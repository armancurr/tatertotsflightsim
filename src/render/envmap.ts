/**
 * Scene environment map from the sky: the ENV_MODE sky dome (no sun disc,
 * hazy ground below the horizon) rendered into a PMREM cube-UV texture and
 * assigned to scene.environment, so every PBR material gets image-based sky
 * light and reflections that match the visible sky. Re-baked when the time of
 * day changes (and by the atmosphere when the camera altitude changes a lot).
 */
import * as THREE from 'three';

export interface EnvBaker {
  readonly texture: THREE.Texture | null;
  /** Re-render the environment; returns the new PMREM texture. ~2–4 ms. */
  bake(): THREE.Texture;
  dispose(): void;
}

export function createEnvBaker(renderer: THREE.WebGLRenderer, envMesh: THREE.Mesh, size = 256): EnvBaker {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(envMesh);
  let rt: THREE.WebGLRenderTarget | null = null;

  return {
    get texture() {
      return rt ? rt.texture : null;
    },
    bake() {
      const prevTarget = renderer.getRenderTarget();
      const next = pmrem.fromScene(envScene, 0, 0.1, 10, { size });
      renderer.setRenderTarget(prevTarget);
      if (rt) rt.dispose();
      rt = next;
      return rt.texture;
    },
    dispose() {
      envScene.remove(envMesh);
      if (rt) rt.dispose();
      rt = null;
      pmrem.dispose();
    },
  };
}
