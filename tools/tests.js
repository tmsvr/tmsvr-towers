// The test suite. No framework and no build step: open /tools/tests.html, or
// from the console: (await import('/tools/tests.js')).runTests()
// Every test drives the real modules (sim, data, schema, stats, render), so a
// failure here is a failure in the game.
import * as sim from '../src/sim.js';
import {
  T, MAPS, FLOWERS, FLOWER_ORDER, MAX_LEVEL, FLOWER_HP, ENEMIES, CATS, CAT_ORDER, BALANCE, TOTAL_WAVES,
  plantCost, upgradeCost, flowerStats, WEAR_MULT, BLOOM, bloomOf, ELITES, SHIELD, CHEST, LOADOUT_SIZE, PLAYER,
} from '../src/data.js';
import { encodeSnapshot, encodeInputs, decodeFast } from '../src/schema.js';
import { gameSummary } from '../src/stats.js';
import { render, num, clock, setView, BASE_W, BASE_H, VIEW_W, MAP_H } from '../src/render.js';
import { runBot } from './bot.js';
import { encodeCode, decodeCode, codeOf, dailyChallenge, shareText } from '../src/challenge.js';
import { raceStatus, raceResult } from '../src/versus.js';
import { createHostLink } from '../src/host.js';
import { saveGame, loadGame } from '../src/save.js';

const DT = 1 / 60;
const tests = [];
const test = (group, name, fn) => tests.push({ group, name, fn });

class Fail extends Error {}
const ok = (cond, msg) => { if (!cond) throw new Fail(msg); };
const eq = (a, b, msg) => ok(a === b, `${msg}: expected ${b}, got ${a}`);
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, `${msg}: expected ${b} ±${tol}, got ${a}`);

// ---- helpers ------------------------------------------------------------------
const idle = (s) => s.players.map(() => ({}));
const tick = (s, inp = {}, who = 0) => { const all = idle(s); all[who] = inp; sim.step(s, all, DT); };

// A game past the pick screen, every cat rich, on the given map.
function game({ cats = ['bomber'], map = 0, seed = 7, loadout = ['thorn', 'frost', 'daisy'] } = {}) {
  const s = sim.createState(cats.length, seed, { map, cats });
  s.players.forEach((p) => { p.pick.chosen = loadout.slice(); p.pick.ready = true; });
  sim.step(s, idle(s), DT);
  for (const p of s.players) p.coins = 5000;
  return s;
}

// The free tile nearest the map's start.
function freeTile(s, avoid = []) {
  const [sx, sy] = [Math.floor(s.m.start.x / T), Math.floor(s.m.start.y / T)];
  for (let r = 1; r < 12; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const x = sx + dx, y = sy + dy;
    if (sim.canBuildAt(s, x, y) && !avoid.some(([ax, ay]) => ax === x && ay === y)) return [x, y];
  }
  throw new Fail('no free tile near the start');
}
// A free tile right next to a road (for monsters to walk past).
function tileByRoad(s) {
  for (const k of s.m.pathTiles) {
    const x = k % s.m.W, y = (k - x) / s.m.W;
    if (x < 2 || y < 2 || x > s.m.W - 3 || y > s.m.H - 3) continue;
    for (const [dx, dy] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) if (sim.canBuildAt(s, x + dx, y + dy)) return { flower: [x + dx, y + dy], road: [x, y] };
  }
  throw new Fail('no tile next to a road');
}
const goTo = (p, [x, y]) => { p.x = (x + 0.5) * T; p.y = (y + 0.5) * T; };
const flowerAt = (s, [x, y]) => s.grid.get(y * s.m.W + x);

// Plant `type` on a tile with the real keys: the first tap shows the ghost, the second plants.
function plant(s, p, at, type) {
  goTo(p, at);
  p.sel = p.loadout.indexOf(type);
  ok(p.sel >= 0, `${type} is not in the loadout`);
  tick(s, { buildTap: true }, p.id); tick(s, {}, p.id); tick(s, { buildTap: true }, p.id);
  const f = flowerAt(s, at);
  ok(f && f.type === type, `planting ${type} failed`);
  return f;
}
// Hold the plant key until the flower reaches the next level (or `secs` run out).
function growOnce(s, p, f, secs = 20) {
  const from = f.lvl;
  for (let i = 0; i < secs * 60 && f.lvl === from; i++) { p.waitRelease = false; tick(s, { build: true }, p.id); }
  ok(f.lvl === from + 1, `growing from level ${from} didn't finish`);
}

// ---- data ---------------------------------------------------------------------
test('Data', 'every price is a whole multiple of the price step', () => {
  const step = BALANCE.flowerLevels.priceStep || 1;
  for (const t of FLOWER_ORDER) {
    const prices = [plantCost(t), ...Array.from({ length: MAX_LEVEL - 1 }, (_, i) => upgradeCost(t, i + 1))];
    for (const v of prices) ok(v > 0 && v % step === 0, `${t} has a price of ${v}`);
  }
});

test('Data', 'flowers never get worse when upgraded', () => {
  for (const t of FLOWER_ORDER) for (let l = 1; l < MAX_LEVEL; l++) {
    const a = flowerStats(t, l), b = flowerStats(t, l + 1);
    ok(b.dmg >= a.dmg && b.range >= a.range && b.rate <= a.rate, `${t} level ${l + 1} is weaker than level ${l}`);
  }
});

test('Data', 'every wave list names real monsters with sane arrival waves', () => {
  const lists = { waves: BALANCE.waves, ...BALANCE.waveSets };
  for (const [name, list] of Object.entries(lists)) for (const u of list) {
    ok(ENEMIES[u.enemy], `${name}: unknown monster ${u.enemy}`);
    const [lo, hi] = Array.isArray(u.fromWave) ? u.fromWave : [u.fromWave, u.fromWave];
    ok(lo >= 1 && hi <= TOTAL_WAVES && lo <= hi, `${name}: ${u.enemy} arrives in [${lo}, ${hi}]`);
    ok(u.weight > 0 && u.cost > 0 && u.group >= 1, `${name}: ${u.enemy} has a bad weight, cost or group`);
  }
});

test('Data', 'monsters that split or spawn make real monsters', () => {
  for (const [id, e] of Object.entries(ENEMIES)) {
    if (e.split) ok(ENEMIES[e.split.into], `${id} splits into unknown ${e.split.into}`);
    if (e.spawns) ok(ENEMIES[e.spawns.type], `${id} spawns unknown ${e.spawns.type}`);
  }
});

// ---- maps ---------------------------------------------------------------------
for (const m of MAPS) {
  test('Maps', `${m.name}: roads start on the edge, run straight and end at the cottage`, () => {
    for (const [i, path] of m.paths.entries()) {
      const pts = path.points, [x0, y0] = pts[0];
      ok(x0 === 0 || y0 === 0 || x0 === m.W - 1 || y0 === m.H - 1, `road ${i} starts inside the map at ${x0},${y0}`);
      for (let k = 1; k < pts.length; k++) {
        const [ax, ay] = pts[k - 1], [bx, by] = pts[k];
        ok(ax === bx || ay === by, `road ${i} has a slanted segment ${ax},${ay} → ${bx},${by}`);
        ok(bx >= 0 && by >= 0 && bx < m.W && by < m.H, `road ${i} leaves the map at ${bx},${by}`);
      }
      const [ex, ey] = pts[pts.length - 1];
      ok(ex === m.baseTile[0] && ey === m.baseTile[1], `road ${i} ends at ${ex},${ey}, not at the cottage`);
    }
  });

  test('Maps', `${m.name}: cats can walk from the start to every road`, () => {
    // walkable = not under a pond, tree or rock (bridges and decks are fine)
    const solid = (k) => (m.solids.get(k) || []).length > 0;
    const k0 = Math.floor(m.start.y / T) * m.W + Math.floor(m.start.x / T);
    ok(!solid(k0), 'the start is inside an obstacle');
    const seen = new Set([k0]), todo = [k0];
    while (todo.length) {
      const k = todo.pop(), x = k % m.W, y = (k - x) / m.W;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy, nk = ny * m.W + nx;
        if (nx < 0 || ny < 0 || nx >= m.W || ny >= m.H || seen.has(nk) || solid(nk)) continue;
        seen.add(nk); todo.push(nk);
      }
    }
    const cut = [...m.pathTiles].filter((k) => !seen.has(k));
    eq(cut.length, 0, `road tiles cats can't reach (first: ${cut[0] % m.W},${Math.floor(cut[0] / m.W)})`);
  });
}

// ---- prices: what you see is what you pay --------------------------------------
for (const cat of CAT_ORDER) {
  test('Prices', `${CATS[cat].name} pays exactly the price shown, planting and every upgrade`, () => {
    const s = game({ cats: [cat] }), p = s.players[0], at = freeTile(s);
    let before = p.coins;
    const shownPlant = sim.plantPrice(p, 'thorn');
    const f = plant(s, p, at, 'thorn');
    growOnce(s, p, f);
    near(before - p.coins, shownPlant, 0.999, 'planting');
    while (f.lvl < MAX_LEVEL) {
      const shown = sim.upgradeLeft(p, f);
      before = p.coins;
      growOnce(s, p, f);
      near(before - p.coins, shown, 0.999, `level ${f.lvl}`);
    }
    eq(sim.upgradeLeft(p, f), 0, 'a max level flower costs nothing more');
  });
}

test('Prices', 'a half-paid upgrade shows only what is left', () => {
  const s = game({ cats: ['gardener'] }), p = s.players[0], f = plant(s, p, freeTile(s), 'thorn');
  growOnce(s, p, f);
  tick(s); // let go of the key: a finished level waits for a fresh press
  const full = sim.upgradeLeft(p, f), before = p.coins;
  for (let i = 0; i < 20; i++) tick(s, { build: true });
  const paid = before - p.coins;
  ok(paid > 0 && f.lvl === 1, 'some was paid and the level is not done');
  near(sim.upgradeLeft(p, f), full - paid, 1, 'what is left');
  const rest = sim.upgradeLeft(p, f), mid = p.coins;
  growOnce(s, p, f);
  near(mid - p.coins, rest, 0.999, 'the rest');
});

test('Prices', 'two cats on one flower each see their own price', () => {
  const s = game({ cats: ['bomber', 'gardener'] }), [boom, fern] = s.players, at = freeTile(s);
  const f = plant(s, boom, at, 'thorn');
  growOnce(s, boom, f);
  goTo(fern, at);
  eq(sim.upgradeLeft(fern, f), Math.ceil(upgradeCost('thorn', 1) * CATS.gardener.upgradeCost - 1e-6), 'Fern');
  eq(sim.upgradeLeft(boom, f), upgradeCost('thorn', 1), 'Boom');
});

test('Prices', 'healing costs what the tag says', () => {
  const s = game({ cats: ['scout'] }), p = s.players[0], f = plant(s, p, freeTile(s), 'thorn');
  growOnce(s, p, f);
  f.hp = 35;
  const shown = sim.healLeft(p, f), before = p.coins;
  for (let i = 0; i < 600 && f.hp < FLOWER_HP; i++) tick(s, { heal: true });
  eq(f.hp, FLOWER_HP, 'healed to full');
  near(before - p.coins, shown, 0.999, 'heal cost');
});

test('Prices', 'digging up pays back the refund share of what went in', () => {
  const s = game({ cats: ['bomber'] }), p = s.players[0], at = freeTile(s), f = plant(s, p, at, 'thorn');
  growOnce(s, p, f); growOnce(s, p, f);
  const refund = sim.uprootRefund(f), before = p.coins;
  eq(refund, Math.floor(f.spent * BALANCE.economy.uprootRefund), 'refund');
  tick(s, { cycle: true }); // upgrade → dig mode
  for (let i = 0; i < 200 && flowerAt(s, at); i++) tick(s, { build: true });
  ok(!flowerAt(s, at), 'the flower is gone');
  eq(Math.round(p.coins - before), refund, 'coins back');
});

// ---- monsters -----------------------------------------------------------------
// A monster of `type` placed on a road tile, one tick old.
function monsterOn(s, type, [x, y]) {
  sim.spawnEnemy(s, type, null, 0);
  const e = s.enemies[s.enemies.length - 1];
  e.x = (x + 0.5) * T; e.y = (y + 0.5) * T;
  return e;
}

