/**
 * Bell 206 JetRanger property tests (fast-check): random control scripts — collective, cyclic,
 * pedals, trim, the engine switch and the stability assist — flown for 30 s from the runway, from a
 * hover, from cruise and from random attitudes, rates, speeds and rotor speeds. Whatever the pilot
 * does the state stays finite and physical: unit quaternion, bounded rates and rotor speed, valid
 * phases, the wreck stays put.
 */
import { describe, it, vi } from 'vitest';
import fc from 'fast-check';
import { CONFIG, KT_TO_MS } from '../../src/config';
import type { AircraftState, Controls } from '../../src/types';
import { createApproachState, createInitialState, step, FLAT_ENV } from '../../src/physics';
import { omegaFromPqr, quatFromEuler } from '../../src/physics/frames';
import { B206_CFG, NOMINAL_OMEGA, heliTrim } from './b206-helpers';
import { allFinite, RUNWAY_ENV } from './helpers';

vi.setConfig({ testTimeout: 120000 });

const FIXED = CONFIG.sim.fixedDt;
const A = B206_CFG.aircraft;
const PHASES = new Set(['ground', 'airborne', 'landed', 'crashed']);
const unit = fc.double({ min: 0, max: 1, noNaN: true });
const signed = fc.double({ min: -1, max: 1, noNaN: true });

const controlsArb: fc.Arbitrary<Controls> = fc.record({
  throttle: unit,
  elevator: signed,
  aileron: signed,
  rudder: signed,
  elevatorTrim: signed,
  flapsNotch: fc.constant(0),
  gearDown: fc.boolean(),
  brake: unit,
  parkingBrake: fc.boolean(),
  engineOn: fc.boolean(),
  stabilityAssist: fc.boolean(),
});
const scriptArb = fc.array(
  fc.record({ controls: controlsArb, seconds: fc.double({ min: 0.2, max: 6, noNaN: true }), dt: fc.double({ min: FIXED / 4, max: FIXED, noNaN: true }) }),
  { minLength: 3, maxLength: 20 },
);

function flyScript(s0: AircraftState, script: { controls: Controls; seconds: number; dt: number }[], env = RUNWAY_ENV): string | null {
  let s = s0;
  let t = 0;
  for (const seg of script) {
    const n = Math.max(1, Math.round(seg.seconds / seg.dt));
    for (let i = 0; i < n && t < 30; i++, t += seg.dt) {
      const prev = s;
      s = step(s, seg.controls, seg.dt, env, B206_CFG);
      if (!allFinite(s)) return `non-finite state at t=${s.time}`;
      const q = s.orientation;
      const qn = Math.hypot(q.x, q.y, q.z, q.w);
      if (Math.abs(qn - 1) > 1e-6) return `quaternion norm ${qn}`;
      if (!PHASES.has(s.phase)) return `phase ${s.phase}`;
      const w = s.angularVelocity;
      if (Math.max(Math.abs(w.x), Math.abs(w.y), Math.abs(w.z)) > A.limits.maxAngularRate + 1e-9) return 'angular rate past the clamp';
      if (!s.rotor) return 'rotor state lost';
      if (s.rotor.omega < 0 || s.rotor.omega > NOMINAL_OMEGA * 1.4 + 1e-9) return `rotor speed ${s.rotor.omega}`;
      if (s.rotor.enginePower < 0) return 'negative engine power (the freewheel drives only)';
      if (s.phase !== 'crashed' && s.derived.ias > A.limits.vneKt * A.limits.overspeedFailureFactor * KT_TO_MS * 1.05) return `IAS ${s.derived.ias} m/s`;
      if (s.gearPos !== 1) return 'fixed skids moved';
      if (s.time <= prev.time) return 'time did not advance';
      if (s.phase === 'crashed' && prev.phase === 'crashed' && (s.position.x !== prev.position.x || s.position.z !== prev.position.z)) return 'wreck moved';
    }
  }
  return null;
}

