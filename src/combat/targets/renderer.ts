/**
 * Draws the range's vehicles: one InstancedMesh per class × part (hull, turret) × level of detail,
 * all sharing one vertex-coloured MeshStandardMaterial (fog on, HDR-calibrated albedo) whose shader
 * adds per-instance paint (plain 4BO / two- and three-tone camouflage), mud and dust weathering and
 * the charred wreck (soot black with rust-brown burnt paint), plus the same far-terrain lift and
 * depth pull as the roads so hulls never sink into the coarse distant terrain mesh. No allocation
 * per frame: instances are refilled in place from the vehicle views.
 */
import * as THREE from 'three';
import { CONFIG } from '../../config';
import type { GroundKind as TargetKind } from '../types';
import { buildClassModel, TARGET_KINDS, type ClassModel, type Lod } from './models';
import { createShadowRenderer, newShadowShape, shadowShape } from './shadows';
import { buildBermGeometry } from './berms';
import type { Berm } from './plan';

export interface VehicleView {
  kind: TargetKind;
  visible: boolean;
  /** Hull footprint centre (ground level), heading (deg), terrain pitch/roll (rad, visual). */
  x: number;
  y: number;
  z: number;
  headingDeg: number;
  pitch: number;
  roll: number;
  /** Turret yaw relative to the hull (rad, + = to the right). */
  turretYaw: number;
  /** 0 intact … 1 fully charred. */
  char: number;
  seed: number;
  camo: number;
  /** A tossed turret: world pose (overrides the mounted turret). */
  turretFree: boolean;
  turretPos: THREE.Vector3;
  turretQuat: THREE.Quaternion;
  /** No turret at all (not drawn). */
  turretGone: boolean;
  /** Metres driven (the wheels and tracks turn with it). */
  odo: number;
}

export function newVehicleView(kind: TargetKind): VehicleView {
  return {
    kind, visible: true, x: 0, y: 0, z: 0, headingDeg: 0, pitch: 0, roll: 0, turretYaw: 0, char: 0, seed: 0, camo: 0,
    turretFree: false, turretPos: new THREE.Vector3(), turretQuat: new THREE.Quaternion(), turretGone: false, odo: 0,
  };
}

/** Level of detail for a camera distance, with hysteresis around the previous level. */
export function selectLod(dist: number, prev: Lod, lod: readonly [number, number] = CONFIG.combat.range.lod, hyst = CONFIG.combat.range.lodHysteresis): Lod {
  const [a, b] = lod;
  const up = 1 + hyst;
  const down = 1 - hyst;
  let l: Lod = dist < a ? 0 : dist < b ? 1 : 2;
  if (l !== prev) {
    // stay at the previous level inside the hysteresis band
    if (prev === 0 && dist < a * up) l = 0;
    else if (prev === 1 && dist >= a * down && dist < b * up) l = 1;
    else if (prev === 2 && dist >= b * down) l = 2;
  }
  return l;
}

