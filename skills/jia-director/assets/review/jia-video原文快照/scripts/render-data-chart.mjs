#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';

const DEFAULT_CONFIG = 'E:\\开发项目\\视频剪辑skill\\config\\video-workflow.json';
const TEMPLATE = fileURLToPath(new URL('../assets/livecanvas-remotion/', import.meta.url));
const EXPECTED = {'@remotion/bundler':'4.0.530', '@remotion/renderer':'4.0.530', remotion:'4.0.530', react:'19.1.0', 'react-dom':'19.1.0'};
const FRAMES = [0, 30, 60, 78, 89];
const HELP = `Local LiveCanvas data chart renderer (fixed 1080x1440 / 30fps / 90 frames).
  node render-data-chart.mjs --data <json> --output <NEW directory> [--allow-demo]
       [--config <runtime-json>] [--runtime <installed project>] [--browser <local executable>]
  node render-data-chart.mjs --doctor [--config <runtime-json>] [--runtime <project>] [--browser <executable>]
No dependency install, browser download, remote media, audio, or Live Photo pairing.
Synthetic data requires explicit --allow-demo. Real data requires HTTP(S) source URLs.
An existing output directory is always rejected; failed engineering remains for inspection.`;

const fail = (message) => {throw new Error(message);};
const object = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}: expected object`);
};
const textField = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) fail(`${label}: expected nonempty text`);
};
const date = (value, label) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(`${label}: expected YYYY-MM-DD`);
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0,10) !== value) fail(`${label}: invalid calendar date`);
  return ms;
};
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = async (file) => JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,''));
const exists = async (file) => {
  try {await fs.lstat(file); return true;} catch (error) {if(error.code === 'ENOENT') return false; throw error;}
};

function args(argv) {
  const out = {};
  const values = new Set(['data','output','config','runtime','browser']);
  const switches = new Set(['doctor','allow-demo','help']);
  for (let i=0; i<argv.length; i++) {
    const name = argv[i].startsWith('--') ? argv[i].slice(2) : '';
    if (!values.has(name) && !switches.has(name)) fail(`Unknown argument: ${argv[i]}`);
    if (Object.hasOwn(out,name)) fail(`Duplicate argument: --${name}`);
    if (values.has(name)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) fail(`Missing value: --${name}`);
      out[name] = path.resolve(value);
    } else out[name] = true;
  }
  if (out.help) {
    if (Object.keys(out).length !== 1) fail('--help must be used alone');
    return out;
  }
  if (out.doctor) {
    if (out.data || out.output || out['allow-demo']) fail('--doctor only accepts --config, --runtime, and --browser');
  } else if (!out.data || !out.output) fail('Required: --data and --output (or --doctor / --help)');
  return out;
}

function validate(data, allowDemo) {
  object(data,'data');
  if (data.schemaVersion !== 1) fail('data.schemaVersion must be 1');
  if (typeof data.demo !== 'boolean') fail('data.demo must be boolean');
  textField(data.provenance,'data.provenance');
  const synthetic = data.demo || data.provenance === 'synthetic';
  if (synthetic && !allowDemo) fail('Synthetic data requires explicit --allow-demo');
  for (const key of ['title','subtitle','footnote']) textField(data[key],`data.${key}`);
  date(data.asOf,'data.asOf');
  object(data.metric,'data.metric');
  for (const key of ['kind','label','unit']) textField(data.metric[key],`data.metric.${key}`);
  object(data.period,'data.period');
  const start = date(data.period.start,'data.period.start');
  const end = date(data.period.end,'data.period.end');
  if (!(start < end)) fail('period.start must be earlier than period.end');
  if (!['daily','monthly','yearly'].includes(data.period.granularity)) fail('period.granularity must be daily/monthly/yearly');
  for (const key of ['timezone','definition']) textField(data.period[key],`data.period.${key}`);
  object(data.display,'data.display');
  const domain = data.display.yDomain;
  if (!Array.isArray(domain) || domain.length !== 2 || !domain.every(Number.isFinite) || !(domain[0] < domain[1])) fail('display.yDomain requires two finite increasing numbers');
  if (!Number.isInteger(data.display.decimals) || data.display.decimals < 0 || data.display.decimals > 4) fail('display.decimals must be an integer from 0 through 4');
  if (!Array.isArray(data.sources) || !data.sources.length) fail('data.sources must be a nonempty array');
  const sources = new Set();
  for (const [i,source] of data.sources.entries()) {
    object(source,`sources[${i}]`);
    for (const key of ['id','title','url']) textField(source[key],`sources[${i}].${key}`);
    if (sources.has(source.id)) fail(`Duplicate source id: ${source.id}`);
    sources.add(source.id);
    let url;
    try {url = new URL(source.url);} catch {fail(`sources[${i}].url: invalid URL`);}
    if (!synthetic && !['http:','https:'].includes(url.protocol)) fail(`sources[${i}].url: real data requires HTTP(S)`);
    if (source.accessedAt !== undefined) date(source.accessedAt,`sources[${i}].accessedAt`);
    if (source.method !== undefined) textField(source.method,`sources[${i}].method`);
  }
  if (!Array.isArray(data.series) || data.series.length < 1 || data.series.length > 4) fail('data.series requires 1 through 4 series');
  const ids = new Set();
  for (const [i,series] of data.series.entries()) {
    object(series,`series[${i}]`);
    for (const key of ['id','name','color']) textField(series[key],`series[${i}].${key}`);
    if (ids.has(series.id)) fail(`Duplicate series id: ${series.id}`);
    ids.add(series.id);
    // Colors enter SVG/CSS only as colors: URL values and arbitrary CSS are not supported.
    if (!/^#[\da-f]{6}$/i.test(series.color)) fail(`series[${i}].color: expected six-digit hex color`);
    if (!Array.isArray(series.points) || !series.points.length) fail(`series[${i}].points must be nonempty`);
    let previous = -Infinity;
    let observed = 0;
    for (const [j,point] of series.points.entries()) {
      object(point,`series[${i}].points[${j}]`);
      const ms = date(point.date,`series[${i}].points[${j}].date`);
      if (!(ms > previous)) fail(`series[${i}] dates must be strictly increasing and unique`);
      if (ms < start || ms > end) fail(`series[${i}].points[${j}].date falls outside period`);
      previous = ms;
      textField(point.sourceId,`series[${i}].points[${j}].sourceId`);
      if (!sources.has(point.sourceId)) fail(`Unknown point sourceId: ${point.sourceId}`);
      if (point.value !== null) {
        if (!Number.isFinite(point.value)) fail(`series[${i}].points[${j}].value must be finite or null`);
        if (point.value < domain[0] || point.value > domain[1]) fail(`series[${i}].points[${j}].value lies outside yDomain`);
        observed++;
      }
    }
    if (!observed) fail(`series[${i}] needs at least one observed value (the template requires an observed first series)`);
  }
  const renderData = structuredClone(data);
  if (synthetic) renderData.demo = true;
  return {synthetic, renderData};
}

async function packageInfo(req, name) {
  const entry = req.resolve(name);
  let dir = path.dirname(entry);
  for (;;) {
    const file = path.join(dir,'package.json');
    if (await exists(file)) {
      const pkg = await readJson(file);
      if (pkg.name === name) return {name,version:pkg.version,entry,packageJson:file};
    }
    const parent = path.dirname(dir);
    if (parent === dir) fail(`Cannot locate installed package metadata: ${name}`);
    dir = parent;
  }
}

async function runtimeState(options) {
  const configPath = options.config || DEFAULT_CONFIG;
  const state = {configPath,runtimeProject:null,browserPath:null,packages:[],errors:[],ready:false,networkInstall:false};
  let config = {};
  try {config = await readJson(configPath);} catch (error) {
    // Explicit runtime AND browser make configuration optional; do not hide malformed JSON.
    if (!(error.code === 'ENOENT' && options.runtime && options.browser)) state.errors.push(`Configuration: ${error.message}`);
  }
  state.runtimeProject = options.runtime || config.dataCharts?.runtimeProject || null;
  state.browserPath = options.browser || config.render?.browserPath || null;
  if (state.runtimeProject) state.runtimeProject = path.resolve(state.runtimeProject);
  if (state.browserPath) state.browserPath = path.resolve(state.browserPath);
  if (!state.browserPath) state.errors.push('Set config.render.browserPath or --browser to an existing local browser');
  else {
    try {if (!(await fs.stat(state.browserPath)).isFile()) fail('not a file');}
    catch (error) {state.errors.push(`Browser: ${error.message}`);}
  }
  if (!state.runtimeProject) state.errors.push('Set config.dataCharts.runtimeProject or --runtime; no fallback to other Remotion projects');
  else {
    try {
      const runtimePackage = path.join(state.runtimeProject,'package.json');
      await fs.access(runtimePackage);
      const nodeModules = path.join(state.runtimeProject,'node_modules');
      if (!(await fs.stat(nodeModules)).isDirectory()) fail('node_modules is not a directory');
      const req = createRequire(runtimePackage);
      for (const [name,expected] of Object.entries(EXPECTED)) {
        try {
          const info = await packageInfo(req,name);
          state.packages.push({...info,expected});
          if (info.version !== expected) state.errors.push(`${name}: installed ${info.version}, expected ${expected}`);
          const relative = path.relative(nodeModules,info.entry);
          if (relative.startsWith('..') || path.isAbsolute(relative)) state.errors.push(`${name}: resolves outside selected runtime node_modules`);
        } catch (error) {state.errors.push(`${name}: ${error.message}`);}
      }
    } catch (error) {state.errors.push(`Runtime: ${error.message}`);}
  }
  state.ready = state.errors.length === 0;
  return state;
}

async function fileTree(root, prefix='') {
  const files = [];
  for (const item of (await fs.readdir(path.join(root,prefix),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
    const relative = path.join(prefix,item.name);
    if (item.isSymbolicLink()) fail(`Template must not contain links: ${relative}`);
    if (item.isDirectory()) files.push(...await fileTree(root,relative));
    else if (item.isFile()) {
      const bytes = await fs.readFile(path.join(root,relative));
      files.push({path:relative.replaceAll('\\','/'),bytes:bytes.length,sha256:sha(bytes)});
    } else fail(`Unsupported template entry: ${relative}`);
  }
  return files;
}

async function main() {
  const options = args(process.argv.slice(2));
  if (options.help) {console.log(HELP); return;}
  if (options.doctor) {
    const state = await runtimeState(options);
    console.log(JSON.stringify({kind:'livecanvas-runtime-doctor',...state},null,2));
    if (!state.ready) process.exitCode = 1;
    return;
  }
  const inputBytes = await fs.readFile(options.data);
  const originalData = JSON.parse(inputBytes.toString('utf8').replace(/^\uFEFF/,''));
  const {synthetic,renderData} = validate(originalData,Boolean(options['allow-demo']));
  if (await exists(options.output)) fail(`Output directory already exists: ${options.output}`);
  const state = await runtimeState(options);
  if (!state.ready) fail(`Runtime is not ready: ${state.errors.join('; ')}`);
  const templateFiles = await fileTree(TEMPLATE);
  const receipt = {schemaVersion:1,kind:'livecanvas-local-render',status:'preparing',startedAt:new Date().toISOString(),
    outputDirectory:options.output,input:{path:options.data,sha256:sha(inputBytes),originalData},
    synthetic,syntheticLabel:synthetic?'合成示例 · 非真实数据':null,sourcesVerified:false,
    sourceVerification:'Source identifiers and URLs checked for structure only; facts were not verified.',
    geometry:{width:1080,height:1440,fps:30,durationInFrames:90,durationSeconds:3},
    template:{root:TEMPLATE,files:templateFiles},runtime:state,adapterChanges:[],artifacts:[],
    audio:false,livePhotoPairing:false,dependencyInstall:false,browserDownload:false,remoteMedia:false};
  await fs.mkdir(path.dirname(options.output),{recursive:true});
  await fs.mkdir(options.output); // exclusive: a competing run cannot reuse it
  const receiptPath = path.join(options.output,'render.json');
  try {
    await fs.writeFile(receiptPath,JSON.stringify(receipt,null,2),{flag:'wx'});
    // The root is our exclusive directory containing the initial receipt. Copy
    // children into absent destinations: fs.cp(errorOnExist) rejects the root itself.
    for (const item of await fs.readdir(TEMPLATE,{withFileTypes:true})) {
      await fs.cp(path.join(TEMPLATE,item.name),path.join(options.output,item.name),{recursive:true,errorOnExist:true,force:false});
    }
    await fs.writeFile(path.join(options.output,'data.json'),JSON.stringify(renderData,null,2)+'\n');
    receipt.adapterChanges.push({file:'data.json',change:'Replace copied example with validated input; force visible demo label for synthetic provenance.'});
    const entryPoint = path.join(options.output,'src','index.tsx');
    const source = await fs.readFile(entryPoint,'utf8');
    const fontNeedle = 'fontFamily:\'"PingFang SC", "Noto Sans CJK SC", sans-serif\'';
    if (!source.includes(fontNeedle)) fail('Pinned template no longer matches font adapter patch');
    const adapted = source.replace(fontNeedle,'fontFamily:\'"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif\'');
    await fs.writeFile(entryPoint,adapted);
    receipt.adapterChanges.push({file:'src/index.tsx',change:'Add Windows Microsoft YaHei font fallback.',originalSha256:sha(Buffer.from(source)),workingSha256:sha(Buffer.from(adapted))});
    const modules = path.join(options.output,'node_modules');
    await fs.symlink(path.join(state.runtimeProject,'node_modules'),modules,process.platform==='win32'?'junction':'dir');
    receipt.runtime.nodeModulesLink = {path:modules,target:await fs.realpath(modules),type:process.platform==='win32'?'junction':'symlink'};
    receipt.status = 'rendering';
    await fs.writeFile(receiptPath,JSON.stringify(receipt,null,2));
    const req = createRequire(path.join(state.runtimeProject,'package.json'));
    const bundler = await import(pathToFileURL(req.resolve('@remotion/bundler')).href);
    const renderer = await import(pathToFileURL(req.resolve('@remotion/renderer')).href);
    const serveUrl = await bundler.bundle({entryPoint,outDir:path.join(options.output,'bundle')});
    const inputProps = {data:renderData};
    const browserExecutable = state.browserPath;
    const composition = await renderer.selectComposition({serveUrl,id:'LiveCanvas',inputProps,browserExecutable});
    if (composition.width!==1080 || composition.height!==1440 || composition.fps!==30 || composition.durationInFrames!==90) fail('Template composition differs from fixed 1080x1440 / 30fps / 90-frame contract');
    const common = {composition,serveUrl,inputProps,browserExecutable};
    await renderer.renderMedia({...common,codec:'h264',pixelFormat:'yuv420p',crf:16,concurrency:2,outputLocation:path.join(options.output,'motion.mp4')});
    await renderer.renderStill({...common,frame:78,imageFormat:'jpeg',jpegQuality:100,output:path.join(options.output,'cover.jpg')});
    for (const frame of FRAMES) await renderer.renderStill({...common,frame,imageFormat:'png',output:path.join(options.output,`frame-${frame}.png`)});
    for (const name of ['motion.mp4','cover.jpg',...FRAMES.map(frame=>`frame-${frame}.png`)]) {
      const bytes = await fs.readFile(path.join(options.output,name));
      if (!bytes.length) fail(`Empty output: ${name}`);
      receipt.artifacts.push({path:name,bytes:bytes.length,sha256:sha(bytes)});
    }
    receipt.status = 'rendered_pending_visual_review';
    receipt.coverFrame = 78;
    receipt.completedAt = new Date().toISOString();
    receipt.workingSource = await fileTree(path.join(options.output,'src'));
    await fs.writeFile(receiptPath,JSON.stringify(receipt,null,2));
    console.log(JSON.stringify({status:receipt.status,outputDirectory:options.output,receipt:receiptPath,synthetic},null,2));
  } catch (error) {
    receipt.status = 'failed';
    receipt.failedAt = new Date().toISOString();
    receipt.error = {name:error.name,message:error.message};
    try {await fs.writeFile(receiptPath,JSON.stringify(receipt,null,2));} catch (receiptError) {console.error(`Receipt write failed: ${receiptError.message}`);}
    throw error;
  }
}

main().catch(error=>{console.error(JSON.stringify({status:'failed',message:error.message}));process.exitCode=1;});
