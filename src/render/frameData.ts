/**
 * Per-frame hand-off from the atmosphere (sun, in-cloud whiteout) to the
 * renderer's output pass, stored on scene.userData so the app only has to
 * call renderer.render(scene, camera).
 */
import * as THREE from 'three';
import type { DepthMode } from './renderer';

/**
 * The volumetric cloud pass as the renderer sees it: rendered after the scene
 * (with the resolved scene depth), composited by the output pass.
 */
export interface CloudPassHook {
  /** Render + composite volumetric clouds this frame. */
  readonly active: boolean;
  render(renderer: THREE.WebGLRenderer, depth: THREE.Texture, camera: THREE.Camera, targetW: number, targetH: number, pixelRatio: number, depthMode: DepthMode): void;
  readonly outputA: THREE.Texture;
  readonly outputB: THREE.Texture;
  readonly size: THREE.Vector2;
  readonly layerBottom: number;
  readonly layerTop: number;
  /** Measured GPU ms of the last timed cloud pass (written by the renderer; NaN without a timer). */
  gpuMs: number;
  /** Sum of every timed pass of the frame (scene + clouds + post), for the timer sanity check (cloudBudget.ts). */
  frameGpuMs: number;
  /** The renderer's pixel ratio is at its dynamic-resolution minimum (written by the renderer). */
  atMinQuality: boolean;
}

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
  /** Volumetric clouds (null = none / billboard mode). */
  clouds: CloudPassHook | null;
}

const KEY = '__atmosphereFrame';

export function setAtmosphereFrameData(scene: THREE.Object3D, data: AtmosphereFrameData): void {
  scene.userData[KEY] = data;
}

export function getAtmosphereFrameData(scene: THREE.Object3D): AtmosphereFrameData | undefined {
  return scene.userData[KEY] as AtmosphereFrameData | undefined;
}
