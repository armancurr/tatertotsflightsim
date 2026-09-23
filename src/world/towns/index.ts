/**
 * Towns renderer: every building of the world drawn as instanced parametric
 * archetypes (archetypes.ts) with a procedural facade/roof shader (shaders.ts).
 *
 * - Data: placement → instance records (instances.ts), built in a Web Worker
 *   (`worker: true`, the real terrain) or synchronously (tests, previews).
 *   Until it arrives nothing is drawn and obstacleTop answers −∞.
 * - Near LOD: one InstancedBufferGeometry + mesh per archetype (gable, hip,
 *   flat, gambrel, silo). Each frame the chunks within `nearDistance` (with
 *   hysteresis) that are in the view frustum or near the shadow focus are
 *   selected; when that set changes their contiguous instance ranges are
 *   copied into the draw buffer — shadow-focus chunks first, so the shadow
 *   pass draws only the first `nShadow` instances (onBeforeShadow) while the
 *   colour pass draws them all (onBeforeRender).
 * - Mid/far LOD: ONE static instanced mesh of simple prisms for every
 *   building; its vertex shader culls instances in near chunks (a chunk
 *   texture), too small for their distance, or beyond farDistance (towers
 *   stay to ~16 km), with a dithered fade. No shadows.
 * - `obstacleTop` queries the same placement (what you see is what you hit).
 *
 * update() allocates nothing; draw calls ≤ 6 (+ ≤ 5 shadow).
 */
import * as THREE from 'three';
import { CONFIG } from '../../config';
import { getLayout, type WorldLayout } from '../layout';
import { getRoadNetwork } from '../roads/network';
import { placeBuildings, type Building } from './placement';
import { createObstacleIndex } from './obstacles';
import { ARCH_GEOMETRIES, INST_STRIDE, NEAR_KINDS, type ArchetypeGeometry, type NearKind } from './archetypes';
import { buildInstances, type InstanceSets } from './instances';
import { unpackBuildings } from './pack';
import { createBuildingDepthMaterial, createBuildingMaterial, createBuildingUniforms, type BuildingUniforms } from './material';
import { TALL_SIZE } from './lod';

export { placeBuildings, roofTopAt, buildingRect, type Building } from './placement';
export { createObstacleIndex } from './obstacles';
export { createStandInHeight } from './standin';

export interface TownsOptions {
  heightAt: (x: number, z: number) => number;
  seed?: number;
  layout?: WorldLayout;
  /** Build the placement in a Web Worker (it uses the real `terrainHeight`, so only pass that as heightAt). */
  worker?: boolean;
  /** Pre-placed buildings (previews/tests): skips the placement. */
  buildings?: Building[];
}

export interface TownsStats {
  buildings: number;
  drawCalls: number;
  nearInstances: number;
  shadowInstances: number;
  midInstances: number;
  nearChunks: number;
  rebuilds: number;
  night: number;
  ready: boolean;
  buildMs: number;
}

export interface Towns {
  /** Resolves once the buildings are placed and the meshes exist. */
  ready(): Promise<void>;
  /**
   * Per frame. `focus` = centre of the sun-shadow area (the aircraft; default the camera),
   * `sunDir` = unit vector toward the sun (drives the lit windows at dusk).
   */
  update(camera: THREE.PerspectiveCamera, time: number, focus?: THREE.Vector3, sunDir?: THREE.Vector3): void;
  obstacleTop(x: number, z: number): number;
  stats(): TownsStats;
  dispose(): void;
  /** The placed buildings (read-only; empty until ready). */
  readonly buildings: readonly Building[];
  readonly group: THREE.Group;
}

interface WorkerResult {
  type: 'built';
  packed: Float64Array;
  sets: InstanceSets;
  ms: number;
}

interface NearMesh {
  kind: NearKind;
  mesh: THREE.Mesh;
  geo: THREE.InstancedBufferGeometry;
  src: Float32Array;
  start: Int32Array;
  draw: Float32Array;
  buffer: THREE.InstancedInterleavedBuffer;
  range: { start: number; count: number };
  n: number;
  nShadow: number;
}

/** Shadow focus radius: chunks whose box is within this of the focus cast sun shadows (m). */
const SHADOW_REACH = 450;

