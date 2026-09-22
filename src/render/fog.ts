/**
 * Aerial perspective for EVERY material: a global override of three.js' fog
 * shader chunks with height-based, sun-aware atmospheric haze.
 *
 * ─── The model ───────────────────────────────────────────────────────────────
 * The haze is the same atmosphere as the sky (atmosphereModel.ts): Rayleigh
 * (blue, scale height 8 km) + aerosol/Mie (grey, density `fogDensity` at sea
 * level, falling off with `fogHeightFalloff`). For a segment camera → surface
 * the optical depth of each species has a closed form for an exponential
 * height profile, so per fragment:
 *
 *     τ = β_R·L_R + β_M·L_M,   L_k = d·e^{-k·y_cam}·(1 − e^{-k·Δy})/(k·Δy)
 *     T = e^{-τ}                          (per channel: blue fades first)
 *     S = [E_sun·(β_R L_R·P_R(μ) + α_M β_M L_M·P_M(μ)) + A·(β_R L_R + α_M β_M L_M)] / τ
 *     colour' = colour·T + S·(1 − T)
 *
 * μ = cos(view, sun) gives the warm Mie glow toward the sun and the bluish
 * Rayleigh grey away from it. `A` is an ambient (sky/multiple-scattering)
 * term calibrated each time against the physical sky at the horizon, so a
 * far-away mountain fades to exactly the sky colour behind it. T is forced to
 * 0 at `visibility` (the terrain draw distance) so the terrain edge vanishes;
 * the sky shader draws the same `hazeColor` below/at the horizon.
 *
 * ─── How the uniforms reach every material ───────────────────────────────────
 * All parameters live in ONE shared Float32Array (`atmoFogData`, 6 × vec4),
 * exposed as the uniform `atmoFog`. `installAtmosphericFog()` (run when this
 * module is imported, idempotent):
 *   1. replaces THREE.ShaderChunk.fog_pars_vertex / fog_vertex /
 *      fog_pars_fragment / fog_fragment (resolved at program compile time, so
 *      every material compiled afterwards uses them — built-ins, InstancedMesh,
 *      onBeforeCompile-extended materials and ShaderMaterials that #include the
 *      fog chunks);
 *   2. adds `atmoFog: { value: atmoFogData }` to THREE.UniformsLib.fog and to
 *      every THREE.ShaderLib entry that has fog uniforms. three's
 *      UniformsUtils.clone/merge copy typed arrays BY REFERENCE (only Color/
 *      Vector/Matrix/Texture values and plain Arrays are cloned), so every
 *      material's uniform points at the same array;
 *   3. writing new values into `atmoFogData` (packFogUniforms, every frame
 *      and on time-of-day change) therefore updates every material with no
 *      recompiles: three re-uploads a material's uniforms whenever it switches
 *      material, i.e. at least once per frame per material.
 * A ShaderMaterial whose uniforms were NOT built from UniformsLib.fog lacks the
 * uniform; GL then reads zeros → mode 0 → the chunk falls back to classic
 * FogExp2 with scene.fog (still sensible). `ensureSceneFogUniforms(scene)`
 * (called by the atmosphere on the first frames and periodically) patches
 * such materials and disposes them so they re-link with the uniform.
 * Materials need nothing else: `fog: true` (the default for built-ins) and
 * scene.fog set to a FogExp2 (createAtmosphere does that) is all it takes.
 */
import * as THREE from 'three';
import type { Vec3 } from '../types';
import type { AtmosphereParams, RGB } from './atmosphereModel';
import { phaseMie, phaseRayleigh, skyRadiance, sunIlluminanceAt } from './atmosphereModel';
import { CONFIG } from '../config';

export const ATMO_FOG_VEC4S = 6;
/** The one shared uniform array every fog-enabled material reads (see header). */
export const atmoFogData = new Float32Array(ATMO_FOG_VEC4S * 4);

export interface FogState {
  /** 1 = aerial perspective, 0 = classic FogExp2 fallback, -1 = fog off. */
  mode: 1 | 0 | -1;
  sunDir: Vec3;
  /** Rayleigh extinction at the reference height, 1/m. */
  rayleigh: RGB;
  rayleighFalloff: number;
  /** Aerosol extinction at the reference height, 1/m. */
  mieExtinction: number;
  mieFalloff: number;
  mieAlbedo: number;
  mieG: number;
  /** Beyond this distance everything is fully hazed (m). */
  visibility: number;
  /** Sun illuminance lighting the haze (scene units). */
  sunRadiance: RGB;
  /** Isotropic ambient source (sky light + multiple scattering), scene units. */
  ambient: RGB;
  /** World y of the density reference (sea level). */
  referenceHeight: number;
}

