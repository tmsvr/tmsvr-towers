// Game simulation. No DOM/canvas/audio access: state in, inputs in, state out.
// Inputs per player per tick: { mx, my, atk, bomb, build (held), heal (held), buildTap, cycle, ready }
// Side effects for presentation are queued for whoever draws the game:
// sounds and shake in s.events, visual effects (described, not simulated) in
// s.fx. Both are drained by the caller.
import {
  T, U, VIEW_W, MAP_H, TOTAL_WAVES, MAPS, ENEMIES,
  FLOWER_ORDER, FLOWERS, MAX_LEVEL, GROW_TIME, FLOWER_HP, WEAR_PER_SEC, WEAR_MULT, HEAL_RATE, HEAL_COST,
  POISON_TIME, START_COINS, LOADOUT_SIZE, WAVES, DIFFICULTY, ECONOMY, flowerStats, upgradeCost, PLAYER, CATS, CAT_ORDER,
} from './data.js';
import { prune, clamp, nextSeed, randomFrom } from './util.js';

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const isDead = (o) => o.dead, isDone = (o) => o.done, cloudGone = (c) => c.t >= c.dur;

// The game's own random numbers: wave make-up, spawn spots, coin scatter.
// Only rules that change what happens may use these, so cosmetic tweaks can
// never change a seeded game (fx.js uses Math.random for its particles).
function rnd(s) {
  s.rng = nextSeed(s.rng);
  return randomFrom(s.rng);
}

// Cats are kept this far inside the edge of the world.
const EDGE = 14;

// Difficulty knobs from balance.json (exported so balance can be swept from the console).
export const TUNE = DIFFICULTY;

// sharedScreen: both cats share one camera, so they can't wander further apart than the view.
// loadouts / cats: last game's flower picks and characters, pre-selected on the pick screen.
// The map lives on the state (s.m, one of MAPS), so any number of games can
// exist side by side: the balance bot's, a guest's view, the real one.
export function createState(nPlayers = 1, seed = 1337, { sharedScreen = false, loadouts = [], cats = [], map = 0 } = {}) {
  const m = MAPS[map] || MAPS[0];
  const s = {
    m,
    t: 0, nextId: 1, rng: seed, wave: 0, phase: 'pick', timer: DIFFICULTY.firstWaveDelay, queue: [], spawnWait: 0,
    lives: DIFFICULTY.cottageHealth, maxLives: DIFFICULTY.cottageHealth, baseHitT: 0, lastAlarm: -99, players: [], flowers: [], enemies: [], drops: [], bombs: [], projs: [], clouds: [],
    fx: [], events: [], grid: new Map(), over: false, won: false, kills: 0, sharedScreen, map: m.index,
  };
  const coins = startCoins(m, nPlayers);
  const taken = new Set();
  for (let i = 0; i < nPlayers; i++) {
    let cat = CATS[cats[i]] && !taken.has(cats[i]) ? cats[i] : CAT_ORDER.find((c, k) => k >= i && !taken.has(c)) || CAT_ORDER.find((c) => !taken.has(c));
    taken.add(cat);
    s.players.push({
      id: i, x: m.start.x + i * T, y: m.start.y, dir: 0, atkCd: 0, swingT: 0, coins, stun: 0, cat, stam: 1, tired: false, sprinting: false, restT: 0,
      bombs: PLAYER.bombMax, sel: 0, building: false, moving: false, mode: 'grow', onFlowerId: null, working: null, msgCd: 0,
      loadout: null, pick: { row: 1, cursor: 0, chosen: (loadouts[i] || []).filter((t) => FLOWERS[t]).slice(0, LOADOUT_SIZE), ready: false },
      prevMx: 0, prevMy: 0, prevAtk: false,
    });
  }
  return s;
}

const ev = (s, type, extra) => s.events.push({ type, ...extra });

function text(s, x, y, txt, col = '#fff') {
  s.fx.push({ kind: 'text', x, y, txt, col });
}

// A burst of n little bits flying out from (x, y); see fx.js.
function puff(s, x, y, col, n = 6, spd = 90) {
  s.fx.push({ kind: 'puff', x, y, col, n, spd });
}

const banner = (s, txt) => s.fx.push({ kind: 'banner', txt });

export function tileOf(m, p) {
  return { tx: clamp(Math.floor(p.x / T), 0, m.W - 1), ty: clamp(Math.floor(p.y / T), 0, m.H - 1) };
}

