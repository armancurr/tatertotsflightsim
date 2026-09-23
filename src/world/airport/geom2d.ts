/**
 * Convex-polygon helpers in 2D (runway coordinates a, c — or any plane): half-plane clipping,
 * convex difference (the pieces of a convex polygon outside another convex polygon, disjoint),
 * point-in-polygon, area. Used to cut the crossing runway, taxiways and paint where pavements
 * cross, so no two coplanar surfaces ever overlap. PURE.
 */

export interface P2 {
  a: number;
  c: number;
}

/** Signed area (positive = counter-clockwise in (a, c)). */
export function polyArea(p: readonly P2[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[i];
    const r = p[(i + 1) % p.length];
    s += q.a * r.c - r.a * q.c;
  }
  return s / 2;
}

/** Counter-clockwise copy. */
export function ccw(p: readonly P2[]): P2[] {
  return polyArea(p) < 0 ? [...p].reverse() : [...p];
}

/** Keep the part of polygon `p` where na·a + nc·c ≤ d (Sutherland–Hodgman, one plane). */
export function clipHalfPlane(p: readonly P2[], na: number, nc: number, d: number): P2[] {
  const out: P2[] = [];
  const n = p.length;
  for (let i = 0; i < n; i++) {
    const A = p[i];
    const B = p[(i + 1) % n];
    const fa = na * A.a + nc * A.c - d;
    const fb = na * B.a + nc * B.c - d;
    if (fa <= 0) out.push(A);
    if ((fa < 0 && fb > 0) || (fa > 0 && fb < 0)) {
      const t = fa / (fa - fb);
      out.push({ a: A.a + (B.a - A.a) * t, c: A.c + (B.c - A.c) * t });
    }
  }
  return dedupe(out);
}

function dedupe(p: P2[]): P2[] {
  const out: P2[] = [];
  for (const q of p) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last.a - q.a) > 1e-9 || Math.abs(last.c - q.c) > 1e-9) out.push(q);
  }
  if (out.length > 1) {
    const f = out[0];
    const l = out[out.length - 1];
    if (Math.abs(f.a - l.a) <= 1e-9 && Math.abs(f.c - l.c) <= 1e-9) out.pop();
  }
  return out;
}

/** Outward half-planes (na, nc, d with inside = na·a + nc·c ≤ d) of a convex polygon. */
function planes(p: readonly P2[]): { na: number; nc: number; d: number }[] {
  const q = ccw(p);
  const out: { na: number; nc: number; d: number }[] = [];
  for (let i = 0; i < q.length; i++) {
    const A = q[i];
    const B = q[(i + 1) % q.length];
    // CCW in (a, c): outward normal of edge A→B is (dc, −da)
    let na = B.c - A.c;
    let nc = -(B.a - A.a);
    const l = Math.hypot(na, nc);
    if (l < 1e-12) continue;
    na /= l;
    nc /= l;
    out.push({ na, nc, d: na * A.a + nc * A.c });
  }
  return out;
}

/** Tiny slivers (area below this, m²) are dropped from differences. */
const MIN_AREA = 1e-4;

/**
 * The part of convex `subject` outside convex `hole`, as disjoint convex pieces (at most one per
 * edge of `hole`). Returns [subject] when they don't overlap.
 */
export function convexDifference(subject: readonly P2[], hole: readonly P2[]): P2[][] {
  const pl = planes(hole);
  const pieces: P2[][] = [];
  let rest: P2[] = [...subject];
  for (const h of pl) {
    if (rest.length < 3) break;
    // outside this edge (na·p > d) → a piece; continue with the inside part
    const out = clipHalfPlane(rest, -h.na, -h.nc, -h.d);
    if (out.length >= 3 && Math.abs(polyArea(out)) > MIN_AREA) pieces.push(out);
    rest = clipHalfPlane(rest, h.na, h.nc, h.d);
  }
  return pieces;
}

/** Subtract several convex holes in turn. */
export function subtractAll(subject: readonly P2[], holes: readonly (readonly P2[])[]): P2[][] {
  let parts: P2[][] = [[...subject]];
  for (const h of holes) {
    const next: P2[][] = [];
    for (const p of parts) if (overlaps(p, h)) next.push(...convexDifference(p, h));
    else next.push(p);
    parts = next;
  }
  return parts;
}

/** Intersection of two convex polygons. */
export function intersectConvex(p: readonly P2[], q: readonly P2[]): P2[] {
  let r: P2[] = [...p];
  for (const h of planes(q)) {
    r = clipHalfPlane(r, h.na, h.nc, h.d);
    if (r.length < 3) return [];
  }
  return r;
}

/** Axis-aligned bounding boxes overlap (cheap pre-test). */
export function overlaps(p: readonly P2[], q: readonly P2[]): boolean {
  const b = bounds(p);
  const d = bounds(q);
  return b.a0 < d.a1 && d.a0 < b.a1 && b.c0 < d.c1 && d.c0 < b.c1;
}

export function bounds(p: readonly P2[]): { a0: number; a1: number; c0: number; c1: number } {
  let a0 = Infinity, a1 = -Infinity, c0 = Infinity, c1 = -Infinity;
  for (const q of p) {
    if (q.a < a0) a0 = q.a;
    if (q.a > a1) a1 = q.a;
    if (q.c < c0) c0 = q.c;
    if (q.c > c1) c1 = q.c;
  }
  return { a0, a1, c0, c1 };
}

/** Point inside a convex polygon (either winding), with a tolerance (m, > 0 grows it). */
export function pointInConvex(p: readonly P2[], a: number, c: number, eps = 0): boolean {
  let sign = 0;
  const n = p.length;
  for (let i = 0; i < n; i++) {
    const A = p[i];
    const B = p[(i + 1) % n];
    const ea = B.a - A.a;
    const ec = B.c - A.c;
    const l = Math.hypot(ea, ec);
    if (l < 1e-12) continue;
    const cr = (ea * (c - A.c) - ec * (a - A.a)) / l; // signed distance, + = left of A→B
    if (sign === 0) sign = polyArea(p) >= 0 ? 1 : -1;
    if (cr * sign < -eps) return false;
  }
  return true;
}

export function rectPoly(a0: number, a1: number, c0: number, c1: number): P2[] {
  return [
    { a: a0, c: c0 },
    { a: a1, c: c0 },
    { a: a1, c: c1 },
    { a: a0, c: c1 },
  ];
}
