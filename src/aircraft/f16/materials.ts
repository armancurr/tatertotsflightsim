/**
 * F-16 materials. Few materials = few programs: every painted part shares `paint` (the livery
 * atlas: colour, roughness and panel-line bump), small parts share `parts` (vertex colour +
 * per-vertex roughness/metalness). After a crash, soot spreads from the engine bay over every
 * painted/parts material (`char` uniform).
 */
import * as THREE from 'three';
import { createPartsMaterial } from '../materials';

export interface F16Textures {
  map: THREE.Texture;
  roughness: THREE.Texture;
  bump: THREE.Texture;
  screens: THREE.Texture;
}

export interface F16Materials {
  paint: THREE.MeshStandardMaterial;
  radome: THREE.MeshStandardMaterial;
  parts: THREE.MeshStandardMaterial;
  interior: THREE.MeshStandardMaterial;
  canopy: THREE.MeshPhysicalMaterial;
  hud: THREE.MeshPhysicalMaterial;
  screens: THREE.MeshBasicMaterial;
  panel: THREE.MeshStandardMaterial;
  nav: THREE.MeshBasicMaterial;
  formation: THREE.MeshBasicMaterial;
  strobe: THREE.MeshBasicMaterial;
  lamp: THREE.MeshBasicMaterial;
  glow: THREE.ShaderMaterial;
  char: { value: number };
  all: THREE.Material[];
}

/** Soot: blackened, matte, spreading from the engine bay / fuel tanks with a noisy front. */
const SOOT_GLSL = /* glsl */ `
uniform float uChar;
varying vec3 vSootPos;
float f16Hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float f16Noise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(f16Hash(i), f16Hash(i + vec3(1, 0, 0)), f.x), mix(f16Hash(i + vec3(0, 1, 0)), f16Hash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(f16Hash(i + vec3(0, 0, 1)), f16Hash(i + vec3(1, 0, 1)), f.x), mix(f16Hash(i + vec3(0, 1, 1)), f16Hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float f16Soot(vec3 p) {
  if (uChar <= 0.0) return 0.0;
  float n = f16Noise(p * 2.3) * 0.6 + f16Noise(p * 7.1) * 0.4;
  float d = length((p - vec3(0.0, 0.0, 1.8)) * vec3(0.8, 1.0, 0.55));
  float front = uChar * 9.0 - d + (n - 0.5) * 2.6;
  return smoothstep(0.0, 1.4, front) * (0.7 + 0.3 * n);
}
`;

export function addF16Soot<T extends THREE.MeshStandardMaterial>(m: T, char: { value: number }, key: string): T {
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (shader, renderer) => {
    prev.call(m, shader, renderer);
    shader.uniforms.uChar = char;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSootPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSootPos = (modelMatrix * vec4(position, 1.0)).xyz - (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + SOOT_GLSL)
      .replace('#include <color_fragment>', '#include <color_fragment>\nfloat wSoot = f16Soot(vSootPos);\ndiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.03, 0.027, 0.025), wSoot);')
      .replace('#include <normal_fragment_begin>', 'roughnessFactor = mix(roughnessFactor, 0.97, wSoot);\nmetalnessFactor = mix(metalnessFactor, 0.0, wSoot);\n#include <normal_fragment_begin>');
  };
  m.customProgramCacheKey = () => key + '|f16soot';
  return m;
}

export function createF16Materials(tex: F16Textures | null): F16Materials {
  const char = { value: 0 };
  // Military matte paint: FS 36270 / 36118 / 36375 come from the atlas; a faint sheen.
  const paint = new THREE.MeshStandardMaterial({
    name: 'f16.paint',
    color: tex ? 0xffffff : 0x7f8488,
    map: tex?.map ?? null,
    roughness: 1,
    roughnessMap: tex?.roughness ?? null,
    metalness: 0,
    bumpMap: tex?.bump ?? null,
    bumpScale: 1.2,
  });
  if (!tex) paint.roughness = 0.6;
  const radome = new THREE.MeshStandardMaterial({ name: 'f16.radome', color: 0x5e6468, roughness: 0.5, metalness: 0 });
  const parts = createPartsMaterial('f16-parts');
  const interior = createPartsMaterial('f16-interior');
  addF16Soot(paint, char, 'f16-paint');
  addF16Soot(radome, char, 'f16-radome');
  addF16Soot(parts, char, 'f16-parts');

  // Canopy: gold/smoke tint (the ITO coating) with strong reflections.
  const canopy = new THREE.MeshPhysicalMaterial({
    name: 'f16.canopy',
    color: 0x4f4222,
    roughness: 0.02,
    metalness: 0,
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
    side: THREE.DoubleSide,
    envMapIntensity: 1.3,
  });
  premultipliedGlass(canopy, 'f16-canopy');
  const hud = new THREE.MeshPhysicalMaterial({
    name: 'f16.hud',
    color: 0x2f4a3a,
    roughness: 0.03,
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
    side: THREE.DoubleSide,
    envMapIntensity: 0.6,
  });
  premultipliedGlass(hud, 'f16-hud');
  const screens = new THREE.MeshBasicMaterial({ name: 'f16.screens', color: tex ? 0x9a9a9a : 0x061006, map: tex?.screens ?? null });
  // The painted instrument panel (lit), sharing the screen canvas.
  const panel = new THREE.MeshStandardMaterial({ name: 'f16.panel', color: tex ? 0xffffff : 0x2a2d30, map: tex?.screens ?? null, roughness: 0.8, metalness: 0 });

  const nav = new THREE.MeshBasicMaterial({ name: 'f16.nav', vertexColors: true });
  const formation = new THREE.MeshBasicMaterial({ name: 'f16.formation', color: 0x2a3326 });
  const strobe = new THREE.MeshBasicMaterial({ name: 'f16.strobe', color: 0xbfc4c8 });
  const lamp = new THREE.MeshBasicMaterial({ name: 'f16.lamp', color: 0x9aa0a4 });

  const glow = new THREE.ShaderMaterial({
    name: 'f16.glow',
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

  const all: THREE.Material[] = [paint, radome, parts, interior, canopy, hud, screens, panel, nav, formation, strobe, lamp, glow];
  return { paint, radome, parts, interior, canopy, hud, screens, panel, nav, formation, strobe, lamp, glow, char, all };
}

/** Glass: diffuse tint scaled by opacity, reflections at full strength (premultiplied blend). */
function premultipliedGlass(m: THREE.MeshPhysicalMaterial, key: string) {
  m.blending = THREE.CustomBlending;
  m.blendSrc = THREE.OneFactor;
  m.blendDst = THREE.OneMinusSrcAlphaFactor;
  m.blendSrcAlpha = THREE.OneFactor;
  m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      'vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;',
      'vec3 outgoingLight = totalDiffuse * diffuseColor.a + totalSpecular + totalEmissiveRadiance;',
    );
  };
  m.customProgramCacheKey = () => key;
}
