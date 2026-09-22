/**
 * Roads renderer: streams road chunks around the camera.
 *
 * All heavy work (network → plan → chunk geometry) runs in a Web Worker
 * (roads.worker.ts → builder.ts); where there is no worker (node tests, or a
 * custom heightAt/layout) the same builder runs inline, time-sliced per frame.
 * Two levels of detail split per fragment at `nearDistance` (material.ts):
 * near chunks (chunkSize, full cross-sections, bridges with railings, guard
 * rails; built nearest-first, evicted when far) and far super-chunks
 * (farChunkSize, 5-column ribbons of the major roads and streets). One draw
 * call per visible chunk + street lights (lights.ts).
 *
 * Cars read the lane graph (`lanes`) and the rendered surface (`surface`) of
 * the active instance (`activeRoads()`).
 */
import * as THREE from 'three';
import { CONFIG } from '../../config';
import { getLayout, type WorldLayout } from '../layout';
import { terrainHeight } from '../heightfield';
import { RoadBuilder, type ChunkBuild, type ChunkInfo, type LaneData, type RoadSummary } from './builder';
import { createRoadMaterials } from './material';
import { createStreetLights, streetLightLevel, type StreetLights } from './lights';
import { RoadSurface } from './surface';

export { buildRoadNetwork, getRoadNetwork, KIND_RANK, type RoadNetwork, type NetRoad, type NetKind, type FarmSite } from './network';
export { planRoads, runsFor, type RoadPlan, type RoadPiece, type RoadNode } from './plan';
export { buildRun, mergeRibbons, ribbonColumns } from './ribbon';
export { RoadSurface } from './surface';
export type { LaneData, RoadSummary } from './builder';

export interface RoadsOptions {
  heightAt: (x: number, z: number) => number;
  layout?: WorldLayout;
  /** Build in a Web Worker (default: when available and heightAt/layout are the real ones). */
  worker?: boolean;
}

export interface RoadsStats {
  /** Near chunks with roads (total). */
  chunks: number;
  farChunks: number;
  built: number;
  pending: number;
  drawCalls: number;
  vertices: number;
  lights: number;
  lightsDrawn: number;
  worker: boolean;
  ready: boolean;
}

export interface Roads {
  update(camera: THREE.PerspectiveCamera, time: number, sunElevationDeg?: number): void;
  /** Resolves when the roads around the camera are built. */
  ready(camera: THREE.PerspectiveCamera): Promise<void>;
  /** The lane graph (null until the plan is known). */
  readonly lanes: LaneData | null;
  /** The rendered road surface of the built near chunks (for cars). */
  readonly surface: RoadSurface;
  stats(): RoadsStats;
  dispose(): void;
}

let active: Roads | null = null;
/** The roads instance most recently created (and not disposed), for the cars system. */
export function activeRoads(): Roads | null {
  return active;
}

interface ChunkRec {
  info: ChunkInfo;
  state: 0 | 1 | 2;
  mesh: THREE.Mesh | null;
  box: THREE.Box3;
  dist: number;
  vertices: number;
}

const tmpV = new THREE.Vector3();

