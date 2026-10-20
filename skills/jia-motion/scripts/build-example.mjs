import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../assets');
const check=(ok,message)=>{if(!ok)throw new Error(message);};
const sha=b=>createHash('sha256').update(b).digest('hex');
async function exists(p){try{await fs.lstat(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
function args(argv){
  const a={};for(let i=0;i<argv.length;i++){
    if(argv[i]==='--help')return {help:true};
    check(['--kind','--output','--width','--height','--fps','--duration','--config','--gsap','--font'].includes(argv[i]),`Unknown argument ${argv[i]}`);
    const key=argv[i].slice(2);check(!Object.hasOwn(a,key)&&argv[i+1]&&!argv[i+1].startsWith('--'),`Invalid ${argv[i]}`);a[key]=argv[++i];
  }return a;
}
function preview(spec){return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${spec.title}</title><style>body{margin:0;padding:24px;background:#18222b;color:#f1efe8;font-family:Arial,sans-serif}main{max-width:1100px;margin:auto}.screen{width:100%;aspect-ratio:16/9;overflow:hidden;position:relative}iframe{border:0;position:absolute;transform-origin:0 0;width:${spec.width}px;height:${spec.height}px}.controls{display:flex;gap:14px;padding:20px 0;align-items:center}input{flex:1}button{padding:10px 18px;border:0;background:#ff6845;border-radius:5px;font:inherit}</style><main><div class="screen"><iframe src="index.html" id="film"></iframe></div><div class="controls"><button id="play">播放</button><input id="time" aria-label="时间" type="range" min="0" max="${spec.duration}" step="${1/spec.fps}" value="0"><output id="read">0.00s</output></div><p>源码预览控件不会进入成片；无配乐，动作与工程验证待本人复核。</p></main><script>const f=document.querySelector('#film'),slider=document.querySelector('#time'),button=document.querySelector('#play'),read=document.querySelector('#read');let playing=false,t=0,last=0;const duration=${spec.duration};new ResizeObserver(()=>f.style.transform='scale('+(f.parentElement.clientWidth/${spec.width})+')').observe(f.parentElement);function seek(v){t=Math.max(0,Math.min(duration,v));f.contentWindow.__jiaMotion?.seek(t);slider.value=t;read.value=t.toFixed(2)+'s';}function tick(now){if(playing){t+=(now-last)/1000;if(t>=duration){t=duration;playing=false;button.textContent='播放';}seek(t);}last=now;requestAnimationFrame(tick);}button.onclick=()=>{if(!f.contentWindow.__jiaMotion?.ready)return;if(t>=duration)seek(0);playing=!playing;button.textContent=playing?'暂停':'播放';};slider.oninput=()=>{playing=false;button.textContent='播放';seek(Number(slider.value));};requestAnimationFrame(tick);</script></html>`;}
async function main(){
  const a=args(process.argv.slice(2));if(a.help){console.log('build-example.mjs --kind ui|carry --output NEW_DIR --width W --height H --fps FPS --duration SECONDS [--config FILE] [--gsap FILE] [--font FILE]');return;}
  for(const key of ['kind','output','width','height','fps','duration'])check(Object.hasOwn(a,key),`--${key} is required`);
  check(['ui','carry'].includes(a.kind),'kind must be ui or carry');
  const width=Number(a.width),height=Number(a.height),fps=Number(a.fps),duration=Number(a.duration);
  check(Number.isInteger(width)&&Number.isInteger(height)&&width>=640&&width<=3840&&height>=360&&height<=2160&&width*9===height*16,'Example layout requires 16:9, 640x360 through 3840x2160; redesign other aspects');
  check(Number.isInteger(fps)&&fps>=1&&fps<=120&&Number.isFinite(duration)&&duration>=3&&duration<=12,'fps 1..120 and duration 3..12 required');
  const output=path.resolve(a.output);check(!await exists(output),`Output already exists: ${output}`);
  let config={};if(a.config||!a.gsap||!a.font)config=JSON.parse(await fs.readFile(a.config??'E:/开发项目/视频剪辑skill/config/video-workflow.json','utf8'));
  const gsap=path.resolve(a.gsap??config.render?.motionGsapPath??''),font=path.resolve(a.font??config.render?.motionFontPath??'C:/Windows/Fonts/msyh.ttc');
  const gsapBytes=await fs.readFile(gsap),fontBytes=await fs.readFile(font);
  check(/GSAP\s+\d+\.\d+\.\d+/i.test(gsapBytes.toString('utf8')),'GSAP banner missing');
  check(fontBytes.length>0&&['.ttc','.ttf','.otf','.woff','.woff2'].includes(path.extname(font).toLowerCase()),'Unsupported or empty font');
  const spec={schemaVersion:1,id:`jia-motion-${a.kind}`,kind:a.kind,title:a.kind==='ui'?'让操作推动变化':'让对象带出下一幕',width,height,fps,duration,audio:'none',userAccepted:false};
  await fs.mkdir(path.dirname(output),{recursive:true});await fs.mkdir(output);await fs.mkdir(path.join(output,'assets'));
  for(const file of ['motion.mjs','scenes.mjs'])await fs.copyFile(path.join(source,file),path.join(output,'assets',file));
  const fontName='local-font'+path.extname(font).toLowerCase();
  await fs.writeFile(path.join(output,'assets/gsap.min.js'),gsapBytes,{flag:'wx'});await fs.writeFile(path.join(output,'assets',fontName),fontBytes,{flag:'wx'});
  const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${spec.title}</title><style>@font-face{font-family:MotionLocal;src:url('assets/${fontName}')}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#f1efe8}*{box-sizing:border-box}svg{display:block;font-family:MotionLocal,sans-serif}#${spec.id}{width:${width}px;height:${height}px;position:relative;overflow:hidden}</style></head><body><main id="${spec.id}" data-composition-id="${spec.id}" data-start="0" data-duration="${duration}" data-width="${width}" data-height="${height}"><svg id="stage" xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 1280 720"></svg></main><script id="motion-spec" type="application/json">${JSON.stringify(spec)}</script><script src="assets/gsap.min.js"></script><script>window.__timelines=window.__timelines||{};</script><script type="module" src="assets/scenes.mjs"></script></body></html>`;
  await fs.writeFile(path.join(output,'index.html'),html,{flag:'wx'});await fs.writeFile(path.join(output,'preview.html'),preview(spec),{flag:'wx'});
  await fs.writeFile(path.join(output,'scene.json'),JSON.stringify(spec,null,2),{flag:'wx'});
  const resources={offline:true,audio:'none',fpsRequested:fps,exportFpsMustBeVerified:true,thirdParty:[{path:'assets/gsap.min.js',source:gsap,sha256:sha(gsapBytes)},{path:`assets/${fontName}`,source:font,sha256:sha(fontBytes)}],originalCode:['assets/motion.mjs','assets/scenes.mjs'],userAccepted:false};
  await fs.writeFile(path.join(output,'resources.json'),JSON.stringify(resources,null,2),{flag:'wx'});
  await fs.writeFile(path.join(output,'README.md'),`# ${spec.title}\n\n可修改的动作验证工程，${width}×${height}，请求${fps}fps，${duration}秒；无音轨。源码与字体已复制进本项目。preview.html需本地HTTP，控件不进入输出。\n\n使用已配置jia-director的run-video.ps1 render输出；当前默认导出30fps。其他帧率需显式传给实际后端，并以最终ffprobe核对，不能仅凭scene.json称规格通过。\n\n这是局部工程验证，不是获本人接受的风格配方。字体与GSAP按原许可在本机使用，未随Skill包分发。\n`,{flag:'wx'});
  console.log(JSON.stringify({ok:true,output,...spec}));
}
main().catch(e=>{console.error(e.stack??e.message);process.exitCode=1;});
