/**
 * Terrain worker pool resilience: a worker that fails (its script 404s behind a misconfigured host,
 * module workers unsupported, a crash) must not strand its tiles — they go back to the queue and are
 * built by the remaining workers, or on the main thread when none is left. Before, the world stayed a
 * grey void with every tile pending forever.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChunkBuilderPool } from '../../../src/world/terrain/workerPool';
import type { ChunkData, ChunkRequest } from '../../../src/world/terrain/chunk';

class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  posted: { type: string; id?: number }[] = [];
  terminated = false;
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(m: { type: string; id?: number }) {
    this.posted.push(m);
  }
  terminate() {
    this.terminated = true;
  }
  fail() {
    this.onerror?.({ message: 'failed to load' } as ErrorEvent);
  }
  finish(id: number) {
    this.onmessage?.({ data: { type: 'built', id, chunk: { id } } } as MessageEvent);
  }
  builds() {
    return this.posted.filter((m) => m.type === 'build').map((m) => m.id!);
  }
}

const g = globalThis as unknown as { Worker?: unknown };
let saved: unknown;
beforeEach(() => {
  saved = g.Worker;
  g.Worker = FakeWorker;
  FakeWorker.all = [];
});
afterEach(() => {
  g.Worker = saved;
});

const req = {} as ChunkRequest;

function pool(workers: number) {
  const done: number[] = [];
  let mainThread = 0;
  const p = new ChunkBuilderPool(workers, (id) => done.push(id), () => {
    mainThread++;
    return {} as ChunkData;
  });
  return { p, done, main: () => mainThread };
}

describe('terrain worker pool: failing workers', () => {
  it('a failed worker hands its in-flight tiles to the surviving worker', () => {
    const { p, done } = pool(2);
    for (let i = 1; i <= 4; i++) p.submit(i, req, i);
    p.pump();
    const [a, b] = FakeWorker.all;
    const lost = a.builds();
    expect(lost.length).toBeGreaterThan(0);
    a.fail();
    expect(a.terminated).toBe(true);
    for (const id of b.builds()) b.finish(id);
    p.pump();
    for (const id of b.builds()) if (!done.includes(id)) b.finish(id);
    expect(done.sort()).toEqual([1, 2, 3, 4]);
    expect(p.pending).toBe(0);
  });

  it('when every worker fails, the tiles are built on the main thread', () => {
    const { p, done, main } = pool(2);
    for (let i = 1; i <= 5; i++) p.submit(i, req, i);
    p.pump();
    for (const w of FakeWorker.all) w.fail();
    expect(p.usingWorkers).toBe(false);
    for (let i = 0; i < 10 && p.pending > 0; i++) p.pump();
    expect(done.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(main()).toBe(5);
  });

  it('a late message from a failed worker does not complete a tile twice', () => {
    const { p, done } = pool(1);
    p.submit(7, req, 1);
    p.pump();
    const [a] = FakeWorker.all;
    a.fail();
    a.finish(7);
    p.pump();
    expect(done).toEqual([7]);
    expect(p.pending).toBe(0);
  });
});
