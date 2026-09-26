/**
 * Marine wildlife tunables (PURE): counts, where the animals live, how they move, how far they are
 * drawn. Kept in the wildlife module (not src/config.ts) so the sea's animals can be tuned without
 * touching the shared config; every number the wildlife code uses lives here.
 *
 * Frame: world +X east, +Z south (the sea is south of the coast), heading clockwise from north.
 */
import { CONFIG } from '../../config';
import { PLATFORM_SITE } from '../offshore/sites';

export interface Circle {
  x: number;
  z: number;
  r: number;
}
export interface Box {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export const WILDLIFE = {
  seed: 0x5eab1d5,
  /** Places no animal goes (other features of the sea), by species. */
  zones: {
    /** Naval gunnery range (shells land there; CONFIG.combat.gunnery.center): every species keeps `r` away. */
    gunnery: { x: CONFIG.combat.gunnery.center.x, z: CONFIG.combat.gunnery.center.z, r: 4000 } as Circle,
    /** Oil platform (src/world/offshore/sites.ts PLATFORM_SITE): whales and dolphins keep `r` away (gulls may visit it). */
    oilRig: { x: PLATFORM_SITE.x, z: PLATFORM_SITE.z, r: 1500 } as Circle,
    /** Offshore wind farm and the jet-ski race course (+ margins). */
    windFarm: { x0: 8800, x1: 13700, z0: 9400, z1: 12200 } as Box,
    jetSkiCourse: { x0: -3150, x1: -1550, z0: 7550, z1: 8450 } as Box,
    /** Cruise terminal and naval pier: from the coast out to z1 (m past the coast line). */
    // (the cruise pier runs ~735 m out, the naval pier's T-head face ~805 m: src/world/harbour/layout.ts)
    cruiseTerminal: { x0: -4250, x1: -3200, z0: -200, z1: 850 } as Box,
    navalPier: { x0: -6400, x1: -5300, z0: -200, z1: 950 } as Box,
    /** Marina structures: margin (m) from any breakwater, pontoon or quay for swimming animals. */
    marinaMargin: 60,
    /** Islands: swimming animals keep this far off the island's radius (m). */
    islandMargin: 120,
  },
  dolphin: {
    /** Least water depth under a pod's route (m). */
    minDepth: 5,
    /** Body length (m) of an adult bottlenose, and the size spread. */
    length: 2.7,
    sizeSpread: 0.12,
    /** Coastal pods: centre (x, z), radii of their wandering loop (m), members, cruising speed (m/s). */
    pods: [
      { x: 3300, z: 7250, rx: 520, rz: 300, n: 6, speed: 2.4 },
      { x: -8200, z: 8800, rx: 900, rz: 280, n: 5, speed: 2.8 },
      { x: -4700, z: 9900, rx: 650, rz: 420, n: 7, speed: 3.0 },
      { x: -600, z: 9600, rx: 900, rz: 450, n: 4, speed: 2.6 },
      { x: -1800, z: 13350, rx: 1100, rz: 300, n: 8, speed: 3.4 },
      { x: 6100, z: 9350, rx: 700, rz: 350, n: 5, speed: 2.5 },
      { x: -11200, z: 9300, rx: 800, rz: 350, n: 3, speed: 2.2 },
    ],
    /** Big ships whose bow wave a pod plays in, by traffic route id, and that pod's size. */
    shipPods: [
      { route: 'container-0', n: 6 },
      { route: 'tanker-0', n: 5 },
      { route: 'ferry-0', n: 4 },
    ],
    /** Ship pods: ride windows (s) — every `period`, for `ride` s (joining / leaving over `join` s). */
    shipRide: { period: 720, ride: 330, join: 35 },
    /** Breathing cycle (s): cruising, porpoising (fast), riding a bow wave. */
    breathe: { cruise: [11, 22] as [number, number], ride: [3.6, 6.5] as [number, number] },
    /** Chance that a surfacing is a clean leap: cruising, riding. */
    leap: { cruise: 0.07, ride: 0.18 },
    /** Bow riding (the player's vessel): speed window (kt), reach (m), limits (s). */
    ride: {
      minKt: 6,
      maxKt: 25,
      /** Keep riding while the speed stays inside this wider window (kt). */
      holdMinKt: 4.5,
      holdMaxKt: 28,
      reach: 300,
      /** How long a ride lasts (s, per engagement, deterministic from the engagement count). */
      duration: [55, 140] as [number, number],
      /** Give up the approach after (s). */
      approachTimeout: 70,
      /** Peel-off (s), then swim home underwater; no new engagement for `cooldown` s. */
      peel: 9,
      cooldown: 90,
      /** Swimming limits: acceleration (m/s²), burst speed (m/s), speed over the vessel's when catching up. */
      accel: 5,
      burst: 9,
      catchUp: 3.5,
      /** Swimming home after a ride (m/s). */
      homeSpeed: 5,
      /** Clearance from the hull's plan footprint (m): no dolphin centre ever inside the grown box. */
      hullClearance: 0.7,
    },
    /** Drawn out to (m from the camera); simulated only inside `drawDistance + 200`. */
    drawDistance: 1600,
  },
  whale: {
    /** Humpbacks: route centre, radii, speed (m/s), length (m); `calf` = a calf swims with her. */
    whales: [
      { x: -3700, z: 12350, rx: 650, rz: 250, speed: 1.1, length: 13.5, calf: true },
      { x: -8600, z: 12900, rx: 900, rz: 450, speed: 1.3, length: 14.5, calf: false },
      { x: 8800, z: 13300, rx: 1100, rz: 400, speed: 1.2, length: 13.8, calf: false },
      { x: 15000, z: 12900, rx: 1200, rz: 500, speed: 1.4, length: 15.0, calf: false },
      { x: 1200, z: 13250, rx: 900, rz: 200, speed: 1.0, length: 12.8, calf: false },
    ],
    /** Offshore: z beyond this (m), depth at least (m). */
    minZ: 11500,
    minDepth: 18,
    /** A surfacing sequence: blows per sequence, seconds between them, the terminal dive (s). */
    blows: [3, 6] as [number, number],
    blowInterval: [26, 40] as [number, number],
    dive: [110, 200] as [number, number],
    /** Chance a sequence opens with a breach. */
    breachChance: 0.35,
    /** Blow: height (m), rise time (s), how long the vapour hangs (s). */
    blowHeight: 4.2,
    blowLife: 5.5,
    drawDistance: 14000,
  },
  gull: {
    /** Herring gull: wingspan (m). */
    span: 1.35,
    /** Flocks wheeling over the marina and the harbour: centre (marina u, w or world x, z), birds, radius, height (m). */
    flocks: [
      { frame: 'marina' as const, u: -40, w: 170, n: 22, r: 55, alt: 16 },
      { frame: 'marina' as const, u: 10, w: 360, n: 14, r: 40, alt: 12 },
      { frame: 'world' as const, u: -3700, w: 8050, n: 16, r: 60, alt: 32 },
      { frame: 'world' as const, u: -5900, w: 8000, n: 10, r: 50, alt: 26 },
    ],
    /** Perched birds: on the breakwater crests, piles, beacons and the quay. */
    perched: { breakwater: 26, piles: 12, visitorPiles: 2, beacons: 2, quay: 8 },
    /** Birds trailing each fishing boat (traffic kind 'fish'), and following the player's boat. */
    fishing: 16,
    player: 7,
    /** Following the player needs this speed (kt); they give up after this long stopped (s). */
    playerMinKt: 4,
    playerLinger: 25,
    /** Scatter: a boat / aircraft / the camera within (m) flushes perched birds and pushes flying ones away. */
    scatter: { boat: 38, aircraft: 90, camera: 10, flee: 9 },
    /** Nothing ever closer to the camera than this (m). */
    cameraClearance: 4.5,
    /** Drawn as birds out to (m), as dots beyond (to `dotDistance`). */
    meshDistance: 520,
    dotDistance: 2200,
  },
  seal: {
    /** Seal Rock and how many harbour seals haul out on it. */
    rock: { x: 7800, z: 10831, r: 420 } as Circle,
    n: 9,
    /** Hauled out between these terrain heights (m). */
    minH: 0.45,
    maxH: 2.6,
    drawDistance: 1800,
  },
} as const;

export type WildlifeTuning = typeof WILDLIFE;
