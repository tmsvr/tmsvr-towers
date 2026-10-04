// Game data. All tunable numbers live in /balance.json (in tiles and seconds);
// this module loads it and converts to the pixel units the game uses.
const BAL = await (await fetch(new URL('../balance.json', import.meta.url))).json();
export const BALANCE = BAL;

export const T = 56;
export const U = T / 40;           // sprite scale (art is authored for a 40px tile)
export const W = 36;               // world size in tiles
export const H = 22;
export const WORLD_W = W * T;
export const WORLD_H = H * T;
export const VIEW_W = 18 * T;      // visible part of the world
export const MAP_H = 10 * T;
export const HUD_H = 96;
export const TOTAL_WAVES = BAL.difficulty.totalWaves;

const PTS = [
  [0, 3], [7, 3], [7, 9], [3, 9], [3, 18], [11, 18], [11, 13], [16, 13],
  [16, 4], [23, 4], [23, 17], [29, 17], [29, 8], [35, 8],
];
export const WAYPOINTS = PTS.map(([x, y]) => ({ x: (x + 0.5) * T, y: (y + 0.5) * T }));
export const SPAWN = { x: -T * 0.5, y: 3.5 * T };
export const BASE = WAYPOINTS[WAYPOINTS.length - 1];

export const PATH_TILES = new Set();
for (let i = 0; i < PTS.length - 1; i++) {
  const [x0, y0] = PTS[i];
  const [x1, y1] = PTS[i + 1];
  for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++)
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) PATH_TILES.add(y * W + x);
}

// ---- enemies (pixels, pixels/second) ----
export const ENEMIES = {};
for (const [id, e] of Object.entries(BAL.enemies)) {
  ENEMIES[id] = {
    ...e,
    speed: e.speed * T,
    r: e.size * T,
    coin: e.coins,
    leak: e.livesLost,
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

export function flowerStats(type, lvl) {
  const b = FLOWERS[type];
  const l = lvl - 1;
  const pl = LV.perLevel;
  return {
    ...b,
    range: b.range * (1 + pl.range * l),
    dmg: b.dmg * (1 + pl.damage * l),
    rate: b.rate * (1 - pl.fasterFiring * l),
    slow: b.slow ? Math.max(0.25, b.slow - pl.slowStrength * l) : undefined,
    stacks: b.stacks ? b.stacks + pl.poisonStacks * l : undefined,
    cloudR: b.cloudR ? b.cloudR * (1 + pl.cloudSize * l) : undefined,
  };
}

// Cost to go from `lvl` to `lvl + 1`.
export function upgradeCost(type, lvl) {
  return Math.round(FLOWERS[type].cost * LV.upgradeCostMultipliers[lvl - 1]);
}

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
  bombRecharge: P.bombRecharge,
  colors: ['#ff9a3c', '#a7b1c4'],
  darks: ['#c4600f', '#6c778c'],
  scarves: ['#3a7bd5', '#e04f7a'],
};
