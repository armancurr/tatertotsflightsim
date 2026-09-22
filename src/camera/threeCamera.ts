/**
 * Adapter: copy a pure CameraPose onto a THREE.PerspectiveCamera. No allocations.
 * The projection matrix is only rebuilt when the FOV actually changes.
 */
import type { PerspectiveCamera } from 'three';
import type { CameraPose } from './cameraRig';

/** FOV changes smaller than this (degrees) don't rebuild the projection matrix. */
const FOV_EPS = 1e-4;

export function applyCameraPose(camera: PerspectiveCamera, pose: CameraPose): void {
  const p = pose.position;
  const q = pose.quaternion;
  camera.position.set(p.x, p.y, p.z);
  camera.quaternion.set(q.x, q.y, q.z, q.w);
  if (Number.isFinite(pose.fov) && Math.abs(camera.fov - pose.fov) > FOV_EPS) {
    camera.fov = pose.fov;
    camera.updateProjectionMatrix();
  }
}
