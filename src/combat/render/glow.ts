/**
 * Additive HDR light streaks in ONE instanced draw call: gun tracers (stretched along their
 * velocity over ~1/60 s) and the muzzle flash. Each instance is a segment tail → head with a world
 * width; the vertex shader expands it into a camera-facing capsule in screen space (at least uMinPx
 * wide so a tracer 2 km away is still a visible dot, dimmed in proportion), and the fragment shader
 * draws a soft Gaussian core. Emission is linear HDR (the scene renders into a float target and is
 * tone mapped later), attenuated by the atmospheric fog transmittance (fog chunk evaluated on
 * black and white — no in-scatter is added, so streaks never turn into hazy rectangles).
 * Buffers are preallocated; begin/add/end allocate nothing.
 */
import * as THREE from 'three';

export interface GlowSink {
  /** Add one streak; returns false when the buffer is full. headBias: +1 brighter at the head, −1 at the tail. */
  add(hx: number, hy: number, hz: number, tx: number, ty: number, tz: number, widthM: number, intensity: number, r: number, g: number, b: number, headBias: number): boolean;
}

export interface GlowRenderer extends GlowSink {
  readonly mesh: THREE.Mesh;
  readonly capacity: number;
  count: number;
  begin(): void;
  /** Upload and set the viewport size (drawing-buffer pixels). */
  end(viewportW: number, viewportH: number): void;
  dispose(): void;
}

const VERT = /* glsl */ `
attribute vec4 iHead;   // xyz, width (m)
attribute vec4 iTail;   // xyz, intensity
attribute vec4 iColor;  // rgb, head bias
uniform vec2 uViewport;
uniform float uMinPx;
uniform float uMinGain;
varying vec3 vSeg;      // along (px from the tail), across (px), length (px)
varying float vHalfW;
varying vec4 vCol;
varying float vGain;
#include <fog_pars_vertex>
void main() {
  vec4 vh = viewMatrix * vec4(iHead.xyz, 1.0);
  vec4 vt = viewMatrix * vec4(iTail.xyz, 1.0);
  const float NEAR_Z = -0.3;
  if ((vh.z > NEAR_Z && vt.z > NEAR_Z) || iTail.w <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  if (vh.z > NEAR_Z) vh = mix(vt, vh, (NEAR_Z - vt.z) / (vh.z - vt.z));
  if (vt.z > NEAR_Z) vt = mix(vh, vt, (NEAR_Z - vh.z) / (vt.z - vh.z));
  vec4 ch = projectionMatrix * vh;
  vec4 ct = projectionMatrix * vt;
  vec2 halfVp = 0.5 * uViewport;
  vec2 sh = ch.xy / ch.w * halfVp;
  vec2 st = ct.xy / ct.w * halfVp;
  vec2 d = sh - st;
  float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  vec2 perp = vec2(-dir.y, dir.x);
  float pxPerM = projectionMatrix[1][1] * halfVp.y;
  float wWorld = iHead.w * pxPerM / max(-min(vh.z, vt.z), 0.05);
  float w = max(wWorld, uMinPx);
  float a = position.x;
  vec2 p = mix(st, sh, a) + dir * (a * 2.0 - 1.0) * w * 0.5 + perp * position.y * w * 0.5;
  vec4 c = mix(ct, ch, a);
  gl_Position = vec4(p / halfVp * c.w, c.z, c.w);
  vSeg = vec3(a * (len + w) - 0.5 * w, position.y * 0.5 * w, len);
  vHalfW = 0.5 * w;
  vCol = iColor;
  // Sub-pixel streaks are drawn uMinPx wide: spread the same light over them (with a floor).
  vGain = iTail.w * max(uMinGain, min(1.0, wWorld / w));
  vec4 mvPosition = mix(vt, vh, a);
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
varying vec3 vSeg;
varying float vHalfW;
varying vec4 vCol;
varying float vGain;
#include <fog_pars_fragment>
vec3 finishColor(vec3 c) {
  #ifdef TONE_MAPPING
    c = toneMapping(c);
  #endif
  return linearToOutputTexel(vec4(c, 1.0)).rgb;
}
void main() {
  float len = vSeg.z;
  float dx = vSeg.x - clamp(vSeg.x, 0.0, len);
  float r = sqrt(dx * dx + vSeg.y * vSeg.y) / max(vHalfW, 1e-3);
  if (r >= 1.0) discard;
  float prof = (exp(-3.5 * r * r) - exp(-3.5)) / (1.0 - exp(-3.5));
  float t = len > 0.5 ? clamp(vSeg.x / len, 0.0, 1.0) : 1.0;
  float along = mix(0.3, 1.0, vCol.w >= 0.0 ? t : 1.0 - t);
  vec3 emis = vCol.rgb * (vGain * prof * along);
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
  gl_FragColor = vec4(finishColor(emis) * fogT, 0.0);
}
`;

