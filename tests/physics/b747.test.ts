/**
 * Boeing 747-400 unit + property tests: the config against the real aircraft (220 t light), the lift
 * and drag curves, the engines, and the airliner features the 747 adds to src/physics — spoilers
 * (flight + automatic ground spoilers), the outboard-aileron lockout, per-notch flap placards, the
 * aft-body tail bumper — plus the spawn on the runway (struts hold 220 t, no bounce, tail on the runway).
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { CONFIG, KT_TO_MS, type Config } from '../../src/config';
import type { AircraftState, Controls } from '../../src/types';
import {
  aileronEffectiveness, computeAero, createInitialState, createTrimmedState, defaultControls, dragCoefficient, FLAT_ENV, flapPlacardKt,
  groundContacts, groundSpoilerExtension, jetThrust, liftCoefficient, machDragFactor, solveTrim, step, stepJetEngine, steadyJetEngine,
} from '../../src/physics';
import { airDensity, speedOfSound } from '../../src/physics/atmosphere';
import { quatFromEuler } from '../../src/physics/frames';
import { annunciationActive } from '../../src/ui/messages';
import { along, B, B747_CFG, deg, fly747, tailClearance } from './b747-helpers';
import { RUNWAY_ENV } from './helpers';

const DEG = Math.PI / 180;
const W = B.mass * CONFIG.sim.gravity;
const ZERO = { x: 0, y: 0, z: 0 };
const NEUTRAL = { elevator: 0, aileron: 0, rudder: 0, elevatorTrim: 0 };

/** CLmax (and its α, deg) for a flap angle, from the lift curve. */
function clMax(flapsDeg: number, cfg: Config = B747_CFG): { cl: number; alphaDeg: number } {
  let cl = -Infinity;
  let alphaDeg = 0;
  for (let a = 0; a <= 25; a += 0.02) {
    const c = liftCoefficient(a * DEG, flapsDeg, cfg);
    if (c > cl) { cl = c; alphaDeg = a; }
  }
  return { cl, alphaDeg };
}
/** 1-g stall speed (KEAS = KIAS here) at 220 t. */
const vs1g = (clmax: number): number => Math.sqrt((2 * W) / (CONFIG.sim.seaLevelDensity * B.wingArea * clmax)) / KT_TO_MS;

describe('747 config: the real aircraft', () => {
  it('220 t light, 4 × 252 kN, 541 m² / 64.44 m / MAC 8.32, no afterburner, no fly-by-wire', () => {
    expect(B.mass).toBe(220000);
    expect(B.wingArea).toBe(541);
    expect(B.wingSpan).toBeCloseTo(64.44, 2);
    expect(B.meanChord).toBeCloseTo(8.32, 2);
    expect((B.wingSpan ** 2) / B.wingArea).toBeCloseTo(7.68, 1);
    const j = B.engine.jet!;
    expect(j.milThrustN).toBe(4 * 252000);
    expect(j.maxThrustN).toBe(j.milThrustN);
    expect(B.fbw).toBeNull();
    // Thrust-to-weight: light 747 ≈ 0.47 (MTOW 396.9 t: 0.26).
    expect(j.milThrustN / W).toBeGreaterThan(0.44);
    expect(j.milThrustN / W).toBeLessThan(0.5);
    // Flap detents 0/5/10/20/25/30 with placards 260/240/230/205/180; VMO 365.
    expect(B.flaps.notchesDeg).toEqual([0, 5, 10, 20, 25, 30]);
    expect(B.flaps.placardKt).toEqual([365, 260, 240, 230, 205, 180]);
    expect(B.flaps.vfeKt).toBe(180);
    expect(B.limits.vneKt).toBe(365);
    expect(B.surfaces.flapMaxDeg).toBe(30);
  });

  it('the thrust line hangs ~2 m below the CG and the tail bumper strikes at ≈ 10–11° on the wheels', () => {
    expect(B.engine.jet!.thrustPoint.y).toBeLessThan(-1.8);
    expect(B.engine.jet!.thrustPoint.y).toBeGreaterThan(-2.5);
    const main = B.geometry.leftMainWheel;
    // Rotating about the main-wheel contact (struts extended at lift-off): the tailcone end (9.6°) and the
    // aft-body bumper (10.2°) are the first to touch.
    const strike = Math.min(...B.geometry.structuralPoints.filter((p) => p.z > main.z && !p.name.startsWith('belly')).map((p) => Math.atan2(p.y - main.y, p.z - main.z) / DEG));
    expect(strike).toBeGreaterThan(9.3);
    expect(strike).toBeLessThan(11.5);
  });
});

