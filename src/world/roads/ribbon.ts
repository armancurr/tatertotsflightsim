/**
 * Road ribbons: the road network turned into terrain-draped triangle strips.
 * PURE (no three.js); the renderer only uploads the arrays.
 *
 * 1. planRibbons (xz only, cheap): each road is smoothed and sampled every
 *    `sampleSpacing` m; roads are processed from the highest rank down and a
 *    road is cut where it enters the corridor of one processed earlier (exact
 *    boundary by bisection), so junctions never have two overlapping ribbons.
 *    The pieces are split into runs per chunk (neighbouring runs share their
 *    end section, normals are computed on the whole piece → no cracks).
 * 2. buildRun (per chunk, on demand): cross-sections of 5–7 columns (skirt,
 *    edge, …, edge, skirt) at the terrain height + lift at every column (so the
 *    road banks with the ground), bridge decks over the river with approach
 *    ramps, then greedy simplification: a section is dropped while the
 *    straight interpolation between its neighbours stays within
 *    `drapeTolerance` of every dropped sample.
 * 3. mergeRuns: one indexed geometry per chunk.
 */
import type { Bridge } from '../layout';
import type { NetKind, RoadNetwork } from './network';
import { KIND_RANK } from './network';
import { SegmentGrid, resampleSmooth, type XZ } from '../towns/geom';
import { CONFIG } from '../../config';

export type RoadsConfig = typeof CONFIG.world.towns.roads;

/** Extra clearance beyond a higher-ranked road's edge where a joining road is cut, m. */
export const TRIM_MARGIN = 0.3;
/** Verge skirt width beyond the paved edge, m. */
export const SKIRT = 0.9;

export const KIND_ID: Record<NetKind, number> = { highway: 0, road: 1, access: 2, lane: 3, street: 4, drive: 5 };

/** Across offsets of a cross-section's columns (m, − = left of travel), skirts first/last. */
export function ribbonColumns(kind: NetKind, width: number): number[] {
  const hw = width / 2;
  if (kind === 'highway' || kind === 'road' || kind === 'access') return [-hw - SKIRT, -hw, -hw / 2, 0, hw / 2, hw, hw + SKIRT];
  return [-hw - SKIRT, -hw, 0, hw, hw + SKIRT];
}

export interface BridgeSpan {
  /** The layout bridge's centre (identity) and water level. */
  x: number;
  z: number;
  water: number;
  /** Deck start/end along the piece's arc length, m. */
  s0: number;
  s1: number;
  /** Centreline xz at the span ends (where the deck meets the banks). */
  ax: number;
  az: number;
  bx: number;
  bz: number;
}

export interface RibbonRun {
  road: number;
  /** Piece id (a road can be cut into several pieces). */
  piece: number;
  kind: NetKind;
  width: number;
  /** Chunk indices. */
  ci: number;
  cj: number;
  n: number;
  xs: Float64Array;
  zs: Float64Array;
  /** Unit right normal (of the direction of travel). */
  nx: Float64Array;
  nz: Float64Array;
  /** Arc length along the piece. */
  ss: Float64Array;
  /** Bridge of this piece if the run touches its span or ramps. */
  bridge: BridgeSpan | null;
}

export interface RibbonPlan {
  runs: RibbonRun[];
  /** Road indices in processing order (highest rank first). */
  order: number[];
}

export interface RibbonData {
  /** Kept sections. */
  n: number;
  /** World positions, n × columns × 3. */
  pos: Float32Array;
  /** Per vertex: across offset (m), along (m), half width (m), kind id. */
  road: Float32Array;
  /** Per section: 0 road, 1 bridge ramp, 2 bridge span. */
  bridge: Uint8Array;
  /** Per kept section: its index in the run (for bridges/tests). */
  src: Int32Array;
}

// ─── Plan ─────────────────────────────────────────────────────────────────────

