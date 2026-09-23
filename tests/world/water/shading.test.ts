import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { fcParams } from '../../support/fc';
import {
  LAND,
  bendStrength,
  landAlbedo,
  landSurface,
  landTone,
  marchReflection,
  riverOptics,
  riverProfile,
  riverTurbidity,
  riverWhitewater,
  treeCover,
  waterBody,
  glsl3,
  type RGB,
} from '../../../src/world/water/shading';

const inUnit = (c: RGB) => c.every((v) => Number.isFinite(v) && v >= 0 && v <= 1);
const lum = (c: RGB) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const W0 = { forest: 0, field: 0, grass: 0, rock: 0, snow: 0, sand: 0, urban: 0, water: 0 };

describe('land seen in reflections', () => {
  it('orders the tones forest < grass < field < rock < snow, trees darken everything to forest', () => {
    const t = (k: keyof typeof W0) => landTone({ ...W0, [k]: 1 }, 0);
    expect(t('forest')).toBeLessThan(t('grass'));
    expect(t('grass')).toBeLessThan(t('field'));
    expect(t('field')).toBeLessThan(t('rock'));
    expect(t('rock')).toBeLessThan(t('snow'));
    expect(landTone({ ...W0, snow: 1 }, 1)).toBe(0);
    expect(lum(landAlbedo(0))).toBeLessThan(lum(landAlbedo(0.25)));
    expect(lum(landAlbedo(1))).toBeGreaterThan(0.6);
    expect(landAlbedo(0)).toEqual(LAND.forest);
  });

  it('canopy stands on the ground; closed forest ≈ 17 m, alpine trees shorter, roofs 8 m', () => {
    expect(landSurface(100, 1, 0)).toBeCloseTo(100 + LAND.treeHeight, 6);
    expect(landSurface(2000, 1, 0)).toBeCloseTo(2000 + LAND.treeHeightAlpine, 6);
    expect(landSurface(50, 0, 1)).toBeCloseTo(58, 6);
    expect(treeCover(0)).toBe(0);
    expect(treeCover(0.55)).toBe(1); // riparian strips
  });

  it('fuzz: tone, albedo and surface are finite and in range for any weights', () => {
    const w = fc.double({ min: 0, max: 1, noNaN: true });
    fc.assert(
      fc.property(w, w, w, w, w, w, w, w, fc.double({ min: -500, max: 4000, noNaN: true }), (a, b, c, d, e, f, g, cov, h) => {
        const tone = landTone({ forest: a, field: b, grass: c, rock: d, snow: e, sand: f, urban: g, water: 0 }, cov);
        expect(tone).toBeGreaterThanOrEqual(0);
        expect(tone).toBeLessThanOrEqual(1);
        expect(inUnit(landAlbedo(tone))).toBe(true);
        const s = landSurface(h, cov, g);
        expect(s).toBeGreaterThanOrEqual(h);
        expect(s).toBeLessThanOrEqual(h + LAND.treeHeight + LAND.urbanHeight + 1e-9);
      }),
      fcParams(300),
    );
    expect(inUnit(landAlbedo(NaN))).toBe(true);
  });
});

