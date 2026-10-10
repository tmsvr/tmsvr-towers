// Procedural sound effects and background music via WebAudio. No asset files.
let ctx = null, master, sfxBus, musicBus, noiseBuf;
let drumBus, dangerBus; // music layers that fade in with the action
let muted = false;
const lastPlayed = {};

export function initAudio() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  master = ctx.createGain(); master.gain.value = 0.7; master.connect(ctx.destination);
  const comp = ctx.createDynamicsCompressor(); comp.connect(master);
  sfxBus = ctx.createGain(); sfxBus.gain.value = 0.9; sfxBus.connect(comp);
  musicBus = ctx.createGain(); musicBus.gain.value = 0.22; musicBus.connect(comp);
  drumBus = ctx.createGain(); drumBus.gain.value = 0; drumBus.connect(musicBus);
  dangerBus = ctx.createGain(); dangerBus.gain.value = 0; dangerBus.connect(musicBus);
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  startMusic();
}

export function toggleMute() {
  muted = !muted;
  if (master) master.gain.setTargetAtTime(muted ? 0 : 0.7, ctx.currentTime, 0.05);
  return muted;
}
export const isMuted = () => muted;

function tone({ type = 'sine', f = 440, f2, dur = 0.1, vol = 0.2, attack = 0.005, delay = 0, dest = sfxBus }) {
  const t = ctx.currentTime + delay;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(dest);
  o.start(t); o.stop(t + dur + 0.05);
}

function noise({ dur = 0.2, vol = 0.2, type = 'lowpass', f = 1000, f2, q = 1, delay = 0, dest = sfxBus }) {
  const t = ctx.currentTime + delay;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const flt = ctx.createBiquadFilter();
  flt.type = type; flt.Q.value = q;
  flt.frequency.setValueAtTime(f, t);
  if (f2) flt.frequency.exponentialRampToValueAtTime(f2, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(flt).connect(g).connect(dest);
  src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.05);
}

const arp = (notes, step, opts) => notes.forEach((f, i) => tone({ f, delay: i * step, ...opts }));

