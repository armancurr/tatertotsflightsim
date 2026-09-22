/**
 * Terrain renderer: quadtree LOD tiles around the camera (quadtree.ts rules),
 * built off the main thread by a worker pool (chunk.ts), uploaded under a
 * per-frame budget, drawn with the procedural terrain material.
 *
 * - While a node's children are still being built the node itself stays drawn
 *   (and vice versa when merging), so there are never holes.
 * - Geometries/meshes are pooled (all tiles share one vertex layout and one
 *   index buffer) and evicted LRU beyond `cacheSize`.
 * - Every tile gets an exact bounding sphere, so three's frustum culling works.
 * - Vertex-shader geomorphing + skirts hide LOD seams and popping.
 */
import * as THREE from 'three';
import { CONFIG, type Config } from '../../config';
import { getHeightfield, type Heightfield } from '../heightfield';
import { getLandcover } from '../landcover';
import { boxDistance, shouldSplit, lodParamsFromConfig, tileKey, type LodParams } from './quadtree';
import { buildChunk, chunkVertexCount, createChunkIndex, type ChunkData } from './chunk';
import { ChunkBuilderPool } from './workerPool';
import { createTerrainMaterial } from './material';

export interface TerrainOptions {
  /** Worker count (default: hardwareConcurrency − 2, clamped 2..4). */
  workers?: number;
  /** Max tile uploads per frame in flight (default 4; 32 before the first ready()). */
  uploadsPerFrame?: number;
  /** Tiles kept (drawn + cached) before LRU eviction (default 560). */
  cacheSize?: number;
  /** Quads per tile side (default config.world.terrain.chunkResolution). */
  resolution?: number;
  receiveShadow?: boolean;
  config?: Config;
}

export interface TerrainStats {
  tiles: number;
  pending: number;
  triangles: number;
}

export interface Terrain {
  update(camera: THREE.PerspectiveCamera): void;
  stats(): TerrainStats;
  /** Resolves when every tile the current view wants is built and uploaded. */
  ready(): Promise<void>;
  dispose(): void;
  readonly group: THREE.Group;
  readonly material: THREE.MeshStandardMaterial;
}

interface Tile {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  node: TNode | null;
  lastDrawn: number;
}

interface TNode {
  key: string;
  level: number;
  ix: number;
  iz: number;
  size: number;
  x0: number;
  z0: number;
  yMin: number;
  yMax: number;
  children: TNode[] | null;
  tile: Tile | null;
  jobId: number;
  lastSeen: number;
  lastSplit: number;
  lastWanted: number;
  dist: number;
}

const ATTRS = ['position', 'normal', 'lc0', 'lc1', 'lcp0', 'lcp1', 'aMorph'] as const;

