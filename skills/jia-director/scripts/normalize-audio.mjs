import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr?.slice(-4000) ?? 'Media command failed.');
  return result;
}
async function hashFile(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
async function absent(file) {
  try { await stat(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error(`Output already exists; use a new version: ${file}`);
}
function measurements(stderr) {
  const match = stderr.match(/\{\s*"input_i"[\s\S]*?\}/);
  if (!match) throw new Error('FFmpeg did not return loudnorm measurements.');
  const values = JSON.parse(match[0]);
  for (const key of ['input_i','input_tp','input_lra','input_thresh','target_offset']) {
    if (!Number.isFinite(Number(values[key]))) throw new Error(`Non-finite loudness measurement (${key}); inspect the source audio instead of normalizing silence.`);
  }
  return values;
}
async function main() {
  const options = new Map();
  for (let i = 2; i < process.argv.length; i += 2) {
    if (!['--input','--output','--config'].includes(process.argv[i]) || !process.argv[i + 1]) throw new Error('Use --input <mp4> --output <new.mp4> [--config <runtime.json>].');
    if (options.has(process.argv[i])) throw new Error(`Duplicate option: ${process.argv[i]}`);
    options.set(process.argv[i], process.argv[i + 1]);
  }
  if (!options.get('--input') || !options.get('--output')) throw new Error('--input and --output are required.');
  const input = path.resolve(options.get('--input'));
  const output = path.resolve(options.get('--output'));
  if (input.toLowerCase() === output.toLowerCase() || path.extname(output).toLowerCase() !== '.mp4') throw new Error('Use a different new .mp4 output path.');
  const receipt = `${output}.loudness.json`;
  await absent(output);
  await absent(receipt);
  if (!(await stat(input)).isFile()) throw new Error('Input must be a media file.');
  const config = options.get('--config') ? JSON.parse(await readFile(options.get('--config'), 'utf8')) : {};
  const ffmpeg = config.tools?.ffmpegCommand ?? 'ffmpeg';
  const ffprobe = config.tools?.ffprobeCommand ?? 'ffprobe';
  const probe = JSON.parse(run(ffprobe, ['-v','error','-show_streams','-show_format','-of','json',input]).stdout);
  const sourceVideo = probe.streams?.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const sourceAudio = probe.streams?.find(s => s.codec_type === 'audio');
  if (!sourceVideo || !sourceAudio) throw new Error('Normalization requires video and an existing audio track; it does not invent narration.');
  if (!Number.isInteger(sourceVideo.index) || !Number.isInteger(sourceAudio.index)) throw new Error('Cannot establish selected video/audio stream indices.');
  const duration = Number(sourceVideo.duration ?? probe.format?.duration);
  const sourceAudioDuration = Number(sourceAudio.duration ?? probe.format?.duration);
  const [rateNumerator, rateDenominator = '1'] = String(sourceVideo.avg_frame_rate ?? sourceVideo.r_frame_rate).split('/');
  const frameRate = Number(rateNumerator) / Number(rateDenominator);
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(frameRate) || frameRate <= 0 || !Number.isFinite(sourceAudioDuration)) throw new Error('Cannot establish the source video timeline duration and frame rate.');
  if (Math.abs(sourceAudioDuration - duration) > 1 / frameRate + 0.001) throw new Error('Source audio/video durations already differ by more than one frame; inspect alignment before loudness processing.');
  const sourceHash = await hashFile(input);
  const first = run(ffmpeg, ['-hide_banner','-nostats','-i',input,'-map','0:a:0','-af','loudnorm=I=-16:TP=-1:LRA=11:print_format=json','-f','null',process.platform === 'win32' ? 'NUL' : '/dev/null']);
  const measured = measurements(first.stderr);
  let gainDb = -16 - Number(measured.input_i);
  const limiterCeilingDb = -2;
  const limiterLinear = 10 ** (limiterCeilingDb / 20);
  // Measure loudness without applying loudnorm's dynamic output: it shifted
  // late speech events in the real forward test. Static gain + a compensated
  // lookahead limiter preserves event positions; oversampling controls peaks.
  const filterForGain = value => `volume=${value}dB,aresample=192000,alimiter=limit=${limiterLinear}:attack=5:release=50:level=false:latency=true,aresample=48000,apad=whole_dur=${duration},atrim=duration=${duration}`;
  await mkdir(path.dirname(output), { recursive: true });
  const temporary = path.join(path.dirname(output), `.${path.basename(output, '.mp4')}.${randomUUID()}.mp4`);
  let temporaryCreated = false;
  try {
    temporaryCreated = true;
    const passes = [];
    let finalMeasurements;
    for (let attempt = 0; attempt < 2; attempt++) {
      run(ffmpeg, ['-hide_banner','-nostats','-n','-i',input,'-map',`0:${sourceVideo.index}`,'-map',`0:${sourceAudio.index}`,'-map_metadata','0','-c:v','copy','-c:a','aac','-b:a','192k','-ar','48000','-af',filterForGain(gainDb),'-t',String(duration),'-movflags','+faststart',temporary]);
      finalMeasurements = measurements(run(ffmpeg, ['-hide_banner','-nostats','-i',temporary,'-map','0:a:0','-af','loudnorm=I=-16:TP=-1:LRA=11:print_format=json','-f','null',process.platform === 'win32' ? 'NUL' : '/dev/null']).stderr);
      const integrated = Number(finalMeasurements.input_i);
      const truePeak = Number(finalMeasurements.input_tp);
      passes.push({ gainDb, integratedLufs: integrated, truePeakDb: truePeak });
      if (integrated >= -17 && integrated <= -15 && truePeak <= -1) break;
      const correction = -16 - integrated;
      if (attempt === 1 || truePeak > -1 || Math.abs(correction) > 3) throw new Error(`Audio needs manual mixing after gain/limiting (LUFS ${integrated}, dBTP ${truePeak}); no output version was committed.`);
      // At most one measured correction. Only this invocation's UUID file
      // is removed; original media and existing outputs are never changed.
      await unlink(temporary);
      gainDb += correction;
    }
    if (await hashFile(input) !== sourceHash) throw new Error('Input changed while normalizing; no output version was committed.');
    const processed = JSON.parse(run(ffprobe, ['-v','error','-show_streams','-show_format','-of','json',temporary]).stdout);
    const processedVideo = processed.streams?.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
    const processedAudio = processed.streams?.find(s => s.codec_type === 'audio');
    const outputVideoDuration = Number(processedVideo?.duration ?? processed.format?.duration);
    const outputAudioDuration = Number(processedAudio?.duration ?? processed.format?.duration);
    if (!Number.isFinite(outputVideoDuration) || !Number.isFinite(outputAudioDuration) || Math.abs(outputVideoDuration - duration) > 1 / frameRate + 0.001 || Math.abs(outputAudioDuration - outputVideoDuration) > 1 / frameRate + 0.001) throw new Error('Normalized output did not preserve the source timeline; no output version was committed.');
    await copyFile(temporary, output, constants.COPYFILE_EXCL);
    const outputHash = await hashFile(output);
    const result = { input, sourceSha256: sourceHash, output, outputSha256: outputHash, sourceMeasurements: measured, outputMeasurements: finalMeasurements, method: { kind: 'measured-static-gain-and-latency-compensated-oversampled-limiter', gainDb, limiterCeilingDb, passes }, timeline: { sourceVideoDuration: duration, sourceAudioDuration, outputVideoDuration, outputAudioDuration, frameRate }, target: { integratedLufs: -16, truePeakDb: -1, audioSampleRate: 48000 }, videoReencoded: false, finalQaRequired: true, subjectiveAudioReviewed: false };
    await writeFile(receipt, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
    process.stdout.write(`${JSON.stringify({ output, receipt, outputSha256: outputHash, finalQaRequired: true })}\n`);
  } finally {
    if (temporaryCreated) await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
