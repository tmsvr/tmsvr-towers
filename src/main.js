// Input, game loop, menus/lobby, and glue between sim, renderer, audio and network.
//
// Modes:  menu | local | hostWait | host | joinInput | joining | guest
//   local     – this browser runs the game for 1 or 2 players on one keyboard
//   host      – this browser runs the game; player 2's inputs arrive over the network
//   guest     – this browser only sends inputs and draws snapshots from the host
import { createState, step, updateFx } from './sim.js';
import { render, VIEW_W, VIEW_H } from './render.js';
import { initAudio, play, toggleMute } from './audio.js';
import { hostGame, joinGame } from './net.js';
import { makeSnapshot, applySnapshot, interpolate, newGuestState } from './snapshot.js';
import { PLAYER, T, W, H, WORLD_W, WORLD_H, MAP_H } from './data.js';

const canvas = document.getElementById('game');
const lobby = document.getElementById('lobby');
const dpr = Math.min(2, window.devicePixelRatio || 1);
canvas.width = VIEW_W * dpr;
canvas.height = VIEW_H * dpr;
const ctx = canvas.getContext('2d');
ctx.scale(dpr, dpr);

const KEYS = [
  { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', atk: 'KeyF', bomb: 'KeyG', build: 'KeyE', cycle: 'KeyQ' },
  { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', atk: 'Comma', bomb: 'Period', build: 'Slash', cycle: 'KeyM' },
];
const DEFAULT_LABELS = { Comma: ',', Period: '.', Slash: '/', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
const KEY_TO_CODE = { '/': 'Slash', ',': 'Comma', '.': 'Period' };

const held = new Set();
const pressed = new Set(); // edge-triggered keys, consumed by the next sim tick (or network send)
let mode = 'menu';
let state = null;
let nPlayers = 1;
let net = null;
let roomCode = '';
const ui = {
  cam: { x: 0, y: 0, snap: true },
  paused: false, shake: 0, dpr, keys: KEYS, netLabel: '', disconnected: false,
  // Online, each person plays with the P1 layout on their own keyboard.
  keysFor: (pid) => (mode === 'local' ? KEYS[pid] : KEYS[0]),
  keyLabel: (code) => DEFAULT_LABELS[code] || code.replace(/^Key|^Digit/, ''),
  mode: () => mode,
};

// Keys are bound by physical position; show what is printed on this keyboard layout.
navigator.keyboard?.getLayoutMap?.().then((map) => {
  ui.keyLabel = (code) => (map.get(code) || DEFAULT_LABELS[code] || code.replace(/^Key|^Digit/, '')).toUpperCase();
}).catch(() => {});

// ---- input ------------------------------------------------------------------
function readKeys(k, withArrows) {
  const h = (c) => held.has(c);
  const up = h(k.up) || (withArrows && h('ArrowUp')), down = h(k.down) || (withArrows && h('ArrowDown'));
  const left = h(k.left) || (withArrows && h('ArrowLeft')), right = h(k.right) || (withArrows && h('ArrowRight'));
  return {
    mx: (right ? 1 : 0) - (left ? 1 : 0),
    my: (down ? 1 : 0) - (up ? 1 : 0),
    atk: h(k.atk),
    build: h(k.build),
    buildTap: pressed.has(k.build),
    bomb: pressed.has(k.bomb),
    cycle: pressed.has(k.cycle),
    ready: pressed.has('Enter'),
  };
}

// Player 2's input on the host: held keys are replaced by each message, taps are
// remembered until a sim tick consumes them so none get lost.
const remote = { held: {}, taps: {} };
function resetRemote() { remote.held = {}; remote.taps = {}; }

function collectInputs() {
  if (mode === 'host') return [readKeys(KEYS[0], true), { ...remote.held, ...remote.taps }];
  return Array.from({ length: nPlayers }, (_, i) => readKeys(KEYS[i], nPlayers === 1));
}

addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) {
    if (e.code === 'Escape') backToMenu();
    return;
  }
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Slash', 'Enter', 'Quote'].includes(e.code)) e.preventDefault();
  initAudio(); // browsers only allow audio after a user gesture
  if (e.repeat) return;
  const code = e.code || KEY_TO_CODE[e.key] || '';
  held.add(code);
  pressed.add(code);
  if (code === 'KeyN') toggleMute();
  if (code === 'Escape') { if (mode !== 'menu') backToMenu(); return; }
  if (mode === 'menu') {
    if (code === 'Digit1' || code === 'Numpad1') startLocal(1);
    if (code === 'Digit2' || code === 'Numpad2') startLocal(2);
    if (code === 'Digit3' || code === 'Numpad3') startHost();
    if (code === 'Digit4' || code === 'Numpad4') showJoin();
    return;
  }
  if (code === 'KeyP') {
    if (mode === 'guest') net.send({ t: 'pause' });
    else if (mode === 'local' || mode === 'host') ui.paused = !ui.paused;
  }
  if (code === 'KeyR' && state && (state.over || state.won)) {
    if (mode === 'guest') net.send({ t: 'restart' });
    else if (mode === 'local' || mode === 'host') newGame();
  }
});
addEventListener('keyup', (e) => held.delete(e.code || KEY_TO_CODE[e.key] || ''));
addEventListener('blur', () => held.clear());
addEventListener('pointerdown', initAudio);

