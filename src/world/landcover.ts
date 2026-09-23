/**
 * What covers the ground: landcover weights for the terrain shader and wave-2
 * vegetation, the physics surface type, and tree density. PURE, deterministic.
 *
 * Classes are allocated in priority order (snow → rock → urban → sand →
 * forest → field → grass), each taking its presence × what is left, so the
 * weights are always in [0, 1] and sum to 1. Water overrides everything.
 */
import { CONFIG, type Config } from '../config';
import type { SurfaceType } from '../types';
import { createSimplex2D, fbm } from './noise';
import { getHeightfield, newTerrainSample, type Heightfield, type TerrainSample } from './heightfield';
import { runwayFrames, toRunwayCoords, type RunwayFrame } from './runway';
import type { OrientedRect, Town } from './layout';
import { fieldAt, newFieldInfo } from './fields';
import { fieldPaving, type WorldPave } from './airport/field';

export interface LandcoverWeights {
  forest: number;
  field: number;
  grass: number;
  rock: number;
  snow: number;
  sand: number;
  urban: number;
  water: number;
}

/** Packing order of the weights (terrain vertex attributes: lc0 = first four, lc1 = last four). */
export const LANDCOVER_KEYS = ['forest', 'field', 'grass', 'rock', 'snow', 'sand', 'urban', 'water'] as const;

export function newLandcover(): LandcoverWeights {
  return { forest: 0, field: 0, grass: 1, rock: 0, snow: 0, sand: 0, urban: 0, water: 0 };
}

