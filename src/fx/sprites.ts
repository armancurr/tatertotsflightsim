/**
 * PURE procedural particle sprites, packed in one RGBA8 atlas (4 × 2 tiles):
 *
 *   row 0 (v = 0..½): 4 billowy smoke puffs — A = density, RG = sprite-space normal (xy, 0.5
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

function smokeTile(size: number, seed: number) {
  const r = rng(seed);
  const n = size * size;
  const dens = new Float32Array(n);
  const height = new Float32Array(n);
  // A cluster of overlapping blobs: the big central one plus 5 lobes.
  const blobs: { x: number; y: number; r: number }[] = [{ x: 0, y: 0, r: 0.56 }];
  for (let b = 0; b < 5; b++) {
    const ang = r() * Math.PI * 2;
    const dist = 0.22 + 0.16 * r();
    blobs.push({ x: Math.cos(ang) * dist, y: Math.sin(ang) * dist, r: 0.3 + 0.16 * r() });
  }
  const ox = r() * 100;
  const oy = r() * 100;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = ((x + 0.5) / size) * 2 - 1;
      const v = ((y + 0.5) / size) * 2 - 1;
      let shape = 0;
      for (const bl of blobs) {
        const d2 = ((u - bl.x) ** 2 + (v - bl.y) ** 2) / (bl.r * bl.r);
        shape = Math.max(shape, 1 - d2);
      }
      const nz = fbm(u * 2.6 + ox, v * 2.6 + oy, seed);
      const detail = fbm(u * 7 + oy, v * 7 + ox, seed + 5, 3);
      const d = shape * (0.6 + 0.8 * nz) - 0.1 + 0.08 * (detail - 0.5);
      const rr = Math.hypot(u, v);
      const k = y * size + x;
      dens[k] = smooth(0, 0.5, d) * smooth(0.9, 0.76, rr);
      height[k] = Math.sqrt(Math.max(0, shape)) * 0.85 + 0.35 * nz + 0.08 * detail;
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
      core[k] = dens[k] > 0 ? Math.min(1, Math.max(0, height[k] * 0.9)) : 0;
    }
  }
  return { dens, nx, ny, core };
}

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
      const wob = (fbm(u * 1.4 + ox, v * 2.2 - ox, seed) - 0.5) * 0.55 * (0.25 + t);
      const xw = u - wob - lean * t;
      const width = 0.66 * Math.pow(Math.max(0, 1 - t), 0.85) * smooth(0.02, 0.2, t);
      const c = width > 1e-4 ? 1 - Math.abs(xw) / width : 0;
      const tongues = fbm(u * 3.2 + ox, v * 1.4 - ox * 0.5, seed + 9);
      let d = smooth(0, 0.55, c) * smooth(0.2, 0.62, tongues + 0.45 * (1 - t));
      d *= smooth(0.92, 0.78, Math.abs(u)) * smooth(0.92, 0.8, Math.abs(v));
      const k = y * size + x;
      dens[k] = d;
      core[k] = d * Math.max(0, c) * Math.pow(1 - t, 0.4);
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
