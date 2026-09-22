/**
 * PURE particle pool: preallocated struct-of-arrays storage, a free-list, and oldest-first
 * recycling when full. No allocation after construction (emit copies from a reusable
 * ParticleInit template). The simulation is deliberately simple and robust:
 *
 *   v ← v + (wind − v)·(1 − e^(−drag·dt))          (particles are carried by the air)
 *   v.y += (buoyancy·e^(−age/buoyTau) − gravity)·dt (hot gas rises, then cools)
 *   + a cheap divergence-ish turbulence field       (billowing, not straight lines)
 *   ground: gas stays above it; solids (bounce > 0) bounce, slide with friction, then rest.
 *
 * Visual curves (size, alpha, heat) are pure functions of the particle's age.
 */

export interface ParticleInit {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** Seconds. */
  life: number;
  /** Diameter at birth and asymptotic diameter, m; size approaches size1 with time constant growTau. */
  size0: number; size1: number; growTau: number;
  /** Relaxation rate toward the wind velocity, 1/s. */
  drag: number;
  /** Upward acceleration at birth (m/s²), decaying with buoyTau. */
  buoyancy: number; buoyTau: number;
  gravity: number;
  /** Peak opacity 0..1, fade-in time (s), fade-out as a fraction of life, first visible age (s). */
  alpha: number; fadeIn: number; fadeOut: number; visibleAt: number;
  rot: number; rotRate: number;
  /** Incandescence 0..~1.2 (fire), cooling with heatTau. */
  heat: number; heatTau: number;
  /** Albedo (smoke/dust) and how much lighter it gets over its life (×(1 + lighten·t)). */
  r: number; g: number; b: number; lighten: number;
  /** Sprite atlas tile. */
  tile: number;
  groundY: number;
  /** > 0 = solid (bounces with this restitution); 0 = gas. */
  bounce: number;
  /** Ground friction for solids, 1/s. */
  friction: number;
  turbulence: number;
  seed: number;
}

export function newParticleInit(): ParticleInit {
  return {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, size0: 1, size1: 1, growTau: 1, drag: 0, buoyancy: 0, buoyTau: 1e9,
    gravity: 0, alpha: 1, fadeIn: 0, fadeOut: 0, visibleAt: 0, rot: 0, rotRate: 0, heat: 0, heatTau: 1,
    r: 0.5, g: 0.5, b: 0.5, lighten: 0, tile: 0, groundY: -1e9, bounce: 0, friction: 0, turbulence: 0, seed: 0,
  };
}

const DEFAULTS = newParticleInit();

const clampF = (v: number, lo: number, hi: number, d: number) => (Number.isFinite(v) ? (v < lo ? lo : v > hi ? hi : v) : d);

export class ParticlePool {
  readonly capacity: number;
  count = 0;
  /** Accumulated simulation time, s (drives the turbulence field). */
  time = 0;
  readonly alive: Uint8Array;
  readonly px: Float32Array; readonly py: Float32Array; readonly pz: Float32Array;
  readonly vx: Float32Array; readonly vy: Float32Array; readonly vz: Float32Array;
  readonly age: Float32Array; readonly life: Float32Array;
  readonly size0: Float32Array; readonly size1: Float32Array; readonly growTau: Float32Array;
  readonly drag: Float32Array; readonly buoyancy: Float32Array; readonly buoyTau: Float32Array; readonly gravity: Float32Array;
  readonly alpha: Float32Array; readonly fadeIn: Float32Array; readonly fadeOut: Float32Array; readonly visibleAt: Float32Array;
  readonly rot: Float32Array; readonly rotRate: Float32Array;
  readonly heat: Float32Array; readonly heatTau: Float32Array;
  readonly r: Float32Array; readonly g: Float32Array; readonly b: Float32Array; readonly lighten: Float32Array;
  readonly tile: Float32Array; readonly groundY: Float32Array; readonly bounce: Float32Array; readonly friction: Float32Array;
  readonly turbulence: Float32Array; readonly seed: Float32Array;
  private readonly serial: Float64Array;
  private readonly free: Int32Array;
  private freeTop: number;
  private nextSerial = 0;

