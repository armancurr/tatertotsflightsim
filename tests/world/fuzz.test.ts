/**
 * Property / fuzz tests (fast-check) for the pure world: random points anywhere
 * in ±100 km (and some far beyond), random tiles, random polylines, random cameras.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createSimplex2D, fbm, ridged, erodedFbm, slopeLimitedFbm } from '../../src/world/noise';
import { terrainHeight, terrainNormal, getHeightfield } from '../../src/world/heightfield';
import { landcoverAt, surfaceAt, treeDensity, LANDCOVER_KEYS, getLandcover } from '../../src/world/landcover';
import { getLayout, lakeSignedDistance } from '../../src/world/layout';
import { createEnvironment } from '../../src/world/environment';
import { PolylineIndex, newPolyQuery } from '../../src/world/polyline';
import { selectTiles, lodParamsFromConfig } from '../../src/world/terrain/quadtree';
import { buildChunk, chunkVertexCount } from '../../src/world/terrain/chunk';
import { CONFIG } from '../../src/config';
import type { SurfaceType } from '../../src/types';

const L = getLayout();
const hf = getHeightfield();
const env = createEnvironment();
const ELEV = CONFIG.world.airport.elevation;
const SURFACES: SurfaceType[] = ['runway', 'asphalt', 'grass', 'dirt', 'field', 'forest', 'rock', 'snow', 'sand', 'urban', 'water'];

const coord = fc.double({ min: -100000, max: 100000, noNaN: true, noDefaultInfinity: true });
const point = fc.tuple(coord, coord);
const farCoord = fc.double({ min: -5e6, max: 5e6, noNaN: true, noDefaultInfinity: true });
const RUNS = { numRuns: 400 };

describe('fuzz: noise', () => {
  const n = createSimplex2D(99);
  it('simplex, fbm, ridged, eroded fbm stay finite and in range for any input', () => {
    fc.assert(
      fc.property(farCoord, farCoord, (x, y) => {
        const v = n(x, y);
        expect(Number.isFinite(v)).toBe(true);
        expect(Math.abs(v)).toBeLessThanOrEqual(1);
        expect(Math.abs(fbm(n, x, y, 5))).toBeLessThanOrEqual(1);
        const r = ridged(n, x, y, 5);
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThanOrEqual(1);
        expect(Math.abs(erodedFbm(n, x, y, 5))).toBeLessThanOrEqual(1);
        expect(Number.isFinite(slopeLimitedFbm(n, x, y, 100, 1000, 6))).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });
});

describe('fuzz: heightfield', () => {
  it('terrainHeight and terrainNormal are finite, deterministic and sane anywhere in ±100 km', () => {
    fc.assert(
      fc.property(point, ([x, z]) => {
        const h = terrainHeight(x, z);
        expect(Number.isFinite(h)).toBe(true);
        expect(terrainHeight(x, z)).toBe(h);
        expect(h).toBeGreaterThan(-400);
        expect(h).toBeLessThan(3300);
        const nrm = terrainNormal(x, z);
        expect(Math.hypot(nrm.x, nrm.y, nrm.z)).toBeCloseTo(1, 9);
        expect(nrm.y).toBeGreaterThan(0.2);
        expect(terrainNormal(x, z)).toEqual(nrm);
      }),
      RUNS,
    );
  });
  it('is finite far beyond the designed map', () => {
    fc.assert(
      fc.property(farCoord, farCoord, (x, z) => {
        const h = terrainHeight(x, z);
        expect(Number.isFinite(h)).toBe(true);
        expect(h).toBeGreaterThan(-400);
        expect(h).toBeLessThan(3500);
      }),
      { numRuns: 300 },
    );
  });
  it('is locally continuous: a 5 cm step never jumps more than 12 cm (away from carved banks)', () => {
    fc.assert(
      fc.property(point, fc.double({ min: 0, max: Math.PI * 2, noNaN: true }), ([x, z], a) => {
        if (hf.nearCarvedBank(x, z)) return;
        const d = Math.abs(terrainHeight(x + 0.05 * Math.cos(a), z + 0.05 * Math.sin(a)) - terrainHeight(x, z));
        expect(d).toBeLessThan(0.12);
      }),
      { numRuns: 1500 },
    );
  });
  it('keeps every paved airport surface exactly at the field elevation', () => {
    const rectPoint = fc.tuple(fc.integer({ min: 0, max: L.airport.pavedAreas.length - 1 }), fc.double({ min: -1, max: 1, noNaN: true }), fc.double({ min: -1, max: 1, noNaN: true }));
    fc.assert(
      fc.property(rectPoint, ([i, a, b]) => {
        const r = L.airport.pavedAreas[i];
        const h = (r.headingDeg * Math.PI) / 180;
        const x = r.center.x + Math.sin(h) * r.halfLength * a + Math.cos(h) * r.halfWidth * b;
        const z = r.center.z - Math.cos(h) * r.halfLength * a + Math.sin(h) * r.halfWidth * b;
        expect(terrainHeight(x, z)).toBe(ELEV);
        expect(terrainNormal(x, z).y).toBeCloseTo(1, 9);
        expect(['runway', 'asphalt']).toContain(surfaceAt(x, z));
      }),
      { numRuns: 1000 },
    );
  });
});

describe('fuzz: landcover, surfaces, water, trees', () => {
  it('landcover weights are each in [0,1] and sum to 1', () => {
    fc.assert(
      fc.property(point, ([x, z]) => {
        const w = landcoverAt(x, z);
        let s = 0;
        for (const k of LANDCOVER_KEYS) {
          expect(w[k]).toBeGreaterThanOrEqual(0);
          expect(w[k]).toBeLessThanOrEqual(1);
          s += w[k];
        }
        expect(s).toBeCloseTo(1, 9);
      }),
      RUNS,
    );
  });
  it('surfaceAt is a valid, deterministic surface type', () => {
    fc.assert(
      fc.property(point, ([x, z]) => {
        const s = surfaceAt(x, z);
        expect(SURFACES).toContain(s);
        expect(surfaceAt(x, z)).toBe(s);
      }),
      RUNS,
    );
  });
  it('waterLevel is consistent with surfaceAt water and with the terrain', () => {
    // bias half the samples to the coast, the lakes and the river where water is interesting
    const river = L.rivers[0];
    const near = fc.oneof(
      point,
      fc.tuple(fc.double({ min: -30000, max: 30000, noNaN: true }), fc.double({ min: -600, max: 600, noNaN: true })).map(([x, dz]) => [x, L.coast.zAt(x) + dz] as [number, number]),
      fc.tuple(fc.integer({ min: 0, max: river.points.length - 1 }), fc.double({ min: -80, max: 80, noNaN: true }), fc.double({ min: -80, max: 80, noNaN: true })).map(
        ([i, dx, dz]) => [river.points[i].x + dx, river.points[i].z + dz] as [number, number],
      ),
      fc.tuple(fc.integer({ min: 0, max: L.lakes.length - 1 }), fc.double({ min: -1.3, max: 1.3, noNaN: true }), fc.double({ min: -1.3, max: 1.3, noNaN: true })).map(
        ([i, a, b]) => [L.lakes[i].center.x + a * L.lakes[i].radiusX, L.lakes[i].center.z + b * L.lakes[i].radiusZ] as [number, number],
      ),
    );
    fc.assert(
      fc.property(near, ([x, z]) => {
        const wl = env.waterLevel(x, z);
        const h = env.groundHeight(x, z);
        const s = env.surfaceAt(x, z);
        if (s === 'water') {
          expect(wl).not.toBeNull();
          expect(h).toBeLessThan(wl as number);
        }
        if (wl !== null) {
          expect(h).toBeLessThan(wl);
          // only a bridge deck (road over the river) or pavement can be dry over water
          if (s !== 'water') expect(['asphalt', 'runway']).toContain(s);
          if (wl > 0) {
            const inLake = L.lakes.some((lk) => lk.level === wl && lakeSignedDistance(lk, x, z) < 60);
            const nearRiver = river.points.some((p) => Math.hypot(p.x - x, p.z - z) < 140);
            expect(inLake || nearRiver).toBe(true);
          }
        } else {
          expect(h).toBeGreaterThanOrEqual(0);
        }
      }),
      { numRuns: 800 },
    );
  });
  it('treeDensity is in [0,1] and zero wherever the surface is water, pavement or a road', () => {
    fc.assert(
      fc.property(point, ([x, z]) => {
        const d = treeDensity(x, z);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(1);
        const s = surfaceAt(x, z);
        if (s === 'water' || s === 'runway' || s === 'asphalt') expect(d).toBe(0);
        if (getLandcover().isPaved(x, z)) expect(d).toBe(0);
      }),
      RUNS,
    );
  });
});

describe('fuzz: spatial structures', () => {
  it('polyline index distance matches brute force for random polylines', () => {
    const pts = fc.array(fc.tuple(fc.double({ min: -500, max: 500, noNaN: true }), fc.double({ min: -500, max: 500, noNaN: true })), { minLength: 2, maxLength: 12 });
    fc.assert(
      fc.property(pts, fc.double({ min: -700, max: 700, noNaN: true }), fc.double({ min: -700, max: 700, noNaN: true }), (raw, qx, qz) => {
        const line = raw.map(([x, z]) => ({ x, z }));
        const idx = new PolylineIndex([line], [line.map((_, i) => [i])], 1, 200, 64);
        const q = newPolyQuery(1);
        let best = Infinity;
        for (let i = 1; i < line.length; i++) {
          const a = line[i - 1];
          const b = line[i];
          const vx = b.x - a.x;
          const vz = b.z - a.z;
          const l2 = vx * vx + vz * vz;
          const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((qx - a.x) * vx + (qz - a.z) * vz) / l2)) : 0;
          best = Math.min(best, Math.hypot(qx - a.x - vx * t, qz - a.z - vz * t));
        }
        const found = idx.query(qx, qz, q);
        if (best < 199.999) {
          expect(found).toBe(true);
          expect(q.d).toBeCloseTo(best, 6);
          expect(q.v[0]).toBeGreaterThanOrEqual(-1e-9);
          expect(q.v[0]).toBeLessThanOrEqual(line.length - 1 + 1e-9);
        } else if (best > 200.001) expect(found).toBe(false);
      }),
      { numRuns: 500 },
    );
  });
  it('LOD selection never overlaps, always covers the camera, and stays bounded', () => {
    const P = lodParamsFromConfig(CONFIG);
    const cam = fc.record({ x: fc.double({ min: -3e5, max: 3e5, noNaN: true }), y: fc.double({ min: -50, max: 9000, noNaN: true }), z: fc.double({ min: -3e5, max: 3e5, noNaN: true }) });
    fc.assert(
      fc.property(cam, (c) => {
        const tiles = selectTiles(c, P, () => ({ min: 0, max: 100 }));
        expect(tiles.length).toBeGreaterThan(0);
        expect(tiles.length).toBeLessThan(420);
        const under = tiles.filter((t) => c.x >= t.x0 && c.x < t.x0 + t.size && c.z >= t.z0 && c.z < t.z0 + t.size);
        expect(under.length).toBe(1);
        const sorted = [...tiles].sort((a, b) => a.x0 - b.x0);
        for (let i = 0; i < sorted.length; i++)
          for (let j = i + 1; j < sorted.length && sorted[j].x0 < sorted[i].x0 + sorted[i].size; j++) {
            const a = sorted[i];
            const b = sorted[j];
            const ov = a.z0 < b.z0 + b.size && b.z0 < a.z0 + a.size;
            expect(ov).toBe(false);
          }
      }),
      { numRuns: 60 },
    );
  });
  it('chunks built anywhere have finite data and landcover weights that sum to 1', () => {
    const lc = getLandcover();
    const req = fc.record({
      x0: fc.integer({ min: -400, max: 400 }).map((i) => i * 256),
      z0: fc.integer({ min: -400, max: 400 }).map((i) => i * 256),
      size: fc.constantFrom(256, 1024, 4096, 16384),
    });
    fc.assert(
      fc.property(req, (r) => {
        const res = 8;
        const c = buildChunk(hf, lc, { ...r, res });
        const nv = chunkVertexCount(res);
        for (let v = 0; v < nv; v++) {
          expect(Number.isFinite(c.positions[v * 3 + 1])).toBe(true);
          expect(Number.isFinite(c.morph[v * 3])).toBe(true);
          let s = 0;
          for (let k = 0; k < 4; k++) s += c.lc0[v * 4 + k] + c.lc1[v * 4 + k];
          expect(Math.abs(s - 255)).toBeLessThanOrEqual(6);
        }
        expect(c.minY).toBeLessThan(c.maxY + 1e-9);
      }),
      { numRuns: 40 },
    );
  });
});
