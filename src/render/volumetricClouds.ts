/**
 * Volumetric cumulus: a raymarched cloud layer rendered at reduced
 * resolution, temporally accumulated, and composited against the scene depth
 * by the output pass (post.ts).
 *
 * ─── Density ─────────────────────────────────────────────────────────────────
 * The weather map (cloudWeather.ts) gives, per world column, the cloud base
 * (flat condensation level) and the column top (the upper surface of the
 * cloud's puffs). Inside a column the base density ramps up over BASE_SOFT m
 * (sharp flat bases) and down over TOP_SOFT m below the top (domed, soft
 * tops); thin columns at the rim are weaker (EDGE_SOFT). That base shape is
 * eroded by a tileable Perlin-Worley/Worley volume (64³, lobes of 150–600 m)
 * and, near the camera, by a Worley detail volume (32³, 25–200 m billows —
 * wispy at the base, cauliflower at the top). Everything drifts with the wind.
 *
 * ─── Lighting (per sample, energy-conserving integration, Hillaire 2016) ─────
 *   σ = density · σmax;  S = σ · (E_sun · Σ_i aⁱ·P(μ, cⁱg)·e^{−bⁱ τ_sun} · powder + L_amb)
 *   L += T · S · (1 − e^{−σ dt}) / σ;   T ·= e^{−σ dt}
 * τ_sun from a 5-tap light march toward the sun (25 → 400 m), dual-lobe HG
 * phase (strong forward lobe = silver lining when backlit, weak back lobe),
 * three multiple-scattering octaves (a = b = c = ½), a "powder" term that
 * darkens thin sun-facing edges, and sky ambient that fades from the sky
 * colour at the tops to the darker ground-bounce colour at the flat bases.
 * The result is hazed with the same aerial-perspective function as every
 * material (fog.ts), at the transmittance-weighted cloud distance, so distant
 * clouds sink into the horizon haze.
 *
 * ─── Sampling ────────────────────────────────────────────────────────────────
 * Steps grow with distance and are finer inside cloud columns (cloudMarch.ts
 * mirrors the schedule); the start offset is a 64² blue-noise rank plus a
 * golden-ratio per-frame offset. Each pixel reprojects its cloud distance into
 * last frame's history (temporal.ts mirrors the math) and blends 1 − alpha of
 * it unless it fell off screen or the occluder depth changed (disocclusion).
 * The march stops at the scene depth, so terrain occludes clouds and clouds
 * cover what lies behind them; the output pass upsamples depth-aware.
 *
 * ─── Outputs (MRT, RGBA16F at cloud resolution) ─────────────────────────────
 *   A: rgb = in-scattered radiance (already hazed), a = transmittance
 *   B: r = cloud distance (km), g = scene distance the ray was clipped to (km)
 *
 * The same density also feeds the cloud-shadow pass: for each texel of a
 * periodic map on the base plane, the opacity along the sun ray (shape noise
 * included, detail omitted), blurred, and copied into fog.ts's shared
 * `cloudShadowTexture` that every material's fog chunk samples.
 */
import * as THREE from 'three';
import type { CloudField } from './cloudLayout';
import { BASE_SOFT, COV_SOFT, EDGE_SOFT, TOP_SOFT, createWeatherMap, weatherRasterJob, type WeatherMap } from './cloudWeather';
import { DETAIL_NOISE, SHAPE_NOISE, noiseVolumeJob } from './cloudNoise';
import { blueNoiseJob } from './blueNoise';
import type { JobQueue } from './jobQueue';
import { DEFAULT_MARCH } from './cloudMarch';
import { ATMO_FOG_GLSL, atmoFogData, cloudShadowTexture } from './fog';
import { frameJitter } from './temporal';
import type { DepthMode } from './renderer';
import type { RGB } from './atmosphereModel';
import type { Vec3 } from '../types';