// ─── GLSL (shared by the fog chunks and the sky shader) ───────────────────────

export const ATMO_FOG_GLSL = /* glsl */ `
uniform vec4 atmoFog[ ${ATMO_FOG_VEC4S} ];
// [0] sunDir.xyz, mode   [1] betaR.rgb, kR   [2] betaM, kM, mieG, visibility
// [3] sunRadiance.rgb, mieAlbedo   [4] ambient.rgb, referenceHeight
float atmoOD( float k, float yc, float dy ) {
	float kd = k * dy;
	float f = abs( kd ) > 1e-4 ? ( 1.0 - exp( - kd ) ) / kd : 1.0 - 0.5 * kd;
	return exp( - k * yc ) * f;
}
float atmoPhaseR( float mu ) { return 0.0596831 * ( 1.0 + mu * mu ); }
float atmoPhaseM( float mu, float g ) {
	float g2 = g * g;
	return 0.1193662 * ( ( 1.0 - g2 ) * ( 1.0 + mu * mu ) ) / ( ( 2.0 + g2 ) * pow( max( 1e-6, 1.0 + g2 - 2.0 * g * mu ), 1.5 ) );
}
// In-scattered light along camera→point (rel = point - camera), transmittance in T.
vec3 atmoFogScatter( vec3 rel, float camY, out vec3 T ) {
	float d = length( rel );
	vec3 v = rel / max( d, 1e-3 );
	float yc = camY - atmoFog[ 4 ].w;
	float fR = atmoOD( atmoFog[ 1 ].w, yc, rel.y ) * d;
	float fM = atmoOD( atmoFog[ 2 ].y, yc, rel.y ) * d;
	vec3 tR = atmoFog[ 1 ].rgb * fR;
	float tMe = atmoFog[ 2 ].x * fM;
	float tMs = tMe * atmoFog[ 3 ].w;
	vec3 tau = tR + tMe;
	T = exp( - tau ) * ( 1.0 - smoothstep( 0.8 * atmoFog[ 2 ].w, atmoFog[ 2 ].w, d ) );
	float mu = dot( v, atmoFog[ 0 ].xyz );
	vec3 src = atmoFog[ 3 ].rgb * ( tR * atmoPhaseR( mu ) + tMs * atmoPhaseM( mu, atmoFog[ 2 ].z ) ) + atmoFog[ 4 ].rgb * ( tR + tMs );
	return src / max( tau, vec3( 1e-9 ) ) * ( 1.0 - T );
}
vec3 atmoFogApply( vec3 color, vec3 rel, float camY ) {
	vec3 T;
	vec3 ins = atmoFogScatter( rel, camY, T );
	return color * T + ins;
}
`;

const FOG_PARS_VERTEX = /* glsl */ `
#ifdef USE_FOG
	varying float vFogDepth;
	varying vec3 vFogWorldRel;
#endif
`;

const FOG_VERTEX = /* glsl */ `
#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
	// world-space vector camera → vertex: transpose(view rotation) · view-space position
	vFogWorldRel = ( vec4( mvPosition.xyz, 0.0 ) * viewMatrix ).xyz;
#endif
`;

const FOG_PARS_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
	uniform vec3 fogColor;
	varying float vFogDepth;
	varying vec3 vFogWorldRel;
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
	${ATMO_FOG_GLSL}
#endif
`;

const FOG_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
	if ( atmoFog[ 0 ].w > 0.5 ) {
		vec3 atmoT;
		vec3 atmoIns = atmoFogScatter( vFogWorldRel, cameraPosition.y, atmoT );
		#ifdef TONE_MAPPING
			// Direct-to-screen fallback: the colour is already tone mapped + encoded.
			atmoIns = linearToOutputTexel( vec4( toneMapping( atmoIns ), 1.0 ) ).rgb;
		#endif
		gl_FragColor.rgb = gl_FragColor.rgb * atmoT + atmoIns;
	} else if ( atmoFog[ 0 ].w > -0.5 ) {
		// uniform missing (all zeros): classic three.js fog with scene.fog
		#ifdef FOG_EXP2
			float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
		#else
			float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
		#endif
		gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
	}
#endif
`;

let installed = false;

