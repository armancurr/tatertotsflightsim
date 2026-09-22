import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { createVegetation, type VegetationOptions } from '../../../src/world/vegetation';
import { createObstacleField } from '../../../src/world/vegetation/obstacles';
import { createStandInWorld } from '../../../src/world/vegetation/standin';
import { I_STRIDE, I_X, I_Y, I_Z, I_H, I_R } from '../../../src/world/vegetation/streamer';

const W = createStandInWorld();
const SEED = 4242;
const FAST = { treeViewDistance: 2200, chunkSize: 512, maxCellsPerFrame: 256, frameBudgetMs: 1e9, urgentBudgetMs: 1e9 };

/** A point deep inside a forest of the stand-in world. */
function forestPoint(): { x: number; z: number } {
  for (let r = 3000; r < 20000; r += 700)
    for (let a = 0; a < 6.28; a += 0.3) {
      const x = Math.cos(a) * r;
      const z = -Math.abs(Math.sin(a) * r);
      let ok = true;
      for (let dx = -200; dx <= 200 && ok; dx += 50) for (let dz = -200; dz <= 200 && ok; dz += 50) if (W.densityAt(x + dx, z + dz) < 0.85) ok = false;
      if (ok) return { x, z };
    }
  throw new Error('no forest found');
}
const F = forestPoint();

function make(config: VegetationOptions['config'] = {}) {
  const scene = new THREE.Scene();
  const veg = createVegetation(scene, { heightAt: W.heightAt, densityAt: W.densityAt, seed: SEED, config: { ...FAST, ...config } });
  const cam = new THREE.PerspectiveCamera(60, 1.6, 1, 60000);
  return { scene, veg, cam };
}

function place(cam: THREE.PerspectiveCamera, x: number, agl: number, z: number, pitchDeg = -10, headingDeg = 0): void {
  cam.position.set(x, W.heightAt(x, z) + agl, z);
  cam.rotation.set(0, 0, 0, 'YXZ');
  cam.rotation.set((pitchDeg * Math.PI) / 180, (-headingDeg * Math.PI) / 180, 0, 'YXZ');
  cam.updateMatrixWorld(true);
}

function settle(veg: ReturnType<typeof make>['veg'], cam: THREE.PerspectiveCamera, frames = 60): void {
  for (let i = 0; i < frames; i++) veg.update(cam, i / 60);
}

