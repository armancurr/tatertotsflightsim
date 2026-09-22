import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  firingFrequency, cycleFrequency, bladePassFrequency, engineMix, windGain, windCenterHz, whistleGain,
  rollingGain, rollingCutoffHz, brakeScrubGain, touchdownIntensity, stallHornOn, viewCutoffHz,
  distanceGain, cabinBusGain, dopplerFactor, masterGain, crashIntensity, exhaustCenterHz,
} from '../../src/audio/mapping';
import { CONFIG } from '../../src/config';
import type { CameraMode, SurfaceType } from '../../src/types';

const A = CONFIG.audio;
const MODES: CameraMode[] = ['cockpit', 'chase', 'external', 'orbit'];
const SURFACES = Object.keys(A.surfaceRumble) as SurfaceType[];
const anyNum = fc.double(); // includes NaN, ±Infinity, -0
const num = (lo: number, hi: number) => fc.double({ min: lo, max: hi, noNaN: true });
const fin = (v: number) => Number.isFinite(v);

describe('engine frequencies', () => {
  it('firing frequency = rpm/60 × 2 for the 4-cylinder four-stroke O-360', () => {
    expect(firingFrequency(2700)).toBeCloseTo(90, 9);
    expect(firingFrequency(700)).toBeCloseTo(700 / 30, 9);
    expect(firingFrequency(0)).toBe(0);
  });
  it('the 4-stroke cycle is half the crank rate; 2-blade blade-pass = 2/rev', () => {
    expect(cycleFrequency(2400)).toBeCloseTo(20, 9);
    expect(bladePassFrequency(2400)).toBeCloseTo(80, 9);
    expect(firingFrequency(2400)).toBeCloseTo(cycleFrequency(2400) * 4, 9);
  });
  it('fuzz: frequencies are finite, non-negative and monotone in rpm', () => {
    fc.assert(fc.property(anyNum, anyNum, (a, b) => {
      for (const f of [firingFrequency, cycleFrequency, bladePassFrequency, exhaustCenterHz]) {
        const fa = f(a);
        expect(fin(fa)).toBe(true);
        expect(fa).toBeGreaterThanOrEqual(0);
      }
      if (fin(a) && fin(b) && a <= b) {
        expect(firingFrequency(a)).toBeLessThanOrEqual(firingFrequency(b));
        expect(bladePassFrequency(a)).toBeLessThanOrEqual(bladePassFrequency(b));
        expect(exhaustCenterHz(a)).toBeLessThanOrEqual(exhaustCenterHz(b));
      }
    }));
  });
  it('frequencies stay audible-range bounded even for absurd rpm', () => {
    expect(firingFrequency(1e12)).toBeLessThan(400);
    expect(firingFrequency(-50)).toBe(0);
  });
});

