/**
 * The full ground the range planner reads, built from the pure world (heightfield, landcover,
 * vegetation placement, road network) — the same data the terrain, trees, roads and farms are
 * drawn from. Used in the layout worker and in node tests (in the browser's main thread the
 * physics environment is used instead, see ground.ts `groundFromEnv`).
 *
 * Keep-out raster around the site: farm yards and towns (2 = never), roads and a strip beside
 * them where roadside houses stand (1 = may be crossed by the track, never parked on).
 */
import { CONFIG } from '../../config';
import { createEnvironment } from '../../world/environment';
import { getLayout } from '../../world/layout';
import { terrainHeight } from '../../world/heightfield';
import { getRoadNetwork } from '../../world/roads/network';
import { createObstacleField } from '../../world/vegetation/obstacles';
import { createRealVegWorld } from '../../world/vegetation/world';
import type { RangeGround } from './ground';

export interface RangeGroundOptions {
  /** Half-size of the keep-out raster around the site, m. */
  halfSize?: number;
  /** Raster cell, m. */
  cell?: number;
}

export function createRangeGround(site: { x: number; z: number }, opts: RangeGroundOptions = {}): RangeGround {
  const cfg = CONFIG.combat.range;
  const env = createEnvironment();
  const vw = createRealVegWorld();
  const trees = createObstacleField({ densityAt: vw.densityAt, heightAt: vw.heightAt, world: vw, cacheCells: 4096 });
  const layout = getLayout();
  const net = getRoadNetwork(layout, terrainHeight);

  const H = opts.halfSize ?? 1300;
  const cell = opts.cell ?? cfg.ground.cell;
  const N = Math.ceil((2 * H) / cell);
  const x0 = site.x - H;
  const z0 = site.z - H;
  const ras = new Uint8Array(N * N);
  const mark = (x: number, z: number, r: number, v: number) => {
    const i0 = Math.max(0, Math.floor((x - r - x0) / cell));
    const i1 = Math.min(N - 1, Math.ceil((x + r - x0) / cell));
    const j0 = Math.max(0, Math.floor((z - r - z0) / cell));
    const j1 = Math.min(N - 1, Math.ceil((z + r - z0) / cell));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const cx = x0 + (i + 0.5) * cell;
        const cz = z0 + (j + 0.5) * cell;
        if (Math.hypot(cx - x, cz - z) <= r && ras[j * N + i] < v) ras[j * N + i] = v;
      }
  };
  const inWindow = (x: number, z: number, pad: number) => x > x0 - pad && x < x0 + 2 * H + pad && z > z0 - pad && z < z0 + 2 * H + pad;
  for (const t of layout.towns) if (inWindow(t.x, t.z, t.radius + 200)) mark(t.x, t.z, t.radius + 150, 2);
  for (const f of net.farms) if (inWindow(f.x, f.z, cfg.ground.farmClearance)) mark(f.x, f.z, cfg.ground.farmClearance, 2);
  for (const r of net.roads) {
    const w = r.width / 2 + (r.kind === 'drive' ? cfg.ground.roadClearance : 30);
    for (let k = 0; k < r.points.length - 1; k++) {
      const a = r.points[k];
      const b = r.points[k + 1];
      if (!inWindow(a.x, a.z, 60) && !inWindow(b.x, b.z, 60)) continue;
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      const n = Math.max(1, Math.ceil(L / (cell * 0.75)));
      for (let q = 0; q <= n; q++) mark(a.x + ((b.x - a.x) * q) / n, a.z + ((b.z - a.z) * q) / n, w, 1);
    }
  }
  const keepOut = (x: number, z: number): number => {
    const i = Math.floor((x - x0) / cell);
    const j = Math.floor((z - z0) / cell);
    if (i < 0 || j < 0 || i >= N || j >= N) return 0;
    return ras[j * N + i];
  };
  return {
    height: (x, z) => env.groundHeight(x, z),
    normal: (x, z) => env.groundNormal(x, z),
    surface: (x, z) => env.surfaceAt(x, z),
    water: (x, z) => env.waterLevel(x, z),
    obstacle: (x, z) => trees.top(x, z),
    keepOut,
  };
}
