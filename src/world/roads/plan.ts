/**
 * Road plan (PURE, xz only, no heights): the network turned into PIECES that
 * meet at NODES — the shared topology of the ribbons (ribbon.ts), the markings
 * (crosswalks, stop bars, sidewalk corners) and the car lanes (world/cars).
 *
 * 1. Roads are processed from the highest rank down (KIND_RANK, then index).
 *    Each is smoothed and sampled every `sampleSpacing` m and cut where it
 *    enters the corridor (half width + TRIM_MARGIN) of a road processed earlier
 *    (exact boundary by bisection): a CUT end.
 * 2. Every cut end is projected onto the crossing road; the crossing road's
 *    piece is SPLIT there (end-to-end, sharing the section), and all ends meet
 *    at one node. So every piece has junctions only at its ends, and the
 *    distance to the junction (`dS`/`dE`) is linear along it — exact under
 *    linear interpolation in the shader.
 * 3. Bridges: the piece carrying a layout bridge gets samples at the span and
 *    ramp ends.
 * 4. `runsFor(pieces, size)`: pieces cut per chunk (neighbouring runs share
 *    their end section; normals come from the whole piece → no cracks).
 */
import type { Bridge, Town } from '../layout';
import type { NetKind, NetRoad, RoadNetwork } from './network';
import { KIND_RANK } from './network';
import { resampleSmooth, type XZ } from '../towns/geom';
import { CONFIG } from '../../config';

export type RoadsConfig = typeof CONFIG.world.towns.roads;

/** Extra clearance beyond a higher-ranked road's edge where a joining road is cut, m. */
export const TRIM_MARGIN = 0.3;
/** Kind ids (shader + attribute encoding). */
export const KIND_ID: Record<NetKind, number> = { highway: 0, road: 1, access: 2, lane: 3, street: 4, drive: 5 };
export const KIND_BY_ID: NetKind[] = ['highway', 'road', 'access', 'lane', 'street', 'drive'];

/** Split requests closer than this along a piece share one node, m. */
const CLUSTER = 2.5;
/** A junction this close to a piece end attaches to that end instead of splitting, m. */
const END_SNAP = 1.0;

export interface BridgeSpan {
  /** The layout bridge's centre (identity) and water level. */
  x: number;
  z: number;
  water: number;
  /** Deck start/end along the ROAD's arc length (piece `ss` units), m. */
  s0: number;
  s1: number;
  /** Centreline xz at the span ends (where the deck meets the banks). */
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** Deck (paved) width, m. */
  width: number;
}

export interface PieceEnd {
  /** Node id, −1 = free (dead) end. */
  node: number;
  /** Distance from this end to the node centre, m (0 where the piece was split through the junction). */
  off: number;
  /**
   * Half width of the crossing road(s) measured along this piece, m. 0 = no
   * crossing. Sign: > 0 town junction (crosswalks, stop bars), < 0 rural.
   */
  h: number;
  /** Sidewalk width of the crossing road (0 if none), m. */
  y: number;
  /** This end was trimmed at the crossing road's edge (its sidewalk yields to the crossing one's). */
  cut: boolean;
}

export interface PieceStyle {
  /** Sidewalk width outside the paved edge (towns), m; 0 = none. */
  sidewalk: number;
  /** Gravel/grass shoulder band outside the paved edge (or the sidewalk), m. */
  shoulder: number;
  /** Soft verge (alpha → 0) outside the shoulder, m. */
  fade: number;
  /** Town arterial (double yellow centre line). */
  arterial: boolean;
}

export interface RoadPiece {
  id: number;
  road: number;
  kind: NetKind;
  width: number;
  /** Town index for town streets (−1 otherwise). */
  town: number;
  style: PieceStyle;
  n: number;
  xs: Float64Array;
  zs: Float64Array;
  /** Unit right normal (of the direction of travel, i.e. increasing s). */
  nx: Float64Array;
  nz: Float64Array;
  /** Arc length along the ROAD (continuous across the pieces of one road). */
  ss: Float64Array;
  start: PieceEnd;
  end: PieceEnd;
  bridge: BridgeSpan | null;
}

