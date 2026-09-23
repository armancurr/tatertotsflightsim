/**
 * PURE shape of the Fairchild Republic A-10C Thunderbolt II (no three.js): the anchor points shared
 * with the physics and the weapons (`A10_AIRCRAFT.geometry`, `A10_WEAPONS`), the fuselage
 * cross-sections (key-framed, monotone-cubic along the body, Catmull-Rom around each section), the
 * canopy, the straight wing (constant-chord centre section, tapered outer panels with dihedral and
 * drooped Hoerner tips), the gear pods, the TF34 nacelles, the twin-fin tail, the GAU-8/A and the
 * pylon stations. Body frame: +X right, +Y up, −Z nose, origin = CG, metres.
 *
 * Real dimensions: 16.26 m long (gun muzzle → tail), 17.53 m span, 4.47 m tall, wheelbase 5.40 m,
 * track 5.25 m. Wing 47.0 m²: centre section 3.05 m chord out to ±3.07 m, outer panels tapering to
 * 1.9 m with ~6.5° dihedral. Horizontal tail 5.74 m span with the fins as end plates.
 */
import { A10_AIRCRAFT, A10_WEAPONS } from '../../config';

export const GEO = A10_AIRCRAFT.geometry;
const SP = (name: string) => {
  const p = GEO.structuralPoints.find((s) => s.name === name);
  if (!p) throw new Error(`a10 shape: missing structural point ${name}`);
  return p;
};
const DEG = Math.PI / 180;

/** GAU-8/A muzzle (firing barrel) — the frontmost point; the length is measured from it. */
export const MUZZLE = A10_WEAPONS.gun!.muzzle;

/** Anchor points the physics / weapons use (tests hold the model to them within 3 cm). */
export const ANCHOR = {
  muzzle: MUZZLE,
  noseTip: SP('noseTip'),
  wingtipRight: SP('rightWingtip'),
  wingtipLeft: SP('leftWingtip'),
  finTopRight: SP('rightFinTop'),
  finTopLeft: SP('leftFinTop'),
  finRootRight: SP('rightFinRoot'),
  engineTopRight: SP('rightEngine'),
  engineTopLeft: SP('leftEngine'),
  eye: GEO.pilotEye,
  noseWheel: GEO.noseWheel,
  leftMainWheel: GEO.leftMainWheel,
  rightMainWheel: GEO.rightMainWheel,
  noseWheelRadius: GEO.noseWheelRadius,
  mainWheelRadius: GEO.mainWheelRadius,
  /** Aft-most point (rudder trailing edges). */
  tailZ: MUZZLE.z + GEO.length,
} as const;

