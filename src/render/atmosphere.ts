/**
 * The atmosphere: sky, sun light + soft shadows, sky-lit environment map,
 * aerial-perspective fog on every material, cumulus clouds, cirrus, and the
 * data the output pass needs for the lens flare and in-cloud whiteout.
 *
 *   const atmo = createAtmosphere(renderer, scene);
 *   // per frame, before renderer.render(scene, camera):
 *   atmo.update(camera, dt, aircraftPosition);
 *   // key N:
 *   atmo.setTimeOfDay((atmo.timeOfDay + 1) % CONFIG.atmosphere.timeOfDay.length);
 *
 * Everything is derived from one physical sky model (atmosphereModel.ts), so
 * the sunlight colour, the sky, the haze on distant terrain, the environment
 * lighting and the cloud lighting always agree with each other.
 *
 * Clouds (config.render.cloudMode, URL ?clouds=volumetric|billboard|off):
 * 'volumetric' raymarches the cumulus field (volumetricClouds.ts) and falls
 * back to the instanced billboard puffs of the SAME field (clouds.ts) while
 * the noise volumes are still being generated (time-sliced, jobQueue.ts) and
 * whenever the budget controller (cloudBudget.ts) finds the pass over budget.
 * Both drift with the wind, and the cloud-shadow map (fog.ts chunk) is
 * rendered from the same density whenever the sun moves.
 * QA/profiling URL switches: ?clouds=…, ?cloudshadows=0, ?cloudres=0.35,
 * ?cloudbudget=0 (never fall back). Live: window.__render.clouds() (mode,
 * budget level, timer trust), window.__render.benchClouds() (renderer.ts).
 */
import * as THREE from 'three';
import { CONFIG } from '../config';
import { defaultAtmosphereParams, luminance, type AtmosphereParams } from './atmosphereModel';
import { computeAtmosphereState, type AtmosphereState } from './atmosphereState';
import { createClouds, type Clouds } from './clouds';
import { createEnvBaker } from './envmap';
import { ensureSceneFogUniforms, hazeColor, installAtmosphericFog, packCloudShadowUniforms, packFogUniforms } from './fog';
import { setAtmosphereFrameData, type AtmosphereFrameData, type CloudPassHook } from './frameData';
import { createJobQueue, type JobQueue } from './jobQueue';
import { createVolumetricClouds, type VolumetricClouds } from './volumetricClouds';
import { createCloudBudget, type CloudBudget, type CloudQuality } from './cloudBudget';
import { cloudColumnDensity, shadowOpacityAt, projectAlongSun } from './cloudWeather';
import { createSky } from './sky';
import { snapShadowCenter, sunDirectionFromAngles } from './sun';

export type CloudMode = 'volumetric' | 'billboard' | 'off';

/** Cloud mode from a URL query (?clouds=…), else the config. */
export function cloudModeFromQuery(search: string | undefined, fallback: CloudMode): CloudMode {
  const v = search ? new URLSearchParams(search).get('clouds') : null;
  return v === 'volumetric' || v === 'billboard' || v === 'off' ? v : fallback;
}

export interface AtmosphereOptions {
  /** Initial time-of-day preset index (default 0 = morning). */
  timeOfDay?: number;
  /** Cumulus clouds (default true). false = 'off'. */
  clouds?: boolean;
  /** Cloud renderer (default: URL ?clouds=, else config.render.cloudMode). */
  cloudMode?: CloudMode;
  /** Cloud shadows on materials (default config.atmosphere.cloudShadows.enabled, URL ?cloudshadows=0). */
  cloudShadows?: boolean;
  /** Cirrus wisps in the sky shader (default true). */
  cirrus?: boolean;
  /** Sun shadows (default true). */
  shadows?: boolean;
  /** Lens flare (default config.render.lensFlare.enabled). */
  flare?: boolean;
  /** Aerial perspective on materials (default true; false = no fog, for measuring its cost). */
  fog?: boolean;
  /** Terrain height, so clouds stay above mountains. */
  groundHeight?: (x: number, z: number) => number;
  seed?: number;
}

