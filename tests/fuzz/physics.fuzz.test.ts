/**
 * Property tests for the flight model (src/physics): random control sequences
 * flown for 60–300 simulated seconds from the runway, from the approach reset
 * and from random airborne states (any attitude, rates, speeds, gear, flaps),
 * over flat and hilly worlds.
 *
 * After EVERY step: no NaN/Infinity anywhere, unit quaternion, gearPos and
 * flapsDeg in range, consistent phase/crash/stall flags, speed < 250 kt,
 * 'crashed' is terminal (frozen, same crash record). The input state and
 * controls are deep-frozen, so any mutation inside step() throws.
 * Separately: determinism, dt edge cases and hostile control values.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { AircraftState, Controls, Environment } from '../../src/types';
import { createApproachState, createInitialState, createTrimmedState, FLAT_ENV, stallAlphaRad, step } from '../../src/physics';
import { BODY_FORWARD, bodyToWorld, quatFromEuler } from '../../src/physics/frames';
import { CONFIG, KT_TO_MS } from '../../src/config';
import { fcParams } from '../support/fc';
import { attitude, controlSegment, controls, hostileNum, num, vec3, type ControlSegment } from '../support/arbitraries';
import { deepFreeze, stateViolation } from '../support/invariants';
import { HILLY_ENV, RUNWAY_FLAT_ENV } from '../support/envs';
import { ScriptedPilot, iasKt, type PilotSettings } from '../support/pilot';

const DT = CONFIG.sim.fixedDt;
const HYST = (CONFIG.aircraft.stall.recoveryHysteresisDeg * Math.PI) / 180;
/** Phase changes the state machine may make in one step. */
const ALLOWED: Record<string, readonly string[]> = {
  ground: ['ground', 'airborne', 'crashed'],
  airborne: ['airborne', 'ground', 'landed', 'crashed'],
  landed: ['landed', 'airborne', 'crashed'],
  crashed: ['crashed'],
};

/** State-machine and contact invariants that relate a step's input and output. */
function transitionViolation(prev: AircraftState, next: AircraftState, env: Environment): string | null {
  if (!ALLOWED[prev.phase].includes(next.phase)) return `illegal phase change ${prev.phase} → ${next.phase}`;
  if (next.phase === 'crashed') return null;
  if (next.onGround !== next.wheelContact.some(Boolean)) return `onGround ${next.onGround} but wheelContact ${next.wheelContact}`;
  if ((next.phase === 'airborne') === next.onGround) return `phase ${next.phase} with onGround ${next.onGround}`;
  if (next.phase === 'airborne') {
    const aS = stallAlphaRad(next.flapsDeg);
    if (next.derived.alpha > aS + 1e-9 && !next.stalled) return `alpha ${next.derived.alpha} above stall ${aS} but not stalled`;
    if (next.stalled && next.derived.alpha < aS - HYST - 1e-9) return `stalled at alpha ${next.derived.alpha} (< stall − hysteresis)`;
  }
  if (next.phase === 'landed' && !next.touchdown) return 'landed without a touchdown record';
  if (prev.touchdown && next.touchdown !== prev.touchdown && JSON.stringify(next.touchdown) !== JSON.stringify(prev.touchdown) && prev.phase !== 'airborne') {
    return 'touchdown record replaced without a new landing';
  }
  const g = env.groundHeight(next.position.x, next.position.z);
  if (!(next.position.y > g)) return `CG ${(g - next.position.y).toFixed(3)} m below the terrain and not crashed`;
  const w = env.waterLevel(next.position.x, next.position.z);
  if (w !== null && w > g && !(next.position.y > w)) return 'CG below the water surface and not crashed';
  return null;
}
const ENVS: Record<string, Environment> = { flat: FLAT_ENV, runwayFlat: RUNWAY_FLAT_ENV, hilly: HILLY_ENV };
const TIMEOUT = 120_000;

interface AirborneSpec {
  x: number;
  z: number;
  agl: number;
  att: { heading: number; pitch: number; roll: number };
  /** Direction of flight relative to the nose: deviation angles, deg. */
  velPitch: number;
  velYaw: number;
  speedKt: number;
  omega: { x: number; y: number; z: number };
  flapsDeg: number;
  gearUp: boolean;
}

const airborneArb: fc.Arbitrary<AirborneSpec> = fc.record({
  x: num(-8000, 8000),
  z: num(-8000, 8000),
  agl: num(150, 3000),
  att: attitude(80),
  velPitch: num(-30, 30),
  velYaw: num(-20, 20),
  speedKt: num(35, 150),
  omega: vec3(1.2),
  flapsDeg: num(0, 30),
  gearUp: fc.boolean(),
});

