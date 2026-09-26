/**
 * Harbour obstacles (PURE, no three.js): the Port Chateau marina's structures (quay wall and its
 * bollards and lamps, the harbour works on the quay, rubble-mound breakwaters with their parapets
 * and entrance beacons, floating pontoons, fingers, piles, gangways, the visitors' pontoon), the
 * boats moored in it, and the bay ferry terminals, as the physics' obstacle columns: `top(x, z)`
 * = the height (m MSL) of whatever solid stands at (x, z), or −Infinity over open water / land.
 * The berth water stays free, so a hull can lie alongside a pontoon or leave its berth.
 *
 * Built from the same layout data (`MarinaLayout`, `FerryTerminal`) and dimensions the models in
 * models/marina.ts draw (`HARBOUR_DIMS` is shared with them); tests/world/traffic/harbourObstacles
 * samples the drawn geometry against this function. Fast: a world-box reject, then one lookup in a
 * 6 m grid of primitives in the structure's own frame (the physics asks ~30× per step at 120 Hz).
 */
import { VESSEL_DIMS, type FerryTerminal, type MarinaLayout } from './sea';
import { h01 } from './rng';

/** Dimensions shared by the drawn marina (models/marina.ts) and the obstacles. */
export const HARBOUR_DIMS = {
  pileTop: 3.05,
  pileRadius: 0.26,
  fingerTop: 0.55,
  beaconTop: 9.8,
  beaconRadius: 0.9,
  /** Wave wall on the seaward edge of a breakwater crest: height above the crest, width, inset. */
  parapetH: 1.2,
  parapetW: 0.9,
  parapetInset: 0.45,
  quayBollardTop: 0.55,
  cleatTop: 0.2,
  signTop: 2.3,
  /** The ferry terminal's deck height. */
  terminalDeckY: 4.4,
} as const;

// ─── Primitives (in a local frame: u along, w across; heights m MSL) ────────────────────────────

/** Axis-aligned box. */
interface BoxP {
  k: 0;
  u0: number;
  u1: number;
  w0: number;
  w1: number;
  top: number;
}
/** Vertical cylinder. */
interface DiscP {
  k: 1;
  u: number;
  w: number;
  r: number;
  top: number;
}
/** Cone / mound: flat top y1 within r1, falling linearly to y0 at r0. */
interface ConeP {
  k: 2;
  u: number;
  w: number;
  r1: number;
  y1: number;
  r0: number;
  y0: number;
}
/** A profile swept along a segment: height = lerp(y0, y1, t) + prof(d), d = distance from the segment. */
interface SweepP {
  k: 3;
  au: number;
  aw: number;
  bu: number;
  bw: number;
  y0: number;
  y1: number;
  /** [d, y] pairs, ascending d; beyond the last d nothing. */
  prof: readonly (readonly [number, number])[];
}
type Prim = BoxP | DiscP | ConeP | SweepP;

const CELL = 6;

/** A set of primitives in one local frame, bucketed on a grid. */
export interface ObstacleSet {
  /** Frame: world = o + u·U + w·W. */
  ox: number;
  oz: number;
  ux: number;
  uz: number;
  wx: number;
  wz: number;
  /** World bounding box (fast reject). */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Local grid. */
  u0: number;
  w0: number;
  nu: number;
  nw: number;
  cells: Prim[][];
  count: number;
}

function primBounds(p: Prim): [number, number, number, number] {
  switch (p.k) {
    case 0:
      return [p.u0, p.u1, p.w0, p.w1];
    case 1:
      return [p.u - p.r, p.u + p.r, p.w - p.r, p.w + p.r];
    case 2:
      return [p.u - p.r0, p.u + p.r0, p.w - p.r0, p.w + p.r0];
    case 3: {
      const r = p.prof[p.prof.length - 1][0];
      return [Math.min(p.au, p.bu) - r, Math.max(p.au, p.bu) + r, Math.min(p.aw, p.bw) - r, Math.max(p.aw, p.bw) + r];
    }
  }
}

