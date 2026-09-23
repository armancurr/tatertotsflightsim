/**
 * Unit: the pure A-10 animation mapping (surfaces, speed-brake split, flaps, slats, fans, GAU-8,
 * gear sequence, lights) against the real aircraft's numbers.
 */
import { describe, it, expect } from 'vitest';
import { createA10Anim, stepA10Anim, A10_LIMITS, fanRpmFor, gearDoor, gearLeg, strobeFlash } from '../../../src/aircraft/a10/animate';
import { createDefaultVisualState, createRestReadings, type AircraftVisualState } from '../../../src/aircraft/types';

const DEG = Math.PI / 180;
const v = (p: Partial<AircraftVisualState> = {}): AircraftVisualState => ({ ...createDefaultVisualState(), engineRunning: true, ...p });
const run = (s: AircraftVisualState, seconds: number, a = createA10Anim()) => {
  for (let t = 0; t < seconds; t += 1 / 60) stepA10Anim(s, a, 1 / 60);
  return a;
};

describe('A-10 animation mapping', () => {
  it('elevators: full back stick = 30° trailing edge up, full forward = 20° down', () => {
    expect(run(v({ elevator: 1 }), 0.1).elevatorRad).toBeCloseTo(-30 * DEG, 6);
    expect(run(v({ elevator: -1 }), 0.1).elevatorRad).toBeCloseTo(20 * DEG, 6);
  });
  it('rudders ±30°, + = trailing edge right', () => {
    expect(run(v({ rudder: 1 }), 0.1).rudderRad).toBeCloseTo(30 * DEG, 6);
    expect(run(v({ rudder: -0.5 }), 0.1).rudderRad).toBeCloseTo(-15 * DEG, 6);
  });
  it('decelerons: +aileron raises the right pair and lowers the left pair together (±20°)', () => {
    const a = run(v({ aileron: 1 }), 0.1);
    expect(a.decelRightUpperRad).toBeCloseTo(-20 * DEG, 6);
    expect(a.decelRightLowerRad).toBeCloseTo(-20 * DEG, 6);
    expect(a.decelLeftUpperRad).toBeCloseTo(20 * DEG, 6);
    expect(a.decelLeftLowerRad).toBeCloseTo(20 * DEG, 6);
  });
  it('speed brake: the halves split ±60° about the aileron position, taking ~1.8 s', () => {
    const a = createA10Anim();
    run(v({ speedBrake: 1 }), 0.9, a);
    expect(a.split).toBeGreaterThan(0.4);
    expect(a.split).toBeLessThan(0.6);
    run(v({ speedBrake: 1 }), 1.2, a);
    expect(a.split).toBe(1);
    expect(a.decelLeftUpperRad).toBeCloseTo(-60 * DEG, 6);
    expect(a.decelLeftLowerRad).toBeCloseTo(60 * DEG, 6);
    run(v({ speedBrake: 1, aileron: 1 }), 0.1, a);
    expect(a.decelRightUpperRad).toBeCloseTo(-80 * DEG, 6);
    expect(a.decelRightLowerRad).toBeCloseTo(40 * DEG, 6);
  });
  it('flaps follow flapsDeg at a finite rate and stop at 30°', () => {
    const a = createA10Anim();
    run(v({ flapsDeg: 20 }), 0.5, a);
    expect(a.flapRad).toBeLessThan(20 * DEG);
    run(v({ flapsDeg: 20 }), 3, a);
    expect(a.flapRad).toBeCloseTo(20 * DEG, 6);
    run(v({ flapsDeg: 90 }), 5, a);
    expect(a.flapRad).toBeCloseTo(A10_LIMITS.flapMaxDeg * DEG, 6);
  });
  it('slats extend only in flight above ~11° α', () => {
    const air = { ...createRestReadings(), state: 'airborne' as const, airspeedKt: 150 };
    expect(run(v({ instruments: { ...air, aoaDeg: 5 } }), 2).slat).toBe(0);
    expect(run(v({ instruments: { ...air, aoaDeg: 15 } }), 2).slat).toBe(1);
    expect(run(v({ instruments: { ...createRestReadings(), aoaDeg: 15, state: 'ground' } }), 2).slat).toBe(0);
  });
  it('fans: N1 ≈ 26 % at idle core speed, 100 % at military; off when the engine is off', () => {
    expect(fanRpmFor(70, true) / A10_LIMITS.fanMaxRpm).toBeCloseTo(0.26, 2);
    expect(fanRpmFor(100, true)).toBeCloseTo(A10_LIMITS.fanMaxRpm, 3);
    expect(fanRpmFor(100, false)).toBe(0);
    const a = run(v({ propRpm: 100 }), 0.2);
    expect(a.fanBlur).toBe(1);
    expect(run(v({ engineRunning: false, propRpm: 0 }), 0.2).fanRpm).toBe(0);
  });
  it('GAU-8: the cluster turns with gunSpin, never more than half a barrel pitch per frame, and blurs at speed', () => {
    const a = createA10Anim();
    stepA10Anim(v({ gunSpin: 1 }), a, 1 / 30);
    expect(a.gunAngle).toBeGreaterThan(0);
    expect(a.gunAngle).toBeLessThan((2 * Math.PI) / 7 / 2);
    expect(a.gunBlur).toBe(1);
    const b = createA10Anim();
    stepA10Anim(v({ gunSpin: 0 }), b, 1 / 30);
    expect(b.gunAngle).toBe(0);
    expect(b.gunBlur).toBe(0);
    // Full speed is 3,900 rds/min ÷ 7 barrels ≈ 557 rpm.
    expect(A10_LIMITS.gunMaxRpm).toBeCloseTo(557, 0);
  });
  it('gear sequence: nose doors open first, legs travel through the middle of the cycle', () => {
    expect(gearDoor(0.05)).toBeGreaterThan(0.4);
    expect(gearLeg(0.05)).toBe(0);
    expect(gearLeg(1)).toBe(1);
    expect(gearLeg(0.5)).toBeGreaterThan(0.2);
    expect(gearLeg(0.5)).toBeLessThan(0.8);
    expect(gearDoor(1)).toBe(1);
  });
  it('nose-wheel steering ±55° only with the gear locked down', () => {
    expect(run(v({ gearPos: 1, nosewheelSteer: 1 }), 0.1).noseSteerRad).toBeCloseTo(55 * DEG, 6);
    expect(run(v({ gearPos: 0.5, nosewheelSteer: 1 }), 0.1).noseSteerRad).toBe(0);
  });
  it('a wreck is dark and its gun and fans stop', () => {
    const a = run(v({ crashed: true, gunSpin: 1, propRpm: 100, lights: { nav: true, strobe: true, beacon: true, landing: true, taxi: true } }), 0.5);
    expect(a.nav + a.strobe + a.landing + a.taxi).toBe(0);
    expect(a.gunSpin).toBe(0);
    expect(a.fanRpm).toBe(0);
  });
  it('strobes double-flash', () => {
    let on = 0;
    for (let t = 0; t < 1.1; t += 0.01) on += strobeFlash(t);
    expect(on).toBeGreaterThan(5);
    expect(on).toBeLessThan(20);
  });
});