export function createTerrain(renderer: THREE.WebGLRenderer, scene: THREE.Scene, opts: TerrainOptions = {}): Terrain {
  void renderer;
  const cfg = opts.config ?? CONFIG;
  const hf: Heightfield = getHeightfield();
  const P: LodParams = lodParamsFromConfig(cfg);
  const res = opts.resolution ?? cfg.world.terrain.chunkResolution;
  const cacheSize = opts.cacheSize ?? 560;
  const uploadsSteady = opts.uploadsPerFrame ?? 4;
  const hc = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4;
  const workerCount = opts.workers ?? Math.max(2, Math.min(4, hc - 2));
  const nv = chunkVertexCount(res);
  const trisPerTile = res * res * 2 + 4 * res * 2;

  const group = new THREE.Group();
  group.name = 'terrain';
  scene.add(group);
  const tm = createTerrainMaterial(hf.layout, cfg);
  const material = tm.material;
  const index = new THREE.BufferAttribute(createChunkIndex(res), 1);

  // ── Pools ────────────────────────────────────────────────────────────────
  const freeMeshes: Tile['mesh'][] = [];
  const liveTiles = new Set<Tile>();
  const newMesh = (): Tile['mesh'] => {
    const g = new THREE.BufferGeometry();
    g.setIndex(index);
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Int16Array(nv * 3), 3, true));
    g.setAttribute('lc0', new THREE.BufferAttribute(new Uint8Array(nv * 4), 4, true));
    g.setAttribute('lc1', new THREE.BufferAttribute(new Uint8Array(nv * 4), 4, true));
    g.setAttribute('lcp0', new THREE.BufferAttribute(new Uint8Array(nv * 4), 4, true));
    g.setAttribute('lcp1', new THREE.BufferAttribute(new Uint8Array(nv * 4), 4, true));
    g.setAttribute('aMorph', new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
    g.boundingSphere = new THREE.Sphere();
    g.boundingBox = new THREE.Box3();
    const m = new THREE.Mesh(g, material);
    m.matrixAutoUpdate = false;
    m.castShadow = false;
    m.receiveShadow = opts.receiveShadow ?? true;
    m.name = 'terrain-tile';
    return m;
  };
  const upload = (node: TNode, data: ChunkData): Tile => {
    const mesh = freeMeshes.pop() ?? newMesh();
    const g = mesh.geometry;
    const a = g.attributes;
    (a.position.array as Float32Array).set(data.positions);
    (a.normal.array as Int16Array).set(data.normals);
    (a.lc0.array as Uint8Array).set(data.lc0);
    (a.lc1.array as Uint8Array).set(data.lc1);
    (a.lcp0.array as Uint8Array).set(data.lcp0);
    (a.lcp1.array as Uint8Array).set(data.lcp1);
    (a.aMorph.array as Float32Array).set(data.morph);
    for (const k of ATTRS) a[k].needsUpdate = true;
    const half = data.size / 2;
    const midY = (data.minY + data.maxY) / 2;
    const halfY = (data.maxY - data.minY) / 2;
    g.boundingBox!.min.set(-half, data.minY, -half);
    g.boundingBox!.max.set(half, data.maxY, half);
    g.boundingSphere!.center.set(0, midY, 0);
    g.boundingSphere!.radius = Math.sqrt(2 * half * half + halfY * halfY) + 1;
    mesh.position.set(data.center.x, 0, data.center.z);
    mesh.updateMatrix();
    mesh.matrixWorldNeedsUpdate = true;
    mesh.visible = false;
    group.add(mesh);
    const tile: Tile = { mesh, node, lastDrawn: -1 };
    liveTiles.add(tile);
    node.yMin = data.minY;
    node.yMax = data.maxY;
    return tile;
  };
  const release = (tile: Tile) => {
    liveTiles.delete(tile);
    if (tile.node) tile.node.tile = null;
    tile.node = null;
    group.remove(tile.mesh);
    tile.mesh.visible = false;
    if (freeMeshes.length < 64) freeMeshes.push(tile.mesh);
    else tile.mesh.geometry.dispose();
  };

  // ── Builders ─────────────────────────────────────────────────────────────
  const completed: { id: number; data: ChunkData }[] = [];
  const pool = new ChunkBuilderPool(workerCount, (id, data) => completed.push({ id, data }), (req) => buildChunk(hf, getLandcover(), req));
  const jobs = new Map<number, TNode>();
  let nextJob = 1;

  // ── Quadtree ─────────────────────────────────────────────────────────────
  const roots = new Map<string, TNode>();
  const estimateY = (x0: number, z0: number, size: number): [number, number] => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = 0; j <= 2; j++)
      for (let i = 0; i <= 2; i++) {
        const h = hf.height(x0 + (i * size) / 2, z0 + (j * size) / 2);
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
    const pad = 20 + size * 0.04;
    return [lo - pad, hi + pad];
  };
  const makeNode = (level: number, ix: number, iz: number): TNode => {
    const size = P.rootSize / 2 ** level;
    const x0 = ix * size;
    const z0 = iz * size;
    const [yMin, yMax] = estimateY(x0, z0, size);
    return { key: tileKey(level, ix, iz), level, ix, iz, size, x0, z0, yMin, yMax, children: null, tile: null, jobId: 0, lastSeen: 0, lastSplit: 0, lastWanted: 0, dist: 0 };
  };

  let frame = 0;
  const cam = new THREE.Vector3();
  const drawList: TNode[] = [];
  const wanted: TNode[] = [];

  const draw = (n: TNode) => drawList.push(n);
  const want = (n: TNode) => {
    n.lastWanted = frame;
    wanted.push(n);
  };

  const resolve = (n: TNode): boolean => {
    n.lastSeen = frame;
    const d = boxDistance(cam.x, cam.y, cam.z, n.x0, n.x0 + n.size, n.yMin, n.yMax, n.z0, n.z0 + n.size);
    n.dist = d;
    if (d > P.maxDistance) return true;
    if (shouldSplit(n.size, d, P)) {
      n.lastSplit = frame;
      if (!n.children) n.children = [makeNode(n.level + 1, n.ix * 2, n.iz * 2), makeNode(n.level + 1, n.ix * 2 + 1, n.iz * 2), makeNode(n.level + 1, n.ix * 2, n.iz * 2 + 1), makeNode(n.level + 1, n.ix * 2 + 1, n.iz * 2 + 1)];
      const mark = drawList.length;
      let ok = true;
      for (const c of n.children) ok = resolve(c) && ok;
      if (ok) return true;
      if (n.tile) {
        drawList.length = mark;
        draw(n);
        return true;
      }
      return false;
    }
    if (n.tile) {
      draw(n);
      return true;
    }
    want(n);
    // merging: the children may still be cached — draw them until this tile arrives
    if (n.children && n.children.every((c) => c.tile)) {
      for (const c of n.children) draw(c);
      return true;
    }
    return false;
  };

  const pruneSubtree = (n: TNode) => {
    if (n.tile) release(n.tile);
    if (n.jobId) {
      pool.cancel(n.jobId);
      jobs.delete(n.jobId);
      n.jobId = 0;
    }
    if (n.children) for (const c of n.children) pruneSubtree(c);
    n.children = null;
  };
  const sweep = (n: TNode) => {
    if (!n.children) return;
    if (frame - n.lastSplit > 300) {
      for (const c of n.children) pruneSubtree(c);
      n.children = null;
      return;
    }
    for (const c of n.children) sweep(c);
  };

  let readyWaiters: (() => void)[] = [];
  let everReady = false;
  let lastMissing = Infinity;

  const update = (camera: THREE.PerspectiveCamera) => {
    frame++;
    camera.getWorldPosition(cam);
    tm.setTime(performance.now() / 1000);
    drawList.length = 0;
    wanted.length = 0;
    // roots around the camera
    const R = P.rootSize;
    const span = Math.ceil(P.maxDistance / R);
    const cx = Math.floor(cam.x / R);
    const cz = Math.floor(cam.z / R);
    for (let iz = cz - span; iz <= cz + span; iz++)
      for (let ix = cx - span; ix <= cx + span; ix++) {
        const k = tileKey(0, ix, iz);
        let r = roots.get(k);
        if (!r) {
          r = makeNode(0, ix, iz);
          roots.set(k, r);
        }
        resolve(r);
      }
    // visibility
    for (const t of liveTiles) t.mesh.visible = false;
    for (const n of drawList) {
      n.tile!.lastDrawn = frame;
      n.tile!.mesh.visible = true;
    }
    // requests: cancel stale queued jobs, (re)submit wanted ones by distance
    for (const [id, node] of jobs) {
      if (node.lastWanted !== frame && pool.isQueued(id)) {
        pool.cancel(id);
        jobs.delete(id);
        node.jobId = 0;
      }
    }
    for (const n of wanted) {
      const prio = n.dist - n.size * 0.01;
      if (n.jobId) pool.reprioritize(n.jobId, prio);
      else {
        n.jobId = nextJob++;
        jobs.set(n.jobId, n);
        pool.submit(n.jobId, { x0: n.x0, z0: n.z0, size: n.size, res }, prio);
      }
    }
    pool.pump();
    // uploads under a budget
    const budget = everReady ? uploadsSteady : 32;
    const t0 = performance.now();
    let done = 0;
    while (completed.length > 0 && done < budget && (done === 0 || performance.now() - t0 < 4)) {
      const { id, data } = completed.shift()!;
      const node = jobs.get(id);
      jobs.delete(id);
      if (!node || node.jobId !== id) continue;
      node.jobId = 0;
      if (!node.tile) node.tile = upload(node, data);
      done++;
    }
    // LRU eviction of tiles not drawn this frame
    if (liveTiles.size > cacheSize) {
      const idle = [...liveTiles].filter((t) => t.lastDrawn !== frame).sort((a, b) => a.lastDrawn - b.lastDrawn);
      for (let i = 0; i < idle.length && liveTiles.size > cacheSize; i++) release(idle[i]);
    }
    // forget far-away parts of the tree now and then
    if (frame % 120 === 0) {
      for (const [k, r] of roots) {
        if (frame - r.lastSeen > 300) {
          pruneSubtree(r);
          roots.delete(k);
        } else sweep(r);
      }
    }
    lastMissing = wanted.length;
    if (wanted.length === 0 && completed.length === 0) {
      everReady = true;
      const w = readyWaiters;
      readyWaiters = [];
      for (const f of w) f();
    }
  };

  return {
    group,
    material,
    update,
    stats: () => ({ tiles: drawList.length, pending: pool.pending + completed.length + Math.max(0, lastMissing - pool.pending), triangles: drawList.length * trisPerTile }),
    ready: () =>
      new Promise<void>((res) => {
        if (frame > 0 && lastMissing === 0 && completed.length === 0) res();
        else readyWaiters.push(res);
      }).then(() => tm.ready),
    dispose: () => {
      pool.dispose();
      for (const t of [...liveTiles]) release(t);
      for (const m of freeMeshes) m.geometry.dispose();
      freeMeshes.length = 0;
      index.array = new Uint16Array(0);
      tm.dispose();
      group.removeFromParent();
      roots.clear();
      jobs.clear();
      completed.length = 0;
    },
  };
}
