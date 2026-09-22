/**
 * Time-sliced job queue (jobQueue.ts): generators advance until the per-step
 * budget is spent, in FIFO order, and completion callbacks fire once.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createJobQueue } from '../../src/render/jobQueue';

/** A fake clock that advances by `cost` ms every time a job does one unit of work. */
function fakeClock() {
  let t = 0;
  return { now: () => t, spend: (ms: number) => (t += ms) };
}

function* work(clock: ReturnType<typeof fakeClock>, units: number, cost: number, log?: number[], id = 0) {
  for (let i = 0; i < units; i++) {
    clock.spend(cost);
    log?.push(id);
    yield;
  }
  return units;
}

describe('job queue', () => {
  it('runs units until the budget is spent, then stops (never more than one unit over)', () => {
    const c = fakeClock();
    const q = createJobQueue({ now: c.now });
    q.add('a', work(c, 100, 1));
    const t0 = c.now();
    q.step(4);
    // units of 1 ms: stops once ≥ 4 ms spent
    expect(c.now() - t0).toBe(4);
    expect(q.pending).toBe(1);
  });
  it('runs jobs in FIFO order and calls onDone once with the generator result', () => {
    const c = fakeClock();
    const q = createJobQueue({ now: c.now });
    const log: number[] = [];
    const done: Array<[string, unknown]> = [];
    q.add('a', work(c, 3, 1, log, 1), (r) => done.push(['a', r]));
    q.add('b', work(c, 2, 1, log, 2), (r) => done.push(['b', r]));
    while (q.pending > 0) q.step(2);
    expect(log).toEqual([1, 1, 1, 2, 2]);
    expect(done).toEqual([
      ['a', 3],
      ['b', 2],
    ]);
    expect(q.step(2)).toBe(true);
  });
  it('property: any mix of jobs finishes; no step exceeds budget + one unit', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ units: fc.integer({ min: 0, max: 30 }), cost: fc.double({ min: 0.05, max: 3, noNaN: true }) }), { maxLength: 6 }),
        fc.double({ min: 0.5, max: 8, noNaN: true }),
        (jobs, budget) => {
          const c = fakeClock();
          const q = createJobQueue({ now: c.now });
          let finished = 0;
          for (const j of jobs) q.add('j', work(c, j.units, j.cost), () => finished++);
          const maxCost = Math.max(0, ...jobs.map((j) => j.cost));
          let steps = 0;
          while (q.pending > 0 && steps < 10000) {
            const t0 = c.now();
            q.step(budget);
            expect(c.now() - t0).toBeLessThanOrEqual(budget + maxCost + 1e-9);
            steps++;
          }
          expect(finished).toBe(jobs.length);
        },
      ),
    );
  });
  it('a throwing job is dropped and reported; later jobs still run', () => {
    const c = fakeClock();
    const errors: string[] = [];
    const q = createJobQueue({ now: c.now, onError: (name) => errors.push(name) });
    function* bad(): Generator<void, void, void> {
      yield;
      throw new Error('boom');
    }
    let ok = false;
    q.add('bad', bad());
    q.add('good', work(c, 1, 1), () => (ok = true));
    for (let i = 0; i < 5; i++) q.step(10);
    expect(errors).toEqual(['bad']);
    expect(ok).toBe(true);
  });
  it('whenIdle resolves once the queue drains', async () => {
    const c = fakeClock();
    const q = createJobQueue({ now: c.now });
    q.add('a', work(c, 3, 1));
    const p = q.whenIdle();
    q.step(10);
    await expect(p).resolves.toBeUndefined();
  });
});

import { createStagedTask } from '../../src/render/jobQueue';

describe('staged task (env re-bake time slicing)', () => {
  it('runs exactly one stage per step and reports completion on the last', () => {
    const log: number[] = [];
    const t = createStagedTask([() => log.push(0), () => log.push(1), () => log.push(2)]);
    expect(t.busy).toBe(false);
    expect(t.step()).toBe(false); // idle: nothing runs
    t.start();
    expect(t.busy).toBe(true);
    expect(t.step()).toBe(false);
    expect(t.step()).toBe(false);
    expect(t.step()).toBe(true);
    expect(t.busy).toBe(false);
    expect(log).toEqual([0, 1, 2]);
  });
  it('restarting mid-way starts again from the first stage (a newer altitude supersedes the old bake)', () => {
    const log: number[] = [];
    const t = createStagedTask([() => log.push(0), () => log.push(1), () => log.push(2)]);
    t.start();
    t.step();
    t.step();
    t.start();
    while (!t.step());
    expect(log).toEqual([0, 1, 0, 1, 2]);
  });
  it('runAll completes synchronously (time-of-day change)', () => {
    const log: number[] = [];
    const t = createStagedTask([() => log.push(0), () => log.push(1)]);
    t.start();
    t.step();
    t.runAll();
    expect(log).toEqual([0, 0, 1]);
    expect(t.busy).toBe(false);
  });
  it('property: for any number of stages and restart pattern, a full run executes every stage in order once', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10 }), fc.array(fc.boolean(), { maxLength: 40 }), (n, restarts) => {
        const log: number[] = [];
        const t = createStagedTask(Array.from({ length: n }, (_, i) => () => log.push(i)));
        t.start();
        let lastRun: number[] = [];
        for (const r of restarts) {
          if (r) {
            t.start();
            lastRun = [];
          }
          const before = log.length;
          const done = t.step();
          if (log.length > before) lastRun.push(log[log.length - 1]);
          if (done) {
            expect(lastRun).toEqual(Array.from({ length: n }, (_, i) => i));
            lastRun = [];
          }
        }
      }),
    );
  });
});
