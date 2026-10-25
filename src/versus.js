// Versus races: two teams, each playing its own game of the same challenge
// (same seed, map and mode, so the same waves), linked host to host. Neither
// side's game knows about the other; the hosts swap a few numbers a second,
// and whoever holds out better wins. Pure helpers here; main.js does the
// talking (the 'race', 'status', 'pause' and 'send' messages).
import { wavesCleared, scoreOf, lastWave } from './sim.js';

// What one team tells the other about its game, a few times a second.
export function raceStatus(s) {
  return {
    wave: s.wave, last: lastWave(s), phase: s.phase, cleared: wavesCleared(s),
    lives: Math.max(0, Math.ceil(s.lives)), maxLives: s.maxLives, kills: s.kills, score: scoreOf(s),
    over: !!s.over, won: !!s.won, players: s.players.length, picked: s.phase !== 'pick', meter: s.meter || 0,
    // our packs still on their way to them, so they can watch them land
    threat: (s.threats || []).reduce((a, th) => a + th.share, 0), threatT: s.threats?.length ? Math.min(...s.threats.map((th) => th.t)) : 0,
  };
}

const done = (st) => st.over || st.won;

// How a finished game ranks: winning first, then waves cleared, then the
// cottage left, then the score. Higher is better.
const rank = (st) => [st.won ? 1 : 0, st.cleared, st.won ? st.lives : 0, st.score];
function compare(a, b) {
  const ra = rank(a), rb = rank(b);
  for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] > rb[i] ? 1 : -1;
  return 0;
}

// 'win' | 'lose' | 'draw' for `mine` against `theirs`, or null while it can
// still go either way. A team still playing has already won if the other fell
// with fewer waves cleared than it has now (waves cleared only go up).
export function raceResult(mine, theirs) {
  if (!mine || !theirs) return null;
  if (done(mine) && done(theirs)) { const c = compare(mine, theirs); return c > 0 ? 'win' : c < 0 ? 'lose' : 'draw'; }
  if (done(mine) && !mine.won && theirs.cleared > mine.cleared) return 'lose';
  if (done(theirs) && !theirs.won && mine.cleared > theirs.cleared) return 'win';
  return null;
}

// What the race looks like from here, in a few words (HUD and end screen).
export function raceLine(st) {
  if (!st) return 'not connected';
  if (st.left) return 'left the race';
  if (!st.picked) return 'choosing flowers';
  if (st.won) return `won all ${st.last} waves · 🏠 ${st.lives}`;
  if (st.over) return `fell in wave ${st.wave} · ${st.cleared} cleared`;
  return `wave ${Math.max(1, st.wave)}/${st.last} · 🏠 ${st.lives}/${st.maxLives}`;
}
