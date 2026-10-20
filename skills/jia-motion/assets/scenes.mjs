import {clamp,mix,phase,retarget,cubic,bindTimeline} from './motion.mjs';
const spec=JSON.parse(document.querySelector('#motion-spec').textContent);
const svg=document.querySelector('#stage');
const set=(id,attrs)=>{const el=document.getElementById(id);for(const [k,v]of Object.entries(attrs))el.setAttribute(k,String(v));};
const text=(id,value)=>document.getElementById(id).textContent=value;
const color=(a,b,u)=>'#'+[1,3,5].map(i=>Math.round(mix(parseInt(a.slice(i,i+2),16),parseInt(b.slice(i,i+2),16),u)).toString(16).padStart(2,'0')).join('');
const D=spec.duration;

function uiScene(){
  svg.innerHTML=`<defs><clipPath id="panel-clip"><rect id="clip-rect"/></clipPath><filter id="panel-shadow" x="-30%" y="-30%" width="160%" height="180%"><feDropShadow dx="0" dy="24" stdDeviation="22" flood-color="#14222b" flood-opacity=".14"/></filter></defs>
  <rect width="1280" height="720" fill="#f1efe8"/>
  <text x="92" y="82" fill="#69746d" font-size="16" letter-spacing="4">JIA / MOTION</text>
  <text x="92" y="143" fill="#18222b" font-size="44" font-weight="700">让操作，推动变化。</text>
  <g id="hero-shell" filter="url(#panel-shadow)"><rect id="shell"/>
    <g id="button-label"><path d="M -63 -10 L -63 10 L -47 0 Z" fill="#fff"/><text x="-32" y="8" fill="#fff" font-size="25" font-weight="700">开始制作</text></g>
    <g id="panel-content" clip-path="url(#panel-clip)">
      <text x="30" y="46" fill="#eef1ef" font-size="22" font-weight="700">MOTION STUDIO</text><circle id="live-dot" r="4" fill="#ff6845"/><text id="live-label" y="44" fill="#b8c9c9" font-size="13" letter-spacing="2">ACTIVE</text>
      <path id="divider" stroke="#ffffff" stroke-opacity=".13"/>
      <text x="30" y="94" fill="#b8c9c9" font-size="18">动作轨迹</text><text id="value-label" y="99" fill="#ff6845" font-size="34" font-weight="700"/>
      <rect id="chart-bg" rx="14" fill="#24313a"/>
      <path id="chart-guide" fill="none" stroke="#9ab0b6" stroke-opacity=".2" stroke-width="1"/>
      <path id="chart" fill="none" stroke="#ff6845" stroke-width="5" stroke-linecap="round"/>
      <circle id="chart-tip" r="6" fill="#ff6845"/>
      <path id="slider-base" stroke="#53636b" stroke-width="5" stroke-linecap="round"/><path id="slider-fill" stroke="#ff6845" stroke-width="5" stroke-linecap="round"/>
      <circle id="slider-knob" r="10" fill="#fff5eb"/>
      <g id="complete"><circle r="15" fill="#ff6845"/><path d="M -7 0 L -2 5 L 8 -6" fill="none" stroke="#17212a" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></g>
    </g>
  </g>
  <circle id="click-ring" fill="none" stroke="#ff6845" stroke-width="3"/>
  <g id="cursor"><path d="M 0 0 L 0 31 L 8 23 L 15 38 L 22 34 L 15 20 L 28 20 Z" fill="#ffffff" stroke="#18222b" stroke-width="2" stroke-linejoin="round"/></g>
  <text id="result" x="640" y="659" text-anchor="middle" fill="#35433f" font-size="23">变化有因果，落点有结果。</text>`;
  function stateAt(t){
    const p=clamp(t/D),options={frequency:15/D,damping:.83};
    const w=retarget(t,240,[{time:.15*D,target:760},{time:.39*D,target:660},{time:.58*D,target:700}],options).value;
    const h=retarget(t,88,[{time:.15*D,target:310},{time:.39*D,target:390},{time:.58*D,target:340}],options).value;
    const radius=retarget(t,44,[{time:.15*D,target:28}],options).value;
    const drag=phase(p,.38,.68),progress=.18+.64*drag,complete=phase(p,.72,.82);
    const x=640-w/2,y=390-h/2,knob={x:x+32+(w-64)*progress,y:y+h-43};
    let cursor={x:mix(1010,692,phase(p,0,.15)),y:mix(590,389,phase(p,0,.15))};
    if(p>.22)cursor={x:mix(692,knob.x,phase(p,.22,.36)),y:mix(389,knob.y,phase(p,.22,.36))};
    if(p>.7)cursor={x:mix(knob.x,1040,phase(p,.7,.86)),y:mix(knob.y,565,phase(p,.7,.86))};
    return {time:t,p,subject:{id:'hero-shell',kind:'container',x:640,y:390,width:w,height:h,radius},x,y,w,h,radius,progress,complete,cursor,
      events:{clicked:p>=.15,dragging:p>=.38&&p<.68,released:p>=.7}};
  }
  function draw(s){
    const {p,w,h,x,y}=s;
    set('hero-shell',{transform:`translate(${x} ${y})`});
    set('shell',{x:0,y:0,width:w,height:h,rx:s.radius,fill:color('#2456e8','#18222b',phase(p,.15,.27))});
    set('clip-rect',{x:0,y:0,width:w,height:h,rx:s.radius});
    set('button-label',{transform:`translate(${w/2} ${h/2})`,opacity:1-phase(p,.15,.22)});
    set('panel-content',{opacity:phase(p,.23,.3)});
    set('live-dot',{cx:w-113,cy:39});set('live-label',{x:w-99});
    set('divider',{d:`M 30 65 L ${w-30} 65`});
    text('value-label',`${Math.round(s.progress*100)}%`);set('value-label',{x:w-112});
    const top=119,bottom=h-84,cw=w-60,ch=Math.max(30,bottom-top),peak=bottom-ch*(.35+.6*s.progress);
    set('chart-bg',{x:30,y:top,width:cw,height:ch});
    set('chart-guide',{d:`M 50 ${bottom-15} L ${w-50} ${bottom-15} M 50 ${top+20} L ${w-50} ${top+20}`});
    set('chart',{d:`M 50 ${bottom-20} C ${w*.3} ${bottom-20},${w*.32} ${peak},${w*.5} ${peak} S ${w*.76} ${bottom-30},${w-50} ${top+20}`});
    set('chart-tip',{cx:w-50,cy:top+20});
    const sy=h-43,kx=32+(w-64)*s.progress;
    set('slider-base',{d:`M 32 ${sy} L ${w-32} ${sy}`});set('slider-fill',{d:`M 32 ${sy} L ${kx} ${sy}`});set('slider-knob',{cx:kx,cy:sy});
    set('complete',{opacity:s.complete,transform:`translate(${w-34} 39) scale(${mix(.7,1,s.complete)})`});
    set('live-dot',{opacity:1-s.complete});set('live-label',{opacity:1-s.complete});
    set('cursor',{transform:`translate(${s.cursor.x} ${s.cursor.y}) scale(${1-.14*Math.sin(Math.PI*phase(p,.14,.18))})`,opacity:1-phase(p,.86,.95)});
    const click=clamp((p-.15)/.09);
    set('click-ring',{cx:692,cy:389,r:8+32*click,opacity:p>=.15&&p<.24?(1-click)*.8:0});
    set('result',{opacity:phase(p,.79,.88)});
  }
  return {stateAt,draw};
}

