// Extra game feel ("juice"): floating damage numbers, squash on hits, pops when
// monsters die, confetti, a bouncing coin counter and a brief freeze on big
// moments. It is purely presentational: it watches the state and events and
// never changes the game. J toggles it in game; balance.json → "juice" sets
// the default and switches single effects off.
import { BALANCE } from './data.js';

const CFG = {
  enabled: true, damageNumbers: true, squash: true, deathPops: true, confetti: true, coinBounce: true, hitStop: true,
  ...(BALANCE.juice || {}),
};
const FONT = '"Fredoka", system-ui, -apple-system, sans-serif';
let on = CFG.enabled;
const want = (k) => on && CFG[k];

const seen = new Map(); // enemy id -> { hp, x, y, r, squash, pending, pendingT }
let nums = [], pops = [], confetti = [], coinT = [], lastCoins = [];
let stop = 0, last = 0, lastState = null, toast = null;

function reset() {
  seen.clear();
  nums = []; pops = []; confetti = []; coinT = []; lastCoins = [];
  stop = 0;
}

export function toggleJuice() {
  on = !on;
  reset();
  toast = { txt: on ? 'Effects on' : 'Effects off', t: 1.5 };
  return on;
}

// Called by the game loop for every sound/shake event.
export function juiceEvent(e) {
  if (!on) return;
  if (e.type === 'explode' && CFG.hitStop) stop = Math.max(stop, 0.06);
  if (e.type === 'bossDie') {
    if (CFG.hitStop) stop = Math.max(stop, 0.3);
    if (CFG.confetti) burst(70);
  }
  if (e.type === 'clear' && CFG.confetti) burst(90);
  if (e.type === 'win' && CFG.confetti) burst(220);
}

// The game loop asks this before stepping the simulation; true = skip this frame.
export function hitStopping(dt) {
  if (stop <= 0) return false;
  stop -= dt;
  return true;
}

function burst(n) {
  const cols = ['#ff6a5a', '#ffd23f', '#6be06b', '#5ab4ff', '#ff8fd0', '#ffffff'];
  for (let i = 0; i < n; i++) {
    confetti.push({
      x: Math.random() * 1008, y: -10 - Math.random() * 120, vx: (Math.random() - 0.5) * 120, vy: 80 + Math.random() * 140,
      rot: Math.random() * 6, vr: (Math.random() - 0.5) * 12, w: 5 + Math.random() * 5, col: cols[i % cols.length], t: 0,
    });
  }
}

// Compare this frame's state with the last one to find hits, deaths and income.
export function observeJuice(s) {
  const now = performance.now() / 1000;
  const dt = Math.min(0.1, now - (last || now));
  last = now;
  if (s !== lastState) { reset(); lastState = s; }
  if (!on) return;
  const alive = new Set();
  for (const e of s.enemies) {
    alive.add(e.id);
    const rec = seen.get(e.id);
    if (!rec) { seen.set(e.id, { hp: e.hp, x: e.x, y: e.y, r: e.def.r, squash: 0, pending: 0, pendingT: 0 }); continue; }
    if (e.hp < rec.hp - 0.01) {
      rec.pending += rec.hp - e.hp;
      rec.squash = 0.14;
    }
    Object.assign(rec, { hp: e.hp, x: e.x, y: e.y });
    rec.squash = Math.max(0, rec.squash - dt);
    // add up rapid small hits (poison ticks, daisy seeds) into one number
    if (rec.pending > 0) rec.pendingT += dt;
    if (rec.pending >= 30 || rec.pendingT > 0.3) flush(rec);
  }
  for (const [id, rec] of seen) {
    if (alive.has(id)) continue;
    flush(rec);
    if (CFG.deathPops) pops.push({ x: rec.x, y: rec.y, r: rec.r, t: 0 });
    seen.delete(id);
  }
  s.players.forEach((p, i) => {
    if (lastCoins[i] !== undefined && p.coins > lastCoins[i] + 0.5) coinT[i] = 0.3;
    lastCoins[i] = p.coins;
    coinT[i] = Math.max(0, (coinT[i] || 0) - dt);
  });
  for (const n of nums) { n.t += dt; n.y -= 34 * dt; }
  nums = nums.filter((n) => n.t < 0.8);
  for (const p of pops) p.t += dt;
  pops = pops.filter((p) => p.t < 0.3);
  for (const k of confetti) { k.t += dt; k.x += k.vx * dt; k.y += k.vy * dt; k.vx *= 0.99; k.rot += k.vr * dt; }
  confetti = confetti.filter((k) => k.y < 760 && k.t < 6);
  if (toast) { toast.t -= dt; if (toast.t <= 0) toast = null; }
}

