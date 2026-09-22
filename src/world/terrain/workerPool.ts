/**
 * A small pool of terrain-builder Web Workers with a priority queue. Jobs not
 * yet dispatched can be cancelled (tiles the camera no longer needs). Where
 * Workers are unavailable (node, old browsers) jobs are built on the calling
 * thread, one per pump(), so nothing breaks.
 */
import type { ChunkData, ChunkRequest } from './chunk';

export type ChunkDone = (id: number, data: ChunkData) => void;

interface Job {
  id: number;
  req: ChunkRequest;
  priority: number;
}

interface Slot {
  worker: Worker;
  inFlight: number;
}

export class ChunkBuilderPool {
  private queue: Job[] = [];
  private queued = new Map<number, Job>();
  private slots: Slot[] = [];
  private inFlight = 0;
  private readonly maxPerWorker = 2;
  private dirty = false;
  private disposed = false;

  constructor(
    workerCount: number,
    private readonly onDone: ChunkDone,
    private readonly fallback?: (req: ChunkRequest) => ChunkData,
  ) {
    if (typeof Worker !== 'undefined') {
      for (let i = 0; i < workerCount; i++) {
        try {
          const worker = new Worker(new URL('./terrainWorker.ts', import.meta.url), { type: 'module' });
          const slot: Slot = { worker, inFlight: 0 };
          worker.onmessage = (e: MessageEvent) => {
            const m = e.data;
            if (m?.type !== 'built') return;
            slot.inFlight--;
            this.inFlight--;
            if (!this.disposed) this.onDone(m.id, m.chunk as ChunkData);
            this.pump();
          };
          worker.onerror = (err) => console.error('terrain worker error', err.message);
          worker.postMessage({ type: 'warmup' });
          this.slots.push(slot);
        } catch (err) {
          console.warn('terrain: workers unavailable, building on the main thread', err);
          break;
        }
      }
    }
  }

  get usingWorkers(): boolean {
    return this.slots.length > 0;
  }

  /** Jobs queued + in flight. */
  get pending(): number {
    return this.queue.length + this.inFlight;
  }

  submit(id: number, req: ChunkRequest, priority: number): void {
    const existing = this.queued.get(id);
    if (existing) {
      existing.priority = priority;
      this.dirty = true;
      return;
    }
    const job = { id, req, priority };
    this.queue.push(job);
    this.queued.set(id, job);
    this.dirty = true;
  }

  /** Updates the priority of a queued job (no-op if already dispatched). */
  reprioritize(id: number, priority: number): void {
    const j = this.queued.get(id);
    if (j && j.priority !== priority) {
      j.priority = priority;
      this.dirty = true;
    }
  }

  /** Cancels a job that hasn't been dispatched yet. Returns false if it's already running/done. */
  cancel(id: number): boolean {
    const j = this.queued.get(id);
    if (!j) return false;
    this.queued.delete(id);
    const i = this.queue.indexOf(j);
    if (i >= 0) this.queue.splice(i, 1);
    return true;
  }

  isQueued(id: number): boolean {
    return this.queued.has(id);
  }

  /** Dispatches queued jobs (highest priority = lowest value first). */
  pump(): void {
    if (this.disposed || this.queue.length === 0) return;
    if (this.dirty) {
      this.queue.sort((a, b) => b.priority - a.priority); // pop() from the end = smallest
      this.dirty = false;
    }
    if (this.slots.length === 0) {
      const job = this.queue.pop()!;
      this.queued.delete(job.id);
      if (this.fallback) this.onDone(job.id, this.fallback(job.req));
      return;
    }
    for (const slot of this.slots) {
      while (slot.inFlight < this.maxPerWorker && this.queue.length > 0) {
        const job = this.queue.pop()!;
        this.queued.delete(job.id);
        slot.inFlight++;
        this.inFlight++;
        slot.worker.postMessage({ type: 'build', id: job.id, ...job.req });
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const s of this.slots) s.worker.terminate();
    this.slots = [];
    this.queue = [];
    this.queued.clear();
    this.inFlight = 0;
  }
}
