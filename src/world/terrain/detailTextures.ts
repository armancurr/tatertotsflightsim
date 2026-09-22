/**
 * Procedural ground detail textures, generated at start-up (in a worker) —
 * no downloaded assets. PURE and deterministic (seeded), resolution-independent
 * and seamlessly tileable (every noise lattice wraps with the tile).
 *
 * Each layer is a close-up photo substitute for one kind of ground, as seen
 * from a few metres: mown grass, a leafy crop canopy, ploughed soil, gravel /
 * scree, rock, sand, snow and straw stubble. The terrain shader samples them
 * with hex tiling (no visible repetition) and multiplies its own macro colour
 * by them, so every layer is stored as a NEUTRAL modulation:
 *
 *   albedo  RGBA8: rgb = colour / mean colour × 0.5 (mean exactly ≈ 0.5 per channel,
 *                  so distant mips leave the macro palette untouched), a = height 0..1
 *   normal  RGBA8: r, g = tangent-space normal x, z (×0.5 + 0.5; world +X, +Z),
 *                  b = cavity / ambient occlusion (1 = open), a = 255
 *
 * Also the small tileable RGBA noise texture the shader uses instead of
 * per-pixel hashing (value noise ×2, fBm, cellular).
 */

export const DETAIL_LAYERS = ['grass', 'crop', 'soil', 'gravel', 'rock', 'sand', 'snow', 'straw'] as const;
export type DetailLayer = (typeof DETAIL_LAYERS)[number];
/** Physical size of one texture tile per layer, m (the shader's uv = world xz / size). */
export const DETAIL_TILE_M = [1.6, 2.4, 2.4, 1.6, 7.0, 3.0, 8.0, 1.8];
/** Relief amplitude per layer (m) used for the normal map. */
const DETAIL_RELIEF_M = [0.006, 0.04, 0.03, 0.025, 0.1, 0.008, 0.04, 0.008];
export const NOISE_TEX_SIZE = 256;
/** Lattice cells per tile in the noise texture's value-noise channels (shader: uv = p / NOISE_CELLS). */
export const NOISE_CELLS = 32;

// ── hashing and periodic noise (texture-space u, v ∈ [0, 1), wrapping) ─────────

