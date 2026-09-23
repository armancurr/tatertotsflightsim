/**
 * PURE shape of the Boeing 747-400 (no three.js): the anchor points shared with the physics
 * (`B747_AIRCRAFT.geometry`), the fuselage cross-sections (main lobe + the upper-deck hump,
 * blended with a smooth max so the famous waist fillets itself; the wing-body fairing squares the
 * lower lobe), the cranked wing planform, the tail, the four engine pods, the gear and the
 * flight-deck windows. Body frame: +X right, +Y up, −Z nose, origin = CG, metres.
 *
 * Real dimensions: 70.66 m long, 64.44 m span over the canted winglets, 19.41 m tall, fuselage
 * 6.5 m wide, wing 37.5° quarter-chord sweep / 7° dihedral, root chord 14.5 m at the side of the
 * body, trailing-edge kink at 12.8 m, tip chord 4.1 m, stabiliser 22.17 m span, wheelbase 25.6 m,
 * wing-gear track 11.0 m, 49-inch tyres, 747 truck wheelbase 1.47 m, wheel pair 1.12 m apart.
 */
import { B747_AIRCRAFT } from '../../config';

export const GEO = B747_AIRCRAFT.geometry;
export function SP(name: string) {
  const p = GEO.structuralPoints.find((s) => s.name === name);
  if (!p) throw new Error(`b747 shape: missing structural point ${name}`);
  return p;
}
const DEG = Math.PI / 180;

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export function smooth(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Monotone cubic (Fritsch–Carlson) interpolation: no overshoot between keys. */
export function pchip(xs: readonly number[], ys: readonly number[], x: number): number {
  const n = xs.length;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let i = 0;
  while (i < n - 2 && x > xs[i + 1]) i++;
  const h = xs[i + 1] - xs[i];
  const d = (k: number) => (ys[k + 1] - ys[k]) / (xs[k + 1] - xs[k]);
  const slope = (k: number) => {
    if (k === 0) return d(0);
    if (k === n - 1) return d(n - 2);
    const a = d(k - 1);
    const b = d(k);
    if (a * b <= 0) return 0;
    const w1 = 2 * (xs[k + 1] - xs[k]) + (xs[k] - xs[k - 1]);
    const w2 = xs[k + 1] - xs[k] + 2 * (xs[k] - xs[k - 1]);
    return (w1 + w2) / (w1 / a + w2 / b);
  };
  const t = (x - xs[i]) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * slope(i) + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * slope(i + 1);
}
const table = (keys: readonly (readonly [number, number])[]) => {
  const xs = keys.map((k) => k[0]);
  const ys = keys.map((k) => k[1]);
  return (x: number) => pchip(xs, ys, x);
};

// ─── Fuselage ────────────────────────────────────────────────────────────────

export const NOSE_Z = GEO.spinnerTip.z;
/** Aftmost point of the model: the fin tip's trailing edge (overall length 70.66 m). */
export const TAIL_Z = NOSE_Z + GEO.length;
/** End of the fuselage: the tail cone (APU exhaust), 68.63 m from the nose. */
export const FUSE_END_Z = SP('tailcone').z + 0.03;
/** Where the break-up sections split: nose section | centre (wing box) | aft body. */
export const SPLIT_FWD_Z = -12;
export const SPLIT_AFT_Z = 14;

/** Main-lobe crown (top centreline without the hump). */
const crownT = table([
  [-32, 0], [-31.9, 0.5], [-31.6, 1.1], [-31, 1.8], [-30, 2.55], [-29, 2.95], [-28, 3.2], [-26, 3.38], [-24, 3.44], [-21, 3.45],
  [19, 3.44], [22, 3.4], [24, 3.32], [26.5, 3.17], [29, 2.97], [31.5, 2.72], [33.5, 2.45], [35, 2.2], [36, 1.95], [36.5, 1.79], [FUSE_END_Z, 1.75],
]);
/** Keel (bottom centreline of the main lobe; the wing-body fairing adds below). */
const keelB = table([
  [-32, 0], [-31.9, -0.5], [-31.6, -1.05], [-31, -1.6], [-30, -2.12], [-29, -2.4], [-28, SP('chin').y], [-26, -2.87], [-24, -3.03],
  [-21, -3.14], [-18, -3.185], [-15, SP('bellyForward').y], [9, -3.2], [13, -3.1], [16, SP('bellyAft').y], [19, -2.42], [22, -1.78],
  [24.5, -1.17], [26.5, SP('tailBumper').y], [29, -0.02], [31.5, 0.5], [33.5, 0.88], [35, 1.12], [36, 1.25], [SP('tailcone').z, SP('tailcone').y], [FUSE_END_Z, 1.31],
]);
/** Half width of the main lobe. */
const halfW = table([
  [-32, 0], [-31.9, 0.55], [-31.6, 1.15], [-31, 1.75], [-30, 2.3], [-29, 2.63], [-28, 2.86], [-26, 3.06], [-24, 3.17], [-21, 3.23],
  [-18, 3.25], [16, 3.25], [19, 3.2], [22, 3.1], [24, 2.98], [26.5, 2.72], [29, 2.3], [31.5, 1.75], [33.5, 1.2], [35, 0.75], [36, 0.42], [36.5, 0.27], [FUSE_END_Z, 0.24],
]);
/** Upper-deck hump top (the forehead over the windscreens, the -400's stretched upper deck). */
const humpH = table([
  [-31, 1.7], [-30.6, 2.5], [-30.2, 3.1], [-29.9, 3.5], [-29.5, 4.0], [-29, 4.5], [-28.4, 4.85], [-27.6, 5.07], [-26.8, 5.17],
  [SP('upperDeckRoof').z, SP('upperDeckRoof').y], [-12, 5.2], [-10, 5.14], [-8, 4.94], [-6, 4.52], [-4, 3.98], [-2.5, 3.62], [-1, 3.35], [2, 3.0],
]);
/** Hump half width. */
const humpW = table([
  [-31, 1.1], [-30.2, 1.5], [-29.5, 1.8], [-28.5, 2.08], [-27, 2.3], [-25, 2.4], [-10, 2.4], [-6, 2.33], [-2.5, 2.2], [2, 2.0],
]);
/** Wing-body fairing weight (0..1): squares and widens the lower lobe, drops the keel to −3.3. */
function fairing(z: number): number {
  return smooth(-14, -9, z) * (1 - smooth(8, 13.5, z));
}
const HUMP_CY = 2.4;

export interface Section {
  /** Centre the rays start from. */
  cy: number;
  top: number;
  bot: number;
  w: number;
  /** Lower-lobe half width and superellipse exponent (the fairing squares it). */
  wBot: number;
  pBot: number;
  /** Wing-body fairing bulge: extra half width at the lower corners (below the wing root). */
  bulge: number;
  hump: number;
  humpW: number;
  /** Hump ellipse centre height (kept inside the main lobe so the two always overlap). */
  humpCy: number;
}

export function section(z: number): Section {
  const zz = clamp(z, NOSE_Z, FUSE_END_Z);
  const f = fairing(zz);
  const top = crownT(zz);
  const bot = keelB(zz) - 0.1 * f * smooth(-12, -3, zz) * (1 - smooth(4, 12, zz));
  const w = halfW(zz);
  const cy = (top + keelB(zz)) / 2;
  return { cy, top, bot, w, wBot: w, pBot: 2 + 3 * f, bulge: 0.9 * f, hump: zz >= -31 && zz < 2 ? humpH(zz) : 0, humpW: humpW(zz), humpCy: Math.min(HUMP_CY, top - 0.7) };
}

/** Polynomial smooth max (a fillet of width k where a ≈ b; exact where |a − b| > k). */
function smax(a: number, b: number, k: number): number {
  const h = clamp(0.5 + (0.5 * (a - b)) / k, 0, 1);
  return b + (a - b) * h + k * h * (1 - h);
}

/**
 * Outline point of the section at angle θ from the top (0 = top centre, π = keel), right side
 * (x ≥ 0). The main lobe is an ellipse on top and a superellipse below; the hump is an ellipse
 * centred at y = HUMP_CY; the two blend with a smooth max.
 */
export function sectionPoint(s: Section, theta: number, out: [number, number] = [0, 0]): [number, number] {
  const dx = Math.sin(theta);
  const dy = Math.cos(theta);
  const aTop = Math.max(1e-4, s.top - s.cy);
  const aBot = Math.max(1e-4, s.cy - s.bot);
  let tMain: number;
  if (dy >= 0) tMain = 1 / Math.sqrt((dx * dx) / Math.max(1e-8, s.w * s.w) + (dy * dy) / (aTop * aTop));
  else {
    const p = s.pBot;
    tMain = 1 / Math.pow(Math.pow(Math.abs(dx) / Math.max(1e-4, s.wBot), p) + Math.pow(Math.abs(dy) / aBot, p), 1 / p);
  }
  let r = tMain;
  if (s.hump > 0 && s.hump > s.top - 0.3 && s.humpW > 0.01) {
    // Ray from (0, cy) against the ellipse centred at (0, humpCy) with semi-axes humpW, hump − humpCy.
    const hy = Math.max(0.05, s.hump - s.humpCy);
    const oy = s.cy - s.humpCy;
    const A = (dx * dx) / (s.humpW * s.humpW) + (dy * dy) / (hy * hy);
    const B = (2 * oy * dy) / (hy * hy);
    const C = (oy * oy) / (hy * hy) - 1;
    const disc = B * B - 4 * A * C;
    if (disc > 0) {
      const tH = (-B + Math.sqrt(disc)) / (2 * A);
      if (tH > 0) r = smax(tMain, tH, 0.32);
    }
  }
  let x = r * dx;
  const y = s.cy + r * dy;
  if (s.bulge > 0 && dy < 0) x += s.bulge * smooth(-1.0, -2.6, y) * (x / Math.max(1e-4, s.w));
  out[0] = x;
  out[1] = y;
  return out;
}

/** Fine half outline (top centre → keel) with cumulative arc length: [x, y, s] rows. */
export function halfOutline(z: number, samples = 160): Float64Array {
  const s = section(z);
  const out = new Float64Array((samples + 1) * 3);
  const p: [number, number] = [0, 0];
  let acc = 0;
  let px = 0;
  let py = 0;
  for (let i = 0; i <= samples; i++) {
    // Denser near the top (the hump / forehead) where the outline turns fastest.
    const u = i / samples;
    sectionPoint(s, Math.PI * u, p);
    if (i > 0) acc += Math.hypot(p[0] - px, p[1] - py);
    out[i * 3] = p[0];
    out[i * 3 + 1] = p[1];
    out[i * 3 + 2] = acc;
    px = p[0];
    py = p[1];
  }
  return out;
}

/** Point at arc length s (from the top centre) on a half outline; returns [x, y]. */
export function outlineAt(h: Float64Array, s: number, out: [number, number] = [0, 0]): [number, number] {
  const n = h.length / 3;
  const total = h[(n - 1) * 3 + 2];
  const ss = clamp(s, 0, total);
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (h[mid * 3 + 2] < ss) lo = mid;
    else hi = mid;
  }
  const s0 = h[lo * 3 + 2];
  const s1 = h[hi * 3 + 2];
  const t = s1 > s0 ? (ss - s0) / (s1 - s0) : 0;
  out[0] = lerp(h[lo * 3], h[hi * 3], t);
  out[1] = lerp(h[lo * 3 + 1], h[hi * 3 + 1], t);
  return out;
}

