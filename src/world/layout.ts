/**
 * The geography of the world as plain data, derived deterministically from
 * config + seed: the airport (runway from runway.ts, taxiways, apron, building
 * and parking spots), the coast with its bay and islands, lakes, the river,
 * towns/villages and the road network. PURE (no three.js).
 *
 * Wave 2 (airport buildings/markings, trees, towns, roads) renders from this;
 * the heightfield carves/flattens the terrain from it.
 *
 * Frame: +X east, +Z south (north = −Z), metres, heading clockwise from north.
 */
import { CONFIG, type Config } from '../config';
import { runwayFrame, fromRunwayCoords, type RunwayFrame } from './runway';
import { createRegional, newRegionalSample, type Regional, type Island } from './regional';
import { createSimplex2D, mulberry32 } from './noise';
import type { XZ } from './polyline';

export type { XZ } from './polyline';
export type { Island } from './regional';

/** A rectangle with its long axis (`halfLength`) along `headingDeg`. */
export interface OrientedRect {
  center: XZ;
  halfLength: number;
  halfWidth: number;
  headingDeg: number;
}

/** A building footprint. `headingDeg` is the direction its front/doors face. */
export interface BuildingSpot {
  center: XZ;
  headingDeg: number;
  /** Extent across the front (m). */
  width: number;
  /** Extent front-to-back (m). */
  depth: number;
  /** Suggested height (m). */
  height: number;
}

/** A point with a facing (parked aircraft nose direction, fuel pump orientation…). */
export interface Spot {
  x: number;
  z: number;
  headingDeg: number;
}

export interface Taxiway {
  name: string;
  kind: 'parallel' | 'connector';
  rect: OrientedRect;
}

export interface AirportLayout {
  name: string;
  icao: string;
  /** Field elevation, m MSL: the whole paved area is exactly this high. */
  elevation: number;
  runway: RunwayFrame;
  flatRadius: number;
  blendWidth: number;
  taxiways: Taxiway[];
  apron: OrientedRect;
  /** Runway + taxiways + apron (every paved rectangle). */
  pavedAreas: OrientedRect[];
  hangars: BuildingSpot[];
  tower: BuildingSpot;
  terminal: BuildingSpot;
  fuel: Spot;
  parkingSpots: Spot[];
  windsock: XZ;
  /** Where the airport access road leaves the airfield (behind the terminal). */
  accessRoadStart: XZ;
}

export interface CoastLayout {
  /** z of the coastline at x (land is north of it). */
  zAt(x: number): number;
  /** The coastline sampled every 100 m from x = −40 km to +40 km (west → east). */
  polyline: XZ[];
  bay: { x: number; z: number; width: number };
}

export interface Lake {
  name: string;
  center: XZ;
  /** Semi-axes of the base ellipse (m) and its rotation (deg, clockwise from +X toward +Z). */
  radiusX: number;
  radiusZ: number;
  rotationDeg: number;
  /** Lobe coefficients of the shoreline: r(θ) = 1 + Σ a·sin(kθ + φ). */
  lobes: { k: number; a: number; phase: number }[];
  /** Water surface height, m MSL. */
  level: number;
  maxDepth: number;
  /** Closed shoreline polygon (last point ≠ first), counter-clockwise, 96 points. */
  shoreline: XZ[];
}

export interface River {
  name: string;
  /** Channel centreline from source to mouth (meandering), ~40 m spacing. */
  points: XZ[];
  /** Water surface height at each point (non-increasing; 0 at the sea). */
  levels: number[];
  /** Half-width of the water at each point, m. */
  halfWidths: number[];
  /** Channel depth below the water surface at each point, m. */
  depths: number[];
  /** Smooth valley centreline (no meanders), ~200 m spacing, and its levels. */
  valley: XZ[];
  valleyLevels: number[];
  source: XZ;
  mouth: XZ;
}

export type TownKind = 'city' | 'town' | 'village' | 'hamlet';

export interface Town {
  name: string;
  kind: TownKind;
  x: number;
  z: number;
  /** Radius of the built-up area, m. */
  radius: number;
  /** 0..1 building density at the centre. */
  density: number;
  /** Street grid orientation (deg) and block size (m), for buildings and the ground shader. */
  gridAngleDeg: number;
  blockSize: number;
}

