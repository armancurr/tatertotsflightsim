/**
 * PURE: what the gun looks like this frame, written into a GlowSink — every tracer round as a
 * red-orange HDR streak stretched back along its velocity over `STREAK_S` (the eye's/camera's
 * motion blur at 60 fps), burning out after ~3 s; and, while firing, the flickering muzzle flash
 * (a bright core at the muzzle + a short flame tongue along the gun line).
 */
import type { Vec3 } from '../../types';
import type { RoundPool } from '../rounds';
import { ROUND_TRACER } from '../rounds';
import type { GlowSink } from './glow';

/** Streak length in seconds of flight, capped in metres. */
export const STREAK_S = 1 / 60;
export const STREAK_MAX_M = 22;
/** Tracer compound burn time: full brightness until BURN_S, gone at BURN_END_S. */
export const BURN_S = 2.6;
export const BURN_END_S = 3.4;
/** Linear HDR radiance of a tracer core (red-orange strontium flare) and the flash (yellow-white). */
export const TRACER_RGB = [18, 3.6, 0.55] as const;
export const FLASH_RGB = [9, 5.2, 1.8] as const;
const TRACER_WIDTH_M = 0.18;

/** Writes every live tracer; returns how many were written. */
export function writeTracers(pool: RoundPool, sink: GlowSink): number {
  let n = 0;
  for (let k = 0; k < pool.count; k++) {
    const i = pool.idx[k];
    if (!(pool.flags[i] & ROUND_TRACER)) continue;
    const age = pool.age[i];
    if (age >= BURN_END_S) continue;
    const burn = age <= BURN_S ? 1 : 1 - (age - BURN_S) / (BURN_END_S - BURN_S);
    const vx = pool.vx[i], vy = pool.vy[i], vz = pool.vz[i];
    const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
    const len = Math.min(sp * STREAK_S, STREAK_MAX_M);
    const k2 = sp > 1e-6 ? len / sp : 0;
    const x = pool.x[i], y = pool.y[i], z = pool.z[i];
    if (!sink.add(x, y, z, x - vx * k2, y - vy * k2, z - vz * k2, TRACER_WIDTH_M, burn, TRACER_RGB[0], TRACER_RGB[1], TRACER_RGB[2], 1)) break;
    n++;
  }
  return n;
}

/**
 * Muzzle flash at `muzzle` along `dir` (unit), flicker 0..1 (a fresh random number each frame).
 * `aircraftVel` makes the flame tongue trail slightly the way the air carries it.
 */
export function writeMuzzleFlash(sink: GlowSink, muzzle: Vec3, dir: Vec3, flicker: number, scale = 1): void {
  const f = 0.55 + 0.45 * flicker;
  const L = (1.6 + 1.6 * flicker) * scale;
  // Core: a ball of fire at the muzzle.
  sink.add(muzzle.x + dir.x * 0.35, muzzle.y + dir.y * 0.35, muzzle.z + dir.z * 0.35, muzzle.x, muzzle.y, muzzle.z, 0.9 * scale * f, 1.3 * f, FLASH_RGB[0], FLASH_RGB[1], FLASH_RGB[2], -1);
  // Tongue: the propellant gas burning ahead of the barrel.
  sink.add(muzzle.x + dir.x * L, muzzle.y + dir.y * L, muzzle.z + dir.z * L, muzzle.x, muzzle.y, muzzle.z, 0.55 * scale, 0.9 * f, FLASH_RGB[0], FLASH_RGB[1] * 0.85, FLASH_RGB[2] * 0.6, -1);
}
