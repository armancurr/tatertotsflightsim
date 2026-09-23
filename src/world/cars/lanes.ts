/**
 * The drivable lane graph (PURE, no three.js), built from the roads' lane data
 * (`activeRoads().lanes`, see src/world/roads/builder.ts LaneData).
 *
 * Right-hand traffic. Every road piece carries two directed lanes:
 *   lane 2p     "forward"  — travels with increasing arc length s, on the right (+across)
 *   lane 2p + 1 "backward" — travels with decreasing s, on the other side (−across)
 * A lane is addressed by u ∈ [0, len] from its ENTRY end. `across` is measured
 * right of the piece's increasing-s direction (the piece normals), so a lane's
 * point is centreline(s) + normal(s)·across.
 *
 * Offsets per kind (roads/markings.ts): highway lanes 3.65 m either side of the
 * double yellow, two-lane roads in the middle of their ≤3.3 m lanes, streets
 * split their carriageway (paved width minus parking bands) in two, farm tracks
 * are one shared lane on the centreline (single = one vehicle per piece).
 * Town streets with sidewalks park cars at the kerb: city arterials (≥ 9.5 m)
 * both sides, other grid streets one side (per piece); the moving lanes shift
 * away from the parked side so nothing overlaps.
 *
 * Junctions: each piece end at a node has a CLEAR distance — the junction box
 * edge (the crossing road's half width at the crossing angle + 1.2 m rural,
 * + 4 m in town where the crosswalk and stop bar are). A lane's EXIT is at
 * u = len − clear; CONNECTORS (cubic Béziers, arc-length tables) join an
 * in-lane's exit to an out-lane's entry (u = clear) through the box. Each
 * connector knows its turn speed (lateral acceleration), its priority (the
 * road that passes through wins, then rank), whether its approach must stop
 * (town, all-way/2-way stops) or yield, and which other connectors of the node
 * CONFLICT with it (paths closer than CONFLICT_DIST, or the same out-lane).
 * Dead ends: U-turn connectors (streets, lanes, tracks) or despawn (highways and
 * roads at the edge of the map). Every in-lane at a node also has a fallback
 * U-turn (used when no exit suits the vehicle).
 */
import { PIECE_F, PIECE_I, PT, type LaneData } from '../roads/builder';
import { hash2i } from '../noise';
import { CONFIG } from '../../config';

export type CarsConfig = typeof CONFIG.world.cars;

/** Road kind ids (roads/plan.ts KIND_ID). */
export const KIND = { highway: 0, road: 1, access: 2, lane: 3, street: 4, drive: 5 } as const;
/** Road rank by kind id (roads/network.ts KIND_RANK). */
export const RANK = [5, 4, 3, 2, 1, 0];
/** Piece flags (LaneData): sidewalk, town arterial, bridge. */
export const FLAG = { sidewalk: 1, arterial: 2, bridge: 4 } as const;
/** Width of a kerbside parking band (kerb → inner edge of the parked car + clearance), m. */
export const PARK_BAND = 2.3;
/** Gap between the kerb and a parked car's side, m. */
export const PARK_KERB = 0.22;
/** Two connectors whose centre paths come closer than this conflict, m. */
export const CONFLICT_DIST = 2.7;
/** A U-turn at a junction starts this far before the stop line, m. */
export const UTURN_BACK = 12;
/** Samples per connector arc-length table. */
export const CONN_SAMPLES = 16;

export interface PieceLayout {
  /** Across offset of the forward / backward lane centre, m (+ = right of increasing s). */
  fwd: number;
  bwd: number;
  /** Kerb parking: 1 = right side (+across), 2 = left side, 3 = both. */
  park: number;
  /** Widest vehicle that fits its lane without touching the other lane or the parked cars, m. */
  maxWidth: number;
  /** One shared lane (farm tracks): one vehicle per piece. */
  single: boolean;
}

