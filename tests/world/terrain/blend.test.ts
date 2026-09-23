import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { classWeights, heightBlend, topTwo, CLASS_COUNT, BLEND_GLSL, type ClassInputs } from '../../../src/world/terrain/blend';

const unit = fc.double({ min: 0, max: 1, noNaN: true });
const half = fc.double({ min: -0.5, max: 0.5, noNaN: true });
const inputs = fc.record<ClassInputs>({
  forest: unit,
  field: unit,
  grass: unit,
  rock: unit,
  snow: unit,
  sand: unit,
  urban: unit,
  slope: unit,
  nb: half,
  nb2: half,
  nSnow: half,
  streak: unit,
  height: fc.double({ min: -50, max: 3500, noNaN: true }),
});

describe('class weights (unit)', () => {
  it('pure farmland stays farmland; a snowfield on a gentle slope is snow; a cliff is rock', () => {
    const base: ClassInputs = { forest: 0, field: 1, grass: 0, rock: 0, snow: 0, sand: 0, urban: 0, slope: 0.01, nb: 0, nb2: 0, nSnow: 0, streak: 0.5, height: 100 };
    const w = new Float32Array(CLASS_COUNT);
    classWeights(base, w);
    expect(w[0]).toBeCloseTo(1, 3);
    classWeights({ ...base, field: 0, snow: 1, height: 2400, slope: 0.1 }, w);
    expect(w[5]).toBeGreaterThan(0.95);
    classWeights({ ...base, field: 0, grass: 1, rock: 0, slope: 0.6, height: 2000 }, w);
    expect(w[3]).toBeGreaterThan(0.85);
    expect(w[5]).toBe(0);
  });
  it('scree appears only on moderate slopes in the high country', () => {
    const w = new Float32Array(CLASS_COUNT);
    const base: ClassInputs = { forest: 0, field: 0, grass: 0, rock: 1, snow: 0, sand: 0, urban: 0, slope: 0.15, nb: 0, nb2: 0, nSnow: 0, streak: 0.5, height: 1800 };
    classWeights(base, w);
    expect(w[4]).toBeGreaterThan(0.5);
    classWeights({ ...base, height: 300 }, w);
    expect(w[4]).toBe(0);
    classWeights({ ...base, slope: 0.7 }, w);
    expect(w[4]).toBe(0);
  });
  it('topTwo finds the two largest', () => {
    expect(topTwo([0.1, 0.5, 0.2, 0, 0, 0.15, 0, 0.05])).toEqual([1, 2]);
    expect(topTwo([0.6, 0.1, 0, 0, 0, 0, 0, 0.3])).toEqual([0, 7]);
  });
});

describe('class weights (fuzz)', () => {
  it('are finite, each in [0, 1], and sum to 1 for any inputs', () => {
    const w = new Float32Array(CLASS_COUNT);
    fc.assert(
      fc.property(inputs, (i) => {
        classWeights(i, w);
        let s = 0;
        for (let k = 0; k < CLASS_COUNT; k++) {
          expect(Number.isFinite(w[k])).toBe(true);
          expect(w[k]).toBeGreaterThanOrEqual(-1e-6);
          expect(w[k]).toBeLessThanOrEqual(1 + 1e-6);
          s += w[k];
        }
        expect(s).toBeCloseTo(1, 4);
      }),
      { numRuns: 3000 },
    );
  });
  it('never paints a class the landcover does not have, whatever the break-up noise (no snow flecks in farmland)', () => {
    const w = new Float32Array(CLASS_COUNT);
    fc.assert(
      fc.property(inputs, (i) => {
        classWeights({ ...i, snow: 0 }, w);
        expect(w[5]).toBeLessThan(1e-9);
        classWeights({ ...i, forest: 0 }, w);
        expect(w[2]).toBeLessThan(1e-9);
        classWeights({ ...i, sand: 0 }, w);
        expect(w[6]).toBeLessThan(1e-9);
        classWeights({ ...i, urban: 0 }, w);
        expect(w[7]).toBeLessThan(1e-9);
        // rock may come from the slope alone (cliffs), never on flat ground without rock landcover
        classWeights({ ...i, rock: 0, slope: Math.min(i.slope, 0.12) }, w);
        expect(w[3] + w[4]).toBeLessThan(1e-9);
      }),
      { numRuns: 3000 },
    );
  });
  it('the worst-case noise leaves lowland farmland untouched', () => {
    const w = new Float32Array(CLASS_COUNT);
    for (const nb of [-0.5, 0.5])
      for (const nb2 of [-0.5, 0.5])
        for (const nSnow of [-0.5, 0.5])
          for (const streak of [0, 1]) {
            classWeights({ forest: 0, field: 0.9, grass: 0.1, rock: 0, snow: 0, sand: 0, urban: 0, slope: 0.02, nb, nb2, nSnow, streak, height: 60 }, w);
            expect(w[0] + w[1]).toBeCloseTo(1, 6);
          }
  });
  it('topTwo returns two distinct indices, the first the maximum', () => {
    fc.assert(
      fc.property(fc.array(unit, { minLength: CLASS_COUNT, maxLength: CLASS_COUNT }), (w) => {
        const [a, b] = topTwo(w);
        expect(a).not.toBe(b);
        expect(w[a]).toBe(Math.max(...w));
        for (let k = 0; k < CLASS_COUNT; k++) if (k !== a) expect(w[b]).toBeGreaterThanOrEqual(w[k]);
      }),
    );
  });
});

describe('height blend (fuzz)', () => {
  const pair = fc.tuple(unit, unit, unit, unit, unit);
  it('is a finite share in [0, 1]', () => {
    fc.assert(
      fc.property(pair, ([a1, h1, a2, h2, fade]) => {
        const b = heightBlend(a1, h1, a2, h2, fade);
        expect(Number.isFinite(b)).toBe(true);
        expect(b).toBeGreaterThanOrEqual(0);
        expect(b).toBeLessThanOrEqual(1);
      }),
      { numRuns: 3000 },
    );
  });
  it('never shows a class with no weight, and is linear without detail', () => {
    fc.assert(
      fc.property(pair, ([a1, h1, a2, h2, fade]) => {
        expect(heightBlend(a1 + 0.01, h1, 0, h2, fade)).toBe(0);
        expect(heightBlend(0, h1, a2 + 0.01, h2, fade)).toBeCloseTo(1, 9);
        const s = a1 + a2;
        if (s > 1e-3) expect(heightBlend(a1, h1, a2, h2, 0)).toBeCloseTo(a2 / s, 9);
      }),
      { numRuns: 2000 },
    );
  });
  it('favours the higher texel: raising class 2 never lowers its share', () => {
    fc.assert(
      fc.property(pair, unit, ([a1, h1, a2, h2, fade], dh) => {
        const b0 = heightBlend(a1, h1, a2, h2 * (1 - dh), fade);
        const b1 = heightBlend(a1, h1, a2, h2, fade);
        expect(b1).toBeGreaterThanOrEqual(b0 - 1e-9);
      }),
      { numRuns: 2000 },
    );
  });
  it('the GLSL twin declares the same functions', () => {
    for (const fn of ['void classWeights(', 'void topTwo(', 'float heightBlend(']) expect(BLEND_GLSL).toContain(fn);
  });
});
