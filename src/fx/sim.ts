/**
 * PURE effects simulation (no three.js): the particle pools, the continuous emitters and the
 * burst recipes for a crash (fireball → black mushroom, embers, flung burning debris, a
 * lingering drifting smoke column, a ground fire) and for touchdowns (tyre smoke / dust /
 * spray at the main wheels). Deterministic for a seed. The renderer (effects.ts) only reads it.
 */
import { CONFIG } from '../config';
import type { SurfaceType, Vec3 } from '../types';
import { ParticlePool, newParticleInit, particleHeat, type ParticleInit } from './pool';
import { FLAME_TILES } from './sprites';

const FX = CONFIG.fx;
const MAX_EMITTERS = 8;

const enum Kind {
  None = 0,
  CrashSmoke = 1,
  GroundFire = 2,
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
  intensity: number;
}

const fin = (v: number, d = 0) => (Number.isFinite(v) ? v : d);
const clamp01 = (v: number) => (v > 0 ? (v < 1 ? v : 1) : 0);
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

const PAVED = new Set<string>(['runway', 'asphalt', 'urban']);
const GRASSY = new Set<string>(['grass', 'field', 'forest']);

export class FxSim {
  readonly smoke = new ParticlePool(FX.smokeCapacity);
  readonly fire = new ParticlePool(FX.fireCapacity);
  readonly debris = new ParticlePool(FX.debrisCapacity);
  /** 0..1 strength of the fire right now (drives the point light). */
  fireLevel = 0;
  firePos = { x: 0, y: 0, z: 0 };
  private readonly emitters: Emitter[] = [];
  private readonly tpl: ParticleInit = newParticleInit();
  private readonly trailAcc: Float32Array;
  private readonly flameAcc: Float32Array;
  private rndState: number;
  /** Fireball flash (brief, bright) — position and age. */
  private flash = { x: 0, y: 0, z: 0, age: 1e9, strength: 0 };

