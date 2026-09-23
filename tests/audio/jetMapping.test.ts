import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  jetCorePct, jetFanPct, jetWhineHz, jetShaftHz, jetFanHz, jetIntakeHz, jetMix, jetDirectivity, jetRoarCutoffHz, abLightOff,
} from '../../src/audio/jetMapping';
import { CONFIG } from '../../src/config';

const J = CONFIG.audio.jet;
const anyNum = fc.double();
const fin = (v: number) => Number.isFinite(v);
const RUN = { power: 0, afterburner: 0, engineRunning: true, starting: false, crashed: false };

describe('jet spool speeds', () => {
  it('state.engine.rpm is the core speed N2 in % (0..~110)', () => {
    expect(jetCorePct(0)).toBe(0);
    expect(jetCorePct(70)).toBe(70);
    expect(jetCorePct(100)).toBe(100);
    expect(jetCorePct(104)).toBe(104);
  });
  it('a piston-style rpm (placeholder physics) is read as a fraction of the piston max rpm', () => {
    const max = CONFIG.aircraft.engine.maxRpm;
    expect(jetCorePct(max)).toBeCloseTo(100, 6);
    expect(jetCorePct(max / 2)).toBeCloseTo(50, 6);
  });
  it('the fan (N1) lags the core: ~40 % at ground idle, 100 % at 100 % N2', () => {
    expect(jetFanPct(0)).toBe(0);
    expect(jetFanPct(J.idleCorePct)).toBeGreaterThan(30);
    expect(jetFanPct(J.idleCorePct)).toBeLessThan(50);
    expect(jetFanPct(100)).toBeCloseTo(100, 6);
  });
  it('the whine is the HP-compressor blade-pass tone: ~3.5 kHz at idle, ~5 kHz at 100 %', () => {
    expect(jetWhineHz(100)).toBeCloseTo((J.coreMaxRpm / 60) * J.whineBlades, 6);
    expect(jetWhineHz(100)).toBeGreaterThan(4500);
    expect(jetWhineHz(100)).toBeLessThan(5600);
    expect(jetWhineHz(J.idleCorePct)).toBeGreaterThan(3000);
    expect(jetWhineHz(J.idleCorePct)).toBeLessThan(4000);
    expect(jetShaftHz(100)).toBeCloseTo(J.coreMaxRpm / 60, 6);
    expect(jetFanHz(100)).toBeCloseTo(J.fanMaxRpm / 60, 6);
  });
  it('fuzz: speeds and frequencies are finite, non-negative, bounded and monotone', () => {
    fc.assert(fc.property(anyNum, anyNum, (a, b) => {
      for (const f of [jetCorePct, (x: number) => jetFanPct(jetCorePct(x)), (x: number) => jetWhineHz(jetCorePct(x)), (x: number) => jetFanHz(jetCorePct(x)), (x: number) => jetIntakeHz(jetCorePct(x))]) {
        const v = f(a);
        expect(fin(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }
      expect(jetCorePct(a)).toBeLessThanOrEqual(115);
      expect(jetWhineHz(jetCorePct(a))).toBeLessThan(8000);
      const pa = jetCorePct(a);
      const pb = jetCorePct(b);
      if (fin(a) && fin(b) && pa <= pb) {
        expect(jetFanPct(pa)).toBeLessThanOrEqual(jetFanPct(pb));
        expect(jetWhineHz(pa)).toBeLessThanOrEqual(jetWhineHz(pb));
      }
    }));
  });
});

describe('jetMix', () => {
  it('silent when stopped, and on a crash', () => {
    const off = jetMix({ ...RUN, corePct: 0, engineRunning: false });
    for (const v of Object.values(off)) expect(v).toBe(0);
    const crashed = jetMix({ ...RUN, corePct: 100, power: 1, afterburner: 1, crashed: true });
    for (const k of ['whine', 'fan', 'roar', 'rumble', 'abRumble', 'abTear', 'crackle', 'intake', 'starter'] as const) expect(crashed[k]).toBe(0);
  });
  it('idle: the whine dominates; MIL: the roar dominates; AB adds a deep rumble and crackle', () => {
    const idle = jetMix({ ...RUN, corePct: J.idleCorePct, power: 0.02 });
    const mil = jetMix({ ...RUN, corePct: 100, power: 1 });
    const ab = jetMix({ ...RUN, corePct: 100, power: 1, afterburner: 1 });
    expect(idle.whine).toBeGreaterThan(0.4);
    expect(idle.roar).toBeLessThan(0.35);
    expect(idle.roar).toBeGreaterThan(0.05);
    expect(mil.roar).toBeGreaterThan(0.9);
    expect(mil.fan).toBeGreaterThan(idle.fan);
    expect(idle.abRumble).toBe(0);
    expect(mil.abRumble).toBe(0);
    expect(mil.crackle).toBe(0);
    expect(ab.abRumble).toBeGreaterThan(0.9);
    expect(ab.crackle).toBeGreaterThan(0.9);
    expect(ab.brightness).toBeGreaterThanOrEqual(mil.brightness);
  });
  it('a running engine never sounds below ground idle (placeholder physics with piston rpm)', () => {
    const low = jetMix({ ...RUN, corePct: 20, power: 0 });
    const idle = jetMix({ ...RUN, corePct: J.idleCorePct, power: 0 });
    expect(low.whine).toBeCloseTo(idle.whine, 3);
    expect(low.corePct).toBeGreaterThanOrEqual(J.idleCorePct * 0.97);
  });
  it('spooling down after shutdown: the whine fades with the core speed', () => {
    const a = jetMix({ ...RUN, engineRunning: false, corePct: 60 });
    const b = jetMix({ ...RUN, engineRunning: false, corePct: 25 });
    const c = jetMix({ ...RUN, engineRunning: false, corePct: 5 });
    expect(a.whine).toBeGreaterThan(b.whine);
    expect(b.whine).toBeGreaterThan(c.whine);
    expect(a.roar).toBe(0); // no combustion
  });
  it('the jet fuel starter sounds only while starting', () => {
    expect(jetMix({ ...RUN, engineRunning: false, starting: true, corePct: 15 }).starter).toBe(1);
    expect(jetMix({ ...RUN, corePct: 80 }).starter).toBe(0);
  });
  it('fuzz: every channel is finite in [0,1] and monotone in power and afterburner', () => {
    const b = fc.boolean();
    fc.assert(fc.property(anyNum, anyNum, anyNum, anyNum, b, b, b, (core, p, ab, dp, running, starting, crashed) => {
      const m = jetMix({ corePct: core, power: p, afterburner: ab, engineRunning: running, starting, crashed });
      for (const [k, v] of Object.entries(m)) {
        expect(fin(v), k).toBe(true);
        if (k !== 'corePct') {
          expect(v, k).toBeGreaterThanOrEqual(0);
          expect(v, k).toBeLessThanOrEqual(1);
        }
      }
      if (fin(p) && fin(dp) && fin(core)) {
        const hi = jetMix({ corePct: core, power: p + Math.abs(dp), afterburner: ab, engineRunning: running, starting, crashed });
        expect(hi.roar).toBeGreaterThanOrEqual(m.roar - 1e-12);
        const hiAb = jetMix({ corePct: core, power: p, afterburner: (fin(ab) ? ab : 0) + Math.abs(dp), engineRunning: running, starting, crashed });
        expect(hiAb.abRumble).toBeGreaterThanOrEqual(m.abRumble - 1e-12);
      }
    }));
  });
});

describe('jet directivity and filters', () => {
  it('behind the jet the roar dominates; in front the whine/fan (inlet) dominate', () => {
    const behind = jetDirectivity(1);
    const front = jetDirectivity(-1);
    const side = jetDirectivity(0);
    expect(behind.aft).toBeGreaterThan(front.aft);
    expect(front.fore).toBeGreaterThan(behind.fore);
    expect(side.aft).toBeLessThan(behind.aft);
    expect(behind.aft).toBeCloseTo(1, 6);
    expect(front.fore).toBeCloseTo(1, 6);
  });
  it('the roar opens up with power and afterburner', () => {
    expect(jetRoarCutoffHz(1, 0)).toBeGreaterThan(jetRoarCutoffHz(0, 0));
    expect(jetRoarCutoffHz(1, 1)).toBeGreaterThan(jetRoarCutoffHz(1, 0));
  });
  it('afterburner light-off is an upward crossing of the threshold only', () => {
    expect(abLightOff(0, 0.3)).toBe(true);
    expect(abLightOff(0.3, 0.6)).toBe(false);
    expect(abLightOff(0.6, 0)).toBe(false);
    expect(abLightOff(Number.NaN, 0.5)).toBe(true);
    expect(abLightOff(0, Number.NaN)).toBe(false);
  });
  it('fuzz: directivity and cutoffs finite and bounded', () => {
    fc.assert(fc.property(anyNum, anyNum, anyNum, (aft, p, ab) => {
      const d = jetDirectivity(aft);
      for (const v of [d.aft, d.fore]) {
        expect(fin(v)).toBe(true);
        expect(v).toBeGreaterThan(0.2);
        expect(v).toBeLessThanOrEqual(1);
      }
      const c = jetRoarCutoffHz(p, ab);
      expect(fin(c)).toBe(true);
      expect(c).toBeGreaterThanOrEqual(200);
      expect(c).toBeLessThanOrEqual(8000);
    }));
  });
});
