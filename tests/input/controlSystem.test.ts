import { describe, it, expect } from 'vitest';
import {
  createControlState, updateControls, resetControls, emptyInputFrame,
  type ControlState, type InputFrame, type MouseFrame, type GamepadFrame, type SimAction,
} from '../../src/input/controlSystem';
import { CONFIG, cloneConfig } from '../../src/config';

const DT = 1 / 60;

interface FrameSpec {
  held?: string[];
  pressed?: (string | { code: string; shift: boolean })[];
  shift?: boolean;
  mouse?: Partial<MouseFrame>;
  gamepad?: GamepadFrame | null;
}

function frame(spec: FrameSpec = {}): InputFrame {
  const base = emptyInputFrame();
  return {
    held: new Set(spec.held ?? []),
    pressed: (spec.pressed ?? []).map((p) => (typeof p === 'string' ? { code: p, shift: spec.shift ?? false } : p)),
    shift: spec.shift ?? false,
    mouse: { ...base.mouse, ...spec.mouse },
    gamepad: spec.gamepad ?? null,
  };
}

/** Run the control system for `seconds` with the same (non-edge) input every frame. */
function run(state: ControlState, seconds: number, spec: FrameSpec = {}, cfg = CONFIG, dt = DT): ControlState {
  let s = state;
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) s = updateControls(s, frame({ ...spec, pressed: [] }), dt, cfg).state;
  return s;
}

/** Run and record a control value every frame. */
function trace(state: ControlState, seconds: number, spec: FrameSpec, pick: (s: ControlState) => number): { state: ControlState; values: number[] } {
  let s = state;
  const values: number[] = [];
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    s = updateControls(s, frame(spec), DT).state;
    values.push(pick(s));
  }
  return { state: s, values };
}

function press(state: ControlState, code: string, shift = false, cfg = CONFIG) {
  return updateControls(state, frame({ pressed: [{ code, shift }], shift }), DT, cfg);
}

const pad = (p: Partial<GamepadFrame>): GamepadFrame => ({ pitch: 0, roll: 0, yaw: 0, throttle: null, brake: 0, ...p });

describe('control state defaults', () => {
  it('starts with throttle 0, flaps up, gear down, engine on, landing light on, centred yoke', () => {
    const s = createControlState();
    expect(s.controls.throttle).toBe(0);
    expect(s.controls.flapsNotch).toBe(0);
    expect(s.controls.gearDown).toBe(true);
    expect(s.controls.engineOn).toBe(true);
    expect(s.landingLight).toBe(true);
    expect(s.mouseYoke).toBe(false);
    expect(s.controls.elevator).toBe(0);
    expect(s.controls.aileron).toBe(0);
    expect(s.controls.rudder).toBe(0);
    expect(s.controls.elevatorTrim).toBe(0);
    expect(s.controls.brake).toBe(0);
    expect(s.controls.parkingBrake).toBe(false);
  });
  it('an empty input frame changes nothing and fires no actions', () => {
    const f = emptyInputFrame();
    expect(f.held.size).toBe(0);
    expect(f.pressed).toEqual([]);
    expect(f.gamepad).toBeNull();
    expect(f.mouse.inside).toBe(false);
    const s0 = createControlState();
    const { state, actions } = updateControls(s0, f, DT);
    expect(actions).toEqual([]);
    expect(state.controls).toEqual(s0.controls);
  });
  it('is pure: never mutates the previous state or the input frame', () => {
    const s0 = createControlState();
    const before = JSON.stringify(s0);
    const f = frame({ held: ['ArrowUp', 'KeyW'], pressed: ['KeyG', 'KeyF'] });
    updateControls(s0, f, DT);
    expect(JSON.stringify(s0)).toBe(before);
    expect([...f.held]).toEqual(['ArrowUp', 'KeyW']);
    expect(f.pressed.length).toBe(2);
  });
});

