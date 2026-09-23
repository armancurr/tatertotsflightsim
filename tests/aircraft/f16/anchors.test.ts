/**
 * The F-16 model agrees with the physics geometry (F16_AIRCRAFT.geometry) within 3 cm: wheel
 * contact points, wingtips, stabilator tips, fin top, pilot eye, overall dimensions — and its
 * moving surfaces move the right way.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as THREE from 'three';
import { createF16Model, F16_PART } from '../../../src/aircraft/f16';
import { createDefaultVisualState, createRestReadings, type AircraftVisualState } from '../../../src/aircraft/types';
import { F16_AIRCRAFT } from '../../../src/config';

const G = F16_AIRCRAFT.geometry;
const TOL = 0.03;
type Model = ReturnType<typeof createF16Model>;

function state(patch: Partial<AircraftVisualState> = {}): AircraftVisualState {
  return { ...createDefaultVisualState(), engineRunning: true, cameraMode: 'chase', ...patch };
}
function apply(m: Model, v: AircraftVisualState, frames = 1) {
  for (let i = 0; i < frames; i++) m.setVisualState(v, 1 / 30);
  m.root.updateMatrixWorld(true);
}
function part(m: Model, name: string): THREE.Object3D {
  const o = m.root.getObjectByName(name);
  if (!o) throw new Error(`missing part ${name}`);
  return o;
}
/** Exact bounds (in the root's frame) of every visible mesh vertex under `obj`. */
function bounds(m: Model, obj: THREE.Object3D, filter?: (p: THREE.Vector3) => boolean): THREE.Box3 {
  m.root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(m.root.matrixWorld).invert();
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  const mat = new THREE.Matrix4();
  const visit = (o: THREE.Object3D) => {
    if (!o.visible || o.userData.noBounds) return;
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      const inst = o as THREE.InstancedMesh;
      const n = inst.isInstancedMesh ? inst.count : 1;
      const im = new THREE.Matrix4();
      for (let k = 0; k < n; k++) {
        mat.multiplyMatrices(inv, mesh.matrixWorld);
        if (inst.isInstancedMesh) {
          inst.getMatrixAt(k, im);
          mat.multiply(im);
        }
        const p = mesh.geometry.getAttribute('position');
        for (let i = 0; i < p.count; i++) {
          v.fromBufferAttribute(p, i).applyMatrix4(mat);
          if (!filter || filter(v)) box.expandByPoint(v);
        }
      }
    }
    for (const c of o.children) visit(c);
  };
  visit(obj);
  return box;
}
function bodyPos(m: Model, name: string): THREE.Vector3 {
  m.root.updateMatrixWorld(true);
  return m.root.worldToLocal(part(m, name).getWorldPosition(new THREE.Vector3()));
}

