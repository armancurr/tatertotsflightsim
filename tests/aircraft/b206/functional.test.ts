/**
 * Functional: the whole JetRanger model built in node — render budget (draw calls, triangles),
 * build time, the fleet entry, crash break-up parts and their exact restore, the wreck and its
 * reset, robustness to bad inputs, and disposal.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createB206Model, B206_PART } from '../../../src/aircraft/b206';
import { getAircraftDef } from '../../../src/fleet';
import { createDefaultVisualState, createRestReadings, type AircraftVisualState } from '../../../src/aircraft/types';
import { B206_AIRCRAFT } from '../../../src/config';
import type { RotorState } from '../../../src/types';

const RC = B206_AIRCRAFT.rotorcraft!;

function rotor(patch: Partial<RotorState> = {}): RotorState {
  return {
    omega: 0, vi: 0, viTail: 0, thrust: 0, tailThrust: 0, flapLong: 0, flapLat: 0, enginePower: 0, n1: 0, govInt: 0, torque: 0,
    collective: 0, cyclicLong: 0, cyclicLat: 0, pedal: 0, sasOn: false, sasLong: 0, sasLat: 0, sasYaw: 0, headingRef: 0,
    vrs: 0, bladeStall: 0, groundEffect: 0, fx: 0, fy: 0,
    ...patch,
  } as RotorState;
}
function state(patch: Partial<AircraftVisualState> = {}): AircraftVisualState {
  return { ...createDefaultVisualState(), engineRunning: true, cameraMode: 'chase', rotor: rotor(), ...patch };
}
const flying = (patch: Partial<AircraftVisualState> = {}) =>
  state({ propRpm: RC.rotor.nominalRpm, rotor: rotor({ thrust: B206_AIRCRAFT.mass * 9.81, collective: 0.5, flapLong: 0.03 }), ...patch });

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
    tris += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
  });
  return { calls, tris };
}

describe('JetRanger model: budget', () => {
  it('builds in well under 400 ms (geometry in node; the browser adds the canvas painting)', () => {
    createB206Model().dispose(); // warm up
    let ms = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const m = createB206Model();
      ms = Math.min(ms, performance.now() - t0);
      m.dispose();
    }
    expect(ms).toBeLessThan(400);
  }, 30000);

  it('stays within 40 draw calls and 40–120 k triangles in every view and configuration', () => {
    const m = createB206Model();
    for (const v of [
      state(),
      flying(),
      flying({ cameraMode: 'cockpit', instruments: createRestReadings(), lights: { nav: true, strobe: true, beacon: true, landing: true, taxi: true } }),
      state({ crashed: true, crashAge: 8 }),
    ]) {
      for (let i = 0; i < 20; i++) m.setVisualState(v, 1 / 30);
      const b = budget(m.root);
      expect(b.calls).toBeLessThanOrEqual(40);
      expect(b.tris).toBeGreaterThan(40_000);
      expect(b.tris).toBeLessThan(120_000);
    }
    m.dispose();
  });

  it('the fleet JetRanger entry builds this model', () => {
    const def = getAircraftDef('b206');
    expect(def.id).toBe('b206');
    const model = def.createModel();
    expect(model.root.name).toBe(B206_PART.root);
    expect(model.root.getObjectByName(B206_PART.mainRotor)).toBeTruthy();
    expect(model.root.getObjectByName(B206_PART.tailRotor)).toBeTruthy();
    expect(model.landingLight).toBeInstanceOf(THREE.SpotLight);
    model.dispose();
  });
});

describe('JetRanger crash break-up', () => {
  const EXPECTED = ['fuselage', 'tailBoom', 'mainRotor', 'tailRotor', 'skids'];

  it('exposes the major subtrees as disjoint parts with sensible masses; the fuselage (fuel, engine) burns', () => {
    const m = createB206Model();
    const parts = m.getBreakupParts!();
    expect(parts.map((p) => p.name).sort()).toEqual([...EXPECTED].sort());
    for (const p of parts) {
      expect(p.mass).toBeGreaterThan(10);
      expect(p.object.parent).toBe(m.root);
      // A pure container at the identity (the model animates only its children).
      expect(p.object.matrix.equals(new THREE.Matrix4())).toBe(true);
      for (const q of parts) {
        if (q === p) continue;
        let nested = false;
        q.object.traverseAncestors((a) => {
          if (a === p.object) nested = true;
        });
        expect(nested, `${q.name} inside ${p.name}`).toBe(false);
      }
    }
    expect(parts.filter((p) => p.burning).map((p) => p.name)).toEqual(['fuselage']);
    const total = parts.reduce((s, p) => s + p.mass, 0);
    expect(Math.abs(total - B206_AIRCRAFT.mass)).toBeLessThan(100);
    const mass = Object.fromEntries(parts.map((p) => [p.name, p.mass]));
    expect(mass.fuselage).toBeGreaterThan(mass.mainRotor);
    expect(mass.mainRotor).toBeGreaterThan(mass.tailBoom);
    expect(mass.tailBoom).toBeGreaterThan(mass.tailRotor);
    m.dispose();
  });

  it('detached parts (thrown about in the scene) restore exactly to their parents and local transforms', () => {
    const m = createB206Model();
    const scene = new THREE.Scene();
    scene.add(m.root);
    m.root.position.set(100, 50, -20);
    m.root.quaternion.setFromEuler(new THREE.Euler(0.2, 1.1, -0.4));
    m.setVisualState(flying(), 1 / 30);
    m.root.updateMatrixWorld(true);
    const parts = m.getBreakupParts!();
    const before = parts.map((p) => ({ parent: p.object.parent, local: p.object.matrix.clone(), world: p.object.matrixWorld.clone() }));
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
    m.restoreBreakupParts!();
    expect(parts.every((p, i) => p.object.parent === before[i].parent)).toBe(true);
    m.dispose();
    // Disposing removes everything, including parts still lying around in the scene.
    const m2 = createB206Model();
    scene.add(m2.root);
    const p2 = m2.getBreakupParts!();
    scene.attach(p2[1].object);
    m2.dispose();
    expect(p2[1].object.parent).toBeNull();
    expect(m2.root.parent).toBeNull();
  });

  it("each part's collision box is the size of the real piece", () => {
    const m = createB206Model();
    m.root.updateMatrixWorld(true);
    const size = (obj: THREE.Object3D) => {
      const inv = obj.matrixWorld.clone().invert();
      const box = new THREE.Box3();
      const tmp = new THREE.Box3();
      obj.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || o.userData.noBounds) return;
        mesh.geometry.computeBoundingBox();
        tmp.copy(mesh.geometry.boundingBox!).applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld));
        box.union(tmp);
      });
      return box.getSize(new THREE.Vector3());
    };
    const max: Record<string, number> = { fuselage: 5.2, tailBoom: 5.0, mainRotor: 10.3, tailRotor: 1.8, skids: 3.7 };
    const min: Record<string, number> = { fuselage: 3.5, tailBoom: 4.0, mainRotor: 9.9, tailRotor: 1.5, skids: 3.0 };
    for (const p of m.getBreakupParts!()) {
      const s = size(p.object);
      const big = Math.max(s.x, s.y, s.z);
      expect(big, p.name).toBeLessThan(max[p.name]);
      expect(big, p.name).toBeGreaterThan(min[p.name]);
    }
    m.dispose();
  });

  it('a crashed JetRanger is a wreck — bent blades, a stopped rotor, a bent boom, splayed skids, no glass, dark lights, soot — and a reset brings it all back', () => {
    const m = createB206Model();
    const glass = m.root.getObjectByName(B206_PART.glass)!;
    const bend = m.root.getObjectByName(B206_PART.boomBend)!;
    const blade = m.root.getObjectByName(B206_PART.blade0) as THREE.Mesh;
    const spin = m.root.getObjectByName(B206_PART.spin)!;
    const gear = m.root.getObjectByName(B206_PART.skidGear) as THREE.Mesh;
    const intactBlade = blade.geometry;
    const minY = (g: THREE.BufferGeometry) => {
      g.computeBoundingBox();
      return g.boundingBox!.min.y;
    };
    const gearMin = minY(gear.geometry);
    const lights = { nav: true, strobe: true, beacon: true, landing: true, taxi: true };
    m.setVisualState(flying({ lights }), 1 / 30);
    const crashed = flying({ crashed: true, crashAge: 10, lights });
    const a0 = spin.rotation.y;
    m.setVisualState(crashed, 1 / 30);
    m.setVisualState(crashed, 1 / 30);
    expect(glass.visible).toBe(false);
    expect(m.landingLight!.visible).toBe(false);
    expect(m.root.getObjectByName(B206_PART.disc)!.visible).toBe(false);
    expect(spin.rotation.y).toBeCloseTo(a0, 9);
    expect(blade.geometry).not.toBe(intactBlade);
    expect(minY(blade.geometry)).toBeLessThan(minY(intactBlade) - 1);
    expect(bend.quaternion.angleTo(new THREE.Quaternion())).toBeGreaterThan(0.1);
    expect(minY(gear.geometry)).toBeGreaterThan(gearMin + 0.1);
    m.setVisualState(state({ crashed: false }), 1 / 30);
    expect(glass.visible).toBe(true);
    expect(blade.geometry).toBe(intactBlade);
    expect(bend.quaternion.angleTo(new THREE.Quaternion())).toBeLessThan(1e-9);
    expect(bend.position.length()).toBeLessThan(1e-9);
    expect(Math.abs(minY(gear.geometry) - gearMin)).toBeLessThan(1e-6);
    m.dispose();
  });

  it('bad inputs (NaN / Infinity / missing rotor state) never produce NaN transforms', () => {
    const m = createB206Model();
    const bad = state({
      propRpm: NaN,
      rotor: rotor({ flapLong: NaN, flapLat: Infinity, collective: NaN, cyclicLong: -Infinity, pedal: NaN, thrust: NaN }),
      wheelCompression: [NaN, Infinity, -5],
      time: NaN,
      elevator: NaN,
    });
    for (const v of [bad, { ...bad, rotor: null }, { ...bad, rotor: undefined, propRpm: Infinity }]) {
      for (let i = 0; i < 5; i++) m.setVisualState(v, NaN);
      m.setVisualState(v, 1 / 30);
      m.root.updateMatrixWorld(true);
      m.root.traverse((o) => {
        for (const e of o.matrixWorld.elements) expect(Number.isFinite(e), o.name).toBe(true);
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) {
          const p = mesh.geometry.getAttribute('position').array as ArrayLike<number>;
          for (let i = 0; i < p.length; i += 97) expect(Number.isFinite(p[i]), o.name).toBe(true);
        }
      });
    }
    m.dispose();
  });

  it('dispose frees every geometry, including the wreck clones', () => {
    const m = createB206Model();
    m.setVisualState(state({ crashed: true, crashAge: 3 }), 1 / 30);
    m.setVisualState(state(), 1 / 30);
    const geos = new Set<THREE.BufferGeometry>();
    m.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) geos.add(mesh.geometry);
    });
    let disposed = 0;
    for (const g of geos) g.addEventListener('dispose', () => disposed++);
    m.dispose();
    expect(disposed).toBe(geos.size);
    expect(m.root.parent).toBeNull();
  });
});
