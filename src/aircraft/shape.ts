/**
 * The C172RG airframe as numbers: fuselage profile curves, wing and tail
 * planforms, gear kinematics. Pure (no three.js) so tests and the livery
 * painter can evaluate the exact same surfaces the meshes are built from.
 *
 * Body frame: +X right wing, +Y up, −Z nose, origin = CG. Anchors (wheels,
 * prop hub, wing root, tail) come from CONFIG.aircraft.geometry.
 */
import { CONFIG } from '../config';

const G = CONFIG.aircraft.geometry;
const DEG = Math.PI / 180;

// ─── Monotone cubic interpolation (Fritsch–Carlson) ──────────────────────────

export type Curve = (x: number) => number;

/** Smooth, overshoot-free curve through the points (clamped outside). */
export function monotoneCurve(pts: ReadonlyArray<readonly [number, number]>): Curve {
  const n = pts.length;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const d: number[] = [];
  const m: number[] = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] > x) hi = mid;
      else lo = mid;
    }
    const h = xs[hi] - xs[lo];
    const t = (x - xs[lo]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[lo] + (t3 - 2 * t2 + t) * h * m[lo] + (-2 * t3 + 3 * t2) * ys[hi] + (t3 - t2) * h * m[hi]
    );
  };
}

// ─── Fuselage cross-sections ──────────────────────────────────────────────────

export interface SectionParams {
  /** y of the top centreline. */
  top: number;
  /** y of the bottom centreline. */
  bottom: number;
  /** Half of the maximum width. */
  halfWidth: number;
  /** y at which the section is widest. */
  widthY: number;
  /** Superellipse exponents of the upper and lower halves (2 = ellipse, larger = boxier). */
  nTop: number;
  nBot: number;
}

/**
 * Point on a fuselage section. t ∈ [0,1): 0 = top centre, 0.25 = left side (−x),
 * 0.5 = bottom centre, 0.75 = right side (+x). (Counter-clockwise seen from the tail.)
 */
export function superSectionPoint(s: SectionParams, t: number, out: { x: number; y: number }) {
  const th = 2 * Math.PI * t;
  const sn = Math.sin(th);
  const cs = Math.cos(th);
  const upper = cs >= 0;
  const n = upper ? s.nTop : s.nBot;
  const e = 2 / n;
  out.x = -s.halfWidth * Math.sign(sn) * Math.pow(Math.abs(sn), e);
  const h = upper ? s.top - s.widthY : s.widthY - s.bottom;
  out.y = s.widthY + (upper ? 1 : -1) * h * Math.pow(Math.abs(cs), e);
  return out;
}

const ARC_SAMPLES = 256;
const _cum = new Float64Array(ARC_SAMPLES + 1);
const _ap = { x: 0, y: 0 };

/**
 * Arc-length parameterisation of a section: converts ring parameters t (0 top,
 * 0.25 left, 0.5 belly, 0.75 right — as fractions of the half-perimeter on each
 * side) into the angle parameter of superSectionPoint. Evenly spaced t then gives
 * evenly spaced points (and texels) all round, flat cabin sides included.
 */
export function arcToAngle(s: SectionParams, ts: ArrayLike<number>, out: Float64Array | number[]): void {
  superSectionPoint(s, 0, _ap);
  let px = _ap.x;
  let py = _ap.y;
  _cum[0] = 0;
  for (let i = 1; i <= ARC_SAMPLES; i++) {
    superSectionPoint(s, (0.5 * i) / ARC_SAMPLES, _ap);
    _cum[i] = _cum[i - 1] + Math.hypot(_ap.x - px, _ap.y - py);
    px = _ap.x;
    py = _ap.y;
  }
  const total = _cum[ARC_SAMPLES];
  for (let k = 0; k < ts.length; k++) {
    let t = ts[k] % 1;
    if (t < 0) t += 1;
    const mirrored = t > 0.5;
    const target = (mirrored ? 1 - t : t) * 2 * total;
    let lo = 0;
    let hi = ARC_SAMPLES;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (_cum[mid] > target) hi = mid;
      else lo = mid;
    }
    const seg = _cum[hi] - _cum[lo];
    const f = seg > 0 ? (target - _cum[lo]) / seg : 0;
    const a = (0.5 * (lo + f)) / ARC_SAMPLES;
    out[k] = mirrored ? 1 - a : a;
  }
}

