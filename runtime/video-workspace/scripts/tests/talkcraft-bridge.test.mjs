import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { coreWordsToFlat, validateEdl, audioRemixWarnings, exportWords, importEdl } from '../talkcraft-bridge.mjs';

const SOURCE_HASH = 'a'.repeat(64);
const transcript = () => ({ sourceAssetId: 'asset_source', sourceAssetHash: SOURCE_HASH, engine: 'whisper.cpp',
  segments: [{ id: 'seg', text: '用户已经校对为这个文本' }],
  words: [
    { id: 'w1', text: '原ASR', start: 0.1, end: 0.4, sourceAssetId: 'asset_source' },
    { id: 'w2', text: '嗯', start: 0.5, end: 0.7, sourceAssetId: 'asset_source' },
  ] });
const edl = () => ({ source: 'source.wav', sr: 48000, fps: 30, src_total: 3, out_total: 2,
  removed: 1, cuts: [{ start: 1, end: 2, kind: 'pause', text: '' }],
  keep: [{ src_start: 0, src_end: 1, dst_start: 0 }, { src_start: 2, src_end: 3, dst_start: 1 }] });

test('flat export preserves original word text and does not fabricate corrected-script alignment', () => {
  assert.deepEqual(coreWordsToFlat(transcript(), SOURCE_HASH, 1), [
    { text: '原ASR', start: 0.1, end: 0.4 }, { text: '嗯', start: 0.5, end: 0.7 },
  ]);
});
test('actual source binding rejects a stale transcript hash', () => {
  assert.throws(() => coreWordsToFlat(transcript(), 'b'.repeat(64)), /TRANSCRIPT_SOURCE_HASH_MISMATCH/);
});
test('missing, coercible and zero-length timing are rejected instead of interpolated', () => {
  for (const value of [undefined, null, '0.5']) {
    const data = transcript(); data.words[1].start = value;
    assert.throws(() => coreWordsToFlat(data, SOURCE_HASH), /WORD_TIMING_INVALID/);
  }
  const data = transcript(); data.words[1].end = data.words[1].start;
  assert.throws(() => coreWordsToFlat(data, SOURCE_HASH), /WORD_TIMING_INVALID/);
});
test('word identity and original time order remain bound to the source asset', () => {
  const sourceMismatch = transcript(); sourceMismatch.words[1].sourceAssetId = 'other';
  assert.throws(() => coreWordsToFlat(sourceMismatch, SOURCE_HASH), /WORD_SOURCE_ASSET_MISMATCH/);
  const duplicates = transcript(); duplicates.words[1].id = 'w1';
  assert.throws(() => coreWordsToFlat(duplicates, SOURCE_HASH), /DUPLICATE_WORD_ID/);
  const order = transcript(); order.words[1].start = 0;
  assert.throws(() => coreWordsToFlat(order, SOURCE_HASH), /WORD_TIMELINE_INVALID/);
});
test('EDL maps full retained intervals into a contiguous shortened timeline', () => {
  const result = validateEdl(edl());
  assert.deepEqual(result.keep, [
    { sourceIn: 0, sourceOut: 1, timelineIn: 0, timelineOut: 1 },
    { sourceIn: 2, sourceOut: 3, timelineIn: 1, timelineOut: 2 },
  ]);
  assert.equal(result.removedDurationSeconds, 1);
});
test('overlapping or reversed cuts cannot enter a review candidate', () => {
  const overlap = edl(); overlap.cuts.push({ start: 1.8, end: 2.2 });
  assert.throws(() => validateEdl(overlap), /EDL_CUT_OVERLAP_OR_ORDER/);
  const reversed = edl(); reversed.cuts[0] = { start: 2, end: 1 };
  assert.throws(() => validateEdl(reversed), /EDL_CUT_INVALID/);
});
test('keep gaps, duplicate source ranges and target-time displacement are rejected', () => {
  const gap = edl(); gap.keep[1].src_start = 2.2;
  assert.throws(() => validateEdl(gap), /EDL_KEEP_DOES_NOT_MATCH_CUTS/);
  const duplicate = edl(); duplicate.keep[1] = { src_start: 0, src_end: 1, dst_start: 1 };
  assert.throws(() => validateEdl(duplicate), /EDL_KEEP_DOES_NOT_MATCH_CUTS/);
  const displaced = edl(); displaced.keep[1].dst_start = 1.2;
  assert.throws(() => validateEdl(displaced), /EDL_DESTINATION_MAPPING_INVALID/);
});
test('declared totals cannot conceal missing or duplicated material', () => {
  const duration = edl(); duration.out_total = 2.1;
  assert.throws(() => validateEdl(duration), /EDL_OUTPUT_DURATION_MISMATCH/);
  const removed = edl(); removed.removed = 0.8;
  assert.throws(() => validateEdl(removed), /EDL_REMOVED_DURATION_MISMATCH/);
  removed.removed = '1';
  assert.throws(() => validateEdl(removed), /EDL_REMOVED_DURATION_MISMATCH/);
});
test('a silent trimmed picture requires explicit remix of the preserved source voice', () => {
  const warnings = audioRemixWarnings({ hasAudio: true, hasVideo: true }, { hasAudio: false, hasVideo: true });
  assert.ok(warnings.includes('PRESERVE_SOURCE_VOICE_AND_REMIX_CLEAN_AUDIO_AFTER_VIDEO_ONLY_TRIM'));
  assert.ok(warnings.includes('RENDERED_VIDEO_HAS_NO_AUDIO_NOT_A_COMPLETE_DELIVERY'));
  assert.ok(warnings.includes('CANDIDATE_ONLY_NO_CORE_APPROVAL_OR_EXECUTION'));
});

