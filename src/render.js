// Canvas rendering. Reads game state, never mutates it.
// The world is bigger than the screen: everything on the map is drawn relative to ui.cam.
//
// The state is either the host's (sim.js createState) or the guest's, rebuilt
// from snapshots (snapshot.js newGuestState); both must provide what this
// file reads:
//   m (the map), phase, wave, timer, lives, maxLives, baseHitT, over, won, kills,
//   queue (an array; only its length is used), grid (tile -> flower),
//   players, flowers, enemies (each with its def), drops, projs, bombs, clouds,
// with each entity carrying the fields schema.js sends for it.
import {
  T, U, VIEW_W, MAP_H, HUD_H, TOTAL_WAVES, MAPS,
  FLOWER_ORDER, FLOWERS, MAX_LEVEL, FLOWER_HP, LOADOUT_SIZE, flowerStats, upgradeCost, plantCost, PLAYER, CATS, CAT_ORDER, GLOBAL_RANGE, ENEMIES, INTROS,
} from './data.js';
import { tileOf, canBuildAt, uprootRefund, catStats, plantPrice, upgradeLeft, healLeft } from './sim.js';
import { isMuted } from './audio.js';
import { observeJuice, drawJuiceWorld, drawJuiceScreen, hitSquash, swingSquash, coinScale } from './juice.js';
import { liveEffects } from './fx.js';
import { clamp, seededRandom } from './util.js';

export { VIEW_W };
export const VIEW_H = MAP_H + HUD_H;

const FONT = '"Fredoka", system-ui, -apple-system, sans-serif';
const OUT = '#2b2118';

// ---- primitives -------------------------------------------------------------
function circle(c, x, y, r, fill, stroke, lw = 2) {
  c.beginPath(); c.arc(x, y, Math.max(0.1, r), 0, Math.PI * 2);
  if (fill) { c.fillStyle = fill; c.fill(); }
  if (stroke) { c.strokeStyle = stroke; c.lineWidth = lw; c.stroke(); }
}
function ellipse(c, x, y, rx, ry, fill, stroke, lw = 2, rot = 0) {
  c.beginPath(); c.ellipse(x, y, Math.max(0.1, rx), Math.max(0.1, ry), rot, 0, Math.PI * 2);
  if (fill) { c.fillStyle = fill; c.fill(); }
  if (stroke) { c.strokeStyle = stroke; c.lineWidth = lw; c.stroke(); }
}
function rrect(c, x, y, w, h, r, fill, stroke, lw = 2) {
  c.beginPath(); c.roundRect(x, y, w, h, r);
  if (fill) { c.fillStyle = fill; c.fill(); }
  if (stroke) { c.strokeStyle = stroke; c.lineWidth = lw; c.stroke(); }
}
function star(c, x, y, r, fill, stroke) {
  c.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r * 0.45 : r;
    c.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  c.closePath(); c.fillStyle = fill; c.fill();
  if (stroke) { c.strokeStyle = stroke; c.lineWidth = 1.5; c.stroke(); }
}
function label(c, txt, x, y, size, fill = '#fff', align = 'center', weight = 600, outline = 'rgba(0,0,0,0.65)') {
  c.font = `${weight} ${size}px ${FONT}`; c.textAlign = align; c.textBaseline = 'middle';
  if (outline) { c.strokeStyle = outline; c.lineWidth = Math.max(3, size / 5); c.lineJoin = 'round'; c.strokeText(txt, x, y); }
  c.fillStyle = fill; c.fillText(txt, x, y);
}
function fitText(c, txt, maxW, size, weight = 500) {
  c.font = `${weight} ${size}px ${FONT}`;
  if (c.measureText(txt).width <= maxW) return txt;
  while (txt.length > 4 && c.measureText(txt + '…').width > maxW) txt = txt.slice(0, -1);
  return txt + '…';
}
// Blend two #rrggbb colours. Withering flowers ask for this every frame, so
// results are remembered (t is rounded to 1/64, which nobody can see).
const mixed = new Map();
function mix(a, b, t) {
  t = Math.round(t * 64) / 64;
  const key = a + b + t;
  let out = mixed.get(key);
  if (!out) {
    const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
    const ch = (p, s) => (p >> s) & 255;
    const m = (s) => Math.round(ch(pa, s) + (ch(pb, s) - ch(pa, s)) * t);
    out = `rgb(${m(16)},${m(8)},${m(0)})`;
    if (mixed.size > 4000) mixed.clear();
    mixed.set(key, out);
  }
  return out;
}

// A canvas for pictures painted once and then stamped many times a frame
// (flower heads, background tiles, minimap). willReadFrequently keeps it in
// ordinary memory instead of on the GPU. In Firefox, stamping from a GPU canvas
// cost about 0.1 ms per drawImage, over half of a busy frame; from one of these
// it is a third faster overall. Chrome draws them just as fast either way.
function cacheCanvas(w, h) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  return { cv, c: cv.getContext('2d', { willReadFrequently: true }) };
}

// ---- static background (pre-rendered once per map) -------------------------
// Painted once into one big canvas (about 3700 x 2600 pixels at 2x), then cut
// into tiles. Copying a screenful out of the big canvas every frame was slower
// in Firefox, and in Chrome it cost about 8 ms whenever the browser kept that
// canvas off the GPU. Only the ~20 tiles on screen are drawn.
const BG_TILE = 512; // in device pixels
let bgCache = null;
function getBg(m, dpr) {
  if (bgCache && bgCache.dpr === dpr && bgCache.map === m && bgCache.cv) return bgCache.cv;
  const { cv, c } = cacheCanvas(m.worldW * dpr, m.worldH * dpr);
  c.scale(dpr, dpr);
  paintBg(c, m);
  bgCache = { dpr, cv, map: m, tiles: null };
  return cv;
}

function bgTiles(m, dpr) {
  if (bgCache && bgCache.dpr === dpr && bgCache.map === m && bgCache.tiles) return bgCache.tiles;
  const big = getBg(m, dpr);
  minimapBg(m, dpr); // shrink it for the minimap while the big picture still exists
  const tiles = [];
  for (let y = 0; y < big.height; y += BG_TILE) {
    for (let x = 0; x < big.width; x += BG_TILE) {
      const { cv, c } = cacheCanvas(Math.min(BG_TILE, big.width - x), Math.min(BG_TILE, big.height - y));
      c.drawImage(big, -x, -y);
      tiles.push({ x, y, cv });
    }
  }
  bgCache.tiles = tiles;
  bgCache.cv = null; // tens of megabytes nobody needs any more
  return tiles;
}

// The map area of the screen, with the camera's top-left corner at (camX, camY).
// Tiles are drawn 1:1 in device pixels at whole-pixel offsets, so they are
// never resampled and no seams can show between them.
function drawBg(c, m, dpr, camX, camY) {
  const tiles = bgTiles(m, dpr);
  const tf = c.getTransform(); // the screen shake's offset, in device pixels
  const ox = Math.round(tf.e), oy = Math.round(tf.f);
  const vx = Math.round(camX * dpr), vy = Math.round(camY * dpr);
  const vx1 = vx + Math.round(VIEW_W * dpr), vy1 = vy + Math.round(MAP_H * dpr);
  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  for (const t of tiles) {
    const x0 = Math.max(vx, t.x), y0 = Math.max(vy, t.y);
    const x1 = Math.min(vx1, t.x + t.cv.width), y1 = Math.min(vy1, t.y + t.cv.height);
    if (x1 <= x0 || y1 <= y0) continue;
    c.drawImage(t.cv, x0 - t.x, y0 - t.y, x1 - x0, y1 - y0, ox + x0 - vx, oy + y0 - vy, x1 - x0, y1 - y0);
  }
  c.restore();
}

function strokePoly(c, pts, w, col) {
  c.beginPath(); c.moveTo(pts[0].x, pts[0].y);
  for (const p of pts.slice(1)) c.lineTo(p.x, p.y);
  c.lineWidth = w; c.strokeStyle = col; c.lineJoin = 'round'; c.lineCap = 'round'; c.stroke();
}

function drawPond(c, o, r) {
  const x = o.x * T, y = o.y * T, w = o.w * T, h = o.h * T;
  rrect(c, x + 2, y + 6, w - 4, h - 4, T * 0.45, 'rgba(0,0,0,0.12)');
  rrect(c, x + 2, y + 2, w - 4, h - 4, T * 0.45, '#d8c48e', '#9c7444', 2.5);
  const g = c.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, '#6cc0ea'); g.addColorStop(1, '#3f8fc9');
  rrect(c, x + 9, y + 9, w - 18, h - 18, T * 0.35, g, '#2f6f9e', 2);
  c.strokeStyle = 'rgba(255,255,255,0.35)'; c.lineWidth = 2; c.lineCap = 'round';
  for (let i = 0; i < o.w * o.h * 0.8; i++) {
    const rx = x + 18 + r() * (w - 36), ry = y + 18 + r() * (h - 36);
    c.beginPath(); c.moveTo(rx - 6, ry); c.quadraticCurveTo(rx, ry - 3, rx + 6, ry); c.stroke();
  }
  for (let i = 0; i < Math.max(1, o.w * o.h / 6); i++) {
    const px = x + 20 + r() * (w - 40), py = y + 20 + r() * (h - 40);
    c.beginPath(); c.moveTo(px, py); c.arc(px, py, 7, 0.4, Math.PI * 2 - 0.1); c.closePath();
    c.fillStyle = '#5fae4a'; c.fill(); c.strokeStyle = '#3e7a30'; c.lineWidth = 1.2; c.stroke();
    if (r() < 0.4) circle(c, px + 2, py - 2, 2.5, '#ff9ecd');
  }
}

// A wooden bridge deck over one water tile: planks across the way it is
// crossed, with a rail and posts on both sides.
function drawDeck(c, d) {
  c.save(); c.translate((d.x + 0.5) * T, (d.y + 0.5) * T);
  if (d.dir === 'v') c.rotate(Math.PI / 2);
  const hw = T / 2 + 1, hh = T * 0.4;
  c.fillStyle = 'rgba(0,0,0,0.18)'; c.fillRect(-hw, -hh + 4, hw * 2, hh * 2);
  c.fillStyle = '#b8834c'; c.fillRect(-hw, -hh, hw * 2, hh * 2);
  c.strokeStyle = '#7d5530'; c.lineWidth = 1.5;
  for (let x = -hw + T / 7; x < hw; x += T / 7) { c.beginPath(); c.moveTo(x, -hh); c.lineTo(x, hh); c.stroke(); }
  for (const sy of [-1, 1]) {
    c.fillStyle = '#6b4526'; c.fillRect(-hw, sy * hh - 3, hw * 2, 6);
    c.fillStyle = '#8a5c33'; c.fillRect(-hw, sy * hh - 3, hw * 2, 2.5);
    for (const px of [-T / 4, T / 4]) { c.fillStyle = '#5a3a1e'; c.fillRect(px - 2.5, sy * hh - 5, 5, 10); }
  }
  c.restore();
}

function drawRock(c, o) {
  const cx = (o.x + 0.5) * T, cy = (o.y + 0.5) * T;
  ellipse(c, cx, cy + T * 0.22, T * 0.36, T * 0.12, 'rgba(0,0,0,0.18)');
  const big = 0.7 + (o.v || 0.5) * 0.4;
  ellipse(c, cx - 4, cy + 2, T * 0.3 * big, T * 0.24 * big, '#9a9aa2', OUT, 2);
  ellipse(c, cx + T * 0.18, cy + 6, T * 0.17 * big, T * 0.13 * big, '#8a8a93', OUT, 2);
  ellipse(c, cx - 8, cy - 4, T * 0.12 * big, T * 0.06 * big, 'rgba(255,255,255,0.35)');
}

function drawTree(c, o, time) {
  const cx = (o.x + 0.5) * T, cy = (o.y + 0.5) * T;
  const sway = Math.sin(time * 1.2 + o.x * 0.7 + o.y) * 1.5;
  const sc = 0.85 + (o.v || 0.5) * 0.35;
  ellipse(c, cx, cy + T * 0.3, T * 0.42 * sc, T * 0.14, 'rgba(0,0,0,0.22)');
  rrect(c, cx - 5, cy - 4, 10, T * 0.38, 3, '#7a4f2c', OUT, 1.8);
  const col = o.v > 0.6 ? '#3f8f3a' : '#4d9e3f';
  for (const [dx, dy, rr] of [[-0.18, -0.12, 0.27], [0.18, -0.14, 0.26], [0, -0.38, 0.3]]) {
    circle(c, cx + dx * T * sc + sway, cy + dy * T * sc - 6, rr * T * sc, col, OUT, 2);
  }
  circle(c, cx - T * 0.08 * sc + sway, cy - T * 0.45 * sc - 6, T * 0.08 * sc, 'rgba(255,255,255,0.18)');
}

// The cottage yard: a flat, mown lawn with a pebble edging and stepping
// stones. Nothing upright, so it reads as walkable, just not plantable.
function drawYard(c, m, r) {
  const [bx, by] = m.baseTile;
  const x0 = Math.max(0, bx - 1) * T, y0 = Math.max(0, by - 1) * T;
  const x1 = Math.min(m.W, bx + 2) * T, y1 = Math.min(m.H, by + 2) * T;
  c.save();
  c.beginPath(); c.roundRect(x0 + 3, y0 + 3, x1 - x0 - 6, y1 - y0 - 6, T * 0.3); c.clip();
  // mown stripes
  for (let x = x0, i = 0; x < x1; x += T / 2, i++) { c.fillStyle = i % 2 ? '#9ad06a' : '#a6d878'; c.fillRect(x, y0, T / 2, y1 - y0); }
  c.restore();
  // pebble edging: a dotted ring of flat stones you can step over
  const per = 2 * ((x1 - x0) + (y1 - y0)) - 12;
  for (let d = 0; d < per; d += 11) {
    let x, y, e = d;
    const w = x1 - x0 - 6, h = y1 - y0 - 6;
    if (e < w) { x = x0 + 3 + e; y = y0 + 3; } else if ((e -= w) < h) { x = x1 - 3; y = y0 + 3 + e; }
    else if ((e -= h) < w) { x = x1 - 3 - e; y = y1 - 3; } else { e -= w; x = x0 + 3; y = y1 - 3 - e; }
    ellipse(c, x, y, 3.2 + r() * 1.2, 2.2 + r(), r() < 0.5 ? '#e9e2d0' : '#cfc6b2', 'rgba(90,80,60,0.45)', 1);
  }
  // stepping stones leading from the door out to each side of the yard
  const cx = (bx + 0.5) * T, cy = (by + 0.5) * T;
  for (const [dx, dy] of [[0, 1], [-1, 0], [1, 0], [0, -1]]) {
    if (m.pathTiles.has((by + dy) * m.W + bx + dx)) continue;
    for (const k of [0.62, 1.05]) {
      const sx = cx + dx * T * k + (r() - 0.5) * 4, sy = cy + dy * T * k + (dy ? 0 : 8);
      ellipse(c, sx, sy + 1.5, T * 0.15, T * 0.1, 'rgba(0,0,0,0.12)');
      ellipse(c, sx, sy, T * 0.15, T * 0.1, '#d9d2c0', 'rgba(90,80,60,0.55)', 1.2);
    }
  }
  // a few clover tufts and daisies in the lawn
  for (let i = 0; i < 10; i++) {
    const x = x0 + 10 + r() * (x1 - x0 - 20), y = y0 + 10 + r() * (y1 - y0 - 20);
    if (Math.abs(x - cx) < T * 0.6 && Math.abs(y - cy) < T * 0.6) continue;
    if (r() < 0.5) for (let k = 0; k < 3; k++) circle(c, x + Math.cos(k * 2.1) * 3, y + Math.sin(k * 2.1) * 3, 2.6, '#6fb84a');
    else { circle(c, x, y, 2.4, '#ffffff'); circle(c, x, y, 1, '#ffd23f'); }
  }
}

function paintBg(c, m) {
  const { W, H, worldW: WORLD_W, worldH: WORLD_H, paths: PATHS, pathTiles: PATH_TILES, blocked: BLOCKED } = m;
  const r = seededRandom(7 + m.index * 101);
  const area = (W * H) / (36 * 22);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) { c.fillStyle = (x + y) % 2 ? '#86c35a' : '#7fbd52'; c.fillRect(x * T, y * T, T, T); }
  // a few darker meadow patches for variety
  for (let i = 0; i < 14 * area; i++) {
    const g = c.createRadialGradient(0, 0, 0, 0, 0, 1);
    const x = r() * WORLD_W, y = r() * WORLD_H, rad = T * (2 + r() * 3);
    c.save(); c.translate(x, y); c.scale(rad, rad * 0.7);
    g.addColorStop(0, 'rgba(40,100,30,0.16)'); g.addColorStop(1, 'rgba(40,100,30,0)');
    c.fillStyle = g; c.beginPath(); c.arc(0, 0, 1, 0, Math.PI * 2); c.fill(); c.restore();
  }
  for (let i = 0; i < 5600 * area; i++) {
    c.fillStyle = r() < 0.5 ? 'rgba(255,255,255,0.07)' : 'rgba(0,70,0,0.09)';
    c.fillRect(r() * WORLD_W, r() * WORLD_H, 2, 2);
  }
  const tile = (x, y) => Math.floor(y / T) * W + Math.floor(x / T);
  const free = (x, y) => !PATH_TILES.has(tile(x, y)) && !BLOCKED.has(tile(x, y));
  c.strokeStyle = '#5f9e3c'; c.lineWidth = 2; c.lineCap = 'round';
  for (let i = 0; i < 640 * area; i++) {
    const x = r() * WORLD_W, y = r() * WORLD_H;
    if (!free(x, y)) continue;
    c.beginPath();
    c.moveTo(x, y); c.lineTo(x - 4, y - 7); c.moveTo(x, y); c.lineTo(x, y - 9); c.moveTo(x, y); c.lineTo(x + 4, y - 7);
    c.stroke();
  }
  const wild = ['#ffffff', '#ffe066', '#ff9ecd', '#b9a4ff'];
  for (let i = 0; i < 220 * area; i++) {
    const x = r() * WORLD_W, y = r() * WORLD_H;
    if (!free(x, y)) continue;
    const col = wild[Math.floor(r() * wild.length)];
    for (let k = 0; k < 3; k++) circle(c, x + (r() - 0.5) * 12, y + (r() - 0.5) * 8, 2.2, col);
  }
  drawYard(c, m, r);
  for (const o of m.obstacles) if (o.type === 'pond') drawPond(c, o, r);
  // roads: all edges first, then all surfaces, so crossings merge cleanly
  const roads = PATHS.map((p) => [{ x: p.spawn.x - Math.cos(p.dir) * T, y: p.spawn.y - Math.sin(p.dir) * T }, ...p.waypoints]);
  for (const pts of roads) strokePoly(c, pts.map((p) => ({ x: p.x, y: p.y + 4 })), T * 0.94, 'rgba(0,0,0,0.12)');
  for (const pts of roads) strokePoly(c, pts, T * 0.94, '#9c7444');
  for (const pts of roads) strokePoly(c, pts, T * 0.82, '#e0bf86');
  for (const pts of roads) strokePoly(c, pts, T * 0.42, 'rgba(255,240,205,0.35)');
  const pathTiles = [...PATH_TILES];
  for (let i = 0; i < pathTiles.length * 7; i++) {
    const k = pathTiles[Math.floor(r() * pathTiles.length)];
    const x = (k % W + 0.5) * T + (r() - 0.5) * T * 0.7, y = (Math.floor(k / W) + 0.5) * T + (r() - 0.5) * T * 0.7;
    ellipse(c, x, y, 1.5 + r() * 2.5, 1 + r() * 2, r() < 0.5 ? '#c49f68' : '#f0dcae');
  }
  // direction arrows painted on each road every few tiles
  c.fillStyle = 'rgba(150,110,60,0.35)';
  for (const path of PATHS) {
    const wp = path.waypoints;
    for (let i = 0; i < wp.length - 1; i++) {
      const a = wp[i], b = wp[i + 1];
      const ang = Math.atan2(b.y - a.y, b.x - a.x), len = Math.hypot(b.x - a.x, b.y - a.y);
      for (let d = T * 1.5; d < len - T; d += T * 3) {
        c.save(); c.translate(a.x + Math.cos(ang) * d, a.y + Math.sin(ang) * d); c.rotate(ang);
        c.beginPath(); c.moveTo(8, 0); c.lineTo(-6, -7); c.lineTo(-3, 0); c.lineTo(-6, 7); c.closePath(); c.fill();
        c.restore();
      }
    }
  }
  for (const d of m.decks) drawDeck(c, d);
  for (const o of m.obstacles) if (o.type === 'rock') drawRock(c, o);
  // a monster cave where each road enters the map
  for (const path of m.paths) {
    const ex = path.waypoints[0].x - Math.cos(path.dir) * T * 0.55, ey = path.waypoints[0].y - Math.sin(path.dir) * T * 0.55;
    c.save(); c.translate(ex, ey); c.rotate(path.dir);
    ellipse(c, -6, 0, T * 0.75, T * 0.85, '#5e5a66', OUT, 3);
    ellipse(c, -12, -T * 0.35, T * 0.3, T * 0.22, '#77737f');
    ellipse(c, 0, 0, T * 0.42, T * 0.55, '#1b1424');
    c.restore();
  }
}

