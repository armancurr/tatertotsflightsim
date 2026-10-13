/**
 * USS Iowa materials. Few materials = few draw calls and programs:
 *   hull      haze-gray steel whose black boot-top and red antifouling are painted in the shader by
 *             body height (crisp at any distance, and they follow the ship when she rolls);
 *   deck      the teak main deck: planks, seams and butts drawn procedurally in the shader (no
 *             texture), fading to the mean colour with distance so it never shimmers;
 *   gray      the per-vertex colour / roughness / metalness parts material (src/aircraft/materials.ts
 *             `tint`): superstructure, turrets, guns, masts, fittings, markings — everything merges;
 *   glass     the pilot-house windows (see-through from the helm);
 *   lit       lit portholes and windows at night (unlit colour × the night factor);
 *   nav       the navigation-light lenses; glow: point sprites for nav and deck lights;
 *   flash     the 16-inch muzzle flash billboards (additive; one material per turret for its uFlash).
 * `night` is a shared uniform 0 (day) … 1 (night) the model sets from the scene's sun.
 */
import * as THREE from 'three';
import { createPartsMaterial } from '../../aircraft/materials';
import { by } from './shape';

/** Paint bands on the hull, body y: antifouling below `bootLo`, the black boot-top up to `bootHi`. */
export const HULL_BANDS = { bootLo: by(-1.1), bootHi: by(0.85) } as const;

export const IOWA_COLORS = {
  haze: 0x7e8387,
  hazeDark: 0x63686c,
  deckGray: 0x474b4f,
  nonSkid: 0x3a3d40,
  black: 0x17191b,
  window: 0x12161a,
  white: 0xe9ebec,
  red: 0x8a2a22,
  bronze: 0xb08d57,
  teak: 0x7a6a56,
  rust: 0x5a3b2a,
  yellow: 0xd9b43a,
} as const;

const ANTIFOUL = new THREE.Color(IOWA_COLORS.red);
const BOOT = new THREE.Color(IOWA_COLORS.black);

export interface IowaMaterials {
  hull: THREE.MeshStandardMaterial;
  deck: THREE.MeshStandardMaterial;
  gray: THREE.MeshStandardMaterial;
  glass: THREE.MeshPhysicalMaterial;
  lit: THREE.MeshBasicMaterial;
  nav: THREE.MeshBasicMaterial;
  glow: THREE.ShaderMaterial;
  /** One per turret (they differ only in uFlash). */
  flash: THREE.ShaderMaterial[];
  night: { value: number };
  /** 0 intact … 1 burnt-out wreck (darkens the painted materials). */
  char: { value: number };
  all: THREE.Material[];
}

function addHullBands(m: THREE.MeshStandardMaterial, char: { value: number }): THREE.MeshStandardMaterial {
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uAntifoul = { value: ANTIFOUL };
    shader.uniforms.uBoot = { value: BOOT };
    shader.uniforms.uChar = char;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vHullP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHullP = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vHullP;\nuniform vec3 uAntifoul;\nuniform vec3 uBoot;\nuniform float uChar;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float bandAw = fwidth(vHullP.y) * 0.75 + 1e-4;
        float isBoot = smoothstep(${HULL_BANDS.bootLo.toFixed(3)} - bandAw, ${HULL_BANDS.bootLo.toFixed(3)} + bandAw, vHullP.y) * (1.0 - smoothstep(${HULL_BANDS.bootHi.toFixed(3)} - bandAw, ${HULL_BANDS.bootHi.toFixed(3)} + bandAw, vHullP.y));
        float isFoul = 1.0 - smoothstep(${HULL_BANDS.bootLo.toFixed(3)} - bandAw, ${HULL_BANDS.bootLo.toFixed(3)} + bandAw, vHullP.y);
        // faint plating seams / weathering streaks on the gray topsides
        float streak = 0.94 + 0.06 * fract(sin(floor(vHullP.z * 0.45) * 12.9898) * 43758.5453);
        diffuseColor.rgb *= mix(streak, 1.0, isBoot + isFoul);
        diffuseColor.rgb = mix(diffuseColor.rgb, uBoot, isBoot);
        diffuseColor.rgb = mix(diffuseColor.rgb, uAntifoul, isFoul);
        diffuseColor.rgb *= 1.0 - 0.8 * uChar;`,
      );
  };
  m.customProgramCacheKey = () => 'iowa.hull';
  return m;
}

/** Teak planks along the ship (0.14 m wide, butts every ~6 m staggered), seams dark; fades out with distance. */
function addTeak(m: THREE.MeshStandardMaterial, char: { value: number }): THREE.MeshStandardMaterial {
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uChar = char;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDeckP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDeckP = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDeckP;\nuniform float uChar;\nfloat teakHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float plankW = 0.14;
        float u = vDeckP.x / plankW;
        float row = floor(u);
        float along = vDeckP.z / 6.1 + teakHash(vec2(row, 3.0)) * 6.1;
        float plank = floor(along);
        float tone = 0.86 + 0.24 * teakHash(vec2(row, plank));
        float fw = fwidth(u);
        float seam = smoothstep(0.0, 0.08 + fw, fract(u)) * smoothstep(0.0, 0.08 + fw, 1.0 - fract(u));
        float fb = fwidth(along);
        float butt = smoothstep(0.0, 0.01 + fb, fract(along)) * smoothstep(0.0, 0.01 + fb, 1.0 - fract(along));
        float lines = mix(0.55, 1.0, seam * butt);
        float fade = clamp(fw * 1.6, 0.0, 1.0);
        diffuseColor.rgb *= mix(tone * lines, 0.9, fade);
        diffuseColor.rgb *= 1.0 - 0.85 * uChar;`,
      );
  };
  m.customProgramCacheKey = () => 'iowa.teak';
  return m;
}

