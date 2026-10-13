/**
 * The Sea-Doo's moving parts go the right way: + steer (bow to starboard) turns the bars right and
 * swings the nozzle's exit to starboard (the jet pushes the stern to port); + trim aims the jet down;
 * the bucket comes down over the nozzle exit; the rider's hands stay on the grips, they lean into
 * the turn (head to starboard for + lean), crouch forward and down (+ foreAft and speed), sit back,
 * and leave the craft (hidden, swimming beside it) after a spill, a capsize and while it is righted.
 * The pure mapping (computeSeadooAnim) is neutral for missing / garbage state.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as THREE from 'three';
import {
  createSeadooModel,
  computeSeadooAnim,
  createSeadooAnim,
  createRiderPose,
  solveRiderPose,
  gripPosition,
  SEADOO_PART,
  SEADOO_SHAPE,
  BONE,
} from '../../../src/vessels/seadoo';
import { SEADOO_AIRCRAFT } from '../../../src/config';
import { createDefaultVisualState, type AircraftVisualState } from '../../../src/aircraft/types';
import { apply, part, state, toBody, type Model } from './helpers';

const JET = SEADOO_AIRCRAFT.watercraft!.propulsors[0];
const DEG = Math.PI / 180;
const E = new THREE.Vector3(JET.position.x, JET.position.y, JET.position.z);

describe('Sea-Doo moving parts', () => {
  let m: Model;
  beforeAll(() => {
    m = createSeadooModel();
    m.root.position.set(-5, 3, 12);
    m.root.quaternion.setFromEuler(new THREE.Euler(-0.05, 2.1, 0.15, 'YXZ'));
  });
  afterAll(() => m.dispose());

  const exitCentre = () => toBody(m, part(m, SEADOO_PART.nozzleTrim), new THREE.Vector3(0, 0, SEADOO_SHAPE.nozzleLength));
  const bone = (n: string) => toBody(m, part(m, `${SEADOO_PART.rider}.${n}`));
  /** The grip centres on the drawn bars (the bar frame's grip points in the body frame). */
  const gripOnBars = (side: number) => toBody(m, part(m, SEADOO_PART.barSteer), new THREE.Vector3(side * SEADOO_SHAPE.grip.x, SEADOO_SHAPE.grip.y, SEADOO_SHAPE.grip.z));

  it('+ steer turns the bars right (the right grip comes back, the left goes forward) by ~25° at full lock', () => {
    apply(m, state({ steerDeg: 0 }));
    const r0 = gripOnBars(1);
    const l0 = gripOnBars(-1);
    apply(m, state({ steerDeg: JET.maxSteerDeg }));
    const r1 = gripOnBars(1);
    const l1 = gripOnBars(-1);
    expect(r1.z).toBeGreaterThan(r0.z + 0.08);
    expect(l1.z).toBeLessThan(l0.z - 0.08);
    // The bar line (left grip → right grip) seen from above has turned clockwise by ~25°.
    const ang = (a: THREE.Vector3, b: THREE.Vector3) => Math.atan2(b.z - a.z, b.x - a.x);
    expect((ang(l1, r1) - ang(l0, r0)) / DEG).toBeGreaterThan(20);
    expect((ang(l1, r1) - ang(l0, r0)) / DEG).toBeLessThan(28);
    // The drawn grips are where gripPosition() says (the rider's IK targets).
    const g = gripPosition(1, SEADOO_SHAPE.barMaxDeg * DEG, new THREE.Vector3());
    expect(g.distanceTo(r1)).toBeLessThan(1e-6);
    apply(m, state({ steerDeg: -JET.maxSteerDeg }));
    expect(gripOnBars(1).z).toBeLessThan(r0.z - 0.08);
  });

  it("+ steer swings the nozzle's exit to STARBOARD (thrust pushes the stern to port) by the steer angle; − to port", () => {
    apply(m, state());
    const straight = exitCentre();
    expect(straight.distanceTo(E)).toBeLessThan(0.005);
    for (const deg of [22, -22, 10]) {
      apply(m, state({ steerDeg: deg }));
      const pivot = toBody(m, part(m, SEADOO_PART.nozzleSteer));
      const axis = exitCentre().sub(pivot).normalize();
      expect(axis.z).toBeGreaterThan(0);
      expect(Math.sign(axis.x)).toBe(Math.sign(deg));
      expect(Math.atan2(axis.x, axis.z) / DEG).toBeCloseTo(deg, 1);
      // The jet (out along the axis) pushes the craft the other way: its side force on the stern is to −sign(deg).
      expect(Math.sign(-axis.x)).toBe(-Math.sign(deg));
    }
  });

  it('+ trim aims the jet down, − up; the steering pivot holds still', () => {
    apply(m, state({ trimDeg: 8 }));
    const pivot = toBody(m, part(m, SEADOO_PART.nozzleSteer));
    const down = exitCentre().sub(pivot).normalize();
    expect(down.y).toBeLessThan(-Math.sin(6 * DEG));
    apply(m, state({ trimDeg: -8 }));
    const up = exitCentre().sub(pivot).normalize();
    expect(up.y).toBeGreaterThan(Math.sin(6 * DEG));
    expect(toBody(m, part(m, SEADOO_PART.nozzleSteer)).distanceTo(pivot)).toBeLessThan(1e-9);
  });

  it('bucket 1 covers the nozzle exit (the jet hits it within a few cm), bucket 0 stows it clear above; it stays inside the overall length', () => {
    const bucket = part(m, SEADOO_PART.bucket) as THREE.Mesh;
    const ray = new THREE.Raycaster();
    const castJet = () => {
      m.root.updateMatrixWorld(true);
      const pivot = toBody(m, part(m, SEADOO_PART.nozzleSteer));
      const exit = exitCentre();
      const dir = exit.clone().sub(pivot).normalize();
      const o = m.root.localToWorld(exit.clone());
      ray.set(o, m.root.localToWorld(exit.clone().add(dir)).sub(o).normalize());
      ray.far = 0.5;
      return ray.intersectObject(bucket, false);
    };
    for (const steerDeg of [0, 22, -22]) {
      apply(m, state({ bucket: 1, steerDeg }));
      const hits = castJet();
      expect(hits.length, `steer ${steerDeg}`).toBeGreaterThan(0);
      expect(hits[0].distance).toBeLessThan(0.08);
      apply(m, state({ bucket: 0, steerDeg }));
      expect(castJet().length, `stowed, steer ${steerDeg}`).toBe(0);
    }
    // Stowed: all of it over the jet's width above the nozzle's top (the side plates' pins sit either side, on the axis).
    apply(m, state({ bucket: 0 }));
    const inv = new THREE.Matrix4().copy(m.root.matrixWorld).invert().multiply(bucket.matrixWorld);
    const pos = bucket.geometry.getAttribute('position');
    let minY = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(inv);
      if (Math.abs(v.x) < 0.08) minY = Math.min(minY, v.y);
      maxZ = Math.max(maxZ, v.z);
    }
    expect(minY).toBeGreaterThan(E.y + JET.diameter / 2);
    expect(maxZ).toBeLessThan(SEADOO_SHAPE.zAft + 0.005);
    // Halfway (the iBR neutral) lies between.
    apply(m, state({ bucket: 0.5 }));
    expect(part(m, SEADOO_PART.bucketHinge).rotation.x).toBeCloseTo(-0.5 * SEADOO_SHAPE.bucketUpDeg * DEG, 6);
  });

  it("the rider's hands stay on the grips in every pose (bars at full lock, leaning, crouched, sitting back)", () => {
    for (const steerDeg of [0, 22, -22, 11]) {
      for (const lean of [0, 1, -1]) {
        for (const foreAft of [0, 1, -1]) {
          apply(m, state({ steerDeg, rider: { lean, foreAft }, speedMs: 12 }));
          for (const [side, fa] of [[-1, 'foreArmL'], [1, 'foreArmR']] as const) {
            const hand = toBody(m, part(m, `${SEADOO_PART.rider}.${fa}`), new THREE.Vector3(0, 0.37, 0));
            expect(hand.distanceTo(gripOnBars(side)), `steer ${steerDeg} lean ${lean} fwd ${foreAft} side ${side}`).toBeLessThan(0.025);
          }
        }
      }
    }
  });

  it('+ lean moves the head to starboard (the hips too, less), − to port; the head stays more upright than the torso', () => {
    apply(m, state());
    const h0 = bone('head');
    const p0 = bone('pelvis');
    apply(m, state({ rider: { lean: 1 } }));
    const h1 = bone('head');
    const p1 = bone('pelvis');
    expect(h1.x - h0.x).toBeGreaterThan(0.15);
    expect(p1.x - p0.x).toBeGreaterThan(0.02);
    expect(p1.x - p0.x).toBeLessThan(h1.x - h0.x);
    const torsoUp = new THREE.Vector3(0, 1, 0).applyQuaternion(part(m, `${SEADOO_PART.rider}.torso`).quaternion);
    const headUp = new THREE.Vector3(0, 1, 0).applyQuaternion(part(m, `${SEADOO_PART.rider}.head`).quaternion);
    expect(headUp.y).toBeGreaterThan(torsoUp.y);
    apply(m, state({ rider: { lean: -1 } }));
    expect(bone('head').x - h0.x).toBeLessThan(-0.15);
  });

  it('+ foreAft (and speed) moves the head forward and down; − sits back', () => {
    apply(m, state());
    const h0 = bone('head');
    const p0 = bone('pelvis');
    apply(m, state({ rider: { foreAft: 1 } }));
    const h1 = bone('head');
    expect(h1.z).toBeLessThan(h0.z - 0.12);
    expect(h1.y).toBeLessThan(h0.y - 0.05);
    apply(m, state({ rider: { foreAft: -1 } }));
    expect(bone('pelvis').z).toBeGreaterThan(p0.z + 0.05);
    const hb = bone('head');
    expect(hb.z).toBeGreaterThan(h1.z);
    // Speed alone crouches the rider a little.
    apply(m, state({ speedMs: 25 }));
    const hs = bone('head');
    expect(hs.z).toBeLessThan(h0.z - 0.02);
    expect(hs.y).toBeLessThan(h0.y);
  });

  it('off the craft (spill, capsize) and while righting: the rider is hidden and swims beside it; back aboard: seated again', () => {
    const body = part(m, SEADOO_PART.riderBody);
    const swimmer = part(m, SEADOO_PART.swimmer);
    apply(m, state());
    expect(body.visible).toBe(true);
    expect(swimmer.visible).toBe(false);
    for (const v of [
      state({ rider: { aboard: false, off: 'spill', offTime: 1 } }),
      state({ rider: { aboard: false, off: 'capsize', offTime: 3 } }),
      state({ righting: 0.4 }),
    ]) {
      apply(m, v);
      expect(body.visible).toBe(false);
      expect(swimmer.visible).toBe(true);
      // Beside the craft (a metre or two off its side), upright in the world, at the surface (world y = surfaceY = 0).
      const s = toBody(m, swimmer);
      expect(Math.hypot(s.x, s.z)).toBeGreaterThan(1);
      expect(Math.hypot(s.x, s.z)).toBeLessThan(2.5);
      const wp = swimmer.getWorldPosition(new THREE.Vector3());
      expect(Math.abs(wp.y)).toBeLessThan(0.05);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(swimmer.getWorldQuaternion(new THREE.Quaternion()));
      expect(up.y).toBeGreaterThan(0.999);
    }
    apply(m, state());
    expect(body.visible).toBe(true);
    expect(swimmer.visible).toBe(false);
  });

  it('the helm view hides the head (the camera is inside the helmet); other views show it', () => {
    const head = part(m, `${SEADOO_PART.rider}.head`);
    apply(m, state({}, { cameraMode: 'cockpit' }));
    expect(head.scale.x).toBeLessThan(0.01);
    for (const mode of ['chase', 'external', 'orbit'] as const) {
      apply(m, state({}, { cameraMode: mode }));
      expect(head.scale.x).toBe(1);
    }
  });
});

