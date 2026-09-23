/**
 * The Maverick view: a picture-in-picture game camera on the locked target, with the look of the
 * Maverick's black-and-white "white-hot" IR video (it is a camera, not a sensor model — the
 * missiles are arcade). Drawn after the main render (the systems' `postRender` hook):
 *
 *   render()  at most `maxHz`: the scene from `camera` into a small HDR target of our own (so the
 *             app's screen pipeline — tone mapping, clouds, dynamic resolution — is untouched),
 *             with shadow-map updates, the scene's matrix update and the aircraft switched off;
 *   blit()    every frame: that picture into the bottom-right corner through the IR look —
 *             luminance with blue (sky, water) and green (vegetation) pushed cold, an auto
 *             gain/level from a few taps, white-hot glows on the vehicles' hulls and engine decks
 *             (`seekerHotSpots`, projected with the same camera when the picture was taken), sensor
 *             noise and a vignette. Viewport + scissor, no clear.
 *
 * Both restore every piece of renderer state they touch (render target, viewport, scissor,
 * scissor test, auto-clear, clear colour, shadow auto-update, the scene's matrix auto-update, the
 * hidden object's visibility), even if a render throws.
 */
import * as THREE from 'three';
import { CONFIG, type Config, type TargetClassConfig } from '../config';
import type { GroundTarget, TargetKind } from '../combat/types';
import { createScreenPt, projectPoint } from './weaponsHudMath';

/** Max hot spots (two per vehicle). */
export const MAX_HOT = 24;

const DEG = Math.PI / 180;
const sp = createScreenPt();
const fin = (x: number): boolean => typeof x === 'number' && Number.isFinite(x);

/**
 * White-hot spots for the vehicles in the picture: per vehicle a faint hull glow at the hull centre
 * and a hot engine deck at the rear (wrecks burn: hotter and bigger). Written as (u, v, radius, heat)
 * in picture units (u, v ∈ 0..1 from the bottom-left; radius as a fraction of the height).
 * Returns the number of spots.
 */
