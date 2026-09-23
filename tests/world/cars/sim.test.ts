import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { TrafficSim, type SimCamera } from '../../../src/world/cars/sim';
import { KIND } from '../../../src/world/cars/lanes';
import { SPECS, VT } from '../../../src/world/cars/specs';
import { cloneConfig } from '../../../src/config';
import { laneGraph } from './fixtures';
import { checkInvariants, footprints, collisions, newPose } from './support';

const g = laneGraph();
const TATERVILLE: SimCamera = { x: 2100, z: 2100, fx: 0, fz: -1 };

const quietCfg = () => {
  const c = cloneConfig().world.cars;
  c.density = { highway: 0, road: 0, access: 0, lane: 0, street: 0, drive: 0 };
  c.tractors = 0;
  return c;
};

/** A long lane of the given kind near a point, with an exit that leads on. */
function findLane(kind: number, minLen: number, near: { x: number; z: number }): number {
  let best = -1;
  let bd = Infinity;
  for (let p = 0; p < g.pieceCount; p++) {
    if (g.pKind[p] !== kind || g.pLen[p] < minLen) continue;
    const a = g.pStart[p];
    const d = Math.hypot(g.px[a] - near.x, g.pz[a] - near.z);
    if (d < bd) {
      bd = d;
      best = p * 2;
    }
  }
  return best;
}

