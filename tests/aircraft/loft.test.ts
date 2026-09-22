import { describe, it, expect } from 'vitest';
import { loftGeometry } from '../../src/aircraft/loft';
import { nacaRing, nacaThickness } from '../../src/aircraft/airfoil';
import { superSectionPoint } from '../../src/aircraft/shape';

/** A ring of n points on a circle of radius r around the z axis at station z (CCW seen from +z unless cw). */
function circle(n: number, r: number, z: number, cw = false): number[] {
  const out: number[] = [];
  for (let j = 0; j < n; j++) {
    const a = ((cw ? -1 : 1) * 2 * Math.PI * j) / n;
    out.push(r * Math.cos(a), r * Math.sin(a), z);
  }
  return out;
}

function vec(arr: ArrayLike<number>, i: number): [number, number, number] {
  return [arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]];
}

describe('loftGeometry', () => {
  const M = 5;
  const N = 8;
  const rings = Array.from({ length: M }, (_, i) => circle(N, 1, i * 0.5));

  it('builds M×(N+1) vertices (seam duplicated) and (M−1)·N quads', () => {
    const g = loftGeometry(rings);
    expect(g.getAttribute('position').count).toBe(M * (N + 1));
    expect(g.getAttribute('normal').count).toBe(M * (N + 1));
    expect(g.getAttribute('uv').count).toBe(M * (N + 1));
    expect(g.getIndex()!.count).toBe((M - 1) * N * 6);
  });

  it('closes every ring: the seam vertex sits on the first vertex', () => {
    const g = loftGeometry(rings);
    const p = g.getAttribute('position').array;
    for (let i = 0; i < M; i++) {
      const a = vec(p, i * (N + 1));
      const b = vec(p, i * (N + 1) + N);
      expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeLessThan(1e-6);
    }
    const uv = g.getAttribute('uv').array;
    expect(uv[0]).toBeCloseTo(0);
    expect(uv[N * 2]).toBeCloseTo(1);
  });

  it('produces unit-length normals pointing outward, whichever way the rings wind', () => {
    for (const cw of [false, true]) {
      const g = loftGeometry(Array.from({ length: M }, (_, i) => circle(N, 1, i * 0.5, cw)));
      const p = g.getAttribute('position').array;
      const n = g.getAttribute('normal').array;
      for (let k = 0; k < g.getAttribute('position').count; k++) {
        const [nx, ny, nz] = vec(n, k);
        expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 5);
        const [px, py] = vec(p, k);
        expect(nx * px + ny * py).toBeGreaterThan(0.9);
      }
    }
  });

  it('winds triangles so the face normal agrees with the vertex normals (front faces outside)', () => {
    for (const cw of [false, true]) {
      const g = loftGeometry(Array.from({ length: M }, (_, i) => circle(N, 1, i * 0.5, cw)));
      const p = g.getAttribute('position').array;
      const n = g.getAttribute('normal').array;
      const idx = g.getIndex()!.array;
      for (let t = 0; t < idx.length; t += 3) {
        const a = vec(p, idx[t]);
        const b = vec(p, idx[t + 1]);
        const c = vec(p, idx[t + 2]);
        const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const fn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const vn = vec(n, idx[t]);
        expect(fn[0] * vn[0] + fn[1] * vn[1] + fn[2] * vn[2]).toBeGreaterThan(0);
      }
    }
  });

  it('adds flat end caps facing away from the body', () => {
    const g = loftGeometry(rings, { capStart: true, capEnd: true });
    expect(g.getAttribute('position').count).toBe(M * (N + 1) + 2 * (N + 1));
    expect(g.getIndex()!.count).toBe((M - 1) * N * 6 + 2 * N * 3);
    const n = g.getAttribute('normal').array;
    const startCapFirst = M * (N + 1);
    const endCapFirst = startCapFirst + N + 1;
    expect(vec(n, startCapFirst)[2]).toBeCloseTo(-1, 5);
    expect(vec(n, endCapFirst)[2]).toBeCloseTo(1, 5);
  });

  it('makes a hard edge where a ring repeats a point (crease)', () => {
    // A unit square with each corner repeated: the corner normals must be face normals, not averaged.
    const sq = (z: number) => [1, -1, z, 1, 1, z, 1, 1, z, -1, 1, z, -1, 1, z, -1, -1, z, -1, -1, z, 1, -1, z];
    const g = loftGeometry([sq(0), sq(1), sq(2)]);
    const n = g.getAttribute('normal').array;
    const cnt = g.getAttribute('position').count;
    for (let k = 0; k < cnt; k++) {
      const [nx, ny, nz] = vec(n, k);
      // Every normal is axis-aligned (±x or ±y), never the 45° average of two faces.
      expect(Math.max(Math.abs(nx), Math.abs(ny))).toBeCloseTo(1, 5);
      expect(nz).toBeCloseTo(0, 5);
    }
  });

  it('supports open strips (closed: false) without a seam wrap', () => {
    const arc = (z: number) => {
      const out: number[] = [];
      for (let j = 0; j <= 6; j++) {
        const a = (Math.PI * j) / 6;
        out.push(Math.cos(a), Math.sin(a), z);
      }
      return out;
    };
    const g = loftGeometry([arc(0), arc(1), arc(2)], { closed: false });
    expect(g.getAttribute('position').count).toBe(3 * 7);
    expect(g.getIndex()!.count).toBe(2 * 6 * 6);
    const p = g.getAttribute('position').array;
    const n = g.getAttribute('normal').array;
    for (let k = 0; k < 21; k++) {
      const [px, py] = vec(p, k);
      const [nx, ny] = vec(n, k);
      expect(nx * px + ny * py).toBeGreaterThan(0.8);
    }
  });

  it('accepts explicit u/v coordinates', () => {
    const v = [0.1, 0.2, 0.3, 0.4, 0.5];
    const g = loftGeometry(rings, { v });
    const uv = g.getAttribute('uv').array;
    expect(uv[1]).toBeCloseTo(0.1);
    expect(uv[(4 * (N + 1)) * 2 + 1]).toBeCloseTo(0.5);
  });
});

