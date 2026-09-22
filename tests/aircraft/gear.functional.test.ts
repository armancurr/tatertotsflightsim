/**
 * Functional: the built 3D gear (meshes, not just the maths) retracts into the
 * fuselage envelope, sequences its doors, stops its wheels and still steers.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import { createAircraft, PART } from '../../src/aircraft/index';
import { createDefaultVisualState, type AircraftVisualState } from '../../src/aircraft/types';
import { skinProtrusion, wellCutDistance } from '../../src/aircraft/gearKinematics';
import { GEAR_PART } from '../../src/aircraft/gear';
import { CONFIG } from '../../src/config';

type Aircraft = ReturnType<typeof createAircraft>;
const state = (patch: Partial<AircraftVisualState> = {}): AircraftVisualState => ({ ...createDefaultVisualState(), ...patch });

function apply(ac: Aircraft, v: AircraftVisualState, dt = 1 / 60) {
  ac.setVisualState(v, dt);
  ac.root.updateMatrixWorld(true);
}

/** Visit every visible mesh vertex under obj in body frame (root at the origin). */
function eachVertex(obj: THREE.Object3D, fn: (p: THREE.Vector3, mesh: THREE.Mesh) => void) {
  const p = new THREE.Vector3();
  obj.traverseVisible((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const pos = m.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) fn(p.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld), m);
  });
}

