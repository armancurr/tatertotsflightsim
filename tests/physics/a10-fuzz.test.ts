/**
 * A-10C property tests (fast-check): random control scripts — stick, rudder, throttle, flaps, gear,
 * brakes, decelerons and the gun trigger — flown for 30 s from the runway, from the approach and from
 * random airborne attitudes and speeds. Whatever the pilot does the state stays finite and physical:
 * unit quaternion, bounded rates and speeds, valid phases, the afterburner never lights.
 */
import { describe, it, vi } from 'vitest';
import fc from 'fast-check';
import { A10_AIRCRAFT, CONFIG, KT_TO_MS } from '../../src/config';
import type { AircraftState, Controls } from '../../src/types';
import { createApproachState, createInitialState, createTrimmedState, step, FLAT_ENV } from '../../src/physics';
import { omegaFromPqr, quatFromEuler } from '../../src/physics/frames';
import { A10_CFG } from './a10-helpers';
import { allFinite, RUNWAY_ENV } from './helpers';

vi.setConfig({ testTimeout: 120000 });

const FIXED = CONFIG.sim.fixedDt;
const A = A10_AIRCRAFT;
const PHASES = new Set(['ground', 'airborne', 'landed', 'crashed']);
const unit = fc.double({ min: 0, max: 1, noNaN: true });
const signed = fc.double({ min: -1, max: 1, noNaN: true });

const controlsArb: fc.Arbitrary<Controls> = fc.record({
  throttle: unit,
  elevator: signed,
  aileron: signed,
  rudder: signed,
  elevatorTrim: signed,
  flapsNotch: fc.integer({ min: 0, max: A.flaps.notchesDeg.length - 1 }),
  gearDown: fc.boolean(),
  brake: unit,
  parkingBrake: fc.boolean(),
  engineOn: fc.boolean(),
  speedBrake: fc.boolean(),
  gunFiring: fc.boolean(),
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
      s = step(s, seg.controls, seg.dt, env, A10_CFG);
      if (!allFinite(s)) return `non-finite state at t=${s.time}`;
      const q = s.orientation;
      const qn = Math.hypot(q.x, q.y, q.z, q.w);
      if (Math.abs(qn - 1) > 1e-6) return `quaternion norm ${qn}`;
      if (!PHASES.has(s.phase)) return `phase ${s.phase}`;
      const w = s.angularVelocity;
      if (Math.max(Math.abs(w.x), Math.abs(w.y), Math.abs(w.z)) > A.limits.maxAngularRate + 1e-9) return 'angular rate past the clamp';
      if (s.derived.ias > A.limits.vneKt * A.limits.overspeedFailureFactor * KT_TO_MS * 1.05 && s.phase !== 'crashed') return `IAS ${s.derived.ias} m/s`;
      if ((s.engine.afterburner ?? 0) !== 0) return 'afterburner lit';
      if (s.flapsDeg < -1e-9 || s.flapsDeg > 20 + 1e-9 || s.gearPos < 0 || s.gearPos > 1) return 'flaps/gear out of range';
      if (s.time <= prev.time) return 'time did not advance';
      if (s.phase === 'crashed' && prev.phase === 'crashed' && (s.position.x !== prev.position.x || s.position.z !== prev.position.z)) return 'wreck moved';
    }
  }
  return null;
}

describe('A-10 fuzz: random pilots for 30 s', () => {
  it('from the runway', () => {
    fc.assert(fc.property(scriptArb, (script) => {
      const r = flyScript(createInitialState(RUNWAY_ENV, A10_CFG), script);
      if (r) throw new Error(r);
      return true;
    }), { numRuns: 20 });
  });

  it('from the approach', () => {
    fc.assert(fc.property(scriptArb, (script) => {
      const r = flyScript(createApproachState(RUNWAY_ENV, A10_CFG), script);
      if (r) throw new Error(r);
      return true;
    }), { numRuns: 20 });
  });

  it('from random airborne attitudes, rates and speeds', () => {
    const startArb = fc.record({
      altitudeM: fc.double({ min: 300, max: 6000, noNaN: true }),
      iasKt: fc.double({ min: 90, max: 440, noNaN: true }),
      headingDeg: fc.double({ min: 0, max: 360, noNaN: true }),
      pitchDeg: fc.double({ min: -80, max: 80, noNaN: true }),
      rollDeg: fc.double({ min: -180, max: 180, noNaN: true }),
      p: fc.double({ min: -2, max: 2, noNaN: true }),
      q: fc.double({ min: -1, max: 1, noNaN: true }),
      r: fc.double({ min: -1, max: 1, noNaN: true }),
    });
    fc.assert(fc.property(startArb, scriptArb, (x, script) => {
      const { state } = createTrimmedState({ altitudeM: x.altitudeM, iasKt: 250, gearDown: false }, FLAT_ENV, A10_CFG);
      const V = x.iasKt * KT_TO_MS * Math.sqrt(CONFIG.sim.seaLevelDensity / state.derived.density);
      const h = (x.headingDeg * Math.PI) / 180;
      const th = (x.pitchDeg * Math.PI) / 180;
      const s0: AircraftState = {
        ...state,
        orientation: quatFromEuler(x.headingDeg, x.pitchDeg, x.rollDeg),
        velocity: { x: Math.sin(h) * Math.cos(th) * V, y: Math.sin(th) * V, z: -Math.cos(h) * Math.cos(th) * V },
        angularVelocity: omegaFromPqr(x.p, x.q, x.r),
      };
      const r = flyScript(s0, script, FLAT_ENV);
      if (r) throw new Error(r);
      return true;
    }), { numRuns: 25 });
  });

  it('a random idle/brake/gear-handle sequence on the ramp never crashes it or bounces it off the gear', () => {
    fc.assert(fc.property(fc.array(fc.record({ brake: unit, parkingBrake: fc.boolean(), gearDown: fc.boolean(), rudder: signed, seconds: fc.double({ min: 0.2, max: 3, noNaN: true }) }), { minLength: 1, maxLength: 8 }), (segs) => {
      let s = createInitialState(RUNWAY_ENV, A10_CFG);
      for (const sg of segs) {
        const c: Controls = { throttle: 0, elevator: 0, aileron: 0, rudder: sg.rudder, elevatorTrim: 0, flapsNotch: 0, gearDown: sg.gearDown, brake: sg.brake, parkingBrake: sg.parkingBrake, engineOn: true };
        for (let i = 0; i < Math.round(sg.seconds / FIXED); i++) {
          s = step(s, c, FIXED, RUNWAY_ENV, A10_CFG);
          if (s.crash || !s.onGround || s.gearPos < 1 || Math.abs(s.derived.verticalSpeed) > 0.1) return false;
        }
      }
      return true;
    }), { numRuns: 25 });
  });
});
