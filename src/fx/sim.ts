/**
 * PURE effects simulation (no three.js): the particle pools, the continuous emitters and the
 * recipes the crash director (src/crash) plays — a white-hot flash, the rolling fireball that
 * turns into a black mushroom, secondary fuel explosions, a shockwave dust ring, sparks, flung
 * burning fragments, water splashes, ploughing dust, fires that follow burning parts (and are
 * quenched into steam in water) and the lingering drifting smoke column — plus a one-call legacy
 * `crash()` burst and touchdown tyre smoke / dust / spray. Deterministic for a seed. The renderer
 * (effects.ts) only reads it.
 */
import { CONFIG } from '../config';
import type { SurfaceType, Vec3 } from '../types';
import { ParticlePool, newParticleInit, particleHeat, type ParticleInit } from './pool';
import { FLAME_TILES, SPARK_TILE } from './sprites';

const FX = CONFIG.fx;
const MAX_EMITTERS = Math.max(1, Math.min(64, FX.maxEmitters));

const enum Kind {
  None = 0,
  Column = 1,
  Fire = 2,
  Steam = 3,
}

interface Emitter {
  kind: Kind;
  x: number;
  y: number;
  z: number;
  groundY: number;
  t: number;
  duration: number;
  rate: number;
  acc: number;
  acc2: number;
  intensity: number;
  radius: number;
  smoky: boolean;
  gen: number;
  /** Current strength of a fire (intensity × envelope × flicker), for the glow it casts on its smoke. */
  level: number;
}

const fin = (v: number, d = 0) => (Number.isFinite(v) ? v : d);
const clamp01 = (v: number) => (v > 0 ? (v < 1 ? v : 1) : 0);
const clampN = (v: number, lo: number, hi: number, d: number) => (Number.isFinite(v) ? (v < lo ? lo : v > hi ? hi : v) : d);
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

const PAVED = new Set<string>(['runway', 'asphalt', 'urban']);
const GRASSY = new Set<string>(['grass', 'field', 'forest']);

/** Handle = emitter slot | generation << 6 (stale handles are ignored). */
const SLOT_BITS = 6;

export class FxSim {
  readonly smoke = new ParticlePool(FX.smokeCapacity);
  readonly fire = new ParticlePool(FX.fireCapacity);
  readonly debris = new ParticlePool(FX.debrisCapacity);
  /** 0..1 strength of the fire right now (drives the point light). */
  fireLevel = 0;
  firePos = { x: 0, y: 0, z: 0 };
  /** 0..1 white-hot explosion flash (drives the point light hard for a split second). */
  flashLevel = 0;
  flashPos = { x: 0, y: 0, z: 0 };
  private readonly emitters: Emitter[] = [];
  private readonly tpl: ParticleInit = newParticleInit();
  private readonly trailAcc: Float32Array;
  private readonly flameAcc: Float32Array;
  private rndState: number;
  /** Orange afterglow of the latest fireball (lights the scene for about a second). */
  private glow = { x: 0, y: 0, z: 0, level: 0 };
  private dustAcc = 0;
  private sparkAcc = 0;
  /** Slots of the burning fire emitters (for glowAt), rebuilt each step. */
  private readonly fireSlots = new Int32Array(MAX_EMITTERS);
  private fireCount = 0;

  constructor(seed: number = FX.seed) {
    this.rndState = seed >>> 0;
    for (let i = 0; i < MAX_EMITTERS; i++) {
      this.emitters.push({ kind: Kind.None, x: 0, y: 0, z: 0, groundY: 0, t: 0, duration: 0, rate: 0, acc: 0, acc2: 0, intensity: 0, radius: 1, smoky: false, gen: 0, level: 0 });
    }
    this.trailAcc = new Float32Array(this.debris.capacity);
    this.flameAcc = new Float32Array(this.debris.capacity);
  }

  /** Deterministic PRNG (mulberry32) in [0,1). */
  rnd(): number {
    this.rndState = (this.rndState + 0x6d2b79f5) >>> 0;
    let t = this.rndState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  private range(r: readonly [number, number] | number[]): number {
    return r[0] + (r[1] - r[0]) * this.rnd();
  }
  private sym(a: number): number {
    return (this.rnd() * 2 - 1) * a;
  }

  private resetTpl(): ParticleInit {
    const t = this.tpl;
    t.x = t.y = t.z = t.vx = t.vy = t.vz = 0;
    t.life = 1; t.size0 = 1; t.size1 = 1; t.growTau = 1; t.drag = 0; t.buoyancy = 0; t.buoyTau = 1e9; t.gravity = 0;
    t.alpha = 1; t.fadeIn = 0; t.fadeOut = 0; t.visibleAt = 0; t.rot = this.rnd() * 6.2832; t.rotRate = 0;
    t.heat = 0; t.heatTau = 1; t.r = t.g = t.b = 0.5; t.lighten = 0; t.tile = Math.floor(this.rnd() * 4);
    t.groundY = -1e9; t.bounce = 0; t.friction = 0; t.turbulence = 0; t.seed = this.rnd(); t.aspect = 1;
    return t;
  }

  // ── Continuous emitters ──────────────────────────────────────────────────

  private addEmitter(kind: Kind, x: number, y: number, z: number, groundY: number, duration: number, rate: number, intensity: number, radius = 1, smoky = false): number {
    if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) return -1;
    let idx = this.emitters.findIndex((m) => m.kind === Kind.None);
    if (idx < 0) {
      // recycle the one closest to burning out
      let best = -Infinity;
      for (let i = 0; i < this.emitters.length; i++) {
        const m = this.emitters[i];
        const done = m.t / Math.max(1e-3, m.duration);
        if (done > best) { best = done; idx = i; }
      }
    }
    const e = this.emitters[idx];
    e.kind = kind;
    e.x = x; e.y = y; e.z = z; e.groundY = fin(groundY, y - 1);
    e.t = 0; e.duration = clampN(duration, 0.1, 600, 10); e.rate = clampN(rate, 0, 1000, 0); e.acc = 0; e.acc2 = 0;
    e.intensity = clampN(intensity, 0, 2, 1); e.radius = clampN(radius, 0.2, 20, 1); e.smoky = smoky;
    e.level = 0;
    e.gen = (e.gen + 1) & 0xffff;
    return idx | (e.gen << SLOT_BITS);
  }

