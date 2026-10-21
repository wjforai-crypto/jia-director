// ASR-only extraction; no speech synthesis or voice enrollment.
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const DEFAULT_CONFIG = resolve(dirname(fileURLToPath(import.meta.url)), '../config/video-workflow.json');
const hasText = x => typeof x === 'string' && x.trim().length > 0;
const fail = code => Object.assign(new Error(code), { code });
const json = x => `${JSON.stringify(x, null, 2)}\n`;
const digest = x => createHash('sha256').update(x).digest('hex');
const save = (path, value) => writeFile(path, typeof value === 'string' ? value : json(value), { encoding: 'utf8', flag: 'wx' });
const decode = bytes => { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw fail('TEXT_REQUIRES_UTF8'); } };
async function lockedJson(path) { try { const bytes = await readFile(path); return { value: JSON.parse(decode(bytes)), sha256: digest(bytes) }; } catch (e) { throw fail(e.code === 'TEXT_REQUIRES_UTF8' ? e.code : 'JSON_INPUT_INVALID'); } }
async function readJson(path) { return (await lockedJson(path)).value; }
async function fileHash(path) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); }
async function regularFile(path, code = 'INPUT_FILE_REQUIRED') { try { if (!(await stat(path)).isFile()) throw fail(code); } catch { throw fail(code); } }
async function unchanged(bindings) { for (const [path, sha] of bindings) if (await fileHash(path) !== sha) throw fail('LOCKED_INPUT_CHANGED'); }
async function newDirectory(path) { try { await mkdir(path); } catch (e) { throw fail(e.code === 'EEXIST' ? 'OUTPUT_ALREADY_EXISTS' : 'OUTPUT_PARENT_REQUIRED'); } }
function codeOf(error) { return /^[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'LOCAL_OPERATION_FAILED'; }

/** Never use a shell; subprocesses inherit no provider API key and never print private arguments. */
async function native(command, args, { timeout = 600_000 } = {}) {
  const env = { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' };
  delete env.MINIMAX_API_KEY; delete env.FISH_AUDIO_API_KEY;
  return await new Promise((yes, no) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let size = 0; let settled = false;
    const timer = setTimeout(() => { child.kill(); finish(fail('NATIVE_TIMEOUT')); }, timeout);
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? no(error) : yes(value); };
    child.stdout.on('data', b => { size += b.length; if (size > 16 * 1024 * 1024) { child.kill(); finish(fail('NATIVE_OUTPUT_TOO_LARGE')); } else chunks.push(b); });
    child.stderr.on('data', () => {});
    child.on('error', () => finish(fail('NATIVE_NOT_AVAILABLE')));
    child.on('close', code => finish(code === 0 ? null : fail('NATIVE_OPERATION_FAILED'), Buffer.concat(chunks).toString('utf8')));
  });
}

/** Existing whisper.cpp route only; ASCII cache preserves native Windows compatibility. */
export function createLocalAsr(config, configPath, deps = {}) {
  const asr = config.asr, run = deps.run ?? native;
  let init;
  async function initialize() {
    if (!asr || asr.engine !== 'whisper.cpp' || !hasText(asr.executable) || !hasText(asr.modelPath) || !hasText(asr.jobsRoot)) throw fail('ASR_NOT_CONFIGURED');
    const paths = Object.fromEntries(['executable', 'modelPath', 'jobsRoot'].map(k => [k, resolve(dirname(configPath), asr[k])]));
    if (/[^\x00-\x7f]/.test(paths.modelPath + paths.jobsRoot)) throw fail('ASR_ASCII_PATH_REQUIRED');
    await regularFile(paths.executable, 'ASR_EXECUTABLE_MISSING'); await regularFile(paths.modelPath, 'ASR_MODEL_MISSING');
    if (!(await stat(paths.jobsRoot)).isDirectory()) throw fail('ASR_JOBS_ROOT_MISSING');
    const modelSha256 = await fileHash(paths.modelPath);
    if (!/^[a-f0-9]{64}$/i.test(asr.modelSha256 ?? '') || modelSha256 !== asr.modelSha256.toLowerCase()) throw fail('ASR_MODEL_HASH_MISMATCH');
    return { ...paths, modelSha256, modelStat: await stat(paths.modelPath) };
  }
  return async ({ audioPath, outputDir }) => {
    try {
      init ??= initialize(); const runtime = await init;
      const before = await stat(runtime.modelPath);
      if (before.size !== runtime.modelStat.size || before.mtimeMs !== runtime.modelStat.mtimeMs) throw fail('ASR_MODEL_CHANGED');
      const audioSha256 = await fileHash(audioPath), job = resolve(runtime.jobsRoot, `voice-${randomUUID().replaceAll('-', '')}`);
      await newDirectory(job);
      const wav = resolve(job, 'audio.wav'), prefix = resolve(job, 'raw');
      await run(config.tools?.ffmpegCommand ?? 'ffmpeg', ['-nostdin', '-v', 'error', '-n', '-protocol_whitelist', 'file,pipe', '-i', audioPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
      await run(runtime.executable, ['-m', runtime.modelPath, '-f', wav, '-l', asr.language ?? 'zh', '-sow', '-ojf', '-of', prefix, '-np']);
      const raw = await readFile(`${prefix}.json`), result = JSON.parse(decode(raw));
      if (!Array.isArray(result.transcription) || result.transcription.some(s => typeof s.text !== 'string')) throw fail('ASR_JSON_INVALID');
      const text = result.transcription.map(s => s.text).join('');
      if (await fileHash(audioPath) !== audioSha256) throw fail('LOCKED_INPUT_CHANGED');
      const after = await stat(runtime.modelPath);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw fail('ASR_MODEL_CHANGED');
      await writeFile(resolve(outputDir, 'asr.raw.json'), raw, { flag: 'wx' });
      const receipt = { status: 'transcribed', engine: 'whisper.cpp', model: asr.modelName, modelSha256: runtime.modelSha256, language: asr.language ?? 'zh', audioSha256, rawJsonSha256: digest(raw), cacheJob: job, text, humanReviewed: false, apiRequests: 0 };
      await save(resolve(outputDir, 'asr.receipt.json'), receipt); return receipt;
    } catch (error) { if (error.code === 'LOCKED_INPUT_CHANGED') throw error; return { status: 'unverified', code: codeOf(error), text: null, apiRequests: 0 }; }
  };
}

