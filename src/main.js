// Input, game loop, menus/lobby, and glue between sim, renderer, audio and network.
//
// Modes:  menu | local | hostWait | host | joinInput | joining | guest
//   local     – this browser runs the game for 1 or 2 players on one keyboard
//   host      – this browser runs the game; player 2's inputs arrive over the network (host.js)
//   guest     – this browser only sends inputs and draws snapshots from the host (guest.js)
import { createState, step, continueEndless, retryWave } from './sim.js';
import { finishLog, currentLog, gameSummary } from './stats.js';
import { render, VIEW_W, VIEW_H } from './render.js';
import { initAudio, play, toggleMute, setMusicMood } from './audio.js';
import { juiceEvent, hitStopping, toggleJuice } from './juice.js';
import { hostGame, joinGame } from './net.js';
import { applySnapshot, applyEffects, interpolate, newGuestState } from './snapshot.js';
import { decodeFast, PROTOCOL } from './schema.js';
import { createHostLink } from './host.js';
import { createGuestLink } from './guest.js';
import { saveGame, loadGame } from './save.js';
import { spawnEffect, spawnTrails, updateEffects, resetEffects } from './fx.js';
import { MAPS, MAP_H, DATA_HASH, FLOWER_ORDER, LOADOUT_SIZE } from './data.js';

const canvas = document.getElementById('game');
const lobby = document.getElementById('lobby');
const ctx = canvas.getContext('2d');
// The game is laid out at VIEW_W x VIEW_H and stretched to fit the window; the
// canvas gets as many real pixels as it is shown at, so it stays sharp at any
// size. Steps of 0.25 keep resizing from rebuilding the caches every frame.
// The 2x cap matters: past it the pre-drawn map background gets huge, and
// Firefox in particular slows right down copying from it every frame.
function pixelScale() {
  const shown = canvas.getBoundingClientRect().width || VIEW_W;
  return Math.min(2, Math.max(1, Math.round(((shown * (window.devicePixelRatio || 1)) / VIEW_W) * 4) / 4));
}
function fitCanvas() {
  const k = pixelScale();
  if (k === ui.dpr && canvas.width === Math.round(VIEW_W * k)) return;
  canvas.width = Math.round(VIEW_W * k);
  canvas.height = Math.round(VIEW_H * k);
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ui.dpr = k;
}

const KEYS = [
  { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', atk: 'KeyF', bomb: 'KeyG', build: 'KeyE', heal: 'KeyR', cycle: 'KeyQ', sprint: 'ShiftLeft' },
  { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', atk: 'Comma', bomb: 'Period', build: 'Slash', heal: 'Quote', cycle: 'KeyM', sprint: 'ShiftRight' },
];
const DEFAULT_LABELS = { ShiftLeft: 'Shift', ShiftRight: 'R-Shift', Comma: ',', Period: '.', Slash: '/', Quote: "'", ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
const KEY_TO_CODE = { '/': 'Slash', ',': 'Comma', '.': 'Period', "'": 'Quote' };

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
  paused: false, shake: 0, dpr: 0, fps: 60, keys: KEYS, netLabel: '', disconnected: false, guide: null, online: null,
  // Online, each person plays with the P1 layout on their own keyboard.
  keysFor: (pid) => (mode === 'local' ? KEYS[pid] : KEYS[0]),
  keyLabel: (code) => DEFAULT_LABELS[code] || code.replace(/^Key|^Digit/, ''),
  mode: () => mode,
};
fitCanvas();
addEventListener('resize', fitCanvas);

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
    heal: h(k.heal),
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
  // the flower guide sits on top and keeps the keys to itself
  if (ui.guide != null) {
    const n = FLOWER_ORDER.length;
    if (code === 'ArrowLeft' || code === 'KeyA') ui.guide = (ui.guide + n - 1) % n;
    if (code === 'ArrowRight' || code === 'KeyD') ui.guide = (ui.guide + 1) % n;
    if (code === 'KeyI' || code === 'Escape') ui.guide = null;
    return;
  }
  if (code === 'KeyI' && (mode === 'menu' || state?.phase === 'pick')) { ui.guide = 0; held.clear(); return; }
  held.add(code);
  pressed.add(code);
  if (code === 'KeyN') toggleMute();
  if (code === 'KeyJ') toggleJuice();
  if (code === 'KeyL') downloadLogs();
  // Esc in a game pauses (and resumes); M in the pause menu leaves. After the
  // game, before it starts online, or once disconnected, Esc leaves at once.
  if (code === 'Escape') {
    if (mode === 'menu') { if (ui.online) { leaveOnline(); flashNote('Left the online game'); } return; }
    if (state && !state.over && !state.won && !ui.disconnected) togglePause();
    else backToMenu();
    return;
  }
  if (code === 'KeyM' && ui.paused && mode !== 'menu') { backToMenu(); return; }
  if (code === 'KeyS' && ui.paused && mode !== 'menu') { saveToFile(); return; }
  if (mode === 'menu') {
    // still connected after a game: 3 or Enter plays again together, any other mode leaves
    if (ui.online && (code === 'Digit3' || code === 'Numpad3' || code === 'Enter')) { playAgainOnline(); return; }
    if (ui.online && /^(Digit|Numpad)[124]$/.test(code)) leaveOnline();
    if (code === 'KeyO') openSaveFile();
    if (code === 'Digit1' || code === 'Numpad1') startLocal(1);
    if (code === 'Digit2' || code === 'Numpad2') startLocal(2);
    if (code === 'Digit3' || code === 'Numpad3') startHost();
    if (code === 'Digit4' || code === 'Numpad4') showJoin();
    return;
  }
  if (code === 'KeyP') togglePause();
  // R after a game: back to the pick screen. R while paused: the same map,
  // cats and flowers again, straight into the game.
  // After a win, C keeps going (endless mode); after losing an endless wave,
  // R tries that wave again from the break before it.
  const endlessLoss = state?.endless && state.over;
  if (code === 'KeyC' && state?.won && !ui.paused) {
    if (mode === 'guest') net.send({ t: 'continue' });
    else if (mode === 'local' || mode === 'host') keepGoing();
  }
  if (code === 'KeyR' && state && (state.over || state.won || ui.paused)) {
    if (mode === 'guest') net.send({ t: endlessLoss && !ui.paused ? 'retry' : 'restart' });
    else if (mode === 'local' || mode === 'host') { if (endlessLoss && !ui.paused) retry(); else newGame(ui.paused && !state.over && !state.won); }
  }
});
addEventListener('keyup', (e) => held.delete(e.code || KEY_TO_CODE[e.key] || ''));
addEventListener('blur', () => held.clear());
addEventListener('pointerdown', initAudio);

