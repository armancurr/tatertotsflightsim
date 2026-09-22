/**
 * Fair-weather cumulus field: every cloud is a cluster of soft, camera-facing
 * puff billboards (cloudLayout.ts), all drawn in ONE instanced draw call.
 *
 * Lighting per puff/pixel: a pseudo-sphere normal from the billboard
 * coordinate (bright sun-facing side, dark lee side), per-puff self-shadowing
 * from the rest of its cloud (sunlit tops, blue-grey flat bases), a
 * Henyey-Greenstein forward-scattering lobe concentrated on thin edges (the
 * silver lining when backlit), and sky/ground ambient. Puffs fade out as the
 * camera gets close, and the atmosphere turns the camera's in-cloud density
 * into a soft whiteout in the output pass — flying through a cloud never
 * pops sprites. The shader includes the fog chunks, so clouds get exactly the
 * same aerial perspective as terrain.
 *
 * Every frame each cloud is wrapped to within half a tile of the camera
 * (vertex positions are world-space), and every ~20 frames or 40 m of travel
 * the visible puffs are re-sorted back-to-front on the CPU (typed-array sort
 * of packed distance/index keys, ~0.2 ms for 4k puffs) and uploaded.
 */
import * as THREE from 'three';
import type { Vec3 } from '../types';
import type { RGB } from './atmosphereModel';
import {
  cloudDensityAt,
  computePuffSunOcclusion,
  generateCloudField,
  maxGroundUnder,
  wrapCoord,
  PUFF_STRIDE,
  P_DX,
  P_DZ,
  P_HFRAC,
  P_OCC,
  P_R,
  P_ROT,
  P_VAR,
  P_Y,
  type CloudField,
} from './cloudLayout';
import { fbm2, mulberry32 } from './noise';

export interface CloudsOptions {
  seed: number;
  count: number;
  coverage: number;
  baseAltitude: number;
  thickness: number;
  areaRadius: number;
  groundHeight?: (x: number, z: number) => number;
  minClearance?: number;
}

export interface CloudLighting {
  sunDir: Vec3;
  /** Sun illuminance at cloud level (scene units). */
  sun: RGB;
  /** Diffuse light on the sky-facing side (scene units, already × albedo/π). */
  ambientTop: RGB;
  /** Diffuse light on the flat bases (ground bounce + light diffusing through). */
  ambientBottom: RGB;
}

export interface Clouds {
  mesh: THREE.Mesh;
  field: CloudField;
  /** Wrap, sort and upload; update the in-cloud density at the camera. */
  update(camera: THREE.Camera, dt: number): void;
  setLighting(l: CloudLighting): void;
  /** Wind drift of the whole field (m): matches the volumetric clouds and the cloud shadows. */
  setWind(x: number, z: number): void;
  /** 0..1 smoothed cloud density at the camera. */
  readonly immersion: number;
  dispose(): void;
}

