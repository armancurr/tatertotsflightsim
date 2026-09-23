/**
 * PURE gun CCIP ("continuously computed impact point"): where a round fired NOW would hit the ground,
 * for the HUD pipper. It flies the same ballistic model as the live rounds (ballistics.ts, RK4) from
 * the muzzle with the aircraft's velocity + the muzzle velocity along the gun line, in coarse steps,
 * and tests each step against the terrain/water like the rounds do (ground.ts). No solution (null)
 * when the round doesn't reach the ground within `maxTimeS` / `maxRangeM`.
 */
import type { Environment } from '../types';
import { newBallistic, stepBallistic } from './ballistics';
import { segmentSurfaceHit, surfaceHeight, type SurfaceHit } from './ground';

export interface CcipSolution {
  x: number;
  y: number;
  z: number;
  /** Slant range from the muzzle, m. */
  range: number;
  /** Time of flight, s. */
  time: number;
  water: boolean;
}

export const newCcip = (): CcipSolution => ({ x: 0, y: 0, z: 0, range: 0, time: 0, water: false });

export interface CcipOptions {
  /** Integration step, s. */
  dt?: number;
  maxTimeS?: number;
  maxRangeM?: number;
}

/** Steepest terrain assumed when skipping ground tests high above it (rise per horizontal metre). */
export const TERRAIN_SLOPE_BOUND = 1.5;

const B = newBallistic();
const HIT: SurfaceHit = { x: 0, y: 0, z: 0, water: false };

/**
 * Solve the CCIP for a round leaving (mx,my,mz) with world velocity (vx,vy,vz) and drag dragK.
 * Returns true and fills `out`, or false when there is no ground impact within the limits.
 */
export function computeCcip(env: Environment, mx: number, my: number, mz: number, vx: number, vy: number, vz: number, dragK: number, out: CcipSolution, opts: CcipOptions = {}): boolean {
  const dt = opts.dt ?? 0.05;
  const maxT = opts.maxTimeS ?? 4;
  const maxR = opts.maxRangeM ?? 5000;
  if (!Number.isFinite(mx + my + mz + vx + vy + vz)) return false;
  B.x = mx; B.y = my; B.z = mz; B.vx = vx; B.vy = vy; B.vz = vz;
  let t = 0;
  let nextCheck = 0;
  while (t < maxT - 1e-9) {
    const x0 = B.x, y0 = B.y, z0 = B.z;
    const h = Math.min(dt, maxT - t);
    stepBallistic(B, h, dragK);
    t += h;
    if (t >= nextCheck) {
      const f = segmentSurfaceHit(env, x0, y0, z0, B.x, B.y, B.z, HIT, 8);
      if (f >= 0) {
        const range = Math.hypot(HIT.x - mx, HIT.y - my, HIT.z - mz);
        if (range > maxR) return false;
        out.x = HIT.x; out.y = HIT.y; out.z = HIT.z;
        out.range = range;
        out.time = t - h + h * f;
        out.water = HIT.water;
        return true;
      }
      // Skip ground tests until the round could possibly reach terrain rising at the slope bound.
      const c = B.y - surfaceHeight(env, B.x, B.z);
      const closing = TERRAIN_SLOPE_BOUND * Math.hypot(B.vx, B.vz) + Math.max(0, -B.vy) + 1;
      nextCheck = t + Math.max(0, (c - 3) / closing);
    }
    if (Math.hypot(B.x - mx, B.y - my, B.z - mz) > maxR + 50) return false;
  }
  return false;
}
