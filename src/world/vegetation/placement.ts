/**
 * Deterministic tree placement. PURE (no three.js, no DOM): the renderer, the
 * physics obstacle hash and the tests all call the same `treesInCell`, so the
 * trees you see are exactly the trees you hit.
 *
 * The world is divided into square placement cells (`cellSize`, 64 m). Each
 * cell holds a `gridPerCell²` jittered lattice of candidate points indexed on a
 * GLOBAL lattice (so the result never depends on how cells are grouped into
 * chunks). A candidate becomes a tree with a probability derived from
 * `densityAt` (0..1 landcover tree density) shaped by:
 *   - clustering noise (clumps and small clearings inside woods),
 *   - a quadratic falloff at low density (sparse lone trees in open land),
 *   - hedgerows: noise-warped field boundaries in open land get rows of bushes,
 *     broadleaves and the odd line of poplars,
 *   - forest edges: smaller trees and more bushes where the density fades.
 * Species (spruce/fir conifer, broadleaf, poplar, bush) follow large "stand"
 * regions plus altitude (more conifers higher up).
 *
 * Output is packed (`TREE_STRIDE` floats per tree) to keep streaming GC-free:
 *   x, y (ground height at the trunk), z, height, crown radius, species,
 *   rotation (rad), tint (0..1), rank (0..1, stratified: far LODs keep rank < k).
 * Frame: +X east, +Y up, +Z south (metres, MSL).
 */
import { CONFIG } from '../../config';
import { createSimplex2D, hash2i, type Noise2D } from '../noise';

export type HeightFn = (x: number, z: number) => number;
export type DensityFn = (x: number, z: number) => number;

export const CONIFER = 0;
export const DECIDUOUS = 1;
export const POPLAR = 2;
export const BUSH = 3;
export const SPECIES_COUNT = 4;
export const SPECIES_NAMES = ['conifer', 'deciduous', 'poplar', 'bush'] as const;

/** Packed tree record layout. */
export const TREE_STRIDE = 9;
export const T_X = 0;
export const T_Y = 1;
export const T_Z = 2;
export const T_H = 3;
export const T_R = 4;
export const T_SPECIES = 5;
export const T_ROT = 6;
export const T_TINT = 7;
export const T_RANK = 8;

/** Upper bounds used by the obstacle hash and bounding volumes. */
export const MAX_CROWN_RADIUS = 12;
export const MAX_TREE_HEIGHT = 32;

export interface TreeCell {
  cx: number;
  cz: number;
  count: number;
  /** count × TREE_STRIDE packed floats. */
  data: Float32Array;
}

export interface PlacementParams {
  cellSize: number;
  gridPerCell: number;
  /** Global multiplier on the density (config treeDensity). */
  densityScale: number;
}

export function placementParams(v = CONFIG.world.vegetation): PlacementParams {
  return { cellSize: v.cellSize, gridPerCell: v.gridPerCell, densityScale: v.treeDensity };
}

const DEFAULT_PARAMS = placementParams();

// ─── canopy envelopes (shared with the meshes: see species.ts) ────────────────

/**
 * Normalised canopy top (fraction of the tree height) at normalised distance
 * `rho` = horizontal distance / crown radius from the trunk; −Infinity outside
 * the crown. The species meshes are built inside these envelopes.
 */
export function canopyProfile(species: number, rho: number): number {
  if (!(rho <= 1)) return -Infinity;
  const r = rho < 0 ? 0 : rho;
  switch (species) {
    case CONIFER:
      return 1 - 0.9 * r;
    case DECIDUOUS:
      return ENVELOPE[DECIDUOUS].center + ENVELOPE[DECIDUOUS].half * Math.sqrt(1 - r * r);
    case POPLAR:
      return ENVELOPE[POPLAR].center + ENVELOPE[POPLAR].half * Math.sqrt(1 - r * r);
    default:
      return ENVELOPE[BUSH].center + ENVELOPE[BUSH].half * Math.sqrt(1 - r * r);
  }
}

