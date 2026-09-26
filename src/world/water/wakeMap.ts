/**
 * The wake map: a world-aligned half-float render target that follows the player's boat (its
 * corner snapped to whole texels, so it never swims), redrawn every frame from the hull's track
 * strip (wakeField.ts `buildWakeStrip`) with the wake-field shader (`WAKE_FIELD_GLSL`):
 * R = wake wave height (m, signed, additive), G = foam density, B = aeration (churn), A = slick.
 * Cleared to zero each frame: the strip carries the whole age history (the foam is a function of
 * where and when the hull passed, so it stays put on the water, spreads and decays). The frame's
 * extent follows the hull's size (wakeField.ts `wakeMapExtent`: 520 m for boats, kilometres for
 * ships); the resolution is fixed per map (1024, 512 on the low quality preset).
 *
 * A second render target (MRT) holds the track's direction of travel (x, z, weighted by the strip's
 * feathering — it adds up where strips overlap) and the white water's freshness: the sea shader
 * streaks its foam along the track and makes fresh wash seethe.
 *
 * The sea material samples it through `WAKE_MAP_UNIFORMS` (a module singleton shared with
 * material.ts: one texture and one transform, `uWakeXf.w` = 0 when there is no wake, and the sea
 * shader skips it). Drawn without a camera: the vertex shader maps world x, z straight to clip space.
 */
import * as THREE from 'three';
import { WAKE_FIELD_GLSL, STRIP_ACROSS, STRIP_MAX, wakeFoamCell, wakeStripIndices, type WakeMapFrame, type WakeStrip } from './wakeField';

export interface WakeMapUniforms {
  uWakeMap: { value: THREE.Texture };
  /** The second target: track direction (x, z, weighted), freshness, −. */
  uWakeAux: { value: THREE.Texture };
  /** x0, z0 (world corner), 1 / extent, active (0/1). */
  uWakeXf: { value: THREE.Vector4 };
  /** Texel size (m), 1 / resolution. */
  uWakeTexel: { value: THREE.Vector2 };
  /** The sea shader's foam cell size (m) for this hull (wakeField.ts wakeFoamCell). */
  uWakeCell: { value: number };
}

const blank = new THREE.DataTexture(new Uint16Array(4), 1, 1, THREE.RGBAFormat, THREE.HalfFloatType);
blank.needsUpdate = true;

/** Shared with the sea material (material.ts): the one wake map in the world. */
export const WAKE_MAP_UNIFORMS: WakeMapUniforms = {
  uWakeMap: { value: blank },
  uWakeAux: { value: blank },
  uWakeXf: { value: new THREE.Vector4(0, 0, 1, 0) },
  uWakeTexel: { value: new THREE.Vector2(1, 1) },
  uWakeCell: { value: 1.3 },
};

export interface WakeMapOptions {
  /** Texels per side and world extent (m). */
  res?: number;
  extent?: number;
}

export interface WakeMap {
  readonly target: THREE.WebGLRenderTarget;
  readonly res: number;
  readonly extent: number;
  /**
   * Uploads the strip and renders the map at `frame`. `travelled` = the hull's distance travelled
   * now; L, B the hull's length and beam.
   */
  render(renderer: THREE.WebGLRenderer, strip: WakeStrip, frame: WakeMapFrame, travelled: number, L: number, B: number): void;
  /** No wake: the sea stops sampling the map. */
  hide(): void;
  dispose(): void;
}

