/**
 * PURE mapping from the sim's visual state to the A-10's joint angles, fans, gun, gear sequence and
 * lights. No three.js. `stepA10Anim` writes into a caller-owned object (no allocations per frame)
 * and rate-limits what real actuators rate-limit (decelerons as speed brakes, slats, flaps).
 *
 * Angle conventions (applied by the model about each hinge):
 *   elevators, flaps, deceleron halves: + = trailing edge DOWN
 *   rudders: + = trailing edge to the RIGHT (+x)
 *   slats: 0 = stowed … 1 = extended (forward and drooped)
 *   nose steer: + = wheel turned right
 *
 * Real A-10 numbers: elevators +30/−20° (TE up/down), rudders ±30°, decelerons ±20° as ailerons, the
 * two halves splitting to a combined ~120° (±60° about the aileron position) as the speed brake,
 * flaps 0/7/20/30°, slats extend automatically at high α (~13° and up), nose-wheel steering ±55°.
 * The TF34's fan turns ~7,300 rpm at full power; the GAU-8/A's cluster ~560 rpm (3,900 rds/min ÷ 7).
 */
import type { AircraftVisualState } from '../types';

const DEG = Math.PI / 180;

export const A10_LIMITS = {
  elevatorUpDeg: 30,
  elevatorDownDeg: 20,
  rudderDeg: 30,
  aileronDeg: 20,
  /** Each deceleron half opens this far from the aileron position at full speed brake. */
  splitDeg: 60,
  /** Seconds for the decelerons to split fully. */
  splitTime: 1.8,
  flapMaxDeg: 30,
  /** Flap rate, deg/s (visual smoothing of the sim's flap position). */
  flapRateDeg: 12,
  /** Slats extend above this α (deg) in flight; full travel in slatTime seconds. */
  slatAlphaDeg: 11,
  slatTime: 1.2,
  noseSteerDeg: 55,
  maxCompression: 0.3,
  noseWheelRadius: 0.3,
  mainWheelRadius: 0.46,
  /** Fan speed at 100 % core, rpm; blur threshold. */
  fanMaxRpm: 7300,
  fanBlurRpm: 380,
  /** Gun cluster speed at gunSpin 1, rpm; blur threshold (fraction of full speed). */
  gunMaxRpm: 3900 / 7,
  gunBlur: 0.18,
} as const;

export interface A10Anim {
  elevatorRad: number;
  rudderRad: number;
  /** Deceleron halves, left/right, upper/lower (+ = TE down). */
  decelLeftUpperRad: number;
  decelLeftLowerRad: number;
  decelRightUpperRad: number;
  decelRightLowerRad: number;
  /** 0..1 smoothed speed-brake split. */
  split: number;
  flapRad: number;
  /** 0..1 slat extension. */
  slat: number;
  /** Fans: rpm and wrapped angle, left/right (the fans run together). */
  fanRpm: number;
  fanAngle: number;
  /** 0..1 blur (fast fan). */
  fanBlur: number;
  /** GAU-8 cluster: 0..1 spin, wrapped angle, blur 0..1. */
  gunSpin: number;
  gunAngle: number;
  gunBlur: number;
  /** 0 = stowed … 1 = down and locked. */
  noseLeg: number;
  mainLeg: number;
  noseDoor: number;
  noseSteerRad: number;
  compression: [number, number, number];
  wheelAngle: [number, number, number];
  nav: number;
  strobe: number;
  landing: number;
  taxi: number;
}