/** Lane offsets and kerb parking of one piece. `h` ∈ [0,1) is a stable per-piece hash (parking side). */
export function pieceLayout(kind: number, width: number, flags: number, town: number, h: number): PieceLayout {
  const hw = width / 2;
  if (kind === KIND.drive) return { fwd: 0, bwd: 0, park: 0, maxWidth: Math.max(1.6, width - 0.2), single: true };
  let park = 0;
  if (kind === KIND.street && town >= 0 && flags & FLAG.sidewalk && !(flags & FLAG.bridge)) {
    if (flags & FLAG.arterial) park = width >= 9.5 ? 3 : 0;
    else if (width >= 6.4) park = h < 0.5 ? 1 : 2;
  }
  const a = -hw + (park & 2 ? PARK_BAND : 0);
  const b = hw - (park & 1 ? PARK_BAND : 0);
  let fwd: number;
  let bwd: number;
  if (kind === KIND.highway || kind === KIND.road || kind === KIND.access) {
    // painted lanes either side of the centre line (highway: 3.65 m lanes beside a double yellow)
    const lw = kind === KIND.highway ? Math.min(3.65, hw - 0.3) : Math.min(3.3, hw - 0.2);
    const c0 = kind === KIND.highway ? 0.05 : 0;
    fwd = c0 + lw / 2;
    bwd = -fwd;
  } else {
    const c = (a + b) / 2;
    const q = (b - a) / 4;
    fwd = c + q;
    bwd = c - q;
  }
  const m = (fwd + bwd) / 2;
  const wf = 2 * Math.min(fwd - m, b - fwd);
  const wb = 2 * Math.min(m - bwd, bwd - a);
  return { fwd, bwd, park, maxWidth: Math.min(wf, wb) - 0.1, single: false };
}

export interface LanePoint {
  x: number;
  z: number;
  /** Unit direction of travel. */
  hx: number;
  hz: number;
}

export interface Connector {
  id: number;
  /** Junction node (−1 = the dead end of a piece). */
  node: number;
  inLane: number;
  outLane: number;
  /** Where it leaves the in-lane / joins the out-lane (lane u). */
  inU: number;
  outU: number;
  /** Cubic Bézier control points p0..p3 (x, z pairs). */
  p: Float64Array;
  /** Arc length at t = k / CONN_SAMPLES. */
  lut: Float32Array;
  /** Length, m (0: a plain continuation, no junction box). */
  len: number;
  /** Speed for the tightest part of the path, m/s. */
  vTurn: number;
  /** −1 left, 0 straight, 1 right, 2 U-turn. */
  turn: number;
  /** Right of way (higher wins). */
  prio: number;
  /** Approach control: 0 none (priority road), 1 yield, 2 stop sign. */
  stop: number;
  /** Other connectors of the node that may not be used at the same time. */
  conflicts: number[];
  /** Road kind ids of the in / out piece. */
  kindIn: number;
  kindOut: number;
}

const tmpA: LanePoint = { x: 0, z: 0, hx: 0, hz: 0 };
const tmpB: LanePoint = { x: 0, z: 0, hx: 0, hz: 0 };

export class LaneGraph {
  pieceCount!: number;
  laneCount!: number;
  nodeCount!: number;
  // pieces
  pStart!: Int32Array;
  pCount!: Int32Array;
  pKind!: Uint8Array;
  pTown!: Int32Array;
  pFlags!: Uint8Array;
  pRoad!: Int32Array;
  pWidth!: Float32Array;
  pS0!: Float64Array;
  pLen!: Float64Array;
  pStartNode!: Int32Array;
  pEndNode!: Int32Array;
  /** Junction box clearance at the piece start / end, m. */
  pClearS!: Float32Array;
  pClearE!: Float32Array;
  pPark!: Uint8Array;
  pSingle!: Uint8Array;
  /** Bounding box per piece (x0, z0, x1, z1). */
  pBox!: Float32Array;
  // points
  px!: Float64Array;
  pz!: Float64Array;
  ps!: Float64Array;
  pnx!: Float64Array;
  pnz!: Float64Array;
  /** Posted limit and the limit including curves (m/s). */
  pv!: Float32Array;
  vLim!: Float32Array;
  /** Braking envelopes toward the next curve: forward lanes (ahead = higher index) / backward lanes. */
  vF!: Float32Array;
  vB!: Float32Array;
  // lanes
  laneAcross!: Float32Array;
  laneLen!: Float64Array;
  laneExitU!: Float64Array;
  laneEntryU!: Float64Array;
  laneExitNode!: Int32Array;
  laneMaxW!: Float32Array;
  laneConnStart!: Int32Array;
  laneConnCount!: Int32Array;
  /** U-turn connector at the exit (dead end or fallback), −1 = none. */
  laneUturn!: Int32Array;
  /** 1: vehicles leaving this lane's exit are released (map edge). */
  laneDespawn!: Uint8Array;
  // nodes
  nodeX!: Float32Array;
  nodeZ!: Float32Array;
  connectors: Connector[] = [];
  /** Connector ids per lane exit (CSR into laneConnStart/Count). */
  laneConn!: Int32Array;

  private gen: Generator<void> | null;

