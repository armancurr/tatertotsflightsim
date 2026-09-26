/** Shared helpers for the offshore scenery tests. */
import type { SeaPlan } from '../../../src/world/traffic/sea';

/** Every route's path points (x, z), ~5–20 m apart. */
export function routePoints(plan: SeaPlan): Float64Array {
  const out: number[] = [];
  for (const r of plan.routes) for (let i = 0; i < r.path.n; i++) out.push(r.path.x[i], r.path.z[i]);
  return Float64Array.from(out);
}

/** Distance from (x, z) to the nearest route point. */
export function minDistance(pts: Float64Array, x: number, z: number): number {
  let m = Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    const d = (pts[i] - x) ** 2 + (pts[i + 1] - z) ** 2;
    if (d < m) m = d;
  }
  return Math.sqrt(m);
}
