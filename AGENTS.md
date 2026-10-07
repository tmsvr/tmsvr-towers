# AGENTS.md

Guide for anyone (human or AI agent) working on **Petal Patrol**, a co-op
tower defense game for the browser: cats plant flower creatures and bonk
monsters to protect their cottage. Player-facing docs are in `README.md`; the
idea backlog is `IDEAS.md`.

## At a glance

- **Plain ES modules + `<canvas>`.** No framework, no bundler, no npm, no
  build step. What is in the repo is exactly what the browser runs.
- **All art and sound are procedural** (drawn with canvas calls in
  `src/render.js`, synthesised with Web Audio in `src/audio.js`). There are
  no image or audio files.
- **All tunable numbers live in JSON**: `balance.json` (flowers, enemies,
  waves, economy, cats) and `maps.json` (map layouts). Code reads them at
  startup; balance changes almost never need code changes.
- **Online co-op** is peer to peer over WebRTC through PeerJS (loaded from
  jsDelivr in `index.html`), using PeerJS's free public broker. There is no
  server of our own.
- **Hosting** is GitHub Pages, served straight from the `main` branch root.

## Run it locally

```bash
python3 serve.py          # http://localhost:8765  (optional: python3 serve.py 9000)
```

`serve.py` is Python's static file server with `Cache-Control: no-store`, so
edits show up on a normal reload. Any static server works, but others may cache.
Opening `index.html` as a `file://` URL does **not** work, because ES modules
and `fetch` of the JSON files need HTTP.

Claude Code users: `.claude/launch.json` defines this server as `towers`
(port 8765) for the preview browser.

## Project layout

| Path | What it is |
|---|---|
| `index.html` | The page: canvas, lobby DOM for online play, CSS, PeerJS script tag |
| `balance.json` | Every gameplay number, in tiles and seconds. `_help` explains the fields |
| `maps.json` | Maps: roads (waypoints), cottage, start, obstacles, `waveSize`, `startCoins`, scatter. `_help` explains the fields |
| `src/data.js` | Loads both JSON files (top-level `await fetch`), converts to pixel units, derives flower stats per level, prepares maps (decks, bridges, colliders), computes `DATA_HASH` |
| `src/sim.js` | **The game rules.** Pure state + `step(state, inputs, dt)`. No DOM, no drawing |
| `src/stats.js` | Game log hooks the sim calls (damage, coins, waves…). Counting only, never affects play |
| `src/render.js` | Draws everything: world, flowers, cats, enemies, HUD, menu, pick screen, flower guide |
| `src/fx.js`, `src/juice.js` | Visual-only effects (particles, damage numbers, squash, hit-stop) |
| `src/audio.js` | Procedural sound effects and adaptive music |
| `src/main.js` | Entry point: keyboard input, fixed-step game loop, menus, camera, lobby, game logs (L key), canvas sizing |
| `src/net.js` | PeerJS wrapper: a reliable channel and a fast, unreliable one |
| `src/schema.js` | Binary encoding of snapshots and guest inputs; defines `PROTOCOL` |
| `src/host.js` / `src/guest.js` | Each side of an online game (host-authoritative) |
| `src/snapshot.js` | Host builds snapshots; guest interpolates between them |
| `src/predict.js` | Guest-side prediction of its own cat, reconciled with the host |
| `src/util.js` | Seeded RNG, `clamp`, small helpers |
| `tools/bot.js` | Autopilot that plays whole games through the real sim |
| `tools/balance-test.html` | UI for running the autopilot over many seeds and maps |
| `tools/gallery.html` | Every flower at every level and every cat (standing and swinging), drawn with the real render code. `?zoom=5` for close-ups |
| `tools/maps.html` | Every map from `maps.json` drawn whole with the real render code (roads, ponds, bridges, scatter, cottage, entrances) |
| `serve.py` | No-cache local server |
| `.nojekyll` | Tells GitHub Pages to serve files untouched |

## Architecture

```
keyboard ──► main.js ──inputs──► sim.step(state, inputs, 1/60) ──► state
                │                         │ events (sounds, fx)
                │                         ▼
                └──────────────► render.js / fx.js / juice.js / audio.js
```

- **Fixed timestep.** The sim always advances in 1/60 s ticks (`DT` in
  `main.js`); the render runs at display rate.
- **Determinism.** The sim uses only its own seeded RNG (`rnd(s)`), never
  `Math.random()`, so the same seed and inputs give the same game. Visual-only
  code (`fx.js`, `juice.js`) may use `Math.random()`.
- **Sim/render split.** `sim.js` must stay free of DOM and canvas so it can run
  on the online host and in `tools/bot.js`. It communicates outward through
  events on the state (`ev(s, 'chomp')`, banners, fx requests).
- **Units.** JSON is in tiles and seconds; `data.js` converts to pixels (`T` =
  56 px per tile, `U` scales art). Positions in the sim are pixels.
- **Fixed logical screen.** Everything is laid out for `VIEW_W × VIEW_H`
  (1008 × 656: an 18 × 10 tile map view plus a 96 px HUD). CSS scales the
  canvas to fit the window; `fitCanvas()` in `main.js` gives the backing store
  as many real pixels as it is shown at (capped at 2×: bigger makes Firefox
  slow). Online, the top-left label shows ping and frame rate. Caches (map background,
  sprite heads) are keyed by that scale (`ui.dpr`).
