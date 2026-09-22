/**
 * Water surfaces: the sea (a radial grid at sea level that follows the camera),
 * lake discs at their own levels and the river as a ribbon following its
 * sloping water surface.
 *
 * Material: MeshStandardMaterial extended with onBeforeCompile, so three's PBR
 * sun specular, scene.environment reflections, shadows, depth modes and the
 * (atmosphere-overridden) fog chunks all apply. On top:
 *  - procedural wave normals (a spectrum of directional waves + ripples, no
 *    textures), each band faded by the pixel footprint with its lost slope
 *    variance moved into roughness, so the sea reads right from a low pass and
 *    from 3,000 m (broad sun-glint path far away, sparkle close up);
 *  - wind slicks: km-scale patches of calmer / rougher water;
 *  - sky reflection fallback (a gradient) when scene.environment is absent;
 *  - straight-alpha compositing: alpha = Fresnel (+ glint), so looking down you
 *    see the turquoise shallows / deep-blue bed the terrain shader tints, while
 *    grazing views mirror the sky. Far away the water turns opaque deep blue.
 */
import * as THREE from 'three';
import { CONFIG, type Config } from '../config';
import { getLayout, type WorldLayout } from './layout';

export interface WaterOptions {
  layout?: WorldLayout;
  config?: Config;
  /** Radius of the sea disc around the camera, m (default: camera far plane). */
  seaRadius?: number;
}

export interface Water {
  update(camera: THREE.PerspectiveCamera, time: number, sunDirection: THREE.Vector3): void;
  dispose(): void;
  readonly group: THREE.Group;
}

const WATER_VERTEX_PARS = /* glsl */ `
varying vec3 vWaterW;
`;
const WATER_WORLDPOS = /* glsl */ `
vWaterW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
`;

const WATER_FRAGMENT_PARS = /* glsl */ `
varying vec3 vWaterW;
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform float uWaveScale;   // 1 = open sea, smaller = sheltered lake / river
uniform float uWaveLength;  // wavelength multiplier
uniform vec2 uFarOpaque;    // distance range over which the water body turns opaque
uniform float uClarity;     // 1 = clear sea, lower = murkier (more body colour close in)

vec3 wNormalW;
float wRoughExtra;
float wDist;

uint wPcg( uint v ) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ( ( s >> ( ( s >> 28u ) + 4u ) ) ^ s ) * 277803737u;
  return ( w >> 22u ) ^ w;
}
float wHash( vec2 p ) { ivec2 i = ivec2( p ); return float( wPcg( uint( i.x ) + wPcg( uint( i.y ) ) ) ) * ( 1.0 / 4294967295.0 ); }
float wNoise( vec2 p ) {
  vec2 i = floor( p ); vec2 f = p - i; vec2 u = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( wHash( i ), wHash( i + vec2( 1.0, 0.0 ) ), u.x ), mix( wHash( i + vec2( 0.0, 1.0 ) ), wHash( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
}
// Gradient of value noise (for ripples), finite difference.
vec2 wNoiseGrad( vec2 p ) {
  float e = 0.35;
  return vec2( wNoise( p + vec2( e, 0.0 ) ) - wNoise( p - vec2( e, 0.0 ) ), wNoise( p + vec2( 0.0, e ) ) - wNoise( p - vec2( 0.0, e ) ) ) / ( 2.0 * e );
}

// Sum of directional waves: returns the surface slope (dh/dx, dh/dz); moves filtered-out slope variance to wRoughExtra.
vec2 wWaves( vec2 p, float fw ) {
  vec2 slope = vec2( 0.0 );
  float lost = 0.0;
  // wind from the south-west: waves travel north-east
  const float G = 9.81;
  float slick = 0.55 + 0.9 * wNoise( p / 900.0 ) * wNoise( p / 260.0 + 3.0 );
  for ( int i = 0; i < 7; i++ ) {
    float fi = float( i );
    float lambda = uWaveLength * 70.0 * pow( 0.56, fi );
    float ang = 0.785 + ( wHash( vec2( fi, 3.0 ) ) - 0.5 ) * 1.4;
    vec2 dir = vec2( cos( ang ), -sin( ang ) );
    float k = 6.2831853 / lambda;
    float c = sqrt( G / k );
    float steep = 0.12 * uWaveScale * ( i < 2 ? 0.7 : 1.0 ) * slick; // slope amplitude = A·k
    float ph = k * dot( dir, p ) - k * c * uTime + fi * 1.7;
    // band filtering by pixel footprint
    float vis = 1.0 - smoothstep( lambda * 0.18, lambda * 0.6, fw );
    slope += dir * steep * cos( ph ) * vis;
    lost += 0.5 * steep * steep * ( 1.0 - vis );
  }
  // small wind ripples
  float rl = 0.9 * uWaveLength;
  float rvis = 1.0 - smoothstep( rl * 0.2, rl * 0.8, fw );
  vec2 rp = p / rl + vec2( uTime * 0.35, -uTime * 0.2 );
  vec2 rg = ( wNoiseGrad( rp ) + wNoiseGrad( rp * 2.1 + 7.0 ) * 0.5 ) * 0.09 * uWaveScale * slick;
  slope += rg * rvis;
  lost += 0.01 * uWaveScale * slick * ( 1.0 - rvis );
  wRoughExtra = lost;
  return slope;
}
`;

