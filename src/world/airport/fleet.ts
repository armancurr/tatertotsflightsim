/**
 * Extra airport vehicles and aircraft (static, merged into one mesh drawn with
 * createVehicleMaterial: vertex colour + aRM roughness/metalness, aAccent = 0):
 *
 * - `kingair`    Beechcraft King Air 350-class twin turboprop (T-tail, winglets, 4-blade props)
 * - `helicopter` Robinson R44-class light helicopter (glass bubble, skids, 2-blade rotor)
 * - `arff`       ARFF crash tender (Oshkosh Striker 6×6-class, roof + bumper turrets)
 * - `fueltruck`  aviation refueler (Jet A or 100LL band, hose cabinet, ladder)
 * - `tug`        aircraft tow tractor with its tow bar
 * - `baggage`    baggage tractor towing two carts with bags
 * - `pickup`     airport ops pickup (amber light bar, checkered flag)
 *
 * Local frame: ground at y = 0 (tyre / skid contact), −Z = the nose / front,
 * +X = right. Every model is centred on its overall box in X/Z
 * (EXTRA_VEHICLE_SIZE). PURE geometry (MeshBuilder), no textures.
 */
import * as THREE from 'three';
import { MeshBuilder, type V3 } from './builder';
import { nacaRing } from '../../aircraft/airfoil';

export type ExtraVehicle = 'kingair' | 'helicopter' | 'arff' | 'fueltruck' | 'tug' | 'baggage' | 'pickup';

export const EXTRA_VEHICLE_KINDS: readonly ExtraVehicle[] = ['kingair', 'helicopter', 'arff', 'fueltruck', 'tug', 'baggage', 'pickup'];

/** Number of paint schemes per kind (`variant` is taken modulo this). */
export const EXTRA_VEHICLE_VARIANTS: Record<ExtraVehicle, number> = { kingair: 3, helicopter: 2, arff: 2, fueltruck: 2, tug: 2, baggage: 2, pickup: 2 };

/** Overall box (m), centred on the local origin in X/Z, from the ground up. */
export const EXTRA_VEHICLE_SIZE: Record<ExtraVehicle, { length: number; width: number; height: number }> = {
  kingair: { length: 14.25, width: 17.87, height: 4.27 },
  helicopter: { length: 11.95, width: 2.26, height: 3.26 },
  arff: { length: 12.65, width: 3.5, height: 3.81 },
  fueltruck: { length: 9.16, width: 2.75, height: 3.21 },
  tug: { length: 5.46, width: 1.7, height: 2.05 },
  baggage: { length: 9.62, width: 1.44, height: 2.05 },
  pickup: { length: 5.55, width: 1.94, height: 2.95 },
};

// ─── brushes ───────────────────────────────────────────────────────────────

interface Brush {
  color: number;
  rough: number;
  metal: number;
}
const paint = (color: number, rough = 0.32, metal = 0.1): Brush => ({ color, rough, metal });
const GLASS: Brush = { color: 0x0e1419, rough: 0.05, metal: 0.9 };
const RUBBER: Brush = { color: 0x151515, rough: 0.9, metal: 0 };
const DARK: Brush = { color: 0x1e2022, rough: 0.7, metal: 0.2 };
const STEEL: Brush = { color: 0xa9adb0, rough: 0.35, metal: 0.85 };
const ALU: Brush = { color: 0xc3c7ca, rough: 0.3, metal: 0.8 };
const CHOCK: Brush = { color: 0xe0b020, rough: 0.8, metal: 0 };
const put = (b: MeshBuilder, br: Brush) => b.set({ color: br.color, rough: br.rough, metal: br.metal, accent: 0, part: 0, mat: 0 });

// ─── helpers ───────────────────────────────────────────────────────────────

/** Piecewise table with smoothstep blending between the points (like vehicles.ts). */
function table(pts: [number, number][]): (z: number) => number {
  return (z: number) => {
    if (z <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++)
      if (z <= pts[i][0]) {
        const t = (z - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0]);
        const s = t * t * (3 - 2 * t);
        return pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * s;
      }
    return pts[pts.length - 1][1];
  };
}

const spow = (v: number, p: number) => Math.sign(v) * Math.pow(Math.abs(v), p);

interface Section {
  cy: (z: number) => number;
  hw: (z: number) => number;
  hh: (z: number) => number;
  /** Superellipse exponent (2 = ellipse, larger = boxier). */
  e: number;
}

/** Point on a body section at angle th (0 = +X right, π/2 = top), pushed out by `off`. */
function surf(s: Section, z: number, th: number, off = 0): V3 {
  const hw = s.hw(z) + off;
  const hh = s.hh(z) + off;
  return [hw * spow(Math.cos(th), 2 / s.e), s.cy(z) + hh * spow(Math.sin(th), 2 / s.e), z];
}

/**
 * Loft over a grid of rings with a brush per quad (duplicated vertices, smooth grid normals) —
 * lets one smooth body carry glass, paint and stripes without separate shells.
 */
function gridLoft(b: MeshBuilder, rings: V3[][], closed: boolean, pick: (i: number, k: number) => Brush) {
  const R = rings.length;
  const K = rings[0].length;
  const at = (i: number, k: number) => rings[Math.max(0, Math.min(R - 1, i))][closed ? ((k % K) + K) % K : Math.max(0, Math.min(K - 1, k))];
  const nrm: V3[][] = [];
  for (let i = 0; i < R; i++) {
    let cx = 0, cy = 0, cz = 0;
    for (const q of rings[i]) {
      cx += q[0] / K;
      cy += q[1] / K;
      cz += q[2] / K;
    }
    const row: V3[] = [];
    for (let k = 0; k < K; k++) {
      const p = rings[i][k];
      const a = at(i + 1, k), bb = at(i - 1, k), c = at(i, k + 1), d = at(i, k - 1);
      const tx = a[0] - bb[0], ty = a[1] - bb[1], tz = a[2] - bb[2];
      const sx = c[0] - d[0], sy = c[1] - d[1], sz = c[2] - d[2];
      let nx = ty * sz - tz * sy, ny = tz * sx - tx * sz, nz = tx * sy - ty * sx;
      if (nx * (p[0] - cx) + ny * (p[1] - cy) + nz * (p[2] - cz) < 0) (nx = -nx), (ny = -ny), (nz = -nz);
      const l = Math.hypot(nx, ny, nz);
      row.push(l > 1e-9 ? [nx / l, ny / l, nz / l] : [p[0] - cx || 0, p[1] - cy || 1, p[2] - cz || 0]);
    }
    nrm.push(row.map((n) => {
      const l = Math.hypot(n[0], n[1], n[2]) || 1;
      return [n[0] / l, n[1] / l, n[2] / l] as V3;
    }));
  }
  const kk = closed ? K : K - 1;
  for (let i = 0; i < R - 1; i++)
    for (let k = 0; k < kk; k++) {
      const k1 = (k + 1) % K;
      put(b, pick(i, k));
      const ids = ([[i, k], [i, k1], [i + 1, k1], [i + 1, k]] as const).map(([ii, kx]) => {
        const p = rings[ii][kx];
        const n = nrm[ii][kx];
        return b.v(p[0], p[1], p[2], n[0], n[1], n[2]);
      });
      b.quad(ids[0], ids[1], ids[2], ids[3]);
    }
}

/** Body lofted through `zs` with K points per ring (k = 0 at th = −π/2, the bottom). */
function bodyRings(s: Section, zs: number[], K: number): V3[][] {
  return zs.map((z) => {
    const ring: V3[] = [];
    for (let k = 0; k < K; k++) ring.push(surf(s, z, -Math.PI / 2 + (k / K) * Math.PI * 2));
    return ring;
  });
}
const thOf = (k: number, K: number) => -Math.PI / 2 + ((k + 0.5) / K) * Math.PI * 2;

/** An elliptical window (or panel) lying on the body surface around (zc, thc). */
function surfEllipse(b: MeshBuilder, s: Section, zc: number, thc: number, rz: number, rth: number, off = 0.012, n = 12) {
  const c = surf(s, zc, thc, off);
  const nc = normalOf(s, zc, thc);
  const ci = b.v(c[0], c[1], c[2], nc[0], nc[1], nc[2]);
  const ring: number[] = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    // superellipse-ish rounded rectangle
    const z = zc + rz * spow(Math.cos(a), 0.6);
    const th = thc + rth * spow(Math.sin(a), 0.6);
    const p = surf(s, z, th, off);
    const nn = normalOf(s, z, th);
    ring.push(b.v(p[0], p[1], p[2], nn[0], nn[1], nn[2]));
  }
  for (let k = 0; k < n; k++) b.tri(ci, ring[k], ring[(k + 1) % n]);
}

