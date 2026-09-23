/**
 * PURE shape of the F-16C Block 50 (no three.js): the anchor points shared with the physics
 * (`F16_AIRCRAFT.geometry`), the fuselage cross-sections (key-framed, monotone-cubic interpolated
 * along the body, Catmull-Rom around each section), the canopy bubble, and the wing / stabilator /
 * fin planforms. Body frame: +X right, +Y up, −Z nose, origin = CG, metres.
 *
 * Real proportions (15.06 m over the pitot, 9.96 m over the wingtip missiles, 4.88 m tall): the
 * radome is a tangent ogive; the strakes (LEX) start beside the windscreen and sweep out to meet
 * the 40° wing leading edge; the ventral intake sits under the cockpit with its upper lip forward;
 * the aft fuselage carries side booms with the stabilator pivots and the split speed brakes.
 */
import { F16_AIRCRAFT } from '../../config';

export const GEO = F16_AIRCRAFT.geometry;
const SP = (name: string) => {
  const p = GEO.structuralPoints.find((s) => s.name === name);
  if (!p) throw new Error(`f16 shape: missing structural point ${name}`);
  return p;
};

/** Anchor points the physics uses (tests hold the model to them within 3 cm). */
export const ANCHOR = {
  pitotTip: GEO.spinnerTip,
  noseTip: SP('noseTip'),
  wingtipRight: SP('rightWingtip'),
  wingtipLeft: SP('leftWingtip'),
  stabTipRight: SP('rightStab'),
  stabTipLeft: SP('leftStab'),
  finTop: GEO.verticalTailTop,
  eye: GEO.pilotEye,
  noseWheel: GEO.noseWheel,
  leftMainWheel: GEO.leftMainWheel,
  rightMainWheel: GEO.rightMainWheel,
  noseWheelRadius: GEO.noseWheelRadius,
  mainWheelRadius: GEO.mainWheelRadius,
  /** Aft-most point: the length is measured from the pitot tip. */
  tailZ: GEO.spinnerTip.z + GEO.length,
} as const;

const DEG = Math.PI / 180;

// ─── Fuselage ────────────────────────────────────────────────────────────────

/** Radome: tangent ogive from the tip to the joint with the forward fuselage. */
export const RADOME = { tipZ: ANCHOR.noseTip.z, tipY: ANCHOR.noseTip.y, jointZ: -6.75 } as const;
/** Fuselage loft runs from the radome joint to the nozzle base. */
export const FUSE_END_Z = 4.95;

/** Half-section control points, top centre → bottom centre (x ≥ 0). */
export type HalfSection = [number, number][];

/** Superellipse half-section: centre y, half width, top and bottom half-heights, exponent. */
function ell(cy: number, a: number, bt: number, bb: number, n = 2): HalfSection {
  const ang = [0, 35, 60, 78, 90, 102, 120, 145, 180];
  return ang.map((d) => {
    const t = d * DEG;
    const s = Math.sin(t);
    const c = Math.cos(t);
    const x = a * Math.sign(s) * Math.abs(s) ** (2 / n);
    const y = cy + (c >= 0 ? bt : bb) * Math.sign(c) * Math.abs(c) ** (2 / n);
    return [Math.abs(x) < 1e-9 ? 0 : x, y] as [number, number];
  });
}

/**
 * Key cross-sections. Points: P0 top centre, P1 upper shoulder, P2 upper side (canopy sill /
 * strake root), P3 strake upper surface, P4 the widest point (strake / wing-root / boom edge),
 * P5 strake lower surface, P6 lower side, P7 lower shoulder, P8 bottom centre. Under the canopy
 * the "top" is the cockpit deck; from the intake lip aft the belly is inside the intake cowl.
 */
