import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, mkdir, stat, rename, unlink, readdir, open } from 'node:fs/promises';
import { resolve, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createLocalAsr } from './local-asr.mjs';
import { invariant, normalizeTranscript, validateEdits, makeTimeline, buildCues, toSrt } from './rough-review-model.mjs';
import { stageState, selectStage, saveStage, exportStage, importAsset, createTask, importResults, makeMotionAsset, stageMedia } from './review-stages.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONFIG = join(ROOT, 'config/video-workflow.json');
const json = value => JSON.stringify(value, null, 2) + '\n';
const sha = value => createHash('sha256').update(value).digest('hex');
const decode = value => value.toString('utf8').replace(/^\uFEFF/, '');
async function load(path) { return JSON.parse(decode(await readFile(path))); }
export async function hashFile(path) {
  const hash = createHash('sha256'); for await (const data of createReadStream(path)) hash.update(data); return hash.digest('hex');
}
async function exclusive(path, data) { await writeFile(path, typeof data === 'string' || Buffer.isBuffer(data) ? data : json(data), { flag: 'wx' }); }
export function native(command, args, { binary = false, maxBytes = 16 * 1024 * 1024 } = {}) {
  return new Promise((res, rej) => {
    const env = { ...process.env, HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1' };
    for (const key of Object.keys(env)) if (/(MINIMAX|FISH).*KEY/i.test(key)) delete env[key];
    const child = spawn(command, args, { windowsHide: true, shell: false, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [], stderr = []; let bytes = 0, stderrBytes = 0, failure;
    child.stdout.on('data', b => { bytes += b.length; if (bytes > maxBytes) { failure = new Error('工具输出过大'); child.kill(); } else stdout.push(b); });
    child.stderr.on('data', b => { if (stderrBytes < 256 * 1024) { stderr.push(b); stderrBytes += b.length; } });
    child.once('error', rej); child.once('close', code => code === 0 && !failure ? res(binary ? Buffer.concat(stdout) : decode(Buffer.concat(stdout))) : rej(failure ?? new Error(`${command} exit ${code}: ${decode(Buffer.concat(stderr)).slice(-4000)}`)));
  });
}
const rate = str => { const [a, b = 1] = String(str).split('/').map(Number); return a / b; };
export async function probe(source, config) {
  const raw = JSON.parse(await native(config.tools?.ffprobeCommand ?? 'ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_streams', '-show_format', '-of', 'json', source]));
  const v = raw.streams.find(s => s.codec_type === 'video'), a = raw.streams.find(s => s.codec_type === 'audio');
  invariant(v && a, '口播审片需要真实视频和原声音轨');
  const reportedDuration = Number(v.duration ?? raw.format.duration), fps = rate(v.r_frame_rate), frameCount = Number(v.nb_frames) || null;
  const frameDuration = frameCount ? frameCount / fps : reportedDuration;
  // MP4 duration text can be truncated to milliseconds; use a matching frame count instead of losing a complete last frame.
  const duration = frameCount && Math.abs(rate(v.avg_frame_rate) - fps) < .01 && Math.abs(frameDuration - reportedDuration) < .5 / fps ? frameDuration : reportedDuration;
  invariant(duration > 0 && duration <= 7200 && Number.isFinite(fps) && fps >= 1 && fps <= 60, '支持两小时内、1–60fps 的口播素材');
  invariant(Math.abs(Number(v.start_time ?? 0)) < 1 / fps && Math.abs(Number(a.start_time ?? 0)) < 1 / fps, '素材音视频起点不同，需先检查偏移');
  return { duration, fps, sourceFrameRate: v.r_frame_rate, averageFrameRate: v.avg_frame_rate, frameCount,
    width: v.width, height: v.height, audioSampleRate: Number(a.sample_rate), audioDuration: Number(a.duration ?? raw.format.duration),
    videoDuration: Number(v.duration ?? raw.format.duration), codec: v.codec_name, audioCodec: a.codec_name };
}
async function waveform(source, config, duration) {
  const bytes = await native(config.tools?.ffmpegCommand ?? 'ffmpeg', ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', source, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '2000', '-f', 's16le', 'pipe:1'], { binary: true, maxBytes: 32 * 1024 * 1024 });
  const samples = Math.floor(bytes.length / 2), count = Math.min(24000, Math.ceil(duration * 40)), peaks = [];
  for (let i = 0; i < count; i++) {
    let peak = 0; for (let j = Math.floor(i * samples / count); j < Math.floor((i + 1) * samples / count); j++) peak = Math.max(peak, Math.abs(bytes.readInt16LE(j * 2)) / 32768);
    peaks.push(Number(peak.toFixed(4)));
  }
  return { duration, peaks, kind: 'decoded-source-audio-peak-envelope' };
}

export async function prepareReview({ input, outputDir, transcriptInput, scriptInput, configPath = DEFAULT_CONFIG }) {
  invariant(input && outputDir, '需要 --input 和新的 --output-dir');
  const source = resolve(input), destination = resolve(outputDir), config = await load(configPath);
  invariant(['.mp4', '.mov', '.mkv', '.webm'].includes(extname(source).toLowerCase()), '请选择本地口播视频');
  const sourceSha = await hashFile(source), info = await probe(source, config);
  await mkdir(destination, { recursive: false });
  let rawBytes, asrReceipt;
  if (transcriptInput) {
    rawBytes = await readFile(resolve(transcriptInput)); const raw = JSON.parse(decode(rawBytes));
    // A standalone raw Whisper JSON has no asset binding. Import is explicit and remains unverified.
    if (raw.sourceAssetHash) invariant(raw.sourceAssetHash === sourceSha, '转写不属于这段原片');
    asrReceipt = { kind: 'existing-transcript-import', input: resolve(transcriptInput), sha256: sha(rawBytes), sourceBoundInInput: Boolean(raw.sourceAssetHash), humanReviewedThisSession: false, remoteRequests: 0 };
  } else {
    asrReceipt = await createLocalAsr(config, resolve(configPath))({ audioPath: source, outputDir: destination });
    invariant(asrReceipt.status === 'transcribed', `本地转写失败：${asrReceipt.code ?? asrReceipt.status}`);
    rawBytes = await readFile(join(destination, 'asr.raw.json'));
  }
  await exclusive(join(destination, 'transcript.source.json'), rawBytes);
  await exclusive(join(destination, 'transcript.import.json'), asrReceipt);
  const transcript = normalizeTranscript(JSON.parse(decode(rawBytes)), info.duration);
  await exclusive(join(destination, 'transcript.json'), transcript);
  let script = null;
  if (scriptInput) {
    const bytes = await readFile(resolve(scriptInput)); invariant(bytes.length <= 256 * 1024, '脚本太大');
    await exclusive(join(destination, 'script.reference.txt'), bytes);
    script = { file: 'script.reference.txt', sha256: sha(bytes), usage: '校字和覆盖检查参考，不补造未说出的台词' };
  }
  const suggestions = [];
  // These are pacing hints, not VAD evidence or semantic deletion. Nothing is selected automatically.
  for (let i = 0; i < transcript.segments.length - 1; i++) {
    const a = transcript.segments[i], b = transcript.segments[i + 1];
    if (b.start - a.end > 1.2) suggestions.push({ id: `pause:${i}`, start: a.end + .2, end: b.start - .2,
      reason: '较长句间间隔；先听呼吸与表情，再决定是否缩短', category: '停顿候选', confidence: '待听审' });
  }
  const sourceStat = await stat(source);
  const project = { schemaVersion: 1, kind: 'local-rough-review-workspace', title: dirname(destination).split(/[\\/]/).at(-1) + ' / ' + destination.split(/[\\/]/).at(-1),
    createdAt: new Date().toISOString(), source: { path: source, sha256: sourceSha, size: sourceStat.size, mtimeMs: sourceStat.mtimeMs, ...info },
    transcript: { file: 'transcript.json', sha256: await hashFile(join(destination, 'transcript.json')), rawSha256: sha(rawBytes) }, script,
    rules: { originalAudio: true, remoteRequests: 0, paidCalls: 0, coreStateWritten: false, savingIsUserApproval: false, browserPreviewFrameExact: false },
    outputClock: { fps: info.fps, mode: 'CFR-normalized-from-source', audioSampleRate: 48000 } };
  invariant(await hashFile(source) === sourceSha, '转写期间原片变动，停止登记');
  await exclusive(join(destination, 'project.json'), project);
  await exclusive(join(destination, 'suggestions.json'), { sourceSha256: sourceSha, transcriptSha256: project.transcript.sha256, suggestions });
  await exclusive(join(destination, 'edits.json'), { schemaVersion: 1, revision: 0, projectSha256: await hashFile(join(destination, 'project.json')), cuts: [], corrections: {}, subtitleOverrides: {}, history: [] });
  await exclusive(join(destination, 'waveform.json'), await waveform(source, config, info.duration));
  return { status: 'prepared-awaiting-review', projectDir: destination, words: transcript.units.length, segments: transcript.segments.length, remoteRequests: 0, paidCalls: 0 };
}

export async function readReview(projectDir, { verifySource = false } = {}) {
  const dir = resolve(projectDir), project = await load(join(dir, 'project.json')), edits = await load(join(dir, 'edits.json'));
  invariant(project.kind === 'local-rough-review-workspace' && edits.projectSha256 === await hashFile(join(dir, 'project.json')), '工程绑定变化');
  invariant(project.transcript.sha256 === await hashFile(join(dir, 'transcript.json')), '转写文件变化');
  invariant(project.transcript.rawSha256 === await hashFile(join(dir, 'transcript.source.json')), '原始转写变化');
  if (project.script) invariant(project.script.sha256 === await hashFile(join(dir, project.script.file)), '参考脚本变化');
  if (verifySource) invariant(project.source.sha256 === await hashFile(project.source.path), '原片变化，请建立新版本');
  const transcript = await load(join(dir, 'transcript.json'));
  const valid = validateEdits(edits, transcript, project.source.duration);
  invariant(Number.isInteger(edits.revision) && edits.revision >= 0, '编辑版本无效');
  const suggestions = await load(join(dir, 'suggestions.json'));
  invariant(suggestions.sourceSha256 === project.source.sha256 && suggestions.transcriptSha256 === project.transcript.sha256 && Array.isArray(suggestions.suggestions), '建议来源绑定无效');
  const timeline = makeTimeline(valid.cuts, project.source.duration, project.outputClock.fps);
  return { dir, project, transcript, edits: { ...edits, ...valid }, suggestions: suggestions.suggestions, timeline, cues: buildCues(transcript, valid, timeline) };
}
async function withLock(dir, name, fn) {
  const lock = join(dir, name); let fd;
  try { fd = await open(lock, 'wx'); await fd.writeFile(json({ pid: process.pid, at: new Date().toISOString() })); }
  catch (e) { if (e.code === 'EEXIST') throw new Error('工程正在写入；请等待。异常关闭后先核实锁中的进程再处理'); throw e; }
  try { return await fn(); } finally { await fd.close(); await unlink(lock); }
}
async function atomicJson(path, value) { const tmp = `${path}.${randomUUID()}.tmp`; await exclusive(tmp, value); await rename(tmp, path); }
export async function saveReview(projectDir, payload) {
  const dir = resolve(projectDir);
  return withLock(dir, '.write.lock', async () => {
    const current = await readReview(dir, { verifySource: true });
    invariant(payload.revision === current.edits.revision, 'STALE_REVISION: 已有新修改，请重新载入');
    const valid = validateEdits(payload, current.transcript, current.project.source.duration);
    const timeline = makeTimeline(valid.cuts, current.project.source.duration, current.project.outputClock.fps);
    const cues = buildCues(current.transcript, valid, timeline), activeKeys = new Set(cues.map(c => c.key));
    // A changed cut invalidates old fragment captions instead of attaching them to a new interval.
    for (const key of Object.keys(valid.subtitleOverrides)) if (!activeKeys.has(key)) delete valid.subtitleOverrides[key];
    const edits = { ...current.edits, ...valid, revision: current.edits.revision + 1,
      history: [...current.edits.history, { revision: current.edits.revision + 1, at: new Date().toISOString(), action: 'save-local-edit', cutCount: valid.cuts.length, correctionCount: Object.keys(valid.corrections).length }].slice(-500) };
    await atomicJson(join(dir, 'edits.json'), edits);
    return { status: 'saved', revision: edits.revision, userApprovalRecorded: false };
  });
}
export async function importSuggestions(projectDir, input) {
  const dir = resolve(projectDir);
  return withLock(dir, '.write.lock', async () => {
    const r = await readReview(dir, { verifySource: true }), file = await load(resolve(input));
    invariant(file.sourceSha256 === r.project.source.sha256 && file.transcriptSha256 === r.project.transcript.sha256, '建议绑定不匹配');
    invariant(Array.isArray(file.suggestions) && file.suggestions.length <= 500, '建议格式无效');
    validateEdits({ cuts: file.suggestions.map(s => ({ ...s, origin: 'suggestion' })), corrections: {}, subtitleOverrides: {} }, r.transcript, r.project.source.duration);
    for (const s of file.suggestions) invariant(typeof s.category === 'string' && s.category.length < 100 && typeof s.confidence === 'string' && s.confidence.length < 100, '建议需要分类和不确定性');
    await atomicJson(join(dir, 'suggestions.json'), { sourceSha256: file.sourceSha256, transcriptSha256: file.transcriptSha256, suggestions: file.suggestions });
    return { status: 'suggestions-imported-not-applied', count: file.suggestions.length };
  });
}

export async function exportReview(projectDir, { configPath = DEFAULT_CONFIG, revision } = {}) {
  const dir = resolve(projectDir);
  return withLock(dir, '.export.lock', async () => {
    const r = await readReview(dir, { verifySource: true }), config = await load(configPath);
    invariant(revision === r.edits.revision, 'STALE_REVISION: 先保存并重新检查最新修改');
    invariant(!r.cues.some(c => c.requiresCorrection), '部分裁剪涉及已校对句子，请在字幕区校对保留片段后再导出');
    const root = join(dir, 'exports'); await mkdir(root, { recursive: true });
    const id = `r${revision}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`, out = join(root, id); await mkdir(out);
    const mapping = { schemaVersion: 1, kind: 'original-to-rough-frame-mapping', revision, source: r.project.source,
      transcriptSha256: r.project.transcript.sha256, editsSha256: sha(json(r.edits)), clock: r.project.outputClock, ...r.timeline, cues: r.cues };
    await exclusive(join(out, 'edits.snapshot.json'), r.edits);
    await exclusive(join(out, 'mapping.json'), mapping); await exclusive(join(out, 'rough.srt'), toSrt(r.cues));
    const ks = r.timeline.keeps, fps = r.timeline.fps, filter = [], n = ks.length;
    filter.push(`[0:v:0]fps=${fps}:start_time=0,split=${n}${ks.map((_, i) => `[v${i}]`).join('')}`);
    filter.push(`[0:a:0]aresample=48000,asplit=${n}${ks.map((_, i) => `[a${i}]`).join('')}`);
    for (const [i, k] of ks.entries()) {
      const frames = k.sourceEndFrame - k.sourceStartFrame, samples = Math.round(frames / fps * 48000), d = samples / 48000;
      filter.push(`[v${i}]trim=start_frame=${k.sourceStartFrame}:end_frame=${k.sourceEndFrame},setpts=N/${fps}/TB[vout${i}]`);
      filter.push(`[a${i}]atrim=start=${k.sourceStart}:end=${k.sourceEnd},asetpts=N/SR/TB,apad=whole_len=${samples},atrim=end_sample=${samples},afade=t=in:d=${Math.min(.002, d / 4)},afade=t=out:st=${Math.max(0, d - .002)}:d=${Math.min(.002, d / 4)}[aout${i}]`);
    }
    filter.push(`${ks.map((_, i) => `[vout${i}][aout${i}]`).join('')}concat=n=${n}:v=1:a=1[v][a]`);
    const filterPath = join(out, 'render.filter.txt'), mp4 = join(out, 'rough.mp4'); await exclusive(filterPath, filter.join(';\n'));
    await native(config.tools?.ffmpegCommand ?? 'ffmpeg', ['-nostdin', '-hide_banner', '-v', 'error', '-n', '-protocol_whitelist', 'file,pipe', '-i', r.project.source.path,
      '-filter_complex_script', filterPath, '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-r', String(fps), '-t', String(r.timeline.outputDuration), '-c:a', 'aac', '-ar', '48000', '-b:a', '192k', '-movflags', '+faststart', mp4], { maxBytes: 1024 * 1024 });
    const actual = await probe(mp4, config);
    await native(config.tools?.ffmpegCommand ?? 'ffmpeg', ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', mp4, '-f', 'null', '-']);
    const srtOk = r.cues.every(c => c.end > c.start && c.start >= 0 && c.end <= r.timeline.outputDuration + .001);
    const passed = actual.frameCount === r.timeline.outputFrames && Math.abs(actual.videoDuration - r.timeline.outputDuration) < .001 && actual.audioSampleRate === 48000 && Math.abs(actual.audioDuration - actual.videoDuration) <= 1 / fps && srtOk;
    const qa = { passed, fullDecode: true, frameCountExpected: r.timeline.outputFrames, actual, srtWithinOutput: srtOk, cutPointListening: 'pending', userAcceptance: 'pending', previewSeekingFrameExact: false };
    await exclusive(join(out, 'qa.json'), qa);
    invariant(passed, '导出技术检查未通过，保留输出和 QA 供诊断');
    invariant(await hashFile(r.project.source.path) === r.project.source.sha256, '导出期间原片变动');
    const files = {};
    for (const name of ['rough.mp4', 'rough.srt', 'mapping.json', 'edits.snapshot.json', 'qa.json']) files[name] = { path: join(out, name), sha256: await hashFile(join(out, name)) };
    const handoff = { kind: 'rough-to-fine-local-handoff', source: files['rough.mp4'], sourceSrt: files['rough.srt'], originalToRough: files['mapping.json'],
      frameCount: actual.frameCount, fps, next: 'fine-cut-plan → 审查计划散列 → fine-cut-render → 补图/MG/B-roll',
      semanticCutsOwner: 'edits.snapshot.json', fineCutScope: 'technical-edge-refinement', coreStateWritten: false,
      coreRegistration: '仅在已有正式项目状态允许且完成真实审查时，使用核心 CLI 登记版本；词级决定不冒充整句 operation' };
    await exclusive(join(out, 'fine-cut.handoff.json'), handoff);
    const receipt = { status: 'exported-awaiting-listening-and-user-review', revision, outputDir: out, files, qaPassed: true, audio: 'preserved-source-with-2ms-edge-fades', subtitle: 'external-SRT-single-owner', remoteRequests: 0, paidCalls: 0, coreStateWritten: false, userApprovalRecorded: false };
    await exclusive(join(out, 'receipt.json'), receipt); return receipt;
  });
}

async function bodyJson(req) {
  invariant(req.headers['content-type']?.startsWith('application/json'), '需要 JSON 请求');
  const chunks = []; let bytes = 0;
  for await (const b of req) { bytes += b.length; invariant(bytes <= 1024 * 1024, '请求过大'); chunks.push(b); }
  return JSON.parse(decode(Buffer.concat(chunks)));
}
export async function openReview(projectDir, { configPath = DEFAULT_CONFIG, openBrowser = true } = {}) {
  const dir = resolve(projectDir); await readReview(dir, { verifySource: true });
  const sessions = join(dir, 'sessions'); await mkdir(sessions, { recursive: true });
  const session = join(sessions, randomUUID()); await mkdir(session);
  const ready = join(session, 'ready.json'), log = await open(join(session, 'server.log'), 'wx');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve', '--project-dir', dir, '--config', resolve(configPath), '--ready-file', ready], { detached: true, windowsHide: true, shell: false, stdio: ['ignore', log.fd, log.fd] });
  let launchError; child.once('error', e => { launchError = e; }); child.unref(); await log.close();
  for (let i = 0; i < 80; i++) {
    if (launchError) throw launchError;
    try {
      const r = await load(ready);
      if (openBrowser) {
        invariant(process.platform === 'win32', '本机入口仅配置 Windows 浏览器打开；可用 serve 获取网址');
        const browser = spawn('explorer.exe', [r.url], { detached: true, stdio: 'ignore', shell: false }); browser.on('error', () => {}); browser.unref();
      }
      return { ...r, browserOpenRequested: openBrowser, sessionDir: session };
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await new Promise(res => setTimeout(res, 100));
  }
  throw new Error(`审片服务未就绪，请检查 ${join(session, 'server.log')}`);
}
export async function serveReview(projectDir, { port = 0, configPath = DEFAULT_CONFIG } = {}) {
  const dir = resolve(projectDir); await readReview(dir, { verifySource: true });
  invariant(Number.isInteger(port) && port >= 0 && port <= 65535, '端口无效');
  const nonce = randomBytes(24).toString('hex'); let origin, job = { status: 'idle' }, stageJob = { status: 'idle' };
  const reply = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(json(value)); };
  const server = createServer(async (req, res) => {
    try {
      invariant(req.headers.host === new URL(origin).host, '只接受本地审片地址');
      const path = new URL(req.url, origin).pathname;
      if (req.method === 'POST') {
        invariant(req.headers.origin === origin && req.headers['x-review-token'] === nonce, '请求不属于本审片窗口');
        const data = await bodyJson(req);
        if (path === '/api/save') return reply(res, 200, await saveReview(dir, data));
        if (path === '/api/stages/select') return reply(res, 200, await selectStage(dir, data.stage, data.id, data.revision));
        if (path === '/api/stages/save') return reply(res, 200, await saveStage(dir, data.stage, data));
        if (path === '/api/stages/asset') return reply(res, 200, await importAsset(dir, data.input, configPath));
        if (path === '/api/stages/task') return reply(res, 200, await createTask(dir, data));
        if (path === '/api/stages/results') return reply(res, 200, await importResults(dir, data.input, configPath));
        if (path === '/api/stages/export' || path === '/api/stages/motion') {
          invariant(stageJob.status !== 'running' && job.status !== 'running', '已有导出或动效制作进行中');
          stageJob = { status: 'running', stage: data.stage ?? 'motion' };
          const work = path.endsWith('/motion') ? makeMotionAsset(dir, data, configPath) : exportStage(dir, data.stage, data, configPath);
          work.then(result => { stageJob = { status: 'done', result }; }).catch(e => { stageJob = { status: 'failed', error: e.message }; });
          return reply(res, 202, stageJob);
        }
        if (path === '/api/export') {
          invariant(job.status !== 'running' && stageJob.status !== 'running', '已有导出进行中');
          job = { status: 'running', revision: data.revision };
          exportReview(dir, { configPath, revision: data.revision }).then(result => { job = { status: 'done', result }; }).catch(e => { job = { status: 'failed', error: e.message }; });
          return reply(res, 202, job);
        }
        return reply(res, 404, { error: '未知操作' });
      }
      invariant(req.method === 'GET' || req.method === 'HEAD', '请求方法不支持');
      if (path === '/api/state') {
        const r = await readReview(dir); let exports = [];
        try { for (const id of await readdir(join(dir, 'exports'))) { try { const rec = await load(join(dir, 'exports', id, 'receipt.json')); exports.push({ id, revision: rec.revision, duration: (await load(join(dir, 'exports', id, 'qa.json'))).actual.videoDuration }); } catch {} } } catch {}
        return reply(res, 200, { ...r, dir: undefined, token: nonce, exports: exports.reverse(), scriptText: r.project.script ? decode(await readFile(join(dir, r.project.script.file))) : null, job });
      }
      if (path === '/api/waveform') return reply(res, 200, await load(join(dir, 'waveform.json')));
      if (path === '/api/job') return reply(res, 200, job);
      if (path === '/api/stages') return reply(res, 200, { ...await stageState(dir), job: stageJob });
      if (path === '/api/stages/job') return reply(res, 200, stageJob);
      let file, contentType;
      if (path === '/media') { const r = await readReview(dir); file = r.project.source.path; contentType = ({ '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska' })[extname(file).toLowerCase()];
        const s = await stat(file); invariant(s.size === r.project.source.size && s.mtimeMs === r.project.source.mtimeMs, '原片已变化'); }
      else if (path.startsWith('/stage-files/')) { const media = await stageMedia(dir, path); file = media.file; contentType = media.type; }
      else if (path.startsWith('/exports/')) {
        const match = /^\/exports\/([a-zA-Z0-9-]+)\/(rough\.mp4|rough\.srt|mapping\.json|fine-cut\.handoff\.json|qa\.json|receipt\.json)$/.exec(path);
        invariant(match, '无效导出文件'); file = join(dir, 'exports', match[1], match[2]);
        contentType = match[2].endsWith('mp4') ? 'video/mp4' : 'text/plain; charset=utf-8';
      } else {
        const files = { '/': ['ui/rough-review/index.html', 'text/html'], '/app.mjs': ['ui/rough-review/app.mjs', 'text/javascript'], '/stages.mjs': ['ui/rough-review/stages.mjs', 'text/javascript'], '/styles.css': ['ui/rough-review/styles.css', 'text/css'], '/stages.css': ['ui/rough-review/stages.css', 'text/css'], '/model.mjs': ['scripts/rough-review-model.mjs', 'text/javascript'] };
        if (!files[path]) return reply(res, 404, { error: '文件不存在' });
        file = join(ROOT, files[path][0]); contentType = files[path][1] + '; charset=utf-8';
      }
      const size = (await stat(file)).size; let start = 0, end = size - 1, status = 200;
      if (req.headers.range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if (!m || (!m[1] && !m[2])) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
        if (!m[1]) start = Math.max(0, size - Number(m[2])); else start = Number(m[1]);
        if (m[1] && m[2]) end = Math.min(end, Number(m[2]));
        if (!Number.isSafeInteger(start) || start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
        status = 206;
      }
      res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; media-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'", ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
      if (req.method === 'HEAD') return res.end();
      const stream = createReadStream(file, { start, end }); stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
    } catch (e) { if (!res.headersSent) reply(res, e.message.includes('STALE_REVISION') ? 409 : 400, { error: e.message }); else res.destroy(); }
  });
  await new Promise((res, rej) => { server.once('error', rej); server.listen(port, '127.0.0.1', res); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, url: origin, projectDir: dir, pid: process.pid };
}

const HELP = `本地口播审片（不上传、不付费、不写核心状态）\nprepare --input 原片.mp4 --output-dir 新目录 [--transcript 核心或Whisper.json] [--script 脚本.txt] [--config 配置]\nopen --project-dir 目录 [--config 配置] （后台服务并打开浏览器）\nserve --project-dir 目录 [--port 0] [--config 配置]\nsuggest --project-dir 目录 --input 绑定来源的建议.json\nsave --project-dir 目录 --input 带revision/cuts/corrections/subtitleOverrides的编辑.json\nexport --project-dir 目录 --revision 已保存版本 [--config 配置]\n`;
async function main(args) {
  if (!args.length || args.includes('--help')) { process.stdout.write(HELP); return; }
  const [command, ...rest] = args, opts = {};
  const allowed = { prepare: ['--input', '--output-dir', '--transcript', '--script', '--config'], open: ['--project-dir', '--config'], serve: ['--project-dir', '--port', '--config', '--ready-file'], suggest: ['--project-dir', '--input'], save: ['--project-dir', '--input'], export: ['--project-dir', '--revision', '--config'] };
  invariant(allowed[command], '命令不支持');
  for (let i = 0; i < rest.length; i += 2) { invariant(allowed[command].includes(rest[i]) && rest[i + 1] && !rest[i + 1].startsWith('--') && !Object.hasOwn(opts, rest[i]), '参数无效'); opts[rest[i]] = rest[i + 1]; }
  let result;
  if (command === 'prepare') result = await prepareReview({ input: opts['--input'], outputDir: opts['--output-dir'], transcriptInput: opts['--transcript'], scriptInput: opts['--script'], configPath: opts['--config'] });
  else { invariant(opts['--project-dir'], '需要 --project-dir');
    if (command === 'serve') { const r = await serveReview(opts['--project-dir'], { port: Number(opts['--port'] ?? 0), configPath: opts['--config'] }); result = { url: r.url, projectDir: r.projectDir, pid: r.pid, remoteRequests: 0 }; if (opts['--ready-file']) await exclusive(resolve(opts['--ready-file']), result); }
    if (command === 'open') result = await openReview(opts['--project-dir'], { configPath: opts['--config'] });
    if (command === 'suggest') result = await importSuggestions(opts['--project-dir'], opts['--input']);
    if (command === 'save') result = await saveReview(opts['--project-dir'], await load(resolve(opts['--input'])));
    if (command === 'export') result = await exportReview(opts['--project-dir'], { revision: Number(opts['--revision']), configPath: opts['--config'] });
  }
  process.stdout.write(json(result));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(e => { process.stderr.write(json({ error: e.message })); process.exitCode = 1; });
