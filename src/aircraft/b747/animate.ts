/**
 * PURE mapping from the sim's visual state to the 747-400's joint angles, fans, gear sequence and
 * lights. No three.js. `stepB747Anim` writes into a caller-owned object (no allocations per frame)
 * and rate-limits what real actuators rate-limit (flaps, Kruegers, spoilers, truck tilt).
 *
 * Angle conventions (applied by the model about each hinge):
 *   elevators, ailerons, flaps: + = trailing edge DOWN
 *   rudders: + = trailing edge to the RIGHT (+x)
 *   spoilers: + = panel UP (0 … 45°)
 *   truck tilt: + = aft wheels DOWN (the 747's trucks hang toe-up in flight)
 *
 * Real 747-400 numbers: elevators 25° up / 20° down, split rudder ±30°, inboard (high-speed)
 * ailerons ±20° always, outboard (low-speed) ailerons locked out with the flaps up, six spoilers a
 * wing as speed brakes (45° in this model) and roll spoilers on the up-going… down-going wing's
 * side, triple-slotted Fowler flaps 0/1/5/10/20/25/30 (mostly aft travel to 10, then droop),
 * Krueger / variable-camber leading-edge flaps out with any flap, nose-wheel steering ±70° (fading
 * with ground speed like the physics), 49-inch tyres, trucks tilted ~13° in flight. RB211-524H fan
 * ~3,900 rpm at full power, ~22 % N1 at idle.
 */
import type { AircraftVisualState } from '../types';
import { B747_AIRCRAFT } from '../../config';

const DEG = Math.PI / 180;
const GD = B747_AIRCRAFT.ground;

export const B747_LIMITS = {
  elevatorUpDeg: 25,
  elevatorDownDeg: 20,
  rudderDeg: 30,
  aileronDeg: 20,
  spoilerMaxDeg: 45,
  /** Roll-spoiler deflection at full aileron. */
  rollSpoilerDeg: 25,
  /** Seconds for the speed brakes to open fully. */
  speedBrakeTime: 1.2,
  flapMaxDeg: 30,
  /** Visual flap rate, deg/s (the physics already moves the flaps at the real rate). */
  flapRateDeg: 12,
  /** Main flap droop at 30°, aft flap extra deflection at 30°. */
  flapMainDeg: 25,
  flapAftDeg: 25,
  kruegerTime: 1.4,
  noseSteerDeg: B747_AIRCRAFT.surfaces.nosewheelSteerMaxDeg,
  steerFadeSpeed: GD.steeringFadeSpeed,
  steerMinFraction: GD.steeringMinFraction,
  maxCompression: B747_AIRCRAFT.geometry.strutTravel,
  wheelRadius: B747_AIRCRAFT.geometry.mainWheelRadius,
  truckTiltDeg: 13,
  truckTiltRateDeg: 40,
  fanMaxRpm: 3900,
  fanBlurRpm: 380,
} as const;

export interface B747Anim {
  elevatorRad: number;
  rudderUpperRad: number;
  rudderLowerRad: number;
  aileronLeftInRad: number;
  aileronRightInRad: number;
  aileronLeftOutRad: number;
  aileronRightOutRad: number;
  /** 0..1 speed-brake extension (rate limited). */
  speedBrake: number;
  spoilerLeftRad: number;
  spoilerRightRad: number;
  /** Smoothed flap setting, degrees. */
  flapDeg: number;
  /** 0..1 Fowler travel aft along the tracks. */
  flapTravel: number;
  flapMainRad: number;
  /** Aft segment, relative to the main flap. */
  flapAftRad: number;
  /** 0..1 leading-edge flaps. */
  krueger: number;
  /** 0 = stowed … 1 = down and locked. */
  legs: number;
  /** 0 = closed … 1 = open (the well doors open only while the gear travels). */
  doors: number;
  truckTiltRad: number;
  noseSteerRad: number;
  compression: [number, number, number];
  wheelAngle: [number, number, number];
  fanRpm: number;
  fanAngle: number;
  fanBlur: number;
  nav: number;
  strobe: number;
  /** Upper / lower red beacons (they alternate). */
  beacon: number;
  beacon2: number;
  landing: number;
  taxi: number;
  logo: number;
}

