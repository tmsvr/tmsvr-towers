// A simple autopilot used to sanity-check balance.json. It plays both cats:
// heal hurt flowers, grow seedlings, plant near the path, upgrade, and
// otherwise bonk the nearest enemy or collect coins. It never uses bombs and
// picks a random-ish flower mix, so real players should do noticeably better.
import * as sim from '../src/sim.js';
import { T, W, H, PATH_TILES, FLOWER_ORDER, LOADOUT_SIZE, MAX_LEVEL } from '../src/data.js';

export function runBot({ players = 2, seed = 1, loadouts, map = 0, maxMinutes = 40 } = {}) {
  const s = sim.createState(players, seed, { map });
  s.players.forEach((p, i) => {
    const pick = loadouts?.[i] || FLOWER_ORDER.slice(i * 2, i * 2 + LOADOUT_SIZE);
    p.pick.chosen = pick.length === LOADOUT_SIZE ? pick : FLOWER_ORDER.slice(0, LOADOUT_SIZE);
    p.pick.ready = true;
  });
  sim.step(s, s.players.map(() => ({})), 1 / 60);

  // tiles next to lots of path, best first
  const spots = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!sim.canBuildAt(s, x, y)) continue;
    let n = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (PATH_TILES.has((y + dy) * W + x + dx)) n++;
    if (n >= 3) spots.push([x, y, n]);
  }
  spots.sort((a, b) => b[2] - a[2]);

  let built = 0;
  const bots = s.players.map(() => ({ target: null }));
  const log = [];
  let lastWave = 0;
  for (let tick = 0; tick < 60 * 60 * maxMinutes && !s.over && !s.won; tick++) {
    const inputs = s.players.map(() => ({}));
    s.players.forEach((p, i) => {
      const b = bots[i], inp = inputs[i];
      if (b.target && (b.target.dead || (!b.target.grow && !(p.mode === 'heal' && b.target.hp < 100)) || p.coins < 1)) b.target = null;
      if (!b.target && tick % 10 === i * 5) {
        const hurt = s.flowers.find((f) => f.lvl > 0 && f.lvl < MAX_LEVEL && f.hp < 45);
        const seedling = s.flowers.find((f) => f.grow && f.lvl === 0);
        const up = s.flowers.filter((f) => f.lvl > 0 && f.lvl < MAX_LEVEL).sort((a, c) => a.lvl - c.lvl)[0];
        if (hurt && p.coins >= 5) { b.target = hurt; p.mode = 'heal'; p.onFlowerId = hurt.id; }
        else if (seedling && p.coins >= 5) { b.target = seedling; p.mode = 'grow'; p.onFlowerId = seedling.id; }
        else if (s.flowers.length < Math.min(14, 3 + s.wave) || !up) {
          // keep planting until there's a decent garden, saving up if needed
          const spot = p.coins >= 25 && spots.find(([x, y]) => sim.canBuildAt(s, x, y));
          if (spot) {
            p.sel = built++ % p.loadout.length;
            p.building = true;
            p.x = (spot[0] + 0.5) * T; p.y = (spot[1] + 0.5) * T;
            inp.buildTap = true; inp.build = true;
          }
        } else if (up && p.coins >= 15) { b.target = up; p.mode = 'grow'; p.onFlowerId = up.id; }
        if (b.target) { p.x = b.target.x; p.y = b.target.y - 10; }
      }
      if (b.target) { inp.build = true; return; }
      if (inp.buildTap) return;
      let foe = null, fd = 400;
      for (const e of s.enemies) { if (e.under || e.def.flying) continue; const d = Math.hypot(e.x - p.x, e.y - p.y); if (d < fd) { fd = d; foe = e; } }
      let coin = null, cd = 1e9;
      for (const d of s.drops) { const dd = Math.hypot(d.x - p.x, d.y - p.y); if (dd < cd) { cd = dd; coin = d; } }
      if (foe && (!coin || fd < cd)) {
        inp.mx = foe.x - p.x; inp.my = foe.y - p.y;
        if (fd < 60) { p.dir = Math.atan2(inp.my, inp.mx); inp.mx = 0; inp.my = 0; inp.atk = true; }
      } else if (coin) { inp.mx = coin.x - p.x; inp.my = coin.y - p.y; }
    });
    sim.step(s, inputs, 1 / 60);
    s.events.length = 0;
    if (s.phase === 'prep' && s.timer > 8) s.timer = 8;
    if (s.wave !== lastWave) {
      lastWave = s.wave;
      log.push({ wave: s.wave, lives: s.lives, coins: s.players.map((p) => Math.floor(p.coins)), flowers: s.flowers.length, levels: s.flowers.reduce((a, f) => a + f.lvl, 0) });
    }
  }
  return { won: s.won, wave: s.wave, lives: s.lives, log };
}
