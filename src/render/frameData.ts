/**
 * Per-frame hand-off from the atmosphere (sun, in-cloud whiteout) to the
 * renderer's output pass, stored on scene.userData so the app only has to
 * call renderer.render(scene, camera).
 */
import * as THREE from 'three';

export interface AtmosphereFrameData {
  sunDirection: THREE.Vector3;
  /** Sun illuminance colour at the camera (HDR, scene units). */
  sunColor: THREE.Color;
  /** Expected HDR luminance of the unoccluded sun disc (flare occlusion threshold). */
  sunDiscLuminance: number;
  /** Sun angular radius, radians. */
  sunAngularRadius: number;
  /** 0..1 in-cloud whiteout amount. */
  immersion: number;
  immersionColor: THREE.Color;
  /** Draw the lens flare this frame. */
  flare: boolean;
}

const KEY = '__atmosphereFrame';

export function setAtmosphereFrameData(scene: THREE.Object3D, data: AtmosphereFrameData): void {
  scene.userData[KEY] = data;
}

export function getAtmosphereFrameData(scene: THREE.Object3D): AtmosphereFrameData | undefined {
  return scene.userData[KEY] as AtmosphereFrameData | undefined;
}
