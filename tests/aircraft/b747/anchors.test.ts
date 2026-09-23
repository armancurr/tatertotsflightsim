/**
 * The 747-400 model agrees with the physics geometry (B747_AIRCRAFT.geometry) within 3 cm: the 18
 * wheels (nose pair on the nose contact, the wing-gear trucks on the main contacts, the body-gear
 * trucks level with them), every structural point the physics collides with (nose tip, chin,
 * belly, tail bumper, tail cone, upper-deck roof, wingtips, stabiliser tips, fin top, the four
 * engine pods), the pilot's eye on the upper-deck flight deck, and the overall dimensions — and
 * the moving parts move the right way.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as THREE from 'three';
import { createB747Model, B747_PART } from '../../../src/aircraft/b747';
import { GEAR, WING } from '../../../src/aircraft/b747/shape';
import { createDefaultVisualState, createRestReadings, type AircraftVisualState } from '../../../src/aircraft/types';
import { B747_AIRCRAFT } from '../../../src/config';

const G = B747_AIRCRAFT.geometry;
const TOL = 0.03;
const DEG = Math.PI / 180;
type Model = ReturnType<typeof createB747Model>;
const SP = (n: string) => {
  const p = G.structuralPoints.find((q) => q.name === n);
  if (!p) throw new Error(`no structural point ${n}`);
  return p;
};
const ground = { ...createRestReadings(), state: 'ground' as const };

function state(patch: Partial<AircraftVisualState> = {}): AircraftVisualState {
  return { ...createDefaultVisualState(), engineRunning: true, cameraMode: 'chase', instruments: ground, ...patch };
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
/** Exact bounds (root frame) of every visible mesh vertex under `obj` that passes `filter`. */
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
const skins = [B747_PART.skinForward, B747_PART.skinCentre, B747_PART.skinAft];
function skinBounds(m: Model, filter: (p: THREE.Vector3) => boolean): THREE.Box3 {
  const b = new THREE.Box3();
  for (const s of skins) b.union(bounds(m, part(m, s), filter));
  return b;
}

