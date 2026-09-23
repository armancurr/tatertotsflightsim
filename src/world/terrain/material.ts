/**
 * The terrain material: MeshStandardMaterial extended with onBeforeCompile so
 * three's PBR lighting, shadow receiving, log/reversed depth and — importantly —
 * the (atmosphere-overridden) fog chunks all stay intact. `fog: true`.
 * The procedural surface lives in terrainShader.ts; its noise texture and
 * detail textures are generated at start-up in a worker (detailWorker.ts).
 */
import * as THREE from 'three';
import { CONFIG, type Config } from '../../config';
import type { WorldLayout } from '../layout';
import { runwayFrames } from '../runway';
import {
  TERRAIN_VERTEX_PARS,
  TERRAIN_BEGIN_VERTEX,
  TERRAIN_WORLDPOS_VERTEX,
  TERRAIN_FRAGMENT_PARS,
  TERRAIN_MAP_FRAGMENT,
  TERRAIN_ROUGHNESS_FRAGMENT,
  TERRAIN_NORMAL_FRAGMENT,
  MAX_TOWNS,
  MAX_RUNWAYS,
} from './terrainShader';
import { generateDetailSet, generateNoiseTexture, NOISE_TEX_SIZE } from './detailTextures';

export interface TerrainMaterial {
  material: THREE.MeshStandardMaterial;
  /** Advance animated detail (surf, wind in the crops) and the detail fade-in. */
  setTime(t: number): void;
  /** Resolves when the noise texture is in place (the surface looks right from then on). */
  ready: Promise<void>;
  /** True once the detail textures are uploaded. */
  detailReady(): boolean;
  dispose(): void;
}

export interface TerrainMaterialOptions {
  /** Detail texture size (default 512). */
  detailSize?: number;
  /** Max anisotropic filtering for the detail textures (default 8). */
  anisotropy?: number;
}

function replaceOnce(src: string, find: string, repl: string): string {
  if (!src.includes(find)) throw new Error(`terrain material: shader chunk ${find} not found`);
  return src.replace(find, repl);
}

function noiseTexture(data: Uint8Array, size: number): THREE.DataTexture {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = THREE.NoColorSpace;
  t.name = 'terrain-noise';
  t.needsUpdate = true;
  return t;
}

function arrayTexture(data: Uint8Array, size: number, layers: number, anisotropy: number, name: string): THREE.DataArrayTexture {
  const t = new THREE.DataArrayTexture(data, size, size, layers);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = anisotropy;
  t.colorSpace = THREE.NoColorSpace;
  t.name = name;
  t.needsUpdate = true;
  return t;
}

