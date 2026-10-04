// Small helpers shared by several modules.

// Remove the items `gone` picks out, in place. The game loop thins its lists
// every tick and frame; doing it in place saves a new array each time.
export function prune(list, gone) {
  let n = 0;
  for (let i = 0; i < list.length; i++) if (!gone(list[i])) list[n++] = list[i];
  list.length = n;
  return list;
}

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Seeded random numbers (mulberry32). The whole generator state is one 32-bit
// integer, so the game can keep it in its state (s.rng) and stay repeatable.
export const nextSeed = (a) => (a + 0x6d2b79f5) | 0;
export function randomFrom(a) {
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
// A stand-alone generator, for things painted or placed once from a seed.
export function seededRandom(seed) {
  return () => randomFrom(seed = nextSeed(seed));
}
