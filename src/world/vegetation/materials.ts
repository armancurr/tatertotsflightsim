/**
 * Tree materials: three.js MeshStandardMaterials extended with
 * onBeforeCompile, so the scene's lights, shadows, sky environment and the
 * global atmospheric fog override (ShaderChunk fog_*) all apply unchanged.
 *
 * NEAR (instanced leaf-card meshes): alpha-tested foliage atlas with
 * alpha-to-coverage (MSAA-soft edges), wind sway + leaf flutter in the vertex
 * shader, bent foliage normals that are NOT flipped on back faces (crowns
 * shade as volumes), per-fragment leaf-clump noise, translucency (sunlit
 * leaves glow when back-lit — computed inside three's per-light loop so it
 * uses the real sun colour and its shadow), and a dithered LOD cross-fade:
 * fragments are kept where IGN(pixel) < meshWeight(d). Instances fully past
 * the mesh range collapse to a point (no fragments).
 *
 * IMPOSTOR (one draw per chunk, all species): camera-facing, world-up-aligned
 * billboards reading a baked atlas (6 view elevations × 7 species) with an
 * albedo and a tangent-space normal texture (+ leaf mask in its alpha), so
 * they are lit — and back-lit — like the meshes. They keep the complementary
 * dither (IGN ≥ meshWeight), thin out with distance by stratified rank (the
 * survivors grow to keep the canopy closed) and fade to nothing toward the
 * view distance. Formulas mirror lod.ts.
 */
import * as THREE from 'three';
import type { LodParams } from './lod';
import { SPECIES_R0 } from './species';
import type { FoliageTextures } from './textures';
import { SPECIES_COUNT } from './placement';

export interface VegUniforms {
  uVegTime: THREE.IUniform<number>;
  uVegWind: THREE.IUniform<THREE.Vector2>;
  uVegMeshDist: THREE.IUniform<number>;
  uVegLodBand: THREE.IUniform<number>;
  uVegViewDist: THREE.IUniform<number>;
  uVegFarBand: THREE.IUniform<number>;
  uVegThinStart: THREE.IUniform<number>;
  uVegThinExp: THREE.IUniform<number>;
  uVegCap: THREE.IUniform<number>;
  uVegCompMax: THREE.IUniform<number>;
  uVegTransl: THREE.IUniform<number>;
  uVegSunDir: THREE.IUniform<THREE.Vector3>;
  uVegSunColor: THREE.IUniform<THREE.Color>;
}

export function createVegUniforms(lod: LodParams, translucency = 1): VegUniforms {
  return {
    uVegTime: { value: 0 },
    uVegWind: { value: new THREE.Vector2(1, 0.3) },
    uVegMeshDist: { value: lod.meshDistance },
    uVegLodBand: { value: lod.lodFadeBand },
    uVegViewDist: { value: lod.viewDistance },
    uVegFarBand: { value: lod.farFadeBand },
    uVegThinStart: { value: lod.thinStartDistance },
    uVegThinExp: { value: lod.thinExponent },
    uVegCap: { value: 1 },
    uVegCompMax: { value: lod.thinCompensationMax },
    uVegTransl: { value: translucency },
    uVegSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uVegSunColor: { value: new THREE.Color(1, 1, 1) },
  };
}

/** Height of the crown centre used for LOD distances, as a fraction of tree height. */
export const CROWN_CENTER = 0.47;

// ─── per-tree variety (JS rules + the GLSL generated from the same constants) ──────────────

/** Share of trees (all species but shrubs) that are dead: grey-brown (spruce: rust), sparse crowns. */
export const DEAD_FRACTION = 0.005;
/** Tint values above this: deciduous trees already turning (yellow → orange-brown), ~2 %. */
export const TURNING_T = 0.98;
/** Alpha multiplier (leaf coverage) of a dead tree's crown. */
const DEAD_DENSITY = 0.55;
/** Share of a dead tree's foliage clumps that are gone (bare limbs). */
const DEAD_DROP = 0.7;

/**
 * Per-species variation of the foliage clumps (species.ts `clump` attribute), per tree: a clump is
 * dropped with probability `drop` (a gap, the branch behind it shows) or shrunk toward its centre
 * by a factor in [minScale, 1]. Spruce clumps are branch segments (varying branch lengths); its
 * clump 0 (the dark inner cone) always stays.
 */
