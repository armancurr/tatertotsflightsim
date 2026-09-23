/**
 * Unit + fuzz: the glowing-streak pool (sparks and ricochets): preallocated, oldest recycled when
 * full, gravity + drag + one bounce, heat cooling, everything dies and nothing goes NaN.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { StreakPool } from '../../../src/combat/fx/streaks';

const DT = 1 / 60;
const run = (p: StreakPool, s: number, g = -1e9) => {
  for (let i = 0; i < Math.round(s / DT); i++) p.step(DT, g);
};

describe('StreakPool', () => {
  it('a spark flies, falls under gravity, cools and dies', () => {
    const p = new StreakPool(8);
    const i = p.emit(0, 1, 0, 10, 10, 0, 1.0, 0.05, 1.3, 0.5, 9.81, 0.5);
    expect(p.count).toBe(1);
    run(p, 0.3);
    expect(p.px[i]).toBeGreaterThan(1);
    expect(p.py[i]).toBeGreaterThan(1);
    const h1 = p.heatOf(i);
    run(p, 0.3);
    expect(p.heatOf(i)).toBeLessThan(h1);
    expect(p.vy[i]).toBeLessThan(10 - 9.81 * 0.55);
    run(p, 1);
    expect(p.count).toBe(0);
  });
  it('bounces once off the ground, losing most of its speed', () => {
    const p = new StreakPool(4);
    const i = p.emit(0, 0.5, 0, 0, -20, 0, 3, 0.05, 1.3, 1, 9.81, 0);
    run(p, 0.1, 0);
    expect(p.py[i]).toBeGreaterThanOrEqual(0);
    expect(p.vy[i]).toBeGreaterThan(0);
    expect(p.vy[i]).toBeLessThan(10);
  });
  it('recycles the oldest when full (capacity never grows)', () => {
    const p = new StreakPool(3);
    for (let k = 0; k < 10; k++) p.emit(k, 0, 0, 0, 0, 0, 5, 0.05, 1, 1, 0, 0);
    expect(p.count).toBe(3);
    const xs = [0, 1, 2].map((k) => p.px[k]).sort((a, b) => a - b);
    expect(xs).toEqual([7, 8, 9]);
  });
  it('clear() kills everything', () => {
    const p = new StreakPool(5);
    for (let k = 0; k < 5; k++) p.emit(0, 0, 0, 1, 1, 1, 5, 0.05, 1, 1, 0, 0);
    p.clear();
    expect(p.count).toBe(0);
    expect([...p.alive].every((a) => a === 0)).toBe(true);
  });
  it('fuzz: garbage emits and steps never produce NaN or exceed capacity', () => {
    const any = fc.oneof(fc.double(), fc.constant(Number.NaN), fc.constant(Infinity));
    fc.assert(
      fc.property(fc.array(fc.array(any, { minLength: 12, maxLength: 12 }), { maxLength: 40 }), fc.array(any, { maxLength: 20 }), (emits, dts) => {
        const p = new StreakPool(16);
        for (const a of emits) p.emit(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8], a[9], a[10], a[11]);
        for (const dt of dts) p.step(dt, 0);
        expect(p.count).toBeLessThanOrEqual(16);
        for (let i = 0; i < p.capacity; i++) {
          if (!p.alive[i]) continue;
          for (const v of [p.px[i], p.py[i], p.pz[i], p.vx[i], p.vy[i], p.vz[i], p.heatOf(i), p.width[i]]) expect(Number.isFinite(v)).toBe(true);
        }
      }),
    );
  });
});
