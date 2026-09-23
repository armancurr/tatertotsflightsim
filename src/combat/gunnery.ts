/**
 * PURE gun system core (no three.js), driven by src/game/systems/weapons.ts and by the headless tests:
 *
 *   adjustControls  — steps the barrels/ammo (gun.ts) before the physics; returns gunFiring (recoil)
 *   update          — spawns this frame's rounds at their sub-frame times along the muzzle's path,
 *                     flies every round (ballistics.ts), tests each step against the target hulls
 *                     (world.raycast) and the ground/water (ground.ts), applies hits, emits the
 *                     gun events, solves the CCIP and writes the GUN fields of world.status
 *
 * Damage: every round is `gun.damage` before armour (world.applyHit scales it by the struck face).
 * The combat mix fires one PGU-13 HEI in five: it bursts on impact — on the ground its splash is a
 * world.applyBlast (damage × 0.5 within splashRadiusM); on a vehicle it does its direct damage and
 * the same splash to the OTHER vehicles near it (fragments don't go through the armour of the one it
 * burst on). PGU-14 API rounds striking a tank's sloped glacis at a shallow angle glance off
 * (impact.ricochet, no damage) and fly on briefly.
 *
 * Allocation-free per round except the event objects (a few per frame).
 */
import { CONFIG, type GunConfig } from '../config';
import type { Controls, Environment, Quat, Vec3 } from '../types';
import type { CombatWorld } from './world';
import type { RayHit } from './types';
import { createGunState, newGunStep, reloadGun, stepGun, disperse, GUN_MAX_ROUNDS_PER_STEP, type GunState } from './gun';
import { createRng } from './rng';
import { newBallistic, stepBallistic } from './ballistics';
import { segmentSurfaceHit, surfaceHeight, type SurfaceHit } from './ground';
import { computeCcip, newCcip, TERRAIN_SLOPE_BOUND } from './ccip';
import { RoundPool, ROUND_HEI, ROUND_RICOCHET, ROUND_TRACER } from './rounds';

export interface GunPose {
  position: Vec3;
  orientation: Quat;
}

export interface GunneryOptions {
  seed?: number;
  /** Pool size (default CONFIG.combat.maxRounds). */
  maxRounds?: number;
}

export interface Gunnery {
  readonly pool: RoundPool;
  readonly gunState: GunState;
  readonly gun: GunConfig | null;
  /** Muzzle position and gun-line direction (world) at the last update — for the renderers. */
  readonly muzzle: Vec3;
  readonly gunDir: Vec3;
  /** Seconds the current burst has been firing (0 when not firing). */
  readonly burstTime: number;
  setGun(gun: GunConfig | null, time: number): void;
  /** Reset: full drum, nothing in flight, barrels stopped (emits gunStop for an open burst, then reload). */
  reload(time: number): void;
  adjustControls(controls: Controls, crashed: boolean, dt: number): Controls;
  update(pose: GunPose, velocity: Vec3, dt: number, time: number, paused?: boolean): void;
  stats(): { inFlight: number; tracers: number; impacts: number; ccipMs: number };
}

/** One-way sub-step of a round, s (≈ 17 m at the muzzle). */
const MAX_SUB = 1 / 60;
/** T-72-style upper glacis slope from the vertical, deg; API rounds meeting it flatter than RICOCHET_DEG glance off. */
const GLACIS_DEG = 68;
const RICOCHET_DEG = 30;
/** Armour thicker than this (front damage factor ≤) can make rounds glance. */
const RICOCHET_ARMOR = 0.35;
/** A ricochet keeps this fraction of its speed and lives at most this long. */
const RICOCHET_KEEP = 0.35;
const RICOCHET_LIFE = 0.8;

const DEG = Math.PI / 180;

/** Rotate body (x,y,z) by q into out (no allocation). */
function rotate(q: Quat, x: number, y: number, z: number, out: Vec3): Vec3 {
  const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;
  out.x = ix * qw + iw * -qx + iy * -qz - iz * -qy;
  out.y = iy * qw + iw * -qy + iz * -qx - ix * -qz;
  out.z = iz * qw + iw * -qz + ix * -qy - iy * -qx;
  return out;
}