  constructor(capacity: number) {
    const n = Math.max(1, Math.floor(Number.isFinite(capacity) ? capacity : 1));
    this.capacity = n;
    const f = () => new Float32Array(n);
    this.alive = new Uint8Array(n);
    this.px = f(); this.py = f(); this.pz = f();
    this.vx = f(); this.vy = f(); this.vz = f();
    this.age = f(); this.life = f();
    this.size0 = f(); this.size1 = f(); this.growTau = f();
    this.drag = f(); this.buoyancy = f(); this.buoyTau = f(); this.gravity = f();
    this.alpha = f(); this.fadeIn = f(); this.fadeOut = f(); this.visibleAt = f();
    this.rot = f(); this.rotRate = f();
    this.heat = f(); this.heatTau = f();
    this.r = f(); this.g = f(); this.b = f(); this.lighten = f();
    this.tile = f(); this.groundY = f(); this.bounce = f(); this.friction = f();
    this.turbulence = f(); this.seed = f();
    this.serial = new Float64Array(n);
    this.free = new Int32Array(n);
    this.freeTop = 0;
    this.clear();
  }

  /** Remove every particle. */
  clear(): void {
    this.alive.fill(0);
    this.count = 0;
    this.freeTop = 0;
    for (let i = this.capacity - 1; i >= 0; i--) this.free[this.freeTop++] = i;
  }

  /** Allocate a slot: a free one, else recycle the oldest live particle. */
  private allocate(): number {
    let i: number;
    if (this.freeTop > 0) {
      i = this.free[--this.freeTop];
      this.count++;
    } else {
      i = 0;
      let best = Infinity;
      for (let k = 0; k < this.capacity; k++) {
        if (this.alive[k] && this.serial[k] < best) {
          best = this.serial[k];
          i = k;
        }
      }
    }
    this.alive[i] = 1;
    this.serial[i] = this.nextSerial++;
    return i;
  }

  /** Spawn a particle from a template (values are sanitised). Returns its slot. */
  emit(p: ParticleInit): number {
    const i = this.allocate();
    const D = DEFAULTS;
    this.px[i] = clampF(p.x, -1e7, 1e7, 0);
    this.py[i] = clampF(p.y, -1e7, 1e7, 0);
    this.pz[i] = clampF(p.z, -1e7, 1e7, 0);
    this.vx[i] = clampF(p.vx, -1e4, 1e4, 0);
    this.vy[i] = clampF(p.vy, -1e4, 1e4, 0);
    this.vz[i] = clampF(p.vz, -1e4, 1e4, 0);
    this.age[i] = 0;
    this.life[i] = clampF(p.life, 1e-3, 1e4, D.life);
    this.size0[i] = clampF(p.size0, 0, 1e4, D.size0);
    this.size1[i] = clampF(p.size1, 0, 1e4, this.size0[i]);
    this.growTau[i] = clampF(p.growTau, 1e-3, 1e6, D.growTau);
    this.drag[i] = clampF(p.drag, 0, 100, 0);
    this.buoyancy[i] = clampF(p.buoyancy, -1e3, 1e3, 0);
    this.buoyTau[i] = clampF(p.buoyTau, 1e-3, 1e9, D.buoyTau);
    this.gravity[i] = clampF(p.gravity, -1e3, 1e3, 0);
    this.alpha[i] = clampF(p.alpha, 0, 1, 1);
    this.fadeIn[i] = clampF(p.fadeIn, 0, 1e4, 0);
    this.fadeOut[i] = clampF(p.fadeOut, 0, 1, 0);
    this.visibleAt[i] = clampF(p.visibleAt, 0, 1e4, 0);
    this.rot[i] = clampF(p.rot, -1e3, 1e3, 0);
    this.rotRate[i] = clampF(p.rotRate, -100, 100, 0);
    this.heat[i] = clampF(p.heat, 0, 10, 0);
    this.heatTau[i] = clampF(p.heatTau, 1e-3, 1e6, D.heatTau);
    this.r[i] = clampF(p.r, 0, 4, D.r);
    this.g[i] = clampF(p.g, 0, 4, D.g);
    this.b[i] = clampF(p.b, 0, 4, D.b);
    this.lighten[i] = clampF(p.lighten, 0, 100, 0);
    this.tile[i] = clampF(Math.floor(p.tile), 0, 255, 0);
    this.groundY[i] = clampF(p.groundY, -1e9, 1e7, D.groundY);
    this.bounce[i] = clampF(p.bounce, 0, 1, 0);
    this.friction[i] = clampF(p.friction, 0, 100, 0);
    this.turbulence[i] = clampF(p.turbulence, 0, 1e3, 0);
    this.seed[i] = clampF(p.seed, 0, 1, 0);
    return i;
  }

  kill(i: number): void {
    if (!(i >= 0 && i < this.capacity) || !this.alive[i]) return;
    this.alive[i] = 0;
    this.count--;
    this.free[this.freeTop++] = i;
  }

