import type { CameraMode, SurfaceType } from '../types';
import type { EngineSound } from '../fleet/types';
import type { CombatAudioApi } from './combat';
import type { AirAudioApi } from './airTargets';

/** Everything the sound engine needs each frame (see createAudioInputTracker for the adapter from AircraftState). */
export interface AudioInputs {
  rpm: number;
  /** 0..1 engine power fraction actually produced. */
  power: number;
  engineRunning: boolean;
  /** Starter cranking. */
  starting: boolean;
  airspeedKt: number;
  onGround: boolean;
  groundSpeedKt: number;
  stallWarning: boolean;
  gearMoving: boolean;
  flapsMoving: boolean;
  /** Vertical speed at touchdown (fpm) — only on the frame of a touchdown, otherwise null. */
  touchdownFpm: number | null;
  crashed: boolean;
  cameraMode: CameraMode;
  paused: boolean;
  /** 0..1 toe brakes. */
  brake: number;
  surface: SurfaceType;
  /** Optional: camera → aircraft distance (m) for exterior attenuation/air absorption. Default: refDistanceM. */
  listenerDistanceM?: number;
  /** Optional: speed (m/s) at which the aircraft closes on the camera (+ approaching) — Doppler in exterior views. */
  closingSpeedMs?: number;
  /** Optional: impact speed (kt) for the crash boom; defaults to airspeedKt. */
  crashSpeedKt?: number;
  /** Optional: the landing-gear warning horn is sounding (see src/ui/gearWarning.ts). Default false. */
  gearWarning?: boolean;
  /** Optional (jets): afterburner 0..1. Default 0. */
  afterburner?: number;
  /** Optional (jets): the speed brake is travelling (hydraulic whine). Default false. */
  speedBrakeMoving?: boolean;
  /**
   * Optional: cos(angle between the aircraft's tail direction and the camera) — +1 camera straight
   * behind, −1 ahead of the nose (jet noise directivity in exterior views). Default 0.
   */
  aft?: number;
  /** Optional (helicopters): the rotor, drivetrain and turboshaft (absent on fixed-wing aircraft). */
  rotor?: RotorAudioInputs;
  /** Optional (helicopters): the low rotor RPM horn is sounding (see lowRotorRpmHorn in turboshaftMapping.ts). Default false. */
  lowRotorRpm?: boolean;
  /** Optional (boats and ships): engines, propulsors and the hull in the water (absent on aircraft). */
  vessel?: VesselAudioInputs;
}

/** One marine engine + gearbox + propeller as the sound engine sees it (from VesselState.propulsors). */
export interface MarineEngineAudioInputs {
  /** Engine rpm. */
  rpm: number;
  /** Engine torque, fraction of rated (the load gauge; > 1 briefly on the torque rise). */
  load: number;
  /** Turbo boost: available-torque fraction 0..1 (the turbo spools with it). */
  boost: number;
  /** Gearbox: +1 ahead, 0 neutral, −1 astern. */
  gear: number;
  /** Propeller speed, rev/s (signed). */
  propRps: number;
  /** Propeller thrust, N (+ ahead). */
  thrustN: number;
  // Sea-Doo (pwc) voice: waterjet fields (from PropulsorState.jet; present only on 'jet' propulsors).
  /** Pump flow, m³/s. */
  flow?: number;
  /** Jet speed out of the nozzle, m/s. */
  jetSpeed?: number;
  /** 0 = intake full of water … 1 = sucking air (airborne): the pump ventilates. */
  ventilation?: number;
  /** Reverse bucket (iBR) 0 = up (ahead) … 1 = down (astern). */
  bucket?: number;
  // End Sea-Doo (pwc) voice.
}

/**
 * A boat's engines and hull as the sound engine sees them (from AircraftState.vessel, see
 * createAudioInputTracker). Physical units; the 'marineDiesel' voice (marineMapping.ts) makes the sound.
 */
export interface VesselAudioInputs {
  /** Engines port first; only the first `engineCount` entries are valid (a reused fixed pool). */
  engines: MarineEngineAudioInputs[];
  engineCount: number;
  /** Speed through the water, m/s (+ ahead). */
  speedMs: number;
  /** Planing lift as a fraction of the weight, 0..~1. */
  planing: number;
  /** Running trim, deg (+ bow up). */
  trimDeg: number;
  /** Touching the bottom, the shore or a structure. */
  aground: boolean;
  /** Vertical speed of the hull relative to the water surface under it, m/s (+ rising; smoothed). */
  heaveMs: number;
  /** Body pitch and roll rates, rad/s (the hull working in the waves). */
  pitchRate: number;
  rollRate: number;
  /** Still on the mooring lines at the berth. */
  moored: boolean;
}

