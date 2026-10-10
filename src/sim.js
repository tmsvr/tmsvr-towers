// Game simulation. No DOM/canvas/audio access: state in, inputs in, state out.
// Inputs per player per tick: { mx, my, atk, bomb, build (held), heal (held), buildTap, cycle, ready }
// Side effects for presentation are queued for whoever draws the game:
// sounds and shake in s.events, visual effects (described, not simulated) in
// s.fx. Both are drained by the caller.
import {
  T, U, VIEW_W, MAP_H, TOTAL_WAVES, MAPS, ENEMIES, INTROS,
  FLOWER_ORDER, FLOWERS, MAX_LEVEL, GROW_TIME, FLOWER_HP, WEAR_PER_SEC, WEAR_MULT, HEAL_RATE, HEAL_COST,
  POISON_TIME, START_COINS, LOADOUT_SIZE, DIFFICULTY, ECONOMY, flowerStats, upgradeCost, plantCost, PLAYER, CATS, CAT_ORDER, bloomOf, ELITES,
} from './data.js';
import { prune, clamp, nextSeed, randomFrom } from './util.js';
import * as log from './stats.js';

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
    items: [], // power-ups dropped by elites, waiting to be picked up
    seen: {}, // monster types met so far (each gets one warning banner)
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
      item: null, // the power-up this cat carries
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

// Coins this cat pays, which is what every price tag and HUD line shows.
// A class's price multiplier (Fern pays less, Brick more) applies to planting,
// upgrading and healing alike; partly paid levels only cost what's left.
const coinsFor = (p, base) => Math.ceil(base * catStats(p).price - 1e-6);
export const plantPrice = (p, type) => coinsFor(p, plantCost(type));
export const upgradeLeft = (p, f) => (f.lvl >= MAX_LEVEL ? 0 : coinsFor(p, f.grow ? f.grow.cost - f.grow.paid : upgradeCost(f.type, f.lvl)));
export const healLeft = (p, f) => coinsFor(p, (FLOWER_HP - f.hp) * healCostPerHp(f));

// What the mode key cycles through while standing on a flower. Healing has
// its own key, so the plant key only ever upgrades (or digs up).
const FLOWER_MODES = ['grow', 'dig'];

// ---- Enemies --------------------------------------------------------------
export function spawnEnemy(s, type, from, path = 0) {
  log.logSpawn(s, type);
  // the first of a new kind of monster says what it is and what stops it
  if (!s.seen[type]) {
    s.seen[type] = true;
    if (INTROS[type]) s.fx.push({ kind: 'intro', type }); // a card with its picture and hint
  }
  const d = ENEMIES[type];
  const w = Math.max(0, s.wave - 1);
  const solo = s.players.length === 1;
  // The last boss is the big one. Bosses also shrink on maps with split-up
  // defences (smaller waveSize), since only some flowers will ever see them.
  const finale = d.boss ? (s.wave >= TOTAL_WAVES ? TUNE.finalBossHp || 1 : 1) * Math.sqrt(s.m.waveSize) : 1;
  // after the breather, endless monsters toughen up faster than the crowds grow
  const endless = 1 + (TUNE.endlessHpPerWave ?? 0) * Math.max(0, s.wave - TOTAL_WAVES - 1);
  const hpScale = (TUNE.enemyHp ?? 1) * (1 + w * TUNE.hpPerWave + w * w * TUNE.hpPerWaveSquared) * (solo ? (d.boss ? TUNE.soloBossHp : 1) : TUNE.coopEnemyHp) * finale * endless;
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
    burnT: 0, burnDps: 0, vulnT: 0, vuln: 0, // Bloom: Fire Lily's burning, Stinkbloom's weak spot
  });
  if (!from) maybeElite(s, s.enemies[s.enemies.length - 1]);
}

// ---- Elite monsters and power-ups (IDEAS R2) ----------------------------------
function pickWeighted(s, table) {
  const keys = Object.keys(table);
  let r = rnd(s) * keys.reduce((a, k) => a + (table[k].weight ?? 1), 0);
  for (const k of keys) if ((r -= table[k].weight ?? 1) <= 0) return k;
  return keys[keys.length - 1];
}

