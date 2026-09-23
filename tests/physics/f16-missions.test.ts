/**
 * Functional F-16 missions flown through step() with scripted pilots on the runway world:
 *   (a) afterburner take-off → climb → level at 10,000 ft and accelerate past 500 KIAS;
 *   (b) military-power take-off roll;
 *   (c) a 9 g turn;
 *   (d) approach and landing on runway 36, stopping on the runway with brakes + speed brake.
 * The Cessna's own missions (tests/functional, tests/physics) run unchanged.
 */
import { describe, it, expect, vi } from 'vitest';
import { FT_TO_M, MS_TO_KT, M_TO_FT, RAD_TO_DEG } from '../../src/config';
import type { AircraftState, Controls } from '../../src/types';
import { approachControls, createApproachState, createInitialState, defaultControls } from '../../src/physics';
import { runwayFrame, toRunwayCoords } from '../../src/world/runway';
import { F16_CFG, RUNWAY_ENV, fly, iasKt, trimmed, headingError } from './helpers';

vi.setConfig({ testTimeout: 60000 });

const env = RUNWAY_ENV;
const rw = runwayFrame(F16_CFG);
const along = (s: AircraftState) => toRunwayCoords(s.position.x, s.position.z, rw).along;
const across = (s: AircraftState) => toRunwayCoords(s.position.x, s.position.z, rw).across;
const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));
const flyF = (s: AircraftState, pilot: Controls | ((x: AircraftState) => Controls), seconds: number, opts: { each?: (x: AircraftState) => void; until?: (x: AircraftState) => boolean } = {}) =>
  fly(s, pilot, seconds, { cfg: F16_CFG, env, ...opts });

interface TakeoffResult {
  state: AircraftState;
  rotateKt: number;
  liftoffKt: number;
  /** Brake release → last wheel off the runway, m. */
  groundRollM: number;
  maxPitchOnGround: number;
}

/**
 * Line up, run up to ~60 % on the brakes (they will not hold military), release, set `throttle`
 * (1 = full afterburner, 0.9 = military), rotate at 155 KIAS at ~3 °/s toward 12° pitch.
 */
function takeoff(throttle: number): TakeoffResult {
  const base: Controls = { ...defaultControls(), gearDown: true };
  let s = createInitialState(env, F16_CFG);
  s = flyF(s, { ...base, throttle: 0.5, brake: 1 }, 5);
  expect(s.derived.groundSpeed, 'brakes hold the run-up').toBeLessThan(0.5);
  const a0 = along(s);
  let rotateKt = 0;
  let liftoff: AircraftState | null = null;
  let maxPitchOnGround = 0;
  s = flyF(s, (x) => {
    let elevator = 0;
    if (iasKt(x) >= 155 || rotateKt > 0) {
      if (!rotateKt) rotateKt = iasKt(x);
      const qTarget = Math.min(3, 0.8 * (12 - x.derived.pitchDeg));
      elevator = clamp1((x.onGround ? 0.45 : 0.1) + 0.25 * (qTarget - x.derived.q * RAD_TO_DEG));
    }
    return { ...base, throttle, elevator, aileron: clamp1(-0.05 * x.derived.rollDeg), rudder: clamp1(0.05 * headingError(x, 0) * -1) };
  }, 60, {
    each: (x) => {
      if (x.onGround) maxPitchOnGround = Math.max(maxPitchOnGround, x.derived.pitchDeg);
      if (!liftoff && !x.onGround && x.airborneTime > 0 && x.airborneTime < 0.02) liftoff = x;
    },
    until: (x) => !!x.crash || x.airborneTime > 3,
  });
  expect(s.crash, s.crash?.reason).toBeNull();
  expect(liftoff).not.toBeNull();
  const lo = liftoff as unknown as AircraftState;
  if (process.env.F16_DEBUG) console.log(`takeoff thr=${throttle} rotate=${rotateKt.toFixed(0)} liftoff=${iasKt(lo).toFixed(0)} roll=${(along(lo) - a0).toFixed(0)} pitchMax=${maxPitchOnGround.toFixed(1)} rotateAt=${lo.time.toFixed(1)}`);
  return { state: s, rotateKt, liftoffKt: iasKt(lo), groundRollM: along(lo) - a0, maxPitchOnGround };
}

