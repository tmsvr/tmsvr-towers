// The fast-lane messages (snapshots and guest input), listed once and written
// as compact binary. Encoding (sender) and decoding (receiver) both walk the
// same field lists, so a field is added or removed in one place and the two
// sides can't drift apart.
import { ENEMIES, FLOWER_ORDER, CAT_ORDER, ELITE_TRAITS, ITEM_KINDS } from './data.js';

// ---- bytes ------------------------------------------------------------------
// Whole numbers are written as varints (7 bits a byte), signed ones zigzagged,
// so small numbers take one byte and a position in tenths of a pixel three.
// Bump whenever a message changes shape, so mismatched copies refuse to play
// together instead of misreading each other (checked when a guest joins).
export const PROTOCOL = 9;

const utf8 = new TextEncoder(), fromUtf8 = new TextDecoder();

class Out {
  constructor() { this.b = new Uint8Array(2048); this.n = 0; }
  room(k) {
    if (this.n + k <= this.b.length) return;
    const b = new Uint8Array(Math.max(this.b.length * 2, this.n + k));
    b.set(this.b);
    this.b = b;
  }
  byte(v) { this.room(1); this.b[this.n++] = v; }
  uint(v) {
    this.room(10);
    while (v >= 128) { this.b[this.n++] = (v % 128) | 128; v = Math.floor(v / 128); }
    this.b[this.n++] = v;
  }
  int(v) { this.uint(v >= 0 ? v * 2 : -v * 2 - 1); }
  f64(v) { this.room(8); new DataView(this.b.buffer).setFloat64(this.n, v); this.n += 8; }
  str(s) { const b = utf8.encode(s); this.uint(b.length); this.room(b.length); this.b.set(b, this.n); this.n += b.length; }
  bytes() { return this.b.slice(0, this.n).buffer; }
}

// Reading checks every step, so a cut-off or garbled message throws instead
// of producing nonsense (decodeFast turns that into "ignore the message").
class In {
  constructor(buf) { this.b = new Uint8Array(buf); this.n = 0; }
  need(k) { if (this.n + k > this.b.length) throw new RangeError('message too short'); }
  byte() { this.need(1); return this.b[this.n++]; }
  uint() {
    let v = 0, k = 1, x;
    do {
      this.need(1);
      x = this.b[this.n++]; v += (x & 127) * k; k *= 128;
      if (k > 2 ** 56) throw new RangeError('number too long');
    } while (x & 128);
    return v;
  }
  int() { const u = this.uint(); return u % 2 ? -(u + 1) / 2 : u / 2; }
  f64() { this.need(8); const v = new DataView(this.b.buffer, this.b.byteOffset).getFloat64(this.n); this.n += 8; return v; }
  str() { const len = this.uint(); this.need(len); const s = fromUtf8.decode(this.b.subarray(this.n, this.n + len)); this.n += len; return s; }
  // A list length, refusing absurd ones before anything is allocated.
  len(max) { const n = this.uint(); if (n > max) throw new RangeError('list too long'); return n; }
}

