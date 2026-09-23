/**
 * F110-GE-129 exhaust: 16 external nozzle petals with the divergent flaps inside (one instanced
 * mesh; the petals converge at military power and open wide in afterburner / at idle), the
 * augmentor liner and flame holders deep inside (glowing with heat), and the afterburner plume —
 * nested additive cones with a white-hot core, orange flame with shock diamonds and a faint
 * outer haze, flickering; scaled by the afterburner intensity.
 */
import * as THREE from 'three';
import { tint, merge } from '../materials';
import { NOZZLE } from './shape';
import { tube, V } from './geom';

const N = NOZZLE.petals;
const LEN = NOZZLE.exitZ - NOZZLE.baseZ;

/** Exit radius for a nozzle opening 0 (military) … 1 (fully open). */
export function nozzleExitRadius(open: number): number {
  const o = Math.max(0, Math.min(1, open));
  return NOZZLE.exitRadiusMin + (NOZZLE.exitRadiusMax - NOZZLE.exitRadiusMin) * o;
}

/** One petal (outer flap + inner divergent flap), hinge at the origin, extending along +z, radial +y. */
function petalGeometry(): THREE.BufferGeometry {
  const r = NOZZLE.baseRadius;
  const half = (Math.PI / N) * 1.0; // flaps meet at the base; they taper, opening dark gaps aft
  const segU = 4;
  const segV = 6;
  const shell = (radius: number, taper: number, hex: number, rough: number, metal: number, heat: number, inward: boolean) => {
    const pos: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    const c = new THREE.Color(hex);
    for (let j = 0; j <= segV; j++) {
      const t = j / segV;
      const z = t * LEN;
      const w = half * (1 - taper * t);
      for (let i = 0; i <= segU; i++) {
        const a = -w + (2 * w * i) / segU;
        // A stiffening ridge down the middle of each outer flap.
        const rr = radius + (!inward && i === segU / 2 ? 0.012 : 0);
        pos.push(Math.sin(a) * rr, Math.cos(a) * rr - r, z);
        // Heat staining toward the exit on the outside; bands on the petal.
        const k = 1 - 0.28 * t * (inward ? 0 : 1) - (i === 0 || i === segU ? 0.12 : 0);
        col.push(c.r * k, c.g * k, c.b * k * (1 + 0.12 * t));
      }
    }
    for (let j = 0; j < segV; j++) {
      for (let i = 0; i < segU; i++) {
        const a = j * (segU + 1) + i;
        const b = a + 1;
        const d = a + segU + 1;
        const e = d + 1;
        if (inward) idx.push(a, b, d, b, e, d);
        else idx.push(a, d, b, b, d, e);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const count = pos.length / 3;
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const rm = new Float32Array(count * 2);
    const ht = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      rm[i * 2] = rough;
      rm[i * 2 + 1] = metal;
      ht[i] = heat * (0.4 + 0.6 * (pos[i * 3 + 2] / LEN));
    }
    g.setAttribute('rm', new THREE.BufferAttribute(rm, 2));
    g.setAttribute('heat', new THREE.BufferAttribute(ht, 1));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    return g;
  };
  const outer = shell(r, 0.06, 0x8a867e, 0.45, 0.8, 0, false);
  const inner = shell(r - 0.022, 0.02, 0x2e2925, 0.7, 0.6, 0.7, true);
  // Petal edge (the trailing lip) — a thin strip closing outer to inner at the exit.
  const out = mergeWithHeat([outer, inner]);
  return out;
}

function mergeWithHeat(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let v = 0;
  let ix = 0;
  for (const g of list) {
    v += g.getAttribute('position').count;
    ix += g.getIndex()!.count;
  }
  const out = new THREE.BufferGeometry();
  const names = ['position', 'normal', 'color', 'rm', 'heat', 'uv'] as const;
  const sizes = { position: 3, normal: 3, color: 3, rm: 2, heat: 1, uv: 2 };
  for (const n of names) {
    const arr = new Float32Array(v * sizes[n]);
    let o = 0;
    for (const g of list) {
      const a = g.getAttribute(n).array as Float32Array;
      arr.set(a, o);
      o += a.length;
    }
    out.setAttribute(n, new THREE.BufferAttribute(arr, sizes[n]));
  }
  const idx = new Uint32Array(ix);
  let o = 0;
  let base = 0;
  for (const g of list) {
    const a = g.getIndex()!;
    for (let k = 0; k < a.count; k++) idx[o + k] = a.getX(k) + base;
    o += a.count;
    base += g.getAttribute('position').count;
  }
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

/** Heat-glow parts material: vertex colours, per-vertex roughness/metalness, emissive from `heat` × uHeat. */
export function createNozzleMaterial(): { material: THREE.MeshStandardMaterial; heat: { value: number } } {
  const heat = { value: 0 };
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, name: 'f16.nozzle' });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uHeat = heat;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 rm;\nattribute float heat;\nvarying vec2 vRM;\nvarying float vHeat;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRM = rm;\nvHeat = heat;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uHeat;\nvarying vec2 vRM;\nvarying float vHeat;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vRM.x;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vRM.y;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        float hk = vHeat * uHeat;
        // Blackbody-ish: dull red at military power, orange-white in afterburner.
        vec3 hot = mix(vec3(0.9, 0.18, 0.03), vec3(1.6, 0.95, 0.45), smoothstep(0.55, 1.0, uHeat));
        totalEmissiveRadiance += hot * hk * hk * (0.5 + 1.7 * smoothstep(0.6, 1.0, uHeat));`,
      );
  };
  m.customProgramCacheKey = () => 'f16-nozzle-heat';
  return { material: m, heat };
}

export interface NozzleBuild {
  group: THREE.Group;
  petals: THREE.InstancedMesh;
  interior: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  heat: { value: number };
  setOpen(open: number): void;
}

export function buildNozzle(name: string): NozzleBuild {
  const { material, heat } = createNozzleMaterial();
  const group = new THREE.Group();
  group.name = name;
  group.position.set(0, NOZZLE.axisY, NOZZLE.baseZ);
  const petals = new THREE.InstancedMesh(petalGeometry(), material, N);
  petals.name = `${name}.petals`;
  petals.castShadow = true;
  petals.receiveShadow = true;
  petals.frustumCulled = false;
  // Alternating flaps and seals: two tones of heat-worn metal.
  const tone = new THREE.Color();
  for (let k = 0; k < N; k++) petals.setColorAt(k, tone.setScalar(k % 2 === 0 ? 1 : 0.62));
  group.add(petals);

  // Interior (seen looking up the nozzle): flame-holder rings, the turbine exit cone and a dark
  // augmentor back wall, all just aft of the fuselage end cap.
  const r = NOZZLE.baseRadius;
  const parts: THREE.BufferGeometry[] = [];
  const back = new THREE.CircleGeometry(r - 0.01, 32);
  back.translate(0, 0, 0.07);
  parts.push(back);
  const ring1 = new THREE.TorusGeometry(r * 0.64, 0.02, 6, 32);
  ring1.translate(0, 0, 0.13);
  parts.push(ring1);
  const ring2 = new THREE.TorusGeometry(r * 0.36, 0.018, 6, 24);
  ring2.translate(0, 0, 0.15);
  parts.push(ring2);
  const cone = new THREE.ConeGeometry(r * 0.27, 0.36, 20, 1);
  cone.rotateX(Math.PI / 2);
  cone.translate(0, 0, 0.25);
  parts.push(cone);
  const sp: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    sp.push(tube(V(Math.cos(a) * r * 0.2, Math.sin(a) * r * 0.2, 0.14), V(Math.cos(a) * r * 0.9, Math.sin(a) * r * 0.9, 0.12), 0.012, 0.012, 5));
  }
  parts.push(merge(sp.map((g) => tint(g, 0x3a3430, 0.8, 0.4))));
  const hk = [0.65, 1, 1, 0.8, 0.9];
  const cols = [0x0e0c0b, 0x3a3430, 0x3a3430, 0x2a2622, 0x3a3430];
  const withAttrs = parts.map((g, i) => {
    const t = tint(g, cols[i], 0.8, 0.4);
    const n = t.getAttribute('position').count;
    t.setAttribute('heat', new THREE.BufferAttribute(new Float32Array(n).fill(hk[i]), 1));
    return t;
  });
  const interiorGeo = mergeWithHeat(withAttrs);
  const interior = new THREE.Mesh(interiorGeo, material);
  interior.name = `${name}.interior`;
  group.add(interior);

  // A nozzle mounting ring (hides the joint with the fuselage end).
  const ringGeo = tint(tube(V(0, 0, -0.06), V(0, 0, 0.05), r + 0.015, r + 0.01, 32, true), 0x4c4b48, 0.5, 0.7);
  ringGeo.setAttribute('heat', new THREE.BufferAttribute(new Float32Array(ringGeo.getAttribute('position').count), 1));
  const ring = new THREE.Mesh(mergeWithHeat([ringGeo]), material);
  ring.castShadow = true;
  group.add(ring);

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3(1, 1, 1);
  const qt = new THREE.Quaternion();
  const X = V(1, 0, 0);
  let last = -1;
  const setOpen = (open: number) => {
    const o = Math.round(Math.max(0, Math.min(1, open)) * 400) / 400;
    if (o === last) return;
    last = o;
    const tilt = Math.atan2(r - nozzleExitRadius(o), LEN);
    for (let k = 0; k < N; k++) {
      const a = (k / N) * Math.PI * 2;
      // Position the hinge on the base ring, then converge (rotate about the petal's local x).
      p.set(Math.sin(a) * r, Math.cos(a) * r, 0);
      e.set(0, 0, -a);
      q.setFromEuler(e);
      q.multiply(qt.setFromAxisAngle(X, tilt));
      m.compose(p, q, s);
      petals.setMatrixAt(k, m);
    }
    petals.instanceMatrix.needsUpdate = true;
  };
  setOpen(1);
  return { group, petals, interior, material, heat, setOpen };
}

// ─── Afterburner plume ───────────────────────────────────────────────────────

export const PLUME_LENGTH = 5.5;
/** Shock-diamond spacing (m). */
const DIAMOND = 0.62;

/** Nested open cones along +z (local), radii profile per layer; attribute `layer` 0 core … 2 haze. */
function plumeGeometry(): THREE.BufferGeometry {
  const layers = [
    { r0: 0.27, r1: 0.05, len: 0.62, seg: 48 },
    { r0: 0.42, r1: 0.15, len: 0.85, seg: 36 },
    { r0: 0.5, r1: 0.62, len: 1.0, seg: 20 },
  ];
  const pos: number[] = [];
  const nor: number[] = [];
  const lay: number[] = [];
  const ax: number[] = [];
  const idx: number[] = [];
  const radial = 20;
  layers.forEach((L, li) => {
    const base = pos.length / 3;
    for (let j = 0; j <= L.seg; j++) {
      const t = j / L.seg;
      const z = t * L.len * PLUME_LENGTH;
      // Shock-diamond pinches on the core (the expansion/compression cells), fading downstream.
      const pinch = li === 0 ? 1 - 0.5 * (0.5 + 0.5 * Math.cos((z * Math.PI * 2) / DIAMOND)) * (1 - 0.6 * t) : 1;
      const r = (L.r0 + (L.r1 - L.r0) * Math.pow(t, li === 2 ? 0.8 : 1.15)) * pinch;
      for (let i = 0; i <= radial; i++) {
        const a = (i / radial) * Math.PI * 2;
        pos.push(Math.cos(a) * r, Math.sin(a) * r, z);
        nor.push(Math.cos(a), Math.sin(a), (L.r0 - L.r1) / (L.len * PLUME_LENGTH));
        lay.push(li);
        ax.push(t * L.len);
      }
    }
    for (let j = 0; j < L.seg; j++) {
      for (let i = 0; i < radial; i++) {
        const a = base + j * (radial + 1) + i;
        const b = a + 1;
        const c = a + radial + 1;
        const d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('layer', new THREE.Float32BufferAttribute(lay, 1));
  g.setAttribute('axial', new THREE.Float32BufferAttribute(ax, 1));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(V(0, 0, PLUME_LENGTH * 0.5), PLUME_LENGTH * 0.6);
  return g;
}

export interface PlumeBuild {
  mesh: THREE.Mesh;
  uniforms: { uTime: { value: number }; uAB: { value: number }; uLen: { value: number } };
}

export function buildPlume(name: string): PlumeBuild {
  const uniforms = { uTime: { value: 0 }, uAB: { value: 0 }, uLen: { value: 1 } };
  const mat = new THREE.ShaderMaterial({
    name: 'f16.plume',
    uniforms,
    vertexShader: /* glsl */ `
      attribute float layer;
      attribute float axial;
      uniform float uTime;
      uniform float uLen;
      varying float vLayer;
      varying float vAxial;
      varying float vFacing;
      varying float vZ;
      void main() {
        vLayer = layer;
        vAxial = axial;
        vec3 p = position;
        // Turbulent wobble grows downstream.
        float w = axial * axial * 0.18;
        p.x += sin(uTime * 31.0 + p.z * 3.1) * w;
        p.y += cos(uTime * 27.0 + p.z * 2.7) * w;
        p.z *= uLen;
        vZ = p.z;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vec3 n = normalize(normalMatrix * normal);
        vFacing = abs(dot(n, normalize(-mv.xyz)));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uAB;
      varying float vLayer;
      varying float vAxial;
      varying float vFacing;
      varying float vZ;
      void main() {
        float flick = 0.86 + 0.14 * sin(uTime * 53.0 + vZ * 4.0) * sin(uTime * 37.0 + 1.7);
        // Shock diamonds: bright compression nodes every ~0.62 m, fading downstream.
        float d = 0.5 + 0.5 * cos(vZ * 6.2831 / ${DIAMOND.toFixed(3)});
        float diamonds = pow(d, 6.0) * smoothstep(0.03, 0.08, vAxial) * (1.0 - smoothstep(0.15, 0.5, vAxial));
        float soft = pow(vFacing, 1.5);
        vec3 col;
        float a;
        if (vLayer < 0.5) {
          // Core: yellow-white at the exit with pink-white Mach disks, turning orange.
          float t = vAxial / 0.62;
          col = mix(vec3(1.9, 1.5, 1.05), vec3(1.6, 0.75, 0.28), smoothstep(0.0, 0.6, t));
          col += vec3(1.7, 1.1, 1.0) * diamonds * 1.6;
          a = (1.0 - smoothstep(0.15, 1.0, t)) * soft * (0.22 + 1.1 * diamonds);
        } else if (vLayer < 1.5) {
          // Flame envelope: translucent orange, redder downstream.
          float t = vAxial / 0.85;
          col = mix(vec3(1.4, 0.6, 0.2), vec3(0.85, 0.2, 0.07), smoothstep(0.0, 0.8, t));
          a = (1.0 - smoothstep(0.2, 1.0, t)) * soft * 0.3;
        } else {
          // Outer haze: faint warm glow.
          col = vec3(0.8, 0.3, 0.12);
          a = (1.0 - smoothstep(0.0, 1.0, vAxial)) * soft * 0.06;
        }
        a *= smoothstep(0.0, 0.02, vAxial + 0.001) * flick * uAB;
        gl_FragColor = vec4(col * a, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(plumeGeometry(), mat);
  mesh.name = name;
  mesh.position.set(0, NOZZLE.axisY, NOZZLE.exitZ - 0.02);
  mesh.renderOrder = 4;
  mesh.userData.noBounds = true;
  mesh.visible = false;
  return { mesh, uniforms };
}
