/**
 * The cumulus "weather map" and the cloud-shadow geometry (pure, no three.js).
 *
 * The same cloud field that places the billboard fallback clouds
 * (cloudLayout.ts) is rasterised into a periodic 2D map covering one cloud
 * tile (2·areaRadius, repeating like the billboard wrap), RGBA8:
 *   R  column top above the cloud base = the upper surface of the cloud's puff
 *      spheres (max over puffs), capped at the cloud's height, / maxThickness
 *   G  cloud base altitude: baseMin + G·baseRange (flat condensation level)
 *   B  column bottom above the cloud base = the lower surface of the puff
 *      spheres (min over puffs, ≥ 0), / maxThickness; 1 where no puff is
 *   A  coverage: max over puffs of (1 − d/r), 0 at the rim → 1 at a puff's
 *      centre (soft, erodible cloud sides instead of vertical walls)
 * So each column spans [bottom, top]: the union of the puff spheres, sliced
 * per texel — a flat base (the spheres dip below it and are cut off) that
 * rounds up at the rim, bulging sides and cauliflower domes instead of a
 * cylinder with a lid. The volumetric raymarch (volumetricClouds.ts) turns
 * this into a 3D density and erodes it with 3D noise; the
 * shadow pass integrates the same density along the sun ray. GLSL mirrors of
 * `sampleWeather` / `cloudColumnDensity` live in volumetricClouds.ts; the
 * functions here are what the tests exercise and what the CPU uses (in-cloud
 * immersion, shadow reference).
 *
 * UV convention: u = (x − windX)/tile + 0.5, v = (z − windZ)/tile + 0.5; texel
 * (i, j) is stored at data[(j·size + i)·4] and centred at u = (i + 0.5)/size.
 */
import type { Vec3 } from '../types';
import {
  PUFF_STRIDE,
  P_DX,
  P_DZ,
  P_R,
  P_Y,
  type CloudField,
} from './cloudLayout';

/** Density ramps: sharp flat base / underside (m) and the domed top surface (m). */
export const BASE_SOFT = 40;
export const TOP_SOFT = 120;
/** Thin columns (column thickness below this, m) are weaker: frayed cloud rims. */
export const EDGE_SOFT = 150;
/** Coverage ramp: the outer part of every puff's footprint is thinner (erodible sides). */
export const COV_SOFT = 0.45;
/** Extinction used for the cloud shadow (1/m at density 1). */
export const SHADOW_SIGMA = 0.04;

export interface WeatherMapOptions {
  size: number;
  baseMin: number;
  baseRange: number;
  maxThickness: number;
}

export interface WeatherMap extends WeatherMapOptions {
  /** Metres per tile (period). */
  tile: number;
  data: Uint8Array;
}

export interface WeatherSample {
  /** Column top above the base, m (0 = no cloud). */
  top: number;
  /** Base altitude, m. */
  base: number;
  /** Column bottom above the base, m (0 on the flat base). */
  bottom: number;
  /** Coverage 0..1 (0 at the cloud rim). */
  cov?: number;
}

export function createWeatherMap(field: CloudField, o: WeatherMapOptions): WeatherMap {
  const data = new Uint8Array(o.size * o.size * 4);
  for (let i = 2; i < data.length; i += 4) data[i] = 255; // no puff: the column bottom is at the top of the layer
  return { ...o, tile: field.tile, data };
}