function flush(rec) {
  if (rec.pending >= 1 && CFG.damageNumbers) {
    nums.push({ x: rec.x + (Math.random() - 0.5) * rec.r, y: rec.y - rec.r - 6, txt: `${Math.round(rec.pending)}`, big: rec.pending >= 40, t: 0 });
  }
  rec.pending = 0; rec.pendingT = 0;
}

// 0..1 how squashed an enemy should look right after being hit.
export function hitSquash(id) {
  if (!want('squash')) return 0;
  const rec = seen.get(id);
  return rec ? rec.squash / 0.14 : 0;
}

// 0..1 stretch of a cat mid-swing.
export function swingSquash(p) {
  return want('squash') && p.swingT > 0 ? Math.sin((1 - p.swingT / 0.18) * Math.PI) : 0;
}

// Scale for a player's coin counter in the HUD.
export function coinScale(i) {
  return want('coinBounce') && coinT[i] > 0 ? 1 + 0.35 * Math.sin((coinT[i] / 0.3) * Math.PI) : 1;
}

function text(c, txt, x, y, size, col) {
  c.font = `700 ${size}px ${FONT}`;
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.lineWidth = 3.5; c.strokeStyle = 'rgba(0,0,0,0.7)'; c.lineJoin = 'round';
  c.strokeText(txt, x, y); c.fillStyle = col; c.fillText(txt, x, y);
}

// Drawn inside the camera transform.
export function drawJuiceWorld(c) {
  if (!on) return;
  for (const p of pops) {
    const k = p.t / 0.3;
    c.beginPath(); c.arc(p.x, p.y, p.r * (0.8 + k * 1.2), 0, Math.PI * 2);
    c.strokeStyle = `rgba(255,255,255,${0.8 * (1 - k)})`; c.lineWidth = 4 * (1 - k) + 1; c.stroke();
    for (let i = 0; i < 6; i++) {
      const a = i * 1.047 + p.r;
      c.beginPath(); c.arc(p.x + Math.cos(a) * p.r * (1 + k * 1.6), p.y + Math.sin(a) * p.r * (1 + k * 1.6), 3 * (1 - k), 0, Math.PI * 2);
      c.fillStyle = '#fff4c2'; c.fill();
    }
  }
  for (const n of nums) {
    c.globalAlpha = Math.min(1, (0.8 - n.t) * 4);
    const pop = 1 + Math.max(0, 0.12 - n.t) * 4;
    text(c, n.txt, n.x, n.y, (n.big ? 20 : 13) * pop, n.big ? '#ffd23f' : '#ffffff');
  }
  c.globalAlpha = 1;
}

// Drawn in screen space, over the HUD.
export function drawJuiceScreen(c) {
  for (const k of confetti) {
    c.save(); c.translate(k.x, k.y); c.rotate(k.rot);
    c.fillStyle = k.col; c.fillRect(-k.w / 2, -k.w / 4, k.w, k.w / 2 * (0.4 + Math.abs(Math.sin(k.t * 8))));
    c.restore();
  }
  if (toast) {
    c.globalAlpha = Math.min(1, toast.t * 3);
    text(c, toast.txt, 504, 70, 20, '#ffffff');
    c.globalAlpha = 1;
  }
}
