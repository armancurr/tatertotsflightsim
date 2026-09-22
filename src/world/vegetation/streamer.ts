/**
 * Chunk streaming for trees. PURE (no three.js): owns which chunks exist
 * around the camera, generates their placement cells incrementally within a
 * per-frame budget (cell count and wall-clock time), and packs a finished
 * chunk into a pooled buffer:
 *
 *   - instance layout (`I_STRIDE` floats): x, y, z, height, crown radius,
 *     code = species + rotation/2π (fraction), tint, rank — the exact layout
 *     the impostor shader reads, so the pooled array is uploaded as is;
 *   - trees sorted by rank bin (counting sort), so "draw the trees with
 *     rank < k" is a prefix: `countForKeep(k)`;
 *   - a per-cell index (cellStart/cellItems) for fast near-mesh gathering.
 *
 * Buffers come from an injected pool (acquire/release) — the renderer's pool
 * pairs each array with its GPU mesh — and go back to it on eviction.
 */
import { rectDistance } from './lod';
import { TREE_STRIDE, T_X, T_Y, T_Z, T_H, T_R, T_SPECIES, T_ROT, T_TINT, T_RANK, type TreeCell } from './placement';
import type { PoolHandle } from './pool';

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

export interface StreamerOptions<S> {
  chunkSize: number;
  cellSize: number;
  viewDistance: number;
  /** Chunks are dropped only beyond viewDistance + keepMargin (hysteresis). Default chunkSize/2. */
  keepMargin?: number;
  maxCellsPerFrame: number;
  /** Cell cap while urgent (a chunk within urgentRadius is not ready). Default 4 × maxCellsPerFrame. */
  urgentCellsPerFrame?: number;
  frameBudgetMs: number;
  urgentBudgetMs: number;
  /** Chunks closer than this must be ready; until then the urgent budget applies. Default 0 (own chunk). */
  urgentRadius?: number;
  generateCell(cx: number, cz: number): TreeCell;
  acquire(n: number): PoolHandle<S> | null;
  release(h: PoolHandle<S>): void;
  arrayOf(s: S): Float32Array;
  now?: () => number;
  onReady?: (c: StreamChunk<S>) => void;
  onEvict?: (c: StreamChunk<S>) => void;
}

export class StreamChunk<S> {
  ready = false;
  count = 0;
  slot: PoolHandle<S> | null = null;
  /** rankCdf[b] = number of trees whose rank < b / RANK_BINS. */
  rankCdf = new Uint32Array(RANK_BINS + 1);
  cellStart: Uint32Array;
  cellItems: Uint16Array | Uint32Array = new Uint16Array(0);
  minY = 0;
  maxY = 0;
  maxH = 0;
  maxR = 0;
  /** Nearest horizontal distance from the camera (updated every frame). */
  dist = 0;
  /** Renderer-owned per-chunk state. */
  user: unknown = null;
  /** @internal generation state */
  cells: TreeCell[] = [];
  nextCell = 0;

  constructor(
    readonly kx: number,
    readonly kz: number,
    readonly key: number,
    readonly x0: number,
    readonly z0: number,
    readonly size: number,
    readonly cellsPerSide: number,
  ) {
    this.cellStart = new Uint32Array(cellsPerSide * cellsPerSide + 1);
  }

  get x1(): number {
    return this.x0 + this.size;
  }
  get z1(): number {
    return this.z0 + this.size;
  }

  /** Instances to submit so that every tree with rank < keep is included (a prefix). */
  countForKeep(keep: number): number {
    if (!(keep > 0)) return 0;
    if (keep >= 1) return this.count;
    return this.rankCdf[Math.min(RANK_BINS, Math.ceil(keep * RANK_BINS))];
  }
}

const OFF = 1 << 20;
const chunkKey = (kx: number, kz: number): number => (kx + OFF) * 2097152 + (kz + OFF);

export class ChunkStreamer<S> {
  readonly chunks = new Map<number, StreamChunk<S>>();
  onReady?: (c: StreamChunk<S>) => void;
  onEvict?: (c: StreamChunk<S>) => void;
  private readonly o: StreamerOptions<S>;
  private readonly cellsPerSide: number;
  private readonly keepMargin: number;
  private readonly work: StreamChunk<S>[] = [];
  private readonly now: () => number;
  private readonly result = { generated: 0, urgent: false, readied: 0, evicted: 0 };
  private binCount = new Uint32Array(RANK_BINS + 1);
  private cellOf = new Uint16Array(0);

  constructor(opts: StreamerOptions<S>) {
    this.o = opts;
    this.cellsPerSide = Math.round(opts.chunkSize / opts.cellSize);
    this.keepMargin = opts.keepMargin ?? opts.chunkSize * 0.5;
    this.now = opts.now ?? (() => performance.now());
    this.onReady = opts.onReady;
    this.onEvict = opts.onEvict;
  }

  /** Chunk containing world point (x, z), if streamed. */
  chunkAt(x: number, z: number): StreamChunk<S> | undefined {
    const s = this.o.chunkSize;
    return this.chunks.get(chunkKey(Math.floor(x / s), Math.floor(z / s)));
  }

  /** Cells still to generate for chunks currently tracked. */
  pendingCells(): number {
    let n = 0;
    const per = this.cellsPerSide * this.cellsPerSide;
    for (const c of this.chunks.values()) if (!c.ready) n += per - c.nextCell;
    return n;
  }

