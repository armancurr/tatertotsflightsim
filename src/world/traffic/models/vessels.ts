/**
 * Procedural vessel models (local frame: bow −Z, starboard +X, waterline y = 0).
 *
 * Hulls are lofted stations × waterline-parallel rings, so the boot stripe,
 * rub rail and antifouling are crisp horizontal bands, with a raked stem,
 * flared bow, sheer and transom. Superstructures are stacked prisms with dark
 * glass bands. Sails are cambered grids (port/starboard-tack variants) with a
 * flutter weight toward the leech. Two levels of detail per model.
 */
import { MeshBuilder, mat, type Mat } from './builder';
import { h01 } from '../rng';
import type { VesselKind } from '../sea';

// ─── Palette ──────────────────────────────────────────────────────────────────
// Tinted parts (t = 1) are multiplied by the instance colour; their base is white.
const WHITE_T = mat(0xffffff, 0.3, 0, 1);
const WHITE = mat(0xeeeeea, 0.32);
const OFFWHITE = mat(0xdcdad2, 0.45);
const GLASS = mat(0x0b1016, 0.06, 0.1);
const GLASS_BLUE = mat(0x0d1a26, 0.06, 0.15);
/** Glass that lights up at dusk (luff weight −1 → the batch material's window pattern). */
const LIT = mat(0x0b1016, 0.06, 0.1, 0, -1);
const LIT_BLUE = mat(0x0d1a26, 0.06, 0.15, 0, -1);
const LIT_FAR = mat(0x3a3f45, 0.3, 0.1, 0, -1);
const STAINLESS = mat(0xb9bec4, 0.25, 0.9);
const MAST = mat(0xc9ccd0, 0.3, 0.8);
const DARK = mat(0x202326, 0.5);
const BLACK = mat(0x121314, 0.45);
const TEAK = mat(0x8a6a48, 0.7);
const NONSKID = mat(0xd9d5ca, 0.75);
const ANTIFOUL_RED = mat(0x6e211c, 0.8);
const ANTIFOUL_BLUE = mat(0x1c2533, 0.8);
const DECK_GREY = mat(0x6f7478, 0.8);
const DECK_GREEN = mat(0x4d5a4a, 0.8);
const DECK_RED = mat(0x6b3a30, 0.8);
const RUST = mat(0x5a3326, 0.85);
const ORANGE = mat(0xd9651c, 0.55);
const YELLOW = mat(0xd9b21c, 0.5);
const CANVAS = mat(0x274a78, 0.85);
const SAIL = mat(0xf2f0ea, 0.72, 0, 0, 1);
const RED = mat(0xa0201c, 0.45);
const GREEN_L = mat(0x2a7a3a, 0.45);

// ─── Hull ─────────────────────────────────────────────────────────────────────

export interface HullSpec {
  L: number;
  B: number;
  /** Deck height above the waterline at mid-ships. */
  F: number;
  /** Canoe-body depth below the waterline. */
  D: number;
  /** Deck rise at the bow as a fraction of F. */
  sheer: number;
  /** Transom half-beam as a fraction of B/2 (0 = pointed/double-ended). */
  transom: number;
  /** Transom bottom depth as a fraction of D. */
  transomDepth: number;
  /** Bow fineness exponent (higher = fuller bow). */
  entry: number;
  /** Section superellipse exponent (2 = round, 4+ = boxy). */
  n: number;
  /** Stem overhang (m): the stem rakes aft toward the keel. */
  rake: number;
  topside: Mat;
  boot: Mat;
  bottom: Mat;
  deck: Mat;
  rub: Mat;
  /** Height of the boot-stripe top above the waterline. */
  bootTop: number;
  /** Double-ended (ferry): symmetric plan and profile. */
  symmetric?: boolean;
  /** Extra band of hull windows (motor yachts): [zFrom, zTo, yLow, yHigh]. */
  hullWindows?: [number, number, number, number];
  stations?: number;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function hullShape(s: HullSpec, u: number) {
  const q = s.symmetric ? 1 - Math.abs(2 * u - 1) : 0; // 0 at both ends, 1 mid (symmetric)
  let plan: number;
  if (s.symmetric) plan = Math.pow(Math.max(0, 1 - Math.pow(1 - q, s.entry)), 0.42);
  else if (u < 0.5) plan = s.transom + (1 - s.transom) * smoothstep(-0.1, 0.5, u);
  else plan = Math.pow(Math.max(0, 1 - Math.pow((u - 0.5) / 0.5, s.entry)), 0.5);
  const halfB = (s.B / 2) * plan;
  const deckY = s.symmetric ? s.F * (1 + s.sheer * (1 - q) * (1 - q)) : s.F * (1 + s.sheer * u * u * 1.2 - 0.04 * Math.sin(Math.PI * u));
  let keel: number;
  if (s.symmetric) keel = -s.D * (0.2 + 0.8 * smoothstep(0, 0.35, q));
  else if (u < 0.22) keel = -s.D * (s.transomDepth + (1 - s.transomDepth) * smoothstep(0, 0.22, u));
  else if (u > 0.68) keel = -s.D * (1 - 0.94 * Math.pow((u - 0.68) / 0.32, 1.25));
  else keel = -s.D;
  return { halfB, deckY, keel };
}

/** Lofts the hull + deck + transom into `b`. */
export function buildHull(b: MeshBuilder, s: HullSpec): void {
  const NS = s.stations ?? 22;
  const levels = (deckY: number, keel: number): number[] => {
    const lv = [deckY, deckY - Math.min(0.12 * s.F, 0.6), s.bootTop, 0, keel * 0.4, keel * 0.8, keel];
    // keep the levels ordered top → bottom and inside [keel, deck]
    for (let i = 1; i < lv.length; i++) lv[i] = Math.min(lv[i - 1] - 1e-3, Math.max(keel, lv[i]));
    return lv;
  };
  const stationsU: number[] = [];
  for (let i = 0; i <= NS; i++) {
    const t = i / NS;
    // denser toward the bow where the shape changes fastest
    stationsU.push(s.symmetric ? 0.5 - 0.5 * Math.cos(Math.PI * t) : 1 - Math.pow(1 - t, 1.35));
  }
  const rings: [number, number, number][][] = [];
  const bandOf: number[][] = [];
  for (const u of stationsU) {
    const { halfB, deckY, keel } = hullShape(s, u);
    const lv = levels(deckY, keel);
    const zBase = s.L / 2 - u * s.L;
    const pts: [number, number, number][] = [];
    const sideStar: [number, number, number][] = [];
    for (let k = 0; k < lv.length; k++) {
      const y = lv[k];
      const v = Math.min(1, Math.max(0, (deckY - y) / Math.max(1e-3, deckY - keel)));
      // flare: above the waterline the sides open out slightly toward the bow
      const flare = y > 0 ? 1 + 0.06 * smoothstep(0.5, 1, u) * (y / Math.max(0.1, deckY)) : 1;
      const hb = halfB * Math.pow(Math.max(0, 1 - Math.pow(v, s.n)), 1 / s.n) * flare;
      const bowRake = s.symmetric ? 0 : s.rake * smoothstep(0.72, 1, u) * v;
      sideStar.push([hb, y, zBase + bowRake]);
    }
    // U profile: starboard deck → keel → port deck
    for (let k = 0; k < sideStar.length; k++) pts.push(sideStar[k]);
    for (let k = sideStar.length - 2; k >= 0; k--) pts.push([-sideStar[k][0], sideStar[k][1], sideStar[k][2]]);
    rings.push(pts);
    bandOf.push(lv);
  }
  const nLv = 7;
  const bandMat = (i: number, j: number): Mat => {
    const k = j < nLv - 1 ? j : 2 * (nLv - 1) - j - 1; // band index 0..5 (0 top)
    if (s.hullWindows && (k === 1 || k === 0)) {
      const z = rings[i][0][2];
      const [z0, z1, y0, y1] = s.hullWindows;
      const ym = (bandOf[i][1] + bandOf[i][2]) / 2;
      if (k === 1 && z >= z0 && z <= z1 && ym > y0 && ym < y1 + 1) return LIT;
    }
    if (k === 0) return s.rub;
    if (k === 1) return s.topside;
    if (k === 2) return s.boot;
    return s.bottom;
  };
  b.loft(rings, bandMat, false, true);
  // deck: strip between the port and starboard deck edges, slightly cambered
  const nP = rings[0].length;
  for (let i = 0; i < rings.length - 1; i++) {
    const a0 = rings[i][0];
    const a1 = rings[i][nP - 1];
    const b0 = rings[i + 1][0];
    const b1 = rings[i + 1][nP - 1];
    const camber = 0.02 * s.B;
    const mid = (p: [number, number, number], q: [number, number, number]): [number, number, number] => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2 + camber, (p[2] + q[2]) / 2];
    const am = mid(a0, a1);
    const bm = mid(b0, b1);
    const ids = [a0, am, a1, b0, bm, b1].map((p) => b.vertex(p[0], p[1], p[2], 0, 1, 0, s.deck));
    // winding: facing up
    b.tri(ids[0], ids[3], ids[1]).tri(ids[1], ids[3], ids[4]).tri(ids[1], ids[4], ids[2]).tri(ids[2], ids[4], ids[5]);
  }
  // transom (stern) and, for double-enders, nothing (both ends pointed)
  if (!s.symmetric && s.transom > 0) {
    const r = rings[0];
    const cz = r[0][2];
    const cy = (r[0][1] + r[Math.floor(nP / 2)][1]) / 2;
    const c = b.vertex(0, cy, cz, 0, 0, 1, s.topside);
    const ids = r.map((p) => b.vertex(p[0], p[1], p[2], 0, 0, 1, p[1] < 0 ? s.bottom : s.topside));
    for (let k = 0; k < ids.length - 1; k++) b.tri(c, ids[k + 1], ids[k]);
    b.tri(c, ids[0], ids[ids.length - 1]);
  }
}

