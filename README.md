# Petal Patrol

A co-op tower defense game in the browser: two cats defend their cottage by
planting flower creatures, bonking monsters with batons and throwing bombs.
Plain HTML + JavaScript, no build step.

## Running it

```bash
python3 serve.py
```

Then open http://localhost:8765. (`serve.py` is Python's built-in file server
with caching turned off, so edits show up on a normal reload.)

## Hosting on GitHub Pages

The game is just static files, so GitHub Pages can serve it as is:

1. Push this folder to a GitHub repository (public, for free Pages).
2. In the repository: **Settings → Pages → Build and deployment**, choose
   **Deploy from a branch**, branch `main`, folder `/ (root)`.
3. After a minute the game is at `https://<user>.github.io/<repo>/`.

Every push to `main` redeploys. Online co-op works from there too: the host
presses **3** and sends the **Copy invite link** link; players are connected
through PeerJS's free public server, so no server of your own is needed.
GitHub caches files for up to 10 minutes, so after an update both players
should reload. `.nojekyll` tells Pages to serve the files without processing
them.

## Playing

- **1** solo · **2** local co-op (one keyboard) · **3** host online · **4** join online
- Before each game, pick a map, a cat and 3 of the 7 flowers. Two players can't
  pick the same cat: Brick (slow, big hits), Zip (fast, light hits), Fern
  (grows and heals faster) or Boom (faster, bigger bombs).
- Standing on a flower, hold E to upgrade it and R to heal it. Q switches E to
  dig-up mode, which removes the flower and refunds part of what was spent on it.
- At level 5 every flower **blooms**: it sparkles and gains a special ability
  (Daisy seeds split, Fire Lily sets monsters alight, Frostbloom freezes…).
  The flower guide (I) says what each one does.
- From wave 4 some big monsters arrive as **elites**: they glow, are much
  tougher and have a trait (armoured, swift, regenerating, frost-proof or
  splitting). Each one drops a surprise power-up; walk over it to carry it
  (one per cat, shown in your HUD panel) and press V (P2: `;`) to use it:
  fertiliser (free level for the flower you stand on), watering can (nearby
  flowers heal and stop wearing for the wave), sun orb (the flower you stand
  on fires twice as fast for 20 s) or snow globe (every monster but bosses
  freezes for 2 s). Unclaimed power-ups vanish after 10 s.
- **Bosses raise a shield** at 60% health (the last boss and endless bosses at
  70% and 35%). It blocks 90% of all damage except bombs: 5 bomb hits break it
  in co-op, 3 alone, and Boom's bombs count double. A broken shield leaves the
  boss stunned and taking 50% more damage for 3 s.
- A wave in which a boss died ends with a **boss chest**: each cat picks one
  of 3 perks for the rest of the run (cottage repair, slower wear, softer
  aphids, an extra flower type, cheaper flowers, faster growing, a bigger bomb
  pouch). Left/right to choose, plant or baton key to take it. Each perk can
  be taken twice.
- In co-op, each cat keeps the coins it picks up (`economy.coopCoinShare` in
  `balance.json` can split a share of every pickup with the other cat).
- P1: WASD move · Shift sprint · F baton · G bomb · V use power-up · E plant/upgrade (hold) · R heal (hold) · Q next flower / dig-up mode
- P2 (local): arrows · Right Shift sprint · `,` baton · `.` bomb · `;` use power-up · `/` plant/upgrade · `'` heal · M next flower
- P or Esc pauses (either player, online too). From the pause screen R restarts the same map with the same cats and flowers, M goes back to the menu, and S saves the game as a file.
- **O** on the main menu loads a saved game (solo, local co-op or online) and carries on from the moment it was saved, paused. Online, the host saves and loads; a loaded online game starts once P2 joins.
- Beat all 10 waves and press C on the victory screen to keep going in **endless mode**: wave after wave, each tougher than the last. Wave 11, right after the big boss, is a smaller one to catch your breath; after that the monsters come in about the same numbers but get much tougher, and every 5 waves brings one more boss (wave 15 has two, waves 16–19 one each, wave 20 three…). Lose an endless wave and R retries it from the break before it (same garden, same coins); Esc goes back to the menu.
- I (in the menu or while picking) opens the flower guide: every flower's stats at each level, worked out from `balance.json`.
- L downloads the game logs (see below).
- J turns the extra effects (damage numbers, confetti, hit-stop…) on and off.
- Online, both players use the P1 keys on their own keyboard. Your friend needs
  the game too: easiest is hosting it on GitHub Pages (see above) and sending
  them the invite link.