  constructor(seed: number = FX.seed) {
    this.rndState = seed >>> 0;
    for (let i = 0; i < MAX_EMITTERS; i++) {
      this.emitters.push({ kind: Kind.None, x: 0, y: 0, z: 0, groundY: 0, t: 0, duration: 0, rate: 0, acc: 0, intensity: 0 });
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
    t.groundY = -1e9; t.bounce = 0; t.friction = 0; t.turbulence = 0; t.seed = this.rnd();
    return t;
  }

  private addEmitter(kind: Kind, x: number, y: number, z: number, groundY: number, duration: number, rate: number, intensity: number) {
    let e = this.emitters.find((m) => m.kind === Kind.None);
    if (!e) e = this.emitters.reduce((a, b) => (b.t > a.t ? b : a)); // recycle the oldest
    e.kind = kind;
    e.x = x; e.y = y; e.z = z; e.groundY = groundY;
    e.t = 0; e.duration = duration; e.rate = rate; e.acc = 0; e.intensity = intensity;
  }

  /**
   * A crash at (x,y,z) at speedKt, aircraft velocity (vx,vy,vz) m/s, ground height groundY.
   * water = ditching (spray, no fire).
   */
  crash(xIn: number, yIn: number, zIn: number, speedKt: number, vxIn: number, vyIn: number, vzIn: number, groundYIn: number, water = false): void {
    if (!(Number.isFinite(xIn) && Number.isFinite(yIn) && Number.isFinite(zIn))) return;
    const C = FX.crash;
    const spdKt = Math.min(400, Math.max(0, fin(speedKt)));
    const I = clamp01(spdKt / 120);
    const g = Math.min(yIn, fin(groundYIn, yIn - 1));
    const x = xIn, z = zIn;
    const y = Math.max(g + 0.5, yIn);
    let vx = fin(vxIn), vy = fin(vyIn), vz = fin(vzIn);
    const vmag = Math.hypot(vx, vy, vz);
    if (vmag > 200) {
      vx *= 200 / vmag; vy *= 200 / vmag; vz *= 200 / vmag;
    }
    const hmag = Math.hypot(vx, vz);
    const dx = hmag > 0.5 ? vx / hmag : 0;
    const dz = hmag > 0.5 ? vz / hmag : 0;
    const fwd = Math.min(hmag, 80);

    if (water) {
      this.spray(x, g, z, dx, dz, fwd, I);
      this.flingDebris(x, y, z, g, dx, dz, fwd, I * 0.5, false, 0.05);
      return;
    }
    const fire = spdKt >= C.fireMinKt;
    this.dustRing(x, g, z, dx, dz, fwd, I);
    this.flingDebris(x, y, z, g, dx, dz, fwd, I, fire, 0.3);
    if (!fire) {
      // oil smoke from a broken engine: short and thin
      this.addEmitter(Kind.CrashSmoke, x, g, z, g, 7, C.smokeRate * 0.35, 0.45);
      return;
    }
    this.fireball(x, y, z, g, dx, dz, fwd, I);
    this.embers(x, y, z, g, dx, dz, fwd, I);
    this.addEmitter(Kind.CrashSmoke, x + dx * fwd * 0.15, g, z + dz * fwd * 0.15, g, C.smokeDuration * (0.6 + 0.4 * I), C.smokeRate * (0.6 + 0.4 * I), 0.6 + 0.4 * I);
    this.addEmitter(Kind.GroundFire, x + dx * fwd * 0.15, g, z + dz * fwd * 0.15, g, C.groundFireDuration * (0.55 + 0.45 * I), C.groundFireRate, 0.55 + 0.45 * I);
    this.flash = { x, y: y + 3, z, age: 0, strength: 0.6 + 0.4 * I };
  }

  private fireball(x: number, y: number, z: number, g: number, dx: number, dz: number, fwd: number, I: number) {
    const C = FX.crash;
    const n = Math.round(C.fireballCount * (0.5 + 0.5 * I));
    for (let k = 0; k < n; k++) {
      const t = this.resetTpl();
      // Fuel sprays forward and up, then burns as a rolling, rising ball.
      const th = this.rnd() * 6.2832;
      const up = 0.25 + 0.75 * this.rnd();
      const sp = C.fireballSpeed * (0.35 + 0.65 * this.rnd()) * (0.6 + 0.6 * I);
      const ca = Math.sqrt(1 - up * up);
      const along = fwd * 0.35 * this.rnd();
      t.x = x + this.sym(2);
      t.y = y + this.rnd() * 2;
      t.z = z + this.sym(2);
      t.vx = Math.cos(th) * ca * sp + dx * along;
      t.vy = up * sp * 0.7 + 3;
      t.vz = Math.sin(th) * ca * sp + dz * along;
      t.life = this.range(C.fireballLife);
      t.size0 = C.fireballSize[0] * (0.7 + 0.6 * this.rnd());
      t.size1 = C.fireballSize[1] * (0.6 + 0.5 * this.rnd()) * (0.7 + 0.4 * I);
      t.growTau = 0.45 + 0.4 * this.rnd();
      t.drag = 1.7;
      t.buoyancy = 10;
      t.buoyTau = 1.4;
      t.alpha = 0.95;
      t.fadeIn = 0.03;
      t.fadeOut = 0.45;
      t.heat = 1.05 + 0.2 * this.rnd();
      t.heatTau = t.life * (0.45 + 0.25 * this.rnd());
      t.r = t.g = t.b = 0.035;
      t.rotRate = this.sym(0.8);
      t.turbulence = 3;
      t.groundY = g;
      const vx = t.vx, vy = t.vy, vz = t.vz, px = t.x, py = t.y, pz = t.z, life = t.life, s1 = t.size1;
      this.fire.emit(t);
      // …and the black mushroom that the fireball turns into (same path, appears as it cools).
      const s = this.resetTpl();
      s.x = px; s.y = py; s.z = pz; s.vx = vx; s.vy = vy; s.vz = vz;
      s.visibleAt = life * (0.35 + 0.2 * this.rnd());
      s.life = 8 + 5 * this.rnd();
      s.size0 = s1 * 0.6;
      s.size1 = s1 * (1.5 + 0.6 * this.rnd());
      s.growTau = 3;
      s.drag = 1.2;
      s.buoyancy = 9;
      s.buoyTau = 3;
      s.alpha = 0.85;
      s.fadeIn = 0.8;
      s.fadeOut = 0.55;
      s.heat = 0.55;
      s.heatTau = 0.7;
      s.r = s.g = s.b = C.smokeAlbedo * 0.9;
      s.lighten = 3;
      s.rotRate = this.sym(0.25);
      s.turbulence = 2.5;
      s.groundY = g;
      this.smoke.emit(s);
    }
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
      t.life = 1.5 + 2.5 * this.rnd();
      t.size0 = t.size1 = 0.25 + 0.25 * this.rnd();
      t.gravity = 5;
      t.drag = 0.6;
      t.heat = 1.2;
      t.heatTau = 1.2 + this.rnd();
      t.r = t.g = t.b = 0.02;
      t.fadeOut = 0.3;
      t.turbulence = 4;
      t.groundY = g;
      t.bounce = 0.2;
      t.friction = 4;
      this.fire.emit(t);
    }
  }

