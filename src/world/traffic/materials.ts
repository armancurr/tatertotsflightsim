/**
 * Materials for traffic. All fog-enabled (the global aerial-perspective fog
 * applies), calibrated for the HDR pipeline (sun ≈ 3 scene units, exposure 2.2).
 *
 *  - `createBatchMaterial`: MeshStandardMaterial for BatchedMesh models whose
 *    vertices carry `aPbr` (roughness, metalness, tint mask, luff weight):
 *    tint mixes the per-instance batching colour (livery / hull paint) in,
 *    sails flutter along their normal (luff > 0), lit glass (luff < 0) shows a
 *    pattern of warm windows at dusk (`uNight`), and hulls below the waterline
 *    fade into the water colour.
 *  - `createWakeMaterial`: foam trail + Kelvin arm ribbons, displaced by the
 *    same Gerstner trains as the drawn sea (`packSeaWaves`).
 *  - `createPointMaterial`: ONE point sprite material for nav/strobe/landing
 *    lights (additive), bow spray and far-aircraft dots (alpha, sun-lit) via
 *    premultiplied blending; lights only lose light to the haze, dots/spray
 *    get the full aerial perspective.
 *  - `createDiscMaterial`: propeller / rotor blur discs (instanced).
 *  - `createContrailMaterial`: persistent contrail ribbons (sun-lit, forward-scattering).
 */
import * as THREE from 'three';
import type { WaveSpectrum } from '../water/waves';

export interface LightingUniforms {
  uSunDir: { value: THREE.Vector3 };
  /** Sun colour × intensity at the camera (scene units). */
  uSunColor: { value: THREE.Color };
  /** Sky irradiance on a horizontal surface (scene units). */
  uSky: { value: THREE.Color };
  /** Seconds (wave / flutter time). */
  uTime: { value: number };
  /** 0 day … 1 night (window lights). */
  uNight: { value: number };
}

export function createLightingUniforms(): LightingUniforms {
  return {
    uSunDir: { value: new THREE.Vector3(0.4, 0.7, -0.5).normalize() },
    uSunColor: { value: new THREE.Color(3, 2.9, 2.7) },
    uSky: { value: new THREE.Color(0.6, 0.75, 1.0) },
    uTime: { value: 0 },
    uNight: { value: 0 },
  };
}

/** Uniforms that share the global atmospheric fog array (see render/fog.ts). */
function fogUniforms(): Record<string, THREE.IUniform> {
  const u: Record<string, THREE.IUniform> = THREE.UniformsUtils.clone(THREE.UniformsLib.fog);
  const lib = THREE.UniformsLib.fog as Record<string, THREE.IUniform>;
  if (lib.atmoFog) u.atmoFog = { value: lib.atmoFog.value };
  if (lib.atmoCloudShadow) u.atmoCloudShadow = { value: lib.atmoCloudShadow.value };
  return u;
}

export function createBatchMaterial(shared: LightingUniforms, opts: { underwater: boolean; name: string }): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.5, metalness: 0, envMapIntensity: 1 });
  m.name = opts.name;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = shared.uTime;
    shader.uniforms.uNight = shared.uNight;
    shader.uniforms.uSunDir = shared.uSunDir;
    shader.uniforms.uSunColor = shared.uSunColor;
    shader.uniforms.uWaterDeep = { value: new THREE.Color(0.012, 0.05, 0.065) };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec4 aPbr;
varying vec4 vPbr;
varying vec3 vLocalPos;
varying vec3 vLocalN;
varying float vWin;
uniform float uTime;`,
      )
      .replace(
        '#include <color_vertex>',
        `vWin = 1.0;
#if defined( USE_COLOR ) || defined( USE_BATCHING_COLOR )
  vColor = vec4( color, 1.0 );
  #ifdef USE_BATCHING_COLOR
    vec4 tintC = getBatchingColor( getIndirectIndex( gl_DrawID ) );
    vColor.rgb = mix( vColor.rgb, vColor.rgb * tintC.rgb, aPbr.z );
    // instance colour alpha = how many of its windows are lit at night
    vWin = tintC.a;
  #endif
