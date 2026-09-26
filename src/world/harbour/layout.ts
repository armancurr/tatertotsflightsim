/**
 * The big-ship port (PURE, no three.js): the cruise terminal east of the Port Chateau marina and the
 * naval pier west of it, as plain data in each pier's own frame — what the models draw
 * (src/world/harbour/models.ts), what the physics hits (src/world/harbour/obstacles.ts) and where a
 * ship berths (src/world/port.ts `portBerths`).
 *
 * The sea off Port Chateau shoals gently (≈ 11 m of water 500 m out, 17 m at 1 km), so rather than
 * dredging a berth pocket (which would have to be carved identically into the physics ground, the
 * terrain mesh and the water shader's baked depth) both piers run out on piles to water deep enough
 * for the largest ship each takes, the way deep-water jetties are built:
 *
 *  - Cruise terminal (x ≈ −3,420): a trestle from the beach, then a 40 m wide berthing pier heading
 *    175° (out to sea). The ship lies along its west face, port side to, bow to the open sea, so it
 *    casts off and drives straight out. The terminal building stands on the pier with two jet
 *    bridges to the ship's side; the car park and bus bays are on a raised apron ashore.
 *  - Naval pier (x ≈ −5,720): a long trestle perpendicular to the coast and a T-head parallel to it.
 *    The ship lies along the T-head's seaward face, starboard side to, bow west to open water, with
 *    navy-grey fender camels between hull and pier; a utility building and a portal crane on the head.
 *
 * How far out each berth has to be is found from the heightfield (the smallest distance at which
 * the largest ship's whole footprint has `maxDraft + SHIP_UNDER_KEEL` of water), so it is always
 * deep enough by construction and tests/world/harbour checks it again.
 *
 * Pier frame: world = o + u·U + w·W, U = out along the pier (heading `headingU`), W = U turned 90° to
 * the right (heading `headingW`); heights m MSL. Geometry is built with x = u, z = w (right-handed,
 * y up) and placed with a rotation about y of atan2(−uz, ux).
 */
import { CONFIG, type Config } from '../../config';
import { getLayout, type WorldLayout } from '../layout';
import { getHeightfield } from '../heightfield';
import type { WaterWorld, XZ } from '../traffic/sea';

export interface PierFrame {
  ox: number;
  oz: number;
  ux: number;
  uz: number;
  wx: number;
  wz: number;
  headingU: number;
  headingW: number;
}

export const pierWorld = (f: PierFrame, u: number, w: number): XZ => ({ x: f.ox + f.ux * u + f.wx * w, z: f.oz + f.uz * u + f.wz * w });
export const pierLocal = (f: PierFrame, x: number, z: number): { u: number; w: number } => {
  const dx = x - f.ox;
  const dz = z - f.oz;
  return { u: dx * f.ux + dz * f.uz, w: dx * f.wx + dz * f.wz };
};
/** Rotation about +y that turns the geometry frame (x = u, z = w) into the pier frame. */
export const pierYaw = (f: PierFrame): number => Math.atan2(-f.uz, f.ux);

const DEG = Math.PI / 180;
const hdg = (dx: number, dz: number): number => ((Math.atan2(dx, -dz) / DEG) % 360 + 360) % 360;

/** A frame from an origin and the heading of U (W = U turned right). */
export function frameFrom(ox: number, oz: number, headingU: number): PierFrame {
  const h = headingU * DEG;
  const ux = Math.sin(h);
  const uz = -Math.cos(h);
  // right of U: (cos h, sin h)
  return { ox, oz, ux, uz, wx: Math.cos(h), wz: Math.sin(h), headingU: ((headingU % 360) + 360) % 360, headingW: (((headingU + 90) % 360) + 360) % 360 };
}

/** The largest vessel each berth takes (m). A berth's water is ≥ maxDraft + SHIP_UNDER_KEEL deep everywhere. */
export const BERTH_LIMITS = {
  visitor: { length: 20, beam: 4.6, draft: 2.0 },
  cruise: { length: 300, beam: 40, draft: 9.0 },
  naval: { length: 290, beam: 36, draft: 11.5 },
} as const;
/** Least water under a ship's keel at a ship berth, m. */
export const SHIP_UNDER_KEEL = 2.0;