export function createTerrainMaterial(layout: WorldLayout, cfg: Config = CONFIG, opts: TerrainMaterialOptions = {}): TerrainMaterial {
  const ap = layout.airport;
  const paved = ap.pavedAreas.slice(0, 8);
  const pavedA = [];
  const pavedB = [];
  for (let i = 0; i < 8; i++) {
    const r = paved[i];
    if (!r) {
      pavedA.push(new THREE.Vector4(1e9, 1e9, 0, 0));
      pavedB.push(new THREE.Vector4(0, -1, 1, 0));
      continue;
    }
    const h = (r.headingDeg * Math.PI) / 180;
    pavedA.push(new THREE.Vector4(r.center.x, r.center.z, r.halfLength, r.halfWidth));
    pavedB.push(new THREE.Vector4(Math.sin(h), -Math.cos(h), i === 0 ? 0 : 1, 0));
  }
  const townA: THREE.Vector4[] = [];
  const townB: THREE.Vector4[] = [];
  const towns = layout.towns.slice(0, MAX_TOWNS);
  for (let i = 0; i < MAX_TOWNS; i++) {
    const t = towns[i];
    townA.push(t ? new THREE.Vector4(t.x, t.z, t.radius, (t.gridAngleDeg * Math.PI) / 180) : new THREE.Vector4(1e9, 1e9, 0, 0));
    townB.push(t ? new THREE.Vector4(t.blockSize, t.density, 0, 0) : new THREE.Vector4(60, 0, 0, 0));
  }

  // every runway (36/18 first): threshold, length, heading — approach corridors stay clear
  const frames = runwayFrames(cfg).slice(0, MAX_RUNWAYS);
  const runwaysU: THREE.Vector4[] = [];
  for (let i = 0; i < MAX_RUNWAYS; i++) {
    const r = frames[i];
    runwaysU.push(r ? new THREE.Vector4(r.threshold.x, r.threshold.z, r.length, (r.headingDeg * Math.PI) / 180) : new THREE.Vector4(1e9, 1e9, 0, 0));
  }
  const seed = (cfg.world.seed | 0) + 404;
  const detailSize = opts.detailSize ?? 512;
  const aniso = opts.anisotropy ?? 8;
  // Placeholders until the worker delivers (neutral grey noise, flat detail).
  const noise0 = noiseTexture(new Uint8Array([128, 128, 128, 128]), 1);
  const det0 = arrayTexture(new Uint8Array([128, 128, 128, 128]), 1, 1, 1, 'terrain-detail-albedo');
  const detN0 = arrayTexture(new Uint8Array([128, 128, 255, 255]), 1, 1, 1, 'terrain-detail-normal');
  const uniforms = {
    uTime: { value: 0 },
    uSplit: { value: cfg.world.terrain.lodSplitFactor },
    uPavedA: { value: pavedA },
    uPavedB: { value: pavedB },
    uPavedCount: { value: paved.length },
    uAirport: { value: new THREE.Vector4(ap.runway.center.x, ap.runway.center.z, ap.flatRadius, (ap.runway.headingDeg * Math.PI) / 180) },
    uRunways: { value: runwaysU },
    uRunwayCount: { value: frames.length },
    uTownA: { value: townA },
    uTownB: { value: townB },
    uTownCount: { value: towns.length },
    uNoise: { value: noise0 as THREE.Texture },
    uDetA: { value: det0 as THREE.Texture },
    uDetN: { value: detN0 as THREE.Texture },
    uDetail: { value: 0 },
  };
  const owned: THREE.Texture[] = [noise0, det0, detN0];

  let detailArrived = -1;
  let lastT = 0;
  let resolveReady!: () => void;
  const ready = new Promise<void>((res) => (resolveReady = res));
  let worker: Worker | null = null;
  const onNoise = (data: Uint8Array, size: number) => {
    const t = noiseTexture(data, size);
    owned.push(t);
    uniforms.uNoise.value = t;
    resolveReady();
  };
  const onDetail = (albedo: Uint8Array, normal: Uint8Array, size: number, layers: number) => {
    const a = arrayTexture(albedo, size, layers, aniso, 'terrain-detail-albedo');
    const n = arrayTexture(normal, size, layers, aniso, 'terrain-detail-normal');
    owned.push(a, n);
    uniforms.uDetA.value = a;
    uniforms.uDetN.value = n;
    detailArrived = 0;
    if (lastT === 0) uniforms.uDetail.value = 1; // before the first frame: no fade needed
  };
  if (typeof Worker !== 'undefined') {
    try {
      worker = new Worker(new URL('./detailWorker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent) => {
        const m = e.data;
        if (m?.type === 'noise') onNoise(m.data as Uint8Array, m.size as number);
        else if (m?.type === 'detail') {
          onDetail(m.albedo as Uint8Array, m.normal as Uint8Array, m.size as number, m.layers as number);
          worker?.terminate();
          worker = null;
        }
      };
      worker.onerror = (err) => console.error('terrain detail worker error', err.message);
      worker.postMessage({ size: detailSize, noiseSize: NOISE_TEX_SIZE, seed });
    } catch (err) {
      console.warn('terrain: detail worker unavailable, generating on the main thread', err);
      worker = null;
    }
  }
  if (!worker && !uniforms.uDetail.value && detailArrived < 0) {
    // No workers (node / old browsers): small textures on this thread.
    onNoise(generateNoiseTexture(NOISE_TEX_SIZE, seed), NOISE_TEX_SIZE);
    const set = generateDetailSet(64, seed);
    onDetail(set.albedo, set.normal, set.size, set.layers);
  }

  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0, fog: true });
  material.name = 'terrain';
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    let v = shader.vertexShader;
    v = replaceOnce(v, '#include <common>', `#include <common>\n${TERRAIN_VERTEX_PARS}`);
    v = replaceOnce(v, '#include <begin_vertex>', TERRAIN_BEGIN_VERTEX);
    v = replaceOnce(v, '#include <worldpos_vertex>', `#include <worldpos_vertex>\n${TERRAIN_WORLDPOS_VERTEX}`);
    shader.vertexShader = v;
    let f = shader.fragmentShader;
    // the atmosphere's fog override carries the sun direction (bale shadows); plain three fog doesn't
    const atmoSun = THREE.ShaderChunk.fog_pars_fragment.includes('atmoFog') ? '#define TERRAIN_ATMO_SUN\n' : '';
    f = replaceOnce(f, '#include <common>', `${atmoSun}#include <common>\n${TERRAIN_FRAGMENT_PARS}`);
    f = replaceOnce(f, '#include <map_fragment>', TERRAIN_MAP_FRAGMENT);
    f = replaceOnce(f, '#include <roughnessmap_fragment>', TERRAIN_ROUGHNESS_FRAGMENT);
    f = replaceOnce(f, '#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${TERRAIN_NORMAL_FRAGMENT}`);
    shader.fragmentShader = f;
  };
  material.customProgramCacheKey = () => `terrain-v3${THREE.ShaderChunk.fog_pars_fragment.includes('atmoFog') ? '-atmo' : ''}`;
  return {
    material,
    ready,
    detailReady: () => detailArrived >= 0,
    setTime(t: number) {
      const dt = Math.min(0.1, Math.max(0, t - lastT));
      lastT = t;
      uniforms.uTime.value = t;
      // fade the detail in over ~0.8 s so its arrival never pops
      if (detailArrived >= 0 && uniforms.uDetail.value < 1) {
        detailArrived += dt;
        uniforms.uDetail.value = Math.min(1, detailArrived / 0.8);
      }
    },
    dispose() {
      worker?.terminate();
      worker = null;
      for (const t of owned) t.dispose();
      material.dispose();
    },
  };
}
