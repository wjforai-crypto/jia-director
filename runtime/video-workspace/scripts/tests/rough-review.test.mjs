import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeTranscript, validateEdits, makeTimeline, buildCues, toSrt } from '../rough-review-model.mjs';
import { native, prepareReview, readReview, saveReview, exportReview, serveReview, hashFile, importSuggestions } from '../rough-review.mjs';
import { makePlan, renderPlan } from '../fine-cut.mjs';
const raw = { sourceAssetHash: undefined, segments: [{ id: 's1', start: 0, end: 1, text: '不能这样', wordIds: ['a', 'b', 'c'] }, { id: 's2', start: 1.5, end: 2.8, text: '结束', wordIds: ['d'] }],
  words: [{ id: 'a', text: '不', start: 0, end: .3, confidence: .9 }, { id: 'b', text: '能', start: .3, end: .5, confidence: .9 }, { id: 'c', text: '这样', start: .5, end: 1, confidence: .9 }, { id: 'd', text: '结束', start: 1.5, end: 2.8, confidence: .9 }] };
const empty = { cuts: [], corrections: {}, subtitleOverrides: {} };
const cut = (start, end, id = 'c') => ({ id, start, end, reason: '明确测试范围', origin: 'manual' });

test('zero and overlapping ASR tokens merge conservatively; no fabricated per-word alignment', () => {
  const input = structuredClone(raw); input.words[0].end = 0;
  const normalized = normalizeTranscript(input, 3);
  assert.deepEqual(normalized.units[0].wordIds, ['a', 'b']);
  assert.deepEqual([normalized.units[0].start, normalized.units[0].end], [0, .5]);
  assert.equal(normalized.units[0].timingKind, 'merged-ASR-span');
  assert.equal(normalized.units[0].text, '不能');
  input.words[2].start = .4;
  assert.equal(normalizeTranscript(input, 3).units[0].text, '不能这样');
  input.words[2].end = 4;
  assert.throws(() => normalizeTranscript(input, 3), /时间码无效/);
});

test('cut union and frame complement preserve every other frame and natural gap', () => {
  const t = makeTimeline([cut(.31, .8), cut(.5, 1.1, 'overlap')], 3, 30);
  assert.deepEqual(t.keeps.map(k => [k.sourceStartFrame, k.sourceEndFrame, k.outputStartFrame, k.outputEndFrame]), [[0, 9, 0, 9], [33, 90, 9, 66]]);
  assert.equal(t.outputFrames + t.droppedFrames, 90);
  const word = makeTimeline([cut(.51, .67)], 3, 30);
  assert.ok(word.keeps.every(k => k.sourceEnd <= .51 || k.sourceStart >= .67), 'selected word must not leave a sub-frame remnant');
  assert.equal(makeTimeline([], 3, 30).outputFrames, 90);
  assert.throws(() => makeTimeline([cut(0, 3)], 3, 30), /全部/);
  assert.throws(() => validateEdits({ ...empty, cuts: [cut(-1, 2)] }, normalizeTranscript(raw, 3), 3), /越界/);
  assert.throws(() => validateEdits({ ...empty, corrections: { 'u:s1:0': '' } }, normalizeTranscript(raw, 3), 3), /空文字/);
});

test('script-backed correction is separate from deletion; clipped corrected segments require fragment review', () => {
  const input = structuredClone(raw); input.segments[0].text = '不能那样';
  const tr = normalizeTranscript(input, 3), edits = { ...empty, cuts: [cut(.5, 1)] }, t = makeTimeline(edits.cuts, 3, 30);
  const cs = buildCues(tr, edits, t);
  assert.equal(cs[0].text, '不能'); assert.equal(cs[0].requiresCorrection, true);
  edits.subtitleOverrides = { [cs[0].key]: '不能' };
  assert.equal(buildCues(tr, edits, t)[0].requiresCorrection, false);
  const corrected = { ...empty, corrections: { 'u:s1:2': '那样' } };
  assert.equal(buildCues(tr, corrected, makeTimeline([], 3, 30))[0].text, '不能那样');
  assert.match(toSrt(cs), /00:00:00,000 --> 00:00:00,500\n不能/);
});

