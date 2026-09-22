import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { ChunkStreamer, I_STRIDE, I_X, I_Z, I_RANK, I_CODE, RANK_BINS, type StreamerOptions } from '../../../src/world/vegetation/streamer';
import { SizeClassPool, sizeClasses } from '../../../src/world/vegetation/pool';
import { treesInCell, placementParams, TREE_STRIDE, T_X, T_Z, T_SPECIES, type TreeCell } from '../../../src/world/vegetation/placement';

const P = placementParams();
const hills = (x: number, z: number) => 30 + 10 * Math.sin(x / 400);
/** Patchy forest: roughly half the land. */
const patchy = (x: number, z: number) => (Math.sin(x / 700) * Math.cos(z / 900) > 0 ? 0.9 : 0.02);

interface Setup {
  streamer: ChunkStreamer<Float32Array>;
  pool: SizeClassPool<Float32Array>;
  generated: { n: number };
  ready: number;
  evicted: number;
}

function setup(over: Partial<StreamerOptions<Float32Array>> = {}, density: (x: number, z: number) => number = patchy): Setup {
  const chunkSize = over.chunkSize ?? 512;
  const perSide = (chunkSize / P.cellSize) * P.gridPerCell;
  const pool = new SizeClassPool<Float32Array>(sizeClasses(perSide * perSide), (cap) => new Float32Array(cap * I_STRIDE), undefined, 6);
  const generated = { n: 0 };
  const s: Setup = { streamer: null as unknown as ChunkStreamer<Float32Array>, pool, generated, ready: 0, evicted: 0 };
  s.streamer = new ChunkStreamer<Float32Array>({
    chunkSize,
    cellSize: P.cellSize,
    viewDistance: 1500,
    maxCellsPerFrame: 16,
    urgentCellsPerFrame: 64,
    frameBudgetMs: Infinity,
    urgentBudgetMs: Infinity,
    urgentRadius: 0,
    generateCell: (cx, cz): TreeCell => {
      generated.n++;
      return treesInCell(cx, cz, density, hills, 99);
    },
    acquire: (n) => pool.acquire(n),
    release: (h) => pool.release(h),
    arrayOf: (a) => a,
    onReady: () => s.ready++,
    onEvict: () => s.evicted++,
    ...over,
  });
  return s;
}

function runUntilIdle(s: Setup, x: number, z: number, maxFrames = 5000): number {
  let frames = 0;
  while (frames < maxFrames) {
    s.streamer.update(x, z);
    frames++;
    if (s.streamer.pendingCells() === 0) break;
  }
  return frames;
}

describe('ChunkStreamer — time slicing', () => {
  it('generates at most maxCellsPerFrame cells per update once the camera chunk is ready', () => {
    const s = setup();
    runUntilIdle(s, 0, 0, 1); // first (urgent) frame
    for (let f = 0; f < 50; f++) {
      const before = s.generated.n;
      const r = s.streamer.update(0, 0);
      const made = s.generated.n - before;
      expect(made).toBe(r.generated);
      if (!r.urgent) expect(made).toBeLessThanOrEqual(16);
      else expect(made).toBeLessThanOrEqual(64);
    }
  }, 90000);

  it('respects the time budget with an injected clock (always ≥ 1 cell of progress)', () => {
    let t = 0;
    const s = setup({ frameBudgetMs: 2, urgentBudgetMs: 2, maxCellsPerFrame: 1000, urgentCellsPerFrame: 1000, now: () => (t += 0.5) });
    for (let f = 0; f < 20; f++) {
      const r = s.streamer.update(100, 100);
      expect(r.generated).toBeGreaterThanOrEqual(1);
      expect(r.generated).toBeLessThanOrEqual(4);
    }
  }, 90000);

  it('urgent mode: the chunk under the camera gets the larger budget until it is ready', () => {
    const s = setup();
    const r = s.streamer.update(10, 10);
    expect(r.urgent).toBe(true);
    expect(r.generated).toBe(64);
    runUntilIdle(s, 10, 10);
    expect(s.streamer.update(10, 10).urgent).toBe(false);
  }, 90000);

  it('eventually readies every chunk in range, nearest first', () => {
    const s = setup();
    const order: number[] = [];
    s.streamer.onReady = (c) => order.push(c.dist);
    runUntilIdle(s, 0, 0);
    expect(s.streamer.pendingCells()).toBe(0);
    for (const c of s.streamer.chunks.values()) expect(c.ready).toBe(true);
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThanOrEqual(order[i - 1] - 1e-9);
  }, 90000);
});

