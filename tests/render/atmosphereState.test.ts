/**
 * Functional tests: the full CPU lighting state for every time-of-day preset —
 * what the sun light, sky ambient, haze, clouds and flare will be given.
 */
import { describe, it, expect } from 'vitest';
import { computeAtmosphereState } from '../../src/render/atmosphereState';
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
