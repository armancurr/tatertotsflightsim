/**
 * Tree obstacles for the physics: `top(x, z)` = the highest canopy surface
 * (m MSL) over the point, or −Infinity where there is no tree. PURE — it runs
 * the same deterministic placement as the renderer (`treesInCell`) through a
 * spatial hash (the placement cells) with a bounded LRU cache, so it works
 * anywhere in the world whether or not the trees are currently drawn.
 */
import { CONFIG } from '../../config';
import {
  treesInCell,
  canopyTopOf,
  placementParams,
  MAX_CROWN_RADIUS,
  TREE_STRIDE,
  T_X,
  T_Z,
  T_R,
  type DensityFn,
  type HeightFn,
  type PlacementParams,
  type TreeCell,
  type VegWorld,
} from './placement';

export interface ObstacleFieldOptions {
  densityAt: DensityFn;
  heightAt: HeightFn;
  seed?: number;
  params?: PlacementParams;
  /** The full placement world (takes precedence over densityAt/heightAt). */
  world?: VegWorld;
  /** LRU capacity in cells. */
  cacheCells?: number;
  /** Optional source of already generated cells (the renderer's chunks); null = generate. */
  provider?: (cx: number, cz: number) => TreeCell | null;
}

export interface ObstacleField {
  /** Canopy top (m MSL) at x, z, or −Infinity. Never NaN. */
  top(x: number, z: number): number;
  /** Cells currently cached. */
  cachedCells(): number;
  /** Seeds the cache with an already generated cell (the renderer shares its work). */
  offer(cell: TreeCell): void;
  clear(): void;
}

/** Farther than this from the origin there are no trees (the world is ±65 km). */
const WORLD_LIMIT = 1e7;
const OFF = 1 << 20;
const cellKey = (cx: number, cz: number): number => (cx + OFF) * 2097152 + (cz + OFF);

export function createObstacleField(opts: ObstacleFieldOptions): ObstacleField {
  const params = opts.params ?? placementParams();
  const seed = opts.seed ?? CONFIG.world.seed;
  const capacity = Math.max(4, opts.cacheCells ?? CONFIG.world.vegetation.obstacleCacheCells);
  const C = params.cellSize;
  const cache = new Map<number, TreeCell>();

  const getCell = (cx: number, cz: number): TreeCell => {
    const k = cellKey(cx, cz);
    let c = cache.get(k);
    if (c) {
      // refresh LRU position
      cache.delete(k);
      cache.set(k, c);
      return c;
    }
    c = opts.provider?.(cx, cz) ?? (opts.world ? treesInCell(cx, cz, opts.world, seed, params) : treesInCell(cx, cz, opts.densityAt, opts.heightAt, seed, params));
    cache.set(k, c);
    if (cache.size > capacity) cache.delete(cache.keys().next().value as number);
    return c;
  };

  const topInCell = (c: TreeCell, x: number, z: number, best: number): number => {
    const d = c.data;
    for (let i = 0; i < c.count; i++) {
      const o = i * TREE_STRIDE;
      const r = d[o + T_R];
      const dx = x - d[o + T_X];
      if (dx > r || dx < -r) continue;
      const dz = z - d[o + T_Z];
      if (dz > r || dz < -r) continue;
      const t = canopyTopOf(d, i, x, z);
      if (t > best) best = t;
    }
    return best;
  };

  return {
    top(x: number, z: number): number {
      if (!(x > -WORLD_LIMIT && x < WORLD_LIMIT && z > -WORLD_LIMIT && z < WORLD_LIMIT)) return -Infinity;
      const cx = Math.floor(x / C);
      const cz = Math.floor(z / C);
      const fx = x - cx * C;
      const fz = z - cz * C;
      const R = MAX_CROWN_RADIUS;
      const x0 = fx < R ? -1 : 0;
      const x1 = fx > C - R ? 1 : 0;
      const z0 = fz < R ? -1 : 0;
      const z1 = fz > C - R ? 1 : 0;
      let best = -Infinity;
      for (let dz = z0; dz <= z1; dz++) for (let dx = x0; dx <= x1; dx++) best = topInCell(getCell(cx + dx, cz + dz), x, z, best);
      return Number.isNaN(best) ? -Infinity : best;
    },
    cachedCells: () => cache.size,
    offer(cell: TreeCell): void {
      const k = cellKey(cell.cx, cell.cz);
      if (cache.has(k)) return;
      cache.set(k, cell);
      if (cache.size > capacity) cache.delete(cache.keys().next().value as number);
    },
    clear: () => cache.clear(),
  };
}
