// Peer-to-peer connection via PeerJS (WebRTC). The public PeerJS server only
// introduces the two browsers; game traffic then flows directly between them.
const PREFIX = 'petalpatrol-v1-';
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O, easy to read aloud

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

function wire(conn, { onData, onClose }) {
  conn.on('data', (raw) => onData(typeof raw === 'string' ? JSON.parse(raw) : raw));
  conn.on('close', onClose);
  conn.on('error', onClose);
}

function requirePeer(onError) {
  if (window.Peer) return true;
  onError("Couldn't load the networking library. Online play needs an internet connection.");
  return false;
}

// Host: registers a room code and waits for one guest. A new guest replaces a
// dropped one, so a friend can rejoin with the same code.
export function hostGame({ onOpen, onConnect, onData, onClose, onError }) {
  let peer = null, conn = null, closed = false;
  if (!requirePeer(onError)) return { send() {}, close() {}, connected: false };

  const open = () => {
    const code = randomCode();
    peer = new window.Peer(PREFIX + code, { debug: 0 });
    peer.on('open', () => onOpen(code));
    peer.on('connection', (c) => {
      c.on('open', () => {
        if (conn && conn !== c) conn.close();
        conn = c;
        onConnect();
      });
      wire(c, { onData, onClose: () => { if (conn === c) { conn = null; if (!closed) onClose(); } } });
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
    send(msg) { if (conn && conn.open) conn.send(JSON.stringify(msg)); },
    close() { closed = true; peer && peer.destroy(); },
    get connected() { return !!(conn && conn.open); },
  };
}

export function joinGame(code, { onOpen, onData, onClose, onError }) {
  let conn = null, closed = false;
  if (!requirePeer(onError)) return { send() {}, close() {} };
  const peer = new window.Peer({ debug: 0 });
  peer.on('open', () => {
    conn = peer.connect(PREFIX + code.toUpperCase(), { reliable: true });
    conn.on('open', onOpen);
    wire(conn, { onData, onClose: () => { if (!closed) onClose(); } });
  });
  peer.on('error', (err) => { if (!closed) onError(errorText(err)); });
  return {
    send(msg) { if (conn && conn.open) conn.send(JSON.stringify(msg)); },
    close() { closed = true; peer.destroy(); },
  };
}
