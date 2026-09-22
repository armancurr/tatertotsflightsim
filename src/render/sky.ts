/**
 * Physically based sky dome.
 *
 * Per pixel: single scattering through a spherical Rayleigh + aerosol + ozone
 * atmosphere (16 energy-conserving steps, analytic Chapman sun transmittance)
 * — a line-by-line mirror of `skyRadiance` in atmosphereModel.ts. Near and
 * below the horizon it blends into the aerial-perspective haze colour from
 * fog.ts (`atmoFogScatter`, the same function every material's fog uses), so
 * distant terrain melts seamlessly into the sky. On top: a limb-darkened sun
 * disc reddened by the view transmittance, and high cirrus wisps.
 *
 * The dome is a unit sphere drawn around the camera (view rotation only) at
 * the far plane, after all opaque geometry (renderOrder), so only visible sky
 * pixels are shaded. A second material (ENV_MODE) shares the uniforms for the
 * PMREM environment bake: no sun disc/cirrus, and a hazy ground below the
 * horizon so PBR materials get sky light from above and ground bounce below.
 */
import * as THREE from 'three';
import { ATMO_FOG_GLSL, atmoFogData } from './fog';
import type { AtmosphereParams, RGB } from './atmosphereModel';
import { fbm2 } from './noise';
import type { Vec3 } from '../types';

export const SKY_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunE;
uniform vec3 uBetaR;
uniform float uHR;
uniform float uBetaMe;
uniform float uMieAlbedo;
uniform float uHM;
uniform float uMieG;
uniform vec3 uBetaO;
uniform float uOzoneC;
uniform float uOzoneW;
uniform float uMS;

const float PR = 6360e3;
const float PT = 6460e3;
const float LN2 = 0.6931472;