function drawCottage(c, x, y, lives, maxLives, hitT, time) {
  const r = clamp(lives / maxLives, 0, 1);
  const shake = hitT > 0 ? Math.sin(time * 70) * 1.5 : 0;
  c.save(); c.translate(x + shake, y - 4);
  ellipse(c, 0, T * 0.42, T * 0.6, T * 0.14, 'rgba(0,0,0,0.25)');
  rrect(c, -T * 0.42, -T * 0.12, T * 0.84, T * 0.52, 4, hitT > 0 ? '#f7c9b8' : '#f3e3c3', OUT, 2.5);
  rrect(c, T * 0.18, -T * 0.62, T * 0.14, T * 0.3, 2, '#a5574a', OUT, 2);
  for (let i = 0; i < 3; i++) {
    const k = (time * 0.5 + i / 3) % 1;
    circle(c, T * 0.25 + Math.sin(k * 6 + i) * 5, -T * 0.66 - k * T * 0.6, 4 + k * 6, r < 0.35 ? `rgba(70,70,70,${0.6 * (1 - k)})` : `rgba(230,230,230,${0.5 * (1 - k)})`);
  }
  c.beginPath(); c.moveTo(-T * 0.55, -T * 0.08); c.lineTo(0, -T * 0.58); c.lineTo(T * 0.55, -T * 0.08); c.closePath();
  c.fillStyle = '#d6504a'; c.fill(); c.strokeStyle = OUT; c.lineWidth = 2.5; c.lineJoin = 'round'; c.stroke();
  rrect(c, -T * 0.09, T * 0.1, T * 0.18, T * 0.3, [6, 6, 0, 0], '#7a4b2a', OUT, 2);
  rrect(c, -T * 0.34, T * 0.02, T * 0.16, T * 0.14, 2, '#9fd8ff', OUT, 2);
  rrect(c, T * 0.18, T * 0.02, T * 0.16, T * 0.14, 2, '#9fd8ff', OUT, 2);
  // bite marks and cracks appear as the cottage gets chewed up
  c.strokeStyle = OUT; c.lineWidth = 1.5; c.lineCap = 'round';
  if (r < 0.7) { c.beginPath(); c.moveTo(-T * 0.38, -T * 0.05); c.lineTo(-T * 0.3, T * 0.05); c.lineTo(-T * 0.35, T * 0.14); c.stroke(); }
  if (r < 0.4) { c.beginPath(); c.moveTo(T * 0.4, T * 0.2); c.lineTo(T * 0.3, T * 0.27); c.lineTo(T * 0.36, T * 0.36); c.stroke(); circle(c, T * 0.42, -T * 0.02, 5, '#7fbd52'); }
  c.restore();
  // health bar
  const w = T * 1.1, bx = x - w / 2, by = y - T * 0.98;
  rrect(c, bx - 2, by - 2, w + 4, 11, 5, OUT);
  rrect(c, bx, by, Math.max(0, w * r), 7, 3, r > 0.5 ? '#6be06b' : r > 0.25 ? '#ffd23f' : '#ff6a5a');
  if (hitT > 0) label(c, '!', x + w / 2 + 10, by + 3, 16, '#ff6a5a', 'center', 700);
}

// ---- flower creatures -----------------------------------------------------
// Drawn in a 40-unit local space, then scaled by U. Each level adds a head.
const SPEC = {
  daisy:     { petal: '#ffffff', face: '#ffc93c', n: 10, len: 9,   w: 3.4, body: '#6cc24a', dark: '#3f8a2c' },
  sunflower: { petal: '#ffcc1f', face: '#8a5420', n: 14, len: 10.5, w: 3.8, body: '#5aa83c', dark: '#356b22', big: 1.2 },
  firelily:  { petal: '#ff7a2f', face: '#ffe066', n: 6,  len: 12,  w: 4.2, body: '#6b9a3a', dark: '#3d5e1e', pointy: true },
  stink:     { petal: '#9ad14b', face: '#7b3fa0', n: 5,  len: 10,  w: 6,   body: '#6d8f3a', dark: '#3e5520' },
  frost:     { petal: '#bff0ff', face: '#f4fdff', n: 6,  len: 12,  w: 3.6, body: '#6fa9bd', dark: '#3d6f80' },
  thorn:     { petal: '#ff4d5e', face: '#b3122e', n: 7,  len: 8.5, w: 5,   body: '#3f7a34', dark: '#244d1d' },
  snap:      { petal: '#e0569b', face: '#ffd1e6', n: 5,  len: 11,  w: 5.5, body: '#4f9a45', dark: '#2f6a2a', teeth: true },
};
const HEADS = [
  null,
  [[0, -14, 1]],
  [[-7, -13, 0.9], [7, -15, 0.95]],
  [[0, -21, 1], [-11, -10, 0.85], [11, -10, 0.85]],
  [[-6, -23, 0.95], [6, -23, 0.95], [-13, -11, 0.8], [13, -11, 0.8]],
  [[0, -27, 1.05], [-11, -19, 0.85], [11, -19, 0.85], [-15, -7, 0.72], [15, -7, 0.72]],
];
const LEVEL_SCALE = [0, 0.92, 0.95, 0.98, 1.01, 1.04]; // levels show in looks and attitude, not size
const WITHER = '#9a7b55';

// ---- flower heads, painted once and reused ---------------------------------
// A head has up to 14 stroked petals; a garden of level-5 flowers would mean
// thousands of path operations a frame. Each look (type × how withered ×
// mouth × crown) is painted once into a small canvas and stamped from then
// on. Only the pupils are drawn live, so the flowers still watch their targets.
const SPRITE_R = 20;        // head-local units from the centre to the sprite edge
let spriteScale = 4;        // sprite pixels per unit; follows the screen's pixel ratio
const sprites = new Map();

function sprite(key, paint) {
  let cv = sprites.get(key);
  if (!cv) {
    const size = Math.ceil(SPRITE_R * 2 * spriteScale);
    let g;
    ({ cv, c: g } = cacheCanvas(size, size));
    g.scale(spriteScale, spriteScale);
    g.translate(SPRITE_R, SPRITE_R);
    paint(g);
    sprites.set(key, cv);
  }
  return cv;
}
const stamp = (c, cv) => c.drawImage(cv, -SPRITE_R, -SPRITE_R, SPRITE_R * 2, SPRITE_R * 2);

function setSpriteScale(dpr) {
  const k = 2 * dpr; // heads are drawn at up to ~1.7 screen pixels per unit
  if (k !== spriteScale) { spriteScale = k; sprites.clear(); }
}

// Each flower type has its own personality, and its face changes with level
// in its own way (Thornrose gets angrier, Daisy happier, Frostbloom more
// serenely magical...). Returns what to draw; l is the flower's level.
const PERSONA = {
  daisy: (l) => ({ eyes: 'round', sparkle: l >= 4, cheeks: '#ff7896', mouth: l >= 3 ? 'bigsmile' : 'smile' }),
  sunflower: (l) => ({ eyes: 'round', squint: true, brows: l >= 4 ? 'flat' : null, mouth: 'smirk' }),
  firelily: (l) => ({ eyes: 'round', brows: 'cheeky', mouth: l >= 3 ? 'teethgrin' : 'grin' }),
  stink: (l) => ({ eyes: 'lazy', mouth: l >= 3 ? 'tongue' : 'smirk' }),
  frost: (l) => ({ eyes: 'round', iris: '#5ab8e8', lashes: true, sparkle: true, cheeks: '#8fd6ff', mouth: 'soft', tiara: l >= 3 ? 'ice' : null }),
  thorn: (l) => ({ eyes: 'round', narrow: l >= 4, brows: 'angry', anger: l, mouth: l >= 4 ? 'teethgrin' : l >= 2 ? 'scowl' : 'flat', fangs: l >= MAX_LEVEL }),
  snap: (l) => ({ eyes: 'round', lashes: true, cheeks: '#ff7896', mouth: 'jaw', teeth: 3 + l, tiara: l >= 2 && l < MAX_LEVEL ? 'pink' : null }),
};

// A flower face: petals around a disc with eyes and a mouth.
// o: { wither 0..1, spin (radians, petals only), look (radians), mouth
//      ('smile' normally, 'open' when firing, 'sad' when wilting), crown, lvl }
function drawHead(c, type, o = {}) {
  const w = Math.round((o.wither || 0) * 8) / 8;
  const mouth = o.mouth || 'smile', lvl = o.lvl || 1;
  const face = PERSONA[type](lvl);
  const petals = sprite(`p${type}${w}`, (g) => paintPetals(g, type, w));
  if (o.spin) { c.save(); c.rotate(o.spin); stamp(c, petals); c.restore(); } else stamp(c, petals);
  stamp(c, sprite(`f${type}${w}${mouth}${o.crown ? 1 : 0}${lvl}`, (g) => paintFace(g, type, w, mouth, o.crown, face)));
  if (mouth === 'sleep') return;
  const lx = o.look != null ? Math.cos(o.look) * 1.1 : 0, ly = o.look != null ? Math.sin(o.look) * 0.8 : 0;
  for (const ex of [-2.4, 2.4]) {
    if (face.iris) { circle(c, ex + lx * 0.7, -1.1 + ly * 0.7, 1.35, face.iris); circle(c, ex + lx * 0.7, -1.1 + ly * 0.7, 0.65, '#1a1a1a'); }
    else circle(c, ex + lx, -1.1 + ly, 1, '#1a1a1a');
    if (face.sparkle) circle(c, ex + lx * 0.7 + 0.5, -1.6 + ly * 0.7, 0.4, '#ffffff');
  }
  // the stinkbloom's lazy, droopy lids sit over its pupils
  if (face.eyes === 'lazy') {
    const lid = w ? mix(SPEC[type].face, WITHER, w * 0.6) : SPEC[type].face;
    for (const ex of [-2.4, 2.4]) {
      const low = -0.5;
      c.beginPath(); c.ellipse(ex, -1.2, 1.9, 2.3, 0, Math.PI, 0); c.lineTo(ex + 1.9, low); c.lineTo(ex - 1.9, low); c.closePath();
      c.fillStyle = lid; c.fill();
      c.strokeStyle = OUT; c.lineWidth = 0.9; c.beginPath(); c.moveTo(ex - 1.8, low); c.lineTo(ex + 1.8, low); c.stroke();
      if (face.lashes) { c.lineWidth = 0.6; c.beginPath(); for (const k of [-1, 0, 1]) { c.moveTo(ex + k * 1.1, low); c.lineTo(ex + k * 1.4, low + 0.9); } c.stroke(); }
    }
  }
}

function paintPetals(c, type, w) {
  const sp = SPEC[type];
  const petal = w ? mix(sp.petal, WITHER, w * 0.8) : sp.petal;
  if (sp.big) c.scale(sp.big, sp.big);
  for (let i = 0; i < sp.n; i++) {
    c.save(); c.rotate((i / sp.n) * Math.PI * 2);
    if (type === 'frost' || sp.pointy) {
      c.beginPath(); c.moveTo(4, 0); c.quadraticCurveTo(sp.len * 0.55, -sp.w * 1.2, sp.len + 3, 0); c.quadraticCurveTo(sp.len * 0.55, sp.w * 1.2, 4, 0);
      c.fillStyle = petal; c.fill(); c.strokeStyle = OUT; c.lineWidth = 1.3; c.stroke();
      if (sp.pointy) { c.strokeStyle = 'rgba(255,230,120,0.8)'; c.lineWidth = 1; c.beginPath(); c.moveTo(6, 0); c.lineTo(sp.len, 0); c.stroke(); }
    } else {
      ellipse(c, sp.len * 0.62, 0, sp.len * 0.55, sp.w, petal, OUT, 1.3);
      if (type === 'stink') circle(c, sp.len * 0.75, 0, 1.4, 'rgba(123,63,160,0.6)');
    }
    c.restore();
  }
  if (type === 'thorn') for (let i = 0; i < 5; i++) { c.save(); c.rotate((i / 5) * Math.PI * 2 + 0.3); ellipse(c, 4.5, 0, 4.5, 3.6, w ? mix('#e0283d', WITHER, w) : '#e0283d', OUT, 1.1); c.restore(); }
}

// Everything on the face except the pupils (and the eyelids, see drawHead).
function paintFace(c, type, w, mouth, crown, face) {
  const sp = SPEC[type];
  const fr = (type === 'sunflower' ? 7.5 : 6.2) * (sp.big || 1);
  circle(c, 0, 0, fr, w ? mix(sp.face, WITHER, w * 0.6) : sp.face, OUT, 1.5);
  if (type === 'sunflower') for (let i = 0; i < 6; i++) circle(c, Math.cos(i * 1.3) * 6, 3.5 + Math.sin(i * 2.3) * 1.8, 0.8, '#3d220c');
  c.lineCap = 'round';
  // eyes
  const eyeWhite = type === 'stink' ? '#e6ffb0' : '#ffffff';
  if (mouth === 'sleep') {
    c.strokeStyle = OUT; c.lineWidth = 1.1;
    for (const ex of [-2.4, 2.4]) { c.beginPath(); c.arc(ex, -1, 1.4, 0.2, Math.PI - 0.2); c.stroke(); }
  } else {
    for (const ex of [-2.4, 2.4]) ellipse(c, ex, -1.2, 1.7, face.narrow ? 1.5 : 2.1, eyeWhite, OUT, 0.9);
    if (face.squint) { c.strokeStyle = OUT; c.lineWidth = 1.2; c.beginPath(); c.moveTo(-4.5, -3.3); c.lineTo(4.5, -3.3); c.stroke(); }
    if (face.lashes && face.eyes === 'round') {
      c.strokeStyle = OUT; c.lineWidth = 0.7;
      for (const sx of [-1, 1]) { const ex = sx * 2.4; c.beginPath(); c.moveTo(ex + sx * 1.4, -2.4); c.lineTo(ex + sx * 2.5, -3.3); c.moveTo(ex + sx * 0.8, -3); c.lineTo(ex + sx * 1.4, -4.1); c.stroke(); }
    }
  }
  // brows
  c.strokeStyle = OUT;
  const brows = mouth === 'open' && type === 'thorn' ? 'angry' : face.brows;
  if (brows === 'angry') {
    const a = face.anger || 2, tilt = 0.6 + a * 0.4;
    c.lineWidth = 0.9 + a * 0.3;
    c.beginPath(); c.moveTo(-3.9, -3.4 - tilt); c.lineTo(-1.1, -3.1); c.moveTo(3.9, -3.4 - tilt); c.lineTo(1.1, -3.1); c.stroke();
  } else if (brows === 'flat') {
    c.lineWidth = 1.1; c.beginPath(); c.moveTo(-4, -4.1); c.lineTo(-1, -4.1); c.moveTo(4, -4.1); c.lineTo(1, -4.1); c.stroke();
  } else if (brows === 'cheeky') {
    c.lineWidth = 1; c.beginPath(); c.moveTo(-4, -3.6); c.lineTo(-1.2, -3.9); c.moveTo(1.2, -4.6); c.quadraticCurveTo(2.6, -5.6, 4, -4.8); c.stroke();
  }
  if (face.cheeks && mouth !== 'sad') { circle(c, -4, 1.6, 1.1, face.cheeks + '73'); circle(c, 4, 1.6, 1.1, face.cheeks + '73'); }
  // mouth
  c.strokeStyle = OUT; c.lineWidth = 1.1;
  const m = mouth === 'sad' ? 'sad' : mouth === 'open' ? (face.mouth === 'jaw' ? 'jawOpen' : 'open') : face.mouth;
  if (m === 'jaw' || m === 'jawOpen') {
    if (m === 'jaw') {
      // a sweet little smile... with two tiny fangs
      c.beginPath(); c.arc(0, 1.6, 1.8, 0.3, Math.PI - 0.3); c.stroke();
      c.fillStyle = '#ffffff'; c.lineWidth = 0.6;
      for (const fx of [-0.9, 0.9]) { c.beginPath(); c.moveTo(fx - 0.5, 3.2); c.lineTo(fx + 0.5, 3.2); c.lineTo(fx, 4.4); c.closePath(); c.fill(); c.stroke(); }
    } else {
      // the real jaw only shows when it bites; more teeth every level
      const open = 3.4;
      ellipse(c, 0, 3, 4.6, open, '#5a1a2a', OUT, 0.9);
      c.fillStyle = '#ffffff';
      const n = face.teeth || 4;
      for (let i = 0; i < n; i++) { const tx = -3.2 + (i / (n - 1)) * 6.4; c.beginPath(); c.moveTo(tx - 0.7, 3 - open + 0.3); c.lineTo(tx + 0.7, 3 - open + 0.3); c.lineTo(tx, 3 - open + 2); c.fill(); }
    }
  } else if (m === 'open') ellipse(c, 0, 2.6, 1.8, 2, type === 'firelily' ? '#ff9a3c' : type === 'stink' ? '#9ad14b' : '#5a1a1a', OUT, 0.9);
  else if (m === 'sad') { c.beginPath(); c.arc(0, 4.2, 1.6, Math.PI + 0.4, -0.4); c.stroke(); }
  else if (m === 'smile') { c.beginPath(); c.arc(0, 1.6, 1.6, 0.3, Math.PI - 0.3); c.stroke(); }
  else if (m === 'soft') { c.beginPath(); c.arc(0, 1.9, 1.1, 0.4, Math.PI - 0.4); c.stroke(); }
  else if (m === 'bigsmile') {
    // a wide open smile with a pink tongue filling the bottom of the mouth
    c.beginPath(); c.moveTo(-3.9, 0.8); c.quadraticCurveTo(0, 2.6, 3.9, 0.8); c.quadraticCurveTo(0, 7.2, -3.9, 0.8); c.closePath(); // a crescent: corners up
    c.fillStyle = '#7a2030'; c.fill();
    c.save(); c.clip(); ellipse(c, 0, 5.2, 2.6, 1.6, '#ff7d96'); c.restore();
    c.stroke();
  } else if (m === 'grin') { c.beginPath(); c.arc(0, 0.9, 2.8, 0.35, Math.PI - 0.35); c.stroke(); }
  else if (m === 'smirk' || m === 'tongue') {
    c.beginPath(); c.moveTo(-2, 2.6); c.quadraticCurveTo(0.5, 1.8, 2.2, 1.6); c.stroke();
    if (m === 'tongue') { ellipse(c, 0.9, 3.2, 1.1, 1.4, '#ff8fb0', OUT, 0.8); c.beginPath(); c.moveTo(0.9, 2.4); c.lineTo(0.9, 3.8); c.lineWidth = 0.5; c.stroke(); }
  } else if (m === 'flat') { c.beginPath(); c.moveTo(-1.8, 2.4); c.lineTo(1.8, 2.4); c.stroke(); }
  else if (m === 'scowl') { c.beginPath(); c.arc(0, 4, 2, Math.PI + 0.5, -0.5); c.stroke(); }
  else if (m === 'teethgrin') {
    rrect(c, -3.2, 1.6, 6.4, 2.6, 1.2, '#ffffff', OUT, 0.9);
    c.lineWidth = 0.6; c.beginPath(); for (const tx of [-1.6, 0, 1.6]) { c.moveTo(tx, 1.7); c.lineTo(tx, 4.1); } c.moveTo(-3, 2.9); c.lineTo(3, 2.9); c.stroke();
    if (face.fangs) { c.fillStyle = '#ffffff'; c.lineWidth = 0.8; for (const fx of [-2.2, 2.2]) { c.beginPath(); c.moveTo(fx - 0.9, 4.1); c.lineTo(fx + 0.9, 4.1); c.lineTo(fx, 6); c.closePath(); c.fill(); c.stroke(); } }
  }
  // headwear: a tiara for the princess and the ice queen, the crown at level 5
  if (face.tiara && !crown) {
    const ice = face.tiara === 'ice';
    c.fillStyle = ice ? '#e8fbff' : '#ffd1e6'; c.strokeStyle = OUT; c.lineWidth = 0.9; c.lineJoin = 'round';
    c.beginPath(); c.moveTo(-4, -fr + 0.5); c.lineTo(-3, -fr - 2.5); c.lineTo(-1.2, -fr - 1); c.lineTo(0, -fr - 4.5); c.lineTo(1.2, -fr - 1); c.lineTo(3, -fr - 2.5); c.lineTo(4, -fr + 0.5); c.closePath(); c.fill(); c.stroke();
    circle(c, 0, -fr - 1.6, 0.9, ice ? '#7fd8ff' : '#ff4f9a', OUT, 0.5);
  }
  if (crown) {
    c.fillStyle = '#ffd23f'; c.strokeStyle = OUT; c.lineWidth = 1.2; c.lineJoin = 'round';
    c.beginPath(); c.moveTo(-5, -fr - 1); c.lineTo(-5.5, -fr - 7); c.lineTo(-2.5, -fr - 4); c.lineTo(0, -fr - 8.5);
    c.lineTo(2.5, -fr - 4); c.lineTo(5.5, -fr - 7); c.lineTo(5, -fr - 1); c.closePath(); c.fill(); c.stroke();
  }
}

