/**
 * Impostor atlas: every species mesh (with its leaf-card textures) rendered
 * once at startup from 6 view elevations (0°, 18°, … 90°) into two RGBA8
 * render targets: albedo (sRGB, alpha = coverage) and view-space bent normals
 * = the billboard's tangent-space normals (alpha = leaf mask, for
 * translucency). Rows = species, columns = elevation. Mipmapped, so far
 * forests filter smoothly. Baking needs a renderer: pass one to `bake`, or let
 * the first impostor draw bake lazily from its onBeforeRender (nested render,
 * the same pattern three's Reflector uses).
 */
import * as THREE from 'three';
import { buildSpeciesGeometry, SPECIES_R0 } from './species';
import { SPECIES_COUNT } from './placement';
import { ELEVATION_COLS, ELEVATION_STEP, TILE_MARGIN, halfHeightAt, CROWN_CENTER, type ImpostorAtlasTextures } from './materials';
import type { FoliageTextures } from './textures';

export interface ImpostorAtlas extends ImpostorAtlasTextures {
  readonly baked: boolean;
  /** Renders the atlas (idempotent). Restores the renderer's target, viewport and clear state. */
  bake(renderer: THREE.WebGLRenderer): void;
  dispose(): void;
}

/** Linear colour behind each species' silhouettes (≈ its foliage) so filtering has no dark halos. */
const CLEAR_LINEAR: [number, number, number][] = [
  [0.022, 0.045, 0.03],
  [0.04, 0.06, 0.03],
  [0.05, 0.09, 0.028],
  [0.07, 0.12, 0.035],
  [0.04, 0.085, 0.028],
  [0.06, 0.09, 0.045],
  [0.05, 0.08, 0.03],
];

const bakeVert = /* glsl */ `
attribute float leaf;
varying vec2 vUv;
varying vec3 vCol;
varying vec3 vN;
varying vec3 vObj;
varying float vLeaf;
void main() {
  vUv = uv;
  vCol = color;
  vLeaf = leaf;
  vObj = position;
  vN = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const bakeAlbedoFrag = /* glsl */ `
