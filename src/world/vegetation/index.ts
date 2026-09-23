/**
 * Trees and forests: deterministic placement (placement.ts) generated in Web
 * Workers (workers.ts, vegetation.worker.ts) or inline, streamed per chunk with
 * LOD levels and pooled buffers (streamer.ts, pool.ts), near instanced meshes
 * per species with shadows, wind and translucency, far impostor billboards
 * per chunk (impostors.ts, materials.ts), LOD/thinning (lod.ts) and the
 * physics obstacle query (obstacles.ts).
 *
 * Main-thread work per frame is bounded and allocation-free: chunk bookkeeping,
 * copying delivered chunks into pooled GPU buffers, the impostor prefix counts,
 * and (every few metres of camera travel or degrees of rotation) re-gathering
 * the near set from the per-cell index with per-cell frustum culling.
 */
import * as THREE from 'three';
import { CONFIG } from '../../config';
import { placementParams, treesInCell, worldOf, SPECIES_COUNT, type DensityFn, type HeightFn, type VegWorld } from './placement';
import { createObstacleField } from './obstacles';
import { lodParams, keepFraction } from './lod';
import { SizeClassPool, sizeClasses, type PoolHandle } from './pool';
import { ChunkStreamer, chunkKey, type StreamChunk, type AsyncChunkSource } from './streamer';
import { I_STRIDE, I_X, I_Y, I_Z, I_H, I_R, I_CODE, I_TINT, extractCell, type PackedChunk } from './pack';
import { buildSpeciesGeometry } from './species';
import { createVegUniforms, createNearMaterial, createNearDepthMaterial, createImpostorMaterial, CROWN_CENTER, TILE_MARGIN } from './materials';
import { createImpostorAtlas } from './impostors';
import { getFoliageTextures } from './textures';

export type VegetationConfig = typeof CONFIG.world.vegetation;

export interface VegetationOptions {
  heightAt: HeightFn;
  densityAt: DensityFn;
  /** The full placement world (site sampling); defaults to heightAt + densityAt. */
  world?: VegWorld;
  seed?: number;
  /** Optional: bake the impostor atlas right away (otherwise baked lazily on first draw). */
  renderer?: THREE.WebGLRenderer;
  /** Asynchronous chunk generation (the worker pool); inline when absent. */
  source?: AsyncChunkSource | null;
  /** Overrides of CONFIG.world.vegetation (tests, previews). */
  config?: Partial<VegetationConfig>;
}

export interface VegetationStats {
  trees: number;
  drawCalls: number;
  chunks: number;
  pooled: number;
  nearTrees: number;
  impostorTrees: number;
  visibleChunks: number;
  poolCreated: number;
  pendingCells: number;
  pendingJobs: number;
  cellsThisFrame: number;
  urgent: boolean;
  nearRebuilds: number;
}

export interface Vegetation {
  update(camera: THREE.PerspectiveCamera, time: number, sunDirection?: THREE.Vector3, sunColor?: THREE.Color): void;
  obstacleTop(x: number, z: number): number;
  stats(): VegetationStats;
  /** True when every chunk within `radius` (m, horizontal) of the last camera has its trees. */
  isReadyAround(radius: number): boolean;
  dispose(): void;
  readonly root: THREE.Group;
  /** Ready chunks with their bounding sphere and instance data (tests/debug). */
  debugChunks(): { sphere: THREE.Sphere; array: Float32Array; count: number; level: number }[];
  /** The near instanced meshes (one per species). */
  readonly nearMeshes: readonly THREE.InstancedMesh[];
}

interface Slot {
  array: Float32Array;
  buffer: THREE.InstancedInterleavedBuffer;
  geometry: THREE.InstancedBufferGeometry;
  mesh: THREE.Mesh;
}