// three evaluates roughness before the normal chunks: the waves are computed here, once.
const WATER_ROUGHNESS = /* glsl */ `
wDist = distance( cameraPosition, vWaterW );
float wFw = max( length( fwidth( vWaterW.xz ) ), 1e-3 );
vec2 wSlope = wWaves( vWaterW.xz, wFw );
wNormalW = normalize( vec3( -wSlope.x, 1.0, -wSlope.y ) );
float roughnessFactor = clamp( sqrt( roughness * roughness + wRoughExtra * 3.0 ), 0.02, 0.5 );
`;

const WATER_NORMAL = /* glsl */ `
normal = normalize( ( viewMatrix * vec4( wNormalW, 0.0 ) ).xyz );
`;

const WATER_OPAQUE = /* glsl */ `
{
  vec3 Vw = normalize( cameraPosition - vWaterW );
  float NdV = clamp( dot( wNormalW, Vw ), 0.0, 1.0 );
  float F = 0.02 + 0.98 * pow( 1.0 - NdV, 5.0 );
  vec3 spec = reflectedLight.directSpecular + reflectedLight.indirectSpecular;
  #ifndef USE_ENVMAP
    vec3 Rw = reflect( -Vw, wNormalW );
    vec3 sky = mix( uSkyHorizon, uSkyZenith, pow( clamp( Rw.y, 0.0, 1.0 ), 0.45 ) );
    spec += F * sky;
  #endif
  // sparkle: tiny sharp sun glints on wave facets close in
  vec3 Hw = normalize( uSunDir + Vw );
  float sparkle = pow( max( dot( wNormalW, Hw ), 0.0 ), 2200.0 ) * step( 0.0, uSunDir.y ) * ( 1.0 - smoothstep( 150.0, 1200.0, wDist ) );
  spec += uSunColor * sparkle * 4.0;
  // the water body: murk close in (rivers/lakes), opaque deep water far away
  float body = max( smoothstep( uFarOpaque.x, uFarOpaque.y, wDist ), 1.0 - uClarity );
  vec3 bodyCol = totalDiffuse;
  float a = F + ( 1.0 - F ) * body;
  vec3 premul = spec + ( 1.0 - F ) * body * bodyCol;
  float glint = clamp( dot( reflectedLight.directSpecular, vec3( 0.3333 ) ) * 0.5 + sparkle, 0.0, 1.0 );
  float aEff = clamp( max( a, a + glint ), 0.0, 1.0 );
  gl_FragColor = vec4( premul / max( aEff, 1e-3 ), aEff );
}
`;

function replaceOnce(src: string, find: string, repl: string): string {
  if (!src.includes(find)) throw new Error(`water material: shader chunk ${find} not found`);
  return src.replace(find, repl);
}

interface WaterMat {
  material: THREE.MeshStandardMaterial;
  uniforms: Record<string, { value: unknown }>;
}

