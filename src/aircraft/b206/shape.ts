/**
 * Bell 206B-3 JetRanger III: the analytic shape (PURE, no three.js). Everything the lofts, the
 * livery painter, the glass, the cockpit and the tests need to agree on lives here.
 *
 * Body frame: metres, origin = CG, +X right, +Y up, −Z nose. The anchors come from
 * B206_AIRCRAFT.geometry / .rotorcraft (nose tip, rotor hub, tail rotor, fin top, stabiliser,
 * skids); the profile in between follows the real aircraft's three-view.
 *
 * Fuselage cross-sections are two superellipses (a rounder roof over a flatter belly) joined at
 * the widest line `wY`. A section point is parameterised by u ∈ [0, 1): u = 0 is the keel, 0.25
 * the right side, 0.5 the roof, 0.75 the left side (so the loft seam runs along the belly, never
 * through the paint). The livery texture uses the same (u, v(z)) mapping.
 */
import { B206_AIRCRAFT } from '../../config';

const G = B206_AIRCRAFT.geometry;
const RC = B206_AIRCRAFT.rotorcraft!;

export const DEG = Math.PI / 180;

/** Nose tip (the forward-most point) and the joints along the airframe. */
export const Z_TIP = G.spinnerTip.z;
export const Y_TIP = G.spinnerTip.y;
/** Where the tail boom is bolted to the aft fuselage. */
export const Z_JOINT = 2.0;
/** Aft end of the boom (the fins and the tail-rotor gearbox sit on it). */
export const Z_BOOM_END = 6.35;
/** Rear wall of the passenger cabin (the baggage compartment is behind it). */
export const Z_CABIN_END = 0.32;
/** The painted texture spans the whole skin: v = 0 at the nose tip … 1 at the boom end. */
export const vOfZ = (z: number) => (z - Z_TIP) / (Z_BOOM_END - Z_TIP);
export const zOfV = (v: number) => Z_TIP + v * (Z_BOOM_END - Z_TIP);
/** Cabin-only mapping (interior lining and glass): v = 0 at the nose tip … 1 at the cabin's rear wall. */
export const vCabinOfZ = (z: number) => (z - Z_TIP) / (Z_CABIN_END - Z_TIP);
export const zOfVCabin = (v: number) => Z_TIP + v * (Z_CABIN_END - Z_TIP);

// ─── Tail boom: a straight tapered tube rising slightly toward the tail ─────────────────────────
export const boomCy = (z: number) => 0.2 + (z - Z_JOINT) * 0.035;
export const boomR = (z: number) => 0.22 - (z - Z_JOINT) * 0.0205;

// ─── Monotone cubic interpolation (no overshoot between control points) ─────────────────────────
export type Curve = (z: number) => number;
export function pchip(pts: ReadonlyArray<readonly [number, number]>): Curve {
  const n = pts.length;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const h: number[] = [];
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(xs[i + 1] - xs[i]);
    d.push((ys[i + 1] - ys[i]) / h[i]);
  }
  const m: number[] = new Array(n).fill(0);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0;
    else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }
  return (x: number) => {
    if (x <= xs[0]) return ys[0] + m[0] * (x - xs[0]);
    if (x >= xs[n - 1]) return ys[n - 1] + m[n - 1] * (x - xs[n - 1]);
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const t = (x - xs[i]) / h[i];
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h[i] * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h[i] * m[i + 1];
  };
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Rounds the nose: 0 at the tip → 1 at `len` aft of it, with a vertical tangent at the tip (an elliptic cap). */
function noseRound(z: number, len: number): number {
  const s = (z - Z_TIP) / len;
  if (s >= 1) return 1;
  if (s <= 0) return 0;
  return Math.sqrt(1 - (1 - s) * (1 - s));
}

// Boom samples appended to each cabin curve so the aft fuselage flows into the boom's taper.
const boomTail = (f: (z: number) => number): Array<[number, number]> => [Z_JOINT, Z_JOINT + 0.4, Z_JOINT + 0.8].map((z) => [z, f(z)]);

