/**
 * Deterministic building placement for the whole world. PURE (no three.js).
 *
 * Buildings are placed on lots walked along both sides of every street and
 * through-road of each settlement (so they line the streets, with gardens
 * implied by the setbacks and the gaps between lots), in zones by distance
 * from the centre: the coastal city gets a downtown of towers, offices and
 * apartment blocks, a harbour of warehouses and suburbs of houses; towns a
 * main street of shops; villages houses around a church with a spire. Industrial
 * sheds line the main roads at the edges. Farmsteads (farmhouse, red barn,
 * silos, machine shed) stand at the farm sites of the road network, and a few
 * houses are scattered along the country roads.
 *
 * Every building is oriented to face its nearest road segment and is kept clear
 * of roads, water, the airport and every other building; its base sits at the
 * lowest ground under the footprint (walls extend up from there).
 */
import { CONFIG } from '../../config';
import type { WorldLayout, Town } from '../layout';
import { createSimplex2D, mulberry32 } from '../noise';
import type { RoadNetwork, NetRoad, TownsConfig } from '../roads/network';
import { SegmentGrid, RectHash, makeRect, headingOf, cumulativeLength, type Rect, type XZ } from './geom';

export type Archetype = 'gable' | 'hip' | 'flat' | 'gambrel' | 'silo';
export const ARCHETYPES: readonly Archetype[] = ['gable', 'hip', 'flat', 'gambrel', 'silo'];

export type BuildingUse =
  | 'house'
  | 'apartment'
  | 'shop'
  | 'office'
  | 'tower'
  | 'industrial'
  | 'warehouse'
  | 'church'
  | 'steeple'
  | 'farmhouse'
  | 'barn'
  | 'silo'
  | 'shed'
  | 'tree'
  | 'pool'
  | 'garage'
  | 'watertower'
  | 'school'
  | 'townhall'
  | 'tank';

/** Facade style ids used by the building shader. */
export const STYLE = { house: 0, apartment: 1, office: 2, industrial: 3, barn: 4, church: 5, silo: 6, shop: 7, shed: 8, tree: 13, pool: 14, civic: 15 } as const;
/** Extra facade styles for derived pieces (rooftop units, tanks, masts, penthouses). */
export const STYLE_X = { hvac: 9, tank: 10, mast: 11, plain: 12 } as const;

/** Props that are not buildings: trees and pools (no windows, no street front). */
export const isProp = (b: Pick<Building, 'use'>): boolean => b.use === 'tree' || b.use === 'pool';

export interface Building {
  /** Footprint centre, m. */
  x: number;
  z: number;
  /** Base elevation (m MSL): at or just below the lowest ground under the footprint. */
  y: number;
  /** Direction the front (door) faces — toward its street for town buildings. */
  headingDeg: number;
  /** Extent across the front / front-to-back, m. */
  width: number;
  depth: number;
  /** Wall height above `y` (includes the extra height on sloping ground), m. */
  wallHeight: number;
  /** Roof rise above the walls (parapet height for flat roofs, dome for silos), m. */
  roofHeight: number;
  /** Hip roofs: ridge length as a fraction of the building length along it (0 = pyramid). Silos: 1 = dome, 0 = cone (grain bin). */
  ridge: number;
  /** 0 = ridge parallel to the front (width axis), 1 = ridge front-to-back (gable end to the street). */
  ridgeAxis: 0 | 1;
  archetype: Archetype;
  use: BuildingUse;
  wallColor: number;
  roofColor: number;
  /** Storey height for the window grid, m (0 = no windows). */
  floorHeight: number;
  style: number;
  /** Stable random in [0, 1) for shader variation. */
  rand: number;
  /** Settlement index (−1 = countryside) and farm index (−1 = not a farm building). */
  town: number;
  farm: number;
  /** Height of the base below the ground floor (the extra wall on sloping ground), m. Set by the placement. */
  plinth?: number;
  /**
   * Flat-roofed towers with a setback: the full footprint rises to `tierHeight` above `y` (plus the
   * parapet), the upper tier — the footprint inset by `tierInset` on every side — to the full height.
   */
  tierHeight?: number;
  tierInset?: number;
}

export interface PlacementOptions {
  seed?: number;
  cfg?: TownsConfig;
}

// ─── Roof profile / obstacles ─────────────────────────────────────────────────

export function buildingRect(b: Building): Rect {
  return makeRect(b.x, b.z, b.headingDeg, b.width, b.depth);
}

/** Gambrel cross-section: height fraction at normalised distance t from the ridge (0) to the eave (1). */
export const GAMBREL_KNEE_T = 0.64;
export const GAMBREL_KNEE_H = 0.62;
export function gambrelFrac(t: number): number {
  return t >= GAMBREL_KNEE_T ? (GAMBREL_KNEE_H * (1 - t)) / (1 - GAMBREL_KNEE_T) : GAMBREL_KNEE_H + ((1 - GAMBREL_KNEE_H) * (GAMBREL_KNEE_T - t)) / GAMBREL_KNEE_T;
}

const DEG = Math.PI / 180;
/** Tree crowns: height fraction of the widest ring (twin of archetypes.TREE_EQ; asserted equal in the tests). */
export const TREE_EQ_P = 0.42;

/**
 * Height (m MSL) of the top of the building at (x, z) — the roof surface over
 * the footprint (parapet top for flat roofs) — or −Infinity outside it.
 * Allocation-free.
 */
export function roofTopAt(b: Building, x: number, z: number): number {
  const h = b.headingDeg * DEG;
  const fx = Math.sin(h);
  const fz = -Math.cos(h);
  const dx = x - b.x;
  const dz = z - b.z;
  const u = dx * -fz + dz * fx;
  const v = dx * fx + dz * fz;
  const hw = b.width / 2;
  const hd = b.depth / 2;
  if (b.archetype === 'silo') {
    const r2 = (u * u + v * v) / (hw * hw);
    if (r2 > 1) return -Infinity;
    // a tree: the crown's upper half (an ellipsoid cap from its widest ring), lumps only pull it in
    if (b.use === 'tree') return b.y + b.wallHeight + b.roofHeight * (TREE_EQ_P + (1 - TREE_EQ_P) * Math.sqrt(1 - r2));
    return b.y + b.wallHeight + b.roofHeight * (b.ridge < 0.5 ? 1 - Math.sqrt(r2) : Math.sqrt(1 - r2));
  }
  const au = Math.abs(u);
  const av = Math.abs(v);
  if (au > hw || av > hd) return -Infinity;
  const tier = b.tierHeight ?? 0;
  if (b.archetype === 'flat' && tier > 0) {
    const ins = b.tierInset ?? 0;
    const onTop = au <= hw - ins && av <= hd - ins;
    return b.y + (onTop ? b.wallHeight : tier) + b.roofHeight;
  }
  let frac = 1;
  if (b.archetype !== 'flat') {
    const p = b.ridgeAxis === 0 ? au : av; // along the ridge
    const lp = b.ridgeAxis === 0 ? hw : hd;
    const c = b.ridgeAxis === 0 ? av : au; // across the ridge
    const sc = b.ridgeAxis === 0 ? hd : hw;
    const t = c / sc;
    if (b.archetype === 'gable') frac = 1 - t;
    else if (b.archetype === 'gambrel') frac = gambrelFrac(t);
    else {
      const rl = b.ridge * lp;
      const end = lp - rl > 1e-9 ? (lp - p) / (lp - rl) : 1;
      frac = Math.min(1 - t, end, 1);
    }
  }
  return b.y + b.wallHeight + b.roofHeight * (frac > 0 ? frac : 0);
}

