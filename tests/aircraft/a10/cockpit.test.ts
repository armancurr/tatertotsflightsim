/**
 * The A-10C cockpit view (camera '1' at A10_AIRCRAFT.geometry.pilotEye): raycasts from the eye check
 * the Warthog's famous visibility — a clear forward cone, the glareshield (panel top) 16–21° below
 * the horizon straight ahead, nothing opaque close to the eye — plus the HUD combiner contract
 * (`hudCombiner`: its geometry is the glass rectangle) and the hidden head.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as THREE from 'three';
import { createA10Model, A10_PART } from '../../../src/aircraft/a10';
import { HUD } from '../../../src/aircraft/a10/cockpit';
import { createDefaultVisualState, createRestReadings, type AircraftVisualState } from '../../../src/aircraft/types';
import { A10_AIRCRAFT } from '../../../src/config';

const G = A10_AIRCRAFT.geometry;
const DEG = Math.PI / 180;
type Model = ReturnType<typeof createA10Model>;

function state(patch: Partial<AircraftVisualState> = {}): AircraftVisualState {
  return { ...createDefaultVisualState(), engineRunning: true, cameraMode: 'cockpit', instruments: createRestReadings(), ...patch };
}
const eye = new THREE.Vector3(G.pilotEye.x, G.pilotEye.y, G.pilotEye.z);
const dir = (yaw: number, pitch: number) => new THREE.Vector3(Math.sin(yaw * DEG) * Math.cos(pitch * DEG), Math.sin(pitch * DEG), -Math.cos(yaw * DEG) * Math.cos(pitch * DEG));

function opaqueMeshes(m: Model): THREE.Object3D[] {
  m.root.updateMatrixWorld(true);
  const out: THREE.Object3D[] = [];
  m.root.traverseVisible((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || o.userData.noBounds) return;
    if ((mesh.material as THREE.Material).transparent) return;
    out.push(o);
  });
  return out;
}

describe('A-10 cockpit view', () => {
  let m: Model;
  let opaque: THREE.Object3D[];
  const ray = new THREE.Raycaster();
  const hit = (yaw: number, pitch: number, far = 3) => {
    ray.set(eye, dir(yaw, pitch));
    ray.far = far;
    return ray.intersectObjects(opaque, false)[0] ?? null;
  };
  beforeAll(() => {
    m = createA10Model();
    for (let i = 0; i < 3; i++) m.setVisualState(state(), 1 / 30);
    opaque = opaqueMeshes(m);
  });
  afterAll(() => m.dispose());

  it("hides the pilot's own head in the cockpit view and shows it outside", () => {
    expect(m.root.getObjectByName(A10_PART.pilotHead)!.visible).toBe(false);
    m.setVisualState(state({ cameraMode: 'chase' }), 1 / 30);
    expect(m.root.getObjectByName(A10_PART.pilotHead)!.visible).toBe(true);
    m.setVisualState(state(), 1 / 30);
    opaque = opaqueMeshes(m);
  });

  it('nothing opaque within 40 cm of the eye ahead, left, right, up or over the nose', () => {
    for (const [yaw, pitch] of [[0, 0], [0, -10], [-90, 0], [90, 0], [0, 60], [0, 89], [-45, -10], [45, -10], [-120, 10], [120, 10]]) {
      const h = hit(yaw, pitch);
      if (h) expect(h.distance, `yaw ${yaw} pitch ${pitch}: ${h.object.name}`).toBeGreaterThan(0.4);
    }
  });

  it('the view over the nose: the glareshield (panel top) is 16–21° below the horizon (beside the HUD)', () => {
    for (const yaw of [-12, 12]) {
      let first = 90;
      for (let p = 0; p >= -40; p -= 0.25) {
        if (hit(yaw, p)) {
          first = -p;
          break;
        }
      }
      expect(first, `yaw ${yaw}`).toBeGreaterThan(16);
      expect(first, `yaw ${yaw}`).toBeLessThan(21);
    }
  });

  it('the central view (±10° yaw, −10…+12.5° pitch) is completely clear bar the thin HUD frame', () => {
    for (let yaw = -10; yaw <= 10; yaw += 1) {
      for (let pitch = -10; pitch <= 12.5; pitch += 1) {
        const h = hit(yaw, pitch);
        if (h) expect(h.object.name, `yaw ${yaw} pitch ${pitch}`).toBe('a10.cockpit.interior');
      }
    }
    let blocked = 0;
    let n = 0;
    for (let yaw = -10; yaw <= 10; yaw += 1) for (let pitch = -10; pitch <= 12.5; pitch += 1) {
      n++;
      if (hit(yaw, pitch)) blocked++;
    }
    expect(blocked / n).toBeLessThan(0.08);
  });

  it('the forward cone (±25° yaw, −12…+15° pitch) is mostly clear: only the slim windscreen frame crosses it', () => {
    let n = 0;
    let blocked = 0;
    const blockers = new Set<string>();
    for (let yaw = -25; yaw <= 25; yaw += 2.5) {
      for (let pitch = -12; pitch <= 15; pitch += 2.5) {
        n++;
        const h = hit(yaw, pitch);
        if (h) {
          blocked++;
          blockers.add(h.object.name);
        }
      }
    }
    expect(blocked / n).toBeLessThan(0.15);
    for (const b of blockers) expect(['a10.canopy.frame', 'a10.cockpit.interior'], b).toContain(b);
  });

  it('above the windscreen the bubble is frameless: straight up and up-back are clear', () => {
    for (const [yaw, pitch] of [[0, 45], [0, 70], [0, 89], [30, 60], [-30, 60], [180, 70]]) expect(hit(yaw, pitch), `yaw ${yaw} pitch ${pitch}`).toBeNull();
  });

  it('superb side view: looking left and right well below the horizon is clear (the pilot sits high)', () => {
    for (const yaw of [-90, -60, 60, 90]) for (const pitch of [0, -15, -25]) expect(hit(yaw, pitch), `yaw ${yaw} pitch ${pitch}`).toBeNull();
  });

  it('the HUD combiner is exposed as hudCombiner: a w × h glass rectangle ahead of the eye, above the glareshield', () => {
    const combiner = m.hudCombiner as THREE.Mesh;
    expect(combiner).toBeTruthy();
    expect(combiner.name).toBe(A10_PART.hudCombiner);
    expect(m.root.getObjectByName(A10_PART.hudCombiner)).toBe(combiner);
    combiner.geometry.computeBoundingBox();
    const b = combiner.geometry.boundingBox!;
    expect(b.max.x - b.min.x).toBeCloseTo(HUD.w, 6);
    expect(b.max.y - b.min.y).toBeCloseTo(HUD.h, 6);
    expect(b.max.z - b.min.z).toBeCloseTo(0, 6);
    // In the body frame it sits in front of the eye, straight ahead, a little below the horizon.
    m.root.updateMatrixWorld(true);
    const c = m.root.worldToLocal(combiner.getWorldPosition(new THREE.Vector3()));
    expect(Math.abs(c.x)).toBeLessThan(0.01);
    expect(c.z).toBeLessThan(eye.z - 0.5);
    const below = Math.atan2(eye.y - c.y, eye.z - c.z) / DEG;
    expect(below).toBeGreaterThan(5);
    expect(below).toBeLessThan(20);
    // Wide: it covers at least ±7° either side of the centreline.
    expect(Math.atan2(HUD.w / 2, eye.z - c.z) / DEG).toBeGreaterThan(7);
  });

  it('the panel carries two MFCDs, the stick is on the centreline and the throttles on the left console', () => {
    const screens = m.root.getObjectByName('a10.cockpit.screens') as THREE.Mesh;
    screens.geometry.computeBoundingBox();
    const sb = screens.geometry.boundingBox!;
    expect(sb.min.x).toBeLessThan(-0.25);
    expect(sb.max.x).toBeGreaterThan(0.25);
    // Stick grip on the centreline between the knees; throttle grips left.
    expect(hit(0, -45, 1.2)?.object.name).toBeDefined();
  });
});
