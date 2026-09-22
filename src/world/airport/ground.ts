/**
 * Ground-level airport geometry built from the plan: the pavement pieces and
 * fillets (draped on the terrain), the soft grass/dirt shoulders along every
 * outside pavement edge, and the paint quads from markings.ts. Each surface
 * floats a few centimetres above the one below it (AIRPORT_HEIGHTS) so they
 * never z-fight; the materials add a polygon offset on top.
 */
import * as THREE from 'three';
import { MeshBuilder, type V3 } from './builder';
import { pavementAt, toWorld, type AirportPlan, type PaveKind, type RC } from './plan';
import { runwayMarkings, taxiMarkings, type MarkQuad } from './markings';

/**
 * Lift above the terrain, m: shoulders < pavement < markings. Dyadic fractions, so field
 * elevation + lift is exact in float32 (the layers stay exactly parallel).
 */
export const AIRPORT_HEIGHTS = { shoulder: 0.03125, pavement: 0.0625, markings: 0.09375 } as const;

export type HeightFn = (x: number, z: number) => number;

export const PAVE_KIND_ID: Record<PaveKind, number> = { runway: 0, taxiway: 1, apron: 2, carpark: 3 };

/** Colours of the paint (linear, before the shader's wear). */
export const PAINT_RGB = { white: [0.64, 0.64, 0.62] as const, yellow: [0.66, 0.42, 0.045] as const };

const RUNWAY_MARKS = new Set(['threshold', 'designator', 'centerline', 'tdz', 'aiming', 'edge']);

function renameAttr(g: THREE.BufferGeometry, from: string, to: string) {
  const a = g.getAttribute(from);
  g.deleteAttribute(from);
  g.setAttribute(to, a);
}

/** Bilinear point in a quad given in runway coords. */
function bilerp(p: readonly RC[], s: number, t: number): RC {
  const a0 = p[0].a + (p[1].a - p[0].a) * s;
  const c0 = p[0].c + (p[1].c - p[0].c) * s;
  const a1 = p[3].a + (p[2].a - p[3].a) * s;
  const c1 = p[3].c + (p[2].c - p[3].c) * s;
  return { a: a0 + (a1 - a0) * t, c: c0 + (c1 - c0) * t };
}

/** Emit a runway-coords quad subdivided so no piece is longer than `maxLen`, draped on the terrain. */
function drapedQuad(b: MeshBuilder, plan: AirportPlan, p: readonly RC[], lift: number, heightAt: HeightFn, maxLen: number, kindAttr: number) {
  const l01 = Math.hypot(p[1].a - p[0].a, p[1].c - p[0].c);
  const l12 = Math.hypot(p[2].a - p[1].a, p[2].c - p[1].c);
  const ns = Math.max(1, Math.ceil(l01 / maxLen));
  const nt = Math.max(1, Math.ceil(l12 / maxLen));
  b.set({ mat: kindAttr });
  const ids: number[][] = [];
  for (let i = 0; i <= ns; i++) {
    const row: number[] = [];
    for (let j = 0; j <= nt; j++) {
      const q = bilerp(p, i / ns, j / nt);
      const w = toWorld(plan, q.a, q.c);
      row.push(b.v(w.x, heightAt(w.x, w.z) + lift, w.z, 0, 1, 0));
    }
    ids.push(row);
  }
  for (let i = 0; i < ns; i++) for (let j = 0; j < nt; j++) b.quad(ids[i][j], ids[i + 1][j], ids[i + 1][j + 1], ids[i][j + 1]);
}

// ─── pavement ───────────────────────────────────────────────────────────────

export function buildPavement(plan: AirportPlan, heightAt: HeightFn): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const lift = AIRPORT_HEIGHTS.pavement;
  for (const r of plan.pavement) {
    const p: RC[] = [
      { a: r.a0, c: r.c0 },
      { a: r.a1, c: r.c0 },
      { a: r.a1, c: r.c1 },
      { a: r.a0, c: r.c1 },
    ];
    drapedQuad(b, plan, p, lift, heightAt, 24, PAVE_KIND_ID[r.kind]);
  }
  for (const f of plan.fillets) {
    b.set({ mat: PAVE_KIND_ID[f.kind] });
    const w = toWorld(plan, f.corner.a, f.corner.c);
    const c = b.v(w.x, heightAt(w.x, w.z) + lift, w.z, 0, 1, 0);
    const ids = f.arc.map((q) => {
      const p = toWorld(plan, q.a, q.c);
      return b.v(p.x, heightAt(p.x, p.z) + lift, p.z, 0, 1, 0);
    });
    for (let i = 0; i < ids.length - 1; i++) b.tri(c, ids[i], ids[i + 1]);
  }
  const g = b.toGeometry(['mat']);
  renameAttr(g, 'aMat', 'aKind');
  return g;
}

// ─── shoulders ──────────────────────────────────────────────────────────────

/**
 * Strips along every pavement edge that borders grass: aKind = 0 at the pavement edge (tucked
 * 0.4 m under it) → 1 at the outer edge. Convex outer corners get a quarter-disc fan.
 */