/** Size used for distance culling: the larger of the height and ~the footprint. */
export function visualSize(b: Building): number {
  return Math.max(b.wallHeight + b.roofHeight * 0.6, 0.7 * Math.max(b.width, b.depth));
}

// ─── Palettes ─────────────────────────────────────────────────────────────────

/** Painted siding / render of American-style houses (and their brick ones). */
const WALL_HOUSE = [0xf0eee8, 0xe9e4d6, 0xe4d8b0, 0xd2d3cf, 0xb4c0c6, 0xb8c2aa, 0xd3c2a0, 0xa99f8e, 0xc9b79c, 0x9aa7ae, 0xa0553f, 0x8e4a36, 0x9b6049, 0xe6e1d3];
/** Mediterranean-style render of the coastal city (ochre, salmon, cream, pale blue…). */
const WALL_HOUSE_EU = [0xe2c48a, 0xe0ab8c, 0xefe6cf, 0xefdc9e, 0xf2efe8, 0xcf9474, 0xc3d0d6, 0xdccaa6, 0xd7b8a0, 0xb86a4e, 0xe8d3b5];
const WALL_APT = [0xd9d1c2, 0xcbbca4, 0xbcb6ad, 0xe2d8ca, 0x9e5c44, 0xc6c2b8, 0xd4c4a8, 0xa8a49c, 0xe0cfa8, 0x8f5a44];
/** Coated glass of curtain walls (the shader turns the tint into a reflectance). */
const WALL_GLASS = [0x5d7f8c, 0x4f6a86, 0x7b6a58, 0x8c969e, 0x3c464e, 0x6f8f8a, 0x9aa9b6, 0x566b7c];
/** Precast concrete / stone of punched-window offices. */
const WALL_CONCRETE = [0xc9c4b8, 0xb5b0a6, 0xd6d0c2, 0x9c9990, 0xbfae96, 0xa8a49c];
const WALL_SHOP = [0xe0d4bc, 0xcfb99a, 0xb45f45, 0xd9c9a0, 0xe8e2d4, 0xa9b4a8, 0xc98f6c, 0x9e4f3a, 0x8c4a38];
/** Main-street commercial blocks of the American town: mostly brick. */
const WALL_SHOP_TOWN = [0xa3553f, 0x8e4a36, 0xb06448, 0x9b5b45, 0x7f4535, 0xcfb99a, 0xd9c9a0, 0xe0d4bc];
const WALL_INDUSTRIAL = [0xb9bdbf, 0x9fa7a8, 0xc4b89e, 0xa8b0b4, 0x8c9699, 0xd0ccc0];
const WALL_BARN_RED = [0x8e2b22, 0x9b3426, 0x7f271f, 0xa33a2a];
const WALL_BARN_OTHER = [0x7a7068, 0xe6e2d8, 0x6e6258];
const WALL_SILO = [0xc9cacb, 0x2f4a6a, 0xb7bcc0, 0xd6d2c8];
const WALL_SHED = [0x9ea5a6, 0x5f7a5a, 0xb5a98e, 0x8a3a2e, 0xa7adb0];
const WALL_CHURCH = [0xcfc6b4, 0xe7e2d6, 0xb9ae98, 0xd8d0c0];
/** Tree foliage (sRGB): deciduous greens, a few darker conifers, a purple-leaf plum, a pale birch. */
const FOLIAGE = [0x4f6b35, 0x5a7a3a, 0x445f2e, 0x68834a, 0x4a6438, 0x3b5530, 0x5f7440, 0x55703e];
const FOLIAGE_CONIFER = [0x2f4a33, 0x36523a, 0x2c4430];
const FOLIAGE_ODD = [0x5e3f3c, 0x7c9355, 0x8a8a4a];

const ROOF_TERRACOTTA = [0xa65a3e, 0x9d5439, 0xb0653f, 0x914c36, 0xa8694b, 0xb5744f];
/** Asphalt shingles: charcoal, estate grey, weathered wood, driftwood, brown, black, hickory, green-grey, slate blue. */
const ROOF_SHINGLE = [0x3e3f41, 0x56585b, 0x6a645b, 0x78746c, 0x4f443a, 0x2d2d2f, 0x5c5246, 0x4b534d, 0x4a4f57, 0x625e59];
const ROOF_SLATE = [0x4a4f57, 0x565c63, 0x3e4247, 0x5d6167];
const ROOF_BROWN = [0x6b4a36, 0x5a4232, 0x74553f];
/** Standing-seam metal roofs on houses (flagged metal by their colour). */
export const ROOF_METAL_RES = [0x3f5347, 0x7d3b31, 0x3a3c40, 0x8d9395, 0x33425a];
const ROOF_FLAT = [0x7a7a7c, 0x8a8886, 0x6c6e70, 0x94918c, 0x4a4b4d, 0xa89f8e, 0x9c9a94];
const ROOF_METAL = [0x8e9496, 0x6e7477, 0xa3a7a6, 0x7c8a8c];
const ROOF_BARN = [0x4e5156, 0x6d6f72, 0x7a3a2e, 0x5a6a5c];
const ROOF_CHURCH = [0x4a4f57, 0x5e8c7a, 0x3e4349];

type Region = 'coastal' | 'town' | 'rural';

const pick = <T>(rnd: () => number, a: readonly T[]): T => a[Math.floor(rnd() * a.length) % a.length];

function roofColor(rnd: () => number, region: Region): number {
  const r = rnd();
  // cumulative shares: terracotta, slate, shingles, brown, metal
  const [t, sl, sh, br] = region === 'coastal' ? [0.5, 0.65, 0.85, 0.92] : region === 'town' ? [0.12, 0.22, 0.77, 0.87] : [0.06, 0.14, 0.64, 0.76];
  if (r < t) return pick(rnd, ROOF_TERRACOTTA);
  if (r < sl) return pick(rnd, ROOF_SLATE);
  if (r < sh) return pick(rnd, ROOF_SHINGLE);
  if (r < br) return pick(rnd, ROOF_BROWN);
  return pick(rnd, ROOF_METAL_RES);
}

// ─── Prototypes ───────────────────────────────────────────────────────────────

