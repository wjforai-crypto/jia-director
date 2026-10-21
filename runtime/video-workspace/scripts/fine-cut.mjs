import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const USAGE = `node fine-cut.mjs plan --input ROUGH.mp4 --cuts CUTS.json --output NEW-PLAN.json [--source-srt ROUGH.srt]
node fine-cut.mjs render --plan PLAN.json --reviewed-plan-sha256 SHA256 --output NEW.mp4 --srt NEW.srt --mapping NEW.json --qa NEW.json --receipt NEW.json

CUTS.json: {"scope":"technical-edge-refinement","segments":[{"id":"clip-1","startFrame":0,"endFrameExclusive":30,"reason":"实际核查后的技术切点说明"}]}
Input must be a real CFR rough-cut video with audio. Frame ranges are ordered and cannot overlap or reorder speech.
This adapter preserves original audio without loudness processing; it does not record core versions or user approval.`;

function assert(condition, message) { if (!condition) throw new Error(message); }
function localFile(value, label) {
  assert(typeof value === 'string' && value.trim() && !value.includes('\0'), `${label} must be a local file path`);
  assert(!/^[a-z][a-z0-9+.-]*:/i.test(value) || /^[a-z]:[\\/]/i.test(value), `${label} cannot be a URL`);
  return path.resolve(value);
}
async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function regularFile(file, label) {
  const entry = await lstat(file);
  assert(entry.isFile() && entry.size > 0, `${label} must be an existing non-empty regular file`);
  return entry;
}
async function assertNew(file) {
  try { await lstat(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error(`Output already exists; choose a new file: ${file}`);
}
function run(program, args) {
  const result = spawnSync(program, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 128 * 1024 * 1024 });
  assert(!result.error && result.status === 0, `${program} failed: ${result.error?.message ?? result.stderr?.slice(-3000) ?? 'unknown error'}`);
  return result.stdout;
}
function rate(value) {
  const match = String(value).match(/^(\d+)\/(\d+)$/);
  assert(match && +match[1] > 0 && +match[2] > 0, 'Invalid video frame rate');
  return { numerator: +match[1], denominator: +match[2], value: +match[1] / +match[2], rational: `${+match[1]}/${+match[2]}` };
}
async function probe(file, checkCfr = true) {
  const raw = JSON.parse(run('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', file]));
  const video = raw.streams.find(stream => stream.codec_type === 'video');
  const audio = raw.streams.find(stream => stream.codec_type === 'audio');
  assert(video && audio, 'Fine cut requires video and original audio streams');
  const fps = rate(video.avg_frame_rate);
  const nativeRate = rate(video.r_frame_rate);
  assert(Math.abs(fps.value - nativeRate.value) < 0.000001, 'Variable frame rate is unsupported; normalize the rough-cut video first');
  assert(fps.value >= 1 && fps.value <= 120, 'Supported CFR frame rate is 1–120 fps');
  const frames = Number(video.nb_read_frames ?? video.nb_frames);
  assert(Number.isInteger(frames) && frames > 0 && frames <= 216000, 'Source frame count must be 1–216000');
  const durationSeconds = frames / fps.value;
  const audioDurationSeconds = Number(audio.duration ?? raw.format.duration);
  assert(Number.isFinite(audioDurationSeconds) && audioDurationSeconds >= durationSeconds - 1 / fps.value - 0.001, 'Original audio is shorter than the video by more than one frame');
  assert(Math.abs(Number(video.start_time ?? 0)) <= 0.001 && Math.abs(Number(audio.start_time ?? 0)) <= 1 / fps.value, 'Source tracks must start at zero within one video frame');
  if (checkCfr) {
    const frameData = JSON.parse(run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', file]));
    assert(frameData.frames.length === frames, 'Frame timestamp count does not match the source frame count');
    const tolerance = Math.max(0.00001, 0.001 / fps.value);
    for (let index = 0; index < frames; index++) {
      const pts = Number(frameData.frames[index].best_effort_timestamp_time);
      assert(Number.isFinite(pts) && Math.abs(pts - index / fps.value) <= tolerance, `Source is not CFR at frame ${index}; normalize the rough cut first`);
    }
  }
  return {
    fps, frames, durationSeconds, width: video.width, height: video.height,
    videoDurationSeconds: Number(video.duration ?? durationSeconds),
    audioDurationSeconds,
    sampleRate: Number(audio.sample_rate), channels: audio.channels,
  };
}

export function normalizeSegments(cuts, frameCount) {
  assert(cuts?.scope === 'technical-edge-refinement', 'cuts.scope must be technical-edge-refinement; semantic deletion belongs to core review-cut');
  assert(Array.isArray(cuts.segments) && cuts.segments.length > 0 && cuts.segments.length <= 500, 'cuts.segments must contain 1–500 frame ranges');
  let previousEnd = 0;
  const ids = new Set();
  return cuts.segments.map((segment, index) => {
    assert(segment && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(segment.id ?? '') && !ids.has(segment.id), `segments[${index}] requires a unique safe id`);
    ids.add(segment.id);
    assert(Number.isInteger(segment.startFrame) && Number.isInteger(segment.endFrameExclusive), `segments[${index}] frame boundaries must be integers`);
    assert(segment.startFrame >= 0 && segment.endFrameExclusive > segment.startFrame && segment.endFrameExclusive <= frameCount, `segments[${index}] frame range is outside source bounds or empty`);
    assert(segment.startFrame >= previousEnd, 'Frame ranges must be ordered without overlaps; sentence reordering belongs to semantic rough cut');
    assert(typeof segment.reason === 'string' && segment.reason.trim(), `segments[${index}] requires a technical refinement reason`);
    previousEnd = segment.endFrameExclusive;
    return { id: segment.id, startFrame: segment.startFrame, endFrameExclusive: segment.endFrameExclusive, reason: segment.reason.trim() };
  });
}
function timeFromSrt(value) {
  const parts = value.match(/^(\d{2,}):(\d{2}):(\d{2}),([0-9]{3})$/);
  assert(parts && +parts[2] < 60 && +parts[3] < 60, `Invalid SRT timestamp: ${value}`);
  return (+parts[1] * 3600 + +parts[2] * 60 + +parts[3]) * 1000 + +parts[4];
}
export function parseSrt(text, durationSeconds = Infinity) {
  if (!text.trim()) return [];
  let priorStart = -1;
  return text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim().split(/\n\s*\n/).map((block, index) => {
    const lines = block.split('\n');
    assert(/^\d+$/.test(lines[0] ?? ''), `SRT block ${index + 1} requires a numeric index`);
    const timing = (lines[1] ?? '').match(/^(\S+)\s+-->\s+(\S+)$/);
    assert(timing, `Invalid timing in SRT block ${index + 1}`);
    const startMs = timeFromSrt(timing[1]), endMs = timeFromSrt(timing[2]);
    assert(endMs > startMs && startMs >= priorStart && endMs <= durationSeconds * 1000 + 1, `SRT block ${index + 1} is unordered, empty, or outside the rough cut`);
    const body = lines.slice(2).join('\n');
    assert(body.trim(), `SRT block ${index + 1} has no caption text`);
    priorStart = startMs;
    return { id: index + 1, sourceIndex: Number(lines[0]), startMs, endMs, text: body };
  });
}
function stamp(milliseconds) {
  const ms = Math.max(0, Math.round(milliseconds));
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}
export function createMapping(segments, fps) {
  let outputFrame = 0;
  return segments.map(segment => {
    const count = segment.endFrameExclusive - segment.startFrame;
    const item = {
      ...segment, roughStartSeconds: segment.startFrame / fps, roughEndSeconds: segment.endFrameExclusive / fps,
      fineStartFrame: outputFrame, fineEndFrameExclusive: outputFrame + count,
      fineStartSeconds: outputFrame / fps, fineEndSeconds: (outputFrame + count) / fps,
    };
    outputFrame += count;
    return item;
  });
}
export function remapSrt(cues, mapping) {
  const output = [], unmappedCueIds = [], clippedCueIds = [], splitCueIds = [];
  for (const cue of cues) {
    const pieces = [];
    let retainedMs = 0;
    for (const segment of mapping) {
      const left = Math.max(cue.startMs, segment.roughStartSeconds * 1000);
      const right = Math.min(cue.endMs, segment.roughEndSeconds * 1000);
      if (right - left < 0.5) continue;
      retainedMs += right - left;
      const startMs = Math.round(segment.fineStartSeconds * 1000 + left - segment.roughStartSeconds * 1000);
      const endMs = Math.round(segment.fineStartSeconds * 1000 + right - segment.roughStartSeconds * 1000);
      if (endMs <= startMs) continue;
      const prior = pieces.at(-1);
      if (prior && Math.abs(startMs - prior.endMs) <= 1) prior.endMs = endMs;
      else pieces.push({ sourceCueId: cue.id, startMs, endMs, text: cue.text });
    }
    if (!pieces.length) unmappedCueIds.push(cue.id);
    if (retainedMs < cue.endMs - cue.startMs - 1) clippedCueIds.push(cue.id);
    if (pieces.length > 1) splitCueIds.push(cue.id);
    output.push(...pieces);
  }
  output.sort((left, right) => left.startMs - right.startMs || left.sourceCueId - right.sourceCueId);
  return {
    cues: output,
    text: output.map((cue, index) => `${index + 1}\n${stamp(cue.startMs)} --> ${stamp(cue.endMs)}\n${cue.text}\n`).join('\n'),
    audit: { originalCueCount: cues.length, outputCueCount: output.length, unmappedCueIds, clippedCueIds, splitCueIds, textChanged: false, subjectiveSpeechReviewCompleted: false },
  };
}

export async function makePlan(options) {
  const input = localFile(options.input, '--input'), cutsPath = localFile(options.cuts, '--cuts'), output = localFile(options.output, '--output');
  assert(path.extname(input).toLowerCase() === '.mp4' && path.extname(output).toLowerCase() === '.json', 'Plan requires a .mp4 input and .json output');
  await assertNew(output);
  await regularFile(input, 'Rough-cut source');
  const sourceHash = await hashFile(input), cutsHash = await hashFile(cutsPath);
  const media = await probe(input);
  const cuts = JSON.parse(await readFile(cutsPath, 'utf8'));
  const segments = normalizeSegments(cuts, media.frames);
  const mapping = createMapping(segments, media.fps.value);
  let sourceSrt = null, cues = [];
  if (options.sourceSrt) {
    const file = localFile(options.sourceSrt, '--source-srt');
    await regularFile(file, 'Rough-cut SRT');
    sourceSrt = { path: file, sha256: await hashFile(file) };
    cues = parseSrt(await readFile(file, 'utf8'), media.durationSeconds);
  }
  const subtitles = remapSrt(cues, mapping);
  assert(!subtitles.audit.unmappedCueIds.length, `Frame selection would delete entire subtitle cues ${subtitles.audit.unmappedCueIds.join(', ')}; return to semantic rough-cut review`);
  assert(await hashFile(input) === sourceHash && await hashFile(cutsPath) === cutsHash && (!sourceSrt || await hashFile(sourceSrt.path) === sourceSrt.sha256), 'Input changed during planning; no plan was written');
  const expectedFrames = mapping.at(-1).fineEndFrameExclusive;
  const plan = {
    schemaVersion: 1, kind: 'fine-cut-plan', scope: 'technical-edge-refinement',
    source: { role: 'rough-cut', path: input, sha256: sourceHash, ...media },
    cutsInput: { path: cutsPath, sha256: cutsHash }, sourceSrt, segments,
    expected: { frames: expectedFrames, durationSeconds: expectedFrames / media.fps.value },
    subtitleAudit: { ...subtitles.audit, sourceSrtProvided: Boolean(sourceSrt) },
    review: { status: 'plan-created-awaiting-explicit-digest', audioAndMeaningReviewCompleted: false },
    core: { versionRegistration: 'not-recorded', review: 'pending-core-review', projectStateModified: false },
    createdAt: new Date().toISOString(),
  };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx' });
  return { plan: output, sha256: await hashFile(output), expected: plan.expected, subtitleAudit: plan.subtitleAudit };
}

export async function renderPlan(options) {
  const planPath = localFile(options.plan, '--plan');
  assert(/^[a-fA-F0-9]{64}$/.test(options.reviewedPlanSha256 ?? ''), '--reviewed-plan-sha256 must be the explicit SHA256 of the actual plan file');
  const planHash = await hashFile(planPath);
  assert(planHash === options.reviewedPlanSha256.toLowerCase(), 'Reviewed plan SHA256 does not match the actual plan file');
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  assert(plan.kind === 'fine-cut-plan' && plan.schemaVersion === 1 && plan.scope === 'technical-edge-refinement', 'Unsupported fine-cut plan schema or scope');
  assert(plan.source?.role === 'rough-cut', 'Fine cut must refine the rough-cut source, not replace semantic source registration');
  const source = localFile(plan.source?.path, 'Plan source');
  assert(await hashFile(source) === plan.source.sha256, 'Rough-cut source changed since planning; create and review a new plan');
  if (plan.sourceSrt) assert(await hashFile(localFile(plan.sourceSrt.path, 'Plan SRT')) === plan.sourceSrt.sha256, 'Rough-cut SRT changed since planning; create and review a new plan');
  const outputPaths = Object.fromEntries(['output', 'srt', 'mapping', 'qa', 'receipt'].map(key => [key, localFile(options[key], `--${key}`)]));
  const allPaths = Object.values(outputPaths).map(file => process.platform === 'win32' ? file.toLowerCase() : file);
  assert(new Set(allPaths).size === allPaths.length, 'All output files must have distinct paths');
  assert(path.extname(outputPaths.output).toLowerCase() === '.mp4' && path.extname(outputPaths.srt).toLowerCase() === '.srt', 'Render output must be .mp4 and subtitle output .srt');
  for (const key of ['mapping', 'qa', 'receipt']) assert(path.extname(outputPaths[key]).toLowerCase() === '.json', `--${key} must be .json`);
  for (const file of Object.values(outputPaths)) await assertNew(file);
  const media = await probe(source);
  assert(media.frames === plan.source.frames && media.fps.rational === plan.source.fps?.rational && media.width === plan.source.width && media.height === plan.source.height, 'Plan source media metadata does not match the actual rough cut');
  const segments = normalizeSegments(plan, media.frames), mapping = createMapping(segments, media.fps.value);
  const frames = mapping.at(-1).fineEndFrameExclusive, durationSeconds = frames / media.fps.value;
  assert(frames === plan.expected?.frames && Math.abs(durationSeconds - plan.expected?.durationSeconds) < 0.000001, 'Plan expected output does not match frame selection');
  const cues = plan.sourceSrt ? parseSrt(await readFile(plan.sourceSrt.path, 'utf8'), media.durationSeconds) : [];
  const subtitles = remapSrt(cues, mapping);
  assert(!subtitles.audit.unmappedCueIds.length, 'Plan drops whole subtitle cues; semantic deletions require reviewed core operations');
  await mkdir(path.dirname(outputPaths.output), { recursive: true });
  const staging = await mkdtemp(path.join(path.dirname(outputPaths.output), '.fine-cut-job-'));
  const stage = Object.fromEntries(Object.keys(outputPaths).map(key => [key, path.join(staging, key === 'output' ? 'fine-base.mp4' : `${key}.${key === 'srt' ? 'srt' : 'json'}`)]));
  const published = [];
  try {
    const filters = [], concat = [];
    mapping.forEach((segment, index) => {
      filters.push(`[0:v:0]trim=start_frame=${segment.startFrame}:end_frame=${segment.endFrameExclusive},setpts=PTS-STARTPTS[v${index}]`);
      filters.push(`[0:a:0]atrim=start=${segment.roughStartSeconds.toFixed(12)}:end=${segment.roughEndSeconds.toFixed(12)},asetpts=PTS-STARTPTS[a${index}]`);
      concat.push(`[v${index}][a${index}]`);
    });
    filters.push(`${concat.join('')}concat=n=${mapping.length}:v=1:a=1[vout][aout]`);
    const command = ['-hide_banner', '-loglevel', 'error', '-n', '-i', source, '-filter_complex', filters.join(';'), '-map', '[vout]', '-map', '[aout]', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', media.fps.rational, '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', stage.output];
    run('ffmpeg', command);
    const actual = await probe(stage.output);
    run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', stage.output, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);
    const durationDelta = Math.abs(actual.videoDurationSeconds - actual.audioDurationSeconds);
    const checks = { frameCount: actual.frames === frames, fps: Math.abs(actual.fps.value - media.fps.value) < 0.000001, dimensions: actual.width === media.width && actual.height === media.height, sampleRate: actual.sampleRate === 48000, audioVideoDuration: durationDelta <= 1 / media.fps.value + 0.001, fullDecode: true };
    const qa = { kind: 'fine-cut-technical-qa', passed: Object.values(checks).every(Boolean), checks, expected: { frames, durationSeconds }, actual, audioVideoDurationDeltaSeconds: durationDelta, audioProcessing: 'retain-original-no-gain-or-loudness-filter', subjectiveListeningCompleted: false, semanticReviewCompleted: false, coreQaMediaExecuted: false };
    assert(qa.passed, `Fine cut failed technical QA: ${JSON.stringify(checks)}`);
    assert(await hashFile(source) === plan.source.sha256 && await hashFile(planPath) === planHash && (!plan.sourceSrt || await hashFile(plan.sourceSrt.path) === plan.sourceSrt.sha256), 'Inputs changed during rendering; no outputs were published');
    const mappingArtifact = { kind: 'rough-to-fine-frame-mapping', schemaVersion: 1, coordinateSystems: { source: 'rough-cut-video-frames', output: 'fine-base-video-frames', end: 'exclusive' }, source: { path: source, sha256: plan.source.sha256 }, planSha256: planHash, fps: media.fps, segments: mapping, durationSeconds, subtitleAudit: subtitles.audit, limitations: ['Does not map original camera footage to rough cut; retain the existing core rough-cut mapping.', 'Subtitle text is preserved; clipped cue timing and cut comfort require actual listening.'] };
    await writeFile(stage.srt, subtitles.text, { flag: 'wx' });
    await writeFile(stage.mapping, `${JSON.stringify(mappingArtifact, null, 2)}\n`, { flag: 'wx' });
    await writeFile(stage.qa, `${JSON.stringify(qa, null, 2)}\n`, { flag: 'wx' });
    const hashes = {};
    for (const key of ['output', 'srt', 'mapping', 'qa']) hashes[key] = await hashFile(stage[key]);
    const receipt = { kind: 'fine-cut-render-receipt', schemaVersion: 1, jobId: randomUUID(), renderedAt: new Date().toISOString(), sourceSha256: plan.source.sha256, planPath, planSha256: planHash, explicitReviewedPlanDigestProvided: true, outputs: Object.fromEntries(Object.keys(hashes).map(key => [key, { path: outputPaths[key], sha256: hashes[key] }])), ffmpeg: { executable: 'ffmpeg', arguments: command.map(value => value === stage.output ? outputPaths.output : value), audioProcessing: 'preserve-source-audio; AAC encoding and 48kHz resampling only; no loudnorm' }, qaPassed: qa.passed, core: { versionRegistration: 'not-recorded', review: 'pending-core-review', projectStateModified: false }, subjectiveListeningCompleted: false, userApprovalRecorded: false };
    await writeFile(stage.receipt, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
    for (const [key, destination] of Object.entries(outputPaths)) {
      await mkdir(path.dirname(destination), { recursive: true });
      const sha256 = await hashFile(stage[key]);
      await copyFile(stage[key], destination, constants.COPYFILE_EXCL);
      published.push({ destination, sha256 });
      assert(await hashFile(destination) === sha256, `Published output hash mismatch: ${destination}`);
    }
    return { ...outputPaths, frames, durationSeconds, qaPassed: qa.passed, planSha256: planHash, core: receipt.core, subtitleAudit: subtitles.audit };
  } catch (error) {
    for (const file of published) if (await hashFile(file.destination).catch(() => null) === file.sha256) await rm(file.destination);
    throw error;
  } finally {
    assert(path.dirname(staging) === path.dirname(outputPaths.output) && path.basename(staging).startsWith('.fine-cut-job-'), 'Unexpected staging cleanup target');
    await rm(staging, { recursive: true, force: true });
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--help' || command === 'help') { console.log(USAGE); return; }
  assert(command === 'plan' || command === 'render', USAGE);
  const allowed = command === 'plan' ? new Set(['input', 'cuts', 'output', 'source-srt']) : new Set(['plan', 'reviewed-plan-sha256', 'output', 'srt', 'mapping', 'qa', 'receipt']);
  const options = {}, seen = new Set();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]?.replace(/^--/, '');
    assert(args[index]?.startsWith('--') && allowed.has(name) && !seen.has(name) && args[index + 1] && !args[index + 1].startsWith('--'), `Invalid or duplicate argument: ${args[index]}\n${USAGE}`);
    seen.add(name);
    options[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = args[index + 1];
  }
  const result = command === 'plan' ? await makePlan(options) : await renderPlan(options);
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