export const FUSE_KEYS: { z: number; p: HalfSection }[] = [
  { z: RADOME.jointZ, p: ell(-0.06, 0.455, 0.43, 0.44) },
  { z: -6.3, p: ell(-0.05, 0.5, 0.49, 0.44, 2.2) },
  { z: -6.0, p: [[0, 0.475], [0.28, 0.44], [0.44, 0.31], [0.52, 0.1], [0.545, -0.03], [0.535, -0.14], [0.49, -0.29], [0.31, -0.42], [0, -0.46]] },
  { z: -5.6, p: [[0, 0.48], [0.29, 0.47], [0.45, 0.4], [0.54, 0.08], [0.585, -0.04], [0.565, -0.13], [0.51, -0.28], [0.32, -0.39], [0, -0.42]] },
  { z: -5.2, p: [[0, 0.47], [0.3, 0.465], [0.46, 0.42], [0.555, 0.03], [0.63, -0.05], [0.575, -0.12], [0.52, -0.25], [0.33, -0.33], [0, -0.35]] },
  // Cockpit tub (under the canopy): the "top" dips to the floor between the sills.
  { z: -5.02, p: [[0, 0.24], [0.28, 0.37], [0.465, 0.43], [0.565, 0.0], [0.65, -0.055], [0.58, -0.115], [0.52, -0.24], [0.335, -0.32], [0, -0.34]] },
  { z: -4.6, p: [[0, 0.22], [0.28, 0.37], [0.47, 0.43], [0.58, -0.02], [0.69, -0.065], [0.595, -0.115], [0.515, -0.23], [0.34, -0.3], [0, -0.31]] },
  { z: -3.8, p: [[0, 0.22], [0.28, 0.37], [0.47, 0.43], [0.6, -0.03], [0.79, -0.09], [0.61, -0.14], [0.52, -0.235], [0.36, -0.29], [0, -0.3]] },
  { z: -3.1, p: [[0, 0.23], [0.27, 0.37], [0.44, 0.43], [0.62, -0.04], [0.9, -0.115], [0.63, -0.165], [0.53, -0.245], [0.37, -0.29], [0, -0.3]] },
  { z: -2.8, p: [[0, 0.25], [0.25, 0.37], [0.4, 0.43], [0.63, -0.05], [0.96, -0.125], [0.64, -0.175], [0.535, -0.25], [0.37, -0.29], [0, -0.3]] },
  // Aft canopy fairing, then the dorsal spine sloping down to the fin.
  { z: -2.66, p: [[0, 1.0], [0.19, 0.955], [0.33, 0.76], [0.64, -0.05], [0.98, -0.13], [0.645, -0.18], [0.54, -0.25], [0.37, -0.29], [0, -0.3]] },
  { z: -2.2, p: [[0, 0.83], [0.23, 0.795], [0.43, 0.58], [0.67, -0.05], [1.08, -0.165], [0.71, -0.225], [0.555, -0.265], [0.38, -0.29], [0, -0.3]] },
  { z: -1.5, p: [[0, 0.745], [0.27, 0.715], [0.51, 0.5], [0.73, -0.02], [1.22, -0.205], [0.94, -0.35], [0.74, -0.45], [0.45, -0.4], [0, -0.34]] },
  { z: -0.68, p: [[0, 0.71], [0.29, 0.68], [0.56, 0.46], [0.8, 0.02], [1.42, -0.27], [1.2, -0.47], [0.95, -0.555], [0.55, -0.565], [0, -0.45]] },
  { z: 0.3, p: [[0, 0.695], [0.3, 0.665], [0.58, 0.44], [0.84, 0.01], [1.34, -0.28], [1.18, -0.48], [0.95, -0.56], [0.55, -0.6], [0, -0.52]] },
  { z: 1.2, p: [[0, 0.685], [0.31, 0.655], [0.6, 0.43], [0.84, 0.0], [1.32, -0.29], [1.14, -0.47], [0.92, -0.575], [0.52, -0.72], [0, -0.8]] },
  { z: 2.0, p: [[0, 0.675], [0.31, 0.645], [0.6, 0.41], [0.84, 0.0], [1.32, -0.29], [1.06, -0.44], [0.8, -0.58], [0.5, -0.74], [0, -0.8]] },
  { z: 2.9, p: [[0, 0.645], [0.33, 0.6], [0.6, 0.34], [0.84, -0.03], [1.26, -0.3], [0.94, -0.44], [0.7, -0.56], [0.48, -0.72], [0, -0.78]] },
  { z: 3.5, p: [[0, 0.6], [0.34, 0.525], [0.58, 0.2], [0.78, -0.18], [1.06, -0.33], [0.86, -0.5], [0.62, -0.56], [0.44, -0.66], [0, -0.72]] },
  { z: 4.3, p: [[0, 0.54], [0.33, 0.45], [0.54, 0.12], [0.74, -0.22], [1.04, -0.34], [0.84, -0.49], [0.56, -0.5], [0.38, -0.6], [0, -0.64]] },
  { z: FUSE_END_Z, p: [[0, 0.48], [0.3, 0.39], [0.5, 0.1], [0.72, -0.24], [1.02, -0.34], [0.82, -0.48], [0.5, -0.4], [0.37, -0.47], [0, -0.58]] },
];