  private emitterOf(h: number): Emitter | null {
    if (!Number.isInteger(h) || h < 0) return null;
    const e = this.emitters[h & ((1 << SLOT_BITS) - 1)];
    return e && e.kind !== Kind.None && e.gen === h >>> SLOT_BITS ? e : null;
  }

  /** A fire on a burning part (or a fuel spill): flame licks within `radius` m of (x,y,z) and, if smoky, dark smoke. Returns a handle. */
  addFire(x: number, y: number, z: number, groundY: number, intensity: number, duration: number, radius: number, smoky = true): number {
    return this.addEmitter(Kind.Fire, x, y, z, groundY, duration, FX.crash.partFireRate, intensity, radius, smoky);
  }

  /** The lingering smoke column: thick black smoke rising and drifting with the wind for `duration` s. Returns a handle. */
  addColumn(x: number, y: number, z: number, groundY: number, intensity: number, duration: number): number {
    return this.addEmitter(Kind.Column, x, fin(groundY, y), z, groundY, duration, FX.crash.smokeRate, intensity);
  }

  /** Move a fire/column with its part (stale or invalid handles are ignored). */
  moveFire(h: number, x: number, y: number, z: number, groundY: number): void {
    const e = this.emitterOf(h);
    if (!e || !(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) return;
    e.x = x; e.y = e.kind === Kind.Column ? fin(groundY, y) : y; e.z = z;
    e.groundY = fin(groundY, e.groundY);
  }

  /** Put a fire out (it fell into water): the flames stop at once and a brief plume of steam rises. */
  quench(h: number): void {
    const e = this.emitterOf(h);
    if (!e || e.kind !== Kind.Fire) return;
    e.kind = Kind.Steam;
    e.level = 0;
    e.t = 0;
    e.duration = 3;
    e.acc = 0;
  }

  /** Number of live continuous emitters. */
  activeEmitters(): number {
    let n = 0;
    for (const e of this.emitters) if (e.kind !== Kind.None) n++;
    return n;
  }

  // ── Bursts ───────────────────────────────────────────────────────────────

  /** The white-hot flash of an explosion: a few huge, very hot sprites and a hard light pulse (τ ≈ 0.08 s). */
  flash(x: number, y: number, z: number, strengthIn: number): void {
    if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) return;
    const s = clampN(strengthIn, 0, 2, 0);
    if (s <= 0) return;
    if (s >= this.flashLevel) {
      this.flashPos.x = x; this.flashPos.y = y; this.flashPos.z = z;
    }
    this.flashLevel = Math.max(this.flashLevel, Math.min(1.5, s));
    for (let k = 0; k < 3; k++) {
      const t = this.resetTpl();
      t.x = x + this.sym(1.5); t.y = y + this.sym(1); t.z = z + this.sym(1.5);
      t.life = 0.2 + 0.08 * this.rnd();
      t.size0 = 4 * s;
      t.size1 = (11 + 5 * this.rnd()) * s;
      t.growTau = 0.08;
      t.alpha = 0.65;
      t.fadeOut = 0.7;
      t.heat = 1.3;
      t.heatTau = 0.3;
      t.r = t.g = t.b = 0.02;
      t.rotRate = this.sym(2);
      this.fire.emit(t);
    }
  }

  /**
   * The fuel fireball at (x,y,z) (ground at g) for an aircraft moving at (vx,vy,vz), intensity I 0..1:
   * burning vapour thrown forward along the path and up, growing into a rolling ball that glows
   * yellow-white, cools through orange to sooty red over ~1–2 s and leaves the black mushroom.
   */
  fireball(xIn: number, yIn: number, zIn: number, gIn: number, vxIn: number, vyIn: number, vzIn: number, Iin: number): void {
    if (!(Number.isFinite(xIn) && Number.isFinite(yIn) && Number.isFinite(zIn))) return;
    const I = clamp01(fin(Iin, 1));
    const g = Math.min(yIn, fin(gIn, yIn - 1));
    const x = xIn, z = zIn, y = Math.max(g + 0.5, yIn);
    const { dx, dz, fwd } = this.heading(vxIn, vyIn, vzIn, 60);
    this.puffs(x, y, z, g, dx, dz, fwd, I, Math.round(FX.crash.fireballCount * (0.5 + 0.5 * I)), 1);
    const glow = 0.6 + 0.4 * I;
    if (glow >= this.glow.level) {
      this.glow.x = x; this.glow.y = y + 3; this.glow.z = z;
    }
    this.glow.level = Math.max(this.glow.level, glow);
  }

