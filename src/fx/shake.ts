/**
 * PURE camera feel: shake intensity (0..1, fed to CameraInput.shake — the rig squares it into
 * an amplitude) and a subtle speed-dependent FOV widening. Every input may be garbage
 * (NaN/±Infinity): the outputs are always finite and in range.
 */
import { CONFIG } from '../config';
import type { SurfaceType } from '../types';

export interface ShakeInputs {
  onGround: boolean;
  groundSpeedKt: number;
  surface: SurfaceType;
  aoaDeg: number;
  /** Stall angle of attack for the current configuration, degrees. */
  stallAoaDeg: number;
  airspeedKt: number;
  vneKt: number;
  /** Seconds since the crash, or null. */
  crashAge: number | null;
}

const clamp01 = (v: number) => (v > 0 ? (v < 1 ? v : 1) : 0);
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const num = (v: number, fallback = 0) => (Number.isNaN(v) ? fallback : v);

/** Camera shake intensity 0..1 from ground roll, stall buffet, overspeed vibration and a crash. */
export function cameraShakeFor(s: ShakeInputs): number {
  const S = CONFIG.fx.shake;
  // Ground roll: surface roughness × speed.
  let roll = 0;
  if (s.onGround) {
    const r = (S.surfaceRoughness as Record<string, number>)[s.surface];
    const rough = Number.isFinite(r) ? clamp01(r) : 0.8;
    const gs = clamp01(num(s.groundSpeedKt) / S.rollFullKt);
    roll = S.rollMax * rough * Math.pow(gs, 0.7);
  }
  // Stall buffet: needs airflow over the wing.
  const stall = Number.isFinite(s.stallAoaDeg) ? s.stallAoaDeg : 16;
  const aoa = num(s.aoaDeg, -90);
  const ias = num(s.airspeedKt);
  const flow = smooth(8, 30, ias);
  const buffet = S.buffetMax * smooth(stall - S.buffetMarginDeg, stall + S.buffetPastDeg, aoa) * flow;
  // Overspeed.
  const vne = Number.isFinite(s.vneKt) && s.vneKt > 0 ? s.vneKt : 163;
  const over = S.overspeedMax * smooth(vne * S.overspeedStart, vne * S.overspeedFull, ias);
  // Crash.
  const age = s.crashAge;
  const crash = age !== null && Number.isFinite(age) && age >= 0 ? Math.exp(-S.crashDecay * age) : 0;
  // Independent sources combine like probabilities: never above 1, each one always adds.
  const v = 1 - (1 - clamp01(roll)) * (1 - clamp01(buffet)) * (1 - clamp01(over)) * (1 - clamp01(crash));
  return Number.isFinite(v) ? clamp01(v) : 0;
}

/** FOV widening (degrees) with airspeed — a subtle sense of speed. */
export function speedFovOffset(airspeedKt: number): number {
  const F = CONFIG.fx.fov;
  const v = F.maxDeg * smooth(F.startKt, F.fullKt, num(airspeedKt));
  return Number.isFinite(v) ? Math.min(F.maxDeg, Math.max(0, v)) : 0;
}
