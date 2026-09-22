import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  lodParams,
  lodForDistance,
  lodWeights,
  keepFraction,
  thinCompensation,
  chunksInRange,
  rectDistance,
} from '../../../src/world/vegetation/lod';

const P = lodParams();

describe('LOD selection by distance', () => {
  it('mesh near, impostor mid, nothing far', () => {
    expect(lodForDistance(0, P)).toBe('mesh');
    expect(lodForDistance(P.meshDistance - P.lodFadeBand - 1, P)).toBe('mesh');
    expect(lodForDistance(P.meshDistance + 1, P)).toBe('impostor');
    expect(lodForDistance((P.meshDistance + P.viewDistance) / 2, P)).toBe('impostor');
    expect(lodForDistance(P.viewDistance + 1, P)).toBe('none');
    expect(lodForDistance(1e9, P)).toBe('none');
  });

  it('the cross-fade weights are complementary inside the view distance', () => {
    const w = { mesh: 0, impostor: 0 };
    lodWeights(P.meshDistance - P.lodFadeBand / 2, P, w);
    expect(w.mesh).toBeGreaterThan(0);
    expect(w.impostor).toBeGreaterThan(0);
    expect(w.mesh + w.impostor).toBeCloseTo(1, 9);
  });

  it('fuzz: mesh weight non-increasing, weights in [0,1], sum 1 below the view distance', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 20000, noNaN: true }), fc.double({ min: 0, max: 20000, noNaN: true }), (a, b) => {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const wl = { mesh: 0, impostor: 0 };
        const wh = { mesh: 0, impostor: 0 };
        lodWeights(lo, P, wl);
        lodWeights(hi, P, wh);
        expect(wl.mesh).toBeGreaterThanOrEqual(wh.mesh);
        for (const w of [wl, wh]) {
          expect(w.mesh).toBeGreaterThanOrEqual(0);
          expect(w.mesh).toBeLessThanOrEqual(1);
          expect(w.impostor).toBeGreaterThanOrEqual(0);
          expect(w.impostor).toBeLessThanOrEqual(1);
        }
        if (lo < P.viewDistance) expect(wl.mesh + wl.impostor).toBeCloseTo(1, 9);
        if (hi >= P.viewDistance) expect(wh.impostor).toBe(0);
      }),
    );
  });

  it('fuzz: lodForDistance is monotone (mesh → impostor → none)', () => {
    const order = { mesh: 0, impostor: 1, none: 2 } as const;
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1e5, noNaN: true }), fc.double({ min: 0, max: 1e5, noNaN: true }), (a, b) => {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        expect(order[lodForDistance(lo, P)]).toBeLessThanOrEqual(order[lodForDistance(hi, P)]);
      }),
    );
  });
});

describe('far thinning', () => {
  it('keeps everything up to the thinning distance, nothing at the view distance', () => {
    expect(keepFraction(0, P, 1)).toBe(1);
    expect(keepFraction(P.thinStartDistance, P, 1)).toBe(1);
    expect(keepFraction(P.viewDistance, P, 1)).toBe(0);
    expect(keepFraction(P.viewDistance * 2, P, 1)).toBe(0);
    expect(keepFraction(P.thinStartDistance * 2, P, 1)).toBeLessThan(1);
  });

  it('fuzz: keep fraction in [0, capScale], non-increasing with distance; compensation ≥ 1 and capped', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 10000, noNaN: true }),
        fc.double({ min: 0, max: 10000, noNaN: true }),
        fc.double({ min: 0.05, max: 1, noNaN: true }),
        (a, b, cap) => {
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          const kl = keepFraction(lo, P, cap);
          const kh = keepFraction(hi, P, cap);
          expect(kl).toBeGreaterThanOrEqual(kh);
          expect(kl).toBeLessThanOrEqual(cap + 1e-12);
          expect(kh).toBeGreaterThanOrEqual(0);
          const cl = thinCompensation(lo, P);
          const ch = thinCompensation(hi, P);
          expect(cl).toBeGreaterThanOrEqual(1);
          expect(ch).toBeGreaterThanOrEqual(cl);
          expect(ch).toBeLessThanOrEqual(P.thinCompensationMax + 1e-12);
        },
      ),
    );
  });
});

describe('chunk ranges', () => {
  it('rectDistance is 0 inside and Euclidean outside', () => {
    expect(rectDistance(5, 5, 0, 0, 10, 10)).toBe(0);
    expect(rectDistance(13, 14, 0, 0, 10, 10)).toBeCloseTo(5, 9);
    expect(rectDistance(-3, 5, 0, 0, 10, 10)).toBeCloseTo(3, 9);
  });

  it('fuzz: every point within the radius lies in a listed chunk; list sorted and within range', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -50000, max: 50000, noNaN: true }),
        fc.double({ min: -50000, max: 50000, noNaN: true }),
        fc.double({ min: 100, max: 5000, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: Math.PI * 2, noNaN: true }),
        (x, z, radius, rf, ang) => {
          const size = 1024;
          const list = chunksInRange(x, z, radius, size);
          for (let i = 1; i < list.length; i++) expect(list[i].dist).toBeGreaterThanOrEqual(list[i - 1].dist);
          for (const c of list) expect(c.dist).toBeLessThanOrEqual(radius);
          const px = x + Math.cos(ang) * radius * rf * 0.999;
          const pz = z + Math.sin(ang) * radius * rf * 0.999;
          const kx = Math.floor(px / size);
          const kz = Math.floor(pz / size);
          expect(list.some((c) => c.kx === kx && c.kz === kz)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });
});