// The share of eligible monsters that arrive as elites in the current wave.
export function eliteChance(s) {
  const E = ELITES;
  if (!E.enabled || s.wave < E.fromWave) return 0;
  const endless = Math.max(0, s.wave - TOTAL_WAVES);
  return Math.min(E.maxChance, E.chance + E.chancePerWave * (s.wave - E.fromWave) + (E.chanceEndlessPerWave ?? 0) * endless);
}

function maybeElite(s, e) {
  const chance = eliteChance(s);
  if (chance > 0 && ELITES.types.includes(e.type) && rnd(s) < chance) makeElite(s, e, pickWeighted(s, ELITES.traits), pickWeighted(s, ELITES.items));
}

// What it carries stays a surprise until it drops.
export function makeElite(s, e, trait, item) {
  const tr = ELITES.traits[trait] || {};
  e.elite = trait;
  e.carry = item;
  e.hp = e.maxhp = e.maxhp * ELITES.hp;
  if (tr.armor) e.armorPlus = tr.armor;
  if (tr.speed) e.speedMul = tr.speed;
  if (!s.seen.elite) { s.seen.elite = true; banner(s, 'An elite monster! Beat it for a power-up'); }
  ev(s, 'elite');
  log.logElite(s, e);
}

// Frostbloom (and the snow globe) can't hold these.
const frostproof = (e) => e.def.unslowable || e.elite === 'frostproof';

// by: the cat that put it down in a swap, who can't take it back until it
// has stepped away (otherwise standing still would swap back and forth).
function dropItem(s, kind, x, y, by = null) {
  s.items.push({ id: s.nextId++, kind, x, y, age: 0, by });
}

// Walk over a power-up to take it. A cat already carrying one swaps.
function updateItems(s, dt) {
  for (const it of s.items) {
    it.age += dt;
    if (it.age >= ELITES.itemSeconds) { it.done = true; log.logItem(s, null, it.kind, 'expired'); continue; }
    for (const p of s.players) {
      const d = dist(p, it);
      if (it.by === p.id) { if (d > T * 0.9) it.by = null; continue; }
      if (p.stun > 0 || !p.loadout || d > T * 0.6) continue;
      it.done = true;
      if (p.item) dropItem(s, p.item, p.x, p.y, p.id);
      p.item = it.kind;
      text(s, it.x, it.y - T * 0.5, `${ELITES.items[it.kind].name}!`, '#bff7ff');
      ev(s, 'pickup');
      log.logItem(s, p, it.kind, 'picked');
      break;
    }
  }
  prune(s.items, isDone);
}

function useItem(s, p) {
  const kind = p.item, cfg = ELITES.items[kind] || {};
  const { tx, ty } = tileOf(s.m, p);
  const f = s.grid.get(ty * s.m.W + tx);
  const say = (msg) => deny(s, p, p.x, p.y - T * 0.6, msg);
  if (kind === 'fertiliser') {
    if (!f) return say('Stand on a flower');
    if (f.lvl >= MAX_LEVEL) return say('Already max level');
    f.lvl = f.grow ? f.grow.to : f.lvl + 1; // a half-grown level finishes, coins already in it stay spent
    f.grow = null;
    f.hp = FLOWER_HP;
    f.flash = 0.5;
    log.logLevel(s, p, f);
    puff(s, f.x, f.y, '#8dff9a', 18, 140);
    text(s, f.x, f.y - T * 0.7, f.lvl === 1 ? `${FLOWERS[f.type].name}!` : `Level ${f.lvl}!`, '#8dff9a');
  } else if (kind === 'sun') {
    if (!f || f.lvl === 0) return say('Stand on a grown flower');
    f.sunT = cfg.seconds;
    puff(s, f.x, f.y, '#ffd23f', 16, 120);
  } else if (kind === 'water') {
    const wave = s.phase === 'wave' ? s.wave : s.wave + 1; // used in a break, it covers the coming wave
    for (const g of s.flowers) if (!g.dead && g.lvl > 0 && dist(g, p) <= cfg.radius * T) { g.hp = FLOWER_HP; g.wet = wave; }
    s.fx.push({ kind: 'ring', x: p.x, y: p.y, r: cfg.radius * T, col: '#6fc3ff', life: 0.6 });
    puff(s, p.x, p.y, '#6fc3ff', 16, 120);
  } else if (kind === 'snow') {
    for (const e of s.enemies) if (!e.dead && !e.def.boss && !frostproof(e)) { e.stun = Math.max(e.stun, cfg.seconds); e.chew = null; }
    s.fx.push({ kind: 'flash', x: p.x, y: p.y, r: T * 4 });
    banner(s, 'Snow globe! Everything freezes');
  }
  p.item = null;
  ev(s, kind === 'snow' ? 'freeze' : 'powerup');
  log.logItem(s, p, kind, 'used');
}

