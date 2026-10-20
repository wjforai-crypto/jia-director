import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--help' && argv.length === 1) return {help: true};
    if (!['--project', '--spec', '--input', '--output', '--ffprobe', '--ffmpeg'].includes(flag) ||
        !argv[i + 1] || argv[i + 1].startsWith('--') || Object.hasOwn(a, flag.slice(2))) {
      throw new Error('Invalid export-inspection arguments');
    }
    a[flag.slice(2)] = argv[++i];
  }
  if (!a.input || !a.output || Boolean(a.project) === Boolean(a.spec)) {
    throw new Error('Use exactly one of --project DIR or --spec FILE, plus --input VIDEO --output NEW_REPORT.json');
  }
  return a;
}

function run(exe, args) {
  const p = spawnSync(exe, args, {
    encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 180000
  });
  return {command: [exe, ...args], exitCode: p.status, signal: p.signal,
    error: p.error?.message ?? null, stdout: p.stdout ?? '', stderr: p.stderr ?? ''};
}

function successful(p) { return !p.error && p.exitCode === 0; }
function rational(s) {
  const [n, d = 1] = String(s ?? '').split('/').map(Number);
  return d !== 0 ? n / d : NaN;
}
async function sha256(file) {
  const h = createHash('sha256');
  for await (const block of createReadStream(file)) h.update(block);
  return h.digest('hex');
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) {
    console.log('inspect-export.mjs (--project DIR | --spec FILE) --input VIDEO --output NEW_REPORT.json [--ffprobe EXE] [--ffmpeg EXE]');
    return;
  }
  const output = path.resolve(a.output);
  try {
    await fs.lstat(output);
    throw new Error('Report exists; choose a new report');
  } catch (e) { if (e.code !== 'ENOENT') throw e; }

  const input = path.resolve(a.input);
  const specPath = path.resolve(a.spec ?? path.join(a.project, 'scene.json'));
  const report = {
    schemaVersion: 2, createdAt: new Date().toISOString(), input, specPath,
    technicalVerified: false, userAccepted: false, sha256: null, specSha256: null,
    expected: null, actual: null, fullDecode: false, timestamps: {status: 'NOT_REQUESTED'},
    commands: [], errors: [], framesViewed: false, continuousViewingPerformed: false,
    subjectiveListeningPerformed: false, motionVisualReview: 'PENDING',
    bodyCadenceVerified: false, sourceHashesVerified: false,
    scope: 'File specifications, decoded frame count, full decode and requested CFR timestamps only. No judgment of body cadence, duplicated poses, visual motion, source completeness, listening, playback performance or user acceptance.'
  };
  try {
    const spec = JSON.parse((await fs.readFile(specPath, 'utf8')).replace(/^\uFEFF/, ''));
    for (const k of ['width', 'height', 'fps', 'duration']) {
      if (typeof spec[k] !== 'number' || !Number.isFinite(spec[k]) || spec[k] <= 0) {
        throw new Error(`Invalid positive numeric spec.${k}`);
      }
    }
    if (!Number.isInteger(spec.width) || !Number.isInteger(spec.height)) throw new Error('Canvas dimensions must be integers');
    const audio = spec.audio ?? 'optional';
    if (!['none', 'required', 'optional'].includes(audio)) throw new Error('spec.audio must be none, required or optional');
    if (spec.frameMode !== undefined && spec.frameMode !== 'cfr') throw new Error('Only explicit spec.frameMode=cfr is supported');
    for (const k of ['codec', 'pixelFormat']) {
      if (spec[k] !== undefined && (typeof spec[k] !== 'string' || !spec[k])) throw new Error(`Invalid spec.${k}`);
    }
    report.specSha256 = await sha256(specPath);
    report.expected = {width: spec.width, height: spec.height, fps: spec.fps, duration: spec.duration,
      frames: Math.round(spec.duration * spec.fps), audio, frameMode: spec.frameMode ?? 'unspecified',
      codec: spec.codec ?? 'unspecified', pixelFormat: spec.pixelFormat ?? 'unspecified'};
    const before = await sha256(input);
    report.sha256 = before;
    const info = run(a.ffprobe ?? 'ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', input]);
    report.commands.push(info);
    if (!successful(info)) throw new Error(`ffprobe failed: ${info.error ?? info.stderr}`);
    const probe = JSON.parse(info.stdout);
    const videos = probe.streams.filter(s => s.codec_type === 'video');
    if (videos.length !== 1) throw new Error(`Expected one video stream; got ${videos.length}`);
    const video = videos[0], fps = rational(video.avg_frame_rate);
    const frames = Number(video.nb_read_frames);
    const duration = Number(video.duration ?? probe.format.duration);
    const audioStreams = probe.streams.filter(s => s.codec_type === 'audio').length;
    report.actual = {width: video.width, height: video.height, fps, duration, decodedFrames: frames,
      audioStreams, codec: video.codec_name, pixelFormat: video.pix_fmt};
    if (video.width !== spec.width || video.height !== spec.height) report.errors.push('canvas mismatch');
    if (!Number.isFinite(fps) || Math.abs(fps - spec.fps) > 1e-6) report.errors.push('fps mismatch');
    if (!Number.isFinite(duration) || Math.abs(duration - spec.duration) > 1 / spec.fps + .001) report.errors.push('duration mismatch');
    if (!Number.isFinite(frames) || frames !== report.expected.frames) report.errors.push('decoded frame-count mismatch');
    if (audio === 'none' && audioStreams !== 0) report.errors.push('unexpected audio stream');
    if (audio === 'required' && audioStreams === 0) report.errors.push('missing required audio stream');
    if (spec.codec && video.codec_name !== spec.codec) report.errors.push('codec mismatch');
    if (spec.pixelFormat && video.pix_fmt !== spec.pixelFormat) report.errors.push('pixel-format mismatch');

    const decode = run(a.ffmpeg ?? 'ffmpeg', ['-v', 'error', '-xerror', '-i', input,
      '-map', '0:v', '-map', '0:a?', '-f', 'null', '-']);
    report.commands.push(decode);
    report.fullDecode = successful(decode);
    if (!report.fullDecode) report.errors.push('full decode failed');

    if (spec.frameMode === 'cfr') {
      const pts = run(a.ffprobe ?? 'ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_frames',
        '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', input]);
      // Save the command/result without duplicating a possibly large frame list in stdout.
      report.commands.push({...pts, stdout: successful(pts) ? '(parsed into timestamps below)' : pts.stdout});
      if (!successful(pts)) throw new Error(`CFR timestamp probe failed: ${pts.error ?? pts.stderr}`);
      const times = JSON.parse(pts.stdout).frames.map(f =>
        f.best_effort_timestamp_time === undefined ? NaN : Number(f.best_effort_timestamp_time));
      // Account for timestamp quantization without tolerating a whole skipped frame.
      const tolerance = Math.max(.000002, Math.min((rational(video.time_base) || 0) * 1.1, .25 / spec.fps));
      let maxDeviation = 0, badSteps = 0;
      for (let i = 1; i < times.length; i++) {
        const delta = times[i] - times[i - 1];
        if (!Number.isFinite(delta) || delta <= 0) { badSteps++; continue; }
        const error = Math.abs(delta - 1 / spec.fps);
        maxDeviation = Math.max(maxDeviation, error);
        if (error > tolerance) badSteps++;
      }
      const ok = times.length === frames && times.length > 0 && times.every(Number.isFinite) && badSteps === 0;
      report.timestamps = {status: ok ? 'PASS' : 'FAIL', count: times.length, first: times[0], last: times.at(-1),
        maxStepDeviation: maxDeviation, tolerance, badSteps};
      if (!ok) report.errors.push('CFR timestamp mismatch');
    }
    const after = await sha256(input);
    report.inputHashAfter = after;
    if (before !== after) report.errors.push('video changed during inspection');
  } catch (e) {
    report.errors.push(e.message);
  }
  report.technicalVerified = report.errors.length === 0;
  await fs.mkdir(path.dirname(output), {recursive: true});
  await fs.writeFile(output, JSON.stringify(report, null, 2), {flag: 'wx'});
  console.log(JSON.stringify({report: output, technicalVerified: report.technicalVerified,
    actual: report.actual, timestamps: report.timestamps.status, errors: report.errors}));
  if (!report.technicalVerified) process.exitCode = 1;
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