- **Game phases.** Menu → pick screen (`s.phase === 'pick'`: map, cat, 3
  flowers per player) → waves → won/over overlay.

### Online play

- **Host-authoritative.** The host runs `sim.js`; the guest sends inputs (one
  per tick, numbered and resent until acknowledged) and receives binary
  snapshots on the unreliable channel. Sounds and effects ride along.
- **The guest predicts its own cat** (`predict.js`) and blends everything else
  between snapshots (`snapshot.js`).
- **Version check on join.** Both sides compare `PROTOCOL` (in `schema.js`)
  and `DATA_HASH` (a hash of `balance.json` + `maps.json`). If they differ, the
  host refuses with "a different version of the game", so **both players must
  run the same deploy** (hard reload after an update).
- **If you change what a snapshot or input contains** (`schema.js` field
  lists), **bump `PROTOCOL`**.

## Common changes

| I want to… | Do this |
|---|---|
| Rebalance (damage, costs, HP, waves, economy) | Edit `balance.json`. The flower guide (I key) and pick cards update themselves |
| Change a map, or add one | Edit/add an entry in `maps.json`, then look at it whole in `/tools/maps.html`. Roads are lists of corner points; each segment must be horizontal or vertical; every road ends at `base`. Check reachability (a scatter seed can wall off a tile; change `scatter.seed`) |
| Make a map easier or harder | `waveSize` (monster count; boss HP scales with its square root) and `startCoins` in `maps.json` |
| Add a flower | New entry in `balance.json → flowers` (its `kind` picks the attack code in `sim.js`; a new kind needs new code there), plus its look in `render.js` (`SPEC`, `PERSONA`, `BODIES`). The pick screen, guide and network encoding pick it up automatically; bump `PROTOCOL` |
| Add an enemy | Entry in `balance.json → enemies`, plus a `waves` entry (`fromWave`, `weight`, `cost`, `group`) so it spawns, and its drawing in `drawEnemy` (`render.js`). Bump `PROTOCOL` |
| Add a key | `KEYS` in `main.js` (P1 and P2 layouts); show it in the menu (`drawMenu`) and README. Online inputs are flags in `schema.js` (`INPUT_FLAGS`, bump `PROTOCOL`) |
| Change art | `render.js`, then check `tools/gallery.html` |
| Log more for balancing | Add a hook in `stats.js` and call it from `sim.js` |

## Testing

There is no automated test suite. Check changes like this:

1. **Run it**: `python3 serve.py`, play a few waves (solo is quickest: press 1).
   Check the browser console for errors.
2. **Balance sanity**: open `/tools/balance-test.html`, choose map and players,
   run several games. The bot never uses bombs and plays crudely, so its
   results are a *lower bound* on what real players manage. From the console:
   `(await import('/tools/bot.js')).runBot({ players: 2, seed: 1, map: 0 })`
   returns `{ won, wave, lives, log }`.
3. **Art**: `/tools/gallery.html` (add `?zoom=5`).
4. **Real playtest logs**: players press **L** to download the last 20 games
   as JSON (per wave: monsters, cottage damage by type and by road, coins
   earned/spent per cat, time spent per activity, damage and kills per flower
   type, garden snapshot; plus a timeline of plants, level-ups, heals, digs,
   bombs, leaks and cat positions, and a per-flower record with tile, levels
   and own damage). The format is documented at the top of `src/stats.js`.
   This is the main source for balance decisions; online, only the host has
   it. `runBot()` returns the same log as `game`.
5. **Online**: open two browser windows; host with 3, join with 4 using the
   room code. Test with the same build in both.

Useful console checks (modules can be imported directly):

```js
const d = await import('/src/data.js');
d.flowerStats('daisy', 5);   // a flower's numbers at a level
d.plantCost('thorn'); d.upgradeCost('thorn', 4);
```

## Deploying

- Push to `main` → GitHub Pages redeploys (about 1 minute). Live at
  https://tmsvr.github.io/tmsvr-towers/
- Check the build: `gh api repos/tmsvr/tmsvr-towers/pages/builds/latest --jq .status`
- Pages caches files for up to 10 minutes. After a deploy, **every player
  hard reloads** (Cmd+Shift+R / Ctrl+Shift+R), otherwise mismatched versions
  refuse to connect online.

## Conventions

- **Code style**: modern JS (ES2022, top-level await), 2-space indent, single
  quotes, semicolons, compact one-line helpers. Comments explain *why* and
  game intent in plain language; match the density of the surrounding code.
- **Keep the sim pure**: no DOM, canvas, audio or `Math.random()` in `sim.js`.
- **Numbers belong in JSON**, not in code, whenever someone might want to tune
  them; document new fields in the JSON `_help` section.
- **Commits**: one meaningful change per commit, imperative summary line
  (e.g. "Coin drops fade 5% per wave; weaker Thornrose").
- **Docs**: when controls or features change, update `README.md` (players),
  the menu text in `render.js` and this file (developers).
- **Browser support**: current desktop Chrome, Firefox and Safari; keyboard
  only (no touch controls).