describe('F-16 take-off', () => {
  it('(a) afterburner take-off: rotate ~155 kt, airborne in 450–700 m; climb, level at 10,000 ft and pass 500 KIAS', () => {
    const t = takeoff(1);
    expect(t.rotateKt).toBeGreaterThan(148);
    expect(t.rotateKt).toBeLessThan(160);
    expect(t.groundRollM).toBeGreaterThan(450);
    expect(t.groundRollM).toBeLessThan(700);
    expect(t.liftoffKt).toBeGreaterThan(155);
    expect(t.liftoffKt).toBeLessThan(195);
    expect(t.maxPitchOnGround, 'no tail strike').toBeLessThan(13.5);
    // Gear up, climb at 15° pitch in afterburner, level off at 10,000 ft (FBW path hold + altitude trim).
    const target = 10000 * FT_TO_M;
    const up: Controls = { ...defaultControls(), gearDown: false, throttle: 1 };
    let maxIasLevel = 0;
    let maxDevFt = 0;
    const s = flyF(t.state, (x) => {
      const err = target - x.position.y;
      const climbing = err > 600;
      const stick = climbing
        ? clamp1(0.05 * (15 - x.derived.pitchDeg) - 0.02 * x.derived.q * RAD_TO_DEG)
        : clamp1(0.004 * err - 0.012 * x.velocity.y);
      return { ...up, elevator: stick, aileron: clamp1(-0.05 * x.derived.rollDeg) };
    }, 120, {
      each: (x) => {
        if (Math.abs(x.position.y - target) < 150 && x.time > t.state.time + 20) {
          maxIasLevel = Math.max(maxIasLevel, iasKt(x));
          maxDevFt = Math.max(maxDevFt, Math.abs(x.position.y - target) * M_TO_FT);
        }
      },
      until: (x) => !!x.crash || (maxIasLevel > 510 && x.time > t.state.time + 60),
    });
    if (process.env.F16_DEBUG) console.log(`climb/level: max ${maxIasLevel.toFixed(0)} KIAS at 10,000 ft, ${(s.time - t.state.time).toFixed(0)} s after lift-off`);
    expect(s.crash, s.crash?.reason).toBeNull();
    expect(s.gearPos).toBe(0);
    expect(maxIasLevel, 'level at 10,000 ft in afterburner').toBeGreaterThan(500);
    expect(Math.abs(s.position.y - target) * M_TO_FT).toBeLessThan(300);
  });

  it('(b) military-power take-off: airborne in ~700–1,100 m', () => {
    const t = takeoff(0.9);
    expect(t.groundRollM).toBeGreaterThan(700);
    expect(t.groundRollM).toBeLessThan(1100);
    expect(t.state.engine.afterburner ?? 0).toBe(0);
  });
});

describe('F-16 manoeuvring', () => {
  it('(c) a 9 g turn: ≥ 8.5 g held for 2+ s, never 10 g, no structural failure, heading swings > 90°', () => {
    const { state, controls } = trimmed({ altitudeM: 10000 * FT_TO_M, iasKt: 480, gearDown: false }, F16_CFG);
    const c: Controls = { ...controls, gearDown: false, throttle: 1 };
    // Roll to ~80° bank, then full aft stick holding the bank.
    let s = flyF(state, (x) => ({ ...c, aileron: clamp1(0.02 * (80 - x.derived.rollDeg)) }), 1.5);
    const h0 = s.derived.headingDeg;
    let above85 = 0;
    let maxN = 0;
    let maxA = 0;
    s = flyF(s, (x) => ({ ...c, elevator: 1, aileron: clamp1(0.02 * (82 - x.derived.rollDeg)) }), 8, {
      each: (x) => {
        if (x.derived.loadFactor >= 8.5) above85 += 1 / 120;
        maxN = Math.max(maxN, x.derived.loadFactor);
        maxA = Math.max(maxA, x.derived.alpha * RAD_TO_DEG);
      },
    });
    if (process.env.F16_DEBUG) console.log(`9 g turn: ${above85.toFixed(1)} s ≥ 8.5 g, max ${maxN.toFixed(2)} g, α max ${maxA.toFixed(1)}°, heading change ${Math.abs(headingError(s, h0)).toFixed(0)}° in 8 s, end ${iasKt(s).toFixed(0)} KIAS`);
    expect(s.crash, s.crash?.reason).toBeNull();
    expect(above85).toBeGreaterThan(2);
    expect(maxN).toBeLessThan(10);
    expect(maxA).toBeLessThan(26.5);
    expect(Math.abs(headingError(s, h0))).toBeGreaterThan(90);
  });
});

