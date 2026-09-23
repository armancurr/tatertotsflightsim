/**
 * PURE crash-sound planning: the randomised schedule of secondary explosions after an impact,
 * level laws for crash sounds heard from a distance, the burning fire's fade, and a rate limiter for
 * the crash effects' window events (`sim:explosion`, `sim:impact`). Total functions.
 */
import { CONFIG } from '../config';

const C = CONFIG.audio.crash;
const num = (v: number): number => (Number.isNaN(v) ? 0 : v);
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number): number => clamp(num(v), 0, 1);

export interface PlannedExplosion {
  /** Seconds after the impact. */
  at: number;
  /** 0..1 (1 = as big as the fuel-tank fireball). */
  size: number;
}

/**
 * Secondary explosions after a crash (fuel tanks, ammunition, hydraulics accumulators): more for a
 * harder impact, the first within about a second, then at random (exponential) gaps, getting
 * smaller; nothing after secondaryLastS. `rnd` returns floats in [0,1).
 */
export function secondaryExplosions(rnd: () => number, intensity: number): PlannedExplosion[] {
  const I = clamp01(intensity);
  const span = C.secondaryMax - C.secondaryMin;
  const n = clamp(C.secondaryMin + Math.floor(I * span + 0.999 * rnd() * 0.6 * (I + 0.2)), C.secondaryMin, C.secondaryMax);
  const first = C.secondaryFirstS;
  const last = C.secondaryLastS;
  const out: PlannedExplosion[] = [];
  let t = first + 0.5 * rnd();
  for (let i = 0; i < n; i++) {
    // Leave room for the remaining explosions before `last` (keeps the list strictly increasing).
    const room = last - 0.05 * (n - i);
    t = Math.min(t, room);
    if (out.length && t <= out[out.length - 1].at) t = out[out.length - 1].at + 0.05;
    const fade = 1 - (0.6 * i) / Math.max(1, n - 1);
    out.push({ at: t, size: clamp(fade * (0.55 + 0.45 * rnd()) * (0.6 + 0.4 * I), 0.1, 1) });
    // Shifted exponential gap: at least secondaryMinGapS, mean secondaryMeanGapS (no pile-up at the minimum).
    const u = Math.min(0.999, Math.max(0, rnd()));
    t += C.secondaryMinGapS - Math.log(1 - u) * Math.max(0, C.secondaryMeanGapS - C.secondaryMinGapS);
  }
  return out;
}

/** Crash sounds are loud and carry: full level within refDistanceM, then (ref/d)^distanceExponent. */
export function crashDistanceGain(distanceM: number): number {
  const d = clamp(num(Math.abs(distanceM)), 0, 1e7);
  if (d <= C.refDistanceM) return 1;
  return clamp01(Math.pow(C.refDistanceM / d, C.distanceExponent));
}

/** Debris/airframe impact intensity 0..1 from its speed (m/s). */
export function impactIntensity(speedMs: number): number {
  const v = clamp(num(Math.abs(speedMs)), 0, 1e6);
  return clamp01(Math.pow(v / C.impactFullMs, 0.8));
}

/**
 * Explosion size 0..1 from an event's `size` (the crash effects may send a 0..1 scale or a fireball
 * radius in metres; ≥ 1 is full size). Missing/NaN → a medium explosion.
 */
export function explosionSize(size: number): number {
  if (Number.isNaN(size)) return 0.6;
  return clamp01(size);
}

/** Level of the burning fire bed `ageS` after the crash (fades in over ~1 s, dies away over fireFadeS). */
export function fireLevel(ageS: number): number {
  const a = clamp(num(ageS), 0, 1e7);
  const fadeIn = 1 - Math.exp(-a / 0.25);
  return clamp01(C.fireLevel * fadeIn * Math.exp(-a / C.fireFadeS));
}

/** At most `maxPerS` events in any rolling second (clock `now`, seconds). */
export function createRateLimiter(maxPerS: number): (now: number) => boolean {
  const max = Math.max(1, Math.floor(num(maxPerS)));
  const times: number[] = [];
  return (now) => {
    const t = num(now);
    while (times.length && times[0] <= t - 1) times.shift();
    if (times.length >= max) return false;
    times.push(t);
    return true;
  };
}
