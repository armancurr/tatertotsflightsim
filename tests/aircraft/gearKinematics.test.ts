import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  MAIN_GEAR,
  NOSE_GEAR,
  bellyY,
  createMainGearPose,
  createNoseGearPose,
  mainGearPose,
  noseGearPose,
  skinProtrusion,
  tyreProfile,
  wellCutDistance,
} from '../../src/aircraft/gearKinematics';
import { gearRetraction } from '../../src/aircraft/animate';
import { fuselageSection, type SectionParams } from '../../src/aircraft/shape';
import { CONFIG } from '../../src/config';

const G = CONFIG.aircraft.geometry;
const sec: SectionParams = { top: 0, bottom: 0, halfWidth: 0, widthY: 0, nTop: 2, nBot: 2 };
const v = (p: { x: number; y: number; z: number }) => new THREE.Vector3(p.x, p.y, p.z);

describe('fuselage envelope helpers', () => {
  it('bellyY is the section bottom on the centreline, symmetric, and rises toward the sides', () => {
    for (const z of [-1.2, -0.5, 0, 0.6, 1.3, 2.0]) {
      fuselageSection(z, sec);
      expect(bellyY(0, z)).toBeCloseTo(sec.bottom, 6);
      expect(bellyY(0.3, z)).toBeCloseTo(bellyY(-0.3, z), 9);
      expect(bellyY(0.3, z)).toBeGreaterThan(bellyY(0.1, z));
    }
  });
  it('skinProtrusion measures metres outside the skin (negative inside)', () => {
    const z = 0.6;
    const yb = bellyY(0, z);
    expect(skinProtrusion(0, yb - 0.01, z)).toBeCloseTo(0.01, 3);
    expect(skinProtrusion(0, yb + 0.05, z)).toBeLessThan(-0.04);
    expect(skinProtrusion(0, 0, z)).toBeLessThan(-0.3);
    expect(skinProtrusion(1.5, 0, z)).toBeGreaterThan(0.8);
    expect(skinProtrusion(0, 0, 9)).toBeGreaterThan(3);
  });
});

describe('main gear kinematics (172RG: legs swing aft/inward, wheels lie flat in open belly wells)', () => {
  const pose = createMainGearPose();
  it('the leg is rigid: pivot → foot is the same length down and stowed', () => {
    const P = v(MAIN_GEAR.pivot);
    expect(v(MAIN_GEAR.footDown).distanceTo(P)).toBeCloseTo(MAIN_GEAR.legLength, 6);
    expect(v(MAIN_GEAR.footStowed).distanceTo(P)).toBeCloseTo(MAIN_GEAR.legLength, 6);
  });
  for (const side of [-1, 1] as const) {
    it(`side ${side}: gear down puts the wheel on the physics contact point`, () => {
      mainGearPose(side, 0, 0, pose);
      const w = side < 0 ? G.leftMainWheel : G.rightMainWheel;
      expect(pose.wheel.x).toBeCloseTo(w.x, 6);
      expect(pose.wheel.y).toBeCloseTo(w.y + G.mainWheelRadius, 6);
      expect(pose.wheel.z).toBeCloseTo(w.z, 6);
    });
    it(`side ${side}: stowed, the wheel lies (nearly) flat behind the cabin inside its well`, () => {
      mainGearPose(side, 1, 0, pose);
      expect(pose.wheel.x * side).toBeGreaterThan(0.12);
      expect(pose.wheel.x * side).toBeLessThan(0.32);
      expect(pose.wheel.z).toBeGreaterThan(0.9);
      expect(pose.wheel.z).toBeLessThan(1.6);
      // Axle within 25° of vertical (wheel face follows the belly), pointing down from the leg foot.
      expect(pose.axleDir.y).toBeLessThan(-Math.cos(25 * (Math.PI / 180)));
      expect(wellCutDistance(pose.wheel.x, pose.wheel.z)).toBeGreaterThan(0.15);
      expect(skinProtrusion(pose.wheel.x, pose.wheel.y, pose.wheel.z)).toBeLessThan(-0.04);
    });
    it(`side ${side}: strut compression lifts the wheel straight up when down, and is ignored when stowed`, () => {
      mainGearPose(side, 0, 0, pose);
      const y0 = pose.wheel.y;
      const x0 = pose.wheel.x;
      mainGearPose(side, 0, 0.12, pose);
      expect(pose.wheel.y - y0).toBeCloseTo(0.12, 6);
      expect(pose.wheel.x).toBeCloseTo(x0, 6);
      mainGearPose(side, 1, 0, pose);
      const s0 = pose.wheel.clone();
      mainGearPose(side, 1, 0.15, pose);
      expect(pose.wheel.distanceTo(s0)).toBeLessThan(1e-9);
    });
  }
  it('stowed tyre shows only a sliver below the belly skin (0.3–3 cm)', () => {
    mainGearPose(1, 1, 0, pose);
    const prof = tyreProfile(G.mainWheelRadius, MAIN_GEAR.rim, MAIN_GEAR.tyreWidth, 12);
    const a = pose.axleDir;
    const u = new THREE.Vector3(0, 0, 1).cross(a).normalize();
    const w = a.clone().cross(u).normalize();
    let worst = -Infinity;
    const p = new THREE.Vector3();
    for (const [r, h] of prof) {
      for (let k = 0; k < 48; k++) {
        const t = (k / 48) * Math.PI * 2;
        p.copy(pose.wheel).addScaledVector(a, h).addScaledVector(u, r * Math.cos(t)).addScaledVector(w, r * Math.sin(t));
        worst = Math.max(worst, skinProtrusion(p.x, p.y, p.z));
      }
    }
    expect(worst).toBeGreaterThan(0.003);
    expect(worst).toBeLessThan(0.03);
  });
  it('the leg sweeps aft through the air, not through the cabin: the foot stays outside the skin mid-swing', () => {
    for (let s = 0.1; s <= 0.8; s += 0.05) {
      mainGearPose(1, s, 0, pose);
      const inWell = wellCutDistance(pose.foot.x, pose.foot.z) > 0;
      expect(inWell || skinProtrusion(pose.foot.x, pose.foot.y, pose.foot.z) > -0.01).toBe(true);
    }
  });
});

