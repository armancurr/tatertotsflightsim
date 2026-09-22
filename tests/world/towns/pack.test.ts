import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { packBuildings, unpackBuildings, PACK_STRIDE } from '../../../src/world/towns/pack';
import { ARCHETYPES, placeBuildings, type Building } from '../../../src/world/towns/placement';
import { getRoadNetwork } from '../../../src/world/roads/network';
import { LAYOUT, HEIGHT } from './fixtures';

// whole-world placements are CPU-heavy: generous timeouts so the suite stays green under parallel load
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const USES: Building['use'][] = ['house', 'apartment', 'shop', 'office', 'tower', 'industrial', 'warehouse', 'church', 'steeple', 'farmhouse', 'barn', 'silo', 'shed'];

const norm = (b: Building): Building => {
  const o: Building = { ...b };
  // optional fields: absent and 0 mean the same
  if (!o.tierHeight) {
    delete o.tierHeight;
    delete o.tierInset;
  }
  if (o.plinth === undefined) o.plinth = 0;
  return o;
};

describe('packBuildings / unpackBuildings', () => {
  it('round-trips the real placement exactly (Float64)', () => {
    const B = placeBuildings(LAYOUT, getRoadNetwork(LAYOUT, HEIGHT), HEIGHT);
    const packed = packBuildings(B);
    expect(packed.length).toBe(B.length * PACK_STRIDE);
    const back = unpackBuildings(packed);
    expect(back.length).toBe(B.length);
    for (let i = 0; i < B.length; i++) expect(back[i]).toEqual(norm(B[i]));
  });
  it('fuzz: any building round-trips', () => {
    const arb = fc.record({
      x: fc.double({ noNaN: true, noDefaultInfinity: true }),
      z: fc.double({ noNaN: true, noDefaultInfinity: true }),
      y: fc.double({ min: -100, max: 3000, noNaN: true }),
      headingDeg: fc.double({ min: 0, max: 360, noNaN: true }),
      width: fc.double({ min: 1, max: 100, noNaN: true }),
      depth: fc.double({ min: 1, max: 100, noNaN: true }),
      wallHeight: fc.double({ min: 1, max: 200, noNaN: true }),
      roofHeight: fc.double({ min: 0, max: 30, noNaN: true }),
      ridge: fc.double({ min: 0, max: 1, noNaN: true }),
      ridgeAxis: fc.constantFrom<0 | 1>(0, 1),
      archetype: fc.constantFrom(...ARCHETYPES),
      use: fc.constantFrom(...USES),
      wallColor: fc.integer({ min: 0, max: 0xffffff }),
      roofColor: fc.integer({ min: 0, max: 0xffffff }),
      floorHeight: fc.double({ min: 0, max: 5, noNaN: true }),
      style: fc.integer({ min: 0, max: 12 }),
      rand: fc.double({ min: 0, max: 0.9999, noNaN: true }),
      town: fc.integer({ min: -1, max: 40 }),
      farm: fc.integer({ min: -1, max: 5000 }),
      plinth: fc.double({ min: 0, max: 10, noNaN: true }),
      tier: fc.option(fc.record({ h: fc.double({ min: 5, max: 100, noNaN: true }), i: fc.double({ min: 1, max: 8, noNaN: true }) }), { nil: undefined }),
    });
    fc.assert(
      fc.property(fc.array(arb, { maxLength: 30 }), (list) => {
        const bs: Building[] = list.map(({ tier, ...b }) => ({ ...b, ...(tier ? { tierHeight: tier.h, tierInset: tier.i } : {}) }));
        const back = unpackBuildings(packBuildings(bs));
        expect(back).toEqual(bs.map(norm));
      }),
    );
  });
});
