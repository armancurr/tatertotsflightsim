/**
 * The crash plan (src/crash/plan.ts): what kind of impact it was, how hard, and how each airframe
 * part leaves it (momentum kept, explosion push, spin, which parts shear off later), plus the
 * slow-motion and crash-camera curves.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  partRole, classifyImpact, impactSeverity, planBreakup, crashTimeScale, crashCameraBlend, frameDistance, crashShake,
  type PartSpec, type ImpactSpec,
} from '../../src/crash/plan';
import { CONFIG } from '../../src/config';

const C = CONFIG.crash;
const KT = 0.514444;

function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 172-like set of parts around a CG at (0, 31, 0), nose toward −Z. */
function cessna(): PartSpec[] {
  return [
    { name: 'fuselage', mass: 520, x: 0, y: 31, z: 0.3, hx: 0.6, hy: 0.75, hz: 3.8, burning: true },
    { name: 'leftWing', mass: 70, x: -2.9, y: 32.2, z: -0.1, hx: 2.6, hy: 0.1, hz: 0.75, burning: true },
    { name: 'rightWing', mass: 70, x: 2.9, y: 32.2, z: -0.1, hx: 2.6, hy: 0.1, hz: 0.75, burning: true },
    { name: 'tail', mass: 35, x: 0, y: 31.6, z: 4.6, hx: 1.7, hy: 0.9, hz: 0.6 },
    { name: 'engine', mass: 140, x: 0, y: 31, z: -1.6, hx: 0.45, hy: 0.4, hz: 0.5 },
    { name: 'prop', mass: 25, x: 0, y: 31, z: -2.2, hx: 0.95, hy: 0.95, hz: 0.1 },
    { name: 'gear.left', mass: 12, x: -1.2, y: 30.2, z: 0.4, hx: 0.12, hy: 0.35, hz: 0.12 },
  ];
}

function impact(kind: ImpactSpec['kind'], vx: number, vy: number, vz: number, severity = 1): ImpactSpec {
  return { kind, severity, vx, vy, vz, wx: 0, wy: 0, wz: 0, cgx: 0, cgy: 31, cgz: 0, ix: 0, iy: 30, iz: -2 };
}

describe('partRole', () => {
  it('maps part names to roles', () => {
    const cases: [string, string][] = [
      ['fuselage', 'core'], ['exterior', 'core'], ['leftWing', 'wing'], ['wing.right', 'wing'], ['wing', 'wing'],
      ['tail', 'tail'], ['fin', 'tail'], ['tailplane', 'tail'], ['stabilizer', 'tail'], ['engine', 'engine'], ['cowling', 'engine'],
      ['prop', 'prop'], ['propHub', 'prop'], ['spinner', 'prop'], ['gear.left', 'gear'], ['noseGear', 'gear'], ['wheel', 'gear'],
      ['canopy', 'canopy'], ['glass', 'canopy'], ['door.left', 'canopy'], ['flap.left', 'surface'], ['aileron.right', 'surface'],
      ['elevator', 'tail'], ['rudder', 'tail'], ['antenna', 'misc'],
    ];
    for (const [n, r] of cases) expect(partRole(n), n).toBe(r);
  });
});

describe('classifyImpact / impactSeverity', () => {
  it('ditching, obstacles, bumps, nose-in and skids', () => {
    expect(classifyImpact({ vx: 0, vy: -3, vz: -30, water: true })).toBe('ditch');
    expect(classifyImpact({ vx: 0, vy: -3, vz: -30, water: false, reason: 'Ditched in water' })).toBe('ditch');
    expect(classifyImpact({ vx: 0, vy: -3, vz: -45, water: false, reason: 'Hit an obstacle' })).toBe('obstacle');
    expect(classifyImpact({ vx: 0, vy: -1, vz: -5, water: false })).toBe('bump');
    expect(classifyImpact({ vx: 0, vy: -40, vz: -40, water: false })).toBe('noseIn');
    expect(classifyImpact({ vx: 0, vy: -4, vz: -45, water: false })).toBe('skid');
    expect(classifyImpact({ vx: Number.NaN, vy: Infinity, vz: 0, water: false })).toBe('bump');
  });
  it('severity is 0 below bumpKt, 1 from fullKt, monotone in between', () => {
    expect(impactSeverity(C.bumpKt * 0.5)).toBe(0);
    expect(impactSeverity(C.fullKt * 1.2)).toBe(1);
    let last = -1;
    for (let kt = 0; kt < 200; kt += 1) {
      const s = impactSeverity(kt);
      expect(s).toBeGreaterThanOrEqual(last);
      last = s;
    }
    expect(impactSeverity(Number.NaN)).toBe(0);
  });
});