/** A patch of the body surface (z0..z1 × th0..th1), pushed out by `off`. */
function surfPatch(b: MeshBuilder, s: Section, z0: number, z1: number, th0: number, th1: number, nz: number, nt: number, off = 0.01) {
  const ids: number[][] = [];
  for (let i = 0; i <= nz; i++) {
    const row: number[] = [];
    for (let j = 0; j <= nt; j++) {
      const z = z0 + ((z1 - z0) * i) / nz;
      const th = th0 + ((th1 - th0) * j) / nt;
      const p = surf(s, z, th, off);
      const n = normalOf(s, z, th);
      row.push(b.v(p[0], p[1], p[2], n[0], n[1], n[2]));
    }
    ids.push(row);
  }
  for (let i = 0; i < nz; i++) for (let j = 0; j < nt; j++) b.quad(ids[i][j], ids[i + 1][j], ids[i + 1][j + 1], ids[i][j + 1]);
}

function normalOf(s: Section, z: number, th: number): V3 {
  const e = 1e-3;
  const p = surf(s, z, th);
  const pz = surf(s, z + e, th);
  const pt = surf(s, z, th + e);
  const tz: V3 = [pz[0] - p[0], pz[1] - p[1], pz[2] - p[2]];
  const tt: V3 = [pt[0] - p[0], pt[1] - p[1], pt[2] - p[2]];
  let nx = tt[1] * tz[2] - tt[2] * tz[1];
  let ny = tt[2] * tz[0] - tt[0] * tz[2];
  let nz = tt[0] * tz[1] - tt[1] * tz[0];
  // outward: away from the section centre
  if (nx * p[0] + ny * (p[1] - s.cy(z)) < 0) (nx = -nx), (ny = -ny), (nz = -nz);
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

/** Wheel: tyre + hub, axle along X, centred on x (the tyre spans x ± w/2). */
function wheel(b: MeshBuilder, x: number, y: number, z: number, r: number, w: number, hub: Brush = STEEL, seg = 14) {
  b.push(new THREE.Matrix4().makeRotationZ(Math.PI / 2).setPosition(x + w / 2, y, z));
  put(b, RUBBER);
  b.lathe([[r * 0.66, 0], [r * 0.92, 0.004], [r, w * 0.14], [r, w * 0.86], [r * 0.92, w - 0.004], [r * 0.66, w]], seg, 0, 0, false);
  put(b, hub);
  b.lathe([[r * 0.66, 0], [r * 0.5, 0.02], [r * 0.18, 0.05], [0, 0.055]], seg - 4);
  b.lathe([[r * 0.66, w], [r * 0.5, w - 0.02], [r * 0.18, w - 0.05], [0, w - 0.055]], seg - 4);
  b.pop();
}
const wheelC = wheel;

/** Flat quad from four points with a normal (both sides if `twoSided`). */
function quad(b: MeshBuilder, pts: V3[], n: V3, twoSided = false) {
  b.poly(pts, n);
  if (twoSided) b.poly([...pts].reverse().map((p) => [p[0] - n[0] * 0.002, p[1] - n[1] * 0.002, p[2] - n[2] * 0.002] as V3), [-n[0], -n[1], -n[2]]);
}

/** Airfoil panel lofted through span stations; `place(c, a, s)` → point for chord c ∈ [0,1], thickness a, station s. */
function airfoilPanel(b: MeshBuilder, ring: number[], spans: number[], place: (c: number, a: number, s: number) => V3, capTip = true) {
  const rings: V3[][] = [];
  for (const s of spans) {
    const r: V3[] = [];
    for (let i = 0; i < ring.length; i += 2) r.push(place(ring[i], ring[i + 1], s));
    rings.push(r);
  }
  b.loft(rings, true);
  if (capTip) {
    const last = rings[rings.length - 1];
    const prev = rings[rings.length - 2];
    const c = last.reduce<[number, number, number]>((acc, p) => [acc[0] + p[0] / last.length, acc[1] + p[1] / last.length, acc[2] + p[2] / last.length], [0, 0, 0]);
    const pc = prev.reduce<[number, number, number]>((acc, p) => [acc[0] + p[0] / prev.length, acc[1] + p[1] / prev.length, acc[2] + p[2] / prev.length], [0, 0, 0]);
    const n: V3 = [c[0] - pc[0], c[1] - pc[1], c[2] - pc[2]];
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    b.capRing(last, c, [n[0] / l, n[1] / l, n[2] / l]);
  }
}

/** Box from min/max corners with a brush. */
function boxB(b: MeshBuilder, br: Brush, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, skip = '') {
  put(b, br);
  b.box(Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1), Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1), skip);
}

/** Extrude a convex side profile [z, y] across x ∈ [x0, x1] (a cab / body silhouette). */
function sideProfile(b: MeshBuilder, br: Brush, profile: [number, number][], x0: number, x1: number) {
  put(b, br);
  // local frame: X' = −z_world… we want profile (z, y) extruded along world X:
  // rotation about Y by +90° maps local +X → world −Z and local +Z → world +X.
  b.push(new THREE.Matrix4().makeRotationY(Math.PI / 2));
  b.prismZ(profile.map(([z, y]) => [-z, y] as [number, number]), x0, x1, { caps: true });
  b.pop();
}

/** Yellow wheel chocks either side of a tyre at (x, z) of radius r. */
function chocks(b: MeshBuilder, x: number, z: number, r: number, w = 0.2) {
  put(b, CHOCK);
  for (const dz of [-1, 1]) {
    b.push(new THREE.Matrix4().makeRotationY(Math.PI / 2).setPosition(x, 0, z + dz * (r * 0.72 + 0.1)));
    b.prismZ([[-0.1 * dz, 0], [0.1 * dz, 0], [0.02 * dz, 0.11]], -w / 2, w / 2);
    b.pop();
  }
}

/** Propeller: n blades of radius `radius` around a hub at `hub`, disc in the XY plane, spinner toward −Z. */
function prop(b: MeshBuilder, hub: V3, n: number, radius: number, chord: number, spinR: number, spinLen: number, phase: number, tip: Brush) {
  b.push(new THREE.Matrix4().makeRotationX(-Math.PI / 2).setPosition(hub[0], hub[1], hub[2]));
  put(b, paint(0xd9d9d4, 0.3, 0.2));
  b.lathe([[spinR, -0.05], [spinR * 0.98, 0.06], [spinR * 0.82, spinLen * 0.45], [spinR * 0.5, spinLen * 0.78], [spinR * 0.15, spinLen * 0.97], [0, spinLen]], 14);
  b.pop();
  for (let i = 0; i < n; i++) {
    const phi = phase + (i / n) * Math.PI * 2;
    const ux = Math.cos(phi), uy = Math.sin(phi);
    const vx = -uy, vy = ux;
    const stations = [0.1, 0.3, 0.6, 0.85, 0.9, 1.0];
    const rings: V3[][] = [];
    for (const f of stations) {
      const r = radius * f;
      const ch = chord * (f < 0.3 ? 0.75 : 1 - 0.35 * (f - 0.3)) * (f > 0.97 ? 0.6 : 1);
      const th = chord * (0.18 - 0.12 * f);
      const beta = (40 - 25 * f) * (Math.PI / 180);
      const ring: V3[] = [];
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const cc = (Math.cos(a) * ch) / 2;
        const tt = (Math.sin(a) * th) / 2;
        const cx = vx * Math.cos(beta), cy = vy * Math.cos(beta), cz = -Math.sin(beta);
        const tx = vx * Math.sin(beta), ty = vy * Math.sin(beta), tz = Math.cos(beta);
        ring.push([hub[0] + ux * r + cx * cc + tx * tt, hub[1] + uy * r + cy * cc + ty * tt, hub[2] + 0.05 + cz * cc + tz * tt]);
      }
      rings.push(ring);
    }
    put(b, paint(0x1a1a1a, 0.55, 0.2));
    b.loft(rings.slice(0, 5), true);
    put(b, tip);
    b.loft(rings.slice(4), true);
    const last = rings[5];
    const c = last.reduce<[number, number, number]>((acc, p) => [acc[0] + p[0] / 8, acc[1] + p[1] / 8, acc[2] + p[2] / 8], [0, 0, 0]);
    b.capRing(last, c, [ux, uy, 0]);
  }
}

// ─── King Air 350 ─────────────────────────────────────────────────────────

const KA_LIVERIES: { stripe: number; pin: number; tail: number }[] = [
  { stripe: 0x1d3263, pin: 0xb58a2a, tail: 0x1d3263 },
  { stripe: 0x5b1a22, pin: 0x9aa0a4, tail: 0x5b1a22 },
  { stripe: 0x202020, pin: 0xc4561e, tail: 0x202020 },
];

