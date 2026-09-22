/**
 * The three water materials (sea, lakes, river): MeshStandardMaterial
 * extended with onBeforeCompile (shaders.ts), `fog: true`, transparent with
 * depth writes. Uniform objects in `shared` are referenced by all three (one
 * update per frame reaches every program).
 */
import * as THREE from 'three';
import {
  WATER_VERTEX_PARS,
  WATER_BEGIN_VERTEX,
  WATER_WORLDPOS_VERTEX,
  WATER_PROJECT_VERTEX,
  WATER_FRAGMENT_PARS,
  WATER_SURFACE_FRAGMENT,
  WATER_ROUGHNESS_FRAGMENT,
  WATER_NORMAL_FRAGMENT,
  WATER_OPAQUE_FRAGMENT,
} from './shaders';

export type WaterKind = 'sea' | 'lake' | 'river';

type U<T> = { value: T };

export interface SharedWaterUniforms {
  uTime: U<number>;
  uOrigin: U<THREE.Vector2>;
  uSunDir: U<THREE.Vector3>;
  uSkyZenith: U<THREE.Color>;
  uSkyHorizon: U<THREE.Color>;
  uDetail: U<THREE.Texture>;
  uBathyN: U<THREE.Texture>;
  uBathyNXf: U<THREE.Vector4>;
  uBathyF: U<THREE.Texture>;
  uBathyFXf: U<THREE.Vector4>;
}

export interface WaterMaterialUniforms {
  uWaveA: U<Float32Array>;
  uWaveB: U<Float32Array>;
  uWaveGain: U<number>;
  uDetailL1: U<THREE.Vector4>;
  uDetailL2: U<THREE.Vector4>;
  uDetailOff: U<THREE.Vector4>;
  uBaseVar: U<number>;
  uAbsorb: U<THREE.Vector3>;
  uDeep: U<THREE.Vector3>;
  uBed: U<THREE.Vector3>;
  uWhitecap: U<THREE.Vector4>;
  uCaustic: U<THREE.Vector2>;
  // sea
  uSurf: U<THREE.Vector2>;
  uDispRange: U<number>;
  // lake
  uTarnDeep: U<THREE.Vector3>;
  uTarnAbsorb: U<THREE.Vector3>;
  // river
  uPiers: U<Float32Array>;
  uMargin: U<number>;
  uPxAngle: U<number>;
  uMinPx: U<number>;
  uLiftPerM: U<number>;
  uPull: U<number>;
}

export interface WaterMaterial {
  kind: WaterKind;
  material: THREE.MeshStandardMaterial;
  uniforms: WaterMaterialUniforms;
}

function replaceOnce(src: string, find: string, repl: string): string {
  if (!src.includes(find)) throw new Error(`water material: shader chunk ${find} not found`);
  return src.replace(find, repl);
}

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

export function createWaterMaterial(kind: WaterKind, shared: SharedWaterUniforms, waveCount: number): WaterMaterial {
  const uniforms: WaterMaterialUniforms = {
    uWaveA: { value: new Float32Array(16 * 4) },
    uWaveB: { value: new Float32Array(16 * 4) },
    uWaveGain: { value: 1 },
    uDetailL1: { value: new THREE.Vector4(1, 0, 1 / 9.3, 0.07) },
    uDetailL2: { value: new THREE.Vector4(1, 0, 1 / 2.9, 0.063) },
    uDetailOff: { value: new THREE.Vector4() },
    uBaseVar: { value: 0.004 },
    uAbsorb: { value: v3(0.46, 0.085, 0.06) },
    uDeep: { value: v3(0.0035, 0.014, 0.026) },
    uBed: { value: v3(0.42, 0.37, 0.26) },
    uWhitecap: { value: new THREE.Vector4(0.36, 0.5, 1, 1) },
    uCaustic: { value: new THREE.Vector2(0.6, 0) },
    uSurf: { value: new THREE.Vector2(60, 7.5) },
    uDispRange: { value: 1500 },
    uTarnDeep: { value: v3(0.0018, 0.005, 0.008) },
    uTarnAbsorb: { value: v3(0.75, 0.28, 0.24) },
    uPiers: { value: new Float32Array(16) },
    uMargin: { value: 3 },
    uPxAngle: { value: 0.001 },
    uMinPx: { value: 1.4 },
    uLiftPerM: { value: 0.0012 },
    uPull: { value: 0.006 },
  };
  if (kind === 'lake') {
    uniforms.uAbsorb.value.set(0.55, 0.16, 0.2);
    uniforms.uDeep.value.set(0.004, 0.012, 0.012);
    uniforms.uBed.value.set(0.16, 0.14, 0.1);
    uniforms.uWhitecap.value.set(9, 10, 0, 1);
    uniforms.uDetailL1.value.set(1, 0, 1 / 4.1, 0.05);
    uniforms.uDetailL2.value.set(1, 0, 1 / 1.3, 0.045);
    uniforms.uBaseVar.value = 0.0025;
    uniforms.uCaustic.value.set(0.25, 0);
  } else if (kind === 'river') {
    uniforms.uAbsorb.value.set(0.9, 0.36, 0.55);
    uniforms.uDeep.value.set(0.009, 0.017, 0.012);
    uniforms.uBed.value.set(0.2, 0.17, 0.12);
    uniforms.uWhitecap.value.set(9, 10, 0, 0);
    uniforms.uDetailL1.value.set(1, 0, 1 / 3.4, 0.06);
    uniforms.uDetailL2.value.set(0.94, 0.34, 1 / 1.25, 0.05);
    uniforms.uBaseVar.value = 0.003;
    uniforms.uCaustic.value.set(0, 0);
  }
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.1,
    metalness: 0,
    transparent: true,
    depthWrite: true,
    fog: true,
  });
  material.name = `water-${kind}`;
  material.defines = { [`WATER_${kind.toUpperCase()}`]: '', WAVE_N: String(Math.max(1, Math.min(16, waveCount))) };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared, uniforms);
    let v = shader.vertexShader;
    v = replaceOnce(v, '#include <common>', `#include <common>\n${WATER_VERTEX_PARS}`);
    v = replaceOnce(v, '#include <begin_vertex>', `#include <begin_vertex>\n${WATER_BEGIN_VERTEX}`);
    v = replaceOnce(v, '#include <project_vertex>', `#include <project_vertex>\n${WATER_PROJECT_VERTEX}`);
    v = replaceOnce(v, '#include <worldpos_vertex>', `#include <worldpos_vertex>\n${WATER_WORLDPOS_VERTEX}`);
    shader.vertexShader = v;
    let f = shader.fragmentShader;
    f = replaceOnce(f, '#include <common>', `#include <common>\n${WATER_FRAGMENT_PARS}`);
    f = replaceOnce(f, '#include <map_fragment>', WATER_SURFACE_FRAGMENT);
    f = replaceOnce(f, '#include <roughnessmap_fragment>', WATER_ROUGHNESS_FRAGMENT);
    f = replaceOnce(f, '#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${WATER_NORMAL_FRAGMENT}`);
    f = replaceOnce(f, '#include <opaque_fragment>', WATER_OPAQUE_FRAGMENT);
    shader.fragmentShader = f;
  };
  material.customProgramCacheKey = () => `water2-${kind}`;
  return { kind, material, uniforms };
}