export function canBuildAt(s, tx, ty) {
  const k = ty * s.m.W + tx;
  return !s.m.pathTiles.has(k) && !s.m.blocked.has(k) && !s.grid.has(k);
}

// Push a cat out of trees, rocks and ponds so it slides along their edges.
const CAT_R = T * 0.22;
export function collideCat(m, p) {
  const tx = Math.floor(p.x / T), ty = Math.floor(p.y / T);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = ty - 1; y <= ty + 1; y++) for (let x = tx - 1; x <= tx + 1; x++) {
      if (x < 0 || y < 0 || x >= m.W || y >= m.H) continue;
      for (const s of m.solids.get(y * m.W + x) || []) {
        const nx = clamp(p.x, s.x0, s.x1), ny = clamp(p.y, s.y0, s.y1);
        let dx = p.x - nx, dy = p.y - ny, d = Math.hypot(dx, dy);
        const min = s.rad + CAT_R;
        if (d >= min) continue;
        if (d < 1e-6) {
          // centre inside a pond's core: leave by the nearest side
          const opts = [[p.x - s.x0, -1, 0], [s.x1 - p.x, 1, 0], [p.y - s.y0, 0, -1], [s.y1 - p.y, 0, 1]].sort((a, b) => a[0] - b[0]);
          [, dx, dy] = opts[0];
          if (dx) p.x = (dx < 0 ? s.x0 : s.x1) + dx * min;
          if (dy) p.y = (dy < 0 ? s.y0 : s.y1) + dy * min;
          continue;
        }
        p.x = nx + (dx / d) * min;
        p.y = ny + (dy / d) * min;
      }
    }
  }
  p.x = clamp(p.x, EDGE, m.worldW - EDGE);
  p.y = clamp(p.y, EDGE, m.worldH - EDGE);
}

// A cat's stats with its class applied.
export function catStats(p) {
  const k = CATS[p.cat] || CATS[CAT_ORDER[0]];
  return {
    speed: PLAYER.speed * k.speed,
    atkDmg: PLAYER.atkDmg * k.batonDamage,
    atkCd: PLAYER.atkCd * k.batonCooldown,
    atkRange: PLAYER.atkRange * k.batonRange,
    bombRecharge: PLAYER.bombRecharge * k.bombRecharge,
    bombRadius: PLAYER.bombRadius * k.bombRadius,
    sprintSeconds: PLAYER.sprintSeconds * k.sprintSeconds,
    bombDmg: PLAYER.bombDmg * (k.bombDamage ?? 1),
    grow: k.growSpeed,
    price: k.upgradeCost ?? 1, // coins this cat pays per coin of upgrade or healing
  };
}

export const healCostPerHp = (f) => (FLOWERS[f.type].cost * HEAL_COST) / FLOWER_HP;
export const uprootRefund = (f) => Math.floor((f.spent || 0) * ECONOMY.uprootRefund);

// What the mode key cycles through while standing on a flower. Healing has
// its own key, so the plant key only ever upgrades (or digs up).
const FLOWER_MODES = ['grow', 'dig'];

