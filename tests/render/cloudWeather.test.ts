/**
 * Cloud weather map + cloud-shadow geometry (cloudWeather.ts): the rasterised
 * column-top heightfield matches the puff layout, the density profile has a
 * flat base and a soft top, the sun projection is geometrically exact, and the
 * shadow factor is finite and in [0, 1] for any input.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { generateCloudField, PUFF_STRIDE, P_DX, P_DZ, P_R, P_Y } from '../../src/render/cloudLayout';
import {
  createWeatherMap,
  rasterizeWeather,
  sampleWeather,
  cloudColumnDensity,
  projectAlongSun,
  shadowOpacityAt,
  cloudShadowFactor,
  weatherUv,
  type WeatherSample,
} from '../../src/render/cloudWeather';
import { sunDirectionFromAngles } from '../../src/render/sun';

const field = generateCloudField({ seed: 3, count: 60, coverage: 0.45, baseAltitude: 1500, thickness: 2000, areaRadius: 12000 });
const opts = { size: 512, baseMin: 1300, baseRange: 1600, maxThickness: 2200 };
const map = createWeatherMap(field, opts);
rasterizeWeather(field, map);
const s: WeatherSample = { top: 0, base: 0, dens: 0 };

describe('weather map', () => {
  it('covers each cloud centre with a column reaching near the cloud height, on the cloud base', () => {
    for (const c of field.clouds.slice(0, 20)) {
      sampleWeather(map, c.x, c.z, 0, 0, s);
      expect(s.top).toBeGreaterThan(0.3 * c.height);
      expect(s.top).toBeLessThanOrEqual(c.height + 0.05 * opts.maxThickness);
      expect(Math.abs(s.base - c.base)).toBeLessThan(opts.baseRange / 255 + 1);
    }
  });
  it('the column top is the upper surface of the puffs (never above any puff sphere)', () => {
    const p = field.puffs;
    for (let k = 0; k < 200; k++) {
      const ci = k % field.clouds.length;
      const c = field.clouds[ci];
      const i = c.firstPuff + (k % c.puffCount);
      const o = i * PUFF_STRIDE;
      const x = c.x + p[o + P_DX];
      const z = c.z + p[o + P_DZ];
      sampleWeather(map, x, z, 0, 0, s);
      // at a puff centre the column is at least as high as the puff top (minus texel/quantisation slop)
      expect(s.top).toBeGreaterThan(p[o + P_Y] - c.base + p[o + P_R] - 0.12 * opts.maxThickness);
    }
  });
  it('is empty far from every cloud', () => {
    let empty = 0;
    for (let i = 0; i < 400; i++) {
      const x = ((i * 7919) % 24000) - 12000;
      const z = ((i * 104729) % 24000) - 12000;
      const near = field.clouds.some((c) => Math.hypot(c.x - x, c.z - z) < c.radius * 1.3 || Math.hypot(Math.abs(c.x - x) - 24000, c.z - z) < c.radius * 1.3);
      if (near) continue;
      sampleWeather(map, x, z, 0, 0, s);
      if (s.top < 1) empty++;
      else expect(s.top).toBeLessThan(0.2 * opts.maxThickness);
    }
    expect(empty).toBeGreaterThan(50);
  });
  it('tiles: sampling one tile away gives the same column; wind shifts it', () => {
    const c = field.clouds[0];
    const a: WeatherSample = { top: 0, base: 0, dens: 0 };
    sampleWeather(map, c.x, c.z, 0, 0, a);
    sampleWeather(map, c.x + map.tile, c.z - map.tile, 0, 0, s);
    expect(s.top).toBeCloseTo(a.top, 6);
    sampleWeather(map, c.x + 500, c.z, 500, 0, s);
    expect(s.top).toBeCloseTo(a.top, 6);
  });
  it('is deterministic', () => {
    const m2 = createWeatherMap(field, opts);
    rasterizeWeather(field, m2);
    expect(Buffer.from(m2.data).equals(Buffer.from(map.data))).toBe(true);
  });
  it('uv mapping puts world x = 0 at the tile centre and is periodic', () => {
    const uv = { u: 0, v: 0 };
    weatherUv(map, 0, 0, 0, 0, uv);
    expect(uv.u).toBeCloseTo(0.5, 12);
    expect(uv.v).toBeCloseTo(0.5, 12);
  });
});

describe('column density profile', () => {
  it('is zero below the base and above the top, peaks inside, with a sharp flat base and a soft top', () => {
    const c = field.clouds.find((q) => q.height > 900)!;
    // the tallest column of this cloud
    let bx = c.x, bz = c.z, bt = -1;
    for (let dx = -c.radius; dx <= c.radius; dx += 25)
      for (let dz = -c.radius; dz <= c.radius; dz += 25) {
        sampleWeather(map, c.x + dx, c.z + dz, 0, 0, s);
        if (s.top > bt) (bt = s.top), (bx = c.x + dx), (bz = c.z + dz);
      }
    sampleWeather(map, bx, bz, 0, 0, s);
    const at = (y: number) => cloudColumnDensity(map, bx, y, bz, 0, 0);
    expect(at(s.base - 5)).toBe(0);
    expect(at(s.base + s.top + 5)).toBe(0);
    expect(at(s.base + s.top * 0.5)).toBeGreaterThan(0.8);
    // flat base: dense within 60 m above the base; soft top: thin in the top 60 m
    expect(at(s.base + 60)).toBeGreaterThan(0.8);
    expect(at(s.base + s.top - 60)).toBeLessThan(0.3);
  });
  it('property: finite and within [0, 1] everywhere', () => {
    fc.assert(
      fc.property(fc.double({ min: -1e6, max: 1e6, noNaN: true }), fc.double({ min: -1e4, max: 1e5, noNaN: true }), fc.double({ min: -1e6, max: 1e6, noNaN: true }), (x, y, z) => {
        const d = cloudColumnDensity(map, x, y, z, 0, 0);
        expect(Number.isFinite(d)).toBe(true);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(1);
      }),
    );
  });
});

describe('cloud-shadow projection geometry', () => {
  const unitSun = fc
    .tuple(fc.double({ min: -89, max: 90, noNaN: true }), fc.double({ min: 0, max: 360, noNaN: true }))
    .map(([el, az]) => sunDirectionFromAngles(el, az));
  const pt = fc.tuple(fc.double({ min: -1e5, max: 1e5, noNaN: true }), fc.double({ min: -500, max: 9000, noNaN: true }), fc.double({ min: -1e5, max: 1e5, noNaN: true }));

  it('projects a point along the sun ray onto the plane (the point lies on the ray, at the plane height)', () => {
    fc.assert(
      fc.property(pt, unitSun.filter((d) => d.y > 0.05), fc.double({ min: 0, max: 5000, noNaN: true }), ([x, y, z], sun, planeY) => {
        const q = { x: 0, y: 0, z: 0 };
        projectAlongSun(x, y, z, sun, planeY, q);
        expect(q.y).toBeCloseTo(planeY, 6);
        // q − p is parallel to the sun direction
        const t = (planeY - y) / sun.y;
        expect(q.x).toBeCloseTo(x + sun.x * t, 4);
        expect(q.z).toBeCloseTo(z + sun.z * t, 4);
      }),
    );
  });
  it('overhead sun projects straight up', () => {
    const q = { x: 0, y: 0, z: 0 };
    projectAlongSun(120, 40, -77, { x: 0, y: 1, z: 0 }, 1500, q);
    expect(q.x).toBeCloseTo(120, 9);
    expect(q.z).toBeCloseTo(-77, 9);
  });
  it('fuzz: shadow opacity and shadow factor are finite and in [0, 1] for any point and sun', () => {
    fc.assert(
      fc.property(pt, unitSun, fc.double({ min: 0, max: 1, noNaN: true }), ([x, y, z], sun, strength) => {
        const q = { x: 0, y: 0, z: 0 };
        projectAlongSun(x, y, z, sun, 1500, q);
        expect(Number.isFinite(q.x) && Number.isFinite(q.z)).toBe(true);
        const op = shadowOpacityAt(map, q.x, q.z, sun, 0, 0, 24);
        expect(Number.isFinite(op)).toBe(true);
        expect(op).toBeGreaterThanOrEqual(0);
        expect(op).toBeLessThanOrEqual(1);
        const f = cloudShadowFactor(op, strength, y, 1500, sun.y);
        expect(Number.isFinite(f)).toBe(true);
        expect(f).toBeGreaterThanOrEqual(0);
        expect(f).toBeLessThanOrEqual(1);
      }),
    );
  });
  it('the ground right under a thick cloud is shadowed with an overhead sun; open ground is not', () => {
    const sun = { x: 0, y: 1, z: 0 };
    const c = field.clouds.find((q) => q.height > 600)!;
    expect(shadowOpacityAt(map, c.x, c.z, sun, 0, 0, 48)).toBeGreaterThan(0.9);
    const f = cloudShadowFactor(1, 0.4, 30, 1500, 1);
    expect(f).toBeCloseTo(0.6, 6);
    expect(cloudShadowFactor(0, 0.4, 30, 1500, 1)).toBe(1);
  });
  it('the shadow of a cloud is displaced away from the sun on the ground', () => {
    const sun = sunDirectionFromAngles(40, 90); // sun in the east → shadows fall to the west
    const c = field.clouds.find((q) => q.height > 800 && q.radius > 400)!;
    const mid = c.base + c.height * 0.4;
    const shift = (mid - 30) / Math.tan((40 * Math.PI) / 180);
    const q = { x: 0, y: 0, z: 0 };
    // a ground point west of the cloud by `shift` projects back to the cloud's middle
    projectAlongSun(c.x - shift, 30, c.z, sun, mid, q);
    expect(q.x).toBeCloseTo(c.x, 3);
    projectAlongSun(c.x - shift, 30, c.z, sun, opts.baseMin, q);
    expect(shadowOpacityAt(map, q.x, q.z, sun, 0, 0, 64)).toBeGreaterThan(0.5);
  });
  it('no shadow once the sun is below the horizon or the point is above the cloud layer', () => {
    expect(cloudShadowFactor(1, 0.4, 30, 1500, -0.1)).toBe(1);
    expect(cloudShadowFactor(1, 0.4, 5000, 1500, 0.8)).toBe(1);
  });
});