describe('ChunkStreamer — chunk contents', () => {
  it('a ready chunk holds exactly the trees of its cells, sorted by rank, with a rank CDF', () => {
    const s = setup();
    runUntilIdle(s, 0, 0);
    const c = [...s.streamer.chunks.values()].find((k) => k.count > 50)!;
    expect(c).toBeDefined();
    const perSide = 512 / P.cellSize;
    let expected = 0;
    const xs = new Set<string>();
    for (let j = 0; j < perSide; j++)
      for (let i = 0; i < perSide; i++) {
        const cell = treesInCell(c.kx * perSide + i, c.kz * perSide + j, patchy, hills, 99);
        expected += cell.count;
        for (let t = 0; t < cell.count; t++)
          xs.add(`${cell.data[t * TREE_STRIDE + T_X]},${cell.data[t * TREE_STRIDE + T_Z]},${cell.data[t * TREE_STRIDE + T_SPECIES]}`);
      }
    expect(c.count).toBe(expected);
    const a = c.slot!.value;
    for (let i = 0; i < c.count; i++) {
      expect(xs.has(`${a[i * I_STRIDE + I_X]},${a[i * I_STRIDE + I_Z]},${Math.floor(a[i * I_STRIDE + I_CODE])}`)).toBe(true);
      if (i > 0) expect(Math.floor(a[i * I_STRIDE + I_RANK] * RANK_BINS)).toBeGreaterThanOrEqual(Math.floor(a[(i - 1) * I_STRIDE + I_RANK] * RANK_BINS));
    }
    expect(c.rankCdf[0]).toBe(0);
    expect(c.rankCdf[RANK_BINS]).toBe(c.count);
    // countForKeep is a superset of the trees with rank < keep
    for (const k of [0.1, 0.33, 0.5, 0.9]) {
      let n = 0;
      for (let i = 0; i < c.count; i++) if (a[i * I_STRIDE + I_RANK] < k) n++;
      expect(c.countForKeep(k)).toBeGreaterThanOrEqual(n);
      expect(c.countForKeep(k)).toBeLessThanOrEqual(n + c.count / 64 + 8);
    }
  }, 90000);

  it('the per-cell index lists every tree once, inside its cell', () => {
    const s = setup();
    runUntilIdle(s, 0, 0);
    for (const c of s.streamer.chunks.values()) {
      if (c.count === 0) continue;
      const seen = new Uint8Array(c.count);
      const perSide = c.cellsPerSide;
      for (let ci = 0; ci < perSide * perSide; ci++) {
        const x0 = c.x0 + (ci % perSide) * P.cellSize;
        const z0 = c.z0 + Math.floor(ci / perSide) * P.cellSize;
        for (let k = c.cellStart[ci]; k < c.cellStart[ci + 1]; k++) {
          const t = c.cellItems[k];
          seen[t]++;
          const a = c.slot!.value;
          expect(a[t * I_STRIDE + I_X]).toBeGreaterThanOrEqual(x0 - 1e-3);
          expect(a[t * I_STRIDE + I_X]).toBeLessThanOrEqual(x0 + P.cellSize + 1e-3);
          expect(a[t * I_STRIDE + I_Z]).toBeGreaterThanOrEqual(z0 - 1e-3);
          expect(a[t * I_STRIDE + I_Z]).toBeLessThanOrEqual(z0 + P.cellSize + 1e-3);
        }
      }
      expect([...seen].every((v) => v === 1)).toBe(true);
    }
  }, 90000);

  it('chunks with no trees are ready but take no buffer', () => {
    const s = setup({}, () => 0);
    runUntilIdle(s, 0, 0);
    for (const c of s.streamer.chunks.values()) {
      expect(c.ready).toBe(true);
      expect(c.count).toBe(0);
      expect(c.slot).toBeNull();
    }
    expect(s.pool.stats().inUse).toBe(0);
  }, 90000);
});

describe('ChunkStreamer — pooling while flying (functional)', () => {
  it('moving the camera 50 km in steps keeps the pool and chunk count bounded, with no leaks', () => {
    const s = setup({ maxCellsPerFrame: 64 });
    let maxChunks = 0;
    let maxCreated = 0;
    for (let x = 0; x <= 50000; x += 150) {
      s.streamer.update(x, x * 0.3);
      s.streamer.update(x, x * 0.3);
      maxChunks = Math.max(maxChunks, s.streamer.chunks.size);
      maxCreated = Math.max(maxCreated, s.pool.stats().created);
      const withSlot = [...s.streamer.chunks.values()].filter((c) => c.slot !== null).length;
      expect(s.pool.stats().inUse).toBe(withSlot);
    }
    // chunks within 1.5 km (+ hysteresis) of the camera: bounded by the disc area
    const bound = Math.ceil(((1500 + 512) * 2) / 512 + 1) ** 2;
    expect(maxChunks).toBeLessThanOrEqual(bound);
    expect(maxCreated).toBeLessThanOrEqual(bound + 5 * 6);
    expect(s.evicted).toBeGreaterThan(50);
    s.streamer.dispose();
    expect(s.pool.stats().inUse).toBe(0);
  }, 90000);

  it('hysteresis: jittering back and forth over a chunk border does not churn chunks', () => {
    const s = setup();
    runUntilIdle(s, 511, 0);
    const evicted0 = s.evicted;
    for (let i = 0; i < 200; i++) s.streamer.update(i % 2 ? 505 : 519, 0);
    expect(s.evicted).toBe(evicted0);
  }, 90000);

  it('fuzz: for any path, live chunks all lie within range + margin and inUse = chunks holding a slot', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.double({ min: -3000, max: 3000, noNaN: true }), fc.double({ min: -3000, max: 3000, noNaN: true })), { minLength: 1, maxLength: 25 }), (path) => {
        const s = setup({ maxCellsPerFrame: 8, urgentCellsPerFrame: 16 });
        let x = 0;
        let z = 0;
        for (const [dx, dz] of path) {
          x += dx;
          z += dz;
          s.streamer.update(x, z);
          for (const c of s.streamer.chunks.values()) expect(c.dist).toBeLessThanOrEqual(1500 + 512 + 1e-6);
          const withSlot = [...s.streamer.chunks.values()].filter((c) => c.slot !== null).length;
          expect(s.pool.stats().inUse).toBe(withSlot);
        }
        s.streamer.dispose();
        expect(s.pool.stats().inUse).toBe(0);
      }),
      { numRuns: 25 },
    );
  }, 90000);
});
