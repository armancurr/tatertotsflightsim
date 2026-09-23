/**
 * Target selection for the missiles (T): the live vehicle nearest to where the nose points, within
 * the selection cone and range and in plain view; pressing again cycles to the next one. After
 * `lockTimeS` on the same target the HUD shows LOCK. A game UI rule, not a sensor model.
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
