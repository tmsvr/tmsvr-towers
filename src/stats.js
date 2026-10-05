// The game log for balancing: how each wave went, what was spent and earned,
// what dealt the damage and what hurt the cottage. The sim calls these hooks;
// they only count, so they never change how the game plays. Only the copy of
// the game that runs the rules (local play or the online host) keeps a log.
import { DATA_HASH, CATS } from './data.js';

const add = (o, k, v = 1) => { o[k] = (o[k] || 0) + v; };
const r1 = (v) => Math.round(v * 10) / 10;

// Called when the pick screen ends: who played what, where.
export function startLog(s) {
  s.stats = {
    version: DATA_HASH,
    date: new Date().toISOString(),
    map: s.m.id,
    players: s.players.map((p) => ({ id: p.id, cat: p.cat, catName: CATS[p.cat]?.name, loadout: p.loadout.slice() })),
    cottageHealth: s.maxLives,
    result: null,
    waves: [],
    cur: null,
  };
  openPeriod(s);
}

// A period runs from the end of one wave (or the start of the game) to the
// end of the next, so spending in the break before a wave counts towards it.
function openPeriod(s) {
  s.stats.cur = {
    wave: s.wave + 1,
    prepStartT: s.t, waveStartT: null, endT: null,
    cottageStart: s.lives,
    cottageDamage: {},
    spawned: {}, killed: {},
    damage: {}, kills: {},
    coins: s.players.map((p) => ({ start: p.coins, earned: 0, plant: 0, upgrade: 0, heal: 0, refund: 0 })),
    planted: {}, upgrades: {}, wilted: { wear: {}, aphid: {} }, dug: {},
  };
}

const cur = (s) => s.stats?.cur;

export function logWaveStart(s) { if (cur(s)) cur(s).waveStartT = s.t; }

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
  for (const k in w.damage) w.damage[k] = Math.round(w.damage[k]);
  w.coins.forEach((c, i) => { c.end = Math.round(s.players[i].coins); for (const k in c) c[k] = Math.round(c[k]); });
  w.garden = s.flowers.filter((f) => !f.dead).map((f) => ({ type: f.type, lvl: f.lvl, hp: Math.round(f.hp) }));
  delete w.prepStartT; delete w.waveStartT; delete w.endT;
  s.stats.waves.push(w);
  s.stats.cur = null;
  if (how === 'cleared') openPeriod(s);
}

// The whole game, ready to save: the last wave is closed if it was cut short.
export function finishLog(s, how) {
  if (!s.stats) return null;
  if (cur(s) && cur(s).waveStartT != null) logWaveEnd(s, how);
  const st = s.stats;
  st.result = { how, wave: s.wave, won: !!s.won, cottage: r1(s.lives), kills: s.kills, seconds: Math.round(s.t) };
  const totals = { damage: {}, kills: {}, cottageDamage: {}, coins: s.players.map(() => ({ earned: 0, plant: 0, upgrade: 0, heal: 0, refund: 0 })) };
  for (const w of st.waves) {
    for (const k in w.damage) add(totals.damage, k, w.damage[k]);
    for (const k in w.kills) add(totals.kills, k, w.kills[k]);
    for (const k in w.cottageDamage) add(totals.cottageDamage, k, w.cottageDamage[k]);
    w.coins.forEach((c, i) => { for (const k in totals.coins[i]) totals.coins[i][k] += c[k] || 0; });
  }
  totals.coins.forEach((c, i) => { c.left = Math.round(s.players[i].coins); });
  st.totals = totals;
  const { cur: _, ...log } = st;
  return log;
}

export function logSpawn(s, type) { if (cur(s)) add(cur(s).spawned, type); }

// src says what did it: a flower type, 'baton P1', 'bomb P2', 'poison'...
export function logDamage(s, src, e, dealt, killed) {
  const w = cur(s);
  if (!w || !src) return;
  add(w.damage, src, dealt);
  if (killed) { add(w.kills, src); add(w.killed, e.type); }
}

export function logCottage(s, type, amt) { if (cur(s)) add(cur(s).cottageDamage, type, amt); }

// kind: 'earned' | 'plant' | 'upgrade' | 'heal' | 'refund'
export function logCoins(s, p, kind, amt) { const c = cur(s)?.coins[p.id]; if (c) c[kind] += amt; }

export function logPlanted(s, type) { if (cur(s)) add(cur(s).planted, type); }
export function logUpgrade(s, type, lvl) { const w = cur(s); if (w) { w.upgrades[type] ??= {}; add(w.upgrades[type], `Lv${lvl}`); } }
export function logWilt(s, type, cause) { if (cur(s)) add(cur(s).wilted[cause], type); }
export function logDug(s, type) { if (cur(s)) add(cur(s).dug, type); }