export const CLUMP_VARIATION = [
  { drop: 0.05, minScale: 0.72 }, // spruce
  { drop: 0.1, minScale: 0.7 }, // pine
  { drop: 0.08, minScale: 0.7 }, // broadleaf
  { drop: 0.08, minScale: 0.65 }, // birch
  { drop: 0.04, minScale: 0.75 }, // poplar
  { drop: 0.06, minScale: 0.7 }, // willow
  { drop: 0.1, minScale: 0.6 }, // bush
] as const;

const fract = (v: number): number => v - Math.floor(v);

export function isDeadTree(t: number, species: number): boolean {
  return species !== 6 && t < DEAD_FRACTION;
}

/** Leaf-coverage multiplier of a tree's crown (1, or sparse for dead trees). */
export function crownDensity(t: number, species: number): number {
  return isDeadTree(t, species) ? DEAD_DENSITY : 1;
}

/** 32-bit PCG hash (identical to `vegPcg` in GLSL). */
function pcg(v: number): number {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
}

/** Scale of foliage clump `id` of the tree with tint value t (0 = dropped). Mirrors `vegClumpScale`. */
export function clumpScale(t: number, species: number, id: number): number {
  if (species === 0 && id === 0) return 1;
  const tree = Math.floor(Math.fround(t) * 16777216) >>> 0;
  const h = pcg((tree ^ Math.imul(id + 1, 0x9e3779b9)) >>> 0);
  const u = h / 4294967296;
  const v = pcg(h) / 4294967296;
  const cv = CLUMP_VARIATION[species] ?? CLUMP_VARIATION[2];
  if (u < (isDeadTree(t, species) ? DEAD_DROP : cv.drop)) return 0;
  return cv.minScale + (1 - cv.minScale) * v;
}

/**
 * Per-instance tint (multiplier on the foliage colour) from the tint hash t:
 * brightness ±26 %, warm yellow-green ↔ cool blue-green (half as much for
 * conifers), saturation 0.8–1.15 (olive to vivid), willows silvered; deciduous
 * trees above `TURNING_T` turning (olive-yellow → orange-brown); dead trees
 * grey-brown (dead spruce/pine mostly rust-red). Orchard tints (0.3–0.5) stay
 * plain green. `tintGlsl` is the identical GLSL.
 */
export function tintColor(t: number, species: number, out: THREE.Color): THREE.Color {
  const f1 = fract(t * 7.31);
  const f2 = fract(t * 13.17 + 0.37);
  const conifer = species <= 1;
  const b = 0.74 + 0.52 * f1;
  const w = (t - 0.5) * (conifer ? 0.5 : 1);
  let r = (1 + 0.26 * w) * b;
  let g = (1 + 0.06 * w) * b;
  let bl = (1 - 0.42 * w) * b;
  const sat = 0.8 + 0.35 * f2;
  const l = 0.3 * r + 0.59 * g + 0.11 * bl;
  r = l + (r - l) * sat;
  g = l + (g - l) * sat;
  bl = l + (bl - l) * sat;
  if (species === 5) {
    r *= 1.05;
    bl *= 1.45;
  }
  if (t > TURNING_T && species >= 2 && species <= 4) {
    const k = (t - TURNING_T) / (1 - TURNING_T);
    r *= 1.55 + 0.75 * k;
    g *= 1.08 - 0.22 * k;
    bl *= 0.5 - 0.15 * k;
  }
  if (isDeadTree(t, species)) {
    const k = t / DEAD_FRACTION;
    const d = 0.85 + 0.3 * f1;
    if (conifer && k < 0.6) {
      r = 1.5 * d;
      g = 0.62 * d;
      bl = 0.4 * d;
    } else {
      r = 1.05 * d;
      g = 0.66 * d;
      bl = 0.64 * d;
    }
  }
  out.setRGB(r, g, bl);
  return out;
}

