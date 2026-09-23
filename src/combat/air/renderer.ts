/**
 * Draws the enemy aircraft: one InstancedMesh per class × part × level of detail, all sharing one
 * vertex-coloured MeshStandardMaterial (fog on, HDR-calibrated) whose shader paints the
 * camouflage per class (hard-edged sprayed blotches, the pale underside with a wavy demarcation,
 * subtle panel shading), shifts the bort-number decals to each instance's number, glows the hot
 * nozzles and chars the wrecks; the decal atlas carries the red stars and stencil digits. Rotors
 * are blur discs (the traffic disc material), and ONE point list holds the nav lights,
 * anti-collision beacons, the engines' dull glow from behind, burning flares and — far away,
 * where the mesh is a few pixels — a dot so they stay visible at 3–8 km. No allocation per frame.
 */
import * as THREE from 'three';
import { CONFIG } from '../../config';
import type { AirKind } from '../types';
import { createDiscMaterial, createLightingUniforms, createPointMaterial, type LightingUniforms } from '../../world/traffic/materials';
import { PointBuffer } from '../../world/traffic/points';
import { airAtlas, airFixtures, buildAirModel, DIGIT_W, type AirFixtures, type AirLod, type AirModel, type AirPart } from './models';
import { PART_PIVOT } from './wreck';
import type { AirEntity } from './squadron';
import type { FlarePool } from './airFx';

const KINDS: AirKind[] = ['fighter', 'attack', 'helo'];
const PARTS: Record<AirKind, AirPart[]> = { fighter: ['body', 'wingL', 'wingR', 'tail'], attack: ['body', 'wingL', 'wingR', 'tail'], helo: ['body', 'tailRotor', 'blades'] };
const SCHEME: Record<AirKind, number> = { fighter: 0, attack: 1, helo: 2 };

/** Camouflage palettes (sRGB): base, patch 1, patch 2, underside — MiG-29 greys, Su-25 desert/green, Mi-24 tan/green. */
const PALETTES: number[][] = [
  [0xa3abae, 0x6d7a82, 0x87949a, 0xbfc8cc],
  [0xb09a70, 0x6f5436, 0x5b6638, 0xa3b9c9],
  [0xa08e62, 0x4b5733, 0x5a4730, 0x9db2c0],
];

const VERT_PARS = /* glsl */ `
attribute vec4 aState;
attribute vec4 aSurf;
varying vec4 vState;
varying vec4 vSurf;
varying vec3 vObj;
varying vec3 vObjN;
uniform float uDigitW;
`;
const FRAG_PARS = /* glsl */ `
varying vec4 vState;
varying vec4 vSurf;
varying vec3 vObj;
varying vec3 vObjN;
uniform vec3 uPal[12];
uniform float uGlow;
float atHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float atNoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(atHash(i), atHash(i + vec3(1, 0, 0)), f.x), mix(atHash(i + vec3(0, 1, 0)), atHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(atHash(i + vec3(0, 0, 1)), atHash(i + vec3(1, 0, 1)), f.x), mix(atHash(i + vec3(0, 1, 1)), atHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
`;
const FRAG_COLOR = /* glsl */ `
{
  int sc = int(vState.z + 0.5) * 4;
  vec3 base = diffuseColor.rgb;
  if (vSurf.x > 0.5 && vSurf.x < 1.5) {
    // camouflage: big hard-edged blotches (two patch colours), a wavy demarcation to the pale underside
    vec3 p = vObj * vec3(0.32, 0.5, 0.26) + vState.y * 17.0;
    float m1 = atNoise(p) * 0.7 + atNoise(p * 2.3) * 0.3;
    float m2 = atNoise(p * 1.1 + 5.3) * 0.7 + atNoise(p * 2.7 + 2.0) * 0.3;
    vec3 c = uPal[sc];
    c = mix(c, uPal[sc + 1], smoothstep(0.5, 0.53, m1));
    c = mix(c, uPal[sc + 2], smoothstep(0.58, 0.61, m2) * (1.0 - smoothstep(0.5, 0.53, m1)));
    float wob = (atNoise(vObj * 0.9 + 3.0) - 0.5) * 0.35;
    float under = 1.0 - smoothstep(-0.32 + wob, -0.22 + wob, vObjN.y);
    c = mix(c, uPal[sc + 3], under);
    // weathering: panels a touch lighter/darker, exhaust-stained aft
    c *= 0.92 + 0.12 * atNoise(vObj * vec3(1.6, 1.6, 0.8) + 11.0);
    base = c * vColor.rgb;
  }
  // wreck: soot, burnt paint, bare metal
  float ch = vState.x;
  if (ch > 0.0) {
    float n = atNoise(vObj * 1.4 + 3.0) * 0.6 + atNoise(vObj * 4.7) * 0.4;
    vec3 burnt = mix(vec3(0.015, 0.014, 0.013), vec3(0.07, 0.035, 0.018), smoothstep(0.45, 0.75, n));
    burnt = mix(burnt, vec3(0.09, 0.09, 0.09), smoothstep(0.8, 0.92, atNoise(vObj * 2.9 + 9.0)) * 0.7);
    base = mix(base, burnt, clamp(ch * (0.7 + 0.6 * n), 0.0, 1.0));
  }
  diffuseColor.rgb = base;
}
`;