const SHADER_VERT_PARS = /* glsl */ `
attribute vec4 aState;
attribute vec4 aPart;
varying vec4 vState;
varying vec4 vPart;
varying vec3 vObj;
uniform float uLift;
uniform float uPull;
uniform float uTime;
uniform float uDishRate;
// the ZSU's radar dish spins about its mast (a vertical axis at z = aPart.z) while the vehicle lives
vec2 tgDish(vec2 xz) {
  float a = (uTime * uDishRate + aState.y) * 6.2831853 * (1.0 - step(0.001, aState.x));
  float c = cos(a);
  float s = sin(a);
  vec2 p = vec2(xz.x, xz.y - aPart.z);
  return vec2(c * p.x - s * p.y, aPart.z + s * p.x + c * p.y);
}
`;
const SHADER_FRAG_PARS = /* glsl */ `
varying vec4 vState;
varying vec4 vPart;
varying vec3 vObj;
float tgHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float tgNoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(tgHash(i), tgHash(i + vec3(1, 0, 0)), f.x), mix(tgHash(i + vec3(0, 1, 0)), tgHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(tgHash(i + vec3(0, 0, 1)), tgHash(i + vec3(1, 0, 1)), f.x), mix(tgHash(i + vec3(0, 1, 1)), tgHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
`;
const SHADER_COLOR = /* glsl */ `
{
  vec3 base = diffuseColor.rgb;
  float painted = step(0.045, base.g) * step(base.r, base.g);
  vec3 sp = vObj * 0.9 + vState.y * 41.0;
  // camouflage: large soft-edged blotches (brown; black stripes for the three-tone scheme)
  if (vState.z > 0.5 && painted > 0.5) {
    float m = tgNoise(sp * 0.55) * 0.65 + tgNoise(sp * 1.3) * 0.35;
    base = mix(base, vec3(0.085, 0.062, 0.033), smoothstep(0.5, 0.56, m));
    if (vState.z > 1.5) base = mix(base, vec3(0.02, 0.02, 0.018), smoothstep(0.66, 0.7, tgNoise(sp * 0.8 + 7.0)));
  }
  // dust and dried mud, heaviest low down; a little everywhere
  float n = tgNoise(vObj * 2.3 + vState.y * 13.0);
  float low = smoothstep(1.4, 0.15, vObj.y);
  float dust = clamp(low * (0.45 + 0.5 * n) + 0.05 * n, 0.0, 0.85);
  base = mix(base, vec3(0.2, 0.165, 0.115), dust * 0.75);
  // charred wreck: soot black, burnt paint gone to rust-brown in patches, grey ash
  float c = vState.x;
  if (c > 0.0) {
    float r = tgNoise(vObj * 1.6 + 3.0) * 0.6 + tgNoise(vObj * 5.0) * 0.4;
    vec3 burnt = mix(vec3(0.016, 0.015, 0.014), vec3(0.075, 0.034, 0.017), smoothstep(0.45, 0.75, r));
    burnt = mix(burnt, vec3(0.06, 0.058, 0.055), smoothstep(0.78, 0.9, tgNoise(vObj * 3.3 + 9.0)) * 0.6);
    base = mix(base, burnt, clamp(c * (0.75 + 0.5 * n), 0.0, 1.0));
  }
  // running gear: wheel hubs/spokes turn and track links run with the odometer (vState.w, m)
  if (vPart.x > 0.5 && vPart.x < 1.5) {
    vec2 d = vec2(vObj.y - vPart.y, vObj.z - vPart.z);
    float rr = length(d) / max(vPart.w, 0.01);
    float a = atan(d.x, d.y) - vState.w / max(vPart.w, 0.05);
    float spokes = smoothstep(0.45, 0.85, cos(a * 5.0)) * step(0.3, rr) * step(rr, 0.8);
    float mud = smoothstep(0.6, 0.95, cos(a * 3.0 + 1.0)) * step(0.84, rr);
    base *= 1.0 - 0.55 * spokes - 0.3 * mud;
  } else if (vPart.x > 1.5 && vPart.x < 2.5) {
    float u = (vObj.z + (vObj.y > vPart.y ? 1.0 : -1.0) * vState.w) / 0.3;
    float fw = fwidth(u);
    float link = smoothstep(0.62, 0.8, abs(fract(u) - 0.5) * 2.0) * clamp(1.5 - fw * 3.0, 0.0, 1.0);
    base *= 1.0 - 0.5 * link;
  }
  diffuseColor.rgb = base;
}
`;

export function createVehicleMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.08, fog: true });
  const cfg = CONFIG.combat.range;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uLift = { value: cfg.lodLift };
    shader.uniforms.uPull = { value: cfg.depthPull };
    shader.uniforms.uTime = timeUniform;
    shader.uniforms.uDishRate = { value: cfg.turret.radarRevS };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${SHADER_VERT_PARS}`)
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nif (aPart.x > 2.5) objectNormal.xz = tgDish(objectNormal.xz + vec2(0.0, aPart.z)) - vec2(0.0, aPart.z);')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvState = aState;\nvPart = aPart;\nvObj = position;\nif (aPart.x > 2.5) transformed.xz = tgDish(transformed.xz);')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
{
  vec4 tgW = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
  tgW.y += uLift * distance(tgW.xyz, cameraPosition);
  vec4 tgMv = viewMatrix * tgW;
  gl_Position = projectionMatrix * vec4(tgMv.xyz * (1.0 - uPull), 1.0);
}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${SHADER_FRAG_PARS}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${SHADER_COLOR}`)
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.97, vState.x);\nmetalnessFactor *= 1.0 - vState.x;');
  };
  mat.customProgramCacheKey = () => 'targets-vehicle-v2';
  return mat;
}

/** Shared clock for the vehicle shader (radar dish), s. */
const timeUniform = { value: 0 };

