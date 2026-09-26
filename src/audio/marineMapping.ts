/**
 * PURE mappings for motor yachts (aircraft sound 'marineDiesel'; the Princess V50): twin Volvo Penta
 * D6-435 diesels (6-cylinder in-line, 4-stroke, turbocharged, 700 … 3500 rpm) driving IPS 600 pod
 * drives with twin counter-rotating propellers, and the hull in the water. No WebAudio here; every
 * function is total (NaN/±∞ in, finite and bounded out).
 *
 * What a V50 sounds like, and where it comes from:
 *   - the diesels: a 6-cylinder 4-stroke fires 3 times per revolution, rpm/20 Hz (35 Hz at idle,
 *     175 Hz flat out). Two engines on one governor never run quite together: a slow beat. Compression
 *     ignition makes the pressure rise steep, hence the gritty clatter (a knock at every firing, loudest
 *     at idle and under load). Under load the note hardens and brightens; the turbos whistle with boost.
 *   - the exhaust: IPS drives exhaust through the propeller hubs, underwater. What you hear is a muffled,
 *     bubbly burble behind the boat; at idle part of it leaves through the idle-relief ports above the
 *     water, a more open chug.
 *   - the propellers: a low blade-rate thrum through the hull; heavily loaded (lots of thrust, little
 *     speed) they churn and cavitate.
 *   - the water: slaps against the hull (lapping at rest, slapping in a chop, slamming off wave crests
 *     when planing), the rush of water along the hull growing with speed, the bow wave's wash at
 *     displacement speeds and the steady hiss/skim once she is up on the plane; grinding when aground.
 *   - inside the saloon (cockpit view) the engines are below the floor: muffled low rumble, the hull
 *     louder; the wind is small.
 *
 * Constants live here (not in CONFIG.audio) because only this voice uses them.
 */
import type { AudioInputs, AudioLevels, MarineEngineAudioInputs } from './types';

export const MARINE = {
  /** D6-435: 6 cylinders in line, 4-stroke; idle and rated rpm. */
  cylinders: 6,
  idleRpm: 700,
  maxRpm: 3500,
  /** Engine rpm per propeller revolution (IPS 600) and the blades heard (4-blade forward propeller). */
  gearRatio: 1.82,
  propBlades: 4,
  /** The starboard engine runs this fraction faster than the port one (the beat), plus a slow wander. */
  detune: 0.0045,
  detuneWander: 0.0018,
  /** Reference thrust per propulsor (≈ full power at cruise), N; full speed, kt. */
  refThrustN: 16000,
  fullSpeedKt: 34,
  /** Turbo whistle pitch range, Hz (compressor wheel tone, rises with boost and rpm). */
  turboMinHz: 2300,
  turboMaxHz: 7200,
  /** Engine run-down after a stop: time constant of the audible rpm decay, s; the "shudder" below this rpm. */
  rundownTauS: 0.5,
  shudderRpm: 140,
  /** Overall level relative to the Cessna's engine; the exterior path in the saloon (cockpit view). */
  volume: 1.25,
  cockpitGain: 0.4,
  /** Engines under the saloon floor: their low-pass in the cockpit view, Hz, and the engine-bus level there. */
  cockpitEngineLpHz: 700,
  cockpitEngines: 0.75,
  /** The hull is louder inside (you sit in it). */
  cockpitWater: 1.35,
  /** Structure-borne engine rumble, cockpit only. */
  cabinRumble: 0.25,
  /** Channel levels before engineVolume × volume. */
  tone: 0.17,
  clatter: 0.1,
  exhaust: 0.45,
  bubble: 0.25,
  turbo: 0.018,
  mech: 0.05,
  prop: 0.16,
  cavitation: 0.12,
  starter: 0.3,
  crank: 0.55,
  rush: 0.3,
  hiss: 0.07,
  wash: 0.55,
  skim: 0.09,
  grind: 0.35,
  grindRumble: 0.6,
  /** One-shots. */
  catchLevel: 0.9,
  clunkLevel: 0.7,
  shudderLevel: 0.6,
  slapLevel: 0.9,
  /** Apparent wind (CONFIG.audio wind) scaled for a boat: on deck, and inside the saloon. */
  windExterior: 0.6,
  windCabin: 0.12,
  /** Exterior views: full level within this distance, m (the chase camera sits well behind a 15 m boat). */
  refDistanceM: 25,
};

