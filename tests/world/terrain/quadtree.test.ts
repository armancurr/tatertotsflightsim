import { describe, it, expect } from 'vitest';
import { selectTiles, morphRange, lodParamsFromConfig, type TileDesc } from '../../../src/world/terrain/quadtree';
import { CONFIG } from '../../../src/config';

const P = lodParamsFromConfig(CONFIG);
const flat = () => ({ min: 0, max: 50 });

function overlaps(a: TileDesc, b: TileDesc): boolean {
  return a.x0 < b.x0 + b.size && b.x0 < a.x0 + a.size && a.z0 < b.z0 + b.size && b.z0 < a.z0 + a.size;
}

describe('terrain LOD quadtree', () => {
  it('takes its parameters from config.world.terrain and the visibility', () => {
    expect(P.rootSize).toBe(CONFIG.world.terrain.rootSize);
    expect(P.minTileSize).toBe(CONFIG.world.terrain.minTileSize);
    expect(P.splitFactor).toBe(CONFIG.world.terrain.lodSplitFactor);
    expect(P.maxDistance).toBeGreaterThanOrEqual(CONFIG.atmosphere.visibility);
  });

  for (const cam of [
    { x: 0, y: 32, z: 750 },
    { x: 5000, y: 1500, z: -3000 },
    { x: 2e5 + 17, y: 800, z: -3.3e5 },
  ]) {
    it(`covers the visible world without overlaps or holes (camera ${cam.x}, ${cam.y}, ${cam.z})`, () => {
      const tiles = selectTiles(cam, P, flat);
      for (let i = 0; i < tiles.length; i++) for (let j = i + 1; j < tiles.length; j++) expect(overlaps(tiles[i], tiles[j])).toBe(false);
      // every probe point within the visibility distance lies in exactly one tile
      for (let a = 0; a < 360; a += 7)
        for (const r of [0, 50, 300, 1200, 5000, 20000, 45000, 59000]) {
          const x = cam.x + Math.sin((a * Math.PI) / 180) * r;
          const z = cam.z + Math.cos((a * Math.PI) / 180) * r;
          const n = tiles.filter((t) => x >= t.x0 && x < t.x0 + t.size && z >= t.z0 && z < t.z0 + t.size).length;
          expect(n).toBe(1);
        }
      // ~44 leaves per level ring; three's frustum culling draws about a third of them
      expect(tiles.length).toBeLessThan(360);
    });
  }

  it('uses the finest tiles under the camera and coarser ones with distance', () => {
    const cam = { x: 100, y: 10, z: 100 };
    const tiles = selectTiles(cam, P, flat);
    const under = tiles.find((t) => cam.x >= t.x0 && cam.x < t.x0 + t.size && cam.z >= t.z0 && cam.z < t.z0 + t.size)!;
    expect(under.size).toBe(P.minTileSize);
    for (const t of tiles) {
      if (t.size > P.minTileSize) expect(t.dist).toBeGreaterThanOrEqual(t.size * P.splitFactor - 1e-6);
    }
    // neighbouring tiles differ by at most one level (so morphing + skirts close every seam)
    for (const a of tiles)
      for (const b of tiles) {
        const touch = a.x0 <= b.x0 + b.size && b.x0 <= a.x0 + a.size && a.z0 <= b.z0 + b.size && b.z0 <= a.z0 + a.size;
        if (touch && a !== b) expect(Math.abs(a.level - b.level)).toBeLessThanOrEqual(1);
      }
  });

  it('refines less at altitude', () => {
    const low = selectTiles({ x: 0, y: 30, z: 0 }, P, flat);
    const high = selectTiles({ x: 0, y: 5000, z: 0 }, P, flat);
    expect(Math.min(...high.map((t) => t.size))).toBeGreaterThan(Math.min(...low.map((t) => t.size)));
    expect(high.length).toBeLessThan(low.length);
  });

  it('morph range ends where the parent would stop splitting', () => {
    const [a, b] = morphRange(1024, P.splitFactor);
    expect(b).toBeCloseTo(2 * 1024 * P.splitFactor);
    expect(a).toBeLessThan(b);
    expect(a).toBeGreaterThan(1024 * P.splitFactor);
  });

  it('is deterministic and stable keys identify tiles', () => {
    const a = selectTiles({ x: 10, y: 400, z: 20 }, P, flat).map((t) => t.key);
    const b = selectTiles({ x: 10, y: 400, z: 20 }, P, flat).map((t) => t.key);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
  });
});
