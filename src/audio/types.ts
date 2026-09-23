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
  /** Which engine voice plays: the Cessna's O-360 + prop ('piston'), the F-16's F110 ('jet'), the A-10's TF34s ('turbofan'). */
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