describe('747 lift, drag and stall speeds (220 t)', () => {
  it('CLα ≈ 5.0/rad (4.9–5.3)', () => {
    const slope = (liftCoefficient(4 * DEG, 0, B747_CFG) - liftCoefficient(0, 0, B747_CFG)) / (4 * DEG);
    expect(slope).toBeGreaterThan(4.9);
    expect(slope).toBeLessThan(5.3);
  });

  it('CLmax clean ≈ 1.3 → 1-g stall ≈ 138 KIAS; flaps 30 ≈ 2.35 → ≈ 103 KIAS; Vref30 = 1.23 Vs ≈ 127 KIAS', () => {
    const clean = clMax(0);
    const f30 = clMax(30);
    expect(clean.cl).toBeGreaterThan(1.25);
    expect(clean.cl).toBeLessThan(1.45);
    expect(clean.alphaDeg).toBeGreaterThan(12);
    expect(clean.alphaDeg).toBeLessThan(16);
    expect(f30.cl).toBeGreaterThan(2.3);
    expect(f30.cl).toBeLessThan(2.6);
    expect(vs1g(clean.cl)).toBeGreaterThan(132);
    expect(vs1g(clean.cl)).toBeLessThan(145);
    expect(vs1g(f30.cl)).toBeGreaterThan(98);
    expect(vs1g(f30.cl)).toBeLessThan(110);
    expect(1.23 * vs1g(f30.cl)).toBeGreaterThan(123);
    expect(1.23 * vs1g(f30.cl)).toBeLessThan(135);
    // Take-off flaps 10: Vr 145 is ≈ 1.19 Vs.
    expect(B.limits.vrKt / vs1g(clMax(10).cl)).toBeGreaterThan(1.12);
    expect(B.limits.vrKt / vs1g(clMax(10).cl)).toBeLessThan(1.3);
  });

  it('property: CLmax grows with every flap notch; the flaps add drag', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 4 }), (n) => {
      const a = B.flaps.notchesDeg[n];
      const b = B.flaps.notchesDeg[n + 1];
      expect(clMax(b).cl).toBeGreaterThan(clMax(a).cl);
      expect(dragCoefficient(3 * DEG, 0, b, 1, B747_CFG)).toBeGreaterThan(dragCoefficient(3 * DEG, 0, a, 1, B747_CFG));
    }), { numRuns: 20 });
  });

  it('max L/D clean ≈ 17 (16–19)', () => {
    let best = 0;
    for (let a = -2; a < 10; a += 0.05) {
      const cl = liftCoefficient(a * DEG, 0, B747_CFG);
      best = Math.max(best, cl / dragCoefficient(a * DEG, 0, 0, 0, B747_CFG));
    }
    expect(best).toBeGreaterThan(16);
    expect(best).toBeLessThan(19);
  });

  it('transonic drag rise: nothing at the M 0.85 cruise, a wall past MMO 0.92', () => {
    expect(machDragFactor(0.85, B747_CFG)).toBe(1);
    expect(machDragFactor(0.88, B747_CFG)).toBeLessThan(1.15);
    expect(machDragFactor(0.92, B747_CFG)).toBeGreaterThan(1.5);
    expect(machDragFactor(0.95, B747_CFG)).toBeGreaterThan(2.2);
  });
});

