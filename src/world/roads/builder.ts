/**
 * Road builder (PURE, no three.js): everything heavy about roads, run in a Web
 * Worker (roads.worker.ts) or inline (tests, fallback) — the same code.
 *
 *   summary()        chunk list (near + far LOD), the lane graph for cars and
 *                    the street lights — cheap to transfer (typed arrays)
 *   build(key, far)  one chunk's merged geometry (ribbons + bridges + guard
 *                    rails) and, for near chunks, the surface profiles cars
 *                    drive on (the exact heights of the rendered ribbon)
 */
import type { WorldLayout } from '../layout';
import { getRoadNetwork } from './network';
import { planRoads, runsFor, chunkKey, KIND_ID, type RoadPlan, type RibbonRun, type RoadPiece, type RoadsConfig } from './plan';
import { buildRun, mergeRibbons, pavedLift, bridgeProfile, VERGE_LIFT, type MergedGeometry, type RibbonData, type PartData } from './ribbon';
import { PartBuilder, buildBridge, buildGuardRail } from './structures';
import { CONFIG } from '../../config';

export interface ChunkInfo {
  key: string;
  far: boolean;
  ci: number;
  cj: number;
  x0: number;
  z0: number;
  size: number;
  /** Sections before simplification (a cost estimate). */
  samples: number;
}

/** Surface heights of one run as rendered (per kept section), for cars. */
export interface RunProfile {
  piece: number;
  s: Float32Array;
  yL: Float32Array;
  yC: Float32Array;
  yR: Float32Array;
}

export interface ChunkBuild {
  key: string;
  far: boolean;
  ox: number;
  oz: number;
  geometry: MergedGeometry;
  profiles: RunProfile[];
}

/**
 * The lane graph (typed arrays, transferable):
 *   pieceI  per piece: road, kindId, town, startNode, endNode, ptStart, ptCount, flags (1 sidewalk, 2 arterial, 4 bridge)
 *   pieceF  per piece: width, sidewalk width, s0, s1
 *   pts     per point: x, z, s, nx, nz, vmax (m/s)
 *   nodes   per node: x, z;  nodeEnds: CSR (nodeStart[n]..nodeStart[n+1]) of piece×2+end
 */
export interface LaneData {
  pieceI: Int32Array;
  pieceF: Float32Array;
  pts: Float32Array;
  nodes: Float32Array;
  nodeStart: Int32Array;
  nodeEnds: Int32Array;
}
export const PIECE_I = 8;
export const PIECE_F = 4;
export const PT = 6;

export interface RoadSummary {
  chunks: ChunkInfo[];
  lanes: LaneData;
  /** Street lights: x, y (base), z, yaw (rad, the arm points along −sin/−cos… see lights.ts), per light. */
  lights: Float32Array;
  /** Plan stats. */
  pieces: number;
  nodes: number;
}

/** Speed limits by kind, m/s (≈ 55, 45, 35, 30, 25, 15 mph). */
export const SPEED_LIMIT: Record<RoadPiece['kind'], number> = { highway: 24.6, road: 20, access: 15.6, lane: 13.4, street: 11.2, drive: 6.7 };
/** Through a town. */
export const TOWN_SPEED = 13.4;

export class RoadBuilder {
  readonly plan: RoadPlan;
  private near = new Map<string, RibbonRun[]>();
  private far = new Map<string, RibbonRun[]>();
  private bridgeChunk = new Map<string, RoadPiece[]>();
  private farBridgeChunk = new Map<string, RoadPiece[]>();

  constructor(
    private layout: WorldLayout,
    private heightAt: (x: number, z: number) => number,
    private cfg: RoadsConfig = CONFIG.world.towns.roads,
  ) {
    const net = getRoadNetwork(layout, heightAt);
    this.plan = planRoads(net, layout.bridges, layout.towns, cfg);
    for (const r of runsFor(this.plan.pieces, cfg.chunkSize)) {
      const k = chunkKey(r.ci, r.cj);
      (this.near.get(k) ?? this.near.set(k, []).get(k)!).push(r);
    }
    for (const r of runsFor(this.plan.pieces, cfg.farChunkSize, (p) => p.kind !== 'drive')) {
      const k = chunkKey(r.ci, r.cj);
      (this.far.get(k) ?? this.far.set(k, []).get(k)!).push(r);
    }
    // bridges belong to the chunk of their centre
    const seen = new Set<object>();
    for (const p of this.plan.pieces) {
      if (!p.bridge || seen.has(p.bridge)) continue;
      // the piece that holds the whole span
      if (p.ss[0] > p.bridge.s0 || p.ss[p.n - 1] < p.bridge.s1) continue;
      seen.add(p.bridge);
      const kn = chunkKey(Math.floor(p.bridge.x / cfg.chunkSize), Math.floor(p.bridge.z / cfg.chunkSize));
      const kf = chunkKey(Math.floor(p.bridge.x / cfg.farChunkSize), Math.floor(p.bridge.z / cfg.farChunkSize));
      (this.bridgeChunk.get(kn) ?? this.bridgeChunk.set(kn, []).get(kn)!).push(p);
      (this.farBridgeChunk.get(kf) ?? this.farBridgeChunk.set(kf, []).get(kf)!).push(p);
      if (!this.near.has(kn)) this.near.set(kn, []);
      if (!this.far.has(kf)) this.far.set(kf, []);
    }
  }