uniform sampler2D map;
varying vec2 vUv;
varying vec3 vCol;
varying vec3 vN;
varying vec3 vObj;
varying float vLeaf;
float h3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float n3(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h3(i), h3(i + vec3(1, 0, 0)), f.x), mix(h3(i + vec3(0, 1, 0)), h3(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(h3(i + vec3(0, 0, 1)), h3(i + vec3(1, 0, 1)), f.x), mix(h3(i + vec3(0, 1, 1)), h3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
void main() {
  vec4 t = texture2D(map, vUv);
  if (t.a < 0.45) discard;
  float n = n3(vObj * 14.0) * 0.6 + n3(vObj * 40.0) * 0.4;
  vec3 c = t.rgb * vCol * mix(1.0, 0.8 + 0.4 * n, vLeaf);
  gl_FragColor = vec4(c, 1.0);
}`;

const bakeNormalFrag = /* glsl */ `
uniform sampler2D map;
varying vec2 vUv;
varying vec3 vCol;
varying vec3 vN;
varying vec3 vObj;
varying float vLeaf;
void main() {
  vec4 t = texture2D(map, vUv);
  if (t.a < 0.45) discard;
  vec3 n = normalize(vN);
  // bark faces the camera side it is seen from; foliage keeps its bent normal
  if (vLeaf < 0.5 && !gl_FrontFacing) n = -n;
  gl_FragColor = vec4(n * 0.5 + 0.5, vLeaf);
}`;

export function createImpostorAtlas(tileSize: number, tex: FoliageTextures): ImpostorAtlas {
  const cols = ELEVATION_COLS;
  const rows = SPECIES_COUNT;
  const w = cols * tileSize;
  const h = rows * tileSize;
  const mk = (srgb: boolean): THREE.WebGLRenderTarget => {
    const rt = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      anisotropy: 4,
    });
    rt.texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    rt.texture.name = srgb ? 'vegetation-impostor-albedo' : 'vegetation-impostor-normal';
    return rt;
  };
  const albedoRT = mk(true);
  const normalRT = mk(false);
  let baked = false;

  const atlas: ImpostorAtlas = {
    albedo: albedoRT.texture,
    normal: normalRT.texture,
    cols,
    rows,
    size: new THREE.Vector2(w, h),
    get baked() {
      return baked;
    },
    bake(renderer: THREE.WebGLRenderer): void {
      if (baked) return;
      baked = true;
      const prevTarget = renderer.getRenderTarget();
      const prevClear = renderer.getClearColor(new THREE.Color());
      const prevAlpha = renderer.getClearAlpha();
      const prevAutoClear = renderer.autoClear;
      const prevShadowAuto = renderer.shadowMap.autoUpdate;
      const prevXr = renderer.xr.enabled;
      renderer.xr.enabled = false;
      renderer.shadowMap.autoUpdate = false;
      renderer.autoClear = false;

      const scene = new THREE.Scene();
      const mat = (frag: string): THREE.ShaderMaterial =>
        new THREE.ShaderMaterial({ vertexShader: bakeVert, fragmentShader: frag, uniforms: { map: { value: tex.map } }, vertexColors: true, side: THREE.DoubleSide });
      const albedoMat = mat(bakeAlbedoFrag);
      const normalMat = mat(bakeNormalFrag);
      const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 20);
      const geoms = Array.from({ length: SPECIES_COUNT }, (_, s) => buildSpeciesGeometry(s));
      const mesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material> = new THREE.Mesh(geoms[0], albedoMat);
      mesh.frustumCulled = false;
      scene.add(mesh);
      const center = new THREE.Vector3();
      const clear = new THREE.Color();

      for (const pass of [0, 1]) {
        const rt = pass === 0 ? albedoRT : normalRT;
        mesh.material = pass === 0 ? albedoMat : normalMat;
        for (let s = 0; s < SPECIES_COUNT; s++) {
          const R0 = SPECIES_R0[s];
          mesh.geometry = geoms[s];
          mesh.scale.set(R0, 1, R0); // canonical proportions: height 1, crown radius R0
          center.set(0, CROWN_CENTER, 0);
          for (let k = 0; k < cols; k++) {
            const e = k * ELEVATION_STEP;
            const hw = R0 * TILE_MARGIN;
            const hh = halfHeightAt(1, R0, e) * TILE_MARGIN;
            cam.left = -hw;
            cam.right = hw;
            cam.top = hh;
            cam.bottom = -hh;
            cam.updateProjectionMatrix();
            // camera on +Z side, raised by e; up = world up projected (continuous to −Z at 90°)
            const se = Math.sin(e);
            const ce = Math.cos(e);
            cam.position.set(0, center.y + se * 5, ce * 5);
            cam.up.set(0, ce, -se);
            cam.lookAt(center);
            rt.viewport.set(k * tileSize, s * tileSize, tileSize, tileSize);
            rt.scissor.set(k * tileSize, s * tileSize, tileSize, tileSize);
            rt.scissorTest = true;
            renderer.setRenderTarget(rt);
            if (pass === 0) {
              const c = CLEAR_LINEAR[s];
              clear.setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace);
            } else clear.setRGB(0.5, 0.5, 1, THREE.LinearSRGBColorSpace);
            renderer.setClearColor(clear, 0);
            renderer.clear(true, true, false);
            renderer.render(scene, cam);
          }
        }
        rt.scissorTest = false;
        rt.viewport.set(0, 0, w, h);
        rt.scissor.set(0, 0, w, h);
      }

      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(prevClear, prevAlpha);
      renderer.autoClear = prevAutoClear;
      renderer.shadowMap.autoUpdate = prevShadowAuto;
      renderer.xr.enabled = prevXr;
      for (const g of geoms) g.dispose();
      albedoMat.dispose();
      normalMat.dispose();
    },
    dispose(): void {
      albedoRT.dispose();
      normalRT.dispose();
    },
  };
  return atlas;
}
