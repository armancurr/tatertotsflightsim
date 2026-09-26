/**
 * Princess V50 shape tables (pure, no three.js): the hull comes from V50_AIRCRAFT.watercraft.hull
 * .stations (the physics' own table, via src/vessels/hullSection.ts); everything above the sheer
 * line is defined here relative to it — the coachroof / house sides inset from the deck edge, the
 * raked, wrap-around windscreen, the side glazing, the hardtop roof with its sunroof, the radar
 * pylon, the saloon and cockpit soles, the swim platform, and where the helm sits.
 *
 * Body frame: origin = CG, +X starboard, +Y up, −Z bow, metres. The saloon sole is below the
 * seated helmsman's eye (V50_AIRCRAFT.geometry.pilotEye); the radar dome's top is
 * geometry.verticalTailTop.
 */
import { V50_AIRCRAFT } from '../../config';
import { hullSectionAt, type HullSection } from '../hullSection';
import { deckHeightAt } from '../hullLoft';

export const W50 = V50_AIRCRAFT.watercraft!;
export const STATIONS = W50.hull.stations;
export const G50 = V50_AIRCRAFT.geometry;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The hull section at z (the physics' interpolation). */
export const sec = (z: number, out?: HullSection): HullSection => hullSectionAt(STATIONS, z, out);

export const V50_SHAPE = {
  /** Stem and transom (the table's ends), bow pulpit / anchor tip, swim platform aft edge. */
  zStem: STATIONS[0].z,
  zTransom: STATIONS[STATIONS.length - 1].z,
  zAnchorTip: -9.2,
  zPlatformAft: 6.3,
  /** Swim platform top (teak) and its thickness. */
  platformY: -0.25,
  platformThickness: 0.16,
  /** Deck camber at the centreline, m. */
  deckCamber: 0.05,
  /** Where the coachroof starts rising out of the foredeck, and how far above the deck it gets. */
  zCoachroof: -6.6,
  coachRise: 0.27,
  /** Side-deck width beside the house (aft of the windscreen) and forward where the house narrows. */
  sideDeck: 0.3,
  sideDeckFwd: 0.62,
  /** Windscreen: base on the coachroof (centre z, how far aft the corners sweep), top under the roof. */
  wsBaseZ: -3.3,
  wsBaseSweep: 0.35,
  wsTopZ: -2.1,
  wsTopSweep: 0.2,
  /** The house sides lean in (tumblehome) this much from the sill to the roof. */
  tumblehome: 0.16,
  /** Hardtop roof: top height at the centreline, crown, thickness, aft edge. */
  roofY: 2.46,
  roofCrown: 0.05,
  roofThickness: 0.1,
  roofAftZ: 2.55,
  /** Saloon aft bulkhead (glass doors) and the cockpit's inner transom face. */
  zAftBulkhead: 1.2,
  zTransomInner: 5.38,
  /** Cockpit bulwark cap width (inboard of the deck edge). */
  gunwaleCap: 0.12,
  /** One sole for the saloon and the cockpit (below the helmsman's eye). */
  floorY: 0.42,
  /** Dash depth aft of the windscreen base, and the dash top height. */
  dashDepth: 0.62,
  dashY: 1.28,
  /** Radar pylon: base centre z on the roof, the dome (radius, height) on top. */
  pylonBaseZ: 0.15,
  domeRadius: 0.3,
  domeHeight: 0.23,
  /** Guard rails: height above the deck edge, inset from it. */
  railHeight: 0.4,
  railInset: 0.07,
  /** Pod fairing and drive leg. */
  podFairingRadius: 0.33,
} as const;

const S = V50_SHAPE;

/** Deck height at (x, z) on the cambered deck. */
export function deckY(x: number, z: number): number {
  return deckHeightAt(sec(z), x, S.deckCamber);
}

/** Half-width of the house (coachroof / saloon sides) at z: the deck edge less the side deck. */
export function houseHalf(z: number): number {
  const inset = S.sideDeck + (S.sideDeckFwd - S.sideDeck) * (1 - smooth(S.zCoachroof, S.wsBaseZ - 0.3, z));
  return Math.max(0.2, sec(z).deckHalf - inset);
}

/** Coachroof rise above the cambered deck at z (0 at the coachroof's forward end). */
export function coachRise(z: number): number {
  return S.coachRise * smooth(S.zCoachroof, S.wsBaseZ - 0.3, z);
}

/** Coachroof top height at (x, z) (|x| ≤ houseHalf(z)). */
export function coachTopY(x: number, z: number): number {
  return deckY(x, z) + coachRise(z);
}

/** The house side's top edge (the side windows' sill) at z. */
export function sillY(z: number): number {
  return coachTopY(houseHalf(z), z);
}

/** Windscreen base on the coachroof, u ∈ [−1, 1] across (−1 port corner): z, and half-width at the corners. */
export function wsBaseZ(u: number): number {
  return S.wsBaseZ + S.wsBaseSweep * u * u;
}
export const WS_BASE_HALF = houseHalf(S.wsBaseZ + S.wsBaseSweep);

/** Half-width of the house at the roof (the glazing's top edge) at z. */
export function houseTopHalf(z: number): number {
  return houseHalf(z) - S.tumblehome;
}

/** Windscreen top edge (under the roof's front lip), u ∈ [−1, 1]. */
export function wsTopZ(u: number): number {
  return S.wsTopZ + S.wsTopSweep * u * u;
}
export const WS_TOP_HALF = houseTopHalf(S.wsTopZ + S.wsTopSweep);

/** Roof half-width at z (a little outboard of the glazing's top edge). */
export function roofHalf(z: number): number {
  return houseTopHalf(Math.min(z, S.zAftBulkhead)) + 0.05;
}

/** Roof top height at (x, z): a crowned, very slightly sloping lid. */
export function roofTopY(x: number, z: number): number {
  const h = roofHalf(z);
  const u = Math.min(1, Math.abs(x) / h);
  return S.roofY + S.roofCrown * (1 - u * u) - 0.024 * (z - S.wsTopZ);
}
/** Roof underside (the headliner) at (x, z). */
export function roofBottomY(x: number, z: number): number {
  return roofTopY(x, z) - S.roofThickness;
}
/** Roof front edge (overhangs the windscreen top) and the rounded aft edge, u ∈ [−1, 1]. */
export function roofFrontZ(u: number): number {
  return wsTopZ(u) - 0.1;
}
export function roofAftZ(u: number): number {
  return S.roofAftZ - 0.35 * Math.pow(Math.abs(u), 4);
}

/** Dash aft face (the saloon's forward bulkhead) z at x. */
export function dashAftZ(x: number): number {
  const u = Math.max(-1, Math.min(1, x / WS_BASE_HALF));
  return wsBaseZ(u) + S.dashDepth;
}

/** Cockpit inner bulwark half-width at z. */
export function cockpitHalf(z: number): number {
  return sec(z).deckHalf - S.gunwaleCap;
}

/** The helm (starboard): seat, wheel, displays, relative to the pilot's eye. */
export const HELM = {
  eye: { x: G50.pilotEye.x, y: G50.pilotEye.y, z: G50.pilotEye.z },
  seat: { x: G50.pilotEye.x, z: G50.pilotEye.z + 0.05, cushionY: S.floorY + 0.52, width: 0.95, depth: 0.55 },
  wheel: { x: G50.pilotEye.x, y: 1.1, z: G50.pilotEye.z - 0.62, radius: 0.19, tiltDeg: 40 },
} as const;