/** Samples between consecutive control points (P0-P1, P1-P2, …, P7-P8). */
export const SECTION_SEGMENTS = [5, 6, 9, 7, 4, 4, 7, 6] as const;
/** Index of the upper side point (P2: sill / shoulder) in the sampled half ring. */
export const SHOULDER_INDEX = SECTION_SEGMENTS[0] + SECTION_SEGMENTS[1];
/** Points per half ring (top centre and bottom centre included). */
export const HALF_POINTS = SECTION_SEGMENTS.reduce((a, b) => a + b, 0) + 1;
/** Index of the widest point (P4) in the sampled half ring. */
export const EDGE_INDEX = SECTION_SEGMENTS.slice(0, 4).reduce((a, b) => a + b, 0);

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
    const w2 = (xs[k + 1] - xs[k]) + 2 * (xs[k] - xs[k - 1]);
    return (w1 + w2) / (w1 / a + w2 / b);
  };
  const t = (x - xs[i]) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * slope(i) + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * slope(i + 1);
}

const KEY_Z = FUSE_KEYS.map((k) => k.z);
const KEY_COORD: number[][] = [];
for (let j = 0; j < 9; j++) {
  KEY_COORD.push(FUSE_KEYS.map((k) => k.p[j][0]));
  KEY_COORD.push(FUSE_KEYS.map((k) => k.p[j][1]));
}

/** Control points of the section at station z. */
export function fuselageControl(z: number): HalfSection {
  const out: HalfSection = [];
  for (let j = 0; j < 9; j++) out.push([pchip(KEY_Z, KEY_COORD[2 * j], z), pchip(KEY_Z, KEY_COORD[2 * j + 1], z)]);
  out[0][0] = 0;
  out[8][0] = 0;
  return out;
}

/** Centripetal Catmull-Rom point between p1 and p2 (t in 0..1). */
function catmull(p0: number[], p1: number[], p2: number[], p3: number[], t: number, out: number[]) {
  const a = 0.5;
  const dt0 = Math.max(1e-4, Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) ** a);
  const dt1 = Math.max(1e-4, Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) ** a);
  const dt2 = Math.max(1e-4, Math.hypot(p3[0] - p2[0], p3[1] - p2[1]) ** a);
  for (let k = 0; k < 2; k++) {
    let t1 = (p1[k] - p0[k]) / dt0 - (p2[k] - p0[k]) / (dt0 + dt1) + (p2[k] - p1[k]) / dt1;
    let t2 = (p2[k] - p1[k]) / dt1 - (p3[k] - p1[k]) / (dt1 + dt2) + (p3[k] - p2[k]) / dt2;
    t1 *= dt1;
    t2 *= dt1;
    const tt = t * t;
    const ttt = tt * t;
    out[k] = (2 * ttt - 3 * tt + 1) * p1[k] + (ttt - 2 * tt + t) * t1 + (-2 * ttt + 3 * tt) * p2[k] + (ttt - tt) * t2;
  }
}

/** Sampled half ring (x ≥ 0) from top centre to bottom centre: HALF_POINTS [x, y] pairs. */
export function sampleHalf(ctrl: HalfSection, segments: readonly number[] = SECTION_SEGMENTS): [number, number][] {
  const pts: number[][] = [[-ctrl[1][0], ctrl[1][1]], ...ctrl, [-ctrl[7][0], ctrl[7][1]]];
  const out: [number, number][] = [];
  const tmp = [0, 0];
  for (let s = 0; s < 8; s++) {
    const n = segments[s];
    for (let k = 0; k < n; k++) {
      catmull(pts[s], pts[s + 1], pts[s + 2], pts[s + 3], k / n, tmp);
      out.push([Math.max(0, tmp[0]), tmp[1]]);
    }
  }
  out.push([0, ctrl[8][1]]);
  out[0][0] = 0;
  return out;
}

/**
 * Full closed ring at station z (flat xyz), starting at the bottom centre, up the right side,
 * over the top and down the left side (the loft seam is at the bottom centre).
 */
export function fuselageRing(z: number, scale = 1, centre: [number, number] = [0, 0]): number[] {
  const half = sampleHalf(fuselageControl(z));
  const out: number[] = [];
  const H = half.length;
  const P = (x: number, y: number) => out.push(centre[0] + x * scale, centre[1] + (y - centre[1]) * scale, z);
  for (let k = H - 1; k >= 0; k--) P(half[k][0], half[k][1]);
  for (let k = 1; k < H - 1; k++) P(-half[k][0], half[k][1]);
  return out;
}