/**
 * Crown envelopes in normalised tree space (height 1, crown radius 1):
 * ellipsoid centre height and half-height (conifer: cone, apex 1, rim 0.1).
 */
export const ENVELOPE = [
  { center: 0.1, half: 0.9 },
  { center: 0.62, half: 0.38 },
  { center: 0.55, half: 0.45 },
  { center: 0.3, half: 0.7 },
] as const;

/** MSL canopy top of tree `i` of a packed array at (x, z), or −Infinity. */
export function canopyTopOf(data: Float32Array, i: number, x: number, z: number): number {
  const o = i * TREE_STRIDE;
  const dx = x - data[o + T_X];
  const dz = z - data[o + T_Z];
  const r = data[o + T_R];
  const d2 = dx * dx + dz * dz;
  if (d2 > r * r) return -Infinity;
  return data[o + T_Y] + data[o + T_H] * canopyProfile(data[o + T_SPECIES], Math.sqrt(d2) / r);
}

// ─── noise fields per seed ───────────────────────────────────────────────────

interface Fields {
  cluster: Noise2D;
  stand: Noise2D;
  warp: Noise2D;
  angle: number;
}
const fieldCache = new Map<number, Fields>();
function fieldsFor(seed: number): Fields {
  let f = fieldCache.get(seed);
  if (!f) {
    f = {
      cluster: createSimplex2D((seed ^ 0x7f4a7c15) >>> 0),
      stand: createSimplex2D((seed ^ 0x2545f491) >>> 0),
      warp: createSimplex2D((seed ^ 0x61c88647) >>> 0),
      angle: hash2i(seed, 991, 17) * (Math.PI / 2),
    };
    if (fieldCache.size > 32) fieldCache.clear();
    fieldCache.set(seed, f);
  }
  return f;
}

// ─── hedgerows / field boundaries ────────────────────────────────────────────

export interface HedgeSample {
  /** Id of the field (patch of farmland) containing the point. */
  fieldId: number;
  /** Distance to the nearest field boundary, m (approximate: warped frame). */
  dist: number;
  /** Inside a hedgerow band (a boundary that has a hedge). */
  onHedge: boolean;
  /** A row of poplars rather than a mixed hedge. */
  poplarRow: boolean;
  /** Offset (world x, z) that moves the point onto the hedge line. */
  snapX: number;
  snapZ: number;
}

export function newHedgeSample(): HedgeSample {
  return { fieldId: 0, dist: 0, onHedge: false, poplarRow: false, snapX: 0, snapZ: 0 };
}

const FIELD_U = 240;
const FIELD_V = 170;
const HEDGE_HALF_WIDTH = 3.4;

/**
 * Farmland field pattern: a slowly rotating, noise-warped brick grid of fields
 * (~240 × 170 m). About half of the boundaries carry a hedgerow.
 */
