#!/usr/bin/env node
/** Offline scene graph -> exclusive new HyperFrames project. No core or paid API. */
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { assertVisibleText } from './visible-text-policy.mjs';
import { EASES, evaluateAt } from '../assets/directed-motion/evaluator.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.resolve(HERE, '../assets/directed-motion');
const DEFAULT_CONFIG = 'E:/开发项目/视频剪辑skill/config/video-workflow.json';
const DEFAULT_FONT = 'C:/Windows/Fonts/msyh.ttc';
const KINDS = ['orb','platform','gate','house','person','line','text','asset'];
const PROPS = ['x','y','rotation','scale','scaleX','scaleY','opacity','light','progress'];
function check(ok, m) { if (!ok) throw new Error(m); }
function object(v,l) { check(v && typeof v==='object' && !Array.isArray(v),`${l} must be an object`);return v; }
function keys(v,allowed,l) { for(const k of Object.keys(v))check(allowed.includes(k),`${l}: unknown field ${k}`); }
function number(v,l,min,max) { check(typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max,`${l} must be ${min}..${max}`);return v; }
function text(v,l,max=120,visible=true) { check(typeof v==='string' && v.length>0 && v.length<=max && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v),`${l} needs plain text up to ${max} characters`);if(visible)assertVisibleText(v,l);return v.normalize('NFC'); }
function color(v,l) { check(/^#[\da-f]{6}$/i.test(v),`${l} must be #RRGGBB`);return v; }
function id(v,l) { check(typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_-]{0,70}$/.test(v),`${l} needs ASCII identifier`);return v; }
function args(argv) {
  const o={};for(let i=0;i<argv.length;i++) { const k=argv[i];if(k==='--help')return{help:true};check(['--input','--output','--config','--gsap','--font'].includes(k),`Unknown flag ${k}`);check(!o[k.slice(2)],`Duplicate ${k}`);check(argv[i+1]&&!argv[i+1].startsWith('--'),`Missing ${k}`);o[k.slice(2)]=argv[++i]; }
  check(o.input&&o.output,'--input and --output are required');return o;
}
async function exists(p) { try{await fs.lstat(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;} }
const html = v=>String(v).replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[x]);
const json = v=>JSON.stringify(v).replace(/[<>&\u2028\u2029]/g,c=>`\\u${c.charCodeAt(0).toString(16).padStart(4,'0')}`);
const hash = b=>createHash('sha256').update(b).digest('hex');

// Preview UI is a separate document. Its wall-clock drives only seeks into the
// exported, paused deterministic composition and never enters index.html.
function previewPage(spec) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(spec.title)} · 源码预览</title><style>html,body{margin:0;background:#111923;color:#e7eef5;font-family:sans-serif}main{max-width:1000px;margin:0 auto;padding:20px}h1{font-size:22px;margin:0 0 14px}.viewer{position:relative;width:100%;aspect-ratio:${spec.canvas.width}/${spec.canvas.height};overflow:hidden;background:#000}iframe{position:absolute;left:0;top:0;width:${spec.canvas.width}px;height:${spec.canvas.height}px;border:0;transform-origin:0 0}.controls{display:flex;align-items:center;gap:12px;padding:14px 0;flex-wrap:wrap}button{border:1px solid #536779;border-radius:6px;padding:9px 14px;background:#26394a;color:#e7eef5;cursor:pointer}button:disabled{opacity:.4;cursor:wait}input{flex:1;min-width:180px}output{font-variant-numeric:tabular-nums;font-size:14px;white-space:nowrap}.note{font-size:14px;line-height:1.6;color:#a7bbc9}</style></head><body><main><h1>${html(spec.title)}</h1><div class="viewer" id="viewer"><iframe id="film-frame" src="index.html" title="${html(spec.title)}"></iframe></div><div class="controls"><button id="play-toggle" type="button" disabled>播放</button><button id="replay" type="button" disabled>重播</button><input id="scrubber" type="range" min="0" max="${spec.canvas.duration}" step="${1/spec.canvas.fps}" value="0" aria-label="时间" disabled><output id="position">0.00 / ${spec.canvas.duration.toFixed(2)} 秒</output></div><p class="note" id="status">正在加载本地工程…</p><p class="note">这些控件只用于源码预览，视频输出不包含它们。成片审查优先直接播放交付 MP4。</p></main><script>
  const frame=document.getElementById('film-frame'),viewer=document.getElementById('viewer'),playButton=document.getElementById('play-toggle'),replayButton=document.getElementById('replay'),slider=document.getElementById('scrubber'),position=document.getElementById('position'),status=document.getElementById('status');
  const duration=${spec.canvas.duration},fps=${spec.canvas.fps},compositionId=${json(spec.compositionId)};
  let adapter=null,currentTime=0,playing=false,raf=0,clockStart=0,playStart=0;
  function fit(){frame.style.transform='scale('+(viewer.clientWidth/${spec.canvas.width})+')';}
  new ResizeObserver(fit).observe(viewer);fit();
  function seek(value){currentTime=Math.max(0,Math.min(duration,Number(value)||0));if(adapter)adapter.seek(currentTime);slider.value=String(currentTime);position.textContent=currentTime.toFixed(2)+' / '+duration.toFixed(2)+' 秒';}
  function pause(){playing=false;cancelAnimationFrame(raf);raf=0;playButton.textContent='播放';}
  function tick(now){if(!playing)return;const t=Math.min(duration,playStart+(now-clockStart)/1000);seek(Math.floor(t*fps+1e-7)/fps);if(t>=duration){seek(duration);pause();return;}raf=requestAnimationFrame(tick);}
  function play(){if(!adapter)return;if(currentTime>=duration)seek(0);playing=true;clockStart=performance.now();playStart=currentTime;playButton.textContent='暂停';raf=requestAnimationFrame(tick);}
  function replay(){pause();seek(0);play();}
  playButton.addEventListener('click',()=>playing?pause():play());replayButton.addEventListener('click',replay);slider.addEventListener('input',()=>{pause();seek(slider.value);});
  async function attach(attempt=0){try{const child=frame.contentWindow,directed=child.__directed,timeline=child.__timelines&&child.__timelines[compositionId];if(!directed&&!timeline){if(attempt<180){requestAnimationFrame(()=>attach(attempt+1));return;}throw new Error('工程未完成初始化');}await child.document.fonts.ready;adapter={seek(t){if(directed)directed.seek(t);else{timeline.pause();timeline.totalTime(t,false);}}};seek(0);playButton.disabled=false;replayButton.disabled=false;slider.disabled=false;status.textContent='已加载：本地 HTTP 源码预览';}catch(error){status.textContent='加载失败，请使用本地 HTTP 服务打开 preview.html。'+error.message;}}
  frame.addEventListener('load',()=>attach());
  window.__preview={seek(t){pause();seek(t);},play,pause,replay,state(){return{ready:Boolean(adapter),time:currentTime,playing,duration,fps};}};
  if(location.protocol==='file:')status.textContent='请先启动本地 HTTP 服务，不能直接以 file:// 打开。';
  </script></body></html>`;
}

async function validate(raw,input,gsap,font) {
  object(raw,'input');keys(raw,['schemaVersion','compositionId','title','canvas','style','camera','nodes','tracks','captions','backgroundAsset'],'input');
  check(raw.schemaVersion===1,'schemaVersion must be 1');
  const compositionId=id(raw.compositionId??'directed-motion','compositionId');
  const title=text(raw.title??'生活的缓冲','title',120,false);
  const c=object(raw.canvas,'canvas');keys(c,['width','height','fps','duration'],'canvas');
  for(const key of ['width','height','fps','duration'])check(Object.hasOwn(c,key),`canvas.${key} is required; inherit the actual project specification explicitly`);
  const canvas={width:number(c.width,'canvas.width',320,4096),height:number(c.height,'canvas.height',240,4096),fps:number(c.fps,'canvas.fps',1,120),duration:number(c.duration,'canvas.duration',.5,600)};
  check(Number.isInteger(canvas.width)&&Number.isInteger(canvas.height)&&Number.isInteger(canvas.fps),'canvas width/height/fps must be integers');
  const style={background:'#07111C',foreground:'#EDF3F5',accent:'#F1BD71',lightX:-.6,lightY:-.8,...object(raw.style??{},'style')};keys(style,['background','foreground','accent','lightX','lightY'],'style');
  for(const k of ['background','foreground','accent'])color(style[k],`style.${k}`);for(const k of ['lightX','lightY'])number(style[k],`style.${k}`,-1,1);
  check(Math.hypot(style.lightX,style.lightY)>.1,'Main light direction cannot be zero');
  const camera={x:canvas.width/2,y:canvas.height/2,zoom:1,...object(raw.camera??{},'camera')};keys(camera,['x','y','zoom'],'camera');number(camera.x,'camera.x',-50000,50000);number(camera.y,'camera.y',-50000,50000);number(camera.zoom,'camera.zoom',.1,5);
  const assets=[];
  async function asset(value,kind) {
    check(typeof value==='string'&&value&&!value.includes('\0'),`${kind}: needs local file`);check(!/^[a-z][a-z\d+.-]*:/i.test(value)||/^[a-z]:[\\/]/i.test(value),`${kind}: URL not allowed`);
    const p=path.resolve(path.dirname(input),value),stat=await fs.stat(p);check(stat.isFile()&&stat.size>0,`${kind}: not a nonempty file`);
    const buffer=await fs.readFile(p),ext=path.extname(p).toLowerCase();
    if(kind==='image') {
      check(['.png','.jpg','.jpeg','.webp','.svg'].includes(ext),'Images must be SVG, PNG, JPEG or WebP');
      if(ext==='.svg'){
        const s=buffer.toString('utf8').replace(/<!--[\s\S]*?-->/g,'');
        check(/<svg\b/i.test(s),'SVG root missing');
        check(!/<(?:script|foreignObject|animate|animateTransform|set)\b|\bon\w+\s*=|(?:javascript:|data:|@import)|(?:href|src)\s*=\s*["'][^#"']|url\(\s*["']?(?!#)/i.test(s),'SVG cannot include active content, timed animation or external resources');
        for(const match of s.matchAll(/<(?:text|tspan|textPath)\b[^>]*>([\s\S]*?)<\/(?:text|tspan|textPath)>/gi)){
          const visible=match[1].replace(/<[^>]*>/g,'').replace(/&#x([\da-f]+);/gi,(_,hex)=>String.fromCodePoint(parseInt(hex,16))).replace(/&#(\d+);/g,(_,num)=>String.fromCodePoint(Number(num))).replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'");assertVisibleText(visible,'SVG visible text');
        }
      }else{
        check((ext==='.png'&&buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))||(['.jpg','.jpeg'].includes(ext)&&buffer[0]===255&&buffer[1]===216&&buffer[2]===255)||(ext==='.webp'&&buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WEBP'),'Raster image signature does not match extension');
      }
    }
    if(kind==='gsap')check(ext==='.js'&&/GSAP\s+\d+\.\d+\.\d+/i.test(buffer.toString('utf8')),'GSAP file banner missing');
    if(kind==='font')check(['.ttc','.ttf','.otf','.woff','.woff2'].includes(ext),'Unsupported font format');
    const digest=hash(buffer),relativePath=kind==='gsap'?'assets/gsap.min.js':`assets/${digest}${ext}`;
    const existing=assets.find(a=>a.sha256===digest);if(existing)return existing.relativePath;
    assets.push({kind,originalPath:p,relativePath,sha256:digest,bytes:stat.size,buffer});return relativePath;
  }
  await asset(gsap,'gsap');const fontAsset=await asset(font,'font');
  let backgroundAsset=null;if(raw.backgroundAsset)backgroundAsset=await asset(raw.backgroundAsset,'image');
  check(Array.isArray(raw.nodes)&&raw.nodes.length>0&&raw.nodes.length<=150,'nodes need 1..150 objects');const ids=new Set();
  const nodes=[];
  for(const [i,rawNode]of raw.nodes.entries()) {
    const l=`nodes[${i}]`,n=object(rawNode,l);keys(n,['id','kind','x','y','depth','width','height','radius','rotation','scale','scaleX','scaleY','opacity','light','progress','groundY','shadow','text','size','style','assetPath'],l);
    const node={id:id(n.id,`${l}.id`),kind:n.kind,x:number(n.x??0,`${l}.x`,-50000,50000),y:number(n.y??0,`${l}.y`,-50000,50000),depth:number(n.depth??0,`${l}.depth`,-500,1200),width:number(n.width??70,`${l}.width`,1,4096),height:number(n.height??40,`${l}.height`,1,4096),radius:number(n.radius??24,`${l}.radius`,1,1000),rotation:number(n.rotation??0,`${l}.rotation`,-36000,36000),scale:number(n.scale??1,`${l}.scale`,.01,10),scaleX:number(n.scaleX??1,`${l}.scaleX`,.01,10),scaleY:number(n.scaleY??1,`${l}.scaleY`,.01,10),opacity:number(n.opacity??1,`${l}.opacity`,0,1),light:number(n.light??.2,`${l}.light`,0,1),progress:number(n.progress??1,`${l}.progress`,0,1),groundY:number(n.groundY??n.y??0,`${l}.groundY`,-50000,50000),shadow:n.shadow??false,size:number(n.size??20,`${l}.size`,8,100),style:{color:style.accent,stroke:style.accent,...object(n.style??{},`${l}.style`)}};
    check(KINDS.includes(node.kind),`${l}.kind unsupported`);check(!ids.has(node.id),`${l}.id duplicates another node: ${node.id}`);check(node.id!=='camera',`${l}.id camera is reserved for the camera track target`);ids.add(node.id);check(typeof node.shadow==='boolean',`${l}.shadow must be boolean`);
    keys(node.style,['color','stroke'],`${l}.style`);for(const k of ['color','stroke'])color(node.style[k],`${l}.style.${k}`);
    if(node.kind==='text')node.text=text(n.text,`${l}.text`,120);else check(n.text===undefined,`${l}.text only supported by kind:text`);
    if(node.kind==='asset')node.assetPath=await asset(n.assetPath,'image');else check(n.assetPath===undefined,`${l}.assetPath only supported by kind:asset`);
    nodes.push(node);
  }
  check(Array.isArray(raw.tracks??[])&&(raw.tracks??[]).length<=1500,'tracks must be array up to 1500');const tracks=[];
  for(const[i,r]of(raw.tracks??[]).entries()){
    const l=`tracks[${i}]`;object(r,l);keys(r,['target','property','start','duration','from','to','ease','damping','frequency','velocityFrom','velocityTo'],l);
    check(r.target==='camera'||ids.has(r.target),`${l}.target unknown`);check((r.target==='camera'?['x','y','zoom']:PROPS).includes(r.property),`${l}.property unsupported`);
    const tr={target:r.target,property:r.property,start:number(r.start,`${l}.start`,0,canvas.duration),duration:number(r.duration,`${l}.duration`,.001,canvas.duration),from:number(r.from,`${l}.from`,-50000,50000),to:number(r.to,`${l}.to`,-50000,50000),ease:r.ease??'smooth'};
    check(tr.start+tr.duration<=canvas.duration+1e-7,`${l} exceeds duration`);check(EASES.includes(tr.ease),`${l}.ease unsupported`);
    if(['opacity','light','progress'].includes(tr.property))for(const k of['from','to'])number(tr[k],`${l}.${k}`,0,1);
    if(['scale','scaleX','scaleY','zoom'].includes(tr.property))for(const k of['from','to'])number(tr[k],`${l}.${k}`, .05,10);
    if(tr.ease==='spring'){tr.damping=number(r.damping??7,`${l}.damping`,3,20);tr.frequency=number(r.frequency??12,`${l}.frequency`,2,30);}else check(r.damping===undefined&&r.frequency===undefined,`${l}: spring parameters require spring`);
    if(tr.ease==='hermite'){tr.velocityFrom=number(r.velocityFrom??0,`${l}.velocityFrom`,-50000,50000);tr.velocityTo=number(r.velocityTo??0,`${l}.velocityTo`,-50000,50000);}else check(r.velocityFrom===undefined&&r.velocityTo===undefined,`${l}: velocity parameters require hermite`);
    tracks.push(tr);
  }
  tracks.sort((a,b)=>a.target.localeCompare(b.target)||a.property.localeCompare(b.property)||a.start-b.start);
  const last=new Map();for(const tr of tracks){const k=`${tr.target}.${tr.property}`,p=last.get(k);if(p){check(tr.start>=p.start+p.duration-1e-7,`Overlapping tracks ${k}`);check(Math.abs(tr.from-p.to)<1e-6,`Discontinuous endpoint ${k}: ${tr.from} != ${p.to}`);if(Math.abs(tr.start-(p.start+p.duration))<1e-7&&p.ease==='hermite'&&tr.ease==='hermite')check(Math.abs(p.velocityTo-tr.velocityFrom)<1e-6,`Discontinuous flight velocity ${k}`);}else{const base=tr.target==='camera'?camera:nodes.find(n=>n.id===tr.target);check(Math.abs(tr.from-base[tr.property])<1e-6,`First track does not match base ${k}`);}last.set(k,tr);}
  check(Array.isArray(raw.captions??[])&&(raw.captions??[]).length<=100,'captions needs array up to 100');const captions=(raw.captions??[]).map((r,i)=>{const l=`captions[${i}]`;object(r,l);keys(r,['text','start','duration','x','y','width','size','color'],l);const c={text:text(r.text,`${l}.text`,80),start:number(r.start,`${l}.start`,0,canvas.duration),duration:number(r.duration,`${l}.duration`,.2,canvas.duration),x:number(r.x??canvas.width/2,`${l}.x`,0,canvas.width),y:number(r.y??canvas.height-43,`${l}.y`,0,canvas.height),width:number(r.width??canvas.width-80,`${l}.width`,20,canvas.width),size:number(r.size??25,`${l}.size`,12,60),color:color(r.color??style.foreground,`${l}.color`)};check(c.start+c.duration<=canvas.duration+1e-7,`${l} exceeds duration`);for(const line of c.text.split('\n'))check(Array.from(line).length*c.size<=c.width,`${l}: estimated text line exceeds width; use newline or smaller font`);return c;});
  // Validate the actual HTML/SVG ID set, rather than banning broad prefixes.
  // node IDs also coexist with generated gradient and caption IDs in one DOM.
  const domIds=new Map();
  const addDomId=(value,owner)=>{const owners=domIds.get(value)??[];owners.push(owner);domIds.set(value,owners);};
  addDomId(compositionId,'compositionId');addDomId('stage','SVG stage');addDomId('soft-light','blur filter');
  nodes.forEach((node,i)=>{addDomId(node.id,`nodes[${i}].id`);addDomId(`light-${node.id}`,`nodes[${i}] gradient`);});
  captions.forEach((_,i)=>addDomId(`caption-${i}`,`captions[${i}] group`));
  const collisions=[...domIds].filter(([,owners])=>owners.length>1);
  check(collisions.length===0,`DOM ID collision: ${collisions.map(([value,owners])=>`${value} (${owners.join(' / ')})`).join('; ')}`);
  const spec={schemaVersion:1,compositionId,title,canvas,style,camera,nodes,tracks,captions,backgroundAsset};
  // Catch authored spring overshoots that would create invalid scale/NaN in actual sampling.
  for(let i=0;i<=Math.ceil(canvas.duration*canvas.fps);i++){const s=evaluateAt(spec,Math.min(canvas.duration,i/canvas.fps));for(const n of Object.values(s.nodes))check(n.scale>0&&n.scaleX>0&&n.scaleY>0&&Object.values(n).filter(v=>typeof v==='number').every(Number.isFinite),`Invalid evaluated node ${n.id} at frame ${i}`);check(s.camera.zoom>0&&Object.values(s.camera).every(Number.isFinite),`Invalid camera at ${i}`);}
  return{spec,assets,fontAsset};
}
async function main(){const a=args(process.argv.slice(2));if(a.help){console.log('build-directed-motion.mjs --input local-scene.json --output NEW_DIRECTORY [--config WORKSPACE_CONFIG] [--gsap LOCAL_JS] [--font LOCAL_FONT]');return;}
  const input=path.resolve(a.input),output=path.resolve(a.output);check(!await exists(output),`Output already exists: ${output}`);
  let config={};if(a.config||!a.gsap||!a.font){const configPath=path.resolve(a.config??DEFAULT_CONFIG);try{config=JSON.parse(await fs.readFile(configPath,'utf8'));}catch(e){throw new Error(`Cannot read workspace runtime configuration ${configPath}: ${e.message}. Use --config or explicit --gsap and --font.`);}}
  const gsap=a.gsap??config.render?.motionGsapPath;check(typeof gsap==='string'&&gsap,'Configured render.motionGsapPath is missing; set workspace config or pass --gsap LOCAL_JS');
  const font=a.font??config.render?.motionFontPath??DEFAULT_FONT;
  const raw=JSON.parse(await fs.readFile(input,'utf8'));const {spec,assets,fontAsset}=await validate(raw,input,path.resolve(gsap),path.resolve(font));
  const staging=path.join(path.dirname(output),`.directed-stage-${randomUUID()}`);await fs.mkdir(path.join(staging,'assets'),{recursive:true});
  try{
    for(const asset of assets)await fs.writeFile(path.join(staging,asset.relativePath),asset.buffer,{flag:'wx'});
    await fs.copyFile(path.join(SOURCE,'evaluator.mjs'),path.join(staging,'assets/evaluator.mjs'));
    await fs.copyFile(path.join(SOURCE,'player.mjs'),path.join(staging,'assets/player.mjs'));
    const page=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(spec.title)}</title><style>@font-face{font-family:DirectedLocal;src:url('${fontAsset}')}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:${spec.style.background}}#${spec.compositionId}{position:relative;width:${spec.canvas.width}px;height:${spec.canvas.height}px;overflow:hidden}svg{display:block;font-family:DirectedLocal,sans-serif}*{box-sizing:border-box}</style></head><body><main id="${spec.compositionId}" data-composition-id="${spec.compositionId}" data-start="0" data-duration="${spec.canvas.duration}" data-width="${spec.canvas.width}" data-height="${spec.canvas.height}"><svg id="stage" xmlns="http://www.w3.org/2000/svg" width="${spec.canvas.width}" height="${spec.canvas.height}" viewBox="0 0 ${spec.canvas.width} ${spec.canvas.height}"></svg></main><script src="assets/gsap.min.js"></script><script>window.__timelines = window.__timelines || {};</script><script type="module">import {initialize} from './assets/player.mjs';initialize(${json(spec)});</script></body></html>`;
    await fs.writeFile(path.join(staging,'index.html'),page,{flag:'wx'});
    await fs.writeFile(path.join(staging,'preview.html'),previewPage(spec),{flag:'wx'});
    await fs.writeFile(path.join(staging,'scene.json'),JSON.stringify(spec,null,2)+'\n',{flag:'wx'});
    await fs.writeFile(path.join(staging,'input-original.json'),JSON.stringify(raw,null,2)+'\n',{flag:'wx'});
    const manifest={kind:'directed-motion-asset-manifest',compositionId:spec.compositionId,canvas:spec.canvas,offline:true,audio:'none',renderer:'hyperframes',assets:assets.map(({buffer,...rest})=>rest),capabilities:['independent-local-time-tracks','persistent-object-identities','2d-depth-camera-projection','deterministic-gravity-spring-hermite','local-light-and-shadow'],limitations:['no-3d-physics','no-automatic-directing','no-audio','no-core-state-mutation']};
    await fs.writeFile(path.join(staging,'asset-manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
    await fs.writeFile(path.join(staging,'README.md'),`# ${spec.title}\n\n离线动态图形工程，${spec.canvas.width}×${spec.canvas.height}，${spec.canvas.fps}fps，${spec.canvas.duration}秒。音轨：无。成片审查优先直接播放交付 MP4。运行资源均在本工程内。状态说明和素材来源留在交付文档，不绘制在视频。\n\n## 源码预览\n\n不能双击以 file:// 打开 HTML，浏览器会阻止本工程的 ES 模块。请用已安装的 Python 3.12 内置本地 HTTP 服务提供本工程，再打开独立的 preview.html；它在 iframe 外提供播放、暂停、重播和时间滑块，控件不会写入 index.html 或视频帧。\n\n\`\`\`powershell\n& "C:/Users/MSN/AppData/Local/Programs/Python/Python312/python.exe" -m http.server 3108 --bind 127.0.0.1 --directory "${output.split(path.sep).join('/')}"\n\`\`\`\n\n在浏览器打开 http://127.0.0.1:3108/preview.html 。命令在当前终端前台运行，结束时 Ctrl+C。工作区外依照实际本地工具选择已验证的 HTTP 服务，不假定有上述 Python 路径。HyperFrames Studio 在本机仅证实服务可启动，UI 加载未通过验收，不作为本交付的可用预览入口。构建器不会安装、后台启动或发布服务。\n\npreview.html 的浏览器时钟只负责预览进度，按帧定位暂停的确定性工程；index.html、evaluator 和导出时间轴不读取它。运行时窗口 __directed.seek(t) 可定位，最终渲染使用有限暂停 GSAP 时间轴。字幕、图形与运动来自 input-original.json。2D光影与分层投影是艺术近似，不是真实物理解算。工程不管理既有核心项目状态；事实与创意核对、浏览器动作前中后与反向定位检查、最终MP4解码和观看应分别记录。技术检查通过不代表用户成片确认。\n`,{flag:'wx'});
    // Rename is exclusive at the caller level; a competing output creator is checked again.
    check(!await exists(output),`Output was created concurrently: ${output}`);await fs.rename(staging,output);
  }catch(e){console.error(`Build failed; staging retained for inspection: ${staging}`);throw e;}
  console.log(JSON.stringify({ok:true,output,index:path.join(output,'index.html'),duration:spec.canvas.duration,nodes:spec.nodes.length,tracks:spec.tracks.length,audio:'none',networkUsed:false},null,2));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