  /**
   * Builds the graph. `lazy`: only prepare — call `buildStep(ms)` until it
   * returns true (the build takes ~150 ms, too long for one frame).
   */
  constructor(
    data: LaneData,
    private cfg: CarsConfig = CONFIG.world.cars,
    lazy = false,
  ) {
    this.gen = this.build(data);
    if (!lazy) this.buildStep(Infinity);
  }

  /** Continues a lazy build for up to `ms` milliseconds; true once complete. */
  buildStep(ms: number): boolean {
    if (!this.gen) return true;
    const t0 = performance.now();
    while (true) {
      if (this.gen.next().done) {
        this.gen = null;
        return true;
      }
      if (performance.now() - t0 >= ms) return false;
    }
  }

  get complete(): boolean {
    return this.gen === null;
  }

  private *build(data: LaneData): Generator<void> {
    const cfg = this.cfg;
    const P = data.pieceI.length / PIECE_I;
    this.pieceCount = P;
    this.laneCount = P * 2;
    const npts = data.pts.length / PT;
    this.px = new Float64Array(npts);
    this.pz = new Float64Array(npts);
    this.ps = new Float64Array(npts);
    this.pnx = new Float64Array(npts);
    this.pnz = new Float64Array(npts);
    this.pv = new Float32Array(npts);
    for (let i = 0; i < npts; i++) {
      this.px[i] = data.pts[i * PT];
      this.pz[i] = data.pts[i * PT + 1];
      this.ps[i] = data.pts[i * PT + 2];
      this.pnx[i] = data.pts[i * PT + 3];
      this.pnz[i] = data.pts[i * PT + 4];
      this.pv[i] = data.pts[i * PT + 5];
    }
    this.pStart = new Int32Array(P);
    this.pCount = new Int32Array(P);
    this.pKind = new Uint8Array(P);
    this.pTown = new Int32Array(P);
    this.pFlags = new Uint8Array(P);
    this.pRoad = new Int32Array(P);
    this.pWidth = new Float32Array(P);
    this.pS0 = new Float64Array(P);
    this.pLen = new Float64Array(P);
    this.pStartNode = new Int32Array(P);
    this.pEndNode = new Int32Array(P);
    this.pClearS = new Float32Array(P);
    this.pClearE = new Float32Array(P);
    this.pPark = new Uint8Array(P);
    this.pSingle = new Uint8Array(P);
    this.pBox = new Float32Array(P * 4);
    this.laneAcross = new Float32Array(P * 2);
    this.laneMaxW = new Float32Array(P * 2);
    for (let p = 0; p < P; p++) {
      const I = p * PIECE_I;
      const F = p * PIECE_F;
      this.pRoad[p] = data.pieceI[I];
      this.pKind[p] = data.pieceI[I + 1];
      this.pTown[p] = data.pieceI[I + 2];
      this.pStartNode[p] = data.pieceI[I + 3];
      this.pEndNode[p] = data.pieceI[I + 4];
      this.pStart[p] = data.pieceI[I + 5];
      this.pCount[p] = data.pieceI[I + 6];
      this.pFlags[p] = data.pieceI[I + 7];
      this.pWidth[p] = data.pieceF[F];
      const a = this.pStart[p];
      const b = a + this.pCount[p] - 1;
      // arc length from the points themselves (exactly what lanePoint interpolates)
      this.pS0[p] = this.ps[a];
      this.pLen[p] = Math.max(1e-3, this.ps[b] - this.ps[a]);
      const lay = pieceLayout(this.pKind[p], this.pWidth[p], this.pFlags[p], this.pTown[p], hash2i(p, 0x5a17, 911));
      this.laneAcross[p * 2] = lay.fwd;
      this.laneAcross[p * 2 + 1] = lay.bwd;
      this.laneMaxW[p * 2] = lay.maxWidth;
      this.laneMaxW[p * 2 + 1] = lay.maxWidth;
      this.pPark[p] = lay.park;
      this.pSingle[p] = lay.single ? 1 : 0;
      let x0 = Infinity;
      let z0 = Infinity;
      let x1 = -Infinity;
      let z1 = -Infinity;
      for (let i = a; i <= b; i++) {
        x0 = Math.min(x0, this.px[i]);
        x1 = Math.max(x1, this.px[i]);
        z0 = Math.min(z0, this.pz[i]);
        z1 = Math.max(z1, this.pz[i]);
      }
      this.pBox.set([x0, z0, x1, z1], p * 4);
    }
    const N = data.nodes.length / 2;
    this.nodeCount = N;
    this.nodeX = new Float32Array(N);
    this.nodeZ = new Float32Array(N);
    for (let n = 0; n < N; n++) {
      this.nodeX[n] = data.nodes[n * 2];
      this.nodeZ[n] = data.nodes[n * 2 + 1];
    }

    yield;
    // ── curve speeds and braking envelopes ──
    this.vLim = new Float32Array(npts);
    this.vF = new Float32Array(npts);
    this.vB = new Float32Array(npts);
    const aLat = cfg.lateralAccel;
    const bc = cfg.idm.decel * 0.8;
    for (let p = 0; p < P; p++) {
      const a = this.pStart[p];
      const n = this.pCount[p];
      for (let i = a; i < a + n; i++) {
        let v = this.pv[i];
        if (i > a && i < a + n - 1) {
          const ux = this.px[i] - this.px[i - 1];
          const uz = this.pz[i] - this.pz[i - 1];
          const wx = this.px[i + 1] - this.px[i];
          const wz = this.pz[i + 1] - this.pz[i];
          const l1 = Math.hypot(ux, uz);
          const l2 = Math.hypot(wx, wz);
          if (l1 > 1e-6 && l2 > 1e-6) {
            const th = Math.abs(Math.atan2(ux * wz - uz * wx, ux * wx + uz * wz));
            const k = th / ((l1 + l2) / 2);
            if (k > 1e-6) v = Math.min(v, Math.sqrt(aLat / k));
          }
        }
        this.vLim[i] = Math.max(cfg.minTurnSpeed, v);
      }
      // interior curvature applies to the samples around it too (the simplified polyline turns at a point)
      this.vF[a + n - 1] = this.vLim[a + n - 1];
      for (let i = a + n - 2; i >= a; i--) this.vF[i] = Math.min(this.vLim[i], Math.sqrt(this.vF[i + 1] ** 2 + 2 * bc * (this.ps[i + 1] - this.ps[i])));
      this.vB[a] = this.vLim[a];
      for (let i = a + 1; i < a + n; i++) this.vB[i] = Math.min(this.vLim[i], Math.sqrt(this.vB[i - 1] ** 2 + 2 * bc * (this.ps[i] - this.ps[i - 1])));
    }

    yield;
    // ── junction clearances ──
    const nodeEnds = (n: number): Int32Array => data.nodeEnds.subarray(data.nodeStart[n], data.nodeStart[n + 1]);
    const endDir = (p: number, e: number, out: { x: number; z: number }) => {
      const a = this.pStart[p];
      const b = a + this.pCount[p] - 1;
      const i = e === 1 ? b : a;
      const j = e === 1 ? b - 1 : a + 1;
      const dx = this.px[i] - this.px[j];
      const dz = this.pz[i] - this.pz[j];
      const l = Math.hypot(dx, dz) || 1;
      out.x = dx / l;
      out.z = dz / l;
    };
    const d1 = { x: 0, z: 0 };
    const d2 = { x: 0, z: 0 };
    for (let p = 0; p < P; p++) {
      for (let e = 0; e < 2; e++) {
        const node = e === 1 ? this.pEndNode[p] : this.pStartNode[p];
        let clear = 0;
        if (node >= 0) {
          const ends = nodeEnds(node);
          const i = e === 1 ? this.pStart[p] + this.pCount[p] - 1 : this.pStart[p];
          const off = Math.hypot(this.px[i] - this.nodeX[node], this.pz[i] - this.nodeZ[node]);
          endDir(p, e, d1);
          let ah = 0;
          let town = (this.pFlags[p] & FLAG.sidewalk) !== 0;
          if (ends.length > 2) {
            for (const code of ends) {
              const q = code >> 1;
              if (this.pRoad[q] === this.pRoad[p]) continue;
              endDir(q, code & 1, d2);
              const sin = Math.abs(d1.x * d2.z - d1.z * d2.x);
              ah = Math.max(ah, this.pWidth[q] / 2 / Math.max(0.35, sin));
              if (this.pFlags[q] & FLAG.sidewalk) town = true;
            }
          }
          if (ah > 0) clear = Math.max(0.5, ah + (town ? 4 : 1.2) - off);
        }
        if (e === 1) this.pClearE[p] = clear;
        else this.pClearS[p] = clear;
      }
      const len = this.pLen[p];
      const sum = this.pClearS[p] + this.pClearE[p];
      if (sum > 0.8 * len) {
        const k = (0.8 * len) / sum;
        this.pClearS[p] *= k;
        this.pClearE[p] *= k;
      }
    }

    yield;
    // ── lanes ──
    const L = P * 2;
    this.laneLen = new Float64Array(L);
    this.laneExitU = new Float64Array(L);
    this.laneEntryU = new Float64Array(L);
    this.laneExitNode = new Int32Array(L);
    this.laneUturn = new Int32Array(L).fill(-1);
    this.laneDespawn = new Uint8Array(L);
    for (let l = 0; l < L; l++) {
      const p = l >> 1;
      const back = l & 1;
      const len = this.pLen[p];
      this.laneLen[l] = len;
      this.laneExitNode[l] = back ? this.pStartNode[p] : this.pEndNode[p];
      this.laneExitU[l] = len - (back ? this.pClearS[p] : this.pClearE[p]);
      this.laneEntryU[l] = back ? this.pClearE[p] : this.pClearS[p];
    }

    // ── connectors ──
    const perLane: number[][] = Array.from({ length: L }, () => []);
    const make = (node: number, inLane: number, outLane: number, uturn: boolean): Connector => {
      const c = this.buildConnector(this.connectors.length, node, inLane, outLane, uturn);
      this.connectors.push(c);
      return c;
    };
    for (let n = 0; n < N; n++) {
      const ends = nodeEnds(n);
      const conns: Connector[] = [];
      for (const ci of ends) {
        const pi = ci >> 1;
        const inLane = ci & 1 ? pi * 2 : pi * 2 + 1;
        for (const co of ends) {
          const po = co >> 1;
          if (po === pi) continue;
          const outLane = co & 1 ? po * 2 + 1 : po * 2;
          const c = make(n, inLane, outLane, false);
          conns.push(c);
          perLane[inLane].push(c.id);
        }
        const u = make(n, inLane, inLane ^ 1, true);
        conns.push(u);
        this.laneUturn[inLane] = u.id;
      }
      this.junctionRules(n, ends, conns);
      if (n % 100 === 99) yield;
    }
    // dead ends
    for (let l = 0; l < L; l++) {
      if (this.laneExitNode[l] >= 0) continue;
      const k = this.pKind[l >> 1];
      if (k === KIND.highway || k === KIND.road) {
        this.laneDespawn[l] = 1;
        continue;
      }
      const c = make(-1, l, l ^ 1, true);
      this.laneUturn[l] = c.id;
    }
    yield;
    yield* this.computeConflicts();
    this.laneConnStart = new Int32Array(L);
    this.laneConnCount = new Int32Array(L);
    let total = 0;
    for (let l = 0; l < L; l++) total += perLane[l].length;
    this.laneConn = new Int32Array(total);
    let o = 0;
    for (let l = 0; l < L; l++) {
      this.laneConnStart[l] = o;
      this.laneConnCount[l] = perLane[l].length;
      for (const id of perLane[l]) this.laneConn[o++] = id;
    }
  }

