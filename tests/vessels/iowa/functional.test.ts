/**
 * Functional: the whole USS Iowa model built in node — the render budget (draw calls, triangles) in
 * every view and state and from afar (the detail LODs drop out), build time, few shared materials,
 * the crash break-up parts (bow, stern, superstructure, three turrets: disjoint identity containers,
 * masses summing to the displacement) and their exact restore, the wreck and its reset, robustness
 * to bad inputs, a per-frame update that allocates nothing, and disposal of every geometry and
 * material.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createIowaModel, IOWA_DETAIL_DISTANCE, IOWA_PART } from '../../../src/vessels/iowa';
import { createDefaultVisualState, type AircraftVisualState } from '../../../src/aircraft/types';
import { IOWA_AIRCRAFT, IOWA_WEAPONS } from '../../../src/config';
import type { TurretStatus } from '../../../src/combat/types';
import type { PropulsorState, VesselState } from '../../../src/types';

const T = IOWA_WEAPONS.naval!.turrets;

function vessel(p: Partial<PropulsorState> = {}): VesselState {
  return {
    seaTime: 0, propulsors: [0, 1, 2, 3].map(() => ({ rpm: 0, n: 0, gear: 'neutral' as const, thrust: 0, steerDeg: 0, load: 0, boost: 0, ...p })), tabs: 0, mooring: null,
    speedMs: 0, leewayDeg: 0, trimDeg: 0, planing: 0, wettedLength: 0, wettedArea: 0, displacedVolume: 0, resistance: 0, depthUnderKeel: Infinity,
    aground: false, touching: false, capsizeTime: 0, surfaceY: 0,
  };
}
const firing = (): TurretStatus[] => T.map((t) => ({ trainDeg: t.stowDeg + 30, elevDeg: 20, recoil: new Array(t.barrels).fill(0.8), flash: new Array(t.barrels).fill(1), ready: new Array(t.barrels).fill(false) }));
function state(patch: Partial<AircraftVisualState> = {}): AircraftVisualState {
  return { ...createDefaultVisualState(), engineRunning: true, cameraMode: 'chase', vessel: vessel(), turrets: null, ...patch };
}

/** Draw calls and triangles of the visible model, with each LOD resolved for a camera `dist` metres away. */
function budget(root: THREE.Object3D, dist = 200) {
  const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 1e5);
  root.updateMatrixWorld(true);
  const p = new THREE.Vector3().setFromMatrixPosition(root.matrixWorld);
  cam.position.set(p.x + dist, p.y + dist * 0.3, p.z);
  cam.updateMatrixWorld(true);
  root.traverse((o) => {
    if ((o as THREE.LOD).isLOD) (o as THREE.LOD).update(cam);
  });
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

describe('Iowa model: budget', () => {
  it('builds in well under a second', () => {
    createIowaModel().dispose(); // warm up
    let ms = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const m = createIowaModel();
      ms = Math.min(ms, performance.now() - t0);
      m.dispose();
    }
    expect(ms).toBeLessThan(1000);
  }, 60000);

  it('stays within ~50 draw calls and 30–150 k triangles in every view and state (budget 80)', () => {
    const m = createIowaModel();
    for (const v of [
      state(),
      state({ vessel: vessel({ n: 3.3, steerDeg: 20 }), turrets: firing() }),
      state({ cameraMode: 'cockpit', lights: { nav: true, strobe: true, beacon: true, landing: true, taxi: true }, turrets: firing() }),
      state({ crashed: true, crashAge: 8 }),
      state({ vessel: null, turrets: null }),
    ]) {
      for (let i = 0; i < 5; i++) m.setVisualState(v, 1 / 30);
      const b = budget(m.root);
      expect(b.calls).toBeLessThanOrEqual(50);
      expect(b.tris).toBeGreaterThan(30_000);
      expect(b.tris).toBeLessThan(150_000);
    }
    m.dispose();
  });

  it('from afar (an aerial view) the rails, lifelines and small fittings drop out', () => {
    const m = createIowaModel();
    m.setVisualState(state(), 1 / 30);
    const near = budget(m.root, 300);
    const far = budget(m.root, IOWA_DETAIL_DISTANCE * 2);
    expect(far.calls).toBeLessThan(near.calls);
    expect(far.tris).toBeLessThan(near.tris - 5000);
    for (const n of [IOWA_PART.fittingsBow, IOWA_PART.fittingsStern, IOWA_PART.superDetails]) {
      budget(m.root, 300);
      expect(m.root.getObjectByName(n)!.visible, n).toBe(true);
      budget(m.root, IOWA_DETAIL_DISTANCE * 2);
      expect(m.root.getObjectByName(n)!.visible, n).toBe(false);
    }
    m.dispose();
  });

  it('the big meshes cast shadows; everything shares a handful of materials', () => {
    const m = createIowaModel();
    for (const n of [IOWA_PART.shellBow, IOWA_PART.shellStern, IOWA_PART.superMain, `${IOWA_PART.turret(0)}.house`, `${IOWA_PART.turret(2)}.gun1`]) {
      expect((m.root.getObjectByName(n) as THREE.Mesh).castShadow, n).toBe(true);
    }
    const mats = new Set<THREE.Material>();
    m.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh || (o as THREE.Points).isPoints) mats.add(mesh.material as THREE.Material);
    });
    expect(mats.size).toBeLessThanOrEqual(10);
    // all nine guns share one geometry
    const guns = new Set<THREE.BufferGeometry>();
    T.forEach((_t, i) => [0, 1, 2].forEach((k) => guns.add((m.root.getObjectByName(`${IOWA_PART.turret(i)}.gun${k}`) as THREE.Mesh).geometry)));
    expect(guns.size).toBe(1);
    m.dispose();
  });

  it('a frame update allocates no new objects (steady state)', () => {
    const m = createIowaModel();
    const v = state({ vessel: vessel({ n: 2, steerDeg: 10 }), turrets: firing() });
    for (let i = 0; i < 50; i++) m.setVisualState(v, 1 / 60);
    // three.js objects created per frame would show up as new ids; count the scene graph instead
    let before = 0;
    m.root.traverse(() => before++);
    for (let i = 0; i < 200; i++) m.setVisualState(v, 1 / 60);
    let after = 0;
    m.root.traverse(() => after++);
    expect(after).toBe(before);
    m.dispose();
  });
});

