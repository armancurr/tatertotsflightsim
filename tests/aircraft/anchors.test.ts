import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import { createAircraft, PART } from '../../src/aircraft/index';
import { createDefaultVisualState, type AircraftVisualState } from '../../src/aircraft/types';
import { CONFIG } from '../../src/config';

const G = CONFIG.aircraft.geometry;
const TOL = 0.02;

type Aircraft = ReturnType<typeof createAircraft>;

function state(patch: Partial<AircraftVisualState> = {}): AircraftVisualState {
  return { ...createDefaultVisualState(), ...patch };
}

function worldPos(ac: Aircraft, name: string): THREE.Vector3 {
  const o = ac.root.getObjectByName(name);
  if (!o) throw new Error(`missing part ${name}`);
  return o.getWorldPosition(new THREE.Vector3());
}

/** Exact world-space bounds of every visible mesh vertex under `obj` (optionally skipping a subtree). */
function meshBounds(obj: THREE.Object3D, skip?: THREE.Object3D): THREE.Box3 {
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  const visit = (o: THREE.Object3D) => {
    if (!o.visible || o === skip) return;
    const m = o as THREE.Mesh;
    if (m.isMesh && !o.userData.noBounds) {
      const p = m.geometry.getAttribute('position');
      for (let i = 0; i < p.count; i++) box.expandByPoint(v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld));
    }
    for (const c of o.children) visit(c);
  };
  visit(obj);
  return box;
}

function apply(ac: Aircraft, v: AircraftVisualState) {
  ac.setVisualState(v, 1 / 60);
  ac.root.updateMatrixWorld(true);
}

describe('aircraft model anchors match config geometry', () => {
  let ac: Aircraft;
  beforeAll(() => {
    ac = createAircraft();
    ac.root.position.set(10, 20, 30); // anchors are body-frame: test through the root transform
    ac.root.quaternion.setFromEuler(new THREE.Euler(0.1, 0.4, -0.2, 'YXZ'));
    apply(ac, state({ gearPos: 1 }));
  });

  function toBody(p: THREE.Vector3): THREE.Vector3 {
    return ac.root.worldToLocal(p.clone());
  }

  const wheels = [
    ['nose', PART.axleNose, G.noseWheel, G.noseWheelRadius],
    ['left main', PART.axleLeft, G.leftMainWheel, G.mainWheelRadius],
    ['right main', PART.axleRight, G.rightMainWheel, G.mainWheelRadius],
  ] as const;

  for (const [label, part, contact, radius] of wheels) {
    it(`${label} tyre bottom sits on the physics contact point (uncompressed)`, () => {
      apply(ac, state({ gearPos: 1, wheelCompression: [0, 0, 0] }));
      const axle = toBody(worldPos(ac, part));
      expect(Math.abs(axle.x - contact.x)).toBeLessThan(TOL);
      expect(Math.abs(axle.y - radius - contact.y)).toBeLessThan(TOL);
      expect(Math.abs(axle.z - contact.z)).toBeLessThan(TOL);
    });
  }

  it('strut compression lifts each wheel by the compression', () => {
    apply(ac, state({ gearPos: 1, wheelCompression: [0.1, 0.05, 0.15] }));
    const n = toBody(worldPos(ac, PART.axleNose));
    const l = toBody(worldPos(ac, PART.axleLeft));
    const r = toBody(worldPos(ac, PART.axleRight));
    expect(n.y - G.noseWheelRadius - G.noseWheel.y).toBeCloseTo(0.1, 1);
    expect(Math.abs(n.y - G.noseWheelRadius - (G.noseWheel.y + 0.1))).toBeLessThan(TOL);
    expect(Math.abs(l.y - G.mainWheelRadius - (G.leftMainWheel.y + 0.05))).toBeLessThan(TOL);
    expect(Math.abs(r.y - G.mainWheelRadius - (G.rightMainWheel.y + 0.15))).toBeLessThan(TOL);
    expect(Math.abs(l.x - G.leftMainWheel.x)).toBeLessThan(TOL);
    expect(Math.abs(r.x - G.rightMainWheel.x)).toBeLessThan(TOL);
    apply(ac, state({ gearPos: 1 }));
  });

  it('propeller hub and spinner tip are where the physics expects', () => {
    const hub = toBody(worldPos(ac, PART.propHub));
    expect(hub.distanceTo(new THREE.Vector3(G.propHub.x, G.propHub.y, G.propHub.z))).toBeLessThan(TOL);
    const spinner = ac.root.getObjectByName(PART.spinner)!;
    ac.root.position.set(0, 0, 0);
    ac.root.quaternion.identity();
    ac.root.updateMatrixWorld(true);
    const b = meshBounds(spinner);
    expect(Math.abs(b.min.z - G.spinnerTip.z)).toBeLessThan(TOL);
  });

  it('overall dimensions are the real C172: 8.28 m long, 10.92 m span, 2.72 m tall (gear down)', () => {
    ac.root.position.set(0, 0, 0);
    ac.root.quaternion.identity();
    apply(ac, state({ gearPos: 1, cameraMode: 'chase' }));
    const b = meshBounds(ac.root);
    expect(Math.abs(b.max.z - b.min.z - G.length)).toBeLessThan(0.03);
    expect(Math.abs(b.max.x - b.min.x - CONFIG.aircraft.wingSpan)).toBeLessThan(0.03);
    expect(Math.abs(b.max.y - b.min.y - G.height)).toBeLessThan(0.03);
    expect(Math.abs(b.min.y - G.noseWheel.y)).toBeLessThan(TOL);
    expect(Math.abs(b.min.z - G.spinnerTip.z)).toBeLessThan(TOL);
  });

  it('the wing root leading edge is at the configured point and the wing is high on the cabin', () => {
    ac.root.position.set(0, 0, 0);
    ac.root.quaternion.identity();
    apply(ac, state());
    const wing = ac.root.getObjectByName(PART.wing) as THREE.Mesh;
    const p = wing.geometry.getAttribute('position');
    let best = new THREE.Vector3(0, 0, Infinity);
    for (let i = 0; i < p.count; i++) {
      if (Math.abs(p.getX(i)) > 0.3) continue;
      if (p.getZ(i) < best.z) best = new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i));
    }
    const le = G.wingRootLeadingEdge;
    expect(Math.abs(best.z - le.z)).toBeLessThan(TOL);
    expect(Math.abs(best.y - le.y)).toBeLessThan(TOL);
  });

  it('the horizontal tail spans 3.45 m and the fin top reaches the configured height', () => {
    ac.root.position.set(0, 0, 0);
    ac.root.quaternion.identity();
    apply(ac, state());
    const stab = meshBounds(ac.root.getObjectByName(PART.tailplane)!);
    expect(Math.abs(stab.max.x - stab.min.x - G.horizontalTail.span)).toBeLessThan(0.03);
    const fin = meshBounds(ac.root.getObjectByName(PART.fin)!);
    expect(Math.abs(fin.max.y - G.verticalTailTop.y)).toBeLessThan(0.05);
  });

  it('retracted gear disappears into the belly: nothing hangs below the fuselage', () => {
    ac.root.position.set(0, 0, 0);
    ac.root.quaternion.identity();
    apply(ac, state({ gearPos: 0 }));
    // The propeller legitimately reaches below the belly; everything else must be tucked in.
    const b = meshBounds(ac.root, ac.root.getObjectByName(PART.propHub));
    expect(b.min.y).toBeGreaterThan(-0.62);
    for (const part of [PART.axleNose, PART.axleLeft, PART.axleRight]) {
      const a = worldPos(ac, part);
      expect(a.y).toBeGreaterThan(-0.5);
      expect(Math.abs(a.x)).toBeLessThan(0.45);
    }
    apply(ac, state({ gearPos: 1 }));
  });
});

