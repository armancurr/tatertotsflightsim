/**
 * Road ribbons (PURE, no three.js): runs of the plan (plan.ts) turned into
 * terrain-draped triangle strips with everything the road shader needs.
 *
 * Cross-section columns (mirrored): paved centre … paved edge (hw), the
 * sidewalk or shoulder edge, and the soft verge edge (alpha → 0 in the shader,
 * so the road blends into the terrain instead of looking pasted on).
 * Heights: every column sits on heightAt at its own xz (the road banks with the
 * ground) + a lift: paved/sidewalk `lift` (+1.2 cm per kind rank, so the
 * higher-ranked road wins where ribbons overlap at junctions), shoulders half
 * of that, the verge edge 2 cm. Bridge spans carry the deck (deckHeight) with
 * approach ramps whose verges widen into embankments down to the ground.
 * After sampling, greedy simplification drops a section while the straight
 * interpolation between its neighbours stays within `drapeTolerance`.
 *
 * Per-vertex attributes (see material.ts):
 *   aRoad  = (across m, along m, paved half width m, info)
 *            info = kind + 8·flags + 64·sidewalk(dm), flags: 1 sidewalk,
 *            2 arterial, 4 embankment/bridge (opaque verge)
 *   aJunc  = (dS, dE, hS, hE)  distance to the junction centre at the start /
 *            end and the crossing half widths (plan.ts PieceEnd.h)
 *   aJunc2 = (yS, yE)          crossing sidewalk widths (+100 = cut end)
 * Structures (bridges, guard rails) share the mesh with kind 6 (see
 * structures.ts): aRoad = (u, v, 0, 6 + 8·material).
 */
import type { RibbonRun, RoadPiece, BridgeSpan, RoadsConfig } from './plan';
import { KIND_ID } from './plan';
import { KIND_RANK } from './network';
import { CONFIG } from '../../config';

export { KIND_ID } from './plan';
export type { RibbonRun, RoadsConfig } from './plan';

export type RibbonMode = 'near' | 'far';

export const FLAG_SIDEWALK = 1;
export const FLAG_ARTERIAL = 2;
export const FLAG_EMBANK = 4;
/** Verge edge height above the terrain, m. */
export const VERGE_LIFT = 0.02;
/** Extra height of a sidewalk's outer edge over the road, m (a kerb read from above). */
export const SIDEWALK_RISE = 0.03;

/** Across offsets of a cross-section's columns (m, − = left of travel). */
export function ribbonColumns(p: Pick<RoadPiece, 'width' | 'style'>, mode: RibbonMode = 'near'): number[] {
  const hw = p.width / 2;
  const st = p.style;
  const out = hw + (st.sidewalk > 0 ? st.sidewalk : st.shoulder);
  const fade = out + st.fade;
  if (mode === 'far') return [-fade, -hw, 0, hw, fade];
  const inner = hw >= 3 ? [-hw, -hw / 2, 0, hw / 2, hw] : [-hw, 0, hw];
  return [-fade, -out, ...inner, out, fade];
}

/** Paved lift of a kind (higher rank a little higher), m. */
export function pavedLift(kind: RoadPiece['kind'], cfg: RoadsConfig = CONFIG.world.towns.roads): number {
  return cfg.lift + 0.012 * KIND_RANK[kind];
}

const smooth01 = (t: number): number => {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
};

/** Deck top (without lift) along a bridge span; hA/hB are the terrain heights at the span ends. */
export function deckHeight(span: BridgeSpan, hA: number, hB: number, s: number, cfg: RoadsConfig = CONFIG.world.towns.roads): number {
  const top = Math.max(hA, hB, span.water + cfg.bridgeClearance);
  const t = (s - span.s0) / (span.s1 - span.s0);
  return top + 0.35 * Math.sin(Math.PI * (t < 0 ? 0 : t > 1 ? 1 : t));
}

