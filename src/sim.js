// Game simulation. No DOM/canvas/audio access: state in, inputs in, state out.
// Inputs per player per tick: { mx, my, atk, bomb, build (held), buildTap, cycle, ready }
// Side effects for presentation (sounds, shake) are queued in s.events.
import {
  T, U, W, H, WORLD_W, WORLD_H, VIEW_W, MAP_H, TOTAL_WAVES, WAYPOINTS, SPAWN, BASE, PATH_TILES, ENEMIES,
  FLOWER_ORDER, FLOWERS, MAX_LEVEL, GROW_TIME, FLOWER_HP, WEAR_PER_SEC, WEAR_MULT, HEAL_RATE, HEAL_COST,
  CHEW_DPS, POISON_TIME, START_COINS, LOADOUT_SIZE, flowerStats, upgradeCost, PLAYER,
} from './data.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function rnd(s) {
  s.rng = (s.rng + 0x6d2b79f5) | 0;
  let t = Math.imul(s.rng ^ (s.rng >>> 15), 1 | s.rng);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// Difficulty knobs (exported so balance can be swept from the console).
export const TUNE = { hpLinear: 0.3, hpQuad: 0.015, budgetBase: 8, budgetPerWave: 11, coinMult: 1, waveBonus: 1, soloWaves: 0.6 };

// sharedScreen: both cats share one camera, so they can't wander further apart than the view.
// loadouts: last game's flower picks per player, pre-selected on the pick screen.
export function createState(nPlayers = 1, seed = 1337, { sharedScreen = false, loadouts = [] } = {}) {
  const s = {
    t: 0, nextId: 1, rng: seed, wave: 0, phase: 'pick', timer: 30, queue: [], spawnWait: 0,
    lives: 20, players: [], flowers: [], enemies: [], drops: [], bombs: [], projs: [], clouds: [],
    fx: [], events: [], grid: new Map(), over: false, won: false, kills: 0, sharedScreen,
  };
  const coins = nPlayers > 1 ? START_COINS.coop : START_COINS.solo;
  for (let i = 0; i < nPlayers; i++) {
    s.players.push({
      id: i, x: (5 + i) * T, y: 6 * T, dir: 0, atkCd: 0, swingT: 0, coins, stun: 0,
      bombs: PLAYER.bombMax, sel: 0, moving: false, mode: 'grow', onFlowerId: null, working: null, msgCd: 0,
      loadout: null, pick: { cursor: 0, chosen: (loadouts[i] || []).filter((t) => FLOWERS[t]).slice(0, LOADOUT_SIZE), ready: false },
      prevMx: 0, prevAtk: false,
    });
  }
  return s;
}

const ev = (s, type, extra) => s.events.push({ type, ...extra });

function text(s, x, y, txt, col = '#fff') {
  s.fx.push({ kind: 'text', x, y, txt, col, life: 0.9, max: 0.9 });
}

function puff(s, x, y, col, n = 6, spd = 90) {
  for (let i = 0; i < n; i++) {
    const a = rnd(s) * Math.PI * 2;
    const v = spd * U * (0.4 + rnd(s) * 0.8);
    s.fx.push({ kind: 'puff', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, col, size: 2 + rnd(s) * 3, life: 0.45, max: 0.45 });
  }
}

export function tileOf(p) {
  return { tx: clamp(Math.floor(p.x / T), 0, W - 1), ty: clamp(Math.floor(p.y / T), 0, H - 1) };
}

export function canBuildAt(s, tx, ty) {
  const k = ty * W + tx;
  return !PATH_TILES.has(k) && !s.grid.has(k);
}

export const healCostPerHp = (f) => (FLOWERS[f.type].cost * HEAL_COST) / FLOWER_HP;

// ---- Enemies --------------------------------------------------------------
function spawnEnemy(s, type, from) {
  const d = ENEMIES[type];
  const w = Math.max(0, s.wave - 1);
  const hpScale = (1 + w * TUNE.hpLinear + w * w * TUNE.hpQuad) * (d.boss && s.players.length === 1 ? TUNE.soloWaves : 1);
  const j = () => (rnd(s) - 0.5) * 18 * U;
  s.enemies.push({
    id: s.nextId++, type, def: d,
    x: from ? from.x + j() : SPAWN.x, y: from ? from.y + j() : SPAWN.y,
    seg: from ? from.seg : 0, dist: from ? from.dist : 0,
    hp: d.hp * hpScale, maxhp: d.hp * hpScale,
    stun: 0, slow: 1, slowT: 0, kx: 0, ky: 0, flash: 0, dead: false, wob: rnd(s) * 6, ang: 0,
    phaseT: rnd(s) * 2, spawnT: 0, under: false, dashing: false, chew: null, chewT: 0, chewCd: 1,
    psn: 0, psnT: 0, psnDps: 0,
  });
}