/** Arc length on a half outline where it passes height y (searching from the top down). */
export function sAtY(h: Float64Array, y: number): number {
  const n = h.length / 3;
  if (y >= h[1]) return 0;
  for (let i = 0; i < n - 1; i++) {
    const y0 = h[i * 3 + 1];
    const y1 = h[(i + 1) * 3 + 1];
    if ((y0 - y) * (y1 - y) <= 0 && y0 !== y1) return lerp(h[i * 3 + 2], h[(i + 1) * 3 + 2], (y - y0) / (y1 - y0));
  }
  return h[(n - 1) * 3 + 2];
}

/** Outline half width at height y (0 if the section doesn't reach y). */
export function xAtY(h: Float64Array, y: number): number {
  const n = h.length / 3;
  for (let i = 0; i < n - 1; i++) {
    const y0 = h[i * 3 + 1];
    const y1 = h[(i + 1) * 3 + 1];
    if ((y0 - y) * (y1 - y) <= 0 && y0 !== y1) return lerp(h[i * 3], h[(i + 1) * 3], (y - y0) / (y1 - y0));
  }
  return 0;
}

/** Lower-surface height of the fuselage at station z and half width x (the keel if x is beyond the outline). */
export function lowerYAt(z: number, x: number): number {
  const h = halfOutline(z, 160);
  const n = h.length / 3;
  let best = h[(n - 1) * 3 + 1];
  for (let i = n - 1; i > 0; i--) {
    const x0 = h[i * 3];
    const x1 = h[(i - 1) * 3];
    if ((x0 - x) * (x1 - x) <= 0 && x0 !== x1) return lerp(h[i * 3 + 1], h[(i - 1) * 3 + 1], (x - x0) / (x1 - x0));
    best = h[(i - 1) * 3 + 1];
  }
  return best;
}