describe('747 model anchors match B747_AIRCRAFT.geometry', () => {
  let m: Model;
  beforeAll(() => {
    m = createB747Model();
    // Anchors are body-frame: test through an arbitrary root transform.
    m.root.position.set(10, 20, 30);
    m.root.quaternion.setFromEuler(new THREE.Euler(0.1, 0.4, -0.2, 'YXZ'));
    apply(m, state({ gearPos: 1 }), 5);
  });
  afterAll(() => m.dispose());

  it('the nose-wheel axle sits on the nose contact (tyre bottom at y −5.0)', () => {
    apply(m, state({ gearPos: 1, wheelCompression: [0, 0, 0] }));
    const a = bodyPos(m, B747_PART.noseAxle);
    expect(Math.abs(a.x - G.noseWheel.x)).toBeLessThan(TOL);
    expect(Math.abs(a.y - G.noseWheelRadius - G.noseWheel.y)).toBeLessThan(TOL);
    expect(Math.abs(a.z - G.noseWheel.z)).toBeLessThan(TOL);
  });

  it('the wing-gear trucks are centred on the main contacts; the body-gear trucks at x ±1.9 just aft, level with them', () => {
    apply(m, state({ gearPos: 1, wheelCompression: [0, 0, 0] }));
    for (const [side, contact] of [['left', G.leftMainWheel], ['right', G.rightMainWheel]] as const) {
      const w = bodyPos(m, B747_PART.truck(B747_PART.wingGear(side)));
      expect(Math.abs(w.x - contact.x), side).toBeLessThan(TOL);
      expect(Math.abs(w.y - G.mainWheelRadius - contact.y)).toBeLessThan(TOL);
      expect(Math.abs(w.z - contact.z)).toBeLessThan(TOL);
      const b = bodyPos(m, B747_PART.truck(B747_PART.bodyGear(side)));
      expect(Math.abs(Math.abs(b.x) - 1.9)).toBeLessThan(0.15);
      expect(Math.sign(b.x)).toBe(Math.sign(contact.x));
      expect(Math.abs(b.y - G.mainWheelRadius - contact.y)).toBeLessThan(TOL);
      expect(b.z).toBeGreaterThan(contact.z + 1.5);
      expect(b.z).toBeLessThan(contact.z + 5);
    }
    // Real 747-400: 25.6 m wheelbase, 11.0 m wing-gear track.
    expect(bodyPos(m, B747_PART.truck(B747_PART.wingGear('left'))).z - bodyPos(m, B747_PART.noseAxle).z).toBeCloseTo(25.6, 1);
  });

  it('all 18 tyres reach the ground line (lowest vertex of every leg at y −5.0) and there are 18 of them', () => {
    apply(m, state({ gearPos: 1 }));
    const legs = [B747_PART.noseGear, ...(['left', 'right'] as const).flatMap((s) => [B747_PART.wingGear(s), B747_PART.bodyGear(s)])];
    for (const name of legs) {
      const b = bounds(m, part(m, name));
      expect(Math.abs(b.min.y - G.noseWheel.y), name).toBeLessThan(TOL);
    }
    let wheels = 0;
    m.root.traverse((o) => {
      if (o.userData.wheels) wheels += o.userData.wheels as number;
    });
    expect(wheels).toBe(18);
  });

  it('strut compression lifts the nose gear by c0, the left trucks by c1 and the right trucks by c2', () => {
    apply(m, state({ gearPos: 1, wheelCompression: [0.1, 0.05, 0.15] }));
    expect(bodyPos(m, B747_PART.noseAxle).y - G.noseWheelRadius - G.noseWheel.y).toBeCloseTo(0.1, 2);
    for (const [side, c] of [['left', 0.05], ['right', 0.15]] as const) {
      expect(bodyPos(m, B747_PART.truck(B747_PART.wingGear(side))).y - G.mainWheelRadius - G.leftMainWheel.y).toBeCloseTo(c, 2);
      expect(bodyPos(m, B747_PART.truck(B747_PART.bodyGear(side))).y - G.mainWheelRadius - G.leftMainWheel.y).toBeCloseTo(c, 2);
    }
    apply(m, state({ gearPos: 1 }));
  });

  it('fuselage keel and crown pass through the physics points: nose tip, chin, belly, tail bumper, tail cone, upper-deck roof', () => {
    apply(m, state());
    const near = (z: number, dz = 0.06) => (p: THREE.Vector3) => Math.abs(p.x) < 0.25 && Math.abs(p.z - z) < dz;
    for (const n of ['chin', 'bellyForward', 'bellyMid', 'bellyAft', 'tailBumper']) {
      const p = SP(n);
      expect(Math.abs(skinBounds(m, near(p.z)).min.y - p.y), n).toBeLessThan(TOL);
    }
    const roof = SP('upperDeckRoof');
    expect(Math.abs(skinBounds(m, near(roof.z)).max.y - roof.y)).toBeLessThan(TOL);
    const cone = SP('tailcone');
    expect(Math.abs(skinBounds(m, (p) => Math.abs(p.z - cone.z) < 0.04).min.y - cone.y)).toBeLessThan(TOL);
    const tip = SP('noseTip');
    const all = skinBounds(m, () => true);
    expect(Math.abs(all.min.z - tip.z)).toBeLessThan(TOL);
    const tipZone = skinBounds(m, (p) => p.z < tip.z + 0.02);
    expect(Math.abs((tipZone.min.y + tipZone.max.y) / 2 - tip.y)).toBeLessThan(TOL);
  });

  it('the upper-deck hump runs back to about the wing-root leading edge, then fairs into the crown', () => {
    apply(m, state());
    const crown = (z: number) => skinBounds(m, (p) => Math.abs(p.x) < 0.3 && Math.abs(p.z - z) < 0.3).max.y;
    expect(crown(-20)).toBeGreaterThan(5.1);
    expect(crown(-11)).toBeGreaterThan(4.9);
    expect(crown(2)).toBeLessThan(3.7);
    expect(crown(20)).toBeLessThan(3.7);
    // The main fuselage is ~6.5 m wide.
    const w = skinBounds(m, (p) => Math.abs(p.z - 5) < 0.3 && p.y > -1 && p.y < 1.5);
    expect(w.max.x - w.min.x).toBeGreaterThan(6.35);
    expect(w.max.x - w.min.x).toBeLessThan(6.7);
  });

  it('wingtips: 64.44 m span over the canted winglets; the tip station spans z 21 at y 1.4; 7° dihedral', () => {
    apply(m, state());
    for (const [name, tip] of [[B747_PART.leftWing, SP('leftWingtip')], [B747_PART.rightWing, SP('rightWingtip')]] as const) {
      const b = bounds(m, part(m, name));
      const outer = tip.x < 0 ? b.min.x : b.max.x;
      expect(Math.abs(outer - tip.x), name).toBeLessThan(TOL);
      const t = bounds(m, part(m, B747_PART.wingPanel(tip.x < 0 ? 'left' : 'right')), (p) => Math.abs(p.x) > WING.tipX - 0.02);
      expect(t.min.z).toBeLessThan(tip.z);
      expect(t.max.z).toBeGreaterThan(tip.z);
      expect(Math.abs(t.min.y - tip.y)).toBeLessThan(TOL);
      // The winglet rises well above the tip and leans outboard.
      expect(b.max.y).toBeGreaterThan(tip.y + 1.5);
    }
    const mid = (x: number) => {
      const b = bounds(m, part(m, B747_PART.wingPanel('right')), (p) => Math.abs(p.x - x) < 0.05);
      return (b.min.y + b.max.y) / 2;
    };
    const xa = WING.kinkX;
    const xb = WING.aileronOutboard[1];
    const dih = Math.atan2(mid(xb) - mid(xa), xb - xa) / DEG;
    expect(dih).toBeGreaterThan(5.5);
    expect(dih).toBeLessThan(8.5);
  });

  it('the wing is swept 37.5° at the quarter chord (outer panel)', () => {
    apply(m, state());
    const qc = (x: number) => WING.le(x) + 0.25 * WING.chord(x);
    const sweep = Math.atan2(qc(28) - qc(15), 13) / DEG;
    expect(sweep).toBeGreaterThan(35.5);
    expect(sweep).toBeLessThan(39.5);
    // The model's leading edge is where the planform says.
    const x = WING.aileronOutboard[0];
    const b = bounds(m, part(m, B747_PART.wingPanel('right')), (p) => Math.abs(p.x - x) < 0.05);
    expect(Math.abs(b.min.z - WING.le(x))).toBeLessThan(0.08);
  });

  it('stabiliser tips at ±11.08 m (22.17 m span) at y 2.2, spanning z 36; fin top at y 14.41 spanning z 37.5', () => {
    apply(m, state());
    for (const n of ['leftStab', 'rightStab']) {
      const p = SP(n);
      const tipB = bounds(m, part(m, B747_PART.tail), (q) => Math.sign(q.x) === Math.sign(p.x) && Math.abs(q.x) > Math.abs(p.x) - 0.25);
      expect(Math.abs(Math.max(Math.abs(tipB.min.x), Math.abs(tipB.max.x)) - Math.abs(p.x)), n).toBeLessThan(TOL);
      expect(tipB.min.z).toBeLessThan(p.z);
      expect(tipB.max.z).toBeGreaterThan(p.z);
      expect(tipB.min.y).toBeLessThan(p.y + TOL);
      expect(tipB.max.y).toBeGreaterThan(p.y - TOL);
    }
    const tail = bounds(m, part(m, B747_PART.tail));
    expect(Math.abs(tail.max.y - G.verticalTailTop.y)).toBeLessThan(TOL);
    const top = bounds(m, part(m, B747_PART.tail), (q) => q.y > G.verticalTailTop.y - 0.1);
    expect(top.min.z).toBeLessThan(G.verticalTailTop.z);
    expect(top.max.z).toBeGreaterThan(G.verticalTailTop.z);
  });

  it('engine pods: nacelle bottoms on the physics points, inboard ahead of outboard, the fans face forward', () => {
    apply(m, state());
    const pods: [number, string][] = [[1, 'leftOutboardEngine'], [2, 'leftInboardEngine'], [3, 'rightInboardEngine'], [4, 'rightOutboardEngine']];
    for (const [n, sp] of pods) {
      const p = SP(sp);
      const nac = bounds(m, part(m, B747_PART.nacelle(n)), (q) => Math.abs(q.z - p.z) < 0.08);
      expect(Math.abs(nac.min.y - p.y), sp).toBeLessThan(TOL);
      expect(Math.abs((nac.min.x + nac.max.x) / 2 - p.x), sp).toBeLessThan(TOL);
      const fan = bodyPos(m, B747_PART.fan(n));
      expect(Math.abs(fan.x - p.x)).toBeLessThan(TOL);
      expect(fan.z).toBeLessThan(p.z);
      const all = bounds(m, part(m, B747_PART.engine(n)));
      // Big high-bypass pods: ~2.7 m across.
      expect(all.max.z - all.min.z).toBeGreaterThan(6);
    }
    expect(bounds(m, part(m, B747_PART.nacelle(2))).min.z).toBeLessThan(bounds(m, part(m, B747_PART.nacelle(1))).min.z - 5);
    const w = bounds(m, part(m, B747_PART.nacelle(3)), (q) => Math.abs(q.z - SP('rightInboardEngine').z) < 0.08);
    expect(w.max.x - w.min.x).toBeGreaterThan(2.5);
    expect(w.max.x - w.min.x).toBeLessThan(3.0);
  });

  it('overall: 70.66 m long, 64.44 m span, 19.41 m tall with the gear down', () => {
    m.root.position.set(0, 0, 0);
    m.root.quaternion.identity();
    apply(m, state({ gearPos: 1 }));
    const b = bounds(m, m.root);
    expect(Math.abs(b.max.z - b.min.z - G.length)).toBeLessThan(TOL);
    expect(Math.abs(b.min.z - G.spinnerTip.z)).toBeLessThan(TOL);
    expect(Math.abs(b.max.x - b.min.x - 64.44)).toBeLessThan(TOL);
    expect(Math.abs(b.max.y - b.min.y - G.height)).toBeLessThan(TOL);
    expect(Math.abs(b.min.y - G.noseWheel.y)).toBeLessThan(TOL);
  });

  it("the captain's eye is on the upper deck behind the windscreen, with the flight-deck group ready around it", () => {
    apply(m, state());
    const eye = new THREE.Vector3(G.pilotEye.x, G.pilotEye.y, G.pilotEye.z);
    const sec = skinBounds(m, (p) => Math.abs(p.z - eye.z) < 0.1);
    expect(sec.max.y).toBeGreaterThan(eye.y + 0.6);
    const atEye = skinBounds(m, (p) => Math.abs(p.z - eye.z) < 0.1 && Math.abs(p.y - eye.y) < 0.2);
    expect(atEye.min.x).toBeLessThan(eye.x - 0.6);
    const glass = bounds(m, part(m, B747_PART.cockpitGlass));
    expect(glass.min.z).toBeLessThan(eye.z - 0.5);
    expect(glass.min.y).toBeLessThan(eye.y);
    expect(glass.max.y).toBeGreaterThan(eye.y);
    const deck = part(m, B747_PART.flightDeck);
    expect(deck.children.length).toBe(0);
    expect(bodyPos(m, B747_PART.flightDeck).distanceTo(eye)).toBeLessThan(2);
  });

  it('gear up: every wheel is tucked inside the fuselage outline, the doors closed (hidden)', () => {
    m.root.position.set(0, 0, 0);
    m.root.quaternion.identity();
    apply(m, state({ gearPos: 0, instruments: { ...ground, state: 'airborne' } }), 3);
    const wheels = [B747_PART.noseSteer, ...(['left', 'right'] as const).flatMap((s) => [B747_PART.truck(B747_PART.wingGear(s)), B747_PART.truck(B747_PART.bodyGear(s))])];
    for (const name of wheels) {
      const b = bounds(m, part(m, name));
      expect(b.min.y, name).toBeGreaterThan(-3.3);
      expect(Math.max(Math.abs(b.min.x), Math.abs(b.max.x)), name).toBeLessThan(3.6);
    }
    for (const d of B747_PART.doors) expect(part(m, d).visible, d).toBe(false);
    apply(m, state({ gearPos: 1 }), 3);
    expect(GEAR.bodyZ).toBeGreaterThan(G.leftMainWheel.z);
  });
});

