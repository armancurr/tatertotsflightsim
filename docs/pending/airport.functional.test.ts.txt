/**
 * Functional: build the whole airport with three.js in node (geometry only, no
 * WebGL) and check the scene graph it produces.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { getLayout } from '../../../src/world/layout';
import { createAirport, countDrawCalls, AIRPORT_HEIGHTS } from '../../../src/world/airport';
import { PAPI_ANGLES } from '../../../src/world/airport/lights';

const layout = getLayout().airport;
const elev = layout.elevation;

function build(heightAt?: (x: number, z: number) => number) {
  const scene = new THREE.Scene();
  const sources: ((x: number, z: number) => number)[] = [];
  const env = { registerObstacleSource: (fn: (x: number, z: number) => number) => sources.push(fn) };
  const airport = createAirport(scene, env, heightAt ? { heightAt } : undefined);
  scene.updateMatrixWorld(true);
  return { scene, sources, airport };
}

const v = new THREE.Vector3();
const m = new THREE.Matrix4();
function forEachVertex(obj: THREE.Object3D, fn: (p: THREE.Vector3, o: THREE.Object3D) => void) {
  obj.traverse((o) => {
    const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    if (!g || !g.attributes.position) return;
    const pos = g.attributes.position;
    const inst = (o as THREE.InstancedMesh).isInstancedMesh ? (o as THREE.InstancedMesh) : null;
    const n = inst ? inst.count : 1;
    for (let k = 0; k < n; k++) {
      if (inst) {
        inst.getMatrixAt(k, m);
        m.premultiply(o.matrixWorld);
      } else m.copy(o.matrixWorld);
      for (let i = 0; i < pos.count; i++) fn(v.fromBufferAttribute(pos, i).applyMatrix4(m), o);
    }
  });
}

describe('createAirport (node, geometry only)', () => {
  const { scene, sources, airport } = build();

  it('adds one group and stays within the draw-call budget', () => {
    expect(scene.children.length).toBe(1);
    const calls = countDrawCalls(scene);
    expect(calls).toBeGreaterThan(5);
    expect(calls).toBeLessThanOrEqual(40);
  });

  it('uses instancing for the parked aircraft and the cars', () => {
    const inst: THREE.InstancedMesh[] = [];
    scene.traverse((o) => {
      if ((o as THREE.InstancedMesh).isInstancedMesh) inst.push(o as THREE.InstancedMesh);
    });
    expect(inst.length).toBeGreaterThanOrEqual(2);
    expect(inst.some((i) => i.name === 'parked-aircraft' && i.count >= 6)).toBe(true);
    expect(inst.some((i) => i.name === 'cars' && i.count >= 4)).toBe(true);
  });

  it('keeps every material fog-enabled so the atmosphere applies', () => {
    scene.traverse((o) => {
      const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!mat) return;
      for (const mm of Array.isArray(mat) ? mat : [mat]) expect((mm as THREE.MeshStandardMaterial).fog, `${o.name} fog`).toBe(true);
    });
  });

  it('puts nothing below the ground (foundations at most 0.3 m deep)', () => {
    let min = Infinity;
    let worst = '';
    forEachVertex(scene, (p, o) => {
      const d = p.y - elev;
      if (d < min) {
        min = d;
        worst = o.name;
      }
    });
    expect(min, worst).toBeGreaterThanOrEqual(-0.3);
  });

  it('floats the pavement above the terrain and the paint above the pavement', () => {
    const pave = scene.getObjectByName('pavement')!;
    const marks = scene.getObjectByName('markings')!;
    forEachVertex(pave, (p) => expect(p.y).toBeCloseTo(elev + AIRPORT_HEIGHTS.pavement, 6));
    forEachVertex(marks, (p) => expect(p.y).toBeCloseTo(elev + AIRPORT_HEIGHTS.markings, 6));
    expect(AIRPORT_HEIGHTS.markings).toBeGreaterThan(AIRPORT_HEIGHTS.pavement);
    expect(AIRPORT_HEIGHTS.pavement).toBeGreaterThan(AIRPORT_HEIGHTS.shoulder);
    expect(AIRPORT_HEIGHTS.shoulder).toBeGreaterThan(0);
  });

  it('registers an obstacle source so the tower is solid', () => {
    expect(sources.length).toBe(1);
    const t = layout.tower;
    expect(sources[0](t.center.x, t.center.z)).toBeGreaterThanOrEqual(elev + t.height);
    expect(sources[0](0, 0)).toBe(-Infinity);
  });

  it('update(): the PAPI for 36 shows 2 white / 2 red from a camera on the 3° path', () => {
    const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 90000);
    const papi = airport.papiState('36');
    const u0 = papi.units[0];
    const d = 1500;
    cam.position.set(u0.x, u0.y + d * Math.tan((3 * Math.PI) / 180), u0.z + d);
    cam.updateMatrixWorld();
    airport.update(cam, 10, 30);
    expect(airport.papiState('36').white).toBe(2);
    cam.position.y = u0.y + d * Math.tan((4 * Math.PI) / 180);
    airport.update(cam, 10.1, 30);
    expect(airport.papiState('36').white).toBe(4);
    cam.position.y = u0.y + d * Math.tan((2 * Math.PI) / 180);
    airport.update(cam, 10.2, 30);
    expect(airport.papiState('36').white).toBe(0);
    expect(PAPI_ANGLES.length).toBe(4);
  });

  it('update(): writes the PAPI colours into the light buffer (white units = white, red units = red)', () => {
    const cam = new THREE.PerspectiveCamera();
    const u0 = airport.papiState('36').units[0];
    cam.position.set(u0.x, u0.y + 1500 * Math.tan((3 * Math.PI) / 180), u0.z + 1500);
    airport.update(cam, 3, 20);
    const st = airport.papiState('36');
    for (const u of st.units) {
      const [r, g, b] = u.color;
      if (u.whiteness > 0.99) expect(Math.min(r, g, b)).toBeGreaterThan(0.8);
      if (u.whiteness < 0.01) {
        expect(r).toBeGreaterThan(0.8);
        expect(g).toBeLessThan(0.2);
      }
    }
  });

  it('update(): is cheap (no per-frame work proportional to geometry)', () => {
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(0, 300, 4000);
    const t0 = performance.now();
    for (let i = 0; i < 2000; i++) airport.update(cam, i / 60, 20);
    expect((performance.now() - t0) / 2000).toBeLessThan(0.2);
  });

  it('follows a non-flat heightAt (buildings sit on it, nothing buried)', () => {
    const slope = (x: number, z: number) => 30 + 0.002 * x - 0.001 * z;
    const b = build(slope);
    let min = Infinity;
    forEachVertex(b.scene, (p) => {
      min = Math.min(min, p.y - slope(p.x, p.z));
    });
    expect(min).toBeGreaterThanOrEqual(-0.35);
    const t = layout.tower;
    expect(b.sources[0](t.center.x, t.center.z)).toBeGreaterThanOrEqual(slope(t.center.x, t.center.z) + t.height - 0.01);
    b.airport.dispose();
  });

  it('dispose(): removes everything and clears the obstacles', () => {
    const b = build();
    b.airport.dispose();
    expect(b.scene.children.length).toBe(0);
    expect(b.sources[0](layout.tower.center.x, layout.tower.center.z)).toBe(-Infinity);
  });

  it('works without an environment', () => {
    const s = new THREE.Scene();
    const a = createAirport(s, null);
    expect(s.children.length).toBe(1);
    a.dispose();
  });
});
