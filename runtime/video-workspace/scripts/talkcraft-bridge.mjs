#!/usr/bin/env node
/** Original, offline interchange adapter. Does not execute video-talkcraft or edit core state. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const UPSTREAM_SHA = '4cd673df4b7a6a35784a0881df223721789c5e23';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const hasText = value => typeof value === 'string' && value.trim().length > 0;
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };

async function fileRecord(file) {
  const absolutePath = await realpath(resolve(file));
  const info = await stat(absolutePath);
  if (!info.isFile() || info.size === 0) fail('SOURCE_REQUIRES_NONEMPTY_LOCAL_FILE');
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(absolutePath)) digest.update(chunk);
  return { path: absolutePath, bytes: info.size, sha256: digest.digest('hex') };
}

async function jsonRecord(file) {
  const record = await fileRecord(file);
  const data = await readFile(record.path);
  let payload;
  try { payload = JSON.parse(data.toString('utf8').replace(/^\uFEFF/u, '')); }
  catch { fail('JSON_INVALID'); }
  if (hash(data) !== record.sha256) fail('INPUT_CHANGED_DURING_READ');
  return { ...record, payload };
}

function probeMedia(file, ffprobe = 'ffprobe') {
  const result = spawnSync(ffprobe, [
    '-v', 'error', '-show_entries',
    'format=duration:stream=codec_type,duration,r_frame_rate,avg_frame_rate', '-of', 'json', file,
  ], { shell: false, windowsHide: true, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
  let payload;
  try {
    if (result.error || result.status !== 0) fail('MEDIA_PROBE_FAILED');
    payload = JSON.parse(result.stdout);
  } catch { fail('MEDIA_PROBE_FAILED'); }
  const duration = Number(payload.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) fail('MEDIA_DURATION_INVALID');
  const rate = text => {
    const [a, b] = String(text ?? '').split('/').map(Number);
    return Number.isFinite(a) && Number.isFinite(b) && b > 0 ? a / b : null;
  };
  const streams = payload.streams ?? [];
  const video = streams.find(stream => stream.codec_type === 'video');
  return {
    durationSeconds: duration, hasAudio: streams.some(stream => stream.codec_type === 'audio'),
    hasVideo: Boolean(video), fps: video ? rate(video.r_frame_rate) : null,
    averageFps: video ? rate(video.avg_frame_rate) : null,
  };
}

/** Preserve raw ASR word text. Reviewed segment text cannot manufacture word-level timings. */
export function coreWordsToFlat(transcript, sourceHash, durationSeconds = Infinity) {
  if (!object(transcript) || !hasText(transcript.sourceAssetId)) fail('CORE_TRANSCRIPT_INVALID');
  if (!hasText(sourceHash) || !/^[a-f0-9]{64}$/iu.test(sourceHash) ||
      !/^[a-f0-9]{64}$/iu.test(transcript.sourceAssetHash ?? '') ||
      transcript.sourceAssetHash.toLowerCase() !== sourceHash.toLowerCase()) fail('TRANSCRIPT_SOURCE_HASH_MISMATCH');
  if (!Array.isArray(transcript.words) || transcript.words.length === 0) fail('CORE_WORDS_REQUIRED');
  const ids = new Set();
  let previousStart = -Infinity;
  return transcript.words.map(word => {
    if (!object(word) || !hasText(word.id) || !hasText(word.text)) fail('WORD_TEXT_OR_ID_INVALID');
    if (ids.has(word.id)) fail('DUPLICATE_WORD_ID');
    ids.add(word.id);
    if (word.sourceAssetId !== transcript.sourceAssetId) fail('WORD_SOURCE_ASSET_MISMATCH');
    if (!finite(word.start) || !finite(word.end) || word.start < 0 || word.end <= word.start) fail('WORD_TIMING_INVALID');
    if (word.start < previousStart || word.end > durationSeconds + 0.05) fail('WORD_TIMELINE_INVALID');
    previousStart = word.start;
    return { text: word.text, start: word.start, end: word.end };
  });
}

