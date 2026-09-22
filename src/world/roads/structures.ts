/**
 * Road structures (PURE): bridges (deck slab with fascia and girders, concrete
 * parapets with a steel rail, piers with cap beams down into the river bed,
 * abutments with wing walls) and W-beam guard rails on posts along bridge
 * ramps and embankments. Output is in the ribbon vertex format (ribbon.ts
 * PartData, kind 6), so it merges into the chunk mesh: no extra draw calls.
 */
import type { RoadPiece, RoadsConfig } from './plan';
import type { PartData } from './ribbon';
import { deckHeight, pavedLift } from './ribbon';
import { CONFIG } from '../../config';

export const MAT_CONCRETE = 0;
export const MAT_STEEL = 1;
export const MAT_DARK = 2;
export const MAT_OLD_CONCRETE = 3;
export const MAT_STONE = 4;

type V3 = [number, number, number];

/** Accumulates flat-shaded faces in the ribbon vertex format. */
export class PartBuilder {
  private pos: number[] = [];
  private nor: number[] = [];
  private road: number[] = [];
  private idx: number[] = [];

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  /** A planar quad a-b-c-d (counter-clockwise seen from the front), uv in metres for the shader noise. */
  quad(a: V3, b: V3, c: V3, d: V3, mat: number): void {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = d[0] - a[0];
    const vy = d[1] - a[1];
    const vz = d[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-12) return;
    nx /= l;
    ny /= l;
    nz /= l;
    const lu = Math.hypot(ux, uy, uz) || 1;
    const lv = Math.hypot(vx, vy, vz) || 1;
    const v0 = this.vertexCount;
    const uvs: [number, number][] = [
      [0, 0],
      [lu, 0],
      [lu, lv],
      [0, lv],
    ];
    const off = (a[0] + a[2]) * 0.37;
    [a, b, c, d].forEach((p, i) => {
      this.pos.push(p[0], p[1], p[2]);
      this.nor.push(nx, ny, nz);
      this.road.push(uvs[i][0] + off, uvs[i][1] + p[1] * 0.5, 0, 6 + 8 * mat);
    });
    this.idx.push(v0, v0 + 1, v0 + 2, v0, v0 + 2, v0 + 3);
  }

  /** Oriented box: centre, unit axes u (up) and f (forward) — right = f × u — and half sizes. */
  box(c: V3, u: V3, fw: V3, hr: number, hu: number, hf: number, mat: number, bottom = true): void {
    const r: V3 = [fw[1] * u[2] - fw[2] * u[1], fw[2] * u[0] - fw[0] * u[2], fw[0] * u[1] - fw[1] * u[0]];
    const p = (sr: number, su: number, sf: number): V3 => [
      c[0] + r[0] * hr * sr + u[0] * hu * su + fw[0] * hf * sf,
      c[1] + r[1] * hr * sr + u[1] * hu * su + fw[1] * hf * sf,
      c[2] + r[2] * hr * sr + u[2] * hu * su + fw[2] * hf * sf,
    ];
    // +r, −r, +u, −u, +f, −f faces (outward CCW)
    this.quad(p(1, -1, -1), p(1, -1, 1), p(1, 1, 1), p(1, 1, -1), mat);
    this.quad(p(-1, -1, 1), p(-1, -1, -1), p(-1, 1, -1), p(-1, 1, 1), mat);
    this.quad(p(-1, 1, -1), p(1, 1, -1), p(1, 1, 1), p(-1, 1, 1), mat);
    if (bottom) this.quad(p(-1, -1, 1), p(1, -1, 1), p(1, -1, -1), p(-1, -1, -1), mat);
    this.quad(p(1, -1, 1), p(-1, -1, 1), p(-1, 1, 1), p(1, 1, 1), mat);
    this.quad(p(-1, -1, -1), p(1, -1, -1), p(1, 1, -1), p(-1, 1, -1), mat);
  }

