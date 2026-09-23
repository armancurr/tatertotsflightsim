/**
 * Draws the missiles in flight: a small AGM-65 shape (body, glass seeker dome, long-chord wings,
 * tail fins), a bright motor flame and a grey-white smoke trail that lingers, spreads and rises.
 * Everything is pooled — no allocations per frame.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ensureAtmosphericFogUniforms } from '../render/fog';
import type { Vec3 } from '../types';

const TRAIL_CAP = 900;
const TRAIL_LIFE = 9;
const TRAIL_SPACING = 4;

export interface MissileRenderer {
  readonly object: THREE.Group;
  /** Show missile `slot` at `pos` pointing along `dir` (unit), or hide it (null). */
  setMissile(slot: number, pos: Vec3 | null, dir?: Vec3): void;
  /** Emit trail puffs along the segment the missile flew this frame. */
  trail(from: Vec3, to: Vec3): void;
  /** Age the trail (dt = 0 while paused) and size it for the screen. */
  update(dt: number, viewportHeight: number): void;
  clear(): void;
  stats(): { puffs: number; visible: number };
  dispose(): void;
}

function missileGeometry(length: number, diameter: number): THREE.BufferGeometry {
  const r = diameter / 2;
  const parts: THREE.BufferGeometry[] = [];
  const body = new THREE.CylinderGeometry(r, r, length * 0.92, 16, 1, false);
  body.rotateX(Math.PI / 2); // along Z
  body.translate(0, 0, 0.04 * length);
  parts.push(body);
  // Long-chord cruciform wings (the Maverick's delta strakes) and small tail fins.
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + Math.PI / 4;
    const wing = new THREE.BoxGeometry(0.012, 0.19, length * 0.42);
    wing.translate(0, r + 0.09, length * 0.08);
    wing.rotateZ(a);
    parts.push(wing);
    const fin = new THREE.BoxGeometry(0.01, 0.16, 0.2);
    fin.translate(0, r + 0.07, length * 0.44);
    fin.rotateZ(a);
    parts.push(fin);
  }
  const g = mergeGeometries(parts.map((p) => p.toNonIndexed()), false)!;
  parts.forEach((p) => p.dispose());
  return g;
}

function radialTexture(): THREE.CanvasTexture | THREE.DataTexture {
  const n = 64;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const d = Math.hypot(x - n / 2 + 0.5, y - n / 2 + 0.5) / (n / 2);
      const a = Math.max(0, 1 - d) ** 2;
      const i = (y * n + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.round(a * 255);
    }
  }
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  t.needsUpdate = true;
  return t;
}

