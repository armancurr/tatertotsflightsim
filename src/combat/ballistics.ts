/**
 * PURE exterior ballistics of the gun rounds: gravity + quadratic drag
 *
 *     a = g − k·(ρ/ρ₀)·|v|·v          (k = GunConfig.dragK at sea level)
 *
 * integrated with classic RK4 (the acceleration depends only on the velocity, with the density held
 * at the step's start height). RK4 is exact for constant acceleration and ~1e-6 accurate here for
 * any step up to 1/20 s — so the CCIP (coarse steps) lands where the fired rounds (frame-sized
 * steps) really land. Allocation-free: callers pass a mutable state.
 */
import { CONFIG } from '../config';
import { airDensity } from '../physics/atmosphere';

export interface Ballistic {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

export const newBallistic = (): Ballistic => ({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 });

const RHO0 = CONFIG.sim.seaLevelDensity;

/** ρ/ρ₀ at a height MSL (ISA). */
export function densityRatioAt(y: number): number {
  return airDensity(y) / RHO0;
}

/** Longest single RK4 step, s (longer requests are split). */
const MAX_STEP = 0.1;

/**
 * Advance one round by dt seconds (split into ≤ 0.1 s RK4 steps). dragK in 1/m at sea level.
 * Non-finite dt / dragK are treated as 0 so a bad frame can never poison the state.
 */
export function stepBallistic(b: Ballistic, dtIn: number, dragKIn: number, gravity: number = CONFIG.sim.gravity): void {
  let dt = Number.isFinite(dtIn) && dtIn > 0 ? Math.min(dtIn, 10) : 0;
  const k0 = Number.isFinite(dragKIn) && dragKIn > 0 ? dragKIn : 0;
  const g = Number.isFinite(gravity) ? gravity : 0;
  while (dt > 1e-12) {
    const h = dt > MAX_STEP ? MAX_STEP : dt;
    dt -= h;
    const k = k0 > 0 ? k0 * densityRatioAt(b.y) : 0;
    const vx = b.vx, vy = b.vy, vz = b.vz;
    // k1
    let s = k * Math.sqrt(vx * vx + vy * vy + vz * vz);
    const a1x = -s * vx, a1y = -g - s * vy, a1z = -s * vz;
    // k2
    const v2x = vx + 0.5 * h * a1x, v2y = vy + 0.5 * h * a1y, v2z = vz + 0.5 * h * a1z;
    s = k * Math.sqrt(v2x * v2x + v2y * v2y + v2z * v2z);
    const a2x = -s * v2x, a2y = -g - s * v2y, a2z = -s * v2z;
    // k3
    const v3x = vx + 0.5 * h * a2x, v3y = vy + 0.5 * h * a2y, v3z = vz + 0.5 * h * a2z;
    s = k * Math.sqrt(v3x * v3x + v3y * v3y + v3z * v3z);
    const a3x = -s * v3x, a3y = -g - s * v3y, a3z = -s * v3z;
    // k4
    const v4x = vx + h * a3x, v4y = vy + h * a3y, v4z = vz + h * a3z;
    s = k * Math.sqrt(v4x * v4x + v4y * v4y + v4z * v4z);
    const a4x = -s * v4x, a4y = -g - s * v4y, a4z = -s * v4z;

    b.x += (h / 6) * (vx + 2 * v2x + 2 * v3x + v4x);
    b.y += (h / 6) * (vy + 2 * v2y + 2 * v3y + v4y);
    b.z += (h / 6) * (vz + 2 * v2z + 2 * v3z + v4z);
    let nvx = vx + (h / 6) * (a1x + 2 * a2x + 2 * a3x + a4x);
    let nvy = vy + (h / 6) * (a1y + 2 * a2y + 2 * a3y + a4y);
    let nvz = vz + (h / 6) * (a1z + 2 * a2z + 2 * a3z + a4z);
    // Drag can never reverse the velocity (guards absurd k·|v|·h ≫ 1 inputs).
    if (nvx * vx < 0) nvx = 0;
    if (nvz * vz < 0) nvz = 0;
    if (g === 0 && nvy * vy < 0) nvy = 0;
    b.vx = nvx;
    b.vy = nvy;
    b.vz = nvz;
  }
}

/**
 * Fly a round in steps of dt until `stop(b, t)` or maxT; returns the time flown (s).
 * (Tests and offline tools; the live rounds step per frame.)
 */
export function flyUntil(b: Ballistic, dt: number, dragK: number, stop: (b: Ballistic, t: number) => boolean, maxT: number): number {
  let t = 0;
  const h = Number.isFinite(dt) && dt > 0 ? dt : 1 / 60;
  while (t < maxT && !stop(b, t)) {
    stepBallistic(b, h, dragK);
    t += h;
  }
  return t;
}