// Whether flowers, bombs and batons can touch this enemy right now.
export const hittable = (e) => !e.dead && !e.under;
// Out of reach of ground-only flowers and poison clouds: flyers, and
// grasshoppers in the middle of a leap.
export const airborne = (e) => e.def.flying || (e.dashing && e.def.dash.leap);

// src (optional) is who did it, for the game log: a flower type, 'baton P1'...;
// fid is the flower that did it, so the log can judge each flower's spot;
// bloom marks damage from a level-5 Bloom ability.
export function damage(s, e, amt, ignoreArmor = false, quiet = false, src = null, fid = null, bloom = false) {
  if (e.dead) return;
  let hit = ignoreArmor ? amt : Math.max(1, amt - e.def.armor - (e.armorPlus || 0));
  // Stinkbloom's Bloom: monsters in its clouds take extra damage from everything
  const weak = e.vulnT > 0 ? hit * e.vuln : 0;
  hit += weak;
  const dealt = Math.min(hit, Math.max(0, e.hp));
  e.hp -= hit;
  if (!quiet) e.flash = 0.1;
  if (e.hp <= 0) killEnemy(s, e);
  log.logDamage(s, src, e, dealt, e.dead, fid, bloom);
  if (weak > 0) log.logBloomDamage(s, 'stink', Math.min(weak, dealt));
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
  if (e.elite === 'splitting') { // smaller copies of itself, no longer elite
    const tr = ELITES.traits.splitting;
    for (let i = 0; i < tr.count; i++) {
      spawnEnemy(s, e.type, e);
      const c = s.enemies[s.enemies.length - 1];
      c.hp = c.maxhp = (e.maxhp / ELITES.hp) * tr.hp;
      c.mini = true;
    }
    ev(s, 'split');
  }
  if (e.elite) log.logEliteKilled(s);
  if (e.carry) { dropItem(s, e.carry, e.x, e.y); log.logItem(s, null, e.carry, 'dropped'); }
  // Drops shrink a little each wave, so bigger waves don't pay out ever more;
  // fractions round up by chance, so even 1-coin monsters drop less on average.
  const fade = Math.max(ECONOMY.coinFadeMin ?? 0, 1 - (ECONOMY.coinFadePerWave ?? 0) * Math.max(0, s.wave - 1));
  const raw = e.def.coin * ECONOMY.coinDropMultiplier * s.m.coinDrops * fade;
  const v = Math.floor(raw + rnd(s));
  if (v <= 0) return;
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
      damage(s, e, e.psn * e.psnDps * dt, true, true, 'stink', e.psnFid);
      if (e.psnT <= 0) e.psn = 0;
      if (e.dead) continue;
    }
    if (e.burnT > 0) { // Fire Lily's Bloom
      e.burnT -= dt;
      damage(s, e, e.burnDps * dt, true, true, 'firelily', e.burnFid, true);
      if (e.burnT <= 0) e.burnDps = 0;
      if (e.dead) continue;
    }
    if (e.vulnT > 0) e.vulnT -= dt;
    if (e.elite === 'regenerating' && !(e.psnT > 0) && !(e.burnT > 0)) e.hp = Math.min(e.maxhp, e.hp + e.maxhp * ELITES.traits.regenerating.perSecond * dt);
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
          hurtFlower(s, e.chew, e.def.eats.damagePerSecond * WEAR_MULT[e.chew.lvl] * dt, false, 'aphid'); // sturdier flowers shrug off bites
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
    let sp = e.def.speed * e.slow * (e.speedMul || 1) * (e.dashing ? e.def.dash.speedMultiplier : 1) * (e.under ? e.def.burrow.speedMultiplier : 1);
    // stag beetles run faster the more they are hurt, so chip damage along the road backfires
    if (e.def.enrage) sp *= 1 + (e.def.enrage.maxSpeedMultiplier - 1) * (1 - Math.max(0, e.hp) / e.maxhp);
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
  log.logCottage(s, e, e.def.bite * dt);
  s.baseHitT = 0.25;
  ev(s, 'chomp');
  if (s.t - s.lastAlarm > 10) {
    s.lastAlarm = s.t;
    banner(s, 'The cottage is under attack!');
    ev(s, 'leak');
    ev(s, 'shake', { amt: 4 });
  }
  if (s.lives <= 0) { s.lives = 0; s.over = true; log.logWaveEnd(s, 'lost'); ev(s, 'lose'); }
}

