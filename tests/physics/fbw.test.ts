/**
 * F-16 fly-by-wire: the pure layer (unit), the command laws in flight (g and roll-rate tracking,
 * neutral stick holds 1 g / attitude, bank compensation, AoA limiter, sideslip ≈ 0, gear-down
 * path hold) and a fuzz of random F-16 control sequences.
 */
import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { CONFIG, MS_TO_KT, M_TO_FT, RAD_TO_DEG } from '../../src/config';
import type { AircraftState, Controls } from '../../src/types';
import { applyFbw, createApproachState, approachControls, createInitialState, fbwCommands, step } from '../../src/physics';
import { bodyToWorld, omegaFromPqr, quatFromEuler, worldToBody } from '../../src/physics/frames';
import { allFinite, deepFreeze, DT, F16_CFG, fly, iasKt, RUNWAY_ENV, trimmed } from './helpers';

vi.setConfig({ testTimeout: 30000 });

const F = F16_CFG.aircraft.fbw!;
const cruise = (iasKt = 350, altitudeM = 3048) => {
  const t = trimmed({ altitudeM, iasKt, gearDown: false }, F16_CFG);
  return { state: t.state, controls: { ...t.controls, gearDown: false } as Controls };
};
const controls0: Controls = { throttle: 0, elevator: 0, aileron: 0, rudder: 0, elevatorTrim: 0, flapsNotch: 0, gearDown: true, brake: 0, parkingBrake: false, engineOn: true, speedBrake: false };
const flyF = (s: AircraftState, pilot: Controls | ((x: AircraftState) => Controls), seconds: number, each?: (x: AircraftState) => void) =>
  fly(s, pilot, seconds, { cfg: F16_CFG, each });