#endif
vPbr = aPbr;
vLocalPos = position;
vLocalN = normal;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
if ( aPbr.w > 0.0 ) {
  float ph = 0.0;
  #ifdef USE_BATCHING
    ph = batchingMatrix[3].x * 0.37 + batchingMatrix[3].z * 0.23;
  #endif
  float fl = sin( uTime * 7.3 + position.y * 1.7 + position.z * 2.3 + ph ) * 0.6 + sin( uTime * 11.1 + position.y * 3.1 + ph * 1.3 ) * 0.4;
  transformed += objectNormal * aPbr.w * 0.05 * fl;
}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec4 vPbr;
varying vec3 vLocalPos;
varying vec3 vLocalN;
varying float vWin;
uniform vec3 uWaterDeep;
uniform float uNight;
uniform vec3 uSunDir;
uniform vec3 uSunColor;`,
      )
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = vPbr.x;`)
      .replace('#include <metalnessmap_fragment>', `float metalnessFactor = vPbr.y;`)
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
if ( vPbr.w > 0.0 ) {
  // sailcloth is translucent: the shaded side glows with the sun behind it
  vec3 sunV = normalize( ( viewMatrix * vec4( uSunDir, 0.0 ) ).xyz );
  totalEmissiveRadiance += diffuseColor.rgb * uSunColor * max( -dot( normal, sunV ), 0.0 ) * 0.3 / PI;
}
if ( vPbr.w < -0.5 && uNight * vWin > 0.001 ) {
  // lit glass: a pattern of warm windows (≈1.8 m wide, 2.6 m tall cells), some dark
  vec3 cell = floor( vLocalPos * vec3( 0.55, 0.38, 0.55 ) );
  float h = fract( sin( dot( cell, vec3( 12.9898, 78.233, 37.719 ) ) ) * 43758.5453 );
  vec3 f = fract( vLocalPos * vec3( 0.55, 0.38, 0.55 ) );
  // mullions along the face: z on the sides, x on the ends
  float u = abs( vLocalN.x ) > abs( vLocalN.z ) ? f.z : f.x;
  float frame = step( 0.1, u ) * step( u, 0.9 ) * step( 0.12, f.y ) * step( f.y, 0.85 );
  float lit = step( 1.0 - 0.7 * vWin, h ) * frame;
  totalEmissiveRadiance += vec3( 1.0, 0.7, 0.4 ) * uNight * lit * ( 0.5 + 0.9 * h ) * 1.6;
}`,
      );
    if (opts.underwater) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
if ( vLocalPos.y < 0.0 ) {
  float wd = 1.0 - exp( vLocalPos.y * 0.55 );
  diffuseColor.rgb = mix( diffuseColor.rgb * vec3( 0.55, 0.8, 0.85 ), uWaterDeep, clamp( 0.35 + wd, 0.0, 1.0 ) );
}`,
      );
    }
  };
  m.customProgramCacheKey = () => `traffic-batch-${opts.underwater ? 'w' : 'a'}`;
  return m;
}

const NOISE_GLSL = /* glsl */ `
float tHash( vec2 p ) { p = fract( p * vec2( 123.34, 456.21 ) ); p += dot( p, p + 45.32 ); return fract( p.x * p.y ); }
float tNoise( vec2 p ) {
  vec2 i = floor( p ); vec2 f = fract( p ); vec2 u = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( tHash( i ), tHash( i + vec2( 1.0, 0.0 ) ), u.x ), mix( tHash( i + vec2( 0.0, 1.0 ) ), tHash( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
}
`;

// ─── Sea waves (the water shader's Gerstner trains) ──────────────────────────

export const MAX_TRAINS = 16;

export interface SeaWaveUniforms {
  /** (Dx·k, Dz·k, ω, phase at the origin now) per train. */
  uWaveA: { value: Float32Array };
  /** (amplitude, chop, k·A, wavelength) per train. */
  uWaveB: { value: Float32Array };
  /** Origin x, origin z (snapped near the camera), displacement range (m). */
  uWaveO: { value: THREE.Vector3 };
}

