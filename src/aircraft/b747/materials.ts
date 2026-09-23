/**
 * 747 materials. Few materials = few programs: every painted surface shares `paint` (the livery
 * atlas: colour, plus one data texture with the panel-line bump in R and the roughness in G — a
 * standard material: a clear coat doubled the jumbo's GPU cost for little visible gain), small parts share `parts` (vertex colour + per-vertex
 * roughness/metalness). `surfaces` is the same paint pulled forward in depth (spoilers and
 * Krueger flaps lie on the wing skin). The logo lights wash the fin from the stabiliser (an
 * emissive term with a falloff from the two lamps — no real light, so no shader recompiles), and a
 * wreck's soot spreads from the engines and the wing roots (`char` uniform).
 */
import * as THREE from 'three';
import { createPartsMaterial } from '../materials';

export interface B747Textures {
  map: THREE.Texture;
  /** R = panel-line bump, G = roughness. */
  data: THREE.Texture;
}

/** Shared uniforms of the painted/parts materials. */
export interface B747Effects {
  /** Wreck soot coverage 0..1. */
  char: { value: number };
  /** Logo-light wash 0..1. */
  logo: { value: number };
  /** Inverse of the aircraft root's world matrix (set before each draw). */
  bodyFromWorld: { value: THREE.Matrix4 };
}

export interface B747Materials {
  paint: THREE.MeshStandardMaterial;
  surfaces: THREE.MeshStandardMaterial;
  parts: THREE.MeshStandardMaterial;
  glass: THREE.MeshPhysicalMaterial;
  nav: THREE.MeshBasicMaterial;
  glow: THREE.ShaderMaterial;
  fx: B747Effects;
  all: THREE.Material[];
}

const SOOT_GLSL = /* glsl */ `
uniform float uChar;
uniform float uLogo;
varying vec3 vBodyPos;
varying vec3 vBodyNormal;
float b7Hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float b7Noise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(b7Hash(i), b7Hash(i + vec3(1, 0, 0)), f.x), mix(b7Hash(i + vec3(0, 1, 0)), b7Hash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(b7Hash(i + vec3(0, 0, 1)), b7Hash(i + vec3(1, 0, 1)), f.x), mix(b7Hash(i + vec3(0, 1, 1)), b7Hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float b7Soot(vec3 p) {
  if (uChar <= 0.0) return 0.0;
  float n = b7Noise(p * 0.55) * 0.6 + b7Noise(p * 1.9) * 0.4;
  vec3 q = vec3(abs(p.x), p.y, p.z);
  float dIn = length((q - vec3(11.9, -1.5, -1.0)) * vec3(1.0, 1.0, 0.5));
  float dOut = length((q - vec3(21.2, -0.6, 6.0)) * vec3(1.0, 1.0, 0.5));
  float dRoot = length((q - vec3(4.0, -2.0, 2.0)) * vec3(0.6, 1.0, 0.45));
  float d = min(min(dIn, dOut), dRoot);
  float front = uChar * 30.0 - d + (n - 0.5) * 8.0;
  return smoothstep(0.0, 4.0, front) * (0.7 + 0.3 * n);
}
// Logo lights: two lamps on the stabiliser's upper surface washing the fin.
float b7Logo(vec3 p, vec3 n) {
  if (uLogo <= 0.0 || abs(p.x) > 1.2 || p.z < 22.0 || p.y < 1.5) return 0.0;
  float s = 0.0;
  for (int i = 0; i < 2; i++) {
    vec3 lamp = vec3(i == 0 ? -3.4 : 3.4, 1.35, 31.9);
    vec3 d = p - lamp;
    float dist2 = dot(d, d);
    float lambert = max(0.0, dot(normalize(n), normalize(-d)));
    float cone = smoothstep(0.35, 0.8, dot(normalize(d), normalize(vec3(-sign(lamp.x) * 0.4, 1.0, 0.35))));
    s += lambert * cone * 60.0 / (4.0 + dist2);
  }
  return s * uLogo;
}
`;

