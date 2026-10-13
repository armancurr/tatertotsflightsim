/**
 * PURE mappings for the personal watercraft (aircraft sound 'pwc'; the Sea-Doo RXP-X 325): a Rotax
 * 1630 ACE (1.6 l in-line three-cylinder 4-stroke, gear-driven supercharger, idle 1,700 rpm, limiter
 * 8,000 rpm) driving the jet pump's impeller directly, and a small planing hull. No WebAudio here;
 * every function is total (NaN/±∞ in, finite and bounded out).
 *
 * What a jet ski sounds like, and where it comes from:
 *   - the engine: a 3-cylinder 4-stroke fires 1.5 times per revolution, rpm/40 Hz (42.5 Hz at idle,
 *     200 Hz on the limiter). The three pulses are never quite equal: the half-order (rpm/120, one
 *     cycle) roughness that gives a triple its uneven, raspy growl. Under load the note hardens into a
 *     snarl (a gated rasp at every firing); at idle the waterline exhaust at the stern is wet and gurgly.
 *   - the supercharger: gear-driven, ≈5.6 × crank speed (≈45,000 rpm on the limiter); its compressor
 *     wheel's blade passage is a clear whine, 1.3 kHz at idle rising to ≈6 kHz, louder with boost and
 *     load. Chopping the throttle at high rpm dumps the boost: a quick whoosh (the "blow-off").
 *   - the pump: water roaring through the impeller and out of the nozzle, growing with the flow and the
 *     jet's speed; a faint impeller blade tone (4 blades → 4 × rpm/60); cavitation churn on hard
 *     launches (high load, low speed). Airborne off a wave the intake sucks air: the water roar is gone,
 *     a hollow, fluttering sputter instead, and the ECU cuts the engine to ≈4,200 rpm (the note drops).
 *     Landing brings the load back with a slam and a splash.
 *   - the hull: a small planing hull slaps off every wave at speed (frequent, sharp slaps), spray
 *     hiss, the displacement gurgle at low speed.
 *   - the rider sits on it in the open air (cockpit view): the engine under the seat (more low end, a
 *     structure-borne rumble), the water and the wind loud; no cabin.
 *
 * Constants live here (not in CONFIG.audio) because only this voice uses them.
 */
import type { AudioInputs, AudioLevels, MarineEngineAudioInputs } from './types';
import { hullMotion } from './marineMapping';

export const PWC = {
  /** Rotax 1630 ACE: 3 cylinders in line, 4-stroke; idle, limiter and the ECU's ventilation cut, rpm. */
  cylinders: 3,
  idleRpm: 1700,
  maxRpm: 8000,
  ventRpm: 4200,
  /** Impeller blades (the impeller turns at engine speed). */
  impellerBlades: 4,
  /** Supercharger step-up ratio from the crank and its compressor wheel's blades (the whine is their passage). */
  scRatio: 5.6,
  scBlades: 8,
  /** Pump flow, m³/s, and jet speed, m/s, at full throttle; top speed, kt (governed). */
  maxFlow: 0.28,
  maxJetSpeed: 48,
  fullSpeedKt: 58,
  /** Engine run-down after a stop: time constant of the audible rpm decay (the impeller in the water brakes it hard), s; it stops below stopRpm. */
  rundownTauS: 0.28,
  stopRpm: 300,
  /** The stop "cough" plays as the run-down passes this rpm. */
  coughRpm: 650,
  /** Blow-off: the throttle is chopped above this rpm from at least this load; the load must fall by this much. */
  blowOffRpm: 5000,
  blowOffLoad: 0.5,
  blowOffDrop: 0.35,
  /** A landing after at least this much time ventilating (airborne), s. */
  minAirS: 0.2,
  /** Overall level relative to the Cessna's engine; the exterior path level in the rider's view. */
  volume: 1.4,
  cockpitGain: 0.9,
  /** Rider's view: the engine under the seat (engine bus level), the water around you, the seat rumble (cabin path). */
  cockpitEngines: 1.05,
  cockpitWater: 1.15,
  cabinRumble: 0.3,
  /** The rider's ears in the open air: the view low-pass, Hz (no cabin; a little head shadow), and the low shelf, dB. */
  riderCutoffHz: 9000,
  riderShelfDb: 2,
  /** Channel levels before engineVolume × volume. */
  tone: 0.2,
  rasp: 0.1,
  exhaust: 0.4,
  gurgle: 0.5,
  whine: 0.03,
  mech: 0.05,
  roar: 0.34,
  nozzle: 0.1,
  blade: 0.025,
  cavitation: 0.16,
  vent: 0.75,
  starter: 0.3,
  crank: 0.4,
  rush: 0.3,
  hiss: 0.09,
  wash: 0.5,
  skim: 0.1,
  grind: 0.35,
  grindRumble: 0.6,
  /** One-shots. */
  catchLevel: 0.7,
  coughLevel: 0.5,
  blowOffLevel: 0.5,
  clunkLevel: 0.6,
  slapLevel: 0.8,
  landingLevel: 0.85,
  /** Apparent wind (CONFIG.audio wind) scaled for a jet ski: from the chase camera, and in the rider's ears. */
  windExterior: 0.55,
  windRider: 1.1,
  /** Exterior views: full level within this distance, m (the chase camera sits ≈9 m behind a 3.5 m craft). */
  refDistanceM: 10,
};

