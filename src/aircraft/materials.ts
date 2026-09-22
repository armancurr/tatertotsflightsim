/**
 * Shared materials of the aircraft. Few materials = few draw calls: small
 * static parts (tyres, struts, antennas, cockpit furniture…) all use the
 * `parts` material, whose colour, roughness and metalness come per vertex
 * (see `tint`), so whole assemblies merge into single meshes.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { FuselageTextures } from './livery';

export interface AircraftMaterials {
  skin: THREE.MeshPhysicalMaterial;
  fin: THREE.MeshPhysicalMaterial;
  paint: THREE.MeshPhysicalMaterial;
  parts: THREE.MeshStandardMaterial;
  blades: THREE.MeshStandardMaterial;
  glass: THREE.MeshPhysicalMaterial;
  disc: THREE.ShaderMaterial;
  nav: THREE.MeshBasicMaterial;
  strobe: THREE.MeshBasicMaterial;
  beacon: THREE.MeshBasicMaterial;
  lamp: THREE.MeshBasicMaterial;
  glow: THREE.ShaderMaterial;
  cabin: THREE.MeshStandardMaterial;
  panel: THREE.MeshStandardMaterial;
  gearLights: THREE.MeshBasicMaterial;
  all: THREE.Material[];
}

/** Adds per-vertex roughness/metalness (attribute `rm`) to a standard/physical material. */
function perVertexRM<T extends THREE.MeshStandardMaterial>(m: T, key: string): T {
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 rm;\nvarying vec2 vRM;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRM = rm;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vRM;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vRM.x;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vRM.y;');
  };
  m.customProgramCacheKey = () => key;
  return m;
}

const PAINT_WHITE = 0xf2f2ee;

/** A vertex-coloured material with per-vertex roughness/metalness (see `tint`). */
export function createPartsMaterial(key: string): THREE.MeshStandardMaterial {
  const m = perVertexRM(new THREE.MeshStandardMaterial({ vertexColors: true }), key);
  m.name = `ac.${key}`;
  return m;
}

