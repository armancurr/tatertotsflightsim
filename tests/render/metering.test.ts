import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { adaptStep, meterTrim } from '../../src/render/metering';
import { CONFIG } from '../../src/config';

const cfg = CONFIG.render.metering;

describe('eye adaptation: metering trim', () => {
  it('leaves a typical frame alone (exposed mean = key → no trim)', () => {
    const ex = 2.2;
    const avgLog2 = Math.log2(cfg.key / ex);
    expect(meterTrim(avgLog2, ex)).toBeCloseTo(0, 9);
  });
  it('stops down for a bright frame (into the sun, a wall of cloud) and opens up for a dark one (cockpit)', () => {
    const ex = 2.2;
    expect(meterTrim(Math.log2((cfg.key * 2) / ex), ex)).toBeLessThan(0);
    expect(meterTrim(Math.log2((cfg.key / 2) / ex), ex)).toBeGreaterThan(0);
    // partial: a frame 2× too bright is trimmed by less than a full stop
    expect(meterTrim(Math.log2((cfg.key * 2) / ex), ex)).toBeGreaterThan(-1);
  });
  it('is finite, clamped and non-increasing in the metered brightness for any input (property)', () => {
    const lo = Math.log2(cfg.min);
    const hi = Math.log2(cfg.max);
    fc.assert(
      fc.property(fc.oneof(fc.double(), fc.double({ min: -20, max: 20, noNaN: true })), fc.double({ min: 0, max: 5, noNaN: true }), fc.oneof(fc.double(), fc.double({ min: 0.01, max: 50, noNaN: true })), (m, dm, ex) => {
        const t = meterTrim(m, ex);
        expect(Number.isFinite(t)).toBe(true);
        expect(t).toBeGreaterThanOrEqual(lo - 1e-12);
        expect(t).toBeLessThanOrEqual(hi + 1e-12);
        if (Number.isFinite(m) && ex > 0 && Number.isFinite(ex)) expect(meterTrim(m + dm, ex)).toBeLessThanOrEqual(t + 1e-12);
      }),
      { numRuns: 500 },
    );
  });
});

describe('eye adaptation: easing', () => {
  it('moves toward the target, faster when darkening than when brightening', () => {
    const down = adaptStep(0, -1, 0.1);
    const up = adaptStep(0, 1, 0.1);
    expect(down).toBeLessThan(0);
    expect(down).toBeGreaterThan(-1);
    expect(up).toBeGreaterThan(0);
    expect(Math.abs(down)).toBeGreaterThan(Math.abs(up));
  });
  it('converges over a few seconds of frames and never overshoots (functional)', () => {
    let a = 0;
    let maxA = 0;
    for (let i = 0; i < 600; i++) {
      a = adaptStep(a, 0.5, 1 / 60);
      maxA = Math.max(maxA, a);
    }
    expect(a).toBeCloseTo(0.5, 2);
    expect(maxA).toBeLessThanOrEqual(0.5 + 1e-12);
  });
  it('stays between the previous value and the target, finite for any input (property)', () => {
    fc.assert(
      fc.property(fc.oneof(fc.double(), fc.double({ min: -3, max: 3, noNaN: true })), fc.oneof(fc.double(), fc.double({ min: -3, max: 3, noNaN: true })), fc.oneof(fc.double(), fc.double({ min: 0, max: 5, noNaN: true })), (p, t, dt) => {
        const a = adaptStep(p, t, dt);
        expect(Number.isFinite(a) || (!Number.isFinite(p) && !Number.isFinite(t))).toBe(true);
        if (Number.isFinite(p) && Number.isFinite(t)) {
          expect(a).toBeGreaterThanOrEqual(Math.min(p, t) - 1e-9);
          expect(a).toBeLessThanOrEqual(Math.max(p, t) + 1e-9);
        }
      }),
      { numRuns: 500 },
    );
  });
});
