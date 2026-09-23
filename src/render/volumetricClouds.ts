/**
 * Volumetric cumulus: a raymarched cloud layer rendered at reduced
 * resolution with checkerboard (quarter-pixel) temporal updates, composited
 * against the scene depth by the output pass (post.ts). ~0.5 ms GPU on an
 * M2 Max at 1440×900 (window.__render.benchClouds(); the timer queries are
 * not per-pass accurate on ANGLE/Metal — see cloudBudget.ts).
 *
 * ─── Density ─────────────────────────────────────────────────────────────────
 * The weather map (cloudWeather.ts) gives, per world column, the cloud base
 * (flat condensation level) and the column interval [bottom, top] = the union
 * of the cloud's puff spheres: a flat base that rounds up at the rim, bulging
 * sides, domed tops. The lookup is domain-warped by the shape noise (±sideWarp
 * m) so the sides wander with height instead of rising as vertical walls.
 * Inside, the base density ramps up over BASE_SOFT m above the underside and
 * down over TOP_SOFT m below the top, and is eroded by a tileable
 * Perlin-Worley/Worley volume (64³, lobes of 150–600 m) and, near the camera
 * (distance LOD), a Worley detail volume (32³, billows of ⅛–½ detailPeriod —
 * wispy at the base, cauliflower at the top); the eroded density is
 * multiplied by edgeSharpness and saturated (crisp surfaces, softened with
 * distance to avoid sub-pixel sparkle). Everything drifts with the wind.
 *
 * ─── Lighting (per sample, energy-conserving integration, Hillaire 2016) ─────
 *   σ = density · σmax;  S = σ · (E_sun · (Σ_i aⁱ·P(μ, cⁱg)·e^{−bⁱ τ_sun} · powder + D(h)) + L_amb)
 *   L += T · S · (1 − e^{−σ dt}) / σ;   T ·= e^{−σ dt}
 * τ_sun from a 3-tap light march toward the sun (cloudMarch.ts LIGHT_TAPS),
 * dual-lobe HG phase (strong forward lobe = silver lining when backlit, weak
 * back lobe), three multiple-scattering octaves (a = b = c = ½), a "powder"
 * term that darkens thin sun-facing edges seen down-sun, D(h) = sunlight
 * diffusing down through the cloud (bright in-cloud whiteout, darker flat
 * base), and sky ambient from the sky colour at the tops to the darker
 * ground-bounce colour at the base, occluded by the column above. The result is
 * hazed with the same aerial-perspective function as every material (fog.ts)
 * at the transmittance-weighted cloud distance, so distant clouds sink into
 * the horizon haze.
 *
 * ─── Sampling (cloudMarch.ts marchRay mirrors the loop) ─────────────────────
 * Empty space is skipped with a conservative distance field of the weather
 * map (horizontal clearance / |dir.xz|); near clouds the ray takes coarse
 * steps growing with distance; a coarse step that lands inside a column backs
 * up and re-marches that stretch finely; in-cloud steps grow with distance and
 * as the transmittance falls; the march stops when opaque. The start offset is
 * a 64² blue-noise rank plus a golden-ratio per-frame offset.
 *
 * ─── Checkerboard temporal reconstruction (temporal.ts mirrors it) ───────────
 * Pass 1 marches one pixel of every 2×2 block (Bayer order) into a half-size
 * march buffer. Pass 2 (resolve) rebuilds the full buffer: each pixel
 * reprojects its cloud point into last frame's buffer (two steps: with the
 * fresh distance, then with the distance the history saw there), rejects it
 * off screen or when the occluder depth changed (disocclusion), clamps it to
 * the range of the fresh 3×3 neighbourhood (no ghosting), and blends: the
 * freshly marched pixel mixes its new sample in with temporalAlpha, the others
 * carry the clamped history (giving way to the fresh estimate when the clamp
 * had to move it far); without usable history the depth-aware upsampled fresh
 * samples are used (teleport, reset, time-of-day change, newly revealed sky).
 * The march stops at the scene depth, so terrain and the aircraft occlude
 * clouds and clouds cover what lies behind them; the output pass upsamples
 * depth-aware and treats MSAA edge pixels as half near, half far.
 *
 * ─── Outputs (MRT, RGBA16F at cloud resolution) ─────────────────────────────
 *   A: rgb = in-scattered radiance (already hazed), a = transmittance
 *   B: r = cloud distance (km), g = scene distance the ray was clipped to (km)
 *
 * The same density also feeds the cloud-shadow pass: for each texel of a
 * periodic map on the base plane, the opacity along the sun ray (shape noise
 * and warp included, detail omitted), blurred, and copied into fog.ts's shared
 * `cloudShadowTexture` that every material's fog chunk samples — the shadows
 * on the ground are cast by exactly the clouds overhead.
 */
