/**
 * Shared helpers for the physics tests: fly a state for N seconds with a fixed
 * control set or a tiny "pilot" function, simple autopilot loops, and a flat
 * test world with a real runway rectangle (grass elsewhere).
 */
import { CONFIG, MS_TO_KT, RAD_TO_DEG } from '../../src/config';
import type { AircraftState, Controls, Environment } from '../../src/types';
import { step, FLAT_ENV, createTrimmedState, type TrimRequest } from '../../src/physics';
import { isOnRunway } from '../../src/world/runway';
import { clamp, wrap180 } from '../../src/math/vec3';

export const DT = CONFIG.sim.fixedDt;

export type Pilot = Controls | ((s: AircraftState) => Controls);

export interface FlyOptions {
  env?: Environment;
  /** Stop early when this returns true (checked after every step). */
  until?: (s: AircraftState) => boolean;
  /** Called after every step. */
  each?: (s: AircraftState) => void;
}

/** Step the physics at the fixed 120 Hz rate for `seconds` of simulated time. */
export function fly(state: AircraftState, pilot: Pilot, seconds: number, opts: FlyOptions = {}): AircraftState {
  const env = opts.env ?? FLAT_ENV;
  const n = Math.round(seconds / DT);
  let s = state;
  for (let i = 0; i < n; i++) {
    const c = typeof pilot === 'function' ? pilot(s) : pilot;
    s = step(s, c, DT, env);
    opts.each?.(s);
    if (opts.until?.(s)) break;
  }
  return s;
}

export const iasKt = (s: AircraftState): number => s.derived.ias * MS_TO_KT;
export const tasKt = (s: AircraftState): number => s.derived.tas * MS_TO_KT;
export const fpm = (s: AircraftState): number => s.velocity.y * 196.8504;

/** Flat world at y = 0 where only the runway rectangle is 'runway' and the rest is grass. */
export const RUNWAY_ENV: Environment = {
  groundHeight: () => 0,
  surfaceAt: (x, z) => (isOnRunway(x, z) ? 'runway' : 'grass'),
  waterLevel: () => null,
  obstacleTop: () => -Infinity,
};

/** A trimmed, airborne aircraft plus the controls that hold it there. */
export function trimmed(req: Partial<TrimRequest> = {}): { state: AircraftState; controls: Controls } {
  return createTrimmedState({ altitudeM: 1000, iasKt: 90, flightPathDeg: 0, flapsNotch: 0, gearDown: true, headingDeg: 0, ...req });
}

/** Aileron command that holds a bank angle (deg) with rate damping. */
export function bankHold(s: AircraftState, bankDeg: number): number {
  return clamp(0.04 * (bankDeg - s.derived.rollDeg) - 0.012 * s.derived.p * RAD_TO_DEG, -1, 1);
}

/** Elevator command that holds a pitch attitude (deg) with pitch-rate damping. */
export function pitchHold(s: AircraftState, pitchDeg: number): number {
  return clamp(0.06 * (pitchDeg - s.derived.pitchDeg) - 0.04 * s.derived.q * RAD_TO_DEG, -1, 1);
}

/** Elevator command (added to a base) that holds an altitude with vertical-speed damping. */
export function altitudeHold(s: AircraftState, targetY: number): number {
  return 0.01 * (targetY - s.position.y) - 0.06 * s.velocity.y - 0.02 * s.derived.q * RAD_TO_DEG;
}

/** Heading error in degrees (+ = aircraft is right of the target heading). */
export const headingError = (s: AircraftState, targetDeg: number): number => wrap180(s.derived.headingDeg - targetDeg);

/** Every number in a nested object is finite. */
export function allFinite(obj: unknown): boolean {
  if (typeof obj === 'number') return Number.isFinite(obj);
  if (obj === null || typeof obj !== 'object') return true;
  for (const v of Object.values(obj as Record<string, unknown>)) if (!allFinite(v)) return false;
  return true;
}

/** Deep-freeze an object so any mutation inside step() throws in strict mode. */
export function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

/** Small deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