describe('747 engines (4 × PW4056)', () => {
  it('high-bypass lapse: 1,008 kN static, ~80 % at M 0.2, ~20 % at FL350 M 0.85', () => {
    expect(jetThrust(1, 0, 1.225, 0, B747_CFG)).toBeCloseTo(1008000, -3);
    const m2 = jetThrust(1, 0, 1.225, 0.2, B747_CFG) / 1008000;
    expect(m2).toBeGreaterThan(0.76);
    expect(m2).toBeLessThan(0.86);
    const fl350 = jetThrust(1, 0, airDensity(10668), 0.85, B747_CFG);
    expect(fl350).toBeGreaterThan(180000);
    expect(fl350).toBeLessThan(240000);
    expect(jetThrust(0, 0, 1.225, 0, B747_CFG)).toBeLessThan(0.05 * 1008000);
  });

  it('spool idle → 95 % in 6–8 s; never an afterburner', () => {
    let e = steadyJetEngine(0, 1.225, 0, B747_CFG);
    let t95 = 0;
    for (let i = 0; i < 20 * 120; i++) {
      e = stepJetEngine(e, { throttle: 1, engineOn: true }, 1 / 120, 1.225, 0, 0, B747_CFG);
      if (!t95 && e.power >= 0.95) t95 = (i + 1) / 120;
      expect(e.afterburner).toBe(0);
    }
    expect(t95).toBeGreaterThan(6);
    expect(t95).toBeLessThan(8);
  });

  it('power pitches the nose up (thrust line below the CG), idle does not', () => {
    const vb = { x: 0, y: -70 * Math.sin(4 * DEG), z: -70 * Math.cos(4 * DEG) };
    const idle = computeAero(vb, ZERO, 1.225, 30, 1, NEUTRAL, 36000, B747_CFG);
    const toga = computeAero(vb, ZERO, 1.225, 30, 1, NEUTRAL, 800000, B747_CFG);
    // Body X torque + = nose up; ≈ 2.1 m × ΔT.
    expect(toga.tx - idle.tx).toBeCloseTo(2.1 * (800000 - 36000), -4);
  });
});

describe('747 spoilers', () => {
  const vb = { x: 0, y: -65 * Math.sin(2 * DEG), z: -65 * Math.cos(2 * DEG) };
  it('flight spoilers (speed brake) spoil a little lift and add drag; ground spoilers dump most of the lift', () => {
    const clean = computeAero(vb, ZERO, 1.225, 30, 1, NEUTRAL, 0, B747_CFG, Infinity, {});
    const sb = computeAero(vb, ZERO, 1.225, 30, 1, NEUTRAL, 0, B747_CFG, Infinity, { speedBrake: 1 });
    const gsp = computeAero(vb, ZERO, 1.225, 30, 1, NEUTRAL, 0, B747_CFG, Infinity, { speedBrake: 1, groundSpoilers: 1 });
    expect(clean.CL - sb.CL).toBeCloseTo(B.aero.spoilers!.flightLiftLoss, 6);
    expect(sb.CD - clean.CD).toBeCloseTo(B.aero.cdSpeedBrake, 6);
    expect(clean.CL - gsp.CL).toBeCloseTo(B.aero.spoilers!.groundLiftLoss, 6);
    expect(gsp.CD - clean.CD).toBeCloseTo(B.aero.cdSpeedBrake + B.aero.spoilers!.groundCd, 6);
    // On the ground at the level attitude, flaps 30: lift falls below a quarter of the weight at touchdown speed.
    const vg = { x: 0, y: 0, z: -125 * KT_TO_MS };
    const dumped = computeAero(vg, ZERO, 1.225, 30, 1, NEUTRAL, 0, B747_CFG, 5, { groundSpoilers: 1 });
    expect(dumped.lift / W).toBeLessThan(0.25);
  });

  it('aircraft without spoilers ignore the ground-spoiler input (the Cessna, F-16, A-10 are unchanged)', () => {
    const a = computeAero(vb, ZERO, 1.225, 10, 1, NEUTRAL, 1000, CONFIG);
    const b = computeAero(vb, ZERO, 1.225, 10, 1, NEUTRAL, 1000, CONFIG, Infinity, { groundSpoilers: 1 });
    expect(b).toEqual(a);
  });

  it('auto ground spoilers: mains on the ground above 30 kt with the thrust levers at idle (or the lever up)', () => {
    const s0 = createInitialState(RUNWAY_ENV, B747_CFG);
    const rolling = (kt: number): AircraftState => ({ ...s0, derived: { ...s0.derived, groundSpeed: kt * KT_TO_MS } });
    expect(groundSpoilerExtension(rolling(120), { throttle: 0, speedBrake: false }, B747_CFG)).toBe(1);
    expect(groundSpoilerExtension(rolling(120), { throttle: 1, speedBrake: false }, B747_CFG)).toBe(0);
    expect(groundSpoilerExtension(rolling(120), { throttle: 1, speedBrake: true }, B747_CFG)).toBe(1);
    expect(groundSpoilerExtension(rolling(10), { throttle: 0, speedBrake: false }, B747_CFG)).toBe(0);
    const air = { ...rolling(140), wheelContact: [false, false, false] as [boolean, boolean, boolean] };
    expect(groundSpoilerExtension(air, { throttle: 0, speedBrake: true }, B747_CFG)).toBe(0);
    expect(groundSpoilerExtension(rolling(120), { throttle: 0, speedBrake: true }, CONFIG)).toBe(0);
  });
});