/** Stations of the fuselage loft: a 9 cm grid plus every key section. */
export function fuselageStations(): number[] {
  const zs = new Set<number>();
  for (let z = RADOME.jointZ; z < FUSE_END_Z; z += 0.07) zs.add(Math.round(z * 1000) / 1000);
  for (const k of FUSE_KEYS) zs.add(k.z);
  zs.add(FUSE_END_Z);
  const sorted = [...zs].sort((a, b) => a - b);
  const out: number[] = [];
  for (const z of sorted) if (!out.length || z - out[out.length - 1] > 0.025 || z === FUSE_END_Z) out.push(z);
  if (out.length > 1 && out[out.length - 1] - out[out.length - 2] < 0.025) out.splice(out.length - 2, 1);
  return out;
}

/** Tangent-ogive radius fraction (0 at the tip … 1 at the joint) at distance x from the tip. */
export function ogive(x: number, length: number): number {
  const R = 1;
  const L = length / 0.5; // shape of a radius-0.5 ogive of this length, normalised
  const rho = (R * R + L * L) / (2 * R);
  const xx = Math.max(0, Math.min(L, (x / length) * L));
  return Math.max(0, Math.sqrt(rho * rho - (L - xx) * (L - xx)) + R - rho);
}

// ─── Canopy ──────────────────────────────────────────────────────────────────

/** Canopy stations: z, half-width at the sill, sill height, top height. */
export const CANOPY_KEYS: { z: number; w: number; sill: number; top: number }[] = [
  { z: -6.12, w: 0.04, sill: 0.49, top: 0.51 },
  { z: -5.95, w: 0.22, sill: 0.48, top: 0.64 },
  { z: -5.7, w: 0.34, sill: 0.47, top: 0.8 },
  { z: -5.35, w: 0.42, sill: 0.465, top: 0.97 },
  { z: -4.95, w: 0.46, sill: 0.46, top: 1.1 },
  { z: -4.5, w: 0.476, sill: 0.46, top: 1.21 },
  { z: -4.05, w: 0.478, sill: 0.46, top: 1.28 },
  { z: -3.65, w: 0.47, sill: 0.46, top: 1.29 },
  { z: -3.25, w: 0.45, sill: 0.46, top: 1.24 },
  { z: -2.92, w: 0.415, sill: 0.46, top: 1.14 },
  { z: -2.65, w: 0.37, sill: 0.46, top: 1.02 },
];
export const CANOPY_FRONT_Z = CANOPY_KEYS[0].z;
export const CANOPY_REAR_Z = CANOPY_KEYS[CANOPY_KEYS.length - 1].z;

export function canopyAt(z: number): { w: number; sill: number; top: number } {
  const zs = CANOPY_KEYS.map((k) => k.z);
  return {
    w: pchip(zs, CANOPY_KEYS.map((k) => k.w), z),
    sill: pchip(zs, CANOPY_KEYS.map((k) => k.sill), z),
    top: pchip(zs, CANOPY_KEYS.map((k) => k.top), z),
  };
}

/** Canopy cross-section: an arch from the right sill over the top to the left sill (n+1 points). */
export function canopyArch(z: number, n: number, inset = 0, drop = 0.035): number[] {
  const c = canopyAt(z);
  const out: number[] = [];
  const w = Math.max(0.001, c.w - inset);
  const h = Math.max(0.001, c.top - c.sill - inset);
  for (let k = 0; k <= n; k++) {
    const t = (k / n) * Math.PI; // 0 = right sill … π = left sill
    const cs = Math.cos(t);
    const sn = Math.sin(t);
    const x = w * Math.sign(cs) * Math.abs(cs) ** (2 / 2.25);
    const y = c.sill + h * Math.abs(sn) ** (2 / 2.1);
    out.push(x, k === 0 || k === n ? y - drop : y, z);
  }
  return out;
}

// ─── Wing ────────────────────────────────────────────────────────────────────

const WING_LE_SWEEP = 40 * DEG;
/** Wing reference plane height and root leading edge (theoretical, on the centreline). */
export const WING = {
  y: GEO.wingRootLeadingEdge.y,
  rootLeZ: GEO.wingRootLeadingEdge.z,
  rootChord: GEO.wingRootChord,
  tipChord: GEO.wingTipChord,
  /** Wing panel tip (the launcher rail and missile are outboard). */
  tipX: 4.52,
  /** First station of the wing panel (inside the strake blend). */
  rootX: 0.95,
  /** Strake / wing leading-edge junction; the LEF and flaperon start here. */
  junctionX: 1.45,
  flaperonOuterX: 3.75,
  flaperonChord: 0.62,
  lefRootChord: 0.62,
  lefTipChord: 0.31,
  thickness: 0.04,
  camber: 0.006,
} as const;

