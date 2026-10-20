#!/usr/bin/env node
/** Build a new, offline HyperFrames motion composition. No core project state. */
import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertVisibleText } from './visible-text-policy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMPONENTS = path.resolve(HERE, '../assets/motion-components');
const RECIPES = new Set(['title-reveal', 'photo-pan', 'flow-steps', 'comparison', 'checklist', 'metric-bars', 'quote-focus', 'lower-third']);
const EPS = 1e-7;
function check(ok, message) { if (!ok) throw new Error(message); }
function object(value, label) { check(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`); return value; }
function keys(value, allowed, label) { for (const key of Object.keys(value)) check(allowed.includes(key), `${label}: unknown field ${key}`); }
function number(value, label, min, max) { check(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max, `${label} must be finite and between ${min} and ${max}`); return value; }
function string(value, label, max = 120, required = true) {
  if (value === undefined && !required) return '';
  check(typeof value === 'string' && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value), `${label} must be plain text`);
  const result = value.normalize('NFC').trim();
  check(!required || result.length > 0, `${label} must not be empty`);
  check(Array.from(result).length <= max, `${label} exceeds ${max} characters`);
  return result;
}
function visibleString(value, label, max = 120, required = true) {
  return assertVisibleText(string(value, label, max, required), label);
}
function array(value, label, min, max) { check(Array.isArray(value) && value.length >= min && value.length <= max, `${label} needs ${min}..${max} items`); return value; }
function html(value) { return String(value).replace(/[&<>"']/g, x => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[x]); }
function jsonForHtml(value) { return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, x => `\\u${x.charCodeAt(0).toString(16).padStart(4, '0')}`); }
async function exists(filename) { try { await fs.lstat(filename); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
async function sha256(filename) { const hash = createHash('sha256'); for await (const part of createReadStream(filename)) hash.update(part); return hash.digest('hex'); }
function localPath(value, base, label) {
  check(typeof value === 'string' && value.trim() && !value.includes('\0'), `${label} needs a local path`);
  check(!/^[a-z][a-z\d+.-]*:/i.test(value) || /^[a-z]:[\\/]/i.test(value), `${label} cannot be a URL`);
  return path.resolve(base, value);
}
async function localFile(filename, label) { const stat = await fs.stat(filename).catch(e => { throw new Error(`${label}: unreadable file ${filename} (${e.code})`); }); check(stat.isFile() && stat.size > 0, `${label} must be a nonempty file`); return stat; }

function cli(argv) {
  const result = {};
  const names = new Set(['--input', '--output', '--gsap', '--font']);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--help') { check(argv.length === 1, '--help cannot be combined with other flags'); return { help: true }; }
    check(names.has(key), `Unknown flag: ${key}`);
    check(!Object.hasOwn(result, key.slice(2)), `Duplicate flag: ${key}`);
    check(typeof argv[i + 1] === 'string' && !argv[i + 1].startsWith('--'), `Missing value for ${key}`);
    result[key.slice(2)] = argv[++i];
  }
  for (const key of ['input', 'output', 'gsap']) check(result[key], `--${key} is required`);
  return result;
}

async function validate(raw, inputPath, gsapPath, fontPath) {
  object(raw, 'input'); keys(raw, ['schemaVersion', 'compositionId', 'title', 'canvas', 'style', 'shots', 'captions'], 'input');
  check(raw.schemaVersion === 1, 'schemaVersion must be 1');
  const compositionId = string(raw.compositionId, 'compositionId', 80);
  check(/^[A-Za-z][A-Za-z0-9_-]*$/.test(compositionId), 'compositionId must be an ASCII identifier');
  const canvas = object(raw.canvas, 'canvas'); keys(canvas, ['width', 'height', 'fps', 'duration', 'transparent', 'captionReserve'], 'canvas');
  const width = number(canvas.width, 'canvas.width', 320, 8192), height = number(canvas.height, 'canvas.height', 240, 8192);
  check(Number.isInteger(width) && Number.isInteger(height), 'canvas width and height must be integers');
  const fps = number(canvas.fps ?? 30, 'canvas.fps', 1, 120), duration = number(canvas.duration, 'canvas.duration', .5, 3600);
  const transparent = canvas.transparent ?? false; check(typeof transparent === 'boolean', 'canvas.transparent must be boolean');
  const captionReserve = number(canvas.captionReserve ?? .14, 'canvas.captionReserve', .1, .3);
  const style = { background: '#F4EFE5', foreground: '#173B36', muted: '#526963', accent: '#D05A32', ...object(raw.style ?? {}, 'style') };
  keys(style, ['background', 'foreground', 'muted', 'accent'], 'style');
  for (const [key, value] of Object.entries(style)) check(/^#[\da-f]{6}$/i.test(value), `style.${key} must be #RRGGBB`);
  const title = string(raw.title, 'title', 120, false) || '可复用动效';
  check(compositionId !== 'motion-description', 'compositionId conflicts with the internal description element');
  const ids = new Set([compositionId, 'motion-description']);
  const assets = new Map();
  async function asset(filename, kind, use, outputName) {
    const stat = await localFile(filename, kind);
    if (!assets.has(filename)) {
      const hash = await sha256(filename), ext = path.extname(filename).toLowerCase();
      assets.set(filename, { originalPath: filename, realPath: await fs.realpath(filename), sha256: hash, bytes: stat.size, kind, relativePath: outputName || `assets/${hash}${ext}`, uses: [] });
    }
    const entry = assets.get(filename); check(entry.kind === kind, `Asset used as conflicting kinds: ${filename}`); entry.uses.push(use); return entry;
  }
  check(path.extname(gsapPath).toLowerCase() === '.js', '--gsap must point to a local JavaScript file');
  await asset(gsapPath, 'gsap-runtime', 'animation-engine', 'assets/gsap.min.js');
  const gsapText = await fs.readFile(gsapPath, 'utf8');
  const gsapVersion = /GSAP\s+(\d+\.\d+\.\d+)/i.exec(gsapText)?.[1] ?? null;
  check(gsapVersion, '--gsap file does not contain a recognizable GSAP version banner');
  let font = null;
  if (fontPath) {
    const ext = path.extname(fontPath).toLowerCase(); check(['.ttf', '.otf', '.ttc', '.woff', '.woff2'].includes(ext), 'Supported font extensions: TTF, OTF, TTC, WOFF, WOFF2');
    font = await asset(fontPath, 'font', 'local-typeface');
  }
  function timed(item, label) {
    const id = string(item.id, `${label}.id`, 80); check(/^[A-Za-z][A-Za-z0-9_-]*$/.test(id), `${label}.id must be an ASCII identifier`); check(!ids.has(id), `Duplicate id: ${id}`); ids.add(id);
    const start = number(item.start, `${label}.start`, 0, duration), itemDuration = number(item.duration, `${label}.duration`, .5, duration);
    check(start + itemDuration <= duration + EPS, `${label} exceeds canvas.duration`);
    return { id, start, duration: itemDuration };
  }
  const shots = [];
  for (const [i, shot] of array(raw.shots, 'shots', 1, 200).entries()) {
    const label = `shots[${i}]`; object(shot, label); keys(shot, ['id', 'start', 'duration', 'recipe', 'params', 'source'], label);
    const normal = timed(shot, label); check(RECIPES.has(shot.recipe), `${label}.recipe is unsupported`); normal.recipe = shot.recipe;
    check(!transparent || normal.recipe === 'lower-third', 'Transparent canvas only supports lower-third overlays');
    const p = object(shot.params, `${label}.params`), pl = `${label}.params`;
    normal.source = visibleString(shot.source, `${label}.source`, 220, ['comparison', 'metric-bars'].includes(normal.recipe));
    const optional = (key, max) => visibleString(p[key], `${pl}.${key}`, max, false);
    switch (normal.recipe) {
      case 'title-reveal': keys(p, ['eyebrow', 'title', 'subtitle'], pl); normal.params = { eyebrow: optional('eyebrow', 32), title: visibleString(p.title, `${pl}.title`, 52), subtitle: optional('subtitle', 100) }; break;
      case 'photo-pan': {
        keys(p, ['image', 'title', 'subtitle', 'pan', 'positionX', 'positionY', 'zoomStart', 'zoomEnd'], pl);
        const filename = localPath(p.image, path.dirname(inputPath), `${pl}.image`), ext = path.extname(filename).toLowerCase();
        check(['.png', '.jpg', '.jpeg', '.webp'].includes(ext), `${pl}.image must be PNG, JPEG or WebP`);
        const item = await asset(filename, 'image', normal.id);
        const handle = await fs.open(filename, 'r'); const magic = Buffer.alloc(12); await handle.read(magic, 0, 12, 0); await handle.close();
        check((ext === '.png' && magic.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) || (['.jpg','.jpeg'].includes(ext) && magic[0] === 255 && magic[1] === 216 && magic[2] === 255) || (ext === '.webp' && magic.toString('ascii', 0, 4) === 'RIFF' && magic.toString('ascii', 8, 12) === 'WEBP'), `${pl}.image signature does not match extension`);
        const pan = p.pan ?? 'left'; check(['left','right','up','down','none'].includes(pan), `${pl}.pan must be left/right/up/down/none`);
        normal.params = { image: item.relativePath, title: visibleString(p.title, `${pl}.title`, 48), subtitle: optional('subtitle', 80), pan, positionX: number(p.positionX ?? 50, `${pl}.positionX`, 0, 100), positionY: number(p.positionY ?? 50, `${pl}.positionY`, 0, 100), zoomStart: number(p.zoomStart ?? 1.12, `${pl}.zoomStart`, 1.04, 1.4), zoomEnd: number(p.zoomEnd ?? 1.05, `${pl}.zoomEnd`, 1.04, 1.4) }; break;
      }
      case 'flow-steps': case 'checklist': {
        keys(p, ['title', 'items', 'note'], pl);
        normal.params = { title: visibleString(p.title, `${pl}.title`, 48), note: optional('note', 100), items: array(p.items, `${pl}.items`, 2, 5).map((item, index) => { const il = `${pl}.items[${index}]`; object(item, il); keys(item, ['label','detail'], il); return { label: visibleString(item.label, `${il}.label`, 24), detail: visibleString(item.detail, `${il}.detail`, 58, false) }; }) }; break;
      }
      case 'comparison': {
        keys(p, ['title', 'left', 'right', 'rows', 'note'], pl);
        normal.params = { title: visibleString(p.title, `${pl}.title`, 48), left: visibleString(p.left, `${pl}.left`, 20), right: visibleString(p.right, `${pl}.right`, 20), note: optional('note', 80), rows: array(p.rows, `${pl}.rows`, 1, 4).map((row, index) => { const rl = `${pl}.rows[${index}]`; object(row, rl); keys(row, ['label','left','right'], rl); return { label: visibleString(row.label, `${rl}.label`, 20), left: visibleString(row.left, `${rl}.left`, 42), right: visibleString(row.right, `${rl}.right`, 42) }; }) }; break;
      }
      case 'metric-bars': {
        keys(p, ['title', 'unit', 'scaleMax', 'bars', 'note'], pl);
        const scaleMax = number(p.scaleMax, `${pl}.scaleMax`, Number.EPSILON, 1e12);
        normal.params = { title: visibleString(p.title, `${pl}.title`, 48), unit: visibleString(p.unit, `${pl}.unit`, 16), scaleMax, note: optional('note', 100), bars: array(p.bars, `${pl}.bars`, 1, 5).map((bar, index) => { const bl = `${pl}.bars[${index}]`; object(bar, bl); keys(bar, ['label','value'], bl); return { label: visibleString(bar.label, `${bl}.label`, 26), value: number(bar.value, `${bl}.value`, 0, scaleMax) }; }) }; break;
      }
      case 'quote-focus': keys(p, ['quote', 'attribution', 'title'], pl); normal.params = { quote: visibleString(p.quote, `${pl}.quote`, 110), attribution: visibleString(p.attribution, `${pl}.attribution`, 60), title: optional('title', 40) }; break;
      case 'lower-third': keys(p, ['name', 'role', 'tag', 'side'], pl); check(['left','right'].includes(p.side ?? 'left'), `${pl}.side must be left or right`); normal.params = { name: visibleString(p.name, `${pl}.name`, 24), role: optional('role', 42), tag: optional('tag', 24), side: p.side ?? 'left' }; break;
    }
    shots.push(normal);
  }
  const full = shots.filter(s => s.recipe !== 'lower-third').sort((a,b) => a.start - b.start);
  for (let i = 1; i < full.length; i++) check(full[i].start >= full[i - 1].start + full[i - 1].duration - EPS, `Full-screen shots overlap: ${full[i - 1].id} / ${full[i].id}`);
  const lowers = shots.filter(s => s.recipe === 'lower-third').sort((a,b) => a.start - b.start);
  for (let i = 1; i < lowers.length; i++) check(lowers[i].start >= lowers[i - 1].start + lowers[i - 1].duration - EPS, `Lower-thirds overlap: ${lowers[i - 1].id} / ${lowers[i].id}`);
  const captions = array(raw.captions ?? [], 'captions', 0, 1000).map((caption, index) => { const label = `captions[${index}]`; object(caption, label); keys(caption, ['id','start','duration','text'], label); return { ...timed(caption, label), text: visibleString(caption.text, `${label}.text`, width >= height ? 100 : 58) }; }).sort((a,b) => a.start - b.start);
  for (let i = 1; i < captions.length; i++) check(captions[i].start >= captions[i - 1].start + captions[i - 1].duration - EPS, `Captions overlap: ${captions[i - 1].id} / ${captions[i].id}`);
  return { schemaVersion: 1, compositionId, title, canvas: { width, height, fps, duration, transparent, captionReserve }, style, shots, captions, assets: [...assets.values()], font, gsapVersion };
}

function sourceMarkup(shot) { return shot.source ? `<p class="motion-source">来源：${html(shot.source)}</p>` : ''; }
function content(shot) {
  const p = shot.params;
  const title = value => `<h2 class="motion-title">${html(value)}</h2>`;
  const note = value => value ? `<p class="motion-note">${html(value)}</p>` : '';
  switch (shot.recipe) {
    case 'title-reveal': return `<div class="title-copy"><p class="eyebrow">${html(p.eyebrow)}</p><div class="title-mask"><h1 class="hero-title">${html(p.title)}</h1></div><i class="accent-rule"></i>${note(p.subtitle)}</div>`;
    case 'photo-pan': return `<div class="photo-grid"><div class="photo-copy">${title(p.title)}<i class="accent-rule"></i>${note(p.subtitle)}</div><div class="photo-window"><img class="pan-photo" src="${html(p.image)}" alt="${html(p.title)}" style="object-position:${p.positionX}% ${p.positionY}%"><div class="photo-corner" data-layout-ignore></div></div></div>`;
    case 'flow-steps': return `${title(p.title)}<div class="flow-grid" data-step-count="${p.items.length}">${p.items.map((item,i) => `<div class="flow-node"><span class="step-number">${String(i + 1).padStart(2,'0')}</span><h3>${html(item.label)}</h3><p>${html(item.detail)}</p>${i < p.items.length - 1 ? '<span class="flow-connector" aria-hidden="true">→</span>' : ''}</div>`).join('')}</div>${note(p.note)}`;
    case 'checklist': return `${title(p.title)}<div class="check-grid">${p.items.map(item => `<div class="check-item"><svg class="check-mark" viewBox="0 0 60 60" aria-hidden="true"><circle cx="30" cy="30" r="26"></circle><path d="M17 30L26 39L44 21"></path></svg><div class="check-copy"><h3>${html(item.label)}</h3><p>${html(item.detail)}</p></div></div>`).join('')}</div>${note(p.note)}`;
    case 'comparison': return `${title(p.title)}<div class="compare-grid"><span class="compare-empty"></span><h3 class="compare-heading">${html(p.left)}</h3><h3 class="compare-heading">${html(p.right)}</h3>${p.rows.map(row => `<span class="compare-label">${html(row.label)}</span><p class="compare-cell">${html(row.left)}</p><p class="compare-cell">${html(row.right)}</p>`).join('')}</div>${note(p.note)}`;
    case 'metric-bars': return `${title(p.title)}<div class="metrics"><p class="scale-note">共同刻度：0—${p.scaleMax} ${html(p.unit)}</p>${p.bars.map(bar => `<div class="metric-row"><div class="metric-top"><span>${html(bar.label)}</span><strong>${bar.value}<small> ${html(p.unit)}</small></strong></div><div class="metric-track"><span class="metric-fill" style="width:${100 * bar.value / p.scaleMax}%"></span></div></div>`).join('')}</div>${note(p.note)}`;
    case 'quote-focus': return `${p.title ? title(p.title) : ''}<div class="quote-block"><span class="quote-mark" aria-hidden="true">“</span><blockquote>${html(p.quote)}</blockquote><i class="accent-rule"></i><p class="quote-author">${html(p.attribution)}</p></div>`;
    case 'lower-third': return `<div class="lower-panel ${p.side}"><i class="lower-accent"></i><div class="lower-copy"><p class="lower-tag">${html(p.tag)}</p><h2>${html(p.name)}</h2><p>${html(p.role)}</p></div></div>`;
  }
}

function makeHtml(description) {
  const {canvas:c, style:s} = description;
  const fontCss = description.font
    ? `@font-face{font-family:JiaVideoLocal;src:url('${description.font.relativePath}');font-display:block}body{font-family:JiaVideoLocal,sans-serif}`
    : "@font-face{font-family:JiaVideoSystem;src:local('Microsoft YaHei');font-display:block}body{font-family:JiaVideoSystem,sans-serif}";
  const scenes = description.shots.map(shot => `<section id="${shot.id}" class="clip motion-scene recipe-${shot.recipe}" data-start="${shot.start}" data-duration="${shot.duration}" data-track-index="${shot.recipe === 'lower-third' ? 10 : 0}"><div class="motion-content">${content(shot)}${sourceMarkup(shot)}</div></section>`).join('\n');
  const captions = description.captions.map(cap => `<div id="${cap.id}" class="clip motion-caption" data-start="${cap.start}" data-duration="${cap.duration}" data-track-index="20"><span>${html(cap.text)}</span></div>`).join('\n');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${html(description.title)}</title>
<link rel="stylesheet" href="assets/motion.css">
<style>:root{--width:${c.width}px;--height:${c.height}px;--u:${Math.min(c.width,c.height)/1080}px;--paper:${s.background};--ink:${s.foreground};--muted:${s.muted};--accent:${s.accent};--caption-reserve:${c.captionReserve*c.height}px}${fontCss}</style>
</head><body class="${c.width < c.height ? 'portrait' : 'landscape'}${c.transparent ? ' transparent' : ''}">
<div id="${description.compositionId}" class="motion-composition" data-composition-id="${description.compositionId}" data-start="0" data-duration="${c.duration}" data-width="${c.width}" data-height="${c.height}" data-fps="${c.fps}">
${scenes}
${captions}
</div>
<script type="application/json" id="motion-description">${jsonForHtml({ compositionId:description.compositionId, canvas:c, shots:description.shots, captions:description.captions })}</script>
<script>window.__timelines = window.__timelines || {};</script>
<script src="assets/gsap.min.js"></script>
<script src="assets/motion-runtime.js"></script>
</body></html>\n`;
}

async function main() {
  const args = cli(process.argv.slice(2));
  if (args.help) { console.log('node build-motion.mjs --input <motion.json> --output <new-directory> --gsap <local-gsap.min.js> [--font <local-font>]'); return; }
  const inputPath = path.resolve(args.input), outputPath = path.resolve(args.output);
  check(!(await exists(outputPath)), `Output already exists; choose a new version directory: ${outputPath}`);
  const gsapPath = localPath(args.gsap, process.cwd(), '--gsap'), fontPath = args.font ? localPath(args.font, process.cwd(), '--font') : null;
  const inputBytes = await fs.readFile(inputPath);
  const raw = JSON.parse(inputBytes.toString('utf8').replace(/^\uFEFF/, ''));
  const description = await validate(raw, inputPath, gsapPath, fontPath);
  const temp = `${outputPath}.building-${randomUUID()}`;
  await fs.mkdir(path.dirname(outputPath), { recursive:true });
  await fs.mkdir(path.join(temp, 'assets'), { recursive:true });
  try {
    for (const asset of description.assets) {
      const target = path.join(temp, asset.relativePath);
      await fs.copyFile(asset.originalPath, target);
      check(await sha256(target) === asset.sha256, `Asset changed during copy: ${asset.originalPath}`);
    }
    for (const [source,dest] of [['motion-runtime.js','motion-runtime.js'],['motion.css','motion.css']]) await fs.copyFile(path.join(COMPONENTS, source), path.join(temp,'assets',dest));
    await fs.writeFile(path.join(temp,'index.html'), makeHtml(description), 'utf8');
    const receipt = { schemaVersion:1, purpose:'motion-build-dependencies', generatedAt:new Date().toISOString(), node:process.version, runtime:{ name:'GSAP', version:description.gsapVersion, path:'assets/gsap.min.js', sha256:description.assets.find(a=>a.kind==='gsap-runtime').sha256 }, adapter:{ file:'assets/motion-runtime.js', sha256:await sha256(path.join(temp,'assets/motion-runtime.js')) }, stylesheet:{ file:'assets/motion.css', sha256:await sha256(path.join(temp,'assets/motion.css')) }, font:description.font ? {kind:'local-file',family:'JiaVideoLocal',file:description.font.relativePath,sha256:description.font.sha256} : {kind:'host-system',family:'JiaVideoSystem',localName:'Microsoft YaHei',portable:false}, intendedRenderer:'HyperFrames 0.7.103', offline:true, renderVerified:false };
    const manifest = { schemaVersion:1, purpose:'motion-build-assets', input:{ path:inputPath, sha256:createHash('sha256').update(inputBytes).digest('hex') }, assets:description.assets, output:{ html:'index.html', sha256:await sha256(path.join(temp,'index.html')) }, limitations:['Source labels are user-supplied provenance, not independently verified facts.', 'Build success is not render, audio, visual or user approval.'] };
    const writeJson = (name,value) => fs.writeFile(path.join(temp,name), JSON.stringify(value,null,2)+'\n', 'utf8');
    await writeJson('motion.normalized.json', {schemaVersion:1,compositionId:description.compositionId,title:description.title,canvas:description.canvas,style:description.style,shots:description.shots,captions:description.captions});
    await writeJson('asset-manifest.json', manifest);
    await writeJson('dependencies.json', receipt);
    // mkdir is exclusive even when another process creates an empty target.
    await fs.mkdir(outputPath);
    for (const entry of await fs.readdir(temp)) await fs.rename(path.join(temp, entry), path.join(outputPath, entry));
    await fs.rmdir(temp);
    console.log(JSON.stringify({ status:'BUILT_NOT_RENDERED', output:outputPath, compositionId:description.compositionId, dimensions:[description.canvas.width,description.canvas.height], duration:description.canvas.duration, recipes:[...new Set(description.shots.map(s=>s.recipe))], assets:description.assets.length },null,2));
  } catch(e) { console.error(`Incomplete new build preserved at ${temp}`); throw e; }
}
main().catch(e => { console.error(`build-motion: ${e.message}`); process.exitCode = 1; });
