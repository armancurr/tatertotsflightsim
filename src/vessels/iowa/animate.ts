/**
 * PURE mapping from the sim's visual state to the USS Iowa model's moving parts (no three.js):
 * each shaft's propeller speed and rudder angle, each turret's train, elevation, per-gun recoil and
 * muzzle flash, and the lights. Tolerates `v.vessel` / `v.turrets` absent, null, short or holding
 * garbage (props still, rudders amidships, turrets stowed: I and II forward, III aft, guns level).
 *
 * Rudder sign (PropulsorState.steerDeg, + = turns the bow to STARBOARD): the trailing edge swings to
 * starboard, so the stern is pushed to port. In three.js (+Y up) rotation.y = +δ turns the rudder's
 * trailing-edge direction (0, 0, +1) to (sin δ, 0, cos δ) — to starboard: rudder pivot rotation.y =
 * +steerDeg (radians). Only the inboard shafts carry rudders; the outboard shafts' angle is unused.
 *
 * Turrets (TurretStatus, IOWA_WEAPONS.naval.turrets order): train + = starboard → the train pivot's
 * rotation.y = −train; elevation + = up → the elevation pivot's rotation.x = +elev; recoil 0..1 →
 * each barrel slides back IOWA_RECOIL_M; flash 0..1 → the muzzle flash billboard's size / opacity.
 */
import type { AircraftVisualState } from '../../aircraft/types';
import type { NavalTurretConfig } from '../../config';
import { IOWA_RECOIL_M, foldTrain } from './turrets';
import { TURRETS, WC } from './shape';

const DEG = Math.PI / 180;

export interface IowaTurretAnim {
  /** Train and elevation, deg (clamped to the turret's arcs), the pivots' rotations (rad). */
  trainDeg: number;
  elevDeg: number;
  rotY: number;
  rotX: number;
  /** Per gun: recoil travel (m, + = back) and flash 0..1. */
  recoilM: number[];
  flash: number[];
}

export interface IowaAnim {
  /** Per propulsor: propeller speed (rev/s, signed) and rudder angle (rad, the pivot's rotation.y). */
  n: number[];
  rudder: number[];
  turrets: IowaTurretAnim[];
  /** Nav lights on (0 / 1). */
  nav: number;
  crashed: boolean;
}

/** Hard-over rudder angle the model allows (the physics' largest steer, plus a margin). */
export const RUDDER_MAX_DEG = WC.propulsors[0].maxSteerDeg + 2;

export function createIowaAnim(turrets: readonly NavalTurretConfig[] = TURRETS): IowaAnim {
  const k = WC.propulsors.length;
  return {
    n: new Array(k).fill(0),
    rudder: new Array(k).fill(0),
    turrets: turrets.map((t) => ({
      trainDeg: t.stowDeg,
      elevDeg: 0,
      rotY: -t.stowDeg * DEG,
      rotX: 0,
      recoilM: new Array(t.barrels).fill(0),
      flash: new Array(t.barrels).fill(0),
    })),
    nav: 0,
    crashed: false,
  };
}

const fin = (x: unknown, d = 0) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function computeIowaAnim(v: AircraftVisualState, out: IowaAnim, turrets: readonly NavalTurretConfig[] = TURRETS): IowaAnim {
  const crashed = v.crashed === true;
  const vs = v.vessel ?? null;
  for (let i = 0; i < out.n.length; i++) {
    const p = vs?.propulsors?.[i];
    out.n[i] = crashed ? 0 : clamp(fin(p?.n), -10, 10);
    out.rudder[i] = crashed ? 0 : clamp(fin(p?.steerDeg), -RUDDER_MAX_DEG, RUDDER_MAX_DEG) * DEG;
  }
  const live = Array.isArray(v.turrets) ? v.turrets : null;
  for (let t = 0; t < out.turrets.length; t++) {
    const cfg = turrets[t];
    const o = out.turrets[t];
    const st = crashed ? null : live?.[t] ?? null;
    let train = st ? fin(st.trainDeg, cfg.stowDeg) : cfg.stowDeg;
    train = foldTrain(cfg, train);
    // inside the training arc (an aft turret's arc runs round 180°)
    train = clamp(train, Math.min(cfg.trainMinDeg, cfg.stowDeg), Math.max(cfg.trainMaxDeg, cfg.stowDeg));
    const elev = st ? clamp(fin(st.elevDeg), cfg.elevMinDeg, cfg.elevMaxDeg) : 0;
    o.trainDeg = train;
    o.elevDeg = elev;
    o.rotY = -train * DEG;
    o.rotX = elev * DEG;
    for (let k = 0; k < o.recoilM.length; k++) {
      o.recoilM[k] = st ? clamp(fin(st.recoil?.[k]), 0, 1) * IOWA_RECOIL_M : 0;
      o.flash[k] = st ? clamp(fin(st.flash?.[k]), 0, 1) : 0;
    }
  }
  out.nav = !crashed && v.lights?.nav ? 1 : 0;
  out.crashed = crashed;
  return out;
}