  /** Vertical prism (n-gon) from y0 to y1 at (x, z). */
  column(x: number, z: number, y0: number, y1: number, radius: number, sides: number, mat: number): void {
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2;
      const a1 = ((i + 1) / sides) * Math.PI * 2;
      const x0 = x + Math.cos(a0) * radius;
      const z0 = z + Math.sin(a0) * radius;
      const x1 = x + Math.cos(a1) * radius;
      const z1 = z + Math.sin(a1) * radius;
      this.quad([x1, y0, z1], [x0, y0, z0], [x0, y1, z0], [x1, y1, z1], mat);
    }
  }

  /**
   * Extrudes a 2D profile (across, up; listed so that walking it keeps the
   * outside on the right... i.e. counter-clockwise in (across, up)) along a
   * path of frames (centre xyz + right unit vector); each profile edge gets
   * its own flat-ish strip.
   */
  extrude(profile: [number, number][], path: { x: number; y: number; z: number; rx: number; rz: number }[], mat: number, closed = false): void {
    const m = profile.length;
    const edges = closed ? m : m - 1;
    for (let e = 0; e < edges; e++) {
      const a = profile[e];
      const b = profile[(e + 1) % m];
      for (let k = 0; k + 1 < path.length; k++) {
        const P = path[k];
        const Q = path[k + 1];
        const at = (fr: typeof P, pr: [number, number]): V3 => [fr.x + fr.rx * pr[0], fr.y + pr[1], fr.z + fr.rz * pr[0]];
        this.quad(at(P, b), at(P, a), at(Q, a), at(Q, b), mat);
      }
    }
  }

  data(): PartData {
    return {
      pos: new Float32Array(this.pos),
      normal: new Float32Array(this.nor),
      road: new Float32Array(this.road),
      index: new Uint32Array(this.idx),
    };
  }
}

export interface BridgeFrame {
  x: number;
  y: number;
  z: number;
  /** Unit right vector (xz). */
  rx: number;
  rz: number;
  s: number;
}

/** Deck frames (centre at the deck surface incl. paved lift) along the span of a bridged piece. */
export function bridgeFrames(p: RoadPiece, heightAt: (x: number, z: number) => number, cfg: RoadsConfig = CONFIG.world.towns.roads): BridgeFrame[] {
  const sp = p.bridge!;
  const hA = heightAt(sp.ax, sp.az);
  const hB = heightAt(sp.bx, sp.bz);
  const lift = pavedLift(p.kind, cfg);
  const out: BridgeFrame[] = [];
  for (let i = 0; i < p.n; i++) {
    const s = p.ss[i];
    if (s < sp.s0 - 0.07 || s > sp.s1 + 0.07) continue;
    out.push({ x: p.xs[i], y: deckHeight(sp, hA, hB, s, cfg) + lift, z: p.zs[i], rx: p.nx[i], rz: p.nz[i], s });
  }
  return out;
}

export interface BridgeParts {
  piers: { x: number; z: number; top: number; bottom: number }[];
  deckBottom: number;
}

/**
 * A road bridge over the span of `p` (p.bridge): `detail` = near LOD (railings,
 * girders, wing walls); far LOD keeps the slab, parapets and piers.
 */
