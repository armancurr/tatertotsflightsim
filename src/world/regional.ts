/**
 * Regional terrain: the big shapes of the world before any local carving —
 * the coastline (sea to the south, with a bay), the sea floor, islands, the
 * rolling farmland plains, the foothills and the main mountain range to the
 * north. PURE and deterministic from config + seed. The heightfield
 * (heightfield.ts) adds rivers, lakes, the airport plateau and roads on top.
 *
 * Frame: +X east, +Z south (north = -Z), metres.
 */
import { CONFIG, type Config } from '../config';
import { createSimplex2D, fbm, slopeLimitedFbm, type Noise2D } from './noise';

export interface Island {
  name: string;
  x: number;
  z: number;
  /** Approximate shore radius, m. */
  radius: number;
  /** Peak height above sea level, m. */
  height: number;
}

/** Components of a regional sample (written by `sample`, no allocation). */
export interface RegionalSample {
  /** Total regional height, m MSL. */
  h: number;
  /** Signed "distance" inland from the coastline, m (+ land, − sea). */
  coast: number;
  /** Plains/coast/sea part of the height (no hills or mountains). */
  plains: number;
  /** Foothill contribution, m. */
  foot: number;
  /** Main-range contribution, m. */
  range: number;
  /** 0..1 foothill mask. */
  footMask: number;
  /** 0..1 main-range mask. */
  rangeMask: number;
}

export interface Regional {
  /** z of the coastline (m) at a given x; land is north (z smaller). */
  coastZ(x: number): number;
  /** Bay centre x/z and half-width, for the layout. */
  bay: { x: number; z: number; width: number };
  islands: Island[];
  /** Fills `out` with the regional height and its components. */
  sample(x: number, z: number, out: RegionalSample): RegionalSample;
  /** Regional height only. */
  height(x: number, z: number): number;
}

export function newRegionalSample(): RegionalSample {
  return { h: 0, coast: 0, plains: 0, foot: 0, range: 0, footMask: 0, rangeMask: 0 };
}

const smooth = (e0: number, e1: number, x: number): number => {
  let t = (x - e0) / (e1 - e0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
};

/**
 * Tabulates a smooth 1D function over ±131 km at 8 m spacing (linear interpolation,
 * error ≪ 1 mm for the multi-km wavelengths used here); falls back to the function beyond.
 */
function lut1d(f: (x: number) => number): (x: number) => number {
  const STEP = 8;
  const HALF = 131072;
  const N = (2 * HALF) / STEP + 1;
  const t = new Float64Array(N);
  for (let i = 0; i < N; i++) t[i] = f(i * STEP - HALF);
  return (x: number): number => {
    const u = (x + HALF) / STEP;
    if (u < 0 || u >= N - 1) return f(x);
    const i = Math.floor(u);
    const a = u - i;
    return t[i] + (t[i + 1] - t[i]) * a;
  };
}

/** Smooth max(v, 0) with blend width k (keeps valleys from creasing at zero). */
const smaxPos = (v: number, k: number): number => {
  const h = Math.max(k - Math.abs(v), 0) / k;
  return Math.max(v, 0) + h * h * k * 0.25;
};

/** Polynomial smooth maximum (k = blend width). */
const smax = (a: number, b: number, k: number): number => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + h * h * k * 0.25;
};

// Coast design (m)
const COAST_BASE_Z = 7700;
const COAST_WANDER = 1300;
const BAY_X = 3300;
const BAY_DEPTH = 1900;
const BAY_W = 2100;

