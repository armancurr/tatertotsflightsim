/**
 * Hulls against the offshore scenery (pure physics, the Princess V50's hull model): an inflatable
 * race buoy is a SOFT obstacle — driven into at speed, the boat bumps off it and slows, nothing
 * crashes (a hard obstacle of the same size holes the hull); the platform is a hard wall for a boat
 * (a collision, never "aground" on the helideck 50 m up); a turbine tower too.
 */
import { describe, it, expect } from 'vitest';
import { createVesselState } from '../../../src/physics';
import type { Environment } from '../../../src/types';
import { createEnvironment } from '../../../src/world/environment';
import { createPlatformPhysics, platformFrame, PLATFORM } from '../../../src/world/offshore/platform';
import { localToWorld } from '../../../src/world/offshore/sites';
import { createWindFarmPhysics, windFarmLayout } from '../../../src/world/offshore/windFarm';
import { createBuoyObstacles } from '../../../src/world/offshore/raceModel';
import { raceCourse } from '../../../src/world/offshore/raceCourse';
import { DEEP_SEA, V50_CALM, drive, knots } from '../../physics/v50-helpers';

const buoy = (x0: number, z0: number, r: number) => (x: number, z: number) => ((x - x0) ** 2 + (z - z0) ** 2 <= r * r ? 3.4 : -Infinity);

describe('soft race buoys', () => {
  it('a V50 at 25 kt straight into a buoy bumps it and carries on slower — no crash; the same buoy made hard holes the hull', () => {
    const soft: Environment = { ...DEEP_SEA, softObstacleTop: buoy(0, -60, 1.0) };
    const s0 = createVesselState(soft, V50_CALM, { x: 0, z: 0, headingDeg: 0, speedKt: 25 }).state;
    let minSpeed = Infinity;
    let touched = false;
    const s = drive(s0, 8, () => ({ throttle: 0.75 }), soft, V50_CALM, (_t, x) => {
      minSpeed = Math.min(minSpeed, knots(x));
      if (x.vessel?.touching) touched = true;
    });
    expect(touched).toBe(true);
    expect(s.crash).toBeNull();
    expect(minSpeed).toBeLessThan(24);
    expect(knots(s)).toBeGreaterThan(5);
    const hard: Environment = { ...DEEP_SEA, obstacleTop: buoy(0, -60, 1.0) };
    const h = drive(createVesselState(hard, V50_CALM, { x: 0, z: 0, headingDeg: 0, speedKt: 25 }).state, 8, () => ({ throttle: 0.75 }), hard, V50_CALM);
    expect(h.crash?.reason).toMatch(/Collision/);
  });

  it('the course’s buoy lookup: solid at every buoy and arch float, open water between them', () => {
    const c = raceCourse();
    const f = createBuoyObstacles(c);
    for (const m of c.marks.slice(1)) expect(f(m.x, m.z)).toBeGreaterThan(2);
    const g = c.marks[0];
    expect(f(g.x, g.z)).toBe(-Infinity); // the gate's middle is open
    expect(f(g.x + g.dz * 12, g.z - g.dx * 12)).toBeGreaterThan(0); // a float at the arch's foot
    for (const p of c.line) expect(f(p.x, p.z)).toBe(-Infinity); // the racing line is clear
    expect(f(0, 0)).toBe(-Infinity);
  });
});

describe('hard offshore structures', () => {
  const env = createEnvironment();
  const phys = createPlatformPhysics();
  env.registerObstacleSource((x, z) => phys.obstacleTop(x, z));
  env.registerDeckSource((x, z) => phys.helideckTop(x, z));
  const farm = createWindFarmPhysics(215);
  env.registerObstacleSource((x, z) => farm.obstacleTop(x, z));

  it('driving into the platform (under the helideck) is a collision, never "aground" on the deck', () => {
    const F = platformFrame();
    // start 150 m out on the quarters' (upwind) side, heading straight at the helideck
    const hd = PLATFORM.helideck;
    const start = localToWorld(F, hd.cx - 150, hd.cz, { x: 0, z: 0 });
    const hdg = F.headingDeg; // local +X
    const s = drive(createVesselState(env, V50_CALM, { x: start.x, z: start.z, headingDeg: hdg, speedKt: 22 }).state, 20, () => ({ throttle: 0.7 }), env, V50_CALM);
    expect(s.crash?.reason).toMatch(/Collision/);
  });

  it('a turbine tower is solid for a boat', () => {
    const t = windFarmLayout().turbines[0];
    const s = drive(createVesselState(env, V50_CALM, { x: t.x, z: t.z + 120, headingDeg: 0, speedKt: 22 }).state, 15, () => ({ throttle: 0.7 }), env, V50_CALM);
    expect(s.crash?.reason).toMatch(/Collision/);
  });
});
