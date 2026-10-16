// Challenge codes: a game's seed, map and mode in six letters, so friends can
// play exactly the same waves and compare scores without any server. The same
// code always brings the same monsters (the waves have their own random
// numbers, see wrnd in sim.js), whatever anyone plants.
//
// 30 bits, five to a letter: seed (SEED_BITS), map (5), hard (1), sprint (1),
// and a 2-bit check so a mistyped code is refused rather than played.
import { MAPS } from './data.js';
import { modeName, lastWave, wavesCleared, scoreOf } from './sim.js';

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32, no I/O/0/1
export const SEED_BITS = 21;
export const randomSeed = () => Math.floor(Math.random() * 2 ** SEED_BITS);

const check = (v) => (v % 3 + (v >> 7) % 4 + (v >> 15) % 4) % 4;

// { seed, map, hard, sprint } → 'ABC-DEF'
export function encodeCode({ seed, map, hard, sprint }) {
  let v = (seed % 2 ** SEED_BITS) * 128 + (map % 32) * 4 + (hard ? 2 : 0) + (sprint ? 1 : 0);
  v = v * 4 + check(v);
  let out = '';
  for (let i = 0; i < 6; i++) { out = LETTERS[v % 32] + out; v = Math.floor(v / 32); }
  return `${out.slice(0, 3)}-${out.slice(3)}`;
}

// 'abc-def', 'ABCDEF'… → { seed, map, hard, sprint }, or null if it isn't a code.
export function decodeCode(text) {
  const t = String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (t.length !== 6) return null;
  let v = 0;
  for (const ch of t) {
    const k = LETTERS.indexOf(ch);
    if (k < 0) return null;
    v = v * 32 + k;
  }
  const body = Math.floor(v / 4);
  if (check(body) !== v % 4) return null;
  const map = Math.floor(body / 4) % 32;
  if (map >= MAPS.length) return null;
  return { seed: Math.floor(body / 128), map, hard: !!(body & 2), sprint: !!(body & 1) };
}

export const codeOf = (s) => encodeCode({ seed: s.seed ?? 0, map: s.map, hard: s.hard, sprint: s.sprint });

// Today's challenge, the same for everyone on the same date: a Sprint on a map
// that changes every day.
export function dailyChallenge(date = new Date()) {
  const day = date.toISOString().slice(0, 10);
  let h = 0x811c9dc5;
  for (const ch of day) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
  h >>>= 0;
  return { seed: h % 2 ** SEED_BITS, map: Math.floor(h / 2 ** SEED_BITS) % MAPS.length, hard: false, sprint: true, day };
}

// A few lines to paste into a chat, Wordle style: what was played, how it went.
export function shareText(s, { players = s.players.length, daily = null } = {}) {
  const hp = Math.max(0, Math.ceil(s.lives)), bar = Math.round((hp / s.maxLives) * 10);
  const result = s.won ? `won all ${lastWave(s)} waves` : s.endless ? `endless wave ${s.wave}` : `fell in wave ${s.wave}/${lastWave(s)}`;
  const who = players > 1 ? ` · ${players} players` : ' · solo';
  return [
    `🌼 Petal Patrol${daily ? ` · daily ${daily}` : ''} · ${modeName(s)} · ${s.m.name}${who}`,
    `Code ${codeOf(s)} · ${result} · ${wavesCleared(s)} cleared`,
    `🏠 ${'🟩'.repeat(bar)}${'⬛'.repeat(10 - bar)} ${hp}/${s.maxLives} · ${s.kills} bonked${s.retries?.length ? ` · ${s.retries.length} retr${s.retries.length > 1 ? 'ies' : 'y'}` : ''}`,
    `Score ${scoreOf(s).toLocaleString('en-US')}`,
  ].join('\n');
}