const TRAIL_VERT = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute float aSeed;
uniform float uScale;
varying float vAlpha;
varying float vSeed;
#include <fog_pars_vertex>
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = clamp(aSize * uScale / max(-mvPosition.z, 0.5), 0.0, 400.0);
  vAlpha = aAlpha;
  vSeed = aSeed;
  #include <fog_vertex>
}
`;

const TRAIL_FRAG = /* glsl */ `
uniform vec3 uColor;
varying float vAlpha;
varying float vSeed;
#include <fog_pars_fragment>
float h(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + vSeed * 43.7) * 43758.5453); }
float n2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y);
}
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float d = length(p);
  float edge = 1.0 - smoothstep(0.35, 1.0, d + (n2(p * 3.0 + vSeed * 7.0) - 0.5) * 0.45);
  float a = vAlpha * edge;
  if (a < 0.003) discard;
  // Lit from above: brighter top, darker belly.
  vec3 c = uColor * (0.8 + 0.35 * (-p.y));
  #ifdef TONE_MAPPING
    c = toneMapping(c);
  #endif
  gl_FragColor = vec4(linearToOutputTexel(vec4(c, 1.0)).rgb, a);
  #include <fog_fragment>
}
`;

export function createMissileRenderer(opts: { length: number; diameter: number; slots: number }): MissileRenderer {
  const object = new THREE.Group();
  object.name = 'missiles';

  // ── Missile bodies ───────────────────────────────────────────────────────
  const geo = missileGeometry(opts.length, opts.diameter);
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x5c6146, roughness: 0.55, metalness: 0.2 });
  const domeGeo = new THREE.SphereGeometry(opts.diameter / 2, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  domeGeo.rotateX(-Math.PI / 2);
  domeGeo.translate(0, 0, -opts.length * 0.42);
  const domeMat = new THREE.MeshStandardMaterial({ color: 0x1b2230, roughness: 0.08, metalness: 0.6 });
  const tex = radialTexture();
  const flameMat = new THREE.SpriteMaterial({ map: tex, color: new THREE.Color(9, 5.2, 2.2), blending: THREE.AdditiveBlending, depthWrite: false, fog: true });
  const slots: { group: THREE.Group; flame: THREE.Sprite }[] = [];
  for (let i = 0; i < opts.slots; i++) {
    const group = new THREE.Group();
    const body = new THREE.Mesh(geo, bodyMat);
    body.castShadow = true;
    group.add(body, new THREE.Mesh(domeGeo, domeMat));
    const flame = new THREE.Sprite(flameMat);
    flame.scale.set(1.1, 1.1, 1);
    flame.position.set(0, 0, opts.length * 0.55);
    group.add(flame);
    group.visible = false;
    object.add(group);
    slots.push({ group, flame });
  }
  const fwd = new THREE.Vector3(0, 0, -1);
  const dirV = new THREE.Vector3();

  // ── Smoke trail (pooled points) ─────────────────────────────────────────
  const pos = new Float32Array(TRAIL_CAP * 3);
  const size = new Float32Array(TRAIL_CAP);
  const alpha = new Float32Array(TRAIL_CAP);
  const seed = new Float32Array(TRAIL_CAP);
  const age = new Float32Array(TRAIL_CAP).fill(TRAIL_LIFE);
  const tgeo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const sizeAttr = new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage);
  const alphaAttr = new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage);
  tgeo.setAttribute('position', posAttr);
  tgeo.setAttribute('aSize', sizeAttr);
  tgeo.setAttribute('aAlpha', alphaAttr);
  tgeo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  const tmat = new THREE.ShaderMaterial({
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), uScale: { value: 500 }, uColor: { value: new THREE.Color(0.42, 0.42, 0.4) } },
    vertexShader: TRAIL_VERT,
    fragmentShader: TRAIL_FRAG,
    transparent: true,
    depthWrite: false,
    fog: true,
  });
  ensureAtmosphericFogUniforms(tmat);
  const points = new THREE.Points(tgeo, tmat);
  points.frustumCulled = false;
  points.name = 'missile-trail';
  object.add(points);
  let head = 0;
  let live = 0;
  let carry = 0;
  let rnd = 0x9e3779b9;
  const rand = () => {
    rnd = (rnd + 0x6d2b79f5) >>> 0;
    let t = rnd;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    object,
    setMissile(slot, p, dir) {
      const s = slots[slot];
      if (!s) return;
      if (!p) {
        s.group.visible = false;
        return;
      }
      s.group.visible = true;
      s.group.position.set(p.x, p.y, p.z);
      if (dir) {
        dirV.set(dir.x, dir.y, dir.z);
        s.group.quaternion.setFromUnitVectors(fwd, dirV);
      }
      const f = 0.9 + 0.35 * rand();
      s.flame.scale.set(f, f * 1.1, 1);
    },
    trail(from, to) {
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const dz = to.z - from.z;
      const len = Math.hypot(dx, dy, dz);
      if (!(len > 0) || !Number.isFinite(len)) return;
      let d = TRAIL_SPACING - carry;
      for (; d <= len; d += TRAIL_SPACING) {
        const k = d / len;
        const i = head;
        head = (head + 1) % TRAIL_CAP;
        pos[i * 3] = from.x + dx * k + (rand() - 0.5) * 0.4;
        pos[i * 3 + 1] = from.y + dy * k + (rand() - 0.5) * 0.4;
        pos[i * 3 + 2] = from.z + dz * k + (rand() - 0.5) * 0.4;
        age[i] = 0;
        seed[i] = rand();
      }
      carry = len - (d - TRAIL_SPACING);
      (tgeo.getAttribute('aSeed') as THREE.BufferAttribute).needsUpdate = true;
    },
    update(dt, viewportHeight) {
      const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
      live = 0;
      for (let i = 0; i < TRAIL_CAP; i++) {
        if (age[i] >= TRAIL_LIFE) {
          alpha[i] = 0;
          size[i] = 0;
          continue;
        }
        age[i] += step;
        const u = Math.min(1, age[i] / TRAIL_LIFE);
        pos[i * 3 + 1] += step * 0.7 * (1 - u); // warm exhaust rises a little
        size[i] = 1.2 + 9 * Math.sqrt(u);
        alpha[i] = 0.62 * (1 - u) * (1 - u) * Math.min(1, age[i] * 8 + 0.3);
        live++;
      }
      tmat.uniforms.uScale.value = viewportHeight * 0.5 * 1.7;
      posAttr.needsUpdate = true;
      sizeAttr.needsUpdate = true;
      alphaAttr.needsUpdate = true;
    },
    clear() {
      age.fill(TRAIL_LIFE);
      carry = 0;
      slots.forEach((s) => (s.group.visible = false));
    },
    stats: () => ({ puffs: live, visible: slots.filter((s) => s.group.visible).length }),
    dispose() {
      geo.dispose();
      domeGeo.dispose();
      bodyMat.dispose();
      domeMat.dispose();
      flameMat.dispose();
      tex.dispose();
      tgeo.dispose();
      tmat.dispose();
      object.removeFromParent();
    },
  };
}