/** Rasterise the field into `map` (clouds × puffs), yielding every `cloudsPerYield` clouds. */
export function* weatherRasterJob(field: CloudField, map: WeatherMap, cloudsPerYield = 16): Generator<void, WeatherMap, void> {
  const { size, tile, data, baseMin, baseRange, maxThickness } = map;
  const texel = tile / size;
  const half = tile / 2;
  const p = field.puffs;
  for (let ci = 0; ci < field.clouds.length; ci++) {
    const c = field.clouds[ci];
    const gCode = Math.max(0, Math.min(255, Math.round(((c.base - baseMin) / baseRange) * 255)));
    const end = c.firstPuff + c.puffCount;
    for (let i = c.firstPuff; i < end; i++) {
      const o = i * PUFF_STRIDE;
      const px = c.x + p[o + P_DX];
      const pz = c.z + p[o + P_DZ];
      const r = p[o + P_R];
      const r2 = r * r;
      const topBase = p[o + P_Y] - c.base;
      const i0 = Math.ceil((px - r + half) / texel - 0.5) - 1;
      const i1 = Math.floor((px + r + half) / texel - 0.5) + 1;
      const j0 = Math.ceil((pz - r + half) / texel - 0.5) - 1;
      const j1 = Math.floor((pz + r + half) / texel - 0.5) + 1;
      for (let j = j0; j <= j1; j++) {
        const zc = (j + 0.5) * texel - half;
        const dz = zc - pz;
        const row = (((j % size) + size) % size) * size;
        for (let ii = i0; ii <= i1; ii++) {
          const xc = (ii + 0.5) * texel - half;
          const dx = xc - px;
          const k = (row + (((ii % size) + size) % size)) * 4;
          const d2 = dx * dx + dz * dz;
          if (d2 >= r2) {
            if (data[k] === 0) data[k + 1] = gCode; // dilate the base so bilinear edges stay on this cloud's base
            continue;
          }
          const chord = Math.sqrt(r2 - d2);
          const t = Math.min(c.height, topBase + chord);
          const code = Math.max(1, Math.min(255, Math.round((t / maxThickness) * 255)));
          const bot = Math.max(0, Math.min(255, Math.floor((Math.max(0, topBase - chord) / maxThickness) * 255)));
          const cov = Math.round(255 * (1 - Math.sqrt(d2) / r));
          if (cov > data[k + 3]) data[k + 3] = cov;
          if (bot < data[k + 2]) data[k + 2] = bot;
          if (code > data[k]) {
            data[k] = code;
            data[k + 1] = gCode;
          }
        }
      }
    }
    if (ci % cloudsPerYield === cloudsPerYield - 1) yield;
  }
  return map;
}

export function rasterizeWeather(field: CloudField, map: WeatherMap): WeatherMap {
  const job = weatherRasterJob(field, map);
  for (;;) {
    const r = job.next();
    if (r.done) return r.value;
  }
}

export function weatherUv(map: WeatherMap, x: number, z: number, windX: number, windZ: number, out: { u: number; v: number }) {
  out.u = (x - windX) / map.tile + 0.5;
  out.v = (z - windZ) / map.tile + 0.5;
  return out;
}

const _uv = { u: 0, v: 0 };

/** Bilinear, wrapping sample of the map at world (x, z) with the wind offset. */
export function sampleWeather(map: WeatherMap, x: number, z: number, windX: number, windZ: number, out: WeatherSample): WeatherSample {
  weatherUv(map, x, z, windX, windZ, _uv);
  const n = map.size;
  const fx = _uv.u * n - 0.5;
  const fz = _uv.v * n - 0.5;
  if (!Number.isFinite(fx) || !Number.isFinite(fz)) {
    out.top = 0;
    out.base = map.baseMin;
    out.bottom = 0;
    return out;
  }
  const x0 = Math.floor(fx);
  const z0 = Math.floor(fz);
  const tx = fx - x0;
  const tz = fz - z0;
  const i0 = ((x0 % n) + n) % n;
  const i1 = (i0 + 1) % n;
  const j0 = ((z0 % n) + n) % n;
  const j1 = (j0 + 1) % n;
  const d = map.data;
  const a = (j0 * n + i0) * 4;
  const b = (j0 * n + i1) * 4;
  const c = (j1 * n + i0) * 4;
  const e = (j1 * n + i1) * 4;
  const w00 = (1 - tx) * (1 - tz);
  const w10 = tx * (1 - tz);
  const w01 = (1 - tx) * tz;
  const w11 = tx * tz;
  const lerp = (ch: number) => (d[a + ch] * w00 + d[b + ch] * w10 + d[c + ch] * w01 + d[e + ch] * w11) / 255;
  out.top = lerp(0) * map.maxThickness;
  out.base = map.baseMin + lerp(1) * map.baseRange;
  out.bottom = lerp(2) * map.maxThickness;
  out.cov = lerp(3);
  return out;
}

// ─── Distance field (empty-space skipping for the march) ─────────────────────
/**
 * A coarse periodic map (same uv convention as the weather map) of the
 * horizontal clearance from each point to the nearest cloud column, used by
 * the march to jump over empty sky: `sampleClearance` (and its GLSL mirror)
 * never over-estimates — no column (bilinear weather top ≥ 1 m) lies within
 * that distance. R8 codes of `unit` m, floor-quantised; the bilinear-sampling
 * slack is subtracted as `margin`.
 */
