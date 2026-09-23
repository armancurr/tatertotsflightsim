/**
 * Materials for the traffic (all fog-enabled, HDR-calibrated: sun ≈ 3 scene
 * units, exposure ≈ 2.2):
 *
 * - `createCarMaterial`: MeshPhysicalMaterial for the vehicle BatchedMesh.
 *   Per instance (a data texture indexed by the batch instance id, 2 texels):
 *   paint (linear rgb + finish) and (odometer, steering angle, light flags,
 *   road kind). Vertex: wheels spin about their hub (and the fronts steer),
 *   a per-vehicle amount of road grime (a hash of the instance) that builds
 *   up toward the sills in splashy patches — duller, browner, no clear coat,
 *   the road's LOD lift + depth pull (roads/depth.ts) so a car never sinks into
 *   coarse terrain. Fragment: paint where aMat.x = 1 with a clear coat
 *   (reflections from scene.environment), solid/metallic/solid finishes,
 *   tinted glass, lamps: head lamps, tail/brake lamps, amber indicators.
 * - `createShadowMaterial`: contact shadows — a soft dark patch under each
 *   body plus its cast shadow swept away from the sun, multiplied onto the road.
 * - `createGlowMaterial`: screen-sized head/tail lamp glows at dusk, brightest
 *   when a lamp faces the camera.
 */
import * as THREE from 'three';
import { DEPTH_GLSL, lodLiftArray } from '../roads/depth';
import { CONFIG } from '../../config';

/** Light flag bits (instance data). */
export const FLAG_HEAD = 1;
export const FLAG_BRAKE = 2;
export const FLAG_IND_L = 4;
export const FLAG_IND_R = 8;

export interface CarUniforms {
  uCarData: { value: THREE.DataTexture };
  uCarDataW: { value: number };
  uLodLift: { value: number[] };
  uDepthPull: { value: number };
  /** 0..1: lamps on (dusk). */
  uLights: { value: number };
  /** Indicator blink phase 0/1. */
  uBlink: { value: number };
  /** Shadow: sun direction (unit, world) and fade distance. */
  uSunDir: { value: THREE.Vector3 };
  uShadowFar: { value: number };
  /** Glow: pixels per metre at 1 m (viewport height / (2·tan(fov/2))). */
  uPx: { value: number };
}

export function createCarUniforms(data: THREE.DataTexture): CarUniforms {
  const rc = CONFIG.world.towns.roads;
  return {
    uCarData: { value: data },
    uCarDataW: { value: data.image.width },
    uLodLift: { value: lodLiftArray(rc) },
    uDepthPull: { value: rc.depthPull },
    uLights: { value: 0 },
    uBlink: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0.3, 0.8, -0.5).normalize() },
    uShadowFar: { value: CONFIG.world.cars.shadowDistance },
    uPx: { value: 900 },
  };
}

function replaceOnce(src: string, find: string, repl: string): string {
  if (!src.includes(find)) throw new Error(`cars material: shader chunk ${find} not found`);
  return src.replace(find, repl);
}

