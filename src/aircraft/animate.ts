/**
 * PURE mapping from the sim's visual state to the model's joint angles, light
 * intensities and blends. No three.js. `computeAnimation` writes into a
 * caller-owned object so the per-frame path allocates nothing.
 *
 * Angle conventions (what the model applies about each hinge):
 *   elevator / ailerons / flaps / trim tab: + = trailing edge DOWN
 *   rudder: + = trailing edge to the RIGHT (+x)
 *   nose steer: + = wheel turned right
 *   noseGearAngleRad: rotation of the nose leg about +X (negative swings the wheel aft)
 */
import { CONFIG } from '../config';
import type { AircraftVisualState } from './types';

const DEG = Math.PI / 180;

export interface AircraftAnimation {
  elevatorRad: number;
  aileronLeftRad: number;
  aileronRightRad: number;
  rudderRad: number;
  trimTabRad: number;
  flapRad: number;
  /** Flap run-out along the chord (m aft) and drop (m down). */
  flapSlide: number;
  flapDrop: number;
  /** 0 = down and locked … 1 = stowed. */
  noseGearRetract: number;
  mainGearRetract: number;
  noseGearAngleRad: number;
  /** Nose gear door opening, radians (0 = shut). */
  gearDoorRad: number;
  noseSteerRad: number;
  /** 0 = solid blades … 1 = blurred disc. */
  propBlend: number;
  /** Yoke pulled toward the pilot (m), turned right (rad, clockwise as the pilot sees it). */
  yokePull: number;
  yokeRollRad: number;
  /** Right pedal pushed forward (m); the left pedal moves back by the same amount. */
  pedalRight: number;
  /** 0..1 light intensities. */
  nav: number;
  strobe: number;
  beacon: number;
  landing: number;
  taxi: number;
}