describe('F-16 model anchors match F16_AIRCRAFT.geometry', () => {
  let m: Model;
  beforeAll(() => {
    m = createF16Model();
    // Anchors are body-frame: test through an arbitrary root transform.
    m.root.position.set(10, 20, 30);
    m.root.quaternion.setFromEuler(new THREE.Euler(0.1, 0.4, -0.2, 'YXZ'));
    apply(m, state({ gearPos: 1 }), 5);
  });
  afterAll(() => m.dispose());

  const wheels = [
    ['nose', F16_PART.axleNose, G.noseWheel, G.noseWheelRadius],
    ['left main', F16_PART.axleLeft, G.leftMainWheel, G.mainWheelRadius],
    ['right main', F16_PART.axleRight, G.rightMainWheel, G.mainWheelRadius],
  ] as const;
  for (const [label, name, contact, radius] of wheels) {
    it(`${label} tyre bottom sits on the physics contact point (uncompressed)`, () => {
      apply(m, state({ gearPos: 1, wheelCompression: [0, 0, 0] }));
      const axle = bodyPos(m, name);
      expect(Math.abs(axle.x - contact.x)).toBeLessThan(TOL);
      expect(Math.abs(axle.y - radius - contact.y)).toBeLessThan(TOL);
      expect(Math.abs(axle.z - contact.z)).toBeLessThan(TOL);
    });
  }

  it('the tyres themselves reach the contact height (lowest vertex of each wheel)', () => {
    apply(m, state({ gearPos: 1 }));
    for (const name of [F16_PART.noseGear, F16_PART.leftMainGear, F16_PART.rightMainGear]) {
      const b = bounds(m, part(m, name));
      expect(Math.abs(b.min.y - G.noseWheel.y)).toBeLessThan(TOL);
    }
  });

  it('strut compression lifts each wheel by the compression', () => {
    apply(m, state({ gearPos: 1, wheelCompression: [0.1, 0.05, 0.15] }));
    const n = bodyPos(m, F16_PART.axleNose);
    const l = bodyPos(m, F16_PART.axleLeft);
    const r = bodyPos(m, F16_PART.axleRight);
    expect(Math.abs(n.y - G.noseWheelRadius - (G.noseWheel.y + 0.1))).toBeLessThan(TOL);
    expect(Math.abs(l.y - G.mainWheelRadius - (G.leftMainWheel.y + 0.05))).toBeLessThan(TOL);
    expect(Math.abs(r.y - G.mainWheelRadius - (G.rightMainWheel.y + 0.15))).toBeLessThan(TOL);
    apply(m, state({ gearPos: 1 }));
  });

  it('wingtips (rail + missile) reach ±4.98 m at the physics wingtip station', () => {
    apply(m, state());
    for (const [name, tip] of [[F16_PART.leftWing, G.structuralPoints.find((p) => p.name === 'leftWingtip')!], [F16_PART.rightWing, G.structuralPoints.find((p) => p.name === 'rightWingtip')!]] as const) {
      const b = bounds(m, part(m, name));
      const outer = tip.x < 0 ? b.min.x : b.max.x;
      expect(Math.abs(outer - tip.x)).toBeLessThan(TOL);
      // The tip assembly (everything outboard of 4.6 m) spans the wingtip station at its height.
      const t = bounds(m, part(m, name), (p) => Math.abs(p.x) > 4.6);
      expect(t.min.z).toBeLessThan(tip.z);
      expect(t.max.z).toBeGreaterThan(tip.z);
      expect(t.min.y).toBeLessThan(tip.y + TOL);
      expect(t.max.y).toBeGreaterThan(tip.y - TOL);
    }
  });

  it('stabilator tips are at ±2.79 m, y −0.55, spanning z 5.2 (neutral)', () => {
    apply(m, state({ elevator: 0, aileron: 0 }));
    for (const [name, sp] of [[F16_PART.leftStab, 'leftStab'], [F16_PART.rightStab, 'rightStab']] as const) {
      const tip = G.structuralPoints.find((p) => p.name === sp)!;
      const b = bounds(m, part(m, name));
      const outer = tip.x < 0 ? b.min.x : b.max.x;
      expect(Math.abs(outer - tip.x)).toBeLessThan(TOL);
      const t = bounds(m, part(m, name), (p) => Math.abs(p.x) > Math.abs(tip.x) - 0.08);
      expect(t.min.z).toBeLessThan(tip.z);
      expect(t.max.z).toBeGreaterThan(tip.z);
      expect(Math.abs((t.min.y + t.max.y) / 2 - tip.y)).toBeLessThan(TOL);
    }
  });

  it('the fin top is the highest point: y 3.13 over z 5.6', () => {
    apply(m, state());
    const fin = bounds(m, part(m, F16_PART.tail));
    expect(Math.abs(fin.max.y - G.verticalTailTop.y)).toBeLessThan(TOL);
    const tip = bounds(m, part(m, F16_PART.tail), (p) => p.y > G.verticalTailTop.y - 0.1);
    expect(tip.min.z).toBeLessThan(G.verticalTailTop.z);
    expect(tip.max.z).toBeGreaterThan(G.verticalTailTop.z);
  });

  it('overall: 15.06 m over the pitot, 9.96 m span, 4.88 m tall with the gear down', () => {
    m.root.position.set(0, 0, 0);
    m.root.quaternion.identity();
    apply(m, state({ gearPos: 1 }));
    const b = bounds(m, m.root);
    expect(Math.abs(b.max.z - b.min.z - G.length)).toBeLessThan(TOL);
    expect(Math.abs(b.min.z - G.spinnerTip.z)).toBeLessThan(TOL);
    expect(Math.abs(b.max.x - b.min.x - 9.96)).toBeLessThan(TOL);
    expect(Math.abs(b.max.y - b.min.y - G.height)).toBeLessThan(TOL);
    expect(Math.abs(b.min.y - G.noseWheel.y)).toBeLessThan(TOL);
  });

  it('the pilot eye is inside the helmet and under the canopy', () => {
    apply(m, state({ cameraMode: 'chase' }));
    const eye = new THREE.Vector3(G.pilotEye.x, G.pilotEye.y, G.pilotEye.z);
    const head = bounds(m, part(m, F16_PART.pilotHead)).expandByScalar(TOL);
    expect(head.containsPoint(eye)).toBe(true);
    const canopy = bounds(m, part(m, F16_PART.canopyGlass));
    expect(canopy.containsPoint(eye)).toBe(true);
    expect(canopy.max.y - eye.y).toBeGreaterThan(0.2);
  });

  it('exposes the M61A1 muzzle (gunMuzzle) in the left strake root: left side, above the strake, below the canopy sill, beside the cockpit', () => {
    m.root.position.set(0, 0, 0);
    m.root.quaternion.identity();
    apply(m, state());
    const g = bodyPos(m, 'gunMuzzle');
    expect(g.x).toBeLessThan(-0.45);
    expect(g.x).toBeGreaterThan(-0.8);
    expect(g.y).toBeGreaterThan(-0.1);
    expect(g.y).toBeLessThan(0.4);
    expect(g.z).toBeGreaterThan(G.pilotEye.z - 0.6);
    expect(g.z).toBeLessThan(G.pilotEye.z + 0.9);
    // It sits on the skin: the nearest fuselage vertex is within 8 cm.
    const skin = part(m, F16_PART.skin) as THREE.Mesh;
    const p = skin.geometry.getAttribute('position');
    let best = Infinity;
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) best = Math.min(best, v.fromBufferAttribute(p, i).distanceTo(g));
    expect(best).toBeLessThan(0.08);
    // It rides with the fuselage in a crash.
    let inFuselage = false;
    part(m, 'gunMuzzle').traverseAncestors((a) => {
      if (a.name === F16_PART.fuselage) inFuselage = true;
    });
    expect(inFuselage).toBe(true);
  });

  it('with the gear up nothing but the underwing stores hangs below the belly and the ventral fins', () => {
    m.root.position.set(0, 0, 0);
    m.root.quaternion.identity();
    // The Mavericks on their pylons hang lower, as on the real jet (checked in stores.test.ts); fire them off here.
    apply(m, { ...state({ gearPos: 0 }), stores: [false, false] }, 3);
    const pylons = [0, 1].map((i) => m.root.getObjectByName(`f16.pylon.${i}`)!);
    pylons.forEach((p) => (p.visible = false));
    const b = bounds(m, m.root);
    pylons.forEach((p) => (p.visible = true));
    expect(b.min.y).toBeGreaterThan(-1.05);
    for (const name of [F16_PART.axleNose, F16_PART.axleLeft, F16_PART.axleRight]) {
      const a = bodyPos(m, name);
      expect(a.y).toBeGreaterThan(-0.95);
      expect(Math.abs(a.x)).toBeLessThan(1.0);
    }
    apply(m, state({ gearPos: 1 }), 3);
  });
});

