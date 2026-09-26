/**
 * Bell 206B-3 JetRanger III flight model (src/physics/rotor.ts): performance against the flight
 * manual and published data, the characteristic helicopter behaviours (torque reaction, translating
 * tendency, translational lift, blowback, autorotation, vortex ring state, dynamic roll-over), the
 * governed turboshaft and the stability assist. Bands sit around the REAL aircraft's numbers.
 */
import { describe, it, expect } from 'vitest';
import { B206_AIRCRAFT, FT_TO_M } from '../../src/config';
import type { AircraftState, Controls } from '../../src/types';
import { createInitialState, createApproachState, defaultControls, step, FLAT_ENV } from '../../src/physics';
import { availablePower, axialInflowRatio, inducedVelocity, solveRotorTrim } from '../../src/physics/rotor';
import { airDensity } from '../../src/physics/atmosphere';
import { wrap180 } from '../../src/math/vec3';
import { B206_CFG, DT, RC, SHP, fpm, gsKt, heliTrim, holdClimb, holdHeight, iasKt, nr, torquePct, withMass } from './b206-helpers';

const A = B206_AIRCRAFT;
const fly = (s0: AircraftState, pilot: (s: AircraftState) => Controls, seconds: number, each?: (s: AircraftState) => void, cfg = B206_CFG) => {
  let s = s0;
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    s = step(s, pilot(s), DT, FLAT_ENV, cfg);
    each?.(s);
  }
  return s;
};
const trimPower = (kt: number, altFt = 0, cfg = B206_CFG) => solveRotorTrim({ altitudeM: altFt * FT_TO_M, iasKt: kt }, cfg).power / SHP;

describe('JetRanger geometry', () => {
  it('matches the real aircraft', () => {
    const g = A.geometry;
    expect(RC.rotor.radius * 2).toBeCloseTo(10.16, 2);
    expect(RC.tailRotor.radius * 2).toBeCloseTo(1.65, 2);
    expect(g.length).toBeCloseTo(9.5, 2);
    // Top of the hub (≈ 0.16 m above its centre) above the unloaded skids.
    expect(RC.rotor.hub.y + 0.16 - RC.skids.points[0].y).toBeCloseTo(2.91, 1);
    expect(RC.skids.points[2].x - RC.skids.points[0].x).toBeCloseTo(1.92, 2);
    expect(g.horizontalTail.span).toBeCloseTo(1.97, 2);
    // The tail rotor clears the main rotor disc.
    expect(RC.tailRotor.position.z - RC.tailRotor.radius).toBeGreaterThan(RC.rotor.hub.z + RC.rotor.radius);
  });
});

describe('rotor aerodynamics', () => {
  it('induced velocity: momentum theory in climb and windmill brake, the vortex-ring hump in between, continuous', () => {
    expect(axialInflowRatio(0)).toBeCloseTo(1, 6);
    expect(axialInflowRatio(-2)).toBeCloseTo(1, 6);
    expect(axialInflowRatio(1)).toBeCloseTo(-0.5 + Math.sqrt(1.25), 6);
    expect(axialInflowRatio(-3)).toBeCloseTo(1.5 - Math.sqrt(1.25), 6);
    expect(axialInflowRatio(-1.2)).toBeGreaterThan(1.7);
    // The empirical curve joins momentum theory without a step at both ends.
    expect(axialInflowRatio(-1e-9)).toBeCloseTo(axialInflowRatio(1e-9), 6);
    expect(axialInflowRatio(-2 + 1e-9)).toBeCloseTo(axialInflowRatio(-2 - 1e-9), 3);
  });
  it('forward flight: induced velocity falls as vh²/V (translational lift), and the VRS vanishes above ~15 kt', () => {
    const T = 12750;
    const A = Math.PI * RC.rotor.radius ** 2;
    const hover = inducedVelocity(T, 1.225, A, 0, 0).vi;
    expect(hover).toBeCloseTo(Math.sqrt(T / (2 * 1.225 * A)), 3);
    const fast = inducedVelocity(T, 1.225, A, 0, 40).vi;
    expect(fast).toBeCloseTo((hover * hover) / 40, 1);
    expect(inducedVelocity(T, 1.225, A, -8, 0).vrs).toBeGreaterThan(0.9);
    expect(inducedVelocity(T, 1.225, A, -8, 12).vrs).toBeLessThan(0.1);
  });
});

