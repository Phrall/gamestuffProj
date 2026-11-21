// Seeded RNG (mulberry32) so a battle replays exactly from its seed. Only hit/miss uses it.
export function nextRandom(state: { rngState: number }): number {
  let t = (state.rngState = (state.rngState + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** A standalone seeded generator (for flavour such as barks, kept apart from combat rolls). */
export function mulberry32(seed: number): () => number {
  const st = { rngState: seed | 0 };
  return () => nextRandom(st);
}
