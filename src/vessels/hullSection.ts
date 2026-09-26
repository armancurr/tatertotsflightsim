/**
 * Pure hull-section maths for any vessel whose hull is a table of transverse stations
 * (`HullStation[]` in src/config.ts): each station is a hard-chine section — keel point
 * (0, keelY), a straight V bottom to the chine (±chineHalf, chineY), straight topsides to the
 * deck edge (±deckHalf, deckY). Between stations every field is interpolated along z with a
 * monotone (Fritsch–Carlson / PCHIP) cubic: smooth, exact at the stations, and never overshooting
 * the table (a fine bow can't bulge past its neighbours). Outside the table the end stations hold.
 *
 * No three.js here: the physics, the 3D loft (src/vessels/hullLoft.ts) and the tests all read the
 * same functions, so what is drawn is what floats. Body frame: +X starboard, +Y up, −Z bow, metres.
 */
import type { HullStation } from '../config';

/** One transverse section of the hull (the same fields as a station). */
export interface HullSection {
  z: number;
  keelY: number;
  chineHalf: number;
  chineY: number;
  deckHalf: number;
  deckY: number;
}

const FIELDS = ['keelY', 'chineHalf', 'chineY', 'deckHalf', 'deckY'] as const;
type Field = (typeof FIELDS)[number];

/** Monotone cubic (PCHIP) through (xs, ys): returns the tangents at the knots. xs ascending. */
export function pchipTangents(xs: readonly number[], ys: readonly number[]): number[] {
  const n = xs.length;
  const m = new Array<number>(n).fill(0);
  if (n < 2) return m;
  const h: number[] = [];
  const d: number[] = [];
  for (let k = 0; k < n - 1; k++) {
    h.push(xs[k + 1] - xs[k]);
    d.push((ys[k + 1] - ys[k]) / (xs[k + 1] - xs[k]));
  }
  if (n === 2) {
    m[0] = m[1] = d[0];
    return m;
  }
  for (let k = 1; k < n - 1; k++) {
    if (d[k - 1] * d[k] <= 0) m[k] = 0;
    else {
      // Weighted harmonic mean (Fritsch–Butland): keeps the curve monotone between knots.
      const w1 = 2 * h[k] + h[k - 1];
      const w2 = h[k] + 2 * h[k - 1];
      m[k] = (w1 + w2) / (w1 / d[k - 1] + w2 / d[k]);
    }
  }
  // Ends: one-sided three-point estimate, clipped to stay shape-preserving.
  const end = (h0: number, h1: number, d0: number, d1: number) => {
    let t = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
    if (Math.sign(t) !== Math.sign(d0)) t = 0;
    else if (Math.sign(d0) !== Math.sign(d1) && Math.abs(t) > Math.abs(3 * d0)) t = 3 * d0;
    return t;
  };
  m[0] = end(h[0], h[1], d[0], d[1]);
  m[n - 1] = end(h[n - 2], h[n - 3], d[n - 2], d[n - 3]);
  return m;
}