describe('control surfaces move the right way', () => {
  let ac: Aircraft;
  beforeAll(() => {
    ac = createAircraft();
  });
  function centre(name: string, v: AircraftVisualState): THREE.Vector3 {
    apply(ac, v);
    return meshBounds(ac.root.getObjectByName(name)!).getCenter(new THREE.Vector3());
  }

  it('+elevator lifts the elevator trailing edge', () => {
    expect(centre(PART.elevator, state({ elevator: 1 })).y).toBeGreaterThan(centre(PART.elevator, state()).y + 0.02);
  });
  it('+aileron raises the right aileron and lowers the left', () => {
    const r0 = centre(PART.aileronRight, state()).y;
    const l0 = centre(PART.aileronLeft, state()).y;
    expect(centre(PART.aileronRight, state({ aileron: 1 })).y).toBeGreaterThan(r0 + 0.01);
    expect(centre(PART.aileronLeft, state({ aileron: 1 })).y).toBeLessThan(l0 - 0.01);
  });
  it('+rudder swings the rudder trailing edge to the right (+x)', () => {
    expect(centre(PART.rudder, state({ rudder: 1 })).x).toBeGreaterThan(0.03);
    expect(centre(PART.rudder, state({ rudder: -1 })).x).toBeLessThan(-0.03);
  });
  it('flaps 30° go down and aft', () => {
    for (const f of [PART.flapLeft, PART.flapRight]) {
      const up = centre(f, state({ flapsDeg: 0 }));
      const down = centre(f, state({ flapsDeg: 30 }));
      expect(down.y).toBeLessThan(up.y - 0.05);
      expect(down.z).toBeGreaterThan(up.z + 0.05);
    }
  });
  it('+trim drops the trim tab trailing edge', () => {
    expect(centre(PART.trimTab, state({ trim: 1 })).y).toBeLessThan(centre(PART.trimTab, state()).y - 0.005);
  });
});

describe('render budget', () => {
  it('stays within ~60 draw calls outside the cockpit and a sensible triangle count', () => {
    const ac = createAircraft();
    ac.setVisualState(state({ cameraMode: 'chase', propRpm: 2400 }), 1 / 60);
    let calls = 0;
    let tris = 0;
    ac.root.traverseVisible((o) => {
      const m = o as THREE.Mesh;
      if (!(m.isMesh || (o as THREE.Points).isPoints)) return;
      calls++;
      const g = m.geometry;
      tris += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    });
    expect(calls).toBeLessThanOrEqual(60);
    expect(tris).toBeLessThan(200_000);
    ac.dispose();
  });
});
