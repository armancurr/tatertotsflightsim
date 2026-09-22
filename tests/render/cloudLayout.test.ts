import { describe, it, expect } from 'vitest';
import {
  generateCloudField,
  wrapCoord,
  computePuffSunOcclusion,
  cloudDensityAt,
  PUFF_STRIDE,
  P_DX,
  P_Y,
  P_DZ,
  P_R,
  P_HFRAC,
  P_OCC,
  type CloudLayoutOptions,
} from '../../src/render/cloudLayout';

const opts: CloudLayoutOptions = { seed: 17221, count: 220, coverage: 0.42, baseAltitude: 1500, thickness: 900, areaRadius: 38000 };

describe('cloud field generation', () => {
  const f = generateCloudField(opts);

  it('is deterministic for a seed and differs between seeds', () => {
    const g = generateCloudField(opts);
    expect(Array.from(g.puffs.subarray(0, 400))).toEqual(Array.from(f.puffs.subarray(0, 400)));
    const h = generateCloudField({ ...opts, seed: 99 });
    expect(h.clouds[0].x).not.toBe(f.clouds[0].x);
  });

  it('places the configured number of clouds inside the wrap tile around the origin', () => {
    expect(f.clouds.length).toBe(220);
    expect(f.tile).toBe(2 * opts.areaRadius);
    for (const c of f.clouds) {
      expect(Math.abs(c.x)).toBeLessThanOrEqual(opts.areaRadius);
      expect(Math.abs(c.z)).toBeLessThanOrEqual(opts.areaRadius);
    }
  });

  it('builds each cloud from several puffs with a flat base at the base altitude and a limited top', () => {
    expect(f.puffCount).toBeGreaterThanOrEqual(220 * 10);
    for (const c of f.clouds) {
      expect(c.puffCount).toBeGreaterThanOrEqual(10);
      expect(c.base).toBeGreaterThanOrEqual(opts.baseAltitude - 100);
      expect(c.base).toBeLessThanOrEqual(opts.baseAltitude + 150);
      expect(c.height).toBeLessThanOrEqual(opts.thickness + 1e-9);
      let lowest = Infinity;
      for (let i = c.firstPuff; i < c.firstPuff + c.puffCount; i++) {
        const o = i * PUFF_STRIDE;
        const y = f.puffs[o + P_Y];
        const r = f.puffs[o + P_R];
        expect(y + r * 0.6).toBeLessThanOrEqual(c.base + c.height + 1);
        expect(Math.hypot(f.puffs[o + P_DX], f.puffs[o + P_DZ])).toBeLessThanOrEqual(c.radius + 1e-6);
        expect(f.puffs[o + P_HFRAC]).toBeGreaterThanOrEqual(0);
        expect(f.puffs[o + P_HFRAC]).toBeLessThanOrEqual(1);
        lowest = Math.min(lowest, y - r * 0.6);
      }
      expect(Math.abs(lowest - c.base)).toBeLessThan(40);
    }
  });

  it('has no big holes: from any point of the tile a cloud is within 7 km (the airport is at the origin)', () => {
    for (let x = -36000; x <= 36000; x += 6000) {
      for (let z = -36000; z <= 36000; z += 6000) {
        let best = Infinity;
        for (const c of f.clouds) {
          const dx = ((c.x - x + 3 * f.tile / 2) % f.tile) - f.tile / 2;
          const dz = ((c.z - z + 3 * f.tile / 2) % f.tile) - f.tile / 2;
          best = Math.min(best, Math.hypot(dx, dz));
        }
        expect(best, `hole at ${x},${z}`).toBeLessThan(7000);
      }
    }
  });

  it('coverage 0 means clear sky; more coverage means bigger clouds', () => {
    expect(generateCloudField({ ...opts, coverage: 0 }).clouds.length).toBe(0);
    const avg = (cov: number) => {
      const g = generateCloudField({ ...opts, coverage: cov });
      return g.clouds.reduce((s, c) => s + c.radius, 0) / g.clouds.length;
    };
    expect(avg(0.9)).toBeGreaterThan(avg(0.25));
  });

  it('lifts clouds that would sit in the terrain', () => {
    const ground = (x: number, z: number) => (x > 0 ? 2300 : 0);
    const g = generateCloudField({ ...opts, groundHeight: ground, minClearance: 250 });
    for (const c of g.clouds) {
      if (c.x - c.radius > 0) expect(c.base).toBeGreaterThanOrEqual(2300 + 250);
      if (c.x + c.radius < 0) expect(c.base).toBeLessThan(1700);
    }
  });
});

describe('wrapCoord (clouds re-centre around the camera)', () => {
  it('returns the equivalent coordinate within half a tile of the centre', () => {
    const tile = 76000;
    for (const [v, c] of [[0, 0], [37000, -37000], [-50000, 120000], [12345, 987654]]) {
      const w = wrapCoord(v, c, tile);
      expect(w).toBeGreaterThanOrEqual(c - tile / 2);
      expect(w).toBeLessThan(c + tile / 2);
      const k = (w - v) / tile;
      expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-9);
    }
  });
});

describe('puff lighting and immersion', () => {
  const f = generateCloudField(opts);
  it('puffs low in a cloud are more shadowed than its top puffs when the sun is high', () => {
    computePuffSunOcclusion(f, { x: 0, y: 1, z: 0 });
    let lowSum = 0, lowN = 0, highSum = 0, highN = 0;
    for (let i = 0; i < f.puffCount; i++) {
      const o = i * PUFF_STRIDE;
      const occ = f.puffs[o + P_OCC];
      expect(occ).toBeGreaterThanOrEqual(0);
      expect(occ).toBeLessThanOrEqual(1);
      if (f.puffs[o + P_HFRAC] < 0.3) { lowSum += occ; lowN++; }
      if (f.puffs[o + P_HFRAC] > 0.7) { highSum += occ; highN++; }
    }
    expect(lowSum / lowN).toBeGreaterThan(highSum / highN + 0.1);
  });
  it('density is high inside a cloud and zero far above it, including across the wrap seam', () => {
    const c = f.clouds[0];
    const o = c.firstPuff * PUFF_STRIDE;
    const px = c.x + f.puffs[o + P_DX];
    const pz = c.z + f.puffs[o + P_DZ];
    const py = f.puffs[o + P_Y];
    expect(cloudDensityAt(f, px, py, pz, px, pz)).toBeGreaterThan(0.5);
    expect(cloudDensityAt(f, px, py + 5000, pz, px, pz)).toBe(0);
    // the same cloud seen from one tile to the east
    const cam = px + f.tile;
    expect(cloudDensityAt(f, px + f.tile, py, pz, cam, pz)).toBeGreaterThan(0.5);
  });
});
