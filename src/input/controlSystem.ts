/**
 * PURE control system: raw input (held keys, key-down edges, mouse, gamepad) → smoothed
 * `Controls` for the physics + edge-triggered sim actions for the app.
 *
 * No DOM here — the DOM adapters (keyboard.ts, mouse.ts, gamepad.ts, inputManager.ts)
 * build an `InputFrame` each rendered frame and the app feeds it through `updateControls`.
 *
 * Yoke/rudder pipeline per axis:
 *   source → rate-limited "raw" position → exponential smoothing (smoothingTau) → clamp [-1, 1]
 * Source precedence: keyboard (while any key of the axis is held) > gamepad stick (outside the
 * deadzone) > mouse yoke (elevator/aileron, when enabled and the pointer is over the canvas) > centre.
 */
import type { CameraMode, Controls } from '../types';
import { CONFIG, type Config } from '../config';
import { clamp, expApproach, moveToward } from '../math/vec3';

export interface MouseFrame {
  /** Drag movement since the last frame, CSS pixels (+x right, +y down). Only accumulates while dragging. */
  dx: number;
  dy: number;
  /** Wheel since the last frame, in notches (+ = scroll down / toward the user = zoom out). */
  wheel: number;
  /** A pointer button is held down on the canvas. */
  dragging: boolean;
  /** pointer position, -1..1 from canvas centre (+x right, +y DOWN) */
  x: number;
  y: number;
  /** The pointer is over the canvas. */
  inside: boolean;
}

/** Gamepad axes already in control convention: pitch +1 = pull (nose up), roll/yaw +1 = right. Raw (no deadzone). */
export interface GamepadFrame {
  pitch: number;
  roll: number;
  yaw: number;
  /** 0..1 absolute throttle, or null when the gamepad is not commanding the throttle this frame. */
  throttle: number | null;
  /** 0..1 brake trigger. */
  brake: number;
}

export interface KeyPress {
  /** KeyboardEvent.code */
  code: string;
  /** Shift was held when the key went down. */
  shift: boolean;
}

export interface InputFrame {
  /** KeyboardEvent.code of every key currently held. */
  held: ReadonlySet<string>;
  /** Key-down edges since the last frame (auto-repeat excluded), in order. */
  pressed: readonly KeyPress[];
  shift: boolean;
  mouse: MouseFrame;
  gamepad: GamepadFrame | null;
}

export type CameraModeAction = `camera:${CameraMode}`;
export type SimAction =
  | 'reset'
  | 'resetApproach'
  | 'pause'
  | 'help'
  | 'toggleHud'
  | 'mute'
  | 'timeOfDay'
  | 'cameraNext'
  | CameraModeAction;

export interface AxisState {
  /** Rate-limited position before smoothing. */
  elevator: number;
  aileron: number;
  rudder: number;
}

export interface ControlState {
  /** What the physics gets. */
  controls: Controls;
  /** Mouse-yoke mode (Y). */
  mouseYoke: boolean;
  /** Landing light switch (L) — cosmetic, for the renderer. */
  landingLight: boolean;
  /** Internal: rate-limited yoke/rudder positions (the smoothed ones are in `controls`). */
  raw: AxisState;
  /** Internal: keyboard brake ramp 0..1 (the gamepad trigger is combined on top). */
  keyBrake: number;
}

/** When the smoothed value is this close to its target it lands exactly on it (clean zeros). */
const SNAP_EPS = 2.5e-3;

function defaultControls(): Controls {
  return {
    throttle: 0,
    elevator: 0,
    aileron: 0,
    rudder: 0,
    elevatorTrim: 0,
    flapsNotch: 0,
    gearDown: true,
    brake: 0,
    parkingBrake: false,
    engineOn: true,
  };
}

export function createControlState(_cfg: Config = CONFIG): ControlState {
  return {
    controls: defaultControls(),
    mouseYoke: false,
    landingLight: true,
    raw: { elevator: 0, aileron: 0, rudder: 0 },
    keyBrake: 0,
  };
}

export function emptyInputFrame(): InputFrame {
  return {
    held: new Set<string>(),
    pressed: [],
    shift: false,
    mouse: { dx: 0, dy: 0, wheel: 0, dragging: false, x: 0, y: 0, inside: false },
    gamepad: null,
  };
}

