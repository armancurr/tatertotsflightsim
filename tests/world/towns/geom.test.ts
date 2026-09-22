import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  makeRect,
  rectCorners,
  rectsOverlap,
  pointInRect,
  rectSegmentDistance,
  pointSegmentDistance,
  frontVector,
  headingOf,
  SegmentGrid,
  RectHash,
  resampleSmooth,
  polylineLength,
} from '../../../src/world/towns/geom';

const coord = fc.double({ min: -500, max: 500, noNaN: true });
const size = fc.double({ min: 1, max: 60, noNaN: true });
const heading = fc.double({ min: 0, max: 360, noNaN: true });

describe('geom: headings and rects', () => {
  it('frontVector points north at 0°, east at 90° and headingOf inverts it', () => {
    const n = frontVector(0);
    expect(n.x).toBeCloseTo(0);
    expect(n.z).toBeCloseTo(-1);
    const e = frontVector(90);
    expect(e.x).toBeCloseTo(1);
    expect(e.z).toBeCloseTo(0);
    fc.assert(
      fc.property(heading, (h) => {
        const f = frontVector(h);
        const back = headingOf(f.x, f.z);
        const diff = Math.abs(((back - h + 540) % 360) - 180);
        expect(diff).toBeLessThan(1e-6);
      }),
    );
  });

  it('rect corners are at ±width/2, ±depth/2 along the axes', () => {
    const r = makeRect(10, 20, 90, 8, 4); // front faces east
    const cs = rectCorners(r);
    const xs = cs.map((c) => c.x).sort((a, b) => a - b);
    const zs = cs.map((c) => c.z).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(8);
    expect(xs[3]).toBeCloseTo(12);
    expect(zs[0]).toBeCloseTo(16);
    expect(zs[3]).toBeCloseTo(24);
  });

  it('point-in-rect agrees with the corners (fuzz)', () => {
    fc.assert(
      fc.property(coord, coord, heading, size, size, fc.double({ min: -0.99, max: 0.99, noNaN: true }), fc.double({ min: -0.99, max: 0.99, noNaN: true }), (x, z, h, w, d, u, v) => {
        const r = makeRect(x, z, h, w, d);
        const px = x + r.ax * u * w * 0.5 + r.fx * v * d * 0.5;
        const pz = z + r.az * u * w * 0.5 + r.fz * v * d * 0.5;
        expect(pointInRect(r, px, pz)).toBe(true);
        const qx = x + r.ax * (w * 0.5 + 0.01) * Math.sign(u || 1);
        const qz = z + r.az * (w * 0.5 + 0.01) * Math.sign(u || 1);
        expect(pointInRect(r, qx, qz)).toBe(false);
      }),
    );
  });

  it('SAT overlap is symmetric and matches a brute-force sample test (fuzz)', () => {
    fc.assert(
      fc.property(coord, coord, heading, size, size, coord, coord, heading, size, size, (x1, z1, h1, w1, d1, x2, z2, h2, w2, d2) => {
        const a = makeRect(x1 / 10, z1 / 10, h1, w1, d1);
        const b = makeRect(x2 / 10, z2 / 10, h2, w2, d2);
        const o = rectsOverlap(a, b);
        expect(rectsOverlap(b, a)).toBe(o);
        // any corner of one strictly inside the other ⇒ overlap
        const inside = rectCorners(a).some((c) => pointInRect(b, c.x, c.z, -1e-6)) || rectCorners(b).some((c) => pointInRect(a, c.x, c.z, -1e-6));
        if (inside) expect(o).toBe(true);
        // centres inside each other ⇒ overlap
        if (pointInRect(a, b.x, b.z)) expect(o).toBe(true);
      }),
    );
  });

  it('a gap makes nearby rects count as overlapping', () => {
    const a = makeRect(0, 0, 0, 10, 10);
    const b = makeRect(11.5, 0, 0, 10, 10); // 1.5 m apart
    expect(rectsOverlap(a, b)).toBe(false);
    expect(rectsOverlap(a, b, 1)).toBe(false);
    expect(rectsOverlap(a, b, 2)).toBe(true);
  });
});

