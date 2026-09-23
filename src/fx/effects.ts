/**
 * three.js adapter for the effects simulation (sim.ts): ONE sorted, instanced draw call for all
 * smoke/dust/fire/sparks (premultiplied-alpha blending unifies additive fire and alpha smoke, so fire
 * seen through smoke and smoke in front of fire both composite correctly), an InstancedMesh of
 * tumbling debris, and a flickering point light at the fire. Buffers are preallocated; update()
 * allocates nothing.
 *
 * Every particle looks different and moves: the shader derives a mirror flip, a noise-space offset
 * and an animation rate from the particle's seed (shading.ts `variation`) and scrolls a tiling
 * 4-channel noise texture (sprites.ts) through it —
 *   puffs    (tiles 0–3) boil and fray with age (noise-distorted, eroded), are lit like volumes by
 *            the sun (sprite normals, 2-tap self-shadow, darker thick core, forward scattering) and
 *            glow orange from below near a fire; hot puffs (fireballs) are a rolling temperature
 *            field (hot core, mottled by the noise) that cools patch by patch into soot;
 *   flames   (tiles 4–7) are tongue envelopes animated by upward-scrolling domain-warped noise that
 *            breaks them into licks, oriented along their (wind-leaning, buoyant) velocity and
 *            stretched tall (per-particle aspect), hottest low in the core, sooty at the tips;
 *   sparks   (SPARK_TILE) are procedural motion-blurred streaks along their screen velocity.
 * Far flames/sparks never vanish sub-pixel (energy-conserving minimum size). Particles fade near
 * the ground (analytic soft particles against the terrain height under them), near the camera and
 * when they would cover too much of the screen, and haze with the scene fog (fog chunks included,
 * so the atmospheric fog override applies too).
 */
import * as THREE from 'three';
import { CONFIG } from '../config';
import type { SurfaceType } from '../types';
import { FxSim } from './sim';
import { particleAlpha, particleHeat, particleSize, type ParticlePool } from './pool';
import { createSortScratch, sortBackToFront } from './sort';
import { generateNoiseTexture, generateParticleAtlas } from './sprites';
import { FIRE_GLSL } from './shading';

const FX = CONFIG.fx;
const FIRE_LIGHT = new THREE.Color(0xff8a3a);
const FLASH_LIGHT = new THREE.Color(0xffd9a8);
/** The animation clock wraps (seconds) to keep float precision in the shader. */
const TIME_WRAP = 3600;

export interface EffectsOptions {
  /** Terrain/water height for debris bounce and ground fades (default: just below the event). */
  groundHeight?: (x: number, z: number) => number;
  seed?: number;
  /** Sprite atlas tile size in px (default 128). */
  atlasSize?: number;
}

export interface Effects {
  /** Fireball + debris + rising, drifting smoke column (~20 s). velocity = aircraft velocity (m/s); water = ditching. */
  crash(position: THREE.Vector3, speedKt: number, opts?: { velocity?: THREE.Vector3; water?: boolean }): void;
  /** Tyre smoke at the mains (position = aircraft CG; orientation places the wheels; surface picks smoke/dust/spray). */
  touchdown(position: THREE.Vector3, fpm: number, opts?: { orientation?: THREE.Quaternion; velocity?: THREE.Vector3; surface?: SurfaceType }): void;
  /** Per frame (after camera.updateMatrixWorld()). dt = 0 while paused. wind in world m/s. */
  update(camera: THREE.PerspectiveCamera, dt: number, wind?: THREE.Vector3): void;
  /** Sun direction (world, toward the sun), sun radiance and sky ambient for smoke lighting. */
  setSun(direction: THREE.Vector3, color?: THREE.Color, ambient?: THREE.Color): void;
  reset(): void;
  dispose(): void;
  readonly object: THREE.Group;
  readonly sim: FxSim;
  stats(): { smoke: number; fire: number; debris: number; drawn: number; fireLevel: number; flashLevel: number; emitters: number };
}