describe('yoke and rudder keys', () => {
  it('ArrowDown pulls (elevator +), ArrowUp pushes (elevator −)', () => {
    expect(run(createControlState(), 0.3, { held: ['ArrowDown'] }).controls.elevator).toBeGreaterThan(0.3);
    expect(run(createControlState(), 0.3, { held: ['ArrowUp'] }).controls.elevator).toBeLessThan(-0.3);
  });
  it('ArrowRight rolls right (+), ArrowLeft left (−); D is right rudder (+), A left (−)', () => {
    expect(run(createControlState(), 0.3, { held: ['ArrowRight'] }).controls.aileron).toBeGreaterThan(0.3);
    expect(run(createControlState(), 0.3, { held: ['ArrowLeft'] }).controls.aileron).toBeLessThan(-0.3);
    expect(run(createControlState(), 0.3, { held: ['KeyD'] }).controls.rudder).toBeGreaterThan(0.3);
    expect(run(createControlState(), 0.3, { held: ['KeyA'] }).controls.rudder).toBeLessThan(-0.3);
  });
  it('holding reaches (practically) full deflection in under 0.6 s on every axis', () => {
    for (const [key, pick] of [
      ['ArrowDown', (s: ControlState) => s.controls.elevator],
      ['ArrowUp', (s: ControlState) => -s.controls.elevator],
      ['ArrowRight', (s: ControlState) => s.controls.aileron],
      ['KeyA', (s: ControlState) => -s.controls.rudder],
    ] as const) {
      const s = run(createControlState(), 0.6, { held: [key] });
      expect(pick(s)).toBeGreaterThan(0.97);
    }
  });
  it('responds progressively, not instantly: one frame gives a small deflection', () => {
    const s = run(createControlState(), DT, { held: ['ArrowDown'] });
    expect(s.controls.elevator).toBeGreaterThan(0);
    expect(s.controls.elevator).toBeLessThan(0.1);
  });
  it('a 0.1 s tap gives a small deflection that returns to exactly centre', () => {
    const tap = trace(createControlState(), 0.1, { held: ['ArrowRight'] }, (s) => s.controls.aileron);
    const after = trace(tap.state, 0.6, {}, (s) => s.controls.aileron);
    const peak = Math.max(...tap.values, ...after.values);
    expect(peak).toBeGreaterThan(0.05);
    expect(peak).toBeLessThan(0.3);
    expect(after.state.controls.aileron).toBe(0);
  });
  it('returns to centre after release at the return rate (full → exactly 0 within 0.6 s)', () => {
    const held = run(createControlState(), 1, { held: ['ArrowDown'] });
    expect(run(held, 0.15, {}).controls.elevator).toBeGreaterThan(0.2);
    expect(run(held, 0.35, {}).controls.elevator).toBeLessThan(0.1);
    expect(run(held, 0.6, {}).controls.elevator).toBe(0);
  });
  it('is never jerky: the per-frame change stays small while holding and releasing', () => {
    const a = trace(createControlState(), 0.8, { held: ['ArrowRight'] }, (s) => s.controls.aileron);
    const b = trace(a.state, 0.8, {}, (s) => s.controls.aileron);
    const v = [0, ...a.values, ...b.values];
    let maxStep = 0;
    for (let i = 1; i < v.length; i++) maxStep = Math.max(maxStep, Math.abs(v[i] - v[i - 1]));
    expect(maxStep).toBeLessThan(0.08);
  });
  it('opposite keys held together cancel', () => {
    const s = run(createControlState(), 0.5, { held: ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'KeyA', 'KeyD'] });
    expect(s.controls.aileron).toBe(0);
    expect(s.controls.elevator).toBe(0);
    expect(s.controls.rudder).toBe(0);
  });
  it('clamps to [-1, 1] and to keyboardMaxDeflection', () => {
    const long = run(createControlState(), 5, { held: ['ArrowDown', 'ArrowLeft', 'KeyD'] });
    expect(long.controls.elevator).toBeLessThanOrEqual(1);
    expect(long.controls.aileron).toBeGreaterThanOrEqual(-1);
    expect(long.controls.rudder).toBeLessThanOrEqual(1);
    const cfg = cloneConfig();
    cfg.controls.keyboardMaxDeflection = 0.7;
    const limited = run(createControlState(cfg), 3, { held: ['ArrowDown'] }, cfg);
    expect(limited.controls.elevator).toBeCloseTo(0.7, 3);
  });
  it('dt = 0 changes no axis', () => {
    const s = updateControls(createControlState(), frame({ held: ['ArrowDown', 'KeyW'] }), 0).state;
    expect(s.controls.elevator).toBe(0);
    expect(s.controls.throttle).toBe(0);
  });
  it('uses the bindings from the config', () => {
    const cfg = cloneConfig();
    cfg.controls.keys.pitchUp = ['KeyK'];
    const s = run(createControlState(cfg), 0.3, { held: ['KeyK'] }, cfg);
    expect(s.controls.elevator).toBeGreaterThan(0.3);
    expect(run(createControlState(cfg), 0.3, { held: ['ArrowDown'] }, cfg).controls.elevator).toBe(0);
  });
});

