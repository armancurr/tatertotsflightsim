import { describe, it, expect } from 'vitest';
import {
  mulberry32,
  hash2i,
  createSimplex2D,
  simplex2Deriv,
  fbm,
  ridged,
  erodedFbm,
  warp,
  slopeLimitedFbm,
} from '../../src/world/noise';

describe('seeded PRNG', () => {
  it('is deterministic and in [0,1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 1000; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });
  it('hash2i is a stable integer hash in [0,1)', () => {
    expect(hash2i(3, 7, 1)).toBe(hash2i(3, 7, 1));
    expect(hash2i(3, 7, 1)).not.toBe(hash2i(7, 3, 1));
    for (let i = -50; i < 50; i++) {
      const v = hash2i(i, i * 3 + 1, 9);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('simplex 2D noise', () => {
  const n = createSimplex2D(1234);
  it('is deterministic for a seed and differs across seeds', () => {
    const m = createSimplex2D(1234);
    const o = createSimplex2D(999);
    let diff = 0;
    for (let i = 0; i < 200; i++) {
      const x = i * 0.37 - 20;
      const y = i * 0.11 + 5;
      expect(n(x, y)).toBe(m(x, y));
      diff += Math.abs(n(x, y) - o(x, y));
    }
    expect(diff).toBeGreaterThan(10);
  });
  it('stays in [-1, 1] and uses most of the range', () => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < 100000; i++) {
      const v = n(i * 0.1731, i * 0.0917 - 300);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    expect(lo).toBeGreaterThanOrEqual(-1);
    expect(hi).toBeLessThanOrEqual(1);
    expect(hi - lo).toBeGreaterThan(1.4);
  });
  it('is continuous (small steps give small changes)', () => {
    for (let i = 0; i < 5000; i++) {
      const x = i * 0.713 - 1000;
      const y = i * 0.291 + 77;
      expect(Math.abs(n(x + 1e-3, y) - n(x, y))).toBeLessThan(0.01);
      expect(Math.abs(n(x, y + 1e-3) - n(x, y))).toBeLessThan(0.01);
    }
  });
  it('works far from the origin', () => {
    const v = n(1.0e6 + 0.5, -2.5e6 + 0.25);
    expect(Number.isFinite(v)).toBe(true);
    expect(Math.abs(v)).toBeLessThanOrEqual(1);
  });
  it('derivative variant matches the value and finite differences', () => {
    const out = { v: 0, dx: 0, dy: 0 };
    const perm = createSimplex2D(77);
    for (let i = 0; i < 500; i++) {
      const x = i * 0.519 - 60;
      const y = i * 0.233 + 12;
      simplex2Deriv(perm, x, y, out);
      expect(out.v).toBeCloseTo(perm(x, y), 10);
      const e = 1e-5;
      const fdx = (perm(x + e, y) - perm(x - e, y)) / (2 * e);
      const fdy = (perm(x, y + e) - perm(x, y - e)) / (2 * e);
      expect(out.dx).toBeCloseTo(fdx, 3);
      expect(out.dy).toBeCloseTo(fdy, 3);
    }
  });
  it('is fast (millions of samples per second)', () => {
    let s = 0;
    for (let i = 0; i < 200000; i++) s += n(i * 0.01, i * 0.013); // warm up the JIT
    const N = 2_000_000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) s += n(i * 0.0137, i * 0.0071);
    const dt = (performance.now() - t0) / 1000;
    expect(Number.isFinite(s)).toBe(true);
    expect(N / dt).toBeGreaterThan(5_000_000);
  });
});

describe('fractal helpers', () => {
  const n = createSimplex2D(5);
  it('fbm is deterministic, bounded and continuous', () => {
    for (let i = 0; i < 2000; i++) {
      const x = i * 0.31;
      const y = i * -0.17;
      const v = fbm(n, x, y, 6);
      expect(v).toBe(fbm(n, x, y, 6));
      expect(Math.abs(v)).toBeLessThanOrEqual(1);
      expect(Math.abs(fbm(n, x + 1e-3, y, 6) - v)).toBeLessThan(0.05);
    }
  });
  it('ridged multifractal is in [0,1] with sharp ridges', () => {
    let hi = 0;
    for (let i = 0; i < 20000; i++) {
      const v = ridged(n, i * 0.05, i * 0.031, 6);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      hi = Math.max(hi, v);
    }
    expect(hi).toBeGreaterThan(0.5);
  });
  it('eroded fbm is bounded and continuous', () => {
    for (let i = 0; i < 2000; i++) {
      const x = i * 0.29 + 3;
      const y = i * 0.21 - 9;
      const v = erodedFbm(n, x, y, 6);
      expect(Math.abs(v)).toBeLessThanOrEqual(1);
      expect(Math.abs(erodedFbm(n, x + 1e-3, y, 6) - v)).toBeLessThan(0.05);
    }
  });
  it('domain warp displaces points smoothly and deterministically', () => {
    const out = { x: 0, y: 0 };
    warp(n, 10, 20, 0.5, 3, out);
    const a = { x: out.x, y: out.y };
    warp(n, 10, 20, 0.5, 3, out);
    expect(out).toEqual(a);
    expect(Math.hypot(a.x - 10, a.y - 20)).toBeGreaterThan(0);
    expect(Math.hypot(a.x - 10, a.y - 20)).toBeLessThanOrEqual(3 * Math.SQRT2 + 1e-9);
    warp(n, 10.001, 20, 0.5, 3, out);
    expect(Math.hypot(out.x - a.x - 0.001, out.y - a.y)).toBeLessThan(0.01);
  });
});

describe('slope-limited fBm', () => {
  const n = createSimplex2D(31);
  it('is deterministic, continuous and bounded by its amplitude sum', () => {
    for (let i = 0; i < 2000; i++) {
      const x = i * 37.1 - 20000;
      const z = i * -23.3 + 900;
      const h = slopeLimitedFbm(n, x, z, 1000, 9000, 8, 0.5, 0.8);
      expect(h).toBe(slopeLimitedFbm(n, x, z, 1000, 9000, 8, 0.5, 0.8));
      expect(Math.abs(h)).toBeLessThanOrEqual(2000);
      expect(Math.abs(slopeLimitedFbm(n, x + 0.01, z, 1000, 9000, 8, 0.5, 0.8) - h)).toBeLessThan(0.1);
    }
  });
  it('keeps slopes near the limit even with large amplitudes', () => {
    const slopes: number[] = [];
    for (let z = -20000; z < 0; z += 97)
      for (let x = -20000; x < 20000; x += 263) {
        const h = slopeLimitedFbm(n, x, z, 1300, 10000, 8, 0.5, 0.7);
        slopes.push(Math.max(Math.abs(slopeLimitedFbm(n, x + 1, z, 1300, 10000, 8, 0.5, 0.7) - h), Math.abs(slopeLimitedFbm(n, x, z + 1, 1300, 10000, 8, 0.5, 0.7) - h)));
      }
    slopes.sort((a, b) => a - b);
    expect(slopes[Math.floor(slopes.length * 0.99)]).toBeLessThan(0.7 * 2.2);
    expect(slopes[slopes.length - 1]).toBeLessThan(0.7 * 3);
  });
});
