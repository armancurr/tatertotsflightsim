/** Deterministic hashing helpers for traffic schedules (pure). */
import { hash2i, mulberry32 } from '../noise';

/** Stable [0,1) value for (seed, a, b). */
export const h01 = (seed: number, a: number, b = 0): number => hash2i(a | 0, b | 0, seed | 0);

/** Stable value in [lo, hi). */
export const hRange = (seed: number, a: number, b: number, lo: number, hi: number): number => lo + (hi - lo) * h01(seed, a, b);

/** Stable pick from a list. */
export const hPick = <T>(seed: number, a: number, b: number, list: readonly T[]): T => list[Math.min(list.length - 1, Math.floor(h01(seed, a, b) * list.length))];

export { mulberry32 };

export const DEG = Math.PI / 180;
export const KT = 0.514444;
export const FT = 0.3048;
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const smooth = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Wraps an angle difference to (−180, 180]. */
export const wrap180 = (d: number): number => {
  let a = d % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return a;
};