describe('Iowa crash break-up', () => {
  const EXPECTED = ['bow', 'stern', 'superstructure', 'turretI', 'turretII', 'turretIII'];

  it('exposes bow, stern, superstructure and the three turrets as disjoint identity containers; masses sum to the displacement', () => {
    const m = createIowaModel();
    const parts = m.getBreakupParts!();
    expect(parts.map((p) => p.name).sort()).toEqual([...EXPECTED].sort());
    for (const p of parts) {
      expect(p.mass).toBeGreaterThan(1e6);
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
    expect(Math.abs(parts.reduce((s, p) => s + p.mass, 0) - IOWA_AIRCRAFT.mass)).toBeLessThan(1000);
    const mass = Object.fromEntries(parts.map((p) => [p.name, p.mass]));
    expect(mass.stern).toBeGreaterThan(mass.superstructure);
    expect(mass.bow).toBeGreaterThan(mass.turretI);
    m.dispose();
  });

  it('detached parts restore exactly to their parents and local transforms; the wreck darkens and resets', () => {
    const m = createIowaModel();
    const scene = new THREE.Scene();
    scene.add(m.root);
    const parts = m.getBreakupParts!();
    const shell = m.root.getObjectByName(IOWA_PART.superMain) as THREE.Mesh;
    const saved = parts.map((p) => ({ parent: p.object.parent, idx: p.object.parent!.children.indexOf(p.object), m: p.object.matrix.clone() }));
    for (const p of parts) {
      scene.attach(p.object);
      p.object.position.add(new THREE.Vector3(Math.random() * 50, 20, -30));
      p.object.rotation.set(0.5, 1, -0.3);
    }
    m.setVisualState(state({ crashed: true, crashAge: 20 }), 1 / 30);
    const gray = (shell.material as THREE.MeshStandardMaterial).color.r;
    expect(gray).toBeLessThan(0.5);
    m.restoreBreakupParts!();
    m.setVisualState(state(), 1 / 30);
    parts.forEach((p, i) => {
      expect(p.object.parent).toBe(saved[i].parent);
      expect(p.object.parent!.children.indexOf(p.object)).toBe(saved[i].idx);
      p.object.updateMatrix();
      expect(p.object.matrix.equals(saved[i].m)).toBe(true);
    });
    expect((shell.material as THREE.MeshStandardMaterial).color.r).toBeCloseTo(1, 6);
    m.dispose();
  });
});

describe('Iowa model: robustness and disposal', () => {
  it('bad inputs (NaN, huge, short arrays, missing sections) never produce NaN transforms', () => {
    const m = createIowaModel();
    const junk: AircraftVisualState[] = [
      state({ vessel: vessel({ n: Number.NaN, steerDeg: Number.POSITIVE_INFINITY }) }),
      state({ vessel: { ...vessel(), propulsors: [] } }),
      state({ turrets: [{ trainDeg: Number.NaN, elevDeg: 1e9, recoil: [Number.NaN], flash: [-5], ready: [] }] as TurretStatus[] }),
      state({ vessel: undefined, turrets: undefined, lights: undefined as unknown as AircraftVisualState['lights'] }),
    ];
    for (const v of junk) {
      m.setVisualState(v, Number.NaN);
      m.setVisualState(v, 1e6);
      m.root.updateMatrixWorld(true);
      m.root.traverse((o) => {
        for (const e of o.matrixWorld.elements) expect(Number.isFinite(e), o.name).toBe(true);
      });
    }
    m.dispose();
  });

  it('dispose() frees every geometry and material exactly once', () => {
    const m = createIowaModel();
    const geos = new Set<THREE.BufferGeometry>();
    const mats = new Set<THREE.Material>();
    m.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) geos.add(mesh.geometry);
      if (mesh.material) mats.add(mesh.material as THREE.Material);
    });
    const disposed = new Set<unknown>();
    for (const g of geos) g.addEventListener('dispose', () => disposed.add(g));
    for (const x of mats) x.addEventListener('dispose', () => disposed.add(x));
    m.dispose();
    expect(disposed.size).toBe(geos.size + mats.size);
  });
});
