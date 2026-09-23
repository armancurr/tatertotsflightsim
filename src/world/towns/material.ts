/**
 * Building materials: MeshStandardMaterial (PBR lights, shadows, sky
 * environment reflections, the global aerial-perspective fog) extended with
 * the parametric vertex transform and the procedural facade/roof shader
 * (shaders.ts), plus the matching depth material so shadows follow the
 * vertex-shader geometry.
 */
import * as THREE from 'three';
import {
  BLD_VERT_PARS,
  BLD_VERT_NORMAL,
  BLD_VERT_BEGIN_COLOR,
  BLD_VERT_BEGIN_DEPTH,
  BLD_FRAG_PARS,
  BLD_FRAG_SHADE,
  BLD_FRAG_COLOR,
  BLD_FRAG_DITHER,
  BLD_FRAG_DITHER_NEAR,
} from './shaders';

export interface BuildingUniforms {
  /** 0 by day … 1 at night: the fraction of windows lit scales with it. */
  uBldNight: { value: number };
  /** Per chunk: 255 where the near LOD draws it (the mid LOD skips it). */
  uBldChunkNear: { value: THREE.Texture };
  /** Mid LOD: (minAngularSize, midDistance, farDistance, tallSize). */
  uBldLod: { value: THREE.Vector4 };
  /** The view camera's world position (the shadow pass needs the real camera for the tree LOD). */
  uBldCam: { value: THREE.Vector3 };
  /** Tree LOD cross-fade: (start, end) distances, m. */
  uBldTree: { value: THREE.Vector2 };
}

/** Shader anchors every material edit relies on (tests check they exist in three's sources). */
export const VERTEX_ANCHORS = ['#include <common>', '#include <beginnormal_vertex>', '#include <begin_vertex>'];
export const FRAGMENT_ANCHORS = [
  '#include <common>',
  '#include <clipping_planes_fragment>',
  '#include <color_fragment>',
  '#include <roughnessmap_fragment>',
  '#include <metalnessmap_fragment>',
  '#include <emissivemap_fragment>',
  '#include <aomap_fragment>',
  '#include <normal_fragment_maps>',
];
export const DEPTH_ANCHORS = ['#include <common>', '#include <begin_vertex>'];

const must = (src: string, anchor: string, by: string): string => {
  if (!src.includes(anchor)) throw new Error(`buildings: shader anchor missing: ${anchor}`);
  return src.replace(anchor, by);
};

/** Edits a standard-material shader in place (exported for tests). */
export function patchStandardShader(shader: { vertexShader: string; fragmentShader: string; uniforms: Record<string, THREE.IUniform> }, u: BuildingUniforms, mid: boolean): void {
  Object.assign(shader.uniforms, u);
  let vs = shader.vertexShader;
  vs = must(vs, '#include <common>', `#include <common>\n${BLD_VERT_PARS}`);
  vs = must(vs, '#include <beginnormal_vertex>', BLD_VERT_NORMAL);
  vs = must(vs, '#include <begin_vertex>', BLD_VERT_BEGIN_COLOR);
  let fs = shader.fragmentShader;
  fs = must(fs, '#include <common>', `#include <common>\n${BLD_FRAG_PARS}\n${BLD_FRAG_SHADE}`);
  fs = must(fs, '#include <clipping_planes_fragment>', mid ? BLD_FRAG_DITHER : BLD_FRAG_DITHER_NEAR);
  fs = must(fs, '#include <color_fragment>', BLD_FRAG_COLOR);
  // glass panels are never perfectly flat: a per-panel tilt breaks up the sky reflection
  fs = must(fs, '#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n  normal = normalize(normal + vec3(bldJit * 0.012, bldJit * 0.008, 0.0));');
  fs = must(fs, '#include <roughnessmap_fragment>', 'float roughnessFactor = bldRough;');
  fs = must(fs, '#include <metalnessmap_fragment>', 'float metalnessFactor = bldMetal;');
  fs = must(fs, '#include <emissivemap_fragment>', 'totalEmissiveRadiance = bldEmit;');
  fs = must(
    fs,
    '#include <aomap_fragment>',
    `reflectedLight.indirectDiffuse *= bldAO;
  reflectedLight.indirectSpecular *= mix(1.0, bldAO, 0.6);
  reflectedLight.directDiffuse *= mix(1.0, bldAO, 0.3);`,
  );
  shader.vertexShader = vs;
  shader.fragmentShader = fs;
}

export function patchDepthShader(shader: { vertexShader: string; uniforms: Record<string, THREE.IUniform> }, u: BuildingUniforms): void {
  Object.assign(shader.uniforms, u);
  let vs = shader.vertexShader;
  vs = must(vs, '#include <common>', `#include <common>\n${BLD_VERT_PARS}`);
  vs = must(vs, '#include <begin_vertex>', BLD_VERT_BEGIN_DEPTH);
  shader.vertexShader = vs;
}

export function createBuildingMaterial(u: BuildingUniforms, mid: boolean): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, fog: true });
  m.name = mid ? 'buildings-mid' : 'buildings-near';
  m.defines = mid ? { BLD_COLOR: '', BLD_MID: '' } : { BLD_COLOR: '' };
  m.onBeforeCompile = (shader) => patchStandardShader(shader, u, mid);
  m.customProgramCacheKey = () => (mid ? 'buildings-mid-v2' : 'buildings-near-v2');
  return m;
}

export function createBuildingDepthMaterial(u: BuildingUniforms): THREE.MeshDepthMaterial {
  const m = new THREE.MeshDepthMaterial();
  m.name = 'buildings-depth';
  m.onBeforeCompile = (shader) => patchDepthShader(shader, u);
  m.customProgramCacheKey = () => 'buildings-depth-v2';
  return m;
}

export function createBuildingUniforms(chunkCount: number): BuildingUniforms {
  const rows = Math.max(1, Math.ceil(chunkCount / 256));
  const tex = new THREE.DataTexture(new Uint8Array(256 * rows), 256, rows, THREE.RedFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return { uBldNight: { value: 0 }, uBldChunkNear: { value: tex }, uBldLod: { value: new THREE.Vector4() }, uBldCam: { value: new THREE.Vector3() }, uBldTree: { value: new THREE.Vector2(600, 800) } };
}