export function createGunnery(world: CombatWorld, env: Environment, opts: GunneryOptions = {}): Gunnery {
  const pool = new RoundPool(opts.maxRounds ?? CONFIG.combat.maxRounds);
  const rng = createRng(opts.seed ?? 0x6a08);
  let gun: GunConfig | null = null;
  const gunState = createGunState(null);
  const step = newGunStep();
  const times = new Float64Array(GUN_MAX_ROUNDS_PER_STEP);
  // Rounds due this frame (from adjustControls) and the burst edges to report.
  let pending = 0;
  let windowDt = 0;
  let startedPending = false;
  let stoppedPending = false;
  let stoppedBurst = 0;
  let serial = 0;
  let burstTime = 0;
  let impacts = 0;
  let ccipMs = 0;

  // Pose scratch.
  const muzzle = { x: 0, y: 0, z: 0 };
  const gunDir = { x: 0, y: 0, z: -1 };
  const right = { x: 1, y: 0, z: 0 };
  const up = { x: 0, y: 1, z: 0 };
  const prevMuzzle = { x: 0, y: 0, z: 0 };
  const prevDir = { x: 0, y: 0, z: -1 };
  let havePrev = false;
  const off = { a: 0, b: 0 };
  const B = newBallistic();
  const P0 = { x: 0, y: 0, z: 0 };
  const P1 = { x: 0, y: 0, z: 0 };
  const HIT: SurfaceHit = { x: 0, y: 0, z: 0, water: false };
  const ccip = newCcip();
  const ccipPoint = { x: 0, y: 0, z: 0 };
  // Target broad phase (refreshed each update): AABB of every hull, padded.
  let tMinX = 0, tMaxX = 0, tMinZ = 0, tMaxZ = 0, tMaxY = 0, haveTargets = false;
  let now = 0;

  const writeStatus = () => {
    const s = world.status;
    s.hasGun = !!gun;
    s.gunName = gun ? gun.name : '';
    s.rounds = gun ? gunState.rounds : 0;
    s.maxRounds = gun ? gun.rounds : 0;
    s.gunSpin = gunState.spin;
    s.gunFiring = gunState.firing;
  };

  const refreshTargetBounds = () => {
    haveTargets = false;
    for (const t of world.targets) {
      const c = world.classOf(t.kind);
      const r = 0.5 * Math.hypot(c.length, c.width) + 1;
      if (!haveTargets) {
        tMinX = t.position.x - r; tMaxX = t.position.x + r; tMinZ = t.position.z - r; tMaxZ = t.position.z + r; tMaxY = t.position.y + c.height + 1;
        haveTargets = true;
      } else {
        tMinX = Math.min(tMinX, t.position.x - r); tMaxX = Math.max(tMaxX, t.position.x + r);
        tMinZ = Math.min(tMinZ, t.position.z - r); tMaxZ = Math.max(tMaxZ, t.position.z + r);
        tMaxY = Math.max(tMaxY, t.position.y + c.height + 1);
      }
    }
  };

  const mayHitTargets = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) =>
    haveTargets && Math.min(y0, y1) <= tMaxY && Math.max(x0, x1) >= tMinX && Math.min(x0, x1) <= tMaxX && Math.max(z0, z1) >= tMinZ && Math.min(z0, z1) <= tMaxZ;

  /** HEI fragments on every live vehicle near `c` except the one it burst on (same fall-off as world.applyBlast). */
  const splashOthers = (cx: number, cy: number, cz: number, radius: number, damage: number, excludeId: number) => {
    for (const t of world.targets) {
      if (!t.alive || t.id === excludeId) continue;
      const cls = world.classOf(t.kind);
      const r = t.headingDeg * DEG;
      const co = Math.cos(r), si = Math.sin(r);
      const dx = cx - t.position.x, dz = cz - t.position.z;
      const lx = dx * co + dz * si, lz = dz * co - dx * si, ly = cy - t.position.y;
      const qx = Math.max(Math.abs(lx) - cls.width / 2, 0);
      const qz = Math.max(Math.abs(lz) - cls.length / 2, 0);
      const qy = ly < 0 ? -ly : Math.max(ly - cls.height, 0);
      const d = Math.sqrt(qx * qx + qy * qy + qz * qz);
      if (d >= radius) continue;
      const tx = t.position.x - cx, ty = t.position.y + cls.height / 2 - cy, tz = t.position.z - cz;
      const n = Math.hypot(tx, ty, tz) || 1;
      world.applyHit(t.id, { weapon: 'gun', damage: damage * (1 - d / radius) ** 2, point: { x: cx, y: cy, z: cz }, direction: { x: tx / n, y: ty / n, z: tz / n }, time: now, face: 'top' });
    }
  };

  /** A round struck a hull. Returns true when it glanced off and flies on (B holds its new state). */
  const hitTarget = (slot: number, r: RayHit, g: GunConfig): boolean => {
    const t = r.target;
    const sp = Math.hypot(B.vx, B.vy, B.vz) || 1;
    const dx = B.vx / sp, dy = B.vy / sp, dz = B.vz / sp;
    const hei = (pool.flags[slot] & ROUND_HEI) !== 0;
    const point = { x: r.point.x, y: r.point.y, z: r.point.z };
    impacts++;
    if (!t.alive) {
      world.emit({ type: 'impact', time: now, weapon: 'gun', point, surface: 'target', targetId: t.id });
      return false;
    }
    const cls = world.classOf(t.kind);
    if (!hei && r.face === 'front' && cls.armor.front <= RICOCHET_ARMOR) {
      // Plate normal of the sloped glacis: the hull's forward tilted up by the slope.
      const h = t.headingDeg * DEG;
      const fx = Math.sin(h), fz = -Math.cos(h);
      const c = Math.cos(GLACIS_DEG * DEG), s = Math.sin(GLACIS_DEG * DEG);
      const nx = fx * c, ny = s, nz = fz * c;
      const dn = dx * nx + dy * ny + dz * nz;
      if (-dn < Math.sin(RICOCHET_DEG * DEG)) {
        world.emit({ type: 'impact', time: now, weapon: 'gun', point, surface: 'target', targetId: t.id, ricochet: true });
        // Mirror about the plate, lose most of the speed, scatter a little.
        const vdn = B.vx * nx + B.vy * ny + B.vz * nz;
        const k = RICOCHET_KEEP;
        B.vx = (B.vx - 2 * vdn * nx) * k + rng.sym(25);
        B.vy = (B.vy - 2 * vdn * ny) * k + rng.sym(25);
        B.vz = (B.vz - 2 * vdn * nz) * k + rng.sym(25);
        B.x = point.x + nx * 0.05;
        B.y = point.y + ny * 0.05;
        B.z = point.z + nz * 0.05;
        pool.flags[slot] |= ROUND_RICOCHET;
        pool.age[slot] = Math.max(pool.age[slot], g.maxFlightS - RICOCHET_LIFE);
        pool.nextCheck[slot] = 0;
        return true;
      }
    }
    world.emit({ type: 'impact', time: now, weapon: 'gun', point, surface: 'target', targetId: t.id });
    world.applyHit(t.id, { weapon: 'gun', damage: g.damage, point, direction: { x: dx, y: dy, z: dz }, time: now, face: r.face });
    if (hei) splashOthers(point.x, point.y, point.z, g.splashRadiusM, g.damage * 0.5, t.id);
    return false;
  };

  const hitGround = (slot: number, g: GunConfig) => {
    impacts++;
    const point = { x: HIT.x, y: HIT.y, z: HIT.z };
    const ricochet = (pool.flags[slot] & ROUND_RICOCHET) !== 0;
    world.emit({ type: 'impact', time: now, weapon: 'gun', point, surface: HIT.water ? 'water' : env.surfaceAt(HIT.x, HIT.z), targetId: null, ...(ricochet ? { ricochet: true } : {}) });
    if (!ricochet && pool.flags[slot] & ROUND_HEI) world.applyBlast(point, g.splashRadiusM, g.damage * 0.5, 'gun', now);
  };

  /** Fly one round for h seconds; frees it on impact or at maxFlightS. */
  const advance = (slot: number, h: number, g: GunConfig) => {
    let rem = h;
    B.x = pool.x[slot]; B.y = pool.y[slot]; B.z = pool.z[slot];
    B.vx = pool.vx[slot]; B.vy = pool.vy[slot]; B.vz = pool.vz[slot];
    while (rem > 1e-9) {
      const sub = rem > MAX_SUB ? MAX_SUB : rem;
      rem -= sub;
      const x0 = B.x, y0 = B.y, z0 = B.z;
      stepBallistic(B, sub, g.dragK);
      const age = pool.age[slot] + sub;
      let tr: RayHit | null = null;
      if (!(pool.flags[slot] & ROUND_RICOCHET) && mayHitTargets(x0, y0, z0, B.x, B.y, B.z)) {
        P0.x = x0; P0.y = y0; P0.z = z0;
        P1.x = B.x; P1.y = B.y; P1.z = B.z;
        tr = world.raycast(P0, P1);
      }
      let gf = -1;
      if (age >= pool.nextCheck[slot]) {
        gf = segmentSurfaceHit(env, x0, y0, z0, B.x, B.y, B.z, HIT, 8);
        if (gf < 0) {
          const c = B.y - surfaceHeight(env, B.x, B.z);
          const closing = TERRAIN_SLOPE_BOUND * Math.hypot(B.vx, B.vz) + Math.max(0, -B.vy) + 1;
          pool.nextCheck[slot] = age + Math.max(0, (c - 3) / closing);
        }
      }
      if (tr) {
        const len = Math.hypot(B.x - x0, B.y - y0, B.z - z0);
        if (gf < 0 || tr.distance <= gf * len) {
          if (!hitTarget(slot, tr, g)) {
            pool.remove(slot);
            return;
          }
          pool.age[slot] = Math.max(pool.age[slot], age);
          continue;
        }
      }
      if (gf >= 0) {
        hitGround(slot, g);
        pool.remove(slot);
        return;
      }
      pool.age[slot] = age;
      if (age >= g.maxFlightS) {
        pool.remove(slot);
        return;
      }
    }
    pool.x[slot] = B.x; pool.y[slot] = B.y; pool.z[slot] = B.z;
    pool.vx[slot] = B.vx; pool.vy[slot] = B.vy; pool.vz[slot] = B.vz;
  };

  const self: Gunnery = {
    pool,
    gunState,
    get gun() {
      return gun;
    },
    muzzle,
    gunDir,
    get burstTime() {
      return burstTime;
    },

    setGun(g, time) {
      gun = g;
      self.reload(time);
    },

    reload(time) {
      now = time;
      if (gunState.firing) world.emit({ type: 'gunStop', time, roundsFired: gunState.burst });
      reloadGun(gunState, gun);
      pool.clear();
      pending = 0;
      startedPending = stoppedPending = false;
      burstTime = 0;
      havePrev = false;
      writeStatus();
      world.status.ccip = null;
      world.status.ccipRangeM = null;
      world.emit({ type: 'reload', time });
    },

    adjustControls(controls, crashed, dt) {
      if (!gun) {
        gunState.spin = 0;
        gunState.firing = false;
        return controls.gunFiring ? { ...controls, gunFiring: false } : controls;
      }
      stepGun(gunState, gun, !!controls.trigger, !crashed, dt, times, step);
      // Accumulate if two control steps happen before an update (keeps every round).
      const base = pending > 0 ? windowDt : 0;
      for (let i = 0; i < step.count && pending < times.length; i++) times[pending++] = base + times[i];
      windowDt = base + (Number.isFinite(dt) && dt > 0 ? dt : 0);
      if (step.started) startedPending = true;
      if (step.stopped) {
        stoppedPending = true;
        stoppedBurst = step.burst;
      }
      return { ...controls, gunFiring: step.firing };
    },

    update(pose, velocity, dtIn, time, paused = false) {
      now = time;
      const dt = !paused && Number.isFinite(dtIn) && dtIn > 0 ? dtIn : 0;
      const g = gun;
      const q = pose.orientation;
      const vx = Number.isFinite(velocity.x) ? velocity.x : 0;
      const vy = Number.isFinite(velocity.y) ? velocity.y : 0;
      const vz = Number.isFinite(velocity.z) ? velocity.z : 0;
      if (g) {
        rotate(q, g.muzzle.x, g.muzzle.y, g.muzzle.z, muzzle);
        muzzle.x += pose.position.x; muzzle.y += pose.position.y; muzzle.z += pose.position.z;
        const dep = g.boresightDownDeg * DEG;
        rotate(q, 0, -Math.sin(dep), -Math.cos(dep), gunDir);
        rotate(q, 1, 0, 0, right);
        rotate(q, 0, 1, 0, up);
      }
      if (!havePrev) {
        prevMuzzle.x = muzzle.x - vx * windowDt; prevMuzzle.y = muzzle.y - vy * windowDt; prevMuzzle.z = muzzle.z - vz * windowDt;
        prevDir.x = gunDir.x; prevDir.y = gunDir.y; prevDir.z = gunDir.z;
      }

      if (g && dt > 0) {
        refreshTargetBounds();
        // Rounds already in flight (backwards: removal swaps the last one in).
        for (let k = pool.count - 1; k >= 0; k--) advance(pool.idx[k], dt, g);
        if (startedPending) world.emit({ type: 'gunStart', time });
        // This frame's rounds, each from where the muzzle was at its own sub-frame time.
        const win = windowDt > 0 ? windowDt : dt;
        for (let i = 0; i < pending; i++) {
          const tt = times[i];
          const f = Math.min(1, Math.max(0, tt / win));
          const tau = Math.max(0, win - tt);
          let dx = prevDir.x + (gunDir.x - prevDir.x) * f;
          let dy = prevDir.y + (gunDir.y - prevDir.y) * f;
          let dz = prevDir.z + (gunDir.z - prevDir.z) * f;
          disperse(rng, g.dispersionMrad, off);
          dx += off.a * right.x + off.b * up.x;
          dy += off.a * right.y + off.b * up.y;
          dz += off.a * right.z + off.b * up.z;
          const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
          serial++;
          world.stats.roundsFired++;
          const slot = pool.spawn();
          if (slot < 0) continue;
          pool.x[slot] = prevMuzzle.x + (muzzle.x - prevMuzzle.x) * f;
          pool.y[slot] = prevMuzzle.y + (muzzle.y - prevMuzzle.y) * f;
          pool.z[slot] = prevMuzzle.z + (muzzle.z - prevMuzzle.z) * f;
          pool.vx[slot] = vx + (g.muzzleVelocity * dx) / l;
          pool.vy[slot] = vy + (g.muzzleVelocity * dy) / l;
          pool.vz[slot] = vz + (g.muzzleVelocity * dz) / l;
          let flags = 0;
          if (g.tracerEvery > 0 && serial % Math.round(g.tracerEvery) === 0) flags |= ROUND_TRACER;
          if (serial % 5 === 2) flags |= ROUND_HEI;
          pool.flags[slot] = flags;
          advance(slot, tau, g);
        }
        if (stoppedPending) world.emit({ type: 'gunStop', time, roundsFired: stoppedBurst });
        burstTime = gunState.firing ? burstTime + dt : 0;
      }
      if (dt > 0 || paused) {
        pending = 0;
        windowDt = 0;
        startedPending = stoppedPending = false;
      }

      // CCIP: a zero-dispersion round fired now.
      const s = world.status;
      if (g) {
        const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
        const mv = g.muzzleVelocity;
        const ok = computeCcip(env, muzzle.x, muzzle.y, muzzle.z, vx + mv * gunDir.x, vy + mv * gunDir.y, vz + mv * gunDir.z, g.dragK, ccip);
        if (ok) {
          ccipPoint.x = ccip.x; ccipPoint.y = ccip.y; ccipPoint.z = ccip.z;
          s.ccip = ccipPoint;
          s.ccipRangeM = ccip.range;
        } else {
          s.ccip = null;
          s.ccipRangeM = null;
        }
        if (typeof performance !== 'undefined') ccipMs += (performance.now() - t0 - ccipMs) * 0.05;
      } else {
        s.ccip = null;
        s.ccipRangeM = null;
      }
      writeStatus();

      prevMuzzle.x = muzzle.x; prevMuzzle.y = muzzle.y; prevMuzzle.z = muzzle.z;
      prevDir.x = gunDir.x; prevDir.y = gunDir.y; prevDir.z = gunDir.z;
      havePrev = !!g;
    },

    stats() {
      let tracers = 0;
      for (let k = 0; k < pool.count; k++) if (pool.flags[pool.idx[k]] & ROUND_TRACER) tracers++;
      return { inFlight: pool.count, tracers, impacts, ccipMs: Math.round(ccipMs * 1000) / 1000 };
    },
  };
  return self;
}
