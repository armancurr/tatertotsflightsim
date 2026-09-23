import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { fcParams } from '../../support/fc';
import { createWater } from '../../../src/world/terrainIndex';
import { waterSurfaceAt as fromIndex } from '../../../src/world/water';
import { waterSurfaceAt } from '../../../src/world/water/waves';
import { getLayout } from '../../../src/world/layout';
import { CONFIG } from '../../../src/config';

const L = getLayout();

function setup() {
  const scene = new THREE.Scene();
  const water = createWater(scene, { bathymetryRes: 32, detailTileSize: 32 });
  const cam = new THREE.PerspectiveCamera(60, 1.6, 0.5, 90000);
  return { scene, water, cam };
}

function place(cam: THREE.PerspectiveCamera, x: number, y: number, z: number, headingDeg: number, pitchDeg = -8) {
  cam.position.set(x, y, z);
  cam.rotation.set((pitchDeg * Math.PI) / 180, (-headingDeg * Math.PI) / 180, 0, 'YXZ');
  cam.updateMatrixWorld(true);
}

describe('water (functional)', () => {
  it('builds the sea, lakes and river in ≤ 12 draw calls, fogged, sorted before other transparents', () => {
    const { scene, water, cam } = setup();
    const all: THREE.Mesh[] = [];
    scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) all.push(o as THREE.Mesh);
    });
    const meshes = all.filter((m) => !m.name.startsWith('reeds:'));
    const names = meshes.map((m) => m.name).sort();
    expect(names).toEqual(['lakes', 'river:Tater River', 'sea']);
    // reeds: chunks near the camera only; ≤ 12 draw calls in all anywhere along the river
    const rv = L.rivers[0];
    for (let i = 0; i < rv.points.length; i += 60) {
      place(cam, rv.points[i].x, rv.levels[i] + 150, rv.points[i].z, 180);
      water.update(cam, 0, new THREE.Vector3(0, 1, 0));
      const visible = all.filter((m) => m.visible).length;
      expect(water.stats().drawCalls).toBe(visible);
      expect(visible).toBeLessThanOrEqual(12);
    }
    for (const m of meshes) {
      const mat = m.material as THREE.MeshStandardMaterial;
      expect(mat.fog).toBe(true);
      expect(mat.transparent).toBe(true);
      expect(m.renderOrder).toBeLessThan(0);
      expect(m.castShadow).toBe(false);
      expect(m.receiveShadow).toBe(true);
    }
    // the river draws after the sea (it blends into it at the mouth)
    const sea = meshes.find((m) => m.name === 'sea')!;
    const river = meshes.find((m) => m.name.startsWith('river'))!;
    expect(river.renderOrder).toBeGreaterThan(sea.renderOrder);
    water.dispose();
    expect(scene.children.length).toBe(0);
  });

  it('lakes sit at their levels, over their shorelines', () => {
    const { scene, water } = setup();
    const lakes = scene.getObjectByName('lakes') as THREE.Mesh;
    const pos = lakes.geometry.getAttribute('position');
    const kind = lakes.geometry.getAttribute('aLake');
    const levels = new Set<number>();
    for (let i = 0; i < pos.count; i++) {
      const lk = L.lakes[kind.getX(i) > 0.5 ? 1 : 0];
      expect(pos.getY(i)).toBeCloseTo(lk.level, 3);
      levels.add(Math.round(pos.getY(i)));
    }
    expect(levels.size).toBe(2);
    water.dispose();
  });

  it('follows the camera and keeps the uniforms (no per-frame reallocation) over many frames', () => {
    const { scene, water, cam } = setup();
    const sea = scene.getObjectByName('sea') as THREE.Mesh;
    const sun = new THREE.Vector3(0.3, 0.8, -0.5).normalize();
    const mat = sea.material as THREE.MeshStandardMaterial;
    water.update(cam, 0, sun);
    const u0 = { ...water.uniforms('sea') };
    for (let f = 0; f < 600; f++) {
      const t = f / 60;
      place(cam, 3300 + f * 40, 300 + f, 4500 + f * 20, 180);
      water.update(cam, t, sun);
      expect(sea.position.x).toBeCloseTo(cam.position.x, 6);
      expect(sea.position.z).toBeCloseTo(cam.position.z, 6);
    }
    const u1 = water.uniforms('sea');
    for (const k of Object.keys(u0) as (keyof typeof u0)[]) expect(u1[k]).toBe(u0[k]);
    expect(mat).toBe(sea.material);
    // phases are wrapped into [0, 2π) and finite
    const A = u1.uWaveA.value;
    for (let i = 0; i < 16; i++) {
      expect(A[i * 4 + 3]).toBeGreaterThanOrEqual(0);
      expect(A[i * 4 + 3]).toBeLessThan(2 * Math.PI + 1e-6);
    }
    water.dispose();
  });

  it('bakes bathymetry around the camera (main-thread fallback in node) and re-centres as it flies', () => {
    const { water, cam } = setup();
    const sun = new THREE.Vector3(0, 1, 0);
    place(cam, 3300, 400, L.coast.zAt(3300) + 500, 180);
    water.update(cam, 0, sun);
    const s0 = water.stats();
    expect(s0.bathyBakes).toBeGreaterThanOrEqual(2);
    const near0 = water.stats().near as { cx: number; cz: number };
    const cell = CONFIG.world.water.bathymetryNear / 32; // centres snap to the texel grid
    expect(Math.hypot(near0.cx - 3300, near0.cz - (L.coast.zAt(3300) + 500))).toBeLessThan(cell);
    place(cam, 3300 + 3000, 400, L.coast.zAt(3300) + 500, 90);
    water.update(cam, 1, sun);
    const near1 = water.stats().near as { cx: number; cz: number };
    expect(Math.abs(near1.cx - 6300)).toBeLessThanOrEqual(cell / 2);
    water.dispose();
  });

  it('fuzz: any camera pose and time keeps every uniform finite', () => {
    const { water, cam } = setup();
    const sun = new THREE.Vector3(0.2, 0.9, 0.1).normalize();
    fc.assert(
      fc.property(
        fc.double({ min: -60000, max: 60000, noNaN: true }),
        fc.double({ min: 1, max: 6000, noNaN: true }),
        fc.double({ min: -60000, max: 60000, noNaN: true }),
        fc.double({ min: 0, max: 1e6, noNaN: true }),
        fc.integer({ min: 0, max: 3 }),
        (x, y, z, t, tod) => {
          place(cam, x, y, z, (x * 7) % 360);
          water.update(cam, t, sun, { timeOfDay: tod, viewportHeight: 900 });
          for (const kind of ['sea', 'lake', 'river'] as const) {
            const u = water.uniforms(kind);
            for (const v of u.uWaveA.value) expect(Number.isFinite(v)).toBe(true);
            expect(Number.isFinite(u.uDetailOff.value.x + u.uDetailOff.value.y + u.uDetailOff.value.z + u.uDetailOff.value.w)).toBe(true);
            expect(u.uWaveGain.value).toBeGreaterThanOrEqual(0);
            expect(u.uWaveGain.value).toBeLessThanOrEqual(1);
          }
        },
      ),
      fcParams(60),
    );
    water.dispose();
  });

  it('exports the dependency-free wave API', () => {
    expect(fromIndex).toBe(waterSurfaceAt);
    const s = fromIndex(100, 200, 3);
    expect(Number.isFinite(s.height)).toBe(true);
  });
});
