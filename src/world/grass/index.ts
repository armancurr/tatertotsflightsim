/**
 * 3D grass near the camera: instanced tufts of curved blades (+ wildflower
 * heads in meadows) on grass landcover, within `viewDistance` of the camera
 * and only while the camera is low (taxi, take-off, landing, low passes).
 *
 *   - Placement (placement.ts) is per 16 m cell, deterministic, generated in
 *     the vegetation Web Workers (or inline in tests) and cached (bounded LRU).
 *   - Each cell is rank-sorted, so its density falls off with distance as a
 *     prefix: keep(d) = min(1, (d0/d)^exp). The CPU copies the prefixes of the
 *     visible cells (per-cell frustum test) into ONE instance buffer when the
 *     camera has moved/turned enough or cells arrived; the vertex shader then
 *     trims each tuft smoothly by its own distance (no popping at cell edges).
 *   - One draw call. Wind sway (gusts travelling across the field), per-tuft
 *     colour (lush ↔ dry, tint), blade translucency when back-lit, fog, shadows
 *     received from trees and the aircraft.
 */
import * as THREE from 'three';
import { CONFIG } from '../../config';
import { generateGrassCell, G_STRIDE, G_RANK, type GrassCell, type GrassParams } from './placement';
import type { VegWorld } from '../vegetation/placement';
import type { GrassJobSource } from '../vegetation/workers';

export type GrassConfig = typeof CONFIG.world.grass;

export interface GrassOptions {
  world: VegWorld;
  seed?: number;
  /** Asynchronous generation (the shared vegetation workers); inline when absent. */
  source?: GrassJobSource | null;
  config?: Partial<GrassConfig>;
  /** Inline mode: cells generated per frame at most (default 6). */
  inlineCellsPerFrame?: number;
}

export interface GrassStats {
  tufts: number;
  cells: number;
  visibleCells: number;
  pending: number;
  cached: number;
  rebuilds: number;
  active: boolean;
  drawCalls: number;
}

export interface Grass {
  update(camera: THREE.PerspectiveCamera, time: number): void;
  stats(): GrassStats;
  readonly mesh: THREE.Mesh;
  /** The instance data currently drawn (tests). */
  debugInstances(): { data: Float32Array; count: number };
  dispose(): void;
}

interface CellState {
  cx: number;
  cz: number;
  cell: GrassCell | null;
  requested: boolean;
  lastUsed: number;
  /** Distance from the camera to the cell centre (this frame). */
  d: number;
}

const byDist = (a: CellState, b: CellState): number => a.d - b.d;

const OFF = 1 << 20;
const cellKey = (cx: number, cz: number): number => (cx + OFF) * 2097152 + (cz + OFF);

