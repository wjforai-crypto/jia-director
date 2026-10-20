import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const skillRoot = resolve(here, '../..');
const workspace = resolve(skillRoot, '../..');
const builder = join(skillRoot, 'scripts/build-directed-motion.mjs');
const checksParent = join(workspace, 'checks/2026-10-06/gap-closure/skill-supplement-v01');
await mkdir(checksParent, { recursive: true });
const checkRoot = await mkdtemp(join(checksParent, 'builder-tests-'));
const base = JSON.parse(await readFile(join(skillRoot, 'assets/directed-motion/life-buffer.example.json'), 'utf8'));
const runtime = JSON.parse((await readFile(join(workspace, 'config/video-workflow.json'), 'utf8')).replace(/^\uFEFF/u, ''));
const results = [];

async function runCase(name, input, expectation) {
  const inputPath = join(checkRoot, `${name}.json`), output = join(checkRoot, `${name}-engineering`);
  await writeFile(inputPath, JSON.stringify(input, null, 2), { flag: 'wx' });
  const execution = spawnSync(process.execPath, [builder, '--input', inputPath, '--output', output,
    '--gsap', runtime.render.motionGsapPath, '--font', runtime.render.motionFontPath ?? 'C:/Windows/Fonts/msyh.ttc'],
  { encoding: 'utf8', windowsHide: true });
  assert.equal(execution.status, expectation === true ? 0 : 1, execution.stderr);
  if (expectation !== true) {
    assert.match(execution.stderr, expectation);
    await assert.rejects(stat(output), /ENOENT/, 'invalid input must not produce an engineering directory');
  }
  results.push({ name, passed: true, actualExitCode: execution.status, stderr: execution.stderr.trim(), output });
  return output;
}

test('omitting the complete canvas cannot silently select 480P or 16 seconds', async () => {
  const input = structuredClone(base); delete input.canvas;
  await runCase('missing-canvas', input, /canvas must be an object/);
});
test('each required canvas dimension and timing field rejects omission', async () => {
  for (const field of ['width', 'height', 'fps', 'duration']) {
    const input = structuredClone(base); delete input.canvas[field];
    await runCase(`missing-${field}`, input, new RegExp(`canvas\\.${field} is required`));
  }
});
test('null, strings, nonpositive duration and fractional integer fields cannot become defaults', async () => {
  for (const [name, field, value, error] of [
    ['null-width', 'width', null, /canvas\.width must be/],
    ['string-fps', 'fps', '30', /canvas\.fps must be/],
    ['zero-duration', 'duration', 0, /canvas\.duration must be/],
    ['fractional-height', 'height', 480.5, /canvas width\/height\/fps must be integers/],
  ]) {
    const input = structuredClone(base); input.canvas[field] = value;
    await runCase(name, input, error);
  }
});
test('the existing explicitly specified insurance example still builds unchanged scene content', async () => {
  const output = await runCase('explicit-existing-example', structuredClone(base), true);
  const normalized = JSON.parse(await readFile(join(output, 'scene.json'), 'utf8'));
  assert.deepEqual(normalized.canvas, base.canvas);
  assert.equal(normalized.nodes.length, base.nodes.length);
  assert.equal(normalized.tracks.length, base.tracks.length);
  const html = await readFile(join(output, 'index.html'), 'utf8');
  assert.match(html, /data-width="854" data-height="480"/);
  assert.match(html, /data-duration="16"/);
});
test('a separately configured landscape composition keeps its actual dimensions and duration', async () => {
  const input = { schemaVersion: 1, compositionId: 'landscape-check', title: '参数验证',
    canvas: { width: 1920, height: 1080, fps: 24, duration: 4 },
    nodes: [{ id: 'title', kind: 'text', x: 960, y: 540, text: '明确画幅与时长' }] };
  const output = await runCase('explicit-landscape', input, true);
  assert.deepEqual(JSON.parse(await readFile(join(output, 'scene.json'), 'utf8')).canvas, input.canvas);
  assert.match(await readFile(join(output, 'index.html'), 'utf8'), /data-duration="4" data-width="1920" data-height="1080"/);
});

after(async () => {
  await writeFile(join(checkRoot, 'validation.json'), JSON.stringify({ kind: 'explicit-canvas-builder-validation',
    casesPassed: results.length, cases: results, upstreamExecuted: false, renderingPerformed: false,
    note: 'Schema and actual output construction only; no new creative-quality claim or exported-video modification.' }, null, 2), { flag: 'wx' });
});