import * as THREE from 'three';
import type { CloudField } from './cloudLayout';
import { BASE_SOFT, COV_SOFT, EDGE_SOFT, TOP_SOFT, createDistanceField, warpedClearanceMargin, createWeatherMap, distanceFieldJob, weatherRasterJob, type CloudDistanceField, type WeatherMap } from './cloudWeather';
import { DETAIL_NOISE, SHAPE_NOISE, noiseVolumeJob } from './cloudNoise';
import { blueNoiseJob } from './blueNoise';
import type { JobQueue } from './jobQueue';
import { DEFAULT_MARCH, LIGHT_TAPS, type MarchParams } from './cloudMarch';
import { ATMO_FOG_GLSL, atmoFogData, cloudShadowTexture } from './fog';
import { CLAMP_TAKEOVER, HISTORY_BOX_PAD, checkerOffset, frameJitter, marchBufferSize, type PixelOffset } from './temporal';
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
  /** Eroded density is multiplied by this and saturated (crisp surfaces). */
  edgeSharpness: number;
  /** Detail-noise period, m (rounded so the tile holds a whole number of periods). */
  detailPeriod: number;
  /** Max horizontal displacement of the weather lookup by the shape noise (m): wandering, non-vertical cloud sides. */
  sideWarp: number;
  /** Multipliers on sun and ambient light (artistic calibration of the multiple-scattering approximation). */
  sunScale: number;
  ambientScale: number;
  /** Weight of a freshly marched sample against its pixel's history (each pixel is marched every 4th frame). */
  temporalAlpha: number;
  /** Distance-field texels per tile side (empty-space skipping). */
  distanceSize: number;
  /** Detail noise fades out by this distance (m). */
  detailDistance: number;
  /** Step schedule overrides (cloudMarch.ts DEFAULT_MARCH). */
  march?: Partial<MarchParams>;
  lighting: CloudLightingParams;
  /** Shadow map texels per side (must match fog.ts cloudShadowTexture). */
  shadowSize: number;
}