/** Where s lies on a bridged piece: 0 road, 1 ramp, 2 span; the deck height there and the ramp blend (0 ground … 1 deck). */
export function bridgeProfile(sp: BridgeSpan, hA: number, hB: number, s: number, cfg: RoadsConfig = CONFIG.world.towns.roads): { flag: 0 | 1 | 2; deck: number; blend: number } {
  const ramp = cfg.bridgeRamp;
  if (s >= sp.s0 - 1e-6 && s <= sp.s1 + 1e-6) return { flag: 2, deck: deckHeight(sp, hA, hB, s, cfg), blend: 1 };
  if (s > sp.s0 - ramp && s < sp.s0) return { flag: 1, deck: deckHeight(sp, hA, hB, sp.s0, cfg), blend: smooth01((s - (sp.s0 - ramp)) / ramp) };
  if (s > sp.s1 && s < sp.s1 + ramp) return { flag: 1, deck: deckHeight(sp, hA, hB, sp.s1, cfg), blend: smooth01((sp.s1 + ramp - s) / ramp) };
  return { flag: 0, deck: NaN, blend: 0 };
}

export interface RibbonData {
  /** Kept sections, columns per section. */
  n: number;
  nc: number;
  /** World positions, n × nc × 3. */
  pos: Float32Array;
  /** Per vertex attributes (see header). */
  road: Float32Array;
  junc: Float32Array;
  junc2: Float32Array;
  /** Unit normals, n × nc × 3. */
  normal: Float32Array;
  /** Per kept section: 0 road, 1 bridge ramp, 2 bridge span. */
  bridge: Uint8Array;
  /** Per kept section: its sample index in the piece. */
  src: Int32Array;
  /** Per kept section: road arc length, and the heights of the left paved edge, centre and right paved edge (no shader lift). */
  s: Float32Array;
  yL: Float32Array;
  yC: Float32Array;
  yR: Float32Array;
}

export interface BuildOptions {
  mode?: RibbonMode;
  /** Use every `stride`-th sample (forced samples always) — the far LOD samples less. */
  stride?: number;
  /** Simplification tolerance, m (default cfg.drapeTolerance) and longest segment (default cfg.maxSegment). */
  tolerance?: number;
  maxSegment?: number;
}

/** Encodes the per-piece info float. */
export function pieceInfo(p: RoadPiece, embank: boolean): number {
  let flags = 0;
  if (p.style.sidewalk > 0) flags |= FLAG_SIDEWALK;
  if (p.style.arterial) flags |= FLAG_ARTERIAL;
  if (embank) flags |= FLAG_EMBANK;
  return KIND_ID[p.kind] + 8 * flags + 64 * Math.min(63, Math.round(p.style.sidewalk * 10));
}

