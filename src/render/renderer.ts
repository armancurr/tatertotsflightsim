/**
 * WebGL2 renderer with a high-precision HDR pipeline.
 *
 * Depth: the scene spans an 8 cm instrument panel to a 90 km horizon
 * (near/far ≈ 10⁶). With EXT_clip_control three.js uses a REVERSED depth
 * buffer (1 at near, 0 at far) and the scene is drawn into a render target
 * with a 32-bit FLOAT depth attachment — float precision is densest near 0,
 * i.e. far away, which gives near-uniform relative precision over the whole
 * range (a plain 24-bit buffer would resolve only ~20 m at 5 km, and z-fight
 * shorelines, roads and runways). Without the extension we fall back to a
 * logarithmic depth buffer (costs early-z, still no z-fighting).
 *
 * Colour: the scene renders linear HDR into that target (RGBA16F, 4× MSAA),
 * then a single output pass (post.ts) adds the lens flare / in-cloud
 * whiteout / vignette, tone maps ('filmic' = Filmic Neutral, toneMapping.ts,
 * or three's AgX / ACES / Neutral — config.render.toneMapping) and encodes sRGB to the canvas. Fog and the sky are therefore
 * composited in linear light, before tone mapping.
 *
 * Integration: `renderer.render(scene, camera)` is transparently routed
 * through that pipeline whenever it targets the screen (no render target set),
 * so app code keeps calling renderer.render; renders into explicit render
 * targets (PMREM, shadow maps, other passes) are untouched. `handle.render`
 * is the same thing, explicitly. Dynamic resolution (dynamicResolution.ts)
 * adjusts the pixel ratio from the measured frame interval.
 */
import * as THREE from 'three';
import { CONFIG } from '../config';
import { createDynamicResolution, type DynamicResolution } from './dynamicResolution';
import { createOutputPass, type OutputPass, type PostSettings } from './post';
import { getAtmosphereFrameData } from './frameData';
import { installFilmicNeutral } from './toneMapping';

export type DepthMode = 'reversed' | 'logarithmic' | 'standard';

/** Reversed depth needs EXT_clip_control; otherwise a logarithmic depth buffer. */
export function chooseDepthMode(hasClipControl: boolean, preferred: DepthMode = 'reversed'): DepthMode {
  if (preferred === 'standard') return 'standard';
  if (preferred === 'reversed' && hasClipControl) return 'reversed';
  return 'logarithmic';
}

export function toneMappingFromName(name: string): THREE.ToneMapping {
  switch (name) {
    case 'aces':
      return THREE.ACESFilmicToneMapping;
    case 'neutral':
      return THREE.NeutralToneMapping;
    case 'filmic':
      installFilmicNeutral();
      return THREE.CustomToneMapping;
    case 'none':
      return THREE.NoToneMapping;
    default:
      return THREE.AgXToneMapping;
  }
}

export function renderTargetSize(cssWidth: number, cssHeight: number, pixelRatio: number): { width: number; height: number } {
  return {
    width: Math.max(1, Math.floor(cssWidth * pixelRatio)),
    height: Math.max(1, Math.floor(cssHeight * pixelRatio)),
  };
}

function probeClipControl(): boolean {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return false;
    const ok = !!gl.getExtension('EXT_clip_control');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return ok;
  } catch {
    return false;
  }
}

export interface RendererOptions {
  /** Force a depth mode (default: reversed if supported, else logarithmic). */
  depth?: DepthMode;
  /** HDR target + output pass (default config.render.hdr). */
  hdr?: boolean;
  /** MSAA samples in the HDR target (default config.render.msaaSamples). */
  samples?: number;
  toneMapping?: string;
  dynamicResolution?: boolean;
}

export interface RendererHandle {
  renderer: THREE.WebGLRenderer;
  /** Re-read the container size (also runs automatically via ResizeObserver). */
  resize(): void;
  /** Set the render pixel ratio (clamped to config.render min/max). */
  setQuality(pixelRatio: number): void;
  dispose(): void;
  /** Render through the HDR pipeline (same as renderer.render with no target set). */
  render(scene: THREE.Scene, camera: THREE.Camera): void;
  readonly depthMode: DepthMode;
  readonly hdr: boolean;
  readonly pixelRatio: number;
  /** Let the frame rate drive the pixel ratio. */
  dynamicResolution: boolean;
  /** Output-pass settings (flare, vignette, grade), live-editable. */
  post: PostSettings;
}