function airborneState(spec: AirborneSpec, env: Environment): AircraftState {
  const ground = env.groundHeight(spec.x, spec.z);
  const water = env.waterLevel(spec.x, spec.z);
  const surface = water !== null && water > ground ? water : ground;
  const { state } = createTrimmedState({ altitudeM: surface + spec.agl, iasKt: 90, x: spec.x, z: spec.z, headingDeg: spec.att.heading }, env);
  const orientation = quatFromEuler(spec.att.heading, spec.att.pitch, spec.att.roll);
  const vDir = quatFromEuler(spec.att.heading + spec.velYaw, spec.att.pitch + spec.velPitch, 0);
  const v = spec.speedKt * KT_TO_MS;
  const f = bodyToWorld(vDir, BODY_FORWARD);
  return {
    ...state,
    orientation,
    velocity: { x: f.x * v, y: f.y * v, z: f.z * v },
    angularVelocity: spec.omega,
    flapsDeg: spec.flapsDeg,
    gearPos: spec.gearUp ? 0 : 1,
  };
}

type Start = { kind: 'runway' } | { kind: 'approach' } | { kind: 'airborne'; spec: AirborneSpec };
const startArb: fc.Arbitrary<Start> = fc.oneof(
  { weight: 1, arbitrary: fc.constant({ kind: 'runway' as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'approach' as const }) },
  { weight: 2, arbitrary: airborneArb.map((spec) => ({ kind: 'airborne' as const, spec })) },
);

function initial(start: Start, env: Environment): AircraftState {
  if (start.kind === 'runway') return createInitialState(env);
  if (start.kind === 'approach') return createApproachState(env);
  return airborneState(start.spec, env);
}

/** Fly the segments (cycled) for `seconds` and check every invariant after every step. */
function flyChecked(s0: AircraftState, segs: readonly ControlSegment[], seconds: number, env: Environment): AircraftState {
  let s = deepFreeze(structuredClone(s0));
  const frozenSegs = segs.map((g) => ({ seconds: g.seconds, controls: deepFreeze({ ...g.controls }) }));
  const bad0 = stateViolation(s);
  if (bad0) throw new Error(`initial state invalid: ${bad0}`);
  let t = 0;
  let i = 0;
  let segLeft = frozenSegs[0].seconds;
  while (t < seconds) {
    const c = frozenSegs[i % frozenSegs.length].controls;
    const prev = s;
    const next = step(prev, c, DT, env);
    const bad = stateViolation(next);
    if (bad) throw new Error(`t=${next.time.toFixed(3)} (seg ${i % frozenSegs.length}, phase ${prev.phase}→${next.phase}): ${bad}`);
    if (Math.abs(next.time - (prev.time + DT)) > 1e-9) throw new Error(`time ${prev.time} → ${next.time}`);
    const tb = transitionViolation(prev, next, env);
    if (tb) throw new Error(`t=${next.time.toFixed(3)} (seg ${i % frozenSegs.length}): ${tb}`);
    if (prev.phase === 'crashed') {
      if (next.phase !== 'crashed') throw new Error(`left 'crashed' for '${next.phase}'`);
      if (JSON.stringify(next.crash) !== JSON.stringify(prev.crash)) throw new Error('crash record changed after the crash');
      if (JSON.stringify(next.position) !== JSON.stringify(prev.position)) throw new Error('wreck moved');
    }
    s = deepFreeze(next);
    t += DT;
    segLeft -= DT;
    if (segLeft <= 0) { i++; segLeft = frozenSegs[i % frozenSegs.length].seconds; }
  }
  return s;
}

const segmentsArb = fc.array(controlSegment, { minLength: 2, maxLength: 40 });
const envArb = fc.constantFrom('flat', 'runwayFlat', 'hilly');

