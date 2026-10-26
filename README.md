# Petal Patrol

A co-op tower defense game in the browser: up to four cats defend their cottage by
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
presses **3** and sends the **Copy invite link** link to up to 3 friends; players are connected
through PeerJS's free public server, so no server of your own is needed.
GitHub caches files for up to 10 minutes, so after an update every player
should reload. `.nojekyll` tells Pages to serve the files without processing
them.

## Playing

- **1** solo · **2** local co-op (two on one keyboard) · **3** host online (up to 4 cats) · **4** join online · **5** versus race
- Online the host waits in the lobby until everyone is in, then presses **Enter** (or the button) to
  start. With 3 or 4 cats each wave brings more monsters, a little tougher (`balance.json →
  difficulty.morePlayers`), boss shields take more bombs, and each player's HUD shows their own
  cat's card in full and the others small. Someone who drops out can rejoin with the same code
  and gets their cat back.
- Before each game, pick a map, a cat and 3 of the 7 flowers. Two players can't
  pick the same cat: Brick (slow, big hits), Zip (fast, light hits), Fern
  (grows and heals faster) or Boom (faster, bigger bombs). On the map row, E
  switches between **Normal**, **Hard** (more and much tougher monsters,
  and fewer coins: for players whose gardens hold Normal with lots to spare),
  **Sprint** (6 quick waves, see Competing below) and **Sprint · Hard**.
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
- **Three kinds of boss**, and each boss is picked at random: the **Boss**
  (lets out grunts as it walks), the **Mole King** (digs underground where
  nothing can hit it, and shakes the flowers around it each time it comes up)
  and the **Bramble Witch** (heals the monsters around it and withers the
  flowers it walks past). Max-level flowers shrug off the quake and the
  withering. Only the Boss raises a shield; the other two have their own tricks.
- **The Boss raises a shield** at 60% health (the last boss and endless bosses at
  70% and 35%). It blocks 90% of all damage except bombs: 3 bomb hits break it
  (in co-op or alone), and Boom's bombs count double. A broken shield leaves the
  boss stunned and taking 50% more damage for 3 s. Bosses also shrug off half
  of a Frostbloom's slow and can't be frozen solid.
- A wave in which a boss died ends with a **boss chest**: each cat picks one
  of 3 perks for the rest of the run (cottage repair, slower wear, softer
  aphids, an extra flower type, cheaper flowers, faster growing, a bigger bomb
  pouch). Left/right to choose, plant or baton key to take it. Each perk can
  be taken twice: team perks (roof, roots, stems) by the whole team, the
  others by each cat. A second copy stacks: percentages multiply (two Deep
  roots: flowers wear 0.7 × 0.7 = 51% slower), extra bombs and flower types
  add up, and the roof repair is a one-off. Each cat's HUD card shows its
  perks along the bottom (team perks in green), and the pause screen spells
  out what everyone's perks add up to.
- In co-op, each cat keeps the coins it picks up (`economy.coopCoinShare` in
  `balance.json` can split a share of every pickup with the other cat).
- P1: WASD move · Shift sprint · F baton · G bomb · V use power-up · E plant/upgrade (hold) · R heal (hold) · Q next flower / dig-up mode · X send monsters (versus races)
- P2 (local): arrows · Right Shift sprint · `,` baton · `.` bomb · `;` use power-up · `/` plant/upgrade · `'` heal · M next flower
- P or Esc pauses (either player, online too); S on the pause screen saves the game as a file.
- The pause, defeat and victory screens share the same keys:
  - **R** retries the wave from the break before it (same garden, same coins), in any wave
  - **T** starts a new game (the pick screen, with your last map, cats and flowers already chosen)
  - **M** goes back to the menu (Esc too, after the game)
  - **C** on the victory screen keeps going in endless mode
- **O** on the main menu loads a saved game (solo, local co-op or online) and carries on from the moment it was saved, paused. Online, the host saves and loads; a loaded online game starts once all its players are back (or when the host presses Enter).
- Beat all 10 waves and press C on the victory screen to keep going in **endless mode**: wave after wave, each tougher than the last. Every wave's monsters are 20% tougher than the last, endless ones too, so sooner or later even a garden full of level-5 flowers meets a wave it can't hold. Wave 11, right after the big boss, is a smaller one to catch your breath; after that the monsters come in about the same numbers, and every 5 waves brings one more boss (wave 15 has two, wave 20 three, wave 25 four…). From wave 21 the waves in between bring bosses too (one each until wave 25, then two…).
- The game fills the browser window: a wider or taller window shows more of the map (things stay the same size), so there are no black bars.
- I (in the menu or while picking) opens the flower guide: every flower's stats at each level, worked out from `balance.json`.
- L downloads the game logs (see below).
- Online, everyone uses the P1 keys on their own keyboard. Your friends need
  the game too: easiest is hosting it on GitHub Pages (see above) and sending
  them the invite link.