function drawSeedling(c, f, time) {
  const p = f.grow ? f.grow.paid / f.grow.cost : 1;
  const sp = SPEC[f.type];
  c.save(); c.translate(0, 12); c.scale(0.55 + 0.45 * p, 0.55 + 0.45 * p);
  c.strokeStyle = OUT; c.lineWidth = 3.4; c.lineCap = 'round';
  c.beginPath(); c.moveTo(0, 0); c.lineTo(0, -12); c.stroke();
  c.strokeStyle = sp.dark; c.lineWidth = 2; c.beginPath(); c.moveTo(0, 0); c.lineTo(0, -12); c.stroke();
  ellipse(c, -6, -9, 6, 2.6, sp.body, OUT, 1.2, -0.5 + Math.sin(time * 2) * 0.1);
  ellipse(c, 6, -9, 6, 2.6, sp.body, OUT, 1.2, 0.5 - Math.sin(time * 2) * 0.1);
  circle(c, 0, -17, 6, mix(sp.body, '#ffffff', 0.25), OUT, 1.4);
  ellipse(c, 0, -21, 3, 2.2, sp.petal, OUT, 1);
  c.strokeStyle = OUT; c.lineWidth = 1;
  for (const ex of [-2.2, 2.2]) { c.beginPath(); c.arc(ex, -17.5, 1.2, 0.2, Math.PI - 0.2); c.stroke(); }
  c.restore();
  if (Math.floor(time * 1.5 + f.id) % 3 === 0) label(c, 'z', 9, -16 - ((time * 6) % 4), 8, '#ffffff', 'center', 700, null);
}

// ---- flower bodies ------------------------------------------------------------
// Every flower type has its own body and its own way of getting stronger:
// the daisy grows more heads, the sunflower grows taller, the fire lily grows
// more vine-snakes, the stinkbloom gets fatter, the frostbloom more crystal,
// the thornrose more muscle and thorns, the snapdragon a longer neck.
// Each is drawn in the flower's 40-unit space with the soil at y = 12.

// One face, swaying, looking at the target, gaping when it fires.
function flowerHead(c, o, x, y, scale, i, firing, extra) {
  const { f, time, wither, lvl } = o;
  c.save();
  c.translate(x, y + Math.sin(time * 2 + i * 1.7 + f.id) * 0.7);
  c.rotate(Math.sin(time * 1.6 + i + f.id) * 0.08 + wither * (x < 0 ? -0.4 : 0.4));
  c.scale(scale, scale);
  drawHead(c, f.type, {
    look: f.angle, wither, crown: lvl === MAX_LEVEL && i === 0, lvl,
    mouth: firing ? 'open' : wither > 0.55 ? 'sad' : 'smile',
    spin: f.type === 'frost' ? time * 0.35 + i : 0, // the frostbloom turns slowly and serenely
  });
  if (extra) extra(c);
  c.restore();
}
const firingHead = (f, i) => f.flash > 0 && f.headIdx === i;

function stem(c, x0, y0, cx, cy, x1, y1, w, dark) {
  for (const [lw, col] of [[w + 1.6, OUT], [w, dark]]) {
    c.strokeStyle = col; c.lineWidth = lw; c.lineCap = 'round';
    c.beginPath(); c.moveTo(x0, y0); c.quadraticCurveTo(cx, cy, x1, y1); c.stroke();
  }
}

function leaf(c, x, y, len, ang, col) {
  c.save(); c.translate(x, y); c.rotate(ang);
  c.beginPath(); c.moveTo(0, 0); c.quadraticCurveTo(len * 0.5, -len * 0.35, len, 0); c.quadraticCurveTo(len * 0.5, len * 0.35, 0, 0);
  c.fillStyle = col; c.fill(); c.strokeStyle = OUT; c.lineWidth = 1.1; c.stroke();
  c.restore();
}

// Daisy: a leafy bouquet that sprouts another head every level.
function bodyBouquet(c, o) {
  const { f, lvl, time, wither, body, dark } = o;
  for (const sx of [-1, 1]) ellipse(c, sx * 5.5, 12, 4.2, 2.3, dark, OUT, 1.2);
  const wave = Math.sin(time * 3 + f.id) * 0.25 - (f.flash > 0 ? 0.7 : 0) + wither * 0.6;
  for (const sx of [-1, 1]) {
    c.save(); c.translate(sx * (7 + Math.min(lvl, 3)), 2); c.rotate(sx * wave);
    ellipse(c, sx * 5, 0, 6, 2.6, body, OUT, 1.3, sx * 0.25);
    c.restore();
  }
  ellipse(c, 0, 3, 8 + Math.min(lvl, 4), 10, body, OUT, 1.8);
  ellipse(c, -2.5, 1, 2.8, 5, 'rgba(255,255,255,0.18)');
  c.strokeStyle = dark; c.lineWidth = 1; c.beginPath(); c.moveTo(0, 10); c.lineTo(0, 4); c.moveTo(0, 7); c.lineTo(-2.5, 5); c.moveTo(0, 7); c.lineTo(2.5, 5); c.stroke(); // a leaf vein
  const heads = HEADS[lvl], droop = wither * 4;
  for (const [hx, hy] of heads) stem(c, hx * 0.3, -5, hx * 0.2, (hy + droop) * 0.6, hx, hy + droop + 4, 2, dark);
  heads.forEach(([hx, hy, hs], i) => flowerHead(c, o, hx, hy + droop, hs, i, firingHead(f, i)));
}

// Sunflower: a lone sniper on a stalk. Levels add gear rather than height:
// more leaves, a monocle (Lv3), a seed bandolier (Lv4), golden petal tips (Lv5).
function bodyStalk(c, o) {
  const { f, lvl, time, wither, body, dark } = o;
  const h = 22 + lvl, sway = Math.sin(time * 1.2 + f.id) * 1.5 + wither * 5;
  for (const sx of [-1, 1]) { c.strokeStyle = dark; c.lineWidth = 2; c.lineCap = 'round'; c.beginPath(); c.moveTo(0, 10); c.quadraticCurveTo(sx * 4, 12, sx * 7, 13); c.stroke(); }
  stem(c, 0, 11, sway * 0.3, -h * 0.4, sway, -h, 3.2, dark);
  for (let i = 0; i < Math.min(lvl + 1, 4); i++) {
    const t = 0.15 + i * 0.2, y = 11 - (11 + h) * t, sx = i % 2 ? 1 : -1;
    leaf(c, sway * t, y, 10, sx > 0 ? -0.5 + Math.sin(time * 2 + i) * 0.1 + wither : Math.PI + 0.5 - Math.sin(time * 2 + i) * 0.1 - wither, body);
  }
  if (lvl >= 4) {
    // a bandolier of seeds slung across the stalk
    c.strokeStyle = '#6b4220'; c.lineWidth = 2.2; c.beginPath(); c.moveTo(-6, -2); c.quadraticCurveTo(sway * 0.4, -6, 6, -12); c.stroke();
    for (let i = 0; i < 4; i++) { const t = 0.15 + i * 0.23; ellipse(c, -6 + 12 * t + sway * 0.2, -2 - 10 * t - Math.sin(t * Math.PI) * 2, 1.3, 2, '#3d220c', OUT, 0.7, 0.6); }
  }
  flowerHead(c, o, sway, -h - 3 + wither * 4, 1.05, 0, f.flash > 0, (g) => {
    if (lvl >= 3) {
      g.strokeStyle = '#3b3b45'; g.lineWidth = 0.9; g.beginPath(); g.arc(2.4, -1.2, 2.6, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.moveTo(4.9, -0.6); g.quadraticCurveTo(6.5, 3, 5, 6); g.stroke();
      g.fillStyle = 'rgba(200,235,255,0.35)'; g.beginPath(); g.arc(2.4, -1.2, 2.3, 0, Math.PI * 2); g.fill();
    }
    if (lvl >= MAX_LEVEL) for (let i = 0; i < 14; i++) { const a = (i / 14) * Math.PI * 2; circle(g, Math.cos(a) * 13.5, Math.sin(a) * 13.5, 1.2, '#fff6c0'); }
  });
}

// Fire lily: an onion bulb with writhing vines, each ending in a fiery snake head.
function bodyVines(c, o) {
  const { f, lvl, time, wither, body, dark } = o;
  ellipse(c, 0, 6, 8 + lvl * 0.6, 7, mix(body, '#c9893f', 0.35), OUT, 1.6);
  c.strokeStyle = dark; c.lineWidth = 0.9;
  for (const sx of [-3, 0, 3]) { c.beginPath(); c.moveTo(sx, 0); c.quadraticCurveTo(sx * 1.4, 6, sx, 12); c.stroke(); }
  const n = lvl, spread = n === 1 ? 0 : 1.7;
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (n === 1 ? 0 : (i / (n - 1) - 0.5) * spread);
    const len = 17 + lvl * 1.6 - (i % 2) * 3;
    const wr = Math.sin(time * 2.2 + i * 1.9 + f.id) * 4;
    const hx = Math.cos(a) * len + wr * 0.4, hy = 1 + Math.sin(a) * len + wither * 6;
    const cx = Math.cos(a) * len * 0.5 - Math.sin(a) * wr * 2, cy = 1 + Math.sin(a) * len * 0.5 + Math.cos(a) * wr;
    stem(c, Math.cos(a) * 3, 0, cx, cy, hx, hy + 4, 2.2, dark);
    // a curly tendril halfway up
    c.strokeStyle = dark; c.lineWidth = 1; c.beginPath(); c.arc(cx + 2.5, cy, 2, 0, Math.PI * 1.6); c.stroke();
    flowerHead(c, o, hx, hy, 0.78, i, firingHead(f, i), wither ? null : (g) => {
      const fl = Math.sin(time * 14 + i * 3) * 1.5;
      ellipse(g, 0, -11 - fl, 2.2, 3.5 + fl * 0.5, 'rgba(255,170,60,0.85)');
      ellipse(g, 0, -10.5 - fl, 1.1, 2, 'rgba(255,240,150,0.95)');
    });
  }
}

// Stinkbloom: a corpse flower. Five huge spotted petals lie on the ground
// around a pit, and the face peeks out of it. Levels add more spots, buzzing
// flies, dripping goo and thicker stink rather than size.
function bodyRafflesia(c, o) {
  const { f, lvl, time, wither } = o;
  const petal = wither ? mix('#9b3b5c', '#8c7a4a', wither * 0.8) : '#9b3b5c';
  const spot = wither ? mix('#e9d8a6', '#b9ab88', wither) : '#e9d8a6';
  const cy = 6, breathe = 1 + Math.sin(time * 2 + f.id) * 0.03 + (f.flash > 0 ? 0.08 : 0);
  // five fat petals, seen from the side so they sit flat on the ground
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i / 5) * Math.PI * 2 + 0.3;
    c.save(); c.translate(0, cy); c.scale(breathe, 0.55 * breathe); c.rotate(a);
    ellipse(c, 10, 0, 9, 7, petal, OUT, 1.8);
    for (let k = 0; k < 1 + lvl; k++) circle(c, 6 + (k % 3) * 3.2, -3 + Math.floor(k / 3) * 4 + (k % 2) * 1.5, 1.1 + (k % 2) * 0.5, spot);
    c.restore();
  }
  // the pit in the middle
  ellipse(c, 0, cy - 0.5, 7.5, 4, '#4a1630', OUT, 1.5);
  ellipse(c, 0, cy - 1.3, 6, 2.4, '#2a0a1a');
  // dripping goo from Lv3
  if (lvl >= 3) for (let i = 0; i < lvl - 2; i++) {
    const x = -9 + i * 8, k = (time * 0.6 + i * 0.4 + f.id * 0.2) % 1;
    ellipse(c, x, cy + 4 + k * 4, 1, 1.2 + k * 1.5, `rgba(154,209,75,${0.9 - k * 0.6})`);
  }
  // stink rising, thicker each level
  for (let i = 0; i < 1 + lvl; i++) {
    const k = (time * 0.7 + i / (1 + lvl) + f.id * 0.1) % 1;
    circle(c, Math.sin(k * 7 + i) * 9, cy - 6 - k * 20, 1.3 + k * 2.6, `rgba(154,209,75,${0.55 * (1 - k)})`);
  }
  flowerHead(c, o, 0, cy - 6, 0.68, 0, f.flash > 0);
  // flies buzzing around it from Lv2
  for (let i = 0; i < lvl - 1; i++) {
    const a = time * (3 + i * 0.7) + i * 2.1 + f.id;
    const x = Math.cos(a) * (13 + i * 2), y = cy - 10 + Math.sin(a * 1.3) * 6;
    ellipse(c, x - 1, y - 1.2, 1.3, 0.8, 'rgba(220,240,255,0.8)', null, 1, -0.5 + Math.sin(time * 40 + i) * 0.4);
    ellipse(c, x + 1, y - 1.2, 1.3, 0.8, 'rgba(220,240,255,0.8)', null, 1, 0.5 - Math.sin(time * 40 + i) * 0.4);
    circle(c, x, y, 1.1, '#1a1a1a');
  }
}

// Frostbloom: a cluster of ice crystals; more and bigger shards each level,
// with shards orbiting the head from level 3.
function bodyCrystal(c, o) {
  const { f, lvl, time, wither } = o;
  const ice = wither ? mix('#bfefff', '#9aa6aa', wither) : '#bfefff', deep = wither ? mix('#6fb7d6', '#7a8488', wither) : '#6fb7d6';
  const n = 2 + lvl;
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1) - 0.5, a = -Math.PI / 2 + t * 1.6;
    const len = 12 * (1 - Math.abs(t) * 0.5), w = 3.2;
    c.save(); c.translate(t * 10, 11); c.rotate(a + Math.PI / 2);
    c.beginPath(); c.moveTo(-w, 0); c.lineTo(-w * 0.8, -len * 0.8); c.lineTo(0, -len); c.lineTo(w * 0.8, -len * 0.8); c.lineTo(w, 0); c.closePath();
    c.fillStyle = i % 2 ? ice : deep; c.fill(); c.strokeStyle = OUT; c.lineWidth = 1.2; c.stroke();
    c.strokeStyle = 'rgba(255,255,255,0.7)'; c.lineWidth = 0.8; c.beginPath(); c.moveTo(-w * 0.3, -2); c.lineTo(-w * 0.2, -len * 0.75); c.stroke();
    c.restore();
  }
  const hy = -12;
  // a few twinkles drifting slowly upwards: it's a gentle, magical thing
  for (let i = 0; i < 1 + lvl; i++) {
    const k = (time * 0.25 + i / (1 + lvl) + f.id * 0.13) % 1, a = i * 2.4 + f.id;
    c.globalAlpha = Math.sin(k * Math.PI) * 0.9;
    star(c, Math.cos(a) * (9 + (i % 3) * 3), 6 - k * 30, 1.6 + Math.sin(time * 4 + i) * 0.6, '#ffffff', null);
    c.globalAlpha = 1;
  }
  stem(c, 0, 4, 0, hy * 0.5, 0, hy + 4, 2.4, deep);
  flowerHead(c, o, 0, hy, 1, 0, f.flash > 0);
  for (let i = 0; i < lvl - 2; i++) {
    const a = time * 1.4 + (i / (lvl - 2)) * Math.PI * 2;
    const ox = Math.cos(a) * 15, oy = hy + Math.sin(a) * 6;
    c.save(); c.translate(ox, oy); c.rotate(a * 2);
    c.beginPath(); c.moveTo(0, -3.5); c.lineTo(1.6, 0); c.lineTo(0, 3.5); c.lineTo(-1.6, 0); c.closePath();
    c.fillStyle = '#e8fbff'; c.fill(); c.strokeStyle = OUT; c.lineWidth = 0.8; c.stroke();
    c.restore();
  }
}

// Thornrose: a muscly brute. Levels add thorns rather than size: more on the
// chest, then on the arms (Lv3), spiked shoulders (Lv4), a thorn crown (Lv5).
function bodyBrute(c, o) {
  const { f, lvl, time, wither, body, dark } = o;
  const thornCol = wither ? mix('#e8e2d0', '#9a8a6a', wither) : '#e8e2d0';
  const flex = f.flash > 0 ? 1 : 0.35 + Math.sin(time * 2 + f.id) * 0.15;
  const tw = 9;
  const thorn = (x, y, a, len = 3.5) => {
    c.save(); c.translate(x, y); c.rotate(a);
    c.beginPath(); c.moveTo(-1.2, 0); c.lineTo(0, -len); c.lineTo(1.2, 0); c.closePath();
    c.fillStyle = thornCol; c.fill(); c.strokeStyle = OUT; c.lineWidth = 0.8; c.stroke();
    c.restore();
  };
  for (const sx of [-1, 1]) rrect(c, sx * 4 - 2.5, 7, 5, 6, 2, dark, OUT, 1.1); // stubby root legs
  for (const sx of [-1, 1]) {
    const shx = sx * (tw - 1), shy = -3, ex = shx + sx * 6, ey = shy + 2, hx = ex + sx * 1.5, hy = ey - 6 - flex * 5;
    stem(c, shx, shy, ex, ey + 2, hx, hy, 3.6, body);
    const bx = (shx + ex) / 2 + sx * 0.5, by = shy + 0.5 - flex * 1.5;
    circle(c, bx, by, 4.5 * (0.8 + flex * 0.3), body, OUT, 1.2);
    if (lvl >= 3) for (let k = 0; k < lvl - 1; k++) thorn(bx + sx * (k - 1) * 2, by - 3.6, sx * (0.4 + k * 0.25), 3);
    circle(c, hx, hy, 3, dark, OUT, 1.1);
    if (lvl >= 4) for (let k = 0; k < 3; k++) thorn(shx + sx * k * 1.8 - sx * 1, shy - 2.5 - (k === 1 ? 0.8 : 0), sx * (0.2 + k * 0.4), 4.5);
  }
  c.beginPath(); c.moveTo(-tw, -5); c.quadraticCurveTo(0, -9, tw, -5); c.quadraticCurveTo(tw * 0.7, 6, 3.5, 9); c.lineTo(-3.5, 9); c.quadraticCurveTo(-tw * 0.7, 6, -tw, -5);
  c.fillStyle = body; c.fill(); c.strokeStyle = OUT; c.lineWidth = 1.6; c.stroke();
  c.strokeStyle = dark; c.lineWidth = 1; c.beginPath(); c.moveTo(0, -6); c.lineTo(0, 6); c.moveTo(-4, -1); c.quadraticCurveTo(-2, 1, 0, -1); c.moveTo(4, -1); c.quadraticCurveTo(2, 1, 0, -1); c.stroke();
  const nThorns = 2 + lvl * 2;
  for (let i = 0; i < nThorns; i++) {
    const t = nThorns === 1 ? 0.5 : i / (nThorns - 1), sx = t < 0.5 ? -1 : 1;
    thorn((t - 0.5) * tw * 1.7, -4 + Math.abs(t - 0.5) * 3 + (i % 2) * 7, sx * (0.9 + (i % 3) * 0.3), 3 + (i % 2));
  }
  flowerHead(c, o, 0, -15 + wither * 3, 1, 0, f.flash > 0, lvl >= MAX_LEVEL ? (g) => {
    // a ring of thorns around the rose
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + 0.3; g.save(); g.rotate(a); g.translate(0, -11.5);
      g.beginPath(); g.moveTo(-1.2, 0); g.lineTo(0, -4); g.lineTo(1.2, 0); g.closePath(); g.fillStyle = thornCol; g.fill(); g.strokeStyle = OUT; g.lineWidth = 0.8; g.stroke(); g.restore();
    }
  } : null);
}

