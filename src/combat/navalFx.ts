/**
 * PURE effects of the naval guns (no three.js): the particles and the sea-surface rings the renderer
 * (src/combat/render/navalFxRender.ts) draws, plus the camera shake. Deterministic for a seed,
 * preallocated (the oldest particle is recycled when the pool is full), allocation-free per step.
 *
 *   water column   a 16-inch shell bursting on the sea throws a column of white water 60–100 m high
 *                  in ~3 s: a dense core, a crown spreading at the top, a spray skirt at the base; it
 *                  collapses back under gravity into a base surge of mist that rolls outward and a
 *                  cloud of spray that hangs and drifts downwind; a white foam ring spreads on the
 *                  water and fades over ~40 s (compared with photographs of Iowa-class salvos).
 *   muzzle blast   each gun: an orange-white flash tens of metres long, a fireball, then a huge
 *                  brown-grey cloud of propellant smoke rolling out along the line of fire and hanging
 *                  over the sea; the blast's pressure wave flattens the water beside the ship — a
 *                  dark ring racing outward — and whips up spray.
 *   burst          on a target / on land: a flash and black smoke (the fireball and debris are the
 *                  shared fx pool's explosion, played by the system); on a floating target also a
 *                  smaller column of water.
 *   shake          impulses that reach the camera at the speed of sound (d / 343 m/s).
 */

export const PK = { spray: 0, mist: 1, smoke: 2, flash: 3 } as const;
export type ParticleKind = (typeof PK)[keyof typeof PK];
export const RING = { foam: 0, pressure: 1 } as const;

const SOUND = 343;
const fin = (v: number, d = 0) => (Number.isFinite(v) ? v : d);

export interface NavalFxOptions {
  seed?: number;
  particles?: number;
  rings?: number;
  shakes?: number;
}

export interface ShakeImpulse {
  x: number;
  y: number;
  z: number;
  /** Emission time (s), strength at 0 m (0..1), reference distance (m). */
  t: number;
  strength: number;
  refM: number;
}

export class NavalFxSim {
  readonly cap: number;
  count = 0;
  readonly alive: Uint8Array;
  readonly kind: Uint8Array;
  readonly px: Float32Array; readonly py: Float32Array; readonly pz: Float32Array;
  readonly vx: Float32Array; readonly vy: Float32Array; readonly vz: Float32Array;
  readonly age: Float32Array; readonly life: Float32Array;
  readonly size0: Float32Array; readonly size1: Float32Array; readonly growTau: Float32Array;
  readonly drag: Float32Array; readonly gravity: Float32Array; readonly buoy: Float32Array;
  readonly alpha: Float32Array; readonly fadeIn: Float32Array; readonly fadeOut: Float32Array;
  readonly r: Float32Array; readonly g: Float32Array; readonly b: Float32Array;
  /** Emission 0..1 at birth, its decay time constant (s). */
  readonly emit: Float32Array; readonly emitTau: Float32Array;
  readonly rot: Float32Array; readonly rotRate: Float32Array; readonly seed: Float32Array;
  private readonly born: Float64Array;
  private readonly free: Int32Array;
  private freeTop = 0;
  private serial = 0;

  // rings on the sea
  readonly ringCap: number;
  ringCount = 0;
  readonly ringAlive: Uint8Array;
  readonly ringKind: Uint8Array;
  readonly ringX: Float32Array; readonly ringZ: Float32Array;
  readonly ringAge: Float32Array; readonly ringLife: Float32Array;
  readonly ringR0: Float32Array; readonly ringR1: Float32Array; readonly ringTau: Float32Array;
  readonly ringStrength: Float32Array; readonly ringSeed: Float32Array;

  private readonly shakes: ShakeImpulse[];
  private shakeNext = 0;
  private rnd: () => number;
  private seed0: number;
  time = 0;
  /** Counters for tests / stats. */
  columns = 0;
  blasts = 0;