// ---- Waves ----------------------------------------------------------------
// The wave each monster type first turns up in. A [lo, hi] range is rolled
// once per game, so players can't always know when the flyers are coming.
function arrivals(s) {
  if (!s.arrive) s.arrive = s.m.waves.map((u) => Array.isArray(u.fromWave) ? u.fromWave[0] + Math.floor(rnd(s) * (u.fromWave[1] - u.fromWave[0] + 1)) : u.fromWave);
  return s.arrive;
}

function buildQueue(s, n) {
  const q = [];
  const from = arrivals(s);
  const size = (k) => TUNE.waveBudgetBase + k * TUNE.waveBudgetPerWave + k * k * (TUNE.waveBudgetPerWaveSquared || 0);
  // Endless waves past the breather barely grow in number (fewer coins, fewer
  // easy crowds for pulse flowers); their monsters get tougher instead.
  const endless = n > TOTAL_WAVES + 1;
  let budget = (endless ? size(TOTAL_WAVES) * (1 + (TUNE.endlessWaveSizePerWave ?? 0) * (n - TOTAL_WAVES)) : size(n))
    * (s.players.length > 1 ? TUNE.coopWaveSize : TUNE.soloWaveSize) * s.m.waveSize;
  const avail = s.m.waves.map((u, i) => ({ ...u, fromWave: from[i] })).filter((u) => u.fromWave <= n);
  const bossWave = n % TUNE.bossEvery === 0;
  if (bossWave) budget *= TUNE.bossWaveBudget;
  // the first endless wave after the big boss is a breather before it ramps up again
  const breather = n === TOTAL_WAVES + 1;
  if (breather) budget *= TUNE.breatherWaveSize ?? 1;
  // Monsters that just arrived get the spotlight; older ones slowly make room.
  const weightOf = (u) => {
    const age = n - u.fromWave;
    return u.weight * (age <= 1 ? TUNE.newEnemyBoost ?? 1 : Math.max(TUNE.oldEnemyMin ?? 1, 1 - (TUNE.oldEnemyFade ?? 0) * (age - 1)));
  };
  const total = avail.reduce((a, u) => a + weightOf(u), 0);
  while (budget > 0) {
    let r = rnd(s) * total, pick = avail[0];
    for (const u of avail) { r -= weightOf(u); if (r <= 0) { pick = u; break; } }
    const path = Math.floor(rnd(s) * s.m.paths.length); // a group sticks together on one road
    const [lo, hi] = TUNE.spawnGap || [0.4, 1.2];
    // packs (swarms, wasps) get bigger every wave after they first appear
    const group = pick.group > 1 ? Math.round(pick.group * (1 + (TUNE.packGrowthPerWave ?? 0) * (n - pick.fromWave))) : 1;
    for (let i = 0; i < group; i++) q.push({ type: pick.enemy, path, wait: group > 1 ? 0.18 : lo + rnd(s) * (hi - lo) });
    budget -= pick.cost;
  }
  // endless brings more bosses every bossEvery waves, in ordinary waves too; the extra ones come mid-wave
  const bosses = (bossWave ? 1 : 0) + (endless ? Math.floor((n - TOTAL_WAVES) / TUNE.bossEvery) * (TUNE.endlessBossesPerCycle ?? 0) : 0);
  for (let i = 0; i < bosses; i++) {
    const at = bossWave && i === bosses - 1 ? q.length : Math.floor((q.length * (i + 1)) / (bosses + 1));
    q.splice(at, 0, { type: 'boss', path: Math.floor(rnd(s) * s.m.paths.length), wait: 3 });
  }
  const k = Math.max(TUNE.spawnGapMinScale ?? 0.5, 1 - n * (TUNE.spawnSpeedupPerWave ?? 0.03));
  for (const e of q) e.wait *= k;
  // the opening rush: the first part of every wave pours out almost at once
  const rush = breather ? 0 : Math.floor(q.length * (TUNE.openingRush ?? 0));
  for (let i = 0; i < rush; i++) q[i].wait = Math.min(q[i].wait, 0.12);
  return q;
}

