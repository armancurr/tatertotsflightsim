/**
 * Seeded, deterministic 2D noise for the procedural world. PURE (no three.js,
 * no DOM) so the physics, the tests and the terrain worker share it.
 *
 * - `createSimplex2D(seed)` — 2D simplex gradient noise in [-1, 1], ~15–25 ns/sample.
 * - `simplex2Deriv` — the same noise with its analytic gradient (for eroded fBm).
 * - `fbm`, `ridged`, `erodedFbm`, `warp` — fractal helpers built on top.
 * - `mulberry32`, `hash2i` — seeded PRNG and integer lattice hash.
 *
 * Every octave loop rotates the domain (≈37°) so no axis-aligned artefacts appear.
 */

/** Seeded 32-bit PRNG (mulberry32). Returns a function producing floats in [0, 1). */
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

/** Stable integer lattice hash → [0, 1). Same inputs always give the same value. */
export function hash2i(ix: number, iy: number, seed = 0): number {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x1b873593);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** A 2D noise function with its permutation table attached (for the derivative variant). */
export interface Noise2D {
  (x: number, y: number): number;
  readonly perm: Uint8Array;
}

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
/** 16 unit gradient directions, evenly spaced. */
const NG = 16;
const GX = new Float64Array(NG);
const GY = new Float64Array(NG);
for (let i = 0; i < NG; i++) {
  const a = (i / NG) * Math.PI * 2 + 0.1963;
  GX[i] = Math.cos(a);
  GY[i] = Math.sin(a);
}
/** Normalises the kernel sum to [-1, 1] (max of Σ t⁴·(g·d) for unit gradients is ≈ 0.01001). */
const SCALE = 99.0;

function buildPerm(seed: number): Uint8Array {
  const rnd = mulberry32(seed ^ 0x9e3779b9);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  return perm;
}

/** Seeded 2D simplex noise in [-1, 1]. Continuous (C²), deterministic, fast. */
export function createSimplex2D(seed: number): Noise2D {
  const perm = buildPerm(seed);
  const fn = (x: number, y: number): number => {
    const s = (x + y) * F2;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    let i1 = 0;
    let j1 = 1;
    if (x0 > y0) {
      i1 = 1;
      j1 = 0;
    }
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;
    let n = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      const g = perm[ii + perm[jj]] & 15;
      t0 *= t0;
      n += t0 * t0 * (GX[g] * x0 + GY[g] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      const g = perm[ii + i1 + perm[jj + j1]] & 15;
      t1 *= t1;
      n += t1 * t1 * (GX[g] * x1 + GY[g] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      const g = perm[ii + 1 + perm[jj + 1]] & 15;
      t2 *= t2;
      n += t2 * t2 * (GX[g] * x2 + GY[g] * y2);
    }
    return SCALE * n;
  };
  Object.defineProperty(fn, 'perm', { value: perm });
  return fn as Noise2D;
}

export interface NoiseDeriv {
  v: number;
  dx: number;
  dy: number;
}

/** Simplex noise value and analytic gradient at (x, y). Writes into `out` (no allocation). */
export function simplex2Deriv(noise: Noise2D, x: number, y: number, out: NoiseDeriv): NoiseDeriv {
  const perm = noise.perm;
  const s = (x + y) * F2;
  const i = Math.floor(x + s);
  const j = Math.floor(y + s);
  const t = (i + j) * G2;
  const x0 = x - (i - t);
  const y0 = y - (j - t);
  let i1 = 0;
  let j1 = 1;
  if (x0 > y0) {
    i1 = 1;
    j1 = 0;
  }
  const x1 = x0 - i1 + G2;
  const y1 = y0 - j1 + G2;
  const x2 = x0 - 1 + 2 * G2;
  const y2 = y0 - 1 + 2 * G2;
  const ii = i & 255;
  const jj = j & 255;
  let n = 0;
  let dx = 0;
  let dy = 0;
  const t0 = 0.5 - x0 * x0 - y0 * y0;
  if (t0 > 0) {
    const g = perm[ii + perm[jj]] & 15;
    const gd = GX[g] * x0 + GY[g] * y0;
    const t2 = t0 * t0;
    const t4 = t2 * t2;
    n += t4 * gd;
    const k = -8 * t2 * t0 * gd;
    dx += k * x0 + t4 * GX[g];
    dy += k * y0 + t4 * GY[g];
  }
  const t1 = 0.5 - x1 * x1 - y1 * y1;
  if (t1 > 0) {
    const g = perm[ii + i1 + perm[jj + j1]] & 15;
    const gd = GX[g] * x1 + GY[g] * y1;
    const t2 = t1 * t1;
    const t4 = t2 * t2;
    n += t4 * gd;
    const k = -8 * t2 * t1 * gd;
    dx += k * x1 + t4 * GX[g];
    dy += k * y1 + t4 * GY[g];
  }
  const t2_ = 0.5 - x2 * x2 - y2 * y2;
  if (t2_ > 0) {
    const g = perm[ii + 1 + perm[jj + 1]] & 15;
    const gd = GX[g] * x2 + GY[g] * y2;
    const t2 = t2_ * t2_;
    const t4 = t2 * t2;
    n += t4 * gd;
    const k = -8 * t2 * t2_ * gd;
    dx += k * x2 + t4 * GX[g];
    dy += k * y2 + t4 * GY[g];
  }
  out.v = SCALE * n;
  out.dx = SCALE * dx;
  out.dy = SCALE * dy;
  return out;
}

// Octave rotation (≈36.87°) — decorrelates octaves and hides lattice directions.
const RC = 0.8;
const RS = 0.6;

/** Fractal Brownian motion, normalised to [-1, 1]. */
export function fbm(noise: Noise2D, x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let px = x;
  let py = y;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(px, py);
    norm += amp;
    amp *= gain;
    const nx = (RC * px - RS * py) * lacunarity + 17.13;
    py = (RS * px + RC * py) * lacunarity - 5.71;
    px = nx;
  }
  return sum / norm;
}