describe('fly-by-wire layer (unit)', () => {
  it('is pure: never mutates its inputs; passes every non-surface control through', () => {
    const { state, controls } = cruise();
    const s = deepFreeze(structuredClone(state));
    const c = deepFreeze({ ...controls, elevator: 0.4, aileron: -0.3, rudder: 0.2, throttle: 0.7, speedBrake: true, brake: 0.5 });
    const out = applyFbw(s, c, F16_CFG);
    expect(out).not.toBe(c);
    expect(out.throttle).toBe(0.7);
    expect(out.speedBrake).toBe(true);
    expect(out.brake).toBe(0.5);
    expect(out.gearDown).toBe(false);
    expect(applyFbw(s, c, F16_CFG)).toEqual(out); // deterministic
  });

  it('does nothing for an aircraft without fly-by-wire (the Cessna)', () => {
    const { state, controls } = trimmed();
    const c = { ...controls, elevator: 0.3 };
    expect(applyFbw(state, c, CONFIG)).toBe(c);
  });

  it('on the wheels: pitch-rate command with tail-strike protection; ailerons and rudder direct', () => {
    const { state, controls } = cruise();
    const still = { x: 0, y: 0, z: 0 };
    const onGround = (pitchDeg: number, q = 0): AircraftState => ({
      ...state, onGround: true, airborneTime: 0, angularVelocity: { ...still, x: q }, derived: { ...state.derived, pitchDeg },
    });
    expect(applyFbw(onGround(0), { ...controls, elevator: 0 }, F16_CFG).elevator).toBe(0);
    expect(applyFbw(onGround(0), { ...controls, elevator: 1 }, F16_CFG).elevator).toBeGreaterThan(0.8); // start the rotation
    // Rotating faster than commanded: the stabilator eases off.
    const fast = applyFbw(onGround(5, (2 * F.groundPitchRateDeg * Math.PI) / 180), { ...controls, elevator: 1 }, F16_CFG).elevator;
    expect(fast).toBeLessThan(0.5);
    // At the attitude limit the pull is cancelled (no tail strike), past it the nose is pushed down.
    expect(applyFbw(onGround(F.groundPitchLimitDeg + 1), { ...controls, elevator: 1 }, F16_CFG).elevator).toBeLessThan(0.3);
    const out = applyFbw(onGround(0), { ...controls, elevator: 0.8, aileron: -0.5, rudder: 0.3 }, F16_CFG);
    expect(out.aileron).toBe(-0.5);
    expect(out.rudder).toBe(0.3);
  });

  it('a keyboard pilot holding full aft stick through the take-off roll does not strike the tail', () => {
    let s = createInitialState(RUNWAY_ENV, F16_CFG);
    let maxPitchGround = 0;
    s = fly(s, (x) => ({ ...controls0, throttle: 1, elevator: iasKt(x) > 120 ? 1 : 0 }), 40, {
      cfg: F16_CFG, env: RUNWAY_ENV,
      each: (x) => { if (x.onGround) maxPitchGround = Math.max(maxPitchGround, x.derived.pitchDeg); },
      until: (x) => !!x.crash || x.airborneTime > 5,
    });
    expect(s.crash, s.crash?.reason).toBeNull();
    expect(maxPitchGround).toBeLessThan(F.groundPitchLimitDeg + 1);
  });

  it('commands: neutral stick = 1 g level (bank-compensated), full aft = 9 g, full forward = −3 g; the AoA limit caps the load at low speed', () => {
    const { state, controls } = cruise(450);
    expect(fbwCommands(state, controls, F16_CFG).nCmd).toBeCloseTo(1, 1);
    expect(fbwCommands(state, { ...controls, elevator: 1 }, F16_CFG).nCmd).toBeCloseTo(9, 1);
    expect(fbwCommands(state, { ...controls, elevator: -1 }, F16_CFG).nCmd).toBeCloseTo(-3, 1);
    const banked: AircraftState = { ...state, derived: { ...state.derived, rollDeg: 45 } };
    expect(fbwCommands(banked, controls, F16_CFG).nCmd).toBeCloseTo(Math.SQRT2, 1);
    const slow = cruise(200).state;
    const c = fbwCommands(slow, { ...controls, elevator: 1 }, F16_CFG);
    expect(c.alphaCmdDeg).toBeCloseTo(F.aoaLimitDeg, 3);
    expect(c.nCmd).toBeLessThan(5);
    expect(fbwCommands(state, { ...controls, aileron: 1 }, F16_CFG).pCmdDeg).toBeCloseTo(F.maxRollRateDeg, 0);
  });

  it('fuzz: any state and any (even hostile) inputs give finite surfaces in [−1, 1]', () => {
    const { state, controls } = cruise();
    const any = fc.oneof(fc.double({ noNaN: false }), fc.constantFrom(NaN, Infinity, -Infinity, 0, 1, -1));
    fc.assert(fc.property(
      any, any, any, fc.double({ min: 5, max: 700, noNaN: true }), fc.double({ min: -1.5, max: 1.5, noNaN: true }), fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
      fc.double({ min: -5, max: 5, noNaN: true }), fc.boolean(), fc.boolean(),
      (e, a, r, V, alpha, roll, rate, gear, ground) => {
        const s: AircraftState = {
          ...state,
          onGround: ground,
          angularVelocity: { x: rate, y: -rate / 2, z: rate / 3 },
          derived: { ...state.derived, tas: V, alpha, beta: alpha / 4, rollDeg: roll * RAD_TO_DEG, verticalSpeed: V * Math.sin(alpha / 2) },
        };
        const out = applyFbw(s, { ...controls, elevator: e, aileron: a, rudder: r, gearDown: gear }, F16_CFG);
        return [out.elevator, out.aileron, out.rudder].every((v) => Number.isFinite(v) && v >= -1 && v <= 1);
      },
    ), { numRuns: 500 });
  });
});

