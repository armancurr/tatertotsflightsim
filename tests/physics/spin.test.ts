/**
 * Spins (Cessna 172RG): entry from a full-aft, full-rudder stall at idle, the developed spin,
 * the PARE recovery, and the difference between a spin and a spiral dive. Plus the wing-drop
 * behaviour of coordinated vs skidding stalls, and a fuzz of random high-α control sequences.
 *
 * "Spin rate" is the rotation about the vertical (world) axis — what a pilot times as
 * "seconds per turn" — positive when the aircraft turns clockwise seen from above (right).
 */
import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { M_TO_FT, MS_TO_KT, RAD_TO_DEG } from '../../src/config';
import type { AircraftState, Controls } from '../../src/types';
import { bodyToWorld, omegaFromPqr, quatFromEuler } from '../../src/physics/frames';
import { step } from '../../src/physics';
import { allFinite, bankHold, fly, iasKt, trimmed, DT } from './helpers';

vi.setConfig({ testTimeout: 30000 });

/** Rotation rate about the world vertical, deg/s (+ = clockwise seen from above = turning right). */
export const spinRate = (s: AircraftState): number => -bodyToWorld(s.orientation, s.angularVelocity).y * RAD_TO_DEG;

interface SpinEntry {
  state: AircraftState;
  controls: Controls;
  /** Seconds from the stall until the aircraft rolls AND yaws toward the rudder at > 60 °/s (autorotation). */
  incipientS: number;
  /** Seconds from the stall until the rotation about the vertical exceeds 90 °/s. */
  rotatingS: number;
}

/** Idle, full aft yoke until the break, then full rudder `dir` (+1 right), ailerons neutral; fly 6 s. */
function enterSpin(dir: 1 | -1, altitudeM = 3000): SpinEntry {
  const { state, controls } = trimmed({ altitudeM, iasKt: 65, gearDown: false });
  let s = fly(state, { ...controls, throttle: 0, elevator: 1 }, 30, { until: (x) => x.stalled });
  expect(s.stalled).toBe(true);
  const pro: Controls = { ...controls, throttle: 0, elevator: 1, rudder: dir, aileron: 0 };
  const t0 = s.time;
  let incipient = Infinity;
  let rotating = Infinity;
  s = fly(s, pro, 6, {
    each: (x) => {
      if (incipient === Infinity && dir * x.derived.p * RAD_TO_DEG > 60 && dir * x.derived.r * RAD_TO_DEG > 60) incipient = x.time - t0;
      if (rotating === Infinity && dir * spinRate(x) > 90) rotating = x.time - t0;
    },
  });
  return { state: s, controls: pro, incipientS: incipient, rotatingS: rotating };
}

interface SpinStats {
  meanRate: number;
  minRate: number;
  meanPitch: number;
  minIas: number;
  maxIas: number;
  ftPerTurn: number;
  secPerTurn: number;
  alwaysStalled: boolean;
  alwaysLabelStalled: boolean;
  end: AircraftState;
}

/** Hold the controls for `seconds` and summarise the motion (rate signed by `dir`). */
function spinStats(s0: AircraftState, c: Controls, seconds: number, dir: number): SpinStats {
  let n = 0, rate = 0, minRate = Infinity, pitch = 0, minIas = Infinity, maxIas = 0;
  let alwaysStalled = true;
  let turned = 0;
  const y0 = s0.position.y;
  const end = fly(s0, c, seconds, {
    each: (x) => {
      const r = dir * spinRate(x);
      n++; rate += r; minRate = Math.min(minRate, r); pitch += x.derived.pitchDeg;
      minIas = Math.min(minIas, iasKt(x)); maxIas = Math.max(maxIas, iasKt(x));
      turned += r * DT;
      if (!x.stalled || x.phase !== 'airborne') alwaysStalled = false;
    },
  });
  const turns = turned / 360;
  return {
    meanRate: rate / n,
    minRate,
    meanPitch: pitch / n,
    minIas,
    maxIas,
    ftPerTurn: ((y0 - end.position.y) * M_TO_FT) / turns,
    secPerTurn: seconds / turns,
    alwaysStalled,
    alwaysLabelStalled: alwaysStalled,
    end,
  };
}

