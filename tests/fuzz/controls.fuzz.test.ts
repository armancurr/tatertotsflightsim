/**
 * Property tests for the pure control system (src/input/controlSystem.ts):
 * random input-frame sequences — random held key sets (conflicting keys
 * included), random key presses (with and without Shift), random mouse and
 * gamepad input including hostile numbers, random frame times including 0 and
 * the 0.25 s clamp — must always produce sane Controls.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  boundKeyCodes, createControlState, emptyInputFrame, resetControls, updateControls,
  type ControlState, type GamepadFrame, type InputFrame, type MouseFrame, type SimAction,
} from '../../src/input/controlSystem';
import { CONFIG } from '../../src/config';
import { fcParams } from '../support/fc';
import { hostileNum, num } from '../support/arbitraries';
import { controlsViolation } from '../support/invariants';

const BOUND = [...boundKeyCodes()];
const KEY_POOL = [...BOUND, 'KeyQ', 'KeyZ', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'Tab', 'Unidentified'];
const K = CONFIG.controls.keys;

const maybeHostile = (a: fc.Arbitrary<number>) => fc.oneof({ weight: 9, arbitrary: a }, { weight: 1, arbitrary: hostileNum });

const mouseArb: fc.Arbitrary<MouseFrame> = fc.record({
  dx: maybeHostile(num(-500, 500)),
  dy: maybeHostile(num(-500, 500)),
  wheel: maybeHostile(num(-10, 10)),
  dragging: fc.boolean(),
  x: maybeHostile(num(-1.5, 1.5)),
  y: maybeHostile(num(-1.5, 1.5)),
  inside: fc.boolean(),
});

const gamepadArb: fc.Arbitrary<GamepadFrame | null> = fc.option(fc.record({
  pitch: maybeHostile(num(-1.2, 1.2)),
  roll: maybeHostile(num(-1.2, 1.2)),
  yaw: maybeHostile(num(-1.2, 1.2)),
  throttle: fc.option(maybeHostile(num(-0.2, 1.2)), { nil: null }),
  brake: maybeHostile(num(-0.2, 1.2)),
}), { nil: null, freq: 3 });

const frameArb: fc.Arbitrary<InputFrame> = fc.record({
  held: fc.subarray(KEY_POOL, { maxLength: 8 }).map((a) => new Set(a) as ReadonlySet<string>),
  pressed: fc.array(fc.record({ code: fc.constantFrom(...KEY_POOL), shift: fc.boolean() }), { maxLength: 4 }),
  shift: fc.boolean(),
  mouse: mouseArb,
  gamepad: gamepadArb,
});

const dtArb = fc.oneof(
  { weight: 6, arbitrary: num(0, 0.25) },
  { weight: 1, arbitrary: fc.constantFrom(0, 0.25, 1 / 60, 1 / 144) },
  { weight: 1, arbitrary: fc.constantFrom(NaN, -0.016, Infinity, 5) },
);

const sequenceArb = fc.array(fc.tuple(frameArb, dtArb), { minLength: 1, maxLength: 120 });

function run(seq: readonly (readonly [InputFrame, number])[], start: ControlState = createControlState()) {
  let st = start;
  const actions: SimAction[] = [];
  for (const [f, dt] of seq) {
    const r = updateControls(st, f, dt);
    st = r.state;
    actions.push(...r.actions);
    const bad = controlsViolation(st.controls);
    if (bad) throw new Error(`controls out of range: ${bad}`);
    for (const v of [st.raw.elevator, st.raw.aileron, st.raw.rudder]) {
      if (!(v >= -1 && v <= 1)) throw new Error(`raw axis out of range: ${v}`);
    }
    if (!(st.keyBrake >= 0 && st.keyBrake <= 1)) throw new Error(`keyBrake ${st.keyBrake}`);
  }
  return { state: st, actions };
}

const released = (): InputFrame => emptyInputFrame();

describe('control system under random input', () => {
  it('every Controls field stays finite and in range; flapsNotch is an integer notch', () => {
    fc.assert(fc.property(sequenceArb, (seq) => {
      run(seq);
    }), fcParams(400));
  });

  it('is deterministic: the same input sequence gives the same controls and actions', () => {
    fc.assert(fc.property(sequenceArb, (seq) => {
      const a = run(seq);
      const b = run(seq);
      expect(b.state).toEqual(a.state);
      expect(b.actions).toEqual(a.actions);
    }), fcParams(200));
  });

  it('never mutates its input state or frame', () => {
    fc.assert(fc.property(sequenceArb, (seq) => {
      let st = createControlState();
      for (const [f, dt] of seq) {
        const before = JSON.stringify(st);
        const heldBefore = [...f.held];
        const pressedBefore = JSON.stringify(f.pressed);
        const r = updateControls(st, f, dt);
        expect(JSON.stringify(st)).toBe(before);
        expect([...f.held]).toEqual(heldBefore);
        expect(JSON.stringify(f.pressed)).toBe(pressedBefore);
        st = r.state;
      }
    }), fcParams(100));
  });

  it('releasing everything returns ailerons, rudder and toe brakes to 0 within 1 s and the elevator within 3 s', () => {
    fc.assert(fc.property(sequenceArb, fc.constantFrom(1 / 30, 1 / 60, 1 / 144), (seq, dt) => {
      let { state } = run(seq);
      let t = 0;
      for (; t < 1; t += dt) state = updateControls(state, released(), dt).state;
      let c = state.controls;
      expect([c.aileron, c.rudder, c.brake]).toEqual([0, 0, 0]);
      for (; t < 3; t += dt) state = updateControls(state, released(), dt).state;
      c = state.controls;
      expect([c.elevator, c.aileron, c.rudder, c.brake]).toEqual([0, 0, 0, 0]);
      // Latched controls (throttle, trim, flaps, gear, parking brake) are NOT touched by releasing the keys.
      expect(controlsViolation(c)).toBeNull();
    }), fcParams(300));
  });

  it('latched controls only change on their own keys; zero-dt frames never move the continuous controls', () => {
    fc.assert(fc.property(sequenceArb, frameArb, (seq, f) => {
      const { state } = run(seq);
      const r = updateControls(state, { ...f, gamepad: null }, 0).state.controls;
      const c = state.controls;
      // dt = 0: throttle, trim and the keyboard brake ramp do not move (no gamepad).
      // (== rather than Object.is: a gamepad throttle of -0 legitimately becomes +0 on the keyboard path.)
      expect(r.throttle === c.throttle, `throttle ${c.throttle} → ${r.throttle}`).toBe(true);
      expect(r.elevatorTrim === c.elevatorTrim, `trim ${c.elevatorTrim} → ${r.elevatorTrim}`).toBe(true);
      const pressedCodes = f.pressed.map((p) => p.code);
      const count = (codes: readonly string[]) => pressedCodes.filter((x) => codes.includes(x)).length;
      if (count(K.gear) === 0) expect(r.gearDown).toBe(c.gearDown);
      else expect(r.gearDown).toBe(count(K.gear) % 2 === 0 ? c.gearDown : !c.gearDown);
      if (count(K.flapsDown) + count(K.flapsUp) === 0) expect(r.flapsNotch).toBe(c.flapsNotch);
      if (count(K.parkingBrake) === 0) expect(r.parkingBrake).toBe(c.parkingBrake);
      if (count(K.engine) === 0) expect(r.engineOn).toBe(c.engineOn);
    }), fcParams(300));
  });

  it('R emits reset, Shift+R emits resetApproach, and every sim action comes from a pressed key', () => {
    fc.assert(fc.property(fc.array(fc.record({ code: fc.constantFrom(...KEY_POOL), shift: fc.boolean() }), { maxLength: 12 }), (pressed) => {
      const f: InputFrame = { ...emptyInputFrame(), pressed };
      const { actions } = updateControls(createControlState(), f, 1 / 60);
      const resets = pressed.filter((p) => K.reset.includes(p.code));
      const expected = resets.map((p) => (p.shift ? 'resetApproach' : 'reset'));
      expect(actions.filter((a) => a === 'reset' || a === 'resetApproach')).toEqual(expected);
      expect(actions.length).toBeLessThanOrEqual(pressed.length);
    }), fcParams(300));
  });

  it('holding a conflicting pair (pitch up + pitch down) keeps that axis centred', () => {
    fc.assert(fc.property(fc.array(dtArb, { minLength: 1, maxLength: 60 }), (dts) => {
      let st = createControlState();
      const held = new Set([...K.pitchUp, ...K.pitchDown, ...K.rollLeft, ...K.rollRight, ...K.yawLeft, ...K.yawRight]);
      for (const dt of dts) st = updateControls(st, { ...emptyInputFrame(), held }, dt).state;
      expect([st.controls.elevator, st.controls.aileron, st.controls.rudder]).toEqual([0, 0, 0]);
    }), fcParams(100));
  });

  it('resetControls restores defaults and keeps the pilot preferences', () => {
    fc.assert(fc.property(sequenceArb, (seq) => {
      const { state } = run(seq);
      const r = resetControls(state);
      // The helicopter stability assist (K) is a preference: it survives a reset.
      expect(r.controls).toEqual({ ...createControlState().controls, stabilityAssist: state.controls.stabilityAssist !== false });
      expect(r.mouseYoke).toBe(state.mouseYoke);
      expect(r.landingLight).toBe(state.landingLight);
      expect(r.raw).toEqual({ elevator: 0, aileron: 0, rudder: 0 });
    }), fcParams(100));
  });
});
