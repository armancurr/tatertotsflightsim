/**
 * Deterministic grass-tuft placement. PURE (no three.js, no DOM) — runs in the
 * vegetation workers and in tests.
 *
 * The ground is divided into square grass cells (`cellSize`, 16 m) holding a
 * jittered `perSide²` lattice of tuft candidates on a GLOBAL lattice. The site
 * (landcover grass weight, ground height, road and water distance, airfield)
 * is sampled on a 5 × 5 grid per cell and interpolated — landcover is smooth
 * at that scale — while pavement (runway, taxiways, apron) is tested exactly
 * per tuft, so the grass runs right up to the runway edge and never onto it.
 *
 * Tufts on the airfield are mown short; meadows are longer, patchy, with
 * clustered wildflowers (white, yellow, purple). Each tuft carries a stratified
 * rank (Bayer 4×4 + hash) and the cell is sorted by it, so "draw a fraction k
 * of this cell" is a prefix. Packed `G_STRIDE` floats per tuft:
 *   x, y, z, height (m), code = kind + rotation/2π (fraction), tint, rank, lush.
 * kind: 0 grass, 1 white flowers, 2 yellow flowers, 3 purple flowers.
 */
import { hash2i, createSimplex2D, type Noise2D } from '../noise';
import { newSiteSample, type VegWorld } from '../vegetation/placement';

export const G_STRIDE = 8;
export const G_X = 0;
export const G_Y = 1;
export const G_Z = 2;
export const G_H = 3;
export const G_CODE = 4;
export const G_TINT = 5;
export const G_RANK = 6;
export const G_LUSH = 7;

export const GRASS_KIND_COUNT = 4;

export interface GrassParams {
  /** Cell size, m. */
  cellSize: number;
  /** Candidates per cell side. */
  perSide: number;
  /** Within this distance of the runway centre the grass is mown (the airfield), m. */
  mownRadius: number;
}

export interface GrassCell {
  cx: number;
  cz: number;
  count: number;
  /** count × G_STRIDE floats, sorted by rank. */
  data: Float32Array;
  minY: number;
  maxY: number;
}

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const RANK_BINS = 64;

