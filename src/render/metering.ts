/**
 * Eye adaptation / camera metering on the GPU: a gentle, view-dependent trim on top of the
 * time-of-day exposure (atmosphereState.ts), like a camera's centre-weighted metering or an eye
 * adapting when you look into the sun or down into a dark cockpit.
 *
 *   meter   HDR scene (with the volumetric clouds composited) → 64×32 target of centre-weighted
 *           log2 luminance (R = w·log2 L, G = w), mip-mapped down to 1×1 by the GPU = the weighted
 *           geometric mean of the frame;
 *   adapt   1×1 ping-pong: the target trim (key / metered)^strength, clamped to [min, max], eased
 *           toward exponentially (faster when it has to darken, like the eye) — stored as log2.
 * The output pass multiplies the scene by exp2(trim) before tone mapping; bloom's threshold follows.
 * Nothing is read back to the CPU (no stalls). Cost: two tiny passes (≈0.02 ms).
 *
 * `meterTrim` and `adaptStep` are the exact TypeScript mirrors (tests).
 */
import * as THREE from 'three';
import { CONFIG } from '../config';
import { HDR_SAFE_GLSL } from './hdrSafe';

export type MeteringConfig = typeof CONFIG.render.metering;

/**
 * Target log2 exposure trim for a frame whose weighted mean log2 scene luminance is `avgLog2`,
 * shown at `exposure`: strength·log2(key / exposed mean), clamped to log2 [min, max]. Finite for any input.
 */
export function meterTrim(avgLog2: number, exposure: number, cfg: MeteringConfig = CONFIG.render.metering): number {
  const lo = Math.log2(cfg.min);
  const hi = Math.log2(cfg.max);
  if (!Number.isFinite(avgLog2) || !(exposure > 0) || !Number.isFinite(exposure)) return 0;
  const t = cfg.strength * (Math.log2(cfg.key) - (avgLog2 + Math.log2(exposure)));
  return Math.min(hi, Math.max(lo, t));
}

/** One easing step of the trim (log2) toward `target` over `dt` seconds: darkening uses tauDarken, brightening tauBrighten. */
export function adaptStep(prev: number, target: number, dt: number, cfg: MeteringConfig = CONFIG.render.metering): number {
  if (!Number.isFinite(target)) return Number.isFinite(prev) ? prev : 0;
  if (!Number.isFinite(prev)) return target;
  const d = Math.min(0.25, Math.max(0, Number.isFinite(dt) ? dt : 0));
  const tau = target < prev ? cfg.tauDarken : cfg.tauBrighten;
  const k = 1 - Math.exp(-d / Math.max(tau, 1e-3));
  const a = prev * (1 - k) + target * k;
  return Number.isFinite(a) ? Math.min(Math.max(a, Math.min(prev, target)), Math.max(prev, target)) : target;
}

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
	vUv = position.xy * 0.5 + 0.5;
	gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

const METER = /* glsl */ `
uniform sampler2D tSrc;
uniform sampler2D tCloudA;
uniform float uCloudOn;
uniform vec2 uStep; // uv offset of the 4 taps inside a meter texel
varying vec2 vUv;
${HDR_SAFE_GLSL}
float lumAt( vec2 uv ) {
	vec3 c = textureLod( tSrc, uv, 0.0 ).rgb;
	if ( uCloudOn > 0.5 ) {
		vec4 cl = textureLod( tCloudA, uv, 0.0 );
		c = c * cl.a + cl.rgb;
	}
	return dot( hdrSafe( c ), vec3( 0.2126, 0.7152, 0.0722 ) );
}
void main() {
	float l = 0.25 * ( lumAt( vUv + uStep * vec2( - 1.0, - 1.0 ) ) + lumAt( vUv + uStep * vec2( 1.0, - 1.0 ) )
		+ lumAt( vUv + uStep * vec2( - 1.0, 1.0 ) ) + lumAt( vUv + uStep * vec2( 1.0, 1.0 ) ) );
	// centre-weighted (a little below the middle, where the world is in a chase or cockpit view)
	vec2 q = ( vUv - vec2( 0.5, 0.45 ) ) * vec2( 1.0, 1.3 );
	float w = 1.0 - 0.75 * smoothstep( 0.0, 0.7, length( q ) );
	gl_FragColor = vec4( w * log2( clamp( l, 1e-5, 1e4 ) ), w, 0.0, 1.0 );
}
`;