export interface RoadNode {
  id: number;
  x: number;
  z: number;
  /** Attached piece ends: piece id × 2 + (0 start | 1 end). */
  ends: number[];
}

export interface RoadPlan {
  pieces: RoadPiece[];
  nodes: RoadNode[];
  /** Road indices in processing order (highest rank first). */
  order: number[];
}

export interface RibbonRun {
  piece: RoadPiece;
  /** Chunk indices (chunk size given to runsFor). */
  ci: number;
  cj: number;
  /** Index range [i0, i1] into the piece's samples (inclusive; neighbours share the boundary sample). */
  i0: number;
  i1: number;
}

// ─── Style ────────────────────────────────────────────────────────────────────

export function pieceStyle(road: Pick<NetRoad, 'kind' | 'width' | 'town'>, towns: readonly Pick<Town, 'kind'>[]): PieceStyle {
  switch (road.kind) {
    case 'highway':
      return { sidewalk: 0, shoulder: 1.3, fade: 2.2, arterial: false };
    case 'road':
      return { sidewalk: 0, shoulder: 1.0, fade: 1.8, arterial: false };
    case 'access':
      return { sidewalk: 0, shoulder: 0.9, fade: 1.6, arterial: false };
    case 'lane':
      return { sidewalk: 0, shoulder: 0.5, fade: 1.4, arterial: false };
    case 'drive':
      return { sidewalk: 0, shoulder: 0.3, fade: 1.1, arterial: false };
    case 'street': {
      const t = road.town >= 0 ? towns[road.town] : undefined;
      const grid = !!t && (t.kind === 'city' || t.kind === 'town');
      const arterial = road.width >= 8;
      if (grid) return { sidewalk: t!.kind === 'city' ? (arterial ? 3.0 : 2.5) : 2.2, shoulder: 0, fade: 0.8, arterial };
      return { sidewalk: 0, shoulder: 0.5, fade: 1.1, arterial: false };
    }
  }
}

// ─── Corridor grid (which earlier road covers a point) ────────────────────────

class CorridorGrid {
  private ax: number[] = [];
  private az: number[] = [];
  private bx: number[] = [];
  private bz: number[] = [];
  private hw: number[] = [];
  private id: number[] = [];
  private cells = new Map<number, number[]>();
  private maxHw = 0;
  constructor(private cell: number) {}
  add(pts: readonly XZ[], hw: number, id: number): void {
    const c = this.cell;
    for (let i = 1; i < pts.length; i++) {
      const s = this.ax.length;
      const a = pts[i - 1];
      const b = pts[i];
      this.ax.push(a.x);
      this.az.push(a.z);
      this.bx.push(b.x);
      this.bz.push(b.z);
      this.hw.push(hw);
      this.id.push(id);
      const pad = hw + 2;
      const i0 = Math.floor((Math.min(a.x, b.x) - pad) / c);
      const i1 = Math.floor((Math.max(a.x, b.x) + pad) / c);
      const j0 = Math.floor((Math.min(a.z, b.z) - pad) / c);
      const j1 = Math.floor((Math.max(a.z, b.z) + pad) / c);
      for (let j = j0; j <= j1; j++)
        for (let ii = i0; ii <= i1; ii++) {
          const k = ii * 73856093 + j * 19349663;
          let l = this.cells.get(k);
          if (!l) this.cells.set(k, (l = []));
          l.push(s);
        }
    }
    if (hw > this.maxHw) this.maxHw = hw;
  }
  /** Smallest id < maxId whose corridor (half width + margin) contains (x, z); −1 if none. */
  coverId(x: number, z: number, margin: number, maxId: number): number {
    const l = this.cells.get(Math.floor(x / this.cell) * 73856093 + Math.floor(z / this.cell) * 19349663);
    if (!l) return -1;
    let best = -1;
    for (const s of l) {
      const id = this.id[s];
      if (id >= maxId || (best >= 0 && id >= best)) continue;
      const vx = this.bx[s] - this.ax[s];
      const vz = this.bz[s] - this.az[s];
      const l2 = vx * vx + vz * vz;
      let t = l2 > 1e-12 ? ((x - this.ax[s]) * vx + (z - this.az[s]) * vz) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = x - this.ax[s] - vx * t;
      const ez = z - this.az[s] - vz * t;
      const r = this.hw[s] + margin;
      if (ex * ex + ez * ez < r * r) best = id;
    }
    return best;
  }
}

