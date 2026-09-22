/**
 * Heading, pitch, roll and yaw: the rotational response to the controls.
 */
import { describe, it, expect } from 'vitest';
import { RAD_TO_DEG } from '../../src/config';
import { createInitialState, defaultControls } from '../../src/physics';
import { quatFromEuler } from '../../src/physics/frames';
import { fly, trimmed, bankHold, iasKt, headingError } from './helpers';

describe('heading', () => {
  it('a right bank turns the aircraft right (heading increases)', () => {
    const { state, controls } = trimmed({ altitudeM: 1500, iasKt: 90, headingDeg: 90 });
    const s = fly(state, (s) => ({ ...controls, aileron: bankHold(s, 25), elevator: 0.06 }), 10);
    expect(headingError(s, 90)).toBeGreaterThan(20);
    expect(s.derived.r).toBeGreaterThan(0);
  });

  it('a left bank turns the aircraft left (heading decreases)', () => {
    const { state, controls } = trimmed({ altitudeM: 1500, iasKt: 90, headingDeg: 90 });
    const s = fly(state, (s) => ({ ...controls, aileron: bankHold(s, -25), elevator: 0.06 }), 10);
    expect(headingError(s, 90)).toBeLessThan(-20);
    expect(s.derived.r).toBeLessThan(0);
  });

  it('wraps through north cleanly (heading stays in 0..360)', () => {
    const { state, controls } = trimmed({ altitudeM: 1500, iasKt: 90, headingDeg: 350 });
    const s = fly(state, (s) => ({ ...controls, aileron: bankHold(s, 25), elevator: 0.06 }), 8, {
      each: (s) => {
        expect(s.derived.headingDeg).toBeGreaterThanOrEqual(0);
        expect(s.derived.headingDeg).toBeLessThan(360);
      },
    });
    expect(s.derived.headingDeg).toBeGreaterThan(5);
    expect(s.derived.headingDeg).toBeLessThan(180);
  });
});

describe('pitch', () => {
  it('pulling the yoke raises the nose', () => {
    const { state, controls } = trimmed({ altitudeM: 1500, iasKt: 95 });
    const s = fly(state, { ...controls, elevator: 0.4 }, 1);
    expect(s.derived.q).toBeGreaterThan(0);
    expect(s.derived.pitchDeg).toBeGreaterThan(state.derived.pitchDeg + 3);
    expect(s.derived.loadFactor).toBeGreaterThan(1.3);
  });

  it('pushing the yoke lowers the nose', () => {
    const { state, controls } = trimmed({ altitudeM: 1500, iasKt: 95 });
    const s = fly(state, { ...controls, elevator: -0.4 }, 1);
    expect(s.derived.q).toBeLessThan(0);
    expect(s.derived.pitchDeg).toBeLessThan(state.derived.pitchDeg - 3);
    expect(s.derived.loadFactor).toBeLessThan(0.7);
  });

  it('nose-up trim raises the nose hands-off; the aircraft is statically stable in pitch', () => {
    const { state, controls } = trimmed({ altitudeM: 1500, iasKt: 95 });
    const up = fly(state, { ...controls, elevatorTrim: controls.elevatorTrim + 0.3 }, 2);
    expect(up.derived.pitchDeg).toBeGreaterThan(state.derived.pitchDeg + 1);
    // A 1-second pull and release: the pitch rate dies away rather than diverging.
    let s = fly(state, { ...controls, elevator: 0.3 }, 1);
    s = fly(s, controls, 4);
    expect(Math.abs(s.derived.q * RAD_TO_DEG)).toBeLessThan(3);
  });
});