/** Fuselage loft stations: dense at the nose and tail cone, the physics points and splits included. */
export function fuselageStations(): number[] {
  const zs: number[] = [NOSE_Z];
  const push = (z0: number, z1: number, step: number) => {
    for (let z = z0 + step; z < z1 - 1e-6; z += step) zs.push(z);
    zs.push(z1);
  };
  push(NOSE_Z, -31.6, 0.05);
  push(-31.6, -30.4, 0.15);
  push(-30.4, -26, 0.2);
  push(-26, -8, 0.6);
  push(-8, 18, 0.65);
  push(18, 35, 0.5);
  push(35, FUSE_END_Z - 0.03, 0.25);
  zs.push(FUSE_END_Z);
  for (const n of ['chin', 'bellyForward', 'bellyMid', 'bellyAft', 'tailBumper', 'tailcone', 'upperDeckRoof']) zs.push(SP(n).z);
  zs.push(SPLIT_FWD_Z, SPLIT_AFT_Z, GEO.pilotEye.z);
  return [...new Set(zs.map((z) => Math.round(z * 1e4) / 1e4))].sort((a, b) => a - b);
}

// ─── Wing ────────────────────────────────────────────────────────────────────

const LE_SLOPE = 0.84; // 40° leading-edge sweep
const TIP_X = 31.6;
const KINK_X = 12.8;
const SOB_X = 3.25;
/** Tip leading edge: the physics wingtip station sits at the tip's mid chord (Boeing: 46.5 m from the nose). */
const TIP_LE_Z = SP('rightWingtip').z - GEO.wingTipChord / 2;
const le = (x: number) => TIP_LE_Z - LE_SLOPE * (TIP_X - x);
const TE_SOB = le(SOB_X) + GEO.wingRootChord;
const TE_KINK = le(KINK_X) + 9.6;
const TE_TIP = le(TIP_X) + GEO.wingTipChord;
const te = (x: number) =>
  x <= KINK_X ? TE_SOB + ((x - SOB_X) * (TE_KINK - TE_SOB)) / (KINK_X - SOB_X) : TE_KINK + ((x - KINK_X) * (TE_TIP - TE_KINK)) / (TIP_X - KINK_X);