export function createGlowRenderer(scene: THREE.Scene | null, capacity = 600): GlowRenderer {
  const cap = Math.max(1, Math.floor(capacity));
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const attr = () => {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    a.setUsage(THREE.DynamicDrawUsage);
    return a;
  };
  const iHead = attr(), iTail = attr(), iColor = attr();
  geo.setAttribute('iHead', iHead);
  geo.setAttribute('iTail', iTail);
  geo.setAttribute('iColor', iColor);
  geo.instanceCount = 0;
  const uniforms: Record<string, THREE.IUniform> = {
    ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    uViewport: { value: new THREE.Vector2(1440, 900) },
    uMinPx: { value: 2.2 },
    uMinGain: { value: 0.35 },
  };
  // Keep the shared atmospheric-fog array by reference (render/fog.ts).
  const fogLib = THREE.UniformsLib.fog as Record<string, THREE.IUniform>;
  if (fogLib.atmoFog) uniforms.atmoFog = { value: fogLib.atmoFog.value };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    fog: true,
    defines: { ATMO_NO_CLOUD_SHADOW: '' },
  });
  mat.blending = THREE.CustomBlending;
  mat.blendEquation = THREE.AddEquation;
  mat.blendSrc = THREE.OneFactor;
  mat.blendDst = THREE.OneFactor;
  mat.blendSrcAlpha = THREE.ZeroFactor;
  mat.blendDstAlpha = THREE.OneFactor;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'weapons-glow';
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  mesh.visible = false;
  scene?.add(mesh);
  const H = iHead.array as Float32Array, T = iTail.array as Float32Array, C = iColor.array as Float32Array;

  const self: GlowRenderer = {
    mesh,
    capacity: cap,
    count: 0,
    begin() {
      self.count = 0;
    },
    add(hx, hy, hz, tx, ty, tz, widthM, intensity, r, g, b, headBias) {
      if (self.count >= cap) return false;
      if (!Number.isFinite(hx + hy + hz + tx + ty + tz + widthM + intensity)) return true;
      const o = self.count * 4;
      H[o] = hx; H[o + 1] = hy; H[o + 2] = hz; H[o + 3] = widthM;
      T[o] = tx; T[o + 1] = ty; T[o + 2] = tz; T[o + 3] = intensity;
      C[o] = r; C[o + 1] = g; C[o + 2] = b; C[o + 3] = headBias;
      self.count++;
      return true;
    },
    end(w, h) {
      (uniforms.uViewport.value as THREE.Vector2).set(Math.max(1, w), Math.max(1, h));
      const n = self.count;
      geo.instanceCount = n;
      mesh.visible = n > 0;
      if (n > 0) {
        for (const a of [iHead, iTail, iColor]) {
          a.clearUpdateRanges();
          a.addUpdateRange(0, n * 4);
          a.needsUpdate = true;
        }
      }
    },
    dispose() {
      mesh.removeFromParent();
      geo.dispose();
      mat.dispose();
    },
  };
  return self;
}
