import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { DETAIL_LOD, bandCover, detailFades, stripeFade } from '../../../src/world/terrain/detailLod';
import { DETAIL_TILE_M } from '../../../src/world/terrain/detailTextures';
import { TERRAIN_FRAGMENT_PARS } from '../../../src/world/terrain/terrainShader';

const footprint = fc.double({ min: 1e-3, max: 5e4, noNaN: true, noDefaultInfinity: true });
const tile = fc.constantFrom(...DETAIL_TILE_M);

describe('terrain detail LOD (twins of the shader fades)', () => {
  it('every fade is 1 up close, 0 once the feature is sub-pixel, and finite in [0, 1] between', () => {
    for (const S of DETAIL_TILE_M) {
      const near = detailFades(Math.min(S * DETAIL_LOD.nearStart * 0.5, DETAIL_LOD.blendStart * 0.5), 0.01, S);
      expect(near).toEqual({ near: 1, mid: 1, blend: 1, bump: 1 });
      const far = detailFades(S * DETAIL_LOD.midScale, 10, S);
      expect(far).toEqual({ near: 0, mid: 0, blend: 0, bump: 0 });
    }
    expect(stripeFade(0.25, 0.01)).toBe(1);
    expect(stripeFade(0.25, 0.25 * DETAIL_LOD.stripeEnd)).toBe(0);
  });

  it('property: the fades never grow with the footprint (i.e. with distance), and stay finite', () => {
    fc.assert(
      fc.property(footprint, footprint, footprint, tile, fc.double({ min: 0.05, max: 40, noNaN: true }), (a, b, c, S, period) => {
        const [f1, f2] = a <= b ? [a, b] : [b, a];
        const g = Math.min(c, f1); // gFw ≥ gFwD for the same pixel is not required by the fades; any pair works
        const x = detailFades(f1, g, S);
        const y = detailFades(f2, Math.max(g, f2), S);
        for (const k of ['near', 'mid', 'blend', 'bump'] as const) {
          if (!Number.isFinite(x[k]) || !Number.isFinite(y[k])) return false;
          if (x[k] < 0 || x[k] > 1 || y[k] < 0 || y[k] > 1) return false;
          if (y[k] > x[k] + 1e-12) return false;
        }
        const s1 = stripeFade(period, f1);
        const s2 = stripeFade(period, f2);
        return Number.isFinite(s1) && Number.isFinite(s2) && s2 <= s1 + 1e-12 && s1 >= 0 && s1 <= 1;
      }),
      { numRuns: 2000 },
    );
  });

  it('property: detail fades out before its texture would alias — near detail is gone by 1/9 of its tile per pixel', () => {
    fc.assert(
      fc.property(tile, fc.double({ min: 1 / 9, max: 1e3, noNaN: true }), (S, k) => detailFades(S * k, S * k, S).near === 0),
    );
  });

  it('property: band coverage is finite, in [0, 1], and falls with the distance from the band', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 500, noNaN: true }),
        fc.double({ min: 0, max: 500, noNaN: true }),
        fc.double({ min: 0.01, max: 20, noNaN: true }),
        footprint,
        (d1, d2, w, fw) => {
          const [a, b] = d1 <= d2 ? [d1, d2] : [d2, d1];
          const ca = bandCover(a, w, fw);
          const cb = bandCover(b, w, fw);
          return Number.isFinite(ca) && Number.isFinite(cb) && ca >= 0 && ca <= 1 && cb >= 0 && cb <= 1 && cb <= ca + 1e-12;
        },
      ),
      { numRuns: 2000 },
    );
  });
});

describe('terrain shader source (performance guards)', () => {
  it('builds its fades from DETAIL_LOD', () => {
    expect(TERRAIN_FRAGMENT_PARS).toContain(`S * ${DETAIL_LOD.nearEnd}`);
    expect(TERRAIN_FRAGMENT_PARS).toContain(`S2 * ${DETAIL_LOD.midEnd}`);
    expect(TERRAIN_FRAGMENT_PARS).toContain(`period * ${DETAIL_LOD.stripeEnd}`);
  });

  it('never indexes the class-weight array with a variable (a dynamically indexed local array spills to memory: ~5 ms a frame over farmland)', () => {
    const uses = [...TERRAIN_FRAGMENT_PARS.matchAll(/\bw\[\s*([^\]]+?)\s*\]/g)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const idx of uses) expect(idx, `w[ ${idx} ]`).toMatch(/^(\d+|K)$/);
  });

  it('evaluates each class surface at most three times per pixel (no per-class loop)', () => {
    const calls = TERRAIN_FRAGMENT_PARS.split('tClassSurf(').length - 2; // minus the definition
    expect(calls).toBeLessThanOrEqual(3);
    expect(TERRAIN_FRAGMENT_PARS).not.toMatch(/for\s*\(\s*int k = 0; k < 8; k\+\+\s*\)\s*\{\s*if \( k == i1/);
  });
});