  /**
   * Advance every particle by dt (s) in a wind (m/s, world frame). dt ≤ 0 or non-finite: no-op.
   * Long steps are integrated in ≤ 0.1 s sub-steps (capped at 10 s total).
   */
  step(dtIn: number, wxIn: number, wyIn: number, wzIn: number): void {
    if (!(dtIn > 0) || !Number.isFinite(dtIn)) return;
    const total = Math.min(dtIn, 10);
    const n = Math.ceil(total / 0.1);
    for (let k = 0; k < n; k++) this.subStep(total / n, wxIn, wyIn, wzIn);
  }

  private subStep(dt: number, wxIn: number, wyIn: number, wzIn: number): void {
    const wx = clampF(wxIn, -200, 200, 0);
    const wy = clampF(wyIn, -200, 200, 0);
    const wz = clampF(wzIn, -200, 200, 0);
    this.time += dt;
    const time = this.time;
    for (let i = 0; i < this.capacity; i++) {
      if (!this.alive[i]) continue;
      const age = this.age[i] + dt;
      this.age[i] = age;
      if (age >= this.life[i]) {
        this.kill(i);
        continue;
      }
      let vx = this.vx[i];
      let vy = this.vy[i];
      let vz = this.vz[i];
      const drag = this.drag[i];
      if (drag > 0) {
        const k = 1 - Math.exp(-drag * dt);
        vx += (wx - vx) * k;
        vy += (wy - vy) * k;
        vz += (wz - vz) * k;
      }
      vy += (this.buoyancy[i] * Math.exp(-age / this.buoyTau[i]) - this.gravity[i]) * dt;
      const turb = this.turbulence[i];
      let x = this.px[i];
      let y = this.py[i];
      let z = this.pz[i];
      if (turb > 0) {
        const ph = this.seed[i] * 6.2832;
        vx += turb * Math.sin(y * 0.07 + time * 0.8 + ph) * dt;
        vz += turb * Math.cos(x * 0.06 - time * 0.7 + ph * 1.3) * dt;
        vy += turb * 0.4 * Math.sin(z * 0.08 + time * 0.9 + ph * 0.7) * dt;
      }
      x += vx * dt;
      y += vy * dt;
      z += vz * dt;
      this.rot[i] += this.rotRate[i] * dt;
      const gy = this.groundY[i];
      if (y < gy) {
        y = gy;
        if (this.bounce[i] > 0) {
          if (vy < 0) vy = -vy * this.bounce[i];
          const fr = Math.exp(-this.friction[i] * dt);
          vx *= fr;
          vz *= fr;
          this.rotRate[i] *= fr;
          if (Math.abs(vy) < 0.5 && Math.hypot(vx, vz) < 0.3) {
            vx = 0;
            vy = 0;
            vz = 0;
            this.rotRate[i] = 0;
          }
        } else if (vy < 0) {
          vy = 0;
        }
      }
      if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) && Number.isFinite(vx) && Number.isFinite(vy) && Number.isFinite(vz) && Number.isFinite(this.rot[i]))) {
        this.kill(i);
        continue;
      }
      this.px[i] = x;
      this.py[i] = y;
      this.pz[i] = z;
      this.vx[i] = vx;
      this.vy[i] = vy;
      this.vz[i] = vz;
    }
  }
}

/** Current diameter, m. */
export function particleSize(p: ParticlePool, i: number): number {
  const s0 = p.size0[i];
  const s = s0 + (p.size1[i] - s0) * (1 - Math.exp(-p.age[i] / p.growTau[i]));
  return Number.isFinite(s) && s > 0 ? s : 0;
}

/** Current opacity 0..1 (0 before visibleAt; fade in; fade out over the last fadeOut fraction of life). */
export function particleAlpha(p: ParticlePool, i: number): number {
  const t = p.age[i];
  const v0 = p.visibleAt[i];
  if (t < v0) return 0;
  const fi = p.fadeIn[i] > 0 ? Math.min(1, (t - v0) / p.fadeIn[i]) : 1;
  let fo = 1;
  const life = p.life[i];
  const fOut = p.fadeOut[i];
  if (fOut > 0) {
    const e0 = life * (1 - fOut);
    const u = Math.min(1, Math.max(0, (t - e0) / (life - e0)));
    fo = 1 - u * u * (3 - 2 * u);
  }
  const a = p.alpha[i] * fi * fo;
  return Number.isFinite(a) ? Math.min(1, Math.max(0, a)) : 0;
}

/** Current incandescence (0 = cold smoke). */
export function particleHeat(p: ParticlePool, i: number): number {
  const h = p.heat[i] * Math.exp(-p.age[i] / p.heatTau[i]);
  return Number.isFinite(h) && h > 0 ? h : 0;
}