interface Slot {
  mesh: THREE.InstancedMesh;
  state: THREE.InstancedBufferAttribute;
  count: number;
  sphere: THREE.Sphere;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export interface TargetsRendererOptions {
  /** Earth berms and revetments to draw (static, draped over `ground`). */
  berms?: readonly Berm[];
  ground?: (x: number, z: number) => number;
}

export interface TargetsRenderer {
  readonly group: THREE.Group;
  /** Refill the instances from the views; `sun` = unit direction to the sun (contact shadows), `time` s (radar dish). */
  update(camera: THREE.Camera, views: readonly VehicleView[], sun?: { x: number; y: number; z: number }, time?: number): void;
  /** Meshes with instances this frame (≈ draw calls before frustum culling). */
  activeMeshes(): number;
  /** Instances drawn per class/part/lod (tests). */
  counts(): Record<string, number>;
  dispose(): void;
}

const DEG = Math.PI / 180;

export function createTargetsRenderer(capacity: Partial<Record<TargetKind, number>>, opts: TargetsRendererOptions = {}): TargetsRenderer {
  const group = new THREE.Group();
  group.name = 'targets';
  const material = createVehicleMaterial();
  const rc = CONFIG.combat.range;
  let total = 0;
  for (const k of TARGET_KINDS) total += capacity[k] ?? 0;
  // contact shadows: one instanced draw for every vehicle
  const shadows = createShadowRenderer(total);
  group.add(shadows.mesh);
  const shape = newShadowShape();
  const DEFAULT_SUN = { x: 0.35, y: 0.8, z: -0.45 };
  // earth berms and revetments: one static draw (the vehicle material: lift, pull, fog, dust)
  let bermMesh: THREE.InstancedMesh | null = null;
  if (opts.berms && opts.berms.length > 0 && opts.ground) {
    const geo = buildBermGeometry(opts.berms, opts.ground);
    geo.setAttribute('aState', new THREE.InstancedBufferAttribute(new Float32Array([0, 0.5, 0, 0]), 4));
    bermMesh = new THREE.InstancedMesh(geo, material, 1);
    bermMesh.setMatrixAt(0, new THREE.Matrix4());
    bermMesh.name = 'targets.berms';
    bermMesh.castShadow = true;
    bermMesh.receiveShadow = true;
    bermMesh.frustumCulled = true;
    geo.computeBoundingSphere();
    bermMesh.boundingSphere = geo.boundingSphere!.clone();
    bermMesh.boundingSphere.radius += 10;
    group.add(bermMesh);
  }
  const models = new Map<string, ClassModel>();
  const slots = new Map<string, Slot>();
  const key = (kind: TargetKind, part: 'hull' | 'turret', lod: Lod) => `${kind}.${part}.${lod}`;
  for (const kind of TARGET_KINDS) {
    const cap = capacity[kind] ?? 0;
    if (cap <= 0) continue;
    for (const lod of [0, 1, 2] as Lod[]) {
      const m = buildClassModel(kind, lod);
      models.set(`${kind}.${lod}`, m);
      for (const part of ['hull', 'turret'] as const) {
        const geo = part === 'hull' ? m.hull : m.turret;
        if (!geo) continue;
        // turrets can also be tossed free of their hull: room for every one
        const state = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
        state.setUsage(THREE.DynamicDrawUsage);
        geo.setAttribute('aState', state);
        const mesh = new THREE.InstancedMesh(geo, material, cap);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.count = 0;
        mesh.visible = false;
        mesh.castShadow = lod < 2;
        mesh.receiveShadow = lod === 0;
        mesh.name = `targets.${key(kind, part, lod)}`;
        mesh.frustumCulled = true;
        const slot: Slot = { mesh, state, count: 0, sphere: new THREE.Sphere(), minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
        mesh.boundingSphere = slot.sphere;
        slots.set(key(kind, part, lod), slot);
        group.add(mesh);
      }
    }
  }
  const lods = new Map<VehicleView, Lod>();
  const M = new THREE.Matrix4();
  const R = new THREE.Matrix4();
  const T = new THREE.Matrix4();
  const Q = new THREE.Quaternion();
  const E = new THREE.Euler(0, 0, 0, 'YXZ');
  const S = new THREE.Vector3(1, 1, 1);
  const P = new THREE.Vector3();
  const camPos = new THREE.Vector3();

  const put = (slot: Slot, m: THREE.Matrix4, v: VehicleView) => {
    const i = slot.count++;
    slot.mesh.setMatrixAt(i, m);
    const a = slot.state.array as Float32Array;
    a[i * 4] = v.char;
    a[i * 4 + 1] = v.seed;
    a[i * 4 + 2] = v.camo;
    a[i * 4 + 3] = v.odo % 10000;
    const x = m.elements[12];
    const y = m.elements[13];
    const z = m.elements[14];
    if (i === 0) {
      slot.minX = slot.maxX = x;
      slot.minY = slot.maxY = y;
      slot.minZ = slot.maxZ = z;
    } else {
      slot.minX = Math.min(slot.minX, x);
      slot.maxX = Math.max(slot.maxX, x);
      slot.minY = Math.min(slot.minY, y);
      slot.maxY = Math.max(slot.maxY, y);
      slot.minZ = Math.min(slot.minZ, z);
      slot.maxZ = Math.max(slot.maxZ, z);
    }
  };

  return {
    group,
    update(camera, views, sun = DEFAULT_SUN, time = 0) {
      camera.getWorldPosition(camPos);
      timeUniform.value = time;
      for (const s of slots.values()) s.count = 0;
      shadows.begin();
      for (const v of views) {
        if (!v.visible) continue;
        const dist = Math.hypot(v.x - camPos.x, v.y - camPos.y, v.z - camPos.z);
        const lod = selectLod(dist, lods.get(v) ?? 2);
        lods.set(v, lod);
        const hull = slots.get(key(v.kind, 'hull', lod));
        if (!hull) continue;
        E.set(v.pitch, -v.headingDeg * DEG, v.roll, 'YXZ');
        Q.setFromEuler(E);
        P.set(v.x, v.y, v.z);
        const k = farScaleAt(dist);
        S.set(k, k, k);
        M.compose(P, Q, S);
        const cls = CONFIG.combat.targets[v.kind];
        shadowShape(cls.length, cls.width, cls.height, v.headingDeg, sun, rc.shadow.castMax, shape);
        shadows.add(M, shape, rc.shadow.strength, v.char);
        put(hull, M, v);
        const model = models.get(`${v.kind}.${lod}`)!;
        const tur = slots.get(key(v.kind, 'turret', lod));
        if (!tur || v.turretGone) continue;
        if (v.turretFree) {
          M.compose(v.turretPos, v.turretQuat, S.set(1, 1, 1));
        } else {
          T.makeTranslation(0, model.ring.y, model.ring.z);
          R.makeRotationY(-v.turretYaw);
          M.multiply(T).multiply(R);
        }
        put(tur, M, v);
      }
      shadows.end();
      for (const s of slots.values()) {
        s.mesh.count = s.count;
        s.mesh.visible = s.count > 0;
        if (s.count === 0) continue;
        s.mesh.instanceMatrix.needsUpdate = true;
        s.state.needsUpdate = true;
        s.sphere.center.set((s.minX + s.maxX) / 2, (s.minY + s.maxY) / 2, (s.minZ + s.maxZ) / 2);
        s.sphere.radius = 0.5 * Math.hypot(s.maxX - s.minX, s.maxY - s.minY, s.maxZ - s.minZ) + 12;
      }
    },
    activeMeshes() {
      let n = 0;
      for (const s of slots.values()) if (s.count > 0) n++;
      if (shadows.mesh.count > 0) n++;
      if (bermMesh) n++;
      return n;
    },
    counts() {
      const out: Record<string, number> = {};
      for (const [k, s] of slots) if (s.count > 0) out[k] = s.count;
      return out;
    },
    dispose() {
      for (const s of slots.values()) {
        s.mesh.geometry.dispose();
        s.mesh.dispose();
      }
      shadows.dispose();
      if (bermMesh) bermMesh.geometry.dispose();
      material.dispose();
      group.removeFromParent();
    },
  };
}

/** Drawing scale of a vehicle at camera distance d (the far-visibility aid, CONFIG.combat.range.farScale). */
export function farScaleAt(d: number, f: readonly [number, number, number] = CONFIG.combat.range.farScale): number {
  if (!(d > f[0])) return 1;
  const t = Math.min(1, (d - f[0]) / Math.max(1, f[1] - f[0]));
  return 1 + (f[2] - 1) * t * t * (3 - 2 * t);
}

/** Turret ring (hull frame) and its tossed centre-of-mass height, per class (LOD 0). */
export function ringOf(kind: TargetKind): { y: number; z: number } {
  const m = RINGS[kind];
  return m;
}
const RINGS: Record<TargetKind, { y: number; z: number }> = {
  tank: { y: 1.45, z: -0.35 },
  ifv: { y: 1.78, z: -0.35 },
  apc: { y: 2.0, z: -1.2 },
  truck: { y: 0, z: 0 },
  aaa: { y: 1.35, z: -0.2 },
};