// Snapdragon: a flytrap on a thick, segmented neck that lunges at whatever it
// bites, standing on wriggling root-tentacles, with a ring of spiky leaves
// behind its jaw. The neck grows and the collar gets spikier each level.
function bodyTrap(c, o) {
  const { f, lvl, time, wither, body, dark } = o;
  const roots = 2 + lvl;
  for (let i = 0; i < roots; i++) {
    const t = i / (roots - 1) - 0.5, wig = Math.sin(time * 3 + i * 1.3 + f.id) * 2;
    c.lineCap = 'round';
    for (const [lw, col] of [[4, OUT], [2.4, dark]]) {
      c.strokeStyle = col; c.lineWidth = lw;
      c.beginPath(); c.moveTo(t * 6, 8); c.quadraticCurveTo(t * 16, 9 + wig, t * 26, 12 + Math.abs(t) * 3 - wig * 0.5); c.stroke();
    }
  }
  ellipse(c, 0, 6, 7.5, 5.5, body, OUT, 1.5);
  const reach = 16 + lvl, lunge = f.flash > 0 ? 6 : 0;
  const ax = Math.cos(f.angle || -Math.PI / 2), ay = Math.sin(f.angle || -Math.PI / 2);
  const hx = ax * (4 + lunge) * 0.8, hy = -reach + Math.min(0, ay) * lunge + wither * 6;
  const coil = Math.sin(time * 1.8 + f.id) * 5;
  const nw = 4.2;
  stem(c, 0, 3, -9 + coil, -reach * 0.45, hx, hy + 4, nw, dark);
  // neck segments
  for (let i = 1; i < 4; i++) {
    const t = i / 4, mx = 2 * (1 - t) * t * (-9 + coil) + t * t * hx, my = (1 - t) * (1 - t) * 3 + 2 * (1 - t) * t * (-reach * 0.45) + t * t * (hy + 4);
    ellipse(c, mx, my, nw * 0.7, nw * 0.3, body, null);
  }
  // a ring of spiky leaves behind the jaw
  const spikes = 5 + lvl;
  c.save(); c.translate(hx, hy); c.rotate(Math.sin(time * 1.3 + f.id) * 0.1);
  for (let i = 0; i < spikes; i++) {
    const a = (i / spikes) * Math.PI * 2, len = 14 + (i % 2) * 2;
    c.save(); c.rotate(a);
    c.beginPath(); c.moveTo(4, -2.6); c.lineTo(len, 0); c.lineTo(4, 2.6); c.closePath();
    c.fillStyle = i % 2 ? dark : body; c.fill(); c.strokeStyle = OUT; c.lineWidth = 1; c.stroke();
    c.restore();
  }
  c.restore();
  flowerHead(c, o, hx, hy, 1.05, 0, f.flash > 0);
}

const BODIES = { daisy: bodyBouquet, sunflower: bodyStalk, firelily: bodyVines, stink: bodyRafflesia, frost: bodyCrystal, thorn: bodyBrute, snap: bodyTrap };

function drawFlower(c, f, time) {
  const sp = SPEC[f.type];
  const hpR = clamp(f.hp / FLOWER_HP, 0, 1);
  const wither = f.lvl < MAX_LEVEL ? clamp((0.7 - hpR) / 0.7, 0, 1) : 0;
  c.save(); c.translate(f.x, f.y);
  ellipse(c, 0, T * 0.22, T * 0.36, T * 0.14, '#6b4a2b');
  ellipse(c, 0, T * 0.19, T * 0.31, T * 0.1, '#8a6038');
  c.scale(U, U);
  if (f.lvl === 0) { drawSeedling(c, f, time); c.restore(); return; }
  const lvl = f.lvl;
  const k = LEVEL_SCALE[lvl];
  const breathe = Math.sin(time * 2.4 + f.id) * 0.03;
  const fire = f.flash > 0 ? 0.08 : 0;
  const hurt = f.hurtT > 0 ? Math.sin(time * 80) * 1.2 : 0;
  c.translate(hurt, 12); c.scale(k * (1 + fire * 0.6), k * (1 + breathe - fire)); c.translate(0, -12);
  if (lvl === MAX_LEVEL) circle(c, 0, -12, 28, `rgba(255,232,120,${0.2 + Math.sin(time * 3 + f.id) * 0.07})`);
  else if (lvl === 4) circle(c, 0, -10, 24, `rgba(220,240,255,${0.12 + Math.sin(time * 3 + f.id) * 0.05})`);
  const body = wither ? mix(sp.body, '#8c7a4a', wither * 0.8) : sp.body;
  const dark = wither ? mix(sp.dark, '#5e4a2a', wither * 0.8) : sp.dark;
  (BODIES[f.type] || bodyBouquet)(c, { f, sp, lvl, time, wither, body, dark });
  c.restore();
  if (wither > 0.75 && Math.floor(time * 3) % 2) label(c, '!', f.x + T * 0.32, f.y - T * 0.5, 16, '#ff6a5a', 'center', 700);
}

const onFlower = (s, p, f) => p.loadout && p.stun <= 0 && Math.floor(p.x / T) === f.tx && Math.floor(p.y / T) === f.ty;

// What the next level (and healing) costs the cat standing on this flower,
// shown right above it so nobody has to look down at the HUD. Each cat pays
// its own price, so two cats on one flower get a row each.
function drawCostTag(c, f, s) {
  s.players.filter((q) => onFlower(s, q, f)).forEach((p, row) => drawCostRow(c, f, p, row));
}

function drawCostRow(c, f, p, row) {
  const tags = [];
  if (p.mode === 'dig') tags.push(['dig', `+${uprootRefund(f)}`, '#e0a060']);
  else if (f.lvl >= MAX_LEVEL) tags.push(['', 'MAX', '#ffd23f']);
  else {
    tags.push([`Lv${f.lvl + 1}`, `${upgradeLeft(p, f)}`, '#ffe27a']);
    if (f.lvl > 0 && f.hp < FLOWER_HP - 0.5) tags.push(['heal', `${healLeft(p, f)}`, '#8dff9a']);
  }
  c.font = `700 12px ${FONT}`;
  const parts = tags.map(([a, b, col]) => ({ a, b, col, w: (a ? c.measureText(a + ' ').width : 0) + c.measureText(b).width + (a === '' || a === 'dig' ? 0 : 16) + 14 }));
  const total = parts.reduce((t, q) => t + q.w, 0) + (parts.length - 1) * 4;
  let x = f.x - total / 2;
  const y = f.y - T * 1.22 - row * 24; // above the cat's P1/P2 badge
  for (const q of parts) {
    rrect(c, x, y - 10, q.w, 20, 10, 'rgba(20,28,36,0.85)', q.col, 1.5);
    let tx = x + 7;
    if (q.a) { label(c, q.a, tx, y + 0.5, 11, '#dce7ef', 'left', 600, null); c.font = `600 11px ${FONT}`; tx += c.measureText(q.a + ' ').width; }
    if (q.a !== '' && q.a !== 'dig') { coinIcon(c, tx + 5, y, 5.5); tx += 13; }
    label(c, q.b, tx, y + 0.5, 12, q.col, 'left', 700, null);
    x += q.w + 4;
  }
}

function drawFlowerStatus(c, f, s) {
  drawCostTag(c, f, s);
  const workers = s.players.filter((p) => p.working === f);
  if (f.grow) {
    const p = f.grow.paid / f.grow.cost;
    const r = T * 0.46;
    c.lineCap = 'round';
    c.beginPath(); c.arc(f.x, f.y, r, 0, Math.PI * 2); c.strokeStyle = 'rgba(0,0,0,0.35)'; c.lineWidth = 6; c.stroke();
    c.beginPath(); c.arc(f.x, f.y, r, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2);
    c.strokeStyle = workers.length ? '#ffe066' : '#9be15d'; c.lineWidth = 4; c.stroke();
    if (!s.players.some((q) => onFlower(s, q, f)) && (f.lvl > 0 || !workers.length)) label(c, `${f.lvl > 0 ? 'Lv' + f.grow.to + ' ' : ''}${Math.floor(p * 100)}%`, f.x, f.y - T * 0.62, 12, '#ffe27a');
  }
  if (f.lvl > 0 && f.lvl < MAX_LEVEL && f.hp < FLOWER_HP) {
    const w = T * 0.6, x = f.x - w / 2, y = f.y + T * 0.36;
    const r = f.hp / FLOWER_HP;
    rrect(c, x - 1.5, y - 1.5, w + 3, 7, 3, OUT);
    rrect(c, x, y, Math.max(0, w * r), 4, 2, r > 0.6 ? '#6be06b' : r > 0.3 ? '#ffd23f' : '#ff6a5a');
  }
  const digger = workers.find((p) => p.mode === 'dig' && p.dig > 0);
  if (digger) {
    const r = T * 0.52;
    c.lineCap = 'round';
    c.beginPath(); c.arc(f.x, f.y, r, 0, Math.PI * 2); c.strokeStyle = 'rgba(0,0,0,0.35)'; c.lineWidth = 6; c.stroke();
    c.beginPath(); c.arc(f.x, f.y, r, -Math.PI / 2, -Math.PI / 2 + Math.min(1, digger.dig) * Math.PI * 2);
    c.strokeStyle = '#e0a060'; c.lineWidth = 4; c.stroke();
  }
  if (f.lvl > 1) label(c, `${f.lvl}`, f.x + T * 0.36, f.y + T * 0.22, 11, f.lvl === MAX_LEVEL ? '#ffd23f' : '#ffffff', 'center', 700);
}

function drawWorkStream(c, p, time) {
  const f = p.working;
  if (p.mode === 'dig') {
    // clods of dirt flicking up from the flower's roots
    for (let i = 0; i < 4; i++) {
      const k = (time * 3 + i / 4) % 1, side = i % 2 ? 1 : -1;
      circle(c, f.x + side * (6 + k * 18), f.y + T * 0.25 - Math.sin(k * Math.PI) * T * 0.45, 3.5 - k * 1.5, '#8a5a32', OUT, 1);
    }
    return;
  }
  const heal = p.healing;
  for (let i = 0; i < 3; i++) {
    const k = (time * 2.5 + i / 3) % 1;
    const x = p.x + (f.x - p.x) * k, y = p.y + (f.y - T * 0.2 - p.y) * k - Math.sin(k * Math.PI) * T * 0.5;
    if (heal) label(c, '+', x, y, 14, '#8dff9a', 'center', 700);
    else circle(c, x, y, 3.5, '#ffd23f', OUT, 1.2);
  }
}

function drawCloud(c, cl, time) {
  const life = cl.t / cl.dur;
  const a = Math.min(1, cl.t * 4) * (1 - Math.max(0, life - 0.75) * 4);
  c.save(); c.globalAlpha = Math.max(0, a) * 0.5;
  for (let i = 0; i < 7; i++) {
    const ang = i * 0.9 + time * 0.4 + cl.id;
    const rr = cl.r * (0.45 + 0.15 * Math.sin(time * 2 + i));
    circle(c, cl.x + Math.cos(ang) * cl.r * 0.45, cl.y + Math.sin(ang) * cl.r * 0.3, rr, i % 2 ? '#8fc63e' : '#a8d65a');
  }
  c.globalAlpha = Math.max(0, a) * 0.9;
  for (let i = 0; i < 4; i++) {
    const k = (time * 0.8 + i / 4) % 1;
    circle(c, cl.x + Math.sin(i * 2.3 + cl.id) * cl.r * 0.6, cl.y - k * cl.r * 0.6, 2 + k * 2, null, '#5b7a1e', 1.2);
  }
  c.restore();
}

// ---- enemies ---------------------------------------------------------------
const BODY = {
  grunt: '#9b7bc8', swarm: '#e2b93b', runner: '#f08a3c', flyer: '#5f6bd6', wasp: '#ffd23f',
  shield: '#5b95dc', healer: '#5cc97f', tank: '#7b6250', boss: '#d43a3a', dasher: '#3cc6b4',
  splitter: '#c66bd8', blobling: '#ec9af0', mole: '#8a6a55', aphid: '#a6e07a', hive: '#e0a63a',
  woolly: '#c9783a', hopper: '#8cc63f', charger: '#4a3a5c',
};

function eyes(c, r, ang, angry) {
  const ex = Math.cos(ang) * r * 0.16, ey = Math.sin(ang) * r * 0.1;
  for (const sx of [-1, 1]) {
    circle(c, sx * r * 0.36 + ex, -r * 0.15 + ey, r * 0.25, '#fff', OUT, 1.2);
    circle(c, sx * r * 0.36 + ex * 1.6, -r * 0.13 + ey * 1.6, r * 0.12, '#1a1a1a');
  }
  if (angry) {
    c.strokeStyle = OUT; c.lineWidth = Math.max(1.5, r * 0.1); c.lineCap = 'round';
    c.beginPath(); c.moveTo(-r * 0.6 + ex, -r * 0.5 + ey); c.lineTo(-r * 0.15 + ex, -r * 0.35 + ey);
    c.moveTo(r * 0.6 + ex, -r * 0.5 + ey); c.lineTo(r * 0.15 + ex, -r * 0.35 + ey); c.stroke();
  }
}

function dart(c, r, col) {
  c.beginPath(); c.moveTo(r * 1.35, 0); c.quadraticCurveTo(0, -r * 1.2, -r, -r * 0.6);
  c.quadraticCurveTo(-r * 0.5, 0, -r, r * 0.6); c.quadraticCurveTo(0, r * 1.2, r * 1.35, 0);
  c.fillStyle = col; c.fill(); c.strokeStyle = OUT; c.lineWidth = 2; c.stroke();
}

