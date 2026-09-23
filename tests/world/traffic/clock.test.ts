import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createTrafficClock, parseTrafficTime } from '../../../src/world/traffic/clock';

describe('traffic clock', () => {
  it('advances with the frame time and stops while paused', () => {
    const c = createTrafficClock(100);
    expect(c.t).toBe(100);
    expect(c.advance(0.5, false)).toBeCloseTo(0.5);
    expect(c.t).toBeCloseTo(100.5);
    expect(c.advance(0.5, true)).toBe(0);
    expect(c.t).toBeCloseTo(100.5);
  });

  it('clamps long frames (tab switches) and ignores bad frame times', () => {
    const c = createTrafficClock(0, 0.25);
    expect(c.advance(10, false)).toBeCloseTo(0.25);
    expect(c.advance(Number.NaN, false)).toBe(0);
    expect(c.advance(-1, false)).toBe(0);
    expect(c.advance(Infinity, false)).toBe(0);
    expect(c.t).toBeCloseTo(0.25);
    c.set(42);
    expect(c.t).toBe(42);
    c.set(Number.NaN);
    expect(c.t).toBe(42);
  });

  it('?tt=<s> overrides the start time (finite, ≥ 0)', () => {
    expect(parseTrafficTime('?tt=1234.5')).toBe(1234.5);
    expect(parseTrafficTime('?veil=0&tt=60&pause=1')).toBe(60);
    expect(parseTrafficTime('?tt=abc')).toBeNull();
    expect(parseTrafficTime('?tt=-5')).toBeNull();
    expect(parseTrafficTime('')).toBeNull();
    expect(parseTrafficTime(undefined)).toBeNull();
  });

  it('fuzz: the clock never runs backwards and never jumps more than the clamp', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.double({ min: -5, max: 50 }), fc.boolean()), { maxLength: 200 }), (frames) => {
        const c = createTrafficClock(0, 1);
        let prev = c.t;
        for (const [dt, paused] of frames) {
          const step = c.advance(dt, paused);
          expect(step).toBeGreaterThanOrEqual(0);
          expect(step).toBeLessThanOrEqual(1);
          expect(c.t - prev).toBeCloseTo(step, 9);
          if (paused) expect(step).toBe(0);
          prev = c.t;
        }
      }),
      { numRuns: 200 },
    );
  });
});