/** Dimensions shared by the drawn piers and their obstacles. */
export const PORT_DIMS = {
  /** Pier deck height (the ferry terminals' too). */
  deckY: 4.4,
  deckThickness: 1.1,
  /** Hull ↔ pier face: pneumatic fenders (cruise) / floating camels (naval), m. */
  cruiseGap: 2.0,
  navalGap: 3.0,
  /** How far the fenders / camels stand out from the face (less than the gap). */
  fenderOut: 1.5,
  camelOut: 2.5,
  bollardTop: 0.75,
  bollardR: 0.35,
  kerbH: 0.3,
  lampH: 9,
  /** Jet bridge: height of its floor above the deck, width and height of the tube. */
  bridgeFloor: 7.5,
  bridgeW: 3.2,
  bridgeH: 3.2,
  terminalH: 16,
  /** The terminal's barrel-vaulted roof: rise above the eaves (m); the glazed atrium at its land end: length along the pier, height. */
  vaultRise: 3.5,
  atriumLen: 18,
  atriumH: 22,
  navalBuildingH: 8.5,
  crane: { height: 24, legSpan: 14, legGauge: 10 },
} as const;

/** One berth's quay face in world coordinates: the vessel lies alongside it, bow toward b. */
export interface BerthFace {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** Unit normal from the face into the berth water. */
  nx: number;
  nz: number;
  /** The vessel's heading at the berth (a → b), deg. */
  headingDeg: number;
  /** Where the middle of a berthed hull lies along the face (world). */
  cx: number;
  cz: number;
  /** Hull ↔ face gap, m. */
  gap: number;
  /** Which side of the vessel lies against the face. */
  side: 'port' | 'starboard';
}

export interface Rect {
  u0: number;
  u1: number;
  w0: number;
  w1: number;
}

export interface CruiseTerminalLayout {
  frame: PierFrame;
  deckY: number;
  /** Approach trestle from the shore (u0 is on land) to the berthing pier. */
  trestle: { u0: number; u1: number; half: number };
  /** The berthing pier; its +w edge (w1) is the berth face. */
  pier: Rect;
  /** Where the largest ship's stern lies (pier u) — the berth starts just before it. */
  sternU: number;
  building: Rect & { height: number };
  /** Jet bridges from the building's upper floor out over the face (w1 of each ends past the face, inside the gap). */
  bridges: { u: number; w0: number; w1: number; y: number }[];
  /** The raised apron ashore: car park, bus bays, forecourt (top = deckY, a retaining wall to the beach). */
  apron: Rect;
  /** Where the pier meets the shore (pier u of ground ≥ 1.5 m). */
  shoreU: number;
  /** Parked coaches and cars on the apron (centre, length along u, width along w, height), bus shelters. */
  vehicles: { u: number; w: number; len: number; wid: number; h: number; bus: boolean; tint: number }[];
  shelters: Rect[];
  bollards: { u: number; w: number }[];
  fenders: { u: number; w: number }[];
  lamps: { u: number; w: number; y: number }[];
  face: BerthFace;
}

export interface NavalPierLayout {
  frame: PierFrame;
  deckY: number;
  trestle: { u0: number; u1: number; half: number };
  /** The T-head: its seaward edge (u1) is the berth face. */
  head: Rect;
  building: Rect & { height: number };
  crane: { u: number; w: number };
  /** Containers and a truck on the T-head (centre, length along w, width along u, height). */
  stores: { u: number; w: number; len: number; wid: number; h: number; tint: number }[];
  /** Floating camels along the face (w extents), from the face out to camelOut. */
  camels: { w0: number; w1: number }[];
  bollards: { u: number; w: number }[];
  lamps: { u: number; w: number; y: number }[];
  /** A small raised apron ashore with the guard house on it. */
  apron: Rect;
  gate: Rect & { height: number };
  shoreU: number;
  face: BerthFace;
}

export interface PortWorks {
  cruise: CruiseTerminalLayout;
  naval: NavalPierLayout;
}

/** Where the piers leave the shore (world x) and the cruise pier's heading. */
export const PORT_SITES = { cruiseX: -3420, cruiseHeading: 175, navalX: -5720 } as const;

const defaultWater = (): WaterWorld => {
  const hf = getHeightfield();
  return { groundHeight: (x, z) => hf.height(x, z), waterLevel: (x, z) => hf.waterLevel(x, z) };
};

/** Water depth (m), −Infinity on land / off the sea. */
function depthAt(water: WaterWorld, x: number, z: number): number {
  const wl = water.waterLevel(x, z);
  if (wl === null || Math.abs(wl) > 0.5) return -Infinity;
  return wl - water.groundHeight(x, z);
}

/** Least depth over a pier-frame rectangle sampled every `step` m. */
export function rectMinDepth(water: WaterWorld, f: PierFrame, r: Rect, step = 5): number {
  let lo = Infinity;
  const nu = Math.max(1, Math.ceil((r.u1 - r.u0) / step));
  const nw = Math.max(1, Math.ceil((r.w1 - r.w0) / step));
  for (let i = 0; i <= nu; i++)
    for (let j = 0; j <= nw; j++) {
      const p = pierWorld(f, r.u0 + ((r.u1 - r.u0) * i) / nu, r.w0 + ((r.w1 - r.w0) * j) / nw);
      const d = depthAt(water, p.x, p.z);
      if (d < lo) lo = d;
      if (lo === -Infinity) return lo;
    }
  return lo;
}