float chapmanL( float H, float h, float cosZ ) {
	float u = H * LN2;
	float X = PR / u;
	float hh = h / u;
	float c = sqrt( X + hh );
	if ( cosZ >= 0.0 ) return H * c * exp2( - hh ) / ( c * cosZ + 1.0 );
	float x0 = sqrt( max( 0.0, 1.0 - cosZ * cosZ ) ) * ( X + hh );
	float c0 = sqrt( x0 );
	return H * ( 2.0 * c0 * exp2( X - x0 ) - c * exp2( - hh ) / ( 1.0 - c * cosZ ) );
}
float ozoneL( float h, float cosZ ) {
	float lo = uOzoneC - uOzoneW;
	float hi = uOzoneC + uOzoneW;
	float column;
	if ( h <= lo ) column = uOzoneW;
	else if ( h <= uOzoneC ) column = uOzoneW - ( h - lo ) * ( h - lo ) / ( 2.0 * uOzoneW );
	else if ( h < hi ) column = ( hi - h ) * ( hi - h ) / ( 2.0 * uOzoneW );
	else return 0.0;
	float ro = PR + max( h, uOzoneC );
	float r = PR + h;
	float s = ( r / ro ) * ( r / ro ) * ( 1.0 - cosZ * cosZ );
	return column / sqrt( max( 0.0025, 1.0 - s ) );
}
bool hitsPlanet( float h, float cosZ ) {
	if ( cosZ >= 0.0 ) return false;
	float r = PR + h;
	return h * ( 2.0 * PR + h ) < r * r * cosZ * cosZ;
}
vec3 transToSpace( float h, float cosZ ) {
	if ( hitsPlanet( h, cosZ ) ) return vec3( 0.0 );
	float lR = chapmanL( uHR, h, cosZ );
	float lM = chapmanL( uHM, h, cosZ );
	float lO = ozoneL( h, cosZ );
	return exp( - ( uBetaR * lR + uBetaMe * lM + uBetaO * lO ) );
}
float skyPhaseR( float mu ) { return 0.0596831 * ( 1.0 + mu * mu ); }
float skyPhaseM( float mu, float g ) {
	float g2 = g * g;
	return 0.1193662 * ( ( 1.0 - g2 ) * ( 1.0 + mu * mu ) ) / ( ( 2.0 + g2 ) * pow( max( 1e-6, 1.0 + g2 - 2.0 * g * mu ), 1.5 ) );
}
vec3 skyRadiance( vec3 dir, float camH ) {
	float h0 = max( camH, 1.0 );
	float r0 = PR + h0;
	float mu = dir.y;
	float nu = dot( dir, uSunDir );
	float discTop = ( PT - r0 ) * ( PT + r0 ) + r0 * r0 * mu * mu;
	float tMax = - r0 * mu + sqrt( max( 0.0, discTop ) );
	float discG = r0 * r0 * mu * mu - h0 * ( 2.0 * PR + h0 );
	if ( mu < 0.0 && discG > 0.0 ) tMax = - r0 * mu - sqrt( discG );
	float phR = skyPhaseR( nu );
	float phM = skyPhaseM( nu, uMieG );
	float bMs = uBetaMe * uMieAlbedo;
	vec3 tv = vec3( 1.0 );
	vec3 L = vec3( 0.0 );
	for ( int i = 0; i < 16; i ++ ) {
		float s0 = float( i ) / 16.0;
		float s1 = float( i + 1 ) / 16.0;
		float t0 = tMax * s0 * s0;
		float t1 = tMax * s1 * s1;
		float dt = t1 - t0;
		float tm = 0.5 * ( t0 + t1 );
		float q = h0 * ( 2.0 * PR + h0 ) + tm * tm + 2.0 * r0 * tm * mu;
		float r = sqrt( PR * PR + q );
		float h = q / ( r + PR );
		float dR = exp( - h / uHR );
		float dM = exp( - h / uHM );
		float dO = max( 0.0, 1.0 - abs( h - uOzoneC ) / uOzoneW );
		vec3 sR = uBetaR * dR;
		float sMs = bMs * dM;
		float sMe = uBetaMe * dM;
		vec3 ext = sR + sMe + uBetaO * dO;
		float muS = ( r0 * uSunDir.y + tm * nu ) / r;
		vec3 ts = transToSpace( h, muS );
		vec3 ms = uMS * 0.0795775 * ( ts + 0.02 );
		vec3 S = ts * ( sR * phR + sMs * phM ) + ( sR + sMs ) * ms;
		vec3 T = exp( - ext * dt );
		L += tv * S * ( 1.0 - T ) / max( ext, vec3( 1e-12 ) );
		tv *= T;
	}
	return L * uSunE;
}
`;

const VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
	vDir = position;
	vec4 p = projectionMatrix * vec4( ( viewMatrix * vec4( position, 0.0 ) ).xyz, 1.0 );
	#ifdef USE_REVERSED_DEPTH_BUFFER
		p.z = 0.0;
	#else
		p.z = p.w;
	#endif
	gl_Position = p;
}
`;

