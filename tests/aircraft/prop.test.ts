import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createPropDisc, propDiscParams, strobeRate } from '../../src/aircraft/animate';
import { CONFIG } from '../../src/config';

const E = CONFIG.aircraft.engine;

describe('propeller disc mapping', () => {
  const p = createPropDisc();
  it('stopped: crisp opaque blades at their true angle, no disc', () => {
    propDiscParams(0, false, p);
    expect(p.bladeOpacity).toBe(1);
    expect(p.discAlpha).toBe(0);
    expect(p.ghost).toBe(0);
    expect(p.strobe).toBe(false);
  });
  it('idle: blades still clearly visible, drawn stroboscopically, with a ghost in the disc', () => {
    propDiscParams(E.idleRpm, false, p);
    expect(p.bladeOpacity).toBeGreaterThan(0.5);
    expect(p.strobe).toBe(true);
    expect(p.ghost).toBeGreaterThan(0.15);
  });
  it('cruise, seen from outside: a faint, slightly dark translucent disc and a barely-there tip ring', () => {
    propDiscParams(2400, false, p);
    expect(p.bladeOpacity).toBe(0);
    expect(p.discAlpha).toBeGreaterThan(0.03);
    expect(p.discAlpha).toBeLessThan(0.11);
    expect(p.tipAlpha).toBeLessThanOrEqual(p.discAlpha * 1.4);
    expect(p.tipTint).toBeLessThan(0.3);
    expect(p.ghost).toBeLessThan(0.02);
  });
  it('cruise, from the cockpit: almost invisible (much fainter than from outside)', () => {
    propDiscParams(2400, true, p);
    expect(p.discAlpha).toBeGreaterThan(0);
    expect(p.discAlpha).toBeLessThan(0.035);
    expect(p.tipAlpha).toBeLessThan(0.045);
  });
  it('the stroboscopic ghost fades out as rpm rises above idle', () => {
    let prev = Infinity;
    for (let rpm = E.idleRpm; rpm <= 2700; rpm += 50) {
      propDiscParams(rpm, false, p);
      expect(p.ghost).toBeLessThanOrEqual(prev + 1e-12);
      prev = p.ghost;
    }
  });
  it('the apparent (aliased) blade rotation is slow: under 0.6 rev/s at any rpm', () => {
    for (let rpm = 0; rpm <= 3000; rpm += 10) expect(Math.abs(strobeRate(rpm))).toBeLessThan(0.6 * 2 * Math.PI);
  });
});

describe('property: prop disc parameters are bounded for any input', () => {
  it('finite, in [0, 1], and the blades and disc cross-fade', () => {
    const p = createPropDisc();
    fc.assert(
      fc.property(fc.oneof(fc.double({ min: -1e6, max: 1e6, noNaN: true }), fc.constantFrom(Number.NaN, Infinity, -Infinity)), fc.boolean(), (rpm, cockpit) => {
        propDiscParams(rpm, cockpit, p);
        for (const k of ['bladeOpacity', 'discAlpha', 'tipAlpha', 'tipTint', 'ghost', 'blend'] as const) {
          expect(Number.isFinite(p[k])).toBe(true);
          expect(p[k]).toBeGreaterThanOrEqual(0);
          expect(p[k]).toBeLessThanOrEqual(1);
        }
        expect(p.bladeOpacity + p.blend).toBeCloseTo(1, 9);
        expect(p.discAlpha).toBeLessThan(0.12);
        expect(Number.isFinite(strobeRate(rpm))).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});