describe('createVegetation — functional', () => {
  it('low over a forest: near meshes and impostors are populated, draw calls reported', () => {
    const { veg, cam } = make();
    place(cam, F.x, 60, F.z);
    settle(veg, cam, 40);
    const s = veg.stats();
    expect(s.chunks).toBeGreaterThan(4);
    expect(s.nearTrees).toBeGreaterThan(200);
    expect(s.impostorTrees).toBeGreaterThan(1000);
    expect(s.trees).toBe(s.nearTrees + s.impostorTrees);
    expect(s.drawCalls).toBeGreaterThanOrEqual(2);
    expect(s.drawCalls).toBeLessThan(60);
    veg.dispose();
  }, 90000);

  it('obstacleTop matches the pure obstacle field (fuzz) and is a crash inside the forest', () => {
    const { veg } = make();
    const pure = createObstacleField({ densityAt: W.densityAt, heightAt: W.heightAt, seed: SEED });
    fc.assert(
      fc.property(fc.double({ min: -400, max: 400, noNaN: true }), fc.double({ min: -400, max: 400, noNaN: true }), (dx, dz) => {
        const x = F.x + dx;
        const z = F.z + dz;
        expect(veg.obstacleTop(x, z)).toBe(pure.top(x, z));
      }),
      { numRuns: 300 },
    );
    // Somewhere in dense forest there is canopy well above the ground.
    let above = 0;
    for (let i = 0; i < 400; i++) {
      const x = F.x + (i % 20) * 3;
      const z = F.z + Math.floor(i / 20) * 3;
      if (veg.obstacleTop(x, z) > W.heightAt(x, z) + 5) above++;
    }
    expect(above).toBeGreaterThan(100);
    // The runway is open.
    expect(veg.obstacleTop(0, 0)).toBe(-Infinity);
    veg.dispose();
  }, 90000);

  it('LOD by altitude: no meshes from 1 km up, nothing at all from 6 km up', () => {
    const { veg, cam } = make({ treeViewDistance: 4500 });
    place(cam, F.x, 1000, F.z, -30);
    settle(veg, cam, 120);
    expect(veg.stats().nearTrees).toBe(0);
    expect(veg.stats().impostorTrees).toBeGreaterThan(0);
    place(cam, F.x, 6000, F.z, -60);
    settle(veg, cam, 5);
    expect(veg.stats().trees).toBe(0);
    veg.dispose();
  }, 90000);

  it('respects maxTrees (impostors thin out globally so the total stays under the cap)', () => {
    const { veg, cam } = make({ maxTrees: 15000 });
    place(cam, F.x, 80, F.z);
    settle(veg, cam, 60);
    expect(veg.stats().trees).toBeLessThanOrEqual(15000);
    expect(veg.stats().trees).toBeGreaterThan(8000);
    veg.dispose();
  }, 90000);

  it('chunk frustum culling: looking straight up from high above draws no impostor chunks', () => {
    const { veg, cam } = make();
    place(cam, F.x, 900, F.z, -20);
    settle(veg, cam, 60);
    expect(veg.stats().visibleChunks).toBeGreaterThan(0);
    place(cam, F.x, 900, F.z, 89);
    veg.update(cam, 2);
    expect(veg.stats().visibleChunks).toBe(0);
    veg.dispose();
  }, 90000);

  it('chunk bounding spheres contain every tree they draw (base, top, crown and billboard growth)', () => {
    const { veg, cam } = make();
    place(cam, F.x, 120, F.z);
    settle(veg, cam, 60);
    const chunks = veg.debugChunks();
    expect(chunks.length).toBeGreaterThan(3);
    const p = new THREE.Vector3();
    for (const c of chunks) {
      const s = c.sphere;
      for (let i = 0; i < c.count; i++) {
        const o = i * I_STRIDE;
        const x = c.array[o + I_X];
        const y = c.array[o + I_Y];
        const z = c.array[o + I_Z];
        const h = c.array[o + I_H];
        const r = c.array[o + I_R] * 1.12 * 1.6; // billboard margin × max thinning growth
        for (const [dx, dy, dz] of [[0, -0.1 * h, 0], [0, h * 1.6, 0], [r, h / 2, r], [-r, h / 2, -r]]) {
          p.set(x + dx, y + dy, z + dz);
          expect(s.distanceToPoint(p)).toBeLessThanOrEqual(1e-3);
        }
      }
    }
    veg.dispose();
  }, 90000);

  it('time-sliced streaming: cells generated per frame never exceed the budget in cruise', () => {
    const { veg, cam } = make({ maxCellsPerFrame: 6, urgentBudgetMs: 1e9 });
    place(cam, F.x, 150, F.z);
    settle(veg, cam, 5);
    for (let i = 0; i < 200; i++) {
      // 150 kt ≈ 77 m/s → 1.3 m per frame at 60 fps
      place(cam, F.x + i * 1.3, 150, F.z);
      veg.update(cam, i / 60);
      const s = veg.stats();
      if (!s.urgent) expect(s.cellsThisFrame).toBeLessThanOrEqual(6);
    }
    veg.dispose();
  }, 90000);

  it('pool reuse: flying 50 km in steps keeps pooled buffers and scene objects bounded; dispose cleans up', () => {
    const { scene, veg, cam } = make({ maxCellsPerFrame: 4096 });
    let maxObjects = 0;
    let maxCreated = 0;
    for (let d = 0; d <= 50000; d += 1000) {
      place(cam, -25000 + d, 200, -12000 + d * 0.2);
      veg.update(cam, d / 100);
      veg.update(cam, d / 100 + 0.016);
      let n = 0;
      veg.root.traverse(() => n++);
      maxObjects = Math.max(maxObjects, n);
      maxCreated = Math.max(maxCreated, veg.stats().poolCreated);
    }
    // disc of radius (view + margin) in 512 m chunks, + the 8 near meshes, + pool idle cap
    const chunkBound = Math.ceil(((2200 + 256) * 2) / 512 + 1) ** 2;
    expect(maxCreated).toBeLessThanOrEqual(chunkBound + 5 * 8);
    expect(maxObjects).toBeLessThanOrEqual(chunkBound + 5 * 8 + 8 + 2);
    expect(veg.stats().pooled).toBeLessThanOrEqual(5 * 8);
    veg.dispose();
    expect(scene.children.includes(veg.root)).toBe(false);
    expect(veg.root.children.length).toBe(0);
  }, 120000);
});