describe('nose gear kinematics', () => {
  const pose = createNoseGearPose();
  it('gear down: the nose wheel sits on the physics contact point; steering turns it', () => {
    noseGearPose(0, 0, 0, pose);
    expect(pose.wheel.x).toBeCloseTo(G.noseWheel.x, 6);
    expect(pose.wheel.y).toBeCloseTo(G.noseWheel.y + G.noseWheelRadius, 6);
    expect(pose.wheel.z).toBeCloseTo(G.noseWheel.z, 6);
    noseGearPose(0, 0, 0.2, pose);
    expect(pose.steerRad).toBeCloseTo(0.2, 9);
  });
  it('stowed: the leg lies aft in the nose well, wheel inside the skin, steering centred', () => {
    noseGearPose(1, 0.1, 0.2, pose);
    expect(pose.steerRad).toBe(0);
    expect(pose.slide).toBe(0);
    expect(pose.wheel.distanceTo(v(NOSE_GEAR.wheelStowed))).toBeLessThan(1e-9);
    expect(wellCutDistance(pose.wheel.x, pose.wheel.z)).toBeGreaterThan(0.03);
    const lowest = pose.wheel.y - G.noseWheelRadius;
    expect(lowest).toBeGreaterThan(bellyY(0, pose.wheel.z) + 0.003);
  });
  it('the folding drag brace keeps its link lengths all the way', () => {
    const l1 = NOSE_GEAR.braceUpper;
    const l2 = NOSE_GEAR.braceLower;
    for (let s = 0; s <= 1.0001; s += 0.1) {
      noseGearPose(s, 0, 0, pose);
      expect(pose.braceKnee.distanceTo(v(NOSE_GEAR.braceAnchor))).toBeCloseTo(l1, 5);
      expect(pose.braceKnee.distanceTo(pose.braceAttach)).toBeCloseTo(l2, 5);
    }
  });
});

describe('gear sequencing: doors open → legs move → doors close', () => {
  it('doors are fully open whenever a leg is away from its stowed position', () => {
    for (let g = 0; g <= 1.00001; g += 0.002) {
      const s = { ...gearRetraction(g) };
      if (s.nose < 0.999 || s.main < 0.999) expect(s.door).toBeGreaterThan(0.995);
    }
  });
  it('doors only move while both legs are stowed', () => {
    for (let g = 0; g <= 1.00001; g += 0.002) {
      const s = { ...gearRetraction(g) };
      if (s.door > 0.001 && s.door < 0.995) {
        expect(s.nose).toBeGreaterThan(0.999);
        expect(s.main).toBeGreaterThan(0.999);
      }
    }
  });
  it('legs retract monotonically and doors open monotonically with gearPos', () => {
    let prev = { ...gearRetraction(0) };
    for (let g = 0.001; g <= 1.00001; g += 0.001) {
      const s = { ...gearRetraction(g) };
      expect(s.nose).toBeLessThanOrEqual(prev.nose + 1e-12);
      expect(s.main).toBeLessThanOrEqual(prev.main + 1e-12);
      expect(s.door).toBeGreaterThanOrEqual(prev.door - 1e-12);
      prev = s;
    }
  });
});

describe('belly openings (plan view)', () => {
  it('cover the leg pivots, the stowed wheels and the nose well, and nothing on the centreline mid-cabin', () => {
    const P = MAIN_GEAR.pivot;
    expect(wellCutDistance(P.x, P.z)).toBeGreaterThan(0);
    expect(wellCutDistance(-P.x, P.z)).toBeGreaterThan(0);
    expect(wellCutDistance(MAIN_GEAR.wheelStowed.x, MAIN_GEAR.wheelStowed.z)).toBeGreaterThan(0.15);
    expect(wellCutDistance(0, NOSE_GEAR.wheelStowed.z)).toBeGreaterThan(0.05);
    expect(wellCutDistance(0, 0.2)).toBeLessThan(0);
    expect(wellCutDistance(0, 2.5)).toBeLessThan(0);
  });
});