// ---- Enemies --------------------------------------------------------------
function spawnEnemy(s, type, from, path = 0) {
  const d = ENEMIES[type];
  const w = Math.max(0, s.wave - 1);
  const solo = s.players.length === 1;
  // The last boss is the big one. Bosses also shrink on maps with split-up
  // defences (smaller waveSize), since only some flowers will ever see them.
  const finale = d.boss ? (s.wave >= TOTAL_WAVES ? TUNE.finalBossHp || 1 : 1) * Math.sqrt(s.m.waveSize) : 1;
  const hpScale = (1 + w * TUNE.hpPerWave + w * w * TUNE.hpPerWaveSquared) * (solo ? (d.boss ? TUNE.soloBossHp : 1) : TUNE.coopEnemyHp) * finale;
  const j = () => (rnd(s) - 0.5) * 18 * U;
  const id = s.nextId++;
  const road = s.m.paths[from ? from.path : path];
  s.enemies.push({
    id, type, def: d,
    path: from ? from.path : path,
    x: from ? from.x + j() : road.spawn.x, y: from ? from.y + j() : road.spawn.y,
    seg: from ? from.seg : 0, dist: from ? from.dist : 0, left: from ? from.left : road.length,
    hp: d.hp * hpScale, maxhp: d.hp * hpScale,
    stun: 0, slow: 1, slowT: 0, kx: 0, ky: 0, flash: 0, dead: false, wob: (id * 2.4) % 6, ang: 0, // wob only animates, so it stays off the game's random numbers
    phaseT: rnd(s) * 2, spawnT: 0, under: false, dashing: false, chew: null, chewT: 0, chewCd: 1,
    psn: 0, psnT: 0, psnDps: 0, atBase: false, baseAng: rnd(s) * Math.PI * 2,
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
    for (let i = 0; i < e.def.split.count; i++) spawnEnemy(s, e.def.split.into, e);
    puff(s, e.x, e.y, '#e08ae8', 12, 120);
    ev(s, 'split');
  }
  const v = Math.max(1, Math.round(e.def.coin * ECONOMY.coinDropMultiplier));
  // Large drops split into a few pickups so they scatter nicely.
  const pieces = v >= 20 ? 6 : v >= 5 ? 2 : 1;
  const base = Math.floor(v / pieces);
  for (let i = 0; i < pieces; i++) {
    const val = i === pieces - 1 ? v - base * (pieces - 1) : base;
    const a = rnd(s) * Math.PI * 2;
    const sp = (pieces > 1 ? 50 + rnd(s) * 60 : 20) * U;
    s.drops.push({ id: s.nextId++, x: e.x, y: e.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, value: val, age: 0, big: val >= 4 });
  }
}

function applyStun(e, dur) {
  e.stun = Math.max(e.stun, e.def.boss ? dur * 0.3 : dur);
  e.chew = null;
}

function updateEnemies(s, dt) {
  const { base, worldW, worldH } = s.m;
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
        if (o !== e && !o.dead && o.hp < o.maxhp && dist(o, e) < e.def.heals.radius) o.hp = Math.min(o.maxhp, o.hp + e.def.heals.perSecond * dt);
      }
    }
    if (e.stun > 0) { e.stun -= dt; continue; }
    if (e.def.spawns) {
      e.spawnT += dt;
      if (e.spawnT >= e.def.spawns.every) {
        e.spawnT = 0;
        for (let i = 0; i < e.def.spawns.count; i++) spawnEnemy(s, e.def.spawns.type, e);
        ev(s, 'spawn');
      }
    }
    if (e.def.burrow) {
      e.phaseT += dt;
      if (e.phaseT >= (e.under ? e.def.burrow.belowSeconds : e.def.burrow.aboveSeconds)) {
        e.phaseT = 0;
        e.under = !e.under;
        puff(s, e.x, e.y, '#8a6038', 8, 70);
        ev(s, 'burrow');
      }
    }
    if (e.def.dash) {
      e.phaseT += dt;
      const was = e.dashing;
      e.dashing = e.phaseT % e.def.dash.every > e.def.dash.every - e.def.dash.duration;
      if (e.dashing && !was) ev(s, 'dash');
    }
    if (e.def.eats) {
      if (e.chew) {
        if (e.chew.dead) e.chew = null;
        else {
          e.chewT -= dt;
          e.wob += dt * 14;
          hurtFlower(s, e.chew, e.def.eats.damagePerSecond * dt);
          ev(s, 'chomp');
          if (e.chewT <= 0) { e.chew = null; e.chewCd = e.def.eats.cooldown; }
          continue;
        }
      } else if ((e.chewCd -= dt) <= 0) {
        // one aphid per flower, so a crowd can't strip a flower in seconds
        const f = s.flowers.find((f) => !f.dead && f.lvl < MAX_LEVEL && dist(e, f) < e.def.eats.reach && !s.enemies.some((o) => o.chew === f));
        if (f) { e.chew = f; e.chewT = e.def.eats.chewSeconds; e.ang = Math.atan2(f.y - e.y, f.x - e.x); continue; }
      }
    }
    e.wob += dt * 8 * e.slow;
    const sp = e.def.speed * e.slow * (e.dashing ? e.def.dash.speedMultiplier : 1) * (e.under ? e.def.burrow.speedMultiplier : 1);
    const road = s.m.paths[e.path], wps = road.waypoints;
    // On the last stretch each enemy heads for its own spot around the cottage wall.
    const final = e.def.flying || e.seg >= wps.length - 1;
    const tgt = final
      ? { x: clamp(base.x + Math.cos(e.baseAng) * T * 0.62, T * 0.3, worldW - T * 0.3), y: clamp(base.y + Math.sin(e.baseAng) * T * 0.5, T * 0.3, worldH - T * 0.3) }
      : wps[e.seg];
    const dx = tgt.x - e.x, dy = tgt.y - e.y;
    const d = Math.hypot(dx, dy);
    if (final && d < 3) { chompCottage(s, e, dt); continue; }
    e.atBase = false;
    const mv = Math.min(sp * dt, d);
    if (d > 0) { e.x += (dx / d) * mv; e.y += (dy / d) * mv; e.ang = Math.atan2(dy, dx); }
    e.dist += mv;
    // how far is left to the cottage (flowers aim at whoever is closest to getting in)
    e.left = final ? Math.hypot(base.x - e.x, base.y - e.y) : road.length - e.dist;
    if (!final && d - mv < 1) e.seg++;
  }
}