// ---- modes ------------------------------------------------------------------
let lastLoadouts = [];
function newGame() {
  if (state && state.players) lastLoadouts = state.players.map((p) => p.loadout || p.pick.chosen);
  state = createState(nPlayers, (Math.random() * 1e9) | 0, { sharedScreen: mode === 'local' && nPlayers > 1, loadouts: lastLoadouts });
  ui.cam.snap = true;
  ui.paused = false;
  play('wave');
}

function startLocal(n) { mode = 'local'; nPlayers = n; newGame(); }

function backToMenu() {
  if (net) net.close();
  net = null;
  mode = 'menu';
  state = null;
  ui.paused = false;
  ui.netLabel = '';
  ui.disconnected = false;
  hideLobby();
  canvas.focus();
}

function showLobby(html) { lobby.innerHTML = html; lobby.hidden = false; }
function hideLobby() { lobby.hidden = true; lobby.innerHTML = ''; }
const isLocalhost = ['localhost', '127.0.0.1', '[::1]', ''].includes(location.hostname) || location.protocol === 'file:';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function startHost() {
  mode = 'hostWait';
  resetRemote();
  showLobby('<h2>Host an online game</h2><p>Getting a room code…</p><p class="hint">Esc to cancel</p>');
  net = hostGame({
    onOpen: (code) => {
      roomCode = code;
      const link = `${location.origin}${location.pathname}?join=${code}`;
      const share = isLocalhost
        ? '<p class="hint">Your friend needs their own copy of the game (or put it online, e.g. GitHub Pages), then presses <b>4</b> and enters the code.</p>'
        : `<p><button id="copy">Copy invite link</button></p><p class="hint">…or they open the game, press <b>4</b> and enter the code.</p>`;
      showLobby(`<h2>Waiting for player 2…</h2><p>Room code</p><div class="code">${code}</div>${share}<p class="hint">Esc to cancel</p>`);
      const btn = document.getElementById('copy');
      if (btn) btn.onclick = () => navigator.clipboard.writeText(link).then(() => { btn.textContent = 'Copied!'; });
    },
    onConnect: () => {
      hideLobby();
      resetRemote();
      ui.netLabel = `Online · room ${roomCode} · P2 connected`;
      if (mode === 'hostWait') { mode = 'host'; nPlayers = 2; newGame(); }
      play('grown');
    },
    onData: onGuestMessage,
    onClose: () => { resetRemote(); ui.netLabel = `P2 disconnected — they can rejoin with code ${roomCode}`; play('leak'); },
    onError: (msg) => showLobby(`<h2>Couldn't host</h2><p>${esc(msg)}</p><p class="hint">Esc to go back</p>`),
  });
}

