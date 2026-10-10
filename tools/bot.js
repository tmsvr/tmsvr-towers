// An autopilot that plays whole games through the real sim, for balance and
// difficulty checks. It copies how people actually play co-op, as measured in
// real game logs (20 online games, October 2026):
//  - roles: Boom guards the cottage (staying about 5 tiles from it), bonks
//    whatever is closest to getting in and bombs crowds whenever a bomb is
//    ready; Fern gardens. Each spends its own coins on flowers, and the guard
//    gardens too between waves.
//  - the garden: about 13 cheap flowers before wave 1, then 2-3 more a wave;
//    nearly all other coins go into upgrades, so little is ever saved up.
//  - a compact garden: flowers right next to the road where they reach a lot
//    of it, near the cottage, next to flowers already there and near where
//    the cat is standing; hurt flowers healed at about half health.
//  - cats walk everywhere (around trees and ponds) and nobody calls waves early.
//  - power-ups are picked up and used, chest perks chosen with some sense.
// A person still places and times things better, so treat the results as a
// slightly pessimistic estimate rather than a hard lower bound.
import * as sim from '../src/sim.js';
import { finishLog } from '../src/stats.js';
import { T, FLOWER_ORDER, FLOWERS, LOADOUT_SIZE, MAX_LEVEL, FLOWER_HP, PLAYER, CATS, ELITES, CHEST, flowerStats } from '../src/data.js';

// The habits measured in the logs; runBot({ habits }) can override any of them.
export const HABITS = {
  gardenStart: 13,     // flowers wanted by the first wave…
  gardenPerWave: 1.8,
  gardenRoad: 150,     // …on a map with this many road tiles (more road, more flowers)
  leakPlant: 3,        // after a wave that hurt the cottage, the garden grows this much more
  guardShare: 0.4,     // share of the garden that is the guard's own flower types (its fire lilies and thornroses do most damage)  // …and this many more each wave after
  healBelow: 55,       // health at which a flower gets healed
  bombCrowd: 3,        // monsters a bomb should catch (or a boss)
  guardRange: 9,       // tiles from the cottage the guard looks after
  guardSpends: 80,    // coins the guard carries before gardening mid-wave (unless the cottage is in danger)
  // how a spot is chosen: road it reaches, minus tiles from the cottage and from the cat
  spotCottage: 0.25,
  spotWalk: 0.25,
  spotRoads: 0.6,      // …plus this per flower the spot's least-guarded road is behind the best-guarded one
  frostShare: 0.3,     // at most this share of a cat's flowers are Frostblooms
};
// What people pick most for each role.
const LOADOUTS = { guard: ['thorn', 'firelily', 'sunflower'], gardener: ['daisy', 'stink', 'frost'], solo: ['daisy', 'thorn', 'frost'] };

// Walking directions around trees, rocks and ponds on map m: a breadth-first
// distance field from the target tile, cached per target.
const fields = new Map();
function field(m, tx, ty) {
  const { W, H } = m;
  const key = ty * W + tx;
  let d = fields.get(key);
  if (d) return d;
  d = new Int32Array(W * H).fill(-1);
  d[key] = 0;
  const q = [key];
  for (let i = 0; i < q.length; i++) {
    const k = q[i], x = k % W, y = (k - x) / W;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      const nk = ny * W + nx;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H || d[nk] >= 0 || m.solids.has(nk)) continue;
      d[nk] = d[k] + 1;
      q.push(nk);
    }
  }
  fields.set(key, d);
  return d;
}

