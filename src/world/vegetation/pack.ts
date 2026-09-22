/**
 * Packing placement cells into the instance layout the impostor shader reads.
 * PURE (no three.js, no DOM) — runs in the vegetation worker and inline.
 *
 *   - instance layout (`I_STRIDE` floats): x, y, z, height, crown radius,
 *     code = species + rotation/2π (fraction), tint, rank;
 *   - trees sorted by rank bin (counting sort), so "draw the trees with
 *     rank < k" is a prefix: `rankCdf[ceil(k · RANK_BINS)]`;
 *   - a per-cell index (cellStart/cellItems) for fast near-mesh gathering.
 */
import { TREE_STRIDE, T_X, T_Y, T_Z, T_H, T_R, T_SPECIES, T_ROT, T_TINT, T_RANK, treesInCell, type PlacementParams, type TreeCell, type VegWorld } from './placement';

export const I_STRIDE = 8;
export const I_X = 0;
export const I_Y = 1;
export const I_Z = 2;
export const I_H = 3;
export const I_R = 4;
export const I_CODE = 5;
export const I_TINT = 6;
export const I_RANK = 7;
export const RANK_BINS = 256;

export interface PackedChunk {
  /** Trees packed (≤ the data capacity). */
  count: number;
  /** count × I_STRIDE floats (the array may be longer). */
  data: Float32Array;
  /** rankCdf[b] = number of trees whose rank < b / RANK_BINS. */
  rankCdf: Uint32Array;
  /** Per-cell index: trees of cell ci are cellItems[cellStart[ci] .. cellStart[ci+1]). */
  cellStart: Uint32Array;
  cellItems: Uint16Array | Uint32Array;
  minY: number;
  maxY: number;
  maxH: number;
  maxR: number;
  /** Only candidates with rank < rankMax were generated. */
  rankMax: number;
}

let binScratch = new Uint32Array(RANK_BINS + 1);
let cellOfScratch = new Uint16Array(0);

/**
 * Packs cells (row-major, `cellsPerSide²` of them) into `out` (or a new array of
 * exactly the right size when `out` is null). Trees beyond `out`'s capacity are
 * dropped by rank (the prefix stays valid).
 */
export function packCells(cells: readonly TreeCell[], cellsPerSide: number, out: Float32Array | null, rankMax = 1): PackedChunk {
  let total = 0;
  for (const cell of cells) total += cell.count;
  const arr = out ?? new Float32Array(total * I_STRIDE);
  const n = Math.min(total, Math.floor(arr.length / I_STRIDE));
  const bins = binScratch.length === RANK_BINS + 1 ? binScratch : (binScratch = new Uint32Array(RANK_BINS + 1));
  bins.fill(0);
  for (const cell of cells)
    for (let t = 0; t < cell.count; t++) {
      const b = Math.min(RANK_BINS - 1, Math.floor(cell.data[t * TREE_STRIDE + T_RANK] * RANK_BINS));
      bins[b + 1]++;
    }
  for (let b = 1; b <= RANK_BINS; b++) bins[b] += bins[b - 1];
  const rankCdf = new Uint32Array(bins);
  if (cellOfScratch.length < total) cellOfScratch = new Uint16Array(Math.max(total, cellOfScratch.length * 2));
  const cellOf = cellOfScratch;
  let minY = Infinity;
  let maxY = -Infinity;
  let maxH = 0;
  let maxR = 0;
  for (let ci = 0; ci < cells.length; ci++) {
    const cell = cells[ci];
    const d = cell.data;
    for (let t = 0; t < cell.count; t++) {
      const s = t * TREE_STRIDE;
      const b = Math.min(RANK_BINS - 1, Math.floor(d[s + T_RANK] * RANK_BINS));
      const pos = bins[b]++;
      if (pos >= n) continue;
      const w = pos * I_STRIDE;
      arr[w + I_X] = d[s + T_X];
      arr[w + I_Y] = d[s + T_Y];
      arr[w + I_Z] = d[s + T_Z];
      arr[w + I_H] = d[s + T_H];
      arr[w + I_R] = d[s + T_R];
      arr[w + I_CODE] = d[s + T_SPECIES] + (d[s + T_ROT] / (Math.PI * 2)) * 0.999;
      arr[w + I_TINT] = d[s + T_TINT];
      arr[w + I_RANK] = d[s + T_RANK];
      cellOf[pos] = ci;
      const y = d[s + T_Y];
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (d[s + T_H] > maxH) maxH = d[s + T_H];
      if (d[s + T_R] > maxR) maxR = d[s + T_R];
    }
  }
  if (n < total) for (let b = 0; b <= RANK_BINS; b++) rankCdf[b] = Math.min(rankCdf[b], n);

  const ncell = cellsPerSide * cellsPerSide;
  const start = new Uint32Array(ncell + 1);
  for (let i = 0; i < n; i++) start[cellOf[i] + 1]++;
  for (let ci = 1; ci <= ncell; ci++) start[ci] += start[ci - 1];
  const items = n < 65536 ? new Uint16Array(n) : new Uint32Array(n);
  const fill = start.slice(0, ncell);
  for (let i = 0; i < n; i++) items[fill[cellOf[i]]++] = i;
  if (total === 0) {
    minY = 0;
    maxY = 0;
  }
  return { count: n, data: arr, rankCdf, cellStart: start, cellItems: items, minY, maxY, maxH, maxR, rankMax };
}

/** Generates and packs a whole chunk (cellsPerSide² cells starting at cell (kx·per, kz·per)). */
export function generateChunk(kx: number, kz: number, cellsPerSide: number, world: VegWorld, seed: number, params: PlacementParams, rankMax: number): PackedChunk {
  const cells: TreeCell[] = [];
  for (let j = 0; j < cellsPerSide; j++)
    for (let i = 0; i < cellsPerSide; i++) cells.push(treesInCell(kx * cellsPerSide + i, kz * cellsPerSide + j, world, seed, params, rankMax));
  return packCells(cells, cellsPerSide, null, rankMax);
}

/**
 * The trees of cell `ci` of a packed chunk as a `TreeCell` (placement layout) —
 * exact copies of the generated floats, so obstacle queries match `treesInCell`.
 */
export function extractCell(p: PackedChunk, ci: number, cx: number, cz: number): TreeCell {
  const a = p.data;
  const k0 = p.cellStart[ci];
  const k1 = p.cellStart[ci + 1];
  const data = new Float32Array((k1 - k0) * TREE_STRIDE);
  for (let k = k0; k < k1; k++) {
    const o = p.cellItems[k] * I_STRIDE;
    const w = (k - k0) * TREE_STRIDE;
    const code = a[o + I_CODE];
    const sp = Math.floor(code);
    data[w + T_X] = a[o + I_X];
    data[w + T_Y] = a[o + I_Y];
    data[w + T_Z] = a[o + I_Z];
    data[w + T_H] = a[o + I_H];
    data[w + T_R] = a[o + I_R];
    data[w + T_SPECIES] = sp;
    data[w + T_ROT] = ((code - sp) / 0.999) * Math.PI * 2;
    data[w + T_TINT] = a[o + I_TINT];
    data[w + T_RANK] = a[o + I_RANK];
  }
  return { cx, cz, count: k1 - k0, data };
}