// Whether flowers, bombs and batons can touch this enemy right now.
export const hittable = (e) => !e.dead && !e.under;

export function damage(s, e, amt, ignoreArmor = false, quiet = false) {
  if (e.dead) return;
  e.hp -= ignoreArmor ? amt : Math.max(1, amt - e.def.armor);
  if (!quiet) e.flash = 0.1;
  if (e.hp <= 0) killEnemy(s, e);
}

function killEnemy(s, e) {
  e.dead = true;
  s.kills++;
  puff(s, e.x, e.y, '#ffffff', 10, 110);
  ev(s, e.def.boss ? 'bossDie' : 'die');
  if (e.def.boss) ev(s, 'shake', { amt: 10 });
  if (e.def.split) {
    for (let i = 0; i < e.def.split.n; i++) spawnEnemy(s, e.def.split.type, e);
    puff(s, e.x, e.y, '#e08ae8', 12, 120);
    ev(s, 'split');
  }
  const v = Math.max(1, Math.round(e.def.coin * TUNE.coinMult));
  // Large drops split into a few pickups so they scatter nicely.
  const pieces = v >= 20 ? 6 : v >= 5 ? 2 : 1;
  const base = Math.floor(v / pieces);
  for (let i = 0; i < pieces; i++) {
    const val = i === pieces - 1 ? v - base * (pieces - 1) : base;
    const a = rnd(s) * Math.PI * 2;
    const sp = (pieces > 1 ? 50 + rnd(s) * 60 : 20) * U;
    s.drops.push({ id: s.nextId++, x: e.x, y: e.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, value: val, age: 0, meat: val >= 4 });
  }
}

function applyStun(e, dur) {
  e.stun = Math.max(e.stun, e.def.boss ? dur * 0.3 : dur);
  e.chew = null;
}

function updateEnemies(s, dt) {
  for (const e of s.enemies) {
    if (e.dead) continue;
    e.flash = Math.max(0, e.flash - dt);
    if (e.slowT > 0) { e.slowT -= dt; if (e.slowT <= 0) e.slow = 1; }
    if (e.psnT > 0) {
      e.psnT -= dt;
      damage(s, e, e.psn * e.psnDps * dt, true, true);
      if (e.psnT <= 0) e.psn = 0;
      if (e.dead) continue;
    }
    if (e.kx || e.ky) {
      e.x += e.kx * dt; e.y += e.ky * dt;
      const f = Math.pow(0.002, dt);
      e.kx *= f; e.ky *= f;
      if (Math.abs(e.kx) + Math.abs(e.ky) < 4) e.kx = e.ky = 0;
    }
    if (e.def.heals) {
      for (const o of s.enemies) {
        if (o !== e && !o.dead && o.hp < o.maxhp && dist(o, e) < 80 * U) o.hp = Math.min(o.maxhp, o.hp + 7 * dt);
      }
    }
    if (e.stun > 0) { e.stun -= dt; continue; }
    if (e.def.spawns) {
      e.spawnT += dt;
      if (e.spawnT >= e.def.spawns.every) {
        e.spawnT = 0;
        for (let i = 0; i < e.def.spawns.n; i++) spawnEnemy(s, e.def.spawns.type, e);
        ev(s, 'spawn');
      }
    }
    if (e.def.burrow) {
      e.phaseT += dt;
      if (e.phaseT >= (e.under ? 1.8 : 2.6)) {
        e.phaseT = 0;
        e.under = !e.under;
        puff(s, e.x, e.y, '#8a6038', 8, 70);
        ev(s, 'burrow');
      }
    }
    if (e.def.dash) {
      e.phaseT += dt;
      const was = e.dashing;
      e.dashing = e.phaseT % 2.4 > 1.85;
      if (e.dashing && !was) ev(s, 'dash');
    }
    if (e.def.eats) {
      if (e.chew) {
        if (e.chew.dead) e.chew = null;
        else {
          e.chewT -= dt;
          e.wob += dt * 14;
          hurtFlower(s, e.chew, CHEW_DPS * dt);
          ev(s, 'chomp');
          if (e.chewT <= 0) { e.chew = null; e.chewCd = 4; }
          continue;
        }
      } else if ((e.chewCd -= dt) <= 0) {
        const f = s.flowers.find((f) => !f.dead && f.lvl < MAX_LEVEL && dist(e, f) < T * 1.25);
        if (f) { e.chew = f; e.chewT = 3.5; e.ang = Math.atan2(f.y - e.y, f.x - e.x); continue; }
      }
    }
    e.wob += dt * 8 * e.slow;
    const sp = e.def.speed * U * e.slow * (e.dashing ? 3.2 : 1) * (e.under ? 1.5 : 1);
    const tgt = e.def.flying ? BASE : WAYPOINTS[e.seg];
    const dx = tgt.x - e.x, dy = tgt.y - e.y;
    const d = Math.hypot(dx, dy);
    const mv = Math.min(sp * dt, d);
    if (d > 0) { e.x += (dx / d) * mv; e.y += (dy / d) * mv; e.ang = Math.atan2(dy, dx); }
    e.dist += mv;
    if (e.dashing && rnd(s) < dt * 30) s.fx.push({ kind: 'puff', x: e.x, y: e.y, vx: 0, vy: 0, col: 'rgba(255,255,255,0.7)', size: 3, life: 0.25, max: 0.25 });
    if (d - mv < 1) {
      if (e.def.flying || e.seg >= WAYPOINTS.length - 1) leak(s, e);
      else e.seg++;
    }
  }
}

