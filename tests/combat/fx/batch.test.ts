/**
 * Unit + fuzz: the per-frame impact batch — at most `capacity` impact effects per frame (the rest
 * are merged into the nearest one of the same kind, which grows instead), preallocated, no growth.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { ImpactBatch } from '../../../src/combat/fx/batch';

describe('ImpactBatch', () => {
  it('keeps impacts one by one up to its capacity', () => {
    const b = new ImpactBatch(4);
    b.add(0, 0, 0, 0, false, -1);
    b.add(10, 0, 0, 0, false, -1);
    expect(b.count).toBe(2);
    expect(b.weight[0]).toBe(1);
    expect(b.x[1]).toBe(10);
    expect(b.total).toBe(2);
  });
  it('over capacity, merges into the nearest slot of the same class (weight grows), never more slots', () => {
    const b = new ImpactBatch(2);
    b.add(0, 0, 0, 0, false, -1);
    b.add(100, 0, 0, 0, false, -1);
    b.add(98, 0, 1, 0, false, -1);
    expect(b.count).toBe(2);
    expect(b.weight[1]).toBe(2);
    expect(b.weight[0]).toBe(1);
    expect(b.total).toBe(3);
    // A different class merges into the nearest slot when no slot of its class exists.
    b.add(1, 0, 0, 3, true, 7);
    expect(b.count).toBe(2);
    expect(b.weight[0]).toBe(2);
  });
  it('clear() empties it; arrays are preallocated and never reallocated', () => {
    const b = new ImpactBatch(3);
    const xs = b.x;
    for (let i = 0; i < 100; i++) b.add(i, 0, i, i % 5, i % 2 === 0, i);
    expect(b.count).toBe(3);
    b.clear();
    expect(b.count).toBe(0);
    expect(b.total).toBe(0);
    expect(b.x).toBe(xs);
  });
  it('ignores non-finite positions', () => {
    const b = new ImpactBatch(3);
    b.add(Number.NaN, 0, 0, 0, false, -1);
    b.add(0, Infinity, 0, 0, false, -1);
    expect(b.count).toBe(0);
  });
  it('fuzz: count ≤ capacity and the weights add up to every finite impact added', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 32 }),
        fc.array(fc.tuple(fc.double({ min: -1e4, max: 1e4, noNaN: true }), fc.double({ min: -1e4, max: 1e4, noNaN: true }), fc.integer({ min: 0, max: 4 })), { maxLength: 300 }),
        (cap, adds) => {
          const b = new ImpactBatch(cap);
          for (const [x, z, c] of adds) b.add(x, 0, z, c, false, -1);
          expect(b.count).toBeLessThanOrEqual(cap);
          let w = 0;
          for (let i = 0; i < b.count; i++) w += b.weight[i];
          expect(w).toBe(adds.length);
          expect(b.total).toBe(adds.length);
        },
      ),
    );
  });
});
