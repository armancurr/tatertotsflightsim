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
 * Volumetric clouds: when the atmosphere's frame data carries an active cloud
 * pass (frameData.ts), the MSAA depth is resolved too, the cloud pass marches
 * its low-resolution buffer against that depth right after the scene, and the
 * output pass composites it (post.ts). The scene, cloud and output passes are
 * timed on the GPU when EXT_disjoint_timer_query_webgl2 exists
 * (`handle.gpuTimings()`), which also feeds the cloud budget controller.
 *
 * Integration: `renderer.render(scene, camera)` is transparently routed
 * through that pipeline whenever it targets the screen (no render target set),
 * so app code keeps calling renderer.render; renders into explicit render
 * targets (PMREM, shadow maps, other passes) are untouched. `handle.render`
 * is the same thing, explicitly. Dynamic resolution (dynamicResolution.ts)
 * adjusts the pixel ratio from the measured frame interval, within the range of
 * the quality preset (quality.ts, ?quality=auto|low|medium|high): 'auto' starts
 * at a conservative resolution and climbs when there is headroom. A change of
 * devicePixelRatio (window dragged to another monitor, browser zoom) re-plans
 * the range.
 */
import * as THREE from 'three';
import { CONFIG } from '../config';
import { createDynamicResolution, type DynamicResolution } from './dynamicResolution';
import { bloomForQuality, createOutputPass, type OutputPass, type PostSettings } from './post';
import { getAtmosphereFrameData } from './frameData';
import { installFilmicNeutral } from './toneMapping';
import { createGpuTimer, type GpuTimer } from './gpuTimer';
import { msaaLadder, planQuality, qualityFromQuery, type QualityLevel, type QualityPlan } from './quality';
import { installLogDepthForShaderMaterials } from './logDepthPatch';

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

/**
 * Can EXT_disjoint_timer_query results be attributed to single passes on this
 * GPU? ANGLE's Metal backend (Chrome/Edge on macOS, Apple GPUs) times whole
 * command buffers: every pass reports roughly the frame ("clouds 10 ms" for a
 * pass that costs 0.5 ms synchronised), so the cloud budget must not use it.
 */
export function passTimingReliable(rendererString: string): boolean {
  return !/metal|apple/i.test(rendererString);
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
  /** Quality preset (default: ?quality=, else config.render.quality.default). */
  quality?: QualityLevel;
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
  /** Smoothed GPU ms per pass ('scene', 'clouds', 'post'); empty without a timer query extension. */
  gpuTimings(): Record<string, number>;
  /** Pixel ratio is at the dynamic-resolution minimum (nothing left to lower). */
  readonly atMinQuality: boolean;
  readonly gpuTimer: GpuTimer;
  /** The quality plan in force (re-planned when devicePixelRatio changes). */
  readonly quality: QualityPlan;
}

