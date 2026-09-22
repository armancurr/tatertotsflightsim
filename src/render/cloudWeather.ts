/**
 * The cumulus "weather map" and the cloud-shadow geometry (pure, no three.js).
 *
 * The same cloud field that places the billboard fallback clouds
 * (cloudLayout.ts) is rasterised into a periodic 2D map covering one cloud
 * tile (2·areaRadius, repeating like the billboard wrap), RGBA8:
 *   R  column top above the cloud base = the upper surface of the cloud's puff
 *      spheres (max over puffs), capped at the cloud's height, / maxThickness
 *   G  cloud base altitude: baseMin + G·baseRange (flat condensation level)
 *   B  per-cloud density multiplier
 *   A  coverage: max over puffs of (1 − d/r), 0 at the rim → 1 at a puff's
 *      centre (soft, erodible cloud sides instead of vertical walls)
 * The volumetric raymarch (volumetricClouds.ts) turns this heightfield into a
 * 3D density — flat base, soft domed top — and erodes it with 3D noise; the
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

/** Density ramps: sharp flat base (m) and soft domed top (m). */
export const BASE_SOFT = 40;
export const TOP_SOFT = 300;
/** Thin columns (column top below this, m) are weaker: frayed cloud rims. */
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
  /** Density multiplier 0..1. */
  dens: number;
  /** Coverage 0..1 (0 at the cloud rim). */
  cov?: number;
}

export function createWeatherMap(field: CloudField, o: WeatherMapOptions): WeatherMap {
  const data = new Uint8Array(o.size * o.size * 4);
  return { ...o, tile: field.tile, data };
}

function hash01(i: number, seed: number): number {
  let h = Math.imul(i | 0, 374761393) ^ Math.imul(seed | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
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
    const bCode = Math.round(255 * (0.78 + 0.22 * hash01(ci, 77)));
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
          const t = Math.min(c.height, topBase + Math.sqrt(r2 - d2));
          const code = Math.max(1, Math.min(255, Math.round((t / maxThickness) * 255)));
          const cov = Math.round(255 * (1 - Math.sqrt(d2) / r));
          if (cov > data[k + 3]) data[k + 3] = cov;
          if (code > data[k]) {
            data[k] = code;
            data[k + 1] = gCode;
            data[k + 2] = bCode;
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
    out.dens = 0;
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
  out.dens = lerp(2);
  out.cov = lerp(3);
  return out;
}

const _s: WeatherSample = { top: 0, base: 0, dens: 0, cov: 0 };
const sat = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x);

/** Base (un-eroded) cloud density 0..1 at a world point: flat base, soft domed top. */
export function cloudColumnDensity(map: WeatherMap, x: number, y: number, z: number, windX: number, windZ: number): number {
  sampleWeather(map, x, z, windX, windZ, _s);
  if (_s.top < 1) return 0;
  const h = y - _s.base;
  if (!(h > 0) || h >= _s.top) return 0;
  return sat(h / BASE_SOFT) * sat((_s.top - h) / TOP_SOFT) * sat(_s.top / EDGE_SOFT) * sat((_s.cov ?? 1) / COV_SOFT);
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
    if (d > 0) tau += d * _s.dens * SHADOW_SIGMA * ds;
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