function startWave(s) {
  s.wave++;
  s.phase = 'wave';
  s.queue = buildQueue(s, s.wave);
  s.spawnWait = 0.5;
  log.logWaveStart(s);
  const boss = s.queue.filter((e) => e.type === 'boss').length;
  banner(s, boss > 1 ? `Wave ${s.wave} — ${boss} BOSSES!` : boss ? `Wave ${s.wave} — BOSS!` : s.wave === TOTAL_WAVES + 1 ? `Wave ${s.wave} — catch your breath` : `Wave ${s.wave}`);
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
    if (s.wave >= TOTAL_WAVES && !s.endless) { s.won = true; log.logWaveEnd(s, 'won'); ev(s, 'win'); return; }
    s.phase = 'prep';
    s.timer = TUNE.timeBetweenWaves;
    // Everyone gets a share; in co-op each cat gets a bit more than half.
    const bonus = Math.round((ECONOMY.waveBonusBase + s.wave * ECONOMY.waveBonusPerWave) * (s.players.length > 1 ? ECONOMY.coopBonusShare : 1));
    for (const p of s.players) p.coins += bonus;
    log.logWaveEnd(s, 'cleared');
    banner(s, bonus > 0 ? `Wave cleared!  +${bonus} each` : 'Wave cleared!');
    ev(s, 'clear');
    if (s.endless) saveCheckpoint(s);
  }
}

// ---- Endless mode ---------------------------------------------------------
// After winning, players can keep going: the waves carry on past the last one,
// bigger every time (the same formulas, with every boss at final-boss size).
// Each break between endless waves is saved, so a lost wave can be retried
// from the start of the break before it.
export function continueEndless(s) {
  if (!s.won) return;
  s.won = false;
  s.endless = true;
  s.phase = 'prep';
  s.timer = TUNE.timeBetweenWaves;
  log.resumeLog(s);
  banner(s, 'Endless mode: how far can you go?');
  ev(s, 'wave');
  saveCheckpoint(s);
}

// The map is shared by every state and never changes, so it isn't copied.
function saveCheckpoint(s) {
  s.checkpoint = structuredClone({ ...s, m: null, checkpoint: null, fx: [], events: [] });
}

