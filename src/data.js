// Game data. All tunable numbers live in /balance.json (in tiles and seconds);
// this module loads it and converts to the pixel units the game uses.
import { seededRandom } from './util.js';
const BAL = await (await fetch(new URL('../balance.json', import.meta.url), { cache: 'no-store' })).json();
export const BALANCE = BAL;

const MAP_DEFS = (await (await fetch(new URL('../maps.json', import.meta.url), { cache: 'no-store' })).json()).maps;

// A short fingerprint of the numbers and maps, so two online players can
// check they are playing the same game (FNV-1a over the JSON).
export const DATA_HASH = (() => {
  let h = 0x811c9dc5;
  for (const ch of JSON.stringify([BAL, MAP_DEFS])) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
  return (h >>> 0).toString(16);
})();

export const T = 56;
export const U = T / 40;           // sprite scale (art is authored for a 40px tile)
export const VIEW_W = 18 * T;      // visible part of the world
export const MAP_H = 10 * T;
export const HUD_H = 96;
export const TOTAL_WAVES = BAL.difficulty.totalWaves;

// ---- maps ----

function prepareMap(def, index) {
  const w = def.width, h = def.height;
  const center = ([x, y]) => ({ x: (x + 0.5) * T, y: (y + 0.5) * T });
  const pathTiles = new Set();
  const paths = def.paths.map((pts) => {
    let length = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++)
        for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) pathTiles.add(y * w + x);
      length += (Math.abs(x1 - x0) + Math.abs(y1 - y0)) * T;
    }
    // enemies appear one tile outside the map edge, walking in
    const dx = Math.sign(pts[1][0] - pts[0][0]), dy = Math.sign(pts[1][1] - pts[0][1]);
    const spawn = center([pts[0][0] - dx, pts[0][1] - dy]);
    return { points: pts, waypoints: pts.map(center), spawn, dir: Math.atan2(dy, dx), length: length + T };
  });
  const blocked = new Set();
  const obstacles = [];
  const footbridges = new Set(); // cat-only bridges over water
  for (const o of def.obstacles || []) {
    if (o.type === 'bridge') {
      for (let y = o.y; y < o.y + o.h; y++) for (let x = o.x; x < o.x + o.w; x++) { footbridges.add(y * w + x); blocked.add(y * w + x); }
    } else if (o.type === 'pond') {
      for (let y = o.y; y < o.y + o.h; y++) for (let x = o.x; x < o.x + o.w; x++) blocked.add(y * w + x);
      obstacles.push({ ...o });
    } else {
      blocked.add(o.y * w + o.x);
      obstacles.push({ ...o, w: 1, h: 1 });
    }
  }
  // The cottage yard: free to walk through, but nobody plants there, so
  // monsters can always reach the walls and chomp.
  const near = (x, y, [px, py], r) => Math.abs(x - px) <= r && Math.abs(y - py) <= r;
  const yard = new Set();
  for (let y = def.base[1] - 1; y <= def.base[1] + 1; y++)
    for (let x = def.base[0] - 1; x <= def.base[0] + 1; x++) {
      if (x < 0 || y < 0 || x >= w || y >= h || pathTiles.has(y * w + x)) continue;
      yard.add(y * w + x);
      blocked.add(y * w + x);
    }
  const rnd = seededRandom(def.scatter?.seed || 1);
  for (const [type, count] of [['tree', def.scatter?.trees || 0], ['rock', def.scatter?.rocks || 0]]) {
    for (let placed = 0, tries = 0; placed < count && tries < count * 50; tries++) {
      const x = Math.floor(rnd() * w), y = Math.floor(rnd() * h), k = y * w + x;
      if (pathTiles.has(k) || blocked.has(k) || near(x, y, def.start, 2) || near(x, y, def.base, 2)) continue;
      blocked.add(k);
      obstacles.push({ type, x, y, w: 1, h: 1, v: rnd() });
      placed++;
    }
  }
  // Bridges: water tiles a road or a footbridge crosses. Everyone can walk
  // over them, nobody can plant on them. Each deck runs along the way it is
  // crossed (dir 'h' or 'v'), so its planks can be drawn the right way.
  const water = new Set();
  for (const o of obstacles) if (o.type === 'pond') for (let y = o.y; y < o.y + o.h; y++) for (let x = o.x; x < o.x + o.w; x++) water.add(y * w + x);
  const crossing = (k) => pathTiles.has(k) || footbridges.has(k);
  const decks = [];
  for (const k of water) {
    if (!crossing(k)) continue;
    const x = k % w, y = (k - x) / w;
    const h = (x > 0 && crossing(k - 1)) || (x < w - 1 && crossing(k + 1));
    decks.push({ x, y, dir: h ? 'h' : 'v' });
  }
  const deckTiles = new Set(decks.map((d) => d.y * w + d.x));
  // What cats bump into: rounded boxes (ponds) and circles (tree trunks, rocks),
  // matched to the drawings. Each is listed under every tile it touches.
  // A pond with a bridge across it is made of square tiles instead, leaving
  // the deck free.
  const solids = new Map();
  const addSolid = (k, s) => { if (!solids.has(k)) solids.set(k, []); solids.get(k).push(s); };
  for (const o of obstacles) {
    let s;
    if (o.type === 'pond' && [...Array(o.w * o.h).keys()].some((i) => deckTiles.has((o.y + Math.floor(i / o.w)) * w + o.x + (i % o.w)))) {
      for (let y = o.y; y < o.y + o.h; y++) for (let x = o.x; x < o.x + o.w; x++) {
        if (!deckTiles.has(y * w + x)) addSolid(y * w + x, { x0: x * T, y0: y * T, x1: (x + 1) * T, y1: (y + 1) * T, rad: 0 });
      }
      continue;
    } else if (o.type === 'pond') {
      const rad = T * 0.4;
      s = { x0: o.x * T + 4 + rad, y0: o.y * T + 4 + rad, x1: (o.x + o.w) * T - 4 - rad, y1: (o.y + o.h) * T - 4 - rad, rad };
    } else {
      const cx = (o.x + 0.5) * T, cy = (o.y + 0.5) * T + (o.type === 'tree' ? T * 0.08 : 2);
      const rad = o.type === 'tree' ? T * 0.28 : T * 0.3 * (0.7 + (o.v || 0.5) * 0.4);
      s = { x0: cx, y0: cy, x1: cx, y1: cy, rad };
    }
    for (let y = o.y; y < o.y + o.h; y++) for (let x = o.x; x < o.x + o.w; x++) addSolid(y * w + x, s);
  }
  return {
    index, id: def.id, name: def.name, desc: def.desc, W: w, H: h, waveSize: def.waveSize ?? 1, startCoins: def.startCoins ?? 1, worldW: w * T, worldH: h * T,
    paths, base: center(def.base), baseTile: def.base, start: center(def.start), pathTiles, blocked, yard, obstacles, solids, decks,
  };
}

