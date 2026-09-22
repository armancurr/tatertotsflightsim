import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createObstacleField } from '../../../src/world/vegetation/obstacles';
import {
  treesInCell,
  placementParams,
  canopyTopOf,
  TREE_STRIDE,
  T_X,
  T_Y,
  T_Z,
  T_H,
  T_R,
  MAX_CROWN_RADIUS,
} from '../../../src/world/vegetation/placement';

const P = placementParams();
const hills = (x: number, z: number) => 25 + 15 * Math.sin(x / 350) + 10 * Math.cos(z / 280);
/** Forest in x < 0, open field (no trees) in x ≥ 0. */
const halfForest = (x: number, _z: number) => (x < 0 ? 1 : 0);
const SEED = 1234;

function bruteTop(x: number, z: number): number {
  const C = P.cellSize;
  const cx = Math.floor(x / C);
  const cz = Math.floor(z / C);
  let best = -Infinity;
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++) {
      const c = treesInCell(cx + dx, cz + dz, halfForest, hills, SEED);
      for (let i = 0; i < c.count; i++) best = Math.max(best, canopyTopOf(c.data, i, x, z));
    }
  return best;
}

describe('obstacleTop', () => {
  const field = createObstacleField({ densityAt: halfForest, heightAt: hills, seed: SEED });

  it('inside a canopy → that tree’s top; directly at the trunk → base + height', () => {
    const c = treesInCell(-3, 2, halfForest, hills, SEED);
    expect(c.count).toBeGreaterThan(10);
    for (let i = 0; i < c.count; i++) {
      const o = i * TREE_STRIDE;
      const top = field.top(c.data[o + T_X], c.data[o + T_Z]);
      // Another taller overlapping crown may be higher, never lower.
      expect(top).toBeGreaterThanOrEqual(c.data[o + T_Y] + c.data[o + T_H] - 1e-3);
    }
  });

  it('open field (density 0) → −Infinity', () => {
    for (let i = 0; i < 200; i++) {
      const x = MAX_CROWN_RADIUS + 1 + i * 37.3;
      const z = -3000 + i * 29.1;
      expect(field.top(x, z)).toBe(-Infinity);
    }
  });

  it('fuzz: equals the brute-force max over the 3×3 neighbouring cells', () => {
    fc.assert(
      fc.property(fc.double({ min: -3000, max: 400, noNaN: true }), fc.double({ min: -3000, max: 3000, noNaN: true }), (x, z) => {
        expect(field.top(x, z)).toBe(bruteTop(x, z));
      }),
      { numRuns: 300 },
    );
  });

  it('fuzz: never NaN, only finite heights or −Infinity, anywhere', () => {
    const f2 = createObstacleField({ densityAt: (x, z) => 0.5 + 0.5 * Math.sin(x * 0.01 + z * 0.013), heightAt: hills, seed: 5 });
    fc.assert(
      fc.property(fc.double({ noNaN: false }), fc.double({ noNaN: false }), (x, z) => {
        const t = f2.top(x, z);
        expect(Number.isNaN(t)).toBe(false);
        expect(t === -Infinity || Number.isFinite(t)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('handles a density function that returns NaN and a height function that returns NaN', () => {
    const bad = createObstacleField({ densityAt: () => NaN, heightAt: () => NaN, seed: 1 });
    expect(bad.top(10, 10)).toBe(-Infinity);
    const badH = createObstacleField({ densityAt: () => 1, heightAt: () => NaN, seed: 1 });
    const t = badH.top(10, 10);
    expect(Number.isNaN(t)).toBe(false);
  });

  it('keeps a bounded LRU cache of cells', () => {
    const f = createObstacleField({ densityAt: halfForest, heightAt: hills, seed: 9, cacheCells: 32 });
    for (let i = 0; i < 2000; i++) f.top(-i * 50, i * 13);
    expect(f.cachedCells()).toBeLessThanOrEqual(32);
    expect(f.cachedCells()).toBeGreaterThan(0);
  });

  it('is fast enough for the physics (≥ 20k queries/s after warm-up, even under parallel test load)', () => {
    const f = createObstacleField({ densityAt: halfForest, heightAt: hills, seed: 3 });
    for (let i = 0; i < 2000; i++) f.top(-500 + (i % 50), -200 + i * 0.1);
    const t0 = performance.now();
    let acc = 0;
    for (let i = 0; i < 50000; i++) {
      const t = f.top(-500 + (i % 50) * 0.7, -200 + (i % 997) * 0.2);
      if (t > acc) acc = t;
    }
    const dt = performance.now() - t0;
    expect(50000 / (dt / 1000)).toBeGreaterThan(20000);
  });

  it('crown profile: the top decreases toward the crown edge of an isolated tree', () => {
    // A single lone tree: density only in a tiny disc.
    const c0 = treesInCell(10, 10, () => 1, hills, 77);
    const o = 0;
    const tx = c0.data[o + T_X];
    const tz = c0.data[o + T_Z];
    const r = c0.data[o + T_R];
    const lone = createObstacleField({ densityAt: (x, z) => (Math.hypot(x - tx, z - tz) < 0.01 ? 1 : 0), heightAt: hills, seed: 77 });
    const center = lone.top(tx, tz);
    const mid = lone.top(tx + r * 0.5, tz);
    const edge = lone.top(tx + r * 0.95, tz);
    expect(center).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(edge);
    expect(lone.top(tx + r * 1.05, tz)).toBe(-Infinity);
  });
});