// ---- game logs (for balancing) -------------------------------------------------
// Every finished (or abandoned) game's log is kept in this browser, the last
// LOG_KEEP of them; L downloads them all as one JSON file. Only the copy that
// runs the game (local play or the online host) has a log.
const LOG_KEY = 'petalpatrol-logs', LOG_KEEP = 20;
function savedLogs() {
  try { return JSON.parse(localStorage.getItem(LOG_KEY)) || []; } catch { return []; }
}
function saveGameLog(how) {
  if (!state?.stats || state.logSaved) return;
  state.logSaved = true;
  if (!state.stats.waves.length && !(state.stats.cur && state.wave > 0)) return; // nothing played yet
  const entry = finishLog(state, how);
  entry.mode = mode === 'host' ? 'online co-op (host)' : nPlayers > 1 ? 'local co-op' : 'solo';
  // the end screen's numbers; an online guest gets the same ones
  if (how !== 'quit') {
    ui.summary = gameSummary(entry);
    if (mode === 'host' && guestOk && net.connected) net.send({ t: 'summary', summary: ui.summary });
  }
  // an endless game is saved again each time it ends; keep only its latest log
  const others = savedLogs().filter((g) => g.date !== entry.date);
  try { localStorage.setItem(LOG_KEY, JSON.stringify([...others, entry].slice(-LOG_KEEP))); } catch { /* storage full or blocked */ }
}
function downloadLogs() {
  const logs = savedLogs();
  // include the game in progress, as it stands
  if (state?.stats && !state.logSaved && state.stats.waves.length) {
    logs.push({ ...currentLog(state), result: { how: 'in progress', wave: state.wave, cottage: Math.round(state.lives), kills: state.kills, seconds: Math.round(state.t) } });
  }
  if (!logs.length) { flashNote(mode === 'guest' ? 'The host has the game log' : 'No games logged yet'); return; }
  downloadJson(JSON.stringify({ games: logs }, null, 1), 'log');
  flashNote(`Downloaded ${logs.length} game log${logs.length > 1 ? 's' : ''}`);
}
const fileStamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
function downloadJson(text, what) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = `petal-patrol-${what}-${fileStamp()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function flashNote(txt) { ui.note = { txt, until: performance.now() + 2500 }; }

// ---- modes ------------------------------------------------------------------
let lastLoadouts = [], lastCats = [];
let lastMap = 0;
function togglePause() {
  if (mode === 'guest') net.send({ t: 'pause' });
  else if (mode === 'local' || mode === 'host') ui.paused = !ui.paused;
}

// same: restart with the same map, cats and flowers, skipping the pick screen.
function newGame(same = false) {
  saveGameLog('quit');
  if (state && state.players) { lastLoadouts = state.players.map((p) => p.loadout || p.pick.chosen); lastCats = state.players.map((p) => p.cat); lastMap = state.map; }
  state = createState(nPlayers, (Math.random() * 1e9) | 0, { sharedScreen: mode === 'local' && nPlayers > 1, loadouts: lastLoadouts, cats: lastCats, map: lastMap });
  // everyone already has a full loadout, so the next tick leaves the pick screen
  if (same && state.players.every((p) => p.pick.chosen.length === LOADOUT_SIZE)) for (const p of state.players) p.pick.ready = true;
  ui.cam.snap = true;
  ui.paused = false;
  ui.summary = null;
  resetEffects();
  play('wave');
}

function keepGoing() {
  state.logSaved = false; // the same game's log goes on, and replaces the saved one when it ends
  continueEndless(state);
  ui.summary = null;
}
function retry() {
  retryWave(state);
  ui.summary = null;
  resetEffects();
}

// ---- saved games ---------------------------------------------------------------
// S on the pause screen downloads the whole game as a file; O on the main menu
// loads one and carries on paused. Online games are saved and loaded by the
// host, and a loaded online game starts once P2 is connected.
let pendingSave = null; // an online save waiting for P2 to join
function saveToFile() {
  if (mode === 'guest') { flashNote('The host can save the game'); return; }
  const how = mode === 'host' ? 'online' : nPlayers > 1 ? 'local' : 'solo';
  downloadJson(JSON.stringify(saveGame(state, how)), `save-${state.m.id}-wave${state.wave}`);
  flashNote('Game saved: load it from the main menu with O');
}

function openSaveFile() {
  if (ui.online === 'guest') { flashNote('The host can load a saved game'); return; }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    let save;
    try { save = loadGame(JSON.parse(await file.text())); } catch (e) { flashNote(`Couldn't load that file: ${e.message}`); return; }
    if (mode === 'menu') startSaved(save);
  };
  input.click();
}

