/**
 * Blue-noise dither tile by void-and-cluster (Ulichney 1993), pure.
 *
 * Returns the rank of every pixel (a permutation of 0..n²−1): thresholding the
 * ranks at any level gives an evenly spread point set, so using rank/n² as a
 * per-pixel ray-start jitter spreads the raymarch error as high-frequency
 * noise that the temporal accumulation removes almost completely.
 * Energy: toroidal Gaussian (σ = 1.5 px) truncated at ±6 px.
 */
import { mulberry32 } from './noise';

const SIGMA = 1.5;
const R = 6;

export function* blueNoiseJob(n: number, seed: number, unitsPerYield = 64): Generator<void, Uint16Array, void> {
  const N = n * n;
  const kSize = 2 * R + 1;
  const kernel = new Float32Array(kSize * kSize);
  for (let y = -R; y <= R; y++) for (let x = -R; x <= R; x++) kernel[(y + R) * kSize + (x + R)] = Math.exp(-(x * x + y * y) / (2 * SIGMA * SIGMA));
  const energy = new Float64Array(N);
  const on = new Uint8Array(N);
  const rank = new Uint16Array(N);
  const splat = (i: number, sgn: number) => {
    const px = i % n;
    const py = (i - px) / n;
    for (let y = -R; y <= R; y++) {
      const row = (((py + y) % n) + n) % n;
      for (let x = -R; x <= R; x++) {
        const col = (((px + x) % n) + n) % n;
        energy[row * n + col] += sgn * kernel[(y + R) * kSize + (x + R)];
      }
    }
  };
  const tightestCluster = () => {
    let best = -1;
    let bestE = -Infinity;
    for (let i = 0; i < N; i++) if (on[i] && energy[i] > bestE) (bestE = energy[i]), (best = i);
    return best;
  };
  const largestVoid = () => {
    let best = -1;
    let bestE = Infinity;
    for (let i = 0; i < N; i++) if (!on[i] && energy[i] < bestE) (bestE = energy[i]), (best = i);
    return best;
  };

  // Initial pattern: ~10 % random ones, relaxed until stable.
  const rng = mulberry32(seed ^ 0xb1e5);
  const ones = Math.max(1, Math.floor(N / 10));
  let placed = 0;
  while (placed < ones) {
    const i = Math.floor(rng() * N);
    if (on[i]) continue;
    on[i] = 1;
    splat(i, 1);
    placed++;
  }
  for (let it = 0; it < N; it++) {
    const c = tightestCluster();
    on[c] = 0;
    splat(c, -1);
    const v = largestVoid();
    on[v] = 1;
    splat(v, 1);
    if (v === c) break;
    if (it % unitsPerYield === unitsPerYield - 1) yield;
  }
  const initial = on.slice();
  const initialEnergy = energy.slice();

  // Phase 1: rank the initial ones by removing the tightest cluster.
  let count = ones;
  let work = 0;
  while (count > 0) {
    const c = tightestCluster();
    on[c] = 0;
    splat(c, -1);
    count--;
    rank[c] = count;
    if (++work % unitsPerYield === 0) yield;
  }
  // Phases 2+3: from the initial pattern, fill the largest void until full.
  on.set(initial);
  energy.set(initialEnergy);
  count = ones;
  while (count < N) {
    const v = largestVoid();
    on[v] = 1;
    splat(v, 1);
    rank[v] = count;
    count++;
    if (++work % unitsPerYield === 0) yield;
  }
  return rank;
}

export function generateBlueNoise(n: number, seed: number): Uint16Array {
  const job = blueNoiseJob(n, seed);
  for (;;) {
    const r = job.next();
    if (r.done) return r.value;
  }
}
