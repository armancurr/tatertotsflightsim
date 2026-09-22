/**
 * PURE mappings from the flight situation to synthesiser parameters. No WebAudio here —
 * every function is total (NaN/±Infinity in → finite, bounded value out), so the synth
 * can hand the results straight to AudioParam.setTargetAtTime (which throws on non-finite).
 *
 * Engine model: Lycoming O-360, 4 cylinders, 4-stroke → each cylinder fires once every two
 * revolutions → 2 firing pulses per crank revolution: f_fire = rpm/60 × cylinders/2.
 * The full 4-stroke cycle (all 4 cylinders once) repeats at rpm/120 — the "lumpy" half-orders
 * of a real aero engine come from cylinder-to-cylinder differences within that cycle.
 * 2-blade propeller: blade-pass frequency = rpm/60 × 2 (coincides with the firing rate).
 */
import { CONFIG } from '../config';
import type { CameraMode, SurfaceType } from '../types';

const A = CONFIG.audio;
const MAX_RPM_FOR_AUDIO = 4000;

const finite = (v: number, fallback = 0): number => (Number.isFinite(v) ? v : fallback);
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number): number => clamp(finite(v), 0, 1);
/** Hermite smoothstep, total. */
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((finite(x) - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}
/** Sanitised rpm: finite, 0..MAX_RPM_FOR_AUDIO (NaN → 0, +∞ → max). */
const rpmOf = (rpm: number): number => (Number.isNaN(rpm) ? 0 : clamp(rpm, 0, MAX_RPM_FOR_AUDIO));
/** Sanitised non-negative magnitude (NaN → 0, +∞ → big finite). */
const mag = (v: number, max = 1e6): number => (Number.isNaN(v) ? 0 : clamp(Math.abs(v), 0, max));
const pos = (v: number, max = 1e6): number => (Number.isNaN(v) ? 0 : clamp(v, 0, max));

// ─── Engine ──────────────────────────────────────────────────────────────────

/** Cylinder firing frequency, Hz: rpm/60 × cylinders/2 (4-stroke). */
export function firingFrequency(rpm: number, cylinders: number = A.cylinders): number {
  return (rpmOf(rpm) / 60) * (cylinders / 2);
}

/** Frequency of one complete 4-stroke cycle (two revolutions), Hz. */
export function cycleFrequency(rpm: number): number {
  return rpmOf(rpm) / 120;
}

/** Propeller blade-pass frequency, Hz. */
export function bladePassFrequency(rpm: number, blades: number = A.propBlades): number {
  return (rpmOf(rpm) / 60) * blades;
}

/** Centre of the exhaust-noise band (the "chuff"), rises with rpm, Hz. */
export function exhaustCenterHz(rpm: number): number {
  return 130 + (rpmOf(rpm) / CONFIG.aircraft.engine.maxRpm) * 420;
}

export interface EngineMixInput {
  rpm: number;
  power: number;
  engineRunning: boolean;
  starting: boolean;
  crashed: boolean;
}

export interface EngineMix {
  /** Exhaust pulses + firing tone (only when the engine is running). */
  exhaust: number;
  /** Propeller buzz + blade slap (rises steeply with tip speed, and with blade loading). */
  prop: number;
  /** Valve-train / gear-case tick. */
  mechanical: number;
  /** Starter motor while cranking. */
  starter: number;
  /** 0..1 spectral brightness of the engine tone (opens its low-pass with power). */
  brightness: number;
}

/** Relative loudness of the engine's sound channels, each 0..1. Monotone in rpm and power. */
export function engineMix(a: EngineMixInput): EngineMix {
  if (a.crashed) return { exhaust: 0, prop: 0, mechanical: 0, starter: 0, brightness: 0 };
  const rpm = rpmOf(a.rpm);
  const rpmN = clamp(rpm / CONFIG.aircraft.engine.maxRpm, 0, 1);
  const p = clamp01(a.power);
  const firing = a.engineRunning ? smoothstep(A.firingMinRpm * 0.5, A.firingMinRpm * 1.6, rpm) : 0;
  const exhaust = firing * (A.idleLoudness + (1 - A.idleLoudness) * Math.pow(p, 0.8));
  const load = a.engineRunning ? 0.35 + 0.65 * p : 0.35;
  const prop = clamp01(rpmN * rpmN * load);
  const mechanical = clamp01(Math.pow(rpmN, 0.8) * (a.engineRunning ? 1 : 0.55));
  const starter = a.starting ? 1 : 0;
  const brightness = clamp01(0.25 * rpmN + 0.75 * (a.engineRunning ? p : 0));
  return { exhaust: clamp01(exhaust), prop, mechanical, starter, brightness };
}

// ─── Airflow ─────────────────────────────────────────────────────────────────

/** Wind/airflow noise level 0..1 (grows ~V^1.6, saturates at windFullKt). */
export function windGain(airspeedKt: number): number {
  const v = pos(airspeedKt);
  return clamp01(Math.pow(clamp01((v - 4) / (A.windFullKt - 4)), 1.6));
}

/** Band-pass centre of the wind noise, Hz (windMinHz → windMaxHz). */
export function windCenterHz(airspeedKt: number): number {
  const t = Math.pow(clamp01(pos(airspeedKt) / A.windTopKt), 0.85);
  return A.windMinHz + (A.windMaxHz - A.windMinHz) * t;
}

/** Cockpit door-seal whistle level 0..1 (cockpit view only). */
export function whistleGain(airspeedKt: number, cameraMode: CameraMode): number {
  if (cameraMode !== 'cockpit') return 0;
  return smoothstep(A.whistleStartKt, A.whistleFullKt, pos(airspeedKt));
}

// ─── Ground ──────────────────────────────────────────────────────────────────

const PAVED: ReadonlySet<string> = new Set(['runway', 'asphalt', 'urban']);

function roughness(surface: SurfaceType): number {
  const r = (A.surfaceRumble as Record<string, number>)[surface];
  return Number.isFinite(r) ? clamp(r, 0, 1) : 0.8;
}

/** Tyre rolling rumble level 0..1. */
export function rollingGain(groundSpeedKt: number, onGround: boolean, surface: SurfaceType): number {
  if (!onGround) return 0;
  const gs = pos(groundSpeedKt);
  if (gs < 0.3) return 0;
  return clamp01(roughness(surface) * Math.pow(clamp01(gs / A.rollingFullKt), 0.75));
}

/** Low-pass cutoff of the rolling rumble, Hz: faster/rougher → brighter. */
export function rollingCutoffHz(groundSpeedKt: number, surface: SurfaceType): number {
  const gs = clamp01(pos(groundSpeedKt) / 90);
  return 60 + gs * (300 + 900 * roughness(surface));
}

/** Brake scrub/squeal level 0..1 (paved surfaces squeal, soft ground only scrubs). */
export function brakeScrubGain(brake: number, groundSpeedKt: number, surface: SurfaceType, onGround: boolean): number {
  if (!onGround) return 0;
  const b = clamp01(brake);
  const s = smoothstep(2, 30, pos(groundSpeedKt));
  return clamp01(b * s * (PAVED.has(surface) ? 1 : 0.35));
}

// ─── Events ──────────────────────────────────────────────────────────────────

/** Touchdown chirp/thump intensity 0..1 from the vertical speed at contact (fpm, either sign). 0 = no touchdown. */
export function touchdownIntensity(fpm: number | null): number {
  if (fpm === null || Number.isNaN(fpm)) return 0;
  const v = mag(fpm);
  const t = clamp01((v - A.touchdownMinFpm) / (A.touchdownFullFpm - A.touchdownMinFpm));
  return clamp01(0.08 + 0.92 * Math.pow(t, 0.9));
}

/** Stall warning horn: the reed needs airflow, and a wreck is silent. */
export function stallHornOn(stallWarning: boolean, airspeedKt: number, crashed: boolean): boolean {
  return !!stallWarning && !crashed && Number.isFinite(airspeedKt) && airspeedKt >= A.stallHornMinKt;
}

/** Crash boom/debris intensity 0.3..1 from the impact speed (kt). */
export function crashIntensity(speedKt: number): number {
  return 0.3 + 0.7 * Math.pow(clamp01(pos(speedKt) / 140), 0.7);
}

// ─── Listener / view ─────────────────────────────────────────────────────────

/** Low-pass cutoff of the aircraft sound for the view: muffled cabin, or open exterior dulled by distance. */
export function viewCutoffHz(cameraMode: CameraMode, distanceM: number = A.refDistanceM): number {
  if (cameraMode === 'cockpit') return A.cabinCutoffHz;
  const d = Math.max(0, pos(distanceM, 1e7) - A.refDistanceM);
  return clamp(A.exteriorCutoffHz / (1 + d / A.absorptionHalfM), 600, A.exteriorCutoffHz);
}

/** Exterior distance attenuation 0..1 (inverse distance beyond refDistanceM); 1 in the cockpit. */
export function distanceGain(cameraMode: CameraMode, distanceM: number = A.refDistanceM): number {
  if (cameraMode === 'cockpit') return 1;
  const d = pos(distanceM, 1e7);
  return clamp01(A.refDistanceM / Math.max(A.refDistanceM, d));
}

/** Level of cabin-only sounds (horn, motors, whistle) for the view. */
export function cabinBusGain(cameraMode: CameraMode): number {
  return cameraMode === 'cockpit' ? 1 : A.exteriorCabinGain;
}

/** Doppler pitch factor for a source approaching the listener at `closingSpeedMs` (+ = approaching). */
export function dopplerFactor(closingSpeedMs: number): number {
  const c = A.speedOfSoundMs;
  const v = Number.isNaN(closingSpeedMs) ? 0 : clamp(closingSpeedMs, -0.4 * c, 0.4 * c);
  return c / (c - v);
}

/** Master output gain: silent when muted or paused. */
export function masterGain(muted: boolean, paused: boolean, volume: number = A.masterVolume): number {
  return muted || paused ? 0 : clamp01(volume);
}