describe('throttle, trim, flaps, gear, brakes, switches', () => {
  it('W raises the throttle at throttleRate and it stays where released', () => {
    const s = run(createControlState(), 1, { held: ['KeyW'] });
    expect(s.controls.throttle).toBeCloseTo(CONFIG.controls.throttleRate, 2);
    expect(run(s, 2, {}).controls.throttle).toBeCloseTo(s.controls.throttle, 10);
  });
  it('S lowers it; PageUp/PageDown and =/− work too; clamped to 0..1', () => {
    expect(run(createControlState(), 5, { held: ['KeyW'] }).controls.throttle).toBe(1);
    expect(run(createControlState(), 1, { held: ['KeyS'] }).controls.throttle).toBe(0);
    const up = run(createControlState(), 1, { held: ['PageUp'] });
    expect(up.controls.throttle).toBeGreaterThan(0.4);
    expect(run(up, 0.5, { held: ['PageDown'] }).controls.throttle).toBeLessThan(up.controls.throttle);
    expect(run(createControlState(), 1, { held: ['Equal'] }).controls.throttle).toBeGreaterThan(0.4);
    expect(run(up, 0.5, { held: ['Minus'] }).controls.throttle).toBeLessThan(up.controls.throttle);
  });
  it('a gamepad throttle axis sets the throttle directly', () => {
    const s = updateControls(createControlState(), frame({ gamepad: pad({ throttle: 0.73 }) }), DT).state;
    expect(s.controls.throttle).toBeCloseTo(0.73, 10);
    const s2 = updateControls(s, frame({ gamepad: pad({ throttle: 1.4 }) }), DT).state;
    expect(s2.controls.throttle).toBe(1);
    // null leaves the keyboard in charge
    const s3 = run(s, 1, { held: ['KeyW'], gamepad: pad({ throttle: null }) });
    expect(s3.controls.throttle).toBeGreaterThan(0.9);
  });
  it('] trims nose up, [ nose down, at trimRate, clamped to ±1', () => {
    const up = run(createControlState(), 1, { held: ['BracketRight'] });
    expect(up.controls.elevatorTrim).toBeCloseTo(CONFIG.controls.trimRate, 2);
    expect(run(up, 0.5, {}).controls.elevatorTrim).toBeCloseTo(up.controls.elevatorTrim, 10);
    expect(run(createControlState(), 1, { held: ['BracketLeft'] }).controls.elevatorTrim).toBeCloseTo(-CONFIG.controls.trimRate, 2);
    expect(run(createControlState(), 10, { held: ['BracketRight'] }).controls.elevatorTrim).toBe(1);
    expect(run(createControlState(), 10, { held: ['BracketLeft'] }).controls.elevatorTrim).toBe(-1);
  });
  it('F steps the flaps down one notch per press, V up, bounded by the notch table', () => {
    const last = CONFIG.aircraft.flaps.notchesDeg.length - 1;
    let s = createControlState();
    const seen: number[] = [];
    for (let i = 0; i < last + 2; i++) {
      s = press(s, 'KeyF').state;
      seen.push(s.controls.flapsNotch);
    }
    expect(seen).toEqual([1, 2, 3, 3, 3].slice(0, last + 2));
    expect(s.controls.flapsNotch).toBe(last);
    for (let i = 0; i < last + 2; i++) s = press(s, 'KeyV').state;
    expect(s.controls.flapsNotch).toBe(0);
  });
  it('holding F without a new key-down does not keep stepping', () => {
    let s = press(createControlState(), 'KeyF').state;
    s = run(s, 1, { held: ['KeyF'] });
    expect(s.controls.flapsNotch).toBe(1);
  });
  it('G toggles the gear handle, B the parking brake, E the engine, L the landing light, Y the mouse yoke', () => {
    let s = createControlState();
    s = press(s, 'KeyG').state; expect(s.controls.gearDown).toBe(false);
    s = press(s, 'KeyG').state; expect(s.controls.gearDown).toBe(true);
    s = press(s, 'KeyB').state; expect(s.controls.parkingBrake).toBe(true);
    s = press(s, 'KeyB').state; expect(s.controls.parkingBrake).toBe(false);
    s = press(s, 'KeyE').state; expect(s.controls.engineOn).toBe(false);
    s = press(s, 'KeyE').state; expect(s.controls.engineOn).toBe(true);
    s = press(s, 'KeyL').state; expect(s.landingLight).toBe(false);
    s = press(s, 'KeyL').state; expect(s.landingLight).toBe(true);
    s = press(s, 'KeyY').state; expect(s.mouseYoke).toBe(true);
    s = press(s, 'KeyY').state; expect(s.mouseYoke).toBe(false);
  });
  it('Space ramps the brakes to 1 in about 0.15 s and releases them quickly', () => {
    const partial = run(createControlState(), 0.05, { held: ['Space'] });
    expect(partial.controls.brake).toBeGreaterThan(0.1);
    expect(partial.controls.brake).toBeLessThan(0.6);
    const full = run(createControlState(), 0.17, { held: ['Space'] });
    expect(full.controls.brake).toBe(1);
    expect(run(full, 0.12, {}).controls.brake).toBe(0);
  });
  it('the gamepad brake trigger applies the brakes too', () => {
    const s = run(createControlState(), 0.3, { gamepad: pad({ brake: 0.7 }) });
    expect(s.controls.brake).toBeCloseTo(0.7, 2);
  });
});

