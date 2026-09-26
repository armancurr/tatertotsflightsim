/**
 * The player's wake field (src/world/water/wakeField.ts): Kelvin geometry (the 19.47° cusp, the
 * Rabaud–Moisy narrowing at planing speed, the dispersion-relation wavelength), realistic heights,
 * decay with distance, nothing ahead of the bow or outside the wedge, finite everywhere (fuzz), the
 * map's frame snapped to whole texels (the map never swims), and the GLSL mirrors the TS constants.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  GRAVITY, KELVIN_DEG, WAKE_FIELD, WAKE_FIELD_GLSL, apparentWakeAngle, kelvinHeight, kelvinRoots, kelvinWavelength, wakeAmplitude,
  wakeField, wakeMapFrame,
} from '../../../src/world/water/wakeField';
import { fcParams } from '../../support/fc';

const L = 14.2;
const B = 4.11;
const kMax = Math.PI / (2 * (520 / 1024));

describe('wake field: Kelvin geometry', () => {
  it('the cusp is at 19.47°, and a planing hull narrows its wake (≈ 0.18 / Fr)', () => {
    expect(KELVIN_DEG).toBeCloseTo(19.47, 2);
    const slow = apparentWakeAngle(3, L);
    const fast = apparentWakeAngle(14.7, L);
    expect((slow * 180) / Math.PI).toBeCloseTo(19.47, 1);
    expect((fast * 180) / Math.PI).toBeGreaterThan(6);
    expect((fast * 180) / Math.PI).toBeLessThan(11);
  });

  it('wavelengths follow deep-water dispersion (λ = 2πU²cos²θ / g)', () => {
    expect(kelvinWavelength(10, 0)).toBeCloseTo((2 * Math.PI * 100) / GRAVITY, 6);
    expect(kelvinWavelength(10, Math.PI / 3)).toBeCloseTo(kelvinWavelength(10, 0) / 4, 6);
  });

  it('two stationary-phase roots inside the wedge, none outside', () => {
    const r = kelvinRoots(100, 20)!;
    expect(r.transverse).toBeLessThan(1 / Math.SQRT2);
    expect(r.diverging).toBeGreaterThan(1 / Math.SQRT2);
    expect(kelvinRoots(100, 40)).toBeNull(); // tan(19.47°) × 100 ≈ 35 m
    expect(kelvinRoots(-5, 0)).toBeNull();
  });
});

describe('wake field: heights', () => {
  it('a V50 makes wake waves of tens of centimetres, not metres', () => {
    for (const [U, planing] of [[5.3, 0], [14.7, 0.75]] as const) {
      let max = 0;
      for (let x = 5; x < 300; x += 2.5) for (let y = -120; y <= 120; y += 0.5) max = Math.max(max, Math.abs(kelvinHeight(x, y, U, L, B, planing, kMax)));
      expect(max).toBeGreaterThan(0.1);
      expect(max).toBeLessThan(1.0);
    }
    expect(wakeAmplitude(14.7, B, 0.75)).toBeLessThan(0.6);
  });

  it('the waves decay behind the boat', () => {
    const peak = (x: number) => {
      let m = 0;
      for (let y = 0; y < 0.45 * x; y += 0.25) m = Math.max(m, Math.abs(kelvinHeight(x, y, 5.3, L, B, 0, kMax)));
      return m;
    };
    expect(peak(300)).toBeLessThan(peak(40));
  });

  it('nothing ahead of the bow, nothing when stopped', () => {
    expect(kelvinHeight(-3, 1, 10, L, B, 0, kMax)).toBe(0);
    expect(kelvinHeight(50, 5, 0, L, B, 0, kMax)).toBe(0);
    const o = wakeField({ x: -2, y: 0, U: 12, age: 0, planing: 0.5, L, B, kMax } as never);
    expect(o.foam).toBe(0);
    expect(o.churn).toBe(0);
  });

  it('white water right behind the transom, thinning with age', () => {
    const young = wakeField({ x: L + 2, y: 0, U: 14.7, age: 0.3, planing: 0.8, L, B, kMax } as never).foam;
    const old = wakeField({ x: L + 2, y: 0, U: 14.7, age: 30, planing: 0.8, L, B, kMax } as never).foam;
    expect(young).toBeGreaterThan(0.6);
    expect(old).toBeLessThan(young * 0.5);
  });

  it('fuzz: finite and bounded everywhere', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -50, max: 600, noNaN: true }),
        fc.double({ min: -300, max: 300, noNaN: true }),
        fc.double({ min: 0, max: 25, noNaN: true }),
        fc.double({ min: 0, max: 300, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (x, y, U, age, planing) => {
          const o = wakeField({ x, y, U, age, planing, L, B, kMax } as never);
          return Number.isFinite(o.height) && Math.abs(o.height) < 3 && o.foam >= 0 && o.foam <= 1 && o.churn >= 0 && o.churn <= 1 && o.slick >= 0 && o.slick <= 1;
        },
      ),
      fcParams(400),
    );
  });
});

describe('wake map frame and shader', () => {
  it('the frame corner sits on whole texels, whatever the boat does (the map never swims)', () => {
    fc.assert(
      fc.property(fc.double({ min: -2e4, max: 2e4, noNaN: true }), fc.double({ min: -2e4, max: 2e4, noNaN: true }), fc.double({ min: 0, max: 360, noNaN: true }), (x, z, h) => {
        const f = wakeMapFrame(x, z, h, 520, 1024);
        const tx = f.x0 / f.texel;
        const tz = f.z0 / f.texel;
        // the boat is inside the map
        return Math.abs(tx - Math.round(tx)) < 1e-6 && Math.abs(tz - Math.round(tz)) < 1e-6 && x > f.x0 && x < f.x0 + f.extent && z > f.z0 && z < f.z0 + f.extent;
      }),
      fcParams(200),
    );
  });

  it('the GLSL uses the same constants as the TS mirror, and never takes pow() of a bare value (the RECORD NaN lesson)', () => {
    expect(WAKE_FIELD_GLSL).toContain(String(WAKE_FIELD.ampPerBeam));
    expect(WAKE_FIELD_GLSL).toContain(String(WAKE_FIELD.cuspWidth));
    expect(WAKE_FIELD_GLSL).not.toMatch(/pow\(\s*[a-zA-Z_]\w*\s*,/);
    // every sqrt() argument is max()/clamp()-guarded or built from values clamped to ≥ 0 above it
    expect(WAKE_FIELD_GLSL).toContain('age = max( age, 0.0 );');
  });
});
