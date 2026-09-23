/**
 * Functional stress: several seeds × the busiest and the trickiest places
 * (Taterville's grid, Port Chateau, the coast highway bridge, the villages of
 * Millbrook and Eastfield with their acute junctions and dead ends), four
 * minutes each with the camera circling — no vehicle ever overlaps another,
 * every invariant holds, and gridlock releases stay rare.
 */
import { describe, it, expect } from 'vitest';
import { TrafficSim, type SimCamera } from '../../../src/world/cars/sim';
import { laneGraph } from './fixtures';
import { invariantErrors, footprints, collisions, newPose } from './support';

const g = laneGraph();
const SPOTS: [string, number, number][] = [
  ['Taterville', 2100, 2100],
  ['Port Chateau', -4700, 6541],
  ['coast bridge', 3237, 5685],
  ['Millbrook', -7400, -1600],
  ['Eastfield', 9200, -2800],
];

describe('traffic stress (functional)', () => {
  it('no collisions, no broken invariants, for several seeds in five places', { timeout: 300_000 }, () => {
    const problems: string[] = [];
    let stuck = 0;
    let spawned = 0;
    for (const seed of [3, 17, 29, 101]) {
      for (const [name, x0, z0] of SPOTS) {
        const sim = new TrafficSim(g, { seed });
        const cam: SimCamera = { x: x0, z: z0, fx: 0, fz: -1 };
        const pose = newPose();
        for (let k = 0; k < 20 * 240; k++) {
          cam.x = x0 + Math.cos(k * 0.001) * 400;
          cam.z = z0 + Math.sin(k * 0.001) * 400;
          sim.step(cam);
          if (k % 20 !== 0) continue;
          for (const e of invariantErrors(sim, g)) problems.push(`seed ${seed} ${name} t=${k / 20}: ${e}`);
          for (const [a, b, pen] of collisions(footprints(sim, pose), 0.12)) problems.push(`seed ${seed} ${name} t=${k / 20}: type ${sim.type[a.car]} × type ${sim.type[b.car]} overlap ${pen.toFixed(2)} m`);
        }
        stuck += sim.stuckReleased;
        spawned += sim.spawned;
      }
    }
    expect(problems.slice(0, 10)).toEqual([]);
    expect(stuck).toBeLessThan(spawned * 0.03);
  });
});
