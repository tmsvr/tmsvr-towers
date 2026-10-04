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

function requirePeer(onError) {
  if (window.Peer) return true;
  onError("Couldn't load the networking library. Online play needs an internet connection.");
  return false;
}

const OFFLINE = { send() {}, sendFast() {}, close() {}, kick() {}, connected: false, congested: false };

// Host: registers a room code and waits for one guest. A new guest replaces a
// dropped one, so a friend can rejoin with the same code.
export function hostGame({ onOpen, onConnect, onData, onClose, onError }) {
  let peer = null, closed = false;
  const link = lanes();
  if (!requirePeer(onError)) return OFFLINE;

  const open = () => {
    const code = randomCode();
    peer = new window.Peer(PREFIX + code, { debug: 0 });
    peer.on('open', () => onOpen(code));
    peer.on('connection', (c) => {
      c.on('open', () => {
        const old = link.conn;
        if (old && old !== c) { link.detach(old); old.close(); }
        link.attach(c, onData);
        onConnect();
      });
      wire(c, { onData, onClose: () => { if (link.detach(c) && !closed) onClose(); } });
    });
    peer.on('error', (err) => {
      if (err.type === 'unavailable-id') { peer.destroy(); open(); return; } // code clash: pick another
      if (err.type === 'peer-unavailable') return;
      if (!closed) onError(errorText(err));
    });
    // The signalling link can drop while the game connection is fine; reconnect so rejoining still works.
    peer.on('disconnected', () => { if (!closed && !peer.destroyed) peer.reconnect(); });
  };
  open();

  return {
    send: (msg) => link.send(msg),
    sendFast: (msg) => link.sendFast(msg),
    close() { closed = true; peer && peer.destroy(); },
    // Drop the current guest (the room stays open for another).
    kick() { const c = link.conn; if (c) { link.detach(c); setTimeout(() => c.close(), 300); } },
    get connected() { return link.open; },
    get congested() { return link.congested; },
  };
}

export function joinGame(code, { onOpen, onData, onClose, onError }) {
  let closed = false;
  const link = lanes();
  if (!requirePeer(onError)) return OFFLINE;
  const peer = new window.Peer({ debug: 0 });
  peer.on('open', () => {
    const conn = peer.connect(PREFIX + code.toUpperCase(), { reliable: true });
    conn.on('open', () => { link.attach(conn, onData); onOpen(); });
    wire(conn, { onData, onClose: () => { link.detach(conn); if (!closed) onClose(); } });
  });
  peer.on('error', (err) => { if (!closed) onError(errorText(err)); });
  return {
    send: (msg) => link.send(msg),
    sendFast: (msg) => link.sendFast(msg),
    close() { closed = true; peer.destroy(); },
    get connected() { return link.open; },
    get congested() { return link.congested; },
  };
}
