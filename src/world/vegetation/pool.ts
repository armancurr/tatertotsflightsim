/**
 * Object pool with size classes: preallocated buffers are handed out by
 * capacity and returned when a chunk scrolls out of range, so streaming reuses
 * memory instead of allocating. The idle list per class is capped (surplus is
 * disposed), so the pool can never grow without bound. PURE (generic).
 */

export interface PoolHandle<T> {
  readonly value: T;
  readonly capacity: number;
  /** @internal */
  readonly cls: number;
  /** @internal */
  live: boolean;
}

export interface PoolStats {
  /** Items currently allocated (in use + idle). */
  created: number;
  inUse: number;
  free: number;
}

/** Geometric capacity classes up to `max` (max/32, max/8, max/4, max/2, max). */
export function sizeClasses(max: number): number[] {
  const m = Math.max(1, Math.ceil(max));
  const out: number[] = [];
  for (const f of [1 / 32, 1 / 8, 1 / 4, 1 / 2, 1]) {
    const c = Math.max(1, Math.ceil(m * f));
    if (out.length === 0 || c > out[out.length - 1]) out.push(c);
  }
  return out;
}

export class SizeClassPool<T> {
  private readonly classes: number[];
  private readonly freeLists: PoolHandle<T>[][];
  private inUse = 0;
  private created = 0;

  constructor(
    classes: number[],
    private readonly factory: (capacity: number) => T,
    private readonly disposeItem?: (item: T) => void,
    private readonly maxFreePerClass = 8,
  ) {
    this.classes = [...classes].sort((a, b) => a - b);
    this.freeLists = this.classes.map(() => []);
  }

  /** A handle with capacity ≥ n, or null when n exceeds the largest class. */
  acquire(n: number): PoolHandle<T> | null {
    let cls = 0;
    while (cls < this.classes.length && this.classes[cls] < n) cls++;
    if (cls >= this.classes.length) return null;
    const free = this.freeLists[cls];
    let h = free.pop();
    if (!h) {
      h = { value: this.factory(this.classes[cls]), capacity: this.classes[cls], cls, live: false };
      this.created++;
    }
    h.live = true;
    this.inUse++;
    return h;
  }

  release(h: PoolHandle<T>): void {
    if (!h.live) return;
    h.live = false;
    this.inUse--;
    const free = this.freeLists[h.cls];
    if (free.length < this.maxFreePerClass) free.push(h);
    else {
      this.created--;
      this.disposeItem?.(h.value);
    }
  }

  stats(): PoolStats {
    let free = 0;
    for (const l of this.freeLists) free += l.length;
    return { created: this.created, inUse: this.inUse, free };
  }

  /** Disposes every idle item (live handles stay valid until released). */
  dispose(): void {
    for (const l of this.freeLists) {
      for (const h of l) this.disposeItem?.(h.value);
      this.created -= l.length;
      l.length = 0;
    }
  }
}
