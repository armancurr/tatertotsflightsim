/**
 * Unit: the PURE marine-diesel mappings (marineMapping.ts) and the D6's cycle waveform — firing rate
 * rpm/20, monotone and bounded levels, load hardening, the run-down, water levels vs speed and
 * planing, slap rates, and totality (NaN/±∞ in → finite out).
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  MARINE as M, gearSign, hullMotion, marineCycleHz, marineEngineMix, marineFiringHz, marineWaterMix, propBladeHz, rundownRpm,
  slapChance, turboWhistleHz, marineWindScale,
} from '../../src/audio/marineMapping';
import { dieselCycleWaveform } from '../../src/audio/waves';
import { goertzelAmplitude } from '../../src/audio/analysis';

const wild = fc.oneof(fc.double(), fc.constantFrom(Number.NaN, Infinity, -Infinity, 0, 1e300, -1e300));

describe('marine diesel frequencies', () => {
  it('firing = rpm/60 × 3 for the 6-cylinder 4-stroke D6: 35 Hz at 700 rpm, 175 Hz at 3500; the cycle is rpm/120', () => {
    expect(marineFiringHz(700)).toBeCloseTo(35, 9);
    expect(marineFiringHz(3000)).toBeCloseTo(150, 9);
    expect(marineFiringHz(3500)).toBeCloseTo(175, 9);
    expect(marineCycleHz(3500)).toBeCloseTo(3500 / 120, 9);
    expect(marineFiringHz(2400)).toBeCloseTo(marineCycleHz(2400) * 6, 9);
    expect(marineFiringHz(-5)).toBe(0);
    expect(marineFiringHz(1e12)).toBeLessThan(250);
  });
  it('propeller blade passage from |n|; turbo whistle rises with rpm and boost within its range', () => {
    expect(propBladeHz(-20)).toBeCloseTo(20 * M.propBlades, 9);
    expect(turboWhistleHz(3500, 1)).toBeGreaterThan(turboWhistleHz(3500, 0.3));
    expect(turboWhistleHz(3500, 1)).toBeGreaterThan(turboWhistleHz(1500, 1));
    expect(turboWhistleHz(0, 0)).toBeCloseTo(M.turboMinHz, 9);
    expect(turboWhistleHz(1e9, 1e9)).toBeLessThanOrEqual(M.turboMaxHz);
  });
  it('gear sign', () => {
    expect(gearSign('ahead')).toBe(1);
    expect(gearSign('neutral')).toBe(0);
    expect(gearSign('astern')).toBe(-1);
    expect(gearSign(undefined)).toBe(0);
  });
  it('the cycle waveform: its strongest low harmonic is the 6th (six firings per cycle)', () => {
    const n = 4096;
    const one = dieselCycleWaveform(n);
    const s = new Float32Array(n * 4);
    for (let i = 0; i < s.length; i++) s[i] = one[i % n];
    const amp = (h: number) => goertzelAmplitude(s, n, h);
    const six = amp(6);
    for (const h of [1, 2, 3, 4, 5, 7, 8]) expect(six).toBeGreaterThan(amp(h) * 2);
  });
});

describe('marineEngineMix', () => {
  it('silent when not running (only the machinery turning), silent in a wreck', () => {
    const off = marineEngineMix(600, 0.5, 0.5, false, false);
    expect(off.tone).toBe(0);
    expect(off.clatter).toBe(0);
    expect(off.exhaust).toBe(0);
    expect(off.mech).toBeGreaterThan(0);
    const wreck = marineEngineMix(3000, 1, 1, true, true);
    for (const k of ['tone', 'clatter', 'exhaust', 'bubble', 'turbo', 'mech'] as const) expect(wreck[k]).toBe(0);
  });
  it('load hardens (drive), brightens and loudens the note; the exhaust opens at idle (idle relief)', () => {
    const light = marineEngineMix(2500, 0.1, 0.2, true, false);
    const heavy = marineEngineMix(2500, 1, 1, true, false);
    expect(heavy.drive).toBeGreaterThan(light.drive * 3);
    expect(heavy.bright).toBeGreaterThan(light.bright);
    expect(heavy.tone).toBeGreaterThan(light.tone);
    expect(heavy.turbo).toBeGreaterThan(light.turbo);
    expect(heavy.clatterHz).toBeGreaterThan(light.clatterHz);
    const idle = marineEngineMix(700, 0.1, 0, true, false);
    const mid = marineEngineMix(2000, 0.1, 0, true, false);
    expect(idle.exhaustLpHz).toBeGreaterThan(mid.exhaustLpHz - 120 * (1300 / 3500));
    expect(idle.turbo).toBe(0);
  });
  it('monotone in rpm and load', () => {
    fc.assert(fc.property(fc.double({ min: 0, max: 4000, noNaN: true }), fc.double({ min: 0, max: 4000, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }), (a, b, l) => {
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      const x = marineEngineMix(lo, l, l, true, false);
      const y = marineEngineMix(hi, l, l, true, false);
      expect(y.tone).toBeGreaterThanOrEqual(x.tone - 1e-12);
      expect(y.mech).toBeGreaterThanOrEqual(x.mech - 1e-12);
      expect(y.firingHz).toBeGreaterThanOrEqual(x.firingHz);
    }));
  });
  it('total: NaN/∞ in → finite, bounded out', () => {
    fc.assert(fc.property(wild, wild, wild, fc.boolean(), fc.boolean(), (r, l, b, run, cr) => {
      const m = marineEngineMix(r, l, b, run, cr);
      for (const [k, v] of Object.entries(m)) {
        expect(Number.isFinite(v), k).toBe(true);
        if (!k.endsWith('Hz') && k !== 'drive') expect(v >= 0 && v <= 1, k).toBe(true);
      }
    }), { numRuns: 500 });
  });
});

describe('rundownRpm', () => {
  it('follows the physics while running; after a stop it decays with rundownTau, then stops below 60 rpm', () => {
    expect(rundownRpm(700, 1200, true, 0.1)).toBe(1200);
    const r = rundownRpm(700, 0, false, M.rundownTauS);
    expect(r).toBeCloseTo(700 / Math.E, 6);
    expect(rundownRpm(50, 0, false, 0.01)).toBe(0);
    // The physics' own (slower) run-down wins.
    expect(rundownRpm(700, 690, false, 0.1)).toBe(690);
    // Paused: holds.
    expect(rundownRpm(700, 0, false, 0)).toBe(700);
    fc.assert(fc.property(wild, wild, fc.boolean(), wild, (p, t, run, dt) => {
      expect(Number.isFinite(rundownRpm(p, t, run, dt))).toBe(true);
    }));
  });
});

describe('marineWaterMix', () => {
  it('rush and hiss grow with speed; wash belongs to displacement speeds; skim only when planing', () => {
    const rest = marineWaterMix(0, 0, 0, 0, 0, false, 0, 0, 2);
    const slow = marineWaterMix(4, 0.05, 0, 0, 0, false, 8000, 10, 2);
    const plane = marineWaterMix(15, 0.9, 0, 0, 0, false, 28000, 27, 2);
    expect(rest.rush).toBe(0);
    expect(slow.rush).toBeGreaterThan(0);
    expect(plane.rush).toBeGreaterThan(slow.rush);
    expect(plane.hiss).toBeGreaterThan(slow.hiss);
    expect(plane.rushHz).toBeGreaterThan(slow.rushHz);
    expect(slow.wash).toBeGreaterThan(plane.wash);
    expect(slow.skim).toBe(0);
    expect(plane.skim).toBeGreaterThan(0.5);
    // Going astern is as loud as ahead.
    expect(marineWaterMix(-4, 0, 0, 0, 0, false, 8000, -10, 2).rush).toBeCloseTo(slow.rush, 9);
  });
  it('slaps: lapping at rest, more with the hull working in the waves and with speed; the planing hull slams harder', () => {
    const rest = marineWaterMix(0, 0, 0, 0, 0, false, 0, 0, 2);
    const chop = marineWaterMix(0, 0, 0.8, 0.12, 0.1, false, 0, 0, 2);
    const under = marineWaterMix(5, 0.1, 0, 0, 0, false, 0, 0, 2);
    expect(rest.slapRate).toBeGreaterThan(0);
    expect(chop.slapRate).toBeGreaterThan(rest.slapRate * 3);
    expect(under.slapRate).toBeGreaterThan(rest.slapRate);
    expect(chop.slapIntensity).toBeGreaterThan(rest.slapIntensity);
    const planeChop = marineWaterMix(15, 0.9, 0.8, 0.12, 0, false, 0, 0, 2);
    const dispChop = marineWaterMix(15, 0.1, 0.8, 0.12, 0, false, 0, 0, 2);
    expect(planeChop.slapIntensity).toBeGreaterThan(dispChop.slapIntensity);
    expect(hullMotion(0, 0, 0)).toBe(0);
    expect(hullMotion(-5, 0, 0)).toBe(1);
  });
  it('grinding only aground, louder with speed; propellers cavitate when heavily loaded at low speed', () => {
    expect(marineWaterMix(2, 0, 0, 0, 0, false, 0, 0, 2).grind).toBe(0);
    const g1 = marineWaterMix(0.5, 0, 0, 0, 0, true, 0, 0, 2).grind;
    const g2 = marineWaterMix(5, 0, 0, 0, 0, true, 0, 0, 2).grind;
    expect(g1).toBeGreaterThan(0.3);
    expect(g2).toBeGreaterThan(g1);
    const holeShot = marineWaterMix(2, 0, 0, 0, 0, false, 32000, 30, 2);
    const cruise = marineWaterMix(15, 0.9, 0, 0, 0, false, 28000, 27, 2);
    expect(holeShot.cavitation).toBeGreaterThan(cruise.cavitation * 2);
    expect(holeShot.prop).toBeGreaterThan(0);
  });
  it('total: NaN/∞ in → finite, bounded out', () => {
    fc.assert(fc.property(wild, wild, wild, wild, wild, fc.boolean(), wild, wild, wild, (s, p, h, pr, rr, ag, th, n, e) => {
      const m = marineWaterMix(s, p, h, pr, rr, ag, th, n, e);
      for (const [k, v] of Object.entries(m)) {
        expect(Number.isFinite(v), k).toBe(true);
        if (!k.endsWith('Hz') && k !== 'speedKt' && k !== 'slapRate') expect(v >= 0 && v <= 1, k).toBe(true);
      }
      expect(m.slapRate).toBeLessThanOrEqual(8);
    }), { numRuns: 500 });
  });
});

describe('slapChance / wind', () => {
  it('Poisson probability per frame, bounded, 0 when paused', () => {
    expect(slapChance(3, 0)).toBe(0);
    expect(slapChance(0, 1 / 60)).toBe(0);
    expect(slapChance(3, 1 / 60)).toBeCloseTo(1 - Math.exp(-3 / 60), 12);
    fc.assert(fc.property(wild, wild, (r, d) => {
      const p = slapChance(r, d);
      expect(p >= 0 && p <= 1).toBe(true);
    }));
  });
  it('the saloon hears much less apparent wind than the deck', () => {
    expect(marineWindScale(false)).toBeLessThan(marineWindScale(true) * 0.5);
    expect(marineWindScale(true)).toBeLessThan(1);
  });
});
