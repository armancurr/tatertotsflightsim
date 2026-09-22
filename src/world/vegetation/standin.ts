/**
 * STAND-IN height and tree density for the vegetation tests and preview,
 * built on the real world layout (airport, roads, rivers, lakes, coast,
 * towns) so exclusions are realistic. After integration the orchestrator
 * passes the real `terrainHeight` and landcover `treeDensity` instead.
 * PURE (no three.js).
 */
import { CONFIG } from '../../config';
import { createSimplex2D, fbm } from '../noise';
import { getLayout, lakeSignedDistance, type WorldLayout } from '../layout';
import { PolylineIndex, newPolyQuery } from '../polyline';
import { toRunwayCoords } from '../runway';

export const GROUND = { FIELD: 0, FOREST: 1, WATER: 2, PAVED: 3, ROAD: 4, TOWN: 5, GRASS: 6 } as const;
export type GroundKind = (typeof GROUND)[keyof typeof GROUND];

export interface StandInWorld {
  heightAt(x: number, z: number): number;
  /** 0..1 tree density (0 = no trees). */
  densityAt(x: number, z: number): number;
  /** Coarse ground class for colouring the preview terrain. */
  groundAt(x: number, z: number): GroundKind;
}

const smooth = (e0: number, e1: number, x: number): number => {
  let t = (x - e0) / (e1 - e0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
};

export function createStandInWorld(seed: number = CONFIG.world.seed, layout: WorldLayout = getLayout()): StandInWorld {
  const nH = createSimplex2D(seed + 501);
  const nF = createSimplex2D(seed + 502);
  const nW = createSimplex2D(seed + 503);
  const ap = layout.airport;
  const rw = ap.runway;
  const roads = new PolylineIndex(
    layout.roads.map((r) => r.points),
    layout.roads.map((r) => r.points.map(() => [r.width * 0.5])),
    1,
    40,
    200,
  );
  const rivers = new PolylineIndex(
    layout.rivers.map((r) => r.points),
    layout.rivers.map((r) => r.halfWidths.map((h) => [h])),
    1,
    120,
    200,
  );
  const q = newPolyQuery(1);

  const airportMask = (x: number, z: number): number => {
    // 0 on the airfield (runway + approach zones + ramp), 1 well away from it.
    const c = toRunwayCoords(x, z, rw);
    const along = Math.max(0, Math.abs(c.along - rw.halfLength) - (rw.halfLength + 600)); // along is from the threshold
    const across = Math.max(0, Math.abs(c.across) - 380);
    const d = Math.hypot(along, across);
    return d <= 0 ? 0 : smooth(0, 250, d);
  };

  const heightAt = (x: number, z: number): number => {
    let h = 34 + 60 * fbm(nH, x / 5200, z / 5200, 4) + 12 * fbm(nH, x / 1100 + 40, z / 1100, 3);
    h = Math.max(h, 4);
    const r = Math.hypot(x - rw.center.x, z - rw.center.z);
    const t = smooth(ap.flatRadius, ap.flatRadius + ap.blendWidth, r);
    h = ap.elevation + (h - ap.elevation) * t;
    const s = layout.coast.zAt(x) - z; // metres inland
    if (s < 500) h = -6 + (h + 6) * smooth(-60, 500, s);
    return h;
  };

  const forestness = (x: number, z: number): number => {
    const wx = x + 500 * nW(x / 4000, z / 4000);
    const wz = z + 500 * nW(x / 4000 + 7.7, z / 4000);
    const f = fbm(nF, wx / 2600, wz / 2600, 4) + 0.35 * fbm(nF, x / 650 + 13, z / 650, 2) + 0.05;
    return smooth(0.02, 0.2, f);
  };

  const densityAt = (x: number, z: number): number => {
    if (!(Number.isFinite(x) && Number.isFinite(z))) return 0;
    if (z > layout.coast.zAt(x) - 30) return 0;
    let m = airportMask(x, z);
    if (m <= 0) return 0;
    for (const lake of layout.lakes) {
      const sd = lakeSignedDistance(lake, x, z);
      if (sd < 14) return 0;
    }
    if (rivers.query(x, z, q) && q.d < q.v[0] + 7) return 0;
    if (roads.query(x, z, q)) {
      if (q.d < q.v[0] + 6) return 0;
      m *= smooth(q.v[0] + 6, q.v[0] + 14, q.d) * 0.7 + 0.3;
    }
    for (const t of layout.towns) {
      const d = Math.hypot(x - t.x, z - t.z);
      if (d < t.radius * 1.15) m *= 0.12 + 0.25 * smooth(t.radius * 0.3, t.radius * 1.15, d);
    }
    const f = forestness(x, z);
    const d = (0.03 + 0.95 * f) * m;
    return d < 0 ? 0 : d > 1 ? 1 : d;
  };

  const groundAt = (x: number, z: number): GroundKind => {
    if (z > layout.coast.zAt(x) - 10) return GROUND.WATER;
    for (const lake of layout.lakes) if (lakeSignedDistance(lake, x, z) < 0) return GROUND.WATER;
    if (rivers.query(x, z, q) && q.d < q.v[0]) return GROUND.WATER;
    const c = toRunwayCoords(x, z, rw);
    if (Math.abs(c.along - rw.halfLength) <= rw.halfLength && Math.abs(c.across) <= rw.halfWidth) return GROUND.PAVED;
    for (const r of ap.pavedAreas) {
      const h = (r.headingDeg * Math.PI) / 180;
      const dx = x - r.center.x;
      const dz = z - r.center.z;
      const al = dx * Math.sin(h) - dz * Math.cos(h);
      const ac = dx * Math.cos(h) + dz * Math.sin(h);
      if (Math.abs(al) <= r.halfLength && Math.abs(ac) <= r.halfWidth) return GROUND.PAVED;
    }
    if (roads.query(x, z, q) && q.d < q.v[0]) return GROUND.ROAD;
    if (airportMask(x, z) < 1) return GROUND.GRASS;
    for (const t of layout.towns) if (Math.hypot(x - t.x, z - t.z) < t.radius * 0.8) return GROUND.TOWN;
    return densityAt(x, z) > 0.45 ? GROUND.FOREST : GROUND.FIELD;
  };

  return { heightAt, densityAt, groundAt };
}