interface Proto {
  use: BuildingUse;
  archetype: Archetype;
  width: number;
  depth: number;
  wallHeight: number;
  roofHeight: number;
  ridge: number;
  ridgeAxis: 0 | 1;
  wallColor: number;
  roofColor: number;
  floorHeight: number;
  style: number;
  /** Distance from the road edge to the front wall, m. */
  setback: number;
  /** Gap to the next lot along the street, m. */
  gap: number;
  /** Minimum clearance to any other building, m. */
  clear: number;
  /** Setback tier (flat towers): height above the base and inset, m. */
  tierHeight?: number;
  tierInset?: number;
}

const pitched = (rnd: () => number, w: number, d: number, hip: boolean, pitchDeg: number, ridgeAxis: 0 | 1): { roofHeight: number; ridge: number; ridgeAxis: 0 | 1 } => {
  const span = ridgeAxis === 0 ? d : w;
  const along = ridgeAxis === 0 ? w : d;
  void rnd;
  return { roofHeight: (span / 2) * Math.tan(pitchDeg * DEG), ridge: hip ? Math.max(0, (along - span) / along) : 1, ridgeAxis };
};

function houseProto(rnd: () => number, region: Region, use: BuildingUse = 'house'): Proto {
  const storeys = rnd() < (use === 'farmhouse' ? 0.7 : 0.55) ? 2 : 1;
  const w = 8 + rnd() * 5;
  const d = 7 + rnd() * 3.5;
  const hip = rnd() < 0.35;
  const axis: 0 | 1 = hip ? (w >= d ? 0 : 1) : rnd() < 0.72 ? 0 : 1;
  const roof = pitched(rnd, w, d, hip, hip ? 24 + rnd() * 10 : 30 + rnd() * 15, axis);
  const white = use === 'farmhouse' && rnd() < 0.5;
  return {
    use,
    archetype: hip ? 'hip' : 'gable',
    width: w,
    depth: d,
    wallHeight: storeys * 2.8 + 0.5,
    ...roof,
    wallColor: white ? pick(rnd, [0xf2efe8, 0xefece4, 0xe9dfc6]) : pick(rnd, region === 'coastal' ? WALL_HOUSE_EU : WALL_HOUSE),
    roofColor: roofColor(rnd, region),
    floorHeight: 2.8,
    style: STYLE.house,
    setback: 4 + rnd() * 5,
    gap: 5 + rnd() * 9,
    clear: 1.5,
  };
}

function rowHouseProto(rnd: () => number, region: Region): Proto {
  const w = 6 + rnd() * 2;
  const d = 9 + rnd() * 2;
  const storeys = 2 + (rnd() < 0.4 ? 1 : 0);
  return {
    use: 'house',
    archetype: 'gable',
    width: w,
    depth: d,
    wallHeight: storeys * 2.9 + 0.4,
    ...pitched(rnd, w, d, false, 32 + rnd() * 10, 0),
    wallColor: pick(rnd, region === 'coastal' ? WALL_HOUSE_EU : WALL_HOUSE),
    roofColor: roofColor(rnd, region),
    floorHeight: 2.9,
    style: STYLE.house,
    setback: 2 + rnd() * 2,
    gap: 0.7,
    clear: 0.6,
  };
}

function shopProto(rnd: () => number, region: Region): Proto {
  const w = 8 + rnd() * 7;
  const d = 12 + rnd() * 5;
  const floors = 2 + Math.floor(rnd() * 2);
  const flat = rnd() < 0.55;
  return {
    use: 'shop',
    archetype: flat ? 'flat' : 'gable',
    width: w,
    depth: d,
    wallHeight: floors * 3.2 + 0.6,
    ...(flat ? { roofHeight: 0.6 + rnd() * 0.8, ridge: 1, ridgeAxis: 0 as const } : pitched(rnd, w, d, false, 30 + rnd() * 12, 0)),
    wallColor: pick(rnd, region === 'town' ? WALL_SHOP_TOWN : region === 'coastal' ? [...WALL_SHOP, ...WALL_HOUSE_EU] : WALL_SHOP),
    roofColor: flat ? pick(rnd, ROOF_FLAT) : roofColor(rnd, region),
    floorHeight: 3.2,
    style: STYLE.shop,
    setback: 1.5 + rnd(),
    gap: 0.7 + (rnd() < 0.3 ? rnd() * 5 : 0),
    clear: 0.6,
  };
}

function apartmentProto(rnd: () => number, region: Region, maxFloors: number): Proto {
  const w = 16 + rnd() * 14;
  const d = 11 + rnd() * 4;
  const floors = 3 + Math.floor(rnd() * Math.max(1, maxFloors - 2));
  const hip = rnd() < 0.3;
  return {
    use: 'apartment',
    archetype: hip ? 'hip' : 'flat',
    width: w,
    depth: d,
    wallHeight: floors * 3 + 0.6,
    ...(hip ? pitched(rnd, w, d, true, 22 + rnd() * 8, 0) : { roofHeight: 0.8 + rnd() * 0.6, ridge: 1, ridgeAxis: 0 as const }),
    wallColor: pick(rnd, WALL_APT),
    roofColor: hip ? roofColor(rnd, region) : pick(rnd, ROOF_FLAT),
    floorHeight: 3,
    style: STYLE.apartment,
    setback: 3 + rnd() * 4,
    gap: 4 + rnd() * 8,
    clear: 2,
  };
}

function officeProto(rnd: () => number, minH: number, maxH: number, use: BuildingUse): Proto {
  const tower = use === 'tower';
  const w = tower ? 22 + rnd() * 14 : 20 + rnd() * 16;
  const d = tower ? 22 + rnd() * 14 : 16 + rnd() * 10;
  const h = minH + (maxH - minH) * rnd();
  const glass = rnd() < (tower ? 0.7 : 0.45);
  const fh = glass ? 3.8 : 3.2;
  const floors = Math.max(2, Math.round(h / fh));
  // setback: the upper floors of some towers (and a few tall offices) step in
  const tiered = floors >= 10 && rnd() < (tower ? 0.5 : 0.3);
  const tierFloors = Math.round(floors * (0.45 + 0.3 * rnd()));
  const inset = Math.min(2.5 + rnd() * 3, (Math.min(w, d) - 10) / 2);
  return {
    use,
    archetype: 'flat',
    width: w,
    depth: d,
    wallHeight: floors * fh + 0.8,
    ...(tiered && inset > 1.6 && floors - tierFloors >= 3 ? { tierHeight: tierFloors * fh + 0.4, tierInset: inset } : {}),
    roofHeight: 1.2 + rnd() * 1.2,
    ridge: 1,
    ridgeAxis: 0,
    wallColor: glass ? pick(rnd, WALL_GLASS) : pick(rnd, WALL_CONCRETE),
    roofColor: pick(rnd, ROOF_FLAT),
    floorHeight: fh,
    style: glass ? STYLE.office : STYLE.apartment,
    setback: tower ? 4 + rnd() * 5 : 2 + rnd() * 3,
    gap: tower ? 6 + rnd() * 8 : 2 + rnd() * 6,
    clear: 2,
  };
}

