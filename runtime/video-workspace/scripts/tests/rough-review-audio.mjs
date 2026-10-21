// Check original->rough timing with real decoded speech, without claiming subjective listening.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { native } from '../rough-review.mjs';
const dir = resolve(process.argv[2]), map = JSON.parse(await readFile(join(dir, 'mapping.json'), 'utf8'));
async function pcm(file, start) {
  const bytes = await native('ffmpeg', ['-nostdin', '-v', 'error', '-ss', String(start), '-i', file, '-t', '1.5', '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'], { binary: true });
  const samples = []; for (let i = 0; i < bytes.length; i += 2) samples.push(bytes.readInt16LE(i)); return samples;
}
const windows = [];
for (const k of map.keeps) {
  if (k.sourceEnd - k.sourceStart < 3) continue;
  const offset = Math.min(2, (k.sourceEnd - k.sourceStart) / 3), sourceTime = k.sourceStart + offset, outputTime = k.outputStart + offset;
  const [a, b] = await Promise.all([pcm(map.source.path, sourceTime), pcm(join(dir, 'rough.mp4'), outputTime)]);
  let best = { correlation: -1, offsetSamples: 0 };
  for (let lag = -160; lag <= 160; lag++) {
    let xy = 0, xx = 0, yy = 0, sx = 0, sy = 0, n = 0;
    for (let i = 200; i < Math.min(a.length, b.length) - 200; i++) { const x = a[i], y = b[i + lag]; xy += x * y; xx += x * x; yy += y * y; sx += x; sy += y; n++; }
    const r = (xy - sx * sy / n) / Math.sqrt((xx - sx * sx / n) * (yy - sy * sy / n));
    if (r > best.correlation) best = { correlation: r, offsetSamples: lag };
  }
  assert.ok(best.correlation > .9 && Math.abs(best.offsetSamples) <= 16, 'decoded source audio must stay aligned within 1ms');
  windows.push({ sourceTime, outputTime, ...best, offsetMs: best.offsetSamples / 16 });
}
assert.ok(windows.length > 0, 'need a speech window');
const receipt = { status: 'measured-audio-alignment-passed', windows, sampleRate: 16000, listeningCompleted: false, scope: 'retained speech windows only, not subjective cut-edge quality' };
await writeFile(join(dir, 'audio-alignment.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' }); console.log(JSON.stringify(receipt));
