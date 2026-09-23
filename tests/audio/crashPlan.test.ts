import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { secondaryExplosions, crashDistanceGain, impactIntensity, fireLevel, createRateLimiter, explosionSize } from '../../src/audio/crashPlan';
import { crackleSamples, mulberry32 } from '../../src/audio/waves';
import { CONFIG } from '../../src/config';

const C = CONFIG.audio.crash;
const anyNum = fc.double();
const fin = (v: number) => Number.isFinite(v);

describe('secondary explosions schedule', () => {
  it('a few explosions after the impact, spread over several seconds, getting smaller', () => {
    const plan = secondaryExplosions(mulberry32(7), 1);
    expect(plan.length).toBeGreaterThanOrEqual(C.secondaryMin);
    expect(plan.length).toBeLessThanOrEqual(C.secondaryMax);
    expect(plan[0].at).toBeGreaterThanOrEqual(C.secondaryFirstS);
    for (let i = 1; i < plan.length; i++) expect(plan[i].at).toBeGreaterThan(plan[i - 1].at);
    expect(plan[plan.length - 1].at).toBeLessThanOrEqual(C.secondaryLastS);
    expect(plan[plan.length - 1].at - plan[0].at).toBeGreaterThan(1);
  });
  it('a harder crash has at least as many secondary explosions', () => {
    let soft = 0;
    let hard = 0;
    for (let s = 1; s <= 40; s++) {
      soft += secondaryExplosions(mulberry32(s), 0.3).length;
      hard += secondaryExplosions(mulberry32(s), 1).length;
    }
    expect(hard).toBeGreaterThan(soft);
  });
  it('is randomised (different seeds → different timings) but deterministic per seed', () => {
    const a = secondaryExplosions(mulberry32(1), 0.8);
    const b = secondaryExplosions(mulberry32(1), 0.8);
    const c = secondaryExplosions(mulberry32(2), 0.8);
    expect(a).toEqual(b);
    expect(a.map((e) => e.at)).not.toEqual(c.map((e) => e.at));
  });
  it('fuzz: any seed/intensity → sorted, bounded, finite plan', () => {
    fc.assert(fc.property(fc.integer(), anyNum, (seed, intensity) => {
      const plan = secondaryExplosions(mulberry32(seed), intensity);
      expect(plan.length).toBeGreaterThanOrEqual(C.secondaryMin);
      expect(plan.length).toBeLessThanOrEqual(C.secondaryMax);
      let last = -Infinity;
      for (const e of plan) {
        expect(fin(e.at) && fin(e.size)).toBe(true);
        expect(e.at).toBeGreaterThan(last);
        expect(e.at).toBeGreaterThanOrEqual(C.secondaryFirstS);
        expect(e.at).toBeLessThanOrEqual(C.secondaryLastS);
        expect(e.size).toBeGreaterThan(0);
        expect(e.size).toBeLessThanOrEqual(1);
        last = e.at;
      }
    }));
  });
});

describe('crash levels', () => {
  it('distance: full level close by, falling slowly (explosions carry)', () => {
    expect(crashDistanceGain(0)).toBe(1);
    expect(crashDistanceGain(C.refDistanceM)).toBe(1);
    expect(crashDistanceGain(400)).toBeLessThan(0.25);
    expect(crashDistanceGain(400)).toBeGreaterThan(0.1);
  });
  it('impact intensity from speed (m/s), bounded', () => {
    expect(impactIntensity(0)).toBe(0);
    expect(impactIntensity(C.impactFullMs)).toBeCloseTo(1, 6);
    expect(impactIntensity(10)).toBeGreaterThan(0);
    expect(impactIntensity(10)).toBeLessThan(impactIntensity(30));
  });
  it('explosion size accepts a number or a radius-like value and maps to 0..1', () => {
    expect(explosionSize(1)).toBeCloseTo(1, 6);
    expect(explosionSize(0.5)).toBeCloseTo(0.5, 6);
    expect(explosionSize(12)).toBeLessThanOrEqual(1); // metres of fireball → capped
    expect(explosionSize(Number.NaN)).toBeCloseTo(0.6, 6);
  });
  it('the fire fades in quickly and dies away over tens of seconds', () => {
    expect(fireLevel(0)).toBe(0);
    expect(fireLevel(1)).toBeGreaterThan(0.8 * C.fireLevel);
    expect(fireLevel(C.fireFadeS * 3)).toBeLessThan(0.1 * C.fireLevel);
  });
  it('fuzz: crash levels finite, in [0,1], monotone', () => {
    fc.assert(fc.property(anyNum, anyNum, (a, b) => {
      for (const v of [crashDistanceGain(a), impactIntensity(a), fireLevel(a), explosionSize(a)]) {
        expect(fin(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      if (fin(a) && fin(b) && 0 <= a && a <= b) {
        expect(crashDistanceGain(a)).toBeGreaterThanOrEqual(crashDistanceGain(b));
        expect(impactIntensity(a)).toBeLessThanOrEqual(impactIntensity(b));
      }
    }));
  });
});

describe('rate limiter (window events)', () => {
  it('lets through at most maxPerS per rolling second', () => {
    const ok = createRateLimiter(3);
    const got = [0, 0.1, 0.2, 0.3, 0.4].map((t) => ok(t));
    expect(got).toEqual([true, true, true, false, false]);
    expect(ok(1.05)).toBe(true);
  });
  it('fuzz: never more than maxPerS within any 1 s window', () => {
    fc.assert(fc.property(fc.array(fc.double({ min: 0, max: 20, noNaN: true }), { maxLength: 80 }), (ts) => {
      const times = [...ts].sort((x, y) => x - y);
      const ok = createRateLimiter(4);
      const passed = times.filter((t) => ok(t));
      for (let i = 0; i < passed.length; i++) {
        const inWin = passed.filter((t) => t >= passed[i] && t < passed[i] + 1).length;
        expect(inWin).toBeLessThanOrEqual(4);
      }
    }));
  });
});

describe('afterburner crackle noise', () => {
  const n = 44100;
  const s = crackleSamples(n, 3, 0.004);
  it('is finite, bounded and deterministic', () => {
    expect(s.every(fin)).toBe(true);
    expect(Math.max(...s.map(Math.abs))).toBeLessThanOrEqual(1);
    expect(crackleSamples(n, 3, 0.004)).toEqual(s);
  });
  it('is impulsive and positively skewed (the signature of jet crackle)', () => {
    let m = 0;
    for (const v of s) m += v;
    m /= n;
    let m2 = 0;
    let m3 = 0;
    let m4 = 0;
    for (const v of s) {
      const d = v - m;
      m2 += d * d;
      m3 += d * d * d;
      m4 += d * d * d * d;
    }
    m2 /= n;
    m3 /= n;
    m4 /= n;
    expect(m3 / Math.pow(m2, 1.5)).toBeGreaterThan(0.5); // skewness
    expect(m4 / (m2 * m2)).toBeGreaterThan(6); // kurtosis ≫ 3 (Gaussian)
  });
});
