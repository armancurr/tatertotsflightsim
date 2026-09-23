import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { filmicNeutral, filmicTone, filmicToneGlsl, installFilmicNeutral, FILMIC_NEUTRAL_GLSL, DEFAULT_TONE, type ToneParams } from '../../src/render/toneMapping';

const out = () => ({ r: 0, g: 0, b: 0 });
const lum = (x: { r: number; g: number; b: number }) => 0.2126 * x.r + 0.7152 * x.g + 0.0722 * x.b;
const grey = (v: number, p: ToneParams = DEFAULT_TONE, e = 1) => filmicTone({ r: v, g: v, b: v }, e, p, out()).g;

describe('filmic tone curve (hue-preserving, soft shoulder, no shadow crush)', () => {
  it('maps black to black and keeps shadows nearly linear (no toe crush)', () => {
    const z = filmicNeutral({ r: 0, g: 0, b: 0 }, 1, out());
    expect(z.r + z.g + z.b).toBe(0);
    const s = filmicNeutral({ r: 0.05, g: 0.04, b: 0.02 }, 1, out());
    expect(s.g).toBeGreaterThan(0.75 * 0.04);
    expect(s.b).toBeGreaterThan(0.5 * 0.02);
    // a sky-lit shadow on grass (≈1–2 % after exposure) is not crushed to black
    expect(grey(0.015)).toBeGreaterThan(0.0105);
  });
  it('compresses highlights into [0,1] and desaturates them toward white', () => {
    const h = filmicNeutral({ r: 40, g: 30, b: 10 }, 1, out());
    for (const c of [h.r, h.g, h.b]) expect(c).toBeLessThanOrEqual(1 + 1e-9);
    expect(h.b / h.r).toBeGreaterThan(10 / 40);
  });
  it('keeps gradation in the highlights: sunlit cloud (≈1.6), white paint (≈1.2) and 4× over stay apart', () => {
    const a = grey(1.2);
    const b = grey(1.6);
    const c = grey(4);
    // at least ~2 display code values between each (8-bit, after sRGB) — the old shoulder merged them
    const srgb = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055) * 255;
    expect(srgb(b) - srgb(a)).toBeGreaterThan(3);
    expect(srgb(c) - srgb(b)).toBeGreaterThan(3);
    expect(c).toBeLessThan(0.985);
  });
  it('middle grey stays near middle grey (the look others calibrated at exposure 2.2 does not shift)', () => {
    expect(grey(0.18)).toBeGreaterThan(0.16);
    expect(grey(0.18)).toBeLessThan(0.2);
  });
  it('contrast > 1 deepens shadows and lifts upper mids around the pivot, hue unchanged', () => {
    const flat = { ...DEFAULT_TONE, contrast: 1 };
    const punchy = { ...DEFAULT_TONE, contrast: 1.15 };
    expect(grey(0.05, punchy)).toBeLessThan(grey(0.05, flat));
    expect(grey(0.5, punchy)).toBeGreaterThan(grey(0.5, flat));
    const c = filmicTone({ r: 0.3, g: 0.2, b: 0.1 }, 1, punchy, out());
    expect(c.g / c.r).toBeCloseTo(0.2 / 0.3, 2);
  });
  const ch = fc.double({ min: 0, max: 1e4, noNaN: true });
  const params = fc.record({
    contrast: fc.double({ min: 0.8, max: 1.4, noNaN: true }),
    shoulderStart: fc.double({ min: 0.3, max: 0.9, noNaN: true }),
    toe: fc.double({ min: 0, max: 0.03, noNaN: true }),
    desaturation: fc.double({ min: 0, max: 0.5, noNaN: true }),
    pivot: fc.double({ min: 0.05, max: 0.5, noNaN: true }),
  });
  it('is monotonic in exposure, finite and in [0,1] for any colour and any sane parameters (property)', () => {
    fc.assert(
      fc.property(ch, ch, ch, fc.double({ min: 1.01, max: 4, noNaN: true }), params, (r, g, b, k, p) => {
        const a = filmicTone({ r, g, b }, 1, p, out());
        const c = filmicTone({ r, g, b }, k, p, out());
        expect(lum(c)).toBeGreaterThanOrEqual(lum(a) - 1e-7);
        for (const x of [a.r, a.g, a.b, c.r, c.g, c.b]) {
          expect(Number.isFinite(x)).toBe(true);
          expect(x).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThanOrEqual(1 + 1e-9);
        }
      }),
      { numRuns: 400 },
    );
  });
  it('is monotonic along the grey axis (property)', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 100, noNaN: true }), fc.double({ min: 1e-4, max: 10, noNaN: true }), params, (v, dv, p) => {
        expect(grey(v + dv, p)).toBeGreaterThanOrEqual(grey(v, p) - 1e-9);
      }),
      { numRuns: 400 },
    );
  });
  it('the GLSL is generated from the same parameters and installs as three.js CustomToneMapping', () => {
    const glsl = filmicToneGlsl({ ...DEFAULT_TONE, contrast: 1.234 });
    expect(glsl).toContain('1.234');
    expect(glsl).toContain('vec3 CustomToneMapping( vec3 color )');
    installFilmicNeutral();
    expect(THREE.ShaderChunk.tonemapping_pars_fragment).toContain(FILMIC_NEUTRAL_GLSL.trim().split('\n')[0]);
    expect(THREE.ShaderChunk.tonemapping_pars_fragment).not.toContain('vec3 CustomToneMapping( vec3 color ) { return color; }');
    // re-installing with other parameters replaces the curve (no duplicate definitions)
    installFilmicNeutral({ ...DEFAULT_TONE, contrast: 1.111 });
    const src = THREE.ShaderChunk.tonemapping_pars_fragment;
    expect(src.split('vec3 CustomToneMapping( vec3 color )').length).toBe(2);
    expect(src).toContain('1.111');
    installFilmicNeutral();
  });
});