function leak(s, e) {
  e.dead = true;
  s.lives -= e.def.leak;
  text(s, BASE.x, BASE.y - T * 0.6, `-${e.def.leak} ❤`, '#ff5555');
  puff(s, BASE.x, BASE.y, '#ff5555', 10);
  ev(s, 'leak');
  ev(s, 'shake', { amt: 5 });
  if (s.lives <= 0) { s.lives = 0; s.over = true; ev(s, 'lose'); }
}

// ---- Waves ----------------------------------------------------------------
const UNLOCK = [
  // type, first wave, weight, budget cost, group size
  ['grunt', 1, 5, 1, 1], ['swarm', 2, 3, 2, 5], ['runner', 3, 2, 1.3, 1], ['dasher', 3, 3, 1.5, 1],
  ['flyer', 4, 2, 1.6, 1], ['splitter', 4, 3, 3, 1], ['aphid', 5, 3, 1.6, 1], ['shield', 5, 2, 2.5, 1],
  ['tank', 6, 2, 4.5, 1], ['mole', 6, 3, 2, 1], ['healer', 7, 2, 3, 1], ['hive', 8, 2, 5, 1],
  ['wasp', 9, 2, 3, 3],
];

function buildQueue(s, n) {
  const q = [];
  let budget = (TUNE.budgetBase + n * TUNE.budgetPerWave) * (s.players.length > 1 ? 1 : TUNE.soloWaves);
  const avail = UNLOCK.filter((u) => u[1] <= n);
  if (n % 5 === 0) budget *= 0.6;
  while (budget > 0) {
    const total = avail.reduce((a, u) => a + u[2], 0);
    let r = rnd(s) * total, pick = avail[0];
    for (const u of avail) { r -= u[2]; if (r <= 0) { pick = u; break; } }
    for (let i = 0; i < pick[4]; i++) q.push({ type: pick[0], wait: pick[4] > 1 ? 0.22 : 0.4 + rnd(s) * 0.8 });
    budget -= pick[3];
  }
  if (n % 5 === 0) q.push({ type: 'boss', wait: 3 });
  const k = Math.max(0.5, 1 - n * 0.03);
  for (const e of q) e.wait *= k;
  return q;
}

function startWave(s) {
  s.wave++;
  s.phase = 'wave';
  s.queue = buildQueue(s, s.wave);
  s.spawnWait = 0.5;
  const boss = s.wave % 5 === 0;
  s.fx.push({ kind: 'banner', txt: boss ? `Wave ${s.wave} — BOSS!` : `Wave ${s.wave}`, life: 2.2, max: 2.2 });
  ev(s, boss ? 'boss' : 'wave');
}