const TAN_DIH = Math.tan(GEO.dihedralDeg * DEG);

export const WING = {
  /** First section (buried in the fuselage), side of body, TE kink, tip (winglet root). */
  rootX: 2.6,
  sobX: SOB_X,
  kinkX: KINK_X,
  tipX: TIP_X,
  /** Span extreme at the winglet top (the physics wingtip station). */
  spanX: Math.abs(SP('rightWingtip').x),
  le,
  te,
  chord: (x: number) => te(x) - le(x),
  /** Thickness/chord: 13.4 % at the root, 10.5 % at the kink, 8 % at the tip. */
  thickness: (x: number) => (x <= SOB_X ? 0.134 : x <= KINK_X ? lerp(0.134, 0.105, (x - SOB_X) / (KINK_X - SOB_X)) : lerp(0.105, 0.08, (x - KINK_X) / (TIP_X - KINK_X))),
  camber: (x: number) => lerp(0.022, 0.014, clamp(x / TIP_X, 0, 1)),
  /** Incidence (nose up +): 2° at the root washing out to −1° at the tip. */
  twist: (x: number) => (x <= KINK_X ? lerp(2, 0.5, clamp((x - SOB_X) / (KINK_X - SOB_X), 0, 1)) : lerp(0.5, -1, (x - KINK_X) / (TIP_X - KINK_X))) * DEG,
  dihedral: GEO.dihedralDeg * DEG,
  /** Chord-plane height at the leading edge (set so the tip's lowest point is the physics tip y). */
  yLE: (x: number) => WING_TIP_LE_Y - (TIP_X - x) * TAN_DIH,
  /** Winglet: 1.8 m, canted 22° outboard, 60° leading-edge sweep, tip chord 1.1 m. */
  winglet: { height: 1.8, cantDeg: 22, sweepDeg: 58, tipChord: 1.05 },
  // Control surfaces (span x ranges; chord fractions where they start).
  flapInboard: [3.45, 11.2] as const,
  aileronInboard: [11.25, 13.7] as const,
  flapOutboard: [13.75, 22.6] as const,
  aileronOutboard: [22.65, 29.6] as const,
  flapF: 0.7,
  flapSplitF: 0.9,
  aileronF: 0.76,
  spoilerInboard: [4.0, 11.0] as const,
  spoilerOutboard: [14.2, 22.2] as const,
  spoilerF: [0.54, 0.69] as const,
  kruegerInboard: [3.6, 11.0] as const,
  kruegerOutboard: [12.8, 30.9] as const,
  kruegerF: 0.13,
} as const;

