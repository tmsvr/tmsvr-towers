// The host's side of an online game: taking the guest's inputs one per sim
// tick, and sending snapshots, sounds and effects back.
import { makeSnapshot, effectsMessage } from './snapshot.js';

const TAPS = ['bomb', 'cycle', 'buildTap', 'ready', 'use'];

export function createHostLink() {
  // The guest's inputs. It numbers them, one per guest tick, and resends the
  // ones we haven't confirmed; we apply exactly one per sim tick and report
  // the last in each snapshot (see predict.js for why).
  let queue = [], last = {}, seq = 0, ack = 0;
  // Sound events and effect descriptions waiting for the next snapshot.
  // Repeats of an event in one snapshot are merged (sounds are rate-limited
  // anyway), so a crowd chewing the cottage can't crowd out the boss kill.
  const events = new Map();
  let fx = [];
  let ticks = 0, lastSent = 0, snapSeq = 0;

  return {
    // A guest (re)connected: forget the last one's inputs and anything queued.
    reset() {
      queue = []; last = {}; seq = 0; ack = 0;
      events.clear(); fx = [];
    },

    receiveInputs(list) {
      for (const inp of list) {
        if (inp.seq <= seq) continue; // already have it
        seq = inp.seq;
        queue.push(inp);
      }
    },

    // The guest's input for this sim tick.
    nextInput() {
      if (queue.length > 8) { // a burst arrived or we fell behind: skip ahead, keeping any taps
        const skipped = queue.splice(0, queue.length - 4);
        for (const k of TAPS) if (skipped.some((i) => i[k])) queue[0][k] = true;
      }
      const inp = queue.shift();
      if (!inp) return { ...last, bomb: false, cycle: false, buildTap: false, ready: false }; // late: assume the same keys are still held
      last = inp;
      ack = inp.seq;
      return inp;
    },

    // Called after every sim tick.
    ticked() { ticks++; },

    forwardEvent(e) {
      const had = events.get(e.type);
      if (!had || (e.type === 'shake' && e.amt > had.amt)) events.set(e.type, e);
    },

    forwardEffect(d) { if (fx.length < 400) fx.push(d); },

    // Called every pump. A snapshot goes out every second sim tick (30 a
    // second), or as a slow heartbeat while nothing ticks (paused). It is
    // stamped with the moment its last tick stands for, `acc` seconds ago, so
    // the guest can space them out evenly.
    send(net, s, now, acc, paused) {
      if (ticks < 2 && now - lastSent < 100) return;
      lastSent = now;
      ticks = 0;
      const at = now - acc * 1000;
      if (!net.congested) net.sendFast(makeSnapshot(s, ++snapSeq, at, paused, ack));
      const msg = effectsMessage(fx, [...events.values()], at);
      fx = [];
      events.clear();
      if (msg) net.send(msg);
    },
  };
}