function buildSet(frame: { ox: number; oz: number; ux: number; uz: number; wx: number; wz: number }, prims: Prim[]): ObstacleSet {
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  const bounds = prims.map(primBounds);
  for (const [p0, p1, q0, q1] of bounds) {
    a0 = Math.min(a0, p0);
    a1 = Math.max(a1, p1);
    b0 = Math.min(b0, q0);
    b1 = Math.max(b1, q1);
  }
  const nu = Math.max(1, Math.ceil((a1 - a0) / CELL));
  const nw = Math.max(1, Math.ceil((b1 - b0) / CELL));
  const cells: Prim[][] = Array.from({ length: nu * nw }, () => []);
  prims.forEach((p, i) => {
    const [p0, p1, q0, q1] = bounds[i];
    const i0 = Math.max(0, Math.floor((p0 - a0) / CELL));
    const i1 = Math.min(nu - 1, Math.floor((p1 - a0) / CELL));
    const j0 = Math.max(0, Math.floor((q0 - b0) / CELL));
    const j1 = Math.min(nw - 1, Math.floor((q1 - b0) / CELL));
    for (let j = j0; j <= j1; j++) for (let ii = i0; ii <= i1; ii++) cells[j * nu + ii].push(p);
  });
  // world box of the local box's corners
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const u of [a0, a1])
    for (const w of [b0, b1]) {
      const x = frame.ox + frame.ux * u + frame.wx * w;
      const z = frame.oz + frame.uz * u + frame.wz * w;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
  return { ...frame, minX, maxX, minZ, maxZ, u0: a0, w0: b0, nu, nw, cells, count: prims.length };
}

function primTop(p: Prim, u: number, w: number): number {
  switch (p.k) {
    case 0:
      return u >= p.u0 && u <= p.u1 && w >= p.w0 && w <= p.w1 ? p.top : -Infinity;
    case 1: {
      const du = u - p.u;
      const dw = w - p.w;
      return du * du + dw * dw <= p.r * p.r ? p.top : -Infinity;
    }
    case 2: {
      const d = Math.hypot(u - p.u, w - p.w);
      if (d > p.r0) return -Infinity;
      if (d <= p.r1) return p.y1;
      return p.y1 + ((p.y0 - p.y1) * (d - p.r1)) / (p.r0 - p.r1);
    }
    case 3: {
      const vu = p.bu - p.au;
      const vw = p.bw - p.aw;
      const L2 = vu * vu + vw * vw || 1;
      let t = ((u - p.au) * vu + (w - p.aw) * vw) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(u - p.au - vu * t, w - p.aw - vw * t);
      const pr = p.prof;
      if (d > pr[pr.length - 1][0]) return -Infinity;
      let y = pr[0][1];
      if (d > pr[0][0]) {
        for (let i = 1; i < pr.length; i++) {
          if (d <= pr[i][0]) {
            y = pr[i - 1][1] + ((pr[i][1] - pr[i - 1][1]) * (d - pr[i - 1][0])) / (pr[i][0] - pr[i - 1][0]);
            break;
          }
        }
      }
      return p.y0 + (p.y1 - p.y0) * t + y;
    }
  }
}

/** Top of an obstacle set at a world point (m MSL), −Infinity where nothing stands. */
export function obstacleSetTop(s: ObstacleSet, x: number, z: number): number {
  if (x < s.minX || x > s.maxX || z < s.minZ || z > s.maxZ) return -Infinity;
  const dx = x - s.ox;
  const dz = z - s.oz;
  const u = dx * s.ux + dz * s.uz;
  const w = dx * s.wx + dz * s.wz;
  const i = Math.floor((u - s.u0) / CELL);
  const j = Math.floor((w - s.w0) / CELL);
  if (i < 0 || j < 0 || i >= s.nu || j >= s.nw) return -Infinity;
  const cell = s.cells[j * s.nu + i];
  let top = -Infinity;
  for (let k = 0; k < cell.length; k++) {
    const y = primTop(cell[k], u, w);
    if (y > top) top = y;
  }
  return top;
}

// ─── The marina ──────────────────────────────────────────────────────────────

/** The harbour works on the quay (models/marina.ts HARBOUR_WORKS, repeated here to stay pure). */
const WORKS = { u0: 228, u1: 348, crane: { u: 302, w: -14, pivotY: 27, boom: 44, luffDeg: 36 }, lift: { u: 334, w: -5 } } as const;

export interface MarinaObstacleOptions {
  /** Include the moored boats' hulls (default true). */
  boats?: boolean;
}