function makeWaterMaterial(kind: 'sea' | 'lake' | 'river', shared: Record<string, { value: unknown }>): WaterMat {
  const uniforms: Record<string, { value: unknown }> = {
    ...shared,
    uWaveScale: { value: kind === 'sea' ? 1 : kind === 'lake' ? 0.42 : 0.3 },
    uWaveLength: { value: kind === 'sea' ? 1 : kind === 'lake' ? 0.28 : 0.12 },
    uFarOpaque: { value: new THREE.Vector2(22000, 50000) },
    uClarity: { value: kind === 'sea' ? 1 : kind === 'lake' ? 0.8 : 0.55 },
  };
  const body = kind === 'sea' ? new THREE.Color().setRGB(0.004, 0.017, 0.028, THREE.LinearSRGBColorSpace) : new THREE.Color().setRGB(0.008, 0.02, 0.018, THREE.LinearSRGBColorSpace);
  const material = new THREE.MeshStandardMaterial({
    color: body,
    roughness: 0.04,
    metalness: 0,
    transparent: true,
    depthWrite: true,
    fog: true,
    envMapIntensity: 1,
  });
  material.name = `water-${kind}`;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    let v = shader.vertexShader;
    v = replaceOnce(v, '#include <common>', `#include <common>\n${WATER_VERTEX_PARS}`);
    v = replaceOnce(v, '#include <worldpos_vertex>', `#include <worldpos_vertex>\n${WATER_WORLDPOS}`);
    shader.vertexShader = v;
    let f = shader.fragmentShader;
    f = replaceOnce(f, '#include <common>', `#include <common>\n${WATER_FRAGMENT_PARS}`);
    f = replaceOnce(f, '#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${WATER_NORMAL}`);
    f = replaceOnce(f, '#include <roughnessmap_fragment>', WATER_ROUGHNESS);
    f = replaceOnce(f, '#include <opaque_fragment>', WATER_OPAQUE);
    shader.fragmentShader = f;
  };
  material.customProgramCacheKey = () => 'water-v1';
  return { material, uniforms };
}

/** A disc of radius R made of rings whose spacing grows with distance (dense near the camera). */
function radialGrid(R: number, rings = 56, segs = 72): THREE.BufferGeometry {
  const pos: number[] = [0, 0, 0];
  const r0 = 1.5;
  const growth = Math.pow(R / r0, 1 / (rings - 1));
  for (let k = 0; k < rings; k++) {
    const r = r0 * Math.pow(growth, k);
    for (let s = 0; s < segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      pos.push(Math.cos(a) * r, 0, Math.sin(a) * r);
    }
  }
  const idx: number[] = [];
  for (let s = 0; s < segs; s++) idx.push(0, 1 + ((s + 1) % segs), 1 + s);
  for (let k = 0; k < rings - 1; k++)
    for (let s = 0; s < segs; s++) {
      const a = 1 + k * segs + s;
      const b = 1 + k * segs + ((s + 1) % segs);
      const c = a + segs;
      const d = b + segs;
      idx.push(a, b, c, b, d, c);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), R);
  return g;
}