function carryScene(){
  svg.innerHTML=`<rect width="1280" height="720" fill="#f1efe8"/>
  <text x="92" y="82" fill="#69746d" font-size="16" letter-spacing="4">JIA / MOTION</text>
  <text id="intro-header" x="92" y="143" fill="#18222b" font-size="44" font-weight="700">让一个对象，带出下一幕。</text>
  <g id="old-scene"><path d="M 230 440 C 440 300 610 470 830 330" fill="none" stroke="#d5d9cf" stroke-width="3" stroke-dasharray="5 10"/>
    <path id="travel-trace" d="M 230 440 C 440 300 610 470 830 330" fill="none" stroke="#2456e8" stroke-width="4" stroke-linecap="round" pathLength="1" stroke-dasharray="1"/>
    <circle cx="830" cy="330" r="40" fill="none" stroke="#2456e8" stroke-width="2"/>
    <text x="215" y="499" fill="#435149" font-size="19">起点</text><text x="790" y="402" fill="#435149" font-size="19">交接点</text></g>
  <circle id="scene-mask" cx="830" cy="330" fill="#18222b" data-layout-allow-overflow="true"/>
  <g id="new-scene"><text x="92" y="143" fill="#f1efe8" font-size="40" font-weight="700">同一身份，继续完成动作。</text>
    <path id="edge-0" fill="none" stroke="#ff6845" stroke-width="3" stroke-linecap="round" pathLength="1" stroke-dasharray="1"/>
    <path id="edge-1" fill="none" stroke="#ff6845" stroke-width="3" stroke-linecap="round" pathLength="1" stroke-dasharray="1"/>
    <path id="edge-2" fill="none" stroke="#ff6845" stroke-width="3" stroke-linecap="round" pathLength="1" stroke-dasharray="1"/>
    ${[{x:340,y:258,label:'构图'},{x:940,y:258,label:'动作'},{x:940,y:500,label:'结果'}].map((n,i)=>`<g id="target-${i}" transform="translate(${n.x} ${n.y})"><circle r="27" fill="#24313a" stroke="#6a7c80" stroke-width="1.5"/><path id="tick-${i}" d="M -9 0 L -2 7 L 12 -9" fill="none" stroke="#ff6845" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><text y="59" fill="#dae5e1" font-size="22" text-anchor="middle">${n.label}</text></g>`).join('')}
    <circle id="pulse-0" r="5" fill="#fff1d9"/><circle id="pulse-1" r="5" fill="#fff1d9"/><circle id="pulse-2" r="5" fill="#fff1d9"/>
    <text x="640" y="657" text-anchor="middle" fill="#b2c3c2" font-size="23">跨镜承接，也承接注意力。</text></g>
  <circle id="hero-ring" fill="none" stroke="#ff6845" stroke-width="2"/>
  <circle id="hero-core"/>
  <text id="hero-label" text-anchor="middle" fill="#ffab8c" font-size="20">线索</text>`;
  const A={x:230,y:440},B={x:440,y:300},C={x:610,y:470},Z={x:830,y:330};
  const targets=[{x:340,y:258},{x:940,y:258},{x:940,y:500}];
  function stateAt(t){
    const p=clamp(t/D),u=phase(p,.06,.37),q=cubic(u,A,B,C,Z),move=phase(p,.48,.63);
    const x=mix(q.x,640,move),y=mix(q.y,360,move),radius=mix(15,27,phase(p,.38,.56));
    return {time:t,p,u,x,y,radius,mask:phase(p,.37,.57),network:phase(p,.57,.65),
      edges:[phase(p,.62,.74),phase(p,.7,.82),phase(p,.78,.9)],
      subject:{id:'hero-core',kind:'carrier',x,y,radius},events:{reached:p>=.37,transition:p>=.37&&p<.57,settled:p>=.9}};
  }
  function draw(s){
    const {p,x,y}=s;
    set('travel-trace',{'stroke-dashoffset':1-s.u});
    set('scene-mask',{r:1600*s.mask});
    set('old-scene',{opacity:1-phase(p,.37,.52)});
    set('intro-header',{opacity:1-phase(p,.37,.52)});
    set('new-scene',{opacity:s.network});
    set('hero-core',{cx:x,cy:y,r:s.radius,fill:color('#2456e8','#ff6845',phase(p,.35,.43))});
    const wave=clamp((p-.37)/.14);
    set('hero-ring',{cx:x,cy:y,r:s.radius+8+60*wave,opacity:p>=.37&&p<.51?(1-wave)*.7:0});
    set('hero-label',{x,y:y+59,opacity:phase(p,.56,.64)});
    text('hero-label',p>=.6?'主线':'线索');
    for(let i=0;i<3;i++){
      const n=targets[i],u=s.edges[i];
      set(`edge-${i}`,{d:`M ${x} ${y} L ${n.x} ${n.y}`,'stroke-dashoffset':1-u});
      set(`target-${i}`,{opacity:phase(p,.59+i*.07,.65+i*.07)});
      set(`tick-${i}`,{opacity:phase(u,.85,1)});
      set(`pulse-${i}`,{cx:mix(x,n.x,u),cy:mix(y,n.y,u),opacity:u>0&&u<1?1:0});
    }
  }
  return {stateAt,draw};
}
const scene=spec.kind==='ui'?uiScene():carryScene();
bindTimeline({id:spec.id,duration:D,...scene});