export function createA10Anim(): A10Anim {
  return {
    elevatorRad: 0,
    rudderRad: 0,
    decelLeftUpperRad: 0,
    decelLeftLowerRad: 0,
    decelRightUpperRad: 0,
    decelRightLowerRad: 0,
    split: 0,
    flapRad: 0,
    slat: 0,
    fanRpm: 0,
    fanAngle: 0,
    fanBlur: 0,
    gunSpin: 0,
    gunAngle: 0,
    gunBlur: 0,
    noseLeg: 1,
    mainLeg: 1,
    noseDoor: 1,
    noseSteerRad: 0,
    compression: [0, 0, 0],
    wheelAngle: [0, 0, 0],
    nav: 0,
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

function approach(from: number, to: number, maxStep: number): number {
  const d = to - from;
  return Math.abs(d) <= maxStep ? to : from + Math.sign(d) * maxStep;
}

const TWO_PI = Math.PI * 2;

/** Gear sequence as a pure function of the physics gear position (0 = up … 1 = down). */
export function gearLeg(gearPos: number): number {
  return smoothstep(0.1, 0.95, clamp01(gearPos));
}
/** The nose doors open first and stay open with the gear down. */
export function gearDoor(gearPos: number): number {
  return smoothstep(0, 0.1, clamp01(gearPos));
}

/** The anti-collision strobes' flash (1.1 s period, double flash). */
export function strobeFlash(time: number): number {
  const t = ((fin(time) % 1.1) + 1.1) % 1.1;
  return t < 0.05 || (t > 0.14 && t < 0.19) ? 1 : 0;
}

/** Fan speed (rpm) from the engine core speed in % (70 idle … 100): N1 ≈ 26 % at idle, 100 % at military. */
export function fanRpmFor(corePct: number, running: boolean): number {
  if (!running) return 0;
  const c = clamp(fin(corePct), 0, 104);
  const n1 = c <= 70 ? (c / 70) * 26 : 26 + ((c - 70) / 30) * 74;
  return (Math.max(0, n1) / 100) * A10_LIMITS.fanMaxRpm;
}

export function stepA10Anim(v: AircraftVisualState, a: A10Anim, dtIn: number): A10Anim {
  const dt = clamp(fin(dtIn), 0, 0.25);
  const L = A10_LIMITS;
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
  a.rudderRad = rud * L.rudderDeg * DEG;

  // Decelerons: aileron (+aileron = roll right = right TE up) plus the speed-brake split.
  a.split = approach(clamp01(a.split), crashed ? clamp01(a.split) : clamp01(v.speedBrake), dt / L.splitTime);
  const sp = a.split * L.splitDeg;
  const ar = -ail * L.aileronDeg;
  const al = ail * L.aileronDeg;
  a.decelRightUpperRad = (ar - sp) * DEG;
  a.decelRightLowerRad = (ar + sp) * DEG;
  a.decelLeftUpperRad = (al - sp) * DEG;
  a.decelLeftLowerRad = (al + sp) * DEG;

  // Flaps follow the sim's flap position (rate-smoothed).
  const flapTarget = clamp(fin(v.flapsDeg), 0, L.flapMaxDeg) * DEG;
  a.flapRad = approach(clamp(fin(a.flapRad), 0, L.flapMaxDeg * DEG), flapTarget, L.flapRateDeg * DEG * dt);

  // Slats: out at high α in flight (stowed on the ground).
  const comp = v.wheelCompression;
  const wow = !!comp && (fin(comp[0]) > 0.005 || fin(comp[1]) > 0.005 || fin(comp[2]) > 0.005);
  const onGround = wow || inst?.state === 'ground' || inst?.state === 'landed';
  const alpha = inst ? fin(inst.aoaDeg, 0) : 3 + 12 * elev;
  const slatTarget = !crashed && !onGround && alpha > L.slatAlphaDeg ? 1 : 0;
  a.slat = approach(clamp01(a.slat), crashed ? clamp01(a.slat) : slatTarget, dt / L.slatTime);

  // Fans (windmill slowly in flight with the engines off).
  const running = v.engineRunning === true && !crashed;
  let rpm = fanRpmFor(fin(v.propRpm), running);
  if (!running && !crashed && inst && fin(inst.airspeedKt) > 60) rpm = Math.min(900, fin(inst.airspeedKt) * 4);
  a.fanRpm = rpm;
  // Rotate at the true rate below the blur threshold; above it, the blades are replaced by the disc
  // and the spinner keeps turning at a readable rate (no wagon-wheel strobing).
  const fanRate = rpm < L.fanBlurRpm ? (rpm / 60) * TWO_PI : Math.min((rpm / 60) * TWO_PI, 9);
  a.fanAngle = (fin(a.fanAngle) + fanRate * dt) % TWO_PI;
  a.fanBlur = rpm >= L.fanBlurRpm ? 1 : 0;

  // GAU-8/A: spin 0..1 from the weapons system.
  const spin = crashed ? 0 : clamp01(v.gunSpin);
  a.gunSpin = spin;
  const gunRate = (spin * L.gunMaxRpm) / 60 * TWO_PI;
  // Cap the visible per-frame turn below half a barrel pitch so the cluster never strobes backwards.
  const maxStep = (TWO_PI / 7) * 0.42;
  a.gunAngle = (fin(a.gunAngle) + Math.min(gunRate * dt, maxStep)) % TWO_PI;
  a.gunBlur = smoothstep(L.gunBlur * 0.5, L.gunBlur * 2.5, spin);

  // Gear.
  a.noseLeg = a.mainLeg = gearLeg(gearPos);
  a.noseDoor = gearDoor(gearPos);
  a.noseSteerRad = gearPos >= 0.999 ? clamp1(v.nosewheelSteer) * L.noseSteerDeg * DEG : 0;
  const rolls = v.wheelRollSpeed;
  for (let i = 0; i < 3; i++) {
    a.compression[i] = comp ? clamp(fin(comp[i]), 0, L.maxCompression) : 0;
    const r = i === 0 ? L.noseWheelRadius : L.mainWheelRadius;
    const speed = rolls ? fin(rolls[i]) : 0;
    a.wheelAngle[i] = (fin(a.wheelAngle[i]) + (speed / r) * dt) % TWO_PI;
  }

  // Lights (a wreck's electrics are dead). The landing/taxi lamps are in the pod noses (always out).
  const lt = v.lights;
  a.nav = !crashed && lt?.nav ? 1 : 0;
  a.strobe = !crashed && (lt?.strobe || lt?.beacon) ? strobeFlash(fin(v.time)) : 0;
  a.landing = !crashed && lt?.landing ? 1 : 0;
  a.taxi = !crashed && lt?.taxi ? 1 : 0;
  return a;
}
