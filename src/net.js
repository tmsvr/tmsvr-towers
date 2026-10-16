// Peer-to-peer connection via PeerJS (WebRTC). The public PeerJS server only
// introduces the two browsers; game traffic then flows directly between them.
//
// Two lanes share the connection:
//   send(obj)       – reliable and ordered (PeerJS's own channel, which encodes
//                     the object itself): sound/effect events, pause/restart,
//                     pings. Nothing here may be lost.
//   sendFast(bytes) – unordered with no retransmits: snapshots and guest input,
//                     already encoded (schema.js). A lost or late one is simply
//                     replaced by the next, so it never holds up the messages
//                     behind it the way a reliable channel does.
// Received fast-lane messages reach onData as an ArrayBuffer.
const PREFIX = 'petalpatrol-v1-';
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O, easy to read aloud
// Both sides create this channel themselves (negotiated), so no extra
// handshake is needed once the PeerJS connection is up.
const FAST_LANE = { negotiated: true, id: 100, ordered: false, maxRetransmits: 0 };
// Bytes waiting to go out before we stop adding snapshots. Queueing more
// would only make every later one arrive later.
const BACKLOG = { fast: 16 * 1024, reliable: 64 * 1024 };
// Players whose networks block direct connections need their traffic relayed
// through a TURN server. PeerJS brings a free shared one (UDP only, best
// effort); this Worker (turn/worker.js) hands out Cloudflare's, which also
// relays over TCP and TLS on port 443 and so gets through strict firewalls.
// Empty: PeerJS's own servers only.
const ICE_URL = 'https://petal-turn.timester12.workers.dev';
const ICE_WAIT = 3000; // ms; without an answer by then, connect with PeerJS's servers

