import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const usage = 'node inspect-video.mjs --input <local.mp4> --output <new-qa-directory> [--config <runtime.json>] [--times "0,1.2"] [--boundaries "2,4"] [--expect-width 1920] [--expect-height 1080] [--expect-fps 30] [--expect-duration 6] [--skip-loudness]';
const valuedOptions = new Set(['--input', '--output', '--config', '--times', '--boundaries', '--expect-width', '--expect-height', '--expect-fps', '--expect-duration']);
const maxSamples = 64;

function finite(value, label, minimum = 0, integer = false) {
  if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Number(value))) throw new Error(`${label} must be a finite number.`);
  const number = Number(value);
  if (number < minimum || (integer && !Number.isInteger(number))) throw new Error(`${label} must be ${integer ? 'an integer' : 'a number'} >= ${minimum}.`);
  return number;
}
function localPath(value, label) {
  if (!value || value.includes('\0') || (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value))) throw new Error(`${label} must be a local filesystem path, not a URL.`);
  return path.resolve(value);
}
function timestamps(value, label) {
  if (value === undefined) return [];
  const values = value.split(',').map(item => finite(item, label));
  if (values.length > maxSamples) throw new Error(`${label} has more than ${maxSamples} entries.`);
  return values;
}
function rate(value) {
  const [numerator, denominator = '1'] = String(value ?? '').split('/');
  const result = Number(numerator) / Number(denominator);
  return Number.isFinite(result) && result > 0 ? result : null;
}
function numberOrNull(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}
async function hashFile(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
async function newDirectory(directory) {
  try { await lstat(directory); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(path.dirname(directory), { recursive: true });
    await mkdir(directory);
    return;
  }
  throw new Error(`Output already exists; choose a new QA directory: ${directory}`);
}
function parseLoudness(stderr) {
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  const integrated = summary.match(/\bI:\s*(-?inf|[-+\d.]+)\s+LUFS/i)?.[1];
  const peak = summary.match(/True peak:\s*Peak:\s*(-?inf|[-+\d.]+)\s+dBFS/i)?.[1];
  if (integrated === undefined || peak === undefined) throw new Error('FFmpeg ebur128 did not return integrated loudness and true peak.');
  return {
    integratedLufs: numberOrNull(integrated),
    truePeakDbtp: numberOrNull(peak),
    rawIntegrated: integrated,
    rawTruePeak: peak,
    finite: Number.isFinite(Number(integrated)) && Number.isFinite(Number(peak)),
    method: 'FFmpeg ebur128=peak=true; first audio stream; no processing or target approval',
  };
}

async function main() {
  if (process.argv.length === 3 && process.argv[2] === '--help') { console.log(usage); return; }
  const options = new Map();
  for (let i = 2; i < process.argv.length; i++) {
    const name = process.argv[i];
    if (options.has(name)) throw new Error(`Duplicate option: ${name}`);
    if (name === '--skip-loudness') { options.set(name, true); continue; }
    if (!valuedOptions.has(name) || process.argv[i + 1] === undefined || process.argv[i + 1].startsWith('--')) throw new Error(usage);
    options.set(name, process.argv[++i]);
  }
  const input = localPath(options.get('--input'), '--input');
  const output = localPath(options.get('--output'), '--output');
  if (path.extname(input).toLowerCase() !== '.mp4') throw new Error('--input must be a local .mp4 file.');
  if (!(await stat(input)).isFile()) throw new Error('--input must be a regular file.');
  const requestedTimes = timestamps(options.get('--times'), '--times');
  const boundaries = timestamps(options.get('--boundaries'), '--boundaries');
  const expected = {};
  for (const key of ['width', 'height', 'fps', 'duration']) {
    if (options.has(`--expect-${key}`)) expected[key] = finite(options.get(`--expect-${key}`), `--expect-${key}`, key === 'width' || key === 'height' ? 1 : Number.MIN_VALUE, key === 'width' || key === 'height');
  }
  const configPath = options.has('--config') ? localPath(options.get('--config'), '--config') : null;
  const config = configPath ? JSON.parse(await readFile(configPath, 'utf8')) : {};
  const ffprobe = config.tools?.ffprobeCommand ?? 'ffprobe';
  const ffmpeg = config.tools?.ffmpegCommand ?? 'ffmpeg';
  for (const [label, executable] of Object.entries({ ffprobe, ffmpeg })) {
    if (typeof executable !== 'string' || !executable.trim() || executable.includes('\0')) throw new Error(`Invalid ${label} executable in configuration.`);
  }
  await newDirectory(output);
  await mkdir(path.join(output, 'frames'));
  await mkdir(path.join(output, 'logs'));
  const report = {
    schemaVersion: 1,
    kind: 'video-file-inspection',
    createdAt: new Date().toISOString(),
    input, output, configPath,
    status: 'TECHNICAL_CHECKS_RUNNING',
    inputSha256: await hashFile(input),
    expectations: expected,
    checks: [], commands: [], samples: [],
    review: {
      framesViewed: false,
      subjectiveVisualReviewed: false,
      subjectiveAudioReviewed: false,
      factualContentReviewed: false,
      userApproved: false,
      coreAcceptanceStateUpdated: false,
      publicationStateUpdated: false,
      scope: 'Technical evidence and decoded final-file frames only. View frames and listen to the final MP4 separately; use the existing core QA/acceptance workflow.',
    },
  };
  async function run(label, command, args, requireSuccess = true) {
    const index = String(report.commands.length + 1).padStart(2, '0');
    const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, shell: false, maxBuffer: 64 * 1024 * 1024 });
    const record = {
      label, command, args,
      exitCode: result.status,
      signal: result.signal,
      error: result.error?.message ?? null,
      stdout: path.join('logs', `${index}-${label}.stdout.txt`),
      stderr: path.join('logs', `${index}-${label}.stderr.txt`),
    };
    report.commands.push(record);
    await writeFile(path.join(output, record.stdout), result.stdout ?? '', { flag: 'wx' });
    await writeFile(path.join(output, record.stderr), result.stderr ?? '', { flag: 'wx' });
    const ok = !result.error && result.status === 0;
    if (!ok && requireSuccess) throw new Error(`${label} failed: ${result.error?.message ?? result.stderr?.slice(-2000) ?? result.signal ?? result.status}`);
    return { ...result, ok };
  }
  function check(name, ok, details) { report.checks.push({ name, ok, ...details }); }
  try {
    const probe = JSON.parse((await run('probe', ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', input])).stdout);
    await writeFile(path.join(output, 'probe.json'), `${JSON.stringify(probe, null, 2)}\n`, { flag: 'wx' });
    const video = probe.streams?.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
    const audio = probe.streams?.filter(stream => stream.codec_type === 'audio') ?? [];
    if (!video || !Number.isInteger(video.index)) throw new Error('No primary video stream with an established stream index.');
    const fps = rate(video.avg_frame_rate) ?? rate(video.r_frame_rate);
    if (!fps || !Number.isInteger(video.width) || video.width <= 0 || !Number.isInteger(video.height) || video.height <= 0) throw new Error('Cannot establish finite positive frame rate and dimensions.');
    const videoStart = numberOrNull(video.start_time) ?? 0;
    const declaredDuration = (numberOrNull(video.duration) ?? ((numberOrNull(video.duration_ts) ?? 0) * (rate(video.time_base) ?? 0))) || null;
    const formatDuration = numberOrNull(probe.format?.duration);
    const seekDurationHint = declaredDuration ?? formatDuration;
    if (!(seekDurationHint > 0)) throw new Error('Cannot establish a finite positive video-tail seek hint.');
    // The container duration is only a seek hint. The last actual decoded video
    // PTS below determines final-frame sampling even when audio overhangs.
    const tailStart = Math.max(0, videoStart + seekDurationHint - 3);
    const tail = JSON.parse((await run('video-tail', ffprobe, ['-v', 'error', '-select_streams', String(video.index), '-read_intervals', `${tailStart}%`, '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time,duration_time,pkt_duration_time', '-of', 'json', input])).stdout);
    const frames = (tail.frames ?? []).map(frame => ({
      pts: numberOrNull(frame.best_effort_timestamp_time),
      duration: numberOrNull(frame.duration_time) ?? numberOrNull(frame.pkt_duration_time),
    })).filter(frame => frame.pts !== null).sort((a, b) => a.pts - b.pts);
    if (!frames.length) throw new Error('No decoded tail frames; cannot establish the actual last video frame.');
    const last = frames.at(-1);
    const lastFrameTime = last.pts - videoStart;
    const lastFrameDuration = last.duration > 0 ? last.duration : 1 / fps;
    const duration = lastFrameTime + lastFrameDuration;
    if (!Number.isFinite(lastFrameTime) || lastFrameTime < 0 || !Number.isFinite(duration) || duration <= 0) throw new Error('Decoded video-tail timing is invalid.');
    report.media = {
      video: { index: video.index, codec: video.codec_name, width: video.width, height: video.height, fps, startTime: videoStart, declaredDuration, duration, durationMethod: 'last decoded video PTS minus video start plus final-frame duration', lastFrameTime, lastFrameAbsolutePts: last.pts, lastFrameDuration, lastFrameDurationEstimated: !(last.duration > 0) },
      audio: audio.map(stream => ({ index: stream.index, codec: stream.codec_name, sampleRate: numberOrNull(stream.sample_rate), channels: stream.channels, startTime: numberOrNull(stream.start_time), duration: numberOrNull(stream.duration) })),
      formatDuration,
    };
    check('video-timeline', true, { duration, lastFrameTime, formatDuration, declaredDuration });
    for (const key of Object.keys(expected)) {
      const actual = key === 'duration' ? duration : key === 'fps' ? fps : video[key];
      const tolerance = key === 'duration' ? 1 / fps + 0.001 : key === 'fps' ? 0.00001 : 0;
      check(`expected-${key}`, Math.abs(actual - expected[key]) <= tolerance, { expected: expected[key], actual, tolerance });
    }
    for (const [label, values] of [['--times', requestedTimes], ['--boundaries', boundaries]]) {
      if (values.some(time => time > duration + 0.000001)) throw new Error(`${label} contains a timestamp beyond the actual video duration (${duration}s).`);
    }
    const samples = new Map();
    function addSample(requested, reason) {
      const time = Math.max(0, Math.min(lastFrameTime, requested));
      const key = time.toFixed(9);
      if (!samples.has(key)) samples.set(key, { requestedTime: time, requests: [] });
      samples.get(key).requests.push({ reason, requestedTime: requested, clamped: Math.abs(time - requested) > 0.000000001 });
    }
    addSample(0, 'first-frame');
    addSample(lastFrameTime, 'last-decoded-video-frame');
    for (const time of requestedTimes) addSample(time, 'custom');
    for (const boundary of boundaries) {
      addSample(boundary - 1 / fps, `boundary-${boundary}-minus-one-frame`);
      addSample(boundary, `boundary-${boundary}`);
      addSample(boundary + 1 / fps, `boundary-${boundary}-plus-one-frame`);
    }
    if (samples.size > maxSamples) throw new Error(`The combined deduplicated sample plan exceeds ${maxSamples} frames.`);
    report.coverage = {
      wholeFileDecoded: false,
      requestedTimes, boundaries,
      samplingClock: 'Seconds relative to the primary video stream start; selection returns the next decoded frame at or after the requested time.',
      samplingLimit: maxSamples,
      sampledFrameCount: samples.size,
      vfrNotice: 'Boundary offsets use the reported average frame period. Inspect actual extracted PTS; this is not a frame-accurate edit decision list.',
      notCovered: ['Unselected video streams visually', 'Unselected audio streams subjectively', 'Subtitle/data streams', 'Subjective image quality or listening', 'Content facts or user acceptance'],
    };
    const decodedStreams = (probe.streams ?? []).filter(stream => ['video', 'audio'].includes(stream.codec_type));
    const decodeArgs = ['-hide_banner', '-nostdin', '-v', 'error', '-xerror', '-err_detect', 'explode', '-i', input];
    for (const stream of decodedStreams) decodeArgs.push('-map', `0:${stream.index}`);
    decodeArgs.push('-f', 'null', '-');
    const decode = await run('full-decode', ffmpeg, decodeArgs, false);
    report.coverage.wholeFileDecoded = decode.ok;
    report.coverage.decodedStreamIndices = decodedStreams.map(stream => stream.index);
    check('full-video-audio-decode', decode.ok, { streamIndices: report.coverage.decodedStreamIndices });
    let sampleIndex = 0;
    for (const sample of [...samples.values()].sort((a, b) => a.requestedTime - b.requestedTime)) {
      const index = String(++sampleIndex).padStart(3, '0');
      const file = path.join('frames', `${index}-${sample.requestedTime.toFixed(6)}s.png`);
      const threshold = videoStart + sample.requestedTime - 0.000001;
      const extraction = await run(`sample-${index}`, ffmpeg, ['-hide_banner', '-nostdin', '-nostats', '-n', '-copyts', '-i', input, '-map', `0:${video.index}`, '-vf', `select=gte(t\\,${threshold}),showinfo`, '-frames:v', '1', '-fps_mode', 'passthrough', '-update', '1', path.join(output, file)], false);
      const observedPts = numberOrNull(extraction.stderr?.match(/pts_time:([-+\d.eE]+)/)?.[1]);
      const actualTime = observedPts === null ? null : observedPts - videoStart;
      let fileExists = false;
      try { fileExists = (await stat(path.join(output, file))).size > 0; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const ok = extraction.ok && fileExists && actualTime !== null;
      report.samples.push({ ...sample, file, extracted: ok, actualAbsolutePts: observedPts, actualTime, sha256: fileExists ? await hashFile(path.join(output, file)) : null });
      check(`decoded-frame-${index}`, ok, { requestedTime: sample.requestedTime, actualTime, file });
    }
    if (!audio.length) {
      report.loudness = { status: 'NOT_APPLICABLE_NO_AUDIO', note: 'A silent motion fixture can pass technical checks. Narration requirements must be checked against its brief.' };
    } else if (options.has('--skip-loudness')) {
      report.loudness = { status: 'NOT_MEASURED_EXPLICITLY_SKIPPED' };
    } else {
      const measurement = await run('audio-ebur128', ffmpeg, ['-hide_banner', '-nostdin', '-nostats', '-i', input, '-map', `0:${audio[0].index}`, '-vn', '-af', 'ebur128=peak=true:framelog=verbose', '-f', 'null', '-'], false);
      if (measurement.ok) {
        report.loudness = { status: 'MEASURED', streamIndex: audio[0].index, ...parseLoudness(measurement.stderr) };
      } else {
        report.loudness = { status: 'MEASUREMENT_FAILED', streamIndex: audio[0].index };
      }
      check('audio-loudness-measured', measurement.ok, { streamIndex: audio[0].index });
    }
    const finalHash = await hashFile(input);
    check('input-unchanged', finalHash === report.inputSha256, { originalSha256: report.inputSha256, finalSha256: finalHash });
    report.status = report.checks.every(item => item.ok) ? 'TECHNICAL_CHECKS_PASSED' : 'TECHNICAL_CHECKS_FAILED';
  } catch (error) {
    report.status = 'TECHNICAL_CHECKS_FAILED';
    report.error = error.message;
  }
  report.completedAt = new Date().toISOString();
  const reportFile = path.join(output, 'inspection.json');
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ status: report.status, report: reportFile, sampledFrameCount: report.samples.length, framesViewed: false, subjectiveAudioReviewed: false, error: report.error ?? null }, null, 2));
  if (report.status !== 'TECHNICAL_CHECKS_PASSED') process.exitCode = 1;
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
