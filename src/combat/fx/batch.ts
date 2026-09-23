/**
 * PURE per-frame impact batch: the impacts that arrived since the last frame, at most `capacity`
 * of them (CONFIG.combat.maxImpactFxPerFrame). When full, a new impact is merged into the nearest
 * slot of the same class (else the nearest slot) whose weight grows — a merged impact plays a
 * bigger effect instead of many small ones. Struct-of-arrays, preallocated, never reallocated.
 */
export class ImpactBatch {
  readonly capacity: number;
  count = 0;
  /** Every impact added since clear() (merged ones included). */
  total = 0;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  readonly weight: Float32Array;
  /** CLASS_CODE of the impact (see plan.ts). */
  readonly cls: Uint8Array;
  readonly ricochet: Uint8Array;
  /** Target id (−1 = none). */
  readonly target: Int32Array;
  /** Surface code (index into SURFACES in sim.ts, for dust colours). */
  readonly surface: Uint8Array;

  constructor(capacity: number) {
    const n = Math.max(1, Math.floor(Number.isFinite(capacity) ? capacity : 1));
    this.capacity = n;
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.z = new Float32Array(n);
    this.weight = new Float32Array(n);
    this.cls = new Uint8Array(n);
    this.ricochet = new Uint8Array(n);
    this.target = new Int32Array(n);
    this.surface = new Uint8Array(n);
  }

  clear(): void {
    this.count = 0;
    this.total = 0;
  }

  /** Add one impact; returns the slot it went to (−1 if ignored). */
  add(x: number, y: number, z: number, cls: number, ricochet: boolean, target: number, surface = 0): number {
    if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) return -1;
    this.total++;
    if (this.count < this.capacity) {
      const i = this.count++;
      this.x[i] = x;
      this.y[i] = y;
      this.z[i] = z;
      this.weight[i] = 1;
      this.cls[i] = cls;
      this.ricochet[i] = ricochet ? 1 : 0;
      this.target[i] = Number.isFinite(target) ? target : -1;
      this.surface[i] = surface;
      return i;
    }
    // Full: merge into the nearest slot of the same class, else the nearest slot.
    let best = -1;
    let bestD = Infinity;
    let any = 0;
    let anyD = Infinity;
    for (let i = 0; i < this.count; i++) {
      const dx = this.x[i] - x, dy = this.y[i] - y, dz = this.z[i] - z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < anyD) {
        anyD = d;
        any = i;
      }
      if (this.cls[i] === cls && d < bestD) {
        bestD = d;
        best = i;
      }
    }
    const i = best >= 0 ? best : any;
    this.weight[i] += 1;
    if (ricochet) this.ricochet[i] = 1;
    return i;
  }
}
