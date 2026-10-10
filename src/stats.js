// The game log for balancing: how each wave went, what was spent and earned,
// what dealt the damage and what hurt the cottage. The sim calls these hooks;
// they only count, so they never change how the game plays. Only the copy of
// the game that runs the rules (local play or the online host) keeps a log.
//
// Besides the per-wave summaries, the log keeps (format 3):
//  - timeline: what happened when, as compact arrays [t, kind, ...]:
//      [t, 'wave', n]                        a wave starts
//      [t, 'end', n, how, cottage]           a wave ends ('cleared' | 'lost' | 'won')
//      [t, 'plant', p, fid, type, tx, ty]    player p puts a seedling on tile tx, ty
//      [t, 'lvl', p, fid, lvl, coins]        flower fid reaches lvl (1 = done growing); p finished it, coins = p's coins after
//      [t, 'heal', p, fid, hp]               p starts healing flower fid (at hp health)
//      [t, 'dig', p, fid, lvl, refund]       p digs flower fid up
//      [t, 'wilt', fid, cause]               flower fid wilts ('wear' | 'aphid')
//      [t, 'bomb', p, tx, ty, hits]          p's bomb lands on tile tx, ty and hits that many monsters
//      [t, 'leak', type, road]               a monster reaches the cottage (road = index into the map's paths)
//      [t, 'pos', p, tx, ty, act, coins]     every 2 s: where each cat is and what it mostly did since the last sample
//                                            (b = growing/upgrading, h = healing, d = digging, f = fighting, m = moving, i = idle)
//  - flowers: every flower ever planted, with its tile, who planted it when,
//    each level reached [t, lvl, by], how it ended, and its own damage and kills
//    (in total and per wave), so placement can be judged flower by flower.
// t is game seconds; tiles are map tile coordinates.
//
// Per wave (and in totals) for the features being playtested (IDEAS R1-R3):
//  - bloom: { damage: {type: n}, triggers: {type: n} }  level-5 abilities; the
//    damage is also inside `damage`, this is the share the ability added.
import { DATA_HASH, CATS } from './data.js';

const add = (o, k, v = 1) => { o[k] = (o[k] || 0) + v; };
const r1 = (v) => Math.round(v * 10) / 10;
const SAMPLE = 2; // seconds between position samples

// Called when the pick screen ends: who played what, where.
export function startLog(s) {
  s.stats = {
    format: 3,
    version: DATA_HASH,
    date: new Date().toISOString(),
    map: s.m.id,
    players: s.players.map((p) => ({ id: p.id, cat: p.cat, catName: CATS[p.cat]?.name, loadout: p.loadout.slice() })),
    cottageHealth: s.maxLives,
    result: null,
    waves: [],
    timeline: [],
    flowers: {},
    cur: null,
    acts: s.players.map(() => ({})), sampleT: 0,
  };
  openPeriod(s);
}

// Endless mode after a win: the same log carries on with the next wave.
export function resumeLog(s) {
  if (!s.stats) return;
  s.stats.endless = true;
  openPeriod(s);
}

// A period runs from the end of one wave (or the start of the game) to the
// end of the next, so spending in the break before a wave counts towards it.
function openPeriod(s) {
  s.stats.cur = {
    wave: s.wave + 1,
    prepStartT: s.t, waveStartT: null, endT: null,
    cottageStart: s.lives,
    cottageDamage: {}, cottageDamageByRoad: {},
    spawned: {}, killed: {},
    damage: {}, kills: {},
    coins: s.players.map((p) => ({ start: p.coins, earned: 0, plant: 0, upgrade: 0, heal: 0, refund: 0 })),
    activity: s.players.map(() => ({})), // seconds spent on each activity (same letters as 'pos')
    planted: {}, upgrades: {}, wilted: { wear: {}, aphid: {} }, dug: {},
    bloom: { damage: {}, triggers: {} }, // level-5 abilities (IDEAS R1): damage they added, times they went off
  };
}

const cur = (s) => s.stats?.cur;
const ev = (s, ...a) => { s.stats.timeline.push([r1(s.t), ...a]); };

export function logWaveStart(s) {
  if (!cur(s)) return;
  cur(s).waveStartT = s.t;
  ev(s, 'wave', s.wave);
}

