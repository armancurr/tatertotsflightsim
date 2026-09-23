/**
 * Target selection for the missiles (T): the live vehicle nearest to where the nose points, within
 * the selection cone and range and in plain view; pressing again cycles to the next one. After
 * `lockTimeS` on the same target the HUD shows LOCK. A game UI rule, not a sensor model.
 *
 * `pickTarget` makes it stable in a tight platoon: a first press takes the target nearest the nose
 * but keeps the one already tracked while it is within `stickDeg` of that (so a slightly-off nose
 * never flips between neighbours, and re-pressing doesn't restart the lock); presses within
 * `cycleS` of each other step through the targets in the order fixed at the first press.
 */
import type { MissileConfig } from '../config';
import type { Environment, Vec3 } from '../types';
import type { GroundTarget, LockState } from './types';
import type { CombatWorld } from './world';
import { lineOfSight } from './ground';

export interface TargetLock {
  state: LockState;
  targetId: number | null;
  /** Seconds on the current target. */
  timer: number;
}

export const newLock = (): TargetLock => ({ state: 'off', targetId: null, timer: 0 });

/** The aim point of a target (hull centre). */
export function targetCentre(world: CombatWorld, id: number): Vec3 | null {
  const t = world.find(id);
  return t ? world.centreOf(t) : null;
}

/** The next target to select (the one after `currentId`, wrapping), or null when nothing is in view. */
export function selectNextTarget(
  world: CombatWorld, origin: Vec3, forward: Vec3, cfg: Pick<MissileConfig, 'selectConeDeg' | 'maxRangeM'>, currentId: number | null, env?: Environment,
  accept: (t: GroundTarget) => boolean = () => true,
): number | null {
  const found = world.targetsInCone(origin, forward, cfg.selectConeDeg, cfg.maxRangeM).filter((c) => {
    if (!accept(c.target)) return false;
    if (!env) return true;
    const p = targetCentre(world, c.target.id);
    return p !== null && lineOfSight(env, origin, p);
  });
  if (found.length === 0) return null;
  const i = found.findIndex((c) => c.target.id === currentId);
  return found[(i + 1) % found.length].target.id;
}

/** Advance the lock timer. Returns 'lock' when LOCK is reached, 'lost' when the target is gone or far out of range. */
export function stepLock(lock: TargetLock, world: CombatWorld, origin: Vec3, dt: number, cfg: Pick<MissileConfig, 'maxRangeM' | 'lockTimeS'>): 'lock' | 'lost' | null {
  if (lock.state === 'off' || lock.targetId === null) return null;
  const t = world.find(lock.targetId);
  const p = targetCentre(world, lock.targetId);
  const range = p ? Math.hypot(p.x - origin.x, p.y - origin.y, p.z - origin.z) : Infinity;
  if (!t || !t.alive || !(range <= cfg.maxRangeM * 1.25)) {
    lock.state = 'off';
    lock.targetId = null;
    lock.timer = 0;
    return 'lost';
  }
  if (Number.isFinite(dt) && dt > 0) lock.timer += dt;
  if (lock.state === 'tracking' && lock.timer >= cfg.lockTimeS) {
    lock.state = 'locked';
    return 'lock';
  }
  return null;
}

export interface TargetPicker {
  /** Time of the last press, s. */
  lastPressS: number;
  /** The cycle order fixed at the first press of a burst (target ids, nearest the nose first). */
  order: number[];
}

export const newPicker = (): TargetPicker => ({ lastPressS: -Infinity, order: [] });

export interface PickOptions {
  /** Presses closer together than this (s) step to the next target. */
  cycleS: number;
  /** A first press keeps the tracked target while it is within this many degrees of the one nearest the nose. */
  stickDeg: number;
}

export const PICK_DEFAULTS: PickOptions = { cycleS: 2.5, stickDeg: 0.4 };

/** T pressed at time `nowS`: the target to track (see the header), or null when nothing is in view. */
export function pickTarget(
  picker: TargetPicker, nowS: number, world: CombatWorld, origin: Vec3, forward: Vec3, cfg: Pick<MissileConfig, 'selectConeDeg' | 'maxRangeM'>, currentId: number | null,
  env?: Environment, accept: (t: GroundTarget) => boolean = () => true, opts: PickOptions = PICK_DEFAULTS,
): number | null {
  const found = world.targetsInCone(origin, forward, cfg.selectConeDeg, cfg.maxRangeM).filter((c) => {
    if (!accept(c.target)) return false;
    if (!env) return true;
    const p = targetCentre(world, c.target.id);
    return p !== null && lineOfSight(env, origin, p);
  });
  const quick = nowS - picker.lastPressS < opts.cycleS && Number.isFinite(picker.lastPressS);
  picker.lastPressS = nowS;
  if (found.length === 0) {
    picker.order = [];
    return null;
  }
  const inView = (id: number) => found.some((c) => c.target.id === id);
  if (quick && currentId !== null && picker.order.includes(currentId)) {
    // the next in the burst's order that is still in view (newcomers join at the end)
    for (const c of found) if (!picker.order.includes(c.target.id)) picker.order.push(c.target.id);
    const n = picker.order.length;
    const i = picker.order.indexOf(currentId);
    for (let k = 1; k <= n; k++) {
      const id = picker.order[(i + k) % n];
      if (inView(id)) return id;
    }
    return found[0].target.id;
  }
  // a first press: nearest the nose, sticky to the tracked one
  picker.order = found.map((c) => c.target.id);
  const best = found[0];
  if (currentId !== null) {
    const cur = found.find((c) => c.target.id === currentId);
    if (cur && cur.angleDeg <= best.angleDeg + opts.stickDeg) {
      // start the burst's order at the tracked target
      picker.order = [currentId, ...picker.order.filter((id) => id !== currentId)];
      return currentId;
    }
  }
  return best.target.id;
}
