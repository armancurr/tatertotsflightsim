/**
 * Property-based (fuzz) tests with fast-check: random control scripts with
 * random time steps (≤ fixedDt), flown for 60–300 simulated seconds from the
 * runway, from the approach and from random airborne attitudes and speeds.
 * Whatever the pilot does, the state stays physical and the API contract holds.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { CONFIG, MS_TO_KT } from '../../src/config';
import type { AircraftState, Controls } from '../../src/types';
import {
  step, createInitialState, createApproachState, createTrimmedState, FLAT_ENV,
} from '../../src/physics';
import { quatFromEuler, omegaFromPqr } from '../../src/physics/frames';
import { allFinite, deepFreeze, RUNWAY_ENV } from './helpers';

const FIXED = CONFIG.sim.fixedDt;
const FLAPS_MAX = Math.max(...CONFIG.aircraft.flaps.notchesDeg);
const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 12;
const SEED = process.env.FUZZ_SEED ? Number(process.env.FUZZ_SEED) : undefined;
const PHASES = new Set(['ground', 'airborne', 'landed', 'crashed']);

const unit = fc.double({ min: 0, max: 1, noNaN: true });
const signed = fc.double({ min: -1, max: 1, noNaN: true });

const controlsArb: fc.Arbitrary<Controls> = fc.record({
  throttle: unit,
  elevator: signed,
  aileron: signed,
  rudder: signed,
  elevatorTrim: signed,
  flapsNotch: fc.integer({ min: 0, max: CONFIG.aircraft.flaps.notchesDeg.length - 1 }),
  gearDown: fc.boolean(),
  brake: unit,
  parkingBrake: fc.boolean(),
  engineOn: fc.boolean(),
});

/** A script: segments of constant controls, each with its own duration and time step. */
const segmentArb = fc.record({
  controls: controlsArb,
  seconds: fc.double({ min: 0.3, max: 12, noNaN: true }),
  dt: fc.double({ min: FIXED / 4, max: FIXED, noNaN: true }),
});
const scriptArb = fc.array(segmentArb, { minLength: 3, maxLength: 30 });
const durationArb = fc.integer({ min: 60, max: 300 });

const airborneArb = fc.record({
  altitudeM: fc.double({ min: 300, max: 3000, noNaN: true }),
  iasKt: fc.double({ min: 45, max: 150, noNaN: true }),
  headingDeg: fc.double({ min: 0, max: 360, noNaN: true }),
  pitchDeg: fc.double({ min: -70, max: 70, noNaN: true }),
  rollDeg: fc.double({ min: -180, max: 180, noNaN: true }),
  p: fc.double({ min: -1.5, max: 1.5, noNaN: true }),
  q: fc.double({ min: -1, max: 1, noNaN: true }),
  r: fc.double({ min: -1, max: 1, noNaN: true }),
  flapsNotch: fc.integer({ min: 0, max: 3 }),
  gearDown: fc.boolean(),
});

type AirborneCase = typeof airborneArb extends fc.Arbitrary<infer T> ? T : never;

function randomAirborne(a: AirborneCase): AircraftState {
  const { state } = createTrimmedState({
    altitudeM: a.altitudeM, iasKt: a.iasKt, headingDeg: a.headingDeg, flapsNotch: a.flapsNotch, gearDown: a.gearDown,
  });
  // Keep the flight path, throw the airframe into a random attitude and rotation.
  return {
    ...state,
    orientation: quatFromEuler(a.headingDeg, a.pitchDeg, a.rollDeg),
    angularVelocity: omegaFromPqr(a.p, a.q, a.r),
  };
}

/** Physical invariants between two consecutive states. Returns a description of the first violation. */
function violation(prev: AircraftState, next: AircraftState, dt: number): string | null {
  const { position: p, velocity: v, orientation: o, angularVelocity: w } = next;
  const nums = [p.x, p.y, p.z, v.x, v.y, v.z, o.x, o.y, o.z, o.w, w.x, w.y, w.z, next.time, next.flapsDeg, next.gearPos,
    next.airborneTime, next.engine.power, next.engine.rpm, next.engine.thrust, next.engine.startTimer];
  for (const n of nums) if (!Number.isFinite(n)) return 'non-finite core value';
  for (const n of Object.values(next.derived)) if (!Number.isFinite(n)) return 'non-finite derived value';
  const qn = Math.sqrt(o.x * o.x + o.y * o.y + o.z * o.z + o.w * o.w);
  if (Math.abs(qn - 1) > 1e-6) return `orientation not unit (${qn})`;
  if (next.gearPos < 0 || next.gearPos > 1) return `gearPos ${next.gearPos}`;
  if (next.flapsDeg < 0 || next.flapsDeg > FLAPS_MAX) return `flapsDeg ${next.flapsDeg}`;
  if (next.engine.power < 0 || next.engine.power > 1.2) return `power ${next.engine.power}`;
  if (next.engine.rpm < 0) return `rpm ${next.engine.rpm}`;
  if (next.wheelCompression.some((c) => c < 0)) return 'negative strut compression';
  if (!PHASES.has(next.phase)) return `phase ${next.phase}`;
  const kt = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) * MS_TO_KT;
  if (kt >= 250) return `speed ${kt.toFixed(0)} kt`;
  if (Math.abs(next.time - prev.time - dt) > 1e-9) return 'time did not advance by dt';
  if (next.phase === 'airborne' && next.onGround) return 'airborne while on the ground';
  if (next.stalled && next.phase !== 'airborne') return 'stalled while not airborne';
  if (prev.phase === 'crashed') {
    if (next.phase !== 'crashed') return 'left the crashed state';
    if (next.position.x !== prev.position.x || next.position.y !== prev.position.y || next.position.z !== prev.position.z) return 'wreck moved';
    if (JSON.stringify(next.crash) !== JSON.stringify(prev.crash)) return 'crash record changed';
    if (next.engine.running) return 'engine running after crash';
  }
  if (next.phase === 'crashed' && !next.crash) return 'crashed without a record';
  return null;
}

