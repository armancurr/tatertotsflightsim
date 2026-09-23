/**
 * Kinematic flight for the enemy aircraft (PURE, no three.js): a point mass flying coordinated
 * turns. Each step the speed moves toward the commanded speed (accel/decel limits), the bank rolls
 * toward the bank a commanded turn rate needs (roll-rate limit, bank ≤ min(commanded max, the
 * g limit)), and the turn rate is then exactly the coordinated one for that bank —
 * ω = g·tan φ / V — so what you see (the bank) always matches how fast it turns. The flight-path
 * angle chases the commanded altitude (time constant, climb/dive limits, a g-limited pitch rate);
 * a hard floor keeps it above the terrain. The attitude quaternion (three.js body convention: −Z
 * nose, +Y up, +X right wing) is heading, pitch = path angle + angle of attack (∝ load factor), and
 * bank; helicopters fly nose-down in proportion to speed instead.
 *
 * Frames: world +X east, +Y up, +Z south; heading clockwise from north (−Z), bank + = right wing down.
 */
import type { Quat, Vec3 } from '../../types';

export const G = 9.80665;
const DEG = Math.PI / 180;

export interface FlightSpec {
  cruise: number;
  min: number;
  max: number;
  accel: number;
  decel: number;
  maxG: number;
  cruiseBankDeg: number;
  breakBankDeg: number;
  rollRateDeg: number;
  maxClimbDeg: number;
  maxDiveDeg: number;
  /** Angle of attack per g (deg), shown as nose-up attitude. */
  aoaPerG: number;
  minAglM: number;
  /** Helicopter: nose-down attitude at cruise (deg). */
  noseDownDeg: number;
  heloPitch: boolean;
}

export interface FlightState {
  x: number;
  y: number;
  z: number;
  /** True airspeed (= ground speed, no wind), m/s. */
  speed: number;
  /** Heading, rad clockwise from north. */
  heading: number;
  /** Flight-path angle, rad (+ climbing). */
  gamma: number;
  /** Bank, rad (+ = right wing down). */
  bank: number;
  /** Turn rate, rad/s (+ = turning right). */
  turnRate: number;
  /** Load factor, g. */
  load: number;
  /** Body attitude (derived each step). */
  pitch: number;
  orientation: Quat;
  velocity: Vec3;
  /** Speed change this step, m/s² (helicopter pitch). */
  accel: number;
}

export interface FlightCommand {
  /** Desired turn rate, rad/s (+ right). */
  turnRate: number;
  /** Desired altitude, m MSL. */
  altitude: number;
  /** Desired speed, m/s. */
  speed: number;
  /** Bank allowed now, rad (cruise or break). */
  maxBank: number;
  /** Altitude-hold time constant, s. */
  altitudeTau: number;
}

const fin = (v: number, d = 0) => (Number.isFinite(v) ? v : d);
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Wrap an angle to −π..π. */
export function wrapPi(a: number): number {
  if (!Number.isFinite(a)) return 0;
  let r = a % (2 * Math.PI);
  if (r > Math.PI) r -= 2 * Math.PI;
  else if (r < -Math.PI) r += 2 * Math.PI;
  return r;
}

/** Largest bank the g limit allows in a level turn. */
export function gLimitedBank(maxG: number): number {
  return Math.acos(1 / Math.max(1.0001, maxG));
}

/** Coordinated turn rate for a bank at a speed. */
export function turnRateFor(bank: number, speed: number): number {
  return (G * Math.tan(bank)) / Math.max(1, speed);
}

/** Bank needed for a turn rate at a speed. */
export function bankFor(turnRate: number, speed: number): number {
  return Math.atan((Math.max(1, speed) * turnRate) / G);
}

/** Quaternion (three.js Euler order 'YXZ'): yaw −heading, pitch, roll −bank. */
export function attitudeQuat(out: Quat, heading: number, pitch: number, bank: number): Quat {
  const x = pitch * 0.5;
  const y = -heading * 0.5;
  const z = -bank * 0.5;
  const c1 = Math.cos(x), s1 = Math.sin(x);
  const c2 = Math.cos(y), s2 = Math.sin(y);
  const c3 = Math.cos(z), s3 = Math.sin(z);
  out.x = s1 * c2 * c3 + c1 * s2 * s3;
  out.y = c1 * s2 * c3 - s1 * c2 * s3;
  out.z = c1 * c2 * s3 - s1 * s2 * c3;
  out.w = c1 * c2 * c3 + s1 * s2 * s3;
  return out;
}

