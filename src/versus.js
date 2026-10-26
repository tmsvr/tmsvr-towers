// Versus races: two teams, each playing its own game of the same challenge
// (same seed, map and mode, so the same waves), linked host to host. Neither
// side's game knows about the other; the hosts swap a few numbers a second,
// and whoever holds out better wins. Pure helpers here; main.js does the
// talking (the 'race', 'status', 'pause' and 'send' messages).
import { wavesCleared, scoreOf, lastWave } from './sim.js';
import { CATS } from './data.js';

// What one team tells the other about its game, a few times a second.
export function raceStatus(s) {
  return {
    wave: s.wave, last: lastWave(s), phase: s.phase, cleared: wavesCleared(s),
    lives: Math.max(0, Math.ceil(s.lives)), maxLives: s.maxLives, kills: s.kills, waveKills: s.waveKills ?? s.kills, score: scoreOf(s),
    over: !!s.over, won: !!s.won, fell: !!s.over && !s.raceWon, players: s.players.length, cats: s.players.map((p) => p.cat), picked: s.phase !== 'pick', meter: s.meter || 0,
    // our packs still on their way to them, so they can watch them land
    waiting: s.waiting ? s.wave + 1 : 0, // ready for that wave, waiting for the rivals
    rush: s.rush || 0, // we pressed Enter for that wave: it starts for them too
    threat: (s.threats || []).reduce((a, th) => a + th.share, 0), threatT: s.threats?.length ? Math.min(...s.threats.map((th) => th.t)) : 0,
  };
}

// How a race ends: the first cottage to fall loses, and the other team's
// game stops there too (main.js calls endRace). If both teams win every wave,
// or fall at the same moment, the cottage left decides, then the score.
const rank = (st) => [st.fell ? 0 : 1, st.cleared, st.lives, st.score];
function compare(a, b) {
  const ra = rank(a), rb = rank(b);
  for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] > rb[i] ? 1 : -1;
  return 0;
}

// 'win' | 'lose' | 'draw' for `mine` against `theirs`, or null while it can
// still go either way.
export function raceResult(mine, theirs) {
  if (!mine || !theirs) return null;
  if (mine.fell !== theirs.fell) return mine.fell ? 'lose' : 'win';
  if ((mine.fell && theirs.fell) || (mine.won && theirs.won)) { const c = compare(mine, theirs); return c > 0 ? 'win' : c < 0 ? 'lose' : 'draw'; }
  return null;
}

// The rival team by its cats: "Brick & Zip", "Brick, Zip & Fern".
export function rivalName(st) {
  const names = (st?.cats || []).map((c) => CATS[c]?.name).filter(Boolean);
  if (!names.length) return st?.players > 1 ? `Rivals (${st.players})` : 'Rival';
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} & ${names.at(-1)}`;
}

// What the race looks like from here, in a few words (HUD and end screen).
export function raceLine(st) {
  if (!st) return 'not connected';
  if (st.left) return 'left the race';
  if (!st.picked) return 'choosing flowers';
  if (st.won) return `won all ${st.last} waves · 🏠 ${st.lives}`;
  if (st.fell) return `cottage fell in wave ${st.wave}`;
  if (st.over) return `still standing in wave ${st.wave} · 🏠 ${st.lives}/${st.maxLives}`;
  if (st.waiting) return `ready for wave ${st.waiting} · 🏠 ${st.lives}/${st.maxLives}`;
  return `wave ${Math.max(1, st.wave)}/${st.last} · 🏠 ${st.lives}/${st.maxLives}`;
}