// Enemies that reach the cottage keep biting it until someone deals with them.
function chompCottage(s, e, dt) {
  e.atBase = true;
  e.left = 0;
  e.wob += dt * 14;
  e.ang = Math.atan2(s.m.base.y - e.y, s.m.base.x - e.x);
  s.lives -= e.def.bite * dt;
  s.baseHitT = 0.25;
  ev(s, 'chomp');
  if (s.t - s.lastAlarm > 10) {
    s.lastAlarm = s.t;
    banner(s, 'The cottage is under attack!');
    ev(s, 'leak');
    ev(s, 'shake', { amt: 4 });
  }
  if (s.lives <= 0) { s.lives = 0; s.over = true; ev(s, 'lose'); }
}

// ---- Waves ----------------------------------------------------------------
function buildQueue(s, n) {
  const q = [];
  let budget = (TUNE.waveBudgetBase + n * TUNE.waveBudgetPerWave + n * n * (TUNE.waveBudgetPerWaveSquared || 0)) * (s.players.length > 1 ? TUNE.coopWaveSize : TUNE.soloWaveSize) * s.m.waveSize;
  const avail = WAVES.filter((u) => u.fromWave <= n);
  const bossWave = n % TUNE.bossEvery === 0;
  if (bossWave) budget *= TUNE.bossWaveBudget;
  while (budget > 0) {
    const total = avail.reduce((a, u) => a + u.weight, 0);
    let r = rnd(s) * total, pick = avail[0];
    for (const u of avail) { r -= u.weight; if (r <= 0) { pick = u; break; } }
    const path = Math.floor(rnd(s) * s.m.paths.length); // a group sticks together on one road
    for (let i = 0; i < pick.group; i++) q.push({ type: pick.enemy, path, wait: pick.group > 1 ? 0.22 : 0.4 + rnd(s) * 0.8 });
    budget -= pick.cost;
  }
  if (bossWave) q.push({ type: 'boss', path: Math.floor(rnd(s) * s.m.paths.length), wait: 3 });
  const k = Math.max(0.5, 1 - n * 0.03);
  for (const e of q) e.wait *= k;
  return q;
}

function startWave(s) {
  s.wave++;
  s.phase = 'wave';
  s.queue = buildQueue(s, s.wave);
  s.spawnWait = 0.5;
  const boss = s.wave % TUNE.bossEvery === 0;
  banner(s, boss ? `Wave ${s.wave} — BOSS!` : `Wave ${s.wave}`);
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
      spawnEnemy(s, e.type, null, e.path);
      s.spawnWait = e.wait;
    }
  } else if (!s.enemies.some((e) => !e.dead)) {
    if (s.wave >= TOTAL_WAVES) { s.won = true; ev(s, 'win'); return; }
    s.phase = 'prep';
    s.timer = TUNE.timeBetweenWaves;
    // Everyone gets a share; in co-op each cat gets a bit more than half.
    const bonus = Math.round((ECONOMY.waveBonusBase + s.wave * ECONOMY.waveBonusPerWave) * (s.players.length > 1 ? ECONOMY.coopBonusShare : 1));
    for (const p of s.players) p.coins += bonus;
    banner(s, `Wave cleared!  +${bonus} each`);
    ev(s, 'clear');
  }
}

// ---- Players --------------------------------------------------------------
// The baton's timers and arc; the online guest runs this alone to show its
// own swing straight away.
export function startSwing(p, cs) {
  p.atkCd = cs.atkCd;
  p.swingT = PLAYER.swingTime;
  p.swingDir = p.dir;
}

