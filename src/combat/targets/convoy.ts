/**
 * The march column (PURE, no rendering, allocation-free per step): drives the convoy along the
 * range's track — the real farm lane (an open path: end to end, a pause, every vehicle pivots
 * round where it stopped, and the column comes back tail first) or a trail loop (closed: round and
 * round).
 *
 * Each vehicle is a point on the path (arc length `s`, lateral offset `lat`, + = left of the
 * path's +s direction) with its own travel direction `dir` (±1), speed and a yaw off the path
 * tangent. Followers keep `spacing` behind the vehicle ahead (never closer than `minGap`), the lead
 * brakes to stop at the turning place, and everyone behind stops exactly at its own spacing.
 *
 * Under fire (`alarm`): the column brakes to a halt; after a reaction time each survivor pulls off
 * the road — alternately left and right, never further than the plan's scatter clearance allows —
 * and stops angled off the road (cover). `regroupS` after the last alarm they drive back onto the
 * road, bypass wrecks on it (`bypass` m to the side) and carry on.
 *
 * A hard guard makes overlap impossible: a move that would bring two hulls (or a hull and a parked
 * vehicle) within `margin` of each other is not made.
 */
import { CONFIG } from '../../config';
import type { GroundKind as TargetKind } from '../types';
import { newPathSample, sampleAt, type TrackPath } from './path';
import { mulberry32 } from './rng';

export type UnitMode = 'column' | 'halt' | 'scatter' | 'cover' | 'rejoin' | 'turn';

export interface ConvoyUnit {
  readonly kind: TargetKind;
  readonly slot: number;
  readonly tracked: boolean;
  readonly halfL: number;
  readonly halfW: number;
  alive: boolean;
  mode: UnitMode;
  s: number;
  lat: number;
  /** +1 = travelling toward increasing s. */
  dir: number;
  /** Heading offset from the travel direction, rad (+ = clockwise / to the right). */
  yaw: number;
  yawTarget: number;
  speed: number;
  /** Metres driven (wheels and tracks turn with it). */
  odo: number;
  /** Scatter: lateral offset to reach (signed), reaction time. */
  latTarget: number;
  reactAt: number;
  /** Output pose (world). */
  x: number;
  z: number;
  headingDeg: number;
}

/** A parked (static) hull the column must never touch. */
export interface StaticHull {
  x: number;
  z: number;
  headingDeg: number;
  halfL: number;
  halfW: number;
}

export interface ConvoyRoute {
  path: TrackPath;
  /** Per path station (every ~2 m): clearance to the left / right of +s, m. */
  scatterL: ArrayLike<number>;
  scatterR: ArrayLike<number>;
  /** Open paths: where the lead stops [heading −s, heading +s]. Closed loops: null. */
  ends: [number, number] | null;
}

export interface ConvoyInit {
  kind: TargetKind;
  slot: number;
  s: number;
  /** Direction of travel at the start (+1 up the path). */
  dir?: number;
}

export type ConvoyCfg = typeof CONFIG.combat.range.convoy;

export interface ConvoyDriver {
  readonly units: ConvoyUnit[];
  /** 'drive' | 'endStop' | 'turn' | 'contact' (halted / scattered under fire) | 'regroup'. */
  phase(): string;
  /** Column direction of travel (+1 / −1). */
  dir(): number;
  update(dt: number): void;
  /** Under fire: halt and scatter (again, if already scattered: restarts the regroup clock). */
  alarm(): void;
  /** This unit is destroyed: it stops where it is and becomes an obstacle. */
  kill(i: number): void;
  reset(): void;
  /** Minimum centre distance between any two units' hulls grown by margin: true if some pair overlaps. */
  overlapping(): boolean;
}

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
const TRACKED: Record<TargetKind, boolean> = { tank: true, ifv: true, apc: false, truck: false, aaa: true, fighter: false, attack: false, helo: false } as Record<TargetKind, boolean>;

const wrapPi = (a: number) => {
  let r = a % TAU;
  if (r > Math.PI) r -= TAU;
  if (r <= -Math.PI) r += TAU;
  return r;
};