describe('traffic simulation', { timeout: 120_000 }, () => {
  it('fills the roads around the camera on its first step, inside the radius', () => {
    const sim = new TrafficSim(g);
    sim.step(TATERVILLE);
    expect(sim.count).toBeGreaterThan(40);
    const pose = newPose();
    for (let i = 0; i < sim.cap; i++) {
      if (!sim.alive[i]) continue;
      sim.pose(i, 0, pose);
      expect(Math.hypot(pose.x - TATERVILLE.x, pose.z - TATERVILLE.z)).toBeLessThan(sim.cfg.radius + 30);
    }
    checkInvariants(sim, g);
  });

  it('is deterministic for a seed and a camera path; another seed differs', () => {
    const run = (seed: number) => {
      const sim = new TrafficSim(g, { seed });
      const cam = { ...TATERVILLE };
      for (let k = 0; k < 400; k++) {
        cam.x += 1.5;
        sim.step(cam);
      }
      const out: number[] = [];
      for (let i = 0; i < sim.cap; i++) if (sim.alive[i]) out.push(sim.type[i], sim.lane[i], sim.conn[i], Math.round(sim.u[i] * 1000), Math.round(sim.v[i] * 1000), sim.paint[i]);
      return out;
    };
    const a = run(11);
    expect(run(11)).toEqual(a);
    expect(run(12)).not.toEqual(a);
  });

  it('a lone car accelerates to about its desired speed and never exceeds what the road allows', () => {
    const sim = new TrafficSim(g, { cfg: quietCfg() });
    const lane = findLane(KIND.highway, 1500, { x: 3237, z: 5685 });
    expect(lane).toBeGreaterThanOrEqual(0);
    const pose = newPose();
    const i = sim.place(VT.sedan, lane, g.laneEntryU[lane] + 5, 0);
    sim.pose(i, 0, pose);
    const cam = { x: pose.x, z: pose.z, fx: 0, fz: 0 };
    let vMax = 0;
    for (let k = 0; k < 30 * 40 && sim.alive[i] && sim.lane[i] === lane; k++) {
      const allowed = g.allowedSpeed(lane, sim.u[i]) * sim.desire[i];
      expect(sim.v[i]).toBeLessThanOrEqual(allowed + 0.35);
      vMax = Math.max(vMax, sim.v[i]);
      sim.pose(i, 0, pose);
      cam.x = pose.x;
      cam.z = pose.z;
      sim.step(cam);
    }
    expect(vMax).toBeGreaterThan(15);
  });

  it('keeps a safe gap behind a slow tractor and settles at its speed', () => {
    const sim = new TrafficSim(g, { cfg: quietCfg() });
    const lane = findLane(KIND.road, 900, { x: 0, z: 0 });
    const u0 = g.laneEntryU[lane] + 10;
    const lead = sim.place(VT.tractor, lane, u0 + 120, 6);
    const car = sim.place(VT.sedan, lane, u0, 20);
    const pose = newPose();
    sim.pose(car, 0, pose);
    const cam = { x: pose.x, z: pose.z, fx: 0, fz: 0 };
    let minGap = Infinity;
    for (let k = 0; k < 30 * 25; k++) {
      sim.step(cam);
      if (sim.lane[car] !== lane || sim.lane[lead] !== lane) break;
      const gap = sim.u[lead] - sim.u[car] - (SPECS[VT.tractor].length + SPECS[VT.sedan].length) / 2;
      minGap = Math.min(minGap, gap);
    }
    expect(minGap).toBeGreaterThan(1.5);
    expect(Math.abs(sim.v[car] - sim.v[lead])).toBeLessThan(1.5);
  });

  it('stops at a town stop sign before entering the junction', () => {
    // a lane whose exits are all stop-controlled
    let lane = -1;
    for (let l = 0; l < g.laneCount && lane < 0; l++) {
      if (g.pTown[l >> 1] !== 0 || g.laneLen[l] < 90 || g.laneConnCount[l] === 0) continue;
      let all = true;
      for (let k = 0; k < g.laneConnCount[l]; k++) if (g.connectors[g.laneConn[g.laneConnStart[l] + k]].stop !== 2) all = false;
      if (all) lane = l;
    }
    expect(lane).toBeGreaterThanOrEqual(0);
    const sim = new TrafficSim(g, { cfg: quietCfg() });
    const i = sim.place(VT.sedan, lane, g.laneExitU[lane] - 60, 10);
    const pose = newPose();
    sim.pose(i, 0, pose);
    const cam = { x: pose.x, z: pose.z, fx: 0, fz: 0 };
    let vMin = Infinity;
    let entered = false;
    for (let k = 0; k < 30 * 30 && !entered; k++) {
      sim.step(cam);
      if (sim.conn[i] >= 0) entered = true;
      else vMin = Math.min(vMin, sim.v[i]);
    }
    expect(entered).toBe(true);
    expect(vMin).toBeLessThan(0.3);
  });

  it('never holds more vehicles than its pool', () => {
    const cfg = cloneConfig().world.cars;
    cfg.maxMoving = 12;
    const sim = new TrafficSim(g, { cfg });
    for (let k = 0; k < 200; k++) {
      sim.step(TATERVILLE);
      expect(sim.count).toBeLessThanOrEqual(12);
    }
    expect(sim.count).toBe(12);
  });

  it('releases every vehicle when the camera leaves, and fills the new place', () => {
    const sim = new TrafficSim(g);
    for (let k = 0; k < 60; k++) sim.step(TATERVILLE);
    const far: SimCamera = { x: -4700, z: 6400, fx: 1, fz: 0 };
    sim.step(far);
    const pose = newPose();
    for (let i = 0; i < sim.cap; i++) {
      if (!sim.alive[i]) continue;
      sim.pose(i, 0, pose);
      expect(Math.hypot(pose.x - far.x, pose.z - far.z)).toBeLessThan(sim.cfg.despawnRadius + 30);
    }
    expect(sim.count).toBeGreaterThan(40);
    checkInvariants(sim, g);
  });

  it('property: random seeds and camera paths keep every invariant', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1e6 }),
        fc.array(fc.record({ dx: fc.double({ min: -60, max: 60, noNaN: true }), dz: fc.double({ min: -60, max: 60, noNaN: true }), steps: fc.integer({ min: 1, max: 40 }) }), { minLength: 1, maxLength: 8 }),
        fc.constantFrom({ x: 2100, z: 2100 }, { x: 3237, z: 5685 }, { x: -4700, z: 6541 }, { x: 800, z: -3000 }),
        (seed, moves, start) => {
          const sim = new TrafficSim(g, { seed });
          const cam: SimCamera = { x: start.x, z: start.z, fx: 0, fz: -1 };
          for (const m of moves) {
            const l = Math.hypot(m.dx, m.dz) || 1;
            cam.fx = m.dx / l;
            cam.fz = m.dz / l;
            for (let k = 0; k < m.steps; k++) {
              cam.x += m.dx / 30;
              cam.z += m.dz / 30;
              sim.step(cam);
            }
            checkInvariants(sim, g);
          }
          const hits = collisions(footprints(sim, newPose()), 0.15);
          expect(hits.map(([a, b, p]) => `${sim.type[a.car]}#${a.car} (lane ${sim.lane[a.car]} conn ${sim.conn[a.car]}) × ${sim.type[b.car]}#${b.car} (lane ${sim.lane[b.car]} conn ${sim.conn[b.car]}) pen ${p.toFixed(2)} at ${a.x.toFixed(0)},${a.z.toFixed(0)}`)).toEqual([]);
        },
      ),
      { numRuns: 25 },
    );
  });
});
