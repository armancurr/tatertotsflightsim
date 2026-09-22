/**
 * Chunk streaming for trees. PURE (no three.js): owns which chunks exist
 * around the camera, gets their trees generated and packs a finished chunk
 * into a pooled buffer (see pack.ts for the layout).
 *
 * Two ways to generate:
 *   - inline (`generateCell`): cells are generated on the calling thread,
 *     incrementally within a per-frame budget (cell count and wall-clock time);
 *   - async (`source`): whole chunks are requested from an `AsyncChunkSource`
 *     (the Web Worker pool in the app) nearest first and delivered packed; the
 *     main thread only copies them into pooled buffers.
 *
 * LOD levels: `levelFor(dist3)` says which rank prefix a chunk needs (1 = every
 * tree; far chunks draw only rank < k, so only those are generated). A chunk
 * whose need grows is regenerated at the higher level while the old data keeps
 * drawing; the new data is a superset, so nothing pops.
 *
 * Buffers come from an injected pool (acquire/release) — the renderer's pool
 * pairs each array with its GPU mesh — and go back to it on eviction.
 */
import { rectDistance } from './lod';
import { packCells, I_STRIDE, RANK_BINS, type PackedChunk } from './pack';
import type { TreeCell } from './placement';
import type { PoolHandle } from './pool';

export { I_STRIDE, I_X, I_Y, I_Z, I_H, I_R, I_CODE, I_TINT, I_RANK, RANK_BINS } from './pack';

export interface ChunkJob {
  key: number;
  kx: number;
  kz: number;
  /** Generate candidates with rank < rankMax. */
  rankMax: number;
  /** Lower = sooner. */
  priority: number;
}

/** Asynchronous chunk generation (the vegetation Web Workers, or a test double). */
export interface AsyncChunkSource {
  /** Queues a job (replaces a queued job with the same key). */
  request(job: ChunkJob): void;
  /** Drops a queued job (a running one is delivered and ignored). */
  cancel(key: number): void;
  /** Hands over every finished job. */
  drain(cb: (key: number, p: PackedChunk) => void): void;
  /** Jobs queued + running. */
  pending(): number;
}

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
  /** Inline generation of one cell (rank < rankMax). Needed unless `source` is given. */
  generateCell?(cx: number, cz: number, rankMax: number): TreeCell;
  /** Asynchronous whole-chunk generation (takes precedence over generateCell). */
  source?: AsyncChunkSource;
  /** Rank prefix needed at a 3D distance (quantised by the streamer). Default: always 1 (every tree). */
  levelFor?(dist3: number): number;
  acquire(n: number): PoolHandle<S> | null;
  release(h: PoolHandle<S>): void;
  arrayOf(s: S): Float32Array;
  now?: () => number;
  onReady?: (c: StreamChunk<S>) => void;
  onEvict?: (c: StreamChunk<S>) => void;
}

/** Quantises a needed keep fraction to a generation level: 1, 1/2, 1/4, 1/8 (0 = none). */
export function quantizeLevel(keep: number): number {
  if (!(keep > 0)) return 0;
  if (keep > 0.5) return 1;
  if (keep > 0.25) return 0.5;
  if (keep > 0.125) return 0.25;
  return 0.125;
}

export class StreamChunk<S> {
  /** Has instance data (at `level`). */
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
  /** Rank prefix held (0 = nothing yet; 1 = every tree). */
  level = 0;
  /** Rank prefix needed now. */
  want = 0;
  /** Nearest horizontal / 3D distance from the camera (updated every frame). */
  dist = 0;
  dist3 = 0;
  /** Renderer-owned per-chunk state. */
  user: unknown = null;
  /** @internal generation state */
  cells: TreeCell[] = [];
  nextCell = 0;
  genLevel = 0;
  requested = 0;

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
export const chunkKey = (kx: number, kz: number): number => (kx + OFF) * 2097152 + (kz + OFF);

export class ChunkStreamer<S> {
  readonly chunks = new Map<number, StreamChunk<S>>();
  onReady?: (c: StreamChunk<S>) => void;
  onEvict?: (c: StreamChunk<S>) => void;
  private readonly o: StreamerOptions<S>;
  readonly cellsPerSide: number;
  private readonly keepMargin: number;
  private readonly work: StreamChunk<S>[] = [];
  private readonly now: () => number;
  private readonly result = { generated: 0, urgent: false, readied: 0, evicted: 0, requested: 0 };
  private readonly byDist = (a: StreamChunk<S>, b: StreamChunk<S>): number => a.dist3 - b.dist3;
  private readonly onDelivered = (key: number, p: PackedChunk): void => {
    const c = this.chunks.get(key);
    if (!c) return;
    if (c.requested === p.rankMax) c.requested = 0;
    if (p.rankMax <= c.level) return; // stale (we already hold as much)
    this.install(c, p);
    this.result.readied++;
    this.onReady?.(c);
  };