/** Validate deletion intervals and the complete source-to-destination keep mapping. */
export function validateEdl(edl) {
  if (!object(edl) || !hasText(edl.source)) fail('EDL_SOURCE_REQUIRED');
  if (!finite(edl.sr) || !Number.isInteger(edl.sr) || edl.sr <= 0) fail('EDL_SAMPLE_RATE_INVALID');
  if (!finite(edl.fps) || edl.fps < 0) fail('EDL_FPS_INVALID');
  if (!finite(edl.src_total) || edl.src_total <= 0 || !finite(edl.out_total) || edl.out_total <= 0) fail('EDL_DURATION_INVALID');
  if (!Array.isArray(edl.cuts) || !Array.isArray(edl.keep) || edl.keep.length === 0) fail('EDL_INTERVALS_REQUIRED');
  const tolerance = Math.max(0.00011, 2 / edl.sr);
  const cuts = [];
  let lastEnd = 0;
  for (const row of edl.cuts) {
    if (!object(row) || !finite(row.start) || !finite(row.end) ||
        row.start < 0 || row.end > edl.src_total + tolerance || row.end <= row.start) fail('EDL_CUT_INVALID');
    if (row.start < lastEnd - tolerance) fail('EDL_CUT_OVERLAP_OR_ORDER');
    lastEnd = row.end;
    cuts.push({ start: row.start, end: row.end, kind: hasText(row.kind) ? row.kind : 'unspecified',
      text: typeof row.text === 'string' ? row.text : '', confidence: row.conf ?? null });
  }
  const expected = [];
  let cursor = 0;
  for (const cut of cuts) {
    if (cut.start > cursor + tolerance) expected.push({ start: cursor, end: cut.start });
    cursor = cut.end;
  }
  if (edl.src_total > cursor + tolerance) expected.push({ start: cursor, end: edl.src_total });
  if (expected.length !== edl.keep.length) fail('EDL_KEEP_DOES_NOT_MATCH_CUTS');
  const keep = [];
  let destinationCursor = 0;
  for (let i = 0; i < edl.keep.length; i++) {
    const row = edl.keep[i], interval = expected[i];
    if (!object(row) || !finite(row.src_start) || !finite(row.src_end) || !finite(row.dst_start) ||
        row.src_start < 0 || row.src_end <= row.src_start || row.dst_start < 0) fail('EDL_KEEP_INVALID');
    if (Math.abs(row.src_start - interval.start) > tolerance || Math.abs(row.src_end - interval.end) > tolerance)
      fail('EDL_KEEP_DOES_NOT_MATCH_CUTS');
    if (Math.abs(row.dst_start - destinationCursor) > tolerance) fail('EDL_DESTINATION_MAPPING_INVALID');
    const duration = row.src_end - row.src_start;
    keep.push({ sourceIn: row.src_start, sourceOut: row.src_end, timelineIn: row.dst_start,
      timelineOut: row.dst_start + duration });
    destinationCursor += duration;
  }
  const cumulativeTolerance = tolerance * (keep.length + 1);
  if (Math.abs(destinationCursor - edl.out_total) > cumulativeTolerance) fail('EDL_OUTPUT_DURATION_MISMATCH');
  const removed = cuts.reduce((sum, cut) => sum + cut.end - cut.start, 0);
  if ('removed' in edl && (!finite(edl.removed) || edl.removed < 0 ||
      Math.abs(removed - edl.removed) > cumulativeTolerance)) fail('EDL_REMOVED_DURATION_MISMATCH');
  return { sourceDurationSeconds: edl.src_total, outputDurationSeconds: edl.out_total,
    removedDurationSeconds: removed, fps: edl.fps, sampleRate: edl.sr, cuts, keep };
}

export function audioRemixWarnings(sourceMedia, renderedMedia = null) {
  const warnings = ['CANDIDATE_ONLY_NO_CORE_APPROVAL_OR_EXECUTION', 'WORD_CUTS_CANNOT_BECOME_WHOLE_SENTENCE_DROP',
    'PAUSE_SELECTION_DIFFERS_FROM_CORE_CENTER_COMPRESSION', 'TIMING_ASSETS_REQUIRE_REMAP_AFTER_APPROVED_CUTS'];
  if (sourceMedia.hasAudio) warnings.push('PRESERVE_SOURCE_VOICE_AND_REMIX_CLEAN_AUDIO_AFTER_VIDEO_ONLY_TRIM');
  if (renderedMedia?.hasVideo && !renderedMedia.hasAudio) warnings.push('RENDERED_VIDEO_HAS_NO_AUDIO_NOT_A_COMPLETE_DELIVERY');
  if (!sourceMedia.hasAudio) warnings.push('SOURCE_HAS_NO_AUDIO_RECORDING_RELATION_REQUIRES_REVIEW');
  return warnings;
}

