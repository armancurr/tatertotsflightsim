/**
 * Time-sliced background work for the renderer (pure; no DOM needed).
 *
 * A job is a generator that does a small unit of work (≈0.5–2 ms) between
 * `yield`s. `step(budgetMs)` advances the jobs in FIFO order until the budget
 * is spent, so heavy start-up generation (3D noise volumes, the cloud weather
 * map, blue noise) never produces a long frame. `startIdleLoop()` also drives
 * the queue from macrotasks between frames (setTimeout), so the work mostly
 * finishes while the app is still awaiting terrain streaming at start-up.
 */

export interface JobQueueOptions {
  /** Clock in ms (default performance.now). */
  now?: () => number;
  /** Called when a job throws; the job is dropped. */
  onError?: (name: string, err: unknown) => void;
}

export interface JobQueue {
  /** Queue a job; `onDone` receives the generator's return value. */
  add<T>(name: string, job: Generator<unknown, T, void>, onDone?: (result: T) => void): void;
  /** Advance jobs until `budgetMs` is spent. Returns true when the queue is empty. */
  step(budgetMs: number): boolean;
  readonly pending: number;
  /** Name of the job currently at the head, or null. */
  readonly current: string | null;
  /** Resolves when the queue is (or next becomes) empty. */
  whenIdle(): Promise<void>;
  /** Drive the queue from setTimeout macrotasks with `budgetMs` per slice until empty. */
  startIdleLoop(budgetMs: number): void;
  dispose(): void;
}

interface Entry {
  name: string;
  job: Generator<unknown, unknown, void>;
  onDone?: (r: unknown) => void;
}

export function createJobQueue(opts: JobQueueOptions = {}): JobQueue {
  const now = opts.now ?? (() => performance.now());
  const queue: Entry[] = [];
  let idleWaiters: Array<() => void> = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function drained() {
    if (queue.length > 0) return;
    const w = idleWaiters;
    idleWaiters = [];
    for (const f of w) f();
  }

  function step(budgetMs: number): boolean {
    const t0 = now();
    while (queue.length > 0 && now() - t0 < budgetMs) {
      const e = queue[0];
      let r: IteratorResult<unknown, unknown>;
      try {
        r = e.job.next();
      } catch (err) {
        queue.shift();
        opts.onError?.(e.name, err);
        continue;
      }
      if (r.done) {
        queue.shift();
        e.onDone?.(r.value);
      }
    }
    drained();
    return queue.length === 0;
  }

  function startIdleLoop(budgetMs: number) {
    if (timer !== null || disposed || typeof setTimeout === 'undefined') return;
    const tick = () => {
      timer = null;
      if (disposed) return;
      if (!step(budgetMs)) timer = setTimeout(tick, 0);
    };
    timer = setTimeout(tick, 0);
  }

  return {
    add(name, job, onDone) {
      queue.push({ name, job, onDone: onDone as ((r: unknown) => void) | undefined });
    },
    step,
    get pending() {
      return queue.length;
    },
    get current() {
      return queue.length > 0 ? queue[0].name : null;
    },
    whenIdle() {
      if (queue.length === 0) return Promise.resolve();
      return new Promise<void>((res) => idleWaiters.push(res));
    },
    startIdleLoop,
    dispose() {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      queue.length = 0;
      drained();
    },
  };
}

export interface StagedTask {
  /** (Re)start from the first stage. */
  start(): void;
  /** Run the next stage (if running). Returns true when this step ran the last stage. */
  step(): boolean;
  /** Restart and run every stage now. */
  runAll(): void;
  readonly busy: boolean;
  /** Index of the next stage to run (0 when idle). */
  readonly stage: number;
}

/**
 * A fixed sequence of GPU/CPU stages run one per frame (e.g. the environment
 * re-bake: cube faces, then the PMREM filter), so no single frame pays for all
 * of it. `start()` during a run restarts it (newer inputs supersede).
 */
export function createStagedTask(stages: Array<() => void>): StagedTask {
  let next = 0;
  let running = false;
  function step(): boolean {
    if (!running) return false;
    stages[next]();
    next++;
    if (next >= stages.length) {
      running = false;
      next = 0;
      return true;
    }
    return false;
  }
  return {
    start() {
      running = stages.length > 0;
      next = 0;
    },
    step,
    runAll() {
      running = stages.length > 0;
      next = 0;
      while (running) step();
    },
    get busy() {
      return running;
    },
    get stage() {
      return next;
    },
  };
}
