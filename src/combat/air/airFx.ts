/**
 * Effects for the enemy aircraft on the shared fx pools (FxSim, PURE): decoy flares (white-hot
 * magnesium burning in a falling arc, each trailing white smoke), the falling wreck's trail (a
 * burning core and thick black smoke laid along the path), a thinner trail behind a separated
 * part, the ground impact (explosion + fireball + debris) and the water splash. Fixed pools, no
 * allocation per frame.
 */
import type { FxSim } from '../../fx/sim';
import { newParticleInit, type ParticleInit } from '../../fx/pool';

export interface Flare {
  on: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  life: number;
  nextSmoke: number;
}

const tpl: ParticleInit = newParticleInit();
const DEFAULTS = newParticleInit();

function reset(sim: FxSim): ParticleInit {
  Object.assign(tpl, DEFAULTS);
  tpl.rot = sim.rnd() * 6.2832;
  tpl.seed = sim.rnd();
  tpl.tile = Math.floor(sim.rnd() * 4);
  return tpl;
}

export class FlarePool {
  readonly items: Flare[] = [];
  constructor(n: number) {
    for (let i = 0; i < n; i++) this.items.push({ on: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 0, life: 0, nextSmoke: 0 });
  }

  get active(): number {
    let n = 0;
    for (const f of this.items) if (f.on) n++;
    return n;
  }

  /** Eject one flare from (x,y,z) with the aircraft's velocity + an ejection kick (down and out). */
  eject(x: number, y: number, z: number, vx: number, vy: number, vz: number, kx: number, ky: number, kz: number, life: number): Flare | null {
    let f = this.items.find((i) => !i.on);
    if (!f) {
      // recycle the oldest
      f = this.items.reduce((a, b) => (b.age > a.age ? b : a));
    }
    f.on = true;
    f.x = x;
    f.y = y;
    f.z = z;
    f.vx = vx + kx;
    f.vy = vy + ky;
    f.vz = vz + kz;
    f.age = 0;
    f.life = life;
    f.nextSmoke = 0;
    return f;
  }

  /** Fly the flares (drag slows them to a slow fall) and burn them into the fx pools. */
  step(dt: number, sim: FxSim | null): void {
    if (!(dt > 0)) return;
    const k = Math.exp(-1.6 * dt);
    for (const f of this.items) {
      if (!f.on) continue;
      f.age += dt;
      if (f.age >= f.life) {
        f.on = false;
        continue;
      }
      f.vx *= k;
      f.vz *= k;
      f.vy = f.vy * k - 9.8 * dt * (1 - k * 0.5);
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.z += f.vz * dt;
      if (!sim) continue;
      const burn = 1 - f.age / f.life;
      // the burning pellet
      const t = reset(sim);
      t.x = f.x;
      t.y = f.y;
      t.z = f.z;
      t.life = 0.14;
      t.size0 = 1.6 + 0.8 * burn;
      t.size1 = 0.8;
      t.growTau = 0.1;
      t.alpha = 1;
      t.fadeOut = 0.5;
      t.heat = 1.45;
      t.heatTau = 0.5;
      t.r = t.g = t.b = 0.9;
      sim.fire.emit(t);
      // its white smoke trail
      if (f.age >= f.nextSmoke) {
        f.nextSmoke = f.age + 0.09;
        const s = reset(sim);
        s.x = f.x;
        s.y = f.y;
        s.z = f.z;
        s.vx = f.vx * 0.1;
        s.vy = 0.4;
        s.vz = f.vz * 0.1;
        s.life = 2.6 + sim.rnd();
        s.size0 = 0.9;
        s.size1 = 4.5;
        s.growTau = 1.2;
        s.drag = 0.8;
        s.alpha = 0.42 * burn + 0.1;
        s.fadeIn = 0.05;
        s.fadeOut = 0.7;
        s.r = 0.62;
        s.g = 0.62;
        s.b = 0.64;
        s.lighten = 0.2;
        s.turbulence = 0.6;
        sim.smoke.emit(s);
      }
    }
  }

  clear(): void {
    for (const f of this.items) f.on = false;
  }
}

