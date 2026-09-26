/**
 * Shared helpers for the Princess V50 hull tests: the fleet config, test seas (calm deep water, the
 * real Gerstner sea, a shelving beach, a wall of pontoon) and a helm that holds the lever and wheel.
 */
import { CONFIG, MS_TO_KT, V50_AIRCRAFT, type Config } from '../../src/config';
import { createVesselState, step } from '../../src/physics';
import { eulerFromQuat } from '../../src/physics/frames';
import type { AircraftState, Controls, Environment } from '../../src/types';

/** The V50's config as the fleet builds it. */
export const V50_CFG: Config = { ...CONFIG, aircraft: V50_AIRCRAFT };
/** The same, on still water: the sea's waves switched off (the level no longer counts as "the sea"). */
export const V50_CALM: Config = { ...V50_CFG, world: { ...V50_CFG.world, seaLevel: 12345 } };

export const DT = CONFIG.sim.fixedDt;

/** Open deep water everywhere (sea level 0, the bottom 40 m down). */
export const DEEP_SEA: Environment = { groundHeight: () => -40, surfaceAt: () => 'water', waterLevel: () => 0 };

/** 6 m of water south of z = −200; north of it the bottom shelves up 1 : 10 to a beach (dry from z ≈ −260). */
export const BEACH: Environment = {
  groundHeight: (_x, z) => (z >= -200 ? -6 : Math.min(3, -6 + (-200 - z) * 0.1)),
  surfaceAt: () => 'water',
  waterLevel: () => 0,
};

/** Deep water with a pontoon (top 0.6 m above the water) filling everything north of z = `wallZ`. */
export function pontoonEnv(wallZ: number): Environment {
  return { ...DEEP_SEA, obstacleTop: (_x, z) => (z < wallZ ? 0.6 : -Infinity) };
}

export const helm = (o: Partial<Controls> = {}): Controls => ({
  throttle: 0, elevator: 0, aileron: 0, rudder: 0, elevatorTrim: 0, flapsNotch: 0, gearDown: true, brake: 0, parkingBrake: false, engineOn: true, ...o,
});

export const knots = (s: AircraftState): number => (s.vessel?.speedMs ?? 0) * MS_TO_KT;
export const euler = (s: AircraftState) => eulerFromQuat(s.orientation);

/** At rest (or moored) at the origin, bow north. */
export function atRest(env: Environment = DEEP_SEA, cfg: Config = V50_CALM, o: { headingDeg?: number; moored?: boolean } = {}): AircraftState {
  return createVesselState(env, cfg, { x: 0, z: 0, headingDeg: o.headingDeg ?? 0, moored: o.moored }).state;
}

/** Drive for `seconds` with controls from `ctl(t, s)`, calling `each(t, s)` every step. */
export function drive(
  s0: AircraftState, seconds: number, ctl: (t: number, s: AircraftState) => Partial<Controls>, env: Environment = DEEP_SEA, cfg: Config = V50_CALM,
  each?: (t: number, s: AircraftState) => void,
): AircraftState {
  let s = s0;
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    const t = i * DT;
    s = step(s, helm(ctl(t, s)), DT, env, cfg);
    each?.(t, s);
  }
  return s;
}