// ─── Plan ─────────────────────────────────────────────────────────────────────

interface Proto {
  road: number;
  pts: XZ[];
  ss: number[];
  /** Order position of the road covering the cut start/end (−1 = free end). */
  cutS: number;
  cutE: number;
  bridge: BridgeSpan | null;
}

interface Request {
  proto: number;
  s: number;
  x: number;
  z: number;
  /** The cut piece end (proto × 2 + end) and |sin| of the crossing angle. */
  from: number;
  sin: number;
}

export function planRoads(net: RoadNetwork, bridges: readonly Bridge[], towns: readonly Pick<Town, 'kind'>[], cfg: RoadsConfig = CONFIG.world.towns.roads): RoadPlan {
  const roads = net.roads;
  const order = roads.map((_, i) => i).sort((a, b) => KIND_RANK[roads[b].kind] - KIND_RANK[roads[a].kind] || a - b);
  const pos = new Int32Array(roads.length);
  order.forEach((ri, k) => (pos[ri] = k));
  const grid = new CorridorGrid(64);
  roads.forEach((r, ri) => grid.add(r.points, r.width / 2, pos[ri]));
  const styles = roads.map((r) => pieceStyle(r, towns));

  // 1. uncovered runs of every road
  const protos: Proto[] = [];
  for (const ri of order) {
    const road = roads[ri];
    const k = pos[ri];
    const pts = resampleSmooth(road.points, cfg.sampleSpacing);
    const rs = cumulative(pts);
    const cov = pts.map((p) => grid.coverId(p.x, p.z, TRIM_MARGIN, k));
    let i = 0;
    while (i < pts.length) {
      if (cov[i] >= 0) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < pts.length && cov[j + 1] < 0) j++;
      const piece: XZ[] = [];
      const ps: number[] = [];
      let cutS = -1;
      let cutE = -1;
      if (i > 0) {
        const b = bisect(pts[i], pts[i - 1], grid, k);
        piece.push(b.p);
        ps.push(rs[i] - (rs[i] - rs[i - 1]) * b.t);
        cutS = b.id;
      }
      for (let m = i; m <= j; m++) {
        piece.push(pts[m]);
        ps.push(rs[m]);
      }
      if (j < pts.length - 1) {
        const b = bisect(pts[j], pts[j + 1], grid, k);
        piece.push(b.p);
        ps.push(rs[j] + (rs[j + 1] - rs[j]) * b.t);
        cutE = b.id;
      }
      i = j + 1;
      // drop near-duplicate points (a bisected end right on a sample)
      const cp: XZ[] = [piece[0]];
      const cs: number[] = [ps[0]];
      for (let m = 1; m < piece.length; m++) {
        if (ps[m] - cs[cs.length - 1] > 0.05) {
          cp.push(piece[m]);
          cs.push(ps[m]);
        } else if (m === piece.length - 1) {
          cp[cp.length - 1] = piece[m];
          cs[cs.length - 1] = ps[m];
        }
      }
      if (cp.length < 2 || cs[cs.length - 1] - cs[0] < 1.5) continue;
      protos.push({ road: ri, pts: cp, ss: cs, cutS, cutE, bridge: null });
    }
  }

  // 2. bridges: samples at the span and ramp ends
  for (const b of bridges) {
    for (const pr of protos) {
      if (roads[pr.road].name !== b.road) continue;
      const sc = project(pr.pts, pr.ss, b.x, b.z, 40);
      if (!sc) continue;
      const s0 = sc.s - b.length / 2;
      const s1 = sc.s + b.length / 2;
      const ins = insertAt(pr.pts, pr.ss, [s0 - cfg.bridgeRamp, s0, s1, s1 + cfg.bridgeRamp]);
      pr.pts = ins.pts;
      pr.ss = ins.ss;
      const ea = pointAt(pr.pts, pr.ss, s0);
      const eb = pointAt(pr.pts, pr.ss, s1);
      pr.bridge = { x: b.x, z: b.z, water: b.waterLevel, s0, s1, ax: ea.x, az: ea.z, bx: eb.x, bz: eb.z, width: roads[pr.road].width };
      break;
    }
  }

  // 3. project every cut end onto the crossing road's pieces
  const segIdx = new PieceIndex(protos, 64);
  const requests: Request[] = [];
  protos.forEach((pr, pi) => {
    for (const end of [0, 1] as const) {
      const cut = end === 0 ? pr.cutS : pr.cutE;
      if (cut < 0) continue;
      const cr = order[cut];
      const p = end === 0 ? pr.pts[0] : pr.pts[pr.pts.length - 1];
      const hit = segIdx.nearest(p.x, p.z, roads[cr].width / 2 + 6, cr);
      if (!hit) continue;
      const q = end === 0 ? pr.pts[1] : pr.pts[pr.pts.length - 2];
      const dx = p.x - q.x;
      const dz = p.z - q.z;
      const l = Math.hypot(dx, dz) || 1;
      const sin = Math.abs((dx * hit.dz - dz * hit.dx) / l);
      requests.push({ proto: hit.proto, s: hit.s, x: hit.x, z: hit.z, from: pi * 2 + end, sin });
    }
  });

  // 4. cluster requests per piece → nodes (union-find merges nodes met twice)
  const parent: number[] = [];
  const nodeXZ: { x: number; z: number; n: number }[] = [];
  const newNode = (x: number, z: number): number => {
    parent.push(parent.length);
    nodeXZ.push({ x, z, n: 1 });
    return parent.length - 1;
  };
  const find = (a: number): number => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]];
    return a;
  };
  const union = (a: number, b: number): number => {
    a = find(a);
    b = find(b);
    if (a !== b) parent[b] = a;
    return a;
  };
  /** Node of each proto end (proto × 2 + end), −1 = none. */
  const endNode = new Int32Array(protos.length * 2).fill(-1);
  /** Crossing info contributed to each proto end: h (signed), y. */
  interface Contribution {
    h: number;
    y: number;
    town: boolean;
  }
  const contrib = new Map<number, Contribution>();
  const addContrib = (key: number, h: number, y: number, town: boolean) => {
    const c = contrib.get(key);
    if (!c) contrib.set(key, { h, y, town });
    else {
      c.h = Math.max(c.h, h);
      c.y = Math.max(c.y, y);
      c.town = c.town || town;
    }
  };
  const byProto = new Map<number, Request[]>();
  for (const r of requests) (byProto.get(r.proto) ?? byProto.set(r.proto, []).get(r.proto)!).push(r);
  /** Split points per proto: s, node, and the crossing info for both new ends. */
  const splits = new Map<number, { s: number; node: number; h: number; y: number; town: boolean }[]>();
  const townJunction = (a: number, b: number) => styles[a].sidewalk > 0 || styles[b].sidewalk > 0;
  for (const [pi, list] of byProto) {
    list.sort((a, b) => a.s - b.s);
    const pr = protos[pi];
    const s0 = pr.ss[0];
    const s1 = pr.ss[pr.ss.length - 1];
    let c = 0;
    while (c < list.length) {
      let e = c;
      while (e + 1 < list.length && list[e + 1].s - list[c].s < CLUSTER) e++;
      const members = list.slice(c, e + 1);
      c = e + 1;
      let sx = 0;
      let sz = 0;
      let s = 0;
      for (const m of members) {
        sx += m.x;
        sz += m.z;
        s += m.s;
      }
      sx /= members.length;
      sz /= members.length;
      s /= members.length;
      // this junction's contribution to the through piece: the joining roads' widths
      let h = 0;
      let y = 0;
      let town = false;
      for (const m of members) {
        const from = protos[m.from >> 1];
        if (roads[from.road].kind === 'drive') continue;
        h = Math.max(h, roads[from.road].width / 2 / Math.max(0.35, m.sin));
        y = Math.max(y, styles[from.road].sidewalk);
        town = town || townJunction(from.road, pr.road);
      }
      // inside a bridge span/ramp: never split (no junctions on bridges)
      const br = pr.bridge;
      const onBridge = !!br && s > br.s0 - cfg.bridgeRamp - 1 && s < br.s1 + cfg.bridgeRamp + 1;
      let node: number;
      if (s - s0 < END_SNAP || s1 - s < END_SNAP || onBridge) {
        const end = s - s0 < s1 - s ? 0 : 1;
        const key = pi * 2 + end;
        node = endNode[key] >= 0 ? endNode[key] : (endNode[key] = newNode(sx, sz));
        if (h > 0) addContrib(key, h, y, town);
      } else {
        node = newNode(sx, sz);
        (splits.get(pi) ?? splits.set(pi, []).get(pi)!).push({ s, node, h, y, town });
      }
      for (const m of members) {
        const k = m.from;
        endNode[k] = endNode[k] >= 0 ? union(endNode[k], node) : node;
      }
    }
  }

  // 5. build the final pieces (split protos), with normals from the whole proto
  const pieces: RoadPiece[] = [];
  const reqByFrom = new Map<number, Request>();
  for (const r of requests) reqByFrom.set(r.from, r);
  const cutEnd = (pi: number, end: 0 | 1): PieceEnd => {
    const key = pi * 2 + end;
    const pr = protos[pi];
    const cut = end === 0 ? pr.cutS : pr.cutE;
    const node = endNode[key];
    const base: PieceEnd = { node: node >= 0 ? find(node) : -1, off: 0, h: 0, y: 0, cut: false };
    if (cut >= 0) {
      const r = reqByFrom.get(key);
      const cr = order[cut];
      const p = end === 0 ? pr.pts[0] : pr.pts[pr.pts.length - 1];
      if (r) base.off = Math.hypot(p.x - r.x, p.z - r.z);
      else base.off = roads[cr].width / 2 + TRIM_MARGIN;
      if (roads[pr.road].kind !== 'drive' || roads[cr].kind === 'drive') {
        const sin = r ? Math.max(0.35, r.sin) : 1;
        const town = townJunction(cr, pr.road);
        base.h = ((roads[cr].width / 2) / sin) * (town ? 1 : -1);
        base.y = styles[cr].sidewalk;
      }
      base.cut = true;
    }
    const c = contrib.get(key);
    if (c && c.h > Math.abs(base.h)) {
      base.h = c.town ? c.h : -c.h;
      base.y = Math.max(base.y, c.y);
    }
    return base;
  };
  protos.forEach((pr, pi) => {
    const n = pr.pts.length;
    const nxA = new Float64Array(n);
    const nzA = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = pr.pts[Math.max(0, i - 1)];
      const b = pr.pts[Math.min(n - 1, i + 1)];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const l = Math.hypot(dx, dz) || 1;
      nxA[i] = -dz / l;
      nzA[i] = dx / l;
    }
    const road = roads[pr.road];
    const sp = (splits.get(pi) ?? []).sort((a, b) => a.s - b.s);
    // cut positions → sub-ranges; the split sample is inserted exactly
    let pts = pr.pts;
    let ss = pr.ss;
    let nx = Array.from(nxA);
    let nz = Array.from(nzA);
    if (sp.length) {
      const ins = insertWithNormals(pts, ss, nx, nz, sp.map((q) => q.s));
      pts = ins.pts;
      ss = ins.ss;
      nx = ins.nx;
      nz = ins.nz;
    }
    const bounds: number[] = [0];
    for (const q of sp) {
      let best = -1;
      let bd = Infinity;
      for (let i = 1; i < ss.length - 1; i++) {
        const d = Math.abs(ss[i] - q.s);
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      if (best > bounds[bounds.length - 1]) bounds.push(best);
    }
    bounds.push(pts.length - 1);
    for (let b = 0; b + 1 < bounds.length; b++) {
      const a = bounds[b];
      const e = bounds[b + 1];
      const m = e - a + 1;
      if (m < 2) continue;
      const piece: RoadPiece = {
        id: pieces.length,
        road: pr.road,
        kind: road.kind,
        width: road.width,
        town: road.town,
        style: styles[pr.road],
        n: m,
        xs: new Float64Array(m),
        zs: new Float64Array(m),
        nx: new Float64Array(m),
        nz: new Float64Array(m),
        ss: new Float64Array(m),
        start: b === 0 ? cutEnd(pi, 0) : splitEnd(sp[b - 1], find),
        end: b + 2 === bounds.length ? cutEnd(pi, 1) : splitEnd(sp[b], find),
        bridge: null,
      };
      for (let i = 0; i < m; i++) {
        piece.xs[i] = pts[a + i].x;
        piece.zs[i] = pts[a + i].z;
        piece.nx[i] = nx[a + i];
        piece.nz[i] = nz[a + i];
        piece.ss[i] = ss[a + i];
      }
      if (pr.bridge && piece.ss[m - 1] >= pr.bridge.s0 - cfg.bridgeRamp && piece.ss[0] <= pr.bridge.s1 + cfg.bridgeRamp) piece.bridge = pr.bridge;
      pieces.push(piece);
    }
  });

  // 6. nodes (compressed ids), each at the mean of the raw nodes merged into it
  const acc = new Map<number, { x: number; z: number; n: number }>();
  for (let i = 0; i < parent.length; i++) {
    const r = find(i);
    const a = acc.get(r);
    if (a) {
      a.x += nodeXZ[i].x;
      a.z += nodeXZ[i].z;
      a.n++;
    } else acc.set(r, { x: nodeXZ[i].x, z: nodeXZ[i].z, n: 1 });
  }
  for (const [r, a] of acc) nodeXZ[r] = { x: a.x / a.n, z: a.z / a.n, n: a.n };
  const remap = new Map<number, number>();
  const nodes: RoadNode[] = [];
  const nodeOf = (raw: number): number => {
    if (raw < 0) return -1;
    const r = find(raw);
    let id = remap.get(r);
    if (id === undefined) {
      id = nodes.length;
      remap.set(r, id);
      nodes.push({ id, x: nodeXZ[r].x, z: nodeXZ[r].z, ends: [] });
    }
    return id;
  };
  for (const p of pieces) {
    p.start.node = nodeOf(p.start.node);
    p.end.node = nodeOf(p.end.node);
    if (p.start.node >= 0) nodes[p.start.node].ends.push(p.id * 2);
    if (p.end.node >= 0) nodes[p.end.node].ends.push(p.id * 2 + 1);
  }
  return { pieces, nodes, order };
}

