import { describe, it, expect } from 'vitest';
import { createF16Anim, stepF16Anim, F16_LIMITS, type F16Anim } from '../../../src/aircraft/f16/animate';
import { createDefaultVisualState, createRestReadings, type AircraftVisualState } from '../../../src/aircraft/types';

const DEG = Math.PI / 180;

function vs(patch: Partial<AircraftVisualState> = {}): AircraftVisualState {
  return { ...createDefaultVisualState(), engineRunning: true, ...patch };
}

/** Run the animation long enough for every rate-limited value to settle. */
function settle(v: AircraftVisualState, a: F16Anim = createF16Anim(), seconds = 8): F16Anim {
  for (let t = 0; t < seconds; t += 1 / 60) stepF16Anim(v, a, 1 / 60);
  return a;
}

function airborne(patch: Partial<AircraftVisualState> = {}, aoaDeg = 5, throttlePct = 80): AircraftVisualState {
  return vs({
    gearPos: 0,
    wheelCompression: [0, 0, 0],
    instruments: { ...createRestReadings(), state: 'airborne', aoaDeg, throttlePct, airspeedKt: 350 },
    ...patch,
  });
}

describe('F-16 control-surface mapping', () => {
  it('+elevator (nose up) raises both stabilator trailing edges by the full 25°', () => {
    const a = settle(airborne({ elevator: 1 }));
    expect(a.stabLeftRad).toBeCloseTo(-F16_LIMITS.stabPitchDeg * DEG, 5);
    expect(a.stabRightRad).toBeCloseTo(-F16_LIMITS.stabPitchDeg * DEG, 5);
    const b = settle(airborne({ elevator: -1 }));
    expect(b.stabLeftRad).toBeCloseTo(25 * DEG, 5);
  });

  it('+aileron (roll right): right flaperon and right stab trailing edges go up, left ones down', () => {
    const a = settle(airborne({ aileron: 1 }));
    expect(a.flaperonRightRad).toBeLessThan(-15 * DEG);
    expect(a.flaperonLeftRad).toBeGreaterThan(15 * DEG);
    expect(a.stabRightRad).toBeLessThan(a.stabLeftRad);
    expect(a.stabLeftRad - a.stabRightRad).toBeCloseTo(2 * F16_LIMITS.stabRollDeg * DEG, 5);
  });

  it('stabilators never exceed ±25° even with full pitch and roll together', () => {
    const a = settle(airborne({ elevator: 1, aileron: 1 }));
    expect(Math.abs(a.stabLeftRad)).toBeLessThanOrEqual(25 * DEG + 1e-9);
    expect(Math.abs(a.stabRightRad)).toBeLessThanOrEqual(25 * DEG + 1e-9);
  });

  it('+rudder swings the rudder trailing edge right by 30°', () => {
    expect(settle(airborne({ rudder: 1 })).rudderRad).toBeCloseTo(30 * DEG, 5);
    expect(settle(airborne({ rudder: -1 })).rudderRad).toBeCloseTo(-30 * DEG, 5);
  });

  it('flaps (or the gear handle down) droop both flaperons as flaps, at most 20°', () => {
    const clean = settle(airborne({ flapsDeg: 0 }));
    expect(clean.flaperonLeftRad).toBeCloseTo(0, 5);
    const full = settle(airborne({ flapsDeg: 30 }));
    expect(full.flaperonLeftRad).toBeCloseTo(20 * DEG, 5);
    expect(full.flaperonRightRad).toBeCloseTo(20 * DEG, 5);
    const gearDown = settle(airborne({ gearPos: 1 }));
    expect(gearDown.flaperonLeftRad).toBeCloseTo(20 * DEG, 5);
  });

  it('flaperons stay inside the real −23°…+20° range at full aileron with the flaps down', () => {
    const a = settle(airborne({ flapsDeg: 30, aileron: -1 }));
    for (const r of [a.flaperonLeftRad, a.flaperonRightRad]) {
      expect(r).toBeLessThanOrEqual(20 * DEG + 1e-9);
      expect(r).toBeGreaterThanOrEqual(-23 * DEG - 1e-9);
    }
  });
});

