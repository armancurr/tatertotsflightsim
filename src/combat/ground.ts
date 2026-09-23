/**
 * PURE terrain queries for the weapons: where a (short, straight) flight segment first meets the
 * ground or water, and whether a seeker can see a target over the terrain. Both sample the same
 * `Environment` the physics and the terrain mesh use (what you see is what you hit).
 */
import type { Environment, Vec3 } from '../types';

/** Ground or water surface height at x,z (water covers the bed). */
export function surfaceHeight(env: Environment, x: number, z: number): number {
  const g = env.groundHeight(x, z);
  const w = env.waterLevel(x, z);
  return w === null || w < g ? g : w;
}

export interface SurfaceHit {
  x: number;
  y: number;
  z: number;
  /** The segment met water (not the ground). */
  water: boolean;
}

/**
 * First point where the segment (x0,y0,z0) → (x1,y1,z1) goes below the ground/water surface:
 * samples every ≤ `spacing` m, then bisects the crossing to ~1 % of a sample interval (≤ 10 cm).
 * Returns the fraction along the segment (0..1) and fills `out`, or −1 when it stays above.
 */
export function segmentSurfaceHit(env: Environment, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, out: SurfaceHit, spacing = 8): number {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!Number.isFinite(len)) return -1;
  if (y0 <= surfaceHeight(env, x0, z0)) return fill(env, x0, y0, z0, out, 0);
  const n = Math.max(1, Math.min(256, Math.ceil(len / Math.max(0.5, spacing))));
  let a = 0;
  for (let i = 1; i <= n; i++) {
    const f = i / n;
    const x = x0 + dx * f, y = y0 + dy * f, z = z0 + dz * f;
    if (y > surfaceHeight(env, x, z)) {
      a = f;
      continue;
    }
    // Bisect between a (above) and f (below).
    let lo = a;
    let hi = f;
    for (let k = 0; k < 10; k++) {
      const m = 0.5 * (lo + hi);
      if (y0 + dy * m > surfaceHeight(env, x0 + dx * m, z0 + dz * m)) lo = m;
      else hi = m;
    }
    return fill(env, x0 + dx * hi, y0 + dy * hi, z0 + dz * hi, out, hi);
  }
  return -1;
}

function fill(env: Environment, x: number, y: number, z: number, out: SurfaceHit, f: number): number {
  out.x = x;
  out.z = z;
  const g = env.groundHeight(x, z);
  const w = env.waterLevel(x, z);
  out.water = w !== null && w >= g;
  // A point on a gentle slope sits on the surface; on a cliff face keep the segment's own height.
  const s = out.water ? (w as number) : g;
  out.y = Math.min(y, s) > s - 0.5 ? s : y;
  return f;
}

/**
 * Can `from` see `to` over the terrain? Samples the line every ≤ `spacing` m (at most 160 samples),
 * ignoring the last `endMarginM` m before `to` (a target's own hull sits in its local ground bumps).
 */
export function lineOfSight(env: Environment, from: Vec3, to: Vec3, spacing = 25, endMarginM = 12): boolean {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(len > 1)) return true;
  const end = Math.max(0, 1 - endMarginM / len);
  const n = Math.max(2, Math.min(160, Math.ceil(len / Math.max(1, spacing))));
  for (let i = 1; i < n; i++) {
    const f = (i / n) * end;
    if (from.y + dy * f < surfaceHeight(env, from.x + dx * f, from.z + dz * f)) return false;
  }
  return true;
}