function splitEnd(q: { node: number; h: number; y: number; town: boolean }, find: (a: number) => number): PieceEnd {
  return { node: find(q.node), off: 0, h: q.h > 0 ? (q.town ? q.h : -q.h) : 0, y: q.y, cut: false };
}

/** Point on segment a (uncovered) → b (covered) at the corridor boundary (on the uncovered side), and who covers b. */
function bisect(a: XZ, b: XZ, grid: CorridorGrid, k: number): { p: XZ; t: number; id: number } {
  let lo = 0;
  let hi = 1;
  let id = grid.coverId(b.x, b.z, TRIM_MARGIN, k);
  for (let it = 0; it < 16; it++) {
    const m = (lo + hi) / 2;
    const c = grid.coverId(a.x + (b.x - a.x) * m, a.z + (b.z - a.z) * m, TRIM_MARGIN, k);
    if (c >= 0) {
      hi = m;
      id = c;
    } else lo = m;
  }
  return { p: { x: a.x + (b.x - a.x) * lo, z: a.z + (b.z - a.z) * lo }, t: lo, id };
}

/** Spatial index over proto piece segments, filtered by road. */
class PieceIndex {
  private cells = new Map<number, number[]>();
  constructor(
    private protos: Proto[],
    private cell: number,
  ) {
    protos.forEach((pr, pi) => {
      for (let i = 1; i < pr.pts.length; i++) {
        const a = pr.pts[i - 1];
        const b = pr.pts[i];
        const i0 = Math.floor(Math.min(a.x, b.x) / cell);
        const i1 = Math.floor(Math.max(a.x, b.x) / cell);
        const j0 = Math.floor(Math.min(a.z, b.z) / cell);
        const j1 = Math.floor(Math.max(a.z, b.z) / cell);
        for (let j = j0; j <= j1; j++)
          for (let ii = i0; ii <= i1; ii++) {
            const k = ii * 73856093 + j * 19349663;
            let l = this.cells.get(k);
            if (!l) this.cells.set(k, (l = []));
            l.push(pi * 1048576 + i);
          }
      }
    });
  }
  nearest(x: number, z: number, maxR: number, road: number): { proto: number; s: number; x: number; z: number; dx: number; dz: number } | null {
    const c = this.cell;
    let best = maxR;
    let out: { proto: number; s: number; x: number; z: number; dx: number; dz: number } | null = null;
    const seen = new Set<number>();
    for (let j = Math.floor((z - maxR) / c); j <= Math.floor((z + maxR) / c); j++)
      for (let i = Math.floor((x - maxR) / c); i <= Math.floor((x + maxR) / c); i++) {
        const l = this.cells.get(i * 73856093 + j * 19349663);
        if (!l) continue;
        for (const code of l) {
          if (seen.has(code)) continue;
          seen.add(code);
          const pi = Math.floor(code / 1048576);
          const pr = this.protos[pi];
          if (pr.road !== road) continue;
          const si = code - pi * 1048576;
          const a = pr.pts[si - 1];
          const b = pr.pts[si];
          const vx = b.x - a.x;
          const vz = b.z - a.z;
          const l2 = vx * vx + vz * vz;
          let t = l2 > 1e-12 ? ((x - a.x) * vx + (z - a.z) * vz) / l2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const px = a.x + vx * t;
          const pz = a.z + vz * t;
          const d = Math.hypot(x - px, z - pz);
          if (d < best) {
            best = d;
            const ll = Math.sqrt(l2) || 1;
            out = { proto: pi, s: pr.ss[si - 1] + (pr.ss[si] - pr.ss[si - 1]) * t, x: px, z: pz, dx: vx / ll, dz: vz / ll };
          }
        }
      }
    return out;
  }
}

