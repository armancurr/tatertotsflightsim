/**
 * USS Iowa (BB-61) shape tables (pure, no three.js). The hull is the physics' own station table
 * (IOWA_AIRCRAFT.watercraft.hull.stations, via src/vessels/hullSection.ts); everything above the
 * main deck is placed here in the ship's own measurements — `s` metres aft of the stem and `h`
 * metres above the design waterline — and converted to the body frame with IOWA_FRAME
 * (bz(s) = s − stemToCg, by(h) = h + cgBelowWl). Positions follow the 1984-modernised ship's
 * general arrangement: turrets I and II forward (II superfiring), the conning tower and the
 * pilot house (04 level), the tower foremast, two funnels, the rebuilt mainmast, turret III aft
 * and the helicopter pad on the fantail; the six remaining 5-inch/38 twin mounts (three a side),
 * eight Tomahawk armoured box launchers, four Harpoon quad canisters and four Phalanx CIWS.
 */
import { IOWA_AIRCRAFT, IOWA_FRAME, IOWA_WEAPONS } from '../../config';
import { hullSectionAt, type HullSection } from '../hullSection';
import { deckHeightAt } from '../hullLoft';

export const WC = IOWA_AIRCRAFT.watercraft!;
export const STATIONS = WC.hull.stations;
export const GEO = IOWA_AIRCRAFT.geometry;
export const TURRETS = IOWA_WEAPONS.naval!.turrets;

/** Body z of a point `s` m aft of the stem; body y of a height `h` m above the design waterline. */
export const bz = (s: number): number => s - IOWA_FRAME.stemToCg;
export const by = (h: number): number => h + IOWA_FRAME.cgBelowWl;
/** Back from the body frame: metres aft of the stem, and height above the waterline. */
export const sOf = (z: number): number => z + IOWA_FRAME.stemToCg;
export const hOf = (y: number): number => y - IOWA_FRAME.cgBelowWl;

/** The hull section at body z (the physics' table, PCHIP between stations as the loft draws it). */
export const sec = (z: number, out?: HullSection): HullSection => hullSectionAt(STATIONS, z, out);

/** Main-deck camber at the centreline, m. */
export const DECK_CAMBER = 0.3;

/** Main-deck height (body y) at body (x, z): the sheer line plus the camber. */
export function deckY(x: number, z: number): number {
  const s = sec(z);
  return deckHeightAt(s, Math.min(Math.abs(x), s.deckHalf), DECK_CAMBER);
}

/** Superstructure deck levels, height above the waterline (the 01 … 05 levels amidships). */
export const LEVEL = { main: 7.4, l01: 10.3, l02: 13.0, l03: 15.7, l04: 18.6, l05: 21.5 } as const;

export const IOWA_SHAPE = {
  zStem: STATIONS[0].z,
  zTransom: STATIONS[STATIONS.length - 1].z,
  /** Where the hull breaks in two for the crash (between turret II and the conning tower's base). */
  zBreak: bz(112),
  /** Barbette outer radius (39 ft 4 in diameter). */
  barbetteR: 6.0,
  /** Conning tower: centre, semi-axes (x, z), from the main deck up to its roof (the 04 level). */
  conningTower: { s: 101.5, rx: 4.0, rz: 4.6, top: LEVEL.l04 },
  /** Pilot house (04 level) around the helm, and its window band (m above the 04 deck). */
  pilotHouse: { s0: 93.5, s1: 101, half: 6.2, winLo: 0.95, winHi: 2.45, roof: 2.8 },
  /** The tower foremast (the "tower" behind the conning tower): centre, radius, top; the foremast pole top. */
  tower: { s: 108, r: 3.4, top: 36.5, mastTop: 62 - IOWA_FRAME.draft },
  /** Funnels: centre s, half-width (x), half-length (s), top (h). */
  funnels: [
    { s: 128, hx: 4.6, hs: 6.2, top: 30.5 },
    { s: 151.5, hx: 4.4, hs: 5.6, top: 28.5 },
  ],
  /** The mainmast (rebuilt in 1984) aft of the second funnel. */
  mainmast: { s: 162, top: 41 },
  /** 5-inch/38 twin mounts: s, |x|, level (deck height they sit on), train (deg, 0 = forward). */
  fiveInch: [
    { s: 100, x: 11.6, deck: LEVEL.l01, train: 0 },
    { s: 113.5, x: 9.3, deck: LEVEL.l02, train: 0 },
    { s: 127, x: 11.6, deck: LEVEL.l01, train: 180 },
  ],
  /** Tomahawk armoured box launchers (4 missiles each): s of the box's centre, |x|, the deck under it. */
  tomahawk: [
    { s: 139.5, x: 10.8, deck: LEVEL.l01 },
    { s: 147, x: 10.8, deck: LEVEL.l01 },
    { s: 166.5, x: 9.4, deck: LEVEL.l01 },
    { s: 174, x: 9.4, deck: LEVEL.l01 },
  ],
  /** Harpoon quad canisters: s, |x|, deck. */
  harpoon: [
    { s: 157, x: 6.2, deck: LEVEL.l02 },
    { s: 160.5, x: 6.2, deck: LEVEL.l02 },
  ],
  /** Phalanx CIWS: s, |x|, deck. */
  ciws: [
    { s: 119.5, x: 8.0, deck: LEVEL.l03 },
    { s: 166, x: 5.6, deck: LEVEL.l03 },
  ],
  /** Helicopter landing pad on the fantail (aft of turret III): centre s, half-size (square), circle radius. */
  helipad: { s: 240, half: 10, circleR: 7.4 },
  /** Hull number on both bows: s range of the digits, height of the digits' base and their height. */
  hullNumber: { s0: 22, s1: 35, base: 6.6, height: 3.6 },
} as const;

/** Nav lights (body frame): masthead (fore), range (main), sidelights on the bridge wings, stern. */
export const IOWA_LIGHTS = {
  masthead: { x: 0, y: by(44.5), z: bz(109.5) },
  range: { x: 0, y: by(38), z: bz(162.6) },
  port: { x: -7.9, y: by(LEVEL.l04 + 1.3), z: bz(95) },
  starboard: { x: 7.9, y: by(LEVEL.l04 + 1.3), z: bz(95) },
  stern: { x: 0, y: by(6.9), z: bz(269.6) },
} as const;