export function planRibbons(net: RoadNetwork, bridges: readonly Bridge[], cfg: RoadsConfig = CONFIG.world.towns.roads): RibbonPlan {
  const roads = net.roads;
  const order = roads.map((_, i) => i).sort((a, b) => KIND_RANK[roads[b].kind] - KIND_RANK[roads[a].kind] || a - b);
  const pos = new Int32Array(roads.length);
  order.forEach((ri, k) => (pos[ri] = k));
  const grid = new SegmentGrid(64);
  roads.forEach((r, ri) => grid.addPolyline(r.points, r.width / 2, pos[ri]));
  grid.build();
  const size = cfg.chunkSize;
  const runs: RibbonRun[] = [];
  let pieceId = 0;
  for (const ri of order) {
    const road = roads[ri];
    const k = pos[ri];
    const pts = resampleSmooth(road.points, cfg.sampleSpacing);
    const covered = pts.map((p) => grid.coveredBy(p.x, p.z, TRIM_MARGIN, k));
    // uncovered runs, with bisected exact ends
    let i = 0;
    while (i < pts.length) {
      if (covered[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < pts.length && !covered[j + 1]) j++;
      const piece: XZ[] = [];
      if (i > 0) piece.push(bisect(pts[i], pts[i - 1], grid, k));
      for (let m = i; m <= j; m++) piece.push(pts[m]);
      if (j < pts.length - 1) piece.push(bisect(pts[j], pts[j + 1], grid, k));
      i = j + 1;
      // drop near-duplicate points (a bisected end right on a sample)
      const clean: XZ[] = [piece[0]];
      for (let m = 1; m < piece.length; m++) {
        const p = piece[m];
        const q = clean[clean.length - 1];
        if (Math.hypot(p.x - q.x, p.z - q.z) > 0.05) clean.push(p);
        else if (m === piece.length - 1) clean[clean.length - 1] = p;
      }
      if (clean.length < 2) continue;
      let len = 0;
      for (let m = 1; m < clean.length; m++) len += Math.hypot(clean[m].x - clean[m - 1].x, clean[m].z - clean[m - 1].z);
      if (len < 1.5) continue;
      emitPiece(road.name, ri, pieceId++, road.kind, road.width, clean, bridges, cfg, size, runs);
    }
  }
  return { runs, order };
}

/** Point on segment a (uncovered) → b (covered) at the corridor boundary (on the uncovered side). */
function bisect(a: XZ, b: XZ, grid: SegmentGrid, k: number): XZ {
  let lo = 0;
  let hi = 1;
  for (let it = 0; it < 16; it++) {
    const m = (lo + hi) / 2;
    if (grid.coveredBy(a.x + (b.x - a.x) * m, a.z + (b.z - a.z) * m, TRIM_MARGIN, k)) hi = m;
    else lo = m;
  }
  return { x: a.x + (b.x - a.x) * lo, z: a.z + (b.z - a.z) * lo };
}

function emitPiece(name: string, ri: number, piece: number, kind: NetKind, width: number, pts0: XZ[], bridges: readonly Bridge[], cfg: RoadsConfig, size: number, out: RibbonRun[]): void {
  let pts = pts0;
  let ss = cum(pts);
  // bridge of this piece?
  let span: BridgeSpan | null = null;
  for (const b of bridges) {
    if (b.road !== name) continue;
    const sc = project(pts, ss, b.x, b.z);
    if (!sc) continue;
    const s0 = sc.s - b.length / 2;
    const s1 = sc.s + b.length / 2;
    // make sure the span and ramp ends are samples
    pts = insertAt(pts, ss, [s0 - cfg.bridgeRamp, s0, s1, s1 + cfg.bridgeRamp]);
    ss = cum(pts);
    const ea = pointAt(pts, ss, s0);
    const eb = pointAt(pts, ss, s1);
    span = { x: b.x, z: b.z, water: b.waterLevel, s0, s1, ax: ea.x, az: ea.z, bx: eb.x, bz: eb.z };
    break;
  }
  const n = pts.length;
  const nxA = new Float64Array(n);
  const nzA = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    nxA[i] = -dz / l;
    nzA[i] = dx / l;
  }
  const chunkOf = (p: XZ): number => Math.floor(p.x / size) * 100003 + Math.floor(p.z / size);
  let a = 0;
  while (a < n - 1) {
    const c = chunkOf(pts[a]);
    let b = a + 1;
    while (b < n - 1 && chunkOf(pts[b]) === c) b++;
    const m = b - a + 1;
    const run: RibbonRun = {
      road: ri,
      piece,
      kind,
      width,
      ci: Math.floor(pts[a].x / size),
      cj: Math.floor(pts[a].z / size),
      n: m,
      xs: new Float64Array(m),
      zs: new Float64Array(m),
      nx: new Float64Array(m),
      nz: new Float64Array(m),
      ss: new Float64Array(m),
      bridge: null,
    };
    for (let i = 0; i < m; i++) {
      run.xs[i] = pts[a + i].x;
      run.zs[i] = pts[a + i].z;
      run.nx[i] = nxA[a + i];
      run.nz[i] = nzA[a + i];
      run.ss[i] = ss[a + i];
    }
    if (span && run.ss[m - 1] >= span.s0 - cfg.bridgeRamp && run.ss[0] <= span.s1 + cfg.bridgeRamp) run.bridge = span;
    out.push(run);
    a = b;
  }
}

