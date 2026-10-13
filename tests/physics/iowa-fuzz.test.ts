/**
 * USS Iowa property tests (fast-check): random helm scripts — the telegraph through ahead, stop and
 * astern, the wheel, the engine switch — for 30 s from rest, from her lines and from random speeds,
 * headings and attitudes, in the real Gerstner sea over deep water, on a shelving bank and against a
 * pier. Whatever the helmsman does the state stays finite and physical: unit quaternion, bounded
 * rates, sane turbine rpm and rudder angles, valid phases, and a wreck stays put.
 */
import { describe, it, vi } from 'vitest';
import fc from 'fast-check';
import { IOWA_AIRCRAFT } from '../../src/config';
import type { AircraftState, Controls, Environment } from '../../src/types';
import { createVesselState, step } from '../../src/physics';
import { quatFromEuler } from '../../src/physics/frames';
import { deepFreeze } from './helpers';
import { fcParams } from '../support/fc';
import { BANK, DT, IOWA_CFG, OCEAN, WC, pierEnv } from './iowa-helpers';

vi.setConfig({ testTimeout: 240000 });

const PHASES = new Set(['afloat', 'crashed']);
const unit = fc.double({ min: 0, max: 1, noNaN: true });
const signed = fc.double({ min: -1, max: 1, noNaN: true });

const controlsArb: fc.Arbitrary<Controls> = fc.record({
  throttle: signed,
  elevator: signed,
  aileron: signed,
  rudder: signed,
  elevatorTrim: signed,
  flapsNotch: fc.constant(0),
  gearDown: fc.boolean(),
  brake: unit,
  parkingBrake: fc.boolean(),
  engineOn: fc.oneof(fc.constant(true), fc.constant(true), fc.constant(false)),
});
const scriptArb = fc.array(
  fc.record({ controls: controlsArb, seconds: fc.double({ min: 0.5, max: 8, noNaN: true }), dt: fc.double({ min: DT / 4, max: DT * 1.4, noNaN: true }) }),
  { minLength: 3, maxLength: 10 },
);

/** Finite everywhere except the documented "deep water" depth (Infinity). */
function finite(o: unknown, key = ''): boolean {
  if (typeof o === 'number') return Number.isFinite(o) || (key === 'depthUnderKeel' && o === Infinity);
  if (o === null || typeof o !== 'object') return true;
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) if (!finite(v, k)) return false;
  return true;
}

function driveScript(s0: AircraftState, script: { controls: Controls; seconds: number; dt: number }[], env: Environment): string | null {
  let s = s0;
  let t = 0;
  let crashedAt: AircraftState | null = null;
  for (const seg of script) {
    const n = Math.max(1, Math.round(seg.seconds / seg.dt));
    for (let i = 0; i < n && t < 30; i++, t += seg.dt) {
      // (freeze every 10th input: the purity check, at a fraction of the cost)
      const input = i % 10 === 0 ? deepFreeze(structuredClone(s)) : s;
      s = step(input, seg.controls, seg.dt, env, IOWA_CFG);
      if (!finite(s)) return `non-finite state at t=${s.time}`;
      const q = s.orientation;
      const qn = Math.hypot(q.x, q.y, q.z, q.w);
      if (Math.abs(qn - 1) > 1e-6) return `quaternion norm ${qn}`;
      if (!PHASES.has(s.phase)) return `phase ${s.phase}`;
      const w = s.angularVelocity;
      if (Math.max(Math.abs(w.x), Math.abs(w.y), Math.abs(w.z)) > IOWA_AIRCRAFT.limits.maxAngularRate + 1e-9) return 'angular rate past the clamp';
      const v = s.vessel;
      if (!v) return 'vessel state lost';
      if (v.propulsors.length !== 4) return 'shafts lost';
      for (const p of v.propulsors) {
        if (p.rpm < 0 || p.rpm > WC.engine.maxRpm * 1.1) return `rpm ${p.rpm}`;
        if (Math.abs(p.steerDeg) > WC.propulsors[0].maxSteerDeg + 1e-9) return `rudder ${p.steerDeg}`;
      }
      if (Math.hypot(s.velocity.x, s.velocity.y, s.velocity.z) > 22) return `speed ${Math.hypot(s.velocity.x, s.velocity.z)} m/s`;
      if (crashedAt) {
        if (s.phase !== 'crashed') return 'a wreck came back to life';
        if (s.position.x !== crashedAt.position.x || s.position.z !== crashedAt.position.z) return 'the wreck moved';
      } else if (s.phase === 'crashed') {
        if (!s.crash?.reason) return 'crash without a reason';
        crashedAt = s;
      }
    }
  }
  return null;
}

const startArb = fc.record({
  headingDeg: fc.double({ min: 0, max: 360, noNaN: true }),
  speedKt: fc.oneof(fc.constant(0), fc.double({ min: 0, max: 33, noNaN: true })),
  rollDeg: fc.double({ min: -25, max: 25, noNaN: true }),
  pitchDeg: fc.double({ min: -3, max: 3, noNaN: true }),
  moored: fc.boolean(),
  seaTime: fc.double({ min: 0, max: 3000, noNaN: true }),
});

type Start = typeof startArb extends fc.Arbitrary<infer R> ? R : never;

function start(env: Environment, a: Start): AircraftState {
  const s = createVesselState(env, IOWA_CFG, { x: 0, z: 0, headingDeg: a.headingDeg, speedKt: a.speedKt, moored: a.moored && a.speedKt === 0, seaTime: a.seaTime }).state;
  return { ...s, orientation: quatFromEuler(a.headingDeg, a.pitchDeg, a.rollDeg) };
}

describe('USS Iowa fuzz: random helm scripts stay physical', () => {
  it('in the open sea (real waves), from random starts', () => {
    fc.assert(fc.property(startArb, scriptArb, (a, script) => driveScript(start(OCEAN, a), script, OCEAN) === null), fcParams(10));
  });

  it('near a shelving bank', () => {
    const env: Environment = { ...BANK, groundHeight: (x, z) => BANK.groundHeight(x, z - 380) };
    fc.assert(fc.property(startArb, scriptArb, (a, script) => driveScript(start(env, { ...a, headingDeg: 0 }), script, env) === null), fcParams(6));
  });

  it('against a pier', () => {
    const env = pierEnv(-140);
    fc.assert(fc.property(startArb, scriptArb, (a, script) => driveScript(start(env, a), script, env) === null), fcParams(6));
  });
});