// how: 'cleared' | 'lost' | 'won'
export function logWaveEnd(s, how) {
  const w = cur(s);
  if (!w) return;
  w.endT = s.t;
  w.result = how;
  w.prepSeconds = r1((w.waveStartT ?? s.t) - w.prepStartT);
  w.waveSeconds = r1(s.t - (w.waveStartT ?? s.t));
  w.cottageEnd = r1(s.lives);
  for (const k in w.cottageDamage) w.cottageDamage[k] = r1(w.cottageDamage[k]);
  for (const k in w.cottageDamageByRoad) w.cottageDamageByRoad[k] = r1(w.cottageDamageByRoad[k]);
  for (const k in w.damage) w.damage[k] = Math.round(w.damage[k]);
  for (const k in w.bloom.damage) w.bloom.damage[k] = Math.round(w.bloom.damage[k]);
  w.coins.forEach((c, i) => { c.end = Math.round(s.players[i].coins); for (const k in c) c[k] = Math.round(c[k]); });
  w.activity.forEach((a) => { for (const k in a) a[k] = Math.round(a[k]); });
  w.garden = s.flowers.filter((f) => !f.dead).map((f) => ({ id: f.id, type: f.type, lvl: f.lvl, hp: Math.round(f.hp), tx: f.tx, ty: f.ty }));
  delete w.prepStartT; delete w.waveStartT; delete w.endT;
  s.stats.waves.push(w);
  s.stats.cur = null;
  ev(s, 'end', w.wave, how, r1(s.lives));
  if (how === 'cleared') openPeriod(s);
}

// The whole game, ready to save: the last wave is closed if it was cut short.
export function finishLog(s, how) {
  if (!s.stats) return null;
  if (cur(s) && cur(s).waveStartT != null) logWaveEnd(s, how);
  const st = s.stats;
  st.result = { how, wave: s.wave, won: !!s.won, cottage: r1(s.lives), kills: s.kills, seconds: Math.round(s.t) };
  const totals = { damage: {}, kills: {}, cottageDamage: {}, cottageDamageByRoad: {}, coins: s.players.map(() => ({ earned: 0, plant: 0, upgrade: 0, heal: 0, refund: 0 })), bloom: { damage: {}, triggers: {} } };
  for (const w of st.waves) {
    for (const k in w.bloom?.damage) add(totals.bloom.damage, k, w.bloom.damage[k]);
    for (const k in w.bloom?.triggers) add(totals.bloom.triggers, k, w.bloom.triggers[k]);
    for (const k in w.damage) add(totals.damage, k, w.damage[k]);
    for (const k in w.kills) add(totals.kills, k, w.kills[k]);
    for (const k in w.cottageDamage) add(totals.cottageDamage, k, w.cottageDamage[k]);
    for (const k in w.cottageDamageByRoad) add(totals.cottageDamageByRoad, k, w.cottageDamageByRoad[k]);
    w.coins.forEach((c, i) => { for (const k in totals.coins[i]) totals.coins[i][k] += c[k] || 0; });
  }
  totals.coins.forEach((c, i) => { c.left = Math.round(s.players[i].coins); });
  st.totals = totals;
  return currentLog(s);
}

// The log as it stands, without closing anything (for downloading mid-game).
export function currentLog(s) {
  const { cur: _, acts: __, sampleT: ___, flowers, ...log } = s.stats;
  log.flowers = Object.values(flowers).map((f) => {
    const out = { ...f, dmg: Math.round(f.dmg), dmgByWave: {} };
    for (const k in f.dmgByWave) out.dmgByWave[k] = Math.round(f.dmgByWave[k]);
    return out;
  });
  return log;
}

export function logSpawn(s, type) { if (cur(s)) add(cur(s).spawned, type); }

// src says what did it: a flower type, 'baton P1', 'bomb P2', 'stink'...;
// fid is the flower that did it, when a flower did.
export function logDamage(s, src, e, dealt, killed, fid, bloom = false) {
  const w = cur(s);
  if (!w || !src) return;
  add(w.damage, src, dealt);
  if (bloom) add(w.bloom.damage, src, dealt);
  if (killed) { add(w.kills, src); add(w.killed, e.type); }
  const f = fid != null && s.stats.flowers[fid];
  if (f) {
    f.dmg += dealt;
    add(f.dmgByWave, s.wave, dealt);
    if (killed) f.kills++;
  }
}

// Bloom abilities: extra damage counted on its own (it is already in the
// flower's damage), and each time an ability goes off.
export function logBloomDamage(s, type, amt) { if (cur(s)) add(cur(s).bloom.damage, type, amt); }
export function logBloom(s, type) { if (cur(s)) add(cur(s).bloom.triggers, type); }

// A monster chewing the cottage; the first bite also goes on the timeline.
export function logCottage(s, e, amt) {
  const w = cur(s);
  if (!w) return;
  add(w.cottageDamage, e.type, amt);
  add(w.cottageDamageByRoad, e.path, amt);
  if (!e.leakLogged) { e.leakLogged = true; ev(s, 'leak', e.type, e.path); }
}

// kind: 'earned' | 'plant' | 'upgrade' | 'heal' | 'refund'
export function logCoins(s, p, kind, amt) { const c = cur(s)?.coins[p.id]; if (c) c[kind] += amt; }