describe('reflection march', () => {
  const flat = (): [number, number] => [-10, 0.3];
  const up = (a: number): [number, number, number] => [Math.cos(a), Math.sin(a), 0];

  it('sees the sky over open water and a wall of trees across a river', () => {
    expect(marchReflection(flat, [0, 0, 0], up(0.1), 0.01).cover).toBe(0);
    // a 17 m tree line 40 m away along +x
    const wall = (x: number): [number, number] => (x > 40 ? [17, 0] : [-3, 0.3]);
    const low = marchReflection(wall, [0, 0, 0], up(0.2), 0.01); // tan 0.2·40 ≈ 8 m < 17 m → hit
    expect(low.cover).toBe(1);
    expect(low.t).toBeGreaterThan(40);
    expect(low.t).toBeLessThan(80);
    const high = marchReflection(wall, [0, 0, 0], up(0.9), 0.01); // clears the trees
    expect(high.cover).toBe(0);
  });

  it('finds a mountain 12 km away behind a lake', () => {
    const mtn = (x: number): [number, number] => [x > 12000 ? 2500 : -20, 0.9];
    const hit = marchReflection(mtn, [0, 200, 0], up(0.1), 0.01); // 12 km · tan 0.1 ≈ 1.2 km < 2.3 km
    expect(hit.cover).toBe(1);
    expect(hit.tone).toBeCloseTo(0.9, 6);
    expect(marchReflection(mtn, [0, 200, 0], up(0.35), 0.01).cover).toBe(0);
  });

  it('softens the silhouette with roughness', () => {
    const wall = (x: number): [number, number] => (x > 100 ? [20, 0] : [-3, 0.3]);
    // ray just grazing the treetops: sharp on calm water, half-covered on rough water
    const a = Math.atan(20 / 104);
    const calm = marchReflection(wall, [0, 0, 0], up(a + 0.03), 0.005).cover;
    const rough = marchReflection(wall, [0, 0, 0], up(a + 0.03), 0.2).cover;
    expect(calm).toBe(0);
    expect(rough).toBeGreaterThan(0.2);
    expect(rough).toBeLessThan(0.8);
  });

  it('fuzz: coverage in [0, 1], distance finite, for any ray and terrain', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.001, max: 1.5, noNaN: true }),
        fc.double({ min: 0, max: 6.3, noNaN: true }),
        fc.double({ min: 0, max: 0.8, noNaN: true }),
        fc.integer({ min: 0, max: 1000 }),
        (el, az, soft, seed) => {
          const land = (x: number, z: number): [number, number] => [Math.sin(x / 300 + seed) * 200 + Math.cos(z / 500) * 150, 0.5];
          const R: [number, number, number] = [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)];
          const h = marchReflection(land, [0, 360, 0], R, soft);
          expect(h.cover).toBeGreaterThanOrEqual(0);
          expect(h.cover).toBeLessThanOrEqual(1);
          expect(Number.isFinite(h.t)).toBe(true);
        },
      ),
      fcParams(200),
    );
  });
});

describe('river cross-section', () => {
  it('is symmetric and deepest in the middle of a straight reach, dry nowhere', () => {
    const c = riverProfile(0, 0, 4, 0);
    expect(c.depth).toBeCloseTo(4.05, 6);
    for (const u of [0.2, 0.5, 0.9]) {
      expect(riverProfile(u, 0, 4, 0).depth).toBeCloseTo(riverProfile(-u, 0, 4, 0).depth, 9);
      expect(riverProfile(u, 0, 4, 0).depth).toBeLessThan(c.depth);
    }
    expect(riverProfile(0.95, 0, 4, 0).dry).toBe(0);
  });

  it('bends: the thalweg moves to the outer bank, a point bar dries on the inner bank', () => {
    // inner bank at u > 0 for b > 0
    const deepest = (b: number) => {
      let best = -2;
      let bd = -Infinity;
      for (let u = -1; u <= 1; u += 0.01) {
        const d = riverProfile(u, b, 4, 0).depth;
        if (d > bd) {
          bd = d;
          best = u;
        }
      }
      return best;
    };
    expect(deepest(1)).toBeLessThan(-0.3);
    expect(deepest(-1)).toBeGreaterThan(0.3);
    expect(riverProfile(0.85, 1, 4, 0).dry).toBe(1); // the bar
    expect(riverProfile(-0.85, 1, 4, 0).dry).toBe(0); // the cut bank stays wet
    expect(riverProfile(-0.85, 1, 4, 0).depth).toBeGreaterThan(1);
  });

  it('irregular edges: a high edge noise exposes the margin, the middle stays wet', () => {
    expect(riverProfile(0.97, 0, 3, 1).dry).toBeGreaterThan(0.5);
    expect(riverProfile(0.2, 0, 3, 1).dry).toBe(0);
  });

  it('bend strength follows curvature·half-width and is clamped', () => {
    expect(bendStrength(0, 30)).toBe(0);
    expect(bendStrength(1 / 1000, 30)).toBeCloseTo(0.42, 6);
    expect(bendStrength(1, 30)).toBe(1);
    expect(bendStrength(-1, 30)).toBe(-1);
    expect(bendStrength(NaN, 30)).toBe(0);
  });

  it('fuzz: finite depth ≤ D + 0.05, dry in [0, 1] and only where the depth is ≤ 0.02', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1.5, max: 1.5, noNaN: true }),
        fc.double({ min: -2, max: 2, noNaN: true }),
        fc.double({ min: 0, max: 8, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (u, b, D, n) => {
          const s = riverProfile(u, b, D, n);
          expect(Number.isFinite(s.depth)).toBe(true);
          expect(s.depth).toBeLessThanOrEqual(D + 0.05 + 1e-9);
          expect(s.dry).toBeGreaterThanOrEqual(0);
          expect(s.dry).toBeLessThanOrEqual(1);
          if (s.dry > 0) expect(s.depth).toBeLessThan(0.02);
        },
      ),
      fcParams(400),
    );
  });
});

