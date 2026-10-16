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
  jsDelivr in `index.html`, pinned by an `integrity` hash: a new PeerJS
  version needs a new hash), using PeerJS's free public broker. The only
  server of our own is optional: a Cloudflare Worker (`turn/`) that hands out
  TURN relay credentials for players behind strict firewalls.
- **No third-party requests besides those.** The Fredoka font is served from
  `fonts/`, not Google Fonts, so visitors' browsers don't contact Google.
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
| `fonts/` | The Fredoka font (Latin letters, every weight in one file), its CSS and license |
| `balance.json` | Every gameplay number, in tiles and seconds. `_help` explains the fields |
| `maps.json` | Maps: roads (waypoints), cottage, start, obstacles, `waveSize`, `startCoins`, `waveSet`, scatter. `_help` explains the fields |
| `src/data.js` | Loads both JSON files (top-level `await fetch`), converts to pixel units, derives flower stats per level, prepares maps (decks, bridges, colliders), computes `DATA_HASH` |
| `src/sim.js` | **The game rules.** Pure state + `step(state, inputs, dt)`. No DOM, no drawing |
| `src/stats.js` | Game log hooks the sim calls (damage, coins, waves…). Counting only, never affects play. `gameSummary` makes the end screen's numbers (the host sends them to the guest as a `summary` message) |
| `src/render.js` | Draws everything: world, flowers, cats, enemies, HUD, menu, pick screen, flower guide |
| `src/fx.js`, `src/juice.js` | Visual-only effects (particles, damage numbers, squash, hit-stop) |
| `src/audio.js` | Procedural sound effects and adaptive music |
| `src/main.js` | Entry point: keyboard input, fixed-step game loop, menus, camera, lobby, game logs (L key), canvas sizing |
| `src/net.js` | PeerJS wrapper: a host's room (`openRoom`: any number of links, and linking to another room) and a guest's connection (`joinGame`), each link with a reliable channel and a fast, unreliable one. Fetches TURN servers from `ICE_URL` first, falling back to PeerJS's own |
| `src/versus.js` | Versus races: what one team tells the other (`raceStatus`) and who wins (`raceResult`) |
| `src/schema.js` | Binary encoding of snapshots and guest inputs; defines `PROTOCOL` |
| `src/host.js` / `src/guest.js` | Each side of an online game (host-authoritative) |
| `src/snapshot.js` | Host builds snapshots; guest interpolates between them |
| `src/predict.js` | Guest-side prediction of its own cat, reconciled with the host |
| `src/challenge.js` | Challenge codes (seed + map + mode in six letters), the daily challenge, and the result text players copy with X |
| `src/save.js` | Saved games (S on the pause screen, O on the menu): the whole state as JSON, keeping shared references (`$id`/`$ref`) and naming shared data (monster types, maps) |
| `src/util.js` | Seeded RNG, `clamp`, small helpers |
| `src/version.js` | `BUILD`, the build number shown in the bottom-right corner of the menu and pause screen (the commit count) |
| `tools/bot.js` | Autopilot that plays whole games through the real sim, copying real co-op habits (`HABITS` at the top) |
| `tools/balance-test.html` | UI for running the autopilot over many seeds and maps |
| `tools/gallery.html` | Every flower at every level, every cat (standing and swinging) and every monster, drawn with the real render code. `?zoom=5` for close-ups |
| `tools/screens.html` | Every screen (menu, guide, pick, game, chest, pause, end screens, overlays) drawn with the real render code on realistic games, including a long endless run with huge numbers, so text that doesn't fit shows at a glance. `?only=pause` filters by name |
| `tools/tests.html`, `tools/tests.js` | The test suite: prices, maps, monsters, endless mode, whole autopilot games, saved games, online encoding, drawing. Runs in the browser |
| `tools/fakepeer.js` | A stand-in for PeerJS over `BroadcastChannel`: open the game with `?fakenet` in several tabs of one browser to test online play without the internet (`&tick` too if background tabs freeze) |
| `tools/maps.html` | Every map from `maps.json` drawn whole with the real render code (roads, ponds, bridges, scatter, cottage, entrances) |
| `turn/` | Cloudflare Worker that makes TURN relay credentials, and how to deploy it (`turn/README.md`) |
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
- **The waves have their own RNG** (`wrnd(s)`, state `s.wrng`, started from
  `s.seed`). Everything that makes up a wave (`buildQueue`, `arrivals`,
  `pickBoss`, and the elites, rolled into the queue entries) uses it and
  nothing else does, so a seed, map and mode always bring the same monsters
  however the game is played. That is what makes challenge codes fair: keep
  `rnd(s)` out of wave make-up, and `wrnd(s)` out of everything else.
