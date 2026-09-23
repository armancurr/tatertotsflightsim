/**
 * PURE procedural particle sprites, packed in one RGBA8 atlas (4 × 2 tiles), plus a tileable
 * 4-channel noise texture that the particle shader scrolls to animate them (flames lick upward,
 * fireballs roll, puffs boil and fray — every particle samples its own part of it):
 *
 *   row 0 (v = 0..½): 4 ragged billowy smoke puffs — A = density (Beer-Lambert: wispy edges, thick core), RG = sprite-space normal (xy, 0.5
 *                     = flat), B = thickness (hotter core when the puff is fire)
 *   row 1 (v = ½..1): 4 flame tongues — A = density, B = heat core, RG neutral
 *
 * Puffs are a cluster of overlapping blobs eroded by fractal noise (cauliflower edges), with
 * normals from the blob height field so the shader can light them like volumes (sun side
 * bright, shadow side dark). Every tile fades to exactly zero before its border.
 * Row 0 of the data is the bottom of the texture (DataTexture, flipY = false).
 */

export const ATLAS_COLS = 4;
export const ATLAS_ROWS = 2;
export const SMOKE_TILES = [0, 1, 2, 3] as const;
export const FLAME_TILES = [4, 5, 6, 7] as const;
/** Sparks and embers: drawn procedurally (a motion-blurred hot streak), not from the atlas. */
export const SPARK_TILE = 8;

export type ParticleKind = 'puff' | 'flame' | 'spark';

/** What the shader draws for a tile index (same thresholds as the GLSL: < 4 puff, < 8 flame, else spark). */
export function particleKind(tile: number): ParticleKind {
  return tile < 3.5 ? 'puff' : tile < 7.5 ? 'flame' : 'spark';
}

export interface Atlas {
  data: Uint8Array;
  width: number;
  height: number;
}

function hash(ix: number, iy: number, seed: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function vnoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy, seed);
  const b = hash(ix + 1, iy, seed);
  const c = hash(ix, iy + 1, seed);
  const d = hash(ix + 1, iy + 1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function fbm(x: number, y: number, seed: number, octaves = 5): number {
  let s = 0;
  let amp = 0.5;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    s += amp * vnoise(x * f, y * f, seed + o * 17);
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return s / norm;
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function writeTile(atlas: Atlas, tile: number, size: number, dens: Float32Array, nx: Float32Array, ny: Float32Array, core: Float32Array) {
  const col = tile % ATLAS_COLS;
  const row = Math.floor(tile / ATLAS_COLS);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const k = y * size + x;
      const o = ((row * size + y) * atlas.width + col * size + x) * 4;
      const a = Math.round(255 * Math.min(1, Math.max(0, dens[k])));
      atlas.data[o] = a > 0 ? Math.round(128 + 127 * nx[k]) : 128;
      atlas.data[o + 1] = a > 0 ? Math.round(128 + 127 * ny[k]) : 128;
      atlas.data[o + 2] = a > 0 ? Math.round(255 * Math.min(1, Math.max(0, core[k]))) : 0;
      atlas.data[o + 3] = a;
    }
  }
}

/**
 * A billowing smoke puff: a cauliflower cluster of soft gaussian blobs (a few big ones inside,
 * many small lobes around the rim), domain-warped by fractal noise so the silhouette is ragged,
 * modulated by internal turbulence, and turned into opacity with Beer-Lambert (1 − e^(−k·density))
 * so only the thick core approaches opaque while the edges stay wispy.
 */