export function hedgeQuery(x: number, z: number, seed: number, out: HedgeSample): HedgeSample {
  const f = fieldsFor(seed);
  const th = f.angle + 0.35 * f.warp(x / 9000, z / 9000);
  const c = Math.cos(th);
  const s = Math.sin(th);
  const wx = x + 45 * f.warp(x / 700 + 5.3, z / 700);
  const wz = z + 45 * f.warp(x / 700, z / 700 + 9.1);
  const u = wx * c + wz * s;
  const v = -wx * s + wz * c;
  const jv = Math.floor(v / FIELD_V);
  const uo = u + hash2i(jv, 3, seed) * FIELD_U;
  const iu = Math.floor(uo / FIELD_U);
  const fu = uo / FIELD_U - iu;
  const fv = v / FIELD_V - jv;
  const du = Math.min(fu, 1 - fu) * FIELD_U;
  const dv = Math.min(fv, 1 - fv) * FIELD_V;
  out.fieldId = (Math.imul(iu, 73856093) ^ Math.imul(jv, 19349663)) >>> 0;
  out.onHedge = false;
  out.poplarRow = false;
  out.snapX = 0;
  out.snapZ = 0;
  if (du <= dv) {
    out.dist = du;
    const bu = fu < 0.5 ? iu : iu + 1; // boundary index along u
    const h = hash2i(bu, jv, seed ^ 0x4ed);
    if (du < HEDGE_HALF_WIDTH && h < 0.55) {
      out.onHedge = true;
      out.poplarRow = h < 0.07;
      const delta = (fu < 0.5 ? -fu : 1 - fu) * FIELD_U; // move along +u by delta to reach the line
      out.snapX = delta * c;
      out.snapZ = delta * s;
    }
  } else {
    out.dist = dv;
    const bv = fv < 0.5 ? jv : jv + 1;
    const h = hash2i(iu, bv, seed ^ 0x9e1);
    if (dv < HEDGE_HALF_WIDTH && h < 0.5) {
      out.onHedge = true;
      out.poplarRow = h < 0.06;
      const delta = (fv < 0.5 ? -fv : 1 - fv) * FIELD_V; // along +v
      out.snapX = -delta * s;
      out.snapZ = delta * c;
    }
  }
  return out;
}

// ─── placement ───────────────────────────────────────────────────────────────