const KA: Section = {
  cy: table([[-7.1, 1.5], [-6.4, 1.5], [-5.0, 1.63], [-3.8, 1.78], [2.2, 1.8], [4.0, 2.1], [6.3, 2.55]]),
  hw: table([[-7.1, 0.03], [-6.85, 0.24], [-6.2, 0.44], [-5.3, 0.62], [-4.3, 0.74], [-3.5, 0.77], [2.2, 0.77], [3.6, 0.62], [5.0, 0.38], [6.3, 0.1]]),
  hh: table([[-7.1, 0.03], [-6.85, 0.22], [-6.2, 0.4], [-5.3, 0.6], [-4.3, 0.79], [-3.5, 0.84], [2.2, 0.84], [3.6, 0.68], [5.0, 0.42], [6.3, 0.12]]),
  e: 2.3,
};

function kingAir(b: MeshBuilder, variant: number) {
  const liv = KA_LIVERIES[variant % KA_LIVERIES.length];
  const WHITE = paint(0xf0f0ec, 0.3, 0.05);
  // ── fuselage (with the cheatline and pinstripe painted into the loft) ──
  const zs: number[] = [];
  for (let i = 0; i <= 8; i++) zs.push(-7.1 + (2.6 * (1 - Math.cos((i / 8) * Math.PI * 0.5))));
  for (let z = -4.3; z < 2.3; z += 0.55) zs.push(z);
  for (let i = 0; i <= 10; i++) zs.push(2.3 + (4.0 * i) / 10);
  const K = 32;
  const rings = bodyRings(KA, zs, K);
  const deg = Math.PI / 180;
  gridLoft(b, rings, true, (i, k) => {
    const th = thOf(k, K);
    const el = Math.asin(Math.max(-1, Math.min(1, Math.sin(th)))) / deg; // elevation angle −90..90
    const z = (zs[i] + zs[i + 1]) / 2;
    if (el < -55 && z > -5 && z < 3) return paint(0xd7d9da, 0.35, 0.1); // belly
    return WHITE;
  });
  b.capRing(rings[rings.length - 1], [0, KA.cy(6.3), 6.34], [0, 0, 1]);
  // cheatline + pinstripe (both sides), following the fuselage curvature
  for (const [e0, e1, br] of [[-15, -7, paint(liv.stripe, 0.28, 0.1)], [-19, -17.2, paint(liv.pin, 0.28, 0.3)]] as const) {
    put(b, br);
    surfPatch(b, KA, -6.45, 5.7, e0 * deg, e1 * deg, 44, 1, 0.006);
    surfPatch(b, KA, -6.45, 5.7, (180 - e1) * deg, (180 - e0) * deg, 44, 1, 0.006);
  }
  // windshield (two panes), cockpit side windows, cabin windows
  put(b, GLASS);
  surfPatch(b, KA, -5.05, -4.2, 36 * deg, 87 * deg, 4, 4, 0.012);
  surfPatch(b, KA, -5.05, -4.2, 93 * deg, 144 * deg, 4, 4, 0.012);
  for (const [a0, a1] of [[14 * deg, 40 * deg], [140 * deg, 166 * deg]]) surfPatch(b, KA, -4.15, -3.55, a0, a1, 3, 3, 0.012);
  for (let i = 0; i < 7; i++) {
    const z = -2.75 + i * 0.72;
    if (i === 6) continue; // airstair door on the left, emergency exit on the right: skip one
    surfEllipse(b, KA, z, 14 * deg, 0.19, 0.16, 0.012, 12);
    surfEllipse(b, KA, z, (180 - 14) * deg, 0.19, 0.16, 0.012, 12);
  }
  // airstair door outline (left side, behind the wing)
  put(b, paint(0x9aa0a4, 0.4, 0.1));
  surfPatch(b, KA, 1.55, 1.6, 150 * deg, 205 * deg, 1, 4, 0.008);
  surfPatch(b, KA, 2.35, 2.4, 150 * deg, 205 * deg, 1, 4, 0.008);
  // radome seam + nose (dark grey tip)
  put(b, paint(0x6d7174, 0.4, 0.1));
  surfPatch(b, KA, -7.1, -6.95, -Math.PI, Math.PI, 1, 16, 0.004);

  // ── wing (low, 6° dihedral, tapered outer panels) with winglets ──
  const af = nacaRing({ m: 0.02, p: 0.4, t: 0.16, n: 9 });
  const dih = Math.tan(6 * deg);
  const rootY = 1.12;
  const chord = table([[0, 2.35], [2.9, 2.25], [8.82, 1.05]]);
  const le = table([[0, -1.3], [2.9, -1.26], [8.82, -0.58]]);
  const thick = table([[0, 1], [2.9, 0.95], [8.82, 0.7]]);
  for (const side of [-1, 1]) {
    put(b, WHITE);
    airfoilPanel(b, af, [0, 0.8, 1.9, 2.9, 4.6, 6.5, 8.2, 8.82], (c, a, s) => [side * s, rootY + s * dih + chord(s) * a * thick(s), le(s) + chord(s) * c]);
    // winglet
    const ty = rootY + 8.82 * dih;
    const wl = nacaRing({ m: 0, p: 0, t: 0.1, n: 7 });
    put(b, paint(liv.tail, 0.3, 0.1));
    airfoilPanel(b, wl, [0, 1], (c, a, h) => {
      const hh = h * 0.62;
      const ch = 0.95 - 0.45 * h;
      const l0 = -0.52 + 0.45 * h;
      return [side * (8.8 + 0.18 * hh + a * ch), ty + hh + 0.02, l0 + c * ch];
    });
    // nav light
    put(b, paint(side < 0 ? 0xc01010 : 0x10b030, 0.2, 0.1));
    b.boxC(side * 8.82, ty + 0.06, le(8.82) + 0.12, 0.05, 0.06, 0.12);
  }

  // ── nacelles + props + main gear ──
  const NAC: Section = {
    cy: table([[-3.8, 1.46], [-3.2, 1.38], [-1.5, 1.3], [0.3, 1.36], [1.9, 1.58]]),
    hw: table([[-3.8, 0.3], [-3.35, 0.44], [-2.2, 0.47], [0.2, 0.44], [1.3, 0.26], [1.95, 0.05]]),
    hh: table([[-3.8, 0.3], [-3.35, 0.5], [-2.2, 0.62], [0.2, 0.62], [1.3, 0.34], [1.95, 0.05]]),
    e: 2.2,
  };
  const nz: number[] = [];
  for (let i = 0; i <= 14; i++) nz.push(-3.8 + (5.75 * i) / 14);
  for (const side of [-1, 1]) {
    const xN = side * 2.6;
    b.pushTR(xN, 0, 0, 0);
    const nr = bodyRings(NAC, nz, 18);
    gridLoft(b, nr, true, (i, k) => {
      const th = thOf(k, 18);
      if (Math.sin(th) > 0.15 && nz[i] < -2.6 && nz[i] > -3.4) return paint(liv.stripe, 0.3, 0.1);
      return WHITE;
    });
    b.capRing(nr[nr.length - 1], [0, NAC.cy(1.95), 1.97], [0, 0, 1]);
    // chin inlet and exhaust stacks
    put(b, paint(0x0d0d0d, 0.9, 0));
    surfEllipse(b, NAC, -3.36, -Math.PI / 2, 0.08, 0.5, 0.01, 10);
    put(b, paint(0x55504a, 0.5, 0.7));
    for (const sx of [-1, 1]) {
      const p = surf(NAC, -2.45, sx > 0 ? 0 : Math.PI, 0);
      b.tube([p[0], p[1], p[2]], [p[0] + sx * 0.2, p[1] - 0.02, p[2] + 0.35], 0.09, 0.08, 8, true);
    }
    // main gear: strut + twin wheels
    put(b, paint(0xbfc2c4, 0.35, 0.7));
    b.tube([0, 0.95, -0.35], [0, 0.36, -0.3], 0.07, 0.06, 8);
    b.tube([-0.25, 0.34, -0.3], [0.25, 0.34, -0.3], 0.045, 0.045, 6);
    for (const wx of [-0.2, 0.2]) wheelC(b, wx, 0.34, -0.3, 0.34, 0.17, STEEL, 12);
    chocks(b, 0, -0.3, 0.34, 0.65);
    // gear doors (open, hanging)
    put(b, WHITE);
    for (const dx of [-1, 1]) b.boxC(dx * 0.4, 0.78, -0.2, 0.02, 0.36, 1.0);
    b.pop();
    prop(b, [xN, 1.46, -3.86], 4, 1.33, 0.24, 0.24, 0.5, side > 0 ? 0.35 : 0.9, paint(0xe8c020, 0.45, 0.1));
  }

  // ── nose gear ──
  put(b, paint(0xbfc2c4, 0.35, 0.7));
  b.tube([0, 1.05, -5.25], [0, 0.26, -5.35], 0.055, 0.05, 8);
  wheelC(b, 0, 0.24, -5.35, 0.24, 0.15, STEEL, 12);
  chocks(b, 0, -5.35, 0.24, 0.35);

  // ── T-tail: swept fin, dorsal fillet, stabilizer on top, ventral strakes ──
  const sym = nacaRing({ m: 0, p: 0, t: 0.12, n: 8 });
  const finSt = [
    { y: 2.3, le: 3.35, te: 6.25 },
    { y: 3.2, le: 4.4, te: 6.5 },
    { y: 4.15, le: 5.35, te: 6.85 },
  ];
  put(b, paint(liv.tail, 0.3, 0.1));
  airfoilPanel(b, sym, [0, 1, 2], (c, a, i) => {
    const s = finSt[i];
    const ch = s.te - s.le;
    return [a * ch, s.y, s.le + c * ch];
  });
  sideProfile(b, paint(liv.tail, 0.3, 0.1), [[1.9, 2.6], [4.2, 2.6], [4.2, 3.12]], -0.06, 0.06);
  const stab = nacaRing({ m: 0, p: 0, t: 0.1, n: 8 });
  for (const side of [-1, 1]) {
    put(b, WHITE);
    airfoilPanel(b, stab, [0, 1.2, 2.82], (c, a, s) => {
      const f = s / 2.82;
      const l0 = 5.45 + 0.85 * f;
      const ch = 1.62 - 0.77 * f;
      return [side * s, 4.2 + a * ch * 0.9, l0 + c * ch];
    });
  }
  put(b, paint(0xd0d2d3, 0.4, 0.1));
  for (const sx of [-1, 1]) {
    b.push(new THREE.Matrix4().makeRotationZ(sx * 0.6).setPosition(sx * 0.18, 1.7, 0));
    b.boxC(0, -0.12, 4.4, 0.03, 0.3, 1.1);
    b.pop();
  }
}

