/**
 * PURE mapping from the sim's visual state to the F-16 model's joint angles, nozzle, plume, gear
 * sequence and lights. No three.js. `stepF16Anim` writes into a caller-owned object (no
 * allocations per frame) and rate-limits what real actuators rate-limit (LEFs, speed brakes,
 * nozzle, afterburner light-off).
 *
 * Angle conventions (applied by the model about each hinge):
 *   stabilators, flaperons: + = trailing edge DOWN
 *   rudder: + = trailing edge to the RIGHT (+x)
 *   leading-edge flaps: + = leading edge DOWN (droop)
 *   nose steer: + = wheel turned right
 *
 * Real F-16 numbers: stabilators ±25° (±5° differential for roll), flaperons −23…+20° (aileron
 * ±21.5°, flap 20° — the flight computer lowers them with the gear handle), rudder ±30°, LEFs
 * −2…25° scheduled 1.38·α + 1.45° (2° up on the ground), speed brakes 60° (43° with the gear
 * down), nose-wheel steering ±32°. The F110's nozzle hangs open with the engine off and at idle,
 * closes to its minimum area at military power and opens wide in afterburner.
 */
import type { AircraftVisualState } from '../types';

const DEG = Math.PI / 180;

export const F16_LIMITS = {
  stabPitchDeg: 25,
  stabRollDeg: 5,
  stabMaxDeg: 25,
  flaperonAileronDeg: 21.5,
  flaperonFlapDeg: 20,
  flaperonUpDeg: 23,
  rudderDeg: 30,
  lefMinDeg: -2,
  lefMaxDeg: 25,
  /** LEF actuator rate, deg/s. */
  lefRateDeg: 30,
  speedBrakeDeg: 60,
  speedBrakeGearDownDeg: 43,
  /** Seconds for the speed brakes to travel fully. */
  speedBrakeTime: 1.6,
  noseSteerDeg: 32,
  /** Nozzle travel rate (fraction of full travel per second). */
  nozzleRate: 1.2,
  maxCompression: 0.3,
  noseWheelRadius: 0.23,
  mainWheelRadius: 0.35,
} as const;

export interface F16Anim {
  stabLeftRad: number;
  stabRightRad: number;
  flaperonLeftRad: number;
  flaperonRightRad: number;
  rudderRad: number;
  lefRad: number;
  /** 0..1 smoothed speed-brake travel and the resulting petal angle. */
  speedBrake: number;
  speedBrakeRad: number;
  /** Throttle proxy 0..1 (from the instruments; 0.7 when running without them). */
  power: number;
  /** 0 = minimum exit area (military power) … 1 = fully open. */
  nozzleOpen: number;
  /** 0..1 glow of the hot nozzle interior. */
  heat: number;
  /** 0..1 afterburner plume intensity (smoothed light-off / blow-out). */
  ab: number;
  /** 0 = stowed … 1 = down and locked. */
  noseLeg: number;
  mainLeg: number;
  /** 0 = shut … 1 = open. */
  noseDoor: number;
  mainDoor: number;
  noseSteerRad: number;
  /** Strut compression (m) [nose, left, right]. */
  compression: [number, number, number];
  /** Wheel roll angle (rad, wrapped) [nose, left, right]. */
  wheelAngle: [number, number, number];
  nav: number;
  formation: number;
  strobe: number;
  landing: number;
  taxi: number;
}

