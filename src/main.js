// Input, game loop, menus/lobby, and glue between sim, renderer, audio and network.
//
// Modes:  menu | local | hostWait | host | joinInput | joining | guest
//   local     – this browser runs the game for 1 or 2 players on one keyboard
//   host      – this browser runs the game; player 2's inputs arrive over the network (host.js)
//   guest     – this browser only sends inputs and draws snapshots from the host (guest.js)
import { createState, step } from './sim.js';
import { render, VIEW_W, VIEW_H } from './render.js';
import { initAudio, play, toggleMute, setMusicMood } from './audio.js';
import { juiceEvent, hitStopping, toggleJuice } from './juice.js';
import { hostGame, joinGame } from './net.js';
import { applySnapshot, applyEffects, interpolate, newGuestState } from './snapshot.js';
import { decodeFast, PROTOCOL } from './schema.js';
import { createHostLink } from './host.js';
import { createGuestLink } from './guest.js';
import { spawnEffect, spawnTrails, updateEffects, resetEffects } from './fx.js';
import { MAPS, MAP_H, DATA_HASH } from './data.js';

const canvas = document.getElementById('game');
const lobby = document.getElementById('lobby');
const dpr = Math.min(2, window.devicePixelRatio || 1);
canvas.width = VIEW_W * dpr;
canvas.height = VIEW_H * dpr;
const ctx = canvas.getContext('2d');
ctx.scale(dpr, dpr);

