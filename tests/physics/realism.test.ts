/**
 * Calibration against the Cessna 172RG POH: the numbers a pilot would notice.
 * (The measured values are recorded in the comment block at the top of
 * src/physics/aircraft.ts.)
 */
import { describe, it, expect } from 'vitest';
import { CONFIG, MS_TO_KT, RAD_TO_DEG } from '../../src/config';
import type { AircraftState, Controls } from '../../src/types';
import { createInitialState, defaultControls, powerTarget, airDensity, step, createTrimmedState } from '../../src/physics';
import { toRunwayCoords } from '../../src/world/runway';
import { quatFromEuler } from '../../src/physics/frames';
import { clamp } from '../../src/math/vec3';
import { fly, trimmed, iasKt, tasKt, altitudeHold, bankHold, allFinite, rng, DT, RUNWAY_ENV } from './helpers';

const LIM = CONFIG.aircraft.limits;

/** Elevator loop that holds an indicated airspeed (pitch for speed). */
const speedHold = (s: AircraftState, kt: number, base = 0) =>
  clamp(base + 0.02 * (iasKt(s) - kt) - 0.03 * s.derived.q * RAD_TO_DEG, -1, 1);

describe('realism (C172RG POH calibration)', () => {
  it('full-throttle ground roll to Vr (55 KIAS) is 200–400 m, then it rotates and lifts off', () => {
    const s0 = createInitialState(RUNWAY_ENV);
    const start = toRunwayCoords(s0.position.x, s0.position.z).along;
    let s = fly(s0, { ...defaultControls(), throttle: 1 }, 60, { env: RUNWAY_ENV, until: (x) => iasKt(x) >= LIM.vrKt });
    const roll = toRunwayCoords(s.position.x, s.position.z).along - start;
    expect(roll).toBeGreaterThan(200);
    expect(roll).toBeLessThan(400);
    let liftoffKt = 0;
    s = fly(s, (x) => ({ ...defaultControls(), throttle: 1, elevator: x.derived.pitchDeg < 9 ? 0.6 : 0.1 }), 10, {
      env: RUNWAY_ENV,
      each: (x) => { if (!liftoffKt && x.phase === 'airborne') liftoffKt = iasKt(x); },
      until: (x) => x.airborneTime > 2,
    });
    expect(s.phase).toBe('airborne');
    expect(s.crash).toBeNull();
    expect(liftoffKt).toBeGreaterThan(50);
    expect(liftoffKt).toBeLessThan(65);
  });

  it(`best-rate climb (Vy ${LIM.vyKt} KIAS, full power, sea level): 550–950 fpm`, () => {
    const { state, controls } = trimmed({ altitudeM: 150, iasKt: LIM.vyKt, gearDown: false });
    const pilot = (s: AircraftState): Controls => ({ ...controls, throttle: 1, elevator: speedHold(s, LIM.vyKt), aileron: bankHold(s, 0), rudder: 0.06 });
    let s = fly(state, pilot, 15);
    const y0 = s.position.y;
    s = fly(s, pilot, 30);
    const fpm = ((s.position.y - y0) / 30) * 196.85;
    expect(Math.abs(iasKt(s) - LIM.vyKt)).toBeLessThan(3);
    expect(fpm).toBeGreaterThan(550);
    expect(fpm).toBeLessThan(950);
  });

  it('75 % power cruise at 8000 ft, gear up: 120–140 KTAS', () => {
    const alt = 2438;
    const rho = airDensity(alt);
    const sigma = rho / CONFIG.sim.seaLevelDensity;
    const idle = CONFIG.aircraft.engine.idlePower;
    const throttle = clamp((0.75 / sigma - idle) / (1 - idle), 0, 1);
    expect(powerTarget(throttle, rho)).toBeCloseTo(0.75, 2);
    const { state, controls } = trimmed({ altitudeM: alt, iasKt: 110, gearDown: false });
    const pilot = (s: AircraftState): Controls => ({ ...controls, throttle, elevator: altitudeHold(s, alt), aileron: bankHold(s, 0) });
    const s = fly(state, pilot, 240);
    expect(Math.abs(s.position.y - alt)).toBeLessThan(15);
    expect(tasKt(s)).toBeGreaterThan(120);
    expect(tasKt(s)).toBeLessThan(140);
  });

  it('top speed in level flight at full power is below 160 kt', () => {
    const { state, controls } = trimmed({ altitudeM: 300, iasKt: 130, gearDown: false });
    const pilot = (s: AircraftState): Controls => ({ ...controls, throttle: 1, elevator: altitudeHold(s, 300), aileron: bankHold(s, 0) });
    const s = fly(state, pilot, 240);
    expect(tasKt(s)).toBeGreaterThan(130);
    expect(tasKt(s)).toBeLessThan(160);
  });

  it('idle glide at 70 KIAS (gear up, flaps up) is ≈ 8–10 : 1', () => {
    const { state, controls } = trimmed({ altitudeM: 1500, iasKt: 70, gearDown: false, flightPathDeg: -6 });
    const pilot = (s: AircraftState): Controls => ({ ...controls, throttle: 0, elevator: speedHold(s, 70), aileron: bankHold(s, 0) });
    let s = fly(state, pilot, 15);
    const p0 = s.position;
    s = fly(s, pilot, 60);
    const ratio = Math.hypot(s.position.x - p0.x, s.position.z - p0.z) / (p0.y - s.position.y);
    expect(Math.abs(iasKt(s) - 70)).toBeLessThan(2);
    expect(ratio).toBeGreaterThan(8);
    expect(ratio).toBeLessThan(10);
  });

  it('hands-off trimmed cruise is stable for 60 s (no divergence, wings stay level, altitude held)', () => {
    const { state, controls } = trimmed({ altitudeM: 1500, iasKt: 110, gearDown: false });
    // A small upset to see that it damps: 4° of bank and a 1 m/s updraft.
    const s0 = { ...state, orientation: quatFromEuler(0, state.derived.pitchDeg, 4), velocity: { ...state.velocity, y: 1 } };
    let maxRoll = 0;
    let maxDy = 0;
    const s = fly(s0, controls, 60, {
      each: (x) => {
        maxRoll = Math.max(maxRoll, Math.abs(x.derived.rollDeg));
        maxDy = Math.max(maxDy, Math.abs(x.position.y - 1500));
      },
    });
    expect(s.phase).toBe('airborne');
    expect(maxRoll).toBeLessThan(10);
    expect(maxDy).toBeLessThan(150);
    expect(Math.abs(iasKt(s) - 110)).toBeLessThan(10);
  });

  it('landing rollout with full brakes from touchdown speed stops in < 500 m', () => {
    const { state } = trimmed({ altitudeM: 30, iasKt: 55, flapsNotch: 3 });
    // Put it on the runway at touchdown speed, all wheels down, rolling north.
    const g = createInitialState(RUNWAY_ENV);
    const v = state.derived.tas;
    const rolling: AircraftState = { ...g, velocity: { x: 0, y: 0, z: -v }, flapsDeg: 30, phase: 'landed' };
    const start = toRunwayCoords(rolling.position.x, rolling.position.z).along;
    const s = fly(rolling, { ...defaultControls(), flapsNotch: 3, brake: 1 }, 60, {
      env: RUNWAY_ENV,
      until: (x) => x.derived.groundSpeed < 0.3,
    });
    const dist = toRunwayCoords(s.position.x, s.position.z).along - start;
    expect(s.derived.groundSpeed).toBeLessThan(0.3);
    expect(dist).toBeLessThan(500);
    expect(dist).toBeGreaterThan(60);
    expect(s.phase).toBe('landed');
  });

  it('the parking brake holds against full power', () => {
    const s0 = createInitialState();
    const s = fly(s0, { ...defaultControls(), throttle: 1, parkingBrake: true }, 8);
    expect(Math.hypot(s.position.x - s0.position.x, s.position.z - s0.position.z)).toBeLessThan(1);
    expect(s.phase).toBe('ground');
  });

  it('no NaN after 10 simulated minutes of random stick inputs', () => {
    const rand = rng(1234);
    let { state: s, controls } = createTrimmedState({ altitudeM: 3000, iasKt: 100, gearDown: false });
    let c: Controls = controls;
    let flown = 0;
    let crashes = 0;
    const steps = Math.round(600 / DT);
    for (let i = 0; i < steps; i++) {
      if (i % 60 === 0) {
        c = {
          ...c,
          elevator: rand() * 2 - 1,
          aileron: rand() * 2 - 1,
          rudder: rand() * 2 - 1,
          throttle: rand(),
          flapsNotch: Math.floor(rand() * 4),
          gearDown: rand() > 0.5,
          elevatorTrim: rand() * 2 - 1,
          engineOn: rand() > 0.05,
        };
      }
      s = step(s, c, DT);
      flown += DT;
      if (i % 600 === 0 && !allFinite(s)) break;
      if (s.phase === 'crashed' || s.position.y < 600) {
        if (s.phase === 'crashed') crashes++;
        expect(allFinite(s)).toBe(true);
        ({ state: s } = createTrimmedState({ altitudeM: 3000, iasKt: 100, gearDown: false }));
      }
    }
    expect(allFinite(s)).toBe(true);
    expect(flown).toBeGreaterThan(599);
    expect(crashes).toBeGreaterThanOrEqual(0);
  });

  it('step is fast (well under 0.1 ms per call)', () => {
    const { state, controls } = trimmed({ altitudeM: 1500, iasKt: 100 });
    let s = state;
    for (let i = 0; i < 2000; i++) s = step(s, controls, DT); // warm up
    const n = 20000;
    const t0 = performance.now();
    // A gentle wobble: bank ±20° (bank-held, so the aircraft stays in normal flight while we time it).
    for (let i = 0; i < n; i++) s = step(s, { ...controls, aileron: bankHold(s, 20 * Math.sin(i * 0.001)) }, DT);
    const perStepMs = (performance.now() - t0) / n;
    // Ground contact is the expensive case: rolling on the runway.
    let g = createInitialState();
    const t1 = performance.now();
    for (let i = 0; i < n; i++) g = step(g, { ...defaultControls(), throttle: 0.3 }, DT);
    const perGroundStepMs = (performance.now() - t1) / n;
    expect(perStepMs).toBeLessThan(0.1);
    expect(perGroundStepMs).toBeLessThan(0.1);
    expect(s.derived.tas * MS_TO_KT).toBeGreaterThan(50);
  });
});
