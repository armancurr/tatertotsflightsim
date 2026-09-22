/**
 * Towns renderer (INTERIM): buildings from the pure placement as one
 * InstancedMesh of boxes per chunk (wall colour per instance, height = walls +
 * half the roof), largest first, distance-culled by size (lod.ts boxCount) and
 * frustum-culled per chunk. `obstacleTop` queries the same placement.
 *
 * TODO (see report): archetype geometries (gable/hip/flat/gambrel/silo) with the
 * facade shader for the near LOD; shadows via customDepthMaterial.
 */
import * as THREE from 'three';
import { CONFIG } from '../../config';
import { getLayout, type WorldLayout } from '../layout';
import { getRoadNetwork } from '../roads/network';
import { placeBuildings, visualSize, type Building } from './placement';
import { createObstacleIndex } from './obstacles';
import { groupByChunk, chunkBounds, distanceToBox, boxCount, selectLod, LOD_HIDDEN, type Lod } from './lod';

export { placeBuildings, roofTopAt, buildingRect, type Building } from './placement';
export { createObstacleIndex } from './obstacles';
export { createStandInHeight } from './standin';

export interface TownsOptions {
  heightAt: (x: number, z: number) => number;
  seed?: number;
  layout?: WorldLayout;
}

export interface Towns {
  update(camera: THREE.PerspectiveCamera, time: number): void;
  obstacleTop(x: number, z: number): number;
  stats(): { buildings: number; drawCalls: number };
  dispose(): void;
  /** The placed buildings (read-only). */
  readonly buildings: readonly Building[];
}

interface ChunkMesh {
  mesh: THREE.InstancedMesh;
  box: THREE.Box3;
  sizes: Float32Array;
  lod: Lod;
}

export function createTowns(scene: THREE.Scene, opts: TownsOptions): Towns {
  const cfg = CONFIG.world.towns;
  const layout = opts.layout ?? getLayout();
  const net = getRoadNetwork(layout, opts.heightAt);
  const buildings = placeBuildings(layout, net, opts.heightAt, { seed: opts.seed });
  const obstacleTop = createObstacleIndex(buildings);
  const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, fog: true });
  const group = new THREE.Group();
  group.name = 'towns';
  const chunks: ChunkMesh[] = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const col = new THREE.Color();
  for (const c of groupByChunk(buildings, cfg.chunkSize)) {
    const idx = [...c.indices].sort((a, b) => visualSize(buildings[b]) - visualSize(buildings[a]));
    const mesh = new THREE.InstancedMesh(geo, mat, idx.length);
    const sizes = new Float32Array(idx.length);
    idx.forEach((bi, k) => {
      const b = buildings[bi];
      const h = (b.headingDeg * Math.PI) / 180;
      q.setFromAxisAngle(up, Math.atan2(Math.sin(h), -Math.cos(h)));
      p.set(b.x, b.y, b.z);
      s.set(b.width, b.wallHeight + b.roofHeight * (b.archetype === 'flat' ? 1 : 0.5), b.depth);
      mesh.setMatrixAt(k, m.compose(p, q, s));
      mesh.setColorAt(k, col.setHex(b.wallColor));
      sizes[k] = visualSize(b);
    });
    const box = chunkBounds(buildings, c.indices);
    mesh.boundingBox = box.clone();
    mesh.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    group.add(mesh);
    chunks.push({ mesh, box, sizes, lod: LOD_HIDDEN });
  }
  scene.add(group);
  const frustum = new THREE.Frustum();
  const pm = new THREE.Matrix4();
  let drawCalls = 0;
  return {
    buildings,
    update(camera: THREE.PerspectiveCamera): void {
      camera.updateMatrixWorld();
      pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(pm);
      const e = camera.matrixWorld.elements;
      drawCalls = 0;
      for (const c of chunks) {
        const d = distanceToBox(c.box, e[12], e[13], e[14]);
        c.lod = selectLod(d, c.lod, cfg);
        const n = c.lod === LOD_HIDDEN ? 0 : boxCount(c.sizes, d, cfg);
        c.mesh.count = n;
        c.mesh.visible = n > 0;
        if (n > 0 && frustum.intersectsBox(c.box)) drawCalls++;
      }
    },
    obstacleTop,
    stats: () => ({ buildings: buildings.length, drawCalls }),
    dispose(): void {
      scene.remove(group);
      for (const c of chunks) c.mesh.dispose();
      geo.dispose();
      mat.dispose();
    },
  };
}
