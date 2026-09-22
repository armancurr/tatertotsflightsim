import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { filmicNeutral, installFilmicNeutral, FILMIC_NEUTRAL_GLSL } from '../../src/render/toneMapping';

const out = () => ({ r: 0, g: 0, b: 0 });

describe('filmic neutral tone mapping (Khronos Neutral shoulder, no shadow crush)', () => {
  it('maps black to black and keeps shadows nearly linear (no toe crush)', () => {
    const z = filmicNeutral({ r: 0, g: 0, b: 0 }, 1, out());
    expect(z.r + z.g + z.b).toBe(0);
    const s = filmicNeutral({ r: 0.05, g: 0.04, b: 0.02 }, 1, out());
    expect(s.g).toBeGreaterThan(0.85 * 0.04);
    expect(s.b).toBeGreaterThan(0.6 * 0.02);
  });
  it('compresses highlights into [0,1] and desaturates them toward white', () => {
    const h = filmicNeutral({ r: 40, g: 30, b: 10 }, 1, out());
    for (const c of [h.r, h.g, h.b]) expect(c).toBeLessThanOrEqual(1 + 1e-9);
    expect(h.b / h.r).toBeGreaterThan(10 / 40);
  });
  it('is monotonic in exposure for any colour (property)', () => {
    const ch = fc.double({ min: 0, max: 50, noNaN: true });
    fc.assert(
      fc.property(ch, ch, ch, fc.double({ min: 1.01, max: 4, noNaN: true }), (r, g, b, k) => {
        const a = filmicNeutral({ r, g, b }, 1, out());
        const c = filmicNeutral({ r, g, b }, k, out());
        const lum = (x: typeof a) => 0.2126 * x.r + 0.7152 * x.g + 0.0722 * x.b;
        expect(lum(c)).toBeGreaterThanOrEqual(lum(a) - 1e-9);
        for (const x of [c.r, c.g, c.b]) {
          expect(x).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThanOrEqual(1 + 1e-9);
        }
      }),
    );
  });
  it('installs as three.js CustomToneMapping', () => {
    installFilmicNeutral();
    expect(THREE.ShaderChunk.tonemapping_pars_fragment).toContain(FILMIC_NEUTRAL_GLSL.trim().split('\n')[0]);
    expect(THREE.ShaderChunk.tonemapping_pars_fragment).not.toContain('vec3 CustomToneMapping( vec3 color ) { return color; }');
  });
});