describe('mouse yoke', () => {
  const yokeOn = () => press(createControlState(), 'KeyY').state;
  it('is off by default: the pointer does nothing', () => {
    const s = run(createControlState(), 0.5, { mouse: { inside: true, x: 0.5, y: 0.5 } });
    expect(s.controls.elevator).toBe(0);
    expect(s.controls.aileron).toBe(0);
  });
  it('maps pointer down → pull, right → right aileron, full at mouseYokeRange', () => {
    const s = run(yokeOn(), 0.5, { mouse: { inside: true, x: 0.8, y: CONFIG.controls.mouseYokeRange } });
    expect(s.controls.elevator).toBeCloseTo(1, 3);
    expect(s.controls.aileron).toBeCloseTo(1, 3);
    const up = run(yokeOn(), 0.5, { mouse: { inside: true, x: -0.3, y: -0.3 } });
    const { mouseYokeDeadzone: dz, mouseYokeRange: range } = CONFIG.controls;
    const expected = (0.3 - dz) / (range - dz);
    expect(up.controls.elevator).toBeCloseTo(-expected, 3);
    expect(up.controls.aileron).toBeCloseTo(-expected, 3);
  });
  it('has a centre deadzone', () => {
    const d = CONFIG.controls.mouseYokeDeadzone * 0.8;
    const s = run(yokeOn(), 0.5, { mouse: { inside: true, x: d, y: -d } });
    expect(s.controls.elevator).toBe(0);
    expect(s.controls.aileron).toBe(0);
  });
  it('returns to centre when the pointer leaves the canvas', () => {
    const s = run(yokeOn(), 0.5, { mouse: { inside: true, x: 0.5, y: 0.5 } });
    expect(s.controls.elevator).toBeGreaterThan(0.5);
    const out = run(s, 0.6, { mouse: { inside: false, x: 0.5, y: 0.5 } });
    expect(out.controls.elevator).toBe(0);
  });
  it('keyboard input for an axis overrides the mouse while held', () => {
    const s = run(yokeOn(), 0.8, { held: ['ArrowUp'], mouse: { inside: true, x: 0.5, y: 0.5 } });
    expect(s.controls.elevator).toBeLessThan(-0.9);
    // aileron still follows the mouse
    expect(s.controls.aileron).toBeGreaterThan(0.5);
  });
});

