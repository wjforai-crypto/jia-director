// Jia Director 2.0 engineering demo: props, actual medium functions and a deterministic world camera.
// No human/mascot geometry, random time noise or simulated voice; this is not a user-approved new style.
(() => {
  let W=1920,H=1080;
  U.onStage((w,h)=>{W=w;H=h;});
  const P=PAINT, M=MEDIUM, C=CAM;
  const clamp=x=>Math.max(0,Math.min(1,x));
  const smooth=x=>{x=clamp(x);return x*x*(3-2*x);};
  function vessel(c,x,y,r,t,mode){
    c.save();c.translate(x,y);
    c.fillStyle='#e9bd67';
    c.beginPath();c.ellipse(0,r*.36,r*.88,r*1.04,0,0,Math.PI*2);
    const pts=P.ellipsePts(0,r*.36,r*.88,r*1.04,24);
    if(mode==='watercolor')P.watercolor(c,pts,'#b57143',{layers:5,alpha:.20,amp:8,seed:12});
    else {c.fillStyle=mode==='ink'?'#efe0bd':'#bd633e';c.fill();}
    c.strokeStyle='#463d31';c.lineWidth=Math.max(2,r*.018);c.stroke();
    c.fillStyle='#faf2d6';c.beginPath();c.ellipse(0,-r*.54,r*.74,r*.16,0,0,Math.PI*2);c.fill();c.stroke();
    // Water moves inside the vessel, rather than full-frame random flicker.
    c.save();c.beginPath();c.ellipse(0,r*.36,r*.83,r*.98,0,0,Math.PI*2);c.clip();
    c.fillStyle=mode==='ink'?'#9baca0':'#468b86';c.beginPath();c.moveTo(-r,r*.30);
    for(let i=0;i<=36;i++){let x=-r+2*r*i/36;c.lineTo(x,r*.30+Math.sin(i*.35-t*3)*r*.055);}
    c.lineTo(r,r*2);c.lineTo(-r,r*2);c.closePath();c.globalAlpha=.62;c.fill();c.restore();
    c.restore();
  }
  function branch(c,x,y,s,t,mode){
    const sway=Math.sin(t*1.7)*.045;
    c.save();c.translate(x,y);c.rotate(sway);
    const stem=[[0,0],[-s*.12,-s*.42],[s*.02,-s*.78],[s*.2,-s*1.2]];
    P.brush(c,stem,{w:s*.035,seed:41,reveal:smooth(t*.85),dry:mode==='ink'?.7:.3,col:[36,62,43]});
    for(let i=0;i<9;i++){
      const p=(i+1)/10,side=i%2?1:-1;
      const x=s*.16*p,y=-s*1.1*p;
      const a=side<0?-2.7:-.4;
      const growth=smooth(t*1.2-p*.85);
      P.leaf(c,x,y,a+Math.sin(t*2+i)*.035,s*.45*growth,s*.09*growth,.8,[45,82,54]);
    }
    c.restore();
  }
  function notebook(c,x,y,w,h,t,mode){
    c.save();c.translate(x,y);c.rotate(-.08);
    c.fillStyle='#504233';c.fillRect(10,16,w,h);
    c.fillStyle='#f9eed7';c.fillRect(0,0,w,h);c.strokeStyle='#695242';c.lineWidth=3;c.strokeRect(0,0,w,h);
    const lines=6;
    for(let i=0;i<lines;i++)P.brush(c,[[w*.12,h*(.2+i*.105)],[w*.8,h*(.2+i*.105)+Math.sin(i)*4]],{w:2.2,tone:.35,seed:5+i,reveal:clamp(t*.9-i*.12)});
    const fold=smooth((t-.8)/1.1),lift=Math.sin(fold*Math.PI)*w*.22;
    c.fillStyle=mode==='ink'?'#ded4bd':'#e4bf86';c.beginPath();c.moveTo(w*.68,0);c.quadraticCurveTo(w+lift,-h*.2*fold,w,h*.3);c.lineTo(w,h);c.closePath();c.globalAlpha=.78;c.fill();c.restore();
  }
  function make(mode){
    let ground;
    return {
      init(){ground=M.plaster('jia_'+mode,{base:mode==='ink'?'#eee8d9':'#e7d3af',seed:53,pits:600,mottle:.025});},
      draw(c,lt){
        c.drawImage(ground,0,0,W,H);
        const cam=C.track({x:W/2,y:H/2,z:1},[{at:.1,kind:'glide',x:W*.44,y:H*.5,dur:.9},{at:1.6,kind:'push',x:W*.44,y:H*.44,k:.16,dur:.9},{at:2.9,kind:'pull',z:1,x:W/2,y:H/2,dur:.9}],lt);
        C.with(c,cam,()=>{
          const u=W/1280;
          c.fillStyle=mode==='ink'?'#d2c7ad':'#b58d66';c.fillRect(-W,H*.73,W*3,H);
          c.strokeStyle='#705d48';c.lineWidth=2;
          for(let i=-2;i<9;i++){c.beginPath();c.moveTo(i*W*.18,H*.73);c.lineTo(i*W*.18+W*.2,H*1.8);c.stroke();}
          vessel(c,W*.39,H*.58,128*u,lt,mode);
          branch(c,W*.39,H*.55,265*u,lt,mode);
          notebook(c,W*.66,H*.48,280*u,205*u,lt,mode);
          // A second independent, causal action: a wooden pencil rolls and settles beside the notebook.
          const q=smooth((lt-.6)/1.3),px=W*(.92-.18*q),py=H*.75;
          c.save();c.translate(px,py);c.rotate(-.25+.16*Math.sin(q*Math.PI));
          c.fillStyle='#bc633d';c.fillRect(-110*u,-8*u,220*u,16*u);c.fillStyle='#40362c';c.beginPath();c.moveTo(-110*u,-8*u);c.lineTo(-135*u,0);c.lineTo(-110*u,8*u);c.fill();c.restore();
          if(mode==='ink')P.inkWash(c,'jia-shadow',smooth(lt),g=>{g.fillStyle='rgba(24,35,25,.14)';g.beginPath();g.ellipse(W*.38,H*.80,W*.16,H*.035,0,0,Math.PI*2);g.fill();},{halo:6,blur:2,alpha:.6});
        });
        if(mode==='fresco'){
          const plate=P.scratch('jia-fresco-plate');const pc=plate.getContext('2d');pc.reset();pc.drawImage(c.canvas,0,0);
          M.fresco(c,plate,{ground,chalk:.045,soften:.35,plasterAlpha:.25});
        }
      }
    };
  }
  SCENES.jia_watercolor=make('watercolor');SCENES.jia_ink=make('ink');SCENES.jia_fresco=make('fresco');
})();
