/**
 * Shared helpers for the USS Iowa hull tests: the fleet config (calm and with the real sea), deep
 * ocean, a shelving bank and a pier wall sized for a battleship, the steady lever for a speed, and a
 * cached "steaming steadily at N kt" state (a battleship takes minutes to settle, so it is computed
 * once per speed and shared).
 *
 * Why not createVesselState's own lever: its pre-run helmsman (src/physics/hull.ts) integrates the
 * speed error at a gain made for yachts; a 58,000 t hull answers the lever over minutes, so in its
 * 25 s the lever winds down to the detent. The tests start from its running attitude and set the
 * lever from the propeller law (speed ∝ shaft rpm) instead, then let the ship settle.
 */
import { CONFIG, IOWA_AIRCRAFT, type Config } from '../../src/config';
import { createVesselState, step } from '../../src/physics';
import type { AircraftState, Controls, Environment } from '../../src/types';
import { DT, helm } from './v50-helpers';

export { DT, helm, knots, euler } from './v50-helpers';

export const WC = IOWA_AIRCRAFT.watercraft!;
/** The Iowa's config as the fleet builds it. */
export const IOWA_CFG: Config = { ...CONFIG, aircraft: IOWA_AIRCRAFT };
/** The same on still water (the sea's waves off: the level no longer counts as "the sea"). */
export const IOWA_CALM: Config = { ...IOWA_CFG, world: { ...IOWA_CFG.world, seaLevel: 12345 } };

/** Open ocean everywhere: sea level 0, the bottom 200 m down. */
export const OCEAN: Environment = { groundHeight: () => -200, surfaceAt: () => 'water', waterLevel: () => 0 };

/** 30 m of water south of z = −300; north of it the bottom shelves up 1 : 20 (11 m deep at z ≈ −680, dry from z ≈ −960). */
export const BANK: Environment = {
  groundHeight: (_x, z) => (z >= -300 ? -30 : Math.min(3, -30 + (-300 - z) * 0.05)),
  surfaceAt: () => 'water',
  waterLevel: () => 0,
};

/** Deep water with a pier / quay wall (top 3 m above the water) filling everything north of z = `wallZ`. */
export function pierEnv(wallZ: number): Environment {
  return { ...OCEAN, obstacleTop: (_x, z) => (z < wallZ ? 3 : -Infinity) };
}

/** Drive for `seconds` (calm open ocean unless told otherwise) with controls from `ctl(t, s)`, calling `each(t, s)` every step. */
export function drive(
  s0: AircraftState, seconds: number, ctl: (t: number, s: AircraftState) => Partial<Controls>, env: Environment = OCEAN, cfg: Config = IOWA_CALM,
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

/** The lever that holds `kt` in calm water (speed ∝ shaft rpm; full ahead = 4,900 rpm ≈ 32.5 kt). */
export function steadyLever(kt: number): number {
  const e = WC.engine;
  const rpm = (e.maxRpm * kt) / 32.5;
  return Math.min(1, WC.neutralDetent + (1 - WC.neutralDetent) * Math.max(0, (rpm - e.idleRpm) / (e.maxRpm - e.idleRpm)));
}

/** At rest at the origin, bow north. */
export function atRest(env: Environment = OCEAN, cfg: Config = IOWA_CALM, o: { headingDeg?: number; moored?: boolean } = {}): AircraftState {
  return createVesselState(env, cfg, { x: 0, z: 0, headingDeg: o.headingDeg ?? 0, moored: o.moored }).state;
}

const cache = new Map<number, AircraftState>();
/** Steaming steadily at about `kt` (calm, deep water), bow north, at the origin; the lever is steadyLever(kt). */
export function underway(kt: number): AircraftState {
  let s = cache.get(kt);
  if (!s) {
    const lever = steadyLever(kt);
    const c = createVesselState(OCEAN, IOWA_CALM, { x: 0, z: 0, headingDeg: 0, speedKt: kt });
    const settled = drive(c.state, 200, () => ({ throttle: lever }), OCEAN, IOWA_CALM);
    s = { ...settled, time: 0, position: { ...settled.position, x: 0, z: 0 } };
    cache.set(kt, s);
  }
  return s;
}