export function createWakeMap(opts: WakeMapOptions = {}): WakeMap {
  const res = opts.res ?? 1024;
  const extent = opts.extent ?? 520;
  const target = new THREE.WebGLRenderTarget(res, res, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    count: 2,
  });
  target.textures[0].name = 'wake-map';
  target.textures[1].name = 'wake-map-aux';

  const nv = STRIP_MAX * STRIP_ACROSS;
  const geo = new THREE.BufferGeometry();
  const aXZ = new THREE.BufferAttribute(new Float32Array(nv * 2), 2).setUsage(THREE.DynamicDrawUsage);
  const aTrack = new THREE.BufferAttribute(new Float32Array(nv * 4), 4).setUsage(THREE.DynamicDrawUsage);
  const aExtra = new THREE.BufferAttribute(new Float32Array(nv * 4), 4).setUsage(THREE.DynamicDrawUsage);
  const aDir = new THREE.BufferAttribute(new Float32Array(nv * 2), 2).setUsage(THREE.DynamicDrawUsage);
  // three needs a position attribute to size the draw; the shader ignores it
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
  geo.setAttribute('aXZ', aXZ);
  geo.setAttribute('aTrack', aTrack);
  geo.setAttribute('aExtra', aExtra);
  geo.setAttribute('aDir', aDir);
  const attrs = [[aXZ, 2], [aTrack, 4], [aExtra, 4], [aDir, 2]] as const;
  geo.setIndex(new THREE.BufferAttribute(wakeStripIndices(), 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);

  const uniforms = {
    uXf: { value: new THREE.Vector3(0, 0, 1 / extent) },
    uTrav: { value: 0 },
    uHull: { value: new THREE.Vector3(14, 4, 1) }, // L, B, kMax
  };
  const mat = new THREE.RawShaderMaterial({
    name: 'wake-field',
    glslVersion: THREE.GLSL3,
    uniforms,
    vertexShader: /* glsl */ `
      precision highp float;
      in vec2 aXZ;
      in vec4 aTrack;
      in vec4 aExtra;
      in vec2 aDir;
      uniform vec3 uXf;
      out vec4 wkTrack;
      out vec4 wkExtra;
      out vec2 wkDir;
      void main() {
        wkTrack = aTrack;
        wkExtra = aExtra;
        wkDir = aDir;
        vec2 uv = ( aXZ - uXf.xy ) * uXf.z;
        gl_Position = vec4( uv * 2.0 - 1.0, 0.0, 1.0 );
      }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      in vec4 wkTrack;
      in vec4 wkExtra;
      in vec2 wkDir;
      uniform float uTrav;
      uniform vec3 uHull;
      layout( location = 0 ) out vec4 fragColor;
      layout( location = 1 ) out vec4 fragAux;
      ${WAKE_FIELD_GLSL}
      void main() {
        float L = uHull.x;
        float B = uHull.y;
        float s = wkTrack.x;
        float x = uTrav - s + 0.5 * L;
        vec4 w = wakeField( x, wkTrack.y, s, max( wkTrack.w, 0.0 ), wkTrack.z, wkExtra.x, max( wkExtra.y, 1.0 ), L, B, uHull.z, wkExtra.z );
        // (NaN/Inf never reach the map)
        fragColor = ( w == w && abs( w.x ) < 50.0 ) ? w : vec4( 0.0 );
        vec4 a = wakeAux( wkDir, wkTrack.y, max( wkExtra.y, 1.0 ), wkTrack.z, L, B );
        fragAux = a == a ? a : vec4( 0.0 );
      }`,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneFactor,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const prevClear = new THREE.Color();

  return {
    target,
    res,
    extent,
    render(renderer, strip, frame, travelled, L, B) {
      const n = strip.count * STRIP_ACROSS;
      if (strip.count < 2) {
        this.hide();
        return;
      }
      (aXZ.array as Float32Array).set(strip.xz.subarray(0, n * 2));
      (aTrack.array as Float32Array).set(strip.track.subarray(0, n * 4));
      (aExtra.array as Float32Array).set(strip.extra.subarray(0, n * 4));
      (aDir.array as Float32Array).set(strip.dir.subarray(0, n * 2));
      for (const [a, k] of attrs) {
        a.clearUpdateRanges();
        a.addUpdateRange(0, n * k);
        a.needsUpdate = true;
      }
      geo.setDrawRange(0, (strip.count - 1) * (STRIP_ACROSS - 1) * 6);
      uniforms.uXf.value.set(frame.x0, frame.z0, 1 / frame.extent);
      uniforms.uTrav.value = travelled;
      // resolve waves down to ~4 texels
      uniforms.uHull.value.set(L, B, (2 * Math.PI) / (4 * frame.texel));
      const prevTarget = renderer.getRenderTarget();
      const prevAlpha = renderer.getClearAlpha();
      renderer.getClearColor(prevClear);
      const prevAuto = renderer.autoClear;
      renderer.setRenderTarget(target);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, false, false);
      renderer.autoClear = false;
      renderer.render(scene, cam);
      renderer.autoClear = prevAuto;
      renderer.setClearColor(prevClear, prevAlpha);
      renderer.setRenderTarget(prevTarget);
      WAKE_MAP_UNIFORMS.uWakeMap.value = target.textures[0];
      WAKE_MAP_UNIFORMS.uWakeAux.value = target.textures[1];
      WAKE_MAP_UNIFORMS.uWakeXf.value.set(frame.x0, frame.z0, 1 / frame.extent, 1);
      WAKE_MAP_UNIFORMS.uWakeTexel.value.set(frame.texel, 1 / frame.res);
      WAKE_MAP_UNIFORMS.uWakeCell.value = wakeFoamCell(L, B);
    },
    hide() {
      WAKE_MAP_UNIFORMS.uWakeXf.value.w = 0;
    },
    dispose() {
      this.hide();
      WAKE_MAP_UNIFORMS.uWakeMap.value = blank;
      WAKE_MAP_UNIFORMS.uWakeAux.value = blank;
      target.dispose();
      geo.dispose();
      mat.dispose();
    },
  };
}
