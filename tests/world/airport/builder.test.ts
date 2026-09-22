import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { MeshBuilder } from '../../../src/world/airport/builder';

/** Every triangle's geometric normal points away from `centre` (closed convex solids). */
function outwardFraction(b: MeshBuilder, centre: [number, number, number]): number {
  let ok = 0;
  const P = b.pos;
  for (let t = 0; t < b.idx.length; t += 3) {
    const [a, c, d] = [b.idx[t], b.idx[t + 1], b.idx[t + 2]];
    const A = new THREE.Vector3(P[a * 3], P[a * 3 + 1], P[a * 3 + 2]);
    const B = new THREE.Vector3(P[c * 3], P[c * 3 + 1], P[c * 3 + 2]);
    const C = new THREE.Vector3(P[d * 3], P[d * 3 + 1], P[d * 3 + 2]);
    const n = B.clone().sub(A).cross(C.clone().sub(A));
    const m = A.add(B).add(C).divideScalar(3).sub(new THREE.Vector3(...centre));
    if (n.dot(m) > 0) ok++;
  }
  return ok / (b.idx.length / 3);
}

describe('MeshBuilder', () => {
  it('box: 12 outward triangles, 24 vertices, wall UVs in metres with v = height', () => {
    const b = new MeshBuilder().box(0, 0, 0, 4, 3, 2);
    expect(b.triangleCount).toBe(12);
    expect(b.vertexCount).toBe(24);
    expect(outwardFraction(b, [2, 1.5, 1])).toBe(1);
    const vs = b.uv.filter((_, i) => i % 2 === 1);
    expect(Math.max(...vs)).toBeCloseTo(3, 6);
    const g = b.toGeometry(['color', 'mat', 'uv']);
    expect(g.attributes.position.count).toBe(24);
    expect(g.attributes.aUvM.itemSize).toBe(2);
    expect(g.index!.count).toBe(36);
  });

  it('skip removes faces', () => {
    expect(new MeshBuilder().box(0, 0, 0, 1, 1, 1, 'tb').triangleCount).toBe(8);
  });

  it('transform stack: pushTR moves and rotates, pop restores', () => {
    const b = new MeshBuilder();
    b.pushTR(10, 0, 5, Math.PI / 2);
    b.v(1, 0, 0, 1, 0, 0);
    b.pop();
    b.v(1, 0, 0, 1, 0, 0);
    // rotation about +Y by 90°: +X → −Z
    expect(b.pos[0]).toBeCloseTo(10, 6);
    expect(b.pos[2]).toBeCloseTo(4, 6);
    expect(b.nrm[2]).toBeCloseTo(-1, 6);
    expect(b.pos[3]).toBeCloseTo(1, 6);
    expect(() => b.pop()).toThrow();
  });

  it('cylinder with caps is closed and outward', () => {
    const b = new MeshBuilder().cylinder(0, 0, 0, 1, 2, 16, true);
    expect(outwardFraction(b, [0, 1, 0])).toBe(1);
  });

  it('brush attributes are recorded per vertex (colour converted to linear)', () => {
    const b = new MeshBuilder().set({ color: 0xff0000, mat: 7, accent: 1, rough: 0.3, metal: 0.8, part: 2 });
    b.v(0, 0, 0, 0, 1, 0);
    expect(b.col[0]).toBeCloseTo(1, 6);
    expect(b.col[1]).toBe(0);
    expect(b.mat[0]).toBe(7);
    expect(b.acc[0]).toBe(1);
    expect(b.rm).toEqual([0.3, 0.8]);
    expect(b.part[0]).toBe(2);
    const g = b.toGeometry(['accent', 'rm', 'part']);
    expect(g.attributes.aAccent.count).toBe(1);
    expect(g.attributes.aRM.itemSize).toBe(2);
    expect(g.attributes.color).toBeUndefined();
  });

  it('prismZ of a convex profile is closed and outward (both windings)', () => {
    const prof: [number, number][] = [
      [-2, 0],
      [2, 0],
      [2, 2],
      [0, 3],
      [-2, 2],
    ];
    for (const p of [prof, [...prof].reverse()]) {
      const b = new MeshBuilder().prismZ(p, -1, 1);
      expect(outwardFraction(b, [0, 1.4, 0])).toBe(1);
    }
  });

  it('loft of circles makes an outward tube', () => {
    const rings = [0, 1, 2, 3].map((z) => Array.from({ length: 12 }, (_, k) => [Math.cos((k / 12) * 6.283), Math.sin((k / 12) * 6.283), z] as const));
    const b = new MeshBuilder().loft(rings);
    // outward relative to the axis: check against each triangle's own ring centre (on the z axis)
    let ok = 0;
    for (let t = 0; t < b.idx.length; t += 3) {
      const ids = [b.idx[t], b.idx[t + 1], b.idx[t + 2]];
      const P = ids.map((i) => new THREE.Vector3(b.pos[i * 3], b.pos[i * 3 + 1], b.pos[i * 3 + 2]));
      const n = P[1].clone().sub(P[0]).cross(P[2].clone().sub(P[0]));
      const m = P[0].clone().add(P[1]).add(P[2]).divideScalar(3);
      if (n.dot(new THREE.Vector3(m.x, m.y, 0)) > 0) ok++;
    }
    expect(ok).toBe(b.triangleCount);
  });

  it('fuzz: boxes and tubes anywhere, any rotation, stay outward and finite', () => {
    fc.assert(
      fc.property(
        fc.record({
          x: fc.double({ min: -500, max: 500, noNaN: true }),
          y: fc.double({ min: -5, max: 50, noNaN: true }),
          z: fc.double({ min: -500, max: 500, noNaN: true }),
          rot: fc.double({ min: -7, max: 7, noNaN: true }),
          sx: fc.double({ min: 0.05, max: 40, noNaN: true }),
          sy: fc.double({ min: 0.05, max: 40, noNaN: true }),
          sz: fc.double({ min: 0.05, max: 40, noNaN: true }),
        }),
        (o) => {
          const b = new MeshBuilder().pushTR(o.x, o.y, o.z, o.rot).boxC(0, 0, 0, o.sx, o.sy, o.sz);
          b.tube([0, 0, 0], [o.sx, o.sy, o.sz], 0.1, 0.05, 6, true);
          b.pop();
          expect(b.pos.every(Number.isFinite)).toBe(true);
          expect(b.nrm.every(Number.isFinite)).toBe(true);
          const box = new MeshBuilder().pushTR(o.x, o.y, o.z, o.rot).boxC(0, 0, 0, o.sx, o.sy, o.sz);
          expect(outwardFraction(box, [o.x, o.y, o.z])).toBe(1);
        },
      ),
      { numRuns: 200 },
    );
  });
});
