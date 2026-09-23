import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { bloomLevels, bloomWeight } from '../../src/render/bloom';
import { bloomForQuality } from '../../src/render/post';
import { CONFIG } from '../../src/config';

describe('bloom mip chain', () => {
  it('starts at half resolution and halves down to ~1/32 at 1440×900', () => {
    const l = bloomLevels(1440, 900);
    expect(l[0]).toEqual({ width: 720, height: 450 });
    expect(l.length).toBe(5);
    expect(l[4]).toEqual({ width: 45, height: 29 });
  });
  it('stops before a side drops below the minimum, always keeps the ½-res level', () => {
    expect(bloomLevels(40, 20).length).toBe(1);
    expect(bloomLevels(1, 1)).toEqual([{ width: 1, height: 1 }]);
    expect(bloomLevels(64, 64, 5, 8).map((s) => s.width)).toEqual([32, 16, 8]);
  });
  it('is well-formed for any size (property)', () => {
    fc.assert(
      fc.property(fc.oneof(fc.double(), fc.integer({ min: -10, max: 9000 })), fc.oneof(fc.double(), fc.integer({ min: -10, max: 9000 })), fc.integer({ min: 0, max: 12 }), (w, h, n) => {
        const l = bloomLevels(w, h, n);
        expect(l.length).toBeLessThanOrEqual(Math.min(8, n));
        for (let i = 0; i < l.length; i++) {
          expect(Number.isInteger(l[i].width) && l[i].width >= 1).toBe(true);
          expect(Number.isInteger(l[i].height) && l[i].height >= 1).toBe(true);
          if (i > 0) {
            expect(l[i].width).toBeLessThanOrEqual(l[i - 1].width);
            expect(l[i].height).toBeLessThanOrEqual(l[i - 1].height);
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe('bloom soft-knee threshold', () => {
  it('is zero well below the threshold and approaches 1 far above it', () => {
    expect(bloomWeight(0.2, 1.2, 0.6)).toBe(0);
    expect(bloomWeight(0.6, 1.2, 0.6)).toBe(0);
    expect(bloomWeight(1.2, 1.2, 0.6)).toBeGreaterThan(0);
    expect(bloomWeight(100, 1.2, 0.6)).toBeGreaterThan(0.98);
  });
  it('bloomed energy b·w(b) is finite, in [0, b], continuous and non-decreasing in b (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1e4, noNaN: true }),
        fc.double({ min: 1e-4, max: 1, noNaN: true }),
        fc.double({ min: 0.1, max: 5, noNaN: true }),
        fc.double({ min: 0, max: 2, noNaN: true }),
        (b, db, t, k) => {
          const w = bloomWeight(b, t, k);
          expect(Number.isFinite(w)).toBe(true);
          expect(w).toBeGreaterThanOrEqual(0);
          expect(w).toBeLessThanOrEqual(1);
          expect((b + db) * bloomWeight(b + db, t, k)).toBeGreaterThanOrEqual(b * w - 1e-9);
          // continuity: a small step never jumps
          const e = 1e-6;
          expect(Math.abs((b + e) * bloomWeight(b + e, t, k) - b * w)).toBeLessThan(1e-3);
        },
      ),
      { numRuns: 400 },
    );
  });
  it('handles junk input', () => {
    for (const b of [NaN, -1, 0, -Infinity]) expect(bloomWeight(b, 1, 0.5)).toBe(0);
    expect(bloomWeight(Infinity, 1, 0.5)).toBe(1);
  });
});

describe('bloom and the quality presets', () => {
  it('is on for auto/medium/high on a real GPU and off for low and software rendering', () => {
    const on = CONFIG.render.bloom.intensity;
    expect(on).toBeGreaterThan(0);
    expect(bloomForQuality({ level: 'high', tier: 'standard' })).toBe(on);
    expect(bloomForQuality({ level: 'auto', tier: 'low' })).toBe(on);
    expect(bloomForQuality({ level: 'medium', tier: 'standard' })).toBe(on);
    expect(bloomForQuality({ level: 'low', tier: 'standard' })).toBe(0);
    expect(bloomForQuality({ level: 'auto', tier: 'software' })).toBe(0);
  });
});
