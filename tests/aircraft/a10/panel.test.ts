/**
 * The A-10C panel painter (src/aircraft/a10/panel.ts), in node: gauge values from the readings
 * (unit), lamps that follow the gear / AOA / engine, and — property-based — whatever the readings
 * (NaN, infinities, absurd values), every value stays finite inside its dial and every canvas call
 * the painters make gets finite numbers (a recording 2D context stands in for the canvas).
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { a10Gauges, a10Lamps, drawConsoles, drawDash, drawDashBackground, drawScreens, lampCell, LAMP, LAMP_COUNT, SCREEN_CANVAS, type ScreenState } from '../../../src/aircraft/a10/panel';
import { createRestReadings } from '../../../src/aircraft/types';
import type { InstrumentReadings } from '../../../src/types';

/** A fake 2D context: records every call, checks every numeric argument is finite. */
function recordingContext() {
  const bad: string[] = [];
  let calls = 0;
  const gradient = { addColorStop: () => undefined };
  const target: Record<string, unknown> = {};
  const ctx = new Proxy(target, {
    get(t, key: string) {
      if (key in t) return t[key];
      if (key === 'createLinearGradient' || key === 'createRadialGradient')
        return (...a: unknown[]) => {
          calls++;
          for (const v of a) if (typeof v === 'number' && !Number.isFinite(v)) bad.push(key);
          return gradient;
        };
      if (key === 'measureText') return () => ({ width: 10 });
      return (...a: unknown[]) => {
        calls++;
        for (const v of a) if (typeof v === 'number' && !Number.isFinite(v)) bad.push(`${key}(${a.join(',')})`);
      };
    },
    set(t, key: string, v) {
      t[key] = v;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, bad, calls: () => calls };
}

const wild = fc.oneof(fc.double({ noNaN: false }), fc.constantFrom(Number.NaN, Infinity, -Infinity, 0, 1e12, -1e12));
const readings: fc.Arbitrary<InstrumentReadings | null> = fc.oneof(
  fc.constant(null),
  fc
    .record({
      airspeedKt: wild, altitudeFt: wild, verticalSpeedFpm: wild, pitchDeg: wild, rollDeg: wild, headingDeg: wild,
      throttlePct: wild, rpm: wild, flapsDeg: wild, aoaDeg: wild, gLoad: wild,
      engineStatus: fc.constantFrom('RUNNING', 'STARTING', 'OFF', 'FAILED'),
      gear: fc.constantFrom('down', 'up', 'transit'),
      state: fc.constantFrom('ground', 'airborne', 'stalled', 'landed', 'crashed'),
      stallWarning: fc.boolean(),
    })
    .map((r) => ({ ...createRestReadings(), ...r }) as InstrumentReadings),
);

describe('A-10 panel: gauge values', () => {
  it('rest readings: engines off, gear down, needles at their stops', () => {
    const g = a10Gauges(createRestReadings());
    expect(g.iasKt).toBe(0);
    expect(g.corePct).toBe(0);
    expect(g.fanPct).toBe(0);
    expect(g.ffPph).toBe(0);
    expect(g.gear).toBe('down');
    expect(g.running).toBe(false);
  });

  it('cruise: 300 kt, 90 % core, 60 % throttle → the TF34 gauges read like the real engine', () => {
    const g = a10Gauges({ ...createRestReadings(), airspeedKt: 300, altitudeFt: 5200, rpm: 90, throttlePct: 60, engineStatus: 'RUNNING', headingDeg: 370, aoaDeg: 3 });
    expect(g.iasKt).toBe(300);
    expect(g.headingDeg).toBeCloseTo(10, 9);
    expect(g.fanPct).toBeGreaterThan(70);
    expect(g.fanPct).toBeLessThan(g.corePct);
    expect(g.ittC).toBeGreaterThan(600);
    expect(g.ittC).toBeLessThan(900);
    expect(g.ffPph).toBeGreaterThan(1500);
    expect(g.ffPph).toBeLessThan(2500);
  });

  it('lamps: three greens with the gear down, the red handle light in transit, none up; the AOA indexer only gear-down in flight', () => {
    const down = a10Lamps({ ...createRestReadings(), gear: 'down', state: 'airborne', aoaDeg: 9 });
    expect([down.gearNose, down.gearLeft, down.gearRight, down.gearHandle]).toEqual([true, true, true, false]);
    expect(down.aoaOn).toBe(true);
    const transit = a10Lamps({ ...createRestReadings(), gear: 'transit', state: 'airborne' });
    expect([transit.gearNose, transit.gearHandle]).toEqual([false, true]);
    const up = a10Lamps({ ...createRestReadings(), gear: 'up', state: 'airborne', aoaDeg: 9 });
    expect([up.gearNose, up.gearLeft, up.gearRight, up.gearHandle, up.aoaOn, up.aoaHigh, up.aoaLow]).toEqual([false, false, false, false, false, false, false]);
    expect(a10Lamps({ ...createRestReadings(), gear: 'down', state: 'airborne', aoaDeg: 14 }).aoaHigh).toBe(true);
    expect(a10Lamps({ ...createRestReadings(), gear: 'down', state: 'airborne', aoaDeg: 4 }).aoaLow).toBe(true);
  });

  it('every lamp has its own cell inside the screens canvas', () => {
    const ids = Object.values(LAMP);
    expect(new Set(ids).size).toBe(LAMP_COUNT);
    const cells = ids.map(lampCell);
    for (const c of cells) {
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.x + c.w).toBeLessThanOrEqual(SCREEN_CANVAS.width);
      expect(c.y).toBeGreaterThanOrEqual(512);
      expect(c.y + c.h).toBeLessThanOrEqual(SCREEN_CANVAS.height);
    }
    for (let i = 0; i < cells.length; i++)
      for (let j = i + 1; j < cells.length; j++) {
        const a = cells[i];
        const b = cells[j];
        expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h, `${i} × ${j}`).toBe(false);
      }
  });
});