function industrialProto(rnd: () => number, big: boolean): Proto {
  const w = big ? 30 + rnd() * 40 : 16 + rnd() * 14;
  const d = big ? 22 + rnd() * 23 : 12 + rnd() * 8;
  const flat = rnd() < 0.45;
  const axis: 0 | 1 = rnd() < 0.5 ? 0 : 1;
  return {
    use: big ? 'warehouse' : 'industrial',
    archetype: flat ? 'flat' : 'gable',
    width: w,
    depth: d,
    wallHeight: big ? 7 + rnd() * 4 : 5 + rnd() * 2,
    ...(flat ? { roofHeight: 0.6 + rnd() * 0.5, ridge: 1, ridgeAxis: 0 as const } : pitched(rnd, w, d, false, 8 + rnd() * 6, axis)),
    wallColor: pick(rnd, WALL_INDUSTRIAL),
    roofColor: pick(rnd, ROOF_METAL),
    floorHeight: 0,
    style: STYLE.industrial,
    setback: 8 + rnd() * 10,
    gap: 8 + rnd() * 14,
    clear: 3,
  };
}

// ─── Placement ────────────────────────────────────────────────────────────────

interface Sampler {
  x: number;
  z: number;
  tx: number;
  tz: number;
}

/** Position/tangent at arc length s along a polyline with cumulative lengths `cum`. */
function sampleAt(pts: XZ[], cum: number[], s: number, out: Sampler, hint: { i: number }): void {
  let i = Math.max(1, hint.i);
  while (i < pts.length - 1 && cum[i] < s) i++;
  while (i > 1 && cum[i - 1] > s) i--;
  hint.i = i;
  const a = pts[i - 1];
  const b = pts[i];
  const seg = cum[i] - cum[i - 1] || 1;
  const t = Math.max(0, Math.min(1, (s - cum[i - 1]) / seg));
  out.x = a.x + (b.x - a.x) * t;
  out.z = a.z + (b.z - a.z) * t;
  out.tx = (b.x - a.x) / seg;
  out.tz = (b.z - a.z) / seg;
}

