/**
 * The single source of truth for frame conventions (see the header of src/types.ts).
 * Every module converts between world, body and aircraft-convention quantities
 * through these helpers — never by hand.
 */
import type { Quat, Vec3 } from '../types';
import { qFromAxisAngle, qMul, qRotate, qRotateInverse } from '../math/quat';
import { wrap360 } from '../math/vec3';

const DEG = Math.PI / 180;

/** Body axes expressed in the body frame. */
export const BODY_FORWARD: Vec3 = { x: 0, y: 0, z: -1 };
export const BODY_RIGHT: Vec3 = { x: 1, y: 0, z: 0 };
export const BODY_UP: Vec3 = { x: 0, y: 1, z: 0 };

/** Build the body→world orientation from heading/pitch/roll in degrees (roll + = right wing down). */
export function quatFromEuler(headingDeg: number, pitchDeg: number, rollDeg: number): Quat {
  const qYaw = qFromAxisAngle({ x: 0, y: 1, z: 0 }, -headingDeg * DEG);
  const qPitch = qFromAxisAngle({ x: 1, y: 0, z: 0 }, pitchDeg * DEG);
  const qRoll = qFromAxisAngle({ x: 0, y: 0, z: 1 }, -rollDeg * DEG);
  return qMul(qMul(qYaw, qPitch), qRoll);
}

export interface Euler {
  /** 0..360, clockwise from north. */
  headingDeg: number;
  /** + nose up. */
  pitchDeg: number;
  /** + right wing down, -180..180. */
  rollDeg: number;
}

/** Heading/pitch/roll in degrees from the body→world orientation. */
export function eulerFromQuat(q: Quat): Euler {
  const f = qRotate(q, BODY_FORWARD);
  const r = qRotate(q, BODY_RIGHT);
  const u = qRotate(q, BODY_UP);
  const pitch = Math.asin(Math.max(-1, Math.min(1, f.y)));
  let heading: number;
  if (Math.abs(f.y) < 0.9999) {
    heading = Math.atan2(f.x, -f.z);
  } else {
    // Pointing straight up/down: heading is ill-defined, use the up vector's horizontal direction.
    heading = Math.atan2(-u.x * Math.sign(f.y), u.z * Math.sign(f.y));
  }
  const roll = Math.atan2(-r.y, u.y);
  return { headingDeg: wrap360(heading / DEG), pitchDeg: pitch / DEG, rollDeg: roll / DEG };
}

/** Forward / right / up unit vectors of the aircraft in world space. */
export function bodyAxesWorld(q: Quat): { forward: Vec3; right: Vec3; up: Vec3 } {
  return { forward: qRotate(q, BODY_FORWARD), right: qRotate(q, BODY_RIGHT), up: qRotate(q, BODY_UP) };
}

export const worldToBody = (q: Quat, v: Vec3): Vec3 => qRotateInverse(q, v);
export const bodyToWorld = (q: Quat, v: Vec3): Vec3 => qRotate(q, v);

export interface AirData {
  /** Airspeed magnitude, m/s. */
  V: number;
  /** Forward, rightward and downward components of the air-relative velocity in the body frame. */
  u: number;
  v: number;
  w: number;
  /** Angle of attack, rad (+ nose above the flight path). */
  alpha: number;
  /** Sideslip, rad (+ air arriving from the right). */
  beta: number;
}

/**
 * Air data from the body-frame velocity of the aircraft relative to the air
 * (i.e. worldToBody(q, velocity - wind)).
 */
export function airDataFromBodyVelocity(vb: Vec3): AirData {
  const u = -vb.z;
  const v = vb.x;
  const w = -vb.y;
  const V = Math.sqrt(u * u + v * v + w * w);
  const alpha = Math.atan2(w, u);
  const beta = V > 1e-6 ? Math.asin(Math.max(-1, Math.min(1, v / V))) : 0;
  return { V, u, v, w, alpha, beta };
}

/** Aircraft-convention body rates (p roll, q pitch, r yaw) from the body angular velocity vector. */
export function pqrFromOmega(omegaBody: Vec3): { p: number; q: number; r: number } {
  return { p: -omegaBody.z, q: omegaBody.x, r: -omegaBody.y };
}

/** Body angular velocity vector from aircraft-convention rates. */
export function omegaFromPqr(p: number, q: number, r: number): Vec3 {
  return { x: q, y: -r, z: -p };
}

/** Body-frame torque vector from aircraft-convention moments (L roll, M pitch, N yaw). */
export function torqueFromLMN(L: number, M: number, N: number): Vec3 {
  return { x: M, y: -N, z: -L };
}

/** Aircraft-convention moments from a body-frame torque vector. */
export function lmnFromTorque(t: Vec3): { L: number; M: number; N: number } {
  return { L: -t.z, M: t.x, N: -t.y };
}
