/**
 * Reusable invariant checks for the fuzz and functional layers. Each returns a
 * description of the first violation (or null), so a property can report
 * *what* broke instead of a bare `false`.
 */
import type { AircraftState, Controls, Quat } from '../../src/types';
import { CONFIG, MS_TO_KT } from '../../src/config';

/** Path of the first non-finite number inside a nested value, or null when every number is finite. */
export function firstNonFinite(obj: unknown, path = '$'): string | null {
  if (typeof obj === 'number') return Number.isFinite(obj) ? null : `${path} = ${obj}`;
  if (obj === null || typeof obj !== 'object') return null;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const bad = firstNonFinite(v, `${path}.${k}`);
    if (bad) return bad;
  }
  return null;
}

export const quatNorm = (q: Quat): number => Math.hypot(q.x, q.y, q.z, q.w);

/** Deep-freeze so that any mutation of an input throws (ES modules run in strict mode). */
export function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

const FLAP_MAX = Math.max(...CONFIG.aircraft.flaps.notchesDeg);
const PHASES = new Set(['ground', 'airborne', 'landed', 'crashed']);

export interface StateLimits {
  /** Upper bound on indicated airspeed (what window.sim.airspeed shows), knots. */
  maxIasKt: number;
  /** Upper bound on the inertial speed |velocity|, knots (TAS grows with altitude at a given IAS). */
  maxSpeedKt: number;
}

export const DEFAULT_LIMITS: StateLimits = { maxIasKt: 250, maxSpeedKt: 300 };

/** Every structural invariant an AircraftState must satisfy after any step. */
export function stateViolation(s: AircraftState, limits: StateLimits = DEFAULT_LIMITS): string | null {
  const nf = firstNonFinite(s);
  if (nf) return `non-finite ${nf}`;
  const n = quatNorm(s.orientation);
  if (Math.abs(n - 1) > 1e-6) return `orientation norm ${n}`;
  if (!(s.gearPos >= 0 && s.gearPos <= 1)) return `gearPos ${s.gearPos}`;
  if (!(s.flapsDeg >= 0 && s.flapsDeg <= FLAP_MAX + 1e-9)) return `flapsDeg ${s.flapsDeg}`;
  if (!PHASES.has(s.phase)) return `phase ${s.phase}`;
  if (s.phase === 'crashed' && !s.crash) return 'crashed without a crash record';
  if (s.phase !== 'crashed' && s.crash) return `crash record while ${s.phase}`;
  if (s.stalled && s.phase !== 'airborne') return `stalled while ${s.phase}`;
  const iasKt = s.derived.ias * MS_TO_KT;
  if (!(iasKt < limits.maxIasKt)) return `IAS ${iasKt.toFixed(1)} kt`;
  const speedKt = Math.hypot(s.velocity.x, s.velocity.y, s.velocity.z) * MS_TO_KT;
  if (!(speedKt < limits.maxSpeedKt)) return `speed ${speedKt.toFixed(1)} kt`;
  if (s.airborneTime < 0) return `airborneTime ${s.airborneTime}`;
  if (s.engine.power < -1e-12 || s.engine.power > 1.2) return `engine.power ${s.engine.power}`;
  if (s.engine.rpm < 0) return `engine.rpm ${s.engine.rpm}`;
  for (const c of s.wheelCompression) if (c < 0) return `wheelCompression ${c}`;
  return null;
}

/** Controls within the ranges documented in src/types.ts. */
export function controlsViolation(c: Controls, maxNotch = CONFIG.aircraft.flaps.notchesDeg.length - 1): string | null {
  const nf = firstNonFinite(c);
  if (nf) return `non-finite ${nf}`;
  const inR = (v: number, lo: number, hi: number) => v >= lo && v <= hi;
  if (!inR(c.throttle, 0, 1)) return `throttle ${c.throttle}`;
  if (!inR(c.elevator, -1, 1)) return `elevator ${c.elevator}`;
  if (!inR(c.aileron, -1, 1)) return `aileron ${c.aileron}`;
  if (!inR(c.rudder, -1, 1)) return `rudder ${c.rudder}`;
  if (!inR(c.elevatorTrim, -1, 1)) return `elevatorTrim ${c.elevatorTrim}`;
  if (!inR(c.brake, 0, 1)) return `brake ${c.brake}`;
  if (!Number.isInteger(c.flapsNotch) || !inR(c.flapsNotch, 0, maxNotch)) return `flapsNotch ${c.flapsNotch}`;
  for (const k of ['gearDown', 'parkingBrake', 'engineOn'] as const) {
    if (typeof c[k] !== 'boolean') return `${k} ${String(c[k])}`;
  }
  return null;
}