describe('JetRanger fuzz: random pilots for 30 s', () => {
  it('from the runway', () => {
    fc.assert(fc.property(scriptArb, (script) => {
      const r = flyScript(createInitialState(RUNWAY_ENV, B206_CFG), script);
      if (r) throw new Error(r);
      return true;
    }), { numRuns: 20 });
  });

  it('from the hover and the approach', () => {
    fc.assert(fc.property(scriptArb, fc.boolean(), (script, hover) => {
      const s0 = hover ? heliTrim({ altitudeM: 20 }).state : createApproachState(RUNWAY_ENV, B206_CFG);
      const r = flyScript(s0, script);
      if (r) throw new Error(r);
      return true;
    }), { numRuns: 20 });
  });

  it('from random airborne attitudes, rates, speeds and rotor speeds', () => {
    const startArb = fc.record({
      altitudeM: fc.double({ min: 100, max: 4000, noNaN: true }),
      iasKt: fc.double({ min: 0, max: 150, noNaN: true }),
      headingDeg: fc.double({ min: 0, max: 360, noNaN: true }),
      pitchDeg: fc.double({ min: -80, max: 80, noNaN: true }),
      rollDeg: fc.double({ min: -180, max: 180, noNaN: true }),
      p: fc.double({ min: -2, max: 2, noNaN: true }),
      q: fc.double({ min: -1, max: 1, noNaN: true }),
      r: fc.double({ min: -1, max: 1, noNaN: true }),
      nr: fc.double({ min: 0.3, max: 1.3, noNaN: true }),
    });
    fc.assert(fc.property(startArb, scriptArb, (x, script) => {
      const { state } = heliTrim({ altitudeM: x.altitudeM, iasKt: 60 });
      const V = x.iasKt * KT_TO_MS * Math.sqrt(CONFIG.sim.seaLevelDensity / state.derived.density);
      const h = (x.headingDeg * Math.PI) / 180;
      const th = (x.pitchDeg * Math.PI) / 180;
      const s0: AircraftState = {
        ...state,
        orientation: quatFromEuler(x.headingDeg, x.pitchDeg, x.rollDeg),
        velocity: { x: Math.sin(h) * Math.cos(th) * V, y: Math.sin(th) * V, z: -Math.cos(h) * Math.cos(th) * V },
        angularVelocity: omegaFromPqr(x.p, x.q, x.r),
        rotor: { ...state.rotor!, omega: NOMINAL_OMEGA * x.nr },
      };
      const r = flyScript(s0, script, FLAT_ENV);
      if (r) throw new Error(r);
      return true;
    }), { numRuns: 25 });
  });

  it('sitting on the ramp with the collective down, whatever the stick, switches and moderate pedals do, it stays put', () => {
    fc.assert(fc.property(fc.array(fc.record({ elevator: signed, aileron: signed, rudder: signed, engineOn: fc.boolean(), stabilityAssist: fc.boolean(), seconds: fc.double({ min: 0.2, max: 3, noNaN: true }) }), { minLength: 1, maxLength: 8 }), (segs) => {
      let s = createInitialState(RUNWAY_ENV, B206_CFG);
      const p0 = { ...s.position };
      for (const sg of segs) {
        const c: Controls = { throttle: 0, elevator: sg.elevator * 0.3, aileron: sg.aileron * 0.3, rudder: sg.rudder * 0.5, elevatorTrim: 0, flapsNotch: 0, gearDown: true, brake: 0, parkingBrake: false, engineOn: sg.engineOn, stabilityAssist: sg.stabilityAssist };
        for (let i = 0; i < Math.round(sg.seconds / FIXED); i++) {
          s = step(s, c, FIXED, RUNWAY_ENV, B206_CFG);
          if (s.crash || !s.onGround || Math.abs(s.derived.verticalSpeed) > 0.1) return false;
        }
      }
      return Math.hypot(s.position.x - p0.x, s.position.z - p0.z) < 0.5;
    }), { numRuns: 25 });
  });

  it('full pedal at flat pitch can only pivot it slowly on its skids (the tail rotor out-pulls the skid friction), never lift or tip it', () => {
    for (const rudder of [-1, 1]) {
      let s = createInitialState(RUNWAY_ENV, B206_CFG);
      let maxRate = 0;
      for (let i = 0; i < Math.round(5 / FIXED); i++) {
        s = step(s, { throttle: 0, elevator: 0, aileron: 0, rudder, elevatorTrim: 0, flapsNotch: 0, gearDown: true, brake: 0, parkingBrake: false, engineOn: true }, FIXED, RUNWAY_ENV, B206_CFG);
        maxRate = Math.max(maxRate, Math.abs(s.derived.r));
        if (s.crash || !s.onGround) throw new Error(`rudder ${rudder}: ${s.crash?.reason ?? 'left the ground'}`);
      }
      if ((maxRate * 180) / Math.PI > 45) throw new Error(`rudder ${rudder}: pivots at ${((maxRate * 180) / Math.PI).toFixed(0)} °/s`);
    }
  });
});