- Online, going back to the menu (from the pause, victory or defeat screen)
  takes everyone there and keeps you connected: anyone presses
  **3** or **Enter** to play again together, **Esc** leaves.
- Online, the top-left label shows the ping, frames per second, the slowest
  frame of the last second and how many game updates arrive each second (for
  the guest; the host sees updates it had to drop). If the game feels laggy
  while it says 60 fps, a low update count means the connection, not the
  computer, is struggling.

## Competing

There is no server, so scores live in your browser and get shared by pasting
them into a chat.

- **Sprint** is the quick mode, about 8 minutes: 6 waves that play like normal
  waves 2, 4, 5, 7, 9 and 10, with bosses in waves 3 and 6, more coins at the
  start, more coins per monster and 12 s breaks.
- **Every game has a challenge code** (top right of the pick screen, and on the
  end screen), like `9KW-CVE`. It stands for the map, the mode and the waves'
  random numbers. Anyone who plays the same code meets exactly the same monsters,
  in the same order on the same roads, elites included, whatever they plant. So
  a code makes a fair contest: everyone plays it, then you compare scores.
- **K** on the menu: type in a code. **D**: today's **daily challenge** (a
  Sprint on a map that changes every day, the same for everyone). The menu
  shows the challenge until you press K to clear it, and every game started in
  the meantime (solo, local or hosted online) uses it. The map and mode are
  locked on the pick screen; cats and flowers are yours to choose.
- **Score** = 1,000 per wave cleared + 20 per point of cottage health left + 5
  per monster of the waves bonked (not the bugs a hive lets out or the blobs a
  splitter breaks into: a hive left alive longer makes more; not monsters sent
  by versus rivals), ×1.5 on Hard (`balance.json → score`). Only compare
  scores of the same mode, map and number of players. The end screen shows
  your best in this browser (per code for challenges, otherwise per map, mode
  and number of players).
- **X** on the victory or defeat screen copies the result for the chat:

  ```
  🌼 Petal Patrol · daily 2026-10-16 · Sprint · Whirlpool · 2 players
  Code 9KW-CVE · won all 6 waves · 6 cleared
  🏠 🟩🟩🟩🟩🟩🟩🟩⬛⬛⬛ 141/200 · 812 bonked
  Score 12,880
  ```

  Retrying a wave (R) is allowed, but the result says how many retries you used.

### Versus races

Two teams race on the same challenge, each in its own garden, each team on
its own computers: same map, same mode, same waves. A team is one to four
players (the host plus up to three teammates who join with 4). In a race each
cat picks 4 flowers instead of 3.

1. Each team's host presses **5**. That opens a versus room with a code.
2. One host types the other host's code into the **Rival team** box and
   presses **Link** (either way round works). The host who was linked to
   chooses the map and mode (Sprint by default) and starts the race.
3. Teammates press **4** and enter their own host's code, before the race
   starts.
4. Everyone picks a cat and 4 flowers (the map is already set); a team that's
   ready waits for the other, then both start at the same moment.

The panel at the top shows the rivals' cats, how they're doing, both scores
and whether they can block. Every wave starts for both teams at the same
moment: a team whose break runs out first waits for the other. The first
break is longer (45 s), so both teams can plant. **Enter in a break starts the
next wave for both teams**, as long as both teams are in a break (not while
the rivals are still fighting): their break ends at once, so calling a wave
early is a way to catch them before they've planted. **The first cottage to fall loses**, and the race ends
there for both teams. If both teams win every wave, the one with more cottage
left wins, then the higher score. Boss chests never offer the cottage repair
in a race. The end screen puts the two teams side by side (waves, cottage,
score, monsters bonked, coins, flower and cat damage, packs sent, rival packs
blocked, packs that got through and the monsters those brought, star flower), the better number in green, next to your own team's cats.

**Sending monsters.** Bonking your wave fills the send meter. **X** spends
part of it on a pack of monsters for the rivals. A pack doesn't land at once:
the rivals get an 8-second warning, and if they send in that time, their pack
cancels yours first and only the rest comes back at you. So sending as much
back only blocks: the trick is timing. Attack when their meter is empty (the
panel says "they can't block"), and keep some of yours to block their big
push.

**Send them monsters.** Bonking your wave fills your team's purple send
meter (a whole wave fills it once over, a boss adds half). When it's past the
first tick, any cat presses **X** to send a pack to the rivals: 15% of the
wave they're playing, made of its kinds of monsters (never bosses). Every pack
is worth the same: a swarm is cut down to what the pack pays for. One that
lands in a break comes with their next wave. Sent monsters have a
purple ring and drop half the coins, and killing them doesn't fill the
meter, so packs can't bounce back and forth. Numbers: `balance.json → send`. Pausing pauses both
teams. A race can't be retried or saved; **Enter** on the end screen asks for
a rematch (new waves, same map and mode), **M** leaves.

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