describe('A-10 panel: fuzz', () => {
  it('gauge values are always finite and inside their dials', () => {
    fc.assert(
      fc.property(readings, wild, (r, t) => {
        const g = a10Gauges(r, t);
        for (const [k, v] of Object.entries(g)) if (typeof v === 'number') expect(Number.isFinite(v), k).toBe(true);
        expect(g.iasKt).toBeGreaterThanOrEqual(0);
        expect(g.iasKt).toBeLessThanOrEqual(550);
        expect(Math.abs(g.vviFpm)).toBeLessThanOrEqual(6000);
        expect(g.headingDeg).toBeGreaterThanOrEqual(0);
        expect(g.headingDeg).toBeLessThan(360);
        expect(Math.abs(g.rollDeg)).toBeLessThanOrEqual(180);
        expect(Math.abs(g.pitchDeg)).toBeLessThanOrEqual(90);
        for (const v of [g.fanPct, g.oilPsi]) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(100);
        }
        expect(g.ittC).toBeLessThanOrEqual(1100);
        expect(g.flapsDeg).toBeGreaterThanOrEqual(0);
        expect(g.flapsDeg).toBeLessThanOrEqual(20);
        expect(['down', 'up', 'transit']).toContain(g.gear);
      }),
      { numRuns: 500 },
    );
  });

  it('the painters only ever pass finite numbers to the canvas, whatever the readings and stores', { timeout: 60_000 }, () => {
    const bg = recordingContext();
    drawDashBackground(bg.ctx);
    drawConsoles(bg.ctx);
    expect(bg.bad).toEqual([]);
    expect(bg.calls()).toBeGreaterThan(500);
    fc.assert(
      fc.property(readings, wild, fc.array(fc.boolean(), { maxLength: 6 }), fc.array(fc.boolean(), { maxLength: 3 }), fc.boolean(), (r, t, stores, air, dsms) => {
        const rc = recordingContext();
        drawDash(rc.ctx, a10Gauges(r, t), null);
        const s: ScreenState = { headingDeg: r?.headingDeg ?? t, rightPage: dsms ? 'DSMS' : 'TGP', stores, airStores: air, lamps: a10Lamps(r), time: t };
        drawScreens(rc.ctx, s);
        expect(rc.bad).toEqual([]);
      }),
      { numRuns: 60 },
    );
  });
});
