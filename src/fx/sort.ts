/**
 * PURE, allocation-free back-to-front ordering for alpha-blended particles: a counting sort on
 * quantised view depth (O(n + buckets), stable, deterministic). With 2048 buckets the ordering
 * error is range/2048 — far below a particle's size.
 */

export interface SortScratch {
  buckets: number;
  counts: Uint32Array;
  keys: Uint32Array;
}

export function createSortScratch(capacity: number, buckets = 2048): SortScratch {
  return { buckets, counts: new Uint32Array(buckets + 1), keys: new Uint32Array(Math.max(1, capacity)) };
}

/** Fill order[0..n) with indices 0..n-1 sorted by depth, largest (farthest) first. */
export function sortBackToFront(depth: ArrayLike<number>, n: number, order: Int32Array | Uint32Array, s: SortScratch): void {
  if (n <= 0) return;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    const d = depth[i];
    if (d < min) min = d;
    if (d > max) max = d;
  }
  const range = max - min;
  if (!(range > 0) || !Number.isFinite(range)) {
    for (let i = 0; i < n; i++) order[i] = i;
    return;
  }
  const B = s.buckets;
  const scale = B / range;
  const counts = s.counts;
  const keys = s.keys;
  counts.fill(0);
  for (let i = 0; i < n; i++) {
    let q = Math.floor((max - depth[i]) * scale); // far → small key → drawn first
    if (!(q >= 0)) q = 0;
    if (q > B - 1) q = B - 1;
    keys[i] = q;
    counts[q + 1]++;
  }
  for (let b = 1; b <= B; b++) counts[b] += counts[b - 1];
  for (let i = 0; i < n; i++) order[counts[keys[i]]++] = i;
}