const FRAGMENT = /* glsl */ `
${ATMO_FOG_GLSL}
${SKY_GLSL}
uniform float uCamY;
uniform float uSeaLevel;
uniform vec3 uGround;
uniform float uSunRadius;
uniform float uSunDiscScale;
uniform float uHorizonBlend;
uniform sampler2D tCirrus;
uniform vec4 uCirrus;        // altitude, coverage, opacity, uv scale (1/m)
uniform vec4 uCirrusOffset;  // camera xz, wind offset uv
uniform vec3 uCirrusSun;
uniform vec3 uCirrusAmb;
varying vec3 vDir;

void main() {
	vec3 dir = normalize( vDir );
	float camH = uCamY - uSeaLevel;
	float vis = atmoFog[ 2 ].w;
	float dist = vis;
	if ( dir.y < 0.0 ) dist = min( max( camH, 0.1 ) / - dir.y, vis );
	vec3 hazeT;
	vec3 haze = atmoFogScatter( dir * dist, uCamY, hazeT );
	haze += uGround * hazeT;
	float w = dir.y < 0.0 ? 1.0 : 1.0 - smoothstep( 0.0, uHorizonBlend, dir.y );
	vec3 L = haze;
	if ( w < 1.0 ) L = mix( skyRadiance( dir, camH ), haze, w );

	#ifndef ENV_MODE
	float nu = dot( dir, uSunDir );
	// cirrus: a streaky texture on a plane high above, lit by (forward-scattered) sunlight
	if ( dir.y > 0.015 && uCirrus.z > 0.0 ) {
		float t = ( uCirrus.x - uCamY ) / dir.y;
		vec2 p = ( uCirrusOffset.xy + dir.xz * t ) * uCirrus.w + uCirrusOffset.zw;
		float c = texture2D( tCirrus, p ).r * 0.8 + texture2D( tCirrus, p * 2.3 + 0.37 ).r * 0.2;
		// fade toward the horizon, where the plane projection stretches the wisps into streaks
		float a = smoothstep( 1.0 - uCirrus.y, 1.0 - uCirrus.y + 0.4, c ) * uCirrus.z * smoothstep( 0.06, 0.4, dir.y );
		float g = 0.7;
		float hg = ( 1.0 - g * g ) / ( 12.566 * pow( 1.0 + g * g - 2.0 * g * nu, 1.5 ) );
		vec3 tv = transToSpace( camH, dir.y );
		vec3 col = ( uCirrusSun * ( 0.05 + 0.6 * hg ) + uCirrusAmb ) * mix( vec3( 1.0 ), tv, 0.5 );
		L = mix( L, L * 0.75 + col, a );
	}
	// sun disc with limb darkening, reddened by the air in front of it
	if ( nu > 0.0 ) {
		float x = length( cross( dir, uSunDir ) ) / uSunRadius;
		if ( x < 1.5 ) {
			float aa = max( fwidth( x ), 1e-3 );
			float disc = 1.0 - smoothstep( 1.0 - aa, 1.0 + aa, x );
			float muL = sqrt( max( 0.0, 1.0 - x * x ) );
			vec3 limb = 1.0 - vec3( 0.48, 0.58, 0.7 ) * ( 1.0 - muL );
			vec3 tv = transToSpace( camH, dir.y );
			L += uSunE * tv * limb * disc * uSunDiscScale / ( 3.14159265 * uSunRadius * uSunRadius );
		}
	}
	#endif
	L = min( L, vec3( 60000.0 ) );
	gl_FragColor = vec4( L, 1.0 );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`;