const f = (v: number): string => (Number.isInteger(v) ? `${v}.0` : `${v}`);
const tintGlsl = /* glsl */ `
bool vegDead(float t, float sp) { return sp < 5.5 && t < ${f(DEAD_FRACTION)}; }
float vegCrownDensity(float t, float sp) { return vegDead(t, sp) ? ${f(DEAD_DENSITY)} : 1.0; }
vec3 vegTint(float t, float sp) {
  float f1 = fract(t * 7.31);
  float f2 = fract(t * 13.17 + 0.37);
  bool conifer = sp < 1.5;
  float b = 0.74 + 0.52 * f1;
  float w = (t - 0.5) * (conifer ? 0.5 : 1.0);
  vec3 c = vec3(1.0 + 0.26 * w, 1.0 + 0.06 * w, 1.0 - 0.42 * w) * b;
  float l = dot(c, vec3(0.3, 0.59, 0.11));
  c = vec3(l) + (c - vec3(l)) * (0.8 + 0.35 * f2);
  if (abs(sp - 5.0) < 0.5) c *= vec3(1.05, 1.0, 1.45);
  if (t > ${f(TURNING_T)} && sp > 1.5 && sp < 4.5) {
    float k = (t - ${f(TURNING_T)}) / ${f(1 - TURNING_T)};
    c *= vec3(1.55 + 0.75 * k, 1.08 - 0.22 * k, 0.5 - 0.15 * k);
  }
  if (vegDead(t, sp)) {
    float k = t / ${f(DEAD_FRACTION)};
    float d = 0.85 + 0.3 * f1;
    c = (conifer && k < 0.6 ? vec3(1.5, 0.62, 0.4) : vec3(1.05, 0.66, 0.64)) * d;
  }
  return c;
}
`;

const clumpGlsl = /* glsl */ `
uint vegPcg(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
const vec2 VEG_CLUMP_VAR[${CLUMP_VARIATION.length}] = vec2[](${CLUMP_VARIATION.map((c) => `vec2(${f(c.drop)}, ${f(c.minScale)})`).join(', ')});
float vegClumpScale(float t, float sp, float id) {
  int s = int(sp + 0.5);
  if (s == 0 && id < 0.5) return 1.0;
  uint tree = uint(floor(t * 16777216.0));
  uint h = vegPcg(tree ^ (uint(id + 1.5) * 0x9e3779b9u));
  float u = float(h) / 4294967296.0;
  float v = float(vegPcg(h)) / 4294967296.0;
  vec2 cv = VEG_CLUMP_VAR[clamp(s, 0, ${CLUMP_VARIATION.length - 1})];
  if (u < (vegDead(t, sp) ? ${f(DEAD_DROP)} : cv.x)) return 0.0;
  return cv.y + (1.0 - cv.y) * v;
}
`;

// ─── translucency ──────────────────────────────────────────────────────────────────────────

/**
 * Leaf translucency, energy-normalised like three's Lambert term (1/π): diffuse
 * transmission on the unlit side (`back`) plus a forward-scatter lobe toward
 * the viewer (`fwd`), both strongest at the crown's rim where the light path
 * through the foliage is short (`rimMin` in the middle of a crown) — back-lit
 * trees get a glowing edge and a dark body, never a neon glow.
 */
export const TRANSLUCENCY = { back: 0.55, fwd: 0.6, fwdPow: 6, rimMin: 0.2, tint: [1.15, 1.25, 0.6] as const };

/** Scalar translucency factor (× light colour × leaf albedo × tint). L toward the light, V toward the camera, N the bent normal. */
export function translucency(L: THREE.Vector3, V: THREE.Vector3, N: THREE.Vector3): number {
  const back = Math.max(0, -N.dot(L));
  const rim = 1 - Math.abs(N.dot(V));
  const thin = TRANSLUCENCY.rimMin + (1 - TRANSLUCENCY.rimMin) * rim * rim;
  const fwd = Math.pow(Math.max(0, -V.dot(L)), TRANSLUCENCY.fwdPow);
  return ((TRANSLUCENCY.back * back + TRANSLUCENCY.fwd * fwd) * thin) / Math.PI;
}

/**
 * Brightness calibration of the impostors per species (× the baked albedo): the small atlas tiles
 * lose the thin lit needle tips and leaf edges, so the billboards come out a little darker than
 * the meshes they replace. Measured by the trees preview `compare=1` (tests/e2e/trees.e2e.test.ts).
 */
export const IMPOSTOR_GAIN = [1.14, 1.08, 1.0, 1.05, 1.04, 1.02, 1.0] as const;