  /** Segment index k (points k, k+1) of piece p containing arc length s (clamped to the piece), searching from a hint. */
  segmentAt(p: number, s: number, hint = -1): number {
    const a = this.pStart[p];
    const last = a + this.pCount[p] - 2;
    const ps = this.ps;
    if (hint >= a && hint <= last) {
      if (s >= ps[hint] && s <= ps[hint + 1]) return hint;
      if (hint < last && s >= ps[hint + 1] && s <= ps[hint + 2]) return hint + 1;
      if (hint > a && s >= ps[hint - 1] && s <= ps[hint]) return hint - 1;
    }
    if (s <= ps[a]) return a;
    if (s >= ps[last + 1]) return last;
    let lo = a;
    let hi = last + 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (ps[m] <= s) lo = m;
      else hi = m;
    }
    return Math.min(lo, last);
  }

  /** Arc length s of piece p at lane u. */
  laneS(l: number, u: number): number {
    const p = l >> 1;
    return l & 1 ? this.pS0[p] + this.pLen[p] - u : this.pS0[p] + u;
  }

  /** Point and travel direction on lane l at u (extrapolated straight beyond the ends); returns the segment (a hint for the next call). */
  lanePoint(l: number, u: number, out: LanePoint, hint = -1): number {
    const p = l >> 1;
    const back = (l & 1) === 1;
    const s = back ? this.pS0[p] + this.pLen[p] - u : this.pS0[p] + u;
    const k = this.segmentAt(p, s, hint);
    const s0 = this.ps[k];
    const s1 = this.ps[k + 1];
    const t = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
    const tc = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = this.px[k] + (this.px[k + 1] - this.px[k]) * t;
    const cz = this.pz[k] + (this.pz[k + 1] - this.pz[k]) * t;
    let nx = this.pnx[k] + (this.pnx[k + 1] - this.pnx[k]) * tc;
    let nz = this.pnz[k] + (this.pnz[k + 1] - this.pnz[k]) * tc;
    const nl = Math.hypot(nx, nz) || 1;
    nx /= nl;
    nz /= nl;
    const acr = this.laneAcross[l];
    out.x = cx + nx * acr;
    out.z = cz + nz * acr;
    // tangent of increasing s from the right normal n = (−dz, dx): d = (nz, −nx)
    out.hx = back ? -nz : nz;
    out.hz = back ? nx : -nx;
    return k;
  }

  /** Posted speed limit at lane u, m/s. */
  speedLimit(l: number, u: number, hint = -1): number {
    const p = l >> 1;
    const k = this.segmentAt(p, this.laneS(l, u), hint);
    return Math.min(this.pv[k], this.pv[k + 1]);
  }

  /** Speed allowed at lane u: the limit, curves here and braking for curves ahead (within the lane), m/s. */
  allowedSpeed(l: number, u: number, hint = -1): number {
    const p = l >> 1;
    const s = this.laneS(l, u);
    const k = this.segmentAt(p, s, hint);
    const seg = Math.min(this.vLim[k], this.vLim[k + 1]);
    const bc2 = 2 * this.cfg.idm.decel * 0.8;
    if (l & 1) {
      const d = Math.max(0, s - this.ps[k]);
      return Math.min(seg, Math.sqrt(this.vB[k] * this.vB[k] + bc2 * d));
    }
    const d = Math.max(0, this.ps[k + 1] - s);
    return Math.min(seg, Math.sqrt(this.vF[k + 1] * this.vF[k + 1] + bc2 * d));
  }

  /** Point and direction at distance w along a connector. */
  connPoint(c: Connector, w: number, out: LanePoint): void {
    const t = this.connT(c, w);
    const p = c.p;
    const u = 1 - t;
    const b0 = u * u * u;
    const b1 = 3 * u * u * t;
    const b2 = 3 * u * t * t;
    const b3 = t * t * t;
    out.x = b0 * p[0] + b1 * p[2] + b2 * p[4] + b3 * p[6];
    out.z = b0 * p[1] + b1 * p[3] + b2 * p[5] + b3 * p[7];
    // derivative
    const d0 = 3 * u * u;
    const d1 = 6 * u * t;
    const d2 = 3 * t * t;
    let dx = d0 * (p[2] - p[0]) + d1 * (p[4] - p[2]) + d2 * (p[6] - p[4]);
    let dz = d0 * (p[3] - p[1]) + d1 * (p[5] - p[3]) + d2 * (p[7] - p[5]);
    const l = Math.hypot(dx, dz);
    if (l < 1e-9) {
      dx = p[6] - p[0];
      dz = p[7] - p[1];
    }
    const l2 = Math.hypot(dx, dz) || 1;
    out.hx = dx / l2;
    out.hz = dz / l2;
  }

  /** Bézier parameter at arc length w (clamped). */
  connT(c: Connector, w: number): number {
    if (c.len <= 0 || w <= 0) return 0;
    if (w >= c.len) return 1;
    const lut = c.lut;
    let lo = 0;
    let hi = CONN_SAMPLES;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (lut[m] <= w) lo = m;
      else hi = m;
    }
    const f = lut[hi] > lut[lo] ? (w - lut[lo]) / (lut[hi] - lut[lo]) : 0;
    return (lo + f) / CONN_SAMPLES;
  }

  // ─── construction helpers ───────────────────────────────────────────────────

  private buildConnector(id: number, node: number, inLane: number, outLane: number, uturn: boolean): Connector {
    let inU = uturn && node < 0 ? this.laneLen[inLane] : this.laneExitU[inLane];
    let outU = uturn && node < 0 ? 0 : this.laneEntryU[outLane];
    if (uturn && node >= 0 && outLane === (inLane ^ 1)) {
      // turn round on the own road, clear of the junction (the loop reaches ~6 m ahead of its start)
      const back = Math.min(UTURN_BACK, Math.max(0, this.laneExitU[inLane] - this.laneEntryU[inLane] - 1));
      inU = this.laneExitU[inLane] - back;
      outU = this.laneLen[inLane] - inU;
    }
    this.lanePoint(inLane, inU, tmpA);
    this.lanePoint(outLane, outU, tmpB);
    const p = new Float64Array(8);
    p[0] = tmpA.x;
    p[1] = tmpA.z;
    p[6] = tmpB.x;
    p[7] = tmpB.z;
    const dx = tmpB.x - tmpA.x;
    const dz = tmpB.z - tmpA.z;
    const d = Math.hypot(dx, dz);
    const hIn = Math.atan2(tmpA.hx, -tmpA.hz);
    const hOut = Math.atan2(tmpB.hx, -tmpB.hz);
    let dh = ((hOut - hIn) * 180) / Math.PI;
    dh = ((((dh + 180) % 360) + 360) % 360) - 180;
    let turn = Math.abs(dh) < 35 ? 0 : dh > 0 ? 1 : -1;
    if (uturn || Math.abs(dh) > 150) turn = 2;
    if (turn === 2) {
      // loop to the left (right-hand traffic): out ahead, sweep across, back
      let mx = dx;
      let mz = dz;
      if (d > 0.5) {
        mx /= d;
        mz /= d;
      } else {
        mx = tmpA.hz;
        mz = -tmpA.hx;
      }
      const bulge = Math.max(1.2, 3.4 - d / 2);
      const reach = 7.5;
      p[2] = tmpA.x + tmpA.hx * reach - mx * bulge;
      p[3] = tmpA.z + tmpA.hz * reach - mz * bulge;
      p[4] = tmpB.x - tmpB.hx * reach + mx * bulge;
      p[5] = tmpB.z - tmpB.hz * reach + mz * bulge;
    } else {
      const k = d * (turn === 0 ? 0.34 : 0.42);
      p[2] = tmpA.x + tmpA.hx * k;
      p[3] = tmpA.z + tmpA.hz * k;
      p[4] = tmpB.x - tmpB.hx * k;
      p[5] = tmpB.z - tmpB.hz * k;
    }
    const lut = new Float32Array(CONN_SAMPLES + 1);
    let len = 0;
    let kmax = 0;
    let lx = p[0];
    let lz = p[1];
    for (let i = 0; i <= CONN_SAMPLES; i++) {
      const t = i / CONN_SAMPLES;
      const u = 1 - t;
      const x = u * u * u * p[0] + 3 * u * u * t * p[2] + 3 * u * t * t * p[4] + t * t * t * p[6];
      const z = u * u * u * p[1] + 3 * u * u * t * p[3] + 3 * u * t * t * p[5] + t * t * t * p[7];
      if (i > 0) len += Math.hypot(x - lx, z - lz);
      lut[i] = len;
      lx = x;
      lz = z;
      // curvature |B'×B''| / |B'|³
      const bx = 3 * u * u * (p[2] - p[0]) + 6 * u * t * (p[4] - p[2]) + 3 * t * t * (p[6] - p[4]);
      const bz = 3 * u * u * (p[3] - p[1]) + 6 * u * t * (p[5] - p[3]) + 3 * t * t * (p[7] - p[5]);
      const cx = 6 * u * (p[4] - 2 * p[2] + p[0]) + 6 * t * (p[6] - 2 * p[4] + p[2]);
      const cz = 6 * u * (p[5] - 2 * p[3] + p[1]) + 6 * t * (p[7] - 2 * p[5] + p[3]);
      const sp = Math.hypot(bx, bz);
      if (sp > 1e-6) kmax = Math.max(kmax, Math.abs(bx * cz - bz * cx) / (sp * sp * sp));
    }
    const vMax = Math.min(this.speedLimit(inLane, inU), this.speedLimit(outLane, outU));
    if (len < 0.3 && turn !== 2) {
      len = 0;
      lut.fill(0);
    }
    const vTurn = turn === 2 ? this.cfg.minTurnSpeed : Math.max(this.cfg.minTurnSpeed, Math.min(vMax, kmax > 1e-6 ? Math.sqrt(this.cfg.lateralAccel / kmax) : vMax));
    return {
      id,
      node,
      inLane,
      outLane,
      inU,
      outU,
      p,
      lut,
      len,
      vTurn,
      turn,
      prio: 0,
      stop: 0,
      conflicts: [],
      kindIn: this.pKind[inLane >> 1],
      kindOut: this.pKind[outLane >> 1],
    };
  }

  /**
   * Conflicts between connectors of one node AND of nodes close together (a
   * junction cluster: roads meeting a few metres apart share one box). Paths
   * are sampled with a short run of lane before and after (the stop area and
   * where the body still is), compared pairwise.
   */
  private *computeConflicts(): Generator<void> {
    const S = 12;
    const EXT_IN = 2;
    const EXT_OUT = 3;
    const conns = this.connectors;
    const pts: Float64Array[] = [];
    const q: LanePoint = { x: 0, z: 0, hx: 0, hz: 0 };
    const byNode = new Map<number, number[]>();
    for (const c of conns) {
      if (c.id % 3000 === 2999) yield;
      const a = new Float64Array((S + 3) * 2);
      for (let i = 0; i <= S; i++) {
        this.connPoint(c, (c.len * i) / S, q);
        a[i * 2] = q.x;
        a[i * 2 + 1] = q.z;
        if (i === 0) {
          a[(S + 1) * 2] = q.x - q.hx * EXT_IN;
          a[(S + 1) * 2 + 1] = q.z - q.hz * EXT_IN;
        }
        if (i === S) {
          a[(S + 2) * 2] = q.x + q.hx * EXT_OUT;
          a[(S + 2) * 2 + 1] = q.z + q.hz * EXT_OUT;
        }
      }
      pts.push(a);
      if (c.node >= 0) (byNode.get(c.node) ?? byNode.set(c.node, []).get(c.node)!).push(c.id);
    }
    // nodes near each other (grid)
    const CLUSTER = 30;
    const cell = new Map<number, number[]>();
    const key = (i: number, j: number) => i * 100003 + j;
    for (const n of byNode.keys()) {
      const k = key(Math.floor(this.nodeX[n] / CLUSTER), Math.floor(this.nodeZ[n] / CLUSTER));
      (cell.get(k) ?? cell.set(k, []).get(k)!).push(n);
    }
    const D2 = CONFLICT_DIST * CONFLICT_DIST;
    const test = (i: number, j: number) => {
      const a = conns[i];
      const b = conns[j];
      if (a.inLane === b.inLane) return;
      // one after the other in the same flow (through a short lane between two boxes)
      if (a.outLane === b.inLane || b.outLane === a.inLane) return;
      let hit = a.outLane === b.outLane;
      if (!hit) {
        const A = pts[i];
        const B = pts[j];
        const na = a.len > 0 ? S + 3 : 1;
        const nb = b.len > 0 ? S + 3 : 1;
        for (let x = 0; x < na && !hit; x++)
          for (let y = 0; y < nb; y++) {
            const ex = A[x * 2] - B[y * 2];
            const ez = A[x * 2 + 1] - B[y * 2 + 1];
            if (ex * ex + ez * ez < D2) {
              hit = true;
              break;
            }
          }
      }
      if (hit) {
        a.conflicts.push(b.id);
        b.conflicts.push(a.id);
      }
    };
    let done = 0;
    for (const [n, list] of byNode) {
      if (++done % 120 === 0) yield;
      const ci = Math.floor(this.nodeX[n] / CLUSTER);
      const cj = Math.floor(this.nodeZ[n] / CLUSTER);
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const others = cell.get(key(ci + di, cj + dj));
          if (!others) continue;
          for (const m of others) {
            if (m < n) continue;
            if (Math.hypot(this.nodeX[m] - this.nodeX[n], this.nodeZ[m] - this.nodeZ[n]) > CLUSTER) continue;
            const other = byNode.get(m)!;
            if (m === n) {
              for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) test(list[x], list[y]);
            } else for (const x of list) for (const y of other) test(x, y);
          }
        }
    }
  }

  /** Priorities and stop/yield rules of one node's connectors. */
  private junctionRules(n: number, ends: Int32Array, conns: Connector[]): void {
    // roads passing through (≥ 2 ends) and ranks
    const roadEnds = new Map<number, number>();
    let town = false;
    for (const code of ends) {
      const p = code >> 1;
      roadEnds.set(this.pRoad[p], (roadEnds.get(this.pRoad[p]) ?? 0) + 1);
      if (this.pFlags[p] & FLAG.sidewalk) town = true;
    }
    const prioOf = (lane: number): number => {
      const p = lane >> 1;
      return ((roadEnds.get(this.pRoad[p]) ?? 0) >= 2 ? 100 : 0) + RANK[this.pKind[p]] * 10;
    };
    let top = -1;
    for (const code of ends) top = Math.max(top, prioOf((code >> 1) * 2));
    const topRoads = new Set<number>();
    for (const code of ends) if (prioOf((code >> 1) * 2) === top) topRoads.add(this.pRoad[code >> 1]);
    const simple = ends.length <= 2;
    for (const c of conns) {
      c.prio = prioOf(c.inLane);
      if (simple || (c.prio === top && topRoads.size === 1)) c.stop = 0;
      else c.stop = town ? 2 : 1;
    }
    void n;
  }
}