/** 2D NACA-like point on the wing section at chord fraction f, upper or lower (in chord units). */
export function wingSurfaceH(x: number, f: number, upper: boolean): number {
  const t = WING.thickness(x);
  const m = WING.camber(x);
  const p = 0.4;
  const ff = clamp(f, 0, 1);
  const th = 5 * t * (0.2969 * Math.sqrt(ff) - 0.126 * ff - 0.3516 * ff * ff + 0.2843 * ff ** 3 - 0.1036 * ff ** 4);
  const cam = ff < p ? (m / (p * p)) * (2 * p * ff - ff * ff) : (m / ((1 - p) * (1 - p))) * (1 - 2 * p + 2 * p * ff - ff * ff);
  return upper ? cam + th : cam - th;
}

/** Body point on the right wing at span x, chord fraction f and section height h (chord units). */
export function wingPoint(x: number, f: number, h: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const c = WING.chord(x);
  const tw = WING.twist(x);
  const sd = Math.sin(WING.dihedral);
  const cd = Math.cos(WING.dihedral);
  out[0] = x - sd * h * c;
  out[1] = WING.yLE(x) + cd * h * c - Math.sin(tw) * f * c;
  out[2] = WING.le(x) + f * c * Math.cos(tw);
  return out;
}

/** Tip chord-plane height chosen so the lowest point of the tip section is the physics wingtip y. */
const WING_TIP_LE_Y = (() => {
  let minH = 0;
  const x = TIP_X;
  const c = GEO.wingTipChord;
  for (let i = 0; i <= 200; i++) {
    const f = i / 200;
    const tw = (-1 * Math.PI) / 180;
    const y = Math.cos(GEO.dihedralDeg * DEG) * wingSurfaceHRaw(x, f) * c - Math.sin(tw) * f * c;
    minH = Math.min(minH, y);
  }
  return SP('rightWingtip').y - minH;
})();
function wingSurfaceHRaw(x: number, f: number): number {
  // Same as wingSurfaceH(lower) but usable before WING exists (tip values).
  void x;
  const t = 0.08;
  const m = 0.014;
  const p = 0.4;
  const th = 5 * t * (0.2969 * Math.sqrt(f) - 0.126 * f - 0.3516 * f * f + 0.2843 * f ** 3 - 0.1036 * f ** 4);
  const cam = f < p ? (m / (p * p)) * (2 * p * f - f * f) : (m / ((1 - p) * (1 - p))) * (1 - 2 * p + 2 * p * f - f * f);
  return cam - th;
}

