/**
 * The combat world: every ground target, the hit/blast bookkeeping (armour by aspect), a
 * seeker search, the combat event stream and the weapons status. Plain data + pure maths —
 * no three.js — so it is fully unit-testable. One per scene via `combatWorld(scene)` (a WeakMap,
 * like the fx hub): the weapons, targets, fx, audio and HUD systems all share it.
 */
import { CONFIG, type Config, type TargetClassConfig } from '../config';
import type { Vec3 } from '../types';
import type {
  CombatEvent, CombatListener, CombatStats, ConeHit, GroundTarget, HitInfo, HullFace, NewTarget,
  RangeInfo, RayHit, TargetKind, WeaponKind, WeaponsStatus,
} from './types';
import { effectiveDamage } from './damage';

export interface CombatWorld {
  readonly targets: GroundTarget[];
  status: WeaponsStatus;
  range: RangeInfo | null;
  readonly stats: CombatStats;
  classOf(kind: TargetKind): TargetClassConfig;
  /** An aircraft target (box centred on `position`, full 3D orientation)? */
  isAir(t: GroundTarget): boolean;
  /** The aim point: hull centre (ground vehicles: half a hull above `position`; aircraft: `position`). */
  centreOf(t: GroundTarget): Vec3;
  /** A world-frame offset from the target's position → its body/hull frame (x right, y up, −z front). */
  toBody(t: GroundTarget, d: Vec3): Vec3;
  addTarget(t: NewTarget): GroundTarget;
  find(id: number): GroundTarget | undefined;
  removeAll(): void;
  /** First hull box (alive or wrecked) crossed by the segment from → to, or null. */
  raycast(from: Vec3, to: Vec3): RayHit | null;
  /** Apply one hit (armour by the struck face for the gun); emits 'hit' and, once, 'destroyed'. */
  applyHit(targetId: number, hit: HitInfo): { damage: number; destroyed: boolean };
  /** Blast: damage × (1 − d/R)² by distance d from each hull; returns the ids it destroyed. */
  applyBlast(center: Vec3, radius: number, damage: number, weapon: WeaponKind, time: number): number[];
  /** Live targets within `coneDeg` of the axis and `maxRange`, nearest the axis first. */
  targetsInCone(origin: Vec3, axis: Vec3, coneDeg: number, maxRange: number): ConeHit[];
  reviveAll(): void;
  resetStats(): void;
  on(fn: CombatListener): () => void;
  emit(e: CombatEvent): void;
}

export function emptyWeaponsStatus(): WeaponsStatus {
  return {
    hasGun: false,
    gunName: '',
    rounds: 0,
    maxRounds: 0,
    gunSpin: 0,
    gunFiring: false,
    hasMissiles: false,
    missileName: '',
    missiles: 0,
    maxMissiles: 0,
    stores: [],
    hasAirMissiles: false,
    airMissileName: '',
    airMissiles: 0,
    maxAirMissiles: 0,
    airStores: [],
    lock: { state: 'off', targetId: null, progress: 0, rangeM: null, inRange: false },
    ccip: null,
    ccipRangeM: null,
    missilesInFlight: 0,
  };
}

const DEG = Math.PI / 180;

/** Rotate v by the inverse of unit quaternion q (world → body). */
function rotInv(q: { x: number; y: number; z: number; w: number }, v: Vec3): Vec3 {
  // conj(q) · v · q, expanded (t = 2 · cross(−q.xyz, v)).
  const qx = -q.x, qy = -q.y, qz = -q.z, qw = q.w;
  const tx = 2 * (qy * v.z - qz * v.y);
  const ty = 2 * (qz * v.x - qx * v.z);
  const tz = 2 * (qx * v.y - qy * v.x);
  return { x: v.x + qw * tx + (qy * tz - qz * ty), y: v.y + qw * ty + (qz * tx - qx * tz), z: v.z + qw * tz + (qx * ty - qy * tx) };
}

/** World direction → hull/body frame (x right, y up, z back; −z is the front). */
function dirToLocal(t: GroundTarget, v: Vec3): Vec3 {
  if (t.orientation) return rotInv(t.orientation, v);
  const r = t.headingDeg * DEG;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: v.x * c + v.z * s, y: v.y, z: v.z * c - v.x * s };
}

/** World → hull frame, relative to the target's position. */
function toLocal(t: GroundTarget, p: Vec3): Vec3 {
  return dirToLocal(t, { x: p.x - t.position.x, y: p.y - t.position.y, z: p.z - t.position.z });
}

/** Hull/body frame direction → world. */
function dirToWorld(t: GroundTarget, v: Vec3): Vec3 {
  if (t.orientation) {
    const q = t.orientation;
    const tx = 2 * (q.y * v.z - q.z * v.y);
    const ty = 2 * (q.z * v.x - q.x * v.z);
    const tz = 2 * (q.x * v.y - q.y * v.x);
    return { x: v.x + q.w * tx + (q.y * tz - q.z * ty), y: v.y + q.w * ty + (q.z * tx - q.x * tz), z: v.z + q.w * tz + (q.x * ty - q.y * tx) };
  }
  const r = t.headingDeg * DEG;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: v.x * c - v.z * s, y: v.y, z: v.x * s + v.z * c };
}