function smokeTile(size: number, seed: number) {
  const r = rng(seed);
  const n = size * size;
  const dens = new Float32Array(n);
  const height = new Float32Array(n);
  const blobs: { x: number; y: number; r: number; w: number }[] = [];
  // the cluster leans one way (puffs are never symmetric)
  const lean = r() * Math.PI * 2;
  const lx = Math.cos(lean) * 0.06, ly = Math.sin(lean) * 0.06;
  for (let b = 0; b < 5; b++) {
    const ang = r() * Math.PI * 2;
    const dist = 0.24 * Math.sqrt(r());
    blobs.push({ x: lx + Math.cos(ang) * dist, y: ly + Math.sin(ang) * dist, r: 0.26 + 0.14 * r(), w: 0.7 + 0.4 * r() });
  }
  const lobes = 6 + Math.floor(r() * 4);
  for (let b = 0; b < lobes; b++) {
    const ang = r() * Math.PI * 2;
    const dist = 0.3 + 0.22 * r();
    blobs.push({ x: lx + Math.cos(ang) * dist, y: ly + Math.sin(ang) * dist, r: 0.13 + 0.14 * r(), w: 0.35 + 0.6 * r() });
  }
  const ox = r() * 100;
  const oy = r() * 100;
  // a lumpy outline: the silhouette radius wobbles with angle (random-phase harmonics)
  const ph = [r(), r(), r(), r()].map((p) => p * Math.PI * 2);
  const amp = [0.22, 0.16, 0.07, 0].map((a) => a * (0.75 + 0.5 * r()));
  const outline = (th: number) => 1 + amp[0] * Math.sin(2 * th + ph[0]) + amp[1] * Math.sin(3 * th + ph[1]) + amp[2] * Math.sin(4 * th + ph[2]) + amp[3] * Math.sin(5 * th + ph[3]);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = ((x + 0.5) / size) * 2 - 1;
      const v = ((y + 0.5) / size) * 2 - 1;
      // domain warp → ragged, torn edges
      const wu = u + 0.45 * (fbm(u * 1.5 + ox, v * 1.5 + oy, seed + 3, 4) - 0.5);
      const wv = v + 0.45 * (fbm(u * 1.5 + oy, v * 1.5 - ox, seed + 7, 4) - 0.5);
      let d = 0;
      for (const bl of blobs) d += bl.w * Math.exp(-((wu - bl.x) ** 2 + (wv - bl.y) ** 2) / (bl.r * bl.r));
      const turb = fbm(u * 3.2 + ox, v * 3.2 + oy, seed, 5);
      const fine = fbm(u * 6.5 + oy, v * 6.5 + ox, seed + 5, 3);
      d *= 0.55 + 0.8 * turb;
      d -= 0.1 + 0.08 * (fine - 0.5);
      d *= smooth(1.55, 0.4, Math.hypot(u - lx, v - ly) / (0.56 * outline(Math.atan2(v - ly, u - lx))));
      const rr = Math.hypot(u, v);
      const k = y * size + x;
      const win = smooth(0.93, 0.6, rr);
      dens[k] = (1 - Math.exp(-1.1 * Math.max(0, d))) * win;
      height[k] = 0.7 * Math.sqrt(Math.max(0, d)) + 0.45 * Math.max(0, 1 - rr * rr) + 0.06 * turb;
    }
  }
  const nx = new Float32Array(n);
  const ny = new Float32Array(n);
  const core = new Float32Array(n);
  const s = size / 6; // slope scale
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const k = y * size + x;
      const hx = height[y * size + Math.min(size - 1, x + 1)] - height[y * size + Math.max(0, x - 1)];
      const hy = height[Math.min(size - 1, y + 1) * size + x] - height[Math.max(0, y - 1) * size + x];
      let gx = -hx * s;
      let gy = -hy * s;
      const len = Math.hypot(gx, gy, 1);
      gx /= len;
      gy /= len;
      nx[k] = gx;
      ny[k] = gy;
      core[k] = dens[k] > 0 ? Math.min(1, Math.max(0, height[k] * 0.8)) : 0;
    }
  }
  return { dens, nx, ny, core };
}

/**
 * A flame lick: a soft gaussian cross-section (no hard outline) that narrows and leans upward,
 * broken into several flickering tongues by vertically stretched noise; hottest low in the core.
 */
