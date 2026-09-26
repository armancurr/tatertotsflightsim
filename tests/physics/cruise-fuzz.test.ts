/**
 * MS Tater Star property tests (fast-check), after v50-fuzz: random helm scripts — the lever through
 * ahead, neutral and astern, the rudders (A / D), the tunnel thrusters (← / →), the engine switch —
 * driven for 60 s from rest and from random speeds, headings and attitudes, in the real Gerstner
 * sea, over deep water, off a shelving shore and against a quay. Whatever the helmsman does the
 * state stays finite and physical: unit quaternion, bounded rates, sane rpm, rudders within 35°,
 * thrusters within their rating (and silent at speed), valid phases, and a wreck stays put.
 */
import { describe, it, vi } from 'vitest';
import fc from 'fast-check';
import { CRUISE_AIRCRAFT } from '../../src/config';
import type { AircraftState, Controls, Environment } from '../../src/types';
import { createVesselState, step } from '../../src/physics';
import { quatFromEuler } from '../../src/physics/frames';
import { deepFreeze } from './helpers';
import { fcParams } from '../support/fc';
import { DT } from './v50-helpers';
import { CRUISE_CFG, OCEAN, WC } from './cruise-helpers';

vi.setConfig({ testTimeout: 240000 });

const PHASES = new Set(['afloat', 'crashed']);
const unit = fc.double({ min: 0, max: 1, noNaN: true });
const signed = fc.double({ min: -1, max: 1, noNaN: true });
const SHORE: Environment = { groundHeight: (_x, z) => (z >= -400 ? -30 : Math.min(3, -30 + (-400 - z) * 0.08)), surfaceAt: () => 'water', waterLevel: () => 0 };
const QUAY: Environment = { ...OCEAN, obstacleTop: (x, z) => (z < -200 || x > 40 ? 2 : -Infinity) };

const controlsArb: fc.Arbitrary<Controls> = fc.record({
  throttle: signed,
  elevator: signed,
  aileron: fc.oneof(signed, fc.constant(1), fc.constant(-1)),
  rudder: signed,
  elevatorTrim: signed,
  flapsNotch: fc.constant(0),
  gearDown: fc.boolean(),
  brake: unit,
  parkingBrake: fc.boolean(),
  engineOn: fc.oneof(fc.constant(true), fc.constant(true), fc.constant(false)),
});
const scriptArb = fc.array(
  fc.record({ controls: controlsArb, seconds: fc.double({ min: 1, max: 20, noNaN: true }), dt: fc.double({ min: DT / 4, max: DT * 1.4, noNaN: true }) }),
  { minLength: 3, maxLength: 10 },
);

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
    for (let i = 0; i < n && t < 60; i++, t += seg.dt) {
      const input = i % 50 === 0 ? deepFreeze(structuredClone(s)) : s;
      s = step(input, seg.controls, seg.dt, env, CRUISE_CFG);
      if (!finite(s)) return `non-finite state at t=${s.time}`;
      const q = s.orientation;
      const qn = Math.hypot(q.x, q.y, q.z, q.w);
      if (Math.abs(qn - 1) > 1e-6) return `quaternion norm ${qn}`;
      if (!PHASES.has(s.phase)) return `phase ${s.phase}`;
      const w = s.angularVelocity;
      if (Math.max(Math.abs(w.x), Math.abs(w.y), Math.abs(w.z)) > CRUISE_AIRCRAFT.limits.maxAngularRate + 1e-9) return 'angular rate past the clamp';
      const v = s.vessel;
      if (!v || v.propulsors.length !== WC.propulsors.length) return 'vessel state lost';
      for (let k = 0; k < v.propulsors.length; k++) {
        const p = v.propulsors[k];
        const pc = WC.propulsors[k];
        if (pc.type === 'thruster') {
          if (Math.abs(p.thrust) > pc.thruster!.maxThrustN + 1e-6) return `thruster ${p.thrust}`;
          if (Math.abs(v.speedMs) > 6 && Math.abs(p.thrust) > 0.05 * pc.thruster!.maxThrustN && s.phase !== 'crashed') return `thruster at speed ${p.thrust}`;
          if (p.steerDeg !== 0) return 'thruster steered';
        } else {
          if (p.rpm < 0 || p.rpm > WC.engine.maxRpm * 1.1) return `rpm ${p.rpm}`;
          if (Math.abs(p.steerDeg) > pc.maxSteerDeg + 1e-9) return `steer ${p.steerDeg}`;
        }
      }
      if (Math.hypot(s.velocity.x, s.velocity.y, s.velocity.z) > 16) return `speed ${Math.hypot(s.velocity.x, s.velocity.z)} m/s`;
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
  speedKt: fc.oneof(fc.constant(0), fc.double({ min: 0, max: 22, noNaN: true })),
  rollDeg: fc.double({ min: -15, max: 15, noNaN: true }),
  pitchDeg: fc.double({ min: -3, max: 3, noNaN: true }),
  seaTime: fc.double({ min: 0, max: 3000, noNaN: true }),
});

type Start = typeof startArb extends fc.Arbitrary<infer R> ? R : never;

function start(env: Environment, a: Start): AircraftState {
  const s = createVesselState(env, CRUISE_CFG, { x: 0, z: 0, headingDeg: a.headingDeg, speedKt: a.speedKt, seaTime: a.seaTime }).state;
  return { ...s, orientation: quatFromEuler(a.headingDeg, a.pitchDeg, a.rollDeg) };
}

describe('Tater Star fuzz: random helm scripts stay physical', () => {
  it('in the open sea (real waves), from random starts', () => {
    fc.assert(fc.property(startArb, scriptArb, (a, script) => driveScript(start(OCEAN, a), script, OCEAN) === null), fcParams(12));
  });

  it('off a shelving shore', () => {
    fc.assert(fc.property(startArb, scriptArb, (a, script) => driveScript(start(SHORE, { ...a, headingDeg: 0 }), script, SHORE) === null), fcParams(8));
  });

  it('against a quay', () => {
    fc.assert(fc.property(startArb, scriptArb, (a, script) => driveScript(start(QUAY, a), script, QUAY) === null), fcParams(8));
  });
});
