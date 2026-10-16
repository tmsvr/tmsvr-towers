// The host's side of an online game: taking each guest's inputs one per sim
// tick, and sending snapshots, sounds and effects back to every guest.
import { makeSnapshot, effectsMessage } from './snapshot.js';

const TAPS = ['bomb', 'cycle', 'buildTap', 'ready', 'use', 'send'];
const NO_TAPS = Object.fromEntries(TAPS.map((k) => [k, false]));

// One guest's inputs. It numbers them, one per guest tick, and resends the
// ones we haven't confirmed; we apply exactly one per sim tick and report the
// last in each snapshot (see predict.js for why).
function inputQueue() {
  let queue = [], last = {}, seq = 0, ack = 0;
  return {
    get ack() { return ack; },
    receive(list) {
      for (const inp of list) {
        if (inp.seq <= seq) continue; // already have it
        seq = inp.seq;
        queue.push(inp);
      }
    },
    next() {
      if (queue.length > 8) { // a burst arrived or we fell behind: skip ahead, keeping any taps
        const skipped = queue.splice(0, queue.length - 4);
        for (const k of TAPS) if (skipped.some((i) => i[k])) queue[0][k] = true;
      }
      const inp = queue.shift();
      if (!inp) return { ...last, ...NO_TAPS }; // late: assume the same keys are still held
      last = inp;
      ack = inp.seq;
      return inp;
    },
  };
}

export function createHostLink() {
  const guests = new Map(); // player id -> its input queue
  // Sound events and effect descriptions waiting for the next snapshot.
  // Repeats of an event in one snapshot are merged (sounds are rate-limited
  // anyway), so a crowd chewing the cottage can't crowd out the boss kill.
  const events = new Map();
  let fx = [];
  let ticks = 0, lastSent = 0, snapSeq = 0;

  return {
    // Everyone (re)starts: forget all inputs and anything queued.
    reset() { guests.clear(); events.clear(); fx = []; },
    // One guest (re)joined or left: its inputs start afresh.
    resetGuest(pid) { guests.delete(pid); },

    receiveInputs(pid, list) {
      if (!guests.has(pid)) guests.set(pid, inputQueue());
      guests.get(pid).receive(list);
    },

    // Guest `pid`'s input for this sim tick; a cat nobody plays stands still.
    nextInput(pid) { return guests.get(pid)?.next() || {}; },

    // Called after every sim tick.
    ticked() { ticks++; },

    forwardEvent(e) {
      const had = events.get(e.type);
      if (!had || (e.type === 'shake' && e.amt > had.amt)) events.set(e.type, e);
    },

    forwardEffect(d) { if (fx.length < 400) fx.push(d); },

    // Called every pump with the links to send to (player id -> link). A
    // snapshot goes out every second sim tick (30 a second), or as a slow
    // heartbeat while nothing ticks (paused). It is stamped with the moment
    // its last tick stands for, `acc` seconds ago, so guests can space them
    // out evenly. Returns 1 when a snapshot went out, -1 when one had to be
    // dropped for a guest because its connection is backed up.
    send(links, s, now, acc, paused) {
      if (!links.size || (ticks < 2 && now - lastSent < 100)) return 0;
      lastSent = now;
      ticks = 0;
      const at = now - acc * 1000;
      const acks = s.players.map((p) => guests.get(p.id)?.ack || 0);
      const snap = makeSnapshot(s, ++snapSeq, at, paused, acks);
      const msg = effectsMessage(fx, [...events.values()], at);
      fx = [];
      events.clear();
      let dropped = false;
      for (const link of links.values()) {
        if (link.congested) dropped = true;
        else link.sendFast(snap);
        if (msg) link.send(msg);
      }
      return dropped ? -1 : 1;
    },
  };
}
