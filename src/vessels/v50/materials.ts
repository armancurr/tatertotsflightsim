/**
 * Princess V50 materials. Few materials = few draw calls: the hull skin is one white gel-coat whose
 * antifouling and dark boot-top stripe are painted in the shader by body height (crisp at any
 * mesh resolution, and they follow the model when it heels); the superstructure, decks and
 * mouldings share one vertex-coloured gloss GRP; teak soles share one planked material; small
 * parts (stainless, drives, cushions, helm) use the per-vertex colour/roughness/metalness parts
 * material of the aircraft (src/aircraft/materials.ts `tint`). After a crash the soot spreads over
 * the painted ones (`char`).
 */
import * as THREE from 'three';
import { addSoot, createPartsMaterial } from '../../aircraft/materials';

/** Waterline paint bands on the hull, body y (m): antifouling below `bootLo`, the stripe up to `bootHi`. */
export const HULL_BANDS = { bootLo: -0.55, bootHi: -0.35 } as const;
const ANTIFOUL = new THREE.Color(0x27313c);
const BOOT = new THREE.Color(0x121416);

export interface V50Textures {
  teak: THREE.Texture;
  screens: THREE.Texture;
  name: THREE.Texture;
}

export interface V50Materials {
  hull: THREE.MeshPhysicalMaterial;
  grp: THREE.MeshPhysicalMaterial;
  teak: THREE.MeshStandardMaterial;
  parts: THREE.MeshStandardMaterial;
  props: THREE.MeshStandardMaterial;
  interior: THREE.MeshStandardMaterial;
  glass: THREE.MeshPhysicalMaterial;
  darkGlass: THREE.MeshPhysicalMaterial;
  screens: THREE.MeshStandardMaterial;
  disc: THREE.MeshStandardMaterial;
  name: THREE.MeshStandardMaterial;
  nav: THREE.MeshBasicMaterial;
  glow: THREE.ShaderMaterial;
  char: { value: number };
  all: THREE.Material[];
}

/** Paint the antifouling and boot-top bands on a material by the body-frame height. */
function addWaterlineBands<T extends THREE.MeshStandardMaterial>(m: T): T {
  const prev = m.onBeforeCompile;
  const prevKey = m.customProgramCacheKey.bind(m);
  m.onBeforeCompile = (shader, renderer) => {
    prev.call(m, shader, renderer);
    shader.uniforms.uAntifoul = { value: ANTIFOUL };
    shader.uniforms.uBoot = { value: BOOT };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vHullY;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHullY = position.y;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vHullY;\nuniform vec3 uAntifoul;\nuniform vec3 uBoot;')
      // Before color_fragment, so the soot (added after it) still darkens the bands.
      .replace(
        '#include <color_fragment>',
        `float bandAw = fwidth(vHullY) * 0.75 + 1e-4;
        float isBoot = smoothstep(${HULL_BANDS.bootLo.toFixed(3)} - bandAw, ${HULL_BANDS.bootLo.toFixed(3)} + bandAw, vHullY) * (1.0 - smoothstep(${HULL_BANDS.bootHi.toFixed(3)} - bandAw, ${HULL_BANDS.bootHi.toFixed(3)} + bandAw, vHullY));
        float isFoul = 1.0 - smoothstep(${HULL_BANDS.bootLo.toFixed(3)} - bandAw, ${HULL_BANDS.bootLo.toFixed(3)} + bandAw, vHullY);
        diffuseColor.rgb = mix(diffuseColor.rgb, uBoot, isBoot);
        diffuseColor.rgb = mix(diffuseColor.rgb, uAntifoul, isFoul);
        #include <color_fragment>`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.72, isFoul);')
      .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n#ifdef USE_CLEARCOAT\nmaterial.clearcoat *= 1.0 - isFoul;\n#endif');
  };
  m.customProgramCacheKey = () => prevKey() + '|v50bands';
  return m;
}

