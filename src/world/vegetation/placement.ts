/**
 * Deterministic tree placement. PURE (no three.js, no DOM): the renderer (in a
 * Web Worker), the physics obstacle hash and the tests all call the same
 * `treesInCell`, so the trees you see are exactly the trees you hit.
 *
 * The world is divided into square placement cells (`cellSize`, 64 m). Each
 * cell holds a `gridPerCell²` jittered lattice of candidate points indexed on a
 * GLOBAL lattice (so the result never depends on how cells are grouped into
 * chunks). A candidate becomes a tree with a probability derived from the
 * landcover tree density (0..1), shaped by:
 *   - clustering noise (clumps and small clearings inside woods),
 *   - a quadratic falloff at low density (sparse lone trees in open land),
 *   - hedgerows: candidates near a 'hedge' margin of the farm-field model
 *     (fields.ts — the same fields the terrain shader paints) snap onto it,
 *   - orchards: some field woodlots are planted as neat rows of fruit trees
 *     along the field's tractor rows,
 *   - forest edges: smaller trees, birches and shrubs where the density fades,
 *   - riparian stands (willows, poplars, alders) along rivers and lake shores,
 *   - the alpine tree line (spruce, shrinking with altitude), sparse trees on
 *     steep slopes.
 *
 * Every candidate carries a stratified `rank` (Bayer 4×4 + hash, 0..1); far
 * LODs keep rank < k. `rankMax` lets a caller evaluate only the candidates it
 * will draw (far chunks skip ~85 % of the work) — the survivors are identical.
 *
 * Output is packed (`TREE_STRIDE` floats per tree) to keep streaming GC-free:
 *   x, y (ground height at the trunk), z, height, crown radius, species,
 *   rotation (rad), tint (0..1), rank (0..1).
 * Frame: +X east, +Y up, +Z south (metres, MSL).
 */
import { CONFIG } from '../../config';
import { createSimplex2D, hash2i, type Noise2D } from '../noise';
import { fieldAt, newFieldInfo, pcgHash } from '../fields';

export type HeightFn = (x: number, z: number) => number;
export type DensityFn = (x: number, z: number) => number;

// ─── species ─────────────────────────────────────────────────────────────────

export const SPRUCE = 0;
export const PINE = 1;
export const BROADLEAF = 2;
export const BIRCH = 3;
export const POPLAR = 4;
export const WILLOW = 5;
export const BUSH = 6;
export const SPECIES_COUNT = 7;
export const SPECIES_NAMES = ['spruce', 'pine', 'broadleaf', 'birch', 'poplar', 'willow', 'bush'] as const;
/** Legacy aliases (wave 2). */
export const CONIFER = SPRUCE;
export const DECIDUOUS = BROADLEAF;

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

// ─── the world as the placement sees it ─────────────────────────────────────

/** Everything placement wants to know about a site (filled by `VegWorld.site`). */
export interface SiteSample {
  /** 0..1 landcover tree density (0 = no trees: water, roads, pavement, fields, town cores…). */
  density: number;
  /** Ground height, m MSL. */
  height: number;
  /** Distance to open water (river bank, lake shore, sea), m; Infinity when unknown/far. */
  water: number;
  /** 0..1 landcover weights. */
  field: number;
  urban: number;
  grass: number;
  forest: number;
  /** Distance to the nearest road edge, m (Infinity when far/unknown). */
  road: number;
  /** Distance to the runway centre, m (Infinity when unknown). */
  airport: number;
}

export function newSiteSample(): SiteSample {
  return { density: 0, height: 0, water: Infinity, field: 0, urban: 0, grass: 0, forest: 0, road: Infinity, airport: Infinity };
}

/**
 * Placement's view of the world. `site` (optional) returns the full sample in
 * one go given the terrain normal's y and z components (placement derives the
 * normal from a coarse per-cell height grid, far cheaper than per candidate).
 */
export interface VegWorld {
  heightAt: HeightFn;
  densityAt: DensityFn;
  site?(x: number, z: number, normalY: number, normalZ: number, out: SiteSample): SiteSample;
  /** Optional: true on runway/taxiway/apron pavement (grass exclusion). */
  paved?(x: number, z: number): boolean;
}