export function createCarMaterial(u: CarUniforms): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    roughness: 0.5,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
    envMapIntensity: 1,
    fog: true,
  });
  m.name = 'cars';
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uCarData = u.uCarData;
    shader.uniforms.uCarDataW = u.uCarDataW;
    shader.uniforms.uLodLift = u.uLodLift;
    shader.uniforms.uDepthPull = u.uDepthPull;
    shader.uniforms.uLights = u.uLights;
    shader.uniforms.uBlink = u.uBlink;
    let v = shader.vertexShader;
    v = replaceOnce(
      v,
      '#include <common>',
      /* glsl */ `#include <common>
attribute vec4 aMat;
attribute vec4 aWheel;
uniform highp sampler2D uCarData;
uniform float uCarDataW;
varying vec4 vCarPaint;
varying vec4 vCarMat;
varying float vCarFlags;
varying vec4 vCarDirt;
${DEPTH_GLSL}
float cLift = 4.0;
float cAng = 0.0;
float cSteer = 0.0;
vec3 carRot( vec3 p ) {
  float c = cos( cAng );
  float s = sin( cAng );
  p = vec3( p.x, p.y * c - p.z * s, p.y * s + p.z * c );
  float c2 = cos( -cSteer );
  float s2 = sin( -cSteer );
  return vec3( p.x * c2 + p.z * s2, p.y, -p.x * s2 + p.z * c2 );
}`,
    );
    v = replaceOnce(
      v,
      '#include <batching_vertex>',
      /* glsl */ `#include <batching_vertex>
{
  int ci = int( getIndirectIndex( gl_DrawID ) ) * 2;
  int cw = int( uCarDataW );
  vec4 d0 = texelFetch( uCarData, ivec2( ci % cw, ci / cw ), 0 );
  vec4 d1 = texelFetch( uCarData, ivec2( ( ci + 1 ) % cw, ( ci + 1 ) / cw ), 0 );
  vCarPaint = d0;
  vCarMat = aMat;
  vCarFlags = d1.z;
  cLift = d1.w;
  // road grime: a per-vehicle amount (most cars fairly clean, a few filthy), splashed up from the road
  float dh = fract( sin( float( ci ) * 12.9898 + 4.1 ) * 43758.5453 );
  vCarDirt = vec4( position, ( 0.12 + 0.88 * dh * dh ) * ( 1.0 - smoothstep( 0.08, 0.85, position.y ) ) );
  if ( aWheel.w != 0.0 ) {
    cAng = -d1.x / abs( aWheel.w );
    cSteer = aWheel.w < 0.0 ? d1.y : 0.0;
  }
}`,
    );
    v = replaceOnce(v, '#include <beginnormal_vertex>', /* glsl */ `#include <beginnormal_vertex>\nif ( aWheel.w != 0.0 ) objectNormal = carRot( objectNormal );`);
    v = replaceOnce(v, '#include <begin_vertex>', /* glsl */ `#include <begin_vertex>\nif ( aWheel.w != 0.0 ) transformed = aWheel.xyz + carRot( position - aWheel.xyz );`);
    v = replaceOnce(
      v,
      '#include <project_vertex>',
      /* glsl */ `vec4 cWorld = modelMatrix * batchingMatrix * vec4( transformed, 1.0 );
cWorld.y += roadLodLift( cLift, distance( cWorld.xyz, cameraPosition ) );
vec4 mvPosition = viewMatrix * cWorld;
gl_Position = projectionMatrix * roadPull( mvPosition );`,
    );
    shader.vertexShader = v;
    let f = shader.fragmentShader;
    f = replaceOnce(
      f,
      '#include <common>',
      /* glsl */ `#include <common>
varying vec4 vCarPaint;
varying vec4 vCarMat;
varying float vCarFlags;
varying vec4 vCarDirt;
uniform float uLights;
uniform float uBlink;
float carNoise( vec3 p ) {
  vec3 i = floor( p );
  vec3 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  float n = dot( i, vec3( 1.0, 57.0, 113.0 ) );
  vec4 h = fract( sin( vec4( n, n + 1.0, n + 57.0, n + 58.0 ) ) * 43758.5453 );
  vec4 h2 = fract( sin( vec4( n + 113.0, n + 114.0, n + 170.0, n + 171.0 ) ) * 43758.5453 );
  vec2 a = mix( h.xz, h.yw, f.x );
  vec2 b = mix( h2.xz, h2.yw, f.x );
  return mix( mix( a.x, a.y, f.y ), mix( b.x, b.y, f.y ), f.z );
}
float carDirt = 0.0;`,
    );
    f = replaceOnce(f, '#include <color_fragment>', /* glsl */ `#include <color_fragment>\ndiffuseColor.rgb = mix( diffuseColor.rgb, vCarPaint.rgb, vCarMat.x );
{
  float sp = carNoise( vCarDirt.xyz * vec3( 7.0, 5.0, 3.0 ) ) * 0.65 + carNoise( vCarDirt.xyz * 19.0 ) * 0.35;
  carDirt = clamp( vCarDirt.w * ( 0.55 + 0.9 * sp ) - 0.08, 0.0, 1.0 ) * ( vCarMat.w > 0.5 ? 0.35 : 1.0 );
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.085, 0.07, 0.052 ), carDirt * 0.6 );
}`);
    f = replaceOnce(f, '#include <roughnessmap_fragment>', /* glsl */ `float roughnessFactor = mix( mix( vCarMat.y, vCarPaint.a > 0.5 ? 0.3 : 0.36, vCarMat.x ), 0.92, carDirt * 0.8 );`);
    f = replaceOnce(f, '#include <metalnessmap_fragment>', /* glsl */ `float metalnessFactor = mix( vCarMat.z, vCarPaint.a < 0.5 ? 0.0 : vCarPaint.a < 1.5 ? 0.22 : 0.5, vCarMat.x );`);
    f = replaceOnce(f, '#include <lights_physical_fragment>', /* glsl */ `#include <lights_physical_fragment>\nmaterial.clearcoat *= vCarMat.x * ( 1.0 - carDirt );`);
    f = replaceOnce(
      f,
      '#include <emissivemap_fragment>',
      /* glsl */ `#include <emissivemap_fragment>
{
  float lamp = floor( vCarMat.w + 0.5 );
  float fl = floor( vCarFlags + 0.5 );
  float head = mod( fl, 2.0 );
  float brake = mod( floor( fl / 2.0 ), 2.0 );
  float indL = mod( floor( fl / 4.0 ), 2.0 );
  float indR = mod( floor( fl / 8.0 ), 2.0 );
  if ( lamp > 0.5 && lamp < 1.5 ) {
    totalEmissiveRadiance += vec3( 1.0, 0.92, 0.8 ) * 45.0 * head * uLights;
  } else if ( lamp > 1.5 && lamp < 3.5 ) {
    float ind = lamp < 2.5 ? indL : indR;
    totalEmissiveRadiance += vec3( 1.0, 0.035, 0.015 ) * ( 7.0 * head * uLights + 14.0 * brake + 14.0 * ind * uBlink );
  } else if ( lamp > 3.5 ) {
    float ind = lamp < 4.5 ? indL : indR;
    totalEmissiveRadiance += vec3( 1.0, 0.42, 0.04 ) * 16.0 * ind * uBlink;
  }
}`,
    );
    shader.fragmentShader = f;
  };
  m.customProgramCacheKey = () => 'cars-v2';
  return m;
}

