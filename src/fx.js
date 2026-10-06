// Visual effects: particles, floating text, rings, beams, banners.
//
// The simulation only describes an effect in a few numbers ("a puff of 10
// white bits at x, y") by pushing it to s.fx. This module turns those
// descriptions into live particles and animates them. Everything here is
// cosmetic and uses Math.random, so it never touches the game's own random
// numbers, and online only the short descriptions cross the network.
import { U } from './data.js';
import { prune } from './util.js';

const burntOut = (f) => f.life <= 0;
const LIFE = { puff: 0.45, text: 0.9, ring: 0.4, flash: 0.15, beam: 0.3, bite: 0.35, banner: 2.2, intro: 9 };

const live = [];
export const liveEffects = () => live;
export function resetEffects() { live.length = 0; }

function particle(x, y, vx, vy, col, size, life) {
  live.push({ kind: 'puff', x, y, vx, vy, col, size, life, max: life });
}

function burst(x, y, col, n, spd) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = spd * U * (0.4 + Math.random() * 0.8);
    particle(x, y, Math.cos(a) * v, Math.sin(a) * v, col, 2 + Math.random() * 3, LIFE.puff);
  }
}

// d: { kind, ...where and what } as pushed by the simulation (or received
// from the host, so anything odd is ignored rather than trusted).
export function spawnEffect(d) {
  if (!d || !(d.kind in LIFE)) return;
  // banners and new-monster cards sit on the screen, not in the world, so they have no position
  if (d.kind === 'banner' ? typeof d.txt !== 'string' : d.kind === 'intro' ? typeof d.type !== 'string' : !Number.isFinite(d.x + d.y)) return;
  if (d.kind === 'puff') { burst(d.x, d.y, d.col, Math.min(d.n | 0, 64), +d.spd || 0); return; }
  const life = Math.min(+d.life || LIFE[d.kind], 10);
  live.push({ ...d, life, max: life });
}

// Small trails that follow things around: dust behind dashing monsters,
// sparks behind fire bolts, splinters from a cottage being chewed.
export function spawnTrails(s, dt) {
  const base = s.m.base;
  for (const e of s.enemies) {
    if (e.dashing && Math.random() < dt * 30) particle(e.x, e.y, 0, 0, 'rgba(255,255,255,0.7)', 3, 0.25);
    if (e.atBase && Math.random() < dt * 2) burst(base.x + (e.x - base.x) * 0.5, base.y + (e.y - base.y) * 0.5, '#e8d9b5', 3, 50);
  }
  for (const p of s.projs) {
    if (p.kind === 'bolt' && Math.random() < dt * 40) particle(p.x, p.y, 0, -20, '#ffb347', 3 + Math.random() * 3, 0.3);
  }
}

export function updateEffects(dt) {
  const drag = Math.pow(0.9, dt * 60);
  for (const f of live) {
    f.life -= dt;
    if (f.kind === 'puff') { f.x += f.vx * dt; f.y += f.vy * dt; f.vx *= drag; f.vy *= drag; }
    else if (f.kind === 'text') f.y -= 28 * dt;
  }
  prune(live, burntOut);
}
