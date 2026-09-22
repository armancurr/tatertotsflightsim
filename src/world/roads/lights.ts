/**
 * Street lights along town streets: one instanced mesh (tapered pole, arm and
 * a cobra-head luminaire whose lens glows warm when the sun is low) plus a
 * points layer of soft glows at the lamps. Only the lights within
 * `streetLightDistance` of the camera are instanced; the set is refreshed when
 * the camera has moved (grid buckets, no per-frame allocation).
 */
import * as THREE from 'three';
import { CONFIG } from '../../config';
import { DEPTH_GLSL } from './depth';

export interface StreetLights {
  update(camera: THREE.PerspectiveCamera, level: number): void;
  readonly count: number;
  readonly drawn: number;
  dispose(): void;
}

/** 0..1: lamps on at dawn/dusk (sun below ~14°), off in daylight. */
export function streetLightLevel(sunElevationDeg: number): number {
  if (!(sunElevationDeg === sunElevationDeg)) return 1;
  const t = Math.max(0, Math.min(1, (sunElevationDeg - 3) / (14 - 3)));
  return 1 - t * t * (3 - 2 * t);
}

const POLE_H = 8.5;
const viewportHeight = (): number => (typeof innerHeight === 'number' && innerHeight > 0 ? innerHeight * Math.min(2, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) : 900);
const ARM = 1.9;

/** Pole + arm + luminaire, local frame: base at the origin, the arm along −z (toward the road). Colour attribute: rgb, alpha = lamp (emissive) mask. */
export function streetLightGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const paint = (g: THREE.BufferGeometry, r: number, gg: number, b: number, lamp: number) => {
    const n = g.getAttribute('position').count;
    const c = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) c.set([r, gg, b, lamp], i * 4);
    g.setAttribute('color', new THREE.BufferAttribute(c, 4));
    return g.index ? g.toNonIndexed() : g;
  };
  const pole = new THREE.CylinderGeometry(0.075, 0.12, POLE_H, 8, 1, true);
  pole.translate(0, POLE_H / 2, 0);
  parts.push(paint(pole, 0.32, 0.33, 0.34, 0));
  const base = new THREE.CylinderGeometry(0.2, 0.24, 0.5, 8);
  base.translate(0, 0.25, 0);
  parts.push(paint(base, 0.28, 0.28, 0.29, 0));
  // arm: a slightly rising tube toward −z
  const arm = new THREE.CylinderGeometry(0.045, 0.055, ARM, 6, 1, true);
  arm.rotateX(Math.PI / 2 - 0.12);
  arm.translate(0, POLE_H - 0.05 + Math.sin(0.12) * ARM * 0.5, -ARM / 2);
  parts.push(paint(arm, 0.32, 0.33, 0.34, 0));
  // cobra head housing + lens
  const head = new THREE.BoxGeometry(0.34, 0.16, 0.72);
  head.translate(0, POLE_H + 0.12, -ARM - 0.25);
  parts.push(paint(head, 0.42, 0.43, 0.44, 0));
  const lens = new THREE.BoxGeometry(0.26, 0.04, 0.52);
  lens.translate(0, POLE_H + 0.02, -ARM - 0.25);
  parts.push(paint(lens, 0.9, 0.85, 0.7, 1));
  const merged = mergeNonIndexed(parts);
  merged.computeVertexNormals();
  merged.computeBoundingSphere();
  return merged;
}

function mergeNonIndexed(gs: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let n = 0;
  for (const g of gs) n += g.getAttribute('position').count;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 4);
  let o = 0;
  for (const g of gs) {
    const p = g.getAttribute('position');
    const c = g.getAttribute('color');
    pos.set(p.array as Float32Array, o * 3);
    col.set(c.array as Float32Array, o * 4);
    o += p.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 4));
  return out;
}

