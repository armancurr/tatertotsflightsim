/**
 * Princess V50 property tests (fast-check): random helm scripts — the lever through ahead, neutral
 * and astern, the wheel, trim tabs, the engine switch — driven for 30 s from rest, from the berth
 * and from random speeds, headings and attitudes, in the real Gerstner sea, over deep water, on a
 * shelving beach and against a pontoon. Whatever the helmsman does the state stays finite and
 * physical: unit quaternion, bounded rates, sane rpm and steering, valid phases, and a wreck stays put.
 */
import { describe, it, vi } from 'vitest';
import fc from 'fast-check';
import { V50_AIRCRAFT } from '../../src/config';
import type { AircraftState, Controls, Environment } from '../../src/types';
import { createVesselState, step } from '../../src/physics';
import { quatFromEuler } from '../../src/physics/frames';
import { deepFreeze } from './helpers';
import { fcParams } from '../support/fc';
import { BEACH, DEEP_SEA, DT, V50_CFG, pontoonEnv } from './v50-helpers';

vi.setConfig({ testTimeout: 180000 });

const WC = V50_AIRCRAFT.watercraft!;
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
  fc.record({ controls: controlsArb, seconds: fc.double({ min: 0.2, max: 6, noNaN: true }), dt: fc.double({ min: DT / 4, max: DT * 1.4, noNaN: true }) }),
  { minLength: 3, maxLength: 16 },
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
      const input = deepFreeze(structuredClone(s));
      s = step(input, seg.controls, seg.dt, env, V50_CFG);
      if (!finite(s)) return `non-finite state at t=${s.time}`;
      const q = s.orientation;
      const qn = Math.hypot(q.x, q.y, q.z, q.w);
      if (Math.abs(qn - 1) > 1e-6) return `quaternion norm ${qn}`;
      if (!PHASES.has(s.phase)) return `phase ${s.phase}`;
      const w = s.angularVelocity;
      if (Math.max(Math.abs(w.x), Math.abs(w.y), Math.abs(w.z)) > V50_AIRCRAFT.limits.maxAngularRate + 1e-9) return 'angular rate past the clamp';
      const v = s.vessel;
      if (!v) return 'vessel state lost';
      for (const p of v.propulsors) {
        if (p.rpm < 0 || p.rpm > WC.engine.maxRpm * 1.1) return `rpm ${p.rpm}`;
        if (Math.abs(p.steerDeg) > WC.propulsors[0].maxSteerDeg + 1e-9) return `steer ${p.steerDeg}`;
      }
      if (v.tabs < 0 || v.tabs > 1) return `tabs ${v.tabs}`;
      if (Math.hypot(s.velocity.x, s.velocity.y, s.velocity.z) > 40) return `speed ${Math.hypot(s.velocity.x, s.velocity.z)} m/s`;
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
  speedKt: fc.oneof(fc.constant(0), fc.double({ min: 0, max: 34, noNaN: true })),
  rollDeg: fc.double({ min: -40, max: 40, noNaN: true }),
  pitchDeg: fc.double({ min: -10, max: 15, noNaN: true }),
  moored: fc.boolean(),
  seaTime: fc.double({ min: 0, max: 3000, noNaN: true }),
});

type Start = typeof startArb extends fc.Arbitrary<infer R> ? R : never;

function start(env: Environment, a: Start): AircraftState {
  const s = createVesselState(env, V50_CFG, { x: 0, z: 0, headingDeg: a.headingDeg, speedKt: a.speedKt, moored: a.moored && a.speedKt === 0, seaTime: a.seaTime }).state;
  return { ...s, orientation: quatFromEuler(a.headingDeg, a.pitchDeg, a.rollDeg) };
}

describe('Princess V50 fuzz: random helm scripts stay physical', () => {
  it('in the open sea (real waves), from random starts', () => {
    fc.assert(fc.property(startArb, scriptArb, (a, script) => driveScript(start(DEEP_SEA, a), script, DEEP_SEA) === null), fcParams(25));
  });

  it('near a shelving beach', () => {
    fc.assert(fc.property(startArb, scriptArb, (a, script) => driveScript(start(BEACH, { ...a, headingDeg: 0 }), script, BEACH) === null), fcParams(15));
  });

  it('against a pontoon', () => {
    const env = pontoonEnv(-30);
    fc.assert(fc.property(startArb, scriptArb, (a, script) => driveScript(start(env, a), script, env) === null), fcParams(15));
  });
});