// ─── canopy envelopes (shared with the meshes: see species.ts) ────────────────

/**
 * Crown envelopes in normalised tree space (height 1, crown radius 1):
 * ellipsoid centre height and half-height (spruce: cone, apex 1, rim 0.1).
 */
export const ENVELOPE = [
  { center: 0.1, half: 0.9 }, // spruce (cone)
  { center: 0.74, half: 0.26 }, // pine: bare trunk, crown on top
  { center: 0.6, half: 0.4 }, // broadleaf
  { center: 0.6, half: 0.4 }, // birch
  { center: 0.55, half: 0.45 }, // poplar
  { center: 0.5, half: 0.5 }, // willow (weeping dome)
  { center: 0.3, half: 0.7 }, // bush
] as const;

/**
 * Normalised canopy top (fraction of the tree height) at normalised distance
 * `rho` = horizontal distance / crown radius from the trunk; −Infinity outside
 * the crown. The species meshes are built inside these envelopes.
 */
export function canopyProfile(species: number, rho: number): number {
  if (!(rho <= 1)) return -Infinity;
  const r = rho < 0 ? 0 : rho;
  if (species === SPRUCE) return 1 - 0.9 * r;
  const e = ENVELOPE[species] ?? ENVELOPE[BUSH];
  return e.center + e.half * Math.sqrt(1 - r * r);
}

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
}
const fieldCache = new Map<number, Fields>();
function fieldsFor(seed: number): Fields {
  let f = fieldCache.get(seed);
  if (!f) {
    f = {
      cluster: createSimplex2D((seed ^ 0x7f4a7c15) >>> 0),
      stand: createSimplex2D((seed ^ 0x2545f491) >>> 0),
      warp: createSimplex2D((seed ^ 0x61c88647) >>> 0),
    };
    if (fieldCache.size > 32) fieldCache.clear();
    fieldCache.set(seed, f);
  }
  return f;
}

// ─── hedgerows / field boundaries (the farm-field model of fields.ts) ───────

export interface HedgeSample {
  /** Id of the field (patch of farmland) containing the point. */
  fieldId: number;
  /** Distance to the nearest block boundary, m. */
  dist: number;
  /** Inside a hedgerow band (a block edge that carries a hedge). */
  onHedge: boolean;
  /** A row of poplars rather than a mixed hedge. */
  poplarRow: boolean;
  /** Offset (world x, z) that moves the point onto the hedge line (~1.2 m inside the block). */
  snapX: number;
  snapZ: number;
}

export function newHedgeSample(): HedgeSample {
  return { fieldId: 0, dist: 0, onHedge: false, poplarRow: false, snapX: 0, snapZ: 0 };
}

/** Half-width of the band around a hedge margin whose candidates are pulled onto it, m. */
const HEDGE_BAND = 6.5;
/** Where the hedge line runs: this far inside the block edge (the terrain paints ~2.5 m). */
const HEDGE_INSET = 1.2;
const fiH = newFieldInfo();

/**
 * Hedgerows follow the 'hedge' margins of the shared field model (fields.ts), so
 * they line up with the field edges the terrain shader paints. `seed` varies
 * which hedges are poplar rows.
 */