- Online, going back to the menu (from the pause, victory or defeat screen)
  takes both players there and keeps you connected: either of you presses
  **3** or **Enter** to play again together, **Esc** leaves.

## Tuning

| File | What's in it |
|---|---|
| `balance.json` | Every flower, enemy, level, economy and difficulty number, in tiles and seconds. The `_help` section explains each field. |
| `maps.json` | Map layouts: roads, base, obstacles, plus per-map `waveSize` and `startCoins`. |
| `tools/gallery.html` | Every flower at every level and every cat, drawn with the game's own code (http://localhost:8765/tools/gallery.html). |
| `tools/maps.html` | Every map drawn whole, to check a layout after editing `maps.json` (http://localhost:8765/tools/maps.html). |
| `tools/balance-test.html` | Open http://localhost:8765/tools/balance-test.html to run an autopilot through whole games with the current numbers. |

The autopilot plays co-op the way real players do (measured from game logs:
Boom guards and bombs, Fern gardens, compact gardens near the cottage, most
coins into upgrades). Checked against real games on the same balance, it
usually ends within a wave or two of the players, slightly behind, so treat
its results as a slightly pessimistic estimate.

## Game logs

When a game ends, the victory or defeat screen shows the highlights: damage
and kills for each flower type, the star flower, what each cat earned and
spent, its baton and bomb damage, and which monsters bit the cottage most.
Online, both players see it.

Every game keeps a log for balancing: per wave how long it took, which
monsters came and died, cottage damage by monster type, each cat's coins
(start, earned, spent on planting/upgrades/healing, end), damage and kills by
each flower type, baton and bomb, flowers planted, upgraded, wilted (wear or
aphids) and dug up, cottage damage per road, how long each cat spent
building, healing, fighting or walking, and the garden at the end of the wave.
It also keeps a timeline (every planting and level-up with its tile, who did
it and when, heals, digs, bombs, leaks, and each cat's position every 2
seconds) and a record of every flower with its own damage and kills, so
placement and play style can be studied. The last 20 games
are kept in the browser; press **L** (in a game, on the end screen or in the
menu) to download them as one JSON file. Online, the host's browser has the
log. The code is in `src/stats.js`.

## Code

Developer guide (architecture, testing, deploying, conventions): [AGENTS.md](AGENTS.md).

| File | Role |
|---|---|
| `src/sim.js` | Game rules; no drawing, so it can run on the host for online play |
| `src/render.js` | Draws everything on a canvas (all art is procedural) |
| `src/fx.js` | Particles and other visual effects the sim asks for |
| `src/audio.js` | Procedural sound effects and music |
| `src/main.js` | Input, game loop, menus, online lobby |
| `src/net.js` | Online connection (PeerJS/WebRTC): a reliable lane and a fast, lossy one |
| `src/schema.js` | What a snapshot and guest input contain, and their binary encoding |
| `src/host.js`, `src/guest.js` | Each side of an online game (host-authoritative) |
| `src/snapshot.js` | The guest's view: snapshots blended on the host's clock |
| `src/predict.js` | The guest's own cat, moved at once and checked against the host |
| `src/data.js` | Loads the JSON files and converts them to game units |
| `src/save.js` | Saved games: the whole game as a JSON file |
| `src/util.js` | Small shared helpers (seeded random numbers, clamp, prune) |