  constructor(opts: NavalFxOptions = {}) {
    const n = Math.max(16, Math.floor(opts.particles ?? 3200));
    this.cap = n;
    const f = () => new Float32Array(n);
    this.alive = new Uint8Array(n);
    this.kind = new Uint8Array(n);
    this.px = f(); this.py = f(); this.pz = f();
    this.vx = f(); this.vy = f(); this.vz = f();
    this.age = f(); this.life = f();
    this.size0 = f(); this.size1 = f(); this.growTau = f();
    this.drag = f(); this.gravity = f(); this.buoy = f();
    this.alpha = f(); this.fadeIn = f(); this.fadeOut = f();
    this.r = f(); this.g = f(); this.b = f();
    this.emit = f(); this.emitTau = f();
    this.rot = f(); this.rotRate = f(); this.seed = f();
    this.born = new Float64Array(n);
    this.free = new Int32Array(n);
    const m = Math.max(4, Math.floor(opts.rings ?? 96));
    this.ringCap = m;
    const g = () => new Float32Array(m);
    this.ringAlive = new Uint8Array(m);
    this.ringKind = new Uint8Array(m);
    this.ringX = g(); this.ringZ = g(); this.ringAge = g(); this.ringLife = g();
    this.ringR0 = g(); this.ringR1 = g(); this.ringTau = g(); this.ringStrength = g(); this.ringSeed = g();
    this.shakes = Array.from({ length: Math.max(4, opts.shakes ?? 48) }, () => ({ x: 0, y: 0, z: 0, t: -1e9, strength: 0, refM: 1 }));
    this.seed0 = (opts.seed ?? 0x16b61) >>> 0;
    this.rnd = mulberry(this.seed0);
    this.reset();
  }

  reset(): void {
    this.alive.fill(0);
    this.count = 0;
    this.freeTop = 0;
    for (let i = this.cap - 1; i >= 0; i--) this.free[this.freeTop++] = i;
    this.ringAlive.fill(0);
    this.ringCount = 0;
    for (const s of this.shakes) {
      s.t = -1e9;
      s.strength = 0;
    }
    this.rnd = mulberry(this.seed0);
    this.time = 0;
  }

  private u(a: number, b: number): number {
    return a + (b - a) * this.rnd();
  }

  private alloc(): number {
    let i: number;
    if (this.freeTop > 0) {
      i = this.free[--this.freeTop];
      this.count++;
    } else {
      // recycle the oldest
      i = 0;
      let best = Infinity;
      for (let k = 0; k < this.cap; k++) {
        if (this.born[k] < best) {
          best = this.born[k];
          i = k;
        }
      }
    }
    this.alive[i] = 1;
    this.born[i] = this.serial++;
    return i;
  }

  /** One particle (all fields explicit; sizes are diameters, m). */
  private add(
    kind: ParticleKind, x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number,
    size0: number, size1: number, growTau: number, drag: number, gravity: number, buoy: number,
    alpha: number, fadeIn: number, fadeOut: number, r: number, g: number, b: number, emit = 0, emitTau = 1,
  ): number {
    if (!Number.isFinite(x + y + z + vx + vy + vz) || Math.abs(x) + Math.abs(y) + Math.abs(z) > 1e7 || Math.abs(vx) + Math.abs(vy) + Math.abs(vz) > 1e5) return -1;
    const i = this.alloc();
    this.kind[i] = kind;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.age[i] = 0;
    this.life[i] = Math.max(0.05, life);
    this.size0[i] = size0; this.size1[i] = size1; this.growTau[i] = Math.max(0.02, growTau);
    this.drag[i] = drag; this.gravity[i] = gravity; this.buoy[i] = buoy;
    this.alpha[i] = alpha; this.fadeIn[i] = fadeIn; this.fadeOut[i] = fadeOut;
    this.r[i] = r; this.g[i] = g; this.b[i] = b;
    this.emit[i] = emit; this.emitTau[i] = Math.max(0.01, emitTau);
    this.rot[i] = this.rnd() * Math.PI * 2;
    this.rotRate[i] = (this.rnd() - 0.5) * 0.4;
    this.seed[i] = this.rnd();
    return i;
  }

