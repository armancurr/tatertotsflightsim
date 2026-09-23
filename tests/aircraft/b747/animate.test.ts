/**
 * The 747-400's pure animation mapping (src/aircraft/b747/animate.ts): control surfaces move the
 * right way and stay inside the real travel limits, the outboard ailerons lock out with the flaps
 * up, the spoilers work as speed brakes and roll spoilers, the triple-slotted flaps run aft then
 * droop, the Krueger flaps drop with any flap, the gear runs its door → leg → door sequence, the
 * trucks tilt in the air and level on the ground, the fans follow the core, and the lights flash.
 */
import { describe, it, expect } from 'vitest';
import { createB747Anim, stepB747Anim, B747_LIMITS, gearLegs, gearDoors, strobeFlash, beaconFlash, fanRpmFor } from '../../../src/aircraft/b747/animate';
import { createDefaultVisualState, createRestReadings, type AircraftVisualState } from '../../../src/aircraft/types';

const DEG = Math.PI / 180;
const L = B747_LIMITS;
function state(patch: Partial<AircraftVisualState> = {}): AircraftVisualState {
  return { ...createDefaultVisualState(), engineRunning: true, ...patch };
}
function settle(v: AircraftVisualState, frames = 400, a = createB747Anim()) {
  for (let i = 0; i < frames; i++) stepB747Anim(v, a, 1 / 30);
  return a;
}

describe('747 animation: flight controls', () => {
  it('+elevator raises the elevators (TE up = negative), limits 25° up / 20° down', () => {
    expect(settle(state({ elevator: 1 })).elevatorRad).toBeCloseTo(-L.elevatorUpDeg * DEG, 6);
    expect(settle(state({ elevator: -1 })).elevatorRad).toBeCloseTo(L.elevatorDownDeg * DEG, 6);
    expect(settle(state({ elevator: 0 })).elevatorRad).toBeCloseTo(0, 9);
  });
  it('+rudder swings both rudder panels right; the upper and lower rudders move together', () => {
    const a = settle(state({ rudder: 1 }));
    expect(a.rudderUpperRad).toBeCloseTo(L.rudderDeg * DEG, 6);
    expect(a.rudderLowerRad).toBeCloseTo(L.rudderDeg * DEG, 6);
  });
  it('+aileron: right ailerons TE up, left TE down; the outboard ailerons are locked out with the flaps up', () => {
    const clean = settle(state({ aileron: 1, flapsDeg: 0 }));
    expect(clean.aileronRightInRad).toBeLessThan(-10 * DEG);
    expect(clean.aileronLeftInRad).toBeGreaterThan(10 * DEG);
    expect(Math.abs(clean.aileronRightOutRad)).toBeLessThan(0.5 * DEG);
    expect(Math.abs(clean.aileronLeftOutRad)).toBeLessThan(0.5 * DEG);
    const dirty = settle(state({ aileron: 1, flapsDeg: 20 }));
    expect(dirty.aileronRightOutRad).toBeLessThan(-15 * DEG);
    expect(dirty.aileronLeftOutRad).toBeGreaterThan(15 * DEG);
  });
  it('the spoilers are speed brakes (both wings up) and roll spoilers (the up-going wing\'s side stays down)', () => {
    const sb = settle(state({ speedBrake: 1 }));
    for (const k of ['spoilerLeftRad', 'spoilerRightRad'] as const) expect(sb[k]).toBeGreaterThan(30 * DEG);
    const roll = settle(state({ aileron: 1 }));
    expect(roll.spoilerRightRad).toBeGreaterThan(5 * DEG);
    expect(roll.spoilerLeftRad).toBeCloseTo(0, 6);
    const none = settle(state());
    expect(none.spoilerLeftRad).toBe(0);
    expect(none.spoilerRightRad).toBe(0);
  });
});

describe('747 animation: high-lift devices', () => {
  it('the flaps track the sim position at a finite rate and never exceed 30°', () => {
    const a = createB747Anim();
    stepB747Anim(state({ flapsDeg: 30 }), a, 1 / 30);
    expect(a.flapDeg).toBeGreaterThan(0);
    expect(a.flapDeg).toBeLessThan(5);
    settle(state({ flapsDeg: 30 }), 600, a);
    expect(a.flapDeg).toBeCloseTo(30, 6);
    settle(state({ flapsDeg: 80 }), 600, a);
    expect(a.flapDeg).toBeCloseTo(30, 6);
  });
  it('Fowler motion: the flaps run aft first, then droop; the aft segment droops more than the main', () => {
    const f5 = settle(state({ flapsDeg: 5 }));
    const f10 = settle(state({ flapsDeg: 10 }));
    const f30 = settle(state({ flapsDeg: 30 }));
    expect(f5.flapTravel).toBeGreaterThan(0.3);
    expect(f5.flapMainRad).toBeLessThan(5 * DEG);
    expect(f30.flapTravel).toBeCloseTo(1, 6);
    expect(f10.flapMainRad).toBeGreaterThan(f5.flapMainRad);
    expect(f30.flapMainRad).toBeGreaterThan(f10.flapMainRad);
    expect(f30.flapAftRad).toBeGreaterThan(f30.flapMainRad * 0.5);
    expect(f30.flapMainRad + f30.flapAftRad).toBeGreaterThan(40 * DEG);
  });
  it('the leading-edge Krueger / variable-camber flaps drop with any flap setting', () => {
    expect(settle(state({ flapsDeg: 0 })).krueger).toBe(0);
    expect(settle(state({ flapsDeg: 1 })).krueger).toBeCloseTo(1, 6);
    expect(settle(state({ flapsDeg: 25 })).krueger).toBeCloseTo(1, 6);
  });
});

