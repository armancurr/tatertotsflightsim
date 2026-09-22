import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { selectLod, boxCount, groupByChunk, chunkBounds, distanceToBox, LOD_NEAR, LOD_BOX, LOD_HIDDEN } from '../../../src/world/towns/lod';
import { placeBuildings, roofTopAt, buildingRect } from '../../../src/world/towns/placement';
import { getRoadNetwork } from '../../../src/world/roads/network';
import { rectCorners } from '../../../src/world/towns/geom';
import { CONFIG } from '../../../src/config';
import { LAYOUT, HEIGHT } from './fixtures';

const cfg = CONFIG.world.towns;

describe('LOD selection', () => {
  it('detailed near, boxes in the middle distance, hidden far', () => {
    expect(selectLod(100, LOD_NEAR, cfg)).toBe(LOD_NEAR);
    expect(selectLod(cfg.nearDistance * 1.5, LOD_NEAR, cfg)).toBe(LOD_BOX);
    expect(selectLod(cfg.farDistance * 1.2, LOD_BOX, cfg)).toBe(LOD_HIDDEN);
  });
  it('has hysteresis around the near/box switch', () => {
    const d = cfg.nearDistance;
    expect(selectLod(d * 1.01, LOD_NEAR, cfg)).toBe(LOD_NEAR);
    expect(selectLod(d * 0.99, LOD_BOX, cfg)).toBe(LOD_BOX);
    expect(selectLod(d * (1 + cfg.hysteresis * 1.1), LOD_NEAR, cfg)).toBe(LOD_BOX);
    expect(selectLod(d * (1 - cfg.hysteresis * 1.1), LOD_BOX, cfg)).toBe(LOD_NEAR);
  });
  it('is monotonic in distance from a fixed previous state (fuzz)', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 50000, noNaN: true }), fc.double({ min: 0, max: 50000, noNaN: true }), fc.constantFrom(LOD_NEAR, LOD_BOX, LOD_HIDDEN), (a, b, prev) => {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        expect(selectLod(lo, prev, cfg)).toBeLessThanOrEqual(selectLod(hi, prev, cfg));
      }),
    );
  });
  it('boxCount draws the largest buildings first and fewer with distance (fuzz)', () => {
    fc.assert(
      fc.property(fc.array(fc.double({ min: 1, max: 150, noNaN: true }), { minLength: 0, maxLength: 200 }), fc.double({ min: 0, max: 30000, noNaN: true }), fc.double({ min: 0, max: 30000, noNaN: true }), (sizes, d1, d2) => {
        const sorted = Float32Array.from(sizes.sort((a, b) => b - a));
        const [near, far] = d1 < d2 ? [d1, d2] : [d2, d1];
        const cn = boxCount(sorted, near, cfg);
        const cf = boxCount(sorted, far, cfg);
        expect(cf).toBeLessThanOrEqual(cn);
        // exactly the ones at least as large as the threshold
        const thr = (d: number) => Math.max(d * cfg.minAngularSize, d > cfg.midDistance ? 25 : 0);
        expect(cn).toBe(Array.from(sorted).filter((s) => s >= thr(near)).length);
      }),
    );
  });
});

describe('chunks', () => {
  const B = placeBuildings(LAYOUT, getRoadNetwork(LAYOUT, HEIGHT), HEIGHT);
  const chunks = groupByChunk(B, cfg.chunkSize);
  it('puts every building in exactly one chunk, the one holding its centre', () => {
    let n = 0;
    for (const c of chunks) {
      n += c.indices.length;
      for (const i of c.indices) {
        expect(Math.floor(B[i].x / cfg.chunkSize)).toBe(c.i);
        expect(Math.floor(B[i].z / cfg.chunkSize)).toBe(c.j);
      }
    }
    expect(n).toBe(B.length);
  });
  it('chunk bounds contain every footprint corner and roof top of its buildings', () => {
    for (const c of chunks) {
      const bb = chunkBounds(B, c.indices);
      for (const i of c.indices) {
        const b = B[i];
        for (const p of rectCorners(buildingRect(b))) {
          expect(p.x).toBeGreaterThanOrEqual(bb.min.x - 1e-6);
          expect(p.x).toBeLessThanOrEqual(bb.max.x + 1e-6);
          expect(p.z).toBeGreaterThanOrEqual(bb.min.z - 1e-6);
          expect(p.z).toBeLessThanOrEqual(bb.max.z + 1e-6);
        }
        expect(b.y).toBeGreaterThanOrEqual(bb.min.y - 1e-6);
        expect(roofTopAt(b, b.x, b.z)).toBeLessThanOrEqual(bb.max.y + 1e-6);
        expect(b.y + b.wallHeight + b.roofHeight).toBeLessThanOrEqual(bb.max.y + 1e-6);
      }
    }
  });
  it('distanceToBox is 0 inside and the Euclidean distance outside (fuzz)', () => {
    const box = new THREE.Box3(new THREE.Vector3(-10, 0, -20), new THREE.Vector3(30, 50, 40));
    fc.assert(
      fc.property(fc.double({ min: -200, max: 200, noNaN: true }), fc.double({ min: -200, max: 200, noNaN: true }), fc.double({ min: -200, max: 200, noNaN: true }), (x, y, z) => {
        expect(distanceToBox(box, x, y, z)).toBeCloseTo(box.distanceToPoint(new THREE.Vector3(x, y, z)), 9);
      }),
    );
  });
});