test('Monsters', 'Frostbloom slows a grunt but not a woolly bear', () => {
  const s = game({ cats: ['bomber'] }), p = s.players[0], spot = tileByRoad(s);
  const f = plant(s, p, spot.flower, 'frost');
  growOnce(s, p, f);
  const grunt = monsterOn(s, 'grunt', spot.road), woolly = monsterOn(s, 'woolly', spot.road);
  for (let i = 0; i < 30; i++) { grunt.x = woolly.x = (spot.road[0] + 0.5) * T; grunt.y = woolly.y = (spot.road[1] + 0.5) * T; tick(s); }
  ok(grunt.slowT > 0, 'the grunt was not slowed');
  eq(woolly.slowT, 0, 'woolly bear slow time');
  eq(woolly.slow, 1, 'woolly bear speed');
});

test('Monsters', 'bosses shrug off part of the Frostbloom slow', () => {
  const s = game({ cats: ['bomber'] }), p = s.players[0], spot = tileByRoad(s);
  const f = plant(s, p, spot.flower, 'frost');
  growOnce(s, p, f);
  const grunt = monsterOn(s, 'grunt', spot.road), boss = monsterOn(s, 'boss', spot.road);
  for (let i = 0; i < 30; i++) { grunt.x = boss.x = (spot.road[0] + 0.5) * T; grunt.y = boss.y = (spot.road[1] + 0.5) * T; tick(s); }
  ok(grunt.slowT > 0 && boss.slowT > 0, 'both were slowed');
  const resist = ENEMIES.boss.slowResist;
  ok(resist > 0, 'bosses have a slowResist');
  near(1 - boss.slow, (1 - grunt.slow) * (1 - resist), 1e-9, 'the boss loses less speed');
});

test('Monsters', 'ground-only flowers miss flyers and leaping grasshoppers', () => {
  const def = (t) => ({ def: ENEMIES[t], dashing: false });
  ok(!sim.airborne(def('grunt')), 'a grunt is on the ground');
  ok(sim.airborne(def('flyer')), 'a flyer is in the air');
  ok(!sim.airborne(def('hopper')), 'a grasshopper between leaps is on the ground');
  ok(sim.airborne({ ...def('hopper'), dashing: true }), 'a leaping grasshopper is in the air');
  ok(!sim.airborne({ ...def('dasher'), dashing: true }), 'a dashing dasher stays on the ground');
});

// A flower of `type` grown to level 1 next to a road, and that road tile.
function flowerByRoad(type) {
  const s = game({ cats: ['bomber'], loadout: [type, 'frost', 'daisy'] }), p = s.players[0], spot = tileByRoad(s);
  const f = plant(s, p, spot.flower, type);
  growOnce(s, p, f);
  goTo(p, freeTile(s, [spot.flower])); // step off so the cat doesn't stand in the way
  return { s, f, road: spot.road };
}
// Keep monsters pinned on a tile while the game runs for `secs`.
function hold(s, list, [x, y], secs) {
  for (let i = 0; i < secs * 60; i++) { for (const e of list) if (!e.dead) { e.x = (x + 0.5) * T; e.y = (y + 0.5) * T; } tick(s); }
}

test('Bosses', 'every kind of boss turns up, picked at random', () => {
  const s = wonGame(), seen = new Set();
  sim.continueEndless(s);
  for (let n = TOTAL_WAVES + 5; n < TOTAL_WAVES + 40; n++) {
    s.wave = n - 1; s.phase = 'prep'; s.queue = []; s.enemies = [];
    tick(s, { ready: true });
    for (const e of s.queue) if (ENEMIES[e.type].boss) seen.add(e.type);
  }
  eq([...seen].sort().join(' '), Object.keys(BALANCE.difficulty.bossTypes).sort().join(' '), 'boss kinds seen');
});

test('Bosses', 'only bosses without noShield raise shields', () => {
  const s = wonGame(), { road } = tileByRoad(s);
  for (const t of Object.keys(BALANCE.difficulty.bossTypes)) {
    const e = monsterOn(s, t, road);
    sim.damage(s, e, e.maxhp * 0.5, true, true);
    eq(e.shield > 0, !ENEMIES[t].noShield, `${t} shield`);
  }
});

test('Bosses', 'the Mole King shakes the flowers around it when it comes up', () => {
  const { s, f, road } = flowerByRoad('frost');
  const king = monsterOn(s, 'moleking', road), q = ENEMIES.moleking.quake;
  king.under = true; king.phaseT = ENEMIES.moleking.burrow.belowSeconds - 0.001;
  const before = f.hp;
  tick(s);
  ok(!king.under, 'back above ground');
  near(before - f.hp, q.damage * WEAR_MULT[f.lvl], 0.5, 'quake damage');
});

test('Monsters', 'a mole at the cottage comes up to bite and stays up, so it can be hit', () => {
  const s = game({ cats: ['bomber'] }), b = s.m.base, path = s.m.paths[0];
  sim.spawnEnemy(s, 'mole', null, 0);
  const e = s.enemies.at(-1);
  e.seg = path.waypoints.length - 1;
  e.x = b.x + Math.cos(e.baseAng) * T * 0.62; e.y = b.y + Math.sin(e.baseAng) * T * 0.5;
  e.under = true; e.phaseT = 0;
  const lives = s.lives;
  tick(s);
  eq(s.lives, lives, 'no bite from underground');
  for (let t = 0; t < ENEMIES.mole.burrow.aboveSeconds + 1; t += DT) tick(s);
  ok(!e.under && sim.hittable(e), 'above ground and hittable');
  ok(s.lives < lives, 'bites once it is up');
});

test('Bosses', 'the Bramble Witch heals monsters near it and withers flowers', () => {
  const { s, f, road } = flowerByRoad('frost');
  const witch = monsterOn(s, 'witch', road), grunt = monsterOn(s, 'grunt', road), d = ENEMIES.witch;
  grunt.hp = grunt.maxhp / 2;
  const hp = grunt.hp, before = f.hp;
  hold(s, [witch, grunt], road, 1);
  near(grunt.hp - hp, d.heals.share * grunt.maxhp, grunt.maxhp * 0.01, 'grunt healed');
  near(before - f.hp, d.withers.perSecond * WEAR_MULT[f.lvl], 0.5, 'flower withered');
});

test('Monsters', 'Snapdragon bites off a share of a big monster\'s max health', () => {
  const { s, f, road } = flowerByRoad('snap');
  const tank = monsterOn(s, 'tank', road), before = tank.hp;
  for (let i = 0; i < 120 && tank.hp === before; i++) hold(s, [tank], road, 1 / 60);
  const st = flowerStats('snap', f.lvl);
  near(before - tank.hp, st.dmg + tank.maxhp * st.maxHpBite - ENEMIES.tank.armor, 0.01, 'one bite');
});

test('Monsters', 'Snapdragon bites only a small share off a boss', () => {
  const { s, f, road } = flowerByRoad('snap');
  const boss = monsterOn(s, 'boss', road), before = boss.hp;
  for (let i = 0; i < 120 && boss.hp === before; i++) hold(s, [boss], road, 1 / 60);
  const st = flowerStats('snap', f.lvl);
  ok(st.bossMaxHpBite < st.maxHpBite, 'bosses lose a smaller share');
  near(before - boss.hp, st.dmg + boss.maxhp * st.bossMaxHpBite - ENEMIES.boss.armor, 0.01, 'one bite');
});

test('Monsters', 'Snapdragon bites the toughest monster in reach, not the critter in front', () => {
  const { s, road } = flowerByRoad('snap');
  const swarm = monsterOn(s, 'swarm', road), tank = monsterOn(s, 'tank', road), before = tank.hp;
  for (let i = 0; i < 120 && tank.hp === before; i++) hold(s, [swarm, tank], road, 1 / 60);
  ok(tank.hp < before, 'the tank was bitten');
  ok(!swarm.dead, 'the critter went first');
});

test('Monsters', 'Sunflowers shoot the tough monster nearest the cottage, not the toughest one', () => {
  const { s, f, road } = flowerByRoad('sunflower');
  // a hurt Mole King at the cottage, a fresh (tougher) Boss far away, and a grunt even closer
  const king = monsterOn(s, 'moleking', road), boss = monsterOn(s, 'boss', road), grunt = monsterOn(s, 'grunt', road);
  ok(boss.maxhp > king.maxhp, 'the Boss is the tougher one');
  for (const [e, left] of [[king, T], [boss, T * 20], [grunt, 1]]) { e.left = left; e.stun = 30; } // stunned, so they stay put
  const hp = () => [king, boss, grunt].map((e) => e.hp);
  const before = hp();
  f.cd = 0; tick(s);
  const after = hp();
  ok(after[0] < before[0], 'the Mole King at the cottage was hit');
  eq(after.slice(1).join(' '), before.slice(1).join(' '), 'the far Boss and the grunt were not');
});

test('Monsters', 'Sunflowers spread their beams out instead of all firing at once', () => {
  const s = game({ loadout: ['sunflower', 'frost', 'daisy'] }), [p] = s.players;
  const used = [];
  for (let i = 0; i < 3; i++) { const at = freeTile(s, used); used.push(at); growOnce(s, p, plant(s, p, at, 'sunflower')); }
  for (let i = 0; i < 60; i++) tick(s); // ready all break long
  tick(s, { ready: true });
  ok(s.phase === 'wave', 'the wave started');
  const cds = s.flowers.map((f) => f.cd).sort((a, b) => a - b), rate = flowerStats('sunflower', 1).rate;
  for (let i = 1; i < cds.length; i++) ok(cds[i] - cds[i - 1] > rate / 3 - 0.1, `beams ${cds.map((c) => c.toFixed(1))} are spread out`);
});

test('Monsters', 'poison gets through armour; poison-immune monsters shrug it off', () => {
  const { s, road } = flowerByRoad('stink');
  const grunt = monsterOn(s, 'grunt', road), beetle = monsterOn(s, 'charger', road);
  grunt.hp = grunt.maxhp = beetle.hp = beetle.maxhp = 1e6; // keep both alive
  ENEMIES.grunt.poisonImmune = true; // no monster is immune right now, so borrow the grunt
  try { hold(s, [grunt, beetle], road, 4); } finally { delete ENEMIES.grunt.poisonImmune; }
  ok(beetle.psn > 0, 'the armoured stag beetle was not poisoned');
  eq(grunt.psn, 0, 'poison stacks on an immune monster');
});

test('Monsters', 'Thornrose hits the ground but misses flyers', () => {
  const { s, road } = flowerByRoad('thorn');
  const grunt = monsterOn(s, 'grunt', road), flyer = monsterOn(s, 'flyer', road);
  grunt.hp = grunt.maxhp = flyer.hp = flyer.maxhp = 1e6;
  hold(s, [grunt, flyer], road, 2);
  ok(grunt.hp < grunt.maxhp, 'the grunt took no damage');
  eq(flyer.hp, flyer.maxhp, 'flyer health');
});

test('Monsters', 'a hurt stag beetle runs faster', () => {
  const pace = (hpShare) => {
    const s = game({ cats: ['bomber'], map: 0 }), road = s.m.paths[0].points;
    const e = monsterOn(s, 'charger', road[1]);
    e.seg = 2; e.hp = e.maxhp * hpShare;
    const d0 = e.dist;
    for (let i = 0; i < 30; i++) tick(s);
    return e.dist - d0;
  };
  const full = pace(1), weak = pace(0.1);
  const want = 1 + (ENEMIES.charger.enrage.maxSpeedMultiplier - 1) * 0.9;
  near(weak / full, want, 0.05, 'speed ratio at 10% health');
});

test('Monsters', 'a [lo, hi] arrival wave lands inside its range and varies between games', () => {
  const m = MAPS.findIndex((x) => x.waves !== BALANCE.waves && x.waves.some((u) => Array.isArray(u.fromWave)));
  ok(m >= 0, 'no map uses a ranged arrival');
  const seen = new Set();
  for (let seed = 1; seed <= 24; seed++) {
    const s = game({ map: m, seed });
    tick(s, { ready: true });
    ok(s.phase === 'wave' && s.arrive, 'the first wave did not start');
    s.m.waves.forEach((u, i) => {
      if (!Array.isArray(u.fromWave)) return eq(s.arrive[i], u.fromWave, `${u.enemy} arrival`);
      ok(s.arrive[i] >= u.fromWave[0] && s.arrive[i] <= u.fromWave[1], `${u.enemy} arrives in wave ${s.arrive[i]}`);
      if (u.enemy === 'flyer') seen.add(s.arrive[i]);
    });
  }
  ok(seen.size > 1, 'flyers arrived in the same wave every game');
});