function drawEnemy(c, e, time) {
  const r = e.def.r;
  const fly = e.def.flying;
  if (e.under) {
    const bump = Math.abs(Math.sin(e.wob * 1.5)) * 2;
    ellipse(c, e.x, e.y + 3, r * 1.1, r * 0.55 + bump, '#7a5434', OUT, 2);
    ellipse(c, e.x - r * 0.3, e.y, r * 0.35, r * 0.18, '#9c7444');
    circle(c, e.x + Math.cos(time * 9) * r, e.y + 4, 2, '#9c7444');
    return;
  }
  // a grasshopper mid-leap is up in the air, out of reach of ground flowers
  const leap = e.dashing && e.def.dash?.leap;
  const hop = fly ? Math.sin(e.wob) * 3 - T * 0.35 : leap ? -T * 0.38 : -Math.abs(Math.sin(e.wob)) * 2.5;
  const flash = e.flash > 0;
  const col = flash ? '#ffffff' : BODY[e.type];
  ellipse(c, e.x, e.y + r * 0.75, r * (fly || leap ? 0.7 : 0.95), r * 0.35, 'rgba(0,0,0,0.22)');
  c.save();
  c.translate(e.x, e.y + hop);
  const sq = (fly ? 0 : Math.sin(e.wob * 2) * (e.type === 'splitter' || e.type === 'blobling' ? 0.14 : 0.06)) + hitSquash(e.id) * 0.22;
  c.scale(1 + sq, 1 - sq);
  if (e.def.heals) {
    const k = (time * 1.2) % 1;
    circle(c, 0, 0, r + k * 16 * U, null, `rgba(120,255,160,${0.6 * (1 - k)})`, 2);
  }
  switch (e.type) {
    case 'flyer':
    case 'wasp': {
      const flap = Math.sin(e.wob * (e.type === 'wasp' ? 4 : 2.2)) * 8 * U;
      if (e.type === 'wasp') {
        c.globalAlpha = 0.7;
        for (const sx of [-1, 1]) ellipse(c, sx * r * 0.9, -r * 0.7 - flap * 0.3, r * 0.9, r * 0.45, '#e6f6ff', OUT, 1.2, sx * 0.5);
        c.globalAlpha = 1;
        c.save(); c.rotate(e.ang);
        ellipse(c, 0, 0, r * 1.3, r * 0.85, col, OUT, 2);
        c.fillStyle = flash ? '#fff' : '#2b2118';
        for (const sx of [-0.35, 0.25]) c.fillRect(sx * r - 1.5, -r * 0.75, 3.5, r * 1.5);
        c.beginPath(); c.moveTo(-r * 1.3, 0); c.lineTo(-r * 1.9, 0); c.strokeStyle = OUT; c.lineWidth = 2; c.stroke();
        c.restore();
        eyes(c, r, e.ang, true);
        break;
      }
      c.fillStyle = flash ? '#fff' : '#3c46a8'; c.strokeStyle = OUT; c.lineWidth = 1.8; c.lineJoin = 'round';
      for (const sx of [-1, 1]) {
        c.beginPath(); c.moveTo(sx * r * 0.5, 0); c.lineTo(sx * (r + 14 * U), -6 * U - flap);
        c.lineTo(sx * (r + 8 * U), 2 * U); c.lineTo(sx * (r + 4 * U), 6 * U); c.closePath(); c.fill(); c.stroke();
      }
      circle(c, 0, 0, r, col, OUT, 2);
      eyes(c, r, e.ang, false);
      break;
    }
    case 'runner':
    case 'dasher': {
      c.save(); c.rotate(e.ang);
      if (e.dashing) {
        c.strokeStyle = 'rgba(255,255,255,0.8)'; c.lineWidth = 2; c.lineCap = 'round';
        for (const ly of [-0.5, 0, 0.5]) { c.beginPath(); c.moveTo(-r * 1.4, ly * r); c.lineTo(-r * 2.8, ly * r); c.stroke(); }
      }
      dart(c, r, col);
      if (e.type === 'dasher') {
        c.fillStyle = flash ? '#fff' : '#1f8a7c';
        for (const sx of [-0.4, 0.2]) { c.beginPath(); c.moveTo(sx * r, -r * 0.5); c.lineTo(sx * r - r * 0.5, -r * 1.05); c.lineTo(sx * r + r * 0.2, -r * 0.6); c.fill(); }
      }
      c.restore();
      eyes(c, r, e.ang, true);
      break;
    }
    case 'tank':
    case 'boss': {
      rrect(c, -r, -r, r * 2, r * 2, r * 0.4, col, OUT, 2.5);
      if (e.type === 'tank') {
        rrect(c, -r * 0.8, r * 0.25, r * 1.6, r * 0.5, 3, flash ? '#fff' : '#5a4636', OUT, 1.5);
        for (const sx of [-0.5, 0, 0.5]) circle(c, sx * r, r * 0.5, 2, '#cfc3b5');
      } else {
        c.fillStyle = '#ffd23f'; c.strokeStyle = OUT; c.lineWidth = 2; c.lineJoin = 'round';
        c.beginPath(); c.moveTo(-r * 0.6, -r); c.lineTo(-r * 0.65, -r * 1.55); c.lineTo(-r * 0.3, -r * 1.25);
        c.lineTo(0, -r * 1.7); c.lineTo(r * 0.3, -r * 1.25); c.lineTo(r * 0.65, -r * 1.55); c.lineTo(r * 0.6, -r); c.closePath();
        c.fill(); c.stroke();
        c.fillStyle = '#fff'; for (const sx of [-1, 1]) { c.beginPath(); c.moveTo(sx * r * 0.25, r * 0.45); c.lineTo(sx * r * 0.15, r * 0.75); c.lineTo(sx * r * 0.05, r * 0.45); c.fill(); }
      }
      eyes(c, r, e.ang, true);
      break;
    }
    case 'swarm': {
      c.strokeStyle = OUT; c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(-r * 0.4, -r * 0.8); c.lineTo(-r * 0.8, -r * 1.6); c.moveTo(r * 0.4, -r * 0.8); c.lineTo(r * 0.8, -r * 1.6); c.stroke();
      circle(c, 0, 0, r, col, OUT, 1.8);
      c.strokeStyle = 'rgba(0,0,0,0.35)'; c.beginPath(); c.moveTo(0, -r); c.lineTo(0, r); c.stroke();
      eyes(c, r, e.ang, false);
      break;
    }
    case 'splitter':
    case 'blobling': {
      c.globalAlpha = 0.92;
      c.beginPath();
      for (let i = 0; i <= 16; i++) {
        const a = (i / 16) * Math.PI * 2, rr = r * (1 + Math.sin(a * 3 + e.wob) * 0.06);
        c.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
      }
      c.closePath(); c.fillStyle = col; c.fill(); c.strokeStyle = OUT; c.lineWidth = 2; c.stroke();
      c.globalAlpha = 1;
      if (e.type === 'splitter') for (let i = 0; i < 3; i++) circle(c, Math.cos(i * 2.1 + e.wob * 0.3) * r * 0.45, r * 0.25 + Math.sin(i * 2.1 + e.wob * 0.3) * r * 0.3, r * 0.22, '#f4b8f6', 'rgba(0,0,0,0.25)', 1);
      circle(c, -r * 0.35, -r * 0.45, r * 0.2, 'rgba(255,255,255,0.5)');
      eyes(c, r, e.ang, e.type === 'blobling');
      break;
    }
    case 'mole': {
      circle(c, 0, 0, r, col, OUT, 2);
      ellipse(c, 0, r * 0.25, r * 0.6, r * 0.5, flash ? '#fff' : '#b8957a');
      c.save(); c.rotate(e.ang);
      circle(c, r * 0.9, 0, r * 0.25, '#ff8fa8', OUT, 1.2);
      c.restore();
      for (const sx of [-1, 1]) circle(c, sx * r * 0.35, -r * 0.2, r * 0.1, '#1a1a1a');
      for (const sx of [-1, 1]) ellipse(c, sx * r * 0.95, r * 0.45, r * 0.32, r * 0.2, '#f2d7c0', OUT, 1.2);
      break;
    }
    case 'aphid': {
      const chew = !!e.chew;
      c.save(); c.rotate(e.ang);
      c.strokeStyle = OUT; c.lineWidth = 1.4;
      for (const lx of [-0.4, 0.1, 0.6]) for (const sy of [-1, 1]) {
        const kick = Math.sin(e.wob * 2 + lx * 5) * 2;
        c.beginPath(); c.moveTo(lx * r, sy * r * 0.5); c.lineTo(lx * r + kick, sy * r * 1.15); c.stroke();
      }
      ellipse(c, -r * 0.1, 0, r * 1.15, r * 0.8, col, OUT, 2);
      ellipse(c, -r * 0.3, -r * 0.25, r * 0.45, r * 0.2, 'rgba(255,255,255,0.35)');
      c.beginPath(); c.moveTo(r * 0.8, -r * 0.3); c.quadraticCurveTo(r * 1.5, -r * 0.9, r * 1.6, -r * 1.1);
      c.moveTo(r * 0.8, r * 0.3); c.quadraticCurveTo(r * 1.5, r * 0.9, r * 1.6, r * 1.1); c.stroke();
      const open = chew ? Math.abs(Math.sin(time * 14)) * r * 0.25 : 0;
      ellipse(c, r * 1.05, 0, r * 0.12 + open * 0.4, r * 0.12 + open, '#5a1a1a');
      c.restore();
      eyes(c, r * 0.9, e.ang, chew);
      if (chew) label(c, 'nom', r * 0.2, -r * 1.6 - Math.abs(Math.sin(time * 7)) * 3, 9, '#ffffff', 'center', 700);
      break;
    }
    case 'woolly': {
      // a woolly bear caterpillar: rust middle, dark ends, a halo of fur
      c.save(); c.rotate(e.ang);
      const seg = [[-r * 0.85, '#3a2a20'], [-r * 0.3, col], [r * 0.25, col], [r * 0.8, '#3a2a20']];
      for (const [sx, sc] of seg) {
        const bob = Math.sin(e.wob * 2 + sx) * r * 0.08;
        c.strokeStyle = flash ? '#fff' : sc; c.lineWidth = 1.3;
        c.beginPath();
        for (let i = 0; i < 9; i++) { const a = (i / 9) * Math.PI * 2; c.moveTo(sx + Math.cos(a) * r * 0.4, bob + Math.sin(a) * r * 0.4); c.lineTo(sx + Math.cos(a) * r * 0.72, bob + Math.sin(a) * r * 0.72); }
        c.stroke();
        circle(c, sx, bob, r * 0.48, flash ? '#fff' : sc, OUT, 1.6);
      }
      c.restore();
      c.save(); c.translate(Math.cos(e.ang) * r * 0.75, Math.sin(e.ang) * r * 0.75); // eyes on the head end
      eyes(c, r * 0.6, e.ang, true);
      c.restore();
      break;
    }
    case 'hopper': {
      c.save(); c.rotate(e.ang);
      // big folded back legs, kicked out straight while leaping
      c.strokeStyle = OUT; c.lineWidth = 2; c.lineJoin = 'round'; c.lineCap = 'round';
      for (const sy of [-1, 1]) {
        c.beginPath(); c.moveTo(-r * 0.1, sy * r * 0.45);
        if (leap) c.lineTo(-r * 1.9, sy * r * 0.7);
        else { c.lineTo(r * 0.3, sy * r * 1.15); c.lineTo(-r * 1.1, sy * r * 0.75); }
        c.stroke();
      }
      ellipse(c, 0, 0, r * 1.25, r * 0.62, col, OUT, 2);
      ellipse(c, -r * 0.2, 0, r * 0.8, r * 0.3, flash ? '#fff' : '#6aa52a');
      c.beginPath(); c.moveTo(r * 0.9, -r * 0.2); c.quadraticCurveTo(r * 1.7, -r * 0.6, r * 2, -r * 1.1);
      c.moveTo(r * 0.9, r * 0.2); c.quadraticCurveTo(r * 1.7, r * 0.6, r * 2, r * 1.1); c.lineWidth = 1.3; c.stroke();
      c.restore();
      eyes(c, r * 0.85, e.ang, leap);
      break;
    }
    case 'charger': {
      // a stag beetle; the more it's hurt the angrier it glows and the more it steams
      const rage = 1 - Math.max(0, e.hp) / e.maxhp;
      c.save(); c.rotate(e.ang);
      if (rage > 0.25) {
        c.strokeStyle = `rgba(255,255,255,${Math.min(0.8, rage)})`; c.lineWidth = 2; c.lineCap = 'round';
        for (const ly of [-0.5, 0.5]) { c.beginPath(); c.moveTo(-r * 1.2, ly * r); c.lineTo(-r * (1.6 + rage * 1.5), ly * r); c.stroke(); }
      }
      // two curved pincers reaching forward and in
      c.fillStyle = flash ? '#fff' : '#8a5a3a'; c.strokeStyle = OUT; c.lineWidth = 1.6; c.lineJoin = 'round';
      for (const sy of [-1, 1]) {
        c.beginPath(); c.moveTo(r * 0.6, sy * r * 0.55);
        c.quadraticCurveTo(r * 1.5, sy * r * 0.95, r * 1.95, sy * r * 0.12);
        c.quadraticCurveTo(r * 1.4, sy * r * 0.5, r * 0.75, sy * r * 0.2);
        c.closePath(); c.fill(); c.stroke();
      }
      ellipse(c, -r * 0.1, 0, r * 1.05, r * 0.9, col, OUT, 2.2);
      c.strokeStyle = 'rgba(0,0,0,0.4)'; c.lineWidth = 1.5; c.beginPath(); c.moveTo(-r, 0); c.lineTo(r * 0.5, 0); c.stroke();
      ellipse(c, -r * 0.4, -r * 0.35, r * 0.35, r * 0.15, 'rgba(255,255,255,0.3)');
      c.restore();
      if (rage > 0) { c.globalAlpha = rage * 0.45; circle(c, 0, 0, r, '#ff3a2a'); c.globalAlpha = 1; }
      eyes(c, r * 0.85, e.ang, true);
      break;
    }
    case 'hive': {
      for (let i = 0; i < 4; i++) {
        const yy = r * 0.65 - i * r * 0.45, rx = r * (1 - i * 0.18);
        ellipse(c, 0, yy, rx, r * 0.32, flash ? '#fff' : i % 2 ? '#f0bf55' : '#d99a2b', OUT, 1.8);
      }
      ellipse(c, 0, r * 0.35, r * 0.25, r * 0.18, '#2b1a0c');
      eyes(c, r * 0.8, e.ang, true);
      break;
    }
    default: {
      if (e.type === 'grunt') {
        c.fillStyle = flash ? '#fff' : '#f2e6d0'; c.strokeStyle = OUT; c.lineWidth = 1.5;
        for (const sx of [-1, 1]) { c.beginPath(); c.moveTo(sx * r * 0.35, -r * 0.8); c.lineTo(sx * r * 0.6, -r * 1.35); c.lineTo(sx * r * 0.75, -r * 0.6); c.closePath(); c.fill(); c.stroke(); }
      }
      circle(c, 0, 0, r, col, OUT, 2);
      circle(c, -r * 0.35, -r * 0.45, r * 0.22, 'rgba(255,255,255,0.35)');
      eyes(c, r, e.ang, e.type === 'grunt');
      if (e.def.heals) {
        rrect(c, -r * 0.55, -r * 1.35, r * 1.1, r * 0.55, 3, '#fff', OUT, 1.5);
        c.fillStyle = '#e04848'; c.fillRect(-r * 0.08, -r * 1.3, r * 0.16, r * 0.45); c.fillRect(-r * 0.25, -r * 1.15, r * 0.5, r * 0.15);
      }
      if (e.type === 'shield') {
        c.save(); c.rotate(e.ang);
        rrect(c, r * 0.65, -r * 0.85, r * 0.45, r * 1.7, r * 0.2, flash ? '#fff' : '#c9d6e3', OUT, 2);
        circle(c, r * 0.88, 0, r * 0.15, '#ffd23f');
        c.restore();
      }
    }
  }
  if (e.atBase) label(c, 'nom!', 0, -r - 10 - Math.abs(Math.sin(time * 9)) * 4, 11, '#ffffff', 'center', 700);
  if (e.psn > 0) {
    c.globalAlpha = 0.35; circle(c, 0, 0, r + 1, '#8fc63e'); c.globalAlpha = 1;
    for (let i = 0; i < Math.min(3, e.psn); i++) {
      const k = (time * 1.5 + i / 3) % 1;
      circle(c, Math.sin(i * 2.5) * r * 0.6, -r * 0.4 - k * r, 1.5 + k * 1.5, `rgba(154,209,75,${1 - k})`);
    }
  }
  if (e.slowT > 0) {
    c.globalAlpha = 0.45; circle(c, 0, 0, r + 2, '#9be8ff'); c.globalAlpha = 1;
    for (let i = 0; i < 3; i++) { const a = i * 2.1 + time; star(c, Math.cos(a) * r * 0.8, Math.sin(a) * r * 0.8, 3, '#ffffff'); }
  }
  if (e.stun > 0) {
    for (let i = 0; i < 3; i++) {
      const a = time * 6 + (i * Math.PI * 2) / 3;
      star(c, Math.cos(a) * r * 0.9, -r - 6 + Math.sin(a) * 4, 5, '#ffe27a', OUT);
    }
  }
  c.restore();
  if (e.hp < e.maxhp) {
    const w = Math.max(26, r * 2.2), bx = e.x - w / 2, by = e.y + hop - r - (e.type === 'boss' ? r * 0.85 : 12);
    rrect(c, bx - 1.5, by - 1.5, w + 3, 7, 3, OUT);
    rrect(c, bx, by, Math.max(0, w * (e.hp / e.maxhp)), 4, 2, e.psn > 0 ? '#a6e04a' : e.hp / e.maxhp > 0.4 ? '#6be06b' : '#ff6a5a');
  }
}

// ---- cats ------------------------------------------------------------------
// Each class wears something on its head: Brick a sweatband, Zip goggles,
// Fern a straw hat, Boom a bandana and eyepatch.
function drawCatGear(c, cat, time) {
  if (cat === 'brawler') {
    rrect(c, -10, -6, 20, 4.5, 2, '#e04a3a', OUT, 1.4);
    rrect(c, -14, -6, 5, 3, 1.5, '#e04a3a', OUT, 1.2);
  } else if (cat === 'scout') {
    rrect(c, -9, -8.5, 18, 3, 1.5, '#4a4a55', null);
    for (const gx of [-3, 4]) circle(c, gx, -7.5, 3.6, '#8fd8ff', OUT, 1.5);
    circle(c, -4, -8.5, 1, '#ffffff');
  } else if (cat === 'gardener') {
    ellipse(c, 0, -8, 15, 4, '#e8c56a', OUT, 1.6);
    c.beginPath(); c.moveTo(-8, -8.5); c.quadraticCurveTo(-7, -17, 0, -17); c.quadraticCurveTo(7, -17, 8, -8.5); c.closePath();
    c.fillStyle = '#f0d27a'; c.fill(); c.strokeStyle = OUT; c.lineWidth = 1.6; c.stroke();
    rrect(c, -8, -11, 16, 2.6, 1, '#6bbf4a');
    circle(c, 5, -11, 2.2, '#ff8fb8', OUT, 1);
  } else if (cat === 'bomber') {
    c.beginPath(); c.moveTo(-10, -4); c.quadraticCurveTo(0, -15, 10, -4); c.closePath();
    c.fillStyle = '#d6453a'; c.fill(); c.strokeStyle = OUT; c.lineWidth = 1.5; c.stroke();
    for (const [dx, dy] of [[-3, -7], [3, -8], [0, -10]]) circle(c, dx, dy, 0.9, '#ffffff');
    ellipse(c, -11, -4, 3, 2, '#d6453a', OUT, 1.2);
    ellipse(c, 5, -1, 3, 3.4, '#1a1a1a');
    c.strokeStyle = '#1a1a1a'; c.lineWidth = 1; c.beginPath(); c.moveTo(2, -3); c.lineTo(-9, -6); c.stroke();
  }
}

// Each cat's own weapon, lying along +x from the grip (0) to the tip (len).
function drawWeapon(c, cat, len) {
  c.lineCap = 'round'; c.lineJoin = 'round';
  const stick = (x0, x1, w, col) => {
    c.strokeStyle = OUT; c.lineWidth = w + 3; c.beginPath(); c.moveTo(x0, 0); c.lineTo(x1, 0); c.stroke();
    c.strokeStyle = col; c.lineWidth = w; c.beginPath(); c.moveTo(x0, 0); c.lineTo(x1, 0); c.stroke();
  };
  if (cat === 'brawler') {
    // Brick: a baseball bat, thin taped handle swelling into a fat barrel
    c.beginPath();
    c.moveTo(0, -1.8); c.lineTo(len * 0.35, -2.2); c.quadraticCurveTo(len * 0.7, -5.5, len - 4, -5.5);
    c.arc(len - 4, 0, 5.5, -Math.PI / 2, Math.PI / 2);
    c.quadraticCurveTo(len * 0.7, 5.5, len * 0.35, 2.2); c.lineTo(0, 1.8); c.closePath();
    c.fillStyle = '#d9a35e'; c.fill(); c.strokeStyle = OUT; c.lineWidth = 1.6; c.stroke();
    c.beginPath(); c.moveTo(len * 0.45, -1.5); c.quadraticCurveTo(len * 0.75, -3.6, len - 4, -3.4);
    c.strokeStyle = 'rgba(255,255,255,0.45)'; c.lineWidth = 1.2; c.stroke();
    rrect(c, 0, -2.2, len * 0.28, 4.4, 1.5, '#3b3b48', OUT, 1.2);
    circle(c, -0.5, 0, 3, '#3b3b48', OUT, 1.2);
  } else if (cat === 'bomber') {
    // Boom: a pirate cutlass, brass guard and a curved blade
    const g = len * 0.24;
    stick(0, g, 3.4, '#7a4a22');
    c.beginPath();
    c.moveTo(g, -2.4); c.lineTo(len * 0.8, -2.6); c.quadraticCurveTo(len - 1, -3.4, len + 1, -6);
    c.quadraticCurveTo(len * 0.9, 4, len * 0.62, 4.6); c.quadraticCurveTo(len * 0.4, 4.4, g, 2.6); c.closePath();
    c.fillStyle = '#dfe7ee'; c.fill(); c.strokeStyle = OUT; c.lineWidth = 1.5; c.stroke();
    c.beginPath(); c.moveTo(g + 2, -0.6); c.lineTo(len * 0.8, -1); c.strokeStyle = 'rgba(140,160,175,0.9)'; c.lineWidth = 1; c.stroke();
    c.beginPath(); c.moveTo(g, -4.5); c.quadraticCurveTo(g + 2.5, 0, g, 4.5); c.quadraticCurveTo(g - 6, 6, -1, 2);
    c.strokeStyle = OUT; c.lineWidth = 4; c.stroke(); c.strokeStyle = '#f2c14e'; c.lineWidth = 2.2; c.stroke();
    circle(c, -0.5, 0, 2.2, '#f2c14e', OUT, 1);
  } else if (cat === 'gardener') {
    // Fern: a garden spade, D-handle, wooden shaft and a rounded steel blade
    const b = len * 0.66;
    stick(2, b, 2.8, '#b07a3c');
    c.beginPath(); c.ellipse(1, 0, 3, 4, 0, 0, Math.PI * 2); c.strokeStyle = OUT; c.lineWidth = 3.6; c.stroke();
    c.strokeStyle = '#b07a3c'; c.lineWidth = 1.8; c.stroke();
    rrect(c, b - 1.5, -2.6, 4, 5.2, 1.2, '#8e9aa3', OUT, 1.2);
    c.beginPath();
    c.moveTo(b + 2, -5); c.lineTo(len - 4, -5); c.quadraticCurveTo(len + 1, -4, len + 1.5, 0);
    c.quadraticCurveTo(len + 1, 4, len - 4, 5); c.lineTo(b + 2, 5); c.closePath();
    c.fillStyle = '#b9c4cc'; c.fill(); c.strokeStyle = OUT; c.lineWidth = 1.5; c.stroke();
    c.beginPath(); c.moveTo(b + 4, -2.5); c.lineTo(len - 4, -2.5); c.strokeStyle = 'rgba(255,255,255,0.6)'; c.lineWidth = 1.2; c.stroke();
    ellipse(c, len - 3, 2.6, 2.4, 1.4, '#7a5432');
  } else {
    // Zip: a light twig, a little fork and a leaf on the end
    stick(0, len, 2.2, '#9a6a3a');
    c.beginPath(); c.moveTo(len * 0.55, 0); c.lineTo(len * 0.72, -4.5);
    c.strokeStyle = OUT; c.lineWidth = 3.6; c.stroke(); c.strokeStyle = '#9a6a3a'; c.lineWidth = 1.6; c.stroke();
    c.save(); c.translate(len * 0.72, -4.5); c.rotate(-0.6);
    ellipse(c, 2.6, 0, 3.2, 1.6, '#6bbf4a', OUT, 1);
    c.restore();
    c.save(); c.translate(len, 0); c.rotate(0.4);
    ellipse(c, 3, 0, 3.6, 1.8, '#7fd35a', OUT, 1);
    c.restore();
  }
}

