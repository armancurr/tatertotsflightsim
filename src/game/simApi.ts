/**
 * `window.sim` — the simulator's state exposed to the page, so a browser tool
 * (or a curious pilot in DevTools) can ask it questions while flying instead of
 * reading pixels. The object is created once and updated in place every frame.
 */
import type { AircraftState, CameraMode, Controls, GearState, SimSnapshot, SimStateLabel } from '../types';
import { M_TO_FT, MS_TO_FPM, MS_TO_KT, RAD_TO_DEG } from '../config';

export interface FpsLike {
  fps: number;
  avg: number;
  min: number;
  onePercentLow: number;
  longFrames: number;
  frames: number;
}

export interface SimSnapshotFull extends SimSnapshot {
  /** Vertical speed, feet per minute. */
  verticalSpeed: number;
  /** Height of the CG above ground/water, feet. */
  altitudeAGL: number;
  /** Ground speed, knots. */
  groundSpeed: number;
  /** Angle of attack, degrees. */
  aoa: number;
  /** Load factor, g. */
  gLoad: number;
  rpm: number;
  engine: 'running' | 'starting' | 'off' | 'failed';
  onGround: boolean;
  flapsNotch: number;
  gearHandle: 'down' | 'up';
  brakes: number;
  parkingBrake: boolean;
  trim: number;
  camera: CameraMode;
  paused: boolean;
  /** Crash reason, or null. */
  crash: string | null;
  lastLanding: null | { rating: string; fpm: number; airspeedKt: number; onRunway: boolean; centerlineOffsetM: number | null; surface: string };
  perf: FpsLike;
  position: { x: number; y: number; z: number };
  time: number;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

export function gearStateFromPos(gearPos: number): GearState {
  if (gearPos >= 0.999) return 'down';
  if (gearPos <= 0.001) return 'up';
  return 'transit';
}

export function stateLabel(state: AircraftState): SimStateLabel {
  if (state.phase === 'crashed') return 'crashed';
  if (state.phase === 'airborne' && state.stalled) return 'stalled';
  return state.phase;
}

export function buildSimSnapshot(args: {
  state: AircraftState;
  controls: Controls;
  fps: FpsLike;
  cameraMode: CameraMode;
  paused: boolean;
}): SimSnapshotFull {
  const { state, controls, fps, cameraMode, paused } = args;
  const d = state.derived;
  const e = state.engine;
  const engine = e.failed ? 'failed' : e.starting ? 'starting' : e.running ? 'running' : 'off';
  const td = state.touchdown;
  return {
    airspeed: r1(d.ias * MS_TO_KT),
    altitude: Math.round(state.position.y * M_TO_FT),
    heading: r1(d.headingDeg),
    pitch: r1(d.pitchDeg),
    roll: r1(d.rollDeg),
    throttle: Math.round(controls.throttle * 100),
    gear: gearStateFromPos(state.gearPos),
    flaps: r1(state.flapsDeg),
    state: stateLabel(state),
    fps: r1(fps.fps),
    verticalSpeed: Math.round(d.verticalSpeed * MS_TO_FPM),
    altitudeAGL: Math.round(d.altitudeAGL * M_TO_FT),
    groundSpeed: r1(d.groundSpeed * MS_TO_KT),
    aoa: r1(d.alpha * RAD_TO_DEG),
    gLoad: Math.round(d.loadFactor * 100) / 100,
    rpm: Math.round(e.rpm),
    engine,
    onGround: state.onGround,
    flapsNotch: controls.flapsNotch,
    gearHandle: controls.gearDown ? 'down' : 'up',
    brakes: controls.brake,
    parkingBrake: controls.parkingBrake,
    trim: Math.round(controls.elevatorTrim * 100),
    camera: cameraMode,
    paused,
    crash: state.crash ? state.crash.reason : null,
    lastLanding: td
      ? {
          rating: td.rating,
          fpm: Math.round(td.verticalSpeedFpm),
          airspeedKt: r1(td.airspeedKt),
          onRunway: td.onRunway,
          centerlineOffsetM: td.centerlineOffsetM === null ? null : r1(td.centerlineOffsetM),
          surface: td.surface,
        }
      : null,
    perf: { ...fps },
    position: { x: r1(state.position.x), y: r1(state.position.y), z: r1(state.position.z) },
    time: r1(state.time),
  };
}

export interface SimActions {
  reset(): void;
  resetApproach(): void;
  setCamera(mode: CameraMode): void;
  setPaused(paused: boolean): void;
}

/**
 * Create `window.sim` once. `update` copies a fresh snapshot onto the same
 * object each frame, so references held by a tool stay live.
 */
export function installSimApi(win: Window, actions: SimActions): { update(s: SimSnapshotFull): void; object: Record<string, unknown> } {
  const object: Record<string, unknown> = {
    reset: () => actions.reset(),
    resetApproach: () => actions.resetApproach(),
    setCamera: (mode: CameraMode) => actions.setCamera(mode),
    pause: () => actions.setPaused(true),
    resume: () => actions.setPaused(false),
  };
  (win as unknown as { sim: Record<string, unknown> }).sim = object;
  return {
    object,
    update(s: SimSnapshotFull) {
      Object.assign(object, s);
    },
  };
}