test('Monsters', 'per-map coin drops are read from maps.json', () => {
  for (const m of MAPS) ok(m.coinDrops > 0, `${m.name} coin drops ${m.coinDrops}`);
  ok(MAPS.some((m) => m.coinDrops !== 1), 'some map has its own coin drops');
});

// ---- endless mode ---------------------------------------------------------------
// A game that has just won: a small garden, wave 10 done.
function wonGame() {
  const s = game({ cats: ['bomber', 'gardener'] }), [boom] = s.players;
  const f = plant(s, boom, freeTile(s), 'thorn');
  growOnce(s, boom, f);
  s.wave = TOTAL_WAVES; s.won = true; s.phase = 'wave';
  return s;
}
// Start the next wave and clear it at once.
function clearNextWave(s) {
  tick(s, { ready: true });
  ok(s.phase === 'wave', 'the wave did not start');
  s.queue.length = 0;
  for (const e of s.enemies) e.dead = true;
  tick(s);
}

test('Endless', 'after a win, C carries on into wave 11 and beyond', () => {
  const s = wonGame();
  sim.continueEndless(s);
  ok(!s.won && s.endless && s.phase === 'prep', 'not back in a break');
  clearNextWave(s);
  eq(s.wave, TOTAL_WAVES + 1, 'wave'); ok(!s.won && s.phase === 'prep', 'endless waves never win');
  clearNextWave(s);
  eq(s.wave, TOTAL_WAVES + 2, 'wave');
  ok(s.stats.waves.length > 0 && s.stats.cur, 'the log carries on');
});

test('Endless', 'the wave after the big boss is a breather', () => {
  const s = wonGame();
  sim.continueEndless(s);
  tick(s, { ready: true });
  const calm = s.queue.length;
  s.queue.length = 0;
  for (const e of s.enemies) e.dead = true;
  tick(s);
  tick(s, { ready: true });
  ok(calm < s.queue.length * 0.7, `wave 11 has ${calm} monsters, wave 12 ${s.queue.length}`);
});

test('Endless', 'later endless waves stay small but bring more bosses', () => {
  const s = wonGame();
  sim.continueEndless(s);
  const waveAt = (n) => {
    s.wave = n - 1; s.phase = 'prep'; s.queue = []; s.enemies = [];
    tick(s, { ready: true });
    eq(s.wave, n, 'wave');
    return { size: s.queue.length, bosses: s.queue.filter((e) => ENEMIES[e.type].boss).length };
  };
  const w12 = waveAt(TOTAL_WAVES + 2), w15 = waveAt(TOTAL_WAVES + 5), w16 = waveAt(TOTAL_WAVES + 6), w20 = waveAt(TOTAL_WAVES + 10);
  const w21 = waveAt(TOTAL_WAVES + 11), w25 = waveAt(TOTAL_WAVES + 15), w26 = waveAt(TOTAL_WAVES + 16);
  eq([w12, w15, w16, w20, w21, w25, w26].map((w) => w.bosses).join(' '), '0 2 0 3 1 4 2', 'bosses in waves 12, 15, 16, 20, 21, 25, 26');
  ok(w20.size < w12.size * 1.6, `wave 20 has ${w20.size} monsters, wave 12 ${w12.size}`);
});

test('Waves', 'packs grow up to packMaxGrowth times their size', () => {
  const D = BALANCE.difficulty;
  // the biggest run of swarm bugs in a row on one road, in a late wave
  let biggest = 0;
  for (let seed = 1; seed <= 4; seed++) {
    const s = wonGame();
    s.rng = seed;
    sim.continueEndless(s);
    s.wave = 39; s.phase = 'prep'; s.queue = []; s.enemies = [];
    tick(s, { ready: true });
    let run = 0;
    s.queue.forEach((e, i) => { run = e.type === 'swarm' && i && s.queue[i - 1].type === 'swarm' && s.queue[i - 1].path === e.path && e.wait <= 0.181 ? run + 1 : 1; if (e.type === 'swarm') biggest = Math.max(biggest, run); });
  }
  ok(biggest > 0, 'no swarms in wave 40');
  // two packs can land back to back on one road, so allow twice the cap
  ok(biggest <= 2 * Math.round(5 * D.packMaxGrowth), `a run of ${biggest} swarm bugs`);
});

test('Waves', 'packs pay for every member, so bigger packs use up the wave as fast as smaller ones', () => {
  const D = BALANCE.difficulty, old = D.packGrowthPerWave;
  // the wave budget the monsters of wave 9 use up (a pack member costs cost / group), over a few seeds
  const used = (g) => {
    D.packGrowthPerWave = g;
    let n = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const s = game({ cats: ['bomber', 'gardener'], seed });
      s.wave = 8; s.phase = 'prep'; s.queue = []; s.enemies = [];
      tick(s, { ready: true });
      const unit = Object.fromEntries(s.m.waves.map((u) => [u.enemy, u.cost / u.group]));
      for (const e of s.queue) n += unit[e.type];
    }
    return n;
  };
  try {
    const flat = used(0), grown = used(old);
    near(grown / flat, 1, 0.05, `wave budget used: ${grown.toFixed(0)} with growing packs, ${flat.toFixed(0)} without`);
  } finally { D.packGrowthPerWave = old; }
});

test('Waves', 'every wave is hpGrowth tougher than the last, endless too', () => {
  const s = wonGame(), D = BALANCE.difficulty;
  const gruntIn = (n) => { s.wave = n; sim.spawnEnemy(s, 'grunt', null, 0); return s.enemies.at(-1).maxhp; };
  for (const n of [2, 6, TOTAL_WAVES, TOTAL_WAVES + 1, TOTAL_WAVES + 2, TOTAL_WAVES + 15]) near(gruntIn(n) / gruntIn(n - 1), 1 + D.hpGrowth, 1e-9, `wave ${n} grunt vs wave ${n - 1}`);
});

test('Endless', 'endless bosses have endlessBossHp of the health they would have', () => {
  const s = wonGame(), D = BALANCE.difficulty;
  const bossIn = (n) => { s.wave = n; sim.spawnEnemy(s, 'boss', null, 0); return s.enemies.at(-1).maxhp; };
  const n = TOTAL_WAVES + 5;
  near(bossIn(n) / bossIn(TOTAL_WAVES), (1 + D.hpGrowth) ** (n - TOTAL_WAVES) * D.endlessBossHp, 1e-9, 'wave 15 boss vs wave 10 boss');
});

test('Waves', 'hard mode: monsters have hard.enemyHp health and hard.waveSize as many come', () => {
  const H = BALANCE.difficulty.hard;
  const wave = (hard) => {
    let n = 0, hp = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const s = game({ cats: ['bomber', 'gardener'], seed });
      s.hard = hard;
      s.wave = 7; s.phase = 'prep'; s.queue = []; s.enemies = [];
      tick(s, { ready: true });
      n += s.queue.length;
      sim.spawnEnemy(s, 'grunt', null, 0); hp = s.enemies.at(-1).maxhp;
    }
    return { n, hp };
  };
  const normal = wave(false), hard = wave(true);
  near(hard.hp / normal.hp, H.enemyHp, 1e-9, 'grunt health');
  near(hard.n / normal.n, H.waveSize, 0.12, `${hard.n} monsters instead of ${normal.n}`);
});

test('Maps', 'maps with more entrances pay more per monster', () => {
  const k = BALANCE.economy.entranceCoins;
  for (const m of MAPS) near(m.coinDrops, (m.entrances / 2) ** k, 1e-9, `${m.name} coin drops`);
  ok(MAPS.find((m) => m.id === 'pinwheel').coinDrops > MAPS.find((m) => m.id === 'lakeside').coinDrops, 'Pinwheel pays more than Lakeside');
});

test('Waves', 'hard mode: monsters drop hard.coins as many coins', () => {
  const coinsFrom = (hard) => {
    let n = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const s = game({ cats: ['bomber'], seed });
      s.hard = hard; s.wave = 1;
      sim.spawnEnemy(s, 'tank', null, 0);
      const e = s.enemies.at(-1);
      s.drops.length = 0;
      sim.damage(s, e, 1e9, true);
      n += s.drops.reduce((a, d) => a + d.value, 0);
    }
    return n;
  };
  const normal = coinsFrom(false), hard = coinsFrom(true);
  near(hard / normal, BALANCE.difficulty.hard.coins, 0.08, `${hard} coins instead of ${normal}`);
});

test('Waves', 'the plant key on the map row switches hard mode, and everyone confirms again', () => {
  const s = sim.createState(2, 1, { map: 0 });
  s.players.forEach((p) => { p.pick.chosen = ['thorn', 'frost', 'daisy']; });
  s.players[1].pick.ready = true;
  s.players[0].pick.row = 0;
  eq(s.hard, false, 'starts on normal');
  sim.step(s, [{ buildTap: true }, {}], DT);
  eq(s.hard, true, 'hard after the plant key');
  eq(s.players[1].pick.ready, false, 'the other cat is no longer ready');
  eq(sim.createState(1, 1, { hard: true }).hard, true, 'last game\'s choice carries over');
});

test('Endless', 'a lost endless wave can be retried from the break before it', () => {
  const s = wonGame();
  sim.continueEndless(s);
  clearNextWave(s); // wave 11 done, break before 12 saved
  const coins = s.players.map((p) => p.coins), lives = s.lives, garden = s.flowers.map((f) => `${f.type}${f.lvl}@${f.tx},${f.ty}`);
  tick(s, { ready: true });
  for (let i = 0; i < 120; i++) tick(s);
  s.players[0].coins = 0; s.flowers[0].lvl = 1;
  s.lives = 0; s.over = true;
  sim.retryWave(s);
  ok(!s.over && s.phase === 'prep' && s.endless, 'back in the break');
  eq(s.wave, TOTAL_WAVES + 1, 'wave before the retried one');
  eq(s.lives, lives, 'cottage');
  s.players.forEach((p, i) => eq(p.coins, coins[i], `P${i + 1} coins`));
  eq(s.flowers.map((f) => `${f.type}${f.lvl}@${f.tx},${f.ty}`).join(' '), garden.join(' '), 'garden');
  const f = s.flowers[0];
  ok(s.grid.get(f.ty * s.m.W + f.tx) === f, 'the garden grid points at the restored flowers');
  ok(s.m === MAPS[s.map], 'the map is the shared one');
  tick(s, { ready: true });
  eq(s.wave, TOTAL_WAVES + 2, 'the retried wave starts');
  const m = decodeFast(encodeSnapshot(s, { seq: 1, at: 0, paused: false, acks: [0, 0] }));
  ok(m.state.game.endless, 'online guests are told it is endless');
});

test('Retry', 'a lost early wave can be retried from the break before it', () => {
  const s = game({ cats: ['bomber', 'gardener'] }), [boom] = s.players;
  ok(sim.canRetry(s), 'wave 1 can be retried once the flowers are picked');
  clearNextWave(s); // wave 1 done, break before 2 saved
  const f = plant(s, boom, freeTile(s), 'thorn');
  growOnce(s, boom, f);
  clearNextWave(s); // wave 2 done, break before 3 saved
  const coins = s.players.map((p) => p.coins), lives = s.lives;
  tick(s, { ready: true });
  for (let i = 0; i < 120; i++) tick(s);
  s.players[0].coins = 0; s.lives = 0; s.over = true;
  sim.retryWave(s);
  ok(!s.over && s.phase === 'prep' && !s.endless, 'back in the break');
  eq(s.wave, 2, 'wave before the retried one');
  eq(s.lives, lives, 'cottage');
  s.players.forEach((p, i) => eq(p.coins, coins[i], `P${i + 1} coins`));
  eq(s.flowers.length, 1, 'garden');
  eq(s.retries.join(), '3', 'the log remembers the retry');
  tick(s, { ready: true });
  eq(s.wave, 3, 'the retried wave starts');
});

test('Retry', 'from the pause screen mid-wave or in a break, never after a win', () => {
  const s = game();
  clearNextWave(s);
  tick(s, { ready: true });
  for (let i = 0; i < 60; i++) tick(s);
  ok(s.phase === 'wave' && s.wave === 2, 'in wave 2');
  sim.retryWave(s); // paused mid-wave
  ok(s.phase === 'prep' && s.wave === 1, 'back in the break before wave 2');
  sim.retryWave(s); // paused in that break
  ok(s.phase === 'prep' && s.wave === 1, 'the same break again');
  eq(s.retries.join(), '2,2', 'both retries logged');
  const won = wonGame();
  ok(!sim.canRetry(won), 'nothing to retry after a win');
});