describe('JetRanger performance (1,300 kg, ISA)', () => {
  it('hover out of ground effect at sea level: ~85 % torque (250–290 shp)', () => {
    const p = trimPower(0);
    expect(p).toBeGreaterThan(250);
    expect(p).toBeLessThan(290);
  });
  it('the power bucket: minimum power at 40–60 kt, well under half… of the hover power + margin (Vy 52 kt)', () => {
    const speeds = [0, 20, 30, 40, 50, 60, 70, 80];
    const powers = speeds.map((k) => trimPower(k));
    const iMin = powers.indexOf(Math.min(...powers));
    expect(speeds[iMin]).toBeGreaterThanOrEqual(40);
    expect(speeds[iMin]).toBeLessThanOrEqual(60);
    expect(powers[iMin] / powers[0]).toBeLessThan(0.62);
  });
  it('top speed at the 317 shp take-off limit: 110–125 kt (max cruise ~115 kt, Vne 130)', () => {
    let vmax = 0;
    for (let kt = 90; kt <= 130; kt += 2) if (trimPower(kt) <= 317) vmax = kt;
    expect(vmax).toBeGreaterThanOrEqual(110);
    expect(vmax).toBeLessThanOrEqual(125);
  });
  it('hover ceiling out of ground effect at max gross (1,451 kg): 3,500–7,000 ft on 317 shp', () => {
    const cfg = withMass(1451);
    let ceiling = 0;
    for (let ft = 0; ft <= 12000; ft += 500) {
      const avail = Math.min(317 * SHP, availablePower(airDensity(ft * FT_TO_M), RC)) / SHP;
      if (trimPower(0, ft, cfg) <= avail) ceiling = ft;
    }
    expect(ceiling).toBeGreaterThanOrEqual(3500);
    expect(ceiling).toBeLessThanOrEqual(7000);
  });
  it('hovers nose-up and left skid low with left pedal (counter-clockwise rotor, tail rotor pushing right)', () => {
    const t = solveRotorTrim({ altitudeM: 0, iasKt: 0 }, B206_CFG);
    expect(t.pitchDeg).toBeGreaterThan(2);
    expect(t.pitchDeg).toBeLessThan(6);
    expect(t.rollDeg).toBeLessThan(-1);
    expect(t.rollDeg).toBeGreaterThan(-4);
    expect(t.controls.pedal).toBeLessThan(-0.15);
    // In cruise the cambered fin carries the anti-torque load: pedals near neutral.
    const c = solveRotorTrim({ altitudeM: 0, iasKt: 100 }, B206_CFG);
    expect(Math.abs(c.controls.pedal)).toBeLessThan(0.15);
    expect(c.pitchDeg).toBeLessThan(0);
    // Forward cyclic grows with speed and leaves a margin at Vne.
    const v = solveRotorTrim({ altitudeM: 0, iasKt: 128 }, B206_CFG);
    expect(v.controls.cyclicLong).toBeLessThan(c.controls.cyclicLong);
    expect(v.controls.cyclicLong).toBeGreaterThan(-0.95);
  });
  it('translational lift: at 20–25 kt the power needed drops by > 20 % from the hover', () => {
    expect(trimPower(25) / trimPower(0)).toBeLessThan(0.8);
  });
  it('ground effect: hovering at skid height takes 5–20 % less torque than out of ground effect', () => {
    let s = createInitialState(FLAT_ENV, B206_CFG);
    s = fly(s, (x) => ({ ...defaultControls(), throttle: x.time < 4 ? x.time * 0.1 : holdHeight(x, 2.8, 0.4) }), 25);
    expect(s.phase).toBe('airborne');
    const ige = torquePct(s);
    const oge = (trimPower(0) * SHP) / RC.engine.transmissionLimitW * 100;
    expect(ige / oge).toBeGreaterThan(0.8);
    expect(ige / oge).toBeLessThan(0.95);
  });
});

