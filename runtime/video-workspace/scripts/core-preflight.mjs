import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ARTIFACTS = ['project.json', 'assets.json', 'transcript.json', 'cut-plan.json', 'edit-plan.json', 'visual-routing.json', 'kimi-visual-direction.json', 'review.json', 'archive-manifest.json'];
function assert(condition, message) { if (!condition) throw new Error(message); }
function localPath(value, label) {
  assert(typeof value === 'string' && value.trim() && !value.includes('\0'), `${label} requires a local path`);
  assert(!/^[a-z][a-z0-9+.-]*:/i.test(value) || /^[a-z]:[\\/]/i.test(value), `${label} cannot be a URL`);
  return path.resolve(value);
}
async function fileHash(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function readJson(file) { return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
async function assertNew(file) {
  try { await lstat(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error(`Output already exists; preserve it and choose a new path: ${file}`);
}
async function sourceFile(file) {
  const entry = await lstat(file);
  assert(entry.isFile() && entry.size > 0, `Source must be an existing non-empty regular file: ${file}`);
}
function key(file) { return process.platform === 'win32' ? file.toLowerCase() : file; }
export function parseCoreArgs(args) {
  assert(Array.isArray(args) && typeof args[0] === 'string' && args[0], 'Core command is required');
  const [command, ...rest] = args;
  const options = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index], value = rest[index + 1];
    assert(name?.startsWith('--') && typeof value === 'string' && !options.has(name), `Invalid or duplicate core option: ${name}`);
    options.set(name, value);
  }
  return { command, options };
}
function required(options, name) { assert(options.has(name), `Core command requires ${name}`); return options.get(name); }
export async function loadCanonicalCore(coreCli) {
  const file = path.join(path.dirname(localPath(coreCli, '--core-cli')), 'canonical-json.js');
  const module = await import(pathToFileURL(file).href);
  assert(typeof module.sha256Canonical === 'function', 'Configured core canonical-json.js does not export sha256Canonical');
  return { sha256Canonical: module.sha256Canonical, path: file, sha256: await fileHash(file) };
}
function warningsForTranscript(transcript, cutPlan) {
  const warnings = [];
  const pauses = (cutPlan.operations ?? []).filter(operation => operation.kind === 'pause');
  const uncovered = [];
  for (let index = 0; index + 1 < transcript.segments.length; index++) {
    const left = transcript.segments[index], right = transcript.segments[index + 1];
    const gap = right.start - left.end;
    if (gap > 0.001 && gap < 0.8 && !pauses.some(pause => Math.abs(pause.sourceIn - left.end) < 0.001 && Math.abs(pause.sourceOut - right.start) < 0.001)) uncovered.push({ afterSegmentId: left.id, beforeSegmentId: right.id, sourceIn: left.end, sourceOut: right.start, durationSeconds: gap });
  }
  if (uncovered.length) warnings.push({ code: 'SHORT_PAUSES_NOT_IN_CUT_OPERATIONS', intervals: uncovered, message: 'Core rough render omits these unrepresented short pauses; review breathing and restore from source in fine cut when needed.' });
  const corrected = transcript.segments.filter(segment => typeof segment.asrText === 'string' && segment.asrText !== segment.text).map(segment => segment.id);
  if (corrected.length) warnings.push({ code: 'CORRECTED_TEXT_HAS_ORIGINAL_ASR_WORD_TIMES', segmentIds: corrected, message: 'Review-transcript changes sentence text but does not realign original ASR words. Use corrected sentence captions and verified rough/fine output time.' });
  const covered = new Set((transcript.reviewHistory ?? []).flatMap(review => (review.corrections ?? []).map(correction => correction.segmentId)));
  if (transcript.asrReviewStatus === 'reviewed' && covered.size < transcript.segments.length) warnings.push({ code: 'TRANSCRIPT_REVIEW_COVERAGE_NOT_PROVEN', reviewedSegmentCount: covered.size, segmentCount: transcript.segments.length, message: 'A reviewed flag does not prove full-video listening; retain the actual listening coverage separately.' });
  warnings.push({ code: 'CORE_ROUGH_AUDIO_USES_DYNAMIC_LOUDNORM', message: 'Existing core rough render applies dynamic loudnorm. Verify actual audio event positions; the fine-cut adapter preserves its input audio without another loudness pass.' });
  return warnings;
}

export async function preflightCore(args, { coreCli } = {}) {
  const { command, options } = parseCoreArgs(args);
  const result = { ok: true, command, guarded: false, warnings: [], coreStateModified: false };
  if (!new Set(['init', 'render-rough', 'qa-media']).has(command)) return result;
  const project = localPath(required(options, '--project'), '--project');
  result.guarded = true;
  if (command === 'init') {
    for (const artifact of ARTIFACTS) await assertNew(path.join(project, artifact));
    const source = localPath(required(options, '--source'), '--source');
    await sourceFile(source);
    result.sourceSha256 = await fileHash(source);
    return result;
  }
  if (command === 'qa-media') {
    const output = localPath(options.get('--report') ?? required(options, '--output'), '--report/--output');
    await assertNew(output);
    result.output = output;
    return result;
  }
  const output = localPath(required(options, '--output'), '--output'), srt = localPath(required(options, '--srt'), '--srt');
  const partial = `${output}.partial.mp4`;
  assert(new Set([output, srt, partial].map(key)).size === 3, 'MP4, SRT, and partial output paths must be distinct');
  for (const file of [output, srt, partial]) await assertNew(file);
  const projectFile = await readJson(path.join(project, 'project.json'));
  const assets = await readJson(path.join(project, 'assets.json'));
  const transcriptPath = path.join(project, 'transcript.json'), cutPath = path.join(project, 'cut-plan.json');
  const transcript = await readJson(transcriptPath), cutPlan = await readJson(cutPath), editPlan = await readJson(path.join(project, 'edit-plan.json'));
  assert(new Set(['visual_direction_ready', 'draft1_pending_user', 'revision_in_progress']).has(projectFile.workflowStatus), 'render-rough project state is not ready for a render');
  const source = (assets.assets ?? []).find(asset => asset.role === 'a-roll');
  assert(source, 'render-rough requires the actually registered a-roll asset');
  const sourcePath = localPath(source.path, 'a-roll path');
  await sourceFile(sourcePath);
  const sourceSha256 = await fileHash(sourcePath);
  assert(sourceSha256 === source.sha256, 'Registered source SHA256 does not match the actual file');
  assert(key(localPath(projectFile.source?.path, 'project.source.path')) === key(sourcePath), 'Project source path does not match the a-roll rendered by the core');
  assert(transcript.sourceAssetId === source.assetId && transcript.sourceAssetHash === sourceSha256, 'Transcript is not bound to this source asset/hash');
  assert(Array.isArray(transcript.segments) && transcript.segments.length && Array.isArray(transcript.words) && transcript.words.length, 'render-rough requires a real non-empty transcript');
  const canonical = await loadCanonicalCore(coreCli);
  const contentHash = canonical.sha256Canonical({ segments: transcript.segments, words: transcript.words });
  assert(contentHash === transcript.contentHash, 'Transcript internal contentHash is stale or does not use the actual core canonical JSON algorithm');
  const transcriptSha256 = await fileHash(transcriptPath), cutPlanSha256 = await fileHash(cutPath);
  assert(cutPlan.transcriptHash === transcriptSha256, 'Cut plan transcriptHash must match the transcript file SHA256, not its internal contentHash');
  assert(cutPlan.transcriptContentHash === contentHash, 'Cut plan transcriptContentHash does not match the actual canonical transcript content');
  assert(cutPlan.reviewStatus === 'approved' && editPlan.reviewStatus === 'ready', 'render-rough requires reviewed cut operations and a ready edit plan');
  assert(editPlan.cutPlanHash === cutPlanSha256, 'Edit plan cutPlanHash does not match the actual cut plan file SHA256');
  result.bindings = { sourcePath, sourceSha256, transcriptSha256, transcriptContentHash: contentHash, cutPlanSha256, canonicalModulePath: canonical.path, canonicalModuleSha256: canonical.sha256 };
  result.outputs = { output, srt, partial };
  result.warnings = warningsForTranscript(transcript, cutPlan);
  const uncoveredPauses = result.warnings.find(warning => warning.code === 'SHORT_PAUSES_NOT_IN_CUT_OPERATIONS');
  assert(!uncoveredPauses, `SHORT_PAUSES_NOT_IN_CUT_OPERATIONS: ${JSON.stringify(uncoveredPauses?.intervals ?? [])}. New projects should regenerate plan-cut and review these preserved source ranges. For an existing project, preserve its reviewed decisions before a controlled plan repair; do not silently delete natural pauses or hand-edit hashes to bypass this check.`);
  result.limitations = ['Read-only preflight does not replace the existing core project-state lock or provide an atomic render transaction.', 'Hash checks and state labels do not constitute listening or user confirmation.'];
  return result;
}
async function main() {
  const args = process.argv.slice(2), divider = args.indexOf('--');
  assert(divider === 2 && args[0] === '--core-cli' && args[1], 'node core-preflight.mjs --core-cli EXISTING-CLI.js -- COMMAND --project PROJECT ...');
  console.log(JSON.stringify(await preflightCore(args.slice(divider + 1), { coreCli: args[1] })));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
