/**
 * PURE combat effects (no three.js), driven by the combat events: they are queued as they arrive
 * (allocation-free: numbers copied into preallocated slots) and played on the next update() into the
 * shared fx pools (FxSim: dust/smoke, fire/flashes, debris) and this module's glowing streaks
 * (sparks, ricochets). What plays, compared with real A-10 gun-run and Maverick footage:
 *
 *   30 mm on soil     dark ejecta thrown up + billowing brown-grey dust that lingers and merges with
 *                     the next impacts into the rippling "carpet" along the burst; HEI sparkle
 *   30 mm on pavement sparks skittering off, a grey puff, chips
 *   30 mm on water    tall white splash columns and mist
 *   30 mm on armour   a white-hot incendiary flash, a spray of sparks, a wisp of smoke; ricochets
 *                     glance off as fast glowing streaks
 *   Maverick          flash (lights the scene), a short orange-black fireball, a dust ring racing
 *                     over the ground, a dirt column thrown up, hot fragments, smoke that lingers;
 *                     an air burst (self-destruct) is a fireball and a black puff, nothing on the ground
 *   vehicle destroyed the catastrophic explosion — a big flash, the rolling fireball, dark debris
 *                     (some burning) — and the secondary pop 0.3–1.5 s later (ammunition cooking off);
 *                     the wreck, turret toss and lingering fire/smoke column are the targets system's
 *   camera shake      the GAU-8 vibrating the airframe (strong in the cockpit), and every blast once
 *                     its pressure wave reaches the camera (d / c), scaled by size and distance
 *
 * At most CONFIG.combat.maxImpactFxPerFrame impact effects play per frame (the rest merge into the
 * nearest and play bigger). Everything lives in fixed pools; reset() empties them.
 */
import { CONFIG } from '../../config';
import type { FxSim } from '../../fx/sim';
import { newParticleInit, type ParticleInit } from '../../fx/pool';
import type { Vec3 } from '../../types';
import type { CombatEvent, TargetKind } from '../types';
import { ImpactBatch } from './batch';
import { StreakPool } from './streaks';
import { CLASS_CODE, CLASS_OF_CODE, blastShake, combineShake, dustAlbedo, gunShake, impactClass, isAirBurst, secondaryPlan, soundArrivalS } from './plan';

const C = CONFIG.fx.combat;

/** Surface codes stored in the batch (dust colour lookup). */
const SURFACES = ['dirt', 'runway', 'asphalt', 'grass', 'field', 'forest', 'rock', 'snow', 'sand', 'urban', 'water', 'target'] as const;
const SURFACE_CODE: Record<string, number> = Object.fromEntries(SURFACES.map((s, i) => [s, i]));

const fin = (v: number, d = 0) => (Number.isFinite(v) ? v : d);
const KINDS: readonly TargetKind[] = ['tank', 'ifv', 'apc', 'truck', 'aaa'];

export interface CombatFxEnv {
  /** Terrain (or water surface) height at x, z. */
  groundHeight(x: number, z: number): number;
}

export interface CombatFxOptions {
  seed?: number;
  /** Impact effects per frame (default CONFIG.combat.maxImpactFxPerFrame). */
  maxImpactsPerFrame?: number;
  streakCapacity?: number;
  maxPending?: number;
}

export interface CombatFxStats {
  /** Impacts received since the start / last reset (merged ones included). */
  impacts: number;
  /** Impact effects played on the last update (≤ maxImpactFxPerFrame). */
  lastFrameEffects: number;
  flashes: number;
  detonations: number;
  destroyed: number;
  secondaries: number;
  streaks: number;
  pending: number;
  blasts: number;
}

const enum PendKind {
  None = 0,
  Secondary = 1,
}

interface Pending {
  kind: PendKind;
  at: number;
  x: number;
  y: number;
  z: number;
  size: number;
}

interface Blast {
  used: boolean;
  t0: number;
  x: number;
  y: number;
  z: number;
  size: number;
}

interface QueuedBurst {
  x: number;
  y: number;
  z: number;
  /** Detonation: blast radius; destroyed: kind index. */
  a: number;
  /** Detonation surface code; destroyed: target id. */
  b: number;
  /** Destroyed: kill time (for the secondary plan). */
  t: number;
}

const QUEUE = 8;
const HITS = 16;
const BLASTS = 8;

export class CombatFxSim {
  readonly batch: ImpactBatch;
  readonly streaks: StreakPool;
  private readonly tpl: ParticleInit = newParticleInit();
  private rndState: number;
  private now = 0;
  private readonly det: QueuedBurst[] = [];
  private detCount = 0;
  private readonly kills: QueuedBurst[] = [];
  private killCount = 0;
  private readonly hits: Float32Array = new Float32Array(HITS * 3);
  private hitCount = 0;
  private readonly pending: Pending[] = [];
  private readonly blasts: Blast[] = [];
  private readonly cam = { x: 0, y: 0, z: 0, set: false };
  private readonly s: CombatFxStats = { impacts: 0, lastFrameEffects: 0, flashes: 0, detonations: 0, destroyed: 0, secondaries: 0, streaks: 0, pending: 0, blasts: 0 };