function updateWaves(s, dt, ready) {
  if (s.phase === 'prep') {
    s.timer -= dt;
    if (ready) s.timer = Math.min(s.timer, 0);
    if (s.timer <= 0) startWave(s);
    return;
  }
  if (s.queue.length) {
    s.spawnWait -= dt;
    if (s.spawnWait <= 0) {
      const e = s.queue.shift();
      spawnEnemy(s, e.type);
      s.spawnWait = e.wait;
    }
  } else if (!s.enemies.some((e) => !e.dead)) {
    if (s.wave >= TOTAL_WAVES) { s.won = true; ev(s, 'win'); return; }
    s.phase = 'prep';
    s.timer = 15;
    // Everyone gets a share; in co-op each cat gets a bit more than half.
    const bonus = Math.round((10 + s.wave * 2) * TUNE.waveBonus * (s.players.length > 1 ? 0.6 : 1));
    for (const p of s.players) p.coins += bonus;
    s.fx.push({ kind: 'banner', txt: `Wave cleared!  +${bonus} each`, life: 2.2, max: 2.2 });
    ev(s, 'clear');
  }
}

// ---- Players --------------------------------------------------------------
function swing(s, p) {
  p.atkCd = PLAYER.atkCd;
  p.swingT = 0.18;
  p.swingDir = p.dir;
  let hit = false;
  for (const e of s.enemies) {
    if (!hittable(e)) continue;
    const dx = e.x - p.x, dy = e.y - p.y;
    const d = Math.hypot(dx, dy);
    if (d > PLAYER.atkRange + e.def.r) continue;
    let da = Math.atan2(dy, dx) - p.dir;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    if (Math.abs(da) > PLAYER.atkArc / 2 && d > e.def.r + 10 * U) continue;
    damage(s, e, PLAYER.atkDmg);
    hit = true;
    if (e.chew) { e.chew = null; e.chewCd = 2; }
    // Only small critters get knocked back, so the baton can't juggle big ones in a kill zone.
    if (e.def.light && d > 0) { e.kx += (dx / d) * PLAYER.knock; e.ky += (dy / d) * PLAYER.knock; }
    puff(s, e.x, e.y, '#ffe27a', 4, 70);
  }
  ev(s, hit ? 'hit' : 'swing');
}

function throwBomb(s, p) {
  p.bombs -= 1;
  const tx = clamp(p.x + Math.cos(p.dir) * PLAYER.bombRange, 10, WORLD_W - 10);
  const ty = clamp(p.y + Math.sin(p.dir) * PLAYER.bombRange, 10, WORLD_H - 10);
  s.bombs.push({ id: s.nextId++, sx: p.x, sy: p.y, tx, ty, x: p.x, y: p.y, h: 0, t: 0, dur: 0.6 });
  ev(s, 'throw');
}

function explode(s, b) {
  s.fx.push({ kind: 'ring', x: b.tx, y: b.ty, r: PLAYER.bombRadius, col: '#ffb347', life: 0.4, max: 0.4 });
  s.fx.push({ kind: 'flash', x: b.tx, y: b.ty, r: PLAYER.bombRadius * 0.8, life: 0.15, max: 0.15 });
  puff(s, b.tx, b.ty, '#ffb347', 16, 160);
  puff(s, b.tx, b.ty, '#6b6b6b', 8, 60);
  ev(s, 'explode');
  ev(s, 'shake', { amt: 7 });
  for (const e of s.enemies) {
    if (!hittable(e)) continue;
    if (Math.hypot(e.x - b.tx, e.y - b.ty) <= PLAYER.bombRadius + e.def.r) {
      damage(s, e, 4, true);
      applyStun(e, PLAYER.bombStun);
    }
  }
  // Cats caught in the blast get knocked down too — watch where you throw!
  for (const p of s.players) {
    const dx = p.x - b.tx, dy = p.y - b.ty, d = Math.hypot(dx, dy);
    if (d > PLAYER.bombRadius + 10 * U) continue;
    p.stun = PLAYER.catStun;
    p.working = null;
    const push = 30 * U / Math.max(1, d) ;
    p.x = clamp(p.x + dx * push, 14, WORLD_W - 14);
    p.y = clamp(p.y + dy * push, 14, WORLD_H - 14);
    text(s, p.x, p.y - T * 0.6, 'Ouch!', '#ffb347');
    ev(s, 'catStun');
  }
}