/** Half-breadth of the hull at (u, y) — the same section as `buildHull` (for fittings on the side). */
export function hullHalfAt(s: HullSpec, u: number, y: number): number {
  const { halfB, deckY, keel } = hullShape(s, u);
  const v = Math.min(1, Math.max(0, (deckY - y) / Math.max(1e-3, deckY - keel)));
  const flare = y > 0 ? 1 + 0.06 * smoothstep(0.5, 1, u) * (y / Math.max(0.1, deckY)) : 1;
  return halfB * Math.pow(Math.max(0, 1 - Math.pow(v, s.n)), 1 / s.n) * flare;
}

/** Model z of the hull station u (0 = stern, 1 = bow) at the deck edge. */
const stationZ = (s: HullSpec, u: number) => s.L / 2 - u * s.L;

/**
 * Guard rails along both deck edges from u0 to u1: stanchions every `pitch` m and a top rail
 * following the sheer, `inset` m inside the deck edge, `h` m tall.
 */
function deckRails(b: MeshBuilder, s: HullSpec, u0: number, u1: number, h: number, pitch: number, inset: number, m: Mat, bowPulpit = false): void {
  const n = Math.max(2, Math.round(((u1 - u0) * s.L) / pitch));
  for (const side of [-1, 1]) {
    let prev: [number, number, number] | null = null;
    for (let i = 0; i <= n; i++) {
      const u = u0 + ((u1 - u0) * i) / n;
      const { deckY } = hullShape(s, u);
      const x = side * Math.max(0.05, hullHalfAt(s, u, deckY) - inset);
      const z = stationZ(s, u);
      b.cylinder([x, deckY, z], [x, deckY + h, z], 0.018, 0.018, 3, m, false);
      const top: [number, number, number] = [x, deckY + h, z];
      if (prev) b.cylinder(prev, top, 0.02, 0.02, 3, m, false);
      prev = top;
    }
  }
  if (bowPulpit) {
    const { deckY } = hullShape(s, u1);
    const z = stationZ(s, u1);
    const x = Math.max(0.05, hullHalfAt(s, u1, deckY) - inset);
    b.cylinder([-x, deckY + h, z], [0, deckY + h, z - 0.35], 0.02, 0.02, 3, m, false);
    b.cylinder([x, deckY + h, z], [0, deckY + h, z - 0.35], 0.02, 0.02, 3, m, false);
    b.cylinder([0, deckY, z - 0.3], [0, deckY + h, z - 0.35], 0.02, 0.02, 3, m, false);
  }
}

/** A bulbous bow: a rounded torpedo below the waterline ahead of the forefoot. */
function bulbousBow(b: MeshBuilder, s: HullSpec, r: number, len: number, lod: number, m: Mat): void {
  const zTip = -s.L / 2 - r * 0.25;
  const y = -s.D * 0.58;
  const segs = lod ? 6 : 10;
  b.cylinder([0, y * 0.95, zTip + len], [0, y, zTip + len * 0.3], r * 0.9, r, segs, m, false);
  b.cylinder([0, y, zTip + len * 0.3], [0, y + r * 0.08, zTip + len * 0.08], r, r * 0.72, segs, m, false);
  b.cylinder([0, y + r * 0.08, zTip + len * 0.08], [0, y + r * 0.12, zTip], r * 0.72, r * 0.25, segs, m, true);
}

