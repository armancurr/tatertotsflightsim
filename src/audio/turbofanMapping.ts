/**
 * PURE mappings for the A-10's TF34-GE-100A high-bypass turbofans (aircraft sound 'turbofan'):
 * the "Hog whistle" is the fan's blade-pass tone (28 blades × N1 shaft rate: ≈1.2 kHz at ground
 * idle, ≈3.4 kHz at 100 % N1) over a soft low roar (high-bypass: slow, quiet jet). Total functions.
 */
import { CONFIG } from '../config';

const T = CONFIG.audio.turbofan;
const num = (v: number): number => (Number.isNaN(v) ? 0 : v);
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number): number => clamp(num(v), 0, 1);

/** Fan speed N1 % for a core speed N2 % (the fan lags far behind the core at low power). */
export function tf34FanPct(corePct: number): number {
  const c = clamp(num(corePct), 0, 110);
  const x = clamp01((c - T.fanStartCorePct) / (100 - T.fanStartCorePct));
  return 100 * Math.pow(x, T.fanExponent) + Math.max(0, c - 100);
}

/** The whistle: fan blade-pass frequency, Hz. */
export function tf34WhistleHz(corePct: number): number {
  return (tf34FanPct(corePct) / 100) * (T.fanMaxRpm / 60) * T.fanBlades;
}

/** Faint high core-compressor whine, Hz. */
export function tf34CoreHz(corePct: number): number {
  return (clamp(num(corePct), 0, 110) / 100) * (T.coreMaxRpm / 60) * T.coreBlades;
}

export interface TurbofanMix {
  whistle: number;
  roar: number;
  rumble: number;
  core: number;
  starter: number;
  /** Roar low-pass openness 0..1. */
  brightness: number;
}

/** Channel levels 0..1 (monotone in power). */
export function turbofanMix(corePct: number, power: number, running: boolean, starting: boolean, crashed: boolean, out?: TurbofanMix): TurbofanMix {
  const o = out ?? { whistle: 0, roar: 0, rumble: 0, core: 0, starter: 0, brightness: 0 };
  let core = clamp(num(corePct), 0, 110);
  if (running && !starting) core = Math.max(core, T.idleCorePct);
  if (crashed || (core <= 0 && !starting)) {
    o.whistle = o.roar = o.rumble = o.core = o.starter = o.brightness = 0;
    return o;
  }
  const p = running ? clamp01(power) : 0;
  const spool = clamp01(core / T.idleCorePct);
  const fan = tf34FanPct(core) / 100;
  o.whistle = clamp01(spool * (0.55 + 0.45 * fan));
  o.core = clamp01(spool * (0.5 + 0.5 * fan));
  o.roar = running ? clamp01(0.25 + 0.75 * Math.pow(p, 1.2)) : 0;
  o.rumble = running ? clamp01(0.3 + 0.7 * p) : 0;
  o.starter = starting ? 1 : 0;
  o.brightness = clamp01(0.25 + 0.75 * p);
  return o;
}