describe('retractable gear (built model)', () => {
  let ac: Aircraft;
  beforeAll(() => {
    ac = createAircraft({ quality: 'low' });
    ac.root.position.set(0, 0, 0);
    ac.root.quaternion.identity();
  });

  it('stowed: every gear vertex is inside the fuselage skin (tyre sliver ≤ 3 cm, everything else ≤ 1 cm)', () => {
    apply(ac, state({ gearPos: 0 }));
    const gear = ac.root.getObjectByName('gear')!;
    let worstTyre = -Infinity;
    let worstOther = -Infinity;
    eachVertex(gear, (p, m) => {
      const d = skinProtrusion(p.x, p.y, p.z);
      if (m.name.startsWith('wheel.')) worstTyre = Math.max(worstTyre, d);
      else worstOther = Math.max(worstOther, d);
    });
    expect(worstTyre).toBeLessThanOrEqual(0.03);
    expect(worstOther).toBeLessThanOrEqual(0.01);
  });

  it('stowed: the main tyres show a sliver below the belly (flush wells, not hidden, not hanging)', () => {
    apply(ac, state({ gearPos: 0 }));
    for (const name of ['wheel.left', 'wheel.right']) {
      const wheel = ac.root.getObjectByName(name)!;
      let worst = -Infinity;
      eachVertex(wheel, (p) => {
        worst = Math.max(worst, skinProtrusion(p.x, p.y, p.z));
      });
      expect(worst).toBeGreaterThan(0.003);
      expect(worst).toBeLessThan(0.03);
    }
  });

  it('stowed: gear buried inside the fuselage is only ever over a belly opening (wells, leg slots, nose well)', () => {
    apply(ac, state({ gearPos: 0 }));
    const gear = ac.root.getObjectByName('gear')!;
    let bad = 0;
    eachVertex(gear, (p) => {
      if (skinProtrusion(p.x, p.y, p.z) < -0.012 && wellCutDistance(p.x, p.z) < -0.03) bad++;
    });
    expect(bad).toBe(0);
  });

  it('the well liners are recessed (inside the skin), lit and have depth', () => {
    const wells = ac.root.getObjectByName('gearWells') as THREE.Mesh;
    expect(wells).toBeTruthy();
    expect((wells.material as THREE.Material).type).not.toBe('MeshBasicMaterial');
    let worst = -Infinity;
    let deepest = Infinity;
    eachVertex(wells, (p) => {
      const d = skinProtrusion(p.x, p.y, p.z);
      worst = Math.max(worst, d);
      deepest = Math.min(deepest, d);
    });
    expect(worst).toBeLessThan(0.004);
    expect(deepest).toBeLessThan(-0.12);
  });

  it('gear down: doors hang open; stowed: doors lie on the skin', () => {
    apply(ac, state({ gearPos: 1 }));
    const doors = ac.root.getObjectByName('noseDoors')!;
    let open = -Infinity;
    eachVertex(doors, (p) => {
      open = Math.max(open, skinProtrusion(p.x, p.y, p.z));
    });
    expect(open).toBeGreaterThan(0.08);
    apply(ac, state({ gearPos: 0 }));
    let shut = -Infinity;
    eachVertex(doors, (p) => {
      shut = Math.max(shut, skinProtrusion(p.x, p.y, p.z));
    });
    expect(shut).toBeLessThan(0.012);
  });

  it('a full retraction at 60 fps: doors hold open while the legs move, then close; nothing jumps', () => {
    const T = CONFIG.aircraft.gear.transitTime;
    const dt = 1 / 60;
    const n = Math.round(T / dt);
    const nose = ac.root.getObjectByName(GEAR_PART.axleNose)!;
    const left = ac.root.getObjectByName(GEAR_PART.axleLeft)!;
    const doorPivot = ac.root.getObjectByName('noseDoor.left')!;
    let prevNose = new THREE.Vector3();
    let prevLeft = new THREE.Vector3();
    let prevDoor = Infinity;
    let doorsClosingAt = -1;
    let legsStowedAt = -1;
    for (let i = 0; i <= n; i++) {
      const g = 1 - i / n;
      apply(ac, state({ gearPos: g }), dt);
      const pn = nose.getWorldPosition(new THREE.Vector3());
      const pl = left.getWorldPosition(new THREE.Vector3());
      const door = Math.abs(doorPivot.rotation.z);
      if (i > 0) {
        // Smooth: no wheel moves more than 5 cm in a frame over a 5 s cycle.
        expect(pn.distanceTo(prevNose)).toBeLessThan(0.05);
        expect(pl.distanceTo(prevLeft)).toBeLessThan(0.05);
        expect(door).toBeLessThanOrEqual(prevDoor + 1e-9);
        if (door < prevDoor - 1e-6 && doorsClosingAt < 0) doorsClosingAt = i;
        if (legsStowedAt < 0 && pn.distanceTo(prevNose) < 1e-7 && pl.distanceTo(prevLeft) < 1e-7 && g < 0.5) legsStowedAt = i;
      }
      prevNose = pn;
      prevLeft = pl;
      prevDoor = door;
    }
    expect(doorsClosingAt).toBeGreaterThan(0);
    expect(legsStowedAt).toBeGreaterThan(0);
    expect(doorsClosingAt).toBeGreaterThanOrEqual(legsStowedAt);
    expect(prevDoor).toBeLessThan(1e-6);
  });

  it('wheels spin with the ground roll when down, and stop once retracted', () => {
    const spinOf = (name: string) => ac.root.getObjectByName(name)!.rotation.x;
    apply(ac, state({ gearPos: 1, wheelRollSpeed: [25, 25, 25] }));
    const a0 = spinOf('wheelSpin.left');
    apply(ac, state({ gearPos: 1, wheelRollSpeed: [25, 25, 25] }));
    expect(Math.abs(spinOf('wheelSpin.left') - a0)).toBeGreaterThan(0.5);
    // Retract with the wheels still turning: the snubbers stop them.
    for (let i = 0; i < 90; i++) apply(ac, state({ gearPos: 0, wheelRollSpeed: [25, 25, 25] }));
    const names = ['wheelSpin.nose', 'wheelSpin.left', 'wheelSpin.right'];
    const before = names.map(spinOf);
    apply(ac, state({ gearPos: 0, wheelRollSpeed: [25, 25, 25] }));
    names.forEach((nm, i) => expect(spinOf(nm)).toBeCloseTo(before[i], 9));
  });

  it('nosewheel steering still turns the nose axle when down, and is centred when up', () => {
    const G = CONFIG.aircraft.surfaces;
    const q = new THREE.Quaternion();
    apply(ac, state({ gearPos: 1, nosewheelSteer: 1 }));
    ac.root.getObjectByName(PART.axleNose)!.getWorldQuaternion(q);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    const yaw = Math.atan2(fwd.x, -fwd.z) * (180 / Math.PI);
    expect(Math.abs(Math.abs(yaw) - G.nosewheelSteerMaxDeg)).toBeLessThan(0.5);
    apply(ac, state({ gearPos: 1, nosewheelSteer: 0 }));
    ac.root.getObjectByName(PART.axleNose)!.getWorldQuaternion(q);
    fwd.set(0, 0, -1).applyQuaternion(q);
    expect(Math.abs(fwd.x)).toBeLessThan(1e-6);
  });
});