const VERT = /* glsl */ `
attribute vec4 iPos;    // xyz, diameter
attribute vec4 iParams; // rotation, opacity, heat, tile
attribute vec4 iColor;  // albedo, fire glow at the particle
attribute vec4 iExtra;  // ground height under it, seed, age / life, aspect (width / height)
attribute vec4 iVel;    // velocity (m/s)
uniform vec3 uSunView;
uniform float uNearFade;
uniform float uMaxCover;
uniform float uViewportH;
uniform float uMinPx;
uniform float uShutter;
varying vec2 vQ;
varying vec4 vVar;
varying vec3 vLight;
varying vec2 vUpS;
varying vec4 vColor;
varying vec4 vFx;
varying vec2 vGround;
varying float vPhase;
varying float vStreak;
#include <fog_pars_vertex>
${FIRE_GLSL}
void main() {
  float size = iPos.w;
  float tile = iParams.w;
  float kind = tile < 3.5 ? 0.0 : (tile < 7.5 ? 1.0 : 2.0); // puff, flame, spark
  vec4 va = variation(iExtra.y);
  vec4 mvPosition = viewMatrix * vec4(iPos.xyz, 1.0);
  float depth = -mvPosition.z;
  float p11 = projectionMatrix[1][1];
  // Energy-conserving minimum size: far flames and sparks stay visible as points.
  float px = size * p11 * 0.5 * uViewportH / max(depth, 0.05);
  float grow = pixelScale(px, uMinPx);
  size *= grow;
  // Fade sprites the camera is inside of, and any that would cover too much of the screen.
  float fade = iParams.y / (grow * grow) * smoothstep(0.1 * size * uNearFade, size * uNearFade, depth) * coverFade(size, depth, p11, uMaxCover);
  vec3 upV = mat3(viewMatrix) * vec3(0.0, 1.0, 0.0);
  vec2 corner = position.xy;
  vec2 k = corner;
  float rot = iParams.x;
  float streak = 1.0;
  if (kind > 1.5) {
    // Spark: a streak along its screen-space motion during the exposure.
    vec3 vv = mat3(viewMatrix) * iVel.xyz;
    float len = length(vv.xy) * uShutter;
    vec2 ax = length(vv.xy) > 1e-4 ? normalize(vv.xy) : vec2(0.0, 1.0);
    rot = atan(-ax.x, ax.y);
    streak = 1.0 + len / max(size, 1e-3);
    k.y *= streak;
  } else if (kind > 0.5) {
    // Flame: stands on its base along its buoyant, wind-leaning velocity; tall when seen from the side.
    vec3 axisW = normalize(vec3(iVel.x * 0.35, max(iVel.y, 0.0) * 0.25 + 1.0, iVel.z * 0.35));
    vec3 axisV = mat3(viewMatrix) * axisW;
    float l = length(axisV.xy);
    rot = (l > 1e-3 ? atan(-axisV.x, axisV.y) : iParams.x) + iParams.x;
    float side = smoothstep(0.2, 0.75, l);
    float asp = clamp(iExtra.w, 0.1, 10.0);
    float tall = mix(1.0, inversesqrt(asp), side) * (1.0 + 0.05 * side * max(iVel.y, 0.0));
    float wide = mix(1.0, sqrt(asp), side);
    k = vec2(corner.x * wide, corner.y * tall + 0.3 * tall * side);
  }
  float c = cos(rot);
  float s = sin(rot);
  vec2 off = vec2(c * k.x - s * k.y, s * k.x + c * k.y) * size;
  mvPosition.xy += off;
  gl_Position = projectionMatrix * mvPosition;
  if (fade < 0.003) gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // nothing to draw: no fill cost
  vQ = vec2(corner.x, corner.y);
  vVar = vec4(va.z, va.w, variationRate(iExtra.y), clamp(iExtra.z, 0.0, 1.0));
  vLight = vec3(c * uSunView.x + s * uSunView.y, -s * uSunView.x + c * uSunView.y, uSunView.z);
  vUpS = vec2(c * upV.x + s * upV.y, -s * upV.x + c * upV.y);
  // Forward scattering (Henyey-Greenstein, g = 0.6): thin smoke glows when it is between the eye and the sun.
  float cosT = dot(normalize(mvPosition.xyz), uSunView);
  vPhase = 0.64 / pow(1.36 - 1.2 * cosT, 1.5);
  vColor = iColor;
  vec3 worldOff = (vec4(off, 0.0, 0.0) * viewMatrix).xyz;
  vGround = vec2(iPos.y + worldOff.y - iExtra.x, 1.0 / max(0.05, 0.25 * size));
  vFx = vec4(fade, iParams.z, kind, tile + (va.x < 0.0 ? 16.0 : 0.0));
  vStreak = streak;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uAtlas;
uniform sampler2D uNoise;
uniform float uTime;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uGlowColor;
uniform float uGlowFloor;
uniform float uFireIntensity;
uniform float uFireOcclusion;
uniform float uSparkIntensity;
uniform float uSelfShadow;
varying vec2 vQ;
varying vec4 vVar;
varying vec3 vLight;
varying vec2 vUpS;
varying vec4 vColor;
varying vec4 vFx;
varying vec2 vGround;
varying float vPhase;
varying float vStreak;
#include <fog_pars_fragment>
${FIRE_GLSL}
vec3 finishColor(vec3 c) {
  #ifdef TONE_MAPPING
    c = toneMapping(c);
  #endif
  return linearToOutputTexel(vec4(c, 1.0)).rgb;
}
vec2 tileUv(float tile, vec2 q) {
  q = clamp(q, -0.5, 0.5);
  return (vec2(mod(tile, 4.0), floor(tile / 4.0)) + q + 0.5) / vec2(4.0, 2.0);
}
void main() {
  float kind = vFx.z;
  float heat = vFx.y;
  float flip = vFx.w >= 16.0 ? -1.0 : 1.0;
  float tile = vFx.w - (flip < 0.0 ? 16.0 : 0.0);
  float groundFade = clamp(vGround.x * vGround.y, 0.0, 1.0);
  float base = vFx.x * groundFade;
  if (base < 0.002) discard;
  float a;
  float T = 0.0;
  float occ = 1.0;
  float emisK = uFireIntensity;
  vec3 lit = vec3(0.0);
  if (kind > 1.5) {
    // Spark / ember: a hot capsule stretched along its motion; the light is spread over the streak.
    vec2 p = vec2(vQ.x, vQ.y * vStreak);
    p.y = max(abs(p.y) - 0.5 * (vStreak - 1.0), 0.0);
    float d2 = dot(p, p) * 4.0;
    a = exp(-5.0 * d2) * smoothstep(1.0, 0.6, d2) * base * inversesqrt(vStreak);
    if (a < 0.002) discard;
    T = heat;
    occ = 0.0;
    emisK = uFireIntensity * uSparkIntensity;
  } else if (kind > 0.5) {
    // Flame tongue: the envelope flutters and splits into licks as noise scrolls up through it.
    vec2 q = vec2(vQ.x * flip, vQ.y);
    float h = vQ.y + 0.5;
    float tt = uTime * vVar.z;
    vec2 nq = vec2(q.x * 0.7, q.y * 0.45 - tt * 0.9) + vVar.xy;
    vec4 n1 = texture2D(uNoise, nq);
    vec4 n2 = texture2D(uNoise, nq * 2.3 + (n1.rg - 0.5) * 0.3 + vec2(0.37, 0.61 - tt * 0.5));
    vec2 d = vec2((n1.r - 0.5) * 0.38 + (n2.g - 0.5) * 0.14, (n1.g - 0.5) * 0.1) * (0.25 + h);
    vec4 env = texture2D(uAtlas, tileUv(tile, q + d));
    float brk = smoothstep(0.0, 0.35, n2.b * 0.8 + n1.a * 0.4 + (1.0 - h) * 0.75 - 0.45);
    a = env.a * brk * base;
    if (a < 0.002) discard;
    T = flameTemperature(heat, env.b + (n2.r - 0.5) * 0.3, h);
    // Soot shows at the tips; the sides stay a translucent red glow (no dark outline).
    occ = mix(0.2 + 0.6 * h, uFireOcclusion, smoothstep(0.3, 0.9, T));
    lit = vColor.rgb * uAmbient;
  } else {
    // Puff: boils (noise-distorted) and frays with age; lit like a volume.
    vec2 q = vec2(vQ.x * flip, vQ.y);
    float age = vVar.w;
    float hot = smoothstep(0.02, 0.3, heat);
    float tt = uTime * vVar.z * mix(0.05, 0.35, hot);
    vec4 n = texture2D(uNoise, q * 0.6 + vVar.xy + vec2(tt * 0.6, -tt));
    vec2 uq = q + (n.rg - 0.5) * (0.08 + 0.08 * age + 0.12 * hot);
    vec4 tex = texture2D(uAtlas, tileUv(tile, uq));
    float dens = smokeErosion(tex.a, n.b * 0.6 + n.a * 0.4, age);
    a = dens * base;
    if (a < 0.002) discard;
    vec3 nrm = vec3((tex.rg * 2.0 - 1.0) * vec2(flip, 1.0), 0.0);
    nrm.z = sqrt(max(0.0, 1.0 - dot(nrm.xy, nrm.xy)));
    vec3 L = normalize(vLight);
    float diff = clamp(dot(nrm, L) * 0.6 + 0.4, 0.0, 1.0);
    // Self-shadow: puff density one step toward the sun, plus the thick core when the sun is behind it.
    float toward = texture2D(uAtlas, tileUv(tile, uq + vec2(L.x * flip, L.y) * 0.22)).a;
    float sh = mix(1.0, selfShadow(toward + tex.b * max(-L.z, 0.0)), uSelfShadow);
    float phase = mix(1.0, clamp(vPhase, 0.25, 4.0), (1.0 - tex.a) * 0.75);
    float ao = mix(1.0, 0.6, tex.b * tex.a);
    vec3 albedo = vColor.rgb;
    // Fire light from below: the underside of the smoke glows.
    float below = clamp(0.55 - 0.5 * dot(nrm.xy, vUpS), 0.15, 1.0);
    lit = albedo * (uAmbient * ao + uSunColor * diff * sh * phase) + max(albedo, vec3(uGlowFloor)) * uGlowColor * vColor.a * below;
    if (heat > 0.004) {
      // Rolling fireball: hot thick core mottled by the noise; cool patches go to soot first. The glow
      // needs optical depth: thin edges are dark soot, not a translucent orange haze.
      T = fireballTemperature(heat, tex.b, n.a * 0.55 + n.b * 0.45) * smoothstep(0.08, 0.55, dens);
      occ = mix(1.0, uFireOcclusion, smoothstep(0.3, 0.9, T));
    }
  }
  vec3 emis = T > 0.0 ? fireRamp(T) * emisK : vec3(0.0);
  float aOcc = a * occ;
  gl_FragColor = vec4(0.0);
  {
    #include <fog_fragment>
  }
  vec3 fogIns = gl_FragColor.rgb;
  gl_FragColor = vec4(1.0);
  {
    #include <fog_fragment>
  }
  vec3 fogT = gl_FragColor.rgb - fogIns;
  vec3 col = (finishColor(lit) * fogT + fogIns) * aOcc + finishColor(emis) * fogT * a;
  gl_FragColor = vec4(col, aOcc);
}
`;

