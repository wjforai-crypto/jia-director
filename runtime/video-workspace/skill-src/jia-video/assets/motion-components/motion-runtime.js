/* Jia Video motion adapter: finite, paused, frame-seekable GSAP timeline. */
(function () {
  'use strict';
  const spec = JSON.parse(document.getElementById('motion-description').textContent);
  if (!window.gsap) throw new Error('Local GSAP runtime unavailable');
  const timeline = window.gsap.timeline({ paused: true });
  const sentinel = { progress: 0 };
  timeline.to(sentinel, { progress: 1, duration: spec.canvas.duration, ease: 'none' }, 0);
  const allScenes = document.querySelectorAll('.motion-scene');
  const allCaptions = document.querySelectorAll('.motion-caption');
  window.gsap.set(allScenes, { autoAlpha: 0 });
  timeline.set(allScenes, { autoAlpha: 0 }, 0);
  if (allCaptions.length) { window.gsap.set(allCaptions, { autoAlpha: 0 }); timeline.set(allCaptions, { autoAlpha: 0 }, 0); }
  function enter(shot, selector, from, to, offset, nominalDuration) {
    // Query inside the scene so every term in a comma-separated selector is scoped.
    const targets = document.getElementById(shot.id).querySelectorAll(selector);
    if (!targets.length) return;
    window.gsap.set(targets, from);
    timeline.set(targets, from, 0);
    const duration = Math.min(nominalDuration, shot.duration * .27);
    const time = shot.start + Math.min(offset, shot.duration * .4);
    timeline.fromTo(targets, from, { ...to, duration, ease: to.ease || 'power3.out', immediateRender: false }, time);
  }
  for (const shot of spec.shots) {
    const scene = document.getElementById(shot.id);
    timeline.set(scene, { autoAlpha: 1 }, shot.start);
    timeline.set(scene, { autoAlpha: 0 }, shot.start + shot.duration);
    enter(shot, '.motion-title', { y: 28, opacity: 0 }, { y: 0, opacity: 1 }, .07, .7);
    enter(shot, '.motion-note,.motion-source', { y: 12, opacity: 0 }, { y: 0, opacity: 1 }, .35, .55);
    switch (shot.recipe) {
      case 'title-reveal':
        enter(shot, '.eyebrow', { x: -24, opacity: 0 }, { x: 0, opacity: 1 }, .05, .5);
        enter(shot, '.hero-title', { yPercent: 110 }, { yPercent: 0 }, .16, .9);
        enter(shot, '.accent-rule', { scaleX: 0 }, { scaleX: 1 }, .35, .7);
        break;
      case 'photo-pan': {
        enter(shot, '.photo-window', { x: 36, opacity: 0 }, { x: 0, opacity: 1 }, .1, .8);
        enter(shot, '.accent-rule', { scaleX: 0 }, { scaleX: 1 }, .35, .7);
        const image = scene.querySelector('.pan-photo'), p = shot.params;
        const direction = { left: [-1,0], right:[1,0], up:[0,-1], down:[0,1], none:[0,0] }[p.pan];
        const from = { scale:p.zoomStart, xPercent:-1.3 * direction[0], yPercent:-1.3 * direction[1] };
        window.gsap.set(image, from); timeline.set(image, from, 0);
        timeline.fromTo(image, from, { scale:p.zoomEnd, xPercent:1.3 * direction[0], yPercent:1.3 * direction[1], duration:shot.duration, ease:'none', immediateRender:false }, shot.start);
        break;
      }
      case 'flow-steps': {
        const nodes = scene.querySelectorAll('.flow-node');
        nodes.forEach((node, i) => enter(shot, `.flow-node:nth-child(${i + 1})`, { y:28, opacity:0 }, { y:0, opacity:1 }, .25 + i * Math.min(.25, shot.duration*.07), .7));
        enter(shot, '.flow-connector', { scaleX:0, opacity:0 }, { scaleX:1, opacity:1 }, .55, .7);
        break;
      }
      case 'checklist': {
        const items = scene.querySelectorAll('.check-item');
        items.forEach((item,i) => {
          const prefix = `.check-item:nth-child(${i + 1})`;
          enter(shot, `${prefix} .check-copy`, { x:28, opacity:0 }, { x:0, opacity:1 }, .2 + i*.19, .6);
          enter(shot, `${prefix} .check-mark circle`, { strokeDashoffset:164, opacity:.5 }, { strokeDashoffset:0, opacity:.5 }, .2 + i*.19, .7);
          enter(shot, `${prefix} .check-mark path`, { strokeDashoffset:50 }, { strokeDashoffset:0 }, .4 + i*.19, .5);
        });
        break;
      }
      case 'comparison':
        enter(shot, '.compare-heading', { y:15, opacity:0 }, { y:0, opacity:1 }, .16, .6);
        enter(shot, '.compare-label,.compare-cell', { clipPath:'inset(0 0 100% 0)', opacity:0 }, { clipPath:'inset(0 0 0% 0)', opacity:1 }, .3, .8);
        break;
      case 'metric-bars':
        enter(shot, '.scale-note,.metric-top', { y:16, opacity:0 }, { y:0, opacity:1 }, .15, .6);
        scene.querySelectorAll('.metric-row').forEach((row,i) => enter(shot, `.metric-row:nth-of-type(${i + 1}) .metric-fill`, { scaleX:0 }, { scaleX:1 }, .25 + i*.2, .9));
        break;
      case 'quote-focus':
        enter(shot, '.quote-mark', { scale:.75, opacity:0 }, { scale:1, opacity:1 }, .1, .7);
        enter(shot, 'blockquote', { y:32, opacity:0 }, { y:0, opacity:1 }, .25, .85);
        enter(shot, '.accent-rule', { scaleX:0 }, { scaleX:1 }, .45, .7);
        enter(shot, '.quote-author', { x:22, opacity:0 }, { x:0, opacity:1 }, .5, .6);
        break;
      case 'lower-third':
        enter(shot, '.lower-panel', { x:shot.params.side === 'left' ? -42 : 42, opacity:0 }, { x:0, opacity:1 }, 0, .65);
        enter(shot, '.lower-accent', { scaleY:0 }, { scaleY:1 }, .1, .65);
        break;
    }
  }
  for (const caption of spec.captions) {
    const element = document.getElementById(caption.id);
    timeline.set(element, { autoAlpha:1 }, caption.start);
    timeline.set(element, { autoAlpha:0 }, caption.start + caption.duration);
  }
  window.__timelines = window.__timelines || {};
  window.__timelines[spec.compositionId] = timeline;
  timeline.seek(0, true).pause();
  window.__motionReady = true;
})();