  update(x: number, z: number): { generated: number; urgent: boolean; readied: number; evicted: number } {
    const o = this.o;
    const t0 = this.now();
    const size = o.chunkSize;
    const R = o.viewDistance;
    const res = this.result;
    res.generated = 0;
    res.readied = 0;
    res.evicted = 0;

    // 1. Track every chunk in range.
    const k0x = Math.floor((x - R) / size);
    const k1x = Math.floor((x + R) / size);
    const k0z = Math.floor((z - R) / size);
    const k1z = Math.floor((z + R) / size);
    for (let kz = k0z; kz <= k1z; kz++)
      for (let kx = k0x; kx <= k1x; kx++) {
        const key = chunkKey(kx, kz);
        if (this.chunks.has(key)) continue;
        const d = rectDistance(x, z, kx * size, kz * size, (kx + 1) * size, (kz + 1) * size);
        if (d <= R) this.chunks.set(key, new StreamChunk<S>(kx, kz, key, kx * size, kz * size, size, this.cellsPerSide));
      }

    // 2. Distances, eviction, work list.
    const work = this.work;
    work.length = 0;
    let urgent = false;
    const urgentR = o.urgentRadius ?? 0;
    for (const c of this.chunks.values()) {
      c.dist = rectDistance(x, z, c.x0, c.z0, c.x1, c.z1);
      if (c.dist > R + this.keepMargin) {
        this.evict(c);
        continue;
      }
      if (!c.ready) {
        work.push(c);
        if (c.dist <= urgentR) urgent = true;
      }
    }
    res.urgent = urgent;
    work.sort((a, b) => a.dist - b.dist);

    // 3. Generate within the budget (always make some progress).
    const cap = urgent ? (o.urgentCellsPerFrame ?? o.maxCellsPerFrame * 4) : o.maxCellsPerFrame;
    const budget = urgent ? o.urgentBudgetMs : o.frameBudgetMs;
    const per = this.cellsPerSide * this.cellsPerSide;
    outer: for (const c of work) {
      while (c.nextCell < per) {
        if (res.generated >= cap || (res.generated > 0 && this.now() - t0 >= budget)) break outer;
        const i = c.nextCell % this.cellsPerSide;
        const j = Math.floor(c.nextCell / this.cellsPerSide);
        c.cells.push(o.generateCell(c.kx * this.cellsPerSide + i, c.kz * this.cellsPerSide + j));
        c.nextCell++;
        res.generated++;
      }
      this.finalize(c);
      res.readied++;
      this.onReady?.(c);
    }
    return res;
  }

  private evict(c: StreamChunk<S>): void {
    this.chunks.delete(c.key);
    if (c.slot) {
      this.o.release(c.slot);
      c.slot = null;
    }
    c.cells = [];
    this.result.evicted++;
    this.onEvict?.(c);
  }

  /** Packs the generated cells into a pooled, rank-sorted instance buffer. */
  private finalize(c: StreamChunk<S>): void {
    let total = 0;
    for (const cell of c.cells) total += cell.count;
    c.ready = true;
    c.count = 0;
    if (total === 0) {
      c.cells = [];
      c.rankCdf.fill(0);
      return;
    }
    const slot = this.o.acquire(total);
    if (!slot) {
      c.cells = [];
      return;
    }
    const arr = this.o.arrayOf(slot.value);
    const n = Math.min(total, slot.capacity);

    // Counting sort by rank bin.
    const bins = this.binCount;
    bins.fill(0);
    for (const cell of c.cells)
      for (let t = 0; t < cell.count; t++) {
        const b = Math.min(RANK_BINS - 1, Math.floor(cell.data[t * TREE_STRIDE + T_RANK] * RANK_BINS));
        bins[b + 1]++;
      }
    for (let b = 1; b <= RANK_BINS; b++) bins[b] += bins[b - 1];
    c.rankCdf.set(bins);
    if (this.cellOf.length < total) this.cellOf = new Uint16Array(Math.max(total, this.cellOf.length * 2));
    const cellOf = this.cellOf;
    let minY = Infinity;
    let maxY = -Infinity;
    let maxH = 0;
    let maxR = 0;
    for (let ci = 0; ci < c.cells.length; ci++) {
      const cell = c.cells[ci];
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
    if (n < total) for (let b = 0; b <= RANK_BINS; b++) c.rankCdf[b] = Math.min(c.rankCdf[b], n);

    // Per-cell index.
    const cells = this.cellsPerSide * this.cellsPerSide;
    const start = c.cellStart;
    start.fill(0);
    for (let i = 0; i < n; i++) start[cellOf[i] + 1]++;
    for (let ci = 1; ci <= cells; ci++) start[ci] += start[ci - 1];
    const items = n < 65536 ? new Uint16Array(n) : new Uint32Array(n);
    const fill = start.slice(0, cells);
    for (let i = 0; i < n; i++) items[fill[cellOf[i]]++] = i;

    c.cellItems = items;
    c.count = n;
    c.slot = slot;
    c.minY = minY;
    c.maxY = maxY;
    c.maxH = maxH;
    c.maxR = maxR;
    c.cells = [];
  }

  /** Releases every chunk's buffer back to the pool. */
  dispose(): void {
    for (const c of [...this.chunks.values()]) this.evict(c);
  }
}