describe('spin entry and the developed spin', () => {
  for (const dir of [1, -1] as const) {
    const side = dir > 0 ? 'right' : 'left';
    it(`full aft yoke + full ${side} rudder at the stall (idle): incipient spin in 1–3 s, then a developed ${side} spin`, () => {
      const e = enterSpin(dir);
      expect(e.incipientS, 'incipient spin: rolling and yawing toward the rudder within 3 s of the stall').toBeLessThan(3);
      expect(e.incipientS).toBeGreaterThan(0.3);
      expect(e.rotatingS, 'turning about the vertical at > 90 °/s within 6 s').toBeLessThan(6);
      const st = spinStats(e.state, e.controls, 12, dir);
      expect(st.meanRate, 'spin rate °/s (toward the rudder)').toBeGreaterThan(150);
      expect(st.meanRate).toBeLessThan(250);
      expect(st.minRate, 'keeps rotating the same way').toBeGreaterThan(60);
      expect(st.meanPitch, 'nose 40–70° down').toBeLessThan(-40);
      expect(st.meanPitch).toBeGreaterThan(-70);
      expect(st.minIas, 'airspeed stays low').toBeGreaterThan(35);
      expect(st.maxIas, 'airspeed does not build like a spiral').toBeLessThan(78);
      expect(st.ftPerTurn, 'altitude lost per turn').toBeGreaterThan(200);
      expect(st.ftPerTurn).toBeLessThan(350);
      expect(st.alwaysStalled, "state stays 'stalled' throughout").toBe(true);
      expect(st.end.crash).toBeNull();
    });
  }

  it('holding pro-spin controls keeps it spinning (≥ 6 more turns, rate steady)', () => {
    const e = enterSpin(1, 4000);
    const a = spinStats(e.state, e.controls, 10, 1);
    const b = spinStats(a.end, e.controls, 10, 1);
    expect(b.meanRate).toBeGreaterThan(150);
    expect(Math.abs(b.meanRate - a.meanRate)).toBeLessThan(40);
    expect(b.alwaysStalled).toBe(true);
  });
});

/** PARE: idle, ailerons neutral, full opposite rudder, then (after `pushDelay` s) forward elevator. */
function recover(s0: AircraftState, base: Controls, dir: number, pushDelay = 0.6) {
  const t0 = s0.time;
  let turned = 0;
  let stoppedAt: AircraftState | null = null;
  const s = fly(s0, (x) => ({ ...base, throttle: 0, aileron: 0, rudder: -dir, elevator: x.time - t0 > pushDelay ? -0.4 : 1 }), 12, {
    each: (x) => {
      turned += Math.abs(spinRate(x)) * DT;
      if (!stoppedAt && Math.abs(spinRate(x)) < 20) stoppedAt = x;
    },
    until: (x) => Math.abs(spinRate(x)) < 20 && !x.stalled,
  });
  return { s, turns: turned / 360, stoppedAt: stoppedAt as AircraftState | null };
}

describe('spin recovery (PARE)', () => {
  for (const dir of [1, -1] as const) {
    it(`${dir > 0 ? 'right' : 'left'} spin: opposite rudder + forward elevator stop the rotation within 1.5 turns; then the pilot pulls out`, () => {
      const e = enterSpin(dir, 3000);
      const dev = fly(e.state, e.controls, 4); // developed
      const r = recover(dev, e.controls, dir);
      expect(r.stoppedAt, 'rotation stops').not.toBeNull();
      expect(r.turns, 'turns to stop').toBeLessThan(1.5);
      expect(r.s.stalled, 'unstalled after the push').toBe(false);
      // Pull out of the dive: rudder neutral, wings level, ≤ 3.5 g, power when the nose is up.
      const yStart = r.s.position.y;
      let minY = yStart;
      let maxG = 0;
      const pull = (x: AircraftState) => {
        const target = x.derived.loadFactor > 3.2 ? 0.1 : 0.9;
        return Math.max(-0.3, Math.min(target, 0.06 * (5 - x.derived.pitchDeg) - 0.03 * x.derived.q * RAD_TO_DEG));
      };
      const s = fly(r.s, (x) => ({
        ...e.controls, rudder: 0, aileron: bankHold(x, 0), elevator: pull(x), throttle: x.derived.pitchDeg > 0 ? 1 : 0,
      }), 20, { each: (x) => { minY = Math.min(minY, x.position.y); maxG = Math.max(maxG, x.derived.loadFactor); } });
      expect(s.crash).toBeNull();
      expect(s.stalled).toBe(false);
      expect(Math.abs(s.derived.pitchDeg)).toBeLessThan(20);
      expect(Math.abs(s.derived.rollDeg)).toBeLessThan(20);
      expect(maxG).toBeLessThan(4.4);
      expect((yStart - minY) * M_TO_FT, 'pull-out height loss').toBeLessThan(900);
    });
  }
});