function deny(s, p, x, y, msg) {
  if (p.msgCd > 0) return;
  p.msgCd = 1;
  text(s, x, y, msg, '#ff7777');
  ev(s, 'deny');
}

function plant(s, p) {
  const { tx, ty } = tileOf(p);
  const k = ty * W + tx;
  const cx = (tx + 0.5) * T, cy = ty * T;
  if (s.grid.has(k)) return;
  if (PATH_TILES.has(k)) return deny(s, p, cx, cy, "Can't plant on the path");
  if (p.coins < 1) return deny(s, p, cx, cy, 'Out of coins!');
  const type = p.loadout[p.sel];
  const nf = {
    id: s.nextId++, type, lvl: 0, tx, ty, x: cx, y: cy + T / 2, cd: 0.3, angle: 0, flash: 0, hurtT: 0,
    hp: FLOWER_HP, headIdx: 0, dead: false, grow: { to: 1, cost: FLOWERS[type].cost, paid: 0 },
  };
  s.flowers.push(nf);
  s.grid.set(k, nf);
  puff(s, nf.x, nf.y, '#c9a26b', 10);
  ev(s, 'plant');
}

// A cat holding the plant key pours its own coins into the flower it stands on.
function work(s, p, f, dt) {
  if (f.lvl > 0 && p.mode === 'heal') {
    if (f.hp >= FLOWER_HP) return;
    const cph = healCostPerHp(f);
    const pay = Math.min((FLOWER_HP - f.hp) * cph, HEAL_RATE * dt * cph, p.coins);
    if (pay <= 1e-6) return deny(s, p, f.x, f.y - T * 0.6, 'Out of coins!');
    p.coins -= pay;
    f.hp += pay / cph;
    p.working = f;
    ev(s, 'pour');
    if (f.hp >= FLOWER_HP - 1e-6) {
      f.hp = FLOWER_HP;
      text(s, f.x, f.y - T * 0.6, 'Healthy!', '#8dff9a');
      ev(s, 'healed');
    }
    return;
  }
  if (!f.grow) {
    if (f.lvl >= MAX_LEVEL) return deny(s, p, f.x, f.y - T * 0.6, 'Max level!');
    f.grow = { to: f.lvl + 1, cost: upgradeCost(f.type, f.lvl), paid: 0 };
  }
  const g = f.grow;
  const pay = Math.min(g.cost - g.paid, (g.cost / GROW_TIME[g.to]) * dt, p.coins);
  if (pay <= 1e-6) return deny(s, p, f.x, f.y - T * 0.6, 'Out of coins!');
  p.coins -= pay;
  g.paid += pay;
  p.working = f;
  ev(s, 'pour');
  if (g.paid >= g.cost - 1e-6) {
    f.lvl = g.to;
    f.grow = null;
    f.hp = FLOWER_HP;
    f.flash = 0.5;
    f.cd = 0.2;
    puff(s, f.x, f.y, FLOWERS[f.type].color, 16, 130);
    text(s, f.x, f.y - T * 0.7, f.lvl === 1 ? FLOWERS[f.type].name + '!' : `Level ${f.lvl}!`, '#ffe27a');
    ev(s, 'grown');
    p.waitRelease = true; // don't roll straight into the next upgrade
  }
}