export function buildRun(run: RibbonRun, heightAt: (x: number, z: number) => number, cfg: RoadsConfig = CONFIG.world.towns.roads, opts: BuildOptions = {}): RibbonData {
  const p = run.piece;
  const mode = opts.mode ?? 'near';
  const stride = Math.max(1, opts.stride ?? 1);
  const cols = ribbonColumns(p, mode);
  const nc = cols.length;
  const hw = p.width / 2;
  const sp = p.bridge;
  const ramp = cfg.bridgeRamp;
  // candidate samples: every stride-th + forced (run ends, bridge boundaries)
  const cand: number[] = [];
  for (let i = run.i0; i <= run.i1; i++) {
    const s = p.ss[i];
    let forced = i === run.i0 || i === run.i1;
    if (sp && (Math.abs(s - sp.s0) < 0.06 || Math.abs(s - sp.s1) < 0.06 || Math.abs(s - (sp.s0 - ramp)) < 0.06 || Math.abs(s - (sp.s1 + ramp)) < 0.06)) forced = true;
    if (forced || (i - run.i0) % stride === 0 || (sp && s > sp.s0 - 1 && s < sp.s1 + 1)) cand.push(forced ? -i - 1 : i);
  }
  const n = cand.length;
  const idx = new Int32Array(n);
  const forced = new Uint8Array(n);
  cand.forEach((c, k) => {
    idx[k] = c < 0 ? -c - 1 : c;
    forced[k] = c < 0 ? 1 : 0;
  });
  const X = new Float64Array(n * nc);
  const Y = new Float64Array(n * nc);
  const Z = new Float64Array(n * nc);
  const flag = new Uint8Array(n);
  let hA = 0;
  let hB = 0;
  if (sp) {
    hA = heightAt(sp.ax, sp.az);
    hB = heightAt(sp.bx, sp.bz);
  }
  const paved = pavedLift(p.kind, cfg);
  const shoulderLift = cfg.lift * 0.5;
  const sidewalk = p.style.sidewalk > 0;
  for (let k = 0; k < n; k++) {
    const i = idx[k];
    const cx = p.xs[i];
    const cz = p.zs[i];
    const rx = p.nx[i];
    const rz = p.nz[i];
    const s = p.ss[i];
    let deck = NaN;
    let blend = 0;
    if (sp) {
      const bp = bridgeProfile(sp, hA, hB, s, cfg);
      flag[k] = bp.flag;
      deck = bp.deck;
      blend = bp.blend;
    }
    // paved columns first (|c| ≤ hw)
    let edgeAbove = 0;
    for (let c = 0; c < nc; c++) {
      const a = cols[c];
      if (Math.abs(a) > hw + 1e-6) continue;
      const x = cx + rx * a;
      const z = cz + rz * a;
      const o = k * nc + c;
      X[o] = x;
      Z[o] = z;
      if (flag[k] === 2) Y[o] = deck + paved;
      else {
        const g = heightAt(x, z) + paved;
        Y[o] = flag[k] === 1 ? Math.max(g, g + (deck + paved - g) * blend) : g;
        if (flag[k] === 1 && Math.abs(Math.abs(a) - hw) < 1e-6) edgeAbove = Math.max(edgeAbove, Y[o] - paved - heightAt(x, z));
      }
    }
    // outside columns
    for (let c = 0; c < nc; c++) {
      const a = cols[c];
      if (Math.abs(a) <= hw + 1e-6) continue;
      const side = a < 0 ? -1 : 1;
      const o = k * nc + c;
      const eo = k * nc + (side < 0 ? cols.indexOf(-hw) : cols.indexOf(hw));
      const outer = c === 0 || c === nc - 1;
      if (flag[k] === 2) {
        // on the span: tucked under the parapet
        X[o] = cx + rx * side * (hw + 0.35);
        Z[o] = cz + rz * side * (hw + 0.35);
        Y[o] = Y[eo] - 0.4;
        continue;
      }
      let across = Math.abs(a);
      if (flag[k] === 1 && outer && edgeAbove > 0.2) across += edgeAbove * 1.6;
      const x = cx + rx * side * across;
      const z = cz + rz * side * across;
      X[o] = x;
      Z[o] = z;
      const g = heightAt(x, z);
      if (outer) Y[o] = g + VERGE_LIFT;
      else if (flag[k] === 1 && edgeAbove > 0.2) Y[o] = Y[eo] - 0.08;
      else Y[o] = sidewalk ? g + paved + SIDEWALK_RISE : g + shoulderLift;
    }
  }
  // greedy simplification
  const tol = opts.tolerance ?? cfg.drapeTolerance;
  const maxSeg = opts.maxSegment ?? cfg.maxSegment;
  const keep: number[] = [0];
  const fits = (a: number, b: number): boolean => {
    const sa = p.ss[idx[a]];
    const sb = p.ss[idx[b]];
    if (sb - sa > maxSeg) return false;
    if (flag[a] !== flag[b] && (flag[a] === 2 || flag[b] === 2)) return false;
    for (let k = a + 1; k < b; k++) {
      const t = (p.ss[idx[k]] - sa) / (sb - sa);
      const ia = idx[a];
      const ib = idx[b];
      const ik = idx[k];
      const ex = p.xs[ia] + (p.xs[ib] - p.xs[ia]) * t - p.xs[ik];
      const ez = p.zs[ia] + (p.zs[ib] - p.zs[ia]) * t - p.zs[ik];
      if (ex * ex + ez * ez > 0.08 * 0.08 * (mode === 'far' ? 16 : 1)) return false;
      for (let c = 0; c < nc; c++) {
        const ya = Y[a * nc + c];
        const yb = Y[b * nc + c];
        const lim = c === 0 || c === nc - 1 ? tol * 4 : tol;
        if (Math.abs(ya + (yb - ya) * t - Y[k * nc + c]) > lim) return false;
      }
    }
    return true;
  };
  let i = 0;
  while (i < n - 1) {
    let j = i + 1;
    while (j + 1 < n && !forced[j] && fits(i, j + 1)) j++;
    keep.push(j);
    i = j;
  }
  const m = keep.length;
  const out: RibbonData = {
    n: m,
    nc,
    pos: new Float32Array(m * nc * 3),
    road: new Float32Array(m * nc * 4),
    junc: new Float32Array(m * nc * 4),
    junc2: new Float32Array(m * nc * 2),
    normal: new Float32Array(m * nc * 3),
    bridge: new Uint8Array(m),
    src: new Int32Array(m),
    s: new Float32Array(m),
    yL: new Float32Array(m),
    yC: new Float32Array(m),
    yR: new Float32Array(m),
  };
  const eL = cols.indexOf(-hw);
  const eR = cols.indexOf(hw);
  const cC = cols.indexOf(0);
  const s0 = p.ss[0];
  const s1 = p.ss[p.n - 1];
  const hS = p.start.h;
  const hE = p.end.h;
  const yS = p.start.y + (p.start.cut ? 100 : 0);
  const yE = p.end.y + (p.end.cut ? 100 : 0);
  const alongOffset = (p.road * 61.7) % 400;
  keep.forEach((k, o) => {
    const si = idx[k];
    const s = p.ss[si];
    out.bridge[o] = flag[k];
    out.src[o] = si;
    out.s[o] = s;
    out.yL[o] = Y[k * nc + eL];
    out.yC[o] = Y[k * nc + cC];
    out.yR[o] = Y[k * nc + eR];
    const info = pieceInfo(p, flag[k] !== 0);
    const dS = s - s0 + p.start.off;
    const dE = s1 - s + p.end.off;
    for (let c = 0; c < nc; c++) {
      const v = o * nc + c;
      out.pos[v * 3] = X[k * nc + c];
      out.pos[v * 3 + 1] = Y[k * nc + c];
      out.pos[v * 3 + 2] = Z[k * nc + c];
      out.road[v * 4] = cols[c];
      out.road[v * 4 + 1] = s + alongOffset;
      out.road[v * 4 + 2] = hw;
      out.road[v * 4 + 3] = info;
      out.junc[v * 4] = dS;
      out.junc[v * 4 + 1] = dE;
      out.junc[v * 4 + 2] = hS;
      out.junc[v * 4 + 3] = hE;
      out.junc2[v * 2] = yS;
      out.junc2[v * 2 + 1] = yE;
    }
  });
  // normals from the kept grid (neighbouring sections along, neighbouring columns across)
  const P = out.pos;
  for (let o = 0; o < m; o++)
    for (let c = 0; c < nc; c++) {
      const a0 = (Math.max(0, o - 1) * nc + c) * 3;
      const a1 = (Math.min(m - 1, o + 1) * nc + c) * 3;
      const b0 = (o * nc + Math.max(0, c - 1)) * 3;
      const b1 = (o * nc + Math.min(nc - 1, c + 1)) * 3;
      const tx = P[a1] - P[a0];
      const ty = P[a1 + 1] - P[a0 + 1];
      const tz = P[a1 + 2] - P[a0 + 2];
      const ux = P[b1] - P[b0];
      const uy = P[b1 + 1] - P[b0 + 1];
      const uz = P[b1 + 2] - P[b0 + 2];
      // n = u × t (across × along) — pointing up for a right-hand across
      let nx = uy * tz - uz * ty;
      let ny = uz * tx - ux * tz;
      let nz = ux * ty - uy * tx;
      if (ny < 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
      const l = Math.hypot(nx, ny, nz);
      const v = (o * nc + c) * 3;
      if (l > 1e-9) {
        out.normal[v] = nx / l;
        out.normal[v + 1] = ny / l;
        out.normal[v + 2] = nz / l;
      } else out.normal[v + 1] = 1;
    }
  return out;
}

// ─── Merge ────────────────────────────────────────────────────────────────────

export interface MergedGeometry {
  /** Positions relative to (ox, 0, oz). */
  position: Float32Array;
  normal: Float32Array;
  road: Float32Array;
  junc: Float32Array;
  junc2: Float32Array;
  index: Uint32Array;
  minY: number;
  maxY: number;
}

/** A structure part in the same vertex format (structures.ts). */
export interface PartData {
  pos: Float32Array;
  normal: Float32Array;
  road: Float32Array;
  index: Uint32Array;
}

export function mergeRibbons(datas: readonly RibbonData[], parts: readonly PartData[] = [], ox = 0, oz = 0): MergedGeometry {
  let nv = 0;
  let ni = 0;
  for (const d of datas) {
    nv += d.n * d.nc;
    ni += Math.max(0, d.n - 1) * (d.nc - 1) * 6;
  }
  for (const p of parts) {
    nv += p.pos.length / 3;
    ni += p.index.length;
  }
  const g: MergedGeometry = {
    position: new Float32Array(nv * 3),
    normal: new Float32Array(nv * 3),
    road: new Float32Array(nv * 4),
    junc: new Float32Array(nv * 4),
    junc2: new Float32Array(nv * 2),
    index: new Uint32Array(ni),
    minY: Infinity,
    maxY: -Infinity,
  };
  let v0 = 0;
  let ii = 0;
  const copyPos = (src: Float32Array, at: number) => {
    const count = src.length / 3;
    for (let v = 0; v < count; v++) {
      const y = src[v * 3 + 1];
      g.position[(at + v) * 3] = src[v * 3] - ox;
      g.position[(at + v) * 3 + 1] = y;
      g.position[(at + v) * 3 + 2] = src[v * 3 + 2] - oz;
      if (y < g.minY) g.minY = y;
      if (y > g.maxY) g.maxY = y;
    }
  };
  for (const d of datas) {
    const nc = d.nc;
    copyPos(d.pos, v0);
    g.normal.set(d.normal, v0 * 3);
    g.road.set(d.road, v0 * 4);
    g.junc.set(d.junc, v0 * 4);
    g.junc2.set(d.junc2, v0 * 2);
    for (let k = 0; k + 1 < d.n; k++)
      for (let c = 0; c + 1 < nc; c++) {
        const a = v0 + k * nc + c;
        const b = a + 1;
        const cc = a + nc;
        const dd = cc + 1;
        // counter-clockwise seen from above (+across = right of travel)
        g.index[ii++] = a;
        g.index[ii++] = b;
        g.index[ii++] = cc;
        g.index[ii++] = b;
        g.index[ii++] = dd;
        g.index[ii++] = cc;
      }
    v0 += d.n * nc;
  }
  for (const p of parts) {
    const count = p.pos.length / 3;
    copyPos(p.pos, v0);
    g.normal.set(p.normal, v0 * 3);
    g.road.set(p.road, v0 * 4);
    for (let k = 0; k < p.index.length; k++) g.index[ii++] = v0 + p.index[k];
    v0 += count;
  }
  if (nv === 0) g.minY = g.maxY = 0;
  return g;
}