export function createVegetation(scene: THREE.Scene, opts: VegetationOptions): Vegetation {
  const cfg: VegetationConfig = { ...CONFIG.world.vegetation, ...(opts.config ?? {}) };
  const seed = opts.seed ?? CONFIG.world.seed;
  const params = placementParams(cfg);
  const lod = lodParams(cfg);
  const world: VegWorld = opts.world ?? worldOf(opts.densityAt, opts.heightAt);
  const root = new THREE.Group();
  root.name = 'vegetation';
  scene.add(root);

  const tex = getFoliageTextures();
  const uniforms = createVegUniforms(lod, cfg.translucency);
  const atlas = createImpostorAtlas(cfg.impostorTileSize, tex);
  const impMat = createImpostorMaterial(uniforms, atlas);
  const nearMat = createNearMaterial(uniforms, tex);
  const nearDepth = createNearDepthMaterial(uniforms, tex);
  if (opts.renderer) atlas.bake(opts.renderer);

  // ── impostor quad + pool ──────────────────────────────────────────────────
  const quadPos = new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3);
  const quadUv = new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2);
  const quadNrm = new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 3);
  const quadIdx = new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1);
  const bakeHook = (r: THREE.WebGLRenderer): void => {
    if (!atlas.baked) atlas.bake(r);
  };
  const perChunk = ((cfg.chunkSize / cfg.cellSize) * cfg.gridPerCell) ** 2;
  const pool = new SizeClassPool<Slot>(
    sizeClasses(perChunk),
    (cap) => {
      const array = new Float32Array(cap * I_STRIDE);
      const buffer = new THREE.InstancedInterleavedBuffer(array, I_STRIDE, 1);
      buffer.setUsage(THREE.DynamicDrawUsage);
      const geometry = new THREE.InstancedBufferGeometry();
      geometry.setIndex(quadIdx);
      geometry.setAttribute('position', quadPos);
      geometry.setAttribute('uv', quadUv);
      geometry.setAttribute('normal', quadNrm);
      geometry.setAttribute('iA', new THREE.InterleavedBufferAttribute(buffer, 4, 0));
      geometry.setAttribute('iB', new THREE.InterleavedBufferAttribute(buffer, 4, 4));
      geometry.instanceCount = 0;
      geometry.boundingSphere = new THREE.Sphere();
      const mesh = new THREE.Mesh(geometry, impMat);
      mesh.name = 'vegetation-impostors';
      mesh.visible = false;
      mesh.matrixAutoUpdate = false;
      mesh.onBeforeRender = bakeHook;
      root.add(mesh);
      return { array, buffer, geometry, mesh };
    },
    (s) => {
      root.remove(s.mesh);
      s.geometry.dispose();
    },
    8,
  );

  const streamer = new ChunkStreamer<Slot>({
    chunkSize: cfg.chunkSize,
    cellSize: cfg.cellSize,
    viewDistance: cfg.treeViewDistance,
    maxCellsPerFrame: cfg.maxCellsPerFrame,
    frameBudgetMs: cfg.frameBudgetMs,
    urgentBudgetMs: cfg.urgentBudgetMs,
    urgentRadius: cfg.meshDistance,
    source: opts.source ?? undefined,
    generateCell: (cx, cz, rankMax) => treesInCell(cx, cz, world, seed, params, rankMax),
    levelFor: (d3) => keepFraction(d3, lod, 1),
    acquire: (n) => pool.acquire(n),
    release: (h: PoolHandle<Slot>) => {
      h.value.mesh.visible = false;
      h.value.geometry.instanceCount = 0;
      pool.release(h);
    },
    arrayOf: (s) => s.array,
    onReady: (c) => {
      if (c.dist < cfg.meshDistance + cfg.cellSize * 2) nearDirty = true;
      if (!c.slot) return;
      const s = c.slot.value;
      s.buffer.clearUpdateRanges();
      s.buffer.addUpdateRange(0, c.count * I_STRIDE);
      s.buffer.needsUpdate = true;
      // Conservative bounds: trees + crown + billboard margin × max thinning growth.
      const grow = TILE_MARGIN * cfg.thinCompensationMax;
      const pad = c.maxR * grow;
      const x0 = c.x0 - pad;
      const x1 = c.x1 + pad;
      const z0 = c.z0 - pad;
      const z1 = c.z1 + pad;
      const y0 = c.minY - 0.2 * c.maxH - pad;
      const y1 = c.maxY + c.maxH * (1 + grow) + pad;
      const bs = s.geometry.boundingSphere!;
      bs.center.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
      bs.radius = 0.5 * Math.hypot(x1 - x0, y1 - y0, z1 - z0);
      s.mesh.visible = true;
    },
  });

  // ── near meshes (one per species; all cast shadows) ───────────────────────
  const nearGeoms = Array.from({ length: SPECIES_COUNT }, (_, s) => buildSpeciesGeometry(s));
  const nearCap = cfg.nearCapacity;
  const nearMeshes = nearGeoms.map((g, s) => {
    const m = new THREE.InstancedMesh(g, nearMat, nearCap);
    m.name = `vegetation-near-${s}`;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(nearCap * 3), 3);
    m.instanceColor.setUsage(THREE.DynamicDrawUsage);
    m.count = 0;
    m.castShadow = true;
    m.receiveShadow = true;
    m.customDepthMaterial = nearDepth;
    m.boundingSphere = new THREE.Sphere();
    m.frustumCulled = true;
    root.add(m);
    return m;
  });
  let nearDirty = true;
  const lastNear = new THREE.Vector3(Infinity, Infinity, Infinity);
  const lastDir = new THREE.Vector3(0, 0, 0);
  const counts = new Int32Array(SPECIES_COUNT);
  const cellBox = new THREE.Box3();
  const nearFrustum = new THREE.Frustum();
  const inflated = new THREE.Matrix4();

  const obstacles = createObstacleField({
    densityAt: world.densityAt,
    heightAt: world.heightAt,
    world,
    seed,
    params,
    cacheCells: cfg.obstacleCacheCells,
    // Share the renderer's work: cells of fully generated chunks are exact copies.
    provider: (cx, cz) => {
      const per = streamer.cellsPerSide;
      const c = streamer.chunks.get(chunkKey(Math.floor(cx / per), Math.floor(cz / per)));
      if (!c || c.level < 1 || !c.slot) return null;
      const i = cx - c.kx * per;
      const j = cz - c.kz * per;
      const p: PackedChunk = {
        count: c.count, data: c.slot.value.array, rankCdf: c.rankCdf, cellStart: c.cellStart, cellItems: c.cellItems,
        minY: c.minY, maxY: c.maxY, maxH: c.maxH, maxR: c.maxR, rankMax: c.level,
      };
      return extractCell(p, j * per + i, cx, cz);
    },
  });

  let capScale = 1;
  const frustum = new THREE.Frustum();
  const projView = new THREE.Matrix4();
  const cp = new THREE.Vector3();
  const camDir = new THREE.Vector3();
  const st: VegetationStats = {
    trees: 0, drawCalls: 0, chunks: 0, pooled: 0, nearTrees: 0, impostorTrees: 0, visibleChunks: 0,
    poolCreated: 0, pendingCells: 0, pendingJobs: 0, cellsThisFrame: 0, urgent: false, nearRebuilds: 0,
  };

  function rebuildNear(cam: THREE.Vector3, camera: THREE.PerspectiveCamera): void {
    nearDirty = false;
    st.nearRebuilds++;
    lastNear.copy(cam);
    lastDir.copy(camDir);
    const R = cfg.meshDistance + cfg.nearRebuildDistance + 10;
    const R2 = R * R;
    const always2 = cfg.nearAlwaysDistance * cfg.nearAlwaysDistance;
    // widen the frustum so small rotations between rebuilds never expose missing trees
    inflated.copy(camera.projectionMatrix);
    inflated.elements[0] /= cfg.nearFrustumWiden;
    inflated.elements[5] /= cfg.nearFrustumWiden;
    projView.multiplyMatrices(inflated, camera.matrixWorldInverse);
    nearFrustum.setFromProjectionMatrix(projView);
    counts.fill(0);
    const C = cfg.cellSize;
    for (const c of streamer.chunks.values()) {
      if (c.level < 1 || !c.slot || c.dist > R) continue;
      const per = c.cellsPerSide;
      const a = c.slot.value.array;
      for (let ci = 0; ci < per * per; ci++) {
        const k0 = c.cellStart[ci];
        const k1 = c.cellStart[ci + 1];
        if (k0 === k1) continue;
        const x0 = c.x0 + (ci % per) * C;
        const z0 = c.z0 + Math.floor(ci / per) * C;
        const dx = cam.x < x0 ? x0 - cam.x : cam.x > x0 + C ? cam.x - x0 - C : 0;
        const dz = cam.z < z0 ? z0 - cam.z : cam.z > z0 + C ? cam.z - z0 - C : 0;
        const dh2 = dx * dx + dz * dz;
        if (dh2 > R2) continue;
        if (dh2 > always2) {
          cellBox.min.set(x0 - 12, c.minY - 2, z0 - 12);
          cellBox.max.set(x0 + C + 12, c.maxY + c.maxH + 2, z0 + C + 12);
          if (!nearFrustum.intersectsBox(cellBox)) continue;
        }
        for (let k = k0; k < k1; k++) {
          const o = c.cellItems[k] * I_STRIDE;
          const x = a[o + I_X];
          const y = a[o + I_Y];
          const z = a[o + I_Z];
          const h = a[o + I_H];
          const ex = x - cam.x;
          const ey = y + CROWN_CENTER * h - cam.y;
          const ez = z - cam.z;
          if (ex * ex + ey * ey + ez * ez > R2) continue;
          const code = a[o + I_CODE];
          const sp = Math.floor(code);
          const m = nearMeshes[sp];
          const n = counts[sp];
          if (n >= nearCap) continue;
          counts[sp]++;
          const r = a[o + I_R];
          const rot = (code - sp) * Math.PI * 2;
          const cs = Math.cos(rot);
          const sn = Math.sin(rot);
          const e = m.instanceMatrix.array as Float32Array;
          const w = n * 16;
          e[w] = cs * r; e[w + 1] = 0; e[w + 2] = -sn * r; e[w + 3] = 0;
          e[w + 4] = 0; e[w + 5] = h; e[w + 6] = 0; e[w + 7] = 0;
          e[w + 8] = sn * r; e[w + 9] = 0; e[w + 10] = cs * r; e[w + 11] = 0;
          e[w + 12] = x; e[w + 13] = y; e[w + 14] = z; e[w + 15] = 1;
          // instanceColor = (tint hash, species, 0): the shader derives the tint and the crown variation
          const ca = m.instanceColor!.array as Float32Array;
          ca[n * 3] = a[o + I_TINT];
          ca[n * 3 + 1] = sp;
          ca[n * 3 + 2] = 0;
        }
      }
    }
    let total = 0;
    for (let sp = 0; sp < SPECIES_COUNT; sp++) {
      const m = nearMeshes[sp];
      const n = counts[sp];
      m.count = n;
      total += n;
      m.instanceMatrix.clearUpdateRanges();
      m.instanceMatrix.addUpdateRange(0, n * 16);
      m.instanceMatrix.needsUpdate = true;
      m.instanceColor!.clearUpdateRanges();
      m.instanceColor!.addUpdateRange(0, n * 3);
      m.instanceColor!.needsUpdate = true;
      m.boundingSphere!.center.copy(cam);
      m.boundingSphere!.radius = R + 40;
      m.visible = n > 0;
    }
    st.nearTrees = total;
  }

  /** Impostor instances all chunks would submit with this cap scale. */
  const countAt = (cap: number): number => {
    let n = 0;
    for (const c of streamer.chunks.values()) if (c.slot) n += c.countForKeep(keepFraction(c.dist3, lod, cap));
    return n;
  };

  let lastCamX = 0;
  let lastCamZ = 0;

  return {
    root,
    nearMeshes,
    update(camera: THREE.PerspectiveCamera, time: number, sunDirection?: THREE.Vector3, sunColor?: THREE.Color): void {
      camera.updateMatrixWorld();
      cp.setFromMatrixPosition(camera.matrixWorld);
      camDir.set(-camera.matrixWorld.elements[8], -camera.matrixWorld.elements[9], -camera.matrixWorld.elements[10]);
      lastCamX = cp.x;
      lastCamZ = cp.z;
      const groundY = world.heightAt(cp.x, cp.z);
      const r = streamer.update(cp.x, cp.z, cp.y, Number.isFinite(groundY) ? groundY : 0);
      st.cellsThisFrame = r.generated;
      st.urgent = r.urgent;
      uniforms.uVegTime.value = time * cfg.windSpeed;
      uniforms.uVegWind.value.set(cfg.windStrength, 0.3 * cfg.windStrength);
      if (sunDirection) uniforms.uVegSunDir.value.copy(sunDirection);
      if (sunColor) uniforms.uVegSunColor.value.copy(sunColor);

      if (nearDirty || cp.distanceToSquared(lastNear) > cfg.nearRebuildDistance * cfg.nearRebuildDistance || camDir.dot(lastDir) < cfg.nearRebuildCos) rebuildNear(cp, camera);

      // Global thinning so the total stays under maxTrees (binary search only when over).
      const budget = Math.max(0, cfg.maxTrees - st.nearTrees);
      let target = 1;
      if (countAt(1) > budget) {
        let lo = 0;
        let hi = 1;
        for (let i = 0; i < 12; i++) {
          const mid = (lo + hi) / 2;
          if (countAt(mid) > budget) hi = mid;
          else lo = mid;
        }
        target = lo;
      }
      capScale = target < capScale ? target : Math.min(target, capScale + 0.02);
      uniforms.uVegCap.value = capScale;

      projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(projView);
      let imp = 0;
      let visible = 0;
      for (const c of streamer.chunks.values()) {
        if (!c.slot) continue;
        const s = c.slot.value;
        const n = c.countForKeep(keepFraction(c.dist3, lod, capScale));
        s.geometry.instanceCount = n;
        s.mesh.visible = n > 0;
        imp += n;
        if (n > 0 && frustum.intersectsSphere(s.geometry.boundingSphere!)) visible++;
      }
      let nearDraws = 0;
      for (let i = 0; i < nearMeshes.length; i++) {
        const m = nearMeshes[i];
        if (m.count > 0 && frustum.intersectsSphere(m.boundingSphere!)) nearDraws++;
      }
      st.impostorTrees = imp;
      st.trees = imp + st.nearTrees;
      st.visibleChunks = visible;
      st.drawCalls = visible + nearDraws;
      st.chunks = streamer.chunks.size;
      const ps = pool.stats();
      st.pooled = ps.free;
      st.poolCreated = ps.created;
      st.pendingCells = streamer.pendingCells();
      st.pendingJobs = opts.source ? opts.source.pending() : 0;
    },
    obstacleTop: (x: number, z: number): number => obstacles.top(x, z),
    stats: (): VegetationStats => ({ ...st }),
    isReadyAround(radius: number): boolean {
      for (const c of streamer.chunks.values()) {
        const d = Math.hypot(Math.max(0, c.x0 - lastCamX, lastCamX - c.x1), Math.max(0, c.z0 - lastCamZ, lastCamZ - c.z1));
        if (d <= radius && c.want > 0 && c.level < c.want) return false;
      }
      return streamer.chunks.size > 0;
    },
    debugChunks() {
      const out: { sphere: THREE.Sphere; array: Float32Array; count: number; level: number }[] = [];
      for (const c of streamer.chunks.values()) if (c.slot) out.push({ sphere: c.slot.value.geometry.boundingSphere!, array: c.slot.value.array, count: c.count, level: c.level });
      return out;
    },
    dispose(): void {
      streamer.dispose();
      pool.dispose();
      for (const m of nearMeshes) {
        root.remove(m);
        m.dispose();
      }
      for (const g of nearGeoms) g.dispose();
      nearMat.dispose();
      nearDepth.dispose();
      impMat.dispose();
      atlas.dispose();
      root.clear();
      scene.remove(root);
    },
  };
}