export function createStreetLights(scene: THREE.Scene, data: Float32Array, capacity = 2400): StreetLights {
  const rc = CONFIG.world.towns.roads;
  const count = data.length / 4;
  // grid buckets
  const CELL = 256;
  const buckets = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const k = Math.floor(data[i * 4] / CELL) * 65536 + Math.floor(data[i * 4 + 2] / CELL);
    let l = buckets.get(k);
    if (!l) buckets.set(k, (l = []));
    l.push(i);
  }
  const geo = streetLightGeometry();
  const uLevel = { value: 0 };
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.5, fog: true });
  mat.name = 'street-lights';
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uLampLevel = uLevel;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vLamp;')
      .replace('#include <color_vertex>', '#include <color_vertex>\nvLamp = color.a;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vLamp;\nuniform float uLampLevel;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3( 1.0, 0.72, 0.42 ) * 38.0 * uLampLevel * vLamp;');
  };
  mat.customProgramCacheKey = () => 'street-lights-v1';
  const mesh = new THREE.InstancedMesh(geo, mat, capacity);
  mesh.name = 'street-lights';
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;

  // glows: screen-sized soft sprites (warm), additive
  const glowPos = new Float32Array(capacity * 3);
  const glowGeo = new THREE.BufferGeometry();
  glowGeo.setAttribute('position', new THREE.BufferAttribute(glowPos, 3));
  glowGeo.setDrawRange(0, 0);
  glowGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  const glowMat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uLevel: { value: 0 }, uPx: { value: 1 }, uLodLift: { value: [0, 0, 0, 0, 0, 0, 0, 0] }, uDepthPull: { value: rc.depthPull } }]),
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      ${DEPTH_GLSL}
      uniform float uPx;
      varying float vFade;
      void main() {
        vec3 transformed = position;
        vec4 mvPosition = modelViewMatrix * vec4( transformed, 1.0 );
        float d = -mvPosition.z;
        gl_Position = projectionMatrix * roadPull( mvPosition );
        // ~1.2 m halo in world size, clamped to 2.5–26 px
        float px = 1.2 * uPx / max( d, 1.0 );
        gl_PointSize = clamp( px, 2.5, 26.0 );
        vFade = clamp( px / 2.5, 0.35, 1.0 );
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      uniform float uLevel;
      varying float vFade;
      void main() {
        vec2 c = gl_PointCoord * 2.0 - 1.0;
        float r2 = dot( c, c );
        if ( r2 > 1.0 ) discard;
        float a = exp( -r2 * 5.0 ) * uLevel * vFade;
        gl_FragColor = vec4( vec3( 1.0, 0.68, 0.36 ) * 9.0 * a, 1.0 );
        #include <fog_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: true,
  });
  const glows = new THREE.Points(glowGeo, glowMat);
  glows.name = 'street-light-glows';
  glows.frustumCulled = false;
  glows.visible = false;
  const group = new THREE.Group();
  group.name = 'street-lights';
  group.add(mesh, glows);
  scene.add(group);

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const pv = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  let lastX = Infinity;
  let lastZ = Infinity;
  let drawn = 0;
  const R = rc.streetLightDistance;
  // bucket offsets, nearest ring first (so the capacity cuts the farthest lights)
  const reach = Math.ceil(R / CELL);
  const ring: [number, number][] = [];
  for (let dj = -reach; dj <= reach; dj++) for (let di = -reach; di <= reach; di++) if (Math.hypot(di, dj) <= reach + 1) ring.push([di, dj]);
  ring.sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]));
  const refill = (cx: number, cz: number) => {
    let n = 0;
    const bi = Math.floor(cx / CELL);
    const bj = Math.floor(cz / CELL);
    for (let o = 0; o < ring.length && n < capacity; o++) {
        const l = buckets.get((bi + ring[o][0]) * 65536 + (bj + ring[o][1]));
        if (!l) continue;
        for (let k = 0; k < l.length && n < capacity; k++) {
          const i = l[k];
          const x = data[i * 4];
          const z = data[i * 4 + 2];
          if ((x - cx) ** 2 + (z - cz) ** 2 > R * R) continue;
          const y = data[i * 4 + 1];
          q.setFromAxisAngle(up, data[i * 4 + 3]);
          m.compose(pv.set(x, y, z), q, one);
          mesh.setMatrixAt(n, m);
          // lamp position: the arm points along local −z
          const yaw = data[i * 4 + 3];
          glowPos[n * 3] = x - Math.sin(yaw) * (ARM + 0.25);
          glowPos[n * 3 + 1] = y + POLE_H - 0.02;
          glowPos[n * 3 + 2] = z - Math.cos(yaw) * (ARM + 0.25);
          n++;
        }
      }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    glowGeo.getAttribute('position').needsUpdate = true;
    glowGeo.setDrawRange(0, n);
    drawn = n;
  };
  return {
    get count() {
      return count;
    },
    get drawn() {
      return drawn;
    },
    update(camera, level) {
      const e = camera.matrixWorld.elements;
      const cx = e[12];
      const cz = e[14];
      if ((cx - lastX) ** 2 + (cz - lastZ) ** 2 > 80 * 80) {
        lastX = cx;
        lastZ = cz;
        refill(cx, cz);
      }
      uLevel.value = level;
      glowMat.uniforms.uLevel.value = level;
      glowMat.uniforms.uPx.value = viewportHeight() / (2 * Math.tan((camera.fov * Math.PI) / 360));
      glows.visible = level > 0.02 && drawn > 0;
      mesh.visible = drawn > 0;
    },
    dispose() {
      scene.remove(group);
      geo.dispose();
      mat.dispose();
      glowGeo.dispose();
      glowMat.dispose();
      mesh.dispose();
    },
  };
}