/**
 * Contact shadows (instanced unit quads, multiplied onto what is below).
 * Instance attributes: aDims (half length, half width, sun offset x, z in the
 * car frame), aMisc (strength, road kind, quad size x, z).
 */
export function createShadowMaterial(u: CarUniforms): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({
    uniforms: { uLodLift: u.uLodLift, uDepthPull: u.uDepthPull, uShadowFar: u.uShadowFar },
    vertexShader: /* glsl */ `
      ${DEPTH_GLSL}
      attribute vec4 aDims;
      attribute vec4 aMisc;
      uniform float uShadowFar;
      varying vec2 vLocal;
      varying vec4 vDims;
      varying float vStrength;
      void main() {
        vec2 lp = vec2( position.x * aMisc.z, position.z * aMisc.w ) + 0.5 * aDims.zw;
        vLocal = lp;
        vDims = aDims;
        vec4 w = modelMatrix * instanceMatrix * vec4( lp.x, 0.0, lp.y, 1.0 );
        float d = distance( w.xyz, cameraPosition );
        w.y += 0.035 + roadLodLift( aMisc.y, d );
        vStrength = aMisc.x * ( 1.0 - smoothstep( 0.55 * uShadowFar, uShadowFar, d ) );
        vec4 mv = viewMatrix * w;
        gl_Position = projectionMatrix * roadPull( mv );
      }`,
    fragmentShader: /* glsl */ `
      varying vec2 vLocal;
      varying vec4 vDims;
      varying float vStrength;
      float boxSdf( vec2 p, vec2 b ) {
        vec2 d = abs( p ) - b;
        return length( max( d, 0.0 ) ) + min( max( d.x, d.y ), 0.0 );
      }
      void main() {
        vec2 hb = vec2( vDims.y, vDims.x );
        // ambient occlusion right under the body
        float ao = 1.0 - smoothstep( -0.35, 0.5, boxSdf( vLocal, hb * 0.92 ) );
        // the body's shadow swept away from the sun (softer toward its tip)
        float cst = 0.0;
        for ( int k = 0; k < 4; k++ ) {
          float t = float( k ) / 3.0;
          float soft = 0.35 + 0.5 * t;
          cst = max( cst, ( 1.0 - smoothstep( -soft, soft, boxSdf( vLocal - vDims.zw * t, hb * 0.9 ) ) ) * ( 1.0 - 0.35 * t ) );
        }
        float a = clamp( max( ao * 0.72, cst * 0.5 ) * vStrength, 0.0, 0.85 );
        if ( a < 0.004 ) discard;
        gl_FragColor = vec4( vec3( 1.0 - a ), 1.0 );
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.ZeroFactor,
    blendDst: THREE.SrcColorFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
  m.name = 'car-shadows';
  return m;
}

/** Lamp glows (points): attributes position, aGlow (dir x, dir z, kind 0 head / 1 tail, intensity). */
export function createGlowMaterial(u: CarUniforms): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uPx: { value: 900 }, uLodLift: { value: [0, 0, 0, 0, 0, 0, 0, 0] }, uDepthPull: { value: 0 } }]),
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      ${DEPTH_GLSL}
      attribute vec4 aGlow;
      uniform float uPx;
      varying vec3 vCol;
      void main() {
        vec3 transformed = position;
        vec4 mvPosition = modelViewMatrix * vec4( transformed, 1.0 );
        float d = -mvPosition.z;
        gl_Position = projectionMatrix * roadPull( mvPosition );
        vec3 toCam = normalize( cameraPosition - position );
        float facing = smoothstep( -0.25, 0.75, dot( vec3( aGlow.x, 0.0, aGlow.y ), toCam ) );
        bool tail = aGlow.z > 0.5;
        float px = ( tail ? 1.0 : 1.6 ) * uPx / max( d, 1.0 );
        gl_PointSize = clamp( px, 2.5, 26.0 );
        float fade = clamp( px / 2.5, 0.35, 1.0 );
        vCol = ( tail ? vec3( 1.0, 0.05, 0.02 ) * 4.5 : vec3( 1.0, 0.9, 0.75 ) * 10.0 ) * aGlow.w * facing * fade;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      varying vec3 vCol;
      void main() {
        vec2 c = gl_PointCoord * 2.0 - 1.0;
        float r2 = dot( c, c );
        if ( r2 > 1.0 ) discard;
        gl_FragColor = vec4( vCol * exp( -r2 * 5.0 ), 1.0 );
        #include <fog_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: true,
  });
  m.uniforms.uPx = u.uPx;
  m.uniforms.uLodLift = u.uLodLift;
  m.uniforms.uDepthPull = u.uDepthPull;
  m.name = 'car-glows';
  return m;
}
