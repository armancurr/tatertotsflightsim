/**
 * Where things may be built: water (sea, lakes, river) and the airport
 * (plateau + approach corridors) as fast clearance queries shared by the
 * street generator, the farmstead planner and the building placement. PURE.
 */
import type { WorldLayout } from '../layout';
import { lakeSignedDistance } from '../layout';
import { toRunwayCoords } from '../runway';
import { SegmentGrid, type Rect } from './geom';

export interface Constraints {
  /**
   * Approximate distance to the nearest water edge, m (negative = in the water):
   * the minimum of the coast distance, the lakes' signed distances and the
   * river's distance beyond its half width. Exact below 400 m; otherwise some value ≥ 400.
   */
  waterClearance(x: number, z: number): number;
  /** Smallest water clearance of a footprint (exact vs the river, sampled vs coast/lakes). */
  rectWaterClearance(r: Rect): number;
  /** True inside the airport plateau (grown by margin) or its approach corridors. */
  inAirport(x: number, z: number, margin: number): boolean;
  /** True if any corner/edge sample of the footprint is inAirport. */
  rectInAirport(r: Rect, margin: number): boolean;
  /** The river channel as segments (half width per segment). */
  readonly river: SegmentGrid;
}

/** Approach corridor length beyond each runway end, m, and its splay. */
const CORRIDOR = 4000;
const CORRIDOR_HALF = 160;
const CORRIDOR_SPLAY = 0.12;

export function createConstraints(layout: WorldLayout): Constraints {
  const river = new SegmentGrid(160);
  for (const r of layout.rivers)
    for (let i = 1; i < r.points.length; i++)
      river.add(r.points[i - 1].x, r.points[i - 1].z, r.points[i].x, r.points[i].z, Math.max(r.halfWidths[i - 1], r.halfWidths[i]), 0);
  river.build();
  const lakes = layout.lakes;
  const coastZ = layout.coast.zAt;
  const ap = layout.airport;
  const rw = ap.runway;
  const acx = rw.center.x;
  const acz = rw.center.z;

  const waterClearance = (x: number, z: number): number => {
    let c = coastZ(x) - z;
    for (let i = 0; i < lakes.length; i++) {
      const l = lakes[i];
      // cheap reject before the polar distance
      const rr = Math.max(l.radiusX, l.radiusZ) * 1.6 + 500;
      if (Math.abs(x - l.center.x) > rr || Math.abs(z - l.center.z) > rr) continue;
      const d = lakeSignedDistance(l, x, z);
      if (d < c) c = d;
    }
    const rc = river.pointClearance(x, z, 400);
    return rc < c ? rc : c;
  };

  const inAirport = (x: number, z: number, margin: number): boolean => {
    if (Math.hypot(x - acx, z - acz) < ap.flatRadius + margin) return true;
    const c = toRunwayCoords(x, z, rw);
    let beyond = 0;
    if (c.along < 0) beyond = -c.along;
    else if (c.along > rw.length) beyond = c.along - rw.length;
    else return Math.abs(c.across) < CORRIDOR_HALF + margin;
    if (beyond > CORRIDOR + margin) return false;
    return Math.abs(c.across) < CORRIDOR_HALF + CORRIDOR_SPLAY * beyond + margin;
  };

  const samples = (r: Rect, fn: (x: number, z: number) => void): void => {
    const nu = Math.max(1, Math.ceil((2 * r.hw) / 12));
    const nv = Math.max(1, Math.ceil((2 * r.hd) / 12));
    for (let i = 0; i <= nu; i++)
      for (let j = 0; j <= nv; j++) {
        if (i > 0 && i < nu && j > 0 && j < nv) continue; // perimeter only
        const u = -r.hw + (2 * r.hw * i) / nu;
        const v = -r.hd + (2 * r.hd * j) / nv;
        fn(r.x + r.ax * u + r.fx * v, r.z + r.az * u + r.fz * v);
      }
  };

  return {
    river,
    waterClearance,
    rectWaterClearance(r: Rect): number {
      let c = river.clearance(r, 60);
      samples(r, (x, z) => {
        let w = coastZ(x) - z;
        for (let i = 0; i < lakes.length; i++) {
          const d = lakeSignedDistance(lakes[i], x, z);
          if (d < w) w = d;
        }
        if (w < c) c = w;
      });
      return c;
    },
    inAirport,
    rectInAirport(r: Rect, margin: number): boolean {
      let hit = false;
      samples(r, (x, z) => {
        if (!hit && inAirport(x, z, margin)) hit = true;
      });
      return hit;
    },
  };
}
