/**
 * MS Tater Star — the drawn ship's dimensions (PURE, no three.js), in the BODY frame (origin = CG,
 * +X starboard, +Y up, −Z bow, metres), derived from CRUISE_AIRCRAFT so the model and the physics
 * agree: the hull is the physics' station table, the propellers / rudders / thruster tunnels sit on
 * the propulsor positions, the helm eye is geometry.pilotEye, the highest point verticalTailTop.
 *
 * A classic 1990s mid-size cruise ship in the Fantasy-class manner, kept plain: a white hull with
 * rows of portholes; a set-in promenade deck with the lifeboats in davits under the overhang;
 * three decks of cabin windows, two of balconies with the bridge (wings out past the side) at their
 * forward end; the lido deck with its pool between two deckhouses; a single raked funnel aft.
 */
import { CONFIG, CRUISE_AIRCRAFT, type HullStation } from '../../config';
import { staticFloat } from '../../physics/hull';
import { hullSectionAt } from '../hullSection';

export const WCR = CRUISE_AIRCRAFT.watercraft!;
export const GCR = CRUISE_AIRCRAFT.geometry;
export const STATIONS: readonly HullStation[] = WCR.hull.stations;

/** Deck height (m) of the superstructure, and the taller set-in promenade (lifeboat) deck under it. */
export const DECK_H = 2.85;
export const PROM_H = 3.6;

const st0 = STATIONS[0];
const stN = STATIONS[STATIONS.length - 1];
const keelY = Math.min(...STATIONS.map((s) => s.keelY));
const midDeckY = Math.min(...STATIONS.map((s) => s.deckY));
const maxHalf = Math.max(...STATIONS.map((s) => s.deckHalf));

/** One superstructure tier: a plan outline (half-width, rounded ends) extruded over `decks` decks. */
export interface TierSpec {
  name: string;
  /** Bottom (body y), the number of decks and their height (default DECK_H). */
  y0: number;
  decks: number;
  deckH?: number;
  /** Forward and aft ends (body z) and the rounding length at each end. */
  zFwd: number;
  zAft: number;
  roundFwd: number;
  roundAft: number;
  /** Largest half-width (clipped to the hull's deck edge less `inset`). */
  half: number;
  inset: number;
  /** Window style per deck (bottom first): an index into WINDOW_ROWS. */
  styles: number[];
}

/** Window-atlas rows (src/vessels/cruise/textures.ts). */
export const WINDOW_ROWS = { balcony: 0, cabin: 1, lounge: 2, plain: 3, promenade: 4 } as const;
export const WINDOW_ROW_COUNT = 5;
/** Metres of wall per repeat of the window atlas along the wall. */
export const WINDOW_TILE_M = 12.8;

const zBow = st0.z;
const zStern = stN.z;
const baseY = midDeckY;

/** Where things are (body frame). */
export const CRUISE_SHAPE = {
  zBow,
  zStern,
  keelY,
  /** The static waterline (body y) in calm water. */
  waterlineY: -staticFloat({ ...CONFIG, aircraft: CRUISE_AIRCRAFT }).dy,
  /** Main deck at the sheer's lowest point: the superstructure's base. */
  deckY: baseY,
  beam: 2 * maxHalf,
  /** The superstructure (bottom first). */
  tiers: [
    { name: 'promenade', y0: baseY, decks: 1, deckH: PROM_H, zFwd: -80, zAft: 110, roundFwd: 8, roundAft: 10, half: 12.1, inset: 1.2, styles: [WINDOW_ROWS.promenade] },
    { name: 'cabins', y0: baseY + PROM_H, decks: 3, zFwd: -84, zAft: 122, roundFwd: 14, roundAft: 20, half: maxHalf - 0.15, inset: 0.15, styles: [WINDOW_ROWS.cabin, WINDOW_ROWS.cabin, WINDOW_ROWS.cabin] },
    { name: 'balconies', y0: baseY + PROM_H + 3 * DECK_H, decks: 2, zFwd: -86, zAft: 98, roundFwd: 11, roundAft: 16, half: maxHalf - 0.55, inset: 0.6, styles: [WINDOW_ROWS.balcony, WINDOW_ROWS.balcony] },
    { name: 'lidoFwd', y0: baseY + PROM_H + 5 * DECK_H, decks: 1, zFwd: -80, zAft: -40, roundFwd: 7, roundAft: 2, half: 12, inset: 2, styles: [WINDOW_ROWS.lounge] },
    { name: 'lidoAft', y0: baseY + PROM_H + 5 * DECK_H, decks: 1, zFwd: 18, zAft: 90, roundFwd: 3, roundAft: 12, half: 13, inset: 2, styles: [WINDOW_ROWS.lounge] },
    { name: 'sports', y0: baseY + PROM_H + 6 * DECK_H, decks: 1, zFwd: -72, zAft: -50, roundFwd: 5, roundAft: 2, half: 8, inset: 2, styles: [WINDOW_ROWS.plain] },
  ] as TierSpec[],
  /** The bridge: the forward end of the balcony tier's upper deck, glazed across the front. */
  bridge: {
    floorY: baseY + PROM_H + 4 * DECK_H,
    roofY: baseY + PROM_H + 5 * DECK_H,
    zFront: -86,
    zBack: -77,
    /** Glass band (body y) and half-width of the glazed front. */
    glassLo: baseY + PROM_H + 4 * DECK_H + 0.6,
    glassHi: baseY + PROM_H + 5 * DECK_H - 0.3,
    /** Bridge wings: out past the ship's side. */
    wingHalf: maxHalf + 1.6,
    wingZ0: -86,
    wingZ1: -80,
  },
  /** Pool deck (the balcony tier's roof between the lido deckhouses). */
  pool: { y: baseY + PROM_H + 5 * DECK_H, z0: -20, z1: -4, half: 4.2 },
  /** The funnel: stadium section, raked aft; base centre, top centre (its rim), section half-length / half-width at the base. */
  funnel: {
    base: { x: 0, y: baseY + PROM_H + 6 * DECK_H - 0.5, z: 70.5 },
    top: { x: 0, y: GCR.verticalTailTop.y - 2, z: 73.5 },
    halfLen: 11,
    halfWid: 5,
    /** Taper of the section at the top. */
    topScale: 0.86,
    bandLo: 0.6,
    bandHi: 0.72,
  },
  /** The foremast (on the sports deck) with the masthead light, and the aft mast pole on the funnel. */
  mast: { x: 0, z: -62, y0: baseY + PROM_H + 7 * DECK_H, y1: baseY + PROM_H + 7 * DECK_H + 7.9 },
  aftMast: { x: GCR.verticalTailTop.x, z: GCR.verticalTailTop.z, y1: GCR.verticalTailTop.y },
  /** Lifeboats hanging in davits under the cabins' overhang, both sides. */
  lifeboats: { count: 9, z0: -58, pitch: 12.2, length: 10.2, beam: 3.7, height: 3.1, x: 13.9, y: baseY + 0.2 },
  /** Hull porthole rows (body y centres), their height, spacing along z and the z range. */
  portholes: { rows: [baseY - 9.6, baseY - 6.7, baseY - 3.8, baseY - 1.2], half: 0.32, pitch: 3.2, z0: -90, z1: 124 },
  /** Boot-top band (body y): antifouling below `lo`, navy up to `hi`. */
  boot: { lo: 0, hi: 0 },
} as const;
// the boot top straddles the static waterline
(CRUISE_SHAPE.boot as { lo: number; hi: number }).lo = CRUISE_SHAPE.waterlineY - 0.6;
(CRUISE_SHAPE.boot as { lo: number; hi: number }).hi = CRUISE_SHAPE.waterlineY + 1.0;