/** Nose bowl front face z (the loft starts here; the spinner sits just ahead). */
export const FUSE_Z0 = -1.985;
/** Tailcone end (the rudder hinge region). */
export const FUSE_Z1 = 5.5;
/** The windshield meets the cowling here (centreline). */
export const WINDSHIELD_BASE_Z = -1.25;

const topCurve = monotoneCurve([
  [FUSE_Z0, 0.236],
  [-1.8, 0.249],
  [-1.5, 0.258],
  [WINDSHIELD_BASE_Z, 0.262],
  [-1.0, 0.49],
  [-0.8, 0.69],
  [-0.66, 0.83],
  [-0.56, 0.925],
  [-0.47, 0.95],
  [-0.1, 0.956],
  [0.6, 0.955],
  [1.08, 0.94],
  [1.25, 0.9],
  [1.6, 0.775],
  [1.95, 0.66],
  [2.2, 0.608],
  [2.8, 0.53],
  [3.8, 0.425],
  [4.8, 0.3],
  [FUSE_Z1, 0.235],
]);
const bottomCurve = monotoneCurve([
  [FUSE_Z0, -0.335],
  [-1.8, -0.4],
  [-1.5, -0.452],
  [-1.2, -0.49],
  [-0.9, -0.535],
  [-0.3, -0.545],
  [0.6, -0.51],
  [1.2, -0.462],
  [2.0, -0.365],
  [2.8, -0.282],
  [3.8, -0.192],
  [4.8, -0.112],
  [FUSE_Z1, -0.055],
]);
const halfWidthCurve = monotoneCurve([
  [FUSE_Z0, 0.37],
  [-1.85, 0.415],
  [-1.6, 0.448],
  [-1.25, 0.49],
  [-0.9, 0.532],
  [-0.5, 0.558],
  [0.0, 0.565],
  [0.6, 0.556],
  [1.1, 0.532],
  [1.6, 0.476],
  [2.1, 0.41],
  [2.8, 0.318],
  [3.8, 0.214],
  [4.8, 0.132],
  [FUSE_Z1, 0.082],
]);
const widthYCurve = monotoneCurve([
  [FUSE_Z0, -0.03],
  [-1.25, -0.01],
  [-0.9, 0.07],
  [-0.5, 0.14],
  [1.1, 0.15],
  [2.1, 0.16],
  [3.8, 0.12],
  [FUSE_Z1, 0.09],
]);
const nTopCurve = monotoneCurve([
  [FUSE_Z0, 2.3],
  [-1.25, 2.6],
  [-0.9, 3.3],
  [-0.55, 4.6],
  [0.9, 4.8],
  [1.3, 3.8],
  [2.1, 2.7],
  [3.0, 2.3],
  [FUSE_Z1, 2.2],
]);
const nBotCurve = monotoneCurve([
  [FUSE_Z0, 2.3],
  [-1.25, 2.8],
  [-0.6, 3.4],
  [0.8, 3.4],
  [2.1, 2.8],
  [3.5, 2.5],
  [FUSE_Z1, 2.3],
]);

export function fuselageSection(z: number, out: SectionParams): SectionParams {
  out.top = topCurve(z);
  out.bottom = bottomCurve(z);
  out.halfWidth = halfWidthCurve(z);
  out.widthY = widthYCurve(z);
  out.nTop = nTopCurve(z);
  out.nBot = nBotCurve(z);
  return out;
}