export function placeBuildings(layout: WorldLayout, net: RoadNetwork, heightAt: (x: number, z: number) => number, opts: PlacementOptions = {}): Building[] {
  const cfg = opts.cfg ?? CONFIG.world.towns;
  const seed = (opts.seed ?? layout.seed) | 0;
  const C = net.constraints;
  const roads = new SegmentGrid(64);
  net.roads.forEach((r, i) => roads.addPolyline(r.points, r.width / 2, i));
  roads.build();
  const q = roads.newQuery();
  const hash = new RectHash(48);
  const out: Building[] = [];
  const zoneNoise = createSimplex2D(seed ^ 0x2017);

  const toBuilding = (p: Proto, x: number, z: number, headingDeg: number, rand: number, town: number, farm: number): Building => ({
    x,
    z,
    y: 0,
    headingDeg,
    width: p.width,
    depth: p.depth,
    wallHeight: p.wallHeight,
    roofHeight: p.roofHeight,
    ridge: p.ridge,
    ridgeAxis: p.ridgeAxis,
    archetype: p.archetype,
    use: p.use,
    wallColor: p.wallColor,
    roofColor: p.roofColor,
    floorHeight: p.floorHeight,
    style: p.style,
    rand,
    town,
    farm,
    ...(p.tierHeight ? { tierHeight: p.tierHeight, tierInset: p.tierInset } : {}),
  });

  /** Faces the building toward its nearest road segment. False if no road within reach. */
  const orient = (b: Building): boolean => {
    if (!roads.nearest(b.x, b.z, 400, q)) return false;
    let nx = -q.dz;
    let nz = q.dx;
    if (nx * (q.px - b.x) + nz * (q.pz - b.z) < 0) {
      nx = -nx;
      nz = -nz;
    }
    b.headingDeg = headingOf(nx, nz);
    return true;
  };

  /** All constraint checks; fits the base to the ground. Does not add. Trees check only their trunk against the roads (crowns may overhang). */
  const fits = (b: Building, clear: number, roadClear: number): Rect | null => {
    const r = buildingRect(b);
    const rr = b.use === 'tree' ? makeRect(b.x, b.z, b.headingDeg, TRUNK_RECT, TRUNK_RECT) : r;
    if (roads.clearance(rr, 30) < roadClear) return null;
    if (C.rectInAirport(r, 20)) return null;
    if (C.rectWaterClearance(r) < 3) return null;
    if (hash.anyOverlap(r, clear)) return null;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++) {
        const h = heightAt(r.x + r.ax * r.hw * i + r.fx * r.hd * j, r.z + r.az * r.hw * i + r.fz * r.hd * j);
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
    if (!Number.isFinite(lo) || hi - lo > 1.5 + 0.12 * Math.max(b.width, b.depth)) return null;
    b.y = lo - 0.3;
    b.plinth = hi - lo + 0.3;
    b.wallHeight += b.plinth;
    if (b.tierHeight) b.tierHeight += b.plinth;
    return r;
  };

  const tryAdd = (b: Building, clear: number, roadClear = 1.2): boolean => {
    if (b.farm < 0 && !orient(b)) return false;
    const r = fits(b, clear, roadClear);
    if (!r) return false;
    hash.add(r);
    out.push(b);
    return true;
  };

  /** Adds all parts or none (parts are built not to overlap each other). */
  const tryAddGroup = (parts: { b: Building; clear: number }[]): boolean => {
    const rects: Rect[] = [];
    const saved = parts.map((p) => ({ y: p.b.y, wh: p.b.wallHeight, pl: p.b.plinth }));
    for (const p of parts) {
      const r = fits(p.b, p.clear, 1.2);
      if (!r) {
        parts.forEach((pp, i) => {
          pp.b.y = saved[i].y;
          pp.b.wallHeight = saved[i].wh;
          pp.b.plinth = saved[i].pl;
        });
        return false;
      }
      rects.push(r);
    }
    rects.forEach((r) => hash.add(r));
    for (const p of parts) out.push(p.b);
    return true;
  };

  // Roads relevant to each settlement: its streets + the through roads' pieces inside it.
  const townRoads = (ti: number, t: Town): NetRoad[] => {
    const list: NetRoad[] = [];
    for (const r of net.roads) {
      if (r.kind === 'street') {
        if (r.town === ti) list.push(r);
        continue;
      }
      if (r.kind === 'drive') continue;
      // clip to the part inside 1.1 R (keep contiguous runs)
      let run: XZ[] = [];
      const flush = () => {
        if (run.length >= 2) list.push({ ...r, points: run });
        run = [];
      };
      for (const p of r.points) {
        if (Math.hypot(p.x - t.x, p.z - t.z) < 1.1 * t.radius) run.push(p);
        else flush();
      }
      flush();
    }
    return list;
  };

  const churchParts = (rnd: () => number, x: number, z: number, heading: number, ti: number, scale: number): { b: Building; clear: number }[] => {
    const naveW = (10 + rnd() * 3) * scale;
    const naveD = (22 + rnd() * 8) * scale;
    const wall = pick(rnd, WALL_CHURCH);
    const roof = pick(rnd, ROOF_CHURCH);
    const nave: Building = toBuilding(
      {
        use: 'church',
        archetype: 'gable',
        width: naveW,
        depth: naveD,
        wallHeight: (7.5 + rnd() * 2.5) * scale,
        ...pitched(rnd, naveW, naveD, false, 50 + rnd() * 6, 1),
        wallColor: wall,
        roofColor: roof,
        floorHeight: 0,
        style: STYLE.church,
        setback: 0,
        gap: 0,
        clear: 2,
      },
      x,
      z,
      heading,
      rnd(),
      ti,
      -1,
    );
    const sw = (5.2 + rnd() * 1.6) * scale;
    const sh = nave.wallHeight + nave.roofHeight + 4 + rnd() * 6;
    const f = { x: Math.sin(heading * DEG), z: -Math.cos(heading * DEG) };
    const off = naveD / 2 + sw / 2 + 0.02;
    const steeple: Building = toBuilding(
      {
        use: 'steeple',
        archetype: 'hip',
        width: sw,
        depth: sw,
        wallHeight: sh,
        roofHeight: sw * (2 + rnd() * 1.2),
        ridge: 0,
        ridgeAxis: 0,
        wallColor: wall,
        roofColor: roof,
        floorHeight: 0,
        style: STYLE.church,
        setback: 0,
        gap: 0,
        clear: 2,
      },
      x + f.x * off,
      z + f.z * off,
      heading,
      rnd(),
      ti,
      -1,
    );
    return [
      { b: nave, clear: 2 },
      { b: steeple, clear: 2 },
    ];
  };

  /** Tries to put a church on a lot along `list`, nearest to (cx, cz) within [rMin, rMax] of the centre. */
  const placeChurch = (rnd: () => number, list: NetRoad[], t: Town, ti: number, rMin: number, rMax: number, scale: number): boolean => {
    const cands: { p: XZ; tx: number; tz: number; hw: number; d: number }[] = [];
    for (const r of list) {
      for (let i = 1; i < r.points.length; i++) {
        const a = r.points[i - 1];
        const b = r.points[i];
        const d = Math.hypot(a.x - t.x, a.z - t.z);
        if (d < rMin || d > rMax) continue;
        const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        cands.push({ p: a, tx: (b.x - a.x) / l, tz: (b.z - a.z) / l, hw: r.width / 2, d });
      }
    }
    cands.sort((a, b) => a.d - b.d || a.p.x - b.p.x);
    for (const c of cands.slice(0, 80)) {
      for (const side of [1, -1]) {
        const naveD = 30 * scale;
        const off = c.hw + 5 + 7 * scale + naveD / 2;
        const nx = -c.tz * side;
        const nz = c.tx * side;
        const probe: Building = toBuilding(houseProto(rnd, 'rural'), c.p.x + nx * off, c.p.z + nz * off, 0, 0, ti, -1);
        if (!orient(probe)) continue;
        const parts = churchParts(mulberry32((seed ^ Math.imul(ti + 7, 0x51ed27)) >>> 0), probe.x, probe.z, probe.headingDeg, ti, scale);
        if (tryAddGroup(parts)) return true;
      }
    }
    return false;
  };

  /**
   * Puts a landmark on a lot along `list` within [rMin, rMax] of the centre — nearest first, or in a
   * random order — set back `setback` m from the road edge. True if it was placed.
   */
  const placeOnStreet = (rnd: () => number, list: NetRoad[], t: Town, ti: number, rMin: number, rMax: number, make: () => Proto, nearest: boolean): boolean => {
    const cands: { p: XZ; tx: number; tz: number; hw: number; key: number }[] = [];
    for (const r of list) {
      for (let i = 1; i < r.points.length; i++) {
        const a = r.points[i - 1];
        const b = r.points[i];
        const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        for (let f = 0.25; f < 1; f += 0.5) {
          const px = a.x + (b.x - a.x) * f;
          const pz = a.z + (b.z - a.z) * f;
          const d = Math.hypot(px - t.x, pz - t.z);
          if (d < rMin || d > rMax) continue;
          cands.push({ p: { x: px, z: pz }, tx: (b.x - a.x) / l, tz: (b.z - a.z) / l, hw: r.width / 2, key: nearest ? d : rnd() });
        }
      }
    }
    cands.sort((a, b) => a.key - b.key || a.p.x - b.p.x || a.p.z - b.p.z);
    for (const c of cands.slice(0, 120)) {
      for (const side of [1, -1]) {
        const p = make();
        const off = c.hw + p.setback + p.depth / 2;
        const b = toBuilding(p, c.p.x - c.tz * side * off, c.p.z + c.tx * side * off, 0, rnd(), ti, -1);
        if (tryAdd(b, p.clear)) return true;
      }
    }
    return false;
  };

  /** Detached houses (for the yard pass: garages, pools, garden trees). */
  const yards: { b: Building; region: Region; rN: number }[] = [];
  /** Each settlement's roads (for the street-tree pass). */
  const lists: NetRoad[][] = [];

  // ── Settlements ────────────────────────────────────────────────────────────
  const smp: Sampler = { x: 0, z: 0, tx: 1, tz: 0 };
  layout.towns.forEach((t, ti) => {
    const rnd = mulberry32((seed ^ Math.imul(ti + 1, 0x7f4a7c15)) >>> 0);
    const lrnd = mulberry32((seed ^ Math.imul(ti + 1, 0x2c9277b5)) >>> 0);
    const list = townRoads(ti, t);
    lists.push(list);
    const coastal = t.kind === 'city' || layout.coast.zAt(t.x) - t.z < 1500;
    const region: Region = coastal ? 'coastal' : t.kind === 'town' ? 'town' : 'rural';
    // landmarks first
    if (t.kind === 'village') placeChurch(rnd, list, t, ti, 0, t.radius * 0.55, 1);
    else if (t.kind === 'town') placeChurch(rnd, list, t, ti, t.radius * 0.1, t.radius * 0.45, 1.25);
    else if (t.kind === 'city') {
      placeChurch(rnd, list, t, ti, t.radius * 0.3, t.radius * 0.4, 1.4);
      placeChurch(rnd, list, t, ti, t.radius * 0.55, t.radius * 0.65, 1.1);
    }
    // civic buildings: town hall on the main street, schools, a water tower on the edge of town
    if (t.kind === 'town' || t.kind === 'city') {
      placeOnStreet(lrnd, list, t, ti, t.radius * (t.kind === 'city' ? 0.2 : 0.02), t.radius * (t.kind === 'city' ? 0.3 : 0.2), () => townHallProto(lrnd, region), true);
      const schools = t.kind === 'city' ? 3 : 1;
      for (let k = 0; k < schools; k++) placeOnStreet(lrnd, list, t, ti, t.radius * 0.3, t.radius * 0.75, () => schoolProto(lrnd), false);
    }
    if (t.kind === 'town' || t.kind === 'city' || (t.kind === 'village' && lrnd() < 0.45)) {
      placeOnStreet(lrnd, list, t, ti, t.radius * 0.45, t.radius * 0.95, () => waterTowerProto(lrnd, t.kind === 'village' ? 0.8 : 1), false);
    }
    for (const r of list) {
      const cum = cumulativeLength(r.points);
      const len = cum[cum.length - 1];
      const hw = r.width / 2;
      const major = r.kind !== 'street';
      for (const side of [1, -1]) {
        const hint = { i: 1 };
        let s = rnd() * 10;
        while (s < len) {
          sampleAt(r.points, cum, s, smp, hint);
          const d = Math.hypot(smp.x - t.x, smp.z - t.z);
          const rN = (d / t.radius) * (1 + 0.12 * zoneNoise(smp.x / 350, smp.z / 350));
          if (rN > 1.02) {
            s += 15;
            continue;
          }
          const coastD = layout.coast.zAt(smp.x) - smp.z;
          let p: Proto;
          if (t.kind === 'city') {
            if (coastD < 380 && rN < 0.95) p = rnd() < 0.2 ? tankProto(rnd) : industrialProto(rnd, true);
            else if (rN < 0.14) p = rnd() < 0.7 ? (rnd() < 0.1 ? roundTowerProto(rnd, 50 + 50 * (1 - rN / 0.14)) : officeProto(rnd, 40 + 50 * (1 - rN / 0.14), 60 + 60 * (1 - rN / 0.14), 'tower')) : officeProto(rnd, 16, 36, 'office');
            else if (rN < 0.3) p = rnd() < 0.5 ? officeProto(rnd, 14, 34, 'office') : rnd() < 0.5 ? apartmentProto(rnd, region, 8) : shopProto(rnd, region);
            else if (rN < 0.55) p = rnd() < 0.45 ? apartmentProto(rnd, region, 6) : rnd() < 0.5 ? rowHouseProto(rnd, region) : shopProto(rnd, region);
            else if (major && rN > 0.6 && rnd() < 0.45) p = rnd() < 0.15 ? tankProto(rnd) : industrialProto(rnd, rnd() < 0.6);
            else p = houseProto(rnd, region);
          } else if (t.kind === 'town') {
            if (rN < 0.18) p = rnd() < 0.7 ? shopProto(rnd, region) : apartmentProto(rnd, region, 4);
            else if (rN < 0.4) p = rnd() < 0.2 ? apartmentProto(rnd, region, 4) : rnd() < 0.2 ? rowHouseProto(rnd, region) : houseProto(rnd, region);
            else if (major && rN > 0.6 && rnd() < 0.35) p = industrialProto(rnd, rnd() < 0.4);
            else p = houseProto(rnd, region);
          } else if (t.kind === 'village') {
            if (rN < 0.2 && rnd() < 0.25) p = shopProto(rnd, region);
            else if (rN > 0.65 && rnd() < 0.12) p = barnProto(rnd);
            else p = houseProto(rnd, region);
          } else {
            p = rnd() < 0.2 ? barnProto(rnd) : houseProto(rnd, region);
          }
          const falloff = t.kind === 'city' && rN < 0.55 ? 1 : 1 - 0.55 * rN * rN;
          if (rnd() < t.density * falloff + (rN < 0.3 ? 0.15 : 0)) {
            const off = hw + p.setback + p.depth / 2;
            const b = toBuilding(p, smp.x - smp.tz * side * off, smp.z + smp.tx * side * off, 0, rnd(), ti, -1);
            if (tryAdd(b, p.clear) && p.use === 'house' && p.gap > 2) yards.push({ b, region, rN });
          }
          s += p.width + p.gap;
        }
      }
    }
  });

  // ── Farmsteads ─────────────────────────────────────────────────────────────
  net.farms.forEach((f, fi) => {
    const rnd = mulberry32((seed ^ Math.imul(fi + 1, 0x3c6ef372)) >>> 0);
    const h = f.headingDeg * DEG;
    const fx = Math.sin(h);
    const fz = -Math.cos(h);
    const ax = -fz;
    const az = fx;
    const at = (u: number, v: number): XZ => ({ x: f.x + ax * u + fx * v, z: f.z + az * u + fz * v });
    const house = houseProto(rnd, 'rural', 'farmhouse');
    const barn = barnProto(rnd);
    for (const m of rnd() < 0.5 ? [1, -1] : [-1, 1]) {
      const hp = at(m * (8 + house.width / 2 + rnd() * 4), 10 + house.depth / 2 + rnd() * 4);
      const bv = -(7 + barn.depth / 2);
      const bu = -m * (2 + rnd() * 5);
      const bp = at(bu, bv);
      const hb = toBuilding(house, hp.x, hp.z, f.headingDeg, rnd(), -1, fi);
      const bb = toBuilding(barn, bp.x, bp.z, f.headingDeg, rnd(), -1, fi);
      if (!tryAddGroup([
        { b: hb, clear: 2 },
        { b: bb, clear: 2 },
      ]))
        continue;
      // silos beside the barn, on the far side from the house
      const n = 1 + Math.floor(rnd() * 3);
      const bins = rnd() < 0.4;
      const silo = siloProto(rnd, 4.5 + rnd() * 2.5, bins);
      const diam = silo.width;
      for (let k = 0; k < n; k++) {
        const sp = at(bu - m * (barn.width / 2 + 2.5 + diam / 2 + k * (diam + 1.2)), bv + barn.depth / 2 - diam / 2 - 1);
        tryAdd(toBuilding({ ...silo, wallHeight: silo.wallHeight * (1 - 0.12 * k) }, sp.x, sp.z, f.headingDeg, rnd(), -1, fi), 0.8);
      }
      if (rnd() < 0.65) {
        const shed = shedProto(rnd);
        const sp = at(m * (10 + shed.width / 2 + rnd() * 6), -(6 + shed.depth / 2 + rnd() * 8));
        tryAdd(toBuilding(shed, sp.x, sp.z, f.headingDeg, rnd(), -1, fi), 2);
      }
      break;
    }
  });

  // ── Houses scattered along the country roads ───────────────────────────────
  layout.roads.forEach((r, ri) => {
    const rnd = mulberry32((seed ^ Math.imul(ri + 1, 0x1b873593)) >>> 0);
    const cum = cumulativeLength(r.points);
    const len = cum[cum.length - 1];
    const chance = cfg.roadsideHouseChance * (r.kind === 'highway' ? 0.3 : 1);
    const hint = { i: 1 };
    for (let s = 20; s < len; s += 45) {
      for (const side of [1, -1]) {
        if (rnd() >= chance) continue;
        sampleAt(r.points, cum, s, smp, hint);
        let inTown = false;
        for (const t of layout.towns) if (Math.hypot(smp.x - t.x, smp.z - t.z) < t.radius + 80) inTown = true;
        if (inTown) continue;
        const p = houseProto(rnd, 'rural');
        const off = r.width / 2 + 8 + rnd() * 14 + p.depth / 2;
        if (heightAt(smp.x, smp.z) > cfg.farmMaxHeight + 150) continue;
        const b = toBuilding(p, smp.x - smp.tz * side * off, smp.z + smp.tx * side * off, 0, rnd(), -1, -1);
        if (tryAdd(b, 2)) yards.push({ b, region: 'rural', rN: 1 });
      }
    }
  });

  // ── Yards: detached garages, pools and garden trees behind the houses ─────
  yards.forEach((y, yi) => {
    const rnd = mulberry32((seed ^ Math.imul(yi + 1, 0x68e31da4)) >>> 0);
    const h = y.b;
    const hd = h.headingDeg * DEG;
    const fx = Math.sin(hd);
    const fz = -Math.cos(hd);
    const ax = -fz;
    const az = fx;
    const at = (u: number, v: number): XZ => ({ x: h.x + ax * u + fx * v, z: h.z + az * u + fz * v });
    const suburb = y.rN > 0.3;
    if (suburb && y.region !== 'coastal' && rnd() < 0.3) {
      const g = garageProto(rnd, h);
      const side = rnd() < 0.5 ? 1 : -1;
      const c = at(side * (h.width / 2 + 1.4 + g.width / 2), -(h.depth / 2 - g.depth / 2) - rnd() * 5);
      tryAdd(toBuilding(g, c.x, c.z, 0, rnd(), h.town, -1), 0.8);
    }
    if (suburb && rnd() < (y.region === 'coastal' ? 0.24 : y.region === 'town' ? 0.1 : 0.04)) {
      const pl = poolProto(rnd);
      const c = at((rnd() - 0.5) * h.width * 0.6, -(h.depth / 2 + 3 + pl.depth / 2 + rnd() * 3));
      tryAdd(toBuilding(pl, c.x, c.z, 0, rnd(), h.town, -1), 1.2, 1.5);
    }
    const n = y.region === 'rural' ? 2 + Math.floor(rnd() * 3) : 1 + Math.floor(rnd() * 3);
    for (let k = 0, placed = 0; k < n + 3 && placed < n; k++) {
      const tp = treeProto(rnd, rnd() < 0.12 ? 'conifer' : 'garden');
      const r = tp.width / 2;
      const back = rnd() < 0.65;
      const c = back
        ? at((rnd() - 0.5) * (h.width + 8), -(h.depth / 2 + 1.5 + r + rnd() * 9))
        : at((rnd() < 0.5 ? 1 : -1) * (h.width / 2 + 1.2 + r + rnd() * 3), (rnd() - 0.4) * h.depth);
      if (tryAdd(toBuilding(tp, c.x, c.z, 0, rnd(), h.town, -1), 0.5, 0.8)) placed++;
    }
  });

  // ── Street trees along the settlements' streets and main roads ───────────
  layout.towns.forEach((t, ti) => {
    const rnd = mulberry32((seed ^ Math.imul(ti + 1, 0x5f356495)) >>> 0);
    const chance = t.kind === 'city' ? 0.85 : t.kind === 'town' ? 0.8 : t.kind === 'village' ? 0.4 : 0.25;
    for (const r of lists[ti]) {
      const cum = cumulativeLength(r.points);
      const len = cum[cum.length - 1];
      const hw = r.width / 2;
      for (const side of [1, -1]) {
        if (rnd() > chance) continue;
        const hint = { i: 1 };
        // one species and size per side of a street
        const proto = treeProto(rnd, 'street');
        const spacing = 10 + rnd() * 6;
        let s = rnd() * spacing;
        while (s < len) {
          sampleAt(r.points, cum, s, smp, hint);
          const rN = Math.hypot(smp.x - t.x, smp.z - t.z) / t.radius;
          if (rN < 1.0 && rnd() < 0.85) {
            const k = 0.85 + 0.3 * rnd();
            const tp: Proto = { ...proto, width: proto.width * k, depth: proto.width * k, roofHeight: proto.roofHeight * k };
            const off = hw + 1.3 + rnd() * 0.6;
            tryAdd(toBuilding(tp, smp.x - smp.tz * side * off, smp.z + smp.tx * side * off, 0, rnd(), ti, -1), 0.5, 0.8);
          }
          s += spacing * (0.9 + 0.2 * rnd());
        }
      }
    }
  });

  return out;
}