function cumulative(pts: readonly XZ[]): number[] {
  const s = [0];
  for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  return s;
}

function pointAt(pts: readonly XZ[], ss: readonly number[], s: number): XZ {
  let i = 1;
  while (i < pts.length - 1 && ss[i] < s) i++;
  const t = Math.max(0, Math.min(1, (s - ss[i - 1]) / (ss[i] - ss[i - 1] || 1)));
  return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, z: pts[i - 1].z + (pts[i].z - pts[i - 1].z) * t };
}

function project(pts: readonly XZ[], ss: readonly number[], x: number, z: number, maxD: number): { s: number; d: number } | null {
  let best = maxD;
  let bs = NaN;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const vx = b.x - a.x;
    const vz = b.z - a.z;
    const l2 = vx * vx + vz * vz;
    let t = l2 > 0 ? ((x - a.x) * vx + (z - a.z) * vz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(x - a.x - vx * t, z - a.z - vz * t);
    if (d < best) {
      best = d;
      bs = ss[i - 1] + (ss[i] - ss[i - 1]) * t;
    }
  }
  return Number.isNaN(bs) ? null : { s: bs, d: best };
}

/** Samples inserted at the given arc lengths (strictly inside, not within 5 cm of an existing sample). */
function insertAt(pts: readonly XZ[], ss: readonly number[], at: number[]): { pts: XZ[]; ss: number[] } {
  const out: XZ[] = [];
  const os: number[] = [];
  const targets = at.filter((s) => s > ss[0] + 0.05 && s < ss[ss.length - 1] - 0.05).sort((a, b) => a - b);
  let t = 0;
  for (let i = 0; i < pts.length; i++) {
    while (t < targets.length && i > 0 && targets[t] < ss[i] - 0.05 && targets[t] > ss[i - 1] + 0.05) {
      const f = (targets[t] - ss[i - 1]) / (ss[i] - ss[i - 1]);
      out.push({ x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f, z: pts[i - 1].z + (pts[i].z - pts[i - 1].z) * f });
      os.push(targets[t]);
      t++;
    }
    while (t < targets.length && targets[t] <= ss[i] + 0.05) t++;
    out.push(pts[i]);
    os.push(ss[i]);
  }
  return { pts: out, ss: os };
}