- **Sim/render split.** `sim.js` must stay free of DOM and canvas so it can run
  on the online host and in `tools/bot.js`. It communicates outward through
  events on the state (`ev(s, 'chomp')`, banners, fx requests).
- **Units.** JSON is in tiles and seconds; `data.js` converts to pixels (`T` =
  56 px per tile, `U` scales art). Positions in the sim are pixels.
- **Screen size follows the window.** Everything is laid out for the base
  size `BASE_W × BASE_H` (1008 × 656: an 18 × 10 tile map view plus a 96 px
  HUD), zoomed so that just fits the window. A window of another shape shows
  more map instead of black bars: `fitCanvas()` in `main.js` sets the live
  `VIEW_W × VIEW_H` (`setView` in `render.js`), never smaller than the base
  and never bigger than the smallest map. The world, HUD (cat cards centred),
  minimap and banners use the live size; the panel screens (menu, pick, chest,
  pause, end, guide) keep the base layout in a centred frame (`inFrame`, with
  `dim()` for their full-screen backdrop). The sim only knows the base size
  (it keeps local co-op cats within one base screen of each other). The
  backing store gets as many real pixels as the canvas is shown at (capped
  at 2×: bigger makes Firefox slow). Check other shapes with
  `/tools/screens.html?size=1500x656`. Online, the top-left label shows ping, frames per second counted on the
  wall clock, the slowest frame of the last second, and game updates received
  (guest) or dropped because the connection is backed up (host); see
  `measureFrame` in `main.js`. Caches (map background,
  sprite heads) are keyed by that scale (`ui.dpr`).
- **Game phases.** Menu → pick screen (`s.phase === 'pick'`: map, mode
  (`MODES` in `sim.js`: Normal, Hard, Sprint, Sprint · Hard, as `s.hard` and
  `s.sprint`, plant key on the map row), cat, 3 flowers per player) → waves →
  won/over overlay. After a win, C carries on into endless mode
  (`continueEndless`): wave 11 is a smaller breather, then waves barely grow
  in number while boss count climbs (`breatherWaveSize`, `endless*` in
  `balance.json → difficulty`).
- **Sprint mode** (`balance.json → sprint`) plays `sprint.waves.length` waves,
  each like the normal wave it names. `levelOf(s)` is that normal wave; every
  rule that grows with the waves (health, size, coin fade, elites, bosses, the
  breather) goes by it, and `lastWave(s)` is the wave that wins. Use these,
  not `s.wave` or `TOTAL_WAVES`, in new rules that scale with the waves.
- **Challenges and scores.** `s.seed`, `s.map`, `s.hard` and `s.sprint` make
  the challenge code (`codeOf` in `challenge.js`). A challenge (K or D on the
  menu, `ui.challenge` in `main.js`) is applied to each new game with
  `setChallenge`, which also sets `s.locked` so the pick screen can't change
  the map or mode. `scoreOf(s)` in `sim.js` is the score; personal bests are
  kept in `localStorage` (`recordBest` in `main.js`).
- **The difficulty curve.** One rule for every wave, endless included: monster
  health is ×(1 + `hpGrowth`) a wave, so there are no jumps and a full garden
  meets a clear wall a few waves after it stops growing. Packs (swarms, wasps)
  grow up to `packMaxGrowth` times their size but pay for every member, so they
  don't flood late waves. Hard mode multiplies health, wave size and
  coin drops (`difficulty.hard`). Judge changes against these, not with exceptions for
  particular waves or monsters.
- **Stop screens.** Pause, defeat and victory share their keys (`keydown` in
  `main.js`, `stopKeys` in `render.js`): R retries the wave (`retryWave`
  rewinds to the checkpoint the sim saves at the start of every break), T
  starts a new game at the pick screen, M goes to the menu, C after a win
  goes endless. Online the guest asks the host (`retry`, `restart`,
  `continue`).
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
- **Versus races** (5 on the menu, `versus.js`, the "versus races" section of
  `main.js`). Each team is an ordinary host game (host plus guests); the two
  hosts link their rooms (`room.connect`), introducing themselves with a
  `hello` whose `role` is `rival`. The room that was linked to is the
  referee: it chooses the map and mode and sends `race` (a challenge with a
  fresh seed), and both sides start it with `s.versus` set. A side that has
  picked holds (`s.hold`) until the rival's status says it has picked too
  (`releaseHold`). Then the hosts swap `status` messages 4 times a second,
  each passes the rival's on to its guests (`versus`), and pausing sends
  `pause` across. The sims never talk to each other, so each side's game
  stays exactly as deterministic as before.