const SOUNDS = {
  swing: () => noise({ type: 'bandpass', f: 900, f2: 3500, q: 2, dur: 0.12, vol: 0.25 }),
  hit: () => { noise({ type: 'bandpass', f: 1200, f2: 3000, q: 2, dur: 0.1, vol: 0.2 }); tone({ type: 'square', f: 220, f2: 70, dur: 0.1, vol: 0.12 }); },
  throw: () => tone({ type: 'triangle', f: 500, f2: 900, dur: 0.18, vol: 0.12 }),
  explode: () => { noise({ f: 1200, f2: 80, dur: 0.6, vol: 0.7 }); tone({ f: 140, f2: 35, dur: 0.5, vol: 0.6 }); },
  pickup: () => arp([784, 988, 1319], 0.05, { type: 'triangle', dur: 0.14, vol: 0.1 }),
  powerup: () => { arp([523, 784, 1047, 1568], 0.05, { type: 'triangle', dur: 0.2, vol: 0.12 }); noise({ type: 'bandpass', f: 3000, q: 2, dur: 0.25, vol: 0.06 }); },
  freeze: () => { noise({ type: 'bandpass', f: 5000, f2: 1500, q: 1.5, dur: 0.5, vol: 0.12 }); arp([1568, 1319, 1047], 0.06, { type: 'sine', dur: 0.2, vol: 0.08 }); },
  elite: () => { tone({ type: 'sawtooth', f: 180, f2: 260, dur: 0.25, vol: 0.08 }); tone({ type: 'triangle', f: 720, dur: 0.12, vol: 0.06, delay: 0.2 }); },
  bombReady: () => arp([660, 880], 0.07, { type: 'triangle', dur: 0.12, vol: 0.08 }),
  coin: () => { tone({ type: 'square', f: 988, dur: 0.06, vol: 0.06 }); tone({ type: 'square', f: 1319, dur: 0.14, vol: 0.06, delay: 0.06 }); },
  bigCoin: () => { tone({ type: 'triangle', f: 330, f2: 520, dur: 0.08, vol: 0.18 }); tone({ type: 'triangle', f: 520, f2: 780, dur: 0.12, vol: 0.15, delay: 0.07 }); },
  plant: () => { noise({ f: 600, dur: 0.12, vol: 0.15 }); tone({ f: 300, f2: 600, dur: 0.18, vol: 0.12, delay: 0.05 }); },
  grown: () => arp([523, 659, 784, 1047], 0.06, { type: 'triangle', dur: 0.18, vol: 0.1 }),
  cycle: () => tone({ type: 'sine', f: 700, dur: 0.05, vol: 0.06 }),
  deny: () => { tone({ type: 'square', f: 160, dur: 0.09, vol: 0.06 }); tone({ type: 'square', f: 120, dur: 0.12, vol: 0.06, delay: 0.09 }); },
  shoot_daisy: () => tone({ f: 1400, f2: 700, dur: 0.06, vol: 0.04 }),
  shoot_sunflower: () => { tone({ type: 'sawtooth', f: 1800, f2: 300, dur: 0.35, vol: 0.08 }); tone({ type: 'sine', f: 120, f2: 60, dur: 0.3, vol: 0.25 }); noise({ type: 'highpass', f: 3000, dur: 0.15, vol: 0.08 }); },
  shoot_firelily: () => { noise({ type: 'bandpass', f: 600, f2: 2400, q: 1, dur: 0.3, vol: 0.18 }); tone({ type: 'triangle', f: 180, f2: 90, dur: 0.2, vol: 0.1 }); },
  shoot_stink: () => { tone({ f: 160, f2: 420, dur: 0.12, vol: 0.1 }); tone({ f: 220, f2: 520, dur: 0.1, vol: 0.07, delay: 0.08 }); },
  shoot_snap: () => { noise({ type: 'bandpass', f: 900, q: 2, dur: 0.08, vol: 0.2 }); tone({ type: 'square', f: 220, f2: 90, dur: 0.12, vol: 0.1, delay: 0.05 }); },
  catStun: () => { tone({ type: 'square', f: 600, f2: 200, dur: 0.25, vol: 0.1 }); arp([1200, 1000, 1200], 0.08, { type: 'sine', dur: 0.1, vol: 0.06, delay: 0.2 }); },
  splash: () => { noise({ f: 500, f2: 150, dur: 0.35, vol: 0.14 }); tone({ f: 140, f2: 90, dur: 0.25, vol: 0.06 }); },
  shoot_frost: () => { tone({ f: 1760, f2: 1500, dur: 0.25, vol: 0.03 }); tone({ f: 2350, dur: 0.18, vol: 0.02, delay: 0.04 }); },
  shoot_thorn: () => noise({ type: 'highpass', f: 2500, dur: 0.07, vol: 0.08 }),
  die: () => tone({ type: 'square', f: 520, f2: 140, dur: 0.1, vol: 0.05 }),
  bossDie: () => { noise({ f: 1500, f2: 60, dur: 1.0, vol: 0.6 }); arp([392, 523, 659, 784, 1047], 0.08, { type: 'triangle', dur: 0.25, vol: 0.12 }); },
  leak: () => { tone({ type: 'sawtooth', f: 330, f2: 110, dur: 0.35, vol: 0.1 }); },
  wave: () => { tone({ type: 'sawtooth', f: 392, dur: 0.18, vol: 0.07 }); tone({ type: 'sawtooth', f: 523, dur: 0.35, vol: 0.07, delay: 0.18 }); },
  boss: () => { for (let i = 0; i < 3; i++) tone({ type: 'sawtooth', f: 110, f2: 82, dur: 0.5, vol: 0.12, delay: i * 0.55 }); },
  clear: () => arp([523, 659, 784, 659, 1047], 0.09, { type: 'triangle', dur: 0.2, vol: 0.1 }),
  pour: () => tone({ type: 'square', f: 1250 + Math.random() * 400, dur: 0.035, vol: 0.035 }),
  healed: () => arp([660, 880, 1320], 0.06, { type: 'sine', dur: 0.15, vol: 0.09 }),
  wilt: () => { tone({ type: 'triangle', f: 520, f2: 140, dur: 0.6, vol: 0.14 }); noise({ f: 500, f2: 150, dur: 0.4, vol: 0.12 }); },
  split: () => { tone({ f: 260, f2: 900, dur: 0.1, vol: 0.12 }); tone({ f: 380, f2: 1200, dur: 0.1, vol: 0.1, delay: 0.06 }); },
  spawn: () => tone({ f: 200, f2: 520, dur: 0.16, vol: 0.06 }),
  burrow: () => noise({ f: 450, f2: 150, dur: 0.3, vol: 0.18 }),
  dash: () => noise({ type: 'bandpass', f: 2400, f2: 500, q: 1.5, dur: 0.22, vol: 0.1 }),
  chomp: () => { noise({ type: 'bandpass', f: 1600, q: 3, dur: 0.05, vol: 0.12 }); noise({ type: 'bandpass', f: 1300, q: 3, dur: 0.05, vol: 0.1, delay: 0.09 }); },
  dig: () => noise({ type: 'bandpass', f: 500 + Math.random() * 300, q: 1.5, dur: 0.08, vol: 0.12 }),
  uproot: () => { noise({ f: 900, f2: 200, dur: 0.3, vol: 0.2 }); tone({ type: 'triangle', f: 700, f2: 300, dur: 0.2, vol: 0.1 }); tone({ type: 'square', f: 988, dur: 0.06, vol: 0.05, delay: 0.2 }); },
  win: () => arp([523, 523, 784, 784, 880, 1047, 1319], 0.14, { type: 'triangle', dur: 0.3, vol: 0.13 }),
  lose: () => arp([440, 392, 349, 262], 0.25, { type: 'triangle', dur: 0.4, vol: 0.13 }),
};