/**
 * The helicopter's rotor and engine as the sound engine sees them (from AircraftState.rotor, see
 * createAudioInputTracker). Physical units; the voice (turboshaftMapping.ts) turns them into sound.
 */
export interface RotorAudioInputs {
  /** Main-rotor speed NR, rpm (100 % = 394 rpm on the JetRanger). */
  nrRpm: number;
  /** Gas-producer speed N1, fraction (≈0.63 ground idle, 1 = 100 %). */
  n1: number;
  /** Shaft power delivered, W. */
  enginePowerW: number;
  /** Engine torque, fraction of the transmission limit. */
  torque: number;
  /** Main- and tail-rotor thrust, N. */
  thrustN: number;
  tailThrustN: number;
  /** Collective actually on the blades, 0..1. */
  collective: number;
  /** 0..1 vortex-ring state, 0..1 retreating-blade stall, 0..1 ground effect. */
  vrs: number;
  bladeStall: number;
  groundEffect: number;
  /** Vertical speed, m/s (+ up). */
  climbMs: number;
  /** Horizontal deceleration (smoothed), m/s² (+ slowing down: a flare). */
  decelMs2: number;
}

/** Output level meter (post-limiter), for QA. */
export interface AudioMeter {
  /** RMS of the last analysis window (linear, full scale = 1). */
  rms: number;
  /** Absolute peak of the last analysis window. */
  peak: number;
}

export interface AudioSystem {
  /** Create/resume the AudioContext. Call on the first user gesture (keydown/pointerdown). Never throws. */
  resume(): Promise<void>;
  /** Per-frame update (dt in seconds). Never throws. */
  update(a: AudioInputs, dt: number): void;
  setMuted(m: boolean): void;
  readonly muted: boolean;
  /** Which engine voice plays: the Cessna's O-360 + prop ('piston'), the F-16's F110 ('jet'), the A-10's TF34s ('turbofan'), the JetRanger's Allison 250 + rotors ('turboshaft'), the Princess V50's D6 diesels + IPS drives + hull ('marineDiesel'), the Sea-Doo RXP-X's Rotax 1630 + jet pump ('pwc'). */
  setEngine(kind: EngineSound): void;
  readonly engine: EngineSound;
  /** An explosion near the wreck (the crash effects' `sim:explosion`); size 0..1, distance from the camera, m. */
  explosion(e: { size?: number; distanceM?: number }): void;
  /** Debris or airframe hitting the ground (`sim:impact`); speed m/s, distance from the camera, m. */
  impact(e: { speed?: number; speedMs?: number; distanceM?: number }): void;
  /** Silence every crash and combat sound (fire, debris, pending explosions, the gun, delayed booms) — the sim was reset. */
  reset(): void;
  /** Combat sound: the gun, impacts, missiles, explosions (src/audio/combat.ts); no-op before the context exists. */
  readonly combat: CombatAudioApi;
  /** The enemy aircraft's engines (src/audio/airTargets.ts); no-op before the context exists. */
  readonly air: AirAudioApi;
  /** Output meter (creates the analyser on first use); null before the context exists. */
  meter(): AudioMeter | null;
  /** The AudioContext once created (null before resume() or when WebAudio is unavailable). */
  readonly context: BaseAudioContext | null;
  /** The master bus input (mute, pause, compressor, limiter) for other sound modules — the naval guns (src/audio/naval.ts); null before the context exists. */
  readonly masterInput: AudioNode | null;
  /** QA/debug: the last target of every channel (gains 0..1, Hz for filters/oscillators) + counters. */
  levels(): Readonly<AudioLevels>;
  dispose(): void;
}

