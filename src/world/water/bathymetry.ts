/**
 * Bathymetry around the camera for the water shader: water depth below the
 * surface (sea or lake level) and the signed distance to the shoreline, baked
 * from the shared terrain height function into small grids (a two-level
 * clipmap: near ≈ 16 m texels, far ≈ 144 m) and uploaded as half-float RG
 * textures. The shader uses depth for turquoise shallows / dark deep water and
 * transparency at the waterline, and the shore distance for surf lines and the
 * foam rings around islands. PURE (the baking runs in a worker in the app).
 *
 * Texel convention = the GPU's: texel (i, j) is centred at
 * (cx − extent/2 + (i + ½)·cell, cz − extent/2 + (j + ½)·cell); sampling is
 * bilinear between centres with clamp-to-edge.
 */
import type { Heightfield } from '../heightfield';
import { newTerrainSample } from '../heightfield';
import { toHalf } from './detail';

/** Shore distances are clamped to ± this (m). */
export const SHORE_DIST_MAX = 2000;
/** Depths are clamped to this range (m) before packing. */
const DEPTH_MIN = -500;
const DEPTH_MAX = 4000;

export interface BathyLevel {
  res: number;
  /** Centre and side length of the covered square (m); cell = extent / res. */
  cx: number;
  cz: number;
  extent: number;
  cell: number;
  /** Water depth (m, + under water, − on land), row-major (z rows, x columns). */
  depth: Float32Array;
  /** Signed distance to the shoreline (m, + in the water). */
  shore: Float32Array;
  valid: boolean;
}

export function newBathyLevel(res: number): BathyLevel {
  return { res, cx: 0, cz: 0, extent: 1, cell: 1 / res, depth: new Float32Array(res * res), shore: new Float32Array(res * res), valid: false };
}

/**
 * Water depth at x, z for the default world: depth below the lake level inside
 * a lake basin, below sea level everywhere else (negative on land).
 */
export function makeWaterDepthFn(hf: Heightfield): (x: number, z: number) => number {
  const s = newTerrainSample();
  const lakes = hf.layout.lakes;
  const sea = hf.layout.seaLevel;
  return (x, z) => {
    hf.sample(x, z, s);
    if (s.lakeIndex >= 0 && s.lakeSd < 400) return lakes[s.lakeIndex].level - s.h;
    return sea - s.h;
  };
}

/** Sample `depthAt` at every texel centre of a res×res grid centred on (cx, cz). */
export function bakeBathymetry(depthAt: (x: number, z: number) => number, cx: number, cz: number, extent: number, res: number, out: BathyLevel = newBathyLevel(res)): BathyLevel {
  const cell = extent / res;
  const x0 = cx - extent / 2 + cell / 2;
  const z0 = cz - extent / 2 + cell / 2;
  for (let j = 0; j < res; j++) {
    const z = z0 + j * cell;
    for (let i = 0; i < res; i++) out.depth[j * res + i] = depthAt(x0 + i * cell, z);
  }
  out.res = res;
  out.cx = cx;
  out.cz = cz;
  out.extent = extent;
  out.cell = cell;
  out.valid = true;
  return out;
}

/** Bilinear sample (clamp to edge) of a level's depth or shore-distance grid. */
export function sampleBathymetry(lv: BathyLevel, x: number, z: number, channel: 'depth' | 'shore' = 'depth'): number {
  const g = channel === 'depth' ? lv.depth : lv.shore;
  const n = lv.res;
  let u = (x - (lv.cx - lv.extent / 2)) / lv.cell - 0.5;
  let v = (z - (lv.cz - lv.extent / 2)) / lv.cell - 0.5;
  u = u < 0 ? 0 : u > n - 1 ? n - 1 : u;
  v = v < 0 ? 0 : v > n - 1 ? n - 1 : v;
  const i0 = Math.min(n - 2, Math.floor(u));
  const j0 = Math.min(n - 2, Math.floor(v));
  const tu = u - i0;
  const tv = v - j0;
  const a = g[j0 * n + i0];
  const b = g[j0 * n + i0 + 1];
  const c = g[(j0 + 1) * n + i0];
  const d = g[(j0 + 1) * n + i0 + 1];
  return (a + (b - a) * tu) * (1 - tv) + (c + (d - c) * tu) * tv;
}

/**
 * Signed distance to the shoreline (depth = 0 contour), written into lv.shore:
 * sub-cell seeds where the depth changes sign between neighbours, then a
 * two-pass chamfer propagation (≤ 8 % error), + in water, clamped.
 */
