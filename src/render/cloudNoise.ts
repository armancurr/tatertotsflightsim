/**
 * Procedural, tileable 3D noise volumes for the volumetric clouds (pure, no
 * three.js). Generated at start-up in time slices (see jobQueue.ts) and
 * uploaded as Data3DTextures by volumetricClouds.ts.
 *
 *   SHAPE  (64³ RGBA): R = Perlin-Worley (billowy low-frequency base shape),
 *          G/B/A = Worley at 4, 8, 16 cells per tile (the low-frequency FBM
 *          that erodes the base shape into lobes).
 *   DETAIL (32³ RGBA): R/G/B = Worley at 2, 4, 8 cells per tile, A = their
 *          FBM — erodes cloud edges into cauliflower billows / wisps.
 *
 * Every channel is stretched to the full byte range, and every function here
 * tiles with the volume, so the textures can be sampled with REPEAT wrapping.
 */

/** Integer lattice hash → uint32 (deterministic across platforms). */
function hash3(ix: number, iy: number, iz: number, seed: number): number {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(iz | 0, 1440662683) ^ Math.imul(seed | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return h >>> 0;
}

// Perlin's 12 cube-edge gradients.
const GRAD = new Int8Array([1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1]);

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const mod = (a: number, p: number) => ((a % p) + p) % p;

function gdot(ix: number, iy: number, iz: number, p: number, seed: number, x: number, y: number, z: number): number {
  const g = (hash3(mod(ix, p), mod(iy, p), mod(iz, p), seed) % 12) * 3;
  return GRAD[g] * x + GRAD[g + 1] * y + GRAD[g + 2] * z;
}

/** Improved Perlin gradient noise, periodic with `period` lattice cells in every axis. Range [-1, 1]. */
export function perlin3(x: number, y: number, z: number, period: number, seed = 0): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const fx = x - x0;
  const fy = y - y0;
  const fz = z - z0;
  const u = fade(fx);
  const v = fade(fy);
  const w = fade(fz);
  const n000 = gdot(x0, y0, z0, period, seed, fx, fy, fz);
  const n100 = gdot(x0 + 1, y0, z0, period, seed, fx - 1, fy, fz);
  const n010 = gdot(x0, y0 + 1, z0, period, seed, fx, fy - 1, fz);
  const n110 = gdot(x0 + 1, y0 + 1, z0, period, seed, fx - 1, fy - 1, fz);
  const n001 = gdot(x0, y0, z0 + 1, period, seed, fx, fy, fz - 1);
  const n101 = gdot(x0 + 1, y0, z0 + 1, period, seed, fx - 1, fy, fz - 1);
  const n011 = gdot(x0, y0 + 1, z0 + 1, period, seed, fx, fy - 1, fz - 1);
  const n111 = gdot(x0 + 1, y0 + 1, z0 + 1, period, seed, fx - 1, fy - 1, fz - 1);
  const x00 = n000 + u * (n100 - n000);
  const x10 = n010 + u * (n110 - n010);
  const x01 = n001 + u * (n101 - n001);
  const x11 = n011 + u * (n111 - n011);
  const y0v = x00 + v * (x10 - x00);
  const y1v = x01 + v * (x11 - x01);
  const r = y0v + w * (y1v - y0v);
  return r > 1 ? 1 : r < -1 ? -1 : r;
}

/** Feature points of a tileable Worley grid: one point per cell, offsets in [0,1) cell units. */
export interface WorleyGrid {
  cells: number;
  points: Float32Array;
}

export function createWorleyGrid(cells: number, seed: number): WorleyGrid {
  const points = new Float32Array(cells * cells * cells * 3);
  for (let z = 0; z < cells; z++)
    for (let y = 0; y < cells; y++)
      for (let x = 0; x < cells; x++) {
        const o = ((z * cells + y) * cells + x) * 3;
        points[o] = hash3(x, y, z, seed) / 4294967296;
        points[o + 1] = hash3(x, y, z, seed + 101) / 4294967296;
        points[o + 2] = hash3(x, y, z, seed + 202) / 4294967296;
      }
  return { cells, points };
}

/**
 * Inverted Worley F1 at (x, y, z) in TILE units (the grid repeats every 1.0):
 * 1 at a feature point, falling to 0 one cell away. Range [0, 1].
 */
