/**
 * Impostor atlas: every species mesh rendered once at startup from 4 view
 * elevations (0°, 30°, 60°, 90°) into two half-float render targets (albedo
 * with alpha; view-space normals = the billboard's tangent-space normals).
 * Rows = species, columns = elevation. Mipmapped, so far forests filter
 * smoothly. Baking needs a renderer: pass one to `bake`, or let the first
 * impostor draw bake lazily from its onBeforeRender (nested render, the same
 * pattern three's Reflector uses).
 */
import * as THREE from 'three';
import { buildSpeciesGeometry, SPECIES_R0 } from './species';
import { SPECIES_COUNT } from './placement';
import { ELEVATION_STEP, TILE_MARGIN, halfHeightAt, CROWN_CENTER, type ImpostorAtlasTextures } from './materials';

export interface ImpostorAtlas extends ImpostorAtlasTextures {
  readonly baked: boolean;
  /** Renders the atlas (idempotent). Restores the renderer's target, viewport and clear state. */
  bake(renderer: THREE.WebGLRenderer): void;
  dispose(): void;
}

/** Colour behind the tree silhouettes (≈ foliage) so bilinear/mip filtering has no dark halos. */
const CLEAR = [0x0a130a, 0x14220c, 0x16240d, 0x15220d];

export function createImpostorAtlas(tileSize = 256): ImpostorAtlas {
  const cols = 4;
  const rows = SPECIES_COUNT;
  const w = cols * tileSize;
  const h = rows * tileSize;
  const mk = (): THREE.WebGLRenderTarget =>
    new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      anisotropy: 4,
    });
  const albedoRT = mk();
  const normalRT = mk();
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
      const albedoMat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, toneMapped: false });
      const normalMat = new THREE.MeshNormalMaterial();
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
            if (pass === 0) clear.setHex(CLEAR[s], THREE.SRGBColorSpace);
            else clear.setRGB(0.5, 0.5, 1, THREE.LinearSRGBColorSpace);
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