export function hedgeQuery(x: number, z: number, seed: number, out: HedgeSample): HedgeSample {
  fieldAt(x, z, fiH);
  const d = fiH.dBlock;
  out.fieldId = fiH.id;
  out.dist = d;
  out.onHedge = false;
  out.poplarRow = false;
  out.snapX = 0;
  out.snapZ = 0;
  if (fiH.margin !== 'hedge' || d > HEDGE_BAND) return out;
  // gradient of the edge distance → direction to the boundary
  const e = 0.75;
  const gx = fieldAt(x + e, z, fiH).dBlock - fieldAt(x - e, z, fiH).dBlock;
  const gz = fieldAt(x, z + e, fiH).dBlock - fieldAt(x, z - e, fiH).dBlock;
  const gl = Math.hypot(gx, gz);
  if (!(gl > 0.2)) return out; // a corner or a district seam: no clean line to snap to
  out.onHedge = true;
  const k = (d - HEDGE_INSET) / gl;
  out.snapX = -gx * k;
  out.snapZ = -gz * k;
  // a few hedges are lines of poplars (per field + seed)
  out.poplarRow = pcgHash((out.fieldId ^ seed) | 0, 77) < 0.07;
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

/** Orchard lattice: spacing across / along the rows, m. Fraction of woodlots planted as orchards. */
const ORCH_ACROSS = 7.5;
const ORCH_ALONG = 6;
export const ORCHARD_SHARE = 0.35;
/** Orchards only on low ground. */
const ORCHARD_MAX_Y = 380;

const scratch = { buf: new Float32Array(0) };
const hedge = newHedgeSample();
const site = newSiteSample();
const fiO = newFieldInfo();
const grid = new Float64Array(25);

/** Wraps plain density/height functions as a `VegWorld`. */
export function worldOf(densityAt: DensityFn, heightAt: HeightFn): VegWorld {
  return { densityAt, heightAt };
}

/** True when the field containing (x, z) is an orchard (a planted woodlot). */
export function isOrchardField(x: number, z: number): boolean {
  fieldAt(x, z, fiO);
  return fiO.woodlot && pcgHash(fiO.id | 0, 4051) < ORCHARD_SHARE;
}

interface Emit {
  x: number;
  z: number;
  y: number;
  species: number;
  h: number;
  r: number;
  rot: number;
  tint: number;
  rank: number;
}
const em: Emit = { x: 0, z: 0, y: 0, species: 0, h: 0, r: 0, rot: 0, tint: 0, rank: 0 };

/**
 * All trees of placement cell (cx, cz): the square [cx·C, (cx+1)·C) × [cz·C, (cz+1)·C).
 * Pure and deterministic: same inputs → same trees. Only candidates with
 * rank < `rankMax` are evaluated and emitted.
 *
 * Signatures: `treesInCell(cx, cz, world, seed?, params?, rankMax?)` or the
 * legacy `treesInCell(cx, cz, densityAt, heightAt, seed?, params?, rankMax?)`.
 */
export function treesInCell(cx: number, cz: number, world: VegWorld, seed?: number, params?: PlacementParams, rankMax?: number): TreeCell;
export function treesInCell(cx: number, cz: number, densityAt: DensityFn, heightAt: HeightFn, seed?: number, params?: PlacementParams, rankMax?: number): TreeCell;
export function treesInCell(
  cx: number,
  cz: number,
  a: VegWorld | DensityFn,
  b?: HeightFn | number,
  c?: number | PlacementParams,
  d?: PlacementParams | number,
  e?: number,
): TreeCell {
  let world: VegWorld;
  let seed: number;
  let params: PlacementParams;
  let rankMax: number;
  if (typeof a === 'function') {
    world = worldOf(a, b as HeightFn);
    seed = (c as number | undefined) ?? CONFIG.world.seed;
    params = (d as PlacementParams | undefined) ?? DEFAULT_PARAMS;
    rankMax = e ?? 1;
  } else {
    world = a;
    seed = (b as number | undefined) ?? CONFIG.world.seed;
    params = (c as PlacementParams | undefined) ?? DEFAULT_PARAMS;
    rankMax = (d as number | undefined) ?? 1;
  }
  return placeCell(cx, cz, world, seed, params, rankMax);
}

function placeCell(cx: number, cz: number, world: VegWorld, seed: number, params: PlacementParams, rankMax: number): TreeCell {
  const n = params.gridPerCell;
  const C = params.cellSize;
  const sp = C / n;
  const f = fieldsFor(seed | 0);
  const seedI = seed | 0;
  const cap = n * n * 2 * TREE_STRIDE;
  if (scratch.buf.length < cap) scratch.buf = new Float32Array(cap);
  const buf = scratch.buf;
  let count = 0;
  const hasSite = typeof world.site === 'function';
  let gridReady = false;
  const gs = C / 4;
  const cx0 = cx * C;
  const cz0 = cz * C;

  /** Fills `site` for (x, z): the rich path (normal from the cell's height grid) or density + height. */
  const sample = (x: number, z: number): SiteSample => {
    if (!hasSite) {
      site.density = world.densityAt(x, z);
      site.height = NaN; // filled lazily by the caller (only for accepted trees)
      site.water = Infinity;
      site.field = 0;
      site.urban = 0;
      site.grass = 0;
      site.forest = 0;
      site.road = Infinity;
      site.airport = Infinity;
      return site;
    }
    if (!gridReady) {
      for (let j = 0; j <= 4; j++) for (let i = 0; i <= 4; i++) grid[j * 5 + i] = world.heightAt(cx0 + i * gs, cz0 + j * gs);
      gridReady = true;
    }
    let u = (x - cx0) / gs;
    let v = (z - cz0) / gs;
    u = u < 0 ? 0 : u > 3.999 ? 3.999 : u;
    v = v < 0 ? 0 : v > 3.999 ? 3.999 : v;
    const i = Math.floor(u);
    const j = Math.floor(v);
    const fu = u - i;
    const fv = v - j;
    const h00 = grid[j * 5 + i];
    const h10 = grid[j * 5 + i + 1];
    const h01 = grid[(j + 1) * 5 + i];
    const h11 = grid[(j + 1) * 5 + i + 1];
    const gx = ((h10 - h00) * (1 - fv) + (h11 - h01) * fv) / gs;
    const gz = ((h01 - h00) * (1 - fu) + (h11 - h10) * fu) / gs;
    const l = Math.sqrt(gx * gx + 1 + gz * gz);
    return world.site!(x, z, 1 / l, -gz / l, site);
  };

  const push = (): void => {
    const o = count * TREE_STRIDE;
    buf[o + T_X] = em.x;
    buf[o + T_Y] = em.y;
    buf[o + T_Z] = em.z;
    buf[o + T_H] = em.h;
    buf[o + T_R] = em.r;
    buf[o + T_SPECIES] = em.species;
    buf[o + T_ROT] = em.rot;
    buf[o + T_TINT] = em.tint;
    buf[o + T_RANK] = em.rank;
    count++;
  };

  for (let j = 0; j < n; j++) {
    const gz = cz * n + j;
    for (let i = 0; i < n; i++) {
      const gx = cx * n + i;
      const hRank = hash2i(gx, gz, seedI ^ 0x0a54ff53);
      const rank = (BAYER4[((gz & 3) << 2) | (gx & 3)] + hRank * 0.999) / 16;
      const lx0 = gx * sp;
      const lz0 = gz * sp;

      // One field lookup per square: orchards (a regular lattice along the field rows) and hedges.
      fieldAt(lx0 + sp / 2, lz0 + sp / 2, fiO);
      if (fiO.woodlot && pcgHash(fiO.id | 0, 4051) < ORCHARD_SHARE) {
        orchardSquare(lx0, lz0, sp, world, seedI, params, rankMax, sample, push);
        continue;
      }
      if (!(rank < rankMax)) continue;
      const nearHedge = fiO.margin === 'hedge' && fiO.dBlock <= HEDGE_BAND + sp;

      const hAccept = hash2i(gx, gz, seedI);
      const hJx = hash2i(gx, gz, seedI ^ 0x1f3d5b79);
      const hJz = hash2i(gx, gz, seedI ^ 0x2c1b3c6d);
      let x = lx0 + (0.5 + (hJx - 0.5) * 0.9) * sp;
      let z = lz0 + (0.5 + (hJz - 0.5) * 0.9) * sp;

      // Hedgerows pull candidates onto the field boundary (kept inside the lattice square).
      if (nearHedge) hedgeQuery(x, z, seedI, hedge);
      const onHedge = nearHedge && hedge.onHedge;
      if (onHedge) {
        x += hedge.snapX;
        z += hedge.snapZ;
        const eps = sp * 0.02;
        x = x < lx0 + eps ? lx0 + eps : x > lx0 + sp - eps ? lx0 + sp - eps : x;
        z = z < lz0 + eps ? lz0 + eps : z > lz0 + sp - eps ? lz0 + sp - eps : z;
      }

      const s = sample(x, z);
      let dens = s.density * params.densityScale;
      if (!(dens > 0)) continue; // 0, negative and NaN → never a tree
      if (dens > 1) dens = 1;

      const cl = 0.65 * f.cluster(x / 70, z / 70) + 0.35 * f.cluster(x / 23 + 100, z / 23);
      let p: number;
      const woodland = dens >= 0.3;
      if (woodland) {
        p = dens * (0.92 + 0.38 * cl);
        if (cl < -0.55) p *= smooth(-0.8, -0.55, cl); // small clearings
      } else {
        p = ((dens * dens) / 0.3) * (0.9 + 0.3 * cl);
      }
      const hedgeRow = onHedge && dens < 0.5;
      if (hedgeRow) p = Math.max(p, 0.8);
      if (!(hAccept < p)) continue;

      const y = hasSite ? s.height : world.heightAt(x, z);
      if (!Number.isFinite(y)) continue; // no ground here (bad input) → no tree
      const riparian = s.water < 34 && !hedgeRow;

      const hS = hash2i(gx, gz, seedI ^ 0x3b9ac9e1);
      const hSize = hash2i(gx, gz, seedI ^ 0x51f15e5d);
      const hR = hash2i(gx, gz, seedI ^ 0x6a09e667);
      const hRot = hash2i(gx, gz, seedI ^ 0x0bb67ae8);
      const hTint = hash2i(gx, gz, seedI ^ 0x3c6ef372);

      let species: number;
      let edge = 0;
      if (hedgeRow) {
        species = hedge.poplarRow ? (hS < 0.9 ? POPLAR : BROADLEAF) : hS < 0.46 ? BUSH : hS < 0.88 ? BROADLEAF : hS < 0.95 ? BIRCH : SPRUCE;
      } else if (riparian) {
        species = hS < 0.4 ? WILLOW : hS < 0.58 ? POPLAR : hS < 0.7 ? BUSH : hS < 0.8 ? BIRCH : BROADLEAF;
      } else if (s.urban > 0.12) {
        species = hS < 0.55 ? BROADLEAF : hS < 0.72 ? BIRCH : hS < 0.82 ? POPLAR : hS < 0.9 ? SPRUCE : BUSH;
      } else if (woodland) {
        edge = 1 - smooth(0.3, 0.75, dens);
        const pBush = 0.04 + 0.3 * edge;
        const pBirch = 0.03 + 0.14 * edge;
        const pPoplar = 0.012;
        const stand = 0.7 * f.stand(x / 2600, z / 2600) + 0.3 * f.stand(x / 420 + 31, z / 420);
        let coniferShare = 0.42 + 0.9 * stand + (y - 160) / 480;
        coniferShare = coniferShare < 0.03 ? 0.03 : coniferShare > 0.97 ? 0.97 : coniferShare;
        // pines on low, dry ground and sandy coasts; spruce/fir higher up
        const pineShare = 0.55 * (1 - smooth(250, 700, y)) * (0.6 + 0.4 * f.stand(x / 900 + 71, z / 900));
        if (hS < pBush) species = BUSH;
        else if (hS < pBush + pBirch) species = BIRCH;
        else if (hS < pBush + pBirch + pPoplar) species = POPLAR;
        else {
          const u = (hS - pBush - pBirch - pPoplar) / (1 - pBush - pBirch - pPoplar);
          species = u < coniferShare ? (u < coniferShare * pineShare ? PINE : SPRUCE) : BROADLEAF;
        }
      } else {
        species = hS < 0.13 ? BUSH : hS < 0.22 ? BIRCH : hS < 0.29 ? POPLAR : hS < 0.37 ? PINE : hS < 0.42 ? SPRUCE : BROADLEAF;
      }

      let h: number;
      let r: number;
      switch (species) {
        case SPRUCE:
          h = 14 + 15 * Math.pow(hSize, 0.8);
          r = h * (0.17 + 0.06 * hR);
          break;
        case PINE:
          h = 14 + 12 * hSize;
          r = h * (0.2 + 0.08 * hR);
          break;
        case BROADLEAF:
          h = 10 + 11 * hSize;
          r = h * (0.36 + 0.14 * hR);
          if (!woodland && !hedgeRow) {
            h *= 1.08; // open-grown: broad and full
            r *= 1.2;
          }
          break;
        case BIRCH:
          h = 10 + 9 * hSize;
          r = h * (0.22 + 0.08 * hR);
          break;
        case POPLAR:
          h = 18 + 10 * hSize;
          r = h * (0.11 + 0.05 * hR);
          break;
        case WILLOW:
          h = 8 + 7 * hSize;
          r = h * (0.5 + 0.15 * hR);
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
      // krummholz: trees shrink toward the alpine tree line
      if (y > 1250 && species !== BUSH) {
        const k = 1 - 0.55 * smooth(1250, 1750, y);
        h *= k;
        r *= 0.6 + 0.4 * k;
      }
      if (r > MAX_CROWN_RADIUS) r = MAX_CROWN_RADIUS;
      if (h > MAX_TREE_HEIGHT) h = MAX_TREE_HEIGHT;

      em.x = x;
      em.z = z;
      em.y = y;
      em.species = species;
      em.h = h;
      em.r = r;
      em.rot = hRot * Math.PI * 2;
      em.tint = hTint;
      em.rank = rank;
      push();
    }
  }
  return { cx, cz, count, data: buf.slice(0, count * TREE_STRIDE) };
}

/**
 * Orchard trees of one lattice square: the points of a regular lattice aligned
 * with the field's tractor rows (fields.ts `across` + row direction) that fall
 * inside the square — every lattice point belongs to exactly one square, so
 * rows are complete and never doubled.
 */
function orchardSquare(
  lx0: number,
  lz0: number,
  sp: number,
  world: VegWorld,
  seedI: number,
  params: PlacementParams,
  rankMax: number,
  sample: (x: number, z: number) => SiteSample,
  push: () => void,
): void {
  const x = lx0 + sp / 2;
  const z = lz0 + sp / 2;
  fieldAt(x, z, fiO);
  const rdx = fiO.rowDirX;
  const rdz = fiO.rowDirZ;
  const a0 = fiO.across;
  const ax = fieldAt(x + 1, z, fiO).across - a0;
  const az = fieldAt(x, z + 1, fiO).across - a0;
  const g2 = ax * ax + az * az;
  if (!(g2 > 0.25)) return;
  const l0 = x * rdx + z * rdz;
  const k0 = Math.floor((a0 - sp) / ORCH_ACROSS);
  const k1 = Math.ceil((a0 + sp) / ORCH_ACROSS);
  for (let k = k0; k <= k1; k++) {
    const stagger = (k & 1) * 0.5;
    const ak = (k + 0.5) * ORCH_ACROSS;
    const m0 = Math.floor((l0 - sp) / ORCH_ALONG - stagger);
    const m1 = Math.ceil((l0 + sp) / ORCH_ALONG - stagger);
    for (let m = m0; m <= m1; m++) {
      const lm = (m + 0.5 + stagger) * ORCH_ALONG;
      const px = x + (ax * (ak - a0)) / g2 + rdx * (lm - l0);
      const pz = z + (az * (ak - a0)) / g2 + rdz * (lm - l0);
      if (px < lx0 || px >= lx0 + sp || pz < lz0 || pz >= lz0 + sp) continue;
      const hRank = hash2i(k, m, seedI ^ 0x0a54ff53);
      const rank = (BAYER4[((m & 3) << 2) | (k & 3)] + hRank * 0.999) / 16;
      if (!(rank < rankMax)) continue;
      const s = sample(px, pz);
      const dens = s.density * params.densityScale;
      if (!(dens > 0.05)) continue;
      const y = Number.isFinite(s.height) ? s.height : world.heightAt(px, pz);
      if (!Number.isFinite(y) || y > ORCHARD_MAX_Y) continue;
      const hMiss = hash2i(k, m, seedI ^ 0x4f1bbcdc);
      if (hMiss < 0.04) continue; // the odd gap in the rows
      const hSize = hash2i(k, m, seedI ^ 0x51f15e5d);
      em.x = px;
      em.z = pz;
      em.y = y;
      em.species = BROADLEAF;
      em.h = 4.2 + 1.8 * hSize;
      em.r = em.h * (0.5 + 0.08 * hash2i(k, m, seedI ^ 0x6a09e667));
      em.rot = hash2i(k, m, seedI ^ 0x0bb67ae8) * Math.PI * 2;
      // orchard tints sit in their own band (fresh, even green) — see materials.ts
      em.tint = 0.3 + 0.2 * hash2i(k, m, seedI ^ 0x3c6ef372);
      em.rank = rank;
      push();
    }
  }
}
