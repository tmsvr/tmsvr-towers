// The test suite. No framework and no build step: open /tools/tests.html, or
// from the console: (await import('/tools/tests.js')).runTests()
// Every test drives the real modules (sim, data, schema, stats, render), so a
// failure here is a failure in the game.
import * as sim from '../src/sim.js';
import {
  T, MAPS, FLOWERS, FLOWER_ORDER, MAX_LEVEL, FLOWER_HP, ENEMIES, CATS, CAT_ORDER, BALANCE, TOTAL_WAVES,
  plantCost, upgradeCost, flowerStats,
} from '../src/data.js';
import { encodeSnapshot, encodeInputs, decodeFast } from '../src/schema.js';
import { gameSummary } from '../src/stats.js';
import { render } from '../src/render.js';
import { runBot } from './bot.js';
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

test('Monsters', 'stag beetles shrug off poison; grunts don\'t', () => {
  const { s, road } = flowerByRoad('stink');
  const grunt = monsterOn(s, 'grunt', road), beetle = monsterOn(s, 'charger', road);
  grunt.hp = grunt.maxhp = beetle.hp = beetle.maxhp = 1e6; // keep both alive
  hold(s, [grunt, beetle], road, 4);
  ok(grunt.psn > 0, 'the grunt was not poisoned');
  eq(beetle.psn, 0, 'stag beetle poison stacks');
});

test('Monsters', 'Thornrose hits flyers', () => {
  const { s, road } = flowerByRoad('thorn');
  const flyer = monsterOn(s, 'flyer', road);
  flyer.hp = flyer.maxhp = 1e6;
  hold(s, [flyer], road, 2);
  ok(flyer.hp < flyer.maxhp, 'the flyer took no damage');
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
    return { size: s.queue.length, bosses: s.queue.filter((e) => e.type === 'boss').length };
  };
  const w12 = waveAt(TOTAL_WAVES + 2), w15 = waveAt(TOTAL_WAVES + 5), w16 = waveAt(TOTAL_WAVES + 6), w20 = waveAt(TOTAL_WAVES + 10);
  eq([w12.bosses, w15.bosses, w16.bosses, w20.bosses].join(' '), '0 2 1 3', 'bosses in waves 12, 15, 16, 20');
  ok(w20.size < w12.size * 1.6, `wave 20 has ${w20.size} monsters, wave 12 ${w12.size}`);
});

test('Endless', 'monsters after the breather get extra health each wave', () => {
  const s = wonGame(), D = BALANCE.difficulty;
  const gruntIn = (n) => { s.wave = n; sim.spawnEnemy(s, 'grunt', null, 0); return s.enemies.at(-1).maxhp; };
  const base = (n) => 1 + (n - 1) * D.hpPerWave + (n - 1) ** 2 * D.hpPerWaveSquared;
  const n = TOTAL_WAVES + 10, extra = 1 + D.endlessHpPerWave * (n - TOTAL_WAVES - 1);
  near(gruntIn(n) / gruntIn(TOTAL_WAVES + 1), (base(n) / base(TOTAL_WAVES + 1)) * extra, 1e-9, 'wave 20 grunt vs wave 11 grunt');
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
  const m = decodeFast(encodeSnapshot(s, { seq: 1, at: 0, paused: false, ack: 0 }));
  ok(m.state.game.endless, 'online guests are told it is endless');
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

test('Games', 'the end screen summary adds up', () => {
  const r = runBot({ players: 2, seed: 4, map: 0, maxMinutes: 6 }), S = gameSummary(r.game);
  eq(S.cats.length, 2, 'cats');
  for (const f of S.flowers) eq(f.dmg, Math.round(r.game.totals.damage[f.type] || 0), `${f.type} damage`);
  const fromFlowers = r.game.flowers.reduce((a, f) => a + f.dmg, 0);
  near(S.cats.reduce((a, c) => a + c.garden, 0), fromFlowers, 2, 'flower damage split between the cats');
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
  for (let i = 0; i < 900; i++) tick(s, { build: true }, fern.id); // Fern is mid-grow, monsters and seeds are about
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
  const m = decodeFast(encodeSnapshot(s, { seq: 5, at: 1234.5, paused: false, ack: 9 }));
  ok(m && m.t === 'snap', 'decodes as a snapshot');
  eq(m.seq, 5, 'seq'); eq(m.ack, 9, 'ack');
  const g = m.state;
  eq(g.game.wave, s.wave, 'wave'); eq(g.game.map, s.map, 'map');
  eq(g.enemies.length, s.enemies.length, 'monster count');
  g.enemies.forEach((e, i) => { eq(e.type, s.enemies[i].type, `monster ${i} type`); near(e.x, s.enemies[i].x, 0.06, `monster ${i} x`); });
  g.players.forEach((p, i) => { eq(p.cat, s.players[i].cat, 'cat'); near(p.coins, s.players[i].coins, 0.06, 'coins'); });
});

test('Online', 'guest inputs survive the trip', () => {
  const list = [
    { seq: 1, mx: 1, my: 0, build: true }, { seq: 2, mx: 1, my: 0, build: true },
    { seq: 3, mx: 0, my: -1, atk: true, heal: true }, { seq: 4, mx: -1, my: 1, bomb: true, cycle: true, buildTap: true, ready: true, sprint: true },
  ];
  const m = decodeFast(encodeInputs(list));
  ok(m && m.t === 'in', 'decodes as inputs');
  eq(m.inputs.length, list.length, 'input count');
  const keys = ['atk', 'build', 'sprint', 'bomb', 'cycle', 'buildTap', 'ready', 'heal'];
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