/** Soot (+ the logo-light wash on painted surfaces) in body coordinates. */
export function addB747Effects<T extends THREE.MeshStandardMaterial>(m: T, fx: B747Effects, key: string): T {
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (shader, renderer) => {
    prev.call(m, shader, renderer);
    shader.uniforms.uChar = fx.char;
    shader.uniforms.uLogo = fx.logo;
    shader.uniforms.uBodyFromWorld = fx.bodyFromWorld;
    // Body-frame position/normal of every vertex (hinged parts included): world → aircraft root.
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform mat4 uBodyFromWorld;\nvarying vec3 vBodyPos;\nvarying vec3 vBodyNormal;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvBodyPos = (uBodyFromWorld * (modelMatrix * vec4(transformed, 1.0))).xyz;\nvBodyNormal = mat3(uBodyFromWorld) * (mat3(modelMatrix) * objectNormal);',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + SOOT_GLSL)
      .replace('#include <color_fragment>', '#include <color_fragment>\nfloat wSoot = b7Soot(vBodyPos);\ndiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.03, 0.027, 0.025), wSoot);')
      .replace('#include <normal_fragment_begin>', 'roughnessFactor = mix(roughnessFactor, 0.97, wSoot);\nmetalnessFactor = mix(metalnessFactor, 0.0, wSoot);\n#include <normal_fragment_begin>')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.95, 0.86) * b7Logo(vBodyPos, vBodyNormal) * (1.0 - wSoot);');
  };
  m.customProgramCacheKey = () => key + '|b747fx';
  return m;
}

export function createB747Materials(tex: B747Textures | null): B747Materials {
  const fx: B747Effects = { char: { value: 0 }, logo: { value: 0 }, bodyFromWorld: { value: new THREE.Matrix4() } };
  const paintParams: THREE.MeshStandardMaterialParameters = {
    color: tex ? 0xffffff : 0xe9ecef,
    map: tex?.map ?? null,
    roughness: tex ? 1 : 0.35,
    roughnessMap: tex?.data ?? null,
    bumpMap: tex?.data ?? null,
    bumpScale: 0.9,
    metalness: 0,
    envMapIntensity: 1.15,
  };
  const paint = new THREE.MeshStandardMaterial({ ...paintParams, name: 'b747.paint' });
  addB747Effects(paint, fx, 'b747-paint');
  const surfaces = new THREE.MeshStandardMaterial({ ...paintParams, name: 'b747.surfaces', polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  addB747Effects(surfaces, fx, 'b747-paint');
  const parts = createPartsMaterial('b747-parts');
  addB747Effects(parts, fx, 'b747-parts');

  // Flight-deck glass: dark, strongly reflective (premultiplied: diffuse tint scaled by opacity).
  const glass = new THREE.MeshPhysicalMaterial({
    name: 'b747.glass',
    color: 0x1a2228,
    roughness: 0.04,
    metalness: 0,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    side: THREE.DoubleSide,
    envMapIntensity: 1.3,
  });
  glass.blending = THREE.CustomBlending;
  glass.blendSrc = THREE.OneFactor;
  glass.blendDst = THREE.OneMinusSrcAlphaFactor;
  glass.blendSrcAlpha = THREE.OneFactor;
  glass.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  glass.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      'vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;',
      'vec3 outgoingLight = totalDiffuse * diffuseColor.a + totalSpecular + totalEmissiveRadiance;',
    );
  };
  glass.customProgramCacheKey = () => 'b747-glass';

  const nav = new THREE.MeshBasicMaterial({ name: 'b747.lenses', vertexColors: true });

  const glow = new THREE.ShaderMaterial({
    name: 'b747.glow',
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

  const all: THREE.Material[] = [paint, surfaces, parts, glass, nav, glow];
  return { paint, surfaces, parts, glass, nav, glow, fx, all };
}