function startSaved({ state: s, mode: how, sameVersion }) {
  if (how === 'online' && ui.online === 'host') { // P2 is still here: straight back in
    ui.online = null;
    mode = 'host';
    nPlayers = 2;
    host.reset();
    net.send({ t: 'start' });
    resumeGame(s);
  } else if (how === 'online') {
    if (ui.online) leaveOnline();
    pendingSave = s;
    startHost();
  } else {
    if (ui.online) leaveOnline();
    mode = 'local';
    nPlayers = s.players.length;
    resumeGame(s);
  }
  if (!sameVersion) flashNote('Saved with another version of the game: some numbers may have changed');
}

function resumeGame(s) {
  state = s;
  lastLoadouts = s.players.map((p) => p.loadout || p.pick.chosen); lastCats = s.players.map((p) => p.cat); lastMap = s.map;
  ui.cam.snap = true;
  ui.paused = true; // everyone gets their hands on the keys first
  ui.summary = null;
  resetEffects();
  flashNote('Game loaded: P or Esc to carry on');
}

function startLocal(n) { mode = 'local'; nPlayers = n; newGame(); }

// Leaving a game online keeps the connection: both players go back to the
// main menu together and can start another game from there.
function backToMenu() {
  const together = net?.connected && ((mode === 'host' && guestOk) || (mode === 'guest' && !ui.disconnected));
  if (together) { net.send({ t: 'menu' }); menuTogether(); return; }
  saveGameLog('quit');
  leaveOnline();
  mode = 'menu';
  state = null;
  resetEffects();
  ui.paused = false;
  ui.summary = null;
  ui.netLabel = '';
  ui.disconnected = false;
  hideLobby();
  canvas.focus();
}

function menuTogether(note) {
  saveGameLog('quit');
  if (mode === 'host' && state?.players) { lastLoadouts = state.players.map((p) => p.loadout || p.pick.chosen); lastCats = state.players.map((p) => p.cat); lastMap = state.map; }
  ui.online = mode === 'host' ? 'host' : 'guest';
  awaitingStart = ui.online === 'guest'; // snapshots of the old game may still be on the way
  mode = 'menu';
  state = null;
  resetEffects();
  ui.paused = false;
  ui.summary = null;
  hideLobby();
  canvas.focus();
  if (note) flashNote(note);
}

// From the menu together: the host starts the next game; the guest asks it to.
function playAgainOnline() {
  if (ui.online === 'guest') { net.send({ t: 'again' }); flashNote('Starting…'); return; }
  ui.online = null;
  mode = 'host';
  nPlayers = 2;
  host.reset();
  net.send({ t: 'start' });
  newGame();
}