// ---- codecs: how one value is written and read ------------------------------
const num = (decimals) => {
  const k = 10 ** decimals;
  return { write: (w, v) => w.int(Math.round((v || 0) * k)), read: (r) => r.int() / k };
};
// A phase that only matters modulo `period` (kept small so it stays short on the wire).
const cycle = (period, decimals) => {
  const n = num(decimals);
  return { write: (w, v) => n.write(w, ((v || 0) % period + period) % period), read: n.read };
};
const int = { write: (w, v) => w.int(Math.round(v || 0)), read: (r) => r.int() };
const bool = { bool: true }; // packed into one bit field per struct
const text = { write: (w, v) => w.str(v || ''), read: (r) => r.str() };
const oneOf = (list) => ({ write: (w, v) => w.int(list.indexOf(v)), read: (r) => list[r.int()] });
const ref = { write: (w, o) => w.uint(o ? o.id : 0), read: (r) => r.uint() }; // an entity, sent as its id
// A list where only the length matters (the spawn queue): reads back as that many empty slots.
const count = { write: (w, a) => w.uint(a.length), read: (r) => new Array(Math.min(r.uint(), 1e5)) };
const listOf = (c) => ({
  write: (w, a, root) => { w.uint(a.length); for (const v of a) c.write(w, v, root); },
  read: (r) => Array.from({ length: r.len(5000) }, () => c.read(r)),
});
const maybe = (c) => ({
  write: (w, v, root) => { if (v == null) w.byte(0); else { w.byte(1); c.write(w, v, root); } },
  read: (r) => (r.byte() ? c.read(r) : null),
});
// fields: [name, codec, when?]. A `when` field must be a maybe(): while
// when(state) is false it is sent as empty and reads back as null, for data
// only needed in some phases. All bool fields share one bit field.
const struct = (fields) => {
  const flags = fields.filter(([, c]) => c.bool).map(([k]) => k);
  const rest = fields.filter(([, c]) => !c.bool);
  return {
    write(w, o, root) {
      if (flags.length) w.uint(flags.reduce((f, k, i) => f + (o[k] ? 2 ** i : 0), 0));
      for (const [k, c, when] of rest) {
        if (when && !when(root)) w.byte(0);
        else c.write(w, o[k], root);
      }
    },
    read(r) {
      const o = {};
      if (flags.length) { const f = r.uint(); flags.forEach((k, i) => { o[k] = Math.floor(f / 2 ** i) % 2 === 1; }); }
      for (const [k, c] of rest) o[k] = c.read(r);
      return o;
    },
  };
};

const r1 = num(1), r2 = num(2), r3 = num(3);
export const PHASES = ['wave', 'prep', 'pick'];
export const MODES = ['grow', 'dig'];
const flowerType = oneOf(FLOWER_ORDER);
const itemKind = oneOf([null, ...ITEM_KINDS]);

// ---- the snapshot -------------------------------------------------------------
const GAME = struct([
  ['lives', r1], ['wave', int], ['phase', oneOf(PHASES)], ['timer', r1], ['queue', count], ['over', bool], ['won', bool],
  ['kills', int], ['map', int], ['baseHitT', r2], ['maxLives', int], ['endless', bool],
]);

const PICK = struct([['cursor', int], ['chosen', listOf(flowerType)], ['ready', bool], ['row', int]]);

const PLAYER = struct([
  ['id', int], ['x', r1], ['y', r1], ['dir', r2], ['moving', bool], ['swingT', r2], ['swingDir', r2], ['bombs', r2],
  ['sel', int], ['mode', oneOf(MODES)], ['working', ref], ['coins', r1], ['stun', r2], ['loadout', maybe(listOf(flowerType))],
  ['pick', maybe(PICK), (s) => s.phase === 'pick'], ['building', bool], ['healing', bool], ['dig', r2], ['cat', oneOf(CAT_ORDER)], ['stam', r3], ['tired', bool], ['sprinting', bool],
  // only the guest's prediction needs these two (see predict.js)
  ['restT', r3], ['atkCd', r3],
  ['item', itemKind],
]);

const GROW = struct([['to', int], ['cost', int], ['paid', r1]]);

const FLOWER = struct([
  ['id', int], ['type', flowerType], ['lvl', int], ['tx', int], ['ty', int], ['angle', r2], ['flash', r2], ['hurtT', r2],
  ['hp', r1], ['headIdx', int], ['grow', maybe(GROW)], ['spent', r1], ['sunT', r1],
]);

const ENEMY = struct([
  ['id', int], ['type', oneOf(Object.keys(ENEMIES))], ['x', r1], ['y', r1], ['hp', r1], ['maxhp', r1], ['flash', r2],
  // the drawing only uses wob through sines of 1, 1.5, 2, 2.2, 4 and 0.3 times it, all of which repeat every 20π
  ['wob', cycle(20 * Math.PI, 2)], ['ang', r2], ['slowT', r2], ['stun', r2], ['under', bool], ['dashing', bool], ['chew', bool], ['psn', int],
  ['atBase', bool], ['burnT', r1], ['vulnT', r1], ['elite', oneOf([null, ...ELITE_TRAITS])], ['mini', bool],
]);