function updatePlayers(s, dt, inputs) {
  let ready = false;
  for (const p of s.players) {
    const inp = inputs[p.id] || {};
    p.atkCd -= dt;
    p.msgCd -= dt;
    p.swingT = Math.max(0, p.swingT - dt);
    p.working = null;
    const had = p.bombs;
    p.bombs = Math.min(PLAYER.bombMax, p.bombs + dt / PLAYER.bombRecharge);
    if (had < 1 && p.bombs >= 1) ev(s, 'bombReady');
    if (inp.ready) ready = true;
    if (p.stun > 0) { p.stun -= dt; p.moving = false; continue; }

    let mx = inp.mx || 0, my = inp.my || 0;
    const l = Math.hypot(mx, my);
    p.moving = l > 0;
    if (l > 0) { mx /= l; my /= l; p.dir = Math.atan2(my, mx); }
    p.x = clamp(p.x + mx * PLAYER.speed * dt, 14, WORLD_W - 14);
    p.y = clamp(p.y + my * PLAYER.speed * dt, 14, WORLD_H - 14);
    if (s.sharedScreen) {
      for (const o of s.players) {
        if (o === p) continue;
        p.x = clamp(p.x, o.x - (VIEW_W - 90), o.x + (VIEW_W - 90));
        p.y = clamp(p.y, o.y - (MAP_H - 90), o.y + (MAP_H - 90));
      }
    }
    if (inp.atk && p.atkCd <= 0) swing(s, p);
    if (inp.bomb && p.bombs >= 1) throwBomb(s, p);

    const { tx, ty } = tileOf(p);
    let f = s.grid.get(ty * W + tx);
    if (f && f.id !== p.onFlowerId) p.mode = f.lvl > 0 && f.hp < FLOWER_HP * 0.6 ? 'heal' : 'grow';
    p.onFlowerId = f ? f.id : null;
    if (inp.cycle) {
      if (f && f.lvl > 0 && f.lvl < MAX_LEVEL) p.mode = p.mode === 'heal' ? 'grow' : 'heal';
      else if (!f) p.sel = (p.sel + 1) % p.loadout.length;
      ev(s, 'cycle');
    }
    if (inp.buildTap && !f) { plant(s, p); f = s.grid.get(ty * W + tx); }
    if (!inp.build) p.waitRelease = false;
    if (inp.build && f && !p.waitRelease) work(s, p, f, dt);
  }
  return ready;
}

// ---- Flowers & projectiles -----------------------------------------------
function hurtFlower(s, f, amt) {
  if (f.dead || f.lvl >= MAX_LEVEL) return;
  f.hp -= amt;
  f.hurtT = 0.15;
  if (f.hp <= 0) {
    f.dead = true;
    s.grid.delete(f.ty * W + f.tx);
    puff(s, f.x, f.y, '#9a7b55', 16, 100);
    text(s, f.x, f.y - T * 0.5, 'Wilted…', '#d9b38c');
    ev(s, 'wilt');
  }
}

function updateFlowers(s, dt) {
  for (const f of s.flowers) {
    if (f.dead) continue;
    f.flash = Math.max(0, f.flash - dt);
    f.hurtT = Math.max(0, f.hurtT - dt);
    if (f.lvl === 0) continue; // seedlings don't fight
    f.cd -= dt;
    if (f.cd > 0) continue;
    const st = flowerStats(f.type, f.lvl);
    let best = null;
    const inRange = [];
    for (const e of s.enemies) {
      if (!hittable(e) || (st.groundOnly && e.def.flying)) continue;
      if (dist(e, f) <= st.range + e.def.r) {
        inRange.push(e);
        const better = st.target === 'strong' ? !best || e.hp > best.hp : !best || e.dist > best.dist;
        if (better) best = e;
      }
    }
    if (!best) continue;
    f.cd = st.rate;
    f.angle = Math.atan2(best.y - f.y, best.x - f.x);
    f.flash = 0.15;
    f.headIdx = (f.headIdx + 1) % Math.min(f.lvl, 5);
    const hx = f.x, hy = f.y - T * 0.35;
    if (st.kind === 'single') {
      s.projs.push({ id: s.nextId++, kind: 'single', x: hx, y: hy, target: best, speed: 460 * U, dmg: st.dmg, color: st.color });
    } else if (st.kind === 'beam') {
      damage(s, best, st.dmg);
      s.fx.push({ kind: 'beam', x: hx, y: hy, x2: best.x, y2: best.y, col: st.color, w: 4 + f.lvl, life: 0.3, max: 0.3 });
      puff(s, best.x, best.y, '#fff3a0', 10, 110);
    } else if (st.kind === 'bolt') {
      const a = Math.atan2(best.y - hy, best.x - hx);
      s.projs.push({ id: s.nextId++, kind: 'bolt', x: hx, y: hy, ang: a, speed: 420 * U, dmg: st.dmg, left: st.range * 1.25, hit: [], color: st.color, big: f.lvl });
    } else if (st.kind === 'chomp') {
      // small critters get swallowed whole, everything else takes a big bite
      const gulp = best.def.light && !best.def.boss;
      damage(s, best, gulp ? best.hp + 1 : st.dmg, gulp);
      s.fx.push({ kind: 'bite', x: best.x, y: best.y, r: best.def.r + 8 * U, life: 0.35, max: 0.35 });
      if (gulp) text(s, best.x, best.y - T * 0.4, 'GULP!', '#ff9ac8');
    } else if (st.kind === 'cloud') {
      s.projs.push({
        id: s.nextId++, kind: 'lob', x: hx, y: hy, sx: hx, sy: hy, tx: best.x, ty: best.y, speed: 260 * U, color: st.color, t: 0,
        cloud: { r: st.cloudR, dur: st.cloudDur, dps: st.dmg, stacks: st.stacks },
      });
    } else {
      s.fx.push({ kind: 'ring', x: f.x, y: f.y, r: st.range, col: st.color, life: 0.35, max: 0.35 });
      for (const e of inRange) {
        damage(s, e, st.dmg);
        if (st.slow) { e.slow = Math.min(e.slow, st.slow); e.slowT = 1.3; }
      }
    }
    ev(s, 'shoot_' + f.type);
    // Fighting wears flowers out; max level flowers are hardy.
    hurtFlower(s, f, WEAR_PER_SEC * st.rate * WEAR_MULT[f.lvl]);
  }
  s.flowers = s.flowers.filter((f) => !f.dead);
}