describe('geom: distances', () => {
  it('rectSegmentDistance is 0 when the segment crosses the rect and exact otherwise', () => {
    const r = makeRect(0, 0, 0, 10, 10);
    expect(rectSegmentDistance(r, -20, 0, 20, 0)).toBe(0);
    expect(rectSegmentDistance(r, -20, 8, 20, 8)).toBeCloseTo(3);
    expect(rectSegmentDistance(r, 8, 8, 20, 20)).toBeCloseTo(Math.hypot(3, 3));
  });

  it('rectSegmentDistance ≤ distance from any rect sample point to the segment (fuzz)', () => {
    fc.assert(
      fc.property(coord, coord, heading, size, size, coord, coord, coord, coord, (x, z, h, w, d, ax, az, bx, bz) => {
        const r = makeRect(x / 5, z / 5, h, w, d);
        const dist = rectSegmentDistance(r, ax / 5, az / 5, bx / 5, bz / 5);
        expect(dist).toBeGreaterThanOrEqual(0);
        for (const c of rectCorners(r)) expect(dist).toBeLessThanOrEqual(pointSegmentDistance(c.x, c.z, ax / 5, az / 5, bx / 5, bz / 5) + 1e-6);
        expect(dist).toBeLessThanOrEqual(pointSegmentDistance(r.x, r.z, ax / 5, az / 5, bx / 5, bz / 5) + 1e-6);
      }),
    );
  });
});

describe('geom: SegmentGrid', () => {
  it('finds the nearest segment like brute force (fuzz)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(coord, coord, coord, coord), { minLength: 1, maxLength: 30 }),
        coord,
        coord,
        (segs, qx, qz) => {
          const g = new SegmentGrid(64);
          segs.forEach(([ax, az, bx, bz], i) => g.add(ax, az, bx, bz, 3, i));
          g.build();
          let best = Infinity;
          let bestI = -1;
          segs.forEach(([ax, az, bx, bz], i) => {
            const d = pointSegmentDistance(qx, qz, ax, az, bx, bz);
            if (d < best) {
              best = d;
              bestI = i;
            }
          });
          const out = g.newQuery();
          const found = g.nearest(qx, qz, 200, out);
          if (best <= 200) {
            expect(found).toBe(true);
            expect(out.d).toBeCloseTo(best, 6);
            void bestI;
          } else expect(found).toBe(false);
        },
      ),
    );
  });

  it('clearance(rect) = min over segments of rect distance − half width', () => {
    const g = new SegmentGrid(50);
    g.add(-100, 20, 100, 20, 4, 0);
    g.add(30, -100, 30, 100, 2, 1);
    g.build();
    const r = makeRect(0, 0, 0, 10, 10);
    // road 0 edge at z=16 → rect top edge at z=5 → clearance 20-5-4 = 11; road 1 edge at x=28 → 30-5-2 = 23
    expect(g.clearance(r, 100)).toBeCloseTo(11);
    expect(g.clearance(makeRect(0, 20, 0, 4, 4), 100)).toBeLessThan(0);
  });
});

describe('geom: RectHash', () => {
  it('reports overlaps like brute force (fuzz)', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(coord, coord, heading, size, size), { minLength: 1, maxLength: 25 }), fc.tuple(coord, coord, heading, size, size), (rs, q) => {
        const hash = new RectHash(40);
        const rects = rs.map(([x, z, h, w, d]) => makeRect(x / 4, z / 4, h, w, d));
        rects.forEach((r, i) => hash.add(r, i));
        const qr = makeRect(q[0] / 4, q[1] / 4, q[2], q[3], q[4]);
        const brute = rects.some((r) => rectsOverlap(r, qr, 1.5));
        expect(hash.anyOverlap(qr, 1.5)).toBe(brute);
      }),
    );
  });
});

describe('geom: polylines', () => {
  it('resampleSmooth keeps the ends, spaces points evenly and preserves length of a straight line', () => {
    const pts = [
      { x: 0, z: 0 },
      { x: 100, z: 0 },
      { x: 200, z: 0 },
    ];
    const r = resampleSmooth(pts, 7);
    expect(r[0]).toEqual({ x: 0, z: 0 });
    expect(r[r.length - 1].x).toBeCloseTo(200);
    expect(polylineLength(r)).toBeCloseTo(200, 3);
    for (let i = 1; i < r.length; i++) expect(Math.hypot(r[i].x - r[i - 1].x, r[i].z - r[i - 1].z)).toBeLessThanOrEqual(7 + 1e-6);
  });
});