describe('river optics', () => {
  it('clear water upstream shows the bed; turbid water downstream hides it and is browner', () => {
    const clear = riverOptics(0);
    const turbid = riverOptics(1);
    const shallowClear = waterBody(0.8, 1, clear.absorb, clear.deep, clear.bed);
    const shallowTurbid = waterBody(0.8, 1, turbid.absorb, turbid.deep, turbid.bed);
    expect(lum(shallowClear)).toBeGreaterThan(lum(shallowTurbid));
    // turbid deep water: red ≥ blue (olive-brown), clear deep water: blue-green
    const deepT = waterBody(4, 1, turbid.absorb, turbid.deep, turbid.bed);
    const deepC = waterBody(4, 1, clear.absorb, clear.deep, clear.bed);
    expect(deepT[0]).toBeGreaterThan(deepT[2]);
    expect(deepC[2]).toBeGreaterThan(deepC[0]);
    // the plains are turbid, the mountains clear, rapids clearer than pools
    expect(riverTurbidity(0.9, 0, 0.004)).toBeGreaterThan(0.8);
    expect(riverTurbidity(0.05, 0, 0.004)).toBeLessThan(0.2);
    expect(riverTurbidity(0.5, 0.05, 0.004)).toBeLessThan(riverTurbidity(0.5, 0, 0.004));
  });

  it('fuzz: body colours finite and within [0, 1]; whitewater in [0, 1], none without rapids', () => {
    const u = fc.double({ min: 0, max: 1, noNaN: true });
    fc.assert(
      fc.property(u, fc.double({ min: -3, max: 50, noNaN: true }), fc.double({ min: -1, max: 2, noNaN: true }), u, u, u, u, (tb, depth, cosT, r, ph, sw, st) => {
        const o = riverOptics(tb);
        for (const c of [o.absorb.map((v) => v / 2) as RGB, o.deep, o.bed, o.bar]) expect(inUnit(c)).toBe(true);
        expect(inUnit(waterBody(depth, cosT, o.absorb, o.deep, o.bed))).toBe(true);
        const w = riverWhitewater(r, ph, sw, st);
        expect(w).toBeGreaterThanOrEqual(0);
        expect(w).toBeLessThanOrEqual(1);
        expect(riverWhitewater(0, ph, sw, st)).toBe(0);
      }),
      fcParams(400),
    );
  });

  it('rapids: whitewater boils below each drop, calmer pools between, coverage grows with the rapids but never all', () => {
    const cover = (r: number) => {
      let n = 0;
      let k = 0;
      for (let ph = 0; ph < 1; ph += 0.05) for (let a = 0; a <= 1; a += 0.1) for (let b = 0; b <= 1; b += 0.1, k++) n += riverWhitewater(r, ph, a, b) > 0.5 ? 1 : 0;
      return n / k;
    };
    expect(cover(0.2)).toBeLessThan(cover(1));
    expect(cover(1)).toBeGreaterThan(0.08);
    expect(cover(1)).toBeLessThan(0.6);
    expect(riverWhitewater(1, 0.02, 0.5, 0.5)).toBeGreaterThan(riverWhitewater(1, 0.8, 0.5, 0.5));
  });

  it('emits GLSL literals', () => {
    expect(glsl3([0.1, 0.2, 0.3])).toBe('vec3( 0.1000, 0.2000, 0.3000 )');
  });
});