/** Point-sprite glow for the nav lights (additive, drawn after the model). */
function glowMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'v50.glow',
    uniforms: { uHalfHeight: { value: 450 } },
    vertexShader: /* glsl */ `
      attribute vec3 glowColor;
      attribute vec3 aDir;
      attribute float size;
      attribute float intensity;
      uniform float uHalfHeight;
      varying vec3 vColor;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float facing = 1.0;
        if (dot(aDir, aDir) > 0.0) {
          vec3 d = normalize(normalMatrix * aDir);
          facing = smoothstep(-0.25, 0.35, dot(d, normalize(-mv.xyz)));
        }
        float k = intensity * facing;
        float px = size * projectionMatrix[1][1] * uHalfHeight / max(-mv.z, 0.05);
        gl_PointSize = k > 0.001 ? clamp(max(px * (0.35 + 0.65 * facing), 3.0 * k), 0.0, 512.0) : 0.0;
        vColor = glowColor * k;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r2 = dot(d, d) * 4.0;
        if (r2 >= 1.0) discard;
        float core = exp(-r2 * 40.0);
        float halo = exp(-r2 * 7.0) * (1.0 - r2) * 0.22;
        gl_FragColor = vec4(vColor * (core + halo), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

export function createV50Materials(tex: V50Textures | null): V50Materials {
  const char = { value: 0 };
  const gel = { roughness: 0.26, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.06 };
  const hull = addWaterlineBands(new THREE.MeshPhysicalMaterial({ name: 'v50.hull', ...gel, color: 0xf4f4f1, side: THREE.DoubleSide }));
  const grp = new THREE.MeshPhysicalMaterial({ name: 'v50.grp', ...gel, color: 0xffffff, vertexColors: true, side: THREE.DoubleSide });
  const teak = new THREE.MeshStandardMaterial({
    name: 'v50.teak',
    color: 0xffffff,
    vertexColors: true,
    map: tex?.teak ?? null,
    roughness: 0.78,
    metalness: 0,
  });
  const parts = createPartsMaterial('v50-parts');
  const props = createPartsMaterial('v50-props');
  props.side = THREE.DoubleSide;
  const interior = createPartsMaterial('v50-interior');
  const glass = new THREE.MeshPhysicalMaterial({
    name: 'v50.glass',
    color: 0x2a343c,
    roughness: 0.04,
    metalness: 0.1,
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
    side: THREE.DoubleSide,
    envMapIntensity: 1.4,
    specularIntensity: 1,
  });
  const darkGlass = new THREE.MeshPhysicalMaterial({
    name: 'v50.darkGlass',
    color: 0x0a0d10,
    roughness: 0.05,
    metalness: 0.3,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    envMapIntensity: 1.3,
  });
  const screens = new THREE.MeshStandardMaterial({
    name: 'v50.screens',
    color: tex ? 0xffffff : 0x0b0f14,
    map: tex?.screens ?? null,
    emissive: tex ? 0xffffff : 0x000000,
    emissiveMap: tex?.screens ?? null,
    emissiveIntensity: 0.6,
    roughness: 0.25,
    metalness: 0,
  });
  const disc = new THREE.MeshStandardMaterial({
    name: 'v50.propDisc',
    color: 0x9a9384,
    roughness: 0.4,
    metalness: 0.6,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const name = new THREE.MeshStandardMaterial({
    name: 'v50.name',
    color: 0xffffff,
    map: tex?.name ?? null,
    transparent: true,
    alphaTest: 0.1,
    roughness: 0.35,
    metalness: 0.5,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const nav = new THREE.MeshBasicMaterial({ name: 'v50.nav', vertexColors: true });
  const glow = glowMaterial();
  for (const m of [hull, grp, teak, parts, props]) addSoot(m, char);
  const all: THREE.Material[] = [hull, grp, teak, parts, props, interior, glass, darkGlass, screens, disc, name, nav, glow];
  return { hull, grp, teak, parts, props, interior, glass, darkGlass, screens, disc, name, nav, glow, char, all };
}