const smooth = (e0: number, e1: number, x: number): number => {
  let t = (x - e0) / (e1 - e0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
};

function inRect(r: OrientedRect, x: number, z: number, margin = 0): boolean {
  const h = (r.headingDeg * Math.PI) / 180;
  const fx = Math.sin(h);
  const fz = -Math.cos(h);
  const dx = x - r.center.x;
  const dz = z - r.center.z;
  const a = dx * fx + dz * fz;
  const b = dx * -fz + dz * fx; // right = (cos h, sin h) = (-fz, fx)
  return Math.abs(a) <= r.halfLength + margin && Math.abs(b) <= r.halfWidth + margin;
}

export interface Landcover {
  /**
   * Weights from a full terrain sample, the normal's y component (slope) and optionally its
   * z component (aspect: < 0 faces north, where snow lies lower). Writes into `out`.
   * `fieldDetail` (default true) turns field-shaped woodlots and hedgerows into forest; the
   * terrain mesh passes false and lets the shader draw those crisply from the same field model.
   */
  fromSample(s: TerrainSample, normalY: number, x: number, z: number, out: LandcoverWeights, normalZ?: number, fieldDetail?: boolean): LandcoverWeights;
  /** Weights at x, z. Writes into `out`. */
  at(x: number, z: number, out: LandcoverWeights): LandcoverWeights;
  surfaceAt(x: number, z: number): SurfaceType;
  treeDensity(x: number, z: number): number;
  /** Tree density from an existing sample + weights (for batch use in workers). */
  treeDensityFrom(s: TerrainSample, w: LandcoverWeights, x: number, z: number): number;
  /** True on a paved airport surface (any runway, taxiways, aprons, car parks, the perimeter road). */
  isPaved(x: number, z: number): boolean;
}

export function createLandcover(hf: Heightfield = getHeightfield(), cfg: Config = CONFIG): Landcover {
  const seed = cfg.world.seed | 0;
  const L = hf.layout;
  // Every runway (36/18 first, then the crossing 03/21): approach corridors, mown airfield, surfaces.
  const runways: RunwayFrame[] = runwayFrames(cfg);
  const nForest = createSimplex2D(seed + 201);
  const nSnow = createSimplex2D(seed + 202);
  const nUrban = createSimplex2D(seed + 203);
  const nTree = createSimplex2D(seed + 204);
  const nField = createSimplex2D(seed + 205);
  const towns: Town[] = L.towns;
  const flatR = L.airport.flatRadius;
  const taxiApron = [...L.airport.taxiways.map((t) => t.rect), L.airport.apron];
  // The airfield beyond layout.ts (airport/field.ts): the crossing runway's pieces, its taxiways,
  // the GA ramps, T-hangar lanes, car parks and the perimeter road — convex polygons, world x/z.
  const field: WorldPave[] = fieldPaving(cfg);
  let fx0 = Infinity, fx1 = -Infinity, fz0 = Infinity, fz1 = -Infinity;
  for (const f of field) {
    fx0 = Math.min(fx0, f.x0);
    fx1 = Math.max(fx1, f.x1);
    fz0 = Math.min(fz0, f.z0);
    fz1 = Math.max(fz1, f.z1);
  }
  const inPoly = (poly: { x: number; z: number }[], x: number, z: number, eps: number): boolean => {
    // convex, either winding: every edge cross product has the same sign (within eps metres)
    let sgn = 0;
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const A = poly[i];
      const B = poly[(i + 1) % n];
      const ex = B.x - A.x;
      const ez = B.z - A.z;
      const l = Math.sqrt(ex * ex + ez * ez);
      if (l < 1e-12) continue;
      const cr = (ex * (z - A.z) - ez * (x - A.x)) / l;
      if (sgn === 0) {
        let area = 0;
        for (let k = 0; k < n; k++) area += poly[k].x * poly[(k + 1) % n].z - poly[(k + 1) % n].x * poly[k].z;
        sgn = area >= 0 ? 1 : -1;
      }
      if (cr * sgn < -eps) return false;
    }
    return true;
  };
  const onAnyRunway = (x: number, z: number, eps: number): boolean => {
    for (let i = 0; i < runways.length; i++) {
      const rw = runways[i];
      const q = toRunwayCoords(x, z, rw);
      if (q.along >= -eps && q.along <= rw.length + eps && Math.abs(q.across) <= rw.halfWidth + eps) return true;
    }
    return false;
  };
  /** Kind of field pavement at x, z (null if none). */
  const fieldAtXZ = (x: number, z: number, eps: number): WorldPave['kind'] | null => {
    if (x < fx0 - eps || x > fx1 + eps || z < fz0 - eps || z > fz1 + eps) return null;
    for (let i = 0; i < field.length; i++) {
      const f = field[i];
      if (x < f.x0 - eps || x > f.x1 + eps || z < f.z0 - eps || z > f.z1 + eps) continue;
      if (inPoly(f.poly, x, z, eps)) return f.kind;
    }
    return null;
  };

  /** 0..1 presence of cleared airport ground (no forest, no fields): the airfield + approach corridors. */
  const airportClear = (x: number, z: number, dA: number): number => {
    let c = 1 - smooth(flatR + 300, flatR + 800, dA);
    for (let i = 0; i < runways.length; i++) {
      const rw = runways[i];
      const q = toRunwayCoords(x, z, rw);
      const past = q.along < 0 ? -q.along : q.along > rw.length ? q.along - rw.length : 0;
      if (past < 4000) {
        const halfW = 160 + 0.12 * past;
        const corridor = (1 - smooth(halfW, halfW + 150, Math.abs(q.across))) * (1 - smooth(3500, 4000, past));
        if (corridor > c) c = corridor;
      }
    }
    return c;
  };

  /** 0..1: the grass airfield itself (no crops within ~330 m of the runway/taxiway/apron strip). */
  const airfieldGrass = (x: number, z: number): number => {
    let g = 0;
    for (let i = 0; i < runways.length; i++) {
      const rw = runways[i];
      const q = toRunwayCoords(x, z, rw);
      const out = q.along < 0 ? -q.along : q.along > rw.length ? q.along - rw.length : 0;
      // 36/18: less room needed west of the runway; the crossing runways: a narrower mown strip
      const acr = i === 0 ? (q.across < 0 ? -q.across * 1.6 : q.across) : Math.abs(q.across) * 1.9;
      const v = (1 - smooth(330, 430, acr)) * (1 - smooth(260, 380, out));
      if (v > g) g = v;
    }
    return g;
  };

  const urbanPresence = (x: number, z: number): number => {
    let u = 0;
    for (let i = 0; i < towns.length; i++) {
      const t = towns[i];
      const dx = x - t.x;
      const dz = z - t.z;
      const r = t.radius;
      const d2 = dx * dx + dz * dz;
      if (d2 > r * r * 1.7) continue;
      const d = Math.sqrt(d2) + r * 0.18 * nUrban(x / 260, z / 260);
      const v = t.density * (1 - smooth(r * 0.5, r * 1.05, d)) + (1 - smooth(0, r * 0.25, d)) * (1 - t.density);
      if (v > u) u = v;
    }
    return u > 1 ? 1 : u;
  };

  const fi = newFieldInfo();
  const fromSample = (s: TerrainSample, ny: number, x: number, z: number, out: LandcoverWeights, nz = 0, fieldDetail = true): LandcoverWeights => {
    const h = s.h;
    // Water first (under the sea, a lake or the river).
    let submerged = h < 0;
    if (!submerged && s.lakeIndex >= 0 && s.lakeSd < 40 && h < L.lakes[s.lakeIndex].level) submerged = true;
    if (!submerged && s.riverD < s.riverHalfWidth + 14 && h < s.riverLevel) submerged = true;
    if (submerged) {
      out.forest = out.field = out.grass = out.rock = out.snow = out.sand = out.urban = 0;
      out.water = 1;
      return out;
    }
    const slope = 1 - ny; // 0 flat, 0.13 at 30°, 0.29 at 45°, 0.5 at 60°
    const dA = s.airportD;
    // The paved airfield is drawn by the terrain shader (and wave-2 meshes) from the layout's
    // rectangles; its landcover is the mown grass around it (no town texture, no trees).
    const onPaved = dA < flatR && (onAnyRunway(x, z, 0) || taxiApron.some((r) => inRect(r, x, z, 2)) || fieldAtXZ(x, z, 2) !== null);
    // Alpine zonation: forest → meadow/scree → rock → snow; snow lies ~200 m lower on north faces.
    const northness = nz < 0 ? Math.min(1, -nz * 3) : 0;
    const snowLine = 2060 + 170 * nSnow(x / 3200, z / 3200) - 220 * northness;
    const snowP = smooth(snowLine - 160, snowLine + 150, h) * (1 - smooth(0.36, 0.54, slope));
    const alpine = smooth(1600, 2250, h + 180 * nSnow(x / 700, z / 700));
    const rockP = Math.max(smooth(0.2, 0.36, slope) * smooth(150, 700, h + 400 * s.rangeMask), alpine * (0.3 + 0.7 * smooth(0.06, 0.22, slope)) * (1 - snowP));
    const urbanP = onPaved ? 0 : urbanPresence(x, z);
    const c = s.coast;
    const sandP = (1 - smooth(1.9, 3.6, h)) * (1 - smooth(160, 320, c)) * (1 - smooth(0.1, 0.2, slope));
    // Forest patches: more in hills and foothills, woodlots on the plains, riparian strips, a tree line.
    const clear = airportClear(x, z, dA);
    const f = 0.5 + 0.5 * fbm(nForest, x / 2600, z / 2600, 4);
    const hilly = Math.max(s.footMask, s.rangeMask, smooth(90, 260, h));
    let bias = -0.13 + 0.3 * hilly;
    bias += 0.28 * (1 - smooth(s.riverHalfWidth + 20, s.riverHalfWidth + 160, s.riverD));
    let forestP = smooth(0.55, 0.62, f + bias);
    forestP *= 1 - smooth(1480, 1780, h + 140 * nSnow(x / 900, z / 900) + 120 * northness); // tree line
    forestP *= 1 - smooth(0.3, 0.45, slope);
    forestP *= 1 - clear;
    if (s.roadD < s.roadHalfWidth + 12) forestP *= smooth(s.roadHalfWidth + 3, s.roadHalfWidth + 12, s.roadD);
    // Farmland: gentle, low ground away from the beach; a little rough grazing mixed in.
    const rough = smooth(0.62, 0.75, 0.5 + 0.5 * nField(x / 1700, z / 1700));
    const fieldP = (1 - smooth(260, 480, h)) * (1 - smooth(0.07, 0.15, slope)) * smooth(250, 650, c) * (1 - airfieldGrass(x, z)) * (1 - 0.8 * rough);

    // Field-shaped woodlots and hedgerows (the shader draws the same fields).
    if (fieldDetail && fieldP > 0.05) {
      fieldAt(x, z, fi);
      if (fi.woodlot) forestP = Math.max(forestP, fieldP);
      else if (fi.margin === 'hedge' && fi.dBlock < 2.5) forestP = Math.max(forestP, fieldP * 0.9);
    }

    let rem = 1;
    const snowW = snowP * rem;
    rem -= snowW;
    const rockW = rockP * rem;
    rem -= rockW;
    const urbanW = urbanP * rem;
    rem -= urbanW;
    const sandW = sandP * rem;
    rem -= sandW;
    const forestW = forestP * rem;
    rem -= forestW;
    const fieldW = fieldP * rem;
    rem -= fieldW;
    out.snow = snowW;
    out.rock = rockW;
    out.urban = urbanW;
    out.sand = sandW;
    out.forest = forestW;
    out.field = fieldW;
    out.grass = rem < 0 ? 0 : rem;
    out.water = 0;
    return out;
  };

  const ts = newTerrainSample();
  const nrm = { x: 0, y: 1, z: 0 };
  const at = (x: number, z: number, out: LandcoverWeights): LandcoverWeights => {
    hf.sample(x, z, ts);
    hf.normalInto(x, z, nrm);
    return fromSample(ts, nrm.y, x, z, out, nrm.z);
  };

  // Pavement tests carry a micrometre tolerance so points exactly on an edge don't flip with rounding.
  const EPS = 1e-6;
  const isPaved = (x: number, z: number): boolean => onAnyRunway(x, z, EPS) || taxiApron.some((r) => inRect(r, x, z, EPS)) || fieldAtXZ(x, z, EPS) !== null;

  const sw = newLandcover();
  const surfaceAt = (x: number, z: number): SurfaceType => {
    if (onAnyRunway(x, z, EPS)) return 'runway';
    if (taxiApron.some((r) => inRect(r, x, z, EPS))) return 'asphalt';
    const fk = fieldAtXZ(x, z, EPS);
    if (fk !== null) return fk === 'runway' ? 'runway' : 'asphalt';
    hf.sample(x, z, ts);
    if (ts.roadD < ts.roadHalfWidth) return 'asphalt';
    hf.normalInto(x, z, nrm);
    const w = fromSample(ts, nrm.y, x, z, sw, nrm.z);
    if (w.water > 0.5) return 'water';
    let best: SurfaceType = 'grass';
    let bv = w.grass;
    if (w.field > bv) (bv = w.field), (best = 'field');
    if (w.forest > bv) (bv = w.forest), (best = 'forest');
    if (w.rock > bv) (bv = w.rock), (best = 'rock');
    if (w.snow > bv) (bv = w.snow), (best = 'snow');
    if (w.sand > bv) (bv = w.sand), (best = 'sand');
    if (w.urban > bv) (bv = w.urban), (best = 'urban');
    return best;
  };

  const treeDensityFrom = (s: TerrainSample, w: LandcoverWeights, x: number, z: number): number => {
    if (w.water > 0) return 0;
    if (s.roadD < s.roadHalfWidth + 6) return 0;
    const dA = s.airportD;
    if (dA < flatR + 300) return 0;
    if (airportClear(x, z, dA) > 0) return 0;
    const u = urbanPresence(x, z);
    if (u > 0.55) return 0;
    let d = w.forest * (0.78 + 0.22 * nTree(x / 90, z / 90));
    // riparian trees along the river banks
    if (s.riverD < s.riverHalfWidth + 70) d = Math.max(d, 0.55 * (1 - smooth(s.riverHalfWidth + 10, s.riverHalfWidth + 70, s.riverD)) * (1 - w.field));
    // scattered trees in meadows, gardens on the edge of towns
    d += w.grass * 0.04 + (u > 0.15 ? 0.12 * (1 - u) : 0);
    d *= 1 - smooth(0.4, 0.6, u);
    d *= 1 - smooth(0.5, 0.9, w.field); // no trees in the middle of fields
    if (s.roadD < s.roadHalfWidth + 12) d *= smooth(s.roadHalfWidth + 6, s.roadHalfWidth + 12, s.roadD);
    return d < 0 ? 0 : d > 1 ? 1 : d;
  };

  const tw = newLandcover();
  const treeDensity = (x: number, z: number): number => {
    if (isPaved(x, z)) return 0;
    hf.sample(x, z, ts);
    hf.normalInto(x, z, nrm);
    const w = fromSample(ts, nrm.y, x, z, tw, nrm.z);
    return treeDensityFrom(ts, w, x, z);
  };

  return { fromSample, at, surfaceAt, treeDensity, treeDensityFrom, isPaved };
}

let defaultLC: Landcover | null = null;
/** Landcover for the default world (lazy). */
export function getLandcover(): Landcover {
  if (!defaultLC) defaultLC = createLandcover();
  return defaultLC;
}

/** Landcover weights at x, z (a new object; use getLandcover().at(x, z, out) in hot loops). */
export function landcoverAt(x: number, z: number): LandcoverWeights {
  return getLandcover().at(x, z, newLandcover());
}

/** Physics surface type at x, z. */
export function surfaceAt(x: number, z: number): SurfaceType {
  return getLandcover().surfaceAt(x, z);
}

/** 0..1 density of trees at x, z (0 on pavement, roads, water, fields, town centres, approach paths). */
export function treeDensity(x: number, z: number): number {
  return getLandcover().treeDensity(x, z);
}