  chunks(): ChunkInfo[] {
    const out: ChunkInfo[] = [];
    const add = (m: Map<string, RibbonRun[]>, far: boolean, size: number) => {
      for (const [key, runs] of m) {
        const [ci, cj] = key.split(',').map(Number);
        let samples = 0;
        for (const r of runs) samples += r.i1 - r.i0 + 1;
        out.push({ key, far, ci, cj, x0: ci * size, z0: cj * size, size, samples });
      }
    };
    add(this.near, false, this.cfg.chunkSize);
    add(this.far, true, this.cfg.farChunkSize);
    return out;
  }

  summary(): RoadSummary {
    return { chunks: this.chunks(), lanes: this.lanes(), lights: this.lights(), pieces: this.plan.pieces.length, nodes: this.plan.nodes.length };
  }

  build(key: string, far: boolean): ChunkBuild {
    const cfg = this.cfg;
    const size = far ? cfg.farChunkSize : cfg.chunkSize;
    const runs = (far ? this.far : this.near).get(key) ?? [];
    const [ci, cj] = key.split(',').map(Number);
    const ox = (ci + 0.5) * size;
    const oz = (cj + 0.5) * size;
    const datas: RibbonData[] = [];
    const profiles: RunProfile[] = [];
    for (const r of runs) {
      const d = far
        ? buildRun(r, this.heightAt, cfg, { mode: 'far', stride: cfg.farStride, tolerance: cfg.farTolerance, maxSegment: cfg.farMaxSegment })
        : buildRun(r, this.heightAt, cfg);
      datas.push(d);
      if (!far) profiles.push({ piece: r.piece.id, s: d.s, yL: d.yL, yC: d.yC, yR: d.yR });
    }
    const pb = new PartBuilder();
    for (const p of (far ? this.farBridgeChunk : this.bridgeChunk).get(key) ?? []) buildBridge(pb, p, this.heightAt, !far, cfg);
    if (!far) this.guardRails(pb, runs);
    const parts: PartData[] = pb.vertexCount > 0 ? [pb.data()] : [];
    return { key, far, ox, oz, geometry: mergeRibbons(datas, parts, ox, oz), profiles };
  }

  /** W-beam rails on bridge ramps and where the ground falls away beside a major road. */
  private guardRails(pb: PartBuilder, runs: RibbonRun[]): void {
    const cfg = this.cfg;
    for (const r of runs) {
      const p = r.piece;
      if (p.kind !== 'highway' && p.kind !== 'road' && p.kind !== 'access') continue;
      const hw = p.width / 2;
      const off = hw + Math.min(0.8, p.style.shoulder * 0.6);
      const sp = p.bridge;
      const hA = sp ? this.heightAt(sp.ax, sp.az) : 0;
      const hB = sp ? this.heightAt(sp.bx, sp.bz) : 0;
      const lift = pavedLift(p.kind, cfg);
      const baseY = (i: number, x: number, z: number): number => {
        const g = this.heightAt(x, z) + VERGE_LIFT;
        if (!sp) return g;
        const bp = bridgeProfile(sp, hA, hB, p.ss[i], cfg);
        if (bp.flag === 0) return g;
        const ex = p.xs[i] + p.nx[i] * hw;
        const ez = p.zs[i] + p.nz[i] * hw;
        const ge = this.heightAt(ex, ez);
        return Math.max(g, ge + (bp.deck - ge) * bp.blend + lift - 0.05);
      };
      for (const side of [1, -1] as const) {
        let a = -1;
        const flush = (b: number) => {
          if (a >= 0 && b - a >= 3) buildGuardRail(pb, p, a, b, side, off, baseY);
          a = -1;
        };
        for (let i = r.i0; i <= r.i1; i++) {
          const s = p.ss[i];
          let need = false;
          if (sp && s > sp.s0 - cfg.bridgeRamp + 12 && s < sp.s1 + cfg.bridgeRamp - 12) need = s < sp.s0 + 0.5 || s > sp.s1 - 0.5;
          else if (!sp || s < sp.s0 - cfg.bridgeRamp || s > sp.s1 + cfg.bridgeRamp) {
            const ex = p.xs[i] + p.nx[i] * side * hw;
            const ez = p.zs[i] + p.nz[i] * side * hw;
            const g0 = this.heightAt(ex, ez);
            const g1 = this.heightAt(ex + p.nx[i] * side * 5, ez + p.nz[i] * side * 5);
            need = g0 - g1 > 2.2;
          }
          if (need && a < 0) a = i;
          if (!need && a >= 0) flush(i);
        }
        flush(r.i1);
      }
    }
  }