/** Specular F90 of leaves (three's default 1.0 turns grazing leaf cards white against the sun). */
const LEAF_F90 = 0.3;

const commonGlsl = /* glsl */ `
float vegIGN(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
`;

const noiseGlsl = /* glsl */ `
float vegHash3(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vegNoise3(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(vegHash3(i), vegHash3(i + vec3(1, 0, 0)), f.x), mix(vegHash3(i + vec3(0, 1, 0)), vegHash3(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(vegHash3(i + vec3(0, 0, 1)), vegHash3(i + vec3(1, 0, 1)), f.x), mix(vegHash3(i + vec3(0, 1, 1)), vegHash3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
`;

const T = TRANSLUCENCY;
const translGlsl = /* glsl */ `
vec3 vegTranslucency(vec3 L, vec3 V, vec3 N, vec3 lightColor, vec3 albedo, float amount) {
  float back = max(-dot(N, L), 0.0);
  float rim = 1.0 - abs(dot(N, V));
  float thin = ${f(T.rimMin)} + ${f(1 - T.rimMin)} * rim * rim;
  float fwd = pow(max(-dot(V, L), 0.0), ${f(T.fwdPow)});
  return lightColor * albedo * vec3(${T.tint.map(f).join(', ')}) * ((${f(T.back)} * back + ${f(T.fwd)} * fwd) * thin * RECIPROCAL_PI * amount);
}
`;

const DIR_LOOP_CALL = 'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';

/** three's lights_fragment_begin with our translucency added after every direct light. */
function withTranslucency(amount: string): string {
  const src = THREE.ShaderChunk.lights_fragment_begin;
  if (!src.includes(DIR_LOOP_CALL)) return '#include <lights_fragment_begin>';
  return src.split(DIR_LOOP_CALL).join(
    `${DIR_LOOP_CALL}
    reflectedLight.directDiffuse += vegTranslucency(directLight.direction, geometryViewDir, geometryNormal, directLight.color, material.diffuseColor.rgb, ${amount});`,
  );
}

function uniformDecls(u: VegUniforms): string {
  return Object.keys(u)
    .map((k) => {
      const v = (u as unknown as Record<string, THREE.IUniform>)[k].value;
      const t = v instanceof THREE.Vector2 ? 'vec2' : v instanceof THREE.Vector3 || v instanceof THREE.Color ? 'vec3' : 'float';
      return `uniform ${t} ${k};`;
    })
    .join('\n');
}

/** Wind sway (whole tree, ∝ height²) + flutter (leaves only). Needs `transformed`, `vegBase`, `vegLeaf`. */
const windGlsl = /* glsl */ `
  float vegPh = dot(vegBase.xz, vec2(0.0131, 0.0173));
  float vegHf = max(transformed.y, 0.0);
  float vegGust = sin(uVegTime * 1.13 + vegPh) * 0.65 + sin(uVegTime * 2.37 + vegPh * 1.9) * 0.35;
  transformed.xz += uVegWind * vegGust * vegHf * vegHf * 0.03;
  transformed += objectNormal * sin(uVegTime * 7.3 + dot(position, vec3(17.0, 11.0, 13.0)) + vegPh * 3.0) * 0.01 * vegHf * vegLeaf;
`;

const vegBaseGlsl = /* glsl */ `
#ifdef USE_INSTANCING
  vec3 vegBase = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float vegH = length(instanceMatrix[1].xyz);
#else
  vec3 vegBase = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float vegH = 1.0;
#endif
  float vegD = distance(cameraPosition, vegBase + vec3(0.0, ${CROWN_CENTER} * vegH, 0.0));
`;

/**
 * Per-instance data of the near meshes: `instanceColor` carries (tint hash, species, 0), not a
 * colour — the tint is computed in the shader (the same `vegTint` as the impostors), and the tint
 * hash seeds the per-tree clump variation. Needs `transformed` and `vegBase`; defines vegT, vegSp.
 */
const instanceGlsl = /* glsl */ `
#ifdef USE_INSTANCING_COLOR
  float vegT = instanceColor.x;
  float vegSp = instanceColor.y;
#else
  float vegT = 0.5;
  float vegSp = 2.0;
#endif
  // per-tree crown: shrink or drop each foliage clump about its centre (bare branches show in the gaps)
  if (clump.w >= 0.0) transformed = clump.xyz + (transformed - clump.xyz) * vegClumpScale(vegT, vegSp, clump.w);
`;

