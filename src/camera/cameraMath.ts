/**
 * Small pure helpers for the camera rig (no three.js). Camera orientations follow the three.js
 * camera convention: the camera looks down its local -Z with +Y up — the same as the aircraft
 * body frame, so body orientations can be used for the cockpit directly.
 */
import type { Quat, Vec3 } from '../types';

const WORLD_UP: Vec3 = { x: 0, y: 1, z: 0 };

/** Quaternion from an orthonormal basis given as the columns (x, y, z) of a rotation matrix. */
export function quatFromBasis(x: Vec3, y: Vec3, z: Vec3): Quat {
  const m11 = x.x, m12 = y.x, m13 = z.x;
  const m21 = x.y, m22 = y.y, m23 = z.y;
  const m31 = x.z, m32 = y.z, m33 = z.z;
  const trace = m11 + m22 + m33;
  let qx: number, qy: number, qz: number, qw: number;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    qw = 0.25 / s;
    qx = (m32 - m23) * s;
    qy = (m13 - m31) * s;
    qz = (m21 - m12) * s;
  } else if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    qw = (m32 - m23) / s;
    qx = 0.25 * s;
    qy = (m12 + m21) / s;
    qz = (m13 + m31) / s;
  } else if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    qw = (m13 - m31) / s;
    qx = (m12 + m21) / s;
    qy = 0.25 * s;
    qz = (m23 + m32) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
    qw = (m21 - m12) / s;
    qx = (m13 + m31) / s;
    qy = (m23 + m32) / s;
    qz = 0.25 * s;
  }
  const l = Math.hypot(qx, qy, qz, qw) || 1;
  return { x: qx / l, y: qy / l, z: qz / l, w: qw / l };
}

/**
 * Camera orientation looking along `forward` with `up` as the preferred up direction (no roll).
 * Looking straight up/down, "up" on screen becomes north. A zero `forward` returns `fallback`
 * (identity by default). Never returns NaN.
 */
export function lookRotation(forward: Vec3, up: Vec3 = WORLD_UP, fallback: Quat = { x: 0, y: 0, z: 0, w: 1 }): Quat {
  const fl = Math.hypot(forward.x, forward.y, forward.z);
  if (!(fl > 1e-9) || !Number.isFinite(fl)) return { ...fallback };
  // Camera +Z points backwards (away from what it looks at).
  const zx = -forward.x / fl, zy = -forward.y / fl, zz = -forward.z / fl;
  // x = up × z
  let xx = up.y * zz - up.z * zy;
  let xy = up.z * zx - up.x * zz;
  let xz = up.x * zy - up.y * zx;
  let xl = Math.hypot(xx, xy, xz);
  if (xl < 1e-6) {
    // Looking along `up`: use north (-Z) as the up direction instead.
    const ax = 0, ay = 0, az = -1;
    xx = ay * zz - az * zy;
    xy = az * zx - ax * zz;
    xz = ax * zy - ay * zx;
    xl = Math.hypot(xx, xy, xz);
    if (xl < 1e-6) return { ...fallback };
  }
  xx /= xl; xy /= xl; xz /= xl;
  // y = z × x
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  return quatFromBasis({ x: xx, y: xy, z: xz }, { x: yx, y: yy, z: yz }, { x: zx, y: zy, z: zz });
}

/** Wrap radians into (-π, π]. */
export function wrapPi(a: number): number {
  const t = (a + Math.PI) % (2 * Math.PI);
  return (t <= 0 ? t + 2 * Math.PI : t) - Math.PI;
}

/**
 * One exact step of a critically damped spring toward a fixed target (frame-rate independent).
 * omega = stiffness (1/s). Returns [position, velocity].
 */
export function springStep(x: number, v: number, target: number, omega: number, dt: number): [number, number] {
  if (!(dt > 0)) return [x, v];
  if (!(omega > 0)) return [target, 0];
  const e = x - target;
  const ex = Math.exp(-omega * dt);
  const tmp = (v + omega * e) * dt;
  return [target + (e + tmp) * ex, (v - omega * tmp) * ex];
}

/** Unit direction for an azimuth (radians, clockwise from north like a heading) and elevation (radians, + up). */
export function dirFromAngles(azimuth: number, elevation: number): Vec3 {
  const ce = Math.cos(elevation);
  return { x: Math.sin(azimuth) * ce, y: Math.sin(elevation), z: -Math.cos(azimuth) * ce };
}

/** Ease-in-out (smoothstep) on [0, 1]. */
export function easeInOut(t: number): number {
  const u = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return u * u * (3 - 2 * u);
}