export interface VolumetricCloudsOptions {
  field: CloudField;
  seed: number;
  jobs: JobQueue;
  /** Weather-map texels per side. */
  weatherSize: number;
  baseMin: number;
  baseRange: number;
  maxThickness: number;
  /** Cloud buffer size per axis, relative to the CSS resolution. */
  resolution: number;
  /** Extinction at density 1 (1/m). */
  sigma: number;
  /** Max march distance (m). */
  maxDistance: number;
  /** Erosion strength of the shape / detail noise (0..1). */
  shapeErosion: number;
  detailErosion: number;
  /** Multipliers on sun and ambient light (artistic calibration of the multiple-scattering approximation). */
  sunScale: number;
  ambientScale: number;
  /** New-sample weight of the temporal accumulation. */
  temporalAlpha: number;
  /** Shadow map texels per side (must match fog.ts cloudShadowTexture). */
  shadowSize: number;
}

export interface CloudPassLighting {
  sunDir: Vec3;
  sun: RGB;
  ambientTop: RGB;
  ambientBottom: RGB;
}

export interface VolumetricClouds {
  /** Noise volumes, weather map and blue noise generated and uploaded. */
  readonly ready: boolean;
  readonly weather: WeatherMap;
  /** Global layer bounds used by the march and the composite. */
  readonly layerBottom: number;
  readonly layerTop: number;
  /** Texture pair of the latest cloud frame (A: radiance/T, B: distances). */
  readonly outputA: THREE.Texture;
  readonly outputB: THREE.Texture;
  readonly size: THREE.Vector2;
  /** Resolution scale per axis (the budget controller lowers it). */
  resolution: number;
  setLighting(l: CloudPassLighting): void;
  /** Wind offset of the whole cloud field (m, wrapped to the tile). */
  setWind(x: number, z: number): void;
  /** Force the next frame to ignore history (teleport, cut, mode switch). */
  resetHistory(): void;
  /** March into the cloud buffer. `targetW/H` = HDR target size in px; `pixelRatio` of that target. */
  render(renderer: THREE.WebGLRenderer, depth: THREE.Texture, camera: THREE.Camera, targetW: number, targetH: number, pixelRatio: number, depthMode: DepthMode): void;
  /** Recompute the cloud-shadow map for a sun direction (GPU, ~0.3 ms) into fog.ts's shared texture. */
  renderShadowMap(renderer: THREE.WebGLRenderer, sunDir: Vec3): void;
  dispose(): void;
}

const MAX_STEPS = DEFAULT_MARCH.maxSteps;

const FS_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
	vUv = position.xy * 0.5 + 0.5;
	gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

/** Shared density GLSL (march + shadow pass). */
const DENSITY_GLSL = /* glsl */ `
precision highp sampler3D;
uniform sampler2D tWeather;
uniform sampler3D tShape;
uniform sampler3D tDetail;
uniform vec4 uWeather;   // 1/tile, baseMin, baseRange, maxThickness
uniform vec4 uWind;      // offset x, offset z, 1/shapeTile, 1/detailTile
uniform vec4 uErosion;   // shape, detail, sigma, max distance
float cSat( float x ) { return clamp( x, 0.0, 1.0 ); }
float remap( float v, float lo, float hi, float nlo, float nhi ) { return nlo + ( v - lo ) * ( nhi - nlo ) / max( hi - lo, 1e-5 ); }
// Base density + relative height in the column; returns 0 outside the column.
float cloudBase( vec3 p, out float hf, out float colDens ) {
	vec4 w = texture( tWeather, ( p.xz - uWind.xy ) * uWeather.x + 0.5 );
	float top = w.r * uWeather.w;
	float base = uWeather.y + w.g * uWeather.z;
	float h = p.y - base;
	hf = h / max( top, 1.0 );
	colDens = w.b;
	if ( top < 1.0 || h <= 0.0 || h >= top ) return 0.0;
	return cSat( h / ${BASE_SOFT.toFixed(1)} ) * cSat( ( top - h ) / ${TOP_SOFT.toFixed(1)} ) * cSat( top / ${EDGE_SOFT.toFixed(1)} ) * cSat( w.a / ${COV_SOFT.toFixed(3)} );
}
float cloudDensity( vec3 p, bool detail ) {
	float hf, cd;
	float b = cloudBase( p, hf, cd );
	if ( b <= 0.0 ) return 0.0;
	vec3 q = vec3( p.x - uWind.x, p.y, p.z - uWind.y );
	vec4 sn = texture( tShape, q * uWind.z );
	float fbm = sn.g * 0.625 + sn.b * 0.25 + sn.a * 0.125;
	float shapeN = remap( sn.r, fbm - 1.0, 1.0, 0.0, 1.0 );
	float d = remap( b, ( 1.0 - shapeN ) * uErosion.x, 1.0, 0.0, 1.0 );
	if ( d <= 0.0 ) return 0.0;
	if ( detail ) {
		vec4 dn = texture( tDetail, q * uWind.w );
		float m = mix( dn.a, 1.0 - dn.a, cSat( hf * 5.0 ) );
		d = remap( d, m * uErosion.y, 1.0, 0.0, 1.0 );
	}
	return cSat( d ) * cd;
}
`;