function updateProjs(s, dt) {
  for (const p of s.projs) {
    if (p.kind === 'single') {
      if (!hittable(p.target)) { p.done = true; continue; }
      const dx = p.target.x - p.x, dy = p.target.y - p.y;
      const d = Math.hypot(dx, dy), mv = p.speed * dt;
      p.ang = Math.atan2(dy, dx);
      if (d <= mv + p.target.def.r) { damage(s, p.target, p.dmg); p.done = true; puff(s, p.target.x, p.target.y, p.color, 3, 60); }
      else { p.x += (dx / d) * mv; p.y += (dy / d) * mv; }
    } else if (p.kind === 'bolt') {
      const mv = p.speed * dt;
      p.x += Math.cos(p.ang) * mv; p.y += Math.sin(p.ang) * mv;
      p.left -= mv;
      for (const e of s.enemies) {
        if (!hittable(e) || p.hit.includes(e.id)) continue;
        if (Math.hypot(e.x - p.x, e.y - p.y) <= e.def.r + 10 * U) {
          p.hit.push(e.id);
          damage(s, e, p.dmg);
          puff(s, e.x, e.y, '#ffb347', 5, 80);
        }
      }
      if (rnd(s) < dt * 40) s.fx.push({ kind: 'puff', x: p.x, y: p.y, vx: 0, vy: -20, col: '#ffb347', size: 3 + rnd(s) * 3, life: 0.3, max: 0.3 });
      if (p.left <= 0 || p.x < -T || p.y < -T || p.x > WORLD_W + T || p.y > WORLD_H + T) p.done = true;
    } else {
      const dx = p.tx - p.x, dy = p.ty - p.y;
      const d = Math.hypot(dx, dy), mv = p.speed * dt;
      p.t += dt;
      p.k = 1 - d / Math.max(1, Math.hypot(p.tx - p.sx, p.ty - p.sy));
      if (d <= mv) {
        p.done = true;
        s.clouds.push({ id: s.nextId++, x: p.tx, y: p.ty, t: 0, tick: 0, ...p.cloud });
        ev(s, 'splash');
      } else { p.x += (dx / d) * mv; p.y += (dy / d) * mv; }
    }
  }
  s.projs = s.projs.filter((p) => !p.done);
}

// Poison clouds add a stack to every ground enemy inside, twice a second.
function updateClouds(s, dt) {
  for (const c of s.clouds) {
    c.t += dt;
    c.tick -= dt;
    if (c.tick <= 0) {
      c.tick = 0.5;
      for (const e of s.enemies) {
        if (!hittable(e) || e.def.flying) continue;
        if (Math.hypot(e.x - c.x, e.y - c.y) > c.r + e.def.r) continue;
        e.psn = Math.min(c.stacks, e.psn + 1);
        e.psnT = POISON_TIME;
        e.psnDps = Math.max(e.psnDps, c.dps);
      }
    }
  }
  s.clouds = s.clouds.filter((c) => c.t < c.dur);
}