export function createAnimation(): AircraftAnimation {
  return {
    elevatorRad: 0,
    aileronLeftRad: 0,
    aileronRightRad: 0,
    rudderRad: 0,
    trimTabRad: 0,
    flapRad: 0,
    flapSlide: 0,
    flapDrop: 0,
    noseGearRetract: 0,
    mainGearRetract: 0,
    noseGearAngleRad: 0,
    gearDoorRad: 0,
    noseSteerRad: 0,
    propBlend: 0,
    yokePull: 0,
    yokeRollRad: 0,
    pedalRight: 0,
    nav: 0,
    strobe: 0,
    beacon: 0,
    landing: 0,
    taxi: 0,
  };
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const clamp1 = (v: number) => clamp(Number.isFinite(v) ? v : 0, -1, 1);

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

const _gear = { nose: 0, main: 0, door: 0 };

/**
 * Door opening fraction of gearPos (the doors swing in this first slice of the
 * cycle), and where each leg's travel starts/ends. Extending (gearPos 0 → 1):
 * the nose doors open, then the legs come down (the nose leg a touch ahead of the
 * mains, as the hydraulic flow divides), the doors stay open with the gear down
 * (the 172RG's nose doors are linked open). Retracting runs the same in reverse:
 * legs up, then the doors close behind the nose wheel.
 */
export const GEAR_SEQUENCE = { doorEnd: 0.13, noseStart: 0.15, noseEnd: 0.9, mainStart: 0.18, mainEnd: 1 } as const;

/** Leg and door motion for a gear position (0 = up … 1 = down). Returns a shared object. */
export function gearRetraction(gearPos: number): { nose: number; main: number; door: number } {
  const g = clamp(Number.isFinite(gearPos) ? gearPos : 1, 0, 1);
  const q = GEAR_SEQUENCE;
  _gear.nose = 1 - smoothstep(q.noseStart, q.noseEnd, g);
  _gear.main = 1 - smoothstep(q.mainStart, q.mainEnd, g);
  _gear.door = smoothstep(0, q.doorEnd, g);
  return _gear;
}

/** 0 = crisp blades, 1 = full blur disc. */
export function propBlurBlend(rpm: number): number {
  const m = CONFIG.aircraft.model;
  if (!(rpm > m.propBlurStartRpm)) return 0;
  if (rpm >= m.propBlurFullRpm) return 1;
  return smoothstep(m.propBlurStartRpm, m.propBlurFullRpm, rpm);
}

export interface PropDisc {
  /** 0 = crisp blades … 1 = full blur (propBlurBlend). */
  blend: number;
  bladeOpacity: number;
  /** Peak alpha of the time-averaged disc, and of the painted-tip ring. */
  discAlpha: number;
  tipAlpha: number;
  /** How far the tip ring leans toward the tip paint colour (0 = plain disc tone). */
  tipTint: number;
  /** Strength of the stroboscopic two-blade ghost in the disc. */
  ghost: number;
  /** Draw the blades at the aliased (stroboscopic) angle instead of the true one. */
  strobe: boolean;
}

export function createPropDisc(): PropDisc {
  return { blend: 0, bladeOpacity: 1, discAlpha: 0, tipAlpha: 0, tipTint: 0, ghost: 0, strobe: false };
}

/**
 * How the spinning propeller reads: stopped → crisp blades; around idle the
 * blades flicker stroboscopically (drawn at a slowly drifting aliased angle, with
 * a ghost in the disc); at speed a faint, slightly dark translucent disc with a
 * barely-there tip ring. From the cockpit the disc is nearly invisible, as it is
 * to a real pilot.
 */
export function propDiscParams(rpm: number, cockpit: boolean, out: PropDisc): PropDisc {
  const r = Number.isFinite(rpm) ? Math.max(0, rpm) : 0;
  const idle = CONFIG.aircraft.engine.idleRpm;
  const b = propBlurBlend(r);
  const view = cockpit ? 0.3 : 1;
  out.blend = b;
  out.bladeOpacity = 1 - b;
  out.discAlpha = b * 0.075 * view;
  out.tipAlpha = out.discAlpha * 1.25;
  out.tipTint = cockpit ? 0.1 : 0.2;
  out.ghost = Math.min(2 * b, 0.45 * (1 - smoothstep(0.9 * idle, 1800, r))) * view;
  out.strobe = r > CONFIG.aircraft.model.propBlurStartRpm;
  return out;
}

/** Apparent (aliased) rotation rate of the blades, rad/s: a slow wagon-wheel drift that changes with rpm. */
export function strobeRate(rpm: number): number {
  const r = Number.isFinite(rpm) ? Math.max(0, Math.min(rpm, 5000)) : 0;
  return 2 * Math.PI * 0.4 * Math.sin(r * 0.0021);
}

/** Wingtip strobe brightness at time t: a short full-brightness flash once per period. */
export function strobeIntensity(time: number): number {
  const m = CONFIG.aircraft.model;
  const phase = ((time % m.strobePeriodS) + m.strobePeriodS) % m.strobePeriodS;
  return phase < m.strobeFlashS ? 1 : 0;
}

/** Rotating red beacon brightness at time t: a smooth sweep once per period, peak at phase 0. */
export function beaconIntensity(time: number): number {
  const m = CONFIG.aircraft.model;
  const phase = (((time % m.beaconPeriodS) + m.beaconPeriodS) % m.beaconPeriodS) / m.beaconPeriodS;
  const c = Math.cos(2 * Math.PI * phase);
  return c > 0 ? Math.pow(c, 6) : 0;
}

export function computeAnimation(v: AircraftVisualState, out: AircraftAnimation): AircraftAnimation {
  const s = CONFIG.aircraft.surfaces;
  const m = CONFIG.aircraft.model;

  const elev = clamp1(v.elevator);
  const ail = clamp1(v.aileron);
  const rud = clamp1(v.rudder);

  out.elevatorRad = -elev * s.elevatorMaxDeg * DEG;
  const up = s.aileronMaxDeg * DEG;
  const down = up * m.aileronDownRatio;
  // + aileron = roll right: right aileron up (TE up = negative), left aileron down.
  out.aileronRightRad = ail >= 0 ? -ail * up : -ail * down;
  out.aileronLeftRad = ail >= 0 ? ail * down : ail * up;
  out.rudderRad = rud * s.rudderMaxDeg * DEG;
  out.trimTabRad = clamp1(v.trim) * s.trimTabMaxDeg * DEG;

  const flapDeg = clamp(Number.isFinite(v.flapsDeg) ? v.flapsDeg : 0, 0, s.flapMaxDeg);
  const f = flapDeg / s.flapMaxDeg;
  out.flapRad = flapDeg * DEG;
  // The slotted flap runs out on curved tracks: most of the slide comes early.
  out.flapSlide = m.flapSlideM * Math.sin((f * Math.PI) / 2);
  out.flapDrop = m.flapDropM * f;

  const g = gearRetraction(v.gearPos);
  out.noseGearRetract = g.nose;
  out.mainGearRetract = g.main;
  out.noseGearAngleRad = -g.nose * m.noseGearRetractDeg * DEG;
  out.gearDoorRad = g.door * m.gearDoorOpenDeg * DEG;
  // Steering only when the leg is down and locked (the nose leg centres itself before retracting).
  out.noseSteerRad = clamp1(v.nosewheelSteer) * s.nosewheelSteerMaxDeg * DEG * (1 - g.nose);

  out.propBlend = propBlurBlend(v.propRpm);

  out.yokePull = elev * m.yokeTravelM;
  out.yokeRollRad = ail * m.yokeRollMaxDeg * DEG;
  out.pedalRight = rud * m.pedalTravelM;

  const L = v.lights;
  out.nav = L.nav ? 1 : 0;
  out.strobe = L.strobe ? strobeIntensity(v.time) : 0;
  out.beacon = L.beacon ? beaconIntensity(v.time) : 0;
  out.landing = L.landing ? 1 : 0;
  out.taxi = L.taxi ? 1 : 0;
  return out;
}