describe('roll', () => {
  it('right aileron rolls right, left aileron rolls left', () => {
    const { state, controls } = trimmed({ altitudeM: 1500, iasKt: 90 });
    const r = fly(state, { ...controls, aileron: 0.5 }, 1);
    expect(r.derived.p).toBeGreaterThan(0);
    expect(r.derived.rollDeg).toBeGreaterThan(10);
    const l = fly(state, { ...controls, aileron: -0.5 }, 1);
    expect(l.derived.p).toBeLessThan(0);
    expect(l.derived.rollDeg).toBeLessThan(-10);
  });

  it('full aileron at ~90 kt gives a plausible maximum roll rate (30–90 °/s)', () => {
    const { state, controls } = trimmed({ altitudeM: 1500, iasKt: 90 });
    let maxP = 0;
    fly(state, { ...controls, aileron: 1 }, 1.5, { each: (s) => { maxP = Math.max(maxP, s.derived.p * RAD_TO_DEG); } });
    expect(maxP).toBeGreaterThan(30);
    expect(maxP).toBeLessThan(90);
  });

  it('roll is damped: releasing the aileron stops the roll (the bank stays put, no runaway)', () => {
    const { state, controls } = trimmed({ altitudeM: 1500, iasKt: 90 });
    let s = fly(state, { ...controls, aileron: 0.6 }, 0.8);
    const rateBefore = s.derived.p * RAD_TO_DEG;
    const bank = s.derived.rollDeg;
    expect(rateBefore).toBeGreaterThan(15);
    let maxBank = -Infinity;
    s = fly(s, controls, 0.3, { each: (x) => { maxBank = Math.max(maxBank, x.derived.rollDeg); } });
    // The roll stops almost at once: a few degrees of overshoot at most.
    expect(maxBank).toBeLessThan(bank + 6);
    expect(s.derived.p * RAD_TO_DEG).toBeLessThan(0.2 * rateBefore);
    // No runaway afterwards (only the gentle sideslip/Dutch-roll coupling of an uncoordinated roll).
    let maxRate = 0;
    s = fly(s, controls, 4, {
      each: (x) => {
        maxRate = Math.max(maxRate, Math.abs(x.derived.p * RAD_TO_DEG));
        expect(Math.abs(x.derived.rollDeg - bank)).toBeLessThan(10);
      },
    });
    expect(maxRate).toBeLessThan(0.6 * rateBefore);
  });
});

describe('yaw', () => {
  it('right rudder yaws the nose right and makes sideslip (air from the left)', () => {
    const { state, controls } = trimmed({ altitudeM: 1500, iasKt: 90 });
    const s = fly(state, { ...controls, rudder: 0.6 }, 1);
    expect(s.derived.r).toBeGreaterThan(0);
    expect(s.derived.beta * RAD_TO_DEG).toBeLessThan(-1);
    expect(headingError(s, 0)).toBeGreaterThan(0.5);
  });

  it('left rudder yaws the nose left with positive sideslip', () => {
    const { state, controls } = trimmed({ altitudeM: 1500, iasKt: 90 });
    const s = fly(state, { ...controls, rudder: -0.6 }, 1);
    expect(s.derived.r).toBeLessThan(0);
    expect(s.derived.beta * RAD_TO_DEG).toBeGreaterThan(1);
  });

  it('the aircraft weathervanes: released rudder lets the sideslip die out', () => {
    const { state, controls } = trimmed({ altitudeM: 1500, iasKt: 90 });
    let s = fly(state, { ...controls, rudder: 0.6 }, 1.5);
    s = fly(s, (s) => ({ ...controls, aileron: bankHold(s, 0) }), 6);
    expect(Math.abs(s.derived.beta * RAD_TO_DEG)).toBeLessThan(1);
  });

  it('on the ground, rudder steers the nosewheel', () => {
    let s = fly(createInitialState(), { ...defaultControls(), throttle: 0.5 }, 6);
    const h0 = s.derived.headingDeg;
    s = fly(s, { ...defaultControls(), throttle: 0.3, rudder: 1 }, 3);
    expect(s.phase).toBe('ground');
    expect(headingError(s, h0)).toBeGreaterThan(10);
    expect(iasKt(s)).toBeLessThan(40);
  });

  it('a turn stays near-coordinated with a touch of rudder', () => {
    const { state, controls } = trimmed({ altitudeM: 1500, iasKt: 90 });
    const s = fly({ ...state, orientation: quatFromEuler(0, state.derived.pitchDeg, 0) }, (s) => ({
      ...controls, aileron: bankHold(s, 20), elevator: 0.04, rudder: 0.05,
    }), 8);
    expect(Math.abs(s.derived.beta * RAD_TO_DEG)).toBeLessThan(3);
  });
});
