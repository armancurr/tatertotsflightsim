/**
 * The terrain height function the whole sim shares: physics (Environment),
 * the terrain mesh builder (worker) and wave-2 placement all call it, so what
 * you see is what you hit. PURE, deterministic, allocation-free, ≳1M samples/s.
 *
 * Composition (each stage continuous):
 *   regional base (coast/sea floor/plains/foothills/range, regional.ts)
 *   → river valley shaping (floor pulled to the river level, wide in the mountains)
 *   → lake basins (flat water surface, beds below the level, rising shores)
 *   → airport plateau (exactly the field elevation within flatRadius, smootherstep blend)
 *   → road flattening (cross-slope removed toward a smoothed road profile)
 *   → river channel carve (bed below the water level, low banks; cuts through roads = bridges)
 */
import { CONFIG, type Config } from '../config';
import type { Vec3 } from '../types';
import { createRegional, newRegionalSample, type Regional } from './regional';
import { createLayout, getLayout, lakeSignedDistance, type WorldLayout, type Lake } from './layout';
import { PolylineIndex, newPolyQuery } from './polyline';

/** Everything the terrain function knows about a point (filled by `sample`). */
export interface TerrainSample {
  /** Final terrain height, m MSL. */
  h: number;
  /** Regional height before any carving. */
  base: number;
  /** Signed distance inland from the coast (+ land). */
  coast: number;
  footMask: number;
  rangeMask: number;
  /** Distance to the river channel centreline (Infinity when far). */
  riverD: number;
  /** River water level / half-width near this point (NaN / 0 when far). */
  riverLevel: number;
  riverHalfWidth: number;
  /** 0 on the river valley floor → 1 outside the valley. */
  valleyT: number;
  /** Lake index (−1 when none) and signed distance to its shore (+ outside). */
  lakeIndex: number;
  lakeSd: number;
  /** Distance to the nearest road centreline (Infinity when far) and its half-width. */
  roadD: number;
  roadHalfWidth: number;
  /** Distance to the runway centre. */
  airportD: number;
}

export function newTerrainSample(): TerrainSample {
  return {
    h: 0,
    base: 0,
    coast: 0,
    footMask: 0,
    rangeMask: 0,
    riverD: Infinity,
    riverLevel: NaN,
    riverHalfWidth: 0,
    valleyT: 1,
    lakeIndex: -1,
    lakeSd: Infinity,
    roadD: Infinity,
    roadHalfWidth: 0,
    airportD: 0,
  };
}

export interface Heightfield {
  readonly cfg: Config;
  readonly regional: Regional;
  readonly layout: WorldLayout;
  /** Terrain height, m MSL. */
  height(x: number, z: number): number;
  /** Unit surface normal (allocates a new object). */
  normal(x: number, z: number): Vec3;
  /** Unit surface normal written into `out`. */
  normalInto(x: number, z: number, out: Vec3): Vec3;
  /** Full sample (height + the feature distances landcover needs). */
  sample(x: number, z: number, out: TerrainSample): TerrainSample;
  /** Water surface height at x,z (sea 0, lake level, river level) or null when dry. */
  waterLevel(x: number, z: number): number | null;
  /** True near carved river banks / lake rims / road shoulders (where steep cuts are intended). */
  nearCarvedBank(x: number, z: number): boolean;
}

// Tunables (m)
const BANK_H = 1.8; // river bank height above the water
const BANK_W = 14; // width of the bank rise beyond the water's edge
const VALLEY_INNER = 70; // flat valley floor half-width around the valley centreline
const VALLEY_W_PLAINS = 380;
const VALLEY_W_MOUNTAINS = 3200;
const LAKE_RIM = 320;
const ROAD_SHOULDER = 28;