/** The shoreline along the pier axis: the first u (marching landward from u = 0) with ground ≥ 1.5 m. */
function shoreU(water: WaterWorld, f: PierFrame): number {
  for (let u = 0; u > -600; u -= 5) {
    const p = pierWorld(f, u, 0);
    if (water.groundHeight(p.x, p.z) >= 1.5) return u;
  }
  return -600;
}

function makeFace(f: PierFrame, a: { u: number; w: number }, b: { u: number; w: number }, out: { u: number; w: number }, centre: { u: number; w: number }, gap: number): BerthFace {
  const A = pierWorld(f, a.u, a.w);
  const B = pierWorld(f, b.u, b.w);
  const C = pierWorld(f, centre.u, centre.w);
  const nx = f.ux * out.u + f.wx * out.w;
  const nz = f.uz * out.u + f.wz * out.w;
  const dx = B.x - A.x;
  const dz = B.z - A.z;
  // facing along d, the starboard (right) direction is (−dz, dx); the vessel is on the `out` side of
  // the face, so the face is on the vessel's other side
  const right = -dz * nx + dx * nz;
  return { ax: A.x, az: A.z, bx: B.x, bz: B.z, nx, nz, headingDeg: hdg(dx, dz), cx: C.x, cz: C.z, gap, side: right > 0 ? 'port' : 'starboard' };
}

/** The cruise terminal (see the file header). */
export function cruiseTerminal(layout: WorldLayout, water: WaterWorld): CruiseTerminalLayout {
  const D = PORT_DIMS;
  const L = BERTH_LIMITS.cruise;
  const x0 = PORT_SITES.cruiseX;
  const f = frameFrom(x0, layout.coast.zAt(x0), PORT_SITES.cruiseHeading);
  const half = 20;
  const face = half;
  // the berth water of the largest ship (+ 5 m around it): find the nearest stern position with the depth
  const need = L.draft + SHIP_UNDER_KEEL + 0.3;
  let sternU = 250;
  for (; sternU < 1500; sternU += 5) {
    const r = { u0: sternU - 5, u1: sternU + L.length + 5, w0: face + D.cruiseGap - 1, w1: face + D.cruiseGap + L.beam + 5 };
    if (rectMinDepth(water, f, r) >= need) break;
  }
  const pier = { u0: sternU - 60, u1: sternU + L.length + 15, w0: -half, w1: half };
  const building = { u0: sternU + 30, u1: sternU + 180, w0: -16, w1: 8, height: D.terminalH };
  const bridges = [sternU + 75, sternU + 140].map((u) => ({ u, w0: building.w1 - 0.5, w1: face + D.fenderOut + 0.1, y: D.deckY + D.bridgeFloor }));
  const bollards: CruiseTerminalLayout['bollards'] = [];
  for (let u = pier.u0 + 8; u <= pier.u1 - 4; u += 18) bollards.push({ u, w: face - 1.2 });
  const fenders: CruiseTerminalLayout['fenders'] = [];
  for (let u = pier.u0 + 14; u <= pier.u1 - 6; u += 18) fenders.push({ u, w: face + D.fenderOut / 2 });
  const su = shoreU(water, f);
  const lamps: CruiseTerminalLayout['lamps'] = [];
  for (let u = su + 20; u < pier.u0; u += 40) lamps.push({ u, w: -5.5, y: D.deckY + D.lampH });
  for (let u = pier.u0 + 10; u < pier.u1; u += 45) if (u < building.u0 - 4 || u > building.u1 + 4) lamps.push({ u, w: 12, y: D.deckY + D.lampH + 6 });
  const centre = { u: sternU + L.length / 2, w: face };
  // coaches in the bus bays by the forecourt, cars in four rows (perpendicular parking, aisles between)
  const vehicles: CruiseTerminalLayout['vehicles'] = [];
  const hash = (a: number, b: number) => {
    const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
    return x - Math.floor(x);
  };
  for (let k = 0; k < 4; k++) vehicles.push({ u: su - 14, w: -42 - k * 15, len: 12.2, wid: 2.55, h: 3.4, bus: true, tint: k });
  for (const [r, ur] of [su - 40, su - 46, su - 70, su - 76].entries())
    for (let w = -36, k = 0; w >= -104; w -= 2.8, k++) if (hash(r, k) < 0.72) vehicles.push({ u: ur, w, len: 4.5, wid: 1.8, h: 1.5, bus: false, tint: Math.floor(hash(r + 9, k) * 8) });
  const shelters = [0, 1, 2].map((k) => ({ u0: su - 6.5, u1: su - 4.5, w0: -48 - k * 15, w1: -40 - k * 15 }));
  return {
    frame: f,
    deckY: D.deckY,
    trestle: { u0: su - 12, u1: pier.u0, half: 7 },
    pier,
    sternU,
    building,
    bridges,
    apron: { u0: su - 95, u1: su + 2, w0: -110, w1: -9 },
    shoreU: su,
    vehicles,
    shelters,
    bollards,
    fenders,
    lamps,
    face: makeFace(f, { u: pier.u0, w: face }, { u: pier.u1, w: face }, { u: 0, w: 1 }, centre, D.cruiseGap),
  };
}