export function buildBridge(pb: PartBuilder, p: RoadPiece, heightAt: (x: number, z: number) => number, detail: boolean, cfg: RoadsConfig = CONFIG.world.towns.roads): BridgeParts {
  const sp = p.bridge!;
  const fr = bridgeFrames(p, heightAt, cfg);
  const hw = p.width / 2;
  const slab = 0.9;
  const edge = hw + 0.55;
  if (fr.length < 2) return { piers: [], deckBottom: 0 };
  // parapets (concrete barrier, safety-shape) + fascia + underside
  const parapet = (side: 1 | -1): [number, number][] => {
    const s = side;
    const pts: [number, number][] = [
      [s * (hw + 0.02), -0.05],
      [s * (hw + 0.08), 0.22],
      [s * (hw + 0.2), 0.82],
      [s * (hw + 0.45), 0.86],
      [s * edge, 0.86],
      [s * edge, -slab],
      [s * (hw - 0.6), -slab],
    ];
    return s > 0 ? pts.slice().reverse() : pts;
  };
  pb.extrude(parapet(1), fr, MAT_CONCRETE);
  pb.extrude(parapet(-1), fr, MAT_CONCRETE);
  // underside across the middle
  pb.extrude(
    [
      [-(hw - 0.6), -slab],
      [hw - 0.6, -slab],
    ],
    fr,
    MAT_CONCRETE,
  );
  // end caps of the parapet/slab at both ends
  for (const [f0, f1] of [
    [fr[0], fr[1]],
    [fr[fr.length - 1], fr[fr.length - 2]],
  ] as const) {
    const fx = f0.x - f1.x;
    const fz = f0.z - f1.z;
    const l = Math.hypot(fx, fz) || 1;
    pb.box([f0.x, f0.y - slab / 2, f0.z], [0, 1, 0], [fx / l, 0, fz / l], edge, slab / 2, 0.05, MAT_CONCRETE, false);
  }
  // girders under the slab
  const deckBottom = Math.min(...fr.map((f) => f.y)) - slab;
  if (detail) {
    const n = Math.max(2, Math.round(p.width / 3.2));
    for (let g = 0; g < n; g++) {
      const a = -hw + 0.8 + ((p.width - 1.6) * g) / (n - 1);
      pb.extrude(
        [
          [a - 0.3, -slab],
          [a - 0.3, -slab - 1.1],
          [a + 0.3, -slab - 1.1],
          [a + 0.3, -slab],
        ],
        fr,
        MAT_CONCRETE,
      );
    }
    // steel rail on posts on top of each parapet
    for (const side of [1, -1] as const) {
      const off = side * (hw + 0.33);
      pb.extrude(
        [
          [off + 0.05, 1.12],
          [off - 0.05, 1.12],
          [off - 0.05, 1.02],
          [off + 0.05, 1.02],
        ].map((q) => [q[0], q[1]] as [number, number]),
        fr,
        MAT_STEEL,
        true,
      );
      for (let k = 0; k < fr.length; k++) {
        const f = fr[k];
        const g = fr[Math.min(fr.length - 1, k + 1)];
        const fx = g.x - f.x;
        const fz = g.z - f.z;
        const l = Math.hypot(fx, fz) || 1;
        pb.box([f.x + f.rx * off, f.y + 0.96, f.z + f.rz * off], [0, 1, 0], [fx / l, 0, fz / l], 0.04, 0.1, 0.04, MAT_STEEL, false);
      }
    }
  }
  // piers
  const L = sp.s1 - sp.s0;
  const nPiers = Math.max(1, Math.floor(L / 34));
  const piers: BridgeParts['piers'] = [];
  const at = (s: number) => {
    let k = 1;
    while (k < fr.length - 1 && fr[k].s < s) k++;
    const a = fr[k - 1];
    const b = fr[k];
    const t = Math.max(0, Math.min(1, (s - a.s) / (b.s - a.s || 1)));
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t, rx: a.rx, rz: a.rz, fx: b.x - a.x, fz: b.z - a.z };
  };
  for (let i = 1; i <= nPiers; i++) {
    const f = at(sp.s0 + (L * i) / (nPiers + 1));
    const fl = Math.hypot(f.fx, f.fz) || 1;
    const capTop = f.y - slab - (detail ? 1.1 : 0);
    const bed = Math.min(heightAt(f.x, f.z), sp.water - 1) - 1.5;
    pb.box([f.x, capTop - 0.6, f.z], [0, 1, 0], [f.fx / fl, 0, f.fz / fl], hw - 0.2, 0.6, 0.75, MAT_CONCRETE);
    const cols = p.width > 10 ? 3 : 2;
    for (let c = 0; c < cols; c++) {
      const a = -(hw - 1.6) + ((2 * (hw - 1.6)) / (cols - 1)) * c;
      pb.column(f.x + f.rx * a, f.z + f.rz * a, bed, capTop - 1.2, 0.65, detail ? 10 : 6, MAT_OLD_CONCRETE);
    }
    piers.push({ x: f.x, z: f.z, top: capTop, bottom: bed });
  }
  // abutments: a wall under each deck end down into the bank, with wing walls
  for (const end of [0, 1] as const) {
    const f0 = end === 0 ? fr[0] : fr[fr.length - 1];
    const f1 = end === 0 ? fr[1] : fr[fr.length - 2];
    const fx = f0.x - f1.x;
    const fz = f0.z - f1.z;
    const l = Math.hypot(fx, fz) || 1;
    const ux = fx / l;
    const uz = fz / l;
    const ground = heightAt(f0.x, f0.z);
    const bottom = Math.min(ground, deckBottom) - 2.5;
    const top = f0.y - slab;
    const cx = f0.x + ux * 0.8;
    const cz = f0.z + uz * 0.8;
    if (top - bottom > 0.3) pb.box([cx, (top + bottom) / 2, cz], [0, 1, 0], [ux, 0, uz], edge + 0.4, (top - bottom) / 2, 0.8, MAT_OLD_CONCRETE, false);
    if (detail) {
      for (const side of [1, -1]) {
        const wx = cx + f0.rx * side * (edge + 0.2) + ux * 3.5;
        const wz = cz + f0.rz * side * (edge + 0.2) + uz * 3.5;
        const g = heightAt(wx, wz);
        const wtop = f0.y + 0.3;
        const wb = Math.min(g, bottom + 1) - 1;
        if (wtop - wb > 0.3) pb.box([wx, (wtop + wb) / 2, wz], [0, 1, 0], [ux, 0, uz], 0.25, (wtop - wb) / 2, 3.5, MAT_OLD_CONCRETE, false);
      }
    }
  }
  return { piers, deckBottom };
}