// Direction for cat p to walk towards (x, y) on map m, going around obstacles.
function towards(m, p, x, y) {
  const { W, H } = m;
  const tx = Math.floor(x / T), ty = Math.floor(y / T), px = Math.floor(p.x / T), py = Math.floor(p.y / T);
  if (Math.abs(tx - px) + Math.abs(ty - py) <= 1) return [x - p.x, y - p.y];
  const d = field(m, tx, ty);
  let best = null, bd = d[py * W + px] >= 0 ? d[py * W + px] : 1e9;
  for (const [nx, ny] of [[px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]]) {
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    const v = d[ny * W + nx];
    if (v >= 0 && v < bd) { bd = v; best = [nx, ny]; }
  }
  if (!best) return [x - p.x, y - p.y];
  return [(best[0] + 0.5) * T - p.x, (best[1] + 0.5) * T - p.y];
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
// The item of `list` nearest to p (never reorders the game's own lists).
const nearest = (list, p) => list.reduce((best, o) => (!best || dist(o, p) < dist(best, p) ? o : best), null);
const onTile = (p, tx, ty) => Math.floor(p.x / T) === tx && Math.floor(p.y / T) === ty;

// onTick(s, jobs, roles), if given, is called after every tick (for watching what the bot does).
export function runBot({ players = 2, seed = 1, loadouts, cats, map = 0, maxMinutes = 40, habits = {}, onTick } = {}) {
  const H = { ...HABITS, ...habits };
  cats ??= players > 1 ? ['bomber', 'gardener'] : ['gardener'];
  const s = sim.createState(players, seed, { map, cats });
  const m = s.m, base = m.base;
  fields.clear();
  // the gardener is Fern if she's playing (else P2); everyone else guards
  const fern = s.players.findIndex((p) => p.cat === 'gardener');
  const gi = players === 1 ? -1 : fern >= 0 ? fern : 1;
  const roles = s.players.map((p, i) => (players === 1 ? 'solo' : i === gi ? 'gardener' : 'guard'));
  s.players.forEach((p, i) => {
    const pick = loadouts?.[i] || LOADOUTS[roles[i]];
    p.pick.chosen = pick.length === LOADOUT_SIZE ? pick.slice() : FLOWER_ORDER.slice(0, LOADOUT_SIZE);
    p.pick.ready = true;
  });
  sim.step(s, s.players.map(() => ({})), 1 / 60);

  // ---- where flowers go ----
  const roadTiles = m.paths.map((path) => {
    const set = new Set();
    const pts = path.points;
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) set.add(y * m.W + x);
    }
    return set;
  });
  const roadsNear = (x, y) => roadTiles.map((set, i) => {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (set.has((y + dy) * m.W + x + dx)) return i;
    return -1;
  }).filter((i) => i >= 0);
  // How much road a flower on (x, y) would reach (people put 80% of flowers
  // right next to the road, covering about 7 road tiles).
  const coverage = (x, y) => {
    let n = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (dx * dx + dy * dy <= 5.3 && m.pathTiles.has((y + dy) * m.W + x + dx)) n++;
    return n;
  };
  const spots = [];
  const bx = Math.floor(base.x / T), by = Math.floor(base.y / T);
  for (let y = 0; y < m.H; y++) for (let x = 0; x < m.W; x++) {
    if (!sim.canBuildAt(s, x, y)) continue;
    const n = coverage(x, y);
    const near = roadsNear(x, y);
    if (n >= 3) spots.push({ x, y, n: n + 0.5 * (near.length - 1), home: Math.hypot(x - bx, y - by), near });
  }
  const cover = new Map(spots.map((o) => [o.y * m.W + o.x, o.n]));
  // The best free spot for cat p, not one the other cat is already heading for.
  // Every road gets its share: monsters (and bosses) take whichever one they like.
  const nextSpot = (p, taken) => {
    let best = null, bs = -1e9;
    const px = p.x / T, py = p.y / T;
    const per = roadTiles.map(() => 0);
    for (const f of s.flowers) for (const r of roadsNear(f.tx, f.ty)) per[r]++;
    const most = Math.max(...per);
    for (const o of spots) {
      if (taken.has(o.y * m.W + o.x) || !sim.canBuildAt(s, o.x, o.y)) continue;
      const behind = o.near.length ? Math.max(...o.near.map((r) => most - per[r])) : 0;
      const v = o.n + H.spotRoads * behind - H.spotCottage * o.home - H.spotWalk * (Math.abs(o.x + 0.5 - px) + Math.abs(o.y + 0.5 - py));
      if (v > bs) { bs = v; best = o; }
    }
    return best && [best.x, best.y];
  };

  // Which flower of p's loadout to plant next: an even mix, few Frostblooms,
  // and Sunflowers (expensive superweapons) only from wave 2, one per few waves.
  const sunDue = (p) => p.loadout.includes('sunflower') && s.wave >= 2 && s.flowers.filter((f) => f.type === 'sunflower').length < 1 + Math.floor(s.wave / 4);
  const pickType = (p) => {
    if (sunDue(p) && sim.plantPrice(p, 'sunflower') <= p.coins) return 'sunflower';
    const mine = s.flowers.filter((f) => p.loadout.includes(f.type));
    const count = (t) => mine.filter((f) => f.type === t).length;
    const ok = p.loadout.filter((t) => t !== 'sunflower' && sim.plantPrice(p, t) <= p.coins
      && (t !== 'frost' || count(t) < Math.max(1, H.frostShare * (mine.length + 1))));
    ok.sort((a, b) => count(a) - count(b));
    return ok[0] || null;
  };
  let extra = 0; // people widen the garden after the cottage gets hurt
  const wantGarden = () => (H.gardenStart + H.gardenPerWave * s.wave) * (m.pathTiles.size / H.gardenRoad) + extra;
  // Worth upgrading: lots of road in reach, a low level, not a Frostbloom first.
  // Level 5 is worth a push: it stops wearing out.
  const upgradeValue = (f) => (cover.get(f.ty * m.W + f.tx) || 3) * (f.type === 'frost' ? 0.6 : 1) * (f.lvl === MAX_LEVEL - 1 ? 1.5 : 1) / (1 + f.lvl);
  // How much of the garden is the guard's (types only it can plant count fully, shared ones half).
  const guardShare = () => {
    const g = s.players.filter((p, i) => roles[i] === 'guard'), o = s.players.filter((p, i) => roles[i] !== 'guard');
    if (!g.length || !s.flowers.length) return 1;
    const has = (list, t) => list.some((p) => p.loadout.includes(t));
    return s.flowers.reduce((a, f) => a + (has(g, f.type) ? (has(o, f.type) ? 0.5 : 1) : 0), 0) / s.flowers.length;
  };

  // ---- a cat's gardening job: heal, finish a seedling, plant, upgrade ----
  // The two cats never take the same flower or spot.
  function gardenJob(p, i) {
    if (p.coins < 5) return null;
    const other = jobs.filter((j, k) => j && k !== i);
    const busy = new Set(other.map((j) => (j.f ? j.f.ty * m.W + j.f.tx : j.ty * m.W + j.tx)));
    const free = (f) => !f.dead && !busy.has(f.ty * m.W + f.tx);
    const near = (list) => nearest(list, p);
    const hurt = near(s.flowers.filter((f) => free(f) && f.lvl > 0 && f.lvl < MAX_LEVEL && f.hp < H.healBelow));
    if (hurt) return { kind: 'heal', f: hurt };
    const half = near(s.flowers.filter((f) => free(f) && f.grow));
    if (half) return { kind: 'grow', f: half, lvl: half.lvl };
    // a Sunflower is due: plant it once there's enough, saving up until then (heals still come first)
    if (sunDue(p)) {
      const spot = sim.plantPrice(p, 'sunflower') <= p.coins && nextSpot(p, busy);
      return spot ? { kind: 'plant', type: 'sunflower', tx: spot[0], ty: spot[1] } : null;
    }
    const planned = s.flowers.length + other.filter((j) => j.kind === 'plant').length;
    // each cat can only plant its own types, so the gardener leaves room for the guard's
    const share = guardShare(), role = roles[i];
    const guards = s.players.filter((o, k) => roles[k] === 'guard');
    const guardBroke = guards.every((o) => o.loadout.every((t) => sim.plantPrice(o, t) > o.coins));
    const myTurn = role === 'solo' || s.wave <= 1 || (role === 'guard' ? share < H.guardShare + 0.1 : share >= H.guardShare || guardBroke);
    if (planned < wantGarden() && myTurn) {
      const type = pickType(p), spot = type && nextSpot(p, busy);
      if (spot) return { kind: 'plant', type, tx: spot[0], ty: spot[1] };
    }
    const walk = (f) => 1 + 0.08 * (Math.abs(f.x - p.x) + Math.abs(f.y - p.y)) / T;
    const up = s.flowers.filter((f) => free(f) && f.lvl > 0 && f.lvl < MAX_LEVEL).sort((a, b) => upgradeValue(b) / walk(b) - upgradeValue(a) / walk(a))[0];
    if (up && p.coins >= 10) return { kind: 'grow', f: up, lvl: up.lvl };
    return null;
  }
  const jobDone = (p, j) => {
    if (j.f && j.f.dead) return true;
    if (j.kind === 'heal') return j.f.hp >= FLOWER_HP - 0.5 || p.coins < 1;
    if (j.kind === 'grow') return (j.f.lvl > j.lvl && !j.f.grow) || p.coins < 1;
    if (j.kind === 'plant') return !!s.grid.get(j.ty * m.W + j.tx) || !sim.canBuildAt(s, j.tx, j.ty);
    return true;
  };
  // Walk to the job and do it. Returns the inputs for this tick.
  function doJob(p, j, inp) {
    const tx = j.f ? j.f.tx : j.tx, ty = j.f ? j.f.ty : j.ty;
    if (!onTile(p, tx, ty)) { [inp.mx, inp.my] = towards(m, p, (tx + 0.5) * T, (ty + 0.5) * T); return; }
    if (j.kind === 'heal') inp.heal = true;
    else if (j.kind === 'grow') { p.mode = 'grow'; inp.build = !p.waitRelease; }
    else { p.sel = p.loadout.indexOf(j.type); inp.buildTap = true; } // first tap shows it, the next plants it
  }

  // ---- fighting ----
  const atkRange = (p) => sim.catStats(p).atkRange;
  const enemiesNear = (pt, r) => s.enemies.filter((e) => sim.hittable(e) && dist(e, pt) <= r);
  function fight(p, e, inp) {
    const d = dist(e, p);
    if (d < atkRange(p) + e.def.r * 0.5) { p.dir = Math.atan2(e.y - p.y, e.x - p.x); inp.atk = true; }
    else [inp.mx, inp.my] = towards(m, p, e.x, e.y);
  }
  // A bomb lands bombThrowDistance ahead: throw it when the crowd (or a
  // shielded boss) is about that far away, and never onto the other cat.
  function bombTarget(p) {
    const cs = sim.catStats(p), R = cs.bombRadius;
    const shielded = s.enemies.find((e) => e.shield > 0 && sim.hittable(e));
    if (shielded) return shielded;
    let best = null, bestN = H.bombCrowd - 1;
    for (const e of enemiesNear(p, PLAYER.bombRange + T * 3)) {
      const n = enemiesNear(e, R).length + (e.def.boss ? 3 : 0);
      if (n > bestN) { bestN = n; best = e; }
    }
    return best;
  }
  function tryBomb(p, target, inp) {
    const d = dist(target, p);
    if (d > PLAYER.bombRange + T * 1.5) { [inp.mx, inp.my] = towards(m, p, target.x, target.y); return true; }
    if (d < T * 2) { inp.mx = p.x - target.x || 1; inp.my = p.y - target.y; return true; } // too close to throw: back off a step
    const a = Math.atan2(target.y - p.y, target.x - p.x);
    const land = { x: p.x + Math.cos(a) * PLAYER.bombRange, y: p.y + Math.sin(a) * PLAYER.bombRange };
    if (s.players.some((o) => o !== p && dist(o, land) < sim.catStats(p).bombRadius + T * 0.4)) return false;
    p.dir = a; inp.mx = inp.my = 0; inp.bomb = true;
    return true;
  }

  // ---- power-ups and chests ----
  function itemJob(p) {
    if (!p.item) return null;
    const grown = s.flowers.filter((f) => !f.dead && f.lvl > 0);
    if (p.item === 'fertiliser') {
      const f = grown.filter((g) => g.lvl < MAX_LEVEL).sort((a, b) => b.lvl - a.lvl || upgradeValue(b) - upgradeValue(a))[0];
      return f && { kind: 'use', f };
    }
    if (p.item === 'sun' && s.phase === 'wave') {
      const f = grown.map((g) => [g, enemiesNear(g, flowerStats(g.type, g.lvl).range).length]).sort((a, b) => b[1] - a[1])[0];
      return f && f[1] >= 2 && { kind: 'use', f: f[0] };
    }
    if (p.item === 'water') {
      const r = (ELITES.items?.water?.radius ?? 3) * T;
      const f = grown.map((g) => [g, grown.filter((o) => o.lvl < MAX_LEVEL && o.hp < 70 && dist(o, g) <= r).length]).sort((a, b) => b[1] - a[1])[0];
      return f && f[1] >= 3 && { kind: 'use', f: f[0] };
    }
    return null;
  }
  const snowNow = () => s.enemies.filter((e) => e.atBase).length >= 2 || enemiesNear(base, T * 4).length >= 8;
  function pickPerk(p, i) {
    const ch = s.chest, offers = ch.offers[i];
    const rank = (o) => {
      const id = o.split(':')[0];
      if (id === 'roof') return s.lives < s.maxLives * 0.6 ? 10 : 2;
      return { roots: 8, fourth: 5, thumb: 6, stems: 3, paws: roles[i] === 'guard' ? 2 : 7, pouch: roles[i] === 'guard' ? 7 : 1 }[id] ?? 1;
    };
    ch.cursor[i] = offers.indexOf([...offers].sort((a, b) => rank(b) - rank(a))[0]);
  }

  const jobs = s.players.map(() => null);
  const log = [];
  let lastWave = 0, lastLives = s.lives;
  for (let tick = 0; tick < 60 * 60 * maxMinutes && !s.over && !s.won; tick++) {
    const inputs = s.players.map(() => ({}));
    if (s.chest) {
      s.players.forEach((p, i) => { if (s.chest.picked[i] == null) { pickPerk(p, i); inputs[i].buildTap = true; } });
      sim.step(s, inputs, 1 / 60);
      continue;
    }
    s.players.forEach((p, i) => {
      const inp = inputs[i], role = roles[i];
      if (p.stun > 0) { jobs[i] = null; return; }
      const chomper = s.enemies.find((e) => e.atBase && sim.hittable(e));
      if (p.item === 'snow' && snowNow()) { inp.use = true; return; }
      // a power-up lying nearby is worth a detour (unless the cottage is being eaten)
      const it = !chomper && nearest(s.items.filter((x) => dist(x, p) < T * 8), p);
      if (it && (!p.item || role !== 'gardener')) { [inp.mx, inp.my] = towards(m, p, it.x, it.y); return; }

      if (role === 'guard' || role === 'solo') {
        // the guard: shields and crowds get bombed, the cottage gets defended
        const zone = s.enemies.filter((e) => sim.hittable(e) && dist(e, base) < H.guardRange * T);
        if (p.bombs >= 1) {
          const tgt = bombTarget(p);
          if (tgt && (tgt.shield > 0 || dist(tgt, base) < (H.guardRange + 4) * T) && tryBomb(p, tgt, inp)) return;
        }
        // the guard fights what is near the cottage; with full pockets it gardens
        // unless something is about to get in (and so does the solo cat)
        const foe = chomper || zone.sort((a, b) => a.left - b.left)[0];
        const rich = p.coins >= (role === 'solo' ? 20 : H.guardSpends);
        const danger = chomper || (foe && dist(foe, base) < T * 3);
        if (foe && (danger || !rich)) { jobs[i] = null; fight(p, foe, inp); return; }
        if (role === 'guard' && s.phase === 'wave' && !rich) {
          const coin = nearest(s.drops.filter((d) => dist(d, base) < (H.guardRange + 3) * T), p);
          if (coin) [inp.mx, inp.my] = towards(m, p, coin.x, coin.y);
          else if (dist(p, base) > T * 4) [inp.mx, inp.my] = towards(m, p, base.x, base.y + T * 2);
          return;
        }
      } else {
        // the gardener helps when the cottage is eaten and the guard is away,
        // and otherwise only bonks what comes close while it has nothing to do
        if (!jobs[i] && tick % 10 === i * 5) jobs[i] = gardenJob(p, i); // a job first: fighting is for when there's nothing to spend on
        if (!jobs[i]) {
          const close = enemiesNear(p, atkRange(p) + T * 0.3)[0];
          if (close) { fight(p, close, inp); return; }
          const guardAway = s.players.every((o, k) => roles[k] !== 'guard' || dist(o, base) > T * 6);
          if (chomper && guardAway) { fight(p, chomper, inp); return; }
        }
      }
      // gardening (and power-ups that need a flower)
      const use = itemJob(p);
      if (use) {
        if (onTile(p, use.f.tx, use.f.ty)) inp.use = true;
        else [inp.mx, inp.my] = towards(m, p, use.f.x, use.f.y);
        return;
      }
      if (jobs[i] && jobDone(p, jobs[i])) jobs[i] = null;
      if (!jobs[i] && tick % 10 === i * 5) jobs[i] = gardenJob(p, i);
      if (jobs[i]) { doJob(p, jobs[i], inp); return; }
      // nothing to do: pick up coins
      const coin = nearest(s.drops, p);
      if (coin && dist(coin, p) < T * 10) [inp.mx, inp.my] = towards(m, p, coin.x, coin.y);
    });
    sim.step(s, inputs, 1 / 60);
    onTick?.(s, jobs, roles, inputs);
    s.events.length = 0;
    s.fx.length = 0;
    if (s.wave !== lastWave) {
      if (lastLives - s.lives > 5) extra += H.leakPlant;
      lastLives = s.lives;
      lastWave = s.wave;
      log.push({ wave: s.wave, lives: s.lives, coins: s.players.map((p) => Math.floor(p.coins)), flowers: s.flowers.length, levels: s.flowers.reduce((a, f) => a + f.lvl, 0) });
    }
  }
  // game: the same detailed log a real game saves (see src/stats.js)
  return { won: s.won, wave: s.wave, lives: s.lives, log, game: finishLog(s, s.won ? 'won' : s.over ? 'lost' : 'timeout') };
}
