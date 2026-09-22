/**
 * Trees and forests: deterministic placement (placement.ts), time-sliced chunk
 * streaming with pooled buffers (streamer.ts, pool.ts), near instanced meshes
 * per species with shadows and wind, far impostor billboards per chunk
 * (impostors.ts, materials.ts), LOD/thinning (lod.ts) and the physics
 * obstacle query (obstacles.ts).
 */
import * as THREE from 'three';
import { CONFIG } from '../../config';
import { placementParams, treesInCell, SPECIES_COUNT, type DensityFn, type HeightFn } from './placement';
import { createObstacleField } from './obstacles';
import { lodParams, keepFraction, rectDistance } from './lod';
import { SizeClassPool, sizeClasses, type PoolHandle } from './pool';
import { ChunkStreamer, I_STRIDE, I_X, I_Y, I_Z, I_H, I_R, I_CODE, I_TINT, type StreamChunk } from './streamer';
import { buildSpeciesGeometry } from './species';
import { createVegUniforms, createNearMaterial, createImpostorMaterial, tintColor, CROWN_CENTER, TILE_MARGIN } from './materials';
import { createImpostorAtlas } from './impostors';

export type VegetationConfig = typeof CONFIG.world.vegetation;

export interface VegetationOptions {
  heightAt: HeightFn;
  densityAt: DensityFn;
  seed?: number;
  /** Optional: bake the impostor atlas right away (otherwise baked lazily on first draw). */
  renderer?: THREE.WebGLRenderer;
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
  cellsThisFrame: number;
  urgent: boolean;
}

export interface Vegetation {
  update(camera: THREE.PerspectiveCamera, time: number, sunDirection?: THREE.Vector3): void;
  obstacleTop(x: number, z: number): number;
  stats(): VegetationStats;
  dispose(): void;
  readonly root: THREE.Group;
  /** Ready chunks with their bounding sphere and instance data (tests/debug). */
  debugChunks(): { sphere: THREE.Sphere; array: Float32Array; count: number }[];
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
  const root = new THREE.Group();
  root.name = 'vegetation';
  scene.add(root);

  const uniforms = createVegUniforms(lod);
  const atlas = createImpostorAtlas(cfg.impostorTileSize);
  const impMat = createImpostorMaterial(uniforms, atlas);
  const nearMat = createNearMaterial(uniforms);
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
    generateCell: (cx, cz) => treesInCell(cx, cz, opts.densityAt, opts.heightAt, seed, params),
    acquire: (n) => pool.acquire(n),
    release: (h: PoolHandle<Slot>) => {
      h.value.mesh.visible = false;
      h.value.geometry.instanceCount = 0;
      pool.release(h);
    },
    arrayOf: (s) => s.array,
    onReady: (c) => {
      nearDirty = true;
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

  // ── near meshes (preallocated pool: casters + rest per species) ───────────
  const nearGeoms = Array.from({ length: SPECIES_COUNT }, (_, s) => buildSpeciesGeometry(s));
  const casterCap = Math.max(64, Math.floor(cfg.nearCapacity / 2));
  const mkNear = (s: number, cap: number, shadow: boolean): THREE.InstancedMesh => {
    const m = new THREE.InstancedMesh(nearGeoms[s], nearMat, cap);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    m.instanceColor.setUsage(THREE.DynamicDrawUsage);
    m.count = 0;
    m.castShadow = shadow;
    m.receiveShadow = true;
    m.boundingSphere = new THREE.Sphere();
    root.add(m);
    return m;
  };
  const nearCasters = Array.from({ length: SPECIES_COUNT }, (_, s) => mkNear(s, casterCap, true));
  const nearRest = Array.from({ length: SPECIES_COUNT }, (_, s) => mkNear(s, cfg.nearCapacity, false));
  let nearDirty = true;
  const lastNear = new THREE.Vector3(Infinity, Infinity, Infinity);
  const cellList: { c: StreamChunk<Slot>; ci: number; d: number }[] = [];
  const col = new THREE.Color();

  const obstacles = createObstacleField({ densityAt: opts.densityAt, heightAt: opts.heightAt, seed, params, cacheCells: cfg.obstacleCacheCells });

  let capScale = 1;
  const frustum = new THREE.Frustum();
  const projView = new THREE.Matrix4();
  const st: VegetationStats = {
    trees: 0, drawCalls: 0, chunks: 0, pooled: 0, nearTrees: 0, impostorTrees: 0,
    visibleChunks: 0, poolCreated: 0, pendingCells: 0, cellsThisFrame: 0, urgent: false,
  };

  function rebuildNear(cam: THREE.Vector3): void {
    nearDirty = false;
    lastNear.copy(cam);
    const R = cfg.meshDistance + cfg.nearRebuildDistance + 10;
    cellList.length = 0;
    for (const c of streamer.chunks.values()) {
      if (!c.ready || !c.slot || c.dist > R) continue;
      const per = c.cellsPerSide;
      for (let ci = 0; ci < per * per; ci++) {
        if (c.cellStart[ci] === c.cellStart[ci + 1]) continue;
        const x0 = c.x0 + (ci % per) * cfg.cellSize;
        const z0 = c.z0 + Math.floor(ci / per) * cfg.cellSize;
        const d = rectDistance(cam.x, cam.z, x0, z0, x0 + cfg.cellSize, z0 + cfg.cellSize);
        if (d <= R) cellList.push({ c, ci, d });
      }
    }
    cellList.sort((a, b) => a.d - b.d);
    const counts = new Int32Array(SPECIES_COUNT * 2);
    const R2 = R * R;
    const S2 = cfg.shadowDistance * cfg.shadowDistance;
    for (const { c, ci } of cellList) {
      const a = c.slot!.value.array;
      for (let k = c.cellStart[ci]; k < c.cellStart[ci + 1]; k++) {
        const o = c.cellItems[k] * I_STRIDE;
        const x = a[o + I_X];
        const y = a[o + I_Y];
        const z = a[o + I_Z];
        const h = a[o + I_H];
        const dx = x - cam.x;
        const dy = y + CROWN_CENTER * h - cam.y;
        const dz = z - cam.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > R2) continue;
        const code = a[o + I_CODE];
        const sp = Math.floor(code);
        const shadow = d2 < S2;
        const m = shadow ? nearCasters[sp] : nearRest[sp];
        const slot = sp * 2 + (shadow ? 0 : 1);
        const n = counts[slot];
        if (n >= m.instanceMatrix.count) continue;
        counts[slot]++;
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
        tintColor(a[o + I_TINT], sp, col);
        const ca = m.instanceColor!.array as Float32Array;
        ca[n * 3] = col.r;
        ca[n * 3 + 1] = col.g;
        ca[n * 3 + 2] = col.b;
      }
    }
    let total = 0;
    for (let sp = 0; sp < SPECIES_COUNT; sp++)
      for (const [m, slot] of [[nearCasters[sp], sp * 2], [nearRest[sp], sp * 2 + 1]] as [THREE.InstancedMesh, number][]) {
        const n = counts[slot];
        m.count = n;
        total += n;
        m.instanceMatrix.clearUpdateRanges();
        m.instanceMatrix.addUpdateRange(0, n * 16);
        m.instanceMatrix.needsUpdate = true;
        m.instanceColor!.clearUpdateRanges();
        m.instanceColor!.addUpdateRange(0, n * 3);
        m.instanceColor!.needsUpdate = true;
        m.boundingSphere!.center.copy(cam);
        m.boundingSphere!.radius = R + 60;
        m.visible = n > 0;
      }
    st.nearTrees = total;
  }