describe('F-16 approach and landing', () => {
  it('(d) from 6 km final: ~150 KIAS at 11–13° α, touchdown ~140 kt on the runway, stop with brakes + speed brake in 800–1,200 m', () => {
    const base = approachControls(F16_CFG);
    const aim = F16_CFG.aircraft.spawn.approach.aimPointM;
    let s = createApproachState(env, F16_CFG);
    let tdAt: AircraftState | null = null;
    let flaring = false;
    let alphaSum = 0;
    let alphaN = 0;
    const pilot = (x: AircraftState): Controls => {
      if (x.onGround || tdAt) {
        // Rollout: idle, speed brake, lower the nose, brakes once the nosewheel is down, track the centreline.
        return {
          ...base, throttle: 0, speedBrake: true, elevator: x.derived.pitchDeg > 1 ? -0.3 : 0,
          brake: x.wheelContact[0] ? 1 : 0, rudder: clamp1(-0.3 * across(x) - 0.2 * headingError(x, 0)),
        };
      }
      const h = x.derived.altitudeAGL + F16_CFG.aircraft.geometry.noseWheel.y; // wheel height
      if (h < 9) flaring = true;
      const V = Math.hypot(x.velocity.x, x.velocity.y, x.velocity.z);
      const gamma = Math.asin(x.velocity.y / V) * RAD_TO_DEG;
      const gDes = -Math.atan2(Math.max(h, 0), Math.max(aim - along(x), 60)) * RAD_TO_DEG;
      const lat = clamp1(-0.02 * across(x) - 0.03 * x.derived.rollDeg);
      if (flaring) {
        const vsTarget = -1.7 - 0.1 * h;
        return { ...base, throttle: 0, elevator: clamp1(0.25 * (vsTarget - x.velocity.y)), aileron: lat };
      }
      return {
        ...base,
        throttle: Math.max(0, Math.min(0.9, base.throttle + 0.03 * (150 - iasKt(x)))),
        elevator: clamp1(0.4 * (gDes - gamma) + 0.02 * (gDes + 3)),
        aileron: lat,
      };
    };
    s = flyF(s, pilot, 200, {
      each: (x) => {
        if (!tdAt && x.touchdown) tdAt = x;
        const h = x.derived.altitudeAGL;
        if (!x.onGround && h > 30 && h < 250) { alphaSum += x.derived.alpha * RAD_TO_DEG; alphaN++; }
      },
      until: (x) => !!x.crash || (!!tdAt && x.derived.groundSpeed < 0.5),
    });
    expect(s.crash, s.crash?.reason).toBeNull();
    expect(tdAt).not.toBeNull();
    const td = (tdAt as unknown as AircraftState).touchdown!;
    const alphaApp = alphaSum / alphaN;
    expect(alphaApp, 'approach α').toBeGreaterThan(11);
    expect(alphaApp).toBeLessThan(13.5);
    expect(td.onRunway).toBe(true);
    expect(td.airspeedKt).toBeGreaterThan(128);
    expect(td.airspeedKt).toBeLessThan(150);
    expect(['butter', 'smooth', 'firm']).toContain(td.rating);
    expect(td.pitchDeg, 'no tail strike').toBeLessThan(13);
    const rollout = along(s) - along(tdAt as unknown as AircraftState);
    if (process.env.F16_DEBUG) console.log(`landing: approach α ${alphaApp.toFixed(1)}°, touchdown ${td.airspeedKt.toFixed(0)} KIAS ${td.verticalSpeedFpm.toFixed(0)} fpm pitch ${td.pitchDeg.toFixed(1)}° ${td.rating} at ${along(tdAt as unknown as AircraftState).toFixed(0)} m, rollout ${rollout.toFixed(0)} m`);
    expect(rollout).toBeGreaterThan(800);
    expect(rollout).toBeLessThan(1200);
    expect(along(s), 'stops on the runway').toBeLessThan(1600);
    expect(Math.abs(across(s))).toBeLessThan(10);
    expect(s.derived.groundSpeed * MS_TO_KT).toBeLessThan(1);
  });
});