/** Builds the tuft geometry: `blades` curved blades (3 tris each) + 2 crossed flower-head quads. */
export function buildTuftGeometry(blades: number, seed = 7): THREE.BufferGeometry {
  let s = seed >>> 0;
  const rnd = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = []; // x: 0/1 side (flower: 2), y: height along the blade 0..1
  const idx: number[] = [];
  const tips: [number, number, number][] = [];
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * Math.PI * 2 + rnd() * 0.8;
    const r = 0.06 + 0.16 * rnd();
    const bx = Math.cos(a) * r;
    const bz = Math.sin(a) * r;
    const lean = 0.18 + 0.3 * rnd();
    const ld = a + (rnd() - 0.5) * 1.2; // lean direction (mostly outward)
    const lx = Math.cos(ld);
    const lz = Math.sin(ld);
    const h = 0.7 + 0.3 * rnd();
    const w = 0.035 + 0.02 * rnd();
    // blade plane faces sideways to the lean
    const sx = -lz;
    const sz = lx;
    const base = pos.length / 3;
    const pts: [number, number][] = [
      [0, 0],
      [0.55, 0.5],
      [1, 1],
    ];
    for (const [t, k] of pts) {
      const bend = lean * t * t;
      const cx = bx + lx * bend;
      const cz = bz + lz * bend;
      const cy = h * t * (1 - 0.15 * lean * t);
      const ww = t < 1 ? w * (1 - 0.5 * k) : 0;
      const nx = lx * 0.5;
      const nz = lz * 0.5;
      if (t < 1) {
        pos.push(cx - sx * ww, cy, cz - sz * ww, cx + sx * ww, cy, cz + sz * ww);
        nrm.push(nx, 1, nz, nx, 1, nz);
        uv.push(0, t, 1, t);
      } else {
        pos.push(cx, cy, cz);
        nrm.push(nx, 1, nz);
        uv.push(0.5, 1);
        tips.push([cx, cy, cz]);
      }
    }
    idx.push(base, base + 1, base + 3, base, base + 3, base + 2, base + 2, base + 3, base + 4);
  }
  // flower heads: two small crossed quads above the two tallest tips
  tips.sort((p, q) => q[1] - p[1]);
  for (let f = 0; f < 2 && f < tips.length; f++) {
    const [cx, cy, cz] = tips[f];
    const hs = 0.07;
    for (let k = 0; k < 2; k++) {
      const a = k * Math.PI / 2 + f;
      const dx = Math.cos(a) * hs;
      const dz = Math.sin(a) * hs;
      const base = pos.length / 3;
      pos.push(cx - dx, cy - hs * 0.4, cz - dz, cx + dx, cy - hs * 0.4, cz + dz, cx + dx, cy + hs * 1.2, cz + dz, cx - dx, cy + hs * 1.2, cz - dz);
      for (let q = 0; q < 4; q++) nrm.push(0, 1, 0);
      uv.push(2, 0, 2, 0, 2, 1, 2, 1);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

const DIR_LOOP_CALL = 'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';

export function createGrassMaterial(uniforms: { uGrassTime: THREE.IUniform<number>; uGrassView: THREE.IUniform<number>; uGrassFull: THREE.IUniform<number>; uGrassExp: THREE.IUniform<number>; uGrassFade: THREE.IUniform<number>; uGrassWind: THREE.IUniform<number> }): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, side: THREE.DoubleSide, fog: true });
  m.name = 'grass';
  const lights = THREE.ShaderChunk.lights_fragment_begin.split(DIR_LOOP_CALL).join(
    `${DIR_LOOP_CALL}
    {
      float fwd = pow(clamp(dot(geometryViewDir, -directLight.direction), 0.0, 1.0), 3.0);
      reflectedLight.directDiffuse += directLight.color * material.diffuseColor.rgb * vec3(1.2, 1.3, 0.5) * (0.8 * fwd + 0.25) * vGrassT * 0.8;
    }`,
  );
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uGrassTime;
uniform float uGrassView;
uniform float uGrassFull;
uniform float uGrassExp;
uniform float uGrassFade;
uniform float uGrassWind;
attribute vec4 gA;
attribute vec4 gB;
varying vec3 vGrassCol;
varying float vGrassT;`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `float gKind = floor(gB.x);
  float gRot = fract(gB.x) * 6.2831853;
  float gCs = cos(gRot);
  float gSn = sin(gRot);
  vec3 objectNormal = normalize(vec3(gCs * normal.x - gSn * normal.z, normal.y * 1.6, gSn * normal.x + gCs * normal.z));`,
      )
      .replace(
        '#include <begin_vertex>',
        `float gH = gA.w;
  vec3 gP = position;
  bool gFlower = uv.x > 1.5;
  float gT = uv.y;
  // per-tuft distance thinning (rank < keep), shrinking smoothly over the last 15 % of its keep band
  float gD = distance(cameraPosition.xz, gA.xz);
  float gKeep = gD <= uGrassFull ? 1.0 : pow(uGrassFull / gD, uGrassExp);
  gKeep *= (1.0 - smoothstep(uGrassView * 0.8, uGrassView, gD)) * uGrassFade;
  float gAlive = clamp((gKeep - gB.z) / max(0.15 * gKeep, 1e-3), 0.0, 1.0);
  float gS = gH * gAlive;
  if (gFlower && gKind < 0.5) gS = 0.0;
  vec3 transformed = vec3(gCs * gP.x - gSn * gP.z, gP.y, gSn * gP.x + gCs * gP.z) * vec3(gS * 1.1, gS, gS * 1.1);
  // wind: gusts travelling across the field, bending ∝ height²
  float gPh = dot(gA.xz, vec2(0.21, 0.17));
  float gGust = sin(uGrassTime * 1.7 - gA.x * 0.09 + sin(gA.z * 0.05)) * 0.6 + sin(uGrassTime * 3.1 + gPh) * 0.4;
  float gBend = (0.25 + 0.3 * gGust) * uGrassWind * gT * gT * gS;
  transformed.xz += vec2(0.8, 0.6) * gBend + vec2(sin(uGrassTime * 5.3 + gPh * 7.0), cos(uGrassTime * 4.7 + gPh * 5.0)) * 0.04 * gT * gS;
  transformed.y -= gBend * 0.25;
  transformed += gA.xyz;
  vGrassT = gFlower ? 0.0 : gT;
  // colour: dark shaded base → lighter tips; lush green ↔ dry straw; per-tuft tint
  float gTint = gB.y;
  float gLush = gB.w;
  vec3 gGreen = mix(vec3(0.045, 0.085, 0.022), vec3(0.075, 0.12, 0.03), gTint);
  vec3 gDry = mix(vec3(0.13, 0.12, 0.05), vec3(0.17, 0.15, 0.07), gTint);
  vec3 gTip = mix(gDry, gGreen, smoothstep(0.25, 0.75, gLush));
  vGrassCol = mix(gTip * 0.35, gTip * 1.15, smoothstep(0.0, 1.0, gT));
  if (gFlower) vGrassCol = gKind < 1.5 ? vec3(0.8, 0.8, 0.74) : gKind < 2.5 ? vec3(0.75, 0.55, 0.05) : vec3(0.3, 0.12, 0.45);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vGrassCol;