describe('airfoil', () => {
  it('NACA 2412 has 12% max thickness near 30% chord', () => {
    let best = 0;
    let at = 0;
    for (let x = 0; x <= 1; x += 0.01) {
      const t = nacaThickness(0.12, x) * 2;
      if (t > best) {
        best = t;
        at = x;
      }
    }
    expect(best).toBeCloseTo(0.12, 2);
    expect(at).toBeGreaterThan(0.25);
    expect(at).toBeLessThan(0.35);
  });

  it('nacaRing returns a closed loop: upper surface LE→TE then lower TE→LE, cambered upward', () => {
    const ring = nacaRing({ m: 0.02, p: 0.4, t: 0.12, n: 20 });
    // n upper points (LE..TE), then the TE repeated (sharp trailing edge) and n−2 lower points back toward the LE
    expect(ring.length).toBe((2 * 20 - 1) * 2);
    // first point is the leading edge, point n is the trailing edge
    expect(ring[0]).toBeCloseTo(0, 5);
    expect(ring[20 * 2]).toBeCloseTo(1, 2);
    // upper surface above lower surface at mid chord
    let upper = -1;
    let lower = 1;
    for (let k = 0; k < ring.length / 2; k++) {
      const x = ring[k * 2];
      const y = ring[k * 2 + 1];
      if (Math.abs(x - 0.3) < 0.04) {
        if (k < 20) upper = Math.max(upper, y);
        else lower = Math.min(lower, y);
      }
    }
    expect(upper).toBeGreaterThan(0.06);
    expect(lower).toBeLessThan(0);
    expect(upper - lower).toBeCloseTo(0.12, 1);
  });

  it('can cut the section at a hinge: front part ends flat at the hinge, rear part starts with a rounded nose', () => {
    const front = nacaRing({ m: 0.02, p: 0.4, t: 0.12, n: 16, to: 0.75 });
    const rear = nacaRing({ m: 0.02, p: 0.4, t: 0.12, n: 16, from: 0.75 });
    for (let k = 0; k < front.length / 2; k++) expect(front[k * 2]).toBeLessThanOrEqual(0.75 + 1e-9);
    let minRear = 1;
    for (let k = 0; k < rear.length / 2; k++) minRear = Math.min(minRear, rear[k * 2]);
    expect(minRear).toBeLessThan(0.75);
    expect(minRear).toBeGreaterThan(0.7);
  });
});

describe('fuselage section', () => {
  const s = { top: 1, bottom: -0.5, halfWidth: 0.6, widthY: 0.2, nTop: 3, nBot: 2.5 };
  const out = { x: 0, y: 0 };
  it('t=0 is the top centre, 0.25 the left side (−x), 0.5 the bottom, 0.75 the right side', () => {
    superSectionPoint(s, 0, out);
    expect(out.x).toBeCloseTo(0);
    expect(out.y).toBeCloseTo(1);
    superSectionPoint(s, 0.25, out);
    expect(out.x).toBeCloseTo(-0.6);
    expect(out.y).toBeCloseTo(0.2);
    superSectionPoint(s, 0.5, out);
    expect(out.x).toBeCloseTo(0);
    expect(out.y).toBeCloseTo(-0.5);
    superSectionPoint(s, 0.75, out);
    expect(out.x).toBeCloseTo(0.6);
  });
});