// ---- Sprint mode, challenge codes and scores -----------------------------------------
// The monsters of the next wave, without playing it.
function nextQueue(s) {
  s.phase = 'prep'; s.queue = []; s.enemies = [];
  if (s.versus) sim.releaseWave(s, s.wave + 1);
  tick(s, { ready: true });
  return s.queue.map((e) => `${e.type}/${e.path}/${e.elite ? e.elite.join('+') : ''}`).join(' ');
}

test('Sprint', 'a Sprint plays sprint.waves: each wave as tough and as big as the normal wave it names', () => {
  const SP = BALANCE.sprint;
  eq(sim.lastWave({ sprint: true }), SP.waves.length, 'number of waves');
  SP.waves.forEach((lv, i) => eq(sim.levelOf({ sprint: true }, i + 1), lv, `sprint wave ${i + 1}`));
  eq(sim.levelOf({ sprint: true }, SP.waves.length + 1), TOTAL_WAVES + 1, 'endless carries on from the breather');
  const hpIn = (sprint, wave) => { const s = game({ seed: 3 }); s.sprint = sprint; s.wave = wave; sim.spawnEnemy(s, 'grunt', null, 0); return s.enemies.at(-1).maxhp; };
  near(hpIn(true, 3), hpIn(false, SP.waves[2]), 1e-9, 'grunt health in sprint wave 3');
  const sizeOf = (sprint, wave) => { const s = game({ seed: 3 }); s.sprint = sprint; s.wave = wave - 1; return nextQueue(s).split(' ').length; };
  eq(sizeOf(true, 2), sizeOf(false, SP.waves[1]), 'monsters in sprint wave 2');
});

test('Sprint', 'a Sprint is won after its last wave, with more coins to start and shorter breaks', () => {
  const SP = BALANCE.sprint, E = BALANCE.economy;
  const s = sim.createState(1, 5, { map: 0, sprint: true });
  eq(s.players[0].coins, Math.round(E.startCoinsSolo * MAPS[0].startCoins * SP.startCoins), 'start coins');
  s.players[0].pick.chosen = ['thorn', 'frost', 'daisy']; s.players[0].pick.ready = true;
  tick(s);
  eq(s.timer, SP.firstWaveDelay, 'time before the first wave');
  clearNextWave(s);
  eq(s.timer, SP.timeBetweenWaves, 'break');
  s.wave = SP.waves.length - 1;
  clearNextWave(s);
  ok(s.won, `not won after wave ${s.wave}`);
});

test('Sprint', 'the plant key on the map row goes Normal, Hard, Sprint, Sprint · Hard', () => {
  const s = sim.createState(1, 1, { map: 0 });
  s.players[0].pick.row = 0;
  const seen = [];
  for (let i = 0; i < 4; i++) { seen.push(sim.modeName(s)); sim.step(s, [{ buildTap: true }], DT); sim.step(s, [{}], DT); }
  eq(seen.join(', '), 'Normal, Hard, Sprint, Sprint · Hard', 'modes');
  eq(sim.modeName(s), 'Normal', 'and back');
});

test('Challenges', 'a code gives back its seed, map and mode; a typo is refused', () => {
  for (const c of [{ seed: 0, map: 0, hard: false, sprint: false }, { seed: 2 ** 21 - 1, map: MAPS.length - 1, hard: true, sprint: true }, { seed: 123456, map: 4, hard: false, sprint: true }]) {
    const code = encodeCode(c), back = decodeCode(code.toLowerCase());
    ok(/^[A-Z2-9]{3}-[A-Z2-9]{3}$/.test(code), `code ${code}`);
    eq(JSON.stringify(back), JSON.stringify(c), `${code} decodes`);
  }
  const code = encodeCode({ seed: 777, map: 2, hard: false, sprint: true });
  let refused = 0, tried = 0;
  for (let i = 0; i < 7; i++) if (code[i] !== '-') for (const ch of 'ABCXYZ2') { if (ch === code[i]) continue; tried++; if (!decodeCode(code.slice(0, i) + ch + code.slice(i + 1))) refused++; }
  ok(refused / tried > 0.6, `only ${refused} of ${tried} one-letter typos refused`);
  eq(decodeCode('hello'), null, 'not a code');
});

test('Challenges', 'the same code brings the same waves, however the game goes', () => {
  const play = (mess) => {
    const s = game({ cats: ['bomber', 'gardener'], seed: 4242 });
    const waves = [];
    for (let w = 0; w < 4; w++) {
      if (mess) for (let i = 0; i < 25; i++) { sim.spawnEnemy(s, 'tank', null, 0); sim.damage(s, s.enemies.at(-1), 1e9, true); } // kills roll coins
      waves.push(nextQueue(s));
    }
    return waves;
  };
  const a = play(false), b = play(true);
  a.forEach((q, i) => eq(b[i], q, `wave ${i + 1}`));
  const other = game({ cats: ['bomber', 'gardener'], seed: 4243 });
  ok(nextQueue(other) !== a[0] || nextQueue(other) !== a[1], 'another seed brings other waves');
});

test('Challenges', 'a challenge sets the map, mode and seed, and they can no longer be changed', () => {
  const s = sim.createState(2, 1, { map: 0 });
  sim.setChallenge(s, { seed: 99, map: 3, hard: true, sprint: true });
  eq(codeOf(s), encodeCode({ seed: 99, map: 3, hard: true, sprint: true }), 'code');
  s.players[0].pick.row = 0;
  sim.step(s, [{ mx: 1 }, {}], DT); sim.step(s, [{}, {}], DT); sim.step(s, [{ buildTap: true }, {}], DT);
  eq(s.map, 3, 'map'); ok(s.hard && s.sprint, 'mode');
});

test('Challenges', 'the daily challenge is the same all day and changes the next', () => {
  const a = dailyChallenge(new Date('2026-10-16T08:00:00Z')), b = dailyChallenge(new Date('2026-10-16T20:00:00Z')), c = dailyChallenge(new Date('2026-10-17T08:00:00Z'));
  eq(encodeCode(a), encodeCode(b), 'same day');
  ok(encodeCode(a) !== encodeCode(c), 'next day');
  ok(a.sprint, 'a Sprint');
});

test('Challenges', 'the score adds up waves, cottage and kills; Hard counts more; the result names the code', () => {
  const S = BALANCE.score, s = game({ cats: ['bomber', 'gardener'] });
  s.wave = 4; s.phase = 'wave'; s.over = true; s.lives = 37.2; s.kills = 120;
  eq(sim.wavesCleared(s), 3, 'waves cleared when wave 4 was lost');
  eq(sim.scoreOf(s), 3 * S.perWave + 38 * S.perCottage + 120 * S.perKill, 'score');
  s.hard = true;
  eq(sim.scoreOf(s), Math.round((3 * S.perWave + 38 * S.perCottage + 120 * S.perKill) * S.hard), 'hard score');
  const text = shareText(s);
  ok(text.includes(codeOf(s)) && text.includes(sim.scoreOf(s).toLocaleString('en-US')) && text.includes('2 players'), text);
});

test('Challenges', 'mode, seed and lock survive a snapshot', () => {
  const s = sim.createState(2, 1, { map: 0 });
  sim.setChallenge(s, { seed: 5150, map: 2, hard: false, sprint: true });
  const g = decodeFast(encodeSnapshot(s, { seq: 1, at: 0, paused: false, acks: [0, 0] })).state.game;
  ok(g.sprint && g.locked && !g.hard, 'flags'); eq(g.seed, 5150, 'seed');
  eq(codeOf({ ...g }), codeOf(s), 'the guest shows the same code');
});

test('Versus', 'each cat picks one more flower in a race', () => {
  for (const versus of [false, true]) {
    const s = sim.createState(1, 9, { map: 0, versus }), p = s.players[0], want = versus ? LOADOUT_SIZE + 1 : LOADOUT_SIZE;
    p.pick.chosen = []; p.pick.row = 2;
    for (let i = 0; i < FLOWER_ORDER.length; i++) { p.pick.cursor = i; tick(s, { buildTap: true }); tick(s); }
    eq(p.pick.chosen.length, want, versus ? 'race' : 'normal game');
    p.pick.row = 1; tick(s, { my: -1 }); tick(s);
    eq(p.pick.row, versus ? 1 : 0, versus ? "a race's map row can't be reached" : 'the map row');
    p.pick.row = 2;
    tick(s, { atk: true }); tick(s);
    ok(s.phase !== 'pick', 'can start with that many');
  }
});

test('Versus', 'a race side holds after picking until it is let go, and can\'t be retried', () => {
  const s = sim.createState(1, 9, { map: 0, versus: true });
  s.players[0].pick.chosen = ['thorn', 'frost', 'daisy']; s.players[0].pick.ready = true;
  tick(s);
  ok(s.hold && s.phase === 'prep', 'holding after the pick');
  const t0 = s.timer;
  for (let i = 0; i < 60; i++) tick(s, { mx: 1 });
  eq(s.timer, t0, 'the first-wave timer waits'); eq(s.t, 0, 'nothing moves');
  sim.releaseHold(s);
  tick(s);
  ok(!s.hold && s.timer < BALANCE.versus.firstWaveDelay, 'running once let go');
  ok(!sim.canRetry(s), 'a race has no retries');
});

test('Versus', 'who wins a race: the first cottage to fall loses; else cottage left, then score', () => {
  const st = (o) => ({ won: false, over: false, fell: false, cleared: 0, lives: 0, score: 0, picked: true, ...o });
  eq(raceResult(st({ cleared: 2, lives: 10 }), st({ over: true, fell: true, cleared: 2 })), 'win', 'their cottage fell first');
  eq(raceResult(st({ over: true, fell: true, cleared: 2 }), st({ cleared: 2, lives: 10 })), 'lose', 'ours fell first');
  eq(raceResult(st({ over: true, cleared: 2, lives: 10 }), st({ over: true, fell: true, cleared: 2 })), 'win', 'still a win once our game has stopped');
  eq(raceResult(st({ won: true, cleared: 6, lives: 120 }), st({ won: true, cleared: 6, lives: 90 })), 'win', 'both won: more cottage left');
  eq(raceResult(st({ won: true, cleared: 6, lives: 90 }), st({ won: true, cleared: 6, lives: 120 })), 'lose', 'both won: less cottage left');
  eq(raceResult(st({ over: true, fell: true, cleared: 3, score: 9000 }), st({ over: true, fell: true, cleared: 3, score: 8000 })), 'win', 'both fell at once: the score');
  eq(raceResult(st({ over: true, fell: true, cleared: 3, score: 9000 }), st({ over: true, fell: true, cleared: 3, score: 9000 })), 'draw', 'the same');
  eq(raceResult(st({ won: true, cleared: 6, lives: 50 }), st({ cleared: 5 })), null, 'they can still win with more cottage');
  eq(raceResult(st({ cleared: 4 }), st({ cleared: 4 })), null, 'both still playing');
  eq(raceResult(st({}), null), null, 'no rival yet');
  const s = game({ cats: ['bomber'] });
  const r = raceStatus(s);
  ok(r.picked && r.last === TOTAL_WAVES && r.lives === s.maxLives, 'status of a fresh game');
});

// A race side past its pick, let go, with a wave on.
function raceGame(seed = 21) {
  const s = sim.createState(2, seed, { map: 0, versus: true, cats: ['bomber', 'gardener'] });
  s.players.forEach((p) => { p.pick.chosen = ['thorn', 'frost', 'daisy']; p.pick.ready = true; });
  tick(s); sim.releaseHold(s); sim.releaseWave(s, 1);
  tick(s, { ready: true });
  return s;
}

test('Versus', "a race's boss chests never offer cottage repairs", () => {
  for (let seed = 1; seed <= 30; seed++) {
    const s = raceGame(seed);
    s.chestDue = true; s.queue = []; s.enemies = []; tick(s); // the wave ends with a chest
    ok(s.chest, 'a chest');
    ok(s.chest.offers.every((o) => o.every((id) => !BALANCE.bossChest.notInRaces.includes(id.split(':')[0]))), `seed ${seed}`);
  }
});

test('Versus', 'a longer first break; Enter in a break calls the next wave for both teams', () => {
  const s = sim.createState(1, 9, { map: 0, versus: true, sprint: true });
  s.players[0].pick.chosen = ['thorn', 'frost', 'daisy', 'snap']; s.players[0].pick.ready = true;
  tick(s); sim.releaseHold(s);
  near(s.timer, BALANCE.versus.firstWaveDelay, 1e-9, 'the race\'s first break');
  ok(!sim.rushWave(s, 2), 'a call for another wave does nothing');
  ok(sim.rushWave(s, 1), 'the rivals called wave 1');
  for (let i = 0; i < 5; i++) tick(s);
  ok(s.waiting && s.timer <= 0, 'our break is over: waiting to start together');
  const r = raceGame(); r.queue = []; r.enemies = []; tick(r);
  eq(r.phase, 'prep', 'a break');
  eq(raceStatus(r).rush, 1, 'only wave 1 called so far');
  tick(r, { ready: true }); tick(r);
  eq(raceStatus(r).rush, 2, 'Enter calls wave 2 for the rivals too');
});