const ADAPT = /* glsl */ `
uniform sampler2D tMeter;
uniform sampler2D tPrev;
uniform float uLevel;
uniform vec4 uCfg;   // log2 key, strength, log2 min, log2 max
uniform vec3 uTime;  // dt, tauDarken, tauBrighten
uniform float uLogExposure;
uniform float uReset;
varying vec2 vUv;
${HDR_SAFE_GLSL}
void main() {
	vec2 m = textureLod( tMeter, vec2( 0.5 ), uLevel ).rg;
	float avg = m.x / max( m.y, 1e-6 );
	float target = clamp( uCfg.y * ( uCfg.x - ( avg + uLogExposure ) ), uCfg.z, uCfg.w );
	if ( hdrBad( target ) ) target = 0.0;
	float prev = textureLod( tPrev, vec2( 0.5 ), 0.0 ).r;
	// a feedback loop: a NaN here would stay forever (and black out the frame) — restart from the target
	if ( hdrBad( prev ) ) prev = target;
	float tau = target < prev ? uTime.y : uTime.z;
	float a = uReset > 0.5 ? target : prev + ( target - prev ) * ( 1.0 - exp( - uTime.x / max( tau, 1e-3 ) ) );
	if ( hdrBad( a ) ) a = target;
	gl_FragColor = vec4( a, avg, target, 1.0 );
}
`;

export interface Meter {
  /** 1×1: R = log2 exposure trim (G = metered mean log2 luminance, B = target trim). */
  readonly texture: THREE.Texture;
  /** Meter the frame and advance the adaptation by dt seconds. `reset` jumps straight to the target. */
  render(renderer: THREE.WebGLRenderer, source: THREE.Texture, cloud: THREE.Texture | null, exposure: number, dt: number, reset?: boolean): void;
  /** CPU readback of the last result (debug / QA only: stalls the GPU). */
  read(renderer: THREE.WebGLRenderer): { trim: number; meanLog2: number; target: number };
  dispose(): void;
}

export function createMeter(cfg: MeteringConfig = CONFIG.render.metering): Meter {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  blank.needsUpdate = true;
  const W = 64;
  const H = 32;
  const level = Math.log2(W);
  const meterRT = new THREE.WebGLRenderTarget(W, H, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
  });
  const mk1 = () =>
    new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false, generateMipmaps: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  const adapt = [mk1(), mk1()];
  let cur = 0;
  let first = true;
  const meterMat = new THREE.ShaderMaterial({
    name: 'Meter',
    vertexShader: VERTEX,
    fragmentShader: METER,
    uniforms: { tSrc: { value: null }, tCloudA: { value: blank }, uCloudOn: { value: 0 }, uStep: { value: new THREE.Vector2(0.25 / W, 0.25 / H) } },
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const adaptMat = new THREE.ShaderMaterial({
    name: 'MeterAdapt',
    vertexShader: VERTEX,
    fragmentShader: ADAPT,
    uniforms: {
      tMeter: { value: meterRT.texture },
      tPrev: { value: adapt[1].texture },
      uLevel: { value: level },
      uCfg: { value: new THREE.Vector4(Math.log2(cfg.key), cfg.strength, Math.log2(cfg.min), Math.log2(cfg.max)) },
      uTime: { value: new THREE.Vector3(0, cfg.tauDarken, cfg.tauBrighten) },
      uLogExposure: { value: 0 },
      uReset: { value: 1 },
    },
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geo, meterMat);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const px = new Uint16Array(4);

  return {
    get texture() {
      return adapt[cur].texture;
    },
    render(renderer, source, cloud, exposure, dt, reset = false) {
      const prevTarget = renderer.getRenderTarget();
      meterMat.uniforms.tSrc.value = source;
      meterMat.uniforms.tCloudA.value = cloud ?? blank;
      meterMat.uniforms.uCloudOn.value = cloud ? 1 : 0;
      mesh.material = meterMat;
      renderer.setRenderTarget(meterRT);
      renderer.render(scene, cam);
      const next = 1 - cur;
      adaptMat.uniforms.tPrev.value = adapt[cur].texture;
      adaptMat.uniforms.uTime.value.x = Math.min(0.25, Math.max(0, Number.isFinite(dt) ? dt : 0));
      adaptMat.uniforms.uLogExposure.value = Math.log2(exposure > 0 && Number.isFinite(exposure) ? exposure : 1);
      adaptMat.uniforms.uReset.value = reset || first ? 1 : 0;
      mesh.material = adaptMat;
      renderer.setRenderTarget(adapt[next]);
      renderer.render(scene, cam);
      cur = next;
      first = false;
      renderer.setRenderTarget(prevTarget);
    },
    read(renderer) {
      renderer.readRenderTargetPixels(adapt[cur], 0, 0, 1, 1, px);
      const h = THREE.DataUtils.fromHalfFloat;
      return { trim: h(px[0]), meanLog2: h(px[1]), target: h(px[2]) };
    },
    dispose() {
      meterRT.dispose();
      adapt[0].dispose();
      adapt[1].dispose();
      meterMat.dispose();
      adaptMat.dispose();
      geo.dispose();
      blank.dispose();
    },
  };
}