describe('JetRanger handling', () => {
  it('lifts off with the collective alone and holds a steady hover with the stability assist (drift < 2 m, heading < 3°)', () => {
    let s = createInitialState(FLAT_ENV, B206_CFG);
    s = fly(s, (x) => ({ ...defaultControls(), throttle: x.time < 4 ? x.time * 0.11 : holdHeight(x, 3, 0.4) }), 15);
    const p0 = { ...s.position };
    const h0 = s.derived.headingDeg;
    s = fly(s, (x) => ({ ...defaultControls(), throttle: holdHeight(x, 3, 0.4) }), 30);
    expect(s.phase).toBe('airborne');
    expect(Math.hypot(s.position.x - p0.x, s.position.z - p0.z)).toBeLessThan(2);
    expect(Math.abs(wrap180(s.derived.headingDeg - h0))).toBeLessThan(3);
    expect(Math.abs(s.derived.altitudeAGL - 3)).toBeLessThan(0.5);
  });
  it('torque reaction: more collective with the pedals fixed swings the nose right', () => {
    const { state, controls } = heliTrim();
    const r = state.rotor!;
    const raw = { ...controls, stabilityAssist: false, elevator: r.cyclicLong, aileron: r.cyclicLat, rudder: r.pedal, elevatorTrim: 0 };
    const s = fly(state, () => ({ ...raw, throttle: controls.throttle + 0.1 }), 2);
    expect(wrap180(s.derived.headingDeg)).toBeGreaterThan(10);
  });
  it('the raw machine (assist off) is unstable in the hover but slowly: > 1.5 s before it departs 10°', () => {
    const { state, controls } = heliTrim();
    const r = state.rotor!;
    const raw = { ...controls, stabilityAssist: false, elevator: r.cyclicLong, aileron: r.cyclicLat, rudder: r.pedal, elevatorTrim: 0 };
    let t10 = Infinity;
    fly(state, () => raw, 8, (s) => {
      if (t10 === Infinity && (Math.abs(s.derived.pitchDeg - state.derived.pitchDeg) > 10 || Math.abs(s.derived.rollDeg - state.derived.rollDeg) > 10)) t10 = s.time;
    });
    expect(t10).toBeGreaterThan(1.5);
  });
  it('assist: hands-off cruise at 100 kt holds heading (< 2°) and height (< 50 ft) for 30 s', () => {
    const { state, controls } = heliTrim({ iasKt: 100 });
    const s = fly(state, () => controls, 30);
    expect(Math.abs(wrap180(s.derived.headingDeg))).toBeLessThan(2);
    expect(Math.abs(s.position.y - state.position.y) / FT_TO_M).toBeLessThan(50);
    expect(Math.abs(iasKt(s) - 100)).toBeLessThan(3);
  });
  it('assist: a hover pedal turn runs at ~40 °/s and stops within 15° of where the pedal is released', () => {
    const { state, controls } = heliTrim();
    let s = fly(state, (x) => ({ ...controls, rudder: 1, throttle: holdHeight(x, 300, controls.throttle) }), 3);
    const rate = (s.derived.r * 180) / Math.PI;
    expect(rate).toBeGreaterThan(30);
    expect(rate).toBeLessThan(50);
    const released = s.derived.headingDeg;
    s = fly(s, (x) => ({ ...controls, throttle: holdHeight(x, 300, controls.throttle) }), 5);
    expect(Math.abs(wrap180(s.derived.headingDeg - released))).toBeLessThan(15);
  });
  it('assist: a banked turn at 90 kt is coordinated (|β| < 3°) at a standard-ish rate', () => {
    const { state, controls } = heliTrim({ iasKt: 90 });
    let maxBeta = 0;
    const s = fly(state, () => ({ ...controls, aileron: 0.6 }), 15, (x) => (maxBeta = Math.max(maxBeta, Math.abs(x.derived.beta))));
    expect((maxBeta * 180) / Math.PI).toBeLessThan(3);
    expect(s.derived.rollDeg).toBeGreaterThan(15);
    expect((s.derived.r * 180) / Math.PI).toBeGreaterThan(3);
  });
  it('accelerates from the hover with forward cyclic and climbs through translational lift on a fixed collective', () => {
    const { state, controls } = heliTrim();
    let maxVs = -Infinity;
    const s = fly(state, () => ({ ...controls, elevator: -0.5 }), 12, (x) => {
      if (iasKt(x) > 18 && iasKt(x) < 35) maxVs = Math.max(maxVs, fpm(x));
    });
    expect(iasKt(s)).toBeGreaterThan(35);
    expect(maxVs).toBeGreaterThan(200);
  });
});