/** Hull window slits (motor yachts): dark glass strips just proud of the topsides between u0..u1 at y0..y1. */
function hullSlits(b: MeshBuilder, s: HullSpec, spans: [number, number][], y0: number, y1: number, m: Mat): void {
  for (const side of [-1, 1])
    for (const [u0, u1] of spans) {
      const n = 3;
      for (let i = 0; i < n; i++) {
        const ua = u0 + ((u1 - u0) * i) / n;
        const ub = u0 + ((u1 - u0) * (i + 1)) / n;
        const P = (u: number, y: number): [number, number, number] => [side * (hullHalfAt(s, u, y) + 0.015), y, stationZ(s, u)];
        const q = [P(ua, y0), P(ub, y0), P(ub, y1), P(ua, y1)];
        b.poly(side > 0 ? q : [q[0], q[3], q[2], q[1]], m);
      }
    }
}

// ─── Models ──────────────────────────────────────────────────────────────────

export type VesselPart = 'hull' | 'mainP' | 'mainS' | 'jibP' | 'jibS' | 'furled';

/** Mast position of the sailing yacht (local z of the mast, deck height there) for scale 1. */
export const SAIL_RIG = { mastZ: -0.9, deckY: 1.2, mastTop: 16.2, boomY: 2.4, boomLen: 4.7, forestayZ: -5.55, forestayTop: 14.0 };

const SAIL_HULL: HullSpec = {
  L: 12, B: 3.9, F: 1.05, D: 0.55, sheer: 0.22, transom: 0.8, transomDepth: 0.12, entry: 1.7, n: 2.3, rake: 0.7,
  topside: WHITE_T, boot: mat(0x1e2c48, 0.4), bottom: ANTIFOUL_BLUE, deck: NONSKID, rub: STAINLESS, bootTop: 0.12,
};

function sailHull(b: MeshBuilder, lod: number, moored: boolean): void {
  buildHull(b, { ...SAIL_HULL, stations: lod ? 8 : 20 });
  // guard rails with a bow pulpit, dark port lights in the coachroof sides
  if (!lod) deckRails(b, SAIL_HULL, 0.06, 0.93, 0.6, 1.7, 0.12, STAINLESS, true);
  // fin keel + bulb and rudder (seen through clear water from above)
  b.box(0, -1.2, -0.3, 0.16, 1.4, 1.3, ANTIFOUL_BLUE, { top: true });
  if (!lod) {
    b.cylinder([0, -1.95, -1.1], [0, -1.95, 0.8], 0.22, 0.18, 8, ANTIFOUL_BLUE);
    b.box(0, -0.6, 4.6, 0.1, 1.2, 0.6, ANTIFOUL_BLUE, { top: true });
  }
  // coachroof with a dark window band, sprayhood, cockpit
  b.prism(0, -1.3, 1.02, 1.32, 2.5, 4.6, 2.3, 4.2, WHITE, 0.15, false);
  b.prism(0, -1.25, 1.32, 1.55, 2.3, 4.2, 2.1, 3.7, LIT, 0.2, false);
  b.prism(0, -1.2, 1.55, 1.6, 2.1, 3.7, 1.9, 3.5, WHITE, 0);
  if (!lod) {
    b.prism(0, 1.3, 1.1, 1.8, 2.0, 0.9, 1.7, 0.4, CANVAS, 0.25); // sprayhood
    b.box(0, 1.12, 3.1, 2.3, 0.06, 2.9, TEAK); // cockpit sole/seats
    b.cylinder([0, 1.2, 4.5], [0, 2.0, 4.6], 0.03, 0.03, 5, STAINLESS, false); // backstay base / pushpit
  }
  // mast (keel-stepped look), spreaders
  b.cylinder([0, 1.1, SAIL_RIG.mastZ], [0, SAIL_RIG.mastTop, SAIL_RIG.mastZ], lod ? 0.1 : 0.09, 0.06, lod ? 4 : 8, MAST, false);
  if (!lod) {
    b.box(0, 9.2, SAIL_RIG.mastZ, 2.2, 0.05, 0.08, MAST);
    // forestay and backstay as thin rods (visible up close only)
    b.cylinder([0, 1.25, SAIL_RIG.forestayZ], [0, SAIL_RIG.forestayTop, SAIL_RIG.mastZ + 0.05], 0.012, 0.012, 3, STAINLESS, false);
    b.cylinder([0, 1.2, 5.4], [0, SAIL_RIG.mastTop - 0.2, SAIL_RIG.mastZ + 0.1], 0.012, 0.012, 3, STAINLESS, false);
  }
  if (moored) furled(b, lod);
}

/** Furled rig for moored yachts: boom with a blue sail cover and a furled jib along the forestay. */
function furled(b: MeshBuilder, lod: number): void {
  const r = SAIL_RIG;
  b.cylinder([0, r.boomY, r.mastZ + 0.1], [0, r.boomY - 0.05, r.mastZ + r.boomLen], 0.05, 0.05, 5, MAST, false);
  b.cylinder([0, r.boomY + 0.22, r.mastZ + 0.2], [0, r.boomY + 0.15, r.mastZ + r.boomLen - 0.6], 0.26, 0.16, lod ? 5 : 8, CANVAS);
  b.cylinder([0, 1.3, r.forestayZ + 0.1], [0, r.forestayTop - 0.3, r.mastZ - 0.05], 0.13, 0.03, lod ? 4 : 6, mat(0xe8e6de, 0.8));
}