/** Fuselage loft stations: dense where the profile turns (nose, windshield, rear window, tail). */
export function fuselageStations(quality: 'high' | 'low'): number[] {
  const breaks: Array<[number, number]> = [
    // [z up to, spacing]
    [-1.8, 0.04],
    [WINDSHIELD_BASE_Z, 0.06],
    [-0.4, 0.035],
    [1.0, 0.1],
    [2.2, 0.05],
    [FUSE_Z1, 0.15],
  ];
  const k = quality === 'high' ? 1 : 2;
  const zs: number[] = [FUSE_Z0];
  let z = FUSE_Z0;
  for (const [end, step] of breaks) {
    const s = step * k;
    const n = Math.max(1, Math.round((end - z) / s));
    const d = (end - z) / n;
    for (let i = 1; i <= n; i++) zs.push(z + d * i);
    z = end;
  }
  return zs;
}

// ─── Windows & door lines (side projection z,y) ──────────────────────────────

/** A-pillar (windshield side edge) in side view: from the lower corner up to the wing root. */
export const PILLAR = { z0: -1.16, y0: 0.2, z1: -0.55, y1: 0.87 };
export function pillarY(z: number): number {
  return PILLAR.y0 + ((z - PILLAR.z0) * (PILLAR.y1 - PILLAR.y0)) / (PILLAR.z1 - PILLAR.z0);
}
/** Windshield bottom edge z as a function of |x| (curves aft toward the corners). */
export function windshieldBaseZ(ax: number): number {
  const r = Math.min(1, ax / 0.5);
  return WINDSHIELD_BASE_Z + 0.1 * r * r;
}

/** Side window outlines in (z, y), convex, clockwise-agnostic; corner radius applied by the painter. */
export const DOOR_WINDOW: ReadonlyArray<readonly [number, number]> = [
  [-0.92, 0.36],
  [-0.455, 0.87],
  [0.27, 0.87],
  [0.27, 0.36],
];
export const REAR_SIDE_WINDOW: ReadonlyArray<readonly [number, number]> = [
  [0.4, 0.37],
  [0.4, 0.87],
  [1.02, 0.87],
  [1.5, 0.6],
  [1.5, 0.43],
];
/** Rear ("Omni-Vision") window: z range and its lower edge line in side view. */
export const REAR_WINDOW = { z0: 1.13, z1: 1.93, yFront: 0.875, yBack: 0.55 };
export function rearWindowLowerY(z: number): number {
  return REAR_WINDOW.yFront + ((z - REAR_WINDOW.z0) * (REAR_WINDOW.yBack - REAR_WINDOW.yFront)) / (REAR_WINDOW.z1 - REAR_WINDOW.z0);
}
/** Cabin door outline (panel line) in (z, y). */
export const DOOR_OUTLINE: ReadonlyArray<readonly [number, number]> = [
  [-0.97, -0.33],
  [-0.99, 0.26],
  [-0.5, 0.925],
  [0.34, 0.925],
  [0.34, -0.33],
];

// ─── Wing ─────────────────────────────────────────────────────────────────────

export const WING = {
  rootLE: G.wingRootLeadingEdge,
  rootChord: G.wingRootChord,
  tipChord: G.wingTipChord,
  taperStart: G.wingTaperStart,
  semiSpan: CONFIG.aircraft.wingSpan / 2,
  dihedral: G.dihedralDeg * DEG,
  /** Incidence at the root and at the tip (washout), radians. */
  rootIncidence: 1.5 * DEG,
  tipIncidence: -1.5 * DEG,
  /** Airfoil: NACA 2412. */
  m: 0.02,
  p: 0.4,
  t: 0.12,
  /** Span stations of the pieces (from the centreline). */
  flapInboard: 0.6,
  flapOutboard: 2.5,
  aileronInboard: 2.54,
  aileronOutboard: 4.97,
  tipStart: 5.0,
  /** The fibreglass tip ends here; the nav light housing completes the span. */
  tipEnd: 5.43,
  /** Hinge lines as a fraction of the local chord. */
  flapHinge: 0.735,
  aileronHinge: 0.75,
};