// ─── Tail ────────────────────────────────────────────────────────────────────

const FIN_TOP = GEO.verticalTailTop;
const STAB_TIP = SP('rightStab');
export const FIN = {
  rootY: 2.2,
  topY: FIN_TOP.y,
  /** Leading edge: root (y 3.3) z 24.2 → top z 34.9; trailing edge: root z 35.9 → the tip at the tail end (70.66 m). */
  le: (y: number) => lerp(24.2, 34.9, (y - 3.3) / (FIN_TOP.y - 3.3)),
  te: (y: number) => lerp(35.9, TAIL_Z, (y - 3.3) / (FIN_TOP.y - 3.3)),
  thickness: 0.1,
  rudderF: 0.7,
  rudderSplitY: 8.7,
  rudderBottomY: 3.9,
  rudderTopY: FIN_TOP.y - 0.25,
} as const;

export const STAB = {
  tipX: Math.abs(STAB_TIP.x),
  /** Leading edge: centreline z 25.9 → tip z 35.3 (40° sweep); trailing edge centreline 35.9 → tip 37.85 (69.85 m). */
  le: (x: number) => lerp(25.9, 35.3, x / Math.abs(STAB_TIP.x)),
  te: (x: number) => lerp(35.9, 37.85, x / Math.abs(STAB_TIP.x)),
  /** 7° dihedral through the physics tip point. */
  y: (x: number) => STAB_TIP.y - (Math.abs(STAB_TIP.x) - x) * Math.tan(7 * DEG),
  thickness: 0.09,
  elevatorF: 0.7,
  elevatorSplitX: 5.6,
  elevatorInX: 1.3,
  elevatorOutX: Math.abs(STAB_TIP.x) - 0.3,
} as const;

// ─── Engines ─────────────────────────────────────────────────────────────────

export interface EnginePod {
  /** 1 = left outboard … 4 = right outboard. */
  n: 1 | 2 | 3 | 4;
  x: number;
  /** Nacelle axis height. */
  y: number;
  /** Intake lip station. */
  lipZ: number;
}
/** Nacelle outer radius at the max-diameter barrel. */
export const NACELLE_R = 1.36;
/** Physics pod bottoms sit on the barrel, 1.4 m behind the lip. */
const LIP_TO_POINT = 1.4;
function pod(n: 1 | 2 | 3 | 4, name: string): EnginePod {
  const p = SP(name);
  return { n, x: p.x, y: p.y + NACELLE_R, lipZ: p.z - LIP_TO_POINT };
}
export const ENGINES: EnginePod[] = [
  pod(1, 'leftOutboardEngine'),
  pod(2, 'leftInboardEngine'),
  pod(3, 'rightInboardEngine'),
  pod(4, 'rightOutboardEngine'),
];
/**
 * RB211-524H-style long fan cowl: [dz from the lip, radius]. The barrel holds the max radius from
 * 1.1 to 2.4 m (the physics point is at 1.4 m); the fan nozzle exits at 4.95 m, the core nozzle at
 * 5.9 m and the plug ends at 7.0 m.
 */
