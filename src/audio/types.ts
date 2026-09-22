import type { CameraMode, SurfaceType } from '../types';

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
}

export interface AudioSystem {
  /** Create/resume the AudioContext. Call on the first user gesture (keydown/pointerdown). Never throws. */
  resume(): Promise<void>;
  /** Per-frame update (dt in seconds). Never throws. */
  update(a: AudioInputs, dt: number): void;
  setMuted(m: boolean): void;
  readonly muted: boolean;
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
}
