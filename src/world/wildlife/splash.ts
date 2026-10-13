/**
 * Water effects of the animals as stateless particles (PURE, no allocation): every particle of an
 * event is a closed-form function of the event's age and a per-particle hash, so nothing is pooled
 * or simulated and a paused sim shows a frozen splash. Drawn through the traffic point material
 * (soft, sun-lit, fogged sprites) by the renderer.
 *
 *  - dolphin breath: a small puff of vapour and spray as the blowhole breaks the surface
 *  - dolphin re-entry: a few droplets; a leap: a crown of spray and a sheet of droplets
 *  - humpback blow: a tall bushy column (≈ 4 m) that spreads, hangs and drifts downwind
 *  - breach: a huge splash (droplets to 10 m, a white collar, drifting mist); emergence: water
 *    streaming off the body; sounding: water pouring off the raised flukes
 */
import { WILDLIFE } from './tuning';

export interface PointSink {
  push(x: number, y: number, z: number, r: number, g: number, b: number, a: number, size: number, minPx: number, shape: number): boolean;
}

export const SplashKind = {
  DolphinPuff: 0,
  DolphinSplash: 1,
  DolphinLeap: 2,
  WhaleBlow: 10,
  WhaleBreach: 11,
  WhaleEmerge: 12,
  WhaleFluke: 13,
} as const;

/** How long (s) each kind of event shows. */
export const SPLASH_LIFE: Record<number, number> = {
  0: 1.4,
  1: 1.1,
  2: 1.8,
  10: WILDLIFE.whale.blowLife,
  11: 5,
  12: 2.6,
  13: 3,
};

/** Particles per event (the budget the renderer plans for). */
export const SPLASH_COUNT: Record<number, number> = { 0: 7, 1: 10, 2: 26, 10: 70, 11: 150, 12: 50, 13: 36 };

const hash = (a: number, b: number): number => {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h ^= h + Math.imul(h ^ (h >>> 7), h | 61);
  return ((h ^ (h >>> 14)) >>> 0) / 4294967296;
};

export interface SplashContext {
  /** Downwind unit direction and drift speed (m/s) for vapour. */
  windX: number;
  windZ: number;
  drift: number;
}

/**
 * Pushes an event's particles into `sink`. (x, y, z) = the origin at the water line; `key` makes
 * each event's scatter unique and stable; `size` scales it (animal size). Returns particles pushed.
 */