describe('fly-by-wire in flight', () => {
  it('neutral stick holds attitude at 1 g (20 s hands-off at 350 KIAS)', () => {
    const { state, controls } = cruise();
    let maxDn = 0;
    const s = flyF(state, controls, 20, (x) => { maxDn = Math.max(maxDn, Math.abs(x.derived.loadFactor - 1)); });
    expect(Math.abs(s.derived.pitchDeg - state.derived.pitchDeg)).toBeLessThan(1);
    expect(Math.abs(s.derived.rollDeg)).toBeLessThan(1);
    expect(maxDn).toBeLessThan(0.03);
    expect(Math.abs(s.position.y - state.position.y) * M_TO_FT).toBeLessThan(30);
  });

  it('keyboard roll: a short tap gives a small, controllable bank change; a full-rate roll stops soon after release', () => {
    const { state, controls } = cruise();
    // The input system ramps a held key toward full at controls.rollRate /s and back at returnRate /s.
    const up = CONFIG.controls.rollRate;
    const ret = CONFIG.controls.returnRate;
    const keyed = (release: (x: AircraftState) => boolean) => {
      let stick = 0;
      let releasedAt = Infinity;
      let stoppedAfter = Infinity;
      const s = flyF(state, (x) => {
        if (releasedAt === Infinity && release(x)) releasedAt = x.time;
        const rel = x.time >= releasedAt;
        stick = rel ? Math.max(0, stick - ret / 120) : Math.min(1, stick + up / 120);
        if (rel && stoppedAfter === Infinity && Math.abs(x.derived.p * RAD_TO_DEG) < 10) stoppedAfter = x.time - releasedAt;
        return { ...controls, aileron: stick };
      }, 4);
      return { s, stoppedAfter };
    };
    const tap = keyed((x) => x.time >= 0.15).s;
    expect(tap.derived.rollDeg).toBeGreaterThan(3);
    expect(tap.derived.rollDeg).toBeLessThan(25);
    const full = keyed((x) => x.derived.rollDeg >= 60);
    expect(Math.abs(full.s.derived.p * RAD_TO_DEG)).toBeLessThan(3);
    expect(full.s.derived.rollDeg, 'overshoot after releasing at full rate').toBeLessThan(130);
    expect(full.stoppedAfter).toBeLessThan(0.6);
  });

  it('bank compensation: roll to 40°, centre the stick — the jet turns level, holding the bank', () => {
    const { state, controls } = cruise();
    let s = flyF(state, (x) => ({ ...controls, aileron: Math.max(-1, Math.min(1, 0.02 * (40 - x.derived.rollDeg))) }), 4);
    const y0 = s.position.y;
    const h0 = s.derived.headingDeg;
    const bank0 = s.derived.rollDeg;
    expect(Math.abs(bank0 - 40)).toBeLessThan(3);
    s = flyF(s, { ...controls, aileron: 0 }, 10);
    expect(Math.abs(s.derived.rollDeg - bank0)).toBeLessThan(3);
    expect(Math.abs(s.position.y - y0) * M_TO_FT).toBeLessThan(100);
    expect(s.derived.headingDeg - h0).toBeGreaterThan(20);
  });

  it('tracks the g command: half stick ≈ 4 g (curved stick gradient), full stick ≈ 9 g without overshooting past 10 g', () => {
    const { state, controls } = cruise(480);
    const half = flyF(state, { ...controls, elevator: 0.5, throttle: 1 }, 1.5);
    const expected = 1 + (F.maxG - 1) * ((1 - F.pitchShaping) * 0.5 + F.pitchShaping * 0.25);
    expect(half.derived.loadFactor).toBeGreaterThan(expected - 0.4);
    expect(half.derived.loadFactor).toBeLessThan(expected + 0.4);
    let maxN = 0;
    let t85 = Infinity;
    flyF(state, { ...controls, elevator: 1, throttle: 1 }, 2.5, (x) => {
      maxN = Math.max(maxN, x.derived.loadFactor);
      if (t85 === Infinity && x.derived.loadFactor >= 8.5) t85 = x.time;
    });
    expect(t85, 'reaches 8.5 g within 1.5 s').toBeLessThan(1.5);
    expect(maxN).toBeGreaterThan(8.7);
    expect(maxN).toBeLessThan(10);
  });

  it('full forward stick gives about −3 g', () => {
    const { state, controls } = cruise(480);
    let minN = Infinity;
    flyF(state, { ...controls, elevator: -1 }, 2, (x) => { minN = Math.min(minN, x.derived.loadFactor); });
    expect(minN).toBeLessThan(-2.5);
    expect(minN).toBeGreaterThan(-3.6);
  });

  it('tracks the roll-rate command: full stick ≈ 300 °/s in < 1 s, half stick much less (curved gradient); sideslip stays small', () => {
    const { state, controls } = cruise();
    let tFull = Infinity;
    let maxP = 0;
    let maxBeta = 0;
    flyF(state, { ...controls, aileron: 1 }, 2, (x) => {
      const p = x.derived.p * RAD_TO_DEG;
      maxP = Math.max(maxP, p);
      maxBeta = Math.max(maxBeta, Math.abs(x.derived.beta * RAD_TO_DEG));
      if (tFull === Infinity && p > 270) tFull = x.time;
    });
    expect(tFull).toBeLessThan(1);
    expect(maxP).toBeLessThan(320);
    expect(maxBeta).toBeLessThan(3);
    const half = flyF(state, { ...controls, aileron: -0.5 }, 1);
    const want = -F.maxRollRateDeg * ((1 - F.rollShaping) * 0.5 + F.rollShaping * 0.125);
    expect(half.derived.p * RAD_TO_DEG).toBeLessThan(want + 12);
    expect(half.derived.p * RAD_TO_DEG).toBeGreaterThan(want - 12);
    expect(want).toBeGreaterThan(-120);
  });

  it('coordinates turns: a sustained 5 g turn keeps the sideslip under 1°', () => {
    const { state, controls } = cruise(450);
    let s = flyF(state, (x) => ({ ...controls, throttle: 1, aileron: x.derived.rollDeg < 75 ? 0.5 : 0 }), 2);
    let maxBeta = 0;
    s = flyF(s, (x) => ({ ...controls, throttle: 1, elevator: 0.5, aileron: Math.max(-1, Math.min(1, 0.01 * (78 - x.derived.rollDeg))) }), 6, (x) => {
      maxBeta = Math.max(maxBeta, Math.abs(x.derived.beta * RAD_TO_DEG));
    });
    expect(maxBeta).toBeLessThan(1);
    expect(s.crash).toBeNull();
  });

  it('AoA limiter: full aft stick at idle, slowing from 250 KIAS, parks at ~25° — no stall, no departure', () => {
    const { state, controls } = cruise(250, 5000);
    let maxA = 0;
    let stalled = false;
    let maxYaw = 0;
    const s = flyF(state, { ...controls, elevator: 1, throttle: 0 }, 25, (x) => {
      maxA = Math.max(maxA, x.derived.alpha * RAD_TO_DEG);
      if (x.stalled) stalled = true;
      maxYaw = Math.max(maxYaw, Math.abs(x.derived.r * RAD_TO_DEG));
    });
    expect(maxA).toBeGreaterThan(F.aoaLimitDeg - 1);
    expect(maxA).toBeLessThan(F.aoaLimitDeg + 1.5);
    expect(stalled).toBe(false);
    expect(maxYaw).toBeLessThan(10);
    expect(s.crash).toBeNull();
  });

  it('gear down: the AoA limit drops to the landing value, and neutral stick holds the glide path', () => {
    const env = undefined;
    const s0 = createApproachState(env, F16_CFG);
    const c = approachControls(F16_CFG);
    const gamma = (x: AircraftState) => Math.asin(x.velocity.y / Math.hypot(x.velocity.x, x.velocity.y, x.velocity.z)) * RAD_TO_DEG;
    const g0 = gamma(s0);
    const s = flyF(s0, c, 20);
    expect(Math.abs(gamma(s) - g0)).toBeLessThan(0.3);
    expect(Math.abs(iasKt(s) - iasKt(s0))).toBeLessThan(3);
    let maxA = 0;
    flyF(s0, { ...c, elevator: 1, throttle: 0 }, 8, (x) => { maxA = Math.max(maxA, x.derived.alpha * RAD_TO_DEG); });
    expect(maxA).toBeLessThan(F.aoaLimitGearDownDeg + 1.5);
  });
});

