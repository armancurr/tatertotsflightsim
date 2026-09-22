/**
 * Scene environment map from the sky: the ENV_MODE sky dome (no sun disc,
 * hazy ground below the horizon) rendered into a cube map and prefiltered by
 * PMREM, assigned to scene.environment, so every PBR material gets image-based
 * sky light and reflections that match the visible sky.
 *
 * `bake()` does it all at once (start-up, time-of-day change). Altitude-driven
 * re-bakes use `beginBake()` + one `step()` per frame: faces 0–2, faces 3–5,
 * then the PMREM filter into the spare of two ping-pong targets (no GPU
 * allocation after the first two bakes), so no frame pays for a whole bake and
 * the old environment stays valid until the new one is complete.
 */
import * as THREE from 'three';
import { createStagedTask } from './jobQueue';

export interface EnvBaker {
  readonly texture: THREE.Texture | null;
  /** Re-render the environment now; returns the new PMREM texture. */
  bake(): THREE.Texture;
  /** Start (or restart) a time-sliced re-bake. */
  beginBake(): void;
  /** Advance a running re-bake by one slice; returns the new texture when it completes, else null. */
  step(): THREE.Texture | null;
  readonly busy: boolean;
  dispose(): void;
}

export function createEnvBaker(renderer: THREE.WebGLRenderer, envMesh: THREE.Mesh, size = 256): EnvBaker {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(envMesh);
  const cubeRT = new THREE.WebGLCubeRenderTarget(size, {
    type: THREE.HalfFloatType,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
  });
  const cubeCam = new THREE.CubeCamera(0.1, 10, cubeRT);
  const targets: Array<THREE.WebGLRenderTarget | null> = [null, null];
  let cur = -1;

  function renderFaces(from: number, to: number) {
    if (cubeCam.coordinateSystem !== renderer.coordinateSystem) {
      cubeCam.coordinateSystem = renderer.coordinateSystem;
      cubeCam.updateCoordinateSystem();
    }
    cubeCam.updateMatrixWorld(true);
    const prevTarget = renderer.getRenderTarget();
    const prevFace = renderer.getActiveCubeFace();
    const prevLevel = renderer.getActiveMipmapLevel();
    const cams = cubeCam.children as THREE.Camera[];
    for (let i = from; i <= to; i++) {
      renderer.setRenderTarget(cubeRT, i);
      renderer.render(envScene, cams[i]);
    }
    renderer.setRenderTarget(prevTarget, prevFace, prevLevel);
  }

  function filter() {
    const next = cur === 0 ? 1 : 0;
    const prevTarget = renderer.getRenderTarget();
    targets[next] = pmrem.fromCubemap(cubeRT.texture, targets[next]);
    renderer.setRenderTarget(prevTarget);
    cur = next;
  }

  const task = createStagedTask([() => renderFaces(0, 2), () => renderFaces(3, 5), filter]);

  return {
    get texture() {
      return cur >= 0 ? targets[cur]!.texture : null;
    },
    bake() {
      task.runAll();
      return targets[cur]!.texture;
    },
    beginBake() {
      task.start();
    },
    step() {
      return task.step() ? targets[cur]!.texture : null;
    },
    get busy() {
      return task.busy;
    },
    dispose() {
      envScene.remove(envMesh);
      for (const t of targets) t?.dispose();
      targets[0] = targets[1] = null;
      cur = -1;
      cubeRT.dispose();
      pmrem.dispose();
    },
  };
}
