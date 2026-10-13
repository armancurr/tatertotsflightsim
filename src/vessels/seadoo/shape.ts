/**
 * Sea-Doo RXP-X 325 shape constants and small shape functions, all derived from SEADOO_AIRCRAFT so
 * small calibration shifts of the hull (the station table), the jet (propulsors[0].position /
 * jet.inlet) or the rider (geometry.pilotEye) move the drawn parts with them:
 *
 *   hull          lofted from watercraft.hull.stations (stem → transom)
 *   deck          bow dome (under the hood) from the stem to the footwells' front wall, the footwells
 *                 and the central tunnel under the seat, the rear deck / boarding platform from the
 *                 footwells' aft end to `zAft` (stem + LOA, overhanging the pump)
 *   seat, pod     placed around the rider, who is placed on pilotEye (rider.ts)
 *   jet           nozzle exit at propulsors[0].position, grate at jet.inlet
 *
 * Body frame: +X starboard, +Y up, −Z bow, metres, origin = CG.
 */
import { SEADOO_AIRCRAFT } from '../../config';
import { hullSectionAt, pchipEval, pchipTangents, type HullSection } from '../hullSection';

export const SEADOO_WC = SEADOO_AIRCRAFT.watercraft!;
export const STATIONS = SEADOO_WC.hull.stations;
export const JET = SEADOO_WC.propulsors[0];
export const EYE = SEADOO_AIRCRAFT.geometry.pilotEye;

/** The hull section at z (interpolated from the station table). */
export const sec = (z: number): HullSection => hullSectionAt(STATIONS, z);

