/**
 * JetRanger materials. Few materials = few programs and draw calls: the lofted skin carries the
 * painted livery (with alpha cut-outs for the windows), the other painted parts (fairing, fins,
 * stabiliser, driveshaft cover) share one vertex-coloured gloss paint, and every small part shares
 * `parts` (vertex colour + per-vertex roughness/metalness, see `tint`). After a crash the soot
 * spreads over all of them (`char`).
 */
import * as THREE from 'three';
import { addSoot, createPartsMaterial } from '../materials';

export interface B206Textures {
  skin: THREE.Texture;
  cabin: THREE.Texture;
  mask: THREE.Texture;
  panel: THREE.Texture;
}

export interface B206Materials {
  skin: THREE.MeshPhysicalMaterial;
  paint: THREE.MeshPhysicalMaterial;
  parts: THREE.MeshStandardMaterial;
  /** Cabin furniture: seats, panel hood, controls (dimmed outside, where the cabin is in shade). */
  interior: THREE.MeshStandardMaterial;
  cabin: THREE.MeshStandardMaterial;
  glass: THREE.MeshPhysicalMaterial;
  blades: THREE.MeshStandardMaterial;
  tailBlades: THREE.MeshStandardMaterial;
  disc: THREE.ShaderMaterial;
  tailDisc: THREE.ShaderMaterial;
  panel: THREE.MeshStandardMaterial;
  nav: THREE.MeshBasicMaterial;
  beacon: THREE.MeshBasicMaterial;
  lamp: THREE.MeshBasicMaterial;
  glow: THREE.ShaderMaterial;
  char: { value: number };
  all: THREE.Material[];
}

/**
 * Rotor blur disc (the disc lies in its local xz plane): the time average of the blades — a faint
 * veil whose density follows the blades' coverage (chord / circumference, so it thins outboard), a
 * tip ring in the tip-cap colour, and a stroboscopic two-blade ghost.
 */
function discMaterial(name: string, col: THREE.Color, tipCol: THREE.Color): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name,
    uniforms: {
      uAlpha: { value: 0 },
      uGhost: { value: 0 },
      uAngle: { value: 0 },
      uRadius: { value: 1 },
      uInner: { value: 0.1 },
      uTip: { value: 0.9 },
      uColor: { value: col },
      uTipColor: { value: tipCol },
    },
    vertexShader: /* glsl */ `
      varying vec2 vP;
      void main() {
        vP = position.xz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uAlpha;
      uniform float uGhost;
      uniform float uAngle;
      uniform float uRadius;
      uniform float uInner;
      uniform float uTip;
      uniform vec3 uColor;
      uniform vec3 uTipColor;
      varying vec2 vP;
      void main() {
        float r = length(vP) / uRadius;
        if (r > 1.0 || r < uInner) discard;
        float a = atan(vP.y, vP.x);
        float cover = smoothstep(uInner, uInner + 0.06, r) * (1.0 - smoothstep(0.985, 1.0, r));
        // Coverage of two blades ~ chord / circumference: thinner outboard, but never vanishing.
        float dens = mix(1.25, 0.8, smoothstep(uInner, 1.0, r));
        float bands = 1.0 + 0.05 * sin(r * 57.0) + 0.04 * sin(r * 19.0 + 1.1);
        float ghost = pow(0.5 + 0.5 * cos(2.0 * (a - uAngle)), 36.0) * uGhost;
        float tip = smoothstep(uTip - 0.02, uTip, r);
        vec3 c = mix(uColor, uTipColor, tip);
        float alpha = cover * (uAlpha * dens * bands * (1.0 + 0.6 * tip) + ghost * 0.45);
        gl_FragColor = vec4(c, clamp(alpha, 0.0, 1.0));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/** Glass: diffuse tint scaled by alpha, reflections at full strength (premultiplied blend). */
function premultipliedGlass(m: THREE.MeshPhysicalMaterial, key: string) {
  m.blending = THREE.CustomBlending;
  m.blendSrc = THREE.OneFactor;
  m.blendDst = THREE.OneMinusSrcAlphaFactor;
  m.blendSrcAlpha = THREE.OneFactor;
  m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      'vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;',
      'vec3 outgoingLight = totalDiffuse * diffuseColor.a + (totalSpecular + totalEmissiveRadiance) * step(0.02, diffuseColor.a);',
    );
  };
  m.customProgramCacheKey = () => key;
}

export function createB206Materials(tex: B206Textures | null): B206Materials {
  const char = { value: 0 };
  const gloss = { roughness: 0.32, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.08 };
  const skin = new THREE.MeshPhysicalMaterial({
    name: 'b206.skin',
    ...gloss,
    color: tex ? 0xffffff : 0xf2f3ef,
    map: tex?.skin ?? null,
    alphaTest: tex ? 0.5 : 0,
    alphaToCoverage: !!tex,
  });
  const paint = new THREE.MeshPhysicalMaterial({ name: 'b206.paint', ...gloss, color: 0xffffff, vertexColors: true });
  const parts = createPartsMaterial('b206-parts');
  const interior = createPartsMaterial('b206-interior');
  const blades = createPartsMaterial('b206-blades');
  const tailBlades = createPartsMaterial('b206-tailBlades');
  const cabin = new THREE.MeshStandardMaterial({
    name: 'b206.cabin',
    color: tex ? 0xffffff : 0x77787b,
    map: tex?.cabin ?? null,
    roughness: 0.9,
    metalness: 0,
    side: THREE.BackSide,
    alphaTest: tex ? 0.5 : 0,
    alphaToCoverage: !!tex,
  });
  const glass = new THREE.MeshPhysicalMaterial({
    name: 'b206.glass',
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.03,
    metalness: 0,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    envMapIntensity: 1.2,
    specularIntensity: 1,
    alphaMap: tex?.mask ?? null,
    alphaTest: tex ? 0.02 : 0,
  });
  premultipliedGlass(glass, 'b206-glass');
  const disc = discMaterial('b206.rotorDisc', new THREE.Color(0.075, 0.08, 0.085), new THREE.Color(0.35, 0.36, 0.37));
  const tailDisc = discMaterial('b206.tailDisc', new THREE.Color(0.55, 0.56, 0.58), new THREE.Color(0.7, 0.12, 0.1));
  const panel = new THREE.MeshStandardMaterial({
    name: 'b206.panel',
    color: tex ? 0xffffff : 0x1c1d1f,
    map: tex?.panel ?? null,
    emissive: tex ? 0xffffff : 0x000000,
    emissiveMap: tex?.panel ?? null,
    emissiveIntensity: 0.22,
    roughness: 0.55,
    metalness: 0,
  });
  const nav = new THREE.MeshBasicMaterial({ name: 'b206.nav', vertexColors: true });
  const beacon = new THREE.MeshBasicMaterial({ name: 'b206.beacon', color: 0x5a0808 });
  const lamp = new THREE.MeshBasicMaterial({ name: 'b206.lamp', color: 0x9aa0a4 });
  const glow = new THREE.ShaderMaterial({
    name: 'b206.glow',
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
  for (const m of [skin, paint, parts, blades, tailBlades]) addSoot(m, char);
  const all: THREE.Material[] = [skin, paint, parts, interior, cabin, glass, blades, tailBlades, disc, tailDisc, panel, nav, beacon, lamp, glow];
  return { skin, paint, parts, interior, cabin, glass, blades, tailBlades, disc, tailDisc, panel, nav, beacon, lamp, glow, char, all };
}