const smooth = (e0: number, e1: number, x: number): number => {
  let t = (x - e0) / (e1 - e0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
};
const smoother = (t: number): number => {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * t * (t * (t * 6 - 15) + 10);
};

export function createHeightfield(cfg: Config = CONFIG, layout?: WorldLayout): Heightfield {
  const regional = createRegional(cfg);
  const L = layout ?? createLayout(cfg, regional);
  const ap = L.airport;
  const elev = ap.elevation;
  const apX = ap.runway.center.x;
  const apZ = ap.runway.center.z;
  const flatR = ap.flatRadius;
  const blendW = ap.blendWidth;

  // ── River indices ────────────────────────────────────────────────────────
  const river = L.rivers[0];
  const valleyIdx = new PolylineIndex([river.valley], [river.valleyLevels.map((l) => [l])], 1, VALLEY_INNER + VALLEY_W_MOUNTAINS + 10, 512, 60);
  const fineVals = river.points.map((_, i) => [river.levels[i], river.halfWidths[i], river.depths[i]]);
  let maxHW = 0;
  for (const w of river.halfWidths) maxHW = Math.max(maxHW, w);
  const RIVER_R = maxHW + BANK_W + 60;
  const channelIdx = new PolylineIndex([river.points], [fineVals], 3, RIVER_R, 128, 12);
  const qv = newPolyQuery(1);
  const qc = newPolyQuery(3);
  const qr = newPolyQuery(2);

  // ── Lakes ────────────────────────────────────────────────────────────────
  const lakes: Lake[] = L.lakes;
  const lakeReach = lakes.map((l) => {
    let a = 1;
    for (const lb of l.lobes) a += Math.abs(lb.a);
    const r = Math.max(l.radiusX, l.radiusZ) * a;
    // sd is scaled by sqrt(rx·rz); convert the rim width to a conservative world radius
    const rim = (LAKE_RIM * Math.max(l.radiusX, l.radiusZ)) / Math.sqrt(l.radiusX * l.radiusZ);
    return r + rim + 50;
  });

  const rs = newRegionalSample();

  // Stage 1–4: everything but roads and the river channel.
  const preRoad = (x: number, z: number, out: TerrainSample): number => {
    regional.sample(x, z, rs);
    let h = rs.h;
    out.base = h;
    out.coast = rs.coast;
    out.footMask = rs.footMask;
    out.rangeMask = rs.rangeMask;
    // River valley shaping
    out.valleyT = 1;
    if (valleyIdx.query(x, z, qv)) {
      const lv = qv.v[0];
      const floor = lv + BANK_H;
      // wide in the mountains, and never steeper than the height it has to blend away allows
      let valleyW = VALLEY_W_PLAINS + (VALLEY_W_MOUNTAINS - VALLEY_W_PLAINS) * Math.max(rs.footMask, rs.rangeMask);
      const need = (h - floor) * 1.5;
      if (need > valleyW) valleyW = need < VALLEY_W_MOUNTAINS ? need : VALLEY_W_MOUNTAINS;
      const t = smooth(VALLEY_INNER, VALLEY_INNER + valleyW, qv.d);
      let hv = floor + (h - floor) * t;
      // natural levee: the flood plain beside the channel never lies below the water
      const levee = floor - Math.max(0, qv.d - VALLEY_INNER) * 0.011;
      if (levee > hv) hv = levee;
      // On land the valley floor is pulled to the river's bank level (building low natural
      // levees where the land lies below it); at sea nothing is raised.
      let raise = rs.coast / 150;
      raise = raise < 0 ? 0 : raise > 1 ? 1 : raise;
      h += raise * (hv - h);
      out.valleyT = t;
    }
    // Levee from the channel's own level: the ground right beside the water is always above it.
    if (rs.coast > 0 && channelIdx.query(x, z, qc)) {
      const lvF = qc.v[0];
      const e = qc.d - qc.v[1] - BANK_W;
      const levee = lvF + BANK_H - Math.max(0, e) * 0.011 - Math.max(0, e - 45) * 0.5;
      const raise = rs.coast < 150 ? rs.coast / 150 : 1;
      if (levee > h) h += (levee - h) * raise;
    }
    // Lakes
    out.lakeIndex = -1;
    out.lakeSd = Infinity;
    for (let i = 0; i < lakes.length; i++) {
      const lk = lakes[i];
      const dx = x - lk.center.x;
      const dz = z - lk.center.z;
      const R = lakeReach[i];
      if (dx * dx + dz * dz > R * R) continue;
      const sd = lakeSignedDistance(lk, x, z);
      if (sd < out.lakeSd) {
        out.lakeSd = sd;
        out.lakeIndex = i;
      }
      if (sd >= LAKE_RIM) continue;
      const prof = sd < 0 ? lk.level - 0.4 - lk.maxDepth * smooth(0, 350, -sd) : lk.level - 0.4 + 0.05 * sd;
      const w = 1 - smooth(0, LAKE_RIM, sd);
      h += (prof - h) * w;
      // A natural lip that holds the water where the land falls away outside the shore
      // (continuous: equals the bed profile at the shoreline, rises to +1.2 m, then drops away).
      const lip = lk.level - 0.4 + Math.min(1.6, 0.08 * sd) - Math.max(0, sd - 120) * 0.25;
      if (lip > h) h = lip;
    }
    // Airport plateau
    const adx = x - apX;
    const adz = z - apZ;
    const dA = Math.sqrt(adx * adx + adz * adz);
    out.airportD = dA;
    if (dA < flatR + blendW) h = elev + (h - elev) * smoother((dA - flatR) / blendW);
    return h;
  };

  // ── Road profiles (smoothed pre-road terrain along each road) ────────────
  const tmp = newTerrainSample();
  const roadLines = L.roads.map((r) => r.points);
  const roadVals = L.roads.map((r) => {
    const raw = r.points.map((p) => preRoad(p.x, p.z, tmp));
    const n = raw.length;
    const out: number[][] = [];
    const W = 5;
    for (let i = 0; i < n; i++) {
      let a = 0;
      let c = 0;
      for (let j = Math.max(0, i - W); j <= Math.min(n - 1, i + W); j++, c++) a += raw[j];
      out.push([a / c, r.width / 2]);
    }
    return out;
  });
  let maxRoadHW = 0;
  for (const r of L.roads) maxRoadHW = Math.max(maxRoadHW, r.width / 2);
  const roadIdx = new PolylineIndex(roadLines, roadVals, 2, maxRoadHW + ROAD_SHOULDER + 2, 128, 8);

  const sample = (x: number, z: number, out: TerrainSample): TerrainSample => {
    let h = preRoad(x, z, out);
    // Roads
    out.roadD = Infinity;
    out.roadHalfWidth = 0;
    if (roadIdx.query(x, z, qr)) {
      const prof = qr.v[0];
      const hw = qr.v[1];
      const w = 1 - smooth(hw, hw + ROAD_SHOULDER, qr.d);
      h += (prof - h) * w;
      out.roadD = qr.d;
      out.roadHalfWidth = hw;
    }
    // River channel
    out.riverD = Infinity;
    out.riverLevel = NaN;
    out.riverHalfWidth = 0;
    if (channelIdx.query(x, z, qc)) {
      const lv = qc.v[0];
      const w = qc.v[1];
      const depth = qc.v[2];
      const d = qc.d;
      let target: number;
      if (d < w) {
        const u = d / w;
        target = lv - depth * (1 - u * u);
      } else if (d < w + BANK_W) target = lv + BANK_H * smooth(w, w + BANK_W, d);
      else target = lv + BANK_H + (d - w - BANK_W);
      if (target < h) h = target;
      out.riverD = d;
      out.riverLevel = lv;
      out.riverHalfWidth = w;
    }
    // The paved airfield is exactly at the field elevation.
    if (out.airportD <= flatR) h = elev;
    out.h = h;
    return out;
  };

  const scratch = newTerrainSample();
  const height = (x: number, z: number): number => sample(x, z, scratch).h;

  const E = 0.5;
  const normalInto = (x: number, z: number, out: Vec3): Vec3 => {
    const hx = height(x - E, z) - height(x + E, z);
    const hz = height(x, z - E) - height(x, z + E);
    const ny = 2 * E;
    const l = Math.sqrt(hx * hx + ny * ny + hz * hz);
    out.x = hx / l;
    out.y = ny / l;
    out.z = hz / l;
    return out;
  };

  const ws = newTerrainSample();
  const waterLevel = (x: number, z: number): number | null => {
    const s = sample(x, z, ws);
    if (s.lakeIndex >= 0 && s.lakeSd < 40) {
      const lv = lakes[s.lakeIndex].level;
      if (s.h < lv) return lv;
    }
    if (s.riverD < s.riverHalfWidth + BANK_W && s.h < s.riverLevel) return s.riverLevel;
    if (s.h < 0) return 0;
    return null;
  };

  const bs = newTerrainSample();
  const nearCarvedBank = (x: number, z: number): boolean => {
    const s = sample(x, z, bs);
    if (s.riverD < s.riverHalfWidth + BANK_W + 40) return true;
    if (s.lakeIndex >= 0 && Math.abs(s.lakeSd) < 40) return true;
    return false;
  };

  return {
    cfg,
    regional,
    layout: L,
    height,
    normal: (x, z) => normalInto(x, z, { x: 0, y: 1, z: 0 }),
    normalInto,
    sample,
    waterLevel,
    nearCarvedBank,
  };
}

let defaultHF: Heightfield | null = null;
/** The heightfield for the default CONFIG (built once, lazily; shares getLayout()'s data shape). */
export function getHeightfield(): Heightfield {
  if (!defaultHF) defaultHF = createHeightfield(CONFIG, getLayout());
  return defaultHF;
}

/** Terrain height (m MSL) at world x, z — the default world. */
export function terrainHeight(x: number, z: number): number {
  return (defaultHF ?? getHeightfield()).height(x, z);
}

/** Unit terrain normal at world x, z — the default world. */
export function terrainNormal(x: number, z: number): Vec3 {
  return (defaultHF ?? getHeightfield()).normal(x, z);
}