export interface CloudDistanceField {
  size: number;
  tile: number;
  /** Metres per code step. */
  unit: number;
  /** Metres to subtract from the bilinear sample (Lipschitz slack of bilinear interpolation). */
  margin: number;
  data: Uint8Array;
}

export function createDistanceField(map: WeatherMap, size: number, unit = 32): CloudDistanceField {
  const cell = map.tile / size;
  return { size, tile: map.tile, unit, margin: 0.75 * cell, data: new Uint8Array(size * size) };
}

const EDT_INF = 1e20;

/** 1D squared Euclidean distance transform (Felzenszwalb & Huttenlocher) of f[0..n) into d. */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/**
 * Build the distance field from a rasterised weather map, yielding every
 * `linesPerYield` rows/columns. Occupancy: a cell is taken if the bilinear
 * support (±1 texel) of any non-empty weather texel overlaps it; the exact
 * periodic EDT between cell centres, minus the half cell diagonal, is a lower
 * bound on the clearance at each cell centre.
 */
export function* distanceFieldJob(map: WeatherMap, df: CloudDistanceField, linesPerYield = 64): Generator<void, CloudDistanceField, void> {
  const n = df.size;
  const wn = map.size;
  const wt = map.tile / wn;
  const cell = df.tile / n;
  const occ = new Uint8Array(n * n);
  const src = map.data;
  for (let j = 0; j < wn; j++) {
    const y0 = Math.floor(((j - 0.5) * wt) / cell);
    const y1 = Math.ceil(((j + 1.5) * wt) / cell) - 1;
    for (let i = 0; i < wn; i++) {
      if (src[(j * wn + i) * 4] === 0) continue;
      const x0 = Math.floor(((i - 0.5) * wt) / cell);
      const x1 = Math.ceil(((i + 1.5) * wt) / cell) - 1;
      for (let y = y0; y <= y1; y++) {
        const row = (((y % n) + n) % n) * n;
        for (let x = x0; x <= x1; x++) occ[row + (((x % n) + n) % n)] = 1;
      }
    }
    if (j % (linesPerYield * 4) === linesPerYield * 4 - 1) yield;
  }
  // periodic EDT: pad each line with wrapped cells up to the capped distance
  const capCells = Math.ceil((255 * df.unit) / cell) + 2;
  const pad = Math.min(n, capCells);
  const len = n + 2 * pad;
  const f = new Float64Array(len);
  const d = new Float64Array(len);
  const v = new Int32Array(len);
  const z = new Float64Array(len + 1);
  const g = new Float64Array(n * n);
  for (let x = 0; x < n; x++) {
    for (let q = 0; q < len; q++) {
      const y = (((q - pad) % n) + n) % n;
      f[q] = occ[y * n + x] ? 0 : EDT_INF;
    }
    edt1d(f, len, d, v, z);
    for (let y = 0; y < n; y++) g[y * n + x] = d[y + pad];
    if (x % linesPerYield === linesPerYield - 1) yield;
  }
  const half = Math.SQRT1_2 * cell;
  for (let y = 0; y < n; y++) {
    for (let q = 0; q < len; q++) {
      const x = (((q - pad) % n) + n) % n;
      f[q] = g[y * n + x];
    }
    edt1d(f, len, d, v, z);
    for (let x = 0; x < n; x++) {
      const dist = Math.sqrt(d[x + pad]) * cell - half;
      df.data[y * n + x] = dist >= 255 * df.unit ? 255 : Math.max(0, Math.floor(dist / df.unit));
    }
    if (y % linesPerYield === linesPerYield - 1) yield;
  }
  return df;
}

export function buildDistanceField(map: WeatherMap, df: CloudDistanceField): CloudDistanceField {
  const job = distanceFieldJob(map, df);
  for (;;) {
    const r = job.next();
    if (r.done) return r.value;
  }
}

/**
 * Margin to subtract from the sampled clearance when the column lookup is
 * displaced by up to ±warp m per axis (the GPU's noise domain warp): a point
 * can see a column up to warp·√2 closer than its own clearance says.
 */
export function warpedClearanceMargin(df: CloudDistanceField, warp: number): number {
  return df.margin + Math.max(0, warp) * Math.SQRT2;
}