function drawCat(c, p, time) {
  const K = CATS[p.cat] || {};
  const col = K.fur || '#ff9a3c', dark = K.dark || '#c4600f', scarf = PLAYER.scarves[p.id];
  const face = Math.cos(p.dir) >= -0.01 ? 1 : -1;
  const down = p.stun > 0;
  if (p.sprinting && p.moving && !down) {
    // speed lines and kicked-up dust behind a sprinting cat
    c.strokeStyle = 'rgba(255,255,255,0.7)'; c.lineWidth = 2; c.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      const k = (time * 4 + i / 3) % 1, off = (i - 1) * 7 * U;
      const bx = p.x - Math.cos(p.dir) * (16 + k * 14) * U - Math.sin(p.dir) * off, by = p.y - Math.sin(p.dir) * (16 + k * 14) * U + Math.cos(p.dir) * off;
      c.globalAlpha = 1 - k;
      c.beginPath(); c.moveTo(bx, by); c.lineTo(bx - Math.cos(p.dir) * 10 * U, by - Math.sin(p.dir) * 10 * U); c.stroke();
    }
    c.globalAlpha = 1;
  }
  const bob = down ? 0 : p.moving ? -Math.abs(Math.sin(time * 14)) * 3 : p.working ? -Math.abs(Math.sin(time * 10)) * 2 : Math.sin(time * 2) * 0.6;
  ellipse(c, p.x, p.y + 14 * U, (down ? 18 : 14) * U, 5 * U, 'rgba(0,0,0,0.25)');
  c.save();
  c.translate(p.x, p.y + bob + (down ? 6 * U : 0));
  const st = swingSquash(p) * 0.12;
  c.scale(U * 1.15 * face * (1 + st), U * 1.15 * (1 - st));
  if (down) c.rotate(-1.4); // knocked flat on its back
  const wag = Math.sin(time * (p.moving ? 12 : 4)) * 4;
  c.lineCap = 'round';
  for (const [w, s] of [[7, OUT], [4, col]]) {
    c.strokeStyle = s; c.lineWidth = w;
    c.beginPath(); c.moveTo(-8, 6); c.quadraticCurveTo(-20, 4, -17 + wag * 0.3, -10 + wag); c.stroke();
  }
  const step = p.moving ? Math.sin(time * 14) * 3 : 0;
  for (const [lx, ph] of [[-6, 1], [-1, -1], [4, 1], [8, -1]]) rrect(c, lx - 2, 9 + ph * step * 0.3, 4.5, 6 - ph * step * 0.3, 2, dark, OUT, 1.3);
  ellipse(c, 0, 5, 11, 8, col, OUT, 2);
  ellipse(c, 2, 7, 6, 4.5, 'rgba(255,255,255,0.5)');
  c.save(); c.translate(5, -7);
  for (const ex of [-6, 5]) {
    c.beginPath(); c.moveTo(ex - 3, -6); c.lineTo(ex + 1, -15); c.lineTo(ex + 5, -5); c.closePath();
    c.fillStyle = col; c.fill(); c.strokeStyle = OUT; c.lineWidth = 1.8; c.lineJoin = 'round'; c.stroke();
    c.beginPath(); c.moveTo(ex - 1, -7); c.lineTo(ex + 1, -12); c.lineTo(ex + 3, -6.5); c.closePath(); c.fillStyle = '#f7a6b5'; c.fill();
  }
  circle(c, 0, 0, 10, col, OUT, 2);
  if (p.cat === 'scout') { c.strokeStyle = dark; c.lineWidth = 1.6; c.beginPath(); c.moveTo(-3, -9.5); c.lineTo(-3, -6); c.moveTo(0, -10); c.lineTo(0, -6); c.moveTo(3, -9.5); c.lineTo(3, -6); c.stroke(); }
  const blink = Math.sin(time * 1.3 + p.id * 2) > 0.985;
  for (const ex of [-1, 5]) {
    if (down) { c.strokeStyle = OUT; c.lineWidth = 1.4; c.beginPath(); c.moveTo(ex - 2, -3); c.lineTo(ex + 2, 1); c.moveTo(ex + 2, -3); c.lineTo(ex - 2, 1); c.stroke(); }
    else if (blink) { c.strokeStyle = OUT; c.lineWidth = 1.5; c.beginPath(); c.moveTo(ex - 2, -1); c.lineTo(ex + 2, -1); c.stroke(); }
    else { ellipse(c, ex, -1, 2.3, 3, '#1a1a1a'); circle(c, ex + 0.7, -2.2, 0.9, '#fff'); }
  }
  circle(c, 2.5, 3, 1.4, '#f2778b');
  c.strokeStyle = 'rgba(40,30,20,0.6)'; c.lineWidth = 0.9;
  c.beginPath(); c.moveTo(6, 3); c.lineTo(13, 2); c.moveTo(6, 4.5); c.lineTo(13, 5.5); c.moveTo(-1, 3); c.lineTo(-8, 2); c.stroke();
  drawCatGear(c, p.cat, time);
  if (p.tired && !down) { const k = (time * 1.5) % 1; ellipse(c, -11, -6 + k * 8, 1.8, 2.6, `rgba(120,200,255,${1 - k})`, OUT, 0.8); }
  c.restore();
  rrect(c, -3, -1, 14, 4.5, 2, scarf, OUT, 1.4);
  rrect(c, -4, 1, 4, 8, 2, scarf, OUT, 1.4);
  c.restore();
  if (down) {
    for (let i = 0; i < 3; i++) {
      const a = time * 6 + (i * Math.PI * 2) / 3;
      star(c, p.x + Math.cos(a) * 14 * U, p.y - 10 * U + Math.sin(a) * 4, 5, '#ffe27a', OUT);
    }
  } else {
    const bx = p.x, by = p.y + bob;
    let a, inner = 10 * U, outer = 34 * U;
    if (p.swingT > 0) {
      const k = 1 - p.swingT / PLAYER.swingTime;
      const a0 = p.swingDir - PLAYER.atkArc / 2, reach = catStats(p).atkRange;
      a = a0 + PLAYER.atkArc * k;
      c.globalAlpha = 0.6;
      c.beginPath(); c.arc(bx, by, reach * 0.85, a0, a); c.strokeStyle = '#ffffff'; c.lineWidth = (p.cat === 'brawler' ? 15 : 10) * U; c.lineCap = 'round'; c.stroke();
      c.globalAlpha = 1;
      outer = reach * 0.85;
    } else {
      // resting on the shoulder, held out to the side so it doesn't hide the face
      a = -Math.PI / 2 + face * 0.5;
      inner = 0; outer = 26 * U;
    }
    const hx = bx + face * (p.swingT > 0 ? 0 : 15 * U), hy = by + (p.swingT > 0 ? 0 : 10 * U);
    const x1 = hx + Math.cos(a) * inner, y1 = hy + Math.sin(a) * inner, x2 = hx + Math.cos(a) * outer, y2 = hy + Math.sin(a) * outer;
    c.save(); c.translate(x1, y1); c.rotate(a); c.scale(U, U * face);
    drawWeapon(c, p.cat, (outer - inner) / U);
    c.restore();
  }
  if (p.noTag) return;
  rrect(c, p.x - 14, p.y - 34 * U, 28, 16, 8, scarf, OUT, 1.5);
  label(c, `P${p.id + 1}`, p.x, p.y - 34 * U + 8.5, 11, '#fff', 'center', 700, null);
}

function drawBuildGhost(c, p, s, time) {
  if (!p.loadout) return;
  const { tx, ty } = tileOf(s.m, p);
  const f = s.grid.get(ty * s.m.W + tx);
  if (!f && !p.building) return; // the placeholder only shows in build mode
  const type = p.loadout[p.sel];
  const valid = f ? true : canBuildAt(s, tx, ty);
  const col = !valid ? '255,90,90' : f && p.mode === 'dig' ? '230,160,90' : f && p.healing ? '140,255,160' : '255,255,255';
  const pulse = 0.6 + Math.sin(time * 6) * 0.25;
  c.setLineDash([7, 5]); c.lineDashOffset = -time * 20;
  rrect(c, tx * T + 3, ty * T + 3, T - 6, T - 6, 8, `rgba(${col},0.12)`, `rgba(${col},${pulse})`, 2.5);
  c.setLineDash([]);
  if (f && f.lvl > 0) {
    const st = flowerStats(f.type, f.lvl);
    if (st.range < GLOBAL_RANGE) circle(c, f.x, f.y, st.range, 'rgba(255,255,255,0.07)', 'rgba(255,255,255,0.45)', 2);
  } else if (!f && valid) {
    const st = flowerStats(type, 1);
    const cx = (tx + 0.5) * T, cy = (ty + 0.5) * T;
    if (st.range < GLOBAL_RANGE) circle(c, cx, cy, st.range, 'rgba(255,255,255,0.05)', 'rgba(255,255,255,0.3)', 1.5);
    c.globalAlpha = 0.5;
    drawFlower(c, { id: 0, type, lvl: 1, x: cx, y: cy, angle: 0, flash: 0, hurtT: 0, hp: FLOWER_HP, headIdx: 0 }, time);
    c.globalAlpha = 1;
  }
}

// ---- misc sprites -----------------------------------------------------------
function drawDrop(c, d, time) {
  const bob = Math.sin(time * 5 + d.x) * 2;
  ellipse(c, d.x, d.y + 7, 6, 2.5, 'rgba(0,0,0,0.2)');
  // worth 4 or more: a bigger coin with a sparkle
  const k = d.big ? 1.45 : 1;
  const squash = Math.abs(Math.cos(time * 4 + d.x));
  ellipse(c, d.x, d.y + bob - 2, 7 * U * k * (0.35 + 0.65 * squash), 7 * U * k, d.big ? '#ffc61a' : '#ffd23f', OUT, 1.6);
  if (squash > 0.5) label(c, '$', d.x, d.y + bob - 1.5, 10 * k, '#b37a00', 'center', 700, null);
  if (d.big) star(c, d.x + 7 * U, d.y + bob - 9 * U, 2.5 + Math.abs(Math.sin(time * 6 + d.x)) * 2.5, '#fffbe0', null);
}

function drawProj(c, p, time) {
  if (p.kind === 'single') {
    ellipse(c, p.x, p.y, 5, 3, '#ffffff', OUT, 1.2, p.ang || 0);
  } else if (p.kind === 'bolt') {
    const r = 7 + (p.big || 1) * 0.8;
    for (let i = 1; i <= 4; i++) {
      const tx = p.x - Math.cos(p.ang) * i * r * 0.9, ty = p.y - Math.sin(p.ang) * i * r * 0.9;
      circle(c, tx + Math.sin(time * 30 + i) * 2, ty, r * (1 - i * 0.18), `rgba(255,${120 + i * 20},40,${0.6 - i * 0.12})`);
    }
    circle(c, p.x, p.y, r * 1.6, 'rgba(255,150,40,0.3)');
    circle(c, p.x, p.y, r, '#ff8a2f', OUT, 1.5);
    circle(c, p.x, p.y, r * 0.55, '#ffe680');
  } else {
    const h = Math.sin(Math.min(1, p.k || 0) * Math.PI) * T * 0.7;
    ellipse(c, p.x, p.y + 4, 6, 2.5, 'rgba(0,0,0,0.2)');
    circle(c, p.x, p.y - h, 7, p.color, OUT, 1.5);
    circle(c, p.x - 2, p.y - h - 2, 2, 'rgba(255,255,255,0.7)');
  }
}

function drawBomb(c, b, time) {
  ellipse(c, b.x, b.y + 6, 8, 3, 'rgba(0,0,0,0.25)');
  const y = b.y - b.h;
  circle(c, b.x, y, 9, '#2b2b33', OUT, 2);
  circle(c, b.x - 3, y - 3, 2.5, 'rgba(255,255,255,0.45)');
  c.strokeStyle = '#c9a26b'; c.lineWidth = 2; c.beginPath(); c.moveTo(b.x + 4, y - 7); c.lineTo(b.x + 8, y - 12); c.stroke();
  star(c, b.x + 9, y - 13, 4 + Math.sin(time * 40) * 1.5, '#ffdd55');
}

function drawFx(c) {
  for (const f of liveEffects()) {
    const k = f.life / f.max;
    if (f.kind === 'ring') {
      c.globalAlpha = k * 0.8;
      circle(c, f.x, f.y, f.r * (1 - k * 0.3), f.col + '30', f.col, 3);
      c.globalAlpha = 1;
    } else if (f.kind === 'beam') {
      c.lineCap = 'round';
      c.globalAlpha = k;
      c.strokeStyle = 'rgba(255,230,120,0.45)'; c.lineWidth = f.w * 3.2; c.beginPath(); c.moveTo(f.x, f.y); c.lineTo(f.x2, f.y2); c.stroke();
      c.strokeStyle = f.col; c.lineWidth = f.w * 1.4; c.stroke();
      c.strokeStyle = '#fffbe0'; c.lineWidth = f.w * 0.5; c.stroke();
      circle(c, f.x2, f.y2, f.w * 3 * (1.5 - k), 'rgba(255,240,170,0.6)');
      c.globalAlpha = 1;
    } else if (f.kind === 'bite') {
      const gap = f.r * 0.8 * Math.max(0, k * 2 - 1); // jaws snap shut in the first half
      c.save(); c.translate(f.x, f.y); c.globalAlpha = Math.min(1, k * 2.5);
      for (const sy of [-1, 1]) {
        c.beginPath(); c.arc(0, sy * gap, f.r, sy < 0 ? Math.PI : 0, sy < 0 ? Math.PI * 2 : Math.PI); c.closePath();
        c.fillStyle = '#e0569b'; c.fill(); c.strokeStyle = OUT; c.lineWidth = 2; c.stroke();
        c.fillStyle = '#ffffff';
        for (let i = -2; i <= 2; i++) { c.beginPath(); c.moveTo(i * f.r * 0.32 - 3, sy * gap); c.lineTo(i * f.r * 0.32 + 3, sy * gap); c.lineTo(i * f.r * 0.32, sy * (gap - 6)); c.fill(); }
      }
      c.restore();
    } else if (f.kind === 'flash') {
      const g = c.createRadialGradient(f.x, f.y, 0, f.x, f.y, f.r);
      g.addColorStop(0, `rgba(255,255,220,${k})`); g.addColorStop(1, 'rgba(255,200,80,0)');
      circle(c, f.x, f.y, f.r, g);
    } else if (f.kind === 'puff') {
      c.globalAlpha = k; circle(c, f.x, f.y, f.size * (0.5 + k), f.col); c.globalAlpha = 1;
    } else if (f.kind === 'text') {
      c.globalAlpha = Math.min(1, k * 2.5);
      label(c, f.txt, f.x, f.y, 16, f.col, 'center', 700);
      c.globalAlpha = 1;
    }
  }
}

function drawBanners(c) {
  let y0 = 120;
  for (const f of liveEffects()) {
    if (f.kind !== 'banner') continue;
    const k = f.life / f.max;
    const inT = Math.min(1, (f.max - f.life) * 6);
    c.globalAlpha = Math.min(1, k * 4);
    c.font = `700 40px ${FONT}`;
    const w = c.measureText(f.txt).width + 60;
    const y = y0 - (1 - inT) * 30;
    rrect(c, VIEW_W / 2 - w / 2, y - 32, w, 64, 32, 'rgba(30,24,40,0.75)', 'rgba(255,255,255,0.6)', 2);
    label(c, f.txt, VIEW_W / 2, y + 2, 40, f.txt.includes('BOSS') ? '#ff7a6a' : '#fff4c2', 'center', 700, null);
    c.globalAlpha = 1;
    y0 += 76; // two at once stack instead of overlapping
  }
}

// The first monster of a new kind: a small card down the left side with its
// picture, its name and what stops it. Out of the way of the fighting, and up
// long enough to read.
const INTRO_W = 340, INTRO_H = 62;
function drawIntros(c, ui, time) {
  let y = ui.netLabel ? 42 : 12;
  for (const f of liveEffects()) {
    if (f.kind !== 'intro' || !INTROS[f.type] || !ENEMIES[f.type]) continue;
    const [title, hint] = INTROS[f.type];
    const age = f.max - f.life;
    const slide = Math.min(1, age * 5);
    c.globalAlpha = Math.min(1, f.life / 0.8);
    const x = 10 - (1 - slide) * (INTRO_W + 20);
    rrect(c, x, y, INTRO_W, INTRO_H, 14, 'rgba(28,22,34,0.86)', '#ffb347', 2);
    circle(c, x + 31, y + INTRO_H / 2, 22, 'rgba(255,255,255,0.1)');
    c.save(); c.beginPath(); c.arc(x + 31, y + INTRO_H / 2, 22, 0, Math.PI * 2); c.clip();
    const d = ENEMIES[f.type], big = Math.max(d.r, T * 0.2);
    c.translate(x + 31, y + INTRO_H / 2 + (d.flying ? 13 : 2)); c.scale(Math.min(1.4, (T * 0.3) / big), Math.min(1.4, (T * 0.3) / big));
    drawEnemy(c, { id: 0, type: f.type, def: d, x: 0, y: 0, ang: 0, wob: time * 8, hp: 1, maxhp: 1, flash: 0, psn: 0, slowT: 0, stun: 0, under: false, atBase: false, chew: null, dashing: false }, time);
    c.restore();
    label(c, title, x + 62, y + 17, 15, '#ffd27a', 'left', 700, null);
    wrapText(c, hint, INTRO_W - 72, 12, 500).slice(0, 2).forEach((l, i) => label(c, l, x + 62, y + 35 + i * 14, 12, '#f2e8dc', 'left', 500, null));
    c.globalAlpha = 1;
    y += INTRO_H + 8;
  }
}

// ---- minimap ---------------------------------------------------------------
const MM_W = 216, MM_X = VIEW_W - MM_W - 10, MM_Y = 10;
// The minimap's picture of the map never changes, so it is shrunk from the big
// background once per map. Shrinking that ~4000 px image every frame was the
// most expensive thing in the whole frame on a computer without GPU canvas.
let mmCache = null;
const minimapH = (m) => Math.round(MM_W * m.worldH / m.worldW);
function minimapBg(m, dpr) {
  if (mmCache && mmCache.map === m && mmCache.dpr === dpr) return mmCache.cv;
  const w = MM_W, h = minimapH(m);
  let src = getBg(m, dpr);
  // halve step by step; one big jump would skip pixels and look grainy
  while (src.width / 2 >= w * dpr * 1.5) {
    const half = document.createElement('canvas');
    half.width = Math.ceil(src.width / 2); half.height = Math.ceil(src.height / 2);
    half.getContext('2d').drawImage(src, 0, 0, half.width, half.height);
    src = half;
  }
  const { cv, c } = cacheCanvas(Math.round(w * dpr), Math.round(h * dpr));
  c.scale(dpr, dpr);
  c.globalAlpha = 0.85;
  c.drawImage(src, 0, 0, w, h);
  c.globalAlpha = 1;
  const sx = w / m.worldW, sy = h / m.worldH;
  for (const o of m.obstacles) if (o.type === 'tree') circle(c, (o.x + 0.5) * T * sx, (o.y + 0.5) * T * sy, 1.8, '#2f6f2c');
  mmCache = { map: m, dpr, cv };
  return cv;
}

function drawMinimap(c, s, ui) {
  const m = s.m, base = m.base;
  const MM_H = minimapH(m);
  const sx = MM_W / m.worldW, sy = MM_H / m.worldH;
  const mx = (x) => MM_X + x * sx, my = (y) => MM_Y + y * sy;
  c.save();
  rrect(c, MM_X - 3, MM_Y - 3, MM_W + 6, MM_H + 6, 8, 'rgba(20,28,36,0.8)', 'rgba(255,255,255,0.35)', 1.5);
  c.drawImage(minimapBg(m, ui.dpr), MM_X, MM_Y, MM_W, MM_H);
  for (const f of s.flowers) {
    const r = 1.6 + f.lvl * 0.5;
    c.fillStyle = f.lvl === 0 ? '#3e8a2e' : FLOWERS[f.type].color;
    c.fillRect(mx(f.x) - r, my(f.y) - r, r * 2, r * 2);
  }
  for (const e of s.enemies) circle(c, mx(e.x), my(e.y), e.def.boss ? 4.5 : e.def.r > 14 * U ? 3 : 2, e.def.boss ? '#ff3030' : '#e0405a');
  circle(c, mx(base.x), my(base.y), s.baseHitT > 0 ? 6 + Math.sin(performance.now() / 80) * 2 : 4, s.baseHitT > 0 ? '#ff4040' : '#ffffff', OUT, 1.5);
  for (const p of s.players) circle(c, mx(p.x), my(p.y), 4.5, PLAYER.scarves[p.id], '#ffffff', 1.5);
  c.strokeStyle = 'rgba(255,255,255,0.9)'; c.lineWidth = 1.5;
  c.strokeRect(mx(ui.cam.x), my(ui.cam.y), VIEW_W * sx, MAP_H * sy);
  c.restore();
}

// Arrows at the screen edge pointing at off-screen cats and the base when it's under attack.
function drawEdgeMarkers(c, s, ui) {
  const markers = s.players.map((p) => ({ x: p.x, y: p.y, col: PLAYER.scarves[p.id], txt: `P${p.id + 1}` }));
  if (s.baseHitT > 0) markers.push({ x: s.m.base.x, y: s.m.base.y, col: '#ff4040', txt: '🏠!' });
  for (const m of markers) {
    const vx = m.x - ui.cam.x, vy = m.y - ui.cam.y;
    if (vx > 0 && vx < VIEW_W && vy > 0 && vy < MAP_H) continue;
    const cx = VIEW_W / 2, cy = MAP_H / 2;
    const ang = Math.atan2(vy - cy, vx - cx);
    const ex = clamp(vx, 24, VIEW_W - 24), ey = clamp(vy, 24, MAP_H - 24);
    c.save(); c.translate(ex, ey); c.rotate(ang);
    c.beginPath(); c.moveTo(14, 0); c.lineTo(-6, -10); c.lineTo(-6, 10); c.closePath();
    c.fillStyle = m.col; c.fill(); c.strokeStyle = '#fff'; c.lineWidth = 2; c.stroke();
    c.restore();
    label(c, m.txt, ex - Math.cos(ang) * 18, ey - Math.sin(ang) * 18, 11, '#fff', 'center', 700);
  }
}

// ---- HUD ---------------------------------------------------------------------
function coinIcon(c, x, y, r) {
  circle(c, x, y, r, '#ffd23f', OUT, 2);
  label(c, '$', x, y + 1, r * 1.3, '#b37a00', 'center', 700, null);
}

