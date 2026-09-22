/**
 * Materials for traffic. All fog-enabled (the global aerial-perspective fog
 * applies), calibrated for the HDR pipeline (sun ≈ 3 scene units, exposure 2.2).
 *
 *  - `createBatchMaterial`: MeshStandardMaterial for BatchedMesh models whose
 *    vertices carry `aPbr` (roughness, metalness, tint mask, sail flutter):
 *    tint mixes the per-instance batching colour (livery / hull paint) in,
 *    sails flutter along their normal, and (ships) hulls below the waterline
 *    fade into the water colour.
 *  - `createWakeMaterial`: foam trail + Kelvin arm ribbons on the water.
 *  - `createGlowMaterial`: screen-sized light points (nav/strobe/landing
 *    lights, far-aircraft dots, sun glints) with a minimum pixel size.
 *  - `createDiscMaterial`: propeller / rotor blur discs (instanced).
 *  - `createContrailMaterial`: persistent contrail ribbons (sun-lit, forward-scattering).
 *  - `createSprayMaterial`: bow spray particles.
 */
import * as THREE from 'three';

export interface LightingUniforms {
  uSunDir: { value: THREE.Vector3 };
  /** Sun colour × intensity (scene units). */
  uSunColor: { value: THREE.Color };
  /** Sky irradiance on a horizontal surface (scene units). */
  uSky: { value: THREE.Color };
  uTime: { value: number };
}

export function createLightingUniforms(): LightingUniforms {
  return {
    uSunDir: { value: new THREE.Vector3(0.4, 0.7, -0.5).normalize() },
    uSunColor: { value: new THREE.Color(3, 2.9, 2.7) },
    uSky: { value: new THREE.Color(0.6, 0.75, 1.0) },
    uTime: { value: 0 },
  };
}

/** Uniforms that share the global atmospheric fog array (see render/fog.ts). */
function fogUniforms(): Record<string, THREE.IUniform> {
  const u: Record<string, THREE.IUniform> = THREE.UniformsUtils.clone(THREE.UniformsLib.fog);
  const lib = THREE.UniformsLib.fog as Record<string, THREE.IUniform>;
  if (lib.atmoFog) u.atmoFog = { value: lib.atmoFog.value };
  return u;
}

export function createBatchMaterial(shared: LightingUniforms, opts: { underwater: boolean; name: string }): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.5, metalness: 0, envMapIntensity: 1 });
  m.name = opts.name;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = shared.uTime;
    shader.uniforms.uWaterDeep = { value: new THREE.Color(0.012, 0.05, 0.065) };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec4 aPbr;
varying vec4 vPbr;
varying float vLocalY;
uniform float uTime;`,
      )
      .replace(
        '#include <color_vertex>',
        `#if defined( USE_COLOR ) || defined( USE_BATCHING_COLOR )
  vColor = vec4( color, 1.0 );
  #ifdef USE_BATCHING_COLOR
    vec4 tintC = getBatchingColor( getIndirectIndex( gl_DrawID ) );
    vColor.rgb = mix( vColor.rgb, vColor.rgb * tintC.rgb, aPbr.z );
  #endif
#endif
vPbr = aPbr;
vLocalY = position.y;`,
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
varying float vLocalY;
uniform vec3 uWaterDeep;`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `float roughnessFactor = vPbr.x;`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `float metalnessFactor = vPbr.y;`,
      );
    if (opts.underwater) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