  constructor(opts: StreamerOptions<S>) {
    if (!opts.source && !opts.generateCell) throw new Error('ChunkStreamer: generateCell or source required');
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

  /** Cells still to generate for chunks currently tracked (whole chunks count fully in async mode). */
  pendingCells(): number {
    let n = 0;
    const per = this.cellsPerSide * this.cellsPerSide;
    for (const c of this.chunks.values()) if (c.level < c.want) n += this.o.source ? per : per - (c.genLevel === c.want ? c.nextCell : 0);
    return n;
  }

  /**
   * Per frame. (x, z) = camera; `y` = camera height and `groundY` = a ground
   * height estimate for chunks not generated yet (both only matter with levels).
   */
  update(x: number, z: number, y = 0, groundY = y): { generated: number; urgent: boolean; readied: number; evicted: number; requested: number } {
    const o = this.o;
    const t0 = this.now();
    const size = o.chunkSize;
    const R = o.viewDistance;
    const res = this.result;
    res.generated = 0;
    res.readied = 0;
    res.evicted = 0;
    res.requested = 0;

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

    // 2. Finished async jobs.
    o.source?.drain(this.onDelivered);

    // 3. Distances, levels, eviction, work list.
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
      let dy: number;
      if (c.ready && c.count > 0) {
        const top = c.maxY + c.maxH;
        dy = y > top ? y - top : y < c.minY ? c.minY - y : 0;
      } else {
        const top = groundY + 400; // conservative guess for ground not generated yet
        dy = y > top ? y - top : 0;
      }
      c.dist3 = Math.sqrt(c.dist * c.dist + dy * dy);
      const need = o.levelFor ? quantizeLevel(o.levelFor(c.dist3)) : 1;
      if (need > c.want) c.want = need;
      if (c.level < c.want) {
        work.push(c);
        if (c.dist <= urgentR && !c.ready) urgent = true;
      }
    }
    res.urgent = urgent;
    work.sort(this.byDist);

    // 4a. Async: request what is missing, nearest first.
    if (o.source) {
      for (const c of work) {
        if (c.requested >= c.want) continue;
        c.requested = c.want;
        o.source.request({ key: c.key, kx: c.kx, kz: c.kz, rankMax: c.want, priority: c.dist3 });
        res.requested++;
      }
      return res;
    }

    // 4b. Inline: generate within the budget (always make some progress).
    const cap = urgent ? (o.urgentCellsPerFrame ?? o.maxCellsPerFrame * 4) : o.maxCellsPerFrame;
    const budget = urgent ? o.urgentBudgetMs : o.frameBudgetMs;
    const per = this.cellsPerSide * this.cellsPerSide;
    outer: for (const c of work) {
      if (c.genLevel !== c.want) {
        // (re)start at the level needed now
        c.genLevel = c.want;
        c.cells = [];
        c.nextCell = 0;
      }
      while (c.nextCell < per) {
        if (res.generated >= cap || (res.generated > 0 && this.now() - t0 >= budget)) break outer;
        const i = c.nextCell % this.cellsPerSide;
        const j = Math.floor(c.nextCell / this.cellsPerSide);
        c.cells.push(o.generateCell!(c.kx * this.cellsPerSide + i, c.kz * this.cellsPerSide + j, c.genLevel));
        c.nextCell++;
        res.generated++;
      }
      this.finalizeInline(c);
      res.readied++;
      this.onReady?.(c);
    }
    return res;
  }

  private evict(c: StreamChunk<S>): void {
    this.chunks.delete(c.key);
    if (c.requested > 0) this.o.source?.cancel(c.key);
    if (c.slot) {
      this.o.release(c.slot);
      c.slot = null;
    }
    c.cells = [];
    this.result.evicted++;
    this.onEvict?.(c);
  }

  /** Packs the generated cells into a pooled, rank-sorted instance buffer. */
  private finalizeInline(c: StreamChunk<S>): void {
    let total = 0;
    for (const cell of c.cells) total += cell.count;
    const level = c.genLevel;
    c.genLevel = 0;
    c.nextCell = 0;
    if (total === 0) {
      this.clearData(c, level);
      c.cells = [];
      return;
    }
    const slot = this.o.acquire(total);
    if (!slot) {
      c.cells = [];
      c.level = level; // cannot hold it: don't retry forever
      c.ready = true;
      return;
    }
    const p = packCells(c.cells, this.cellsPerSide, this.o.arrayOf(slot.value), level);
    c.cells = [];
    this.adopt(c, p, slot);
  }

  /** Installs a delivered (async) chunk: copies it into a pooled buffer. */
  private install(c: StreamChunk<S>, p: PackedChunk): void {
    if (p.count === 0) {
      this.clearData(c, p.rankMax);
      return;
    }
    const slot = this.o.acquire(p.count);
    if (!slot) {
      c.level = p.rankMax;
      c.ready = true;
      return;
    }
    const arr = this.o.arrayOf(slot.value);
    const n = Math.min(p.count, Math.floor(arr.length / I_STRIDE));
    arr.set(p.data.subarray(0, n * I_STRIDE));
    if (n < p.count) for (let b = 0; b <= RANK_BINS; b++) p.rankCdf[b] = Math.min(p.rankCdf[b], n);
    p.count = n;
    this.adopt(c, p, slot);
  }

  private adopt(c: StreamChunk<S>, p: PackedChunk, slot: PoolHandle<S>): void {
    if (c.slot) this.o.release(c.slot);
    c.slot = slot;
    c.count = p.count;
    c.rankCdf.set(p.rankCdf);
    c.cellStart = p.cellStart;
    c.cellItems = p.cellItems;
    c.minY = p.minY;
    c.maxY = p.maxY;
    c.maxH = p.maxH;
    c.maxR = p.maxR;
    c.level = p.rankMax;
    c.ready = true;
  }

  private clearData(c: StreamChunk<S>, level: number): void {
    if (c.slot) {
      this.o.release(c.slot);
      c.slot = null;
    }
    c.count = 0;
    c.rankCdf.fill(0);
    c.cellStart.fill(0);
    c.cellItems = new Uint16Array(0);
    c.level = level;
    c.ready = true;
  }

  /** Releases every chunk's buffer back to the pool. */
  dispose(): void {
    for (const c of [...this.chunks.values()]) this.evict(c);
  }
}