/**
 * Conservative horizontal clearance (m) from world (x, z) to the nearest
 * cloud column (≤ 0 in or next to one). Bilinear + periodic like the GPU.
 */
export function sampleClearance(df: CloudDistanceField, x: number, z: number, windX: number, windZ: number): number {
  const n = df.size;
  const fx = ((x - windX) / df.tile + 0.5) * n - 0.5;
  const fz = ((z - windZ) / df.tile + 0.5) * n - 0.5;
  if (!Number.isFinite(fx) || !Number.isFinite(fz)) return -df.margin;
  const x0 = Math.floor(fx);
  const z0 = Math.floor(fz);
  const tx = fx - x0;
  const tz = fz - z0;
  const i0 = ((x0 % n) + n) % n;
  const i1 = (i0 + 1) % n;
  const j0 = ((z0 % n) + n) % n;
  const j1 = (j0 + 1) % n;
  const d = df.data;
  const v = (d[j0 * n + i0] * (1 - tx) + d[j0 * n + i1] * tx) * (1 - tz) + (d[j1 * n + i0] * (1 - tx) + d[j1 * n + i1] * tx) * tz;
  return v * df.unit - df.margin;
}

const _s: WeatherSample = { top: 0, base: 0, bottom: 0, cov: 0 };
const sat = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x);

/** Base (un-eroded) cloud density 0..1 at a world point: inside the column [bottom, top], sharp underside, softer domed top. */
export function cloudColumnDensity(map: WeatherMap, x: number, y: number, z: number, windX: number, windZ: number): number {
  sampleWeather(map, x, z, windX, windZ, _s);
  if (_s.top < 1) return 0;
  const h = y - _s.base;
  if (!(h > _s.bottom) || h >= _s.top) return 0;
  return sat((h - _s.bottom) / BASE_SOFT) * sat((_s.top - h) / TOP_SOFT) * sat((_s.top - _s.bottom) / EDGE_SOFT) * sat((_s.cov ?? 1) / COV_SOFT);
}

/** Point where the ray from p toward the sun crosses the horizontal plane y = planeY. */
export function projectAlongSun(px: number, py: number, pz: number, sun: Vec3, planeY: number, out: Vec3): Vec3 {
  const sy = Math.max(sun.y, 0.02);
  const t = (planeY - py) / sy;
  out.x = px + sun.x * t;
  out.y = planeY;
  out.z = pz + sun.z * t;
  return out;
}

/**
 * Opacity 0..1 of the cloud layer along the sun ray through the point q on the
 * plane y = map.baseMin (the shadow map stores exactly this per texel).
 * CPU reference of the GPU shadow pass (without the 3D-noise erosion).
 */
export function shadowOpacityAt(map: WeatherMap, qx: number, qz: number, sun: Vec3, windX: number, windZ: number, steps = 48): number {
  const sy = Math.max(sun.y, 0.05);
  const y0 = map.baseMin;
  const y1 = map.baseMin + map.baseRange + map.maxThickness;
  const dy = (y1 - y0) / steps;
  const ds = dy / sy;
  let tau = 0;
  for (let k = 0; k < steps; k++) {
    const y = y0 + (k + 0.5) * dy;
    const t = (y - map.baseMin) / sy;
    const x = qx + sun.x * t;
    const z = qz + sun.z * t;
    const d = cloudColumnDensity(map, x, y, z, windX, windZ);
    if (d > 0) tau += d * SHADOW_SIGMA * ds;
  }
  const op = 1 - Math.exp(-tau);
  return Number.isFinite(op) ? Math.min(1, Math.max(0, op)) : 0;
}

const smooth = (a: number, b: number, x: number) => {
  const t = sat((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/**
 * Multiplier (0..1) on a fragment's lit colour: 1 − strength·opacity, faded
 * out for a sun near/below the horizon and for points up in/above the layer.
 * Mirrors the fog-chunk GLSL (fog.ts).
 */
export function cloudShadowFactor(opacity: number, strength: number, py: number, planeY: number, sunY: number): number {
  if (!(sunY > 0)) return 1;
  const k = sat(strength) * sat(opacity) * smooth(0, 0.1, sunY) * (1 - smooth(planeY + 200, planeY + 900, py));
  const f = 1 - k;
  return Number.isFinite(f) ? sat(f) : 1;
}