export function seekerHotSpots(
  out: Float32Array, view: ArrayLike<number>, proj: ArrayLike<number>, fovDeg: number,
  targets: readonly GroundTarget[], classOf: (k: TargetKind) => TargetClassConfig,
): number {
  let n = 0;
  const max = Math.min(MAX_HOT, Math.floor(out.length / 4));
  const tanHalf = Math.tan(Math.max(0.05, Math.min(170, fin(fovDeg) ? fovDeg : 5)) * DEG / 2);
  for (let i = 0; i < targets.length && n + 2 <= max; i++) {
    const t = targets[i];
    const cls = classOf(t.kind);
    if (!cls) continue;
    const px = t.position.x;
    const py = t.position.y;
    const pz = t.position.z;
    if (!(fin(px) && fin(py) && fin(pz))) continue;
    projectPoint(sp, px, py + cls.height / 2, pz, view, proj, 1, 1);
    if (!sp.inFront || sp.x < -0.25 || sp.x > 1.25 || sp.y < -0.25 || sp.y > 1.25) continue;
    const depth = Math.max(1, sp.depth);
    // Picture-height fraction per metre at that distance.
    const k = 1 / (2 * tanHalf * depth);
    const alive = t.alive;
    out[4 * n] = sp.x;
    out[4 * n + 1] = 1 - sp.y;
    out[4 * n + 2] = Math.max(0.006, cls.length * 0.5 * k);
    out[4 * n + 3] = alive ? 0.28 : 0.5;
    n++;
    // Engine deck: the rear third, near the top of the hull.
    const h = (fin(t.headingDeg) ? t.headingDeg : 0) * DEG;
    const back = cls.length * 0.3;
    projectPoint(sp, px - Math.sin(h) * back, py + cls.height * 0.75, pz + Math.cos(h) * back, view, proj, 1, 1);
    out[4 * n] = fin(sp.x) ? sp.x : out[4 * (n - 1)];
    out[4 * n + 1] = fin(sp.y) ? 1 - sp.y : out[4 * (n - 1) + 1];
    out[4 * n + 2] = Math.max(0.004, cls.length * (alive ? 0.2 : 0.34) * k);
    out[4 * n + 3] = alive ? 0.85 : 1.3;
    n++;
  }
  return n;
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tScene;
uniform vec4 uHot[${MAX_HOT}];
uniform int uHotCount;
uniform float uAspect;
uniform float uTime;
uniform float uNoise;
varying vec2 vUv;

// Scene colour (linear HDR) → a daytime long-wave IR guess: bright = warm, blue (sky, water) and
// green (vegetation) cooler.
float irLevel(vec3 c) {
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float m = max(max(c.r, c.g), c.b) + 1e-4;
  float blue = clamp((c.b - max(c.r, c.g)) / m * 2.5, 0.0, 1.0);
  float green = clamp((c.g - max(c.r, c.b)) / m * 3.0, 0.0, 1.0);
  float v = l / (l + 0.45);
  v *= 1.0 - 0.8 * blue;
  v *= 1.0 - 0.3 * green;
  return v;
}

void main() {
  float v = irLevel(texture2D(tScene, vUv).rgb);
  // Auto gain / level from a 3×3 grid of taps.
  float mean = 0.0;
  float lo = 1.0;
  float hi = 0.0;
  for (int i = 0; i < 3; i++) {
    for (int j = 0; j < 3; j++) {
      float s = irLevel(texture2D(tScene, vec2(0.2 + 0.3 * float(i), 0.2 + 0.3 * float(j))).rgb);
      mean += s;
      lo = min(lo, s);
      hi = max(hi, s);
    }
  }
  mean /= 9.0;
  float gain = clamp(0.55 / max(0.06, hi - lo), 1.0, 5.0);
  v = 0.4 + (v - mean) * gain;
  // White-hot vehicles.
  for (int k = 0; k < ${MAX_HOT}; k++) {
    if (k >= uHotCount) break;
    vec4 h = uHot[k];
    vec2 d = (vUv - h.xy) * vec2(uAspect, 1.0);
    float r = max(h.z, 0.002);
    v += h.w * exp(-dot(d, d) / (r * r));
  }
  // Sensor noise, faint scan lines, vignette.
  float n = fract(sin(dot(floor(gl_FragCoord.xy) + fract(uTime * 7.31) * 97.0, vec2(12.9898, 78.233))) * 43758.5453);
  v += (n - 0.5) * uNoise;
  v *= 0.97 + 0.03 * sin(gl_FragCoord.y * 1.9);
  vec2 q = vUv - 0.5;
  v *= 1.0 - dot(q, q) * 0.55;
  v = clamp(v, 0.0, 1.0);
  gl_FragColor = vec4(vec3(pow(v, 0.85)), 1.0);
}`;

export interface SeekerRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SeekerViewStats {
  renders: number;
  /** Smoothed CPU ms of a picture render, and GPU ms when a timer query is available (else −1). */
  cpuMs: number;
  gpuMs: number;
  width: number;
  height: number;
}

export interface SeekerView {
  /** The view camera: the caller poses it (position, up, lookAt, fov, aspect) before render(). */
  readonly camera: THREE.PerspectiveCamera;
  /** Hot spots for the next picture (see seekerHotSpots) and how many. */
  readonly hot: Float32Array;
  hotCount: number;
  /** A new picture is due at this time (≤ maxHz) — pose the camera and fill `hot` first. */
  isDue(time: number): boolean;
  /** Take a new picture if one is due (≤ maxHz). Returns true if it rendered. */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, hide: THREE.Object3D | null, time: number, rect: SeekerRect): boolean;
  /** Draw the latest picture into `rect` (CSS px from the canvas's top-left). Call every frame. */
  blit(renderer: THREE.WebGLRenderer, rect: SeekerRect): void;
  /** Force a new picture on the next render(). */
  invalidate(): void;
  /** Compile the IR shader ahead of time (one tiny off-screen draw), so the first picture doesn't hitch. */
  warmUp(renderer: THREE.WebGLRenderer): void;
  /** Brightness mean and spread of the IR picture (a 64×48 read-back; debug and tests). */
  probe(renderer: THREE.WebGLRenderer): { mean: number; std: number } | null;
  stats(): SeekerViewStats;
  dispose(): void;
}

type TimerExt = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number };

export function createSeekerView(cfg: Config = CONFIG): SeekerView {
  const sc = cfg.hud.weapons.seeker;
  const camera = new THREE.PerspectiveCamera(sc.wideFovDeg, 4 / 3, sc.near, sc.far);
  const depthTexture = new THREE.DepthTexture(1, 1, THREE.FloatType);
  depthTexture.format = THREE.DepthFormat;
  const target = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    depthBuffer: true,
    stencilBuffer: false,
    depthTexture,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
  target.texture.name = 'Maverick view';
  const hot = new Float32Array(MAX_HOT * 4);
  const hotUniform = new Float32Array(MAX_HOT * 4);
  const material = new THREE.ShaderMaterial({
    name: 'maverick-view-ir',
    uniforms: {
      tScene: { value: target.texture },
      uHot: { value: hotUniform },
      uHotCount: { value: 0 },
      uAspect: { value: 4 / 3 },
      uTime: { value: 0 },
      uNoise: { value: 0.045 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  let probeTarget: THREE.WebGLRenderTarget | null = null;

  let last = -Infinity;
  let hasPicture = false;
  let renders = 0;
  let cpuMs = 0;
  let gpuMs = -1;
  let timer: { gl: WebGL2RenderingContext; ext: TimerExt; pending: WebGLQuery | null } | null | undefined;

  // Saved renderer state (preallocated).
  const vp = new THREE.Vector4();
  const sc4 = new THREE.Vector4();
  const clear = new THREE.Color();
  const size = new THREE.Vector2();

  const initTimer = (renderer: THREE.WebGLRenderer) => {
    if (timer !== undefined) return;
    try {
      const gl = renderer.getContext() as WebGL2RenderingContext;
      const ext = gl?.getExtension?.('EXT_disjoint_timer_query_webgl2') as TimerExt | null;
      timer = ext && typeof gl.createQuery === 'function' ? { gl, ext, pending: null } : null;
    } catch {
      timer = null;
    }
  };
  const pollTimer = () => {
    if (!timer?.pending) return;
    const { gl, ext, pending } = timer;
    if (!gl.getQueryParameter(pending, gl.QUERY_RESULT_AVAILABLE)) return;
    if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) {
      const ms = (gl.getQueryParameter(pending, gl.QUERY_RESULT) as number) / 1e6;
      gpuMs = gpuMs < 0 ? ms : gpuMs + (ms - gpuMs) * 0.15;
    }
    gl.deleteQuery(pending);
    timer.pending = null;
  };

  const view: SeekerView = {
    camera,
    hot,
    hotCount: 0,

    isDue(time) {
      return !hasPicture || time < last || time - last >= 1 / Math.max(1, sc.maxHz) - 0.004;
    },

    render(renderer, scene, hide, time, rect) {
      if (!view.isDue(time)) return false;
      last = time;
      const pr = Math.min(Math.max(1, renderer.getPixelRatio?.() || 1), sc.maxPixelRatio);
      const w = Math.max(16, Math.round(rect.w * pr));
      const h = Math.max(12, Math.round(rect.h * pr));
      if (target.width !== w || target.height !== h) target.setSize(w, h);
      initTimer(renderer);
      pollTimer();

      const prevTarget = renderer.getRenderTarget();
      const prevAutoClear = renderer.autoClear;
      renderer.getClearColor(clear);
      const prevAlpha = renderer.getClearAlpha();
      const sm = renderer.shadowMap;
      const prevShadowAuto = sm.autoUpdate;
      const prevShadowNeeds = sm.needsUpdate;
      const prevSceneAuto = scene.matrixWorldAutoUpdate;
      const prevHide = hide ? hide.visible : true;
      const t0 = performance.now();
      let query: WebGLQuery | null = null;
      try {
        sm.autoUpdate = false;
        sm.needsUpdate = false;
        scene.matrixWorldAutoUpdate = false;
        if (hide) hide.visible = false;
        camera.updateMatrixWorld();
        renderer.setRenderTarget(target);
        renderer.autoClear = true;
        renderer.setClearColor(0x000000, 1);
        if (timer && !timer.pending) {
          query = timer.gl.createQuery();
          if (query) timer.gl.beginQuery(timer.ext.TIME_ELAPSED_EXT, query);
        }
        renderer.render(scene, camera);
      } finally {
        if (query && timer) {
          timer.gl.endQuery(timer.ext.TIME_ELAPSED_EXT);
          timer.pending = query;
        }
        renderer.setRenderTarget(prevTarget);
        renderer.autoClear = prevAutoClear;
        renderer.setClearColor(clear, prevAlpha);
        sm.autoUpdate = prevShadowAuto;
        sm.needsUpdate = prevShadowNeeds;
        scene.matrixWorldAutoUpdate = prevSceneAuto;
        if (hide) hide.visible = prevHide;
      }
      cpuMs = renders === 0 ? performance.now() - t0 : cpuMs + (performance.now() - t0 - cpuMs) * 0.1;
      renders++;
      hasPicture = true;
      // The glows belong to this picture.
      hotUniform.set(hot);
      material.uniforms.uHotCount.value = Math.max(0, Math.min(MAX_HOT, view.hotCount | 0));
      material.uniforms.uAspect.value = w / h;
      material.uniforms.uTime.value = time;
      return true;
    },

    blit(renderer, rect) {
      if (!hasPicture) return;
      renderer.getSize(size);
      const prevTarget = renderer.getRenderTarget();
      renderer.getViewport(vp);
      renderer.getScissor(sc4);
      const prevTest = renderer.getScissorTest();
      const prevAutoClear = renderer.autoClear;
      try {
        if (prevTarget !== null) renderer.setRenderTarget(null);
        const y = size.y - rect.y - rect.h;
        renderer.setViewport(rect.x, y, rect.w, rect.h);
        renderer.setScissor(rect.x, y, rect.w, rect.h);
        renderer.setScissorTest(true);
        renderer.autoClear = false;
        // A Mesh (not a Scene): three draws it straight to the canvas, outside the HDR pipeline.
        renderer.render(quad, quadCam);
      } finally {
        renderer.setViewport(vp.x, vp.y, vp.z, vp.w);
        renderer.setScissor(sc4.x, sc4.y, sc4.z, sc4.w);
        renderer.setScissorTest(prevTest);
        renderer.autoClear = prevAutoClear;
        if (prevTarget !== null) renderer.setRenderTarget(prevTarget);
      }
    },

    invalidate() {
      hasPicture = false;
      last = -Infinity;
    },

    warmUp(renderer) {
      const prevTarget = renderer.getRenderTarget();
      try {
        renderer.setRenderTarget(target);
        renderer.render(quad, quadCam);
      } catch {
        /* best effort */
      } finally {
        renderer.setRenderTarget(prevTarget);
      }
    },

    probe(renderer) {
      try {
        probeTarget ??= new THREE.WebGLRenderTarget(64, 48, { type: THREE.UnsignedByteType, depthBuffer: false, generateMipmaps: false });
        const prevTarget = renderer.getRenderTarget();
        const prevAutoClear = renderer.autoClear;
        const buf = new Uint8Array(64 * 48 * 4);
        try {
          renderer.setRenderTarget(probeTarget);
          renderer.autoClear = true;
          renderer.render(quad, quadCam);
          renderer.readRenderTargetPixels(probeTarget, 0, 0, 64, 48, buf);
        } finally {
          renderer.setRenderTarget(prevTarget);
          renderer.autoClear = prevAutoClear;
        }
        let s = 0;
        let s2 = 0;
        const n = 64 * 48;
        for (let i = 0; i < n; i++) {
          const v = buf[i * 4] / 255;
          s += v;
          s2 += v * v;
        }
        const mean = s / n;
        return { mean, std: Math.sqrt(Math.max(0, s2 / n - mean * mean)) };
      } catch {
        return null;
      }
    },

    stats: () => ({ renders, cpuMs: Math.round(cpuMs * 1000) / 1000, gpuMs: gpuMs < 0 ? -1 : Math.round(gpuMs * 1000) / 1000, width: target.width, height: target.height }),

    dispose() {
      target.dispose();
      depthTexture.dispose();
      probeTarget?.dispose();
      material.dispose();
      quad.geometry.dispose();
      if (timer?.pending) timer.gl.deleteQuery(timer.pending);
    },
  };
  return view;
}
