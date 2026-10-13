/**
 * Shared helpers for the Sea-Doo RXP-X 325 tests: the fleet's config (calm and real sea, and a rough
 * sea to jump off), and the V50's test seas and helm (tests/physics/v50-helpers.ts).
 */
import { CONFIG, SEADOO_AIRCRAFT, type Config } from '../../src/config';
import { createVesselState } from '../../src/physics';
import type { AircraftState, Controls, Environment } from '../../src/types';
import { DEEP_SEA, drive as driveV50 } from './v50-helpers';

export { BEACH, DEEP_SEA, DT, euler, helm, knots, pontoonEnv } from './v50-helpers';

export const SD_CFG: Config = { ...CONFIG, aircraft: SEADOO_AIRCRAFT };
/** Still water: the level no longer counts as "the sea", so no waves. */
export const SD_CALM: Config = { ...SD_CFG, world: { ...SD_CFG.world, seaLevel: 12345 } };
/** A fresh breeze: ~1 m waves, crests to jump off. */
export const SD_ROUGH: Config = { ...SD_CFG, world: { ...SD_CFG.world, water: { ...SD_CFG.world.water, windKt: 24 } } };

export const MPH = 0.44704;

export function atRest(env: Environment = DEEP_SEA, cfg: Config = SD_CALM, o: { headingDeg?: number; moored?: boolean } = {}): AircraftState {
  return createVesselState(env, cfg, { x: 0, z: 0, headingDeg: o.headingDeg ?? 0, moored: o.moored }).state;
}

export function drive(
  s0: AircraftState, seconds: number, ctl: (t: number, s: AircraftState) => Partial<Controls>, env: Environment = DEEP_SEA, cfg: Config = SD_CALM,
  each?: (t: number, s: AircraftState) => void,
): AircraftState {
  return driveV50(s0, seconds, ctl, env, cfg, each);
}
