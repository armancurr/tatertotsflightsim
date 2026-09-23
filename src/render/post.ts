/**
 * HDR → display output pass: one full-screen triangle that applies, in order,
 * the volumetric clouds (depth-aware upsampling of the low-resolution cloud
 * buffer, composited as scene·T + L; see volumetricClouds.ts), the lens flare
 * (lensflare.ts, occluded by the clouds too), bloom (bloom.ts: a ½-res dual-filter
 * chain of the HDR highlights, rendered from this mesh's onBeforeRender), the
 * in-cloud whiteout, the camera white balance (atmosphereState.ts), a mild optical
 * vignette and saturation grade, filmic tone mapping (renderer.toneMapping, with the
 * camera's auto exposure in renderer.toneMappingExposure), sRGB encoding and a
 * triangular dither against banding in sky gradients.
 * Cost at 1440×900 on an M2 Max: ≈0.2 ms for this pass + ≈0.1–0.2 ms of bloom.
 */
import * as THREE from 'three';
import { FLARE_FRAGMENT_GLSL, FLARE_VERTEX_GLSL, flareEdgeFade, sunScreenPosition, type SunScreen } from './lensflare';
import type { AtmosphereFrameData, CloudPassHook } from './frameData';
import type { DepthMode } from './renderer';
import type { QualityPlan } from './quality';
import { createBloom, type BloomSettings } from './bloom';
import { CONFIG } from '../config';

export interface PostSettings {
  /** 0..1 corner darkening. */
  vignette: number;
  /** 1 = unchanged. */
  saturation: number;
  flare: boolean;
  flareGlare: number;
  flareGhosts: number;
  flareStarburst: number;
  dither: boolean;
  /** Bloom intensity (0 = off; default config.render.bloom.intensity). The 'low' quality preset turns it off. */
  bloom?: number;
}

/** Bloom intensity for a quality plan: off on the 'low' preset and on software renderers. */
export function bloomForQuality(plan: Pick<QualityPlan, 'level' | 'tier'>, intensity: number = CONFIG.render.bloom.intensity): number {
  return plan.level === 'low' || plan.tier === 'software' ? 0 : intensity;
}