describe('engineMix', () => {
  const base = { rpm: 2400, power: 0.8, engineRunning: true, starting: false, crashed: false };
  it('is silent when the engine is stopped and not turning', () => {
    const m = engineMix({ ...base, rpm: 0, power: 0, engineRunning: false });
    expect(m.exhaust).toBe(0);
    expect(m.prop).toBe(0);
    expect(m.mechanical).toBe(0);
    expect(m.starter).toBe(0);
  });
  it('full power is louder than idle', () => {
    const idle = engineMix({ ...base, rpm: 700, power: 0.045 });
    const full = engineMix({ ...base, rpm: 2700, power: 1 });
    expect(full.exhaust).toBeGreaterThan(idle.exhaust * 1.8);
    expect(full.prop).toBeGreaterThan(idle.prop * 4);
  });
  it('idle is clearly audible (idleLoudness)', () => {
    const idle = engineMix({ ...base, rpm: 700, power: 0.045 });
    expect(idle.exhaust).toBeGreaterThan(0.25);
  });
  it('a windmilling (stopped) engine has no exhaust but some prop swish', () => {
    const m = engineMix({ ...base, rpm: 900, power: 0, engineRunning: false });
    expect(m.exhaust).toBe(0);
    expect(m.prop).toBeGreaterThan(0);
  });
  it('the starter sounds only while cranking, and everything cuts on a crash', () => {
    expect(engineMix({ ...base, rpm: 180, engineRunning: false, starting: true }).starter).toBe(1);
    const c = engineMix({ ...base, crashed: true });
    expect(c.exhaust + c.prop + c.mechanical + c.starter).toBe(0);
  });
  it('fuzz: all channels finite in [0,1] for any input', () => {
    fc.assert(fc.property(anyNum, anyNum, fc.boolean(), fc.boolean(), fc.boolean(), (rpm, power, run, st, cr) => {
      const m = engineMix({ rpm, power, engineRunning: run, starting: st, crashed: cr });
      for (const v of [m.exhaust, m.prop, m.mechanical, m.starter, m.brightness]) {
        expect(fin(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }));
  });
  it('fuzz: monotone non-decreasing in power and in rpm', () => {
    fc.assert(fc.property(num(0, 3000), num(0, 3000), num(0, 1), num(0, 1), fc.boolean(), (r1, r2, p1, p2, run) => {
      const [rl, rh] = r1 <= r2 ? [r1, r2] : [r2, r1];
      const [pl, ph] = p1 <= p2 ? [p1, p2] : [p2, p1];
      const lo = engineMix({ rpm: rl, power: pl, engineRunning: run, starting: false, crashed: false });
      const hiP = engineMix({ rpm: rl, power: ph, engineRunning: run, starting: false, crashed: false });
      const hiR = engineMix({ rpm: rh, power: pl, engineRunning: run, starting: false, crashed: false });
      expect(hiP.exhaust).toBeGreaterThanOrEqual(lo.exhaust - 1e-12);
      expect(hiP.prop).toBeGreaterThanOrEqual(lo.prop - 1e-12);
      expect(hiR.exhaust).toBeGreaterThanOrEqual(lo.exhaust - 1e-12);
      expect(hiR.prop).toBeGreaterThanOrEqual(lo.prop - 1e-12);
      expect(hiR.mechanical).toBeGreaterThanOrEqual(lo.mechanical - 1e-12);
    }));
  });
});

describe('airflow', () => {
  it('wind is silent at rest and loud at cruise', () => {
    expect(windGain(0)).toBe(0);
    expect(windGain(110)).toBeGreaterThan(0.4);
    expect(windGain(500)).toBeLessThanOrEqual(1);
  });
  it('the wind band rises with airspeed within [windMinHz, windMaxHz]', () => {
    expect(windCenterHz(0)).toBeCloseTo(A.windMinHz, 6);
    expect(windCenterHz(1000)).toBeCloseTo(A.windMaxHz, 6);
  });
  it('the cockpit whistle is cockpit-only and needs speed', () => {
    expect(whistleGain(150, 'chase')).toBe(0);
    expect(whistleGain(20, 'cockpit')).toBe(0);
    expect(whistleGain(150, 'cockpit')).toBeGreaterThan(0.9);
  });
  it('fuzz: airflow mappings are finite, bounded, monotone in airspeed', () => {
    fc.assert(fc.property(anyNum, anyNum, fc.constantFrom(...MODES), (a, b, mode) => {
      for (const v of [windGain(a), whistleGain(a, mode)]) {
        expect(fin(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      const c = windCenterHz(a);
      expect(c).toBeGreaterThanOrEqual(A.windMinHz);
      expect(c).toBeLessThanOrEqual(A.windMaxHz);
      if (fin(a) && fin(b) && a <= b) {
        expect(windGain(a)).toBeLessThanOrEqual(windGain(b));
        expect(windCenterHz(a)).toBeLessThanOrEqual(windCenterHz(b));
        expect(whistleGain(a, mode)).toBeLessThanOrEqual(whistleGain(b, mode));
      }
    }));
  });
});

describe('ground', () => {
  it('no rumble in the air or at rest; grass rumbles more than the runway', () => {
    expect(rollingGain(40, false, 'runway')).toBe(0);
    expect(rollingGain(0, true, 'runway')).toBe(0);
    expect(rollingGain(40, true, 'grass')).toBeGreaterThan(rollingGain(40, true, 'runway'));
  });
  it('brake scrub needs brakes, speed and the ground', () => {
    expect(brakeScrubGain(0, 40, 'runway', true)).toBe(0);
    expect(brakeScrubGain(1, 0, 'runway', true)).toBe(0);
    expect(brakeScrubGain(1, 40, 'runway', false)).toBe(0);
    expect(brakeScrubGain(1, 40, 'runway', true)).toBeGreaterThan(0.5);
  });
  it('fuzz: ground mappings finite, bounded, monotone in ground speed', () => {
    fc.assert(fc.property(anyNum, anyNum, anyNum, fc.boolean(), fc.constantFrom(...SURFACES), (a, b, brake, g, s) => {
      for (const v of [rollingGain(a, g, s), brakeScrubGain(brake, a, s, g)]) {
        expect(fin(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      const c = rollingCutoffHz(a, s);
      expect(fin(c)).toBe(true);
      expect(c).toBeGreaterThanOrEqual(40);
      expect(c).toBeLessThanOrEqual(2000);
      if (fin(a) && fin(b) && a <= b) {
        expect(rollingGain(a, g, s)).toBeLessThanOrEqual(rollingGain(b, g, s));
        expect(rollingCutoffHz(a, s)).toBeLessThanOrEqual(rollingCutoffHz(b, s));
      }
    }));
  });
  it('unknown surfaces fall back sanely', () => {
    expect(fin(rollingGain(30, true, 'lava' as SurfaceType))).toBe(true);
  });
});

describe('touchdownIntensity', () => {
  it('is 0 without a touchdown, faint for a greaser, 1 for a hard landing', () => {
    expect(touchdownIntensity(null)).toBe(0);
    expect(touchdownIntensity(-60)).toBeGreaterThan(0);
    expect(touchdownIntensity(-60)).toBeLessThan(0.25);
    expect(touchdownIntensity(-900)).toBe(1);
  });
  it('uses the magnitude (sign convention independent)', () => {
    expect(touchdownIntensity(-300)).toBeCloseTo(touchdownIntensity(300), 12);
  });
  it('fuzz: finite in [0,1], monotone in |fpm|', () => {
    fc.assert(fc.property(anyNum, anyNum, (a, b) => {
      const ia = touchdownIntensity(a);
      expect(fin(ia)).toBe(true);
      expect(ia).toBeGreaterThanOrEqual(0);
      expect(ia).toBeLessThanOrEqual(1);
      if (fin(a) && fin(b) && Math.abs(a) <= Math.abs(b)) expect(ia).toBeLessThanOrEqual(touchdownIntensity(b));
    }));
  });
});

describe('stall horn', () => {
  it('sounds with the warning and airflow; not after a crash', () => {
    expect(stallHornOn(true, 50, false)).toBe(true);
    expect(stallHornOn(false, 50, false)).toBe(false);
    expect(stallHornOn(true, 3, false)).toBe(false);
    expect(stallHornOn(true, 50, true)).toBe(false);
    expect(stallHornOn(true, Number.NaN, false)).toBe(false);
  });
  it('the reed frequency is in the C172 range', () => {
    expect(A.stallHornHz).toBeGreaterThanOrEqual(1600);
    expect(A.stallHornHz).toBeLessThanOrEqual(2000);
  });
});

describe('view / listener', () => {
  it('cockpit is muffled (cabin low-pass), exterior is open', () => {
    expect(viewCutoffHz('cockpit')).toBe(A.cabinCutoffHz);
    expect(viewCutoffHz('chase', 10)).toBe(A.exteriorCutoffHz);
    expect(viewCutoffHz('chase')).toBeGreaterThan(viewCutoffHz('cockpit') * 5);
  });
  it('far exterior cameras hear less and duller sound', () => {
    expect(distanceGain('external', 300)).toBeLessThan(0.1);
    expect(distanceGain('cockpit', 300)).toBe(1);
    expect(viewCutoffHz('external', 800)).toBeLessThan(viewCutoffHz('external', 30));
  });
  it('cabin-only sounds are faint outside', () => {
    expect(cabinBusGain('cockpit')).toBe(1);
    expect(cabinBusGain('orbit')).toBeLessThan(0.3);
  });
  it('fuzz: listener mappings finite, bounded, monotone in distance', () => {
    fc.assert(fc.property(fc.constantFrom(...MODES), anyNum, anyNum, (mode, d1, d2) => {
      const g = distanceGain(mode, d1);
      const c = viewCutoffHz(mode, d1);
      expect(fin(g) && g >= 0 && g <= 1).toBe(true);
      expect(fin(c) && c > 0 && c <= A.exteriorCutoffHz).toBe(true);
      if (fin(d1) && fin(d2) && d1 <= d2) {
        expect(distanceGain(mode, d2)).toBeLessThanOrEqual(g);
        expect(viewCutoffHz(mode, d2)).toBeLessThanOrEqual(c);
      }
    }));
  });
  it('doppler: approaching raises pitch, receding lowers it; bounded and monotone', () => {
    expect(dopplerFactor(0)).toBe(1);
    expect(dopplerFactor(60)).toBeGreaterThan(1.1);
    expect(dopplerFactor(-60)).toBeLessThan(0.9);
    fc.assert(fc.property(anyNum, anyNum, (a, b) => {
      const da = dopplerFactor(a);
      expect(fin(da)).toBe(true);
      expect(da).toBeGreaterThanOrEqual(0.6);
      expect(da).toBeLessThanOrEqual(1.7);
      if (fin(a) && fin(b) && a <= b) expect(da).toBeLessThanOrEqual(dopplerFactor(b));
    }));
  });
});

describe('master / crash', () => {
  it('mute and pause silence everything; otherwise the configured volume', () => {
    expect(masterGain(false, false)).toBe(A.masterVolume);
    expect(masterGain(true, false)).toBe(0);
    expect(masterGain(false, true)).toBe(0);
  });
  it('crash intensity grows with impact speed, bounded', () => {
    expect(crashIntensity(150)).toBeGreaterThan(crashIntensity(20));
    fc.assert(fc.property(anyNum, (s) => {
      const c = crashIntensity(s);
      expect(fin(c) && c >= 0.3 && c <= 1).toBe(true);
    }));
  });
});