// ─── Robinson R44 ─────────────────────────────────────────────────────────

const R44: Section = {
  cy: table([[-2.45, 1.22], [-2.0, 1.26], [-1.2, 1.35], [0.0, 1.36], [0.7, 1.42], [1.4, 1.52], [6.1, 1.72]]),
  hw: table([[-2.45, 0.02], [-2.28, 0.33], [-1.8, 0.56], [-1.1, 0.64], [-0.25, 0.64], [0.45, 0.52], [1.15, 0.24], [1.6, 0.16], [3.5, 0.12], [6.1, 0.065]]),
  hh: table([[-2.45, 0.02], [-2.28, 0.37], [-1.8, 0.62], [-1.1, 0.73], [-0.25, 0.73], [0.45, 0.6], [1.15, 0.28], [1.6, 0.17], [3.5, 0.12], [6.1, 0.065]]),
  e: 2.1,
};

function helicopter(b: MeshBuilder, variant: number) {
  const body = [0xb8161b, 0x1f3f7a][variant % 2];
  const BODY = paint(body, 0.28, 0.15);
  const WHITE = paint(0xf0f0ec, 0.3, 0.05);
  const deg = Math.PI / 180;
  b.pushTR(0, 0, -0.935, 0); // centre the overall box (mast at z = −0.935)
  // ── cabin + tail boom: one smooth loft, glass bubble painted in ──
  const zs: number[] = [];
  for (let i = 0; i <= 10; i++) zs.push(-2.45 + 1.4 * (1 - Math.cos((i / 10) * Math.PI * 0.5)));
  for (let z = -0.95; z < 1.6; z += 0.3) zs.push(z);
  for (let i = 0; i <= 8; i++) zs.push(1.6 + (4.5 * i) / 8);
  const K = 28;
  const rings = bodyRings(R44, zs, K);
  gridLoft(b, rings, true, (i, k) => {
    const th = thOf(k, K);
    const z = (zs[i] + zs[i + 1]) / 2;
    const s = Math.sin(th);
    const c = Math.abs(Math.cos(th));
    if (z < 1.25) {
      const post = z > -0.95 && z < -0.8 && c > 0.55; // door post
      if (!post && ((z < -0.35 && s > -0.18) || (z < -1.75 && s > -0.62) || (z < 0.35 && z > -0.8 && s > -0.25 && s < 0.45 && c > 0.6))) return GLASS;
      if (s > 0.5 && z >= -0.35) return WHITE; // cabin roof
      return BODY;
    }
    if (s > -0.25 && s < 0.12 && c > 0.5) return BODY; // boom stripe
    return WHITE;
  });
  b.capRing(rings[rings.length - 1], [0, R44.cy(6.1), 6.12], [0, 0, 1]);
  // engine bay under the transmission (dark), transmission cowl, mast, swashplate
  boxB(b, DARK, -0.4, 0.78, 0.35, 0.4, 1.45, 1.35);
  put(b, paint(0x6b6f72, 0.5, 0.6));
  b.tube([0.2, 0.95, 1.2], [0.28, 0.85, 1.75], 0.07, 0.06, 8, true);
  put(b, WHITE);
  const cowl: Section = {
    cy: table([[-0.55, 2.05], [0.0, 2.2], [1.25, 2.02]]),
    hw: table([[-0.55, 0.12], [-0.2, 0.36], [0.7, 0.34], [1.25, 0.1]]),
    hh: table([[-0.55, 0.05], [-0.2, 0.25], [0.7, 0.22], [1.25, 0.06]]),
    e: 2.6,
  };
  const cz: number[] = [];
  for (let i = 0; i <= 8; i++) cz.push(-0.55 + (1.8 * i) / 8);
  const cr = bodyRings(cowl, cz, 16);
  b.loft(cr, true);
  b.capRing(cr[0], [0, 2.05, -0.56], [0, 0, -1]);
  b.capRing(cr[cr.length - 1], [0, 2.02, 1.26], [0, 0, 1]);
  put(b, paint(0x55595c, 0.4, 0.8));
  b.cylinder(0, 2.35, 0, 0.07, 0.85, 10);
  b.cylinder(0, 2.55, 0, 0.16, 0.07, 12);
  put(b, paint(0x2a2c2e, 0.5, 0.6));
  b.boxC(0, 3.2, 0, 0.34, 0.12, 0.2);
  // ── main rotor: 2 blades fore/aft with droop ──
  const R = 5.03;
  for (const dir of [-1, 1]) {
    const rings2: V3[][] = [];
    const st = [0.06, 0.15, 0.5, 0.9, 1.0];
    for (const f of st) {
      const r = R * f;
      const ch = f < 0.12 ? 0.12 : 0.25;
      const th = f < 0.12 ? 0.06 : 0.028;
      const y = 3.22 - 0.28 * f * f;
      const ring: V3[] = [];
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        ring.push([(Math.cos(a) * ch) / 2 * dir, y + (Math.sin(a) * th) / 2, dir * r]);
      }
      rings2.push(ring);
    }
    put(b, paint(0x3a3c3e, 0.5, 0.5));
    b.loft(rings2.slice(0, 2), true);
    put(b, paint(0xcfd0cc, 0.4, 0.3));
    b.loft(rings2.slice(1, 4), true);
    put(b, paint(0xe8c020, 0.5, 0.1));
    b.loft(rings2.slice(3), true);
    const last = rings2[rings2.length - 1];
    const c = last.reduce<[number, number, number]>((acc, p) => [acc[0] + p[0] / 8, acc[1] + p[1] / 8, acc[2] + p[2] / 8], [0, 0, 0]);
    b.capRing(last, c, [0, 0, dir]);
  }
  // ── tail: upper + lower fin, small stabilizer, tail rotor with guard ──
  const sym = nacaRing({ m: 0, p: 0, t: 0.12, n: 7 });
  put(b, BODY);
  airfoilPanel(b, sym, [0, 1], (c, a, i) => {
    const y = i === 0 ? 1.72 : 2.5;
    const l0 = i === 0 ? 5.55 : 6.02;
    const ch = i === 0 ? 0.62 : 0.34;
    return [a * ch, y, l0 + c * ch];
  });
  airfoilPanel(b, sym, [0, 1], (c, a, i) => {
    const y = i === 0 ? 1.7 : 1.18;
    const l0 = i === 0 ? 5.7 : 5.95;
    const ch = i === 0 ? 0.5 : 0.3;
    return [a * ch, y, l0 + c * ch];
  });
  put(b, WHITE);
  for (const sx of [-1, 1]) airfoilPanel(b, sym, [0, 0.62], (c, a, s) => [sx * s, 1.7 + a * 0.36, 5.28 + c * 0.36]);
  put(b, STEEL);
  b.tube([0, 1.2, 6.1], [0, 1.02, 6.55], 0.018, 0.018, 4);
  b.tube([0, 1.02, 6.55], [0, 1.6, 6.9], 0.018, 0.018, 4);
  const trHub: V3 = [-0.2, 1.88, 6.12];
  put(b, paint(0x55595c, 0.4, 0.8));
  b.tube([0, trHub[1], trHub[2]], trHub, 0.03, 0.03, 6, true);
  for (const s of [-1, 1]) {
    const tip: V3 = [trHub[0], trHub[1] + s * 0.73 * Math.cos(0.4), trHub[2] + s * 0.73 * Math.sin(0.4)];
    put(b, paint(0xd8d8d2, 0.4, 0.3));
    b.tube(trHub, tip, 0.035, 0.03, 4, true);
    put(b, paint(0xc01010, 0.4, 0.1));
    const t2: V3 = [tip[0], trHub[1] + s * 0.76 * Math.cos(0.4), trHub[2] + s * 0.76 * Math.sin(0.4)];
    b.tube(tip, t2, 0.03, 0.028, 4, true);
  }
  // ── skids + cross tubes ──
  put(b, paint(0xb8bcbf, 0.35, 0.7));
  for (const sx of [-1, 1]) {
    const x = sx * 1.09;
    b.tube([x, 0.05, -1.95], [x, 0.05, 1.25], 0.04, 0.04, 8, true);
    b.tube([x, 0.05, -1.95], [x, 0.18, -2.3], 0.04, 0.04, 8);
    b.tube([x, 0.18, -2.3], [x, 0.36, -2.42], 0.04, 0.035, 8, true);
    for (const z of [-1.05, 0.55]) {
      b.tube([x, 0.06, z], [sx * 1.0, 0.45, z], 0.035, 0.035, 6);
      b.tube([sx * 1.0, 0.45, z], [sx * 0.6, 0.66, z], 0.035, 0.035, 6);
    }
  }
  for (const z of [-1.05, 0.55]) b.tube([-0.6, 0.66, z], [0.6, 0.66, z], 0.035, 0.035, 6);
  // steps
  for (const sx of [-1, 1]) boxB(b, DARK, sx * 0.75, 0.42, -1.25, sx * 0.95, 0.45, -0.9);
  b.pop();
}

