/**
 * Unit + property: the JetRanger's sound mapping (src/audio/turboshaftMapping.ts) is pure and total —
 * blade-passage and tail-rotor rates track NR, blade slap grows with thrust, descent (BVI), vortex ring
 * state and blade stall, the turbine follows N1 and power, and the low rotor RPM horn follows the real
 * 206's logic (below 95 % NR in flight; on the ground only with the engine running and the collective up).
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  TURBOSHAFT as T, bladePassHz, compressorWhineHz, emptyTurboshaftInput, gearWhineHz, impulsiveNoise, lightOff, lowRotorRpmHorn,
  rotorDirectivity, rotorPct, tailRotorHz, turboshaftInputs, turboshaftMix, type TurboshaftMixInput,
} from '../../src/audio/turboshaftMapping';
import type { AudioInputs } from '../../src/audio/types';

const HOVER: TurboshaftMixInput = {
  ...emptyTurboshaftInput(),
  nrRpm: T.nominalNrRpm, n1: 0.9, power: 0.74, torque: 0.78, thrustN: 12700, tailThrustN: 740, collective: 0.55,
  onGround: false, engineRunning: true,
};
const mix = (p: Partial<TurboshaftMixInput>) => turboshaftMix({ ...HOVER, ...p });

const LEVELS = [
  'whoosh', 'thump', 'slap', 'crack', 'sharpness', 'tail', 'tailBright', 'whine', 'howl', 'roar', 'roarBright', 'rumble', 'starter', 'igniter', 'gear', 'impulsive',
] as const;

describe('rotor frequencies', () => {
  it('100 % NR: blade passage 2 × 394 / 60 ≈ 13.1 Hz, tail rotor 2 × 2550 / 60 = 85 Hz', () => {
    expect(bladePassHz(394)).toBeCloseTo(13.133, 2);
    expect(tailRotorHz(394)).toBeCloseTo(85, 6);
    expect(rotorPct(394)).toBeCloseTo(100, 9);
    expect(gearWhineHz(394)).toBeCloseTo(T.gearMeshHz, 6);
  });
  it('the blade-passage and tail rates are proportional to NR (the wop-wop slows as the rotor decays)', () => {
    fc.assert(fc.property(fc.double({ min: 0, max: 500, noNaN: true }), (nr) => {
      expect(bladePassHz(nr)).toBeCloseTo((2 * nr) / 60, 9);
      expect(tailRotorHz(nr)).toBeCloseTo((2 * nr * 2550) / 394 / 60, 9);
      const m = mix({ nrRpm: nr });
      expect(m.bladeHz).toBeCloseTo(bladePassHz(nr), 9);
      expect(m.revHz * 2).toBeCloseTo(m.bladeHz, 9);
    }));
  });
  it('the compressor whine rises with N1 (several kHz at 100 %)', () => {
    expect(compressorWhineHz(1)).toBeGreaterThan(3000);
    expect(compressorWhineHz(1)).toBeLessThan(6000);
    expect(compressorWhineHz(0.63)).toBeLessThan(compressorWhineHz(0.9));
  });
});

describe('turboshaftMix is pure and total', () => {
  const wild = fc.oneof(fc.double(), fc.constantFrom(Number.NaN, Infinity, -Infinity, 0, 1e300, -1e300));
  const input = fc.record({
    nrRpm: wild, n1: wild, power: wild, torque: wild, thrustN: wild, tailThrustN: wild, collective: wild, vrs: wild, bladeStall: wild,
    groundEffect: wild, climbMs: wild, decelMs2: wild, airspeedKt: wild, onGround: fc.boolean(), engineRunning: fc.boolean(),
    starting: fc.boolean(), crashed: fc.boolean(),
  });
  it('fuzzed inputs → finite frequencies ≥ 0 and levels in 0..1; same input, same output', () => {
    fc.assert(fc.property(input, (i) => {
      const m = turboshaftMix(i);
      for (const [k, v] of Object.entries(m)) expect(Number.isFinite(v), k).toBe(true);
      for (const k of LEVELS) {
        expect(m[k], k).toBeGreaterThanOrEqual(0);
        expect(m[k], k).toBeLessThanOrEqual(1);
      }
      for (const k of ['bladeHz', 'tailHz', 'whineHz', 'howlHz', 'gearHz', 'starterHz'] as const) expect(m[k]).toBeGreaterThanOrEqual(0);
      expect(m.whineHz).toBeLessThan(20000);
      expect(turboshaftMix({ ...i })).toEqual(m);
    }), { numRuns: 2000 });
  });
  it('turboshaftInputs: fuzzed AudioInputs (with or without the rotor) → finite mix inputs', () => {
    const rotor = fc.option(fc.record({
      nrRpm: wild, n1: wild, enginePowerW: wild, torque: wild, thrustN: wild, tailThrustN: wild, collective: wild, vrs: wild,
      bladeStall: wild, groundEffect: wild, climbMs: wild, decelMs2: wild,
    }), { nil: undefined });
    fc.assert(fc.property(wild, wild, wild, fc.boolean(), fc.boolean(), rotor, (rpm, power, ias, running, onGround, r) => {
      const a = { rpm, power, airspeedKt: ias, engineRunning: running, onGround, starting: false, crashed: false, rotor: r } as unknown as AudioInputs;
      const i = turboshaftInputs(a);
      for (const [k, v] of Object.entries(i)) if (typeof v === 'number') expect(Number.isFinite(v), k).toBe(true);
      for (const [k, v] of Object.entries(turboshaftMix(i))) expect(Number.isFinite(v), k).toBe(true);
    }), { numRuns: 1000 });
  });
  it('a crash silences every channel', () => {
    const m = mix({ crashed: true, vrs: 1 });
    for (const k of LEVELS) expect(m[k], k).toBe(0);
  });
});

describe('main rotor: whoosh at light thrust, slap with loading and blade–vortex interaction', () => {
  it('slap and crack grow with thrust (monotone), and so does the sharpness', () => {
    let prev = mix({ thrustN: 0 });
    for (let th = 1000; th <= 2.2 * T.weightN; th += 1000) {
      const m = mix({ thrustN: th });
      expect(m.slap).toBeGreaterThanOrEqual(prev.slap);
      expect(m.crack).toBeGreaterThanOrEqual(prev.crack);
      expect(m.sharpness).toBeGreaterThanOrEqual(prev.sharpness);
      expect(m.thump).toBeGreaterThanOrEqual(prev.thump);
      prev = m;
    }
    expect(mix({ thrustN: 1.8 * T.weightN }).slap).toBeGreaterThan(mix({ thrustN: 0.3 * T.weightN }).slap * 2);
  });
  it('light thrust (flat pitch) is a soft whoosh, not a slap', () => {
    const m = mix({ thrustN: 0.1 * T.weightN, onGround: true, collective: 0 });
    expect(m.whoosh).toBeGreaterThan(m.slap * 3);
    expect(m.sharpness).toBeLessThan(0.1);
  });
  it('vortex ring state makes it slap: monotone in vrs, much sharper at vrs = 1', () => {
    let prev = mix({ vrs: 0 });
    for (let v = 0.1; v <= 1.0001; v += 0.1) {
      const m = mix({ vrs: v });
      expect(m.slap).toBeGreaterThanOrEqual(prev.slap);
      expect(m.crack).toBeGreaterThanOrEqual(prev.crack);
      prev = m;
    }
    expect(mix({ vrs: 1 }).slap).toBeGreaterThan(mix({ vrs: 0 }).slap * 2.5);
    expect(mix({ vrs: 1 }).sharpness).toBeGreaterThan(0.8);
  });
  it('a 500 fpm descent at 60 kt (BVI), a decelerating flare, a tight turn, blade stall and a 130 kt dash all slap harder than the hover', () => {
    const hover = mix({}).slap;
    expect(mix({ climbMs: -3, airspeedKt: 60 }).slap).toBeGreaterThan(hover * 2);
    expect(mix({ decelMs2: 2.5, airspeedKt: 40 }).slap).toBeGreaterThan(hover * 2);
    expect(mix({ thrustN: 1.7 * T.weightN }).slap).toBeGreaterThan(hover * 1.8);
    expect(mix({ bladeStall: 1, airspeedKt: 120 }).slap).toBeGreaterThan(hover * 2);
    expect(mix({ airspeedKt: 135 }).slap).toBeGreaterThan(hover * 1.5);
    // A climb or a level cruise at 80 kt does not.
    expect(impulsiveNoise({ ...HOVER, climbMs: 5, airspeedKt: 60 })).toBe(0);
    expect(impulsiveNoise({ ...HOVER, airspeedKt: 80 })).toBe(0);
  });
  it('NR decaying (engine off): the rotor gets quieter and slower; a stopped rotor is silent', () => {
    const off = { engineRunning: false, n1: 0, power: 0 };
    const full = mix({ ...off, nrRpm: 394 });
    const half = mix({ ...off, nrRpm: 197 });
    const stopped = mix({ ...off, nrRpm: 0 });
    expect(half.whoosh).toBeLessThan(full.whoosh);
    expect(half.thump).toBeLessThan(full.thump);
    expect(half.bladeHz).toBeCloseTo(full.bladeHz / 2, 9);
    for (const k of ['whoosh', 'thump', 'slap', 'crack', 'tail', 'gear'] as const) expect(stopped[k], k).toBe(0);
  });
});

describe('tail rotor, turbine, transmission', () => {
  it('tail thrust loads and brightens the tail rotor', () => {
    expect(mix({ tailThrustN: 1500 }).tail).toBeGreaterThan(mix({ tailThrustN: 100 }).tail);
    expect(mix({ tailThrustN: -1500 }).tailBright).toBeGreaterThan(mix({ tailThrustN: 0 }).tailBright);
  });
  it('the tail rotor is louder from behind than from ahead; the slap from ahead', () => {
    const behind = rotorDirectivity(1);
    const ahead = rotorDirectivity(-1);
    expect(behind.tail).toBeGreaterThan(ahead.tail * 1.5);
    expect(ahead.main).toBeGreaterThan(behind.main);
    for (const v of [Number.NaN, Infinity, -Infinity]) for (const x of Object.values(rotorDirectivity(v))) expect(Number.isFinite(x)).toBe(true);
  });
  it('the whine follows N1; the exhaust roar rises with power; a shutdown spools the whine down with N1', () => {
    expect(mix({ n1: 1 }).whine).toBeGreaterThan(mix({ n1: 0.7 }).whine);
    expect(mix({ n1: 1 }).whineHz).toBeGreaterThan(mix({ n1: 0.7 }).whineHz);
    let prev = -1;
    for (let p = 0; p <= 1; p += 0.1) {
      const r = mix({ power: p }).roar;
      expect(r).toBeGreaterThan(prev);
      prev = r;
    }
    const spoolDown = mix({ engineRunning: false, n1: 0.35, power: 0 });
    expect(spoolDown.whine).toBeGreaterThan(0);
    expect(spoolDown.whine).toBeLessThan(mix({}).whine);
    expect(spoolDown.rumble).toBe(0);
    expect(mix({ engineRunning: false, n1: 0, nrRpm: 200 }).whine).toBe(0);
  });
  it('starting: starter whine rising with N1, igniters until starter cut-out; light-off when N1 crosses the light-off speed', () => {
    const s = { engineRunning: false, starting: true, power: 0, nrRpm: 60 };
    expect(mix({ ...s, n1: 0.1 }).starter).toBe(1);
    expect(mix({ ...s, n1: 0.1 }).igniter).toBe(1);
    expect(mix({ ...s, n1: 0.6 }).igniter).toBe(0);
    expect(mix({ ...s, n1: 0.5 }).starterHz).toBeGreaterThan(mix({ ...s, n1: 0.1 }).starterHz);
    expect(mix({}).starter).toBe(0);
    expect(mix({ ...s, n1: 0.05 }).roar).toBe(0);
    expect(mix({ ...s, n1: 0.4 }).roar).toBeGreaterThan(0);
    expect(lightOff(0.1, 0.13, true)).toBe(true);
    expect(lightOff(0.13, 0.2, true)).toBe(false);
    expect(lightOff(0.1, 0.13, false)).toBe(false);
    expect(lightOff(Number.NaN, Number.NaN, true)).toBe(false);
  });
  it('the transmission whine follows NR and torque', () => {
    expect(mix({ torque: 1 }).gear).toBeGreaterThan(mix({ torque: 0.1 }).gear);
    expect(mix({ nrRpm: 300 }).gearHz).toBeLessThan(mix({}).gearHz);
  });
});

describe('low rotor RPM horn', () => {
  it('airborne: on below 95 % NR (engine running or not), off at or above', () => {
    expect(lowRotorRpmHorn(94.9, false, 0.5, true, false)).toBe(true);
    expect(lowRotorRpmHorn(80, false, 0.1, false, false)).toBe(true); // autorotation with a low rotor
    expect(lowRotorRpmHorn(95, false, 0.5, true, false)).toBe(false);
    expect(lowRotorRpmHorn(101, false, 0.5, true, false)).toBe(false);
  });
  it('on the ground: silent at flat pitch (start, ground idle, shutdown); on with the engine running and the collective up', () => {
    expect(lowRotorRpmHorn(60, true, 0, true, false)).toBe(false);
    expect(lowRotorRpmHorn(20, true, 0.02, false, false)).toBe(false);
    expect(lowRotorRpmHorn(90, true, 0.3, true, false)).toBe(true);
    expect(lowRotorRpmHorn(90, true, 0.3, false, false)).toBe(false);
  });
  it('a little hysteresis, and never after a crash or on NaN', () => {
    expect(lowRotorRpmHorn(95.3, false, 0.5, true, false, true)).toBe(true);
    expect(lowRotorRpmHorn(95.3, false, 0.5, true, false, false)).toBe(false);
    expect(lowRotorRpmHorn(96, false, 0.5, true, false, true)).toBe(false);
    expect(lowRotorRpmHorn(50, false, 0.5, true, true)).toBe(false);
    expect(lowRotorRpmHorn(Number.NaN, false, 0.5, true, false)).toBe(false);
  });
});