function pointAt(pts: XZ[], ss: number[], s: number): XZ {
  let i = 1;
  while (i < pts.length - 1 && ss[i] < s) i++;
  const t = Math.max(0, Math.min(1, (s - ss[i - 1]) / (ss[i] - ss[i - 1] || 1)));
  return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, z: pts[i - 1].z + (pts[i].z - pts[i - 1].z) * t };
}

function cum(pts: XZ[]): number[] {
  const s = [0];
  for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  return s;
}

function project(pts: XZ[], ss: number[], x: number, z: number): { s: number; d: number } | null {
  let best = 40;
  let bs = -1;
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
  return bs < 0 ? null : { s: bs, d: best };
}

function insertAt(pts: XZ[], ss: number[], at: number[]): XZ[] {
  const out: XZ[] = [];
  const targets = at.filter((s) => s > 0.05 && s < ss[ss.length - 1] - 0.05).sort((a, b) => a - b);
  let t = 0;
  for (let i = 0; i < pts.length; i++) {
    while (t < targets.length && i > 0 && targets[t] < ss[i] - 0.05 && targets[t] > ss[i - 1] + 0.05) {
      const f = (targets[t] - ss[i - 1]) / (ss[i] - ss[i - 1]);
      out.push({ x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f, z: pts[i - 1].z + (pts[i].z - pts[i - 1].z) * f });
      t++;
    }
    while (t < targets.length && Math.abs(targets[t] - ss[i]) <= 0.05) t++;
    out.push(pts[i]);
  }
  return out;
}

// ─── Build (heights + simplification) ────────────────────────────────────────

const smooth01 = (t: number): number => {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
};

/**
 * Deck top (without lift) along a bridge span. `hA`/`hB` are the terrain
 * heights at the span ends.
 */
export function deckHeight(span: BridgeSpan, hA: number, hB: number, s: number, cfg: RoadsConfig): number {
  const top = Math.max(hA, hB, span.water + cfg.bridgeClearance);
  const t = (s - span.s0) / (span.s1 - span.s0);
  return top + 0.35 * Math.sin(Math.PI * (t < 0 ? 0 : t > 1 ? 1 : t));
}