describe('747 moving parts move the right way', () => {
  let m: Model;
  beforeAll(() => {
    m = createB747Model();
  });
  afterAll(() => m.dispose());
  const centre = (name: string, v: AircraftVisualState, frames = 60) => {
    apply(m, v, frames);
    return bounds(m, part(m, name)).getCenter(new THREE.Vector3());
  };

  it('+elevator raises all four elevator panels', () => {
    for (const s of ['left', 'right'] as const) {
      for (const sp of ['inboard', 'outboard'] as const) {
        const n = B747_PART.elevator(s, sp);
        const mid = centre(n, state({ elevator: 0 }), 5).y;
        expect(centre(n, state({ elevator: 1 }), 5).y, n).toBeGreaterThan(mid + 0.1);
      }
    }
  });
  it('+rudder swings the upper and lower rudders trailing edge right', () => {
    for (const n of [B747_PART.rudderUpper, B747_PART.rudderLower]) {
      const x0 = centre(n, state(), 5).x;
      expect(centre(n, state({ rudder: 1 }), 5).x, n).toBeGreaterThan(x0 + 0.2);
    }
  });
  it('+aileron: right inboard aileron up, left down; outboard ailerons move only with flaps out', () => {
    const r0 = centre(B747_PART.aileron('right', 'inboard'), state(), 5).y;
    const l0 = centre(B747_PART.aileron('left', 'inboard'), state(), 5).y;
    expect(centre(B747_PART.aileron('right', 'inboard'), state({ aileron: 1 }), 5).y).toBeGreaterThan(r0 + 0.1);
    expect(centre(B747_PART.aileron('left', 'inboard'), state({ aileron: 1 }), 5).y).toBeLessThan(l0 - 0.1);
    const o0 = centre(B747_PART.aileron('right', 'outboard'), state(), 5).y;
    expect(Math.abs(centre(B747_PART.aileron('right', 'outboard'), state({ aileron: 1 }), 5).y - o0)).toBeLessThan(0.02);
    const oFlaps = centre(B747_PART.aileron('right', 'outboard'), state({ flapsDeg: 20 }), 400).y;
    expect(centre(B747_PART.aileron('right', 'outboard'), state({ flapsDeg: 20, aileron: 1 }), 5).y).toBeGreaterThan(oFlaps + 0.1);
    centre(B747_PART.aileron('right', 'outboard'), state(), 400);
  });
  it('speed brake: every spoiler panel rises from the upper surface', () => {
    for (const s of ['left', 'right'] as const) {
      for (const sp of ['inboard', 'outboard'] as const) {
        const n = B747_PART.spoiler(s, sp);
        const y0 = centre(n, state({ speedBrake: 0 }), 200).y;
        expect(centre(n, state({ speedBrake: 1 }), 200).y, n).toBeGreaterThan(y0 + 0.1);
      }
    }
    centre(B747_PART.spoiler('left', 'inboard'), state({ speedBrake: 0 }), 200);
  });
  it('flaps: the triple-slotted flaps run aft and down with flapsDeg (more at 30 than at 10), the Kruegers drop', () => {
    for (const s of ['left', 'right'] as const) {
      for (const sp of ['inboard', 'outboard'] as const) {
        const n = B747_PART.flapMain(s, sp);
        const a = centre(n, state({ flapsDeg: 0 }), 600);
        const b = centre(n, state({ flapsDeg: 10 }), 600);
        const c = centre(n, state({ flapsDeg: 30 }), 600);
        expect(b.z, n).toBeGreaterThan(a.z + 0.3);
        expect(c.z).toBeGreaterThan(b.z);
        expect(c.y).toBeLessThan(b.y - 0.2);
        expect(b.y).toBeLessThan(a.y);
        const aft = B747_PART.flapAft(s, sp);
        const aft0 = centre(aft, state({ flapsDeg: 0 }), 600);
        const aft30 = centre(aft, state({ flapsDeg: 30 }), 600);
        expect(aft30.y).toBeLessThan(aft0.y - 0.5);
        const k = B747_PART.krueger(s, sp);
        const k0 = centre(k, state({ flapsDeg: 0 }), 600);
        const k1 = centre(k, state({ flapsDeg: 10 }), 600);
        expect(k1.y, k).toBeLessThan(k0.y - 0.1);
        expect(k1.z).toBeLessThan(k0.z);
      }
    }
    centre(B747_PART.flapMain('left', 'inboard'), state({ flapsDeg: 0 }), 600);
  });
  it('the fans spin with the engines and show a blurred disc at speed', () => {
    const fan = part(m, B747_PART.fan(2));
    apply(m, state({ engineRunning: false, propRpm: 0 }), 2);
    const a = fan.rotation.z;
    apply(m, state({ engineRunning: false, propRpm: 0 }), 2);
    expect(fan.rotation.z).toBeCloseTo(a, 9);
    apply(m, state({ engineRunning: true, propRpm: 100 }), 2);
    expect(Math.abs(fan.rotation.z - a)).toBeGreaterThan(0.05);
    expect(part(m, `${B747_PART.fan(2)}.disc`).visible).toBe(true);
    expect(part(m, `${B747_PART.fan(2)}.blades`).visible).toBe(false);
    apply(m, state({ engineRunning: true, propRpm: 20 }), 2);
    expect(part(m, `${B747_PART.fan(2)}.blades`).visible).toBe(true);
  });
  it('gear retraction: nose forward and up, wing gear inward and up, body gear forward and up; doors open in transit', () => {
    const down = (n: string) => bodyPos(m, (apply(m, state({ gearPos: 1 }), 2), n));
    const up = (n: string) => bodyPos(m, (apply(m, state({ gearPos: 0, instruments: { ...ground, state: 'airborne' } }), 2), n));
    const n0 = down(B747_PART.noseAxle);
    const n1 = up(B747_PART.noseAxle);
    expect(n1.z).toBeLessThan(n0.z - 1);
    expect(n1.y).toBeGreaterThan(n0.y + 1.5);
    for (const s of ['left', 'right'] as const) {
      const w0 = down(B747_PART.truck(B747_PART.wingGear(s)));
      const w1 = up(B747_PART.truck(B747_PART.wingGear(s)));
      expect(Math.abs(w1.x)).toBeLessThan(Math.abs(w0.x) - 1.5);
      expect(w1.y).toBeGreaterThan(w0.y + 1.5);
      const b0 = down(B747_PART.truck(B747_PART.bodyGear(s)));
      const b1 = up(B747_PART.truck(B747_PART.bodyGear(s)));
      expect(b1.z).toBeLessThan(b0.z - 1);
      expect(b1.y).toBeGreaterThan(b0.y + 1.5);
    }
    apply(m, state({ gearPos: 0.5, instruments: { ...ground, state: 'airborne' } }), 2);
    for (const d of B747_PART.doors) expect(part(m, d).visible, d).toBe(true);
    apply(m, state({ gearPos: 1 }), 2);
    for (const d of B747_PART.doors) expect(part(m, d).visible, d).toBe(false);
  });
  it('the trucks tilt aft-wheels-down in the air and sit level on the runway', () => {
    const t = part(m, B747_PART.truck(B747_PART.wingGear('left')));
    apply(m, state({ gearPos: 1, wheelCompression: [0, 0, 0], instruments: { ...ground, state: 'airborne' } }), 60);
    expect(t.rotation.x).toBeGreaterThan(5 * DEG);
    apply(m, state({ gearPos: 1, wheelCompression: [0.1, 0.1, 0.1] }), 60);
    expect(Math.abs(t.rotation.x)).toBeLessThan(0.5 * DEG);
  });
  it('the nose wheels steer, and every axle spins with the roll speed', () => {
    const steer = part(m, B747_PART.noseSteer);
    apply(m, state({ gearPos: 1, nosewheelSteer: 1 }));
    expect(Math.abs(steer.rotation.y)).toBeGreaterThan(0.8);
    const axles: THREE.Object3D[] = [];
    m.root.traverse((o) => {
      if (o.userData.wheels) axles.push(o);
    });
    expect(axles.length).toBe(9);
    const before = axles.map((a) => a.rotation.x);
    apply(m, state({ gearPos: 1, wheelRollSpeed: [5, 5, 5] }), 3);
    axles.forEach((a, i) => expect(Math.abs(a.rotation.x - before[i]), a.name).toBeGreaterThan(0.1));
  });
});
