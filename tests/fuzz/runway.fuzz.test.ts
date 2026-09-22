/**
 * Property tests for src/world/runway.ts: runway coordinates for the real config
 * and for arbitrary runway placements/headings.
 */
import { describe, it } from 'vitest';
import fc from 'fast-check';
import { CONFIG, type Config } from '../../src/config';
import { fromRunwayCoords, isOnRunway, runwayFrame, toRunwayCoords, type RunwayFrame } from '../../src/world/runway';
import { wrap180 } from '../../src/math/vec3';
import { fcParams } from '../support/fc';
import { num } from '../support/arbitraries';

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

const randomRunway: fc.Arbitrary<RunwayFrame> = fc
  .record({ cx: num(-5e4, 5e4), cz: num(-5e4, 5e4), heading: num(0, 360), length: num(300, 4000), width: num(10, 60) })
  .map(({ cx, cz, heading, length, width }) => {
    // runwayFrame only reads world.airport — a partial config keeps the property cheap.
    const airport = { ...CONFIG.world.airport, runway: { ...CONFIG.world.airport.runway, center: { x: cx, z: cz }, headingDeg: heading, length, width } };
    return runwayFrame({ world: { airport } } as unknown as Config);
  });

const anyRunway = fc.oneof(fc.constant(runwayFrame()), randomRunway);

describe('runway frame', () => {
  it('dir and right are orthonormal, right is 90° clockwise of dir, ends are `length` apart', () => {
    fc.assert(fc.property(anyRunway, (rw) => {
      const D = 180 / Math.PI;
      const dirHdg = Math.atan2(rw.dir.x, -rw.dir.z) * D;
      const rightHdg = Math.atan2(rw.right.x, -rw.right.z) * D;
      return near(Math.hypot(rw.dir.x, rw.dir.z), 1, 1e-12)
        && near(Math.hypot(rw.right.x, rw.right.z), 1, 1e-12)
        && near(rw.dir.x * rw.right.x + rw.dir.z * rw.right.z, 0, 1e-12)
        && near(wrap180(dirHdg - rw.headingDeg), 0, 1e-9)
        && near(wrap180(rightHdg - dirHdg - 90), 0, 1e-9)
        && near(Math.hypot(rw.farEnd.x - rw.threshold.x, rw.farEnd.z - rw.threshold.z), rw.length, 1e-6);
    }), fcParams(500));
  });

  it('to/from runway coordinates round-trip (world → runway → world and back)', () => {
    fc.assert(fc.property(anyRunway, num(-2e4, 2e4), num(-2e4, 2e4), (rw, a, b) => {
      const w = fromRunwayCoords(a, b, rw);
      const c = toRunwayCoords(w.x, w.z, rw);
      const w2 = fromRunwayCoords(c.along, c.across, rw);
      const tol = 1e-7 * Math.max(1, Math.abs(a) + Math.abs(b) + Math.abs(rw.center.x) + Math.abs(rw.center.z));
      return near(c.along, a, tol) && near(c.across, b, tol) && near(w2.x, w.x, tol) && near(w2.z, w.z, tol);
    }), fcParams(1000));
  });

  it('threshold is along 0, far end is along = length, centre is along = length/2, all on the centreline', () => {
    fc.assert(fc.property(anyRunway, (rw) => {
      const t = toRunwayCoords(rw.threshold.x, rw.threshold.z, rw);
      const f = toRunwayCoords(rw.farEnd.x, rw.farEnd.z, rw);
      const c = toRunwayCoords(rw.center.x, rw.center.z, rw);
      const tol = 1e-6;
      return near(t.along, 0, tol) && near(f.along, rw.length, tol) && near(c.along, rw.halfLength, tol)
        && near(t.across, 0, tol) && near(f.across, 0, tol) && near(c.across, 0, tol);
    }), fcParams(300));
  });

  it('isOnRunway agrees with the runway coordinates (away from the edges)', () => {
    const margin = 1e-3;
    fc.assert(fc.property(anyRunway, num(-600, 4600), num(-100, 100), (rw, along, across) => {
      fc.pre(Math.abs(along) > margin && Math.abs(along - rw.length) > margin && Math.abs(Math.abs(across) - rw.halfWidth) > margin);
      const p = fromRunwayCoords(along, across, rw);
      const inside = along >= 0 && along <= rw.length && Math.abs(across) <= rw.halfWidth;
      return isOnRunway(p.x, p.z, rw) === inside;
    }), fcParams(1000));
  });
});
