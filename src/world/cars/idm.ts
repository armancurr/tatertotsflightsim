/**
 * Longitudinal vehicle kinematics (PURE): the Intelligent Driver Model
 * (Treiber, Hennecke & Helbing 2000) — smooth acceleration to the desired
 * speed, a safe time gap to the vehicle ahead, and comfortable braking that
 * escalates only when a situation demands it — plus braking envelopes.
 */

export interface IdmParams {
  /** Desired time gap, s. */
  T: number;
  /** Jam (standstill) gap, m. */
  s0: number;
  /** Maximum comfortable acceleration / deceleration, m/s². */
  a: number;
  b: number;
  /** Hard limit on braking, m/s². */
  maxDecel: number;
}

/**
 * Acceleration of a vehicle at speed v wanting v0, with a bumper-to-bumper gap
 * `gap` (Infinity = free road) to a leader approached at dv = v − vLeader.
 */
export function idmAccel(v: number, v0: number, gap: number, dv: number, p: IdmParams): number {
  const vd = Math.max(0.1, v0);
  const r = v / vd;
  const r2 = r * r;
  let acc = p.a * (1 - r2 * r2);
  if (gap < Infinity) {
    const g = Math.max(0.05, gap);
    const sStar = p.s0 + Math.max(0, v * p.T + (v * dv) / (2 * Math.sqrt(p.a * p.b)));
    const q = sStar / g;
    acc -= p.a * q * q;
  }
  if (!(acc === acc)) return -p.maxDecel;
  return acc < -p.maxDecel ? -p.maxDecel : acc > p.a ? p.a : acc;
}

/** Highest speed from which `vTarget` can still be reached `dist` metres ahead braking at b. */
export function approachSpeed(vTarget: number, dist: number, b: number): number {
  return Math.sqrt(vTarget * vTarget + 2 * b * Math.max(0, dist));
}