describe('F-16 departure resistance', () => {
  it('full roll while pulling to the AoA limit at 200 KIAS (roll coupling) keeps sideslip and α in hand (fuzz counterexample)', () => {
    const t = trimmed({ altitudeM: 6200, iasKt: 200, gearDown: false }, F16_CFG);
    let s = t.state;
    let maxBeta = 0;
    let maxA = 0;
    let minA = 0;
    s = flyF(s, { ...t.controls, gearDown: false, throttle: 0, elevator: 0.37, aileron: 1 }, 6, (x) => {
      maxBeta = Math.max(maxBeta, Math.abs(x.derived.beta * RAD_TO_DEG));
      maxA = Math.max(maxA, x.derived.alpha * RAD_TO_DEG);
      minA = Math.min(minA, x.derived.alpha * RAD_TO_DEG);
    });
    expect(maxBeta).toBeLessThan(10);
    expect(maxA).toBeLessThan(F.aoaLimitDeg + 2);
    expect(minA).toBeGreaterThan(-8);
    expect(s.crash).toBeNull();
    // Release: the jet settles back to wings-level-ish controllable flight.
    s = flyF(s, { ...t.controls, gearDown: false, throttle: 0.5, elevator: 0, aileron: 0 }, 5);
    expect(Math.abs(s.derived.beta * RAD_TO_DEG)).toBeLessThan(2);
    expect(Math.abs(s.derived.p * RAD_TO_DEG)).toBeLessThan(5);
  });
});

