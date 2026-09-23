/**
 * Functional: the whole A-10C model built in node — render budget (draw calls, triangles), build
 * time, the fleet entry, crash break-up parts that cover the model and restore exactly, the wreck
 * state, and disposal (every geometry and material freed).
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createA10Model, A10_PART } from '../../../src/aircraft/a10';
import { getAircraftDef } from '../../../src/fleet';
import { createDefaultVisualState, createRestReadings, type AircraftVisualState } from '../../../src/aircraft/types';

function state(patch: Partial<AircraftVisualState> = {}): AircraftVisualState {
  return { ...createDefaultVisualState(), engineRunning: true, cameraMode: 'chase', ...patch };
}

/** Draw calls and triangles of the visible model (one call per visible mesh / points object). */
function budget(root: THREE.Object3D) {
  let calls = 0;
  let tris = 0;
  let casters = 0;
  root.traverseVisible((o) => {
    const m = o as THREE.Mesh;
    if (!(m.isMesh || (o as THREE.Points).isPoints)) return;
    calls++;
    if ((o as THREE.Points).isPoints) return;
    if (m.castShadow) casters++;
    const g = m.geometry;
    tris += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
  });
  return { calls, tris, casters };
}

describe('A-10 model: budget', () => {
  it('builds in well under 400 ms (geometry in node; the browser adds the canvas painting)', () => {
    createA10Model().dispose();
    const t0 = performance.now();
    const m = createA10Model();
    const ms = performance.now() - t0;
    m.dispose();
    expect(ms).toBeLessThan(400);
  });

  it('stays within 75 draw calls, ≤ 30 shadow casters and 50–150 k triangles in every configuration (comparable to the F-16)', () => {
    const m = createA10Model();
    const inst = { ...createRestReadings(), throttlePct: 100, state: 'airborne' as const, aoaDeg: 15, airspeedKt: 150 };
    for (const v of [
      state({ gearPos: 1 }),
      state({ gearPos: 0.5 }),
      state({ gearPos: 0, speedBrake: 1, gunSpin: 1, propRpm: 100, instruments: inst }),
      state({ cameraMode: 'cockpit', gearPos: 1, lights: { nav: true, strobe: true, beacon: true, landing: true, taxi: true } }),
    ]) {
      for (let i = 0; i < 60; i++) m.setVisualState(v, 1 / 30);
      const b = budget(m.root);
      expect(b.calls).toBeLessThanOrEqual(75);
      expect(b.casters).toBeLessThanOrEqual(30);
      expect(b.tris).toBeGreaterThan(50_000);
      expect(b.tris).toBeLessThan(150_000);
    }
    m.dispose();
  });

  it('the fleet A-10 entry builds this model (with the weapons contract names)', () => {
    const def = getAircraftDef('a10');
    const model = def.createModel();
    expect(model.root.name).toBe(A10_PART.root);
    expect(model.root.getObjectByName(A10_PART.gunMuzzle)).toBeTruthy();
    for (let i = 0; i < 4; i++) expect(model.root.getObjectByName(A10_PART.store(i))).toBeTruthy();
    model.dispose();
  });
});

