/**
 * PURE mapping from the sim's visual state to the Tater Star's moving parts (no three.js): each
 * shaft's rudder angle (rad) and propeller speed (rev/s), the tunnel thrusters' thrust fraction
 * (−1 … +1, + pushing to starboard), the nav lights. Tolerates `v.vessel` absent / null / short
 * (everything neutral) and garbage numbers.
 *
 * Rudder sign: PropulsorState.steerDeg + turns the bow to STARBOARD; a rudder does that with its
 * trailing edge swung to starboard (the flow pushes the stern to port). The rudder's chord runs aft
 * (+z) from its stock, and a positive rotation.y turns +z toward +x, so rotation.y = +steerDeg.
 */
import type { AircraftVisualState } from '../../aircraft/types';
import { WCR } from './shape';

const DEG = Math.PI / 180;

/** Indices of the shaft propulsors (port first as configured) and of the tunnel thrusters. */
export const SHAFT_INDEX: readonly number[] = WCR.propulsors.map((p, i) => (p.type === 'shaft' ? i : -1)).filter((i) => i >= 0);
export const THRUSTER_INDEX: readonly number[] = WCR.propulsors.map((p, i) => (p.type === 'thruster' ? i : -1)).filter((i) => i >= 0);

export interface CruiseAnim {
  /** Per shaft: rudder angle (rad, the stock's rotation.y) and propeller speed (rev/s, signed). */
  rudder: number[];
  n: number[];
  /** Per thruster: thrust fraction −1 … +1. */
  thrust: number[];
  nav: number;
  crashed: boolean;
}

export function createCruiseAnim(): CruiseAnim {
  return { rudder: SHAFT_INDEX.map(() => 0), n: SHAFT_INDEX.map(() => 0), thrust: THRUSTER_INDEX.map(() => 0), nav: 0, crashed: false };
}

const fin = (x: unknown, d = 0) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function computeCruiseAnim(v: AircraftVisualState, out: CruiseAnim): CruiseAnim {
  const crashed = v.crashed === true;
  const ps = Array.isArray(v.vessel?.propulsors) ? v.vessel!.propulsors : null;
  for (let k = 0; k < SHAFT_INDEX.length; k++) {
    const i = SHAFT_INDEX[k];
    const p = ps?.[i];
    const max = WCR.propulsors[i].maxSteerDeg + 2;
    out.rudder[k] = crashed ? 0 : clamp(fin(p?.steerDeg), -max, max) * DEG;
    out.n[k] = crashed ? 0 : clamp(fin(p?.n), -10, 10);
  }
  for (let k = 0; k < THRUSTER_INDEX.length; k++) {
    const i = THRUSTER_INDEX[k];
    const max = WCR.propulsors[i].thruster?.maxThrustN ?? 1;
    out.thrust[k] = crashed ? 0 : clamp(fin(ps?.[i]?.thrust) / max, -1, 1);
  }
  out.nav = !crashed && v.lights?.nav ? 1 : 0;
  out.crashed = crashed;
  return out;
}