  /** Impostor instances all chunks would submit with this cap scale. */
  const countAt = (cap: number, camY: number): number => {
    let n = 0;
    for (const c of streamer.chunks.values()) if (c.slot) n += c.countForKeep(keepFraction(chunkDist3(c, camY), lod, cap));
    return n;
  };
  const chunkDist3 = (c: StreamChunk<Slot>, camY: number): number => {
    const top = c.maxY + c.maxH;
    const dy = camY > top ? camY - top : camY < c.minY ? c.minY - camY : 0;
    return Math.hypot(c.dist, dy);
  };

  return {
    root,
    update(camera: THREE.PerspectiveCamera, time: number): void {
      camera.updateMatrixWorld();
      const cp = camera.getWorldPosition(new THREE.Vector3());
      const r = streamer.update(cp.x, cp.z);
      st.cellsThisFrame = r.generated;
      st.urgent = r.urgent;
      uniforms.uVegTime.value = time * cfg.windSpeed;
      uniforms.uVegWind.value.set(cfg.windStrength, 0.3 * cfg.windStrength);

      if (nearDirty || cp.distanceTo(lastNear) > cfg.nearRebuildDistance) rebuildNear(cp);

      // Global thinning so the total stays under maxTrees.
      const budget = Math.max(0, cfg.maxTrees - st.nearTrees);
      let target = 1;
      if (countAt(1, cp.y) > budget) {
        let lo = 0;
        let hi = 1;
        for (let i = 0; i < 14; i++) {
          const mid = (lo + hi) / 2;
          if (countAt(mid, cp.y) > budget) hi = mid;
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
        const n = c.countForKeep(keepFraction(chunkDist3(c, cp.y), lod, capScale));
        s.geometry.instanceCount = n;
        s.mesh.visible = n > 0;
        imp += n;
        if (n > 0 && frustum.intersectsSphere(s.geometry.boundingSphere!)) visible++;
      }
      let nearDraws = 0;
      for (const m of [...nearCasters, ...nearRest]) if (m.count > 0 && frustum.intersectsSphere(m.boundingSphere!)) nearDraws++;
      st.impostorTrees = imp;
      st.trees = imp + st.nearTrees;
      st.visibleChunks = visible;
      st.drawCalls = visible + nearDraws;
      st.chunks = streamer.chunks.size;
      const ps = pool.stats();
      st.pooled = ps.free;
      st.poolCreated = ps.created;
      st.pendingCells = streamer.pendingCells();
    },
    obstacleTop: (x: number, z: number): number => obstacles.top(x, z),
    stats: (): VegetationStats => ({ ...st }),
    debugChunks() {
      const out: { sphere: THREE.Sphere; array: Float32Array; count: number }[] = [];
      for (const c of streamer.chunks.values()) if (c.slot) out.push({ sphere: c.slot.value.geometry.boundingSphere!, array: c.slot.value.array, count: c.count });
      return out;
    },
    dispose(): void {
      streamer.dispose();
      pool.dispose();
      for (const m of [...nearCasters, ...nearRest]) {
        root.remove(m);
        m.dispose();
      }
      for (const g of nearGeoms) g.dispose();
      nearMat.dispose();
      impMat.dispose();
      atlas.dispose();
      root.clear();
      scene.remove(root);
    },
  };
}
