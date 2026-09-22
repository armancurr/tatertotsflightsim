/**
 * Contracts of the aircraft model (src/aircraft). No three.js here so pure code
 * (tests, animation mapping) can import it.
 */
import type { CameraMode, InstrumentReadings } from '../types';

export interface AircraftLights {
  nav: boolean;
  strobe: boolean;
  beacon: boolean;
  landing: boolean;
  taxi: boolean;
}

/** Everything the 3D model needs from the sim each frame. */
export interface AircraftVisualState {
  /** -1..1 control positions (this sim's convention: +elevator = nose up, +aileron = roll right, +rudder = yaw right). */
  elevator: number;
  aileron: number;
  rudder: number;
  /** -1..1 elevator trim, + nose up. */
  trim: number;
  /** Actual flap deflection, degrees. */
  flapsDeg: number;
  /** Gear position: 0 = up … 1 = down and locked. */
  gearPos: number;
  /** Strut compression in metres: [nose, left main, right main]. */
  wheelCompression: [number, number, number];
  /** Ground speed of each wheel in m/s (spins the wheels): [nose, left main, right main]. */
  wheelRollSpeed: [number, number, number];
  /** -1..1 nosewheel steering (+ = right). */
  nosewheelSteer: number;
  propRpm: number;
  engineRunning: boolean;
  lights: AircraftLights;
  /** Seconds, for strobe/beacon timing. */
  time: number;
  /** 'cockpit' shows the interior from the pilot's eye (and hides what would block the view). */
  cameraMode: CameraMode;
  /** Live panel gauges, or null for a dark/zeroed panel. */
  instruments: InstrumentReadings | null;
  /** The aircraft has crashed: show the wreck (bent prop, folded wing, collapsed gear, skewed tail, no glass). */
  crashed?: boolean;
  /** Seconds since the crash (the soot spreads over the first few seconds). */
  crashAge?: number;
}

/** Draws the whole instrument panel face into a canvas (the panel texture). */
export type PanelDrawer = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  readings: InstrumentReadings,
) => void;

export function createDefaultVisualState(): AircraftVisualState {
  return {
    elevator: 0,
    aileron: 0,
    rudder: 0,
    trim: 0,
    flapsDeg: 0,
    gearPos: 1,
    wheelCompression: [0, 0, 0],
    wheelRollSpeed: [0, 0, 0],
    nosewheelSteer: 0,
    propRpm: 0,
    engineRunning: false,
    lights: { nav: true, strobe: false, beacon: true, landing: false, taxi: false },
    time: 0,
    cameraMode: 'chase',
    instruments: null,
    crashed: false,
    crashAge: 0,
  };
}

/** Readings shown on the panel when the sim passes `instruments: null` (everything at rest). */
export function createRestReadings(): InstrumentReadings {
  return {
    airspeedKt: 0,
    altitudeFt: 0,
    altitudeAglFt: 0,
    headingDeg: 0,
    verticalSpeedFpm: 0,
    pitchDeg: 0,
    rollDeg: 0,
    slipSkid: 0,
    turnRateDegPerSec: 0,
    throttlePct: 0,
    rpm: 0,
    engineStatus: 'OFF',
    flapsDeg: 0,
    flapsTargetDeg: 0,
    gear: 'down',
    gearLight: 'green',
    brakes: false,
    parkingBrake: false,
    trimPct: 0,
    stallWarning: false,
    overspeed: false,
    aoaDeg: 0,
    gLoad: 1,
    groundSpeedKt: 0,
    state: 'ground',
  };
}