export function createF16Anim(): F16Anim {
  return {
    stabLeftRad: 0,
    stabRightRad: 0,
    flaperonLeftRad: 0,
    flaperonRightRad: 0,
    rudderRad: 0,
    lefRad: F16_LIMITS.lefMinDeg * DEG,
    speedBrake: 0,
    speedBrakeRad: 0,
    power: 0,
    nozzleOpen: 1,
    heat: 0,
    ab: 0,
    noseLeg: 1,
    mainLeg: 1,
    noseDoor: 1,
    mainDoor: 1,
    noseSteerRad: 0,
    compression: [0, 0, 0],
    wheelAngle: [0, 0, 0],
    nav: 0,
    formation: 0,
    strobe: 0,
    landing: 0,
    taxi: 0,
  };
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const fin = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp1 = (v: unknown) => clamp(fin(v), -1, 1);
const clamp01 = (v: unknown) => clamp(fin(v), 0, 1);

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Move `from` toward `to` by at most `maxStep`. */
function approach(from: number, to: number, maxStep: number): number {
  const d = to - from;
  return Math.abs(d) <= maxStep ? to : from + Math.sign(d) * maxStep;
}

const TWO_PI = Math.PI * 2;

/**
 * Gear sequence as a pure function of the physics gear position (0 = up … 1 = down): the doors
 * open in the first 10 % of the travel, the legs swing through 12…95 %; the nose doors stay open
 * with the gear down, the main wheel-bay doors shut again once the legs are locked (the strut
 * doors ride on the legs).
 */
export function gearLeg(gearPos: number): number {
  return smoothstep(0.12, 0.95, clamp01(gearPos));
}
export function gearDoor(gearPos: number): number {
  return smoothstep(0, 0.1, clamp01(gearPos));
}
export function mainBayDoor(gearPos: number): number {
  const g = clamp01(gearPos);
  return smoothstep(0, 0.1, g) * (1 - smoothstep(0.955, 0.995, g));
}

/** The anti-collision strobe's double flash (1.2 s period). */
export function strobeFlash(time: number): number {
  const t = ((fin(time) % 1.2) + 1.2) % 1.2;
  return t < 0.06 || (t > 0.16 && t < 0.22) ? 1 : 0;
}

export function stepF16Anim(v: AircraftVisualState, a: F16Anim, dtIn: number): F16Anim {
  const dt = clamp(fin(dtIn), 0, 0.25);
  const crashed = v.crashed === true;
  const elev = clamp1(v.elevator);
  const ail = clamp1(v.aileron);
  const rud = clamp1(v.rudder);
  const trim = clamp1(v.trim);
  const gearPos = clamp01(v.gearPos);
  const inst = v.instruments;

  // Stabilators: symmetric pitch + differential roll (+ a touch of trim), ±25°.
  const L = F16_LIMITS;
  const pitch = -(elev + trim * 0.12) * L.stabPitchDeg;
  const roll = ail * L.stabRollDeg;
  a.stabRightRad = clamp(pitch - roll, -L.stabMaxDeg, L.stabMaxDeg) * DEG;
  a.stabLeftRad = clamp(pitch + roll, -L.stabMaxDeg, L.stabMaxDeg) * DEG;

  // Flaperons: flap droop (flaps selected, or the gear handle down) + differential aileron.
  const droop = clamp(Math.max(fin(v.flapsDeg), L.flaperonFlapDeg * gearPos), 0, L.flaperonFlapDeg);
  a.flaperonRightRad = clamp(droop - ail * L.flaperonAileronDeg, -L.flaperonUpDeg, L.flaperonFlapDeg) * DEG;
  a.flaperonLeftRad = clamp(droop + ail * L.flaperonAileronDeg, -L.flaperonUpDeg, L.flaperonFlapDeg) * DEG;

  a.rudderRad = rud * L.rudderDeg * DEG;

  // Leading-edge flaps: α schedule in flight, 2° up with weight on wheels.
  const comp = v.wheelCompression;
  const wow = !!comp && (fin(comp[0]) > 0.005 || fin(comp[1]) > 0.005 || fin(comp[2]) > 0.005);
  const onGround = wow || inst?.state === 'ground' || inst?.state === 'landed';
  const alpha = inst ? fin(inst.aoaDeg, 0) : 3 + 12 * elev;
  const lefTarget = (onGround ? L.lefMinDeg : clamp(1.38 * alpha + 1.45, L.lefMinDeg, L.lefMaxDeg)) * DEG;
  a.lefRad = approach(fin(a.lefRad), lefTarget, L.lefRateDeg * DEG * dt);

  // Speed brakes (the sim passes 0/1): real actuator travel time, gear-down limit.
  a.speedBrake = approach(clamp01(a.speedBrake), crashed ? a.speedBrake : clamp01(v.speedBrake), dt / L.speedBrakeTime);
  a.speedBrakeRad = a.speedBrake * (gearPos > 0.5 ? L.speedBrakeGearDownDeg : L.speedBrakeDeg) * DEG;

  // Engine: power proxy, nozzle schedule, exhaust heat, plume.
  const running = v.engineRunning === true && !crashed;
  const power = running ? (inst ? clamp01(fin(inst.throttlePct) / 100) : 0.7) : 0;
  a.power = power;
  const abCmd = running ? clamp01(v.afterburner) : 0;
  const nozzleTarget = !running ? 1 : abCmd > 0.01 ? 0.55 + 0.45 * abCmd : 0.85 * (1 - smoothstep(0.15, 0.9, power));
  a.nozzleOpen = approach(clamp01(a.nozzleOpen), nozzleTarget, L.nozzleRate * dt);
  const abNow = clamp01(a.ab);
  a.ab = running ? (abCmd > abNow ? Math.min(abCmd, abNow + dt * 5) : Math.max(abCmd, abNow - dt * 2.5)) : 0;
  a.heat = running ? clamp(0.55 * smoothstep(0.6, 1, power) + 0.45 * a.ab, 0, 1) : 0;

  // Gear.
  a.noseLeg = a.mainLeg = gearLeg(gearPos);
  a.noseDoor = gearDoor(gearPos);
  a.mainDoor = mainBayDoor(gearPos);
  a.noseSteerRad = gearPos >= 0.999 ? clamp1(v.nosewheelSteer) * L.noseSteerDeg * DEG : 0;
  const rolls = v.wheelRollSpeed;
  for (let i = 0; i < 3; i++) {
    a.compression[i] = comp ? clamp(fin(comp[i]), 0, L.maxCompression) : 0;
    const r = i === 0 ? L.noseWheelRadius : L.mainWheelRadius;
    const speed = rolls ? fin(rolls[i]) : 0;
    a.wheelAngle[i] = (fin(a.wheelAngle[i]) + (speed / r) * dt) % TWO_PI;
  }

  // Lights (a wreck's electrics are dead; landing/taxi lamps live on the gear).
  const lt = v.lights;
  const down = gearPos >= 0.98 ? 1 : 0;
  a.nav = !crashed && lt?.nav ? 1 : 0;
  a.formation = !crashed && lt?.nav ? 0.6 : 0;
  a.strobe = !crashed && (lt?.strobe || lt?.beacon) ? strobeFlash(fin(v.time)) : 0;
  a.landing = !crashed && lt?.landing ? down : 0;
  a.taxi = !crashed && lt?.taxi ? down : 0;
  return a;
}