export interface Atmosphere {
  /** Unit vector toward the sun (world). Updated in place on time-of-day changes. */
  sunDirection: THREE.Vector3;
  sunLight: THREE.DirectionalLight;
  /** Per frame: shadow camera follow, clouds, fog uniforms, sky, altitude-dependent lighting. */
  update(camera: THREE.PerspectiveCamera, dt: number, focus: THREE.Vector3): void;
  setTimeOfDay(index: number): void;
  readonly timeOfDay: number;
  readonly timeOfDayName: string;
  /** The current CPU lighting state (sun/sky/haze/cloud colours). */
  readonly state: AtmosphereState;
  readonly clouds: Clouds | null;
  readonly volumetric: VolumetricClouds | null;
  /** What is drawing the clouds right now. */
  readonly cloudQuality: CloudQuality | 'off';
  /** 0..1 in-cloud density at the camera (smoothed). */
  readonly cloudImmersion: number;
  /** Background generation (noise volumes, weather map) still running. */
  readonly loading: boolean;
  /** Debug numbers (cloud mode, budget, env re-bakes, jobs). */
  stats(): Record<string, unknown>;
  dispose(): void;
}

export function createAtmosphere(renderer: THREE.WebGLRenderer, scene: THREE.Scene, opts: AtmosphereOptions = {}): Atmosphere {
  installAtmosphericFog();
  const ac = CONFIG.atmosphere;
  const presets = ac.timeOfDay;
  const params: AtmosphereParams = defaultAtmosphereParams();
  const fogOn = opts.fog ?? true;
  const reversed = renderer.state.buffers.depth.getReversed();

  // ── Sky ──────────────────────────────────────────────────────────────────
  const sky = createSky({
    cirrus: opts.cirrus === false ? { ...ac.cirrus, opacity: 0 } : ac.cirrus,
    sunAngularRadiusDeg: ac.sunAngularRadiusDeg,
  });
  scene.add(sky.mesh);
  scene.background = null;
  const env = createEnvBaker(renderer, sky.envMesh);
  const search = typeof location !== 'undefined' ? location.search : '';
  const query = new URLSearchParams(search);
  scene.environmentIntensity = ac.skyAmbientIntensity;

  // ── Fog (scene.fog makes three compile the fog chunks; values = fallback) ─
  const fog = new THREE.FogExp2(0xc0cad8, Math.sqrt(Math.LN2) / (ac.visibility * 0.4));
  scene.fog = fogOn ? fog : null;

  // ── Sun light + shadows ──────────────────────────────────────────────────
  const sunLight = new THREE.DirectionalLight(0xffffff, 3);
  sunLight.name = 'sun';
  const shadowsOn = opts.shadows ?? true;
  sunLight.castShadow = shadowsOn;
  const ext = ac.shadowExtent;
  const depthRange = ac.shadowDepthRange;
  sunLight.shadow.mapSize.set(ac.shadowMapSize, ac.shadowMapSize);
  const sc = sunLight.shadow.camera;
  sc.left = -ext;
  sc.right = ext;
  sc.top = ext;
  sc.bottom = -ext;
  sc.near = 1;
  sc.far = depthRange;
  sc.updateProjectionMatrix();
  sunLight.shadow.bias = (reversed ? 1 : -1) * (ac.shadowBias / (depthRange - 1));
  sunLight.shadow.normalBias = ac.shadowNormalBias;
  sunLight.shadow.radius = ac.shadowRadius;
  scene.add(sunLight);
  scene.add(sunLight.target);

  // ── Clouds ───────────────────────────────────────────────────────────────
  const cc = ac.clouds;
  const vc = cc.volumetric;
  const cloudMode: CloudMode = opts.clouds === false ? 'off' : (opts.cloudMode ?? cloudModeFromQuery(search, CONFIG.render.cloudMode));
  const seed = opts.seed ?? CONFIG.world.seed;
  const layout = {
    seed,
    count: cc.count,
    coverage: cc.coverage,
    baseAltitude: cc.baseAltitude,
    thickness: cc.thickness,
    areaRadius: cc.areaRadius,
    groundHeight: opts.groundHeight,
  };
  const clouds: Clouds | null = cloudMode === 'off' ? null : createClouds(layout);
  if (clouds) scene.add(clouds.mesh);
  const jobs: JobQueue = createJobQueue({ onError: (name, err) => console.warn(`[atmosphere] job ${name} failed`, err) });
  const field = clouds ? clouds.field : null;
  const baseMin = cc.baseAltitude - 150;
  const volumetric: VolumetricClouds | null =
    field && cloudMode !== 'off'
      ? createVolumetricClouds({
          field,
          seed,
          jobs,
          weatherSize: vc.weatherSize,
          baseMin,
          baseRange: Math.max(1600, (field.clouds.reduce((m, c) => Math.max(m, c.base), 0) - baseMin) * 1.02),
          maxThickness: cc.thickness + 50,
          resolution: Number(query.get('cloudres')) || CONFIG.render.cloudResolution,
          sigma: vc.sigma,
          maxDistance: vc.maxDistance,
          shapeErosion: vc.shapeErosion,
          detailErosion: vc.detailErosion,
          edgeSharpness: vc.edgeSharpness,
          detailPeriod: vc.detailPeriod,
          sideWarp: vc.sideWarp,
          sunScale: vc.sunScale,
          ambientScale: vc.ambientScale,
          temporalAlpha: vc.temporalAlpha,
          distanceSize: vc.distanceSize,
          detailDistance: vc.detailDistance,
          lighting: vc.lighting,
          shadowSize: ac.cloudShadows.size,
        })
      : null;
  const budget: CloudBudget = createCloudBudget({
    budgetMs: CONFIG.render.cloudBudgetMs,
    targetFps: CONFIG.render.targetFps,
    // ?cloudbudget=0 pins the volumetric renderer (QA / profiling)
    forced: cloudMode === 'billboard' ? 'billboard' : query.get('cloudbudget') === '0' ? 'volumetric' : undefined,
  });
  const baseResolution = volumetric ? volumetric.resolution : 1;
  const shadowsWanted = opts.cloudShadows ?? (query.get('cloudshadows') !== '0' && ac.cloudShadows.enabled);
  jobs.startIdleLoop(6);
  // The cloud pass as the renderer sees it (frameData.ts).
  let volumetricOn = false;
  const cloudHook: CloudPassHook | null = volumetric
    ? {
        get active() {
          return volumetricOn;
        },
        render: (r, depth, camera, w, h, pr, mode) => volumetric.render(r, depth, camera, w, h, pr, mode),
        get outputA() {
          return volumetric.outputA;
        },
        get outputB() {
          return volumetric.outputB;
        },
        size: volumetric.size,
        layerBottom: volumetric.layerBottom,
        layerTop: volumetric.layerTop,
        gpuMs: NaN,
        frameGpuMs: NaN,
        atMinQuality: false,
      }
    : null;

  // ── Shared per-frame data for the output pass ────────────────────────────
  const frame: AtmosphereFrameData = {
    sunDirection: new THREE.Vector3(0, 1, 0),
    sunColor: new THREE.Color(1, 1, 1),
    sunDiscLuminance: 1e4,
    sunAngularRadius: (ac.sunAngularRadiusDeg * Math.PI) / 180,
    immersion: 0,
    immersionColor: new THREE.Color(1, 1, 1),
    flare: opts.flare ?? CONFIG.render.lensFlare.enabled,
    clouds: cloudHook,
    whiteBalance: new THREE.Color(1, 1, 1),
  };
  setAtmosphereFrameData(scene, frame);

  const sunDirection = new THREE.Vector3(0, 1, 0);
  let tod = 0;
  let state: AtmosphereState = computeAtmosphereState(params, sunDirection, 2);
  let stateY = 2;
  let envY = -1e9;
  let envAge = 1e9;
  let envBakes = 0;
  let frameNo = 0;
  let windX = 0;
  let windZ = 0;
  let shadowSunX = NaN;
  let shadowSunY = NaN;
  let shadowSunZ = NaN;
  let shadowFocus = 0;
  let immersion = 0;
  let quality: CloudQuality | 'off' = cloudMode === 'off' ? 'off' : 'billboard';
  const q3 = { x: 0, y: 0, z: 0 };
  const cam = new THREE.Vector3();
  const snapped = new THREE.Vector3();
  const hz = { r: 0, g: 0, b: 0 };
  // ?ae=0: fixed exposure (config.atmosphere.exposure) and daylight white balance, for A/B comparisons
  const autoCamera = query.get('ae') !== '0';

  function applyState() {
    const s = state;
    s.fog.mode = fogOn ? 1 : -1;
    packFogUniforms(s.fog);
    // fallback fog colour = average horizon haze (only used if a material lacks the uniform)
    hazeColor({ x: -sunDirection.x, y: 0, z: -sunDirection.z }, s.cameraY, s.fog, hz);
    fog.color.setRGB(hz.r, hz.g, hz.b, THREE.LinearSRGBColorSpace);
    sky.setState({
      params,
      sunDir: sunDirection,
      cameraY: s.cameraY,
      cameraX: cam.x,
      cameraZ: cam.z,
      seaLevel: CONFIG.world.seaLevel,
      groundRadiance: s.groundRadiance,
      cirrusSun: s.cirrusSun,
      cirrusAmbient: s.cirrusAmbient,
    });
    sunLight.color.setRGB(s.lightColor.r, s.lightColor.g, s.lightColor.b, THREE.LinearSRGBColorSpace);
    sunLight.intensity = s.lightIntensity;
    // no direct light (and no shadows) once the sun is below the horizon
    sunLight.visible = sunDirection.y > -0.01;
    clouds?.setLighting({ sunDir: sunDirection, sun: s.cloud.sun, ambientTop: s.cloud.ambientTop, ambientBottom: s.cloud.ambientBottom });
    volumetric?.setLighting({ sunDir: sunDirection, sun: s.cloud.sun, ambientTop: s.cloud.ambientTop, ambientBottom: s.cloud.ambientBottom });
    frame.sunDirection.copy(sunDirection);
    frame.sunColor.setRGB(s.sunAtCamera.r, s.sunAtCamera.g, s.sunAtCamera.b, THREE.LinearSRGBColorSpace);
    frame.sunDiscLuminance = s.sunDiscLuminance;
    frame.immersionColor.setRGB(s.immersionColor.r, s.immersionColor.g, s.immersionColor.b, THREE.LinearSRGBColorSpace);
    // the camera: auto exposure + white balance for this light
    renderer.toneMappingExposure = autoCamera ? s.exposure : ac.exposure;
    if (autoCamera) frame.whiteBalance!.setRGB(s.whiteBalance.r, s.whiteBalance.g, s.whiteBalance.b, THREE.LinearSRGBColorSpace);
    else frame.whiteBalance!.setRGB(1, 1, 1, THREE.LinearSRGBColorSpace);
  }

  function bakeEnv() {
    scene.environment = env.bake();
    envY = state.cameraY;
    envAge = 0;
    envBakes++;
  }

  function recompute(cameraY: number) {
    state = computeAtmosphereState(params, sunDirection, cameraY, {}, state);
    stateY = cameraY;
    applyState();
  }

  function setTimeOfDay(index: number) {
    const n = presets.length;
    tod = ((Math.round(index) % n) + n) % n;
    const p = presets[tod];
    sunDirectionFromAngles(p.elevationDeg, p.azimuthDeg, sunDirection);
    volumetric?.resetHistory(); // the lighting jumps: don't blend the old one in
    recompute(stateY);
    bakeEnv();
  }

  function updateClouds(camera: THREE.PerspectiveCamera, dt: number) {
    // wind drift (clouds, their shadows and the billboard fallback move together)
    windX += cc.wind[0] * dt;
    windZ += cc.wind[1] * dt;
    if (field) {
      const t = field.tile;
      windX -= Math.floor(windX / t) * t;
      windZ -= Math.floor(windZ / t) * t;
    }
    clouds?.setWind(windX, windZ);
    volumetric?.setWind(windX, windZ);

    // which renderer draws the clouds
    let next: CloudQuality | 'off' = cloudMode === 'off' ? 'off' : 'billboard';
    if (volumetric && volumetric.ready && cloudMode === 'volumetric') {
      if (cloudHook) cloudHook.gpuMs = volumetricOn ? cloudHook.gpuMs : NaN;
      budget.update(dt, volumetricOn && cloudHook ? cloudHook.gpuMs : null, cloudHook?.atMinQuality ?? false, volumetricOn && cloudHook ? cloudHook.frameGpuMs : null);
      next = budget.quality;
      volumetric.resolution = next === 'volumetric-low' ? baseResolution * 0.7 : baseResolution;
    }
    if (next !== quality) {
      volumetric?.resetHistory();
      quality = next;
    }
    volumetricOn = quality === 'volumetric' || quality === 'volumetric-low';
    if (clouds) {
      clouds.mesh.visible = quality === 'billboard';
      if (clouds.mesh.visible) clouds.update(camera, dt);
    }

    // cloud shadows: re-render the shadow map when the sun moved
    if (volumetric && volumetric.ready && shadowsWanted && (sunDirection.x !== shadowSunX || sunDirection.y !== shadowSunY || sunDirection.z !== shadowSunZ)) {
      volumetric.renderShadowMap(renderer, sunDirection);
      shadowSunX = sunDirection.x;
      shadowSunY = sunDirection.y;
      shadowSunZ = sunDirection.z;
    }
    const shadowsOnNow = shadowsWanted && volumetric !== null && !Number.isNaN(shadowSunX);
    if (volumetric) packCloudShadowUniforms(shadowsOnNow ? ac.cloudShadows.strength : 0, volumetric.weather.baseMin, volumetric.weather.tile, windX, windZ);

    // in-cloud immersion: billboards use their own estimate; the volumetric march does its own whiteout
    let target = 0;
    if (quality === 'billboard' && clouds) target = clouds.immersion;
    else if (volumetric && volumetric.ready) target = cloudColumnDensity(volumetric.weather, cam.x, cam.y, cam.z, windX, windZ);
    immersion += (target - immersion) * (1 - Math.exp(-Math.max(0, dt) / 0.25));
    frame.immersion = quality === 'billboard' ? Math.min(1, immersion * 1.15) : 0;

    // the aircraft's shadow fades inside a cloud shadow (no direct sun there)
    if (volumetric && volumetric.ready && shadowsOnNow && sunLight.castShadow && ++shadowFocus % 8 === 0) {
      projectAlongSun(cam.x, Math.max(cam.y, 0), cam.z, sunDirection, volumetric.weather.baseMin, q3);
      const op = cam.y < volumetric.weather.baseMin + 600 ? shadowOpacityAt(volumetric.weather, q3.x, q3.z, sunDirection, windX, windZ, 32) : 0;
      sunLight.shadow.intensity += (1 - 0.85 * op - sunLight.shadow.intensity) * 0.5;
    }
  }

  function update(camera: THREE.PerspectiveCamera, dt: number, focus: THREE.Vector3) {
    frameNo++;
    envAge += dt;
    camera.getWorldPosition(cam);
    if (Math.abs(cam.y - stateY) > 25) recompute(cam.y);
    // background generation: a small slice every frame (the idle loop does the rest between frames)
    if (jobs.pending > 0) jobs.step(2);
    // altitude-driven environment re-bake, one slice per frame (no hitch)
    if (env.busy) {
      const tex = env.step();
      if (tex) {
        scene.environment = tex;
        envBakes++;
      }
    } else if (Math.abs(cam.y - envY) > ac.envRebakeAltitudeStep && envAge > 2) {
      env.beginBake();
      envY = cam.y;
      envAge = 0;
    }

    // sky follows the camera
    sky.uniforms.uCamY.value = cam.y;
    sky.uniforms.uCirrusOffset.value.x = cam.x;
    sky.uniforms.uCirrusOffset.value.y = cam.z;
    sky.tick(dt);

    // shadow frustum: centred on the focus, texel-snapped in light space
    if (shadowsOn) {
      snapShadowCenter(focus, sunDirection, ext, ac.shadowMapSize, snapped);
      sunLight.target.position.copy(snapped);
      sunLight.position.copy(snapped).addScaledVector(sunDirection, ac.shadowLightDistance);
      sunLight.target.updateMatrixWorld();
      sunLight.updateMatrixWorld();
    } else {
      sunLight.position.copy(focus).addScaledVector(sunDirection, 100);
      sunLight.target.position.copy(focus);
    }

    if (clouds || volumetric) updateClouds(camera, dt);

    // late-created ShaderMaterials without the shared fog uniform (see fog.ts)
    if (frameNo === 2 || frameNo % 120 === 0) ensureSceneFogUniforms(scene);
  }

  setTimeOfDay(opts.timeOfDay ?? 0);

  const api: Atmosphere = {
    sunDirection,
    sunLight,
    update,
    setTimeOfDay,
    get timeOfDay() {
      return tod;
    },
    get timeOfDayName() {
      return presets[tod].name;
    },
    get state() {
      return state;
    },
    clouds,
    volumetric,
    get cloudQuality() {
      return quality;
    },
    get cloudImmersion() {
      return immersion;
    },
    get loading() {
      return jobs.pending > 0;
    },
    stats() {
      return {
        cloudMode,
        cloudQuality: quality,
        cloudGpuMs: cloudHook ? Math.round(cloudHook.gpuMs * 100) / 100 : null,
        cloudTimerTrusted: budget.timerTrusted,
        cloudResolution: volumetric?.resolution ?? null,
        cloudBuffer: volumetric ? `${volumetric.size.x}x${volumetric.size.y}` : null,
        jobs: jobs.pending,
        job: jobs.current,
        envBakes,
        cloudShadows: shadowsWanted,
        immersion: Math.round(immersion * 100) / 100,
        exposure: Math.round(renderer.toneMappingExposure * 100) / 100,
      };
    },
    dispose() {
      jobs.dispose();
      volumetric?.dispose();
      scene.remove(sky.mesh);
      scene.remove(sunLight);
      scene.remove(sunLight.target);
      if (clouds) {
        scene.remove(clouds.mesh);
        clouds.dispose();
      }
      if (scene.fog === fog) scene.fog = null;
      if (scene.environment === env.texture) scene.environment = null;
      env.dispose();
      sky.dispose();
      sunLight.shadow.dispose();
      sunLight.dispose();
      delete scene.userData.__atmosphereFrame;
    },
  };
  // Live profiling hook: window.__render.clouds() (cloud mode, budget level, GPU ms, buffer size…)
  if (typeof window !== 'undefined') {
    const w = window as unknown as { __render?: Record<string, unknown> };
    w.__render = { ...(w.__render ?? {}), clouds: () => api.stats(), volumetric, cloudField: field, cloudWind: () => ({ x: windX, z: windZ }) };
  }
  return api;
}

/** Luminance helper re-exported for HUD/debug use. */
export { luminance };
