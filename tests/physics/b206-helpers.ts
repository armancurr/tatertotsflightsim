/**
 * Shared helpers for the Bell 206B-3 JetRanger tests: its fleet config, a trimmed state, a collective
 * "height hold" pilot and read-outs in the units the flight manual uses.
 */
import { B206_AIRCRAFT, CONFIG, MS_TO_KT, type Config } from '../../src/config';
import type { AircraftState, Controls } from '../../src/types';
import { createTrimmedState, FLAT_ENV, type TrimRequest } from '../../src/physics';
import { clamp } from '../../src/math/vec3';
import { getAircraftDef } from '../../src/fleet';

export const B206_CFG: Config = getAircraftDef('b206').config;
export const RC = B206_AIRCRAFT.rotorcraft!;
export const DT = CONFIG.sim.fixedDt;
export const SHP = 745.7;
export const NOMINAL_OMEGA = (RC.rotor.nominalRpm * 2 * Math.PI) / 60;

/** A copy of the JetRanger config with another gross weight, kg. */
export function withMass(mass: number): Config {
  const cfg = structuredClone(B206_CFG);
  cfg.aircraft.mass = mass;
  return cfg;
}

export function heliTrim(req: Partial<TrimRequest> = {}, cfg: Config = B206_CFG): { state: AircraftState; controls: Controls } {
  return createTrimmedState({ altitudeM: 300, iasKt: 0, headingDeg: 0, ...req }, FLAT_ENV, cfg);
}

/** Main-rotor speed, % of nominal. */
export const nr = (s: AircraftState): number => ((s.rotor?.omega ?? 0) / NOMINAL_OMEGA) * 100;
export const torquePct = (s: AircraftState): number => (s.rotor?.torque ?? 0) * 100;
export const iasKt = (s: AircraftState): number => s.derived.ias * MS_TO_KT;
export const gsKt = (s: AircraftState): number => s.derived.groundSpeed * MS_TO_KT;
export const fpm = (s: AircraftState): number => s.velocity.y * 196.8504;

/** Collective that holds a height above the ground (m), around a guess of the trim collective. */
export function holdHeight(s: AircraftState, targetAgl: number, trim: number): number {
  return clamp(trim + 0.04 * (targetAgl - s.derived.altitudeAGL) - 0.08 * s.derived.verticalSpeed, 0, 1);
}

/** Collective that holds a vertical speed (m/s, + up), around a guess of the trim collective. */
export function holdClimb(s: AircraftState, vs: number, trim: number): number {
  return clamp(trim + 0.08 * (vs - s.derived.verticalSpeed), 0, 1);
}