if ( vLocalY < 0.0 ) {
  float wd = 1.0 - exp( vLocalY * 0.55 );
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

export function createWakeMaterial(shared: LightingUniforms): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({
    name: 'traffic.wake',
    uniforms: { ...fogUniforms(), ...shared },
    vertexShader: /* glsl */ `
      attribute vec4 aWake;
      attribute float aType;
      varying vec4 vWake;
      varying float vType;
      varying vec3 vWorld;
      #include <fog_pars_vertex>
      void main() {
        vWake = aWake;
        vType = aType;
        vec4 wp = modelMatrix * vec4( position, 1.0 );
        vWorld = wp.xyz;
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
      varying vec3 vWorld;
      #include <fog_pars_fragment>
      ${NOISE_GLSL}
      void main() {
        float along = vWake.x;
        float across = vWake.y;
        float age = vWake.z;
        float strength = vWake.w;
        if ( strength < 0.003 ) discard;
        float a;
        if ( vType < 0.5 ) {
          // turbulent foam: solid white churn near the stern breaking up into streaks and patches
          float prof = 1.0 - across * across;
          prof = pow( max( prof, 0.0 ), 0.8 );
          vec2 q = vec2( along * 0.11, across * 1.7 );
          float n = tNoise( q + vec2( 0.0, uTime * 0.05 ) ) * 0.6 + tNoise( q * 3.1 + 7.3 ) * 0.4;
          float streak = smoothstep( 0.25 + 0.45 * age, 0.85, n );
          float core = exp( -across * across * 5.0 ) * ( 1.0 - smoothstep( 0.0, 0.35, age ) );
          a = strength * prof * mix( streak, 1.0, core * 0.8 ) * ( 0.95 - 0.35 * age );
        } else {
          // Kelvin arm: a bright crest on the inner edge with feathered echelon wavelets
          float edge = exp( -pow( ( across + 0.45 ) * 2.0, 2.0 ) );
          float feather = 0.5 + 0.5 * sin( along * 0.75 + across * 2.6 );
          feather = smoothstep( 0.35, 1.0, feather );
          float n = tNoise( vec2( along * 0.18, across * 2.0 ) );
          a = strength * edge * mix( 0.35, 1.0, feather ) * ( 0.6 + 0.4 * n ) * 0.8;
        }
        a = clamp( a, 0.0, 0.95 );
        if ( a < 0.004 ) discard;
        // lit foam (Lambert, facing up) with a touch of sky
        float ndl = max( uSunDir.y, 0.0 );
        vec3 col = 0.9 * ( uSunColor * ndl + uSky ) / 3.14159;
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
 * Screen-space glow points. Attributes: position, `aColor` (rgb HDR), `aSize` (world metres),
 * `aMinPx` (minimum pixel diameter), `aDir` (xyz: facing direction for directional lamps, 0 = omni).
 */
export function createGlowMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'traffic.glow',
    uniforms: { uHalfHeight: { value: 450 }, ...fogUniforms() },
    vertexShader: /* glsl */ `
      attribute vec3 aColor;
      attribute float aSize;
      attribute float aMinPx;
      attribute vec3 aDir;
      uniform float uHalfHeight;
      varying vec3 vColor;
      varying float vCore;
      #include <fog_pars_vertex>
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
        gl_Position = projectionMatrix * mvPosition;
        float facing = 1.0;
        if ( dot( aDir, aDir ) > 0.0 ) {
          vec3 d = normalize( ( viewMatrix * vec4( aDir, 0.0 ) ).xyz );
          facing = pow( max( dot( d, normalize( -mvPosition.xyz ) ), 0.0 ), 6.0 ) * 0.95 + 0.05;
        }
        float px = aSize * projectionMatrix[1][1] * uHalfHeight / max( -mvPosition.z, 0.05 );
        float size = max( px, aMinPx );
        // energy conservation: when clamped to the minimum size, dim instead of growing
        float k = px < aMinPx ? pow( px / aMinPx, 1.2 ) : 1.0;
        vColor = aColor * facing * max( k, 0.0 );
        vCore = px < aMinPx ? 1.0 : 0.0;
        gl_PointSize = dot( aColor, aColor ) > 0.0 ? clamp( size, 0.0, 256.0 ) : 0.0;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      varying float vCore;
      #include <fog_pars_fragment>
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r2 = dot( d, d ) * 4.0;
        if ( r2 >= 1.0 ) discard;
        float core = exp( -r2 * 9.0 );
        float halo = exp( -r2 * 3.0 ) * ( 1.0 - r2 ) * 0.25;
        gl_FragColor = vec4( vColor * ( core + halo ), 1.0 );
        #include <fog_fragment>
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
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

/** Contrail ribbon: `aTrail` = (age01, across −1..1, opacity, width m). Sun-lit with forward scattering. */
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
        float breakup = mix( 1.0, 0.55 + 0.45 * tNoise( vec2( vTrail.w * 0.004 + age * 40.0, x * 2.0 ) ), smoothstep( 0.2, 0.8, age ) );
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

/** Bow spray: `aSpray` = (alpha, size m). */
export function createSprayMaterial(shared: LightingUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'traffic.spray',
    uniforms: { ...fogUniforms(), uHalfHeight: { value: 450 }, uSunDir: shared.uSunDir, uSunColor: shared.uSunColor, uSky: shared.uSky },
    vertexShader: /* glsl */ `
      attribute vec2 aSpray;
      uniform float uHalfHeight;
      varying float vA;
      #include <fog_pars_vertex>
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
        gl_Position = projectionMatrix * mvPosition;
        float px = aSpray.y * projectionMatrix[1][1] * uHalfHeight / max( -mvPosition.z, 0.05 );
        vA = aSpray.x * min( 1.0, px / 1.5 );
        gl_PointSize = aSpray.x > 0.0 ? clamp( px, 1.5, 128.0 ) : 0.0;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform vec3 uSky;
      varying float vA;
      #include <fog_pars_fragment>
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r2 = dot( d, d ) * 4.0;
        if ( r2 >= 1.0 ) discard;
        float a = vA * ( 1.0 - r2 ) * ( 1.0 - r2 );
        vec3 col = 0.92 * ( uSunColor * max( uSunDir.y, 0.2 ) + uSky ) / 3.14159;
        gl_FragColor = vec4( col, a );
        #include <fog_fragment>
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    fog: true,
  });
}