/** Return controls to the defaults (optionally overridden by a preset); keeps the pilot's preferences. */
export function resetControls(state: ControlState, preset: Partial<Controls> = {}): ControlState {
  const controls: Controls = { ...defaultControls(), ...preset };
  return {
    controls,
    mouseYoke: state.mouseYoke,
    landingLight: state.landingLight,
    raw: { elevator: controls.elevator, aileron: controls.aileron, rudder: controls.rudder },
    keyBrake: clamp(controls.brake, 0, 1),
  };
}

type Keys = Config['controls']['keys'];
type KeyName = keyof Keys;

/** Key binding → sim action. Order matters only for multiple bindings on one key. */
const ACTION_BINDINGS: readonly (readonly [KeyName, SimAction])[] = [
  ['pause', 'pause'],
  ['help', 'help'],
  ['hud', 'toggleHud'],
  ['mute', 'mute'],
  ['timeOfDay', 'timeOfDay'],
  ['cameraNext', 'cameraNext'],
  ['cameraCockpit', 'camera:cockpit'],
  ['cameraChase', 'camera:chase'],
  ['cameraExternal', 'camera:external'],
  ['cameraOrbit', 'camera:orbit'],
];

/** Symmetric deadzone with rescale so the output still spans 0..1 outside it. */
function deadzone(v: number, dz: number): number {
  if (!Number.isFinite(v)) return 0;
  const a = Math.abs(v);
  if (a <= dz) return 0;
  return Math.sign(v) * Math.min(1, (a - dz) / Math.max(1e-6, 1 - dz));
}

/** Mouse yoke: deadzone, full deflection at `range` (fraction of the half-canvas). */
function mouseAxis(v: number, dz: number, range: number): number {
  if (!Number.isFinite(v)) return 0;
  const a = Math.abs(v);
  if (a <= dz) return 0;
  return Math.sign(v) * Math.min(1, (a - dz) / Math.max(1e-6, range - dz));
}

interface AxisInput {
  /** -1, 0, +1 from the keyboard, or null when no key of this axis is held. */
  key: number | null;
  /** Direct analogue target (gamepad / mouse), or null. */
  analog: number | null;
  rate: number;
  /** Passive return-to-centre rate when no key is held (units/s); defaults to controls.returnRate. */
  returnRate?: number;
}

function stepAxis(raw: number, smoothed: number, inp: AxisInput, dt: number, cfg: Config): { raw: number; value: number } {
  const c = cfg.controls;
  let r = raw;
  if (inp.key !== null) {
    const target = inp.key * c.keyboardMaxDeflection;
    const rate = target === 0 ? c.returnRate : r * target < 0 ? Math.max(inp.rate, c.returnRate) : inp.rate;
    r = moveToward(r, target, rate * dt);
  } else if (inp.analog !== null) {
    r = inp.analog;
  } else {
    r = moveToward(r, 0, (inp.returnRate ?? c.returnRate) * dt);
  }
  r = clamp(r, -1, 1);
  let v = expApproach(smoothed, r, c.smoothingTau, dt);
  if (Math.abs(v - r) < SNAP_EPS) v = r;
  return { raw: r, value: clamp(v, -1, 1) };
}

