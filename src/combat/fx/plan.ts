/**
 * PURE combat-effects plan (no three.js): which recipe an impact surface gets, dust colours, the
 * deterministic secondary explosion of a destroyed vehicle (the audio system plays its boom at the
 * same moment), and the camera-shake laws — the GAU-8 vibrating the airframe, and blasts that shake
 * only once their pressure wave has travelled to the camera (d / c) and then decay. Total functions.
 */
import { CONFIG } from '../../config';
import type { SurfaceType } from '../../types';
import type { ImpactSurface, TargetKind } from '../types';

const C = CONFIG.fx.combat;

export type ImpactClass = 'soil' | 'hard' | 'water' | 'snow' | 'armour';
/** Numeric codes for the preallocated batch (Uint8Array). */
export const CLASS_CODE: Record<ImpactClass, number> = { soil: 0, hard: 1, water: 2, snow: 3, armour: 4 };
export const CLASS_OF_CODE: readonly ImpactClass[] = ['soil', 'hard', 'water', 'snow', 'armour'];

const HARD = new Set<string>(['runway', 'asphalt', 'urban', 'rock']);

const clamp01 = (v: number) => (v > 0 ? (v < 1 ? v : 1) : 0);
const fin = (v: number, d = 0) => (Number.isFinite(v) ? v : d);

/** The effect recipe for a surface (unknown → soil). */
export function impactClass(surface: ImpactSurface | string): ImpactClass {
  if (surface === 'target') return 'armour';
  if (surface === 'water') return 'water';
  if (surface === 'snow') return 'snow';
  if (typeof surface === 'string' && HARD.has(surface)) return 'hard';
  return 'soil';
}

/** Linear albedo of the dust (or spray) an impact throws up from `surface`. */
export function dustAlbedo(surface: SurfaceType | ImpactSurface | string): readonly [number, number, number] {
  switch (surface) {
    case 'sand': return C.sandAlbedo;
    case 'grass':
    case 'forest': return C.grassAlbedo;
    case 'runway':
    case 'asphalt':
    case 'urban':
    case 'rock':
    case 'target': return C.hardAlbedo;
    case 'snow': return C.snowAlbedo;
    case 'water': return CONFIG.fx.touchdown.sprayAlbedo;
    default: return C.soilAlbedo;
  }
}

/** Integer hash → [0, 1). */
function hash01(a: number, b: number): number {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b | 0, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

export interface SecondaryPlan {
  /** Seconds after the kill, or null (no secondary for this vehicle). */
  delayS: number | null;
  /** 0..1 relative to the first explosion. */
  size: number;
}

/**
 * The secondary pop of a destroyed vehicle (ammunition / fuel cooking off): deterministic in the
 * target id and kill time, so the effects and the sound agree without talking to each other.
 */
export function secondaryPlan(targetId: number, kind: TargetKind, time: number): SecondaryPlan {
  const id = Number.isFinite(targetId) ? Math.trunc(targetId) : 0;
  const tq = Number.isFinite(time) ? Math.round(time * 1000) : 0;
  const chance = (C.destroyed.secondaryChance as Record<string, number>)[kind] ?? 0.5;
  const size = 0.35 + 0.45 * hash01(id, tq + 17);
  if (hash01(id, tq) >= chance) return { delayS: null, size };
  const [lo, hi] = C.destroyed.secondary;
  return { delayS: lo + (hi - lo) * hash01(id * 31 + 7, tq), size };
}

/** Speed-of-sound travel time over `distanceM` (≥ 0, finite; garbage → 0). */
export function soundArrivalS(distanceM: number): number {
  const d = fin(distanceM);
  const t = d > 0 ? Math.min(d, 1e6) / C.shake.speedOfSoundMs : 0;
  return Number.isFinite(t) ? t : 0;
}

/** Airframe vibration from the gun: strong in the cockpit, light outside; × barrel spin; 0 when not firing. */
export function gunShake(spin: number, firing: boolean, cockpit: boolean): number {
  if (!firing) return 0;
  const s = clamp01(fin(spin));
  const k = cockpit ? C.shake.gunCockpit : C.shake.gunOutside;
  return clamp01(k * (0.35 + 0.65 * s));
}

/**
 * Shake from a blast of `size` (Maverick = 1) at `distanceM`, `ageS` after the detonation: nothing
 * until the pressure wave arrives, then blastMax·size/(1 + (d/ref)²), decaying with blastTau.
 */
export function blastShake(size: number, distanceM: number, ageS: number): number {
  const S = C.shake;
  const d = Math.max(0, fin(distanceM, 1e9));
  const age = fin(ageS, -1);
  const since = age - soundArrivalS(d);
  if (!(since >= 0)) return 0;
  const sz = Math.min(2, Math.max(0, fin(size)));
  const r = d / S.blastRefM;
  const v = (S.blastMax * Math.min(1, sz)) / (1 + r * r) * Math.exp(-since / S.blastTau);
  return Number.isFinite(v) ? Math.min(S.blastMax, clamp01(v)) : 0;
}

/** Independent shake sources combine like probabilities: never above 1, each one adds. */
export function combineShake(a: number, b: number): number {
  const v = 1 - (1 - clamp01(fin(a))) * (1 - clamp01(fin(b)));
  return Number.isFinite(v) ? clamp01(v) : 0;
}

/** A detonation this far above the ground (m) is an air burst (self-destruct): no ground ring, no dirt. */
export function isAirBurst(y: number, groundY: number): boolean {
  const h = y - groundY;
  return Number.isFinite(h) && h > C.missile.airBurstM;
}