  constructor(opts: CombatFxOptions = {}) {
    this.rndState = (opts.seed ?? C.seed) >>> 0;
    this.batch = new ImpactBatch(opts.maxImpactsPerFrame ?? CONFIG.combat.maxImpactFxPerFrame);
    this.streaks = new StreakPool(opts.streakCapacity ?? C.streakCapacity);
    const nPend = Math.max(1, opts.maxPending ?? C.maxPending);
    for (let i = 0; i < nPend; i++) this.pending.push({ kind: PendKind.None, at: 0, x: 0, y: 0, z: 0, size: 0 });
    for (let i = 0; i < QUEUE; i++) {
      this.det.push({ x: 0, y: 0, z: 0, a: 0, b: 0, t: 0 });
      this.kills.push({ x: 0, y: 0, z: 0, a: 0, b: 0, t: 0 });
    }
    for (let i = 0; i < BLASTS; i++) this.blasts.push({ used: false, t0: 0, x: 0, y: 0, z: 0, size: 0 });
  }

  /** Deterministic PRNG (mulberry32) in [0,1). */
  private rnd(): number {
    this.rndState = (this.rndState + 0x6d2b79f5) >>> 0;
    let t = this.rndState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  private range(r: readonly [number, number]): number {
    return r[0] + (r[1] - r[0]) * this.rnd();
  }
  private sym(a: number): number {
    return (this.rnd() * 2 - 1) * a;
  }

  // ── Events (queued; allocation-free) ────────────────────────────────────────

  onEvent(e: CombatEvent): void {
    if (!e || typeof e !== 'object') return;
    switch (e.type) {
      case 'impact': {
        const p = e.point;
        if (!p) return;
        const surface = e.surface as string;
        const slot = this.batch.add(p.x, p.y, p.z, CLASS_CODE[impactClass(surface)], !!e.ricochet, e.targetId ?? -1, SURFACE_CODE[surface] ?? 0);
        if (slot >= 0) this.s.impacts++;
        return;
      }
      case 'hit': {
        // Gun hits come with an 'impact' on the target; a hit without one still sparks (checked at play time).
        if (e.weapon !== 'gun' || !e.point || this.hitCount >= HITS) return;
        const p = e.point;
        if (!(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z))) return;
        const o = this.hitCount++ * 3;
        this.hits[o] = p.x;
        this.hits[o + 1] = p.y;
        this.hits[o + 2] = p.z;
        return;
      }
      case 'detonation': {
        if (e.weapon !== 'missile' || this.detCount >= QUEUE) return;
        const p = e.position;
        if (!p || !(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z))) return;
        const q = this.det[this.detCount++];
        q.x = p.x; q.y = p.y; q.z = p.z;
        q.a = fin(e.blastRadiusM, 18);
        q.b = SURFACE_CODE[e.surface as string] ?? 0;
        q.t = fin(e.time);
        return;
      }
      case 'destroyed': {
        if (this.killCount >= QUEUE) return;
        const p = e.position;
        if (!p || !(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z))) return;
        const q = this.kills[this.killCount++];
        q.x = p.x; q.y = p.y; q.z = p.z;
        q.a = Math.max(0, KINDS.indexOf(e.kind));
        q.b = fin(e.targetId);
        q.t = fin(e.time);
        return;
      }
      default:
        return;
    }
  }

  // ── Per frame ───────────────────────────────────────────────────────────────

  /**
   * Play the queued events into `fx` (null: the fx system is off — they are dropped) and the
   * streaks, fire due secondaries, advance the streaks. `shooter` = the firing aircraft (round
   * directions), `camera` = the listener for blast shakes. dt = 0 while paused.
   */
  update(dtIn: number, fx: FxSim | null, env: CombatFxEnv, shooter: Vec3 | null, camera: Vec3 | null): void {
    const dt = Number.isFinite(dtIn) && dtIn > 0 ? Math.min(dtIn, 0.25) : 0;
    this.now += dt;
    if (camera && Number.isFinite(camera.x) && Number.isFinite(camera.y) && Number.isFinite(camera.z)) {
      this.cam.x = camera.x;
      this.cam.y = camera.y;
      this.cam.z = camera.z;
      this.cam.set = true;
    }
    const ground = (x: number, z: number, fallback: number) => {
      const g = env.groundHeight(x, z);
      return Number.isFinite(g) ? g : fallback;
    };

    // Gun hits without an impact event on the target: add them as armour impacts.
    for (let h = 0; h < this.hitCount; h++) {
      const hx = this.hits[h * 3], hy = this.hits[h * 3 + 1], hz = this.hits[h * 3 + 2];
      let covered = false;
      for (let i = 0; i < this.batch.count; i++) {
        if (this.batch.cls[i] !== CLASS_CODE.armour) continue;
        const dx = this.batch.x[i] - hx, dy = this.batch.y[i] - hy, dz = this.batch.z[i] - hz;
        if (dx * dx + dy * dy + dz * dz < 9) {
          covered = true;
          break;
        }
      }
      if (!covered && this.batch.add(hx, hy, hz, CLASS_CODE.armour, false, -1, SURFACE_CODE.target) >= 0) this.s.impacts++;
    }
    this.hitCount = 0;

    this.s.lastFrameEffects = 0;
    if (fx) {
      const b = this.batch;
      for (let i = 0; i < b.count; i++) {
        const x = b.x[i], y = b.y[i], z = b.z[i];
        const g = ground(x, z, y);
        const surf = SURFACES[b.surface[i]] ?? 'dirt';
        this.playImpact(fx, CLASS_OF_CODE[b.cls[i]], surf, x, y, z, Math.min(g, y + 0.5), b.weight[i], b.ricochet[i] === 1, shooter);
        this.s.lastFrameEffects++;
      }
      for (let i = 0; i < this.detCount; i++) {
        const q = this.det[i];
        this.playDetonation(fx, q.x, q.y, q.z, ground(q.x, q.z, q.y - 0.5), SURFACES[q.b] ?? 'dirt');
      }
      for (let i = 0; i < this.killCount; i++) {
        const q = this.kills[i];
        this.playDestroyed(fx, q.x, q.y, q.z, ground(q.x, q.z, q.y), KINDS[q.a] ?? 'tank', q.b, q.t);
      }
      // Due secondaries.
      for (const p of this.pending) {
        if (p.kind === PendKind.None || p.at > this.now) continue;
        p.kind = PendKind.None;
        const g = ground(p.x, p.z, p.y);
        fx.explosion(p.x, g + 1.2, p.z, g, p.size);
        this.hotFragments(p.x, g + 1.5, p.z, Math.round(10 * p.size), 25, 60);
        this.addBlast(p.x, g + 1, p.z, p.size * 0.8);
        this.s.secondaries++;
      }
    }
    this.batch.clear();
    this.detCount = 0;
    this.killCount = 0;

    // Streaks: they stay near their impact — use the ground under the camera's area of interest.
    let gy = -1e9;
    for (let i = 0; i < this.streaks.capacity; i++) {
      if (!this.streaks.alive[i]) continue;
      gy = ground(this.streaks.px[i], this.streaks.pz[i], -1e9);
      break;
    }
    this.streaks.step(dt, gy);

    let pend = 0;
    for (const p of this.pending) if (p.kind !== PendKind.None) pend++;
    let blasts = 0;
    for (const bl of this.blasts) {
      if (!bl.used) continue;
      const d = this.cam.set ? Math.hypot(bl.x - this.cam.x, bl.y - this.cam.y, bl.z - this.cam.z) : 1e9;
      if (this.now - bl.t0 > soundArrivalS(d) + 8 * C.shake.blastTau) bl.used = false;
      else blasts++;
    }
    this.s.pending = pend;
    this.s.blasts = blasts;
    this.s.streaks = this.streaks.count;
  }

  /** Camera shake 0..1 now: the gun (cockpit / outside, × spin) and every blast whose wave has arrived. */
  shake(cockpit: boolean, gunSpin: number, gunFiring: boolean): number {
    let v = gunShake(gunSpin, gunFiring, cockpit);
    if (this.cam.set) {
      for (const bl of this.blasts) {
        if (!bl.used) continue;
        const d = Math.hypot(bl.x - this.cam.x, bl.y - this.cam.y, bl.z - this.cam.z);
        v = combineShake(v, blastShake(bl.size, d, this.now - bl.t0));
      }
    }
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
  }

  reset(): void {
    this.batch.clear();
    this.streaks.clear();
    this.detCount = 0;
    this.killCount = 0;
    this.hitCount = 0;
    for (const p of this.pending) p.kind = PendKind.None;
    for (const b of this.blasts) b.used = false;
    const s = this.s;
    s.impacts = 0; s.lastFrameEffects = 0; s.flashes = 0; s.detonations = 0; s.destroyed = 0;
    s.secondaries = 0; s.streaks = 0; s.pending = 0; s.blasts = 0;
  }

  stats(): CombatFxStats {
    let pend = 0;
    for (const p of this.pending) if (p.kind !== PendKind.None) pend++;
    this.s.pending = pend;
    this.s.streaks = this.streaks.count;
    return { ...this.s };
  }

  // ── Recipes ─────────────────────────────────────────────────────────────────

  private resetTpl(): ParticleInit {
    const t = this.tpl;
    t.x = t.y = t.z = t.vx = t.vy = t.vz = 0;
    t.life = 1; t.size0 = 1; t.size1 = 1; t.growTau = 1; t.drag = 0; t.buoyancy = 0; t.buoyTau = 1e9; t.gravity = 0;
    t.alpha = 1; t.fadeIn = 0; t.fadeOut = 0; t.visibleAt = 0; t.rot = this.rnd() * 6.2832; t.rotRate = 0;
    t.heat = 0; t.heatTau = 1; t.r = t.g = t.b = 0.5; t.lighten = 0; t.tile = Math.floor(this.rnd() * 4);
    t.groundY = -1e9; t.bounce = 0; t.friction = 0; t.turbulence = 0; t.seed = this.rnd();
    return t;
  }

  private addBlast(x: number, y: number, z: number, size: number): void {
    let slot = this.blasts[0];
    for (const b of this.blasts) {
      if (!b.used) {
        slot = b;
        break;
      }
      if (b.t0 < slot.t0) slot = b;
    }
    slot.used = true;
    slot.t0 = this.now;
    slot.x = x; slot.y = y; slot.z = z;
    slot.size = size;
  }

  private addPending(at: number, x: number, y: number, z: number, size: number): void {
    let slot: Pending | null = null;
    for (const p of this.pending) {
      if (p.kind === PendKind.None) {
        slot = p;
        break;
      }
    }
    if (!slot) {
      // Full: replace the one due last (the others keep their moment).
      slot = this.pending[0];
      for (const p of this.pending) if (p.at > slot.at) slot = p;
    }
    slot.kind = PendKind.Secondary;
    slot.at = at;
    slot.x = x; slot.y = y; slot.z = z;
    slot.size = size;
  }

  /** The white-yellow HEI/API sparkle: one tiny, very hot, very brief sprite. */
  private flash(fx: FxSim, x: number, y: number, z: number, size: number, heat = 1.4): void {
    const t = this.resetTpl();
    t.x = x; t.y = y; t.z = z;
    t.life = this.range(C.flashLife);
    t.size0 = size * 0.55;
    t.size1 = size;
    t.growTau = 0.025;
    t.alpha = 0.85;
    t.fadeOut = 0.5;
    t.heat = heat;
    t.heatTau = 0.07;
    t.r = t.g = t.b = 0.02;
    fx.fire.emit(t);
    this.s.flashes++;
  }

  /** Sparks: fast glowing streaks around the direction (dx,dy,dz) (unit), spread `spread` (0 = tight, 1 = hemisphere). */
  private sparks(x: number, y: number, z: number, dx: number, dy: number, dz: number, n: number, speed: readonly [number, number], spread: number, width = 0.05): void {
    for (let k = 0; k < n; k++) {
      let vx = dx + this.sym(spread);
      let vy = dy + this.sym(spread) * 0.6 + 0.25 * spread;
      let vz = dz + this.sym(spread);
      const m = Math.hypot(vx, vy, vz) || 1;
      const sp = this.range(speed);
      vx = (vx / m) * sp; vy = (vy / m) * sp; vz = (vz / m) * sp;
      this.streaks.emit(x, y, z, vx, vy, vz, 0.25 + 0.55 * this.rnd(), width * (0.7 + 0.6 * this.rnd()), 1.25 + 0.25 * this.rnd(), 0.15 + 0.3 * this.rnd(), 9.81, 1.4);
    }
  }

  /** Hot fragments flung out in every direction (upper hemisphere), as streaks. */
  private hotFragments(x: number, y: number, z: number, n: number, v0: number, v1: number): void {
    for (let k = 0; k < n; k++) {
      const th = this.rnd() * 6.2832;
      const up = 0.15 + 0.85 * this.rnd();
      const ca = Math.sqrt(1 - up * up);
      const sp = v0 + (v1 - v0) * this.rnd();
      this.streaks.emit(x, y, z, Math.cos(th) * ca * sp, up * sp, Math.sin(th) * ca * sp, 0.5 + 0.9 * this.rnd(), 0.08 + 0.06 * this.rnd(), 1.15 + 0.25 * this.rnd(), 0.4 + 0.4 * this.rnd(), 9.81, 0.6);
    }
  }

  private playImpact(fx: FxSim, cls: string, surface: string, x: number, y: number, z: number, g: number, weight: number, ricochet: boolean, shooter: Vec3 | null): void {
    // Incoming direction (from the shooter), for sparks and ricochets.
    let dx = 0, dy = -1, dz = 0;
    if (shooter && Number.isFinite(shooter.x + shooter.y + shooter.z)) {
      const ix = x - shooter.x, iy = y - shooter.y, iz = z - shooter.z;
      const m = Math.hypot(ix, iy, iz);
      if (m > 1) {
        dx = ix / m; dy = iy / m; dz = iz / m;
      }
    }
    const w = Math.max(1, Math.min(4, fin(weight, 1)));
    const k = Math.min(3, w);
    const big = Math.sqrt(w);
    const alb = dustAlbedo(surface);
    switch (cls) {
      case 'armour': this.armour(fx, x, y, z, dx, dy, dz, k, big, ricochet); break;
      case 'water': this.water(fx, x, g, z, k, big); break;
      case 'hard': this.hard(fx, x, g, z, dx, dz, k, big, alb); break;
      default: this.soil(fx, x, g, z, dx, dz, k, big, alb, cls === 'snow'); break;
    }
  }

  private soil(fx: FxSim, x: number, g: number, z: number, dx: number, dz: number, k: number, big: number, alb: readonly [number, number, number], snow: boolean): void {
    const S = C.soil;
    // Ejecta: dark dirt thrown up in a cone, leaning downrange.
    const ne = Math.round(S.ejecta * k);
    for (let i = 0; i < ne; i++) {
      const t = this.resetTpl();
      const sp = this.range(S.ejectaSpeed) * (0.85 + 0.15 * big);
      const lean = 0.35 * this.rnd();
      let vx = this.sym(0.45) + dx * lean, vz = this.sym(0.45) + dz * lean;
      const vy = 1;
      const m = Math.hypot(vx, vy, vz);
      vx /= m; vz /= m;
      t.x = x + this.sym(0.4); t.y = g + 0.2; t.z = z + this.sym(0.4);
      t.vx = vx * sp; t.vy = (vy / m) * sp; t.vz = vz * sp;
      t.life = this.range(S.ejectaLife);
      t.size0 = this.range(S.ejectaSize) * 0.6;
      t.size1 = this.range(S.ejectaSize) * (1 + 0.25 * big);
      t.growTau = 0.35;
      t.gravity = 9.81;
      t.drag = 1.1;
      t.alpha = snow ? 0.6 : 0.85;
      t.fadeIn = 0.02;
      t.fadeOut = 0.5;
      const dark = snow ? 0.95 : 0.42 + 0.15 * this.rnd();
      t.r = alb[0] * dark; t.g = alb[1] * dark; t.b = alb[2] * dark;
      t.lighten = snow ? 0 : 0.6;
      t.turbulence = 0.5;
      t.groundY = g;
      fx.smoke.emit(t);
    }
    // Billowing dust that lingers (merges into the carpet).
    const np = S.puffs + (k > 1.5 ? 1 : 0);
    for (let i = 0; i < np; i++) {
      const t = this.resetTpl();
      t.x = x + this.sym(1.2); t.y = g + 0.6 + this.rnd(); t.z = z + this.sym(1.2);
      t.vx = this.sym(1.8) + dx * 2; t.vy = this.range(S.puffRise); t.vz = this.sym(1.8) + dz * 2;
      t.life = this.range(S.puffLife);
      t.size0 = 2.6 + 1.2 * this.rnd();
      t.size1 = this.range(S.puffSize) * (0.85 + 0.25 * big);
      t.growTau = 0.9 + 0.8 * this.rnd();
      t.drag = 1.3;
      t.buoyancy = 0.5;
      t.buoyTau = 2;
      t.alpha = S.puffAlpha * (0.8 + 0.3 * this.rnd());
      t.fadeIn = 0.06;
      t.fadeOut = 0.62;
      const sh = 0.9 + 0.2 * this.rnd();
      t.r = alb[0] * sh; t.g = alb[1] * sh; t.b = alb[2] * sh;
      t.lighten = snow ? 0 : 0.12;
      t.rotRate = this.sym(0.3);
      t.turbulence = 1.2;
      t.groundY = g;
      fx.smoke.emit(t);
    }
    // HEI sparkle (the PGU-13 rounds of the combat mix) — merged impacts always sparkle.
    if (!snow && (k > 1.5 || this.rnd() < C.flashChanceSoil)) {
      this.flash(fx, x + this.sym(0.4), g + 0.5, z + this.sym(0.4), this.range(C.flashSize) * (0.8 + 0.2 * big));
      this.sparks(x, g + 0.4, z, 0, 1, 0, 2, [10, 25], 0.9, 0.04);
    }
  }

  private hard(fx: FxSim, x: number, g: number, z: number, dx: number, dz: number, k: number, big: number, alb: readonly [number, number, number]): void {
    const H = C.hard;
    // Sparks skitter on, downrange and up.
    this.sparks(x, g + 0.15, z, dx * 0.9, 0.45, dz * 0.9, Math.round(H.sparks * k), [15, 45], 0.8);
    for (let i = 0; i < Math.round(H.chips * k); i++) {
      const t = this.resetTpl();
      t.x = x; t.y = g + 0.2; t.z = z;
      t.vx = this.sym(4) + dx * 4; t.vy = 5 + 6 * this.rnd(); t.vz = this.sym(4) + dz * 4;
      t.life = 0.7 + 0.5 * this.rnd();
      t.size0 = 0.4; t.size1 = 0.9;
      t.growTau = 0.3;
      t.gravity = 9.81;
      t.drag = 0.8;
      t.alpha = 0.6;
      t.fadeOut = 0.5;
      t.r = alb[0] * 0.5; t.g = alb[1] * 0.5; t.b = alb[2] * 0.5;
      t.groundY = g;
      fx.smoke.emit(t);
    }
    for (let i = 0; i < H.puffs + (k > 1.5 ? 1 : 0); i++) {
      const t = this.resetTpl();
      t.x = x + this.sym(0.6); t.y = g + 0.5; t.z = z + this.sym(0.6);
      t.vx = this.sym(1.2); t.vy = 1.2 + 1.5 * this.rnd(); t.vz = this.sym(1.2);
      t.life = this.range(H.puffLife);
      t.size0 = 1; t.size1 = this.range(H.puffSize) * (0.85 + 0.2 * big);
      t.growTau = 0.9;
      t.drag = 1.4;
      t.buoyancy = 0.3;
      t.alpha = H.puffAlpha;
      t.fadeIn = 0.04;
      t.fadeOut = 0.6;
      const sh = 0.9 + 0.2 * this.rnd();
      t.r = alb[0] * sh; t.g = alb[1] * sh; t.b = alb[2] * sh;
      t.lighten = 0.15;
      t.turbulence = 1;
      t.groundY = g;
      fx.smoke.emit(t);
    }
    if (k > 1.5 || this.rnd() < C.flashChanceHard) this.flash(fx, x, g + 0.35, z, this.range(C.flashSize) * (0.8 + 0.2 * big));
  }

  private water(fx: FxSim, x: number, g: number, z: number, k: number, big: number): void {
    const W = C.water;
    const [r, gg, b] = CONFIG.fx.touchdown.sprayAlbedo;
    for (let i = 0; i < Math.round(W.column * k); i++) {
      const t = this.resetTpl();
      t.x = x + this.sym(0.5); t.y = g + 0.2; t.z = z + this.sym(0.5);
      t.vx = this.sym(1.2); t.vy = this.range(W.columnSpeed) * (0.9 + 0.1 * big); t.vz = this.sym(1.2);
      t.life = 1.5 + 0.9 * this.rnd();
      t.size0 = 0.6;
      t.size1 = this.range(W.columnSize) * (0.9 + 0.2 * big);
      t.growTau = 0.5;
      t.gravity = 9.81;
      t.drag = 0.35;
      t.alpha = 0.55;
      t.fadeIn = 0.02;
      t.fadeOut = 0.5;
      const sh = 0.96 + 0.08 * this.rnd();
      t.r = r * sh; t.g = gg * sh; t.b = b * sh;
      t.lighten = 0.05;
      t.turbulence = 0.4;
      t.groundY = g - 0.3;
      fx.smoke.emit(t);
    }
    for (let i = 0; i < W.mist; i++) {
      const t = this.resetTpl();
      t.x = x + this.sym(1); t.y = g + 1 + 2 * this.rnd(); t.z = z + this.sym(1);
      t.vx = this.sym(1); t.vy = 2 + 2 * this.rnd(); t.vz = this.sym(1);
      t.visibleAt = 0.15 + 0.2 * this.rnd();
      t.life = this.range(W.mistLife);
      t.size0 = 1.5; t.size1 = this.range(W.mistSize) * (0.9 + 0.2 * big);
      t.growTau = 1;
      t.drag = 1.3;
      t.buoyancy = 0.15;
      t.alpha = 0.28;
      t.fadeIn = 0.2;
      t.fadeOut = 0.7;
      t.r = r; t.g = gg; t.b = b;
      t.turbulence = 0.8;
      t.groundY = g;
      fx.smoke.emit(t);
    }
  }

  private armour(fx: FxSim, x: number, y: number, z: number, dx: number, dy: number, dz: number, k: number, big: number, ricochet: boolean): void {
    const A = C.armour;
    // Bounce direction: the round reflected off a face roughly facing back up toward the shooter.
    let nx = -dx, ny = -dy + 0.6, nz = -dz;
    const nm = Math.hypot(nx, ny, nz) || 1;
    nx /= nm; ny /= nm; nz /= nm;
    const dot = dx * nx + dy * ny + dz * nz;
    const rx = dx - 2 * dot * nx, ry = dy - 2 * dot * ny, rz = dz - 2 * dot * nz;
    this.flash(fx, x, y, z, this.range(A.flashSize) * (0.85 + 0.15 * big), 1.5);
    this.sparks(x, y, z, rx * 0.6 + nx * 0.4, ry * 0.6 + ny * 0.4, rz * 0.6 + nz * 0.4, Math.round(A.sparks * k), A.sparkSpeed, 0.9, 0.055);
    const t = this.resetTpl();
    t.x = x; t.y = y + 0.3; t.z = z;
    t.vx = this.sym(0.8); t.vy = 1.5; t.vz = this.sym(0.8);
    t.life = 1.8 + this.rnd();
    t.size0 = 0.6; t.size1 = 2.4 * (0.9 + 0.2 * big);
    t.growTau = 0.6;
    t.drag = 1;
    t.buoyancy = 0.8;
    t.alpha = A.smokeAlpha;
    t.fadeIn = 0.05;
    t.fadeOut = 0.6;
    t.r = t.g = t.b = 0.2;
    t.lighten = 0.5;
    t.turbulence = 0.8;
    fx.smoke.emit(t);
    if (ricochet) {
      // Glances off: most of its speed kept, deflected up and a little sideways, glowing (API incendiary).
      const sp = this.range(C.ricochet.speed);
      let vx = rx + this.sym(0.3), vy = Math.max(0.15, ry) + this.rnd() * 0.3, vz = rz + this.sym(0.3);
      const m = Math.hypot(vx, vy, vz) || 1;
      vx = (vx / m) * sp; vy = (vy / m) * sp; vz = (vz / m) * sp;
      this.streaks.emit(x, y, z, vx, vy, vz, this.range(C.ricochet.life), 0.12, 1.5, 1.2, 9.81, 0.25);
    }
  }

  /** A short, orange-black fireball: hot puffs that grow fast and cool into black smoke puffs. */
  private fireball(fx: FxSim, x: number, y: number, z: number, g: number, n: number, size: number): void {
    const [tr, tg, tb] = CONFIG.fx.crash.smokeTint;
    for (let k = 0; k < n; k++) {
      const t = this.resetTpl();
      const th = this.rnd() * 6.2832;
      const up = 0.2 + 0.8 * this.rnd();
      const ca = Math.sqrt(1 - up * up);
      const sp = (5 + 9 * this.rnd()) * size;
      t.x = x + this.sym(1.2 * size); t.y = Math.max(g + 0.8, y + this.rnd() * 1.5 * size); t.z = z + this.sym(1.2 * size);
      t.vx = Math.cos(th) * ca * sp; t.vy = up * sp * 0.7 + 3; t.vz = Math.sin(th) * ca * sp;
      t.life = 0.5 + 0.45 * this.rnd();
      t.size0 = (2 + 1.2 * this.rnd()) * size;
      t.size1 = (5.5 + 3.5 * this.rnd()) * size;
      t.growTau = 0.12;
      t.drag = 2.5;
      t.buoyancy = 6;
      t.buoyTau = 1;
      t.alpha = 0.95;
      t.fadeIn = 0.015;
      t.fadeOut = 0.5;
      t.heat = 1.0 + 0.25 * this.rnd();
      t.heatTau = 0.28 + 0.12 * this.rnd();
      t.r = 0.03 * tr; t.g = 0.03 * tg; t.b = 0.03 * tb;
      t.rotRate = this.sym(1.5);
      t.turbulence = 3;
      t.groundY = g;
      const px = t.x, py = t.y, pz = t.z, vx = t.vx, vy = t.vy, vz = t.vz, s1 = t.size1;
      fx.fire.emit(t);
      // …and the black puff it leaves.
      const s = this.resetTpl();
      s.x = px; s.y = py; s.z = pz; s.vx = vx * 0.8; s.vy = vy * 0.8; s.vz = vz * 0.8;
      s.visibleAt = 0.2 + 0.15 * this.rnd();
      s.life = 7 + 5 * this.rnd();
      s.size0 = s1 * 0.8;
      s.size1 = s1 * (1.6 + 0.6 * this.rnd());
      s.growTau = 2.5;
      s.drag = 1.4;
      s.buoyancy = 3;
      s.buoyTau = 3;
      s.alpha = 0.85;
      s.fadeIn = 0.3;
      s.fadeOut = 0.6;
      s.heat = 0.2;
      s.heatTau = 0.3;
      s.r = 0.05 * tr; s.g = 0.05 * tg; s.b = 0.05 * tb;
      s.lighten = 1.6;
      s.rotRate = this.sym(0.3);
      s.turbulence = 2;
      s.groundY = g;
      fx.smoke.emit(s);
    }
  }

  private playDetonation(fx: FxSim, x: number, y: number, z: number, g: number, surface: string): void {
    const M = C.missile;
    this.s.detonations++;
    const air = isAirBurst(y, g);
    const cy = air ? y : Math.max(g + 0.3, y);
    fx.flash(x, cy + 1, z, M.flash);
    this.fireball(fx, x, cy, z, air ? cy - 50 : g, 22, M.fireball + 0.25);
    this.hotFragments(x, cy + 0.5, z, 16, 35, 110);
    this.addBlast(x, cy, z, 1);
    if (air) return;
    fx.shockRing(x, g, z, M.ring, surface);
    const alb = dustAlbedo(surface === 'target' ? 'dirt' : surface);
    // Dirt column thrown up.
    for (let k = 0; k < M.dirt; k++) {
      const t = this.resetTpl();
      const sp = this.range(M.dirtSpeed);
      let vx = this.sym(0.35), vz = this.sym(0.35);
      const m = Math.hypot(vx, 1, vz);
      vx /= m; vz /= m;
      t.x = x + this.sym(1.5); t.y = g + 0.5; t.z = z + this.sym(1.5);
      t.vx = vx * sp; t.vy = sp / m; t.vz = vz * sp;
      t.life = 2 + 1.5 * this.rnd();
      t.size0 = 1.4; t.size1 = 3 + 2.5 * this.rnd();
      t.growTau = 0.8;
      t.gravity = 9.81;
      t.drag = 0.6;
      t.alpha = 0.8;
      t.fadeIn = 0.02;
      t.fadeOut = 0.5;
      const dark = 0.45 + 0.2 * this.rnd();
      t.r = alb[0] * dark; t.g = alb[1] * dark; t.b = alb[2] * dark;
      t.lighten = 1;
      t.turbulence = 0.8;
      t.groundY = g;
      fx.smoke.emit(t);
    }
    // Lingering grey-brown smoke and dust.
    for (let k = 0; k < M.smokePuffs; k++) {
      const t = this.resetTpl();
      t.x = x + this.sym(3); t.y = g + 1.5 + 3 * this.rnd(); t.z = z + this.sym(3);
      t.vx = this.sym(2.5); t.vy = 1.5 + 2.5 * this.rnd(); t.vz = this.sym(2.5);
      t.visibleAt = 0.3 * this.rnd();
      t.life = this.range(M.smokeLife);
      t.size0 = 4; t.size1 = this.range(M.smokeSize);
      t.growTau = 3;
      t.drag = 0.7;
      t.buoyancy = 0.9;
      t.buoyTau = 4;
      t.alpha = 0.5;
      t.fadeIn = 0.4;
      t.fadeOut = 0.6;
      const mix = this.rnd();
      t.r = 0.12 + (alb[0] - 0.12) * mix; t.g = 0.11 + (alb[1] - 0.11) * mix; t.b = 0.1 + (alb[2] - 0.1) * mix;
      t.lighten = 0.9;
      t.rotRate = this.sym(0.2);
      t.turbulence = 1.5;
      t.groundY = g;
      fx.smoke.emit(t);
    }
  }

  private playDestroyed(fx: FxSim, x: number, y: number, z: number, g: number, kind: TargetKind, targetId: number, time: number): void {
    const D = C.destroyed;
    const k = (D.size as Record<string, number>)[kind] ?? 0.8;
    this.s.destroyed++;
    const base = Math.max(g, y);
    fx.flash(x, base + 2, z, 1.5 * k);
    // The catastrophic explosion: a fat, short fireball (fuel + ammunition) and its black smoke.
    this.fireball(fx, x, base + 1.2, z, g, Math.round(34 * k), 1.1 + 0.5 * k);
    // Dark debris (hull plates, road wheels, track links), some of it burning.
    const n = Math.round(D.debris * k);
    const t = this.tpl;
    for (let i = 0; i < n; i++) {
      this.resetTpl();
      const th = this.rnd() * 6.2832;
      const up = 0.35 + 0.65 * this.rnd();
      const sp = (8 + 22 * this.rnd()) * (0.7 + 0.3 * k);
      t.x = x + this.sym(1.5); t.y = base + 1.2; t.z = z + this.sym(1.5);
      t.vx = Math.cos(th) * Math.sqrt(1 - up * up) * sp; t.vy = up * sp; t.vz = Math.sin(th) * Math.sqrt(1 - up * up) * sp;
      t.life = 600;
      t.size0 = t.size1 = 0.25 + 0.7 * this.rnd() * this.rnd();
      t.gravity = 9.81;
      t.drag = 0.15;
      t.bounce = 0.25;
      t.friction = 3;
      t.rotRate = this.sym(9);
      t.groundY = g;
      t.heat = this.rnd() < 0.4 ? 1 : 0;
      t.heatTau = 3 + 4 * this.rnd();
      const c = this.rnd();
      if (c < 0.45) { t.r = 0.2; t.g = 0.22; t.b = 0.14; } // olive drab
      else if (c < 0.75) { t.r = 0.07; t.g = 0.065; t.b = 0.06; } // burnt
      else { t.r = 0.27; t.g = 0.19; t.b = 0.12; } // rust / bare steel
      fx.debris.emit(t);
    }
    this.hotFragments(x, base + 1.5, z, Math.round(28 * k), 25, 80);
    this.addBlast(x, base + 1, z, 1.2 * k);
    const plan = secondaryPlan(targetId, kind, time);
    // (not for a kill in the air: the secondary pops on the ground under it — the wreck falls on its own)
    if (plan.delayS !== null && y - g < 20) this.addPending(this.now + plan.delayS, x, base, z, k * (0.5 + 0.6 * plan.size));
  }
}
