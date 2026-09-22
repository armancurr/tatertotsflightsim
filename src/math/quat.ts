import type { Quat, Vec3 } from '../types';

/** Minimal immutable quaternion helpers. Same component layout as three.js Quaternion (x, y, z, w). */
export const qIdentity = (): Quat => ({ x: 0, y: 0, z: 0, w: 1 });
export const qClone = (q: Quat): Quat => ({ x: q.x, y: q.y, z: q.z, w: q.w });

/** Hamilton product a·b (apply b first, then a). */
export const qMul = (a: Quat, b: Quat): Quat => ({
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
});

export const qConj = (q: Quat): Quat => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });

export const qNormalize = (q: Quat): Quat => {
  const l = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
  return l > 1e-12 ? { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l } : qIdentity();
};

export const qFromAxisAngle = (axis: Vec3, angle: number): Quat => {
  const h = angle / 2;
  const s = Math.sin(h);
  return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(h) };
};

/** Rotate vector v by unit quaternion q (q·v·q*). */
export const qRotate = (q: Quat, v: Vec3): Vec3 => {
  // t = 2 * cross(q.xyz, v); v' = v + w*t + cross(q.xyz, t)
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
};

/** Rotate v by the inverse of unit quaternion q (world → body when q is body → world). */
export const qRotateInverse = (q: Quat, v: Vec3): Vec3 => qRotate(qConj(q), v);

/**
 * Integrate orientation by a BODY-frame angular velocity ω over dt.
 * dq/dt = ½ q ⊗ (ω, 0). Uses the exact rotation for the step, then renormalises.
 */
export const qIntegrateBody = (q: Quat, omegaBody: Vec3, dt: number): Quat => {
  const wx = omegaBody.x, wy = omegaBody.y, wz = omegaBody.z;
  const mag = Math.sqrt(wx * wx + wy * wy + wz * wz);
  if (mag < 1e-12) return q;
  const angle = mag * dt;
  const dq = qFromAxisAngle({ x: wx / mag, y: wy / mag, z: wz / mag }, angle);
  return qNormalize(qMul(q, dq));
};

/** Spherical linear interpolation. */
export const qSlerp = (a: Quat, b: Quat, t: number): Quat => {
  let bx = b.x, by = b.y, bz = b.z, bw = b.w;
  let cos = a.x * bx + a.y * by + a.z * bz + a.w * bw;
  if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  if (cos > 0.9995) {
    return qNormalize({ x: a.x + (bx - a.x) * t, y: a.y + (by - a.y) * t, z: a.z + (bz - a.z) * t, w: a.w + (bw - a.w) * t });
  }
  const theta = Math.acos(cos);
  const sin = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sin;
  const wb = Math.sin(t * theta) / sin;
  return { x: a.x * wa + bx * wb, y: a.y * wa + by * wb, z: a.z * wa + bz * wb, w: a.w * wa + bw * wb };
};
