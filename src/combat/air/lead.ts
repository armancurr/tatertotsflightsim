/**
 * Gun lead on an aircraft (PURE): where to put the gun cross so the rounds meet a target flying at
 * constant velocity — the classic "lead computing" pipper, simplified. The rounds leave the muzzle
 * at the muzzle velocity plus the shooter's velocity and slow down with the gun's quadratic drag;
 * they drop under gravity. Solved by fixed-point iteration on the time of flight t:
 *
 *   P(t) = D + (Vt − Vs)·t              (target relative to the shooter, which keeps flying)
 *   A(t) = P(t) + ½·g·t²·ŷ              (aim above it by the drop)
 *   w0 = u + Vs·Â                       (the round's airspeed at the muzzle)
 *   S(t) = ln(1 + k·w0·t)/k − (Vs·Â)·t  (how far ahead of the shooter the round is after t)
 *   t ← the t with S(t) = |P(t)|        (Newton)
 *
 * With k = 0 and g = 0 this is the exact constant-velocity intercept |D + Vr·t| = u·t.
 */
import type { Vec3 } from '../../types';

export interface LeadSolution {
  ok: boolean;
  /** Aim point (world): muzzle + A — put the gun cross on it. */
  x: number;
  y: number;
  z: number;
  /** Time of flight, s, and the range at the meeting point, m. */
  tof: number;
  rangeM: number;
}

export const newLead = (): LeadSolution => ({ ok: false, x: 0, y: 0, z: 0, tof: 0, rangeM: 0 });

const fin = Number.isFinite;

/** Round distance ahead of the shooter after t (see header). */
function sRel(t: number, k: number, w0: number, c: number): number {
  if (k <= 0) return (w0 - c) * t;
  return Math.log1p(k * w0 * t) / k - c * t;
}
function sRelDt(t: number, k: number, w0: number, c: number): number {
  if (k <= 0) return w0 - c;
  return w0 / (1 + k * w0 * t) - c;
}

export function gunLead(
  out: LeadSolution, muzzle: Vec3, shooterVel: Vec3, target: Vec3, targetVel: Vec3, muzzleVelocity: number,
  dragK = 0, gravity = 9.80665, densityRatio = 1, maxTofS = 4,
): LeadSolution {
  out.ok = false;
  const u = muzzleVelocity;
  if (!(fin(u) && u > 1)) return out;
  const Dx = target.x - muzzle.x, Dy = target.y - muzzle.y, Dz = target.z - muzzle.z;
  const vrx = targetVel.x - shooterVel.x, vry = targetVel.y - shooterVel.y, vrz = targetVel.z - shooterVel.z;
  if (!(fin(Dx) && fin(Dy) && fin(Dz) && fin(vrx) && fin(vry) && fin(vrz) && fin(shooterVel.x) && fin(shooterVel.y) && fin(shooterVel.z))) return out;
  const k = fin(dragK) && dragK > 0 ? dragK * (fin(densityRatio) && densityRatio > 0 ? densityRatio : 1) : 0;
  const g = fin(gravity) ? gravity : 0;
  let t = Math.hypot(Dx, Dy, Dz) / u;
  let Px = Dx, Py = Dy, Pz = Dz, Ax = Dx, Ay = Dy, Az = Dz;
  for (let it = 0; it < 8; it++) {
    Px = Dx + vrx * t;
    Py = Dy + vry * t;
    Pz = Dz + vrz * t;
    Ax = Px;
    Ay = Py + 0.5 * g * t * t;
    Az = Pz;
    const al = Math.hypot(Ax, Ay, Az);
    if (!(al > 1e-6)) return out;
    const c = (shooterVel.x * Ax + shooterVel.y * Ay + shooterVel.z * Az) / al;
    const w0 = u + c;
    if (!(w0 > 1)) return out;
    // Newton on S(τ) = |P(τ)| (P re-evaluated inside for the moving target).
    let tau = t;
    for (let n = 0; n < 4; n++) {
      const qx = Dx + vrx * tau, qy = Dy + vry * tau, qz = Dz + vrz * tau;
      const R = Math.hypot(qx, qy, qz);
      const dR = R > 1e-9 ? (qx * vrx + qy * vry + qz * vrz) / R : 0;
      const f = sRel(tau, k, w0, c) - R;
      const df = sRelDt(tau, k, w0, c) - dR;
      if (!(Math.abs(df) > 1e-9)) break;
      tau = Math.max(0, tau - f / df);
    }
    if (!fin(tau) || tau > maxTofS) return out;
    const done = Math.abs(tau - t) < 1e-5;
    t = tau;
    if (done) break;
  }
  Px = Dx + vrx * t;
  Py = Dy + vry * t;
  Pz = Dz + vrz * t;
  out.x = muzzle.x + Px;
  out.y = muzzle.y + Py + 0.5 * g * t * t;
  out.z = muzzle.z + Pz;
  out.tof = t;
  out.rangeM = Math.hypot(Px, Py, Pz);
  out.ok = fin(out.x) && fin(out.y) && fin(out.z) && t > 0;
  return out;
}
