/**
 * Shared helpers for the MS Tater Star (cruise ship) hull tests: the fleet config, its calm-water
 * twin, and a deep open sea deep enough for a 7.75 m draft (the V50's helpers do the driving).
 */
import { CONFIG, CRUISE_AIRCRAFT, type Config } from '../../src/config';
import type { AircraftState, Environment } from '../../src/types';
import { createVesselState } from '../../src/physics';

export const CRUISE_CFG: Config = { ...CONFIG, aircraft: CRUISE_AIRCRAFT };
/** The same, on still water (the level no longer counts as "the sea": no waves). */
export const CRUISE_CALM: Config = { ...CRUISE_CFG, world: { ...CRUISE_CFG.world, seaLevel: 12345 } };
export const WC = CRUISE_AIRCRAFT.watercraft!;
/** Open ocean: sea level 0, the bottom 200 m down. */
export const OCEAN: Environment = { groundHeight: () => -200, surfaceAt: () => 'water', waterLevel: () => 0 };

/** At rest at the origin, bow north (calm water unless a config is given). */
export function shipAtRest(env: Environment = OCEAN, cfg: Config = CRUISE_CALM, headingDeg = 0): AircraftState {
  return createVesselState(env, cfg, { x: 0, z: 0, headingDeg }).state;
}
