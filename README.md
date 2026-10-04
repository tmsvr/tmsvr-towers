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
- Before each game, pick a map, a cat and 4 of the 7 flowers. Two players can't
  pick the same cat: Brick (slow, big hits), Zip (fast, light hits), Fern
  (grows and heals faster) or Boom (faster, bigger bombs).
- Standing on a flower, Q cycles upgrade → heal → dig up. Holding E in dig-up
  mode removes the flower and refunds part of what was spent on it.
- P1: WASD move · Shift sprint · F baton · G bomb · E plant/grow (hold) · Q next flower / heal / dig-up mode
- P2 (local): arrows · Right Shift sprint · `,` baton · `.` bomb · `/` plant/grow · M next flower
- J turns the extra effects (damage numbers, confetti, hit-stop…) on and off.
- Online, both players use the P1 keys on their own keyboard. Your friend needs
  the game too: easiest is hosting it on GitHub Pages (see above) and sending
  them the invite link.

## Tuning

| File | What's in it |
|---|---|
| `balance.json` | Every flower, enemy, level, economy and difficulty number, in tiles and seconds. The `_help` section explains each field. |
| `maps.json` | Map layouts: roads, base, obstacles, plus per-map `waveSize` and `startCoins`. |
| `tools/balance-test.html` | Open http://localhost:8765/tools/balance-test.html to run an autopilot through whole games with the current numbers. |

The autopilot never uses bombs and picks flowers crudely, so treat its
results as a lower bound on what real players can survive.

## Code

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
| `src/util.js` | Small shared helpers (seeded random numbers, clamp, prune) |