/** The hull's drawn deck edge at z: half-breadth and height (the loft's PCHIP section). */
export function hullDeckAt(z: number): { half: number; y: number } {
  const s = hullSectionAt(STATIONS, z);
  return { half: s.deckHalf, y: s.deckY };
}

/** Half-width of a tier at body z (0 outside it): rounded ends (elliptical in plan), clipped to the hull. */
export function tierHalfAt(t: TierSpec, z: number): number {
  if (z < t.zFwd || z > t.zAft) return 0;
  let f = 1;
  if (z < t.zFwd + t.roundFwd) {
    const u = (t.zFwd + t.roundFwd - z) / t.roundFwd;
    f = Math.sqrt(Math.max(0, 1 - u * u));
  } else if (z > t.zAft - t.roundAft) {
    const u = (z - (t.zAft - t.roundAft)) / t.roundAft;
    f = Math.sqrt(Math.max(0, 1 - u * u));
  }
  return Math.max(0, Math.min(t.half * f, hullDeckAt(z).half - t.inset));
}

/** The tier's outline sample positions along z (dense in the rounded ends). */
export function tierZs(t: TierSpec, midStep = 8): number[] {
  const zs: number[] = [];
  const nEnd = 9;
  for (let i = 0; i < nEnd; i++) zs.push(t.zFwd + t.roundFwd * (1 - Math.cos((i / nEnd) * (Math.PI / 2))));
  const a = t.zFwd + t.roundFwd;
  const b = t.zAft - t.roundAft;
  const n = Math.max(1, Math.ceil((b - a) / midStep));
  for (let i = 0; i < n; i++) zs.push(a + ((b - a) * i) / n);
  for (let i = 0; i <= nEnd; i++) zs.push(b + t.roundAft * Math.sin((i / nEnd) * (Math.PI / 2)));
  return zs;
}

/** Nav lights (body frame): sidelights on the bridge wings, the masthead lights, the stern light. */
export const CRUISE_LIGHTS = {
  port: { x: -CRUISE_SHAPE.bridge.wingHalf + 0.3, y: CRUISE_SHAPE.bridge.roofY + 0.5, z: CRUISE_SHAPE.bridge.wingZ0 + 1.5 },
  starboard: { x: CRUISE_SHAPE.bridge.wingHalf - 0.3, y: CRUISE_SHAPE.bridge.roofY + 0.5, z: CRUISE_SHAPE.bridge.wingZ0 + 1.5 },
  masthead: { x: 0, y: CRUISE_SHAPE.mast.y1 + 0.3, z: CRUISE_SHAPE.mast.z },
  aftMasthead: { x: CRUISE_SHAPE.aftMast.x, y: CRUISE_SHAPE.aftMast.y1 - 0.3, z: CRUISE_SHAPE.aftMast.z },
  stern: { x: 0, y: stN.deckY + 1.2, z: zStern + 0.3 },
} as const;
