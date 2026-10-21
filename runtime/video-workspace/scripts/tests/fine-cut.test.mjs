import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMapping, makePlan, normalizeSegments, parseSrt, remapSrt, renderPlan } from '../fine-cut.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const valid = segments => ({ scope: 'technical-edge-refinement', segments });
const segment = (startFrame, endFrameExclusive, id = 'clip-1') => ({ id, startFrame, endFrameExclusive, reason: '核查后的技术边缘修整' });
const outputPaths = folder => ({ output: path.join(folder, 'fine-base.mp4'), srt: path.join(folder, 'fine.srt'), mapping: path.join(folder, 'rough-to-fine.json'), qa: path.join(folder, 'qa.json'), receipt: path.join(folder, 'receipt.json') });
const fileHash = async file => createHash('sha256').update(await readFile(file)).digest('hex');

test('frame ranges reject invalid, empty, out-of-bounds, duplicate, overlapping, and reordered cuts', () => {
  for (const segments of [
    [segment(-1, 5)], [segment(0, 0)], [segment(0, 10.5)], [segment(0, 101)],
    [segment(0, 10), segment(20, 30)],
    [segment(0, 20, 'first'), segment(19, 30, 'second')],
    [segment(20, 30, 'first'), segment(0, 10, 'second')],
    [{ ...segment(0, 30), reason: '' }],
  ]) assert.throws(() => normalizeSegments(valid(segments), 100));
  assert.throws(() => normalizeSegments({ scope: 'semantic-reorder', segments: [segment(0, 20)] }, 100), /semantic deletion/);
  assert.deepEqual(normalizeSegments(valid([segment(0, 30)]), 100), [segment(0, 30)]);
});

test('SRT remapping keeps words and continuous output timing across retained source ranges', () => {
  const cues = parseSrt('1\n00:00:00,000 --> 00:00:02,000\n保持完整的句子\n第二行\n\n2\n00:00:02,000 --> 00:00:03,000\n结尾\n', 3);
  const mapping = createMapping([segment(0, 30, 'first'), segment(36, 90, 'second')], 30);
  const result = remapSrt(cues, mapping);
  assert.equal(result.cues.length, 2);
  assert.deepEqual(result.cues[0], { sourceCueId: 1, startMs: 0, endMs: 1800, text: '保持完整的句子\n第二行' });
  assert.equal(result.cues[1].startMs, result.cues[0].endMs);
  assert.equal(result.cues[1].endMs, 2800);
  assert.deepEqual(result.audit.clippedCueIds, [1]);
  assert.deepEqual(result.audit.unmappedCueIds, []);
  assert.equal(result.audit.textChanged, false);
  assert.equal(parseSrt(result.text, 2.8).length, 2);
  assert.throws(() => parseSrt('1\n00:00:00,700 --> 00:00:00,300\n错位\n'), /unordered/);
});