const KEYS = [
  { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', atk: 'KeyF', bomb: 'KeyG', build: 'KeyE', cycle: 'KeyQ', sprint: 'ShiftLeft' },
  { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', atk: 'Comma', bomb: 'Period', build: 'Slash', cycle: 'KeyM', sprint: 'ShiftRight' },
];
const DEFAULT_LABELS = { ShiftLeft: 'Shift', ShiftRight: 'R-Shift', Comma: ',', Period: '.', Slash: '/', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
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
  menuMap: MAPS[0], // the map behind the menu: the last one played
  paused: false, shake: 0, dpr, keys: KEYS, netLabel: '', disconnected: false,
  // Online, each person plays with the P1 layout on their own keyboard.
  keysFor: (pid) => (mode === 'local' ? KEYS[pid] : KEYS[0]),
  keyLabel: (code) => DEFAULT_LABELS[code] || code.replace(/^Key|^Digit/, ''),
  mode: () => mode,
};

// Keys are bound by physical position; show what is printed on this keyboard layout.
navigator.keyboard?.getLayoutMap?.().then((map) => {
  ui.keyLabel = (code) => (map.has(code) ? map.get(code).toUpperCase() : DEFAULT_LABELS[code] || code.replace(/^Key|^Digit/, ''));
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
    sprint: h(k.sprint) || (withArrows && h('ShiftRight')),
    build: h(k.build),
    buildTap: pressed.has(k.build),
    bomb: pressed.has(k.bomb),
    cycle: pressed.has(k.cycle),
    ready: pressed.has('Enter'),
  };
}

const host = createHostLink();
let guest = null;

function collectInputs() {
  if (mode === 'host') return [readKeys(KEYS[0], true), host.nextInput()];
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
  if (code === 'KeyJ') toggleJuice();
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
let lastLoadouts = [], lastCats = [];
let lastMap = 0;
function newGame() {
  if (state && state.players) { lastLoadouts = state.players.map((p) => p.loadout || p.pick.chosen); lastCats = state.players.map((p) => p.cat); lastMap = state.map; }
  state = createState(nPlayers, (Math.random() * 1e9) | 0, { sharedScreen: mode === 'local' && nPlayers > 1, loadouts: lastLoadouts, cats: lastCats, map: lastMap });
  ui.cam.snap = true;
  ui.paused = false;
  resetEffects();
  play('wave');
}

function startLocal(n) { mode = 'local'; nPlayers = n; newGame(); }

function backToMenu() {
  if (net) net.close();
  net = null;
  mode = 'menu';
  state = null;
  resetEffects();
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
  host.reset();
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
    // The guest introduces itself first (see onGuestMessage); nothing starts until then.
    onConnect: () => { guestOk = false; },
    onData: (m) => onGuestMessage(m instanceof ArrayBuffer ? decodeFast(m) : m),
    onClose: () => { if (!guestOk) return; guestOk = false; host.reset(); ui.netLabel = `P2 disconnected — they can rejoin with code ${roomCode}`; play('leak'); },
    onError: (msg) => showLobby(`<h2>Couldn't host</h2><p>${esc(msg)}</p><p class="hint">Esc to go back</p>`),
  });
}

// Only a guest running the same game version and data may play.
const VERSION = { protocol: PROTOCOL, data: DATA_HASH };
let guestOk = false;

function welcomeGuest(m) {
  if (m.protocol !== VERSION.protocol || m.data !== VERSION.data) {
    net.send({ t: 'reject', ...VERSION });
    net.kick();
    if (mode === 'hostWait') showLobby(`<h2>Waiting for player 2…</h2><p>Room code</p><div class="code">${roomCode}</div><p>Someone tried to join with a different version of the game. You both need the same files.</p><p class="hint">Esc to cancel</p>`);
    else ui.netLabel = `P2 has a different version of the game — room ${roomCode}`;
    return;
  }
  guestOk = true;
  hideLobby();
  host.reset(); // also drops sounds and effects queued while nobody was connected
  ui.netLabel = `Online · room ${roomCode} · P2 connected`;
  if (mode === 'hostWait') { mode = 'host'; nPlayers = 2; newGame(); }
  play('grown');
}

function onGuestMessage(m) {
  if (!m || typeof m.t !== 'string') return;
  if (m.t === 'hello') { welcomeGuest(m); return; }
  if (!guestOk) return;
  if (m.t === 'in') host.receiveInputs(m.inputs);
  else if (m.t === 'pause') ui.paused = !ui.paused;
  else if (m.t === 'restart' && state && (state.over || state.won)) newGame();
  else if (m.t === 'ping' && Number.isFinite(m.at)) net.send({ t: 'pong', at: m.at });
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

let rejected = false;
function startJoin(code) {
  mode = 'joining';
  rejected = false;
  guest = createGuestLink({
    sample: () => { const k = readKeys(KEYS[0], true); pressed.clear(); return k; },
    dropTaps: () => pressed.clear(),
  });
  showLobby(`<h2>Joining room ${esc(code)}…</h2><p>Connecting</p><p class="hint">Esc to cancel</p>`);
  net = joinGame(code, {
    onOpen: () => {
      net.send({ t: 'hello', ...VERSION });
      showLobby(`<h2>Connected!</h2><p>Waiting for the host to start…</p><p class="hint">Esc to leave</p>`);
    },
    onData: (raw) => {
      const m = raw instanceof ArrayBuffer ? decodeFast(raw) : raw;
      if (!m) return;
      if (m.t === 'snap') {
        if (mode !== 'guest') { mode = 'guest'; nPlayers = 2; state = newGuestState(); resetEffects(); ui.cam.snap = true; hideLobby(); canvas.focus(); }
        applySnapshot(state, m, performance.now());
      } else if (m.t === 'fx') {
        if (mode === 'guest') applyEffects(state, m, performance.now());
      } else if (m.t === 'pong') {
        ui.netLabel = `Online · room ${code} · ${Math.round(performance.now() - m.at)} ms`;
      } else if (m.t === 'reject') {
        rejected = true;
        showLobby(`<h2>Different game versions</h2><p>The host has a different version of the game${m.protocol !== VERSION.protocol ? '' : ' (different balance or maps)'}. You both need the same files.</p><p class="hint">Esc to go back</p>`);
      }
    },
    onClose: () => { if (rejected) return; ui.disconnected = true; ui.netLabel = ''; },
    onError: (msg) => showLobby(`<h2>Couldn't join</h2><p>${esc(msg)}</p><p class="hint">Esc to go back</p>`),
  });
  ui.netLabel = `Online · room ${code}`;
}

// ---- loop -------------------------------------------------------------------
const DT = 1 / 60;
let last = performance.now();
let acc = 0;

// Effect descriptions from the sim go to the effects layer here, and when
// hosting to the guest with the next snapshot.
function drainEffects(s, forward) {
  for (const d of s.fx) {
    spawnEffect(d);
    if (forward) host.forwardEffect(d);
  }
  s.fx.length = 0;
}

function playEvents(events, forward) {
  for (const e of events) {
    if (e.type === 'shake') ui.shake = Math.max(ui.shake, e.amt);
    else play(e.type);
    juiceEvent(e);
    if (forward) host.forwardEvent(e);
  }
  events.length = 0;
}

// Runs from requestAnimationFrame, and from a worker's timer while the tab is
// hidden, so a host that switches to another tab keeps the game going for their friend.
function pump() {
  const now = performance.now();
  const elapsed = Math.min(1, (now - last) / 1000);
  last = now;
  if (mode === 'local' || mode === 'host') {
    // Hit-stop freezes the game for a beat on big hits. Online it would also
    // freeze the guest's world while their own cat kept walking, so only
    // local games get it (the timer still runs down either way).
    const stopped = hitStopping(elapsed) && mode === 'local';
    if (ui.paused) { acc = 0; pressed.clear(); }
    else if (!stopped) {
      acc += mode === 'host' ? elapsed : Math.min(elapsed, 0.1);
      let n = 0;
      while (acc >= DT && n++ < 90) {
        rememberPositions(state);
        step(state, collectInputs(), DT);
        if (mode === 'host') host.ticked();
        pressed.clear(); // edge inputs apply to exactly one tick
        acc -= DT;
      }
    }
    drainEffects(state, mode === 'host');
    if (!stopped && !ui.paused) { updateEffects(elapsed); spawnTrails(state, elapsed); }
    playEvents(state.events, mode === 'host');
    if (mode === 'host' && guestOk && net.connected) host.send(net, state, now, acc, ui.paused);
  } else if (mode === 'guest') {
    if (!state.paused) { updateEffects(elapsed); spawnTrails(state, elapsed); }
    playEvents(state.events, false);
    guest.update(net, state, elapsed, now);
  } else {
    pressed.clear();
  }
  ui.shake = Math.max(0, ui.shake - elapsed * 30);
}

// The camera follows your own cat (online) or both cats (same screen).
let lastFrame = performance.now();
function updateCamera(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  const s = mode === 'guest' || mode === 'local' || mode === 'host' ? state : null;
  const ids = mode === 'guest' ? [1] : mode === 'host' ? [0] : s ? s.players.map((p) => p.id) : [];
  const ps = s ? s.players.filter((p) => ids.includes(p.id)) : [];
  if (s) ui.menuMap = s.m;
  const { worldW: WORLD_W, worldH: WORLD_H } = ui.menuMap;
  const tx = ps.length ? ps.reduce((a, p) => a + p.x, 0) / ps.length - VIEW_W / 2 : 0;
  const ty = ps.length ? ps.reduce((a, p) => a + p.y, 0) / ps.length - MAP_H / 2 : (WORLD_H - MAP_H) / 2;
  const cx = Math.max(0, Math.min(WORLD_W - VIEW_W, tx)), cy = Math.max(0, Math.min(WORLD_H - MAP_H, ty));
  if (ui.cam.snap) { ui.cam.x = cx; ui.cam.y = cy; ui.cam.snap = !ps.length; }
  const k = Math.min(1, dt * 7);
  ui.cam.x += (cx - ui.cam.x) * k;
  ui.cam.y += (cy - ui.cam.y) * k;
}

// Music gets busier during waves and tense while the cottage is under attack.
function updateMusic(s) {
  const live = s && !s.over && !s.won && !s.paused && !ui.paused;
  const fighting = live && s.phase === 'wave';
  const danger = live && (s.baseHitT > 0 || s.enemies.some((e) => e.def?.boss));
  setMusicMood(fighting ? 1 : 0, danger ? 1 : 0);
}

// The sim ticks at 60 Hz whatever the display does, so a frame can land
// anywhere between two ticks (or on none, or two). Draw everything that moves
// between where it was a tick ago and where it is now, by how far we are
// into the next tick, and put the real positions back afterwards.
const LERPED = ['players', 'enemies', 'drops', 'projs', 'bombs'];
const saved = [];
function rememberPositions(s) {
  for (const key of LERPED) for (const o of s[key]) { o.px = o.x; o.py = o.y; }
}
function blendPositions(s, a) {
  for (const key of LERPED) {
    for (const o of s[key]) {
      if (o.px === undefined) continue; // appeared this tick
      saved.push(o, o.x, o.y);
      o.x = o.px + (o.x - o.px) * a;
      o.y = o.py + (o.y - o.py) * a;
    }
  }
}
function restorePositions() {
  for (let i = 0; i < saved.length; i += 3) { saved[i].x = saved[i + 1]; saved[i].y = saved[i + 2]; }
  saved.length = 0;
}

let lastDraw = performance.now();
function frame(now) {
  const frameDt = Math.min(0.1, (now - lastDraw) / 1000);
  lastDraw = now;
  pump();
  if (mode === 'guest') {
    interpolate(state, now);
    ui.paused = state.paused;
    guest.show(state, frameDt);
  }
  const ticking = mode === 'local' || mode === 'host';
  if (ticking) blendPositions(state, Math.min(1, acc / DT));
  updateCamera(now);
  const inGame = mode === 'guest' || ticking;
  updateMusic(inGame ? state : null);
  render(ctx, inGame ? state : null, ui);
  if (ticking) restorePositions();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// A hidden tab gets no animation frames and its timers are slowed to as
// little as once a second, which would starve the guest of a host who just
// switched tabs. Timers inside a worker keep their pace, so a tiny one ticks
// the game while the tab is hidden.
const HEARTBEAT = `let id = 0;
onmessage = (e) => { clearInterval(id); if (e.data) id = setInterval(() => postMessage(0), 16); };`;
const heartbeat = new Worker(URL.createObjectURL(new Blob([HEARTBEAT], { type: 'text/javascript' })));
heartbeat.onmessage = () => { if (document.hidden) pump(); };
const followVisibility = () => heartbeat.postMessage(document.hidden);
document.addEventListener('visibilitychange', followVisibility);
followVisibility();

// Invite links: ?join=ABCD opens the join screen with the code filled in.
const invite = new URLSearchParams(location.search).get('join');
if (invite) showJoin(invite.toUpperCase().slice(0, 4));

// Debug hooks for automated play-testing.
window.__game = { get state() { return state; }, get mode() { return mode; }, get net() { return net; }, get pred() { return guest && guest.pred; }, startLocal, held, pressed };