test('real MP4 review persists, protects revisions/bindings, exports matched SRT/mapping, and renders a fine-cut handoff', async t => {
  const dir = resolve('checks/2026-10-10/local-rough-review', `integration-${randomUUID()}`); await mkdir(dir, { recursive: true });
  const source = join(dir, 'input.mp4'), transcript = join(dir, 'raw.json'), project = join(dir, 'review');
  await native('ffmpeg', ['-nostdin', '-v', 'error', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=441:sample_rate=48000:duration=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-ar', '48000', '-shortest', source]);
  const sourceHash = await hashFile(source); raw.sourceAssetHash = sourceHash; await writeFile(transcript, JSON.stringify(raw), { flag: 'wx' });
  await prepareReview({ input: source, transcriptInput: transcript, outputDir: project });
  await assert.rejects(prepareReview({ input: source, transcriptInput: transcript, outputDir: project }), /EEXIST/);
  let r = await readReview(project); assert.equal(r.timeline.outputFrames, 90);
  const initial = { ...empty, revision: 0, cuts: [cut(1, 1.5)] };
  await saveReview(project, initial); await assert.rejects(saveReview(project, initial), /STALE_REVISION/);
  r = await readReview(project); assert.equal(r.edits.revision, 1); assert.equal(r.timeline.outputFrames, 75);
  await assert.rejects(exportReview(project, { revision: 0 }), /STALE_REVISION/);
  const suggestionPath = join(dir, 'suggestions.json');
  await writeFile(suggestionPath, JSON.stringify({ sourceSha256: 'wrong', transcriptSha256: r.project.transcript.sha256, suggestions: [] }));
  await assert.rejects(importSuggestions(project, suggestionPath), /绑定/);
  const server = await serveReview(project); t.after(() => new Promise(res => server.server.close(res)));
  const request = async (path, init) => fetch(server.url + path, init);
  const state = await (await request('/api/state')).json();
  assert.equal(state.edits.revision, 1); assert.equal(state.project.rules.originalAudio, true);
  assert.equal((await request('/media', { headers: { Range: 'bytes=0-99' } })).status, 206);
  const suffix = await request('/media', { headers: { Range: 'bytes=-32' } }); assert.equal((await suffix.arrayBuffer()).byteLength, 32);
  assert.equal((await request('/media', { headers: { Range: 'bytes=999999999-' } })).status, 416);
  assert.equal((await request('/media', { headers: { Range: 'bytes=0-10,20-30' } })).status, 416);
  assert.equal((await request('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...initial, revision: 1 }) })).status, 400);
  const post = body => request('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: server.url, 'X-Review-Token': state.token }, body: JSON.stringify(body) });
  const race = await Promise.all([post({ ...initial, revision: 1 }), post({ ...initial, revision: 1 })]);
  assert.equal(race.filter(r => r.status === 200).length, 1); assert.equal(race.filter(r => [400, 409].includes(r.status)).length, 1);
  r = await readReview(project); assert.equal(r.edits.revision, 2);
  const output = await exportReview(project, { revision: 2 }); assert.equal(output.qaPassed, true);
  const mapping = JSON.parse(await readFile(output.files['mapping.json'].path)); assert.equal(mapping.outputFrames, 75);
  assert.deepEqual(mapping.keeps.map(k => [k.sourceStartFrame, k.sourceEndFrame]), [[0, 30], [45, 90]]);
  const text = await readFile(output.files['rough.srt'].path, 'utf8'); assert.match(text, /不能这样/); assert.match(text, /00:00:01,000 --> 00:00:02,300\n结束/);
  const second = await exportReview(project, { revision: 2 }); assert.notEqual(second.outputDir, output.outputDir);
  assert.equal(await hashFile(output.files['rough.mp4'].path), output.files['rough.mp4'].sha256);
  const fineDir = join(dir, 'fine'); await mkdir(fineDir);
  const cuts = join(fineDir, 'cuts.json'), plan = join(fineDir, 'plan.json');
  await writeFile(cuts, JSON.stringify({ scope: 'technical-edge-refinement', segments: [{ id: 'trim-tail', startFrame: 0, endFrameExclusive: 74, reason: '只修整尾部一帧，验证实际精剪承接' }] }));
  const planned = await makePlan({ input: output.files['rough.mp4'].path, sourceSrt: output.files['rough.srt'].path, cuts, output: plan });
  const fine = await renderPlan({ plan, reviewedPlanSha256: planned.sha256, output: join(fineDir, 'fine.mp4'), srt: join(fineDir, 'fine.srt'), mapping: join(fineDir, 'mapping.json'), qa: join(fineDir, 'qa.json'), receipt: join(fineDir, 'receipt.json') });
  assert.equal(fine.qaPassed, true); assert.equal(fine.frames, 74);
  await writeFile(source, 'changed', { flag: 'a' });
  await assert.rejects(saveReview(project, { ...initial, revision: 2 }), /原片变化/);
  assert.equal(await hashFile(output.files['rough.mp4'].path), output.files['rough.mp4'].sha256);
});