// Every map, ready to play. A game keeps the one it is on as s.m.
export const MAPS = MAP_DEFS.map(prepareMap);

// ---- enemies (pixels, pixels/second) ----
export const ENEMIES = {};
for (const [id, e] of Object.entries(BAL.enemies)) {
  ENEMIES[id] = {
    ...e,
    speed: e.speed * T,
    r: e.size * T,
    coin: e.coins,
    bite: e.bite,
    heals: e.heals && { radius: e.heals.radius * T, perSecond: e.heals.perSecond },
    eats: e.eats && { ...e.eats, reach: e.eats.reach * T },
  };
}
export const WAVES = BAL.waves;

// ---- flowers ----
export const FLOWER_ORDER = Object.keys(BAL.flowers);
const LV = BAL.flowerLevels;
export const LOADOUT_SIZE = LV.loadoutSize;
export const MAX_LEVEL = LV.maxLevel;
export const FLOWERS = {};
for (const [id, f] of Object.entries(BAL.flowers)) {
  FLOWERS[id] = {
    ...f,
    dmg: f.damage,
    range: f.range * T,
    cloudR: f.cloudRadius ? f.cloudRadius * T : undefined,
    cloudDur: f.cloudSeconds,
    stacks: f.maxStacks,
  };
}

// Seconds for one cat to pour the full cost into a level (index = target level).
export const GROW_TIME = [0, ...LV.growSeconds];
export const FLOWER_HP = LV.health;
export const WEAR_PER_SEC = LV.wearPerSecond;
export const WEAR_MULT = [0, ...LV.wearMultiplierByLevel];
export const HEAL_RATE = LV.healPerSecond;
export const HEAL_COST = LV.fullHealCostFraction;
export const POISON_TIME = LV.poisonSeconds;

