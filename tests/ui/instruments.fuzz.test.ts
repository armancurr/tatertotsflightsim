import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { CONFIG } from '../../src/config';
import type { InstrumentReadings } from '../../src/types';
import { createInstrumentModel, updateInstruments } from '../../src/ui/instruments';
import { arbState, arbControls, arbDt, makeState, makeControls } from './fixtures';

const NUMERIC: (keyof InstrumentReadings)[] = [
  'airspeedKt', 'altitudeFt', 'altitudeAglFt', 'headingDeg', 'verticalSpeedFpm', 'pitchDeg', 'rollDeg', 'slipSkid',
  'turnRateDegPerSec', 'throttlePct', 'rpm', 'flapsDeg', 'flapsTargetDeg', 'trimPct', 'aoaDeg', 'gLoad', 'groundSpeedKt',
];

function checkRanges(r: InstrumentReadings): void {
  for (const k of NUMERIC) expect(Number.isFinite(r[k] as number), `${k} = ${r[k]}`).toBe(true);
  expect(r.headingDeg).toBeGreaterThanOrEqual(0);
  expect(r.headingDeg).toBeLessThan(360);
  expect(r.airspeedKt).toBeGreaterThanOrEqual(0);
  expect(r.airspeedKt).toBeLessThanOrEqual(CONFIG.hud.maxAirspeedKt);
  expect(Math.abs(r.verticalSpeedFpm)).toBeLessThanOrEqual(CONFIG.hud.maxVsiFpm);
  expect(r.pitchDeg).toBeGreaterThanOrEqual(-90);
  expect(r.pitchDeg).toBeLessThanOrEqual(90);
  expect(r.rollDeg).toBeGreaterThanOrEqual(-180);
  expect(r.rollDeg).toBeLessThanOrEqual(180);
  expect(Math.abs(r.slipSkid)).toBeLessThanOrEqual(1);
  expect(r.throttlePct).toBeGreaterThanOrEqual(0);
  expect(r.throttlePct).toBeLessThanOrEqual(100);
  expect(r.rpm).toBeGreaterThanOrEqual(0);
  expect(Math.abs(r.trimPct)).toBeLessThanOrEqual(100);
  expect(r.flapsDeg).toBeGreaterThanOrEqual(0);
  expect(r.flapsDeg).toBeLessThanOrEqual(CONFIG.aircraft.surfaces.flapMaxDeg);
  expect(CONFIG.aircraft.flaps.notchesDeg).toContain(r.flapsTargetDeg);
  expect(['down', 'up', 'transit']).toContain(r.gear);
  expect(r.gearLight).toBe(r.gear === 'down' ? 'green' : r.gear === 'transit' ? 'red' : 'off');
  expect(['RUNNING', 'STARTING', 'OFF', 'FAILED']).toContain(r.engineStatus);
  expect(['ground', 'airborne', 'stalled', 'landed', 'crashed']).toContain(r.state);
  expect(Math.abs(r.aoaDeg)).toBeLessThanOrEqual(180);
  expect(r.groundSpeedKt).toBeGreaterThanOrEqual(0);
  expect(r.altitudeAglFt).toBeGreaterThanOrEqual(0);
}

describe('instrument model: property tests', () => {
  it('any sequence of random states, controls and dts yields finite, in-range readings', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(arbState, arbControls, arbDt), { minLength: 1, maxLength: 12 }), (seq) => {
        const m = createInstrumentModel();
        for (const [s, c, dt] of seq) checkRanges(updateInstruments(m, s, c, dt));
      }),
      { numRuns: 300 },
    );
  });

  it('stall warning only ever sounds while airborne', () => {
    fc.assert(
      fc.property(arbState, arbControls, (s, c) => {
        const r = updateInstruments(createInstrumentModel(), s, c, 1 / 60);
        if (s.phase !== 'airborne') expect(r.stallWarning).toBe(false);
      }),
      { numRuns: 300 },
    );
  });

  it('is deterministic: the same inputs give identical readings', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(arbState, arbControls, arbDt), { minLength: 1, maxLength: 8 }), (seq) => {
        const a = createInstrumentModel();
        const b = createInstrumentModel();
        for (const [s, c, dt] of seq) expect(updateInstruments(a, s, c, dt)).toEqual(updateInstruments(b, s, c, dt));
      }),
      { numRuns: 150 },
    );
  });

  it('lags converge: holding any steady state long enough, every smoothed needle reaches the true value', () => {
    fc.assert(
      fc.property(
        fc.record({
          iasKt: fc.double({ min: 0, max: 160, noNaN: true }),
          altFt: fc.double({ min: 0, max: 12000, noNaN: true }),
          headingDeg: fc.double({ min: 0, max: 359.9, noNaN: true }),
          vsFpm: fc.double({ min: -1800, max: 1800, noNaN: true }),
          rpm: fc.double({ min: 0, max: 2700, noNaN: true }),
        }),
        fc.record({
          iasKt: fc.double({ min: 0, max: 160, noNaN: true }),
          altFt: fc.double({ min: 0, max: 12000, noNaN: true }),
          headingDeg: fc.double({ min: 0, max: 359.9, noNaN: true }),
          vsFpm: fc.double({ min: -1800, max: 1800, noNaN: true }),
          rpm: fc.double({ min: 0, max: 2700, noNaN: true }),
        }),
        (from, to) => {
          const m = createInstrumentModel();
          updateInstruments(m, makeState({ ...from, time: 1 }), makeControls(), 1 / 60);
          let r = updateInstruments(m, makeState({ ...to, time: 1 + 1 / 60 }), makeControls(), 1 / 60);
          for (let i = 0; i < 60 * 10; i++) r = updateInstruments(m, makeState({ ...to, time: 2 + i / 60 }), makeControls(), 1 / 60);
          expect(r.airspeedKt).toBeCloseTo(to.iasKt, 2);
          expect(r.altitudeFt).toBeCloseTo(to.altFt, 1);
          expect(r.verticalSpeedFpm).toBeCloseTo(to.vsFpm, 1);
          expect(r.rpm).toBeCloseTo(to.rpm, 1);
          const dh = Math.abs(((r.headingDeg - to.headingDeg + 540) % 360) - 180);
          expect(dh).toBeLessThan(0.01);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('a smoothed needle always lies between its previous reading and the new truth (no overshoot)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 160, noNaN: true }),
        fc.double({ min: 0, max: 160, noNaN: true }),
        fc.double({ min: 0, max: 0.25, noNaN: true }),
        (a, b, dt) => {
          const m = createInstrumentModel();
          const r0 = updateInstruments(m, makeState({ iasKt: a, time: 1 }), makeControls(), 1 / 60);
          const r1 = updateInstruments(m, makeState({ iasKt: b, time: 1 + dt }), makeControls(), dt);
          const lo = Math.min(r0.airspeedKt, b) - 1e-9;
          const hi = Math.max(r0.airspeedKt, b) + 1e-9;
          expect(r1.airspeedKt).toBeGreaterThanOrEqual(lo);
          expect(r1.airspeedKt).toBeLessThanOrEqual(hi);
        },
      ),
      { numRuns: 300 },
    );
  });
});
