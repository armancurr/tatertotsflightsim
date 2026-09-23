/**
 * Crash break-up parts of the C172RG model: the contract the crash system relies on
 * (src/fleet/types.ts BreakupPart): named parts that can be detached into the scene, flung as
 * rigid bodies, and put back exactly — including after the wreck deformation.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import fc from 'fast-check';
import { fcParams } from '../support/fc';
import { createAircraft, PART } from '../../src/aircraft/index';
import { createDefaultVisualState, type AircraftVisualState } from '../../src/aircraft/types';
import { splitByTriangles } from '../../src/aircraft/breakup';

type Aircraft = ReturnType<typeof createAircraft>;
const st = (patch: Partial<AircraftVisualState> = {}): AircraftVisualState => ({ ...createDefaultVisualState(), ...patch });

const NAMES = ['fuselage', 'engine', 'prop', 'leftWing', 'rightWing', 'tail', 'noseGear', 'leftMainGear', 'rightMainGear', 'leftDoor', 'rightDoor'];
/** Meshes allowed outside every part (dead electrics after a crash). */
const LOOSE = new Set(['navLights', 'strobes', 'lightGlows']);

function snapshot(ac: Aircraft): number[] {
  ac.root.updateMatrixWorld(true);
  const out: number[] = [];
  ac.root.traverse((o) => {
    const m = o as THREE.Mesh;
    out.push(o.visible ? 1 : 0, ...o.matrixWorld.elements.map((e) => Math.round(e * 1e9) / 1e9));
    if (m.isMesh) out.push(m.geometry.id);
  });
  return out;
}

function boundsOf(o: THREE.Object3D): THREE.Box3 {
  o.updateMatrixWorld(true);
  const b = new THREE.Box3();
  const v = new THREE.Vector3();
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (!m.isMesh || c.userData.noBounds) return;
    const p = m.geometry.getAttribute('position');
    for (let i = 0; i < p.count; i += 3) b.expandByPoint(v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld));
  });
  return b;
}

function randomPose(o: THREE.Object3D, scene: THREE.Scene, k: number) {
  scene.attach(o);
  o.position.set(Math.sin(k) * 20, 3 + Math.cos(k * 1.7) * 2, Math.cos(k) * 15);
  o.quaternion.setFromEuler(new THREE.Euler(k * 0.7, k * 1.3, -k * 0.4));
  o.updateMatrixWorld(true);
}