  /** The lane graph for cars (see LaneData). Points are the piece samples simplified to ≤ 5 cm deviation. */
  lanes(): LaneData {
    const P = this.plan.pieces;
    const pieceI = new Int32Array(P.length * PIECE_I);
    const pieceF = new Float32Array(P.length * PIECE_F);
    const pts: number[] = [];
    const towns = this.layout.towns;
    const inTown = (x: number, z: number): boolean => {
      for (const t of towns) if ((x - t.x) ** 2 + (z - t.z) ** 2 < (t.radius * 0.95) ** 2) return true;
      return false;
    };
    P.forEach((p, i) => {
      const keep: number[] = [0];
      let a = 0;
      for (let b = 2; b < p.n; b++) {
        // can a → b replace everything in between?
        let ok = b - a < 12;
        for (let k = a + 1; k < b && ok; k++) {
          const t = (p.ss[k] - p.ss[a]) / (p.ss[b] - p.ss[a]);
          const ex = p.xs[a] + (p.xs[b] - p.xs[a]) * t - p.xs[k];
          const ez = p.zs[a] + (p.zs[b] - p.zs[a]) * t - p.zs[k];
          if (ex * ex + ez * ez > 0.0025) ok = false;
        }
        if (!ok) {
          keep.push(b - 1);
          a = b - 1;
        }
      }
      if (keep[keep.length - 1] !== p.n - 1) keep.push(p.n - 1);
      const start = pts.length / PT;
      for (const k of keep) {
        let v = SPEED_LIMIT[p.kind];
        if (p.kind !== 'street' && p.kind !== 'drive' && inTown(p.xs[k], p.zs[k])) v = Math.min(v, TOWN_SPEED);
        pts.push(p.xs[k], p.zs[k], p.ss[k], p.nx[k], p.nz[k], v);
      }
      const flags = (p.style.sidewalk > 0 ? 1 : 0) | (p.style.arterial ? 2 : 0) | (p.bridge ? 4 : 0);
      pieceI.set([p.road, KIND_ID[p.kind], p.town, p.start.node, p.end.node, start, keep.length, flags], i * PIECE_I);
      pieceF.set([p.width, p.style.sidewalk, p.ss[0], p.ss[p.n - 1]], i * PIECE_F);
    });
    const N = this.plan.nodes;
    const nodes = new Float32Array(N.length * 2);
    const nodeStart = new Int32Array(N.length + 1);
    let total = 0;
    N.forEach((n, i) => {
      nodes[i * 2] = n.x;
      nodes[i * 2 + 1] = n.z;
      nodeStart[i] = total;
      total += n.ends.length;
    });
    nodeStart[N.length] = total;
    const nodeEnds = new Int32Array(total);
    N.forEach((n, i) => nodeEnds.set(n.ends, nodeStart[i]));
    return { pieceI, pieceF, pts: new Float32Array(pts), nodes, nodeStart, nodeEnds };
  }

  /** Street lights along town streets (x, y, z, yaw per light). */
  lights(): Float32Array {
    const out: number[] = [];
    const spacing = this.cfg.streetLightSpacing;
    for (const p of this.plan.pieces) {
      if (p.kind !== 'street') continue;
      const sw = p.style.sidewalk;
      const hw = p.width / 2;
      const off = sw > 0 ? hw + sw - 0.45 : hw + 1.3;
      const len = p.ss[p.n - 1] - p.ss[0];
      const both = p.style.arterial;
      const gap = sw > 0 ? spacing : spacing * 1.5;
      const ends = (s: number) => {
        const dS = s - p.ss[0] + p.start.off;
        const dE = p.ss[p.n - 1] - s + p.end.off;
        return (p.start.h !== 0 && dS < Math.abs(p.start.h) + 2) || (p.end.h !== 0 && dE < Math.abs(p.end.h) + 2);
      };
      // phase from the road so neighbouring pieces continue the rhythm
      const phase = ((p.road * 13.7) % gap) + gap * 0.5;
      let k = 0;
      for (let s = p.ss[0] + (((phase - p.ss[0]) % gap) + gap) % gap; s < p.ss[p.n - 1]; s += gap, k++) {
        if (len < 6 || ends(s)) continue;
        const side = both ? (k % 2 === 0 ? 1 : -1) : 1;
        // sample index
        let i = 1;
        while (i < p.n - 1 && p.ss[i] < s) i++;
        const t = (s - p.ss[i - 1]) / (p.ss[i] - p.ss[i - 1] || 1);
        const cx = p.xs[i - 1] + (p.xs[i] - p.xs[i - 1]) * t;
        const cz = p.zs[i - 1] + (p.zs[i] - p.zs[i - 1]) * t;
        const nx = p.nx[i];
        const nz = p.nz[i];
        const x = cx + nx * side * off;
        const z = cz + nz * side * off;
        // the arm (local −z) points back toward the road: (−sin yaw, −cos yaw) = (−nx·side, −nz·side)
        const yaw = Math.atan2(nx * side, nz * side);
        out.push(x, this.heightAt(x, z) + (sw > 0 ? pavedLift(p.kind, this.cfg) : 0), z, yaw);
      }
    }
    return new Float32Array(out);
  }
}