describe('planBreakup', () => {
  const v = 95 * KT;
  it('the fuselage is the core; every plan is finite', () => {
    const { core, plans } = planBreakup(cessna(), impact('noseIn', 0, -v * 0.7, -v * 0.7), rng());
    expect(core).toBe(0);
    expect(plans).toHaveLength(7);
    for (const p of plans) for (const k of ['vx', 'vy', 'vz', 'wx', 'wy', 'wz'] as const) expect(Number.isFinite(p[k])).toBe(true);
    expect(plans[0].attach).toBe(false);
  });
  it('nose-in: the ground stops the dive — the core keeps little forward speed and does not keep driving down', () => {
    const { plans } = planBreakup(cessna(), impact('noseIn', 0, -v * 0.7, -v * 0.7), rng());
    const core = plans[0];
    expect(-core.vz).toBeLessThan(v * 0.7 * 0.6);
    expect(core.vy).toBeGreaterThanOrEqual(-1);
    // everything flies apart at once
    expect(plans.filter((p) => p.attach)).toHaveLength(0);
  });
  it('shallow skid: the core slides on with most of its speed, wings and tail shear off later, the engine tumbles on ahead', () => {
    const { plans } = planBreakup(cessna(), impact('skid', 0, -3, -v), rng());
    const [core, lw, rw, tail, engine, prop] = plans;
    expect(-core.vz).toBeGreaterThan(v * 0.7);
    expect(Math.abs(core.vy)).toBeLessThan(4);
    for (const p of [lw, rw, tail]) {
      expect(p.attach).toBe(true);
      expect(p.detachAt).toBeGreaterThan(0);
      expect(p.detachAt).toBeLessThan(4);
      expect(Number.isFinite(p.breakImpulse)).toBe(true);
    }
    expect(engine.attach).toBe(false);
    expect(-engine.vz).toBeGreaterThanOrEqual(-core.vz * 0.9);
    expect(prop.attach).toBe(false);
    expect(core.friction).toBeLessThan(0.6); // a long slide
  });
  it('heavier parts fly less: the explosion push scales with 1/√mass', () => {
    const parts: PartSpec[] = [
      { name: 'fuselage', mass: 500, x: 0, y: 31, z: 0, hx: 0.6, hy: 0.7, hz: 3.5 },
      { name: 'misc', mass: 10, x: 3, y: 31, z: 0, hx: 0.3, hy: 0.3, hz: 0.3 },
      { name: 'misc', mass: 200, x: 3, y: 31, z: 0, hx: 0.3, hy: 0.3, hz: 0.3 },
    ];
    let light = 0;
    let heavy = 0;
    for (let s = 1; s < 20; s++) {
      const { plans } = planBreakup(parts, impact('noseIn', 0, -2, -2), rng(s));
      light += Math.hypot(plans[1].vx, plans[1].vy, plans[1].vz + 0);
      heavy += Math.hypot(plans[2].vx, plans[2].vy, plans[2].vz + 0);
    }
    expect(light).toBeGreaterThan(heavy * 1.5);
  });
  it('the explosion pushes parts away from the impact point', () => {
    const parts = cessna();
    const imp = impact('noseIn', 0, -2, -2);
    let away = 0;
    for (let s = 1; s < 30; s++) {
      const { plans } = planBreakup(parts, imp, rng(s));
      plans.forEach((p, i) => {
        const dx = parts[i].x - imp.ix, dy = parts[i].y - imp.iy, dz = parts[i].z - imp.iz;
        away += Math.sign(p.vx * dx + p.vy * dy + p.vz * dz);
      });
    }
    expect(away).toBeGreaterThan(0.5 * 29 * parts.length);
  });
  it('ditching: nothing burns, the airframe floats for a while, the engine sinks', () => {
    const { plans } = planBreakup(cessna(), impact('ditch', 0, -4, -30, 0.6), rng());
    expect(plans.every((p) => !p.burning)).toBe(true);
    expect(plans[0].float).toBeGreaterThan(1);
    expect(plans[1].float).toBeGreaterThan(1);
    expect(plans[4].float).toBe(0);
  });
  it('a bump keeps the aircraft in one piece and nothing burns', () => {
    const { plans } = planBreakup(cessna(), impact('bump', 0, -1, -6, 0), rng());
    expect(plans.every((p) => !p.burning)).toBe(true);
    for (const p of plans.slice(1)) {
      expect(p.attach).toBe(true);
      expect(p.detachAt).toBe(Infinity);
    }
  });
  it('fuzz: any impact and any parts give finite, bounded launches', () => {
    const part = fc.record({
      name: fc.constantFrom('fuselage', 'leftWing', 'rightWing', 'tail', 'engine', 'prop', 'gear', 'canopy', 'x'),
      mass: fc.double({ min: -5, max: 2000 }),
      x: fc.double({ min: -20, max: 20 }), y: fc.double({ min: 0, max: 60 }), z: fc.double({ min: -20, max: 20 }),
      hx: fc.double({ min: 0, max: 6 }), hy: fc.double({ min: 0, max: 3 }), hz: fc.double({ min: 0, max: 8 }),
      burning: fc.boolean(),
    });
    fc.assert(
      fc.property(
        fc.array(part, { minLength: 1, maxLength: 12 }),
        fc.constantFrom('noseIn', 'skid', 'obstacle', 'ditch', 'bump'),
        fc.double({ min: -1, max: 2 }),
        fc.double({ min: -300, max: 300 }), fc.double({ min: -300, max: 100 }), fc.double({ min: -300, max: 300 }),
        fc.double({ min: -10, max: 10 }),
        fc.integer(),
        (parts, kind, sev, vx, vy, vz, w, seed) => {
          const imp: ImpactSpec = { kind, severity: sev, vx, vy, vz, wx: w, wy: -w, wz: w * 0.5, cgx: 0, cgy: 30, cgz: 0, ix: 1, iy: 29, iz: -2 };
          const { core, plans } = planBreakup(parts, imp, rng(seed));
          expect(core).toBeGreaterThanOrEqual(0);
          expect(core).toBeLessThan(parts.length);
          expect(plans[core].attach).toBe(false);
          for (const p of plans) {
            for (const k of ['vx', 'vy', 'vz', 'wx', 'wy', 'wz', 'restitution', 'friction', 'float', 'floodTime'] as const) expect(Number.isFinite(p[k])).toBe(true);
            expect(Math.hypot(p.vx, p.vy, p.vz)).toBeLessThanOrEqual(C.debris.maxSpeed + 1e-6);
            expect(Math.hypot(p.wx, p.wy, p.wz)).toBeLessThanOrEqual(C.debris.maxSpin + 1e-6);
            expect(p.detachAt).toBeGreaterThanOrEqual(0);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('slow motion and the crash camera', () => {
  it('slow motion holds, then eases back to real time', () => {
    const S = C.slowMo;
    expect(crashTimeScale(0)).toBeCloseTo(S.scale);
    expect(crashTimeScale(S.hold * 0.9)).toBeCloseTo(S.scale);
    expect(crashTimeScale(S.hold + S.ramp + 0.01)).toBe(1);
    let last = 0;
    for (let t = 0; t < 5; t += 0.01) {
      const k = crashTimeScale(t);
      expect(k).toBeGreaterThanOrEqual(last - 1e-12);
      expect(k).toBeGreaterThanOrEqual(S.scale - 1e-12);
      expect(k).toBeLessThanOrEqual(1);
      last = k;
    }
    expect(crashTimeScale(Number.NaN)).toBe(1);
  });
  it('the crash camera blends in smoothly (at once from the cockpit, whose airframe has gone)', () => {
    expect(crashCameraBlend(0, 'chase')).toBe(0);
    expect(crashCameraBlend(C.camera.blendEnd + 0.1, 'chase')).toBe(1);
    expect(crashCameraBlend(0.9, 'cockpit')).toBe(1);
    let last = 0;
    for (let t = 0; t < 6; t += 0.02) {
      const b = crashCameraBlend(t, 'chase');
      expect(b).toBeGreaterThanOrEqual(last);
      last = b;
    }
    expect(crashCameraBlend(Number.NaN, 'chase')).toBe(0);
  });
  it('frames the debris field: the distance grows with the spread, within limits', () => {
    expect(frameDistance(0)).toBe(C.camera.minDistance);
    expect(frameDistance(1e6)).toBe(C.camera.maxDistance);
    expect(frameDistance(40)).toBeGreaterThan(frameDistance(20));
    expect(frameDistance(Number.NaN)).toBe(C.camera.minDistance);
  });
  it('the impact shake is heavy and brief', () => {
    expect(crashShake(0)).toBe(1);
    expect(crashShake(C.camera.shakeTau * 4)).toBeLessThan(0.05);
    expect(crashShake(-1)).toBe(0);
  });
});
