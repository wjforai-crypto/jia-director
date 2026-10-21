// Local stage orchestration. Frozen exports are the only downstream inputs.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, mkdir, readdir, copyFile, stat, lstat, open, unlink, rename } from 'node:fs/promises';
import { resolve, join, dirname, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizeSegments, createMapping, parseSrt, remapSrt, makePlan, renderPlan } from './fine-cut.mjs';
import { assertVisibleText } from '../skill-src/jia-video/scripts/visible-text-policy.mjs';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = join(ROOT, 'config/video-workflow.json');
const check = (v, m) => { if (!v) throw new Error(m); };
const json = v => JSON.stringify(v, null, 2) + '\n';
const load = async p => JSON.parse((await readFile(p, 'utf8')).replace(/^\uFEFF/, ''));
const hash = async p => { const h = createHash('sha256'); for await (const b of createReadStream(p)) h.update(b); return h.digest('hex'); };
const safeId = v => { check(typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(v), '无效版本或素材 ID'); return v; };
const newJson = (p,v) => writeFile(p,json(v),{flag:'wx'});
async function maybe(p) { try { return await load(p); } catch(e) { if(e.code==='ENOENT')return null; throw e; } }
export function runLocal(cmd,args,{cwd,maxBytes=8*1024*1024}={}) {
  return new Promise((yes,no)=>{
    const env={...process.env,HF_HUB_OFFLINE:'1',DO_NOT_TRACK:'1'};
    for(const k of Object.keys(env))if(/(MINIMAX|FISH).*KEY/i.test(k))delete env[k];
    const child=spawn(cmd,args,{cwd,env,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
    let out='',err='',failed;
    child.stdout.on('data',b=>{out+=b;if(Buffer.byteLength(out)>maxBytes){failed=new Error('本地工具输出过大');child.kill();}});
    child.stderr.on('data',b=>{err=(err+b).slice(-6000);});
    child.once('error',no);child.once('close',code=>code===0&&!failed?yes(out):no(failed??new Error(`${cmd} exit ${code}: ${err}`)));
  });
}
async function locked(dir,fn){
  await mkdir(join(dir,'stages'),{recursive:true});const p=join(dir,'stages','.write.lock');let lock;
  try{lock=await open(p,'wx');}catch(e){if(e.code==='EEXIST')throw new Error('另一个阶段操作正在写入，请稍后');throw e;}
  try{return await fn();}finally{await lock.close();await unlink(p);}
}
async function atomic(p,v){const tmp=p+'.'+randomUUID();await newJson(tmp,v);await rename(tmp,p);}
async function verifyBinding(dir,b){
  check(b&&['rough','fine'].includes(b.stage),'需要固定的粗剪或精剪版本');safeId(b.id);
  const folder=join(dir,b.stage==='rough'?'exports':'stages/fine-exports',b.id);
  const paths={video:join(folder,b.stage+'.mp4'),srt:join(folder,b.stage+'.srt'),mapping:join(folder,'mapping.json')};
  for(const key of Object.keys(paths))check(await hash(paths[key])===b.hashes[key],`${b.stage} ${key} 已改变，请重新选择来源版本`);
  return paths;
}
async function bind(dir,stage,id){
  safeId(id);const folder=join(dir,stage==='rough'?'exports':'stages/fine-exports',id);
  const paths={video:join(folder,stage+'.mp4'),srt:join(folder,stage+'.srt'),mapping:join(folder,'mapping.json')};
  const mapping=await load(paths.mapping),receipt=await load(join(folder,'receipt.json'));
  if(stage==='rough'){
    const handoff=await load(join(folder,'fine-cut.handoff.json'));
    const hashes={video:handoff.source.sha256,srt:handoff.sourceSrt.sha256,mapping:handoff.originalToRough.sha256};
    const b={stage,id,revision:receipt.revision,fps:mapping.fps,frameCount:mapping.outputFrames,width:mapping.source.width,height:mapping.source.height,hashes};
    await verifyBinding(dir,b);return b;
  }
  check(receipt.kind==='fine-cut-stage-receipt'&&receipt.qaPassed,'需要通过技术检查的本地精剪');
  const b={stage,id,revision:receipt.revision,...receipt.media,hashes:receipt.hashes};await verifyBinding(dir,b);return b;
}
export function validateFine(state,segments){
  const base=state.binding;check(base?.stage==='rough','精剪必须绑定粗剪');
  const normalized=normalizeSegments({scope:'technical-edge-refinement',segments},base.frameCount);
  const map=createMapping(normalized,base.fps);return {segments:normalized,mapping:map,frameCount:map.at(-1).fineEndFrameExclusive};
}
export function validateVisual(state,items,assets){
  check(state.binding?.stage==='fine','补图必须绑定精剪');check(Array.isArray(items)&&items.length<=80,'最多 80 个补图片段');
  const ids=new Set();const normalized=items.map(item=>{
    safeId(item.id);check(!ids.has(item.id),'补图 ID 重复');ids.add(item.id);
    check(Number.isInteger(item.startFrame)&&Number.isInteger(item.endFrame)&&item.startFrame>=0&&item.endFrame>item.startFrame&&item.endFrame<=state.binding.frameCount,'补图区间必须位于精剪帧时钟内');
    check(['corner','lower-right','full'].includes(item.placement),'补图位置须为 corner/lower-right/full');check(['still','push'].includes(item.motion),'图片动作为 still/push');
    check(typeof item.prompt==='string'&&item.prompt.length<=2000,'请提供不超过 2000 字的补图说明');
    check(item.cueId==null||Number.isInteger(item.cueId)&&item.cueId>0,'台词 ID 必须为实际字幕序号');
    check(!item.assetId||assets.some(a=>a.id===item.assetId),'素材尚未登记');
    const asset=assets.find(a=>a.id===item.assetId);
    if(asset?.kind==='video')check(asset.duration+.5/state.binding.fps>=(item.endFrame-item.startFrame)/state.binding.fps,'视频素材短于所选区间，请缩短区间或另选素材');
    return {id:item.id,startFrame:item.startFrame,endFrame:item.endFrame,placement:item.placement,motion:item.motion,prompt:item.prompt,assetId:item.assetId??null,cueId:item.cueId??null};
  });
  const ordered=[...normalized].sort((a,b)=>a.startFrame-b.startFrame);
  for(let i=1;i<ordered.length;i++)check(ordered[i].startFrame>=ordered[i-1].endFrame,'补图时间重叠，请调整区间，避免多个素材互相遮挡');
  return normalized;
}
export async function stageState(dir){
  dir=resolve(dir);const fine=await maybe(join(dir,'stages/fine.json')),visual=await maybe(join(dir,'stages/visual.json'));
  const assets=(await maybe(join(dir,'stages/assets.json')))?.assets??[];
  const exports={fine:[],visual:[]};
  for(const s of ['fine','visual']){try{for(const id of await readdir(join(dir,'stages',s+'-exports'))){const r=await maybe(join(dir,'stages',s+'-exports',id,'receipt.json'));if(r?.qaPassed)exports[s].push({id,revision:r.revision,binding:r.binding,duration:r.media.frameCount/r.media.fps});}}catch(e){if(e.code!=='ENOENT')throw e;}exports[s].sort((a,b)=>b.id.localeCompare(a.id));}
  let fineCues=[],visualCues=[];
  if(fine){const p=await verifyBinding(dir,fine.binding);fineCues=parseSrt(await readFile(p.srt,'utf8'),fine.binding.frameCount/fine.binding.fps);}
  if(visual){const p=await verifyBinding(dir,visual.binding);visualCues=parseSrt(await readFile(p.srt,'utf8'),visual.binding.frameCount/visual.binding.fps);}
  const roughEdits=await load(join(dir,'edits.json'));
  return {fine,visual,assets,exports,fineCues,visualCues,roughRevision:roughEdits.revision,fineUpstreamChanged:Boolean(fine&&fine.binding.revision!==roughEdits.revision),visualUpstreamChanged:Boolean(visual&&fine&&(visual.binding.id!==exports.fine.find(e=>e.binding.id===fine.binding.id&&e.revision===fine.revision)?.id)),projectDir:dir};
}
export async function selectStage(dir,stage,id,revision){return locked(dir,async()=>{
  check(['fine','visual'].includes(stage),'阶段不支持');const p=join(dir,'stages',stage+'.json'),old=await maybe(p);
  check((old?.revision??-1)===revision,'STALE_REVISION: 阶段已被另一个窗口修改');
  const binding=await bind(dir,stage==='fine'?'rough':'fine',id);let initial=[];
  if(stage==='fine'){const mapping=await load((await verifyBinding(dir,binding)).mapping);initial=mapping.keeps.map((k,i)=>({id:`clip-${i+1}`,startFrame:k.outputStartFrame,endFrameExclusive:k.outputEndFrame,reason:'保留粗剪切点，等待听审'}));}
  const next={schemaVersion:1,kind:stage+'-review',revision:(old?.revision??-1)+1,binding,initialSegments:initial,segments:initial,items:[],burnSubtitles:true,savingIsUserApproval:false};
  await atomic(p,next);return stageState(dir);
});}
export async function saveStage(dir,stage,data){return locked(dir,async()=>{
  check(['fine','visual'].includes(stage),'阶段不支持');const p=join(dir,'stages',stage+'.json'),state=await load(p);
  check(state.revision===data.revision,'STALE_REVISION: 请刷新阶段，避免覆盖其他窗口');
  check(data.bindingId===state.binding.id,'来源版本已改变');const paths=await verifyBinding(dir,state.binding);
  let next;
  if(stage==='fine'){
    const selection=validateFine(state,data.segments),audit=remapSrt(parseSrt(await readFile(paths.srt,'utf8')),selection.mapping).audit;
    check(!audit.unmappedCueIds.length,'精剪不能删除整句台词，请返回粗剪');
    next={...state,segments:selection.segments};
  }else{
    const assets=(await maybe(join(dir,'stages/assets.json')))?.assets??[];
    check(typeof data.burnSubtitles==='boolean','字幕选项无效');const items=validateVisual(state,data.items,assets),cues=parseSrt(await readFile(paths.srt,'utf8'));
    check(items.every(i=>i.cueId==null||cues.some(c=>c.id===i.cueId)),'补图条目引用了不存在的精剪台词');next={...state,items,burnSubtitles:data.burnSubtitles};
  }
  next.revision++;await atomic(p,next);return stageState(dir);
});}
async function worker(command,dir,output,configPath=CONFIG){return JSON.parse(await runLocal(process.execPath,[fileURLToPath(import.meta.url),'worker','--command',command,'--project-dir',resolve(dir),'--output-dir',output,'--config',resolve(configPath)]));}
export async function exportStage(dir,stage,data,configPath=CONFIG){
  check(['fine','visual'].includes(stage),'阶段不支持');dir=resolve(dir);
  const folder=await locked(dir,async()=>{
    const state=await load(join(dir,'stages',stage+'.json'));check(state.revision===data.revision&&state.binding.id===data.bindingId,'STALE_REVISION: 请保存并核对当前阶段');
    await verifyBinding(dir,state.binding);const id=`r${state.revision}-${Date.now()}-${randomUUID().slice(0,8)}`;
    const out=join(dir,'stages',stage+'-exports',id);await mkdir(out,{recursive:true});await newJson(join(out,'edit.snapshot.json'),state);return out;
  });
  return {stage,outputDir:folder,...await worker(stage,dir,folder,configPath)};
}
export async function importAsset(dir,input,configPath=CONFIG){
  const source=resolve(input);check(!/^[a-z]+:\/\//i.test(input),'只接受本地素材');const ext=extname(source).toLowerCase();
  check(['.png','.jpg','.jpeg','.webp','.mp4'].includes(ext),'支持 PNG/JPG/WebP 或 MP4，不接收 HTML/SVG/可执行文件');
  const info=await lstat(source);check(info.isFile()&&info.size>0&&info.size<=1024**3,'素材必须是 1GB 内的普通文件');
  const cfg=await load(configPath),raw=JSON.parse(await runLocal(cfg.tools.ffprobeCommand,['-v','error','-protocol_whitelist','file,pipe','-show_streams','-show_format','-of','json',source]));
  const v=raw.streams.find(s=>s.codec_type==='video');check(v&&v.width>=16&&v.height>=16,'素材没有可用画面');check(v.width<=8192&&v.height<=8192,'素材尺寸过大');
  const kind=ext==='.mp4'?'video':'image',duration=kind==='video'?Number(v.duration??raw.format.duration):null;
  check(kind!=='video'||Number.isFinite(duration)&&duration>0,'无效视频时长');const before=await hash(source);
  const sidecar=await maybe(source+'.asset.json');
  const provenance=sidecar?.kind==='jia-video-selected-stock-clip'?sidecar:null;
  if(provenance)check(provenance.outputSha256===before&&Array.isArray(provenance.origins)&&provenance.origins.length>0,'素材来源记录与视频不匹配');
  return locked(dir,async()=>{
    const registry=(await maybe(join(dir,'stages/assets.json')))??{assets:[]};const id='asset-'+randomUUID();const folder=join(dir,'stages/assets');await mkdir(folder,{recursive:true});
    const dest=join(folder,id+ext);await copyFile(source,dest,1);check(await hash(dest)===before&&await hash(source)===before,'素材复制时发生改变');
    const asset={id,file:id+ext,name:source.split(/[\\/]/).at(-1),kind,duration,width:v.width,height:v.height,sha256:before,sourcePath:source,audioUsed:false};
    if(provenance){asset.provenance=provenance;await newJson(join(folder,id+'.asset.json'),provenance);}
    registry.assets.push(asset);await atomic(join(dir,'stages/assets.json'),registry);return asset;
  });
}
export async function createTask(dir,data){return locked(dir,async()=>{
  const state=await load(join(dir,'stages/visual.json'));check(state.revision===data.revision&&state.binding.id===data.bindingId,'STALE_REVISION: 先保存补图编辑');await verifyBinding(dir,state.binding);
  const id='task-'+randomUUID(),folder=join(dir,'stages/tasks',id);await mkdir(folder,{recursive:true});
  const file=join(folder,'task.json'),instructions=join(folder,'给Codex的任务.md');
  const tasks=state.items.filter(i=>!i.assetId);check(tasks.length,'没有待制作的补图条目');
  const packet={kind:'local-visual-asset-task',schemaVersion:1,id,binding:state.binding,visualRevision:state.revision,fps:state.binding.fps,tasks,delivery:{kind:'local-visual-asset-results',taskId:id,bindingId:state.binding.id,results:tasks.map(t=>({itemId:t.id,path:'替换为实际本地 PNG 或 MP4 路径'}))},constraints:{imageGenerator:'builtin-image_gen',codeMotion:'local-directed-motion-or-HyperFrames',excludedProviders:['ChatCut','MiniMax'],originalAudio:true,remoteAudioUpload:false,visibleProductionLabels:false,coreStateWritten:false}};
  await newJson(file,packet);
  await writeFile(instructions,`请执行这个本地补图任务：${file}\n\n先读任务和绑定精剪，按句意判断 B-roll/MG；关系、态度、情绪和结论优先保留人物。图像用内置 image_gen，代码动效用已配置的本地 HyperFrames/GSAP。不要使用 ChatCut 或 MiniMax，不上传录音，不加制作状态标签。未完成的任务不写成已生成。\n\n完成后把 task.json 中 delivery 结构另存为 results.json，只填实际文件路径。再运行：\n\nnode "${join(ROOT,'scripts/review-stages.mjs')}" import-results --project-dir "${resolve(dir)}" --input "<results.json实际路径>"\n\n最后在面板刷新素材，预览并导出。状态与来源记在文件中，不能加到画面。\n`,{flag:'wx'});
  return {id,file,instructions,count:tasks.length};
});}
export async function importResults(dir,input,configPath=CONFIG){
  const results=await load(resolve(input));check(results.kind==='local-visual-asset-results','素材结果格式不支持');safeId(results.taskId);
  const task=await load(join(dir,'stages/tasks',results.taskId,'task.json')),current=await load(join(dir,'stages/visual.json'));
  check(results.bindingId===task.binding.id&&current.binding.id===task.binding.id&&current.revision===task.visualRevision,'任务对应的精剪或补图编辑已改变，请重新派发');
  check(Array.isArray(results.results)&&results.results.length>0,'结果不能为空');const seen=new Set(),mapped=[];
  for(const r of results.results){check(task.tasks.some(t=>t.id===r.itemId)&&!seen.has(r.itemId),'未知或重复任务条目');seen.add(r.itemId);const asset=await importAsset(dir,r.path,configPath);mapped.push({itemId:r.itemId,asset});}
  return locked(dir,async()=>{
    const now=await load(join(dir,'stages/visual.json'));check(now.revision===task.visualRevision&&now.binding.id===task.binding.id,'STALE_REVISION: 登记期间编辑已改变，素材已保留但未绑定');
    const assets=(await load(join(dir,'stages/assets.json'))).assets;
    now.items=validateVisual(now,now.items.map(i=>({...i,assetId:mapped.find(m=>m.itemId===i.id)?.asset.id??i.assetId})),assets);now.revision++;
    await atomic(join(dir,'stages/visual.json'),now);return stageState(dir);
  });
}
export async function makeMotionAsset(dir,data,configPath=CONFIG){
  const state=await load(join(dir,'stages/visual.json'));check(state.revision===data.revision&&state.binding.id===data.bindingId,'STALE_REVISION: 先保存补图编辑');
  check(['flow'].includes(data.preset),'本地示例仅提供关系传递动效');
  const left=assertVisibleText(data.left,'左侧对象'),right=assertVisibleText(data.right,'右侧对象');check(left.length>0&&left.length<=16&&right.length>0&&right.length<=16,'对象名称需为 1–16 字');
  const cfg=await load(configPath),id='motion-'+randomUUID(),folder=join(dir,'stages/motion',id);await mkdir(folder,{recursive:true});
  const spec={schemaVersion:1,compositionId:'flow',title:'关系传递',canvas:{width:640,height:360,fps:Math.round(state.binding.fps),duration:4},style:{background:'#101F26',foreground:'#E7F0ED',accent:'#A6E2CF'},nodes:[
    {id:'source',kind:'orb',x:145,y:160,radius:35,style:{color:'#42695F'}},{id:'target',kind:'orb',x:495,y:160,radius:42,scale:1,style:{color:'#31545D'}},
    {id:'path',kind:'line',x:180,y:160,width:274,height:2,progress:0,style:{stroke:'#81BBA8'}},
    {id:'resource',kind:'orb',x:145,y:160,radius:12,opacity:0,style:{color:'#F1BC72'}},
    {id:'label-left',kind:'text',x:145,y:232,text:left,size:26},{id:'label-right',kind:'text',x:495,y:244,text:right,size:26}
  ],tracks:[
    {target:'path',property:'progress',start:.2,duration:.8,from:0,to:1,ease:'smooth'},
    {target:'resource',property:'opacity',start:.5,duration:.3,from:0,to:1,ease:'smooth'},
    {target:'resource',property:'x',start:.8,duration:1.8,from:145,to:495,ease:'hermite',velocityFrom:0,velocityTo:0},
    {target:'resource',property:'opacity',start:2.6,duration:.3,from:1,to:0,ease:'smooth'},
    {target:'target',property:'scale',start:2.6,duration:.6,from:1,to:1.12,ease:'spring'},
    {target:'target',property:'scale',start:3.2,duration:.6,from:1.12,to:1,ease:'smooth'}
  ]};
  await newJson(join(folder,'motion.json'),spec);const project=join(folder,'source');
  await runLocal(process.execPath,[join(ROOT,'skill-src/jia-video/scripts/build-directed-motion.mjs'),'--input',join(folder,'motion.json'),'--output',project,'--config',resolve(configPath)]);
  const output=join(folder,'motion.mp4');
  await runLocal('pwsh',['-NoProfile','-File',join(ROOT,'scripts/video.ps1'),'-Command','render','-ProjectDir',project,'-OutputPath',output]);
  const asset=await importAsset(dir,output,configPath);return {asset,sourceDir:project,creativeAcceptanceCompleted:false};
}
async function fineWorker(dir,out){
  const state=await load(join(out,'edit.snapshot.json')),paths=await verifyBinding(dir,state.binding);
  const selection=validateFine(state,state.segments),cuts=join(out,'cuts.json'),planPath=join(out,'plan.json');
  await newJson(cuts,{scope:'technical-edge-refinement',segments:selection.segments});
  const plan=await makePlan({input:paths.video,cuts,output:planPath,sourceSrt:paths.srt});
  const rendered=await renderPlan({plan:planPath,reviewedPlanSha256:plan.sha256,output:join(out,'fine.mp4'),srt:join(out,'fine.srt'),mapping:join(out,'mapping.json'),qa:join(out,'qa.json'),receipt:join(out,'render.receipt.json')});
  await verifyBinding(dir,state.binding);
  const hashes={video:await hash(join(out,'fine.mp4')),srt:await hash(join(out,'fine.srt')),mapping:await hash(join(out,'mapping.json'))};
  const media={fps:state.binding.fps,frameCount:rendered.frames,width:state.binding.width,height:state.binding.height};
  await copyFile(paths.mapping,join(out,'original-to-rough.json'),1);
  const receipt={kind:'fine-cut-stage-receipt',revision:state.revision,binding:state.binding,media,hashes,qaPassed:rendered.qaPassed,renderPlanDigest:plan.sha256,planDigestSource:'explicit-export-of-saved-panel-selection',subjectiveListeningCompleted:false,userApprovalRecorded:false,coreStateWritten:false,providersUsed:['local-ffmpeg']};
  await newJson(join(out,'receipt.json'),receipt);return {id:out.split(/[\\/]/).at(-1),media,qaPassed:true};
}
async function visualWorker(dir,out,configPath){
  const state=await load(join(out,'edit.snapshot.json')),cfg=await load(configPath),paths=await verifyBinding(dir,state.binding);
  const registry=(await maybe(join(dir,'stages/assets.json')))?.assets??[],items=validateVisual(state,state.items,registry);
  check(items.length&&items.every(i=>i.assetId),'请先为每个补图条目选择实际素材');
  const {fps,frameCount,width,height}=state.binding,duration=frameCount/fps;
  await mkdir(join(out,'assets'));await copyFile(paths.srt,join(out,'visual.srt'),1);await copyFile(paths.mapping,join(out,'mapping.json'),1);
  const originalMapping=join(dirname(paths.video),'original-to-rough.json');await copyFile(originalMapping,join(out,'original-to-rough.json'),1);
  const assets=[],args=['-nostdin','-v','error','-n','-protocol_whitelist','file,pipe','-i',paths.video];
  for(const [index,item] of items.entries()){
    const asset=registry.find(a=>a.id===item.assetId),source=join(dir,'stages/assets',asset.file);check(await hash(source)===asset.sha256,'登记素材已改变');
    const file=join('assets',`${index}${extname(asset.file)}`),dest=join(out,file);await copyFile(source,dest,1);check(await hash(dest)===asset.sha256,'导出素材散列不同');assets.push({...asset,file,itemId:item.id});
    if(asset.kind==='image')args.push('-loop','1','-framerate',String(fps));args.push('-protocol_whitelist','file,pipe','-i',file);
  }
  const filters=['[0:v]setpts=PTS-STARTPTS[base]'];let prior='base';
  items.forEach((item,i)=>{
    const full=item.placement==='full',w=full?width:Math.floor(width*.38/2)*2,h=full?height:Math.floor(height*.4/2)*2;
    const x=full?0:width-w-Math.round(width*.04),y=full?0:Math.round(height*(item.placement==='lower-right'?.4:.06)),start=item.startFrame/fps,end=item.endFrame/fps;
    let chain=`[${i+1}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=0x101F26,setsar=1`;
    if(assets[i].kind==='image'&&item.motion==='push')chain+=`,zoompan=z='1+0.04*min(on/${Math.max(1,item.endFrame-item.startFrame-1)},1)':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=${w}x${h}:fps=${fps}`;
    chain+=`,fps=${fps},trim=duration=${end-start},setpts=PTS-STARTPTS+${start}/TB[layer${i}]`;filters.push(chain);
    filters.push(`[${prior}][layer${i}]overlay=x=${x}:y=${y}:enable='gte(n,${item.startFrame})*lt(n,${item.endFrame})':eof_action=pass:repeatlast=0[v${i}]`);prior='v'+i;
  });
  if(state.burnSubtitles){filters.push(`[${prior}]subtitles=visual.srt:force_style='FontName=Microsoft YaHei,FontSize=22,Outline=2,MarginV=28'[subbed]`);prior='subbed';}
  await writeFile(join(out,'render.filter.txt'),filters.join(';\n'),{flag:'wx'});
  args.push('-filter_complex_script','render.filter.txt','-map',`[${prior}]`,'-map','0:a:0','-frames:v',String(frameCount),'-c:v','libx264','-preset','fast','-crf','20','-pix_fmt','yuv420p','-r',String(fps),'-c:a','copy','-movflags','+faststart','visual.mp4');
  await newJson(join(out,'composition.json'),{kind:'local-fine-visual-composition',binding:state.binding,items,assets,subtitleOwner:'final-parent',audioOwner:'fine-base',burnSubtitles:state.burnSubtitles,ffmpeg:{executable:cfg.tools.ffmpegCommand,args,cwd:out}});
  await runLocal(cfg.tools.ffmpegCommand,args,{cwd:out});
  const raw=JSON.parse(await runLocal(cfg.tools.ffprobeCommand,['-v','error','-count_frames','-show_streams','-of','json',join(out,'visual.mp4')]));
  const v=raw.streams.find(s=>s.codec_type==='video'),a=raw.streams.find(s=>s.codec_type==='audio');
  await runLocal(cfg.tools.ffmpegCommand,['-nostdin','-v','error','-i',join(out,'visual.mp4'),'-f','null','-']);
  const checks={frameCount:Number(v.nb_read_frames)===frameCount,dimensions:v.width===width&&v.height===height,originalAudio:Boolean(a),audioVideoDuration:Math.abs(Number(a?.duration)-duration)<=1/fps+.01,fullDecode:true};
  // Stream copy must retain AAC payload, not just the presence of an audio track.
  for(const [name,source] of [['input',paths.video],['output',join(out,'visual.mp4')]])await runLocal(cfg.tools.ffmpegCommand,['-nostdin','-v','error','-i',source,'-map','0:a:0','-c:a','copy','-f','adts',join(out,name+'.aac')]);
  checks.audioPayloadUnchanged=await hash(join(out,'input.aac'))===await hash(join(out,'output.aac'));
  check(Object.values(checks).every(Boolean),'补图导出技术检查未通过');await verifyBinding(dir,state.binding);
  const qa={kind:'visual-stage-technical-qa',passed:true,checks,subjectiveListeningCompleted:false,creativeAcceptanceCompleted:false,userApprovalRecorded:false,remoteRequests:0};
  await newJson(join(out,'qa.json'),qa);const hashes={video:await hash(join(out,'visual.mp4')),srt:await hash(join(out,'visual.srt')),mapping:await hash(join(out,'mapping.json'))};
  const media={fps,frameCount,width,height};await newJson(join(out,'receipt.json'),{kind:'visual-stage-receipt',revision:state.revision,binding:state.binding,media,hashes,qaPassed:true,audioProcessing:'stream-copy-original-fine-audio',subtitleOwner:'final-parent',creativeAcceptanceCompleted:false,userApprovalRecorded:false,coreStateWritten:false,providersUsed:['local-ffmpeg'],excludedProviders:['ChatCut','MiniMax']});
  return {id:out.split(/[\\/]/).at(-1),media,qaPassed:true};
}
export async function stageMedia(dir,url){
  const parts=url.split('/').filter(Boolean);check(parts[0]==='stage-files','无效阶段文件');
  if(parts[1]==='assets'&&parts.length===3){const assets=(await maybe(join(dir,'stages/assets.json')))?.assets??[],a=assets.find(a=>a.file===parts[2]);check(a,'素材未登记');return {file:join(dir,'stages/assets',a.file),type:a.kind==='video'?'video/mp4':`image/${extname(a.file)==='.jpg'||extname(a.file)==='.jpeg'?'jpeg':extname(a.file).slice(1)}`};}
  check(parts.length===4&&['fine','visual'].includes(parts[1]),'无效阶段路径');safeId(parts[2]);
  check(['fine.mp4','fine.srt','visual.mp4','visual.srt','mapping.json','qa.json','receipt.json','composition.json','render.filter.txt','plan.json','original-to-rough.json'].includes(parts[3]),'文件不可通过浏览器读取');
  return {file:join(dir,'stages',parts[1]+'-exports',parts[2],parts[3]),type:parts[3].endsWith('.mp4')?'video/mp4':'text/plain; charset=utf-8'};
}
async function main(){
  const [command,...rest]=process.argv.slice(2),args={};
  const commands={worker:['command','output-dir'],state:[],select:['stage','id','revision'],save:['stage','input'],export:['stage','revision','binding-id'],task:['revision','binding-id'],motion:['input'],'import-results':['input'],'import-asset':['input']};
  if(command==='--help'){process.stdout.write('本地精剪/补图阶段（不使用 ChatCut）\nstate --project-dir DIR\nselect --project-dir DIR --stage fine|visual --id UPSTREAM-ID --revision CURRENT|-1\nsave --project-dir DIR --stage fine|visual --input EDIT.json\nexport --project-dir DIR --stage fine|visual --revision N --binding-id ID\ntask --project-dir DIR --revision N --binding-id ID\nmotion --project-dir DIR --input MOTION-REQUEST.json\nimport-results --project-dir DIR --input RESULTS.json\nimport-asset --project-dir DIR --input SELECTED-CLIP.mp4 (preserves .asset.json provenance)\n');return;}
  check(Object.hasOwn(commands,command),'使用 --help 查看阶段命令');const allowed=['project-dir','config',...commands[command]];
  for(let i=0;i<rest.length;i+=2){const key=rest[i].replace(/^--/,'');check(rest[i].startsWith('--')&&allowed.includes(key)&&rest[i+1]&&!Object.hasOwn(args,key),'无效参数');args[key]=rest[i+1];}
  check(args['project-dir'],'缺少工程目录');let result;
  if(command==='worker'){check(['fine','visual'].includes(args.command),'无效导出阶段');result=args.command==='fine'?await fineWorker(args['project-dir'],args['output-dir']):await visualWorker(args['project-dir'],args['output-dir'],args.config??CONFIG);}
  else if(command==='state')result=await stageState(args['project-dir']);
  else if(command==='select')result=await selectStage(args['project-dir'],args.stage,args.id,Number(args.revision));
  else if(command==='save')result=await saveStage(args['project-dir'],args.stage,await load(resolve(args.input)));
  else if(command==='export')result=await exportStage(args['project-dir'],args.stage,{revision:Number(args.revision),bindingId:args['binding-id']},args.config??CONFIG);
  else if(command==='task')result=await createTask(args['project-dir'],{revision:Number(args.revision),bindingId:args['binding-id']});
  else if(command==='motion')result=await makeMotionAsset(args['project-dir'],await load(resolve(args.input)),args.config??CONFIG);
  else if(command==='import-asset')result=await importAsset(args['project-dir'],args.input,args.config??CONFIG);
  else result=await importResults(args['project-dir'],args.input,args.config??CONFIG);
  process.stdout.write(json(result));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{process.stderr.write(e.message+'\n');process.exitCode=1;});