// ─── ARFF crash tender ────────────────────────────────────────────────────

function arff(b: MeshBuilder, variant: number) {
  const body = [0xc4d21a, 0xa51510][variant % 2];
  const BODY = paint(body, 0.3, 0.15);
  const WHITE = paint(0xeeeeea, 0.3, 0.1);
  const L0 = -6.15, L1 = 6.15;
  const W = 1.5;
  const wr = 0.62, ww = 0.5;
  const axles = [-3.9, 2.2, 3.75];
  // chassis, bumper, tow hooks
  boxB(b, DARK, -0.6, 0.5, L0 + 0.4, 0.6, 0.98, L1 - 0.3);
  boxB(b, paint(0x222426, 0.6, 0.4), -W, 0.62, L0 - 0.08, W, 0.98, L0 + 0.25);
  // wheels + arch flares
  for (const z of axles)
    for (const sx of [-1, 1]) {
      wheelC(b, sx * (W - ww / 2 - 0.02), wr, z, wr, ww, paint(0xd2d4d6, 0.4, 0.6), 16);
      boxB(b, paint(0x1c1d1e, 0.7, 0.1), sx * (W - 0.02), 1.26, z - 0.78, sx * (W + 0.03), 1.4, z + 0.78);
    }
  // lower body between the wheels (skirts)
  const gaps: [number, number][] = [[-3.1, 1.38], [4.58, L1]];
  for (const [z0, z1] of gaps) boxB(b, BODY, -W, 0.95, z0, W, 1.36, z1);
  // upper body with compartments
  boxB(b, BODY, -W, 1.36, -3.1, W, 3.1, L1);
  boxB(b, WHITE, -W - 0.01, 3.1, -3.1, W + 0.01, 3.2, L1 + 0.01);
  // reflective stripe and compartment roll-up doors
  put(b, paint(0xdedad0, 0.25, 0.2));
  for (const sx of [-1, 1]) quad(b, [[sx * (W + 0.012), 1.4, -3.05], [sx * (W + 0.012), 1.4, L1 - 0.05], [sx * (W + 0.012), 1.5, L1 - 0.05], [sx * (W + 0.012), 1.5, -3.05]], [sx, 0, 0]);
  const doors: [number, number][] = [[-2.95, -1.55], [-1.45, -0.05], [0.05, 1.35], [4.6, 6.0]];
  for (const sx of [-1, 1])
    for (const [z0, z1] of doors) {
      put(b, ALU);
      quad(b, [[sx * (W + 0.015), 1.6, z0], [sx * (W + 0.015), 1.6, z1], [sx * (W + 0.015), 2.95, z1], [sx * (W + 0.015), 2.95, z0]], [sx, 0, 0]);
      put(b, paint(0x6d7174, 0.4, 0.6));
      for (let y = 1.75; y < 2.9; y += 0.3) quad(b, [[sx * (W + 0.018), y, z0 + 0.04], [sx * (W + 0.018), y, z1 - 0.04], [sx * (W + 0.018), y + 0.02, z1 - 0.04], [sx * (W + 0.018), y + 0.02, z0 + 0.04]], [sx, 0, 0]);
      put(b, DARK);
      b.boxC(sx * (W + 0.03), 1.68, (z0 + z1) / 2, 0.04, 0.05, 0.5);
    }
  // cab: raked wrap-around windscreen
  const cab: [number, number][] = [[-3.1, 0.95], [L0, 0.95], [L0 - 0.02, 1.72], [-5.3, 3.33], [-3.1, 3.33]];
  sideProfile(b, BODY, cab, -W, W);
  boxB(b, WHITE, -W - 0.01, 3.33, -5.35, W + 0.01, 3.42, -3.05);
  // windscreen glass on the raked face
  const p0: [number, number] = [L0 + 0.06, 1.84];
  const p1: [number, number] = [-5.38, 3.2];
  const dz = p1[0] - p0[0], dy = p1[1] - p0[1];
  const l = Math.hypot(dz, dy);
  const n: V3 = [0, dz / l, -dy / l];
  const o = 0.012;
  put(b, GLASS);
  quad(b, [[-W + 0.1, p0[1] + n[1] * o, p0[0] + n[2] * o], [W - 0.1, p0[1] + n[1] * o, p0[0] + n[2] * o], [W - 0.1, p1[1] + n[1] * o, p1[0] + n[2] * o], [-W + 0.1, p1[1] + n[1] * o, p1[0] + n[2] * o]].map((q) => [q[0], q[1], q[2]] as V3), n);
  put(b, BODY);
  quad(b, [[-0.04, p0[1] + n[1] * 0.02, p0[0] + n[2] * 0.02], [0.04, p0[1] + n[1] * 0.02, p0[0] + n[2] * 0.02], [0.04, p1[1] + n[1] * 0.02, p1[0] + n[2] * 0.02], [-0.04, p1[1] + n[1] * 0.02, p1[0] + n[2] * 0.02]], n);
  // side windows and crew doors
  for (const sx of [-1, 1]) {
    put(b, GLASS);
    quad(b, [[sx * (W + 0.012), 1.95, -5.85], [sx * (W + 0.012), 1.95, -3.3], [sx * (W + 0.012), 3.15, -3.3], [sx * (W + 0.012), 3.15, -5.3]], [sx, 0, 0]);
    put(b, BODY);
    quad(b, [[sx * (W + 0.016), 1.95, -4.52], [sx * (W + 0.016), 1.95, -4.44], [sx * (W + 0.016), 3.15, -4.44], [sx * (W + 0.016), 3.15, -4.52]], [sx, 0, 0]);
    put(b, DARK);
    quad(b, [[sx * (W + 0.014), 0.98, -3.28], [sx * (W + 0.014), 0.98, -3.24], [sx * (W + 0.014), 3.18, -3.24], [sx * (W + 0.014), 3.18, -3.28]], [sx, 0, 0]);
    // mirror
    put(b, DARK);
    b.tube([sx * W, 2.6, -5.9], [sx * (W + 0.2), 2.7, -5.95], 0.02, 0.02, 4);
    b.boxC(sx * (W + 0.22), 2.55, -5.95, 0.06, 0.45, 0.25);
    // steps
    put(b, ALU);
    b.boxC(sx * (W - 0.05), 0.85, -4.7, 0.2, 0.05, 0.6);
  }
  // headlights, grille, bumper turret
  put(b, paint(0xf2f2ee, 0.1, 0.3));
  for (const sx of [-1, 1]) quad(b, [[sx * 1.35, 1.1, L0 - 0.03], [sx * 1.0, 1.1, L0 - 0.03], [sx * 1.0, 1.3, L0 - 0.03], [sx * 1.35, 1.3, L0 - 0.03]], [0, 0, -1]);
  put(b, DARK);
  quad(b, [[-0.7, 1.1, L0 - 0.025], [0.7, 1.1, L0 - 0.025], [0.7, 1.75, L0 - 0.025], [-0.7, 1.75, L0 - 0.025]], [0, 0, -1]);
  put(b, ALU);
  b.boxC(0, 0.72, L0 - 0.1, 0.3, 0.2, 0.25);
  b.tube([0, 0.74, L0 - 0.2], [0, 0.8, L0 - 0.25], 0.05, 0.035, 8, true);
  // roof turret on the cab
  put(b, ALU);
  b.cylinder(0, 3.42, -4.35, 0.3, 0.12, 12);
  b.tube([0, 3.54, -4.35], [0, 3.62, -4.35], 0.12, 0.12, 8, true);
  b.tube([0, 3.62, -4.35], [0, 3.72, -5.85], 0.075, 0.05, 8, true);
  put(b, DARK);
  b.tube([0, 3.72, -5.85], [0, 3.74, -6.05], 0.06, 0.07, 8, true);
  // light bar and beacons
  put(b, paint(0xd41410, 0.25, 0.2));
  b.boxC(0, 3.49, -5.1, 1.8, 0.14, 0.26);
  put(b, paint(0xf0f0f0, 0.2, 0.2));
  b.boxC(0, 3.49, -5.1, 0.4, 0.145, 0.265);
  put(b, paint(0xd41410, 0.25, 0.2));
  for (const sx of [-1, 1]) b.cylinder(sx * 1.25, 3.2, 5.9, 0.1, 0.18, 10);
  // roof rails + hose reel box + rear ladder
  put(b, ALU);
  for (const sx of [-1, 1]) {
    b.tube([sx * 1.4, 3.2, -2.9], [sx * 1.4, 3.5, -2.9], 0.025, 0.025, 4);
    b.tube([sx * 1.4, 3.2, 5.9], [sx * 1.4, 3.5, 5.9], 0.025, 0.025, 4);
    b.tube([sx * 1.4, 3.5, -2.9], [sx * 1.4, 3.5, 5.9], 0.025, 0.025, 4);
  }
  boxB(b, paint(0x9ca0a3, 0.4, 0.6), -0.8, 3.2, 1.0, 0.8, 3.5, 2.8);
  for (const sx of [-0.35, 0.35]) b.tube([sx, 0.95, L1 + 0.05], [sx, 3.2, L1 + 0.05], 0.025, 0.025, 4);
  for (let y = 1.2; y < 3.2; y += 0.3) b.tube([-0.35, y, L1 + 0.05], [0.35, y, L1 + 0.05], 0.02, 0.02, 4);
  // rear chevrons + tail lights
  for (let i = 0; i < 8; i++) {
    put(b, i % 2 ? paint(0xd41410, 0.3, 0.1) : paint(0xe8d020, 0.3, 0.1));
    const x0 = -W + (i * 2 * W) / 8, x1 = -W + ((i + 1) * 2 * W) / 8;
    quad(b, [[x1, 0.98, L1 + 0.012], [x0, 0.98, L1 + 0.012], [x0, 1.34, L1 + 0.012], [x1, 1.34, L1 + 0.012]], [0, 0, 1]);
  }
  put(b, paint(0x8a0a06, 0.2, 0.2));
  for (const sx of [-1, 1]) b.boxC(sx * 1.2, 1.6, L1 + 0.02, 0.25, 0.18, 0.04);
}