describe('break-up parts: contract', () => {
  let ac: Aircraft;
  beforeAll(() => {
    ac = createAircraft({ quality: 'low' });
    ac.setVisualState(st(), 1 / 60);
  });

  it('lists the major parts with plausible masses; fuel-carrying wings and the engine burn', () => {
    const parts = ac.getBreakupParts();
    expect(parts.map((p) => p.name).sort()).toEqual([...NAMES].sort());
    let total = 0;
    for (const p of parts) {
      expect(Number.isFinite(p.mass) && p.mass > 0).toBe(true);
      total += p.mass;
    }
    expect(total).toBeGreaterThan(700);
    expect(total).toBeLessThan(1200);
    const burning = parts.filter((p) => p.burning).map((p) => p.name).sort();
    expect(burning).toEqual(['engine', 'leftWing', 'rightWing']);
    expect(ac.getBreakupParts()).toEqual(parts); // stable
    for (const p of parts) expect(ac.getBreakupParts().find((q) => q.name === p.name)!.object).toBe(p.object);
  });

  it('parts are disjoint and together hold every mesh of the airframe', () => {
    const parts = ac.getBreakupParts();
    const owner = new Map<THREE.Object3D, string>();
    for (const p of parts) {
      let a = p.object.parent;
      while (a) {
        expect(parts.some((q) => q.object === a), `${p.name} is nested in another part`).toBe(false);
        a = a.parent;
      }
      p.object.traverse((o) => owner.set(o, p.name));
    }
    ac.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!(m.isMesh || (o as THREE.Points).isPoints)) return;
      if (LOOSE.has(o.name)) return;
      expect(owner.has(o), `mesh ${o.name || o.parent?.name} belongs to no part`).toBe(true);
    });
  });

  it('each part sits where it belongs on the airframe', () => {
    ac.root.position.set(0, 0, 0);
    ac.root.quaternion.identity();
    ac.setVisualState(st(), 1 / 60);
    const b = Object.fromEntries(ac.getBreakupParts().map((p) => [p.name, boundsOf(p.object)]));
    expect(b.leftWing.max.x).toBeLessThan(0.05);
    expect(b.leftWing.min.x).toBeLessThan(-5);
    expect(b.rightWing.min.x).toBeGreaterThan(-0.05);
    expect(b.rightWing.max.x).toBeGreaterThan(5);
    expect(b.tail.min.z).toBeGreaterThan(2.0); // the fin's dorsal fillet starts at z = 2.15
    expect(b.tail.max.z).toBeGreaterThan(5.9);
    expect(b.tail.max.x - b.tail.min.x).toBeGreaterThan(3);
    expect(b.engine.max.z).toBeLessThan(-1.2);
    expect(b.prop.max.z).toBeLessThan(-1.9);
    expect(b.noseGear.max.z).toBeLessThan(-0.3); // the drag brace reaches back under the cabin floor
    expect(b.noseGear.min.z).toBeLessThan(-1.1);
    expect(b.leftMainGear.max.x).toBeLessThan(0);
    expect(b.rightMainGear.min.x).toBeGreaterThan(0);
    expect(b.leftDoor.max.x).toBeLessThan(-0.25); // the door wraps up into the roof curve
    expect(b.rightDoor.min.x).toBeGreaterThan(0.25);
    for (const d of [b.leftDoor, b.rightDoor]) {
      expect(d.min.z).toBeGreaterThan(-1.1);
      expect(d.max.z).toBeLessThan(0.45);
      expect(d.max.y - d.min.y).toBeGreaterThan(0.9);
    }
    expect(b.fuselage.max.z - b.fuselage.min.z).toBeGreaterThan(6);
  });

  it('detach → restore returns every part to its parent, child slot and local transform', () => {
    const scene = new THREE.Scene();
    scene.add(ac.root);
    ac.setVisualState(st({ gearPos: 1, time: 1 }), 1 / 60);
    const before = snapshot(ac);
    const parts = ac.getBreakupParts();
    const slots = parts.map((p) => ({ parent: p.object.parent, index: p.object.parent!.children.indexOf(p.object), m: p.object.matrix.clone() }));
    parts.forEach((p, i) => randomPose(p.object, scene, i + 1));
    expect(snapshot(ac)).not.toEqual(before);
    ac.restoreBreakupParts();
    parts.forEach((p, i) => {
      expect(p.object.parent).toBe(slots[i].parent);
      expect(p.object.parent!.children.indexOf(p.object)).toBe(slots[i].index);
      p.object.updateMatrix();
      expect(p.object.matrix.equals(slots[i].m)).toBe(true);
    });
    expect(snapshot(ac)).toEqual(before);
    scene.remove(ac.root);
  });

  it('the model never writes a detached part\'s own transform (the crash system owns it)', () => {
    const scene = new THREE.Scene();
    scene.add(ac.root);
    const parts = ac.getBreakupParts();
    parts.forEach((p, i) => randomPose(p.object, scene, i + 3));
    const worlds = parts.map((p) => p.object.matrixWorld.clone());
    for (const v of [st({ crashed: true, crashAge: 0.5 }), st({ crashed: true, crashAge: 5, propRpm: 2400 }), st({ crashed: false, gearPos: 0.3 })]) {
      ac.setVisualState(v, 1 / 60);
      scene.updateMatrixWorld(true);
      parts.forEach((p, i) => expect(p.object.matrixWorld.equals(worlds[i]), p.name).toBe(true));
    }
    ac.restoreBreakupParts();
    ac.setVisualState(st(), 1 / 60);
    scene.remove(ac.root);
  });

  it('a crash with break-up, then reset, restores the intact aircraft exactly (wreck deformation included)', () => {
    const scene = new THREE.Scene();
    scene.add(ac.root);
    const v = st({ gearPos: 1, propRpm: 0, time: 2 });
    ac.setVisualState(v, 1 / 60);
    const before = snapshot(ac);
    const wing = ac.root.getObjectByName(PART.wingLeft) as THREE.Mesh;
    const intactWing = wing.geometry;
    ac.setVisualState(st({ crashed: true, crashAge: 0.1 }), 1 / 60);
    expect(wing.geometry).not.toBe(intactWing);
    const parts = ac.getBreakupParts();
    for (const [i, p] of parts.entries()) if (i % 2 === 0) randomPose(p.object, scene, i);
    ac.setVisualState(st({ crashed: true, crashAge: 6 }), 1 / 60);
    ac.restoreBreakupParts();
    ac.setVisualState(v, 1 / 60);
    expect(wing.geometry).toBe(intactWing);
    expect(snapshot(ac)).toEqual(before);
    scene.remove(ac.root);
  });

  it('dispose frees the geometry of parts that are still detached', () => {
    const a = createAircraft({ quality: 'low' });
    const scene = new THREE.Scene();
    scene.add(a.root);
    const parts = a.getBreakupParts();
    const door = parts.find((p) => p.name === 'leftDoor')!;
    scene.attach(door.object);
    const geos: THREE.BufferGeometry[] = [];
    door.object.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) geos.push(m.geometry);
    });
    let disposed = 0;
    for (const g of geos) g.addEventListener('dispose', () => disposed++);
    a.dispose();
    expect(disposed).toBe(geos.length);
    expect(door.object.parent).toBeNull();
  });
});

