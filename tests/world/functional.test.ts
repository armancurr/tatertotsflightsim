/**
 * Functional tests: the world pieces working together the way the renderer
 * and the physics use them.
 */
import { describe, it, expect, vi } from 'vitest';

// Whole-flight functional tests: heavy on purpose; they must not flake when the full suite runs in parallel.
vi.setConfig({ testTimeout: 60_000 });
import { buildChunk, defaultSkirt } from '../../src/world/terrain/chunk';
import { selectTiles, lodParamsFromConfig, morphRange, type TileDesc } from '../../src/world/terrain/quadtree';
import { getHeightfield, terrainHeight } from '../../src/world/heightfield';
import { getLandcover } from '../../src/world/landcover';
import { getLayout } from '../../src/world/layout';
import { createEnvironment } from '../../src/world/environment';
import { fromRunwayCoords } from '../../src/world/runway';
import { CONFIG } from '../../src/config';

const hf = getHeightfield();
const lc = getLandcover();
const L = getLayout();
const res = 16;

/** World-space surface height of a built tile at its vertex (i, j), with a morph factor. */
function vertexY(c: ReturnType<typeof buildChunk>, i: number, j: number, morph: number): number {
  const v = j * (res + 1) + i;
  return c.positions[v * 3 + 1] + c.morph[v * 3] * morph;
}

describe('terrain tiles are crack-free', () => {
  // Mountain terrain is where cracks would show.
  const size = 1024;
  const x0 = 4096;
  const z0 = -20480;

  it('adjacent tiles of the same size share identical edges', () => {
    const a = buildChunk(hf, lc, { x0, z0, size, res });
    const b = buildChunk(hf, lc, { x0: x0 + size, z0, size, res });
    const c = buildChunk(hf, lc, { x0, z0: z0 + size, size, res });
    for (let k = 0; k <= res; k++) {
      expect(vertexY(a, res, k, 0)).toBe(vertexY(b, 0, k, 0)); // a's east = b's west
      expect(vertexY(a, k, res, 0)).toBe(vertexY(c, k, 0, 0)); // a's south = c's north
      // with equal morph they still agree
      expect(vertexY(a, res, k, 1)).toBeCloseTo(vertexY(b, 0, k, 1), 4);
    }
  });

  it('a fine tile fully morphed at a LOD seam matches the coarse neighbour exactly', () => {
    // fine tile (size) east of which lies a coarse tile (2·size) whose west edge contains the fine east edge
    const fine = buildChunk(hf, lc, { x0, z0, size, res });
    const coarse = buildChunk(hf, lc, { x0: x0 + size, z0, size: size * 2, res });
    for (let j = 0; j <= res; j++) {
      const zf = z0 + (j * size) / res;
      // coarse edge surface height at zf: linear along the coarse edge between its vertices
      const u = ((zf - z0) / (2 * size)) * res;
      const j0 = Math.floor(u);
      const t = u - j0;
      const yc = j0 >= res ? vertexY(coarse, 0, res, 0) : vertexY(coarse, 0, j0, 0) * (1 - t) + vertexY(coarse, 0, j0 + 1, 0) * t;
      expect(vertexY(fine, res, j, 1)).toBeCloseTo(yc, 3);
    }
  });

  it('where the seam is not yet fully morphed, the skirts are deeper than any gap', () => {
    const fine = buildChunk(hf, lc, { x0, z0, size, res });
    const coarse = buildChunk(hf, lc, { x0: x0 + size, z0, size: size * 2, res });
    let worst = 0;
    for (let j = 0; j <= res; j++) {
      const u = (j / res / 2) * res;
      const j0 = Math.floor(u);
      const t = u - j0;
      const yc = j0 >= res ? vertexY(coarse, 0, res, 0) : vertexY(coarse, 0, j0, 0) * (1 - t) + vertexY(coarse, 0, j0 + 1, 0) * t;
      worst = Math.max(worst, Math.abs(vertexY(fine, res, j, 0) - yc));
    }
    expect(worst).toBeLessThan(defaultSkirt(size, res));
  });
});

