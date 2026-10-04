# Petal Patrol: idea backlog

Ideas for where the game could go next, for picking from. IDs stay stable so
you can refer to them ("let's do C1 and F2").

**Effort:** S = an hour or two · M = a focused session · L = several sessions
or a rework of something core.
**Adds:** 🎯 difficulty / depth · 🎉 fun / feel · 🎨 identity (less of a Cats Go clone).

## Already done

| ID | Idea | Commit |
|---|---|---|
| B7 | Dig up flowers for a partial refund (Q cycles upgrade → heal → dig up) | `f9757f8` |
| H2 | Music that reacts to the game (drums in waves, tense layer when the cottage is chomped or a boss is alive) | `9ffd679` |
| A5 | Cat classes (Brick, Zip, Fern, Boom; no duplicates) plus a sprint key for everyone | see git log |
| H1 | Juice: damage numbers, squash, death pops, confetti, coin bounce, hit-stop. J toggles it; `balance.json → juice` switches single effects | `4783b4c` |
| n/a | Cats collide with trees, rocks and ponds | `4c985cf` |
| n/a | Walkable cottage yard where nothing can be planted | `2c11ddb` |

---

## What other tower defense games do well

| Game | Signature mechanics | What we could borrow |
|---|---|---|
| Kingdom Rush | Hero units, soldiers that block the road, call waves early for gold, upgrades that branch into specialisations, 3-star ratings, Heroic/Iron challenges | Early calls, branching upgrades, challenge modes |
| Bloons TD 6 | 3 upgrade paths per tower, enemy traits that need specific counters (camo, lead, regrow), targeting priority, bosses that split | Enemy traits, targeting modes, upgrade paths |
| Plants vs Zombies | Economy plants, one-shot consumable plants, zombies that eat plants, conveyor-belt levels | Economy flower, consumables, special level rules |
| Orcs Must Die / Dungeon Defenders | Hero fights inside the defence, traps on the path, combo kills, hero classes | Traps, cat classes, combos |
| Defense Grid / Sanctum / Warcraft 3 maze maps | Towers block the route, so players build the maze | Hedges that reroute enemies |
| Rogue Tower / Isle of Arrows | Pick 1 of 3 cards each wave, the path grows, random runs | Card draft between waves |
| Thronefall | Build by day, fight at night, opt-in mutators for a bigger score | Day/night cycle, opt-in difficulty |
| Gemcraft | Combine towers into hybrids, deliberately make waves stronger for more reward | Crossbreeding, betting on waves |
| Dome Keeper | Mine for resources between waves | Something to do between waves |
| Legion TD / Bloons Battles | Creatures you buy get sent to your opponent | Versus mode |

---

## S. Reskins (moving away from Cats Go)

All the art is generated in `src/render.js` and the rules engine is separate,
so a reskin is mostly drawing work. Each one comes with a **signature
mechanic** so the theme changes how the game plays, not only how it looks.

- **S1. Hive Keepers.** Bees defend the queen's hive. Towers stay flowers, and the currency is nectar. *Mechanic:* carry pollen between flowers to crossbreed them (B6). Cheapest option, because the flower art stays. 🎨 · M
- **S2. Lantern Folk.** Foxes with lanterns defend a village from shadow creatures. *Mechanic:* light. Enemies are invisible or stronger outside lit areas, towers need light to see, and the fox's lantern is a moving light source. 🎨🎯 · M–L
- **S3. Tide Pool.** Otters defend a pearl with coral and anemone towers. *Mechanic:* the tide rises and falls, changing which tiles you can build on and which routes are open. 🎨🎯 · L
- **S4. Kitchen Chaos.** Mouse chefs defend a cake with gadget towers. *Mechanic:* enemies drop ingredients that you cook at the stove into buffs. 🎨🎉 · L
- **S5. Spirit Grove.** Forest spirits grow mushroom towers. *Mechanic:* a mycelium network. You can only build on spreading fungus, and connected towers share buffs. 🎨🎯 · M–L
- **S6. Raccoon Junkyard.** Towers are built from scrap parts you carry, and different combinations make different towers. 🎨 · L
- **S7. Haunted Patch.** Dead towers return briefly as ghost towers, and enemies can rise again. 🎨 · M