/** Side-view profile of the cabin pod (before the nose is rounded off). */
const TOP = pchip([
  [Z_TIP, 0.3],
  [-2.4, 0.48],
  [-2.2, 0.62],
  [-2.0, 0.73],
  [-1.8, 0.82],
  [-1.6, 0.89],
  [-1.35, 0.935],
  [-1.0, 0.955],
  [-0.4, 0.962],
  [0.2, 0.955],
  [0.7, 0.925],
  [1.1, 0.84],
  [1.5, 0.64],
  ...boomTail((z) => boomCy(z) + boomR(z)),
]);
const BOTTOM = pchip([
  [Z_TIP, -0.72],
  [-2.4, -0.8],
  [-2.2, -0.81],
  [0.45, -0.81],
  [0.8, -0.77],
  [1.1, -0.64],
  [1.45, -0.38],
  [1.75, -0.12],
  ...boomTail((z) => boomCy(z) - boomR(z)),
]);
const WIDTH_Y = pchip([
  [Z_TIP, Y_TIP],
  [-2.0, -0.06],
  [-1.2, 0.02],
  [0.3, 0.05],
  [0.9, 0.1],
  [1.5, 0.16],
  ...boomTail(boomCy),
]);
const HALF_W = pchip([
  [Z_TIP, 0.5],
  [-2.3, 0.56],
  [-2.0, 0.6],
  [-1.6, 0.625],
  [-1.0, 0.636],
  [0.2, 0.632],
  [0.6, 0.605],
  [1.0, 0.51],
  [1.4, 0.37],
  [1.75, 0.265],
  ...boomTail(boomR),
]);
const N_TOP = pchip([
  [Z_TIP, 2.1],
  [-1.8, 2.4],
  [0.5, 2.5],
  [1.2, 2.3],
  [Z_JOINT, 2],
  [Z_JOINT + 1, 2],
]);
const N_BOT = pchip([
  [Z_TIP, 2.2],
  [-2.0, 3.0],
  [0.4, 3.4],
  [1.0, 2.8],
  [1.6, 2.2],
  [Z_JOINT, 2],
  [Z_JOINT + 1, 2],
]);

export interface Section {
  /** Height of the widest line, the roof and the keel. */
  wY: number;
  top: number;
  bottom: number;
  /** Half-width at wY. */
  hw: number;
  /** Superellipse exponents of the upper and lower halves (2 = ellipse, bigger = boxier). */
  nT: number;
  nB: number;
}

export function makeSection(): Section {
  return { wY: 0, top: 0, bottom: 0, hw: 0, nT: 2, nB: 2 };
}

/** The fuselage cross-section at station z (cabin pod, aft fuselage or boom). */
export function fuselageSection(z: number, out: Section = makeSection()): Section {
  if (z >= Z_JOINT) {
    const zz = Math.min(z, Z_BOOM_END);
    const cy = boomCy(zz);
    const r = boomR(zz);
    out.wY = cy;
    out.top = cy + r;
    out.bottom = cy - r;
    out.hw = r;
    out.nT = 2;
    out.nB = 2;
    return out;
  }
  const zz = Math.max(z, Z_TIP);
  const fT = noseRound(zz, 0.5);
  const fB = noseRound(zz, 0.4);
  const fW = noseRound(zz, 0.45);
  out.top = Y_TIP + (TOP(zz) - Y_TIP) * fT;
  out.bottom = Y_TIP + (BOTTOM(zz) - Y_TIP) * fB;
  out.wY = Y_TIP + (WIDTH_Y(zz) - Y_TIP) * Math.min(fT, fB);
  out.wY = Math.min(out.top - 1e-4, Math.max(out.bottom + 1e-4, out.wY));
  out.hw = HALF_W(zz) * fW;
  out.nT = N_TOP(zz);
  out.nB = N_BOT(zz);
  return out;
}

/** Inset a section by `t` metres all round (the cabin lining). */
export function insetSection(s: Section, t: number, out: Section = makeSection()): Section {
  out.wY = s.wY;
  out.top = Math.max(s.wY + 1e-4, s.top - t);
  out.bottom = Math.min(s.wY - 1e-4, s.bottom + t);
  out.hw = Math.max(1e-4, s.hw - t);
  out.nT = s.nT;
  out.nB = s.nB;
  return out;
}

const spow = (v: number, e: number) => (v < 0 ? -Math.pow(-v, e) : Math.pow(v, e));

