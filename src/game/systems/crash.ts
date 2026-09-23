/**
 * The crash director (owned by src/crash): the frame the physics reports a crash, the airframe
 * breaks into rigid bodies that keep the aircraft's last momentum, the fireball and fires play on
 * the scene's effects (shared with the fx system through fxHub), the debris and effects run in
 * slow motion for a second, and the camera shakes and then drifts to frame the wreckage until the
 * player resets. Runs early (order 2): after the rig has posed the camera, before the world systems
 * cull against it. Idle cost: remembering the aircraft's velocity each frame.
 */
import * as THREE from 'three';
import { KT_TO_MS } from '../../config';
import { CrashDirector } from '../../crash/director';
import { fxHub } from '../../fx/hub';
import type { SystemModule } from './types';

const FPM_TO_MS = 0.00508;

const mod: SystemModule = {
  name: 'crash',
  order: 2,
  create(ctx) {
    const env = ctx.env;
    const hub = fxHub(ctx.scene);
    hub.director = true;
    const director = new CrashDirector(ctx.scene, {
      groundHeight: (x, z) => env.groundHeight(x, z),
      waterLevel: (x, z) => env.waterLevel(x, z),
      obstacleTop: (x, z) => env.obstacleTop(x, z),
      surfaceAt: (x, z) => env.surfaceAt(x, z),
    });
    // The aircraft's motion on the last frame before the crash (the physics zeroes it on impact).
    const lastV = new THREE.Vector3();
    const lastW = new THREE.Vector3();
    let haveLast = false;
    const Q = new THREE.Quaternion();
    const root = new THREE.Vector3();
    let handled: number | null = null;
    const clear = () => {
      handled = null;
      haveLast = false;
      hub.timeScale = 1;
    };
    return {
      cameraShake: () => director.shake(),
      update(f) {
        const s = f.state;
        if (s.phase !== 'crashed' || !s.crash) {
          if (director.active) director.reset();
          lastV.set(s.velocity.x, s.velocity.y, s.velocity.z);
          Q.set(s.orientation.x, s.orientation.y, s.orientation.z, s.orientation.w);
          lastW.set(s.angularVelocity.x, s.angularVelocity.y, s.angularVelocity.z).applyQuaternion(Q);
          haveLast = Number.isFinite(lastV.x + lastV.y + lastV.z + lastW.x + lastW.y + lastW.z);
          if (hub.timeScale !== 1) hub.timeScale = 1;
          return;
        }
        director.fx = hub.effects?.sim ?? null;
        if (s.crash.time !== handled) {
          handled = s.crash.time;
          if (!haveLast) {
            // no pre-crash frame (e.g. a crash on the first frame): rebuild it from the crash record
            Q.set(s.orientation.x, s.orientation.y, s.orientation.z, s.orientation.w);
            const sp = s.crash.speedKt * KT_TO_MS;
            const vy = Math.max(-sp, Math.min(sp, s.crash.verticalSpeedFpm * FPM_TO_MS));
            const fwd = lastV.set(0, 0, -1).applyQuaternion(Q);
            fwd.y = 0;
            if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
            fwd.normalize().multiplyScalar(Math.sqrt(Math.max(0, sp * sp - vy * vy)));
            fwd.y = vy;
            lastW.set(0, 0, 0);
          }
          director.begin(f.aircraft, {
            reason: s.crash.reason,
            speedKt: s.crash.speedKt,
            position: s.crash.position,
            velocity: lastV,
            angularVelocity: lastW,
            massKg: f.def.config.aircraft.mass,
          });
        }
        const dt = f.paused ? 0 : f.dt;
        director.update(dt);
        hub.timeScale = director.timeScale();
        root.copy(f.aircraft.root.position);
        director.applyCamera(f.camera, f.cameraMode, dt, root);
      },
      onReset() {
        director.reset();
        clear();
      },
      onAircraftChange() {
        director.dropModel();
        clear();
      },
      stats: () => director.stats(),
      dispose() {
        director.dispose();
        hub.director = false;
        hub.timeScale = 1;
      },
    };
  },
};
export default mod;
