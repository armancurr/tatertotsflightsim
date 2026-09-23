/**
 * The A-10C model agrees with the physics / weapons geometry (A10_AIRCRAFT.geometry, A10_WEAPONS)
 * within 3 cm: wheel contact points, wingtips, fin tops, engine pods, pilot eye, GAU-8/A muzzle,
 * Maverick stations and the overall dimensions — and its moving parts move the right way.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as THREE from 'three';
import { createA10Model, A10_PART } from '../../../src/aircraft/a10';
import { POD, ENGINE } from '../../../src/aircraft/a10/shape';
import { createDefaultVisualState, createRestReadings, type AircraftVisualState } from '../../../src/aircraft/types';
import { A10_AIRCRAFT, A10_WEAPONS } from '../../../src/config';

const G = A10_AIRCRAFT.geometry;
const W = A10_WEAPONS;
const TOL = 0.03;
type Model = ReturnType<typeof createA10Model>;
const SP = (n: string) => G.structuralPoints.find((p) => p.name === n)!;

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
      mat.multiplyMatrices(inv, mesh.matrixWorld);
      const p = mesh.geometry.getAttribute('position');
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i).applyMatrix4(mat);
        if (!filter || filter(v)) box.expandByPoint(v);
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

describe('A-10 model anchors match A10_AIRCRAFT.geometry / A10_WEAPONS', () => {
  let m: Model;
  beforeAll(() => {
    m = createA10Model();
    // Anchors are body-frame: test through an arbitrary root transform.
    m.root.position.set(10, 20, 30);
    m.root.quaternion.setFromEuler(new THREE.Euler(0.1, 0.4, -0.2, 'YXZ'));
    apply(m, state({ gearPos: 1 }), 5);
  });
  afterAll(() => m.dispose());

  const wheels = [
    ['nose', A10_PART.axleNose, G.noseWheel, G.noseWheelRadius],
    ['left main', A10_PART.axleLeft, G.leftMainWheel, G.mainWheelRadius],
    ['right main', A10_PART.axleRight, G.rightMainWheel, G.mainWheelRadius],
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

  it('the nose wheel is offset right of the centreline (clear of the GAU-8), wheelbase 5.40 m, track 5.25 m', () => {
    expect(bodyPos(m, A10_PART.axleNose).x).toBeGreaterThan(0.2);
    expect(bodyPos(m, A10_PART.axleLeft).z - bodyPos(m, A10_PART.axleNose).z).toBeCloseTo(5.4, 1);
    expect(bodyPos(m, A10_PART.axleRight).x - bodyPos(m, A10_PART.axleLeft).x).toBeCloseTo(5.24, 1);
  });

  it('the tyres themselves reach the contact height (lowest vertex of each leg)', () => {
    apply(m, state({ gearPos: 1 }));
    for (const name of [A10_PART.noseGear, A10_PART.leftMainGear, A10_PART.rightMainGear]) {
      const b = bounds(m, part(m, name));
      expect(Math.abs(b.min.y - G.noseWheel.y), name).toBeLessThan(TOL);
    }
  });

  it('strut compression lifts each wheel by the compression', () => {
    apply(m, state({ gearPos: 1, wheelCompression: [0.1, 0.05, 0.15] }));
    expect(Math.abs(bodyPos(m, A10_PART.axleNose).y - G.noseWheelRadius - (G.noseWheel.y + 0.1))).toBeLessThan(TOL);
    expect(Math.abs(bodyPos(m, A10_PART.axleLeft).y - G.mainWheelRadius - (G.leftMainWheel.y + 0.05))).toBeLessThan(TOL);
    expect(Math.abs(bodyPos(m, A10_PART.axleRight).y - G.mainWheelRadius - (G.rightMainWheel.y + 0.15))).toBeLessThan(TOL);
    apply(m, state({ gearPos: 1 }));
  });

  it('wingtips (drooped Hoerner tips) reach ±8.76 m and span the physics wingtip station', () => {
    apply(m, state());
    for (const [name, tip] of [[A10_PART.leftWing, SP('leftWingtip')], [A10_PART.rightWing, SP('rightWingtip')]] as const) {
      const b = bounds(m, part(m, name));
      const outer = tip.x < 0 ? b.min.x : b.max.x;
      expect(Math.abs(outer - tip.x)).toBeLessThan(TOL);
      const t = bounds(m, part(m, name), (p) => Math.abs(p.x) > 8.3);
      expect(t.min.z).toBeLessThan(tip.z);
      expect(t.max.z).toBeGreaterThan(tip.z);
      expect(t.min.y).toBeLessThan(tip.y + TOL);
      expect(t.max.y).toBeGreaterThan(tip.y - TOL);
      // The tip droops: its outer edge is lower than the panel just inboard of the droop.
      const inboard = bounds(m, part(m, name), (p) => Math.abs(p.x) > 7.7 && Math.abs(p.x) < 7.78 && p.z > tip.z - 0.3 && p.z < tip.z + 0.3);
      const edge = bounds(m, part(m, name), (p) => Math.abs(p.x) > 8.7 && p.z > tip.z - 0.3 && p.z < tip.z + 0.3);
      expect(edge.max.y).toBeLessThan(inboard.max.y - 0.05);
    }
  });

  it('the outer panels have ~6.5° dihedral; the centre section is flat', () => {
    apply(m, state());
    const at = (x: number) => bounds(m, part(m, A10_PART.rightWing), (p) => Math.abs(p.x - x) < 0.02 && p.z < 0.6 && p.y > -1.0);
    const b1 = at(3.488);
    const b2 = at(7.354);
    const dih = Math.atan2((b2.max.y + b2.min.y) / 2 - (b1.max.y + b1.min.y) / 2, 7.354 - 3.488) * (180 / Math.PI);
    expect(dih).toBeGreaterThan(5);
    expect(dih).toBeLessThan(8);
  });

  it('twin fins at ±2.87 m: tops at y 2.52 spanning z 8.6–8.8, roots at y −0.35', () => {
    apply(m, state());
    const tail = bounds(m, part(m, A10_PART.tail));
    expect(Math.abs(tail.max.y - G.verticalTailTop.y)).toBeLessThan(TOL);
    expect(Math.abs(tail.min.y - SP('rightFinRoot').y)).toBeLessThan(TOL);
    for (const sx of [-1, 1]) {
      const top = bounds(m, part(m, A10_PART.tail), (p) => p.y > G.verticalTailTop.y - 0.1 && Math.sign(p.x) === sx);
      expect(Math.abs((top.min.x + top.max.x) / 2 - sx * 2.87)).toBeLessThan(TOL);
      expect(top.min.z).toBeLessThan(8.6);
      expect(top.max.z).toBeGreaterThan(8.8);
    }
    // Horizontal tail: 5.74 m span at y 0.45 (the fins are its end plates).
    const stab = bounds(m, part(m, A10_PART.tail), (p) => Math.abs(p.y - G.horizontalTail.y) < 0.08 && p.z < 8.2 && Math.abs(p.x) < 2.8);
    expect(stab.max.x - stab.min.x).toBeGreaterThan(5.4);
  });

  it('engine pods: nacelles centred at x ±1.55, y 1.1, running z 3.1 … 6.4', () => {
    for (const [nacelle, group, sx] of [[A10_PART.nacelleLeft, A10_PART.engineLeft, -1], [A10_PART.nacelleRight, A10_PART.engineRight, 1]] as const) {
      const c = bounds(m, part(m, nacelle));
      expect(Math.abs((c.min.x + c.max.x) / 2 - sx * ENGINE.x)).toBeLessThan(TOL);
      expect(Math.abs((c.min.y + c.max.y) / 2 - ENGINE.y)).toBeLessThan(TOL);
      expect(Math.abs(c.max.y - SP('rightEngine').y)).toBeLessThan(TOL);
      const e = bounds(m, part(m, group));
      expect(Math.abs(e.min.z - 3.1)).toBeLessThan(TOL);
      expect(Math.abs(e.max.z - 6.4)).toBeLessThan(TOL);
    }
  });

  it('overall: 16.26 m from the gun muzzle to the tail, 17.53 m span, 4.47 m tall with the gear down', () => {
    m.root.position.set(0, 0, 0);
    m.root.quaternion.identity();
    apply(m, state({ gearPos: 1 }));
    const b = bounds(m, m.root);
    expect(Math.abs(b.max.z - b.min.z - G.length)).toBeLessThan(TOL);
    expect(Math.abs(b.min.z - W.gun!.muzzle.z)).toBeLessThan(TOL);
    expect(Math.abs(b.max.x - b.min.x - 17.53)).toBeLessThan(TOL);
    expect(Math.abs(b.max.y - b.min.y - G.height)).toBeLessThan(TOL);
    expect(Math.abs(b.min.y - G.noseWheel.y)).toBeLessThan(TOL);
  });

  it('the pilot eye is inside the helmet and under the canopy', () => {
    apply(m, state({ cameraMode: 'chase' }));
    const eye = new THREE.Vector3(G.pilotEye.x, G.pilotEye.y, G.pilotEye.z);
    const head = bounds(m, part(m, A10_PART.pilotHead)).expandByScalar(TOL);
    expect(head.containsPoint(eye)).toBe(true);
    const canopy = bounds(m, part(m, A10_PART.canopyGlass));
    expect(canopy.containsPoint(eye)).toBe(true);
    expect(Math.abs(canopy.max.y - SP('cabinRoof').y)).toBeLessThan(0.05);
  });

  it('the GAU-8/A muzzle marker is exactly at A10_WEAPONS.gun.muzzle, on the firing barrel, and rides with the nose section', () => {
    m.root.position.set(0, 0, 0);
    m.root.quaternion.identity();
    apply(m, state());
    const g = bodyPos(m, A10_PART.gunMuzzle);
    const mz = W.gun!.muzzle;
    expect(g.distanceTo(new THREE.Vector3(mz.x, mz.y, mz.z))).toBeLessThan(0.001);
    // A barrel ends at the muzzle: cluster vertices within 3 cm of it.
    const cl = bounds(m, part(m, A10_PART.gunCluster), (p) => p.distanceTo(g) < 0.045);
    expect(cl.isEmpty()).toBe(false);
    // The gun axis is left of centre (the firing barrel, at 9 o'clock seen from the front, is on the centreline).
    const cluster = bounds(m, part(m, A10_PART.gunCluster), (p) => p.z < mz.z + 0.1);
    expect((cluster.min.x + cluster.max.x) / 2).toBeLessThan(-0.08);
    expect(cluster.max.x).toBeGreaterThan(0.02);
    // The barrels protrude ahead of the nose.
    const nose = bounds(m, part(m, A10_PART.forwardSkin));
    expect(nose.min.z).toBeGreaterThan(mz.z + 0.2);
    let inForward = false;
    part(m, A10_PART.gunMuzzle).traverseAncestors((a) => {
      if (a.name === A10_PART.forward) inForward = true;
    });
    expect(inForward).toBe(true);
  });

  it('four Mavericks hang exactly at the station points (order of A10_WEAPONS.missiles.stations)', () => {
    const st = W.missiles!.stations;
    expect(st.length).toBe(4);
    st.forEach((p, i) => {
      const s = bodyPos(m, A10_PART.store(i));
      expect(s.distanceTo(new THREE.Vector3(p.x, p.y, p.z)), `station ${i}`).toBeLessThan(TOL);
      const b = bounds(m, part(m, A10_PART.store(i)));
      expect(b.max.z - b.min.z).toBeGreaterThan(W.missiles!.lengthM - 0.05);
      expect(Math.abs((b.min.z + b.max.z) / 2 - p.z)).toBeLessThan(0.05);
    });
  });

  it('stores: a fired missile disappears (visual.stores[i] === false), the rest stay', () => {
    apply(m, state({ stores: [true, false, true, false] }));
    expect(part(m, A10_PART.store(0)).visible).toBe(true);
    expect(part(m, A10_PART.store(1)).visible).toBe(false);
    expect(part(m, A10_PART.store(2)).visible).toBe(true);
    expect(part(m, A10_PART.store(3)).visible).toBe(false);
    apply(m, state({ stores: undefined }));
    for (let i = 0; i < 4; i++) expect(part(m, A10_PART.store(i)).visible).toBe(true);
  });

  it('gear up: the main wheels stay half exposed under the pods; the nose wheel is inside the nose', () => {
    m.root.position.set(0, 0, 0);
    m.root.quaternion.identity();
    apply(m, state({ gearPos: 0 }), 3);
    for (const name of [A10_PART.axleLeft, A10_PART.axleRight]) {
      const a = bodyPos(m, name);
      expect(Math.abs(Math.abs(a.x) - POD.x)).toBeLessThan(TOL);
      // Axle about level with the pod bottom: half the tyre below it.
      expect(Math.abs(a.y - POD.bottomY)).toBeLessThan(0.1);
      expect(a.z).toBeLessThan(G.leftMainWheel.z - 0.5);
    }
    const n = bodyPos(m, A10_PART.axleNose);
    expect(n.y - G.noseWheelRadius).toBeGreaterThan(-1.0);
    expect(n.z).toBeLessThan(G.noseWheel.z - 0.5);
    const b = bounds(m, m.root, (p) => Math.abs(p.x) < 1.2);
    expect(b.min.y).toBeGreaterThan(-1.25);
    apply(m, state({ gearPos: 1 }), 3);
  });
});

describe('A-10 moving parts move the right way', () => {
  let m: Model;
  beforeAll(() => {
    m = createA10Model();
  });
  afterAll(() => m.dispose());
  const centre = (name: string, v: AircraftVisualState, frames = 30) => {
    apply(m, v, frames);
    return bounds(m, part(m, name)).getCenter(new THREE.Vector3());
  };

  it('+elevator raises the elevator trailing edges', () => {
    const up = bounds(m, (apply(m, state({ elevator: 1 }), 5), part(m, A10_PART.elevators)), (p) => p.z > 8.7).getCenter(new THREE.Vector3()).y;
    const mid = bounds(m, (apply(m, state({ elevator: 0 }), 5), part(m, A10_PART.elevators)), (p) => p.z > 8.7).getCenter(new THREE.Vector3()).y;
    expect(up).toBeGreaterThan(mid + 0.1);
  });
  it('+rudder swings both rudders trailing edge right', () => {
    const l0 = centre(A10_PART.rudderLeft, state()).x;
    const r0 = centre(A10_PART.rudderRight, state()).x;
    expect(centre(A10_PART.rudderLeft, state({ rudder: 1 })).x).toBeGreaterThan(l0 + 0.08);
    expect(centre(A10_PART.rudderRight, state({ rudder: 1 })).x).toBeGreaterThan(r0 + 0.08);
  });
  it('+aileron: right deceleron up, left down (both halves together)', () => {
    const ru = centre(A10_PART.decelRightUpper, state()).y;
    const rl = centre(A10_PART.decelRightLower, state()).y;
    const lu = centre(A10_PART.decelLeftUpper, state()).y;
    const ll = centre(A10_PART.decelLeftLower, state()).y;
    expect(centre(A10_PART.decelRightUpper, state({ aileron: 1 })).y).toBeGreaterThan(ru + 0.05);
    expect(centre(A10_PART.decelRightLower, state({ aileron: 1 })).y).toBeGreaterThan(rl + 0.05);
    expect(centre(A10_PART.decelLeftUpper, state({ aileron: 1 })).y).toBeLessThan(lu - 0.05);
    expect(centre(A10_PART.decelLeftLower, state({ aileron: 1 })).y).toBeLessThan(ll - 0.05);
  });
  it('speed brake: the deceleron halves split apart (upper up, lower down)', () => {
    const u0 = centre(A10_PART.decelLeftUpper, state({ speedBrake: 0 }), 120).y;
    const d0 = centre(A10_PART.decelLeftLower, state({ speedBrake: 0 }), 120).y;
    const u1 = centre(A10_PART.decelLeftUpper, state({ speedBrake: 1 }), 120).y;
    const d1 = centre(A10_PART.decelLeftLower, state({ speedBrake: 1 }), 120).y;
    expect(u1).toBeGreaterThan(u0 + 0.12);
    expect(d1).toBeLessThan(d0 - 0.12);
    centre(A10_PART.decelLeftUpper, state({ speedBrake: 0 }), 120);
  });
  it('flaps lower (and move aft) with flapsDeg', () => {
    const a = centre(A10_PART.flapRightInner, state({ flapsDeg: 0 }), 120);
    const b = centre(A10_PART.flapRightInner, state({ flapsDeg: 30 }), 120);
    expect(b.y).toBeLessThan(a.y - 0.1);
    expect(b.z).toBeGreaterThan(a.z);
    centre(A10_PART.flapRightInner, state({ flapsDeg: 0 }), 120);
  });
  it('slats run out forward and droop at high α in flight', () => {
    const inst = { ...createRestReadings(), state: 'airborne' as const, airspeedKt: 150 };
    const a = centre(A10_PART.slatLeft, state({ gearPos: 0, instruments: { ...inst, aoaDeg: 2 } }), 60);
    const b = centre(A10_PART.slatLeft, state({ gearPos: 0, instruments: { ...inst, aoaDeg: 16 } }), 60);
    expect(b.z).toBeLessThan(a.z - 0.08);
    expect(b.y).toBeLessThan(a.y - 0.02);
  });
  it('the GAU-8 cluster spins with gunSpin and blurs at speed; it stops when the gun stops', () => {
    const gun = part(m, A10_PART.gun);
    apply(m, state({ gunSpin: 0 }), 3);
    const a0 = gun.rotation.z;
    apply(m, state({ gunSpin: 0 }), 3);
    expect(gun.rotation.z).toBeCloseTo(a0, 9);
    apply(m, state({ gunSpin: 1 }), 1);
    const a1 = gun.rotation.z;
    apply(m, state({ gunSpin: 1 }), 1);
    expect(Math.abs(gun.rotation.z - a1)).toBeGreaterThan(0.1);
    expect(part(m, A10_PART.gunBlur).visible).toBe(true);
    apply(m, state({ gunSpin: 0 }), 1);
    expect(part(m, A10_PART.gunBlur).visible).toBe(false);
  });
  it('the fans turn with the engines and show a blurred disc at speed', () => {
    const fan = part(m, A10_PART.fanLeft);
    const inst = { ...createRestReadings(), throttlePct: 100 };
    apply(m, state({ engineRunning: false, propRpm: 0 }), 2);
    const a = fan.rotation.z;
    apply(m, state({ engineRunning: false, propRpm: 0 }), 2);
    expect(fan.rotation.z).toBeCloseTo(a, 9);
    apply(m, state({ engineRunning: true, propRpm: 100, instruments: inst }), 2);
    expect(Math.abs(fan.rotation.z - a)).toBeGreaterThan(0.05);
    expect(part(m, `${A10_PART.fanLeft}.disc`).visible).toBe(true);
    expect(part(m, `${A10_PART.fanLeft}.blades`).visible).toBe(false);
  });
  it('gear retracts forward: the main axles move forward and up into the pods', () => {
    const d = bodyPos(m, (apply(m, state({ gearPos: 1 }), 2), A10_PART.axleLeft));
    const u = bodyPos(m, (apply(m, state({ gearPos: 0 }), 2), A10_PART.axleLeft));
    expect(u.z).toBeLessThan(d.z - 0.5);
    expect(u.y).toBeGreaterThan(d.y + 0.2);
    apply(m, state({ gearPos: 1 }), 2);
  });
  it('the nose wheel steers with the rudder pedals when the gear is down', () => {
    const steer = part(m, `${A10_PART.noseGear}.steer`);
    apply(m, state({ gearPos: 1, nosewheelSteer: 1 }));
    expect(Math.abs(steer.rotation.y)).toBeGreaterThan(0.5);
  });
});