/** Point sprites for the lights: per-point colour, size (m), facing (aDir, 0 = all round) and kind (0 nav, 1 deck lamp). */
function glowMaterial(night: { value: number }): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'iowa.glow',
    uniforms: { uHalfHeight: { value: 450 }, uNav: { value: 1 }, uNight: night },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      attribute vec3 glowColor;
      attribute vec3 aDir;
      attribute float size;
      attribute float kind;
      uniform float uHalfHeight;
      uniform float uNav;
      uniform float uNight;
      varying vec3 vColor;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float facing = 1.0;
        if (dot(aDir, aDir) > 0.0) {
          vec3 d = normalize(normalMatrix * aDir);
          facing = smoothstep(-0.2, 0.3, dot(d, normalize(-mv.xyz)));
        }
        float on = kind < 0.5 ? uNav * mix(0.35, 1.0, uNight) : uNight;
        float k = on * facing;
        float px = size * projectionMatrix[1][1] * uHalfHeight / max(-mv.z, 0.05);
        gl_PointSize = k > 0.001 ? clamp(max(px, 2.5 * k), 0.0, 256.0) : 0.0;
        vColor = glowColor * k;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <logdepthbuf_pars_fragment>
      varying vec3 vColor;
      void main() {
        #include <logdepthbuf_fragment>
        vec2 d = gl_PointCoord - 0.5;
        float r2 = dot(d, d) * 4.0;
        if (r2 >= 1.0) discard;
        float core = exp(-r2 * 30.0);
        float halo = exp(-r2 * 6.0) * (1.0 - r2) * 0.25;
        gl_FragColor = vec4(vColor * (core + halo), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

/**
 * The 16-inch muzzle flash: camera-facing quads (aCorner = the quad corner −1…1, aBarrel = which
 * gun), a hot core and an orange fireball with a ragged edge, scaled and faded by uFlash[barrel].
 */
export function flashMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'iowa.flash',
    uniforms: { uFlash: { value: new THREE.Vector3() }, uSize: { value: 22 } },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      attribute vec2 aCorner;
      attribute float aBarrel;
      uniform vec3 uFlash;
      uniform float uSize;
      varying vec2 vUv;
      varying float vK;
      void main() {
        float k = aBarrel < 0.5 ? uFlash.x : aBarrel < 1.5 ? uFlash.y : uFlash.z;
        vK = k;
        vUv = aCorner;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float s = uSize * (0.45 + 0.55 * sqrt(k));
        mv.xy += aCorner * s * step(0.001, k);
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <logdepthbuf_pars_fragment>
      varying vec2 vUv;
      varying float vK;
      void main() {
        #include <logdepthbuf_fragment>
        float r = length(vUv);
        float a = atan(vUv.y, vUv.x);
        float edge = 0.78 + 0.16 * sin(a * 7.0 + vK * 9.0) + 0.08 * sin(a * 13.0 - vK * 5.0);
        float ball = 1.0 - smoothstep(edge * 0.55, edge, r);
        float core = exp(-r * r * 18.0);
        vec3 col = mix(vec3(1.0, 0.45, 0.1), vec3(1.0, 0.88, 0.6), core) * (ball * 1.1 + core * 3.5);
        float alpha = clamp(ball * 0.85 + core, 0.0, 1.0) * vK;
        if (alpha < 0.003) discard;
        gl_FragColor = vec4(col * alpha, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

export function createIowaMaterials(turrets: number): IowaMaterials {
  const night = { value: 0 };
  const char = { value: 0 };
  const hull = addHullBands(new THREE.MeshStandardMaterial({ name: 'iowa.hull', color: IOWA_COLORS.haze, roughness: 0.72, metalness: 0.12, side: THREE.DoubleSide }), char);
  const deck = addTeak(new THREE.MeshStandardMaterial({ name: 'iowa.deck', color: IOWA_COLORS.teak, roughness: 0.86, metalness: 0 }), char);
  const gray = createPartsMaterial('iowa-gray');
  gray.side = THREE.DoubleSide;
  const glass = new THREE.MeshPhysicalMaterial({
    name: 'iowa.glass',
    color: 0x2b363e,
    roughness: 0.05,
    metalness: 0.1,
    transparent: true,
    opacity: 0.6,
    depthWrite: false,
    side: THREE.DoubleSide,
    envMapIntensity: 1.3,
  });
  const lit = new THREE.MeshBasicMaterial({ name: 'iowa.lit', color: 0xffd9a0, toneMapped: true });
  const nav = new THREE.MeshBasicMaterial({ name: 'iowa.nav', vertexColors: true });
  const glow = glowMaterial(night);
  const flash = Array.from({ length: turrets }, () => flashMaterial());
  const all: THREE.Material[] = [hull, deck, gray, glass, lit, nav, glow, ...flash];
  return { hull, deck, gray, glass, lit, nav, glow, flash, night, char, all };
}
