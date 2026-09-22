/**
 * three.js adapter for the effects simulation (sim.ts): ONE sorted, instanced draw call for all
 * smoke/dust/fire (premultiplied-alpha blending unifies additive fire and alpha smoke, so fire
 * seen through smoke and smoke in front of fire both composite correctly), an InstancedMesh of
 * tumbling debris, and a flickering point light at the fire. Buffers are preallocated; update()
 * allocates nothing. Particles are lit with sprite-space normals (sun side bright), glow orange
 * near the fire, fade near the ground/camera, and haze with the scene fog (fog chunks included,
 * so the atmospheric fog override applies too).
 */
import * as THREE from 'three';
import { CONFIG } from '../config';
import type { SurfaceType } from '../types';
import { FxSim } from './sim';
import { particleAlpha, particleHeat, particleSize, type ParticlePool } from './pool';
import { createSortScratch, sortBackToFront } from './sort';
import { generateParticleAtlas } from './sprites';
import { FIRE_GLSL } from './shading';

const FX = CONFIG.fx;

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
  stats(): { smoke: number; fire: number; debris: number; drawn: number; fireLevel: number };
}

const VERT = /* glsl */ `
attribute vec4 iPos;
attribute vec4 iParams;
attribute vec4 iColor;
attribute float iGround;
uniform vec3 uSunView;
uniform float uNearFade;
uniform float uMaxCover;
varying vec2 vUv;
varying vec3 vLight;
varying vec4 vColor;
varying vec3 vFx;
varying vec2 vGround;
varying float vPhase;
#include <fog_pars_vertex>
${FIRE_GLSL}
void main() {
  float size = iPos.w;
  float tile = iParams.w;
  float isFlame = step(3.5, tile);
  vec4 mvPosition = viewMatrix * vec4(iPos.xyz, 1.0);
  float depth = -mvPosition.z;
  // Fade sprites the camera is inside of, and any that would cover too much of the screen.
  float fade = iParams.y * smoothstep(0.1 * size * uNearFade, size * uNearFade, depth) * coverFade(size, depth, projectionMatrix[1][1], uMaxCover);
  vec3 upV = mat3(viewMatrix) * vec3(0.0, 1.0, 0.0);
  float rot = mix(iParams.x, atan(-upV.x, upV.y) + iParams.x * 0.3, isFlame);
  float c = cos(rot);
  float s = sin(rot);
  vec2 corner = position.xy;
  // Flame licks are taller than wide and stand on their base.
  vec2 k = corner * vec2(1.0, mix(1.0, 1.5, isFlame)) + vec2(0.0, 0.25 * isFlame);
  vec2 off = vec2(c * k.x - s * k.y, s * k.x + c * k.y) * size;
  mvPosition.xy += off;
  gl_Position = projectionMatrix * mvPosition;
  if (fade < 0.003) gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // nothing to draw: no fill cost
  vUv = (vec2(mod(tile, 4.0), floor(tile / 4.0)) + corner + 0.5) / vec2(4.0, 2.0);
  vLight = vec3(c * uSunView.x + s * uSunView.y, -s * uSunView.x + c * uSunView.y, uSunView.z);
  // Forward scattering (Henyey-Greenstein, g = 0.6): thin smoke glows when it is between the eye and the sun.
  float cosT = dot(normalize(mvPosition.xyz), uSunView);
  vPhase = 0.64 / pow(1.36 - 1.2 * cosT, 1.5);
  vColor = iColor;
  vec3 worldOff = (vec4(off, 0.0, 0.0) * viewMatrix).xyz;
  vGround = vec2(iPos.y + worldOff.y - iGround, 1.0 / max(0.05, 0.25 * size));
  vFx = vec3(fade, iParams.z, isFlame);
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uAtlas;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uGlowColor;
uniform float uFireIntensity;
uniform float uFireOcclusion;
varying vec2 vUv;
varying vec3 vLight;
varying vec4 vColor;
varying vec3 vFx;
varying vec2 vGround;
varying float vPhase;
#include <fog_pars_fragment>
${FIRE_GLSL}
vec3 finishColor(vec3 c) {
  #ifdef TONE_MAPPING
    c = toneMapping(c);
  #endif
  return linearToOutputTexel(vec4(c, 1.0)).rgb;
}
void main() {
  vec4 tex = texture2D(uAtlas, vUv);
  float groundFade = clamp(vGround.x * vGround.y, 0.0, 1.0);
  float a = tex.a * vFx.x * groundFade;
  if (a < 0.002) discard;
  // Smoke: lit like a volume by the sun (sprite-space normals) and the sky, with forward scattering at thin edges.
  vec3 n = vec3(tex.rg * 2.0 - 1.0, 0.0);
  n.z = sqrt(max(0.0, 1.0 - dot(n.xy, n.xy)));
  float diff = clamp(dot(n, normalize(vLight)) * 0.6 + 0.4, 0.0, 1.0);
  float phase = mix(1.0, clamp(vPhase, 0.25, 4.0), (1.0 - tex.a) * 0.75);
  vec3 albedo = vColor.rgb;
  vec3 lit = albedo * (uAmbient + uSunColor * diff * phase) + albedo * uGlowColor * vColor.a;
  // Fire: hottest in the core of the sprite, cooler and sooty at its edges.
  float T = vFx.y * mix(0.3, 1.15, tex.b);
  vec3 emis = fireRamp(T) * uFireIntensity;
  float glow = smoothstep(0.3, 0.9, T);
  float aOcc = a * mix(1.0, uFireOcclusion, glow);
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

  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const attr = (n: number) => {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * n), n);
    a.setUsage(THREE.DynamicDrawUsage);
    return a;
  };
  const iPos = attr(4), iParams = attr(4), iColor = attr(4), iGround = attr(1);
  geo.setAttribute('iPos', iPos);
  geo.setAttribute('iParams', iParams);
  geo.setAttribute('iColor', iColor);
  geo.setAttribute('iGround', iGround);
  geo.instanceCount = 0;

  const sunDir = new THREE.Vector3(0.45, 0.75, 0.35).normalize();
  const uniforms: Record<string, THREE.IUniform> = {
    ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    uAtlas: { value: atlas },
    uSunView: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(1.0, 0.96, 0.9) },
    uAmbient: { value: new THREE.Color(0.32, 0.37, 0.46) },
    uGlowColor: { value: new THREE.Color(1.1, 0.42, 0.1) },
    uFireIntensity: { value: FX.fireIntensity },
    uFireOcclusion: { value: FX.fireOcclusion },
    uNearFade: { value: FX.nearFade },
    uMaxCover: { value: FX.maxScreenCover },
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
    (iGround.array as Float32Array)[slot] = Math.max(-1e6, p.groundY[i]);
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
      if (dt > 0) sim.step(dt, wind ? wind.x : 0, wind ? wind.y : 0, wind ? wind.z : 0);

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
        for (const a of [iPos, iParams, iColor]) {
          a.clearUpdateRanges();
          a.addUpdateRange(0, n * 4);
          a.needsUpdate = true;
        }
        iGround.clearUpdateRanges();
        iGround.addUpdateRange(0, n);
        iGround.needsUpdate = true;
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

      // Fire light.
      if (light) {
        light.intensity = FX.fireLightIntensity * sim.fireLevel;
        light.position.set(sim.firePos.x, sim.firePos.y, sim.firePos.z);
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
      dGeo.dispose();
      dMat.dispose();
      debris.dispose();
      light?.dispose();
    },
    stats() {
      return { smoke: sim.smoke.count, fire: sim.fire.count, debris: sim.debris.count, drawn, fireLevel: sim.fireLevel };
    },
  };
}