/** Point of a section at ring parameter u (0 keel, 0.25 right, 0.5 roof, 0.75 left). Writes [x, y]. */
export function sectionPoint(s: Section, u: number, out: [number, number] = [0, 0]): [number, number] {
  const th = 2 * Math.PI * u - Math.PI / 2;
  const c = Math.cos(th);
  const sn = Math.sin(th);
  const up = sn >= 0;
  const n = up ? s.nT : s.nB;
  out[0] = s.hw * spow(c, 2 / n);
  out[1] = s.wY + (up ? s.top - s.wY : s.wY - s.bottom) * spow(sn, 2 / n);
  return out;
}

/** Half-width of section `s` at height y (0 outside the section). */
export function sectionHalfWidthAt(s: Section, y: number): number {
  const up = y >= s.wY;
  const h = up ? s.top - s.wY : s.wY - s.bottom;
  const n = up ? s.nT : s.nB;
  const t = Math.abs(y - s.wY) / Math.max(h, 1e-6);
  if (t >= 1) return 0;
  return s.hw * Math.pow(1 - Math.pow(t, n), 1 / n);
}

const _s = makeSection();
/** |x| of the fuselage skin at (y, z). */
export function skinHalfWidth(y: number, z: number): number {
  return sectionHalfWidthAt(fuselageSection(z, _s), y);
}

// ─── Engine / transmission fairing on the roof ──────────────────────────────────────────────────
export const FAIRING_Z0 = -0.95;
export const FAIRING_Z1 = 2.42;
const FAIR_TOP = pchip([
  [FAIRING_Z0, 1.02],
  [-0.8, 1.1],
  [-0.55, 1.175],
  [-0.2, 1.205],
  [0.3, 1.2],
  [0.65, 1.175],
  [1.0, 1.15],
  [1.5, 1.1],
  [1.9, 0.92],
  [2.2, 0.66],
  [FAIRING_Z1, 0.48],
]);
const FAIR_HW = pchip([
  [FAIRING_Z0, 0.3],
  [-0.8, 0.38],
  [-0.5, 0.43],
  [0.2, 0.44],
  [0.6, 0.42],
  [1.2, 0.37],
  [1.8, 0.3],
  [2.2, 0.19],
  [FAIRING_Z1, 0.12],
]);
/** Fairing cross-section at z: a superellipse whose lower half is buried in the roof. */
export function fairingSection(z: number, out: Section = makeSection()): Section {
  const zz = Math.min(FAIRING_Z1, Math.max(FAIRING_Z0, z));
  const f0 = Math.sqrt(Math.max(0, 1 - Math.pow(1 - Math.min(1, (zz - FAIRING_Z0) / 0.22), 2)));
  const f1 = Math.sqrt(Math.max(0, 1 - Math.pow(1 - Math.min(1, (FAIRING_Z1 - zz) / 0.12), 2)));
  const f = Math.min(f0, f1);
  const roof = fuselageSection(zz, _s).top;
  const bottom = roof - 0.06;
  const top = bottom + (FAIR_TOP(zz) - bottom) * Math.max(0.02, f);
  out.bottom = bottom;
  out.top = top;
  out.wY = bottom + 0.3 * (top - bottom);
  out.hw = Math.max(0.004, FAIR_HW(zz) * Math.max(0.03, f));
  out.nT = 2.6;
  out.nB = 2;
  return out;
}
export const fairingTop = (z: number) => fairingSection(z).top;

// ─── Windows (side-view signed distances, negative inside) ─────────────────────────────────────

type Poly = ReadonlyArray<readonly [number, number]>;

/** A convex polygon in (z, y), precompiled: outward edge normals, lengths and its bounding box. */
interface CompiledPoly {
  ax: Float64Array;
  ay: Float64Array;
  ex: Float64Array;
  ey: Float64Array;
  len2: Float64Array;
  nx: Float64Array;
  ny: Float64Array;
  z0: number;
  z1: number;
  y0: number;
  y1: number;
}
const compiled = new WeakMap<Poly, CompiledPoly>();
function compile(poly: Poly): CompiledPoly {
  let c = compiled.get(poly);
  if (c) return c;
  const n = poly.length;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const sgn = area > 0 ? 1 : -1;
  c = {
    ax: new Float64Array(n), ay: new Float64Array(n), ex: new Float64Array(n), ey: new Float64Array(n),
    len2: new Float64Array(n), nx: new Float64Array(n), ny: new Float64Array(n),
    z0: Infinity, z1: -Infinity, y0: Infinity, y1: -Infinity,
  };
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const len = Math.hypot(ex, ey);
    c.ax[i] = a[0];
    c.ay[i] = a[1];
    c.ex[i] = ex;
    c.ey[i] = ey;
    c.len2[i] = len * len;
    // Outward unit normal (the inside is on the left of a counter-clockwise ring).
    c.nx[i] = (sgn * ey) / len;
    c.ny[i] = (-sgn * ex) / len;
    c.z0 = Math.min(c.z0, a[0]);
    c.z1 = Math.max(c.z1, a[0]);
    c.y0 = Math.min(c.y0, a[1]);
    c.y1 = Math.max(c.y1, a[1]);
  }
  compiled.set(poly, c);
  return c;
}

