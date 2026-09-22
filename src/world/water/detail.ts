/**
 * The water's small-scale detail: a seamless tile of wind-wave slopes baked
 * once from an ocean spectrum with an inverse FFT (no downloaded textures),
 * plus a CPU mip chain in LEAN-mapping form so distant water filters
 * correctly: each texel stores (sx, sz, sx² + sz², h). Box-filtering keeps
 * E[s] and E[s²], so the shader recovers the slope variance a pixel covers
 * (E[s²] − E[s]²) and turns it into specular roughness — sharp sparkle up
 * close, a broad sun-glitter path from altitude, no shimmer.
 *
 * Tile space: unit square, wind along +x. Slopes normalised to unit RMS per
 * axis (the shader scales them by the wind's slope variance), heights to unit
 * RMS. PURE.
 */
import { mulberry32 } from './waves';

/** In-place radix-2 complex FFT (length must be a power of two). Inverse includes the 1/n scale. */
export function fft1d(re: Float64Array, im: Float64Array, inverse: boolean, off = 0, stride = 1, n = re.length): void {
  // bit reversal
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const a = off + i * stride;
      const b = off + j * stride;
      let t = re[a];
      re[a] = re[b];
      re[b] = t;
      t = im[a];
      im[a] = im[b];
      im[b] = t;
    }
  }
  const sgn = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (sgn * 2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = off + (i + k) * stride;
        const b = off + (i + k + half) * stride;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
  if (inverse)
    for (let i = 0; i < n; i++) {
      re[off + i * stride] /= n;
      im[off + i * stride] /= n;
    }
}

/** In-place 2D FFT of an n×n row-major complex grid. */
export function fft2d(re: Float64Array, im: Float64Array, n: number, inverse: boolean): void {
  for (let r = 0; r < n; r++) fft1d(re, im, inverse, r * n, 1, n);
  for (let c = 0; c < n; c++) fft1d(re, im, inverse, c, n, n);
}

// ── IEEE half floats (for HalfFloatType DataTextures, filterable everywhere in WebGL2) ──
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** float → IEEE 754 binary16 bits (round to nearest, clamped to ±65504). */
export function toHalf(v: number): number {
  if (Number.isNaN(v)) return 0x7e00;
  v = v > 65504 ? 65504 : v < -65504 ? -65504 : v;
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  const e = exp - 127 + 15;
  if (exp === 0 || e < -10) return sign; // zero / too small
  if (e <= 0) {
    // subnormal half
    mant |= 0x800000;
    const shift = 14 - e;
    let h = mant >> shift;
    if ((mant >> (shift - 1)) & 1) h += 1;
    return sign | h;
  }
  let h = sign | (e << 10) | (mant >> 13);
  if (mant & 0x1000) h += 1; // round (carry into the exponent is correct)
  return h;
}

/** IEEE 754 binary16 bits → float. */
export function fromHalf(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

export interface DetailTile {
  size: number;
  /** Mip levels (size, size/2, … 1), each RGBA float: sx, sz, sx²+sz², h. */
  levels: Float32Array[];
}

/**
 * Bake the tile: a random-phase spectrum ∝ k⁻⁴ (equal slope variance per
 * octave) between 2 and size/4 cycles per tile, cos² spread around +x, with a
 * soft roll-off at both ends; slopes and heights by inverse FFT.
 */
export function bakeDetailTile(size: number, seed: number): DetailTile {
  const n = size;
  const N = n * n;
  const hr = new Float64Array(N);
  const hi = new Float64Array(N);
  const xr = new Float64Array(N);
  const xi = new Float64Array(N);
  const zr = new Float64Array(N);
  const zi = new Float64Array(N);
  const rnd = mulberry32((seed * 747796405) ^ 0x51ed27);
  const gauss = (): number => {
    const u = Math.max(1e-12, rnd());
    const v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const kMin = 2;
  const kMax = Math.max(2, n / 4);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const g1 = gauss();
      const g2 = gauss();
      const kx = i < n / 2 ? i : i - n;
      const kz = j < n / 2 ? j : j - n;
      const k = Math.hypot(kx, kz);
      if (k < 1) continue;
      const dir = kx / k;
      const spread = 0.15 + 0.85 * dir * dir;
      const lo = 1 - Math.exp(-((k / kMin) ** 4));
      const hiCut = Math.exp(-((k / kMax) ** 2));
      const amp = Math.sqrt((spread * lo * hiCut) / k ** 4);
      const a = j * n + i;
      hr[a] = g1 * amp;
      hi[a] = g2 * amp;
      // slopes: i·k·h
      xr[a] = -kx * hi[a];
      xi[a] = kx * hr[a];
      zr[a] = -kz * hi[a];
      zi[a] = kz * hr[a];
    }
  fft2d(hr, hi, n, true);
  fft2d(xr, xi, n, true);
  fft2d(zr, zi, n, true);
  // normalise (zero mean, unit RMS per axis for slopes, unit RMS height)
  let mx = 0;
  let mz = 0;
  let mh = 0;
  for (let a = 0; a < N; a++) {
    mx += xr[a];
    mz += zr[a];
    mh += hr[a];
  }
  mx /= N;
  mz /= N;
  mh /= N;
  let vs = 0;
  let vh = 0;
  for (let a = 0; a < N; a++) {
    xr[a] -= mx;
    zr[a] -= mz;
    hr[a] -= mh;
    vs += xr[a] * xr[a] + zr[a] * zr[a];
    vh += hr[a] * hr[a];
  }
  const ss = vs > 0 ? 1 / Math.sqrt(vs / (2 * N)) : 0;
  const sh = vh > 0 ? 1 / Math.sqrt(vh / N) : 0;
  const L0 = new Float32Array(N * 4);
  for (let a = 0; a < N; a++) {
    const sx = xr[a] * ss;
    const sz = zr[a] * ss;
    L0[a * 4] = sx;
    L0[a * 4 + 1] = sz;
    L0[a * 4 + 2] = sx * sx + sz * sz;
    L0[a * 4 + 3] = hr[a] * sh;
  }
  const levels: Float32Array[] = [L0];
  let cur = L0;
  for (let s = n >> 1; s >= 1; s >>= 1) {
    const next = new Float32Array(s * s * 4);
    const ps = s * 2;
    for (let j = 0; j < s; j++)
      for (let i = 0; i < s; i++)
        for (let c = 0; c < 4; c++) {
          const a = ((2 * j) * ps + 2 * i) * 4 + c;
          next[(j * s + i) * 4 + c] = (cur[a] + cur[a + 4] + cur[a + ps * 4] + cur[a + ps * 4 + 4]) * 0.25;
        }
    levels.push(next);
    cur = next;
  }
  return { size: n, levels };
}
