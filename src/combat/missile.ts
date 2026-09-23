/**
 * Missiles, ARCADE model. After launch a missile flies a scripted quadratic curve: off the rail
 * along the launch direction, bending onto the target's current position, arriving after
 * distance / speed seconds. It is an animation, not a guidance or flight simulation — the owner
 * wants the fun of Mavericks, not a weapons model.
 */
import type { MissileConfig } from '../config';
import type { Vec3 } from '../types';

export interface ArcadeMissile {
  id: number;
  /** Missile station it came from (config order). */
  station: number;
  targetId: number | null;
  /** Launch point, control point and end point (the target's latest position). */
  p0: Vec3;
  p1: Vec3;
  end: Vec3;
  duration: number;
  t: number;
  pos: Vec3;
  /** Unit direction of travel. */
  dir: Vec3;
  arrived: boolean;
}

const norm = (v: Vec3, fallback: Vec3): Vec3 => {
  const n = Math.hypot(v.x, v.y, v.z);
  return n > 1e-9 && Number.isFinite(n) ? { x: v.x / n, y: v.y / n, z: v.z / n } : { ...fallback };
};

export function launchArcadeMissile(id: number, station: number, targetId: number | null, start: Vec3, forward: Vec3, end: Vec3, cfg: MissileConfig): ArcadeMissile {
  const toEnd = { x: end.x - start.x, y: end.y - start.y, z: end.z - start.z };
  const dist = Math.hypot(toEnd.x, toEnd.y, toEnd.z);
  const f = norm(forward, norm(toEnd, { x: 0, y: 0, z: -1 }));
  const lead = dist * 0.35;
  return {
    id,
    station,
    targetId,
    p0: { ...start },
    p1: { x: start.x + f.x * lead, y: start.y + f.y * lead + dist * cfg.arc, z: start.z + f.z * lead },
    end: { ...end },
    duration: Math.max(0.8, dist / Math.max(1, cfg.speed)),
    t: 0,
    pos: { ...start },
    dir: f,
    arrived: false,
  };
}

/** Advance along the curve; `target` (if given) moves the end point to where the target is now. */
export function stepArcadeMissile(m: ArcadeMissile, dt: number, target: Vec3 | null): void {
  if (m.arrived) return;
  if (target && Number.isFinite(target.x) && Number.isFinite(target.y) && Number.isFinite(target.z)) {
    m.end.x = target.x;
    m.end.y = target.y;
    m.end.z = target.z;
  }
  if (Number.isFinite(dt) && dt > 0) m.t = Math.min(m.duration, m.t + dt);
  const u = m.t / m.duration;
  const a = (1 - u) * (1 - u);
  const b = 2 * (1 - u) * u;
  const c = u * u;
  m.pos.x = a * m.p0.x + b * m.p1.x + c * m.end.x;
  m.pos.y = a * m.p0.y + b * m.p1.y + c * m.end.y;
  m.pos.z = a * m.p0.z + b * m.p1.z + c * m.end.z;
  // Tangent of the curve.
  const d = {
    x: 2 * (1 - u) * (m.p1.x - m.p0.x) + 2 * u * (m.end.x - m.p1.x),
    y: 2 * (1 - u) * (m.p1.y - m.p0.y) + 2 * u * (m.end.y - m.p1.y),
    z: 2 * (1 - u) * (m.p1.z - m.p0.z) + 2 * u * (m.end.z - m.p1.z),
  };
  m.dir = norm(d, m.dir);
  if (u >= 1) {
    m.pos.x = m.end.x;
    m.pos.y = m.end.y;
    m.pos.z = m.end.z;
    m.arrived = true;
  }
}