describe('F-16 cockpit view', () => {
  let m: Model;
  beforeAll(() => {
    m = createF16Model();
    apply(m, state({ cameraMode: 'cockpit', instruments: createRestReadings() }), 2);
  });
  afterAll(() => m.dispose());

  it("hides the pilot's own head and helmet in the cockpit view, shows them outside", () => {
    expect(part(m, F16_PART.pilotHead).visible).toBe(false);
    apply(m, state({ cameraMode: 'chase' }));
    expect(part(m, F16_PART.pilotHead).visible).toBe(true);
    apply(m, state({ cameraMode: 'cockpit' }));
  });

  it('nothing opaque sits within 40 cm of the eye straight ahead, left, right or up (over the nose view is clear)', () => {
    m.root.updateMatrixWorld(true);
    const eye = new THREE.Vector3(G.pilotEye.x, G.pilotEye.y, G.pilotEye.z);
    const ray = new THREE.Raycaster();
    const opaque: THREE.Object3D[] = [];
    m.root.traverseVisible((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mat = mesh.material as THREE.Material;
      if (mat.transparent || o.userData.noBounds) return;
      opaque.push(o);
    });
    const DEG = Math.PI / 180;
    for (const [yaw, pitch] of [[0, -7], [0, 0], [-90, 0], [90, 0], [0, 60], [-45, -10], [45, -10]]) {
      const dir = new THREE.Vector3(Math.sin(yaw * DEG) * Math.cos(pitch * DEG), Math.sin(pitch * DEG), -Math.cos(yaw * DEG) * Math.cos(pitch * DEG));
      ray.set(eye, dir);
      const hit = ray.intersectObjects(opaque, false)[0];
      if (hit) expect(hit.distance, `yaw ${yaw} pitch ${pitch}: ${hit.object.name}`).toBeGreaterThan(0.4);
    }
  });

  it('the glareshield keeps an F-16-like view over the nose: 12–17° down straight ahead', () => {
    m.root.updateMatrixWorld(true);
    const eye = new THREE.Vector3(G.pilotEye.x, G.pilotEye.y, G.pilotEye.z);
    const ray = new THREE.Raycaster();
    const opaque: THREE.Object3D[] = [];
    m.root.traverseVisible((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && !(mesh.material as THREE.Material).transparent && !o.userData.noBounds) opaque.push(o);
    });
    const DEG = Math.PI / 180;
    let firstBlocked = 90;
    for (let p = 0; p >= -30; p -= 0.5) {
      ray.set(eye, new THREE.Vector3(0, Math.sin(p * DEG), -Math.cos(p * DEG)));
      const hit = ray.intersectObjects(opaque, false)[0];
      if (hit && hit.distance < 3) {
        firstBlocked = -p;
        break;
      }
    }
    expect(firstBlocked).toBeGreaterThan(12);
    expect(firstBlocked).toBeLessThan(17);
  });
});