/** A smooth monotone curve through knots [x, y] (PCHIP; holds the end values outside). */
export function curve(knots: readonly (readonly [number, number])[]): (x: number) => number {
  const xs = knots.map((k) => k[0]);
  const ys = knots.map((k) => k[1]);
  const ms = pchipTangents(xs, ys);
  return (x: number) => pchipEval(xs, ys, ms, x);
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const mix = (a: number, b: number, t: number) => a + (b - a) * t;
export function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

const zStem = STATIONS[0].z;
const zTransom = STATIONS[STATIONS.length - 1].z;
/** Rider datum: the design below was drawn for pilotEye.z = 0.22; the cockpit follows the eye. */
const dz = EYE.z - 0.22;
const dy = EYE.y - 1.08;

export const SEADOO_SHAPE = {
  zStem,
  zTransom,
  /** Aft end of the rear deck overhang / the reverse bucket: stem + 3.33 m overall. */
  zAft: zStem + SEADOO_AIRCRAFT.geometry.length,
  /** Footwells: front wall top (where the bow dome ends), its slope length, aft end (rear deck). */
  zFootFront: -0.5 + dz,
  frontWall: 0.14,
  zFootRear: zTransom - 0.34,
  floorY: 0.1 + dy,
  /** Central tunnel under the seat (between the footwells): half-width and top. */
  tunnelHalf: 0.235,
  tunnelTopY: 0.3 + dy,
  /** Footwell outer lip: inset from the deck edge and rise above it. */
  lipInset: 0.11,
  lipRise: 0.1,
  rearDeckY: 0.215,
  /** Rear deck underside at the overhang. */
  rearUnderY: 0.145,
  /** Seat: front (against the pod) and aft end. */
  zSeatFront: -0.2 + dz,
  zSeatRear: zTransom - 0.31,
  /** Steering pod (console) span. */
  zPodFront: -0.66 + dz,
  zPodRear: -0.15 + dz,
  /** Steering column pivot (bars rotate about the tilted column axis), tilt (top toward the rider), bar travel. */
  barPivot: { x: 0, y: 0.575 + dy, z: -0.335 + dz },
  columnTiltDeg: 25,
  barMaxDeg: 25,
  /** Hand position on each grip, in the bar frame (x = ± half-span). */
  grip: { x: 0.31, y: 0.07, z: 0.03 },
  /** Nozzle: steering / trim pivot this far ahead of the exit; exit radius from the propulsor diameter. */
  nozzleLength: 0.065,
  /** iBR reverse bucket: hinge pins this far ahead of the exit (on the nozzle axis), swing from down to up. */
  bucketHingeAhead: 0.09,
  bucketUpDeg: 75,
  /** Static waterline with the rider aboard (preview placement), body y. */
  waterlineY: -0.17,
} as const;

const S = SEADOO_SHAPE;

/** Centreline height of the bow dome from the stem to the footwells' front wall (and a little beyond). */
const crownT = curve([
  [0, 0.26],
  [0.09, 0.345],
  [0.27, 0.435],
  [0.5, 0.485],
  [0.75, 0.515],
  [1, 0.54],
  [1.2, 0.555],
]);
export const crownY = (z: number) => crownT((z - S.zStem) / (S.zFootFront - S.zStem)) + dy;

/** Bow dome cross profile: 1 on the centreline … 0 at the deck edge (rounded shoulders). */
export function domeProfile(u: number): number {
  const a = Math.min(1, Math.abs(u));
  return Math.pow(Math.max(0, 1 - Math.pow(a, 2.4)), 0.55);
}

/** Bow dome height at (x, z): the deck edge at |x| = deckHalf rising to the crown on the centreline. */
export function domeY(x: number, z: number): number {
  const s = sec(z);
  const u = s.deckHalf > 1e-6 ? x / s.deckHalf : 1;
  return s.deckY + (crownY(z) - s.deckY) * domeProfile(u);
}

/** Footwell floor height (flat, ramping up to the rear deck at the aft end). */
export const floorY = (z: number) => mix(S.floorY, S.rearDeckY - 0.01, smoothstep(S.zFootRear - 0.3, S.zFootRear, z));

/** Floor (and the sloping front wall) at (x, z) inside the footwell. */
export function footFloorY(x: number, z: number): number {
  if (z < S.zFootFront + S.frontWall) {
    const t = smoothstep(S.zFootFront, S.zFootFront + S.frontWall, z);
    return mix(domeY(x, S.zFootFront), floorY(z), t);
  }
  return floorY(z);
}

/** Inner face of the footwell's outer lip (x) and the lip's top (y), ramping down to the rear deck aft. */
export const lipInnerX = (z: number) => sec(z).deckHalf - S.lipInset;
export const lipTopY = (z: number) => mix(sec(z).deckY + S.lipRise, S.rearDeckY + 0.005, smoothstep(S.zFootRear - 0.26, S.zFootRear, z));

/** Seat: half-width and top height along z (narrow Ergolock seat, dip where the rider sits, bolster behind). */
const seatSpan = S.zSeatRear - S.zSeatFront;
const seatZ = (f: number) => S.zSeatFront + f * seatSpan;
export const seatHalf = curve([
  [seatZ(0), 0.07],
  [seatZ(0.02), 0.12],
  [seatZ(0.09), 0.165],
  [seatZ(0.3), 0.175],
  [seatZ(0.55), 0.19],
  [seatZ(0.78), 0.215],
  [seatZ(0.93), 0.2],
  [seatZ(1), 0.13],
]);
export const seatTop = curve([
  [seatZ(0), 0.41 + dy],
  [seatZ(0.03), 0.44 + dy],
  [seatZ(0.1), 0.43 + dy],
  [seatZ(0.3), 0.385 + dy],
  [seatZ(0.5), 0.35 + dy],
  [seatZ(0.62), 0.352 + dy],
  [seatZ(0.78), 0.435 + dy],
  [seatZ(0.9), 0.43 + dy],
  [seatZ(1), 0.37 + dy],
]);
export const SEAT_BASE_Y = S.tunnelTopY - 0.015;

/** Steering pod (console): half-width and top along z. */
const podSpan = S.zPodRear - S.zPodFront;
const podZ = (f: number) => S.zPodFront + f * podSpan;
export const podHalf = curve([
  [podZ(0), 0.15],
  [podZ(0.1), 0.215],
  [podZ(0.4), 0.25],
  [podZ(0.7), 0.235],
  [podZ(0.9), 0.19],
  [podZ(1), 0.15],
]);
export const podTop = curve([
  [podZ(0), 0.5 + dy],
  [podZ(0.12), 0.585 + dy],
  [podZ(0.3), 0.635 + dy],
  [podZ(0.4), 0.64 + dy],
  [podZ(0.52), 0.605 + dy],
  [podZ(0.66), 0.59 + dy],
  [podZ(0.82), 0.55 + dy],
  [podZ(0.96), 0.465 + dy],
  [podZ(1), 0.44 + dy],
]);
export const POD_BASE_Y = S.tunnelTopY - 0.03;
