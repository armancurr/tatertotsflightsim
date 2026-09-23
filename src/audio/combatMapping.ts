/**
 * PURE combat-sound mappings (total functions: NaN/±∞ in → finite, bounded out):
 *   - propagation: speed-of-sound delay, air absorption (a low-pass falling with distance), level;
 *   - the gun: firing rate (the fundamental of the "BRRRT") while the barrels spin up, drive whine,
 *     timbre per calibre (30 mm GAU-8/A vs 20 mm M61A1), the muzzle-blast pulse waveform;
 *   - the missile motor heard from a distance (a simple flight-path estimate from the launch).
 */
import { CONFIG } from '../config';
import type { Vec3 } from '../types';

const C = CONFIG.audio.combat;
const num = (v: number): number => (Number.isNaN(v) ? 0 : v);
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const fin = (v: number, d = 0): number => (Number.isFinite(v) ? v : d);

/** Speed-of-sound travel time over `distanceM`, s, in [0, maxDelayS]. */
export function soundDelayS(distanceM: number): number {
  return clamp(Math.max(0, num(distanceM)) / C.speedOfSoundMs, 0, C.maxDelayS);
}

/** Air absorption: low-pass cutoff (Hz) for a source `distanceM` away (halves every absorptionHalfM). */
export function airCutoffHz(distanceM: number): number {
  const d = Math.max(0, num(distanceM));
  return clamp(C.maxCutoffHz * Math.pow(0.5, d / C.absorptionHalfM), C.minCutoffHz, C.maxCutoffHz);
}

/** Distance attenuation: 1 within refM, then (refM / d)^distanceExponent. */
export function combatDistanceGain(distanceM: number, refM: number = C.refDistanceM): number {
  const d = Math.max(0, num(distanceM));
  const r = Math.max(1, fin(refM, C.refDistanceM));
  if (d <= r) return 1;
  const g = Math.pow(r / d, C.distanceExponent);
  return Number.isFinite(g) ? clamp(g, 0, 1) : 0;
}

/** Firing rate (Hz) — the fundamental of the gun's buzz — for a barrel spin 0..1 (0 = not turning). */
export function gunRateHz(rateRps: number, spin: number): number {
  const s = clamp(num(spin), 0, 1);
  const r = clamp(num(rateRps), 0, 200);
  if (s <= 0 || r <= 0) return 0;
  return r * Math.max(C.gun.minRateFraction, s);
}

/** Barrel drive whine, Hz, rising with the spin. */
export function gunWhineHz(spin: number): number {
  const [lo, hi] = C.gun.whineHz;
  return lo + (hi - lo) * clamp(num(spin), 0, 1);
}

export interface GunTimbre {
  thump: number;
  tearHz: number;
}

/** Timbre by calibre: the 30 mm GAU-8/A thumps harder and tears lower than the 20 mm M61A1. */
export function gunTimbre(caliberMm: number): GunTimbre {
  const small = num(caliberMm) > 0 && caliberMm < C.gun.smallCaliberMm;
  return small ? { thump: C.gun.smallThump, tearHz: C.gun.smallTearHz } : { thump: C.gun.thump, tearHz: C.gun.tearHz };
}

/**
 * One period of the gun's pressure signature: each round's muzzle blast — a steep positive spike
 * (Friedlander-like), a longer negative phase, a little ringing — normalised to peak 1.
 */
export function muzzleBlastWaveform(n: number): Float32Array {
  const s = new Float32Array(Math.max(8, n | 0));
  let peak = 0;
  for (let j = 0; j < s.length; j++) {
    const t = j / s.length;
    const pos = t < 0.12 ? (1 - t / 0.12) * Math.exp((-3 * t) / 0.12) * (1 - Math.exp(-t / 0.004)) : 0;
    const neg = t >= 0.1 && t < 0.5 ? -0.32 * Math.sin((Math.PI * (t - 0.1)) / 0.4) : 0;
    const ring = 0.08 * Math.sin(2 * Math.PI * 7 * t) * Math.exp(-t / 0.2);
    s[j] = pos + neg + ring;
    peak = Math.max(peak, Math.abs(s[j]));
  }
  if (peak > 0) for (let j = 0; j < s.length; j++) s[j] /= peak;
  return s;
}

/** Motor level of an AGM-65 `ageS` after launch: the boost roar, then the sustain hiss until burnout. */
export function motorLevel(ageS: number): number {
  const a = num(ageS);
  if (a < 0 || a > 30) return 0;
  if (a < 1.2) return 1;
  return 0.55;
}

/**
 * Where a missile launched at `p0` with velocity `v0` roughly is after `ageS` (it accelerates along
 * the launch direction to cruiseMs): good enough for the distance of its receding motor.
 */
export function missilePosition(p0: Vec3, v0: Vec3, ageS: number, cruiseMs: number, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  const a = clamp(num(ageS), 0, 60);
  const vx = fin(v0.x), vy = fin(v0.y), vz = fin(v0.z);
  const sp = Math.hypot(vx, vy, vz);
  const ux = sp > 1 ? vx / sp : 0, uy = sp > 1 ? vy / sp : 0, uz = sp > 1 ? vz / sp : -1;
  const target = Math.max(sp, fin(cruiseMs, 300));
  const acc = 120;
  const tAcc = (target - sp) / acc;
  const dist = a < tAcc ? sp * a + 0.5 * acc * a * a : sp * tAcc + 0.5 * acc * tAcc * tAcc + target * (a - tAcc);
  out.x = fin(p0.x) + ux * dist;
  out.y = fin(p0.y) + uy * dist;
  out.z = fin(p0.z) + uz * dist;
  return out;
}
