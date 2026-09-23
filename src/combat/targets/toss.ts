/**
 * The T-72 "jack-in-the-box": when the carousel autoloader's charges cook off, the turret is
 * blown off the hull, flies 5–25 m up tumbling, and lands beside the wreck (upside down or on
 * its side). A ballistic flight with a constant tumble, then at rest. PURE (three's maths only).
 */
import * as THREE from 'three';

export interface TurretToss {
  /** Launch time (the caller's clock), position (turret ring centre) and velocity. */
  t0: number;
  p0: THREE.Vector3;
  v0: THREE.Vector3;
  /** Initial orientation, tumble axis (unit) and rate (rad/s). */
  q0: THREE.Quaternion;
  axis: THREE.Vector3;
  spin: number;
  /** Flight time and where/how it comes to rest. */
  flightS: number;
  rest: THREE.Vector3;
  restQ: THREE.Quaternion;
}

const G = 9.81;

/**
 * Plan a toss from the turret ring at p0 (orientation q0). `apex` = height gained (m), rnd = PRNG,
 * `groundAt` = terrain height. The turret rests `restLift` m above the ground (it lies on its roof).
 */
export function planToss(t0: number, p0: THREE.Vector3, q0: THREE.Quaternion, apex: number, rnd: () => number, groundAt: (x: number, z: number) => number, restLift = 0.45): TurretToss {
  const h = Math.max(0.5, Number.isFinite(apex) ? apex : 10);
  const vy = Math.sqrt(2 * G * h);
  // horizontal: 1.5–5 m/s in a random direction, capped so it lands within ~25 m
  const ang = rnd() * Math.PI * 2;
  let vh = 1.5 + 3.5 * rnd();
  const g0 = groundAt(p0.x, p0.z);
  // time to fall back to the ground (flat-ground estimate, refined below)
  const drop = Math.max(0, p0.y - (g0 + restLift));
  let T = (vy + Math.sqrt(vy * vy + 2 * G * drop)) / G;
  vh = Math.min(vh, 24 / T);
  const v0 = new THREE.Vector3(Math.cos(ang) * vh, vy, Math.sin(ang) * vh);
  for (let it = 0; it < 4; it++) {
    const gx = p0.x + v0.x * T;
    const gz = p0.z + v0.z * T;
    const d = Math.max(0, p0.y - (groundAt(gx, gz) + restLift));
    T = (vy + Math.sqrt(vy * vy + 2 * G * d)) / G;
  }
  const axis = new THREE.Vector3(rnd() - 0.5, (rnd() - 0.5) * 0.4, rnd() - 0.5);
  if (axis.lengthSq() < 1e-6) axis.set(1, 0, 0);
  axis.normalize();
  const spin = 2.5 + 5 * rnd();
  const rest = new THREE.Vector3(p0.x + v0.x * T, 0, p0.z + v0.z * T);
  rest.y = groundAt(rest.x, rest.z) + restLift;
  // upside down (roof on the ground, 70 %) or on its side, at a random yaw
  const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * Math.PI * 2);
  const flip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), rnd() < 0.7 ? Math.PI : Math.PI / 2 + 0.25);
  const restQ = yaw.multiply(flip);
  return { t0, p0: p0.clone(), v0, q0: q0.clone(), axis, spin, flightS: T, rest, restQ };
}

const tmpQ = new THREE.Quaternion();

/** Pose at time t (writes pos/quat); returns true once it has landed. */
export function tossPose(s: TurretToss, t: number, pos: THREE.Vector3, quat: THREE.Quaternion): boolean {
  const dt = Math.max(0, t - s.t0);
  if (dt >= s.flightS) {
    pos.copy(s.rest);
    quat.copy(s.restQ);
    return true;
  }
  pos.set(s.p0.x + s.v0.x * dt, s.p0.y + s.v0.y * dt - 0.5 * G * dt * dt, s.p0.z + s.v0.z * dt);
  // blend toward the rest pose over the last 0.35 s so it settles instead of snapping
  const f = dt / s.flightS;
  tmpQ.setFromAxisAngle(s.axis, s.spin * dt);
  quat.copy(s.q0).premultiply(tmpQ);
  const k = Math.max(0, (dt - (s.flightS - 0.35)) / 0.35);
  if (k > 0) {
    quat.slerp(s.restQ, k);
    pos.y = Math.max(pos.y, s.rest.y * k + pos.y * (1 - k));
  }
  if (!(f >= 0)) pos.copy(s.p0);
  return false;
}
