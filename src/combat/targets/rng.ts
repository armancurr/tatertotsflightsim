/** Deterministic randomness for the target range (no Math.random anywhere: same range every load). */

/** mulberry32: a small, fast, well-mixed 32-bit PRNG → [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash of up to four integers → [0, 1). */
export function hash01(a: number, b = 0, c = 0, d = 0): number {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13) ^ (b | 0), 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16) ^ (c | 0), 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 15) ^ (d | 0), 0x165667b1);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Hash of a float (quantised to 1 mm) — for "random" choices keyed by a place or a time. */
export function hashFloat(v: number, salt = 0): number {
  const q = Number.isFinite(v) ? Math.round(v * 1000) : 0;
  return hash01(q | 0, Math.floor(q / 4294967296), salt);
}
