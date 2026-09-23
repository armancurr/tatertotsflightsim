import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { findRangeSite } from '../../../src/combat/targets/site';
import { footprintOk, headingOf, headingDiff, openAt, slopeDeg } from '../../../src/combat/targets/ground';
import { CONFIG } from '../../../src/config';
import { fakeGround } from './support';

const R = CONFIG.combat.range;
const bearingOf = (x: number, z: number) => ((Math.atan2(x, -z) * 180) / Math.PI + 360) % 360;

describe('range ground predicates', () => {
  it('open ground: field/grass/dirt, dry, not too steep', () => {
    const g = fakeGround();
    expect(openAt(g, 0, 0)).toBe(true);
    expect(openAt(fakeGround({ surface: () => 'forest' }), 0, 0)).toBe(false);
    expect(openAt(fakeGround({ surface: () => 'urban' }), 0, 0)).toBe(false);
    expect(openAt(fakeGround({ water: () => 3 }), 0, 0)).toBe(false);
    const steep = fakeGround({ height: (x) => x * Math.tan((R.ground.maxSlopeDeg + 2) * Math.PI / 180) });
    expect(openAt(steep, 0, 0)).toBe(false);
    const gentle = fakeGround({ height: (x) => x * Math.tan((R.ground.maxSlopeDeg - 2) * Math.PI / 180) });
    expect(openAt(gentle, 0, 0)).toBe(true);
    expect(slopeDeg({ x: 0, y: 1, z: 0 })).toBeCloseTo(0, 9);
  });

  it('a footprint is rejected when a tree crown or keep-out zone reaches it (with clearance)', () => {
    const tree = fakeGround({ obstacle: (x, z) => (Math.hypot(x - 5, z) < 0.8 ? 60 : -Infinity) });
    // hull 7 × 3.6 at the origin facing north: the tree 5 m to the east is 3.2 m from the side
    expect(footprintOk(tree, 0, 0, 0, 7, 3.6, 1)).toBe(true);
    expect(footprintOk(tree, 0, 0, 0, 7, 3.6, 3)).toBe(false);
    // turned east, the hull reaches 3.5 m → the tree at 4 m (edge) is inside the clearance
    expect(footprintOk(tree, 0, 0, 90, 7, 3.6, 1)).toBe(false);
    const road = fakeGround({ keepOut: (x) => (Math.abs(x) < 3 ? 1 : 0) });
    expect(footprintOk(road, 0, 0, 0, 7, 3.6, 1)).toBe(false);
    expect(footprintOk(road, 0, 0, 0, 7, 3.6, 1, R, true)).toBe(true);
  });

  it('headings: clockwise from north, differences wrap', () => {
    expect(headingOf(0, -1)).toBeCloseTo(0);
    expect(headingOf(1, 0)).toBeCloseTo(90);
    expect(headingOf(0, 1)).toBeCloseTo(180);
    expect(headingOf(-1, 0)).toBeCloseTo(270);
    expect(headingDiff(10, 350)).toBeCloseTo(20);
    expect(headingDiff(350, 10)).toBeCloseTo(-20);
    fc.assert(fc.property(fc.double({ min: -1e4, max: 1e4, noNaN: true }), fc.double({ min: -1e4, max: 1e4, noNaN: true }), (a, b) => {
      const d = headingDiff(a, b);
      return d > -180 - 1e-9 && d <= 180 + 1e-9;
    }));
  });
});

describe('range site search', () => {
  it('on uniformly open ground it takes the preferred bearing at the minimum distance', () => {
    const s = findRangeSite(fakeGround());
    expect(Math.abs(headingDiff(s.bearingDeg, R.bearingDeg))).toBeLessThan(1);
    expect(s.distance).toBeGreaterThanOrEqual(R.minDistance - 1);
    expect(s.distance).toBeLessThan(R.minDistance + R.search.distanceStep + 1);
    expect(s.open).toBeCloseTo(1, 6);
    expect(Math.abs(headingDiff(s.headingDeg, bearingOf(s.x, s.z)))).toBeLessThan(1e-6);
  });

  it('moves to the open patch when the preferred bearing is forest', () => {
    // Only a 1 km disc around bearing 20°, 7 km is open.
    const cx = Math.sin((20 * Math.PI) / 180) * 7000;
    const cz = -Math.cos((20 * Math.PI) / 180) * 7000;
    const g = fakeGround({ surface: (x, z) => (Math.hypot(x - cx, z - cz) < 500 ? 'field' : 'forest') });
    const s = findRangeSite(g);
    expect(Math.hypot(s.x - cx, s.z - cz)).toBeLessThan(250);
    expect(s.open).toBeGreaterThan(0.8);
  });

  it('property: the site is always inside the distance band and deterministic', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1e6 }), fc.double({ min: 0.2, max: 0.8, noNaN: true }), (seed, p) => {
        const f = (x: number, z: number) => {
          const h = Math.sin(x * 0.0021 + seed) * Math.cos(z * 0.0017 - seed * 0.7);
          return h < p * 2 - 1 ? 'field' : 'forest';
        };
        const a = findRangeSite(fakeGround({ surface: f }));
        const b = findRangeSite(fakeGround({ surface: f }));
        expect(a).toEqual(b);
        return a.distance >= R.minDistance - 1e-6 && a.distance <= R.maxDistance + 1e-6;
      }),
      { numRuns: 25 },
    );
  });
});