- **Saves online** are made and loaded by the host. A loaded online save
  either resumes at once (partner still connected) or opens a room and
  resumes when P2 joins (`pendingSave`).

## Common changes

| I want to… | Do this |
|---|---|
| Rebalance (damage, costs, HP, waves, economy) | Edit `balance.json`. The flower guide (I key) and pick cards update themselves |
| Change a map, or add one | Edit/add an entry in `maps.json`, then look at it whole in `/tools/maps.html`. Roads are lists of corner points; each segment must be horizontal or vertical; every road ends at `base`. Check reachability (a scatter seed can wall off a tile; change `scatter.seed`) |
| Tune Sprint or the score | `balance.json → sprint` (which waves it plays, breaks, coins) and `→ score`. Check Sprint with `runBot({ sprint: true })` |
| Make a map easier or harder | `waveSize` (monster count; boss HP scales with its square root) and `startCoins` in `maps.json` |
| Add a flower | New entry in `balance.json → flowers` (its `kind` picks the attack code in `sim.js`; a new kind needs new code there), plus its look in `render.js` (`SPEC`, `PERSONA`, `BODIES`). The pick screen, guide and network encoding pick it up automatically; bump `PROTOCOL` |
| Add an enemy | Entry in `balance.json → enemies`, plus an entry in `waves` or a `waveSets` list (`fromWave`, `weight`, `cost`, `group`) so it spawns, an `intros` card, and its drawing in `drawEnemy` (`render.js`; check it in `/tools/gallery.html`). Bump `PROTOCOL` |
| Add a boss | Like an enemy, with `"boss": true`, plus a weight in `balance.json → difficulty.bossTypes` so it gets picked. Everything keyed on `def.boss` (shields, chests, Sunflower's bonus, Snapdragon's smaller bite, banners) picks it up |
| Give a map its own monsters | Add a list to `balance.json → waveSets` and name it with `waveSet` in the map's `maps.json` entry. Maps without one use `waves`. `fromWave: [lo, hi]` makes a type arrive in a random wave in that range (rolled once per game) |
| Add a key | `KEYS` in `main.js` (P1 and P2 layouts); show it in the menu (`drawMenu`) and README. Online inputs are flags in `schema.js` (`INPUT_FLAGS`, bump `PROTOCOL`) |
| Change art | `render.js`, then check `tools/gallery.html` |
| Change a screen or its text | `render.js`, then check `tools/screens.html` (every screen at once, long texts and big numbers included) |
| Log more for balancing | Add a hook in `stats.js` and call it from `sim.js` |

## Testing

Check changes like this:

1. **Tests**: open `/tools/tests.html` (or from the console
   `(await import('/tools/tests.js')).runTests()`). They drive the real
   modules: every price shown matches what each cat pays (planting, upgrades,
   half-paid levels, healing, digging), maps are well formed and every road
   is reachable on foot, monster rules (frost-proof, leaping, enrage, ranged
   arrival waves, Snapdragon bites), endless mode (breather, wave size, bosses),
   the health curve, pack sizes, hard mode, retrying a wave (lost or from the pause screen, early waves and endless), every Bloom ability, elite traits and
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
   run several games. The bot plays co-op like the real logs: Boom guards the
   cottage and bombs crowds (and boss shields), Fern gardens, about 13 cheap
   flowers before wave 1 then ~2 more a wave (more on maps with more road, and
   after the cottage gets hurt), most coins into upgrades, heals at 55%,
   everyone walks, power-ups and chest perks are used. Replayed on the exact
   balance of 19 logged games it ends within a wave or two of the players,
   usually a little behind (they won on Hourglass, it wins 4/4 with less
   cottage left), so read it as a slightly pessimistic estimate. Its habits
   are numbers in `HABITS` (`runBot({ habits })` overrides them; `onTick`
   watches it play). Solo play is less tuned (the logs are all co-op). From
   the console: `(await import('/tools/bot.js')).runBot({ players: 2, seed: 1, map: 0 })`
   returns `{ won, wave, lives, log, game }`.
4. **Art and screens**: `/tools/gallery.html` (add `?zoom=5`) for sprites, and
   `/tools/screens.html` for every screen's layout and text. Big numbers go
   through `num` (9,425 · 91.1k · 1.3M) and times through `clock` in `render.js`.