/** Evaluate the PCHIP (knots xs, values ys, tangents ms) at x; clamps to the end values outside. */
export function pchipEval(xs: readonly number[], ys: readonly number[], ms: readonly number[], x: number): number {
  const n = xs.length;
  if (n === 0) return NaN;
  if (n === 1 || x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  const h = xs[hi] - xs[lo];
  const t = (x - xs[lo]) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * ys[lo] + (t3 - 2 * t2 + t) * h * ms[lo] + (-2 * t3 + 3 * t2) * ys[hi] + (t3 - t2) * h * ms[hi];
}

/** A hull's station table prepared for fast lookups. */
export interface HullInterpolator {
  stations: readonly HullStation[];
  /** Bow (first station) and stern (last station) z. */
  zBow: number;
  zStern: number;
  /** The section at z (writes into `out` when given: no allocation). */
  at(z: number, out?: HullSection): HullSection;
}

/** Prepare a station table (bow → stern, z strictly ascending) for interpolation. */
export function createHullInterpolator(stations: readonly HullStation[]): HullInterpolator {
  if (stations.length === 0) throw new Error('hull: empty station table');
  for (let k = 1; k < stations.length; k++) {
    if (!(stations[k].z > stations[k - 1].z)) throw new Error('hull: stations must be ordered bow → stern (z ascending)');
  }
  const xs = stations.map((s) => s.z);
  const table = {} as Record<Field, { ys: number[]; ms: number[] }>;
  for (const f of FIELDS) {
    const ys = stations.map((s) => s[f]);
    table[f] = { ys, ms: pchipTangents(xs, ys) };
  }
  return {
    stations,
    zBow: xs[0],
    zStern: xs[xs.length - 1],
    at(z: number, out?: HullSection): HullSection {
      const o = out ?? ({} as HullSection);
      o.z = z;
      for (const f of FIELDS) o[f] = pchipEval(xs, table[f].ys, table[f].ms, z);
      // Keep the section well-formed between stations (chine never above the deck, below the keel).
      if (o.chineY < o.keelY) o.chineY = o.keelY;
      if (o.deckY < o.chineY) o.deckY = o.chineY;
      if (o.chineHalf < 0) o.chineHalf = 0;
      if (o.deckHalf < 0) o.deckHalf = 0;
      return o;
    },
  };
}

const cache = new WeakMap<readonly HullStation[], HullInterpolator>();

/** The interpolated section of `stations` at z (the interpolator is cached per table). */
export function hullSectionAt(stations: readonly HullStation[], z: number, out?: HullSection): HullSection {
  let h = cache.get(stations);
  if (!h) {
    h = createHullInterpolator(stations);
    cache.set(stations, h);
  }
  return h.at(z, out);
}

/**
 * Half-breadth of a section at height y (the hull's outer skin): 0 at and below the keel, the
 * straight bottom up to the chine, the straight topsides up to the deck edge; the deck edge's
 * half-breadth above the deck.
 */
export function sectionHalfBreadth(s: HullSection, y: number): number {
  if (y <= s.keelY) return 0;
  if (y <= s.chineY) {
    const h = s.chineY - s.keelY;
    return h > 1e-9 ? (s.chineHalf * (y - s.keelY)) / h : s.chineHalf;
  }
  if (y <= s.deckY) {
    const h = s.deckY - s.chineY;
    return h > 1e-9 ? s.chineHalf + ((s.deckHalf - s.chineHalf) * (y - s.chineY)) / h : s.deckHalf;
  }
  return s.deckHalf;
}

/**
 * Height of the hull bottom under |x| (the V bottom out to the chine, then the topsides): the
 * keel at x = 0, the chine at chineHalf, the deck edge at deckHalf; NaN outboard of the deck edge.
 */
export function sectionBottomY(s: HullSection, x: number): number {
  const ax = Math.abs(x);
  if (ax <= s.chineHalf) return s.chineHalf > 1e-9 ? s.keelY + ((s.chineY - s.keelY) * ax) / s.chineHalf : s.keelY;
  if (ax <= s.deckHalf) {
    const w = s.deckHalf - s.chineHalf;
    return w > 1e-9 ? s.chineY + ((s.deckY - s.chineY) * (ax - s.chineHalf)) / w : s.chineY;
  }
  return NaN;
}

/** Area of the section below height yTop (default: the whole section up to the deck line), m². */
export function sectionArea(s: HullSection, yTop = s.deckY): number {
  const top = Math.min(yTop, s.deckY);
  if (top <= s.keelY) return 0;
  // Integrate 2·halfBreadth(y) dy: the V bottom (linear in y) then the topsides (linear in y).
  const seg = (y0: number, y1: number) => {
    if (y1 <= y0) return 0;
    return (sectionHalfBreadth(s, y0) + sectionHalfBreadth(s, y1)) * (y1 - y0);
  };
  const yc = Math.min(top, s.chineY);
  return seg(s.keelY, yc) + seg(Math.max(s.keelY, s.chineY), top);
}

/**
 * A point on the starboard half of a section's outline by girth parameter t ∈ [0, 2]: 0 = keel,
 * 1 = chine, 2 = deck edge (linear in between). Mirror x for port.
 */
export function sectionOutlinePoint(s: HullSection, t: number): { x: number; y: number } {
  if (t <= 1) {
    const u = Math.max(0, t);
    return { x: s.chineHalf * u, y: s.keelY + (s.chineY - s.keelY) * u };
  }
  const u = Math.min(1, t - 1);
  return { x: s.chineHalf + (s.deckHalf - s.chineHalf) * u, y: s.chineY + (s.deckY - s.chineY) * u };
}