const DROP = struct([['id', int], ['x', r1], ['y', r1], ['big', bool], ['age', r1]]);
const PROJ = struct([
  ['id', int], ['kind', oneOf(['single', 'bolt', 'lob'])], ['x', r1], ['y', r1], ['big', int], ['color', text],
  ['ang', r2], ['k', r2],
]);
const BOMB = struct([['id', int], ['x', r1], ['y', r1], ['h', r1]]);
const ITEM = struct([['id', int], ['kind', itemKind], ['x', r1], ['y', r1], ['age', r1]]);
const CLOUD = struct([['id', int], ['x', r1], ['y', r1], ['r', r1], ['t', r2], ['dur', r1]]);

// [list in the state (null = the state itself), codec]
const SECTIONS = [
  [null, GAME],
  ['players', listOf(PLAYER)],
  ['flowers', listOf(FLOWER)],
  ['enemies', listOf(ENEMY)],
  ['drops', listOf(DROP)],
  ['projs', listOf(PROJ)],
  ['bombs', listOf(BOMB)],
  ['clouds', listOf(CLOUD)],
  ['items', listOf(ITEM)],
];

// ---- messages -------------------------------------------------------------------
const SNAP = 1, INPUTS = 2;

// The world at host time `at`, plus the last guest input applied (`ack`).
export function encodeSnapshot(s, { seq, at, paused, ack }) {
  const w = new Out();
  w.byte(SNAP); w.uint(seq); w.f64(at); w.byte(paused ? 1 : 0); w.uint(ack);
  for (const [from, codec] of SECTIONS) codec.write(w, from ? s[from] : s, s);
  return w.bytes();
}

// Guest ticks' keys. Holding a direction gives long runs of identical
// ticks, so each run is sent once: first seq, how many, direction, buttons.
const INPUT_FLAGS = ['atk', 'build', 'sprint', 'bomb', 'cycle', 'buildTap', 'ready', 'heal', 'use'];
const unit = (v) => Math.max(-1, Math.min(1, Math.round(+v || 0)));
const inputFlags = (i) => INPUT_FLAGS.reduce((f, k, b) => f | (i[k] ? 1 << b : 0), 0);

export function encodeInputs(list) {
  const runs = [];
  for (const i of list) {
    const mx = unit(i.mx), my = unit(i.my), flags = inputFlags(i);
    const last = runs[runs.length - 1];
    if (last && last.seq + last.n === i.seq && last.mx === mx && last.my === my && last.flags === flags) last.n++;
    else runs.push({ seq: i.seq, n: 1, mx, my, flags });
  }
  const w = new Out();
  w.byte(INPUTS); w.uint(runs.length);
  for (const r of runs) { w.uint(r.seq); w.uint(r.n); w.int(r.mx); w.int(r.my); w.uint(r.flags); }
  return w.bytes();
}

// A fast-lane message back into an object: { t: 'snap', seq, at, paused, ack,
// state: { game, players, flowers, ... } } or { t: 'in', inputs: [one per tick] }.
// Anything that doesn't decode cleanly gives null.
export function decodeFast(buf) {
  try {
    return decode(buf);
  } catch {
    return null;
  }
}

function decode(buf) {
  const r = new In(buf);
  const type = r.byte();
  if (type === SNAP) {
    const m = { t: 'snap', seq: r.uint(), at: r.f64(), paused: r.byte() === 1, ack: r.uint(), state: {} };
    for (const [from, codec] of SECTIONS) m.state[from || 'game'] = codec.read(r);
    return m;
  }
  if (type === INPUTS) {
    const inputs = [];
    for (let runs = r.len(600); runs > 0; runs--) {
      const seq = r.uint(), n = Math.min(r.uint(), 600), mx = unit(r.int()), my = unit(r.int()), f = r.uint();
      for (let k = 0; k < n; k++) {
        const i = { seq: seq + k, mx, my };
        INPUT_FLAGS.forEach((key, b) => { i[key] = !!(f & (1 << b)); });
        inputs.push(i);
      }
    }
    return { t: 'in', inputs };
  }
  return null;
}
