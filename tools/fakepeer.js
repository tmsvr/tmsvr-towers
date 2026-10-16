// A stand-in for PeerJS, for testing online play without the internet: open
// the game with ?fakenet in several tabs of one browser and they connect to
// each other through a BroadcastChannel instead of WebRTC. Only the parts of
// PeerJS that src/net.js uses are here (peers, connections, a negotiated
// second data channel). Messages keep their order and are never lost, so this
// tests the game's flows, not how it copes with a bad connection.
const bus = new BroadcastChannel('petalpatrol-fakepeer');
const peers = new Map(); // id -> FakePeer living in this tab
const conns = new Map(); // connection id -> FakeConn in this tab
const rid = () => Math.random().toString(36).slice(2, 10);

class Emitter {
  constructor() { this.handlers = {}; }
  on(ev, fn) { (this.handlers[ev] ||= []).push(fn); return this; }
  emit(ev, ...args) { for (const fn of this.handlers[ev] || []) fn(...args); }
}

class FakeChannel {
  constructor(conn) { this.conn = conn; this.binaryType = 'arraybuffer'; this.bufferedAmount = 0; this.onmessage = null; }
  get readyState() { return this.conn.open ? 'open' : 'closed'; }
  send(data) { if (this.conn.open) bus.postMessage({ kind: 'data', to: this.conn.remote, id: this.conn.id, lane: 'fast', data }); }
  close() {}
}

class FakeConn extends Emitter {
  constructor(id, local, remote) {
    super();
    Object.assign(this, { id, local, remote, open: false, bufferSize: 0, fast: null });
    this.dataChannel = { bufferedAmount: 0 };
    this.peerConnection = { createDataChannel: () => (this.fast = new FakeChannel(this)) };
    conns.set(id, this);
  }
  send(data) { if (this.open) bus.postMessage({ kind: 'data', to: this.remote, id: this.id, lane: 'rel', data }); }
  close() { if (!conns.has(this.id)) return; bus.postMessage({ kind: 'close', to: this.remote, id: this.id }); this.gone(); }
  gone() { if (!conns.delete(this.id)) return; this.open = false; this.emit('close'); }
  opened() { this.open = true; setTimeout(() => this.emit('open')); }
}

class FakePeer extends Emitter {
  constructor(id, _opts) {
    super();
    if (typeof id === 'object') id = null;
    this.id = id || `anon-${rid()}`;
    this.destroyed = false;
    peers.set(this.id, this);
    setTimeout(() => this.emit('open', this.id), 30);
  }
  connect(other) {
    const c = new FakeConn(rid(), this.id, other);
    bus.postMessage({ kind: 'conn', to: other, from: this.id, id: c.id });
    c.timer = setTimeout(() => { if (!c.open) { conns.delete(c.id); this.emit('error', { type: 'peer-unavailable' }); } }, 3000);
    return c;
  }
  reconnect() {}
  destroy() {
    this.destroyed = true;
    peers.delete(this.id);
    for (const c of [...conns.values()]) if (c.local === this.id) c.close();
  }
}

bus.onmessage = ({ data: m }) => {
  if (m.kind === 'conn') {
    const p = peers.get(m.to);
    if (!p) return;
    const c = new FakeConn(m.id, m.to, m.from);
    p.emit('connection', c);
    bus.postMessage({ kind: 'accept', to: m.from, id: m.id });
    c.opened();
    return;
  }
  const c = conns.get(m.id);
  if (!c || c.local !== m.to) return;
  if (m.kind === 'accept') { clearTimeout(c.timer); c.opened(); }
  else if (m.kind === 'close') c.gone();
  else if (m.kind === 'data') {
    if (m.lane === 'fast') c.fast?.onmessage?.({ data: m.data });
    else c.emit('data', m.data);
  }
};
// closing the tab closes its connections, like a real peer going away
addEventListener('pagehide', () => { for (const c of [...conns.values()]) c.close(); });

window.Peer = FakePeer;

// ?fakenet&tick: some embedded or automated browsers stop drawing background
// tabs without telling the page it is hidden, so their games freeze. Saying
// the page is hidden makes main.js's heartbeat tick it anyway.
if (new URLSearchParams(location.search).has('tick')) Object.defineProperty(document, 'hidden', { get: () => true });
