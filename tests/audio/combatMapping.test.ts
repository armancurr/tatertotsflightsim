/**
 * Unit + fuzz: the PURE combat-sound and TF34 mappings — speed-of-sound delay, air absorption,
 * distance level, the gun's firing-rate fundamental (GAU-8 65 Hz, M61 100 Hz) while spinning up,
 * the muzzle-blast waveform, the missile flight estimate, and the TF34 whistle rising with N1.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  soundDelayS, airCutoffHz, combatDistanceGain, gunRateHz, gunWhineHz, gunTimbre, muzzleBlastWaveform, motorLevel, missilePosition,
} from '../../src/audio/combatMapping';
import { tf34FanPct, tf34WhistleHz, turbofanMix } from '../../src/audio/turbofanMapping';
import { CONFIG, A10_WEAPONS, F16_WEAPONS } from '../../src/config';

const C = CONFIG.audio.combat;
const any = fc.oneof(fc.double(), fc.constantFrom(Number.NaN, Infinity, -Infinity));

describe('propagation', () => {
  it('sound takes distance / 343 m/s (capped at maxDelayS)', () => {
    expect(soundDelayS(343)).toBeCloseTo(1, 6);
    expect(soundDelayS(1200)).toBeCloseTo(1200 / 343, 6);
    expect(soundDelayS(0)).toBe(0);
    expect(soundDelayS(1e6)).toBe(C.maxDelayS);
  });
  it('air absorbs the highs with distance; level falls beyond the reference distance', () => {
    expect(airCutoffHz(0)).toBe(C.maxCutoffHz);
    expect(airCutoffHz(C.absorptionHalfM)).toBeCloseTo(C.maxCutoffHz / 2, 3);
    expect(airCutoffHz(1500)).toBeLessThan(airCutoffHz(300));
    expect(combatDistanceGain(10)).toBe(1);
    expect(combatDistanceGain(C.refDistanceM * 10)).toBeCloseTo(0.1 ** C.distanceExponent, 6);
  });
  it('fuzz: total and bounded', () => {
    fc.assert(fc.property(any, (d) => {
      for (const v of [soundDelayS(d), airCutoffHz(d), combatDistanceGain(d)]) expect(Number.isFinite(v)).toBe(true);
      expect(soundDelayS(d)).toBeLessThanOrEqual(C.maxDelayS);
      expect(combatDistanceGain(d)).toBeLessThanOrEqual(1);
    }));
  });
});

describe('the gun', () => {
  it('the BRRRT fundamental is the firing rate: GAU-8/A 65 Hz, M61A1 100 Hz at full spin', () => {
    expect(gunRateHz(A10_WEAPONS.gun!.rateRps, 1)).toBe(65);
    expect(gunRateHz(F16_WEAPONS.gun!.rateRps, 1)).toBe(100);
  });
  it('rises while the barrels spin up (never below minRateFraction), silent when stopped', () => {
    expect(gunRateHz(65, 0.5)).toBeCloseTo(32.5);
    expect(gunRateHz(65, 0.01)).toBeCloseTo(65 * C.gun.minRateFraction);
    expect(gunRateHz(65, 0)).toBe(0);
    expect(gunWhineHz(1)).toBeGreaterThan(gunWhineHz(0.2));
  });
  it('the 20 mm gun is lighter and brighter than the 30 mm', () => {
    const big = gunTimbre(30);
    const small = gunTimbre(20);
    expect(small.thump).toBeLessThan(big.thump);
    expect(small.tearHz).toBeGreaterThan(big.tearHz);
  });
  it('muzzle blast: sharp positive spike, longer negative phase, normalised', () => {
    const w = muzzleBlastWaveform(1024);
    const max = Math.max(...w);
    const min = Math.min(...w);
    expect(max).toBeCloseTo(1, 5);
    expect(min).toBeLessThan(-0.2);
    expect(w.findIndex((v) => v === max)).toBeLessThan(1024 * 0.05);
  });
  it('fuzz: gun mappings total', () => {
    fc.assert(fc.property(any, any, (r, s) => {
      expect(Number.isFinite(gunRateHz(r, s))).toBe(true);
      expect(gunRateHz(r, s)).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(gunWhineHz(s))).toBe(true);
    }));
  });
});

describe('missile motor', () => {
  it('boost roar, then sustain, then silence', () => {
    expect(motorLevel(0.5)).toBe(1);
    expect(motorLevel(5)).toBeLessThan(1);
    expect(motorLevel(5)).toBeGreaterThan(0);
    expect(motorLevel(40)).toBe(0);
  });
  it('the missile recedes along its launch direction, accelerating to its cruise speed', () => {
    const p0 = { x: 0, y: 100, z: 0 };
    const v0 = { x: 0, y: 0, z: -120 };
    const a = missilePosition(p0, v0, 1, 300);
    const b = missilePosition(p0, v0, 5, 300);
    expect(a.z).toBeLessThan(-120);
    expect(b.z).toBeLessThan(a.z - 4 * 250);
    expect(b.x).toBe(0);
  });
});

describe('TF34 turbofan', () => {
  it('N1 lags the core: ~35 % at ground idle, 100 % at 100 % N2', () => {
    expect(tf34FanPct(70)).toBeGreaterThan(28);
    expect(tf34FanPct(70)).toBeLessThan(42);
    expect(tf34FanPct(100)).toBeCloseTo(100, 6);
  });
  it('the whistle is the fan blade-pass tone, ~1.2 kHz at idle rising to ~3.4 kHz', () => {
    const T = CONFIG.audio.turbofan;
    expect(tf34WhistleHz(100)).toBeCloseTo((T.fanMaxRpm / 60) * T.fanBlades, 3);
    expect(tf34WhistleHz(70)).toBeGreaterThan(900);
    expect(tf34WhistleHz(70)).toBeLessThan(1500);
    let prev = -1;
    for (let c = 50; c <= 105; c += 1) {
      expect(tf34WhistleHz(c)).toBeGreaterThanOrEqual(prev);
      prev = tf34WhistleHz(c);
    }
  });
  it('mix: louder with power, silent when crashed or off', () => {
    const idle = turbofanMix(70, 0, true, false, false);
    const mil = turbofanMix(100, 1, true, false, false);
    expect(mil.roar).toBeGreaterThan(idle.roar);
    expect(mil.whistle).toBeGreaterThanOrEqual(idle.whistle);
    expect(turbofanMix(100, 1, true, false, true).whistle).toBe(0);
    expect(turbofanMix(0, 0, false, false, false).roar).toBe(0);
  });
  it('fuzz: total', () => {
    fc.assert(fc.property(any, any, fc.boolean(), fc.boolean(), (c, p, r, s) => {
      expect(Number.isFinite(tf34WhistleHz(c))).toBe(true);
      const m = turbofanMix(c, p, r, s, false);
      for (const v of Object.values(m)) expect(v >= 0 && v <= 1).toBe(true);
    }));
  });
});
