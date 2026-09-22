import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { getLayout } from '../../../src/world/layout';
import { fromRunwayCoords } from '../../../src/world/runway';
import { createAirportPlan } from '../../../src/world/airport/plan';
import { airportObstacles, createObstacleSource, type Obstacle } from '../../../src/world/airport/obstacles';

const layout = getLayout().airport;
const plan = createAirportPlan(layout);
const elev = layout.elevation;
const shapes = airportObstacles(plan, () => elev);
const top = createObstacleSource(shapes);

describe('obstacle source (pure)', () => {
  const box: Obstacle = { type: 'box', x: 10, z: 20, halfW: 5, halfD: 2, headingDeg: 90, top: 42 };
  const cyl: Obstacle = { type: 'cylinder', x: -30, z: 0, r: 3, top: 60 };
  const f = createObstacleSource([box, cyl]);
  it('returns the top inside a footprint and -Infinity outside', () => {
    expect(f(10, 20)).toBe(42);
    // heading 90: the front faces east, so width (halfW) runs north-south and depth (halfD) east-west
    expect(f(11.9, 20)).toBe(42);
    expect(f(12.1, 20)).toBe(-Infinity);
    expect(f(10, 24.9)).toBe(42);
    expect(f(10, 25.1)).toBe(-Infinity);
    expect(f(-30, 2.9)).toBe(60);
    expect(f(-30, 3.1)).toBe(-Infinity);
  });
  it('takes the tallest of overlapping obstacles', () => {
    const g = createObstacleSource([box, { ...box, top: 50, halfW: 1, halfD: 1 }]);
    expect(g(10, 20)).toBe(50);
    expect(g(10, 23)).toBe(42);
  });
  it('fuzz: never NaN, for any input (including NaN and infinities)', () => {
    fc.assert(
      fc.property(fc.double(), fc.double(), (x, z) => {
        const v = top(x, z);
        expect(Number.isNaN(v)).toBe(false);
        expect(v === -Infinity || Number.isFinite(v)).toBe(true);
      }),
      { numRuns: 5000 },
    );
  });
});

describe('airport obstacles', () => {
  it('includes the tower, every hangar, the terminal and the parked aircraft', () => {
    const t = layout.tower;
    expect(top(t.center.x, t.center.z)).toBeGreaterThanOrEqual(elev + t.height);
    for (const h of layout.hangars) expect(top(h.center.x, h.center.z)).toBeCloseTo(elev + h.height, 6);
    expect(top(layout.terminal.center.x, layout.terminal.center.z)).toBeGreaterThanOrEqual(elev + layout.terminal.height);
    for (const p of plan.parked) {
      expect(top(p.x, p.z)).toBeGreaterThan(elev + 2);
      expect(top(p.x, p.z)).toBeLessThan(elev + 3.5);
    }
    expect(top(layout.windsock.x, layout.windsock.z)).toBeGreaterThan(elev + 4);
  });
  it('fuzz: correct heights inside each building footprint', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: layout.hangars.length - 1 }), fc.double({ min: -0.95, max: 0.95, noNaN: true }), fc.double({ min: -0.95, max: 0.95, noNaN: true }), (i, u, v) => {
        const h = layout.hangars[i];
        const hd = (h.headingDeg * Math.PI) / 180;
        // front direction and the direction across the front
        const fx = Math.sin(hd), fz = -Math.cos(hd);
        const rx = Math.cos(hd), rz = Math.sin(hd);
        const x = h.center.x + rx * u * (h.width / 2) + fx * v * (h.depth / 2);
        const z = h.center.z + rz * u * (h.width / 2) + fz * v * (h.depth / 2);
        const t = top(x, z);
        expect(t).toBeGreaterThan(elev + 2);
        expect(t).toBeLessThanOrEqual(elev + h.height + 1e-9);
      }),
    );
  });
  it('fuzz: the runway, taxiway and connectors are clear (-Infinity)', () => {
    const rects = plan.pavement.filter((p) => p.kind === 'runway' || p.kind === 'taxiway');
    fc.assert(
      fc.property(fc.integer({ min: 0, max: rects.length - 1 }), fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }), (i, u, v) => {
        const r = rects[i];
        const p = fromRunwayCoords(r.a0 + u * (r.a1 - r.a0), r.c0 + v * (r.c1 - r.c0), layout.runway);
        expect(top(p.x, p.z)).toBe(-Infinity);
      }),
      { numRuns: 3000 },
    );
  });
  it('fuzz: -Infinity far away from the airport', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: Math.PI * 2, noNaN: true }), fc.double({ min: 2500, max: 1e6, noNaN: true }), (ang, d) => {
        expect(top(Math.cos(ang) * d, Math.sin(ang) * d)).toBe(-Infinity);
      }),
    );
  });
  it('follows the ground height it is given', () => {
    const f2 = createObstacleSource(airportObstacles(plan, () => 100));
    const t = layout.tower;
    expect(f2(t.center.x, t.center.z)).toBeGreaterThanOrEqual(100 + t.height);
  });
});
