import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { arcDelta, chaikin, makePath, nearestOnPath, newPathSample, resample, sampleAt, wrapS } from '../../../src/combat/targets/path';

const square = [{ x: 0, z: 0 }, { x: 100, z: 0 }, { x: 100, z: 100 }, { x: 0, z: 100 }];

describe('track paths', () => {
  it('a closed square is 400 m long and wraps', () => {
    const p = makePath(square, true);
    expect(p.length).toBeCloseTo(400);
    const o = newPathSample();
    sampleAt(p, 150, o);
    expect(o.x).toBeCloseTo(100);
    expect(o.z).toBeCloseTo(50);
    expect(o.tx).toBeCloseTo(0);
    expect(o.tz).toBeCloseTo(1);
    sampleAt(p, 550, o);
    expect(o.x).toBeCloseTo(100);
    expect(o.z).toBeCloseTo(50);
    sampleAt(p, 350, o); // last (closing) segment back to the start
    expect(o.x).toBeCloseTo(0);
    expect(o.z).toBeCloseTo(50);
    expect(o.tz).toBeCloseTo(-1);
    expect(wrapS(p, -10)).toBeCloseTo(390);
    expect(arcDelta(p, 390, 10)).toBeCloseTo(20);
    expect(arcDelta(p, 10, 390)).toBeCloseTo(-20);
  });

  it('an open path clamps', () => {
    const p = makePath(square, false);
    expect(p.length).toBeCloseTo(300);
    const o = newPathSample();
    sampleAt(p, 1e6, o);
    expect(o.x).toBeCloseTo(0);
    expect(o.z).toBeCloseTo(100);
    expect(arcDelta(p, 10, 290)).toBeCloseTo(280);
  });

  it('resampling keeps the length and spacing; Chaikin stays inside the hull; nearest point', () => {
    const r = resample(square, 2, true);
    const p = makePath(r, true);
    expect(p.length).toBeCloseTo(400, 0);
    for (let i = 1; i < r.length; i++) expect(Math.hypot(r[i].x - r[i - 1].x, r[i].z - r[i - 1].z)).toBeLessThan(2.1);
    const c = chaikin(square, true);
    expect(c).toHaveLength(8);
    for (const q of c) expect(q.x >= 0 && q.x <= 100 && q.z >= 0 && q.z <= 100).toBe(true);
    const nr = nearestOnPath(makePath(square, true), 50, -7);
    expect(nr.s).toBeCloseTo(50);
    expect(nr.d).toBeCloseTo(7);
  });

  it('property: samples are always on the polyline and tangents are unit', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ x: fc.double({ min: -500, max: 500, noNaN: true }), z: fc.double({ min: -500, max: 500, noNaN: true }) }), { minLength: 3, maxLength: 12 }),
        fc.boolean(),
        fc.double({ min: -5000, max: 5000, noNaN: true }),
        (pts, closed, s) => {
          const p = makePath(pts, closed);
          if (p.n < 2 || p.length < 1e-3) return true;
          const o = sampleAt(p, s, newPathSample());
          const near = nearestOnPath(p, o.x, o.z);
          return near.d < 1e-6 && Math.abs(Math.hypot(o.tx, o.tz) - 1) < 1e-9;
        },
      ),
      { numRuns: 300 },
    );
  });
});
