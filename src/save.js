// Saved games: the whole game state as JSON, written from the pause menu and
// loaded from the main menu (solo, local co-op or online).
//
// The state is a graph, not a tree: a flower sits both in s.flowers and in
// s.grid, a seed points at the monster it chases, a cat at the flower it is
// working on. So an object met more than once is written whole the first time
// with an $id and as {$ref} after that. Shared game data (monster types,
// flowers, maps) is written by name and comes back as the very same object.
// Maps, Sets and non-finite numbers get their own markers.
import { ENEMIES, FLOWERS, MAPS, DATA_HASH } from './data.js';

export const SAVE_FORMAT = 1;

function constants() {
  const c = new Map();
  for (const [k, v] of Object.entries(ENEMIES)) c.set(v, `enemy:${k}`);
  for (const [k, v] of Object.entries(FLOWERS)) c.set(v, `flower:${k}`);
  MAPS.forEach((m, i) => c.set(m, `map:${i}`));
  return c;
}
function constant(name) {
  const [kind, k] = name.split(':');
  const v = kind === 'enemy' ? ENEMIES[k] : kind === 'flower' ? FLOWERS[k] : kind === 'map' ? MAPS[+k] : undefined;
  if (!v) throw new Error(`unknown ${kind} "${k}"`);
  return v;
}
const children = (v) => (v instanceof Map ? [...v.keys(), ...v.values()] : v instanceof Set ? [...v] : Object.values(v));

// mode: 'solo' | 'local' | 'online', how the game was being played.
export function saveGame(s, mode) {
  const C = constants(), seen = new Set(), shared = new Set();
  const root = { ...s, fx: [], events: [] }; // effects and sounds are already on screen
  const visit = (v) => {
    if (!v || typeof v !== 'object' || C.has(v)) return;
    if (seen.has(v)) { shared.add(v); return; }
    seen.add(v);
    for (const x of children(v)) visit(x);
  };
  visit(root);
  const ids = new Map();
  const out = (v) => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : { $num: String(v) };
    if (!v || typeof v !== 'object') return v;
    if (C.has(v)) return { $c: C.get(v) };
    if (ids.has(v)) return { $ref: ids.get(v) };
    const o = {};
    if (shared.has(v)) { o.$id = ids.size; ids.set(v, o.$id); } // before the children, for cycles
    if (Array.isArray(v)) o.$arr = v.map(out);
    else if (v instanceof Map) o.$map = [...v].map(([k, x]) => [out(k), out(x)]);
    else if (v instanceof Set) o.$set = [...v].map(out);
    else for (const [k, x] of Object.entries(v)) o[k] = out(x);
    // plain arrays nobody else points at are written as plain arrays
    return Array.isArray(v) && o.$id === undefined ? o.$arr : o;
  };
  return { game: 'petal-patrol', format: SAVE_FORMAT, version: DATA_HASH, date: new Date().toISOString(), mode, state: out(root) };
}

// Throws if the file isn't a save this game can read.
export function loadGame(data) {
  if (data?.game !== 'petal-patrol' || !data.state) throw new Error('not a Petal Patrol save');
  if (data.format !== SAVE_FORMAT) throw new Error('saved by a different version of the game');
  const ids = [];
  const back = (v) => {
    if (!v || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(back);
    if ('$num' in v) return Number(v.$num);
    if ('$c' in v) return constant(v.$c);
    if ('$ref' in v) return ids[v.$ref];
    let o;
    const keep = (x) => { if (v.$id !== undefined) ids[v.$id] = x; return x; };
    if ('$arr' in v) { o = keep([]); for (const x of v.$arr) o.push(back(x)); }
    else if ('$map' in v) { o = keep(new Map()); for (const [k, x] of v.$map) o.set(back(k), back(x)); }
    else if ('$set' in v) { o = keep(new Set()); for (const x of v.$set) o.add(back(x)); }
    else { o = keep({}); for (const [k, x] of Object.entries(v)) if (k !== '$id') o[k] = back(x); }
    return o;
  };
  const s = back(data.state);
  s.items ??= []; // saved before elites dropped power-ups
  if (s.m !== MAPS[s.map]) throw new Error('the map in this save no longer exists');
  return { state: s, mode: data.mode, sameVersion: data.version === DATA_HASH };
}
