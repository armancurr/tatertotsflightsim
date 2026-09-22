/**
 * Level-of-detail and chunking decisions for the building renderer. PURE
 * (three.js math types only).
 *
 * Buildings are grouped into square chunks by their centre. Per chunk and
 * frame: LOD_NEAR (detailed archetype meshes) while the camera is within
 * `nearDistance` of the chunk's bounding box, LOD_BOX (one box per building,
 * largest first, only those whose size ≥ distance × minAngularSize; past
 * midDistance only tall ones) out to `farDistance`, LOD_HIDDEN beyond.
 */
import * as THREE from 'three';
import type { Building } from './placement';
import { buildingRect } from './placement';
import { rectCorners } from './geom';
import type { TownsConfig } from '../roads/network';

export const LOD_NEAR = 0;
export const LOD_BOX = 1;
export const LOD_HIDDEN = 2;
export type Lod = 0 | 1 | 2;

/** Height (m) from which a building counts as "tall" (visible past midDistance). */
export const TALL_SIZE = 25;

type LodCfg = Pick<TownsConfig, 'nearDistance' | 'midDistance' | 'farDistance' | 'minAngularSize' | 'hysteresis'>;

export function selectLod(dist: number, prev: Lod, cfg: LodCfg): Lod {
  const h = cfg.hysteresis;
  const near = cfg.nearDistance * (prev === LOD_NEAR ? 1 + h : 1 - h);
  if (dist < near) return LOD_NEAR;
  const far = cfg.farDistance * (prev === LOD_HIDDEN ? 1 - h : 1 + h);
  return dist < far ? LOD_BOX : LOD_HIDDEN;
}

/** Size threshold (m) for boxes at a distance. */
export function boxThreshold(dist: number, cfg: LodCfg): number {
  const t = dist * cfg.minAngularSize;
  return dist > cfg.midDistance ? Math.max(t, TALL_SIZE) : t;
}

/** Number of leading entries of `sizesDesc` (sorted descending) that are ≥ the threshold at `dist`. */
export function boxCount(sizesDesc: Float32Array, dist: number, cfg: LodCfg): number {
  const thr = boxThreshold(dist, cfg);
  let lo = 0;
  let hi = sizesDesc.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sizesDesc[mid] >= thr) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface Chunk {
  i: number;
  j: number;
  indices: number[];
}

export function groupByChunk(buildings: readonly Building[], size: number): Chunk[] {
  const map = new Map<string, Chunk>();
  buildings.forEach((b, idx) => {
    const i = Math.floor(b.x / size);
    const j = Math.floor(b.z / size);
    const k = `${i},${j}`;
    let c = map.get(k);
    if (!c) map.set(k, (c = { i, j, indices: [] }));
    c.indices.push(idx);
  });
  return [...map.values()].sort((a, b) => a.j - b.j || a.i - b.i);
}

/** Axis-aligned bounds of the buildings (footprints incl. a 1 m eave allowance, base to roof top). */
export function chunkBounds(buildings: readonly Building[], indices: readonly number[]): THREE.Box3 {
  const box = new THREE.Box3();
  for (const i of indices) {
    const b = buildings[i];
    for (const c of rectCorners(buildingRect(b))) {
      box.expandByPoint(new THREE.Vector3(c.x - 1, b.y, c.z - 1));
      box.expandByPoint(new THREE.Vector3(c.x + 1, b.y + b.wallHeight + b.roofHeight + 0.5, c.z + 1));
    }
  }
  return box;
}

/** Distance from a point to a box (0 inside). Allocation-free. */
export function distanceToBox(box: THREE.Box3, x: number, y: number, z: number): number {
  const dx = x < box.min.x ? box.min.x - x : x > box.max.x ? x - box.max.x : 0;
  const dy = y < box.min.y ? box.min.y - y : y > box.max.y ? y - box.max.y : 0;
  const dz = z < box.min.z ? box.min.z - z : z > box.max.z ? z - box.max.z : 0;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