export type RoadKind = 'highway' | 'road' | 'access' | 'lane';

export interface Road {
  name: string;
  kind: RoadKind;
  /** Paved width, m. */
  width: number;
  /** Centreline, ~25 m spacing (drape on terrainHeight; the terrain is flattened across it). */
  points: XZ[];
}

export interface Bridge {
  road: string;
  x: number;
  z: number;
  /** Direction of the road across the bridge. */
  headingDeg: number;
  /** Deck length (bank to bank), m. */
  length: number;
  width: number;
  /** River water level under the bridge, m MSL. */
  waterLevel: number;
}

export interface WorldLayout {
  seed: number;
  seaLevel: number;
  airport: AirportLayout;
  coast: CoastLayout;
  islands: Island[];
  lakes: Lake[];
  rivers: River[];
  towns: Town[];
  roads: Road[];
  bridges: Bridge[];
}

// ─── geometry helpers ────────────────────────────────────────────────────────

const smooth = (e0: number, e1: number, x: number): number => {
  let t = (x - e0) / (e1 - e0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const headingOf = (dx: number, dz: number): number => (((Math.atan2(dx, -dz) * 180) / Math.PI) % 360 + 360) % 360;

/** Uniform Catmull-Rom through control points, densely sampled. */
function catmullRom(ctrl: XZ[], perSeg = 24): XZ[] {
  if (ctrl.length < 3) return ctrl.map((p) => ({ x: p.x, z: p.z }));
  const out: XZ[] = [];
  for (let i = 0; i < ctrl.length - 1; i++) {
    const p0 = ctrl[Math.max(0, i - 1)];
    const p1 = ctrl[i];
    const p2 = ctrl[i + 1];
    const p3 = ctrl[Math.min(ctrl.length - 1, i + 2)];
    for (let s = 0; s < perSeg; s++) {
      const t = s / perSeg;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push({
        x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        z: 0.5 * (2 * p1.z + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3),
      });
    }
  }
  out.push({ ...ctrl[ctrl.length - 1] });
  return out;
}

function cumulative(pts: XZ[]): number[] {
  const s = [0];
  for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  return s;
}

/** Resamples a polyline at (nearly) uniform arc-length spacing, keeping both ends. */
function resample(pts: XZ[], spacing: number): XZ[] {
  const s = cumulative(pts);
  const total = s[s.length - 1];
  const n = Math.max(1, Math.round(total / spacing));
  const out: XZ[] = [];
  let j = 1;
  for (let i = 0; i <= n; i++) {
    const target = (i / n) * total;
    while (j < s.length - 1 && s[j] < target) j++;
    const a = pts[j - 1];
    const b = pts[j];
    const seg = s[j] - s[j - 1];
    const t = seg > 0 ? Math.min(1, Math.max(0, (target - s[j - 1]) / seg)) : 0;
    out.push({ x: lerp(a.x, b.x, t), z: lerp(a.z, b.z, t) });
  }
  return out;
}

/** Unit left normals of a polyline (pointing to the left of travel), averaged at vertices. */
function normals(pts: XZ[]): XZ[] {
  return pts.map((_, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    // left of travel direction (dx, dz) in x/z: rotate by −90° about +Y → (dz, −dx)
    return { x: dz / l, z: -dx / l };
  });
}

function segIntersect(a: XZ, b: XZ, c: XZ, d: XZ): { t: number; u: number } | null {
  const rx = b.x - a.x;
  const rz = b.z - a.z;
  const sx = d.x - c.x;
  const sz = d.z - c.z;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c.x - a.x) * sz - (c.z - a.z) * sx) / den;
  const u = ((c.x - a.x) * rz - (c.z - a.z) * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { t, u } : null;
}

// ─── lakes ────────────────────────────────────────────────────────────────────

/** Signed "distance" to a lake shoreline, m (negative inside). Approximate (scaled polar). */
export function lakeSignedDistance(lake: Lake, x: number, z: number): number {
  const dx = x - lake.center.x;
  const dz = z - lake.center.z;
  const r = (lake.rotationDeg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const u = (dx * c + dz * s) / lake.radiusX;
  const v = (-dx * s + dz * c) / lake.radiusZ;
  const rho = Math.sqrt(u * u + v * v);
  const th = Math.atan2(v, u);
  let rs = 1;
  for (const l of lake.lobes) rs += l.a * Math.sin(l.k * th + l.phase);
  return (rho - rs) * Math.sqrt(lake.radiusX * lake.radiusZ);
}

function lakeShoreline(lake: Omit<Lake, 'shoreline'>, n = 96): XZ[] {
  const r = (lake.rotationDeg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const pts: XZ[] = [];
  for (let i = 0; i < n; i++) {
    const th = (i / n) * Math.PI * 2;
    let rs = 1;
    for (const l of lake.lobes) rs += l.a * Math.sin(l.k * th + l.phase);
    const u = Math.cos(th) * rs * lake.radiusX;
    const v = Math.sin(th) * rs * lake.radiusZ;
    pts.push({ x: lake.center.x + u * c - v * s, z: lake.center.z + u * s + v * c });
  }
  return pts;
}

// ─── the layout ───────────────────────────────────────────────────────────────

export function createLayout(cfg: Config = CONFIG, regional: Regional = createRegional(cfg)): WorldLayout {
  const seed = cfg.world.seed | 0;
  const rnd = mulberry32(seed ^ 0x5eed);
  const nWig = createSimplex2D(seed + 91);
  const rs = newRegionalSample();
  const rw = runwayFrame(cfg);
  const ap = cfg.world.airport;

  // ── Airport ────────────────────────────────────────────────────────────────
  const rect = (along0: number, along1: number, across0: number, across1: number, alongIsLong = true): OrientedRect => {
    const c = fromRunwayCoords((along0 + along1) / 2, (across0 + across1) / 2, rw);
    return alongIsLong
      ? { center: c, halfLength: (along1 - along0) / 2, halfWidth: (across1 - across0) / 2, headingDeg: rw.headingDeg % 360 }
      : { center: c, halfLength: (across1 - across0) / 2, halfWidth: (along1 - along0) / 2, headingDeg: (rw.headingDeg + 90) % 360 };
  };
  const TWY = 110; // parallel taxiway centreline offset (east of the runway), m
  const TWY_HW = 6;
  const L = rw.length;
  const taxiways: Taxiway[] = [
    { name: 'A', kind: 'parallel', rect: rect(19, L - 19, TWY - TWY_HW, TWY + TWY_HW) },
    { name: 'A1', kind: 'connector', rect: rect(19, 31, rw.halfWidth - 1, TWY - TWY_HW + 1, false) },
    { name: 'A2', kind: 'connector', rect: rect(L / 2 - 6, L / 2 + 6, rw.halfWidth - 1, TWY - TWY_HW + 1, false) },
    { name: 'A3', kind: 'connector', rect: rect(L - 31, L - 19, rw.halfWidth - 1, TWY - TWY_HW + 1, false) },
  ];
  const APRON_A0 = L / 2 - 190;
  const APRON_A1 = L / 2 + 190;
  const APRON_C0 = TWY + TWY_HW - 1;
  const APRON_C1 = 246;
  const apron = rect(APRON_A0, APRON_A1, APRON_C0, APRON_C1);
  const runwayRect: OrientedRect = { center: { ...rw.center }, halfLength: rw.halfLength, halfWidth: rw.halfWidth, headingDeg: rw.headingDeg % 360 };
  const pavedAreas = [runwayRect, ...taxiways.map((t) => t.rect), apron];
  const east = (rw.headingDeg + 90) % 360;
  const west = (rw.headingDeg + 270) % 360;
  const bld = (along: number, across: number, width: number, depth: number, height: number, facing: number): BuildingSpot => ({
    center: fromRunwayCoords(along, across, rw),
    headingDeg: facing,
    width,
    depth,
    height,
  });
  const hangarAcross = APRON_C1 + 14;
  const hangars: BuildingSpot[] = [
    bld(APRON_A0 + 26, hangarAcross, 34, 26, 9, west),
    bld(APRON_A0 + 70, hangarAcross, 34, 26, 9, west),
    bld(APRON_A0 + 114, hangarAcross + 4, 46, 34, 11, west),
    bld(APRON_A1 - 70, hangarAcross, 34, 26, 9, west),
    bld(APRON_A1 - 26, hangarAcross, 34, 26, 9, west),
  ];
  const terminal = bld(L / 2 - 4, APRON_C1 + 10, 38, 16, 6, west);
  const tower = bld(L / 2 + 40, APRON_C1 + 30, 7, 7, 22, west);
  const fuelP = fromRunwayCoords(APRON_A1 - 18, APRON_C0 + 30, rw);
  const fuel: Spot = { x: fuelP.x, z: fuelP.z, headingDeg: west };
  const parkingSpots: Spot[] = [];
  for (const across of [APRON_C0 + 30, APRON_C0 + 72])
    for (let along = APRON_A0 + 22; along <= APRON_A1 - 44; along += 24) {
      const p = fromRunwayCoords(along, across, rw);
      parkingSpots.push({ x: p.x, z: p.z, headingDeg: west });
    }
  const airport: AirportLayout = {
    name: ap.name,
    icao: ap.icao,
    elevation: ap.elevation,
    runway: rw,
    flatRadius: ap.flatRadius,
    blendWidth: ap.blendWidth,
    taxiways,
    apron,
    pavedAreas,
    hangars,
    tower,
    terminal,
    fuel,
    parkingSpots,
    windsock: fromRunwayCoords(L * 0.25, -70, rw),
    accessRoadStart: fromRunwayCoords(L / 2 - 10, APRON_C1 + 45, rw),
  };
  void east;

  // ── Coast ──────────────────────────────────────────────────────────────────
  const coastPolyline: XZ[] = [];
  for (let x = -40000; x <= 40000; x += 100) coastPolyline.push({ x, z: regional.coastZ(x) });
  const coast: CoastLayout = { zAt: regional.coastZ, polyline: coastPolyline, bay: { ...regional.bay } };

  // ── River ──────────────────────────────────────────────────────────────────
  const mouthX = regional.bay.x;
  const cz = regional.coastZ(mouthX);
  const riverCtrl: XZ[] = [
    { x: 9300, z: -25800 },
    { x: 8400, z: -22600 },
    { x: 6900, z: -19600 },
    { x: 7300, z: -16400 },
    { x: 6000, z: -13000 },
    { x: 5000, z: -9600 },
    { x: 4500, z: -6100 },
    { x: 3950, z: -2600 },
    { x: 3750, z: 0 },
    { x: 3900, z: 2400 },
    { x: mouthX + 150, z: cz - 1400 },
    { x: mouthX, z: cz - 300 },
    { x: mouthX - 80, z: cz + 1100 },
  ];
  const valleyDense = resample(catmullRom(riverCtrl, 32), 10);
  const valley = resample(valleyDense, 200);
  const vS = cumulative(valley);
  // Levels: follow a "valley floor" estimate, then force non-increasing downstream.
  // The floor estimate is the lowest ground across a ±300 m band, so the river sits in the
  // bottom of its valley and never runs above the land beside it.
  const vNrm = normals(valley);
  const vRaw = valley.map((p, i) => {
    let lo = Infinity;
    for (const off of [-300, -150, 0, 150, 300]) {
      regional.sample(p.x + vNrm[i].x * off, p.z + vNrm[i].z * off, rs);
      lo = Math.min(lo, rs.plains + 0.4 * rs.foot + 0.25 * rs.range - 2);
    }
    return lo;
  });
  const vLevels = vRaw.slice();
  // find the coast crossing (first point in the sea)
  let seaIdx = valley.length - 1;
  for (let i = 0; i < valley.length; i++) {
    if (valley[i].z > regional.coastZ(valley[i].x)) {
      seaIdx = i;
      break;
    }
  }
  for (let i = 1; i < valley.length; i++) vLevels[i] = Math.min(vLevels[i], vLevels[i - 1] - 0.0004 * (vS[i] - vS[i - 1]));
  // smooth (moving average) and re-enforce monotonicity
  const sm = vLevels.map((_, i) => {
    let a = 0;
    let n = 0;
    for (let j = Math.max(0, i - 3); j <= Math.min(vLevels.length - 1, i + 3); j++, n++) a += vLevels[j];
    return a / n;
  });
  for (let i = 0; i < valley.length; i++) {
    let v = Math.min(sm[i], vRaw[i]);
    if (i > 0) v = Math.min(v, sm[i - 1] - 0.0004 * (vS[i] - vS[i - 1]));
    // estuary: close to the sea the river is at sea level
    const toSea = vS[seaIdx] - vS[i];
    const cap = toSea < 4000 ? 0.0007 * toSea : 2.8 + (toSea - 4000) * 0.05;
    v = Math.min(v, Math.max(0, cap));
    sm[i] = Math.max(0, v);
  }
  for (let i = 1; i < valley.length; i++) sm[i] = Math.min(sm[i], sm[i - 1]);
  const valleyLevels = sm;

  // Meandering channel. Rivers meander on flat flood plains only: the amplitude shrinks where
  // the valley floor is steep (otherwise a bend would carry the water past lower ground).
  const vN = normals(valleyDense);
  const vDS = cumulative(valleyDense);
  const totalV = vDS[vDS.length - 1];
  const gradAt = (s: number): number => {
    let j = 1;
    while (j < vS.length - 1 && vS[j] < s) j++;
    const a = Math.max(1, j - 2);
    const b = Math.min(vS.length - 1, j + 2);
    return Math.abs(valleyLevels[a - 1] - valleyLevels[b]) / Math.max(1, vS[b] - vS[a - 1]);
  };
  const meander: XZ[] = valleyDense.map((p, i) => {
    const s = vDS[i];
    const north = -p.z;
    const flat = 1 - smooth(0.0012, 0.006, gradAt(s));
    const amp = lerp(110, 32, smooth(3000, 10000, north)) * (0.2 + 0.8 * flat) * smooth(0, 1500, s) * smooth(0, 1800, totalV - s);
    const lambda = lerp(330, 150, smooth(3000, 10000, north));
    const off = amp * Math.sin(s / lambda + 2.2 * nWig(s / 4000, 0.5));
    return { x: p.x + vN[i].x * off, z: p.z + vN[i].z * off };
  });
  const points = resample(meander, 40);
  const pS = cumulative(points);
  const pTotal = pS[pS.length - 1];
  // levels by projection onto the valley centreline
  const projLevel = (x: number, z: number): number => {
    let best = Infinity;
    let lv = 0;
    for (let i = 1; i < valley.length; i++) {
      const a = valley[i - 1];
      const b = valley[i];
      const vx = b.x - a.x;
      const vz = b.z - a.z;
      const t = Math.max(0, Math.min(1, ((x - a.x) * vx + (z - a.z) * vz) / (vx * vx + vz * vz)));
      const d = Math.hypot(x - a.x - vx * t, z - a.z - vz * t);
      if (d < best) {
        best = d;
        lv = lerp(valleyLevels[i - 1], valleyLevels[i], t);
      }
    }
    return lv;
  };
  const levels = points.map((p) => projLevel(p.x, p.z));
  for (let i = 1; i < levels.length; i++) levels[i] = Math.min(levels[i], levels[i - 1]);
  levels[levels.length - 1] = 0;
  const halfWidths = points.map((_, i) => {
    const f = pS[i] / pTotal;
    return lerp(9, 34, smooth(0.05, 0.8, f)) + 26 * smooth(0.93, 1, f);
  });
  const depths = points.map((_, i) => lerp(2.2, 4.5, smooth(0.1, 0.8, pS[i] / pTotal)));
  const river: River = {
    name: 'Tater River',
    points,
    levels,
    halfWidths,
    depths,
    valley,
    valleyLevels,
    source: { ...points[0] },
    mouth: { ...points[points.length - 1] },
  };

  // ── Lakes ──────────────────────────────────────────────────────────────────
  const lakeDefs = [
    { name: 'Tater Lake', x: -6400, z: -9800, rx: 1500, rz: 640, rot: 28, depth: 22 },
    { name: 'Crown Tarn', x: -2600, z: -20800, rx: 520, rz: 330, rot: -20, depth: 18 },
  ];
  const lakes: Lake[] = lakeDefs.map((d, li) => {
    const lobes = [
      { k: 2, a: 0.08 + 0.06 * rnd(), phase: rnd() * 6.28 },
      { k: 3, a: 0.1 + 0.08 * rnd(), phase: rnd() * 6.28 },
      { k: 5, a: 0.05 + 0.04 * rnd(), phase: rnd() * 6.28 },
    ];
    // Find the nearby spot whose shoreline is most level (a natural basin), then set the
    // water just below the lowest shore point.
    let best = { x: d.x, z: d.z, spread: Infinity, min: 0 };
    for (let oz = -1500; oz <= 1500; oz += 250)
      for (let ox = -1500; ox <= 1500; ox += 250) {
        const cand = { name: d.name, center: { x: d.x + ox, z: d.z + oz }, radiusX: d.rx, radiusZ: d.rz, rotationDeg: d.rot, lobes, level: 0, maxDepth: d.depth };
        const shore = lakeShoreline(cand, 32);
        let lo = Infinity;
        let hi = -Infinity;
        for (const p of shore) {
          const h = regional.height(p.x, p.z);
          lo = Math.min(lo, h);
          hi = Math.max(hi, h);
        }
        const spread = hi - lo + 0.02 * Math.hypot(ox, oz);
        if (spread < best.spread) best = { x: d.x + ox, z: d.z + oz, spread, min: lo };
      }
    const base = { name: d.name, center: { x: best.x, z: best.z }, radiusX: d.rx, radiusZ: d.rz, rotationDeg: d.rot, lobes, level: 0, maxDepth: d.depth };
    let lo = Infinity;
    for (const p of lakeShoreline(base, 96)) lo = Math.min(lo, regional.height(p.x, p.z));
    const level = Math.round((lo - 1.0) * 10) / 10;
    void li;
    return { ...base, level, shoreline: lakeShoreline({ ...base, level }, 96) };
  });

  // ── Settlements ─────────────────────────────────────────────────────────────
  const towns: Town[] = [];
  const addTown = (name: string, kind: TownKind, x: number, z: number, radius: number, density: number) =>
    towns.push({ name, kind, x, z, radius, density, gridAngleDeg: Math.round(rnd() * 90), blockSize: kind === 'city' ? 90 : kind === 'town' ? 75 : 60 });
  addTown('Taterville', 'town', 2100, 2100, 850, 0.75);
  const cityX = -4700;
  addTown('Port Chateau', 'city', cityX, regional.coastZ(cityX) - 1350, 1900, 0.9);
  const lake0 = lakes[0];
  addTown('Millbrook', 'village', -7400, -1600, 320, 0.55);
  addTown('Eastfield', 'village', 9200, -2800, 340, 0.55);
  addTown('Lakeside', 'village', lake0.center.x + 900, lake0.center.z + 1500, 280, 0.5);
  addTown('Seaview', 'village', 12500, regional.coastZ(12500) - 450, 330, 0.6);
  addTown('Westhaven', 'village', -15500, regional.coastZ(-15500) - 500, 380, 0.6);
  addTown('Oakridge', 'village', -12500, -6200, 300, 0.5);
  addTown('Fernhill', 'village', 14500, -7200, 300, 0.5);
  // Highwater: up the valley, on the valley road (placed below).
  const hwIdx = valley.findIndex((p) => -p.z < 19500);
  const hwP = valley[Math.max(0, hwIdx)];
  const hwN = normals(valley)[Math.max(0, hwIdx)];
  // normals point east (left of downstream travel); the valley road runs on the west bank
  addTown('Highwater', 'village', hwP.x - hwN.x * 300, hwP.z - hwN.z * 300, 260, 0.5);

  const distToRiver = (x: number, z: number): number => {
    let best = Infinity;
    for (let i = 1; i < valley.length; i++) {
      const a = valley[i - 1];
      const b = valley[i];
      const vx = b.x - a.x;
      const vz = b.z - a.z;
      const t = Math.max(0, Math.min(1, ((x - a.x) * vx + (z - a.z) * vz) / (vx * vx + vz * vz)));
      best = Math.min(best, Math.hypot(x - a.x - vx * t, z - a.z - vz * t));
    }
    return best;
  };
  const inLake = (x: number, z: number, margin = 150): boolean => lakes.some((l) => lakeSignedDistance(l, x, z) < margin);
  // Procedural hamlets across the ±30 km map so the world is inhabited everywhere.
  const hamletNames = ['Ashby', 'Burnham', 'Cold Ashton', 'Dunmore', 'Elmstead', 'Foxley', 'Greystone', 'Hollins', 'Ivybridge', 'Kettering', 'Larkfield', 'Marsh End', 'Northwick', 'Pellow', 'Redbrook', 'Stoneleigh'];
  let tries = 0;
  let hn = 0;
  while (hn < hamletNames.length && tries++ < 4000) {
    const x = rnd() * 64000 - 32000;
    const z = rnd() * 50000 - 32000;
    regional.sample(x, z, rs);
    if (rs.coast < 900 || rs.h > 420 || rs.rangeMask > 0.25) continue;
    if (Math.hypot(x - rw.center.x, z - rw.center.z) < 4000) continue;
    if (towns.some((t) => Math.hypot(t.x - x, t.z - z) < t.radius + 2600)) continue;
    if (distToRiver(x, z) < 500 || inLake(x, z, 400)) continue;
    addTown(hamletNames[hn++], 'hamlet', Math.round(x), Math.round(z), 160 + Math.round(rnd() * 80), 0.4);
  }

  // ── Roads ──────────────────────────────────────────────────────────────────
  const roads: Road[] = [];
  const wiggle = (ctrl: XZ[], amp: number, key: number): XZ[] => {
    const dense = resample(catmullRom(ctrl, 16), 25);
    if (amp <= 0) return dense;
    const nn = normals(dense);
    const s = cumulative(dense);
    const tot = s[s.length - 1];
    return dense.map((p, i) => {
      const fade = smooth(0, 400, s[i]) * smooth(0, 400, tot - s[i]);
      const o = amp * fade * nWig(s[i] / 1400 + key * 13.1, key * 3.7);
      return { x: p.x + nn[i].x * o, z: p.z + nn[i].z * o };
    });
  };
  const addRoad = (name: string, kind: RoadKind, ctrl: XZ[], amp = 0) => {
    const width = kind === 'highway' ? 11 : kind === 'lane' ? 5 : 7;
    roads.push({ name, kind, width, points: resample(wiggle(ctrl, amp, roads.length + 1), 25) });
  };
  const town = towns[0];
  const city = towns[1];
  const byName = (n: string) => towns.find((t) => t.name === n)!;
  const acc = airport.accessRoadStart;
  addRoad('Airport Road', 'access', [acc, { x: acc.x + 420, z: acc.z + 140 }, { x: 1300, z: 900 }, { x: 1800, z: 1700 }, { x: town.x, z: town.z }]);
  // Coast highway: ~900 m inland, bending through the city.
  const hwyCtrl: XZ[] = [];
  for (let x = -44000; x <= 44000; x += 2000) hwyCtrl.push({ x, z: regional.coastZ(x) - 950 - 420 * Math.exp(-(((x - city.x) / 2600) ** 2)) });
  addRoad('Coast Highway', 'highway', hwyCtrl, 0);
  // Valley road: west of the river valley, from the town up to Highwater.
  const vNorm = normals(valley);
  const vrCtrl: XZ[] = [{ x: town.x, z: town.z }];
  for (let i = valley.length - 1; i >= 0; i--) {
    const p = valley[i];
    if (p.z > town.z - 900) continue;
    if (-p.z > 19700) break;
    if (i % 5 !== 0) continue;
    const side = -1; // the normal points left of downstream travel = east; go west
    const off = lerp(360, 250, smooth(4000, 12000, -p.z));
    vrCtrl.push({ x: p.x + side * vNorm[i].x * off, z: p.z + side * vNorm[i].z * off });
  }
  const hw = byName('Highwater');
  vrCtrl.push({ x: hw.x, z: hw.z });
  addRoad('Valley Road', 'road', vrCtrl, 0);
  const mb = byName('Millbrook');
  addRoad('Millbrook Lane', 'road', [{ x: town.x, z: town.z }, { x: 800, z: 2950 }, { x: -1500, z: 2800 }, { x: -4300, z: 1300 }, { x: mb.x, z: mb.z }], 70);
  const ef = byName('Eastfield');
  addRoad('Eastfield Road', 'road', [{ x: town.x, z: town.z }, { x: 3600, z: 1300 }, { x: 6400, z: -1200 }, { x: ef.x, z: ef.z }], 60);
  addRoad('Harbour Road', 'road', [{ x: town.x, z: town.z }, { x: 300, z: 4000 }, { x: -2600, z: 5300 }, { x: city.x, z: city.z }], 60);
  const ls = byName('Lakeside');
  addRoad('Lake Road', 'road', [{ x: mb.x, z: mb.z }, { x: (mb.x + ls.x) / 2 - 400, z: (mb.z + ls.z) / 2 }, { x: ls.x, z: ls.z }], 80);
  // Lanes: each other settlement to its nearest already-connected neighbour, if the way is clear.
  const connected = new Set(['Taterville', 'Port Chateau', 'Millbrook', 'Eastfield', 'Lakeside', 'Highwater']);
  const pathClear = (a: XZ, b: XZ): boolean => {
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.ceil(d / 150);
    for (let i = 0; i <= n; i++) {
      const x = lerp(a.x, b.x, i / n);
      const z = lerp(a.z, b.z, i / n);
      regional.sample(x, z, rs);
      if (rs.coast < 120 || rs.h > 520 || inLake(x, z, 80)) return false;
      if (Math.hypot(x - rw.center.x, z - rw.center.z) < ap.flatRadius + 200) return false;
    }
    return true;
  };
  const pending = towns.filter((t) => !connected.has(t.name));
  pending.sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));
  for (const t of pending) {
    const cands = towns.filter((o) => connected.has(o.name)).sort((a, b) => Math.hypot(a.x - t.x, a.z - t.z) - Math.hypot(b.x - t.x, b.z - t.z));
    for (const o of cands.slice(0, 3)) {
      const d = Math.hypot(o.x - t.x, o.z - t.z);
      if (d > 12000) break;
      if (!pathClear(t, o)) continue;
      const mid = { x: (t.x + o.x) / 2 + (rnd() - 0.5) * d * 0.15, z: (t.z + o.z) / 2 + (rnd() - 0.5) * d * 0.15 };
      addRoad(`${t.name} Lane`, 'lane', [{ x: t.x, z: t.z }, mid, { x: o.x, z: o.z }], 50);
      connected.add(t.name);
      break;
    }
  }

  // ── Bridges: where roads cross the river channel ───────────────────────────
  const bridges: Bridge[] = [];
  for (const road of roads) {
    for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1];
      const b = road.points[i];
      for (let j = 1; j < points.length; j++) {
        const hit = segIntersect(a, b, points[j - 1], points[j]);
        if (!hit) continue;
        const x = lerp(a.x, b.x, hit.t);
        const z = lerp(a.z, b.z, hit.t);
        const hwR = lerp(halfWidths[j - 1], halfWidths[j], hit.u);
        const dirR = { x: points[j].x - points[j - 1].x, z: points[j].z - points[j - 1].z };
        const dirRd = { x: b.x - a.x, z: b.z - a.z };
        const sin = Math.abs(dirR.x * dirRd.z - dirR.z * dirRd.x) / (Math.hypot(dirR.x, dirR.z) * Math.hypot(dirRd.x, dirRd.z));
        bridges.push({
          road: road.name,
          x,
          z,
          headingDeg: headingOf(dirRd.x, dirRd.z),
          length: (2 * (hwR + 16)) / Math.max(0.35, sin),
          width: road.width + 2,
          waterLevel: lerp(levels[j - 1], levels[j], hit.u),
        });
      }
    }
  }

  return {
    seed,
    seaLevel: cfg.world.seaLevel,
    airport,
    coast,
    islands: regional.islands.map((i) => ({ ...i })),
    lakes,
    rivers: [river],
    towns,
    roads,
    bridges,
  };
}

let cached: WorldLayout | null = null;
/** The layout for the default CONFIG (built once, lazily). */
export function getLayout(): WorldLayout {
  if (!cached) cached = createLayout(CONFIG);
  return cached;
}
