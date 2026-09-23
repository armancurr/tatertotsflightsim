/**
 * The range at run time (no rendering, testable in node): registers the planned vehicles with the
 * combat world, keeps each one's visual state (terrain pitch/roll, turret, wreck) in a VehicleView,
 * and turns 'destroyed' events into wrecks — the T-72 turret toss, charring, the hull settling,
 * the fire and the black smoke column on the fx sim (within an emitter budget), ammunition
 * cook-off pops — and damaged vehicles smoking. `reset()` revives everything where it started.
 */
import * as THREE from 'three';
import { CONFIG } from '../../config';
import type { Vec3 } from '../../types';
import type { FxSim } from '../../fx/sim';
import { newParticleInit } from '../../fx/pool';
import type { CombatEvent, GroundTarget, GroundKind as TargetKind } from '../types';
import type { CombatWorld } from '../world';
import type { PlannedVehicle, RangePlan } from './plan';
import { newVehicleView, ringOf, type VehicleView } from './renderer';
import { mulberry32 } from './rng';
import { planToss, tossPose, type TurretToss } from './toss';
import { createConvoyDriver, type ConvoyDriver, type StaticHull } from './convoy';
import { makePath } from './path';

export interface RangeRuntimeGround {
  height(x: number, z: number): number;
  normal(x: number, z: number): Vec3;
}

interface Wreck {
  t0: number;
  toss: TurretToss | null;
  landed: boolean;
  fire: number;
  column: number;
  fireEnd: number;
  columnEnd: number;
  cookEnd: number;
  nextPop: number;
  rnd: () => number;
}

export interface RangeVehicle {
  plan: PlannedVehicle;
  target: GroundTarget;
  view: VehicleView;
  wreck: Wreck | null;
  /** Next damaged-smoke puff time. */
  nextSmoke: number;
  /** Index of its unit in the convoy driver (−1: parked). */
  unit: number;
  /** Turret traverse: where it is heading (rad, hull frame) and when it picks the next bearing. */
  turretGoal: number;
  nextScan: number;
  /** Metres since the last dust puff. */
  dustAcc: number;
}

export interface RangeRuntime {
  readonly vehicles: RangeVehicle[];
  readonly views: VehicleView[];
  /** The march column's driver (null when the plan has no track). */
  readonly convoy: ConvoyDriver | null;
  install(plan: RangePlan): void;
  /** Advance by dt (0 while paused). */
  update(dt: number): void;
  reset(): void;
  time(): number;
  stats(): { vehicles: number; alive: number; wrecks: number; fires: number; columns: number; tossed: number };
  dispose(): void;
}

const DEG = Math.PI / 180;

