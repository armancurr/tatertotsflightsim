/**
 * PURE mappings for the F-16's GE F110-GE-129 afterburning turbofan. Total functions (NaN/±∞ in →
 * finite, bounded out) so the synth can hand the results straight to AudioParams.
 *
 * What a turbofan sounds like, and where it comes from:
 *   - turbine whine — the HP compressor's blade-pass tone: N2 shaft rate × blades (≈3.5 kHz at
 *     ground idle, ≈5 kHz at 100 % N2). Strongest ahead of and beside the engine (the inlet).
 *   - fan buzz ("buzz-saw") — supersonic fan-blade tips radiate shock waves at every harmonic of the
 *     N1 shaft rate (≈130 Hz at 100 % N1). Rises steeply above ~80 % N1; forward-radiated.
 *   - roar — turbulent jet mixing noise, broadband, rising steeply with jet velocity (power);
 *     radiated mostly backwards (loudest ~40° off the jet axis behind the aircraft).
 *   - afterburner — a deeper, rougher, much louder roar with "crackle": sparse, positively skewed
 *     pressure spikes from the shock-laden supersonic jet; it lights with a low "whoomph".
 */
import { CONFIG } from '../config';

const J = CONFIG.audio.jet;

const finite = (v: number, d = 0): number => (Number.isFinite(v) ? v : d);
/** NaN → 0; ±∞ kept (clamped by the caller), so the mappings stay monotone at the extremes. */
const num = (v: number): number => (Number.isNaN(v) ? 0 : v);
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number): number => clamp(num(v), 0, 1);
function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((num(x) - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** Highest core speed the sound model accepts, % (overspeed margin). */
const MAX_CORE_PCT = 115;
/** Engine speeds at or below this are read as percent; above as a piston-style rpm (placeholder physics). */
const PERCENT_LIMIT = 130;

/**
 * Core speed N2 in % from `state.engine.rpm`. The jet physics reports N2 %; a value far above 100
 * can only be a piston-style rpm (the F-16 placeholder uses the Cessna engine model), which is read
 * as a fraction of the piston max rpm so the sound still makes sense.
 */
export function jetCorePct(rpm: number): number {
  if (Number.isNaN(rpm) || rpm <= 0) return 0;
  if (rpm <= PERCENT_LIMIT) return Math.min(rpm, MAX_CORE_PCT);
  if (rpm === Infinity) return MAX_CORE_PCT;
  return clamp((rpm / CONFIG.aircraft.engine.maxRpm) * 100, 0, MAX_CORE_PCT);
}

/** Fan speed N1 in % for a core speed N2 % (the LP spool lags: ~40 % at ground idle, 100 % at 100 %). */
export function jetFanPct(corePct: number): number {
  const c = clamp(num(corePct), 0, MAX_CORE_PCT);
  if (c >= 100) return c;
  return 100 * Math.pow(clamp01((c - 45) / 55), 1.15);
}

/** Turbine whine: HP-compressor blade-pass frequency, Hz. */
export function jetWhineHz(corePct: number): number {
  return jetShaftHz(corePct) * J.whineBlades;
}

/** HP (core) shaft rotation frequency, Hz. */
export function jetShaftHz(corePct: number): number {
  return (clamp(num(corePct), 0, MAX_CORE_PCT) / 100) * (J.coreMaxRpm / 60);
}

/** Fan (LP) shaft rotation frequency = fundamental of the buzz-saw tones, Hz. */
export function jetFanHz(corePct: number): number {
  return (jetFanPct(corePct) / 100) * (J.fanMaxRpm / 60);
}

/** Centre of the inlet-duct "howl" resonance heard in the cockpit, Hz (rises with N1). */
export function jetIntakeHz(corePct: number): number {
  return 650 + 9 * jetFanPct(corePct);
}

export interface JetMixInput {
  /** Core speed N2 %, see jetCorePct. */
  corePct: number;
  /** Dry power 0..1 (idle → MIL). */
  power: number;
  /** Afterburner 0..1. */
  afterburner: number;
  engineRunning: boolean;
  starting: boolean;
  crashed: boolean;
}

export interface JetMix {
  /** Effective core speed used for the sound (a running engine never below ground idle), %. */
  corePct: number;
  whine: number;
  fan: number;
  /** Broadband jet-mixing roar. */
  roar: number;
  /** Low body of the roar (felt in the cockpit). */
  rumble: number;
  abRumble: number;
  abTear: number;
  crackle: number;
  /** Cockpit inlet howl. */
  intake: number;
  /** Cockpit ECS air (bleed air from the running engine). */
  ecs: number;
  /** Jet fuel starter. */
  starter: number;
  /** 0..1 openness of the roar's low-pass. */
  brightness: number;
}

const SILENT: JetMix = {
  corePct: 0, whine: 0, fan: 0, roar: 0, rumble: 0, abRumble: 0, abTear: 0, crackle: 0, intake: 0, ecs: 0, starter: 0, brightness: 0,
};

/** Relative loudness of every jet channel, each 0..1. Monotone in power and afterburner. Writes into `out` when given (no allocation). */
export function jetMix(a: JetMixInput, out?: JetMix): JetMix {
  const o = out ?? { ...SILENT };
  if (a.crashed) return Object.assign(o, SILENT);
  const running = !!a.engineRunning;
  let core = clamp(num(a.corePct), 0, MAX_CORE_PCT);
  if (running && !a.starting) core = Math.max(core, J.idleCorePct);
  if (core <= 0 && !a.starting) return Object.assign(o, SILENT);
  const p = running ? clamp01(a.power) : 0;
  const ab = running ? clamp01(a.afterburner) : 0;
  const fan = jetFanPct(core);
  const spool = smoothstep(4, J.idleCorePct, core);
  const aboveIdle = clamp01((core - J.idleCorePct) / (100 - J.idleCorePct));
  const whine = clamp01(spool * (0.6 + 0.4 * aboveIdle));
  const buzz = running ? clamp01(0.2 + 0.8 * smoothstep(55, 98, fan)) : 0.25 * spool;
  const roar = running ? clamp01(0.2 + 0.8 * Math.pow(p, 1.3) + 0.15 * ab) : 0;
  const rumble = running ? clamp01(0.25 + 0.75 * Math.pow(p, 1.1)) : 0;
  o.corePct = core;
  o.whine = whine;
  o.fan = clamp01(buzz * spool);
  o.roar = roar;
  o.rumble = rumble;
  o.abRumble = Math.pow(ab, 0.7);
  o.abTear = Math.pow(ab, 0.9);
  o.crackle = ab > 0 ? clamp01(Math.pow(ab, 0.8)) : 0;
  o.intake = clamp01(spool * (0.35 + (0.65 * fan) / 100));
  o.ecs = running ? 1 : 0;
  o.starter = a.starting ? 1 : 0;
  o.brightness = clamp01(0.2 * aboveIdle + 0.6 * p + 0.2 * ab);
  return o;
}

/** Low-pass cutoff of the roar, Hz: opens with power, more with the afterburner. */
export function jetRoarCutoffHz(power: number, afterburner: number): number {
  return clamp(450 + 3300 * Math.pow(clamp01(power), 0.8) + 1800 * clamp01(afterburner), 200, 8000);
}

export interface JetDirectivity {
  /** Gain for aft-radiated sound (roar, afterburner): 1 behind the jet. */
  aft: number;
  /** Gain for forward-radiated sound (whine, fan buzz): 1 ahead of the inlet. */
  fore: number;
}

/**
 * Directivity from `aft` = cos(angle between the tail direction and the camera), +1 behind the tail,
 * −1 ahead of the nose. Jet noise peaks behind; compressor/fan tones ahead and abeam.
 */
export function jetDirectivity(aft: number, out?: JetDirectivity): JetDirectivity {
  const c = clamp(num(aft), -1, 1);
  const o = out ?? { aft: 1, fore: 1 };
  o.aft = 0.45 + 0.55 * smoothstep(-0.5, 0.85, c);
  o.fore = 0.4 + 0.6 * smoothstep(0.7, -0.85, c);
  return o;
}

/** The afterburner lights: its level crosses the light-off threshold upwards. */
export function abLightOff(prev: number, now: number): boolean {
  const TH = 0.05;
  return finite(now) >= TH && !(finite(prev) >= TH);
}
