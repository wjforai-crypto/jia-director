#!/usr/bin/env node
/** Local render-asset description -> new HyperFrames directory. No project state. */
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertVisibleText } from './visible-text-policy.mjs';

const EPSILON = 1e-7;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const DEFAULT_STYLE = {
  background: '#07111f', foreground: '#f6f8fa', muted: '#b6c7d8',
  accent: '#34d399', fontFamily: 'Microsoft YaHei', motion: 'fade',
};

function requireValue(ok, message) {
  if (!ok) throw new Error(message);
}
function object(value, label) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  return value;
}
function number(value, label, minimum = 0, maximum = Infinity) {
  requireValue(typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum,
    `${label} must be a finite number between ${minimum} and ${maximum}`);
  return value;
}
function text(value, label, fallback = '') {
  if (value === undefined) return fallback;
  requireValue(typeof value === 'string' && !value.includes('\0'), `${label} must be plain text without NUL`);
  return value.normalize('NFC');
}
function visibleText(value, label, fallback = '') {
  return assertVisibleText(text(value, label, fallback), label);
}
function array(value, label) {
  if (value === undefined) return [];
  requireValue(Array.isArray(value), `${label} must be an array`);
  return value;
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}
function cssString(value) {
  return `"${value.replace(/[\\"<>\r\n]/g, (character) => `\\${character.codePointAt(0).toString(16)} `)}"`;
}
function seconds(value) { return String(Number(value.toFixed(7))); }
async function hashFile(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
async function exists(filename) {
  try { await fs.lstat(filename); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function probe(filename, command) {
  const result = spawnSync(command, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filename],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  requireValue(!result.error && result.status === 0,
    `ffprobe failed for ${filename}: ${result.error?.message ?? result.stderr?.trim() ?? result.status}`);
  let payload;
  try { payload = JSON.parse(result.stdout); }
  catch { throw new Error(`ffprobe returned invalid JSON for ${filename}`); }
  const streams = payload.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  function duration(stream) {
    const own = Number(stream?.duration);
    const total = Number(payload.format?.duration);
    return Number.isFinite(own) && own > 0 ? own : total;
  }
  return {
    hasVideo: Boolean(video), hasAudio: Boolean(audio),
    videoDuration: duration(video), audioDuration: duration(audio),
    videoCodec: video?.codec_name ?? null, audioCodec: audio?.codec_name ?? null,
    width: video?.width ?? null, height: video?.height ?? null,
  };
}

async function validateDescription(raw, inputPath, ffprobeCommand) {
  object(raw, 'description');
  const canvas = object(raw.canvas, 'canvas');
  const width = number(canvas.width, 'canvas.width', 320, 8192);
  const height = number(canvas.height, 'canvas.height', 240, 8192);
  const fps = number(canvas.fps ?? 30, 'canvas.fps', 1, 240);
  requireValue(Number.isInteger(width) && Number.isInteger(height), 'canvas width/height must be integers');
  const duration = number(canvas.duration, 'canvas.duration', Number.EPSILON, 3600);
  const title = text(raw.title, 'title', '本地视频合成');
  const style = { ...DEFAULT_STYLE, ...object(raw.style ?? {}, 'style') };
  for (const name of ['background', 'foreground', 'muted', 'accent']) {
    requireValue(typeof style[name] === 'string' && /^#[\da-f]{6}$/i.test(style[name]), `style.${name} must be #RRGGBB`);
  }
  style.fontFamily = text(style.fontFamily, 'style.fontFamily');
  requireValue(['fade', 'none'].includes(style.motion), 'style.motion must be fade or none');
  const ids = new Set(['composition-root']);
  const tracks = new Map();
  const sourceCache = new Map();

  function timed(item, label, defaultTrack) {
    object(item, label);
    requireValue(typeof item.id === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(item.id), `${label}.id must be an ASCII identifier`);
    requireValue(!ids.has(item.id), `duplicate id: ${item.id}`);
    ids.add(item.id);
    const start = number(item.start, `${label}.start`);
    const clipDuration = number(item.duration, `${label}.duration`, Number.EPSILON);
    requireValue(start + clipDuration <= duration + EPSILON, `${label} exceeds canvas.duration`);
    const track = number(item.track ?? defaultTrack, `${label}.track`, 0, 999);
    requireValue(Number.isInteger(track), `${label}.track must be an integer`);
    const entries = tracks.get(track) ?? [];
    entries.push({ id: item.id, start, end: start + clipDuration });
    tracks.set(track, entries);
    return { id: item.id, start, duration: clipDuration, track };
  }
  async function source(value, kind, label) {
    requireValue(typeof value === 'string' && value.trim() && !value.includes('\0'), `${label}.source must be a local file path`);
    requireValue(!/^[a-z][a-z\d+.-]*:/i.test(value) || /^[a-z]:[\\/]/i.test(value), `${label}.source cannot be a URL`);
    const filename = path.resolve(path.dirname(inputPath), value);
    let metadata;
    try { metadata = await fs.stat(filename); }
    catch (error) { throw new Error(`Missing/unreadable asset ${filename}: ${error.code}`); }
    requireValue(metadata.isFile(), `Asset must be a file: ${filename}`);
    if (!sourceCache.has(filename)) {
      const sha256 = await hashFile(filename);
      const extension = path.extname(filename).toLowerCase();
      sourceCache.set(filename, {
        originalPath: filename, realPath: await fs.realpath(filename), sha256,
        bytes: metadata.size, relativePath: `assets/${sha256}${extension}`, extension,
        uses: [], probe: null,
      });
    }
    const asset = sourceCache.get(filename);
    if (kind === 'image') {
      requireValue(IMAGE_EXTENSIONS.has(asset.extension), `${label}: supported images are PNG, JPEG and WebP`);
      const imageProbe = asset.probe ??= probe(filename, ffprobeCommand);
      requireValue(imageProbe.hasVideo && imageProbe.width > 0 && imageProbe.height > 0, `${label}: image cannot be decoded`);
    } else {
      asset.probe ??= probe(filename, ffprobeCommand);
      requireValue(kind === 'video' ? asset.probe.hasVideo : asset.probe.hasAudio, `${label}: asset has no ${kind} stream`);
    }
    asset.uses.push({ id: label, kind });
    return asset;
  }
  function trim(item, asset, kind, label) {
    const mediaStart = number(item.mediaStart ?? 0, `${label}.mediaStart`);
    const available = asset.probe[kind === 'video' ? 'videoDuration' : 'audioDuration'];
    requireValue(Number.isFinite(available) && available > 0, `${label}: media duration cannot be determined`);
    requireValue(mediaStart + item.duration <= available + EPSILON, `${label}: media trim exceeds source duration (${available}s)`);
    return mediaStart;
  }
  function volume(value, label) { return number(value ?? 1, `${label}.volume`, 0, 1); }
  const shots = [];
  for (const [index, item] of array(raw.shots, 'shots').entries()) {
    const label = `shots[${index}]`;
    const normalized = timed(item, label, 0);
    requireValue(['card', 'image', 'video'].includes(item.type), `${label}.type must be card, image or video`);
    Object.assign(normalized, { type: item.type, title: visibleText(item.title, `${label}.title`), text: visibleText(item.text, `${label}.text`) });
    if (item.type === 'card') {
      requireValue(normalized.title.trim() || normalized.text.trim(), `${label}: card needs title or text`);
    } else {
      normalized.asset = await source(item.source, item.type, item.id);
      normalized.fit = item.fit ?? 'contain';
      requireValue(['contain', 'cover'].includes(normalized.fit), `${label}.fit must be contain or cover`);
      if (item.type === 'video') {
        normalized.mediaStart = trim(item, normalized.asset, 'video', label);
        requireValue(item.sourceAudio === undefined || typeof item.sourceAudio === 'boolean', `${label}.sourceAudio must be boolean`);
        normalized.sourceAudio = item.sourceAudio ?? normalized.asset.probe.hasAudio;
        requireValue(!normalized.sourceAudio || normalized.asset.probe.hasAudio, `${label}: requested source audio is missing`);
        normalized.volume = normalized.sourceAudio ? volume(item.volume, label) : 0;
      }
    }
    shots.push(normalized);
  }
  requireValue(shots.length > 0 && shots.length <= 500, 'shots must contain 1-500 entries');
  const audio = [];
  for (const [index, item] of array(raw.audio, 'audio').entries()) {
    const label = `audio[${index}]`;
    const normalized = timed(item, label, 10);
    normalized.asset = await source(item.source, 'audio', item.id);
    normalized.mediaStart = trim(item, normalized.asset, 'audio', label);
    normalized.volume = volume(item.volume, label);
    audio.push(normalized);
  }
  const cues = array(raw.cues, 'cues').map((item, index) => {
    const label = `cues[${index}]`;
    const normalized = timed(item, label, item.type === 'subtitle' ? 20 : 21);
    requireValue(['subtitle', 'overlay'].includes(item.type), `${label}.type must be subtitle or overlay`);
    const cueText = visibleText(item.text, `${label}.text`);
    requireValue(cueText.trim(), `${label}.text cannot be empty`);
    const position = item.position ?? (item.type === 'subtitle' ? 'bottom' : 'top');
    requireValue(['top', 'bottom'].includes(position), `${label}.position must be top or bottom`);
    return { ...normalized, type: item.type, text: cueText, position };
  });
  for (const shot of shots.filter((item) => item.type !== 'card')) {
    requireValue(!ids.has(`${shot.id}-media`), `id conflicts with generated media element: ${shot.id}-media`);
    ids.add(`${shot.id}-media`);
  }
  for (const [track, entries] of tracks) {
    entries.sort((left, right) => left.start - right.start);
    for (let index = 1; index < entries.length; index++) {
      requireValue(entries[index].start >= entries[index - 1].end - EPSILON,
        `track ${track} overlaps: ${entries[index - 1].id} and ${entries[index].id}`);
    }
  }
  return { title, canvas: { width, height, fps, duration }, style, shots, audio, cues, assets: [...sourceCache.values()] };
}

function renderHtml(description) {
  const { title, canvas: { width, height, fps, duration }, style, shots, audio, cues } = description;
  const unit = Math.min(width, height);
  const padding = Math.round(unit * 0.065);
  const topReserve = cues.some((cue) => cue.position === 'top') ? Math.round(unit * 0.14) : padding;
  const bottomReserve = cues.some((cue) => cue.position === 'bottom') ? Math.round(unit * 0.19) : padding;
  const attributes = (clip) => `id="${clip.id}" data-start="${seconds(clip.start)}" data-duration="${seconds(clip.duration)}" data-track-index="${clip.track}"`;
  const media = (clip) => `src="${clip.asset.relativePath}" data-media-start="${seconds(clip.mediaStart ?? 0)}"`;
  const sceneMarkup = shots.map((shot, index) => {
    const heading = shot.title ? `<h1>${escapeHtml(shot.title)}</h1>` : '';
    const explanation = shot.text ? `<p class="explanation">${escapeHtml(shot.text)}</p>` : '';
    const animation = style.motion === 'fade' ? ` style="animation: scene-enter ${seconds(Math.min(0.3, shot.duration / 3))}s ease-out ${seconds(shot.start)}s 1 both paused"` : '';
    if (shot.type === 'card') {
      return `<section ${attributes(shot)} class="clip scene card-scene" style="z-index:${index * 2 + 1}"><div class="scene-content"${animation}>${heading}${explanation}</div></section>`;
    }
    const mediaTop = topReserve + (shot.title ? Math.round(unit * 0.16) : 0) + (shot.text ? Math.round(unit * 0.11) : 0);
    const mediaStyle = `left:${padding}px;top:${mediaTop}px;width:${width - padding * 2}px;height:${height - mediaTop - bottomReserve}px;object-fit:${shot.fit};z-index:${index * 2 + 2}`;
    const display = shot.type === 'image'
      ? `<img ${attributes({ ...shot, id: `${shot.id}-media`, track: 1000 + index })} ${media(shot)} class="clip media" style="${mediaStyle}" alt="${escapeHtml(shot.title)}" />`
      : `<video ${attributes({ ...shot, id: `${shot.id}-media`, track: 1000 + index })} ${media(shot)} class="clip media" style="${mediaStyle}" data-volume="${shot.volume}" ${shot.sourceAudio ? 'data-has-audio="true"' : 'muted'} preload="auto" playsinline></video>`;
    // Timed media must be a direct stage child: nested timed videos freeze in HF.
    return `<section ${attributes(shot)} class="clip scene media-scene" style="z-index:${index * 2 + 1}"><div class="scene-content">${heading}${explanation}</div></section>\n${display}`;
  }).join('\n');
  const audioMarkup = audio.map((clip) => `<audio ${attributes(clip)} ${media(clip)} data-volume="${clip.volume}" preload="auto"></audio>`).join('\n');
  const cueMarkup = cues.map((cue) => `<div ${attributes(cue)} class="clip cue cue-${cue.type} cue-${cue.position}"><span>${escapeHtml(cue.text)}</span></div>`).join('\n');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8" /><meta name="viewport" content="width=${width}, height=${height}" /><title>${escapeHtml(title)}</title>
<style>
@font-face{font-family:${cssString(style.fontFamily)};src:local(${cssString(style.fontFamily)});font-weight:400;font-display:block}
*{box-sizing:border-box}html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden}
body{font-family:${cssString(style.fontFamily)},sans-serif;color:${style.foreground};background:${style.background}}
#composition-root{width:${width}px;height:${height}px;position:relative;overflow:hidden;background:${style.background}}
.scene{position:absolute;inset:0;overflow:hidden;background:${style.background}}
.scene-content{width:100%;height:100%;padding:${topReserve}px ${padding}px ${bottomReserve}px;display:flex;flex-direction:column;gap:${Math.round(unit * 0.025)}px;overflow:hidden}
.card-scene .scene-content{justify-content:center;border-left:${Math.max(3, Math.round(unit * 0.01))}px solid ${style.accent}}
h1{margin:0;max-width:100%;font-size:${Math.round(unit * 0.095)}px;line-height:1.3;font-weight:700;overflow-wrap:anywhere;white-space:pre-wrap}
.explanation{margin:0;color:${style.muted};font-size:${Math.round(unit * 0.055)}px;line-height:1.5;overflow-wrap:anywhere;white-space:pre-wrap}
.media{position:absolute;display:block}
.media-scene h1{font-size:${Math.round(unit * 0.08)}px}.media-scene .explanation{font-size:${Math.round(unit * 0.045)}px}
.cue{position:absolute;left:${padding}px;right:${padding}px;z-index:10000;display:flex;align-items:center;justify-content:center;pointer-events:none}
.cue-top{top:${Math.round(unit * 0.035)}px}.cue-bottom{bottom:${Math.round(unit * 0.035)}px}
.cue span{max-width:100%;padding:${Math.round(unit * 0.015)}px ${Math.round(unit * 0.025)}px;background:${style.background};border:${Math.max(1, Math.round(unit * 0.004))}px solid ${style.accent};font-size:${Math.round(unit * 0.05)}px;line-height:1.35;white-space:pre-wrap;overflow-wrap:anywhere;text-align:center}
.cue-overlay span{color:${style.accent};font-weight:700}
@keyframes scene-enter{from{opacity:0;transform:translateY(${Math.round(unit * 0.025)}px)}to{opacity:1;transform:translateY(0)}}
</style></head><body><div id="composition-root" data-composition-id="jia-local-composition" data-no-timeline data-start="0" data-duration="${seconds(duration)}" data-width="${width}" data-height="${height}" data-fps="${fps}">
${sceneMarkup}
${audioMarkup}
${cueMarkup}
</div></body></html>\n`;
}

/** Only remove new directories this invocation created, within their explicit parent. */
async function removeOwnedDirectory(target, parent, expectedName) {
  const absolute = path.resolve(target);
  requireValue(path.dirname(absolute) === path.resolve(parent) && path.basename(absolute) === expectedName,
    'Refusing cleanup outside the explicitly created directory');
  await fs.rm(absolute, { recursive: true, force: true });
}

export async function buildComposition({ inputPath, outputDir, ffprobeCommand = 'ffprobe' }) {
  const input = path.resolve(inputPath);
  const output = path.resolve(outputDir);
  requireValue(!(await exists(output)), `Output directory already exists; choose a new version: ${output}`);
  const inputBytes = await fs.readFile(input);
  let raw;
  try { raw = JSON.parse(inputBytes.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error('Input must contain valid JSON'); }
  const description = await validateDescription(raw, input, ffprobeCommand);
  const parent = path.dirname(output);
  const stageName = `.${path.basename(output)}.build-${randomUUID()}`;
  const stage = path.join(parent, stageName);
  let stageCreated = false;
  let outputCreated = false;
  try {
    await fs.mkdir(parent, { recursive: true });
    await fs.mkdir(stage);
    stageCreated = true;
    await fs.mkdir(path.join(stage, 'assets'));
    for (const asset of description.assets) {
      const destination = path.join(stage, asset.relativePath);
      if (!(await exists(destination))) await fs.copyFile(asset.originalPath, destination);
      requireValue((await hashFile(destination)) === asset.sha256, `Asset changed while copying: ${asset.originalPath}`);
    }
    const manifest = {
      kind: 'local-render-assets', formatVersion: 1, hyperframesTestedVersion: '0.7.103',
      inputPath: input, inputSha256: createHash('sha256').update(inputBytes).digest('hex'),
      canvas: description.canvas, style: description.style,
      assets: description.assets.map(({ extension, ...asset }) => asset),
      timeline: [...description.shots, ...description.audio, ...description.cues].map(({ asset, ...clip }) => ({
        ...clip, ...(asset ? { assetPath: asset.relativePath } : {}),
      })),
      boundaries: { projectStateContract: false, approvalsRecorded: false, forcedAlignmentPerformed: false,
        formalVoiceAccepted: false, downloadsOrPaidCallsPerformed: false },
    };
    await fs.writeFile(path.join(stage, 'index.html'), renderHtml(description), { flag: 'wx' });
    await fs.writeFile(path.join(stage, 'asset-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    await fs.writeFile(path.join(stage, 'render-description.json'), `${JSON.stringify(raw, null, 2)}\n`, { flag: 'wx' });
    await fs.writeFile(path.join(stage, 'README.md'), '# 本地渲染资产合成\n\nindex.html 是可编辑合成源码，asset-manifest.json 保存原素材路径与 SHA256。\n此目录不记录核心状态或审批，不代表用户成片验收；渲染前运行 HyperFrames lint 与 inspect。\n', { flag: 'wx' });
    // mkdir is the exclusive reservation: even an existing empty output is refused.
    await fs.mkdir(output);
    outputCreated = true;
    for (const entry of await fs.readdir(stage)) await fs.rename(path.join(stage, entry), path.join(output, entry));
    await fs.rmdir(stage);
    stageCreated = false;
    return { outputDir: output, indexPath: path.join(output, 'index.html'), manifestPath: path.join(output, 'asset-manifest.json'),
      shots: description.shots.length, audio: description.audio.length, cues: description.cues.length };
  } catch (error) {
    if (outputCreated) await removeOwnedDirectory(output, parent, path.basename(output));
    throw error;
  } finally {
    if (stageCreated) await removeOwnedDirectory(stage, parent, stageName);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('node build-composition.mjs --input <description.json> --output <NEW-directory> [--ffprobe <executable>]');
    return;
  }
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    requireValue(['--input', '--output', '--ffprobe'].includes(args[index]) && args[index + 1], `Unknown/missing argument: ${args[index]}`);
    requireValue(!Object.hasOwn(options, args[index]), `Duplicate argument: ${args[index]}`);
    options[args[index]] = args[index + 1];
  }
  requireValue(options['--input'] && options['--output'], '--input and --output are required');
  console.log(JSON.stringify({ ok: true, ...await buildComposition({ inputPath: options['--input'], outputDir: options['--output'],
    ffprobeCommand: options['--ffprobe'] ?? 'ffprobe' }) }, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`Composition build failed: ${error.message}`); process.exitCode = 1; });
}