interface RgbLike {
  r: number;
  g: number;
  b: number;
}

/**
 * Smoke lighting from the atmosphere, in the same units three's lit materials use: the sun as
 * radiance per unit albedo (colour × intensity / π, like a Lambert surface facing the sun) and an
 * ambient from the sky dome plus a little sunlit-ground bounce (a puff is lit from all around).
 */
export function smokeLighting(sunColor: RgbLike, sunIntensity: number, skyIrradiance: RgbLike, groundRadiance: RgbLike, outSun: THREE.Color, outAmbient: THREE.Color): void {
  const k = Number.isFinite(sunIntensity) ? Math.max(0, sunIntensity) / Math.PI : 0;
  const f = (v: number) => (Number.isFinite(v) ? Math.max(0, v) : 0);
  outSun.setRGB(f(sunColor.r) * k, f(sunColor.g) * k, f(sunColor.b) * k);
  const amb = (sky: number, ground: number) => (0.8 * f(sky)) / Math.PI + 0.25 * f(ground);
  outAmbient.setRGB(amb(skyIrradiance.r, groundRadiance.r), amb(skyIrradiance.g, groundRadiance.g), amb(skyIrradiance.b, groundRadiance.b));
}

function debrisGeometry(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 0.06, 0.65, 3, 1, 2);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    p.setY(i, p.getY(i) + 0.12 * Math.sin(x * 7.1 + z * 3.3) + 0.08 * Math.cos(z * 9.7));
  }
  g.computeVertexNormals();
  return g;
}

