/**
 * Functional tests: the full CPU lighting state for every time-of-day preset —
 * what the sun light, sky ambient, haze, clouds and flare will be given.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { autoExposure, computeAtmosphereState, whiteBalanceGains } from '../../src/render/atmosphereState';
import { defaultAtmosphereParams, luminance, type RGB } from '../../src/render/atmosphereModel';
import { hazeColor } from '../../src/render/fog';
import { sunDirectionFromAngles } from '../../src/render/sun';
import { CONFIG } from '../../src/config';

const P = defaultAtmosphereParams();
const presets = CONFIG.atmosphere.timeOfDay;
const state = (i: number, h = 2) => computeAtmosphereState(P, sunDirectionFromAngles(presets[i].elevationDeg, presets[i].azimuthDeg), h);
const finite = (c: RGB) => [c.r, c.g, c.b].every(Number.isFinite);
const idx = (name: string) => presets.findIndex((p) => p.name === name);

describe('atmosphere lighting state per time of day', () => {
  it('is finite and positive for every preset', () => {
    presets.forEach((_, i) => {
      const s = state(i);
      for (const c of [s.sunAtCamera, s.skyIrradiance, s.groundRadiance, s.zenith, s.cloud.sun, s.cloud.ambientTop, s.cloud.ambientBottom, s.immersionColor]) {
        expect(finite(c)).toBe(true);
        expect(luminance(c)).toBeGreaterThan(0);
      }
      expect(s.lightIntensity).toBeGreaterThan(0);
      expect(s.sunDiscLuminance).toBeGreaterThan(0);
    });
  });
  it('sunlight is near-white at midday, golden at golden hour, deep orange at dawn', () => {
    const mid = state(idx('Midday')).lightColor;
    const gold = state(idx('Golden hour')).lightColor;
    const dawn = state(idx('Dawn')).lightColor;
    expect(mid.r / mid.b).toBeLessThan(1.4);
    expect(gold.r / gold.b).toBeGreaterThan(1.7);
    expect(dawn.r / dawn.b).toBeGreaterThan(gold.r / gold.b);
    expect(state(idx('Dawn')).lightIntensity).toBeLessThan(state(idx('Midday')).lightIntensity);
  });
  it('skylight is blue and a sensible fraction of direct sun on flat ground', () => {
    const s = state(idx('Morning'));
    expect(s.skyIrradiance.b).toBeGreaterThan(s.skyIrradiance.r);
    const direct = luminance(s.sunAtCamera) * s.sunDir.y;
    const ratio = luminance(s.skyIrradiance) / direct;
    expect(ratio).toBeGreaterThan(0.1);
    expect(ratio).toBeLessThan(0.6);
  });
  it('the unoccluded sun disc is orders of magnitude brighter than the haze around it (flare threshold)', () => {
    presets.forEach((_, i) => {
      const s = state(i);
      const around = hazeColor({ x: s.sunDir.x, y: 0, z: s.sunDir.z }, 2, s.fog, { r: 0, g: 0, b: 0 });
      expect(s.sunDiscLuminance).toBeGreaterThan(50 * luminance(around));
    });
  });
  it('cloud tops are brighter than cloud bases, and bases are bluish-grey', () => {
    const s = state(idx('Morning'));
    const top = luminance(s.cloud.sun) * 0.29 + luminance(s.cloud.ambientTop);
    expect(top).toBeGreaterThan(1.8 * luminance(s.cloud.ambientBottom));
    expect(s.cloud.ambientBottom.b).toBeGreaterThanOrEqual(s.cloud.ambientBottom.r * 0.95);
  });
  it('from 2,000 m the sun is stronger and the haze thinner than on the ground', () => {
    const lo = state(0, 2);
    const hi = state(0, 2000);
    expect(luminance(hi.sunAtCamera)).toBeGreaterThan(luminance(lo.sunAtCamera));
    expect(luminance(hi.zenith)).toBeLessThan(luminance(lo.zenith));
  });
  it('writes into an existing state object (no per-frame allocation)', () => {
    const s = state(0);
    const again = computeAtmosphereState(P, sunDirectionFromAngles(62, 175), 500, {}, s);
    expect(again).toBe(s);
    expect(again.sunDir.y).toBeCloseTo(Math.sin((62 * Math.PI) / 180), 9);
  });
});

describe('camera: auto exposure and white balance from the atmosphere (lookdev)', () => {
  const ae = CONFIG.atmosphere.autoExposure;
  const base = CONFIG.atmosphere.exposure;
  it('the default preset (morning) on the runway keeps the calibration exposure', () => {
    const s = state(idx('Morning'), 32);
    expect(s.exposure / base).toBeGreaterThan(0.97);
    expect(s.exposure / base).toBeLessThan(1.03);
  });
  it('opens up at golden hour and more at dawn (the eye/camera adapts), closes a little at midday', () => {
    const m = state(idx('Morning')).exposure;
    const noon = state(idx('Midday')).exposure;
    const gold = state(idx('Golden hour')).exposure;
    const dawn = state(idx('Dawn')).exposure;
    expect(noon).toBeLessThan(m);
    expect(noon).toBeGreaterThan(0.75 * m);
    expect(gold).toBeGreaterThan(1.5 * m);
    expect(dawn).toBeGreaterThan(gold);
    // …but only partially: dusk still reads darker than day (adaptation < 100 %)
    const eM = state(idx('Morning')).illuminance;
    const eD = state(idx('Dawn')).illuminance;
    expect(dawn * eD).toBeLessThan(0.8 * m * eM);
  });
  it('autoExposure is finite, clamped and non-increasing in the illuminance for any input (property)', () => {
    const e = fc.oneof(fc.double({ noNaN: false }), fc.constant(0), fc.constant(-1), fc.constant(Infinity), fc.double({ min: 1e-6, max: 100, noNaN: true }));
    fc.assert(
      fc.property(e, fc.double({ min: 0, max: 50, noNaN: true }), (E, dE) => {
        const a = autoExposure(E, base, ae);
        expect(Number.isFinite(a)).toBe(true);
        expect(a).toBeGreaterThanOrEqual(base * ae.min - 1e-9);
        expect(a).toBeLessThanOrEqual(base * ae.max + 1e-9);
        if (Number.isFinite(E) && E > 0) expect(autoExposure(E + dE, base, ae)).toBeLessThanOrEqual(a + 1e-9);
      }),
      { numRuns: 500 },
    );
  });
  it('white balance: identity for a neutral light, cools a warm one, keeps luminance, strength 0 = off', () => {
    const o = { r: 0, g: 0, b: 0 };
    whiteBalanceGains({ r: 1, g: 1, b: 1 }, 0.5, o);
    expect(o.r).toBeCloseTo(1, 6);
    expect(o.b).toBeCloseTo(1, 6);
    whiteBalanceGains({ r: 1.4, g: 1, b: 0.5 }, 0.5, o);
    expect(o.b).toBeGreaterThan(1);
    expect(o.r).toBeLessThan(1);
    expect(0.2126 * o.r + 0.7152 * o.g + 0.0722 * o.b).toBeCloseTo(1, 6);
    whiteBalanceGains({ r: 1.4, g: 1, b: 0.5 }, 0, o);
    expect([o.r, o.g, o.b]).toEqual([1, 1, 1]);
  });
  it('white balance gains are finite, positive and bounded for any illuminant (property)', () => {
    const c = fc.oneof(fc.double({ noNaN: false }), fc.double({ min: 0, max: 10, noNaN: true }));
    fc.assert(
      fc.property(c, c, c, fc.double({ min: 0, max: 1, noNaN: true }), (r, g, b, k) => {
        const o = whiteBalanceGains({ r, g, b }, k, { r: 0, g: 0, b: 0 });
        for (const x of [o.r, o.g, o.b]) {
          expect(Number.isFinite(x)).toBe(true);
          expect(x).toBeGreaterThan(0.5);
          expect(x).toBeLessThan(2);
        }
      }),
      { numRuns: 500 },
    );
  });
  it('the camera white balance is ~neutral by day and takes the brown out of dawn (cooler, not neutral)', () => {
    const noon = state(idx('Midday')).whiteBalance;
    expect(Math.abs(noon.b / noon.r - 1)).toBeLessThan(0.08);
    const dawn = state(idx('Dawn')).whiteBalance;
    expect(dawn.b / dawn.r).toBeGreaterThan(1.1);
    expect(dawn.b / dawn.r).toBeLessThan(2);
  });
});