/** Primitives of the marina in its (u, w) frame. */
export function marinaPrims(m: MarinaLayout, opts: MarinaObstacleOptions = {}): Prim[] {
  const P: Prim[] = [];
  const D = HARBOUR_DIMS;
  const q = m.quay;
  // ── quay wall, bollards, lamp posts ──
  P.push({ k: 0, u0: q.u0, u1: q.u1, w0: q.w0, w1: q.w1, top: q.top });
  for (let u = q.u0 + 10; u < q.u1 - 5; u += 16) P.push({ k: 1, u, w: q.w1 - 0.8, r: 0.26, top: q.top + D.quayBollardTop });
  for (let u = q.u0 + 30; u < q.u1; u += 60) P.push({ k: 1, u, w: q.w0 + 4.15, r: 0.3, top: q.top + 6.2 });
  // ── harbour works: crane, container yard, boatyard ──
  const c = WORKS.crane;
  const top = q.top;
  P.push({ k: 0, u0: c.u - 8.3, u1: c.u + 8.3, w0: c.w - 6.3, w1: c.w + 6.3, top: top + 1.5 });
  P.push({ k: 0, u0: c.u - 6, u1: c.u + 6, w0: c.w - 4, w1: c.w + 4, top: top + 2.5 });
  // tower and slewing house (slewed −90°: the house spans u − 3 … u + 8.5, w ± 3.2)
  P.push({ k: 0, u0: c.u - 3, u1: c.u + 8.5, w0: c.w - 3.2, w1: c.w + 3.2, top: top + c.pivotY + 0.75 });
  // boom: luffed up along −u from the house to the tip; the box hangs from the tip on the spreader
  const lr = (c.luffDeg * Math.PI) / 180;
  const tipU = c.u - (2.5 + Math.cos(lr) * (c.boom + 0.4));
  const tipY = top + c.pivotY + 0.8 + Math.sin(lr) * (c.boom + 0.4);
  P.push({ k: 3, au: c.u - 2.5, aw: c.w, bu: tipU, bw: c.w, y0: top + c.pivotY + 0.8, y1: tipY, prof: [[1.2, 1.2]] });
  P.push({ k: 0, u0: tipU - 6.1, u1: tipU + 6.1, w0: c.w - 1.25, w1: c.w + 1.25, top: top + 11.5 + 4 });
  const yard = { u0: 236, w0: -23.5 };
  for (let blk = 0; blk < 2; blk++)
    for (let row = 0; row < 5; row++)
      for (let bay = 0; bay < 2; bay++) {
        const u = yard.u0 + blk * 27 + bay * 12.6 + 6.1;
        const w = yard.w0 + row * 2.6 + 1.25;
        // stacked tiers: the same hash models/marina.ts stacks them with
        const tiers = 1 + Math.floor(h01(501, blk * 10 + row, bay) * 3);
        P.push({ k: 0, u0: u - 6.1, u1: u + 6.1, w0: w - 1.22, w1: w + 1.22, top: top + tiers * 2.59 });
      }
  const tl = WORKS.lift;
  P.push({ k: 0, u0: tl.u - 4.6, u1: tl.u + 4.6, w0: tl.w - 3.8, w1: tl.w + 3.8, top: top + 10.95 });
  for (const [u, w, L] of [[312, -19.5, 10], [322, -20.5, 12.5], [344, -19.5, 9]]) {
    const keelY = top + L * 0.07 + 0.9;
    P.push({ k: 0, u0: u - L * 0.5, u1: u + L * 0.5, w0: w - L * 0.16, w1: w + L * 0.16, top: keelY + L * 0.24 });
  }
  // ── breakwaters: rubble mound (crest, armour slopes and the stones on them), wave wall, heads ──
  for (const bw of m.breakwaters) {
    // crest path, then the armour slope with the stones on it: an envelope of the drawn stones
    // (they stand up to ~1 m proud of the crest at its edge), down to the toe
    const prof: [number, number][] = [
      [bw.crestHalf, bw.crestY],
      [bw.crestHalf + 0.6, bw.crestY + 0.8],
      [bw.crestHalf + 1.8, bw.crestY + 0.7],
      [bw.crestHalf + 2.6, bw.crestY],
      [bw.baseHalf * 0.5, 2.3],
      [bw.baseHalf * 0.5 + 1, 1.5],
      [bw.baseHalf * 0.5 + 1.6, 0.8],
      [bw.baseHalf * 0.5 + 2, -1],
      [bw.baseHalf * 0.72, -2.2],
    ];
    for (let i = 1; i < bw.pts.length; i++) {
      const a = bw.pts[i - 1];
      const b = bw.pts[i];
      P.push({ k: 3, au: a.u, aw: a.w, bu: b.u, bw: b.w, y0: 0, y1: 0, prof });
      // the wave wall on the seaward edge (the side farther from the basin centre (0, 150))
      const du = b.u - a.u;
      const dw = b.w - a.w;
      const l = Math.hypot(du, dw) || 1;
      let nu = dw / l;
      let nw = -du / l;
      const mu = (a.u + b.u) / 2;
      const mw = (a.w + b.w) / 2;
      if (Math.hypot(mu + nu * 5, mw + nw * 5 - 150) < Math.hypot(mu - nu * 5, mw - nw * 5 - 150)) {
        nu = -nu;
        nw = -nw;
      }
      const off = bw.crestHalf - D.parapetInset;
      P.push({ k: 3, au: a.u + nu * off, aw: a.w + nw * off, bu: b.u + nu * off, bw: b.w + nw * off, y0: 0, y1: 0, prof: [[D.parapetW / 2 + 0.05, bw.crestY + D.parapetH]] });
    }
    const end = bw.pts[bw.pts.length - 1];
    P.push({ k: 2, u: end.u, w: end.w, r1: bw.crestHalf + 1, y1: bw.crestY + 0.2, r0: bw.baseHalf, y0: bw.baseY });
    const start = bw.pts[0];
    P.push({ k: 2, u: start.u, w: start.w, r1: bw.crestHalf, y1: bw.crestY, r0: bw.baseHalf * 0.9, y0: bw.baseY });
  }
  for (const bc of m.beacons) P.push({ k: 1, u: bc.u, w: bc.w, r: D.beaconRadius, top: D.beaconTop });
  // ── pontoons, gangways, fingers, piles ──
  for (const p of m.pontoons) {
    P.push({ k: 0, u0: p.u - p.half, u1: p.u + p.half, w0: p.w0, w1: p.w1, top: p.top + 0.02 });
    // gangway: from the quay coping down to the pontoon deck
    P.push({ k: 3, au: p.u, aw: q.w1 - 1, bu: p.u, bw: p.w0 + 4, y0: q.top + 0.1, y1: p.top + 0.1, prof: [[0.7, 0]] });
  }
  for (const f of m.fingers) P.push({ k: 0, u0: f.u0, u1: f.u1, w0: f.w - f.half, w1: f.w + f.half, top: D.fingerTop });
  for (const pl of m.piles) P.push({ k: 1, u: pl.u, w: pl.w, r: D.pileRadius, top: D.pileTop });
  // ── the visitors' pontoon ──
  const v = m.visitor;
  P.push({ k: 0, u0: v.u - v.half, u1: v.u + v.half, w0: v.w0, w1: v.w1, top: v.top + 0.02 });
  for (const cl of v.cleats) P.push({ k: 0, u0: cl.u - 0.1, u1: cl.u + 0.1, w0: cl.w - 0.2, w1: cl.w + 0.2, top: v.top + D.cleatTop });
  for (const pl of v.piles) P.push({ k: 1, u: pl.u, w: pl.w, r: D.pileRadius, top: D.pileTop });
  P.push({ k: 0, u0: v.sign.u - 0.55, u1: v.sign.u + 0.55, w0: v.sign.w - 0.1, w1: v.sign.w + 0.1, top: v.top + D.signTop });
  // ── moored boats (their hulls up to the deck edge) ──
  if (opts.boats !== false) {
    const f = m.frame;
    for (const b of m.berths) {
      const d = VESSEL_DIMS[b.kind];
      const dx = b.x - f.ox;
      const dz = b.z - f.oz;
      const u = dx * f.ux + dz * f.uz;
      const w = dx * f.wx + dz * f.wz;
      // moored heading is along ±u (pontoon berths) or ±w (alongside the breakwater)
      const alongU = Math.abs(Math.cos(((b.heading - f.headingU) * Math.PI) / 180)) > 0.7;
      const hl = (d.length * b.scale * 0.94) / 2;
      const hb = (d.beam * b.scale * 0.9) / 2;
      const [hu, hw] = alongU ? [hl, hb] : [hb, hl];
      P.push({ k: 0, u0: u - hu, u1: u + hu, w0: w - hw, w1: w + hw, top: d.freeboard * b.scale });
    }
  }
  return P;
}