/** Trailing edge is straight; the outer panel's leading edge sweeps back (taper on the LE). */
export function wingChord(ax: number): number {
  if (ax <= WING.taperStart) return WING.rootChord;
  const f = Math.min(1, (ax - WING.taperStart) / (WING.semiSpan - WING.taperStart));
  return WING.rootChord + (WING.tipChord - WING.rootChord) * f;
}
export function wingTEz(): number {
  return WING.rootLE.z + WING.rootChord;
}
export function wingLEz(ax: number): number {
  return wingTEz() - wingChord(ax);
}
export function wingLEy(ax: number): number {
  return WING.rootLE.y + ax * Math.tan(WING.dihedral);
}
export function wingIncidence(ax: number): number {
  if (ax <= WING.taperStart) return WING.rootIncidence;
  const f = Math.min(1, (ax - WING.taperStart) / (WING.semiSpan - WING.taperStart));
  return WING.rootIncidence + (WING.tipIncidence - WING.rootIncidence) * f;
}

/** Body-frame point on the wing at span |x| = ax (side ±1), chord fraction c, thickness coordinate a (fractions of chord). */
export function wingPoint(side: number, ax: number, c: number, a: number, out: { x: number; y: number; z: number }) {
  const ch = wingChord(ax);
  const inc = wingIncidence(ax);
  const ci = Math.cos(inc);
  const si = Math.sin(inc);
  out.x = side * ax;
  out.z = wingLEz(ax) + ch * (c * ci + a * si);
  out.y = wingLEy(ax) + ch * (a * ci - c * si);
  return out;
}

/** Strut: fuselage fitting → wing fitting (right side; mirror x for the left). */
export const STRUT = {
  fuselage: { x: 0.5, y: -0.4, z: -0.02 },
  wing: { x: 2.56, y: 0.0, z: -0.12 }, // y filled from the wing lower surface at build time
  chord: 0.13,
  thickness: 0.34,
};

// ─── Tail ─────────────────────────────────────────────────────────────────────

export const HTAIL = {
  y: G.horizontalTail.y,
  semiSpan: G.horizontalTail.span / 2,
  rootLE: 4.72,
  tipLE: 5.2,
  hinge: 5.4,
  rootTE: 5.93,
  tipTE: 5.8,
  t: 0.09,
  /** Elevator cut-out around the rudder bottom. */
  rudderGap: 0.1,
  /** Trim tab on the right elevator (span range) and its chord. */
  tabInboard: 0.22,
  tabOutboard: 0.7,
  tabChord: 0.12,
};

export const VTAIL = {
  /** Fin leading edge from the dorsal fillet up to the tip (z,y). */
  leRoot: { z: 4.6, y: 0.8 },
  leTop: { z: 5.22, y: 1.37 },
  /** Dorsal fillet starts here on the tailcone top. */
  dorsalStart: 2.15,
  /** Rudder hinge line (bottom → top) and trailing edge (bottom → top). */
  hingeBottom: { z: 5.47, y: -0.08 },
  hingeTop: { z: 5.6, y: 1.4 },
  teBottom: { z: 5.97, y: -0.06 },
  teTop: { z: 6.0, y: 1.3 },
  /** Top of the rudder counterbalance horn (reaches forward over the fin tip). */
  hornTop: 1.44,
  hornFront: 5.28,
  finTop: 1.4,
  t: 0.1,
  maxHalfThickness: 0.07,
};

// ─── Landing gear ─────────────────────────────────────────────────────────────

export const GEAR = {
  /** Nose leg pivot (top of the oleo) and axle. The leg swings aft about +X. */
  nosePivot: { x: 0, y: -0.36, z: G.noseWheel.z },
  noseAxle: { x: G.noseWheel.x, y: G.noseWheel.y + G.noseWheelRadius, z: G.noseWheel.z },
  /** Right main leg pivot inside the lower fuselage side; mirrored for the left. */
  mainPivot: { x: 0.43, y: -0.38, z: 0.32 },
  mainAxle: { x: G.rightMainWheel.x, y: G.rightMainWheel.y + G.mainWheelRadius, z: G.rightMainWheel.z },
  /** Where the right axle ends up with the gear stowed (wheel lying in the belly well). */
  mainStowed: { x: 0.23, y: -0.37, z: 1.36 },
  mainTyreWidth: 0.15,
  noseTyreWidth: 0.12,
};
