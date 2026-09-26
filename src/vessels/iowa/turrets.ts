/**
 * USS Iowa turret geometry (PURE, no three.js): where each 16-inch muzzle is for a turret's train
 * and elevation, in the ship's BODY frame (origin = CG, +X starboard, +Y up, −Z bow) — the same
 * maths the 3D model's turret rig uses (src/vessels/iowa/turretRig.ts), so the gunnery can fire the
 * shell from exactly where the drawn muzzle is.
 *
 * The contract (NavalTurretConfig in src/config.ts, IOWA_WEAPONS.naval.turrets):
 *   - `position` is the turret's rotation centre on its barbette, at the turret floor;
 *   - train (deg): 0 = guns toward the bow (−Z), + = to STARBOARD (clockwise seen from above);
 *   - elevation (deg): + = muzzles up, about the trunnion axis `trunnionHeight` above the floor and
 *     `trunnionForward` ahead of the turret centre (in the turret's own frame);
 *   - the barrels lie `barrelSpacing` apart across the turret: barrel 0 is the LEFT gun (port side
 *     when trained forward), barrel `barrels − 1` the right one;
 *   - each barrel runs `barrelLength` from the trunnion to the muzzle.
 *
 *   muzzle = position + R_y(train) · ( (x_k, trunnionHeight, −trunnionForward) + R_x(elev) · (0, 0, −barrelLength) )
 *   x_k = (k − (barrels − 1) / 2) · barrelSpacing
 *
 * R_y(train) turns the bow direction (0, 0, −1) to starboard (+X) for train = +90°: in three.js
 * terms it is a rotation about +Y by −train (Object3D.rotation.y = −train). R_x(elev) turns
 * (0, 0, −1) up to (0, sin e, −cos e): Object3D.rotation.x = +elev.
 */
import type { NavalTurretConfig } from '../../config';

const DEG = Math.PI / 180;

export interface BodyPoint {
  x: number;
  y: number;
  z: number;
}

/** Recoil travel of a 16"/50 Mark 7 gun (48 in), m: TurretStatus.recoil = 1 slides the barrel this far back. */
export const IOWA_RECOIL_M = 1.22;

/** Lateral offset of barrel k across its turret (turret frame x, + = right / starboard when trained forward), m. */
export function barrelOffset(turret: Pick<NavalTurretConfig, 'barrels' | 'barrelSpacing'>, barrel: number): number {
  return (barrel - (turret.barrels - 1) / 2) * turret.barrelSpacing;
}

/** Rotate a turret-frame vector by the train angle into the body frame (writes into out). */
function trainToBody(trainDeg: number, x: number, y: number, z: number, out: BodyPoint): BodyPoint {
  const t = trainDeg * DEG;
  const c = Math.cos(t);
  const s = Math.sin(t);
  // clockwise from above: (0,0,−1) → (+1,0,0) at +90°
  out.x = x * c - z * s;
  out.y = y;
  out.z = x * s + z * c;
  return out;
}

/** Unit vector along the bore (breech → muzzle) in the body frame for a train and elevation (deg). */
export function iowaBoreBody(trainDeg: number, elevDeg: number, out: BodyPoint = { x: 0, y: 0, z: 0 }): BodyPoint {
  const e = elevDeg * DEG;
  return trainToBody(trainDeg, 0, Math.sin(e), -Math.cos(e), out);
}

/** The trunnion point of barrel k (where it pivots in elevation), body frame. */
export function iowaTrunnionBody(turret: NavalTurretConfig, trainDeg: number, barrel: number, out: BodyPoint = { x: 0, y: 0, z: 0 }): BodyPoint {
  trainToBody(trainDeg, barrelOffset(turret, barrel), turret.trunnionHeight, -turret.trunnionForward, out);
  out.x += turret.position.x;
  out.y += turret.position.y;
  out.z += turret.position.z;
  return out;
}

/**
 * Muzzle of barrel k (0 = left gun) of `turret` trained to `trainDeg` and elevated to `elevDeg`,
 * body frame. `recoil` (0..1, TurretStatus.recoil[k]) slides it back along the bore by up to
 * IOWA_RECOIL_M (default 0: the gun in battery, where the shell leaves). No allocation when `out` is given.
 */
export function iowaMuzzleBody(
  turret: NavalTurretConfig, trainDeg: number, elevDeg: number, barrel: number, recoil = 0, out: BodyPoint = { x: 0, y: 0, z: 0 },
): BodyPoint {
  const e = elevDeg * DEG;
  const len = turret.barrelLength - Math.max(0, Math.min(1, recoil)) * IOWA_RECOIL_M;
  trainToBody(trainDeg, barrelOffset(turret, barrel), turret.trunnionHeight + len * Math.sin(e), -turret.trunnionForward - len * Math.cos(e), out);
  out.x += turret.position.x;
  out.y += turret.position.y;
  out.z += turret.position.z;
  return out;
}

/** A train angle (deg) folded into the turret's arc convention: forward turrets −180…180, an aft turret (stow ≈ 180) 0…360. */
export function foldTrain(turret: Pick<NavalTurretConfig, 'stowDeg'>, trainDeg: number): number {
  const lo = Math.abs(turret.stowDeg) > 90 ? 0 : -180;
  let t = ((trainDeg - lo) % 360 + 360) % 360 + lo;
  if (!Number.isFinite(t)) t = turret.stowDeg;
  return t;
}
