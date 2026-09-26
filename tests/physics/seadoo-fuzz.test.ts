/**
 * Sea-Doo RXP-X 325 property tests (fast-check): random rider scripts — the throttle and the iBR lever
 * through ahead, neutral and reverse, the brake, the handlebars, the rider's lean (← / →) and fore /
 * aft (↑ / ↓), VTS trim, the engine switch — driven for 30 s from rest, from the berth and from random
 * speeds, headings and attitudes (upside down included), in the real Gerstner sea, over deep water, on a
 * shelving beach and against a pontoon. Whatever the rider does the state stays finite and physical:
 * unit quaternion, bounded rates, sane rpm, nozzle and bucket, a rider state, valid phases; a wreck stays
 * put; a capsize is righted, never a wreck.
 */
import { describe, it, vi } from 'vitest';
import fc from 'fast-check';
import { SEADOO_AIRCRAFT } from '../../src/config';
import type { AircraftState, Controls, Environment } from '../../src/types';
import { createVesselState, step } from '../../src/physics';
import { quatFromEuler } from '../../src/physics/frames';
import { deepFreeze } from './helpers';
import { fcParams } from '../support/fc';
import { BEACH, DEEP_SEA, DT, SD_CFG, pontoonEnv } from './seadoo-helpers';

vi.setConfig({ testTimeout: 180000 });

const WC = SEADOO_AIRCRAFT.watercraft!;
const JET = WC.propulsors[0];
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
  brake: fc.oneof(fc.constant(0), fc.constant(0), unit),
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
      s = step(input, seg.controls, seg.dt, env, SD_CFG);
      if (!finite(s)) return `non-finite state at t=${s.time}`;
      const q = s.orientation;
      const qn = Math.hypot(q.x, q.y, q.z, q.w);
      if (Math.abs(qn - 1) > 1e-6) return `quaternion norm ${qn}`;
      if (!PHASES.has(s.phase)) return `phase ${s.phase}`;
      const w = s.angularVelocity;
      if (Math.max(Math.abs(w.x), Math.abs(w.y), Math.abs(w.z)) > SEADOO_AIRCRAFT.limits.maxAngularRate + 1e-9) return 'angular rate past the clamp';
      const v = s.vessel;
      if (!v) return 'vessel state lost';
      const r = v.rider;
      if (!r) return 'rider state lost';
      if (Math.abs(r.lean) > 1 + 1e-9 || Math.abs(r.foreAft) > 1 + 1e-9) return `rider lean ${r.lean} ${r.foreAft}`;
      if (r.aboard !== (r.off === null)) return 'rider aboard / off disagree';
      const rg = v.righting ?? 0;
      if (rg < 0 || rg > 1) return `righting ${rg}`;
      for (const p of v.propulsors) {
        if (p.rpm < 0 || p.rpm > WC.engine.maxRpm * 1.1) return `rpm ${p.rpm}`;
        if (Math.abs(p.steerDeg) > JET.maxSteerDeg + 1e-9) return `steer ${p.steerDeg}`;
        const j = p.jet;
        if (!j) return 'jet state lost';
        if (j.bucket < 0 || j.bucket > 1) return `bucket ${j.bucket}`;
        if (j.ventilation < 0 || j.ventilation > 1) return `ventilation ${j.ventilation}`;
        if (j.flow < 0 || j.jetSpeed < 0 || j.jetSpeed > 80) return `jet ${j.flow} ${j.jetSpeed}`;
        if (Math.abs(j.trimDeg) > JET.jet!.trimRangeDeg + Math.abs(JET.thrustAngleDeg) + 1e-9) return `trim ${j.trimDeg}`;
      }
      if (Math.hypot(s.velocity.x, s.velocity.y, s.velocity.z) > 45) return `speed ${Math.hypot(s.velocity.x, s.velocity.z)} m/s`;
      if (crashedAt) {
        if (s.phase !== 'crashed') return 'a wreck came back to life';
        if (s.position.x !== crashedAt.position.x || s.position.z !== crashedAt.position.z) return 'the wreck moved';
      } else if (s.phase === 'crashed') {
        if (!s.crash?.reason) return 'crash without a reason';
        if (/capsiz/i.test(s.crash.reason)) return 'a capsize wrecked it (it should be righted)';
        crashedAt = s;
      }
    }
  }
  return null;
}

const startArb = fc.record({
  headingDeg: fc.double({ min: 0, max: 360, noNaN: true }),
  speedKt: fc.oneof(fc.constant(0), fc.double({ min: 0, max: 58, noNaN: true })),
  rollDeg: fc.oneof(fc.double({ min: -40, max: 40, noNaN: true }), fc.double({ min: -180, max: 180, noNaN: true })),
  pitchDeg: fc.double({ min: -15, max: 20, noNaN: true }),
  lift: fc.oneof(fc.constant(0), fc.double({ min: 0, max: 2, noNaN: true })),
  moored: fc.boolean(),
  seaTime: fc.double({ min: 0, max: 3000, noNaN: true }),
});

type Start = typeof startArb extends fc.Arbitrary<infer R> ? R : never;

function start(env: Environment, a: Start): AircraftState {
  const s = createVesselState(env, SD_CFG, { x: 0, z: 0, headingDeg: a.headingDeg, speedKt: a.speedKt, moored: a.moored && a.speedKt === 0, seaTime: a.seaTime }).state;
  return { ...s, position: { ...s.position, y: s.position.y + a.lift }, orientation: quatFromEuler(a.headingDeg, a.pitchDeg, a.rollDeg) };
}

describe('Sea-Doo fuzz: random rider scripts stay physical', () => {
  it('in the open sea (real waves), from random starts, jumps and capsizes', () => {
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