/** Mainsail (with boom) in the sail frame: origin at the mast base, boom along +z. `tack` +1 bellies to port (−x). */
function mainsail(b: MeshBuilder, tack: number, lod: number): void {
  const r = SAIL_RIG;
  const rows = lod ? 3 : 8;
  const cols = lod ? 2 : 5;
  const belly = -tack;
  const foot = r.boomLen - 0.25;
  const y0 = r.boomY + 0.08;
  const y1 = r.mastTop - 0.4;
  // boom
  b.cylinder([0, r.boomY, r.mastZ + 0.1], [0, r.boomY - 0.05, r.mastZ + r.boomLen], 0.055, 0.05, 5, MAST, false);
  const grid: [number, number, number][][] = [];
  const luff: number[][] = [];
  for (let i = 0; i <= rows; i++) {
    const h = i / rows;
    const y = y0 + (y1 - y0) * h;
    // chord shrinks toward the head; a little roach on the leech
    const chord = foot * (1 - h) + 0.35 + 0.45 * Math.sin(Math.PI * h) * (1 - h);
    const row: [number, number, number][] = [];
    const lr: number[] = [];
    for (let j = 0; j <= cols; j++) {
      const c = j / cols;
      const depth = 0.1 * chord * Math.sin(Math.PI * Math.pow(c, 0.8)) * (0.6 + 0.4 * (1 - h));
      row.push([belly * depth, y, r.mastZ + 0.08 + c * chord]);
      lr.push(Math.pow(c, 1.5) * (0.3 + 0.7 * h));
    }
    grid.push(row);
    luff.push(lr);
  }
  sailGrid(b, grid, luff, belly);
}

/** Jib in the sail frame (origin at the mast base): luff along the forestay, clew to leeward aft of the mast. */
function jib(b: MeshBuilder, tack: number, lod: number): void {
  const r = SAIL_RIG;
  const rows = lod ? 3 : 7;
  const cols = lod ? 2 : 4;
  const belly = -tack;
  const tackPt: [number, number, number] = [0, 1.35, r.forestayZ + 0.1];
  const head: [number, number, number] = [0, r.forestayTop - 0.6, r.mastZ - 0.35];
  const clew: [number, number, number] = [belly * 0.9, 1.75, r.mastZ + 0.9];
  const grid: [number, number, number][][] = [];
  const luff: number[][] = [];
  for (let i = 0; i <= rows; i++) {
    const h = i / rows;
    const L = [tackPt[0] + (head[0] - tackPt[0]) * h, tackPt[1] + (head[1] - tackPt[1]) * h, tackPt[2] + (head[2] - tackPt[2]) * h];
    const E = [clew[0] + (head[0] - clew[0]) * h, clew[1] + (head[1] - clew[1]) * h, clew[2] + (head[2] - clew[2]) * h];
    const row: [number, number, number][] = [];
    const lr: number[] = [];
    const chord = Math.hypot(E[0] - L[0], E[1] - L[1], E[2] - L[2]);
    for (let j = 0; j <= cols; j++) {
      const c = j / cols;
      const depth = 0.12 * chord * Math.sin(Math.PI * Math.pow(c, 0.75));
      row.push([L[0] + (E[0] - L[0]) * c + belly * depth, L[1] + (E[1] - L[1]) * c, L[2] + (E[2] - L[2]) * c]);
      lr.push(Math.pow(c, 1.4) * (0.4 + 0.6 * (1 - Math.abs(2 * h - 1))));
    }
    grid.push(row);
    luff.push(lr);
  }
  sailGrid(b, grid, luff, belly);
}