describe('747 roll control: outboard ailerons locked out with the flaps up', () => {
  it('flaps up → aileronFlapsUpFraction, any flap → full; other aircraft always full', () => {
    const f = B.aero.aileronFlapsUpFraction!;
    expect(f).toBeGreaterThan(0.3);
    expect(f).toBeLessThan(0.6);
    expect(aileronEffectiveness(0, B747_CFG)).toBeCloseTo(f, 9);
    expect(aileronEffectiveness(5, B747_CFG)).toBe(1);
    expect(aileronEffectiveness(0, CONFIG)).toBe(1);
    const vb = { x: 0, y: 0, z: -150 };
    const up = computeAero(vb, ZERO, 1, 0, 0, { ...NEUTRAL, aileron: 1 }, 0, B747_CFG);
    const down = computeAero(vb, ZERO, 1, 5, 0, { ...NEUTRAL, aileron: 1 }, 0, B747_CFG);
    expect(up.tz / down.tz).toBeCloseTo(f, 2);
  });

  it('property: effectiveness stays in [flaps-up fraction, 1] for any input', () => {
    fc.assert(fc.property(fc.oneof(fc.double(), fc.constantFrom(NaN, Infinity, -Infinity)), (x) => {
      const e = aileronEffectiveness(x, B747_CFG);
      expect(e).toBeGreaterThanOrEqual(B.aero.aileronFlapsUpFraction! - 1e-12);
      expect(e).toBeLessThanOrEqual(1);
    }), { numRuns: 300 });
  });
});

