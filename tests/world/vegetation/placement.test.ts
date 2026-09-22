import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  treesInCell,
  placementParams,
  canopyProfile,
  canopyTopOf,
  hedgeQuery,
  newHedgeSample,
  TREE_STRIDE,
  T_X,
  T_Y,
  T_Z,
  T_H,
  T_R,
  T_SPECIES,
  T_ROT,
  T_TINT,
  T_RANK,
  SPECIES_COUNT,
  CONIFER,
  DECIDUOUS,
  POPLAR,
  BUSH,
  MAX_CROWN_RADIUS,
  MAX_TREE_HEIGHT,
} from '../../../src/world/vegetation/placement';

const P = placementParams();
const flat = (_x: number, _z: number) => 12;
const hills = (x: number, z: number) => 40 + 20 * Math.sin(x / 300) * Math.cos(z / 410);
const constDensity = (d: number) => (_x: number, _z: number) => d;

function countTrees(d: (x: number, z: number) => number, cells: number, seed = 7): number {
  let n = 0;
  for (let i = 0; i < cells; i++) n += treesInCell(i * 3 - 40, (i * 7) % 23 - 11, d, flat, seed).count;
  return n;
}

describe('treesInCell — determinism', () => {
  it('returns identical trees for identical inputs', () => {
    const a = treesInCell(3, -5, constDensity(0.8), hills, 42);
    const b = treesInCell(3, -5, constDensity(0.8), hills, 42);
    expect(a.count).toBeGreaterThan(0);
    expect(a.count).toBe(b.count);
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });

  it('a different seed gives a different forest', () => {
    const a = treesInCell(3, -5, constDensity(0.8), hills, 42);
    const b = treesInCell(3, -5, constDensity(0.8), hills, 43);
    expect(Array.from(a.data)).not.toEqual(Array.from(b.data));
  });

  it('packs exactly count × TREE_STRIDE floats', () => {
    const c = treesInCell(0, 0, constDensity(1), flat, 1);
    expect(c.data.length).toBe(c.count * TREE_STRIDE);
    expect(c.cx).toBe(0);
    expect(c.cz).toBe(0);
  });

  it('fuzz: same inputs → same output, for any cell, seed and density', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -3000, max: 3000 }),
        fc.integer({ min: -3000, max: 3000 }),
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (cx, cz, seed, d) => {
          const a = treesInCell(cx, cz, constDensity(d), hills, seed);
          const b = treesInCell(cx, cz, constDensity(d), hills, seed);
          expect(a.count).toBe(b.count);
          expect(Array.from(a.data)).toEqual(Array.from(b.data));
        },
      ),
      { numRuns: 120 },
    );
  });
});