function sailGrid(b: MeshBuilder, grid: [number, number, number][][], luff: number[][], belly: number): void {
  const rows = grid.length - 1;
  const cols = grid[0].length - 1;
  const ids: number[][] = [];
  for (let i = 0; i <= rows; i++) {
    ids.push([]);
    for (let j = 0; j <= cols; j++) {
      const p = grid[i][j];
      // normal: toward the belly side (lit side flips with DoubleSide shading)
      const pu = grid[Math.min(rows, i + 1)][j];
      const pd = grid[Math.max(0, i - 1)][j];
      const pr = grid[i][Math.min(cols, j + 1)];
      const pl = grid[i][Math.max(0, j - 1)];
      const ux = pu[0] - pd[0], uy = pu[1] - pd[1], uz = pu[2] - pd[2];
      const vx = pr[0] - pl[0], vy = pr[1] - pl[1], vz = pr[2] - pl[2];
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      let l = Math.hypot(nx, ny, nz);
      if (l < 1e-9 && i > 0) {
        // the head of a triangular sail collapses to a point: reuse the row below's normal
        const q = ids[i - 1][Math.min(j, ids[i - 1].length - 1)];
        nx = b.N[q * 3];
        ny = b.N[q * 3 + 1];
        nz = b.N[q * 3 + 2];
        l = 1;
      }
      l = l || 1;
      nx /= l;
      ny /= l;
      nz /= l;
      if (nx * belly < 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
      // luff weight > 0 everywhere on the cloth (the batch shader's sail marker: flutter + translucency)
      ids[i].push(b.vertex(p[0], p[1], p[2], nx, ny, nz, SAIL, Math.max(0.02, luff[i][j])));
    }
  }
  for (let i = 0; i < rows; i++)
    for (let j = 0; j < cols; j++) {
      if (belly > 0) b.quad(ids[i][j], ids[i + 1][j], ids[i + 1][j + 1], ids[i][j + 1]);
      else b.quad(ids[i][j], ids[i][j + 1], ids[i + 1][j + 1], ids[i + 1][j]);
    }
}

const MOTOR_HULL: HullSpec = {
  L: 18, B: 5.0, F: 1.9, D: 0.9, sheer: 0.3, transom: 0.93, transomDepth: 0.45, entry: 1.45, n: 1.6, rake: 1.4,
  topside: WHITE_T, boot: mat(0x2a2d31, 0.35), bottom: ANTIFOUL_BLUE, deck: TEAK, rub: STAINLESS, bootTop: 0.18,
};

function motorYacht(b: MeshBuilder, lod: number): void {
  buildHull(b, { ...MOTOR_HULL, stations: lod ? 8 : 20 });
  // hull window slits (guest cabins) and a foredeck rail
  hullSlits(b, MOTOR_HULL, lod ? [[0.4, 0.66]] : [[0.4, 0.5], [0.53, 0.66]], 1.02, 1.32, LIT);
  if (!lod) deckRails(b, MOTOR_HULL, 0.62, 0.94, 0.75, 1.6, 0.12, STAINLESS, true);
  // main-deck saloon: raked windscreen, dark glass band
  b.prism(0, 0.8, 1.9, 2.6, 4.3, 9.0, 4.1, 8.6, WHITE, 0.1, false);
  b.prism(0, 0.95, 2.6, 3.55, 4.1, 8.6, 3.9, 7.4, LIT_BLUE, 0.5, false);
  b.prism(0, 1.35, 3.55, 3.75, 3.9, 7.4, 3.8, 7.2, WHITE, 0.05);
  // flybridge with windscreen, hardtop on posts, radar arch
  b.prism(0, 1.9, 3.75, 4.5, 3.7, 5.4, 3.5, 5.0, WHITE, 0.1, false);
  b.prism(0, -0.5, 4.5, 4.85, 3.2, 0.5, 3.0, 0.2, GLASS, 0.15);
  if (!lod) {
    b.box(0, 5.9, 2.6, 3.6, 0.12, 4.0, WHITE);
    for (const x of [-1.6, 1.6]) for (const z of [1.0, 4.2]) b.cylinder([x, 4.5, z], [x, 5.85, z], 0.05, 0.05, 5, STAINLESS, false);
    b.box(0, 6.2, 3.2, 0.8, 0.25, 0.5, WHITE); // radar dome base
    b.cylinder([0, 6.3, 3.2], [0, 6.5, 3.2], 0.35, 0.35, 10, WHITE);
    b.box(0, 0.35, 9.35, 4.4, 0.12, 1.3, TEAK); // swim platform
    b.box(0, 1.95, -4.8, 3.0, 0.08, 3.5, mat(0xc8c2b4, 0.8)); // foredeck sunpad
  }
}

function fishingBoat(b: MeshBuilder, lod: number, deployed: boolean): void {
  buildHull(b, {
    L: 20, B: 6.2, F: 1.8, D: 1.6, sheer: 0.42, transom: 0.8, transomDepth: 0.5, entry: 2.2, n: 2.7, rake: 1.0,
    topside: WHITE_T, boot: mat(0xe8e8e2, 0.5), bottom: ANTIFOUL_RED, deck: DECK_GREY, rub: mat(0xe8e8e2, 0.5), bootTop: 0.25, stations: lod ? 8 : 18,
  });
  // wheelhouse forward
  b.prism(0, -3.6, 1.9, 3.6, 4.0, 4.4, 3.8, 4.0, WHITE, 0, false);
  b.prism(0, -3.65, 3.6, 4.5, 3.8, 4.0, 3.9, 4.2, LIT, -0.3, false);
  b.prism(0, -3.7, 4.5, 4.75, 4.1, 4.4, 4.1, 4.4, WHITE, 0);
  // mast + A-frame gantry aft, net drum
  b.cylinder([0, 4.7, -3.2], [0, 9.5, -3.2], 0.12, 0.08, 6, WHITE, false);
  b.cylinder([-2.3, 1.9, 7.8], [-0.2, 7.0, 7.8], 0.14, 0.12, 6, ORANGE, false);
  b.cylinder([2.3, 1.9, 7.8], [0.2, 7.0, 7.8], 0.14, 0.12, 6, ORANGE, false);
  b.box(0, 7.0, 7.8, 0.9, 0.3, 0.3, ORANGE);
  b.cylinder([-1.3, 2.9, 5.2], [1.3, 2.9, 5.2], 0.9, 0.9, lod ? 6 : 12, mat(0x2b5d3a, 0.8));
  // outrigger booms from the mast: out and down when fishing, raised when steaming
  const a = deployed ? 0.45 : 1.25;
  for (const s of [-1, 1]) {
    const ex = s * 10.5 * Math.sin(a);
    const ey = 7.5 + 10.5 * Math.cos(a) - 2;
    b.cylinder([s * 0.2, 7.6, -1.5], [ex, ey, -0.5], 0.09, 0.05, 5, mat(0xc0c4c8, 0.5, 0.6), false);
  }
  if (!lod) {
    b.box(0, 2.2, 1.5, 0.6, 0.6, 0.6, ORANGE); // fish hatch
    b.box(-2.2, 2.3, -6.5, 0.6, 0.6, 0.6, ORANGE);
    b.box(2.2, 2.3, -6.5, 0.6, 0.6, 0.6, YELLOW);
    b.cylinder([0, 4.75, -2.6], [0, 5.3, -2.6], 0.06, 0.06, 5, DARK, false);
    b.box(0, 5.4, -2.6, 1.6, 0.08, 0.2, DARK); // radar bar
  }
}

function launch(b: MeshBuilder, lod: number): void {
  buildHull(b, {
    L: 7.5, B: 2.6, F: 0.9, D: 0.35, sheer: 0.3, transom: 0.9, transomDepth: 0.5, entry: 1.5, n: 1.5, rake: 0.5,
    topside: WHITE_T, boot: mat(0x30343a, 0.4), bottom: mat(0xd8d8d2, 0.5), deck: NONSKID, rub: mat(0x30343a, 0.5), bootTop: 0.15, stations: lod ? 6 : 14,
  });
  b.box(0, 1.25, -0.2, 0.8, 0.7, 1.0, WHITE);
  b.prism(0, -0.55, 1.6, 2.0, 0.9, 0.12, 0.9, 0.08, GLASS, 0.2);
  b.box(0, 0.95, 1.4, 1.9, 0.12, 1.0, mat(0x4a4f56, 0.8)); // seat
  b.box(0, 0.7, 3.95, 0.45, 1.1, 0.55, mat(0x2a2c30, 0.4, 0.2)); // outboard
}

function ferry(b: MeshBuilder, lod: number): void {
  buildHull(b, {
    L: 92, B: 20, F: 3.6, D: 4.2, sheer: 0.18, transom: 0, transomDepth: 0.2, entry: 3.2, n: 4.2, rake: 0,
    topside: WHITE_T, boot: mat(0xf2f2ee, 0.4), bottom: ANTIFOUL_RED, deck: DECK_GREY, rub: WHITE, bootTop: 0.6, symmetric: true, stations: lod ? 10 : 26,
  });
  // car deck enclosure: white walls with a row of openings, open (dark) at both ends
  const CARDECK = mat(0x1b1d20, 0.7);
  b.prism(0, 0, 3.6, 8.4, 17.4, 76, 17.6, 76, WHITE, 0, false);
  b.prism(0, 0, 7.4, 8.4, 17.62, 76, 17.8, 76, WHITE, 0);
  for (const z of [-38.02, 38.02]) b.box(0, 5.8, z, 14.5, 3.6, 0.1, CARDECK);
  for (let k = 0; k < (lod ? 0 : 10); k++) {
    const z = -33 + k * 7.3;
    for (const x of [-8.72, 8.72]) b.box(x, 5.9, z, 0.08, 2.2, 5.2, CARDECK);
  }
  // passenger deck: long glass band
  b.prism(0, 0, 8.4, 9.2, 18, 62, 18, 62, WHITE, 0, false);
  b.prism(0, 0, 9.2, 10.8, 18, 62, 17.8, 61, LIT_BLUE, 0, false);
  b.prism(0, 0, 10.8, 11.6, 17.8, 61, 17.4, 60, WHITE, 0);
  // sun deck and the two wheelhouses (double-ended)
  b.prism(0, 0, 11.6, 13.4, 13, 36, 13, 36, WHITE, 0, false);
  b.prism(0, 0, 12.3, 13.1, 13.05, 36.05, 13.05, 36.05, LIT, 0, false);
  b.prism(0, 0, 13.4, 13.6, 13.2, 36.2, 13.2, 36.2, WHITE, 0);
  for (const z of [-19, 19]) {
    b.prism(0, z, 13.6, 14.6, 11, 4.2, 11, 4.2, WHITE, 0, false);
    b.prism(0, z, 14.6, 16.0, 11.2, 4.4, 11.4, 4.6, LIT, 0, false);
    b.prism(0, z, 16.0, 16.4, 12, 5, 12, 5, WHITE, 0);
  }
  // funnels (port & starboard) with a coloured band, mast
  for (const x of [-4.5, 4.5]) {
    b.prism(x, 0, 13.6, 18.0, 2.2, 4.4, 1.9, 3.8, WHITE, 0.3, false);
    b.prism(x, 0.3, 18.0, 19.3, 1.9, 3.8, 1.8, 3.6, mat(0x1d6b3c, 0.5), 0.1, false);
    b.prism(x, 0.4, 19.3, 19.8, 1.8, 3.6, 1.8, 3.6, BLACK, 0);
  }
  b.cylinder([0, 13.6, 0], [0, 22, 0], 0.2, 0.12, 6, WHITE, false);
  if (!lod) {
    b.box(0, 21, 0, 2.6, 0.12, 0.3, DARK);
    b.cylinder([0, 21.3, 0], [0, 21.6, 0], 0.45, 0.45, 8, WHITE); // radome
    // bridge wings out to the ship's side on both wheelhouses
    for (const z of [-19, 19]) b.box(0, 15.2, z + Math.sign(z) * 1.2, 19.4, 0.25, 1.6, WHITE);
    // lifeboats on davits along the passenger deck, life-raft canisters
    for (const x of [-9.3, 9.3])
      for (const z of [-22, -8, 8, 22]) {
        b.cylinder([x, 11.9, z - 2.2], [x, 11.9, z + 2.2], 0.75, 0.75, 8, ORANGE);
        b.box(x, 12.55, z, 1.3, 0.25, 4.2, WHITE); // canopy
        for (const dz of [-1.8, 1.8]) {
          b.box(x - Math.sign(x) * 0.6, 12.4, z + dz, 0.18, 2.2, 0.18, WHITE);
          b.box(x - Math.sign(x) * 0.1, 13.45, z + dz, 1.2, 0.18, 0.18, WHITE);
        }
      }
    for (const x of [-8.2, 8.2]) for (const z of [-28, -14.5, 14.5, 28]) b.cylinder([x, 11.8, z - 0.6], [x, 11.8, z + 0.6], 0.45, 0.45, 6, WHITE);
    // railings round the passenger and sun decks
    const railsAt = (y: number, hw: number, hl: number) => {
      const RAIL = mat(0xf2f2ee, 0.4);
      for (const x of [-hw, hw]) {
        b.box(x, y + 1.0, 0, 0.06, 0.06, 2 * hl, RAIL);
        for (let z = -hl; z <= hl + 1e-6; z += 3) b.box(x, y + 0.5, z, 0.05, 1.0, 0.05, RAIL);
      }
      for (const z of [-hl, hl]) b.box(0, y + 1.0, z, 2 * hw, 0.06, 0.06, RAIL);
    };
    railsAt(11.6, 8.8, 30);
    railsAt(13.6, 6.4, 17.5);
    // end ramps (vehicle loading aprons) and the bow door frames
    for (const z of [-44, 44]) b.box(0, 4.0, z, 8, 0.4, 2.5, DECK_GREY);
  }
}

const HATCH = mat(0x5f6a60, 0.75, 0.2);
const LASHING = mat(0xd8c24a, 0.6, 0.3);
/** Container colours seen on real ships (Maersk blue, MSC beige, Evergreen green, Hapag orange, ONE magenta, CMA CGM blue, greys…). */
const CONTAINER_COLORS = [0x3c9cc8, 0xcdb68a, 0x2f7a41, 0xd9641f, 0xa52a6b, 0x1d3f8f, 0x8c9196, 0xe3e1da, 0xa22b2a, 0x7a4c30, 0x2b4d99, 0x5f6b72, 0xc8c3b5, 0x3c9cc8, 0x8c9196].map((c) => mat(c, 0.62, 0.15));

function containerShip(b: MeshBuilder, lod: number, variant: number): void {
  const L = 294;
  const B = 32.3;
  const F = 10.5;
  buildHull(b, {
    L, B, F, D: 12, sheer: 0.25, transom: 0.86, transomDepth: 0.4, entry: 2.4, n: 5, rake: 7,
    topside: WHITE_T, boot: mat(0x8c2a22, 0.7), bottom: ANTIFOUL_RED, deck: DECK_GREY, rub: WHITE_T, bootTop: 1.2, stations: lod ? 12 : 30,
  });
  const spec = { L, B, F, D: 12, sheer: 0.25, transom: 0.86, transomDepth: 0.4, entry: 2.4, n: 5, rake: 7 } as HullSpec;
  bulbousBow(b, spec, 4.2, 22, lod, ANTIFOUL_RED);
  // forecastle breakwater and mooring deck, windlasses
  b.prism(0, -L / 2 + 26, F + 1.2, F + 4.2, B * 0.78, 1.2, B * 0.75, 0.8, WHITE, 0);
  if (!lod) {
    for (const x of [-5, 5]) b.cylinder([x - 1.2, F + 2.6, -L / 2 + 14], [x + 1.2, F + 2.6, -L / 2 + 14], 0.9, 0.9, 8, mat(0x3a5a3a, 0.6));
    // free-fall lifeboat on its ramp over the stern, rescue boat davit
    const zs = L / 2 - 52 + 7 + 2;
    b.with([0, F + 9, zs + 5], [-28, 0, 0], () => {
      b.box(0, -0.6, 0, 3.4, 0.3, 9.5, DARK);
      b.cylinder([0, 0.9, -4.3], [0, 0.9, 4.3], 1.4, 1.4, 8, ORANGE);
    });
  }
  // accommodation block aft: 7 decks with window bands, bridge + wings, funnel
  const zA = L / 2 - 52;
  const wA = 26;
  const dA = 14;
  let y = F + 1.5;
  for (let k = 0; k < 7; k++) {
    b.prism(0, zA, y, y + 1.95, wA, dA, wA, dA, WHITE, 0, false);
    b.prism(0, zA, y + 1.95, y + 2.65, wA + 0.02, dA + 0.02, wA + 0.02, dA + 0.02, lod ? LIT_FAR : LIT, 0, false);
    b.prism(0, zA, y + 2.65, y + 2.8, wA, dA, wA, dA, WHITE, 0, false);
    y += 2.8;
  }
  b.prism(0, zA, y, y + 1.2, B, dA + 1, B, dA + 1, WHITE, 0, false);
  b.prism(0, zA, y + 1.2, y + 3.0, B + 0.02, dA + 1.02, B + 0.02, dA + 1.02, LIT, 0, false);
  b.prism(0, zA, y + 3.0, y + 3.6, B + 0.6, dA + 1.6, B + 0.6, dA + 1.6, WHITE, 0);
  b.cylinder([0, y + 3.6, zA], [0, y + 10, zA], 0.35, 0.2, 6, WHITE, false);
  const zF = zA + dA / 2 + 7;
  b.prism(0, zF, F + 1, y + 2, 9, 9, 8, 8.5, WHITE, 1.2, false);
  b.prism(0, zF + 1.2, y + 2, y + 5, 8, 8.5, 8, 8.3, mat([0x1d3f8f, 0x0f5c35, 0xc0392b][variant % 3], 0.5), 0.3, false);
  b.prism(0, zF + 1.5, y + 5, y + 6, 8, 8.3, 8, 8.3, BLACK, 0);
  // containers on deck: 40 ft bays × 13 rows, 3–6 tiers
  const bayLen = 12.2;
  const rowW = 2.44;
  const tierH = 2.59;
  const rows = 13;
  const z0 = -L / 2 + 30;
  const z1 = zA - dA / 2 - 3;
  const nb = Math.floor((z1 - z0) / (bayLen + 0.6));
  for (let bay = 0; bay < nb; bay++) {
    const zc = z0 + (bay + 0.5) * (bayLen + 0.6);
    // hull narrows toward the bow: fewer rows in the forward bays
    const u = 1 - (zc + L / 2) / L;
    const hb = hullShape({ L, B, F, D: 12, sheer: 0.25, transom: 0.86, transomDepth: 0.4, entry: 2.4, n: 5, rake: 7 } as HullSpec, u).halfB;
    const nr = Math.max(3, Math.min(rows, Math.floor((2 * hb - 1.5) / rowW)));
    // hatch cover under the stack and a lashing bridge at the bay's aft end
    b.box(0, F + 0.5, zc, nr * rowW + 0.6, 1.0, bayLen + 0.3, HATCH, { bottom: true });
    if (!lod && bay % 2 === 1) b.box(0, F + 3.6, zc + bayLen / 2 + 0.3, nr * rowW + 0.8, 5.2, 0.35, LASHING, { bottom: true });
    for (let r = 0; r < nr; r++) {
      const xc = (r - (nr - 1) / 2) * rowW;
      const tiers = 3 + Math.floor(h01(911 + variant, bay, r) * 4);
      if (lod) {
        const col = CONTAINER_COLORS[Math.floor(h01(913 + variant, bay, r) * CONTAINER_COLORS.length)];
        b.box(xc, F + 1 + (tiers * tierH) / 2, zc, rowW - 0.08, tiers * tierH, bayLen, col, { bottom: true });
        continue;
      }
      for (let t = 0; t < tiers; t++) {
        const col = CONTAINER_COLORS[Math.floor(h01(912 + variant, bay * 16 + r, t) * CONTAINER_COLORS.length)];
        b.box(xc, F + 1 + (t + 0.5) * tierH, zc, rowW - 0.08, tierH - 0.06, bayLen, col, { bottom: true, top: t < tiers - 1 });
      }
    }
  }
}

function tanker(b: MeshBuilder, lod: number, variant: number): void {
  const L = 250;
  const B = 44;
  const F = 7.5;
  buildHull(b, {
    L, B, F, D: 14, sheer: 0.35, transom: 0.84, transomDepth: 0.45, entry: 2.8, n: 6, rake: 5,
    topside: WHITE_T, boot: mat(0x8a2b22, 0.7), bottom: ANTIFOUL_RED, deck: variant % 2 ? DECK_RED : DECK_GREEN, rub: WHITE_T, bootTop: 0.9, stations: lod ? 12 : 30,
  });
  const spec = { L, B, F, D: 14, sheer: 0.35, transom: 0.84, transomDepth: 0.45, entry: 2.8, n: 6, rake: 5 } as HullSpec;
  bulbousBow(b, spec, 5, 24, lod, ANTIFOUL_RED);
  const PIPE = mat(0x8a9296, 0.5, 0.5);
  const PIPE_R = mat(0x9b3a2a, 0.6, 0.3);
  const zc0 = -L / 2 + 34;
  const zc1 = L / 2 - 42;
  const cl = zc1 - zc0;
  const cm = (zc0 + zc1) / 2;
  // raised catwalk on posts along the centreline
  b.box(0, F + 2.4, cm, 1.4, 0.15, cl, mat(0x9aa3a8, 0.6, 0.4));
  if (lod) b.box(0, F + 1.0, cm, 7, 1.2, cl, PIPE, { bottom: true });
  else {
    for (let z = zc0; z <= zc1; z += 12) b.box(0, F + 1.2, z, 0.25, 2.4, 0.25, PIPE);
    // cargo, stripping and vapour lines either side of the catwalk (and a red fire main)
    for (const [x, r, m] of [[-3.4, 0.45, PIPE], [-2.3, 0.35, PIPE], [-1.3, 0.3, PIPE], [1.3, 0.3, PIPE], [2.3, 0.35, PIPE], [3.4, 0.45, PIPE], [-5.2, 0.2, PIPE_R]] as [number, number, Mat][])
      b.cylinder([x, F + 0.9, zc0], [x, F + 0.9, zc1], r, r, 6, m, false);
    // tank hatches and ullage domes in two rows
    for (let z = zc0 + 8; z < zc1 - 4; z += 22)
      for (const x of [-10, 10]) {
        b.cylinder([x, F, z], [x, F + 0.9, z], 1.1, 1.1, 8, mat(0x8b9a86, 0.7));
        b.box(x * 1.35, F + 0.6, z + 6, 1.4, 1.2, 1.4, WHITE);
      }
    // manifold: transverse lines with valve blocks and drip trays at both sides, midships
    for (let k = 0; k < 6; k++) {
      const z = -12 + (k - 2.5) * 2.6;
      b.cylinder([-B * 0.42, F + 1.3, z], [B * 0.42, F + 1.3, z], 0.35, 0.35, 6, PIPE, false);
      for (const x of [-B * 0.42, B * 0.42]) b.box(x, F + 1.3, z, 1.0, 1.0, 1.0, mat(0x2b5aa0, 0.5, 0.3));
    }
    for (const x of [-B * 0.43, B * 0.43]) b.box(x, F + 0.2, -12, 2.2, 0.4, 16, DARK);
    // hose-handling cranes: kingpost, jib, hook block
    for (const x of [-12, 12]) {
      b.cylinder([x, F, -12], [x, F + 11, -12], 0.6, 0.45, 8, WHITE, false);
      b.box(x, F + 11.5, -12, 1.6, 1.4, 2.2, WHITE);
      b.cylinder([x, F + 11.5, -12], [x * 0.35, F + 15, -26], 0.35, 0.22, 6, WHITE, false);
      b.cylinder([x * 0.35, F + 15, -26], [x * 0.35, F + 9, -26], 0.03, 0.03, 3, DARK, false);
    }
    // foam monitors on posts in front of the accommodation and along the deck
    for (let z = zc0 + 20; z < zc1; z += 45) for (const x of [-7, 7]) b.cylinder([x, F, z], [x, F + 2.8, z], 0.12, 0.12, 5, RED, false);
  }
  // raised forecastle with the mooring deck
  b.prism(0, -L / 2 + 13, F, F + 2.6, B * 0.5, 22, B * 0.5, 22, WHITE_T, 0.0);
  if (!lod) for (const x of [-4.5, 4.5]) b.cylinder([x - 1.3, F + 3.4, -L / 2 + 10], [x + 1.3, F + 3.4, -L / 2 + 10], 1.0, 1.0, 8, mat(0x3a5a3a, 0.6));
  b.prism(0, -L / 2 + 20, F + 1.0, F + 3.2, B * 0.7, 1.2, B * 0.68, 0.8, WHITE, 0);
  // accommodation aft
  const zA = L / 2 - 30;
  let y = F + 1;
  for (let k = 0; k < 5; k++) {
    b.prism(0, zA, y, y + 1.95, 30, 16, 30, 16, WHITE, 0, false);
    b.prism(0, zA, y + 1.95, y + 2.65, 30.02, 16.02, 30.02, 16.02, lod ? LIT_FAR : LIT, 0, false);
    b.prism(0, zA, y + 2.65, y + 2.8, 30, 16, 30, 16, WHITE, 0, false);
    y += 2.8;
  }
  b.prism(0, zA, y, y + 1.2, B, 17, B, 17, WHITE, 0, false);
  b.prism(0, zA, y + 1.2, y + 3.0, B + 0.02, 17.02, B + 0.02, 17.02, LIT, 0, false);
  b.prism(0, zA, y + 3.0, y + 3.6, B + 0.6, 17.6, B + 0.6, 17.6, WHITE, 0);
  b.cylinder([0, y + 3.6, zA], [0, y + 9, zA], 0.35, 0.2, 6, WHITE, false);
  b.prism(0, zA + 15, F + 1, y + 3, 10, 10, 9, 9, WHITE, 1.5, false);
  b.prism(0, zA + 16.5, y + 3, y + 6, 9, 9, 9, 9, mat([0xc0392b, 0x1d3f8f, 0xd9b21c][variant % 3], 0.5), 0.2, false);
  b.prism(0, zA + 16.8, y + 6, y + 7, 9, 9, 9, 9, BLACK, 0);
}

// ─── Public ──────────────────────────────────────────────────────────────────

export interface VesselGeometrySet {
  kind: VesselKind | 'sailRig';
  part: VesselPart;
  lod: number;
  builder: MeshBuilder;
}

/** Builds the mesh for one vessel part at a level of detail (0 = near, 1 = far). */
export function buildVesselPart(kind: VesselKind, part: VesselPart, lod: number, opts: { moored?: boolean; variant?: number; deployed?: boolean } = {}): MeshBuilder {
  const b = new MeshBuilder();
  const v = opts.variant ?? 0;
  if (kind === 'sail') {
    const r = SAIL_RIG;
    if (part === 'hull') sailHull(b, lod, !!opts.moored);
    else if (part === 'furled') furled(b, lod);
    else {
      // sails are built around the mast base so the instance can swing them about the mast
      b.with([0, 0, -r.mastZ], null, () => {
        if (part === 'mainP' || part === 'mainS') mainsail(b, part === 'mainP' ? 1 : -1, lod);
        else jib(b, part === 'jibP' ? 1 : -1, lod);
      });
    }
    return b;
  }
  switch (kind) {
    case 'motor':
      motorYacht(b, lod);
      break;
    case 'fish':
      fishingBoat(b, lod, !!opts.deployed);
      break;
    case 'launch':
      launch(b, lod);
      break;
    case 'ferry':
      ferry(b, lod);
      break;
    case 'container':
      containerShip(b, lod, v);
      break;
    case 'tanker':
      tanker(b, lod, v);
      break;
  }
  return b;
}

/** Instance colours for tinted hull paint (linear RGB-ish multipliers of white). */
export const HULL_TINTS: Record<VesselKind, number[]> = {
  sail: [0xffffff, 0xffffff, 0xf2efe6, 0x1b2a4a, 0x0f3d2e, 0xffffff, 0x7b1f1f, 0xdfe6ea],
  motor: [0xffffff, 0xffffff, 0xeef0f2, 0x1a1d22, 0x2b3f5c, 0xffffff, 0xdad6cc, 0x9aa4ad],
  fish: [0x1d3a6b, 0xa3261f, 0x1f5a3a, 0x2a3a4a, 0x1d3a6b, 0xb03a1f, 0x274b6b, 0x333333],
  launch: [0xffffff, 0xe8e8e8, 0xb8c2cc, 0x2d4a6b, 0xffffff, 0xd8d0c0, 0x9a2a20, 0xffffff],
  ferry: [0xffffff],
  container: [0x1b2a3f, 0x232426, 0x1b3a2a, 0x4a4f55],
  tanker: [0x2a1d1b, 0x1a1c1e, 0x5a1c16],
};

export const RED_LIGHT = RED;
export const GREEN_LIGHT = GREEN_L;
export const RUST_MAT = RUST;
export { WHITE, OFFWHITE, DARK, STAINLESS };
