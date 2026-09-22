/**
 * Roads renderer (INTERIM): the network's ribbons (ribbon.ts: trimmed at
 * junctions, draped on heightAt, bridge decks) merged into one mesh per chunk,
 * plain asphalt/gravel colours per kind (vertex colours), polygonOffset so they
 * never z-fight the terrain. Chunks beyond the view distance (streets/drives:
 * streetViewDistance) are hidden.
 *
 * TODO (see report): markings shader (edge lines, dashed centre), bridge
 * structure (deck slab, piers, railings), view-space depth pull, time-sliced
 * chunk builds, cars.
 */
import * as THREE from 'three';
import { CONFIG } from '../../config';
import { getLayout, type WorldLayout } from '../layout';
import { getRoadNetwork } from './network';
import { planRibbons, buildRun, mergeRuns, type RibbonRun } from './ribbon';
import { distanceToBox } from '../towns/lod';

export { buildRoadNetwork, getRoadNetwork, KIND_RANK, type RoadNetwork, type NetRoad, type NetKind, type FarmSite } from './network';
export { planRibbons, buildRun, mergeRuns } from './ribbon';

export interface RoadsOptions {
  heightAt: (x: number, z: number) => number;
  layout?: WorldLayout;
}

export interface Roads {
  update(camera: THREE.PerspectiveCamera, time: number): void;
  dispose(): void;
  stats(): { chunks: number; drawCalls: number; vertices: number };
}

const KIND_COLOR = [0x3b3d40, 0x404245, 0x45474a, 0x4a4b4c, 0x55565a, 0x8a7d68];

export function createRoads(scene: THREE.Scene, opts: RoadsOptions): Roads {
  const rc = CONFIG.world.towns.roads;
  const layout = opts.layout ?? getLayout();
  const net = getRoadNetwork(layout, opts.heightAt);
  const plan = planRibbons(net, layout.bridges, rc);
  const byChunk = new Map<string, { minor: boolean; runs: RibbonRun[] }>();
  for (const r of plan.runs) {
    const minor = r.kind === 'street' || r.kind === 'drive';
    const k = `${r.ci},${r.cj},${minor ? 1 : 0}`;
    let e = byChunk.get(k);
    if (!e) byChunk.set(k, (e = { minor, runs: [] }));
    e.runs.push(r);
  }
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, fog: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  const group = new THREE.Group();
  group.name = 'roads';
  const meshes: { mesh: THREE.Mesh; box: THREE.Box3; dist: number }[] = [];
  let vertices = 0;
  const c = new THREE.Color();
  for (const [key, e] of byChunk) {
    const [ci, cj] = key.split(',').map(Number);
    const ox = (ci + 0.5) * rc.chunkSize;
    const oz = (cj + 0.5) * rc.chunkSize;
    const datas = e.runs.map((r) => buildRun(r, opts.heightAt, rc));
    const m = mergeRuns(e.runs, datas, ox, oz);
    const n = m.position.length / 3;
    const colors = new Float32Array(n * 3);
    for (let v = 0; v < n; v++) {
      const across = Math.abs(m.road[v * 4]);
      const hw = m.road[v * 4 + 2];
      c.setHex(KIND_COLOR[m.road[v * 4 + 3]]);
      if (across > hw + 0.01) c.multiplyScalar(1.25); // verge
      colors.set([c.r, c.g, c.b], v * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.position, 3));
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.setIndex(new THREE.BufferAttribute(m.index, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    g.computeBoundingBox();
    const mesh = new THREE.Mesh(g, mat);
    mesh.position.set(ox, 0, oz);
    mesh.receiveShadow = true;
    mesh.updateMatrixWorld();
    const box = g.boundingBox!.clone().translate(new THREE.Vector3(ox, 0, oz));
    group.add(mesh);
    meshes.push({ mesh, box, dist: e.minor ? rc.streetViewDistance : rc.viewDistance });
    vertices += n;
  }
  scene.add(group);
  const frustum = new THREE.Frustum();
  const pm = new THREE.Matrix4();
  let drawCalls = 0;
  return {
    update(camera: THREE.PerspectiveCamera): void {
      camera.updateMatrixWorld();
      pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(pm);
      const el = camera.matrixWorld.elements;
      drawCalls = 0;
      for (const m of meshes) {
        m.mesh.visible = distanceToBox(m.box, el[12], el[13], el[14]) < m.dist;
        if (m.mesh.visible && frustum.intersectsBox(m.box)) drawCalls++;
      }
    },
    stats: () => ({ chunks: meshes.length, drawCalls, vertices }),
    dispose(): void {
      scene.remove(group);
      for (const m of meshes) m.mesh.geometry.dispose();
      mat.dispose();
    },
  };
}