const M = MARINE;
const num = (v: number): number => (Number.isNaN(v) ? 0 : v);
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number): number => clamp(num(v), 0, 1);
function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((num(x) - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}
const fin = (v: number | undefined, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
/** Highest engine speed the sound model accepts, rpm (overspeed margin). */
const MAX_RPM = 1.3 * M.maxRpm;
const rpmOf = (rpm: number): number => clamp(num(rpm), 0, MAX_RPM);
const MS_TO_KT = 1.943844;
/** Below this the run-down ends (the last compression stroke stops the engine), rpm. */
const STOP_RPM = 60;

/** Firing frequency of the 6-cylinder 4-stroke, Hz: rpm/60 × 3 = rpm/20 (35 Hz at idle, 175 Hz at 3500). */
export function marineFiringHz(rpm: number): number {
  return (rpmOf(rpm) / 60) * (M.cylinders / 2);
}

/** One complete 4-stroke cycle (two revolutions), Hz. */
export function marineCycleHz(rpm: number): number {
  return rpmOf(rpm) / 120;
}

/** Propeller blade passage from the propeller speed (rev/s, either sign), Hz. */
export function propBladeHz(propRps: number): number {
  return clamp(Math.abs(num(propRps)), 0, MAX_RPM / 60) * M.propBlades;
}

/** Turbo compressor whistle, Hz: rises with rpm and boost. */
export function turboWhistleHz(rpm: number, boost: number): number {
  const r = rpmOf(rpm) / M.maxRpm;
  const spin = clamp01(0.35 * r + 0.65 * clamp01(boost) * Math.sqrt(clamp01(r)));
  return M.turboMinHz + (M.turboMaxHz - M.turboMinHz) * spin;
}

/** Gearbox as a number: +1 ahead, 0 neutral, −1 astern. */
export function gearSign(gear: unknown): number {
  return gear === 'ahead' ? 1 : gear === 'astern' ? -1 : 0;
}

/**
 * The audible engine rpm: follows the physics while the engine runs; after a stop it runs down no
 * faster than exp(−dt/rundownTau) (the flywheel and the propeller in the water keep it turning briefly).
 */
export function rundownRpm(prevRpm: number, rpm: number, running: boolean, dt: number): number {
  const target = rpmOf(rpm);
  if (running) return target;
  const d = clamp(num(dt), 0, 1);
  const decayed = rpmOf(prevRpm) * Math.exp(-d / M.rundownTauS);
  const r = Math.max(target, decayed);
  // A diesel stops abruptly once it is slow (compression brings it to rest).
  return r < STOP_RPM ? target : r;
}

/** One engine's mix (levels 0..1 before the voice's channel gains; Hz). */
export interface MarineEngineMix {
  firingHz: number;
  cycleHz: number;
  /** Combustion present 0..1 (running and above the firing speed). */
  combustion: number;
  /** Firing tone, its brightness 0..1 and the drive into the "hard" waveshaper (0.2 light … 2 full load). */
  tone: number;
  bright: number;
  drive: number;
  /** Diesel clatter (combustion knock) level and its band centre, Hz. */
  clatter: number;
  clatterHz: number;
  /** Underwater exhaust (muffled), its low-pass cutoff (opens at idle through the idle-relief ports), Hz; the bubbly burble. */
  exhaust: number;
  exhaustLpHz: number;
  bubble: number;
  /** Turbo whistle level and pitch. */
  turbo: number;
  turboHz: number;
  /** Rotating machinery whirr (also while running down). */
  mech: number;
}

export function emptyEngineMix(): MarineEngineMix {
  return {
    firingHz: 0, cycleHz: 0, combustion: 0, tone: 0, bright: 0, drive: 0.2, clatter: 0, clatterHz: 1800, exhaust: 0,
    exhaustLpHz: 200, bubble: 0, turbo: 0, turboHz: M.turboMinHz, mech: 0,
  };
}

/** Levels and frequencies of one diesel. Writes into `out` when given (no allocation). */
export function marineEngineMix(
  rpmIn: number, loadIn: number, boostIn: number, running: boolean, crashed: boolean, out?: MarineEngineMix,
): MarineEngineMix {
  const o = out ?? emptyEngineMix();
  const rpm = rpmOf(rpmIn);
  const rpmN = clamp01(rpm / M.maxRpm);
  const load = clamp01(num(loadIn));
  const boost = clamp01(num(boostIn));
  o.firingHz = marineFiringHz(rpm);
  o.cycleHz = marineCycleHz(rpm);
  o.turboHz = turboWhistleHz(rpm, boost);
  if (crashed) {
    o.combustion = o.tone = o.bright = o.clatter = o.exhaust = o.bubble = o.turbo = o.mech = 0;
    o.drive = 0.2;
    o.clatterHz = 1800;
    o.exhaustLpHz = 200;
    return o;
  }
  const comb = running ? smoothstep(200, 520, rpm) : 0;
  o.combustion = comb;
  o.tone = clamp01(comb * (0.28 + 0.32 * rpmN + 0.5 * load));
  o.bright = clamp01(0.12 + 0.3 * rpmN + 0.58 * load);
  o.drive = 0.2 + 1.8 * load;
  o.clatter = clamp01(comb * (0.55 + 0.2 * rpmN + 0.35 * load));
  o.clatterHz = 1700 + 1300 * load + 600 * rpmN;
  // Idle relief: at low rpm part of the exhaust leaves above the water (a more open chug).
  const relief = 1 - smoothstep(900, 1700, rpm);
  o.exhaust = clamp01(comb * (0.3 + 0.12 * relief + 0.3 * rpmN + 0.45 * load));
  o.exhaustLpHz = 150 + 260 * relief + 220 * load + 120 * rpmN;
  o.bubble = clamp01(comb * smoothstep(900, 2200, rpm) * (0.3 + 0.7 * load));
  o.turbo = clamp01(comb * boost * (0.25 + 0.75 * load) * smoothstep(900, 2200, rpm));
  o.mech = clamp01(smoothstep(20, 300, rpm) * (0.35 + 0.65 * rpmN));
  return o;
}

/** The hull and propellers in the water (levels 0..1, Hz, slaps per second). */
export interface MarineWaterMix {
  speedKt: number;
  /** Water rushing along the hull and its band centre, Hz; the high hiss. */
  rush: number;
  rushHz: number;
  hiss: number;
  /** Bow-wave wash / gurgle at displacement speeds. */
  wash: number;
  /** Planing skim (steady high hiss + chine spray). */
  skim: number;
  /** Hull motion relative to the water 0..1 (heave + pitch + roll). */
  motion: number;
  /** Expected slaps per second and their intensity 0..1 (each slap randomises around it). */
  slapRate: number;
  slapIntensity: number;
  /** Aground: grinding level 0..1. */
  grind: number;
  /** Propeller thrum and cavitation / churn, 0..1; the blade passage, Hz. */
  prop: number;
  cavitation: number;
  bladeHz: number;
}

export function emptyWaterMix(): MarineWaterMix {
  return {
    speedKt: 0, rush: 0, rushHz: 400, hiss: 0, wash: 0, skim: 0, motion: 0, slapRate: 0, slapIntensity: 0, grind: 0, prop: 0,
    cavitation: 0, bladeHz: 0,
  };
}

/** Hull motion relative to the water 0..1: heave speed plus pitch/roll rates at the bow and the chines (m/s → 0..1 over 1.5 m/s). */
export function hullMotion(heaveMs: number, pitchRate: number, rollRate: number): number {
  const v = Math.abs(num(heaveMs)) + 7 * Math.abs(num(pitchRate)) + 2 * Math.abs(num(rollRate));
  return clamp01(v / 1.5);
}

/**
 * Water sounds from the hull's state. `thrustN` / `propRps` are the propulsors' totals / mean.
 */
export function marineWaterMix(
  speedMs: number, planing: number, heaveMs: number, pitchRate: number, rollRate: number, aground: boolean,
  thrustN: number, propRps: number, engines: number, out?: MarineWaterMix,
): MarineWaterMix {
  const o = out ?? emptyWaterMix();
  const kt = clamp(Math.abs(num(speedMs)) * MS_TO_KT, 0, 80);
  const pl = clamp01(planing);
  const sN = clamp01(kt / M.fullSpeedKt);
  o.speedKt = kt;
  o.rush = clamp01(Math.pow(sN, 1.25) * 1.05);
  o.rushHz = 350 + 2300 * Math.pow(sN, 0.8);
  o.hiss = clamp01(Math.pow(sN, 1.8));
  o.wash = clamp01(smoothstep(0.8, 9, kt) * (1 - 0.8 * smoothstep(0.35, 0.8, pl)) * (0.5 + 0.5 * smoothstep(4, 16, kt)));
  o.skim = clamp01(smoothstep(0.5, 0.85, pl) * smoothstep(12, 28, kt));
  const motion = hullMotion(heaveMs, pitchRate, rollRate);
  o.motion = motion;
  // Lapping at rest (the sea is never flat in a marina), slapping in a chop, fewer but harder slams planing.
  o.slapRate = clamp(0.7 + 3.2 * motion + 0.1 * kt * (1 - 0.65 * pl), 0, 8);
  o.slapIntensity = clamp01(0.12 + 0.55 * motion + 0.25 * smoothstep(4, 30, kt) * (0.3 + 0.7 * motion) + 0.25 * pl * motion);
  o.grind = aground ? clamp01(0.35 + 0.65 * smoothstep(0.3, 8, kt)) : 0;
  const n = Math.max(1, Math.round(clamp(num(engines), 1, 8)));
  const loadT = clamp01(Math.abs(num(thrustN)) / (M.refThrustN * n));
  o.bladeHz = propBladeHz(propRps);
  o.prop = clamp01(smoothstep(0.5, 6, Math.abs(num(propRps))) * (0.3 + 0.7 * Math.sqrt(loadT)));
  // Heavily loaded propellers (lots of thrust, little speed: getting on the plane, astern) churn and cavitate.
  o.cavitation = clamp01(Math.pow(loadT, 1.3) * (1 - 0.75 * smoothstep(10, 24, kt)));
  return o;
}

/** Probability that a slap happens this frame (Poisson with rate `perS`). */
export function slapChance(perS: number, dt: number): number {
  const r = clamp(num(perS), 0, 50);
  const d = clamp(num(dt), 0, 1);
  return 1 - Math.exp(-r * d);
}

/** The apparent wind's level scale for a boat (CONFIG.audio's wind is an aircraft's). */
export function marineWindScale(exterior: boolean): number {
  return exterior ? M.windExterior : M.windCabin;
}

/** A fallback engine (no vessel state: QA override, or the physics not there yet): from rpm and power. */
export function fallbackEngine(a: AudioInputs, out: MarineEngineAudioInputs): MarineEngineAudioInputs {
  const p = clamp01(fin(a.power, 0));
  out.rpm = rpmOf(fin(a.rpm, 0));
  out.load = p;
  out.boost = p;
  out.gear = 0;
  out.propRps = 0;
  out.thrustN = 0;
  return out;
}

/** Copy an engine's inputs, sanitised (finite, bounded). */
export function sanitiseEngine(e: MarineEngineAudioInputs | undefined, out: MarineEngineAudioInputs): MarineEngineAudioInputs {
  out.rpm = rpmOf(fin(e?.rpm, 0));
  out.load = clamp(fin(e?.load, 0), 0, 3);
  out.boost = clamp01(fin(e?.boost, 0));
  const g = fin(e?.gear, 0);
  out.gear = g > 0.5 ? 1 : g < -0.5 ? -1 : 0;
  out.propRps = clamp(fin(e?.propRps, 0), -MAX_RPM / 60, MAX_RPM / 60);
  out.thrustN = clamp(fin(e?.thrustN, 0), -1e7, 1e7);
  return out;
}

/** The other voices call this: the marine channels are silent while they play (the counters stay). */
export function zeroMarineLevels(L: AudioLevels): void {
  L.marine = 0;
  L.marineRpm = 0;
  L.engineLoad = 0;
  L.turbo = 0;
  L.turboHz = 0;
  L.hullRush = 0;
  L.skim = 0;
  L.wash = 0;
  L.slapRate = 0;
  L.grind = 0;
}