describe('F-16 structural limits', () => {
  it('the airframe fails past 13.5 g (only reachable with the fly-by-wire switched off) and past ~970 KIAS', () => {
    const noFbw = { ...F16_CFG, aircraft: { ...F16_CFG.aircraft, fbw: null } };
    const t = trimmed({ altitudeM: 1500, iasKt: 600, gearDown: false }, noFbw);
    const yank = fly(t.state, { ...t.controls, gearDown: false, elevator: 1 }, 5, { cfg: noFbw, until: (x) => x.phase === 'crashed' });
    expect(yank.crash?.reason).toContain('over-G');
    // With the FBW the same yank is a 9 g pull.
    const f = trimmed({ altitudeM: 1500, iasKt: 600, gearDown: false }, F16_CFG);
    const pull = flyF(f.state, { ...f.controls, gearDown: false, elevator: 1 }, 2);
    expect(pull.crash).toBeNull();
    // Full afterburner in a 60° dive from 800 KIAS: past Vne × 1.08 the airframe fails.
    const d = trimmed({ altitudeM: 8000, iasKt: 800, gearDown: false, flightPathDeg: -60 }, F16_CFG);
    const dive = flyF(d.state, (x) => ({ ...d.controls, gearDown: false, throttle: 1, elevator: 0 }), 60);
    expect(dive.crash?.reason).toContain('overspeed');
    expect(dive.crash!.speedKt).toBeGreaterThan(900);
  });
});