describe('F-16 leading-edge flaps follow angle of attack', () => {
  it('schedule 1.38·α + 1.45° in flight, clamped to −2…25°', () => {
    expect(settle(airborne({}, 10)).lefRad).toBeCloseTo((1.38 * 10 + 1.45) * DEG, 3);
    expect(settle(airborne({}, 40)).lefRad).toBeCloseTo(25 * DEG, 5);
    expect(settle(airborne({}, -10)).lefRad).toBeCloseTo(-2 * DEG, 5);
  });
  it('sit 2° up on the ground (weight on wheels)', () => {
    const a = settle(vs({ gearPos: 1, wheelCompression: [0.05, 0.05, 0.05], instruments: { ...createRestReadings(), aoaDeg: 12 } }));
    expect(a.lefRad).toBeCloseTo(-2 * DEG, 5);
  });
  it('use the elevator as an α proxy when no instruments are given', () => {
    const lo = settle(airborne({ instruments: null, elevator: 0 }));
    const hi = settle(airborne({ instruments: null, elevator: 1 }));
    expect(hi.lefRad).toBeGreaterThan(lo.lefRad + 5 * DEG);
  });
  it('move at a finite actuator rate', () => {
    const a = settle(airborne({}, 0));
    stepF16Anim(airborne({}, 18), a, 1 / 60);
    expect(a.lefRad).toBeLessThan(5 * DEG);
  });
});

describe('F-16 speed brakes', () => {
  it('open over about 1–2 s to 60°, only 43° with the gear down', () => {
    const a = settle(airborne({ speedBrake: 0 }));
    stepF16Anim(airborne({ speedBrake: 1 }), a, 0.5);
    expect(a.speedBrake).toBeGreaterThan(0.1);
    expect(a.speedBrake).toBeLessThan(0.9);
    settle(airborne({ speedBrake: 1 }), a);
    expect(a.speedBrakeRad).toBeCloseTo(60 * DEG, 5);
    const g = settle(airborne({ speedBrake: 1, gearPos: 1 }));
    expect(g.speedBrakeRad).toBeCloseTo(43 * DEG, 5);
  });
});

describe('F-16 nozzle and afterburner', () => {
  it('nozzle hangs open with the engine off, opens at idle, closes at military power, opens wide in afterburner', () => {
    const off = settle(vs({ engineRunning: false, instruments: null }));
    expect(off.nozzleOpen).toBeGreaterThan(0.95);
    const idle = settle(airborne({}, 5, 5));
    expect(idle.nozzleOpen).toBeGreaterThan(0.7);
    const mil = settle(airborne({}, 5, 100));
    expect(mil.nozzleOpen).toBeLessThan(0.1);
    const ab = settle(airborne({ afterburner: 1 }, 5, 100));
    expect(ab.nozzleOpen).toBeGreaterThan(0.95);
    expect(ab.ab).toBeGreaterThan(0.95);
  });
  it('the exhaust glows faintly at military power and hot in afterburner, not at all with the engine off', () => {
    expect(settle(vs({ engineRunning: false })).heat).toBe(0);
    const mil = settle(airborne({}, 5, 100)).heat;
    const ab = settle(airborne({ afterburner: 1 }, 5, 100)).heat;
    expect(mil).toBeGreaterThan(0.2);
    expect(ab).toBeGreaterThan(mil);
  });
  it('the plume lights within a fraction of a second and dies with the engine', () => {
    const a = settle(airborne({ afterburner: 0 }, 5, 100));
    stepF16Anim(airborne({ afterburner: 1 }, 5, 100), a, 0.3);
    expect(a.ab).toBeGreaterThan(0.6);
    settle(vs({ engineRunning: false, afterburner: 1 }), a);
    expect(a.ab).toBe(0);
  });
});

