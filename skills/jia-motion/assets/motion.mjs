/** Jia Motion: deterministic analytic motion. Authored locally; no OneTake code. */
export const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,v));
export const mix=(a,b,t)=>a+(b-a)*t;
export const smooth=t=>{t=clamp(t);return t*t*(3-2*t);};
export const phase=(t,a,b)=>smooth((t-a)/(b-a));
function finite(value,name){if(!Number.isFinite(value))throw new Error(`${name} must be finite`);return value;}

/** Exact solution of a damped oscillator, with position and velocity at t=0. */
export function springState(t,{from,to,velocity=0,frequency=3,damping=.75}){
  for(const [name,v] of Object.entries({t,from,to,velocity,frequency,damping}))finite(v,name);
  if(t<0||frequency<=0||damping<0)throw new Error('Nonnegative t/damping and positive frequency required');
  const w=2*Math.PI*frequency,y0=from-to,z=damping;
  let y,v;
  if(Math.abs(z-1)<1e-7){
    const a=y0,b=velocity+w*y0,e=Math.exp(-w*t);
    y=e*(a+b*t);v=e*(b-w*(a+b*t));
  }else if(z<1){
    const d=w*Math.sqrt(1-z*z),b=(velocity+z*w*y0)/d,c=Math.cos(d*t),s=Math.sin(d*t),e=Math.exp(-z*w*t);
    y=e*(y0*c+b*s);v=e*((-y0*d*s+b*d*c)-z*w*(y0*c+b*s));
  }else{
    const d=Math.sqrt(z*z-1),r1=-w*(z-d),r2=-w*(z+d),a=(velocity-r2*y0)/(r1-r2),b=y0-a;
    y=a*Math.exp(r1*t)+b*Math.exp(r2*t);v=a*r1*Math.exp(r1*t)+b*r2*Math.exp(r2*t);
  }
  return {value:to+y,velocity:v};
}

/** Events are target changes. Each new segment inherits exact previous x and v. */
export function retarget(t,initial,events,options={}){
  finite(t,'t');finite(initial,'initial');if(t<0)throw new Error('t must be nonnegative');
  let anchor=0,from=initial,to=initial,velocity=0,last=-Infinity;
  for(const e of events){
    finite(e.time,'event.time');finite(e.target,'event.target');
    if(e.time<0||e.time<=last)throw new Error('Event times must be nonnegative and strictly increasing');
    last=e.time;
  }
  for(const e of events){
    if(t<e.time)break;
    const state=springState(e.time-anchor,{...options,from,to,velocity});
    anchor=e.time;from=state.value;velocity=state.velocity;to=e.target;
  }
  return springState(t-anchor,{...options,from,to,velocity});
}

/** Position/velocity at both ends; tangents use units per second. */
export function hermite(t,duration,p0,p1,v0=0,v1=0){
  if(!Number.isFinite(duration)||duration<=0)throw new Error('duration must be positive');
  const u=clamp(t/duration),u2=u*u,u3=u2*u;
  return (2*u3-3*u2+1)*p0+(u3-2*u2+u)*duration*v0+(-2*u3+3*u2)*p1+(u3-u2)*duration*v1;
}

/** Pure cubic Bezier point; callers control pacing separately. */
export function cubic(u,a,b,c,d){
  const v=1-clamp(u);u=clamp(u);
  return {x:v*v*v*a.x+3*v*v*u*b.x+3*v*u*u*c.x+u*u*u*d.x,
    y:v*v*v*a.y+3*v*v*u*b.y+3*v*u*u*c.y+u*u*u*d.y};
}

export function bindTimeline({id,duration,draw,stateAt}){
  if(!window.gsap||typeof draw!=='function'||typeof stateAt!=='function'||!Number.isFinite(duration)||duration<=0)throw new Error('Invalid motion timeline setup');
  let time=0;
  const clock={};
  Object.defineProperty(clock,'time',{enumerable:true,configurable:true,get:()=>time,set(v){time=clamp(v,0,duration);draw(stateAt(time));}});
  const timeline=window.gsap.timeline({paused:true});
  timeline.fromTo(clock,{time:0},{time:duration,duration,ease:'none',immediateRender:true},0);
  window.__timelines=window.__timelines||{};
  if(window.__timelines[id])throw new Error(`Duplicate timeline ${id}`);
  window.__timelines[id]=timeline;
  const api={ready:false,duration,id,stateAt,seek(t){timeline.totalTime(clamp(t,0,duration),false);return stateAt(clamp(t,0,duration));}};
  window.__jiaMotion=api;
  draw(stateAt(0));
  Promise.resolve(document.fonts.ready).then(()=>{draw(stateAt(time));api.ready=true;document.documentElement.dataset.ready='true';});
  return api;
}