/** Install the atmospheric fog chunks + shared uniform globally. Idempotent. */
export function installAtmosphericFog(): void {
  const chunks = THREE.ShaderChunk as Record<string, string>;
  chunks.fog_pars_vertex = FOG_PARS_VERTEX;
  chunks.fog_vertex = FOG_VERTEX;
  chunks.fog_pars_fragment = FOG_PARS_FRAGMENT;
  chunks.fog_fragment = FOG_FRAGMENT;
  if (installed) return;
  installed = true;
  (THREE.UniformsLib.fog as Record<string, THREE.IUniform>).atmoFog = { value: atmoFogData };
  const lib = THREE.ShaderLib as unknown as Record<string, { uniforms: Record<string, THREE.IUniform> }>;
  for (const key of Object.keys(lib)) {
    const u = lib[key].uniforms;
    if (u && 'fogColor' in u && !('atmoFog' in u)) u.atmoFog = { value: atmoFogData };
  }
}

/** Add the shared uniform to a fog-enabled ShaderMaterial that lacks it. Returns true if patched. */
export function ensureAtmosphericFogUniforms(material: THREE.Material): boolean {
  const m = material as THREE.ShaderMaterial;
  if (!m.isShaderMaterial || !m.fog || !m.uniforms || 'atmoFog' in m.uniforms) return false;
  m.uniforms.atmoFog = { value: atmoFogData };
  return true;
}

/**
 * Patch every fog-enabled ShaderMaterial under `root` that lacks the shared
 * uniform, and dispose it so three re-links it (with the uniform) next frame.
 * Returns how many materials were patched.
 */
export function ensureSceneFogUniforms(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!mat) return;
    const list = Array.isArray(mat) ? mat : [mat];
    for (const m of list) {
      if (ensureAtmosphericFogUniforms(m)) {
        m.dispose();
        n++;
      }
    }
  });
  return n;
}

// ─── TypeScript mirror (tests + CPU-side colour decisions) ────────────────────