describe('fuzz: random F-16 control sequences', () => {
  it('never NaN; load factor, AoA, rates and speed stay within the jet\'s limits', () => {
    const unit = fc.double({ min: 0, max: 1, noNaN: true });
    const signed = fc.double({ min: -1, max: 1, noNaN: true });
    const seg = fc.record({
      elevator: signed, aileron: signed, rudder: signed, throttle: unit, speedBrake: fc.boolean(), gearDown: fc.boolean(),
      seconds: fc.double({ min: 0.2, max: 5, noNaN: true }),
    });
    const start = fc.record({
      iasKt: fc.double({ min: 200, max: 600, noNaN: true }),
      altitudeM: fc.double({ min: 3000, max: 12000, noNaN: true }),
      pitchDeg: fc.double({ min: -60, max: 60, noNaN: true }),
      rollDeg: fc.double({ min: -180, max: 180, noNaN: true }),
      p: fc.double({ min: -3, max: 3, noNaN: true }),
      q: fc.double({ min: -0.5, max: 0.5, noNaN: true }),
    });
    fc.assert(fc.property(start, fc.array(seg, { minLength: 2, maxLength: 12 }), (st, script) => {
      const t = trimmed({ altitudeM: st.altitudeM, iasKt: st.iasKt, gearDown: false }, F16_CFG);
      // Random attitude and rates; the velocity turns with the airframe (same α and β as the trim).
      const q = quatFromEuler(0, st.pitchDeg, st.rollDeg);
      const velocity = bodyToWorld(q, worldToBody(t.state.orientation, t.state.velocity));
      let s: AircraftState = { ...t.state, orientation: q, velocity, angularVelocity: omegaFromPqr(st.p, st.q, 0) };
      for (const g of script) {
        const c: Controls = { ...t.controls, ...g };
        for (let i = 0; i < Math.round(g.seconds / DT); i++) {
          s = step(s, c, DT, undefined, F16_CFG);
          if (!allFinite(s)) return false;
          if (s.phase === 'crashed') {
            // The only way to break a fly-by-wire jet up here is to dive it past the placard.
            return s.crash!.reason.includes('overspeed') || s.crash!.reason.includes('terrain');
          }
          const d = s.derived;
          if (d.loadFactor > 11 || d.loadFactor < -4.5) return false;
          if (d.ias * MS_TO_KT > 150 && Math.abs(d.alpha * RAD_TO_DEG) > 30) return false;
          const w = s.angularVelocity;
          if (Math.hypot(w.x, w.y, w.z) * RAD_TO_DEG > 420) return false;
        }
      }
      return true;
    }), { numRuns: 30, seed: process.env.FUZZ_SEED ? Number(process.env.FUZZ_SEED) : undefined });
  });

  it('from the runway: random throttle/AB, stick, pedals, brakes, gear and speed brake for up to 90 s never produce NaN', () => {
    const unit = fc.double({ min: 0, max: 1, noNaN: true });
    const signed = fc.double({ min: -1, max: 1, noNaN: true });
    const seg = fc.record({
      elevator: signed, aileron: signed, rudder: signed, throttle: unit, brake: unit, speedBrake: fc.boolean(), gearDown: fc.boolean(),
      flapsNotch: fc.integer({ min: 0, max: 2 }), seconds: fc.double({ min: 0.5, max: 12, noNaN: true }),
    });
    fc.assert(fc.property(fc.array(seg, { minLength: 2, maxLength: 10 }), (script) => {
      let s = createInitialState(RUNWAY_ENV, F16_CFG);
      for (const g of script) {
        const c: Controls = { throttle: g.throttle, elevator: g.elevator, aileron: g.aileron, rudder: g.rudder,
          elevatorTrim: 0, flapsNotch: g.flapsNotch, gearDown: g.gearDown, brake: g.brake, parkingBrake: false, engineOn: true, speedBrake: g.speedBrake };
        for (let i = 0; i < Math.round(g.seconds / DT); i++) {
          s = step(s, c, DT, RUNWAY_ENV, F16_CFG);
          if (!allFinite(s)) return false;
          if (s.phase === 'crashed') return true;
          if (s.derived.loadFactor > 11 || s.derived.loadFactor < -4.5) return false;
        }
      }
      return true;
    }), { numRuns: 20, seed: process.env.FUZZ_SEED ? Number(process.env.FUZZ_SEED) : undefined });
  });
});
