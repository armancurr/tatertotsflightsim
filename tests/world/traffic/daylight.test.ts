import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { nightFactor, sunElevationDeg, syncLighting } from '../../../src/world/traffic/daylight';
import { createLightingUniforms } from '../../../src/world/traffic/materials';
import { CONFIG } from '../../../src/config';

describe('daylight', () => {
  it('no lights by day, some at golden hour, most at dawn, all at night', () => {
    const tod = CONFIG.atmosphere.timeOfDay;
    const at = (name: string) => nightFactor(tod.find((p) => p.name === name)!.elevationDeg);
    expect(at('Morning')).toBe(0);
    expect(at('Midday')).toBe(0);
    expect(at('Golden hour')).toBeGreaterThan(0.1);
    expect(at('Golden hour')).toBeLessThan(0.4);
    expect(at('Dawn')).toBeGreaterThan(0.5);
    expect(nightFactor(-10)).toBe(1);
    expect(nightFactor(Number.NaN)).toBe(0);
  });

  it('fuzz: monotonic in the sun elevation and within [0, 1]', () => {
    fc.assert(
      fc.property(fc.double({ min: -90, max: 90, noNaN: true }), fc.double({ min: 0, max: 20, noNaN: true }), (e, d) => {
        const a = nightFactor(e);
        const b = nightFactor(e + d);
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThanOrEqual(1);
        expect(b).toBeLessThanOrEqual(a + 1e-12);
      }),
    );
    expect(sunElevationDeg(1)).toBeCloseTo(90);
    expect(sunElevationDeg(0)).toBeCloseTo(0);
  });

  it('syncs the atmosphere into the shared uniforms', () => {
    const u = createLightingUniforms();
    syncLighting(u, { x: 0, y: 2, z: 0 }, { r: 1, g: 2, b: 3 }, { r: 0.1, g: 0.2, b: 0.3 });
    expect(u.uSunDir.value.y).toBeCloseTo(1);
    expect(u.uSunColor.value.b).toBeCloseTo(3);
    expect(u.uSky.value.g).toBeCloseTo(0.2);
  });
});
