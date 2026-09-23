import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { drain, slicedJob, chain, type Job } from '../../../src/world/traffic/jobs';
import { getHeightfield } from '../../../src/world/heightfield';
import { getLayout } from '../../../src/world/layout';
import { createSeaPlan, seaPlanJob, type WaterWorld } from '../../../src/world/traffic/sea';

function* count(n: number): Job<number> {
  let s = 0;
  for (let i = 0; i < n; i++) {
    s += i;
    yield;
  }
  return s;
}

describe('time-sliced jobs', () => {
  it('drain runs a job to completion', () => {
    expect(drain(count(10))).toBe(45);
    expect(drain(chain(count(4), (v) => count(v)))).toBe(15);
  });

  it('a sliced job stops at the budget and resumes', () => {
    // each step "takes" 1 ms on a fake clock
    let clock = 0;
    let calls = 0;
    const tick = () => {
      calls++;
      clock += 1;
    };
    const job = slicedJob((function* () {
      for (let i = 0; i < 50; i++) {
        tick();
        yield;
      }
      return 'ok';
    })(), () => clock);
    expect(job.step(10)).toBe(false);
    expect(calls).toBeGreaterThanOrEqual(10);
    expect(calls).toBeLessThanOrEqual(11);
    while (!job.step(10));
    expect(job.done).toBe(true);
    expect(job.value).toBe('ok');
    expect(job.maxStepMs).toBeLessThanOrEqual(1);
    expect(job.steps).toBe(51);
  });

  it('fuzz: any budget sequence completes with the same result', () => {
    fc.assert(
      fc.property(fc.array(fc.double({ min: 0, max: 5, noNaN: true }), { minLength: 1, maxLength: 30 }), fc.integer({ min: 0, max: 60 }), (budgets, n) => {
        let clock = 0;
        const job = slicedJob((function* () {
          let s = 0;
          for (let i = 0; i < n; i++) {
            clock += 0.5;
            s += i;
            yield;
          }
          return s;
        })(), () => clock);
        let k = 0;
        while (!job.step(budgets[k++ % budgets.length]) && k < 10000);
        expect(job.value).toBe((n * (n - 1)) / 2 + 0);
      }),
      { numRuns: 100 },
    );
  });
});

describe('the sea plan builds in small steps', () => {
  it('same plan as the one-shot build; no step does more than ~2,500 water lookups', () => {
    const hf = getHeightfield();
    let lookups = 0;
    let maxPerStep = 0;
    const water: WaterWorld = {
      groundHeight: (x, z) => (lookups++, hf.height(x, z)),
      waterLevel: (x, z) => (lookups++, hf.waterLevel(x, z)),
    };
    const job = seaPlanJob(getLayout(), water);
    let steps = 0;
    let plan;
    for (;;) {
      lookups = 0;
      const r = job.next();
      steps++;
      maxPerStep = Math.max(maxPerStep, lookups);
      if (r.done) {
        plan = r.value;
        break;
      }
    }
    expect(steps).toBeGreaterThan(20);
    expect(maxPerStep).toBeLessThanOrEqual(2500);
    const ref = createSeaPlan(getLayout(), { groundHeight: (x, z) => hf.height(x, z), waterLevel: (x, z) => hf.waterLevel(x, z) });
    expect(plan.routes.map((r) => r.id)).toEqual(ref.routes.map((r) => r.id));
    expect(plan.rejected).toEqual(ref.rejected);
    expect(plan.marina.berths.length).toBe(ref.marina.berths.length);
    expect(plan.terminals).toHaveLength(2);
  }, 60_000);
});
