/**
 * Functional: the whole F-16 model built in node — render budget (draw calls, triangles), build
 * time, the fleet entry, crash break-up parts and their exact restore, and disposal.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createF16Model, F16_PART } from '../../../src/aircraft/f16';
import { getAircraftDef } from '../../../src/fleet';
import { createDefaultVisualState, type AircraftVisualState } from '../../../src/aircraft/types';

function state(patch: Partial<AircraftVisualState> = {}): AircraftVisualState {
  return { ...createDefaultVisualState(), engineRunning: true, cameraMode: 'chase', ...patch };
}

/** Draw calls and triangles of the visible model (one call per visible mesh / points object). */
function budget(root: THREE.Object3D) {
  let calls = 0;
  let tris = 0;
  root.traverseVisible((o) => {
    const m = o as THREE.Mesh;
    if (!(m.isMesh || (o as THREE.Points).isPoints)) return;
    calls++;
    if ((o as THREE.Points).isPoints) return;
    const g = m.geometry;
    const n = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    tris += n * ((o as THREE.InstancedMesh).isInstancedMesh ? (o as THREE.InstancedMesh).count : 1);
  });
  return { calls, tris };
}

describe('F-16 model: budget', () => {
  it('builds in well under 400 ms (geometry in node; the browser adds ~30 ms of canvas painting)', () => {
    createF16Model().dispose(); // warm up
    const t0 = performance.now();
    const m = createF16Model();
    const ms = performance.now() - t0;
    m.dispose();
    expect(ms).toBeLessThan(400);
  });

  it('stays within 60 draw calls and 60–150 k triangles in every view and configuration', () => {
    const m = createF16Model();
    for (const v of [
      state({ gearPos: 1 }),
      state({ gearPos: 0.5 }),
      state({ gearPos: 0, afterburner: 1, speedBrake: 1 }),
      state({ cameraMode: 'cockpit', gearPos: 1, lights: { nav: true, strobe: true, beacon: true, landing: true, taxi: true } }),
    ]) {
      for (let i = 0; i < 60; i++) m.setVisualState(v, 1 / 30);
      const b = budget(m.root);
      expect(b.calls).toBeLessThanOrEqual(60);
      expect(b.tris).toBeGreaterThan(60_000);
      expect(b.tris).toBeLessThan(150_000);
    }
    m.dispose();
  });

  it('the fleet F-16 entry builds this model', () => {
    const def = getAircraftDef('f16');
    const model = def.createModel();
    expect(model.root.name).toBe(F16_PART.root);
    expect(model.root.getObjectByName(F16_PART.nozzle)).toBeTruthy();
    model.dispose();
  });
});

describe('F-16 crash break-up', () => {
  const EXPECTED = ['fuselage', 'noseCone', 'canopy', 'leftWing', 'rightWing', 'tail', 'leftStab', 'rightStab', 'engine', 'noseGear', 'leftMainGear', 'rightMainGear'];

  it('exposes the major subtrees as disjoint parts with sensible masses; fuel-carrying parts burn', () => {
    const m = createF16Model();
    const parts = m.getBreakupParts!();
    expect(parts.map((p) => p.name).sort()).toEqual([...EXPECTED].sort());
    for (const p of parts) {
      expect(p.mass).toBeGreaterThan(20);
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
    const burning = parts.filter((p) => p.burning).map((p) => p.name).sort();
    expect(burning).toEqual(['engine', 'fuselage', 'leftWing', 'rightWing']);
    expect(parts.reduce((s, p) => s + p.mass, 0)).toBeGreaterThan(8000);
    m.dispose();
  });

  it('detached parts (thrown about in the scene) restore exactly to their parents and local transforms', () => {
    const m = createF16Model();
    const scene = new THREE.Scene();
    scene.add(m.root);
    m.root.position.set(100, 50, -20);
    m.root.quaternion.setFromEuler(new THREE.Euler(0.2, 1.1, -0.4));
    m.setVisualState(state({ elevator: 0.7, aileron: -0.5, gearPos: 1 }), 1 / 30);
    m.root.updateMatrixWorld(true);
    const parts = m.getBreakupParts!();
    const before = parts.map((p) => ({ parent: p.object.parent, local: p.object.matrix.clone(), world: p.object.matrixWorld.clone() }));
    // What the crash system does: keep the world transform, move into the scene, tumble.
    parts.forEach((p, i) => {
      scene.attach(p.object);
      p.object.position.add(new THREE.Vector3(i * 3, 10 + i, -i * 2));
      p.object.rotateX(0.3 * i);
      p.object.rotateZ(-0.7 + i * 0.1);
      p.object.visible = i % 2 === 0;
    });
    scene.updateMatrixWorld(true);
    m.restoreBreakupParts!();
    m.root.updateMatrixWorld(true);
    parts.forEach((p, i) => {
      expect(p.object.parent, p.name).toBe(before[i].parent);
      expect(p.object.visible).toBe(true);
      p.object.updateMatrix();
      const a = p.object.matrix.elements;
      const b = before[i].local.elements;
      for (let k = 0; k < 16; k++) expect(a[k]).toBeCloseTo(b[k], 9);
      const w = p.object.matrixWorld.elements;
      const wb = before[i].world.elements;
      for (let k = 0; k < 16; k++) expect(w[k]).toBeCloseTo(wb[k], 6);
    });
    // Restoring twice is harmless.
    m.restoreBreakupParts!();
    expect(parts.every((p, i) => p.object.parent === before[i].parent)).toBe(true);
    m.dispose();
    // Disposing removes everything, including parts still lying around in the scene.
    const m2 = createF16Model();
    scene.add(m2.root);
    const p2 = m2.getBreakupParts!();
    scene.attach(p2[3].object);
    m2.dispose();
    expect(p2[3].object.parent).toBeNull();
    expect(m2.root.parent).toBeNull();
  });

  it('a crashed jet chars, loses its glass and plume, and goes dark; reset brings it all back', () => {
    const m = createF16Model();
    const glass = m.root.getObjectByName(F16_PART.canopyGlass)!;
    m.setVisualState(state({ crashed: true, crashAge: 10, afterburner: 1, lights: { nav: true, strobe: true, beacon: true, landing: true, taxi: true } }), 1 / 30);
    expect(glass.visible).toBe(false);
    expect(m.root.getObjectByName(F16_PART.plume)!.visible).toBe(false);
    expect(m.landingLight!.visible).toBe(false);
    m.setVisualState(state({ crashed: false }), 1 / 30);
    expect(glass.visible).toBe(true);
    m.dispose();
  });
});