  private ring(kind: number, x: number, z: number, r0: number, r1: number, tau: number, life: number, strength: number): void {
    if (!Number.isFinite(x + z + r0 + r1 + strength) || Math.abs(x) + Math.abs(z) > 1e7) return;
    let i = -1;
    let oldest = -1;
    let oldAge = -1;
    for (let k = 0; k < this.ringCap; k++) {
      if (!this.ringAlive[k]) {
        i = k;
        break;
      }
      if (this.ringAge[k] > oldAge) {
        oldAge = this.ringAge[k];
        oldest = k;
      }
    }
    if (i < 0) i = oldest;
    else this.ringCount++;
    this.ringAlive[i] = 1;
    this.ringKind[i] = kind;
    this.ringX[i] = x;
    this.ringZ[i] = z;
    this.ringAge[i] = 0;
    this.ringLife[i] = life;
    this.ringR0[i] = r0;
    this.ringR1[i] = r1;
    this.ringTau[i] = tau;
    this.ringStrength[i] = strength;
    this.ringSeed[i] = this.rnd();
  }

  /** A shake impulse heard/felt at a distance d after d / 343 s. */
  private shake(x: number, y: number, z: number, strength: number, refM: number): void {
    if (!Number.isFinite(x + y + z + strength + refM)) return;
    const s = this.shakes[this.shakeNext];
    this.shakeNext = (this.shakeNext + 1) % this.shakes.length;
    s.x = x; s.y = y; s.z = z;
    s.t = this.time;
    s.strength = strength;
    s.refM = refM;
  }

  /** Camera shake 0..1 at a listener position now: every impulse that has arrived, fading. */
  shakeAt(x: number, y: number, z: number): number {
    let v = 0;
    for (const s of this.shakes) {
      if (s.strength <= 0) continue;
      const d = Math.hypot(s.x - x, s.y - y, s.z - z);
      const since = this.time - s.t - d / SOUND;
      if (since < 0 || since > 3) continue;
      const a = s.strength / (1 + (d / s.refM) * (d / s.refM));
      v = 1 - (1 - v) * (1 - a * Math.exp(-since / 0.35));
    }
    return Math.min(1, v);
  }

