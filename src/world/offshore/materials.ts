/**
 * Materials for the offshore scenery (render). All fog-enabled (the global aerial perspective and
 * cloud shadows apply through `MeshStandardMaterial`), calibrated for the HDR pipeline.
 *
 *  - `createOffshoreMaterial`: ONE vertex-coloured PBR material for everything built with the
 *    traffic MeshBuilder (`aPbr` = roughness, metalness, –, glass flag): steel, paint, decks, glass.
 *    Glass (`aPbr.w < −0.5`) shows warm lit windows at night (`uNight`). With `flare` it is also
 *    lit by the burning gas flare: a fake point light in the shader (position in view space, a
 *    flickering colour, inverse-square fall-off) — no three.js light, no extra pass.
 *  - `createFlameMaterial`: the flare's flame — an additive, animated, HDR-bright shader on a few
 *    crossed quads, leaning downwind.
 *  - `createGlowMaterial`: a soft additive radial glow (the flare's light on the sea at night).
 */
import * as THREE from 'three';

export interface FlareLightUniforms {
  /** Flare position in VIEW space (set per render from the camera). */
  uFlareView: { value: THREE.Vector3 };
  /** Flare colour × intensity (scene units at 1 m; falls off with distance²). */
  uFlareColor: { value: THREE.Color };
  /** Distance (m) inside which the fall-off flattens (the flame's size). */
  uFlareRange: { value: number };
  /** 0 day … 1 night: the lit windows. */
  uNight: { value: number };
}

export function createFlareUniforms(): FlareLightUniforms {
  return {
    uFlareView: { value: new THREE.Vector3() },
    uFlareColor: { value: new THREE.Color(0, 0, 0) },
    uFlareRange: { value: 25 },
    uNight: { value: 0 },
  };
}

/** The shared vertex-coloured PBR material (see the file header). `u` = shared flare / night uniforms. */
export function createOffshoreMaterial(u: FlareLightUniforms, opts: { flare: boolean; name: string; doubleSide?: boolean }): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.2, side: opts.doubleSide ? THREE.DoubleSide : THREE.FrontSide });
  m.name = opts.name;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uFlareView = u.uFlareView;
    shader.uniforms.uFlareColor = u.uFlareColor;
    shader.uniforms.uFlareRange = u.uFlareRange;
    shader.uniforms.uNight = u.uNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 aPbr;
varying vec4 vPbr;
varying vec3 vObjPos;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vPbr = aPbr;
vObjPos = position;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec4 vPbr;
varying vec3 vObjPos;
uniform vec3 uFlareView;
uniform vec3 uFlareColor;
uniform float uFlareRange;
uniform float uNight;`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vPbr.x;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vPbr.y;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
${opts.flare ? `{
  // the gas flare as a point light (view space): Lambert × inverse square, flattened inside its flame
  vec3 toF = uFlareView + vViewPosition;
  float d2 = dot( toF, toF );
  float ndl = max( dot( normal, toF * inversesqrt( max( d2, 1e-4 ) ) ), 0.0 ) * 0.8 + 0.2;
  totalEmissiveRadiance += diffuseColor.rgb * uFlareColor * ndl / ( d2 + uFlareRange * uFlareRange );
}` : ''}
if ( vPbr.w < -0.5 && uNight > 0.001 ) {
  // lit windows: a pattern of warm cells (≈1.5 m × 1.4 m), some dark
  vec3 cell = floor( vObjPos * vec3( 0.66, 0.31, 0.66 ) );
  float h = fract( sin( dot( cell, vec3( 12.9898, 78.233, 37.719 ) ) ) * 43758.5453 );
  vec3 f = fract( vObjPos * vec3( 0.66, 0.31, 0.66 ) );
  float frame = step( 0.15, f.y ) * step( f.y, 0.8 );
  totalEmissiveRadiance += vec3( 1.0, 0.78, 0.5 ) * uNight * step( 0.35, h ) * frame * ( 0.6 + 0.8 * h ) * 1.4;
}`);
  };
  m.customProgramCacheKey = () => `offshore-${opts.flare ? 'flare' : 'plain'}`;
  return m;
}

/** The flare flame (additive): `uTime` animates it, `uIntensity` scales its HDR brightness. */
export function createFlameMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'offshore.flame',
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
    uniforms: { uTime: { value: 0 }, uIntensity: { value: 1 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uIntensity;
      varying vec2 vUv;
      float hash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
      float noise( vec2 p ) {
        vec2 i = floor( p ); vec2 f = fract( p ); f = f * f * ( 3.0 - 2.0 * f );
        return mix( mix( hash( i ), hash( i + vec2( 1, 0 ) ), f.x ), mix( hash( i + vec2( 0, 1 ) ), hash( i + vec2( 1, 1 ) ), f.x ), f.y );
      }
      void main() {
        // u across (0..1), v up the flame (0 base .. 1 tip); turbulence rises
        float x = vUv.x - 0.5;
        float y = vUv.y;
        float n = noise( vec2( x * 5.0, y * 3.0 - uTime * 2.6 ) ) * 0.6 + noise( vec2( x * 11.0, y * 7.0 - uTime * 5.1 ) ) * 0.4;
        float w = mix( 0.42, 0.06, pow( y, 0.8 ) ) * ( 0.75 + 0.5 * n );
        float body = smoothstep( w, w * 0.25, abs( x + ( n - 0.5 ) * 0.18 * y ) );
        float fade = smoothstep( 0.0, 0.08, y ) * ( 1.0 - smoothstep( 0.55 + 0.35 * n, 1.0, y ) );
        float a = body * fade;
        if ( a < 0.003 ) discard;
        vec3 hot = vec3( 1.0, 0.92, 0.7 );
        vec3 mid = vec3( 1.0, 0.52, 0.12 );
        vec3 edge = vec3( 0.75, 0.16, 0.02 );
        vec3 c = mix( edge, mix( mid, hot, smoothstep( 0.4, 0.95, body ) * ( 1.0 - y ) ), smoothstep( 0.0, 0.6, body ) );
        gl_FragColor = vec4( c * a * uIntensity, 1.0 );
      }`,
  });
}

/** A soft radial glow for a flat quad (additive): `uColor` × intensity, fading to the edge. */
export function createGlowMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'offshore.glow',
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
    uniforms: { uColor: { value: new THREE.Color(0, 0, 0) } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying vec2 vUv;
      void main() {
        float r = length( vUv - 0.5 ) * 2.0;
        float a = pow( max( 1.0 - r, 0.0 ), 3.0 );
        if ( a < 0.002 ) discard;
        gl_FragColor = vec4( uColor * a, 1.0 );
      }`,
  });
}