/** The naval pier (see the file header). */
export function navalPier(layout: WorldLayout, water: WaterWorld): NavalPierLayout {
  const D = PORT_DIMS;
  const L = BERTH_LIMITS.naval;
  const x0 = PORT_SITES.navalX;
  const z0 = layout.coast.zAt(x0);
  // perpendicular to the local coast, out to sea
  const s = (layout.coast.zAt(x0 + 150) - layout.coast.zAt(x0 - 150)) / 300;
  const f = frameFrom(x0, z0, hdg(-s, 1));
  const need = L.draft + SHIP_UNDER_KEEL + 0.3;
  const headHalf = 170;
  let uF = 300;
  for (; uF < 2000; uF += 5) {
    const r = { u0: uF + D.navalGap - 1, u1: uF + D.navalGap + L.beam + 5, w0: -L.length / 2 - 5, w1: L.length / 2 + 5 };
    if (rectMinDepth(water, f, r) >= need) break;
  }
  const head = { u0: uF - 24, u1: uF, w0: -headHalf, w1: headHalf };
  const camels: NavalPierLayout['camels'] = [];
  for (let w = -headHalf + 14; w <= headHalf - 14; w += 34) camels.push({ w0: w - 6, w1: w + 6 });
  const bollards: NavalPierLayout['bollards'] = [];
  for (let w = -headHalf + 6; w <= headHalf - 6; w += 17) bollards.push({ u: uF - 1.2, w });
  const su = shoreU(water, f);
  const lamps: NavalPierLayout['lamps'] = [];
  for (let u = su + 25; u < head.u0; u += 50) lamps.push({ u, w: 5, y: D.deckY + D.lampH });
  for (let w = -headHalf + 20; w <= headHalf - 20; w += 50) lamps.push({ u: head.u0 + 3, w, y: D.deckY + D.lampH + 4 });
  // the vessel heads along +W (west): the face runs from the head's −w end to its +w end
  return {
    frame: f,
    deckY: D.deckY,
    trestle: { u0: su - 12, u1: head.u0, half: 6 },
    head,
    building: { u0: head.u0 + 1.5, u1: head.u0 + 11.5, w0: 28, w1: 64, height: D.navalBuildingH },
    crane: { u: uF - 9.5, w: -70 },
    stores: [
      { u: head.u0 + 5, w: -18, len: 12.2, wid: 2.44, h: 2.6, tint: 0 },
      { u: head.u0 + 5, w: -31.5, len: 12.2, wid: 2.44, h: 2.6, tint: 1 },
      { u: head.u0 + 8, w: -24, len: 6.1, wid: 2.44, h: 2.6, tint: 2 },
      { u: head.u0 + 6, w: 90, len: 7.5, wid: 2.5, h: 3.1, tint: 3 },
      { u: head.u0 + 5, w: 118, len: 6.1, wid: 2.44, h: 2.6, tint: 1 },
    ],
    camels,
    bollards,
    lamps,
    apron: { u0: su - 60, u1: su + 2, w0: -30, w1: 30 },
    gate: { u0: su - 40, u1: su - 32, w0: 8, w1: 14, height: 3.4 },
    shoreU: su,
    face: makeFace(f, { u: uF, w: -headHalf }, { u: uF, w: headHalf }, { u: 1, w: 0 }, { u: uF, w: 0 }, D.navalGap),
  };
}

const cache = new WeakMap<WorldLayout, WeakMap<Config, PortWorks>>();

/** Both piers (cached per layout + config; the default water is the heightfield). */
export function portWorks(layout: WorldLayout = getLayout(), cfg: Config = CONFIG, water?: WaterWorld): PortWorks {
  if (water) return { cruise: cruiseTerminal(layout, water), naval: navalPier(layout, water) };
  let byCfg = cache.get(layout);
  if (!byCfg) cache.set(layout, (byCfg = new WeakMap()));
  let w = byCfg.get(cfg);
  if (!w) {
    const wt = defaultWater();
    w = { cruise: cruiseTerminal(layout, wt), naval: navalPier(layout, wt) };
    byCfg.set(cfg, w);
  }
  return w;
}