// ─── Monotone interpolation ───────────────────────────────────────────────────

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

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export function smooth(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

// ─── Fuselage ────────────────────────────────────────────────────────────────

/**
 * Fuselage key sections. top = top centreline; sill/hwS = the upper shoulder (canopy sill under the
 * canopy); hw/yw = the widest point; bot/hwB = the flat belly; floor = cockpit tub floor at the
 * centreline (NaN = closed top). The A-10's forward fuselage is slab-sided with a flat bottom; aft
 * of the wing it tapers into a round-ish boom carrying the tail.
 */
interface FuseKey {
  z: number;
  top: number;
  sill: number;
  hwS: number;
  hw: number;
  yw: number;
  bot: number;
  hwB: number;
  floor: number;
}
const K = (z: number, top: number, sill: number, hwS: number, hw: number, yw: number, bot: number, hwB: number, floor = Number.NaN): FuseKey => ({ z, top, sill, hwS, hw, yw, bot, hwB, floor });

/** Nose tip → tail cone. The nose cone ahead of NOSE_JOINT_Z is scaled from the joint section. */
export const FUSE_KEYS: FuseKey[] = [
  K(-6.62, 0.12, 0.02, 0.3, 0.4, -0.36, -0.8, 0.2),
  K(-6.3, 0.3, 0.18, 0.38, 0.49, -0.34, -0.86, 0.26),
  K(-5.9, 0.47, 0.35, 0.44, 0.555, -0.3, -0.92, 0.32),
  K(-5.5, 0.6, 0.52, 0.49, 0.6, -0.26, -0.96, 0.36),
  // Cockpit tub (open under the canopy): sills at 0.68.
  K(-5.3, 0.66, 0.66, 0.52, 0.615, -0.22, -0.97, 0.38, 0.5),
  K(-5.1, 0.67, 0.68, 0.53, 0.625, -0.2, -0.98, 0.4, 0.12),
  K(-4.3, 0.67, 0.68, 0.54, 0.64, -0.16, -0.995, 0.42, 0.06),
  K(-3.5, 0.67, 0.68, 0.55, 0.66, -0.14, -1.0, 0.44, 0.12),
  K(-3.1, 0.7, 0.68, 0.56, 0.675, -0.13, -1.01, 0.45, 0.45),
  // Behind the canopy: the turtle deck rising to the canopy's rear and the spine descending aft.
  K(-2.9, 1.06, 0.8, 0.46, 0.69, -0.12, -1.015, 0.46),
  K(-2.4, 1.02, 0.84, 0.5, 0.72, -0.12, -1.025, 0.48),
  K(-1.5, 0.96, 0.8, 0.56, 0.755, -0.14, -1.04, 0.5),
  K(-0.4, 0.93, 0.76, 0.6, 0.78, -0.16, -1.05, 0.52),
  K(1.0, 0.9, 0.74, 0.6, 0.79, -0.18, -1.05, 0.52),
  K(2.3, 0.84, 0.68, 0.58, 0.77, -0.18, -1.02, 0.5),
  K(3.4, 0.72, 0.57, 0.53, 0.7, -0.16, -0.93, 0.44),
  K(4.5, 0.62, 0.49, 0.46, 0.6, -0.12, -0.79, 0.36),
  K(5.5, 0.55, 0.44, 0.39, 0.51, -0.07, -0.63, 0.28),
  K(6.5, 0.5, 0.41, 0.32, 0.41, 0.0, -0.45, 0.2),
  K(7.5, 0.48, 0.4, 0.25, 0.32, 0.08, -0.26, 0.13),
  K(8.3, 0.46, 0.39, 0.17, 0.22, 0.18, -0.06, 0.07),
  K(8.75, 0.42, 0.36, 0.1, 0.13, 0.25, 0.1, 0.04),
];
/** Section where the nose cone meets the loft, and where the loft ends (tail cone). */
export const NOSE_JOINT_Z = FUSE_KEYS[0].z;
export const FUSE_END_Z = FUSE_KEYS[FUSE_KEYS.length - 1].z;
/** Tail cone tip (the tail light sits on it). */
export const TAIL_CONE = { z: 8.97, y: 0.3 } as const;

/** Cockpit opening (tub) limits along z. */
export const TUB = { z0: -5.36, z1: -3.02 } as const;

const KEY_Z = FUSE_KEYS.map((k) => k.z);
const col = (f: (k: FuseKey) => number) => FUSE_KEYS.map(f);
const KEY_COLS = {
  top: col((k) => k.top),
  sill: col((k) => k.sill),
  hwS: col((k) => k.hwS),
  hw: col((k) => k.hw),
  yw: col((k) => k.yw),
  bot: col((k) => k.bot),
  hwB: col((k) => k.hwB),
};

/** Interpolated section parameters at station z (floor: NaN outside the tub). */
export function fuselageParams(z: number) {
  const p = (c: number[]) => pchip(KEY_Z, c, z);
  const inTub = z > TUB.z0 && z < TUB.z1;
  // Tub floor: steep walls at the front (instrument panel bulkhead) and the back (seat bulkhead).
  let floor = Number.NaN;
  if (inTub) {
    const wall = Math.min(smooth(TUB.z0, TUB.z0 + 0.22, z), 1 - smooth(TUB.z1 - 0.3, TUB.z1, z));
    floor = lerp(p(KEY_COLS.sill) - 0.02, 0.08, wall);
  }
  return { top: p(KEY_COLS.top), sill: p(KEY_COLS.sill), hwS: p(KEY_COLS.hwS), hw: p(KEY_COLS.hw), yw: p(KEY_COLS.yw), bot: p(KEY_COLS.bot), hwB: p(KEY_COLS.hwB), floor };
}

/** Half-section control points, top centre → bottom centre (x ≥ 0). */
export type HalfSection = [number, number][];

/** The 9 control points of the section at z (see fuselageParams). */
export function fuselageControl(z: number): HalfSection {
  const s = fuselageParams(z);
  const tub = !Number.isNaN(s.floor);
  const pts: HalfSection = [];
  if (tub) {
    pts.push([0, s.floor]);
    pts.push([s.hwS * 0.86, lerp(s.floor, s.sill, 0.55)]);
  } else {
    pts.push([0, s.top]);
    pts.push([s.hwS * 0.62, s.top - (s.top - s.sill) * 0.22]);
  }
  pts.push([s.hwS, s.sill]);
  pts.push([s.hwS + (s.hw - s.hwS) * 0.8, lerp(s.sill, s.yw, 0.5)]);
  pts.push([s.hw, s.yw]);
  pts.push([s.hw * 0.99, lerp(s.yw, s.bot, 0.5)]);
  pts.push([s.hwB + (s.hw - s.hwB) * 0.72, s.bot + (s.yw - s.bot) * 0.12]);
  pts.push([s.hwB, s.bot + 0.012]);
  pts.push([0, s.bot]);
  return pts;
}

/** Samples between consecutive control points (P0-P1, …, P7-P8). */
export const SECTION_SEGMENTS = [5, 5, 6, 5, 5, 5, 5, 5] as const;
/** Points per half ring (top centre and bottom centre included). */
export const HALF_POINTS = SECTION_SEGMENTS.reduce((a, b) => a + b, 0) + 1;
/** Index of the upper shoulder (P2: sill) and the widest point (P4) in the sampled half ring. */
export const SHOULDER_INDEX = SECTION_SEGMENTS[0] + SECTION_SEGMENTS[1];
export const EDGE_INDEX = SECTION_SEGMENTS.slice(0, 4).reduce((a, b) => a + b, 0);

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

/** Half ring of the body at z, including the nose cone ahead of the joint (scaled to the tip). */
export function bodyHalf(z: number): [number, number][] {
  if (z >= NOSE_JOINT_Z) return sampleHalf(fuselageControl(z));
  const joint = sampleHalf(fuselageControl(NOSE_JOINT_Z));
  const L = NOSE_JOINT_Z - ANCHOR.noseTip.z;
  const d = clamp((z - ANCHOR.noseTip.z) / L, 0, 1);
  // Blunt, rounded nose: an elliptical profile, fuller at the top (the IFR receptacle deck).
  const f = Math.sqrt(1 - (1 - d) * (1 - d));
  const tipY = ANCHOR.noseTip.y;
  const cy = (joint[0][1] + joint[joint.length - 1][1]) / 2;
  const ay = lerp(tipY, cy, d);
  return joint.map(([x, y]) => [x * f, ay + (y - cy) * f]);
}

/** Full closed ring at station z (flat xyz), bottom centre → right side → top → left side. */
export function fuselageRing(z: number): number[] {
  const half = bodyHalf(z);
  const out: number[] = [];
  const H = half.length;
  for (let k = H - 1; k >= 0; k--) out.push(half[k][0], half[k][1], z);
  for (let k = 1; k < H - 1; k++) out.push(-half[k][0], half[k][1], z);
  return out;
}

/** Stations of the body loft: nose tip (dense) → tail cone end. */
export function fuselageStations(): number[] {
  const zs: number[] = [];
  const tip = ANCHOR.noseTip.z;
  const L = NOSE_JOINT_Z - tip;
  for (let i = 0; i <= 12; i++) zs.push(tip + L * (1 - Math.cos((i / 12) * (Math.PI / 2))));
  for (let z = NOSE_JOINT_Z + 0.12; z < FUSE_END_Z - 0.05; z += 0.12) zs.push(Math.round(z * 1000) / 1000);
  for (const z of [TUB.z0, TUB.z0 + 0.06, TUB.z0 + 0.14, TUB.z1 - 0.12, TUB.z1 - 0.05, TUB.z1]) zs.push(z);
  zs.push(FUSE_END_Z);
  const sorted = [...new Set(zs)].sort((a, b) => a - b);
  const out: number[] = [];
  for (const z of sorted) if (!out.length || z - out[out.length - 1] > 0.03) out.push(z);
  if (out[out.length - 1] !== FUSE_END_Z) out[out.length - 1] = FUSE_END_Z;
  return out;
}

/** Top-of-body height at station z (outside the tub), for fairings and details. */
export function bodyTopY(z: number): number {
  const h = bodyHalf(z);
  return h[0][1];
}
/** Bottom-of-body height at station z. */
export function bodyBottomY(z: number): number {
  const h = bodyHalf(z);
  return h[h.length - 1][1];
}
/** Max half width of the body at station z. */
export function bodyHalfWidth(z: number): number {
  return Math.max(...bodyHalf(z).map((p) => p[0]));
}

// ─── Canopy ──────────────────────────────────────────────────────────────────

/**
 * Canopy stations: half width at the sill, sill height, top height and squareness. The front is the
 * armoured windscreen (flat raked front panel with side panels, heavy frame); the bubble behind it is
 * one frameless piece hinged at the rear.
 */
export const CANOPY_KEYS: { z: number; w: number; sill: number; top: number; n: number }[] = [
  // Armoured windscreen: flat raked front panel with side panels (a squarer section)…
  { z: -5.5, w: 0.44, sill: 0.62, top: 0.66, n: 3.6 },
  { z: -4.95, w: 0.485, sill: 0.68, top: 1.34, n: 3.0 },
  // …then the one-piece frameless bubble, hinged at the rear.
  { z: -4.6, w: 0.51, sill: 0.68, top: 1.5, n: 2.45 },
  { z: -4.2, w: 0.525, sill: 0.68, top: 1.585, n: 2.25 },
  { z: -3.9, w: 0.528, sill: 0.68, top: 1.6, n: 2.25 },
  { z: -3.5, w: 0.52, sill: 0.68, top: 1.57, n: 2.25 },
  { z: -3.15, w: 0.5, sill: 0.69, top: 1.47, n: 2.3 },
  { z: -2.95, w: 0.47, sill: 0.72, top: 1.34, n: 2.4 },
  { z: -2.78, w: 0.43, sill: 0.76, top: 1.18, n: 2.5 },
];
export const CANOPY_FRONT_Z = CANOPY_KEYS[0].z;
export const CANOPY_REAR_Z = CANOPY_KEYS[CANOPY_KEYS.length - 1].z;
/** The windscreen frame bow (windscreen ↔ canopy joint). */
export const WINDSCREEN_BOW_Z = CANOPY_KEYS[1].z;

export function canopyAt(z: number): { w: number; sill: number; top: number; n: number } {
  const bubble = CANOPY_KEYS.slice(1);
  const zs = bubble.map((k) => k.z);
  const g = (f: (k: (typeof CANOPY_KEYS)[number]) => number) => {
    // The windscreen is flat: interpolate linearly in front of the bow.
    if (z <= WINDSCREEN_BOW_Z) {
      const a = CANOPY_KEYS[0];
      const b = CANOPY_KEYS[1];
      return lerp(f(a), f(b), clamp((z - a.z) / (b.z - a.z), 0, 1));
    }
    return pchip(zs, bubble.map(f), z);
  };
  return { w: g((k) => k.w), sill: g((k) => k.sill), top: g((k) => k.top), n: g((k) => k.n) };
}

/** Canopy cross-section: an arch from the right sill over the top to the left sill (n+1 points). */
export function canopyArch(z: number, n: number, inset = 0): number[] {
  const c = canopyAt(z);
  const out: number[] = [];
  const w = Math.max(0.001, c.w - inset);
  const h = Math.max(0.001, c.top - c.sill - inset);
  for (let k = 0; k <= n; k++) {
    const t = (k / n) * Math.PI;
    const cs = Math.cos(t);
    const sn = Math.sin(t);
    const x = w * Math.sign(cs) * Math.abs(cs) ** (2 / c.n);
    const y = c.sill + h * Math.abs(sn) ** (2 / c.n);
    out.push(x, y, z);
  }
  return out;
}

// ─── Wing ────────────────────────────────────────────────────────────────────

export const WING = {
  /** Chord-line height of the flat centre section. */
  y: GEO.wingRootLeadingEdge.y,
  rootLeZ: GEO.wingRootLeadingEdge.z,
  rootChord: GEO.wingRootChord,
  tipChord: GEO.wingTipChord,
  /** Loft starts inside the fuselage. */
  rootX: 0.55,
  /** End of the constant-chord centre section (outer panel joint). */
  jointX: 3.07,
  tipX: Math.abs(SP('rightWingtip').x),
  /** The Hoerner tip droops from here out. */
  droopX: 8.2,
  droopDrop: 0.2,
  /** Tip leading / trailing edge (the tip chord is centred on the physics wingtip station). */
  tipLeZ: SP('rightWingtip').z - GEO.wingTipChord / 2,
  tipY: SP('rightWingtip').y,
  thicknessRoot: 0.16,
  thicknessTip: 0.13,
  camber: 0.018,
  /** Slats (centre section LE between the fuselage and the gear pods). */
  slatX0: 0.95,
  slatX1: 2.2,
  slatChord: 0.34,
  /** Slotted flaps: inboard (centre section) and outboard (outer panel). */
  flapInX0: 0.82,
  flapInX1: 3.03,
  flapOutX0: 3.11,
  flapOutX1: 5.38,
  flapFrac: 0.3,
  /** Split decelerons (ailerons + speed brakes) on the outer panels. */
  decelX0: 5.44,
  decelX1: 8.12,
  decelFrac: 0.3,
} as const;

/** Outer-panel dihedral (≈ 6.5°): the tip chord line meets the physics wingtip. */
export const DIHEDRAL = Math.atan2(WING.tipY - WING.y, WING.tipX - WING.jointX);

export function wingLeZ(x: number): number {
  const a = Math.abs(x);
  if (a <= WING.jointX) return WING.rootLeZ;
  return lerp(WING.rootLeZ, WING.tipLeZ, (a - WING.jointX) / (WING.tipX - WING.jointX));
}
export function wingTeZ(x: number): number {
  const a = Math.abs(x);
  const rootTe = WING.rootLeZ + WING.rootChord;
  if (a <= WING.jointX) return rootTe;
  return lerp(rootTe, WING.tipLeZ + WING.tipChord, (a - WING.jointX) / (WING.tipX - WING.jointX));
}
export function wingChord(x: number): number {
  return wingTeZ(x) - wingLeZ(x);
}
/** Chord-line height at span station x (flat centre, dihedral outboard, drooped tip). */
export function wingY(x: number): number {
  const a = Math.abs(x);
  if (a <= WING.jointX) return WING.y;
  let y = WING.y + (a - WING.jointX) * Math.tan(DIHEDRAL);
  if (a > WING.droopX) y -= WING.droopDrop * ((a - WING.droopX) / (WING.tipX - WING.droopX)) ** 2;
  return y;
}
/** Thickness ratio (16 % root → 13 % tip). */
export function wingThickness(x: number): number {
  const a = Math.abs(x);
  if (a <= WING.jointX) return WING.thicknessRoot;
  return lerp(WING.thicknessRoot, WING.thicknessTip, (a - WING.jointX) / (WING.tipX - WING.jointX));
}
/** Local roll of the section (the drooped tip turns down). */
export function wingRoll(x: number): number {
  const a = Math.abs(x);
  if (a <= WING.jointX) return 0;
  if (a <= WING.droopX) return DIHEDRAL;
  const k = (a - WING.droopX) / (WING.tipX - WING.droopX);
  return DIHEDRAL - Math.atan((2 * WING.droopDrop * k) / (WING.tipX - WING.droopX));
}

/** Height of the wing's lower surface at span x, chord fraction f (NACA 4-digit thickness). */
export function wingLowerY(x: number, f: number): number {
  const t = wingThickness(x);
  const c = wingChord(x);
  const ff = clamp(f, 0, 1);
  const half = 5 * t * (0.2969 * Math.sqrt(ff) - 0.126 * ff - 0.3516 * ff * ff + 0.2843 * ff ** 3 - 0.1036 * ff ** 4);
  const camber = ff < 0.4 ? (WING.camber / 0.16) * (0.8 * ff - ff * ff) : (WING.camber / 0.36) * (0.2 + 0.8 * ff - ff * ff);
  return wingY(x) + (camber - half) * c;
}
export function wingUpperY(x: number, f: number): number {
  const t = wingThickness(x);
  const c = wingChord(x);
  const ff = clamp(f, 0, 1);
  const half = 5 * t * (0.2969 * Math.sqrt(ff) - 0.126 * ff - 0.3516 * ff * ff + 0.2843 * ff ** 3 - 0.1036 * ff ** 4);
  const camber = ff < 0.4 ? (WING.camber / 0.16) * (0.8 * ff - ff * ff) : (WING.camber / 0.36) * (0.2 + 0.8 * ff - ff * ff);
  return wingY(x) + (camber + half) * c;
}
/** Lower-surface height under a point (x, z). */
export function wingLowerAt(x: number, z: number): number {
  return wingLowerY(x, (z - wingLeZ(x)) / wingChord(x));
}

/** Pylon stations (x of each wing/fuselage store station; 1 = left wingtip … 11 = right wingtip). */
export const STATION_X: Record<number, number> = { 1: -6.6, 2: -5.45, 3: -4.3, 4: -1.85, 5: -0.5, 6: 0, 7: 0.5, 8: 1.85, 9: 4.3, 10: 5.45, 11: 6.6 };

// ─── Main gear pods ──────────────────────────────────────────────────────────

export const POD = {
  x: Math.abs(GEO.rightMainWheel.x),
  noseZ: -1.78,
  tailZ: 1.62,
  halfWidth: 0.36,
  bottomY: -1.22,
} as const;

// ─── TF34 nacelles ───────────────────────────────────────────────────────────

export const ENGINE = {
  x: Math.abs(SP('rightEngine').x),
  y: 1.1,
  lipZ: 3.1,
  endZ: 6.4,
  radius: SP('rightEngine').y - 1.1,
  /** Fan face (behind the intake lip). */
  fanZ: 3.46,
  fanRadius: 0.47,
  intakeRadius: 0.5,
  fanBlades: 28,
} as const;

/** Nacelle outer radius along z (fan cowl), then the core cowl and the exhaust plug. */
export const NACELLE_PROFILE: [number, number][] = [
  [3.1, 0.575],
  [3.14, 0.607],
  [3.24, 0.628],
  [3.5, 0.645],
  [4.1, ENGINE.radius],
  [4.8, 0.645],
  [5.3, 0.615],
  [5.62, 0.575],
  [5.84, 0.535],
];
export const CORE_PROFILE: [number, number][] = [
  [5.5, 0.43],
  [5.84, 0.415],
  [6.0, 0.39],
  [6.14, 0.345],
];
export const PLUG_PROFILE: [number, number][] = [
  [5.95, 0.27],
  [6.1, 0.25],
  [6.22, 0.19],
  [6.32, 0.1],
  [ENGINE.endZ, 0.0],
];

// ─── Tail ────────────────────────────────────────────────────────────────────

export const STAB = {
  y: GEO.horizontalTail.y,
  halfSpan: GEO.horizontalTail.span / 2,
  rootLeZ: 7.18,
  tipLeZ: 7.36,
  teZ: 8.95,
  thickness: 0.085,
  /** Elevator hinge (fraction of the local chord) and inboard end. */
  elevatorFrac: 0.62,
  elevatorX0: 0.2,
} as const;

export const FIN = {
  x: Math.abs(SP('rightFinTop').x),
  bottomY: SP('rightFinRoot').y,
  topY: GEO.verticalTailTop.y,
  /** Leading edge at the bottom and the top; the trailing edge (rudder) is vertical. */
  bottomLeZ: 7.3,
  topLeZ: 7.78,
  teZ: ANCHOR.tailZ,
  thickness: 0.1,
  /** Rudder: hinge at this z, upper and lower sections split by the stabiliser. */
  rudderHingeZ: 8.36,
  rudderUpperY0: 0.63,
  rudderUpperY1: 2.36,
  rudderLowerY0: -0.24,
  rudderLowerY1: 0.27,
} as const;

/** Fin leading edge z at height y (rounded top-front corner, rounded bottom). */
export function finLeZ(y: number): number {
  const t = (y - FIN.bottomY) / (FIN.topY - FIN.bottomY);
  const straight = lerp(FIN.bottomLeZ, FIN.topLeZ, t);
  // Round the top leading corner (radius ~0.5 m) and the bottom (~0.25 m).
  const topR = 0.55;
  const dt = FIN.topY - y;
  const top = dt < topR ? topR - Math.sqrt(Math.max(0, topR * topR - (topR - dt) ** 2)) : 0;
  const botR = 0.3;
  const db = y - FIN.bottomY;
  const bot = db < botR ? botR - Math.sqrt(Math.max(0, botR * botR - (botR - db) ** 2)) : 0;
  return straight + top + bot;
}
export function finTeZ(y: number): number {
  const db = y - FIN.bottomY;
  const botR = 0.16;
  const bot = db < botR ? botR - Math.sqrt(Math.max(0, botR * botR - (botR - db) ** 2)) : 0;
  const dt = FIN.topY - y;
  const topR = 0.12;
  const top = dt < topR ? topR - Math.sqrt(Math.max(0, topR * topR - (topR - dt) ** 2)) : 0;
  return FIN.teZ - bot - top;
}

// ─── GAU-8/A ─────────────────────────────────────────────────────────────────

/**
 * The seven-barrel cluster: the firing barrel (9 o'clock seen from the front — the cluster's
 * right-hand side) is on the centreline at the muzzle point, so the gun axis sits left of centre.
 */
export const GUN = {
  barrels: A10_WEAPONS.gun!.barrels ?? 7,
  /** Radius of the circle through the barrel axes. */
  circleR: 0.118,
  barrelR: 0.034,
  axisX: MUZZLE.x - 0.118,
  axisY: MUZZLE.y,
  muzzleZ: MUZZLE.z,
  /** Where the barrels leave the gun port fairing. */
  portZ: -6.52,
  /** Muzzle clamp (front) and mid-barrel support ring. */
  clampZ: -7.1,
  midClampZ: -6.72,
} as const;

// ─── Stores ──────────────────────────────────────────────────────────────────

export const MAVERICK = {
  length: A10_WEAPONS.missiles!.lengthM,
  radius: A10_WEAPONS.missiles!.diameterM / 2,
  wingSpan: 0.72,
} as const;

/** LAU-88 triple launchers (the inboard-bottom rail left empty, as on the A-10) under stations 3/9. */
export const LAU88 = {
  x: Math.abs(STATION_X[9]),
  y: -1.06,
  z0: -0.78,
  z1: 1.42,
} as const;

export const DEG_A10 = DEG;