const marinaCache = new WeakMap<MarinaLayout, ObstacleSet>();

/** The marina as an obstacle set (cached per layout object). */
export function marinaObstacles(m: MarinaLayout, opts: MarinaObstacleOptions = {}): ObstacleSet {
  const cacheable = opts.boats !== false;
  const hit = cacheable ? marinaCache.get(m) : undefined;
  if (hit) return hit;
  const f = m.frame;
  const s = buildSet(f, marinaPrims(m, opts));
  if (cacheable) marinaCache.set(m, s);
  return s;
}

/** Height (m MSL) of the marina's structures (and moored boats) at a world point; −Infinity over open water. */
export function marinaObstacleTop(m: MarinaLayout, x: number, z: number): number {
  return obstacleSetTop(marinaObstacles(m), x, z);
}

// ─── Ferry terminals ─────────────────────────────────────────────────────────

/** Primitives of a ferry terminal in its model frame (u = out along the pier, w = to its right). */
export function terminalPrims(pierLen: number): Prim[] {
  const y = HARBOUR_DIMS.terminalDeckY;
  const P: Prim[] = [];
  P.push({ k: 0, u0: -20, u1: pierLen, w0: -5.5, w1: 5.5, top: y });
  for (const s of [-1, 1]) P.push({ k: 0, u0: -20, u1: pierLen, w0: s * 5.4 - 0.13, w1: s * 5.4 + 0.13, top: y + 1.0 });
  P.push({ k: 0, u0: pierLen, u1: pierLen + 14, w0: -4.5, w1: 4.5, top: y - 0.25 });
  for (const s of [-1, 1]) P.push({ k: 0, u0: pierLen + 0.4, u1: pierLen + 1.6, w0: s * 5.5 - 0.6, w1: s * 5.5 + 0.6, top: y + 10 });
  P.push({ k: 0, u0: pierLen + 0.3, u1: pierLen + 1.7, w0: -6.2, w1: 6.2, top: y + 10.6 });
  for (const x of [pierLen + 20, pierLen + 50, pierLen + 80]) for (const s of [-1, 1]) P.push({ k: 1, u: x, w: s * 13, r: 1.6, top: 5.8 });
  P.push({ k: 0, u0: -37.5, u1: -14.5, w0: 7.5, w1: 20.5, top: 7.4 });
  return P;
}

