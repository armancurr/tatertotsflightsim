/**
 * Camera feel (owned by src/fx): a subtle speed-dependent widening of the field of view in the
 * cockpit and chase views (fx.fov), eased so view changes never jump. Runs first (order 1), after
 * the app has applied the camera rig's pose and before the other systems cull against the camera;
 * the rig re-applies its own FOV next frame, so the offset never accumulates.
 * (Camera shake — ground roll, stall buffet, overspeed, crash — comes from the fx system's cameraShake.)
 */
import { MS_TO_KT } from '../../config';
import { fovOffsetFor } from '../../fx/shake';
import type { SystemModule } from './types';

/** Time constant of the FOV offset easing, s. */
const TAU = 0.6;

const mod: SystemModule = {
  name: 'camerafx',
  order: 1,
  create(ctx) {
    const camera = ctx.camera;
    let offset = 0;
    let applied = 0;
    return {
      update(f) {
        const cam = f.camera ?? camera;
        const dt = Number.isFinite(f.dt) && f.dt > 0 ? Math.min(f.dt, 0.25) : 0;
        const target = fovOffsetFor(f.cameraMode, f.state.derived.ias * MS_TO_KT);
        if (!f.paused && dt > 0) offset += (target - offset) * (1 - Math.exp(-dt / TAU));
        if (!Number.isFinite(offset)) offset = 0;
        applied = offset < 1e-3 ? 0 : offset;
        if (applied === 0) return;
        cam.fov += applied;
        cam.updateProjectionMatrix();
      },
      onReset() {
        offset = 0;
      },
      stats: () => ({ fovOffsetDeg: Math.round(applied * 100) / 100 }),
    };
  },
};
export default mod;
