/**
 * Contact shadows under the range's vehicles — what makes armour read from the air: a soft dark
 * patch of ambient occlusion under every hull plus its sun-cast shadow swept away from the sun
 * (and, for a wreck, a scorched patch of ground). One instanced quad per vehicle in its hull frame,
 * tilted with the hull to the ground, drawn after the opaque pass with multiply blending (the
 * ground is darkened, never lightened) and no depth write.
 *
 * The coarse distant terrain mesh can lie above the true ground by metres (see
 * src/world/roads/depth.ts): the quad gets the same kind of distance-proportional lift and a
 * view-depth pull — a little more than the hulls get — so it stays visible at 2 km while up close
 * it still hides behind the tracks it sits under. One draw call for every shadow.
 */
import * as THREE from 'three';
import { CONFIG } from '../../config';

export type ShadowConfig = typeof CONFIG.combat.range.shadow;

export interface ShadowShape {
  /** Hull half length / width, m (the AO box). */
  halfL: number;
  halfW: number;
  /** Cast shadow offset in the hull frame (x right, z back), m. */
  castX: number;
  castZ: number;
  /** Quad bounds in the hull frame (x right, z back), m. */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Soft edge beyond the hull (m) where the occlusion fades out. */
export const SOFT = 1.4;

/**
 * Where the shadow falls, in the hull frame: the AO box under the hull and the cast shadow of a
 * body `height` m tall, offset away from the sun (unit direction TO the sun, world) and clamped to
 * `castMax` m (a low sun would stretch it across the field). No cast shadow with the sun down.
 */
export function shadowShape(length: number, width: number, height: number, headingDeg: number, sun: { x: number; y: number; z: number }, castMax: number, out: ShadowShape): ShadowShape {
  const hl = length / 2;
  const hw = width / 2;
  out.halfL = hl;
  out.halfW = hw;
  let cx = 0;
  let cz = 0;
  const sh = Math.hypot(sun.x, sun.z);
  if (sun.y > 0.03 && sh > 1e-6) {
    // centroid height of the body ≈ 0.55 h; the shadow's reach grows as the sun sinks
    const reach = Math.min(castMax, (0.55 * height * sh) / sun.y);
    // away from the sun (world), into the hull frame: forward f = (sin h, −cos h), right r = (cos h, sin h)
    const wx = (-sun.x / sh) * reach;
    const wz = (-sun.z / sh) * reach;
    const h = (headingDeg * Math.PI) / 180;
    const fx = Math.sin(h);
    const fz = -Math.cos(h);
    cx = wx * -fz + wz * fx; // along right
    cz = -(wx * fx + wz * fz); // along back (+z = rear)
  }
  out.castX = cx;
  out.castZ = cz;
  out.minX = -hw - SOFT + Math.min(0, cx);
  out.maxX = hw + SOFT + Math.max(0, cx);
  out.minZ = -hl - SOFT + Math.min(0, cz);
  out.maxZ = hl + SOFT + Math.max(0, cz);
  return out;
}

export const newShadowShape = (): ShadowShape => ({ halfL: 0, halfW: 0, castX: 0, castZ: 0, minX: 0, maxX: 0, minZ: 0, maxZ: 0 });

/** Occlusion (0..1) of the ground at hull-frame point (x, z) — the fragment shader's formula, for tests. */
export function shadowAt(s: ShadowShape, x: number, z: number, strength = 1, soft = SOFT): number {
  const box = (px: number, pz: number, bx: number, bz: number) => {
    const dx = Math.abs(px) - bx;
    const dz = Math.abs(pz) - bz;
    return Math.hypot(Math.max(dx, 0), Math.max(dz, 0)) + Math.min(Math.max(dx, dz), 0);
  };
  const sm = (e0: number, e1: number, v: number) => {
    const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  const ao = 1 - sm(-0.6, soft, box(x, z, s.halfW, s.halfL));
  let cast = 0;
  for (let k = 0; k < 4; k++) {
    const t = k / 3;
    const sc = 0.35 + 0.7 * t;
    cast = Math.max(cast, (1 - sm(-sc, sc, box(x - s.castX * t, z - s.castZ * t, s.halfW * 0.92, s.halfL * 0.92))) * (1 - 0.3 * t));
  }
  return Math.min(0.9, Math.max(ao * 0.8, cast * 0.62) * strength);
}

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec4 aBox;   // halfL, halfW, castX, castZ (hull frame, m)
attribute vec4 aMisc;  // strength, scorch 0..1, -, -
uniform float uLift;
uniform float uPull;
uniform vec2 uFar;
uniform float uGrow;
varying vec2 vLocal;
varying vec4 vBox;
varying vec3 vMisc;
void main() {
  // the soft rim widens with distance (the patch keeps a few pixels at 2 km)
  float dc = distance((modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz, cameraPosition);
  float soft = ${SOFT.toFixed(2)} + 1.6 * aMisc.y + uGrow * dc;
  vec2 lo = vec2(-aBox.y - soft + min(0.0, aBox.z), -aBox.x - soft + min(0.0, aBox.w));
  vec2 hi = vec2(aBox.y + soft + max(0.0, aBox.z), aBox.x + soft + max(0.0, aBox.w));
  vec2 lp = mix(lo, hi, position.xz + 0.5);
  vLocal = lp;
  vBox = aBox;
  // just above a farm lane's ribbon (0.12 m over the ground): the shadow darkens the lane too
  vec4 w = modelMatrix * instanceMatrix * vec4(lp.x, 0.2, lp.y, 1.0);
  float d = distance(w.xyz, cameraPosition);
  w.y += uLift * d;
  vMisc = vec3(aMisc.x * (1.0 - 0.45 * smoothstep(uFar.x, uFar.y, d)), aMisc.y, soft);
  vec4 mv = viewMatrix * w;
  mv.xyz *= 1.0 - uPull;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}`;

const FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec2 vLocal;
varying vec4 vBox;
varying vec3 vMisc;
float boxSdf(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}
void main() {
  #include <logdepthbuf_fragment>
  vec2 hb = vec2(vBox.y, vBox.x);
  float scorch = vMisc.y;
  float ao = 1.0 - smoothstep(-0.6, vMisc.z, boxSdf(vLocal, hb));
  float cst = 0.0;
  for (int k = 0; k < 4; k++) {
    float t = float(k) / 3.0;
    float soft = 0.35 + 0.7 * t;
    cst = max(cst, (1.0 - smoothstep(-soft, soft, boxSdf(vLocal - vBox.zw * t, hb * 0.92))) * (1.0 - 0.3 * t));
  }
  float a = clamp(max(ao * (0.8 + 0.15 * scorch), cst * 0.62) * vMisc.x, 0.0, 0.9);
  if (a < 0.004) discard;
  // a wreck's burnt ground is sooty (a touch warm), plain shadow is neutral
  vec3 mul = mix(vec3(1.0 - a), vec3(1.0 - a) * vec3(0.9, 0.86, 0.82), scorch);
  gl_FragColor = vec4(mul, 1.0);
}`;

export interface ShadowRenderer {
  readonly mesh: THREE.InstancedMesh;
  begin(): void;
  /** One vehicle: its hull pose matrix (ground-level origin), shape and strength (0..1), scorch 0..1. */
  add(m: THREE.Matrix4, s: ShadowShape, strength: number, scorch: number): void;
  end(): void;
  dispose(): void;
}

export function createShadowRenderer(capacity: number, cfg: ShadowConfig = CONFIG.combat.range.shadow): ShadowRenderer {
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2);
  const cap = Math.max(1, capacity);
  const aBox = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
  const aMisc = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
  aBox.setUsage(THREE.DynamicDrawUsage);
  aMisc.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aBox', aBox);
  geo.setAttribute('aMisc', aMisc);
  const mat = new THREE.ShaderMaterial({
    name: 'targets-shadow',
    uniforms: { uLift: { value: cfg.lift }, uPull: { value: cfg.pull }, uGrow: { value: cfg.grow }, uFar: { value: new THREE.Vector2(cfg.farFade[0], cfg.farFade[1]) } },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.ZeroFactor,
    blendDst: THREE.SrcColorFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, cap);
  mesh.name = 'targets.shadows';
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  // after the opaque world (terrain, roads) and before smoke/fire sprites
  mesh.renderOrder = 1;
  mesh.count = 0;
  let n = 0;
  return {
    mesh,
    begin() {
      n = 0;
    },
    add(m, s, strength, scorch) {
      if (n >= cap) return;
      mesh.setMatrixAt(n, m);
      const b = aBox.array as Float32Array;
      b[n * 4] = s.halfL;
      b[n * 4 + 1] = s.halfW;
      b[n * 4 + 2] = s.castX;
      b[n * 4 + 3] = s.castZ;
      const c = aMisc.array as Float32Array;
      c[n * 4] = strength;
      c[n * 4 + 1] = scorch;
      n++;
    },
    end() {
      mesh.count = n;
      mesh.visible = n > 0;
      if (n === 0) return;
      mesh.instanceMatrix.needsUpdate = true;
      aBox.needsUpdate = true;
      aMisc.needsUpdate = true;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
      mesh.removeFromParent();
    },
  };
}
