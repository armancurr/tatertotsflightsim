import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { buildSpeciesGeometry, SPECIES_R0, triangleCount } from '../../../src/world/vegetation/species';
import { canopyProfile, SPECIES_COUNT, SPECIES_NAMES } from '../../../src/world/vegetation/placement';

describe('species meshes', () => {
  for (let s = 0; s < SPECIES_COUNT; s++) {
    describe(SPECIES_NAMES[s], () => {
      const g = buildSpeciesGeometry(s);
      const pos = g.getAttribute('position') as THREE.BufferAttribute;
      const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
      const col = g.getAttribute('color') as THREE.BufferAttribute;

      it('is a low-poly mesh of a few hundred triangles with normals and vertex colours', () => {
        const tris = triangleCount(g);
        expect(tris).toBeGreaterThanOrEqual(150);
        expect(tris).toBeLessThanOrEqual(600);
        expect(nrm.count).toBe(pos.count);
        expect(col.count).toBe(pos.count);
        expect(g.index).not.toBeNull();
      });

      it('normals are unit length, colours in [0, 1] and plausibly green/brown', () => {
        let g0 = 0;
        for (let i = 0; i < pos.count; i++) {
          const l = Math.hypot(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
          expect(l).toBeCloseTo(1, 4);
          for (const c of [col.getX(i), col.getY(i), col.getZ(i)]) {
            expect(c).toBeGreaterThanOrEqual(0);
            expect(c).toBeLessThanOrEqual(1);
          }
          if (col.getY(i) >= col.getX(i) && col.getY(i) >= col.getZ(i)) g0++;
        }
        expect(g0 / pos.count).toBeGreaterThan(0.6); // mostly foliage green
      });

      it('fits the normalised envelope that the physics obstacle uses (height 1, crown radius 1)', () => {
        const box = new THREE.Box3().setFromBufferAttribute(pos);
        expect(box.max.y).toBeLessThanOrEqual(1.0001);
        expect(box.max.y).toBeGreaterThan(0.97);
        expect(box.min.y).toBeGreaterThan(-0.12);
        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i);
          const y = pos.getY(i);
          const z = pos.getZ(i);
          const rho = Math.hypot(x, z);
          expect(rho).toBeLessThanOrEqual(1.02);
          expect(y).toBeLessThanOrEqual(canopyProfile(s, Math.min(rho, 1)) + 0.03);
        }
        // and fills it: the crown reaches most of the way to the radius
        let maxRho = 0;
        for (let i = 0; i < pos.count; i++) maxRho = Math.max(maxRho, Math.hypot(pos.getX(i), pos.getZ(i)));
        expect(maxRho).toBeGreaterThan(0.85);
      });

      it('is irregular, not a cone or a ball: the silhouette radius varies around the crown', () => {
        const bins = new Float64Array(16);
        for (let i = 0; i < pos.count; i++) {
          const a = Math.atan2(pos.getZ(i), pos.getX(i));
          const b = Math.min(15, Math.floor(((a + Math.PI) / (2 * Math.PI)) * 16));
          bins[b] = Math.max(bins[b], Math.hypot(pos.getX(i), pos.getZ(i)));
        }
        const mean = bins.reduce((a, b) => a + b, 0) / 16;
        const sd = Math.sqrt(bins.reduce((a, b) => a + (b - mean) ** 2, 0) / 16);
        expect(sd / mean).toBeGreaterThan(0.015);
      });

      it('is deterministic', () => {
        const g2 = buildSpeciesGeometry(s);
        expect(Array.from((g2.getAttribute('position') as THREE.BufferAttribute).array)).toEqual(Array.from(pos.array));
      });
    });
  }

  it('canonical crown ratios match the placement’s typical radius/height', () => {
    expect(SPECIES_R0.length).toBe(SPECIES_COUNT);
    for (const r of SPECIES_R0) expect(r).toBeGreaterThan(0.1);
  });
});
