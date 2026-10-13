/**
 * Functional: the whole MS Tater Star model built in node — render budget (draw calls, triangles)
 * in every view and state, the distant LOD, build time, crash break-up parts (disjoint identity
 * containers, masses summing to the displacement) and their exact restore, the wreck and its reset,
 * robustness to bad inputs, the pure animation mapping, and disposal of every geometry and material.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createCruiseModel, CRUISE_PART, computeCruiseAnim, createCruiseAnim, SHAFT_INDEX, THRUSTER_INDEX, DETAIL_DISTANCE } from '../../../src/vessels/cruise';
import { createDefaultVisualState, type AircraftVisualState } from '../../../src/aircraft/types';
import { CRUISE_AIRCRAFT } from '../../../src/config';
import type { PropulsorState, VesselState } from '../../../src/types';

const WC = CRUISE_AIRCRAFT.watercraft!;

function vessel(patch: (i: number) => Partial<PropulsorState> = () => ({})): VesselState {
  return {
    seaTime: 0,
    propulsors: WC.propulsors.map((_p, i) => ({ rpm: 0, n: 0, gear: 'neutral', thrust: 0, steerDeg: 0, load: 0, boost: 0, ...patch(i) })),
    tabs: 0, mooring: null, speedMs: 0, leewayDeg: 0, trimDeg: 0, planing: 0, wettedLength: 0, wettedArea: 0,
    displacedVolume: 0, resistance: 0, depthUnderKeel: Infinity, aground: false, touching: false, capsizeTime: 0, surfaceY: 0,
  };
}
function state(patch: Partial<AircraftVisualState> = {}): AircraftVisualState {
  return { ...createDefaultVisualState(), engineRunning: true, cameraMode: 'chase', vessel: vessel(), ...patch };
}
const running = (patch: Partial<AircraftVisualState> = {}) => state({ vessel: vessel((i) => (WC.propulsors[i].type === 'shaft' ? { n: 2.3, steerDeg: 20 } : { thrust: 1e5 })), ...patch });

/** Draw calls and triangles of the visible model (one call per visible mesh / points; LODs as the renderer would pick them). */
function budget(root: THREE.Object3D, camera?: THREE.Camera) {
  root.updateMatrixWorld(true);
  if (camera) root.traverse((o) => (o as THREE.LOD).isLOD && (o as THREE.LOD).update(camera));
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
function cameraAt(d: number): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera();
  c.position.set(d * 0.6, d * 0.3, d * 0.74);
  c.updateMatrixWorld(true);
  return c;
}

describe('Tater Star model: budget', () => {
  it('builds in well under half a second (geometry in node)', () => {
    createCruiseModel().dispose();
    let ms = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const m = createCruiseModel();
      ms = Math.min(ms, performance.now() - t0);
      m.dispose();
    }
    expect(ms).toBeLessThan(500);
  }, 30000);

  it('stays within 30 draw calls (brief: ≤ 60) and 20–150 k triangles in every view and state', () => {
    const m = createCruiseModel();
    for (const v of [
      state(),
      running(),
      running({ cameraMode: 'cockpit', lights: { nav: true, strobe: true, beacon: true, landing: true, taxi: true } }),
      state({ crashed: true, crashAge: 8 }),
      state({ vessel: null }),
    ]) {
      for (let i = 0; i < 5; i++) m.setVisualState(v, 1 / 30);
      const b = budget(m.root, cameraAt(300));
      expect(b.calls).toBeLessThanOrEqual(30);
      expect(b.tris).toBeGreaterThan(20_000);
      expect(b.tris).toBeLessThan(150_000);
    }
    m.dispose();
  });

  it('from kilometres away the small parts drop out (LOD): fewer calls and triangles, the hull and walls stay', () => {
    const m = createCruiseModel();
    const near = budget(m.root, cameraAt(300));
    const far = budget(m.root, cameraAt(DETAIL_DISTANCE * 2));
    expect(far.calls).toBeLessThan(near.calls);
    expect(far.tris).toBeLessThan(near.tris * 0.85);
    for (const n of [CRUISE_PART.shell, CRUISE_PART.walls, CRUISE_PART.funnelBody]) {
      let visible = true;
      m.root.getObjectByName(n)!.traverseAncestors((a) => (visible &&= a.visible));
      expect(visible && m.root.getObjectByName(n)!.visible, n).toBe(true);
    }
    let boats = true;
    const b = m.root.getObjectByName(CRUISE_PART.boats)!;
    b.traverseAncestors((a) => (boats &&= a.visible));
    expect(boats).toBe(false);
    m.dispose();
  });

  it('major meshes cast shadows; few materials (few programs)', () => {
    const m = createCruiseModel();
    for (const n of [CRUISE_PART.shell, CRUISE_PART.walls, CRUISE_PART.decks, CRUISE_PART.funnelBody]) {
      expect((m.root.getObjectByName(n) as THREE.Mesh).castShadow, n).toBe(true);
    }
    const mats = new Set<THREE.Material>();
    m.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh || (o as THREE.Points).isPoints) mats.add(mesh.material as THREE.Material);
    });
    expect(mats.size).toBeLessThanOrEqual(10);
    m.dispose();
  });
});

