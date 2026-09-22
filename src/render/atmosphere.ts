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
 */
import * as THREE from 'three';
import { CONFIG } from '../config';
import { defaultAtmosphereParams, luminance, type AtmosphereParams } from './atmosphereModel';
import { computeAtmosphereState, type AtmosphereState } from './atmosphereState';
import { createClouds, type Clouds } from './clouds';
import { createEnvBaker } from './envmap';
import { ensureSceneFogUniforms, hazeColor, installAtmosphericFog, packFogUniforms } from './fog';
import { setAtmosphereFrameData, type AtmosphereFrameData } from './frameData';
import { createSky } from './sky';
import { snapShadowCenter, sunDirectionFromAngles } from './sun';

export interface AtmosphereOptions {
  /** Initial time-of-day preset index (default 0 = morning). */
  timeOfDay?: number;
  /** Cumulus clouds (default true). */
  clouds?: boolean;
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
  /** 0..1 in-cloud density at the camera (smoothed). */
  readonly cloudImmersion: number;
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
  const clouds: Clouds | null =
    opts.clouds === false
      ? null
      : createClouds({
          seed: opts.seed ?? CONFIG.world.seed,
          ...ac.clouds,
          groundHeight: opts.groundHeight,
        });
  if (clouds) scene.add(clouds.mesh);

  // ── Shared per-frame data for the output pass ────────────────────────────
  const frame: AtmosphereFrameData = {
    sunDirection: new THREE.Vector3(0, 1, 0),
    sunColor: new THREE.Color(1, 1, 1),
    sunDiscLuminance: 1e4,
    sunAngularRadius: (ac.sunAngularRadiusDeg * Math.PI) / 180,
    immersion: 0,
    immersionColor: new THREE.Color(1, 1, 1),
    flare: opts.flare ?? CONFIG.render.lensFlare.enabled,
  };
  setAtmosphereFrameData(scene, frame);

  const sunDirection = new THREE.Vector3(0, 1, 0);
  let tod = 0;
  let state: AtmosphereState = computeAtmosphereState(params, sunDirection, 2);
  let stateY = 2;
  let envY = -1e9;
  let envAge = 1e9;
  let frameNo = 0;
  const cam = new THREE.Vector3();
  const snapped = new THREE.Vector3();
  const hz = { r: 0, g: 0, b: 0 };

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
    frame.sunDirection.copy(sunDirection);
    frame.sunColor.setRGB(s.sunAtCamera.r, s.sunAtCamera.g, s.sunAtCamera.b, THREE.LinearSRGBColorSpace);
    frame.sunDiscLuminance = s.sunDiscLuminance;
    frame.immersionColor.setRGB(s.immersionColor.r, s.immersionColor.g, s.immersionColor.b, THREE.LinearSRGBColorSpace);
  }

  function bakeEnv() {
    scene.environment = env.bake();
    envY = state.cameraY;
    envAge = 0;
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
    recompute(stateY);
    bakeEnv();
  }

  function update(camera: THREE.PerspectiveCamera, dt: number, focus: THREE.Vector3) {
    frameNo++;
    envAge += dt;
    camera.getWorldPosition(cam);
    if (Math.abs(cam.y - stateY) > 25) recompute(cam.y);
    if (Math.abs(cam.y - envY) > ac.envRebakeAltitudeStep && envAge > 2) bakeEnv();

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

    if (clouds) {
      clouds.update(camera, dt);
      frame.immersion = Math.min(1, clouds.immersion * 1.15);
    }

    // late-created ShaderMaterials without the shared fog uniform (see fog.ts)
    if (frameNo === 2 || frameNo % 120 === 0) ensureSceneFogUniforms(scene);
  }

  setTimeOfDay(opts.timeOfDay ?? 0);

  return {
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
    get cloudImmersion() {
      return frame.immersion;
    },
    dispose() {
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
}

/** Luminance helper re-exported for HUD/debug use. */
export { luminance };