/** Oriented rectangles (centre, heading rad clockwise from north, half length/width) overlap, grown by `margin`. Allocation-free. */
export function hullsOverlap(ax: number, az: number, ah: number, ahl: number, ahw: number, bx: number, bz: number, bh: number, bhl: number, bhw: number, margin: number): boolean {
  const dx = bx - ax;
  const dz = bz - az;
  const ra = Math.hypot(ahl + margin, ahw + margin);
  const rb = Math.hypot(bhl + margin, bhw + margin);
  if (dx * dx + dz * dz > (ra + rb) * (ra + rb)) return false;
  const afx = Math.sin(ah);
  const afz = -Math.cos(ah);
  const bfx = Math.sin(bh);
  const bfz = -Math.cos(bh);
  // four axes: each rectangle's forward and right
  for (let k = 0; k < 4; k++) {
    let axx: number;
    let axz: number;
    if (k === 0) (axx = afx), (axz = afz);
    else if (k === 1) (axx = -afz), (axz = afx);
    else if (k === 2) (axx = bfx), (axz = bfz);
    else (axx = -bfz), (axz = bfx);
    const pa = Math.abs(afx * axx + afz * axz) * (ahl + margin) + Math.abs(-afz * axx + afx * axz) * (ahw + margin);
    const pb = Math.abs(bfx * axx + bfz * axz) * (bhl + margin) + Math.abs(-bfz * axx + bfx * axz) * (bhw + margin);
    if (Math.abs(dx * axx + dz * axz) > pa + pb) return false;
  }
  return true;
}

