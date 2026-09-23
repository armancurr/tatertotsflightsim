/**
 * Time-sliced start-up work (PURE): long builds are written as generators that
 * `yield` between small steps; `slicedJob` runs as many steps as fit in a
 * frame's budget, so no frame ever stalls (the sea plan's route validation
 * alone is ~130 ms of heightfield lookups). `drain` runs a job to completion
 * synchronously (tests, workers).
 */

export type Job<T> = Generator<void, T, void>;

export function drain<T>(job: Job<T>): T {
  for (;;) {
    const r = job.next();
    if (r.done) return r.value;
  }
}

export interface SlicedJob<T> {
  /** Runs steps until `budgetMs` is spent or the job ends; true when done. */
  step(budgetMs: number): boolean;
  readonly done: boolean;
  /** The result (once done). */
  readonly value: T | undefined;
  /** Steps run so far, and the longest single step (ms). */
  readonly steps: number;
  readonly maxStepMs: number;
}

const defaultNow = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function slicedJob<T>(job: Job<T>, now: () => number = defaultNow): SlicedJob<T> {
  let done = false;
  let value: T | undefined;
  let steps = 0;
  let maxStepMs = 0;
  return {
    step(budgetMs) {
      if (done) return true;
      const t0 = now();
      let t = t0;
      do {
        const r = job.next();
        const t1 = now();
        maxStepMs = Math.max(maxStepMs, t1 - t);
        t = t1;
        steps++;
        if (r.done) {
          done = true;
          value = r.value;
          return true;
        }
      } while (t - t0 < budgetMs);
      return false;
    },
    get done() {
      return done;
    },
    get value() {
      return value;
    },
    get steps() {
      return steps;
    },
    get maxStepMs() {
      return maxStepMs;
    },
  };
}

/** Chains jobs: runs `a`, then `b(resultOfA)`. */
export function* chain<A, B>(a: Job<A>, b: (v: A) => Job<B>): Job<B> {
  const va = yield* a;
  return yield* b(va);
}
