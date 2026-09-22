/**
 * Raymarch math (cloudMarch.ts) — the TypeScript mirror of the GLSL in
 * volumetricClouds.ts: slab intersection, the distance-adaptive step schedule,
 * phase functions, Beer–powder and multiple-scattering octaves, and depth
 * linearisation.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  intersectSlab,
  nextStep,
  marchSchedule,
  henyeyGreenstein,
  cloudPhase,
  beerPowder,
  multiScatterLight,
  linearDepth,
  layerEntryDistance,
  DEFAULT_MARCH,
} from '../../src/render/cloudMarch';

const dirArb = fc
  .tuple(fc.double({ min: -1, max: 1, noNaN: true }), fc.double({ min: -1, max: 1, noNaN: true }), fc.double({ min: -1, max: 1, noNaN: true }))
  .filter(([x, y, z]) => x * x + y * y + z * z > 1e-3)
  .map(([x, y, z]) => {
    const l = Math.hypot(x, y, z);
    return { x: x / l, y: y / l, z: z / l };
  });

describe('slab intersection', () => {
  it('camera below the layer looking up enters at the base and leaves at the top', () => {
    const r = { t0: 0, t1: 0 };
    intersectSlab(500, 1, 1500, 3500, r);
    expect(r.t0).toBeCloseTo(1000, 9);
    expect(r.t1).toBeCloseTo(3000, 9);
    intersectSlab(500, 0.5, 1500, 3500, r);
    expect(r.t0).toBeCloseTo(2000, 9);
    expect(r.t1).toBeCloseTo(6000, 9);
  });
  it('camera inside starts at 0; looking away from the layer misses', () => {
    const r = { t0: 0, t1: 0 };
    intersectSlab(2000, 0.2, 1500, 3500, r);
    expect(r.t0).toBe(0);
    expect(r.t1).toBeCloseTo(7500, 9);
    intersectSlab(500, -0.3, 1500, 3500, r);
    expect(r.t1).toBeLessThanOrEqual(r.t0);
    intersectSlab(5000, 0.3, 1500, 3500, r);
    expect(r.t1).toBeLessThanOrEqual(r.t0);
  });
  it('property: horizontal rays inside the layer run to infinity; hits lie on the slab boundary', () => {
    fc.assert(
      fc.property(fc.double({ min: -2000, max: 9000, noNaN: true }), dirArb, (y, d) => {
        const r = { t0: 0, t1: 0 };
        intersectSlab(y, d.y, 1500, 3500, r);
        expect(Number.isNaN(r.t0) || Number.isNaN(r.t1)).toBe(false);
        if (r.t1 > r.t0 && Number.isFinite(r.t1)) {
          const yEnd = y + d.y * r.t1;
          expect(yEnd).toBeGreaterThanOrEqual(1500 - 1e-3);
          expect(yEnd).toBeLessThanOrEqual(3500 + 1e-3);
          const yStart = y + d.y * r.t0;
          expect(yStart).toBeGreaterThanOrEqual(1500 - 1e-3);
          expect(yStart).toBeLessThanOrEqual(3500 + 1e-3);
        }
      }),
    );
  });
});

describe('step schedule', () => {
  it('steps grow with distance, bounded by dtMin / dtMax', () => {
    expect(nextStep(0, DEFAULT_MARCH)).toBe(DEFAULT_MARCH.dtMin);
    expect(nextStep(1e7, DEFAULT_MARCH)).toBe(DEFAULT_MARCH.dtMax);
    expect(nextStep(2000, DEFAULT_MARCH)).toBeCloseTo(2000 * DEFAULT_MARCH.k, 9);
  });
  it('property: samples are strictly increasing, inside [t0, t1], at most maxSteps, and cover the segment when the budget allows', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 30000, noNaN: true }),
        fc.double({ min: 1, max: 60000, noNaN: true }),
        fc.double({ min: 0, max: 0.999, noNaN: true }),
        (t0, len, jitter) => {
          const t1 = t0 + len;
          const out = new Float64Array(DEFAULT_MARCH.maxSteps * 2 + 2);
          const n = marchSchedule(t0, t1, jitter, DEFAULT_MARCH, out);
          expect(n).toBeGreaterThan(0);
          expect(n).toBeLessThanOrEqual(DEFAULT_MARCH.maxSteps);
          let prev = -Infinity;
          let covered = 0;
          for (let i = 0; i < n; i++) {
            const t = out[i * 2];
            const dt = out[i * 2 + 1];
            expect(t).toBeGreaterThan(prev);
            expect(t).toBeGreaterThanOrEqual(t0 - 1e-6);
            expect(t).toBeLessThanOrEqual(t1 + 1e-6);
            expect(dt).toBeGreaterThan(0);
            covered += dt;
            prev = t;
          }
          if (n < DEFAULT_MARCH.maxSteps) expect(covered).toBeCloseTo(len, 3);
          else expect(covered).toBeLessThanOrEqual(len + 1e-3);
        },
      ),
    );
  });
  it('a 2 km vertical crossing inside a cloud gets ≥ 40 samples, with fine steps near the camera; empty air is crossed in few steps', () => {
    const out = new Float64Array(400);
    const n = marchSchedule(1000, 3000, 0.5, DEFAULT_MARCH, out, () => true);
    expect(n).toBeGreaterThanOrEqual(40);
    const m = marchSchedule(0, 3000, 0.5, DEFAULT_MARCH, out, () => true);
    expect(out[1]).toBeLessThanOrEqual(DEFAULT_MARCH.dtMin + 1e-9);
    expect(m).toBeGreaterThan(40);
    // looking along the layer from inside, empty air: 30 km fits in the budget
    const e = marchSchedule(0, 30000, 0.5, DEFAULT_MARCH, out);
    expect(e).toBeLessThan(DEFAULT_MARCH.maxSteps);
  });
});

describe('phase and lighting', () => {
  const integrate = (f: (mu: number) => number) => {
    // ∫ f dω = 2π ∫_{-1}^{1} f(μ) dμ
    const N = 20000;
    let s = 0;
    for (let i = 0; i < N; i++) {
      const mu = -1 + ((i + 0.5) / N) * 2;
      s += f(mu);
    }
    return (2 * Math.PI * s * 2) / N;
  };
  it('Henyey–Greenstein and the dual-lobe cloud phase are normalised', () => {
    for (const g of [-0.3, 0, 0.5, 0.8]) expect(integrate((mu) => henyeyGreenstein(mu, g))).toBeCloseTo(1, 2);
    expect(integrate((mu) => cloudPhase(mu, 0.8, -0.3, 0.3))).toBeCloseTo(1, 2);
  });
  it('the cloud phase is strongly forward (silver lining) with some back-scatter', () => {
    expect(cloudPhase(1, 0.8, -0.3, 0.3)).toBeGreaterThan(20 * cloudPhase(0, 0.8, -0.3, 0.3));
    expect(cloudPhase(-1, 0.8, -0.3, 0.3)).toBeGreaterThan(cloudPhase(0, 0.8, -0.3, 0.3));
  });
  it('Beer–powder: 0 at no density and at infinite depth, max at moderate optical depth; in [0, 1]', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1e4, noNaN: true }), fc.double({ min: 0, max: 50, noNaN: true }), (tau, local) => {
        const v = beerPowder(tau, local);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }),
    );
    expect(beerPowder(1e3, 1)).toBeLessThan(1e-6);
    expect(beerPowder(0, 5)).toBeCloseTo(1, 3);
    expect(beerPowder(0, 0)).toBe(0);
  });
  it('multiple-scattering octaves brighten deep interiors vs single scattering, never exceed the unattenuated sum', () => {
    const single = Math.exp(-8) * henyeyGreenstein(0.2, 0.8);
    const ms = multiScatterLight(8, 0.2, 0.8, -0.3, 0.3, 3);
    expect(ms).toBeGreaterThan(single * 5);
    fc.assert(
      fc.property(fc.double({ min: 0, max: 200, noNaN: true }), fc.double({ min: -1, max: 1, noNaN: true }), (tau, mu) => {
        const v = multiScatterLight(tau, mu, 0.8, -0.3, 0.3, 3);
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        let max = 0;
        for (let i = 0; i < 3; i++) max += 0.5 ** i * cloudPhase(mu, 0.8 * 0.5 ** i, -0.3 * 0.5 ** i, 0.3);
        expect(v).toBeLessThanOrEqual(max + 1e-9);
      }),
    );
  });
});

describe('depth', () => {
  it('reversed depth: 1 at near, 0 at far/infinity, monotonic', () => {
    expect(linearDepth(1, 0.1, 90000, 'reversed')).toBeCloseTo(0.1, 6);
    expect(linearDepth(0, 0.1, 90000, 'reversed')).toBe(Infinity);
    const n = 0.1, f = 90000;
    for (const z of [0.5, 3, 40, 900, 12000, 80000]) {
      const d = (n * (f / z - 1)) / (f - n);
      expect(linearDepth(d, n, f, 'reversed')).toBeCloseTo(z, 3);
    }
  });
  it('standard and logarithmic depth round-trip', () => {
    const n = 0.1, f = 90000;
    for (const z of [0.5, 3, 40, 900, 12000]) {
      const ndc = (f + n) / (f - n) - (2 * f * n) / ((f - n) * z);
      expect(linearDepth(ndc * 0.5 + 0.5, n, f, 'standard')).toBeCloseTo(z, 1);
      const logd = Math.log2(1 + z) / Math.log2(f + 1);
      expect(linearDepth(logd, n, f, 'logarithmic')).toBeCloseTo(z, 3);
    }
  });
  it('layer entry distance: 0 inside, along the ray below/above, Infinity when moving away', () => {
    expect(layerEntryDistance(2000, 0.3, 1500, 3500)).toBe(0);
    expect(layerEntryDistance(500, 0.5, 1500, 3500)).toBeCloseTo(2000, 9);
    expect(layerEntryDistance(5000, -0.5, 1500, 3500)).toBeCloseTo(3000, 9);
    expect(layerEntryDistance(500, -0.1, 1500, 3500)).toBe(Infinity);
    expect(layerEntryDistance(5000, 0.1, 1500, 3500)).toBe(Infinity);
  });
});