describe('computeSeadooAnim / solveRiderPose (pure)', () => {
  it('neutral for a missing or null vessel, and garbage-proof', () => {
    const out = createSeadooAnim();
    const base = createDefaultVisualState();
    for (const v of [{ ...base, vessel: null }, { ...base, vessel: undefined }, base] as AircraftVisualState[]) {
      computeSeadooAnim(v, out);
      expect([out.bars, out.nozzleYaw, out.nozzleTrim, out.bucket, out.lean]).toEqual([0, 0, 0, 0, 0]);
      expect(out.aboard).toBe(true);
      expect(out.swimmer).toBe(false);
      expect(out.bucketAngle).toBeCloseTo(-SEADOO_SHAPE.bucketUpDeg * DEG, 9);
    }
    const bad = state({ steerDeg: NaN, bucket: Infinity, trimDeg: -1e9, speedMs: NaN, rider: { lean: NaN, foreAft: 1e9 } });
    computeSeadooAnim(bad, out);
    for (const k of ['bars', 'nozzleYaw', 'nozzleTrim', 'bucket', 'bucketAngle', 'lean', 'fwd', 'speedMs'] as const) expect(Number.isFinite(out[k]), k).toBe(true);
    expect(out.bucket).toBe(0);
    expect(Math.abs(out.nozzleTrim)).toBeLessThanOrEqual(12 * DEG + 1e-9);
    expect(out.fwd).toBe(1);
    const huge = state({ steerDeg: 1e6 });
    computeSeadooAnim(huge, out);
    expect(out.bars).toBeCloseTo(SEADOO_SHAPE.barMaxDeg * DEG, 9);
    expect(out.nozzleYaw).toBeLessThanOrEqual((JET.maxSteerDeg + 4) * DEG);
  });

  it('bars follow steer / maxSteer proportionally; a crash centres everything', () => {
    const out = createSeadooAnim();
    computeSeadooAnim(state({ steerDeg: JET.maxSteerDeg / 2 }), out);
    expect(out.bars).toBeCloseTo((SEADOO_SHAPE.barMaxDeg / 2) * DEG, 9);
    expect(out.nozzleYaw).toBeCloseTo((JET.maxSteerDeg / 2) * DEG, 9);
    computeSeadooAnim(state({ steerDeg: 20 }, { crashed: true }), out);
    expect(out.bars).toBe(0);
    expect(out.crashed).toBe(true);
  });

  it('the neutral pose puts the eye exactly on pilotEye; poses are finite for any input', () => {
    const pose = createRiderPose();
    const G = SEADOO_AIRCRAFT.geometry;
    solveRiderPose(0, 0, 0, pose);
    expect(pose.eye.distanceTo(new THREE.Vector3(G.pilotEye.x, G.pilotEye.y, G.pilotEye.z))).toBeLessThan(1e-3);
    expect(pose.reachPitch).toBe(0);
    for (const [l, f, b] of [[NaN, Infinity, -Infinity], [5, -5, 3], [-1, 1, -0.5]]) {
      solveRiderPose(l, f, b, pose);
      for (let i = 0; i < pose.pos.length; i++) {
        expect(Number.isFinite(pose.pos[i].x + pose.pos[i].y + pose.pos[i].z), `bone ${i}`).toBe(true);
        expect(Math.abs(pose.quat[i].length() - 1)).toBeLessThan(1e-6);
      }
    }
    expect(BONE.head).toBe(2);
  });
});
