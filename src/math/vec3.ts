import type { Vec3 } from '../types';

/** Minimal immutable 3-vector helpers (plain objects, compatible with three.js Vector3.copy). */
export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const vClone = (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: a.z });
export const vAdd = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const vSub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const vScale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
/** a + b·s */
export const vAddScaled = (a: Vec3, b: Vec3, s: number): Vec3 => ({ x: a.x + b.x * s, y: a.y + b.y * s, z: a.z + b.z * s });
export const vDot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const vCross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const vLength = (a: Vec3): number => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
export const vLengthSq = (a: Vec3): number => a.x * a.x + a.y * a.y + a.z * a.z;
export const vNormalize = (a: Vec3): Vec3 => {
  const l = vLength(a);
  return l > 1e-12 ? { x: a.x / l, y: a.y / l, z: a.z / l } : { x: 0, y: 0, z: 0 };
};
export const vLerp = (a: Vec3, b: Vec3, t: number): Vec3 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
});
export const vDistance = (a: Vec3, b: Vec3): number => vLength(vSub(a, b));
/** Component-wise multiply. */
export const vMul = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x * b.x, y: a.y * b.y, z: a.z * b.z });

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Move `current` toward `target` by at most `maxDelta`. */
export const moveToward = (current: number, target: number, maxDelta: number): number =>
  Math.abs(target - current) <= maxDelta ? target : current + Math.sign(target - current) * maxDelta;
/** Frame-rate independent exponential approach: fraction of the gap closed in dt with time constant tau. */
export const expApproach = (current: number, target: number, tau: number, dt: number): number =>
  tau <= 0 ? target : target + (current - target) * Math.exp(-dt / tau);
/** Wrap degrees into [0, 360). */
export const wrap360 = (deg: number): number => ((deg % 360) + 360) % 360;
/** Wrap degrees into (-180, 180]. */
export const wrap180 = (deg: number): number => {
  const d = wrap360(deg);
  return d > 180 ? d - 360 : d;
};