const P = PWC;
const num = (v: number): number => (Number.isNaN(v) ? 0 : v);
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number): number => clamp(num(v), 0, 1);
function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((num(x) - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}
const fin = (v: number | undefined, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
/** Highest engine speed the sound model accepts, rpm (overspeed margin). */
const MAX_RPM = 1.25 * P.maxRpm;
const rpmOf = (rpm: number): number => clamp(num(rpm), 0, MAX_RPM);
const MS_TO_KT = 1.943844;

// ── Frequencies ─────────────────────────────────────────────────────────────

/** Firing frequency of the 3-cylinder 4-stroke, Hz: rpm/60 × 1.5 (42.5 Hz at idle, 200 Hz at 8,000). */
export function pwcFiringHz(rpm: number): number {
  return (rpmOf(rpm) / 60) * (P.cylinders / 2);
}

/** One complete 4-stroke cycle (two revolutions), Hz: the half-order roughness. */
export function pwcCycleHz(rpm: number): number {
  return rpmOf(rpm) / 120;
}

/** Impeller blade passage (the impeller turns at engine speed), Hz. */
export function impellerBladeHz(rpm: number): number {
  return (rpmOf(rpm) / 60) * P.impellerBlades;
}

/** Supercharger whine: the compressor wheel's blade passage, Hz (≈1.3 kHz at idle, ≈6 kHz on the limiter). */
export function superchargerWhineHz(rpm: number): number {
  return Math.min(16000, (rpmOf(rpm) / 60) * P.scRatio * P.scBlades);
}

/** Gear (iBR bucket) as a number from the propulsor's gear sign: +1 ahead, 0 neutral, −1 astern. */
export function bucketGear(gear: number): number {
  const g = fin(gear, 0);
  return g > 0.5 ? 1 : g < -0.5 ? -1 : 0;
}

/**
 * The audible engine rpm: follows the physics while the engine runs; after a stop it runs down no faster
 * than exp(−dt/rundownTau) (the impeller in the water brakes it quickly), and stops below stopRpm.
 */
export function pwcRundownRpm(prevRpm: number, rpm: number, running: boolean, dt: number): number {
  const target = rpmOf(rpm);
  if (running) return target;
  const d = clamp(num(dt), 0, 1);
  const decayed = rpmOf(prevRpm) * Math.exp(-d / P.rundownTauS);
  const r = Math.max(target, decayed);
  return r < P.stopRpm ? target : r;
}

// ── The engine ──────────────────────────────────────────────────────────────

/** The engine's mix (levels 0..1 before the voice's channel gains; Hz). */
export interface PwcEngineMix {
  firingHz: number;
  cycleHz: number;
  /** Combustion present 0..1 (running and above the firing speed). */
  combustion: number;
  /** The load the engine is actually under (ventilation takes it away), 0..1. */
  load: number;
  /** Firing tone, its brightness 0..1 and the drive into the "hard" waveshaper (buzzy triple; harder under load). */
  tone: number;
  bright: number;
  drive: number;
  /** The snarl: a noise band gated at every firing, loudest under load; its centre, Hz. */
  rasp: number;
  raspHz: number;
  /** Waterline exhaust, its low-pass (dull and wet at idle, opening under load), Hz; the wet gurgle at idle. */
  exhaust: number;
  exhaustLpHz: number;
  gurgle: number;
  /** Supercharger whine level and pitch. */
  whine: number;
  whineHz: number;
  /** Rotating machinery whirr (also while running down). */
  mech: number;
}

export function emptyPwcEngineMix(): PwcEngineMix {
  return {
    firingHz: 0, cycleHz: 0, combustion: 0, load: 0, tone: 0, bright: 0, drive: 0.3, rasp: 0, raspHz: 1500, exhaust: 0,
    exhaustLpHz: 260, gurgle: 0, whine: 0, whineHz: superchargerWhineHz(0), mech: 0,
  };
}

/** Levels and frequencies of the Rotax. `ventilation` 0..1 takes the load off (the pump sucks air). Writes into `out` (no allocation). */
export function pwcEngineMix(
  rpmIn: number, loadIn: number, boostIn: number, ventilationIn: number, running: boolean, crashed: boolean, out?: PwcEngineMix,
): PwcEngineMix {
  const o = out ?? emptyPwcEngineMix();
  const rpm = rpmOf(rpmIn);
  const rpmN = clamp01(rpm / P.maxRpm);
  const vent = clamp01(ventilationIn);
  const load = clamp01(num(loadIn)) * (1 - 0.8 * vent);
  const boost = clamp01(num(boostIn)) * (1 - 0.6 * vent);
  o.firingHz = pwcFiringHz(rpm);
  o.cycleHz = pwcCycleHz(rpm);
  o.whineHz = superchargerWhineHz(rpm);
  if (crashed) {
    o.combustion = o.load = o.tone = o.bright = o.rasp = o.exhaust = o.gurgle = o.whine = o.mech = 0;
    o.drive = 0.3;
    o.raspHz = 1500;
    o.exhaustLpHz = 260;
    return o;
  }
  const comb = running ? smoothstep(350, 1100, rpm) : 0;
  o.combustion = comb;
  o.load = running ? load : 0;
  o.tone = clamp01(comb * (0.3 + 0.3 * rpmN + 0.45 * load));
  o.bright = clamp01(0.15 + 0.4 * rpmN + 0.45 * load);
  o.drive = 0.3 + 0.4 * rpmN + 1.8 * load;
  o.rasp = clamp01(comb * (0.12 + 0.33 * rpmN + 0.6 * load));
  o.raspHz = 1100 + 900 * rpmN + 1600 * load;
  o.exhaust = clamp01(comb * (0.35 + 0.3 * rpmN + 0.4 * load));
  o.exhaustLpHz = 240 + 1000 * rpmN + 700 * load;
  // The outlet is at the waterline: wet and gurgly at idle, blown clear as the revs rise.
  o.gurgle = clamp01(comb * (1 - smoothstep(2400, 4800, rpm)) * (1 - 0.6 * vent));
  // Gear-driven: the whine spins with the crank (it winds down with the run-down), louder with boost and load.
  o.whine = clamp01(smoothstep(500, 2500, rpm) * (0.25 + 0.75 * rpmN) * (0.25 + 0.75 * Math.max(boost, load)));
  o.mech = clamp01(smoothstep(50, 800, rpm) * (0.35 + 0.65 * rpmN));
  return o;
}

// ── The pump ────────────────────────────────────────────────────────────────

/** The jet pump (levels 0..1, Hz). */
export interface PwcPumpMix {
  /** Water roaring through the impeller and the nozzle, and its band centre, Hz. */
  roar: number;
  roarHz: number;
  /** The jet's hiss out of the nozzle. */
  nozzle: number;
  /** The impeller blade tone (faint) and its frequency, Hz. */
  blade: number;
  bladeHz: number;
  /** Cavitation churn (hard launch: high load, low speed). */
  cavitation: number;
  /** Ventilation: the hollow, fluttering air-sucking sputter; its flutter rate and band, Hz. */
  vent: number;
  ventRateHz: number;
  ventBandHz: number;
}

export function emptyPwcPumpMix(): PwcPumpMix {
  return { roar: 0, roarHz: 280, nozzle: 0, blade: 0, bladeHz: 0, cavitation: 0, vent: 0, ventRateHz: 9, ventBandHz: 350 };
}

/**
 * The pump from its state: engine (= impeller) rpm, flow m³/s, jet speed m/s, engine load 0..1, craft speed
 * m/s and ventilation 0..1. Writes into `out` (no allocation).
 */
export function pwcPumpMix(
  rpmIn: number, flowIn: number, jetSpeedIn: number, loadIn: number, speedMs: number, ventilationIn: number, crashed: boolean,
  out?: PwcPumpMix,
): PwcPumpMix {
  const o = out ?? emptyPwcPumpMix();
  const rpm = rpmOf(rpmIn);
  const rpmN = clamp01(rpm / P.maxRpm);
  o.bladeHz = impellerBladeHz(rpm);
  o.ventRateHz = 9 + 16 * rpmN;
  o.ventBandHz = 350 + 550 * rpmN;
  const jN = clamp01(Math.abs(num(jetSpeedIn)) / P.maxJetSpeed);
  const fN = clamp01(Math.abs(num(flowIn)) / P.maxFlow);
  o.roarHz = 280 + 1400 * jN;
  if (crashed) {
    o.roar = o.nozzle = o.blade = o.cavitation = o.vent = 0;
    return o;
  }
  const vent = clamp01(ventilationIn);
  const wet = 1 - vent;
  const turning = smoothstep(300, P.idleRpm, rpm);
  o.roar = clamp01(wet * (0.08 * turning + 0.55 * fN + 0.45 * Math.pow(jN, 1.3)));
  o.nozzle = clamp01(Math.pow(jN, 1.5) * (1 - 0.8 * vent));
  o.blade = clamp01(wet * smoothstep(500, 2500, rpm) * (0.3 + 0.7 * fN));
  const kt = Math.abs(num(speedMs)) * MS_TO_KT;
  o.cavitation = clamp01(wet * Math.pow(clamp01(num(loadIn)), 1.5) * (1 - smoothstep(6, 26, kt)) * smoothstep(3000, 6000, rpm));
  o.vent = clamp01(Math.pow(vent, 0.8) * smoothstep(900, 3500, rpm));
  return o;
}

// ── The hull ────────────────────────────────────────────────────────────────

/** The small planing hull in the water (levels 0..1, Hz, slaps per second). */
export interface PwcWaterMix {
  speedKt: number;
  /** Out of the water (a jump) 0..1: the water sounds fall away. */
  air: number;
  /** Water rushing along the hull and its band centre, Hz; the spray hiss. */
  rush: number;
  rushHz: number;
  hiss: number;
  /** Displacement gurgle / wash at low speed. */
  wash: number;
  /** Planing skim. */
  skim: number;
  /** Hull motion relative to the water 0..1. */
  motion: number;
  /** Expected slaps per second and their intensity 0..1. */
  slapRate: number;
  slapIntensity: number;
  /** Aground: grinding 0..1. */
  grind: number;
}

export function emptyPwcWaterMix(): PwcWaterMix {
  return { speedKt: 0, air: 0, rush: 0, rushHz: 500, hiss: 0, wash: 0, skim: 0, motion: 0, slapRate: 0, slapIntensity: 0, grind: 0 };
}

/** Water sounds from the hull's state; `ventilation` stands for "out of the water" (a jump). */
export function pwcWaterMix(
  speedMs: number, planing: number, heaveMs: number, pitchRate: number, rollRate: number, aground: boolean, ventilation: number,
  out?: PwcWaterMix,
): PwcWaterMix {
  const o = out ?? emptyPwcWaterMix();
  const kt = clamp(Math.abs(num(speedMs)) * MS_TO_KT, 0, 90);
  const pl = clamp01(planing);
  const sN = clamp01(kt / P.fullSpeedKt);
  const air = smoothstep(0.35, 0.8, clamp01(ventilation));
  o.speedKt = kt;
  o.air = air;
  o.rush = clamp01(Math.pow(sN, 1.1) * 1.05) * (1 - 0.85 * air);
  o.rushHz = 500 + 2600 * Math.pow(sN, 0.8);
  o.hiss = clamp01(Math.pow(sN, 1.5)) * (1 - 0.7 * air);
  o.wash = clamp01(smoothstep(0.5, 6, kt) * (1 - 0.85 * smoothstep(0.3, 0.75, pl)) * (0.5 + 0.5 * smoothstep(3, 12, kt))) * (1 - air);
  o.skim = clamp01(smoothstep(0.45, 0.8, pl) * smoothstep(12, 35, kt)) * (1 - air);
  const motion = hullMotion(heaveMs, pitchRate, rollRate);
  o.motion = motion;
  // A small planing hull slaps off every wave at speed: frequent, sharp slaps (none in the air).
  o.slapRate = clamp((0.9 + 4 * motion + 0.16 * kt * (0.35 + 0.65 * motion)) * (1 - air), 0, 14);
  o.slapIntensity = clamp01(0.15 + 0.5 * motion + 0.3 * smoothstep(5, 45, kt) * (0.3 + 0.7 * motion) + 0.2 * pl * motion);
  o.grind = aground ? clamp01(0.35 + 0.65 * smoothstep(0.3, 8, kt)) : 0;
  return o;
}

/** The apparent wind's level scale for a jet ski (CONFIG.audio's wind is an aircraft's): the rider has it in the ears. */
export function pwcWindScale(exterior: boolean): number {
  return exterior ? P.windExterior : P.windRider;
}

// ── Events ──────────────────────────────────────────────────────────────────

/** The blow-off detector's memory (see blowOffStep). */
export interface BlowOffState {
  /** The load, slowly smoothed. */
  slow: number;
  /** Armed by a loaded engine; fires once, re-armed by the next loaded run. */
  armed: boolean;
}

export const newBlowOff = (): BlowOffState => ({ slow: 0, armed: false });

/**
 * One frame of the blow-off detector: true on the frame the throttle is chopped at high rpm (the load
 * falls fast from a loaded run, the pump not ventilating — the ECU's cut is not a blow-off).
 */
export function blowOffStep(s: BlowOffState, rpm: number, load: number, ventilation: number, running: boolean, dt: number): boolean {
  const d = clamp(num(dt), 0, 1);
  const l = clamp(num(load), 0, 1.5);
  if (!Number.isFinite(s.slow)) s.slow = 0;
  s.slow += (l - s.slow) * (1 - Math.exp(-d / 0.35));
  if (!running) {
    s.armed = false;
    return false;
  }
  if (l > P.blowOffLoad + 0.05 && rpmOf(rpm) > P.blowOffRpm) s.armed = true;
  if (s.armed && d > 0 && clamp01(ventilation) < 0.4 && rpmOf(rpm) > P.blowOffRpm * 0.8 && s.slow > P.blowOffLoad && l < s.slow - P.blowOffDrop) {
    s.armed = false;
    return true;
  }
  return false;
}

/** The jump detector's memory (see landingStep). */
export interface AirState {
  /** Time spent ventilating (in the air), s. */
  air: number;
  /** The most negative hull heave (falling) seen in the air, m/s. */
  minHeave: number;
}

export const newAirState = (): AirState => ({ air: 0, minHeave: 0 });

/**
 * One frame of the jump detector: returns the landing's intensity 0.3..1 on the frame the intake is back in
 * the water after at least minAirS in the air (longer flights and harder descents land harder), else 0.
 */
export function landingStep(s: AirState, ventilation: number, heaveMs: number, dt: number): number {
  const v = clamp01(ventilation);
  const d = clamp(num(dt), 0, 1);
  if (!Number.isFinite(s.air)) s.air = 0;
  if (!Number.isFinite(s.minHeave)) s.minHeave = 0;
  if (v > 0.6) {
    s.air = Math.min(30, s.air + d);
    s.minHeave = Math.min(s.minHeave, clamp(num(heaveMs), -30, 30));
    return 0;
  }
  if (v >= 0.3) return 0;
  const air = s.air;
  const fall = -Math.min(s.minHeave, clamp(num(heaveMs), -30, 30));
  s.air = 0;
  s.minHeave = 0;
  if (air < P.minAirS) return 0;
  return clamp(0.3 + 0.4 * smoothstep(P.minAirS, 1.5, air) + 0.3 * smoothstep(0.5, 5, fall), 0.3, 1);
}

// ── Inputs ──────────────────────────────────────────────────────────────────

/** The jet ski's propulsor as the voice uses it (sanitised: finite, bounded; jet fields estimated when absent). */
export interface PwcEngineInputs {
  rpm: number;
  load: number;
  boost: number;
  gear: number;
  thrustN: number;
  flow: number;
  jetSpeed: number;
  ventilation: number;
  bucket: number;
}

export const emptyPwcEngine = (): PwcEngineInputs => ({ rpm: 0, load: 0, boost: 0, gear: 0, thrustN: 0, flow: 0, jetSpeed: 0, ventilation: 0, bucket: 0 });

/**
 * Copy the propulsor's inputs, sanitised. Without a propulsor (QA override, no vessel state) the engine
 * follows `a.rpm` / `a.power`. Missing jet fields are estimated from rpm (the pump's flow and jet speed
 * scale with the impeller speed).
 */
export function sanitisePwcEngine(e: MarineEngineAudioInputs | undefined, a: AudioInputs, out: PwcEngineInputs): PwcEngineInputs {
  if (e) {
    out.rpm = rpmOf(fin(e.rpm, 0));
    out.load = clamp(fin(e.load, 0), 0, 1.5);
    out.boost = clamp01(fin(e.boost, 0));
    out.gear = bucketGear(e.gear);
    out.thrustN = clamp(fin(e.thrustN, 0), -1e6, 1e6);
  } else {
    const p = clamp01(fin(a.power, 0));
    out.rpm = rpmOf(fin(a.rpm, 0));
    out.load = p;
    out.boost = p;
    out.gear = 0;
    out.thrustN = 0;
  }
  const spin = clamp01((out.rpm - 0.5 * P.idleRpm) / (P.maxRpm - 0.5 * P.idleRpm));
  out.flow = clamp(Math.abs(fin(e?.flow, spin * P.maxFlow)), 0, 2 * P.maxFlow);
  out.jetSpeed = clamp(Math.abs(fin(e?.jetSpeed, spin * P.maxJetSpeed)), 0, 2 * P.maxJetSpeed);
  out.ventilation = clamp01(fin(e?.ventilation, 0));
  out.bucket = clamp01(fin(e?.bucket, out.gear < 0 ? 1 : out.gear === 0 ? 0.5 : 0));
  return out;
}

/** The other voices' frames (audio.ts calls this for them): the pwc-only channels are silent. */
export function zeroPwcLevels(L: AudioLevels): void {
  L.pwc = 0;
  L.pump = 0;
  L.pumpVent = 0;
}

// ── Waveform ────────────────────────────────────────────────────────────────

/**
 * One full 4-stroke cycle (two crank revolutions) of an in-line triple: three exhaust pulses a third of a
 * cycle apart (240° of crank), slightly unequal in strength and timing — the half-order roughness of a
 * triple's growl. Short, sharp spark-ignition blowdowns with a little ring (the buzzy, raspy edge).
 * Peak-normalised.
 */
export function tripleCycleWaveform(n: number): Float32Array {
  const len = Math.max(8, Math.floor(fin(n, 8)));
  const s = new Float32Array(len);
  const amps = [1, 0.8, 0.9];
  const shift = [0, 0.014, -0.009];
  const decay = [0.032, 0.027, 0.036];
  for (let j = 0; j < len; j++) {
    const t = j / len;
    let v = 0;
    for (let c = 0; c < 3; c++) {
      let dt = t - (c / 3 + shift[c]);
      dt -= Math.floor(dt);
      const rise = 1 - Math.exp(-dt / 0.0022);
      const ring = 0.14 * Math.exp(-dt / 0.012) * Math.sin(2 * Math.PI * dt * 38);
      v += amps[c] * (rise * (Math.exp(-dt / decay[c]) - 0.14 * Math.exp(-dt / (decay[c] * 2.6)) * Math.min(1, dt / decay[c])) + ring);
    }
    s[j] = v;
  }
  let mean = 0;
  for (let j = 0; j < len; j++) mean += s[j];
  mean /= len;
  let peak = 0;
  for (let j = 0; j < len; j++) {
    s[j] -= mean;
    peak = Math.max(peak, Math.abs(s[j]));
  }
  if (peak > 0) for (let j = 0; j < len; j++) s[j] /= peak;
  return s;
}