// ─── aviation refueler ─────────────────────────────────────────────────────

/** Block letters (3×5 cells) as rectangles [x0, y0, x1, y1]. */
const GLYPHS: Record<string, [number, number, number, number][]> = {
  J: [[2, 1, 3, 5], [0, 0, 3, 1], [0, 1, 1, 2]],
  E: [[0, 0, 1, 5], [1, 4, 3, 5], [1, 2, 2.5, 3], [1, 0, 3, 1]],
  T: [[0, 4, 3, 5], [1, 0, 2, 4]],
  A: [[0, 0, 1, 4], [2, 0, 3, 4], [0, 4, 3, 5], [1, 2, 2, 3]],
  '1': [[1, 0, 2, 5], [0, 3.6, 1, 4.6], [0, 0, 3, 0.8]],
  '0': [[0, 0, 1, 5], [2, 0, 3, 5], [1, 4, 2, 5], [1, 0, 2, 1]],
  L: [[0, 0, 1, 5], [1, 0, 3, 1]],
  ' ': [],
};

/** Block text on a vertical plane x = xPlane facing ±X (`sx`), centred on (yc, zc), letter height h. */
function blockText(b: MeshBuilder, text: string, sx: number, xPlane: number, yc: number, zc: number, h: number) {
  const u = h / 5;
  const adv = 4 * u;
  const total = text.length * adv - u;
  // reading direction: toward −Z on the right side (+X), toward +Z on the left side
  const dir = sx > 0 ? -1 : 1;
  let z0 = zc - (dir * total) / 2;
  for (const ch of text) {
    for (const [x0, y0, x1, y1] of GLYPHS[ch] ?? []) {
      const za = z0 + dir * x0 * u, zb = z0 + dir * x1 * u;
      const ya = yc - h / 2 + y0 * u, yb = yc - h / 2 + y1 * u;
      quad(b, [[xPlane, ya, za], [xPlane, ya, zb], [xPlane, yb, zb], [xPlane, yb, za]], [sx, 0, 0]);
    }
    z0 += dir * adv;
  }
}