export function createWater(scene: THREE.Scene, opts: WaterOptions = {}): Water {
  const cfg = opts.config ?? CONFIG;
  const L = opts.layout ?? getLayout();
  const group = new THREE.Group();
  group.name = 'water';
  scene.add(group);

  const shared = {
    uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0.3, 0.8, -0.5).normalize() },
    uSunColor: { value: new THREE.Color(1, 0.96, 0.9).multiplyScalar(cfg.atmosphere.sunIntensity) },
    uSkyZenith: { value: new THREE.Color().setRGB(0.12, 0.28, 0.62, THREE.LinearSRGBColorSpace) },
    uSkyHorizon: { value: new THREE.Color().setRGB(0.55, 0.66, 0.8, THREE.LinearSRGBColorSpace) },
  };
  const sea = makeWaterMaterial('sea', shared);
  const lake = makeWaterMaterial('lake', shared);
  const river = makeWaterMaterial('river', shared);

  // ── Sea: follows the camera ──────────────────────────────────────────────
  const seaRadius = opts.seaRadius ?? cfg.camera.far * 0.98;
  const seaMesh = new THREE.Mesh(radialGrid(seaRadius), sea.material);
  seaMesh.name = 'sea';
  seaMesh.renderOrder = -10; // before clouds and other transparent things
  seaMesh.receiveShadow = true;
  seaMesh.frustumCulled = false;
  seaMesh.position.y = L.seaLevel;
  group.add(seaMesh);

  // ── Lakes: fans over the shoreline pushed 40 m outward (the shore hides the rim) ──
  for (const lk of L.lakes) {
    const pos: number[] = [lk.center.x, lk.level, lk.center.z];
    for (const p of lk.shoreline) {
      const dx = p.x - lk.center.x;
      const dz = p.z - lk.center.z;
      const d = Math.hypot(dx, dz) || 1;
      pos.push(p.x + (dx / d) * 40, lk.level, p.z + (dz / d) * 40);
    }
    const n = lk.shoreline.length;
    const idx: number[] = [];
    for (let i = 0; i < n; i++) idx.push(0, 1 + ((i + 1) % n), 1 + i);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, lake.material);
    m.name = `lake:${lk.name}`;
    m.renderOrder = -10;
    m.receiveShadow = true;
    group.add(m);
  }

  // ── River: a ribbon on its sloping water surface, until it meets the sea ──
  for (const rv of L.rivers) {
    const pos: number[] = [];
    const idx: number[] = [];
    let n = 0;
    for (let i = 0; i < rv.points.length; i++) {
      const p = rv.points[i];
      if (rv.levels[i] <= L.seaLevel + 0.05 && p.z > L.coast.zAt(p.x) - 200) break;
      const a = rv.points[Math.max(0, i - 1)];
      const b = rv.points[Math.min(rv.points.length - 1, i + 1)];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const l = Math.hypot(dx, dz) || 1;
      const w = rv.halfWidths[i] + 9;
      const nx = dz / l;
      const nz = -dx / l;
      const y = rv.levels[i];
      pos.push(p.x - nx * w, y, p.z - nz * w, p.x + nx * w, y, p.z + nz * w);
      if (n > 0) {
        const k = n * 2;
        idx.push(k - 2, k - 1, k, k - 1, k + 1, k);
      }
      n++;
    }
    if (n < 2) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    g.setIndex(idx);
    // make every triangle face up
    const ia = g.index!.array as Uint16Array | Uint32Array;
    const P = g.attributes.position.array as Float32Array;
    for (let t = 0; t < ia.length; t += 3) {
      const [i0, i1, i2] = [ia[t], ia[t + 1], ia[t + 2]];
      const ux = P[i1 * 3] - P[i0 * 3];
      const uz = P[i1 * 3 + 2] - P[i0 * 3 + 2];
      const vx = P[i2 * 3] - P[i0 * 3];
      const vz = P[i2 * 3 + 2] - P[i0 * 3 + 2];
      if (uz * vx - ux * vz < 0) {
        ia[t + 1] = i2;
        ia[t + 2] = i1;
      }
    }
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, river.material);
    m.name = `river:${rv.name}`;
    m.renderOrder = -10;
    m.receiveShadow = true;
    group.add(m);
  }

  const camPos = new THREE.Vector3();
  return {
    group,
    update(camera, time, sunDirection) {
      camera.getWorldPosition(camPos);
      seaMesh.position.set(camPos.x, L.seaLevel, camPos.z);
      shared.uTime.value = time;
      (shared.uSunDir.value as THREE.Vector3).copy(sunDirection).normalize();
      // sky fallback colours from the scene's fog/background when available
      if (scene.fog && 'color' in scene.fog) (shared.uSkyHorizon.value as THREE.Color).copy((scene.fog as THREE.FogExp2).color);
      if (scene.background instanceof THREE.Color) (shared.uSkyZenith.value as THREE.Color).copy(scene.background).multiplyScalar(0.8);
    },
    dispose() {
      group.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
      sea.material.dispose();
      lake.material.dispose();
      river.material.dispose();
      group.removeFromParent();
    },
  };
}