/** Exclusive outputs, including the sidecar. Roll back only files this invocation created. */
async function writeNewOutputs(outputs) {
  const paths = outputs.map(([file]) => resolve(file));
  if (new Set(paths).size !== paths.length) fail('OUTPUT_PATH_COLLISION');
  const handles = [], created = [];
  try {
    for (const file of paths) {
      await mkdir(dirname(file), { recursive: true });
      handles.push(await open(file, 'wx'));
      created.push(file);
    }
    for (let i = 0; i < handles.length; i++) await handles[i].writeFile(outputs[i][1], 'utf8');
  } catch (error) {
    for (const handle of handles) await handle.close().catch(() => {});
    for (const file of created) await unlink(file).catch(() => {});
    if (error.code === 'EEXIST') fail('OUTPUT_EXISTS_NO_OVERWRITE');
    throw error;
  }
  for (const handle of handles) await handle.close();
}

export async function exportWords({ transcript, source, output, ffprobe }) {
  const input = await jsonRecord(transcript), sourceRecord = await fileRecord(source);
  const media = probeMedia(sourceRecord.path, ffprobe);
  const words = coreWordsToFlat(input.payload, sourceRecord.sha256, media.durationSeconds);
  const outputPath = resolve(output), wordsText = json(words), bindingPath = `${outputPath}.binding.json`;
  const binding = {
    schemaVersion: 1, kind: 'talkcraft-word-export-binding', upstreamCommit: UPSTREAM_SHA,
    source: { ...sourceRecord, media }, transcript: { path: input.path, sha256: input.sha256,
      sourceAssetId: input.payload.sourceAssetId, engine: input.payload.engine ?? null,
      contentHash: input.payload.contentHash ?? null, reviewStatus: input.payload.asrReviewStatus ?? 'unknown' },
    words: { path: outputPath, sha256: hash(wordsText), count: words.length },
    timingKind: 'ASR-token-offsets', alignedToReviewedScript: false,
    wordsTextOrigin: 'original-transcript.words.text-not-reviewed-segments.text',
    coreStateChanged: false, upstreamExecuted: false, networkRequests: 0, reviewedByUser: false,
    createdAt: new Date().toISOString(),
  };
  await writeNewOutputs([[outputPath, wordsText], [bindingPath, json(binding)]]);
  return { ok: true, output: outputPath, binding: bindingPath, words: words.length, sourceHash: sourceRecord.sha256 };
}