describe('flight model under random control sequences', () => {
  it('60–300 s from the runway / approach / random airborne states: every invariant after every step', () => {
    fc.assert(fc.property(startArb, envArb, segmentsArb, num(60, 300), (start, envName, segs, seconds) => {
      const env = ENVS[envName];
      flyChecked(initial(start, env), segs, seconds, env);
    }), fcParams(24));
  }, TIMEOUT);

  it('is deterministic: the same start and control sequence give bit-identical states', () => {
    fc.assert(fc.property(startArb, envArb, segmentsArb, num(20, 60), (start, envName, segs, seconds) => {
      const env = ENVS[envName];
      const a = flyChecked(initial(start, env), segs, seconds, env);
      const b = flyChecked(initial(start, env), segs, seconds, env);
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    }), fcParams(8));
  }, TIMEOUT);

  it('hostile control values (NaN, ±Infinity, out of range) are sanitised: the state stays valid', () => {
    const hostileControls: fc.Arbitrary<Controls> = fc.record({
      throttle: fc.oneof(num(-5, 5), hostileNum),
      elevator: fc.oneof(num(-5, 5), hostileNum),
      aileron: fc.oneof(num(-5, 5), hostileNum),
      rudder: fc.oneof(num(-5, 5), hostileNum),
      elevatorTrim: fc.oneof(num(-5, 5), hostileNum),
      flapsNotch: fc.oneof(fc.integer({ min: -3, max: 9 }), num(-2, 6), hostileNum),
      gearDown: fc.boolean(),
      brake: fc.oneof(num(-5, 5), hostileNum),
      parkingBrake: fc.boolean(),
      engineOn: fc.boolean(),
    });
    fc.assert(fc.property(startArb, envArb, fc.array(fc.record({ seconds: num(0.2, 5), controls: hostileControls }), { minLength: 1, maxLength: 20 }), (start, envName, segs) => {
      const env = ENVS[envName];
      flyChecked(initial(start, env), segs, 30, env);
    }), fcParams(15));
  }, TIMEOUT);

  it('dt edge cases: 0 / negative / NaN / Infinity return an unchanged copy; big dt is sub-stepped and stays valid', () => {
    fc.assert(fc.property(startArb, envArb, controls, fc.array(fc.oneof(
      { weight: 4, arbitrary: num(0, 0.05) },
      { weight: 1, arbitrary: fc.constantFrom(0, -1, NaN, Infinity, 1 / 60, 0.25) },
      { weight: 1, arbitrary: num(0.05, 0.3) },
    ), { minLength: 1, maxLength: 200 }), (start, envName, c, dts) => {
      const env = ENVS[envName];
      let s = deepFreeze(initial(start, env));
      for (const dt of dts) {
        const next = step(s, deepFreeze({ ...c }), dt, env);
        if (!(Number.isFinite(dt) && dt > 0)) {
          if (next === s) throw new Error('returned the same object (callers may mutate it)');
          if (JSON.stringify(next) !== JSON.stringify(s)) throw new Error(`dt=${dt} changed the state`);
        } else {
          const bad = stateViolation(next);
          if (bad) throw new Error(`dt=${dt}: ${bad}`);
          if (Math.abs(next.time - s.time - dt) > 1e-9) throw new Error(`dt=${dt}: time advanced by ${next.time - s.time}`);
        }
        s = deepFreeze(next);
      }
    }), fcParams(40));
  }, TIMEOUT);
});

describe('physical sanity', () => {
  it('a held dive at any angle and power never exceeds 250 KIAS without the airframe failing (overspeed)', () => {
    // Regression: the wave-1 snapshot reached 232 KIAS / 250 kt at −20° pitch, 85 % power, gear up (and 395 kt
    // in a vertical power dive) with no consequence. Physics now fails the airframe beyond 1.3·Vne.
    fc.assert(fc.property(num(-90, -15), num(0, 1), fc.boolean(), num(1000, 4000), (pitch, throttle, gearDown, alt) => {
      const { state, controls: c } = createTrimmedState({ altitudeM: alt, iasKt: 100, headingDeg: 0, gearDown });
      let s: AircraftState = { ...state, orientation: quatFromEuler(0, pitch, 0) };
      const pilot = new ScriptedPilot({ throttle, gearDown, elevatorTrim: c.elevatorTrim, vertical: { mode: 'pitch', deg: pitch }, lateral: { mode: 'bank', deg: 0 } });
      for (let n = 0; n < 120 * 120 && s.phase !== 'crashed'; n++) {
        s = step(s, pilot.controls(s), DT, FLAT_ENV);
        const bad = stateViolation(s);
        if (bad) throw new Error(`t=${s.time.toFixed(1)} s, alt ${s.position.y.toFixed(0)} m, pitch ${s.derived.pitchDeg.toFixed(0)}°: ${bad}`);
      }
    }), fcParams(40));
  }, TIMEOUT);

  it('no free energy: engine off, rudder neutral, clear of the ground → g·h + V²/2 never increases', () => {
    const g = CONFIG.sim.gravity;
    const glideSeg = fc.record({
      seconds: num(0.2, 6),
      controls: controls.map((c) => ({ ...c, engineOn: false, throttle: 0, rudder: 0 })),
    });
    fc.assert(fc.property(airborneArb, fc.array(glideSeg, { minLength: 1, maxLength: 20 }), (spec, segs) => {
      const env = FLAT_ENV;
      const base = airborneState({ ...spec, agl: Math.max(spec.agl, 600) }, env);
      let s: AircraftState = deepFreeze({ ...base, engine: { running: false, starting: false, startTimer: 0, failed: false, power: 0, rpm: 0, thrust: 0 } });
      const E = (x: AircraftState) => g * x.position.y + 0.5 * (x.velocity.x ** 2 + x.velocity.y ** 2 + x.velocity.z ** 2);
      let i = 0;
      let left = segs[0].seconds;
      for (let n = 0; n < 60 * 120; n++) {
        const next = step(s, segs[i % segs.length].controls, DT, env);
        if (next.phase !== 'airborne' || next.derived.altitudeAGL < 40) break;
        const dE = E(next) - E(s);
        if (dE > 0.02) {
          throw new Error(`energy rose by ${dE.toFixed(4)} m²/s² in one step at t=${next.time.toFixed(3)} ` +
            `(V=${next.derived.tas.toFixed(1)} m/s, α=${(next.derived.alpha * 57.3).toFixed(1)}°, β=${(next.derived.beta * 57.3).toFixed(1)}°, thrust=${next.engine.thrust.toFixed(1)} N)`);
        }
        s = deepFreeze(next);
        left -= DT;
        if (left <= 0) { i++; left = segs[i % segs.length].seconds; }
      }
    }), fcParams(30));
  }, TIMEOUT);
});