export function buildRun(run: RibbonRun, heightAt: (x: number, z: number) => number, cfg: RoadsConfig = CONFIG.world.towns.roads): RibbonData {
  const cols = ribbonColumns(run.kind, run.width);
  const nc = cols.length;
  const n = run.n;
  const lift = cfg.lift;
  const Y = new Float64Array(n * nc);
  const X = new Float64Array(n * nc);
  const Z = new Float64Array(n * nc);
  const flag = new Uint8Array(n);
  const forced = new Uint8Array(n);
  forced[0] = 1;
  forced[n - 1] = 1;
  const sp = run.bridge;
  let hA = 0;
  let hB = 0;
  if (sp) {
    // terrain at the span ends (identical for every run of the piece → no seams)
    hA = heightAt(sp.ax, sp.az);
    hB = heightAt(sp.bx, sp.bz);
  }
  const ramp = cfg.bridgeRamp;
  const eL = 1;
  const eR = nc - 2;
  for (let k = 0; k < n; k++) {
    const cx = run.xs[k];
    const cz = run.zs[k];
    const rx = run.nx[k];
    const rz = run.nz[k];
    const s = run.ss[k];
    let deck = NaN;
    let blend = 0;
    if (sp) {
      if (s >= sp.s0 - 1e-6 && s <= sp.s1 + 1e-6) {
        flag[k] = 2;
        deck = deckHeight(sp, hA, hB, s, cfg);
        blend = 1;
      } else if (s > sp.s0 - ramp && s < sp.s0) {
        flag[k] = 1;
        deck = deckHeight(sp, hA, hB, sp.s0, cfg);
        blend = smooth01((s - (sp.s0 - ramp)) / ramp);
      } else if (s > sp.s1 && s < sp.s1 + ramp) {
        flag[k] = 1;
        deck = deckHeight(sp, hA, hB, sp.s1, cfg);
        blend = smooth01((sp.s1 + ramp - s) / ramp);
      }
      if (Math.abs(s - sp.s0) < 0.06 || Math.abs(s - sp.s1) < 0.06 || Math.abs(s - (sp.s0 - ramp)) < 0.06 || Math.abs(s - (sp.s1 + ramp)) < 0.06) forced[k] = 1;
    }
    for (let c = 1; c < nc - 1; c++) {
      const x = cx + rx * cols[c];
      const z = cz + rz * cols[c];
      const i = k * nc + c;
      X[i] = x;
      Z[i] = z;
      if (flag[k] === 2) Y[i] = deck + lift;
      else {
        const g = heightAt(x, z) + lift;
        Y[i] = flag[k] === 1 ? Math.max(g, g + (deck + lift - g) * blend) : g;
      }
    }
    // skirts
    for (const c of [0, nc - 1]) {
      const e = c === 0 ? eL : eR;
      const side = c === 0 ? -1 : 1;
      const i = k * nc + c;
      const ei = k * nc + e;
      if (flag[k] === 2) {
        X[i] = X[ei];
        Z[i] = Z[ei];
        Y[i] = Y[ei] - 0.3;
        continue;
      }
      let out = SKIRT;
      if (flag[k] === 1) {
        const above = Y[ei] - heightAt(X[ei], Z[ei]);
        if (above > 0.2) out += above * 1.6;
      }
      const x = X[ei] + rx * side * out;
      const z = Z[ei] + rz * side * out;
      X[i] = x;
      Z[i] = z;
      Y[i] = heightAt(x, z) - 0.15;
    }
  }
  // greedy simplification
  const tol = cfg.drapeTolerance;
  const keep: number[] = [0];
  let i = 0;
  const fits = (a: number, b: number): boolean => {
    const sa = run.ss[a];
    const sb = run.ss[b];
    if (sb - sa > cfg.maxSegment) return false;
    for (let k = a + 1; k < b; k++) {
      const t = (run.ss[k] - sa) / (sb - sa);
      const ex = run.xs[a] + (run.xs[b] - run.xs[a]) * t - run.xs[k];
      const ez = run.zs[a] + (run.zs[b] - run.zs[a]) * t - run.zs[k];
      if (ex * ex + ez * ez > 0.08 * 0.08) return false;
      for (let c = 0; c < nc; c++) {
        const ya = Y[a * nc + c];
        const yb = Y[b * nc + c];
        const lim = c === 0 || c === nc - 1 ? tol * 4 : tol;
        if (Math.abs(ya + (yb - ya) * t - Y[k * nc + c]) > lim) return false;
      }
    }
    return true;
  };
  while (i < n - 1) {
    let j = i + 1;
    while (j + 1 < n && !forced[j] && fits(i, j + 1)) j++;
    keep.push(j);
    i = j;
  }
  const m = keep.length;
  const pos = new Float32Array(m * nc * 3);
  const road = new Float32Array(m * nc * 4);
  const bridge = new Uint8Array(m);
  const src = new Int32Array(m);
  const hw = run.width / 2;
  const kid = KIND_ID[run.kind];
  keep.forEach((k, o) => {
    bridge[o] = flag[k];
    src[o] = k;
    for (let c = 0; c < nc; c++) {
      const v = o * nc + c;
      pos[v * 3] = X[k * nc + c];
      pos[v * 3 + 1] = Y[k * nc + c];
      pos[v * 3 + 2] = Z[k * nc + c];
      road[v * 4] = cols[c];
      road[v * 4 + 1] = run.ss[k];
      road[v * 4 + 2] = hw;
      road[v * 4 + 3] = kid;
    }
  });
  return { n: m, pos, road, bridge, src };
}

// ─── Merge ────────────────────────────────────────────────────────────────────

export interface MergedRibbons {
  /** Positions relative to (ox, 0, oz). */
  position: Float32Array;
  road: Float32Array;
  index: Uint32Array;
}

export function mergeRuns(runs: readonly RibbonRun[], datas: readonly RibbonData[], ox = 0, oz = 0): MergedRibbons {
  let nv = 0;
  let ni = 0;
  runs.forEach((r, i) => {
    const nc = ribbonColumns(r.kind, r.width).length;
    nv += datas[i].n * nc;
    ni += Math.max(0, datas[i].n - 1) * (nc - 1) * 6;
  });
  const position = new Float32Array(nv * 3);
  const road = new Float32Array(nv * 4);
  const index = new Uint32Array(ni);
  let v0 = 0;
  let ii = 0;
  runs.forEach((r, ri) => {
    const d = datas[ri];
    const nc = ribbonColumns(r.kind, r.width).length;
    for (let v = 0; v < d.n * nc; v++) {
      position[(v0 + v) * 3] = d.pos[v * 3] - ox;
      position[(v0 + v) * 3 + 1] = d.pos[v * 3 + 1];
      position[(v0 + v) * 3 + 2] = d.pos[v * 3 + 2] - oz;
    }
    road.set(d.road, v0 * 4);
    for (let k = 0; k + 1 < d.n; k++)
      for (let c = 0; c + 1 < nc; c++) {
        const a = v0 + k * nc + c;
        const b = a + 1;
        const cc = a + nc;
        const dd = cc + 1;
        index[ii++] = a;
        index[ii++] = b;
        index[ii++] = cc;
        index[ii++] = b;
        index[ii++] = dd;
        index[ii++] = cc;
      }
    v0 += d.n * nc;
  });
  return { position, road, index };
}