function makeGeometry(g: ArchetypeGeometry, buffer: THREE.InstancedInterleavedBuffer): THREE.InstancedBufferGeometry {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(g.position, 3));
  geo.setAttribute('aCoef', new THREE.BufferAttribute(g.coef, 3));
  geo.setAttribute('aOff', new THREE.BufferAttribute(g.offset, 3));
  geo.setAttribute('aNrm', new THREE.BufferAttribute(g.normal, 4));
  geo.setAttribute('aFace', new THREE.BufferAttribute(g.face, 2));
  geo.setIndex(new THREE.BufferAttribute(g.index, 1));
  for (let k = 0; k < 5; k++) geo.setAttribute(`i${'ABCDE'[k]}`, new THREE.InterleavedBufferAttribute(buffer, 4, k * 4));
  geo.instanceCount = 0;
  // never culled by three (we cull by chunk); a huge sphere keeps any consumer honest
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
  geo.boundingBox = new THREE.Box3(new THREE.Vector3(-1e7, -1e7, -1e7), new THREE.Vector3(1e7, 1e7, 1e7));
  return geo;
}

function buildSync(opts: TownsOptions, layout: WorldLayout, chunkSize: number): { buildings: Building[]; sets: InstanceSets } {
  const buildings = opts.buildings ?? placeBuildings(layout, getRoadNetwork(layout, opts.heightAt), opts.heightAt, { seed: opts.seed });
  return { buildings, sets: buildInstances(buildings, chunkSize) };
}