export function createRenderer(container: HTMLElement, opts: RendererOptions = {}): RendererHandle {
  const rc = CONFIG.render;
  // ?depth=log|standard forces the fallbacks Firefox and Safari get (no EXT_clip_control) — for QA in Chrome.
  const depthParam = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('depth') : null;
  const depthFromUrl: DepthMode | undefined = depthParam === 'log' || depthParam === 'logarithmic' ? 'logarithmic' : depthParam === 'standard' ? 'standard' : undefined;
  const depthMode = depthFromUrl ?? chooseDepthMode(probeClipControl(), opts.depth ?? 'reversed');
  // Custom ShaderMaterials must write the same logarithmic depth as three's built-ins (logDepthPatch.ts).
  if (depthMode === 'logarithmic') installLogDepthForShaderMaterials();
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
  const gl = renderer.getContext() as WebGL2RenderingContext;
  let rendererString = '';
  try {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    rendererString = String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');
  } catch {
    /* no debug info: assume reliable */
  }
  const qualityLevel = opts.quality ?? qualityFromQuery(typeof location !== 'undefined' ? location.search : '');
  const currentDpr = () => (typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1);
  const makePlan = () =>
    planQuality(qualityLevel, {
      devicePixelRatio: currentDpr(),
      cssWidth: container.clientWidth || (typeof innerWidth === 'number' ? innerWidth : 1440),
      cssHeight: container.clientHeight || (typeof innerHeight === 'number' ? innerHeight : 900),
      renderer: rendererString,
    });
  let plan = makePlan();
  let maxRatio = plan.maxPixelRatio;
  let minRatio = plan.minPixelRatio;
  let pixelRatio = plan.initialPixelRatio;
  // ?msaa=0|2|4 pins the MSAA (A/B measurements); so does opts.samples. Otherwise the 'auto' and
  // 'medium' presets let dynamic resolution step MSAA down before the image gets blurry.
  const url = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
  const msaaParam = url?.get('msaa');
  const fixedSamples = opts.samples ?? (msaaParam != null && msaaParam !== '' && Number.isFinite(Number(msaaParam)) ? Number(msaaParam) : undefined);
  const makeDyn = (initial: number): DynamicResolution =>
    createDynamicResolution({
      msaaLevels: fixedSamples === undefined ? msaaLadder(plan) : undefined,
      targetFps: rc.targetFps,
      minPixelRatio: minRatio,
      maxPixelRatio: maxRatio,
      initialPixelRatio: initial,
      rampUpDelay: plan.rampUpDelay,
      warmup: plan.warmup,
    });
  let dyn: DynamicResolution = makeDyn(pixelRatio);

  let target: THREE.WebGLRenderTarget | null = null;
  let output: OutputPass | null = null;
  if (hdr) {
    const depthTexture = new THREE.DepthTexture(1, 1, THREE.FloatType); // → DEPTH_COMPONENT32F
    depthTexture.format = THREE.DepthFormat;
    target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      samples: fixedSamples ?? plan.msaaSamples,
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
    bloom: bloomForQuality(plan),
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

  /** Re-create the HDR target's multisampled buffers with another sample count (the dynamic-resolution MSAA ladder). */
  function setSamples(n: number) {
    if (!target || fixedSamples !== undefined || !plan.msaaAdaptive || target.samples === n) return;
    target.samples = n;
    target.dispose(); // three re-allocates it (same texture objects) on the next setRenderTarget
  }

  function setQuality(pr: number) {
    const next = Math.min(maxRatio, Math.max(minRatio, pr));
    if (Math.abs(next - pixelRatio) < 1e-3) return;
    pixelRatio = next;
    resize();
  }

  const baseRender = renderer.render.bind(renderer);
  const timer = createGpuTimer(gl);
  // ?gpu=1: flush after every timed pass. ANGLE's Metal backend times whole command buffers, so
  // without a flush every pass in the same buffer reports roughly the whole frame (misleading).
  const exactTiming = typeof location !== 'undefined' && new URLSearchParams(location.search).get('gpu') === '1';
  const perPassTiming = passTimingReliable(rendererString);
  const endPass = () => {
    timer.end();
    if (exactTiming) gl.flush();
  };
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
    // ?dyn=0 pins the pixel ratio (A/B performance measurements at a fixed resolution)
    dynamicResolution: opts.dynamicResolution ?? (url?.get('dyn') === '0' ? false : rc.dynamicResolution),
    post,
    gpuTimings: () => timer.snapshot(),
    get atMinQuality() {
      // The cloud budget's "resolution can't help any more" signal: below config.render.minPixelRatio
      // (the old floor) the clouds may degrade too, while the resolution keeps dropping to the preset floor.
      return pixelRatio <= Math.max(minRatio, Math.min(rc.minPixelRatio, maxRatio)) + 1e-3;
    },
    gpuTimer: timer,
    get quality() {
      return plan;
    },
  };

  // Live profiling hooks (the game's window.sim has no handle on the renderer):
  //   window.__render.gpu()            smoothed GPU ms per pass (timer queries; ?gpu=1 for per-pass accuracy)
  //   window.__render.benchClouds(n)   GPU-synchronised ms of one cloud pass (re-runs it n times on the last frame)
  let probe: { rt: THREE.WebGLRenderTarget; mat: THREE.ShaderMaterial; scene: THREE.Scene; cam: THREE.Camera } | null = null;
  const createProbe = () => {
    const rt = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
    const mat = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null } },
      vertexShader: 'void main() { gl_Position = vec4( position.xy, 0.0, 1.0 ); }',
      fragmentShader: 'uniform sampler2D tSrc; void main() { gl_FragColor = texture2D( tSrc, vec2( 0.5 ) ) + 0.5; }',
      depthTest: false,
      depthWrite: false,
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    const m = new THREE.Mesh(g, mat);
    m.frustumCulled = false;
    const sc = new THREE.Scene();
    sc.add(m);
    return { rt, mat, scene: sc, cam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1) as THREE.Camera };
  };
  let lastScene: THREE.Scene | null = null;
  let lastCamera: THREE.Camera | null = null;
  const benchClouds = (n = 30): number => {
    const frame = lastScene ? getAtmosphereFrameData(lastScene) : undefined;
    const clouds = frame?.clouds;
    if (!clouds || !clouds.active || !target?.depthTexture || !lastCamera) return NaN;
    const px = new Uint8Array(4);
    // read back a pixel that depends on the cloud output → blocks until the GPU has finished the passes
    probe ??= createProbe();
    const sync = () => {
      probe!.mat.uniforms.tSrc.value = clouds.outputA;
      renderer.setRenderTarget(probe!.rt);
      baseRender(probe!.scene, probe!.cam);
      renderer.readRenderTargetPixels(probe!.rt, 0, 0, 1, 1, px);
      renderer.setRenderTarget(null);
    };
    const run = (k: number) => {
      sync();
      const t0 = performance.now();
      for (let i = 0; i < k; i++) clouds.render(renderer, target!.depthTexture!, lastCamera!, target!.width, target!.height, pixelRatio, depthMode);
      sync();
      return performance.now() - t0;
    };
    run(2);
    const a = run(1);
    const b = run(n + 1);
    return Math.round(((b - a) / n) * 1000) / 1000;
  };
  if (typeof window !== 'undefined') {
    const w = window as unknown as { __render?: Record<string, unknown> };
    w.__render = { ...(w.__render ?? {}), gpu: () => timer.snapshot(), gpuAvailable: timer.available, perPassTiming, pixelRatio: () => pixelRatio, msaa: () => (target ? target.samples : 0), quality: () => ({ ...plan }), benchClouds };
  }

  function renderPipeline(scene: THREE.Scene, camera: THREE.Camera) {
    const now = performance.now();
    if (lastFrame > 0 && handle.dynamicResolution) {
      const r = dyn.update((now - lastFrame) / 1000);
      if (r !== null) {
        setQuality(r);
        setSamples(dyn.msaa);
      }
    }
    lastFrame = now;
    if (!target || !output) {
      baseRender(scene, camera);
      return;
    }
    timer.poll();
    lastScene = scene;
    lastCamera = camera;
    const frame = getAtmosphereFrameData(scene);
    const clouds = frame?.clouds && frame.clouds.active ? frame.clouds : null;
    // the cloud march needs the scene depth: resolve it from the MSAA buffer only then
    target.resolveDepthBuffer = clouds !== null;
    renderer.info.reset();
    renderer.setRenderTarget(target);
    timer.begin('scene');
    baseRender(scene, camera);
    endPass();
    const depth = target.depthTexture;
    if (clouds && depth) {
      timer.begin('clouds');
      clouds.render(renderer, depth, camera, target.width, target.height, pixelRatio, depthMode);
      endPass();
      // (NaN = unknown → the budget controller's frame-rate rule; see passTimingReliable)
      clouds.gpuMs = perPassTiming ? timer.get('clouds') : NaN;
      clouds.frameGpuMs = perPassTiming ? timer.get('scene') + clouds.gpuMs + timer.get('post') : NaN;
    }
    if (frame?.clouds) frame.clouds.atMinQuality = handle.atMinQuality;
    renderer.setRenderTarget(null);
    output.update(frame, camera, post, clouds, depth, depthMode);
    timer.begin('post');
    baseRender(output.scene, output.camera);
    endPass();
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

  // devicePixelRatio changes (window moved to another monitor, browser zoom) fire no resize event
  // everywhere: watch a resolution media query for the current ratio and re-plan the range.
  let dprQuery: MediaQueryList | null = null;
  const onDprChange = () => {
    plan = makePlan();
    maxRatio = plan.maxPixelRatio;
    minRatio = plan.minPixelRatio;
    const keep = Math.min(maxRatio, Math.max(minRatio, pixelRatio));
    dyn = makeDyn(keep);
    setSamples(dyn.msaa);
    pixelRatio = -1; // force the resize below
    setQuality(keep);
    watchDpr();
  };
  const watchDpr = () => {
    dprQuery?.removeEventListener?.('change', onDprChange);
    dprQuery = null;
    if (typeof matchMedia !== 'function') return;
    try {
      dprQuery = matchMedia(`(resolution: ${currentDpr()}dppx)`);
      dprQuery.addEventListener?.('change', onDprChange);
    } catch {
      dprQuery = null;
    }
  };
  watchDpr();

  function dispose() {
    dprQuery?.removeEventListener?.('change', onDprChange);
    dprQuery = null;
    ro?.disconnect();
    timer.dispose();
    renderer.render = baseRender;
    target?.depthTexture?.dispose();
    target?.dispose();
    output?.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  }

  return handle;
}