/**
 * W-beam guard rail along one side of piece `p` over samples [i0, i1] at
 * `offset` m from the centreline: posts every ~1.9 m and a beam at 0.55–0.8 m
 * above `baseY(i, x, z)` (the ground/road at the rail).
 */
export function buildGuardRail(pb: PartBuilder, p: RoadPiece, i0: number, i1: number, side: 1 | -1, offset: number, baseY: (i: number, x: number, z: number) => number): void {
  const path: { x: number; y: number; z: number; rx: number; rz: number }[] = [];
  for (let i = i0; i <= i1; i++) {
    const x = p.xs[i] + p.nx[i] * side * offset;
    const z = p.zs[i] + p.nz[i] * side * offset;
    path.push({ x, y: baseY(i, x, z), z, rx: p.nx[i] * side, rz: p.nz[i] * side });
  }
  if (path.length < 2) return;
  // W-beam facing the road (−right), with a crease; its back face
  pb.extrude(
    [
      [0.0, 0.8],
      [0.08, 0.72],
      [0.04, 0.675],
      [0.08, 0.63],
      [0.0, 0.55],
    ].map((q) => [q[0] - 0.05, q[1]] as [number, number]),
    path,
    MAT_STEEL,
  );
  pb.extrude(
    [
      [0.05, 0.55],
      [0.05, 0.8],
    ],
    path,
    MAT_STEEL,
  );
  // posts behind the beam
  let acc = 0;
  for (let k = 0; k < path.length; k++) {
    if (k > 0) acc += Math.hypot(path[k].x - path[k - 1].x, path[k].z - path[k - 1].z);
    if (k > 0 && acc < 1.9) continue;
    acc = 0;
    const q = path[k];
    const n = path[Math.min(path.length - 1, k + 1)];
    const m = path[Math.max(0, k - 1)];
    const fx = n.x - m.x;
    const fz = n.z - m.z;
    const l = Math.hypot(fx, fz) || 1;
    pb.box([q.x + q.rx * 0.14, q.y + 0.37, q.z + q.rz * 0.14], [0, 1, 0], [fx / l, 0, fz / l], 0.075, 0.4, 0.05, MAT_DARK, false);
  }
}