export function createTowns(scene: THREE.Scene, opts: TownsOptions): Towns {
  const cfg = CONFIG.world.towns;
  const layout = opts.layout ?? getLayout();
  const group = new THREE.Group();
  group.name = 'towns';
  scene.add(group);

  let buildings: Building[] = [];
  let obstacle: (x: number, z: number) => number = () => -Infinity;
  let sets: InstanceSets | null = null;
  let uniforms: BuildingUniforms | null = null;
  let nearMat: THREE.MeshStandardMaterial | null = null;
  let midMat: THREE.MeshStandardMaterial | null = null;
  let depthMat: THREE.MeshDepthMaterial | null = null;
  let midMesh: THREE.Mesh | null = null;
  const near: NearMesh[] = [];
  let disposed = false;
  let buildMs = 0;

  // per-chunk state (allocated once the sets are known)
  let chunkNear = new Uint8Array(0);
  let chunkIncl = new Uint8Array(0);
  let order = new Int32Array(0);
  let prevSig = -1;
  let rebuilds = 0;
  let drawCalls = 0;
  let nearInstances = 0;
  let shadowInstances = 0;
  let nearChunks = 0;
  let night = 0;
  const frustum = new THREE.Frustum();
  const pm = new THREE.Matrix4();
  const box = new THREE.Box3();

  const install = (bs: Building[], s: InstanceSets): void => {
    if (disposed) return;
    buildings = bs;
    sets = s;
    obstacle = createObstacleIndex(bs);
    uniforms = createBuildingUniforms(s.chunkCount);
    uniforms.uBldLod.value.set(cfg.minAngularSize, cfg.midDistance, cfg.farDistance, TALL_SIZE);
    nearMat = createBuildingMaterial(uniforms, false);
    midMat = createBuildingMaterial(uniforms, true);
    nearMat.userData.uniforms = uniforms;
    midMat.userData.uniforms = uniforms;
    depthMat = createBuildingDepthMaterial(uniforms);
    chunkNear = new Uint8Array(s.chunkCount);
    chunkIncl = new Uint8Array(s.chunkCount);
    order = new Int32Array(s.chunkCount);
    for (const kind of NEAR_KINDS) {
      const set = s.near[kind];
      const draw = new Float32Array(Math.max(set.data.length, INST_STRIDE));
      const buffer = new THREE.InstancedInterleavedBuffer(draw, INST_STRIDE);
      buffer.setUsage(THREE.DynamicDrawUsage);
      const geo = makeGeometry(ARCH_GEOMETRIES[kind], buffer);
      const mesh = new THREE.Mesh(geo, nearMat);
      mesh.name = `buildings-${kind}`;
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.customDepthMaterial = depthMat;
      mesh.visible = false;
      const nm: NearMesh = { kind, mesh, geo, src: set.data, start: set.start, draw, buffer, range: { start: 0, count: 0 }, n: 0, nShadow: 0 };
      mesh.onBeforeRender = () => {
        geo.instanceCount = nm.n;
      };
      mesh.onBeforeShadow = () => {
        geo.instanceCount = nm.nShadow;
      };
      group.add(mesh);
      near.push(nm);
    }
    const midBuf = new THREE.InstancedInterleavedBuffer(s.mid.data, INST_STRIDE);
    const midGeo = makeGeometry(ARCH_GEOMETRIES.mid, midBuf);
    midGeo.instanceCount = s.mid.data.length / INST_STRIDE;
    midMesh = new THREE.Mesh(midGeo, midMat);
    midMesh.name = 'buildings-mid';
    midMesh.frustumCulled = false;
    midMesh.castShadow = false;
    midMesh.receiveShadow = true;
    midMesh.visible = midGeo.instanceCount > 0;
    group.add(midMesh);
  };

  // ── build: worker (real terrain) or synchronous ──
  let resolveReady: () => void = () => {};
  const readyP = new Promise<void>((r) => (resolveReady = r));
  let worker: Worker | null = null;
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const finishSync = () => {
    const r = buildSync(opts, layout, cfg.chunkSize);
    install(r.buildings, r.sets);
    buildMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    resolveReady();
  };
  if (opts.worker && !opts.buildings && !opts.layout && typeof Worker !== 'undefined') {
    try {
      worker = new Worker(new URL('./towns.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent<WorkerResult>) => {
        if (e.data?.type !== 'built') return;
        const t1 = performance.now();
        install(unpackBuildings(e.data.packed), e.data.sets);
        buildMs = e.data.ms;
        // eslint-disable-next-line no-console
        console.debug(`[towns] ${buildings.length} buildings: worker ${e.data.ms.toFixed(0)} ms, install ${(performance.now() - t1).toFixed(1)} ms`);
        worker?.terminate();
        worker = null;
        resolveReady();
      };
      worker.onerror = (err) => {
        console.warn('[towns] worker failed, building on the main thread', err.message);
        worker?.terminate();
        worker = null;
        finishSync();
      };
      worker.postMessage({ type: 'build', seed: opts.seed, chunkSize: cfg.chunkSize });
    } catch (err) {
      console.warn('[towns] workers unavailable, building on the main thread', err);
      worker = null;
      finishSync();
    }
  } else finishSync();

  /** Copies the included chunks' ranges into the draw buffers (shadow chunks first). */
  const rebuild = (nIncl: number, nShadowChunks: number): void => {
    rebuilds++;
    nearInstances = 0;
    shadowInstances = 0;
    for (const nm of near) {
      let k = 0;
      for (let oi = 0; oi < nIncl; oi++) {
        const c = order[oi];
        const a = nm.start[c];
        const b = nm.start[c + 1];
        if (b > a) {
          const src = nm.src;
          const dst = nm.draw;
          const end = b * INST_STRIDE;
          for (let i = a * INST_STRIDE, j = k * INST_STRIDE; i < end; i++, j++) dst[j] = src[i];
          k += b - a;
        }
        if (oi === nShadowChunks - 1) nm.nShadow = k;
      }
      if (nShadowChunks === 0) nm.nShadow = 0;
      nm.n = k;
      nm.geo.instanceCount = k;
      nm.mesh.visible = k > 0;
      nm.mesh.castShadow = nm.nShadow > 0;
      if (k > 0) {
        // reuse one range object (no allocation): three clears the list after uploading
        nm.range.start = 0;
        nm.range.count = k * INST_STRIDE;
        nm.buffer.updateRanges.length = 0;
        nm.buffer.updateRanges.push(nm.range);
        nm.buffer.needsUpdate = true;
      }
      nearInstances += k;
      shadowInstances += nm.nShadow;
    }
  };

  const nearTex = (): THREE.DataTexture => uniforms!.uBldChunkNear.value as THREE.DataTexture;

  return {
    group,
    get buildings() {
      return buildings;
    },
    ready: () => readyP,
    update(camera: THREE.PerspectiveCamera, _time: number, focus?: THREE.Vector3, sunDir?: THREE.Vector3): void {
      if (!sets || !uniforms) return;
      const s = sets;
      camera.updateMatrixWorld();
      pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(pm);
      const e = camera.matrixWorld.elements;
      const cx = e[12];
      const cy = e[13];
      const cz = e[14];
      const fx = focus ? focus.x : cx;
      const fz = focus ? focus.z : cz;
      const h = cfg.hysteresis;
      const nIn = cfg.nearDistance * (1 - h);
      const nOut = cfg.nearDistance * (1 + h);
      const cb = s.chunkBox;
      let texDirty = false;
      let nIncl = 0;
      let sig = 0;
      nearChunks = 0;
      // pass 1: shadow chunks (near + within reach of the focus), pass 2: the other included near chunks
      for (let pass = 0; pass < 2; pass++) {
        for (let c = 0; c < s.chunkCount; c++) {
          const o = c * 6;
          if (pass === 0) {
            const dx = cx < cb[o] ? cb[o] - cx : cx > cb[o + 3] ? cx - cb[o + 3] : 0;
            const dy = cy < cb[o + 1] ? cb[o + 1] - cy : cy > cb[o + 4] ? cy - cb[o + 4] : 0;
            const dz = cz < cb[o + 2] ? cb[o + 2] - cz : cz > cb[o + 5] ? cz - cb[o + 5] : 0;
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            const wasNear = chunkNear[c] === 1;
            const isNear = d < (wasNear ? nOut : nIn);
            if (isNear !== wasNear) {
              chunkNear[c] = isNear ? 1 : 0;
              texDirty = true;
            }
            chunkIncl[c] = 0;
            if (!isNear) continue;
            nearChunks++;
            const sx = fx < cb[o] ? cb[o] - fx : fx > cb[o + 3] ? fx - cb[o + 3] : 0;
            const sz = fz < cb[o + 2] ? cb[o + 2] - fz : fz > cb[o + 5] ? fz - cb[o + 5] : 0;
            const shadow = sx * sx + sz * sz < SHADOW_REACH * SHADOW_REACH;
            if (shadow) {
              chunkIncl[c] = 2;
              order[nIncl++] = c;
              sig = (Math.imul(sig, 31) + c * 2 + 1) | 0;
              continue;
            }
            box.min.set(cb[o], cb[o + 1], cb[o + 2]);
            box.max.set(cb[o + 3], cb[o + 4], cb[o + 5]);
            if (frustum.intersectsBox(box)) chunkIncl[c] = 1;
          } else if (chunkIncl[c] === 1) {
            order[nIncl++] = c;
            sig = (Math.imul(sig, 31) + c * 2 + 2) | 0;
          }
        }
        if (pass === 0) sig = (Math.imul(sig, 17) + nIncl + 7) | 0;
      }
      let nShadowChunks = 0;
      for (let i = 0; i < nIncl; i++) if (chunkIncl[order[i]] === 2) nShadowChunks++;
      sig = (Math.imul(sig, 13) + nIncl * 7919 + nShadowChunks) | 0;
      if (sig !== prevSig) {
        prevSig = sig;
        rebuild(nIncl, nShadowChunks);
      }
      if (texDirty) {
        const data = nearTex().image.data as Uint8Array;
        for (let c = 0; c < s.chunkCount; c++) data[c] = chunkNear[c] ? 255 : 0;
        nearTex().needsUpdate = true;
      }
      // lit windows from the sun elevation
      if (sunDir) {
        const el = (Math.asin(Math.max(-1, Math.min(1, sunDir.y))) * 180) / Math.PI;
        // lights come on as the sun nears the horizon: ~80 % of full at +4° (dawn), ~20 % at +9° (golden hour)
        const t = Math.max(0, Math.min(1, (el - 1) / 11));
        night = 1 - t * t * (3 - 2 * t);
        uniforms.uBldNight.value = night;
      }
      drawCalls = midMesh && midMesh.visible && nearChunks < s.chunkCount ? 1 : 0;
      for (let i = 0; i < near.length; i++) if (near[i].n > 0) drawCalls++;
    },
    obstacleTop: (x: number, z: number) => obstacle(x, z),
    stats: () => ({
      buildings: buildings.length,
      drawCalls,
      nearInstances,
      shadowInstances,
      midInstances: midMesh ? (midMesh.geometry as THREE.InstancedBufferGeometry).instanceCount : 0,
      nearChunks,
      rebuilds,
      night,
      ready: !!sets,
      buildMs,
    }),
    dispose(): void {
      disposed = true;
      worker?.terminate();
      worker = null;
      scene.remove(group);
      for (const nm of near) nm.geo.dispose();
      midMesh?.geometry.dispose();
      nearMat?.dispose();
      midMat?.dispose();
      depthMat?.dispose();
      uniforms?.uBldChunkNear.value.dispose();
    },
  };
}
