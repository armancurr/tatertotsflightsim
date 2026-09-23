import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { fcParams } from '../../support/fc';
import { placeReeds, buildReeds, REED_STRIDE } from '../../../src/world/water/reeds';
import { getLayout, lakeSignedDistance, type River } from '../../../src/world/layout';
import { CONFIG } from '../../../src/config';

const L = getLayout();
const W = CONFIG.world.water;
const opts = { spacing: W.reedSpacing, rapidsSlope: W.rapidsSlope, coastZAt: L.coast.zAt };

/** Distance from (x, z) to the river centreline (brute force) and the index of the nearest point. */
function nearestRiver(rv: River, x: number, z: number): { d: number; i: number } {
  let d = Infinity;
  let bi = 0;
  for (let i = 0; i < rv.points.length - 1; i++) {
    const a = rv.points[i];
    const b = rv.points[i + 1];
    const ux = b.x - a.x;
    const uz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((x - a.x) * ux + (z - a.z) * uz) / (ux * ux + uz * uz)));
    const dd = Math.hypot(x - a.x - ux * t, z - a.z - uz * t);
    if (dd < d) {
      d = dd;
      bi = i;
    }
  }
  return { d, i: bi };
}

describe('reeds', () => {
  const r = placeReeds(L, opts);

  it('fringes the slow river banks and the lowland lake shores, in patchy stands', () => {
    expect(r.count).toBeGreaterThan(2000);
    expect(r.count).toBeLessThan(20000);
    expect(r.data.length).toBe(r.count * REED_STRIDE);
    const rv = L.rivers[0];
    let river = 0;
    let lake = 0;
    for (let k = 0; k < r.count; k++) {
      const [x, y, z, h, , tint] = r.data.subarray(k * REED_STRIDE, (k + 1) * REED_STRIDE);
      expect(h).toBeGreaterThanOrEqual(1);
      expect(h).toBeLessThanOrEqual(3);
      expect(tint).toBeGreaterThanOrEqual(0);
      expect(tint).toBeLessThanOrEqual(1);
      const lk = L.lakes.find((l) => Math.abs(lakeSignedDistance(l, x, z)) < 12);
      if (lk) {
        lake++;
        expect(lk.level).toBeLessThan(500); // no reeds round the alpine tarn
        expect(y).toBeCloseTo(lk.level - 0.25, 3);
        continue;
      }
      river++;
      const n = nearestRiver(rv, x, z);
      // at the water's edge (± a couple of metres), standing in the shallows at the water level
      expect(Math.abs(n.d - rv.halfWidths[n.i])).toBeLessThan(4);
      expect(Math.abs(y - (rv.levels[n.i] - 0.25))).toBeLessThan(2);
      // not on the coast side of the mouth
      expect(z).toBeLessThan(L.coast.zAt(x));
    }
    expect(river).toBeGreaterThan(1000);
    expect(lake).toBeGreaterThan(300);
  });

  it('keeps out of the steep reaches (rapids) and the mountains', () => {
    const rv = L.rivers[0];
    for (let k = 0; k < r.count; k += 7) {
      const x = r.data[k * REED_STRIDE];
      const z = r.data[k * REED_STRIDE + 2];
      if (L.lakes.some((l) => Math.abs(lakeSignedDistance(l, x, z)) < 12)) continue;
      const { i } = nearestRiver(rv, x, z);
      const a = Math.max(0, i - 3);
      const b = Math.min(rv.points.length - 1, i + 3);
      const slope = (rv.levels[a] - rv.levels[b]) / ((b - a) * 40);
      expect(slope).toBeLessThan(W.rapidsSlope * 3);
    }
  });

  it('is deterministic and splits into spatial chunks that cover every clump once', () => {
    const r2 = placeReeds(L, opts);
    expect(r2.count).toBe(r.count);
    expect(Array.from(r2.data.subarray(0, 60))).toEqual(Array.from(r.data.subarray(0, 60)));
    let total = 0;
    for (const c of r.chunks) {
      total += c.count;
      for (let k = c.start; k < c.start + c.count; k++) {
        const x = r.data[k * REED_STRIDE];
        const z = r.data[k * REED_STRIDE + 2];
        expect(Math.hypot(x - c.x, z - c.z)).toBeLessThanOrEqual(c.radius + 1e-6);
      }
    }
    expect(total).toBe(r.count);
  });

  it('builds a few instanced meshes (one per chunk), fogged, alpha-tested, never casting into the water pass', () => {
    const g = buildReeds(r);
    expect(g.meshes.length).toBe(r.chunks.length);
    for (const m of g.meshes) {
      expect(m.geometry).toBeInstanceOf(THREE.InstancedBufferGeometry);
      expect((m.geometry as THREE.InstancedBufferGeometry).instanceCount).toBeGreaterThan(0);
      const mat = m.material as THREE.MeshStandardMaterial;
      expect(mat.fog).toBe(true);
      expect(mat.alphaTest).toBeGreaterThan(0);
      expect(m.geometry.boundingSphere).not.toBeNull();
    }
    // distance culling: only chunks near the camera stay visible
    const cam = new THREE.Vector3(r.chunks[0].x, 300, r.chunks[0].z);
    g.update(cam, 0);
    const vis = g.meshes.filter((m) => m.visible).length;
    expect(vis).toBeGreaterThan(0);
    expect(vis).toBeLessThan(g.meshes.length);
    g.dispose();
  });

  it('fuzz: any river gives finite clumps at its banks', () => {
    fc.assert(
      fc.property(fc.integer({ min: 3, max: 60 }), fc.double({ min: 4, max: 60, noNaN: true }), fc.double({ min: 0, max: 0.02, noNaN: true }), (n, hw, grad) => {
        const pts = Array.from({ length: n }, (_, i) => ({ x: 30 * Math.sin(i * 0.3), z: -4000 + i * 40 }));
        const levels = pts.map((_, i) => Math.max(0, 100 - i * 40 * grad));
        const rv: River = { name: 'f', points: pts, levels, halfWidths: pts.map(() => hw), depths: pts.map(() => 2), valley: pts, valleyLevels: levels, source: pts[0], mouth: pts[n - 1] };
        const out = placeReeds({ ...L, rivers: [rv], lakes: [] }, { ...opts, coastZAt: () => 1e9 });
        for (const v of out.data) expect(Number.isFinite(v)).toBe(true);
        if (grad > W.rapidsSlope * 3) expect(out.count).toBe(0);
      }),
      fcParams(40),
    );
  });
});