/** Look of the cloud lighting (config.atmosphere.clouds.volumetric.lighting). */
export interface CloudLightingParams {
  /** Forward / backward Henyey–Greenstein asymmetry and the weight of the back lobe. */
  forwardG: number;
  backG: number;
  backWeight: number;
  /** 0..1: how much thin, sun-facing edges darken when seen down-sun ("powder"). */
  powder: number;
  /** Sky light lost deep inside / under a column (0 = none). */
  ambientOcclusion: number;
  /** Sunlight diffusing down through a cloud (× sun colour) at its top, and the fraction of it left at the flat base. */
  diffusion: number;
  diffusionBase: number;
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
  readonly distanceField: CloudDistanceField;
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
  /** Live uniforms of the march / resolve passes (profiling and look development). */
  readonly uniforms: { march: Record<string, THREE.IUniform>; resolve: Record<string, THREE.IUniform> };
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
uniform vec4 uShape;     // edge sharpness, side warp (m), light-march sharpness, sharpness LOD distance (m)
float cSat( float x ) { return clamp( x, 0.0, 1.0 ); }
float remap( float v, float lo, float hi, float nlo, float nhi ) { return nlo + ( v - lo ) * ( nhi - nlo ) / max( hi - lo, 1e-5 ); }
// Shape noise at p: erodes the base shape and domain-warps the weather lookup.
vec4 shapeAt( vec3 p ) {
	return texture( tShape, vec3( p.x - uWind.x, p.y, p.z - uWind.y ) * uWind.z );
}
// Weather column at p (cloudWeather.ts cloudColumnDensity): base density inside [bottom, top] (0 outside) and the
// relative height hf. The lookup is displaced by up to ±uShape.y m by the shape noise, so the column sides wander
// with height instead of being vertical extrusions of the weather texels.
float columnAt( vec3 p, vec4 sn, out float hf ) {
	vec2 warp = ( sn.gb - 0.5 ) * ( 2.0 * uShape.y );
	vec4 w = texture( tWeather, ( p.xz + warp - uWind.xy ) * uWeather.x + 0.5 );
	float top = w.r * uWeather.w;
	float bot = w.b * uWeather.w;
	float base = uWeather.y + w.g * uWeather.z;
	float h = p.y - base;
	hf = h / max( top, 1.0 );
	if ( top < 1.0 || h <= bot || h >= top ) return 0.0;
	return cSat( ( h - bot ) / ${BASE_SOFT.toFixed(1)} ) * cSat( ( top - h ) / ${TOP_SOFT.toFixed(1)} ) * cSat( ( top - bot ) / ${EDGE_SOFT.toFixed(1)} ) * cSat( w.a / ${COV_SOFT.toFixed(3)} );
}
// Erode a column's base density with the shape noise and (weighted by detailW, the distance LOD) the detail noise.
float erodeDensity( vec3 p, vec4 sn, float b, float hf, float detailW, float sharp ) {
	float fbm = sn.g * 0.625 + sn.b * 0.25 + sn.a * 0.125;
	float shapeN = remap( sn.r, fbm - 1.0, 1.0, 0.0, 1.0 );
	float d = remap( b, ( 1.0 - shapeN ) * uErosion.x, 1.0, 0.0, 1.0 );
	if ( d <= 0.0 ) return 0.0;
	if ( detailW > 0.01 ) {
		vec4 dn = texture( tDetail, vec3( p.x - uWind.x, p.y, p.z - uWind.y ) * uWind.w );
		// wispy (inverted billows) at the base, cauliflower billows toward the top
		float m = mix( dn.a, 1.0 - dn.a, cSat( hf * 4.0 ) );
		d = remap( d, m * uErosion.y * detailW, 1.0, 0.0, 1.0 );
	}
	return cSat( d * sharp );
}
float cloudDensity( vec3 p, float detailW, float sharp ) {
	vec4 sn = shapeAt( p );
	float hf;
	float b = columnAt( p, sn, hf );
	if ( b <= 0.0 ) return 0.0;
	return erodeDensity( p, sn, b, hf, detailW, sharp );
}
`;

/** Ray + scene clip distance of a cloud-buffer pixel (march and resolve agree exactly). */
const RAY_GLSL = /* glsl */ `
uniform sampler2D tDepth;
uniform vec4 uDepth;        // near, far, mode (0 std, 1 reversed, 2 log), log2(far + 1)
uniform vec2 uDepthSize;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform vec3 uCamPos;
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
// uv of the pixel centre in [0,1]² → world ray direction; returns the distance along it to the scene (m).
float pixelRay( vec2 uv, out vec3 rd ) {
	vec4 vp = uInvProj * vec4( uv * 2.0 - 1.0, 1.0, 1.0 );
	vec3 vdir = normalize( vp.xyz / vp.w );
	rd = normalize( ( uCamWorld * vec4( vdir, 0.0 ) ).xyz );
	ivec2 dp = ivec2( clamp( floor( uv * uDepthSize ), vec2( 0.0 ), uDepthSize - 1.0 ) );
	float viewZ = linDepth( texelFetch( tDepth, dp, 0 ).r );
	return min( viewZ / max( 1e-4, - vdir.z ), 1e6 );
}
`;

/**
 * The march: one ray per 2×2 block of the cloud buffer per frame (the pixel
 * named by uOffset, Bayer order), into the half-size march buffer. The loop is
 * cloudMarch.ts marchRay() step for step.
 */
const MARCH_FRAGMENT = /* glsl */ `
layout( location = 0 ) out highp vec4 outA;
layout( location = 1 ) out highp vec4 outB;
${ATMO_FOG_GLSL}
${DENSITY_GLSL}
${RAY_GLSL}
uniform sampler2D tBlue;
uniform sampler2D tDist;
uniform vec2 uDist;         // metres at code 1.0 (255·unit), margin (m)
uniform vec2 uFull;         // cloud buffer size (px)
uniform vec2 uOffset;       // marched pixel inside each 2×2 block this frame
uniform float uFrameJitter;
uniform vec4 uLayer;        // bottom, top, sunScale, ambientScale
uniform vec4 uMarch;        // k, kIn, dtMin, dtMax
uniform vec4 uMarch2;       // dtMaxIn, grow, tMin, detail LOD far (m)
uniform vec4 uPhase;        // forward g, back g, back weight, powder strength
uniform vec4 uLight;        // ambient occlusion by the column above, interior diffusion at the top, fraction left at the base, -
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uAmbTop;
uniform vec3 uAmbBottom;

float hg( float mu, float g ) {
	float g2 = g * g;
	return ( 1.0 - g2 ) / ( 12.5663706 * pow( max( 1e-4, 1.0 + g2 - 2.0 * g * mu ), 1.5 ) );
}
float stepOut( float t ) { return clamp( t * uMarch.x, uMarch.z, uMarch.w ); }
float stepIn( float t, float T ) { return clamp( t * uMarch.y, uMarch.z, uMarch2.x ) * ( 1.0 + uMarch2.y * ( 1.0 - T ) ); }
float detailLod( float t ) { return 1.0 - smoothstep( uMarch2.w * 0.33, uMarch2.w, t ); }

void main() {
	ivec2 px = min( ivec2( gl_FragCoord.xy ) * 2 + ivec2( uOffset ), ivec2( uFull ) - 1 );
	vec2 uv = ( vec2( px ) + 0.5 ) / uFull;
	vec3 rd;
	float clip = pixelRay( uv, rd );
	vec3 ro = uCamPos;

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
		float blue = texelFetch( tBlue, px & 63, 0 ).r;
		float jit = fract( blue + uFrameJitter );
		float hLen = max( length( rd.xz ), 1e-3 );
		// phase: strong forward lobe (silver lining) + weak back-scatter; octaves halve g
		float ph0 = mix( hg( mu, uPhase.x ), hg( mu, uPhase.y ), uPhase.z );
		float ph1 = mix( hg( mu, uPhase.x * 0.5 ), hg( mu, uPhase.y * 0.5 ), uPhase.z );
		float ph2 = mix( hg( mu, uPhase.x * 0.25 ), hg( mu, uPhase.y * 0.25 ), uPhase.z );
		// powder: thin sun-facing edges scatter little toward a viewer looking down-sun
		float powderMix = uPhase.w * cSat( 0.6 - 0.6 * mu );
		float fadeStart = uErosion.w * 0.6;
		float s = t0 + jit * stepOut( t0 );
		float sPrev = t0;
		bool wasIn = false;
		float fineUntil = -1.0;
		for ( int i = 0; i < ${MAX_STEPS}; i ++ ) {
			if ( s >= t1 ) break;
			vec3 p = ro + rd * s;
			bool fine = s < fineUntil;
			if ( !fine ) {
				// empty-space skip: horizontal clearance to the nearest column (conservative distance field)
				float free = texture( tDist, ( p.xz - uWind.xy ) * uWeather.x + 0.5 ).r * uDist.x - uDist.y;
				if ( free > 0.0 ) {
					float safe = free / hLen;
					sPrev = s + safe;
					s += max( safe, stepOut( s ) );
					wasIn = false;
					continue;
				}
			}
			vec4 sn = shapeAt( p );
			float hf;
			float b = columnAt( p, sn, hf );
			bool inCol = b > 0.0;
			if ( inCol && !wasIn && !fine && s - sPrev > uMarch.z * 2.0 ) {
				// a coarse step landed inside a column: back up and re-march that stretch finely
				fineUntil = s;
				s = sPrev + jit * stepIn( sPrev, T );
				continue;
			}
			wasIn = inCol;
			float dt = ( inCol || fine ) ? stepIn( s, T ) : stepOut( s );
			float t = s;
			sPrev = s;
			s += dt;
			dt = min( dt, t1 - t );
			if ( !inCol ) continue;
			float lod = detailLod( t );
			// far away the pixel footprint is tens of metres: softer surfaces instead of sub-pixel sparkle
			float sharp = mix( uShape.x, min( uShape.x, 2.0 ), smoothstep( uShape.w * 0.25, uShape.w, t ) );
			float dens = erodeDensity( p, sn, b, hf, lod, sharp ) * ( 1.0 - smoothstep( fadeStart, uErosion.w, t ) );
			if ( dens < 0.003 ) continue;
			float sigma = dens * uErosion.z;
			// light march toward the sun: 3 taps (cloudMarch.ts LIGHT_TAPS)
			// (softer density for the light: self-shadows between billows fade gradually)
			float tau = ( cloudDensity( p + uSunDir * ${LIGHT_TAPS[0].at.toFixed(1)}, lod, uShape.z ) * ${LIGHT_TAPS[0].len.toFixed(1)}
				+ cloudDensity( p + uSunDir * ${LIGHT_TAPS[1].at.toFixed(1)}, 0.0, uShape.z ) * ${LIGHT_TAPS[1].len.toFixed(1)}
				+ cloudDensity( p + uSunDir * ${LIGHT_TAPS[2].at.toFixed(1)}, 0.0, uShape.z ) * ${LIGHT_TAPS[2].len.toFixed(1)} ) * uErosion.z;
			// multiple-scattering octaves (energy ½, optical depth ½, anisotropy ½ each)
			float ms = ph0 * exp( - tau ) + 0.5 * ph1 * exp( - 0.5 * tau ) + 0.25 * ph2 * exp( - 0.25 * tau );
			float powder = mix( 1.0, 1.0 - exp( - 2.0 * sigma * 45.0 ), powderMix );
			// sky light: bluish from above at the tops, darker ground bounce under the flat base, dimmed deep inside
			float up = cSat( 0.1 + hf * 1.15 );
			vec3 amb = mix( uAmbBottom, uAmbTop, up ) * mix( 1.0, exp( - uLight.x * ( 1.0 - hf ) ), 0.5 );
			// sunlight diffusing down through the cloud from its sunlit top: roughly linear in height in a
			// conservative slab (bright in-cloud whiteout; the flat base keeps a fraction uLight.z of it)
			// (only where the direct light is already attenuated: no double counting on sunlit surfaces)
			float diffuse = uLight.y * cSat( uSunDir.y * 1.5 + 0.1 ) * mix( uLight.z, 1.0, cSat( hf ) ) * ( 1.0 - exp( - tau ) );
			vec3 src = uSunCol * ( ms * powder * uLayer.z + diffuse ) + amb * uLayer.w;
			float Ts = exp( - sigma * dt );
			float op = T * ( 1.0 - Ts );
			L += src * op;
			wsum += op;
			tw += op * t;
			T *= Ts;
			if ( T < uMarch2.z ) {
				// opaque: extrapolate the rest instead of letting 2 % of the background through
				L /= max( 1.0 - T, 1e-3 );
				T = 0.0;
				break;
			}
		}
	}
	float dist = wsum > 1e-5 ? tw / wsum : ( t1 > t0 ? 0.5 * ( t0 + min( t1, t0 + 8000.0 ) ) : min( clip, 20000.0 ) );
	if ( wsum > 1e-5 ) {
		vec3 Tair;
		vec3 ins = atmoFogScatter( rd * dist, uCamPos.y, Tair );
		L = L * Tair + ins * ( 1.0 - T );
	}
	outA = vec4( L, T );
	outB = vec4( dist * 0.001, clip * 0.001, 0.0, 1.0 );
}
`;

/**
 * The resolve: rebuilds the full cloud buffer from this frame's march samples
 * and the reprojected history (temporal.ts mirrors it): fresh pixels blend
 * their new sample in, the others carry history clamped to the fresh
 * neighbourhood; no usable history → depth-aware upsampled march samples.
 */
const RESOLVE_FRAGMENT = /* glsl */ `
layout( location = 0 ) out highp vec4 outA;
layout( location = 1 ) out highp vec4 outB;
${RAY_GLSL}
uniform sampler2D tMarchA;
uniform sampler2D tMarchB;
uniform sampler2D tHistA;
uniform sampler2D tHistB;
uniform vec2 uFull;
uniform vec2 uMarchSize;
uniform vec2 uOffset;
uniform mat4 uPrevViewProj;
uniform vec4 uHist;         // history valid, fresh alpha, box pad, -
float clipSim( float a, float b ) { return exp( - 25.0 * abs( a - b ) / max( 1e-4, min( a, b ) ) ); }
void main() {
	ivec2 px = ivec2( gl_FragCoord.xy );
	vec2 uv = ( vec2( px ) + 0.5 ) / uFull;
	vec3 rd;
	float clipKm = pixelRay( uv, rd ) * 0.001;
	ivec2 mmax = ivec2( uMarchSize ) - 1;
	vec2 mc = ( vec2( px ) - uOffset ) * 0.5;
	bool fresh = ( px.x & 1 ) == int( uOffset.x ) && ( px.y & 1 ) == int( uOffset.y );
	vec4 F;
	float fDist;
	if ( fresh ) {
		ivec2 m = clamp( ivec2( mc ), ivec2( 0 ), mmax );
		F = texelFetch( tMarchA, m, 0 );
		fDist = texelFetch( tMarchB, m, 0 ).r;
	} else {
		vec2 fl = floor( mc );
		vec2 f = mc - fl;
		ivec2 i0 = ivec2( fl );
		vec4 acc = vec4( 0.0 );
		float dacc = 0.0;
		float ws = 0.0;
		for ( int k = 0; k < 4; k ++ ) {
			ivec2 o = ivec2( k & 1, k >> 1 );
			ivec2 m = clamp( i0 + o, ivec2( 0 ), mmax );
			vec4 B = texelFetch( tMarchB, m, 0 );
			float w = ( o.x == 1 ? f.x : 1.0 - f.x ) * ( o.y == 1 ? f.y : 1.0 - f.y ) * clipSim( B.g, clipKm ) + 1e-6;
			acc += texelFetch( tMarchA, m, 0 ) * w;
			dacc += B.r * w;
			ws += w;
		}
		F = acc / ws;
		fDist = dacc / ws;
	}
	// neighbourhood of fresh samples (3×3 march texels)
	ivec2 c = ivec2( floor( mc + 0.5 ) );
	vec4 lo = vec4( 1e9 );
	vec4 hi = vec4( -1e9 );
	for ( int j = -1; j <= 1; j ++ ) {
		for ( int i = -1; i <= 1; i ++ ) {
			vec4 v = texelFetch( tMarchA, clamp( c + ivec2( i, j ), ivec2( 0 ), mmax ), 0 );
			lo = min( lo, v );
			hi = max( hi, v );
		}
	}
	// history at the reprojected cloud point; a second step re-projects with the distance the history
	// itself saw there (sharper cloud edges when the camera translates, e.g. orbiting the aircraft)
	bool ok = false;
	vec4 H = F;
	if ( uHist.x > 0.5 ) {
		vec4 pc = uPrevViewProj * vec4( uCamPos + rd * ( fDist * 1000.0 ), 1.0 );
		if ( pc.w > 1e-4 ) {
			vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
			float hDist = texture( tHistB, puv ).r;
			pc = uPrevViewProj * vec4( uCamPos + rd * ( hDist * 1000.0 ), 1.0 );
			if ( pc.w > 1e-4 ) puv = pc.xy / pc.w * 0.5 + 0.5;
			if ( puv.x >= 0.0 && puv.x <= 1.0 && puv.y >= 0.0 && puv.y <= 1.0 ) {
				float hClip = texture( tHistB, puv ).g;
				if ( abs( hClip - clipKm ) / max( 1e-4, min( hClip, clipKm ) ) < 0.1 ) {
					ok = true;
					H = texture( tHistA, puv );
				}
			}
		}
	}
	vec4 pad = ( hi - lo ) * uHist.z;
	vec4 Hc = clamp( H, lo - pad, hi + pad );
	// how far the clamp moved the history (transmittance, and radiance relative to the neighbourhood)
	const vec3 LUMA = vec3( 0.2126, 0.7152, 0.0722 );
	float moved = max( abs( Hc.a - H.a ), abs( dot( Hc.rgb - H.rgb, LUMA ) ) / max( dot( hi.rgb, LUMA ), 1e-3 ) );
	float w = ok ? max( fresh ? uHist.y : 0.0, clamp( moved / ${CLAMP_TAKEOVER.toFixed(3)}, 0.0, 1.0 ) ) : 1.0;
	outA = mix( Hc, F, w );
	outB = vec4( fDist, clipKm, w, 1.0 );
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
		tau += cloudDensity( p, 0.0, uShape.x ) * ds;
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
	s += ( texture2D( tSrc, vUv + 2.0 * uStep ).r + texture2D( tSrc, vUv - 2.0 * uStep ).r ) * 0.115;
	gl_FragColor = vec4( s, s, s, 1.0 );
}
`;

function makeTarget(w: number, h: number, name: string): THREE.WebGLRenderTarget {
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
  rt.textures[0].name = `${name} A`;
  rt.textures[1].name = `${name} B`;
  return rt;
}

export function createVolumetricClouds(o: VolumetricCloudsOptions): VolumetricClouds {
  const field = o.field;
  const weather = createWeatherMap(field, { size: o.weatherSize, baseMin: o.baseMin, baseRange: o.baseRange, maxThickness: o.maxThickness });
  const distField = createDistanceField(weather, o.distanceSize);
  const layerBottom = o.baseMin;
  const layerTop = o.baseMin + o.baseRange + o.maxThickness;
  const tile = weather.tile;
  const march = { ...DEFAULT_MARCH, ...o.march };

  // ── Textures (filled by time-sliced jobs) ────────────────────────────────
  const weatherTex = new THREE.DataTexture(weather.data, weather.size, weather.size, THREE.RGBAFormat);
  weatherTex.wrapS = weatherTex.wrapT = THREE.RepeatWrapping;
  weatherTex.minFilter = weatherTex.magFilter = THREE.LinearFilter;
  weatherTex.generateMipmaps = false;
  weatherTex.name = 'cloud weather';
  const distTex = new THREE.DataTexture(distField.data, distField.size, distField.size, THREE.RedFormat, THREE.UnsignedByteType);
  distTex.wrapS = distTex.wrapT = THREE.RepeatWrapping;
  distTex.minFilter = distTex.magFilter = THREE.LinearFilter;
  distTex.generateMipmaps = false;
  distTex.unpackAlignment = 1;
  distTex.name = 'cloud distance';

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

  let pendingJobs = 5;
  const jobDone = () => {
    pendingJobs--;
  };
  o.jobs.add('clouds:weather', weatherRasterJob(field, weather), () => {
    weatherTex.needsUpdate = true;
    jobDone();
  });
  // FIFO queue: runs after the weather raster it reads
  o.jobs.add('clouds:distance', distanceFieldJob(weather, distField), () => {
    distTex.needsUpdate = true;
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
  const detailScale = Math.max(1, Math.round(tile / o.detailPeriod)) / tile;

  // ── Materials ────────────────────────────────────────────────────────────
  const common = {
    tWeather: { value: weatherTex },
    tShape: { value: shapeTex },
    tDetail: { value: detailTex },
    uWeather: { value: new THREE.Vector4(1 / tile, o.baseMin, o.baseRange, o.maxThickness) },
    uWind: { value: new THREE.Vector4(0, 0, shapeScale, detailScale) },
    uErosion: { value: new THREE.Vector4(o.shapeErosion, o.detailErosion, o.sigma, o.maxDistance) },
    uShape: { value: new THREE.Vector4(o.edgeSharpness, o.sideWarp, o.edgeSharpness, 16000) },
  };
  const ray = {
    tDepth: { value: null as THREE.Texture | null },
    uDepth: { value: new THREE.Vector4(0.1, 90000, 1, 1) },
    uDepthSize: { value: new THREE.Vector2(1, 1) },
    uInvProj: { value: new THREE.Matrix4() },
    uCamWorld: { value: new THREE.Matrix4() },
    uCamPos: { value: new THREE.Vector3() },
  };
  const full = { value: new THREE.Vector2(1, 1) };
  const offset = { value: new THREE.Vector2(0, 0) };
  const lt = o.lighting;
  const marchMat = new THREE.ShaderMaterial({
    name: 'VolumetricCloudMarch',
    glslVersion: THREE.GLSL3,
    uniforms: {
      ...common,
      ...ray,
      atmoFog: { value: atmoFogData },
      tBlue: { value: blueTex },
      tDist: { value: distTex },
      uDist: { value: new THREE.Vector2(255 * distField.unit, warpedClearanceMargin(distField, o.sideWarp)) },
      uFull: full,
      uOffset: offset,
      uFrameJitter: { value: 0 },
      uLayer: { value: new THREE.Vector4(layerBottom, layerTop, o.sunScale, o.ambientScale) },
      uMarch: { value: new THREE.Vector4(march.k, march.kIn, march.dtMin, march.dtMax) },
      uMarch2: { value: new THREE.Vector4(march.dtMaxIn, march.grow, march.tMin, o.detailDistance) },
      uPhase: { value: new THREE.Vector4(lt.forwardG, lt.backG, lt.backWeight, lt.powder) },
      uLight: { value: new THREE.Vector4(lt.ambientOcclusion, lt.diffusion, lt.diffusionBase, 0) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunCol: { value: new THREE.Vector3(1, 1, 1) },
      uAmbTop: { value: new THREE.Vector3(0.3, 0.35, 0.45) },
      uAmbBottom: { value: new THREE.Vector3(0.15, 0.16, 0.18) },
    },
    vertexShader: FS_VERTEX,
    fragmentShader: MARCH_FRAGMENT,
    depthTest: false,
    depthWrite: false,
  });
  const resolveMat = new THREE.ShaderMaterial({
    name: 'VolumetricCloudResolve',
    glslVersion: THREE.GLSL3,
    uniforms: {
      ...ray,
      tMarchA: { value: null },
      tMarchB: { value: null },
      tHistA: { value: null },
      tHistB: { value: null },
      uFull: full,
      uMarchSize: { value: new THREE.Vector2(1, 1) },
      uOffset: offset,
      uPrevViewProj: { value: new THREE.Matrix4() },
      uHist: { value: new THREE.Vector4(0, o.temporalAlpha, HISTORY_BOX_PAD, 0) },
    },
    vertexShader: FS_VERTEX,
    fragmentShader: RESOLVE_FRAGMENT,
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
  const fsMesh = new THREE.Mesh(fsGeo, marchMat);
  fsMesh.frustumCulled = false;
  const fsScene = new THREE.Scene();
  fsScene.add(fsMesh);
  const fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const marchRT = makeTarget(1, 1, 'cloud march');
  const targets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] = [makeTarget(1, 1, 'clouds'), makeTarget(1, 1, 'clouds')];
  let cur = 0;
  let histValid = false;
  let frame = 0;
  const size = new THREE.Vector2(1, 1);
  const prevViewProj = new THREE.Matrix4();
  const viewProj = new THREE.Matrix4();
  const camPos = new THREE.Vector3();
  const lastCamPos = new THREE.Vector3(NaN, NaN, NaN);
  const off: PixelOffset = { x: 0, y: 0 };

  let shadowRT: THREE.WebGLRenderTarget | null = null;
  let shadowRT2: THREE.WebGLRenderTarget | null = null;

  const api: VolumetricClouds = {
    get ready() {
      return pendingJobs <= 0;
    },
    weather,
    distanceField: distField,
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
    uniforms: { march: marchMat.uniforms, resolve: resolveMat.uniforms },
    setLighting(l) {
      const u = marchMat.uniforms;
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
      const ms = marchBufferSize(w, h);
      if (w !== size.x || h !== size.y) {
        targets[0].setSize(w, h);
        targets[1].setSize(w, h);
        marchRT.setSize(ms.width, ms.height);
        size.set(w, h);
        histValid = false;
      }
      const cam = camera as THREE.PerspectiveCamera;
      camera.getWorldPosition(camPos);
      // big jumps (teleport, reset) invalidate the history
      if (!(camPos.distanceToSquared(lastCamPos) < 500 * 500)) histValid = false;
      lastCamPos.copy(camPos);
      viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

      checkerOffset(frame, off);
      offset.value.set(off.x, off.y);
      full.value.set(w, h);
      ray.tDepth.value = depth;
      ray.uDepth.value.set(cam.near ?? 0.1, cam.far ?? 90000, depthMode === 'reversed' ? 1 : depthMode === 'logarithmic' ? 2 : 0, Math.log2((cam.far ?? 90000) + 1));
      ray.uDepthSize.value.set(targetW, targetH);
      ray.uInvProj.value.copy(camera.projectionMatrixInverse);
      ray.uCamWorld.value.copy(camera.matrixWorld);
      ray.uCamPos.value.copy(camPos);
      marchMat.uniforms.uFrameJitter.value = frameJitter(frame);
      frame++;

      const prevTarget = renderer.getRenderTarget();
      // 1. march one pixel per 2×2 block
      fsMesh.material = marchMat;
      renderer.setRenderTarget(marchRT);
      renderer.render(fsScene, fsCam);
      // 2. resolve into the full buffer against last frame's
      const prev = targets[cur];
      cur ^= 1;
      const ru = resolveMat.uniforms;
      ru.tMarchA.value = marchRT.textures[0];
      ru.tMarchB.value = marchRT.textures[1];
      ru.tHistA.value = prev.textures[0];
      ru.tHistB.value = prev.textures[1];
      ru.uMarchSize.value.set(ms.width, ms.height);
      ru.uPrevViewProj.value.copy(prevViewProj);
      ru.uHist.value.x = histValid ? 1 : 0;
      fsMesh.material = resolveMat;
      renderer.setRenderTarget(targets[cur]);
      renderer.render(fsScene, fsCam);
      renderer.setRenderTarget(prevTarget);
      fsMesh.material = marchMat;
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
      const wx = common.uWind.value.x;
      const wz = common.uWind.value.y;
      common.uWind.value.x = 0;
      common.uWind.value.y = 0;
      fsMesh.material = shadowMat;
      renderer.setRenderTarget(shadowRT);
      renderer.render(fsScene, fsCam);
      common.uWind.value.x = wx;
      common.uWind.value.y = wz;
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
      fsMesh.material = marchMat;
    },
    dispose() {
      marchRT.dispose();
      targets[0].dispose();
      targets[1].dispose();
      shadowRT?.dispose();
      shadowRT2?.dispose();
      marchMat.dispose();
      resolveMat.dispose();
      shadowMat.dispose();
      blurMat.dispose();
      fsGeo.dispose();
      weatherTex.dispose();
      distTex.dispose();
      shapeTex.dispose();
      detailTex.dispose();
      blueTex.dispose();
    },
  };
  return api;
}
