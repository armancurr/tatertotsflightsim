/**
 * Shared helpers for the A-10C tests (tests/physics/a10*.test.ts): the fleet's A-10 config (with its
 * weapons), a flyer that uses it on the runway world, and small pilot loops.
 */
import { A10_AIRCRAFT, A10_WEAPONS, CONFIG, MS_TO_KT, RAD_TO_DEG, type Config } from '../../src/config';
import type { AircraftState, Controls } from '../../src/types';
import { step } from '../../src/physics';
import { runwayFrame, toRunwayCoords } from '../../src/world/runway';
import { RUNWAY_ENV } from './helpers';

/** The A-10's full config as the fleet passes it to the physics (weapons included → gun recoil). */
export const A10_CFG: Config = { ...CONFIG, aircraft: A10_AIRCRAFT, weapons: A10_WEAPONS };

export const DT = CONFIG.sim.fixedDt;
export const clamp1 = (v: number): number => Math.max(-1, Math.min(1, v));
export const ias = (s: AircraftState): number => s.derived.ias * MS_TO_KT;
export const tas = (s: AircraftState): number => s.derived.tas * MS_TO_KT;
export const fpm = (s: AircraftState): number => s.velocity.y * 196.8504;
export const deg = (rad: number): number => rad * RAD_TO_DEG;

const rw = runwayFrame(A10_CFG);
/** Distance along runway 36 from its threshold, and lateral offset (m). */
export const along = (s: AircraftState): number => toRunwayCoords(s.position.x, s.position.z, rw).along;
export const across = (s: AircraftState): number => toRunwayCoords(s.position.x, s.position.z, rw).across;

export interface FlyOpts {
  each?: (s: AircraftState, c: Controls) => void;
  until?: (s: AircraftState) => boolean;
}

/** Fly the A-10 on the runway world at 120 Hz with a pilot function, stopping on a crash or `until`. */
export function flyA10(s0: AircraftState, pilot: Controls | ((s: AircraftState) => Controls), seconds: number, opts: FlyOpts = {}): AircraftState {
  let s = s0;
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    const c = typeof pilot === 'function' ? pilot(s) : pilot;
    s = step(s, c, DT, RUNWAY_ENV, A10_CFG);
    opts.each?.(s, c);
    if (s.crash || opts.until?.(s)) break;
  }
  return s;
}

/** Aileron that holds a bank angle (deg), with roll-rate damping (tuned for the A-10's big roll inertia). */
export const bankTo = (s: AircraftState, bankDeg: number): number =>
  clamp1(0.03 * (bankDeg - s.derived.rollDeg) - 0.012 * deg(s.derived.p));

/** Elevator that holds a pitch attitude (deg), with pitch-rate damping. */
export const pitchTo = (s: AircraftState, pitchDeg: number): number =>
  clamp1(0.04 * (pitchDeg - s.derived.pitchDeg) - 0.05 * deg(s.derived.q));

/** Elevator (added to the trim) that holds a vertical speed (m/s), with pitch-rate damping. */
export const vsTo = (s: AircraftState, vsMs: number): number =>
  clamp1(0.012 * (vsMs - s.velocity.y) - 0.05 * deg(s.derived.q));
