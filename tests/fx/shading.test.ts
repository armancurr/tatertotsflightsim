/**
 * The particle look, as pure numbers (each has a GLSL twin generated from the same constants):
 * a Planck-chromaticity fire ramp (white-yellow core → deep orange/red edges), per-particle
 * variation from the seed, age erosion of smoke puffs, self-shadowing, energy-conserving minimum
 * pixel size and the fireball / flame temperature fields.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  fireColor,
  fireKelvin,
  particleVariation,
  smokeErosion,
  selfShadow,
  pixelScale,
  fireballTemperature,
  flameTemperature,
  FIRE_GLSL,
  type Variation,
} from '../../src/fx/shading';

const unit = fc.double({ min: 0, max: 1, noNaN: true });

describe('fire colour: Planck chromaticity', () => {
  it('temperature rises from a dull red glow (~700 K) to a white-yellow core (> 2,500 K)', () => {
    expect(fireKelvin(0)).toBeCloseTo(700, 0);
    expect(fireKelvin(1.1)).toBeGreaterThan(2500);
    expect(fireKelvin(Number.NaN)).toBe(fireKelvin(0));
    expect(fireKelvin(99)).toBe(fireKelvin(1.5));
  });
  it('edges are deep orange-red, the core is yellow-white (green/red and blue/red rise with temperature)', () => {
    const edge = fireColor(0.35);
    const mid = fireColor(0.7);
    const core = fireColor(1.2);
    expect(edge.g / edge.r).toBeLessThan(0.28);
    expect(edge.b / edge.r).toBeLessThan(0.03);
    expect(mid.g / mid.r).toBeGreaterThan(0.35);
    expect(core.g / core.r).toBeGreaterThan(0.65);
    expect(core.b / core.r).toBeGreaterThan(0.25);
    let lastG = -1;
    let lastB = -1;
    for (let t = 0.05; t <= 1.5; t += 0.05) {
      const c = fireColor(t);
      expect(c.g / c.r).toBeGreaterThan(lastG);
      expect(c.b / c.r).toBeGreaterThan(lastB);
      lastG = c.g / c.r;
      lastB = c.b / c.r;
    }
  });
  it('the core is several times brighter than the edges (HDR emission)', () => {
    const lum = (t: number) => {
      const c = fireColor(t);
      return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    };
    expect(lum(1.1) / lum(0.5)).toBeGreaterThan(8);
  });
  it('the GLSL twin carries the same constants', () => {
    expect(FIRE_GLSL).toContain('vec3 fireRamp');
    expect(FIRE_GLSL).toContain('float fireKelvin');
    expect(FIRE_GLSL).toContain('vec4 variation');
    expect(FIRE_GLSL).toContain('float smokeErosion');
    expect(FIRE_GLSL).toContain('float selfShadow');
    expect(FIRE_GLSL).toContain('float fireballTemperature');
    expect(FIRE_GLSL).toContain('float flameTemperature');
  });
});

describe('per-particle variation', () => {
  it('is deterministic per seed and differs between seeds', () => {
    const a = particleVariation(0.123);
    const b = particleVariation(0.123);
    expect(a).toEqual(b);
    const c = particleVariation(0.124);
    expect(Math.abs(a.ox - c.ox) + Math.abs(a.oy - c.oy) + Math.abs(a.jitter - c.jitter)).toBeGreaterThan(0.01);
  });
  it('spreads evenly: flips are balanced, jitter covers −1..1, offsets and rates are distinct', () => {
    const vs: Variation[] = [];
    for (let k = 0; k < 2000; k++) vs.push(particleVariation((k * 0.61803398875) % 1));
    const flips = vs.filter((v) => v.flip < 0).length / vs.length;
    expect(flips).toBeGreaterThan(0.4);
    expect(flips).toBeLessThan(0.6);
    expect(Math.min(...vs.map((v) => v.jitter))).toBeLessThan(-0.9);
    expect(Math.max(...vs.map((v) => v.jitter))).toBeGreaterThan(0.9);
    for (const v of vs) {
      expect(v.rate).toBeGreaterThanOrEqual(0.75);
      expect(v.rate).toBeLessThanOrEqual(1.3);
    }
    const keys = new Set(vs.map((v) => `${v.ox.toFixed(4)}:${v.oy.toFixed(4)}`));
    expect(keys.size).toBeGreaterThan(1990);
  });
  it('fuzz: always finite and in range, even for garbage seeds', () => {
    fc.assert(
      fc.property(fc.oneof(fc.double(), fc.constantFrom(Number.NaN, Infinity, -Infinity)), (s) => {
        const v = particleVariation(s);
        expect(Math.abs(v.flip)).toBe(1);
        for (const x of [v.jitter, v.ox, v.oy, v.rate]) expect(Number.isFinite(x)).toBe(true);
        expect(v.ox).toBeGreaterThanOrEqual(0);
        expect(v.ox).toBeLessThan(1);
      }),
    );
  });
});

describe('smoke erosion with age', () => {
  it('a young puff keeps its density; an old one frays (thin parts vanish first)', () => {
    expect(smokeErosion(0.8, 0.5, 0)).toBeCloseTo(0.8, 2);
    expect(smokeErosion(0.3, 0.5, 1)).toBeLessThan(0.1);
    expect(smokeErosion(1, 0.5, 1)).toBeGreaterThan(0.9);
    expect(smokeErosion(0, 1, 1)).toBe(0);
  });
  it('fuzz: in [0,1], zero where there is no density, non-decreasing in density, non-increasing with age at mean noise', () => {
    fc.assert(
      fc.property(unit, unit, unit, unit, (d1, d2, n, a) => {
        const lo = Math.min(d1, d2), hi = Math.max(d1, d2);
        const e1 = smokeErosion(lo, n, a);
        const e2 = smokeErosion(hi, n, a);
        expect(e1).toBeGreaterThanOrEqual(0);
        expect(e2).toBeLessThanOrEqual(1);
        expect(e2).toBeGreaterThanOrEqual(e1 - 1e-12);
        expect(smokeErosion(0, n, a)).toBe(0);
        const young = smokeErosion(hi, 0.5, Math.min(a, 0.5));
        const old = smokeErosion(hi, 0.5, Math.max(a, 0.5));
        expect(old).toBeLessThanOrEqual(young + 1e-12);
      }),
    );
  });
  it('noise breaks the edge up: the same density is eroded more where the noise is low', () => {
    expect(smokeErosion(0.4, 0.1, 0.6)).toBeLessThan(smokeErosion(0.4, 0.9, 0.6));
  });
});

describe('self-shadowing', () => {
  it('no density toward the sun = fully lit; thick smoke in the way = dark', () => {
    expect(selfShadow(0)).toBe(1);
    expect(selfShadow(1)).toBeLessThan(0.3);
    fc.assert(
      fc.property(unit, unit, (a, b) => {
        expect(selfShadow(Math.max(a, b))).toBeLessThanOrEqual(selfShadow(Math.min(a, b)) + 1e-12);
      }),
    );
  });
});

describe('minimum pixel size (energy conserving)', () => {
  it('leaves big sprites alone and grows tiny ones to the minimum while dimming them by the area ratio', () => {
    expect(pixelScale(10, 2)).toBe(1);
    const s = pixelScale(0.5, 2);
    expect(0.5 * s).toBeCloseTo(2, 9);
    fc.assert(
      fc.property(fc.double({ min: 1e-4, max: 100, noNaN: true }), fc.double({ min: 0.5, max: 4, noNaN: true }), (px, min) => {
        const k = pixelScale(px, min);
        expect(k).toBeGreaterThanOrEqual(1);
        expect(px * k).toBeGreaterThanOrEqual(Math.min(min, px * 1e4) - 1e-9);
        // coverage × opacity is conserved: (px·k)² · (1/k²) = px²
        expect((px * k) ** 2 / (k * k)).toBeCloseTo(px * px, 6);
      }),
    );
    expect(Number.isFinite(pixelScale(0, 2))).toBe(true);
    expect(Number.isFinite(pixelScale(Number.NaN, 2))).toBe(true);
  });
});

describe('temperature fields', () => {
  it('fireball: hottest in the thick core, mottled by the noise, zero once the heat is gone', () => {
    expect(fireballTemperature(0, 1, 1)).toBe(0);
    expect(fireballTemperature(1, 1, 0.5)).toBeGreaterThan(fireballTemperature(1, 0.2, 0.5));
    expect(fireballTemperature(1, 0.6, 0.9)).toBeGreaterThan(fireballTemperature(1, 0.6, 0.1) * 1.4);
    fc.assert(
      fc.property(unit, unit, unit, unit, (h1, h2, c, n) => {
        expect(fireballTemperature(Math.max(h1, h2), c, n)).toBeGreaterThanOrEqual(fireballTemperature(Math.min(h1, h2), c, n) - 1e-12);
        expect(fireballTemperature(h1, c, n)).toBeGreaterThanOrEqual(0);
      }),
    );
  });
  it('flame: hottest low in the core, cooling toward the tip (tips turn to soot)', () => {
    expect(flameTemperature(1, 1, 0)).toBeGreaterThan(flameTemperature(1, 1, 0.9) * 1.5);
    expect(flameTemperature(1, 1, 0.1)).toBeGreaterThan(flameTemperature(1, 0.1, 0.1));
    expect(flameTemperature(0, 1, 0)).toBe(0);
    fc.assert(
      fc.property(unit, unit, unit, (h, c, t) => {
        const v = flameTemperature(h, c, t);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1.5 * Math.max(h, 1e-9) + 1e-9);
      }),
    );
  });
});