export function emitSplash(sink: PointSink, kind: number, age: number, x: number, y: number, z: number, size: number, key: number, ctx: SplashContext): number {
  const life = SPLASH_LIFE[kind];
  if (!(age >= 0) || age >= life) return 0;
  const n = SPLASH_COUNT[kind];
  let pushed = 0;
  const g = 9.81;
  for (let i = 0; i < n; i++) {
    const h1 = hash(key, i * 4 + 1);
    const h2 = hash(key, i * 4 + 2);
    const h3 = hash(key, i * 4 + 3);
    const a = h1 * Math.PI * 2;
    let px = x;
    let py = y;
    let pz = z;
    let alpha = 0;
    let sz = 0.1;
    let shape = 1;
    let bright = 0.95;
    switch (kind) {
      case SplashKind.DolphinPuff: {
        // vapour rising a metre, spreading, fading
        const t = age;
        const r = (0.1 + 0.35 * h2) * Math.min(1, t * 2) * size;
        px += Math.cos(a) * r + ctx.windX * ctx.drift * 0.4 * t;
        pz += Math.sin(a) * r + ctx.windZ * ctx.drift * 0.4 * t;
        py += (0.25 + 0.9 * h3) * size * (1 - Math.exp(-3 * t));
        alpha = 0.35 * (1 - t / life) * Math.min(1, t * 10);
        sz = (0.18 + 0.2 * h2) * size * (1 + 1.5 * t);
        break;
      }
      case SplashKind.DolphinSplash:
      case SplashKind.DolphinLeap: {
        const big = kind === SplashKind.DolphinLeap;
        const v0 = (big ? 2.5 + 4 * h3 : 1.2 + 2.2 * h3) * Math.sqrt(size);
        const spread = (big ? 0.5 + 1.8 * h2 : 0.25 + 0.6 * h2) * size;
        const t = age;
        const up = v0 * t - 0.5 * g * t * t;
        if (up < -0.05) continue;
        px += Math.cos(a) * spread * (0.4 + t * 1.5);
        pz += Math.sin(a) * spread * (0.4 + t * 1.5);
        py += Math.max(0, up);
        alpha = (big ? 0.7 : 0.55) * (1 - t / life);
        sz = (big ? 0.12 + 0.18 * h2 : 0.08 + 0.1 * h2) * size;
        // a few foam blobs stay on the water
        if (i % 5 === 0) {
          py = y + 0.05;
          alpha = 0.5 * (1 - t / life);
          sz = (big ? 0.6 : 0.35) * size * (1 + t);
        }
        break;
      }
      case SplashKind.WhaleBlow: {
        // column: fast rise in ~1 s to the top, bushy spread with height, then hang and drift
        const H = WILDLIFE.whale.blowHeight * size;
        const t = age;
        const f = h3; // height fraction along the column
        const rise = 1 - Math.exp(-4.5 * t);
        const hgt = H * f * rise * (0.85 + 0.3 * h2) - Math.max(0, t - 1.5) * 0.25;
        const bush = (0.15 + 1.1 * f * f) * size * (0.6 + 0.6 * h2) * (0.4 + Math.min(1, t * 1.2));
        const drift = ctx.drift * Math.max(0, t - 0.3) * (0.4 + 0.6 * f);
        px += Math.cos(a) * bush + ctx.windX * drift;
        pz += Math.sin(a) * bush + ctx.windZ * drift;
        py += Math.max(0.2, hgt);
        const fadeIn = Math.min(1, t * 6);
        alpha = 0.3 * fadeIn * Math.pow(1 - t / life, 1.4) * (0.6 + 0.4 * f);
        sz = (0.55 + 0.7 * h2) * size * (1 + 0.8 * t);
        bright = 0.97;
        break;
      }
      case SplashKind.WhaleBreach: {
        const t = age;
        if (i < 110) {
          const v0 = (6 + 11 * h3 * h3 + 4 * h3) * Math.sqrt(size);
          const up = v0 * t - 0.5 * g * t * t;
          if (up < -0.1) {
            // fallen back: leaves a white patch of foam that spreads and fades
            if (i % 3 !== 0) continue;
            py = y + 0.08;
            const r = (3 + 6 * h2) * size * (1 + t * 0.3);
            px += Math.cos(a) * r;
            pz += Math.sin(a) * r;
            alpha = 0.55 * (1 - t / life);
            sz = (1.6 + 1.5 * h2) * size;
            break;
          }
          const spread = (1 + 4.5 * h2) * size;
          px += Math.cos(a) * spread * (0.45 + t * 0.7);
          pz += Math.sin(a) * spread * (0.45 + t * 0.7);
          py += Math.max(0, up);
          alpha = 0.75 * (1 - t / life) * Math.min(1, t * 8);
          sz = (0.35 + 0.55 * h2) * size;
        } else {
          // mist: a cloud that billows and drifts
          const r = (2 + 7 * h2) * size * (0.3 + Math.min(1, t * 0.8));
          px += Math.cos(a) * r + ctx.windX * ctx.drift * t;
          pz += Math.sin(a) * r + ctx.windZ * ctx.drift * t;
          py += (1.5 + 9 * h3) * size * Math.min(1, t * 1.2);
          alpha = 0.22 * Math.min(1, t * 3) * (1 - t / life);
          sz = (2.2 + 2.2 * h3) * size * (1 + 0.4 * t);
        }
        break;
      }
      case SplashKind.WhaleEmerge: {
        // sheets of water falling off the rising body (a column of droplets)
        const t = age;
        const hgt = (1 + 6 * h3) * size * Math.min(1, t * 2);
        const fall = 0.5 * g * Math.max(0, t - 0.4 * h3) ** 2;
        py += Math.max(0, hgt - fall);
        const r = (0.8 + 2.2 * h2) * size;
        px += Math.cos(a) * r;
        pz += Math.sin(a) * r;
        alpha = 0.6 * (1 - t / life);
        sz = (0.3 + 0.4 * h2) * size;
        break;
      }
      case SplashKind.WhaleFluke: {
        // water pouring off the trailing edge of the flukes as they rise
        const t = age;
        const r = (0.5 + 2.3 * h2) * size;
        px += Math.cos(a) * r * 0.6;
        pz += Math.sin(a) * r * 0.6;
        const top = (2.5 + 2.5 * h3) * size * Math.min(1, t * 0.8);
        const drop = 0.5 * g * ((t * 1.7 + h1) % 1.1) ** 2;
        py += Math.max(0, top - drop);
        alpha = 0.55 * Math.min(1, t * 4) * (1 - t / life);
        sz = (0.12 + 0.2 * h2) * size;
        break;
      }
      default:
        continue;
    }
    if (alpha <= 0.003) continue;
    if (!sink.push(px, py, pz, bright, bright, bright * 1.02, alpha, sz, shape === 1 ? 1.6 : 1.2, shape)) return pushed;
    pushed++;
  }
  return pushed;
}

/**
 * Far away, a blow or a breach is a few pixels of many faint sprites that the point material dims
 * below a pixel — yet real blows are seen from kilometres off. One soft "whole event" sprite,
 * fading in with distance (none up close, where the particles carry it), keeps them readable from
 * an aircraft. Returns whether one was pushed.
 */
export function emitFarWhaleSprite(sink: PointSink, kind: number, age: number, x: number, y: number, z: number, size: number, dist: number, ctx: SplashContext): boolean {
  const far = Math.min(1, Math.max(0, (dist - 180) / 900));
  if (far <= 0) return false;
  if (kind === SplashKind.WhaleBlow) {
    const life = SPLASH_LIFE[kind];
    if (age >= life) return false;
    const H = WILDLIFE.whale.blowHeight * size;
    const rise = 1 - Math.exp(-4.5 * age);
    const drift = ctx.drift * Math.max(0, age - 0.3) * 0.7;
    const a = 0.55 * far * Math.min(1, age * 5) * Math.pow(1 - age / life, 1.3);
    return sink.push(x + ctx.windX * drift, y + H * 0.55 * rise, z + ctx.windZ * drift, 0.97, 0.97, 0.99, a, H * (0.7 + 0.3 * age), 2.5, 1);
  }
  if (kind === SplashKind.WhaleBreach) {
    const life = SPLASH_LIFE[kind];
    if (age >= life) return false;
    const a = 0.7 * far * Math.min(1, age * 6) * Math.pow(1 - age / life, 1.5);
    return sink.push(x, y + 4 * size * Math.min(1, age * 1.5), z, 0.97, 0.97, 0.99, a, (9 + 5 * age) * size, 3, 1);
  }
  return false;
}