5. **Real playtest logs**: players press **L** to download the last 20 games
   as JSON (per wave: monsters, cottage damage by type and by road, coins
   earned/spent per cat, time spent per activity, damage and kills per flower
   type, garden snapshot; plus a timeline of plants, level-ups, heals, digs,
   bombs, leaks and cat positions, and a per-flower record with tile, levels
   and own damage). The format is documented at the top of `src/stats.js`.
   This is the main source for balance decisions; online, only the host has
   it. `runBot()` returns the same log as `game`.
6. **Online**: open two browser windows; host with 3, join with 4 using the
   room code. Test with the same build in both. Without the internet (or in a
   browser that can't do WebRTC), add `?fakenet` to every tab's URL: the tabs
   then connect to each other directly (`tools/fakepeer.js`). For versus,
   one tab per team host, each pressing 5, plus a tab per teammate. When touching the menu or
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
| R2 Elites and power-ups | `elites.enabled` | `data.js` (`ELITES`, `ELITE_TRAITS`, `ITEM_KINDS`); `sim.js`: the "Elite monsters and power-ups" section (`maybeElite`, `makeElite`, `frostproof`, `dropItem`, `updateItems`, `useItem`), plus `armorPlus` in `damage`, `speedMul`/regeneration in `updateEnemies`, splitting and drops in `killEnemy`, `wet`/`sunT` in `updateFlowers`, `inp.use`; `render.js`: `ELITE_COLOR`, `drawItemIcon`, `drawItem`, the HUD slot, the menu column; the `use` key in `main.js`, `host.js` `TAPS`, `schema.js` (`use` flag, `item`, `elite`, `mini`, `sunT`, `items`); `save.js` `items` default; `tools/bot.js` `itemJob`, `snowNow`; sounds `pickup`, `powerup`, `freeze`, `elite` | `elites`, `items` per wave and in totals; `elite` and `item` on the timeline |
| R3 Boss shields | `bossShield.enabled` | `data.js` `SHIELD`; `sim.js`: "Boss shields" section (`raiseShield`, `bombShield`), `shieldAt` in `spawnEnemy`, the shield/exposed lines in `damage`, `exposedT` in `updateEnemies`, the call in `explode`; `render.js` `drawShield`; `schema.js` `shield`, `shieldMax`, `exposedT`; `tools/bot.js` bombs shielded bosses first (`bombTarget`); sounds `shieldUp`, `shieldHit`, `shieldBreak` | `shields` per wave and in totals; `shield` on the timeline |
| R3 Boss chests | `bossChest.enabled` | `data.js` `CHEST`, `PERKS`; `sim.js`: "Boss chests" section (`rollOffers`, `openChest`, `updateChest`, `applyPerk`), `chestDue` in `killEnemy`/`updateWaves`/`continueEndless`, the `s.chest` early return in `step`, perks in `catStats` and `teamPerk` (wear, aphids), `bombMax`; `render.js` `drawChest`, the bomb count in the HUD; `schema.js` `chest`, `perks`; `guest.js` (no prediction while a chest is open); `tools/bot.js` `pickPerk`; sound `chest` | `perks` per wave (`[player, perk]`) and in totals; `perk` on the timeline |

To remove one for good: set its switch to false and play, then delete the
code listed (and its tests, `_help` entry and log fields), and bump
`PROTOCOL` if a snapshot field went.

## Deploying

- **Bump `BUILD` in `src/version.js` in every commit you push**, to what
  `git rev-list --count HEAD` will be once that commit is made (today's count
  + 1). The menu shows it, so players can see which version is live.
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
- **Keep Firefox on the GPU**: Firefox switches a canvas to slow software
  drawing for good once it sees many shapes under scales/rotations (or font
  sizes) it hasn't seen before. `main.js` snaps `scale`/`rotate` on the game
  canvas to fine steps, which covers the usual squash and sway. Don't spin
  hundreds of things through `rotate` (draw them as rotated shapes, like the
  confetti) or animate font sizes smoothly (round them). Moving things with
  `translate` is always fine. Check with Firefox when adding lots of animation.
- **Numbers belong in JSON**, not in code, whenever someone might want to tune
  them; document new fields in the JSON `_help` section.
- **Commits**: one meaningful change per commit, imperative summary line
  (e.g. "Coin drops fade 5% per wave; weaker Thornrose").
- **Docs**: when controls or features change, update `README.md` (players),
  the menu text in `render.js` and this file (developers).
- **Browser support**: current desktop Chrome, Firefox and Safari; keyboard
  only (no touch controls).
