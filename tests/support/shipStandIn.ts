/**
 * Stand-in big ships for the port tests: the cruise ship and the battleship are built in parallel
 * elsewhere (fleet ids 'cruise' / 'iowa'), so the berth, pier and berthed-ship tests use generic
 * displacement hulls of the same size — a station table (fine bow, parallel midbody, transom), a mass
 * that floats it at the given draft, two shafts with rudders, and mooring / contact springs scaled
 * from the Princess V50's by the mass ratio. Not calibrated ships: just hulls the right size that float,
 * lie to their lines and can be driven.
 */
import { CONFIG, V50_AIRCRAFT, type AircraftConfig, type Config, type HullStation, type PropulsorConfig } from '../../src/config';
import { hullGeometry } from '../../src/physics/hull';

export interface StandIn {
  id: string;
  config: Config;
}

/** A ship's station table: length L, beam B, draft T (keel at −T), freeboard F at the deck edge. */
export function shipStations(L: number, B: number, T: number, F: number): HullStation[] {
  const h = B / 2;
  const st = (zf: number, half: number, keel: number, deck = F): HullStation => ({ z: zf * L, keelY: -T * keel, chineHalf: h * half * 0.96, chineY: -T * keel + 0.12 * T, deckHalf: h * Math.max(half, 0.04), deckY: deck });
  return [
    { z: -0.5 * L, keelY: -T * 0.55, chineHalf: 0, chineY: -T * 0.5, deckHalf: 0.3, deckY: F * 1.2 },
    st(-0.44, 0.45, 0.9, F * 1.12),
    st(-0.36, 0.82, 1, F * 1.05),
    st(-0.24, 1, 1),
    st(0.2, 1, 1),
    st(0.34, 0.92, 1),
    st(0.44, 0.78, 0.8),
    st(0.5, 0.62, 0.45),
  ];
}

/** A stand-in ship config (length, beam, draft, freeboard; m). */
export function makeStandInShip(L: number, B: number, T: number, F: number): AircraftConfig {
  const v50 = structuredClone(V50_AIRCRAFT);
  const wc0 = v50.watercraft!;
  const stations = shipStations(L, B, T, F);
  const prop = (x: number): PropulsorConfig => ({
    ...wc0.propulsors[0],
    type: 'shaft',
    position: { x, y: -T * 0.62, z: 0.43 * L },
    thrustAngleDeg: 0,
    diameter: Math.min(0.55 * T, 6.5),
    maxSteerDeg: 35,
    highSpeedSteerDeg: 35,
    highSpeedKt: 30,
    steerRateDegPerSec: 5,
    foilArea: 0.018 * L * T,
    foilCentre: { x, y: -T * 0.55, z: 0.455 * L },
  });
  const hull = {
    ...wc0.hull,
    kind: 'displacement' as const,
    stations,
    gridLong: 40,
    gridTrans: 6,
    waveSamplesLong: 7,
    waveSamplesTrans: 3,
    planingLift: 0,
    planingBuoyancyLoss: 0,
    selfWave: 0.3,
    residuary: [[0, 0], [0.15, 0.0003], [0.2, 0.0006], [0.25, 0.0012], [0.3, 0.003], [0.35, 0.006], [0.45, 0.012]] as [number, number][],
    rollDamping: 0.06,
  };
  // the mass that floats it with the keel at −T (waterline at y = 0): bisection on the static waterline
  const probe = { ...wc0, hull, propulsors: [prop(-B / 5), prop(B / 5)], trimTabs: null };
  let lo = 1e5;
  let hi = 5e9;
  for (let i = 0; i < 60; i++) {
    const m = Math.sqrt(lo * hi);
    if (hullGeometry(probe, m).waterlineY < 0) lo = m;
    else hi = m;
  }
  const mass = Math.sqrt(lo * hi);
  const k = mass / v50.mass;
  const kL2 = k * (L / 15.5) ** 2;
  return {
    ...v50,
    name: `Stand-in ship ${L} m`,
    registration: 'STAND IN',
    mass,
    inertia: { pitch: mass * (0.26 * L) ** 2, yaw: mass * (0.27 * L) ** 2, roll: mass * (0.36 * B) ** 2 },
    geometry: { ...v50.geometry, length: L, pilotEye: { x: 0, y: F + 15, z: -0.3 * L } },
    watercraft: {
      ...probe,
      engine: { ...wc0.engine, maxPowerW: 40e6, idleRpm: 150, maxRpm: 900, gearRatio: 4.5, shaftInertia: 5e5, governorGain: 1500, turboLagS: 3, torqueRise: 1.2 },
      windage: { frontArea: 0.35 * B * L * 0.25, sideArea: 0.6 * L * F * 2, cdFront: 0.7, cdSide: 0.9, centre: { x: 0, y: F + 6, z: 0 } },
      mooring: { stiffness: wc0.mooring.stiffness * k, damping: wc0.mooring.damping * k, yawStiffness: wc0.mooring.yawStiffness * kL2, yawDamping: wc0.mooring.yawDamping * kL2 },
      contact: { stiffness: wc0.contact.stiffness * k, damping: wc0.contact.damping * k, friction: 0.3, crashSpeedMs: 1.5, capsizeRollDeg: 60, capsizeTimeS: 6 },
    },
  };
}

/** A stand-in fleet entry (`AircraftDef`-like: an id and a config). */
export function standIn(id: string, L: number, B: number, T: number, F: number): StandIn {
  return { id, config: { ...CONFIG, aircraft: makeStandInShip(L, B, T, F) } };
}

/** The cruise ship's size (MS Tater Star, Carnival Fantasy class): 260 m × 31.5 m, 7.8 m draft. */
export const CRUISE_STANDIN = (): StandIn => standIn('cruise', 260, 31.5, 7.8, 12);
/** USS Iowa's size: 270.4 m × 33 m, 11 m draft. */
export const IOWA_STANDIN = (): StandIn => standIn('iowa', 270.4, 33, 11, 8.5);