// Minimum seconds between repeats, so a dozen flowers don't deafen anyone.
const LIMIT = { shoot_daisy: 0.07, shoot_frost: 0.2, shoot_thorn: 0.1, shoot_sunflower: 0.15, shoot_firelily: 0.12, shoot_stink: 0.15, splash: 0.08, die: 0.05, coin: 0.05, hit: 0.04,
  pour: 0.09, dig: 0.16, chomp: 0.4, burrow: 0.15, dash: 0.15, spawn: 0.25, split: 0.08, deny: 0.3 };

export function play(name) {
  if (!ctx || muted || !SOUNDS[name]) return;
  const now = ctx.currentTime;
  if (now - (lastPlayed[name] || 0) < (LIMIT[name] ?? 0.02)) return;
  lastPlayed[name] = now;
  SOUNDS[name]();
}

// ---- Music: a gentle looping I–vi–IV–V tune --------------------------------
// Three layers share one clock: the tune always plays, drums fade in while a
// wave is running, and a tense bass + counter-melody fades in when the cottage
// is being chomped or a boss is on the field.
const BPM = 104;
const STEP = 60 / BPM / 2; // eighth notes
const CHORDS = [[60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62]]; // C Am F G
const MELODY = [
  [72, null, 76, 74, 72, null, 67, null], [69, null, 72, null, 76, 74, 72, null],
  [69, null, 72, 77, 76, null, 72, null], [74, null, 71, null, 67, 69, 71, null],
  [72, 74, 76, null, 79, null, 76, 74], [72, null, 69, null, 72, null, 76, null],
  [77, null, 76, 74, 72, null, 69, null], [71, null, 74, null, 72, null, null, null],
];
const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
let musicStep = 0, nextTime = 0;

let mood = { drums: 0, danger: 0 };
export function setMusicMood(drums, danger) {
  if (!ctx || (drums === mood.drums && danger === mood.danger)) return;
  mood = { drums, danger };
  drumBus.gain.setTargetAtTime(drums, ctx.currentTime, 0.8);
  dangerBus.gain.setTargetAtTime(danger, ctx.currentTime, danger > 0 ? 0.3 : 1.5);
}

function startMusic() {
  nextTime = ctx.currentTime + 0.2;
  setInterval(scheduleMusic, 50);
}

function scheduleMusic() {
  if (!ctx || ctx.state !== 'running') return;
  while (nextTime < ctx.currentTime + 0.2) {
    const bar = Math.floor(musicStep / 8) % 8;
    const beat = musicStep % 8;
    const chord = CHORDS[bar % 4];
    const at = nextTime - ctx.currentTime;
    if (beat === 0 || beat === 4) tone({ type: 'triangle', f: midi(chord[0] - 24), dur: STEP * 3.5, vol: 0.35, attack: 0.01, delay: at, dest: musicBus });
    if (beat % 2 === 1) chord.forEach((n) => tone({ type: 'sine', f: midi(n), dur: STEP * 0.8, vol: 0.06, delay: at, dest: musicBus }));
    const m = MELODY[bar][beat];
    if (m) tone({ type: 'triangle', f: midi(m), dur: STEP * 1.6, vol: 0.13, attack: 0.01, delay: at, dest: musicBus });
    // drums (silent unless the layer is faded in)
    if (mood.drums > 0.01) {
      if (beat === 0 || beat === 4 || (bar % 2 && beat === 7)) tone({ f: 120, f2: 45, dur: 0.18, vol: 0.5, attack: 0.002, delay: at, dest: drumBus });
      if (beat === 2 || beat === 6) noise({ type: 'bandpass', f: 1800, q: 0.8, dur: 0.12, vol: 0.22, delay: at, dest: drumBus });
      noise({ type: 'highpass', f: 7000, dur: beat % 2 ? 0.03 : 0.05, vol: beat % 2 ? 0.05 : 0.09, delay: at, dest: drumBus });
    }
    // danger: driving eighth-note bass and a high counter-line on the minor third
    if (mood.danger > 0.01) {
      tone({ type: 'sawtooth', f: midi(chord[0] - 24), dur: STEP * 0.7, vol: 0.12, attack: 0.004, delay: at, dest: dangerBus });
      if (beat % 4 === 0) tone({ type: 'square', f: midi(chord[0] + 15 + (beat === 4 ? 2 : 0)), dur: STEP * 1.8, vol: 0.05, attack: 0.01, delay: at, dest: dangerBus });
    }
    nextTime += STEP;
    musicStep++;
  }
}