---

## A. The cat

- **A1. Revive a downed partner.** Hold a button next to a downed partner to revive them. **Needs A2 first**: right now cats can't take damage and are only knocked down by bombs for 1.8 s. 🎯🎉 · S (on top of A2)
- **A2. Cat health and enemies that attack cats.** Some enemies leave the road to swipe at nearby cats. A downed cat either waits for a revive (A1) or gets back up after a few seconds. 🎯 · M
- **A3. Dash or roll** on a cooldown. Sprint covers most of this now. 🎉 · S
- **A4. Choose a tool** with the loadout: baton, slingshot (ranged and weak) or net (slows small enemies). 🎉🎯 · M
- ~~A5. Cat classes~~ (done, with sprint)
- **A6. Cat levels within a run:** gain experience from kills and pick a small perk at each level. 🎉 · M
- **A7. Carry things:** move a seedling, or carry loot. 🎉 · M
- **A8. Co-op combos:** a bomb followed by a baton swing launches enemies, and two cats hitting the same enemy within 0.5 s gives a crit. 🎉 · S–M
- **A9. Ping key** to mark a spot for your partner, shown on the map and minimap. 🎉 · S

## B. Flowers

- **B1. Branching upgrades at level 3:** each flower chooses one of two specialisations, with a different look. 🎯🎉 · M–L
- **B2. Targeting modes per flower:** first, last, strongest, closest. Now that Q already cycles modes on a flower, this would need its own key or a fourth mode. 🎯 · S
- **B3. Economy flower:** makes coins over time but doesn't attack. 🎯 · S
- **B4. Support flower:** buffs the speed or range of neighbouring flowers, or slows their wear. 🎯 · S
- **B5. Adjacency synergies,** for example frost next to fire makes steam damage. 🎯🎉 · M
- **B6. Crossbreeding:** merge two max-level flowers into a hybrid. 🎉 · L
- ~~B7. Uproot and sell~~ (done)
- **B8. One-shot plants:** a mine flower, or a bramble that blocks the road for 5 s. 🎉 · M
- **B9. Traps on the road:** sap, spikes, puddles. 🎯🎉 · M
- **B10. Hedges that reroute enemies,** so players build a maze. This means rewriting how enemies find their way. 🎯 · L
- **B11. Watering:** flowers dry out and you carry water to them from a pond. 🎯 · M
- **B12. More flowers:** a vine that pulls flyers down, a mirror orchid that reflects projectiles, a pitcher plant that stores kills as coins, a dandelion that seeds temporary mini-flowers. 🎉 · S–M each

## C. Enemies

- **C1. Enemy traits that need specific counters:** camouflage only some flowers can reveal, armour only fire melts, regeneration that poison stops. 🎯 · M
- **C2. Elite affixes:** random modifiers such as fast, shielded, vampiric or explodes-on-death, shown with a glowing outline. 🎯🎉 · M
- **C3. Ranged attackers** that shoot flowers from outside their range. 🎯 · M
- **C4. Thieves** that steal coins on the ground and run off with them. 🎯🎉 · S–M
- **C5. Carrier:** a big enemy that drops a group of small ones when hit or killed. 🎯 · S
- **C6. Shield bearer:** blocks projectiles from the front. 🎯 · M
- **C7. Necromancer:** revives recently killed enemies nearby. 🎯 · S
- **C8. Flower-freezer:** an aura that disables flowers. 🎯 · S
- **C9. Multi-phase bosses** with an on-screen health bar. 🎯🎉 · M
- **C10. Seedling snatchers:** flyers that carry a seedling away. 🎯🎉 · M

## D. Maps and environment