describe('747 animation: landing gear', () => {
  it('sequence: doors open first, legs swing, doors close again once the gear is down and locked (or up)', () => {
    expect(gearLegs(0)).toBe(0);
    expect(gearLegs(1)).toBe(1);
    expect(gearDoors(0)).toBe(0);
    expect(gearDoors(1)).toBe(0);
    expect(gearDoors(0.5)).toBe(1);
    // Doors are open before the legs start moving.
    expect(gearDoors(0.1)).toBeGreaterThan(0.9);
    expect(gearLegs(0.1)).toBeLessThan(0.05);
    for (let g = 0; g <= 1; g += 0.01) {
      expect(gearLegs(g)).toBeGreaterThanOrEqual(gearLegs(Math.max(0, g - 0.01)) - 1e-12);
    }
  });
  it('the body/wing trucks tilt (aft wheels down) in the air and sit level on the ground', () => {
    const air = settle(state({ gearPos: 1, wheelCompression: [0, 0, 0], instruments: { ...createRestReadings(), state: 'airborne' } }));
    expect(air.truckTiltRad).toBeCloseTo(L.truckTiltDeg * DEG, 6);
    const ground = settle(state({ gearPos: 1, wheelCompression: [0.1, 0.12, 0.12] }));
    expect(ground.truckTiltRad).toBeCloseTo(0, 6);
    const parked = settle(state({ gearPos: 1, wheelCompression: [0, 0, 0], instruments: { ...createRestReadings(), state: 'ground' } }));
    expect(parked.truckTiltRad).toBeCloseTo(0, 6);
  });
  it('nose steering follows the physics (70° at a crawl, fading with ground speed), only with the gear down', () => {
    expect(settle(state({ nosewheelSteer: 1, wheelRollSpeed: [0, 0, 0] })).noseSteerRad).toBeCloseTo(70 * DEG, 6);
    const fast = settle(state({ nosewheelSteer: 1, wheelRollSpeed: [60, 60, 60] })).noseSteerRad;
    expect(fast).toBeGreaterThan(0);
    expect(fast).toBeLessThan(5 * DEG);
    expect(settle(state({ nosewheelSteer: 1, gearPos: 0.5 })).noseSteerRad).toBe(0);
  });
  it('wheels spin at v / r and compression is clamped to the strut travel', () => {
    const a = createB747Anim();
    stepB747Anim(state({ wheelRollSpeed: [6.2, 6.2, 6.2] }), a, 0.1);
    expect(a.wheelAngle[0]).toBeCloseTo((6.2 / L.wheelRadius) * 0.1, 6);
    stepB747Anim(state({ wheelCompression: [9, -1, 0.2] }), a, 0.1);
    expect(a.compression).toEqual([L.maxCompression, 0, 0.2]);
  });
});

describe('747 animation: engines and lights', () => {
  it('fan speed follows the core: 0 when off, ~22 % N1 at idle, 100 % at full power', () => {
    expect(fanRpmFor(80, false)).toBe(0);
    expect(fanRpmFor(70, true) / L.fanMaxRpm).toBeCloseTo(0.22, 2);
    expect(fanRpmFor(100, true)).toBeCloseTo(L.fanMaxRpm, 6);
    const a = settle(state({ propRpm: 100, engineRunning: true }));
    expect(a.fanBlur).toBe(1);
  });
  it('strobes double-flash, beacons flash red about once a second, all dark on a wreck', () => {
    let on = 0;
    let bon = 0;
    for (let t = 0; t < 10; t += 0.01) {
      on += strobeFlash(t);
      bon += beaconFlash(t);
    }
    expect(on).toBeGreaterThan(50);
    expect(on).toBeLessThan(200);
    expect(bon).toBeGreaterThan(50);
    expect(bon).toBeLessThan(400);
    const lights = { nav: true, strobe: true, beacon: true, landing: true, taxi: true };
    const lit = settle(state({ lights, time: 0.01 }), 1);
    expect(lit.nav).toBe(1);
    expect(lit.landing).toBe(1);
    expect(lit.logo).toBe(1);
    const dead = settle(state({ lights, time: 0.01, crashed: true }), 1);
    expect(dead.nav + dead.strobe + dead.beacon + dead.landing + dead.taxi + dead.logo).toBe(0);
  });
});
