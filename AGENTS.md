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
| `maps.json` | Maps: roads (waypoints), cottage, start, obstacles, `waveSize`, `startCoins`, `waveSet`, scatter. `_help` explains the fields |
| `src/data.js` | Loads both JSON files (top-level `await fetch`), converts to pixel units, derives flower stats per level, prepares maps (decks, bridges, colliders), computes `DATA_HASH` |
| `src/sim.js` | **The game rules.** Pure state + `step(state, inputs, dt)`. No DOM, no drawing |
| `src/stats.js` | Game log hooks the sim calls (damage, coins, waves…). Counting only, never affects play. `gameSummary` makes the end screen's numbers (the host sends them to the guest as a `summary` message) |
| `src/render.js` | Draws everything: world, flowers, cats, enemies, HUD, menu, pick screen, flower guide |
| `src/fx.js`, `src/juice.js` | Visual-only effects (particles, damage numbers, squash, hit-stop) |
| `src/audio.js` | Procedural sound effects and adaptive music |
| `src/main.js` | Entry point: keyboard input, fixed-step game loop, menus, camera, lobby, game logs (L key), canvas sizing |
| `src/net.js` | PeerJS wrapper: a reliable channel and a fast, unreliable one |
| `src/schema.js` | Binary encoding of snapshots and guest inputs; defines `PROTOCOL` |
| `src/host.js` / `src/guest.js` | Each side of an online game (host-authoritative) |
| `src/snapshot.js` | Host builds snapshots; guest interpolates between them |
| `src/predict.js` | Guest-side prediction of its own cat, reconciled with the host |
| `src/save.js` | Saved games (S on the pause screen, O on the menu): the whole state as JSON, keeping shared references (`$id`/`$ref`) and naming shared data (monster types, maps) |
| `src/util.js` | Seeded RNG, `clamp`, small helpers |
| `tools/bot.js` | Autopilot that plays whole games through the real sim |
| `tools/balance-test.html` | UI for running the autopilot over many seeds and maps |
| `tools/gallery.html` | Every flower at every level, every cat (standing and swinging) and every monster, drawn with the real render code. `?zoom=5` for close-ups |
| `tools/tests.html`, `tools/tests.js` | The test suite: prices, maps, monsters, endless mode, whole autopilot games, saved games, online encoding, drawing. Runs in the browser |
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
  flowers per player) → waves → won/over overlay. After a win, C carries on
  into endless mode (`continueEndless`): wave 11 is a smaller breather, then
  waves barely grow in number while health and boss count climb
  (`breatherWaveSize`, `endless*` in `balance.json → difficulty`).
- **Saved games.** S on the pause screen downloads the whole state
  (`save.js`); O on the menu loads it, paused. A loaded game is just a state,
  so it carries on exactly as it would have (the tests check this).

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
- **Back to the menu together.** Leaving a game (pause → M, or Esc on the
  end screen) sends `{t: 'menu'}` and both sides go to the main menu still
  connected (`ui.online`). There 3 or Enter starts a new game (the guest sends
  `again`, the host answers `start` and the guest makes a fresh input link);
  Esc or another mode leaves. The guest ignores snapshots until `start`, since
  the old game's may still be arriving.
- **Saves online** are made and loaded by the host. A loaded online save
  either resumes at once (partner still connected) or opens a room and
  resumes when P2 joins (`pendingSave`).

## Common changes

| I want to… | Do this |
|---|---|
| Rebalance (damage, costs, HP, waves, economy) | Edit `balance.json`. The flower guide (I key) and pick cards update themselves |
| Change a map, or add one | Edit/add an entry in `maps.json`, then look at it whole in `/tools/maps.html`. Roads are lists of corner points; each segment must be horizontal or vertical; every road ends at `base`. Check reachability (a scatter seed can wall off a tile; change `scatter.seed`) |
| Make a map easier or harder | `waveSize` (monster count; boss HP scales with its square root) and `startCoins` in `maps.json` |
| Add a flower | New entry in `balance.json → flowers` (its `kind` picks the attack code in `sim.js`; a new kind needs new code there), plus its look in `render.js` (`SPEC`, `PERSONA`, `BODIES`). The pick screen, guide and network encoding pick it up automatically; bump `PROTOCOL` |
| Add an enemy | Entry in `balance.json → enemies`, plus an entry in `waves` or a `waveSets` list (`fromWave`, `weight`, `cost`, `group`) so it spawns, an `intros` card, and its drawing in `drawEnemy` (`render.js`; check it in `/tools/gallery.html`). Bump `PROTOCOL` |
| Give a map its own monsters | Add a list to `balance.json → waveSets` and name it with `waveSet` in the map's `maps.json` entry. Maps without one use `waves`. `fromWave: [lo, hi]` makes a type arrive in a random wave in that range (rolled once per game) |
| Add a key | `KEYS` in `main.js` (P1 and P2 layouts); show it in the menu (`drawMenu`) and README. Online inputs are flags in `schema.js` (`INPUT_FLAGS`, bump `PROTOCOL`) |
| Change art | `render.js`, then check `tools/gallery.html` |
| Log more for balancing | Add a hook in `stats.js` and call it from `sim.js` |

## Testing

Check changes like this:

1. **Tests**: open `/tools/tests.html` (or from the console
   `(await import('/tools/tests.js')).runTests()`). They drive the real
   modules: every price shown matches what each cat pays (planting, upgrades,
   half-paid levels, healing, digging), maps are well formed and every road
   is reachable on foot, monster rules (frost-proof, leaping, enrage, ranged
   arrival waves, Snapdragon bites), endless mode (breather, wave size, extra
   health and bosses, retrying a wave), every Bloom ability, elite traits and
   each power-up, boss shields and chest perks (each with its switch off too), the same seed gives the same game, the
   autopilot plays every map, a game saved mid-wave and loaded plays on exactly
   like the original, snapshots and inputs survive encoding, and the screens
   draw. The online menu flow lives in `main.js` (DOM), so check it by hand
   (step 6). Add a
   test next to similar ones when you change a rule; a new map is covered
   automatically.
