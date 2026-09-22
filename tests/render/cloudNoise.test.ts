/**
 * Cloud noise volumes (cloudNoise.ts): tileable 3D Perlin / Worley, the shape
 * and detail textures, determinism, tiling and time-sliced generation.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  perlin3,
  worley3,
  createWorleyGrid,
  generateNoiseVolume,
  noiseVolumeJob,
  SHAPE_NOISE,
  DETAIL_NOISE,
  type NoiseVolumeSpec,
} from '../../src/render/cloudNoise';

const small: NoiseVolumeSpec = { ...SHAPE_NOISE, size: 16 };
const smallDetail: NoiseVolumeSpec = { ...DETAIL_NOISE, size: 8 };

describe('tileable gradient noise', () => {
  it('is periodic in every axis with the given period', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 8, noNaN: true }),
        fc.double({ min: 0, max: 8, noNaN: true }),
        fc.double({ min: 0, max: 8, noNaN: true }),
        fc.integer({ min: 2, max: 8 }),
        (x, y, z, p) => {
          const a = perlin3(x, y, z, p, 5);
          expect(perlin3(x + p, y, z, p, 5)).toBeCloseTo(a, 9);
          expect(perlin3(x, y + p, z, p, 5)).toBeCloseTo(a, 9);
          expect(perlin3(x, y, z + p, p, 5)).toBeCloseTo(a, 9);
        },
      ),
    );
  });
  it('stays in [-1, 1] and is zero on lattice points', () => {
    fc.assert(
      fc.property(fc.double({ min: -50, max: 50, noNaN: true }), fc.double({ min: -50, max: 50, noNaN: true }), fc.double({ min: -50, max: 50, noNaN: true }), (x, y, z) => {
        const v = perlin3(x, y, z, 7, 1);
        expect(Number.isFinite(v)).toBe(true);
        expect(Math.abs(v)).toBeLessThanOrEqual(1);
      }),
    );
    expect(perlin3(3, 4, 5, 8, 2)).toBeCloseTo(0, 12);
  });
  it('depends on the seed', () => {
    expect(perlin3(0.3, 0.6, 0.1, 4, 1)).not.toBeCloseTo(perlin3(0.3, 0.6, 0.1, 4, 2), 6);
  });
});

describe('tileable Worley noise', () => {
  it('is periodic and in [0, 1] (1 at feature points, falling with distance)', () => {
    const g = createWorleyGrid(5, 3);
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }), (x, y, z) => {
        const a = worley3(g, x, y, z);
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThanOrEqual(1);
        expect(worley3(g, x + 1, y, z)).toBeCloseTo(a, 9);
        expect(worley3(g, x, y - 1, z)).toBeCloseTo(a, 9);
        expect(worley3(g, x, y, z + 2)).toBeCloseTo(a, 9);
      }),
    );
    // at a feature point the value is 1
    const fx = g.points[0] / g.cells;
    const fy = g.points[1] / g.cells;
    const fz = g.points[2] / g.cells;
    expect(worley3(g, fx, fy, fz)).toBeCloseTo(1, 9);
  });
});

describe('noise volumes', () => {
  it('are deterministic for a seed and differ between seeds', () => {
    const a = generateNoiseVolume(small, 7);
    const b = generateNoiseVolume(small, 7);
    const c = generateNoiseVolume(small, 8);
    expect(a.length).toBe(16 * 16 * 16 * 4);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(Buffer.from(a).equals(Buffer.from(c))).toBe(false);
  });
  it('use the full byte range in every channel (not flat)', () => {
    const v = generateNoiseVolume(small, 3);
    for (let ch = 0; ch < 4; ch++) {
      let lo = 255, hi = 0;
      for (let i = ch; i < v.length; i += 4) {
        lo = Math.min(lo, v[i]);
        hi = Math.max(hi, v[i]);
      }
      expect(hi - lo).toBeGreaterThan(90);
    }
  });
  it('tile seamlessly: opposite faces are as similar as neighbouring slices', () => {
    const n = 16;
    const v = generateNoiseVolume(small, 11);
    const at = (x: number, y: number, z: number) => v[((z * n + y) * n + x) * 4];
    let wrap = 0, inner = 0;
    for (let z = 0; z < n; z++)
      for (let y = 0; y < n; y++) {
        wrap += Math.abs(at(n - 1, y, z) - at(0, y, z));
        inner += Math.abs(at(n / 2, y, z) - at(n / 2 + 1, y, z));
      }
    expect(wrap).toBeLessThan(inner * 1.6);
  });
  it('the time-sliced job yields per block of rows + once per channel stretch, and produces the same bytes', () => {
    const out = new Uint8Array(8 * 8 * 8 * 4);
    const job = noiseVolumeJob(smallDetail, 4, out, 4);
    let yields = 0;
    for (let r = job.next(); !r.done; r = job.next()) yields++;
    expect(yields).toBe(8 * 2 + 4);
    expect(Buffer.from(out).equals(Buffer.from(generateNoiseVolume(smallDetail, 4)))).toBe(true);
  });
});
