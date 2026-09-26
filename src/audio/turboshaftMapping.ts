/**
 * PURE mappings for the Bell 206B-3 JetRanger III (aircraft sound 'turboshaft'): an Allison 250-C20J
 * turboshaft driving a two-blade teetering main rotor and a two-blade tail rotor through a gearbox.
 * No WebAudio here; every function is total (NaN/±∞ in, finite and bounded out).
 *
 * What a JetRanger sounds like, and where it comes from:
 *   - main rotor: the "wop-wop" is the blade passage, 2 blades × NR/60 ≈ 13.1 Hz at 100 % NR. At light
 *     thrust it is a soft whoosh and a low thump. Blade loading (thrust) hardens it, and blade–vortex
 *     interaction (BVI: each blade hitting the tip vortex of the one before, in descents, decelerating
 *     flares, vortex ring state and tight turns) turns it into sharp impulsive slaps. Retreating-blade
 *     stall and advancing-tip compressibility at high speed do the same.
 *   - tail rotor: 2 blades × 2550 rpm / 60 ≈ 85 Hz with harmonics, a buzz. It is loudest behind the
 *     aircraft and gets harder as tail thrust (pedal) rises.
 *   - the Allison 250: a high compressor whine from the gas producer N1 (50,970 rpm at 100 %), the lower
 *     power-turbine howl (33,290 rpm at 100 % N2, locked to NR while the engine drives the rotor) and the
 *     exhaust roar with power. On a start you hear the starter-generator whine, the igniters ticking,
 *     light-off and the spool-up. A shutdown spools the whine down with N1.
 *   - transmission: a gear-mesh whine tied to NR, loud in the cabin under the gearbox.
 *   - the low rotor RPM horn: steady, below 95 % NR in flight. On the ground the collective switch
 *     mutes it while the lever is down.
 *
 * Constants live here (not in CONFIG.audio) because only this voice uses them.
 */
import type { AudioInputs, AudioLevels, RotorAudioInputs } from './types';

export const TURBOSHAFT = {
  /** Main rotor: 100 % NR, rpm; blades. Tail rotor: blades and gear ratio (2550 rpm at 100 %). */
  nominalNrRpm: 394,
  mainBlades: 2,
  tailBlades: 2,
  tailGearRatio: 2550 / 394,
  /** Gross weight used as the reference thrust (1300 kg), N; tail thrust in the hover, N. */
  weightN: 1300 * 9.80665,
  tailRefN: 750,
  /** Allison 250-C20J: take-off power (the physics' maxPowerW), W; N1 at ground idle; light-off N1; starter cut-out N1. */
  maxPowerW: 236000,
  idleN1: 0.63,
  lightOffN1: 0.12,
  starterCutN1: 0.58,
  /** Gas producer N1 and power turbine N2 at 100 %, rpm. */
  n1MaxRpm: 50970,
  n2MaxRpm: 33290,
  /** Orders of the shaft rates heard: the compressor whine (≈4.2 kHz at 100 % N1) and the power-turbine howl (≈1.1 kHz). */
  whineOrder: 5,
  howlOrder: 2,
  /** Main-transmission input spiral-bevel mesh at 100 % NR (6016 rpm input × 19 teeth), Hz; a planetary mesh below it. */
  gearMeshHz: 1905,
  gearMesh2Ratio: 0.285,
  /** Igniter spark rate while starting, Hz. */
  igniterHz: 6,
  /** Low rotor RPM horn: on below this NR %, off again above it + hysteresis; on the ground only with the collective up. */
  lowRpmPct: 95,
  lowRpmHysteresisPct: 0.6,
  collectiveUp: 0.1,
  hornHz: 720,
  hornVolume: 0.26,
  /** Overall level relative to the Cessna's engine, and the exterior path in the cabin (thin doors, the rotor right overhead). */
  volume: 1.7,
  cockpitGain: 0.8,
  /** Channel levels before engineVolume × volume. */
  whoosh: 0.9,
  thump: 1.4,
  slap: 2.5,
  crack: 1.6,
  tail: 0.14,
  whine: 0.05,
  howl: 0.05,
  roar: 0.25,
  rumble: 0.2,
  starter: 0.22,
  igniter: 0.12,
  /** Transmission whine: in the cabin, and the little that reaches the outside. Turbine whine heard in the cabin. */
  gearCabin: 0.035,
  gearExterior: 0.004,
  whineCabin: 0.025,
  /** Light-off "whump" level. */
  lightOff: 0.3,
  /** Exterior views: full level within this distance, m. */
  refDistanceM: 20,
};

