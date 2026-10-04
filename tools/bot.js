// A simple autopilot used to sanity-check balance.json. It plays both cats:
// heal hurt flowers, grow seedlings, plant near the path, upgrade, and
// otherwise bonk the nearest enemy or collect coins. It never uses bombs and
// picks a random-ish flower mix, so real players should do noticeably better.
import * as sim from '../src/sim.js';
import { T, FLOWER_ORDER, FLOWERS, LOADOUT_SIZE, MAX_LEVEL } from '../src/data.js';

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

export function runBot({ players = 2, seed = 1, loadouts, cats, map = 0, maxMinutes = 40 } = {}) {
  const s = sim.createState(players, seed, { map, cats });
  const m = s.m;
  fields.clear();
  s.players.forEach((p, i) => {
    const pick = loadouts?.[i] || FLOWER_ORDER.slice(i * 2, i * 2 + LOADOUT_SIZE);
    p.pick.chosen = pick.length === LOADOUT_SIZE ? pick : FLOWER_ORDER.slice(0, LOADOUT_SIZE);
    p.pick.ready = true;
  });
  sim.step(s, s.players.map(() => ({})), 1 / 60);

  // Each road's tiles, so flowers can be spread over every road.
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

  // tiles next to lots of path, best first
  const spots = [];
  for (let y = 0; y < m.H; y++) for (let x = 0; x < m.W; x++) {
    if (!sim.canBuildAt(s, x, y)) continue;
    let n = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (m.pathTiles.has((y + dy) * m.W + x + dx)) n++;
    if (n >= 3) spots.push([x, y, n, roadsNear(x, y)]);
  }
  spots.sort((a, b) => b[2] - a[2]);
  // the best free spot next to whichever road has the fewest flowers
  const nextSpot = () => {
    const cover = roadTiles.map(() => 0);
    for (const f of s.flowers) for (const i of roadsNear(f.tx, f.ty)) cover[i]++;
    const order = cover.map((c, i) => i).sort((a, b) => cover[a] - cover[b]);
    for (const road of order) {
      const spot = spots.find(([x, y, , near]) => near.includes(road) && sim.canBuildAt(s, x, y));
      if (spot) return spot;
    }
    return null;
  };

  let built = 0;
  const bots = s.players.map(() => ({ target: null }));
  const log = [];
  let lastWave = 0;
  for (let tick = 0; tick < 60 * 60 * maxMinutes && !s.over && !s.won; tick++) {
    const inputs = s.players.map(() => ({}));
    s.players.forEach((p, i) => {
      const b = bots[i], inp = inputs[i];
      if (b.target && (b.target.dead || (!b.target.grow && !(b.heal && b.target.hp < 100)) || p.coins < 1)) b.target = null;
      if (!b.target && tick % 10 === i * 5) {
        const hurt = s.flowers.find((f) => f.lvl > 0 && f.lvl < MAX_LEVEL && f.hp < 45);
        const seedling = s.flowers.find((f) => f.grow && f.lvl === 0);
        const up = s.flowers.filter((f) => f.lvl > 0 && f.lvl < MAX_LEVEL).sort((a, c) => a.lvl - c.lvl)[0];
        if (hurt && p.coins >= 5) { b.target = hurt; b.heal = true; p.onFlowerId = hurt.id; }
        else if (seedling && p.coins >= 5) { b.target = seedling; b.heal = false; p.mode = 'grow'; p.onFlowerId = seedling.id; }
        else if (s.flowers.length < Math.min(16, 2 + s.wave + m.paths.length) || !up) {
          // keep planting until there's a decent garden, saving up if needed
          const spot = p.coins >= 25 && nextSpot();
          if (spot) {
            p.sel = built++ % p.loadout.length;
            // save expensive superweapons (Sunflower) until the first boss is near
            if (FLOWERS[p.loadout[p.sel]].cost > 100 && s.wave < 4) p.sel = built++ % p.loadout.length;
            p.building = true;
            p.x = (spot[0] + 0.5) * T; p.y = (spot[1] + 0.5) * T;
            inp.buildTap = true; inp.build = true;
          }
        } else if (up && p.coins >= 15) { b.target = up; b.heal = false; p.mode = 'grow'; p.onFlowerId = up.id; }
        if (b.target) { p.x = b.target.x; p.y = b.target.y - 10; }
      }
      if (b.target) { if (b.heal) inp.heal = true; else inp.build = !p.waitRelease; return; } // let go once a level finishes, like a player has to
      if (inp.buildTap) return;
      let foe = null, fd = 400;
      for (const e of s.enemies) { if (e.under) continue; const d = Math.hypot(e.x - p.x, e.y - p.y); if (d < fd) { fd = d; foe = e; } }
      // anything chewing on the cottage takes priority, wherever it is
      const chomper = s.enemies.find((e) => e.atBase);
      if (chomper) { foe = chomper; fd = Math.hypot(chomper.x - p.x, chomper.y - p.y); }
      let coin = null, cd = 1e9;
      for (const d of s.drops) { const dd = Math.hypot(d.x - p.x, d.y - p.y); if (dd < cd) { cd = dd; coin = d; } }
      if (foe && (!coin || fd < cd || foe.atBase)) {
        [inp.mx, inp.my] = towards(m, p, foe.x, foe.y);
        if (fd < 60) { p.dir = Math.atan2(foe.y - p.y, foe.x - p.x); inp.mx = 0; inp.my = 0; inp.atk = true; }
      } else if (coin) { [inp.mx, inp.my] = towards(m, p, coin.x, coin.y); }
    });
    sim.step(s, inputs, 1 / 60);
    s.events.length = 0;
    s.fx.length = 0;
    if (s.phase === 'prep' && s.timer > 8) s.timer = 8;
    if (s.wave !== lastWave) {
      lastWave = s.wave;
      log.push({ wave: s.wave, lives: s.lives, coins: s.players.map((p) => Math.floor(p.coins)), flowers: s.flowers.length, levels: s.flowers.reduce((a, f) => a + f.lvl, 0) });
    }
  }
  return { won: s.won, wave: s.wave, lives: s.lives, log };
}