export function worley3(g: WorleyGrid, x: number, y: number, z: number): number {
  const n = g.cells;
  const px = x * n;
  const py = y * n;
  const pz = z * n;
  const cx = Math.floor(px);
  const cy = Math.floor(py);
  const cz = Math.floor(pz);
  const pts = g.points;
  let best = 9;
  for (let dz = -1; dz <= 1; dz++) {
    const iz = cz + dz;
    const wz = ((iz % n) + n) % n;
    for (let dy = -1; dy <= 1; dy++) {
      const iy = cy + dy;
      const wy = ((iy % n) + n) % n;
      for (let dx = -1; dx <= 1; dx++) {
        const ix = cx + dx;
        const wx = ((ix % n) + n) % n;
        const o = ((wz * n + wy) * n + wx) * 3;
        const ex = ix + pts[o] - px;
        const ey = iy + pts[o + 1] - py;
        const ez = iz + pts[o + 2] - pz;
        const d = ex * ex + ey * ey + ez * ez;
        if (d < best) best = d;
      }
    }
  }
  const f1 = Math.sqrt(best);
  return f1 >= 1 ? 0 : 1 - f1;
}

export interface NoiseVolumeSpec {
  kind: 'shape' | 'detail';
  /** Voxels per side. */
  size: number;
  /** Perlin base frequency (lattice cells per tile) and octaves (shape only). */
  perlinFreq: number;
  perlinOctaves: number;
  /** Worley cells per tile for the three Worley channels. */
  worleyFreqs: [number, number, number];
}

export const SHAPE_NOISE: NoiseVolumeSpec = { kind: 'shape', size: 64, perlinFreq: 4, perlinOctaves: 4, worleyFreqs: [4, 8, 16] };
export const DETAIL_NOISE: NoiseVolumeSpec = { kind: 'detail', size: 32, perlinFreq: 0, perlinOctaves: 0, worleyFreqs: [2, 4, 8] };

/**
 * Generator that fills `out` (size³ × RGBA bytes), yielding after every block
 * of `rowsPerYield` rows (default ≈ 1024 voxels, ~1–2 ms of work) and after
 * stretching each of the 4 channels to 0..255. Deterministic for (spec, seed).
 */
export function* noiseVolumeJob(
  spec: NoiseVolumeSpec,
  seed: number,
  out?: Uint8Array,
  rowsPerYield = Math.max(1, Math.min(spec.size, Math.floor(1024 / spec.size))),
): Generator<void, Uint8Array, void> {
  const n = spec.size;
  const voxels = n * n * n;
  const dst = out ?? new Uint8Array(voxels * 4);
  const raw = new Float32Array(voxels * 4);
  const grids = spec.worleyFreqs.map((f, i) => createWorleyGrid(f, seed * 31 + 7 + i * 13));
  const inv = 1 / n;
  for (let z = 0; z < n; z++) {
    const w = (z + 0.5) * inv;
    for (let y = 0; y < n; y++) {
      const v = (y + 0.5) * inv;
      for (let x = 0; x < n; x++) {
        const u = (x + 0.5) * inv;
        const w0 = worley3(grids[0], u, v, w);
        const w1 = worley3(grids[1], u, v, w);
        const w2 = worley3(grids[2], u, v, w);
        const wf = w0 * 0.625 + w1 * 0.25 + w2 * 0.125;
        const o = ((z * n + y) * n + x) * 4;
        if (spec.kind === 'shape') {
          let p = 0;
          let amp = 1;
          let norm = 0;
          let f = spec.perlinFreq;
          for (let k = 0; k < spec.perlinOctaves; k++) {
            p += amp * perlin3(u * f, v * f, w * f, f, seed + k * 57);
            norm += amp;
            amp *= 0.5;
            f *= 2;
          }
          const p01 = Math.min(1, Math.max(0, 0.5 + 0.8 * (p / norm)));
          // Perlin-Worley: remap(perlin, 0, 1, worleyFbm, 1) — billowy, connected blobs
          raw[o] = wf + p01 * (1 - wf);
          raw[o + 1] = w0;
          raw[o + 2] = w1;
          raw[o + 3] = w2;
        } else {
          raw[o] = w0;
          raw[o + 1] = w1;
          raw[o + 2] = w2;
          raw[o + 3] = wf;
        }
      }
      if ((y + 1) % rowsPerYield === 0 || y === n - 1) yield;
    }
  }
  for (let ch = 0; ch < 4; ch++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = ch; i < raw.length; i += 4) {
      const r = raw[i];
      if (r < lo) lo = r;
      if (r > hi) hi = r;
    }
    const s = hi > lo ? 255 / (hi - lo) : 0;
    for (let i = ch; i < raw.length; i += 4) dst[i] = Math.round((raw[i] - lo) * s);
    yield;
  }
  return dst;
}

/** Whole volume in one go (tests, tools). */
export function generateNoiseVolume(spec: NoiseVolumeSpec, seed: number): Uint8Array {
  const job = noiseVolumeJob(spec, seed);
  for (;;) {
    const r = job.next();
    if (r.done) return r.value;
  }
}