describe('treesInCell — tree records', () => {
  it('fuzz: every tree lies inside its cell, sits on the ground and has sane attributes', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -2000, max: 2000 }),
        fc.integer({ min: -2000, max: 2000 }),
        fc.integer({ min: 0, max: 100000 }),
        fc.double({ min: 0.01, max: 1, noNaN: true }),
        (cx, cz, seed, d) => {
          const c = treesInCell(cx, cz, constDensity(d), hills, seed);
          const x0 = cx * P.cellSize;
          const z0 = cz * P.cellSize;
          for (let i = 0; i < c.count; i++) {
            const o = i * TREE_STRIDE;
            const x = c.data[o + T_X];
            const z = c.data[o + T_Z];
            expect(x).toBeGreaterThanOrEqual(x0 - 1e-3);
            expect(x).toBeLessThanOrEqual(x0 + P.cellSize + 1e-3);
            expect(z).toBeGreaterThanOrEqual(z0 - 1e-3);
            expect(z).toBeLessThanOrEqual(z0 + P.cellSize + 1e-3);
            expect(c.data[o + T_Y]).toBeCloseTo(Math.fround(hills(x, z)), 1);
            const h = c.data[o + T_H];
            const r = c.data[o + T_R];
            expect(h).toBeGreaterThan(0.5);
            expect(h).toBeLessThanOrEqual(MAX_TREE_HEIGHT);
            expect(r).toBeGreaterThan(0.2);
            expect(r).toBeLessThanOrEqual(MAX_CROWN_RADIUS);
            const sp = c.data[o + T_SPECIES];
            expect(Number.isInteger(sp)).toBe(true);
            expect(sp).toBeGreaterThanOrEqual(0);
            expect(sp).toBeLessThan(SPECIES_COUNT);
            expect(c.data[o + T_ROT]).toBeGreaterThanOrEqual(0);
            expect(c.data[o + T_ROT]).toBeLessThan(Math.PI * 2 + 1e-4);
            expect(c.data[o + T_TINT]).toBeGreaterThanOrEqual(0);
            expect(c.data[o + T_TINT]).toBeLessThanOrEqual(1);
            expect(c.data[o + T_RANK]).toBeGreaterThanOrEqual(0);
            expect(c.data[o + T_RANK]).toBeLessThan(1);
          }
        },
      ),
      { numRuns: 150 },
    );
  });

  it('never places more trees than lattice candidates', () => {
    const c = treesInCell(1, 1, constDensity(1), flat, 3);
    expect(c.count).toBeLessThanOrEqual(P.gridPerCell * P.gridPerCell);
  });

  it('produces all four species across a varied landscape', () => {
    const seen = new Set<number>();
    const density = (x: number, z: number) => 0.5 + 0.5 * Math.sin(x / 900) * Math.cos(z / 700);
    for (let i = 0; i < 400 && seen.size < 4; i++) {
      const c = treesInCell((i % 20) * 9 - 90, Math.floor(i / 20) * 9 - 90, density, hills, 11);
      for (let t = 0; t < c.count; t++) seen.add(c.data[t * TREE_STRIDE + T_SPECIES]);
    }
    expect([...seen].sort()).toEqual([CONIFER, DECIDUOUS, POPLAR, BUSH]);
  });

  it('species sizes are realistic: conifers and poplars tall, bushes low', () => {
    const sum = new Float64Array(4);
    const n = new Float64Array(4);
    const density = (x: number, z: number) => 0.55 + 0.45 * Math.sin(x / 700);
    for (let i = 0; i < 300; i++) {
      const c = treesInCell(i - 150, (i * 13) % 97, density, hills, 5);
      for (let t = 0; t < c.count; t++) {
        const s = c.data[t * TREE_STRIDE + T_SPECIES];
        sum[s] += c.data[t * TREE_STRIDE + T_H];
        n[s]++;
      }
    }
    const mean = (s: number) => sum[s] / Math.max(1, n[s]);
    expect(mean(CONIFER)).toBeGreaterThan(12);
    expect(mean(POPLAR)).toBeGreaterThan(14);
    expect(mean(DECIDUOUS)).toBeGreaterThan(8);
    expect(mean(BUSH)).toBeLessThan(5);
  });
});

