/**
 * Level-of-detail rules for trees. PURE. The GLSL in materials.ts mirrors
 * these formulas exactly (per instance, distance camera → crown centre):
 *
 *   mesh weight      = 1 − smoothstep(meshDistance − lodFadeBand, meshDistance, d)
 *   impostor weight  = 1 − mesh weight (0 beyond the view distance)
 *   keep fraction    = capScale · min(1, (thinStart / d)^thinExp) · farFade(d)
 *   farFade(d)       = 1 − smoothstep(view − farFadeBand, view, d)
 *   compensation     = min(thinCompensationMax, 1 / √min(1, (thinStart / d)^thinExp))
 *
 * An impostor is drawn only when its (stratified) rank < keep fraction; the
 * survivors grow by `compensation` so thinned far forest keeps its canopy
 * cover, and everything fades out toward the view distance where the terrain
 * colour takes over.
 */
import { CONFIG } from '../../config';

export interface LodParams {
  meshDistance: number;
  lodFadeBand: number;
  viewDistance: number;
  farFadeBand: number;
  thinStartDistance: number;
  thinExponent: number;
  thinCompensationMax: number;
}

export function lodParams(v = CONFIG.world.vegetation): LodParams {
  return {
    meshDistance: v.meshDistance,
    lodFadeBand: v.lodFadeBand,
    viewDistance: v.treeViewDistance,
    farFadeBand: v.farFadeBand,
    thinStartDistance: v.thinStartDistance,
    thinExponent: v.thinExponent,
    thinCompensationMax: v.thinCompensationMax,
  };
}

export type LodLevel = 'mesh' | 'impostor' | 'none';

export const smoothstep = (e0: number, e1: number, x: number): number => {
  let t = (x - e0) / (e1 - e0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
};

export function lodWeights(d: number, p: LodParams, out: { mesh: number; impostor: number }): { mesh: number; impostor: number } {
  const mesh = 1 - smoothstep(p.meshDistance - p.lodFadeBand, p.meshDistance, d);
  out.mesh = mesh;
  out.impostor = d < p.viewDistance ? 1 - mesh : 0;
  return out;
}

const w = { mesh: 0, impostor: 0 };
/** The dominant representation of a tree at distance d. */
export function lodForDistance(d: number, p: LodParams): LodLevel {
  if (!(d < p.viewDistance)) return 'none';
  lodWeights(d, p, w);
  return w.mesh >= 0.5 ? 'mesh' : 'impostor';
}

/** Distance thinning factor alone (1 near, falling beyond thinStartDistance). */
export function thinFactor(d: number, p: LodParams): number {
  if (d <= p.thinStartDistance) return 1;
  return Math.pow(p.thinStartDistance / d, p.thinExponent);
}

/** Fraction of impostors (by rank) still drawn at distance d. */
export function keepFraction(d: number, p: LodParams, capScale: number): number {
  const far = 1 - smoothstep(p.viewDistance - p.farFadeBand, p.viewDistance, d);
  return capScale * thinFactor(d, p) * far;
}

/** Size multiplier for surviving impostors so thinned forest stays closed. */
export function thinCompensation(d: number, p: LodParams): number {
  return Math.min(p.thinCompensationMax, 1 / Math.sqrt(thinFactor(d, p)));
}

/** Distance from (px, pz) to the axis-aligned rectangle [x0, x1] × [z0, z1] (0 inside). */
export function rectDistance(px: number, pz: number, x0: number, z0: number, x1: number, z1: number): number {
  const dx = px < x0 ? x0 - px : px > x1 ? px - x1 : 0;
  const dz = pz < z0 ? z0 - pz : pz > z1 ? pz - z1 : 0;
  return Math.sqrt(dx * dx + dz * dz);
}

export interface ChunkRef {
  kx: number;
  kz: number;
  /** Nearest distance from the query point to the chunk square. */
  dist: number;
}

/** Every chunk (size m) whose square comes within `radius` of (x, z), nearest first. */
export function chunksInRange(x: number, z: number, radius: number, size: number): ChunkRef[] {
  const out: ChunkRef[] = [];
  const k0x = Math.floor((x - radius) / size);
  const k1x = Math.floor((x + radius) / size);
  const k0z = Math.floor((z - radius) / size);
  const k1z = Math.floor((z + radius) / size);
  for (let kz = k0z; kz <= k1z; kz++)
    for (let kx = k0x; kx <= k1x; kx++) {
      const d = rectDistance(x, z, kx * size, kz * size, (kx + 1) * size, (kz + 1) * size);
      if (d <= radius) out.push({ kx, kz, dist: d });
    }
  out.sort((a, b) => a.dist - b.dist || a.kz - b.kz || a.kx - b.kx);
  return out;
}