const smooth = (e0: number, e1: number, x: number): number => {
  let t = (x - e0) / (e1 - e0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
};

const noiseCache = new Map<number, Noise2D>();
function noiseFor(seed: number): Noise2D {
  let n = noiseCache.get(seed);
  if (!n) {
    n = createSimplex2D((seed ^ 0x5bd1e995) >>> 0);
    if (noiseCache.size > 16) noiseCache.clear();
    noiseCache.set(seed, n);
  }
  return n;
}

const G = 5;
const gGrass = new Float64Array(G * G);
const gH = new Float64Array(G * G);
const gRoad = new Float64Array(G * G);
const gWater = new Float64Array(G * G);
const gAirport = new Float64Array(G * G);
const gField = new Float64Array(G * G);
const site = newSiteSample();
let tmp = new Float32Array(0);
let out = new Float32Array(0);
const bins = new Uint32Array(RANK_BINS + 1);

/** Clamp a value that may be ±Infinity so bilinear interpolation stays finite. */
const fin = (v: number, cap: number): number => (v > cap ? cap : v < -cap ? -cap : v !== v ? cap : v);

/** Every grass tuft of cell (cx, cz), sorted by rank. Pure and deterministic. */
export function generateGrassCell(cx: number, cz: number, world: VegWorld, seed: number, p: GrassParams): GrassCell {
  const C = p.cellSize;
  const n = p.perSide;
  const sp = C / n;
  const x0 = cx * C;
  const z0 = cz * C;
  const gs = C / (G - 1);
  const seedI = seed | 0;
  const noise = noiseFor(seedI);

  // 1. Site grid (5 × 5).
  let any = 0;
  for (let j = 0; j < G; j++)
    for (let i = 0; i < G; i++) {
      const x = x0 + i * gs;
      const z = z0 + j * gs;
      const k = j * G + i;
      if (world.site) {
        world.site(x, z, 1, 0, site);
        gGrass[k] = site.grass;
        gH[k] = site.height;
        gRoad[k] = fin(site.road, 1e4);
        gWater[k] = fin(site.water, 1e4);
        gAirport[k] = fin(site.airport, 1e6);
        gField[k] = site.field;
      } else {
        gGrass[k] = 1;
        gH[k] = world.heightAt(x, z);
        gRoad[k] = 1e4;
        gWater[k] = 1e4;
        gAirport[k] = 1e6;
        gField[k] = 0;
      }
      any += gGrass[k];
    }
  // The normal slope isn't needed for grass; fix up heights from the exact height function
  // (site() used a flat normal, which only affects slope-driven classes like rock).
  if (any < 0.02) return { cx, cz, count: 0, data: new Float32Array(0), minY: 0, maxY: 0 };

  if (tmp.length < n * n * G_STRIDE) tmp = new Float32Array(n * n * G_STRIDE);
  let count = 0;
  let minY = Infinity;
  let maxY = -Infinity;
  bins.fill(0);
  for (let j = 0; j < n; j++) {
    const gz = cz * n + j;
    for (let i = 0; i < n; i++) {
      const gx = cx * n + i;
      const hA = hash2i(gx, gz, seedI ^ 0x68e31da4);
      const hJx = hash2i(gx, gz, seedI ^ 0x1b56c4e9);
      const hJz = hash2i(gx, gz, seedI ^ 0x2a8f4b27);
      const x = (gx + 0.5 + (hJx - 0.5) * 0.95) * sp;
      const z = (gz + 0.5 + (hJz - 0.5) * 0.95) * sp;
      // bilinear site
      let u = (x - x0) / gs;
      let v = (z - z0) / gs;
      u = u < 0 ? 0 : u > G - 1.0001 ? G - 1.0001 : u;
      v = v < 0 ? 0 : v > G - 1.0001 ? G - 1.0001 : v;
      const iu = Math.floor(u);
      const iv = Math.floor(v);
      const fu = u - iu;
      const fv = v - iv;
      const k00 = iv * G + iu;
      const w00 = (1 - fu) * (1 - fv);
      const w10 = fu * (1 - fv);
      const w01 = (1 - fu) * fv;
      const w11 = fu * fv;
      const bil = (a: Float64Array): number => a[k00] * w00 + a[k00 + 1] * w10 + a[k00 + G] * w01 + a[k00 + G + 1] * w11;
      const grass = bil(gGrass);
      if (!(grass > 0.03)) continue;
      const road = bil(gRoad);
      if (road < 0.4) continue;
      const water = bil(gWater);
      if (water < 0.6) continue;
      if (world.paved && world.paved(x, z)) continue;
      const airport = bil(gAirport);
      const mown = airport < p.mownRadius;
      // patchy meadows: clumps and thin spots; the mown airfield is even
      const patch = 0.5 + 0.5 * noise(x / 9, z / 9);
      const lushN = 0.5 + 0.5 * noise(x / 60 + 40, z / 60);
      let pAcc = grass * (mown ? 0.95 : 0.35 + 0.75 * patch) * smooth(0.4, 2.5, road) * smooth(0.6, 2, water);
      if (bil(gField) > 0.5) pAcc *= 0.35; // field margins only
      if (!(hA < pAcc)) continue;
      const y = bil(gH);
      if (!Number.isFinite(y)) continue;
      const hS = hash2i(gx, gz, seedI ^ 0x7c3b9a51);
      const hR = hash2i(gx, gz, seedI ^ 0x0e8d2f13);
      const hT = hash2i(gx, gz, seedI ^ 0x3f84d5b5);
      const hRank = hash2i(gx, gz, seedI ^ 0x4c957f2d);
      const hK = hash2i(gx, gz, seedI ^ 0x5a4b3c2d);
      let h: number;
      let kind = 0;
      if (mown) h = 0.09 + 0.08 * hS;
      else {
        h = (0.22 + 0.34 * hS) * (0.7 + 0.5 * patch) * (water < 12 ? 1.35 : 1);
        // wildflowers in clustered patches of meadow
        const fl = noise(x / 14 + 300, z / 14);
        const flowerP = 0.1 * smooth(0.25, 0.7, fl) * (1 - smooth(0.4, 0.8, bil(gField)));
        if (hK < flowerP) {
          const which = 0.5 + 0.5 * noise(x / 40 + 900, z / 40);
          kind = which < 0.38 ? 1 : which < 0.72 ? 2 : 3;
        }
      }
      const o = count * G_STRIDE;
      tmp[o + G_X] = x;
      tmp[o + G_Y] = y;
      tmp[o + G_Z] = z;
      tmp[o + G_H] = h;
      tmp[o + G_CODE] = kind + hR * 0.999;
      tmp[o + G_TINT] = hT;
      const rank = (BAYER4[((gz & 3) << 2) | (gx & 3)] + hRank * 0.999) / 16;
      tmp[o + G_RANK] = rank;
      tmp[o + G_LUSH] = mown ? 1 : lushN;
      bins[Math.min(RANK_BINS - 1, Math.floor(rank * RANK_BINS)) + 1]++;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      count++;
    }
  }
  // counting sort by rank
  for (let b = 1; b <= RANK_BINS; b++) bins[b] += bins[b - 1];
  if (out.length < count * G_STRIDE) out = new Float32Array(Math.max(count * G_STRIDE, out.length * 2));
  for (let t = 0; t < count; t++) {
    const o = t * G_STRIDE;
    const b = Math.min(RANK_BINS - 1, Math.floor(tmp[o + G_RANK] * RANK_BINS));
    const w = bins[b]++ * G_STRIDE;
    for (let q = 0; q < G_STRIDE; q++) out[w + q] = tmp[o + q];
  }
  if (count === 0) {
    minY = 0;
    maxY = 0;
  }
  return { cx, cz, count, data: out.slice(0, count * G_STRIDE), minY, maxY };
}