describe('F-16 gear sequence', () => {
  it('gear down: legs down and locked, nose doors open, main wheel-bay doors shut again; gear up: everything stowed and shut', () => {
    const d = settle(vs({ gearPos: 1 }));
    expect(d.noseLeg).toBe(1);
    expect(d.mainLeg).toBe(1);
    expect(d.noseDoor).toBe(1);
    expect(d.mainDoor).toBe(0);
    expect(settle(vs({ gearPos: 0.5 })).mainDoor).toBe(1);
    const u = settle(vs({ gearPos: 0 }));
    expect(u.noseLeg).toBe(0);
    expect(u.mainLeg).toBe(0);
    expect(u.noseDoor).toBe(0);
    expect(u.mainDoor).toBe(0);
  });
  it('doors open before the legs move (mid-retraction the doors are open)', () => {
    const a = createF16Anim();
    stepF16Anim(vs({ gearPos: 0.12 }), a, 1 / 60);
    expect(a.noseDoor).toBeGreaterThan(0.9);
    expect(a.mainLeg).toBeLessThan(0.05);
    stepF16Anim(vs({ gearPos: 0.5 }), a, 1 / 60);
    expect(a.mainLeg).toBeGreaterThan(0.3);
    expect(a.mainLeg).toBeLessThan(0.7);
  });
  it('nose wheel steers ±32° only with the gear down; wheels spin with roll speed', () => {
    expect(settle(vs({ nosewheelSteer: 1 })).noseSteerRad).toBeCloseTo(F16_LIMITS.noseSteerDeg * DEG, 5);
    expect(settle(vs({ nosewheelSteer: 1, gearPos: 0 })).noseSteerRad).toBe(0);
    const a = createF16Anim();
    stepF16Anim(vs({ wheelRollSpeed: [10, 10, 10] }), a, 0.1);
    expect(a.wheelAngle[1]).toBeCloseTo(1 / 0.35, 3);
    expect(a.wheelAngle[0]).toBeCloseTo(1 / 0.23, 3);
  });
  it('strut compression passes through, clamped to the strut travel', () => {
    const a = settle(vs({ wheelCompression: [0.1, 0.05, 9] }));
    expect(a.compression[0]).toBeCloseTo(0.1, 6);
    expect(a.compression[1]).toBeCloseTo(0.05, 6);
    expect(a.compression[2]).toBeLessThanOrEqual(0.3);
  });
});

describe('F-16 lights', () => {
  it('nav and formation lights follow the nav switch; the anti-collision strobe flashes', () => {
    const on = settle(vs({ lights: { nav: true, strobe: true, beacon: false, landing: false, taxi: false } }));
    expect(on.nav).toBe(1);
    expect(on.formation).toBeGreaterThan(0);
    const seen = new Set<number>();
    const a = createF16Anim();
    for (let t = 0; t < 3; t += 0.01) {
      stepF16Anim(vs({ time: t, lights: { nav: true, strobe: true, beacon: false, landing: false, taxi: false } }), a, 0.01);
      seen.add(a.strobe > 0.5 ? 1 : 0);
    }
    expect(seen).toEqual(new Set([0, 1]));
  });
  it('landing and taxi lamps only shine with the gear down', () => {
    const lights = { nav: true, strobe: false, beacon: false, landing: true, taxi: true };
    expect(settle(vs({ lights, gearPos: 1 })).landing).toBe(1);
    expect(settle(vs({ lights, gearPos: 0 })).landing).toBe(0);
    expect(settle(vs({ lights, gearPos: 0 })).taxi).toBe(0);
  });
  it('a crashed jet is dark and its plume is out', () => {
    const a = settle(vs({ crashed: true, afterburner: 1, lights: { nav: true, strobe: true, beacon: true, landing: true, taxi: true } }));
    expect(a.nav + a.formation + a.strobe + a.landing + a.taxi + a.ab).toBe(0);
  });
});
