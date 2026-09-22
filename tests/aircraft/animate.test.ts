import { describe, it, expect } from 'vitest';
import {
  beaconIntensity,
  computeAnimation,
  createAnimation,
  gearRetraction,
  propBlurBlend,
  strobeIntensity,
} from '../../src/aircraft/animate';
import { createDefaultVisualState } from '../../src/aircraft/types';
import { CONFIG } from '../../src/config';

const DEG = Math.PI / 180;
const S = CONFIG.aircraft.surfaces;
const M = CONFIG.aircraft.model;

function anim(patch: Partial<ReturnType<typeof createDefaultVisualState>>) {
  const v = { ...createDefaultVisualState(), ...patch };
  return computeAnimation(v, createAnimation());
}

describe('control surface mapping', () => {
  it('elevator: +1 (yoke back) raises the trailing edge by the full travel, −1 lowers it', () => {
    expect(anim({ elevator: 1 }).elevatorRad).toBeCloseTo(-S.elevatorMaxDeg * DEG);
    expect(anim({ elevator: -1 }).elevatorRad).toBeCloseTo(S.elevatorMaxDeg * DEG);
    expect(anim({ elevator: 0 }).elevatorRad).toBeCloseTo(0);
    expect(anim({ elevator: 3 }).elevatorRad).toBeCloseTo(-S.elevatorMaxDeg * DEG);
  });

  it('ailerons: roll right raises the right aileron fully and drops the left one less (differential)', () => {
    const a = anim({ aileron: 1 });
    expect(a.aileronRightRad).toBeCloseTo(-S.aileronMaxDeg * DEG);
    expect(a.aileronLeftRad).toBeCloseTo(S.aileronMaxDeg * M.aileronDownRatio * DEG);
    const b = anim({ aileron: -1 });
    expect(b.aileronLeftRad).toBeCloseTo(-S.aileronMaxDeg * DEG);
    expect(b.aileronRightRad).toBeCloseTo(S.aileronMaxDeg * M.aileronDownRatio * DEG);
    for (const x of [-5, -1, -0.3, 0, 0.4, 1, 7]) {
      const c = anim({ aileron: x });
      expect(Math.abs(c.aileronLeftRad)).toBeLessThanOrEqual(S.aileronMaxDeg * DEG + 1e-9);
      expect(Math.abs(c.aileronRightRad)).toBeLessThanOrEqual(S.aileronMaxDeg * DEG + 1e-9);
    }
  });

  it('rudder: +1 swings the trailing edge right by the full travel, clamped', () => {
    expect(anim({ rudder: 1 }).rudderRad).toBeCloseTo(S.rudderMaxDeg * DEG);
    expect(anim({ rudder: -2 }).rudderRad).toBeCloseTo(-S.rudderMaxDeg * DEG);
  });

  it('trim tab: nose-up trim drops the tab trailing edge', () => {
    expect(anim({ trim: 1 }).trimTabRad).toBeCloseTo(S.trimTabMaxDeg * DEG);
    expect(anim({ trim: -1 }).trimTabRad).toBeCloseTo(-S.trimTabMaxDeg * DEG);
  });

  it('flaps: deflect to the commanded angle (≤ max) and slide aft as they go down', () => {
    const up = anim({ flapsDeg: 0 });
    const half = anim({ flapsDeg: 15 });
    const full = anim({ flapsDeg: 30 });
    expect(up.flapRad).toBeCloseTo(0);
    expect(up.flapSlide).toBeCloseTo(0);
    expect(full.flapRad).toBeCloseTo(S.flapMaxDeg * DEG);
    expect(full.flapSlide).toBeCloseTo(M.flapSlideM);
    expect(half.flapSlide).toBeGreaterThan(0);
    expect(half.flapSlide).toBeLessThan(full.flapSlide);
    expect(anim({ flapsDeg: 45 }).flapRad).toBeCloseTo(S.flapMaxDeg * DEG);
    expect(anim({ flapsDeg: -5 }).flapRad).toBeCloseTo(0);
  });

  it('nosewheel steering maps −1..1 to the steering limit', () => {
    expect(anim({ nosewheelSteer: 1 }).noseSteerRad).toBeCloseTo(S.nosewheelSteerMaxDeg * DEG);
    expect(anim({ nosewheelSteer: -1 }).noseSteerRad).toBeCloseTo(-S.nosewheelSteerMaxDeg * DEG);
  });

  it('cockpit controls follow the pilot inputs', () => {
    const a = anim({ elevator: 1, aileron: 1, rudder: 1 });
    expect(a.yokePull).toBeCloseTo(M.yokeTravelM);
    expect(a.yokeRollRad).toBeCloseTo(M.yokeRollMaxDeg * DEG);
    expect(a.pedalRight).toBeCloseTo(M.pedalTravelM);
  });

  it('writes into the object it is given (no allocation per frame)', () => {
    const out = createAnimation();
    expect(computeAnimation(createDefaultVisualState(), out)).toBe(out);
  });
});