const randomCode = () => Array.from({ length: 4 }, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join('');

function errorText(err) {
  switch (err && err.type) {
    case 'peer-unavailable': return 'No game found with that code. Check the code and that the host is still waiting.';
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed': return "Can't reach the matchmaking server. Online play needs an internet connection.";
    case 'browser-incompatible': return "This browser doesn't support online play (WebRTC).";
    default: return `Connection problem: ${err && (err.message || err.type) || 'unknown error'}`;
  }
}

// Bytes can arrive as any view; hand them on as a plain ArrayBuffer.
const asBuffer = (d) => (ArrayBuffer.isView(d) ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d);

// A message that makes a handler throw is dropped (and logged) rather than
// taking the connection's event handling down with it.
function guarded(onData) {
  return (msg) => {
    try { onData(msg); } catch (err) { console.warn('Ignored a message that could not be handled', err); }
  };
}

function wire(conn, { onData, onClose }) {
  const handle = guarded(onData);
  conn.on('data', (raw) => handle(asBuffer(raw)));
  conn.on('close', onClose);
  conn.on('error', onClose);
}

function openFastLane(conn, onData) {
  const ch = conn.peerConnection.createDataChannel('fast', FAST_LANE);
  ch.binaryType = 'arraybuffer';
  const handle = guarded(onData);
  ch.onmessage = (ev) => handle(ev.data);
  return ch;
}

// One connection's two lanes. The fast lane falls back to the reliable one
// until it is open.
function lanes() {
  let conn = null, fast = null;
  return {
    attach(c, onData) { conn = c; fast = openFastLane(c, onData); },
    detach(c) { if (conn !== c) return false; conn = null; if (fast) fast.close(); fast = null; return true; },
    get conn() { return conn; },
    get open() { return !!(conn && conn.open); },
    // True while the link can't keep up; the caller should skip a snapshot.
    get congested() {
      if (fast && fast.bufferedAmount > BACKLOG.fast) return true;
      // PeerJS keeps its own queue of whole messages once the channel is full
      return (conn?.dataChannel?.bufferedAmount || 0) > BACKLOG.reliable || (conn?.bufferSize || 0) > 0;
    },
    send(msg) { if (conn && conn.open) conn.send(msg); },
    sendFast(bytes) {
      if (fast && fast.readyState === 'open') fast.send(bytes);
      else this.send(bytes);
    },
  };
}

// PeerJS options with Cloudflare's servers when the Worker answers, otherwise
// PeerJS's defaults. The credentials last 4 hours; they are reused for one.
let ice = null;
function peerOptions() {
  if (!ICE_URL) return Promise.resolve({ debug: 0 });
  if (!ice || performance.now() - ice.at > 3600e3) {
    const promise = fetch(ICE_URL, { signal: AbortSignal.timeout(ICE_WAIT) })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(({ iceServers }) => ({ debug: 0, config: { iceServers } }))
      .catch((err) => {
        console.warn('No TURN relay; connecting with PeerJS defaults', err);
        if (ice?.promise === promise) ice = null; // try again next time
        return { debug: 0 };
      });
    ice = { at: performance.now(), promise };
  }
  return ice.promise;
}

function requirePeer(onError) {
  if (window.Peer) return true;
  onError("Couldn't load the networking library. Online play needs an internet connection.");
  return false;
}

const OFFLINE = { send() {}, sendFast() {}, close() {}, kick() {}, connected: false, congested: false };

// Host: registers a room code and keeps every connection that opens, each as
// a link with its own two lanes. Teammates join the room; a versus race also
// links two rooms (connect). Who a link is (teammate or rival) is up to the
// game: the first thing either side says is a hello naming its role.
//   onOpen(code)        the room has its code
//   onLink(link)        a connection opened (link.out: we connected to them)
//   onData(link, msg)   a message (fast-lane ones as an ArrayBuffer)
//   onClose(link)       a link closed or failed
export function openRoom({ onOpen, onLink, onData, onClose, onError }) {
  let peer = null, closed = false, code = '';
  if (!requirePeer(onError)) return { ...OFFLINE, connect() {}, links: [] };
  const links = new Set();

  const adopt = (c, out) => {
    const lane = lanes();
    let gone = false;
    const link = {
      out, role: null,
      send: (msg) => lane.send(msg),
      sendFast: (msg) => lane.sendFast(msg),
      get connected() { return lane.open; },
      get congested() { return lane.congested; },
      // Close it (after a moment, so a last message such as a refusal still gets out).
      kick() { if (lane.detach(c)) setTimeout(() => c.close(), 300); },
    };
    const lost = () => { if (gone) return; gone = true; lane.detach(c); links.delete(link); if (!closed) onClose(link); };
    c.on('open', () => { lane.attach(c, (m) => onData(link, m)); links.add(link); onLink(link); });
    wire(c, { onData: (m) => onData(link, m), onClose: lost });
  };

  const open = () => peerOptions().then((opts) => {
    if (closed) return;
    code = randomCode();
    peer = new window.Peer(PREFIX + code, opts);
    peer.on('open', () => onOpen(code));
    peer.on('connection', (c) => adopt(c, false));
    peer.on('error', (err) => {
      if (err.type === 'unavailable-id') { peer.destroy(); open(); return; } // code clash: pick another
      if (err.type === 'peer-unavailable') { onError(errorText(err), true); return; } // a room we tried to link to isn't there
      if (!closed) onError(errorText(err));
    });
    // The signalling link can drop while the game connection is fine; reconnect so rejoining still works.
    peer.on('disconnected', () => { if (!closed && !peer.destroyed) peer.reconnect(); });
  });
  open();

  return {
    get code() { return code; },
    get links() { return [...links]; },
    // Link to another room (a rival team's host).
    connect(other) { adopt(peer.connect(PREFIX + other.toUpperCase(), { reliable: true }), true); },
    close() { closed = true; peer && peer.destroy(); },
  };
}

export function joinGame(code, { onOpen, onData, onClose, onError }) {
  let closed = false, peer = null;
  const link = lanes();
  if (!requirePeer(onError)) return OFFLINE;
  peerOptions().then((opts) => {
    if (closed) return;
    peer = new window.Peer(opts);
    peer.on('open', () => {
      const conn = peer.connect(PREFIX + code.toUpperCase(), { reliable: true });
      conn.on('open', () => { link.attach(conn, onData); onOpen(); });
      wire(conn, { onData, onClose: () => { link.detach(conn); if (!closed) onClose(); } });
    });
    peer.on('error', (err) => { if (!closed) onError(errorText(err)); });
  });
  return {
    send: (msg) => link.send(msg),
    sendFast: (msg) => link.sendFast(msg),
    close() { closed = true; peer && peer.destroy(); },
    get connected() { return link.open; },
    get congested() { return link.congested; },
  };
}