export function createRoads(scene: THREE.Scene, opts: RoadsOptions): Roads {
  const rc = CONFIG.world.towns.roads;
  const mats = createRoadMaterials();
  const group = new THREE.Group();
  group.name = 'roads';
  scene.add(group);
  const surface = new RoadSurface();
  const useWorker = opts.worker ?? (typeof Worker !== 'undefined' && opts.heightAt === terrainHeight && !opts.layout);
  const chunks: ChunkRec[] = [];
  const byKey = new Map<string, ChunkRec>();
  let lanes: LaneData | null = null;
  let lights: StreetLights | null = null;
  let summaryReady = false;
  let inline: RoadBuilder | null = null;
  let worker: Worker | null = null;
  let inFlight = 0;
  let disposed = false;
  let drawCalls = 0;
  const cam = new THREE.Vector3(0, 0, 0);
  let camKnown = false;
  const readyWaiters: (() => void)[] = [];
  let isReady = false;

  const onSummary = (s: RoadSummary) => {
    for (const info of s.chunks) {
      const box = new THREE.Box3(new THREE.Vector3(info.x0, -200, info.z0), new THREE.Vector3(info.x0 + info.size, 3000, info.z0 + info.size));
      const rec: ChunkRec = { info, state: 0, mesh: null, box, dist: Infinity, vertices: 0 };
      chunks.push(rec);
      byKey.set(`${info.far ? 'f' : 'n'}${info.key}`, rec);
    }
    lanes = s.lanes;
    lights = createStreetLights(scene, s.lights);
    summaryReady = true;
    pump();
  };

  const onBuilt = (b: ChunkBuild) => {
    const rec = byKey.get(`${b.far ? 'f' : 'n'}${b.key}`);
    if (!rec || disposed) return;
    if (rec.mesh) disposeMesh(rec);
    const g = b.geometry;
    rec.state = 2;
    if (g.index.length === 0) {
      rec.vertices = 0;
      checkReady();
      return;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(g.position, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(g.normal, 3));
    geo.setAttribute('aRoad', new THREE.BufferAttribute(g.road, 4));
    geo.setAttribute('aJunc', new THREE.BufferAttribute(g.junc, 4));
    geo.setAttribute('aJunc2', new THREE.BufferAttribute(g.junc2, 2));
    geo.setIndex(new THREE.BufferAttribute(g.index, 1));
    const half = rec.info.size / 2;
    geo.boundingBox = new THREE.Box3(new THREE.Vector3(-half - 50, g.minY - 5, -half - 50), new THREE.Vector3(half + 50, g.maxY + 5, half + 50));
    geo.boundingSphere = geo.boundingBox.getBoundingSphere(new THREE.Sphere());
    const mesh = new THREE.Mesh(geo, b.far ? mats.far : mats.near);
    mesh.name = `roads-${b.far ? 'far' : 'near'}-${b.key}`;
    mesh.position.set(b.ox, 0, b.oz);
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.updateMatrixWorld();
    mesh.visible = false;
    group.add(mesh);
    rec.mesh = mesh;
    rec.vertices = g.position.length / 3;
    rec.box.min.set(b.ox - half - 50, g.minY - 5, b.oz - half - 50);
    rec.box.max.set(b.ox + half + 50, g.maxY + 5, b.oz + half + 50);
    if (!b.far) surface.add(b.key, b.profiles);
    checkReady();
  };

  const disposeMesh = (rec: ChunkRec) => {
    if (!rec.mesh) return;
    group.remove(rec.mesh);
    rec.mesh.geometry.dispose();
    rec.mesh = null;
    if (!rec.info.far) surface.remove(rec.info.key);
  };

  if (useWorker) {
    try {
      worker = new Worker(new URL('./roads.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent) => {
        const m = e.data as { type: string; summary?: RoadSummary; build?: ChunkBuild; message?: string; key?: string; far?: boolean };
        if (disposed) return;
        if (m.type === 'summary' && m.summary) onSummary(m.summary);
        else if (m.type === 'built' && m.build) {
          inFlight--;
          onBuilt(m.build);
          pump();
        } else if (m.type === 'error') {
          console.error('[roads] worker:', m.message);
          if (m.key !== undefined) {
            inFlight--;
            const rec = byKey.get(`${m.far ? 'f' : 'n'}${m.key}`);
            if (rec) rec.state = 2;
          }
        }
      };
      worker.onerror = (err) => console.error('[roads] worker error', err.message);
      worker.postMessage({ type: 'init' });
    } catch (err) {
      console.warn('[roads] no worker, building inline', err);
      worker = null;
    }
  }
  if (!worker) {
    inline = new RoadBuilder(opts.layout ?? getLayout(), opts.heightAt, rc);
    onSummary(inline.summary());
  }

  /** Distance (xz) from the camera to a chunk's square. */
  const rectDist = (info: ChunkInfo, x: number, z: number): number => {
    const dx = x < info.x0 ? info.x0 - x : x > info.x0 + info.size ? x - info.x0 - info.size : 0;
    const dz = z < info.z0 ? info.z0 - z : z > info.z0 + info.size ? z - info.z0 - info.size : 0;
    return Math.hypot(dx, dz);
  };
  const wantNear = rc.nearDistance + 500;
  const evictNear = rc.nearDistance + 3000;
  const readyNear = Math.min(rc.nearDistance, 2000);
  const readyFar = 7000;

  /** Next chunk to build (nearest wanted, near chunks before far at equal distance). */
  const nextJob = (): ChunkRec | null => {
    let best: ChunkRec | null = null;
    let bd = Infinity;
    for (const r of chunks) {
      if (r.state !== 0) continue;
      const lim = r.info.far ? rc.viewDistance : wantNear;
      if (r.dist > lim) continue;
      // far chunks slightly de-prioritised (the near LOD is what the camera sees first)
      const d = r.info.far ? r.dist * 1.3 + 400 : r.dist;
      if (d < bd) {
        bd = d;
        best = r;
      }
    }
    return best;
  };

  const refreshDistances = () => {
    for (const r of chunks) r.dist = rectDist(r.info, cam.x, cam.z);
  };

  function checkReady(): void {
    if (isReady || !summaryReady || !camKnown) return;
    for (const r of chunks) {
      if (r.state === 2) continue;
      if (r.dist < (r.info.far ? readyFar : readyNear)) return;
    }
    isReady = true;
    readyWaiters.splice(0).forEach((f) => f());
  }

  function pump(budgetMs = rc.frameBudgetMs): void {
    if (!summaryReady || !camKnown || disposed) return;
    if (worker) {
      while (inFlight < 2) {
        const job = nextJob();
        if (!job) break;
        job.state = 1;
        inFlight++;
        worker.postMessage({ type: 'build', key: job.info.key, far: job.info.far });
      }
      return;
    }
    const t0 = performance.now();
    while (performance.now() - t0 < budgetMs) {
      const job = nextJob();
      if (!job) break;
      job.state = 1;
      onBuilt(inline!.build(job.info.key, job.info.far));
    }
    checkReady();
  }

  const frustum = new THREE.Frustum();
  const pm = new THREE.Matrix4();
  let lastSortX = Infinity;
  let lastSortZ = Infinity;

  const roads: Roads = {
    get lanes() {
      return lanes;
    },
    surface,
    ready(camera) {
      camera.updateMatrixWorld();
      cam.setFromMatrixPosition(camera.matrixWorld);
      camKnown = true;
      refreshDistances();
      if (!worker) {
        // inline: build what the first frame needs now (startup, before the loop)
        while (!isReady) {
          const job = nextJob();
          if (!job || job.dist >= (job.info.far ? readyFar : readyNear)) break;
          job.state = 1;
          onBuilt(inline!.build(job.info.key, job.info.far));
        }
        checkReady();
        isReady = true;
        return Promise.resolve();
      }
      pump();
      checkReady();
      return isReady ? Promise.resolve() : new Promise<void>((res) => readyWaiters.push(res));
    },
    update(camera, _time, sunElevationDeg = 45) {
      camera.updateMatrixWorld();
      cam.setFromMatrixPosition(camera.matrixWorld);
      camKnown = true;
      if (!summaryReady) return;
      if ((cam.x - lastSortX) ** 2 + (cam.z - lastSortZ) ** 2 > 40 * 40) {
        lastSortX = cam.x;
        lastSortZ = cam.z;
        refreshDistances();
        // evict near chunks far behind
        for (const r of chunks) {
          if (!r.info.far && r.state === 2 && r.dist > evictNear) {
            disposeMesh(r);
            r.state = 0;
          }
        }
      }
      // inline: urgent budget while nothing visible is built yet
      let urgent = false;
      if (!worker) {
        urgent = true;
        for (const r of chunks) if (r.state === 2 && r.dist < rc.nearDistance) urgent = false;
      }
      pump(urgent ? rc.urgentBudgetMs : rc.frameBudgetMs);
      pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(pm, camera.coordinateSystem, camera.reversedDepth);
      drawCalls = 0;
      for (const r of chunks) {
        const m = r.mesh;
        if (!m) continue;
        const d3 = r.box.distanceToPoint(cam);
        let vis: boolean;
        if (r.info.far) {
          // skip far chunks entirely inside the near sphere (every fragment would be discarded)
          const far = tmpV.set(Math.max(Math.abs(cam.x - r.box.min.x), Math.abs(cam.x - r.box.max.x)), Math.max(Math.abs(cam.y - r.box.min.y), Math.abs(cam.y - r.box.max.y)), Math.max(Math.abs(cam.z - r.box.min.z), Math.abs(cam.z - r.box.max.z))).length();
          vis = d3 < rc.viewDistance && far > rc.nearDistance;
        } else vis = d3 < rc.nearDistance;
        m.visible = vis && frustum.intersectsBox(r.box);
        if (m.visible) drawCalls++;
      }
      lights?.update(camera, streetLightLevel(sunElevationDeg));
      if (lights && lights.drawn > 0) drawCalls += 1 + (streetLightLevel(sunElevationDeg) > 0.02 ? 1 : 0);
    },
    stats() {
      let built = 0;
      let pending = 0;
      let vertices = 0;
      let near = 0;
      let far = 0;
      for (const r of chunks) {
        if (r.info.far) far++;
        else near++;
        if (r.state === 2) built++;
        if (r.state === 1) pending++;
        vertices += r.mesh ? r.vertices : 0;
      }
      return { chunks: near, farChunks: far, built, pending, drawCalls, vertices, lights: lights?.count ?? 0, lightsDrawn: lights?.drawn ?? 0, worker: !!worker, ready: isReady };
    },
    dispose() {
      disposed = true;
      worker?.terminate();
      for (const r of chunks) disposeMesh(r);
      lights?.dispose();
      scene.remove(group);
      mats.dispose();
      if (active === roads) active = null;
    },
  };
  active = roads;
  return roads;
}
