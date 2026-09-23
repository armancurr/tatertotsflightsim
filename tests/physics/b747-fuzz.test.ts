/**
 * Boeing 747-400 property tests (fast-check): random control scripts — column, wheel, rudder, thrust,
 * trim, flaps, gear, brakes, speed brake, engines — flown for 30 s from the runway, from the approach
 * and from random airborne attitudes and speeds. Whatever the pilot does the state stays finite and
 * physical: unit quaternion, bounded rates and speeds, valid phases, flaps/gear in range, no
 * afterburner, a wreck never moves. And the spawn is stable: sitting on the runway with any idle-ish
 * controls it never bounces, creeps into the air or crashes.
 */
import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { CONFIG, KT_TO_MS } from '../../src/config';
import type { AircraftState, Controls } from '../../src/types';
import { createApproachState, createInitialState, createTrimmedState, step, FLAT_ENV } from '../../src/physics';
import { omegaFromPqr, quatFromEuler } from '../../src/physics/frames';
import { B, B747_CFG } from './b747-helpers';
import { allFinite, RUNWAY_ENV } from './helpers';

vi.setConfig({ testTimeout: 180000 });

const FIXED = CONFIG.sim.fixedDt;
const PHASES = new Set(['ground', 'airborne', 'landed', 'crashed']);
const unit = fc.double({ min: 0, max: 1, noNaN: true });
const signed = fc.double({ min: -1, max: 1, noNaN: true });

const controlsArb: fc.Arbitrary<Controls> = fc.record({
  throttle: unit,
  elevator: signed,
  aileron: signed,
  rudder: signed,
  elevatorTrim: signed,
  flapsNotch: fc.integer({ min: 0, max: B.flaps.notchesDeg.length - 1 }),
  gearDown: fc.boolean(),
  brake: unit,
  parkingBrake: fc.boolean(),
  engineOn: fc.boolean(),
  speedBrake: fc.boolean(),
});
const scriptArb = fc.array(
  fc.record({ controls: controlsArb, seconds: fc.double({ min: 0.2, max: 6, noNaN: true }), dt: fc.double({ min: FIXED / 4, max: FIXED, noNaN: true }) }),
  { minLength: 3, maxLength: 20 },
);

/** Fly a script for (up to) 30 s, checking the invariants after every step. Returns a failure message or null. */
function flyScript(s0: AircraftState, script: { controls: Controls; seconds: number; dt: number }[], env = RUNWAY_ENV): string | null {
  let s = s0;
  let t = 0;
  for (const seg of script) {
    const n = Math.max(1, Math.round(seg.seconds / seg.dt));
    for (let i = 0; i < n && t < 30; i++, t += seg.dt) {
      const prev = s;
      s = step(s, seg.controls, seg.dt, env, B747_CFG);
      if (!allFinite(s)) return `non-finite state at t=${s.time}`;
      const q = s.orientation;
      const qn = Math.hypot(q.x, q.y, q.z, q.w);
      if (Math.abs(qn - 1) > 1e-6) return `quaternion norm ${qn}`;
      if (!PHASES.has(s.phase)) return `phase ${s.phase}`;
      const w = s.angularVelocity;
      if (Math.max(Math.abs(w.x), Math.abs(w.y), Math.abs(w.z)) > B.limits.maxAngularRate + 1e-9) return 'angular rate past the clamp';
      if (s.derived.ias > B.limits.vneKt * B.limits.overspeedFailureFactor * KT_TO_MS * 1.05 && s.phase !== 'crashed') return `IAS ${s.derived.ias} m/s`;
      if ((s.engine.afterburner ?? 0) !== 0) return 'afterburner lit';
      if (s.engine.thrust > B.engine.jet!.milThrustN * 1.001) return `thrust ${s.engine.thrust}`;
      if (s.flapsDeg < -1e-9 || s.flapsDeg > 30 + 1e-9 || s.gearPos < 0 || s.gearPos > 1) return 'flaps/gear out of range';
      if (s.time <= prev.time) return 'time did not advance';
      if (s.phase === 'crashed' && prev.phase === 'crashed' && (s.position.x !== prev.position.x || s.position.z !== prev.position.z)) return 'wreck moved';
    }
  }
  return null;
}

describe('747 fuzz: random pilots for 30 s', () => {
  it('from the runway', () => {
    fc.assert(fc.property(scriptArb, (script) => {
      const r = flyScript(createInitialState(RUNWAY_ENV, B747_CFG), script);
      if (r) throw new Error(r);
      return true;
    }), { numRuns: 20 });
  });

  it('from the approach', () => {
    fc.assert(fc.property(scriptArb, (script) => {
      const r = flyScript(createApproachState(RUNWAY_ENV, B747_CFG), script);
      if (r) throw new Error(r);
      return true;
    }), { numRuns: 20 });
  });

  it('from random airborne attitudes, rates and speeds (high over the flat world)', () => {
    const startArb = fc.record({
      kt: fc.double({ min: 100, max: 400, noNaN: true }),
      alt: fc.double({ min: 1500, max: 12000, noNaN: true }),
      pitch: fc.double({ min: -60, max: 60, noNaN: true }),
      roll: fc.double({ min: -180, max: 180, noNaN: true }),
      p: fc.double({ min: -1, max: 1, noNaN: true }),
      q: fc.double({ min: -0.5, max: 0.5, noNaN: true }),
      r: fc.double({ min: -0.5, max: 0.5, noNaN: true }),
    });
    fc.assert(fc.property(startArb, scriptArb, (st, script) => {
      const { state } = createTrimmedState({ altitudeM: st.alt, iasKt: Math.min(st.kt, 300), gearDown: false }, FLAT_ENV, B747_CFG);
      const s0: AircraftState = {
        ...state,
        orientation: quatFromEuler(0, st.pitch, st.roll),
        angularVelocity: omegaFromPqr(st.p, st.q, st.r),
      };
      const r = flyScript(s0, script, FLAT_ENV);
      if (r) throw new Error(r);
      return true;
    }), { numRuns: 20 });
  });
});

describe('747 spawn is stable', () => {
  it('property: parked or idling on the runway with any trim/column/wheel/flaps, it never leaves the ground, bounces or crashes', () => {
    const idleArb = fc.record({
      throttle: fc.double({ min: 0, max: 0.03, noNaN: true }),
      elevator: signed,
      aileron: signed,
      rudder: signed,
      elevatorTrim: signed,
      flapsNotch: fc.integer({ min: 0, max: 5 }),
      brake: unit,
      parkingBrake: fc.boolean(),
      speedBrake: fc.boolean(),
    });
    fc.assert(fc.property(idleArb, (c) => {
      let s = createInitialState(RUNWAY_ENV, B747_CFG);
      const controls: Controls = { gearDown: true, engineOn: true, ...c };
      let maxVs = 0;
      for (let i = 0; i < 120 * 8; i++) {
        s = step(s, controls, FIXED, RUNWAY_ENV, B747_CFG);
        maxVs = Math.max(maxVs, Math.abs(s.velocity.y));
      }
      expect(s.crash).toBeNull();
      expect(s.onGround).toBe(true);
      expect(s.phase).toBe('ground');
      expect(maxVs).toBeLessThan(0.1);
      expect(s.wheelContact.every(Boolean)).toBe(true);
      // Idle thrust never drags 220 t away with the brakes off: a slow creep at most.
      expect(s.derived.groundSpeed).toBeLessThan(2);
    }), { numRuns: 20 });
  });
});
