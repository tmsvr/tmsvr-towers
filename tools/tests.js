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