export async function importEdl({ edl, source, output, edlSource, edlSourceBase, renderedVideo, ffprobe }) {
  const input = await jsonRecord(edl), validated = validateEdl(input.payload);
  const sourceRecord = await fileRecord(source), sourceMedia = probeMedia(sourceRecord.path, ffprobe);
  const declaredPath = resolve(edlSourceBase ?? dirname(input.path), input.payload.source);
  const declaredSource = await fileRecord(declaredPath);
  const edlSourceRecord = await fileRecord(edlSource ?? sourceRecord.path);
  if (declaredSource.path.toLowerCase() !== edlSourceRecord.path.toLowerCase() ||
      declaredSource.sha256 !== edlSourceRecord.sha256) fail('EDL_DECLARED_SOURCE_MISMATCH');
  const edlMedia = probeMedia(edlSourceRecord.path, ffprobe);
  const durationTolerance = Math.max(0.05, validated.fps > 0 ? 1.5 / validated.fps : 0.05);
  if (Math.abs(edlMedia.durationSeconds - validated.sourceDurationSeconds) > durationTolerance ||
      Math.abs(sourceMedia.durationSeconds - validated.sourceDurationSeconds) > durationTolerance) fail('EDL_MEDIA_DURATION_MISMATCH');
  if (sourceMedia.hasVideo) {
    if (!(validated.fps > 0) || !sourceMedia.fps || Math.abs(sourceMedia.fps - validated.fps) > 0.01) fail('EDL_VIDEO_FPS_MISMATCH');
    if (sourceMedia.averageFps && Math.abs(sourceMedia.averageFps - sourceMedia.fps) > sourceMedia.fps * 0.005)
      fail('EDL_VARIABLE_FRAME_RATE_REQUIRES_REVIEW');
  }
  let rendered = null;
  if (renderedVideo) {
    const record = await fileRecord(renderedVideo);
    const media = probeMedia(record.path, ffprobe);
    if (!media.hasVideo) fail('RENDERED_VIDEO_STREAM_REQUIRED');
    if (Math.abs(media.durationSeconds - validated.outputDurationSeconds) > durationTolerance) fail('RENDERED_VIDEO_DURATION_MISMATCH');
    rendered = { ...record, media };
  }
  const outputPath = resolve(output);
  const sameSource = sourceRecord.path.toLowerCase() === edlSourceRecord.path.toLowerCase() &&
    sourceRecord.sha256 === edlSourceRecord.sha256;
  const candidate = {
    schemaVersion: 1, kind: 'talkcraft-edl-review-candidate', upstreamCommit: UPSTREAM_SHA,
    reviewStatus: 'pending-review', source: { ...sourceRecord, media: sourceMedia },
    edlInput: { path: input.path, sha256: input.sha256 }, edlSource: { ...edlSourceRecord, media: edlMedia },
    originalTranscriptWordsBindingRequiredBeforeExecution: true,
    recordingRelationship: { sameFile: sameSource,
      matchingDurationOnly: !sameSource, sameRecordingAndZeroOffsetVerified: sameSource },
    ...validated, renderedVideo: rendered,
    warnings: audioRemixWarnings(sourceMedia, rendered?.media),
    coreCompatibleDirectDropPlan: false, approvedEdl: false, executable: false,
    coreStateChanged: false, upstreamExecuted: false, networkRequests: 0,
    createdAt: new Date().toISOString(),
  };
  const text = json(candidate);
  await writeNewOutputs([[outputPath, text]]);
  return { ok: true, output: outputPath, sha256: hash(text), sourceHash: sourceRecord.sha256,
    edlHash: input.sha256, reviewStatus: candidate.reviewStatus, warnings: candidate.warnings };
}

const HELP = `Offline Talkcraft interchange (does not execute upstream code):
  export-words --transcript <core transcript.json> --source <registered original> --output <new words.json>
  import-edl --edl <cuts.json> --source <registered original> --output <new candidate.json>
    [--edl-source <same-recording WAV>] [--edl-source-base <root for relative EDL source>]
    [--rendered-video <trimmed silent video>] [--ffprobe <local ffprobe executable>]
Exports raw ASR text/times and real file hashes. EDL import is a review candidate only.
No network, no synthesis, no core approval or state changes. Existing outputs are rejected.`;

async function main(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === 'help') { console.log(HELP); return; }
  const command = argv[0];
  const allowed = command === 'export-words' ? ['transcript', 'source', 'output', 'ffprobe']
    : command === 'import-edl' ? ['edl', 'source', 'output', 'edl-source', 'edl-source-base', 'rendered-video', 'ffprobe'] : [];
  if (allowed.length === 0) fail('COMMAND_INVALID');
  const options = {};
  for (let i = 1; i < argv.length; i += 2) {
    const key = argv[i]?.slice(2), value = argv[i + 1];
    if (!argv[i]?.startsWith('--') || !allowed.includes(key) || !hasText(value) || value.startsWith('--') || key in options) fail('CLI_ARGUMENT_INVALID');
    options[key] = value;
  }
  const required = command === 'export-words' ? ['transcript', 'source', 'output'] : ['edl', 'source', 'output'];
  if (required.some(key => !hasText(options[key]))) fail('CLI_REQUIRED_ARGUMENT_MISSING');
  const result = command === 'export-words' ? await exportWords(options) : await importEdl({ ...options,
    edlSource: options['edl-source'], edlSourceBase: options['edl-source-base'], renderedVideo: options['rendered-video'] });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  main(process.argv.slice(2)).catch(error => { console.error(JSON.stringify({ ok: false, error: error.code ?? error.message })); process.exitCode = 1; });
}