/**
 * Signed distance to a convex polygon in (z, y) (negative inside), exact within `near` of it;
 * farther out it returns a lower bound (the distance to its bounding box), which is all the
 * painters need and much cheaper.
 */
export function sdConvex(poly: Poly, pz: number, py: number, near = Infinity): number {
  const c = compile(poly);
  const bz = Math.max(c.z0 - pz, pz - c.z1, 0);
  const by = Math.max(c.y0 - py, py - c.y1, 0);
  if (bz > near || by > near) return Math.max(bz, by);
  let inside = true;
  let edgeMax = -Infinity;
  let dmin2 = Infinity;
  const n = c.ax.length;
  for (let i = 0; i < n; i++) {
    const dz = pz - c.ax[i];
    const dy = py - c.ay[i];
    const side = dz * c.nx[i] + dy * c.ny[i];
    if (side > 0) inside = false;
    if (side > edgeMax) edgeMax = side;
    const t = Math.max(0, Math.min(1, (dz * c.ex[i] + dy * c.ey[i]) / c.len2[i]));
    const qz = dz - t * c.ex[i];
    const qy = dy - t * c.ey[i];
    const d2 = qz * qz + qy * qy;
    if (d2 < dmin2) dmin2 = d2;
  }
  return inside ? edgeMax : Math.sqrt(dmin2);
}

/** Distance from (pz, py) to an open polyline. */
export function polylineDistance(line: Poly, pz: number, py: number): number {
  let d = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i];
    const b = line[i + 1];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((pz - a[0]) * ex + (py - a[1]) * ey) / (ex * ex + ey * ey)));
    d = Math.min(d, Math.hypot(pz - a[0] - t * ex, py - a[1] - t * ey));
  }
  return d;
}

/** Windscreen aft edge / A-pillar: the line through these two (z, y) points. */
export const A_PILLAR = { lo: [-1.93, 0.06], hi: [-1.62, 0.86] } as const;
const aPillarZ = (y: number) => A_PILLAR.lo[0] + ((y - A_PILLAR.lo[1]) * (A_PILLAR.hi[0] - A_PILLAR.lo[0])) / (A_PILLAR.hi[1] - A_PILLAR.lo[1]);

/**
 * Side-view window outlines (z, y), already inset by their corner radius (the window is the set
 * within `r` of the polygon). One set per side (the airframe is symmetric).
 */
export const WINDOWS = {
  /** The big curved windscreen, one per side of the centre post, wrapping onto the roof. */
  windscreen: {
    poly: [
      [Z_TIP - 0.1, 0.02],
      [A_PILLAR.lo[0], A_PILLAR.lo[1]],
      [aPillarZ(1.3), 1.3],
      [Z_TIP - 0.1, 1.3],
    ] as Poly,
    r: 0,
    /** Half-width of the centre post (the windscreen stops this far from x = 0). */
    post: 0.016,
  },
  /** Chin windows in the lower nose, either side of the keel. */
  chin: {
    poly: [
      [-2.53, -0.1],
      [-2.02, -0.1],
      [-2.05, -0.5],
      [-2.28, -0.6],
      [-2.46, -0.49],
      [-2.54, -0.28],
    ] as Poly,
    r: 0.035,
    keel: 0.055,
  },
  /** Front (crew) door window. */
  frontDoor: {
    poly: [
      [-1.815, 0.0],
      [-1.55, 0.72],
      [-1.02, 0.74],
      [-1.02, -0.01],
    ] as Poly,
    r: 0.07,
  },
  /** Rear (passenger) door window. */
  rearDoor: {
    poly: [
      [-0.76, 0.03],
      [-0.76, 0.72],
      [-0.07, 0.72],
      [0.0, 0.05],
    ] as Poly,
    r: 0.07,
  },
  /** Overhead (roof) windows above the crew seats: top-view (x, z) rectangle, rounded. */
  overhead: { x0: 0.09, x1: 0.4, z0: -1.49, z1: -1.03, r: 0.05 },
} as const;