test('Versus', 'every wave waits for both teams; a fallen cottage ends the race for the other team too', () => {
  const s = raceGame();
  eq(s.phase, 'wave', 'wave 1 started once released');
  s.queue = []; s.enemies = []; tick(s);
  eq(s.phase, 'prep', 'wave 1 cleared');
  tick(s, { ready: true }); for (let i = 0; i < 30; i++) tick(s);
  ok(s.waiting && s.phase === 'prep' && s.wave === 1, 'ready early: waits for the rivals');
  ok(raceStatus(s).waiting === 2, 'and tells them');
  sim.releaseWave(s, 2); tick(s);
  ok(!s.waiting && s.phase === 'wave' && s.wave === 2, 'both ready: wave 2 starts');
  sim.endRace(s);
  ok(s.over && !raceStatus(s).fell, 'the race stops here, our cottage still standing');
  const t = s.t; tick(s);
  eq(s.t, t, 'nothing moves after that');
  const lost = raceGame(); lost.lives = 0; lost.over = true; // how the sim ends a game whose cottage fell
  ok(raceStatus(lost).fell, 'a cottage that fell says so');
});

test('Sending monsters', 'bonking the wave fills the meter; monsters that split off or were sent don\'t count', () => {
  const S = BALANCE.send, s = raceGame();
  eq(s.meter, 0, 'empty to start');
  const n = s.waveCount;
  ok(n > 5, `wave 1 has ${n} monsters`);
  for (let i = 0; i < 3; i++) { sim.spawnEnemy(s, 'grunt', null, 0, null); sim.damage(s, s.enemies.at(-1), 1e9, true); }
  near(s.meter, 3 * S.meterPerWave / n, 1e-9, 'three kills');
  const before = s.meter;
  sim.spawnEnemy(s, 'grunt', s.enemies[0] || { path: 0, x: 100, y: 100, seg: 0, dist: 0, left: 1 }); sim.damage(s, s.enemies.at(-1), 1e9, true);
  sim.spawnEnemy(s, 'grunt', null, 0, null); s.enemies.at(-1).sent = true; sim.damage(s, s.enemies.at(-1), 1e9, true);
  eq(s.meter, before, 'a split-off and a sent monster add nothing');
  for (let i = 0; i < 10 * n; i++) { sim.spawnEnemy(s, 'grunt', null, 0, null); sim.damage(s, s.enemies.at(-1), 1e9, true); }
  eq(s.meter, S.max, 'the meter stops at max');
});

test('Sending monsters', 'the send key spends the meter on a pack for the rivals, only when it is full enough', () => {
  const S = BALANCE.send, s = raceGame();
  s.meter = S.cost * 0.9;
  tick(s, { send: true });
  eq(s.outbox.length, 0, 'not enough: nothing sent');
  s.meter = S.cost * 1.5;
  tick(s, { send: true }, 1);
  eq(s.outbox.length, 1, 'a pack is on its way'); eq(s.outbox[0].share, S.pack, 'its size');
  near(s.meter, S.cost * 0.5, 1e-9, 'meter left');
  const solo = game();
  solo.meter = 5; tick(solo, { send: true });
  ok(!solo.outbox?.length, 'nothing to send outside a race');
});

// A rival pack arrives and its warning runs out on the next tick.
const landNow = (s, share = BALANCE.send.pack) => {
  const left = s.queue.length + s.incoming.length;
  sim.receivePack(s, share); s.threats.at(-1).t = 1e-6; tick(s);
  return s.queue.length + s.incoming.length - left;
};

test('Sending monsters', 'a rival pack waits as a warning, then lands', () => {
  const S = BALANCE.send, s = raceGame();
  ok(sim.receivePack(s, S.pack), 'taken in');
  eq(s.threats.length, 1, 'on its way'); near(s.threats[0].t, S.warning, 1e-9, 'lands in warning seconds');
  const left = s.queue.length;
  for (let i = 0; i < Math.floor((S.warning - 0.5) * 60); i++) tick(s);
  ok(!s.queue.some((e) => e.sent) && !s.enemies.some((e) => e.sent), 'nothing has come yet');
  for (let i = 0; i < 60; i++) tick(s);
  eq(s.threats.length, 0, 'landed');
  ok(s.queue.some((e) => e.sent) || s.enemies.some((e) => e.sent), 'its monsters are here');
  ok(s.queue.length >= left - 30, 'wave still there');
  ok(!sim.receivePack(game(), S.pack), 'nothing outside a race');
});

test('Sending monsters', 'sending while a rival pack is on its way blocks it first', () => {
  const S = BALANCE.send, s = raceGame();
  sim.receivePack(s, S.pack); sim.receivePack(s, S.pack);
  s.meter = S.cost; tick(s, { send: true });
  eq(s.threats.length, 1, 'one pack blocked'); eq(s.outbox.length, 0, 'nothing went across');
  near(s.meter, 0, 1e-9, 'it cost the meter');
  s.threats[0].share = S.pack / 2; tick(s);
  s.meter = S.cost; tick(s, { send: true }, 1);
  eq(s.threats.length, 0, 'the half pack blocked too');
  eq(s.outbox.length, 1, 'and the rest sent'); near(s.outbox[0].share, S.pack / 2, 1e-9, 'half a pack across');
  s.meter = S.cost; tick(s, { send: true });
  near(s.outbox.at(-1).share, S.pack, 1e-9, 'nothing to block: a whole pack');
  eq(s.stats.cur.versus.blocked, 1.5, 'logged as blocked packs');
});

test('Sending monsters', 'a pack joins the wave when it lands, or the next wave in a break; it is marked and drops fewer coins', () => {
  const S = BALANCE.send, s = raceGame();
  const n = landNow(s);
  ok(n > 0, 'some monsters came');
  ok(s.queue.slice(0, n).every((e) => e.sent && !ENEMIES[e.type].boss), 'first in line, marked, no bosses');
  for (let i = 0; i < 60; i++) tick(s);
  ok(s.enemies.some((e) => e.sent), 'sent monsters are out');
  const brk = raceGame(22);
  brk.phase = 'prep'; brk.timer = 30; brk.queue = []; brk.enemies = [];
  const m = landNow(brk);
  eq(brk.queue.length, 0, 'nothing comes during the break'); ok(m > 0 && brk.incoming.length === m, 'held for the next wave');
  tick(brk, { ready: true });
  ok(brk.queue.slice(0, m).every((e) => e.sent), 'the next wave starts with them');
  const coinsFrom = (sent) => {
    let c = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const g = raceGame(seed); g.drops.length = 0;
      sim.spawnEnemy(g, 'tank', null, 0, null); g.enemies.at(-1).sent = sent;
      sim.damage(g, g.enemies.at(-1), 1e9, true);
      c += g.drops.reduce((a, d) => a + d.value, 0);
    }
    return c;
  };
  const plain = coinsFrom(false), sent = coinsFrom(true);
  near(sent / plain, S.coins, 0.1, `${sent} coins instead of ${plain}`);
});

test('Sending monsters', 'a pack doesn\'t change the waves: they stay those of the challenge code', () => {
  const play = (pack) => {
    const s = raceGame(77), waves = [];
    for (let w = 0; w < 3; w++) {
      if (pack) landNow(s);
      s.queue = s.queue.filter((e) => !e.sent); s.incoming = [];
      waves.push(nextQueue(s));
    }
    return waves;
  };
  const a = play(false), b = play(true);
  a.forEach((q, i) => eq(b[i], q, `wave ${i + 2}`));
});

test('Sending monsters', 'the meter, sent monsters and the send key survive the trip', () => {
  const s = raceGame();
  s.meter = 1.25;
  landNow(s); sim.receivePack(s, BALANCE.send.pack);
  for (let i = 0; i < 90; i++) tick(s);
  const m = decodeFast(encodeSnapshot(s, { seq: 1, at: 0, paused: false, acks: [0, 0] }));
  near(m.state.game.meter, 1.25, 0.01, 'meter');
  eq(m.state.game.threats.length, 1, 'a pack on its way'); near(m.state.game.threats[0].t, s.threats[0].t, 0.1, 'its countdown');
  eq(m.state.enemies.filter((e) => e.sent).length, s.enemies.filter((e) => e.sent).length, 'sent monsters');
  const inp = decodeFast(encodeInputs([{ seq: 1, mx: 0, my: 0, send: true }]));
  ok(inp.inputs[0].send, 'the send key');
});

// ---- 3 and 4 cats online ----------------------------------------------------------------
test('Four cats', 'up to 4 cats, each a different one, with more and tougher monsters past the second', () => {
  const X = BALANCE.difficulty.morePlayers;
  const s4 = sim.createState(4, 1, { map: 0 });
  eq(new Set(s4.players.map((p) => p.cat)).size, 4, 'four different cats');
  const wave = (n) => {
    let size = 0, hp = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const s = game({ cats: CAT_ORDER.slice(0, n), seed });
      s.wave = 6; size += nextQueue(s).split(' ').length;
      sim.spawnEnemy(s, 'grunt', null, 0); hp = s.enemies.at(-1).maxhp;
    }
    return { size, hp };
  };
  const two = wave(2), three = wave(3), four = wave(4);
  near(three.hp / two.hp, X[3].enemyHp, 1e-9, 'grunt health with 3 cats');
  near(four.hp / two.hp, X[4].enemyHp, 1e-9, 'grunt health with 4 cats');
  near(three.size / two.size, X[3].waveSize, 0.12, `${three.size} monsters with 3 cats, ${two.size} with 2`);
  near(four.size / two.size, X[4].waveSize, 0.15, `${four.size} monsters with 4 cats, ${two.size} with 2`);
});

test('Four cats', 'a boss shield takes more bombs with every cat past the second', () => {
  const at = (n) => { const s = game({ cats: CAT_ORDER.slice(0, n) }); sim.spawnEnemy(s, 'boss', null, 0); const e = s.enemies.at(-1); sim.damage(s, e, e.maxhp * 0.5, true); return e.shieldMax; };
  eq(at(2), SHIELD.hitsCoop, 'two cats');
  eq(at(4), SHIELD.hitsCoop + BALANCE.difficulty.morePlayers[4].shieldHits, 'four cats');
});

test('Four cats', 'the host keeps each guest\'s inputs apart and tells each one its own ack', () => {
  const h = createHostLink();
  h.receiveInputs(1, [{ seq: 1, mx: 1 }, { seq: 2, mx: 1 }]);
  h.receiveInputs(3, [{ seq: 1, my: -1, bomb: true }]);
  eq(h.nextInput(1).mx, 1, 'P2 moves'); ok(h.nextInput(3).bomb, 'P4 bombs');
  ok(!h.nextInput(2).mx, 'nobody plays P3: it stands still');
  ok(!h.nextInput(3).bomb, 'a late input repeats the keys held, not the taps');
  const s = game({ cats: CAT_ORDER.slice(0, 4) });
  const sent = [], link = (name) => ({ congested: false, sendFast: (b) => sent.push([name, b]), send() {} });
  h.ticked(); h.ticked();
  eq(h.send(new Map([[1, link('P2')], [3, link('P4')]]), s, 1000, 0, false), 1, 'sent');
  eq(sent.length, 2, 'one snapshot to each guest');
  const m = decodeFast(sent[0][1]);
  eq(m.acks.join(), '0,1,0,1', 'acks by player');
  eq(m.state.players.length, 4, 'all four cats in the snapshot');
});

// ---- whole games ----------------------------------------------------------------
test('Games', 'the same seed plays out the same game', () => {
  const a = runBot({ players: 2, seed: 11, map: 1, maxMinutes: 4 });
  const b = runBot({ players: 2, seed: 11, map: 1, maxMinutes: 4 });
  eq(JSON.stringify(a.game.totals), JSON.stringify(b.game.totals), 'game totals');
  eq(a.lives, b.lives, 'cottage health');
});

for (const m of MAPS) {
  test('Games', `${m.name}: the autopilot plays two minutes without errors`, () => {
    const r = runBot({ players: 2, seed: 3, map: m.index, maxMinutes: 2 });
    ok(r.game.waves.length >= 1, 'no wave was played');
  });
}