  /** A secondary fuel explosion (a tank letting go): a smaller fireball with its own flash and sparks. scale 0..2. */
  explosion(x: number, y: number, z: number, gIn: number, scaleIn: number): void {
    if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) return;
    const s = clampN(scaleIn, 0, 2, 0.5);
    if (s <= 0) return;
    const g = Math.min(y, fin(gIn, y - 1));
    this.flash(x, y + 1, z, 0.7 * s);
    this.puffs(x, Math.max(g + 0.5, y), z, g, 0, 0, 0, Math.min(1, s), Math.max(4, Math.round(24 * s)), 0.55 * Math.min(1.3, s));
    this.sparks(x, y + 0.5, z, 0, 4, 0, Math.round(30 * s));
    this.embers(x, y, z, g, 0, 0, 0, Math.min(1, 0.35 * s));
    if (0.5 * s >= this.glow.level) {
      this.glow.x = x; this.glow.y = y + 2; this.glow.z = z;
    }
    this.glow.level = Math.max(this.glow.level, Math.min(1, 0.5 * s));
  }

  /** Fireball puffs (flame that becomes the black mushroom on the same path). `size` scales the puffs. */
  private puffs(x: number, y: number, z: number, g: number, dx: number, dz: number, fwd: number, I: number, n: number, size: number) {
    const C = FX.crash;
    const [tr, tg, tb] = C.smokeTint;
    for (let k = 0; k < n; k++) {
      const t = this.resetTpl();
      const th = this.rnd() * 6.2832;
      const up = 0.15 + 0.85 * this.rnd();
      const sp = C.fireballSpeed * (0.3 + 0.7 * this.rnd()) * (0.6 + 0.6 * I) * Math.sqrt(size);
      const ca = Math.sqrt(1 - up * up);
      const along = fwd * (0.1 + 0.45 * this.rnd());
      t.x = x + this.sym(2 * size);
      t.y = y + this.rnd() * 1.5 * size;
      t.z = z + this.sym(2 * size);
      t.vx = Math.cos(th) * ca * sp + dx * along;
      t.vy = up * sp * 0.6 + 2.5;
      t.vz = Math.sin(th) * ca * sp + dz * along;
      t.life = this.range(C.fireballLife) * (0.7 + 0.3 * size);
      t.size0 = (1.5 + 2 * this.rnd()) * size;
      t.size1 = this.range(C.fireballSize) * (0.7 + 0.4 * I) * size;
      t.growTau = 0.3 + 0.3 * this.rnd();
      t.drag = 2.1;
      t.buoyancy = 9;
      t.buoyTau = 1.3;
      t.alpha = 0.95;
      t.fadeIn = 0.02;
      t.fadeOut = 0.65;
      t.heat = 0.72 + 0.26 * this.rnd();
      t.heatTau = t.life * (0.5 + 0.2 * this.rnd());
      t.r = 0.03 * tr; t.g = 0.03 * tg; t.b = 0.03 * tb;
      t.rotRate = this.sym(1.2);
      t.turbulence = 3.5;
      t.groundY = g;
      const vx = t.vx, vy = t.vy, vz = t.vz, px = t.x, py = t.y, pz = t.z, life = t.life, s1 = t.size1;
      this.fire.emit(t);
      // …and the black mushroom it turns into (same path, fading in as the flame cools).
      const s = this.resetTpl();
      s.x = px; s.y = py; s.z = pz; s.vx = vx; s.vy = vy; s.vz = vz;
      s.visibleAt = life * (0.14 + 0.14 * this.rnd());
      s.life = 9 + 7 * this.rnd();
      s.size0 = s1 * 0.75;
      s.size1 = s1 * (1.7 + 0.7 * this.rnd());
      s.growTau = 3;
      s.drag = 1.0;
      s.buoyancy = 10.5;
      s.buoyTau = 3.5;
      s.alpha = 0.9;
      s.fadeIn = 0.5;
      s.fadeOut = 0.55;
      s.heat = 0.25;
      s.heatTau = 0.4;
      s.r = C.smokeAlbedo * 0.7 * tr; s.g = C.smokeAlbedo * 0.7 * tg; s.b = C.smokeAlbedo * 0.7 * tb;
      s.lighten = 1.6;
      s.rotRate = this.sym(0.25);
      s.turbulence = 2.5;
      s.groundY = g;
      this.smoke.emit(s);
    }
  }

  /** Horizontal travel direction and speed (capped) of a velocity. */
  private heading(vxIn: number, vyIn: number, vzIn: number, cap: number) {
    let vx = fin(vxIn), vz = fin(vzIn);
    const vy = fin(vyIn);
    const vmag = Math.hypot(vx, vy, vz);
    if (vmag > 200) {
      vx *= 200 / vmag;
      vz *= 200 / vmag;
    }
    const hmag = Math.hypot(vx, vz);
    return { dx: hmag > 0.5 ? vx / hmag : 0, dz: hmag > 0.5 ? vz / hmag : 0, fwd: Math.min(hmag, cap) };
  }

  /** The shockwave: a ring of dust racing outward low over the ground from (x, g, z). */
  shockRing(x: number, gIn: number, z: number, Iin: number, surface: SurfaceType | string): void {
    if (!(Number.isFinite(x) && Number.isFinite(z))) return;
    const g = fin(gIn, 0);
    const I = clamp01(fin(Iin, 1));
    const col = this.surfaceColor(surface);
    const n = Math.round(28 + 24 * I);
    for (let k = 0; k < n; k++) {
      const t = this.resetTpl();
      const th = (k / n) * 6.2832 + this.sym(0.1);
      const sp = (22 + 14 * this.rnd()) * (0.5 + 0.5 * I);
      t.x = x + Math.cos(th) * 1.5; t.y = g + 0.5 + this.rnd() * 0.8; t.z = z + Math.sin(th) * 1.5;
      t.vx = Math.cos(th) * sp;
      t.vy = 0.6 + 1.2 * this.rnd();
      t.vz = Math.sin(th) * sp;
      t.life = 1.3 + 0.8 * this.rnd();
      t.size0 = 1.5;
      t.size1 = (3.5 + 2.5 * this.rnd()) * (0.6 + 0.4 * I);
      t.growTau = 0.8;
      t.drag = 2.4;
      t.alpha = 0.3;
      t.fadeIn = 0.03;
      t.fadeOut = 0.7;
      const sh = 0.9 + 0.2 * this.rnd();
      t.r = col[0] * sh; t.g = col[1] * sh; t.b = col[2] * sh;
      t.lighten = 0.2;
      t.turbulence = 1;
      t.groundY = g;
      this.smoke.emit(t);
    }
  }

  /** Sparks: tiny, white-hot, fast, falling — thrown from (x,y,z) around the velocity (vx,vy,vz). */
  sparks(x: number, y: number, z: number, vxIn: number, vyIn: number, vzIn: number, nIn: number): void {
    if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) return;
    const n = Math.round(clampN(nIn, 0, 200, 0));
    const vx = clampN(vxIn, -150, 150, 0), vy = clampN(vyIn, -150, 150, 0), vz = clampN(vzIn, -150, 150, 0);
    for (let k = 0; k < n; k++) {
      const t = this.resetTpl();
      const th = this.rnd() * 6.2832;
      const up = 0.1 + 0.9 * this.rnd();
      const sp = 8 + 22 * this.rnd();
      const ca = Math.sqrt(1 - up * up);
      t.x = x; t.y = y; t.z = z;
      t.vx = Math.cos(th) * ca * sp + vx * 0.3;
      t.vy = up * sp + vy * 0.3;
      t.vz = Math.sin(th) * ca * sp + vz * 0.3;
      t.life = 0.5 + 0.9 * this.rnd();
      t.size0 = t.size1 = 0.2 + 0.25 * this.rnd();
      t.gravity = 9.81;
      t.drag = 0.4;
      t.heat = 1.3 + 0.2 * this.rnd();
      t.heatTau = 0.25 + 0.35 * this.rnd();
      t.r = t.g = t.b = 0.02;
      t.fadeOut = 0.3;
      t.groundY = y - 30;
      t.bounce = 0.3;
      t.friction = 4;
      t.tile = SPARK_TILE;
      this.fire.emit(t);
    }
  }

  /** Fragments: small tumbling chunks of airframe flung from (x,y,z) (some burning, trailing smoke). */
  fragments(x: number, y: number, z: number, gIn: number, vxIn: number, vyIn: number, vzIn: number, Iin: number, burning: boolean): void {
    if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) return;
    const g = Math.min(y, fin(gIn, y - 1));
    const I = clamp01(fin(Iin, 1));
    const { dx, dz, fwd } = this.heading(vxIn, vyIn, vzIn, 80);
    this.flingDebris(x, Math.max(g + 0.3, y), z, g, dx, dz, fwd, I, burning, 0.3);
  }

  /** A water splash at the surface (x, y, z): a misty column of spray with droplets thrown out around it. strength 0..1. */
  splash(x: number, y: number, z: number, strengthIn: number): void {
    if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) return;
    const s = clampN(strengthIn, 0, 1.5, 0.5);
    const [r, gg, b] = FX.touchdown.sprayAlbedo;
    const n = Math.round(24 + 44 * s);
    for (let k = 0; k < n; k++) {
      const t = this.resetTpl();
      const th = this.rnd() * 6.2832;
      const column = k < n * 0.35;
      // the column goes up; the rest is a fan of spray thrown out and up, falling back
      const out = column ? 0.4 + 0.8 * this.rnd() : 3 + 7 * this.rnd() * (0.6 + 0.6 * s);
      t.x = x + this.sym(1.2); t.y = y + 0.2; t.z = z + this.sym(1.2);
      t.vx = Math.cos(th) * out;
      t.vy = (column ? 9 + 12 * this.rnd() : 4 + 7 * this.rnd()) * (0.5 + 0.6 * s);
      t.vz = Math.sin(th) * out;
      t.life = 1.3 + 1.3 * this.rnd();
      t.size0 = column ? 0.9 : 0.4;
      t.size1 = (column ? 2.2 + 2.2 * this.rnd() : 1 + 1.6 * this.rnd()) * (0.6 + 0.5 * s);
      t.growTau = 0.6;
      t.gravity = 9;
      t.drag = 0.5;
      t.alpha = column ? 0.32 : 0.38;
      t.fadeIn = 0.03;
      t.fadeOut = 0.7;
      const sh = 0.95 + 0.1 * this.rnd();
      t.r = r * sh; t.g = gg * sh; t.b = b * sh;
      t.lighten = 0.1;
      t.groundY = y - 0.3;
      t.turbulence = 0.6;
      this.smoke.emit(t);
    }
  }

  /**
   * Ploughing: a wreck sliding at `speed` m/s (moving (vx,vz)) over `surface` at (x, g, z) throws dust
   * (and sparks on pavement) in proportion to its speed. Call every frame with that frame's dt.
   */
  dust(x: number, y: number, z: number, gIn: number, vxIn: number, vzIn: number, speedIn: number, dtIn: number, surface: SurfaceType | string): void {
    if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) return;
    const speed = clampN(speedIn, 0, 150, 0);
    const dt = clampN(dtIn, 0, 0.25, 0);
    if (speed < 0.5 || dt <= 0) return;
    const g = fin(gIn, y);
    const vx = clampN(vxIn, -150, 150, 0), vz = clampN(vzIn, -150, 150, 0);
    const h = Math.hypot(vx, vz);
    const dx = h > 0.1 ? vx / h : 0, dz = h > 0.1 ? vz / h : 0;
    const col = this.surfaceColor(surface);
    const paved = PAVED.has(surface);
    this.dustAcc += dt * speed * 1.4;
    let guard = 0;
    while (this.dustAcc >= 1 && guard++ < 40) {
      this.dustAcc -= 1;
      const t = this.resetTpl();
      const side = this.rnd() < 0.5 ? -1 : 1;
      const lat = speed * (0.12 + 0.3 * this.rnd());
      t.x = x + this.sym(1.5); t.y = g + 0.3; t.z = z + this.sym(1.5);
      t.vx = -dz * side * lat + vx * 0.25;
      t.vy = 1.5 + 2.5 * this.rnd();
      t.vz = dx * side * lat + vz * 0.25;
      t.life = 2 + 2 * this.rnd();
      t.size0 = 1.2;
      t.size1 = 4 + 3 * this.rnd();
      t.growTau = 0.9;
      t.drag = 1.6;
      t.buoyancy = 0.3;
      t.alpha = paved ? 0.3 : 0.45;
      t.fadeIn = 0.05;
      t.fadeOut = 0.7;
      const sh = 0.85 + 0.25 * this.rnd();
      t.r = col[0] * sh; t.g = col[1] * sh; t.b = col[2] * sh;
      t.lighten = 0.2;
      t.turbulence = 1.2;
      t.groundY = g;
      this.smoke.emit(t);
    }
    if (this.dustAcc > 40) this.dustAcc = 0;
    if (paved && speed > 5) {
      this.sparkAcc += dt * speed * 3;
      const n = Math.floor(this.sparkAcc);
      this.sparkAcc -= n;
      if (n > 0) this.sparks(x, g + 0.2, z, vx * 0.6, 2, vz * 0.6, Math.min(n, 20));
    }
  }

  private surfaceColor(surface: SurfaceType | string): readonly [number, number, number] {
    const T = FX.touchdown;
    if (surface === 'water' || surface === 'snow') return T.sprayAlbedo;
    if (PAVED.has(surface)) return T.smokeAlbedo;
    if (GRASSY.has(surface)) return T.grassAlbedo;
    return T.dustAlbedo;
  }

  /**
   * One-call crash burst at (x,y,z) at speedKt, aircraft velocity (vx,vy,vz) m/s, ground height
   * groundY (used when no crash director is running). water = ditching (spray, no fire).
   */
  crash(xIn: number, yIn: number, zIn: number, speedKt: number, vxIn: number, vyIn: number, vzIn: number, groundYIn: number, water = false): void {
    if (!(Number.isFinite(xIn) && Number.isFinite(yIn) && Number.isFinite(zIn))) return;
    const C = FX.crash;
    const spdKt = Math.min(400, Math.max(0, fin(speedKt)));
    const I = clamp01(spdKt / 120);
    const g = Math.min(yIn, fin(groundYIn, yIn - 1));
    const x = xIn, z = zIn;
    const y = Math.max(g + 0.5, yIn);
    const { dx, dz, fwd } = this.heading(vxIn, vyIn, vzIn, 80);

    if (water) {
      this.splash(x, g, z, I);
      this.flingDebris(x, y, z, g, dx, dz, fwd, I * 0.5, false, 0.05);
      return;
    }
    const fire = spdKt >= C.fireMinKt;
    this.shockRing(x, g, z, I, 'dirt');
    this.flingDebris(x, y, z, g, dx, dz, fwd, I, fire, 0.3);
    if (!fire) {
      // oil smoke from a broken engine: short and thin
      this.addColumn(x, g, z, g, 0.45, 7);
      return;
    }
    this.flash(x, y + 2, z, 0.6 + 0.4 * I);
    this.fireball(x, y, z, g, vxIn, vyIn, vzIn, I);
    this.embers(x, y, z, g, dx, dz, fwd, I);
    this.addColumn(x + dx * fwd * 0.15, g, z + dz * fwd * 0.15, g, 0.6 + 0.4 * I, C.smokeDuration * (0.6 + 0.4 * I));
    this.addFire(x + dx * fwd * 0.15, g + 0.5, z + dz * fwd * 0.15, g, 0.55 + 0.45 * I, C.groundFireDuration * (0.55 + 0.45 * I), 4, false);
  }

  private embers(x: number, y: number, z: number, g: number, dx: number, dz: number, fwd: number, I: number) {
    const n = Math.round(FX.crash.emberCount * I);
    for (let k = 0; k < n; k++) {
      const t = this.resetTpl();
      const th = this.rnd() * 6.2832;
      const up = 0.3 + 0.7 * this.rnd();
      const sp = 8 + 20 * this.rnd();
      t.x = x; t.y = y + 1; t.z = z;
      t.vx = Math.cos(th) * Math.sqrt(1 - up * up) * sp + dx * fwd * 0.2;
      t.vy = up * sp;
      t.vz = Math.sin(th) * Math.sqrt(1 - up * up) * sp + dz * fwd * 0.2;
      t.life = 1.2 + 2 * this.rnd();
      t.size0 = t.size1 = 0.1 + 0.16 * this.rnd();
      t.gravity = 6;
      t.drag = 0.6;
      t.heat = 1.35;
      t.heatTau = 0.8 + 0.9 * this.rnd();
      t.r = t.g = t.b = 0.02;
      t.fadeOut = 0.3;
      t.turbulence = 4;
      t.groundY = g;
      t.bounce = 0.2;
      t.friction = 4;
      t.tile = SPARK_TILE;
      this.fire.emit(t);
    }
  }

  private flingDebris(x: number, y: number, z: number, g: number, dx: number, dz: number, fwd: number, I: number, burning: boolean, bounce: number) {
    const n = Math.max(3, Math.round(FX.crash.debrisCount * (0.35 + 0.65 * I)));
    for (let k = 0; k < n; k++) {
      const t = this.resetTpl();
      const th = this.rnd() * 6.2832;
      const up = 0.25 + 0.75 * this.rnd();
      const sp = (4 + 18 * I) * (0.3 + 0.7 * this.rnd());
      t.x = x + this.sym(1.5); t.y = y + 0.5; t.z = z + this.sym(1.5);
      t.vx = Math.cos(th) * Math.sqrt(1 - up * up) * sp + dx * fwd * 0.3 * this.rnd();
      t.vy = up * sp;
      t.vz = Math.sin(th) * Math.sqrt(1 - up * up) * sp + dz * fwd * 0.3 * this.rnd();
      t.life = 600;
      t.size0 = t.size1 = 0.2 + 0.8 * this.rnd() * this.rnd();
      t.gravity = 9.81;
      t.drag = 0.15;
      t.bounce = bounce;
      t.friction = 3;
      t.rotRate = this.sym(9);
      t.groundY = g;
      t.heat = burning && this.rnd() < 0.45 ? 1 : 0;
      t.heatTau = 3 + 5 * this.rnd();
      // colour: white paint, bare aluminium, or burnt
      const c = this.rnd();
      const shade = c < 0.45 ? 0.82 : c < 0.75 ? 0.55 : 0.07;
      t.r = shade; t.g = shade; t.b = shade * (c < 0.45 ? 1 : 1.04);
      const i = this.debris.emit(t);
      this.trailAcc[i] = 0;
      this.flameAcc[i] = 0;
    }
  }

  /**
   * Tyre smoke at the main wheels' contact points (world), for a touchdown at `fpm` (either sign)
   * with aircraft velocity (vx,vy,vz): puffs are spawned along the wheels' path during spin-up.
   */
  touchdown(wheels: ArrayLike<Vec3>, groundYIn: number, fpm: number, vxIn: number, vyIn: number, vzIn: number, surface: SurfaceType): void {
    const T = FX.touchdown;
    const i = clamp01((Math.abs(fin(fpm)) - 50) / (T.fullFpm - 50));
    let vx = fin(vxIn), vz = fin(vzIn);
    const h = Math.hypot(vx, vz);
    if (h > 120) {
      vx *= 120 / h;
      vz *= 120 / h;
    }
    const water = surface === 'water';
    // pavement → white tyre smoke; grass → greenish-brown dust; snow/water → white spray; dirt/sand/rock → brown dust
    const col = PAVED.has(surface) ? T.smokeAlbedo : GRASSY.has(surface) ? T.grassAlbedo : water || surface === 'snow' ? T.sprayAlbedo : T.dustAlbedo;
    const perWheel = Math.round(T.minPuffs + (T.maxPuffs - T.minPuffs) * i);
    const size = T.softSize + (T.hardSize - T.softSize) * i;
    const alpha = T.softAlpha + (T.hardAlpha - T.softAlpha) * i;
    for (let w = 0; w < wheels.length; w++) {
      const p = wheels[w];
      if (!(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z))) continue;
      const g = fin(groundYIn, p.y);
      for (let k = 0; k < perWheel; k++) {
        const t = this.resetTpl();
        const tau = 0.25 * (k / Math.max(1, perWheel - 1)) * (0.8 + 0.4 * this.rnd());
        t.x = p.x + vx * tau + this.sym(0.15);
        t.y = g + 0.25;
        t.z = p.z + vz * tau + this.sym(0.15);
        t.visibleAt = tau;
        t.vx = vx * 0.12 + this.sym(1.2);
        t.vy = 0.3 + 0.8 * this.rnd() * (0.5 + i);
        t.vz = vz * 0.12 + this.sym(1.2);
        t.life = this.range(T.life) * (0.7 + 0.6 * i);
        t.size0 = 0.25 + 0.2 * this.rnd();
        t.size1 = size * (0.7 + 0.5 * this.rnd());
        t.growTau = 0.45;
        t.drag = 1.6;
        t.buoyancy = water ? 0 : 0.3;
        t.gravity = water ? 3 : 0;
        t.alpha = alpha * (0.75 + 0.25 * this.rnd());
        t.fadeIn = 0.04;
        t.fadeOut = 0.7;
        const shade = 0.92 + 0.16 * this.rnd();
        t.r = col[0] * shade; t.g = col[1] * shade; t.b = col[2] * shade;
        t.lighten = 0.1;
        t.turbulence = 1;
        t.groundY = g;
        this.smoke.emit(t);
      }
    }
  }

  /** Advance emitters and particles by dt (s) in a wind (world m/s). */
  step(dtIn: number, wx: number, wy: number, wz: number): void {
    if (!(dtIn > 0) || !Number.isFinite(dtIn)) return;
    const dt = Math.min(dtIn, 0.25);
    const C = FX.crash;
    let fireLevel = 0;
    let fx = 0, fy = 0, fz = 0;
    this.fireCount = 0;
    for (let slot = 0; slot < this.emitters.length; slot++) {
      const e = this.emitters[slot];
      if (e.kind === Kind.None) continue;
      e.t += dt;
      if (e.t >= e.duration) {
        e.kind = Kind.None;
        e.level = 0;
        continue;
      }
      if (e.kind === Kind.Column) {
        const rate = e.rate * (0.35 + 0.65 * Math.exp(-e.t / 6)) * (1 - smooth(e.duration - 6, e.duration, e.t));
        e.acc += rate * dt;
        while (e.acc >= 1) {
          e.acc -= 1;
          this.columnPuff(e);
        }
      } else if (e.kind === Kind.Steam) {
        e.acc += 10 * Math.exp(-e.t / 1.2) * dt;
        while (e.acc >= 1) {
          e.acc -= 1;
          this.steamPuff(e);
        }
      } else {
        const env = this.fireEnvelope(e);
        const flicker = 0.85 + 0.15 * Math.sin(e.t * 13.1 + e.gen) * Math.sin(e.t * 7.3 + 1);
        const level = e.intensity * env * flicker;
        e.level = level;
        if (level > 1e-3) this.fireSlots[this.fireCount++] = slot;
        if (level > fireLevel) {
          fireLevel = level;
          fx = e.x; fy = Math.max(e.y, e.groundY) + 2; fz = e.z;
        }
        e.acc += (e.smoky ? e.rate * (0.5 + 0.35 * e.radius) : C.groundFireRate) * e.intensity * env * dt;
        let guard = 0;
        while (e.acc >= 1 && guard++ < 30) {
          e.acc -= 1;
          this.flame(e, env);
        }
        if (e.acc > 30) e.acc = 0;
        if (e.smoky) {
          e.acc2 += C.partSmokeRate * e.intensity * env * dt;
          while (e.acc2 >= 1) {
            e.acc2 -= 1;
            this.fireSmoke(e);
          }
        }
      }
    }
    // Orange afterglow of the latest fireball.
    this.glow.level *= Math.exp(-dt / 0.9);
    if (this.glow.level > fireLevel) {
      fireLevel = this.glow.level;
      fx = this.glow.x; fy = this.glow.y; fz = this.glow.z;
    }
    this.fireLevel = fireLevel > 1e-3 ? Math.min(1, fireLevel) : 0;
    if (this.fireLevel > 0) {
      this.firePos.x = fx; this.firePos.y = fy; this.firePos.z = fz;
    }
    this.flashLevel *= Math.exp(-dt / 0.08);
    if (this.flashLevel < 1e-3) this.flashLevel = 0;
    this.debrisTrails(dt);
    this.smoke.step(dt, wx, wy, wz);
    this.fire.step(dt, wx, wy, wz);
    this.debris.step(dt, wx, wy, wz);
  }

  private fireEnvelope(e: Emitter): number {
    return smooth(0, 0.4, e.t) * (0.55 + 0.45 * Math.exp(-e.t / 5)) * (1 - smooth(e.duration - 4, e.duration, e.t));
  }

  private columnPuff(e: Emitter) {
    const C = FX.crash;
    const t = this.resetTpl();
    const a = this.rnd() * 6.2832;
    const r = 3 * Math.sqrt(this.rnd());
    const young = Math.exp(-e.t / 10);
    t.x = e.x + Math.cos(a) * r;
    t.y = e.groundY + 1 + 2 * this.rnd();
    t.z = e.z + Math.sin(a) * r;
    t.vx = this.sym(1);
    t.vy = C.smokeRise * (0.75 + 0.5 * this.rnd()) * (0.5 + 0.5 * Math.min(1, e.intensity));
    t.vz = this.sym(1);
    t.life = this.range(C.smokeLife);
    t.size0 = C.smokeSize[0] * (0.8 + 0.4 * this.rnd());
    t.size1 = C.smokeSize[1] * (0.7 + 0.6 * this.rnd()) * (0.6 + 0.4 * Math.min(1, e.intensity));
    t.growTau = C.smokeGrowTau * (0.8 + 0.4 * this.rnd());
    t.drag = C.smokeDrag;
    t.buoyancy = C.smokeBuoyancy * (0.8 + 0.4 * this.rnd()) * (0.6 + 0.4 * Math.min(1, e.intensity));
    t.buoyTau = C.smokeBuoyancyTau;
    t.alpha = 0.9 * (0.6 + 0.4 * young) * Math.min(1, e.intensity);
    t.fadeIn = 0.5;
    t.fadeOut = 0.5;
    t.heat = 0.28 * young * Math.min(1, e.intensity);
    t.heatTau = 0.35;
    const shade = C.smokeAlbedo * (0.85 + 0.3 * this.rnd());
    t.r = shade * C.smokeTint[0]; t.g = shade * C.smokeTint[1]; t.b = shade * C.smokeTint[2];
    t.lighten = C.smokeLighten;
    t.rotRate = this.sym(0.15);
    t.turbulence = 2.5;
    t.groundY = e.groundY;
    this.smoke.emit(t);
  }

  /** Flame height scale (m) of a fire: grows with its size and heat release (Heskestad-like), and with its envelope. */
  private flameHeight(e: Emitter, env: number): number {
    const F = FX.fire;
    const I = Math.min(1, e.intensity);
    return Math.min(F.maxHeight, e.radius * (F.heightPerRadius[0] + F.heightPerRadius[1] * I)) * (0.6 + 0.4 * env);
  }

  /** Base of a fire's flames: the ground for a ground fire, around the part for a part fire. */
  private flameBase(e: Emitter): number {
    return e.smoky ? Math.max(e.groundY, e.y - 0.3 * e.radius + this.sym(0.3 * e.radius)) : e.groundY;
  }

  /** Thick black oily smoke boiling off the flame tips of a burning part / vehicle. */
  private fireSmoke(e: Emitter) {
    const C = FX.crash;
    const t = this.resetTpl();
    const env = this.fireEnvelope(e);
    const L = this.flameHeight(e, env);
    const I = Math.min(1, e.intensity);
    t.x = e.x + this.sym(e.radius * 0.5);
    t.y = this.flameBase(e) + L * (0.6 + 0.35 * this.rnd());
    t.z = e.z + this.sym(e.radius * 0.5);
    t.vx = this.sym(0.6);
    t.vy = 2.5 + 2 * this.rnd();
    t.vz = this.sym(0.6);
    t.life = 7 + 5 * this.rnd();
    t.size0 = Math.max(1, 0.35 * L + 0.4 * e.radius);
    t.size1 = (6 + 5 * this.rnd()) * (0.6 + 0.4 * I) * (0.8 + 0.15 * e.radius);
    t.growTau = 3;
    t.drag = 0.5;
    t.buoyancy = 2.5;
    t.buoyTau = 6;
    t.alpha = 0.75;
    t.fadeIn = 0.25;
    t.fadeOut = 0.6;
    t.heat = 0.3;
    t.heatTau = 0.4;
    const shade = C.smokeAlbedo * (0.8 + 0.3 * this.rnd());
    t.r = shade * C.smokeTint[0]; t.g = shade * C.smokeTint[1]; t.b = shade * C.smokeTint[2];
    t.lighten = C.smokeLighten;
    t.rotRate = this.sym(0.2);
    t.turbulence = 2;
    t.groundY = e.groundY;
    this.smoke.emit(t);
  }

  /** White steam from a fire put out by water. */
  private steamPuff(e: Emitter) {
    const [r, g, b] = FX.touchdown.sprayAlbedo;
    const t = this.resetTpl();
    t.x = e.x + this.sym(e.radius); t.y = Math.max(e.y, e.groundY) + 0.3; t.z = e.z + this.sym(e.radius);
    t.vx = this.sym(0.5); t.vy = 2 + 2 * this.rnd(); t.vz = this.sym(0.5);
    t.life = 2.5 + 2 * this.rnd();
    t.size0 = 1;
    t.size1 = 4 + 3 * this.rnd();
    t.growTau = 1.2;
    t.drag = 0.8;
    t.buoyancy = 1.5;
    t.alpha = 0.55;
    t.fadeIn = 0.1;
    t.fadeOut = 0.7;
    t.r = r; t.g = g; t.b = b;
    t.turbulence = 1;
    t.groundY = e.groundY;
    this.smoke.emit(t);
  }

  /**
   * One flame of a fire. A fire is a clustered volume, not a stamp: broad luminous BODY flames low
   * in the middle, tall narrow TONGUES licking up out of them (buoyancy stretches them), and rolling
   * BILLOWS breaking off the top that cool to soot within a second — sizes scale with the flame
   * height L (Heskestad-like: radius × heat), central flames are taller, every one has its own seed,
   * shape (tile, aspect) and lean. Ground fires spread over their radius; part fires burn around the part.
   */
  private flame(e: Emitter, env: number) {
    const F = FX.fire;
    const t = this.resetTpl();
    const L = this.flameHeight(e, env);
    const a = this.rnd() * 6.2832;
    const rr = Math.sqrt(this.rnd());
    const r = e.radius * rr * (0.55 + 0.3 * Math.min(1, e.intensity));
    const centre = 1 - 0.4 * rr;
    const base = this.flameBase(e);
    const u = this.rnd();
    let s: number;
    t.x = e.x + Math.cos(a) * r;
    t.z = e.z + Math.sin(a) * r;
    t.vx = this.sym(0.4);
    t.vz = this.sym(0.4);
    if (u < F.bodyShare) {
      // body: broad, bright, slow
      s = L * (0.4 + 0.3 * this.rnd()) * centre;
      t.aspect = 0.8 + 0.25 * this.rnd();
      t.life = 0.7 + 0.6 * this.rnd();
      t.y = base + s * 0.3;
      t.vy = 0.5 + 0.8 * this.rnd();
      t.buoyancy = 3;
      t.buoyTau = 0.8;
      t.heat = 1.05 + 0.2 * this.rnd();
      t.heatTau = t.life * 1.4;
      t.tile = FLAME_TILES[Math.floor(this.rnd() * FLAME_TILES.length)];
      t.rot = this.sym(0.2);
    } else if (u < F.bodyShare + F.tongueShare) {
      // tongue: tall, narrow, fast
      s = L * (0.28 + 0.32 * this.rnd()) * centre;
      t.aspect = 0.4 + 0.28 * this.rnd();
      t.life = 0.35 + 0.45 * this.rnd();
      t.y = base + s * 0.45 + L * 0.2 * this.rnd();
      t.vy = 1.5 + 2 * this.rnd();
      t.buoyancy = 7;
      t.buoyTau = 0.6;
      t.heat = 0.95 + 0.25 * this.rnd();
      t.heatTau = t.life * 0.9;
      t.tile = FLAME_TILES[Math.floor(this.rnd() * FLAME_TILES.length)];
      t.rot = this.sym(0.3);
    } else {
      // billow: a rolling ball of burning gas off the top, cooling to soot
      s = L * (0.22 + 0.25 * this.rnd());
      t.life = 0.5 + 0.5 * this.rnd();
      t.y = base + L * (0.45 + 0.35 * this.rnd());
      t.vy = 2 + 1.5 * this.rnd();
      t.buoyancy = 6;
      t.buoyTau = 0.6;
      t.heat = 0.8 + 0.2 * this.rnd();
      t.heatTau = t.life * 0.45;
      t.rotRate = this.sym(1.5);
    }
    const billow = u >= F.bodyShare + F.tongueShare;
    s = Math.max(0.15, Math.min(F.maxFlameSize / (billow ? 1.5 : 1.15), s));
    t.size0 = s * 0.75;
    t.size1 = s * (billow ? 1.5 : 1.15);
    t.growTau = 0.35;
    t.drag = 1.2;
    t.alpha = 0.92;
    t.fadeIn = 0.06;
    t.fadeOut = 0.45;
    t.r = t.g = t.b = 0.03;
    t.groundY = Math.min(e.groundY, base) - s;
    t.turbulence = 0.8;
    this.fire.emit(t);
  }

  /** Burning debris trails smoke and small flames while it flies and for a while after it lands. */
  private debrisTrails(dt: number) {
    const d = this.debris;
    for (let i = 0; i < d.capacity; i++) {
      if (!d.alive[i]) continue;
      const h = particleHeat(d, i);
      if (h < 0.05) continue;
      this.trailAcc[i] += 9 * h * dt;
      this.flameAcc[i] += 14 * h * dt;
      while (this.trailAcc[i] >= 1) {
        this.trailAcc[i] -= 1;
        const t = this.resetTpl();
        t.x = d.px[i]; t.y = d.py[i] + 0.3; t.z = d.pz[i];
        t.vx = d.vx[i] * 0.2; t.vy = 1.5; t.vz = d.vz[i] * 0.2;
        t.life = 3 + 2 * this.rnd();
        t.size0 = 0.8;
        t.size1 = 4 + 3 * h;
        t.growTau = 1.5;
        t.drag = 0.8;
        t.buoyancy = 2;
        t.buoyTau = 3;
        t.alpha = 0.55 * h;
        t.fadeIn = 0.2;
        t.fadeOut = 0.6;
        t.r = t.g = t.b = 0.06;
        t.lighten = 2;
        t.turbulence = 1.5;
        t.groundY = d.groundY[i];
        this.smoke.emit(t);
      }
      while (this.flameAcc[i] >= 1) {
        this.flameAcc[i] -= 1;
        const t = this.resetTpl();
        const s = (0.45 + 0.7 * h) * (0.6 + 0.7 * this.rnd()) * (0.5 + d.size0[i]);
        const billow = this.rnd() < 0.2;
        t.x = d.px[i] + this.sym(0.3); t.y = d.py[i] + s * 0.3; t.z = d.pz[i] + this.sym(0.3);
        t.vx = d.vx[i] * 0.5; t.vy = d.vy[i] * 0.5 + 1 + this.rnd(); t.vz = d.vz[i] * 0.5;
        t.life = billow ? 0.4 + 0.3 * this.rnd() : 0.25 + 0.4 * this.rnd();
        t.size0 = s * 0.8;
        t.size1 = s * (billow ? 1.5 : 1.2);
        t.growTau = 0.3;
        t.drag = 1.5;
        t.buoyancy = billow ? 4 : 5;
        t.buoyTau = 0.6;
        t.alpha = 0.9;
        t.fadeIn = 0.04;
        t.fadeOut = 0.5;
        t.heat = billow ? 0.8 + 0.2 * this.rnd() : 0.95 + 0.2 * this.rnd();
        t.heatTau = billow ? t.life * 0.5 : 1;
        t.r = t.g = t.b = 0.03;
        if (billow) t.rotRate = this.sym(1.5);
        else {
          t.tile = FLAME_TILES[Math.floor(this.rnd() * FLAME_TILES.length)];
          t.aspect = 0.45 + 0.5 * this.rnd();
          t.rot = this.sym(0.3);
        }
        t.turbulence = 0.6;
        t.groundY = d.groundY[i] - s;
        this.fire.emit(t);
      }
    }
  }

  /**
   * Fire (and explosion-flash) illumination at a point (0 = none, ~1–3 right next to a big fire):
   * every burning fire lights its own smoke, plus the afterglow of the latest fireball and the flash.
   */
  glowAt(x: number, y: number, z: number): number {
    let g = 0;
    for (let k = 0; k < this.fireCount; k++) {
      const e = this.emitters[this.fireSlots[k]];
      if (e.kind !== Kind.Fire || !(e.level > 0)) continue;
      const R = 5 + 2.5 * e.radius;
      const dx = x - e.x, dy = y - (Math.max(e.y, e.groundY) + 1 + 0.5 * e.radius), dz = z - e.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > 400 * R * R) continue;
      g += (1.1 * Math.min(1, e.level)) / (1 + d2 / (R * R));
    }
    if (this.glow.level > 1e-3) {
      const dx = x - this.glow.x, dy = y - this.glow.y, dz = z - this.glow.z;
      const R = 11;
      g += (1.1 * this.glow.level) / (1 + (dx * dx + dy * dy + dz * dz) / (R * R));
    }
    if (this.flashLevel > 0) {
      const dx = x - this.flashPos.x, dy = y - this.flashPos.y, dz = z - this.flashPos.z;
      const R = 30;
      g += (1.6 * this.flashLevel) / (1 + (dx * dx + dy * dy + dz * dz) / (R * R));
    }
    return Number.isFinite(g) ? Math.min(3, g) : 0;
  }

  reset(): void {
    this.smoke.clear();
    this.fire.clear();
    this.debris.clear();
    for (const e of this.emitters) {
      e.kind = Kind.None;
      e.level = 0;
      e.gen = (e.gen + 1) & 0xffff;
    }
    this.fireCount = 0;
    this.fireLevel = 0;
    this.flashLevel = 0;
    this.glow.level = 0;
    this.dustAcc = 0;
    this.sparkAcc = 0;
  }
}