const VERTEX = /* glsl */ `
uniform sampler2D tHDR;
uniform vec2 uTexel;
uniform sampler2D tCloudA;
uniform vec4 uCloudOn;   // on, layer bottom, layer top, camera y
uniform mat4 uInvProj;
varying vec2 vUv;
varying vec3 vViewDir;
${FLARE_VERTEX_GLSL}
void main() {
	vUv = position.xy * 0.5 + 0.5;
	vec4 vp = uInvProj * vec4( position.xy, 1.0, 1.0 );
	vViewDir = vp.xyz / vp.w;
	vSunVis = sunVisibility( tHDR, uTexel );
	// the sun behind a cloud: its transmittance at the sun's position
	if ( uCloudOn.x > 0.5 && vSunVis > 0.0 ) vSunVis *= textureLod( tCloudA, uFlareSun.xy, 0.0 ).a;
	gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

const FRAGMENT = /* glsl */ `
uniform sampler2D tHDR;
uniform vec2 uTexel;
uniform vec4 uImmersion;
uniform vec3 uGrade; // saturation, vignette, dither
uniform vec3 uWB;    // camera white-balance gains
uniform sampler2D tBloom;
uniform float uBloom;
uniform sampler2D tCloudA;
uniform sampler2D tCloudB;
uniform sampler2D tDepth;
uniform vec4 uCloudOn;    // on, layer bottom, layer top, camera y
uniform vec2 uCloudSize;
uniform vec4 uDepth;      // near, far, mode (0 std, 1 reversed, 2 log), log2(far + 1)
uniform mat4 uCamWorld;
varying vec2 vUv;
varying vec3 vViewDir;
${FLARE_FRAGMENT_GLSL}
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
// Depth-aware upsampling of the cloud buffer: bilinear weights × similarity of the
// scene distance each cloud texel was marched against to the given scene distance.
vec4 cloudComposite( vec2 uv, float dist, float entry ) {
	if ( dist <= entry ) return vec4( 0.0, 0.0, 0.0, 1.0 ); // entirely in front of the cloud layer
	float distKm = dist * 0.001;
	vec2 p = uv * uCloudSize - 0.5;
	vec2 f = fract( p );
	ivec2 i0 = ivec2( floor( p ) );
	ivec2 mx = ivec2( uCloudSize ) - 1;
	vec4 acc = vec4( 0.0 );
	float wsum = 0.0;
	float best = 1e9;
	vec4 bestA = vec4( 0.0, 0.0, 0.0, 1.0 );
	float bestCloudKm = 0.0;
	for ( int k = 0; k < 4; k ++ ) {
		ivec2 o = ivec2( k & 1, k >> 1 );
		ivec2 ij = clamp( i0 + o, ivec2( 0 ), mx );
		vec4 A = texelFetch( tCloudA, ij, 0 );
		vec2 B = texelFetch( tCloudB, ij, 0 ).rg;
		float wb = ( o.x == 1 ? f.x : 1.0 - f.x ) * ( o.y == 1 ? f.y : 1.0 - f.y );
		float rel = abs( B.g - distKm ) / max( 1e-4, min( B.g, distKm ) );
		float w = wb * exp( - rel * 25.0 );
		acc += A * w;
		wsum += w;
		if ( rel < best ) {
			best = rel;
			bestA = A;
			bestCloudKm = B.r;
		}
	}
	if ( wsum > 1e-4 ) return acc / wsum;
	// no texel saw this surface (thin geometry at cloud resolution): borrow the closest one only
	// if its cloud lies in front of the surface
	return bestCloudKm < distKm ? bestA : vec4( 0.0, 0.0, 0.0, 1.0 );
}
float sceneDist( vec2 uv, float invCos ) {
	return min( linDepth( texture2D( tDepth, uv ).r ) * invCos, 1e6 );
}
void main() {
	vec3 c = texture2D( tHDR, vUv ).rgb;
	if ( uCloudOn.x > 0.5 ) {
		vec3 vd = normalize( vViewDir );
		float invCos = 1.0 / max( 1e-4, - vd.z );
		vec3 rd = mat3( uCamWorld ) * vd;
		float camY = uCloudOn.w;
		float entry = 0.0;
		if ( camY < uCloudOn.y ) entry = rd.y > 1e-5 ? ( uCloudOn.y - camY ) / rd.y : 1e9;
		else if ( camY > uCloudOn.z ) entry = rd.y < -1e-5 ? ( camY - uCloudOn.z ) / - rd.y : 1e9;
		float d0 = sceneDist( vUv, invCos );
		// MSAA edge pixels (the aircraft against clouds) blend a near and a far surface but carry ONE
		// resolved depth: composite for both the nearest and the farthest depth around and average,
		// instead of painting the whole pixel with the far clouds (jagged cloud-coloured fringes).
		float dA = sceneDist( vUv + vec2( uTexel.x, 0.0 ), invCos );
		float dB = sceneDist( vUv - vec2( uTexel.x, 0.0 ), invCos );
		float dC = sceneDist( vUv + vec2( 0.0, uTexel.y ), invCos );
		float dD = sceneDist( vUv - vec2( 0.0, uTexel.y ), invCos );
		float dN = min( d0, min( min( dA, dB ), min( dC, dD ) ) );
		float dF = max( d0, max( max( dA, dB ), max( dC, dD ) ) );
		if ( dF > dN * 1.3 + 1.0 && dF > entry ) {
			vec4 cn = cloudComposite( vUv, dN, entry );
			vec4 cf = cloudComposite( vUv, dF, entry );
			c = 0.5 * ( c * cn.a + cn.rgb ) + 0.5 * ( c * cf.a + cf.rgb );
		} else {
			vec4 cl = cloudComposite( vUv, d0, entry );
			c = c * cl.a + cl.rgb;
		}
	}
	c += lensFlare( vUv );
	if ( uBloom > 0.0 ) c += texture2D( tBloom, vUv ).rgb * uBloom;
	c = mix( c, uImmersion.rgb, uImmersion.a );
	c *= uWB;
	vec2 q = ( vUv - 0.5 ) * vec2( uFlareParams.w, 1.0 );
	c *= 1.0 - uGrade.y * smoothstep( 0.3, 1.05, length( q ) );
	float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
	c = max( mix( vec3( l ), c, uGrade.x ), 0.0 );
	gl_FragColor = vec4( c, 1.0 );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	if ( uGrade.z > 0.0 ) {
		vec2 f = gl_FragCoord.xy;
		float n = fract( sin( dot( f, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ) + fract( sin( dot( f, vec2( 39.3468, 11.135 ) ) ) * 24634.6345 ) - 1.0;
		gl_FragColor.rgb += n / 255.0;
	}
}
`;

export interface OutputPass {
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  material: THREE.ShaderMaterial;
  /** Point the pass at the resolved HDR image of this frame. */
  setInput(texture: THREE.Texture, width: number, height: number): void;
  /** Per-frame uniforms from the atmosphere + the scene camera (+ the cloud pass and scene depth when volumetric clouds are on). */
  update(frame: AtmosphereFrameData | undefined, camera: THREE.Camera, settings: PostSettings, clouds?: CloudPassHook | null, depth?: THREE.Texture | null, depthMode?: DepthMode): void;
  dispose(): void;
}

export function createOutputPass(): OutputPass {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const material = new THREE.ShaderMaterial({
    name: 'OutputPass',
    uniforms: {
      tHDR: { value: null },
      uTexel: { value: new THREE.Vector2(1, 1) },
      uImmersion: { value: new THREE.Vector4(1, 1, 1, 0) },
      uGrade: { value: new THREE.Vector3(1, 0.15, 1) },
      uWB: { value: new THREE.Vector3(1, 1, 1) },
      tBloom: { value: null },
      uBloom: { value: 0 },
      uFlareSun: { value: new THREE.Vector4() },
      uFlareThreshold: { value: 1000 },
      uFlareSampleRadius: { value: 2 },
      uFlareColor: { value: new THREE.Vector3() },
      uFlareParams: { value: new THREE.Vector4(1, 1, 1, 1.6) },
      tCloudA: { value: null },
      tCloudB: { value: null },
      tDepth: { value: null },
      uCloudOn: { value: new THREE.Vector4(0, 0, 0, 0) },
      uCloudSize: { value: new THREE.Vector2(1, 1) },
      uDepth: { value: new THREE.Vector4(0.1, 90000, 1, 1) },
      uInvProj: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() },
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    depthTest: false,
    depthWrite: false,
    toneMapped: true,
  });
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  const bloom = createBloom();
  const bc = CONFIG.render.bloom;
  const bloomSettings: BloomSettings = { intensity: bc.intensity, threshold: bc.threshold, knee: bc.knee, clamp: bc.clamp };
  let bloomCloud: THREE.Texture | null = null;
  // Bloom runs right before this pass draws (nested renders into its own targets, like three's Reflector).
  let lastRenderer: THREE.WebGLRenderer | null = null;
  mesh.onBeforeRender = (renderer) => {
    lastRenderer = renderer;
    const src = material.uniforms.tHDR.value as THREE.Texture | null;
    if (!src || !(bloomSettings.intensity > 0)) return;
    bloom.render(renderer, src, bloomCloud, renderer.toneMappingExposure, bloomSettings);
  };
  // Profiling: window.__render.benchBloom(n) = GPU-synchronised ms of one bloom chain on the last frame.
  if (typeof window !== 'undefined') {
    const px = new Uint16Array(4);
    const benchBloom = (n = 30): number => {
      const r = lastRenderer;
      const src = material.uniforms.tHDR.value as THREE.Texture | null;
      if (!r || !src) return NaN;
      // reading a texel of the bloom result blocks until the GPU has finished the chain
      const sync = () => r.readRenderTargetPixels(bloom.target, 0, 0, 1, 1, px);
      const run = (k: number) => {
        sync();
        const t0 = performance.now();
        for (let i = 0; i < k; i++) bloom.render(r, src, bloomCloud, r.toneMappingExposure, { ...bloomSettings, intensity: 1 });
        sync();
        return performance.now() - t0;
      };
      run(2);
      const a = run(1);
      const b = run(n + 1);
      return Math.round(((b - a) / n) * 1000) / 1000;
    };
    const w = window as unknown as { __render?: Record<string, unknown> };
    w.__render = { ...(w.__render ?? {}), benchBloom, bloomLevels: () => bloom.levels };
  }
  material.uniforms.tBloom.value = bloom.texture;
  const scene = new THREE.Scene();
  scene.add(mesh);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const sun: SunScreen = { x: 0, y: 0, inFront: false };
  let texH = 1;
  const camPos = new THREE.Vector3();
  // 1×1 placeholders so the samplers are always bound to something valid
  const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  blank.needsUpdate = true;
  material.uniforms.tCloudA.value = blank;
  material.uniforms.tCloudB.value = blank;
  material.uniforms.tDepth.value = blank;

  return {
    scene,
    camera,
    material,
    setInput(texture, width, height) {
      material.uniforms.tHDR.value = texture;
      material.uniforms.uTexel.value.set(1 / width, 1 / height);
      texH = height;
      bloom.setSize(width, height);
      material.uniforms.tBloom.value = bloom.texture;
    },
    update(frame, cam, s, clouds, depth, depthMode) {
      const u = material.uniforms;
      if (clouds && clouds.active && depth) {
        const pc = cam as THREE.PerspectiveCamera;
        cam.getWorldPosition(camPos);
        u.tCloudA.value = clouds.outputA;
        u.tCloudB.value = clouds.outputB;
        u.tDepth.value = depth;
        u.uCloudOn.value.set(1, clouds.layerBottom, clouds.layerTop, camPos.y);
        u.uCloudSize.value.copy(clouds.size);
        const far = pc.far ?? 90000;
        u.uDepth.value.set(pc.near ?? 0.1, far, depthMode === 'reversed' ? 1 : depthMode === 'logarithmic' ? 2 : 0, Math.log2(far + 1));
        u.uInvProj.value.copy(cam.projectionMatrixInverse);
        u.uCamWorld.value.copy(cam.matrixWorld);
        bloomCloud = clouds.outputA;
      } else {
        bloomCloud = null;
        u.uCloudOn.value.x = 0;
        u.tCloudA.value = blank;
        u.tCloudB.value = blank;
        u.tDepth.value = blank;
      }
      const aspect = (cam as THREE.PerspectiveCamera).aspect ?? 1;
      u.uFlareParams.value.set(s.flareGlare, s.flareGhosts, s.flareStarburst, aspect);
      u.uGrade.value.set(s.saturation, s.vignette, s.dither ? 1 : 0);
      bloomSettings.intensity = s.bloom ?? bc.intensity;
      u.uBloom.value = bloomSettings.intensity > 0 ? bloomSettings.intensity : 0;
      const wb = frame?.whiteBalance;
      if (wb) u.uWB.value.set(wb.r, wb.g, wb.b);
      else u.uWB.value.set(1, 1, 1);
      if (!frame) {
        u.uFlareSun.value.z = 0;
        u.uImmersion.value.w = 0;
        return;
      }
      u.uImmersion.value.set(frame.immersionColor.r, frame.immersionColor.g, frame.immersionColor.b, frame.immersion);
      let enabled = s.flare && frame.flare;
      if (enabled) {
        sunScreenPosition(frame.sunDirection, cam, sun);
        const fade = flareEdgeFade(sun.x, sun.y);
        enabled = sun.inFront && fade > 0;
        u.uFlareSun.value.set(sun.x * 0.5 + 0.5, sun.y * 0.5 + 0.5, enabled ? 1 : 0, fade);
        u.uFlareColor.value.set(frame.sunColor.r, frame.sunColor.g, frame.sunColor.b);
        u.uFlareThreshold.value = frame.sunDiscLuminance;
        // sun disc radius in pixels of the HDR image
        const fov = ((cam as THREE.PerspectiveCamera).fov ?? 60) * (Math.PI / 180);
        const discPx = (frame.sunAngularRadius / Math.tan(fov / 2)) * (texH / 2);
        u.uFlareSampleRadius.value = Math.max(0.5, discPx * 0.7);
      } else {
        u.uFlareSun.value.z = 0;
      }
    },
    dispose() {
      geo.dispose();
      material.dispose();
      blank.dispose();
      bloom.dispose();
    },
  };
}