  /**
   * A heavy shell bursting on the sea at (x, y, z). `scale` 1 = a 16-inch shell (columns ~60–100 m).
   * `wind` blows the spray and mist (m/s).
   */
  waterColumn(x: number, y: number, z: number, scale = 1, windX = 0, windZ = 0): void {
    const s = Math.max(0.2, Math.min(2, fin(scale, 1)));
    const sv = Math.sqrt(s); // speeds scale with √height
    this.columns++;
    const W = 0.93;
    // core: a tight bundle of jets rising 30–100 m
    for (let k = 0; k < 64; k++) {
      const a = this.rnd() * Math.PI * 2;
      const rr = Math.sqrt(this.rnd()) * 4.5 * s;
      const up = this.u(22, 46) * sv;
      const out = this.u(0.2, 1.6) * sv;
      this.add(PK.spray, x + Math.cos(a) * rr, y + this.u(0, 3), z + Math.sin(a) * rr, Math.cos(a) * out, up, Math.sin(a) * out,
        this.u(6.5, 9.5) * sv, this.u(5, 8) * s, this.u(11, 17) * s, 2.2, 0.1, 9.81, 0, 1, 0.06, 0.35, W, W + 0.01, W + 0.03);
    }
    // crown: fast spray spreading and drooping at the top
    for (let k = 0; k < 18; k++) {
      const a = this.rnd() * Math.PI * 2;
      const up = this.u(36, 47) * sv;
      const out = this.u(3, 8) * sv;
      this.add(PK.spray, x + Math.cos(a) * 2 * s, y + 4 * s, z + Math.sin(a) * 2 * s, Math.cos(a) * out, up, Math.sin(a) * out,
        this.u(8, 10.5) * sv, this.u(6, 9) * s, this.u(14, 22) * s, 2.4, 0.12, 9.81, 0, 0.7, 0.2, 0.45, W, W + 0.01, W + 0.03);
    }
    // skirt: a sheet of spray thrown out low at the base
    for (let k = 0; k < 20; k++) {
      const a = this.rnd() * Math.PI * 2;
      const out = this.u(6, 14) * sv;
      this.add(PK.spray, x + Math.cos(a) * 4 * s, y + 1, z + Math.sin(a) * 4 * s, Math.cos(a) * out, this.u(7, 16) * sv, Math.sin(a) * out,
        this.u(2.6, 3.8) * sv, this.u(3.5, 6) * s, this.u(8, 13) * s, 1, 0.25, 9.81, 0, 0.8, 0.05, 0.4, W, W + 0.01, W + 0.03);
    }
    // base surge: a ring of mist rolling outward over the water as the column falls back
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2 + this.u(-0.12, 0.12);
      const out = this.u(5, 10) * sv;
      this.add(PK.mist, x + Math.cos(a) * 9 * s, y + 3 * s, z + Math.sin(a) * 9 * s, Math.cos(a) * out + windX, this.u(0.2, 0.9), Math.sin(a) * out + windZ,
        this.u(10, 15), this.u(7, 10) * s, this.u(20, 30) * s, 4, 0.3, 0, 0.05, 0.3, 3.2, 0.6, 0.9, 0.91, 0.93);
    }
    // the spray cloud that hangs where the column stood and drifts downwind
    for (let k = 0; k < 12; k++) {
      const a = this.rnd() * Math.PI * 2;
      this.add(PK.mist, x + Math.cos(a) * 3 * s, y + 5, z + Math.sin(a) * 3 * s, Math.cos(a) * 2, this.u(16, 34) * sv, Math.sin(a) * 2,
        this.u(13, 20), this.u(10, 14) * s, this.u(26, 38) * s, 5, 0.55, 2.2, 0, 0.24, 3.2, 0.6, 0.9, 0.91, 0.93);
    }
    // foam on the water
    this.ring(RING.foam, x, z, 10 * s, 58 * s, 7, 48, 1);
    this.shake(x, y, z, 0.55 * s, 160);
  }

  /** A gun's muzzle blast: muzzle (world), bore direction (unit), the ship's velocity; `scale` 1 = a 16-inch gun. */
  muzzleBlast(mx: number, my: number, mz: number, dx: number, dy: number, dz: number, vx = 0, vy = 0, vz = 0, scale = 1, seaY = 0): void {
    const s = Math.max(0.2, Math.min(2, fin(scale, 1)));
    this.blasts++;
    const n = Math.hypot(dx, dy, dz) || 1;
    dx /= n; dy /= n; dz /= n;
    // the flash: incandescent gas shooting out tens of metres
    for (let k = 0; k < 8; k++) {
      const sp = this.u(90, 280) * s;
      this.add(PK.flash, mx, my, mz, vx + dx * sp + this.u(-25, 25), vy + dy * sp + this.u(-18, 25), vz + dz * sp + this.u(-25, 25),
        this.u(0.28, 0.5), this.u(12, 20) * s, this.u(30, 46) * s, 0.12, 5.5, 0, 0, 1, 0.01, 0.5, 1, 0.62, 0.3, 1, this.u(0.08, 0.14));
    }
    // fireball turning into smoke
    for (let k = 0; k < 5; k++) {
      const sp = this.u(40, 120) * s;
      this.add(PK.smoke, mx, my, mz, vx + dx * sp + this.u(-12, 12), vy + dy * sp + this.u(-6, 14), vz + dz * sp + this.u(-12, 12),
        this.u(9, 14), this.u(18, 26) * s, this.u(40, 56) * s, 1.8, 1.6, 0, 1.4, 0.8, 0.02, 0.6, 0.34, 0.3, 0.26, 0.85, this.u(0.2, 0.35));
    }
    // the propellant smoke: a long brown-grey cloud rolling out along the line of fire
    for (let k = 0; k < 16; k++) {
      const sp = this.u(20, 190) * s;
      const tone = this.u(0.9, 1.1);
      this.add(PK.smoke, mx, my, mz, vx + dx * sp + this.u(-20, 20), vy + dy * sp + this.u(-8, 16), vz + dz * sp + this.u(-20, 20),
        this.u(16, 30), this.u(12, 20) * s, this.u(44, 64) * s, 3.2, 1.3, 0, 0.9, 0.72, 0.15, 0.6, 0.41 * tone, 0.37 * tone, 0.32 * tone);
    }
    // the pressure wave on the water beside the ship: a dark ring racing out, spray whipped up
    const h = my - seaY;
    if (h < 60 * s) {
      const hx = Math.hypot(dx, dz) || 1;
      const off = Math.min(40, h * 1.4 + 10) * s;
      const cx = mx + (dx / hx) * off;
      const cz = mz + (dz / hx) * off;
      const k = Math.max(0.25, Math.min(1, 1 - h / (60 * s)));
      this.ring(RING.pressure, cx, cz, 8 * s, 150 * s, 0.4, 2.2, k);
      for (let j = 0; j < 8; j++) {
        const a = this.rnd() * Math.PI * 2;
        const out = this.u(12, 26) * s;
        const rr = this.u(8, 28) * s;
        this.add(PK.spray, cx + Math.cos(a) * rr, seaY + 0.5, cz + Math.sin(a) * rr, Math.cos(a) * out, this.u(2.5, 6), Math.sin(a) * out,
          this.u(1.2, 1.9), this.u(2, 3.2) * s, this.u(4, 6) * s, 0.8, 1.2, 9.81, 0, 0.22 * k, 0.03, 0.5, 0.9, 0.91, 0.93);
      }
    }
    this.shake(mx, my, mz, 0.85 * s, 260);
  }

  /** A shell bursting on a target / the land: flash + black smoke (the shared fx explosion adds fire and debris). */
  burst(x: number, y: number, z: number, onWater: boolean, scale = 1): void {
    const s = Math.max(0.2, Math.min(2, fin(scale, 1)));
    for (let k = 0; k < 6; k++) {
      const a = this.rnd() * Math.PI * 2;
      const sp = this.u(20, 60) * s;
      this.add(PK.flash, x, y + 2, z, Math.cos(a) * sp, this.u(10, 40) * s, Math.sin(a) * sp, this.u(0.3, 0.55), this.u(14, 22) * s, this.u(34, 50) * s, 0.2, 3, 0, 0, 1, 0.01, 0.5, 1, 0.55, 0.22, 1, 0.16);
    }
    for (let k = 0; k < 12; k++) {
      const a = this.rnd() * Math.PI * 2;
      const sp = this.u(4, 16) * s;
      this.add(PK.smoke, x, y + this.u(2, 10), z, Math.cos(a) * sp, this.u(8, 26) * s, Math.sin(a) * sp, this.u(14, 26), this.u(12, 18) * s, this.u(36, 55) * s, 3, 0.8, 0, 2, 0.8, 0.1, 0.6, 0.11, 0.1, 0.1, 0.6, 0.4);
    }
    if (onWater) this.waterColumn(x, 0, z, 0.55 * s);
    this.shake(x, y, z, 0.6 * s, 200);
  }

  /** Advance dt s; `wx, wz` = the wind (m/s) that carries smoke and mist. */
  step(dtIn: number, wxIn = 0, wzIn = 0, seaYIn = 0): void {
    const dt = Number.isFinite(dtIn) && dtIn > 0 ? Math.min(dtIn, 0.25) : 0;
    const wx = Math.max(-60, Math.min(60, fin(wxIn)));
    const wz = Math.max(-60, Math.min(60, fin(wzIn)));
    const seaY = Math.max(-1e4, Math.min(1e4, fin(seaYIn)));
    this.time += dt;
    if (dt <= 0) return;
    for (let i = 0; i < this.cap; i++) {
      if (!this.alive[i]) continue;
      const age = this.age[i] + dt;
      if (age >= this.life[i]) {
        this.alive[i] = 0;
        this.free[this.freeTop++] = i;
        this.count--;
        continue;
      }
      this.age[i] = age;
      const k = 1 - Math.exp(-this.drag[i] * dt);
      this.vx[i] += (wx - this.vx[i]) * k;
      this.vz[i] += (wz - this.vz[i]) * k;
      this.vy[i] += (0 - this.vy[i]) * k * (this.gravity[i] > 0 ? 0.35 : 1);
      this.vy[i] += (this.buoy[i] * Math.exp(-age / 4) - this.gravity[i]) * dt;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
      this.rot[i] += this.rotRate[i] * dt;
      const floor = seaY + this.sizeOf(i) * (this.kind[i] === PK.spray ? 0.1 : 0.22);
      if (this.py[i] < floor) {
        this.py[i] = floor;
        if (this.vy[i] < 0) {
          // spray falling back into the sea: it is gone in a moment; gas spreads along the surface
          if (this.kind[i] === PK.spray && this.gravity[i] > 0) this.life[i] = Math.min(this.life[i], age + 0.35);
          this.vy[i] = 0;
        }
      }
    }
    for (let i = 0; i < this.ringCap; i++) {
      if (!this.ringAlive[i]) continue;
      this.ringAge[i] += dt;
      if (this.ringAge[i] >= this.ringLife[i]) {
        this.ringAlive[i] = 0;
        this.ringCount--;
      }
    }
  }

  /** Diameter now, m. */
  sizeOf(i: number): number {
    return this.size1[i] + (this.size0[i] - this.size1[i]) * Math.exp(-this.age[i] / this.growTau[i]);
  }

  /** Opacity now 0..1. */
  alphaOf(i: number): number {
    const t = this.age[i];
    const L = this.life[i];
    const fi = this.fadeIn[i] > 0 ? Math.min(1, t / this.fadeIn[i]) : 1;
    const fo0 = L * (1 - this.fadeOut[i]);
    const fo = t > fo0 ? Math.max(0, 1 - (t - fo0) / Math.max(1e-3, L - fo0)) : 1;
    return this.alpha[i] * fi * fo;
  }

  /** Emission now 0..1. */
  emitOf(i: number): number {
    return this.emit[i] > 0 ? this.emit[i] * Math.exp(-this.age[i] / this.emitTau[i]) : 0;
  }

  /** Ring radius (m) and strength now. */
  ringRadius(i: number): number {
    return this.ringR1[i] - (this.ringR1[i] - this.ringR0[i]) * Math.exp(-this.ringAge[i] / this.ringTau[i]);
  }

  ringFade(i: number): number {
    const t = this.ringAge[i] / Math.max(1e-3, this.ringLife[i]);
    const inn = Math.min(1, this.ringAge[i] / 0.15);
    return this.ringStrength[i] * inn * (1 - t) * (1 - t);
  }

  stats(): { particles: number; rings: number; columns: number; blasts: number } {
    return { particles: this.count, rings: this.ringCount, columns: this.columns, blasts: this.blasts };
  }
}

function mulberry(seed: number): () => number {
  let st = seed >>> 0;
  return () => {
    st = (st + 0x6d2b79f5) >>> 0;
    let t = st;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
