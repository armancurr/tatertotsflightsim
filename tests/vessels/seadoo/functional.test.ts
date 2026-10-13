/**
 * Functional: the whole Sea-Doo model built in node — render budget (≤ 25 draw calls, triangles) in
 * every view and state, build time, crash break-up parts (disjoint identity containers, masses
 * summing to craft + rider) and their exact restore, robustness to bad inputs, no per-frame
 * allocation of scene objects, and disposal of every geometry and material.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createSeadooModel, SEADOO_PART } from '../../../src/vessels/seadoo';
import { SEADOO_AIRCRAFT } from '../../../src/config';
import type { AircraftVisualState } from '../../../src/aircraft/types';
import { apply, budget, state, vessel } from './helpers';

const STATES: [string, AircraftVisualState][] = [
  ['idle', state({ bucket: 0.45 })],
  ['carve', state({ steerDeg: 22, bucket: 0, trimDeg: -4, speedMs: 18, rider: { lean: 1, foreAft: 0.4 } })],
  ['reverse', state({ bucket: 1, speedMs: -1.5, rider: { foreAft: -0.7 } })],
  ['jump', state({ steerDeg: 6, trimDeg: 8, speedMs: 22, rider: { foreAft: 1 }, jet: { nozzleClear: true, ventilation: 1 } })],
  ['spill', state({ rider: { aboard: false, off: 'spill', offTime: 1 } })],
  ['righting', state({ righting: 0.5, rider: { aboard: false, off: 'capsize', offTime: 4 } })],
  ['crashed', state({}, { crashed: true, crashAge: 5 })],
  ['no vessel', state({}, { vessel: null })],
  ['no rider state', state({ rider: null })],
];

describe('Sea-Doo model: budget', () => {
  it('builds in well under 150 ms', () => {
    createSeadooModel().dispose(); // warm up
    let ms = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const m = createSeadooModel();
      ms = Math.min(ms, performance.now() - t0);
      m.dispose();
    }
    expect(ms).toBeLessThan(150);
  }, 30000);

  it('stays within 25 draw calls (it uses ~11) and 15–90 k triangles in chase and cockpit, in every state', () => {
    const m = createSeadooModel();
    const seen: Record<string, number> = {};
    for (const [name, v] of STATES) {
      for (const cameraMode of ['chase', 'cockpit'] as const) {
        apply(m, { ...v, cameraMode }, 5);
        const b = budget(m.root);
        seen[`${name}/${cameraMode}`] = b.calls;
        expect(b.calls, `${name} ${cameraMode}`).toBeLessThanOrEqual(12);
        expect(b.tris, `${name} ${cameraMode}`).toBeGreaterThan(15_000);
        expect(b.tris, `${name} ${cameraMode}`).toBeLessThan(90_000);
      }
    }
    // The swimmer replaces the rider, never adds to it.
    expect(seen['spill/chase']).toBe(seen['idle/chase']);
    m.dispose();
  });

  it('few materials (paint, parts, rider, screen); the big meshes cast shadows', () => {
    const m = createSeadooModel();
    const mats = new Set<THREE.Material>();
    m.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mats.add(mesh.material as THREE.Material);
    });
    expect(mats.size).toBeLessThanOrEqual(4);
    for (const n of [SEADOO_PART.shell, SEADOO_PART.deck, SEADOO_PART.hoodShell, SEADOO_PART.seatCushion, SEADOO_PART.pod, SEADOO_PART.riderBody]) {
      expect((m.root.getObjectByName(n) as THREE.Mesh).castShadow, n).toBe(true);
    }
    m.dispose();
  });

  it('setVisualState allocates no scene objects and leaves the graph unchanged frame to frame', () => {
    const m = createSeadooModel();
    const count = () => {
      let n = 0;
      m.root.traverse(() => n++);
      return n;
    };
    apply(m, STATES[1][1]);
    const before = count();
    const geos = new Set<THREE.BufferGeometry>();
    m.root.traverse((o) => {
      if ((o as THREE.Mesh).geometry) geos.add((o as THREE.Mesh).geometry);
    });
    for (let i = 0; i < 50; i++) for (const [, v] of STATES) m.setVisualState(v, 1 / 60);
    expect(count()).toBe(before);
    m.root.traverse((o) => {
      if ((o as THREE.Mesh).geometry) expect(geos.has((o as THREE.Mesh).geometry)).toBe(true);
    });
    m.dispose();
  });
});

describe('Sea-Doo crash break-up', () => {
  const EXPECTED = ['hull', 'hood', 'seat', 'handlebars', 'rider'];

  it('exposes the major subtrees as disjoint identity containers; masses sum to craft + rider; the hull burns', () => {
    const m = createSeadooModel();
    const parts = m.getBreakupParts!();
    expect(parts.map((p) => p.name).sort()).toEqual([...EXPECTED].sort());
    for (const p of parts) {
      expect(p.mass).toBeGreaterThan(5);
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
    const total = parts.reduce((s, p) => s + p.mass, 0);
    expect(Math.abs(total - SEADOO_AIRCRAFT.mass)).toBeLessThan(1e-9);
    const mass = Object.fromEntries(parts.map((p) => [p.name, p.mass]));
    expect(mass.hull).toBeGreaterThan(300);
    expect(mass.rider).toBe(SEADOO_AIRCRAFT.watercraft!.rider!.mass);
    // Every mesh belongs to exactly one part (or is the swimmer).
    m.root.traverse((o) => {
      if (!(o as THREE.Mesh).isMesh) return;
      const owners = parts.filter((p) => {
        let inside = false;
        o.traverseAncestors((a) => {
          if (a === p.object) inside = true;
        });
        return inside;
      });
      if (o.name === SEADOO_PART.swimmerBody) expect(owners.length).toBe(0);
      else expect(owners.length, o.name).toBe(1);
    });
    m.dispose();
  });

  it('detached parts (thrown about in the scene) restore exactly to their parents and local transforms', () => {
    const m = createSeadooModel();
    const scene = new THREE.Scene();
    scene.add(m.root);
    m.root.position.set(100, 5, -20);
    m.root.quaternion.setFromEuler(new THREE.Euler(0.2, 1.1, -0.4));
    apply(m, STATES[1][1]);
    const parts = m.getBreakupParts!();
    const before = parts.map((p) => ({ parent: p.object.parent, local: p.object.matrix.clone(), world: p.object.matrixWorld.clone(), index: p.object.parent!.children.indexOf(p.object) }));
    parts.forEach((p, i) => {
      scene.attach(p.object);
      p.object.position.add(new THREE.Vector3(i * 3, 10 + i, -i * 2));
      p.object.rotateX(0.3 * i);
      p.object.rotateZ(-0.7 + i * 0.1);
      p.object.visible = i % 2 === 0;
    });
    // The model keeps animating the detached parts' children without trouble.
    apply(m, STATES[3][1]);
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
    m.dispose();
    // Disposing removes everything, including parts still lying around in the scene.
    const m2 = createSeadooModel();
    scene.add(m2.root);
    const p2 = m2.getBreakupParts!();
    scene.attach(p2[4].object);
    m2.dispose();
    expect(p2[4].object.parent).toBeNull();
    expect(m2.root.parent).toBeNull();
  });

  it('survives garbage input (NaN, huge, missing propulsors / jet / rider) without NaN transforms', () => {
    const m = createSeadooModel();
    const v = vessel({ steerDeg: NaN, bucket: NaN, trimDeg: Infinity, speedMs: NaN, rider: { lean: NaN, foreAft: -Infinity }, righting: NaN });
    const bad: AircraftVisualState[] = [
      state({}, { vessel: v }),
      state({ steerDeg: 1e9, bucket: -1e9, trimDeg: -1e9, rider: { lean: 1e9, foreAft: 1e9 } }),
      state({}, { vessel: { ...vessel(), propulsors: [] } }),
      state({}, { vessel: { ...vessel(), propulsors: [{ ...vessel().propulsors[0], jet: undefined }] } }),
      state({}, { vessel: { ...vessel(), surfaceY: NaN, rider: { lean: 0, foreAft: 0, aboard: false, off: 'spill', offTime: NaN } }, time: NaN }),
      state({}, { vessel: undefined, lights: undefined as unknown as AircraftVisualState['lights'], crashAge: NaN, crashed: true }),
    ];
    for (const s of bad) {
      expect(() => m.setVisualState(s, NaN)).not.toThrow();
      expect(() => m.setVisualState(s, 1e6)).not.toThrow();
      m.root.updateMatrixWorld(true);
      m.root.traverse((o) => {
        for (const e of o.matrixWorld.elements) expect(Number.isFinite(e), o.name).toBe(true);
      });
    }
    m.dispose();
  });

  it('dispose frees every geometry, material and the skeleton, and detaches the model', () => {
    const m = createSeadooModel();
    const scene = new THREE.Scene();
    scene.add(m.root);
    const geos = new Set<THREE.BufferGeometry>();
    const mats = new Set<THREE.Material>();
    let skeleton: THREE.Skeleton | null = null;
    m.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) geos.add(mesh.geometry);
      if (mesh.material) mats.add(mesh.material as THREE.Material);
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) skeleton = (o as THREE.SkinnedMesh).skeleton;
    });
    const freed = new Set<unknown>();
    for (const g of geos) g.addEventListener('dispose', () => freed.add(g));
    for (const x of mats) x.addEventListener('dispose', () => freed.add(x));
    expect(skeleton).not.toBeNull();
    const sk = skeleton as unknown as THREE.Skeleton;
    sk.computeBoneTexture();
    const tex = sk.boneTexture!;
    tex.addEventListener('dispose', () => freed.add(tex));
    m.dispose();
    for (const g of geos) expect(freed.has(g), g.uuid).toBe(true);
    for (const x of mats) expect(freed.has(x), x.name).toBe(true);
    expect(freed.has(tex)).toBe(true);
    expect(m.root.parent).toBeNull();
  });
});