describe('flap placards', () => {
  it('per notch for the 747 (a flap in transit counts as the next notch down), vfeKt for the others', () => {
    expect(flapPlacardKt(0, B747_CFG)).toBe(Infinity);
    expect(flapPlacardKt(5, B747_CFG)).toBe(260);
    expect(flapPlacardKt(10, B747_CFG)).toBe(240);
    expect(flapPlacardKt(14, B747_CFG)).toBe(230);
    expect(flapPlacardKt(20, B747_CFG)).toBe(230);
    expect(flapPlacardKt(25, B747_CFG)).toBe(205);
    expect(flapPlacardKt(30, B747_CFG)).toBe(180);
    expect(flapPlacardKt(20, CONFIG)).toBe(CONFIG.aircraft.flaps.vfeKt);
    expect(flapPlacardKt(0, CONFIG)).toBe(Infinity);
  });

  it('property: never rises as the flaps come down', () => {
    fc.assert(fc.property(fc.double({ min: 0, max: 30, noNaN: true }), fc.double({ min: 0, max: 30, noNaN: true }), (a, b) => {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      expect(flapPlacardKt(hi, B747_CFG)).toBeLessThanOrEqual(flapPlacardKt(lo, B747_CFG));
    }), { numRuns: 300 });
  });

  it('the FLAP OVERSPEED caution uses the placard of the flaps that are out', () => {
    const r = (flapsDeg: number, airspeedKt: number) => ({ state: 'airborne', flapsDeg, airspeedKt }) as unknown as Parameters<typeof annunciationActive>[1];
    expect(annunciationActive('flapOverspeed', r(10, 230), B747_CFG)).toBe(false);
    expect(annunciationActive('flapOverspeed', r(10, 245), B747_CFG)).toBe(true);
    expect(annunciationActive('flapOverspeed', r(30, 175), B747_CFG)).toBe(false);
    expect(annunciationActive('flapOverspeed', r(30, 185), B747_CFG)).toBe(true);
    expect(annunciationActive('flapOverspeed', r(0, 350), B747_CFG)).toBe(false);
  });
});

describe('747 on the ground', () => {
  it('spawns on runway 36 with the tail on the runway, level, struts holding 220 t — and stays put without bouncing', () => {
    let s = createInitialState(RUNWAY_ENV, B747_CFG);
    const tail = B.geometry.structuralPoints.find((p) => p.name === 'tailcone')!;
    expect(along(s) - tail.z).toBeGreaterThan(0);
    expect(Math.abs(s.derived.pitchDeg)).toBeLessThan(0.5);
    expect(s.wheelCompression[1]).toBeGreaterThan(0.1);
    expect(s.wheelCompression[1]).toBeLessThan(0.25);
    expect(s.wheelCompression[0]).toBeLessThan(0.2);
    let maxVs = 0;
    s = fly747(s, { ...defaultControls(), parkingBrake: true }, 10, { each: (x) => { maxVs = Math.max(maxVs, Math.abs(x.velocity.y)); } });
    expect(s.crash).toBeNull();
    expect(s.onGround).toBe(true);
    expect(maxVs).toBeLessThan(0.05);
    expect(s.derived.groundSpeed).toBeLessThan(0.05);
    expect(tailClearance(s)).toBeGreaterThan(3.5);
  });

  it('the tail bumper: a gentle scrape skids (no crash), a hard strike is a "Tail strike"; engine pods are "Engine pod strike"', () => {
    const pitch = 9;
    const q = quatFromEuler(0, pitch, 0);
    const tail = B.geometry.structuralPoints.find((p) => p.name === 'tailBumper')!;
    // Put the bumper 5 cm into the runway (wheels in the air behind it don't matter).
    const yTail = tail.y * Math.cos(pitch * DEG) - tail.z * Math.sin(pitch * DEG);
    const base = { position: { x: 0, y: -yTail - 0.05, z: 0 }, orientation: q, omegaWorld: ZERO, gearPos: 1, brake: 0, parkingBrake: false, rudder: 0, engineRunning: true };
    const gentle = groundContacts({ ...base, velocity: { x: 0, y: -0.5, z: -75 } }, FLAT_ENV, B747_CFG);
    expect(gentle.crashReason).toBeNull();
    expect(gentle.tailScrape).toBe(true);
    // A 747 tail strike scrapes up to scrapeSpeedMs (6 m/s: an over-rotation drags the tail and flies on).
    expect(B.landing.scrapeSpeedMs).toBeGreaterThanOrEqual(5);
    const mid = groundContacts({ ...base, velocity: { x: 0, y: -(B.landing.scrapeSpeedMs - 1), z: -75 } }, FLAT_ENV, B747_CFG);
    expect(mid.crashReason).toBeNull();
    const hard = groundContacts({ ...base, velocity: { x: 0, y: -(B.landing.scrapeSpeedMs + 1), z: -75 } }, FLAT_ENV, B747_CFG);
    expect(hard.crashReason).toBe('Tail strike');
    // 10° of bank on the ground puts the right outboard pod (21.2 m out, 2.1 m above the wheels) into the runway.
    const pod = B.geometry.structuralPoints.find((p) => p.name === 'rightOutboardEngine')!;
    const podY = pod.y * Math.cos(10 * DEG) - pod.x * Math.sin(10 * DEG);
    const bank = groundContacts({ position: { x: 0, y: -podY - 0.05, z: 0 }, velocity: { x: 0, y: -0.2, z: -60 }, orientation: quatFromEuler(0, 0, 10), omegaWorld: ZERO, gearPos: 1, brake: 0, parkingBrake: false, rudder: 0, engineRunning: true }, FLAT_ENV, B747_CFG);
    expect(bank.crashReason).toBe('Engine pod strike');
  });
});

