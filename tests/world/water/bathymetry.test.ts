import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { fcParams } from '../../support/fc';
import {
  bakeBathymetry,
  newBathyLevel,
  sampleBathymetry,
  makeWaterDepthFn,
  shoreDistanceTransform,
  packBathymetryHalf,
  surfFoam,
  levelNeedsRecentre,
  SHORE_DIST_MAX,
  surfBreakerSpacing,
} from '../../../src/world/water/bathymetry';
import { fromHalf } from '../../../src/world/water/detail';
import { getHeightfield } from '../../../src/world/heightfield';
import { getLayout } from '../../../src/world/layout';

const hf = getHeightfield();
const L = getLayout();
const depthAt = makeWaterDepthFn(hf);

describe('water depth function', () => {
  it('is sea depth offshore, lake depth in lakes, negative on land', () => {
    const bayZ = L.coast.zAt(3300) + 1500;
    expect(depthAt(3300, bayZ)).toBeCloseTo(-hf.height(3300, bayZ), 9);
    expect(depthAt(3300, bayZ)).toBeGreaterThan(5);
    const lk = L.lakes[0];
    expect(depthAt(lk.center.x, lk.center.z)).toBeCloseTo(lk.level - hf.height(lk.center.x, lk.center.z), 9);
    expect(depthAt(lk.center.x, lk.center.z)).toBeGreaterThan(10);
    expect(depthAt(0, 0)).toBeLessThan(-20); // the airfield
  });
});

describe('bathymetry bake + sampling', () => {
  const lin = (x: number, z: number) => 2 + 0.01 * x - 0.02 * z;
  const lv = bakeBathymetry(lin, 100, -50, 640, 32, newBathyLevel(32));

  it('stores texel-centre samples and reproduces them', () => {
    const cell = 640 / 32;
    expect(lv.cell).toBe(cell);
    for (const [i, j] of [
      [0, 0],
      [5, 17],
      [31, 31],
    ]) {
      const x = 100 - 320 + (i + 0.5) * cell;
      const z = -50 - 320 + (j + 0.5) * cell;
      expect(lv.depth[j * 32 + i]).toBeCloseTo(lin(x, z), 5);
      expect(sampleBathymetry(lv, x, z)).toBeCloseTo(lin(x, z), 5);
    }
  });

  it('interpolates bilinearly (exact for a linear field) and clamps at the edges', () => {
    fc.assert(
      fc.property(fc.double({ min: -209, max: 409, noNaN: true }), fc.double({ min: -359, max: 259, noNaN: true }), (x, z) => {
        expect(sampleBathymetry(lv, x, z)).toBeCloseTo(lin(x, z), 4);
      }),
      fcParams(300),
    );
    // far outside: the edge value (clamp to edge like the GPU sampler)
    expect(sampleBathymetry(lv, 1e6, -50)).toBeCloseTo(sampleBathymetry(lv, 100 + 320 - 10, -50), 4);
  });

  it('matches the terrain on the real coast (≤ 0.6 m between texels, 16 m cells)', () => {
    const cx = 3300;
    const cz = L.coast.zAt(3300) + 300;
    const lvl = bakeBathymetry(depthAt, cx, cz, 2048, 128, newBathyLevel(128));
    fc.assert(
      fc.property(fc.double({ min: -900, max: 900, noNaN: true }), fc.double({ min: -900, max: 900, noNaN: true }), (dx, dz) => {
        const d = sampleBathymetry(lvl, cx + dx, cz + dz);
        const truth = depthAt(cx + dx, cz + dz);
        // gentle sea floor: close; everywhere: bounded by the local relief
        if (truth > 0 && truth < 30) expect(Math.abs(d - truth)).toBeLessThan(2.5);
        expect(Number.isFinite(d)).toBe(true);
      }),
      fcParams(300),
    );
  });
});

