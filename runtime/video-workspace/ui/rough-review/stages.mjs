const $=id=>document.getElementById(id);
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
let state,token,roughExports=[],page='rough',fine,visual,fineDirty=false,visualDirty=false,fineMode='preview',visualExportPlayback=false,stopAt=null,layers=[],jobTimer;
const seconds=(f,b)=>f/b.fps,clock=s=>`${Math.floor(s/60).toString().padStart(2,'0')}:${(s%60).toFixed(2).padStart(5,'0')}`;
function message(text,error=false){window.dispatchEvent(new CustomEvent('review-message',{detail:{text,error}}));}
async function api(path,data){const r=await fetch(path,data?{method:'POST',headers:{'Content-Type':'application/json','X-Review-Token':token},body:JSON.stringify(data)}:{});const v=await r.json();if(!r.ok)throw new Error(v.error);return v;}
const action=fn=>async()=>{try{await fn();}catch(e){if(e.name!=='AbortError')message(e.message,true);}};
function option(select,value,label){const o=el('option',label);o.value=value;select.append(o);}
function link(container,text,url){const a=el('a',text);a.href=url;a.target='_blank';a.rel='noopener';container.append(a);}
async function refresh(){
  const rough=await api('/api/state');token=rough.token;roughExports=rough.exports;
  state=await api('/api/stages');fine=structuredClone(state.fine);visual=structuredClone(state.visual);fineDirty=visualDirty=false;
  drawSources();drawFine();drawVisual();drawOutputs();if(state.job.status==='running')pollJob();
}
function drawSources(){
  for(const [id,list,current]of [['fineSource',roughExports,fine?.binding.id],['visualSource',state.exports.fine,visual?.binding.id]]){
    const s=$(id),chosen=s.value;s.replaceChildren();if(!list.length)option(s,'','尚无导出版本');
    for(const r of list)option(s,r.id,`r${r.revision} · ${clock(r.duration)} · ${r.id.slice(-8)}`);s.value=list.some(r=>r.id===current)?current:list.some(r=>r.id===chosen)?chosen:list[0]?.id??'';
  }
}
function fineMapping(){let out=0;return (fine?.segments??[]).map(s=>{const n=s.endFrameExclusive-s.startFrame,r={...s,outputStart:out,outputEnd:out+n};out+=n;return r;});}
function fineEdited(){fineDirty=true;$('fineStatus').textContent='有未保存切点';if(fineMode==='export')setFineSource();}
function drawFine(){
  const box=$('fineClips');box.replaceChildren();
  $('fineBinding').textContent=fine?`固定粗剪 ${fine.binding.id} · ${fine.binding.fps} fps${state.fineUpstreamChanged?' · 粗剪已有新修改，当前来源保持原版本':''}`:'先在第 01 步导出粗剪。';
  if(!fine){$('fineStatus').textContent='未载入';return;}$('fineStatus').textContent=fineDirty?'有未保存切点':`已保存 · r${fine.revision}`;$('fineVideo').parentElement.style.aspectRatio=`${fine.binding.width}/${fine.binding.height}`;
  for(const [i,s]of fine.segments.entries()){
    const row=el('div',undefined,'fine-clip'),head=el('div',undefined,'clip-head');head.append(el('b',`片段 ${i+1}`),el('span',`${clock(s.startFrame/fine.binding.fps)} → ${clock(s.endFrameExclusive/fine.binding.fps)}`));
    const listen=el('button',i?'听前一个接缝':'听片头');listen.dataset.listen=String(i);listen.onclick=action(()=>listenJoin(i));head.append(listen);row.append(head);
    const controls=el('div',undefined,'frame-inputs');
    for(const [key,label]of [['startFrame','起始帧'],['endFrameExclusive','结束帧（不含）']]){
      const field=el('label',label),input=el('input');input.type='number';input.step='1';input.min='0';input.max=String(fine.binding.frameCount);input.value=s[key];input.dataset.clip=String(i);input.dataset.boundary=key;
      input.onchange=()=>{s[key]=Number(input.value);fineEdited();};field.append(input);controls.append(field);
    }
    row.append(controls);const reason=el('input');reason.value=s.reason;reason.placeholder='切点调整理由';reason.setAttribute('aria-label',`片段 ${i+1} 调整理由`);reason.onchange=()=>{s.reason=reason.value;fineEdited();};row.append(reason);
    const foot=el('div',undefined,'stage-actions');
    const seekStart=el('button','查看起点'),seekEnd=el('button','查看终点');seekStart.onclick=()=>{setFineSource();$('fineVideo').currentTime=s.startFrame/fine.binding.fps;};seekEnd.onclick=()=>{setFineSource();$('fineVideo').currentTime=Math.max(s.startFrame,s.endFrameExclusive-1)/fine.binding.fps;};foot.append(seekStart,seekEnd);row.append(foot);box.append(row);
  }
}
function setFineSource(){if(!fine)return;const v=$('fineVideo'),src=`/exports/${fine.binding.id}/rough.mp4`;if(v.getAttribute('src')!==src){v.pause();v.src=src;}fineMode='preview';$('fineMode').classList.add('selected');$('fineOriginal').classList.remove('selected');}
async function listenJoin(index){setFineSource();const map=fineMapping(),v=$('fineVideo');stopAt=map[index].outputStart/fine.binding.fps+1.2;v.currentTime=Math.max(map[index].startFrame/fine.binding.fps-1.2,0);if(index)v.currentTime=Math.max(map[index-1].startFrame/fine.binding.fps,(map[index-1].endFrameExclusive/fine.binding.fps)-1.2);await v.play();}
function validateFineLocal(){let previous=0;for(const s of fine.segments){if(!Number.isInteger(s.startFrame)||!Number.isInteger(s.endFrameExclusive)||s.startFrame<previous||s.endFrameExclusive<=s.startFrame||s.endFrameExclusive>fine.binding.frameCount)throw new Error('切点必须按顺序保留有效整数帧，不能交叉或越界');previous=s.endFrameExclusive;}}
async function saveFine(){if(!fine)throw new Error('先载入粗剪');validateFineLocal();state=await api('/api/stages/save',{stage:'fine',revision:fine.revision,bindingId:fine.binding.id,segments:fine.segments});fine=structuredClone(state.fine);fineDirty=false;drawFine();message('精剪切点已保存，未记录成片确认。');}
async function saveVisual(){if(!visual)throw new Error('先载入精剪');state=await api('/api/stages/save',{stage:'visual',revision:visual.revision,bindingId:visual.binding.id,items:visual.items,burnSubtitles:$('burnSubtitles').checked});visual=structuredClone(state.visual);visualDirty=false;drawVisual();message('补图时间表已保存。');}
function drawVisual(){
  $('visualItems').replaceChildren();$('visualCues').replaceChildren();$('assetList').replaceChildren();
  $('visualBinding').textContent=visual?`固定精剪 ${visual.binding.id} · ${visual.binding.fps} fps${state.visualUpstreamChanged?' · 上游精剪已有调整，补图仍绑定当前版本':''}`:'先在第 02 步导出精剪。';
  $('visualStatus').textContent=visual?`已保存 · r${visual.revision}`:'未载入';
  for(const a of state.assets){const r=el('div',undefined,'asset-entry');r.append(el('b',a.name),el('small',`${a.kind==='image'?'图片':'无声视频'} · ${a.width}×${a.height}${a.duration?' · '+a.duration.toFixed(2)+' 秒':''}`));$('assetList').append(r);}
  if(!visual){drawLayers();return;}$('burnSubtitles').checked=visual.burnSubtitles;$('visualScreen').style.aspectRatio=`${visual.binding.width}/${visual.binding.height}`;
  for(const c of state.visualCues){const b=el('button',`${clock(c.startMs/1000)}  ${c.text}`,'cue-choice');b.dataset.cue=String(c.id);b.onclick=()=>{
    visual.items.push({id:'visual-'+crypto.randomUUID(),cueId:c.id,startFrame:Math.max(0,Math.floor(c.startMs/1000*visual.binding.fps)),endFrame:Math.min(visual.binding.frameCount,Math.ceil(c.endMs/1000*visual.binding.fps)),placement:'lower-right',motion:'push',prompt:c.text,assetId:null});visualEdited();drawVisual();setVisualSource();$('visualVideo').currentTime=c.startMs/1000;
  };$('visualCues').append(b);}
  visual.items.forEach((item,i)=>{
    const row=el('div',undefined,'visual-item');row.dataset.item=item.id;const head=el('div',undefined,'clip-head');head.append(el('b',`补图 ${i+1} · ${item.assetId?'素材已选':'待制作'}`));const remove=el('button','移除');remove.onclick=()=>{visual.items.splice(i,1);visualEdited();drawVisual();};head.append(remove);row.append(head);
    const times=el('div',undefined,'frame-inputs');for(const [key,label]of [['startFrame','开始帧'],['endFrame','结束帧（不含）']]){const l=el('label',label),n=el('input');n.type='number';n.step='1';n.value=item[key];n.min=0;n.max=visual.binding.frameCount;n.onchange=()=>{item[key]=Number(n.value);visualEdited();};l.append(n);times.append(l);}row.append(times);
    const selects=el('div',undefined,'frame-inputs'),asset=el('select');asset.setAttribute('aria-label',`补图 ${i+1} 素材`);option(asset,'','待制作 / 尚未选择');for(const a of state.assets)option(asset,a.id,a.name);asset.value=item.assetId??'';asset.onchange=()=>{item.assetId=asset.value||null;visualEdited();drawLayers();};selects.append(asset);
    const pos=el('select');option(pos,'corner','右上角');option(pos,'lower-right','右下角，检查人物和字幕遮挡');option(pos,'full','全屏覆盖');pos.value=item.placement;pos.onchange=()=>{item.placement=pos.value;visualEdited();drawLayers();};selects.append(pos);row.append(selects);
    const motion=el('select');option(motion,'still','图片静止');option(motion,'push','图片缓慢推进');motion.value=item.motion;motion.onchange=()=>{item.motion=motion.value;visualEdited();};row.append(motion);
    const prompt=el('textarea');prompt.value=item.prompt;prompt.rows=2;prompt.placeholder='说明补图要讲清什么，谁在做什么、如何动作';prompt.onchange=()=>{item.prompt=prompt.value;visualEdited();};row.append(prompt);
    const seek=el('button','播放这段');seek.onclick=action(async()=>{setVisualSource();$('visualVideo').currentTime=item.startFrame/visual.binding.fps;stopVisualAt=item.endFrame/visual.binding.fps;await $('visualVideo').play();});row.append(seek);$('visualItems').append(row);
  });drawLayers();if(visualDirty)$('visualStatus').textContent='有未保存补图';
}
function visualEdited(){visualDirty=true;visual.burnSubtitles=$('burnSubtitles').checked;$('visualStatus').textContent='有未保存补图';if(visualExportPlayback)setVisualSource();}
function setVisualSource(){if(!visual)return;const src=`/stage-files/fine/${visual.binding.id}/fine.mp4`,v=$('visualVideo');if(v.getAttribute('src')!==src){v.pause();v.src=src;}visualExportPlayback=false;}
function drawLayers(){layers=[];const container=$('visualLayers');container.replaceChildren();
  for(const i of visual?.items??[]){const a=state.assets.find(a=>a.id===i.assetId);if(!a)continue;const wrap=el('div',undefined,'visual-layer '+i.placement),media=el(a.kind==='image'?'img':'video');media.src=`/stage-files/assets/${a.file}`;if(a.kind==='video'){media.muted=true;media.playsInline=true;media.preload='metadata';}wrap.append(media);container.append(wrap);layers.push({item:i,asset:a,wrap,media});}
}
function drawOutputs(){
  for(const s of ['fine','visual']){const box=$(s+'Outputs');box.replaceChildren();if(state.exports[s].length)box.append(el('h3','实际导出 · 可播放与下载'));
    for(const x of state.exports[s]){const row=el('div',undefined,'output-entry'),play=el('button',`播放 r${x.revision} · ${clock(x.duration)}`);play.dataset.output=x.id;play.onclick=action(async()=>{const v=$(s+'Video');v.pause();v.src=`/stage-files/${s}/${x.id}/${s}.mp4`;if(s==='fine')fineMode='export';else visualExportPlayback=true;await v.play();});row.append(play);
      for(const [title,file]of [['MP4',s+'.mp4'],['字幕',s+'.srt'],['映射','mapping.json'],['QA','qa.json']])link(row,title,`/stage-files/${s}/${x.id}/${file}`);
      if(s==='visual')link(row,'合成源码',`/stage-files/${s}/${x.id}/composition.json`);box.append(row);
    }
  }
}
async function startExport(s){if(s==='fine'){if(fineDirty)await saveFine();}else if(visualDirty)await saveVisual();const r=s==='fine'?fine:visual;if(!r)throw new Error('请先载入来源');await api('/api/stages/export',{stage:s,revision:r.revision,bindingId:r.binding.id});pollJob();}
function pollJob(){clearTimeout(jobTimer);action(async()=>{const job=await api('/api/stages/job');
  for(const id of ['fineExport','visualExport','motionCreate'])$(id).disabled=true;
  if(job.status==='running'){const target=job.stage==='fine'?'fineStatus':'visualStatus';$(target).textContent=job.stage==='motion'?'正在制作本地代码动效…':'正在导出与检查…';jobTimer=setTimeout(pollJob,1000);return;}
  if(job.status==='failed'){for(const id of ['fineExport','visualExport','motionCreate'])$(id).disabled=false;throw new Error(job.error);}
  const fresh=await api('/api/stages');state={...fresh};if(!fineDirty)fine=structuredClone(state.fine);if(!visualDirty)visual=structuredClone(state.visual);drawSources();drawOutputs();drawFine();drawVisual();for(const id of ['fineExport','visualExport','motionCreate'])$(id).disabled=false;message('本地制作完成，请播放实际输出审片。');
})();}
async function switchPage(next){
  $('video').pause();$('fineVideo').pause();$('visualVideo').pause();stopAt=stopVisualAt=null;
  const nav=[...document.querySelectorAll('.workflow [data-stage]')];for(const b of nav)b.disabled=true;
  try{
    if(next!=='rough'){
      const r=await api('/api/state');roughExports=r.exports;const fresh=await api('/api/stages');state=fresh;
      if(!fineDirty)fine=structuredClone(fresh.fine);if(!visualDirty)visual=structuredClone(fresh.visual);drawSources();drawFine();drawVisual();drawOutputs();
      if(next==='fine')setFineSource();else setVisualSource();
    }
    // Reveal only when source loading is configured. A quick output click must
    // not be overwritten by a late stage fetch that resets the video source.
    page=next;document.body.dataset.stage=next;
    for(const s of ['rough','fine','visual'])$(s+'Page').hidden=s!==next;
    $('roughTimeline').hidden=next!=='rough';document.querySelector('.save-group').hidden=next!=='rough';
    for(const b of nav){b.classList.toggle('active',b.dataset.stage===next);b.setAttribute('aria-current',b.dataset.stage===next?'step':'false');}
  }finally{for(const b of nav)b.disabled=false;}
}
let stopVisualAt=null;
function tick(){
  if(fine&&page==='fine'){
    const v=$('fineVideo'),f=Math.floor(v.currentTime*fine.binding.fps+1e-4),map=fineMapping();let pos=f;
    if(fineMode==='preview'&&map.length){const segment=map.find(s=>f>=s.startFrame&&f<s.endFrameExclusive);
      if(segment)pos=segment.outputStart+f-segment.startFrame;
      else if(!v.paused){const next=map.find(s=>s.startFrame>f);if(next){v.currentTime=next.startFrame/fine.binding.fps;pos=next.outputStart;}else v.pause();}
    }
    if(stopAt!==null&&pos/fine.binding.fps>=stopAt){v.pause();stopAt=null;}
    $('fineTime').textContent=`粗剪 ${f} 帧 · ${clock(v.currentTime)}${fineMode==='preview'?' / 精剪 '+clock(pos/fine.binding.fps):''}`;
    const cue=state.fineCues.find(c=>v.currentTime*1000>=c.startMs&&v.currentTime*1000<c.endMs);$('fineCaption').textContent=fineMode==='export'?'':cue?.text??'';
  }
  if(visual&&page==='visual'){
    const base=$('visualVideo'),time=base.currentTime,frame=Math.floor(time*visual.binding.fps+1e-4);
    for(const l of layers){const active=!visualExportPlayback&&frame>=l.item.startFrame&&frame<l.item.endFrame;l.wrap.hidden=!active;
      if(l.asset.kind==='video'){if(active){const t=time-l.item.startFrame/visual.binding.fps;if(Math.abs(l.media.currentTime-t)>.15)l.media.currentTime=t;if(!base.paused&&l.media.paused)l.media.play().catch(()=>{});else if(base.paused)l.media.pause();}else l.media.pause();}
      else l.media.style.transform=l.item.motion==='push'?`scale(${1+.04*Math.max(0,Math.min(1,(frame-l.item.startFrame)/Math.max(1,l.item.endFrame-l.item.startFrame-1)))})`:'none';
    }
    const cue=state.visualCues.find(c=>time*1000>=c.startMs&&time*1000<c.endMs);$('visualCaption').textContent=visualExportPlayback||!visual.burnSubtitles?'':cue?.text??'';
    if(stopVisualAt!==null&&time>=stopVisualAt){base.pause();stopVisualAt=null;}
  }requestAnimationFrame(tick);
}
export async function initStages(){
  await refresh();document.body.dataset.stage='rough';
  for(const b of document.querySelectorAll('.workflow [data-stage]'))b.onclick=action(()=>switchPage(b.dataset.stage));
  for(const s of ['fine','visual'])$(s+'Bind').onclick=action(async()=>{
    if((s==='fine'&&fineDirty)||(s==='visual'&&visualDirty))throw new Error('先保存当前修改，再更换来源');const id=$(s+'Source').value;if(!id)throw new Error('尚无上游导出');const existing=s==='fine'?fine:visual;
    if(existing?.binding.id===id){message('当前已载入该版本。');return;}
    state=await api('/api/stages/select',{stage:s,id,revision:existing?.revision??-1});if(s==='fine'){fine=structuredClone(state.fine);drawFine();setFineSource();}else{visual=structuredClone(state.visual);drawVisual();setVisualSource();}
  });
  $('fineSave').onclick=action(saveFine);$('visualSave').onclick=action(saveVisual);
  $('fineExport').onclick=action(()=>startExport('fine'));$('visualExport').onclick=action(()=>startExport('visual'));
  $('fineMode').onclick=()=>{setFineSource();stopAt=null;};
  $('fineOriginal').onclick=()=>{setFineSource();fineMode='original';$('fineMode').classList.remove('selected');$('fineOriginal').classList.add('selected');};
  for(const [id,delta]of [['finePrevious',-1],['fineNext',1]])$(id).onclick=()=>{if(!fine)return;const v=$('fineVideo');v.pause();v.currentTime=Math.max(0,Math.min((fine.binding.frameCount-1)/fine.binding.fps,(Math.round(v.currentTime*fine.binding.fps)+delta)/fine.binding.fps));};
  $('fineReset').onclick=()=>{if(fine){fine.segments=structuredClone(fine.initialSegments);fineEdited();drawFine();$('fineStatus').textContent='切点已恢复，待保存';}};
  $('fineSplit').onclick=action(()=>{if(!fine||fineMode==='export')throw new Error('请在粗剪来源预览中定位');const frame=Math.round($('fineVideo').currentTime*fine.binding.fps),i=fine.segments.findIndex(s=>frame>s.startFrame&&frame<s.endFrameExclusive);if(i<0)throw new Error('请选片段内部的播放位置');const s=fine.segments[i];fine.segments.splice(i,1,{...s,endFrameExclusive:frame},{...s,id:'clip-'+crypto.randomUUID(),startFrame:frame});fineEdited();drawFine();});
  $('burnSubtitles').onchange=()=>{if(visual)visualEdited();};
  $('assetImport').onclick=action(async()=>{const input=$('assetPath').value.trim().replace(/^"|"$/g,'');if(!input)throw new Error('请输入本地素材路径');const a=await api('/api/stages/asset',{input});state.assets.push(a);drawVisual();message('素材已复制并登记，可在补图条目中选择。');});
  $('motionCreate').onclick=action(async()=>{if(!visual)throw new Error('先载入精剪');if(visualDirty)await saveVisual();await api('/api/stages/motion',{stage:'motion',revision:visual.revision,bindingId:visual.binding.id,preset:'flow',left:$('motionLeft').value,right:$('motionRight').value});pollJob();});
  $('taskCreate').onclick=action(async()=>{if(!visual)throw new Error('先载入精剪');if(visualDirty)await saveVisual();const task=await api('/api/stages/task',{revision:visual.revision,bindingId:visual.binding.id});$('taskResult').textContent=`请 Codex 执行这个补图任务：\n${task.file}\n\n任务说明：${task.instructions}\n待制作 ${task.count} 个素材。`;});
  $('resultsImport').onclick=action(async()=>{if(visualDirty)throw new Error('先保存补图编辑');state=await api('/api/stages/results',{input:$('resultsPath').value});visual=structuredClone(state.visual);drawVisual();message('制作结果已登记。');});
  $('stageRefresh').onclick=action(async()=>{if(fineDirty||visualDirty)throw new Error('先保存未保存修改');await refresh();});
  window.addEventListener('beforeunload',e=>{if(fineDirty||visualDirty){e.preventDefault();e.returnValue='';}});
  document.addEventListener('keydown',e=>{if(page==='rough')return;if(e.ctrlKey&&e.key.toLowerCase()==='s'){e.preventDefault();action(page==='fine'?saveFine:saveVisual)();}});
  tick();
}