test('Games', 'the autopilot plays like people do: a garden before wave 1, bombs, coins spent', () => {
  const r = runBot({ players: 2, seed: 1, map: 1, maxMinutes: 5 });
  const tl = r.game.timeline, first = tl.findIndex((e) => e[1] === 'wave');
  ok(tl.slice(0, first).filter((e) => e[1] === 'plant').length >= 6, 'starting coins not spent on flowers before wave 1');
  ok(tl.some((e) => e[1] === 'bomb'), 'no bombs');
  const w = r.game.waves[1];
  ok(w.coins.every((c) => c.end < 150), `coins left after wave 2: ${w.coins.map((c) => c.end)}`);
});

test('Games', 'the end screen summary adds up', () => {
  const r = runBot({ players: 2, seed: 4, map: 0, maxMinutes: 6 }), S = gameSummary(r.game);
  eq(S.cats.length, 2, 'cats');
  for (const f of S.flowers) eq(f.dmg, Math.round(r.game.totals.damage[f.type] || 0), `${f.type} damage`);
  const fromFlowers = r.game.flowers.reduce((a, f) => a + f.dmg, 0);
  near(S.cats.reduce((a, c) => a + c.garden, 0), fromFlowers, 2, 'flower damage split between the cats');
});

// ---- Bloom abilities (IDEAS R1) -----------------------------------------------------
// A flower of `type` by a road, raised straight to the Bloom level.
function bloomFlower(type) {
  const r = flowerByRoad(type);
  r.f.lvl = BLOOM.level;
  r.f.cd = 0;
  return r;
}
// Pin each monster to its own spot for `secs`.
function pin(s, spots, secs) {
  for (let i = 0; i < secs * 60; i++) { for (const [e, x, y] of spots) if (!e.dead) { e.x = x; e.y = y; } tick(s); }
}
const at = ([x, y]) => [(x + 0.5) * T, (y + 0.5) * T];
// Runs fn with Bloom switched off, then back on.
function withoutBloom(fn) { BLOOM.enabled = false; try { fn(); } finally { BLOOM.enabled = true; } }
const bloomLog = (s) => s.stats.cur.bloom;

test('Bloom', 'every flower has a Bloom ability, and the upgrade that reaches it costs more', () => {
  for (const t of FLOWER_ORDER) ok(bloomOf(t, BLOOM.level), `${t} has none`);
  ok(!bloomOf('daisy', BLOOM.level - 1), 'a level below has it already');
  const on = upgradeCost('thorn', BLOOM.level - 1);
  let off = 0, below = 0;
  withoutBloom(() => { off = upgradeCost('thorn', BLOOM.level - 1); below = upgradeCost('thorn', 1); });
  ok(on > off, `Bloom upgrade ${on}, without Bloom ${off}`);
  eq(upgradeCost('thorn', 1), below, 'other upgrades');
});

test('Bloom', 'Daisy: every few seeds splits on to nearby monsters', () => {
  const { s, road } = bloomFlower('daisy');
  const [x, y] = at(road);
  const list = [0, 1, 2].map(() => monsterOn(s, 'grunt', road));
  for (const e of list) e.hp = e.maxhp = 1e6;
  pin(s, list.map((e, i) => [e, x + i * 12, y]), 3);
  ok(bloomLog(s).triggers.daisy > 0, 'no seed split');
  ok(bloomLog(s).damage.daisy > 0, 'split seeds did no damage');
});

test('Bloom', 'Sunflower: the beam also takes a share of max health', () => {
  const { s, f, road } = bloomFlower('sunflower');
  const tank = monsterOn(s, 'tank', road);
  tank.hp = tank.maxhp = 1e5; // tough enough to live through the beam
  const before = tank.hp;
  pin(s, [[tank, ...at(road)]], 1 / 60);
  const st = flowerStats('sunflower', f.lvl);
  near(before - tank.hp, st.dmg - ENEMIES.tank.armor + tank.maxhp * BLOOM.sunflower.maxHp, 0.01, 'one beam');
});

test('Bloom', 'Fire Lily: monsters it hits keep burning', () => {
  const { s, road } = bloomFlower('firelily');
  const grunt = monsterOn(s, 'grunt', road);
  grunt.hp = grunt.maxhp = 1e6;
  for (let i = 0; i < 240 && !(grunt.burnT > 0); i++) pin(s, [[grunt, ...at(road)]], 1 / 60);
  ok(grunt.burnT > 0, 'the grunt never caught fire');
  const hp = grunt.hp;
  s.flowers.length = 0; s.grid.clear(); s.projs.length = 0; // nothing else may hit it now
  pin(s, [[grunt, ...at(road)]], 0.5);
  ok(grunt.hp < hp, 'burning did no damage');
});

test('Bloom', 'Stinkbloom: monsters in its clouds take extra damage', () => {
  const { s, road } = bloomFlower('stink');
  const grunt = monsterOn(s, 'grunt', road);
  grunt.hp = grunt.maxhp = 1e6;
  for (let i = 0; i < 400 && !(grunt.vulnT > 0); i++) pin(s, [[grunt, ...at(road)]], 1 / 60);
  ok(grunt.vulnT > 0, 'the grunt was never weakened');
  const hp = grunt.hp;
  sim.damage(s, grunt, 100, true);
  near(hp - grunt.hp, 100 * (1 + BLOOM.stink.vulnerable), 0.01, 'a 100 hit');
});

test('Bloom', 'Frostbloom: every few pulses freezes monsters, but not bosses', () => {
  const { s, road } = bloomFlower('frost');
  const grunt = monsterOn(s, 'grunt', road), boss = monsterOn(s, 'boss', road);
  grunt.hp = grunt.maxhp = boss.hp = boss.maxhp = 1e6;
  let frozen = false, bossFrozen = false;
  for (let i = 0; i < 60 * 12; i++) { pin(s, [[grunt, ...at(road)], [boss, ...at(road)]], 1 / 60); frozen ||= grunt.stun > 0; bossFrozen ||= boss.stun > 0; }
  ok(frozen, 'the grunt was never frozen');
  ok(!bossFrozen, 'the boss was frozen');
});

test('Bloom', 'Thornrose: every few pulses reach further', () => {
  const { s, f, road } = bloomFlower('thorn');
  const close = monsterOn(s, 'grunt', road), far = monsterOn(s, 'grunt', road);
  close.hp = close.maxhp = far.hp = far.maxhp = 1e6;
  const reach = flowerStats('thorn', f.lvl).range;
  pin(s, [[close, ...at(road)], [far, f.x + reach * 1.6, f.y]], 1.4); // too soon for a Bloom pulse
  eq(far.hp, far.maxhp, 'far grunt health before the Bloom pulse');
  pin(s, [[close, ...at(road)], [far, f.x + reach * 1.6, f.y]], 3);
  ok(far.hp < far.maxhp, 'the far grunt was never hit');
});

test('Bloom', 'Snapdragon: swallows a weak big monster whole', () => {
  const { s, road } = bloomFlower('snap');
  const tank = monsterOn(s, 'tank', road);
  tank.hp = tank.maxhp * BLOOM.snap.below * 0.9;
  for (let i = 0; i < 180 && !tank.dead; i++) pin(s, [[tank, ...at(road)]], 1 / 60);
  ok(tank.dead, 'the weak tank was not swallowed');
  ok(bloomLog(s).triggers.snap === 1, 'logged');
});

test('Bloom', 'switched off, a level-5 flower has no ability', () => {
  withoutBloom(() => {
    const { s, f, road } = bloomFlower('sunflower');
    const tank = monsterOn(s, 'tank', road);
    tank.hp = tank.maxhp = 1e5;
    const before = tank.hp;
    pin(s, [[tank, ...at(road)]], 1 / 60);
    near(before - tank.hp, flowerStats('sunflower', f.lvl).dmg - ENEMIES.tank.armor, 0.01, 'one beam');
  });
});

test('Monsters', 'Daisy seeds hit flyers harder', () => {
  withoutBloom(() => {
    const { s, f, road } = bloomFlower('daisy');
    const st = flowerStats('daisy', f.lvl);
    ok(st.flyerDamage > 1, 'a bonus against flyers');
    for (const [type, mul] of [['flyer', st.flyerDamage], ['grunt', 1]]) {
      s.enemies = []; s.projs = [];
      const e = monsterOn(s, type, road);
      e.hp = e.maxhp = 1e5; e.armorPlus = 0;
      for (let i = 0; i < 240 && e.hp === e.maxhp; i++) pin(s, [[e, ...at(road)]], 1 / 60);
      near(e.maxhp - e.hp, Math.max(1, st.dmg * mul - ENEMIES[type].armor), 0.01, `one seed into a ${type}`);
    }
  });
});

test('Bloom', 'Sunflower beams hit bosses harder', () => {
  withoutBloom(() => {
    const { s, f, road } = bloomFlower('sunflower');
    const boss = monsterOn(s, 'boss', road);
    boss.hp = boss.maxhp = 1e6; boss.shieldAt = []; // no shield in the way
    const before = boss.hp, st = flowerStats('sunflower', f.lvl);
    pin(s, [[boss, ...at(road)]], 1 / 60);
    ok(st.bossDamage > 1, 'a bonus against bosses');
    near(before - boss.hp, st.dmg * st.bossDamage - ENEMIES.boss.armor, 0.01, 'one beam');
  });
});

// ---- elites and power-ups (IDEAS R2) -------------------------------------------------
// Runs fn with some ELITES numbers changed, then puts them back.
function withElites(changes, fn) {
  const old = Object.fromEntries(Object.keys(changes).map((k) => [k, ELITES[k]]));
  Object.assign(ELITES, changes);
  try { fn(); } finally { Object.assign(ELITES, old); }
}
const eliteOn = (s, type, road, trait, item = 'water') => { const e = monsterOn(s, type, road); sim.makeElite(s, e, trait, item); return e; };
const loose = (s, kind, x, y) => s.items.push({ id: s.nextId++, kind, x, y, age: 0, by: null });

test('Elites', 'elites only come from their wave on, and only of the listed types', () => {
  const s = game(), road = tileByRoad(s).road;
  withElites({ chance: 1, maxChance: 1 }, () => {
    s.wave = ELITES.fromWave - 1;
    ok(!monsterOn(s, ELITES.types[0], road).elite, 'an elite before its wave');
    s.wave = ELITES.fromWave;
    ok(monsterOn(s, ELITES.types[0], road).elite, `no elite ${ELITES.types[0]} at chance 1`);
    ok(!monsterOn(s, 'grunt', road).elite, 'an elite grunt');
  });
  withElites({ chancePerWave: 1 }, () => { s.wave = TOTAL_WAVES; near(sim.eliteChance(s), ELITES.maxChance, 1e-9, 'the chance stops growing'); });
  s.wave = TOTAL_WAVES + 1;
  near(sim.eliteChance(s), ELITES.endlessChance, 1e-9, 'fewer elites when endless mode starts');
  s.wave = TOTAL_WAVES + 30;
  near(sim.eliteChance(s), ELITES.endlessMaxChance, 1e-9, 'endless elites stop growing');
  withElites({ enabled: false }, () => eq(sim.eliteChance(s), 0, 'chance when switched off'));
});

test('Elites', 'an elite is tougher and drops its power-up when it dies', () => {
  const s = game(), road = tileByRoad(s).road;
  const plain = monsterOn(s, 'tank', road), e = eliteOn(s, 'tank', road, 'swift', 'sun');
  near(e.maxhp, plain.maxhp * ELITES.hp, 1e-6, 'health');
  sim.damage(s, e, 1e9, true);
  eq(s.items.map((it) => it.kind).join(), 'sun', 'dropped');
  eq(s.stats.cur.items.dropped.sun, 1, 'logged drop');
  eq(s.stats.cur.elites.killed, 1, 'logged kill');
});