export function logPlanted(s, p, f) {
  if (!cur(s)) return;
  add(cur(s).planted, f.type);
  s.stats.flowers[f.id] = {
    id: f.id, type: f.type, tx: f.tx, ty: f.ty, by: p.id, t: r1(s.t), wave: s.wave, inWave: s.phase === 'wave',
    levels: [], end: null, dmg: 0, kills: 0, dmgByWave: {},
  };
  ev(s, 'plant', p.id, f.id, f.type, f.tx, f.ty);
}

// A flower finished growing (lvl 1) or an upgrade (lvl 2+); p poured the last coin.
export function logLevel(s, p, f) {
  const w = cur(s);
  if (!w) return;
  if (f.lvl > 1) { w.upgrades[f.type] ??= {}; add(w.upgrades[f.type], `Lv${f.lvl}`); }
  s.stats.flowers[f.id]?.levels.push([r1(s.t), f.lvl, p.id]);
  ev(s, 'lvl', p.id, f.id, f.lvl, Math.round(p.coins));
}

export function logHealStart(s, p, f) { if (cur(s)) ev(s, 'heal', p.id, f.id, Math.round(f.hp)); }

export function logWilt(s, f, cause) {
  if (!cur(s)) return;
  add(cur(s).wilted[cause], f.type);
  const rec = s.stats.flowers[f.id];
  if (rec) rec.end = [r1(s.t), 'wilt', cause];
  ev(s, 'wilt', f.id, cause);
}

export function logDug(s, p, f, refund) {
  if (!cur(s)) return;
  add(cur(s).dug, f.type);
  const rec = s.stats.flowers[f.id];
  if (rec) rec.end = [r1(s.t), 'dug', f.lvl];
  ev(s, 'dig', p.id, f.id, f.lvl, refund);
}

export function logBomb(s, b, tx, ty, hits) { if (cur(s)) ev(s, 'bomb', b.owner ?? 0, tx, ty, hits); }

// Every tick: what each cat is doing; every SAMPLE seconds, where it is and
// what it mostly did since the last sample.
export function logTick(s, dt, tileOf) {
  const st = s.stats, w = cur(s);
  if (!w) return;
  s.players.forEach((p, i) => {
    const act = p.working ? (p.mode === 'dig' ? 'd' : 'b') : p.healing ? 'h' : p.swingT > 0 ? 'f' : p.moving ? 'm' : 'i';
    add(st.acts[i], act, dt);
    add(w.activity[i], act, dt);
  });
  if (s.t - st.sampleT < SAMPLE) return;
  st.sampleT = s.t;
  s.players.forEach((p, i) => {
    const a = st.acts[i];
    let best = 'i';
    for (const k in a) if (a[k] > (a[best] || 0)) best = k;
    const { tx, ty } = tileOf(s.m, p);
    ev(s, 'pos', p.id, tx, ty, best, Math.round(p.coins));
    st.acts[i] = {};
  });
}

// What the victory / defeat screen shows, made from a finished log: damage
// and kills per flower type, the best single flower, each cat's coins and
// damage, and what bit the cottage most. Small and plain, so the host can
// send it to an online guest as it is.
export function gameSummary(log) {
  const t = log.totals, r = log.result;
  const flowers = {};
  for (const f of log.flowers) {
    const o = flowers[f.type] ??= { type: f.type, dmg: 0, kills: 0, planted: 0 };
    o.planted++;
  }
  for (const k in t.damage) if (flowers[k]) flowers[k].dmg = Math.round(t.damage[k]);
  for (const k in t.kills) if (flowers[k]) flowers[k].kills = t.kills[k];
  const topLevel = (f) => f.levels.reduce((a, l) => Math.max(a, l[1]), 0);
  const best = log.flowers.reduce((a, f) => (!a || f.dmg > a.dmg ? f : a), null);
  const cats = log.players.map((p, i) => {
    const c = t.coins[i] || {};
    const tag = `P${i + 1}`;
    return {
      cat: p.cat, earned: c.earned || 0, spent: (c.plant || 0) + (c.upgrade || 0) + (c.heal || 0),
      baton: Math.round(t.damage[`baton ${tag}`] || 0), bomb: Math.round(t.damage[`bomb ${tag}`] || 0),
      kills: (t.kills[`baton ${tag}`] || 0) + (t.kills[`bomb ${tag}`] || 0),
      garden: Math.round(log.flowers.filter((f) => f.by === i).reduce((a, f) => a + f.dmg, 0)),
    };
  });
  return {
    won: r.won, wave: r.wave, seconds: r.seconds, kills: r.kills, cottage: Math.round(r.cottage), maxCottage: log.cottageHealth,
    flowers: Object.values(flowers).sort((a, b) => b.dmg - a.dmg),
    best: best && best.dmg > 0 ? { type: best.type, lvl: topLevel(best), dmg: best.dmg, kills: best.kills } : null,
    cats,
    bitten: Object.entries(t.cottageDamage).filter(([, v]) => v >= 1).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => [k, Math.round(v)]),
  };
}