describe('stall behaviour', () => {
  it('a coordinated power-off stall breaks straight: nose drops, wings stay near level, releasing back pressure recovers', () => {
    const { state, controls } = trimmed({ altitudeM: 2000, iasKt: 65, gearDown: false });
    let maxPitch = -Infinity;
    let minPitchAfter = Infinity;
    let maxBank = 0;
    let headingSpan = 0;
    const h0 = state.derived.headingDeg;
    let s = fly(state, { ...controls, throttle: 0, elevator: 1 }, 30, { until: (x) => x.stalled, each: (x) => { maxPitch = Math.max(maxPitch, x.derived.pitchDeg); } });
    s = fly(s, { ...controls, throttle: 0, elevator: 1 }, 6, {
      each: (x) => {
        minPitchAfter = Math.min(minPitchAfter, x.derived.pitchDeg);
        maxBank = Math.max(maxBank, Math.abs(x.derived.rollDeg));
        headingSpan = Math.max(headingSpan, Math.abs(((x.derived.headingDeg - h0 + 540) % 360) - 180));
      },
    });
    expect(minPitchAfter, 'the nose drops').toBeLessThan(maxPitch - 8);
    expect(maxBank, 'minimal wing drop').toBeLessThan(5);
    expect(headingSpan, 'straight ahead').toBeLessThan(5);
    // Release back pressure: unstalled within ~2 s.
    const t = s.time;
    s = fly(s, (x) => ({ ...controls, throttle: 0, elevator: 0, aileron: bankHold(x, 0) }), 6, { until: (x) => !x.stalled });
    expect(s.stalled).toBe(false);
    expect(s.time - t).toBeLessThan(2.5);
  });

  for (const dir of [1, -1] as const) {
    it(`a skidding stall (${dir > 0 ? 'right' : 'left'} rudder in a turn, the base-to-final stall) drops the inside wing toward the rudder`, () => {
      const { state, controls } = trimmed({ altitudeM: 1500, iasKt: 70, gearDown: true, flapsNotch: 1 });
      // Base-to-final: a 20° bank turn toward `dir`, skidded round with inside rudder, top aileron to stop the
      // overbanking, and a steadily tightening pull at low power.
      const t0 = state.time;
      const skid = (x: AircraftState): Controls => ({
        ...controls, throttle: 0.15, aileron: bankHold(x, 20 * dir), rudder: 0.5 * dir, elevator: Math.min(1, 0.2 + 0.12 * (x.time - t0)),
      });
      let s = fly(state, skid, 20, { until: (x) => x.stalled });
      expect(s.stalled).toBe(true);
      let maxBankTowardRudder = 0;
      s = fly(s, skid, 3, { each: (x) => { maxBankTowardRudder = Math.max(maxBankTowardRudder, dir * x.derived.rollDeg); } });
      expect(maxBankTowardRudder, 'the inside wing drops').toBeGreaterThan(60);
    });
  }
});

describe('spin vs spiral dive', () => {
  it('a spiral dive builds airspeed (> 110 KIAS) with the wing flying; a spin keeps the airspeed low with the wing stalled', () => {
    const { state, controls } = trimmed({ altitudeM: 3000, iasKt: 90, gearDown: false });
    // Spiral: steep bank with a little back pressure, power at cruise — the nose drops, the speed builds.
    let maxIas = 0;
    let stalledSeen = false;
    fly(state, (x) => ({ ...controls, aileron: bankHold(x, 70), elevator: 0.15 }), 15, {
      each: (x) => { maxIas = Math.max(maxIas, iasKt(x)); if (x.stalled) stalledSeen = true; },
    });
    expect(maxIas).toBeGreaterThan(110);
    expect(stalledSeen).toBe(false);
    const e = enterSpin(1);
    const st = spinStats(e.state, e.controls, 8, 1);
    expect(st.maxIas).toBeLessThan(78);
    expect(st.alwaysStalled).toBe(true);
  });
});

describe('fuzz: random controls at high angle of attack', () => {
  it('never produce NaN or unbounded rotation (rates stay ≤ 400 °/s, IAS bounded)', () => {
    const unit = fc.double({ min: 0, max: 1, noNaN: true });
    const signed = fc.double({ min: -1, max: 1, noNaN: true });
    const seg = fc.record({ elevator: signed, aileron: signed, rudder: signed, throttle: unit, seconds: fc.double({ min: 0.3, max: 4, noNaN: true }) });
    const start = fc.record({
      pitchDeg: fc.double({ min: -30, max: 60, noNaN: true }),
      rollDeg: fc.double({ min: -90, max: 90, noNaN: true }),
      p: fc.double({ min: -3, max: 3, noNaN: true }),
      r: fc.double({ min: -2, max: 2, noNaN: true }),
      iasKt: fc.double({ min: 45, max: 70, noNaN: true }),
    });
    fc.assert(
      fc.property(start, fc.array(seg, { minLength: 3, maxLength: 12 }), (st, script) => {
        const { state, controls } = trimmed({ altitudeM: 3500, iasKt: st.iasKt, gearDown: false });
        let s: AircraftState = { ...state, orientation: quatFromEuler(0, st.pitchDeg, st.rollDeg), angularVelocity: omegaFromPqr(st.p, 0, st.r) };
        for (const g of script) {
          const c = { ...controls, elevator: Math.max(g.elevator, 0.5), aileron: g.aileron, rudder: g.rudder, throttle: g.throttle };
          const n = Math.round(g.seconds / DT);
          for (let i = 0; i < n && s.phase !== 'crashed'; i++) {
            s = step(s, c, DT);
            if (!allFinite(s)) return false;
            const w = s.angularVelocity;
            if (Math.hypot(w.x, w.y, w.z) * RAD_TO_DEG > 400) return false;
            if (s.derived.ias * MS_TO_KT > 250) return false;
          }
        }
        return true;
      }),
      { numRuns: 25, seed: process.env.FUZZ_SEED ? Number(process.env.FUZZ_SEED) : undefined },
    );
  });
});
