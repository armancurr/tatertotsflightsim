/**
 * Stall conditions and stall recovery.
 */
import { describe, it, expect } from 'vitest';
import { CONFIG, RAD_TO_DEG } from '../../src/config';
import type { AircraftState } from '../../src/types';
import { simStateLabel, liftCoefficient, stallAlphaRad } from '../../src/physics';
import { fly, trimmed, iasKt, altitudeHold, bankHold } from './helpers';

/** Idle power, hold altitude with the elevator until the wing stalls; returns the IAS at the break. */
function stallSpeed(flapsNotch: number, startKt: number): { kt: number; s: AircraftState } {
  const { state, controls } = trimmed({ altitudeM: 1500, iasKt: startKt, flapsNotch, gearDown: false });
  let at: AircraftState | null = null;
  fly(state, (s) => ({ ...controls, throttle: 0, elevator: Math.min(1, altitudeHold(s, 1500) * 1.5), aileron: bankHold(s, 0) }), 60, {
    until: (s) => {
      if (s.stalled) at = s;
      return s.stalled;
    },
  });
  expect(at).not.toBeNull();
  return { kt: iasKt(at!), s: at! };
}

describe('stall conditions', () => {
  it('flying normally is not a stall', () => {
    const { state, controls } = trimmed({ altitudeM: 1500, iasKt: 80 });
    const s = fly(state, controls, 5);
    expect(s.stalled).toBe(false);
    expect(simStateLabel(s)).toBe('airborne');
  });

  it('full aft yoke at idle stalls: stalled flag, label "stalled", CL falls past the peak, the nose drops', () => {
    const { state, controls } = trimmed({ altitudeM: 1500, iasKt: 70 });
    let stallAt: AircraftState | null = null;
    let maxPitch = -Infinity;
    let pitchAfter = Infinity;
    let minClRatio = Infinity;
    fly(state, { ...controls, throttle: 0, elevator: 1 }, 20, {
      each: (s) => {
        if (!stallAt) {
          maxPitch = Math.max(maxPitch, s.derived.pitchDeg);
          if (s.stalled) stallAt = s;
        } else {
          pitchAfter = Math.min(pitchAfter, s.derived.pitchDeg);
          const clMax = liftCoefficient(stallAlphaRad(s.flapsDeg), s.flapsDeg);
          minClRatio = Math.min(minClRatio, liftCoefficient(s.derived.alpha, s.flapsDeg) / clMax);
        }
      },
    });
    expect(stallAt).not.toBeNull();
    const st = stallAt!;
    expect(st.derived.alpha).toBeGreaterThan(stallAlphaRad(st.flapsDeg));
    expect(simStateLabel(st)).toBe('stalled');
    expect(minClRatio).toBeLessThan(0.9); // lift has collapsed
    expect(pitchAfter).toBeLessThan(maxPitch - 8); // the nose drops through
  });

  it(`clean stall at ≈ Vs1 (${CONFIG.aircraft.limits.vs1Kt} KIAS): between 44 and 54 KIAS`, () => {
    const { kt } = stallSpeed(0, 75);
    expect(kt).toBeGreaterThan(44);
    expect(kt).toBeLessThan(54);
  });

  it(`full-flap stall at ≈ Vs0 (${CONFIG.aircraft.limits.vsoKt} KIAS): between 36 and 47 KIAS`, () => {
    const { kt } = stallSpeed(3, 65);
    expect(kt).toBeGreaterThan(36);
    expect(kt).toBeLessThan(47);
    expect(kt).toBeLessThan(stallSpeed(0, 75).kt - 3);
  });

  it('a coordinated stall breaks straight; a stall with full rudder drops a wing', () => {
    const run = (rudder: number) => {
      const { state, controls } = trimmed({ altitudeM: 2000, iasKt: 70 });
      let maxRoll = 0;
      let stalledFor = 0;
      fly(state, { ...controls, throttle: 0, elevator: 1, rudder }, 14, {
        each: (s) => {
          if (s.stalled) stalledFor += 1 / 120;
          if (stalledFor > 0) maxRoll = Math.max(maxRoll, Math.abs(s.derived.rollDeg));
        },
      });
      return maxRoll;
    };
    expect(run(0)).toBeLessThan(10);
    expect(run(1)).toBeGreaterThan(30);
  });

  it('the stalled flag clears only after alpha falls below stall − hysteresis', () => {
    const { kt, s } = stallSpeed(0, 70);
    expect(kt).toBeGreaterThan(0);
    const aStall = stallAlphaRad(0);
    const hyst = (CONFIG.aircraft.stall.recoveryHysteresisDeg * Math.PI) / 180;
    // Step forward with the yoke still back: while alpha stays between stall−hyst and stall, it stays stalled.
    let sawBand = false;
    fly(s, { ...trimmed({ iasKt: 70 }).controls, throttle: 0, elevator: 0.1 }, 4, {
      each: (x) => {
        if (x.derived.alpha < aStall && x.derived.alpha > aStall - hyst + 0.002 && x.phase === 'airborne') {
          sawBand = true;
          expect(x.stalled).toBe(true);
        }
        if (x.derived.alpha < aStall - hyst - 0.002) expect(x.stalled).toBe(false);
      },
    });
    expect(sawBand).toBe(true);
  });
});

describe('stall recovery', () => {
  it('push + full power recovers within ~4 s, losing < 150 m, then climbs away', () => {
    const { state, controls } = trimmed({ altitudeM: 1500, iasKt: 70 });
    // Stall it and hold it stalled for 2 s.
    let s = fly(state, { ...controls, throttle: 0, elevator: 1 }, 30, { until: (s) => s.stalled });
    expect(s.stalled).toBe(true);
    s = fly(s, { ...controls, throttle: 0, elevator: 1 }, 2);
    expect(s.stalled).toBe(true);
    const yStart = s.position.y;
    const tStart = s.time;
    // Recover: release back pressure (push), full power, wings level.
    let minY = s.position.y;
    s = fly(s, (x) => ({ ...controls, throttle: 1, elevator: -0.3, aileron: bankHold(x, 0) }), 6, {
      until: (x) => !x.stalled && x.derived.alpha < stallAlphaRad(0) - 0.1,
      each: (x) => { minY = Math.min(minY, x.position.y); },
    });
    expect(s.stalled).toBe(false);
    expect(s.time - tStart).toBeLessThan(4);
    // Pull out of the dive gently (≤ 2 g) and climb away holding a climb attitude of 8°.
    const climbOut = (x: AircraftState) =>
      x.derived.loadFactor > 2 ? 0 : Math.max(-0.6, Math.min(0.8, 0.08 * (8 - x.derived.pitchDeg) - 0.05 * x.derived.q * RAD_TO_DEG));
    s = fly(s, (x) => ({ ...controls, throttle: 1, elevator: climbOut(x), aileron: bankHold(x, 0), rudder: 0.05 }), 25, {
      each: (x) => { minY = Math.min(minY, x.position.y); },
    });
    expect(yStart - minY).toBeLessThan(150);
    expect(s.stalled).toBe(false);
    expect(s.velocity.y).toBeGreaterThan(0.5);
    expect(s.position.y).toBeGreaterThan(minY + 20);
    expect(Math.abs(s.derived.rollDeg)).toBeLessThan(15);
    expect(s.derived.alpha * RAD_TO_DEG).toBeLessThan(12);
  });
});