test('Elites', 'traits: armoured, swift, regenerating, frost-proof, splitting', () => {
  const s = game(), road = tileByRoad(s).road;
  const plain = monsterOn(s, 'tank', road), armoured = eliteOn(s, 'tank', road, 'armoured');
  const a = plain.hp, b = armoured.hp;
  sim.damage(s, plain, 20); sim.damage(s, armoured, 20);
  eq((a - plain.hp) - (b - armoured.hp), ELITES.traits.armoured.armor, 'armour soaks more');

  const s2 = game(), r2 = tileByRoad(s2).road;
  const slow = monsterOn(s2, 'tank', r2), fast = eliteOn(s2, 'tank', r2, 'swift');
  slow.x = fast.x = s2.m.paths[0].spawn.x; slow.y = fast.y = s2.m.paths[0].spawn.y;
  for (let i = 0; i < 60; i++) tick(s2);
  near(fast.dist / slow.dist, ELITES.traits.swift.speed, 0.05, 'speed ratio');

  const s3 = game(), r3 = tileByRoad(s3).road;
  const regen = eliteOn(s3, 'tank', r3, 'regenerating');
  regen.hp = regen.maxhp / 2;
  pin(s3, [[regen, ...at(r3)]], 1);
  ok(regen.hp > regen.maxhp / 2, 'it did not heal');
  const h = regen.hp;
  regen.psnT = 5; regen.psn = 0;
  pin(s3, [[regen, ...at(r3)]], 1);
  near(regen.hp, h, 1e-6, 'healed while poisoned');

  const { s: s4, road: r4 } = flowerByRoad('frost');
  const proof = eliteOn(s4, 'tank', r4, 'frostproof');
  pin(s4, [[proof, ...at(r4)]], 3);
  eq(proof.slowT, 0, 'slowed');

  const s5 = game(), r5 = tileByRoad(s5).road;
  const splitter = eliteOn(s5, 'tank', r5, 'splitting'), base = splitter.maxhp / ELITES.hp;
  sim.damage(s5, splitter, 1e9, true);
  const kids = s5.enemies.filter((e) => e.mini);
  eq(kids.length, ELITES.traits.splitting.count, 'copies');
  for (const k of kids) { eq(k.type, 'tank', 'copy type'); near(k.maxhp, base * ELITES.traits.splitting.hp, 1e-6, 'copy health'); ok(!k.elite && !k.carry, 'copies are plain'); }
});

test('Power-ups', 'walk over one to carry it; a second one swaps; unclaimed ones vanish', () => {
  const s = game(), p = s.players[0];
  loose(s, 'water', p.x, p.y);
  tick(s);
  eq(p.item, 'water', 'carried');
  loose(s, 'snow', p.x, p.y);
  for (let i = 0; i < 30; i++) tick(s);
  eq(p.item, 'snow', 'swapped');
  eq(s.items.map((it) => it.kind).join(), 'water', 'the old one waits on the ground');
  eq(p.item, 'snow', 'standing still doesn\'t swap back');
  loose(s, 'sun', p.x + T * 6, p.y);
  for (let i = 0; i < ELITES.itemSeconds * 60 + 5; i++) tick(s);
  eq(s.items.length, 0, 'items left after their time');
  eq(s.stats.cur.items.expired.sun, 1, 'logged');
});

test('Power-ups', 'two cats on one spot, both carrying, don\'t swap forever', () => {
  const s = game({ cats: ['bomber', 'gardener'] }), [a, b] = s.players;
  b.x = a.x; b.y = a.y;
  a.item = 'water'; b.item = 'snow';
  loose(s, 'sun', a.x, a.y);
  for (let i = 0; i < 30; i++) tick(s);
  ok(s.items.length <= 2, `items on the ground: ${s.items.length}`);
  eq([a.item, b.item, ...s.items.map((it) => it.kind)].sort().join(), 'snow,sun,water', 'every item still exists once');
});

test('Power-ups', 'fertiliser: a free level for the flower you stand on', () => {
  const s = game(), p = s.players[0], spot = freeTile(s);
  const f = plant(s, p, spot, 'thorn');
  growOnce(s, p, f);
  p.item = 'fertiliser';
  const coins = p.coins;
  tick(s, { use: true });
  eq(f.lvl, 2, 'level'); eq(p.coins, coins, 'coins'); eq(p.item, null, 'used up');
  f.lvl = MAX_LEVEL; p.item = 'fertiliser';
  tick(s, { use: true });
  eq(p.item, 'fertiliser', 'kept when it can\'t help');
});

test('Power-ups', 'watering can: nearby flowers heal and stop wearing for the wave', () => {
  const s = game(), p = s.players[0], spot = freeTile(s);
  const f = plant(s, p, spot, 'thorn');
  growOnce(s, p, f);
  f.hp = 30; p.item = 'water';
  tick(s, { use: true });
  eq(f.hp, FLOWER_HP, 'healed');
  tick(s, { ready: true });
  for (let i = 0; i < 300; i++) tick(s);
  eq(f.hp, FLOWER_HP, 'wore during the watered wave');
});

test('Power-ups', 'sun orb: the flower fires twice as fast', () => {
  const shots = (sun) => {
    const { s, f, road } = flowerByRoad('thorn');
    const g = monsterOn(s, 'grunt', road);
    g.hp = g.maxhp = 1e6;
    if (sun) { const p = s.players[0]; goTo(p, [f.tx, f.ty]); p.item = 'sun'; tick(s, { use: true }); goTo(p, freeTile(s, [[f.tx, f.ty]])); }
    f.shots = 0;
    pin(s, [[g, ...at(road)]], 6);
    return f.shots;
  };
  near(shots(true) / shots(false), ELITES.items.sun.fireRate, 0.35, 'shots with and without');
});

test('Power-ups', 'snow globe: monsters freeze, but not bosses or frost-proof elites', () => {
  const s = game(), p = s.players[0], road = tileByRoad(s).road;
  const grunt = monsterOn(s, 'grunt', road), boss = monsterOn(s, 'boss', road), proof = eliteOn(s, 'tank', road, 'frostproof');
  p.item = 'snow';
  tick(s, { use: true });
  ok(grunt.stun > 0, 'the grunt is free'); eq(boss.stun, 0, 'boss stun'); eq(proof.stun, 0, 'frost-proof stun');
  eq(s.stats.cur.items.used.snow, 1, 'logged');
});

test('Power-ups', 'elites and power-ups survive a snapshot', () => {
  const s = game(), road = tileByRoad(s).road, p = s.players[0];
  eliteOn(s, 'tank', road, 'regenerating');
  loose(s, 'sun', 100, 100);
  p.item = 'water';
  const m = decodeFast(encodeSnapshot(s, { seq: 1, at: 0, paused: false, acks: [0, 0] }));
  eq(m.state.enemies.at(-1).elite, 'regenerating', 'trait');
  eq(m.state.items[0].kind, 'sun', 'item on the ground');
  eq(m.state.players[0].item, 'water', 'carried item');
});

// ---- boss shields and chests (IDEAS R3) ---------------------------------------------
function bossGame(cats = ['gardener', 'scout'], wave = 5) {
  const s = game({ cats });
  s.wave = wave;
  const boss = monsterOn(s, 'boss', tileByRoad(s).road);
  boss.x = boss.y = T * 2; // well away from the cats, so bombs don't knock them down
  return { s, boss };
}
const bombOn = (s, e, owner = 0) => {
  s.bombs.push({ id: s.nextId++, sx: e.x, sy: e.y, tx: e.x, ty: e.y, x: e.x, y: e.y, h: 0, t: 0, dur: 0.001, r: T, dmg: 1, owner });
  tick(s);
};
const hurtTo = (s, e, share) => sim.damage(s, e, e.hp - e.maxhp * share, true);
function withSwitch(obj, on, fn) { const was = obj.enabled; obj.enabled = on; try { fn(); } finally { obj.enabled = was; } }

test('Boss shields', 'a boss shields itself at 60%; only bombs break it, then it is exposed', () => {
  const { s, boss } = bossGame();
  hurtTo(s, boss, SHIELD.at[0] - 0.01);
  eq(boss.shield, SHIELD.hitsCoop, 'segments in co-op');
  let hp = boss.hp;
  sim.damage(s, boss, 1000, true, false, 'firelily');
  near(hp - boss.hp, 1000 * (1 - SHIELD.block), 1e-6, 'a flower hit through the shield');
  for (let i = 1; i < SHIELD.hitsCoop; i++) bombOn(s, boss);
  eq(boss.shield, 1, 'one segment left');
  bombOn(s, boss);
  eq(boss.shield, 0, 'broken');
  ok(boss.exposedT > 0 && boss.stun > SHIELD.exposedSeconds - 0.1, 'exposed and stunned');
  hp = boss.hp;
  sim.damage(s, boss, 1000, true, false, 'firelily');
  near(hp - boss.hp, 1000 * (1 + SHIELD.exposedDamage), 1e-6, 'a hit while exposed');
  eq(s.stats.cur.shields.broken, 1, 'logged');
});

test('Boss shields', "Boom's bombs count double; the solo shield has its own size", () => {
  const { s, boss } = bossGame(['bomber', 'gardener']);
  hurtTo(s, boss, SHIELD.at[0] - 0.01);
  bombOn(s, boss, 0);
  eq(boss.shield, SHIELD.hitsCoop - SHIELD.catHits.bomber, 'after one big bomb');
  const solo = bossGame(['scout']);
  hurtTo(solo.s, solo.boss, SHIELD.at[0] - 0.01);
  eq(solo.boss.shield, SHIELD.hitsSolo, 'segments alone');
});

test('Boss shields', 'the last boss and endless bosses shield twice; switched off, never', () => {
  const { s, boss } = bossGame(undefined, TOTAL_WAVES);
  hurtTo(s, boss, SHIELD.atBig[0] - 0.01);
  ok(boss.shield > 0, 'first shield');
  for (let i = 0; i < SHIELD.hitsCoop; i++) bombOn(s, boss);
  boss.exposedT = 0;
  hurtTo(s, boss, SHIELD.atBig[1] - 0.01);
  ok(boss.shield > 0, 'second shield');
  withSwitch(SHIELD, false, () => {
    const off = bossGame();
    hurtTo(off.s, off.boss, 0.2);
    ok(!(off.boss.shield > 0), 'shielded while switched off');
  });
});

// A game whose current wave is cleared after a boss died in it.
function clearBossWave(cats = ['gardener', 'scout']) {
  const s = game({ cats });
  tick(s, { ready: true });
  s.queue.length = 0;
  for (const e of s.enemies) e.dead = true;
  const boss = monsterOn(s, 'boss', tileByRoad(s).road);
  sim.damage(s, boss, 1e9, true);
  tick(s);
  return s;
}
// Let the chest's lock run out, nobody pressing anything.
function waitOutLock(s) { while (s.chest?.lock > 0) sim.step(s, s.players.map(() => ({})), DT); }

test('Boss chests', 'a wave with a boss kill ends with a chest; the game waits for every pick', () => {
  const s = clearBossWave();
  ok(s.chest, 'no chest');
  for (const o of s.chest.offers) eq(o.length, CHEST.choices, 'offers');
  const t0 = s.t;
  waitOutLock(s);
  sim.step(s, [{ buildTap: true }, {}], DT);
  ok(s.chest && s.chest.picked[0] && s.chest.picked[1] == null, 'P1 picked, P2 not yet');
  for (let i = 0; i < 30; i++) sim.step(s, [{}, {}], DT);
  eq(s.t, t0, 'game time while choosing');
  const want = s.chest.offers[1][1];
  sim.step(s, [{}, { mx: 1 }], DT);
  sim.step(s, [{}, { atk: true }], DT);
  eq(s.chest, null, 'closed');
  eq(s.stats.waves.at(-1).perks.length, 2, 'logged');
  eq(s.stats.waves.at(-1).perks[1][1], want, "P2's perk");
  withSwitch(CHEST, false, () => ok(!clearBossWave().chest, 'a chest while switched off'));
});

test('Boss chests', 'for a moment nothing can be picked, and keys held through it must be pressed again', () => {
  const s = clearBossWave();
  ok(CHEST.lockSeconds > 0 && s.chest.lock > 0, 'the chest opens locked');
  // a cat still mashing plant and baton, and moving, as the chest pops up
  for (let t = 0; t < CHEST.lockSeconds - 0.1; t += DT) sim.step(s, [{ buildTap: true, atk: true, mx: 1 }, { buildTap: true }], DT);
  eq(s.chest.picked.join(','), ',', 'nothing picked while locked');
  eq(s.chest.cursor.join(','), '0,0', 'cursors did not move');
  while (s.chest.lock > 0) sim.step(s, [{ atk: true }, {}], DT);
  sim.step(s, [{ atk: true }, {}], DT);
  eq(s.chest.picked[0], null, 'a baton held through the lock does not pick');
  sim.step(s, [{}, {}], DT);
  sim.step(s, [{ atk: true }, {}], DT);
  ok(s.chest.picked[0], 'pressed again, it picks');
});