function fuelTruck(b: MeshBuilder, variant: number) {
  const jet = variant % 2 === 0;
  const CAB = paint(jet ? 0xf0f0ec : 0x1f4f9a, 0.3, 0.15);
  const TANK = paint(0xeceae4, 0.3, 0.2);
  const BAND = paint(jet ? 0x151515 : 0xb31b14, 0.3, 0.1);
  const L0 = -4.5, L1 = 4.5;
  // chassis + wheels
  boxB(b, DARK, -0.5, 0.45, L0 + 0.3, 0.5, 0.82, L1 - 0.2);
  const wr = 0.5;
  for (const sx of [-1, 1]) {
    wheelC(b, sx * 1.0, wr, -3.25, wr, 0.3, STEEL, 14);
    for (const z of [2.3, 3.45]) wheelC(b, sx * 0.98, wr, z, wr, 0.5, STEEL, 14);
    // fenders
    boxB(b, DARK, sx * 0.72, 1.02, -3.85, sx * 1.2, 1.08, -2.65);
    boxB(b, DARK, sx * 0.7, 1.03, 1.65, sx * 1.25, 1.08, 4.1);
  }
  // hood + cab
  sideProfile(b, CAB, [[-3.0, 0.82], [L0, 0.82], [L0 - 0.02, 1.55], [-4.2, 1.78], [-3.0, 1.85]], -1.05, 1.05);
  sideProfile(b, CAB, [[-1.75, 0.82], [-3.02, 0.82], [-3.02, 1.95], [-2.85, 2.82], [-1.75, 2.85]], -1.2, 1.2);
  put(b, GLASS);
  quad(b, [[-1.1, 1.98, -3.03], [1.1, 1.98, -3.03], [1.08, 2.72, -2.89], [-1.08, 2.72, -2.89]], [0, 0.18, -0.98]);
  for (const sx of [-1, 1]) quad(b, [[sx * 1.212, 1.95, -2.9], [sx * 1.212, 1.95, -2.0], [sx * 1.212, 2.7, -2.0], [sx * 1.212, 2.7, -2.75]], [sx, 0, 0]);
  put(b, DARK);
  quad(b, [[-0.75, 0.95, L0 - 0.035], [0.75, 0.95, L0 - 0.035], [0.75, 1.45, L0 - 0.035], [-0.75, 1.45, L0 - 0.035]], [0, 0, -1]);
  boxB(b, paint(0x2a2c2e, 0.5, 0.5), -1.2, 0.55, L0 - 0.12, 1.2, 0.82, L0 + 0.05);
  put(b, paint(0xf2f2ee, 0.1, 0.3));
  for (const sx of [-1, 1]) quad(b, [[sx * 1.0, 1.2, L0 - 0.04], [sx * 0.8, 1.2, L0 - 0.04], [sx * 0.8, 1.38, L0 - 0.04], [sx * 1.0, 1.38, L0 - 0.04]], [0, 0, -1]);
  // amber beacon + mirrors
  put(b, paint(0xf0a010, 0.2, 0.2));
  b.cylinder(0, 2.85, -2.3, 0.1, 0.18, 10);
  put(b, DARK);
  for (const sx of [-1, 1]) b.boxC(sx * 1.35, 2.3, -2.95, 0.05, 0.35, 0.18);
  // tank: elliptical, dished heads, with the product band
  const T: Section = { cy: () => 2.1, hw: table([[-1.62, 0.0], [-1.6, 1.0], [-1.5, 1.2], [3.2, 1.2], [3.3, 1.0], [3.32, 0]]), hh: table([[-1.62, 0], [-1.6, 0.65], [-1.5, 0.78], [3.2, 0.78], [3.3, 0.65], [3.32, 0]]), e: 2 };
  const tz: number[] = [-1.62, -1.6, -1.55, -1.5, -0.8, 0.1, 1.0, 1.9, 2.6, 3.2, 3.25, 3.3, 3.32];
  const tr = bodyRings(T, tz, 28);
  gridLoft(b, tr, true, (i) => {
    const z = (tz[i] + tz[i + 1]) / 2;
    return z > 0.1 && z < 1.9 ? BAND : TANK;
  });
  // lettering on the band
  put(b, paint(0xf4f4f0, 0.35, 0.05));
  for (const sx of [-1, 1]) blockText(b, jet ? 'JET A' : '100LL', sx, sx * 1.212, 2.1, 1.0, 0.36);
  // saddle, walkway rails, manholes
  boxB(b, DARK, -0.9, 0.82, -1.5, 0.9, 1.35, 3.2);
  put(b, ALU);
  for (const z of [-0.6, 1.0, 2.5]) b.cylinder(0, 2.86, z, 0.28, 0.1, 12);
  for (const sx of [-1, 1]) {
    b.tube([sx * 0.55, 2.85, -1.2], [sx * 0.55, 3.18, -1.2], 0.02, 0.02, 4);
    b.tube([sx * 0.55, 2.85, 2.9], [sx * 0.55, 3.18, 2.9], 0.02, 0.02, 4);
    b.tube([sx * 0.55, 3.18, -1.2], [sx * 0.55, 3.18, 2.9], 0.025, 0.025, 4);
  }
  // rear hose cabinet with roll-up door, ladder, tail lights
  boxB(b, ALU, -1.2, 0.95, 3.35, 1.2, 2.7, L1);
  put(b, paint(0x7d8185, 0.4, 0.6));
  quad(b, [[-1.0, 1.05, L1 + 0.012], [1.0, 1.05, L1 + 0.012], [1.0, 2.55, L1 + 0.012], [-1.0, 2.55, L1 + 0.012]], [0, 0, 1]);
  put(b, paint(0x55595c, 0.4, 0.6));
  for (let y = 1.2; y < 2.5; y += 0.22) quad(b, [[-1.0, y, L1 + 0.015], [1.0, y, L1 + 0.015], [1.0, y + 0.02, L1 + 0.015], [-1.0, y + 0.02, L1 + 0.015]], [0, 0, 1]);
  put(b, ALU);
  for (const x of [-1.08, -0.72]) b.tube([x, 0.6, 3.3], [x, 2.9, 3.3], 0.022, 0.022, 4);
  for (let y = 0.8; y < 2.9; y += 0.3) b.tube([-1.08, y, 3.3], [-0.72, y, 3.3], 0.018, 0.018, 4);
  put(b, paint(0x8a0a06, 0.2, 0.2));
  for (const sx of [-1, 1]) b.boxC(sx * 1.05, 0.9, L1 + 0.02, 0.2, 0.12, 0.04);
}

// ─── tow tractor ───────────────────────────────────────────────────────────

function tug(b: MeshBuilder, variant: number) {
  const BODY = paint([0xe0b020, 0xe9e9e4][variant % 2], 0.35, 0.1);
  b.pushTR(0, 0, 1.1, 0);
  const L0 = -1.6, L1 = 1.6;
  for (const z of [-1.05, 1.05]) for (const sx of [-1, 1]) wheelC(b, sx * 0.68, 0.3, z, 0.3, 0.26, paint(0x6d7174, 0.4, 0.6), 12);
  sideProfile(b, BODY, [[L1, 0.22], [L0 + 0.1, 0.22], [L0, 0.55], [L0 + 0.35, 0.92], [L1, 0.95]], -0.82, 0.82);
  boxB(b, paint(0x1a1a1a, 0.8, 0.1), -0.85, 0.2, L0 - 0.08, 0.85, 0.45, L0 + 0.05);
  boxB(b, paint(0x1a1a1a, 0.8, 0.1), -0.85, 0.2, L1 - 0.05, 0.85, 0.45, L1 + 0.06);
  // operator seat, steering, roll-over frame with a canopy
  boxB(b, DARK, -0.3, 0.95, 0.5, 0.3, 1.05, 1.05);
  boxB(b, DARK, -0.3, 1.05, 0.95, 0.3, 1.55, 1.05);
  put(b, DARK);
  b.tube([0, 0.95, 0.1], [0, 1.35, 0.25], 0.025, 0.025, 4);
  b.cylinder(0, 1.33, 0.26, 0.18, 0.04, 12);
  put(b, paint(0x2a2c2e, 0.5, 0.6));
  for (const sx of [-1, 1]) for (const z of [-0.1, 1.45]) b.tube([sx * 0.72, 0.95, z], [sx * 0.72, 1.92, z], 0.03, 0.03, 6);
  boxB(b, BODY, -0.8, 1.9, -0.18, 0.8, 1.95, 1.53);
  // amber beacon, headlights
  put(b, paint(0xf0a010, 0.2, 0.2));
  b.cylinder(0.55, 1.95, 1.3, 0.06, 0.1, 8);
  put(b, paint(0xf2f2ee, 0.1, 0.3));
  for (const sx of [-1, 1]) quad(b, [[sx * 0.7, 0.6, L0 + 0.12], [sx * 0.5, 0.6, L0 + 0.12], [sx * 0.5, 0.72, L0 + 0.16], [sx * 0.7, 0.72, L0 + 0.16]], [0, 0.6, -0.8]);
  // tow bar lying forward from the front hitch
  put(b, paint(0xe0b020, 0.5, 0.2));
  b.tube([0, 0.35, L0 - 0.08], [0, 0.18, L0 - 2.2], 0.045, 0.045, 6, true);
  b.tube([-0.2, 0.15, L0 - 2.1], [0.2, 0.15, L0 - 2.1], 0.035, 0.035, 6, true);
  for (const sx of [-1, 1]) wheelC(b, sx * 0.24, 0.1, L0 - 1.75, 0.1, 0.06, STEEL, 8);
  b.pop();
}

// ─── baggage tractor + carts ───────────────────────────────────────────────

function baggage(b: MeshBuilder, variant: number) {
  const BODY = paint([0xeaeae5, 0x2e5c9a][variant % 2], 0.35, 0.1);
  // tractor (front at z = −4.8)
  const t0 = -4.8, t1 = -2.1;
  for (const z of [t0 + 0.55, t1 - 0.5]) for (const sx of [-1, 1]) wheelC(b, sx * 0.6, 0.28, z, 0.28, 0.22, paint(0x6d7174, 0.4, 0.6), 10);
  sideProfile(b, BODY, [[t1, 0.25], [t0 + 0.05, 0.25], [t0, 0.6], [t0 + 0.4, 0.95], [t0 + 1.1, 1.0], [t1, 1.0]], -0.72, 0.72);
  boxB(b, DARK, -0.3, 1.0, t1 - 0.8, 0.3, 1.1, t1 - 0.25);
  boxB(b, DARK, -0.3, 1.1, t1 - 0.3, 0.3, 1.55, t1 - 0.22);
  put(b, DARK);
  b.tube([0, 1.0, t0 + 1.2], [0, 1.35, t0 + 1.4], 0.025, 0.025, 4);
  b.cylinder(0, 1.33, t0 + 1.42, 0.17, 0.04, 12);
  put(b, paint(0x2a2c2e, 0.5, 0.6));
  for (const sx of [-1, 1]) for (const z of [t0 + 0.95, t1 - 0.1]) b.tube([sx * 0.66, 1.0, z], [sx * 0.66, 1.9, z], 0.028, 0.028, 6);
  boxB(b, BODY, -0.72, 1.88, t0 + 0.85, 0.72, 1.95, t1);
  put(b, paint(0xf0a010, 0.2, 0.2));
  b.cylinder(0.5, 1.95, t1 - 0.3, 0.06, 0.1, 8);
  put(b, GLASS);
  quad(b, [[-0.62, 1.05, t0 + 0.93], [0.62, 1.05, t0 + 0.93], [0.62, 1.85, t0 + 0.93], [-0.62, 1.85, t0 + 0.93]], [0, 0, -1]);
  // two carts with bags
  const bagCols = [0x1b2a4a, 0x151515, 0x8d1a16, 0x3e4a3c, 0x5b4636, 0x2a2a30, 0x7a6a4a];
  let k = variant * 3;
  for (const [c0, c1] of [[-1.55, 1.35], [1.9, 4.8]] as const) {
    put(b, paint(0x6d7174, 0.5, 0.5));
    b.tube([0, 0.4, c0], [0, 0.35, c0 - 0.55], 0.03, 0.03, 4);
    for (const z of [c0 + 0.45, c1 - 0.45]) for (const sx of [-1, 1]) wheelC(b, sx * 0.58, 0.2, z, 0.2, 0.14, STEEL, 8);
    boxB(b, paint(0x4a4f53, 0.5, 0.5), -0.7, 0.38, c0, 0.7, 0.48, c1);
    put(b, paint(0x9aa0a3, 0.4, 0.7));
    for (const sx of [-1, 1]) {
      b.tube([sx * 0.68, 0.48, c0 + 0.05], [sx * 0.68, 0.48, c1 - 0.05], 0.02, 0.02, 4);
      b.tube([sx * 0.68, 0.85, c0 + 0.05], [sx * 0.68, 0.85, c1 - 0.05], 0.02, 0.02, 4);
      for (const z of [c0 + 0.05, (c0 + c1) / 2, c1 - 0.05]) b.tube([sx * 0.68, 0.48, z], [sx * 0.68, 1.75, z], 0.022, 0.022, 4);
    }
    boxB(b, paint(0x3a4a5a, 0.8, 0.0), -0.72, 1.75, c0 - 0.02, 0.72, 1.8, c1 + 0.02);
    // bags
    for (let z = c0 + 0.15; z < c1 - 0.5; z += 0.62) {
      for (const sx of [-1, 1]) {
        k = (k * 7 + 3) % bagCols.length;
        const h = 0.28 + 0.05 * (k % 3);
        boxB(b, paint(bagCols[k], 0.7, 0.05), sx * 0.08, 0.48, z, sx * 0.62, 0.48 + h, z + 0.48);
      }
    }
  }
}