/** Beyond this (m) from a window, windowSd returns a lower bound, not the exact distance. */
export const WINDOW_NEAR = 0.25;
const NEAR = WINDOW_NEAR;

// Compile the window outlines once.
for (const w of [WINDOWS.windscreen, WINDOWS.chin, WINDOWS.frontDoor, WINDOWS.rearDoor]) compile(w.poly);

export type WindowKind = 'none' | 'windscreen' | 'chin' | 'frontDoor' | 'rearDoor' | 'overhead';

/**
 * Signed distance (m, negative inside) from a skin point to the nearest window, and which one
 * (exact within WINDOW_NEAR of a window, a lower bound beyond).
 */
export function windowSd(x: number, y: number, z: number, out: { d: number; kind: WindowKind } = { d: 0, kind: 'none' }): { d: number; kind: WindowKind } {
  out.d = Infinity;
  out.kind = 'none';
  if (z > Z_CABIN_END + 0.1 || z < Z_TIP - 0.01) return out;
  const ax = Math.abs(x);
  const W = WINDOWS;
  // Windscreen: the side-view polygon, minus the centre post.
  if (z < -1.4) {
    const d = Math.max(sdConvex(W.windscreen.poly, z, y, NEAR), W.windscreen.post - ax);
    if (d < out.d) {
      out.d = d;
      out.kind = 'windscreen';
    }
    const c = Math.max(sdConvex(W.chin.poly, z, y, NEAR) - W.chin.r, W.chin.keel - ax);
    if (c < out.d) {
      out.d = c;
      out.kind = 'chin';
    }
  }
  // Door windows: only on the sides of the cabin.
  if (ax > 0.25 && z > -1.9 && z < 0.15) {
    const f = sdConvex(W.frontDoor.poly, z, y, NEAR) - W.frontDoor.r;
    if (f < out.d) {
      out.d = f;
      out.kind = 'frontDoor';
    }
    const r = sdConvex(W.rearDoor.poly, z, y, NEAR) - W.rearDoor.r;
    if (r < out.d) {
      out.d = r;
      out.kind = 'rearDoor';
    }
  }
  // Overhead windows on the roof.
  if (y > 0.8 && z > -1.6 && z < -0.9) {
    const o = W.overhead;
    const qx = Math.max(o.x0 + o.r - ax, ax - (o.x1 - o.r), 0);
    const qz = Math.max(o.z0 + o.r - z, z - (o.z1 - o.r), 0);
    const inX = Math.max(o.x0 + o.r - ax, ax - (o.x1 - o.r));
    const inZ = Math.max(o.z0 + o.r - z, z - (o.z1 - o.r));
    const d = (qx > 0 || qz > 0 ? Math.hypot(qx, qz) : Math.max(inX, inZ)) - o.r;
    if (d < out.d) {
      out.d = d;
      out.kind = 'overhead';
    }
  }
  return out;
}