export function createSeaWaveUniforms(spec: WaveSpectrum, dispRange: number): SeaWaveUniforms {
  const A = new Float32Array(MAX_TRAINS * 4);
  const B = new Float32Array(MAX_TRAINS * 4);
  const n = Math.min(MAX_TRAINS, spec.trains.length);
  for (let i = 0; i < n; i++) {
    const w = spec.trains[i];
    A[i * 4] = w.dirX * w.k;
    A[i * 4 + 1] = w.dirZ * w.k;
    A[i * 4 + 2] = w.omega;
    B[i * 4] = w.amp;
    B[i * 4 + 1] = w.chop;
    B[i * 4 + 2] = w.k * w.amp;
    B[i * 4 + 3] = w.wavelength;
  }
  return { uWaveA: { value: A }, uWaveB: { value: B }, uWaveO: { value: new THREE.Vector3(0, 0, dispRange) } };
}

const TAU = Math.PI * 2;

/** Per frame: phases at an origin snapped to 2 km near the camera (keeps the GPU arithmetic small). */
export function packSeaWaves(spec: WaveSpectrum, u: SeaWaveUniforms, camX: number, camZ: number, t: number): void {
  const ox = Math.round(camX / 2048) * 2048;
  const oz = Math.round(camZ / 2048) * 2048;
  u.uWaveO.value.x = ox;
  u.uWaveO.value.y = oz;
  const A = u.uWaveA.value;
  const n = Math.min(MAX_TRAINS, spec.trains.length);
  for (let i = 0; i < n; i++) {
    const w = spec.trains[i];
    const ph = w.k * (w.dirX * ox + w.dirZ * oz) + w.phase - w.omega * t;
    A[i * 4 + 3] = ((ph % TAU) + TAU) % TAU;
  }
}

/** GLSL: displaces a world point on the sea exactly like WATER_BEGIN_VERTEX (no shoaling). */
const SEA_DISPLACE_GLSL = /* glsl */ `
uniform vec4 uWaveA[ ${MAX_TRAINS} ];
uniform vec4 uWaveB[ ${MAX_TRAINS} ];
uniform vec3 uWaveO;
vec3 seaDisplace( vec3 wp ) {
  float r = length( wp.xz - cameraPosition.xz );
  float spacing = max( 0.6, r * 0.045 );
  float near = 1.0 - smoothstep( uWaveO.z * 0.6, uWaveO.z, r );
  vec3 d = vec3( 0.0 );
  if ( near <= 0.0 ) return d;
  vec2 P = wp.xz - uWaveO.xy;
  for ( int i = 0; i < ${MAX_TRAINS}; i++ ) {
    vec4 a = uWaveA[ i ];
    vec4 b = uWaveB[ i ];
    if ( b.x <= 0.0 ) continue;
    float w = smoothstep( 2.5 * spacing, 5.0 * spacing, b.w ) * near;
    float th = dot( a.xy, P ) + a.w;
    float c = cos( th );
    vec2 dir = a.xy / max( length( a.xy ), 1e-6 );
    d.xz += dir * ( b.y * c * w );
    d.y += b.x * sin( th ) * w;
  }
  return d;
}
`;