/** Tileable streaky cirrus texture (R channel), generated once. */
export function createCirrusTexture(size = 256, seed = 7): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const vals = new Float32Array(size * size);
  let max = 1e-6;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      // domain-warped, anisotropic fbm → long hair-like strands
      const wx = fbm2(u * 4, v * 4, 3, seed + 3, 4) - 0.5;
      const wy = fbm2(u * 4 + 7.3, v * 4 + 1.1, 3, seed + 5, 4) - 0.5;
      const n = fbm2((u + wx * 0.25) * 3, (v + wy * 0.08) * 16, 5, seed, 3);
      const streak = fbm2(u * 2, v * 2, 2, seed + 9, 2);
      const val = Math.max(0, Math.min(1, (n - 0.35) * 1.8)) * (0.35 + 0.65 * streak);
      vals[y * size + x] = val;
      max = Math.max(max, val);
    }
  }
  // normalise to the full 0..1 range so `coverage` maps predictably
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    data[o] = Math.round((vals[i] / max) * 255);
    data[o + 1] = data[o];
    data[o + 2] = data[o];
    data[o + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

export interface SkyState {
  params: AtmosphereParams;
  sunDir: Vec3;
  cameraY: number;
  cameraX: number;
  cameraZ: number;
  seaLevel: number;
  groundRadiance: RGB;
  cirrusSun: RGB;
  cirrusAmbient: RGB;
}

export interface SkyOptions {
  cirrus?: { altitude: number; coverage: number; opacity: number; scale: number };
  sunAngularRadiusDeg?: number;
}

export interface Sky {
  /** Main-scene sky dome (add to the scene). */
  mesh: THREE.Mesh;
  /** Environment-bake dome (for PMREM, lives in its own scene). */
  envMesh: THREE.Mesh;
  uniforms: Record<string, THREE.IUniform>;
  setState(s: SkyState): void;
  /** Advance cirrus drift. */
  tick(dt: number): void;
  dispose(): void;
}

export function createSky(opts: SkyOptions = {}): Sky {
  const cirrusTex = createCirrusTexture();
  const ci = opts.cirrus ?? { altitude: 9000, coverage: 0.45, opacity: 0.55, scale: 1 / 45000 };
  const uniforms: Record<string, THREE.IUniform> = {
    atmoFog: { value: atmoFogData },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunE: { value: new THREE.Vector3(1, 1, 1) },
    uBetaR: { value: new THREE.Vector3() },
    uHR: { value: 8000 },
    uBetaMe: { value: 0 },
    uMieAlbedo: { value: 0.9 },
    uHM: { value: 1200 },
    uMieG: { value: 0.8 },
    uBetaO: { value: new THREE.Vector3() },
    uOzoneC: { value: 25e3 },
    uOzoneW: { value: 15e3 },
    uMS: { value: 0.5 },
    uCamY: { value: 0 },
    uSeaLevel: { value: 0 },
    uGround: { value: new THREE.Vector3() },
    uSunRadius: { value: ((opts.sunAngularRadiusDeg ?? 0.2666) * Math.PI) / 180 },
    uSunDiscScale: { value: 1 },
    uHorizonBlend: { value: 0.035 },
    tCirrus: { value: cirrusTex },
    uCirrus: { value: new THREE.Vector4(ci.altitude, ci.coverage, ci.opacity, ci.scale) },
    uCirrusOffset: { value: new THREE.Vector4() },
    uCirrusSun: { value: new THREE.Vector3() },
    uCirrusAmb: { value: new THREE.Vector3() },
  };
  const geo = new THREE.SphereGeometry(1, 48, 24);
  const view = new THREE.ShaderMaterial({
    name: 'AtmosphereSky',
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    fog: false,
  });
  const env = new THREE.ShaderMaterial({
    name: 'AtmosphereSkyEnv',
    uniforms,
    defines: { ENV_MODE: 1 },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(geo, view);
  mesh.name = 'sky';
  mesh.frustumCulled = false;
  mesh.renderOrder = 1e9; // after all opaque geometry → only visible sky pixels are shaded
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  const envMesh = new THREE.Mesh(geo, env);
  envMesh.frustumCulled = false;

  let windU = 0;
  let windV = 0;

  function setState(s: SkyState) {
    const p = s.params;
    uniforms.uSunDir.value.set(s.sunDir.x, s.sunDir.y, s.sunDir.z);
    uniforms.uSunE.value.set(p.sunIlluminance * p.sunColor.r, p.sunIlluminance * p.sunColor.g, p.sunIlluminance * p.sunColor.b);
    uniforms.uBetaR.value.set(p.rayleigh.r, p.rayleigh.g, p.rayleigh.b);
    uniforms.uHR.value = p.rayleighScaleHeight;
    uniforms.uBetaMe.value = p.mieExtinction;
    uniforms.uMieAlbedo.value = p.mieAlbedo;
    uniforms.uHM.value = p.mieScaleHeight;
    uniforms.uMieG.value = p.mieG;
    uniforms.uBetaO.value.set(p.ozone.r, p.ozone.g, p.ozone.b);
    uniforms.uOzoneC.value = p.ozoneCenter;
    uniforms.uOzoneW.value = p.ozoneWidth;
    uniforms.uMS.value = p.multiScatter;
    uniforms.uCamY.value = s.cameraY;
    uniforms.uSeaLevel.value = s.seaLevel;
    uniforms.uGround.value.set(s.groundRadiance.r, s.groundRadiance.g, s.groundRadiance.b);
    uniforms.uCirrusSun.value.set(s.cirrusSun.r, s.cirrusSun.g, s.cirrusSun.b);
    uniforms.uCirrusAmb.value.set(s.cirrusAmbient.r, s.cirrusAmbient.g, s.cirrusAmbient.b);
    uniforms.uCirrusOffset.value.set(s.cameraX, s.cameraZ, windU, windV);
  }

  return {
    mesh,
    envMesh,
    uniforms,
    setState,
    tick(dt: number) {
      // slow high-altitude drift (~25 m/s from the west)
      windU = (windU - dt * 25 * ci.scale) % 1;
      windV = (windV - dt * 6 * ci.scale) % 1;
      uniforms.uCirrusOffset.value.z = windU;
      uniforms.uCirrusOffset.value.w = windV;
    },
    dispose() {
      geo.dispose();
      view.dispose();
      env.dispose();
      cirrusTex.dispose();
    },
  };
}