describe('JetRanger emergencies', () => {
  it('autorotation at 52 kt, collective down: 1,300–1,900 fpm with the rotor in the green (95–110 %)', () => {
    const { state, controls } = heliTrim({ altitudeM: 1500, iasKt: 52 });
    const pilot = (s: AircraftState): Controls => ({ ...controls, engineOn: false, throttle: Math.max(0, controls.throttle * (1 - s.time)), elevator: Math.max(-1, Math.min(1, 0.04 * (iasKt(s) - 52) - 0.25)) });
    const s = fly(state, pilot, 40);
    expect(s.crash).toBeNull();
    expect(Math.abs(iasKt(s) - 52)).toBeLessThan(5);
    expect(-fpm(s)).toBeGreaterThan(1300);
    expect(-fpm(s)).toBeLessThan(1900);
    expect(nr(s)).toBeGreaterThan(95);
    expect(nr(s)).toBeLessThan(110);
    expect(s.engine.running).toBe(false);
  });
  it('autorotation flare and touchdown from 55 kt: flare, level, cushion — lands under 360 fpm, no crash', () => {
    const { state, controls } = heliTrim({ altitudeM: 150, iasKt: 55 });
    const cl = (x: number) => Math.max(-1, Math.min(1, x));
    const pitchTo = (deg: number) => cl((deg - B206_CFG.aircraft.rotorcraft!.sas.pitchBiasDeg) / 20);
    let touch = 0;
    const pilot = (x: AircraftState): Controls => {
      const h = x.derived.altitudeAGL + RC.skids.points[0].y; // skid height
      const vs = x.derived.verticalSpeed;
      const base = { ...controls, engineOn: false };
      if (h > 18) return { ...base, throttle: 0, elevator: cl(0.04 * (iasKt(x) - 55) - 0.25) };
      // Flare: nose up to kill the descent and the speed (the rotor speeds up), easing off as it slows.
      if (h > 4) return { ...base, throttle: 0.05, elevator: pitchTo(vs < -2 ? 22 : 10) };
      // Level the skids and cushion with the collective.
      return { ...base, elevator: pitchTo(5), throttle: cl(0.2 + 0.2 * (-0.4 - 0.25 * h - vs)) };
    };
    const s = fly(state, pilot, 60, (x) => {
      if (!touch && x.touchdown) touch = x.touchdown.verticalSpeedFpm;
    });
    expect(s.crash, s.crash?.reason).toBeNull();
    expect(s.onGround).toBe(true);
    expect(-touch).toBeLessThan(360);
    expect(gsKt(s)).toBeLessThan(5);
  });
  it('engine shut down on the ground: the rotor coasts down; restarted, it runs up to 100 % without over-torquing', () => {
    let s = createInitialState(FLAT_ENV, B206_CFG);
    s = fly(s, () => ({ ...defaultControls(), engineOn: false }), 20);
    expect(nr(s)).toBeLessThan(75);
    expect(nr(s)).toBeGreaterThan(40);
    let maxTq = 0;
    s = fly(s, () => defaultControls(), 20, (x) => (maxTq = Math.max(maxTq, torquePct(x))));
    expect(s.engine.running).toBe(true);
    expect(Math.abs(nr(s) - 100)).toBeLessThan(1);
    expect(maxTq).toBeLessThan(105);
    expect(s.onGround).toBe(true);
  });
  it('over-pitching (full collective in the hover) droops the rotor below 95 %', () => {
    const { state, controls } = heliTrim({ altitudeM: 2500 });
    let minNr = 200;
    fly(state, () => ({ ...controls, throttle: 1 }), 6, (x) => (minNr = Math.min(minNr, nr(x))));
    expect(minNr).toBeLessThan(95);
  });
  it('vortex ring state: a slow vertical descent at > 1,000 fpm enters it; forward cyclic flies out of it', () => {
    const { state, controls } = heliTrim({ altitudeM: 1500 });
    // Lower the collective a little and let it sink straight down (the assist holds the spot).
    let s = fly(state, () => ({ ...controls, throttle: controls.throttle - 0.12 }), 8);
    expect(-fpm(s)).toBeGreaterThan(1000);
    expect(s.rotor!.vrs).toBeGreaterThan(0.5);
    // The classic trap: more collective only droops the rotor — the way out is forward cyclic.
    const h0 = s.position.y;
    s = fly(s, () => ({ ...controls, elevator: -0.6 }), 10);
    expect(s.rotor!.vrs).toBeLessThan(0.1);
    expect(h0 - s.position.y).toBeLessThan(500 * FT_TO_M);
  });
  it('dynamic roll-over: lifting off with the skid held by a sideways slide rolls it onto the rotor', () => {
    let s = createInitialState(FLAT_ENV, B206_CFG);
    s = fly(s, (x) => ({ ...defaultControls(), stabilityAssist: false, throttle: Math.min(0.4, x.time * 0.1), aileron: x.time > 2 ? 0.8 : 0 }), 8);
    expect(s.crash?.reason).toBe('Main rotor strike');
  });
  it('a hard landing (> 600 fpm) collapses the skids', () => {
    const { state, controls } = heliTrim({ altitudeM: 12 });
    const s = fly(state, (x) => ({ ...controls, throttle: holdClimb(x, -5, controls.throttle) }), 10);
    expect(s.crash?.reason).toBe('Hard landing — skids collapsed');
  });
  it('a gentle landing from the hover is rated and the helicopter stays put on its skids', () => {
    let s = createInitialState(FLAT_ENV, B206_CFG);
    s = fly(s, (x) => ({ ...defaultControls(), throttle: x.time < 4 ? x.time * 0.11 : holdHeight(x, 4, 0.4) }), 12);
    expect(s.phase).toBe('airborne');
    s = fly(s, (x) => ({ ...defaultControls(), throttle: x.onGround ? Math.max(0, x.rotor!.collective - DT * 0.25) : holdClimb(x, -0.5, 0.38) }), 25);
    expect(s.crash).toBeNull();
    expect(s.touchdown?.rating === 'butter' || s.touchdown?.rating === 'smooth').toBe(true);
    const p = { ...s.position };
    s = fly(s, () => defaultControls(), 10);
    expect(Math.hypot(s.position.x - p.x, s.position.z - p.z)).toBeLessThan(0.05);
  });
});