export function createWakeMaterial(shared: LightingUniforms, waves: SeaWaveUniforms): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({
    name: 'traffic.wake',
    uniforms: { ...fogUniforms(), ...shared, ...waves },
    vertexShader: /* glsl */ `
      attribute vec4 aWake;
      attribute float aType;
      varying vec4 vWake;
      varying float vType;
      ${SEA_DISPLACE_GLSL}
      #include <fog_pars_vertex>
      void main() {
        vWake = aWake;
        vType = aType;
        vec4 wp = modelMatrix * vec4( position, 1.0 );
        // sea wakes ride the drawn waves (lakes are flat)
        if ( position.y < 1.0 ) wp.xyz += seaDisplace( wp.xyz );
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform vec3 uSky;
      uniform float uTime;
      varying vec4 vWake;
      varying float vType;
      #include <fog_pars_fragment>
      ${NOISE_GLSL}
      void main() {
        float along = vWake.x;
        float across = vWake.y;
        float age = vWake.z;
        float strength = vWake.w;
        if ( strength < 0.003 ) discard;
        float a;
        float white;
        if ( vType < 0.5 ) {
          // turbulent wake: white churn at the stern turning into a pale band of bubbles that breaks into streaks
          float prof = pow( max( 1.0 - across * across, 0.0 ), 0.7 );
          vec2 q = vec2( along * 0.32, across * 4.5 );
          float n = tNoise( q + vec2( 0.0, uTime * 0.12 ) ) * 0.5 + tNoise( q * 2.3 + 5.1 ) * 0.3 + tNoise( q * 5.3 + vec2( 1.7, uTime * 0.3 ) ) * 0.2;
          float streak = smoothstep( 0.28 + 0.4 * age, 0.85, n );
          float core = exp( -across * across * 4.0 ) * ( 1.0 - smoothstep( 0.0, 0.3, age ) );
          a = strength * prof * mix( 0.12 + 0.88 * streak, 1.0, core ) * ( 1.0 - 0.6 * age );
          white = mix( 0.35 + 0.65 * streak, 1.0, core ) * ( 1.0 - smoothstep( 0.15, 0.7, age ) * 0.6 );
        } else {
          // Kelvin arm: a train of short feathered crests, angled across the arm, strongest near its inner edge
          // (across −1 inner edge … +1 outer): crests run obliquely across the band, echelon-fashion
          float band = smoothstep( -1.0, -0.6, across ) * ( 1.0 - smoothstep( -0.1, 1.0, across ) );
          float crest = pow( 0.5 + 0.5 * sin( along * 0.55 - across * 4.0 ), 2.5 );
          float n = tNoise( vec2( along * 0.08, across * 1.5 ) ) * 0.6 + tNoise( vec2( along * 0.31, across * 3.1 ) ) * 0.4;
          a = strength * band * crest * smoothstep( 0.2, 0.8, n ) * 0.24;
          white = 0.45 + 0.4 * crest;
          // the bow wave: white water breaking along the stem and the first metres of each arm
          float bow = ( 1.0 - smoothstep( 0.0, 0.045, age ) ) * ( 1.0 - smoothstep( -0.2, 0.9, across ) );
          float bn = tNoise( vec2( along * 0.9, across * 5.0 + uTime * 0.8 ) );
          a = max( a, strength * bow * ( 0.45 + 0.4 * bn ) * 1.6 );
          white = max( white, bow );
        }
        a = clamp( a, 0.0, 0.92 );
        if ( a < 0.004 ) discard;
        // lit foam (Lambert, facing up) with a touch of sky; bubbles under the surface look pale turquoise
        float ndl = max( uSunDir.y, 0.0 );
        vec3 lit = 0.9 * ( uSunColor * ndl + uSky ) / 3.14159;
        vec3 col = lit * mix( vec3( 0.42, 0.72, 0.74 ), vec3( 1.0 ), white );
        gl_FragColor = vec4( col, a );
        #include <fog_fragment>
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  return m;
}

/**
 * Point sprites for lights, spray and far dots (premultiplied blending, one draw call).
 * Attributes: position; `aColor` = rgb (lights: HDR radiance; dots/spray: albedo) + a (0 = light,
 * > 0 = alpha of a dot/spray particle); `aParams` = (size m, min pixel diameter, shape 0 light /
 * 1 soft particle / 2 hard dot, −); `aDir` = facing direction (xyz) + beam exponent (w, 0 = omni).
 * A point smaller than its minimum pixel size is drawn at the minimum and dimmed by the covered area.
 */
export function createPointMaterial(shared: LightingUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'traffic.points',
    uniforms: { uHalfHeight: { value: 450 }, uSunDir: shared.uSunDir, uSunColor: shared.uSunColor, uSky: shared.uSky, ...fogUniforms() },
    vertexShader: /* glsl */ `
      attribute vec4 aColor;
      attribute vec4 aParams;
      attribute vec4 aDir;
      uniform float uHalfHeight;
      varying vec4 vColor;
      varying float vShape;
      varying float vGrow;
      #include <fog_pars_vertex>
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
        // lamps sit on (or just inside) the hull / wing skin: draw them a little in front of it
        if ( aParams.z < 0.5 ) {
          float dv = length( mvPosition.xyz );
          mvPosition.xyz *= max( 0.0, 1.0 - ( 1.2 + 0.002 * dv ) / max( dv, 1e-3 ) );
        }
        gl_Position = projectionMatrix * mvPosition;
        float facing = 1.0;
        if ( aDir.w > 0.0 ) {
          vec3 d = normalize( ( viewMatrix * vec4( aDir.xyz, 0.0 ) ).xyz );
          facing = pow( max( dot( d, normalize( -mvPosition.xyz ) ), 0.0 ), aDir.w );
        }
        float px = aParams.x * projectionMatrix[ 1 ][ 1 ] * uHalfHeight / max( -mvPosition.z, 0.05 );
        float minPx = aParams.y;
        float size = max( px, minPx );
        float k = px < minPx ? ( px / minPx ) * ( px / minPx ) : 1.0;
        vColor = aColor;
        vGrow = 1.0;
        if ( aColor.a > 0.0 ) vColor.a *= k;
        else {
          vColor.rgb *= facing * k;
          // no bloom in the pipeline: a bright lamp is drawn with its glare, a sprite that grows with brightness
          float b = max( max( vColor.r, vColor.g ), vColor.b );
          vGrow = clamp( sqrt( b / 40.0 ), 1.0, 10.0 );
          size *= vGrow;
        }
        vShape = aParams.z;
        float on = aColor.a > 0.0 ? vColor.a : max( max( vColor.r, vColor.g ), vColor.b );
        gl_PointSize = on > 0.0005 ? clamp( size, 1.0, 256.0 ) : 0.0;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform vec3 uSky;
      varying vec4 vColor;
      varying float vShape;
      varying float vGrow;
      #include <fog_pars_fragment>
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r2 = dot( d, d ) * 4.0;
        if ( r2 >= 1.0 ) discard;
        vec3 T = vec3( 1.0 );
        vec3 ins = vec3( 0.0 );
        #ifdef USE_FOG
          if ( atmoFog[ 0 ].w > 0.5 ) ins = atmoFogScatter( vFogWorldRel, cameraPosition.y, T );
        #endif
        if ( vShape < 0.5 ) {
          // the lamp itself (its true size at the centre of the grown sprite) + a capped glare halo
          float core = exp( -r2 * 10.0 * vGrow * vGrow );
          float b = max( max( vColor.r, vColor.g ), vColor.b );
          vec3 hue = vColor.rgb / max( b, 1e-6 );
          float glare = min( 0.02 * b, 5.0 ) * exp( -r2 * 5.0 ) * ( 1.0 - r2 ) + min( 0.22 * b, 60.0 ) * exp( -r2 * 3.5 * vGrow * vGrow ) * ( 1.0 - r2 );
          gl_FragColor = vec4( ( vColor.rgb * core + hue * glare ) * T, 0.0 );
        } else {
          float a = vShape < 1.5 ? ( 1.0 - r2 ) * ( 1.0 - r2 ) : 1.0 - smoothstep( 0.55, 1.0, r2 );
          a *= vColor.a;
          vec3 lit = vColor.rgb * ( uSunColor * max( uSunDir.y, 0.0 ) * 0.9 + uSky ) / 3.14159;
          gl_FragColor = vec4( ( lit * T + ins ) * a, a );
        }
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    fog: true,
  });
}

