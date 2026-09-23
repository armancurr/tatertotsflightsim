/**
 * three.js renderer for the glowing streaks (sparks, ricochets, hot fragments): ONE instanced draw
 * call of camera-facing ribbons, each from where the streak was a moment ago (motion blur) to where it
 * is, at least ~1.5 px wide (thinner ones are widened and dimmed, so energy is kept and nothing
 * shimmers), additive blackbody emission (the fx fire ramp) with the atmospheric fog's transmittance
 * and inscatter. Buffers are preallocated; update() allocates nothing.
 */
import * as THREE from 'three';
import { FIRE_GLSL } from '../../fx/shading';
import type { StreakPool } from './streaks';

const VERT = /* glsl */ `
attribute vec4 iHead;
attribute vec4 iTail;
uniform vec2 uViewport;
varying vec2 vUv;
varying float vHeat;
varying float vGain;
#include <fog_pars_vertex>
void main() {
  vec4 h = viewMatrix * vec4(iHead.xyz, 1.0);
  vec4 t = viewMatrix * vec4(iTail.xyz, 1.0);
  // Clip the tail to just in front of the camera.
  if (t.z > -0.1) t = mix(t, h, clamp((t.z + 0.1) / max(1e-4, t.z - h.z), 0.0, 1.0));
  vec4 mvPosition = mix(t, h, position.x);
  vec4 ch = projectionMatrix * h;
  vec4 ct = projectionMatrix * t;
  vec4 c = projectionMatrix * mvPosition;
  float depth = max(0.1, -mvPosition.z);
  // Width in pixels: the true width, but at least 1.5 px (dimmed to keep the energy).
  float pxPerM = 0.5 * uViewport.y * projectionMatrix[1][1] / depth;
  float wpx = iHead.w * pxPerM;
  float w = max(1.5, wpx);
  vec2 sh = ch.xy / max(1e-4, ch.w) * 0.5 * uViewport;
  vec2 st = ct.xy / max(1e-4, ct.w) * 0.5 * uViewport;
  vec2 d = sh - st;
  float len = length(d);
  vec2 dir = len > 1e-3 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  vec2 off = nrm * position.y * 0.5 * w + dir * (position.x * 2.0 - 1.0) * 0.5 * w;
  c.xy += off / (0.5 * uViewport) * c.w;
  gl_Position = c;
  if (h.z > -0.1 || iTail.w <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vUv = vec2(position.x, position.y);
  vHeat = iTail.w;
  // A widened line spreads the same light over more pixels; a long streak spreads it along its length.
  vGain = min(1.0, wpx / w) * clamp((w + 1.0) / (len + w + 1.0) * 3.0, 0.25, 1.0);
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
uniform float uIntensity;
varying vec2 vUv;
varying float vHeat;
varying float vGain;
#include <fog_pars_fragment>
${FIRE_GLSL}
void main() {
  float across = 1.0 - vUv.y * vUv.y;
  float along = mix(0.25, 1.0, vUv.x);
  float a = across * across * along;
  if (a < 0.003) discard;
  vec3 emis = fireRamp(vHeat) * uIntensity * vGain * a;
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
  vec3 col = emis;
  #ifdef TONE_MAPPING
    col = toneMapping(col);
  #endif
  col = linearToOutputTexel(vec4(col, 1.0)).rgb;
  gl_FragColor = vec4(col * fogT, 1.0);
}
`;

export interface StreakRenderer {
  readonly mesh: THREE.Mesh;
  /** Write the live streaks (after the pool stepped). `shutterS` = motion-blur time. */
  update(camera: THREE.PerspectiveCamera, viewportHeight: number, viewportWidth: number): void;
  readonly drawn: number;
  dispose(): void;
}

export function createStreakRenderer(pool: StreakPool, opts: { intensity?: number; shutterS?: number; minTrailM?: number } = {}): StreakRenderer {
  const cap = pool.capacity;
  const geo = new THREE.InstancedBufferGeometry();
  // x: 0 = tail, 1 = head; y: across −1..1.
  geo.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const head = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
  const tail = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
  head.setUsage(THREE.DynamicDrawUsage);
  tail.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('iHead', head);
  geo.setAttribute('iTail', tail);
  geo.instanceCount = 0;

  const uniforms: Record<string, THREE.IUniform> = {
    ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    uViewport: { value: new THREE.Vector2(1440, 900) },
    uIntensity: { value: opts.intensity ?? 3 },
  };
  const fogLib = THREE.UniformsLib.fog as Record<string, THREE.IUniform>;
  if (fogLib.atmoFog) uniforms.atmoFog = { value: fogLib.atmoFog.value };
  const mat = new THREE.ShaderMaterial({
    uniforms, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, depthTest: true, fog: true,
    defines: { ATMO_NO_CLOUD_SHADOW: '' },
  });
  // Pure emission: add it (src × 1 + dst × 1).
  mat.blending = THREE.CustomBlending;
  mat.blendEquation = THREE.AddEquation;
  mat.blendSrc = THREE.OneFactor;
  mat.blendDst = THREE.OneFactor;
  mat.blendSrcAlpha = THREE.ZeroFactor;
  mat.blendDstAlpha = THREE.OneFactor;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'combatfx-streaks';
  mesh.frustumCulled = false;
  // Always "visible" with 0 instances when idle: the program compiles at start-up, not on the first spark.
  mesh.visible = true;
  mesh.renderOrder = 2;
  const shutter = opts.shutterS ?? 1 / 45;
  const minTrail = opts.minTrailM ?? 0.08;
  let drawn = 0;

  return {
    mesh,
    get drawn() {
      return drawn;
    },
    update(camera, vh, vw) {
      (mat.uniforms.uViewport.value as THREE.Vector2).set(Math.max(1, vw), Math.max(1, vh));
      const H = head.array as Float32Array;
      const T = tail.array as Float32Array;
      let n = 0;
      for (let i = 0; i < cap; i++) {
        if (!pool.alive[i]) continue;
        const heat = pool.heatOf(i);
        if (heat < 0.05) continue;
        const vx = pool.vx[i], vy = pool.vy[i], vz = pool.vz[i];
        const sp = Math.hypot(vx, vy, vz);
        // Trail: the distance covered during the shutter, at least minTrail (a dot).
        const k = sp > 1e-3 ? Math.max(shutter, minTrail / sp) : 0;
        const o = n * 4;
        H[o] = pool.px[i]; H[o + 1] = pool.py[i]; H[o + 2] = pool.pz[i]; H[o + 3] = pool.width[i];
        T[o] = pool.px[i] - vx * k; T[o + 1] = pool.py[i] - vy * k - (sp > 1e-3 ? 0 : minTrail); T[o + 2] = pool.pz[i] - vz * k; T[o + 3] = heat;
        n++;
      }
      drawn = n;
      geo.instanceCount = n;
      if (n > 0) {
        head.clearUpdateRanges();
        head.addUpdateRange(0, n * 4);
        head.needsUpdate = true;
        tail.clearUpdateRanges();
        tail.addUpdateRange(0, n * 4);
        tail.needsUpdate = true;
      }
    },
    dispose() {
      mesh.removeFromParent();
      geo.dispose();
      mat.dispose();
    },
  };
}
