/**
 * Instrument readings a jet needs (Mach, afterburner, speed brake, sideslip, flight path) and
 * per-aircraft gauge limits: the F-16's airspeed must not peg at the Cessna's 250 kt stop.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { CONFIG, F16_AIRCRAFT, KT_TO_MS, type Config } from '../../src/config';
import { createInstrumentModel, updateInstruments, isaSpeedOfSound, instrumentLimits } from '../../src/ui/instruments';
import { arbState, arbControls, arbDt, makeState, makeControls } from './fixtures';

const F16: Config = { ...CONFIG, aircraft: F16_AIRCRAFT };
const DT = 1 / 60;

describe('ISA speed of sound and Mach', () => {
  it('is 340.3 m/s at sea level, 295.1 m/s at the tropopause (11 km) and constant above it', () => {
    expect(isaSpeedOfSound(0)).toBeCloseTo(340.29, 1);
    expect(isaSpeedOfSound(11000)).toBeCloseTo(295.07, 1);
    expect(isaSpeedOfSound(15000)).toBeCloseTo(295.07, 1);
    expect(isaSpeedOfSound(5000)).toBeLessThan(isaSpeedOfSound(0));
    expect(isaSpeedOfSound(5000)).toBeGreaterThan(isaSpeedOfSound(11000));
    expect(Number.isFinite(isaSpeedOfSound(Number.NaN))).toBe(true);
  });

  it('Mach = TAS / local speed of sound', () => {
    const s = makeState({ iasKt: 400, altFt: 0 });
    s.derived.tas = 340.29 * 0.8;
    s.position.y = 0;
    const r = updateInstruments(createInstrumentModel(), s, makeControls(), DT, F16);
    expect(r.mach).toBeCloseTo(0.8, 2);
    const hi = makeState({ iasKt: 300, altFt: 36089 });
    hi.derived.tas = 295.07 * 1.2;
    expect(updateInstruments(createInstrumentModel(), hi, makeControls(), DT, F16).mach).toBeCloseTo(1.2, 2);
  });

  it('Mach is 0 at rest and never negative', () => {
    const s = makeState({ iasKt: 0, onGround: true });
    s.derived.tas = -3;
    expect(updateInstruments(createInstrumentModel(), s, makeControls(), DT).mach).toBe(0);
  });
});

describe('jet readings', () => {
  it('afterburner comes from the engine (clamped 0..1); pistons read 0', () => {
    const s = makeState();
    expect(updateInstruments(createInstrumentModel(), s, makeControls(), DT).afterburner).toBe(0);
    s.engine = { ...s.engine, afterburner: 0.7 };
    expect(updateInstruments(createInstrumentModel(), s, makeControls(), DT, F16).afterburner).toBeCloseTo(0.7, 6);
    s.engine = { ...s.engine, afterburner: 3 };
    expect(updateInstruments(createInstrumentModel(), s, makeControls(), DT, F16).afterburner).toBe(1);
  });

  it('speed brake follows the X toggle (controls.speedBrake)', () => {
    const s = makeState();
    expect(updateInstruments(createInstrumentModel(), s, makeControls(), DT).speedBrake).toBe(false);
    expect(updateInstruments(createInstrumentModel(), s, makeControls({ speedBrake: true }), DT).speedBrake).toBe(true);
  });

  it('sideslip and flight-path angle in degrees (climbing = positive)', () => {
    const s = makeState({ betaDeg: 4, iasKt: 200, vsFpm: 2000 });
    const r = updateInstruments(createInstrumentModel(), s, makeControls(), DT, F16);
    expect(r.betaDeg).toBeCloseTo(4, 5);
    // sin γ = vs / tas
    expect(r.flightPathDeg).toBeCloseTo((Math.asin(2000 / 196.8504 / (200 * KT_TO_MS)) * 180) / Math.PI, 3);
    const d = updateInstruments(createInstrumentModel(), makeState({ vsFpm: -700 }), makeControls(), DT);
    expect(d.flightPathDeg).toBeLessThan(0);
  });
});

describe('per-aircraft limits', () => {
  it('the Cessna keeps the steam-gauge stops; the F-16 reads far beyond 250 kt', () => {
    expect(instrumentLimits(CONFIG).maxAirspeedKt).toBe(CONFIG.hud.maxAirspeedKt);
    expect(instrumentLimits(CONFIG).maxVsiFpm).toBe(CONFIG.hud.maxVsiFpm);
    expect(instrumentLimits(F16).maxAirspeedKt).toBeGreaterThanOrEqual(F16_AIRCRAFT.limits.vneKt);
    expect(instrumentLimits(F16).maxVsiFpm).toBeGreaterThan(CONFIG.hud.maxVsiFpm);
    const r = updateInstruments(createInstrumentModel(), makeState({ iasKt: 450, vsFpm: 15000 }), makeControls(), DT, F16);
    expect(r.airspeedKt).toBeCloseTo(450, 1);
    expect(r.verticalSpeedFpm).toBeCloseTo(15000, 0);
    const c = updateInstruments(createInstrumentModel(), makeState({ iasKt: 450 }), makeControls(), DT);
    expect(c.airspeedKt).toBe(CONFIG.hud.maxAirspeedKt);
  });
});

describe('jet readings: property', () => {
  it('random states with either aircraft: Mach finite ≥ 0, afterburner in [0,1], airspeed within the aircraft limit', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(arbState, arbControls, arbDt), { minLength: 1, maxLength: 8 }), fc.boolean(), (seq, jet) => {
        const cfg = jet ? F16 : CONFIG;
        const lim = instrumentLimits(cfg);
        const m = createInstrumentModel();
        for (const [s, c, dt] of seq) {
          const r = updateInstruments(m, s, c, dt, cfg);
          expect(Number.isFinite(r.mach)).toBe(true);
          expect(r.mach!).toBeGreaterThanOrEqual(0);
          expect(r.afterburner!).toBeGreaterThanOrEqual(0);
          expect(r.afterburner!).toBeLessThanOrEqual(1);
          expect(r.airspeedKt).toBeLessThanOrEqual(lim.maxAirspeedKt);
          expect(Math.abs(r.verticalSpeedFpm)).toBeLessThanOrEqual(lim.maxVsiFpm);
          expect(Number.isFinite(r.betaDeg)).toBe(true);
          expect(Math.abs(r.flightPathDeg)).toBeLessThanOrEqual(90);
          expect(typeof r.speedBrake).toBe('boolean');
        }
      }),
      { numRuns: 250 },
    );
  });
});