export function createConvoyDriver(
  route: ConvoyRoute,
  init: readonly ConvoyInit[],
  statics: readonly StaticHull[] = [],
  cfg: ConvoyCfg = CONFIG.combat.range.convoy,
  classes = CONFIG.combat.targets,
  seed = 1,
): ConvoyDriver {
  const path = route.path;
  const open = !path.closed && route.ends !== null;
  const smp = newPathSample();
  const MARGIN = 0.3;
  const units: ConvoyUnit[] = init.map((q) => ({
    kind: q.kind,
    slot: q.slot,
    tracked: TRACKED[q.kind] ?? true,
    halfL: classes[q.kind].length / 2,
    halfW: classes[q.kind].width / 2,
    alive: true,
    mode: 'column' as UnitMode,
    s: q.s,
    lat: 0,
    dir: q.dir ?? 1,
    yaw: 0,
    yawTarget: 0,
    speed: 0,
    odo: 0,
    latTarget: 0,
    reactAt: 0,
    x: 0,
    z: 0,
    headingDeg: 0,
  }));
  const init0 = init.map((q) => ({ s: q.s, dir: q.dir ?? 1 }));
  let colDir = init0[0]?.dir ?? 1;
  let phase: 'drive' | 'endStop' | 'turn' | 'contact' | 'regroup' = 'drive';
  let clock = 0;
  let phaseT = 0;
  let lastAlarm = -Infinity;
  let rnd = mulberry32(seed);
  const order: number[] = units.map((_, i) => i);

  const wrapS = (s: number) => (path.closed ? ((s % path.length) + path.length) % path.length : Math.max(0, Math.min(path.length, s)));
  /** Signed distance along the path from a to b (closed: shortest way round). */
  const along = (a: number, b: number) => {
    let d = b - a;
    if (path.closed) {
      d = ((d % path.length) + path.length) % path.length;
      if (d > path.length / 2) d -= path.length;
    }
    return d;
  };
  const station = (s: number) => Math.max(0, Math.min(path.n - 1, smp.i + (s - path.s[smp.i] > 1 ? 1 : 0)));
  const clearance = (s: number, side: number): number => {
    sampleAt(path, s, smp);
    const i = station(s);
    return side > 0 ? route.scatterL[i] ?? 0 : route.scatterR[i] ?? 0;
  };

  /** World pose of (s, lat, dir, yaw) → out. */
  const P = { x: 0, z: 0, h: 0 };
  const poseOf = (s: number, lat: number, dir: number, yaw: number) => {
    sampleAt(path, s, smp);
    const nx = smp.tz;
    const nz = -smp.tx;
    P.x = smp.x + nx * lat;
    P.z = smp.z + nz * lat;
    P.h = Math.atan2(smp.tx * dir, -smp.tz * dir) + yaw;
    return P;
  };
  const writePose = (u: ConvoyUnit) => {
    poseOf(u.s, u.lat, u.dir, u.yaw);
    u.x = P.x;
    u.z = P.z;
    u.headingDeg = (((P.h / DEG) % 360) + 360) % 360;
  };

  /** Would unit i at pose P overlap anything (another unit or a parked hull)? */
  const blocked = (i: number, x: number, z: number, h: number): boolean => {
    const u = units[i];
    for (let j = 0; j < units.length; j++) {
      if (j === i) continue;
      const v = units[j];
      if (hullsOverlap(x, z, h, u.halfL, u.halfW, v.x, v.z, v.headingDeg * DEG, v.halfL, v.halfW, MARGIN)) return true;
    }
    for (const q of statics) if (hullsOverlap(x, z, h, u.halfL, u.halfW, q.x, q.z, q.headingDeg * DEG, q.halfL, q.halfW, MARGIN)) return true;
    return false;
  };

  /** Try to move unit i to (s, lat, yaw); keeps the old pose (and stops) if that would touch another hull. */
  const moveTo = (i: number, s: number, lat: number, yaw: number): boolean => {
    const u = units[i];
    const ns = wrapS(s);
    poseOf(ns, lat, u.dir, yaw);
    if (blocked(i, P.x, P.z, P.h)) {
      // allow the move anyway if the unit already overlaps where it is (it must be able to get out)
      if (!blocked(i, u.x, u.z, u.headingDeg * DEG)) {
        u.speed = 0;
        return false;
      }
    }
    const dist = Math.hypot(P.x - u.x, P.z - u.z);
    u.odo += dist + Math.abs(wrapPi(yaw - u.yaw)) * u.halfW;
    u.s = ns;
    u.lat = lat;
    u.yaw = yaw;
    u.x = P.x;
    u.z = P.z;
    u.headingDeg = (((P.h / DEG) % 360) + 360) % 360;
    return true;
  };

  let sortRef = 0;
  const byTravel = (a: number, b: number) => colDir * (along(sortRef, units[b].s) - along(sortRef, units[a].s));

  const turnRate = (u: ConvoyUnit) => (u.tracked ? cfg.turnRateDeg[0] : cfg.turnRateDeg[1]) * DEG;

  /** Pivot toward yawTarget; returns the remaining angle. */
  const pivot = (i: number, dt: number): number => {
    const u = units[i];
    const d = wrapPi(u.yawTarget - u.yaw);
    if (Math.abs(d) < 1e-4) return 0;
    const step = Math.sign(d) * Math.min(Math.abs(d), turnRate(u) * dt);
    moveTo(i, u.s, u.lat, u.yaw + step);
    return wrapPi(u.yawTarget - u.yaw);
  };

  /** Move with speed v along the unit's heading (yaw off its travel direction). */
  const drive = (i: number, v: number, dt: number) => {
    const u = units[i];
    u.speed = v;
    if (v <= 0) return;
    const ds = u.dir * v * Math.cos(u.yaw) * dt;
    const dl = -u.dir * v * Math.sin(u.yaw) * dt;
    moveTo(i, u.s + ds, u.lat + dl, u.yaw);
  };

  const accelTo = (u: ConvoyUnit, vMax: number, dt: number) => Math.max(0, Math.min(vMax, u.speed + cfg.accel * dt));

  /** Column (and rejoin) driving: lead first; followers keep their spacing; precise stops at the ends. */
  const driveColumn = (dt: number) => {
    // order by position along the direction of travel (lead first; loops: relative to one unit)
    sortRef = units[order[0]].s;
    order.sort(byTravel);
    let ahead = -1;
    let k = 0;
    const stopAt = open && route.ends ? (colDir > 0 ? route.ends[1] : route.ends[0]) : NaN;
    for (const i of order) {
      const u = units[i];
      if (!u.alive || (u.mode !== 'column' && u.mode !== 'rejoin')) continue;
      // steer: back onto the road (rejoin), around wrecks on the road (bypass), else straight
      let latGoal = 0;
      if (u.mode === 'column') {
        for (const w of units) {
          if (w.alive || Math.abs(w.lat) > 4) continue;
          const d = colDir * along(u.s, w.s);
          if (d > -(w.halfL + u.halfL + 4) && d < w.halfL + u.halfL + 30) {
            const side = clearance(w.s, 1) >= clearance(w.s, -1) ? 1 : -1;
            latGoal = side * Math.min(cfg.bypass, Math.max(0, clearance(w.s, side) - 1));
          }
        }
      }
      let vMax = cfg.speed;
      const dLat = latGoal - u.lat;
      let yawGoal = 0;
      if (Math.abs(dLat) > 0.05) {
        const rate = Math.max(-1.6, Math.min(1.6, dLat * 0.6));
        const sinY = Math.max(-0.7, Math.min(0.7, (-u.dir * rate) / Math.max(1, u.speed)));
        yawGoal = Math.asin(sinY);
      }
      if (u.mode === 'rejoin') {
        if (Math.abs(u.lat) < 0.4) {
          u.mode = 'column';
        } else {
          yawGoal = u.dir * Math.sign(u.lat) * cfg.scatterAngleDeg * 0.8 * DEG;
          vMax = cfg.scatterSpeed;
        }
      }
      // precise stop at this unit's place at the turning end
      if (open && u.mode === 'column') {
        const myStop = stopAt - colDir * k * cfg.spacing;
        const dist = colDir * (myStop - u.s);
        vMax = Math.min(vMax, Math.sqrt(2 * cfg.brake * Math.max(0, dist - 0.02)));
        if (dist <= 0.05 && u.speed < 0.5) vMax = 0;
      }
      // follow the vehicle ahead
      if (ahead >= 0) {
        const a = units[ahead];
        const gap = colDir * along(u.s, a.s);
        vMax = Math.min(vMax, Math.max(0, a.speed + 0.35 * (gap - cfg.spacing)));
        vMax = Math.min(vMax, Math.sqrt(2 * cfg.brake * Math.max(0, gap - cfg.minGap)));
      }
      // turn toward the goal yaw (pivot when far off, steer when close)
      u.yawTarget = yawGoal;
      const off = Math.abs(wrapPi(yawGoal - u.yaw));
      if (off > 25 * DEG) {
        u.speed = 0;
        pivot(i, dt);
      } else {
        const step = Math.sign(wrapPi(yawGoal - u.yaw)) * Math.min(off, turnRate(u) * dt * 1.5);
        u.yaw = wrapPi(u.yaw + step);
        drive(i, accelTo(u, vMax, dt), dt);
      }
      ahead = i;
      k++;
    }
  };

  const allStopped = () => units.every((u) => !u.alive || u.speed < 0.02);

  const startScatter = (i: number) => {
    const u = units[i];
    const want = cfg.scatter[0] + (cfg.scatter[1] - cfg.scatter[0]) * rnd();
    const a = cfg.scatterAngleDeg * DEG;
    const pref = u.slot % 2 === 0 ? 1 : -1;
    let best = 0;
    let bestSide = pref;
    for (const side of [pref, -pref]) {
      // clearance over the stations the diagonal passes
      const run = want / Math.tan(a);
      let m = want;
      for (let d = 0; d <= run + 2; d += 2) m = Math.min(m, clearance(wrapS(u.s + u.dir * d), side) - u.halfW - 0.5);
      if (m > best + 3) {
        best = m;
        bestSide = side;
      }
      if (m >= cfg.scatter[0]) break;
    }
    if (best < 5) {
      u.mode = 'cover';
      return;
    }
    u.mode = 'scatter';
    u.latTarget = bestSide * best;
    // yaw that moves toward +lat for this travel direction: −dir·sin(yaw) has the sign of side
    u.yawTarget = -u.dir * bestSide * a;
  };

  const update = (dt: number) => {
    if (!(dt > 0) || units.length === 0) return;
    dt = Math.min(dt, 0.1);
    clock += dt;
    phaseT += dt;
    switch (phase) {
      case 'drive': {
        driveColumn(dt);
        if (open && phaseT > 1 && allStopped()) {
          phase = 'endStop';
          phaseT = 0;
        }
        break;
      }
      case 'endStop': {
        for (const u of units) u.speed = 0;
        if (phaseT >= cfg.endPauseS) {
          phase = 'turn';
          phaseT = 0;
          for (const u of units) {
            if (!u.alive) continue;
            u.mode = 'turn';
            u.yawTarget = (u.slot % 2 === 0 ? 1 : -1) * Math.PI * 0.999;
          }
        }
        break;
      }
      case 'turn': {
        let busy = false;
        units.forEach((u, i) => {
          if (!u.alive || u.mode !== 'turn') return;
          const left = pivot(i, dt);
          if (Math.abs(left) < 1e-3) {
            // turned round: the same heading is now yaw 0 in the other direction of travel
            u.dir = -u.dir;
            u.yaw = 0;
            u.yawTarget = 0;
            u.mode = 'column';
            writePose(u);
          } else busy = true;
        });
        if (!busy && phaseT > 0.5) {
          colDir = -colDir;
          phase = 'drive';
          phaseT = -cfg.endPauseS; // (the pause before moving off counts toward the next stop check)
          for (const u of units) if (u.alive && u.dir !== colDir) flipDir(u);
        }
        break;
      }
      case 'contact': {
        units.forEach((u, i) => {
          if (!u.alive) return;
          if (u.mode === 'halt' || u.mode === 'column' || u.mode === 'turn') {
            u.mode = 'halt';
            u.speed = Math.max(0, u.speed - cfg.brake * dt);
            drive(i, u.speed, dt);
            if (clock >= u.reactAt && u.speed < 0.3) startScatter(i);
          } else if (u.mode === 'scatter') {
            const left = Math.abs(wrapPi(u.yawTarget - u.yaw));
            if (left > 20 * DEG) {
              u.speed = 0;
              pivot(i, dt);
            } else {
              pivot(i, dt);
              const togo = Math.abs(u.latTarget) - Math.abs(u.lat);
              const v = togo > 0.3 ? Math.min(accelTo(u, cfg.scatterSpeed, dt), Math.sqrt(2 * cfg.brake * togo)) : 0;
              drive(i, v, dt);
              if (togo <= 0.3 || Math.sign(u.lat) !== Math.sign(u.latTarget) && Math.abs(u.lat) > 1) {
                u.mode = 'cover';
                u.speed = 0;
              }
            }
          } else if (u.mode === 'cover') {
            u.speed = Math.max(0, u.speed - cfg.brake * dt);
            drive(i, u.speed, dt);
          }
        });
        if (clock - lastAlarm >= cfg.regroupS && units.every((u) => !u.alive || u.mode === 'cover')) {
          phase = 'regroup';
          phaseT = 0;
          for (const u of units) {
            if (!u.alive) continue;
            if (u.dir !== colDir) flipDir(u);
            u.mode = Math.abs(u.lat) < 0.4 ? 'column' : 'rejoin';
          }
        }
        break;
      }
      case 'regroup': {
        driveColumn(dt);
        if (units.every((u) => !u.alive || u.mode === 'column')) {
          phase = 'drive';
          phaseT = 0;
        }
        break;
      }
    }
  };

  /** Same heading, other direction of travel. */
  const flipDir = (u: ConvoyUnit) => {
    u.dir = -u.dir;
    u.yaw = wrapPi(u.yaw + Math.PI);
    u.yawTarget = wrapPi(u.yawTarget + Math.PI);
  };

  const reset = () => {
    rnd = mulberry32(seed);
    clock = 0;
    phaseT = 0;
    lastAlarm = -Infinity;
    phase = 'drive';
    colDir = init0[0]?.dir ?? 1;
    units.forEach((u, i) => {
      u.alive = true;
      u.mode = 'column';
      u.s = init0[i].s;
      u.dir = init0[i].dir;
      u.lat = 0;
      u.yaw = 0;
      u.yawTarget = 0;
      u.speed = 0;
      u.odo = 0;
      u.latTarget = 0;
      u.reactAt = 0;
      writePose(u);
    });
  };
  reset();

  return {
    units,
    phase: () => phase,
    dir: () => colDir,
    update,
    alarm() {
      lastAlarm = clock;
      if (phase === 'contact') return;
      phase = 'contact';
      phaseT = 0;
      for (const u of units) {
        if (!u.alive) continue;
        u.reactAt = clock + cfg.reactS[0] + (cfg.reactS[1] - cfg.reactS[0]) * rnd();
        if (u.mode === 'rejoin' || u.mode === 'column' || u.mode === 'turn') u.mode = 'halt';
      }
    },
    kill(i) {
      const u = units[i];
      if (!u || !u.alive) return;
      u.alive = false;
      u.speed = 0;
    },
    reset,
    overlapping() {
      for (let i = 0; i < units.length; i++) {
        const a = units[i];
        for (let j = i + 1; j < units.length; j++) {
          const b = units[j];
          if (hullsOverlap(a.x, a.z, a.headingDeg * DEG, a.halfL, a.halfW, b.x, b.z, b.headingDeg * DEG, b.halfL, b.halfW, 0)) return true;
        }
        for (const q of statics) if (hullsOverlap(a.x, a.z, a.headingDeg * DEG, a.halfL, a.halfW, q.x, q.z, q.headingDeg * DEG, q.halfL, q.halfW, 0)) return true;
      }
      return false;
    },
  };
}