describe('gear retraction', () => {
  it('gearPos 1 = down and locked, doors open', () => {
    const g = gearRetraction(1);
    expect(g.nose).toBeCloseTo(0);
    expect(g.main).toBeCloseTo(0);
    expect(g.door).toBeCloseTo(1);
  });
  it('gearPos 0 = fully stowed, doors shut', () => {
    const g = gearRetraction(0);
    expect(g.nose).toBeCloseTo(1);
    expect(g.main).toBeCloseTo(1);
    expect(g.door).toBeCloseTo(0);
  });
  it('gearPos 0.5 = legs part-way, doors open for the wheels to pass', () => {
    const g = gearRetraction(0.5);
    expect(g.nose).toBeGreaterThan(0.1);
    expect(g.nose).toBeLessThan(0.9);
    expect(g.main).toBeGreaterThan(0.1);
    expect(g.main).toBeLessThan(0.9);
    expect(g.door).toBeCloseTo(1);
  });
  it('the nose leg swings aft by the configured angle', () => {
    expect(anim({ gearPos: 0 }).noseGearAngleRad).toBeCloseTo(-M.noseGearRetractDeg * DEG);
    expect(anim({ gearPos: 1 }).noseGearAngleRad).toBeCloseTo(0);
    const mid = anim({ gearPos: 0.5 }).noseGearAngleRad;
    expect(mid).toBeLessThan(0);
    expect(mid).toBeGreaterThan(-M.noseGearRetractDeg * DEG);
  });
  it('is monotonic in gearPos', () => {
    let prev = gearRetraction(0).main;
    for (let p = 0.05; p <= 1.0001; p += 0.05) {
      const m = gearRetraction(p).main;
      expect(m).toBeLessThanOrEqual(prev + 1e-12);
      prev = m;
    }
  });
});

describe('propeller blur', () => {
  it('shows solid blades when stopped and a full disc at cruise rpm', () => {
    expect(propBlurBlend(0)).toBe(0);
    expect(propBlurBlend(M.propBlurStartRpm)).toBe(0);
    expect(propBlurBlend(2400)).toBe(1);
    const mid = propBlurBlend((M.propBlurStartRpm + M.propBlurFullRpm) / 2);
    expect(mid).toBeGreaterThan(0.2);
    expect(mid).toBeLessThan(0.8);
  });
  it('never decreases as rpm rises', () => {
    let prev = 0;
    for (let r = 0; r <= 2700; r += 25) {
      const b = propBlurBlend(r);
      expect(b).toBeGreaterThanOrEqual(prev);
      prev = b;
    }
  });
  it('is carried into the animation output', () => {
    expect(anim({ propRpm: 2400 }).propBlend).toBe(1);
    expect(anim({ propRpm: 0 }).propBlend).toBe(0);
  });
});

describe('light timing', () => {
  function sample(fn: (t: number) => number, period: number) {
    const n = 4000;
    let on = 0;
    let max = 0;
    let min = Infinity;
    for (let i = 0; i < n; i++) {
      const v = fn((i / n) * period * 3);
      max = Math.max(max, v);
      min = Math.min(min, v);
      if (v > 0.5) on++;
    }
    return { duty: on / n, max, min };
  }

  it('strobes give short, full-brightness flashes once per period', () => {
    const s = sample(strobeIntensity, M.strobePeriodS);
    expect(s.max).toBeCloseTo(1);
    expect(s.min).toBe(0);
    expect(s.duty).toBeGreaterThan(0.01);
    expect(s.duty).toBeLessThan(0.15);
    expect(strobeIntensity(0.01)).toBeCloseTo(strobeIntensity(0.01 + M.strobePeriodS));
    expect(strobeIntensity(M.strobePeriodS / 2)).toBe(0);
  });

  it('the beacon pulses smoothly once per period', () => {
    const b = sample(beaconIntensity, M.beaconPeriodS);
    expect(b.max).toBeGreaterThan(0.95);
    expect(b.min).toBeLessThan(0.05);
    expect(b.duty).toBeGreaterThan(0.08);
    expect(b.duty).toBeLessThan(0.4);
    expect(beaconIntensity(0.3)).toBeCloseTo(beaconIntensity(0.3 + M.beaconPeriodS));
  });

  it('switched-off lights are dark; switched-on steady lights are full', () => {
    const lights = { nav: false, strobe: false, beacon: false, landing: false, taxi: false };
    const off = anim({ lights, time: 0.01 });
    expect(off.nav).toBe(0);
    expect(off.strobe).toBe(0);
    expect(off.beacon).toBe(0);
    expect(off.landing).toBe(0);
    const on = anim({ lights: { nav: true, strobe: true, beacon: true, landing: true, taxi: true }, time: 0.01 });
    expect(on.nav).toBe(1);
    expect(on.landing).toBe(1);
    expect(on.taxi).toBe(1);
    expect(on.strobe).toBeCloseTo(strobeIntensity(0.01));
    expect(on.beacon).toBeCloseTo(beaconIntensity(0.01));
  });
});
