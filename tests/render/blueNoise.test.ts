/**
 * Blue-noise dither tile (blueNoise.ts): a permutation of ranks, deterministic,
 * and spectrally blue (little low-frequency energy compared with white noise).
 */
import { describe, it, expect } from 'vitest';
import { generateBlueNoise, blueNoiseJob } from '../../src/render/blueNoise';
import { mulberry32 } from '../../src/render/noise';

/** Variance of k×k (toroidal) block means — the low-frequency content of a pattern. */
function blockMeanVariance(v: ArrayLike<number>, n: number, k: number): number {
  const means: number[] = [];
  for (let y = 0; y < n; y += k)
    for (let x = 0; x < n; x += k) {
      let s = 0;
      for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) s += v[((y + j) % n) * n + ((x + i) % n)];
      means.push(s / (k * k));
    }
  const m = means.reduce((a, b) => a + b, 0) / means.length;
  return means.reduce((a, b) => a + (b - m) ** 2, 0) / means.length;
}

describe('blue noise', () => {
  const n = 32;
  const ranks = generateBlueNoise(n, 5);
  it('is a permutation of 0..n²−1', () => {
    const seen = new Uint8Array(n * n);
    for (const r of ranks) seen[r]++;
    expect(seen.every((c) => c === 1)).toBe(true);
  });
  it('is deterministic for a seed', () => {
    expect(Array.from(generateBlueNoise(n, 5))).toEqual(Array.from(ranks));
    expect(Array.from(generateBlueNoise(n, 6))).not.toEqual(Array.from(ranks));
  });
  it('has far less low-frequency energy than white noise with the same histogram', () => {
    const rng = mulberry32(9);
    const white = Array.from({ length: n * n }, (_, i) => i);
    for (let i = white.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [white[i], white[j]] = [white[j], white[i]];
    }
    const vb = blockMeanVariance(ranks, n, 4);
    const vw = blockMeanVariance(white, n, 4);
    expect(vb).toBeLessThan(vw * 0.25);
  });
  it('any threshold gives an evenly spread point set (no two of the first 5% adjacent)', () => {
    const k = Math.floor(n * n * 0.05);
    const pts: Array<[number, number]> = [];
    ranks.forEach((r, i) => {
      if (r < k) pts.push([i % n, Math.floor(i / n)]);
    });
    let minD = Infinity;
    for (let a = 0; a < pts.length; a++)
      for (let b = a + 1; b < pts.length; b++) {
        let dx = Math.abs(pts[a][0] - pts[b][0]);
        let dy = Math.abs(pts[a][1] - pts[b][1]);
        dx = Math.min(dx, n - dx);
        dy = Math.min(dy, n - dy);
        minD = Math.min(minD, Math.hypot(dx, dy));
      }
    expect(minD).toBeGreaterThan(1.5);
  });
  it('the job form yields and returns the same tile', () => {
    const job = blueNoiseJob(16, 2, 32);
    let yields = 0;
    let r = job.next();
    while (!r.done) {
      yields++;
      r = job.next();
    }
    expect(yields).toBeGreaterThan(4);
    expect(Array.from(r.value)).toEqual(Array.from(generateBlueNoise(16, 2)));
  });
});
