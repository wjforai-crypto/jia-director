/** Deterministic local-time evaluation. No DOM, wall-clock, GSAP easing or random. */
export const EASES = ['linear', 'smooth', 'cubic-in', 'cubic-out', 'gravity', 'inertia', 'spring', 'hermite'];
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export function response(track, p) {
  p = clamp(p, 0, 1);
  switch (track.ease || 'smooth') {
    case 'linear': return p;
    case 'smooth': return p * p * (3 - 2 * p);
    case 'cubic-in': return p * p * p;
    case 'cubic-out': return 1 - (1 - p) ** 3;
    case 'gravity': return p * p;
    case 'inertia': return (1 - Math.exp(-4 * p)) / (1 - Math.exp(-4));
    case 'spring': {
      const d = track.damping ?? 7, w = track.frequency ?? 12;
      return (1 - Math.exp(-d * p) * Math.cos(w * p)) / (1 - Math.exp(-d) * Math.cos(w));
    }
    default: return p;
  }
}
export function trackValue(track, t) {
  const p = clamp((t - track.start) / track.duration, 0, 1);
  if (track.ease === 'hermite') {
    const p2 = p * p, p3 = p2 * p;
    return (2 * p3 - 3 * p2 + 1) * track.from + (p3 - 2 * p2 + p) * (track.velocityFrom ?? 0) * track.duration
      + (-2 * p3 + 3 * p2) * track.to + (p3 - p2) * (track.velocityTo ?? 0) * track.duration;
  }
  return track.from + (track.to - track.from) * response(track, p);
}
export function evaluateAt(spec, time) {
  const t = clamp(time, 0, spec.canvas.duration);
  const camera = { ...spec.camera };
  const nodes = Object.fromEntries(spec.nodes.map(n => [n.id, { ...n, style: { ...n.style } }]));
  // Tracks are validated/sorted by property then local start at build time.
  for (const track of spec.tracks) {
    if (t < track.start) continue;
    const target = track.target === 'camera' ? camera : nodes[track.target];
    target[track.property] = trackValue(track, t);
  }
  return { time: t, camera, nodes };
}
export function project(spec, state, node, x = node.x, y = node.y) {
  const depthScale = 1 / (1 + node.depth / 1400);
  const scale = state.camera.zoom * depthScale;
  return { x: spec.canvas.width / 2 + (x - state.camera.x) * scale,
    y: spec.canvas.height / 2 + (y - state.camera.y) * scale, scale };
}