test('real synthetic rough video plans and renders with protected outputs and bound source/plan/SRT hashes', async t => {
  const folder = path.join(workspace, 'checks', '2026-10-06', 'gap-closure', `fine-test-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
  await mkdir(folder, { recursive: true });
  const source = path.join(folder, 'synthetic-rough.mp4'), sourceSrt = path.join(folder, 'rough.srt'), cuts = path.join(folder, 'cuts.json'), plan = path.join(folder, 'fine-plan.json');
  const generated = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=441:sample_rate=48000:duration=3', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-shortest', source], { encoding: 'utf8', windowsHide: true });
  assert.equal(generated.status, 0, generated.stderr);
  await writeFile(sourceSrt, '1\n00:00:00,000 --> 00:00:00,900\n第一句技术测试\n\n2\n00:00:01,250 --> 00:00:02,400\n第二句保持原文\n', { flag: 'wx' });
  await writeFile(cuts, JSON.stringify(valid([segment(0, 30, 'first'), segment(36, 72, 'second')])), { flag: 'wx' });
  const planned = await makePlan({ input: source, sourceSrt, cuts, output: plan });
  assert.equal(planned.expected.frames, 66);
  assert.equal(planned.expected.durationSeconds, 2.2);
  assert.equal((await JSON.parse(await readFile(plan, 'utf8'))).source.frames, 90);
  await t.test('planning cannot overwrite an existing file', async () => {
    const prior = await fileHash(plan);
    await assert.rejects(makePlan({ input: source, sourceSrt, cuts, output: plan }), /Output already exists/);
    assert.equal(await fileHash(plan), prior);
  });
  await t.test('render requires the exact explicitly reviewed plan file digest', async () => {
    await assert.rejects(renderPlan({ plan, ...outputPaths(path.join(folder, 'wrong-hash')) }), /reviewed-plan-sha256/);
    await assert.rejects(renderPlan({ plan, reviewedPlanSha256: '0'.repeat(64), ...outputPaths(path.join(folder, 'wrong-hash')) }), /Reviewed plan SHA256/);
  });
  await t.test('modified plan bytes cannot reuse the reviewed digest or bypass frame validation', async () => {
    const modified = path.join(folder, 'modified-plan.json');
    const payload = JSON.parse(await readFile(plan, 'utf8'));
    payload.segments[0].endFrameExclusive = 999;
    await writeFile(modified, JSON.stringify(payload), { flag: 'wx' });
    await assert.rejects(renderPlan({ plan: modified, reviewedPlanSha256: planned.sha256, ...outputPaths(path.join(folder, 'plan-changed')) }), /Reviewed plan SHA256/);
    await assert.rejects(renderPlan({ plan: modified, reviewedPlanSha256: await fileHash(modified), ...outputPaths(path.join(folder, 'invalid-frames')) }), /frame range is outside/);
  });
  const result = await renderPlan({ plan, reviewedPlanSha256: planned.sha256, ...outputPaths(path.join(folder, 'rendered')) });
  assert.equal(result.frames, 66);
  assert.equal(result.qaPassed, true);
  const qa = JSON.parse(await readFile(result.qa, 'utf8'));
  assert.equal(qa.actual.frames, 66);
  assert.equal(qa.actual.sampleRate, 48000);
  assert.ok(qa.audioVideoDurationDeltaSeconds <= 1 / 30 + 0.001);
  assert.equal(qa.checks.fullDecode, true);
  assert.equal(qa.subjectiveListeningCompleted, false);
  const mapping = JSON.parse(await readFile(result.mapping, 'utf8'));
  assert.deepEqual(mapping.segments.map(item => [item.fineStartFrame, item.fineEndFrameExclusive]), [[0, 30], [30, 66]]);
  const outputCues = parseSrt(await readFile(result.srt, 'utf8'), 2.2);
  assert.deepEqual(outputCues.map(cue => cue.text), ['第一句技术测试', '第二句保持原文']);
  assert.deepEqual(outputCues.map(cue => [cue.startMs, cue.endMs]), [[0, 900], [1050, 2200]]);
  const receipt = JSON.parse(await readFile(result.receipt, 'utf8'));
  assert.equal(receipt.core.versionRegistration, 'not-recorded');
  assert.equal(receipt.core.review, 'pending-core-review');
  assert.equal(receipt.core.projectStateModified, false);
  assert.ok(!receipt.ffmpeg.arguments.join(' ').includes('loudnorm'));
  assert.equal(receipt.outputs.output.sha256, await fileHash(result.output));
  await t.test('render cannot overwrite MP4, SRT, mapping, QA, or receipt', async () => {
    for (const key of ['output', 'srt', 'mapping', 'qa', 'receipt']) {
      const outputs = outputPaths(path.join(folder, `collision-${key}`));
      outputs[key] = result[key];
      const prior = await fileHash(result[key]);
      await assert.rejects(renderPlan({ plan, reviewedPlanSha256: planned.sha256, ...outputs }), /Output already exists/);
      assert.equal(await fileHash(result[key]), prior);
    }
  });
  await t.test('changed SRT is rejected before rendering', async () => {
    const original = await readFile(sourceSrt);
    await writeFile(sourceSrt, `${original.toString('utf8')}\n`);
    await assert.rejects(renderPlan({ plan, reviewedPlanSha256: planned.sha256, ...outputPaths(path.join(folder, 'srt-changed')) }), /SRT changed/);
    await writeFile(sourceSrt, original);
  });
  await t.test('a source hash change is rejected before rendering', async () => {
    const changed = path.join(folder, 'changed-source.mp4'), changedPlan = path.join(folder, 'changed-plan.json');
    await copyFile(source, changed);
    const locked = await makePlan({ input: changed, sourceSrt, cuts, output: changedPlan });
    await writeFile(changed, Buffer.from('unapproved-source-change'), { flag: 'a' });
    await assert.rejects(renderPlan({ plan: changedPlan, reviewedPlanSha256: locked.sha256, ...outputPaths(path.join(folder, 'source-changed')) }), /source changed/);
  });
  await t.test('entire subtitle deletion is refused as semantic rough-cut work', async () => {
    const semanticCuts = path.join(folder, 'semantic-deletion.json');
    await writeFile(semanticCuts, JSON.stringify(valid([segment(0, 30)])), { flag: 'wx' });
    await assert.rejects(makePlan({ input: source, sourceSrt, cuts: semanticCuts, output: path.join(folder, 'must-not-write-plan.json') }), /delete entire subtitle cues/);
  });
  await t.test('variable frame rate rough-cut input is refused before a plan is written', async () => {
    const variable = path.join(folder, 'vfr-rough.mp4');
    const generatedVfr = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-n', '-i', source, '-vf', "select='not(mod(n,3))+not(mod(n,5))'", '-fps_mode', 'vfr', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'copy', variable], { encoding: 'utf8', windowsHide: true });
    assert.equal(generatedVfr.status, 0, generatedVfr.stderr);
    await assert.rejects(makePlan({ input: variable, cuts, output: path.join(folder, 'must-not-write-vfr-plan.json') }), /Variable frame rate|not CFR/);
  });
  await writeFile(path.join(folder, 'verification.json'), `${JSON.stringify({ technicalRenderStatus: 'PASS', suiteStatus: 'Check node --test exit status for the full suite; this receipt describes the rendered fixture only.', result, fixture: 'FFmpeg testsrc2 plus synthetic sine; no personal voice', originalAudioNormalized: false, userVoiceOrHumanListeningTested: false }, null, 2)}\n`, { flag: 'wx' });
  console.log(`Fine-cut verification artifacts: ${folder}`);
});