export function createMaterials(tex: FuselageTextures | null): AircraftMaterials {
  const paintBase = {
    color: PAINT_WHITE,
    roughness: 0.3,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.06,
  };
  const skin = new THREE.MeshPhysicalMaterial({
    ...paintBase,
    color: 0xffffff,
    map: tex?.map ?? null,
    roughnessMap: tex?.orm ?? null,
    clearcoatMap: tex?.orm ?? null,
    roughness: tex ? 1 : 0.3,
    alphaTest: tex ? 0.5 : 0,
    alphaToCoverage: !!tex,
  });
  skin.name = 'ac.skin';
  const fin = new THREE.MeshPhysicalMaterial({ ...paintBase, color: 0xffffff, map: tex?.fin ?? null });
  fin.name = 'ac.fin';
  const paint = new THREE.MeshPhysicalMaterial({ ...paintBase });
  paint.name = 'ac.paint';

  const parts = createPartsMaterial('ac-parts');
  const blades = createPartsMaterial('ac-blades');

  // Glass: diffuse tint scaled by opacity, reflections at full strength (premultiplied blend).
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x33464c,
    roughness: 0.03,
    metalness: 0,
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
    side: THREE.DoubleSide,
    envMapIntensity: 1.2,
    specularIntensity: 1,
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
  glass.customProgramCacheKey = () => 'ac-glass';
  glass.name = 'ac.glass';

  const disc = new THREE.ShaderMaterial({
    name: 'ac.propDisc',
    uniforms: {
      uBlend: { value: 0 },
      uAngle: { value: 0 },
      uRadius: { value: 0.96 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vP;
      void main() {
        vP = position.xy;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uBlend;
      uniform float uAngle;
      uniform float uRadius;
      varying vec2 vP;
      void main() {
        float r = length(vP) / uRadius;
        if (r > 1.0) discard;
        float a = atan(vP.y, vP.x);
        // Blade coverage: blades are widest mid-span; soft root and tip.
        float cover = smoothstep(0.12, 0.3, r) * (1.0 - smoothstep(0.96, 1.0, r));
        // A faint two-blade ghost that turns slowly, plus fine concentric banding.
        float ghost = pow(0.5 + 0.5 * cos(2.0 * (a - uAngle)), 8.0);
        float bands = 0.92 + 0.08 * sin(r * 60.0);
        vec3 front = vec3(0.42, 0.43, 0.45);
        vec3 back = vec3(0.03);
        vec3 col = gl_FrontFacing ? front : back;
        float alpha = cover * (0.16 + 0.1 * ghost) * bands;
        // Painted tip bands (red / white / red) show as faint coloured rings.
        if (r > 0.86) {
          float k = (r - 0.86) / 0.14;
          vec3 tip = (k < 0.33 || k > 0.66) ? vec3(0.62, 0.06, 0.05) : vec3(0.85);
          col = mix(col, tip, 0.8);
          alpha = cover * 0.15;
        }
        gl_FragColor = vec4(col, alpha * uBlend);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  const nav = new THREE.MeshBasicMaterial({ vertexColors: true, name: 'ac.nav' });
  const strobe = new THREE.MeshBasicMaterial({ color: 0xbfc4c8, name: 'ac.strobe' });
  const beacon = new THREE.MeshBasicMaterial({ color: 0x5a0808, name: 'ac.beacon' });
  const lamp = new THREE.MeshBasicMaterial({ color: 0x9aa0a4, name: 'ac.lamp' });

  const glow = new THREE.ShaderMaterial({
    name: 'ac.glow',
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
        // Directional lamps (nav sectors, landing light) fade out when seen from behind.
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

  const cabin = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: tex?.cabin ?? null,
    roughness: 0.92,
    metalness: 0,
    side: THREE.BackSide,
    alphaTest: tex ? 0.5 : 0,
    alphaToCoverage: !!tex,
    name: 'ac.cabin',
  });
  if (!tex) cabin.color.setHex(0x8f877a);

  const panel = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.6,
    metalness: 0,
    emissive: 0xffffff,
    emissiveIntensity: 0.28,
    name: 'ac.panel',
  });

  const gearLights = new THREE.MeshBasicMaterial({ color: 0x18ff40, name: 'ac.gearLights' });

  const all: THREE.Material[] = [
    skin, fin, paint, parts, blades, glass, disc, nav, strobe, beacon, lamp, glow, cabin, panel, gearLights,
  ];
  return { skin, fin, paint, parts, blades, glass, disc, nav, strobe, beacon, lamp, glow, cabin, panel, gearLights, all };
}

// ─── Geometry helpers for the `parts` material ───────────────────────────────

const _c = new THREE.Color();

/**
 * Prepare a geometry for the parts material: per-vertex colour (sRGB hex in),
 * roughness and metalness; guarantees position/normal/uv + index so any set of
 * tinted geometries can be merged.
 */
export function tint(geo: THREE.BufferGeometry, hex: number, roughness: number, metalness = 0): THREE.BufferGeometry {
  let g = geo;
  if (!g.index) {
    const n = g.getAttribute('position').count;
    const idx = new (n > 65535 ? Uint32Array : Uint16Array)(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  const count = g.getAttribute('position').count;
  if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  for (const name of Object.keys(g.attributes)) {
    if (!['position', 'normal', 'uv', 'color', 'rm'].includes(name)) g.deleteAttribute(name);
  }
  _c.setHex(hex);
  const col = new Float32Array(count * 3);
  const rm = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    col[i * 3] = _c.r;
    col[i * 3 + 1] = _c.g;
    col[i * 3 + 2] = _c.b;
    rm[i * 2] = roughness;
    rm[i * 2 + 1] = metalness;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('rm', new THREE.BufferAttribute(rm, 2));
  g.morphAttributes = {};
  return g;
}

/** Merge geometries that share an attribute layout (throws with a clear message otherwise). */
export function merge(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const clean = list.map((g) => {
    for (const name of Object.keys(g.attributes)) {
      if (!['position', 'normal', 'uv', 'color', 'rm'].includes(name)) g.deleteAttribute(name);
    }
    return g;
  });
  const out = mergeGeometries(clean, false);
  if (!out) throw new Error('aircraft: mergeGeometries failed (attribute mismatch)');
  for (const g of list) g.dispose();
  return out;
}

/** Strip a loft/primitive down to position/normal/uv (for painted meshes that get merged). */
export function plain(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  for (const name of Object.keys(geo.attributes)) {
    if (!['position', 'normal', 'uv'].includes(name)) geo.deleteAttribute(name);
  }
  if (!geo.index) {
    const n = geo.getAttribute('position').count;
    const idx = new (n > 65535 ? Uint32Array : Uint16Array)(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  return geo;
}