/** Material for the near instanced meshes (all species share it). */
export function createNearMaterial(u: VegUniforms, tex: FoliageTextures): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    map: tex.map,
    vertexColors: true,
    roughness: 0.82,
    metalness: 0,
    alphaTest: 0.45,
    alphaToCoverage: true,
    side: THREE.DoubleSide,
    fog: true,
  });
  m.name = 'vegetation-near';
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
${uniformDecls(u)}
attribute float leaf;
attribute vec4 clump;
varying float vVegFade;
varying float vVegLeaf;
varying float vVegDensity;
varying vec3 vVegPos;
${tintGlsl}
${clumpGlsl}`,
      )
      .replace(
        '#include <color_vertex>',
        `vColor = vec4(1.0);
#ifdef USE_COLOR
  vColor.rgb *= color;
#endif
#ifdef USE_INSTANCING_COLOR
  vColor.rgb *= vegTint(instanceColor.x, instanceColor.y);
  vVegDensity = vegCrownDensity(instanceColor.x, instanceColor.y);
#else
  vVegDensity = 1.0;
#endif`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
${vegBaseGlsl}
${instanceGlsl}
  vVegFade = 1.0 - smoothstep(uVegMeshDist - uVegLodBand, uVegMeshDist, vegD);
  float vegLeaf = leaf;
  vVegLeaf = leaf;
${windGlsl}
  if (vVegFade <= 0.0) transformed = vec3(0.0);
#ifdef USE_INSTANCING
  vVegPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
#else
  vVegPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
#endif`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uVegTransl;
varying float vVegFade;
varying float vVegLeaf;
varying float vVegDensity;
varying vec3 vVegPos;
${commonGlsl}
${noiseGlsl}
${translGlsl}`,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
  if (vVegFade < 0.999 && vegIGN(gl_FragCoord.xy) >= vVegFade) discard;`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
  diffuseColor.a *= mix(1.0, vVegDensity, vVegLeaf);
  // keep leaf coverage as the texture minifies (alpha-tested foliage otherwise thins out)
  vec2 vegDuv = fwidth(vMapUv) * 1024.0;
  diffuseColor.a = min(1.0, diffuseColor.a * (1.0 + 0.35 * max(log2(max(vegDuv.x, vegDuv.y)), 0.0)));`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
  float vegN = vegNoise3(vVegPos * 0.9) * 0.6 + vegNoise3(vVegPos * 2.7) * 0.4;
  diffuseColor.rgb *= mix(1.0, 0.8 + 0.4 * vegN, vVegLeaf);`,
      )
      .replace(
        '#include <normal_fragment_begin>',
        // leaves: never flip the bent normal on back faces (volumetric crown shading)
        `#include <normal_fragment_begin>
#ifdef DOUBLE_SIDED
  if (vVegLeaf > 0.5) { normal = normalize(vNormal); nonPerturbedNormal = normal; }
#endif`,
      )
      .replace(
        '#include <lights_physical_fragment>',
        `#include <lights_physical_fragment>
  material.specularF90 = mix(material.specularF90, ${f(LEAF_F90)}, vVegLeaf);`,
      )
      .replace('#include <lights_fragment_begin>', withTranslucency('uVegTransl * vVegLeaf'));
  };
  m.customProgramCacheKey = () => 'vegetation-near-v3';
  return m;
}