/** Road clearance of a tree is checked on this square around its trunk (m): the crown may overhang. */
export const TRUNK_RECT = 1.2;

function treeProto(rnd: () => number, kind: 'garden' | 'street' | 'conifer'): Proto {
  const conifer = kind === 'conifer';
  const w = conifer ? 3.5 + rnd() * 2.5 : kind === 'street' ? 5 + rnd() * 3 : 4.5 + rnd() * 6;
  const crown = conifer ? w * (2 + rnd() * 0.8) : w * (0.85 + rnd() * 0.45);
  const odd = !conifer && rnd() < 0.08;
  return {
    use: 'tree',
    archetype: 'silo',
    width: w,
    depth: w,
    wallHeight: conifer ? 0.8 + rnd() * 0.8 : 1.6 + rnd() * 1.6,
    roofHeight: crown,
    ridge: 1,
    ridgeAxis: 0,
    wallColor: conifer ? pick(rnd, FOLIAGE_CONIFER) : odd ? pick(rnd, FOLIAGE_ODD) : pick(rnd, FOLIAGE),
    roofColor: 0x4a3c30,
    floorHeight: 0,
    style: STYLE.tree,
    setback: 0,
    gap: 0,
    clear: 0.5,
  };
}

function poolProto(rnd: () => number): Proto {
  const w = 4 + rnd() * 2;
  return {
    use: 'pool',
    archetype: 'flat',
    width: w,
    depth: w * (1.7 + rnd() * 0.5),
    wallHeight: 0.25,
    roofHeight: 0.12,
    ridge: 1,
    ridgeAxis: 0,
    wallColor: pick(rnd, [0xd9d5ca, 0xcfc8b8, 0xe2ded4]),
    roofColor: pick(rnd, [0x3fa6c4, 0x4bb3c8, 0x3a9cb8]),
    floorHeight: 0,
    style: STYLE.pool,
    setback: 0,
    gap: 0,
    clear: 1.2,
  };
}