/** The face a round travelling along `dirLocal` most likely enters by. */
function faceFromDirection(d: Vec3, cls: TargetClassConfig): HullFace {
  // Weight each axis by the area it presents.
  const ax = Math.abs(d.x) * cls.length * cls.height;
  const ay = Math.abs(d.y) * cls.length * cls.width;
  const az = Math.abs(d.z) * cls.width * cls.height;
  if (ay >= ax && ay >= az) return d.y <= 0 ? 'top' : 'bottom';
  if (ax >= az) return 'side';
  return d.z > 0 ? 'front' : 'rear';
}

export function createCombatWorld(cfg: Config = CONFIG): CombatWorld {
  const targets: GroundTarget[] = [];
  const listeners = new Set<CombatListener>();
  const stats: CombatStats = { roundsFired: 0, roundsHit: 0, missilesFired: 0, kills: 0 };
  let nextId = 1;
  const classOf = (kind: TargetKind): TargetClassConfig => cfg.combat.targets[kind];
  const isAir = (t: GroundTarget) => classOf(t.kind).air === true;
  /** Height of the box's centre above `position` (0 for aircraft) and its vertical bounds. */
  const yMid = (t: GroundTarget, cls: TargetClassConfig) => (cls.air ? 0 : cls.height / 2);
  const yLo = (cls: TargetClassConfig) => (cls.air ? -cls.height / 2 : 0);
  const yHi = (cls: TargetClassConfig) => (cls.air ? cls.height / 2 : cls.height);
  const centreOf = (t: GroundTarget): Vec3 => ({ x: t.position.x, y: t.position.y + yMid(t, classOf(t.kind)), z: t.position.z });

  const emit = (e: CombatEvent) => {
    for (const fn of [...listeners]) {
      try {
        fn(e);
      } catch (err) {
        console.error('[combat] listener threw', err);
      }
    }
  };

  const kill = (t: GroundTarget, weapon: WeaponKind, time: number) => {
    t.health = 0;
    t.alive = false;
    t.destroyedAt = time;
    stats.kills++;
    emit({ type: 'destroyed', time, weapon, targetId: t.id, kind: t.kind, position: { ...t.position } });
  };

  const world: CombatWorld = {
    targets,
    status: emptyWeaponsStatus(),
    range: null,
    stats,
    classOf,
    isAir,
    centreOf,
    toBody: (t, d) => dirToLocal(t, d),

    addTarget(n) {
      const cls = classOf(n.kind);
      const t: GroundTarget = {
        id: nextId++,
        kind: n.kind,
        position: { ...n.position },
        headingDeg: n.headingDeg,
        velocity: n.velocity ? { ...n.velocity } : { x: 0, y: 0, z: 0 },
        health: cls.health,
        maxHealth: cls.health,
        alive: true,
        destroyedAt: null,
        group: n.group,
        ...(n.orientation ? { orientation: { ...n.orientation } } : {}),
      };
      targets.push(t);
      return t;
    },

    find: (id) => targets.find((t) => t.id === id),

    removeAll() {
      targets.length = 0;
    },

    raycast(from, to) {
      let best: RayHit | null = null;
      const len = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
      if (!(len > 0)) return null;
      for (const t of targets) {
        const cls = classOf(t.kind);
        // Cheap reject: segment vs bounding sphere.
        const cx = t.position.x - from.x;
        const cy = t.position.y + yMid(t, cls) - from.y;
        const cz = t.position.z - from.z;
        const dx = (to.x - from.x) / len;
        const dy = (to.y - from.y) / len;
        const dz = (to.z - from.z) / len;
        const along = cx * dx + cy * dy + cz * dz;
        const rad = 0.5 * Math.hypot(cls.length, cls.width, cls.height);
        if (along < -rad || along > len + rad) continue;
        const perp2 = cx * cx + cy * cy + cz * cz - along * along;
        if (perp2 > rad * rad) continue;

        // Slab test in the hull frame.
        const o = toLocal(t, from);
        const e = toLocal(t, to);
        const d = { x: e.x - o.x, y: e.y - o.y, z: e.z - o.z };
        const lo = { x: -cls.width / 2, y: yLo(cls), z: -cls.length / 2 };
        const hi = { x: cls.width / 2, y: yHi(cls), z: cls.length / 2 };
        let tmin = 0;
        let tmax = 1;
        let enter: HullFace | null = null;
        let ok = true;
        for (const axis of ['x', 'y', 'z'] as const) {
          if (Math.abs(d[axis]) < 1e-12) {
            if (o[axis] < lo[axis] || o[axis] > hi[axis]) {
              ok = false;
              break;
            }
            continue;
          }
          // Face entered on this axis (the near plane): moving +z in the hull frame enters the front.
          const face: HullFace = axis === 'x' ? 'side' : axis === 'y' ? (d.y < 0 ? 'top' : 'bottom') : d.z > 0 ? 'front' : 'rear';
          let t1 = (lo[axis] - o[axis]) / d[axis];
          let t2 = (hi[axis] - o[axis]) / d[axis];
          if (t1 > t2) [t1, t2] = [t2, t1];
          if (t1 > tmin) {
            tmin = t1;
            enter = face;
          }
          if (t2 < tmax) tmax = t2;
          if (tmin > tmax) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        // Started inside the box: report the face the ray is heading out of the least (by direction).
        const faceHit: HullFace = enter ?? faceFromDirection(d, cls);
        const dist = tmin * len;
        if (best && dist >= best.distance) continue;
        best = {
          target: t,
          distance: dist,
          point: { x: from.x + (to.x - from.x) * tmin, y: from.y + (to.y - from.y) * tmin, z: from.z + (to.z - from.z) * tmin },
          face: faceHit,
        };
      }
      return best;
    },

    applyHit(targetId, hit) {
      const t = world.find(targetId);
      if (!t || !t.alive || !Number.isFinite(hit.damage) || hit.damage <= 0) return { damage: 0, destroyed: false };
      const cls = classOf(t.kind);
      const face = hit.face ?? faceFromDirection(toLocalDir(t, hit.direction), cls);
      const dmg = Math.min(t.health, effectiveDamage(cls, face, hit.weapon, hit.damage));
      if (!(dmg > 0)) return { damage: 0, destroyed: false };
      t.health = Math.max(0, t.health - dmg);
      if (hit.weapon === 'gun') stats.roundsHit++;
      emit({ type: 'hit', time: hit.time, weapon: hit.weapon, targetId: t.id, point: { ...hit.point }, damage: dmg, health: t.health, face });
      if (t.health <= 1e-9) {
        kill(t, hit.weapon, hit.time);
        return { damage: dmg, destroyed: true };
      }
      return { damage: dmg, destroyed: false };
    },

    applyBlast(center, radius, damage, weapon, time) {
      const killed: number[] = [];
      if (!Number.isFinite(damage) || damage <= 0 || !(radius > 0)) return killed;
      for (const t of targets) {
        if (!t.alive) continue;
        const cls = classOf(t.kind);
        const l = toLocal(t, center);
        const qx = Math.max(Math.abs(l.x) - cls.width / 2, 0);
        const qz = Math.max(Math.abs(l.z) - cls.length / 2, 0);
        const qy = l.y < yLo(cls) ? yLo(cls) - l.y : Math.max(l.y - yHi(cls), 0);
        const dist = Math.hypot(qx, qy, qz);
        if (dist >= radius) continue;
        const f = (1 - dist / radius) ** 2;
        const toTarget = { x: t.position.x - center.x, y: t.position.y + yMid(t, cls) - center.y, z: t.position.z - center.z };
        const n = Math.hypot(toTarget.x, toTarget.y, toTarget.z) || 1;
        const r = world.applyHit(t.id, {
          weapon,
          damage: damage * f,
          point: { ...center },
          direction: { x: toTarget.x / n, y: toTarget.y / n, z: toTarget.z / n },
          time,
          face: 'top',
        });
        if (r.destroyed) killed.push(t.id);
      }
      return killed;
    },

    targetsInCone(origin, axis, coneDeg, maxRange) {
      const an = Math.hypot(axis.x, axis.y, axis.z);
      if (!(an > 0)) return [];
      const ux = axis.x / an;
      const uy = axis.y / an;
      const uz = axis.z / an;
      const cosCone = Math.cos(coneDeg * DEG);
      const out: ConeHit[] = [];
      for (const t of targets) {
        if (!t.alive) continue;
        const cls = classOf(t.kind);
        const vx = t.position.x - origin.x;
        const vy = t.position.y + yMid(t, cls) - origin.y;
        const vz = t.position.z - origin.z;
        const range = Math.hypot(vx, vy, vz);
        if (!(range > 0) || range > maxRange) continue;
        const c = (vx * ux + vy * uy + vz * uz) / range;
        if (c < cosCone) continue;
        out.push({ target: t, range, angleDeg: Math.acos(Math.min(1, c)) / DEG });
      }
      return out.sort((a, b) => a.angleDeg - b.angleDeg);
    },

    reviveAll() {
      for (const t of targets) {
        t.health = t.maxHealth;
        t.alive = true;
        t.destroyedAt = null;
      }
    },

    resetStats() {
      stats.roundsFired = 0;
      stats.roundsHit = 0;
      stats.missilesFired = 0;
      stats.kills = 0;
    },

    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    emit,
  };
  return world;
}

const toLocalDir = dirToLocal;

/** Hull-frame helpers, exported for the renderer and tests. */
export const hullFrame = { toLocal, toLocalDir, dirToWorld };

const worlds = new WeakMap<object, CombatWorld>();

/** The combat world of a scene (created on first use). */
export function combatWorld(scene: object, cfg: Config = CONFIG): CombatWorld {
  let w = worlds.get(scene);
  if (!w) {
    w = createCombatWorld(cfg);
    worlds.set(scene, w);
  }
  return w;
}
