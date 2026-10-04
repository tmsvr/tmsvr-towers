// Static game data: map, enemy and flower definitions.
// Sprite sizes are authored for a 40px tile and scaled by U.
export const T = 56;
export const U = T / 40;
export const W = 36;               // world size in tiles
export const H = 22;
export const WORLD_W = W * T;
export const WORLD_H = H * T;
export const VIEW_W = 18 * T;      // visible part of the world
export const MAP_H = 10 * T;
export const HUD_H = 96;
export const TOTAL_WAVES = 15;

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

// light: small enough for the baton to knock back
const e = (hp, speed, coin, leak, r, armor, extra = {}) => ({ hp, speed: speed * 1.5, coin, leak, r: r * U, armor, ...extra });
export const ENEMIES = {
  grunt:    e(32, 50, 2, 1, 11, 0),
  swarm:    e(9, 72, 1, 1, 7, 0, { light: true }),
  runner:   e(20, 100, 2, 1, 10, 0, { light: true }),
  flyer:    e(26, 62, 3, 1, 10, 0, { flying: true }),
  wasp:     e(16, 118, 2, 1, 8, 0, { flying: true, light: true }),
  shield:   e(70, 42, 4, 1, 13, 3),
  healer:   e(44, 46, 4, 1, 11, 0, { heals: true }),
  tank:     e(170, 32, 7, 2, 16, 1),
  dasher:   e(30, 44, 3, 1, 10, 0, { dash: true }),               // sprints in bursts
  splitter: e(60, 40, 3, 1, 14, 0, { split: { type: 'blobling', n: 3 } }),
  blobling: e(12, 98, 1, 1, 7, 0, { light: true }),
  mole:     e(48, 48, 3, 1, 11, 0, { burrow: true }),             // untargetable while underground
  aphid:    e(28, 52, 2, 1, 9, 0, { eats: true, light: true }),   // stops to chew on flowers
  hive:     e(150, 28, 7, 2, 17, 1, { spawns: { type: 'swarm', every: 4.5, n: 2 } }),
  boss:     e(1000, 26, 40, 5, 24, 2, { boss: true, spawns: { type: 'grunt', every: 6, n: 2 } }),
};

export const FLOWER_ORDER = ['daisy', 'sunflower', 'firelily', 'stink', 'frost', 'thorn', 'snap'];
export const LOADOUT_SIZE = 4; // each player brings 4 of the 7 flowers into a game
// range is in tiles here, converted to pixels below
const f = (o) => ({ ...o, range: o.range * T, cloudR: o.cloudR ? o.cloudR * T : undefined });
export const FLOWERS = {
  daisy:     f({ name: 'Daisy',      desc: 'Rapid little seeds',                 cost: 20, range: 2.2, dmg: 5,  rate: 0.4, kind: 'single', color: '#ffffff' }),
  sunflower: f({ name: 'Sunflower',  desc: 'Huge range, slow, massive damage to the strongest', cost: 55, range: 5.5, dmg: 75, rate: 3.2, kind: 'beam', target: 'strong', color: '#ffd23f' }),
  firelily:  f({ name: 'Fire Lily',  desc: 'Fireball pierces everything in a line', cost: 45, range: 3, dmg: 14, rate: 1.6, kind: 'bolt', color: '#ff7a2f' }),
  stink:     f({ name: 'Stinkbloom', desc: 'Poison clouds stack, ignore armor (ground)', cost: 45, range: 2.6, dmg: 2.2, rate: 2.4, kind: 'cloud', cloudR: 0.95, cloudDur: 3.5, stacks: 5, groundOnly: true, color: '#9ad14b' }),
  frost:     f({ name: 'Frostbloom', desc: 'Slows everything nearby',            cost: 35, range: 1.8, dmg: 2,  rate: 0.8, kind: 'pulse', slow: 0.55, color: '#8fe3ff' }),
  thorn:     f({ name: 'Thornrose',  desc: 'Spiky pulse hits all close enemies (ground)', cost: 35, range: 1.3, dmg: 11, rate: 0.6, kind: 'pulse', groundOnly: true, color: '#ff4d5e' }),
  snap:      f({ name: 'Snapdragon', desc: 'Swallows small critters whole, big bite on the rest (ground)', cost: 40, range: 1.3, dmg: 45, rate: 2.4, kind: 'chomp', groundOnly: true, color: '#e0569b' }),
};
export const MAX_LEVEL = 5;

// Seconds for one cat to pour the full cost into a level (index = target level).
export const GROW_TIME = [0, 2, 3, 4.5, 6, 7.5];
export const FLOWER_HP = 100;
export const WEAR_PER_SEC = 0.55;                  // hp lost per second of fighting at level 1
export const WEAR_MULT = [0, 1, 0.8, 0.65, 0.5, 0]; // max level flowers never wear
export const HEAL_RATE = 40;                       // hp per second while a cat heals
export const HEAL_COST = 0.3;                      // full heal = this fraction of base cost
export const CHEW_DPS = 8;                         // aphid damage per second to flowers
export const POISON_TIME = 3;                      // seconds poison stacks last after leaving a cloud

export function flowerStats(type, lvl) {
  const b = FLOWERS[type];
  const l = lvl - 1;
  return {
    ...b,
    range: b.range * (1 + 0.06 * l),
    dmg: b.dmg * (1 + 0.5 * l),
    rate: b.rate * (1 - 0.07 * l),
    slow: b.slow ? Math.max(0.25, b.slow - 0.07 * l) : undefined,
    stacks: b.stacks ? b.stacks + l : undefined,
    cloudR: b.cloudR ? b.cloudR * (1 + 0.08 * l) : undefined,
  };
}

// Cost to go from `lvl` to `lvl + 1`.
export function upgradeCost(type, lvl) {
  return Math.round(FLOWERS[type].cost * [0, 0.8, 1.1, 1.5, 2][lvl]);
}

export const START_COINS = { solo: 60, coop: 40 };

export const PLAYER = {
  speed: 165 * U,
  atkRange: 58 * U,
  atkArc: Math.PI * 0.7,
  atkDmg: 10,
  atkCd: 0.38,
  knock: 200 * U,
  bombRange: 150 * U,
  bombRadius: 75 * U,
  bombStun: 2.5,
  catStun: 1.8,     // cats caught in a bomb blast are knocked down
  bombMax: 1,
  bombRecharge: 14,
  colors: ['#ff9a3c', '#a7b1c4'],
  darks: ['#c4600f', '#6c778c'],
  scarves: ['#3a7bd5', '#e04f7a'],
};