varying float vGrassT;`,
      )
      .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb = vGrassCol;')
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
#ifdef DOUBLE_SIDED
  normal = normalize(vNormal); nonPerturbedNormal = normal;
#endif`,
      )
      .replace('#include <lights_fragment_begin>', lights);
  };
  m.customProgramCacheKey = () => 'grass-v1';
  return m;
}

export function createGrass(scene: THREE.Scene, opts: GrassOptions): Grass {
  const cfg: GrassConfig = { ...CONFIG.world.grass, ...(opts.config ?? {}) };
  const seed = opts.seed ?? CONFIG.world.seed;
  const gp: GrassParams = { cellSize: cfg.cellSize, perSide: cfg.perSide, mownRadius: cfg.mownRadius };
  const C = cfg.cellSize;
  const R = cfg.viewDistance;
  const inlinePerFrame = opts.inlineCellsPerFrame ?? 6;

  const tuft = buildTuftGeometry(cfg.blades);
  const cap = cfg.maxTufts;
  const array = new Float32Array(cap * G_STRIDE);
  const buffer = new THREE.InstancedInterleavedBuffer(array, G_STRIDE, 1);
  buffer.setUsage(THREE.DynamicDrawUsage);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = tuft.index;
  geometry.setAttribute('position', tuft.getAttribute('position'));
  geometry.setAttribute('normal', tuft.getAttribute('normal'));
  geometry.setAttribute('uv', tuft.getAttribute('uv'));
  geometry.setAttribute('gA', new THREE.InterleavedBufferAttribute(buffer, 4, 0));
  geometry.setAttribute('gB', new THREE.InterleavedBufferAttribute(buffer, 4, 4));
  geometry.instanceCount = 0;
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), R + 10);
  const uniforms = {
    uGrassTime: { value: 0 },
    uGrassView: { value: R },
    uGrassFull: { value: cfg.fullDensityDistance },
    uGrassExp: { value: cfg.thinExponent },
    uGrassFade: { value: 1 },
    uGrassWind: { value: cfg.windStrength },
  };
  const material = createGrassMaterial(uniforms);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'grass';
  mesh.frustumCulled = true;
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.visible = false;
  scene.add(mesh);

  const cells = new Map<number, CellState>();
  const maxCached = Math.ceil(((2 * (R + 2 * C)) / C) ** 2 * 1.6);
  let frame = 0;
  let dirty = true;
  const lastPos = new THREE.Vector3(Infinity, 0, 0);
  const lastDir = new THREE.Vector3();
  const camDir = new THREE.Vector3();
  const cp = new THREE.Vector3();
  const frustum = new THREE.Frustum();
  const pv = new THREE.Matrix4();
  const inflated = new THREE.Matrix4();
  const box = new THREE.Box3();
  const work: CellState[] = [];
  let count = 0;
  const st: GrassStats = { tufts: 0, cells: 0, visibleCells: 0, pending: 0, cached: 0, rebuilds: 0, active: false, drawCalls: 0 };

  const onDelivered = (key: number, cell: GrassCell): void => {
    const c = cells.get(key);
    if (!c) return;
    c.cell = cell;
    c.requested = false;
    dirty = true;
  };

  /** Rank prefix of a cell for keep fraction k (the cell is rank-sorted). */
  const prefix = (cell: GrassCell, k: number): number => {
    if (k >= 1) return cell.count;
    let lo = 0;
    let hi = cell.count;
    const d = cell.data;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (d[mid * G_STRIDE + G_RANK] < k) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  function rebuild(camera: THREE.PerspectiveCamera, fade: number): void {
    st.rebuilds++;
    lastPos.copy(cp);
    lastDir.copy(camDir);
    dirty = false;
    inflated.copy(camera.projectionMatrix);
    inflated.elements[0] /= 1.3;
    inflated.elements[5] /= 1.3;
    pv.multiplyMatrices(inflated, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(pv);
    count = 0;
    let vis = 0;
    for (const c of cells.values()) {
      const cell = c.cell;
      if (!cell || cell.count === 0) continue;
      const x0 = c.cx * C;
      const z0 = c.cz * C;
      const dx = cp.x < x0 ? x0 - cp.x : cp.x > x0 + C ? cp.x - x0 - C : 0;
      const dz = cp.z < z0 ? z0 - cp.z : cp.z > z0 + C ? cp.z - z0 - C : 0;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > R) continue;
      if (d > 12) {
        box.min.set(x0, cell.minY - 1, z0);
        box.max.set(x0 + C, cell.maxY + 1.5, z0 + C);
        if (!frustum.intersectsBox(box)) continue;
      }
      let k = d <= cfg.fullDensityDistance ? 1 : Math.pow(cfg.fullDensityDistance / d, cfg.thinExponent);
      k *= fade;
      const n = Math.min(prefix(cell, k * 1.02 + 0.01), cap - count);
      if (n <= 0) continue;
      array.set(cell.data.subarray(0, n * G_STRIDE), count * G_STRIDE);
      count += n;
      vis++;
      if (count >= cap) break;
    }
    geometry.instanceCount = count;
    buffer.clearUpdateRanges();
    buffer.addUpdateRange(0, count * G_STRIDE);
    buffer.needsUpdate = true;
    geometry.boundingSphere!.center.copy(cp);
    st.visibleCells = vis;
    st.tufts = count;
  }

  return {
    mesh,
    update(camera: THREE.PerspectiveCamera, time: number): void {
      frame++;
      camera.updateMatrixWorld();
      cp.setFromMatrixPosition(camera.matrixWorld);
      camDir.set(-camera.matrixWorld.elements[8], -camera.matrixWorld.elements[9], -camera.matrixWorld.elements[10]);
      uniforms.uGrassTime.value = time;
      const ground = opts.world.heightAt(cp.x, cp.z);
      const agl = Number.isFinite(ground) ? cp.y - ground : 0;
      const fade = 1 - Math.min(1, Math.max(0, (agl - cfg.fadeHeight) / (cfg.maxHeight - cfg.fadeHeight)));
      uniforms.uGrassFade.value = fade;
      st.active = fade > 0;
      opts.source?.drain(onDelivered);
      if (!st.active) {
        mesh.visible = false;
        geometry.instanceCount = 0;
        st.tufts = 0;
        st.drawCalls = 0;
        lastPos.set(Infinity, 0, 0);
        return;
      }
      // cells in range: request what is missing (nearest first)
      const c0x = Math.floor((cp.x - R) / C);
      const c1x = Math.floor((cp.x + R) / C);
      const c0z = Math.floor((cp.z - R) / C);
      const c1z = Math.floor((cp.z + R) / C);
      work.length = 0;
      let inRange = 0;
      for (let cz = c0z; cz <= c1z; cz++)
        for (let cx = c0x; cx <= c1x; cx++) {
          const x0 = cx * C;
          const z0 = cz * C;
          const dx = cp.x < x0 ? x0 - cp.x : cp.x > x0 + C ? cp.x - x0 - C : 0;
          const dz = cp.z < z0 ? z0 - cp.z : cp.z > z0 + C ? cp.z - z0 - C : 0;
          if (dx * dx + dz * dz > R * R) continue;
          inRange++;
          const key = cellKey(cx, cz);
          let c = cells.get(key);
          if (!c) {
            c = { cx, cz, cell: null, requested: false, lastUsed: frame, d: 0 };
            cells.set(key, c);
          }
          c.lastUsed = frame;
          if (!c.cell) {
            const ex = x0 + C / 2 - cp.x;
            const ez = z0 + C / 2 - cp.z;
            c.d = Math.sqrt(ex * ex + ez * ez);
            work.push(c);
          }
        }
      st.cells = inRange;
      if (work.length > 0) {
        work.sort(byDist);
        if (opts.source) {
          for (const c of work) {
            if (c.requested) continue;
            c.requested = true;
            opts.source.request(cellKey(c.cx, c.cz), c.cx, c.cz, c.d);
          }
        } else {
          for (let i = 0; i < work.length && i < inlinePerFrame; i++) {
            const c = work[i];
            c.cell = generateGrassCell(c.cx, c.cz, opts.world, seed, gp);
            dirty = true;
          }
        }
      }
      // bounded cache: drop the least recently used cells well out of range
      if (cells.size > maxCached) {
        for (const [k, c] of cells) {
          if (frame - c.lastUsed > 2) {
            if (c.requested) opts.source?.cancel(k);
            cells.delete(k);
          }
          if (cells.size <= maxCached * 0.8) break;
        }
      }
      if (dirty || cp.distanceToSquared(lastPos) > cfg.rebuildDistance * cfg.rebuildDistance || camDir.dot(lastDir) < cfg.rebuildCos) rebuild(camera, fade);
      mesh.visible = count > 0;
      st.drawCalls = mesh.visible ? 1 : 0;
      st.pending = opts.source ? opts.source.pending() : work.length;
      st.cached = cells.size;
    },
    stats: () => ({ ...st }),
    debugInstances: () => ({ data: array, count }),
    dispose(): void {
      scene.remove(mesh);
      geometry.dispose();
      tuft.dispose();
      material.dispose();
      cells.clear();
    },
  };
}