describe('LOD around a moving camera', () => {
  const P = lodParamsFromConfig(CONFIG);
  const yRange = (level: number, ix: number, iz: number, size: number, x0: number, z0: number) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const [a, b] of [
      [0.5, 0.5],
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ]) {
      const h = terrainHeight(x0 + a * size, z0 + b * size);
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
    return { min: lo - 50, max: hi + 50 };
  };
  /** Tiles whose bounding circle intersects a horizontal view wedge (heading, 80° wide). */
  const inView = (tiles: TileDesc[], cam: { x: number; z: number }, headingDeg: number) =>
    tiles.filter((t) => {
      const cx = t.x0 + t.size / 2 - cam.x;
      const cz = t.z0 + t.size / 2 - cam.z;
      const d = Math.hypot(cx, cz);
      const r = t.size * 0.7072;
      if (d < r) return true;
      const ang = Math.atan2(cx, -cz) - (headingDeg * Math.PI) / 180;
      const off = Math.abs(Math.atan2(Math.sin(ang), Math.cos(ang)));
      return off < (40 * Math.PI) / 180 + Math.asin(Math.min(1, r / d));
    });

  it('stays bounded with modest churn and draw calls through a whole flight', () => {
    // take-off roll north, climb to 1500 m, cruise north-east at 150 kt into the mountains, descend back
    const dt = 0.25;
    let prev = new Set<string>();
    let maxTiles = 0;
    let maxChurn = 0;
    let maxView = 0;
    let x = 0;
    let z = 755;
    let y = 32;
    let heading = 0;
    for (let t = 0; t < 240; t += dt) {
      const speed = t < 25 ? 3 * t : 77;
      if (t > 25 && y < 1500) y += 5 * dt;
      if (t > 120) heading = 45;
      if (t > 180) y = Math.max(terrainHeight(x, z) + 300, y - 10 * dt);
      x += Math.sin((heading * Math.PI) / 180) * speed * dt;
      z -= Math.cos((heading * Math.PI) / 180) * speed * dt;
      const cam = { x, y: Math.max(y, terrainHeight(x, z) + 2), z };
      const tiles = selectTiles(cam, P, yRange);
      const keys = new Set(tiles.map((q) => q.key));
      let churn = 0;
      for (const k of keys) if (!prev.has(k)) churn++;
      if (t > 0) maxChurn = Math.max(maxChurn, churn);
      prev = keys;
      maxTiles = Math.max(maxTiles, tiles.length);
      maxView = Math.max(maxView, inView(tiles, cam, heading).length);
      // the ground under the camera is always covered by the finest tiles when low
      if (cam.y - terrainHeight(x, z) < 50) {
        const under = tiles.find((q) => x >= q.x0 && x < q.x0 + q.size && z >= q.z0 && z < q.z0 + q.size)!;
        expect(under.size).toBe(P.minTileSize);
      }
    }
    expect(maxTiles).toBeLessThan(380);
    expect(maxView).toBeLessThan(250);
    expect(maxChurn).toBeLessThan(60); // new tiles per 0.25 s at 150 kt
  });

  it('morph ranges tile the distance axis between levels', () => {
    for (let s = P.minTileSize; s < P.rootSize; s *= 2) {
      const [, end] = morphRange(s, P.splitFactor);
      const [startParent] = morphRange(s * 2, P.splitFactor);
      expect(end).toBeLessThan(startParent);
    }
  });
});

describe('what you see is what you hit', () => {
  it('the finest mesh follows the physics ground within a few decimetres (unmorphed)', () => {
    const size = CONFIG.world.terrain.minTileSize;
    const r = CONFIG.world.terrain.chunkResolution;
    for (const [x0, z0] of [
      [2560, -512], // river country east of the airport
      [-4096, -12800], // foothills near the lake
      [6144, -19968], // the upper valley
    ]) {
      const c = buildChunk(hf, lc, { x0, z0, size, res: r });
      const step = size / r;
      let sum = 0;
      let n = 0;
      // compare the mesh (bilinear-ish via the triangle) against the analytic height at quad centres
      for (let j = 0; j < r; j += 3)
        for (let i = 0; i < r; i += 3) {
          const b = c.positions[(j * (r + 1) + i + 1) * 3 + 1];
          const cc = c.positions[((j + 1) * (r + 1) + i) * 3 + 1];
          const meshY = (b + cc) / 2; // centre of the anti-diagonal
          const trueY = terrainHeight(x0 + (i + 0.5) * step, z0 + (j + 0.5) * step);
          sum += Math.abs(meshY - trueY);
          n++;
        }
      expect(sum / n).toBeLessThan(0.35);
    }
  });

  it('a taxi from the runway to the apron stays on flat pavement', () => {
    const env = createEnvironment();
    const route = [
      ...Array.from({ length: 30 }, (_, i) => fromRunwayCoords(45 + i * 25, 0)), // roll north on the centreline
      ...Array.from({ length: 10 }, (_, i) => fromRunwayCoords(800, 5 + i * 10)), // exit via connector A2
      ...Array.from({ length: 10 }, (_, i) => fromRunwayCoords(800 - i * 10, 110)), // along taxiway A
      ...Array.from({ length: 8 }, (_, i) => fromRunwayCoords(760, 120 + i * 12)), // onto the apron
    ];
    for (const p of route) {
      expect(['runway', 'asphalt']).toContain(env.surfaceAt(p.x, p.z));
      expect(env.groundHeight(p.x, p.z)).toBe(CONFIG.world.airport.elevation);
      expect(env.waterLevel(p.x, p.z)).toBeNull();
    }
  });

  it('the river runs downhill in its channel with banks that hold it in the plains', () => {
    const river = L.rivers[0];
    for (let i = 0; i < river.points.length; i += 7) {
      const p = river.points[i];
      const lvl = river.levels[i];
      expect(terrainHeight(p.x, p.z)).toBeLessThan(lvl);
      if (-p.z < 6000 && p.z < L.coast.zAt(p.x) - 1500) {
        // 90 m to either side the ground is above the water
        const a = river.points[Math.max(0, i - 1)];
        const b = river.points[Math.min(river.points.length - 1, i + 1)];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const l = Math.hypot(dx, dz);
        for (const side of [-1, 1]) {
          const q = { x: p.x + (side * dz * 90) / l, z: p.z - (side * dx * 90) / l };
          expect(terrainHeight(q.x, q.z)).toBeGreaterThan(lvl);
        }
      }
    }
  });
});
