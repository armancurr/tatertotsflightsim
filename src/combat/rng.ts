/**
 * Seeded PRNG for the weapons (gun dispersion, round types, smoke): mulberry32 + a Box–Muller
 * Gaussian with the spare value cached. Deterministic for a seed, allocation-free.
 */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Standard normal (mean 0, σ 1). */
  gauss(): number;
  /** Uniform in [-a, a]. */
  sym(a: number): number;
  reseed(seed: number): void;
}

export function createRng(seed = 1): Rng {
  let state = seed >>> 0;
  let spare = 0;
  let hasSpare = false;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    gauss() {
      if (hasSpare) {
        hasSpare = false;
        return spare;
      }
      let u = next();
      while (u <= 1e-12) u = next();
      const v = next();
      const r = Math.sqrt(-2 * Math.log(u));
      spare = r * Math.sin(2 * Math.PI * v);
      hasSpare = true;
      return r * Math.cos(2 * Math.PI * v);
    },
    sym: (a) => (next() * 2 - 1) * a,
    reseed(s) {
      state = s >>> 0;
      hasSpare = false;
    },
  };
}