export function updateControls(
  state: ControlState,
  input: InputFrame,
  dt: number,
  cfg: Config = CONFIG,
): { state: ControlState; actions: SimAction[] } {
  const c = cfg.controls;
  const keys = c.keys;
  const t = Number.isFinite(dt) && dt > 0 ? dt : 0;
  const held = input.held;
  const isDown = (codes: readonly string[]) => codes.some((code) => held.has(code));
  const matches = (codes: readonly string[], code: string) => codes.includes(code);

  const prev = state.controls;
  let flapsNotch = prev.flapsNotch;
  let gearDown = prev.gearDown;
  let parkingBrake = prev.parkingBrake;
  let engineOn = prev.engineOn;
  let landingLight = state.landingLight;
  let mouseYoke = state.mouseYoke;
  const actions: SimAction[] = [];
  const maxNotch = Math.max(0, cfg.aircraft.flaps.notchesDeg.length - 1);

  // ── Edge-triggered: toggles, steps and sim actions ────────────────────────
  for (const press of input.pressed) {
    const code = press.code;
    if (matches(keys.flapsDown, code)) flapsNotch = Math.min(maxNotch, flapsNotch + 1);
    if (matches(keys.flapsUp, code)) flapsNotch = Math.max(0, flapsNotch - 1);
    if (matches(keys.gear, code)) gearDown = !gearDown;
    if (matches(keys.parkingBrake, code)) parkingBrake = !parkingBrake;
    if (matches(keys.engine, code)) engineOn = !engineOn;
    if (matches(keys.landingLight, code)) landingLight = !landingLight;
    if (matches(keys.mouseYoke, code)) mouseYoke = !mouseYoke;
    if (matches(keys.reset, code)) actions.push(press.shift ? 'resetApproach' : 'reset');
    for (const [name, action] of ACTION_BINDINGS) {
      if (matches(keys[name], code)) actions.push(action);
    }
  }

  // ── Yoke & rudder ──────────────────────────────────────────────────────────
  const keyAxis = (neg: readonly string[], pos: readonly string[]): number | null => {
    const n = isDown(neg);
    const p = isDown(pos);
    if (!n && !p) return null;
    return (p ? 1 : 0) - (n ? 1 : 0);
  };
  const gp = input.gamepad;
  const gpAxis = (v: number | undefined): number | null => {
    if (!gp || v === undefined) return null;
    const d = deadzone(v, c.gamepadDeadzone);
    return d !== 0 ? d : null;
  };
  const m = input.mouse;
  const mouseActive = mouseYoke && m.inside;
  const mouseElev = mouseActive ? mouseAxis(m.y, c.mouseYokeDeadzone, c.mouseYokeRange) : null;
  const mouseAil = mouseActive ? mouseAxis(m.x, c.mouseYokeDeadzone, c.mouseYokeRange) : null;

  const elev = stepAxis(state.raw.elevator, prev.elevator, {
    key: keyAxis(keys.pitchDown, keys.pitchUp),
    analog: gpAxis(gp?.pitch) ?? mouseElev,
    rate: c.pitchRate,
    // The yoke eases off gradually (a pilot relaxing back pressure), so a keyboard rotation holds.
    returnRate: c.pitchReturnRate,
  }, t, cfg);
  const ail = stepAxis(state.raw.aileron, prev.aileron, {
    key: keyAxis(keys.rollLeft, keys.rollRight),
    analog: gpAxis(gp?.roll) ?? mouseAil,
    rate: c.rollRate,
  }, t, cfg);
  const rud = stepAxis(state.raw.rudder, prev.rudder, {
    key: keyAxis(keys.yawLeft, keys.yawRight),
    analog: gpAxis(gp?.yaw),
    rate: c.yawRate,
  }, t, cfg);

  // ── Throttle & trim ──────────────────────────────────────────────────────
  let throttle: number;
  if (gp && gp.throttle !== null && Number.isFinite(gp.throttle)) {
    throttle = clamp(gp.throttle, 0, 1);
  } else {
    const dir = (isDown(keys.throttleUp) ? 1 : 0) - (isDown(keys.throttleDown) ? 1 : 0);
    throttle = clamp(prev.throttle + dir * c.throttleRate * t, 0, 1);
  }
  const trimDir = (isDown(keys.trimNoseUp) ? 1 : 0) - (isDown(keys.trimNoseDown) ? 1 : 0);
  const elevatorTrim = clamp(prev.elevatorTrim + trimDir * c.trimRate * t, -1, 1);

  // ── Brakes ────────────────────────────────────────────────────────────────
  const brakeHeld = isDown(keys.brake);
  const brakeTime = brakeHeld ? c.brakeApplyTime : c.brakeReleaseTime;
  const keyBrake = moveToward(state.keyBrake, brakeHeld ? 1 : 0, brakeTime > 0 ? t / brakeTime : 1);
  const padBrake = gp && Number.isFinite(gp.brake) ? clamp(gp.brake, 0, 1) : 0;
  const brake = Math.max(keyBrake, padBrake);

  const controls: Controls = {
    throttle,
    elevator: elev.value,
    aileron: ail.value,
    rudder: rud.value,
    elevatorTrim,
    flapsNotch,
    gearDown,
    brake,
    parkingBrake,
    engineOn,
  };
  return {
    state: {
      controls,
      mouseYoke,
      landingLight,
      raw: { elevator: elev.raw, aileron: ail.raw, rudder: rud.raw },
      keyBrake,
    },
    actions,
  };
}

/** Every KeyboardEvent.code bound to something (the DOM adapter preventDefaults these). */
export function boundKeyCodes(cfg: Config = CONFIG): Set<string> {
  const out = new Set<string>();
  for (const codes of Object.values(cfg.controls.keys) as readonly (readonly string[])[]) {
    for (const code of codes) out.add(code);
  }
  return out;
}