const MARCH_FRAGMENT = /* glsl */ `
layout( location = 0 ) out highp vec4 outA;
layout( location = 1 ) out highp vec4 outB;
${ATMO_FOG_GLSL}
${DENSITY_GLSL}
uniform sampler2D tDepth;
uniform vec4 uDepth;        // near, far, mode (0 std, 1 reversed, 2 log), log2(far + 1)
uniform vec2 uDepthSize;
uniform vec2 uSize;         // cloud buffer size
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform mat4 uPrevViewProj;
uniform vec3 uCamPos;
uniform vec3 uCamFwd;
uniform sampler2D tHistA;
uniform sampler2D tHistB;
uniform vec2 uHist;         // history valid (0/1), alpha
uniform sampler2D tBlue;
uniform float uFrameJitter;
uniform vec4 uLayer;        // bottom, top, sunScale, ambientScale
uniform vec4 uMarch;        // k, kIn, dtMin, dtMax
uniform float uDtMaxIn;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uAmbTop;
uniform vec3 uAmbBottom;
uniform float uDebug;
varying vec2 vUv;

float linDepth( float d ) {
	if ( uDepth.z > 0.5 && uDepth.z < 1.5 ) {
		if ( d <= 0.0 ) return 1e9;
		return uDepth.x * uDepth.y / ( d * ( uDepth.y - uDepth.x ) + uDepth.x );
	}
	if ( d >= 1.0 ) return 1e9;
	if ( uDepth.z > 1.5 ) return exp2( d * uDepth.w ) - 1.0;
	float ndc = d * 2.0 - 1.0;
	return 2.0 * uDepth.x * uDepth.y / ( uDepth.y + uDepth.x - ndc * ( uDepth.y - uDepth.x ) );
}
float hg( float mu, float g ) {
	float g2 = g * g;
	return ( 1.0 - g2 ) / ( 12.5663706 * pow( max( 1e-4, 1.0 + g2 - 2.0 * g * mu ), 1.5 ) );
}
float phase2( float mu, float g1, float g2, float w ) { return mix( hg( mu, g1 ), hg( mu, g2 ), w ); }

void main() {
	// ray through the centre of this cloud pixel
	vec2 ndc = vUv * 2.0 - 1.0;
	vec4 vp = uInvProj * vec4( ndc, 1.0, 1.0 );
	vec3 vdir = normalize( vp.xyz / vp.w );
	vec3 rd = normalize( ( uCamWorld * vec4( vdir, 0.0 ) ).xyz );
	vec3 ro = uCamPos;
	// scene depth under this pixel → distance along the ray
	ivec2 dp = ivec2( clamp( floor( vUv * uDepthSize ), vec2( 0.0 ), uDepthSize - 1.0 ) );
	float viewZ = linDepth( texelFetch( tDepth, dp, 0 ).r );
	float clip = viewZ / max( 1e-4, -vdir.z );
	clip = min( clip, 1e6 );

	// layer segment
	float t0 = 0.0, t1 = -1.0;
	if ( abs( rd.y ) < 1e-6 ) {
		if ( ro.y >= uLayer.x && ro.y <= uLayer.y ) t1 = 1e9;
	} else {
		float ta = ( uLayer.x - ro.y ) / rd.y;
		float tb = ( uLayer.y - ro.y ) / rd.y;
		t0 = max( min( ta, tb ), 0.0 );
		t1 = max( ta, tb );
	}
	t1 = min( t1, min( clip, uErosion.w ) );

	vec3 L = vec3( 0.0 );
	float T = 1.0;
	float wsum = 0.0;
	float tw = 0.0;
	if ( t1 > t0 ) {
		float mu = dot( rd, uSunDir );
		float blue = texelFetch( tBlue, ivec2( mod( gl_FragCoord.xy, 64.0 ) ), 0 ).r;
		float jit = fract( blue + uFrameJitter );
		// the whole sample sequence is offset by the per-pixel jitter (not just the samples within
		// fixed segments), so cloud boundaries are hit at different depths per pixel → noise, not bands
		float s = t0 + jit * clamp( t0 * uMarch.x, uMarch.z, uMarch.w );
		float sPrev = t0;
		bool wasIn = false;
		float fadeStart = uErosion.w * 0.6;
		for ( int i = 0; i < ${MAX_STEPS}; i ++ ) {
			if ( s >= t1 ) break;
			vec3 p = ro + rd * s;
			float hf, cd;
			bool inCol = cloudBase( p, hf, cd ) > 0.0;
			if ( inCol && !wasIn && s - sPrev > uMarch.z * 2.0 ) {
				// entered a cloud column on a coarse step: re-march that stretch finely
				s = sPrev + jit * clamp( sPrev * uMarch.y, uMarch.z, uDtMaxIn );
				wasIn = true;
				continue;
			}
			wasIn = inCol;
			float dt = inCol ? clamp( s * uMarch.y, uMarch.z, uDtMaxIn ) : clamp( s * uMarch.x, uMarch.z, uMarch.w );
			float t = s;
			sPrev = s;
			s += dt;
			dt = min( dt, t1 - t );
			if ( !inCol ) continue;
			float dens = cloudDensity( p, t < 9000.0 );
			dens *= 1.0 - smoothstep( fadeStart, uErosion.w, t );
			if ( dens < 0.003 ) continue;
			float sigma = dens * uErosion.z;
			// light march toward the sun
			float tau = 0.0;
			float ls = 25.0;
			vec3 lp = p;
			for ( int j = 0; j < 5; j ++ ) {
				lp += uSunDir * ls;
				tau += cloudDensity( lp, j < 1 && t < 4000.0 ) * ls;
				ls *= 2.0;
			}
			tau *= uErosion.z;
			float ms = 0.0;
			float a = 1.0, b = 1.0, c = 1.0;
			for ( int k = 0; k < 3; k ++ ) {
				ms += a * phase2( mu, 0.8 * c, -0.3 * c, 0.3 ) * exp( - tau * b );
				a *= 0.5; b *= 0.5; c *= 0.5;
			}
			float powder = 1.0 - exp( - 2.0 * sigma * 40.0 );
			powder = mix( 1.0, powder, 0.6 * cSat( 0.5 - 0.5 * mu ) );
			float cloudBaseHf;
			cloudBase( p, cloudBaseHf, cd );
			vec3 amb = mix( uAmbBottom, uAmbTop, cSat( 0.15 + cloudBaseHf * 1.1 ) );
			vec3 src = uSunCol * ( ms * powder * uLayer.z ) + amb * uLayer.w;
			float Ts = exp( - sigma * dt );
			float op = T * ( 1.0 - Ts );
			L += src * op;
			wsum += op;
			tw += op * t;
			T *= Ts;
			if ( T < 0.015 ) break;
		}
	}
	float dist = wsum > 1e-5 ? tw / wsum : ( t1 > t0 ? 0.5 * ( t0 + min( t1, t0 + 8000.0 ) ) : min( clip, 20000.0 ) );
	if ( wsum > 1e-5 ) {
		vec3 Tair;
		vec3 ins = atmoFogScatter( rd * dist, uCamPos.y, Tair );
		L = L * Tair + ins * ( 1.0 - T );
	}
	vec4 cur = vec4( L, T );
	if ( uDebug > 0.5 ) {
		float blue = texelFetch( tBlue, ivec2( mod( gl_FragCoord.xy, 64.0 ) ), 0 ).r;
		if ( uDebug < 1.5 ) { outA = vec4( vec3( blue * 1000.0 ), 0.0 ); outB = vec4( 0.0, 1000.0, 0.0, 1.0 ); return; }
		if ( uDebug < 2.5 ) { outA = cur; outB = vec4( dist * 0.001, clip * 0.001, 0.0, 1.0 ); return; }
	}
	float clipKm = clip * 0.001;
	// temporal reprojection
	vec3 wp = ro + rd * dist;
	vec4 pc = uPrevViewProj * vec4( wp, 1.0 );
	float wH = 0.0;
	vec4 hA = cur;
	if ( uHist.x > 0.5 && pc.w > 1e-4 ) {
		vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
		if ( puv.x >= 0.0 && puv.x <= 1.0 && puv.y >= 0.0 && puv.y <= 1.0 ) {
			vec4 hB = texture( tHistB, puv );
			float rel = abs( hB.g - clipKm ) / max( 1e-4, min( hB.g, clipKm ) );
			if ( rel < 0.1 ) {
				wH = 1.0 - uHist.y;
				hA = texture( tHistA, puv );
			}
		}
	}
	outA = mix( cur, hA, wH );
	outB = vec4( dist * 0.001, clipKm, wH, 1.0 );
}
`;