describe('property: any break-up / wreck / reset sequence ends in the intact aircraft', () => {
  let ac: Aircraft;
  let scene: THREE.Scene;
  let intact: number[];
  const base = st({ gearPos: 1, propRpm: 0, time: 3 });
  beforeAll(() => {
    ac = createAircraft({ quality: 'low' });
    scene = new THREE.Scene();
    scene.add(ac.root);
    ac.setVisualState(base, 1 / 60);
    intact = snapshot(ac);
  });

  const step = fc.oneof(
    fc.record({ kind: fc.constant('detach' as const), which: fc.integer({ min: 0, max: NAMES.length - 1 }), k: fc.double({ min: -5, max: 5, noNaN: true }) }),
    fc.record({ kind: fc.constant('frame' as const), crashed: fc.boolean(), age: fc.double({ min: 0, max: 20, noNaN: true }), gear: fc.double({ min: 0, max: 1, noNaN: true }) }),
    fc.record({ kind: fc.constant('restore' as const) }),
  );

  it('restore + an intact frame always gives back the exact intact model', () => {
    fc.assert(
      fc.property(fc.array(step, { minLength: 1, maxLength: 12 }), (steps) => {
        const parts = ac.getBreakupParts();
        for (const s of steps) {
          if (s.kind === 'detach') randomPose(parts[s.which].object, scene, s.k);
          else if (s.kind === 'frame') ac.setVisualState(st({ crashed: s.crashed, crashAge: s.age, gearPos: s.gear }), 1 / 60);
          else ac.restoreBreakupParts();
        }
        ac.restoreBreakupParts();
        ac.setVisualState(base, 1 / 60);
        expect(snapshot(ac)).toEqual(intact);
      }),
      fcParams(40),
    );
  });
});

describe('splitByTriangles (geometry partition)', () => {
  it('keeps every triangle exactly once, compacts vertices, and preserves attributes', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 12 }), fc.integer({ min: 2, max: 5 }), (w, h, n) => {
        const g = new THREE.PlaneGeometry(4, 2, w, h);
        const tris = g.index!.count / 3;
        const parts = splitByTriangles(g, n, (cx, cy) => Math.min(n - 1, Math.max(0, Math.floor(((cx + 2) / 4) * n + cy * 0.1))));
        expect(parts.length).toBe(n);
        let sum = 0;
        for (const p of parts) {
          if (!p) continue;
          sum += p.index!.count / 3;
          const pos = p.getAttribute('position');
          for (let i = 0; i < p.index!.count; i++) expect(p.index!.getX(i)).toBeLessThan(pos.count);
          expect(Object.keys(p.attributes).sort()).toEqual(Object.keys(g.attributes).sort());
        }
        expect(sum).toBe(tris);
      }),
      fcParams(60),
    );
  });
});
