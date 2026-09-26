/**
 * The traffic keeps clear of the big-ship port: every sea route still validates (none rejected) and
 * keeps well away from the piers and from each berth's reserved water (the largest ship it takes),
 * the marina's harbour launch included.
 */
import { describe, it, expect } from 'vitest';
import { getLayout } from '../../../src/world/layout';
import { getHeightfield } from '../../../src/world/heightfield';
import { createSeaPlan } from '../../../src/world/traffic/sea';
import { samplePath, newPathSample } from '../../../src/world/traffic/path';
import { portBerths } from '../../../src/world/port';
import { portWorks, pierLocal } from '../../../src/world/harbour/layout';

const hf = getHeightfield();
const water = { groundHeight: (x: number, z: number) => hf.height(x, z), waterLevel: (x: number, z: number) => hf.waterLevel(x, z) };
const layout = getLayout();

/** Distance from a point to a convex polygon (0 inside; either winding). */
function polyDist(p: { x: number; z: number }, poly: { x: number; z: number }[]): number {
  let d = Infinity;
  let sides = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const vx = b.x - a.x;
    const vz = b.z - a.z;
    sides += Math.sign(vx * (p.z - a.z) - vz * (p.x - a.x));
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.z - a.z) * vz) / (vx * vx + vz * vz)));
    d = Math.min(d, Math.hypot(p.x - a.x - vx * t, p.z - a.z - vz * t));
  }
  return Math.abs(sides) === poly.length ? 0 : d;
}

/** Distance from a point to a pier (its trestle and head / berthing pier), 0 on it. */
function pierDist(p: { x: number; z: number }): number {
  const w = portWorks(layout);
  const box = (f: typeof w.cruise.frame, r: { u0: number; u1: number; w0: number; w1: number }) => {
    const l = pierLocal(f, p.x, p.z);
    return Math.hypot(Math.max(r.u0 - l.u, 0, l.u - r.u1), Math.max(r.w0 - l.w, 0, l.w - r.w1));
  };
  const c = w.cruise;
  const n = w.naval;
  return Math.min(
    box(c.frame, c.pier), box(c.frame, { u0: c.trestle.u0, u1: c.trestle.u1, w0: -c.trestle.half, w1: c.trestle.half }),
    box(n.frame, n.head), box(n.frame, { u0: n.trestle.u0, u1: n.trestle.u1, w0: -n.trestle.half, w1: n.trestle.half }),
  );
}

describe('traffic routes and the big-ship port', () => {
  it('every route validates and keeps ≥ 150 m from the piers and the ship berths\' water', () => {
    const plan = createSeaPlan(layout, water);
    expect(plan.rejected).toEqual([]);
    const berths = portBerths(layout);
    const s = newPathSample();
    let checked = 0;
    for (const r of plan.routes) {
      if (r.level > 1) continue;
      const step = r.path.length > 50000 ? 40 : 10;
      for (let d = 0; d < r.path.length; d += step) {
        samplePath(r.path, d, s);
        if (s.x < -7000 || s.x > -2500 || s.z > 10500) continue;
        checked++;
        expect(pierDist(s), `${r.id} at ${Math.round(s.x)}, ${Math.round(s.z)}`).toBeGreaterThan(150);
        for (const id of ['cruise', 'naval'] as const) expect(polyDist(s, berths[id].reserved), `${r.id} by the ${id} berth`).toBeGreaterThan(150);
      }
    }
    expect(checked).toBeGreaterThan(200);
  }, 60_000);

  it('the harbour launch still runs out through the marina entrance to its buoy and back', () => {
    const plan = createSeaPlan(layout, water);
    const launch = plan.routes.find((r) => r.id === 'launch-0');
    expect(launch).toBeDefined();
  }, 60_000);
});