describe('JetRanger states', () => {
  it('Shift+R: the approach state is a trimmed 60 kt descent toward runway 36 with the rotor at 100 %', () => {
    const s = createApproachState(FLAT_ENV, B206_CFG);
    expect(s.phase).toBe('airborne');
    expect(Math.abs(iasKt(s) - 60)).toBeLessThan(1);
    expect(fpm(s)).toBeLessThan(-300);
    expect(nr(s)).toBeCloseTo(100, 0);
    const s2 = fly(s, () => ({ ...defaultControls(), throttle: s.rotor!.collective, elevatorTrim: 0 }), 1);
    expect(s2.crash).toBeNull();
  });
  it('step() stays cheap: < 25 µs per step', () => {
    const { state, controls } = heliTrim({ iasKt: 80 });
    let s = state;
    const t0 = performance.now();
    for (let i = 0; i < 4000; i++) s = step(s, controls, DT, FLAT_ENV, B206_CFG);
    const us = ((performance.now() - t0) / 4000) * 1000;
    expect(us).toBeLessThan(25);
  });
});

describe('JetRanger spawned in a low hover', () => {
  it('a speed-0 spawn at 10 ft is trimmed in ground effect and holds its height hands-off', () => {
    const { state, controls } = heliTrim({ altitudeM: 10 * FT_TO_M + 1.25 });
    let s = state;
    for (let i = 0; i < Math.round(20 / DT); i++) s = step(s, controls, DT, FLAT_ENV, B206_CFG);
    expect(s.crash).toBeNull();
    expect(Math.abs(s.position.y - state.position.y)).toBeLessThan(1.5);
  });
});