describe('A-10 crash break-up', () => {
  const EXPECTED = ['fuselage', 'noseSection', 'canopy', 'leftWing', 'rightWing', 'tail', 'leftEngine', 'rightEngine', 'noseGear', 'leftMainGear', 'rightMainGear'];

  it('exposes the major subtrees as disjoint parts with sensible masses; engines, wings and fuselage burn', () => {
    const m = createA10Model();
    const parts = m.getBreakupParts!();
    expect(parts.map((p) => p.name).sort()).toEqual([...EXPECTED].sort());
    for (const p of parts) {
      expect(p.mass).toBeGreaterThan(50);
      let inRoot = false;
      p.object.traverseAncestors((a) => {
        if (a === m.root) inRoot = true;
      });
      expect(inRoot, p.name).toBe(true);
      for (const q of parts) {
        if (q === p) continue;
        let nested = false;
        q.object.traverseAncestors((a) => {
          if (a === p.object) nested = true;
        });
        expect(nested, `${q.name} inside ${p.name}`).toBe(false);
      }
    }
    expect(parts.filter((p) => p.burning).map((p) => p.name).sort()).toEqual(['fuselage', 'leftEngine', 'leftWing', 'rightEngine', 'rightWing']);
    const total = parts.reduce((s, p) => s + p.mass, 0);
    expect(total).toBeGreaterThan(10_000);
    expect(total).toBeLessThan(16_000);
    m.dispose();
  });

  it('the parts cover the model: every mesh belongs to exactly one part (except the light glows)', () => {
    const m = createA10Model();
    const parts = m.getBreakupParts!();
    const owned = new Set<THREE.Object3D>();
    for (const p of parts) p.object.traverse((o) => owned.add(o));
    const orphans: string[] = [];
    m.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if ((mesh.isMesh || (o as THREE.Points).isPoints) && !owned.has(o) && !o.userData.noBounds) orphans.push(o.name);
    });
    expect(orphans).toEqual([]);
    m.dispose();
  });

  it('detached parts restore exactly to their parents and local transforms', () => {
    const m = createA10Model();
    const scene = new THREE.Scene();
    scene.add(m.root);
    m.root.position.set(100, 50, -20);
    m.root.quaternion.setFromEuler(new THREE.Euler(0.2, 1.1, -0.4));
    m.setVisualState(state({ elevator: 0.7, aileron: -0.5, gearPos: 1 }), 1 / 30);
    m.root.updateMatrixWorld(true);
    const parts = m.getBreakupParts!();
    const before = parts.map((p) => ({ parent: p.object.parent, local: p.object.matrix.clone(), world: p.object.matrixWorld.clone() }));
    parts.forEach((p, i) => {
      scene.attach(p.object);
      p.object.position.add(new THREE.Vector3(i * 3, 10 + i, -i * 2));
      p.object.rotateX(0.3 * i);
      p.object.visible = i % 2 === 0;
    });
    m.restoreBreakupParts!();
    m.root.updateMatrixWorld(true);
    parts.forEach((p, i) => {
      expect(p.object.parent, p.name).toBe(before[i].parent);
      expect(p.object.visible).toBe(true);
      p.object.updateMatrix();
      for (let k = 0; k < 16; k++) expect(p.object.matrix.elements[k]).toBeCloseTo(before[i].local.elements[k], 9);
      for (let k = 0; k < 16; k++) expect(p.object.matrixWorld.elements[k]).toBeCloseTo(before[i].world.elements[k], 6);
    });
    m.dispose();
    const m2 = createA10Model();
    scene.add(m2.root);
    const p2 = m2.getBreakupParts!();
    scene.attach(p2[3].object);
    m2.dispose();
    expect(p2[3].object.parent).toBeNull();
    expect(m2.root.parent).toBeNull();
  });

  it("each part's collision box is the size of the real piece", () => {
    const m = createA10Model();
    m.root.updateMatrixWorld(true);
    const size = (obj: THREE.Object3D) => {
      const inv = obj.matrixWorld.clone().invert();
      const box = new THREE.Box3();
      const tmp = new THREE.Box3();
      obj.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry.computeBoundingBox();
        tmp.copy(mesh.geometry.boundingBox!).applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld));
        box.union(tmp);
      });
      return box.getSize(new THREE.Vector3());
    };
    const max: Record<string, number> = { fuselage: 12.5, noseSection: 4.8, canopy: 2.9, leftWing: 6.2, rightWing: 6.2, tail: 6.1, leftEngine: 3.4, rightEngine: 3.4, noseGear: 1.9, leftMainGear: 3.5, rightMainGear: 3.5 };
    for (const p of m.getBreakupParts!()) {
      const s = size(p.object);
      expect(Math.max(s.x, s.y, s.z), p.name).toBeLessThan(max[p.name]);
    }
    m.dispose();
  });

  it('a crashed Warthog chars, loses its glass, stops its gun and fans, and goes dark; reset brings it back', () => {
    const m = createA10Model();
    const glass = m.root.getObjectByName(A10_PART.canopyGlass)!;
    const lights = { nav: true, strobe: true, beacon: true, landing: true, taxi: true };
    m.setVisualState(state({ crashed: true, crashAge: 10, gunSpin: 1, lights }), 1 / 30);
    expect(glass.visible).toBe(false);
    expect(m.root.getObjectByName(A10_PART.gunBlur)!.visible).toBe(false);
    expect(m.landingLight!.visible).toBe(false);
    expect(m.root.getObjectByName('a10.navLight.left')!.visible).toBe(false);
    m.setVisualState(state({ crashed: false }), 1 / 30);
    expect(glass.visible).toBe(true);
    m.dispose();
  });
});

describe('A-10 dispose', () => {
  it('frees every geometry and material it created (counted through dispose events)', () => {
    const m = createA10Model();
    const geos = new Set<THREE.BufferGeometry>();
    const mats = new Set<THREE.Material>();
    m.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) geos.add(mesh.geometry);
      if (mesh.material) for (const mt of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) mats.add(mt);
    });
    let gd = 0;
    let md = 0;
    for (const g of geos) g.addEventListener('dispose', () => gd++);
    for (const mt of mats) mt.addEventListener('dispose', () => md++);
    m.dispose();
    expect(gd).toBe(geos.size);
    expect(md).toBe(mats.size);
    expect(geos.size).toBeGreaterThan(40);
  });
});