function insertWithNormals(pts: readonly XZ[], ss: readonly number[], nx: number[], nz: number[], at: number[]): { pts: XZ[]; ss: number[]; nx: number[]; nz: number[] } {
  const out: XZ[] = [];
  const os: number[] = [];
  const onx: number[] = [];
  const onz: number[] = [];
  const targets = at.slice().sort((a, b) => a - b);
  let t = 0;
  for (let i = 0; i < pts.length; i++) {
    while (t < targets.length && i > 0 && targets[t] < ss[i] - 0.05 && targets[t] > ss[i - 1] + 0.05) {
      const f = (targets[t] - ss[i - 1]) / (ss[i] - ss[i - 1]);
      out.push({ x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f, z: pts[i - 1].z + (pts[i].z - pts[i - 1].z) * f });
      os.push(targets[t]);
      const ax = nx[i - 1] + (nx[i] - nx[i - 1]) * f;
      const az = nz[i - 1] + (nz[i] - nz[i - 1]) * f;
      const l = Math.hypot(ax, az) || 1;
      onx.push(ax / l);
      onz.push(az / l);
      t++;
    }
    while (t < targets.length && targets[t] <= ss[i] + 0.05) t++;
    out.push(pts[i]);
    os.push(ss[i]);
    onx.push(nx[i]);
    onz.push(nz[i]);
  }
  return { pts: out, ss: os, nx: onx, nz: onz };
}

/** Pieces cut into runs per chunk of `size` m (neighbouring runs share their end sample). */
export function runsFor(pieces: readonly RoadPiece[], size: number, keep: (p: RoadPiece) => boolean = () => true): RibbonRun[] {
  const out: RibbonRun[] = [];
  for (const p of pieces) {
    if (!keep(p)) continue;
    const n = p.n;
    const chunkOf = (i: number): number => Math.floor(p.xs[i] / size) * 100003 + Math.floor(p.zs[i] / size);
    let a = 0;
    while (a < n - 1) {
      const c = chunkOf(a);
      let b = a + 1;
      while (b < n - 1 && chunkOf(b) === c) b++;
      out.push({ piece: p, ci: Math.floor(p.xs[a] / size), cj: Math.floor(p.zs[a] / size), i0: a, i1: b });
      a = b;
    }
  }
  return out;
}

/** Chunk key. */
export const chunkKey = (ci: number, cj: number): string => `${ci},${cj}`;
