/** Compiles a traffic group's programs up front (hidden objects included) so no frame stalls on them. */
import type * as THREE from 'three';

export async function compileTraffic(renderer: THREE.WebGLRenderer, group: THREE.Object3D, camera: THREE.Camera, scene: THREE.Scene): Promise<void> {
  const hidden: THREE.Object3D[] = [];
  group.traverse((o) => {
    if (!o.visible) {
      hidden.push(o);
      o.visible = true;
    }
  });
  try {
    await renderer.compileAsync(group, camera, scene);
  } catch {
    /* compiled on first use instead */
  } finally {
    for (const o of hidden) o.visible = false;
  }
}
