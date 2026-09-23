/**
 * Dispose GPU resources a few rendered frames after the objects left the scene.
 *
 * Why: three.js shares one depth material for every shadow caster and keeps the last caster's `map`
 * in that material's uniforms (the program is not re-chosen when only `map` changes). Disposing an
 * aircraft's textures right after removing it leaves that stale reference behind; the next shadow
 * pass uploads the disposed texture again — a GPU texture leaked for good on every aircraft switch
 * (measured: +1 texture per A-10 build). After a couple of frames the new aircraft (drawn last in the
 * shadow pass) has replaced the reference, and the old textures can be freed for real.
 *
 * Frames only advance while rendering, so a hidden tab (no requestAnimationFrame) just waits.
 */
export interface DeferredDisposer {
  /** Run `fn` on the `frames`-th following call to tick() (default 2; 0 or 1 = the next one). */
  defer(fn: () => void, frames?: number): void;
  /** One rendered frame has completed. */
  tick(): void;
  /** Run everything still pending (app shutdown). */
  flush(): void;
  readonly pending: number;
}

export function createDeferredDisposer(onError: (e: unknown) => void = (e) => console.error('[dispose] failed', e)): DeferredDisposer {
  const queue: { fn: () => void; frames: number }[] = [];
  const run = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      onError(e);
    }
  };
  return {
    defer(fn, frames = 2) {
      queue.push({ fn, frames: Math.max(0, Math.floor(Number.isFinite(frames) ? frames : 2)) });
    },
    tick() {
      if (queue.length === 0) return;
      for (let i = 0; i < queue.length; ) {
        const q = queue[i];
        q.frames--;
        if (q.frames <= 0) {
          queue.splice(i, 1);
          run(q.fn);
        } else {
          i++;
        }
      }
    },
    flush() {
      while (queue.length) run(queue.shift()!.fn);
    },
    get pending() {
      return queue.length;
    },
  };
}