function contextText(s, p, ui) {
  if (!p.loadout) return p.pick.ready ? 'Ready! Waiting for the other cat…' : 'Choosing flowers…';
  if (p.stun > 0) return 'Knocked down!';
  const key = ui.keyLabel(ui.keysFor(p.id).build), cyc = ui.keyLabel(ui.keysFor(p.id).cycle), hk = ui.keyLabel(ui.keysFor(p.id).heal);
  const m = s.m;
  const { tx, ty } = tileOf(m, p);
  const k = ty * m.W + tx;
  const f = s.grid.get(k);
  if (!f) {
    if (!p.building) return `[${key}] or [${cyc}] build mode`;
    if (m.pathTiles.has(k)) return "Can't plant on the path";
    if (m.yard.has(k)) return 'Cottage yard · no planting here';
    if (m.blocked.has(k)) return "Something's in the way";
    const F = FLOWERS[p.loadout[p.sel]];
    return `[${key}] plant ${F.name} (${plantPrice(p, p.loadout[p.sel])}) · [${cyc}] next · ${F.desc}`;
  }
  const name = FLOWERS[f.type].name;
  const midLevel = f.lvl > 0 && f.lvl < MAX_LEVEL;
  if (p.mode === 'dig') return `Hold [${key}] dig up ${name} · get back ${uprootRefund(f)} · [${cyc}] ${midLevel ? 'upgrade' : 'back'}`;
  if (f.lvl === 0) return `Hold [${key}] to grow ${name} (${upgradeLeft(p, f)}) · [${cyc}] dig up`;
  if (f.lvl >= MAX_LEVEL) return `${name} · max level, never wilts · [${cyc}] dig up`;
  const up = `[${key}] upgrade to Lv${f.lvl + 1} (${upgradeLeft(p, f)})`;
  if (f.hp >= FLOWER_HP - 0.5) return `${up} · healthy · [${cyc}] dig up`;
  return `${up} · [${hk}] heal ${Math.floor(f.hp)}%→100 (${healLeft(p, f)}) · [${cyc}] dig`;
}

function drawHud(c, s, time, ui) {
  const y0 = MAP_H;
  const g = c.createLinearGradient(0, y0, 0, VIEW_H);
  g.addColorStop(0, '#2c3a45'); g.addColorStop(1, '#1b242c');
  c.fillStyle = g; c.fillRect(0, y0, VIEW_W, HUD_H);
  c.fillStyle = '#4c6070'; c.fillRect(0, y0, VIEW_W, 3);

  // cottage health
  const hr = clamp(s.lives / s.maxLives, 0, 1);
  label(c, '🏠', 24, y0 + 30, 18, '#ffffff', 'center', 700, null);
  rrect(c, 40, y0 + 22, 150, 16, 8, 'rgba(0,0,0,0.45)', s.baseHitT > 0 ? '#ff6a5a' : OUT, 2);
  rrect(c, 42, y0 + 24, Math.max(0, 146 * hr), 12, 6, hr > 0.5 ? '#6be06b' : hr > 0.25 ? '#ffd23f' : '#ff6a5a');
  label(c, `${Math.ceil(s.lives)} / ${s.maxLives}`, 115, y0 + 30.5, 12, '#ffffff', 'center', 700);
  label(c, `Wave ${Math.max(1, s.wave)}/${TOTAL_WAVES}`, 14, y0 + 58, 16, '#e8f1f7', 'left', 600, null);
  const status = s.phase === 'pick' ? 'Choosing flowers' : s.phase === 'prep' ? `Next in ${Math.ceil(s.timer)}s · Enter` : `${s.enemies.length + s.queue.length} enemies left`;
  label(c, status, 14, y0 + 78, 12, '#a9bccb', 'left', 500, null);
  label(c, isMuted() ? '🔇' : '', 220, y0 + 30, 14, '#fff', 'center', 500, null);

  const pw = 370;
  s.players.forEach((p, i) => {
    const x0 = 250 + i * (pw + 12);
    const pc = PLAYER.scarves[i];
    rrect(c, x0, y0 + 9, pw, HUD_H - 18, 12, 'rgba(255,255,255,0.06)', pc, 2);
    rrect(c, x0 + 10, y0 + 17, 30, 18, 9, pc);
    label(c, `P${i + 1}`, x0 + 25, y0 + 26.5, 12, '#fff', 'center', 700, null);
    coinIcon(c, x0 + 54, y0 + 26, 8);
    const cs = coinScale(i);
    c.save(); c.translate(x0 + 66, y0 + 27); c.scale(cs, cs);
    label(c, `${Math.floor(p.coins)}`, 0, 0, 16, '#ffe27a', 'left', 700, null);
    c.restore();
    label(c, fitText(c, contextText(s, p, ui), pw - 118, 11.5), x0 + 110, y0 + 27, 11.5, p.stun > 0 ? '#ffb347' : '#dce7ef', 'left', 500, null);
    const bx = x0 + 26, by = y0 + 61;
    circle(c, bx, by, 15, 'rgba(0,0,0,0.45)', OUT, 2);
    const frac = Math.min(1, p.bombs);
    if (frac < 1) {
      c.beginPath(); c.moveTo(bx, by); c.arc(bx, by, 13, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2); c.closePath();
      c.fillStyle = 'rgba(255,179,71,0.55)'; c.fill();
    } else {
      circle(c, bx, by, 13, `rgba(255,179,71,${0.5 + Math.sin(time * 5) * 0.2})`);
    }
    circle(c, bx, by + 1, 7, '#2b2b33', OUT, 1.5);
    c.strokeStyle = '#c9a26b'; c.lineWidth = 1.5; c.beginPath(); c.moveTo(bx + 3, by - 4); c.lineTo(bx + 6, by - 8); c.stroke();
    // stamina bar under the bomb
    rrect(c, bx - 16, by + 18, 32, 6, 3, 'rgba(0,0,0,0.45)');
    if (p.stam > 0.01) rrect(c, bx - 15, by + 19, 30 * p.stam, 4, 2, p.tired ? '#ff8a5a' : p.sprinting ? '#ffffff' : '#7fd4ff');
    (p.loadout || p.pick.chosen).forEach((t, j) => {
      const sx = x0 + 50 + j * 104, sy = y0 + 42, sw = 100, sh = 38;
      const sel = p.loadout && p.building && j === p.sel;
      const cost = p.loadout ? plantPrice(p, t) : plantCost(t), afford = p.coins >= cost;
      rrect(c, sx, sy, sw, sh, 8, sel ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.25)', sel ? pc : 'rgba(255,255,255,0.1)', sel ? 3 : 1);
      c.save(); c.translate(sx + 19, sy + 19); c.scale(0.8, 0.8); if (!afford) c.globalAlpha = 0.45; drawHead(c, t); c.restore();
      label(c, `${cost}`, sx + 54, sy + 20, 14, afford ? '#ffe27a' : '#c07070', 'center', 700, null);
    });
  });
}