- **D1. Day and night cycle.** 🎯🎨 · M
- **D2. Weather:** rain, wind, fog, heat wave. 🎯🎉 · M
- **D3. Switchable gates:** a lever changes which road a branch uses. 🎯🎉 · M
- **D4. Clearable obstacles:** pay coins, or bonk a rock, to open a build spot. This fits nicely now that rocks block movement. 🎉 · S
- **D5. High ground:** hills give flowers extra range. 🎯 · S
- **D6. A second thing to defend** that gives a bonus while it survives. 🎯 · M
- **D7. Escort** a slow cart along a route. 🎯🎉 · L
- **D8. Environmental hazards:** lightning, falling trees, floods. 🎉 · M
- **D9. Usable map objects:** kick a beehive, roll a boulder. 🎉 · S–M
- **D10. Procedural maps.** 🎉 · L
- **D11. More hand-made maps.** 🎉 · S–M each

## E. Economy

- **E1. Call the next wave early for bonus coins.** Enter already starts the wave; this would add the reward. 🎯🎉 · S
- **E2. Interest on unspent coins** each wave, up to a cap. 🎯 · S
- **E3. Coins expire** if not collected within about 10 s. 🎯 · S
- **E4. Gift coins** to your partner. 🎉 · S
- **E5. Second currency** (gems from bosses and elites) for special upgrades. 🎯 · M
- **E6. Kill-streak coin multiplier.** 🎉 · S
- **E7. Cottage repair:** it regenerates slowly, or you pay to fix it between waves. 🎯 · S

## F. Run structure and progression

- **F1. Wave preview:** the next wave's enemy icons and which entrance they come from. 🎯 · S
- **F2. Perk draft:** every few waves, each player picks 1 of 3 cards. 🎉🎯 · M
- **F3. Opt-in mutators** for a higher score. 🎯 · S–M
- **F4. Endless mode and high scores.** 🎉 · S
- **F5. Campaign** with maps unlocking in order and 1–3 stars per map. 🎉 · M
- **F6. Unlocks between runs:** flowers, cat hats. 🎉 · M
- **F7. Daily seed challenge.** 🎉 · S–M
- **F8. End-of-game stats:** MVP flower and MVP cat. 🎉 · S
- **F9. Difficulty select:** easy, normal and hard. 🎯 · S

## G. Co-op and multiplayer

- **G1. Asymmetric roles:** a gardener and a guardian. 🎉 · M
- **G2. Versus mode:** send enemies to your opponent's garden. 🎉 · L
- **G3. 3–4 players online.** 🎉 · M
- **G4. Gamepad support** for couch co-op. 🎉 · S–M

## H. Feel and polish

- ~~H1. Juice~~ (done)
- ~~H2. Dynamic music~~ (done)
- **H3. Tutorial or first-wave hints.** 🎉 · S
- **H4. Settings screen:** volume, key rebinding, screen shake, colour-blind palette. 🎉 · S–M
- **H5. Touch and mobile controls.** 🎉 · M
- **H6. Tree collider size.** Two trees side by side leave a gap only just wide enough for a cat. If that feels fiddly, shrink the colliders. 🎉 · S

---

## Suggestions (updated)

Since the dig-up, juice, music, collisions and yard are done, this is where I'd go next:

1. **Quick wins (about one session):** F1 wave preview, E1 rewarded early calls, F8 end-of-game stats, G4 gamepad support, F9 difficulty select. These are cheap, and each one is noticeable on the first play.
2. **The cat matters more:** A2 enemies that attack cats, then A1 revive. The chomping change already pulls you back to the cottage, and A2 makes that run dangerous. Together they are the biggest boost to co-op tension.
3. **Deeper flower choices:** C1 enemy traits and C2 elite affixes, then B1 branching upgrades. Right now any loadout works against any wave; C1 makes the 4-of-7 pick a real decision.
4. **Replayability:** F2 perk draft between waves, with F3 mutators. This is the step that turns 3 maps × 15 waves into something people come back to.
5. **Its own identity:** one reskin with its mechanic, ideally S2 Lantern Folk with D1 day/night, or S5 Spirit Grove. This is the largest piece of work, so it's best done once the rules above have settled, to avoid redrawing things twice.
