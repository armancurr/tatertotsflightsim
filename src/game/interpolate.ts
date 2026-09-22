/**
 * Render-time interpolation between the last two fixed physics states (pure).
 * alpha = FixedStepLoop.advance(...).alpha: 0 → prev, 1 → next.
 */
import type { Quat, Vec3 } from '../types';
import { vLerp } from '../math/vec3';
import { qSlerp } from '../math/quat';

export interface Pose {
  position: Vec3;
  orientation: Quat;
}

export function interpolatePose(prev: Pose, next: Pose, alpha: number): Pose {
  const t = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 1;
  return {
    position: vLerp(prev.position, next.position, t),
    orientation: qSlerp(prev.orientation, next.orientation, t),
  };
}
