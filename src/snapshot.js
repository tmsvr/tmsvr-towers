// Packing the host's game state into compact snapshots, and rebuilding a
// render-ready state from them on the guest (with smoothing between snapshots).
import { T, W, ENEMIES, FLOWER_ORDER, loadMap } from './data.js';

const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const MODES = ['grow', 'heal', 'dig'];

function packFx(f) {
  const o = {};
  for (const k in f) if (k !== '_sent') o[k] = typeof f[k] === 'number' ? r1(f[k]) : f[k];
  return o;
}

export function makeSnapshot(s, events, paused) {
  const fx = [];
  for (const f of s.fx) if (!f._sent) { f._sent = true; fx.push(packFx(f)); }
  return {
    t: 'snap', paused, fx, events,
    g: [r1(s.lives), s.wave, ['wave', 'prep', 'pick'].indexOf(s.phase), r1(s.timer), s.queue.length, s.over ? 1 : 0, s.won ? 1 : 0, s.kills, s.map, r2(s.baseHitT), s.maxLives],
    p: s.players.map((p) => [p.id, r1(p.x), r1(p.y), r2(p.dir), p.moving ? 1 : 0, r2(p.swingT), r2(p.swingDir || 0), r2(p.bombs), p.sel, MODES.indexOf(p.mode), p.working ? p.working.id : 0, r1(p.coins), r2(p.stun),
      p.loadout ? p.loadout.map((t) => FLOWER_ORDER.indexOf(t)) : 0,
      [p.pick.cursor, p.pick.chosen.map((t) => FLOWER_ORDER.indexOf(t)), p.pick.ready ? 1 : 0, p.pick.row], p.building ? 1 : 0, r2(p.dig || 0)]),
    f: s.flowers.map((f) => [f.id, FLOWER_ORDER.indexOf(f.type), f.lvl, f.tx, f.ty, r2(f.angle), r2(f.flash), r2(f.hurtT), r1(f.hp), f.headIdx, f.grow ? [f.grow.to, f.grow.cost, r1(f.grow.paid)] : 0, r1(f.spent || 0)]),
    e: s.enemies.map((e) => [e.id, e.type, r1(e.x), r1(e.y), r1(e.hp), r1(e.maxhp), r2(e.flash), r2(e.wob), r2(e.ang), r2(e.slowT), r2(e.stun), e.under ? 1 : 0, e.dashing ? 1 : 0, e.chew ? 1 : 0, e.psn, e.atBase ? 1 : 0]),
    d: s.drops.map((d) => [d.id, r1(d.x), r1(d.y), d.meat ? 1 : 0, r1(d.age)]),
    pr: s.projs.map((p) => [p.id, p.kind, r1(p.x), r1(p.y), p.big || 0, p.color, r2(p.ang || 0), r2(p.k || 0)]),
    b: s.bombs.map((b) => [b.id, r1(b.x), r1(b.y), r1(b.h)]),
    c: s.clouds.map((c) => [c.id, r1(c.x), r1(c.y), r1(c.r), r2(c.t), c.dur]),
  };
}

export function newGuestState() {
  return {
    players: [], flowers: [], enemies: [], drops: [], projs: [], bombs: [], clouds: [], fx: [], events: [],
    grid: new Map(), queue: { length: 0 }, lives: 20, wave: 0, phase: 'prep', timer: 0,
    over: false, won: false, kills: 0, paused: false, _at: 0, _interval: 33,
  };
}

// Each entity keeps where it was (ox, oy) and where the snapshot says it is now (nx, ny).
function withMotion(prevList, list) {
  const prev = new Map(prevList.map((o) => [o.id, o]));
  for (const o of list) {
    const p = prev.get(o.id);
    o.ox = p ? p.x : o.nx;
    o.oy = p ? p.y : o.ny;
    o.x = o.ox; o.y = o.oy;
  }
  return list;
}

export function applySnapshot(gs, m, now) {
  gs._interval = gs._at ? clamp(now - gs._at, 16, 250) : 33;
  gs._at = now;
  const [lives, wave, prep, timer, qlen, over, won, kills, map, baseHitT, maxLives] = m.g;
  if (gs.map !== map) { loadMap(map); gs.map = map; } // the host picked a different map
  Object.assign(gs, { lives, baseHitT, maxLives, wave, phase: ['wave', 'prep', 'pick'][prep], timer, over: !!over, won: !!won, kills, paused: m.paused });
  gs.queue = { length: qlen };

  gs.flowers = m.f.map(([id, ti, lvl, tx, ty, angle, flash, hurtT, hp, headIdx, g, spent]) => ({
    id, type: FLOWER_ORDER[ti], lvl, tx, ty, x: (tx + 0.5) * T, y: (ty + 0.5) * T, angle, flash, hurtT, hp, headIdx, spent,
    grow: g ? { to: g[0], cost: g[1], paid: g[2] } : null,
  }));
  gs.grid = new Map(gs.flowers.map((f) => [f.ty * W + f.tx, f]));
  const flowerById = new Map(gs.flowers.map((f) => [f.id, f]));

  gs.players = withMotion(gs.players, m.p.map(([id, nx, ny, dir, moving, swingT, swingDir, bombs, sel, mode, working, coins, stun, loadout, pick, building, dig]) => ({
    id, nx, ny, dir, moving: !!moving, swingT, swingDir, bombs, sel, mode: MODES[mode] || 'grow', dig, working: flowerById.get(working) || null, coins, stun, building: !!building,
    loadout: loadout ? loadout.map((i) => FLOWER_ORDER[i]) : null,
    pick: { cursor: pick[0], chosen: pick[1].map((i) => FLOWER_ORDER[i]), ready: !!pick[2], row: pick[3] },
  })));
  gs.enemies = withMotion(gs.enemies, m.e.map(([id, type, nx, ny, hp, maxhp, flash, wob, ang, slowT, stun, under, dashing, chew, psn, atBase]) => ({
    id, type, def: ENEMIES[type], nx, ny, hp, maxhp, flash, wob, ang, slowT, stun, under: !!under, dashing: !!dashing, chew: !!chew, psn, atBase: !!atBase,
  })));
  gs.drops = withMotion(gs.drops, m.d.map(([id, nx, ny, meat, age]) => ({ id, nx, ny, meat: !!meat, age })));
  gs.projs = withMotion(gs.projs, m.pr.map(([id, kind, nx, ny, big, color, ang, k]) => ({ id, kind, nx, ny, big, color, ang, k })));
  gs.bombs = withMotion(gs.bombs, m.b.map(([id, nx, ny, h]) => ({ id, nx, ny, h })));
  gs.clouds = m.c.map(([id, x, y, r, t, dur]) => ({ id, x, y, r, t, dur }));
  gs.fx.push(...m.fx);
  gs.events.push(...m.events);
}

// Slide everything from its previous position towards the latest snapshot.
export function interpolate(gs, now) {
  const a = clamp((now - gs._at) / gs._interval, 0, 1);
  for (const list of [gs.players, gs.enemies, gs.drops, gs.projs, gs.bombs]) {
    for (const o of list) { o.x = o.ox + (o.nx - o.ox) * a; o.y = o.oy + (o.ny - o.oy) * a; }
  }
}