export function buildShoulders(plan: AirportPlan, heightAt: HeightFn): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const lift = AIRPORT_HEIGHTS.shoulder;
  const tuck = 0.4;
  const put = (a: number, c: number, t: number) => {
    const w = toWorld(plan, a, c);
    b.set({ mat: t });
    return b.v(w.x, heightAt(w.x, w.z) + lift, w.z, 0, 1, 0);
  };
  const strip = (pa: RC, pb: RC, na: number, nc: number, width: number) => {
    const len = Math.hypot(pb.a - pa.a, pb.c - pa.c);
    const n = Math.max(1, Math.ceil(len / 20));
    let prevIn = -1;
    let prevOut = -1;
    for (let i = 0; i <= n; i++) {
      const a = pa.a + ((pb.a - pa.a) * i) / n;
      const c = pa.c + ((pb.c - pa.c) * i) / n;
      const vin = put(a - na * tuck, c - nc * tuck, 0);
      const vout = put(a + na * width, c + nc * width, 1);
      if (i > 0) b.quad(prevIn, vin, vout, prevOut);
      prevIn = vin;
      prevOut = vout;
    }
  };
  const isPaved = (a: number, c: number) => pavementAt(plan, a, c) !== null;
  const widthOf = (kind: PaveKind) => (kind === 'runway' ? 3.5 : kind === 'carpark' ? 1.5 : 2.8);

  for (const r of plan.pavement) {
    const W = widthOf(r.kind);
    const edges: { p0: RC; p1: RC; na: number; nc: number }[] = [
      { p0: { a: r.a0, c: r.c0 }, p1: { a: r.a1, c: r.c0 }, na: 0, nc: -1 },
      { p0: { a: r.a1, c: r.c0 }, p1: { a: r.a1, c: r.c1 }, na: 1, nc: 0 },
      { p0: { a: r.a1, c: r.c1 }, p1: { a: r.a0, c: r.c1 }, na: 0, nc: 1 },
      { p0: { a: r.a0, c: r.c1 }, p1: { a: r.a0, c: r.c0 }, na: -1, nc: 0 },
    ];
    for (const e of edges) {
      const len = Math.hypot(e.p1.a - e.p0.a, e.p1.c - e.p0.c);
      const da = (e.p1.a - e.p0.a) / len;
      const dc = (e.p1.c - e.p0.c) / len;
      const step = 0.5;
      let start = -1;
      const flush = (s0: number, s1: number) => {
        if (s1 - s0 < 0.4) return;
        strip({ a: e.p0.a + da * s0, c: e.p0.c + dc * s0 }, { a: e.p0.a + da * s1, c: e.p0.c + dc * s1 }, e.na, e.nc, W);
      };
      for (let s = 0; s <= len + 1e-6; s += step) {
        const ss = Math.min(s, len);
        const out = !isPaved(e.p0.a + da * ss + e.na * 0.6, e.p0.c + dc * ss + e.nc * 0.6);
        if (out && start < 0) start = ss;
        if (!out && start >= 0) {
          flush(start, Math.max(start, ss - step));
          start = -1;
        }
      }
      if (start >= 0) flush(start, len);
    }
    // convex corners: quarter-disc fans where both neighbouring edges border grass
    const corners: { a: number; c: number; sa: number; sc: number }[] = [
      { a: r.a0, c: r.c0, sa: -1, sc: -1 },
      { a: r.a1, c: r.c0, sa: 1, sc: -1 },
      { a: r.a1, c: r.c1, sa: 1, sc: 1 },
      { a: r.a0, c: r.c1, sa: -1, sc: 1 },
    ];
    for (const k of corners) {
      if (isPaved(k.a + k.sa * 0.6, k.c) || isPaved(k.a, k.c + k.sc * 0.6) || isPaved(k.a + k.sa * 0.6, k.c + k.sc * 0.6)) continue;
      const centre = put(k.a - k.sa * tuck, k.c - k.sc * tuck, 0);
      const ring: number[] = [];
      for (let i = 0; i <= 6; i++) {
        const t = (i / 6) * (Math.PI / 2);
        ring.push(put(k.a + k.sa * W * Math.cos(t), k.c + k.sc * W * Math.sin(t), 1));
      }
      for (let i = 0; i < 6; i++) b.tri(centre, ring[i], ring[i + 1]);
    }
  }
  // fillet arcs: the grass lies toward the arc centre
  for (const f of plan.fillets) {
    const first = f.arc[0];
    const last = f.arc[f.arc.length - 1];
    const ca = first.a + last.a - f.corner.a;
    const cc = first.c + last.c - f.corner.c;
    const W = 2.8;
    let prevIn = -1;
    let prevOut = -1;
    f.arc.forEach((q, i) => {
      const d = Math.hypot(ca - q.a, cc - q.c) || 1;
      const na = (ca - q.a) / d;
      const nc = (cc - q.c) / d;
      const vin = put(q.a - na * tuck, q.c - nc * tuck, 0);
      const vout = put(q.a + na * W, q.c + nc * W, 1);
      if (i > 0) b.quad(prevIn, vin, vout, prevOut);
      prevIn = vin;
      prevOut = vout;
    });
  }
  const g = b.toGeometry(['mat']);
  renameAttr(g, 'aMat', 'aKind');
  return g;
}

// ─── markings ───────────────────────────────────────────────────────────────

export function allMarkings(plan: AirportPlan): MarkQuad[] {
  return [...runwayMarkings(plan.rw), ...taxiMarkings(plan)];
}

export function buildMarkings(plan: AirportPlan, heightAt: HeightFn, quads: MarkQuad[] = allMarkings(plan)): THREE.BufferGeometry {
  const b = new MeshBuilder();
  for (const q of quads) {
    const rgb = PAINT_RGB[q.color];
    const base = b.vertexCount;
    drapedQuad(b, plan, q.p, AIRPORT_HEIGHTS.markings, heightAt, 30, RUNWAY_MARKS.has(q.kind) ? 0 : 1);
    for (let i = base; i < b.vertexCount; i++) {
      b.col[i * 3] = rgb[0];
      b.col[i * 3 + 1] = rgb[1];
      b.col[i * 3 + 2] = rgb[2];
    }
  }
  const g = b.toGeometry(['color', 'mat']);
  renameAttr(g, 'aMat', 'aKind');
  return g;
}

export type { V3 };
