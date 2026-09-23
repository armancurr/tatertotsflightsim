/**
 * Gun recoil. Pure.
 *
 * While rounds are leaving the gun (`controls.gunFiring`, set by the weapons system) an aircraft that
 * carries one (`cfg.weapons.gun`) is pushed back with `gun.recoilN` along the barrel — body +Z, tilted
 * up by the gun-line depression `boresightDownDeg` (the barrel points that far below the nose, so its
 * recoil points that far above the tail) — applied at `gun.muzzle`. The moment arm gives the real
 * aircraft's small trim changes:
 *
 *   A-10C GAU-8/A  45 kN (≈ one TF34 at full power) on the centreline, 0.55 m below the CG, gun line
 *                  2° down: the line of action passes ~0.3 m below the CG → ~13 kN·m nose-down,
 *                  no yaw, no roll (the firing barrel is on the centreline for exactly that reason).
 *                  2 s burst: ΔV ≈ F·t/m ≈ 5.6 m/s ≈ 11 kt at 16 t.
 *   F-16C M61A1    18 kN in the left strake root, 0.6 m left of the centreline → ~11 kN·m nose-left.
 *
 * Returns the force (N) and torque about the CG (N·m) in the BODY frame; zero when not firing or unarmed.
 */
import type { Config } from '../config';

const DEG = Math.PI / 180;

/** A force and a torque about the CG, body frame. */
export interface BodyWrench {
  fx: number;
  fy: number;
  fz: number;
  tx: number;
  ty: number;
  tz: number;
}

const NONE: BodyWrench = Object.freeze({ fx: 0, fy: 0, fz: 0, tx: 0, ty: 0, tz: 0 });

/** Recoil wrench of the aircraft's gun this step (a shared frozen zero when not firing — no allocation). */
export function gunRecoil(gunFiring: boolean | undefined, cfg: Config): BodyWrench {
  const gun = gunFiring === true ? cfg.weapons?.gun : null;
  if (!gun || !(gun.recoilN > 0)) return NONE;
  const dep = (Number.isFinite(gun.boresightDownDeg) ? gun.boresightDownDeg : 0) * DEG;
  // Barrel direction d = (0, −sin dep, −cos dep) (forward, slightly down); recoil F = −recoilN·d.
  const fx = 0;
  const fy = gun.recoilN * Math.sin(dep);
  const fz = gun.recoilN * Math.cos(dep);
  const r = gun.muzzle;
  return {
    fx,
    fy,
    fz,
    // τ = r × F
    tx: r.y * fz - r.z * fy,
    ty: r.z * fx - r.x * fz,
    tz: r.x * fy - r.y * fx,
  };
}
