import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { getLayout } from '../../../src/world/layout';
import { createStandInHeight } from '../../../src/world/towns/standin';

const L = getLayout();
const h = createStandInHeight(L);

describe('stand-in heightfield', () => {
  it('is flat at the field elevation around the airport', () => {
    for (const [x, z] of [
      [0, 0],
      [300, -700],
      [-900, 500],
    ])
      expect(h(x, z)).toBeCloseTo(L.airport.elevation, 6);
  });
  it('drops below sea level south of the coast and is dry land north of it', () => {
    expect(h(-4700, L.coast.zAt(-4700) + 600)).toBeLessThan(0);
    expect(h(2100, 2100)).toBeGreaterThan(1);
  });
  it('carves the river channel below its water level', () => {
    const r = L.rivers[0];
    const i = Math.floor(r.points.length * 0.5);
    expect(h(r.points[i].x, r.points[i].z)).toBeLessThan(r.levels[i]);
  });
  it('is finite and deterministic everywhere (fuzz)', () => {
    const h2 = createStandInHeight(L);
    fc.assert(
      fc.property(fc.double({ min: -45000, max: 45000, noNaN: true }), fc.double({ min: -45000, max: 45000, noNaN: true }), (x, z) => {
        const v = h(x, z);
        expect(Number.isFinite(v)).toBe(true);
        expect(h2(x, z)).toBe(v);
      }),
    );
  });
});