describe('gamepad', () => {
  it('drives pitch/roll/yaw directly (lightly smoothed)', () => {
    const s = run(createControlState(), 0.4, { gamepad: pad({ pitch: 0.5, roll: -0.6, yaw: 0.4 }) });
    const dz = CONFIG.controls.gamepadDeadzone;
    const rescale = (v: number) => Math.sign(v) * (Math.abs(v) - dz) / (1 - dz);
    expect(s.controls.elevator).toBeCloseTo(rescale(0.5), 2);
    expect(s.controls.aileron).toBeCloseTo(rescale(-0.6), 2);
    expect(s.controls.rudder).toBeCloseTo(rescale(0.4), 2);
    // smoothed: the first frame does not jump all the way
    const first = updateControls(createControlState(), frame({ gamepad: pad({ pitch: 1 }) }), DT).state;
    expect(first.controls.elevator).toBeGreaterThan(0.1);
    expect(first.controls.elevator).toBeLessThan(0.6);
  });
  it('ignores stick noise inside the deadzone', () => {
    const d = CONFIG.controls.gamepadDeadzone * 0.9;
    const s = run(createControlState(), 0.5, { gamepad: pad({ pitch: d, roll: -d, yaw: d }) });
    expect(s.controls.elevator).toBe(0);
    expect(s.controls.aileron).toBe(0);
    expect(s.controls.rudder).toBe(0);
  });
  it('full stick reaches full deflection (beyond keyboardMaxDeflection)', () => {
    const cfg = cloneConfig();
    cfg.controls.keyboardMaxDeflection = 0.6;
    const s = run(createControlState(cfg), 0.5, { gamepad: pad({ pitch: 1 }) }, cfg);
    expect(s.controls.elevator).toBeCloseTo(1, 3);
  });
});

describe('edge-triggered actions', () => {
  const cases: [string, boolean, SimAction][] = [
    ['KeyR', false, 'reset'],
    ['KeyR', true, 'resetApproach'],
    ['KeyP', false, 'pause'],
    ['Escape', false, 'pause'],
    ['KeyH', false, 'help'],
    ['KeyI', false, 'toggleHud'],
    ['KeyM', false, 'mute'],
    ['KeyN', false, 'timeOfDay'],
    ['KeyC', false, 'cameraNext'],
    ['Digit1', false, 'camera:cockpit'],
    ['Digit2', false, 'camera:chase'],
    ['Digit3', false, 'camera:external'],
    ['Digit4', false, 'camera:orbit'],
  ];
  for (const [code, shift, action] of cases) {
    it(`${shift ? 'Shift+' : ''}${code} → ${action}`, () => {
      expect(press(createControlState(), code, shift).actions).toEqual([action]);
    });
  }
  it('several presses in one frame produce their actions in order', () => {
    const { actions } = updateControls(createControlState(), frame({ pressed: ['KeyC', 'KeyH', 'Digit4'] }), DT);
    expect(actions).toEqual(['cameraNext', 'help', 'camera:orbit']);
  });
  it('holding a key without a new key-down fires nothing', () => {
    const { actions } = updateControls(createControlState(), frame({ held: ['KeyR', 'KeyP', 'KeyC'] }), DT);
    expect(actions).toEqual([]);
  });
  it('control toggles fire no sim actions', () => {
    expect(press(createControlState(), 'KeyG').actions).toEqual([]);
    expect(press(createControlState(), 'KeyF').actions).toEqual([]);
  });
});

describe('resetControls', () => {
  it('restores the defaults but keeps the pilot preferences (mouse yoke, landing light)', () => {
    let s = createControlState();
    s = press(s, 'KeyY').state;
    s = press(s, 'KeyL').state;
    s = press(s, 'KeyG').state;
    s = press(s, 'KeyF').state;
    s = run(s, 1, { held: ['KeyW', 'ArrowDown', 'BracketRight', 'Space'] });
    const r = resetControls(s);
    expect(r.controls).toEqual(createControlState().controls);
    expect(r.mouseYoke).toBe(true);
    expect(r.landingLight).toBe(false);
    // the smoothed yoke state is reset as well: no residual deflection on the next update
    expect(run(r, DT, {}).controls.elevator).toBe(0);
  });
  it('applies a preset (final approach)', () => {
    const r = resetControls(createControlState(), { throttle: 0.42, flapsNotch: 2 });
    expect(r.controls.throttle).toBe(0.42);
    expect(r.controls.flapsNotch).toBe(2);
    expect(r.controls.gearDown).toBe(true);
    expect(run(r, 0.5, {}).controls.throttle).toBe(0.42);
  });
});
