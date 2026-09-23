/**
 * PURE pool of gun rounds in flight: preallocated struct-of-arrays storage, a dense list of the
 * live slots (`idx[0..count)`, O(1) removal by slot) and a free list. No allocation after
 * construction. When full, `spawn()` returns −1 (the round is simply not simulated).
 */

/** Round flags. */
export const ROUND_TRACER = 1;
export const ROUND_HEI = 2;
/** Glanced off armour: harmless, flies on briefly (still drawn if it is a tracer). */
export const ROUND_RICOCHET = 4;

export class RoundPool {
  readonly capacity: number;
  /** Live rounds; their slots are idx[0..count). */
  count = 0;
  readonly idx: Int32Array;
  readonly x: Float64Array; readonly y: Float64Array; readonly z: Float64Array;
  readonly vx: Float64Array; readonly vy: Float64Array; readonly vz: Float64Array;
  /** Time of flight, s. */
  readonly age: Float64Array;
  /** Time of flight at which the terrain must next be checked (clearance scheduling), s. */
  readonly nextCheck: Float64Array;
  readonly flags: Uint8Array;
  /** Dense index of each slot (−1 = free). */
  private readonly where: Int32Array;
  private readonly free: Int32Array;
  private freeTop = 0;

  constructor(capacity: number) {
    const n = Math.max(1, Math.floor(Number.isFinite(capacity) ? capacity : 1));
    this.capacity = n;
    this.idx = new Int32Array(n);
    this.x = new Float64Array(n); this.y = new Float64Array(n); this.z = new Float64Array(n);
    this.vx = new Float64Array(n); this.vy = new Float64Array(n); this.vz = new Float64Array(n);
    this.age = new Float64Array(n);
    this.nextCheck = new Float64Array(n);
    this.flags = new Uint8Array(n);
    this.where = new Int32Array(n);
    this.free = new Int32Array(n);
    this.clear();
  }

  clear(): void {
    this.count = 0;
    this.freeTop = 0;
    this.where.fill(-1);
    for (let i = this.capacity - 1; i >= 0; i--) this.free[this.freeTop++] = i;
  }

  /** A fresh slot (fields zeroed), or −1 when the pool is full. */
  spawn(): number {
    if (this.freeTop === 0) return -1;
    const s = this.free[--this.freeTop];
    this.where[s] = this.count;
    this.idx[this.count++] = s;
    this.x[s] = this.y[s] = this.z[s] = 0;
    this.vx[s] = this.vy[s] = this.vz[s] = 0;
    this.age[s] = 0;
    this.nextCheck[s] = 0;
    this.flags[s] = 0;
    return s;
  }

  /** Free a slot (no-op if it is not live). */
  remove(slot: number): void {
    const k = slot >= 0 && slot < this.capacity ? this.where[slot] : -1;
    if (k < 0) return;
    this.removeAt(k);
  }

  /** Free the round at dense index k (the last live round moves into k). */
  removeAt(k: number): void {
    if (k < 0 || k >= this.count) return;
    const s = this.idx[k];
    const last = this.idx[--this.count];
    this.idx[k] = last;
    this.where[last] = k;
    this.where[s] = -1;
    this.free[this.freeTop++] = s;
  }

  alive(slot: number): boolean {
    return slot >= 0 && slot < this.capacity && this.where[slot] >= 0;
  }
}