// A flower's numbers at a level. Every flower looks these up every tick, so
// each type and level is worked out once (callers must not change the result).
const statsCache = new Map();
export function flowerStats(type, lvl) {
  const key = type + lvl;
  let st = statsCache.get(key);
  if (!st) { st = Object.freeze(computeStats(type, lvl)); statsCache.set(key, st); }
  return st;
}
// For console balance experiments that change FLOWERS in place.
export const clearFlowerStats = () => statsCache.clear();

function computeStats(type, lvl) {
  const b = FLOWERS[type];
  const l = lvl - 1;
  const pl = LV.perLevel;
  return {
    ...b,
    range: b.range * (1 + pl.range * l),
    dmg: b.dmg * (1 + pl.damage * l),
    rate: b.rate * (1 - pl.fasterFiring * l),
    slow: b.slow ? Math.max(0.25, b.slow - pl.slowStrength * l) : undefined,
    pierce: b.pierce ? Math.floor(b.pierce + (pl.pierce ?? 0) * l) : undefined,
    slowSeconds: b.slow ? (b.slowSeconds ?? 1.3) * (1 + (pl.slowDuration ?? 0) * l) : undefined,
    stacks: b.stacks ? b.stacks + pl.poisonStacks * l : undefined,
    cloudR: b.cloudR ? b.cloudR * (1 + pl.cloudSize * l) : undefined,
  };
}

// Cost to go from `lvl` to `lvl + 1`.
export function upgradeCost(type, lvl) {
  return Math.round(FLOWERS[type].cost * LV.upgradeCostMultipliers[lvl - 1] * (LV.upgradePrice ?? 1));
}

// Coins to plant a seedling and grow it to level 1.
export function plantCost(type) {
  return Math.round(FLOWERS[type].cost * (LV.plantPrice ?? 1));
}

// Ranges at least this big mean "the whole map" (no range circle is drawn).
export const GLOBAL_RANGE = 40 * T;

// ---- cat classes ----
export const CAT_ORDER = Object.keys(BAL.cats);
export const CATS = BAL.cats;

export const ECONOMY = BAL.economy;
export const DIFFICULTY = BAL.difficulty;
export const START_COINS = { solo: ECONOMY.startCoinsSolo, coop: ECONOMY.startCoinsCoop };

const P = BAL.player;
export const PLAYER = {
  speed: P.speed * T,
  atkRange: P.batonRange * T,
  atkArc: (P.batonArcDegrees * Math.PI) / 180,
  atkDmg: P.batonDamage,
  atkCd: P.batonCooldown,
  knock: P.batonKnockback * T,
  bombRange: P.bombThrowDistance * T,
  bombRadius: P.bombRadius * T,
  bombDmg: P.bombDamage,
  bombStun: P.bombStunEnemies,
  catStun: P.bombStunCats,
  bombMax: 1,
  swingTime: 0.18, // seconds the baton's arc is on screen
  bombRecharge: P.bombRecharge,
  sprintSpeed: P.sprintSpeed,
  sprintSeconds: P.sprintSeconds,
  sprintRecover: P.sprintRecoverSeconds,
  sprintDelay: P.sprintRecoverDelay,
  scarves: ['#3a7bd5', '#e04f7a'],
};