/** 2×2 atlas of soft, noisy puff sprites (R = density), with mipmaps. */
export function createPuffAtlas(tileSize = 128, seed = 11): THREE.DataTexture {
  const size = tileSize * 2;
  const data = new Uint8Array(size * size * 4);
  const rng = mulberry32(seed);
  for (let v = 0; v < 4; v++) {
    const ox = (v % 2) * tileSize;
    const oy = Math.floor(v / 2) * tileSize;
    const sx = rng() * 100;
    const sy = rng() * 100;
    for (let y = 0; y < tileSize; y++) {
      for (let x = 0; x < tileSize; x++) {
        const u = ((x + 0.5) / tileSize) * 2 - 1;
        const w = ((y + 0.5) / tileSize) * 2 - 1;
        const d = Math.hypot(u, w) / 0.9; // leave a margin so mips don't bleed between tiles
        // lumpy outline: big lobes + small cauliflower bumps
        const n = fbm2(u * 2.2 + sx, w * 2.2 + sy, 4, seed + v) + 0.45 * (fbm2(u * 7 + sy, w * 7 + sx, 3, seed + 20 + v) - 0.5);
        const edge = d + (n - 0.5) * 0.75;
        let a = 1 - smooth(0.42, 0.98, edge);
        // lumpy interior, denser in the middle
        a *= 0.72 + 0.28 * fbm2(u * 6 + sy, w * 6 + sx, 3, seed + 7 + v);
        a = Math.max(0, Math.min(1, a * 1.15));
        const o = ((oy + y) * size + ox + x) * 4;
        data[o] = Math.round(a * 255);
        data[o + 1] = data[o];
        data[o + 2] = data[o];
        data[o + 3] = 255;
      }
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

function smooth(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

const VERTEX = /* glsl */ `
attribute vec4 aPuff;   // world xyz, radius
attribute vec4 aInfo;   // heightFrac, occlusion, rotation, variant
attribute vec4 aCloud;  // base y, cloud height, brightness, 0
attribute vec3 aNrm;    // cloud-scale normal: puff position relative to the cloud's core
uniform vec2 uFade;     // horizontal distance fade start/end
varying vec3 vCloudN;
varying vec2 vUv;
varying vec2 vQ;
varying vec3 vInfo;
varying float vAlpha;
varying vec3 vWorld;
varying float vBaseY;
varying float vR;
#include <fog_pars_vertex>
void main() {
	vec3 c = aPuff.xyz;
	float r = aPuff.w;
	vec4 mvC = viewMatrix * vec4( c, 1.0 );
	float cr = cos( aInfo.z );
	float sr = sin( aInfo.z );
	vec2 q = position.xy;
	vec2 qr = vec2( cr * q.x - sr * q.y, sr * q.x + cr * q.y );
	vec4 mvPosition = mvC + vec4( qr * r, 0.0, 0.0 );
	float dist = length( mvC.xyz );
	float hd = length( c.xz - cameraPosition.xz );
	vAlpha = smoothstep( 0.35 * r, 1.5 * r, dist ) * ( 1.0 - smoothstep( uFade.x, uFade.y, hd ) );
	float v = aInfo.w;
	vUv = ( q * 0.5 + 0.5 ) * 0.5 + vec2( mod( v, 2.0 ), floor( v * 0.5 ) ) * 0.5;
	vQ = qr;
	vCloudN = aNrm;
	vInfo = vec3( aInfo.x, aInfo.y, aCloud.z );
	vWorld = c + ( vec4( qr * r, 0.0, 0.0 ) * viewMatrix ).xyz;
	vBaseY = aCloud.x;
	vR = r;
	gl_Position = projectionMatrix * mvPosition;
	if ( vAlpha < 0.002 ) gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
	#include <fog_vertex>
}
`;

const FRAGMENT = /* glsl */ `
uniform sampler2D tPuff;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uAmbTop;
uniform vec3 uAmbBottom;
uniform float uOpacity;
varying vec3 vCloudN;
varying vec2 vUv;
varying vec2 vQ;
varying vec3 vInfo;
varying float vAlpha;
varying vec3 vWorld;
varying float vBaseY;
varying float vR;
#include <fog_pars_fragment>
void main() {
	float dens = texture2D( tPuff, vUv ).r;
	float a = dens * vAlpha * uOpacity;
	a *= smoothstep( vBaseY - 3.0, vBaseY + 0.07 * vR, vWorld.y ); // crisp flat base (condensation level)
	if ( a < 0.003 ) discard;
	float rr = dot( vQ, vQ );
	vec3 nV = normalize( vec3( vQ, sqrt( max( 0.0, 1.0 - rr ) ) + 0.2 ) );
	vec3 nP = ( vec4( nV, 0.0 ) * viewMatrix ).xyz;
	// shading follows the whole cloud's shape, with the puff adding cauliflower relief
	vec3 nW = normalize( vCloudN * 0.8 + nP * 0.55 );
	float ndl = dot( nW, uSunDir );
	float occ = vInfo.y;
	float lit = mix( 0.2, 1.0, smoothstep( -0.55, 0.85, ndl ) ) * ( 1.0 - 0.8 * occ );
	vec3 V = normalize( vWorld - cameraPosition );
	float mu = dot( V, uSunDir );
	const float g = 0.6;
	float hg = ( 1.0 - g * g ) / ( 12.566371 * pow( 1.0 + g * g - 2.0 * g * mu, 1.5 ) );
	float thin = 1.0 - dens;
	float rim = 1.0 - abs( dot( vCloudN, V ) );
	// single forward scattering: thin (optically thin) parts radiate ≈ E·p(μ); dense cores diffuse it away
	float silver = hg * ( 0.08 + 0.92 * thin * ( 0.5 + 0.5 * rim ) ) * ( 1.0 - 0.8 * occ );
	float up = clamp( 0.6 * vInfo.x + 0.4 * ( nW.y * 0.5 + 0.5 ), 0.0, 1.0 );
	vec3 amb = mix( uAmbBottom, uAmbTop, up );
	vec3 col = ( uSunCol * ( 0.29 * lit + silver ) + amb ) * vInfo.z;
	gl_FragColor = vec4( col, a );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
}
`;

export function createClouds(o: CloudsOptions): Clouds {
  const field = generateCloudField({
    seed: o.seed,
    count: o.count,
    coverage: o.coverage,
    baseAltitude: o.baseAltitude,
    thickness: o.thickness,
    areaRadius: o.areaRadius,
    groundHeight: o.groundHeight,
    minClearance: o.minClearance,
  });
  const n = field.puffCount;
  const nClouds = field.clouds.length;
  const atlas = createPuffAtlas();

  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const puffBuf = new Float32Array(Math.max(1, n) * 4);
  const infoBuf = new Float32Array(Math.max(1, n) * 4);
  const cloudBuf = new Float32Array(Math.max(1, n) * 4);
  const nrmBuf = new Float32Array(Math.max(1, n) * 3);
  const aPuff = new THREE.InstancedBufferAttribute(puffBuf, 4).setUsage(THREE.DynamicDrawUsage);
  const aInfo = new THREE.InstancedBufferAttribute(infoBuf, 4).setUsage(THREE.DynamicDrawUsage);
  const aCloud = new THREE.InstancedBufferAttribute(cloudBuf, 4).setUsage(THREE.DynamicDrawUsage);
  const aNrm = new THREE.InstancedBufferAttribute(nrmBuf, 3).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aPuff', aPuff);
  geo.setAttribute('aInfo', aInfo);
  geo.setAttribute('aCloud', aCloud);
  geo.setAttribute('aNrm', aNrm);
  geo.instanceCount = 0;

  const material = new THREE.ShaderMaterial({
    name: 'CumulusPuffs',
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        tPuff: { value: null },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunCol: { value: new THREE.Vector3(1, 1, 1) },
        uAmbTop: { value: new THREE.Vector3(0.3, 0.35, 0.45) },
        uAmbBottom: { value: new THREE.Vector3(0.15, 0.16, 0.18) },
        uOpacity: { value: 1 },
        uFade: { value: new THREE.Vector2(o.areaRadius * 0.7, o.areaRadius * 0.95) },
      },
    ]),
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    premultipliedAlpha: true,
    depthWrite: false,
    depthTest: true,
    fog: true,
  });
  material.uniforms.tPuff.value = atlas; // set after merge (textures are cloned by merge)

  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'clouds';
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;

  // Per-cloud brightness variation and render-time state.
  const rng = mulberry32(o.seed + 3);
  const bright = new Float32Array(nClouds);
  for (let i = 0; i < nClouds; i++) bright[i] = 0.93 + 0.12 * rng();
  const wx = new Float64Array(nClouds).fill(NaN);
  const wz = new Float64Array(nClouds).fill(NaN);
  const lift = new Float32Array(nClouds);
  const keys = new Float64Array(Math.max(1, n));
  const clearance = o.minClearance ?? 250;
  const fadeEnd = o.areaRadius * 0.95;

  let lastSortX = Infinity;
  let lastSortY = Infinity;
  let lastSortZ = Infinity;
  let framesSinceSort = 1e9;
  let dirty = true;
  let immersion = 0;
  let windX = 0;
  let windZ = 0;
  const camPos = new THREE.Vector3();

  function sortAndUpload(cx: number, cy: number, cz: number) {
    const p = field.puffs;
    let count = 0;
    for (let ci = 0; ci < nClouds; ci++) {
      const c = field.clouds[ci];
      const dxC = wx[ci] - cx;
      const dzC = wz[ci] - cz;
      if (Math.hypot(dxC, dzC) - c.radius > fadeEnd) continue;
      const end = c.firstPuff + c.puffCount;
      for (let i = c.firstPuff; i < end; i++) {
        const oo = i * PUFF_STRIDE;
        const dx = wx[ci] + p[oo + P_DX] - cx;
        const dy = p[oo + P_Y] + lift[ci] - cy;
        const dz = wz[ci] + p[oo + P_DZ] - cz;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        keys[count++] = Math.floor(d * 4) * 65536 + i;
      }
    }
    const sorted = keys.subarray(0, count).sort();
    // Map puff index → cloud index lazily via firstPuff ranges (clouds are contiguous).
    let w = 0;
    for (let k = count - 1; k >= 0; k--) {
      const i = sorted[k] % 65536;
      const ci = cloudOfPuff[i];
      const c = field.clouds[ci];
      const oo = i * PUFF_STRIDE;
      const b = w * 4;
      puffBuf[b] = wx[ci] + p[oo + P_DX];
      puffBuf[b + 1] = p[oo + P_Y] + lift[ci];
      puffBuf[b + 2] = wz[ci] + p[oo + P_DZ];
      puffBuf[b + 3] = p[oo + P_R];
      infoBuf[b] = p[oo + P_HFRAC];
      infoBuf[b + 1] = p[oo + P_OCC];
      infoBuf[b + 2] = p[oo + P_ROT];
      infoBuf[b + 3] = p[oo + P_VAR];
      cloudBuf[b] = c.base + lift[ci];
      cloudBuf[b + 1] = c.height;
      cloudBuf[b + 2] = bright[ci];
      cloudBuf[b + 3] = 0;
      // cloud-scale normal from the cloud's core (a bit above the base) to the puff
      let nx = p[oo + P_DX] / c.radius;
      let ny = ((p[oo + P_Y] - (c.base + 0.3 * c.height)) / c.height) * 1.3;
      let nz = p[oo + P_DZ] / c.radius;
      const nl = Math.hypot(nx, ny, nz);
      if (nl < 1e-3) {
        nx = 0;
        ny = 1;
        nz = 0;
      } else {
        nx /= nl;
        ny /= nl;
        nz /= nl;
      }
      const b3 = w * 3;
      nrmBuf[b3] = nx;
      nrmBuf[b3 + 1] = ny;
      nrmBuf[b3 + 2] = nz;
      w++;
    }
    geo.instanceCount = w;
    for (const a of [aPuff, aInfo, aCloud, aNrm]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, Math.max(1, w) * a.itemSize);
      a.needsUpdate = true;
    }
  }

  const cloudOfPuff = new Uint16Array(Math.max(1, n));
  field.clouds.forEach((c, ci) => cloudOfPuff.fill(ci, c.firstPuff, c.firstPuff + c.puffCount));

  function update(camera: THREE.Camera, dt: number) {
    camera.getWorldPosition(camPos);
    const cx = camPos.x;
    const cy = camPos.y;
    const cz = camPos.z;
    for (let ci = 0; ci < nClouds; ci++) {
      const c = field.clouds[ci];
      const nx = wrapCoord(c.x + windX, cx, field.tile);
      const nz = wrapCoord(c.z + windZ, cz, field.tile);
      if (nx !== wx[ci] || nz !== wz[ci]) {
        const moved = !(Math.abs(nx - wx[ci]) < 1 && Math.abs(nz - wz[ci]) < 1);
        wx[ci] = nx;
        wz[ci] = nz;
        if (moved && o.groundHeight) {
          lift[ci] = Math.max(0, maxGroundUnder(o.groundHeight, nx, nz, c.radius) + clearance - c.base);
          dirty = true;
        }
      }
    }
    framesSinceSort++;
    const moved2 = (cx - lastSortX) ** 2 + (cy - lastSortY) ** 2 + (cz - lastSortZ) ** 2;
    if (dirty || moved2 > 40 * 40 || framesSinceSort > 20) {
      sortAndUpload(cx, cy, cz);
      lastSortX = cx;
      lastSortY = cy;
      lastSortZ = cz;
      framesSinceSort = 0;
      dirty = false;
    }
    const target = cloudDensityAt(field, cx - windX, cy, cz - windZ, cx - windX, cz - windZ, lift);
    const k = 1 - Math.exp(-Math.max(0, dt) / 0.25);
    immersion += (target - immersion) * k;
  }

  let lastSun = { x: NaN, y: NaN, z: NaN };
  function setLighting(l: CloudLighting) {
    const u = material.uniforms;
    u.uSunDir.value.set(l.sunDir.x, l.sunDir.y, l.sunDir.z);
    u.uSunCol.value.set(l.sun.r, l.sun.g, l.sun.b);
    u.uAmbTop.value.set(l.ambientTop.r, l.ambientTop.g, l.ambientTop.b);
    u.uAmbBottom.value.set(l.ambientBottom.r, l.ambientBottom.g, l.ambientBottom.b);
    if (l.sunDir.x !== lastSun.x || l.sunDir.y !== lastSun.y || l.sunDir.z !== lastSun.z) {
      computePuffSunOcclusion(field, l.sunDir);
      lastSun = { x: l.sunDir.x, y: l.sunDir.y, z: l.sunDir.z };
      dirty = true;
    }
  }

  return {
    mesh,
    field,
    update,
    setLighting,
    setWind(x: number, z: number) {
      const t = field.tile;
      windX = x - Math.floor(x / t) * t;
      windZ = z - Math.floor(z / t) * t;
    },
    get immersion() {
      return immersion;
    },
    dispose() {
      geo.dispose();
      material.dispose();
      atlas.dispose();
    },
  };
}
