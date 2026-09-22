/** Small deterministic PRNG + value noise for procedural render textures and layouts (pure). */

/** mulberry32: fast deterministic PRNG, returns a function giving floats in [0,1). */
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

/** Integer lattice hash → [0,1). */
export function hash2(ix: number, iy: number, seed = 0): number {
  let h = Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263) + Math.imul(seed | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/** 2D value noise in [0,1]. `period` (lattice cells) makes it tile. */
export function valueNoise2(x: number, y: number, seed = 0, period = 0): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = fade(x - x0);
  const fy = fade(y - y0);
  let ax = x0, bx = x0 + 1, ay = y0, by = y0 + 1;
  if (period > 0) {
    ax = ((ax % period) + period) % period;
    bx = ((bx % period) + period) % period;
    ay = ((ay % period) + period) % period;
    by = ((by % period) + period) % period;
  }
  const a = hash2(ax, ay, seed);
  const b = hash2(bx, ay, seed);
  const c = hash2(ax, by, seed);
  const d = hash2(bx, by, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** Fractal sum of value noise, normalised to [0,1]. Tiles when `period` > 0 (period in cells of octave 0). */
export function fbm2(x: number, y: number, octaves = 4, seed = 0, period = 0, lacunarity = 2, gain = 0.5): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2(x * f, y * f, seed + i * 17, period > 0 ? period * f : 0);
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / norm;
}
