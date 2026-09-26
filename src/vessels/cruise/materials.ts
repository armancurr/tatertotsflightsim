/**
 * MS Tater Star materials. Few materials = few draw calls:
 *  - hull: white paint whose antifouling, navy boot top and rows of portholes are drawn in the
 *    shader by body position (crisp at any distance, no geometry), the portholes lit at night;
 *  - walls: the superstructure's white walls with the window atlas (map) and its lit twin
 *    (emissive map, faded in after sunset via `night`);
 *  - parts: the aircraft's per-vertex colour / roughness / metalness material (`tint`) for every
 *    small or coloured part — decks, funnel, lifeboats, davits, mast, props, rudders, tunnels —
 *    so whole assemblies merge into single meshes; `interior` is its double-sided twin (the bridge);
 *  - glass (the bridge), pool water, the bow name, nav lenses and their glow sprites.
 * After a crash the soot spreads over the painted ones (`char`).
 */
import * as THREE from 'three';
import { addSoot, createPartsMaterial } from '../../aircraft/materials';
import { CRUISE_SHAPE } from './shape';
import type { CruiseTextures } from './textures';

export interface CruiseMaterials {
  hull: THREE.MeshStandardMaterial;
  walls: THREE.MeshStandardMaterial;
  parts: THREE.MeshStandardMaterial;
  interior: THREE.MeshStandardMaterial;
  glass: THREE.MeshPhysicalMaterial;
  water: THREE.MeshStandardMaterial;
  name: THREE.MeshStandardMaterial;
  nav: THREE.MeshBasicMaterial;
  glow: THREE.ShaderMaterial;
  /** 0 day … 1 night (lit windows, portholes, the pool). */
  night: { value: number };
  char: { value: number };
  all: THREE.Material[];
}

const f = (x: number) => x.toFixed(3);

/** Antifouling, boot top and porthole rows on the hull by body position; portholes glow at night. */
function addHullPaint(m: THREE.MeshStandardMaterial, night: { value: number }): THREE.MeshStandardMaterial {
  const S = CRUISE_SHAPE;
  const P = S.portholes;
  const rows = P.rows.map((y, i) => `ph += row(hp, hn, ${f(y)}, ${i === P.rows.length - 1 ? '0.55' : f(P.half)}, ${i === P.rows.length - 1 ? '1.1' : '0.42'});`).join('\n');
  const prev = m.onBeforeCompile;
  const prevKey = m.customProgramCacheKey.bind(m);
  m.onBeforeCompile = (shader, renderer) => {
    prev.call(m, shader, renderer);
    shader.uniforms.uNight = night;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vHullP;\nvarying vec3 vHullN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHullP = position;\nvHullN = normal;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vHullP;
        varying vec3 vHullN;
        uniform float uNight;
        float row(vec3 p, vec3 n, float y, float hh, float hw) {
          float aw = fwidth(p.y) + 1e-4;
          float inY = 1.0 - smoothstep(hh - aw, hh + aw, abs(p.y - y));
          float u = p.z / ${f(P.pitch)};
          float fu = abs(fract(u) - 0.5) * ${f(P.pitch)};
          float awz = fwidth(p.z) + 1e-4;
          float inZ = 1.0 - smoothstep(hw - awz, hw + awz, fu);
          float side = smoothstep(0.55, 0.8, abs(n.x));
          float range = step(${f(P.z0)}, p.z) * step(p.z, ${f(P.z1)});
          return inY * inZ * side * range;
        }
        float hullHash(vec2 q) { return fract(sin(dot(q, vec2(12.9898, 78.233))) * 43758.5453); }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec3 hp = vHullP;
        vec3 hn = normalize(vHullN);
        float bandAw = fwidth(hp.y) * 0.75 + 1e-4;
        float isFoul = 1.0 - smoothstep(${f(S.boot.lo)} - bandAw, ${f(S.boot.lo)} + bandAw, hp.y);
        float isBoot = (1.0 - isFoul) * (1.0 - smoothstep(${f(S.boot.hi)} - bandAw, ${f(S.boot.hi)} + bandAw, hp.y));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.045, 0.07, 0.13), isBoot);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.28, 0.07, 0.05), isFoul);
        float ph = 0.0;
        ${rows}
        ph = clamp(ph, 0.0, 1.0);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05, 0.07, 0.09), ph);
        float phLit = ph * step(0.3, hullHash(floor(vec2(hp.z / ${f(P.pitch)}, hp.y * 0.34 + sign(hp.x) * 7.0))));`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.12, ph);\nroughnessFactor = mix(roughnessFactor, 0.8, isFoul);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(1.0, 0.72, 0.42) * phLit * uNight * 1.6 + vec3(0.9, 0.85, 0.78) * 0.03 * uNight * (1.0 - isFoul - isBoot) * (1.0 - ph);');
  };
  m.customProgramCacheKey = () => prevKey() + '|cruiseHull';
  return m;
}

/** Point-sprite glow for the nav lights (additive, drawn after the model). */
function glowMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'cruise.glow',
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
        gl_PointSize = k > 0.001 ? clamp(max(px * (0.35 + 0.65 * facing), 3.0 * k), 0.0, 256.0) : 0.0;
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

/** Emissive intensity of the lit windows at full night (HDR, before exposure). */
export const WINDOW_GLOW = 1.4;

export function createCruiseMaterials(tex: CruiseTextures | null): CruiseMaterials {
  const night = { value: 0 };
  const char = { value: 0 };
  const hull = addHullPaint(new THREE.MeshStandardMaterial({ name: 'cruise.hull', color: 0xf4f4f0, roughness: 0.38, metalness: 0, side: THREE.DoubleSide }), night);
  const walls = new THREE.MeshStandardMaterial({
    name: 'cruise.walls',
    color: 0xffffff,
    map: tex?.windows ?? null,
    emissive: tex ? 0xffffff : 0x000000,
    emissiveMap: tex?.windowsLit ?? null,
    emissiveIntensity: 0,
    roughness: 0.5,
    metalness: 0,
  });
  const parts = createPartsMaterial('cruise-parts');
  const interior = createPartsMaterial('cruise-interior');
  interior.side = THREE.DoubleSide;
  const glass = new THREE.MeshPhysicalMaterial({
    name: 'cruise.glass',
    color: 0x1c2730,
    roughness: 0.05,
    metalness: 0.2,
    transparent: true,
    opacity: 0.78,
    depthWrite: false,
    side: THREE.DoubleSide,
    envMapIntensity: 1.3,
  });
  const water = new THREE.MeshStandardMaterial({ name: 'cruise.pool', color: 0x2aa6c8, roughness: 0.08, metalness: 0, emissive: 0x1fb8e0, emissiveIntensity: 0.05 });
  const name = new THREE.MeshStandardMaterial({
    name: 'cruise.name',
    color: 0xffffff,
    map: tex?.name ?? null,
    transparent: true,
    alphaTest: 0.2,
    roughness: 0.4,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const nav = new THREE.MeshBasicMaterial({ name: 'cruise.nav', vertexColors: true });
  const glow = glowMaterial();
  for (const m of [hull, walls, parts, interior]) addSoot(m, char);
  const all: THREE.Material[] = [hull, walls, parts, interior, glass, water, name, nav, glow];
  return { hull, walls, parts, interior, glass, water, name, nav, glow, night, char, all };
}
