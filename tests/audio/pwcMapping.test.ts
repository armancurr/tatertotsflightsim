/**
 * Unit: the PURE jet-ski mappings (pwcMapping.ts) — the Rotax triple's firing rate rpm/40, the
 * supercharger whine and impeller tone, the pump growing with flow and jet speed, ventilation taking the
 * load and the water roar away, the hull's slaps, the run-down, the blow-off and landing detectors, the
 * triple's cycle waveform, and totality (NaN/±∞ in → finite, bounded out).
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  PWC as P, blowOffStep, bucketGear, emptyPwcEngine, impellerBladeHz, landingStep, newAirState, newBlowOff, pwcCycleHz,
  pwcEngineMix, pwcFiringHz, pwcPumpMix, pwcRundownRpm, pwcWaterMix, pwcWindScale, sanitisePwcEngine, superchargerWhineHz,
  tripleCycleWaveform, zeroPwcLevels,
} from '../../src/audio/pwcMapping';
import { goertzelAmplitude } from '../../src/audio/analysis';
import type { AudioInputs, AudioLevels } from '../../src/audio/types';

const wild = fc.oneof(fc.double(), fc.constantFrom(Number.NaN, Infinity, -Infinity, 0, 1e300, -1e300));
const rpmArb = fc.double({ min: 0, max: 9000, noNaN: true });
const A0 = { rpm: 0, power: 0, engineRunning: false } as AudioInputs;

describe('jet ski frequencies', () => {
  it('firing = rpm/60 × 1.5 for the 3-cylinder 4-stroke: 42.5 Hz at idle 1,700, 200 Hz at 8,000; the cycle is rpm/120', () => {
    expect(pwcFiringHz(1700)).toBeCloseTo(42.5, 9);
    expect(pwcFiringHz(8000)).toBeCloseTo(200, 9);
    expect(pwcFiringHz(4200)).toBeCloseTo(105, 9);
    expect(pwcCycleHz(8000)).toBeCloseTo(8000 / 120, 9);
    expect(pwcFiringHz(5000)).toBeCloseTo(pwcCycleHz(5000) * 3, 9);
    expect(pwcFiringHz(-5)).toBe(0);
    expect(pwcFiringHz(1e12)).toBeLessThanOrEqual(1.25 * 200 + 1e-9);
  });
  it('supercharger whine: monotone in rpm, ≈1.3 kHz at idle, in the 2–7 kHz range at high rpm, bounded', () => {
    fc.assert(fc.property(rpmArb, rpmArb, (a, b) => {
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      expect(superchargerWhineHz(hi)).toBeGreaterThanOrEqual(superchargerWhineHz(lo));
    }));
    expect(superchargerWhineHz(1700)).toBeGreaterThan(1000);
    expect(superchargerWhineHz(1700)).toBeLessThan(1600);
    expect(superchargerWhineHz(8000)).toBeGreaterThan(5000);
    expect(superchargerWhineHz(8000)).toBeLessThan(7000);
    expect(superchargerWhineHz(Infinity)).toBeLessThanOrEqual(16000);
  });
  it('impeller blade passage: 4 blades at engine speed', () => {
    expect(impellerBladeHz(6000)).toBeCloseTo(400, 9);
    expect(impellerBladeHz(Number.NaN)).toBe(0);
  });
  it('bucket gear sign', () => {
    expect(bucketGear(1)).toBe(1);
    expect(bucketGear(0)).toBe(0);
    expect(bucketGear(-1)).toBe(-1);
    expect(bucketGear(Number.NaN)).toBe(0);
  });
  it('the triple cycle waveform: the 3rd harmonic (firing) dominates; the uneven pulses leave some half-order (1st, 2nd)', () => {
    const n = 4096;
    const one = tripleCycleWaveform(n);
    const s = new Float32Array(n * 4);
    for (let i = 0; i < s.length; i++) s[i] = one[i % n];
    const amp = (h: number) => goertzelAmplitude(s, n, h);
    const three = amp(3);
    for (const h of [1, 2, 4, 5]) expect(three).toBeGreaterThan(amp(h) * 2);
    expect(amp(1) + amp(2)).toBeGreaterThan(three * 0.02);
    for (const v of one) expect(Math.abs(v)).toBeLessThanOrEqual(1 + 1e-6);
  });
});

describe('pwcRundownRpm', () => {
  it('follows the physics while running; after a stop it decays (not instantly) and stops below stopRpm', () => {
    expect(pwcRundownRpm(0, 5000, true, 1 / 60)).toBe(5000);
    let r = 1700;
    r = pwcRundownRpm(r, 0, false, 0.1);
    expect(r).toBeGreaterThan(1000);
    expect(r).toBeLessThan(1700);
    for (let i = 0; i < 60; i++) r = pwcRundownRpm(r, 0, false, 1 / 60);
    expect(r).toBe(0);
    expect(pwcRundownRpm(Number.NaN, Number.NaN, false, Number.NaN)).toBe(0);
  });
});

describe('pwcEngineMix', () => {
  it('silent when not running (only the machinery and the supercharger turning), silent in a wreck', () => {
    const off = pwcEngineMix(3000, 0.5, 0.5, 0, false, false);
    expect(off.tone).toBe(0);
    expect(off.rasp).toBe(0);
    expect(off.exhaust).toBe(0);
    expect(off.mech).toBeGreaterThan(0);
    expect(off.whine).toBeGreaterThan(0);
    const wreck = pwcEngineMix(8000, 1, 1, 0, true, true);
    for (const k of ['tone', 'rasp', 'exhaust', 'gurgle', 'whine', 'mech', 'load'] as const) expect(wreck[k]).toBe(0);
  });
  it('load hardens the note into a snarl; wet and gurgly at idle; the whine grows with boost and load', () => {
    const light = pwcEngineMix(6000, 0.1, 0.2, 0, true, false);
    const heavy = pwcEngineMix(6000, 1, 1, 0, true, false);
    expect(heavy.drive).toBeGreaterThan(light.drive * 2);
    expect(heavy.rasp).toBeGreaterThan(light.rasp);
    expect(heavy.raspHz).toBeGreaterThan(light.raspHz);
    expect(heavy.tone).toBeGreaterThan(light.tone);
    expect(heavy.whine).toBeGreaterThan(light.whine * 1.5);
    const idle = pwcEngineMix(1700, 0.08, 0.05, 0, true, false);
    expect(idle.gurgle).toBeGreaterThan(0.8);
    expect(heavy.gurgle).toBe(0);
    expect(idle.exhaustLpHz).toBeLessThan(heavy.exhaustLpHz);
  });
  it('ventilation takes the load off: the snarl, the drive and the whine drop at the same rpm', () => {
    const wet = pwcEngineMix(6000, 0.9, 0.9, 0, true, false);
    const air = pwcEngineMix(6000, 0.9, 0.9, 1, true, false);
    expect(air.load).toBeLessThan(wet.load * 0.3);
    expect(air.rasp).toBeLessThan(wet.rasp);
    expect(air.drive).toBeLessThan(wet.drive);
    expect(air.whine).toBeLessThan(wet.whine);
    expect(air.tone).toBeLessThan(wet.tone);
  });
  it('monotone in rpm and load', () => {
    fc.assert(fc.property(rpmArb, rpmArb, fc.double({ min: 0, max: 1, noNaN: true }), (a, b, l) => {
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      const x = pwcEngineMix(lo, l, l, 0, true, false);
      const y = pwcEngineMix(hi, l, l, 0, true, false);
      expect(y.tone).toBeGreaterThanOrEqual(x.tone - 1e-12);
      expect(y.whine).toBeGreaterThanOrEqual(x.whine - 1e-12);
      expect(y.mech).toBeGreaterThanOrEqual(x.mech - 1e-12);
      const p = pwcEngineMix(hi, Math.min(l, 0.5), 0.5, 0, true, false);
      const q = pwcEngineMix(hi, Math.max(l, 0.5), 0.5, 0, true, false);
      expect(q.rasp).toBeGreaterThanOrEqual(p.rasp - 1e-12);
      expect(q.tone).toBeGreaterThanOrEqual(p.tone - 1e-12);
    }));
  });
});

describe('pwcPumpMix', () => {
  it('the water roar grows with flow and with jet speed (monotone in each)', () => {
    fc.assert(fc.property(
      fc.double({ min: 0, max: 0.4, noNaN: true }), fc.double({ min: 0, max: 0.4, noNaN: true }), fc.double({ min: 0, max: 60, noNaN: true }), fc.double({ min: 0, max: 60, noNaN: true }),
      (f1, f2, j1, j2) => {
        const [fl, fh] = f1 <= f2 ? [f1, f2] : [f2, f1];
        const [jl, jh] = j1 <= j2 ? [j1, j2] : [j2, j1];
        expect(pwcPumpMix(5000, fh, jl, 0.5, 10, 0, false).roar).toBeGreaterThanOrEqual(pwcPumpMix(5000, fl, jl, 0.5, 10, 0, false).roar - 1e-12);
        expect(pwcPumpMix(5000, fl, jh, 0.5, 10, 0, false).roar).toBeGreaterThanOrEqual(pwcPumpMix(5000, fl, jl, 0.5, 10, 0, false).roar - 1e-12);
        expect(pwcPumpMix(5000, fl, jh, 0.5, 10, 0, false).nozzle).toBeGreaterThanOrEqual(pwcPumpMix(5000, fl, jl, 0.5, 10, 0, false).nozzle - 1e-12);
      },
    ));
    const idle = pwcPumpMix(1700, 0.03, 6, 0.08, 0, 0, false);
    const full = pwcPumpMix(8000, 0.28, 47, 1, 28, 0, false);
    expect(full.roar).toBeGreaterThan(idle.roar * 3);
    expect(full.roarHz).toBeGreaterThan(idle.roarHz);
    expect(full.bladeHz).toBeCloseTo(impellerBladeHz(8000), 9);
  });
  it('ventilation: the roar and the blade tone go, the hollow sputter comes', () => {
    const wet = pwcPumpMix(4200, 0.2, 30, 0.5, 20, 0, false);
    const air = pwcPumpMix(4200, 0.2, 30, 0.5, 20, 1, false);
    expect(wet.vent).toBe(0);
    expect(air.vent).toBeGreaterThan(0.8);
    expect(air.roar).toBe(0);
    expect(air.blade).toBe(0);
    expect(air.nozzle).toBeLessThan(wet.nozzle);
    expect(air.cavitation).toBe(0);
  });
  it('cavitation on a hard launch (high load, low speed), not at speed', () => {
    const launch = pwcPumpMix(7000, 0.25, 40, 1, 1, 0, false);
    const cruise = pwcPumpMix(7000, 0.25, 40, 1, 25, 0, false);
    expect(launch.cavitation).toBeGreaterThan(0.5);
    expect(cruise.cavitation).toBeLessThan(0.05);
  });
});

describe('pwcWaterMix', () => {
  it('rush grows with speed; the gurgle at displacement speeds; skim only planing; grinding aground', () => {
    const rest = pwcWaterMix(0, 0, 0, 0, 0, false, 0);
    const slow = pwcWaterMix(2, 0.1, 0, 0, 0, false, 0);
    const fast = pwcWaterMix(25, 1, 0.3, 0.05, 0.05, false, 0);
    expect(rest.rush).toBe(0);
    expect(slow.rush).toBeGreaterThan(0);
    expect(fast.rush).toBeGreaterThan(slow.rush);
    expect(slow.wash).toBeGreaterThan(fast.wash);
    expect(slow.skim).toBe(0);
    expect(fast.skim).toBeGreaterThan(0.5);
    expect(pwcWaterMix(2, 0, 0, 0, 0, true, 0).grind).toBeGreaterThan(0.3);
  });
  it('a small planing hull slaps often at speed in a chop; nothing in the air', () => {
    const calm = pwcWaterMix(0, 0, 0, 0, 0, false, 0);
    const chop = pwcWaterMix(20, 0.9, 0.9, 0.25, 0.1, false, 0);
    const air = pwcWaterMix(20, 0.9, 0.9, 0.25, 0.1, false, 1);
    expect(calm.slapRate).toBeGreaterThan(0);
    expect(chop.slapRate).toBeGreaterThan(6);
    expect(chop.slapIntensity).toBeGreaterThan(calm.slapIntensity);
    expect(air.slapRate).toBe(0);
    expect(air.rush).toBeLessThan(chop.rush * 0.3);
  });
  it('wind scale: the rider has the wind in the ears', () => {
    expect(pwcWindScale(false)).toBeGreaterThan(pwcWindScale(true));
  });
});

describe('detectors', () => {
  it('blow-off: once when the throttle is chopped at high rpm; not on the ECU cut (ventilating), not at low rpm', () => {
    const run = (rpm: number, vent: number) => {
      const s = newBlowOff();
      let n = 0;
      for (let i = 0; i < 60; i++) n += blowOffStep(s, rpm, 1, 0, true, 1 / 60) ? 1 : 0;
      for (let i = 0; i < 60; i++) n += blowOffStep(s, rpm * 0.8, 0.05, vent, true, 1 / 60) ? 1 : 0;
      return n;
    };
    expect(run(7500, 0)).toBe(1);
    expect(run(7500, 1)).toBe(0);
    expect(run(3000, 0)).toBe(0);
    const s = newBlowOff();
    expect(blowOffStep(s, 8000, 1, 0, false, 1 / 60)).toBe(false);
  });
  it('landing: after ≥ minAirS of ventilation, once, harder for longer flights; a brief gulp of air is not a jump', () => {
    const fly = (seconds: number, heave: number) => {
      const s = newAirState();
      const hits: number[] = [];
      for (let i = 0; i < Math.round(seconds * 60); i++) hits.push(landingStep(s, 1, heave, 1 / 60));
      for (let i = 0; i < 30; i++) hits.push(landingStep(s, 0, heave, 1 / 60));
      return hits.filter((h) => h > 0);
    };
    expect(fly(0.1, -1)).toEqual([]);
    const short = fly(0.4, -1);
    const long = fly(1.5, -4);
    expect(short.length).toBe(1);
    expect(long.length).toBe(1);
    expect(long[0]).toBeGreaterThan(short[0]);
    expect(long[0]).toBeLessThanOrEqual(1);
    expect(short[0]).toBeGreaterThanOrEqual(0.3);
  });
});

describe('inputs and levels', () => {
  it('sanitise: copies the propulsor; estimates the jet fields from rpm when absent; falls back on rpm / power without one', () => {
    const e = sanitisePwcEngine({ rpm: 8000, load: 1, boost: 1, gear: 1, propRps: 133, thrustN: 9000, flow: 0.27, jetSpeed: 46, ventilation: 0.2, bucket: 0 }, A0, emptyPwcEngine());
    expect(e).toEqual({ rpm: 8000, load: 1, boost: 1, gear: 1, thrustN: 9000, flow: 0.27, jetSpeed: 46, ventilation: 0.2, bucket: 0 });
    const est = sanitisePwcEngine({ rpm: 8000, load: 1, boost: 1, gear: -1, propRps: 133, thrustN: 0 }, A0, emptyPwcEngine());
    expect(est.flow).toBeCloseTo(P.maxFlow, 9);
    expect(est.jetSpeed).toBeCloseTo(P.maxJetSpeed, 9);
    expect(est.ventilation).toBe(0);
    expect(est.bucket).toBe(1);
    const fb = sanitisePwcEngine(undefined, { ...A0, rpm: 5000, power: 0.6 }, emptyPwcEngine());
    expect(fb.rpm).toBe(5000);
    expect(fb.load).toBeCloseTo(0.6, 9);
  });
  it('zeroPwcLevels silences the pwc channels', () => {
    const L = { pwc: 1, pump: 0.5, pumpVent: 0.7 } as AudioLevels;
    zeroPwcLevels(L);
    expect([L.pwc, L.pump, L.pumpVent]).toEqual([0, 0, 0]);
  });
});

describe('totality', () => {
  it('NaN/±∞ in → finite, bounded out', () => {
    fc.assert(fc.property(wild, wild, wild, wild, wild, wild, fc.boolean(), fc.boolean(), (r, l, b, v, s, h, run, crash) => {
      expect(Number.isFinite(pwcFiringHz(r))).toBe(true);
      expect(Number.isFinite(superchargerWhineHz(r))).toBe(true);
      expect(Number.isFinite(pwcRundownRpm(r, l, run, b))).toBe(true);
      const m = pwcEngineMix(r, l, b, v, run, crash);
      for (const [k, x] of Object.entries(m)) expect(Number.isFinite(x), k).toBe(true);
      for (const k of ['tone', 'bright', 'rasp', 'exhaust', 'gurgle', 'whine', 'mech', 'load', 'combustion'] as const) {
        expect(m[k], k).toBeGreaterThanOrEqual(0);
        expect(m[k], k).toBeLessThanOrEqual(1);
      }
      const u = pwcPumpMix(r, l, b, v, s, h, crash);
      for (const [k, x] of Object.entries(u)) expect(Number.isFinite(x), k).toBe(true);
      for (const k of ['roar', 'nozzle', 'blade', 'cavitation', 'vent'] as const) {
        expect(u[k], k).toBeGreaterThanOrEqual(0);
        expect(u[k], k).toBeLessThanOrEqual(1);
      }
      const w = pwcWaterMix(r, l, b, v, s, crash, h);
      for (const [k, x] of Object.entries(w)) expect(Number.isFinite(x), k).toBe(true);
      expect(w.slapRate).toBeLessThanOrEqual(14);
      const bo = newBlowOff();
      expect(typeof blowOffStep(bo, r, l, v, run, s)).toBe('boolean');
      expect(Number.isFinite(bo.slow)).toBe(true);
      const air = newAirState();
      const li = landingStep(air, v, h, s);
      expect(Number.isFinite(li) && li >= 0 && li <= 1).toBe(true);
      const e = sanitisePwcEngine({ rpm: r, load: l, boost: b, gear: v, propRps: s, thrustN: h, flow: l, jetSpeed: s, ventilation: v, bucket: b }, { ...A0, rpm: r, power: l }, emptyPwcEngine());
      for (const [k, x] of Object.entries(e)) expect(Number.isFinite(x), k).toBe(true);
    }), { numRuns: 500 });
  });
});