function onGuestMessage(m) {
  if (m.t === 'in') {
    remote.held = { mx: m.mx, my: m.my, atk: m.atk, build: m.build };
    for (const k of ['bomb', 'cycle', 'buildTap', 'ready']) if (m[k]) remote.taps[k] = true;
  } else if (m.t === 'pause') ui.paused = !ui.paused;
  else if (m.t === 'restart' && state && (state.over || state.won)) newGame();
  else if (m.t === 'ping') net.send({ t: 'pong', at: m.at });
}

function showJoin(prefill = '') {
  mode = 'joinInput';
  showLobby(`<h2>Join an online game</h2><p>Enter the host's room code</p>
    <form id="joinform"><input id="code" maxlength="4" autocomplete="off" spellcheck="false" value="${esc(prefill)}" placeholder="ABCD"><button>Join</button></form>
    <p class="hint">Esc to cancel</p>`);
  const input = document.getElementById('code');
  input.focus();
  input.oninput = () => { input.value = input.value.toUpperCase().replace(/[^A-Z]/g, ''); };
  document.getElementById('joinform').onsubmit = (ev) => {
    ev.preventDefault();
    initAudio();
    if (input.value.length === 4) startJoin(input.value);
  };
}

let pred = null;      // guest's locally predicted cat position
let lastPing = 0;
function startJoin(code) {
  mode = 'joining';
  pred = null;
  showLobby(`<h2>Joining room ${esc(code)}…</h2><p>Connecting</p><p class="hint">Esc to cancel</p>`);
  net = joinGame(code, {
    onOpen: () => showLobby(`<h2>Connected!</h2><p>Waiting for the host to start…</p><p class="hint">Esc to leave</p>`),
    onData: (m) => {
      if (m.t === 'snap') {
        if (mode !== 'guest') { mode = 'guest'; nPlayers = 2; state = newGuestState(); ui.cam.snap = true; hideLobby(); canvas.focus(); }
        applySnapshot(state, m, performance.now());
        ui.paused = state.paused;
      } else if (m.t === 'pong') {
        ui.netLabel = `Online · room ${code} · ${Math.round(performance.now() - m.at)} ms`;
      }
    },
    onClose: () => { ui.disconnected = true; ui.netLabel = ''; },
    onError: (msg) => showLobby(`<h2>Couldn't join</h2><p>${esc(msg)}</p><p class="hint">Esc to go back</p>`),
  });
  ui.netLabel = `Online · room ${code}`;
}

// ---- loop -------------------------------------------------------------------
const DT = 1 / 60;
let last = performance.now();
let acc = 0;
let lastSnap = 0;
let lastSend = 0;
const outbox = [];

function playEvents(events, forward) {
  for (const e of events) {
    if (e.type === 'shake') ui.shake = Math.max(ui.shake, e.amt);
    else play(e.type);
    if (forward && outbox.length < 60) outbox.push(e);
  }
  events.length = 0;
}

// Runs from requestAnimationFrame and from a timer, so a host that switches to
// another window keeps the game going for their friend.
function pump() {
  const now = performance.now();
  const elapsed = Math.min(1, (now - last) / 1000);
  last = now;
  if (mode === 'local' || mode === 'host') {
    if (!ui.paused) {
      acc += mode === 'host' ? elapsed : Math.min(elapsed, 0.1);
      let n = 0;
      while (acc >= DT && n++ < 90) {
        step(state, collectInputs(), DT);
        pressed.clear(); // edge inputs apply to exactly one tick
        remote.taps = {};
        acc -= DT;
      }
    } else { acc = 0; pressed.clear(); }
    playEvents(state.events, mode === 'host');
    if (mode === 'host' && net.connected && now - lastSnap >= 33) {
      lastSnap = now;
      net.send(makeSnapshot(state, outbox.splice(0), ui.paused));
    }
  } else if (mode === 'guest') {
    updateFx(state, elapsed);
    playEvents(state.events, false);
    const k = readKeys(KEYS[0], true);
    if (now - lastSend >= 16 || pressed.size) {
      lastSend = now;
      net.send({ t: 'in', ...k });
      pressed.clear();
    }
    if (now - lastPing > 2000) { lastPing = now; net.send({ t: 'ping', at: now }); }
    predictOwnCat(k, elapsed);
  } else {
    pressed.clear();
  }
  ui.shake = Math.max(0, ui.shake - elapsed * 30);
}