  private flingDebris(x: number, y: number, z: number, g: number, dx: number, dz: number, fwd: number, I: number, burning: boolean, bounce: number) {
    const n = Math.max(3, Math.round(FX.crash.debrisCount * (0.35 + 0.65 * I)));
    for (let k = 0; k < n; k++) {
      const t = this.resetTpl();
      const th = this.rnd() * 6.2832;
      const up = 0.2 + 0.8 * this.rnd();
      const sp = (3 + 13 * I) * (0.3 + 0.7 * this.rnd());
      t.x = x + this.sym(1.5); t.y = y + 0.5; t.z = z + this.sym(1.5);
      t.vx = Math.cos(th) * Math.sqrt(1 - up * up) * sp + dx * fwd * 0.3 * this.rnd();
      t.vy = up * sp;
      t.vz = Math.sin(th) * Math.sqrt(1 - up * up) * sp + dz * fwd * 0.3 * this.rnd();
      t.life = 600;
      t.size0 = t.size1 = 0.25 + 1.1 * this.rnd() * this.rnd();
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

  private dustRing(x: number, g: number, z: number, dx: number, dz: number, fwd: number, I: number) {
    const n = Math.round(10 + 20 * I);
    for (let k = 0; k < n; k++) {
      const t = this.resetTpl();
      const th = this.rnd() * 6.2832;
      const sp = 4 + 10 * I * this.rnd();
      t.x = x + this.sym(2); t.y = g + 0.5; t.z = z + this.sym(2);
      t.vx = Math.cos(th) * sp + dx * fwd * 0.3;
      t.vy = 1 + 3 * this.rnd();
      t.vz = Math.sin(th) * sp + dz * fwd * 0.3;
      t.life = 2.5 + 1.5 * this.rnd();
      t.size0 = 2;
      t.size1 = 7 + 6 * I;
      t.growTau = 1;
      t.drag = 1.4;
      t.buoyancy = 0.3;
      t.alpha = 0.5;
      t.fadeIn = 0.05;
      t.fadeOut = 0.7;
      const [r, gg, b] = FX.touchdown.dustAlbedo;
      t.r = r * 0.8; t.g = gg * 0.8; t.b = b * 0.8;
      t.turbulence = 1.5;
      t.groundY = g;
      this.smoke.emit(t);
    }
  }

  private spray(x: number, g: number, z: number, dx: number, dz: number, fwd: number, I: number) {
    const n = Math.round(24 + 40 * I);
    const [r, gg, b] = FX.touchdown.sprayAlbedo;
    for (let k = 0; k < n; k++) {
      const t = this.resetTpl();
      const th = this.rnd() * 6.2832;
      const sp = 3 + 12 * I * this.rnd();
      t.x = x + this.sym(2); t.y = g + 0.3; t.z = z + this.sym(2);
      t.vx = Math.cos(th) * sp * 0.6 + dx * fwd * 0.25;
      t.vy = 4 + 12 * I * this.rnd();
      t.vz = Math.sin(th) * sp * 0.6 + dz * fwd * 0.25;
      t.life = 1.8 + 1.8 * this.rnd();
      t.size0 = 1.5;
      t.size1 = 5 + 6 * I;
      t.growTau = 0.8;
      t.gravity = 7;
      t.drag = 0.9;
      t.alpha = 0.7;
      t.fadeOut = 0.6;
      t.r = r; t.g = gg; t.b = b;
      t.groundY = g;
      t.turbulence = 1;
      this.smoke.emit(t);
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
        t.vy = 0.4 + 1.2 * this.rnd() * (0.5 + i);
        t.vz = vz * 0.12 + this.sym(1.2);
        t.life = this.range(T.life) * (0.7 + 0.6 * i);
        t.size0 = 0.35 + 0.3 * this.rnd();
        t.size1 = size * (0.7 + 0.6 * this.rnd());
        t.growTau = 0.7;
        t.drag = 1.3;
        t.buoyancy = water ? 0 : 0.4;
        t.gravity = water ? 3 : 0;
        t.alpha = 0.35 + 0.45 * i;
        t.fadeIn = 0.06;
        t.fadeOut = 0.6;
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
    for (const e of this.emitters) {
      if (e.kind === Kind.None) continue;
      e.t += dt;
      if (e.t >= e.duration) {
        e.kind = Kind.None;
        continue;
      }
      if (e.kind === Kind.CrashSmoke) {
        const rate = e.rate * (0.35 + 0.65 * Math.exp(-e.t / 6));
        e.acc += rate * dt;
        while (e.acc >= 1) {
          e.acc -= 1;
          this.columnPuff(e);
        }
      } else {
        const env = this.fireEnvelope(e);
        const flicker = 0.85 + 0.15 * Math.sin(e.t * 13.1) * Math.sin(e.t * 7.3 + 1);
        const level = e.intensity * env * flicker;
        if (level > fireLevel) {
          fireLevel = level;
          fx = e.x; fy = e.groundY + 3; fz = e.z;
        }
        e.acc += C.groundFireRate * e.intensity * env * dt;
        while (e.acc >= 1) {
          e.acc -= 1;
          this.flame(e, env);
        }
      }
    }
    // Brief fireball flash.
    this.flash.age += dt;
    const flash = this.flash.strength * Math.exp(-this.flash.age / 0.9);
    if (flash > fireLevel) {
      fireLevel = flash;
      fx = this.flash.x; fy = this.flash.y; fz = this.flash.z;
    }
    this.fireLevel = fireLevel > 1e-3 ? Math.min(1, fireLevel) : 0;
    if (this.fireLevel > 0) {
      this.firePos.x = fx; this.firePos.y = fy; this.firePos.z = fz;
    }
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
    t.vy = C.smokeRise * (0.75 + 0.5 * this.rnd()) * (0.5 + 0.5 * e.intensity);
    t.vz = this.sym(1);
    t.life = this.range(C.smokeLife);
    t.size0 = C.smokeSize[0] * (0.8 + 0.4 * this.rnd());
    t.size1 = C.smokeSize[1] * (0.7 + 0.6 * this.rnd()) * (0.6 + 0.4 * e.intensity);
    t.growTau = 4.5;
    t.drag = C.smokeDrag;
    t.buoyancy = C.smokeBuoyancy * (0.8 + 0.4 * this.rnd());
    t.buoyTau = C.smokeBuoyancyTau;
    t.alpha = 0.9 * (0.55 + 0.45 * young) * e.intensity;
    t.fadeIn = 0.5;
    t.fadeOut = 0.55;
    t.heat = 0.35 * young * e.intensity;
    t.heatTau = 0.35;
    t.r = t.g = t.b = C.smokeAlbedo * (0.85 + 0.3 * this.rnd());
    t.lighten = C.smokeLighten;
    t.rotRate = this.sym(0.15);
    t.turbulence = 2.5;
    t.groundY = e.groundY;
    this.smoke.emit(t);
  }

  private flame(e: Emitter, env: number) {
    const t = this.resetTpl();
    const a = this.rnd() * 6.2832;
    const r = 4 * Math.sqrt(this.rnd()) * (0.6 + 0.4 * e.intensity);
    const s = (2.2 + 2.8 * this.rnd()) * (0.6 + 0.5 * e.intensity) * (0.6 + 0.4 * env);
    t.x = e.x + Math.cos(a) * r;
    t.z = e.z + Math.sin(a) * r;
    t.y = e.groundY + s * 0.32;
    t.vx = this.sym(0.4);
    t.vy = 1.5 + 2 * this.rnd();
    t.vz = this.sym(0.4);
    t.life = 0.55 + 0.6 * this.rnd();
    t.size0 = s * 0.8;
    t.size1 = s * 1.25;
    t.growTau = 0.5;
    t.drag = 1;
    t.buoyancy = 5;
    t.buoyTau = 0.6;
    t.alpha = 0.95;
    t.fadeIn = 0.06;
    t.fadeOut = 0.45;
    t.heat = 0.95 + 0.25 * this.rnd();
    t.heatTau = t.life * 1.6;
    t.r = t.g = t.b = 0.03;
    t.tile = FLAME_TILES[Math.floor(this.rnd() * FLAME_TILES.length)];
    t.rot = this.sym(0.25);
    t.groundY = e.groundY - s;
    t.turbulence = 0.5;
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
        const s = 0.8 + 0.9 * h;
        t.x = d.px[i]; t.y = d.py[i] + s * 0.3; t.z = d.pz[i];
        t.vx = d.vx[i] * 0.5; t.vy = d.vy[i] * 0.5 + 1; t.vz = d.vz[i] * 0.5;
        t.life = 0.3 + 0.3 * this.rnd();
        t.size0 = s;
        t.size1 = s * 1.3;
        t.growTau = 0.3;
        t.drag = 1.5;
        t.buoyancy = 3;
        t.alpha = 0.9;
        t.fadeIn = 0.04;
        t.fadeOut = 0.5;
        t.heat = 1;
        t.heatTau = 1;
        t.r = t.g = t.b = 0.03;
        t.tile = FLAME_TILES[Math.floor(this.rnd() * FLAME_TILES.length)];
        t.rot = this.sym(0.2);
        t.groundY = d.groundY[i] - s;
        this.fire.emit(t);
      }
    }
  }

  /** Fire illumination at a point (0 = none, ~1–3 right next to a big fire). */
  glowAt(x: number, y: number, z: number): number {
    if (this.fireLevel <= 0) return 0;
    const dx = x - this.firePos.x, dy = y - this.firePos.y, dz = z - this.firePos.z;
    const R = 14;
    const g = (2.2 * this.fireLevel) / (1 + (dx * dx + dy * dy + dz * dz) / (R * R));
    return Number.isFinite(g) ? Math.min(3, g) : 0;
  }

  reset(): void {
    this.smoke.clear();
    this.fire.clear();
    this.debris.clear();
    for (const e of this.emitters) e.kind = Kind.None;
    this.fireLevel = 0;
    this.flash.age = 1e9;
    this.flash.strength = 0;
  }
}
