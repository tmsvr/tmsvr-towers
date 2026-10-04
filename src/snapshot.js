// Packing the host's game state into compact snapshots, and rebuilding a
// render-ready state from them on the guest.
//
// The guest draws the world a little in the past (DELAY), blending between the
// two snapshots either side of that moment. Every snapshot carries the host's
// clock, so uneven arrival times don't turn into uneven movement, and one lost
// snapshot just means blending across a slightly longer gap.
import { T, ENEMIES, MAPS } from './data.js';
import { encodeSnapshot } from './schema.js';
import { spawnEffect } from './fx.js';
import { clamp } from './util.js';

const r1 = (v) => Math.round(v * 10) / 10;

const DELAY = 90;     // ms the guest's view trails the host: about three snapshots
const KEEP = 1000;    // ms of snapshots kept around
const MOVING = ['players', 'enemies', 'drops', 'projs', 'bombs'];
// Angles that should turn the short way round when blended.
const ANGLES = { players: ['dir'], enemies: ['ang'], projs: ['ang'] };

const packFx = (f) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, typeof v === 'number' ? r1(v) : v]));

// Effect descriptions and sound/shake events since the last snapshot. Sent on
// the reliable lane, since a lost snapshot must not lose a sound or a pop.
// `at` is the host clock, so the guest can show them in step with the world.
export function effectsMessage(fx, events, at) {
  return fx.length || events.length ? { t: 'fx', at, fx: fx.map(packFx), events } : null;
}

// The world as it is at host time `at`. Sent on the fast lane: any snapshot can
// be lost or arrive out of order, so each one is complete on its own.
// `ack` is the last guest input applied, for the guest's prediction.
export function makeSnapshot(s, seq, at, paused, ack) {
  return encodeSnapshot(s, { seq, at, paused, ack });
}

// The guest's state has the same shape as the host's wherever render.js
// reads it (see the top of that file); the _ fields are the guest's own.
export function newGuestState() {
  return {
    players: [], flowers: [], enemies: [], drops: [], projs: [], bombs: [], clouds: [], events: [],
    m: MAPS[0], grid: new Map(), queue: [], lives: 20, maxLives: 20, baseHitT: 0, wave: 0, phase: 'prep', timer: 0,
    over: false, won: false, kills: 0, paused: false,
    _frames: [], _shown: null, _offset: null, _waiting: [],
  };
}

// Host clock minus guest clock, as seen through the fastest recent delivery.
// A quicker-than-usual arrival is believed at once; slower ones only nudge it,
// so a late snapshot doesn't drag the whole view back.
function trackClock(gs, hostAt, now) {
  const o = hostAt - now;
  if (gs._offset === null || o > gs._offset || o < gs._offset - 500) gs._offset = o;
  else gs._offset += (o - gs._offset) * 0.02;
}

const hostNow = (gs, now) => now + gs._offset;

// A received snapshot (decoded by schema.js) made ready to draw.
function decode(m) {
  const u = m.state;
  // anything of a kind we don't know can't be drawn (the version check should prevent this)
  for (const e of u.enemies) e.def = ENEMIES[e.type];
  u.enemies = u.enemies.filter((e) => e.def);
  u.flowers = u.flowers.filter((f) => f.type);
  const fr = { seq: m.seq, at: m.at, paused: m.paused, ack: m.ack, game: u.game, clouds: u.clouds, flowers: u.flowers, byId: {} };
  for (const f of u.flowers) { f.x = (f.tx + 0.5) * T; f.y = (f.ty + 0.5) * T; }
  const W = (MAPS[u.game.map] || MAPS[0]).W;
  fr.grid = new Map(u.flowers.map((f) => [f.ty * W + f.tx, f]));
  const flowerById = new Map(u.flowers.map((f) => [f.id, f]));
  for (const p of u.players) {
    p.working = flowerById.get(p.working) || null;
    p.pick ||= { cursor: 0, chosen: [], ready: false, row: 1 }; // only sent on the pick screen
  }
  for (const key of MOVING) {
    fr[key] = u[key];
    const angles = ANGLES[key] || [];
    for (const o of u[key]) {
      // what the snapshot says; x, y (and angles) get rewritten every frame
      if (key === 'players') o.snap = { ...o }; // the guest's prediction starts from these
      else {
        o.snap = { x: o.x, y: o.y };
        for (const n of angles) o.snap[n] = o[n];
      }
    }
    fr.byId[key] = new Map(u[key].map((o) => [o.id, o]));
  }
  return fr;
}

export function applySnapshot(gs, m, now) {
  const frames = gs._frames;
  if (frames.length && m.seq <= frames[frames.length - 1].seq) return false; // overtaken by a newer one
  trackClock(gs, m.at, now);
  frames.push(decode(m));
  const oldest = m.at - KEEP;
  while (frames.length > 2 && frames[1].at < oldest) frames.shift();
  return true;
}

export function applyEffects(gs, m, now) {
  if (gs._offset === null) trackClock(gs, m.at, now);
  gs._waiting.push(m);
}

// The newest snapshot received (ahead of what's drawn).
export const newestFrame = (gs) => gs._frames[gs._frames.length - 1] || null;

const lerp = (a, b, k) => a + (b - a) * k;
function lerpAngle(a, b, k) {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + d * k;
}

// Show the world as it was DELAY ms ago on the host's clock.
export function interpolate(gs, now) {
  const frames = gs._frames;
  if (!frames.length) return;
  const t = hostNow(gs, now) - DELAY;
  let i = frames.length - 1;
  while (i > 0 && frames[i - 1].at > t) i--;
  // b is the first snapshot after t (or the newest), a the one before it
  const b = frames[i], a = i > 0 ? frames[i - 1] : b;
  const k = b === a ? 1 : clamp((t - a.at) / (b.at - a.at), 0, 1);

  if (gs._shown !== b) {
    gs._shown = b;
    gs.m = MAPS[b.game.map] || MAPS[0]; // the host may have picked another map
    Object.assign(gs, b.game, { paused: b.paused, grid: b.grid, flowers: b.flowers, clouds: b.clouds });
    for (const key of MOVING) gs[key] = b[key];
  }
  for (const key of MOVING) {
    const before = a.byId[key], angles = ANGLES[key] || [];
    for (const o of b[key]) {
      const p = a === b ? null : before.get(o.id);
      const from = p ? p.snap : o.snap, to = o.snap;
      o.x = lerp(from.x, to.x, k);
      o.y = lerp(from.y, to.y, k);
      for (const n of angles) o[n] = lerpAngle(from[n], to[n], k);
    }
  }
  releaseEffects(gs, t);
}

// Effects and sounds wait until the view reaches the moment they happened.
function releaseEffects(gs, t) {
  const waiting = gs._waiting;
  let n = 0;
  while (n < waiting.length && waiting[n].at <= t) n++;
  for (const m of waiting.splice(0, n)) {
    m.fx.forEach(spawnEffect);
    gs.events.push(...m.events);
  }
}