function hash3(a: number, b: number, c: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const wrapI = (i: number, n: number): number => ((i % n) + n) % n;

/** Periodic value noise in [0, 1]: `f` lattice cells per tile. */
function vnoise(u: number, v: number, f: number, seed: number): number {
  const x = u * f;
  const y = v * f;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let fx = x - ix;
  let fy = y - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const x0 = wrapI(ix, f);
  const y0 = wrapI(iy, f);
  const x1 = x0 + 1 === f ? 0 : x0 + 1;
  const y1 = y0 + 1 === f ? 0 : y0 + 1;
  const a = hash3(x0, y0, seed);
  const b = hash3(x1, y0, seed);
  const c = hash3(x0, y1, seed);
  const d = hash3(x1, y1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** Periodic fBm in [0, 1] (octave frequencies f, 2f, 4f …, all periodic). */
function fbm(u: number, v: number, f: number, octaves: number, seed: number, gain = 0.5): number {
  let s = 0;
  let a = 1;
  let n = 0;
  for (let o = 0; o < octaves; o++) {
    s += a * vnoise(u, v, f << o, seed + o * 101);
    n += a;
    a *= gain;
  }
  return s / n;
}

interface Cell {
  f1: number;
  f2: number;
  id: number;
}
const newCell = (): Cell => ({ f1: 0, f2: 0, id: 0 });

/** Periodic cellular noise: distances (in cell units) to the nearest two jittered points. */
function worley(u: number, v: number, f: number, seed: number, out: Cell, jitter = 0.9): Cell {
  const x = u * f;
  const y = v * f;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let f1 = 9;
  let f2 = 9;
  let id = 0;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const cx = wrapI(ix + dx, f);
      const cy = wrapI(iy + dy, f);
      const px = ix + dx + 0.5 + (hash3(cx, cy, seed) - 0.5) * jitter;
      const py = iy + dy + 0.5 + (hash3(cx, cy, seed + 1) - 0.5) * jitter;
      const ex = px - x;
      const ey = py - y;
      const d = Math.sqrt(ex * ex + ey * ey);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = cy * f + cx;
      } else if (d < f2) f2 = d;
    }
  out.f1 = f1;
  out.f2 = f2;
  out.id = id;
  return out;
}

const sat = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const sstep = (e0: number, e1: number, x: number): number => {
  const t = sat((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

// ── layer canvas ───────────────────────────────────────────────────────────────

interface Canvas {
  n: number;
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  h: Float32Array;
}

function newCanvas(n: number): Canvas {
  const m = n * n;
  return { n, r: new Float32Array(m), g: new Float32Array(m), b: new Float32Array(m), h: new Float32Array(m) };
}

/** Fill every texel from a function of (u, v) at the texel centre. */
function fill(c: Canvas, fn: (u: number, v: number, i: number, out: number[]) => void): void {
  const { n } = c;
  const o = [0, 0, 0, 0];
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      fn((x + 0.5) / n, (y + 0.5) / n, i, o);
      c.r[i] = o[0];
      c.g[i] = o[1];
      c.b[i] = o[2];
      c.h[i] = o[3];
    }
}

/**
 * Paint a thin stroke (a blade, a straw) from (x, y) along angle `a`, `len` texels long,
 * rising from height h0 to h1; a texel is painted only where the stroke is higher (z-buffer).
 */
function stroke(c: Canvas, x: number, y: number, a: number, len: number, h0: number, h1: number, r: number, g: number, b: number, shade: number, width = 1): void {
  const { n } = c;
  const steps = Math.max(1, Math.ceil(len));
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  const px = -dy;
  const py = dx;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const hh = h0 + (h1 - h0) * t;
    const k = 1 - shade + shade * t; // darker at the base
    for (let w = 0; w < width; w++) {
      const off = w - (width - 1) / 2;
      const ix = wrapI(Math.round(x + dx * t * len + px * off), n);
      const iy = wrapI(Math.round(y + dy * t * len + py * off), n);
      const i = iy * n + ix;
      if (hh > c.h[i]) {
        c.h[i] = hh;
        c.r[i] = r * k;
        c.g[i] = g * k;
        c.b[i] = b * k;
      }
    }
  }
}

/** Paint a filled ellipse (a leaf, a pebble) with a domed height profile. */
function blob(c: Canvas, x: number, y: number, a: number, rl: number, rw: number, h: number, dome: number, r: number, g: number, b: number, vein = 0): void {
  const { n } = c;
  const R = Math.ceil(Math.max(rl, rw));
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  for (let oy = -R; oy <= R; oy++)
    for (let ox = -R; ox <= R; ox++) {
      const lx = (ox * ca + oy * sa) / rl;
      const ly = (-ox * sa + oy * ca) / rw;
      const d2 = lx * lx + ly * ly;
      if (d2 > 1) continue;
      const hh = h + dome * (1 - d2);
      const ix = wrapI(Math.round(x) + ox, n);
      const iy = wrapI(Math.round(y) + oy, n);
      const i = iy * n + ix;
      if (hh > c.h[i]) {
        c.h[i] = hh;
        const k = 1 + vein * (Math.abs(ly) < 0.12 ? 1 : 0) - 0.18 * d2;
        c.r[i] = r * k;
        c.g[i] = g * k;
        c.b[i] = b * k;
      }
    }
}

// ── the layers ─────────────────────────────────────────────────────────────────

function grass(n: number, seed: number): Canvas {
  const c = newCanvas(n);
  const k = n / 512;
  // thatch and soil between the blades
  fill(c, (u, v, _i, o) => {
    const t = fbm(u, v, 16, 3, seed + 1);
    o[0] = 0.07 + 0.05 * t;
    o[1] = 0.065 + 0.04 * t;
    o[2] = 0.03 + 0.015 * t;
    o[3] = 0.05 * t;
  });
  const rnd = mulberry(seed * 7 + 3);
  const count = Math.round(n * n * 0.42);
  for (let i = 0; i < count; i++) {
    const x = rnd() * n;
    const y = rnd() * n;
    const u = x / n;
    const v = y / n;
    const clump = fbm(u, v, 5, 3, seed + 11);
    if (rnd() > 0.45 + 0.55 * clump) continue;
    const hue = fbm(u, v, 3, 2, seed + 17);
    const clover = sstep(0.66, 0.72, fbm(u, v, 9, 3, seed + 23));
    const mott = fbm(u, v, 10, 2, seed + 29);
    const bright = (0.75 + 0.5 * rnd()) * (0.7 + 0.3 * clump + 0.3 * mott);
    if (clover > 0.5 && rnd() < 0.35) {
      // clover leaflets: three small round leaves, dark blue-green
      const a0 = rnd() * 6.283;
      for (let l = 0; l < 3; l++) {
        const a = a0 + l * 2.094;
        blob(c, x + Math.cos(a) * 2.2 * k, y + Math.sin(a) * 2.2 * k, a, 2.3 * k, 1.9 * k, 0.55 + 0.35 * rnd(), 0.08, 0.08 * bright, 0.19 * bright, 0.07 * bright);
      }
      continue;
    }
    let r: number;
    let g: number;
    let b: number;
    const dead = rnd();
    if (dead < 0.06) {
      r = 0.36;
      g = 0.31;
      b = 0.15;
    } else if (dead < 0.1) {
      r = 0.2;
      g = 0.24;
      b = 0.08;
    } else {
      // yellow-green ↔ blue-green by patch
      const t = hue * 0.8 + rnd() * 0.2;
      r = 0.19 * t + 0.07 * (1 - t);
      g = 0.3 * t + 0.21 * (1 - t);
      b = 0.05 * t + 0.07 * (1 - t);
    }
    const len = (4 + 10 * rnd()) * k;
    const a = rnd() * 6.283;
    stroke(c, x, y, a, len, 0.1 + 0.2 * rnd(), 0.45 + 0.55 * rnd() * (0.6 + 0.4 * clump), r * bright, g * bright, b * bright, 0.35);
  }
  return c;
}

function crop(n: number, seed: number): Canvas {
  const c = newCanvas(n);
  const k = n / 512;
  fill(c, (u, v, _i, o) => {
    const t = fbm(u, v, 12, 3, seed + 1);
    o[0] = 0.035 + 0.02 * t;
    o[1] = 0.04 + 0.02 * t;
    o[2] = 0.02 + 0.01 * t;
    o[3] = 0.04 * t;
  });
  const rnd = mulberry(seed * 13 + 5);
  const count = Math.round(n * n * 0.055);
  for (let i = 0; i < count; i++) {
    const x = rnd() * n;
    const y = rnd() * n;
    const vig = fbm(x / n, y / n, 4, 2, seed + 7);
    const len = (6 + 9 * rnd()) * k;
    const t = rnd();
    const bright = 0.8 + 0.4 * rnd();
    const r = (0.07 + 0.06 * t + 0.03 * vig) * bright;
    const g = (0.16 + 0.07 * t + 0.03 * vig) * bright;
    const b = (0.035 + 0.02 * t) * bright;
    blob(c, x, y, rnd() * 6.283, len, len * (0.3 + 0.15 * rnd()), 0.2 + 0.7 * rnd(), 0.12, r, g, b, 0.18);
  }
  return c;
}

function soil(n: number, seed: number): Canvas {
  const c = newCanvas(n);
  const w1 = newCell();
  const w2 = newCell();
  const w3 = newCell();
  fill(c, (u, v, _i, o) => {
    const wu = u + 0.035 * (fbm(u, v, 8, 2, seed + 21) - 0.5);
    const wv = v + 0.035 * (fbm(u, v, 8, 2, seed + 23) - 0.5);
    worley(wu, wv, 11, seed + 3, w1);
    worley(wu, wv, 34, seed + 5, w2);
    worley(u, v, 30, seed + 7, w3);
    const clod = (1 - sstep(0.15, 1.05, w1.f1)) * (0.6 + 0.4 * hash3(w1.id, 5, seed));
    const crumb = 1 - sstep(0.1, 0.9, w2.f1);
    const lump = fbm(u, v, 6, 4, seed + 9);
    let h = 0.5 * clod + 0.14 * crumb + 0.36 * lump;
    const moist = fbm(u, v, 3, 2, seed + 13);
    let r = 0.15 - 0.05 * moist;
    let g = 0.105 - 0.035 * moist;
    let b = 0.068 - 0.022 * moist;
    // dry, paler crust on the tops of the clods; dark crevices
    const top = sstep(0.5, 0.85, h);
    r += 0.06 * top;
    g += 0.05 * top;
    b += 0.04 * top;
    const crev = 0.55 + 0.45 * sstep(0.12, 0.45, h);
    r *= crev;
    g *= crev;
    b *= crev;
    // a few pale stones
    if (hash3(w3.id, 0, seed + 17) < 0.14 && w3.f1 < 0.26) {
      const s = 1 - w3.f1 / 0.26;
      const t = hash3(w3.id, 1, seed + 17);
      r = 0.3 + 0.1 * t;
      g = 0.28 + 0.08 * t;
      b = 0.25 + 0.07 * t;
      h = Math.max(h, 0.55 + 0.35 * s);
    }
    const grain = 0.9 + 0.2 * hash3(Math.floor(u * n), Math.floor(v * n), seed + 19);
    o[0] = r * grain;
    o[1] = g * grain;
    o[2] = b * grain;
    o[3] = h;
  });
  // bits of old straw
  const rnd = mulberry(seed * 3 + 1);
  const k = n / 512;
  for (let i = 0; i < n * n * 0.002; i++) stroke(c, rnd() * n, rnd() * n, rnd() * 6.283, (6 + 14 * rnd()) * k, 0.7, 0.75, 0.34, 0.29, 0.16, 0.1);
  return c;
}

const STONE_COLOURS = [
  [0.25, 0.25, 0.24],
  [0.3, 0.26, 0.2],
  [0.13, 0.13, 0.13],
  [0.42, 0.41, 0.38],
  [0.24, 0.19, 0.14],
  [0.33, 0.32, 0.3],
];

function gravel(n: number, seed: number): Canvas {
  const c = newCanvas(n);
  const w1 = newCell();
  const w2 = newCell();
  fill(c, (u, v, _i, o) => {
    worley(u, v, 14, seed + 3, w1);
    worley(u, v, 38, seed + 5, w2);
    const m1 = sstep(0.02, 0.14, w1.f2 - w1.f1);
    const m2 = sstep(0.03, 0.16, w2.f2 - w2.f1);
    const s1 = hash3(w1.id, 2, seed);
    const s2 = hash3(w2.id, 2, seed + 1);
    const h1 = m1 * (1 - Math.min(1, w1.f1 * w1.f1 * 1.3)) * (0.55 + 0.45 * s1);
    const h2 = m2 * (1 - Math.min(1, w2.f1 * w2.f1 * 1.5)) * (0.3 + 0.3 * s2);
    const grain = 0.88 + 0.24 * hash3(Math.floor(u * n), Math.floor(v * n), seed + 9);
    let col: number[];
    let h: number;
    if (h1 >= h2) {
      col = STONE_COLOURS[Math.floor(hash3(w1.id, 3, seed) * STONE_COLOURS.length)];
      h = h1;
    } else {
      col = STONE_COLOURS[Math.floor(hash3(w2.id, 3, seed + 1) * STONE_COLOURS.length)];
      h = h2;
    }
    const fines = 1 - sstep(0.05, 0.25, h);
    const spot = 0.85 + 0.3 * vnoise(u, v, 64, seed + 21);
    o[0] = (col[0] * (1 - fines) + 0.1 * fines) * grain * spot;
    o[1] = (col[1] * (1 - fines) + 0.09 * fines) * grain * spot;
    o[2] = (col[2] * (1 - fines) + 0.08 * fines) * grain * spot;
    o[3] = h;
  });
  return c;
}

function rock(n: number, seed: number): Canvas {
  const c = newCanvas(n);
  const w1 = newCell();
  const w2 = newCell();
  const w3 = newCell();
  fill(c, (u, v, _i, o) => {
    const wu = u + 0.06 * (fbm(u, v, 4, 3, seed + 21) - 0.5);
    const wv = v + 0.06 * (fbm(u, v, 4, 3, seed + 23) - 0.5);
    worley(wu, wv, 5, seed + 3, w1, 0.8);
    worley(wu, wv, 15, seed + 5, w2);
    worley(u, v, 44, seed + 7, w3);
    const crack1 = 1 - sstep(0, 0.06, w1.f2 - w1.f1);
    const crack2 = 1 - sstep(0, 0.05, w2.f2 - w2.f1);
    const bumps = fbm(u, v, 4, 5, seed + 9, 0.55);
    const facet = 0.12 * hash3(w1.id, 1, seed); // blocks sit at slightly different levels
    let h = 0.55 * bumps + 0.25 + facet - 0.35 * crack1 - 0.15 * crack2;
    const tone = fbm(u, v, 3, 3, seed + 11);
    const blockTone = hash3(w1.id, 7, seed) - 0.5;
    let r = 0.27 + 0.1 * tone + 0.05 * blockTone;
    let g = 0.26 + 0.085 * tone + 0.045 * blockTone;
    let b = 0.245 + 0.06 * tone + 0.035 * blockTone;
    // lichen: yellow-green and rust spots in patches
    const patch = sstep(0.5, 0.75, fbm(u, v, 6, 3, seed + 13));
    if (patch > 0 && w3.f1 < 0.4 * patch) {
      const t = hash3(w3.id, 0, seed + 15);
      const s = 1 - w3.f1 / (0.4 * patch + 1e-6);
      const lr = t < 0.6 ? 0.33 : 0.42;
      const lg = t < 0.6 ? 0.34 : 0.28;
      const lb = t < 0.6 ? 0.18 : 0.13;
      const m = sat(s * 2);
      r += (lr - r) * m;
      g += (lg - g) * m;
      b += (lb - b) * m;
      h += 0.02 * m;
    }
    const dark = 1 - 0.4 * crack1 - 0.22 * crack2;
    const grain = 0.86 + 0.28 * hash3(Math.floor(u * n), Math.floor(v * n), seed + 17);
    r *= dark * grain;
    g *= dark * grain;
    b *= dark * grain;
    o[0] = r;
    o[1] = g;
    o[2] = b;
    o[3] = h;
  });
  return c;
}

function sand(n: number, seed: number): Canvas {
  const c = newCanvas(n);
  fill(c, (u, v, _i, o) => {
    const warp = fbm(u, v, 4, 3, seed + 3);
    // ripple wave vector on the integer lattice (periodic), meandering by the warp
    const ph = (u * 23 + v * 11 + warp * 2.2) * Math.PI * 2;
    const s = 0.5 + 0.5 * Math.sin(ph);
    const rip = Math.pow(s, 1.6);
    const grainH = hash3(Math.floor(u * n), Math.floor(v * n), seed + 5);
    const h = 0.7 * rip + 0.15 * fbm(u, v, 8, 3, seed + 7) + 0.15 * grainH;
    const tone = fbm(u, v, 5, 2, seed + 9);
    let r = 0.46 + 0.05 * tone - 0.04 * (1 - rip);
    let g = 0.39 + 0.04 * tone - 0.035 * (1 - rip);
    let b = 0.27 + 0.03 * tone - 0.03 * (1 - rip);
    const gr = hash3(Math.floor(u * n), Math.floor(v * n), seed + 11);
    if (gr < 0.025) {
      r *= 0.45;
      g *= 0.45;
      b *= 0.47;
    } else if (gr > 0.985) {
      r *= 1.35;
      g *= 1.35;
      b *= 1.4;
    } else {
      const k = 0.9 + 0.2 * grainH;
      r *= k;
      g *= k;
      b *= k;
    }
    o[0] = r;
    o[1] = g;
    o[2] = b;
    o[3] = h;
  });
  return c;
}

function snow(n: number, seed: number): Canvas {
  const c = newCanvas(n);
  fill(c, (u, v, _i, o) => {
    const drift = fbm(u, v, 3, 5, seed + 3, 0.55);
    const w = fbm(u, v, 5, 2, seed + 5);
    const sast = Math.pow(0.5 + 0.5 * Math.sin((u * 13 + v * 4 + w * 1.5) * Math.PI * 2), 3);
    const h = 0.75 * drift + 0.25 * sast;
    const hollow = 1 - sstep(0.25, 0.6, h);
    const grain = 0.97 + 0.06 * hash3(Math.floor(u * n), Math.floor(v * n), seed + 7);
    o[0] = (0.86 - 0.07 * hollow) * grain;
    o[1] = (0.88 - 0.04 * hollow) * grain;
    o[2] = (0.9 + 0.01 * hollow) * grain;
    o[3] = h;
  });
  return c;
}

function straw(n: number, seed: number): Canvas {
  const c = newCanvas(n);
  const k = n / 512;
  const w = newCell();
  fill(c, (u, v, _i, o) => {
    const t = fbm(u, v, 10, 3, seed + 1);
    o[0] = 0.2 + 0.05 * t;
    o[1] = 0.15 + 0.04 * t;
    o[2] = 0.1 + 0.025 * t;
    o[3] = 0.1 * t;
    // stubble stalks: small bright cut ends on a jittered lattice
    worley(u, v, 72, seed + 3, w, 0.7);
    if (w.f1 < 0.2) {
      const s = 1 - w.f1 / 0.2;
      o[0] = 0.5 * (0.7 + 0.3 * s);
      o[1] = 0.43 * (0.7 + 0.3 * s);
      o[2] = 0.26 * (0.7 + 0.3 * s);
      o[3] = 0.6 + 0.3 * s;
    }
  });
  const rnd = mulberry(seed * 11 + 7);
  const count = Math.round(n * n * 0.03);
  for (let i = 0; i < count; i++) {
    const x = rnd() * n;
    const y = rnd() * n;
    const weathered = rnd() < 0.25;
    const b = 0.8 + 0.4 * rnd();
    const r = (weathered ? 0.34 : 0.52) * b;
    const g = (weathered ? 0.31 : 0.44) * b;
    const bl = (weathered ? 0.22 : 0.22) * b;
    stroke(c, x, y, rnd() * 6.283, (8 + 22 * rnd()) * k, 0.2 + 0.35 * rnd(), 0.25 + 0.35 * rnd(), r, g, bl, 0.1);
  }
  return c;
}

const GENERATORS: ((n: number, seed: number) => Canvas)[] = [grass, crop, soil, gravel, rock, sand, snow, straw];

// ── packing ──────────────────────────────────────────────────────────────────

/** Separable wrap-around box blur of a scalar field. */
function boxBlur(src: Float32Array, n: number, r: number): Float32Array {
  const tmp = new Float32Array(n * n);
  const out = new Float32Array(n * n);
  const w = 2 * r + 1;
  for (let y = 0; y < n; y++) {
    let s = 0;
    for (let k = -r; k <= r; k++) s += src[y * n + wrapI(k, n)];
    for (let x = 0; x < n; x++) {
      tmp[y * n + x] = s / w;
      s += src[y * n + wrapI(x + r + 1, n)] - src[y * n + wrapI(x - r, n)];
    }
  }
  for (let x = 0; x < n; x++) {
    let s = 0;
    for (let k = -r; k <= r; k++) s += tmp[wrapI(k, n) * n + x];
    for (let y = 0; y < n; y++) {
      out[y * n + x] = s / w;
      s += tmp[wrapI(y + r + 1, n) * n + x] - tmp[wrapI(y - r, n) * n + x];
    }
  }
  return out;
}

function pack(c: Canvas, layer: number): { albedo: Uint8Array; normal: Uint8Array } {
  const { n } = c;
  const m = n * n;
  const albedo = new Uint8Array(m * 4);
  const normal = new Uint8Array(m * 4);
  // colour → neutral modulation (mean 0.5 per channel)
  let mr = 0;
  let mg = 0;
  let mb = 0;
  for (let i = 0; i < m; i++) {
    mr += c.r[i];
    mg += c.g[i];
    mb += c.b[i];
  }
  mr = (mr / m) * 2 || 1;
  mg = (mg / m) * 2 || 1;
  mb = (mb / m) * 2 || 1;
  // height → 0..1 between robust percentiles
  const sorted = Float32Array.from(c.h).sort();
  const lo = sorted[Math.floor(m * 0.005)];
  const hi = sorted[Math.min(m - 1, Math.floor(m * 0.995))];
  const span = hi - lo > 1e-6 ? hi - lo : 1;
  const H = new Float32Array(m);
  for (let i = 0; i < m; i++) H[i] = sat((c.h[i] - lo) / span);
  const toByte = (x: number) => Math.round(sat(x) * 255);
  for (let i = 0; i < m; i++) {
    albedo[i * 4] = toByte(c.r[i] / mr);
    albedo[i * 4 + 1] = toByte(c.g[i] / mg);
    albedo[i * 4 + 2] = toByte(c.b[i] / mb);
    albedo[i * 4 + 3] = toByte(H[i]);
  }
  // re-centre the clamped result on 0.5 so distant mips are exactly neutral
  for (let ch = 0; ch < 3; ch++) {
    let s = 0;
    for (let i = 0; i < m; i++) s += albedo[i * 4 + ch];
    const shift = Math.round(127.5 - s / m);
    if (shift !== 0) for (let i = 0; i < m; i++) albedo[i * 4 + ch] = Math.max(0, Math.min(255, albedo[i * 4 + ch] + shift));
  }
  // normals from the height (physical relief over the physical texel size), cavity from local depth
  const texel = DETAIL_TILE_M[layer] / n;
  const k = DETAIL_RELIEF_M[layer] / (2 * texel);
  const blur = boxBlur(H, n, Math.max(1, Math.round(n / 96)));
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const dx = (H[y * n + wrapI(x + 1, n)] - H[y * n + wrapI(x - 1, n)]) * k;
      const dz = (H[wrapI(y + 1, n) * n + x] - H[wrapI(y - 1, n) * n + x]) * k;
      const l = Math.sqrt(dx * dx + 1 + dz * dz);
      normal[i * 4] = toByte(-dx / l * 0.5 + 0.5);
      normal[i * 4 + 1] = toByte(-dz / l * 0.5 + 0.5);
      normal[i * 4 + 2] = toByte(Math.max(0.25, 1 - Math.max(0, blur[i] - H[i]) * 2.2));
      normal[i * 4 + 3] = 255;
    }
  return { albedo, normal };
}

/** One layer (index into DETAIL_LAYERS) at `size`² texels. */
export function generateDetailLayer(layer: number, size: number, seed: number): { albedo: Uint8Array; normal: Uint8Array } {
  const gen = GENERATORS[layer];
  if (!gen) throw new Error(`detail layer ${layer} does not exist`);
  return pack(gen(size, (seed * 977 + layer * 7919) >>> 0), layer);
}

export interface DetailSet {
  size: number;
  layers: number;
  /** size² × 4 × layers, layer-major (DataArrayTexture layout). */
  albedo: Uint8Array;
  normal: Uint8Array;
}

/** Every layer, packed for a DataArrayTexture. */
export function generateDetailSet(size: number, seed: number): DetailSet {
  const L = DETAIL_LAYERS.length;
  const per = size * size * 4;
  const albedo = new Uint8Array(per * L);
  const normal = new Uint8Array(per * L);
  for (let l = 0; l < L; l++) {
    const t = generateDetailLayer(l, size, seed);
    albedo.set(t.albedo, l * per);
    normal.set(t.normal, l * per);
  }
  return { size, layers: L, albedo, normal };
}

/**
 * The shader's noise texture (RGBA8, tileable): r, g = independent smooth value noise with
 * NOISE_CELLS lattice cells per tile; b = 4-octave fBm (from 16 cells); a = cellular F1 (16 cells).
 */
export function generateNoiseTexture(size: number, seed: number): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const w = newCell();
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const i = (y * size + x) * 4;
      out[i] = Math.round(vnoise(u, v, NOISE_CELLS, seed + 1) * 255);
      out[i + 1] = Math.round(vnoise(u, v, NOISE_CELLS, seed + 2) * 255);
      out[i + 2] = Math.round(sat((fbm(u, v, 16, 4, seed + 3) - 0.5) * 1.6 + 0.5) * 255);
      worley(u, v, 16, seed + 4, w);
      out[i + 3] = Math.round(sat(w.f1 / 1.0) * 255);
    }
  return out;
}