const SHADOW_FRAGMENT = /* glsl */ `
${DENSITY_GLSL}
uniform vec3 uSunDir;
uniform vec2 uLayerY; // bottom, top
varying vec2 vUv;
void main() {
	// texel → point on the base plane (tile frame, no wind)
	vec2 q = ( vUv - 0.5 ) / uWeather.x;
	float sy = max( uSunDir.y, 0.05 );
	const int N = 64;
	float dy = ( uLayerY.y - uLayerY.x ) / float( N );
	float ds = dy / sy;
	float tau = 0.0;
	for ( int k = 0; k < N; k ++ ) {
		float y = uLayerY.x + ( float( k ) + 0.5 ) * dy;
		float t = ( y - uLayerY.x ) / sy;
		vec3 p = vec3( q.x + uSunDir.x * t, y, q.y + uSunDir.z * t );
		tau += cloudDensity( p, false ) * ds;
	}
	float op = 1.0 - exp( - tau * uErosion.z );
	gl_FragColor = vec4( op, op, op, 1.0 );
}
`;

const BLUR_FRAGMENT = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uStep;
varying vec2 vUv;
void main() {
	float s = texture2D( tSrc, vUv ).r * 0.3;
	s += ( texture2D( tSrc, vUv + uStep ).r + texture2D( tSrc, vUv - uStep ).r ) * 0.235;
	s += ( texture2D( tSrc, vUv + 2.2 * uStep ).r + texture2D( tSrc, vUv - 2.2 * uStep ).r ) * 0.115;
	gl_FragColor = vec4( s, s, s, 1.0 );
}
`;

function makeTarget(w: number, h: number): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(w, h, {
    count: 2,
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
  });
  rt.textures[0].name = 'clouds A';
  rt.textures[1].name = 'clouds B';
  return rt;
}

export function createVolumetricClouds(o: VolumetricCloudsOptions): VolumetricClouds {
  const field = o.field;
  const weather = createWeatherMap(field, { size: o.weatherSize, baseMin: o.baseMin, baseRange: o.baseRange, maxThickness: o.maxThickness });
  const layerBottom = o.baseMin;
  const layerTop = o.baseMin + o.baseRange + o.maxThickness;
  const tile = weather.tile;

  // ── Textures (filled by time-sliced jobs) ────────────────────────────────
  const weatherTex = new THREE.DataTexture(weather.data, weather.size, weather.size, THREE.RGBAFormat);
  weatherTex.wrapS = weatherTex.wrapT = THREE.RepeatWrapping;
  weatherTex.minFilter = weatherTex.magFilter = THREE.LinearFilter;
  weatherTex.generateMipmaps = false;
  weatherTex.name = 'cloud weather';

  const shapeData = new Uint8Array(SHAPE_NOISE.size ** 3 * 4);
  const shapeTex = new THREE.Data3DTexture(shapeData, SHAPE_NOISE.size, SHAPE_NOISE.size, SHAPE_NOISE.size);
  const detailData = new Uint8Array(DETAIL_NOISE.size ** 3 * 4);
  const detailTex = new THREE.Data3DTexture(detailData, DETAIL_NOISE.size, DETAIL_NOISE.size, DETAIL_NOISE.size);
  for (const t of [shapeTex, detailTex]) {
    t.format = THREE.RGBAFormat;
    t.type = THREE.UnsignedByteType;
    t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
    t.minFilter = t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    t.unpackAlignment = 1;
  }
  const blueData = new Float32Array(64 * 64);
  const blueTex = new THREE.DataTexture(blueData, 64, 64, THREE.RedFormat, THREE.FloatType);
  blueTex.minFilter = blueTex.magFilter = THREE.NearestFilter;
  blueTex.wrapS = blueTex.wrapT = THREE.RepeatWrapping;
  blueTex.generateMipmaps = false;

  let pendingJobs = 4;
  const jobDone = () => {
    pendingJobs--;
  };
  o.jobs.add('clouds:weather', weatherRasterJob(field, weather), () => {
    weatherTex.needsUpdate = true;
    jobDone();
  });
  o.jobs.add('clouds:blue-noise', blueNoiseJob(64, o.seed + 1), (ranks) => {
    for (let i = 0; i < ranks.length; i++) blueData[i] = (ranks[i] + 0.5) / ranks.length;
    blueTex.needsUpdate = true;
    jobDone();
  });
  o.jobs.add('clouds:detail-noise', noiseVolumeJob(DETAIL_NOISE, o.seed + 2, detailData), () => {
    detailTex.needsUpdate = true;
    jobDone();
  });
  o.jobs.add('clouds:shape-noise', noiseVolumeJob(SHAPE_NOISE, o.seed + 3, shapeData), () => {
    shapeTex.needsUpdate = true;
    jobDone();
  });

  const shapeScale = 32 / tile; // 1 / shape tile (the tile is a whole number of noise periods → seamless shadow map)
  const detailScale = 190 / tile;

  // ── March material ───────────────────────────────────────────────────────
  const common = {
    tWeather: { value: weatherTex },
    tShape: { value: shapeTex },
    tDetail: { value: detailTex },
    uWeather: { value: new THREE.Vector4(1 / tile, o.baseMin, o.baseRange, o.maxThickness) },
    uWind: { value: new THREE.Vector4(0, 0, shapeScale, detailScale) },
    uErosion: { value: new THREE.Vector4(o.shapeErosion, o.detailErosion, o.sigma, o.maxDistance) },
  };
  const march = new THREE.ShaderMaterial({
    name: 'VolumetricCloudMarch',
    glslVersion: THREE.GLSL3,
    uniforms: {
      ...common,
      atmoFog: { value: atmoFogData },
      tDepth: { value: null },
      uDepth: { value: new THREE.Vector4(0.1, 90000, 1, 1) },
      uDepthSize: { value: new THREE.Vector2(1, 1) },
      uSize: { value: new THREE.Vector2(1, 1) },
      uInvProj: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() },
      uPrevViewProj: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() },
      uCamFwd: { value: new THREE.Vector3() },
      tHistA: { value: null },
      tHistB: { value: null },
      uHist: { value: new THREE.Vector2(0, o.temporalAlpha) },
      tBlue: { value: blueTex },
      uFrameJitter: { value: 0 },
      uLayer: { value: new THREE.Vector4(layerBottom, layerTop, o.sunScale, o.ambientScale) },
      uMarch: { value: new THREE.Vector4(DEFAULT_MARCH.k, DEFAULT_MARCH.kIn, DEFAULT_MARCH.dtMin, DEFAULT_MARCH.dtMax) },
      uDtMaxIn: { value: DEFAULT_MARCH.dtMaxIn },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunCol: { value: new THREE.Vector3(1, 1, 1) },
      uAmbTop: { value: new THREE.Vector3(0.3, 0.35, 0.45) },
      uAmbBottom: { value: new THREE.Vector3(0.15, 0.16, 0.18) },
      uDebug: { value: typeof location !== 'undefined' ? Number(new URLSearchParams(location.search).get('clouddebug')) || 0 : 0 },
    },
    vertexShader: FS_VERTEX,
    fragmentShader: MARCH_FRAGMENT,
    depthTest: false,
    depthWrite: false,
  });
  const shadowMat = new THREE.ShaderMaterial({
    name: 'CloudShadowMap',
    uniforms: {
      ...common,
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uLayerY: { value: new THREE.Vector2(layerBottom, layerTop) },
    },
    vertexShader: FS_VERTEX,
    fragmentShader: SHADOW_FRAGMENT,
    depthTest: false,
    depthWrite: false,
  });
  const blurMat = new THREE.ShaderMaterial({
    name: 'CloudShadowBlur',
    uniforms: { tSrc: { value: null }, uStep: { value: new THREE.Vector2() } },
    vertexShader: FS_VERTEX,
    fragmentShader: BLUR_FRAGMENT,
    depthTest: false,
    depthWrite: false,
  });

  const fsGeo = new THREE.BufferGeometry();
  fsGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const fsMesh = new THREE.Mesh(fsGeo, march);
  fsMesh.frustumCulled = false;
  const fsScene = new THREE.Scene();
  fsScene.add(fsMesh);
  const fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  let targets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] = [makeTarget(1, 1), makeTarget(1, 1)];
  let cur = 0;
  let histValid = false;
  let frame = 0;
  const size = new THREE.Vector2(1, 1);
  const prevViewProj = new THREE.Matrix4();
  const viewProj = new THREE.Matrix4();
  const camPos = new THREE.Vector3();
  const camFwd = new THREE.Vector3();
  let lastCamPos = new THREE.Vector3(NaN, NaN, NaN);

  let shadowRT: THREE.WebGLRenderTarget | null = null;
  let shadowRT2: THREE.WebGLRenderTarget | null = null;

  const api: VolumetricClouds = {
    get ready() {
      return pendingJobs <= 0;
    },
    weather,
    layerBottom,
    layerTop,
    get outputA() {
      return targets[cur].textures[0];
    },
    get outputB() {
      return targets[cur].textures[1];
    },
    size,
    resolution: o.resolution,
    setLighting(l) {
      const u = march.uniforms;
      u.uSunDir.value.set(l.sunDir.x, l.sunDir.y, l.sunDir.z);
      u.uSunCol.value.set(l.sun.r, l.sun.g, l.sun.b);
      u.uAmbTop.value.set(l.ambientTop.r, l.ambientTop.g, l.ambientTop.b);
      u.uAmbBottom.value.set(l.ambientBottom.r, l.ambientBottom.g, l.ambientBottom.b);
    },
    setWind(x, z) {
      const w = common.uWind.value;
      w.x = x - Math.floor(x / tile) * tile;
      w.y = z - Math.floor(z / tile) * tile;
    },
    resetHistory() {
      histValid = false;
    },
    render(renderer, depth, camera, targetW, targetH, pixelRatio, depthMode) {
      const cssW = targetW / Math.max(pixelRatio, 1e-3);
      const cssH = targetH / Math.max(pixelRatio, 1e-3);
      const w = Math.max(16, Math.round(cssW * api.resolution));
      const h = Math.max(16, Math.round(cssH * api.resolution));
      if (w !== size.x || h !== size.y) {
        targets[0].setSize(w, h);
        targets[1].setSize(w, h);
        size.set(w, h);
        histValid = false;
      }
      const cam = camera as THREE.PerspectiveCamera;
      camera.getWorldPosition(camPos);
      camera.getWorldDirection(camFwd);
      // big jumps (teleport, camera cut) invalidate the history
      if (!(camPos.distanceToSquared(lastCamPos) < 500 * 500)) histValid = false;
      lastCamPos.copy(camPos);
      viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

      const prev = targets[cur];
      cur ^= 1;
      const u = march.uniforms;
      u.tDepth.value = depth;
      u.uDepth.value.set(cam.near ?? 0.1, cam.far ?? 90000, depthMode === 'reversed' ? 1 : depthMode === 'logarithmic' ? 2 : 0, Math.log2((cam.far ?? 90000) + 1));
      u.uDepthSize.value.set(targetW, targetH);
      u.uSize.value.set(w, h);
      u.uInvProj.value.copy(camera.projectionMatrixInverse);
      u.uCamWorld.value.copy(camera.matrixWorld);
      u.uPrevViewProj.value.copy(prevViewProj);
      u.uCamPos.value.copy(camPos);
      u.uCamFwd.value.copy(camFwd);
      u.tHistA.value = prev.textures[0];
      u.tHistB.value = prev.textures[1];
      u.uHist.value.set(histValid ? 1 : 0, o.temporalAlpha);
      u.uFrameJitter.value = frameJitter(frame++);
      fsMesh.material = march;
      const prevTarget = renderer.getRenderTarget();
      renderer.setRenderTarget(targets[cur]);
      renderer.render(fsScene, fsCam);
      renderer.setRenderTarget(prevTarget);
      prevViewProj.copy(viewProj);
      histValid = true;
    },
    renderShadowMap(renderer, sunDir) {
      if (!api.ready) return;
      const n = o.shadowSize;
      if (!shadowRT) {
        const opts = { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping } as const;
        shadowRT = new THREE.WebGLRenderTarget(n, n, opts);
        shadowRT2 = new THREE.WebGLRenderTarget(n, n, opts);
      }
      const prevTarget = renderer.getRenderTarget();
      shadowMat.uniforms.uSunDir.value.set(sunDir.x, sunDir.y, sunDir.z);
      // the shadow map lives in the tile frame: no wind (the fog chunk applies it)
      const saved = common.uWind.value.clone();
      common.uWind.value.x = 0;
      common.uWind.value.y = 0;
      fsMesh.material = shadowMat;
      renderer.setRenderTarget(shadowRT);
      renderer.render(fsScene, fsCam);
      common.uWind.value.copy(saved);
      fsMesh.material = blurMat;
      blurMat.uniforms.tSrc.value = shadowRT.texture;
      blurMat.uniforms.uStep.value.set(1 / n, 0);
      renderer.setRenderTarget(shadowRT2!);
      renderer.render(fsScene, fsCam);
      blurMat.uniforms.tSrc.value = shadowRT2!.texture;
      blurMat.uniforms.uStep.value.set(0, 1 / n);
      renderer.setRenderTarget(shadowRT);
      renderer.render(fsScene, fsCam);
      renderer.setRenderTarget(prevTarget);
      renderer.copyTextureToTexture(shadowRT.texture, cloudShadowTexture);
      fsMesh.material = march;
    },
    dispose() {
      targets[0].dispose();
      targets[1].dispose();
      shadowRT?.dispose();
      shadowRT2?.dispose();
      march.dispose();
      shadowMat.dispose();
      blurMat.dispose();
      fsGeo.dispose();
      weatherTex.dispose();
      shapeTex.dispose();
      detailTex.dispose();
      blueTex.dispose();
    },
  };
  return api;
}
