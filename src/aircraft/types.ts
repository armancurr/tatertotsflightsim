/**
 * Contracts of the aircraft model (src/aircraft). No three.js here so pure code
 * (tests, animation mapping) can import it.
 */
import type { CameraMode, InstrumentReadings, RotorState } from '../types';

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
  /** 0..1 afterburner intensity (jets: drives the nozzle flame). */
  afterburner?: number;
  /** 0..1 speed-brake deployment (jets). */
  speedBrake?: number;
  /** Gun barrel speed 0..1 (the GAU-8's seven barrels spin up before the first round). */
  gunSpin?: number;
  /** Rounds are leaving the gun this frame (muzzle flash, gun gas). */
  gunFiring?: boolean;
  /** Per missile station (CONFIG.weapons.missiles.stations order): a missile still hangs there. */
  stores?: boolean[];
  /** Per air-to-air station (CONFIG.weapons.airMissiles.stations order): a Sidewinder still hangs there. */
  airStores?: boolean[];
  /**
   * Helicopters: the rotor state (speed, tip-path-plane tilt, the blade controls after the stability
   * assist, thrust). `propRpm` is the main-rotor rpm. Absent/null for fixed-wing aircraft.
   */
  rotor?: RotorState | null;
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