export function createAirMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, map: airAtlas(), alphaTest: 0.5, roughness: 0.6, metalness: 0.05, fog: true, envMapIntensity: 0.8 });
  mat.name = 'air.targets';
  const pal: THREE.Vector3[] = [];
  const c = new THREE.Color();
  for (const p of PALETTES) for (const hex of p) {
    c.setHex(hex);
    pal.push(new THREE.Vector3(c.r, c.g, c.b));
  }
  const uGlow = { value: 1 };
  mat.userData.uGlow = uGlow;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uPal = { value: pal };
    shader.uniforms.uGlow = uGlow;
    shader.uniforms.uDigitW = { value: DIGIT_W };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvState = aState;\nvSurf = aSurf;\nvObj = position;\nvObjN = normal;')
      .replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
#ifdef USE_MAP
if ( aSurf.x > 1.5 && aSurf.x < 3.5 ) {
  float num = aState.w;
  float dg = aSurf.x < 2.5 ? floor( num / 10.0 ) : mod( num, 10.0 );
  vMapUv.x += dg * uDigitW;
}
#endif`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${FRAG_COLOR}`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix(vSurf.y, 0.95, vState.x);')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vSurf.z * (1.0 - vState.x);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(1.0, 0.32, 0.07) * vSurf.w * uGlow * (1.0 - vState.x) * 1.4;');
  };
  mat.customProgramCacheKey = () => 'air-targets-v1';
  return mat;
}

interface Slot {
  mesh: THREE.InstancedMesh;
  state: THREE.InstancedBufferAttribute;
  count: number;
}

export interface AirRendererFrame {
  camera: THREE.Camera;
  time: number;
  /** 0 day … 1 night. */
  night: number;
  viewportHeight: number;
}

export interface AirRenderer {
  readonly group: THREE.Group;
  readonly shared: LightingUniforms;
  update(f: AirRendererFrame, entities: readonly AirEntity[], flares: FlarePool): void;
  stats(): { meshes: number; instances: number; dots: number; lights: number; discs: number; triangles: number };
  /** LOD chosen for an entity last frame (tests / QA), -1 = dot only. */
  lodOf(e: AirEntity): number;
  dispose(): void;
}

const tmpM = new THREE.Matrix4();
const tmpM2 = new THREE.Matrix4();
const tmpP = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();
const tmpS = new THREE.Vector3(1, 1, 1);
const tmpV = new THREE.Vector3();
const tmpD = new THREE.Vector3();
const camPos = new THREE.Vector3();
const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);