function updateBombs(s, dt) {
  for (const b of s.bombs) {
    b.t += dt;
    const k = Math.min(1, b.t / b.dur);
    b.x = b.sx + (b.tx - b.sx) * k;
    b.y = b.sy + (b.ty - b.sy) * k;
    b.h = Math.sin(k * Math.PI) * 50 * U;
    if (k >= 1) { b.done = true; explode(s, b); }
  }
  s.bombs = s.bombs.filter((b) => !b.done);
}

// Whoever picks a coin up keeps it.
function updateDrops(s, dt) {
  for (const d of s.drops) {
    d.age += dt;
    d.x += d.vx * dt; d.y += d.vy * dt;
    const f = Math.pow(0.01, dt);
    d.vx *= f; d.vy *= f;
    d.x = clamp(d.x, 8, WORLD_W - 8); d.y = clamp(d.y, 8, WORLD_H - 8);
    let near = null, nd = 80 * U;
    for (const p of s.players) { const dd = dist(d, p); if (dd < nd && p.stun <= 0) { nd = dd; near = p; } }
    if (near && d.age > 0.25) {
      const sp = 300 * U * dt;
      d.x += ((near.x - d.x) / nd) * Math.min(sp, nd);
      d.y += ((near.y - d.y) / nd) * Math.min(sp, nd);
      if (nd < 20 * U) {
        d.done = true;
        near.coins += d.value;
        text(s, d.x, d.y - 10, `+${d.value}`, d.meat ? '#ff9d8a' : '#ffd23f');
        ev(s, d.meat ? 'meat' : 'coin');
      }
    }
    if (d.age > 25) d.done = true;
  }
  s.drops = s.drops.filter((d) => !d.done);
}

export function updateFx(s, dt) {
  for (const f of s.fx) {
    f.life -= dt;
    if (f.kind === 'puff') { f.x += f.vx * dt; f.y += f.vy * dt; f.vx *= 0.9; f.vy *= 0.9; }
    if (f.kind === 'text') f.y -= 28 * dt;
  }
  s.fx = s.fx.filter((f) => f.life > 0);
}

// Pick screen: move with left/right, toggle with the plant key, lock in with the baton key.
function updatePick(s, inputs) {
  const N = FLOWER_ORDER.length;
  for (const p of s.players) {
    const inp = inputs[p.id] || {};
    const pk = p.pick;
    const mx = Math.sign(inp.mx || 0);
    if (mx && mx !== p.prevMx && !pk.ready) { pk.cursor = (pk.cursor + mx + N) % N; ev(s, 'cycle'); }
    p.prevMx = mx;
    if (inp.buildTap) {
      if (pk.ready) { pk.ready = false; ev(s, 'cycle'); }
      else {
        const t = FLOWER_ORDER[pk.cursor];
        const i = pk.chosen.indexOf(t);
        if (i >= 0) { pk.chosen.splice(i, 1); ev(s, 'cycle'); }
        else if (pk.chosen.length < LOADOUT_SIZE) { pk.chosen.push(t); ev(s, 'plant'); }
        else ev(s, 'deny');
      }
    }
    const atkTap = inp.atk && !p.prevAtk;
    p.prevAtk = !!inp.atk;
    if (atkTap) {
      if (pk.chosen.length === LOADOUT_SIZE) { pk.ready = !pk.ready; ev(s, pk.ready ? 'grown' : 'cycle'); }
      else ev(s, 'deny');
    }
  }
  if (s.players.every((p) => p.pick.ready)) {
    for (const p of s.players) { p.loadout = p.pick.chosen.slice(); p.sel = 0; }
    s.phase = 'prep';
    s.timer = 30;
    s.fx.push({ kind: 'banner', txt: 'Plant your flowers!', life: 2.2, max: 2.2 });
    ev(s, 'wave');
  }
}

export function step(s, inputs, dt) {
  if (s.phase === 'pick') { updatePick(s, inputs); updateFx(s, dt); return; }
  if (s.over || s.won) { updateFx(s, dt); return; }
  s.t += dt;
  const ready = updatePlayers(s, dt, inputs);
  updateWaves(s, dt, ready);
  updateEnemies(s, dt);
  updateFlowers(s, dt);
  updateProjs(s, dt);
  updateClouds(s, dt);
  updateBombs(s, dt);
  s.enemies = s.enemies.filter((e) => !e.dead);
  updateDrops(s, dt);
  updateFx(s, dt);
}