export const NACELLE_PROFILE: [number, number][] = [
  [0.02, 1.2], [0.08, 1.25], [0.2, 1.3], [0.45, 1.34], [0.8, 1.356], [1.1, NACELLE_R], [1.4, NACELLE_R], [2.4, NACELLE_R], [3.0, 1.35], [3.6, 1.315], [4.3, 1.24], [4.95, 1.1],
];
export const FAN = { dz: 0.62, radius: 1.12, spinnerLen: 0.62, spinnerR: 0.42 } as const;
export const CORE_PROFILE: [number, number][] = [[4.55, 0.86], [4.95, 0.84], [5.5, 0.74], [5.9, 0.62]];
export const PLUG_PROFILE: [number, number][] = [[5.8, 0.5], [6.2, 0.44], [6.6, 0.3], [6.9, 0.12], [7.0, 0.02]];

// ─── Landing gear ────────────────────────────────────────────────────────────

const R = GEO.mainWheelRadius;
export const GEAR = {
  wheelRadius: R,
  tyreWidth: 0.44,
  /** Half the spacing between the two wheels on an axle (1.12 m pair). */
  pairHalf: 0.56,
  /** Half the truck wheelbase (1.47 m). */
  truckHalf: 0.735,
  nose: {
    axle: { x: GEO.noseWheel.x, y: GEO.noseWheel.y + GEO.noseWheelRadius, z: GEO.noseWheel.z },
    pivot: { x: 0, y: -1.6, z: -23.3 },
    pairHalf: 0.46,
    /** Retraction swing (rad about +x: the leg's foot goes forward and up). */
    swing: 98 * DEG,
  },
  wing: {
    x: Math.abs(GEO.leftMainWheel.x),
    z: GEO.leftMainWheel.z,
    axleY: GEO.leftMainWheel.y + R,
    pivot: { x: 5.2, y: -2.05 },
    /** Inward retraction about the body z axis. */
    swing: 90 * DEG,
  },
  /** Boeing: the body gear is 3.07 m behind the wing gear, track 3.84 m. */
  bodyZ: GEO.leftMainWheel.z + 3.07,
  body: {
    x: 1.92,
    axleY: GEO.leftMainWheel.y + R,
    pivot: { y: -1.25, z: GEO.leftMainWheel.z + 3.5 },
    swing: 84 * DEG,
  },
} as const;

// ─── Flight-deck windows (right side; mirrored) ──────────────────────────────

/**
 * Windows as (a, b) patches: the front windscreen (#1) runs across the forehead from the centre
 * post (x 0.07) to the corner post in x, between two heights in y; the side windows (#2, #3) are
 * (z, y) quads on the side of the hump. Heights are body y.
 */
export const COCKPIT_WINDOWS = {
  front: { x0: 0.075, x1: 0.93, y0: 3.47, y1: 4.33, x1Top: 0.74 },
  side: [
    { z0: -29.37, z1: -28.86, y0: 3.45, y1: 4.25, z0Top: -29.06, z1Top: -28.86 },
    { z0: -28.66, z1: -28.1, y0: 3.5, y1: 4.1, z0Top: -28.62, z1Top: -28.18 },
  ],
} as const;

/** Main-deck doors L1–L5 (centre z) and the upper-deck door; passenger-window rows. */
export const DOORS = { main: [-23.9, -14.1, -3.6, 13.3, 24.1], upper: -12.9, width: 1.07, height: 1.93, sillY: -0.15 } as const;
export const WINDOWS = { mainY: 1.0, upperY: 3.95, pitch: 0.508, w: 0.24, h: 0.34 } as const;