test('real-media export/import preserve file hashes, refuse overwrite and never mark approval', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'talkcraft-bridge-test-'));
  const source = join(dir, 'source.wav'), picture = join(dir, 'picture.mp4');
  const created = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'sine=frequency=440:sample_rate=48000:duration=3', '-c:a', 'pcm_s16le', '-n', source], { windowsHide: true });
  assert.equal(created.status, 0, 'local FFmpeg creates the audio fixture');
  const sourceHash = createHash('sha256').update(await readFile(source)).digest('hex');
  const transcriptPath = join(dir, 'transcript.json'), wordsPath = join(dir, 'words.json');
  const data = transcript(); data.sourceAssetHash = sourceHash;
  await writeFile(transcriptPath, JSON.stringify(data));
  const exported = await exportWords({ transcript: transcriptPath, source, output: wordsPath });
  assert.equal(exported.sourceHash, sourceHash);
  const binding = JSON.parse(await readFile(exported.binding, 'utf8'));
  assert.equal(binding.alignedToReviewedScript, false);
  assert.equal(binding.networkRequests, 0);
  assert.equal(binding.words.sha256, createHash('sha256').update(await readFile(wordsPath)).digest('hex'));
  const before = await readFile(wordsPath);
  await assert.rejects(exportWords({ transcript: transcriptPath, source, output: wordsPath }), /OUTPUT_EXISTS_NO_OVERWRITE/);
  assert.deepEqual(await readFile(wordsPath), before);
  const standaloneWords = join(dir, 'sidecar-conflict.json');
  await writeFile(`${standaloneWords}.binding.json`, 'existing user sidecar');
  await assert.rejects(exportWords({ transcript: transcriptPath, source, output: standaloneWords }), /OUTPUT_EXISTS_NO_OVERWRITE/);
  await assert.rejects(readFile(standaloneWords), /ENOENT/);
  assert.equal(await readFile(`${standaloneWords}.binding.json`, 'utf8'), 'existing user sidecar');
  const video = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'color=c=blue:s=160x90:r=30:d=2', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-n', picture], { windowsHide: true });
  assert.equal(video.status, 0);
  const edlPath = join(dir, 'cuts.json');
  const cuts = edl(); cuts.source = source;
  await writeFile(edlPath, JSON.stringify(cuts));
  const output = join(dir, 'candidate.json');
  const receipt = await importEdl({ edl: edlPath, source, output, renderedVideo: picture });
  const candidate = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(candidate.source.sha256, sourceHash);
  assert.equal(candidate.edlInput.sha256, createHash('sha256').update(await readFile(edlPath)).digest('hex'));
  assert.equal(receipt.sha256, createHash('sha256').update(await readFile(output)).digest('hex'));
  assert.equal(candidate.approvedEdl, false);
  assert.equal(candidate.executable, false);
  assert.equal(candidate.coreStateChanged, false);
  assert.equal(candidate.recordingRelationship.sameRecordingAndZeroOffsetVerified, true);
  assert.ok(candidate.warnings.includes('RENDERED_VIDEO_HAS_NO_AUDIO_NOT_A_COMPLETE_DELIVERY'));
  await assert.rejects(importEdl({ edl: edlPath, source, output }), /OUTPUT_EXISTS_NO_OVERWRITE/);
  const badPath = join(dir, 'different-source.json');
  cuts.source = picture;
  await writeFile(badPath, JSON.stringify(cuts));
  await assert.rejects(importEdl({ edl: badPath, source, output: join(dir, 'bad-candidate.json') }), /EDL_DECLARED_SOURCE_MISMATCH/);
  const wrongDuration = edl(); wrongDuration.source = source;
  wrongDuration.src_total = 2.9; wrongDuration.keep[1].src_end = 2.9; wrongDuration.out_total = 1.9;
  const durationPath = join(dir, 'wrong-duration.json');
  await writeFile(durationPath, JSON.stringify(wrongDuration));
  await assert.rejects(importEdl({ edl: durationPath, source, output: join(dir, 'duration-candidate.json') }), /EDL_MEDIA_DURATION_MISMATCH/);
  const relativePath = join(dir, 'relative-source.json');
  const relative = edl(); relative.source = 'source.wav';
  await writeFile(relativePath, JSON.stringify(relative));
  const relativeReceipt = await importEdl({ edl: relativePath, source, edlSourceBase: dir,
    output: join(dir, 'relative-candidate.json') });
  assert.equal(relativeReceipt.sourceHash, sourceHash);
});
