import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { generateGrassCell, G_STRIDE, G_X, G_Y, G_Z, G_H, G_RANK, type GrassParams } from '../../../src/world/grass/placement';
import { createGrass, buildTuftGeometry } from '../../../src/world/grass';
import { newSiteSample, type SiteSample, type VegWorld } from '../../../src/world/vegetation/placement';

const P: GrassParams = { cellSize: 16, perSide: 32, mownRadius: 300 };
/** A meadow with a paved strip (|x| < 15), a road along z = 200 (half-width 3) and a pond (r 20 at 300, 300). */
const world: VegWorld = {
  heightAt: (x, z) => 30 + 0.01 * x,
  densityAt: () => 0,
  paved: (x, _z) => Math.abs(x) < 15,
  site(x, z, _ny, _nz, out: SiteSample) {
    Object.assign(out, newSiteSample());
    out.height = this.heightAt(x, z);
    out.grass = 0.9;
    out.road = Math.abs(z - 200) - 3;
    out.water = Math.hypot(x - 300, z - 300) - 20;
    out.airport = Math.hypot(x, z);
    return out;
  },
};

describe('grass placement', () => {
  it('fuzz: deterministic for any cell and seed', () => {
    fc.assert(
      fc.property(fc.integer({ min: -500, max: 500 }), fc.integer({ min: -500, max: 500 }), fc.integer({ min: 0, max: 1e6 }), (cx, cz, seed) => {
        const a = generateGrassCell(cx, cz, world, seed, P);
        const b = generateGrassCell(cx, cz, world, seed, P);
        expect(a.count).toBe(b.count);
        expect(Array.from(a.data)).toEqual(Array.from(b.data));
      }),
      { numRuns: 40 },
    );
  });

  it('fuzz: tufts lie in their cell, on the ground, rank-sorted, never on pavement, roads or water', () => {
    fc.assert(
      fc.property(fc.integer({ min: -40, max: 40 }), fc.integer({ min: -40, max: 40 }), fc.integer({ min: 0, max: 99 }), (cx, cz, seed) => {
        const c = generateGrassCell(cx, cz, world, seed, P);
        for (let i = 0; i < c.count; i += 5) {
          const o = i * G_STRIDE;
          const x = c.data[o + G_X];
          const z = c.data[o + G_Z];
          expect(x).toBeGreaterThanOrEqual(cx * 16 - 1e-3);
          expect(x).toBeLessThanOrEqual(cx * 16 + 16 + 1e-3);
          expect(z).toBeGreaterThanOrEqual(cz * 16 - 1e-3);
          expect(z).toBeLessThanOrEqual(cz * 16 + 16 + 1e-3);
          expect(world.paved!(x, z)).toBe(false);
          expect(Math.abs(z - 200) - 3).toBeGreaterThan(0.3);
          expect(Math.hypot(x - 300, z - 300) - 20).toBeGreaterThan(0.5);
          expect(Math.abs(c.data[o + G_Y] - world.heightAt(x, z))).toBeLessThan(0.05);
          expect(c.data[o + G_H]).toBeGreaterThan(0.05);
          expect(c.data[o + G_H]).toBeLessThan(1.2);
          if (i > 0) expect(c.data[o + G_RANK]).toBeGreaterThanOrEqual(Math.floor(c.data[o - G_STRIDE + G_RANK] * 64) / 64 - 1e-6);
        }
      }),
      { numRuns: 16 },
    );
  }, 60000);

  it('meadows are dense (≈ 1–4 tufts/m²) and the mown airfield is denser and shorter', () => {
    const meadow = generateGrassCell(40, 40, world, 5, P); // 900 m out: meadow
    const mown = generateGrassCell(3, 3, world, 5, P); // 50–60 m from the centre: airfield
    expect(meadow.count / 256).toBeGreaterThan(0.5);
    expect(mown.count / 256).toBeGreaterThan(2);
    let hm = 0;
    let hw = 0;
    for (let i = 0; i < meadow.count; i++) hw += meadow.data[i * G_STRIDE + G_H];
    for (let i = 0; i < mown.count; i++) hm += mown.data[i * G_STRIDE + G_H];
    expect(hm / mown.count).toBeLessThan(hw / meadow.count);
  });
});

describe('grass renderer (functional)', () => {
  it('one draw, bounded instances, thinning with distance, nothing from high up', () => {
    const scene = new THREE.Scene();
    const g = createGrass(scene, { world, seed: 3, inlineCellsPerFrame: 400, config: { maxTufts: 40000 } });
    const cam = new THREE.PerspectiveCamera(60, 1.6, 0.5, 5000);
    cam.position.set(60, world.heightAt(60, 60) + 2, 60);
    cam.lookAt(200, 30, 60);
    for (let i = 0; i < 5; i++) g.update(cam, i / 60);
    const s = g.stats();
    expect(s.active).toBe(true);
    expect(s.drawCalls).toBe(1);
    expect(s.tufts).toBeGreaterThan(2000);
    expect(s.tufts).toBeLessThanOrEqual(40000);
    // nearer tufts are denser than far ones
    const { data, count } = g.debugInstances();
    let near = 0;
    let far = 0;
    for (let i = 0; i < count; i++) {
      const d = Math.hypot(data[i * G_STRIDE + G_X] - 60, data[i * G_STRIDE + G_Z] - 60);
      if (d < 20) near++;
      else if (d > 80 && d < 100) far++;
    }
    expect(near / (Math.PI * 400)).toBeGreaterThan((far / (Math.PI * (100 * 100 - 80 * 80))) * 2);
    cam.position.y += 500;
    g.update(cam, 1);
    expect(g.stats().active).toBe(false);
    expect(g.stats().tufts).toBe(0);
    g.dispose();
    expect(scene.children.length).toBe(0);
  });

  it('tuft geometry: blades + flower heads, a few dozen triangles', () => {
    const t = buildTuftGeometry(7);
    const tris = t.index!.count / 3;
    expect(tris).toBe(7 * 3 + 8);
    const box = new THREE.Box3().setFromBufferAttribute(t.getAttribute('position') as THREE.BufferAttribute);
    expect(box.min.y).toBeGreaterThanOrEqual(-1e-6);
    expect(box.max.y).toBeLessThan(1.3);
  });
});