/** Shadow-map depth material for the near meshes: same wind, clumps, alpha test and LOD collapse. */
export function createNearDepthMaterial(u: VegUniforms, tex: FoliageTextures): THREE.MeshDepthMaterial {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: tex.map, alphaTest: 0.45, side: THREE.DoubleSide });
  m.name = 'vegetation-near-depth';
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
${uniformDecls(u)}
attribute float leaf;
attribute vec4 clump;
varying float vVegDensity;
${tintGlsl}
${clumpGlsl}`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
  vec3 objectNormal = normal;
${vegBaseGlsl}
${instanceGlsl}
  vVegDensity = leaf > 0.5 ? vegCrownDensity(vegT, vegSp) : 1.0;
  float vegLeaf = leaf;
${windGlsl}
  if (vegD >= uVegMeshDist) transformed = vec3(0.0);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying float vVegDensity;`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
  diffuseColor.a *= vVegDensity;`,
      );
  };
  m.customProgramCacheKey = () => 'vegetation-near-depth-v3';
  return m;
}

export interface ImpostorAtlasTextures {
  albedo: THREE.Texture;
  /** Tangent-space normal (rgb) + leaf mask (a). */
  normal: THREE.Texture;
  /** Tiles per row (view elevations) and rows (species). */
  cols: number;
  rows: number;
  /** Atlas size in pixels. */
  size: THREE.Vector2;
}

/** Number of view elevations baked (columns) and the step between them (radians): 0°, 18°, … 90°. */
export const ELEVATION_COLS = 6;
export const ELEVATION_STEP = Math.PI / 2 / (ELEVATION_COLS - 1);
/** Frustum margin of the baked tiles (quad half-extent / tree half-extent). */
export const TILE_MARGIN = 1.12;
/** Vertical half extent of a tree (height 1, crown radius r) seen at elevation e, around the crown centre. */
export const halfHeightAt = (h: number, r: number, e: number): number => 0.53 * h * Math.cos(e) + r * Math.sin(e);

/** Material for impostor chunks (one InstancedBufferGeometry per chunk). */
export function createImpostorMaterial(u: VegUniforms, atlas: ImpostorAtlasTextures): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    map: atlas.albedo,
    normalMap: atlas.normal,
    roughness: 0.85,
    metalness: 0,
    alphaTest: 0.5,
    alphaToCoverage: true,
    fog: true,
    side: THREE.FrontSide,
  });
  m.name = 'vegetation-impostor';
  const grid = { value: new THREE.Vector2(atlas.cols, atlas.rows) };
  const atlasSize = { value: atlas.size };
  const r0 = SPECIES_R0.slice(0, SPECIES_COUNT);
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u, { uVegGrid: grid, uVegAtlasSize: atlasSize });
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
${uniformDecls(u)}
uniform vec2 uVegGrid;
attribute vec4 iA;
attribute vec4 iB;
varying vec2 vImpUv0;
varying vec2 vImpUv1;
varying vec4 vImpTile;
varying float vImpF;
varying float vImpFade;
varying vec3 vImpTint;
varying float vImpDensity;
const float VEG_IMP_GAIN[${IMPOSTOR_GAIN.length}] = float[](${IMPOSTOR_GAIN.map(f).join(', ')});
${tintGlsl}`,
      )
      .replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
  float impH = iA.w;
  float impR = iB.x;
  float impSp = floor(iB.y);
  float impRot = fract(iB.y);
  vec3 impCtr = iA.xyz + vec3(0.0, ${CROWN_CENTER} * impH, 0.0);
  vec3 impToCam = cameraPosition - impCtr;
  float impD = length(impToCam);
  vec3 impV = impToCam / max(impD, 1e-3);
  float impMeshW = 1.0 - smoothstep(uVegMeshDist - uVegLodBand, uVegMeshDist, impD);
  float impThin = impD <= uVegThinStart ? 1.0 : pow(uVegThinStart / impD, uVegThinExp);
  float impKeep = uVegCap * impThin * (1.0 - smoothstep(uVegViewDist - uVegFarBand, uVegViewDist, impD));
  float impAlive = clamp((impKeep - iB.w) / max(0.12 * impKeep, 1e-4), 0.0, 1.0);
  float impSz = impAlive * min(uVegCompMax, inversesqrt(impThin));
  bool impDead = impSz <= 0.0 || impMeshW >= 1.0 || impD >= uVegViewDist;
  vImpFade = impMeshW;
  vec3 impRight = cross(vec3(0.0, 1.0, 0.0), impV);
  float impRl = length(impRight);
  impRight = impRl > 1e-4 ? impRight / impRl : vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 impUp = cross(impV, impRight);
  float impSinE = clamp(impV.y, 0.0, 1.0);
  float impCosE = sqrt(max(0.0, 1.0 - impSinE * impSinE));
  float impE = asin(impSinE) / ${ELEVATION_STEP.toFixed(7)};
  float impK0 = floor(min(impE, uVegGrid.x - 1.001));
  vImpF = clamp(impE - impK0, 0.0, 1.0);
  float impHhE = 0.53 * impH * impCosE + impR * impSinE;
  float impHw = ${TILE_MARGIN.toFixed(4)} * impR * impSz;
  float impHh = ${TILE_MARGIN.toFixed(4)} * impHhE * impSz;
  vec3 impPos = impDead ? impCtr : impCtr + impRight * (position.x * impHw) + impUp * (position.y * impHh);
  float impFlip = impRot > 0.5 ? -1.0 : 1.0;
  float impE0 = impK0 * ${ELEVATION_STEP.toFixed(7)};
  float impE1 = impE0 + ${ELEVATION_STEP.toFixed(7)};
  float impHh0 = 0.53 * impH * cos(impE0) + impR * sin(impE0);
  float impHh1 = 0.53 * impH * cos(impE1) + impR * sin(impE1);
  vec2 impQ0 = vec2(position.x * impFlip, position.y * impHhE / impHh0);
  vec2 impQ1 = vec2(position.x * impFlip, position.y * impHhE / impHh1);
  vImpTile = vec4(impK0, impSp, impK0 + 1.0, impSp);
  vImpUv0 = (vImpTile.xy + 0.5 + 0.5 * impQ0) / uVegGrid;
  vImpUv1 = (vImpTile.zw + 0.5 + 0.5 * impQ1) / uVegGrid;
  vImpTint = vegTint(iB.z, impSp) * VEG_IMP_GAIN[int(clamp(impSp, 0.0, ${SPECIES_COUNT - 1}.0))];
  vImpDensity = vegCrownDensity(iB.z, impSp);
