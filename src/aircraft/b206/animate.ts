/**
 * PURE mapping from the sim's visual state to the JetRanger model's joints (no three.js):
 * rotor speeds and blur, the tip-path-plane tilt, coning/droop, blade pitch (collective, cyclic,
 * pedals), the cockpit controls and the lights. Writes into a caller-owned object.
 *
 * Conventions (what index.ts applies):
 *   tiltLong: tip-path plane relative to the mast, + = disc tilted AFT (front of the disc up):
 *             tiltFrame.rotation.x = +tiltLong.
 *   tiltLat:  + = disc tilted RIGHT (right side down): tiltFrame.rotation.z = −tiltLat.
 *   blade pitch: + = leading edge up (feather.rotation.x).
 *   azimuth: + = counter-clockwise seen from above (rotor.direction = +1).
 */
import { B206_AIRCRAFT } from '../../config';
import type { AircraftVisualState } from '../types';
import { ROTOR, smoothstep } from './shape';

const AC = B206_AIRCRAFT;
const RC = AC.rotorcraft!;
const DEG = Math.PI / 180;

/** Radius where the blade bend starts (the grips stay straight). */
export const BEND_R0 = 0.2;
/** Droop at rest (added to the precone line) that puts the tips at the structural points' height. */
export const DROOP_REST = ROTOR.restTipY - ROTOR.hub.y - Math.tan(ROTOR.precone) * (ROTOR.radius - BEND_R0);
/** Tail rotor blur thresholds, tail-rotor rpm (it blurs long before the main rotor does). */
export const TAIL_BLUR = { start: 150, full: 420 } as const;

export interface B206Anim {
  /** Main-rotor rpm (0 in a wreck) and tail-rotor rpm. */
  rpm: number;
  tailRpm: number;
  /** 0 = crisp blades … 1 = full blur. */
  mainBlend: number;
  tailBlend: number;
  tiltLong: number;
  tiltLat: number;
  /** Blade bend: y = coneSlope · (r − r0) + droop · ((r − r0)/(R − r0))². */
  coneSlope: number;
  droop: number;
  /** Collective pitch at 0.75 R (rad) and the cyclic feathering amplitudes (rad, sine/cosine of azimuth). */
  collectivePitch: number;
  cyclicSin: number;
  cyclicCos: number;
  /** Tail-rotor blade pitch, rad (+ pushes the tail right). */
  tailPitch: number;
  /** Cockpit controls: cyclic (+aft, +right), collective lever 0..1, pedals (+right). */
  stickLong: number;
  stickLat: number;
  lever: number;
  pedal: number;
  nav: number;
  beacon: number;
  landing: number;
}

export function createB206Anim(): B206Anim {
  return {
    rpm: 0,
    tailRpm: 0,
    mainBlend: 0,
    tailBlend: 0,
    tiltLong: ROTOR.mastTilt,
    tiltLat: 0,
    coneSlope: Math.tan(ROTOR.precone),
    droop: DROOP_REST,
    collectivePitch: 0,
    cyclicSin: 0,
    cyclicCos: 0,
    tailPitch: 0,
    stickLong: 0,
    stickLat: 0,
    lever: 0,
    pedal: 0,
    nav: 0,
    beacon: 0,
    landing: 0,
  };
}

const fin = (x: unknown, d = 0) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** 0 = crisp blades … 1 = full blur disc (the main rotor, by its rpm). */
export function mainBlurBlend(rpm: number): number {
  const m = AC.model;
  return smoothstep(m.propBlurStartRpm, m.propBlurFullRpm, fin(rpm));
}
export function tailBlurBlend(tailRpm: number): number {
  return smoothstep(TAIL_BLUR.start, TAIL_BLUR.full, fin(tailRpm));
}

/** Rotating red beacon: a sweep once per period. */
export function beaconIntensity(time: number): number {
  const m = AC.model;
  const t = fin(time);
  const phase = (((t % m.beaconPeriodS) + m.beaconPeriodS) % m.beaconPeriodS) / m.beaconPeriodS;
  const c = Math.cos(2 * Math.PI * phase);
  return c > 0 ? Math.pow(c, 6) : 0;
}

export function computeB206Anim(v: AircraftVisualState, out: B206Anim): B206Anim {
  const crashed = v.crashed === true;
  const r = v.rotor ?? null;
  const rpm = crashed ? 0 : Math.max(0, fin(v.propRpm));
  out.rpm = rpm;
  out.tailRpm = rpm * RC.tailRotor.gearRatio;
  out.mainBlend = mainBlurBlend(rpm);
  out.tailBlend = tailBlurBlend(out.tailRpm);

  // Speed as a fraction of 100 % NR; the teetering pair levels itself when the rotor stops (its
  // tips all sit at the same height), and follows the flapping once it turns.
  const s = rpm / RC.rotor.nominalRpm;
  const level = 1 - smoothstep(0.05, 0.4, s);
  const stop = RC.rotor.flapStopDeg * DEG;
  out.tiltLong = clamp(fin(r?.flapLong), -stop, stop) * (1 - level) + ROTOR.mastTilt * level;
  out.tiltLat = clamp(fin(r?.flapLat), -stop, stop) * (1 - level);

  // Coning: the precone, a little more with thrust above the weight; droop stiffened away by Ω².
  const weight = AC.mass * 9.81;
  const tw = r && Number.isFinite(r.thrust) ? clamp(r.thrust / weight, 0, 2.5) : 1;
  const spin2 = Math.min(1.5, s * s);
  out.coneSlope = Math.tan(ROTOR.precone + 1.1 * DEG * (tw - 1) * Math.min(1, spin2));
  out.droop = DROOP_REST / (1 + 60 * spin2);

  // Blade pitch: collective at 0.75 R, the cyclic as a once-per-rev feathering.
  const coll = clamp(fin(r?.collective), 0, 1);
  const [c0, c1] = RC.rotor.collectiveDeg;
  out.collectivePitch = (c0 + (c1 - c0) * coll) * DEG;
  const cl = clamp(fin(r?.cyclicLong, fin(v.elevator)), -1, 1);
  const ct = clamp(fin(r?.cyclicLat, fin(v.aileron)), -1, 1);
  // Feathering that tilts the disc (90° ahead in the rotation): forward stick → most pitch on the
  // retreating (left) side; right stick → most pitch over the nose.
  out.cyclicSin = cl * RC.rotor.cyclicLongDeg * 0.6 * DEG;
  out.cyclicCos = -ct * RC.rotor.cyclicLatDeg * 0.6 * DEG;
  const pedal = clamp(fin(r?.pedal, fin(v.rudder)), -1, 1);
  out.tailPitch = (RC.tailRotor.pitchNeutralDeg - pedal * RC.tailRotor.pitchRangeDeg) * DEG;

  out.stickLong = cl;
  out.stickLat = ct;
  out.lever = coll;
  out.pedal = pedal;

  const L = v.lights;
  const dead = crashed;
  out.nav = !dead && L?.nav ? 1 : 0;
  out.beacon = !dead && L?.beacon ? beaconIntensity(v.time) : 0;
  out.landing = !dead && (L?.landing || L?.taxi) ? (L.landing ? 1 : 0.6) : 0;
  return out;
}

/**
 * Pitch (rad) of a main blade at azimuth ψ, measured from the tail counter-clockwise seen from
 * above (ψ = 90° is the advancing right side).
 */
export function bladePitch(a: B206Anim, psi: number): number {
  return a.collectivePitch + a.cyclicSin * Math.sin(psi) + a.cyclicCos * Math.cos(psi);
}
