// The guest's side of an online game: its own 60 Hz ticks, each sampling the
// keys into a numbered input for the host and moving our cat straight away
// (predict.js), plus the pings that measure the connection.
import { MAPS } from './data.js';
import { newestFrame } from './snapshot.js';
import { encodeInputs } from './schema.js';
import { createPredictor, predictTick, reconcile, unacked, showPrediction } from './predict.js';

const DT = 1 / 60;

// sample(): this tick's keys (taps included, then forgotten). dropTaps():
// forget taps without using them.
export function createGuestLink({ sample, dropTaps }) {
  const pred = createPredictor();
  let acc = 0, unsent = 0, lastKeys = '', lastPing = 0;

  return {
    pred,

    update(net, s, elapsed, now) {
      const fr = newestFrame(s);
      if (!fr) return;
      const g = fr.game, m = MAPS[g.map];
      const canMove = g.phase !== 'pick' && !g.over && !g.won && !fr.paused;
      if (fr.seq !== pred.baseSeq) {
        pred.baseSeq = fr.seq;
        const me = fr.byId.players.get(1);
        if (me) reconcile(pred, m, me.snap, fr.ack, canMove);
      }
      acc = Math.min(acc + elapsed, 0.25);
      let changed = false;
      while (acc >= DT) {
        acc -= DT;
        if (fr.paused) { dropTaps(); continue; } // the host takes no inputs while paused
        const k = sample();
        const key = JSON.stringify(k);
        if (key !== lastKeys) { lastKeys = key; changed = true; }
        predictTick(pred, m, k, canMove);
        unsent++;
      }
      // New keys go out at once; otherwise every other tick is plenty, since
      // each message repeats everything the host hasn't confirmed yet.
      if (unsent && (changed || unsent >= 2) && !net.congested) {
        net.sendFast(encodeInputs(unacked(pred).slice(-120)));
        unsent = 0;
      }
      if (now - lastPing > 2000) { lastPing = now; net.send({ t: 'ping', at: now }); }
    },

    // Draw our cat where we've predicted it, between our last two ticks.
    show(s, frameDt) { showPrediction(pred, s.players[1], acc / DT, frameDt); },
  };
}
