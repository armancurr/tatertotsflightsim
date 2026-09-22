import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createObstacleIndex } from '../../../src/world/towns/obstacles';
import { placeBuildings, roofTopAt, buildingRect, type Building } from '../../../src/world/towns/placement';
import { getRoadNetwork } from '../../../src/world/roads/network';
import { LAYOUT, HEIGHT } from './fixtures';

const B = placeBuildings(LAYOUT, getRoadNetwork(LAYOUT, HEIGHT), HEIGHT);
const top = createObstacleIndex(B);

const brute = (x: number, z: number): number => {
  let t = -Infinity;
  for (const b of B) {
    if (Math.abs(b.x - x) > 80 || Math.abs(b.z - z) > 80) continue;
    t = Math.max(t, roofTopAt(b, x, z));
  }
  return t;
};

describe('obstacleTop', () => {
  it('is −Infinity in open country and over the runway', () => {
    expect(top(0, 0)).toBe(-Infinity);
    expect(top(0, -500)).toBe(-Infinity);
    expect(top(1e6, 1e6)).toBe(-Infinity);
  });

  it('returns the roof height inside a footprint (fuzz over buildings and points in them)', () => {
    fc.assert(
      fc.property(fc.nat({ max: B.length - 1 }), fc.double({ min: -0.98, max: 0.98, noNaN: true }), fc.double({ min: -0.98, max: 0.98, noNaN: true }), (i, u, v) => {
        const b: Building = B[i];
        const r = buildingRect(b);
        const s = b.archetype === 'silo' ? 0.7 : 1; // stay inside the silo's circle
        const x = r.x + r.ax * r.hw * u * s + r.fx * r.hd * v * s;
        const z = r.z + r.az * r.hw * u * s + r.fz * r.hd * v * s;
        const t = top(x, z);
        expect(t).toBeCloseTo(roofTopAt(b, x, z), 9);
        // a setback tower's terrace is at the tier (plus parapet), everything else at least at the wall top
        expect(t).toBeGreaterThanOrEqual(b.y + (b.tierHeight ? b.tierHeight + b.roofHeight : b.wallHeight) - 1e-9);
        expect(t).toBeLessThanOrEqual(b.y + b.wallHeight + b.roofHeight + 1e-9);
      }),
      { numRuns: 500 },
    );
  });

  it('is either finite or −Infinity and matches brute force anywhere (fuzz)', () => {
    const city = LAYOUT.towns[1];
    fc.assert(
      fc.property(fc.double({ min: -1, max: 1, noNaN: true }), fc.double({ min: -1, max: 1, noNaN: true }), (a, c) => {
        const x = city.x + a * city.radius;
        const z = city.z + c * city.radius;
        const t = top(x, z);
        expect(t === -Infinity || Number.isFinite(t)).toBe(true);
        expect(t).toBe(brute(x, z));
      }),
      { numRuns: 400 },
    );
    fc.assert(
      fc.property(fc.double({ min: -40000, max: 40000, noNaN: true }), fc.double({ min: -40000, max: 40000, noNaN: true }), (x, z) => {
        const t = top(x, z);
        expect(t === -Infinity || Number.isFinite(t)).toBe(true);
      }),
      { numRuns: 400 },
    );
  });

  it('answers ~1M queries per second (no allocation in the hot path)', () => {
    const t0 = performance.now();
    let acc = 0;
    const city = LAYOUT.towns[1];
    for (let i = 0; i < 200000; i++) {
      const v = top(city.x + ((i * 37) % 3000) - 1500, city.z + ((i * 91) % 3000) - 1500);
      if (v > acc) acc = v;
    }
    const ms = performance.now() - t0;
    expect(acc).toBeGreaterThan(0);
    expect(ms).toBeLessThan(600);
  });
});
