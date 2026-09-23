/**
 * PURE pool of glowing streaks — the sparks thrown off by 30 mm rounds hitting armour or pavement,
 * and ricochets glancing off a hull. Each one is a hot point moving fast; the renderer draws it as a
 * short motion-blurred line from where it was a moment ago to where it is (camera-facing ribbon).
 * Gravity, air drag, one bounce off the ground, cooling. Struct-of-arrays, preallocated, oldest
 * recycled when full; step() allocates nothing.
 */
const clampF = (v: number, lo: number, hi: number, d: number) => (Number.isFinite(v) ? (v < lo ? lo : v > hi ? hi : v) : d);

export class StreakPool {
  readonly capacity: number;
  count = 0;
  readonly alive: Uint8Array;
  readonly px: Float32Array; readonly py: Float32Array; readonly pz: Float32Array;
  readonly vx: Float32Array; readonly vy: Float32Array; readonly vz: Float32Array;
  readonly age: Float32Array; readonly life: Float32Array;
  /** Line width, m. */
  readonly width: Float32Array;
  readonly heat: Float32Array; readonly heatTau: Float32Array;
  readonly gravity: Float32Array; readonly drag: Float32Array;
  /** Has bounced off the ground once (the next touch kills it). */
  readonly bounced: Uint8Array;
  private readonly serial: Float64Array;
  private nextSerial = 0;

  constructor(capacity: number) {
    const n = Math.max(1, Math.floor(Number.isFinite(capacity) ? capacity : 1));
    this.capacity = n;
    const f = () => new Float32Array(n);
    this.alive = new Uint8Array(n);
    this.px = f(); this.py = f(); this.pz = f();
    this.vx = f(); this.vy = f(); this.vz = f();
    this.age = f(); this.life = f(); this.width = f();
    this.heat = f(); this.heatTau = f(); this.gravity = f(); this.drag = f();
    this.bounced = new Uint8Array(n);
    this.serial = new Float64Array(n);
  }

  clear(): void {
    this.alive.fill(0);
    this.count = 0;
  }

  /** Spawn a streak (values sanitised); the oldest is recycled when full. Returns its slot. */
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, width: number, heat: number, heatTau: number, gravity: number, drag: number): number {
    let i = -1;
    if (this.count < this.capacity) {
      for (let k = 0; k < this.capacity; k++) {
        if (!this.alive[k]) {
          i = k;
          break;
        }
      }
    }
    if (i < 0) {
      let best = Infinity;
      i = 0;
      for (let k = 0; k < this.capacity; k++) {
        if (this.serial[k] < best) {
          best = this.serial[k];
          i = k;
        }
      }
    } else {
      this.count++;
    }
    this.alive[i] = 1;
    this.serial[i] = this.nextSerial++;
    this.px[i] = clampF(x, -1e7, 1e7, 0);
    this.py[i] = clampF(y, -1e7, 1e7, 0);
    this.pz[i] = clampF(z, -1e7, 1e7, 0);
    this.vx[i] = clampF(vx, -3000, 3000, 0);
    this.vy[i] = clampF(vy, -3000, 3000, 0);
    this.vz[i] = clampF(vz, -3000, 3000, 0);
    this.age[i] = 0;
    this.life[i] = clampF(life, 1e-3, 30, 0.5);
    this.width[i] = clampF(width, 0.001, 5, 0.05);
    this.heat[i] = clampF(heat, 0, 3, 1);
    this.heatTau[i] = clampF(heatTau, 1e-3, 100, 0.5);
    this.gravity[i] = clampF(gravity, -100, 100, 0);
    this.drag[i] = clampF(drag, 0, 50, 0);
    this.bounced[i] = 0;
    return i;
  }

  /** Current incandescence (0 = cold). */
  heatOf(i: number): number {
    const h = this.heat[i] * Math.exp(-this.age[i] / this.heatTau[i]);
    return Number.isFinite(h) && h > 0 ? h : 0;
  }

  /** Advance by dt (s); `groundY` is the ground height under the streaks (one value: they stay near their impact). */
  step(dtIn: number, groundY: number): void {
    if (!(dtIn > 0) || !Number.isFinite(dtIn)) return;
    const dt = Math.min(dtIn, 0.1);
    const g = Number.isFinite(groundY) ? groundY : -1e9;
    for (let i = 0; i < this.capacity; i++) {
      if (!this.alive[i]) continue;
      const age = this.age[i] + dt;
      this.age[i] = age;
      if (age >= this.life[i]) {
        this.alive[i] = 0;
        this.count--;
        continue;
      }
      const k = Math.exp(-this.drag[i] * dt);
      let vx = this.vx[i] * k;
      let vy = this.vy[i] * k - this.gravity[i] * dt;
      let vz = this.vz[i] * k;
      const x = this.px[i] + vx * dt;
      let y = this.py[i] + vy * dt;
      const z = this.pz[i] + vz * dt;
      if (y < g && vy < 0) {
        if (this.bounced[i]) {
          this.alive[i] = 0;
          this.count--;
          continue;
        }
        this.bounced[i] = 1;
        y = g + 0.01;
        vy = -vy * 0.3;
        vx *= 0.5;
        vz *= 0.5;
      }
      if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) && Number.isFinite(vx) && Number.isFinite(vy) && Number.isFinite(vz))) {
        this.alive[i] = 0;
        this.count--;
        continue;
      }
      this.px[i] = x; this.py[i] = y; this.pz[i] = z;
      this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    }
  }
}
