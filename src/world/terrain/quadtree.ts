/**
 * Terrain level-of-detail selection (PURE). A grid of root tiles (rootSize,
 * aligned to the world origin) around the camera, each a quadtree; a node is
 * split while the camera is closer to its 3D bounding box than
 * size × splitFactor (down to minTileSize). With splitFactor ≥ ~1.5 neighbouring
 * leaves differ by at most one level, so the vertex-shader morph + skirts close
 * every seam. Tiles farther than maxDistance are dropped.
 */
import type { Config } from '../../config';

export interface LodParams {
  rootSize: number;
  minTileSize: number;
  splitFactor: number;
  /** Tiles whose box is farther than this are not drawn (the visibility distance). */
  maxDistance: number;
}

export interface TileDesc {
  key: string;
  level: number;
  ix: number;
  iz: number;
  size: number;
  /** Min corner (world x, z). */
  x0: number;
  z0: number;
  /** Distance from the camera to the tile's bounding box. */
  dist: number;
}

export type YRange = (level: number, ix: number, iz: number, size: number, x0: number, z0: number) => { min: number; max: number };

export function lodParamsFromConfig(cfg: Config): LodParams {
  const t = cfg.world.terrain;
  return { rootSize: t.rootSize, minTileSize: t.minTileSize, splitFactor: t.lodSplitFactor, maxDistance: cfg.atmosphere.visibility * 1.05 };
}

export function tileKey(level: number, ix: number, iz: number): string {
  return `${level}/${ix}/${iz}`;
}

/** Distance from point to an axis-aligned box. */
export function boxDistance(px: number, py: number, pz: number, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): number {
  const dx = px < x0 ? x0 - px : px > x1 ? px - x1 : 0;
  const dy = py < y0 ? y0 - py : py > y1 ? py - y1 : 0;
  const dz = pz < z0 ? z0 - pz : pz > z1 ? pz - z1 : 0;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Should a node of this size, at this box distance, be split into four children? */
export function shouldSplit(size: number, dist: number, p: LodParams): boolean {
  return size > p.minTileSize && dist < size * p.splitFactor;
}

/**
 * Vertex-distance range over which a tile of `size` morphs toward its parent's grid:
 * fully morphed where the parent would stop splitting (2·size·splitFactor).
 */
export function morphRange(size: number, splitFactor: number): [number, number] {
  const end = 2 * size * splitFactor;
  return [end * 0.72, end];
}

/** The leaf tiles to draw for a camera position. */
export function selectTiles(cam: { x: number; y: number; z: number }, p: LodParams, yRange: YRange, out: TileDesc[] = []): TileDesc[] {
  out.length = 0;
  const R = p.rootSize;
  const cx = Math.floor(cam.x / R);
  const cz = Math.floor(cam.z / R);
  const span = Math.ceil(p.maxDistance / R);
  const visit = (level: number, ix: number, iz: number) => {
    const size = R / 2 ** level;
    const x0 = ix * size;
    const z0 = iz * size;
    const yr = yRange(level, ix, iz, size, x0, z0);
    const d = boxDistance(cam.x, cam.y, cam.z, x0, x0 + size, yr.min, yr.max, z0, z0 + size);
    if (d > p.maxDistance) return;
    if (shouldSplit(size, d, p)) {
      visit(level + 1, ix * 2, iz * 2);
      visit(level + 1, ix * 2 + 1, iz * 2);
      visit(level + 1, ix * 2, iz * 2 + 1);
      visit(level + 1, ix * 2 + 1, iz * 2 + 1);
    } else {
      out.push({ key: tileKey(level, ix, iz), level, ix, iz, size, x0, z0, dist: d });
    }
  };
  for (let iz = cz - span; iz <= cz + span; iz++) for (let ix = cx - span; ix <= cx + span; ix++) visit(0, ix, iz);
  return out;
}