export function createRegional(cfg: Config = CONFIG): Regional {
  const seed = cfg.world.seed | 0;
  const mountainHeight = cfg.world.terrain.mountainHeight;
  const nCoast: Noise2D = createSimplex2D(seed + 11);
  const nCoast2 = createSimplex2D(seed + 12);
  const nRoll = createSimplex2D(seed + 21);
  const nHill = createSimplex2D(seed + 22);
  const nFront = createSimplex2D(seed + 31);
  const nMtn = createSimplex2D(seed + 32);
  const nWarp = createSimplex2D(seed + 33);
  const nMassif = createSimplex2D(seed + 34);
  const nFoot = createSimplex2D(seed + 35);
  const nSea = createSimplex2D(seed + 41);
  const nFar = createSimplex2D(seed + 51);
  const nUpland = createSimplex2D(seed + 52);

  const coastZDirect = (x: number): number =>
    COAST_BASE_Z + COAST_WANDER * fbm(nCoast, x / 21000, 0.37, 3) - BAY_DEPTH * Math.exp(-(((x - BAY_X) / BAY_W) ** 2));
  const frontDirect = (x: number): number => 11500 + 2600 * fbm(nFront, x / 15000, 3.3, 2);
  // Both are smooth 1D functions of x (shortest wavelength several km): tabulate them.
  const coastZ = lut1d(coastZDirect);
  const frontN = lut1d(frontDirect);

  // Islands, placed relative to the actual coastline so they are always offshore.
  const islandDefs = [
    { name: 'Gull Island', x: -1800, off: 4300, radius: 950, height: 150 },
    { name: 'Seal Rock', x: 7800, off: 2900, radius: 420, height: 48 },
    { name: 'Long Key', x: -13500, off: 3800, radius: 1250, height: 90 },
  ];
  const islands: Island[] = islandDefs.map((d) => ({ name: d.name, x: d.x, z: coastZ(d.x) + d.off, radius: d.radius, height: d.height }));
  const isX = new Float64Array(islands.map((i) => i.x));
  const isZ = new Float64Array(islands.map((i) => i.z));
  const isR = new Float64Array(islands.map((i) => i.radius));
  const isH = new Float64Array(islands.map((i) => i.height));
  const NI = islands.length;

  // Deep inland (north of this northing) the coast field is always > COAST_SATURATE, where
  // every function of it has saturated, so it need not be computed.
  const COAST_SATURATE = 16100;
  const DEEP_INLAND_N = 12500;

  const sample = (x: number, z: number, out: RegionalSample): RegionalSample => {
    const n = -z; // northing
    // ── Coast: signed inland distance ────────────────────────────────────────
    let c: number;
    let islandLift = 0;
    if (n > DEEP_INLAND_N) {
      c = 1e5;
    } else {
      c = coastZ(x) - z + 260 * fbm(nCoast2, x / 2300, z / 2300, 3);
      for (let i = 0; i < NI; i++) {
        const dx = x - isX[i];
        const dz = z - isZ[i];
        const r = isR[i];
        // The island field (≤ 1.28 r − d) only matters where it can beat the mainland field by
        // less than the smooth-max width; beyond that smax() returns c exactly, so skipping is seamless.
        const reach = 1.28 * r + 250 - c;
        if (reach <= 0 || dx * dx + dz * dz >= reach * reach) continue;
        const d = Math.sqrt(dx * dx + dz * dz);
        const ci = r * (1 + 0.28 * fbm(nSea, x / 900 + i * 7.1, z / 900, 2)) - d;
        c = smax(c, ci, 250);
        if (ci > 0) {
          const t = smooth(0, r * 0.85, ci);
          islandLift += isH[i] * Math.pow(t, 1.3) * (0.75 + 0.25 * fbm(nHill, x / 400, z / 400, 2));
        }
      }
    }

    // ── Mountain masks ───────────────────────────────────────────────────────
    let footMask = 0;
    let rangeMask = 0;
    const front = frontN(x);
    if (n > front - 6500 && c > 0) {
      const landFade = smooth(0, 3000, c);
      footMask = smooth(front - 6500, front - 1500, n) * landFade;
      rangeMask = smooth(front - 2000, front + 5500, n) * landFade;
    }

    // ── Sea floor / beach / plains ──────────────────────────────────────────
    let plains: number;
    if (c <= 0) {
      const o = -c;
      const depth = 2.8 * (1 - Math.exp(-o / 230)) + 30 * (1 - Math.exp(-o / 2600)) + 95 * (1 - Math.exp(-o / 14000));
      const bumps = (2.2 * fbm(nSea, x / 600, z / 600, 2) + 12 * nSea(x / 9000, z / 9000)) * smooth(0, 1500, o);
      plains = -depth + bumps * (depth / 128);
    } else {
      const beach = 2.6 * smooth(0, 140, c);
      const tr = Math.min(1, Math.max(0, (c - 100) / (COAST_SATURATE - 100)));
      const rise = 36 * (1 - (1 - tr) * (1 - tr) * (1 - tr));
      // Gentle northward rise toward the foothills.
      const riseN = 45 * smooth(1500, 9000, n);
      plains = beach + (rise + riseN) * smooth(0, 300, c);
      const flatFade = 1 - rangeMask; // plains detail fades out inside the main range
      if (flatFade > 0) {
        const inland = smooth(150, 1600, c);
        const rolling = 9.5 * fbm(nRoll, x / 2900, z / 2900, 3) * inland;
        const small = 1.2 * nHill(x / 300, z / 300) * smooth(60, 400, c);
        // Scattered hill country far from the airport (keeps the plains from being a table top).
        const dA = Math.sqrt(x * x + z * z);
        const hm0 = smooth(5000, 12000, dA) * smooth(2000, 7000, c);
        const hillMask = hm0 > 0 ? hm0 * smooth(0.3, 0.75, fbm(nUpland, x / 26000, z / 26000, 2) * 0.5 + 0.5) : 0;
        const hills = hillMask > 0 ? hillMask * smaxPos(95 + slopeLimitedFbm(nUpland, x, z, 95, 3300, 6, 0.5, 0.3), 40) : 0;
        plains += flatFade * (rolling * smooth(0, 300, c) + small + hills * inland);
      }
    }
    plains += islandLift;

    // ── Foothills and the main range ─────────────────────────────────────────
    let foot = 0;
    let range = 0;
    if (footMask > 0) {
      const fw = footMask * (1 - rangeMask);
      if (fw > 0) {
        const f = 170 + slopeLimitedFbm(nFoot, x, z, 210, 4300, 6, 0.5, 0.42);
        foot = fw * smaxPos(f, 60);
      }
    }
    if (rangeMask > 0) {
      // Far north: the range continues but its height wanders, so the world never ends abruptly.
      const farAmp = n > 30000 ? 1 - 0.45 * smooth(30000, 45000, n) * (0.5 + 0.5 * fbm(nFar, x / 30000, z / 30000, 2)) : 1;
      // Domain-warped, slope-limited fBm: eroded-looking ridges and valleys, no cliffs.
      const wx = x + 1000 * nWarp(x / 11000, z / 11000);
      const wz = z + 1000 * nWarp(x / 11000 + 13.7, z / 11000 - 4.1);
      const massif = 0.72 + 0.28 * fbm(nMassif, x / 17000, z / 17000, 2);
      // two ridged octaves: arêtes and pointed peaks; the rest eroded detail
      const m = massif * (1400 + slopeLimitedFbm(nMtn, wx, wz, 1000, 11000, 8, 0.5, 0.65, 2, 0.08));
      range = rangeMask * farAmp * smaxPos(m, 150) * (mountainHeight / 2500);
    }

    out.h = plains + foot + range;
    out.coast = c;
    out.plains = plains;
    out.foot = foot;
    out.range = range;
    out.footMask = footMask;
    out.rangeMask = rangeMask;
    return out;
  };

  const tmp = newRegionalSample();
  return {
    coastZ,
    bay: { x: BAY_X, z: coastZ(BAY_X), width: BAY_W },
    islands,
    sample,
    height: (x, z) => sample(x, z, tmp).h,
  };
}