/**
 * Ridged multifractal (Musgrave), normalised to [0, 1]: sharp crests, smooth
 * troughs; each octave is weighted by the previous signal so valleys stay calm.
 */
export function ridged(noise: Noise2D, x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5, sharpness = 2): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let weight = 1;
  let px = x;
  let py = y;
  for (let o = 0; o < octaves; o++) {
    let s = 1 - Math.abs(noise(px, py));
    s = sharpness === 2 ? s * s : Math.pow(s, sharpness);
    s *= weight;
    weight = s * 1.6;
    if (weight > 1) weight = 1;
    sum += s * amp;
    norm += amp;
    amp *= gain;
    const nx = (RC * px - RS * py) * lacunarity + 31.7;
    py = (RS * px + RC * py) * lacunarity - 11.3;
    px = nx;
  }
  return sum / norm;
}

const _d: NoiseDeriv = { v: 0, dx: 0, dy: 0 };

/**
 * "Eroded" fBm (after Íñigo Quílez): each octave is damped by the accumulated
 * slope, so detail concentrates on ridges and valleys stay smooth. [-1, 1].
 */
export function erodedFbm(noise: Noise2D, x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5, damping = 1): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let dx = 0;
  let dy = 0;
  let px = x;
  let py = y;
  for (let o = 0; o < octaves; o++) {
    simplex2Deriv(noise, px, py, _d);
    dx += _d.dx * amp;
    dy += _d.dy * amp;
    sum += (amp * _d.v) / (1 + damping * (dx * dx + dy * dy));
    norm += amp;
    amp *= gain;
    const nx = (RC * px - RS * py) * lacunarity + 7.31;
    py = (RS * px + RC * py) * lacunarity + 3.17;
    px = nx;
  }
  return sum / norm;
}

/**
 * Domain warp: offsets (x, y) by `amp` × a pair of decorrelated noise samples at
 * frequency `freq`. Writes the warped point into `out`.
 */
export function warp(noise: Noise2D, x: number, y: number, freq: number, amp: number, out: { x: number; y: number }): { x: number; y: number } {
  const fx = x * freq;
  const fy = y * freq;
  const wx = noise(fx + 5.2, fy + 1.3);
  const wy = noise(fx - 8.3, fy + 2.8);
  out.x = x + amp * wx;
  out.y = y + amp * wy;
  return out;
}

const _sd: NoiseDeriv = { v: 0, dx: 0, dy: 0 };

/**
 * Slope-limited fBm, in world units (metres in, metres out). Each octave is
 * damped by the world-space slope already accumulated by the coarser octaves
 * (factor 1 / (1 + (S / maxSlope)²), S = Σ |octave gradient|), so fine detail
 * fades out on steep faces and gathers on ridges, shoulders and valley floors —
 * the look of eroded mountains — while the slope stays near `maxSlope` (no cliffs).
 *
 * The first `ridgeOctaves` octaves are ridged (1 − 2·|n|, crest softened over
 * `ridgeSoftness` of a wavelength): sharp arêtes and pointed peaks with smooth
 * troughs. S sums per-octave slope bounds (gradient magnitudes), which are
 * continuous everywhere, so the damping never jumps.
 *
 * @param amp0 amplitude of the first octave (m)
 * @param wavelength wavelength of the first octave (m)
 * @param maxSlope soft slope limit (rise over run)
 */
export function slopeLimitedFbm(
  noise: Noise2D,
  x: number,
  z: number,
  amp0: number,
  wavelength: number,
  octaves: number,
  gain = 0.5,
  maxSlope = 0.8,
  ridgeOctaves = 0,
  ridgeSoftness = 0.03,
): number {
  let h = 0;
  let amp = amp0;
  let f = 1 / wavelength;
  let S = 0;
  let px = x;
  let pz = z;
  const inv = 1 / (maxSlope * maxSlope);
  const e2 = ridgeSoftness * ridgeSoftness;
  for (let o = 0; o < octaves; o++) {
    simplex2Deriv(noise, px * f, pz * f, _sd);
    let v = _sd.v;
    let g = Math.sqrt(_sd.dx * _sd.dx + _sd.dy * _sd.dy);
    if (o < ridgeOctaves) {
      // soft |n|: sqrt(n² + ε²) − ε ; ridge value 1 − 2·|n|. Its slope bound 2·|∇n| (not the
      // instantaneous slope, which vanishes on the crest) feeds the damping, so crests stay clean.
      const sa = Math.sqrt(v * v + e2);
      v = 1 - 2 * (sa - ridgeSoftness);
      g *= 2;
    }
    const k2 = S * S * inv;
    const a = amp / (1 + k2);
    h += v * a;
    S += g * f * a;
    amp *= gain;
    f *= 2;
    const nx = RC * px - RS * pz + 1731.3;
    pz = RS * px + RC * pz - 571.9;
    px = nx;
  }
  return h;
}
