import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { fcParams } from '../../support/fc';
import { fft1d, fft2d, bakeDetailTile, toHalf, fromHalf } from '../../../src/world/water/detail';

describe('fft', () => {
  it('transforms an impulse into a constant and round-trips', () => {
    const n = 16;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    re[0] = 1;
    fft1d(re, im, false);
    for (let i = 0; i < n; i++) {
      expect(re[i]).toBeCloseTo(1, 12);
      expect(im[i]).toBeCloseTo(0, 12);
    }
    fft1d(re, im, true);
    expect(re[0]).toBeCloseTo(1, 12);
    for (let i = 1; i < n; i++) expect(Math.abs(re[i])).toBeLessThan(1e-12);
  });

  it('puts a pure cosine in bins ±k', () => {
    const n = 32;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * 3 * i) / n);
    fft1d(re, im, false);
    for (let i = 0; i < n; i++) {
      const mag = Math.hypot(re[i], im[i]);
      if (i === 3 || i === n - 3) expect(mag).toBeCloseTo(n / 2, 9);
      else expect(mag).toBeLessThan(1e-9);
    }
  });

  it('fuzz: 2D round trip and Parseval', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5 }), fc.integer({ min: 0, max: 1e6 }), (lg, seed) => {
        const n = 1 << lg;
        let s = seed + 1;
        const r = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
        const re = Float64Array.from({ length: n * n }, r);
        const im = Float64Array.from({ length: n * n }, r);
        const re0 = re.slice();
        const im0 = im.slice();
        let e0 = 0;
        for (let i = 0; i < n * n; i++) e0 += re[i] ** 2 + im[i] ** 2;
        fft2d(re, im, n, false);
        let e1 = 0;
        for (let i = 0; i < n * n; i++) e1 += re[i] ** 2 + im[i] ** 2;
        expect(e1 / (n * n)).toBeCloseTo(e0, 6);
        fft2d(re, im, n, true);
        for (let i = 0; i < n * n; i++) {
          expect(re[i]).toBeCloseTo(re0[i], 9);
          expect(im[i]).toBeCloseTo(im0[i], 9);
        }
      }),
      fcParams(40),
    );
  });
});

describe('half floats', () => {
  it('encodes exactly representable values exactly', () => {
    for (const v of [0, 1, -1, 0.5, 2, 1024, -0.25, 65504]) expect(fromHalf(toHalf(v))).toBe(v);
    expect(fromHalf(toHalf(1e6))).toBe(65504); // clamps instead of overflowing to Infinity
    expect(fromHalf(toHalf(-1e6))).toBe(-65504);
  });
  it('fuzz: relative error ≤ 2^-11 in the normal range', () => {
    fc.assert(
      fc.property(fc.double({ min: -60000, max: 60000, noNaN: true }), (v) => {
        const r = fromHalf(toHalf(v));
        if (Math.abs(v) >= 6.2e-5) expect(Math.abs(r - v)).toBeLessThanOrEqual(Math.abs(v) * 2 ** -11 + 1e-12);
        else expect(Math.abs(r - v)).toBeLessThan(1e-7);
      }),
      fcParams(500),
    );
  });
});

describe('detail tile', () => {
  const t = bakeDetailTile(64, 3);

  it('has a full mip chain of RGBA texels', () => {
    expect(t.size).toBe(64);
    expect(t.levels.length).toBe(7); // 64 … 1
    for (let l = 0; l < t.levels.length; l++) expect(t.levels[l].length).toBe((64 >> l) ** 2 * 4);
  });

  it('holds zero-mean slopes normalised to unit RMS per axis', () => {
    const d = t.levels[0];
    let mx = 0;
    let mz = 0;
    let vx = 0;
    let vz = 0;
    const n = 64 * 64;
    for (let i = 0; i < n; i++) {
      mx += d[i * 4];
      mz += d[i * 4 + 1];
      vx += d[i * 4] ** 2;
      vz += d[i * 4 + 1] ** 2;
      expect(d[i * 4 + 2]).toBeCloseTo(d[i * 4] ** 2 + d[i * 4 + 1] ** 2, 5); // float32 storage
    }
    expect(Math.abs(mx / n)).toBeLessThan(1e-6);
    expect(Math.abs(mz / n)).toBeLessThan(1e-6);
    expect((vx + vz) / (2 * n)).toBeCloseTo(1, 5);
    // wind along +x: slopes across the crests (x) dominate
    expect(vx).toBeGreaterThan(vz * 1.3);
  });

  it('is seamless (tileable) and deterministic', () => {
    const d = t.levels[0];
    let wrap = 0;
    let inner = 0;
    for (let j = 0; j < 64; j++) {
      wrap += Math.abs(d[(j * 64 + 63) * 4 + 3] - d[(j * 64) * 4 + 3]);
      inner += Math.abs(d[(j * 64 + 31) * 4 + 3] - d[(j * 64 + 32) * 4 + 3]);
    }
    expect(wrap).toBeLessThan(inner * 2.5);
    expect(bakeDetailTile(64, 3).levels[0]).toEqual(d);
    expect(bakeDetailTile(64, 4).levels[0]).not.toEqual(d);
  });

  it('fuzz: every mip level keeps E[s²] ≥ E[s]² (LEAN variance never negative)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 6 }), fc.integer({ min: 0, max: 10000 }), (lg, seed) => {
        const tile = bakeDetailTile(1 << lg, seed);
        for (const lv of tile.levels)
          for (let i = 0; i < lv.length; i += 4) expect(lv[i + 2] - (lv[i] ** 2 + lv[i + 1] ** 2)).toBeGreaterThanOrEqual(-1e-6 * (1 + lv[i + 2]));
        const last = tile.levels[tile.levels.length - 1];
        expect(Math.abs(last[0])).toBeLessThan(1e-6);
        expect(last[2]).toBeCloseTo(2, 4);
      }),
      fcParams(30),
    );
  });
});