function swing(s, p) {
  const cs = catStats(p);
  startSwing(p, cs);
  let hit = false;
  for (const e of s.enemies) {
    if (!hittable(e)) continue;
    const dx = e.x - p.x, dy = e.y - p.y;
    const d = Math.hypot(dx, dy);
    if (d > cs.atkRange + e.def.r) continue;
    let da = Math.atan2(dy, dx) - p.dir;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    if (Math.abs(da) > PLAYER.atkArc / 2 && d > e.def.r + 10 * U) continue;
    damage(s, e, cs.atkDmg);
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
  const tx = clamp(p.x + Math.cos(p.dir) * PLAYER.bombRange, 10, s.m.worldW - 10);
  const ty = clamp(p.y + Math.sin(p.dir) * PLAYER.bombRange, 10, s.m.worldH - 10);
  s.bombs.push({ id: s.nextId++, sx: p.x, sy: p.y, tx, ty, x: p.x, y: p.y, h: 0, t: 0, dur: 0.6, r: catStats(p).bombRadius, dmg: catStats(p).bombDmg });
  ev(s, 'throw');
}

function explode(s, b) {
  const R = b.r || PLAYER.bombRadius;
  s.fx.push({ kind: 'ring', x: b.tx, y: b.ty, r: R, col: '#ffb347' });
  s.fx.push({ kind: 'flash', x: b.tx, y: b.ty, r: R * 0.8 });
  puff(s, b.tx, b.ty, '#ffb347', 16, 160);
  puff(s, b.tx, b.ty, '#6b6b6b', 8, 60);
  ev(s, 'explode');
  ev(s, 'shake', { amt: 7 });
  for (const e of s.enemies) {
    if (!hittable(e)) continue;
    if (Math.hypot(e.x - b.tx, e.y - b.ty) <= R + e.def.r) {
      damage(s, e, b.dmg ?? PLAYER.bombDmg, true);
      applyStun(e, PLAYER.bombStun);
    }
  }
  // Cats caught in the blast get knocked down too — watch where you throw!
  for (const p of s.players) {
    const dx = p.x - b.tx, dy = p.y - b.ty, d = Math.hypot(dx, dy);
    if (d > R + 10 * U) continue;
    p.stun = PLAYER.catStun;
    p.working = null;
    const push = 30 * U / Math.max(1, d) ;
    p.x = clamp(p.x + dx * push, EDGE, s.m.worldW - EDGE);
    p.y = clamp(p.y + dy * push, EDGE, s.m.worldH - EDGE);
    collideCat(s.m, p);
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
  const { tx, ty } = tileOf(s.m, p);
  const k = ty * s.m.W + tx;
  const cx = (tx + 0.5) * T, cy = ty * T;
  if (s.grid.has(k)) return;
  if (s.m.pathTiles.has(k)) return deny(s, p, cx, cy, "Can't plant on the path");
  if (s.m.yard.has(k)) return deny(s, p, cx, cy, 'Keep the yard clear!');
  if (s.m.blocked.has(k)) return deny(s, p, cx, cy, "Something's in the way");
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

// A cat holding the heal key pours its own coins into the flower's health.
function heal(s, p, f, dt) {
  if (f.lvl === 0 || f.lvl >= MAX_LEVEL) return deny(s, p, f.x, f.y - T * 0.6, f.lvl ? 'Max level flowers never wilt' : 'Seedlings are fine');
  if (f.hp >= FLOWER_HP) return; // the HUD already says it's healthy
  const cs = catStats(p), cph = healCostPerHp(f) * cs.price;
  const pay = Math.min((FLOWER_HP - f.hp) * cph, HEAL_RATE * cs.grow * dt * cph, p.coins);
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
}

// A cat holding the plant key pours its own coins into upgrading the flower
// it stands on (or digs it up in dig mode).
function work(s, p, f, dt) {
  if (p.mode === 'dig') {
    p.dig = (p.dig || 0) + dt / ECONOMY.uprootSeconds;
    p.working = f;
    ev(s, 'dig');
    if (p.dig >= 1) uproot(s, p, f);
    return;
  }
  if (!f.grow) {
    if (f.lvl >= MAX_LEVEL) return deny(s, p, f.x, f.y - T * 0.6, 'Max level!');
    f.grow = { to: f.lvl + 1, cost: upgradeCost(f.type, f.lvl), paid: 0 };
  }
  const g = f.grow;
  const cs = catStats(p);
  // progress is in the flower's own cost units; this cat pays `price` coins for each
  const prog = Math.min(g.cost - g.paid, (g.cost / GROW_TIME[g.to]) * cs.grow * dt, p.coins / cs.price);
  if (prog <= 1e-6) return deny(s, p, f.x, f.y - T * 0.6, 'Out of coins!');
  const pay = prog * cs.price;
  p.coins -= pay;
  g.paid += prog;
  f.spent = (f.spent || 0) + pay;
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

function uproot(s, p, f) {
  const refund = uprootRefund(f);
  p.coins += refund;
  p.dig = 0;
  p.mode = 'grow';
  p.waitRelease = true;
  f.dead = true;
  s.grid.delete(f.ty * s.m.W + f.tx);
  puff(s, f.x, f.y, '#9a7b55', 14, 110);
  text(s, f.x, f.y - T * 0.6, refund > 0 ? `Dug up · +${refund}` : 'Dug up', '#ffe27a');
  ev(s, 'uproot');
}

// Sprinting drains stamina; it refills after a short rest. Running dry
// leaves the cat tired until a third of the bar is back.
function sprint(p, cs, inp, dt) {
  p.sprinting = !!inp.sprint && p.moving && !p.tired && p.stam > 0;
  if (p.sprinting) {
    p.stam = Math.max(0, p.stam - dt / cs.sprintSeconds);
    p.restT = PLAYER.sprintDelay;
    if (p.stam <= 0) p.tired = true;
  } else if ((p.restT -= dt) <= 0) {
    p.stam = Math.min(1, p.stam + dt / PLAYER.sprintRecover);
    if (p.tired && p.stam >= 0.34) p.tired = false;
  }
}

// The part of a cat's tick that depends only on the cat and its own keys:
// baton timers, being knocked down, stamina and walking. The online guest
// runs exactly this to predict its own cat, so keep anything that needs the
// rest of the world out of here. Returns false while the cat is knocked down.
export function moveCat(s, p, inp, dt) {
  p.atkCd -= dt;
  p.swingT = Math.max(0, p.swingT - dt);
  if (p.stun > 0) { p.stun -= dt; p.moving = false; p.sprinting = false; return false; }
  const cs = catStats(p);
  let mx = inp.mx || 0, my = inp.my || 0;
  const l = Math.hypot(mx, my);
  p.moving = l > 0;
  if (l > 0) { mx /= l; my /= l; p.dir = Math.atan2(my, mx); }
  sprint(p, cs, inp, dt);
  const speed = cs.speed * (p.sprinting ? PLAYER.sprintSpeed : 1);
  p.x = clamp(p.x + mx * speed * dt, EDGE, s.m.worldW - EDGE);
  p.y = clamp(p.y + my * speed * dt, EDGE, s.m.worldH - EDGE);
  if (s.sharedScreen) {
    for (const o of s.players) {
      if (o === p) continue;
      p.x = clamp(p.x, o.x - (VIEW_W - 90), o.x + (VIEW_W - 90));
      p.y = clamp(p.y, o.y - (MAP_H - 90), o.y + (MAP_H - 90));
    }
  }
  collideCat(s.m, p);
  return true;
}

function updatePlayers(s, dt, inputs) {
  let ready = false;
  for (const p of s.players) {
    const inp = inputs[p.id] || {};
    p.msgCd -= dt;
    p.working = null;
    p.healing = false;
    const had = p.bombs;
    p.bombs = Math.min(PLAYER.bombMax, p.bombs + dt / catStats(p).bombRecharge);
    if (had < 1 && p.bombs >= 1) ev(s, 'bombReady');
    if (inp.ready) ready = true;
    if (!moveCat(s, p, inp, dt)) continue;
    // Fighting cancels build mode.
    if (inp.atk && p.atkCd <= 0) { swing(s, p); p.building = false; }
    if (inp.bomb && p.bombs >= 1) { throwBomb(s, p); p.building = false; }

    const { tx, ty } = tileOf(s.m, p);
    let f = s.grid.get(ty * s.m.W + tx);
    if (f && f.id !== p.onFlowerId) p.mode = 'grow'; // stepping onto a flower always starts in upgrade mode
    p.onFlowerId = f ? f.id : null;
    if (inp.cycle) {
      if (f) p.mode = FLOWER_MODES[(FLOWER_MODES.indexOf(p.mode) + 1) % FLOWER_MODES.length];
      // off → flower 1 → … → flower 4 → off
      else if (!p.building) { p.building = true; p.sel = 0; }
      else if (++p.sel >= p.loadout.length) { p.building = false; p.sel = 0; }
      ev(s, 'cycle');
    }
    if (inp.buildTap && !f) {
      // The first press only shows the placeholder flower; the next one plants it.
      if (!p.building) { p.building = true; ev(s, 'cycle'); }
      else { plant(s, p); f = s.grid.get(ty * s.m.W + tx); if (f) p.building = false; }
    }
    if (!inp.build) p.waitRelease = false;
    if (inp.heal && f) { p.healing = true; heal(s, p, f, dt); }
    else if (inp.build && f && !p.waitRelease) work(s, p, f, dt);
    if (p.working?.id !== f?.id || p.mode !== 'dig') p.dig = 0; // digging only counts while held
  }
  return ready;
}

// ---- Flowers & projectiles -----------------------------------------------
// quiet: slow wear, so the flower doesn't flash as if it were being bitten.
function hurtFlower(s, f, amt, quiet = false) {
  if (f.dead || f.lvl >= MAX_LEVEL) return;
  f.hp -= amt;
  if (!quiet) f.hurtT = 0.15;
  if (f.hp <= 0) {
    f.dead = true;
    s.grid.delete(f.ty * s.m.W + f.tx);
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
    // Every flower wears out at the same steady pace while a wave is on,
    // whatever its range or fire rate; higher levels wear slower, max never.
    if (s.phase === 'wave') hurtFlower(s, f, WEAR_PER_SEC * WEAR_MULT[f.lvl] * dt, true);
    if (f.dead) continue;
    f.cd -= dt;
    if (f.cd > 0) continue;
    const st = flowerStats(f.type, f.lvl);
    let best = null;
    const inRange = [];
    for (const e of s.enemies) {
      if (!hittable(e) || (st.groundOnly && e.def.flying)) continue;
      if (dist(e, f) <= st.range + e.def.r) {
        inRange.push(e);
        // 'strong' locks onto the toughest monster (by max health), so a nearly
        // dead boss isn't abandoned for its fresh minions
        const better = st.target === 'strong' ? !best || e.maxhp > best.maxhp || (e.maxhp === best.maxhp && e.hp < best.hp) : !best || e.left < best.left;
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
      s.fx.push({ kind: 'beam', x: hx, y: hy, x2: best.x, y2: best.y, col: st.color, w: 4 + f.lvl });
      puff(s, best.x, best.y, '#fff3a0', 10, 110);
    } else if (st.kind === 'bolt') {
      const a = Math.atan2(best.y - hy, best.x - hx);
      s.projs.push({ id: s.nextId++, kind: 'bolt', x: hx, y: hy, ang: a, speed: 420 * U, dmg: st.dmg, left: st.range * 1.25, hit: [], color: st.color, big: f.lvl });
    } else if (st.kind === 'chomp') {
      // small critters get swallowed whole, everything else takes a big bite
      const gulp = best.def.light && !best.def.boss;
      damage(s, best, gulp ? best.hp + 1 : st.dmg, gulp);
      s.fx.push({ kind: 'bite', x: best.x, y: best.y, r: best.def.r + 8 * U });
      if (gulp) text(s, best.x, best.y - T * 0.4, 'GULP!', '#ff9ac8');
    } else if (st.kind === 'cloud') {
      s.projs.push({
        id: s.nextId++, kind: 'lob', x: hx, y: hy, sx: hx, sy: hy, tx: best.x, ty: best.y, speed: 260 * U, color: st.color, t: 0,
        cloud: { r: st.cloudR, dur: st.cloudDur, dps: st.dmg, stacks: st.stacks },
      });
    } else {
      s.fx.push({ kind: 'ring', x: f.x, y: f.y, r: st.range, col: st.color, life: 0.35 });
      for (const e of inRange) {
        damage(s, e, st.dmg);
        if (st.slow) { e.slow = Math.min(e.slow, st.slow); e.slowT = 1.3; }
      }
    }
    ev(s, 'shoot_' + f.type);
  }
  prune(s.flowers, isDead);
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
      if (p.left <= 0 || p.x < -T || p.y < -T || p.x > s.m.worldW + T || p.y > s.m.worldH + T) p.done = true;
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
  prune(s.projs, isDone);
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
  prune(s.clouds, cloudGone);
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
  prune(s.bombs, isDone);
}

// Whoever picks a coin up keeps it.
function updateDrops(s, dt) {
  for (const d of s.drops) {
    d.age += dt;
    d.x += d.vx * dt; d.y += d.vy * dt;
    const f = Math.pow(0.01, dt);
    d.vx *= f; d.vy *= f;
    d.x = clamp(d.x, 8, s.m.worldW - 8); d.y = clamp(d.y, 8, s.m.worldH - 8);
    let near = null, nd = 80 * U;
    for (const p of s.players) { const dd = dist(d, p); if (dd < nd && p.stun <= 0) { nd = dd; near = p; } }
    if (near && d.age > 0.25) {
      const sp = 300 * U * dt;
      d.x += ((near.x - d.x) / nd) * Math.min(sp, nd);
      d.y += ((near.y - d.y) / nd) * Math.min(sp, nd);
      if (nd < 20 * U) {
        d.done = true;
        // In co-op part of every pickup is shared, so the gardener isn't
        // starved by whoever runs around fighting.
        const share = s.players.length > 1 ? ECONOMY.coopCoinShare ?? 0 : 0;
        near.coins += d.value * (1 - share);
        for (const p of s.players) p.coins += (d.value * share) / s.players.length;
        text(s, d.x, d.y - 10, `+${d.value}`, '#ffd23f');
        ev(s, d.big ? 'bigCoin' : 'coin');
      }
    }
    if (d.age > 25) d.done = true;
  }
  prune(s.drops, isDone);
}

const startCoins = (m, n) => Math.round((n > 1 ? START_COINS.coop : START_COINS.solo) * m.startCoins);

function selectMap(s, i) {
  const m = s.m = MAPS[i] || MAPS[0];
  s.map = m.index;
  s.players.forEach((p, k) => { p.x = m.start.x + k * T; p.y = m.start.y; p.pick.ready = false; p.coins = startCoins(m, s.players.length); });
}

// Next cat in direction `dir` that no other player has.
function nextCat(s, p, dir) {
  const n = CAT_ORDER.length;
  let i = CAT_ORDER.indexOf(p.cat);
  for (let k = 0; k < n; k++) {
    i = (i + dir + n) % n;
    if (!s.players.some((o) => o !== p && o.cat === CAT_ORDER[i])) return CAT_ORDER[i];
  }
  return p.cat;
}

// Pick screen rows: 0 = map, 1 = cat, 2 = flowers. Up/down switches rows,
// left/right moves, the plant key picks a flower, the baton key locks in.
function updatePick(s, inputs) {
  const N = FLOWER_ORDER.length;
  for (const p of s.players) {
    const inp = inputs[p.id] || {};
    const pk = p.pick;
    const mx = Math.sign(inp.mx || 0), my = Math.sign(inp.my || 0);
    if (my && my !== p.prevMy && !pk.ready) { pk.row = clamp(pk.row + my, 0, 2); ev(s, 'cycle'); }
    p.prevMy = my;
    if (mx && mx !== p.prevMx && !pk.ready) {
      if (pk.row === 0) selectMap(s, (s.map + mx + MAPS.length) % MAPS.length); // changing the map un-readies everyone
      else if (pk.row === 1) p.cat = nextCat(s, p, mx); // taken cats are skipped
      else pk.cursor = (pk.cursor + mx + N) % N;
      ev(s, 'cycle');
    }
    p.prevMx = mx;
    if (inp.buildTap) {
      if (pk.ready) { pk.ready = false; ev(s, 'cycle'); }
      else if (pk.row < 2) { pk.row++; ev(s, 'cycle'); }
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
    s.players.forEach((p, k) => { p.loadout = p.pick.chosen.slice(); p.sel = 0; p.x = s.m.start.x + k * T; p.y = s.m.start.y; });
    s.phase = 'prep';
    s.timer = DIFFICULTY.firstWaveDelay;
    banner(s, 'Plant your flowers!');
    ev(s, 'wave');
  }
}

export function step(s, inputs, dt) {
  if (s.phase === 'pick') { updatePick(s, inputs); return; }
  if (s.over || s.won) return;
  s.t += dt;
  s.baseHitT = Math.max(0, s.baseHitT - dt);
  const ready = updatePlayers(s, dt, inputs);
  updateWaves(s, dt, ready);
  updateEnemies(s, dt);
  updateFlowers(s, dt);
  updateProjs(s, dt);
  updateClouds(s, dt);
  updateBombs(s, dt);
  prune(s.enemies, isDead);
  updateDrops(s, dt);
}