function leaveOnline() {
  if (net) net.close();
  net = null;
  ui.online = null;
  ui.netLabel = '';
  guestOk = false;
  awaitingStart = false;
  pendingSave = null;
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
      const resume = pendingSave ? `<p>Your saved game (${esc(pendingSave.m.name)}, wave ${pendingSave.wave}) carries on once they join.</p>` : '';
      showLobby(`<h2>Waiting for player 2…</h2><p>Room code</p><div class="code">${code}</div>${resume}${share}<p class="hint">Esc to cancel</p>`);
      const btn = document.getElementById('copy');
      if (btn) btn.onclick = () => navigator.clipboard.writeText(link).then(() => { btn.textContent = 'Copied!'; });
    },
    // The guest introduces itself first (see onGuestMessage); nothing starts until then.
    onConnect: () => { guestOk = false; },
    onData: (m) => onGuestMessage(m instanceof ArrayBuffer ? decodeFast(m) : m),
    onClose: () => {
      if (!guestOk) return;
      if (ui.online) { leaveOnline(); flashNote('P2 left the online game'); return; }
      guestOk = false; host.reset(); ui.netLabel = `P2 disconnected — they can rejoin with code ${roomCode}`; play('leak');
    },
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
  if (mode === 'hostWait') {
    mode = 'host';
    nPlayers = 2;
    if (pendingSave) { resumeGame(pendingSave); pendingSave = null; } else newGame();
  }
  play('grown');
}

function onGuestMessage(m) {
  if (!m || typeof m.t !== 'string') return;
  if (m.t === 'hello') { welcomeGuest(m); return; }
  if (!guestOk) return;
  if (m.t === 'in') host.receiveInputs(m.inputs);
  else if (m.t === 'pause') ui.paused = !ui.paused;
  else if (m.t === 'restart' && state && (state.over || state.won || ui.paused)) newGame(ui.paused && !state.over && !state.won);
  else if (m.t === 'continue' && state?.won) keepGoing();
  else if (m.t === 'retry' && state?.endless && state.over) retry();
  else if (m.t === 'ping' && Number.isFinite(m.at)) net.send({ t: 'pong', at: m.at });
  else if (m.t === 'menu' && mode === 'host') menuTogether('P2 went back to the menu');
  else if (m.t === 'again' && mode === 'menu' && ui.online === 'host') playAgainOnline();
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

let rejected = false, awaitingStart = false;
const newGuestLink = () => createGuestLink({
  sample: () => { const k = readKeys(KEYS[0], true); pressed.clear(); return k; },
  dropTaps: () => pressed.clear(),
});
function startJoin(code) {
  mode = 'joining';
  rejected = false;
  guest = newGuestLink();
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
        if (awaitingStart) return;
        if (mode !== 'guest') { mode = 'guest'; nPlayers = 2; state = newGuestState(); resetEffects(); ui.cam.snap = true; hideLobby(); canvas.focus(); }
        applySnapshot(state, m, performance.now());
      } else if (m.t === 'fx') {
        if (mode === 'guest') applyEffects(state, m, performance.now());
      } else if (m.t === 'summary') {
        if (mode === 'guest') ui.summary = m.summary;
      } else if (m.t === 'menu') {
        if (mode === 'guest') menuTogether('The host went back to the menu');
      } else if (m.t === 'start') {
        if (awaitingStart) { awaitingStart = false; ui.online = null; guest = newGuestLink(); } // fresh input numbering, like a new join
      } else if (m.t === 'pong') {
        ui.netLabel = `Online · room ${code} · ${Math.round(performance.now() - m.at)} ms`;
      } else if (m.t === 'reject') {
        rejected = true;
        showLobby(`<h2>Different game versions</h2><p>The host has a different version of the game${m.protocol !== VERSION.protocol ? '' : ' (different balance or maps)'}. You both need the same files.</p><p class="hint">Esc to go back</p>`);
      }
    },
    onClose: () => {
      if (rejected) return;
      if (ui.online) { leaveOnline(); flashNote('The host left the online game'); return; }
      ui.disconnected = true; ui.netLabel = '';
    },
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
    if (state && (state.over || state.won) && !state.logSaved) saveGameLog(state.won ? 'won' : 'lost');
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
  if (frameDt > 0) ui.fps += (1 / frameDt - ui.fps) * 0.05; // smoothed, shown online next to the ping
  pump();
  if (mode === 'guest') {
    interpolate(state, now);
    ui.paused = state.paused;
    if (!state.over && !state.won) ui.summary = null; // the host restarted
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
