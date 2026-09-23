/**
 * Functional: the whole 747-400 built in node — render budget (draw calls, triangles, shadow
 * casters) in every configuration, build time, the fleet entry, the lights, crash break-up parts
 * that cover the model and restore exactly, the wreck state, and disposal (every geometry and
 * material freed).
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createB747Model, B747_PART } from '../../../src/aircraft/b747';
import { getAircraftDef } from '../../../src/fleet';
import { createDefaultVisualState, createRestReadings, type AircraftVisualState } from '../../../src/aircraft/types';

function state(patch: Partial<AircraftVisualState> = {}): AircraftVisualState {
  return { ...createDefaultVisualState(), engineRunning: true, cameraMode: 'chase', instruments: { ...createRestReadings(), state: 'ground' }, ...patch };
}

/** Draw calls and triangles of the visible model (one call per visible mesh / points object), optionally skipping a subtree. */
function budget(root: THREE.Object3D, skip?: THREE.Object3D) {
  let calls = 0;
  let tris = 0;
  let casters = 0;
  root.traverseVisible((o) => {
    if (skip) {
      let inside = o === skip;
      o.traverseAncestors((a) => {
        if (a === skip) inside = true;
      });
      if (inside) return;
    }
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

describe('747 model: budget', () => {
  it('builds in well under a second (geometry in node; the browser adds the canvas painting)', () => {
    createB747Model().dispose();
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const m = createB747Model();
      times.push(performance.now() - t0);
      m.dispose();
    }
    expect(Math.min(...times)).toBeLessThan(700);
  }, 20000);

  it('the exterior stays within 80 draw calls, ≤ 30 shadow casters and 60–150 k triangles in every configuration (≤ 100 calls with the flight deck in the cockpit view)', () => {
    const m = createB747Model();
    const deck = m.root.getObjectByName(B747_PART.flightDeck)!;
    const air = { ...createRestReadings(), throttlePct: 100, state: 'airborne' as const, airspeedKt: 160 };
    const lights = { nav: true, strobe: true, beacon: true, landing: true, taxi: true };
    for (const v of [
      state({ gearPos: 1 }),
      state({ gearPos: 0.5, instruments: air, flapsDeg: 20 }),
      state({ gearPos: 0, speedBrake: 1, propRpm: 100, instruments: air }),
      state({ cameraMode: 'cockpit', gearPos: 1, lights }),
    ]) {
      for (let i = 0; i < 60; i++) m.setVisualState(v, 1 / 30);
      const b = budget(m.root, deck);
      expect(b.calls).toBeLessThanOrEqual(80);
      expect(budget(m.root).calls).toBeLessThanOrEqual(100);
      expect(b.casters).toBeLessThanOrEqual(30);
      expect(b.tris).toBeGreaterThan(60_000);
      expect(b.tris).toBeLessThan(150_000);
    }
    m.dispose();
  });

  it('the fleet 747 entry builds this model', () => {
    const def = getAircraftDef('b747');
    const model = def.createModel();
    expect(model.root.name).toBe(B747_PART.root);
    expect(model.root.getObjectByName(B747_PART.flightDeck)).toBeTruthy();
    expect(model.landingLight).toBeInstanceOf(THREE.SpotLight);
    model.dispose();
  });
});

describe('747 lights', () => {
  it('nav, strobes, beacons, landing and logo lights follow the switches; everything is dark on a wreck', () => {
    const m = createB747Model();
    const glow = m.root.getObjectByName(B747_PART.glows) as THREE.Points;
    const intensity = glow.geometry.getAttribute('intensity');
    const sum = () => {
      let s = 0;
      for (let i = 0; i < intensity.count; i++) s += intensity.getX(i);
      return s;
    };
    const off = { nav: false, strobe: false, beacon: false, landing: false, taxi: false };
    m.setVisualState(state({ lights: off }), 1 / 30);
    expect(sum()).toBe(0);
    expect(m.landingLight!.visible).toBe(false);
    m.setVisualState(state({ lights: { ...off, nav: true } }), 1 / 30);
    const navOnly = sum();
    expect(navOnly).toBeGreaterThan(2);
    m.setVisualState(state({ lights: { ...off, nav: true, landing: true } }), 1 / 30);
    expect(sum()).toBeGreaterThan(navOnly);
    expect(m.landingLight!.visible).toBe(true);
    // Beacons flash at some point within two seconds.
    let beacon = 0;
    for (let t = 0; t < 2; t += 0.02) {
      m.setVisualState(state({ lights: { ...off, beacon: true }, time: t }), 0.02);
      beacon = Math.max(beacon, sum());
    }
    expect(beacon).toBeGreaterThan(0.5);
    m.setVisualState(state({ lights: { nav: true, strobe: true, beacon: true, landing: true, taxi: true }, crashed: true, crashAge: 5 }), 1 / 30);
    expect(sum()).toBe(0);
    expect(m.landingLight!.visible).toBe(false);
    m.dispose();
  });
});

describe('747 crash break-up', () => {
  const EXPECTED = [
    'fuselage', 'forwardFuselage', 'aftFuselage', 'leftWing', 'rightWing', 'tail',
    'engine1', 'engine2', 'engine3', 'engine4', 'noseGear', 'leftWingGear', 'rightWingGear', 'leftBodyGear', 'rightBodyGear',
  ];

  it('exposes the major subtrees as disjoint parts with jumbo masses; wings, engines and the centre fuselage burn', () => {
    const m = createB747Model();
    const parts = m.getBreakupParts!();
    expect(parts.map((p) => p.name).sort()).toEqual([...EXPECTED].sort());
    expect(parts[0].name).toBe('fuselage');
    for (const p of parts) {
      expect(p.mass).toBeGreaterThan(500);
      for (const q of parts) {
        if (q === p) continue;
        let nested = false;
        q.object.traverseAncestors((a) => {
          if (a === p.object) nested = true;
        });
        expect(nested, `${q.name} inside ${p.name}`).toBe(false);
      }
    }
    expect(parts.filter((p) => p.burning).map((p) => p.name).sort()).toEqual(['engine1', 'engine2', 'engine3', 'engine4', 'fuselage', 'leftWing', 'rightWing']);
    const total = parts.reduce((s, p) => s + p.mass, 0);
    expect(total).toBeGreaterThan(180_000);
    expect(total).toBeLessThan(240_000);
    m.dispose();
  });

  it('the parts cover the model: every mesh belongs to exactly one part (except the light glows)', () => {
    const m = createB747Model();
    const owned = new Set<THREE.Object3D>();
    for (const p of m.getBreakupParts!()) p.object.traverse((o) => owned.add(o));
    const orphans: string[] = [];
    m.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if ((mesh.isMesh || (o as THREE.Points).isPoints) && !owned.has(o) && !o.userData.noBounds) orphans.push(o.name);
    });
    expect(orphans).toEqual([]);
    m.dispose();
  });

  it('detached parts restore exactly to their parents and local transforms', () => {
    const m = createB747Model();
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
      for (let k = 0; k < 16; k++) expect(p.object.matrixWorld.elements[k]).toBeCloseTo(before[i].world.elements[k], 5);
    });
    m.dispose();
    const m2 = createB747Model();
    scene.add(m2.root);
    const p2 = m2.getBreakupParts!();
    scene.attach(p2[3].object);
    m2.dispose();
    expect(p2[3].object.parent).toBeNull();
    expect(m2.root.parent).toBeNull();
  });

  it("each part's box is the size of the real piece", () => {
    const m = createB747Model();
    m.root.updateMatrixWorld(true);
    const size = (obj: THREE.Object3D) => {
      const box = new THREE.Box3().setFromObject(obj, true);
      return box.getSize(new THREE.Vector3());
    };
    const max: Record<string, number> = {
      fuselage: 30, forwardFuselage: 22, aftFuselage: 28, leftWing: 33, rightWing: 33, tail: 23,
      engine1: 17, engine2: 17, engine3: 17, engine4: 17, noseGear: 4, leftWingGear: 5, rightWingGear: 5, leftBodyGear: 5, rightBodyGear: 5,
    };
    for (const p of m.getBreakupParts!()) {
      const s = size(p.object);
      expect(Math.max(s.x, s.y, s.z), p.name).toBeLessThan(max[p.name]);
    }
    m.dispose();
  });

  it('a crashed jumbo chars, loses its glass, stops its fans and goes dark; reset brings it back', () => {
    const m = createB747Model();
    const glass = m.root.getObjectByName(B747_PART.cockpitGlass)!;
    m.setVisualState(state({ crashed: true, crashAge: 10, propRpm: 100 }), 1 / 30);
    expect(glass.visible).toBe(false);
    expect(m.root.getObjectByName(`${B747_PART.fan(1)}.disc`)!.visible).toBe(false);
    m.setVisualState(state({ crashed: false }), 1 / 30);
    expect(glass.visible).toBe(true);
    m.dispose();
  });
});

describe('747 dispose', () => {
  it('frees every geometry and material it created (counted through dispose events)', () => {
    const m = createB747Model();
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
    expect(geos.size).toBeGreaterThan(50);
  });
});
