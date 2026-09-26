/**
 * Functional: the whole Princess V50 model built in node — render budget (draw calls, triangles)
 * in every view and state, build time, crash break-up parts (disjoint, identity containers,
 * masses summing to the displacement) and their exact restore, the wreck and its reset,
 * robustness to bad inputs, and disposal of every geometry and material.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createV50Model, V50_PART } from '../../../src/vessels/v50';
import { createDefaultVisualState, type AircraftVisualState } from '../../../src/aircraft/types';
import { V50_AIRCRAFT } from '../../../src/config';
import type { PropulsorState, VesselState } from '../../../src/types';

function vessel(props: Partial<PropulsorState>[] = [{}, {}], tabs = 0): VesselState {
  return {
    seaTime: 0,
    propulsors: props.map((p) => ({ rpm: 0, n: 0, gear: 'neutral', thrust: 0, steerDeg: 0, load: 0, boost: 0, ...p })),
    tabs, mooring: null, speedMs: 0, leewayDeg: 0, trimDeg: 0, planing: 0, wettedLength: 0, wettedArea: 0,
    displacedVolume: 0, resistance: 0, depthUnderKeel: Infinity, aground: false, capsizeTime: 0, surfaceY: 0,
  };
}
function state(patch: Partial<AircraftVisualState> = {}): AircraftVisualState {
  return { ...createDefaultVisualState(), engineRunning: true, cameraMode: 'chase', vessel: vessel(), ...patch };
}
const running = (patch: Partial<AircraftVisualState> = {}) =>
  state({ vessel: vessel([{ n: 28, steerDeg: 8 }, { n: 28, steerDeg: 8 }], 0.6), ...patch });

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

describe('V50 model: budget', () => {
  it('builds in well under 300 ms (geometry in node; the browser adds the canvas painting)', () => {
    createV50Model().dispose(); // warm up
    let ms = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const m = createV50Model();
      ms = Math.min(ms, performance.now() - t0);
      m.dispose();
    }
    expect(ms).toBeLessThan(300);
  }, 30000);

  it('stays within 40 draw calls and 10–80 k triangles in every view and state', () => {
    const m = createV50Model();
    for (const v of [
      state(),
      running(),
      running({ cameraMode: 'cockpit', lights: { nav: true, strobe: true, beacon: true, landing: true, taxi: true } }),
      state({ crashed: true, crashAge: 8 }),
      state({ vessel: null }),
    ]) {
      for (let i = 0; i < 10; i++) m.setVisualState(v, 1 / 30);
      const b = budget(m.root);
      expect(b.calls).toBeLessThanOrEqual(40);
      expect(b.tris).toBeGreaterThan(10_000);
      expect(b.tris).toBeLessThan(80_000);
    }
    m.dispose();
  });

  it('major meshes cast shadows; static parts share materials (few programs)', () => {
    const m = createV50Model();
    for (const n of [V50_PART.shell, V50_PART.deck, V50_PART.hardtopFrame, V50_PART.platformBody]) {
      expect((m.root.getObjectByName(n) as THREE.Mesh).castShadow, n).toBe(true);
    }
    const mats = new Set<THREE.Material>();
    m.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh || (o as THREE.Points).isPoints) mats.add(mesh.material as THREE.Material);
    });
    expect(mats.size).toBeLessThanOrEqual(14);
    m.dispose();
  });
});

describe('V50 crash break-up', () => {
  const EXPECTED = ['hull', 'superstructure', 'swimPlatform', 'portPod', 'starboardPod'];

  it('exposes the major subtrees as disjoint identity containers; masses sum to the displacement; the hull burns', () => {
    const m = createV50Model();
    const parts = m.getBreakupParts!();
    expect(parts.map((p) => p.name).sort()).toEqual([...EXPECTED].sort());
    for (const p of parts) {
      expect(p.mass).toBeGreaterThan(50);
      expect(p.object.parent).toBe(m.root);
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
    expect(parts.filter((p) => p.burning).map((p) => p.name)).toEqual(['hull']);
    expect(Math.abs(parts.reduce((s, p) => s + p.mass, 0) - V50_AIRCRAFT.mass)).toBeLessThan(100);
    const mass = Object.fromEntries(parts.map((p) => [p.name, p.mass]));
    expect(mass.hull).toBeGreaterThan(mass.superstructure);
    expect(mass.superstructure).toBeGreaterThan(mass.swimPlatform);
    m.dispose();
  });

  it('detached parts (thrown about in the scene) restore exactly to their parents and local transforms', () => {
    const m = createV50Model();
    const scene = new THREE.Scene();
    scene.add(m.root);
    m.root.position.set(100, 50, -20);
    m.root.quaternion.setFromEuler(new THREE.Euler(0.2, 1.1, -0.4));
    m.setVisualState(running(), 1 / 30);
    m.root.updateMatrixWorld(true);
    const parts = m.getBreakupParts!();
    const before = parts.map((p) => ({ parent: p.object.parent, local: p.object.matrix.clone(), world: p.object.matrixWorld.clone(), index: p.object.parent!.children.indexOf(p.object) }));
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
      expect(p.object.parent!.children.indexOf(p.object)).toBe(before[i].index);
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
    const m2 = createV50Model();
    scene.add(m2.root);
    const p2 = m2.getBreakupParts!();
    scene.attach(p2[1].object);
    m2.dispose();
    expect(p2[1].object.parent).toBeNull();
    expect(m2.root.parent).toBeNull();
  });

  it('a crashed boat loses its glass, knocks its hardtop askew, stops its props and goes dark; reset brings it back', () => {
    const m = createV50Model();
    const glass = m.root.getObjectByName(V50_PART.glass)!;
    const hardtop = m.root.getObjectByName(V50_PART.hardtop)!;
    const nav = m.root.getObjectByName(V50_PART.navLights)!;
    const prop = m.root.getObjectByName(`${V50_PART.podPort}.propFwd`)!;
    m.setVisualState(running({ lights: { nav: true, strobe: false, beacon: false, landing: false, taxi: false } }), 1 / 30);
    expect(nav.visible).toBe(true);
    m.setVisualState(running({ crashed: true, crashAge: 10, lights: { nav: true, strobe: false, beacon: false, landing: false, taxi: false } }), 1 / 30);
    const a = prop.rotation.z;
    m.setVisualState(running({ crashed: true, crashAge: 10 }), 1 / 30);
    expect(prop.rotation.z).toBe(a);
    expect(glass.visible).toBe(false);
    expect(nav.visible).toBe(false);
    expect(hardtop.quaternion.angleTo(new THREE.Quaternion())).toBeGreaterThan(0.05);
    m.setVisualState(state({ crashed: false }), 1 / 30);
    expect(glass.visible).toBe(true);
    expect(hardtop.quaternion.angleTo(new THREE.Quaternion())).toBe(0);
    expect(hardtop.position.length()).toBe(0);
    m.dispose();
  });

  it('survives garbage input (NaN, huge, missing propulsors) without NaN transforms', () => {
    const m = createV50Model();
    const bad = [
      state({ vessel: vessel([{ n: NaN, steerDeg: Infinity }, { n: 1e9, steerDeg: -1e9 }], NaN) }),
      state({ vessel: { ...vessel(), propulsors: [] } }),
      state({ vessel: undefined, lights: undefined as unknown as AircraftVisualState['lights'] }),
    ];
    for (const v of bad) {
      expect(() => m.setVisualState(v, NaN)).not.toThrow();
      expect(() => m.setVisualState(v, 1e6)).not.toThrow();
      m.root.updateMatrixWorld(true);
      m.root.traverse((o) => {
        for (const e of o.matrixWorld.elements) expect(Number.isFinite(e), o.name).toBe(true);
      });
    }
    m.dispose();
  });

  it('dispose frees every geometry and material and detaches the model', () => {
    const m = createV50Model();
    const scene = new THREE.Scene();
    scene.add(m.root);
    const geos = new Set<THREE.BufferGeometry>();
    const mats = new Set<THREE.Material>();
    m.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) geos.add(mesh.geometry);
      if (mesh.material) mats.add(mesh.material as THREE.Material);
    });
    const freed = new Set<unknown>();
    for (const g of geos) g.addEventListener('dispose', () => freed.add(g));
    for (const x of mats) x.addEventListener('dispose', () => freed.add(x));
    m.dispose();
    for (const g of geos) expect(freed.has(g), g.uuid).toBe(true);
    for (const x of mats) expect(freed.has(x), x.name).toBe(true);
    expect(m.root.parent).toBeNull();
  });
});
