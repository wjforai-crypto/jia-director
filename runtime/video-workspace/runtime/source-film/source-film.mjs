import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
const require=createRequire(import.meta.url);
const hash=b=>createHash('sha256').update(b).digest('hex');
const inside=(root,p)=>{const r=path.relative(root,p);return r!== '..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r);};
const dotted=s=>typeof s==='string'&&/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(s);
const finite=(n,label,min=0)=>{if(typeof n!=='number'||!Number.isFinite(n)||n<min)throw Error(`Invalid ${label}`);};
export function validateSpec(s){
  if(s.schemaVersion!==1||!['source-reproduction','source-adaptation','reference-original'].includes(s.mode))throw Error('Invalid schemaVersion/mode');
  if(!s.source?.root||!Array.isArray(s.source.files)||!s.source.files.length)throw Error('Explicit source root and tracked files required');
  for(const key of ['width','height','fps','duration'])finite(s.video?.[key],key,Number.EPSILON);
  if(!Number.isInteger(s.video.width)||!Number.isInteger(s.video.height)||s.video.width%2||s.video.height%2)throw Error('H264 delivery requires positive even dimensions');
  if(Math.abs(s.video.duration*s.video.fps-Math.round(s.video.duration*s.video.fps))>1e-6)throw Error('Duration must contain a whole number of frames');
  if(!['silent','audio-present'].includes(s.video.audio))throw Error('Declare video.audio');
  if(!['browser','command'].includes(s.renderer?.kind))throw Error('Unknown renderer');
  if(s.renderer.kind==='browser'){
    if(!s.renderer.entry||!dotted(s.renderer.seek)||!dotted(s.renderer.ready))throw Error('Browser entry, dotted seek and ready required');
    if(s.renderer.state&&!dotted(s.renderer.state))throw Error('Invalid state function');
    if(s.video.audio!=='silent')throw Error('Browser output is silent; assemble audio using the director composition route');
  }else if(!s.renderer.executable||!Array.isArray(s.renderer.args)||!s.renderer.args.some(v=>String(v).includes('{output}')))throw Error('Command requires executable, argument array and {output} placeholder');
  finite(s.time?.offset??0,'time.offset');finite(s.time?.rate??1,'time.rate',Number.EPSILON);
  for(const c of s.checkpoints??[]){finite(c.at,'checkpoint.at');if(c.at>=s.video.duration)throw Error('Checkpoint outside duration');if(c.maxStepPixels!==undefined)finite(c.maxStepPixels,'maxStepPixels');}
  return s;
}
export function assessObjects(rule,states){
  const issues=[];
  for(const state of states){const rows=state?.objects?.filter(o=>o.id===rule.objectId)??[];if(rule.expectSingle&&rows.length!==1)issues.push(`Expected one ${rule.objectId}, found ${rows.length}`);}
  if(rule.maxStepPixels!==undefined)for(let i=1;i<states.length;i++){
    const a=states[i-1]?.objects?.find(o=>o.id===rule.objectId),b=states[i]?.objects?.find(o=>o.id===rule.objectId);
    if(a&&b){if(a.space!=='screen'||b.space!=='screen'||![a.x,a.y,b.x,b.y].every(Number.isFinite))issues.push('Position evidence must use finite screen coordinates');else if(Math.hypot(a.x-b.x,a.y-b.y)>rule.maxStepPixels)issues.push(`Screen step exceeds ${rule.maxStepPixels}px`);}
  }
  return [...new Set(issues)];
}
async function readJSON(p){return JSON.parse((await fs.readFile(p,'utf8')).replace(/^\uFEFF/,''));}
async function exclusiveDir(p){await fs.mkdir(path.dirname(p),{recursive:true});await fs.mkdir(p);}
function native(exe,args){const r=spawnSync(exe,args,{encoding:'utf8',windowsHide:true,maxBuffer:12*1024*1024});return{command:[exe,...args],exitCode:r.status,stdout:r.stdout??'',stderr:r.stderr??'',error:r.error?.message??null};}
function requireSuccess(r){if(r.error||r.exitCode!==0)throw Error(`Command failed: ${r.command[0]} exit=${r.exitCode}; ${(r.error??r.stderr).slice(-1800)}`);return r;}
export async function verifyVideo(input,video,tools={}){
  const probeCall=requireSuccess(native(tools.ffprobeCommand??'ffprobe',['-v','error','-count_frames','-show_streams','-show_format','-of','json',input]));
  const p=JSON.parse(probeCall.stdout),v=p.streams.find(v=>v.codec_type==='video');if(!v)throw Error('No video stream');
  const [n,d]=v.avg_frame_rate.split('/').map(Number),fps=n/d,frames=Number(v.nb_read_frames),duration=Number(v.duration??p.format.duration),audio=p.streams.filter(s=>s.codec_type==='audio').length;
  const issues=[];
  if(v.width!==video.width||v.height!==video.height)issues.push('dimensions mismatch');
  if(!Number.isFinite(fps)||Math.abs(fps-video.fps)>1e-5)issues.push('fps mismatch');
  if(frames!==Math.round(video.fps*video.duration))issues.push('decoded frame count mismatch');
  if(!Number.isFinite(duration)||Math.abs(duration-video.duration)>1/video.fps+.001)issues.push('duration mismatch');
  if(video.audio==='silent'&&audio!==0||video.audio==='audio-present'&&audio===0)issues.push('audio contract mismatch');
  const decode=native(tools.ffmpegCommand??'ffmpeg',['-hide_banner','-v','error','-xerror','-i',input,'-f','null','-']);
  if(decode.error||decode.exitCode!==0)issues.push('full decode failed');
  return{passed:issues.length===0,actual:{width:v.width,height:v.height,fps,frames,duration,audio,colorSpace:v.color_space??null,colorRange:v.color_range??null},issues,probe:p,decode,probeCommand:probeCall.command};
}
async function fingerprint(root,entries){
  const rows=[];
  async function visit(file){const real=await fs.realpath(file);if(!inside(root,real))throw Error('Tracked source escapes root');const st=await fs.stat(real);if(st.isDirectory()){for(const n of (await fs.readdir(real)).sort())if(!['__pycache__','.git','node_modules'].includes(n))await visit(path.join(real,n));}else if(st.isFile())rows.push({file:path.relative(root,real).replaceAll('\\','/'),sha256:hash(await fs.readFile(real))});}
  for(const entry of entries){if(typeof entry!=='string'||path.isAbsolute(entry)||!inside(root,path.resolve(root,entry)))throw Error('Tracked source must stay inside source root');await visit(path.resolve(root,entry));}
  rows.sort((a,b)=>a.file.localeCompare(b.file));return{sha256:hash(JSON.stringify(rows)),files:rows};
}
async function browserSession(spec,cfg,errors,assets){
  const root=await fs.realpath(spec.source.root),mime={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.woff2':'font/woff2','.ttf':'font/ttf','.ttc':'font/collection','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.wasm':'application/wasm'};
  const server=http.createServer(async(req,res)=>{try{const u=new URL(req.url,'http://localhost');if(u.pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}const rel=decodeURIComponent(u.pathname),file=path.resolve(root,'.'+rel);if(!inside(root,file))throw Error('Outside source root');const real=await fs.realpath(file);if(!inside(root,real))throw Error('Linked asset outside source root');const bytes=await fs.readFile(real);assets.set(path.relative(root,real),hash(bytes));res.writeHead(200,{'Content-Type':mime[path.extname(real)]??'application/octet-stream','Cache-Control':'no-store'});res.end(bytes);}catch{res.writeHead(404);res.end('Resource unavailable');}});
  await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
  let browser;
  try{
    const mod=spec.renderer.playwright??cfg.sourceFilm?.playwrightModule;if(!mod)throw Error('Existing Playwright package required; no automatic install');
    const {chromium}=require(path.resolve(mod));
    browser=await chromium.launch({executablePath:spec.renderer.browser??cfg.render?.browserPath,headless:true,args:['--force-color-profile=srgb','--force-device-scale-factor=1']});
    const origin=`http://127.0.0.1:${server.address().port}`;
    return{async page(){
      const p=await browser.newPage({viewport:{width:spec.video.width,height:spec.video.height},deviceScaleFactor:1});p.setDefaultTimeout(30000);
      p.on('pageerror',e=>errors.push(String(e)));p.on('console',m=>{if(m.type()==='error')errors.push(m.text());});p.on('response',r=>{if(r.status()>=400)errors.push(`HTTP ${r.status()}: ${r.url()}`);});
      await p.route('**/*',r=>{const url=r.request().url();if(url.startsWith(origin+'/')||url.startsWith('data:')||url.startsWith('blob:'))return r.continue();errors.push(`Blocked external request: ${new URL(url).origin}`);return r.abort();});
      const u=new URL(spec.renderer.entry,origin+'/');if(u.origin!==origin)throw Error('Entry must be local');await p.goto(u.href);
      await p.waitForFunction(key=>key.split('.').reduce((v,k)=>v?.[k],window)===true,spec.renderer.ready);
      await p.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode()));});
      if(spec.renderer.capture)await p.locator(spec.renderer.capture).evaluate((el,size)=>{if(el instanceof HTMLCanvasElement){if(el.width!==size.width||el.height!==size.height)throw Error('Intrinsic canvas size differs from delivery spec');Object.assign(el.style,{position:'fixed',left:'0',top:'0',width:`${size.width}px`,height:`${size.height}px`,maxWidth:'none',maxHeight:'none',margin:'0',display:'block',zIndex:'2147483647'});}},{width:spec.video.width,height:spec.video.height});return p;
    },async close(){await browser.close();await new Promise(r=>server.close(r));}};
  }catch(e){if(browser)await browser.close();await new Promise(r=>server.close(r));throw e;}
}
async function at(page,spec,t){
  const mapped=(spec.time?.offset??0)+t*(spec.time?.rate??1);
  return page.evaluate(async({seek,state,t})=>{const get=key=>key.split('.').reduce((v,k)=>v?.[k],window);const parent=seek.includes('.')?get(seek.slice(0,seek.lastIndexOf('.'))):window;const fn=get(seek);if(typeof fn!=='function')throw Error('Seek function missing');const ret=fn.call(parent,t);if(ret instanceof Promise)await ret;return state?get(state)(t):null;},{seek:spec.renderer.seek,state:spec.renderer.state,t:mapped});
}
async function capture(page,spec,file){const node=spec.renderer.capture? page.locator(spec.renderer.capture):page;const bytes=await node.screenshot({path:file,type:'png',animations:'allow'});return hash(bytes);}
async function checkBrowser(session,spec,output,report){
  const page=await session.page(),times=new Set([0,Math.max(0,spec.video.duration-1/spec.video.fps)]);
  for(const c of spec.checkpoints??[])for(const off of [-1,0,1])times.add(Math.max(0,Math.min(spec.video.duration-1/spec.video.fps,c.at+off/spec.video.fps)));
  const stateMap=new Map();await fs.mkdir(path.join(output,'checks'));
  report.samples=[];for(const t of [...times].sort((a,b)=>a-b)){const state=await at(page,spec,t),file=`checks/${report.samples.length.toString().padStart(3,'0')}.png`,sha256=await capture(page,spec,path.join(output,file));stateMap.set(t,state);report.samples.push({t,sourceTime:(spec.time?.offset??0)+t*(spec.time?.rate??1),file,sha256,state});}
  const probe=Math.floor(spec.video.duration*.37*spec.video.fps)/spec.video.fps,a=await at(page,spec,probe),ah=await capture(page,spec);
  await at(page,spec,Math.max(0,spec.video.duration-1/spec.video.fps));await at(page,spec,0);const b=await at(page,spec,probe),bh=await capture(page,spec);
  report.seek={time:probe,imageExact:ah===bh,stateExact:spec.renderer.state?JSON.stringify(a)===JSON.stringify(b):null};
  report.warnings=[];
  if(!report.seek.imageExact)report.warnings.push('Repeated screenshot differs; inspect actual image differences before accepting determinism.');
  if(!spec.renderer.state)report.warnings.push('Object-state instrumentation is unavailable; visual handoff review remains required.');
  report.handoffs=(spec.checkpoints??[]).filter(c=>c.objectId).map(c=>{const states=[-1,0,1].map(o=>stateMap.get(Math.max(0,Math.min(spec.video.duration-1/spec.video.fps,c.at+o/spec.video.fps))));return{...c,status:spec.renderer.state?'INSTRUMENTED':'NOT_INSTRUMENTED',issues:spec.renderer.state?assessObjects(c,states):[]};});
  if(report.seek.stateExact===false||spec.requireExactSeek&&report.seek.imageExact===false||report.handoffs.some(h=>h.issues.length))throw Error('Seek/object handoff check failed; inspect report and images');await page.close();
}
export async function main(argv=process.argv.slice(2)){
  const [command,...rest]=argv;if(!command||command==='--help'){console.log('source-film.mjs doctor|render|check --spec FILE --output NEW_JOB_DIR [--config FILE] [--workers 1..8]');return;}
  if(!['doctor','render','check'].includes(command))throw Error('Unknown source-film command');const a={};
  for(let i=0;i<rest.length;i+=2){if(!['--spec','--output','--config','--workers'].includes(rest[i])||!rest[i+1]||Object.hasOwn(a,rest[i].slice(2)))throw Error('Distinct flag/value arguments required');a[rest[i].slice(2)]=rest[i+1];}
  const cfg=a.config?await readJSON(a.config):{},spec=validateSpec(await readJSON(a.spec));spec.source.root=await fs.realpath(spec.source.root);
  const workers=Number(a.workers??cfg.sourceFilm?.defaultWorkers??1);if(!Number.isInteger(workers)||workers<1||workers>8)throw Error('workers must be 1..8');
  if(command==='doctor'){const r={node:process.version,source:await fingerprint(spec.source.root,spec.source.files),tools:Object.fromEntries(['ffmpegCommand','ffprobeCommand'].map(k=>{const v=native(cfg.tools?.[k]??k.replace('Command',''),['-version']);return[k,{executable:v.command[0],available:v.exitCode===0}];})),renderer:spec.renderer.kind,installsPerformed:false};console.log(JSON.stringify(r,null,2));if(Object.values(r.tools).some(t=>!t.available))process.exitCode=1;return;}
  if(!a.output)throw Error('New job output required');const output=path.resolve(a.output);await exclusiveDir(output);
  const assets=new Map(),errors=[],report={schemaVersion:1,status:'RUNNING',spec,sourceBefore:await fingerprint(spec.source.root,spec.source.files),userAccepted:false,framesViewed:false,subjectiveVisualReviewed:false,subjectiveAudioReviewed:false,errors};
  let session;
  try{
    await fs.writeFile(path.join(output,'spec.json'),JSON.stringify(spec,null,2));
    if(spec.renderer.kind==='browser'){
      session=await browserSession(spec,cfg,errors,assets);await checkBrowser(session,spec,output,report);
      if(command==='render'){
        await fs.mkdir(path.join(output,'frames'));const count=Math.round(spec.video.duration*spec.video.fps);let next=0,failed=false;
        await Promise.all(Array.from({length:workers},async()=>{const p=await session.page();try{while(!failed){const n=next++;if(n>=count)break;await at(p,spec,n/spec.video.fps);await capture(p,spec,path.join(output,'frames',`f${n.toString().padStart(6,'0')}.png`));}}catch(e){failed=true;throw e;}finally{await p.close();}}));
        const encode=native(cfg.tools?.ffmpegCommand??'ffmpeg',['-hide_banner','-nostdin','-v','error','-n','-framerate',String(spec.video.fps),'-i',path.join(output,'frames','f%06d.png'),'-frames:v',String(count),'-an','-vf','scale=in_range=full:out_range=limited:out_color_matrix=bt709,format=yuv420p','-c:v','libx264','-preset','medium','-crf','17','-color_range','tv','-colorspace','bt709','-color_primaries','bt709','-color_trc','bt709','-movflags','+faststart',path.join(output,'encoded.mp4')]);report.encoder=encode;requireSuccess(encode);
      }
    }else{
      if(command==='check')throw Error('Command renderers require their native state checker; run render for final-file verification');
      const replacements={'{output}':path.join(output,'encoded.mp4'),'{project}':spec.source.root,'{fps}':String(spec.video.fps),'{duration}':String(spec.video.duration),'{offset}':String(spec.time?.offset??0)};
      const args=spec.renderer.args.map(v=>{let s=String(v);for(const [k,x]of Object.entries(replacements))s=s.replaceAll(k,x);return s;});
      const proc=spawnSync(spec.renderer.executable,args,{cwd:spec.source.root,encoding:'utf8',windowsHide:true,maxBuffer:12*1024*1024,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONIOENCODING:'utf-8'}});report.encoder={command:[spec.renderer.executable,...args],exitCode:proc.status,stdout:proc.stdout??'',stderr:proc.stderr??'',error:proc.error?.message??null};requireSuccess(report.encoder);
    }
    if(errors.length)throw Error('Browser errors or external requests detected');
    report.sourceAfter=await fingerprint(spec.source.root,spec.source.files);if(report.sourceBefore.sha256!==report.sourceAfter.sha256)throw Error('Source changed during this job; output is not accepted');
    if(command==='render'){const media=path.join(output,'encoded.mp4');report.video=await verifyVideo(media,spec.video,cfg.tools);if(!report.video.passed)throw Error('Final MP4 contract/decode failed');report.videoSha256=hash(await fs.readFile(media));await fs.rename(media,path.join(output,'render.mp4'));report.output=path.join(output,'render.mp4');}
    report.status=command==='render'?'TECHNICAL_RENDER_PASSED':'SOURCE_CHECK_PASSED';
  }catch(e){report.status='FAILED';report.failure=e.message;process.exitCode=1;}
  finally{if(session)await session.close();report.assets=[...assets].map(([file,sha256])=>({file,sha256}));report.coverage='Source/runtime and declared state checks plus actual MP4 specification and decode when rendered. Images require visual review; playback, audio judgment and user acceptance remain separate.';await fs.writeFile(path.join(output,'receipt.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,output:report.output??null,receipt:path.join(output,'receipt.json'),failure:report.failure??null}));}
}