export function wingLeZ(x: number): number {
  return WING.rootLeZ + Math.tan(WING_LE_SWEEP) * Math.abs(x);
}
/** The trailing edge is straight; root at rootLe + rootChord, tip chord from the config. */
export function wingTeZ(x: number): number {
  const rootTe = WING.rootLeZ + WING.rootChord;
  const tipTe = wingLeZ(WING.tipX) + WING.tipChord;
  return rootTe + ((tipTe - rootTe) * Math.abs(x)) / WING.tipX;
}
export function wingChord(x: number): number {
  return wingTeZ(x) - wingLeZ(x);
}
/** LEF chord (tapers from the junction to the tip). */
export function lefChord(x: number): number {
  const t = (Math.abs(x) - WING.junctionX) / (WING.tipX - WING.junctionX);
  return WING.lefRootChord + (WING.lefTipChord - WING.lefRootChord) * Math.max(0, Math.min(1, t));
}

/** Wingtip launcher rail and missile (AIM-9M) centreline: outermost fin reaches the physics wingtip. */
export const AIM9 = {
  length: 2.87,
  radius: 0.0635,
  finSpan: 0.64,
  canardSpan: 0.56,
  /** Fins in an X: their horizontal reach is finSpan/2·cos45°. */
  x: Math.abs(ANCHOR.wingtipRight.x) - (0.64 / 2) * Math.SQRT1_2,
  y: ANCHOR.wingtipRight.y,
  noseZ: 0.25,
} as const;

// ─── Stabilators ─────────────────────────────────────────────────────────────

export const STAB = {
  rootX: 1.08,
  tipX: Math.abs(ANCHOR.stabTipRight.x),
  rootY: GEO.horizontalTail.y,
  tipY: ANCHOR.stabTipRight.y,
  rootLeZ: 3.66,
  rootTeZ: 5.8,
  tipLeZ: 5.1,
  tipTeZ: 5.84,
  /** Pivot shaft (the whole surface turns about it). */
  pivotZ: 4.6,
  thickness: 0.042,
} as const;

// ─── Fin, rudder, ventral fins ───────────────────────────────────────────────

export const FIN = {
  rootY: 0.5,
  tipY: ANCHOR.finTop.y,
  rootLeZ: 2.3,
  rootTeZ: 5.42,
  tipLeZ: 5.06,
  tipTeZ: 5.82,
  thickness: 0.05,
  rudderBottomY: 0.98,
  rudderTopY: 2.82,
  rudderChord: 0.56,
} as const;

/** Fin leading / trailing edge z at height y. */
export function finLeZ(y: number): number {
  return FIN.rootLeZ + ((FIN.tipLeZ - FIN.rootLeZ) * (y - FIN.rootY)) / (FIN.tipY - FIN.rootY);
}
export function finTeZ(y: number): number {
  return FIN.rootTeZ + ((FIN.tipTeZ - FIN.rootTeZ) * (y - FIN.rootY)) / (FIN.tipY - FIN.rootY);
}

export const VENTRAL = {
  x: Math.abs(SP('rightVentral').x),
  rootY: -0.5,
  tipY: -1.0,
  rootLeZ: 2.85,
  rootTeZ: 4.35,
  tipLeZ: 3.55,
  tipTeZ: 4.2,
  cantDeg: 15,
} as const;

// ─── Engine nozzle ───────────────────────────────────────────────────────────

export const NOZZLE = {
  axisY: -0.05,
  baseZ: 4.9,
  exitZ: ANCHOR.tailZ,
  baseRadius: 0.545,
  /** Exit radius at minimum area (military power) and fully open (max AB / engine off). */
  exitRadiusMin: 0.37,
  exitRadiusMax: 0.5,
  petals: 16,
} as const;

// ─── Intake ──────────────────────────────────────────────────────────────────

export const INTAKE = {
  /** Upper lip (splitter) and lower lip stations: the mouth leans back. */
  upperLipZ: -4.55,
  lowerLipZ: -4.05,
  topY: -0.37,
  bottomY: -0.93,
  halfWidth: 0.5,
  lip: 0.045,
  /** Where the cowl has faired into the belly. */
  endZ: 1.65,
} as const;