function flameTile(size: number, seed: number) {
  const r = rng(seed);
  const n = size * size;
  const dens = new Float32Array(n);
  const core = new Float32Array(n);
  const zero = new Float32Array(n);
  const ox = r() * 50;
  const lean = (r() - 0.5) * 0.25;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = ((x + 0.5) / size) * 2 - 1;
      const v = ((y + 0.5) / size) * 2 - 1;
      const t = (v + 1) / 2; // 0 bottom → 1 top
      const wob = (fbm(u * 1.4 + ox, v * 1.8 - ox, seed, 4) - 0.5) * 0.5 * (0.25 + t);
      const xw = u - wob - lean * t;
      const width = 0.48 * Math.pow(Math.max(0, 1 - t), 0.8) + 0.12;
      const profile = Math.exp(-2.2 * (xw / width) ** 2) * smooth(0.0, 0.34, t);
      const tongues = fbm(u * 2.4 + ox, v * 1.1 - ox * 0.5, seed + 9, 4);
      let d = profile * smooth(0.15, 0.9, tongues + 0.5 * (1 - t));
      d *= smooth(0.95, 0.75, Math.abs(u)) * smooth(0.95, 0.78, Math.abs(v));
      const k = y * size + x;
      dens[k] = 1 - Math.exp(-1.65 * d);
      core[k] = d * profile * Math.pow(1 - t, 0.4);
    }
  }
  return { dens, nx: zero, ny: zero, core };
}

/** Build the atlas: `tile` px per tile (power of two recommended), deterministic per seed. */
export function generateParticleAtlas(tile = 128, seed = 1): Atlas {
  const size = Math.max(8, Math.floor(tile));
  const atlas: Atlas = { data: new Uint8Array(size * ATLAS_COLS * size * ATLAS_ROWS * 4), width: size * ATLAS_COLS, height: size * ATLAS_ROWS };
  for (const t of SMOKE_TILES) {
    const s = smokeTile(size, seed * 101 + t * 7 + 1);
    writeTile(atlas, t, size, s.dens, s.nx, s.ny, s.core);
  }
  for (const t of FLAME_TILES) {
    const f = flameTile(size, seed * 131 + t * 11 + 3);
    writeTile(atlas, t, size, f.dens, f.nx, f.ny, f.core);
  }
  return atlas;
}

/** Periodic value noise: lattice `period` cells across the tile, wrapping. */
function pnoise(x: number, y: number, period: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const x0 = ((ix % period) + period) % period, x1 = (x0 + 1) % period;
  const y0 = ((iy % period) + period) % period, y1 = (y0 + 1) % period;
  const a = hash(x0, y0, seed);
  const b = hash(x1, y0, seed);
  const c = hash(x0, y1, seed);
  const d = hash(x1, y1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/**
 * A seamlessly tiling RGBA8 noise texture: four independent fractal value-noise channels at rising
 * base frequencies (R, G: 4 cells across, 4 octaves; B: 8 cells, 3 octaves; A: 16 cells, 2 octaves),
 * each stretched to the full 0..1 range. Deterministic per seed.
 */
export function generateNoiseTexture(sizeIn = 128, seed = 1): Atlas {
  const size = Math.max(8, Math.floor(sizeIn));
  const n = size * size;
  const data = new Uint8Array(n * 4);
  const chans: [number, number][] = [
    [4, 4],
    [4, 4],
    [8, 3],
    [16, 2],
  ];
  const v = new Float32Array(n);
  for (let c = 0; c < 4; c++) {
    const [base, octaves] = chans[c];
    let lo = Infinity, hi = -Infinity;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let sum = 0, amp = 0.5, norm = 0, period = base;
        for (let o = 0; o < octaves; o++) {
          sum += amp * pnoise((x / size) * period, (y / size) * period, period, seed * 7919 + c * 131 + o * 17);
          norm += amp;
          amp *= 0.5;
          period *= 2;
        }
        const val = sum / norm;
        v[y * size + x] = val;
        if (val < lo) lo = val;
        if (val > hi) hi = val;
      }
    }
    const k = hi > lo ? 1 / (hi - lo) : 0;
    for (let i = 0; i < n; i++) data[i * 4 + c] = Math.round(255 * (v[i] - lo) * k);
  }
  return { data, width: size, height: size };
}