/** Propeller / rotor blur disc for an InstancedMesh of a unit disc in the XY plane; `aDisc` = (blades, phase, alpha, tipRing). */
export function createDiscMaterial(shared: LightingUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'traffic.disc',
    uniforms: { ...fogUniforms(), uTime: shared.uTime, uSunColor: shared.uSunColor, uSky: shared.uSky },
    vertexShader: /* glsl */ `
      attribute vec4 aDisc;
      varying vec2 vP;
      varying vec4 vDisc;
      #include <fog_pars_vertex>
      void main() {
        vP = position.xy;
        vDisc = aDisc;
        vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4( position, 1.0 );
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uSunColor;
      uniform vec3 uSky;
      varying vec2 vP;
      varying vec4 vDisc;
      #include <fog_pars_fragment>
      void main() {
        float r = length( vP );
        if ( r > 1.0 ) discard;
        float blades = vDisc.x;
        float ang = atan( vP.y, vP.x );
        float spin = uTime * 3.0 + vDisc.y;
        float ghost = pow( 0.5 + 0.5 * cos( blades * ( ang - spin ) ), 10.0 );
        float cover = smoothstep( 0.08, 0.22, r ) * ( 1.0 - smoothstep( 0.93, 1.0, r ) );
        float bands = 0.9 + 0.1 * sin( r * 40.0 );
        float tip = vDisc.w * smoothstep( 0.9, 0.97, r ) * ( 1.0 - smoothstep( 0.97, 1.0, r ) );
        float a = vDisc.z * ( cover * ( 0.12 + 0.2 * ghost ) * bands + tip * 0.25 );
        vec3 col = vec3( 0.06 ) * ( uSunColor * 0.4 + uSky ) + tip * vec3( 0.3 );
        gl_FragColor = vec4( col, a );
        #include <fog_fragment>
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
  });
}

/** Contrail ribbon: `aTrail` = (age01, across −1..1, opacity, along m). Sun-lit with forward scattering. */
export function createContrailMaterial(shared: LightingUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'traffic.contrail',
    uniforms: { ...fogUniforms(), uSunDir: shared.uSunDir, uSunColor: shared.uSunColor, uSky: shared.uSky, uTime: shared.uTime },
    vertexShader: /* glsl */ `
      attribute vec4 aTrail;
      varying vec4 vTrail;
      varying vec3 vView;
      #include <fog_pars_vertex>
      void main() {
        vTrail = aTrail;
        vec4 wp = modelMatrix * vec4( position, 1.0 );
        vView = normalize( wp.xyz - cameraPosition );
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform vec3 uSky;
      varying vec4 vTrail;
      varying vec3 vView;
      #include <fog_pars_fragment>
      ${NOISE_GLSL}
      void main() {
        float age = vTrail.x;
        float x = vTrail.y;
        // two engine cores merging into one plume as it ages and spreads
        float sep = 0.55 * ( 1.0 - smoothstep( 0.0, 0.08, age ) );
        float w = mix( 0.22, 0.75, smoothstep( 0.0, 0.25, age ) );
        float p = exp( -pow( ( x - sep ) / w, 2.0 ) ) + exp( -pow( ( x + sep ) / w, 2.0 ) );
        p = min( p, 1.0 );
        // older trail: lumpy, with gaps and mammatus-like pouches along it
        float n = tNoise( vec2( vTrail.w * 0.0025, x * 1.5 + age * 3.0 ) ) * 0.65 + tNoise( vec2( vTrail.w * 0.011, x * 3.7 ) ) * 0.35;
        float breakup = mix( 1.0, smoothstep( 0.18, 0.75, n ), smoothstep( 0.15, 0.7, age ) );
        float a = vTrail.z * p * breakup;
        if ( a < 0.003 ) discard;
        float mu = dot( normalize( vView ), normalize( uSunDir ) );
        float g = 0.75;
        float phase = ( 1.0 - g * g ) / pow( 1.0 + g * g - 2.0 * g * mu, 1.5 ) * 0.08 + 0.5;
        vec3 col = ( uSunColor * phase * 0.35 + uSky * 0.55 ) * 0.9;
        gl_FragColor = vec4( col, clamp( a, 0.0, 0.85 ) );
        #include <fog_fragment>
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
  });
}