// ─── Doors (panel lines, side view) ─────────────────────────────────────────────────────────────
const doorFront = (y: number) => aPillarZ(y) + 0.045;
export const DOOR_LINES: ReadonlyArray<Poly> = [
  // Front (crew) door: follows the A-pillar, then along the roof and down the B-pillar.
  [
    [doorFront(-0.1), -0.66],
    [doorFront(0.06), 0.06],
    [doorFront(0.9), 0.9],
    [-0.9, 0.9],
    [-0.9, -0.66],
    [doorFront(-0.1), -0.66],
  ],
  // Rear (passenger) door.
  [
    [-0.865, -0.66],
    [-0.865, 0.9],
    [0.13, 0.9],
    [0.13, -0.66],
    [-0.865, -0.66],
  ],
  // Baggage compartment door, aft of the cabin.
  [
    [0.48, -0.5],
    [0.48, 0.12],
    [1.0, 0.12],
    [1.0, -0.5],
    [0.48, -0.5],
  ],
];
/** Door outline segments (side view), with their bounding boxes. */
const DOOR_SEGS: Float64Array = (() => {
  const out: number[] = [];
  for (const l of DOOR_LINES) for (let i = 0; i < l.length - 1; i++) out.push(l[i][0], l[i][1], l[i + 1][0], l[i + 1][1]);
  return new Float64Array(out);
})();
/** Distance (m) from a side-view point to the nearest door outline (a lower bound beyond `near`). */
export function doorLineDistance(z: number, y: number, near = 0.05): number {
  let d2 = near * near;
  const S = DOOR_SEGS;
  for (let i = 0; i < S.length; i += 4) {
    const az = S[i];
    const ay = S[i + 1];
    const bz = S[i + 2];
    const by = S[i + 3];
    if (z < Math.min(az, bz) - near || z > Math.max(az, bz) + near || y < Math.min(ay, by) - near || y > Math.max(ay, by) + near) continue;
    const ez = bz - az;
    const ey = by - ay;
    const t = Math.max(0, Math.min(1, ((z - az) * ez + (y - ay) * ey) / (ez * ez + ey * ey)));
    const qz = z - az - t * ez;
    const qy = y - ay - t * ey;
    const q = qz * qz + qy * qy;
    if (q < d2) d2 = q;
  }
  return Math.sqrt(d2);
}

/** Door handles (side view centres). */
export const DOOR_HANDLES: ReadonlyArray<readonly [number, number]> = [
  [-1.02, -0.08],
  [-0.05, -0.07],
  [0.9, -0.2],
];

// ─── Livery lines ───────────────────────────────────────────────────────────────────────────────
/** Dividing line between the white upper body and the dark blue belly (a gold stripe rides above it). */
export function paintDivideY(z: number): number {
  const boomLine = boomCy(z) - 0.07;
  return -0.4 + (boomLine + 0.4) * smoothstep(0.3, 2.3, z);
}

/** Registration on both sides of the boom: side-view box (z centre, y bottom and top relative to the boom centre). */
export const REGISTRATION = { zc: 3.35, h: 0.13, yOff: 0.016, text: B206_AIRCRAFT.registration } as const;

// ─── Rotor / tail anchors from the config ───────────────────────────────────────────────────────
export const ROTOR = {
  hub: RC.rotor.hub,
  radius: RC.rotor.radius,
  chord: RC.rotor.chord,
  mastTilt: RC.rotor.mastTiltDeg * DEG,
  precone: RC.rotor.preconeDeg * DEG,
  twist: RC.rotor.twistDeg * DEG,
  direction: RC.rotor.direction,
  /** Top of the mast nut above the hub centre (body y): the overall height (skids to hub top) ends here. */
  mastTop: RC.skids.points[0].y + G.height - RC.rotor.hub.y,
  /** Blade tips at rest (all tip structural points share this height). */
  restTipY: G.structuralPoints.find((p) => p.name === 'rotorTipLeft')?.y ?? 1.2,
  /** Where the blade's aerofoil starts (inboard of this: the grip). */
  bladeRoot: 0.62,
} as const;

export const TAIL_ROTOR = {
  hub: RC.tailRotor.position,
  radius: RC.tailRotor.radius,
  chord: RC.tailRotor.chord,
  axis: RC.tailRotor.axis,
  gearRatio: RC.tailRotor.gearRatio,
  bladeRoot: 0.15,
} as const;

/** Lowest point of the skids (unloaded) and the tube radius. */
export const SKID = {
  y: RC.skids.points[0].y,
  tube: G.mainWheelRadius,
  track: Math.abs(RC.skids.points[0].x),
  zFront: Math.min(...RC.skids.points.map((p) => p.z)),
  zRear: Math.max(...RC.skids.points.map((p) => p.z)),
  /** Cross tubes (z stations). */
  crossFront: -1.02,
  crossRear: 0.74,
  /** Toe starts curling up here; the aft end of the tube. */
  toeZ: -1.5,
  tailZ: 1.62,
} as const;

export const STAB = G.horizontalTail;
export const FIN_TOP = G.verticalTailTop;
export const TAIL_BUMPER = G.structuralPoints.find((p) => p.name === 'tailBumper')!;
/** The airframe's aft-most point (the upper fin's tip trailing edge): nose tip + fuselage length. */
export const Z_TAIL_END = Z_TIP + G.length;