export function createAirRenderer(capacity = 24, cfg = CONFIG.combat.air.render): AirRenderer {
  const group = new THREE.Group();
  group.name = 'air.targets';
  const material = createAirMaterial();
  const shared = createLightingUniforms();
  const models = new Map<string, AirModel>();
  const fixtures = new Map<AirKind, AirFixtures>();
  const slots = new Map<string, Slot>();
  const key = (k: AirKind, part: AirPart, lod: AirLod) => `${k}.${part}.${lod}`;
  for (const kind of KINDS) {
    fixtures.set(kind, airFixtures(kind));
    for (const lod of [0, 1] as AirLod[]) {
      const m = buildAirModel(kind, lod);
      models.set(`${kind}.${lod}`, m);
      for (const part of PARTS[kind]) {
        const src = m.parts[part];
        if (!src) continue;
        const geo = src.clone();
        const state = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
        state.setUsage(THREE.DynamicDrawUsage);
        geo.setAttribute('aState', state);
        const mesh = new THREE.InstancedMesh(geo, material, capacity);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.count = 0;
        mesh.visible = false;
        mesh.frustumCulled = false;
        mesh.castShadow = lod === 0;
        mesh.receiveShadow = lod === 0;
        mesh.name = `air.${key(kind, part, lod)}`;
        slots.set(key(kind, part, lod), { mesh, state, count: 0 });
        group.add(mesh);
      }
    }
  }
  // Rotor blur discs.
  const discMat = createDiscMaterial(shared);
  const maxDiscs = 16;
  const discGeo = new THREE.CircleGeometry(1, 40);
  const discAttr = new THREE.InstancedBufferAttribute(new Float32Array(maxDiscs * 4), 4);
  discAttr.setUsage(THREE.DynamicDrawUsage);
  discGeo.setAttribute('aDisc', discAttr);
  const discs = new THREE.InstancedMesh(discGeo, discMat, maxDiscs);
  discs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  discs.frustumCulled = false;
  discs.count = 0;
  discs.name = 'air.rotors';
  group.add(discs);
  // Lights, flares, far dots.
  const pointMat = createPointMaterial(shared);
  const points = new PointBuffer(512);
  const pointsObj = new THREE.Points(points.geometry, pointMat);
  pointsObj.frustumCulled = false;
  pointsObj.name = 'air.lights';
  pointsObj.renderOrder = 2;
  group.add(pointsObj);

  const lods = new WeakMap<AirEntity, number>();
  const counts = { meshes: 0, instances: 0, dots: 0, lights: 0, discs: 0, triangles: 0 };
  const E = new THREE.Matrix4();

  const put = (slot: Slot, m: THREE.Matrix4, e: AirEntity) => {
    const i = slot.count;
    if (i >= capacity) return;
    slot.count++;
    slot.mesh.setMatrixAt(i, m);
    const a = slot.state.array as Float32Array;
    a[i * 4] = e.char;
    a[i * 4 + 1] = e.seed;
    a[i * 4 + 2] = SCHEME[e.kind];
    a[i * 4 + 3] = e.bort;
  };

  const lamp = (x: number, y: number, z: number, r: number, g: number, b: number, k: number, size: number, dx = 0, dy = 0, dz = 0, ex = 0) => {
    if (k <= 0) return;
    if (points.push(x, y, z, r * k, g * k, b * k, 0, size, 2.0, 0, dx, dy, dz, ex)) counts.lights++;
  };
  const at = (v: THREE.Vector3) => tmpV.copy(v).applyMatrix4(E);
  const dir = (x: number, y: number, z: number) => tmpD.set(x, y, z).transformDirection(E);

  const selectLod = (e: AirEntity, d: number): number => {
    const prev = lods.get(e) ?? 1;
    const [a, b] = cfg.lod;
    const h = cfg.lodHysteresis;
    let l = d < a ? 0 : d < b ? 1 : -1;
    if (l !== prev) {
      if (prev === 0 && d < a * (1 + h)) l = 0;
      else if (prev === 1 && d >= a * (1 - h) && d < b * (1 + h)) l = 1;
      else if (prev === -1 && d >= b * (1 - h)) l = -1;
    }
    lods.set(e, l);
    return l;
  };

  return {
    group,
    shared,
    update(f, entities, flares) {
      f.camera.getWorldPosition(camPos);
      shared.uTime.value = f.time;
      pointMat.uniforms.uHalfHeight.value = f.viewportHeight / 2;
      for (const s of slots.values()) s.count = 0;
      points.reset();
      discs.count = 0;
      counts.dots = 0;
      counts.lights = 0;
      const night = f.night;
      for (const e of entities) {
        if (e.phase === 'sunk') continue;
        const p = e.position;
        const d = Math.hypot(p.x - camPos.x, p.y - camPos.y, p.z - camPos.z);
        if (d > cfg.maxDrawM) continue;
        const kind = e.kind;
        const lod = selectLod(e, d);
        tmpP.set(p.x, p.y, p.z);
        tmpQ.set(e.orientation.x, e.orientation.y, e.orientation.z, e.orientation.w);
        E.compose(tmpP, tmpQ, tmpS);
        const alive = e.phase === 'flying';
        const fx = fixtures.get(kind)!;
        const part = e.fall?.part ?? null;
        if (lod >= 0) {
          const L = lod as AirLod;
          for (const name of PARTS[kind]) {
            const slot = slots.get(key(kind, name, L));
            if (!slot) continue;
            if (name === 'body') put(slot, E, e);
            else if (name === 'blades') {
              if (e.phase === 'wreck') put(slot, E, e);
            } else if (part && part.which === name) {
              // separated: its own tumbling pose about its pivot
              const pv = PART_PIVOT[kind][name] ?? [0, 0, 0];
              tmpM.makeTranslation(-pv[0], -pv[1], -pv[2]);
              tmpQ2.set(part.q.x, part.q.y, part.q.z, part.q.w);
              tmpM2.compose(tmpV.set(part.x, part.y, part.z), tmpQ2, tmpS).multiply(tmpM);
              put(slot, tmpM2, e);
            } else if (name !== 'tailRotor') put(slot, E, e);
          }
        }
        // Rotor discs (spinning), near enough to matter.
        if (fx.rotors.length && e.rotor > 0.05 && d < 4000 && lod >= 0) {
          for (let k = 0; k < fx.rotors.length; k++) {
            const r = fx.rotors[k];
            if (r.axis === 'x' && part && part.which === 'tailRotor') continue;
            const i = discs.count;
            if (i >= maxDiscs) break;
            if (r.axis === 'y') tmpQ2.setFromAxisAngle(AXIS_X, -Math.PI / 2);
            else tmpQ2.setFromAxisAngle(AXIS_Y, Math.PI / 2);
            tmpM2.compose(r.hub, tmpQ2, tmpV.set(r.radius, r.radius, r.radius));
            discs.setMatrixAt(i, tmpM2.premultiply(E));
            const near = 1 - Math.min(1, Math.max(0, (d - 2800) / 1200));
            discAttr.setXYZW(i, r.blades, e.rotorPhase + k * 0.9, 0.9 * near * Math.min(1, 0.3 + e.rotor), 0.25);
            discs.count = i + 1;
          }
        }
        // Far: a dot the size of the aircraft (dims below its minimum pixel size).
        if (d > cfg.dotFromM) {
          const len = CONFIG.combat.targets[kind].length;
          if (points.push(p.x, p.y, p.z, 0.16, 0.17, 0.18, 1, len * 0.38, cfg.dotMinPx, 2)) counts.dots++;
        }
        if (!alive) continue;
        // Nav lights (directional), beacons (double flash on top/bottom), engines' dull glow aft.
        const nav = 1400 * (0.08 + 0.92 * night);
        at(fx.navRed);
        dir(-1, 0, -0.25);
        lamp(tmpV.x, tmpV.y, tmpV.z, 1, 0.05, 0.02, nav, 0.3, tmpD.x, tmpD.y, tmpD.z, 1.2);
        at(fx.navGreen);
        dir(1, 0, -0.25);
        lamp(tmpV.x, tmpV.y, tmpV.z, 0.1, 1, 0.4, nav, 0.3, tmpD.x, tmpD.y, tmpD.z, 1.2);
        at(fx.navWhite);
        dir(0, 0, 1);
        lamp(tmpV.x, tmpV.y, tmpV.z, 1, 0.95, 0.85, nav * 0.8, 0.3, tmpD.x, tmpD.y, tmpD.z, 1.5);
        const ph = f.time * 0.9 + e.seed * 7.3;
        const bf = ph - Math.floor(ph);
        if (bf < 0.1 || (bf > 0.22 && bf < 0.3)) {
          for (const b of fx.beacons) {
            at(b);
            lamp(tmpV.x, tmpV.y, tmpV.z, 1, 0.06, 0.02, 4500 * (0.3 + 0.7 * night), 0.35);
          }
        }
        if (fx.nozzles.length && d < 6000) {
          const hot = 22 * (0.6 + 0.4 * Math.min(1, e.flight.speed / 200));
          for (const n of fx.nozzles) {
            at(n);
            dir(0, 0, 1);
            lamp(tmpV.x, tmpV.y, tmpV.z, 1, 0.36, 0.1, hot, fx.nozzleRadius * 2, tmpD.x, tmpD.y, tmpD.z, 3);
          }
        }
      }
      // Burning flares: blinding white-hot points.
      for (const fl of flares.items) {
        if (!fl.on) continue;
        const burn = 1 - fl.age / fl.life;
        lamp(fl.x, fl.y, fl.z, 1, 0.93, 0.8, 9000 * (0.35 + 0.65 * burn), 0.5);
      }
      points.commit();
      counts.meshes = 0;
      counts.instances = 0;
      counts.triangles = 0;
      for (const s of slots.values()) {
        s.mesh.count = s.count;
        s.mesh.visible = s.count > 0;
        if (s.count === 0) continue;
        counts.meshes++;
        counts.instances += s.count;
        counts.triangles += s.count * ((s.mesh.geometry.index?.count ?? 0) / 3);
        s.mesh.instanceMatrix.needsUpdate = true;
        s.state.needsUpdate = true;
      }
      discs.visible = discs.count > 0;
      if (discs.count > 0) {
        discs.instanceMatrix.needsUpdate = true;
        discAttr.needsUpdate = true;
      }
      counts.discs = discs.count;
    },
    stats: () => ({ ...counts }),
    lodOf: (e) => lods.get(e) ?? -1,
    dispose() {
      for (const s of slots.values()) {
        s.mesh.geometry.dispose();
        s.mesh.dispose();
      }
      material.dispose();
      discGeo.dispose();
      discMat.dispose();
      points.dispose();
      pointMat.dispose();
      group.removeFromParent();
    },
  };
}