describe('F-16 moving surfaces move the right way', () => {
  let m: Model;
  beforeAll(() => {
    m = createF16Model();
  });
  afterAll(() => m.dispose());
  const centre = (name: string, v: AircraftVisualState) => {
    apply(m, v, 30);
    return bounds(m, part(m, name)).getCenter(new THREE.Vector3());
  };
  /** Mean y of the trailing half of a surface (z beyond its centre). */
  const trailingY = (name: string, v: AircraftVisualState) => {
    apply(m, v, 30);
    const c = bounds(m, part(m, name)).getCenter(new THREE.Vector3());
    return bounds(m, part(m, name), (p) => p.z > c.z + 0.2).getCenter(new THREE.Vector3()).y;
  };

  it('+elevator raises both stabilator trailing edges', () => {
    for (const s of [F16_PART.leftStab, F16_PART.rightStab]) {
      expect(trailingY(s, state({ elevator: 1 }))).toBeGreaterThan(trailingY(s, state()) + 0.1);
    }
  });
  it('+aileron raises the right flaperon and lowers the left', () => {
    const r0 = centre(F16_PART.flaperonRight, state({ gearPos: 0 })).y;
    const l0 = centre(F16_PART.flaperonLeft, state({ gearPos: 0 })).y;
    expect(centre(F16_PART.flaperonRight, state({ gearPos: 0, aileron: 1 })).y).toBeGreaterThan(r0 + 0.05);
    expect(centre(F16_PART.flaperonLeft, state({ gearPos: 0, aileron: 1 })).y).toBeLessThan(l0 - 0.05);
  });
  it('+rudder swings the rudder trailing edge right', () => {
    expect(centre(F16_PART.rudder, state({ rudder: 1 })).x).toBeGreaterThan(0.08);
    expect(centre(F16_PART.rudder, state({ rudder: -1 })).x).toBeLessThan(-0.08);
  });
  it('leading-edge flaps droop at high α', () => {
    const inst = { ...createRestReadings(), state: 'airborne' as const, aoaDeg: 15 };
    const lo = centre(F16_PART.lefLeft, state({ gearPos: 0, instruments: { ...inst, aoaDeg: 0 } })).y;
    expect(centre(F16_PART.lefLeft, state({ gearPos: 0, instruments: inst })).y).toBeLessThan(lo - 0.03);
  });
  it('speed brakes split open above and below the booms', () => {
    const closedU = centre(F16_PART.speedBrakeUpperLeft, state({ gearPos: 0, speedBrake: 0 })).y;
    const closedL = centre(F16_PART.speedBrakeLowerLeft, state({ gearPos: 0, speedBrake: 0 })).y;
    const openU = centre(F16_PART.speedBrakeUpperLeft, state({ gearPos: 0, speedBrake: 1 })).y;
    const openL = centre(F16_PART.speedBrakeLowerLeft, state({ gearPos: 0, speedBrake: 1 })).y;
    expect(openU).toBeGreaterThan(closedU + 0.15);
    expect(openL).toBeLessThan(closedL - 0.15);
  });
  it('the nozzle exit narrows at military power and opens in afterburner', () => {
    const inst = { ...createRestReadings(), state: 'airborne' as const, throttlePct: 100 };
    const mil = bounds(m, (apply(m, state({ gearPos: 0, instruments: inst }), 200), part(m, F16_PART.nozzle)), (p) => p.z > 5.7);
    const ab = bounds(m, (apply(m, state({ gearPos: 0, instruments: inst, afterburner: 1 }), 200), part(m, F16_PART.nozzle)), (p) => p.z > 5.7);
    expect(ab.max.x - ab.min.x).toBeGreaterThan(mil.max.x - mil.min.x + 0.12);
  });
  it('the afterburner plume shows only in afterburner', () => {
    apply(m, state({ afterburner: 0 }), 60);
    expect(part(m, F16_PART.plume).visible).toBe(false);
    apply(m, state({ afterburner: 1 }), 60);
    expect(part(m, F16_PART.plume).visible).toBe(true);
  });
});
