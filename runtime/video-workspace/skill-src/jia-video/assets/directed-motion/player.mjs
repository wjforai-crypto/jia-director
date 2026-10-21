import { evaluateAt, project } from './evaluator.mjs';
const SVG = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, parent) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.appendChild(e); return e;
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export function initialize(spec) {
  const root = document.querySelector('#stage');
  const defs = svg('defs', {}, root), visuals = new Map();
  const background = svg('rect', { width: spec.canvas.width, height: spec.canvas.height, fill: spec.style.background }, root);
  if (spec.backgroundAsset) svg('image', { href: spec.backgroundAsset, width: spec.canvas.width, height: spec.canvas.height, preserveAspectRatio: 'xMidYMid slice' }, root);
  // Each node is projected independently; far and near layers react differently to camera translation.
  for (const node of [...spec.nodes].sort((a, b) => b.depth - a.depth)) {
    const color = node.style.color, stroke = node.style.stroke;
    const gradient = svg('radialGradient', { id: `light-${node.id}`, cx: '35%', cy: '25%', r: '80%' }, defs);
    const bright = svg('stop', { offset: '0%', 'stop-color': '#FFFFFF', 'stop-opacity': .8 }, gradient);
    svg('stop', { offset: '38%', 'stop-color': color }, gradient);
    svg('stop', { offset: '100%', 'stop-color': '#07111C' }, gradient);
    const shadow = svg('ellipse', { fill: '#000000', opacity: .28 }, root);
    const g = svg('g', { id: node.id }, root);
    let object, progress;
    const w = node.width, h = node.height, r = node.radius;
    const shapeAttrs = { fill: color, stroke, 'stroke-width': 1.5 };
    if (node.kind === 'orb') {
      object = svg('circle', { r, fill: `url(#light-${node.id})`, stroke, 'stroke-width': 1 }, g);
      svg('path', { d: `M ${-r * .42} ${-r * .56} Q ${-r * .13} ${-r * .78} ${r * .25} ${-r * .57}`, fill: 'none', stroke: '#FFFFFF', 'stroke-width': 2, opacity: .42 }, g);
    } else if (node.kind === 'platform') {
      object = svg('path', { d: `M ${-w/2} 0 L ${-w/2+20} ${-h/2} L ${w/2} ${-h/2} L ${w/2-20} 0 Z`, ...shapeAttrs }, g);
      svg('path', { d: `M ${-w/2} 0 L ${w/2-20} 0 L ${w/2-20} ${h/2} L ${-w/2} ${h/2} Z`, fill: color, opacity: .32, stroke }, g);
      progress = svg('rect', { x: -w/2+14, y: -h/2+4, width: w-40, height: Math.max(3,h/7), rx: 2, fill: '#FFFFFF', opacity: .55 }, g);
    } else if (node.kind === 'gate') {
      object = svg('rect', { x: -w/2, y: -h/2, width: w, height: h, rx: 13, fill: color, 'fill-opacity': .09, stroke, 'stroke-width': 2 }, g);
      svg('path', { d: `M ${-w/2+18} ${-h/2+14} L ${-w/2+18} ${h/2-14} M ${w/2-18} ${-h/2+14} L ${w/2-18} ${h/2-14}`, stroke, fill: 'none', 'stroke-width': 1, opacity: .3 }, g);
      progress = svg('path', { d: 'M -16 0 L -3 12 L 21 -14', fill: 'none', stroke, 'stroke-width': 5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);
    } else if (node.kind === 'house') {
      object = svg('path', { d: `M ${-w/2} 0 L 0 ${-h/2} L ${w/2} 0 L ${w/2-10} 0 L ${w/2-10} ${h/2} L ${-w/2+10} ${h/2} L ${-w/2+10} 0 Z`, ...shapeAttrs }, g);
      svg('rect', { x: -9, y: 7, width: 18, height: h/2-7, rx: 2, fill: '#081522', opacity: .7 }, g);
      progress = svg('rect', { x: w/2-30, y: 8, width: 10, height: 13, rx: 1, fill: '#F1BD71' }, g);
    } else if (node.kind === 'person') {
      object = svg('circle', { cy: -h/3, r: w/4, ...shapeAttrs }, g);
      svg('path', { d: `M ${-w/2} ${h/2} Q ${-w/2} 0 0 0 Q ${w/2} 0 ${w/2} ${h/2} Z`, ...shapeAttrs }, g);
    } else if (node.kind === 'line') {
      object = svg('path', { d: `M ${-w/2} 0 L ${w/2} 0`, fill: 'none', stroke: color, 'stroke-width': h, 'stroke-linecap': 'round' }, g);
      progress = object;
    } else if (node.kind === 'text') {
      object = svg('text', { 'text-anchor': 'middle', fill: color, 'font-size': node.size, 'font-weight': 600 }, g);
      node.text.split('\n').forEach((line, i, lines) => { const t = svg('tspan', { x: 0, y: (i - (lines.length-1)/2)*node.size*1.35 }, object); t.textContent = line; });
    } else if (node.kind === 'asset') {
      object = svg('image', { x: -w/2, y: -h/2, width: w, height: h, href: node.assetPath, preserveAspectRatio: 'xMidYMid meet' }, g);
    }
    const illumination = svg('ellipse', { cx: 0, cy: 0, rx: Math.max(r, w/2)*1.3, ry: Math.max(r,h/2)*1.3, fill: color, opacity: 0, filter: 'url(#soft-light)' }, g);
    if (node.kind === 'orb') g.insertBefore(illumination, object);
    visuals.set(node.id, { g, shadow, gradient, bright, object, progress, illumination });
  }
  const blur = svg('filter', { id: 'soft-light', x: '-80%', y: '-80%', width: '260%', height: '260%' }, defs);
  svg('feGaussianBlur', { stdDeviation: 13 }, blur);
  const captionElements = spec.captions.map((c, i) => {
    const g = svg('g', { id: `caption-${i}` }, root);
    const e = svg('text', { x: c.x, y: c.y, fill: c.color, 'text-anchor': 'middle', 'font-size': c.size, 'font-weight': 600 }, g);
    c.text.split('\n').forEach((line, j, all) => { const t = svg('tspan', { x: c.x, y: c.y + (j-(all.length-1)/2)*c.size*1.35 }, e); t.textContent = line; });
    return g;
  });
  function paint(time) {
    const state = evaluateAt(spec, time);
    for (const original of spec.nodes) {
      const n = state.nodes[original.id], v = visuals.get(n.id), p = project(spec, state, n);
      const scaleX = n.scale*n.scaleX*p.scale, scaleY = n.scale*n.scaleY*p.scale;
      v.g.setAttribute('transform', `translate(${p.x} ${p.y}) rotate(${n.rotation}) scale(${scaleX} ${scaleY})`);
      v.g.setAttribute('opacity', String(clamp(n.opacity,0,1)));
      const ground = project(spec,state,n,n.x,n.groundY);
      const height = Math.max(0,n.groundY-n.y), spread = .8+height/150;
      v.shadow.setAttribute('cx', String(ground.x-spec.style.lightX*height*.3*p.scale));
      v.shadow.setAttribute('cy', String(ground.y-spec.style.lightY*height*.08*p.scale));
      v.shadow.setAttribute('rx', String(Math.max(n.radius,n.width/3)*p.scale*spread*n.scale));
      v.shadow.setAttribute('ry', String(Math.max(3, n.radius*.2)*p.scale/spread));
      v.shadow.setAttribute('opacity', String(n.shadow? n.opacity*.3/(1+height/70):0));
      v.gradient.setAttribute('cx', `${50+spec.style.lightX*24 + (state.camera.x-spec.camera.x)*.002}%`);
      v.gradient.setAttribute('cy', `${50+spec.style.lightY*24}%`);
      v.bright.setAttribute('stop-opacity', String(.38+n.light*.48));
      v.illumination.setAttribute('opacity', String(clamp(n.light,0,1)*.17));
      if (v.progress) {
        if (n.kind==='line') { v.progress.style.strokeDasharray=`${n.width} ${n.width}`; v.progress.style.strokeDashoffset=String(n.width*(1-clamp(n.progress,0,1))); }
        else if (n.kind==='gate') v.progress.setAttribute('opacity',String(clamp(n.progress,0,1)));
        else if (n.kind==='platform') v.progress.setAttribute('width', String(Math.max(0,n.width-40)*clamp(n.progress,0,1)));
        else if (n.kind==='house') v.progress.setAttribute('opacity', String(.1+.9*clamp(n.light,0,1)));
      }
    }
    spec.captions.forEach((c,i)=>{
      const age=state.time-c.start, remaining=c.start+c.duration-state.time;
      const opacity=clamp(Math.min(age/.2,c.start+c.duration>=spec.canvas.duration-1e-7?1:remaining/.2),0,1);
      captionElements[i].setAttribute('opacity',String(opacity));
      captionElements[i].setAttribute('transform', `translate(0 ${8*(1-opacity)})`);
    });
    return state;
  }
  let currentTime=0;
  const clock={};
  // A property write renders even when a caller suppresses GSAP event callbacks.
  // Plain timeline.seek(t), reverse seeks, and HyperFrames totalTime(t,true)
  // therefore share the same deterministic output as __directed.seek(t).
  Object.defineProperty(clock,'time',{enumerable:true,configurable:true,get:()=>currentTime,set(value){currentTime=value;paint(value);}});
  const timeline=window.gsap.timeline({paused:true});
  timeline.fromTo(clock,{time:0},{time:spec.canvas.duration,duration:spec.canvas.duration,ease:'none',immediateRender:true},0);
  window.__timelines=window.__timelines||{};window.__timelines[spec.compositionId]=timeline;
  window.__directed={seek(t){timeline.seek(t,false);return evaluateAt(spec,t);},stateAt(t){return evaluateAt(spec,t);},spec};
  paint(0);
  document.documentElement.dataset.ready='true';
}