export interface AudioLevels {
  master: number;
  engineVolume: number;
  exhaust: number;
  prop: number;
  mechanical: number;
  starter: number;
  cycleHz: number;
  firingHz: number;
  bladeHz: number;
  doppler: number;
  wind: number;
  whistle: number;
  rolling: number;
  scrub: number;
  horn: number;
  /** Gear warning horn level (0 when silent). */
  gearHorn: number;
  gear: number;
  flap: number;
  fire: number;
  viewCutoff: number;
  distance: number;
  cabin: number;
  /** Discrete events played (touchdowns, gear clunks, engine catches, crashes). */
  oneShots: number;
  /** Intensity 0..1 of the last touchdown played. */
  lastTouchdown: number;
  /** Exceptions swallowed by the safety net (should stay 0). */
  errors: number;
  // ── Jet (F110 turbofan); all 0 while the piston engine plays ──
  /** 1 while the jet voice plays, 0 for the piston engine. */
  jet: number;
  corePct: number;
  whineHz: number;
  fanHz: number;
  whine: number;
  fan: number;
  roar: number;
  afterburner: number;
  crackle: number;
  intake: number;
  ecs: number;
  hydraulic: number;
  aft: number;
  /** Engine voices alive (the playing one + any still fading out after a switch). */
  engineVoices: number;
  // ── Crash ──
  /** Crashes played since start. */
  crashes: number;
  /** Explosions played (secondary + `sim:explosion`). */
  explosions: number;
  /** `sim:impact` events played. */
  impacts: number;
  /** Secondary explosions still scheduled for the current crash. */
  pendingExplosions: number;
  /** Crash one-shot sources still playing. */
  crashLive: number;
  // ── A-10 TF34 turbofans (1 while that voice plays; it reuses whineHz = whistle, fanHz = N1 shaft rate…) ──
  turbofan: number;
  // ── JetRanger turboshaft + rotors (1 while that voice plays; it reuses bladeHz = main-rotor blade passage,
  //    whineHz = compressor whine, corePct = N1 %, roar = exhaust, starter; all 0 for the other voices) ──
  turboshaft: number;
  /** Main-rotor speed NR, % of nominal. */
  rotorPct: number;
  /** Blade slap (impulsive) level 0..1 and its sharpness 0..1 (blade–vortex interaction, stall, compressibility). */
  slap: number;
  slapSharpness: number;
  /** Tail-rotor buzz level 0..1 and its blade-pass frequency, Hz. */
  tailRotor: number;
  tailHz: number;
  /** Transmission whine level 0..1. */
  gearbox: number;
  /** Low rotor RPM horn level (0 when silent). */
  rotorHorn: number;
  // ── Marine diesels + hull (1 while the 'marineDiesel' voice plays; it reuses firingHz / cycleHz = the port
  //    engine's firing and cycle rates, bladeHz = propeller blade passage, exhaust, mechanical = clatter,
  //    prop, starter; all 0 for the other voices) ──
  marine: number;
  /** Audible engine rpm (port; follows the run-down after a stop). */
  marineRpm: number;
  /** Mean engine load 0..1 and the turbo whistle's level and pitch, Hz. */
  engineLoad: number;
  turbo: number;
  turboHz: number;
  /** Water rushing along the hull, the planing skim, the displacement wash; 0..1. */
  hullRush: number;
  skim: number;
  wash: number;
  /** Hull slaps per second (expected rate) and the slaps played since start. */
  slapRate: number;
  hullSlaps: number;
  /** Grinding on the bottom (aground) 0..1. */
  grind: number;
  /** Gearbox shifts heard since start (ahead / neutral / astern). */
  gearClunks: number;
  // ── Sea-Doo (pwc) voice: the Rotax 1630 + jet pump + hull (1 while the 'pwc' voice plays; it reuses the marine
  //    channels — marineRpm, engineLoad, turbo / turboHz = the supercharger whine, hullRush, skim, wash, slapRate,
  //    hullSlaps, grind, gearClunks = iBR bucket clunks — and firingHz, cycleHz, bladeHz = impeller blades, exhaust,
  //    mechanical = the snarl, prop = impeller tone, starter; all 0 for the other voices) ──
  pwc: number;
  /** Water roaring through the pump 0..1, and the ventilation sputter 0..1 (the intake sucking air). */
  pump: number;
  pumpVent: number;
  // End Sea-Doo (pwc) voice.
  // ── Combat ──
  /** Gun gate (1 while rounds leave the barrel), its fundamental (firing rate, Hz), the exterior delay d / c (s). */
  gun: number;
  gunHz: number;
  gunDelayS: number;
  /** Missile motor level heard (0..1). */
  motor: number;
  /** Combat one-shots still playing or scheduled. */
  combatLive: number;
  impactsPlayed: number;
  booms: number;
  launches: number;
  // ── Enemy aircraft ──
  /** Voices heard, the loudest one's level (after the canopy) and its Doppler factor. */
  airVoices: number;
  airLevel: number;
  airDoppler: number;
}
