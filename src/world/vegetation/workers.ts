/**
 * A small pool of vegetation Web Workers with a priority queue, shared by the
 * trees (chunks) and the grass (cells). Jobs not yet dispatched can be
 * cancelled or re-prioritised. Each worker runs one job at a time (jobs are
 * whole chunks, tens of ms), so cancellation stays cheap and the nearest work
 * always goes next. Main-thread cost: a sort of the (short) queue when it
 * changes, postMessage, and handing results over.
 *
 * `createVegetationWorkers` returns null where Workers are unavailable (node,
 * tests) — callers then generate inline.
 */
import type { PackedChunk } from './pack';
import type { AsyncChunkSource, ChunkJob } from './streamer';
import type { PlacementParams } from './placement';
import type { GrassCell, GrassParams } from '../grass/placement';

type Kind = 'chunk' | 'grass';

interface Job {
  kind: Kind;
  key: number;
  a: number;
  b: number;
  rankMax: number;
  priority: number;
}

interface Slot {
  worker: Worker;
  busy: Job | null;
  ready: boolean;
}

export interface GrassJobSource {
  request(key: number, cx: number, cz: number, priority: number): void;
  cancel(key: number): void;
  drain(cb: (key: number, cell: GrassCell) => void): void;
  pending(): number;
}

export interface VegetationWorkers {
  readonly trees: AsyncChunkSource;
  readonly grass: GrassJobSource;
  readonly workerCount: number;
  /** Resolves when every worker has built its world. */
  whenReady(): Promise<void>;
  dispose(): void;
}

export interface WorkerInit {
  seed: number;
  params: PlacementParams;
  cellsPerSide: number;
  grass?: GrassParams;
}

const qkey = (kind: Kind, key: number): string => kind + key;

export function createVegetationWorkers(count: number, init: WorkerInit): VegetationWorkers | null {
  if (typeof Worker === 'undefined' || count <= 0) return null;
  const slots: Slot[] = [];
  const queue: Job[] = [];
  const queued = new Map<string, Job>();
  const running = new Map<string, number>(); // kind+key → rankMax running
  const doneChunks: { key: number; p: PackedChunk }[] = [];
  const doneGrass: { key: number; cell: GrassCell }[] = [];
  let dirty = false;
  let disposed = false;
  let readyCount = 0;
  let resolveReady: (() => void) | null = null;
  const readyP = new Promise<void>((r) => (resolveReady = r));

  const pump = (): void => {
    if (disposed || queue.length === 0) return;
    if (dirty) {
      queue.sort((x, y) => y.priority - x.priority); // pop() takes the smallest
      dirty = false;
    }
    for (const s of slots) {
      if (s.busy || !s.ready || queue.length === 0) continue;
      const j = queue.pop()!;
      queued.delete(qkey(j.kind, j.key));
      running.set(qkey(j.kind, j.key), j.rankMax);
      s.busy = j;
      if (j.kind === 'chunk') s.worker.postMessage({ type: 'chunk', key: j.key, kx: j.a, kz: j.b, rankMax: j.rankMax });
      else s.worker.postMessage({ type: 'grass', key: j.key, cx: j.a, cz: j.b });
    }
  };

  for (let i = 0; i < count; i++) {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./vegetation.worker.ts', import.meta.url), { type: 'module' });
    } catch (err) {
      console.warn('vegetation: workers unavailable, generating on the main thread', err);
      break;
    }
    const slot: Slot = { worker, busy: null, ready: false };
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m?.type === 'ready') {
        slot.ready = true;
        readyCount++;
        if (readyCount === slots.length) resolveReady?.();
        pump();
        return;
      }
      const j = slot.busy;
      slot.busy = null;
      if (j) running.delete(qkey(j.kind, j.key));
      if (!disposed) {
        if (m?.type === 'chunk') doneChunks.push({ key: m.key, p: m.packed as PackedChunk });
        else if (m?.type === 'grass') doneGrass.push({ key: m.key, cell: m.cell as GrassCell });
      }
      pump();
    };
    worker.onerror = (err) => console.error('vegetation worker error', err.message);
    worker.postMessage({ type: 'init', ...init });
    slots.push(slot);
  }
  if (slots.length === 0) return null;

  const request = (kind: Kind, key: number, a: number, b: number, rankMax: number, priority: number): void => {
    const k = qkey(kind, key);
    const r = running.get(k);
    if (r !== undefined && r >= rankMax) return; // already on its way
    const q = queued.get(k);
    if (q) {
      if (Math.abs(q.priority - priority) > 32 || q.rankMax !== rankMax) {
        q.priority = priority;
        q.rankMax = Math.max(q.rankMax, rankMax);
        dirty = true;
      }
      pump();
      return;
    }
    const j: Job = { kind, key, a, b, rankMax, priority };
    queue.push(j);
    queued.set(k, j);
    dirty = true;
    pump();
  };
  const cancel = (kind: Kind, key: number): void => {
    const k = qkey(kind, key);
    const j = queued.get(k);
    if (!j) return;
    queued.delete(k);
    const i = queue.indexOf(j);
    if (i >= 0) queue.splice(i, 1);
  };
  const pendingOf = (kind: Kind): number => {
    let n = 0;
    for (const j of queue) if (j.kind === kind) n++;
    for (const s of slots) if (s.busy?.kind === kind) n++;
    return n;
  };

  const trees: AsyncChunkSource = {
    request: (job: ChunkJob) => request('chunk', job.key, job.kx, job.kz, job.rankMax, job.priority),
    cancel: (key) => cancel('chunk', key),
    drain(cb) {
      for (let i = 0; i < doneChunks.length; i++) cb(doneChunks[i].key, doneChunks[i].p);
      doneChunks.length = 0;
    },
    pending: () => pendingOf('chunk'),
  };
  const grass: GrassJobSource = {
    request: (key, cx, cz, priority) => request('grass', key, cx, cz, 1, priority),
    cancel: (key) => cancel('grass', key),
    drain(cb) {
      for (let i = 0; i < doneGrass.length; i++) cb(doneGrass[i].key, doneGrass[i].cell);
      doneGrass.length = 0;
    },
    pending: () => pendingOf('grass'),
  };

  return {
    trees,
    grass,
    workerCount: slots.length,
    whenReady: () => readyP,
    dispose() {
      disposed = true;
      for (const s of slots) s.worker.terminate();
      slots.length = 0;
      queue.length = 0;
      queued.clear();
      running.clear();
    },
  };
}

// ── shared instance (trees + grass systems use one pool) ─────────────────────

let shared: { w: VegetationWorkers; refs: number; key: string } | null = null;

/** The app-wide pool (created on first use, disposed when the last user releases it). */
export function acquireSharedWorkers(count: number, init: WorkerInit): VegetationWorkers | null {
  const key = JSON.stringify(init);
  if (shared && shared.key === key) {
    shared.refs++;
    return shared.w;
  }
  const w = createVegetationWorkers(count, init);
  if (!w) return null;
  if (!shared) shared = { w, refs: 1, key };
  return w;
}

export function releaseSharedWorkers(w: VegetationWorkers | null): void {
  if (!w) return;
  if (shared && shared.w === w) {
    if (--shared.refs > 0) return;
    shared = null;
  }
  w.dispose();
}