export function retryWave(s) {
  if (!s.endless || !s.over || !s.checkpoint) return;
  const { m, checkpoint } = s;
  for (const k of Object.keys(s)) delete s[k];
  Object.assign(s, structuredClone(checkpoint), { m, checkpoint });
  banner(s, `Try wave ${s.wave + 1} again!`);
  ev(s, 'wave');
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
    damage(s, e, cs.atkDmg, false, false, `baton P${p.id + 1}`);
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
  s.bombs.push({ id: s.nextId++, sx: p.x, sy: p.y, tx, ty, x: p.x, y: p.y, h: 0, t: 0, dur: 0.6, r: catStats(p).bombRadius, dmg: catStats(p).bombDmg, owner: p.id });
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
  let hits = 0;
  for (const e of s.enemies) {
    if (!hittable(e)) continue;
    if (Math.hypot(e.x - b.tx, e.y - b.ty) <= R + e.def.r) {
      damage(s, e, b.dmg ?? PLAYER.bombDmg, true, false, `bomb P${(b.owner ?? 0) + 1}`);
      applyStun(e, PLAYER.bombStun);
      hits++;
    }
  }
  log.logBomb(s, b, Math.floor(b.tx / T), Math.floor(b.ty / T), hits);
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
    hp: FLOWER_HP, headIdx: 0, dead: false, grow: { to: 1, cost: plantCost(type), paid: 0 },
  };
  s.flowers.push(nf);
  log.logPlanted(s, p, nf);
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
  if (p.healF !== f.id || s.t - p.healT > 0.5) log.logHealStart(s, p, f);
  p.healF = f.id; p.healT = s.t;
  p.coins -= pay;
  log.logCoins(s, p, 'heal', pay);
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
  log.logCoins(s, p, g.to === 1 ? 'plant' : 'upgrade', pay);
  g.paid += prog;
  f.spent = (f.spent || 0) + pay;
  p.working = f;
  ev(s, 'pour');
  if (g.paid >= g.cost - 1e-6) {
    f.lvl = g.to;
    log.logLevel(s, p, f);
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
  log.logCoins(s, p, 'refund', refund);
  log.logDug(s, p, f, refund);
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
    if (inp.use && p.item) useItem(s, p);

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
function hurtFlower(s, f, amt, quiet = false, cause = 'wear') {
  if (f.dead || f.lvl >= MAX_LEVEL) return;
  f.hp -= amt;
  if (!quiet) f.hurtT = 0.15;
  if (f.hp <= 0) {
    f.dead = true;
    s.grid.delete(f.ty * s.m.W + f.tx);
    puff(s, f.x, f.y, '#9a7b55', 16, 100);
    text(s, f.x, f.y - T * 0.5, 'Wilted…', '#d9b38c');
    ev(s, 'wilt');
    log.logWilt(s, f, cause);
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
    if (s.phase === 'wave' && f.wet !== s.wave) hurtFlower(s, f, WEAR_PER_SEC * WEAR_MULT[f.lvl] * dt, true, 'wear'); // a watering can stops it for a wave
    if (f.sunT > 0) f.sunT -= dt;
    if (f.dead) continue;
    f.cd -= dt;
    if (f.cd > 0) continue;
    const st = flowerStats(f.type, f.lvl), bl = bloomOf(f.type, f.lvl);
    let best = null;
    const inRange = [];
    for (const e of s.enemies) {
      if (!hittable(e) || (st.groundOnly && airborne(e)) || (st.kind === 'cloud' && e.def.poisonImmune)) continue;
      if (dist(e, f) <= st.range + e.def.r) {
        inRange.push(e);
        // 'strong' locks onto the toughest monster (by max health), so a nearly
        // dead boss isn't abandoned for its fresh minions
        const better = st.target === 'strong' ? !best || e.maxhp > best.maxhp || (e.maxhp === best.maxhp && e.hp < best.hp) : !best || e.left < best.left;
        if (better) best = e;
      }
    }
    if (!best) continue;
    f.cd = st.rate / (f.sunT > 0 ? ELITES.items.sun.fireRate : 1); // a sun orb speeds it up
    f.shots = (f.shots || 0) + 1;
    const burst = !!bl?.every && f.shots % bl.every === 0; // this attack is the Bloom one
    f.angle = Math.atan2(best.y - f.y, best.x - f.x);
    f.flash = 0.15;
    f.headIdx = (f.headIdx + 1) % Math.min(f.lvl, 5);
    const hx = f.x, hy = f.y - T * 0.35;
    if (st.kind === 'single') {
      s.projs.push({ id: s.nextId++, kind: 'single', x: hx, y: hy, target: best, speed: 460 * U, dmg: st.dmg, color: st.color, src: f.type, fid: f.id, split: burst ? { ...bl } : null });
    } else if (st.kind === 'beam') {
      damage(s, best, st.dmg, false, false, f.type, f.id);
      if (bl?.maxHp && !best.dead) { damage(s, best, best.maxhp * bl.maxHp, true, true, f.type, f.id, true); log.logBloom(s, f.type); }
      s.fx.push({ kind: 'beam', x: hx, y: hy, x2: best.x, y2: best.y, col: st.color, w: 4 + f.lvl });
      puff(s, best.x, best.y, '#fff3a0', 10, 110);
    } else if (st.kind === 'bolt') {
      const a = Math.atan2(best.y - hy, best.x - hx);
      s.projs.push({ id: s.nextId++, kind: 'bolt', x: hx, y: hy, ang: a, speed: 420 * U, dmg: st.dmg, left: st.range * 1.25, hit: [], pierce: st.pierce ?? Infinity, color: st.color, big: f.lvl, src: f.type, fid: f.id, burn: bl?.seconds ? { ...bl } : null });
    } else if (st.kind === 'chomp') {
      // small critters get swallowed whole; everything else loses a bite plus a
      // share of its max health, so the bigger the monster the bigger the chunk
      // Snapdragon's Bloom: anything but a boss gets swallowed once it's weak enough
      const finish = !!bl?.below && !best.def.boss && !best.def.light && best.hp <= best.maxhp * bl.below;
      const gulp = (best.def.light && !best.def.boss) || finish;
      const chunk = best.maxhp * ((best.def.boss ? st.bossMaxHpBite : st.maxHpBite) || 0);
      damage(s, best, gulp ? best.hp + 1 : st.dmg + chunk, gulp, false, f.type, f.id, finish);
      if (finish) log.logBloom(s, f.type);
      s.fx.push({ kind: 'bite', x: best.x, y: best.y, r: best.def.r + 8 * U });
      if (gulp) text(s, best.x, best.y - T * 0.4, 'GULP!', '#ff9ac8');
    } else if (st.kind === 'cloud') {
      s.projs.push({
        id: s.nextId++, kind: 'lob', x: hx, y: hy, sx: hx, sy: hy, tx: best.x, ty: best.y, speed: 260 * U, color: st.color, t: 0,
        cloud: { r: st.cloudR, dur: st.cloudDur, dps: st.dmg, stacks: st.stacks, fid: f.id, vuln: bl?.vulnerable ?? 0, vulnSec: bl?.seconds ?? 0 },
      });
      if (bl?.vulnerable) log.logBloom(s, f.type);
    } else {
      let hits = inRange, r = st.range;
      if (burst && bl.range) { // Thornrose's Bloom: a pulse twice as wide
        r = st.range * bl.range;
        hits = s.enemies.filter((e) => hittable(e) && dist(e, f) <= r + e.def.r);
      }
      s.fx.push({ kind: 'ring', x: f.x, y: f.y, r, col: st.color, life: burst ? 0.5 : 0.35 });
      for (const e of hits) {
        if (st.dmg > 0) damage(s, e, st.dmg, false, false, f.type, f.id); // the frostbloom only slows
        if (st.slow && !frostproof(e)) { e.slow = Math.min(e.slow, st.slow); e.slowT = Math.max(e.slowT, st.slowSeconds); }
        if (!burst || e.dead || e.def.boss) continue;
        // Bloom: Thornrose shoves small monsters away, Frostbloom freezes them solid
        const dx = e.x - f.x, dy = e.y - f.y, d = Math.hypot(dx, dy);
        if (bl.knock && e.def.light && d > 0) { e.kx += (dx / d) * bl.knock * T; e.ky += (dy / d) * bl.knock * T; }
        if (bl.freeze && !frostproof(e)) { e.stun = Math.max(e.stun, bl.freeze); e.chew = null; }
      }
      if (burst) log.logBloom(s, f.type);
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
      if (d <= mv + p.target.def.r) {
        damage(s, p.target, p.dmg, false, false, p.src, p.fid, !!p.bloom);
        p.done = true;
        puff(s, p.target.x, p.target.y, p.color, 3, 60);
        if (p.split) splitSeed(s, p);
      }
      else { p.x += (dx / d) * mv; p.y += (dy / d) * mv; }
    } else if (p.kind === 'bolt') {
      const mv = p.speed * dt;
      p.x += Math.cos(p.ang) * mv; p.y += Math.sin(p.ang) * mv;
      p.left -= mv;
      for (const e of s.enemies) {
        if (!hittable(e) || p.hit.includes(e.id)) continue;
        if (Math.hypot(e.x - p.x, e.y - p.y) <= e.def.r + 10 * U) {
          p.hit.push(e.id);
          damage(s, e, p.dmg, false, false, p.src, p.fid);
          puff(s, e.x, e.y, '#ffb347', 5, 80);
          if (p.burn && !e.dead) { // Fire Lily's Bloom sets it alight
            e.burnDps = Math.max(e.burnT > 0 ? e.burnDps : 0, p.dmg * p.burn.share);
            e.burnT = p.burn.seconds;
            e.burnFid = p.fid;
            log.logBloom(s, p.src);
          }
          if (p.hit.length >= p.pierce) { p.done = true; break; } // burnt out
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

// Daisy's Bloom: a seed bursts into more seeds that fly on to the monsters
// nearest the one it hit.
function splitSeed(s, p) {
  const t = p.target, b = p.split;
  const near = s.enemies.filter((e) => e !== t && hittable(e) && dist(e, t) <= b.reach * T).sort((a, c) => dist(a, t) - dist(c, t)).slice(0, b.pieces);
  for (const e of near) s.projs.push({ id: s.nextId++, kind: 'single', x: t.x, y: t.y, target: e, speed: 460 * U, dmg: p.dmg * b.damage, color: p.color, src: p.src, fid: p.fid, bloom: true });
  if (near.length) log.logBloom(s, p.src);
}

// Poison clouds add a stack to every ground enemy inside, twice a second.
function updateClouds(s, dt) {
  for (const c of s.clouds) {
    c.t += dt;
    c.tick -= dt;
    if (c.tick <= 0) {
      c.tick = 0.5;
      for (const e of s.enemies) {
        if (!hittable(e) || airborne(e) || e.def.poisonImmune) continue;
        if (Math.hypot(e.x - c.x, e.y - c.y) > c.r + e.def.r) continue;
        e.psn = Math.min(c.stacks, e.psn + 1);
        e.psnT = POISON_TIME;
        e.psnDps = Math.max(e.psnDps, c.dps);
        e.psnFid = c.fid; // the log credits the poison to the newest cloud's flower
        if (c.vuln) { e.vuln = c.vuln; e.vulnT = Math.max(e.vulnT, c.vulnSec); } // Stinkbloom's Bloom
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
        log.logCoins(s, near, 'earned', d.value * (1 - share));
        for (const p of s.players) { p.coins += (d.value * share) / s.players.length; log.logCoins(s, p, 'earned', (d.value * share) / s.players.length); }
        text(s, d.x, d.y - 10, `+${d.value}`, '#ffd23f');
        ev(s, d.big ? 'bigCoin' : 'coin');
      }
    }
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
    log.startLog(s);
  }
}

export function step(s, inputs, dt) {
  if (s.phase === 'pick') { updatePick(s, inputs); return; }
  if (s.over || s.won) return;
  s.t += dt;
  s.baseHitT = Math.max(0, s.baseHitT - dt);
  const ready = updatePlayers(s, dt, inputs);
  if (s.stats) log.logTick(s, dt, tileOf);
  updateWaves(s, dt, ready);
  updateEnemies(s, dt);
  updateFlowers(s, dt);
  updateProjs(s, dt);
  updateClouds(s, dt);
  updateBombs(s, dt);
  prune(s.enemies, isDead);
  updateDrops(s, dt);
  updateItems(s, dt);
}
