/**
 * The JetRanger model agrees with the physics geometry (B206_AIRCRAFT.geometry / .rotorcraft)
 * within 2–3 cm: skid bottoms on the skid contact points, the main rotor hub, mast tilt and radius,
 * the blade tips at rest, the tail rotor hub and radius, fin top, stabiliser tips, tail bumper,
 * overall length and height, the pilot's eye inside the cabin — and its rotors move the right way:
 * the disc tilts with the flapping, the blades turn counter-clockwise seen from above, collective
 * and pedals feather the blades, the cockpit controls follow the rotor controls.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as THREE from 'three';
import { createB206Model, B206_PART } from '../../../src/aircraft/b206';
import { COCKPIT } from '../../../src/aircraft/b206/cockpit';
import { fuselageSection, skinHalfWidth, windowSd } from '../../../src/aircraft/b206/shape';
import { createDefaultVisualState, createRestReadings, type AircraftVisualState } from '../../../src/aircraft/types';
import { B206_AIRCRAFT, CONFIG } from '../../../src/config';
import type { RotorState } from '../../../src/types';

const G = B206_AIRCRAFT.geometry;
const RC = B206_AIRCRAFT.rotorcraft!;
const TOL = 0.02;
const DEG = Math.PI / 180;
type Model = ReturnType<typeof createB206Model>;

/** The rotor fields the model reads (the physics owns the rest). */
function rotor(patch: Partial<RotorState> = {}): RotorState {
  return {
    omega: 0, vi: 0, viTail: 0, thrust: 0, tailThrust: 0, flapLong: 0, flapLat: 0, enginePower: 0, n1: 0, govInt: 0, torque: 0,
    collective: 0, cyclicLong: 0, cyclicLat: 0, pedal: 0, sasOn: false, sasLong: 0, sasLat: 0, sasYaw: 0, headingRef: 0,
    vrs: 0, bladeStall: 0, groundEffect: 0, fx: 0, fy: 0,
    ...patch,
  } as RotorState;
}
function state(patch: Partial<AircraftVisualState> = {}): AircraftVisualState {
  return { ...createDefaultVisualState(), engineRunning: true, cameraMode: 'chase', rotor: rotor(), ...patch };
}
function apply(m: Model, v: AircraftVisualState, frames = 1, dt = 1 / 30) {
  for (let i = 0; i < frames; i++) m.setVisualState(v, dt);
  m.root.updateMatrixWorld(true);
}
function part(m: Model, name: string): THREE.Object3D {
  const o = m.root.getObjectByName(name);
  if (!o) throw new Error(`missing part ${name}`);
  return o;
}
/** Exact bounds (in `frame`'s space, default the root) of every visible mesh vertex under `obj`. */
function bounds(m: Model, obj: THREE.Object3D, filter?: (p: THREE.Vector3) => boolean, frame: THREE.Object3D = m.root): THREE.Box3 {
  m.root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(frame.matrixWorld).invert();
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
/** A point given in `obj`'s local frame, in the root (body) frame. */
function toBody(m: Model, obj: THREE.Object3D, p: THREE.Vector3): THREE.Vector3 {
  m.root.updateMatrixWorld(true);
  return m.root.worldToLocal(obj.localToWorld(p.clone()));
}

describe('JetRanger model anchors match B206_AIRCRAFT.geometry', () => {
  let m: Model;
  beforeAll(() => {
    m = createB206Model();
    // Anchors are body-frame: test through an arbitrary root transform.
    m.root.position.set(10, 20, 30);
    m.root.quaternion.setFromEuler(new THREE.Euler(0.1, 0.4, -0.2, 'YXZ'));
    apply(m, state(), 3);
  });
  afterAll(() => m.dispose());

  it('the skid bottoms sit on the four skid contact points (unloaded)', () => {
    apply(m, state({ wheelCompression: [0, 0, 0] }));
    const gear = part(m, B206_PART.skidGear);
    for (const p of RC.skids.points) {
      const b = bounds(m, gear, (v) => Math.abs(v.x - p.x) < 0.07 && Math.abs(v.z - p.z) < 0.04);
      expect(Math.abs(b.min.y - p.y), `skid at ${p.x}, ${p.z}`).toBeLessThan(TOL);
      expect(Math.abs((b.min.x + b.max.x) / 2 - p.x)).toBeLessThan(TOL);
    }
    // Nothing of the gear hangs below the skids.
    expect(bounds(m, gear).min.y).toBeGreaterThan(RC.skids.points[0].y - TOL);
  });

  it('the skid loads lift each skid by its deflection (front, left rear, right rear)', () => {
    apply(m, state({ wheelCompression: [0.1, 0.05, 0.15] }));
    const gear = part(m, B206_PART.skidGear);
    const lift = (p: { x: number; z: number }) => bounds(m, gear, (v) => Math.abs(v.x - p.x) < 0.07 && Math.abs(v.z - p.z) < 0.04).min.y;
    const [lf, lr, rf, rr] = RC.skids.points;
    expect(Math.abs(lift(lf) - (lf.y + 0.1))).toBeLessThan(TOL);
    expect(Math.abs(lift(lr) - (lr.y + 0.05))).toBeLessThan(TOL);
    expect(Math.abs(lift(rf) - (rf.y + 0.1))).toBeLessThan(TOL);
    expect(Math.abs(lift(rr) - (rr.y + 0.15))).toBeLessThan(TOL);
    apply(m, state());
  });

  it('the main rotor turns on a mast through the hub, tilted 5° forward', () => {
    const mast = part(m, B206_PART.mastFrame);
    const hub = toBody(m, mast, new THREE.Vector3());
    expect(hub.distanceTo(new THREE.Vector3(RC.rotor.hub.x, RC.rotor.hub.y, RC.rotor.hub.z))).toBeLessThan(0.005);
    const up = toBody(m, mast, new THREE.Vector3(0, 1, 0)).sub(hub);
    expect(up.y).toBeCloseTo(Math.cos(RC.rotor.mastTiltDeg * DEG), 4);
    expect(up.z).toBeCloseTo(-Math.sin(RC.rotor.mastTiltDeg * DEG), 4);
    // The spinning parts share the hub.
    expect(toBody(m, part(m, B206_PART.spin), new THREE.Vector3()).distanceTo(hub)).toBeLessThan(0.005);
  });

  it(`the blades reach the rotor radius (${RC.rotor.radius} m) and droop to the tip structural points at rest`, () => {
    apply(m, state({ propRpm: 0 }));
    const tpp = part(m, B206_PART.tiltFrame);
    for (const name of [B206_PART.blade0, B206_PART.blade1]) {
      const b = bounds(m, part(m, name), undefined, tpp);
      const r = Math.max(Math.abs(b.min.x), Math.abs(b.max.x), Math.abs(b.min.z), Math.abs(b.max.z));
      expect(Math.abs(r - RC.rotor.radius), name).toBeLessThan(TOL);
    }
    const tipY = G.structuralPoints.find((p) => p.name === 'rotorTipLeft')!.y;
    const hubXZ = new THREE.Vector2(RC.rotor.hub.x, RC.rotor.hub.z);
    const tip = bounds(m, part(m, B206_PART.mainRotor), (v) => new THREE.Vector2(v.x, v.z).distanceTo(hubXZ) > RC.rotor.radius - 0.06);
    expect(Math.abs((tip.min.y + tip.max.y) / 2 - tipY)).toBeLessThan(0.03);
  });

  it('the tail rotor sits on the left of the boom at its hub, radius 0.825 m, turning in the plane normal to its axis', () => {
    const h = RC.tailRotor.position;
    const spin = part(m, B206_PART.tailSpin);
    const hub = toBody(m, spin, new THREE.Vector3());
    expect(hub.distanceTo(new THREE.Vector3(h.x, h.y, h.z))).toBeLessThan(0.005);
    const axis = toBody(m, spin, new THREE.Vector3(0, 1, 0)).sub(hub);
    expect(axis.dot(new THREE.Vector3(RC.tailRotor.axis.x, RC.tailRotor.axis.y, RC.tailRotor.axis.z))).toBeGreaterThan(0.999);
    for (const name of [B206_PART.tailBlade0, B206_PART.tailBlade1]) {
      const b = bounds(m, part(m, name), undefined, spin);
      const r = Math.max(Math.abs(b.min.x), Math.abs(b.max.x));
      expect(Math.abs(r - RC.tailRotor.radius), name).toBeLessThan(TOL);
    }
    expect(h.x).toBeLessThan(0);
  });

  it('the fin top is the highest point of the tail: y 1.55 over z 6.55', () => {
    const fin = bounds(m, part(m, B206_PART.fins));
    expect(Math.abs(fin.max.y - G.verticalTailTop.y)).toBeLessThan(TOL);
    const tip = bounds(m, part(m, B206_PART.fins), (p) => p.y > G.verticalTailTop.y - 0.08);
    expect(tip.min.z).toBeLessThan(G.verticalTailTop.z);
    expect(tip.max.z).toBeGreaterThan(G.verticalTailTop.z);
    expect(bounds(m, part(m, B206_PART.tailBoom)).max.y).toBeLessThan(G.verticalTailTop.y + TOL);
  });

  it('the stabiliser (span and chord from the geometry) reaches its tip points', () => {
    const t = G.horizontalTail;
    for (const sp of ['leftStab', 'rightStab']) {
      const tip = G.structuralPoints.find((p) => p.name === sp)!;
      const b = bounds(m, part(m, B206_PART.stab));
      expect(Math.abs((tip.x < 0 ? b.min.x : b.max.x) - tip.x)).toBeLessThan(TOL);
      const e = bounds(m, part(m, B206_PART.stab), (p) => Math.abs(p.x) > Math.abs(tip.x) - 0.06 && Math.sign(p.x) === Math.sign(tip.x));
      expect(e.min.z).toBeLessThan(tip.z);
      expect(e.max.z).toBeGreaterThan(tip.z);
      expect(Math.abs((e.min.y + e.max.y) / 2 - tip.y)).toBeLessThan(TOL);
    }
    // The chord at mid-span.
    const mid = bounds(m, part(m, B206_PART.stab), (p) => Math.abs(p.x - 0.5) < 0.05);
    expect(Math.abs(mid.max.z - mid.min.z - t.chord)).toBeLessThan(0.03);
  });

  it('the tail skid reaches down to the tail-bumper point', () => {
    const tb = G.structuralPoints.find((p) => p.name === 'tailBumper')!;
    const b = bounds(m, part(m, B206_PART.tailParts), (p) => p.y < 0);
    expect(Math.abs(b.min.y - tb.y)).toBeLessThan(TOL);
    const low = bounds(m, part(m, B206_PART.tailParts), (p) => p.y < tb.y + 0.01);
    expect(Math.abs((low.min.z + low.max.z) / 2 - tb.z)).toBeLessThan(0.05);
  });

  it('overall: 9.50 m nose to fin (rotors aside), 2.91 m from the skids to the top of the hub', () => {
    m.root.position.set(0, 0, 0);
    m.root.quaternion.identity();
    apply(m, state({ propRpm: 0 }));
    const main = part(m, B206_PART.mainRotor);
    main.visible = false;
    const airframe = bounds(m, m.root);
    main.visible = true;
    expect(Math.abs(airframe.max.z - airframe.min.z - G.length)).toBeLessThan(TOL);
    expect(Math.abs(airframe.min.z - G.spinnerTip.z)).toBeLessThan(TOL);
    const all = bounds(m, m.root);
    expect(Math.abs(all.min.y - RC.skids.points[0].y)).toBeLessThan(TOL);
    expect(Math.abs(all.max.y - all.min.y - G.height)).toBeLessThan(TOL);
    // The rotor disc spans 10.16 m.
    expect(Math.abs(all.max.x - all.min.x - 2 * RC.rotor.radius)).toBeLessThan(0.05);
  });

  it("the pilot's eye (right seat) is inside the cabin with headroom, over the seat, behind the panel", () => {
    const e = G.pilotEye;
    expect(e.x).toBeGreaterThan(0.2);
    expect(skinHalfWidth(e.y, e.z) - e.x).toBeGreaterThan(0.15);
    expect(fuselageSection(e.z).top - e.y).toBeGreaterThan(0.3);
    const over = e.y - COCKPIT.cushionTopY;
    expect(over).toBeGreaterThan(0.72);
    expect(over).toBeLessThan(0.86);
    expect(e.z).toBeGreaterThan(COCKPIT.cushionZ[0]);
    expect(e.z).toBeLessThan(COCKPIT.cushionZ[1]);
    expect(e.z - COCKPIT.panel.z).toBeGreaterThan(0.6);
    expect(e.z - COCKPIT.panel.z).toBeLessThan(0.9);
  });
});

describe('JetRanger rotors move the right way', () => {
  let m: Model;
  beforeAll(() => {
    m = createB206Model();
  });
  afterAll(() => m.dispose());
  const flying = (r: Partial<RotorState> = {}) => state({ propRpm: RC.rotor.nominalRpm, rotor: rotor({ thrust: B206_AIRCRAFT.mass * 9.81, ...r }) });
  /** Height of the disc's front and rear, left and right rim points (tip-path plane) in the body frame. */
  const rim = () => {
    const tpp = part(m, B206_PART.tiltFrame);
    const R = RC.rotor.radius;
    return {
      front: toBody(m, tpp, new THREE.Vector3(0, 0, -R)).y,
      rear: toBody(m, tpp, new THREE.Vector3(0, 0, R)).y,
      left: toBody(m, tpp, new THREE.Vector3(-R, 0, 0)).y,
      right: toBody(m, tpp, new THREE.Vector3(R, 0, 0)).y,
    };
  };

  it('+flapLong tilts the disc aft (its front rises), +flapLat tilts it right (its right side drops)', () => {
    apply(m, flying());
    const n = rim();
    // Level flapping: the disc follows the mast, 5° nose-down.
    expect(n.rear - n.front).toBeCloseTo(2 * RC.rotor.radius * Math.sin(RC.rotor.mastTiltDeg * DEG), 2);
    apply(m, flying({ flapLong: 8 * DEG }));
    const aft = rim();
    expect(aft.front - aft.rear).toBeGreaterThan(n.front - n.rear + 0.3);
    apply(m, flying({ flapLat: 6 * DEG }));
    const right = rim();
    expect(right.right).toBeLessThan(right.left - 0.5);
  });

  it('a stopped rotor levels itself on its teeter hinge; the blades droop, and cone up when turning', () => {
    apply(m, state({ propRpm: 0 }));
    const r0 = rim();
    expect(Math.abs(r0.front - r0.rear)).toBeLessThan(0.01);
    const tipY = (v: AircraftVisualState) => {
      apply(m, v);
      // Tip height relative to the hub, in the blade's own (feathering) frame.
      const t = bounds(m, part(m, B206_PART.blade0), (p) => p.x > RC.rotor.radius - 0.05, part(m, B206_PART.feather0));
      return (t.min.y + t.max.y) / 2;
    };
    const rest = tipY(state({ propRpm: 0 }));
    const spinning = tipY(flying());
    expect(rest).toBeLessThan(-0.25);
    expect(spinning).toBeGreaterThan(0.1);
    expect(tipY(flying({ thrust: 2 * B206_AIRCRAFT.mass * 9.81 }))).toBeGreaterThan(spinning + 0.03);
  });

  it('the blades turn counter-clockwise seen from above (rotor.direction = +1) and the tail rotor at the gear ratio', () => {
    expect(RC.rotor.direction).toBe(1);
    const spin = part(m, B206_PART.spin);
    const tail = part(m, B206_PART.tailSpin);
    // Slow enough to stay below the blur (the blades are drawn at their true angle).
    const v = state({ propRpm: 30 });
    apply(m, v);
    const p0 = toBody(m, spin, new THREE.Vector3(1, 0, 0)).sub(toBody(m, spin, new THREE.Vector3()));
    const a0 = spin.rotation.y;
    const t0 = tail.rotation.y;
    apply(m, v, 1, 0.05);
    const p1 = toBody(m, spin, new THREE.Vector3(1, 0, 0)).sub(toBody(m, spin, new THREE.Vector3()));
    // Cross product about +y > 0: counter-clockwise from above.
    expect(p0.clone().cross(p1).y).toBeGreaterThan(0.05);
    const dMain = spin.rotation.y - a0;
    const dTail = tail.rotation.y - t0;
    expect(dMain).toBeCloseTo((30 / 60) * 2 * Math.PI * 0.05, 5);
    expect(dTail / dMain).toBeCloseTo(RC.tailRotor.gearRatio, 3);
  });

  it('collective feathers both blades nose-up (collectiveDeg at 0.75 R, lever down … up)', () => {
    const pitch = (c: number) => {
      apply(m, flying({ collective: c }));
      // Leading edge minus trailing edge height at 0.75 R, in the tip-path-plane frame.
      const tpp = part(m, B206_PART.tiltFrame);
      const out: number[] = [];
      for (const b of [B206_PART.blade0, B206_PART.blade1]) {
        const mesh = part(m, b);
        const le = tpp.worldToLocal(mesh.localToWorld(new THREE.Vector3(0.75 * RC.rotor.radius, 0, -0.08)));
        const te = tpp.worldToLocal(mesh.localToWorld(new THREE.Vector3(0.75 * RC.rotor.radius, 0, 0.24)));
        out.push(Math.atan2(le.y - te.y, Math.hypot(te.x - le.x, te.z - le.z)) / DEG);
      }
      return out;
    };
    const lo = pitch(0);
    const hi = pitch(1);
    const [c0, c1] = RC.rotor.collectiveDeg;
    for (let k = 0; k < 2; k++) {
      expect(lo[k]).toBeCloseTo(c0, 0);
      expect(hi[k]).toBeCloseTo(c1, 0);
    }
  });

  it('cyclic feathers the blades once per turn; the pedals change the tail-rotor pitch (+ right pedal = less)', () => {
    apply(m, flying({ cyclicLong: 1 }));
    const f0 = part(m, B206_PART.feather0).rotation.x;
    const f1 = part(m, B206_PART.feather1).rotation.x;
    // Opposite blades get opposite cyclic pitch about the collective.
    expect(Math.abs(f0 + f1 - 2 * RC.rotor.collectiveDeg[0] * DEG)).toBeLessThan(1e-6);
    const tp = (pedal: number) => {
      apply(m, flying({ pedal }));
      return part(m, B206_PART.tailFeather0).rotation.x / DEG;
    };
    expect(tp(0)).toBeCloseTo(RC.tailRotor.pitchNeutralDeg, 5);
    expect(tp(1)).toBeCloseTo(RC.tailRotor.pitchNeutralDeg - RC.tailRotor.pitchRangeDeg, 5);
    expect(tp(-1)).toBeCloseTo(RC.tailRotor.pitchNeutralDeg + RC.tailRotor.pitchRangeDeg, 5);
  });

  it('at speed the blades fade into a translucent disc (main and tail)', () => {
    apply(m, state({ propRpm: 0 }));
    expect(part(m, B206_PART.disc).visible).toBe(false);
    expect(part(m, B206_PART.tailDisc).visible).toBe(false);
    apply(m, flying());
    expect(part(m, B206_PART.disc).visible).toBe(true);
    expect(part(m, B206_PART.tailDisc).visible).toBe(true);
    const mat = (part(m, B206_PART.blade0) as THREE.Mesh).material as THREE.Material;
    expect(mat.transparent).toBe(true);
    expect(mat.opacity).toBeLessThan(0.3);
  });
});

describe('JetRanger cockpit', () => {
  let m: Model;
  beforeAll(() => {
    m = createB206Model();
    apply(m, state({ cameraMode: 'cockpit', instruments: createRestReadings() }), 2);
  });
  afterAll(() => m.dispose());
  const grip = (v: AircraftVisualState) => {
    apply(m, v);
    return toBody(m, part(m, B206_PART.cyclic), new THREE.Vector3(0, 0.6, 0.09));
  };

  it('the cyclic moves aft with +cyclicLong and right with +cyclicLat; the collective rises; the pedals move', () => {
    const c = grip(state({ cameraMode: 'cockpit' }));
    expect(grip(state({ cameraMode: 'cockpit', rotor: rotor({ cyclicLong: 1 }) })).z).toBeGreaterThan(c.z + 0.08);
    expect(grip(state({ cameraMode: 'cockpit', rotor: rotor({ cyclicLat: 1 }) })).x).toBeGreaterThan(c.x + 0.06);
    // Without a rotor state the stick follows the elevator/aileron.
    expect(grip(state({ cameraMode: 'cockpit', rotor: null, elevator: 1 })).z).toBeGreaterThan(c.z + 0.08);
    const lever = (coll: number) => {
      apply(m, state({ cameraMode: 'cockpit', rotor: rotor({ collective: coll }) }));
      return toBody(m, part(m, B206_PART.collective), new THREE.Vector3(0, 0.05, -0.58)).y;
    };
    expect(lever(1)).toBeGreaterThan(lever(0) + 0.1);
    apply(m, state({ cameraMode: 'cockpit', rotor: rotor({ pedal: 1 }) }));
    expect(part(m, B206_PART.pedalRight).position.z).toBeLessThan(-0.03);
    expect(part(m, B206_PART.pedalLeft).position.z).toBeGreaterThan(0.03);
  });

  it('looks out over a low glareshield (12–22° down) through the windscreen, and down through the chin windows', () => {
    apply(m, state({ cameraMode: 'cockpit' }));
    const eye = new THREE.Vector3(G.pilotEye.x, G.pilotEye.y, G.pilotEye.z);
    // The skin and the lining get their window cut-outs from textures (browser only): test them
    // against the analytic window outlines instead, and ray-cast everything else that is opaque.
    const skip = new Set<string>([B206_PART.skin, B206_PART.lining, B206_PART.glass]);
    const opaque: THREE.Object3D[] = [];
    m.root.traverseVisible((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && !skip.has(o.name) && !(mesh.material as THREE.Material).transparent && !o.userData.noBounds) opaque.push(o);
    });
    const lining = part(m, B206_PART.lining);
    const ray = new THREE.Raycaster();
    let firstBlocked = 90;
    for (let p = 0; p >= -40; p -= 0.5) {
      const dir = new THREE.Vector3(0, Math.sin(p * DEG), -Math.cos(p * DEG));
      ray.set(eye, dir);
      const hit = ray.intersectObjects(opaque, false)[0];
      if (hit && hit.distance < 2) {
        firstBlocked = -p;
        break;
      }
      // Clear of the cabin furniture: the ray leaves through a window (of the lining, seen from inside).
      const out = ray.intersectObject(lining, false)[0];
      expect(out, `pitch ${p}`).toBeDefined();
      expect(windowSd(out.point.x, out.point.y, out.point.z).d, `pitch ${p}`).toBeLessThan(0);
    }
    expect(firstBlocked).toBeGreaterThan(12);
    expect(firstBlocked).toBeLessThan(22);
    // Nothing opaque within 40 cm straight ahead, up, or to either side at eye level.
    for (const [yaw, pitch] of [[0, 0], [0, 60], [-45, -10], [45, 0], [-90, 0]]) {
      const d = new THREE.Vector3(Math.sin(yaw * DEG) * Math.cos(pitch * DEG), Math.sin(pitch * DEG), -Math.cos(yaw * DEG) * Math.cos(pitch * DEG));
      ray.set(eye, d);
      const hit = ray.intersectObjects(opaque, false)[0];
      if (hit) expect(hit.distance, `yaw ${yaw} pitch ${pitch}: ${hit.object.name}`).toBeGreaterThan(0.4);
    }
    // Between the pedals, the chin window shows the ground ahead and below.
    ray.set(eye, new THREE.Vector3(0, -Math.sin(55 * DEG), -Math.cos(55 * DEG)).normalize());
    const down = ray.intersectObject(lining, false)[0];
    expect(windowSd(down.point.x, down.point.y, down.point.z).kind).toBe('chin');
    // …and the default view has the horizon in the upper half of the screen.
    expect(CONFIG.camera.cockpit.lookDownDeg).toBeGreaterThanOrEqual(0);
  });
});