export function createEffects(scene: THREE.Scene, opts: EffectsOptions = {}): Effects {
  const sim = new FxSim(opts.seed ?? FX.seed);
  const cap = sim.smoke.capacity + sim.fire.capacity;
  const group = new THREE.Group();
  group.name = 'fx';

  // ── Particles ─────────────────────────────────────────────────────────────
  const atlasData = generateParticleAtlas(opts.atlasSize ?? 128, (opts.seed ?? FX.seed) & 0xffff);
  const atlas = new THREE.DataTexture(atlasData.data, atlasData.width, atlasData.height, THREE.RGBAFormat);
  atlas.generateMipmaps = true;
  atlas.minFilter = THREE.LinearMipmapLinearFilter;
  atlas.magFilter = THREE.LinearFilter;
  atlas.needsUpdate = true;
  const noiseData = generateNoiseTexture(FX.noiseSize, ((opts.seed ?? FX.seed) + 7) & 0xffff);
  const noise = new THREE.DataTexture(noiseData.data, noiseData.width, noiseData.height, THREE.RGBAFormat);
  noise.wrapS = noise.wrapT = THREE.RepeatWrapping;
  noise.generateMipmaps = true;
  noise.minFilter = THREE.LinearMipmapLinearFilter;
  noise.magFilter = THREE.LinearFilter;
  noise.needsUpdate = true;

  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const attr = (n: number) => {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * n), n);
    a.setUsage(THREE.DynamicDrawUsage);
    return a;
  };
  const iPos = attr(4), iParams = attr(4), iColor = attr(4), iExtra = attr(4), iVel = attr(4);
  const instAttrs = [iPos, iParams, iColor, iExtra, iVel];
  geo.setAttribute('iPos', iPos);
  geo.setAttribute('iParams', iParams);
  geo.setAttribute('iColor', iColor);
  geo.setAttribute('iExtra', iExtra);
  geo.setAttribute('iVel', iVel);
  geo.instanceCount = 0;

  const sunDir = new THREE.Vector3(0.45, 0.75, 0.35).normalize();
  const uniforms: Record<string, THREE.IUniform> = {
    ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    uAtlas: { value: atlas },
    uNoise: { value: noise },
    uTime: { value: 0 },
    uSunView: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(1.0, 0.96, 0.9) },
    uAmbient: { value: new THREE.Color(0.32, 0.37, 0.46) },
    uGlowColor: { value: new THREE.Color(...FX.smokeGlow) },
    uGlowFloor: { value: FX.glowFloor },
    uFireIntensity: { value: FX.fireIntensity },
    uFireOcclusion: { value: FX.fireOcclusion },
    uSparkIntensity: { value: FX.sparkIntensity },
    uSelfShadow: { value: FX.selfShadow },
    uNearFade: { value: FX.nearFade },
    uMaxCover: { value: FX.maxScreenCover },
    uViewportH: { value: 900 },
    uMinPx: { value: FX.minPixels },
    uShutter: { value: FX.shutter },
  };
  // keep the shared atmospheric-fog array by reference (see render/fog.ts)
  const fogLib = THREE.UniformsLib.fog as Record<string, THREE.IUniform>;
  if (fogLib.atmoFog) uniforms.atmoFog = { value: fogLib.atmoFog.value };
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, depthTest: true, fog: true });
  mat.blending = THREE.CustomBlending;
  mat.blendEquation = THREE.AddEquation;
  mat.blendSrc = THREE.OneFactor;
  mat.blendDst = THREE.OneMinusSrcAlphaFactor;
  mat.blendSrcAlpha = THREE.OneFactor;
  mat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'fx-particles';
  mesh.frustumCulled = false;
  mesh.visible = false;
  const viewport = new THREE.Vector4();
  mesh.onBeforeRender = (renderer) => {
    renderer.getCurrentViewport(viewport);
    if (viewport.w > 0) mat.uniforms.uViewportH.value = viewport.w;
  };
  group.add(mesh);

  // ── Debris ────────────────────────────────────────────────────────────────
  const dGeo = debrisGeometry();
  const dMat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.45 });
  const debris = new THREE.InstancedMesh(dGeo, dMat, sim.debris.capacity);
  debris.name = 'fx-debris';
  debris.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const col = new THREE.Color();
  for (let i = 0; i < sim.debris.capacity; i++) debris.setColorAt(i, col.setRGB(1, 1, 1));
  debris.count = 0;
  debris.frustumCulled = false;
  debris.castShadow = true;
  group.add(debris);

  // ── Fire light ────────────────────────────────────────────────────────────
  let light: THREE.PointLight | null = null;
  if (FX.fireLight) {
    light = new THREE.PointLight(0xff8a3a, 0, FX.fireLightDistance, 2);
    light.name = 'fx-fire-light';
    group.add(light);
  }
  scene.add(group);

  // ── Scratch (no per-frame allocation) ─────────────────────────────────────
  const depth = new Float32Array(cap);
  const ref = new Int32Array(cap);
  const order = new Int32Array(cap);
  const scratch = createSortScratch(cap);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const v3 = new THREE.Vector3();
  const s3 = new THREE.Vector3();
  const axis = new THREE.Vector3();
  const wheelL = new THREE.Vector3();
  const wheelR = new THREE.Vector3();
  const wheels = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }];
  const geom = CONFIG.aircraft.geometry;
  let disposed = false;
  let drawn = 0;
  let clock = 0;

  const groundAt = (x: number, z: number, fallback: number) => {
    if (!opts.groundHeight) return fallback;
    const g = opts.groundHeight(x, z);
    return Number.isFinite(g) ? g : fallback;
  };

  const writeInstance = (slot: number, p: ParticlePool, i: number) => {
    const o = slot * 4;
    const pos = iPos.array as Float32Array, par = iParams.array as Float32Array, colr = iColor.array as Float32Array;
    const t = p.age[i] / p.life[i];
    const light = 1 + p.lighten[i] * t;
    pos[o] = p.px[i]; pos[o + 1] = p.py[i]; pos[o + 2] = p.pz[i]; pos[o + 3] = particleSize(p, i);
    par[o] = p.rot[i]; par[o + 1] = particleAlpha(p, i); par[o + 2] = particleHeat(p, i); par[o + 3] = p.tile[i];
    colr[o] = Math.min(1, p.r[i] * light); colr[o + 1] = Math.min(1, p.g[i] * light); colr[o + 2] = Math.min(1, p.b[i] * light);
    colr[o + 3] = sim.glowAt(p.px[i], p.py[i], p.pz[i]);
    const ex = iExtra.array as Float32Array, vel = iVel.array as Float32Array;
    ex[o] = Math.max(-1e6, p.groundY[i]); ex[o + 1] = p.seed[i]; ex[o + 2] = Math.min(1, Math.max(0, t)); ex[o + 3] = p.aspect[i];
    vel[o] = p.vx[i]; vel[o + 1] = p.vy[i]; vel[o + 2] = p.vz[i]; vel[o + 3] = 0;
  };

  return {
    object: group,
    sim,
    crash(position, speedKt, o = {}) {
      if (disposed) return;
      const v = o.velocity;
      const g = groundAt(position.x, position.z, position.y - 1);
      sim.crash(position.x, position.y, position.z, speedKt, v ? v.x : 0, v ? v.y : 0, v ? v.z : 0, g, !!o.water);
    },
    touchdown(position, fpm, o = {}) {
      if (disposed) return;
      wheelL.set(geom.leftMainWheel.x, geom.leftMainWheel.y, geom.leftMainWheel.z);
      wheelR.set(geom.rightMainWheel.x, geom.rightMainWheel.y, geom.rightMainWheel.z);
      if (o.orientation) {
        q.copy(o.orientation);
        if (!Number.isFinite(q.x + q.y + q.z + q.w) || q.lengthSq() < 1e-8) q.identity();
        q.normalize();
        wheelL.applyQuaternion(q);
        wheelR.applyQuaternion(q);
      }
      wheelL.add(position);
      wheelR.add(position);
      wheels[0].x = wheelL.x; wheels[0].y = wheelL.y; wheels[0].z = wheelL.z;
      wheels[1].x = wheelR.x; wheels[1].y = wheelR.y; wheels[1].z = wheelR.z;
      const g = groundAt(position.x, position.z, Math.min(wheelL.y, wheelR.y));
      const v = o.velocity;
      sim.touchdown(wheels, g, fpm, v ? v.x : 0, v ? v.y : 0, v ? v.z : 0, o.surface ?? 'runway');
    },
    update(camera, dtIn, wind) {
      if (disposed) return;
      const dt = Number.isFinite(dtIn) && dtIn > 0 ? Math.min(dtIn, 0.25) : 0;
      if (dt > 0) {
        sim.step(dt, wind ? wind.x : 0, wind ? wind.y : 0, wind ? wind.z : 0);
        clock = (clock + dt) % TIME_WRAP;
        mat.uniforms.uTime.value = clock;
      }

      // Gather visible particles with their view depth.
      const e = camera.matrixWorld.elements;
      const cx = e[12], cy = e[13], cz = e[14];
      const fx = -e[8], fy = -e[9], fz = -e[10];
      let n = 0;
      let sx = 0, sy = 0, sz = 0;
      const pools = [sim.smoke, sim.fire];
      for (let pi = 0; pi < 2; pi++) {
        const p = pools[pi];
        for (let i = 0; i < p.capacity; i++) {
          if (!p.alive[i]) continue;
          const d = (p.px[i] - cx) * fx + (p.py[i] - cy) * fy + (p.pz[i] - cz) * fz;
          const size = particleSize(p, i);
          if (!(d > -size) || particleAlpha(p, i) < 0.003) continue;
          depth[n] = d;
          ref[n] = pi === 0 ? i : -1 - i;
          n++;
          sx += p.px[i]; sy += p.py[i]; sz += p.pz[i];
        }
      }
      sortBackToFront(depth, n, order, scratch);
      for (let k = 0; k < n; k++) {
        const r = ref[order[k]];
        if (r >= 0) writeInstance(k, sim.smoke, r);
        else writeInstance(k, sim.fire, -1 - r);
      }
      drawn = n;
      geo.instanceCount = n;
      mesh.visible = n > 0;
      if (n > 0) {
        mesh.position.set(sx / n, sy / n, sz / n); // for three's transparent-object sort only
        for (let ai = 0; ai < instAttrs.length; ai++) {
          const a = instAttrs[ai];
          a.clearUpdateRanges();
          a.addUpdateRange(0, n * 4);
          a.needsUpdate = true;
        }
      }
      (mat.uniforms.uSunView.value as THREE.Vector3).copy(sunDir).transformDirection(camera.matrixWorldInverse);

      // Debris.
      const d = sim.debris;
      let m = 0;
      for (let i = 0; i < d.capacity; i++) {
        if (!d.alive[i]) continue;
        const sd = d.seed[i];
        axis.set(Math.sin(sd * 91.7), Math.cos(sd * 47.3), Math.sin(sd * 13.1 + 1)).normalize();
        q.setFromAxisAngle(axis, d.rot[i]);
        const sc = particleSize(d, i);
        v3.set(d.px[i], d.py[i] + 0.04 * sc, d.pz[i]);
        s3.set(sc, sc, sc);
        m4.compose(v3, q, s3);
        debris.setMatrixAt(m, m4);
        const burn = Math.min(1, particleHeat(d, i) * 3);
        debris.setColorAt(m, col.setRGB(d.r[i] * (1 - 0.8 * burn), d.g[i] * (1 - 0.8 * burn), d.b[i] * (1 - 0.8 * burn)));
        m++;
      }
      debris.count = m;
      if (m > 0) {
        debris.instanceMatrix.needsUpdate = true;
        if (debris.instanceColor) debris.instanceColor.needsUpdate = true;
      }

      // Fire light (and the white-hot flash of an explosion through the same light: no extra light, no recompiles).
      if (light) {
        const fireI = FX.fireLightIntensity * sim.fireLevel;
        const flashI = FX.flashLightIntensity * sim.flashLevel;
        light.intensity = fireI + flashI;
        const p = flashI > fireI ? sim.flashPos : sim.firePos;
        light.position.set(p.x, p.y, p.z);
        light.color.copy(FIRE_LIGHT).lerp(FLASH_LIGHT, flashI / Math.max(1e-6, fireI + flashI));
      }
    },
    setSun(direction, color, ambient) {
      if (Number.isFinite(direction.x + direction.y + direction.z) && direction.lengthSq() > 1e-12) sunDir.copy(direction).normalize();
      if (color) (mat.uniforms.uSunColor.value as THREE.Color).copy(color);
      if (ambient) (mat.uniforms.uAmbient.value as THREE.Color).copy(ambient);
    },
    reset() {
      sim.reset();
      geo.instanceCount = 0;
      mesh.visible = false;
      debris.count = 0;
      drawn = 0;
      if (light) light.intensity = 0;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      group.removeFromParent();
      geo.dispose();
      mat.dispose();
      atlas.dispose();
      noise.dispose();
      dGeo.dispose();
      dMat.dispose();
      debris.dispose();
      light?.dispose();
    },
    stats() {
      return { smoke: sim.smoke.count, fire: sim.fire.count, debris: sim.debris.count, drawn, fireLevel: sim.fireLevel, flashLevel: sim.flashLevel, emitters: sim.activeEmitters() };
    },
  };
}