2. **Run it**: `python3 serve.py`, play a few waves (solo is quickest: press 1).
   Check the browser console for errors.
3. **Balance sanity**: open `/tools/balance-test.html`, choose map and players,
   run several games. The bot never uses bombs and plays crudely, so its
   results are a *lower bound* on what real players manage. From the console:
   `(await import('/tools/bot.js')).runBot({ players: 2, seed: 1, map: 0 })`
   returns `{ won, wave, lives, log }`.
4. **Art**: `/tools/gallery.html` (add `?zoom=5`).
5. **Real playtest logs**: players press **L** to download the last 20 games
   as JSON (per wave: monsters, cottage damage by type and by road, coins
   earned/spent per cat, time spent per activity, damage and kills per flower
   type, garden snapshot; plus a timeline of plants, level-ups, heals, digs,
   bombs, leaks and cat positions, and a per-flower record with tile, levels
   and own damage). The format is documented at the top of `src/stats.js`.
   This is the main source for balance decisions; online, only the host has
   it. `runBot()` returns the same log as `game`.
6. **Online**: open two browser windows; host with 3, join with 4 using the
   room code. Test with the same build in both. When touching the menu or
   saves, also check: pause → M takes both to the menu still connected, 3
   there starts a new game for both, and an online save loaded by the host
   brings the guest back in.

Useful console checks (modules can be imported directly):

```js
const d = await import('/src/data.js');
d.flowerStats('daisy', 5);   // a flower's numbers at a level
d.plantCost('thorn'); d.upgradeCost('thorn', 4);
```

## Features being playtested (IDEAS R1–R3)

Three mechanics are on trial. Each has an `enabled` switch in `balance.json`,
lives in its own clearly marked code, has its own tests and its own part of
the game log, so any of them can be switched off, or removed, on its own.

| Feature | Switch | Where the code is | Log |
|---|---|---|---|
| R1 Bloom abilities (level 5) | `bloom.enabled` | `data.js` (`BLOOM`, `bloomOf`, the price bump in `upgradeCost`); `sim.js`: every `bl`/`burst` in `updateFlowers`, `splitSeed`, burning and `vulnT` in `updateEnemies`/`damage`/`updateClouds`; `render.js`: sparkles in `drawFlower`, flames and the purple ring in `drawEnemy`, `bloomText` in the guide; `schema.js` `burnT`, `vulnT` | `bloom` per wave and in totals |
| R2 Elites and power-ups | `elites.enabled` | `data.js` (`ELITES`, `ELITE_TRAITS`, `ITEM_KINDS`); `sim.js`: the "Elite monsters and power-ups" section (`maybeElite`, `makeElite`, `frostproof`, `dropItem`, `updateItems`, `useItem`), plus `armorPlus` in `damage`, `speedMul`/regeneration in `updateEnemies`, splitting and drops in `killEnemy`, `wet`/`sunT` in `updateFlowers`, `inp.use`; `render.js`: `ELITE_COLOR`, `drawItemIcon`, `drawItem`, the HUD slot, the menu column; the `use` key in `main.js`, `host.js` `TAPS`, `schema.js` (`use` flag, `item`, `elite`, `mini`, `sunT`, `items`); `save.js` `items` default; sounds `pickup`, `powerup`, `freeze`, `elite` | `elites`, `items` per wave and in totals; `elite` and `item` on the timeline |
| R3 Boss shields | `bossShield.enabled` | `data.js` `SHIELD`; `sim.js`: "Boss shields" section (`raiseShield`, `bombShield`), `shieldAt` in `spawnEnemy`, the shield/exposed lines in `damage`, `exposedT` in `updateEnemies`, the call in `explode`; `render.js` `drawShield`; `schema.js` `shield`, `shieldMax`, `exposedT`; sounds `shieldUp`, `shieldHit`, `shieldBreak` | `shields` per wave and in totals; `shield` on the timeline |
| R3 Boss chests | `bossChest.enabled` | `data.js` `CHEST`, `PERKS`; `sim.js`: "Boss chests" section (`rollOffers`, `openChest`, `updateChest`, `applyPerk`), `chestDue` in `killEnemy`/`updateWaves`/`continueEndless`, the `s.chest` early return in `step`, perks in `catStats` and `teamPerk` (wear, aphids), `bombMax`; `render.js` `drawChest`, the bomb count in the HUD; `schema.js` `chest`, `perks`; `guest.js` (no prediction while a chest is open); `tools/bot.js` takes the first perk; sound `chest` | `perks` per wave (`[player, perk]`) and in totals; `perk` on the timeline |

To remove one for good: set its switch to false and play, then delete the
code listed (and its tests, `_help` entry and log fields), and bump
`PROTOCOL` if a snapshot field went.

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
- **Keep the sim pure**: no DOM, canvas, audio or `Math.random()` in `sim.js`. Keep the state plain data (objects, arrays, Maps, Sets, numbers, strings) so saved games work; a new kind of shared game data the state points at needs a name in `save.js` (`constants`).
- **Numbers belong in JSON**, not in code, whenever someone might want to tune
  them; document new fields in the JSON `_help` section.
- **Commits**: one meaningful change per commit, imperative summary line
  (e.g. "Coin drops fade 5% per wave; weaker Thornrose").
- **Docs**: when controls or features change, update `README.md` (players),
  the menu text in `render.js` and this file (developers).
- **Browser support**: current desktop Chrome, Firefox and Safari; keyboard
  only (no touch controls).