describe('Tater Star crash break-up', () => {
  const EXPECTED = ['hull', 'superstructure', 'funnel', 'portScrew', 'starboardScrew'];

  it('exposes the major subtrees as disjoint identity containers; masses sum to the displacement', () => {
    const m = createCruiseModel();
    const parts = m.getBreakupParts!();
    expect(parts.map((p) => p.name).sort()).toEqual([...EXPECTED].sort());
    for (const p of parts) {
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
    expect(Math.abs(parts.reduce((s, p) => s + p.mass, 0) - CRUISE_AIRCRAFT.mass)).toBeLessThan(1000);
    const mass = Object.fromEntries(parts.map((p) => [p.name, p.mass]));
    expect(mass.hull).toBeGreaterThan(mass.superstructure);
    expect(mass.superstructure).toBeGreaterThan(mass.funnel);
    m.dispose();
  });

  it('detached parts restore exactly to their parents and local transforms', () => {
    const m = createCruiseModel();
    const scene = new THREE.Scene();
    scene.add(m.root);
    m.root.position.set(100, 5, -20);
    m.root.updateMatrixWorld(true);
    const parts = m.getBreakupParts!();
    const before = parts.map((p) => ({ parent: p.object.parent, local: p.object.matrix.clone(), index: p.object.parent!.children.indexOf(p.object) }));
    parts.forEach((p, i) => {
      scene.attach(p.object);
      p.object.position.add(new THREE.Vector3(i * 30, 10 + i, -i * 20));
      p.object.rotateX(0.3 * i);
      p.object.visible = i % 2 === 0;
    });
    m.restoreBreakupParts!();
    parts.forEach((p, i) => {
      expect(p.object.parent).toBe(before[i].parent);
      expect(p.object.parent!.children.indexOf(p.object)).toBe(before[i].index);
      expect(p.object.visible).toBe(true);
      p.object.updateMatrix();
      for (let k = 0; k < 16; k++) expect(p.object.matrix.elements[k]).toBeCloseTo(before[i].local.elements[k], 9);
    });
    m.dispose();
  });

  it('a wreck loses its bridge glass, stops its props, centres its rudders and goes dark; reset brings it back', () => {
    const m = createCruiseModel();
    const glass = m.root.getObjectByName(CRUISE_PART.glass)!;
    const nav = m.root.getObjectByName(CRUISE_PART.navLights)!;
    const blades = m.root.getObjectByName('cruise.screw.port.blades')!;
    const rudder = m.root.getObjectByName('cruise.rudder.port')!;
    m.setVisualState(running({ lights: { nav: true, strobe: false, beacon: false, landing: false, taxi: false } }), 1 / 30);
    expect(nav.visible).toBe(true);
    expect(rudder.rotation.y).not.toBe(0);
    m.setVisualState(running({ crashed: true, crashAge: 10, lights: { nav: true, strobe: false, beacon: false, landing: false, taxi: false } }), 1 / 30);
    const a = blades.rotation.z;
    m.setVisualState(running({ crashed: true, crashAge: 10 }), 1 / 30);
    expect(blades.rotation.z).toBe(a);
    expect(rudder.rotation.y).toBe(0);
    expect(glass.visible).toBe(false);
    expect(nav.visible).toBe(false);
    m.setVisualState(state({ crashed: false }), 1 / 30);
    expect(glass.visible).toBe(true);
    m.dispose();
  });

  it('survives garbage input (NaN, huge, missing propulsors) without NaN transforms', () => {
    const m = createCruiseModel();
    const bad = [
      state({ vessel: vessel(() => ({ n: NaN, steerDeg: Infinity, thrust: -Infinity })) }),
      state({ vessel: vessel(() => ({ n: 1e9, steerDeg: -1e9, thrust: 1e12 })) }),
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
    const m = createCruiseModel();
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

describe('Tater Star animation mapping (pure)', () => {
  it('maps rudders (rad, clamped), props (rev/s) and thruster fractions; neutral without a vessel or when wrecked', () => {
    const a = createCruiseAnim();
    computeCruiseAnim(state({ vessel: vessel((i) => (WC.propulsors[i].type === 'shaft' ? { steerDeg: 30, n: 2 } : { thrust: -WC.propulsors[i].thruster!.maxThrustN / 2 })) }), a);
    expect(a.rudder.length).toBe(SHAFT_INDEX.length);
    expect(a.thrust.length).toBe(THRUSTER_INDEX.length);
    for (const r of a.rudder) expect(r).toBeCloseTo((30 * Math.PI) / 180, 9);
    for (const n of a.n) expect(n).toBe(2);
    for (const t of a.thrust) expect(t).toBeCloseTo(-0.5, 9);
    computeCruiseAnim(state({ vessel: vessel(() => ({ steerDeg: 400 })) }), a);
    for (const r of a.rudder) expect(r).toBeLessThanOrEqual(((WC.propulsors[0].maxSteerDeg + 2) * Math.PI) / 180);
    computeCruiseAnim(state({ vessel: null }), a);
    expect([...a.rudder, ...a.n, ...a.thrust].every((x) => x === 0)).toBe(true);
    computeCruiseAnim(state({ crashed: true, vessel: vessel(() => ({ steerDeg: 20, n: 2, thrust: 1e5 })) }), a);
    expect([...a.rudder, ...a.n, ...a.thrust].every((x) => x === 0)).toBe(true);
  });
});