#ifdef USE_MAP
  vMapUv = vImpUv0;
#endif
#ifdef USE_NORMALMAP
  vNormalMapUv = vImpUv0;
#endif`,
      )
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = impV;')
      .replace('#include <begin_vertex>', 'vec3 transformed = impPos;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec2 uVegGrid;
uniform vec2 uVegAtlasSize;
uniform float uVegTransl;
varying vec2 vImpUv0;
varying vec2 vImpUv1;
varying vec4 vImpTile;
varying float vImpF;
varying float vImpFade;
varying vec3 vImpTint;
varying float vImpDensity;
float vImpLeaf;
${commonGlsl}
${translGlsl}
vec2 impClamp(vec2 uv, vec2 tile) {
  vec2 lo = (tile + 0.004) / uVegGrid;
  vec2 hi = (tile + 0.996) / uVegGrid;
  return clamp(uv, lo, hi);
}`,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
  if (vImpFade > 0.001 && vegIGN(gl_FragCoord.xy) < vImpFade) discard;
  vec2 impUv0 = impClamp(vImpUv0, vImpTile.xy);
  vec2 impUv1 = impClamp(vImpUv1, vImpTile.zw);`,
      )
      .replace(
        '#include <map_fragment>',
        `#ifdef USE_MAP
  vec4 sampledDiffuseColor = mix(texture2D(map, impUv0), texture2D(map, impUv1), vImpF);
  diffuseColor *= sampledDiffuseColor;
  diffuseColor.rgb *= vImpTint;
  diffuseColor.a *= vImpDensity;
  vec2 impDx = dFdx(vImpUv0 * uVegAtlasSize);
  vec2 impDy = dFdy(vImpUv0 * uVegAtlasSize);
  float impLod = 0.5 * log2(max(max(dot(impDx, impDx), dot(impDy, impDy)), 1e-8));
  diffuseColor.a = min(1.0, diffuseColor.a * (1.0 + 0.3 * max(impLod, 0.0)));
#endif`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `vec4 impNrm = mix(texture2D(normalMap, impUv0), texture2D(normalMap, impUv1), vImpF);
  vImpLeaf = impNrm.a;
` + THREE.ShaderChunk.normal_fragment_maps.replace('texture2D( normalMap, vNormalMapUv )', 'impNrm'),
      )
      .replace(
        '#include <lights_physical_fragment>',
        `#include <lights_physical_fragment>
  material.specularF90 = mix(material.specularF90, ${f(LEAF_F90)}, vImpLeaf);`,
      )
      .replace('#include <lights_fragment_begin>', withTranslucency('uVegTransl * vImpLeaf'));
  };
  m.customProgramCacheKey = () => `vegetation-impostor-v3-${r0.length}`;
  return m;
}