export function newFlightState(x: number, y: number, z: number, headingRad: number, speed: number): FlightState {
  const s: FlightState = {
    x, y, z, speed, heading: wrapPi(headingRad), gamma: 0, bank: 0, turnRate: 0, load: 1, pitch: 0,
    orientation: { x: 0, y: 0, z: 0, w: 1 }, velocity: { x: 0, y: 0, z: 0 }, accel: 0,
  };
  deriveFlight(s, null);
  return s;
}

/** Velocity and attitude from the path state. */
export function deriveFlight(s: FlightState, spec: FlightSpec | null): void {
  const ch = Math.cos(s.heading), sh = Math.sin(s.heading);
  const cg = Math.cos(s.gamma), sg = Math.sin(s.gamma);
  s.velocity.x = s.speed * cg * sh;
  s.velocity.y = s.speed * sg;
  s.velocity.z = -s.speed * cg * ch;
  let pitch = s.gamma;
  if (spec) {
    if (spec.heloPitch) {
      // A helicopter tilts its rotor (and the fuselage) forward to fly fast and back to slow down.
      const v = clamp(s.speed / Math.max(1, spec.cruise), 0, 1.6);
      pitch = s.gamma * 0.35 - spec.noseDownDeg * DEG * v + clamp(-s.accel * 0.06, -0.12, 0.2);
    } else {
      pitch = s.gamma + spec.aoaPerG * DEG * s.load;
    }
  }
  s.pitch = pitch;
  attitudeQuat(s.orientation, s.heading, pitch, s.bank);
}

/**
 * Advance one step. `floor(x, z)` (optional) is the lowest altitude allowed there (ground + margin):
 * the aircraft is held above it.
 */
export function stepFlight(s: FlightState, cmd: FlightCommand, spec: FlightSpec, dtIn: number, floor?: (x: number, z: number) => number): void {
  const dt = Number.isFinite(dtIn) && dtIn > 0 ? Math.min(dtIn, 0.25) : 0;
  if (dt === 0) {
    deriveFlight(s, spec);
    return;
  }
  // Speed.
  const vCmd = clamp(fin(cmd.speed, spec.cruise), spec.min, spec.max);
  const dv = clamp(vCmd - s.speed, -spec.decel * dt, spec.accel * dt);
  const v0 = s.speed;
  s.speed = clamp(fin(s.speed + dv, spec.cruise), spec.min, spec.max);
  s.accel = (s.speed - v0) / dt;
  const V = s.speed;

  // Bank toward the one the commanded turn rate needs (g-limited), at the roll rate.
  const bankLimit = Math.min(Math.max(0, fin(cmd.maxBank, spec.cruiseBankDeg * DEG)), gLimitedBank(spec.maxG), 85 * DEG);
  const want = clamp(bankFor(fin(cmd.turnRate), V), -bankLimit, bankLimit);
  const roll = spec.rollRateDeg * DEG * dt;
  s.bank = clamp(fin(s.bank) + clamp(want - s.bank, -roll, roll), -85 * DEG, 85 * DEG);
  // Coordinated: the turn rate is the one the bank gives.
  s.turnRate = turnRateFor(s.bank, V);
  s.heading = wrapPi(s.heading + s.turnRate * dt);

  // Flight-path angle toward the commanded altitude.
  const tau = Math.max(1, fin(cmd.altitudeTau, 8));
  const dh = fin(cmd.altitude, s.y) - s.y;
  const gWant = Math.asin(clamp(dh / (V * tau), -Math.sin(spec.maxDiveDeg * DEG), Math.sin(spec.maxClimbDeg * DEG)));
  // Pitch rate the spare g allows (pull), and a gentle push-over.
  const nLevel = 1 / Math.max(0.05, Math.cos(s.bank));
  const spare = Math.max(0.3, spec.maxG - nLevel);
  const up = ((spare * G) / V) * dt;
  const down = ((0.8 * G) / V) * dt;
  const g0 = s.gamma;
  s.gamma = clamp(fin(s.gamma) + clamp(gWant - s.gamma, -down, up), -spec.maxDiveDeg * DEG, spec.maxClimbDeg * DEG);
  const gammaDot = (s.gamma - g0) / dt;
  s.load = nLevel * Math.cos(s.gamma) + (V * gammaDot) / G;

  // Move.
  const cg = Math.cos(s.gamma);
  s.x += V * cg * Math.sin(s.heading) * dt;
  s.y += V * Math.sin(s.gamma) * dt;
  s.z -= V * cg * Math.cos(s.heading) * dt;

  if (floor) {
    const f = floor(s.x, s.z);
    if (Number.isFinite(f) && s.y < f) {
      s.y = f;
      if (s.gamma < 0) s.gamma = 0;
    }
  }
  if (!(Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.z))) {
    s.x = fin(s.x);
    s.y = fin(s.y, 1000);
    s.z = fin(s.z);
  }
  deriveFlight(s, spec);
}