// Move the guest's own cat immediately instead of waiting a round trip, then
// gently pull it towards where the host says it is.
let predDir = 0, predMoving = false;
function predictOwnCat(k, dt) {
  const me = state.players[1];
  if (!me) return;
  if (!pred) pred = { x: me.nx, y: me.ny };
  const l = me.stun > 0 || state.phase === 'pick' ? 0 : Math.hypot(k.mx, k.my);
  predMoving = l > 0;
  if (l > 0 && !state.paused && !state.over && !state.won) {
    pred.x = Math.max(14, Math.min(W * T - 14, pred.x + (k.mx / l) * PLAYER.speed * dt));
    pred.y = Math.max(14, Math.min(H * T - 14, pred.y + (k.my / l) * PLAYER.speed * dt));
    predDir = Math.atan2(k.my, k.mx);
  }
  const dx = me.nx - pred.x, dy = me.ny - pred.y, d = Math.hypot(dx, dy);
  if (d > T * 1.5) { pred.x = me.nx; pred.y = me.ny; }
  else { const f = Math.min(1, dt * (l > 0 ? 2 : 8)); pred.x += dx * f; pred.y += dy * f; }
}

// The camera follows your own cat (online) or both cats (same screen).
let lastFrame = performance.now();
function updateCamera(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  const s = mode === 'guest' || mode === 'local' || mode === 'host' ? state : null;
  const ids = mode === 'guest' ? [1] : mode === 'host' ? [0] : s ? s.players.map((p) => p.id) : [];
  const ps = s ? s.players.filter((p) => ids.includes(p.id)) : [];
  const tx = ps.length ? ps.reduce((a, p) => a + p.x, 0) / ps.length - VIEW_W / 2 : 0;
  const ty = ps.length ? ps.reduce((a, p) => a + p.y, 0) / ps.length - MAP_H / 2 : (WORLD_H - MAP_H) / 2;
  const cx = Math.max(0, Math.min(WORLD_W - VIEW_W, tx)), cy = Math.max(0, Math.min(WORLD_H - MAP_H, ty));
  if (ui.cam.snap) { ui.cam.x = cx; ui.cam.y = cy; ui.cam.snap = !ps.length; }
  const k = Math.min(1, dt * 7);
  ui.cam.x += (cx - ui.cam.x) * k;
  ui.cam.y += (cy - ui.cam.y) * k;
}

function frame(now) {
  pump();
  if (mode === 'guest') {
    interpolate(state, now);
    const me = state.players[1];
    if (me && pred) { me.x = pred.x; me.y = pred.y; me.moving = predMoving; if (predMoving) me.dir = predDir; }
  }
  updateCamera(now);
  render(ctx, mode === 'guest' || mode === 'local' || mode === 'host' ? state : null, ui);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
setInterval(() => { if (document.hidden) pump(); }, 50);

// Invite links: ?join=ABCD opens the join screen with the code filled in.
const invite = new URLSearchParams(location.search).get('join');
if (invite) showJoin(invite.toUpperCase().slice(0, 4));

// Debug hooks for automated play-testing.
window.__game = { get state() { return state; }, get mode() { return mode; }, startLocal, held, pressed };
