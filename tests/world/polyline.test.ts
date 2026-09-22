import { describe, it, expect } from 'vitest';
import { PolylineIndex, newPolyQuery } from '../../src/world/polyline';
import { mulberry32 } from '../../src/world/noise';

function bruteDistance(lines: { x: number; z: number }[][], x: number, z: number): number {
  let best = Infinity;
  for (const pts of lines)
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const vx = b.x - a.x;
      const vz = b.z - a.z;
      const t = Math.max(0, Math.min(1, ((x - a.x) * vx + (z - a.z) * vz) / (vx * vx + vz * vz)));
      best = Math.min(best, Math.hypot(x - a.x - vx * t, z - a.z - vz * t));
    }
  return best;
}

describe('polyline index', () => {
  const rnd = mulberry32(7);
  const lines: { x: number; z: number }[][] = [];
  const values: number[][][] = [];
  for (let l = 0; l < 3; l++) {
    const pts = [];
    const vals = [];
    let x = rnd() * 4000 - 2000;
    let z = rnd() * 4000 - 2000;
    for (let i = 0; i < 80; i++) {
      pts.push({ x, z });
      vals.push([100 - i, l]);
      x += rnd() * 60 - 20;
      z += rnd() * 60 - 30;
    }
    lines.push(pts);
    values.push(vals);
  }
  const idx = new PolylineIndex(lines, values, 2, 300, 128);
  const q = newPolyQuery(2);

  it('finds the exact nearest distance within the radius', () => {
    for (let i = 0; i < 3000; i++) {
      const x = rnd() * 6000 - 3000;
      const z = rnd() * 6000 - 3000;
      const d = bruteDistance(lines, x, z);
      const found = idx.query(x, z, q);
      if (d < 300) {
        expect(found).toBe(true);
        expect(q.d).toBeCloseTo(d, 6);
      } else {
        expect(found).toBe(false);
      }
    }
  });

  it('interpolates per-vertex values along segments', () => {
    const p = lines[0][10];
    const n = lines[0][11];
    idx.query((p.x + n.x) / 2, (p.z + n.z) / 2, q);
    expect(q.d).toBeLessThan(1e-6);
    expect(q.v[0]).toBeGreaterThan(88.5);
    expect(q.v[0]).toBeLessThan(90.5);
  });

  it('soft-weighted values are continuous in space', () => {
    let prev = NaN;
    for (let x = -3000; x <= 3000; x += 0.5) {
      if (!idx.query(x, 100, q)) {
        prev = NaN;
        continue;
      }
      if (!Number.isNaN(prev)) expect(Math.abs(q.v[0] - prev)).toBeLessThan(1);
      prev = q.v[0];
    }
  });
});
