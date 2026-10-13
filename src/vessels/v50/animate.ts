/**
 * PURE mapping from the sim's visual state to the Princess V50 model's moving parts (no three.js):
 * each IPS pod's steering angle and propeller speed / blur, the trim-tab deflection and the lights.
 * Tolerates `v.vessel` absent or null (everything neutral: pods straight, props still, tabs up).
 *
 * Steering sign (PropulsorState.steerDeg, + = turns the bow to STARBOARD): IPS propellers pull
 * (they sit at the front of the drive, facing forward), so to swing the bow to starboard the stern
 * must be pushed to port, i.e. the pull must point forward-and-to-PORT. The drive leg therefore
 * yaws left seen from above: the propeller end swings to port and the leg's trailing edge to
 * starboard. In three.js (+Y up) a positive rotation.y turns the forward axis (0, 0, −1) to
 * (−sin δ, 0, −cos δ) — toward port — so the pod pivot gets rotation.y = +steerDeg (in radians).
 * The pivot axis is vertical through the propeller centre (PropulsorConfig.position), so the
 * thrust point never moves.
 *
 * Propellers: n (rev/s, signed; − astern) turns the forward propeller +n and the aft one −n
 * (counter-rotating pair) about the drive axis; above ~8 rev/s the blades blur into a disc.
 */
import type { AircraftVisualState } from '../../aircraft/types';
import { W50 } from './shape';

const DEG = Math.PI / 180;

/** Trim tabs: full deflection (tabs = 1), deg trailing edge down. */
export const TAB_MAX_DEG = 15;
/** Propeller blur: crisp below `start`, full disc above `full` (|n|, rev/s). */
export const PROP_BLUR = { start: 6, full: 10 } as const;

export interface V50Anim {
  /** Pod steering (rad, the pivot's rotation.y), propeller speed (rev/s) and blur (0..1), per propulsor. */
  steer: number[];
  n: number[];
  blur: number[];
  /** Trim-tab deflection, rad (+ = trailing edge down). */
  tab: number;
  /** Nav lights on (0 / 1). */
  nav: number;
  crashed: boolean;
}

export function createV50Anim(): V50Anim {
  const k = W50.propulsors.length;
  return { steer: new Array(k).fill(0), n: new Array(k).fill(0), blur: new Array(k).fill(0), tab: 0, nav: 0, crashed: false };
}

const fin = (x: unknown, d = 0) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** 0 = crisp blades … 1 = full blur disc, from the propeller speed (rev/s, either sign). */
export function propBlur(n: number): number {
  return smoothstep(PROP_BLUR.start, PROP_BLUR.full, Math.abs(fin(n)));
}

export function computeV50Anim(v: AircraftVisualState, out: V50Anim): V50Anim {
  const crashed = v.crashed === true;
  const vs = v.vessel ?? null;
  for (let i = 0; i < out.steer.length; i++) {
    const p = vs?.propulsors?.[i];
    const max = W50.propulsors[i].maxSteerDeg + 4;
    out.steer[i] = crashed ? 0 : clamp(fin(p?.steerDeg), -max, max) * DEG;
    out.n[i] = crashed ? 0 : clamp(fin(p?.n), -60, 60);
    out.blur[i] = propBlur(out.n[i]);
  }
  out.tab = clamp(fin(vs?.tabs), 0, 1) * TAB_MAX_DEG * DEG;
  out.nav = !crashed && v.lights?.nav ? 1 : 0;
  out.crashed = crashed;
  return out;
}