test('Cats', 'two bombs need two presses at least a moment apart', () => {
  const s = game(), [p] = s.players;
  sim.applyPerk(s, p, 'pouch'); // room for two
  p.bombs = 2;
  tick(s, { bomb: true });
  eq(Math.floor(p.bombs), 1, 'first bomb');
  tick(s, { bomb: true });
  eq(Math.floor(p.bombs), 1, 'a second press right away');
  for (let t = 0; t < PLAYER.bombGap; t += DT) tick(s);
  tick(s, { bomb: true });
  eq(Math.floor(p.bombs), 0, 'a second bomb after the gap');
});

test('Boss chests', 'every perk does what it says', () => {
  const s = game({ cats: ['gardener', 'scout'] }), [a, b] = s.players, P = CHEST.perks;
  const lives = (s.lives = 100), max = s.maxLives;
  sim.applyPerk(s, a, 'roof');
  eq(s.maxLives, max, 'max health'); eq(s.lives, Math.min(max, lives + P.roof.cottage), 'health');
  const price = sim.plantPrice(a, 'thorn'), other = sim.plantPrice(b, 'thorn'), grow = sim.catStats(a).grow;
  sim.applyPerk(s, a, 'thumb'); sim.applyPerk(s, a, 'paws'); sim.applyPerk(s, a, 'pouch');
  ok(sim.plantPrice(a, 'thorn') < price, 'cheaper planting');
  near(sim.catStats(a).grow, grow * P.paws.growSpeed, 1e-9, 'grow speed');
  eq(sim.catStats(a).bombMax, 1 + P.pouch.bombs, 'bombs');
  eq(sim.plantPrice(b, 'thorn'), other, "the other cat's price");
  const extra = FLOWER_ORDER.find((t) => !a.loadout.includes(t));
  sim.applyPerk(s, a, `fourth:${extra}`);
  eq(a.loadout.length, LOADOUT_SIZE + 1, 'loadout'); ok(a.loadout.includes(extra), 'the flower');
  // wear and aphids
  const f = plant(s, a, freeTile(s), 'thorn');
  growOnce(s, a, f);
  goTo(a, freeTile(s, [[f.tx, f.ty]]));
  tick(s, { ready: true });
  const wear = (n) => { f.hp = 100; for (let i = 0; i < 60; i++) tick(s); return 100 - f.hp; };
  const before = wear();
  sim.applyPerk(s, b, 'roots');
  near(wear() / before, P.roots.wear, 0.02, 'wear');
  eq(s.perks.roots, 1, 'team perk');
});

test('Boss chests', 'a perk is offered at most twice; endless opens the last boss\'s chest', () => {
  const s = game({ cats: ['gardener', 'scout'] });
  sim.applyPerk(s, s.players[0], 'roof'); sim.applyPerk(s, s.players[1], 'roof');
  for (let i = 0; i < 40; i++) {
    s.chestDue = true; s.won = true; s.chest = null;
    sim.continueEndless(s);
    ok(!s.chest.offers.flat().includes('roof'), 'roof offered a third time');
  }
  const m = decodeFast(encodeSnapshot(s, { seq: 1, at: 0, paused: false, acks: [0, 0] }));
  eq(m.state.game.chest.offers[0].length, CHEST.choices, 'offers in a snapshot');
  eq(m.state.game.perks.roof, 2, 'team perks in a snapshot');
});

test('Boss chests', 'shields and perks survive a snapshot', () => {
  const { s, boss } = bossGame();
  hurtTo(s, boss, 0.5);
  sim.applyPerk(s, s.players[0], 'paws');
  const m = decodeFast(encodeSnapshot(s, { seq: 1, at: 0, paused: false, acks: [0, 0] }));
  const e = m.state.enemies.find((x) => x.type === 'boss');
  eq(e.shield, SHIELD.hitsCoop, 'shield'); eq(e.shieldMax, SHIELD.hitsCoop, 'shield max');
  eq(m.state.players[0].perks.paws, 1, 'perk');
});

// ---- saved games ------------------------------------------------------------------
test('Saves', 'a game saved mid-wave and loaded plays on exactly like the original', () => {
  const s = game({ cats: ['bomber', 'gardener'], loadout: ['daisy', 'thorn', 'frost'] });
  const [boom, fern] = s.players;
  const spots = [...s.m.pathTiles].flatMap((k) => [[1, 0], [0, 1], [-1, 0], [0, -1]].map(([dx, dy]) => [k % s.m.W + dx, Math.floor(k / s.m.W) + dy]))
    .filter(([x, y]) => sim.canBuildAt(s, x, y)).filter((v, i, all) => all.findIndex((w) => w[0] === v[0] && w[1] === v[1]) === i);
  for (let i = 0; i < 6; i++) growOnce(s, boom, plant(s, boom, spots[i * 5], i % 2 ? 'thorn' : 'daisy'));
  const f = plant(s, fern, spots[31], 'daisy');
  tick(s, { ready: true });
  for (let i = 0; i < 900 || (i < 4000 && !(s.enemies.length && s.projs.length)); i++) tick(s, { build: true }, fern.id); // Fern is mid-grow, monsters and seeds are about
  ok(s.enemies.length && s.projs.length, 'no monsters or seeds in flight to save');
  const json = JSON.stringify(saveGame(s, 'local'));
  const { state: c, mode, sameVersion } = loadGame(JSON.parse(json));
  ok(mode === 'local' && sameVersion, 'mode and version');
  ok(c.m === s.m && c.enemies.every((e) => e.def === ENEMIES[e.type]), 'map and monster types are the shared ones');
  ok(c.flowers.every((g) => c.grid.get(g.ty * c.m.W + g.tx) === g), 'the grid points at the loaded flowers');
  ok(c.projs.every((pr) => !pr.target || c.enemies.includes(pr.target)), 'seeds chase the loaded monsters');
  for (const g of [s, c]) for (let i = 0; i < 1800; i++) tick(g, i < 200 ? { build: true } : {}, fern.id);
  ok(f.lvl > 0, 'growing went on');
  eq(JSON.stringify(saveGame(c, 'local').state), JSON.stringify(saveGame(s, 'local').state), 'the two games');
});

test('Saves', 'a save names its map, so reordering the maps doesn\'t break it', () => {
  const s = game({ map: MAPS.length - 1 });
  const data = saveGame(s, 'solo'), json = JSON.stringify(data);
  ok(json.includes(`map:${s.m.id}`), 'the map is saved by name');
  const back = loadGame(JSON.parse(json)).state;
  ok(back.m === s.m && back.map === s.m.index, 'loads onto the same map');
  let msg = '';
  try { loadGame(JSON.parse(json.replaceAll(`map:${s.m.id}`, 'map:3'))); } catch (e) { msg = e.message; }
  ok(/before the maps changed/.test(msg), `an old numbered save: "${msg}"`);
});

test('Saves', 'other files are refused', () => {
  let msg = '';
  try { loadGame({ games: [] }); } catch (e) { msg = e.message; }
  ok(/not a Petal Patrol save/.test(msg), `got "${msg}"`);
});

// ---- online -----------------------------------------------------------------------
test('Online', 'a snapshot decodes back to the same game', () => {
  const s = game({ cats: ['bomber', 'gardener'], map: 0 });
  tick(s, { ready: true });
  for (let i = 0; i < 60 * 8; i++) tick(s);
  ok(s.enemies.length > 0, 'monsters are out');
  const m = decodeFast(encodeSnapshot(s, { seq: 5, at: 1234.5, paused: false, acks: [0, 9, 4] }));
  ok(m && m.t === 'snap', 'decodes as a snapshot');
  eq(m.seq, 5, 'seq'); eq(m.acks.join(), '0,9,4', 'acks');
  const g = m.state;
  eq(g.game.wave, s.wave, 'wave'); eq(g.game.map, s.map, 'map');
  eq(g.enemies.length, s.enemies.length, 'monster count');
  g.enemies.forEach((e, i) => { eq(e.type, s.enemies[i].type, `monster ${i} type`); near(e.x, s.enemies[i].x, 0.06, `monster ${i} x`); });
  g.players.forEach((p, i) => { eq(p.cat, s.players[i].cat, 'cat'); near(p.coins, s.players[i].coins, 0.06, 'coins'); });
});

test('Online', 'guest inputs survive the trip', () => {
  const list = [
    { seq: 1, mx: 1, my: 0, build: true }, { seq: 2, mx: 1, my: 0, build: true },
    { seq: 3, mx: 0, my: -1, atk: true, heal: true }, { seq: 4, mx: -1, my: 1, bomb: true, cycle: true, buildTap: true, ready: true, sprint: true, use: true },
  ];
  const m = decodeFast(encodeInputs(list));
  ok(m && m.t === 'in', 'decodes as inputs');
  eq(m.inputs.length, list.length, 'input count');
  const keys = ['atk', 'build', 'sprint', 'bomb', 'cycle', 'buildTap', 'ready', 'heal', 'use'];
  m.inputs.forEach((got, i) => {
    eq(got.seq, list[i].seq, 'seq'); eq(got.mx, list[i].mx, 'mx'); eq(got.my, list[i].my, 'my');
    for (const k of keys) eq(!!got[k], !!list[i][k], `input ${i} ${k}`);
  });
});

// ---- drawing ----------------------------------------------------------------------
test('Drawing', 'pick screen, a game in progress and the end screen draw without errors', () => {
  const cv = document.createElement('canvas'); cv.width = 1008; cv.height = 656;
  const c = cv.getContext('2d');
  const ui = { cam: { x: 0, y: 0 }, menuMap: MAPS[0], paused: false, shake: 0, dpr: 1, fps: 60, netLabel: '', disconnected: false, guide: null, keysFor: () => ({}), keyLabel: (k) => String(k), mode: () => 'local', summary: null };
  render(c, sim.createState(2, 1, { map: 0 }), ui);
  const s = game({ cats: ['bomber', 'gardener'] });
  const f = plant(s, s.players[0], freeTile(s), 'thorn');
  goTo(s.players[1], [f.tx, f.ty]);
  tick(s, { ready: true });
  for (let i = 0; i < 300; i++) tick(s);
  render(c, s, ui);
  const r = runBot({ players: 2, seed: 2, map: 0, maxMinutes: 3 });
  s.over = true; ui.summary = gameSummary(r.game);
  render(c, s, ui);
});

test('Drawing', 'a wide or tall window shows more map, and every screen still draws', () => {
  const ui = { cam: { x: 0, y: 0 }, menuMap: MAPS[0], paused: false, shake: 0, dpr: 1, netLabel: '', disconnected: false, guide: null, keys: [], keysFor: () => ({}), keyLabel: (k) => String(k), mode: () => 'local', summary: null };
  const s = game({ cats: ['bomber', 'gardener'] });
  try {
    for (const [w, h] of [[1600, BASE_H], [BASE_W, 1100]]) {
      setView(w, h);
      eq(`${VIEW_W}x${MAP_H}`, `${w}x${h - (BASE_H - 560)}`, 'view size');
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      const c = cv.getContext('2d');
      render(c, null, ui); // menu
      render(c, s, ui); // game
      render(c, s, { ...ui, paused: true });
      render(c, sim.createState(2, 1, { map: 0 }), ui); // pick screen
    }
  } finally { setView(BASE_W, BASE_H); }
});

test('Drawing', 'big numbers and long games read the way games show them', () => {
  const cases = [[0, '0'], [812, '812'], [9425, '9,425'], [9999.6, '10k'], [10000, '10k'], [91149, '91.1k'], [99960, '100k'], [117300, '117k'],
    [999400, '999k'], [999600, '1M'], [1300000, '1.3M'], [8756000, '8.8M'], [17058000, '17.1M'], [123456789, '123M']];
  for (const [v, want] of cases) eq(num(v), want, `num(${v})`);
  eq(clock(59), '0:59', 'under a minute'); eq(clock(1046), '17:26', 'minutes'); eq(clock(3725), '1:02:05', 'over an hour');
});

// ---- runner -----------------------------------------------------------------------
export async function runTests({ onResult } = {}) {
  const results = [];
  for (const t of tests) {
    const t0 = performance.now();
    let error = null;
    try { await t.fn(); } catch (e) { error = e instanceof Fail ? e.message : `${e.name}: ${e.message}`; if (!(e instanceof Fail)) console.error(e); }
    const r = { group: t.group, name: t.name, ok: !error, error, ms: Math.round(performance.now() - t0) };
    results.push(r);
    onResult?.(r);
    await new Promise((res) => setTimeout(res)); // let the page draw between tests
  }
  const failed = results.filter((r) => !r.ok);
  return { passed: results.length - failed.length, failed: failed.length, results };
}