type Script = { controls: Controls; seconds: number; dt: number }[];

/** Fly a script (repeated cyclically) for `seconds`; returns the first invariant violation or null, plus the end state. */
function runScript(start: AircraftState, script: Script, seconds: number, env = FLAT_ENV): { error: string | null; end: AircraftState; steps: number } {
  let s = start;
  let t = 0;
  let steps = 0;
  for (let k = 0; t < seconds; k++) {
    const seg = script[k % script.length];
    const n = Math.max(1, Math.round(seg.seconds / seg.dt));
    for (let i = 0; i < n && t < seconds; i++) {
      const next = step(s, seg.controls, seg.dt, env);
      const err = violation(s, next, seg.dt);
      if (err) return { error: `${err} at t=${t.toFixed(2)}s (step ${steps})`, end: next, steps };
      s = next;
      t += seg.dt;
      steps++;
    }
  }
  return { error: allFinite(s) ? null : 'non-finite value somewhere in the state', end: s, steps };
}

const params = { numRuns: NUM_RUNS, seed: SEED, endOnFailure: true };

describe('fuzz: random pilots cannot break the physics', () => {
  it('from the runway (runway-only world), 60–300 s of random controls', () => {
    fc.assert(
      fc.property(scriptArb, durationArb, (script, seconds) => {
        const r = runScript(createInitialState(RUNWAY_ENV), script, seconds, RUNWAY_ENV);
        expect(r.error).toBeNull();
      }),
      params,
    );
  }, 120_000);

  it('from the final-approach state, 60–300 s of random controls', () => {
    fc.assert(
      fc.property(scriptArb, durationArb, (script, seconds) => {
        const r = runScript(createApproachState(), script, seconds);
        expect(r.error).toBeNull();
      }),
      params,
    );
  }, 120_000);

  it('from random airborne attitudes, rates and speeds, 60–300 s of random controls', () => {
    fc.assert(
      fc.property(airborneArb, scriptArb, durationArb, (a, script, seconds) => {
        const r = runScript(randomAirborne(a), script, seconds);
        expect(r.error).toBeNull();
      }),
      params,
    );
  }, 120_000);

  it('step never mutates its inputs (deep-frozen state and controls, random states and controls)', () => {
    fc.assert(
      fc.property(airborneArb, scriptArb, (a, script) => {
        let s = randomAirborne(a);
        let k = 0;
        for (let i = 0; i < 400; i++) {
          const seg = script[k++ % script.length];
          const snapshot = JSON.stringify(s);
          const frozen = deepFreeze(JSON.parse(snapshot) as AircraftState);
          const c = deepFreeze({ ...seg.controls });
          const next = step(frozen, c, seg.dt); // throws if it writes to a frozen object
          expect(JSON.stringify(frozen)).toBe(snapshot);
          expect(next).not.toBe(frozen);
          s = next;
        }
      }),
      { ...params, numRuns: Math.max(4, Math.round(NUM_RUNS / 2)) },
    );
  }, 120_000);

  it('is deterministic: the same script from the same state gives bit-identical results', () => {
    fc.assert(
      fc.property(fc.oneof(fc.constant<'runway' | 'approach'>('runway'), fc.constant<'runway' | 'approach'>('approach')), scriptArb, (where, script) => {
        const start = () => (where === 'runway' ? createInitialState() : createApproachState());
        const a = runScript(start(), script, 60);
        const b = runScript(start(), script, 60);
        expect(JSON.stringify(a.end)).toBe(JSON.stringify(b.end));
        expect(a.steps).toBe(b.steps);
      }),
      { ...params, numRuns: Math.max(4, Math.round(NUM_RUNS / 2)) },
    );
  }, 120_000);

  it('a crashed aircraft stays crashed and still whatever the controls and time steps', () => {
    fc.assert(
      fc.property(scriptArb, (script) => {
        const { state, controls } = createTrimmedState({ altitudeM: 60, iasKt: 110 });
        let s = state;
        for (let i = 0; i < 12000 && s.phase !== 'crashed'; i++) s = step(s, { ...controls, elevator: -1 }, FIXED);
        expect(s.phase).toBe('crashed');
        const r = runScript(s, script, 30);
        expect(r.error).toBeNull();
        expect(r.end.phase).toBe('crashed');
        expect(r.end.position).toEqual(s.position);
      }),
      { ...params, numRuns: Math.max(4, Math.round(NUM_RUNS / 2)) },
    );
  }, 120_000);
});