/** A detached garage in the colours of its house. */
function garageProto(rnd: () => number, h: Building): Proto {
  const w = 6 + rnd() * 1.4;
  const d = 6.2 + rnd() * 1.2;
  return {
    use: 'garage',
    archetype: 'gable',
    width: w,
    depth: d,
    wallHeight: 2.8,
    ...pitched(rnd, w, d, false, 20 + rnd() * 10, 0),
    wallColor: h.wallColor,
    roofColor: h.roofColor,
    floorHeight: 2.8,
    style: STYLE.house,
    setback: 0,
    gap: 0,
    clear: 0.8,
  };
}

function townHallProto(rnd: () => number, region: Region): Proto {
  const w = 26 + rnd() * 8;
  const d = 16 + rnd() * 4;
  return {
    use: 'townhall',
    archetype: 'hip',
    width: w,
    depth: d,
    wallHeight: 3 * 3.8 + 0.8,
    ...pitched(rnd, w, d, true, 26 + rnd() * 6, 0),
    wallColor: pick(rnd, [0xd8cfbd, 0xc9bda5, 0xa3553f, 0xe2dccd]),
    roofColor: region === 'coastal' ? pick(rnd, ROOF_TERRACOTTA) : pick(rnd, [...ROOF_SLATE, 0x5e8c7a]),
    floorHeight: 3.8,
    style: STYLE.civic,
    setback: 8 + rnd() * 4,
    gap: 6,
    clear: 3,
  };
}