const smooth = (e0: number, e1: number, x: number): number => {
  let t = (x - e0) / (e1 - e0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
};

/** 4×4 Bayer matrix: stratifies `rank` so thinning keeps an even spread. */
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

const scratch = { buf: new Float32Array(0) };
const hedge = newHedgeSample();

/**
 * All trees of placement cell (cx, cz): the square [cx·C, (cx+1)·C) × [cz·C, (cz+1)·C).
 * Pure and deterministic: same inputs → same trees.
 */
export function treesInCell(
  cx: number,
  cz: number,
  densityAt: DensityFn,
  heightAt: HeightFn,
  seed: number = CONFIG.world.seed,
  params: PlacementParams = DEFAULT_PARAMS,
): TreeCell {
  const n = params.gridPerCell;
  const sp = params.cellSize / n;
  const f = fieldsFor(seed | 0);
  const seedI = seed | 0;
  const cap = n * n * TREE_STRIDE;
  if (scratch.buf.length < cap) scratch.buf = new Float32Array(cap);
  const buf = scratch.buf;
  let count = 0;

  for (let j = 0; j < n; j++) {
    const gz = cz * n + j;
    for (let i = 0; i < n; i++) {
      const gx = cx * n + i;
      const hAccept = hash2i(gx, gz, seedI);
      const hJx = hash2i(gx, gz, seedI ^ 0x1f3d5b79);
      const hJz = hash2i(gx, gz, seedI ^ 0x2c1b3c6d);
      const lx0 = gx * sp;
      const lz0 = gz * sp;
      let x = lx0 + (0.5 + (hJx - 0.5) * 0.9) * sp;
      let z = lz0 + (0.5 + (hJz - 0.5) * 0.9) * sp;

      // Hedgerows pull candidates onto the field boundary (kept inside the lattice cell).
      hedgeQuery(x, z, seedI, hedge);
      const onHedge = hedge.onHedge;
      if (onHedge) {
        x += hedge.snapX * 0.75;
        z += hedge.snapZ * 0.75;
        const eps = sp * 0.02;
        x = x < lx0 + eps ? lx0 + eps : x > lx0 + sp - eps ? lx0 + sp - eps : x;
        z = z < lz0 + eps ? lz0 + eps : z > lz0 + sp - eps ? lz0 + sp - eps : z;
      }

      let d = densityAt(x, z) * params.densityScale;
      if (!(d > 0)) continue; // 0, negative and NaN → never a tree
      if (d > 1) d = 1;

      const cl = 0.65 * f.cluster(x / 70, z / 70) + 0.35 * f.cluster(x / 23 + 100, z / 23);
      let p: number;
      const woodland = d >= 0.3;
      if (woodland) {
        p = d * (0.92 + 0.38 * cl);
        if (cl < -0.55) p *= smooth(-0.8, -0.55, cl); // small clearings
      } else {
        p = ((d * d) / 0.3) * (0.9 + 0.3 * cl);
      }
      const hedgeRow = onHedge && d < 0.5;
      if (hedgeRow) p = Math.max(p, 0.8);
      if (!(hAccept < p)) continue;

      const hS = hash2i(gx, gz, seedI ^ 0x3b9ac9e1);
      const hSize = hash2i(gx, gz, seedI ^ 0x51f15e5d);
      const hR = hash2i(gx, gz, seedI ^ 0x6a09e667);
      const hRot = hash2i(gx, gz, seedI ^ 0x0bb67ae8);
      const hTint = hash2i(gx, gz, seedI ^ 0x3c6ef372);
      const hRank = hash2i(gx, gz, seedI ^ 0x0a54ff53);
      const y = heightAt(x, z);
      if (!Number.isFinite(y)) continue; // no ground here (bad input) → no tree

      let species: number;
      let edge = 0;
      if (hedgeRow) {
        species = hedge.poplarRow ? (hS < 0.9 ? POPLAR : DECIDUOUS) : hS < 0.45 ? BUSH : hS < 0.93 ? DECIDUOUS : CONIFER;
      } else if (woodland) {
        edge = 1 - smooth(0.3, 0.75, d);
        const pBush = 0.04 + 0.3 * edge;
        const pPoplar = 0.02;
        const stand = 0.7 * f.stand(x / 2600, z / 2600) + 0.3 * f.stand(x / 420 + 31, z / 420);
        let coniferShare = 0.45 + 0.9 * stand + (y - 140) / 500;
        coniferShare = coniferShare < 0.03 ? 0.03 : coniferShare > 0.97 ? 0.97 : coniferShare;
        if (hS < pBush) species = BUSH;
        else if (hS < pBush + pPoplar) species = POPLAR;
        else species = (hS - pBush - pPoplar) / (1 - pBush - pPoplar) < coniferShare ? CONIFER : DECIDUOUS;
      } else {
        species = hS < 0.1 ? BUSH : hS < 0.2 ? POPLAR : hS < 0.32 ? CONIFER : DECIDUOUS;
      }

      let h: number;
      let r: number;
      switch (species) {
        case CONIFER:
          h = 13 + 14 * Math.pow(hSize, 0.8);
          r = h * (0.19 + 0.06 * hR);
          break;
        case DECIDUOUS:
          h = 9 + 10 * hSize;
          r = h * (0.36 + 0.14 * hR);
          if (!woodland && !hedgeRow) {
            h *= 1.12; // open-grown: broad and full
            r *= 1.18;
          }
          break;
        case POPLAR:
          h = 16 + 10 * hSize;
          r = h * (0.12 + 0.05 * hR);
          break;
        default:
          h = 1.6 + 2.8 * hSize;
          r = h * (0.75 + 0.35 * hR);
          break;
      }
      if (edge > 0 && species !== BUSH) {
        const k = 1 - 0.3 * edge;
        h *= k;
        r *= 0.5 + 0.5 * k;
      }
      if (r > MAX_CROWN_RADIUS) r = MAX_CROWN_RADIUS;
      if (h > MAX_TREE_HEIGHT) h = MAX_TREE_HEIGHT;

      const o = count * TREE_STRIDE;
      buf[o + T_X] = x;
      buf[o + T_Y] = y;
      buf[o + T_Z] = z;
      buf[o + T_H] = h;
      buf[o + T_R] = r;
      buf[o + T_SPECIES] = species;
      buf[o + T_ROT] = hRot * Math.PI * 2;
      buf[o + T_TINT] = hTint;
      buf[o + T_RANK] = (BAYER4[((gz & 3) << 2) | (gx & 3)] + hRank * 0.999) / 16;
      count++;
    }
  }
  return { cx, cz, count, data: buf.slice(0, count * TREE_STRIDE) };
}