// ─── ops pickup ────────────────────────────────────────────────────────────

function pickup(b: MeshBuilder, variant: number) {
  const BODY = paint([0xeeeeea, 0xe8b50f][variant % 2], 0.28, 0.4);
  const half = 2.75, hw = 0.97;
  const belt = table([[-2.75, 0.9], [-2.6, 1.05], [-1.2, 1.12], [0.55, 1.14], [0.6, 0.95], [2.75, 0.95]]);
  const bottom = 0.42;
  const zs: number[] = [];
  for (let i = 0; i <= 18; i++) zs.push(-half + (2 * half * i) / 18);
  const rings: V3[][] = zs.map((z) => {
    const e = Math.min(1, (half - Math.abs(z)) / 0.3);
    const w = hw * (0.88 + 0.12 * Math.sqrt(Math.max(0, e)));
    const top = belt(z);
    const bot = bottom + (1 - e) * 0.1;
    const prof: [number, number][] = [[0, bot - 0.02], [w * 0.85, bot], [w, bot + 0.12], [w, top - 0.12], [w * 0.95, top - 0.02], [w * 0.8, top], [0, top + 0.02]];
    const pts: V3[] = prof.map(([x, y]) => [x, y, z]);
    for (let i = prof.length - 2; i >= 1; i--) pts.push([-prof[i][0], prof[i][1], z]);
    return pts;
  });
  put(b, BODY);
  b.loft(rings, true);
  b.capRing(rings[0], [0, 0.65, -half - 0.02], [0, 0, -1]);
  b.capRing(rings[rings.length - 1], [0, 0.7, half + 0.02], [0, 0, 1]);
  // cab greenhouse + roof
  const roof = table([[-1.25, 1.14], [-0.6, 1.84], [0.4, 1.86], [0.55, 1.14]]);
  const gz: number[] = [];
  for (let i = 0; i <= 8; i++) gz.push(-1.25 + (1.8 * i) / 8);
  const glass: V3[][] = gz.map((z) => {
    const bl = 1.13;
    const r = Math.max(bl + 0.01, roof(z));
    const w = hw * 0.95;
    const wt = w - 0.14;
    return [[w, bl, z], [wt + 0.02, r - 0.04, z], [wt - 0.1, r, z], [-wt + 0.1, r, z], [-wt - 0.02, r - 0.04, z], [-w, bl, z]] as V3[];
  });
  put(b, GLASS);
  b.loft(glass, false);
  put(b, BODY);
  const wt = hw * 0.95 - 0.2;
  b.poly([[-wt, 1.875, -0.55], [wt, 1.875, -0.55], [wt, 1.875, 0.38], [-wt, 1.875, 0.38]], [0, 1, 0]);
  // B-pillar / back wall of the cab
  boxB(b, BODY, -hw * 0.93, 1.1, 0.5, hw * 0.93, 1.83, 0.58);
  put(b, GLASS);
  quad(b, [[-0.62, 1.36, 0.585], [0.62, 1.36, 0.585], [0.58, 1.74, 0.585], [-0.58, 1.74, 0.585]], [0, 0, 1]);
  // bed: floor, sides, tailgate
  boxB(b, paint(0x2a2a2a, 0.9, 0.0), -0.86, 0.94, 0.6, 0.86, 0.96, 2.62);
  for (const sx of [-1, 1]) boxB(b, BODY, sx * 0.86, 0.94, 0.6, sx * 0.97, 1.2, 2.72);
  boxB(b, BODY, -0.97, 0.7, 2.62, 0.97, 1.2, 2.74);
  // wheels
  for (const z of [-1.7, 1.75]) for (const sx of [-1, 1]) wheelC(b, sx * 0.82, 0.39, z, 0.39, 0.28, STEEL, 14);
  // lamps, grille
  put(b, DARK);
  quad(b, [[-0.6, 0.62, -half - 0.03], [0.6, 0.62, -half - 0.03], [0.6, 0.86, -half - 0.03], [-0.6, 0.86, -half - 0.03]], [0, 0, -1]);
  put(b, paint(0xf2f2ee, 0.1, 0.3));
  for (const sx of [-1, 1]) quad(b, [[sx * 0.88, 0.72, -half - 0.025], [sx * 0.64, 0.72, -half - 0.025], [sx * 0.64, 0.86, -half - 0.025], [sx * 0.88, 0.86, -half - 0.025]], [0, 0, -1]);
  put(b, paint(0x8a0a06, 0.2, 0.2));
  for (const sx of [-1, 1]) quad(b, [[sx * 0.72, 0.85, 2.75], [sx * 0.94, 0.85, 2.75], [sx * 0.94, 1.12, 2.75], [sx * 0.72, 1.12, 2.75]], [0, 0, 1]);
  // amber light bar
  put(b, paint(0x222426, 0.5, 0.5));
  b.boxC(0, 1.905, -0.2, 1.3, 0.06, 0.3);
  put(b, paint(0xf0a010, 0.2, 0.1));
  b.boxC(0, 1.97, -0.2, 1.2, 0.08, 0.24);
  // checkered flag on a pole at the rear corner
  put(b, STEEL);
  b.tube([0.9, 1.2, 0.72], [0.9, 2.95, 0.72], 0.018, 0.015, 5);
  const n = 6, fs = 0.9 / n;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      put(b, (i + j) % 2 ? paint(0xf2f2ee, 0.8, 0) : paint(0xe8641a, 0.8, 0));
      const z0 = 0.72 + 0.02 + i * fs, z1 = z0 + fs;
      const y1 = 2.93 - j * fs, y0 = y1 - fs;
      quad(b, [[0.9, y0, z0], [0.9, y0, z1], [0.9, y1, z1], [0.9, y1, z0]], [1, 0, 0], true);
    }
}

// ─── dispatch ──────────────────────────────────────────────────────────────

const BUILDERS: Record<ExtraVehicle, (b: MeshBuilder, variant: number) => void> = {
  kingair: kingAir,
  helicopter,
  arff,
  fueltruck: fuelTruck,
  tug,
  baggage,
  pickup,
};

/** Draw one vehicle into the builder's current frame (ground y = 0, −Z = front, +X = right). */
export function buildExtraVehicle(b: MeshBuilder, kind: ExtraVehicle, variant = 0): void {
  const v = ((Math.floor(variant) % EXTRA_VEHICLE_VARIANTS[kind]) + EXTRA_VEHICLE_VARIANTS[kind]) % EXTRA_VEHICLE_VARIANTS[kind];
  BUILDERS[kind](b, v);
}

/** Convenience: one vehicle as a geometry with the attributes createVehicleMaterial reads. */
export function buildExtraVehicleGeometry(kind: ExtraVehicle, variant = 0): THREE.BufferGeometry {
  const b = new MeshBuilder();
  buildExtraVehicle(b, kind, variant);
  return b.toGeometry(['color', 'accent', 'rm']);
}