export function shoreDistanceTransform(lv: BathyLevel): void {
  const n = lv.res;
  const D = lv.depth;
  const S = lv.shore;
  const cell = lv.cell;
  const INF = 1e30;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const d = D[k];
      const wet = d > 0;
      let best = INF;
      const test = (k2: number) => {
        const d2 = D[k2];
        if (d2 > 0 === wet) return;
        const t = Math.abs(d) / (Math.abs(d) + Math.abs(d2) || 1);
        if (t * cell < best) best = t * cell;
      };
      if (i > 0) test(k - 1);
      if (i < n - 1) test(k + 1);
      if (j > 0) test(k - n);
      if (j < n - 1) test(k + n);
      S[k] = best;
    }
  const a = cell;
  const b = cell * Math.SQRT2;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      let v = S[k];
      if (i > 0 && S[k - 1] + a < v) v = S[k - 1] + a;
      if (j > 0) {
        if (S[k - n] + a < v) v = S[k - n] + a;
        if (i > 0 && S[k - n - 1] + b < v) v = S[k - n - 1] + b;
        if (i < n - 1 && S[k - n + 1] + b < v) v = S[k - n + 1] + b;
      }
      S[k] = v;
    }
  for (let j = n - 1; j >= 0; j--)
    for (let i = n - 1; i >= 0; i--) {
      const k = j * n + i;
      let v = S[k];
      if (i < n - 1 && S[k + 1] + a < v) v = S[k + 1] + a;
      if (j < n - 1) {
        if (S[k + n] + a < v) v = S[k + n] + a;
        if (i < n - 1 && S[k + n + 1] + b < v) v = S[k + n + 1] + b;
        if (i > 0 && S[k + n - 1] + b < v) v = S[k + n - 1] + b;
      }
      S[k] = v;
    }
  for (let k = 0; k < n * n; k++) {
    const v = S[k] > SHORE_DIST_MAX ? SHORE_DIST_MAX : S[k];
    S[k] = D[k] > 0 ? v : -v;
  }
}

/** Interleave (depth, shore) as half floats for an RG HalfFloat texture. */
export function packBathymetryHalf(lv: BathyLevel, out: Uint16Array): Uint16Array {
  const n = lv.res * lv.res;
  for (let k = 0; k < n; k++) {
    const d = lv.depth[k];
    out[k * 2] = toHalf(d < DEPTH_MIN ? DEPTH_MIN : d > DEPTH_MAX ? DEPTH_MAX : d);
    out[k * 2 + 1] = toHalf(lv.shore[k]);
  }
  return out;
}

/** True when a level must be re-baked around the camera. */
export function levelNeedsRecentre(lv: BathyLevel, x: number, z: number, frac: number): boolean {
  if (!lv.valid) return true;
  const lim = frac * lv.extent;
  return Math.abs(x - lv.cx) > lim || Math.abs(z - lv.cz) > lim;
}

// ── Surf (mirrored exactly by the GLSL in shaders.ts) ─────────────────────────

const sat = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (a: number, b: number, x: number) => {
  const t = sat((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Distance between successive breaker lines for a surf zone of width W (m). */
export function surfBreakerSpacing(W: number): number {
  return W * 0.42;
}

/**
 * Surf foam 0..1 at a point `dist` m from the shoreline with water `depth` m,
 * time t (s), a 0..1 noise value n (breaks the lines up along the shore), surf
 * zone width W (m) and breaker period T (s). Breaker lines with trailing foam
 * travel shoreward at spacing/T; a lapping line hugs the waterline.
 */
export function surfFoam(depth: number, dist: number, t: number, n: number, W: number, T: number): number {
  if (depth < -0.35 || depth > 7 || dist > 1.25 * W) return 0;
  const zone = (1 - smoothstep(0.5 * W, 1.25 * W, dist)) * (1 - smoothstep(3.5, 7, depth)) * smoothstep(-0.35, 0.1, depth);
  const lambda = surfBreakerSpacing(W);
  const x = dist / lambda + t / T + n * 0.6;
  const ph = x - Math.floor(x);
  // sharp shoreward front at ph → 0, foam trailing seaward, patchy along the crest
  const crest = Math.exp(-ph / 0.07) * (0.35 + 0.65 * n) + Math.exp(-ph / 0.3) * 0.25;
  const lapT = t * 0.9 + n * 6.2831;
  const lap = Math.exp(-((dist / 3) ** 2)) * (0.65 + 0.35 * Math.sin(lapT));
  return sat(Math.max(crest * zone, lap * smoothstep(-0.35, 0.05, depth)));
}
