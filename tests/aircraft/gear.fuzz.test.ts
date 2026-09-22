import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import {
  MAIN_GEAR,
  NOSE_GEAR,
  createMainGearPose,
  createNoseGearPose,
  mainGearPose,
  noseGearPose,
  skinProtrusion,
  tyreProfile,
  wellCutDistance,
} from '../../src/aircraft/gearKinematics';
import { gearRetraction } from '../../src/aircraft/animate';
import { CONFIG } from '../../src/config';

const G = CONFIG.aircraft.geometry;
const wild = fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true });
const retract = fc.oneof(fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: -5, max: 5, noNaN: true }), fc.constantFrom(Number.NaN, Infinity, -Infinity));
const finite3 = (v: THREE.Vector3) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

describe('property: gear kinematics are always finite and rigid', () => {
  const mp = createMainGearPose();
  const np = createNoseGearPose();
  it('main gear: any retraction/compression gives finite poses, unit quaternions, a rigid leg', () => {
    fc.assert(
      fc.property(fc.constantFrom(-1 as const, 1 as const), retract, fc.oneof(wild, fc.constantFrom(Number.NaN)), (side, s, c) => {
        mainGearPose(side, s, c, mp);
        expect(finite3(mp.foot) && finite3(mp.wheel)).toBe(true);
        expect(Math.abs(mp.legQuat.length() - 1)).toBeLessThan(1e-9);
        expect(Math.abs(mp.axleQuat.length() - 1)).toBeLessThan(1e-9);
        expect(Number.isFinite(mp.legScale)).toBe(true);
        // Compression can only shorten the leg by the strut travel.
        const P = new THREE.Vector3(side * MAIN_GEAR.pivot.x, MAIN_GEAR.pivot.y, MAIN_GEAR.pivot.z);
        const len = mp.foot.distanceTo(P);
        expect(len).toBeLessThanOrEqual(MAIN_GEAR.legLength + 1e-9);
        expect(len).toBeGreaterThan(MAIN_GEAR.legLength - G.strutTravel - 1e-9);
        expect(Math.abs(mp.legScale * MAIN_GEAR.legLength - len)).toBeLessThan(1e-9);
        // The wheel hangs off the foot on the axle stub.
        expect(mp.wheel.distanceTo(mp.foot)).toBeCloseTo(MAIN_GEAR.stub, 9);
      }),
      { numRuns: 400 },
    );
  });
  it('nose gear: any retraction/compression/steer gives finite poses and a brace that keeps its lengths', () => {
    fc.assert(
      fc.property(retract, fc.oneof(wild, fc.constantFrom(Number.NaN)), fc.oneof(wild, fc.constantFrom(Number.NaN)), (s, c, st) => {
        noseGearPose(s, c, st, np);
        expect(finite3(np.wheel) && finite3(np.braceKnee) && finite3(np.braceAttach)).toBe(true);
        expect(Number.isFinite(np.swingRad) && Number.isFinite(np.slide) && Number.isFinite(np.steerRad)).toBe(true);
        expect(np.slide).toBeGreaterThanOrEqual(0);
        expect(np.slide).toBeLessThanOrEqual(G.strutTravel);
        const a = NOSE_GEAR.braceAnchor;
        expect(np.braceKnee.distanceTo(new THREE.Vector3(a.x, a.y, a.z))).toBeCloseTo(NOSE_GEAR.braceUpper, 5);
      }),
      { numRuns: 400 },
    );
  });
});

describe('property: the gear never cuts through the skin on its way in or out', () => {
  const mp = createMainGearPose();
  const np = createNoseGearPose();
  const prof = tyreProfile(G.mainWheelRadius, MAIN_GEAR.rim, MAIN_GEAR.tyreWidth, 6);
  const nprof = tyreProfile(G.noseWheelRadius, 0.064, 0.12, 6);
  const p = new THREE.Vector3();
  const u = new THREE.Vector3();
  const w = new THREE.Vector3();
  /** Deepest tyre point that is inside the fuselage but NOT under a belly opening. */
  function clip(c: THREE.Vector3, a: THREE.Vector3, pr: Array<[number, number]>): number {
    u.set(0, 0, 1).cross(a);
    if (u.lengthSq() < 1e-9) u.set(1, 0, 0).cross(a);
    u.normalize();
    w.copy(a).cross(u).normalize();
    let worst = 0;
    for (const [r, h] of pr) {
      for (let k = 0; k < 20; k++) {
        const t = (k / 20) * Math.PI * 2;
        p.copy(c).addScaledVector(a, h).addScaledVector(u, r * Math.cos(t)).addScaledVector(w, r * Math.sin(t));
        const d = skinProtrusion(p.x, p.y, p.z);
        if (d < 0 && wellCutDistance(p.x, p.z) < 0) worst = Math.max(worst, -d);
      }
    }
    return worst;
  }
  it('main wheels (both sides) stay outside the skin except where they rise into their wells', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, noNaN: true }), fc.constantFrom(-1 as const, 1 as const), (s, side) => {
        mainGearPose(side, s, 0, mp);
        expect(clip(mp.wheel, mp.axleDir, prof)).toBeLessThan(0.004);
      }),
      { numRuns: 200 },
    );
  });
  it('the nose wheel stays outside the skin except inside the nose well', () => {
    const axle = new THREE.Vector3(1, 0, 0);
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, noNaN: true }), (s) => {
        noseGearPose(s, 0, 0, np);
        expect(clip(np.wheel, axle, nprof)).toBeLessThan(0.004);
      }),
      { numRuns: 200 },
    );
  });
  it('gear sequencing is continuous and doors never move while a leg is out', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: -2e-3, max: 2e-3, noNaN: true }), (g, dg) => {
        const a = { ...gearRetraction(g) };
        const b = { ...gearRetraction(Math.min(1, Math.max(0, g + dg))) };
        expect(Math.abs(a.nose - b.nose)).toBeLessThan(0.02);
        expect(Math.abs(a.main - b.main)).toBeLessThan(0.02);
        expect(Math.abs(a.door - b.door)).toBeLessThan(0.05);
        if (a.nose < 0.999 || a.main < 0.999) expect(a.door).toBeGreaterThan(0.995);
      }),
      { numRuns: 500 },
    );
  });
});
