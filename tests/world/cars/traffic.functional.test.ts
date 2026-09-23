/**
 * Functional: ten minutes of traffic on the real road network, headless, with
 * the camera hovering over Taterville, flying to the coast highway bridge,
 * hovering there, then crossing to Port Chateau. Every second: the invariants
 * and a collision check of every vehicle's footprint (body + trailer).
 */
import { describe, it, expect } from 'vitest';
import { TrafficSim, type SimCamera } from '../../../src/world/cars/sim';
import { SPECS, VT } from '../../../src/world/cars/specs';
import { laneGraph } from './fixtures';
import { invariantErrors, footprints, collisions, newPose } from './support';

const g = laneGraph();

/** Camera path (x, z) at time t (s). */
function camAt(t: number, out: SimCamera): void {
  const legs: [number, number, number][] = [
    [0, 2100, 2100],
    [180, 2100, 2100],
    [250, 3237, 5685],
    [420, 3237, 5685],
    [520, -4700, 6541],
    [600, -4700, 6541],
  ];
  let k = 0;
  while (k < legs.length - 2 && t > legs[k + 1][0]) k++;
  const [t0, x0, z0] = legs[k];
  const [t1, x1, z1] = legs[k + 1];
  const f = Math.max(0, Math.min(1, (t - t0) / (t1 - t0)));
  // hover: a slow 300 m circle
  const hx = Math.cos(t * 0.02) * 300;
  const hz = Math.sin(t * 0.02) * 300;
  const nx = x0 + (x1 - x0) * f + hx;
  const nz = z0 + (z1 - z0) * f + hz;
  const dx = nx - out.x;
  const dz = nz - out.z;
  const l = Math.hypot(dx, dz);
  if (l > 1e-6) {
    out.fx = dx / l;
    out.fz = dz / l;
  }
  out.x = nx;
  out.z = nz;
}

describe('ten minutes of traffic (functional)', () => {
  it('flows without collisions, spacing violations, NaN or leaks', { timeout: 300_000 }, () => {
    const sim = new TrafficSim(g);
    const cam: SimCamera = { x: 2100, z: 2100, fx: 0, fz: -1 };
    const pose = newPose();
    const steps = Math.round(600 / sim.cfg.step);
    const errors: string[] = [];
    const hits: string[] = [];
    let carSeconds = 0;
    let movingSum = 0;
    let maxCount = 0;
    const typesSeen = new Set<number>();
    const t0 = performance.now();
    for (let k = 0; k < steps; k++) {
      camAt(k * sim.cfg.step, cam);
      sim.step(cam);
      maxCount = Math.max(maxCount, sim.count);
      carSeconds += sim.count * sim.cfg.step;
      for (let i = 0; i < sim.cap; i++) if (sim.alive[i]) movingSum += sim.v[i] * sim.cfg.step;
      if (k % 30 === 0) {
        for (const e of invariantErrors(sim, g)) if (errors.length < 20) errors.push(`t=${(k * sim.cfg.step).toFixed(1)} ${e}`);
        for (let i = 0; i < sim.cap; i++) if (sim.alive[i]) typesSeen.add(sim.type[i]);
      }
      if (k % 15 === 0) {
        for (const [a, b, pen] of collisions(footprints(sim, pose), 0.12)) {
          if (hits.length < 20)
            hits.push(
              `t=${(k * sim.cfg.step).toFixed(1)} ${SPECS[sim.type[a.car]] ? sim.type[a.car] : '?'}#${a.car} (lane ${sim.lane[a.car]} conn ${sim.conn[a.car]}) × ${sim.type[b.car]}#${b.car} (lane ${sim.lane[b.car]} conn ${sim.conn[b.car]}) pen ${pen.toFixed(2)} at ${a.x.toFixed(0)},${a.z.toFixed(0)}`,
            );
        }
      }
    }
    const ms = performance.now() - t0;
    const st = sim.stats();
    console.log(`[cars] 10 min: ${(ms / steps).toFixed(3)} ms/step, max ${maxCount} vehicles, mean speed ${(movingSum / carSeconds).toFixed(1)} m/s, ${JSON.stringify(st)}`);
    expect(errors).toEqual([]);
    expect(hits).toEqual([]);
    // traffic actually flows: vehicles move, pass junctions, few gridlock releases
    expect(movingSum / carSeconds).toBeGreaterThan(6);
    expect(st.junctions).toBeGreaterThan(2000);
    expect(st.stuckReleased).toBeLessThan(st.spawned * 0.02 + 3);
    expect(maxCount).toBeLessThanOrEqual(sim.cap);
    for (const t of [VT.sedan, VT.hatch, VT.suv, VT.pickup, VT.van, VT.box, VT.semi, VT.bus, VT.tractor]) expect(typesSeen.has(t)).toBe(true);
    // no leaks: leave the land entirely → everything is released, no junction stays held
    const sea: SimCamera = { x: 0, z: 40000, fx: 0, fz: 1 };
    sim.step(sea);
    expect(sim.count).toBe(0);
    for (const c of g.connectors) expect(sim.occupancy(c.id)).toBe(0);
    // CPU: well under the per-frame budget at 30 steps/s
    expect(ms / steps).toBeLessThan(1.5);
  });
});
