/**
 * F-16 head-up display: pure geometry (unit), the drawn result measured on a geometry-tracking
 * context (functional), and fast-check fuzz (any readings → finite drawing, right senses).
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { CONFIG } from '../../src/config';
import type { InstrumentReadings } from '../../src/types';
import {
  jetHudGeometry, headingTapeMarks, ladderRungs, drawJetHud, createJetHudState, trackJetHud, JET_HUD_COLOR,
} from '../../src/ui/jetHud';
import { geoCtx, longest, screenTiltDeg, aboveLine, wrap180 } from './geoCtx';
import { makeReadings, arbReadings } from './fixtures';

const W = 520;
const H = 540;
const DEG = Math.PI / 180;
const jet = (over: Partial<InstrumentReadings & { betaDeg: number; flightPathDeg: number; speedBrake: boolean }> = {}) =>
  ({ ...makeReadings({ airspeedKt: 420, altitudeFt: 12000, mach: 0.72, afterburner: 0, gear: 'up', gearLight: 'off', ...over }), betaDeg: 0, flightPathDeg: 0, speedBrake: false, ...over });

describe('jet HUD geometry', () => {
  it('level: horizon through the boresight, no rotation', () => {
    const g = jetHudGeometry(jet({ pitchDeg: 0, rollDeg: 0 }), W, H);
    expect(g.rotation).toBeCloseTo(0, 10);
    expect(g.horizonOffset).toBeCloseTo(0, 10);
    expect(g.ppd).toBeGreaterThan(5);
  });

  it('right bank rotates the ladder counter-clockwise (canvas angle = −roll), like the real horizon', () => {
    expect(jetHudGeometry(jet({ rollDeg: 30 }), W, H).rotation).toBeCloseTo(-30 * DEG, 10);
    expect(jetHudGeometry(jet({ rollDeg: -45 }), W, H).rotation).toBeCloseTo(45 * DEG, 10);
  });

  it('nose up puts the horizon below the boresight by pitch × px/deg', () => {
    const g = jetHudGeometry(jet({ pitchDeg: 8 }), W, H);
    expect(g.horizonOffset).toBeCloseTo(8 * g.ppd, 6);
  });

  it('the flight-path marker sits α below and β right of the boresight', () => {
    const g = jetHudGeometry(jet({ aoaDeg: 5, betaDeg: 2 }), W, H);
    expect(g.fpm.y - g.bore.y).toBeCloseTo(5 * g.ppd, 6);
    expect(g.fpm.x - g.bore.x).toBeCloseTo(2 * g.ppd, 6);
    // Clamped to stay inside the HUD.
    const wild = jetHudGeometry(jet({ aoaDeg: 80, betaDeg: -60 }), W, H);
    expect(wild.fpm.y).toBeLessThan(H);
    expect(wild.fpm.x).toBeGreaterThan(0);
  });

  it('pitch ladder: rungs every 5°, horizon offset + the rung angle, only the visible ones', () => {
    const g = jetHudGeometry(jet({ pitchDeg: 3 }), W, H);
    const rungs = ladderRungs(g, H);
    expect(rungs.length).toBeGreaterThan(3);
    for (const r of rungs) {
      expect(Math.abs(r.deg % 5)).toBe(0);
      expect(r.offset).toBeCloseTo(g.horizonOffset - r.deg * g.ppd, 6);
      expect(Math.abs(r.offset)).toBeLessThan(H * 1.2);
    }
    expect(rungs.some((r) => r.deg === 0)).toBe(true);
  });

  it('heading tape: the heading sits at x = 0; higher headings are to the right, and slide left in a right turn', () => {
    const a = headingTapeMarks(90, 300);
    const at = (m: ReturnType<typeof headingTapeMarks>, deg: number) => m.find((k) => k.deg === deg)!;
    expect(at(a, 90).x).toBeCloseTo(0, 6);
    expect(at(a, 100).x).toBeGreaterThan(0);
    expect(at(a, 80).x).toBeLessThan(0);
    const b = headingTapeMarks(95, 300);
    expect(at(b, 100).x).toBeLessThan(at(a, 100).x);
    expect(at(a, 90).label).toBe('09');
    expect(headingTapeMarks(355, 300).some((m) => m.label === '36' && m.x > 0)).toBe(true);
  });
});

describe('jet HUD drawing (measured)', () => {
  const drawn = (r: ReturnType<typeof jet>, st = createJetHudState()) => {
    const g = geoCtx();
    drawJetHud(g.ctx, W, H, r, st);
    return g;
  };
  const horizonOf = (g: ReturnType<typeof geoCtx>) => longest(g.segments.filter((s) => s.style === JET_HUD_COLOR));

  it('draws in HUD green: the horizon tilts CCW in a right bank and CW in a left bank', () => {
    expect(screenTiltDeg(horizonOf(drawn(jet({ rollDeg: 30 }))))).toBeCloseTo(30, 3);
    expect(screenTiltDeg(horizonOf(drawn(jet({ rollDeg: -30 }))))).toBeCloseTo(-30, 3);
  });

  it('nose up: the boresight sits above the horizon', () => {
    const r = jet({ pitchDeg: 10 });
    const g = jetHudGeometry(r, W, H);
    expect(aboveLine(horizonOf(drawn(r)), g.bore)).toBeGreaterThan(5 * g.ppd);
  });

  it('shows airspeed, altitude, Mach, g and max g, AoA, throttle; AB, gear and speed-brake cues when they apply', () => {
    const st = createJetHudState();
    trackJetHud(st, jet({ gLoad: 6.4 }));
    const t = drawn(jet({ airspeedKt: 432, altitudeFt: 15250, mach: 0.87, gLoad: 2.1, aoaDeg: 6.2, throttlePct: 85 }), st).texts.map((x) => x.s).join(' ');
    for (const s of ['432', '15,250', '0.87', '2.1', '6.4', '6.2', '85']) expect(t).toContain(s);
    expect(t).not.toContain('AB');
    const cues = drawn(jet({ afterburner: 0.8, throttlePct: 100, gear: 'down', gearLight: 'green', speedBrake: true })).texts.map((x) => x.s).join(' ');
    expect(cues).toContain('AB');
    expect(cues).toContain('GEAR');
    expect(cues).toContain('SPD BRK');
  });

  it('max g remembers the peak until reset', () => {
    const st = createJetHudState();
    trackJetHud(st, jet({ gLoad: 3 }));
    trackJetHud(st, jet({ gLoad: 7.5 }));
    trackJetHud(st, jet({ gLoad: 1 }));
    expect(st.maxG).toBeCloseTo(7.5, 6);
    st.maxG = 1;
    trackJetHud(st, jet({ gLoad: Number.NaN }));
    expect(st.maxG).toBe(1);
  });

  it('heading labels in the drawing slide left as the jet turns right', () => {
    // The tape runs along the bottom with the gear up (the lowest "10" is the tape's 100°, not the 10° rung).
    const x = (hdg: number) => drawn(jet({ headingDeg: hdg })).texts.filter((t) => t.s === '10').sort((a, b) => b.p.y - a.p.y)[0].p.x;
    expect(x(97)).toBeLessThan(x(94));
  });
});

describe('jet HUD: property', () => {
  it('any readings: finite drawing; ladder tilt follows the bank; FPM inside the HUD', () => {
    fc.assert(
      fc.property(arbReadings, fc.double({ min: -30, max: 30, noNaN: true }), (r0, beta) => {
        const r = { ...r0, betaDeg: beta, flightPathDeg: 0, speedBrake: false };
        const g = geoCtx();
        drawJetHud(g.ctx, W, H, r, createJetHudState());
        expect(g.numbers.every(Number.isFinite)).toBe(true);
        const geo = jetHudGeometry(r, W, H);
        expect(geo.fpm.x).toBeGreaterThanOrEqual(0);
        expect(geo.fpm.x).toBeLessThanOrEqual(W);
        expect(geo.fpm.y).toBeGreaterThanOrEqual(0);
        expect(geo.fpm.y).toBeLessThanOrEqual(H);
        const roll = r.rollDeg;
        if (Number.isFinite(roll) && Math.abs(wrap180(roll)) > 2 && Math.abs(wrap180(roll)) < 85) {
          const h = longest(g.segments.filter((s) => s.style === JET_HUD_COLOR));
          expect(Math.sign(screenTiltDeg(h))).toBe(Math.sign(wrap180(roll)));
        }
      }),
      { numRuns: 200 },
    );
  });

  it('config defines the HUD colour', () => {
    expect(CONFIG.hud.jet.color).toBe(JET_HUD_COLOR);
  });
});