const T = TURBOSHAFT;
const num = (v: number): number => (Number.isNaN(v) ? 0 : v);
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number): number => clamp(num(v), 0, 1);
function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((num(x) - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}
/** Highest main-rotor speed the sound model accepts, rpm (overspeed margin). */
const MAX_NR_RPM = 1.3 * T.nominalNrRpm;
const nrOf = (rpm: number): number => clamp(num(rpm), 0, MAX_NR_RPM);
const n1Of = (n1: number): number => clamp(num(n1), 0, 1.15);

/** Main-rotor speed as % of nominal (0..130). */
export function rotorPct(nrRpm: number): number {
  return (nrOf(nrRpm) / T.nominalNrRpm) * 100;
}

/** Main-rotor revolutions per second, Hz. */
export function rotorRevHz(nrRpm: number): number {
  return nrOf(nrRpm) / 60;
}

/** Main-rotor blade-passage rate, Hz: blades × NR/60 (≈13.1 Hz at 100 %). */
export function bladePassHz(nrRpm: number): number {
  return rotorRevHz(nrRpm) * T.mainBlades;
}

/** Tail-rotor blade-passage rate, Hz: blades × NR × gear ratio / 60 (≈85 Hz at 100 %). */
export function tailRotorHz(nrRpm: number): number {
  return rotorRevHz(nrRpm) * T.tailGearRatio * T.tailBlades;
}

/** Compressor whine from the gas-producer speed N1 (fraction), Hz. */
export function compressorWhineHz(n1: number): number {
  return n1Of(n1) * (T.n1MaxRpm / 60) * T.whineOrder;
}

/** Power-turbine howl from N2 (fraction), Hz. */
export function turbineHowlHz(n2: number): number {
  return clamp(num(n2), 0, 1.3) * (T.n2MaxRpm / 60) * T.howlOrder;
}

/** Transmission gear-mesh whine, Hz (follows NR). */
export function gearWhineHz(nrRpm: number): number {
  return (nrOf(nrRpm) / T.nominalNrRpm) * T.gearMeshHz;
}

/**
 * The low rotor RPM horn (like the real 206B-3): NR below 95 % in flight; on the ground only with the
 * engine running and the collective up (the collective switch mutes it at flat pitch, e.g. during a
 * start or at ground idle). `wasOn` adds a little hysteresis so it does not chatter at the threshold.
 */
export function lowRotorRpmHorn(
  nrPct: number, onGround: boolean, collective: number, engineRunning: boolean, crashed: boolean, wasOn = false,
): boolean {
  if (crashed || Number.isNaN(nrPct)) return false;
  const th = T.lowRpmPct + (wasOn ? T.lowRpmHysteresisPct : 0);
  if (!(nrPct < th)) return false;
  if (!onGround) return true;
  return !!engineRunning && num(collective) > T.collectiveUp;
}

/** Everything the turboshaft mix needs, in physical units (see turboshaftInputs). */
export interface TurboshaftMixInput {
  nrRpm: number;
  n1: number;
  /** Shaft power 0..1 of take-off power. */
  power: number;
  torque: number;
  thrustN: number;
  tailThrustN: number;
  collective: number;
  vrs: number;
  bladeStall: number;
  groundEffect: number;
  climbMs: number;
  decelMs2: number;
  airspeedKt: number;
  onGround: boolean;
  engineRunning: boolean;
  starting: boolean;
  crashed: boolean;
}

export function emptyTurboshaftInput(): TurboshaftMixInput {
  return {
    nrRpm: 0, n1: 0, power: 0, torque: 0, thrustN: 0, tailThrustN: 0, collective: 0, vrs: 0, bladeStall: 0, groundEffect: 0,
    climbMs: 0, decelMs2: 0, airspeedKt: 0, onGround: true, engineRunning: false, starting: false, crashed: false,
  };
}

const fin = (v: number | undefined, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/**
 * AudioInputs → TurboshaftMixInput. With the rotor state (a.rotor) the physics drives everything;
 * without it (before the helicopter physics exists, or a QA override) NR comes from `rpm`
 * (state.engine.rpm is the main-rotor rpm) and the rest is estimated from power.
 */
export function turboshaftInputs(a: AudioInputs, out?: TurboshaftMixInput): TurboshaftMixInput {
  const o = out ?? emptyTurboshaftInput();
  const r: RotorAudioInputs | undefined = a.rotor;
  const running = !!a.engineRunning;
  const p = clamp01(fin(a.power, 0));
  o.airspeedKt = Math.max(0, fin(a.airspeedKt, 0));
  o.onGround = !!a.onGround;
  o.engineRunning = running;
  o.starting = !!a.starting;
  o.crashed = !!a.crashed;
  if (r) {
    o.nrRpm = nrOf(fin(r.nrRpm, 0));
    o.n1 = n1Of(fin(r.n1, 0));
    o.power = clamp01(fin(r.enginePowerW, 0) / T.maxPowerW);
    o.torque = clamp(fin(r.torque, 0), 0, 3);
    o.thrustN = clamp(fin(r.thrustN, 0), -1e6, 1e6);
    o.tailThrustN = clamp(fin(r.tailThrustN, 0), -1e6, 1e6);
    o.collective = clamp01(fin(r.collective, 0));
    o.vrs = clamp01(fin(r.vrs, 0));
    o.bladeStall = clamp01(fin(r.bladeStall, 0));
    o.groundEffect = clamp01(fin(r.groundEffect, 0));
    o.climbMs = clamp(fin(r.climbMs, 0), -300, 300);
    o.decelMs2 = clamp(fin(r.decelMs2, 0), -100, 100);
  } else {
    o.nrRpm = nrOf(fin(a.rpm, 0));
    const nr = o.nrRpm / T.nominalNrRpm;
    o.n1 = running ? T.idleN1 + (1 - T.idleN1) * p : 0;
    o.power = running ? p : 0;
    o.torque = o.power;
    o.thrustN = a.onGround ? 0.2 * T.weightN * nr * nr : T.weightN * Math.min(1, nr * nr);
    o.tailThrustN = o.torque * T.tailRefN;
    o.collective = a.onGround ? 0 : 0.5;
    o.vrs = o.bladeStall = o.groundEffect = o.climbMs = o.decelMs2 = 0;
  }
  return o;
}

export interface TurboshaftMix {
  /** Main rotor NR, %; its revolution rate, blade-passage and tail-rotor blade-passage rates, Hz. */
  nrPct: number;
  revHz: number;
  bladeHz: number;
  tailHz: number;
  /** Rotor thrust / weight (0..3) and the blade–vortex-interaction / impulsive intensity 0..1. */
  load: number;
  impulsive: number;
  /** Main rotor: broadband whoosh, low thump, slap (impulsive noise band), crack (the impulsive pressure pulse), sharpness 0..1. */
  whoosh: number;
  thump: number;
  slap: number;
  crack: number;
  sharpness: number;
  /** Tail-rotor buzz level and brightness 0..1. */
  tail: number;
  tailBright: number;
  /** Turbine: compressor whine (N1), power-turbine howl (N2), exhaust roar + rumble; 0..1 each. */
  whine: number;
  whineHz: number;
  howl: number;
  howlHz: number;
  roar: number;
  roarBright: number;
  rumble: number;
  /** Starting: starter-generator whine (level, Hz), igniter ticks. */
  starter: number;
  starterHz: number;
  igniter: number;
  /** Transmission whine level and frequency. */
  gear: number;
  gearHz: number;
}

export function emptyTurboshaftMix(): TurboshaftMix {
  return {
    nrPct: 0, revHz: 0, bladeHz: 0, tailHz: 0, load: 0, impulsive: 0, whoosh: 0, thump: 0, slap: 0, crack: 0, sharpness: 0,
    tail: 0, tailBright: 0, whine: 0, whineHz: 0, howl: 0, howlHz: 0, roar: 0, roarBright: 0, rumble: 0, starter: 0,
    starterHz: 0, igniter: 0, gear: 0, gearHz: 0,
  };
}

/**
 * Blade–vortex interaction / impulsive intensity 0..1: descents at moderate speed, decelerating flares,
 * tight turns (thrust well above weight), vortex ring state, blade stall, advancing-tip compressibility.
 */
export function impulsiveNoise(i: TurboshaftMixInput): number {
  const load = clamp(num(i.thrustN) / T.weightN, 0, 3);
  const ias = Math.max(0, num(i.airspeedKt));
  const sink = Math.max(0, -num(i.climbMs));
  const descent = smoothstep(0.8, 4, sink) * smoothstep(12, 40, ias) * (1 - smoothstep(95, 130, ias));
  const flare = smoothstep(0.6, 3, num(i.decelMs2)) * smoothstep(8, 30, ias) * clamp01(load);
  const turn = smoothstep(1.15, 1.8, load);
  const hsi = smoothstep(110, 140, ias);
  return clamp01(Math.max(descent, flare, turn, hsi, clamp01(i.vrs), 0.9 * clamp01(i.bladeStall)));
}

/** Levels and frequencies of every channel. Writes into `out` when given (no allocation). */
export function turboshaftMix(i: TurboshaftMixInput, out?: TurboshaftMix): TurboshaftMix {
  const o = out ?? emptyTurboshaftMix();
  const nrRpm = nrOf(i.nrRpm);
  const nr = nrRpm / T.nominalNrRpm;
  o.nrPct = nr * 100;
  o.revHz = rotorRevHz(nrRpm);
  o.bladeHz = bladePassHz(nrRpm);
  o.tailHz = tailRotorHz(nrRpm);
  o.gearHz = gearWhineHz(nrRpm);
  const n1 = n1Of(i.n1);
  o.whineHz = compressorWhineHz(n1);
  const n2 = i.engineRunning || i.starting ? nr : Math.min(nr, n1 / T.idleN1);
  o.howlHz = turbineHowlHz(n2);
  o.starterHz = 280 + 2600 * clamp01(n1 / T.starterCutN1);
  if (i.crashed) {
    o.load = o.impulsive = o.whoosh = o.thump = o.slap = o.crack = o.sharpness = 0;
    o.tail = o.tailBright = o.whine = o.howl = o.roar = o.roarBright = o.rumble = o.starter = o.igniter = o.gear = 0;
    return o;
  }

  // ── Main rotor ──
  // A slowly turning rotor is soft; loudness rises steeply with tip speed.
  const rotor = smoothstep(0.02, 0.18, nr) * Math.pow(Math.min(nr, 1.3), 1.6);
  const load = clamp(num(i.thrustN) / T.weightN, 0, 3);
  const loadN = clamp01(load / 1.4);
  const imp = impulsiveNoise(i);
  const ge = clamp01(i.groundEffect);
  o.load = load;
  o.impulsive = imp;
  o.whoosh = clamp01(rotor * (0.45 + 0.35 * loadN) * (1 - 0.3 * imp));
  o.thump = clamp01(rotor * (0.25 + 0.55 * loadN + 0.25 * imp) * (1 + 0.15 * ge));
  o.slap = clamp01(rotor * (0.04 + 0.16 * Math.pow(loadN, 1.5) + 0.8 * imp));
  o.crack = clamp01(rotor * (0.03 + 0.12 * Math.pow(loadN, 1.5) + 0.85 * imp));
  o.sharpness = clamp01(0.15 * loadN + 0.85 * imp);

  // ── Tail rotor ──
  const tailLoad = clamp01(Math.abs(num(i.tailThrustN)) / (1.6 * T.tailRefN));
  o.tail = clamp01(rotor * (0.35 + 0.65 * tailLoad));
  o.tailBright = rotor > 0 ? clamp01(0.2 + 0.8 * tailLoad) : 0;

  // ── Turbine ──
  const p = i.engineRunning ? clamp01(i.power) : 0;
  const spool = smoothstep(0.03, T.idleN1, n1);
  const aboveIdle = clamp01((n1 - T.idleN1) / (1 - T.idleN1));
  o.whine = clamp01(spool * (0.55 + 0.45 * aboveIdle));
  const flow = smoothstep(T.lightOffN1, T.idleN1, n1);
  const burning = i.engineRunning || (i.starting && n1 >= T.lightOffN1);
  o.howl = clamp01(smoothstep(0.05, 0.5, n2) * smoothstep(0.02, 0.3, n1) * (0.35 + 0.65 * p));
  o.roar = burning ? clamp01(flow * (0.25 + 0.75 * Math.pow(p, 0.9))) : clamp01(0.3 * flow);
  o.roarBright = clamp01(flow * (0.15 + 0.85 * p));
  o.rumble = burning ? clamp01(flow * (0.3 + 0.7 * p)) : 0;
  o.starter = i.starting ? 1 : 0;
  o.igniter = i.starting && n1 < T.starterCutN1 ? 1 : 0;

  // ── Transmission ──
  o.gear = clamp01(smoothstep(0.05, 0.6, nr) * (0.4 + 0.6 * clamp01(i.torque)));
  return o;
}

export interface RotorDirectivity {
  /** Main rotor (BVI slap radiates forward and down). */
  main: number;
  /** Tail rotor (loudest behind and beside the tail). */
  tail: number;
  /** Engine exhaust (up and aft) and compressor intake. */
  engine: number;
}

/** Exterior directivity from `aft` = cos(angle between the tail direction and the camera): +1 behind, −1 ahead. */
export function rotorDirectivity(aft: number, out?: RotorDirectivity): RotorDirectivity {
  const c = clamp(num(aft), -1, 1);
  const o = out ?? { main: 1, tail: 1, engine: 1 };
  o.main = 0.8 + 0.2 * smoothstep(0.4, -0.9, c);
  o.tail = 0.5 + 0.5 * smoothstep(-0.6, 0.9, c);
  o.engine = 0.65 + 0.35 * smoothstep(-0.5, 0.9, c);
  return o;
}

/** Light-off: N1 crosses the light-off speed upwards during a start. */
export function lightOff(prevN1: number, n1: number, starting: boolean): boolean {
  return !!starting && num(n1) >= T.lightOffN1 && !(num(prevN1) >= T.lightOffN1);
}

/** The other voices call this: the rotor channels are silent while they play. */
export function zeroRotorLevels(L: AudioLevels): void {
  L.turboshaft = 0;
  L.rotorPct = 0;
  L.slap = 0;
  L.slapSharpness = 0;
  L.tailRotor = 0;
  L.tailHz = 0;
  L.gearbox = 0;
}