/** A ferry terminal as an obstacle set (world frame from the pier root and its heading). */
export function terminalObstacles(t: FerryTerminal): ObstacleSet {
  const h = (t.heading * Math.PI) / 180;
  const ux = Math.sin(h);
  const uz = -Math.cos(h);
  return buildSet({ ox: t.x, oz: t.z, ux, uz, wx: -uz, wz: ux }, terminalPrims(t.pierLen));
}

// ─── Combined source for the physics ─────────────────────────────────────────

export interface HarbourObstacles {
  /** Obstacle top at a world point (m MSL), −Infinity where there is none: pass to `registerObstacleSource`. */
  top(x: number, z: number): number;
  /** Adds the ferry terminals once the sea plan knows them. */
  setTerminals(ts: readonly FerryTerminal[]): void;
  readonly sets: readonly ObstacleSet[];
}

export function createHarbourObstacles(m: MarinaLayout, terminals: readonly FerryTerminal[] = []): HarbourObstacles {
  let sets: ObstacleSet[] = [marinaObstacles(m), ...terminals.map(terminalObstacles)];
  return {
    top(x, z) {
      let top = -Infinity;
      for (let i = 0; i < sets.length; i++) {
        const y = obstacleSetTop(sets[i], x, z);
        if (y > top) top = y;
      }
      return top;
    },
    setTerminals(ts) {
      sets = [marinaObstacles(m), ...ts.map(terminalObstacles)];
    },
    get sets() {
      return sets;
    },
  };
}
