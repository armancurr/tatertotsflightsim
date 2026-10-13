/**
 * PURE mapping from the sim's visual state to the Sea-Doo model's moving parts (no scene graph):
 * handlebars, nozzle steer and trim, the reverse bucket, and the rider (aboard, lean, crouch).
 * Tolerates `v.vessel` absent or null and garbage numbers (everything neutral).
 *
 * Signs (PropulsorState.steerDeg, + = bow to STARBOARD):
 *  - bars: + steer = handlebars turned right; `bars` (rad) = steerDeg / maxSteerDeg × barMaxDeg, the
 *    steer group's rotation.y = −bars (the right grip comes back toward the rider);
 *  - nozzle: a jet pushes opposite to where it points, so to push the stern to PORT the nozzle's
 *    exit end must point to STARBOARD: the steer pivot's rotation.y = +steerDeg turns the nozzle
 *    axis (0, 0, +1) to (sin δ, 0, cos δ);
 *  - trim (jet.trimDeg, + = jet aimed down): rotation.x = +trimDeg turns (0, 0, 1) to (0, −sin, cos);
 *  - bucket (0 up … 1 down over the exit): the hinge's rotation.x = −(1 − bucket) × bucketUpDeg
 *    (the bucket is drawn down, rotating it by a negative angle swings it up and forward).
 * Rider: `aboard` false after a spill / capsize and while the craft is being righted; `fwd` adds
 * a crouch with speed to the rider's fore / aft input.
 */
import type { AircraftVisualState } from '../../aircraft/types';
import { JET, SEADOO_SHAPE as S, clamp, smoothstep } from './shape';

const DEG = Math.PI / 180;

export interface SeadooAnim {
  /** Handlebar turn, rad (+ = right). */
  bars: number;
  /** Nozzle steer (rotation.y) and trim (rotation.x), rad. */
  nozzleYaw: number;
  nozzleTrim: number;
  /** Reverse bucket 0 up … 1 down, and the hinge's rotation.x, rad. */
  bucket: number;
  bucketAngle: number;
  /** Rider: on the craft, lean −1..1, fore / aft (with the speed crouch) −1..1. */
  aboard: boolean;
  lean: number;
  fwd: number;
  /** The swimmer is shown (rider off the craft). */
  swimmer: boolean;
  /** Head / helmet drawn (hidden in the helm view: the camera is inside it). */
  headVisible: boolean;
  crashed: boolean;
  /** Speed through the water, m/s (display, crouch). */
  speedMs: number;
}

export function createSeadooAnim(): SeadooAnim {
  return { bars: 0, nozzleYaw: 0, nozzleTrim: 0, bucket: 0, bucketAngle: -S.bucketUpDeg * DEG, aboard: true, lean: 0, fwd: 0, swimmer: false, headVisible: true, crashed: false, speedMs: 0 };
}

const fin = (x: unknown, d = 0) => (typeof x === 'number' && Number.isFinite(x) ? x : d);

export function computeSeadooAnim(v: AircraftVisualState, out: SeadooAnim): SeadooAnim {
  const crashed = v.crashed === true;
  const vs = v.vessel ?? null;
  const p = vs?.propulsors?.[0];
  const jet = p?.jet;
  const maxSteer = JET.maxSteerDeg || 22;
  const steer = crashed ? 0 : clamp(fin(p?.steerDeg), -maxSteer - 4, maxSteer + 4);
  out.bars = clamp(steer / maxSteer, -1, 1) * S.barMaxDeg * DEG;
  out.nozzleYaw = steer * DEG;
  const trimRange = JET.jet?.trimRangeDeg ?? 8;
  out.nozzleTrim = clamp(fin(jet?.trimDeg), -trimRange - 4, trimRange + 4) * DEG;
  out.bucket = clamp(fin(jet?.bucket), 0, 1);
  out.bucketAngle = -(1 - out.bucket) * S.bucketUpDeg * DEG;
  out.speedMs = fin(vs?.speedMs);

  const rider = vs?.rider;
  const righting = fin(vs?.righting);
  out.aboard = rider?.aboard !== false && !(righting > 0);
  out.swimmer = !out.aboard;
  out.lean = out.aboard ? clamp(fin(rider?.lean), -1, 1) : 0;
  const crouch = 0.3 * smoothstep(4, 20, Math.abs(out.speedMs));
  out.fwd = out.aboard ? clamp(fin(rider?.foreAft) + crouch, -1, 1) : 0;
  out.headVisible = v.cameraMode !== 'cockpit';
  out.crashed = crashed;
  return out;
}