function wrapText(c, txt, maxW, size, weight = 500) {
  c.font = `${weight} ${size}px ${FONT}`;
  const lines = [];
  let line = '';
  for (const w of txt.split(' ')) {
    const next = line ? line + ' ' + w : w;
    if (c.measureText(next).width > maxW && line) { lines.push(line); line = w; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

// A tiny overview of a map for the map picker.
function drawMapThumb(c, m, x, y, w, h) {
  const sc = Math.min(w / m.worldW, h / m.worldH);
  const ox = x + (w - m.worldW * sc) / 2, oy = y + (h - m.worldH * sc) / 2;
  rrect(c, ox, oy, m.worldW * sc, m.worldH * sc, 4, '#7fbd52');
  for (const o of m.obstacles) {
    if (o.type === 'pond') rrect(c, ox + o.x * T * sc, oy + o.y * T * sc, o.w * T * sc, o.h * T * sc, 3, '#4fa3d9');
    else circle(c, ox + (o.x + 0.5) * T * sc, oy + (o.y + 0.5) * T * sc, T * sc * 0.4, o.type === 'tree' ? '#3f8f3a' : '#9a9aa2');
  }
  for (const p of m.paths) {
    c.beginPath();
    p.waypoints.forEach((wp, i) => (i ? c.lineTo : c.moveTo).call(c, ox + wp.x * sc, oy + wp.y * sc));
    c.lineWidth = Math.max(2, T * sc * 0.8); c.strokeStyle = '#e0bf86'; c.lineJoin = 'round'; c.stroke();
    circle(c, ox + p.waypoints[0].x * sc, oy + p.waypoints[0].y * sc, 4, '#8a5cff', OUT, 1);
  }
  circle(c, ox + m.base.x * sc, oy + m.base.y * sc, 5, '#d6504a', '#fff', 1.5);
}

// Before the game: choose a map (top row) and LOADOUT_SIZE flowers (bottom row).
// Pulsing outline for each player whose cursor is on this card.
function pickCursor(c, s, x, y, w, h, r, row, on, time) {
  s.players.forEach((p) => {
    if (p.pick.row !== row || p.pick.ready || !on(p)) return;
    const inset = p.id * 5;
    c.globalAlpha = 0.7 + Math.sin(time * 6) * 0.3;
    rrect(c, x - 4 + inset, y - 4 + inset, w + 8 - inset * 2, h + 8 - inset * 2, r - inset, null, PLAYER.scarves[p.id], 4);
    c.globalAlpha = 1;
  });
}

function pips(c, x, y, name, v) {
  label(c, name, x, y, 10.5, '#a9bccb', 'left', 600, null);
  const n = clamp(Math.round(3 * v), 1, 5);
  for (let i = 0; i < 5; i++) rrect(c, x + 40 + i * 11, y - 3.5, 9, 7, 2, i < n ? '#ffe27a' : 'rgba(255,255,255,0.12)');
}

// The maps: a sliding row of fixed-size cards with the chosen map in the
// middle, so any number of maps fits. Left/right slides it, wrapping round;
// cards further out fade away. ui.mapPos is where the row is now (in cards),
// eased towards the chosen map the short way round.
function drawMapCarousel(c, s, ui, time) {
  const N = MAPS.length, mw = 176, mh = 96, step = mw + 12, y = 40;
  const wrap = (d) => ((((d + N / 2) % N) + N) % N) - N / 2; // -N/2 … N/2
  const now = performance.now();
  const dt = Math.min(0.1, (now - (ui.mapPosT ?? now)) / 1000);
  ui.mapPosT = now;
  let pos = ui.mapPos ?? s.map;
  const d = wrap(s.map - pos);
  pos = Math.abs(d) < 0.01 ? s.map : pos + d * Math.min(1, dt * 12);
  ui.mapPos = ((pos % N) + N) % N;
  label(c, `Map ${s.map + 1} / ${N}`, 16, 20, 13, '#8fa5b3', 'left', 600, null);
  for (let i = 0; i < N; i++) {
    const k = wrap(i - ui.mapPos);
    if (Math.abs(k) > 2.6) continue;
    const m = MAPS[i], x = VIEW_W / 2 + k * step - mw / 2, sel = s.map === i;
    c.globalAlpha = Math.abs(k) <= 1.5 ? 1 : Math.max(0, 1 - (Math.abs(k) - 1.5) / 1.1);
    rrect(c, x, y, mw, mh, 12, sel ? 'rgba(255,226,122,0.16)' : 'rgba(255,255,255,0.05)', sel ? '#ffe27a' : 'rgba(255,255,255,0.18)', sel ? 3 : 1.5);
    drawMapThumb(c, m, x + 8, y + 6, mw - 16, mh - 42);
    label(c, fitText(c, m.name, mw - 14, 13, 700), x + mw / 2, y + mh - 27, 13, '#ffffff', 'center', 700, null);
    label(c, fitText(c, m.desc, mw - 14, 10.5), x + mw / 2, y + mh - 11, 10.5, '#a9bccb', 'center', 500, null);
    c.globalAlpha = 1;
    if (sel) pickCursor(c, s, x, y, mw, mh, 15, 0, () => true, time);
  }
  // arrows at both ends: there are always more maps either way
  for (const dir of [-1, 1]) {
    const ax = dir < 0 ? 22 : VIEW_W - 22, ay = y + mh / 2;
    circle(c, ax, ay, 15, 'rgba(20,28,36,0.9)', 'rgba(255,255,255,0.35)', 1.5);
    c.fillStyle = '#ffe27a'; c.beginPath();
    c.moveTo(ax + dir * 6, ay); c.lineTo(ax - dir * 4, ay - 7); c.lineTo(ax - dir * 4, ay + 7); c.closePath(); c.fill();
  }
}

function drawPick(c, s, ui, time) {
  c.fillStyle = 'rgba(12,18,26,0.85)'; c.fillRect(0, 0, VIEW_W, MAP_H);
  label(c, `Choose a map, a cat and ${LOADOUT_SIZE} flowers`, VIEW_W / 2, 20, 22, '#ffe27a', 'center', 700, OUT);
  label(c, 'I: flower guide', VIEW_W - 16, 20, 13, '#8fa5b3', 'right', 600, null);
  drawMapCarousel(c, s, ui, time);
  // cats: each one can only be taken by one player
  const cw0 = 232, cgap = 12, ch0 = 98, cx0 = (VIEW_W - (CAT_ORDER.length * cw0 + (CAT_ORDER.length - 1) * cgap)) / 2, cy0 = 148;
  CAT_ORDER.forEach((id, i) => {
    const K = CATS[id], x = cx0 + i * (cw0 + cgap);
    const owner = s.players.find((p) => p.cat === id);
    rrect(c, x, cy0, cw0, ch0, 12, owner ? 'rgba(255,240,180,0.13)' : 'rgba(255,255,255,0.05)', owner ? PLAYER.scarves[owner.id] : 'rgba(255,255,255,0.18)', owner ? 2.5 : 1.5);
    c.save(); c.translate(x + 36, cy0 + 75);
    drawCat(c, { id: owner ? owner.id : 0, cat: id, noTag: true, x: 0, y: 0, dir: 0, moving: false, swingT: 0, stun: 0 }, time);
    c.restore();
    label(c, K.name, x + 12, cy0 + 13, 16, '#ffffff', 'left', 700, null);
    label(c, fitText(c, K.desc, cw0 - 20, 11), x + 12, cy0 + 29, 11, '#cfe0ea', 'left', 500, null);
    pips(c, x + 92, cy0 + 51, 'Speed', K.speed);
    pips(c, x + 92, cy0 + 63, 'Baton', K.batonDamage / K.batonCooldown);
    pips(c, x + 92, cy0 + 75, 'Garden', K.growSpeed / (K.upgradeCost ?? 1));
    pips(c, x + 92, cy0 + 87, 'Bomb', ((K.bombRadius / K.bombRecharge) * (K.bombDamage ?? 1)) ** 0.4);
    if (owner && s.players.length > 1) {
      rrect(c, x + cw0 - 36, cy0 + 8, 28, 18, 9, PLAYER.scarves[owner.id]);
      label(c, `P${owner.id + 1}`, x + cw0 - 22, cy0 + 17.5, 11, '#fff', 'center', 700, null);
    }
    pickCursor(c, s, x, cy0, cw0, ch0, 15, 1, (p) => p.cat === id, time);
  });
  // flowers
  const N = FLOWER_ORDER.length, cw = 130, gap = 8, x0 = (VIEW_W - (N * cw + (N - 1) * gap)) / 2, y0 = 260, ch = 222;
  FLOWER_ORDER.forEach((t, i) => {
    const F = FLOWERS[t];
    const x = x0 + i * (cw + gap), cx = x + cw / 2;
    const pickedBy = s.players.filter((p) => p.pick.chosen.includes(t));
    rrect(c, x, y0, cw, ch, 14, pickedBy.length ? 'rgba(255,240,180,0.13)' : 'rgba(255,255,255,0.05)', 'rgba(255,255,255,0.18)', 1.5);
    drawFlower(c, { id: i, type: t, lvl: 3, x: cx, y: y0 + 66, angle: Math.PI / 2, flash: Math.sin(time * 2 + i) > 0.97 ? 0.1 : 0, hurtT: 0, hp: FLOWER_HP, headIdx: 0 }, time);
    label(c, F.name, cx, y0 + 106, 15, '#ffffff', 'center', 700, null);
    coinIcon(c, cx - 14, y0 + 125, 7);
    label(c, `${plantCost(t)}`, cx + 2, y0 + 126, 13, '#ffe27a', 'left', 700, null);
    wrapText(c, F.desc, cw - 14, 11.5).slice(0, 3).forEach((l, j) => label(c, l, cx, y0 + 142 + j * 13, 11.5, '#cfe0ea', 'center', 500, null));
    const st = flowerStats(t, 1);
    // every card: range, damage, how often (the poison cloud says how it works)
    const lines = [st.range >= GLOBAL_RANGE ? 'Range: whole map' : `Range ${(st.range / T).toFixed(1)}`];
    if (F.kind === 'cloud') lines.push(`${st.dmg} dmg/s per stack (x${st.stacks})`, `cloud every ${+st.rate.toFixed(2)}s`);
    else {
      lines.push(F.kind === 'chomp' ? `${st.dmg} + ${Math.round((st.maxHpBite || 0) * 100)}% max hp bite` : F.kind === 'bolt' ? `${st.dmg} dmg, pierces ${st.pierce}` : F.kind === 'pulse' ? (st.slow ? `slows to ${Math.round(st.slow * 100)}% for ${+st.slowSeconds.toFixed(1)}s` : `${st.dmg} dmg to all near`) : `${st.dmg} dmg`);
      lines.push(`every ${+st.rate.toFixed(2)}s`);
    }
    lines.forEach((t, j) => label(c, fitText(c, t, cw - 8, 11), cx, y0 + 215 - (lines.length - 1 - j) * 13, 11, j ? '#cfe0ea' : '#8fa5b3', 'center', 500, null));
    pickedBy.forEach((p) => {
      const n = p.pick.chosen.indexOf(t) + 1;
      const bx = p.id === 0 ? x + 18 : x + cw - 18;
      circle(c, bx, y0 + 18, 12, PLAYER.scarves[p.id], '#ffffff', 2);
      label(c, `${n}`, bx, y0 + 19, 13, '#fff', 'center', 700, null);
    });
    pickCursor(c, s, x, y0, cw, ch, 17, 2, (p) => p.pick.cursor === i, time);
  });
  // per-player status and controls
  s.players.forEach((p, i) => {
    const k = ui.keysFor(p.id);
    const y = y0 + ch + 20 + i * 24;
    const n = p.pick.chosen.length;
    const L = ui.keyLabel;
    const keys = p.pick.row === 0 ? `[${L(k.left)}/${L(k.right)}] change map · [${L(k.down)}] cats`
      : p.pick.row === 1 ? `[${L(k.left)}/${L(k.right)}] change cat · [${L(k.up)}] map · [${L(k.down)}] flowers`
      : `[${L(k.left)}/${L(k.right)}] move · [${L(k.build)}] pick · [${L(k.up)}] cats · [${L(k.atk)}] ready`;
    const who = `${CATS[p.cat].name}, `;
    const msg = p.pick.ready ? `Ready with ${CATS[p.cat].name}! ✓` : n < LOADOUT_SIZE ? `${who}${n}/${LOADOUT_SIZE} flowers   ${keys}` : `${who}${LOADOUT_SIZE}/${LOADOUT_SIZE} — [${L(k.atk)}] when ready   ${keys}`;
    rrect(c, VIEW_W / 2 - 360, y - 11, 32, 22, 11, PLAYER.scarves[p.id]);
    label(c, `P${p.id + 1}`, VIEW_W / 2 - 344, y + 0.5, 12, '#fff', 'center', 700, null);
    label(c, fitText(c, msg, 700, 14, 600), VIEW_W / 2 - 318, y + 1, 14, p.pick.ready ? '#8dff9a' : '#e8f1f7', 'left', 600, null);
  });
}

function drawOverlay(c, title, sub, col) {
  c.fillStyle = 'rgba(12,18,26,0.72)'; c.fillRect(0, 0, VIEW_W, VIEW_H);
  label(c, title, VIEW_W / 2, VIEW_H / 2 - 40, 60, col, 'center', 700, OUT);
  sub.forEach((l, i) => label(c, l, VIEW_W / 2, VIEW_H / 2 + 20 + i * 32, 20, '#fff', 'center', 500, null));
}

// The victory / defeat screen with the game's numbers (ui.summary, made by
// gameSummary in stats.js; online the host sends it to the guest). Until it
// is there, just the title and keys.
const short = (v) => (v >= 1e5 ? `${Math.round(v / 1000)}k` : v >= 1e4 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`);
const monsterName = (t) => (INTROS[t]?.[0] || t[0].toUpperCase() + t.slice(1) + 's').replace(/!$/, ''); // intro titles are already plural
function drawEndScreen(c, s, ui, time) {
  const won = s.won, S = ui.summary;
  const col = won ? '#8dff9a' : '#ff7a6a', keys = `${won ? 'R: play again' : 'R: try again'}  ·  Esc: menu  ·  L: download the game log`;
  const head = won ? `All ${TOTAL_WAVES} waves defended  ·  ${s.kills} monsters bonked` : `You reached wave ${s.wave}  ·  ${s.kills} monsters bonked`;
  if (!S) { drawOverlay(c, won ? 'Victory!' : 'The garden fell…', [head, keys], col); return; }
  c.fillStyle = 'rgba(12,18,26,0.86)'; c.fillRect(0, 0, VIEW_W, VIEW_H);
  label(c, won ? 'Victory!' : 'The garden fell…', VIEW_W / 2, 50, 46, col, 'center', 700, OUT);
  const mins = Math.floor(S.seconds / 60), secs = String(S.seconds % 60).padStart(2, '0');
  label(c, `${won ? `All ${TOTAL_WAVES} waves` : `Wave ${S.wave}/${TOTAL_WAVES}`}  ·  ${mins}:${secs}  ·  ${S.kills} monsters bonked  ·  cottage ${S.cottage}/${S.maxCottage}`, VIEW_W / 2, 96, 18, '#e8f1f7', 'center', 500, null);
  const top = 124, h = 444;

  // flowers: damage per type, biggest first
  const fx = 32, fw = 540;
  rrect(c, fx, top, fw, h, 14, 'rgba(255,255,255,0.06)', 'rgba(255,255,255,0.15)', 1.5);
  label(c, 'Flowers', fx + 18, top + 24, 20, '#ffe27a', 'left', 700, null);
  label(c, 'damage', fx + fw - 18, top + 24, 13, '#8fa5b3', 'right', 600, null);
  const maxDmg = Math.max(1, ...S.flowers.map((f) => f.dmg));
  const rowH = Math.min(52, (h - 120) / Math.max(1, S.flowers.length));
  S.flowers.forEach((f, i) => {
    const y = top + 62 + i * rowH, F = FLOWERS[f.type];
    c.save(); c.translate(fx + 34, y + 8); c.scale(0.5, 0.5);
    drawFlower(c, { id: i, type: f.type, lvl: 3, x: 0, y: 0, angle: -Math.PI / 2, flash: 0, hurtT: 0, hp: 100, headIdx: 0, grow: null }, time);
    c.restore();
    label(c, F?.name || f.type, fx + 62, y - 6, 16, '#fff', 'left', 600, null);
    label(c, `${f.planted} planted  ·  ${f.kills} kills`, fx + 62, y + 13, 12, '#8fa5b3', 'left', 500, null);
    const bx = fx + 220, bw = fw - 220 - 80;
    rrect(c, bx, y - 7, bw, 14, 7, 'rgba(255,255,255,0.08)');
    rrect(c, bx, y - 7, Math.max(14, bw * f.dmg / maxDmg), 14, 7, F?.color || '#fff', OUT, 1.2);
    label(c, short(f.dmg), fx + fw - 18, y, 15, '#fff', 'right', 600, null);
  });
  if (S.best) {
    const F = FLOWERS[S.best.type];
    label(c, `Star flower: ${F?.name || S.best.type} (level ${S.best.lvl})  ·  ${short(S.best.dmg)} damage  ·  ${S.best.kills} kills`, fx + 18, top + h - 22, 14, '#ffe27a', 'left', 600, null);
  }

  // cats: coins and damage each
  const cx = fx + fw + 16, cw = VIEW_W - cx - 32;
  rrect(c, cx, top, cw, h, 14, 'rgba(255,255,255,0.06)', 'rgba(255,255,255,0.15)', 1.5);
  label(c, 'Cats', cx + 18, top + 24, 20, '#ffe27a', 'left', 700, null);
  const blockH = S.cats.length > 1 ? 150 : 170;
  S.cats.forEach((k, i) => {
    const y = top + 50 + i * (blockH + 8), K = CATS[k.cat] || {};
    c.save(); c.translate(cx + 40, y + 34); c.scale(1.1, 1.1);
    drawCat(c, { id: i, cat: k.cat, noTag: true, x: 0, y: 0, dir: 0, moving: false, stun: 0, swingT: 0, swingDir: 0 }, time);
    c.restore();
    label(c, `P${i + 1}  ${K.name || k.cat}`, cx + 76, y + 14, 18, ['#8fc3ff', '#ff9ab8'][i], 'left', 700, null); // scarf colours, lightened
    const rows = [['Coins earned', k.earned], ['Spent on flowers', k.spent], ['Baton damage', short(k.baton)], ['Bomb damage', short(k.bomb)], ['Monsters bonked', k.kills], ['Their flowers dealt', short(k.garden)]];
    rows.forEach(([name, v], j) => {
      const colX = cx + 76 + (j % 2) * ((cw - 90) / 2), ry = y + 44 + Math.floor(j / 2) * 30;
      label(c, name, colX, ry, 12, '#8fa5b3', 'left', 500, null);
      label(c, `${v}`, colX, ry + 15, 16, '#fff', 'left', 600, null);
    });
  });
  label(c, S.bitten.length ? `Bit the cottage most: ${S.bitten.map(([t, v]) => `${monsterName(t)} ${v}`).join('  ·  ')}` : 'Nothing bit the cottage!', VIEW_W / 2, top + h + 24, 16, S.bitten.length ? '#ffb3a8' : '#8dff9a', 'center', 600, null);
  label(c, keys, VIEW_W / 2, VIEW_H - 30, 18, '#fff', 'center', 500, null);
}

// The flower guide (I in the menu or while picking): one flower at a time,
// what each level costs and what it improves. The numbers come straight from
// the balance data, so the guide never goes stale.
const fmt = (v) => (v >= 100 ? Math.round(v) : +v.toFixed(v >= 10 ? 1 : 2)).toString();
function guideRows(t) {
  const F = FLOWERS[t];
  const lv = Array.from({ length: MAX_LEVEL }, (_, i) => i + 1);
  const st = lv.map((l) => flowerStats(t, l));
  const costs = lv.map((l) => (l === 1 ? plantCost(t) : upgradeCost(t, l - 1)));
  // only what helps choose and upgrade; the rest (growing time, wear, cloud
  // size...) is in the README and balance.json
  const rows = [['Cost', costs.map((v) => `${v}`)]];
  if (F.kind === 'cloud') {
    rows.push(['Poison per stack', st.map((x) => `${fmt(x.dmg)}/s`)], ['Max stacks', st.map((x) => `${x.stacks}`)],
      ['Cloud every', st.map((x) => `${fmt(x.rate)}s`)]);
  } else if (st[0].slow) {
    rows.push(['Slows to', st.map((x) => `${Math.round(x.slow * 100)}%`)], ['Slow lasts', st.map((x) => `${fmt(x.slowSeconds)}s`)],
      ['Pulse every', st.map((x) => `${fmt(x.rate)}s`)]);
  } else {
    rows.push([F.kind === 'chomp' ? 'Bite' : F.kind === 'pulse' ? 'Damage (all near)' : 'Damage', st.map((x) => fmt(x.dmg))],
      ['Attacks every', st.map((x) => `${fmt(x.rate)}s`)]);
    if (F.kind === 'bolt') rows.push(['Pierces', st.map((x) => `${x.pierce} monsters`)]);
  }
  rows.push(['Range', st.map((x) => (x.range >= GLOBAL_RANGE ? 'whole map' : `${fmt(x.range / T)} tiles`))]);
  if (F.kind === 'cloud') rows.push(['Max poison/s', st.map((x) => fmt(x.dmg * x.stacks))]);
  else if (!st[0].slow) rows.push(['Damage/s', st.map((x) => fmt(x.dmg / x.rate))]);
  return rows;
}

function drawGuide(c, time, sel) {
  c.fillStyle = 'rgba(12,18,26,0.94)'; c.fillRect(0, 0, VIEW_W, VIEW_H);
  label(c, 'Flower guide', VIEW_W / 2, 28, 28, '#ffe27a', 'center', 700, OUT);
  // every flower along the top; the chosen one lit up
  const N = FLOWER_ORDER.length, w = Math.min(120, (VIEW_W - 40) / N), x0 = (VIEW_W - N * w) / 2;
  FLOWER_ORDER.forEach((t, i) => {
    const x = x0 + i * w, on = i === sel;
    rrect(c, x + 4, 52, w - 8, 92, 12, on ? 'rgba(255,226,122,0.16)' : 'rgba(255,255,255,0.04)', on ? '#ffe27a' : 'rgba(255,255,255,0.14)', on ? 2.5 : 1);
    drawFlower(c, { id: i, type: t, lvl: 2, x: x + w / 2, y: 100, angle: Math.PI / 2, flash: 0, hurtT: 0, hp: FLOWER_HP, headIdx: 0 }, time);
    label(c, fitText(c, FLOWERS[t].name, w - 14, 12), x + w / 2, 132, 12, on ? '#ffffff' : '#a9bccb', 'center', 700, null);
  });
  const t = FLOWER_ORDER[sel], F = FLOWERS[t];
  // left: what it is
  const lx = 36;
  label(c, F.name, lx, 176, 24, '#ffffff', 'left', 700, null);
  wrapText(c, F.desc, 230, 14).forEach((l, j) => label(c, l, lx, 202 + j * 18, 14, '#cfe0ea', 'left', 500, null));
  const tags = [];
  if (F.groundOnly) tags.push(['Ground only', '#d9a066']); else tags.push(['Hits flyers too', '#8fe3ff']);
  if (F.kind === 'cloud') tags.push(['Ignores armour', '#9ad14b']);
  if (F.kind === 'chomp') tags.push(['Swallows small critters whole', '#e0569b'], [`Bites off ${Math.round((F.maxHpBite || 0) * 100)}% of max health`, '#e0569b']);
  if (F.kind === 'beam') tags.push(['Aims at the toughest monster', '#ffd23f']);
  if (F.kind === 'bolt') tags.push(['Hits several in a line', '#ff7a2f']);
  if (F.kind === 'pulse' && !F.slow) tags.push(['Hits everything near', '#ff4d5e']);
  tags.forEach(([txt, col], j) => {
    c.font = `600 12px ${FONT}`;
    const tw = c.measureText(txt).width + 18;
    rrect(c, lx, 262 + j * 28, tw, 22, 11, 'rgba(255,255,255,0.06)', col, 1.5);
    label(c, txt, lx + 9, 273.5 + j * 28, 12, col, 'left', 600, null);
  });
  const notes = [
    'Each level: more damage, a little more range, faster attacks.',
    'Level 5 flowers never wear out.',
  ];
  let ny = 262 + tags.length * 28 + 20;
  for (const n of notes) for (const l of wrapText(c, n, 240, 12)) { label(c, l, lx, ny, 12, '#8fa5b3', 'left', 500, null); ny += 16; }
  // right: the five levels side by side
  const rows = guideRows(t);
  const tx = 300, lw = 150, cw = (VIEW_W - 30 - tx - lw) / MAX_LEVEL;
  rrect(c, tx - 12, 160, VIEW_W - 30 - tx + 24, 150 + rows.length * 34, 14, 'rgba(255,255,255,0.04)', 'rgba(255,255,255,0.12)', 1);
  for (let l = 1; l <= MAX_LEVEL; l++) {
    const cx = tx + lw + (l - 0.5) * cw;
    drawFlower(c, { id: sel * 7 + l, type: t, lvl: l, x: cx, y: 236, angle: Math.PI / 2, flash: 0, hurtT: 0, hp: FLOWER_HP, headIdx: 0 }, time);
    label(c, `Level ${l}`, cx, 280, 14, l === MAX_LEVEL ? '#ffe27a' : '#ffffff', 'center', 700, null);
  }
  rows.forEach(([name, vals], r) => {
    const y = 312 + r * 34;
    if (r % 2 === 0) rrect(c, tx - 4, y - 15, VIEW_W - 30 - tx + 8, 30, 6, 'rgba(255,255,255,0.04)');
    label(c, name, tx + 4, y, 14, '#a9bccb', 'left', 600, null);
    vals.forEach((v, l) => {
      const up = l > 0 && v !== vals[l - 1];
      label(c, fitText(c, v, cw - 6, 15, 600), tx + lw + (l + 0.5) * cw, y, 15, r < 1 ? '#ffe27a' : up ? '#ffffff' : '#a9bccb', 'center', 600, null);
    });
  });
  label(c, '←/→ or A/D: other flowers  ·  I or Esc: close', VIEW_W / 2, VIEW_H - 22, 14, '#8fa5b3', 'center', 500, null);
}

function drawMenu(c, time, ui) {
  c.fillStyle = 'rgba(12,18,26,0.55)'; c.fillRect(0, 0, VIEW_W, VIEW_H);
  const cx = VIEW_W / 2;
  rrect(c, cx - 360, 40, 720, 570, 24, 'rgba(30,38,48,0.92)', 'rgba(255,255,255,0.25)', 2);
  label(c, 'Petal Patrol', cx, 100, 64, '#ffe27a', 'center', 700, OUT);
  label(c, 'Two cats. One garden. Many, many monsters.', cx, 146, 18, '#cfe0ea', 'center', 500, null);
  drawCat(c, { id: 0, cat: 'scout', x: cx - 250, y: 100, dir: 0, moving: true, swingT: 0, stun: 0 }, time);
  drawCat(c, { id: 1, cat: 'gardener', x: cx + 250, y: 100, dir: Math.PI, moving: true, swingT: 0, stun: 0 }, time);
  FLOWER_ORDER.forEach((t, i) => {
    const lvl = [1, 3, 2, 2, 4, 3, 2][i];
    const x = cx - 285 + i * 95;
    drawFlower(c, { id: i, type: t, lvl, x, y: 236, angle: Math.PI / 2, flash: 0, hurtT: 0, hp: FLOWER_HP, headIdx: 0 }, time);
    label(c, FLOWERS[t].name, x, 278, 13, '#ffffff', 'center', 600, null);
  });
  const pulse = 0.75 + Math.sin(time * 4) * 0.25;
  c.globalAlpha = pulse;
  label(c, '1  Solo     2  Local co-op     3  Host online     4  Join online', cx, 318, 22, '#ffffff', 'center', 600, null);
  c.globalAlpha = 1;
  const rows = [
    ['', 'Move', 'Sprint', 'Baton', 'Bomb', 'Plant / upgrade', 'Heal', 'Next / mode'],
    ...ui.keys.map((k, i) => [`P${i + 1}`, i === 0 ? [k.up, k.left, k.down, k.right].map(ui.keyLabel).join('') : 'Arrows',
      ui.keyLabel(k.sprint), ui.keyLabel(k.atk), ui.keyLabel(k.bomb), ui.keyLabel(k.build), ui.keyLabel(k.heal), ui.keyLabel(k.cycle)]),
  ];
  const cols = [cx - 300, cx - 228, cx - 158, cx - 98, cx - 42, cx + 48, cx + 140, cx + 230];
  rows.forEach((r, ri) => r.forEach((t, ci) => label(c, t, cols[ci], 358 + ri * 28, ri ? 16 : 13, ri ? '#fff' : '#8fa5b3', 'center', ri ? 600 : 500, null)));
  const tips = [
    'Plant key: build mode, again to plant a seedling, then HOLD to pour coins in. Next-flower key cycles.',
    'Flowers wear out as they fight: stand on one and HOLD the heal key. Mode key on a flower: dig it up for 60% back.',
    `Each player picks a different cat and ${LOADOUT_SIZE} of the ${FLOWER_ORDER.length} flowers. In co-op, each cat keeps the coins it picks up.`,
  ];
  tips.forEach((t, i) => label(c, t, cx, 455 + i * 24, 13.5, '#cfe0ea', 'center', 500, null));
  label(c, 'Enter: early wave  ·  P or Esc: pause  ·  N: sound  ·  J: effects  ·  I: flower guide  ·  L: game logs', cx, 545, 14, '#8fa5b3', 'center', 500, null);
  label(c, 'Online, both players use the P1 keys (or arrows) on their own keyboard.', cx, 570, 13, '#8fa5b3', 'center', 500, null);
}

// The depth-sorted draw list, reused every frame.
const FLOWER = 0, ENEMY = 1, CAT = 2, TREE = 3;
const actors = [], actorPool = [];
function addActor(y, kind, o) {
  const a = actorPool[actors.length] || (actorPool[actors.length] = {});
  a.y = y; a.kind = kind; a.o = o;
  actors.push(a);
}
const byY = (a, b) => a.y - b.y;

// For tools/gallery.html and tools/maps.html: drawn exactly as in the game.
export { drawFlower, drawCat, drawEnemy, getBg, drawTree, drawCottage };

export function render(c, s, ui) {
  const time = performance.now() / 1000;
  setSpriteScale(ui.dpr);
  c.clearRect(0, 0, VIEW_W, VIEW_H);
  const camX = Math.round(ui.cam.x), camY = Math.round(ui.cam.y);
  c.save();
  if (ui.shake > 0) c.translate((Math.random() - 0.5) * ui.shake * 2, (Math.random() - 0.5) * ui.shake * 2);
  const m = s ? s.m : ui.menuMap; // the menu shows the last map played
  drawBg(c, m, ui.dpr, camX, camY);
  c.translate(-camX, -camY);
  for (const path of m.paths) {
    const ex = path.waypoints[0].x - Math.cos(path.dir) * T * 0.55, ey = path.waypoints[0].y - Math.sin(path.dir) * T * 0.55;
    for (let i = 0; i < 3; i++) {
      const a = time * 2 + i * 2.1;
      circle(c, ex + Math.cos(a) * 10, ey + Math.sin(a) * 10, 5, 'rgba(160,110,255,0.6)');
    }
  }
  if (!s) {
    for (const o of m.obstacles) if (o.type === 'tree') drawTree(c, o, time);
    drawCottage(c, m.base.x, m.base.y, 1, 1, 0, time);
    c.restore();
    if (ui.guide != null) drawGuide(c, time, ui.guide); else drawMenu(c, time, ui);
    if (ui.note && performance.now() < ui.note.until) label(c, ui.note.txt, VIEW_W / 2, VIEW_H - 24, 16, '#ffffff', 'center', 700);
    return;
  }
  observeJuice(s);
  // only draw what's on (or near) the screen
  const M = T * 1.5;
  const vis = (o) => o.x > camX - M && o.x < camX + VIEW_W + M && o.y > camY - M && o.y < camY + MAP_H + M;
  for (const p of s.players) drawBuildGhost(c, p, s, time);
  drawCottage(c, m.base.x, m.base.y, s.lives, s.maxLives, s.baseHitT, time);
  for (const cl of s.clouds) if (vis(cl)) drawCloud(c, cl, time);
  for (const d of s.drops) if (vis(d)) drawDrop(c, d, time);
  // things standing on the ground, drawn back to front
  actors.length = 0;
  for (const f of s.flowers) if (vis(f)) addActor(f.y + T * 0.2, FLOWER, f);
  for (const e of s.enemies) if (!e.def.flying && vis(e)) addActor(e.y, ENEMY, e);
  for (const p of s.players) addActor(p.y, CAT, p);
  for (const o of m.obstacles) {
    if (o.type === 'tree' && vis({ x: (o.x + 0.5) * T, y: (o.y + 0.5) * T })) addActor((o.y + 0.75) * T, TREE, o);
  }
  actors.sort(byY);
  for (const a of actors) {
    if (a.kind === FLOWER) drawFlower(c, a.o, time);
    else if (a.kind === ENEMY) drawEnemy(c, a.o, time);
    else if (a.kind === CAT) drawCat(c, a.o, time);
    else drawTree(c, a.o, time);
  }
  for (const f of s.flowers) if (vis(f)) drawFlowerStatus(c, f, s);
  for (const p of s.players) if (p.working) drawWorkStream(c, p, time);
  for (const e of s.enemies) if (e.def.flying && vis(e)) drawEnemy(c, e, time);
  for (const pr of s.projs) if (vis(pr)) drawProj(c, pr, time);
  for (const b of s.bombs) drawBomb(c, b, time);
  drawFx(c);
  drawJuiceWorld(c);
  c.restore();
  c.save();
  drawEdgeMarkers(c, s, ui);
  drawBanners(c);
  drawIntros(c, ui, time);
  drawMinimap(c, s, ui);
  c.restore();
  drawHud(c, s, time, ui);
  drawJuiceScreen(c);
  if (ui.netLabel) {
    const txt = `${ui.netLabel} · ${Math.round(ui.fps)} fps`;
    c.font = `600 13px ${FONT}`;
    const w = c.measureText(txt).width + 26;
    rrect(c, 10, 8, w, 24, 12, 'rgba(20,28,36,0.75)', 'rgba(255,255,255,0.3)', 1.5);
    circle(c, 22, 20, 4, ui.netLabel.includes('disconnected') ? '#ff6a5a' : '#6be06b');
    label(c, txt, 32, 20.5, 13, '#e8f1f7', 'left', 600, null);
  }
  if (s.phase === 'pick' && !ui.disconnected) drawPick(c, s, ui, time);
  if (ui.guide != null) drawGuide(c, time, ui.guide);
  if (ui.disconnected) drawOverlay(c, 'Disconnected', ['The connection to the host was lost', 'Esc: back to menu'], '#ff7a6a');
  else if (ui.paused) drawOverlay(c, 'Paused', ['P or Esc: resume', 'R: restart this map  ·  M: back to the menu'], '#ffffff');
  else if (s.over || s.won) drawEndScreen(c, s, ui, time);
  if (ui.note && performance.now() < ui.note.until) label(c, ui.note.txt, VIEW_W / 2, MAP_H - 24, 16, '#ffffff', 'center', 700);
}