function schoolProto(rnd: () => number): Proto {
  const w = 48 + rnd() * 24;
  const d = 14 + rnd() * 4;
  return {
    use: 'school',
    archetype: 'flat',
    width: w,
    depth: d,
    wallHeight: 2 * 3.7 + 0.9,
    roofHeight: 0.7 + rnd() * 0.4,
    ridge: 1,
    ridgeAxis: 0,
    wallColor: pick(rnd, [0xa3553f, 0x9b5b45, 0xb06448, 0xc9bda5, 0xd8cfbd]),
    roofColor: pick(rnd, ROOF_FLAT),
    floorHeight: 3.7,
    style: STYLE.civic,
    setback: 10 + rnd() * 8,
    gap: 10,
    clear: 4,
  };
}

/** A water tower: a column and a domed tank (drawn as pieces; the obstacle is the whole cylinder). */
function waterTowerProto(rnd: () => number, scale: number): Proto {
  const d = (11 + rnd() * 3) * scale;
  return {
    use: 'watertower',
    archetype: 'silo',
    width: d,
    depth: d,
    wallHeight: (30 + rnd() * 10) * scale,
    roofHeight: d * 0.22,
    ridge: 1,
    ridgeAxis: 0,
    wallColor: pick(rnd, [0xe9ecec, 0xb9d0dc, 0xcfd8c8, 0xdfe3e6]),
    roofColor: pick(rnd, [0xe9ecec, 0xb9d0dc, 0x9aa6ad]),
    floorHeight: 0,
    style: STYLE.civic,
    setback: 10 + rnd() * 8,
    gap: 10,
    clear: 4,
  };
}

/** A fuel / storage tank on the industrial edge and the harbour: wide, white, low cone roof. */
function tankProto(rnd: () => number): Proto {
  const d = 12 + rnd() * 12;
  return {
    use: 'tank',
    archetype: 'silo',
    width: d,
    depth: d,
    wallHeight: 8 + rnd() * 7,
    roofHeight: d * (0.06 + rnd() * 0.04),
    ridge: 0,
    ridgeAxis: 0,
    wallColor: pick(rnd, [0xe6e8e6, 0xd8dcdc, 0xc9ced0, 0xe2dccb]),
    roofColor: pick(rnd, [0xd8dcdc, 0xb7bcc0]),
    floorHeight: 0,
    style: STYLE_X.tank,
    setback: 10 + rnd() * 10,
    gap: 6 + rnd() * 6,
    clear: 3,
  };
}

/** A round glass tower (the silo mesh with a curtain wall and a near-flat roof). */
function roundTowerProto(rnd: () => number, h: number): Proto {
  const d = 24 + rnd() * 10;
  const fh = 3.8;
  const floors = Math.max(12, Math.round(h / fh));
  return {
    use: 'tower',
    archetype: 'silo',
    width: d,
    depth: d,
    wallHeight: floors * fh + 0.8,
    roofHeight: 1.6,
    ridge: 1,
    ridgeAxis: 0,
    wallColor: pick(rnd, WALL_GLASS),
    roofColor: pick(rnd, ROOF_FLAT),
    floorHeight: fh,
    style: STYLE.office,
    setback: 6 + rnd() * 4,
    gap: 8 + rnd() * 6,
    clear: 3,
  };
}

function barnProto(rnd: () => number): Proto {
  const span = 11 + rnd() * 4;
  const len = 20 + rnd() * 10;
  const gambrel = rnd() < 0.7;
  const red = rnd() < 0.78;
  return {
    use: 'barn',
    archetype: gambrel ? 'gambrel' : 'gable',
    width: span,
    depth: len,
    wallHeight: 4.5 + rnd() * 1.5,
    roofHeight: gambrel ? span * (0.42 + rnd() * 0.08) : (span / 2) * Math.tan((38 + rnd() * 8) * DEG),
    ridge: 1,
    ridgeAxis: 1,
    wallColor: red ? pick(rnd, WALL_BARN_RED) : pick(rnd, WALL_BARN_OTHER),
    roofColor: pick(rnd, ROOF_BARN),
    floorHeight: 0,
    style: STYLE.barn,
    setback: 6 + rnd() * 6,
    gap: 10 + rnd() * 10,
    clear: 2,
  };
}

const WALL_BIN = [0xc3c8cb, 0xb4babd, 0xcfd2d0];

function siloProto(rnd: () => number, diam: number, bin: boolean): Proto {
  if (bin) {
    // a corrugated galvanised grain bin: squat, wide, cone roof
    const d = diam * 1.6;
    return {
      use: 'silo',
      archetype: 'silo',
      width: d,
      depth: d,
      wallHeight: 5 + rnd() * 2.8,
      roofHeight: d * (0.2 + rnd() * 0.06),
      ridge: 0,
      ridgeAxis: 0,
      wallColor: pick(rnd, WALL_BIN),
      roofColor: pick(rnd, [0xb7bcc0, 0xa9aeb0]),
      floorHeight: 0,
      style: STYLE.silo,
      setback: 0,
      gap: 1,
      clear: 0.8,
    };
  }
  return {
    use: 'silo',
    archetype: 'silo',
    width: diam,
    depth: diam,
    wallHeight: 11 + rnd() * 9,
    roofHeight: diam * 0.38,
    ridge: 1,
    ridgeAxis: 0,
    wallColor: pick(rnd, WALL_SILO),
    roofColor: pick(rnd, [0xb7bcc0, 0x9aa0a4, 0x2f4a6a]),
    floorHeight: 0,
    style: STYLE.silo,
    setback: 0,
    gap: 1,
    clear: 0.8,
  };
}

function shedProto(rnd: () => number): Proto {
  const w = 18 + rnd() * 8;
  const d = 11 + rnd() * 3;
  return {
    use: 'shed',
    archetype: 'gable',
    width: w,
    depth: d,
    wallHeight: 4.5 + rnd(),
    ...pitched(rnd, w, d, false, 14 + rnd() * 6, 0),
    wallColor: pick(rnd, WALL_SHED),
    roofColor: pick(rnd, ROOF_METAL),
    floorHeight: 0,
    style: STYLE.shed,
    setback: 6,
    gap: 6,
    clear: 2,
  };
}