/** A random manoeuvre for the scripted pilot: keeps the aircraft flying so the fuzzer explores real flight regimes. */
const manoeuvreArb: fc.Arbitrary<{ seconds: number; settings: Partial<PilotSettings> }> = fc.record({
  seconds: num(2, 25),
  settings: fc.record({
    vertical: fc.oneof(
      fc.record({ mode: fc.constant('pitch' as const), deg: num(-20, 30) }),
      fc.record({ mode: fc.constant('speed' as const), kt: num(45, 150) }),
      fc.record({ mode: fc.constant('vs' as const), ms: num(-12, 8) }),
      fc.record({ mode: fc.constant('elevator' as const), value: num(-1, 1) }),
    ),
    lateral: fc.oneof(
      fc.record({ mode: fc.constant('bank' as const), deg: num(-75, 75) }),
      fc.record({ mode: fc.constant('heading' as const), deg: num(0, 360), maxBank: num(5, 60) }),
      fc.constant({ mode: 'centreline' as const }),
    ),
    throttle: fc.oneof(num(0, 1), fc.record({ mode: fc.constant('speed' as const), kt: num(50, 140) })),
    flapsNotch: fc.integer({ min: 0, max: 3 }),
    gearDown: fc.oneof({ weight: 3, arbitrary: fc.constant(true) }, { weight: 1, arbitrary: fc.constant(false) }),
    brake: fc.oneof({ weight: 4, arbitrary: fc.constant(0) }, { weight: 1, arbitrary: num(0, 1) }),
    engineOn: fc.oneof({ weight: 6, arbitrary: fc.constant(true) }, { weight: 1, arbitrary: fc.constant(false) }),
  }),
});

describe('flight model under a randomly-commanded pilot (take-off, then random manoeuvres)', () => {
  it('steep turns, dives, zooms, stalls, gear/flap cycling, engine cuts: every invariant after every step', () => {
    fc.assert(fc.property(envArb, fc.array(manoeuvreArb, { minLength: 3, maxLength: 20 }), (envName, moves) => {
      const env = ENVS[envName];
      const pilot = new ScriptedPilot({ throttle: 1, lateral: { mode: 'centreline' }, vertical: { mode: 'elevator', value: 0 } });
      let s = deepFreeze(createInitialState(env));
      const field = s.position.y;
      const run = (seconds: number, until?: (x: AircraftState) => boolean) => {
        for (let n = 0; n < Math.round(seconds / DT); n++) {
          const prev = s;
          const next = step(prev, deepFreeze(pilot.controls(prev)), DT, env);
          const bad = stateViolation(next) ?? transitionViolation(prev, next, env);
          if (bad) throw new Error(`t=${next.time.toFixed(3)} ${prev.phase}→${next.phase}: ${bad}`);
          s = deepFreeze(next);
          if (until?.(s)) return;
        }
      };
      // Scripted take-off to ~300 m above the field so the random part starts in the air.
      run(40, (x) => iasKt(x) > 55);
      pilot.set({ vertical: { mode: 'pitch', deg: 8 } });
      run(20, (x) => x.phase === 'airborne' && x.airborneTime > 2);
      pilot.set({ vertical: { mode: 'speed', kt: 75 }, lateral: { mode: 'heading', deg: 360 } });
      run(200, (x) => x.position.y > field + 300);
      for (const m of moves) {
        pilot.set(m.settings);
        run(m.seconds);
        if (s.phase === 'crashed') break;
      }
    }), fcParams(20));
  }, TIMEOUT);
});