export function createB747Anim(): B747Anim {
  return {
    elevatorRad: 0,
    rudderUpperRad: 0,
    rudderLowerRad: 0,
    aileronLeftInRad: 0,
    aileronRightInRad: 0,
    aileronLeftOutRad: 0,
    aileronRightOutRad: 0,
    speedBrake: 0,
    spoilerLeftRad: 0,
    spoilerRightRad: 0,
    flapDeg: 0,
    flapTravel: 0,
    flapMainRad: 0,
    flapAftRad: 0,
    krueger: 0,
    legs: 1,
    doors: 0,
    truckTiltRad: 0,
    noseSteerRad: 0,
    compression: [0, 0, 0],
    wheelAngle: [0, 0, 0],
    fanRpm: 0,
    fanAngle: 0,
    fanBlur: 0,
    nav: 0,
    strobe: 0,
    beacon: 0,
    beacon2: 0,
    landing: 0,
    taxi: 0,
    logo: 0,
  };
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const fin = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp1 = (v: unknown) => clamp(fin(v), -1, 1);
const clamp01 = (v: unknown) => clamp(fin(v), 0, 1);
const TWO_PI = Math.PI * 2;

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

function approach(from: number, to: number, maxStep: number): number {
  const d = to - from;
  return Math.abs(d) <= maxStep ? to : from + Math.sign(d) * maxStep;
}

/** Leg swing as a pure function of the physics gear position (0 = up … 1 = down). */
export function gearLegs(gearPos: number): number {
  return smoothstep(0.12, 0.88, clamp01(gearPos));
}
/** The well doors open first, stay open while the legs travel, and close again at either end. */
export function gearDoors(gearPos: number): number {
  const g = clamp01(gearPos);
  return smoothstep(0, 0.1, g) * (1 - smoothstep(0.9, 1, g));
}

/** White anti-collision strobes: double flash every 1.2 s. */
export function strobeFlash(time: number): number {
  const t = ((fin(time) % 1.2) + 1.2) % 1.2;
  return t < 0.05 || (t > 0.15 && t < 0.2) ? 1 : 0;
}
/** Red beacon: a short flash every second. */
export function beaconFlash(time: number): number {
  const t = ((fin(time) % 1) + 1) % 1;
  return t < 0.12 ? 1 : 0;
}

/** Fan speed (rpm) from the core speed in % (70 idle … 100): ~22 % N1 at idle, 100 % at full power. */
export function fanRpmFor(corePct: number, running: boolean): number {
  if (!running) return 0;
  const c = clamp(fin(corePct), 0, 104);
  const n1 = c <= 70 ? (c / 70) * 22 : 22 + ((c - 70) / 30) * 78;
  return (Math.max(0, n1) / 100) * B747_LIMITS.fanMaxRpm;
}

/** Fowler travel (0..1) for a flap fraction 0..1: mostly aft travel by flaps 10, all by 20. */
export function flapTravelFor(f: number): number {
  const k = 1 - clamp(f / 0.6, 0, 1);
  return 1 - k * k;
}

export function stepB747Anim(v: AircraftVisualState, a: B747Anim, dtIn: number): B747Anim {
  const dt = clamp(fin(dtIn), 0, 0.25);
  const L = B747_LIMITS;
  const crashed = v.crashed === true;
  const elev = clamp1(v.elevator);
  const ail = clamp1(v.aileron);
  const rud = clamp1(v.rudder);
  const trim = clamp1(v.trim);
  const gearPos = clamp01(v.gearPos);
  const inst = v.instruments;

  // Elevators (+elevator = nose up = trailing edges up).
  const pitch = clamp(elev + trim * 0.15, -1, 1);
  a.elevatorRad = (pitch >= 0 ? -pitch * L.elevatorUpDeg : -pitch * L.elevatorDownDeg) * DEG;
  a.rudderUpperRad = a.rudderLowerRad = rud * L.rudderDeg * DEG;

  // Flaps first (the outboard ailerons unlock with them).
  const flapTarget = clamp(fin(v.flapsDeg), 0, L.flapMaxDeg);
  a.flapDeg = approach(clamp(fin(a.flapDeg), 0, L.flapMaxDeg), flapTarget, L.flapRateDeg * dt);
  const f = a.flapDeg / L.flapMaxDeg;
  a.flapTravel = flapTravelFor(f);
  a.flapMainRad = L.flapMainDeg * DEG * Math.pow(f, 1.6);
  a.flapAftRad = L.flapAftDeg * DEG * Math.pow(f, 1.3);
  a.krueger = approach(clamp01(a.krueger), crashed ? clamp01(a.krueger) : a.flapDeg > 0.2 ? 1 : 0, dt / L.kruegerTime);

  // Ailerons (+aileron = roll right = right TE up). The outboard pair is locked out when clean.
  const outGain = smoothstep(0, 2, a.flapDeg);
  a.aileronRightInRad = -ail * L.aileronDeg * DEG;
  a.aileronLeftInRad = ail * L.aileronDeg * DEG;
  a.aileronRightOutRad = -ail * L.aileronDeg * DEG * outGain;
  a.aileronLeftOutRad = ail * L.aileronDeg * DEG * outGain;

  // Spoilers: speed brakes on both wings, roll spoilers on the down-going wing.
  a.speedBrake = approach(clamp01(a.speedBrake), crashed ? clamp01(a.speedBrake) : clamp01(v.speedBrake), dt / L.speedBrakeTime);
  const sb = a.speedBrake * L.spoilerMaxDeg;
  a.spoilerRightRad = Math.min(L.spoilerMaxDeg, sb + Math.max(0, ail) * L.rollSpoilerDeg) * DEG;
  a.spoilerLeftRad = Math.min(L.spoilerMaxDeg, sb + Math.max(0, -ail) * L.rollSpoilerDeg) * DEG;

  // Gear.
  a.legs = gearLegs(gearPos);
  a.doors = gearDoors(gearPos);
  const comp = v.wheelCompression;
  const rolls = v.wheelRollSpeed;
  for (let i = 0; i < 3; i++) {
    a.compression[i] = comp ? clamp(fin(comp[i]), 0, L.maxCompression) : 0;
    const speed = rolls ? fin(rolls[i]) : 0;
    a.wheelAngle[i] = (fin(a.wheelAngle[i]) + (speed / L.wheelRadius) * dt) % TWO_PI;
  }
  const wow = a.compression[0] > 0.005 || a.compression[1] > 0.005 || a.compression[2] > 0.005 || inst?.state === 'ground' || inst?.state === 'landed';
  const tiltTarget = wow || crashed ? 0 : L.truckTiltDeg * DEG * a.legs;
  a.truckTiltRad = approach(clamp(fin(a.truckTiltRad), -L.truckTiltDeg * DEG, L.truckTiltDeg * DEG), tiltTarget, L.truckTiltRateDeg * DEG * dt);
  const gs = Math.abs(rolls ? fin(rolls[0]) : 0);
  const steerFrac = Math.max(L.steerMinFraction, clamp(1 - gs / L.steerFadeSpeed, 0, 1));
  a.noseSteerRad = gearPos >= 0.999 ? clamp1(v.nosewheelSteer) * L.noseSteerDeg * DEG * steerFrac : 0;

  // Fans (windmill slowly in flight with the engines off).
  const running = v.engineRunning === true && !crashed;
  let rpm = fanRpmFor(fin(v.propRpm), running);
  if (!running && !crashed && inst && fin(inst.airspeedKt) > 60) rpm = Math.min(600, fin(inst.airspeedKt) * 3);
  a.fanRpm = rpm;
  // True rate below the blur threshold; above it the blades give way to the disc and the spinner
  // keeps turning at a readable rate (no wagon-wheel strobing).
  const fanRate = rpm < L.fanBlurRpm ? (rpm / 60) * TWO_PI : Math.min((rpm / 60) * TWO_PI, 9);
  a.fanAngle = (fin(a.fanAngle) + fanRate * dt) % TWO_PI;
  a.fanBlur = rpm >= L.fanBlurRpm ? 1 : 0;

  // Lights (a wreck's electrics are dead). Logo lights come on with the nav lights.
  const lt = v.lights;
  const t = fin(v.time);
  a.nav = !crashed && lt?.nav ? 1 : 0;
  a.strobe = !crashed && lt?.strobe ? strobeFlash(t) : 0;
  a.beacon = !crashed && lt?.beacon ? beaconFlash(t) : 0;
  a.beacon2 = !crashed && lt?.beacon ? beaconFlash(t + 0.5) : 0;
  a.landing = !crashed && lt?.landing ? 1 : 0;
  a.taxi = !crashed && lt?.taxi ? 1 : 0;
  a.logo = a.nav;
  return a;
}