describe('shore distance', () => {
  it('measures the distance to the shoreline, signed (+ water)', () => {
    // a straight shore at x = 0: water for x > 0, depth = x/25
    const lv = bakeBathymetry((x) => x / 25, 0, 0, 1024, 64, newBathyLevel(64));
    shoreDistanceTransform(lv);
    for (const x of [-300, -40, 8, 40, 200, 400]) {
      const d = sampleBathymetry(lv, x, 37, 'shore');
      expect(Math.sign(d)).toBe(Math.sign(x));
      expect(Math.abs(d - x)).toBeLessThan(Math.max(10, Math.abs(x) * 0.08));
    }
  });

  it('rings an island', () => {
    const lv = bakeBathymetry((x, z) => Math.hypot(x, z) / 20 - 10, 0, 0, 2048, 128, newBathyLevel(128)); // shore at r = 200
    shoreDistanceTransform(lv);
    for (const a of [0, 1, 2.5, 4]) {
      const at = (r: number) => sampleBathymetry(lv, Math.cos(a) * r, Math.sin(a) * r, 'shore');
      expect(Math.abs(at(200))).toBeLessThan(12);
      expect(at(400)).toBeGreaterThan(180);
      expect(at(400)).toBeLessThan(220);
      expect(at(50)).toBeLessThan(-130);
    }
  });

  it('fuzz: 1-Lipschitz (a distance field) and clamped', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1000 }), (seed) => {
        const f = (x: number, z: number) => Math.sin(x / 90 + seed) * 6 + Math.cos(z / 70 - seed * 0.3) * 5 + (seed % 7) - 3;
        const lv = bakeBathymetry(f, 0, 0, 1024, 32, newBathyLevel(32));
        shoreDistanceTransform(lv);
        const n = 32;
        for (let j = 0; j < n; j++)
          for (let i = 0; i < n; i++) {
            const d = lv.shore[j * n + i];
            expect(Math.abs(d)).toBeLessThanOrEqual(SHORE_DIST_MAX);
            expect(Math.sign(d) === Math.sign(lv.depth[j * n + i]) || Math.abs(d) < lv.cell).toBe(true);
            if (i + 1 < n) expect(Math.abs(lv.shore[j * n + i + 1] - d)).toBeLessThanOrEqual(lv.cell * 1.5 + 1e-6);
            if (j + 1 < n) expect(Math.abs(lv.shore[(j + 1) * n + i] - d)).toBeLessThanOrEqual(lv.cell * 1.5 + 1e-6);
          }
      }),
      fcParams(30),
    );
  });

  it('packs depth and distance into half-float RG texels', () => {
    const lv = bakeBathymetry((x) => x / 25, 0, 0, 1024, 16, newBathyLevel(16));
    shoreDistanceTransform(lv);
    const out = new Uint16Array(16 * 16 * 2);
    packBathymetryHalf(lv, out);
    for (let i = 0; i < 256; i++) {
      expect(fromHalf(out[i * 2])).toBeCloseTo(lv.depth[i], 1);
      expect(fromHalf(out[i * 2 + 1])).toBeCloseTo(lv.shore[i], 0);
    }
  });

  it('recentres a level once the camera has moved far enough', () => {
    const lv = newBathyLevel(8);
    lv.cx = 0;
    lv.cz = 0;
    lv.extent = 4000;
    lv.valid = true;
    expect(levelNeedsRecentre(lv, 100, 100, 0.14)).toBe(false);
    expect(levelNeedsRecentre(lv, 600, 0, 0.14)).toBe(true);
    lv.valid = false;
    expect(levelNeedsRecentre(lv, 0, 0, 0.14)).toBe(true);
  });
});

describe('surf foam mask', () => {
  const W = 60;
  const T = 7.5;
  it('fuzz: always within [0, 1] and zero away from the shore', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -5, max: 60, noNaN: true }),
        fc.double({ min: -50, max: 3000, noNaN: true }),
        fc.double({ min: 0, max: 1e5, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (depth, dist, t, n) => {
          const f = surfFoam(depth, dist, t, n, W, T);
          expect(f).toBeGreaterThanOrEqual(0);
          expect(f).toBeLessThanOrEqual(1);
          if (dist > W * 1.25 || depth > 7 || depth < -0.35) expect(f).toBe(0);
        },
      ),
      fcParams(1000),
    );
  });

  it('sends breaker lines shoreward and keeps a lapping line at the waterline', () => {
    // the pattern at t + Δ equals the pattern at t moved toward the shore by v·Δ
    const v = surfBreakerSpacing(W) / T;
    let toward = 0;
    let away = 0;
    for (let t = 0; t < 20; t += 0.53)
      for (let d = 18; d < 32; d += 0.7) {
        const f = surfFoam(d / 25, d, t, 0.5, W, T);
        toward += Math.abs(surfFoam((d - v * 0.4) / 25, d - v * 0.4, t + 0.4, 0.5, W, T) - f);
        away += Math.abs(surfFoam((d + v * 0.4) / 25, d + v * 0.4, t + 0.4, 0.5, W, T) - f);
      }
    expect(toward).toBeLessThan(away * 0.35);
    // at the waterline some foam is always present
    let mean = 0;
    for (let t = 0; t < 30; t += 0.1) mean += surfFoam(0.05, 1, t, 0.5, W, T);
    expect(mean / 300).toBeGreaterThan(0.25);
    // across the surf zone the time-averaged coverage is moderate
    let zone = 0;
    let n = 0;
    for (let t = 0; t < 30; t += 0.37)
      for (let d = 5; d < 50; d += 3) {
        zone += surfFoam(d / 25, d, t, 0.5, W, T);
        n++;
      }
    expect(zone / n).toBeGreaterThan(0.05);
    expect(zone / n).toBeLessThan(0.5);
  });
});
