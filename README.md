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

## Playing

- **1** solo · **2** local co-op (one keyboard) · **3** host online · **4** join online
- Before each game, pick a map and 4 of the 7 flowers.
- Standing on a flower, Q cycles upgrade → heal → dig up. Holding E in dig-up
  mode removes the flower and refunds part of what was spent on it.
- P1: WASD move · F baton · G bomb · E plant/grow (hold) · Q next flower / heal / dig-up mode
- P2 (local): arrows · `,` baton · `.` bomb · `/` plant/grow · M next flower
- J turns the extra effects (damage numbers, confetti, hit-stop…) on and off.
- Online, both players use the P1 keys on their own keyboard. Your friend needs
  the game files too (or host the folder somewhere like GitHub Pages).

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
| `src/audio.js` | Procedural sound effects and music |
| `src/main.js` | Input, game loop, menus, online lobby |
| `src/net.js`, `src/snapshot.js` | Online co-op (PeerJS/WebRTC, host-authoritative) |
| `src/data.js` | Loads the JSON files and converts them to game units |