describe('treesInCell — density', () => {
  it('density 0 → no trees at all (unit)', () => {
    for (let i = -10; i < 10; i++) expect(treesInCell(i, -i * 3, constDensity(0), flat, 9).count).toBe(0);
  });

  it('fuzz: nothing is placed where the density is 0 (random exclusion discs and half-planes)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -500, max: 500 }),
        fc.integer({ min: -500, max: 500 }),
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: 3, max: 60, noNaN: true }),
        fc.integer({ min: 0, max: 99999 }),
        (cx, cz, ox, oz, radius, seed) => {
          const ccx = (cx + 0.5 + ox * 0.5) * P.cellSize;
          const ccz = (cz + 0.5 + oz * 0.5) * P.cellSize;
          const disc = (x: number, z: number) => (Math.hypot(x - ccx, z - ccz) < radius ? 0 : 1);
          const half = (x: number, z: number) => ((x - ccx) * ox + (z - ccz) * oz > 0 ? 0 : 0.9);
          for (const dens of [disc, half]) {
            const c = treesInCell(cx, cz, dens, flat, seed);
            for (let i = 0; i < c.count; i++) {
              const o = i * TREE_STRIDE;
              expect(dens(c.data[o + T_X], c.data[o + T_Z])).toBeGreaterThan(0);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('treats NaN / negative density as 0', () => {
    expect(treesInCell(2, 2, () => NaN, flat, 1).count).toBe(0);
    expect(treesInCell(2, 2, () => -0.5, flat, 1).count).toBe(0);
  });

  it('respects the density statistically: more density → proportionally more trees', () => {
    const cells = 400;
    const n1 = countTrees(constDensity(1), cells);
    const n06 = countTrees(constDensity(0.6), cells);
    const n035 = countTrees(constDensity(0.35), cells);
    // Full forest: most lattice candidates become trees (closed canopy, some clearings).
    expect(n1 / (cells * P.gridPerCell ** 2)).toBeGreaterThan(0.6);
    expect(n06 / n1).toBeGreaterThan(0.5);
    expect(n06 / n1).toBeLessThan(0.75);
    expect(n035 / n1).toBeGreaterThan(0.28);
    expect(n035 / n1).toBeLessThan(0.48);
  });

  it('open land (low density) has only sparse lone trees and hedgerows', () => {
    const cells = 600;
    const forest = countTrees(constDensity(1), cells);
    const open = countTrees(constDensity(0.03), cells);
    expect(open).toBeGreaterThan(0);
    expect(open).toBeLessThan(forest * 0.15);
  });

  it('fuzz: count is monotone (non-decreasing) in density over a large sample', () => {
    fc.assert(
      fc.property(fc.double({ min: 0.3, max: 0.9, noNaN: true }), (d) => {
        const lo = countTrees(constDensity(d), 120, 3);
        const hi = countTrees(constDensity(Math.min(1, d + 0.1)), 120, 3);
        expect(hi).toBeGreaterThanOrEqual(lo);
      }),
      { numRuns: 12 },
    );
  });

  it('forests are clustered: tree counts vary from cell to cell even at constant density', () => {
    const counts: number[] = [];
    for (let i = 0; i < 200; i++) counts.push(treesInCell(i * 5, i * 3, constDensity(0.7), flat, 21).count);
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    const sd = Math.sqrt(counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length);
    expect(sd / mean).toBeGreaterThan(0.08);
  });
});

describe('hedgerows', () => {
  it('hedge lines exist in open land and trees there line up along them', () => {
    const s = newHedgeSample();
    let hedgeTrees = 0;
    let lone = 0;
    for (let i = 0; i < 800; i++) {
      const c = treesInCell((i % 40) - 20, Math.floor(i / 40) - 10, constDensity(0.03), flat, 77);
      for (let t = 0; t < c.count; t++) {
        hedgeQuery(c.data[t * TREE_STRIDE + T_X], c.data[t * TREE_STRIDE + T_Z], 77, s);
        if (s.onHedge) hedgeTrees++;
        else lone++;
      }
    }
    expect(hedgeTrees).toBeGreaterThan(50);
    expect(lone).toBeGreaterThan(0);
    // Most trees in open farmland stand in hedgerows, not scattered at random.
    expect(hedgeTrees / (hedgeTrees + lone)).toBeGreaterThan(0.6);
  });

  it('hedgeQuery is deterministic and reports a field id', () => {
    const a = hedgeQuery(1234.5, -987.25, 3, newHedgeSample());
    const b = hedgeQuery(1234.5, -987.25, 3, newHedgeSample());
    expect(a).toEqual(b);
    expect(Number.isFinite(a.fieldId)).toBe(true);
    expect(a.dist).toBeGreaterThanOrEqual(0);
  });
});

describe('canopy profile (the obstacle shape of every species)', () => {
  it('is highest at the trunk and −Infinity outside the crown', () => {
    for (let s = 0; s < SPECIES_COUNT; s++) {
      expect(canopyProfile(s, 0)).toBeCloseTo(1, 5);
      expect(canopyProfile(s, 1.0001)).toBe(-Infinity);
      expect(canopyProfile(s, 0.99)).toBeGreaterThan(0);
    }
  });

  it('fuzz: non-increasing from trunk to crown edge, within [0, 1]', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 3 }), fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }), (s, a, b) => {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const pl = canopyProfile(s, lo);
        const ph = canopyProfile(s, hi);
        expect(pl).toBeGreaterThanOrEqual(ph - 1e-12);
        expect(pl).toBeLessThanOrEqual(1);
        expect(ph).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  it('canopyTopOf gives base + height at the trunk and −Infinity beyond the crown', () => {
    const c = treesInCell(4, 4, constDensity(1), hills, 8);
    expect(c.count).toBeGreaterThan(0);
    const o = 0;
    const x = c.data[o + T_X];
    const z = c.data[o + T_Z];
    const top = canopyTopOf(c.data, 0, x, z);
    expect(top).toBeCloseTo(c.data[o + T_Y] + c.data[o + T_H], 3);
    expect(canopyTopOf(c.data, 0, x + c.data[o + T_R] + 0.01, z)).toBe(-Infinity);
  });
});
