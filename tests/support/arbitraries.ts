/**
 * fast-check arbitraries for the simulator's value types.
 */
import fc from 'fast-check';
import type { AircraftState, Controls, Quat, Vec3 } from '../../src/types';
import { CONFIG } from '../../src/config';

/** A finite double in [min, max] (no NaN, no ±Infinity). */
export const num = (min: number, max: number): fc.Arbitrary<number> =>
  fc.double({ min, max, noNaN: true, noDefaultInfinity: true });

/** Numbers that are hostile to naive code: NaN, ±Infinity, -0, huge and tiny values. */
export const hostileNum: fc.Arbitrary<number> = fc.constantFrom(NaN, Infinity, -Infinity, -0, 1e308, -1e308, 5e-324);

export const vec3 = (r: number): fc.Arbitrary<Vec3> =>
  fc.record({ x: num(-r, r), y: num(-r, r), z: num(-r, r) });

/** Uniform-ish random unit quaternion (normalised 4-vector, rejecting near-zero norms). */
export const unitQuat: fc.Arbitrary<Quat> = fc
  .tuple(num(-1, 1), num(-1, 1), num(-1, 1), num(-1, 1))
  .filter(([x, y, z, w]) => Math.hypot(x, y, z, w) > 0.1)
  .map(([x, y, z, w]) => {
    const l = Math.hypot(x, y, z, w);
    return { x: x / l, y: y / l, z: z / l, w: w / l };
  });

export interface Attitude {
  heading: number;
  pitch: number;
  roll: number;
}

/** Heading 0..360, pitch within ±maxPitch (away from the ±90° singularity), roll −180..180. */
export const attitude = (maxPitch = 85): fc.Arbitrary<Attitude> =>
  fc.record({ heading: num(0, 359.999), pitch: num(-maxPitch, maxPitch), roll: num(-179.999, 179.999) });

const NOTCHES = CONFIG.aircraft.flaps.notchesDeg.length;

/** Controls exactly within their documented ranges. */
export const controls: fc.Arbitrary<Controls> = fc.record({
  throttle: num(0, 1),
  elevator: num(-1, 1),
  aileron: num(-1, 1),
  rudder: num(-1, 1),
  elevatorTrim: num(-1, 1),
  flapsNotch: fc.integer({ min: 0, max: NOTCHES - 1 }),
  gearDown: fc.boolean(),
  brake: num(0, 1),
  parkingBrake: fc.boolean(),
  engineOn: fc.boolean(),
});

/** A piece of a control sequence: hold these controls for `seconds`. */
export interface ControlSegment {
  seconds: number;
  controls: Controls;
}

/** Control segments favouring "pilot-like" inputs (engine on, mostly gear down) with occasional extremes. */
export const controlSegment: fc.Arbitrary<ControlSegment> = fc.record({
  seconds: num(0.2, 8),
  controls: fc.oneof(
    { weight: 3, arbitrary: controls.map((c) => ({ ...c, engineOn: true, parkingBrake: false })) },
    { weight: 1, arbitrary: controls },
  ),
});

/** Throws if any number in the sampled arbitrary output is not finite — use in tests' own sanity checks. */
export function assertDefined<T>(v: T | undefined | null, what: string): T {
  if (v === undefined || v === null) throw new Error(`${what} is missing`);
  return v;
}

/** Surface-level mutation helper: a copy of `s` with overrides (keeps TypeScript happy). */
export const withState = (s: AircraftState, o: Partial<AircraftState>): AircraftState => ({ ...s, ...o });