function od(k: number, yc: number, dy: number): number {
  const kd = k * dy;
  const f = Math.abs(kd) > 1e-4 ? (1 - Math.exp(-kd)) / kd : 1 - 0.5 * kd;
  return Math.exp(-k * yc) * f;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Mirror of `atmoFogApply` (GLSL). `rel` = point − camera (world metres). */
export function aerialPerspective(color: RGB, rel: Vec3, cameraY: number, s: FogState, out: RGB): RGB {
  if (s.mode !== 1) {
    out.r = color.r;
    out.g = color.g;
    out.b = color.b;
    return out;
  }
  const d = Math.hypot(rel.x, rel.y, rel.z);
  const inv = 1 / Math.max(d, 1e-3);
  const yc = cameraY - s.referenceHeight;
  const fR = od(s.rayleighFalloff, yc, rel.y) * d;
  const fM = od(s.mieFalloff, yc, rel.y) * d;
  const tRr = s.rayleigh.r * fR;
  const tRg = s.rayleigh.g * fR;
  const tRb = s.rayleigh.b * fR;
  const tMe = s.mieExtinction * fM;
  const tMs = tMe * s.mieAlbedo;
  const fade = 1 - smoothstep(0.8 * s.visibility, s.visibility, d);
  const Tr = Math.exp(-(tRr + tMe)) * fade;
  const Tg = Math.exp(-(tRg + tMe)) * fade;
  const Tb = Math.exp(-(tRb + tMe)) * fade;
  const mu = (rel.x * s.sunDir.x + rel.y * s.sunDir.y + rel.z * s.sunDir.z) * inv;
  const pR = phaseRayleigh(mu);
  const pM = phaseMie(mu, s.mieG);
  const srcR = s.sunRadiance.r * (tRr * pR + tMs * pM) + s.ambient.r * (tRr + tMs);
  const srcG = s.sunRadiance.g * (tRg * pR + tMs * pM) + s.ambient.g * (tRg + tMs);
  const srcB = s.sunRadiance.b * (tRb * pR + tMs * pM) + s.ambient.b * (tRb + tMs);
  out.r = color.r * Tr + (srcR / Math.max(tRr + tMe, 1e-9)) * (1 - Tr);
  out.g = color.g * Tg + (srcG / Math.max(tRg + tMe, 1e-9)) * (1 - Tg);
  out.b = color.b * Tb + (srcB / Math.max(tRb + tMe, 1e-9)) * (1 - Tb);
  return out;
}

const _black: RGB = { r: 0, g: 0, b: 0 };
const _rel: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * The colour a black object turns into when it is as far away as anything can
 * be seen in direction `dir` (unit): the visibility distance, or the (flat)
 * ground if the ray reaches it first. The sky shader draws exactly this at and
 * below the horizon.
 */
export function hazeColor(dir: Vec3, cameraY: number, s: FogState, out: RGB): RGB {
  let dist = s.visibility;
  if (dir.y < 0) dist = Math.min(Math.max(cameraY - s.referenceHeight, 0.1) / -dir.y, s.visibility);
  _rel.x = dir.x * dist;
  _rel.y = dir.y * dist;
  _rel.z = dir.z * dist;
  return aerialPerspective(_black, _rel, cameraY, s, out);
}

const _sky: RGB = { r: 0, g: 0, b: 0 };
const _h0: RGB = { r: 0, g: 0, b: 0 };
const _h1: RGB = { r: 0, g: 0, b: 0 };
const _d: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Derive the fog state from the atmosphere for a sun direction and camera
 * height. The ambient term is solved per channel so that the haze at the
 * horizon (+0.5° elevation, averaged over 8 azimuths) equals the physical sky
 * there — distant terrain melts into the sky behind it.
 */
export function fogStateFromAtmosphere(p: AtmosphereParams, sunDir: Vec3, cameraHeight: number, out?: FogState): FogState {
  const s: FogState = out ?? {
    mode: 1,
    sunDir: { x: 0, y: 1, z: 0 },
    rayleigh: { r: 0, g: 0, b: 0 },
    rayleighFalloff: 0,
    mieExtinction: 0,
    mieFalloff: 0,
    mieAlbedo: 0,
    mieG: 0,
    visibility: 0,
    sunRadiance: { r: 0, g: 0, b: 0 },
    ambient: { r: 0, g: 0, b: 0 },
    referenceHeight: 0,
  };
  s.sunDir.x = sunDir.x;
  s.sunDir.y = sunDir.y;
  s.sunDir.z = sunDir.z;
  s.rayleigh.r = p.rayleigh.r;
  s.rayleigh.g = p.rayleigh.g;
  s.rayleigh.b = p.rayleigh.b;
  s.rayleighFalloff = 1 / p.rayleighScaleHeight;
  s.mieExtinction = p.mieExtinction;
  s.mieFalloff = 1 / p.mieScaleHeight;
  s.mieAlbedo = p.mieAlbedo;
  s.mieG = p.mieG;
  s.visibility = CONFIG.atmosphere.visibility;
  s.referenceHeight = CONFIG.world.seaLevel;
  sunIlluminanceAt(p, Math.max(cameraHeight - s.referenceHeight, 0), sunDir, s.sunRadiance);

  // Calibrate the ambient term against the sky at the horizon.
  const mode = s.mode;
  s.mode = 1;
  let skyR = 0, skyG = 0, skyB = 0, a0R = 0, a0G = 0, a0B = 0, wR = 0, wG = 0, wB = 0;
  const el = 0.5 * (Math.PI / 180);
  for (let i = 0; i < 8; i++) {
    const az = (i / 8) * Math.PI * 2;
    _d.x = Math.sin(az) * Math.cos(el);
    _d.y = Math.sin(el);
    _d.z = -Math.cos(az) * Math.cos(el);
    skyRadiance(p, _d, sunDir, cameraHeight - s.referenceHeight, _sky);
    s.ambient.r = s.ambient.g = s.ambient.b = 0;
    hazeColor(_d, cameraHeight, s, _h0);
    s.ambient.r = s.ambient.g = s.ambient.b = 1;
    hazeColor(_d, cameraHeight, s, _h1);
    skyR += _sky.r;
    skyG += _sky.g;
    skyB += _sky.b;
    a0R += _h0.r;
    a0G += _h0.g;
    a0B += _h0.b;
    wR += _h1.r - _h0.r;
    wG += _h1.g - _h0.g;
    wB += _h1.b - _h0.b;
  }
  s.ambient.r = Math.max(0, skyR - a0R) / Math.max(wR, 1e-9);
  s.ambient.g = Math.max(0, skyG - a0G) / Math.max(wG, 1e-9);
  s.ambient.b = Math.max(0, skyB - a0B) / Math.max(wB, 1e-9);
  s.mode = mode;
  return s;
}

/** Write a fog state into the shared uniform array (or `out`). Allocation-free. */
export function packFogUniforms(s: FogState, out: Float32Array = atmoFogData): void {
  out[0] = s.sunDir.x;
  out[1] = s.sunDir.y;
  out[2] = s.sunDir.z;
  out[3] = s.mode;
  out[4] = s.rayleigh.r;
  out[5] = s.rayleigh.g;
  out[6] = s.rayleigh.b;
  out[7] = s.rayleighFalloff;
  out[8] = s.mieExtinction;
  out[9] = s.mieFalloff;
  out[10] = s.mieG;
  out[11] = s.visibility;
  out[12] = s.sunRadiance.r;
  out[13] = s.sunRadiance.g;
  out[14] = s.sunRadiance.b;
  out[15] = s.mieAlbedo;
  out[16] = s.ambient.r;
  out[17] = s.ambient.g;
  out[18] = s.ambient.b;
  out[19] = s.referenceHeight;
}

installAtmosphericFog();