/**
 * Lay the burning wreck's trail from (x0,y0,z0) to (x1,y1,z1): a black smoke puff every `stepM`
 * metres (big, long-lived) with a flame core; `acc` carries the leftover distance between frames.
 * Returns the new leftover.
 */
export function wreckTrail(sim: FxSim, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, acc: number, stepM: number, heat: number, groundY: number): number {
  const d = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
  if (!(d > 0) || !Number.isFinite(d)) return acc;
  let a = acc + d;
  let n = 0;
  while (a >= stepM && n < 40) {
    a -= stepM;
    n++;
    const u = 1 - a / d;
    const x = x0 + (x1 - x0) * u, y = y0 + (y1 - y0) * u, z = z0 + (z1 - z0) * u;
    const t = reset(sim);
    t.x = x + (sim.rnd() - 0.5) * 1.5;
    t.y = y + (sim.rnd() - 0.5) * 1.5;
    t.z = z + (sim.rnd() - 0.5) * 1.5;
    t.vy = 0.8;
    t.life = 10 + 5 * sim.rnd();
    t.size0 = 7;
    t.size1 = 22 + 9 * sim.rnd();
    t.growTau = 1.3;
    t.drag = 0.7;
    t.buoyancy = 0.6;
    t.buoyTau = 4;
    t.alpha = 0.78;
    t.fadeIn = 0.04;
    t.fadeOut = 0.6;
    const c = 0.03 + 0.03 * sim.rnd();
    t.r = c;
    t.g = c;
    t.b = c * 0.95;
    t.lighten = 1.0;
    t.turbulence = 1.1;
    t.groundY = groundY;
    // only the head of the trail glows (the fire), the rest is black smoke at once
    t.heat = u > 0.6 ? heat * 0.3 : 0;
    t.heatTau = 0.12;
    sim.smoke.emit(t);
    if (heat > 0 && (n & 1) === 0) {
      const f = reset(sim);
      f.x = x;
      f.y = y;
      f.z = z;
      f.vy = 1;
      f.life = 0.45 + 0.25 * sim.rnd();
      f.size0 = 3.5 * heat + 1;
      f.size1 = 5.5 * heat + 1.5;
      f.growTau = 0.3;
      f.alpha = 0.95;
      f.fadeOut = 0.6;
      f.heat = 1.15;
      f.heatTau = 0.4;
      f.r = f.g = f.b = 0.1;
      f.turbulence = 1.5;
      sim.fire.emit(f);
    }
  }
  return a;
}

/** A separated part's thin grey trail (every `stepM` m). */
export function partTrail(sim: FxSim, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, acc: number, stepM: number): number {
  const d = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
  if (!(d > 0) || !Number.isFinite(d)) return acc;
  let a = acc + d;
  let n = 0;
  while (a >= stepM && n < 12) {
    a -= stepM;
    n++;
    const u = 1 - a / d;
    const t = reset(sim);
    t.x = x0 + (x1 - x0) * u;
    t.y = y0 + (y1 - y0) * u;
    t.z = z0 + (z1 - z0) * u;
    t.life = 5 + 2 * sim.rnd();
    t.size0 = 1.2;
    t.size1 = 5;
    t.growTau = 1.5;
    t.drag = 0.8;
    t.alpha = 0.45;
    t.fadeOut = 0.6;
    const c = 0.08 + 0.05 * sim.rnd();
    t.r = c;
    t.g = c;
    t.b = c;
    t.lighten = 1.4;
    t.turbulence = 0.9;
    sim.smoke.emit(t);
  }
  return a;
}

/** The wreck hits the ground: explosion, fireball, flung debris. */
export function groundImpact(sim: FxSim, x: number, g: number, z: number, vx: number, vy: number, vz: number, scale: number): void {
  sim.explosion(x, g + 1.5, z, g, 1.3 * scale);
  sim.fireball(x, g + 2, z, g, vx * 0.3, Math.max(0, vy * 0.1), vz * 0.3, Math.min(1, 0.75 * scale));
  sim.fragments(x, g + 1, z, g, vx * 0.2, 6, vz * 0.2, Math.min(1, 0.8 * scale), true);
}
