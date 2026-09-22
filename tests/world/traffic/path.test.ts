import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createPath, samplePath, samplePathAtTime, arcAtTime, filletPath, smoothLoop, smoothLine, newPathSample, headingOf } from '../../../src/world/traffic/path';

describe('traffic paths', () => {
  it('headingOf follows the world frame (north = −Z, clockwise)', () => {
    expect(headingOf(0, -1)).toBeCloseTo(0);
    expect(headingOf(1, 0)).toBeCloseTo(90);
    expect(headingOf(0, 1)).toBeCloseTo(180);
    expect(headingOf(-1, 0)).toBeCloseTo(270);
  });

  it('a straight open path has exact length, heading and time', () => {
    const p = createPath([{ x: 0, y: 10, z: 0, v: 10 }, { x: 0, y: 30, z: -1000, v: 10 }], false, 5);
    expect(p.length).toBeCloseTo(1000, 6);
    expect(p.duration).toBeCloseTo(100, 6);
    const s = samplePath(p, 500, newPathSample());
    expect(s.x).toBeCloseTo(0);
    expect(s.z).toBeCloseTo(-500);
    expect(s.y).toBeCloseTo(20);
    expect(s.heading).toBeCloseTo(0);
    expect(s.grade).toBeCloseTo(0.02);
    expect(samplePathAtTime(p, 25, s).z).toBeCloseTo(-250, 3);
    // clamped at the ends
    expect(samplePath(p, -50, s).z).toBeCloseTo(0);
    expect(samplePath(p, 5000, s).z).toBeCloseTo(-1000);
  });

  it('accelerating segments integrate time exactly (constant acceleration)', () => {
    // 0 → 20 m/s over 100 m: a = v²/2s = 2 m/s², t = 10 s
    const p = createPath([{ x: 0, y: 0, z: 0, v: 0.0001 }, { x: 0, y: 0, z: -100, v: 20 }], false, 1);
    expect(p.duration).toBeGreaterThan(9);
    expect(p.duration).toBeLessThan(11.5);
    expect(arcAtTime(p, p.duration)).toBeCloseTo(100, 3);
  });

  it('closed loops wrap in arc length and time', () => {
    const pts = smoothLoop([{ x: 0, z: 0 }, { x: 1000, z: 0 }, { x: 1000, z: 1000 }, { x: 0, z: 1000 }].map((p) => ({ ...p, v: 5 })));
    const p = createPath(pts, true, 5);
    const a = samplePath(p, 100, newPathSample());
    const b = samplePath(p, 100 + p.length * 3, newPathSample());
    expect(b.x).toBeCloseTo(a.x, 6);
    expect(b.z).toBeCloseTo(a.z, 6);
    const c = samplePathAtTime(p, 12, newPathSample());
    const d = samplePathAtTime(p, 12 + p.duration * 2, newPathSample());
    expect(d.x).toBeCloseTo(c.x, 4);
    expect(d.z).toBeCloseTo(c.z, 4);
  });

  it('fillet corners are arcs of the requested radius, turning the right way', () => {
    // north 2 km then a right turn to the east
    const pts = filletPath([
      { x: 0, z: 0, y: 100, v: 40 },
      { x: 0, z: -2000, y: 100, v: 40, r: 300 },
      { x: 2000, z: -2000, y: 100, v: 40 },
    ]);
    const p = createPath(pts, false, 4);
    const smp = newPathSample();
    let maxK = 0;
    for (let s = 0; s < p.length; s += 10) {
      samplePath(p, s, smp);
      maxK = Math.max(maxK, smp.curvature);
      expect(smp.curvature).toBeGreaterThanOrEqual(-1e-6); // never turns left
    }
    expect(1 / maxK).toBeGreaterThan(270);
    expect(1 / maxK).toBeLessThan(330);
    // length = 2 straights shortened by r·tan(45°) each + quarter arc
    expect(p.length).toBeCloseTo(4000 - 600 + (Math.PI / 2) * 300, -1);
  });

  it('fillet heights and speeds are interpolated between waypoints', () => {
    const pts = filletPath([
      { x: 0, z: 0, y: 0, v: 10 },
      { x: 0, z: -1000, y: 100, v: 20 },
    ]);
    const p = createPath(pts, false, 5);
    const smp = samplePath(p, 500, newPathSample());
    expect(smp.y).toBeGreaterThan(40);
    expect(smp.y).toBeLessThan(60);
    expect(smp.speed).toBeCloseTo(Math.sqrt((100 + 400) / 2), 0);
  });

  it('fuzz: random loops/lines sample finite values inside their bounding box', () => {
    const pt = fc.record({ x: fc.double({ min: -20000, max: 20000, noNaN: true }), z: fc.double({ min: -20000, max: 20000, noNaN: true }), v: fc.double({ min: 0.5, max: 250, noNaN: true }) });
    fc.assert(
      fc.property(fc.array(pt, { minLength: 3, maxLength: 9 }), fc.boolean(), fc.double({ min: -1e6, max: 1e6, noNaN: true }), (ctrl, closed, q) => {
        // avoid degenerate coincident control points
        for (let i = 1; i < ctrl.length; i++) if (Math.hypot(ctrl[i].x - ctrl[i - 1].x, ctrl[i].z - ctrl[i - 1].z) < 1) return;
        const pts = closed ? smoothLoop(ctrl, 8) : smoothLine(ctrl, 8);
        const p = createPath(pts, closed, 20);
        const smp = newPathSample();
        samplePath(p, q, smp);
        for (const k of ['x', 'y', 'z', 'heading', 'curvature', 'grade', 'speed', 's'] as const) expect(Number.isFinite(smp[k])).toBe(true);
        expect(smp.heading).toBeGreaterThanOrEqual(0);
        expect(smp.heading).toBeLessThan(360);
        const xs = pts.map((p2) => p2.x);
        const zs = pts.map((p2) => p2.z);
        expect(smp.x).toBeGreaterThanOrEqual(Math.min(...xs) - 1e-6);
        expect(smp.x).toBeLessThanOrEqual(Math.max(...xs) + 1e-6);
        expect(smp.z).toBeGreaterThanOrEqual(Math.min(...zs) - 1e-6);
        expect(smp.z).toBeLessThanOrEqual(Math.max(...zs) + 1e-6);
        samplePathAtTime(p, q, smp);
        expect(Number.isFinite(smp.x) && Number.isFinite(smp.z)).toBe(true);
        // arcAtTime is monotonic in time within one lap
        const d = Math.min(p.duration, 1e5);
        let prev = -1;
        for (let k = 0; k <= 8; k++) {
          const s = arcAtTime(p, (d * k) / 8.0001);
          expect(s).toBeGreaterThanOrEqual(prev - 1e-6);
          prev = s;
        }
      }),
      { numRuns: 200 },
    );
  });
});