export function createRangeRuntime(world: CombatWorld, ground: RangeRuntimeGround, fx: () => FxSim | null, cfg = CONFIG.combat): RangeRuntime {
  const W = cfg.range.wreck;
  const vehicles: RangeVehicle[] = [];
  const views: VehicleView[] = [];
  let clock = 0;
  let resets = 0;
  const Qh = new THREE.Quaternion();
  const E = new THREE.Euler(0, 0, 0, 'YXZ');
  const P = new THREE.Vector3();
  const tpl = newParticleInit();

  const pose = (v: RangeVehicle) => {
    const view = v.view;
    const t = v.target;
    view.x = t.position.x;
    view.z = t.position.z;
    view.headingDeg = t.headingDeg;
    const n = ground.normal(view.x, view.z);
    const h = t.headingDeg * DEG;
    const fx = Math.sin(h);
    const fz = -Math.cos(h);
    const ny = Math.max(0.3, n.y);
    view.pitch = Math.atan(-(n.x * fx + n.z * fz) / ny);
    view.roll = Math.atan(-(n.x * -fz + n.z * fx) / ny);
    const settle = v.wreck ? Math.min(1, (clock - v.wreck.t0) / 1.5) * (t.kind === 'truck' ? W.truckSettle : W.settle) : 0;
    view.y = t.position.y - settle;
    view.odo = v.unit >= 0 && convoy ? convoy.units[v.unit].odo : 0;
  };

  const place = (v: RangeVehicle) => {
    const p = v.plan;
    v.target.position.x = p.x;
    v.target.position.z = p.z;
    v.target.position.y = ground.height(p.x, p.z);
    v.target.headingDeg = p.headingDeg;
    v.target.velocity.x = v.target.velocity.y = v.target.velocity.z = 0;
    const view = v.view;
    view.visible = true;
    view.char = 0;
    view.turretFree = false;
    view.turretGone = false;
    view.seed = p.seed;
    view.camo = p.camo;
    // turrets: platoon and AAA point toward the airport side; the column's are traversed alternately
    view.turretYaw = p.group === 'convoy' ? (p.slot % 2 ? 1 : -1) * (0.15 + 0.5 * p.seed) : (p.seed - 0.5) * 0.5;
    v.turretGoal = view.turretYaw;
    v.nextScan = 2 + 6 * p.seed;
    v.dustAcc = 0;
    v.wreck = null;
    v.nextSmoke = 0;
    pose(v);
  };

  /** Convoy vehicles: the driver's pose → the combat target (ground height, velocity). */
  const follow = (v: RangeVehicle, dt: number) => {
    if (!convoy || v.unit < 0) return;
    const u = convoy.units[v.unit];
    const t = v.target;
    if (!t.alive) {
      t.velocity.x = t.velocity.y = t.velocity.z = 0;
      return;
    }
    const y = ground.height(u.x, u.z);
    if (dt > 0) {
      t.velocity.x = (u.x - t.position.x) / dt;
      t.velocity.y = (y - t.position.y) / dt;
      t.velocity.z = (u.z - t.position.z) / dt;
    }
    t.position.x = u.x;
    t.position.y = y;
    t.position.z = u.z;
    t.headingDeg = u.headingDeg;
  };

  /** Turrets traverse between scan bearings (faster and wider in contact); the dead stay put. */
  const slewTurret = (v: RangeVehicle, dt: number) => {
    if (!v.target.alive || v.view.turretFree || v.target.kind === 'truck') return;
    const T = cfg.range.turret;
    const contact = convoy?.phase() === 'contact' && v.unit >= 0;
    if (clock >= v.nextScan) {
      const r = v.plan.seed * 7.31 + clock * 0.137;
      const n = r - Math.floor(r);
      const g = v.plan.group;
      const side = v.plan.slot % 2 ? 1 : -1;
      if (g === 'convoy') v.turretGoal = contact ? side * (0.9 + 0.9 * n) : side * (0.2 + 0.9 * n);
      else if (g === 'aaa') v.turretGoal = (n - 0.5) * 3.2;
      else if (g === 'platoon') v.turretGoal = (n - 0.5) * 0.7;
      else v.turretGoal = (n - 0.5) * 1.6;
      v.nextScan = clock + T.scanS[0] + (T.scanS[1] - T.scanS[0]) * n * (contact ? 0.5 : 1);
    }
    const d = v.turretGoal - v.view.turretYaw;
    const step = T.slewDeg * DEG * dt * (contact ? 1.6 : 1);
    v.view.turretYaw += Math.abs(d) <= step ? d : Math.sign(d) * step;
  };

  const killFx = (w: Wreck) => {
    w.fire = -1;
    w.column = -1;
  };

  const activeCount = (key: 'fire' | 'column') => {
    let n = 0;
    for (const v of vehicles) {
      const w = v.wreck;
      if (!w) continue;
      if (key === 'fire' ? w.fire >= 0 && clock < w.fireEnd : w.column >= 0 && clock < w.columnEnd) n++;
    }
    return n;
  };

  const onDestroyed = (e: Extract<CombatEvent, { type: 'destroyed' }>) => {
    const v = vehicles.find((q) => q.target.id === e.targetId);
    if (!v || v.wreck) return;
    if (convoy && v.unit >= 0) {
      convoy.kill(v.unit);
      convoy.alarm();
    }
    const rnd = mulberry32((v.target.id * 7919) ^ (resets * 104729) ^ 0x51ed);
    const t = v.target;
    const w: Wreck = {
      t0: clock, toss: null, landed: false, fire: -1, column: -1,
      fireEnd: clock + W.fireS[0] + (W.fireS[1] - W.fireS[0]) * rnd(),
      columnEnd: 0,
      cookEnd: clock + W.cookOffS[0] + (W.cookOffS[1] - W.cookOffS[0]) * rnd(),
      nextPop: clock + 0.6 + rnd() * 1.5,
      rnd,
    };
    w.columnEnd = w.fireEnd + W.smokeS[0] + (W.smokeS[1] - W.smokeS[0]) * rnd();
    v.wreck = w;
    t.velocity.x = t.velocity.y = t.velocity.z = 0;
    // T-72: the carousel cooks off and throws the turret ("jack-in-the-box")
    if (t.kind === 'tank' && rnd() < W.tossChance) {
      const ring = ringOf('tank');
      const h = t.headingDeg * DEG;
      P.set(t.position.x + Math.sin(h) * -ring.z, t.position.y + ring.y, t.position.z - Math.cos(h) * -ring.z);
      E.set(v.view.pitch, -h - v.view.turretYaw, v.view.roll, 'YXZ');
      Qh.setFromEuler(E);
      const apex = W.tossHeight[0] + (W.tossHeight[1] - W.tossHeight[0]) * rnd();
      w.toss = planToss(clock, P, Qh, apex, rnd, (x, z) => ground.height(x, z));
      v.view.turretFree = true;
      v.view.turretPos.copy(P);
      v.view.turretQuat.copy(Qh);
    }
    const sim = fx();
    if (sim) {
      const y = t.position.y;
      if (activeCount('fire') < W.maxFires) w.fire = sim.addFire(t.position.x, y + (t.kind === 'truck' ? 1.6 : 1.3), t.position.z, y, 1, w.fireEnd - clock, t.kind === 'truck' ? 2.6 : 2.1, true);
      if (activeCount('column') < W.maxColumns) w.column = sim.addColumn(t.position.x, y, t.position.z, y, t.kind === 'truck' ? 0.75 : 0.95, w.columnEnd - clock);
      if (w.toss) {
        sim.flash(P.x, P.y + 1, P.z, 0.9);
        sim.sparks(P.x, P.y + 0.5, P.z, 0, 14, 0, 60);
      }
    }
  };

  /** Under fire: a convoy vehicle hit, or a blast / rounds landing close to the column. */
  const nearConvoy = (p: Vec3, r: number) => {
    for (const v of vehicles) if (v.unit >= 0 && v.target.alive && Math.hypot(v.target.position.x - p.x, v.target.position.z - p.z) < r) return true;
    return false;
  };
  const unsubscribe = world.on((e) => {
    if (e.type === 'destroyed') onDestroyed(e);
    else if (convoy && e.type === 'hit') {
      const v = vehicles.find((q) => q.target.id === e.targetId);
      if (v && v.unit >= 0) convoy.alarm();
    } else if (convoy && e.type === 'detonation' && nearConvoy(e.position, 120)) convoy.alarm();
    else if (convoy && e.type === 'impact' && e.surface !== 'target' && nearConvoy(e.point, 35)) convoy.alarm();
  });

  /** Dust thrown up behind a moving vehicle: a low, slow, lingering tan cloud (reads from the air). */
  const dustPuff = (sim: FxSim, v: RangeVehicle, speed: number) => {
    const t = tpl;
    Object.assign(t, newParticleInitDefaults);
    const cls = cfg.targets[v.target.kind];
    const h = v.target.headingDeg * DEG;
    const fx = Math.sin(h);
    const fz = -Math.cos(h);
    const back = cls.length * 0.5 + 0.8;
    const side = sim.rnd() - 0.5;
    t.x = v.target.position.x - fx * back + -fz * side * cls.width;
    t.y = v.target.position.y + 0.6;
    t.z = v.target.position.z - fz * back + fx * side * cls.width;
    t.vx = -fx * speed * 0.25 + (sim.rnd() - 0.5) * 1.2;
    t.vy = 0.5 + 0.7 * sim.rnd();
    t.vz = -fz * speed * 0.25 + (sim.rnd() - 0.5) * 1.2;
    t.life = 8 + 5 * sim.rnd();
    t.size0 = 2.2;
    t.size1 = 9 + 6 * sim.rnd();
    t.growTau = 2.6;
    t.drag = 0.9;
    t.buoyancy = 0.3;
    t.buoyTau = 5;
    t.alpha = 0.36;
    t.fadeIn = 0.12;
    t.fadeOut = 0.75;
    const c = cfg.range.convoy.dustColor;
    const sh = 0.85 + 0.3 * sim.rnd();
    t.r = c[0] * sh;
    t.g = c[1] * sh;
    t.b = c[2] * sh;
    t.lighten = 0.2;
    t.turbulence = 1.1;
    t.groundY = v.target.position.y;
    t.tile = Math.floor(sim.rnd() * 4);
    t.rot = sim.rnd() * 6.28;
    sim.smoke.emit(t);
  };

  const smokePuff = (sim: FxSim, x: number, y: number, z: number, g: number, dark: number) => {
    const t = tpl;
    Object.assign(t, newParticleInitDefaults);
    t.x = x + (sim.rnd() - 0.5) * 1.2;
    t.y = y;
    t.z = z + (sim.rnd() - 0.5) * 1.2;
    t.vx = (sim.rnd() - 0.5) * 0.6;
    t.vy = 1.5 + sim.rnd();
    t.vz = (sim.rnd() - 0.5) * 0.6;
    t.life = 5 + 3 * sim.rnd();
    t.size0 = 0.8;
    t.size1 = 3.5 + 2.5 * sim.rnd();
    t.growTau = 2;
    t.drag = 0.6;
    t.buoyancy = 1.5;
    t.buoyTau = 4;
    t.alpha = 0.5;
    t.fadeIn = 0.3;
    t.fadeOut = 0.6;
    const s = 0.05 + 0.1 * (1 - dark);
    t.r = s;
    t.g = s;
    t.b = s * 0.95;
    t.lighten = 1.5;
    t.turbulence = 1.2;
    t.groundY = g;
    t.tile = Math.floor(sim.rnd() * 4);
    t.rot = sim.rnd() * 6.28;
    sim.smoke.emit(t);
  };

  let convoy: ConvoyDriver | null = null;

  return {
    vehicles,
    views,
    get convoy() {
      return convoy;
    },
    install(plan) {
      for (const p of plan.vehicles) {
        const target = world.addTarget({ kind: p.kind, position: { x: p.x, y: ground.height(p.x, p.z), z: p.z }, headingDeg: p.headingDeg, group: p.group });
        const v: RangeVehicle = { plan: p, target, view: newVehicleView(p.kind as TargetKind), wreck: null, nextSmoke: 0, unit: -1, turretGoal: 0, nextScan: 0, dustAcc: 0 };
        vehicles.push(v);
        views.push(v.view);
      }
      // the march column drives the track (the farm lane, or a loop)
      const tr = plan.track;
      const col = vehicles.filter((v) => v.plan.group === 'convoy').sort((a, b) => a.plan.slot - b.plan.slot);
      if (tr && tr.points.length > 2 && col.length > 0) {
        const path = makePath(tr.points, tr.kind !== 'lane');
        const statics: StaticHull[] = vehicles
          .filter((v) => v.plan.group !== 'convoy')
          .map((v) => ({ x: v.plan.x, z: v.plan.z, headingDeg: v.plan.headingDeg, halfL: cfg.targets[v.plan.kind].length / 2, halfW: cfg.targets[v.plan.kind].width / 2 }));
        convoy = createConvoyDriver(
          { path, scatterL: tr.scatterL, scatterR: tr.scatterR, ends: tr.kind === 'lane' && tr.ends ? tr.ends : null },
          col.map((v) => ({ kind: v.plan.kind, slot: v.plan.slot, s: v.plan.s })),
          statics,
          cfg.range.convoy,
          cfg.targets,
          Math.round(plan.site.x * 3 + plan.site.z * 5),
        );
        col.forEach((v, i) => (v.unit = i));
      }
      for (const v of vehicles) place(v);
    },
    update(dt) {
      if (!(dt > 0)) return;
      clock += dt;
      const sim = fx();
      if (convoy) {
        // revived by someone else (world.reviveAll): the whole column starts again
        if (vehicles.some((v) => v.unit >= 0 && v.target.alive && !convoy!.units[v.unit].alive)) {
          convoy.reset();
          for (const v of vehicles) if (v.unit >= 0) place(v);
        }
        convoy.update(dt);
      }
      for (const v of vehicles) {
        follow(v, dt);
        slewTurret(v, dt);
        if (sim && v.unit >= 0 && v.target.alive) {
          const u = convoy!.units[v.unit];
          if (u.speed > 1.2) {
            v.dustAcc += u.speed * dt;
            const every = 1 / cfg.range.convoy.dustPerM;
            if (v.dustAcc >= every) {
              v.dustAcc -= every;
              dustPuff(sim, v, u.speed);
            }
          }
        }
        const t = v.target;
        const w = v.wreck;
        if (!t.alive && !w) {
          // destroyed without our listener having seen it (e.g. killed before install): make the wreck now
          onDestroyed({ type: 'destroyed', time: 0, weapon: 'gun', targetId: t.id, kind: t.kind, position: { ...t.position } });
        }
        if (t.alive && v.wreck) {
          // revived by someone else (world.reviveAll): put it back
          place(v);
        }
        const wr = v.wreck;
        if (wr) {
          v.view.char = Math.min(1, (clock - wr.t0) / 2.5);
          if (wr.toss && !wr.landed) {
            wr.landed = tossPose(wr.toss, clock, v.view.turretPos, v.view.turretQuat);
            if (wr.landed && sim) {
              sim.sparks(wr.toss.rest.x, wr.toss.rest.y, wr.toss.rest.z, 0, 3, 0, 20);
              smokePuff(sim, wr.toss.rest.x, wr.toss.rest.y, wr.toss.rest.z, wr.toss.rest.y - 0.5, 0.2);
            }
          }
          if (sim && clock < wr.cookEnd && clock >= wr.nextPop) {
            const y = t.position.y + 1.2 + wr.rnd();
            sim.sparks(t.position.x, y, t.position.z, 0, 6, 0, 10 + Math.floor(wr.rnd() * 20));
            sim.flash(t.position.x, y, t.position.z, 0.15 + wr.rnd() * 0.3);
            wr.nextPop = clock + 0.3 + wr.rnd() * 2.2;
          }
          // wrecks beyond the fire budget (or after the fire) smoulder with cheap puffs
          if (sim && wr.fire < 0 && clock < wr.columnEnd && clock >= v.nextSmoke) {
            smokePuff(sim, t.position.x, t.position.y + 1.5, t.position.z, t.position.y, 0.9);
            v.nextSmoke = clock + 0.7;
          }
        } else if (t.health < t.maxHealth * 0.5 && sim && clock >= v.nextSmoke) {
          // damaged: smoke from the engine deck
          const h = t.headingDeg * DEG;
          const back = 0.3 * (cfg.targets[t.kind].length);
          smokePuff(sim, t.position.x - Math.sin(h) * back, t.position.y + cfg.targets[t.kind].height * 0.8, t.position.z + Math.cos(h) * back, t.position.y, t.health < t.maxHealth * 0.25 ? 0.8 : 0.3);
          v.nextSmoke = clock + (t.health < t.maxHealth * 0.25 ? 0.35 : 0.8);
        }
        pose(v);
      }
    },
    reset() {
      resets++;
      world.reviveAll();
      convoy?.reset();
      for (const v of vehicles) {
        if (v.wreck) killFx(v.wreck);
        place(v);
      }
    },
    time: () => clock,
    stats() {
      let alive = 0;
      let wrecks = 0;
      let tossed = 0;
      for (const v of vehicles) {
        if (v.target.alive) alive++;
        if (v.wreck) wrecks++;
        if (v.wreck?.toss) tossed++;
      }
      return { vehicles: vehicles.length, alive, wrecks, fires: activeCount('fire'), columns: activeCount('column'), tossed };
    },
    dispose() {
      unsubscribe();
    },
  };
}

const newParticleInitDefaults = newParticleInit();
