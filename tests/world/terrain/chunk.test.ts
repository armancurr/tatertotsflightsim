import { describe, it, expect } from 'vitest';
import { buildChunk, createChunkIndex, chunkVertexCount } from '../../../src/world/terrain/chunk';
import { getHeightfield } from '../../../src/world/heightfield';
import { getLandcover } from '../../../src/world/landcover';

const hf = getHeightfield();
const lc = getLandcover();

describe('terrain chunk builder', () => {
  const res = 16;
  const req = { x0: 3000, z0: -9000, size: 1024, res };
  const c = buildChunk(hf, lc, req);
  const nv = chunkVertexCount(res);
  const step = req.size / res;
  const cx = req.x0 + req.size / 2;
  const cz = req.z0 + req.size / 2;

  it('produces arrays of the right sizes', () => {
    expect(nv).toBe((res + 1) * (res + 1) + 4 * (res + 1));
    expect(c.positions.length).toBe(nv * 3);
    expect(c.normals.length).toBe(nv * 3);
    expect(c.lc0.length).toBe(nv * 4);
    expect(c.lc1.length).toBe(nv * 4);
    expect(c.morph.length).toBe(nv * 3);
  });

  it('places grid vertices on the heightfield, relative to the tile centre', () => {
    for (let j = 0; j <= res; j++)
      for (let i = 0; i <= res; i++) {
        const v = j * (res + 1) + i;
        const x = c.positions[v * 3] + cx;
        const z = c.positions[v * 3 + 2] + cz;
        expect(x).toBeCloseTo(req.x0 + i * step, 3);
        expect(z).toBeCloseTo(req.z0 + j * step, 3);
        expect(c.positions[v * 3 + 1]).toBeCloseTo(hf.height(x, z), 2);
      }
    expect(c.minY).toBeLessThanOrEqual(c.maxY);
    expect(c.center).toEqual({ x: cx, z: cz });
  });

  it('hangs skirts below every edge vertex', () => {
    const grid = (res + 1) * (res + 1);
    for (let k = 0; k < 4 * (res + 1); k++) {
      const s = grid + k;
      expect(c.positions[s * 3 + 1]).toBeLessThan(c.maxY);
      // same x/z as some edge vertex
      const x = c.positions[s * 3];
      const z = c.positions[s * 3 + 2];
      const onEdge = Math.abs(Math.abs(x) - req.size / 2) < 1e-3 || Math.abs(Math.abs(z) - req.size / 2) < 1e-3;
      expect(onEdge).toBe(true);
    }
    expect(c.minY).toBeLessThan(Math.min(...Array.from({ length: grid }, (_, v) => c.positions[v * 3 + 1])));
  });

  it('stores unit normals, landcover weights summing to ~1 and morph targets on the coarse grid', () => {
    for (let v = 0; v < nv; v++) {
      const nx = c.normals[v * 3] / 32767;
      const ny = c.normals[v * 3 + 1] / 32767;
      const nz = c.normals[v * 3 + 2] / 32767;
      expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 2);
      expect(ny).toBeGreaterThan(0);
      let s = 0;
      for (let k = 0; k < 4; k++) s += c.lc0[v * 4 + k] + c.lc1[v * 4 + k];
      expect(Math.abs(s - 255)).toBeLessThanOrEqual(6);
      expect(c.morph[v * 3 + 2]).toBe(req.size);
    }
    const H = (i: number, j: number) => c.positions[(j * (res + 1) + i) * 3 + 1];
    const M = (i: number, j: number) => c.morph[(j * (res + 1) + i) * 3];
    for (let j = 0; j <= res; j++)
      for (let i = 0; i <= res; i++) {
        const oi = i % 2 === 1;
        const oj = j % 2 === 1;
        let coarse = H(i, j);
        if (oi && !oj) coarse = (H(i - 1, j) + H(i + 1, j)) / 2;
        if (!oi && oj) coarse = (H(i, j - 1) + H(i, j + 1)) / 2;
        if (oi && oj) coarse = (H(i + 1, j - 1) + H(i - 1, j + 1)) / 2;
        expect(H(i, j) + M(i, j)).toBeCloseTo(coarse, 3);
      }
  });

  it('builds a shared index buffer whose triangles face up (grid) and outward (skirts)', () => {
    const idx = createChunkIndex(res);
    expect(idx.length).toBe((res * res * 2 + 4 * res * 2) * 3);
    for (let t = 0; t < idx.length; t += 3) {
      const [a, b, d] = [idx[t], idx[t + 1], idx[t + 2]];
      for (const v of [a, b, d]) expect(v).toBeLessThan(nv);
      const p = (v: number) => [c.positions[v * 3], c.positions[v * 3 + 1], c.positions[v * 3 + 2]];
      const [A, B, D] = [p(a), p(b), p(d)];
      const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
      const w = [D[0] - A[0], D[1] - A[1], D[2] - A[2]];
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      const ctr = [(A[0] + B[0] + D[0]) / 3, (A[2] + B[2] + D[2]) / 3];
      if (t < res * res * 6) expect(n[1]).toBeGreaterThan(0);
      else expect(n[0] * ctr[0] + n[2] * ctr[1]).toBeGreaterThan(0); // skirt faces away from the tile centre
    }
  });

  it('is deterministic', () => {
    const d = buildChunk(hf, lc, req);
    expect(Array.from(d.positions)).toEqual(Array.from(c.positions));
    expect(Array.from(d.lc0)).toEqual(Array.from(c.lc0));
  });
});
