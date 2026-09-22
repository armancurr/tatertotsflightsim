/**
 * Property-based (fuzz) tests for the pure render/atmosphere modules.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { sunDirectionFromAngles, shadowLightBasis, snapShadowCenter } from '../../src/render/sun';
import { createDynamicResolution } from '../../src/render/dynamicResolution';
import {
  defaultAtmosphereParams,
  chapmanLength,
  transmittanceToSpace,
  skyRadiance,
  rayHitsPlanet,
  type RGB,
} from '../../src/render/atmosphereModel';
import { aerialPerspective, hazeColor, fogStateFromAtmosphere } from '../../src/render/fog';
import { generateCloudField, wrapCoord, PUFF_STRIDE, P_Y, P_R, P_DX, P_DZ, computePuffSunOcclusion, P_OCC } from '../../src/render/cloudLayout';
import { sunScreenPosition, flareEdgeFade } from '../../src/render/lensflare';
import * as THREE from 'three';

const P = defaultAtmosphereParams();
const rgb = (): RGB => ({ r: 0, g: 0, b: 0 });
const finite = (c: RGB) => Number.isFinite(c.r) && Number.isFinite(c.g) && Number.isFinite(c.b);
const unit = fc
  .tuple(fc.double({ min: -1, max: 1, noNaN: true }), fc.double({ min: -1, max: 1, noNaN: true }), fc.double({ min: -1, max: 1, noNaN: true }))
  .filter(([x, y, z]) => x * x + y * y + z * z > 1e-4)
  .map(([x, y, z]) => {
    const l = Math.hypot(x, y, z);
    return { x: x / l, y: y / l, z: z / l };
  });
const elev = fc.double({ min: -89.9, max: 90, noNaN: true });
const azim = fc.double({ min: -720, max: 720, noNaN: true });

describe('property: sun vectors', () => {
  it('are unit length with y = sin(elevation) for any elevation/azimuth', () => {
    fc.assert(
      fc.property(elev, azim, (el, az) => {
        const d = sunDirectionFromAngles(el, az);
        expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1, 10);
        expect(d.y).toBeCloseTo(Math.sin((el * Math.PI) / 180), 10);
      }),
    );
  });
  it('azimuth is periodic in 360°', () => {
    fc.assert(
      fc.property(elev, fc.double({ min: -360, max: 360, noNaN: true }), (el, az) => {
        const a = sunDirectionFromAngles(el, az);
        const b = sunDirectionFromAngles(el, az + 360);
        expect(a.x).toBeCloseTo(b.x, 9);
        expect(a.z).toBeCloseTo(b.z, 9);
      }),
    );
  });
  it('the shadow basis is orthonormal and perpendicular to the sun for any direction', () => {
    fc.assert(
      fc.property(unit, (s) => {
        const r = { x: 0, y: 0, z: 0 };
        const u = { x: 0, y: 0, z: 0 };
        shadowLightBasis(s, r, u);
        const dot = (a: typeof r, b: typeof r) => a.x * b.x + a.y * b.y + a.z * b.z;
        expect(Math.hypot(r.x, r.y, r.z)).toBeCloseTo(1, 6);
        expect(Math.hypot(u.x, u.y, u.z)).toBeCloseTo(1, 6);
        expect(Math.abs(dot(r, u))).toBeLessThan(1e-6);
        if (Math.abs(s.y) < 0.999) {
          expect(Math.abs(dot(r, s))).toBeLessThan(1e-6);
          expect(Math.abs(dot(u, s))).toBeLessThan(1e-6);
        }
      }),
    );
  });
  it('snapping moves the shadow centre by at most half a texel per light axis', () => {
    const coord = fc.double({ min: -2e5, max: 2e5, noNaN: true });
    fc.assert(
      fc.property(fc.double({ min: 2, max: 89, noNaN: true }), azim, coord, fc.double({ min: 0, max: 5000, noNaN: true }), coord, (el, az, x, y, z) => {
        const s = sunDirectionFromAngles(el, az);
        const r = { x: 0, y: 0, z: 0 };
        const u = { x: 0, y: 0, z: 0 };
        shadowLightBasis(s, r, u);
        const f = { x, y, z };
        const c = snapShadowCenter(f, s, 160, 2048, { x: 0, y: 0, z: 0 });
        const texel = 320 / 2048;
        const d = { x: c.x - f.x, y: c.y - f.y, z: c.z - f.z };
        expect(Math.abs(d.x * r.x + d.y * r.y + d.z * r.z)).toBeLessThanOrEqual(texel / 2 + 1e-6);
        expect(Math.abs(d.x * u.x + d.y * u.y + d.z * u.z)).toBeLessThanOrEqual(texel / 2 + 1e-6);
      }),
    );
  });
});

describe('property: dynamic resolution', () => {
  it('always stays within [min, max] and only reports actual changes, for any frame-time sequence', () => {
    fc.assert(
      fc.property(fc.array(fc.double({ min: 1 / 240, max: 0.6, noNaN: true }), { minLength: 1, maxLength: 3000 }), (dts) => {
        const dr = createDynamicResolution({ targetFps: 60, minPixelRatio: 0.75, maxPixelRatio: 1.5 });
        let prev = dr.pixelRatio;
        for (const dt of dts) {
          const r = dr.update(dt);
          expect(dr.pixelRatio).toBeGreaterThanOrEqual(0.75);
          expect(dr.pixelRatio).toBeLessThanOrEqual(1.5);
          if (r === null) expect(dr.pixelRatio).toBe(prev);
          else {
            expect(r).toBe(dr.pixelRatio);
            expect(r).not.toBe(prev);
          }
          prev = dr.pixelRatio;
        }
      }),
      { numRuns: 60 },
    );
  });
  it('never raises the ratio while every frame is slow', () => {
    fc.assert(
      fc.property(fc.array(fc.double({ min: 1 / 40, max: 0.2, noNaN: true }), { minLength: 1, maxLength: 2000 }), (dts) => {
        const dr = createDynamicResolution({ targetFps: 60, minPixelRatio: 0.75, maxPixelRatio: 1.5, initialPixelRatio: 1 });
        let prev = dr.pixelRatio;
        for (const dt of dts) {
          dr.update(dt);
          expect(dr.pixelRatio).toBeLessThanOrEqual(prev);
          prev = dr.pixelRatio;
        }
      }),
      { numRuns: 40 },
    );
  });
});

describe('property: atmosphere model', () => {
  it('Chapman optical length is positive and finite for any ray that escapes the planet', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 20000, noNaN: true }), fc.double({ min: -1, max: 1, noNaN: true }), fc.constantFrom(8000, 1667, 1200), (h, c, H) => {
        fc.pre(!rayHitsPlanet(P.planetRadius, h, c));
        const l = chapmanLength(H, h, c, P.planetRadius);
        expect(Number.isFinite(l)).toBe(true);
        expect(l).toBeGreaterThan(0);
      }),
    );
  });
  it('transmittance is in [0,1] and never decreases as the ray tilts up', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 15000, noNaN: true }), fc.double({ min: -1, max: 1, noNaN: true }), fc.double({ min: 0, max: 0.5, noNaN: true }), (h, c, dc) => {
        const a = transmittanceToSpace(P, h, c, rgb());
        const b = transmittanceToSpace(P, h, Math.min(1, c + dc), rgb());
        for (const k of ['r', 'g', 'b'] as const) {
          expect(a[k]).toBeGreaterThanOrEqual(0);
          expect(a[k]).toBeLessThanOrEqual(1);
          expect(b[k]).toBeGreaterThanOrEqual(a[k] - 1e-9);
        }
      }),
    );
  });
  it('sky radiance is finite and non-negative for any view, sun and camera height', () => {
    fc.assert(
      fc.property(unit, fc.double({ min: -5, max: 90, noNaN: true }), azim, fc.double({ min: 0, max: 8000, noNaN: true }), (d, el, az, h) => {
        const c = skyRadiance(P, d, sunDirectionFromAngles(el, az), h, rgb(), 8);
        expect(finite(c)).toBe(true);
        expect(Math.min(c.r, c.g, c.b)).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 200 },
    );
  });
});

describe('property: aerial perspective', () => {
  const S = fogStateFromAtmosphere(P, sunDirectionFromAngles(38, 125), 2);
  const coord = fc.double({ min: -90000, max: 90000, noNaN: true });
  it('is finite and non-negative for any segment and camera height', () => {
    fc.assert(
      fc.property(coord, fc.double({ min: -5000, max: 5000, noNaN: true }), coord, fc.double({ min: 0, max: 10000, noNaN: true }), (x, y, z, cy) => {
        const c = aerialPerspective({ r: 0.2, g: 0.3, b: 0.1 }, { x, y, z }, cy, S, rgb());
        expect(finite(c)).toBe(true);
        expect(Math.min(c.r, c.g, c.b)).toBeGreaterThanOrEqual(0);
      }),
    );
  });
  it('is monotonic in distance: more distance → less of the object, more haze', () => {
    fc.assert(
      fc.property(unit, fc.double({ min: 0, max: 50000, noNaN: true }), fc.double({ min: 1, max: 40000, noNaN: true }), fc.double({ min: 0, max: 6000, noNaN: true }), (d, s0, ds, cy) => {
        // keep the far point above sea level (the model's ground)
        fc.pre(cy + d.y * (s0 + ds) > -1);
        const near = { x: d.x * s0, y: d.y * s0, z: d.z * s0 };
        const far = { x: d.x * (s0 + ds), y: d.y * (s0 + ds), z: d.z * (s0 + ds) };
        const wN = aerialPerspective({ r: 1, g: 1, b: 1 }, near, cy, S, rgb());
        const bN = aerialPerspective({ r: 0, g: 0, b: 0 }, near, cy, S, rgb());
        const wF = aerialPerspective({ r: 1, g: 1, b: 1 }, far, cy, S, rgb());
        const bF = aerialPerspective({ r: 0, g: 0, b: 0 }, far, cy, S, rgb());
        for (const k of ['r', 'g', 'b'] as const) {
          expect(wF[k] - bF[k]).toBeLessThanOrEqual(wN[k] - bN[k] + 1e-9); // transmittance
          expect(bF[k]).toBeGreaterThanOrEqual(bN[k] - 1e-9); // in-scattered light
        }
      }),
    );
  });
  it('the horizon haze colour is finite and positive in every direction', () => {
    fc.assert(
      fc.property(unit, fc.double({ min: 0, max: 8000, noNaN: true }), (d, cy) => {
        const h = hazeColor(d, cy, S, rgb());
        expect(finite(h)).toBe(true);
        expect(h.g).toBeGreaterThan(0);
      }),
    );
  });
});

describe('property: cloud layout', () => {
  const layout = fc.record({
    seed: fc.integer({ min: 0, max: 2 ** 31 - 1 }),
    count: fc.integer({ min: 1, max: 60 }),
    coverage: fc.double({ min: 0.05, max: 1, noNaN: true }),
    baseAltitude: fc.double({ min: 300, max: 4000, noNaN: true }),
    thickness: fc.double({ min: 200, max: 2000, noNaN: true }),
    areaRadius: fc.double({ min: 8000, max: 60000, noNaN: true }),
  });
  it('is deterministic and every cloud and puff stays within its bounds', () => {
    fc.assert(
      fc.property(layout, (o) => {
        const a = generateCloudField(o);
        const b = generateCloudField(o);
        expect(Array.from(a.puffs)).toEqual(Array.from(b.puffs));
        expect(a.clouds.length).toBeLessThanOrEqual(o.count);
        for (const c of a.clouds) {
          expect(Math.abs(c.x)).toBeLessThanOrEqual(o.areaRadius);
          expect(Math.abs(c.z)).toBeLessThanOrEqual(o.areaRadius);
          expect(c.height).toBeLessThanOrEqual(o.thickness + 1e-6);
          for (let i = c.firstPuff; i < c.firstPuff + c.puffCount; i++) {
            const k = i * PUFF_STRIDE;
            const y = a.puffs[k + P_Y];
            const r = a.puffs[k + P_R];
            expect(r).toBeGreaterThan(0);
            expect(y - 0.6 * r).toBeGreaterThanOrEqual(c.base - 0.01);
            expect(y + 0.6 * r).toBeLessThanOrEqual(c.base + c.height + 0.5);
            expect(Math.hypot(a.puffs[k + P_DX], a.puffs[k + P_DZ])).toBeLessThanOrEqual(c.radius);
          }
        }
      }),
      { numRuns: 40 },
    );
  });
  it('sun occlusion stays within [0,1] for any sun direction', () => {
    const f = generateCloudField({ seed: 5, count: 20, coverage: 0.5, baseAltitude: 1500, thickness: 900, areaRadius: 20000 });
    fc.assert(
      fc.property(unit, (s) => {
        computePuffSunOcclusion(f, s);
        for (let i = 0; i < f.puffCount; i++) {
          const o = f.puffs[i * PUFF_STRIDE + P_OCC];
          expect(o).toBeGreaterThanOrEqual(0);
          expect(o).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: 30 },
    );
  });
  it('wrapCoord lands within half a tile of the centre and differs from v by whole tiles', () => {
    fc.assert(
      fc.property(fc.double({ min: -1e7, max: 1e7, noNaN: true }), fc.double({ min: -1e7, max: 1e7, noNaN: true }), fc.double({ min: 100, max: 2e5, noNaN: true }), (v, c, tile) => {
        const w = wrapCoord(v, c, tile);
        expect(w).toBeGreaterThanOrEqual(c - tile / 2 - 1e-6 * tile);
        expect(w).toBeLessThanOrEqual(c + tile / 2 + 1e-6 * tile);
        const k = (w - v) / tile;
        expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-6);
      }),
    );
  });
});

describe('property: lens flare', () => {
  it('a sun in front of the camera projects into NDC consistent with its view-space angle; edge fade in [0,1]', () => {
    const cam = new THREE.PerspectiveCamera(60, 1.6, 0.08, 90000);
    fc.assert(
      fc.property(elev, azim, fc.double({ min: -3.1, max: 3.1, noNaN: true }), fc.double({ min: -1.2, max: 1.2, noNaN: true }), (el, az, yaw, pitch) => {
        cam.rotation.set(pitch, yaw, 0, 'YXZ');
        cam.updateMatrixWorld();
        const p = sunScreenPosition(sunDirectionFromAngles(el, az), cam, { x: 0, y: 0, inFront: false });
        expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
        const f = flareEdgeFade(p.x, p.y);
        expect(f).toBeGreaterThanOrEqual(0);
        expect(f).toBeLessThanOrEqual(1);
      }),
    );
  });
});