export function createRenderer(container: HTMLElement, opts: RendererOptions = {}): RendererHandle {
  const rc = CONFIG.render;
  const depthMode = chooseDepthMode(probeClipControl(), opts.depth ?? 'reversed');
  const wantHdr = opts.hdr ?? rc.hdr;
  const renderer = new THREE.WebGLRenderer({
    antialias: !wantHdr && rc.antialias,
    powerPreference: 'high-performance',
    stencil: false,
    alpha: false,
    reversedDepthBuffer: depthMode === 'reversed',
    logarithmicDepthBuffer: depthMode === 'logarithmic',
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = toneMappingFromName(opts.toneMapping ?? rc.toneMapping);
  renderer.toneMappingExposure = CONFIG.atmosphere.exposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.setClearColor(0x000000, 1);
  renderer.domElement.style.display = 'block';
  container.appendChild(renderer.domElement);

  const hdr = wantHdr && renderer.extensions.has('EXT_color_buffer_float');
  const maxRatio = Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, rc.maxPixelRatio);
  let pixelRatio = maxRatio;
  const dyn: DynamicResolution = createDynamicResolution({
    targetFps: rc.targetFps,
    minPixelRatio: Math.min(rc.minPixelRatio, maxRatio),
    maxPixelRatio: maxRatio,
  });

  let target: THREE.WebGLRenderTarget | null = null;
  let output: OutputPass | null = null;
  if (hdr) {
    const depthTexture = new THREE.DepthTexture(1, 1, THREE.FloatType); // → DEPTH_COMPONENT32F
    depthTexture.format = THREE.DepthFormat;
    target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      samples: opts.samples ?? rc.msaaSamples,
      depthBuffer: true,
      stencilBuffer: false,
      depthTexture,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    target.resolveDepthBuffer = false;
    target.texture.name = 'HDR scene';
    output = createOutputPass();
  }

  const post: PostSettings = {
    vignette: rc.vignette,
    saturation: rc.saturation,
    flare: rc.lensFlare.enabled,
    flareGlare: rc.lensFlare.glare,
    flareGhosts: rc.lensFlare.ghosts,
    flareStarburst: rc.lensFlare.starburst,
    dither: true,
  };

  function resize() {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(w, h, true);
    if (target && output) {
      const s = renderTargetSize(w, h, pixelRatio);
      target.setSize(s.width, s.height);
      output.setInput(target.texture, s.width, s.height);
    }
  }

  function setQuality(pr: number) {
    const next = Math.min(maxRatio, Math.max(Math.min(rc.minPixelRatio, maxRatio), pr));
    if (Math.abs(next - pixelRatio) < 1e-3) return;
    pixelRatio = next;
    resize();
  }

  const baseRender = renderer.render.bind(renderer);
  let lastFrame = 0;
  const handle: RendererHandle = {
    renderer,
    resize,
    setQuality,
    dispose,
    render: renderPipeline,
    depthMode,
    hdr,
    get pixelRatio() {
      return pixelRatio;
    },
    dynamicResolution: opts.dynamicResolution ?? rc.dynamicResolution,
    post,
  };

  function renderPipeline(scene: THREE.Scene, camera: THREE.Camera) {
    const now = performance.now();
    if (lastFrame > 0 && handle.dynamicResolution) {
      const r = dyn.update((now - lastFrame) / 1000);
      if (r !== null) setQuality(r);
    }
    lastFrame = now;
    if (!target || !output) {
      baseRender(scene, camera);
      return;
    }
    renderer.info.reset();
    renderer.setRenderTarget(target);
    baseRender(scene, camera);
    renderer.setRenderTarget(null);
    output.update(getAtmosphereFrameData(scene), camera, post);
    baseRender(output.scene, output.camera);
  }

  if (hdr) {
    renderer.info.autoReset = false;
    renderer.render = (scene: THREE.Object3D, camera: THREE.Camera) => {
      if (renderer.getRenderTarget() === null && !renderer.xr.isPresenting && (scene as THREE.Scene).isScene) {
        renderPipeline(scene as THREE.Scene, camera);
      } else {
        baseRender(scene, camera);
      }
    };
  }

  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resize()) : null;
  ro?.observe(container);
  resize();

  function dispose() {
    ro?.disconnect();
    renderer.render = baseRender;
    target?.depthTexture?.dispose();
    target?.dispose();
    output?.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  }

  return handle;
}