describe('747 trim solutions', () => {
  const trimAt = (altFt: number, kt: number | { mach: number }, extra: Record<string, unknown> = {}) => {
    const altitudeM = altFt / 3.280839895;
    const iasKt = typeof kt === 'number' ? kt : (kt.mach * speedOfSound(altitudeM) * Math.sqrt(airDensity(altitudeM) / 1.225)) / KT_TO_MS;
    return solveTrim({ altitudeM, iasKt, gearDown: false, ...extra }, B747_CFG);
  };

  it('cruise FL350 M 0.85 (≈ 273 KIAS): trimmed, α ≈ 1°, well inside the thrust available', () => {
    const t = trimAt(35000, { mach: 0.85 });
    expect(t.converged).toBe(true);
    expect(deg(t.alpha)).toBeGreaterThan(0);
    expect(deg(t.alpha)).toBeLessThan(3);
    expect(t.throttle).toBeLessThan(0.9);
    expect(Math.abs(t.elevatorTrim)).toBeLessThan(0.4);
  });

  it('final approach at Vref30 + 5 (132 KIAS), 3° glide: α 4–7°, pitch 0–4°, small power, trim inside ±0.5', () => {
    const t = trimAt(1000, 132, { flapsNotch: 5, gearDown: true, flightPathDeg: -3 });
    expect(t.converged).toBe(true);
    expect(deg(t.alpha)).toBeGreaterThan(4);
    expect(deg(t.alpha)).toBeLessThan(7);
    expect(t.pitchDeg).toBeGreaterThan(0);
    expect(t.pitchDeg).toBeLessThan(4);
    expect(t.throttle).toBeGreaterThan(0.08);
    expect(t.throttle).toBeLessThan(0.4);
    expect(Math.abs(t.elevatorTrim)).toBeLessThan(0.5);
  });

  it('the approach spawn (3° from 9 km, 150 kt, flaps 30, gear down) holds itself hands-off for 20 s', () => {
    const { state, controls } = createTrimmedState({ altitudeM: 520, iasKt: 150, flapsNotch: 5, gearDown: true, flightPathDeg: -3 }, FLAT_ENV, B747_CFG);
    const s = fly747(state, controls as Controls, 20);
    expect(s.crash).toBeNull();
    expect(Math.abs(s.derived.pitchDeg - state.derived.pitchDeg)).toBeLessThan(1);
    expect(Math.abs(s.derived.ias - state.derived.ias) / KT_TO_MS).toBeLessThan(3);
    expect(Math.abs(s.velocity.y - state.velocity.y)).toBeLessThan(0.5);
    // Every step stays on the flat world's air side.
    expect(step(s, controls, 1 / 120, FLAT_ENV, B747_CFG).phase).toBe('airborne');
  });
});
