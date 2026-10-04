// The online guest's own cat, moved on this screen straight away instead of a
// round trip later.
//
// Every guest tick samples the keys into a numbered input, sends it, and moves
// a private copy of the cat with the same moveCat() the host uses. The host
// applies exactly one guest input per tick and says in each snapshot which was
// the last. When a snapshot comes in, we start again from where the host had
// the cat and replay the inputs it hasn't seen yet, so the guest normally ends
// up exactly where it already was. Any small difference (a bomb blast, a
// late input) is folded into an offset that fades out over a few frames
// instead of making the cat jump.
import { T } from './data.js';
import { moveCat, startSwing, catStats } from './sim.js';

const DT = 1 / 60;
const SNAP_DIST = T * 2;               // further off than this, just jump there
const SETTLE = 15;                     // how fast a correction fades (per second)
// What prediction owns while drawing the guest's cat.
const OWN = ['x', 'y', 'dir', 'moving', 'stam', 'tired', 'sprinting', 'restT', 'atkCd', 'swingT', 'swingDir', 'stun'];

export function createPredictor() {
  return { seq: 0, history: [], me: null, prev: null, err: { x: 0, y: 0 }, baseSeq: -1 };
}

// moveCat only needs the map and sharedScreen (always off online) from the game.
function apply(m, p, inp) {
  if (moveCat({ m, sharedScreen: false }, p, inp, DT) && inp.atk && p.atkCd <= 0) startSwing(p, catStats(p));
}

// One guest tick on map m. `inp` is the sampled keys; it gets its number here.
export function predictTick(pr, m, inp, canMove) {
  inp.seq = ++pr.seq;
  pr.history.push(inp);
  if (pr.history.length > 180) pr.history.shift(); // the host has stopped answering; don't grow forever
  if (!pr.me) return;
  pr.prev = { x: pr.me.x, y: pr.me.y };
  if (canMove) apply(m, pr.me, inp);
}

// Inputs the host hasn't applied yet; these are (re)sent every time.
export const unacked = (pr) => pr.history;

// A newer snapshot: `host` is our cat as the host had it after applying input `ack`.
export function reconcile(pr, m, host, ack, canMove) {
  pr.history = pr.history.filter((i) => i.seq > ack);
  const me = {};
  for (const k of OWN) me[k] = host[k];
  me.cat = host.cat;
  if (canMove) for (const inp of pr.history) apply(m, me, inp);
  if (pr.me) {
    const dx = pr.me.x - me.x, dy = pr.me.y - me.y;
    if (Math.hypot(dx, dy) < SNAP_DIST) {
      pr.err.x += dx; pr.err.y += dy;
      pr.prev.x -= dx; pr.prev.y -= dy;
    } else {
      pr.err = { x: 0, y: 0 };
      pr.prev = { x: me.x, y: me.y };
    }
  } else pr.prev = { x: me.x, y: me.y };
  pr.me = me;
}

// Put the predicted cat into the drawn state. `a` is how far we are between
// the last guest tick and the next (0..1), so it moves smoothly at any frame rate.
export function showPrediction(pr, drawn, a, dt) {
  if (!pr.me || !drawn) return;
  const k = Math.exp(-SETTLE * dt);
  pr.err.x *= k; pr.err.y *= k;
  for (const key of OWN) drawn[key] = pr.me[key];
  drawn.x = pr.prev.x + (pr.me.x - pr.prev.x) * a + pr.err.x;
  drawn.y = pr.prev.y + (pr.me.y - pr.prev.y) * a + pr.err.y;
}
