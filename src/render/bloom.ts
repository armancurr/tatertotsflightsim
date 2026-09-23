/**
 * Cheap physically-motivated bloom (veiling glare of the lens/eye) for HDR highlights:
 * sun glints on water and canopies, runway and town lights at dusk, the sun itself.
 *
 * The classic "dual filter" chain (Jimenez, Next-Generation Post Processing in Call of Duty, 2014):
 *   prefilter  full-res HDR → ½ res: 4 bilinear taps (a 4×4 box) with a Karis (1/(1+luma)) average against
 *              fireflies, a soft-knee threshold and a clamp (in EXPOSED units, so it tracks the
 *              camera's auto exposure), with the volumetric cloud layer composited in first so a sun
 *              behind a cloud does not bloom through it;
 *   down       ½ → ¼ → ⅛ → 1/16 → 1/32: 13-tap downsamples;
 *   up         1/32 → … → ½: 9-tap tent, added (blend ONE, ONE) onto the next level up.
 * The output pass (post.ts) adds level ½ × intensity to the scene before tone mapping.
 * At 1440×900 that is ~0.1 ms of GPU on an M2 Max (everything below ½ res is nearly free).
 *
 * Rendered from the output mesh's onBeforeRender (the same nested-render pattern as three's
 * Reflector), so the renderer's pipeline (renderer.ts) needs no extra hook.
 */
import * as THREE from 'three';

export interface BloomSettings {
  /** Added fraction of the blurred highlights (0 = off). */
  intensity: number;
  /** Exposed (display-referred, pre-curve) value where bloom starts. */
  threshold: number;
  /** Soft-knee width around the threshold (exposed units). */
  knee: number;
  /** Clamp of the prefiltered brightness (exposed units): the sun disc must not flood the frame. */
  clamp: number;
}

/** Sizes of the mip chain for a w×h source: ½ res first, halving until a side would drop below `minSide` or `max` levels. */
export function bloomLevels(width: number, height: number, max = 5, minSide = 8): Array<{ width: number; height: number }> {
  const out: Array<{ width: number; height: number }> = [];
  let w = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
  let h = Number.isFinite(height) ? Math.max(1, Math.floor(height)) : 1;
  const n = Math.max(0, Math.min(8, Math.floor(max)));
  for (let i = 0; i < n; i++) {
    w = Math.max(1, Math.ceil(w / 2));
    h = Math.max(1, Math.ceil(h / 2));
    if (i > 0 && Math.min(w, h) < minSide) break;
    out.push({ width: w, height: h });
  }
  return out;
}

/**
 * Soft-knee threshold weight (mirror of the GLSL): the fraction of a pixel of brightness `b`
 * (exposed units) that blooms. 0 below threshold − knee, quadratic through the knee, then
 * (b − threshold)/b. Continuous, in [0, 1), non-decreasing in b. The knee is limited to
 * the threshold (a wider one would start blooming at b = 0).
 */
export function bloomWeight(b: number, threshold: number, knee: number): number {
  if (!(b > 0) || !Number.isFinite(b)) return b === Infinity ? 1 : 0;
  const k = Math.max(Math.min(knee, threshold), 1e-5);
  const soft = Math.min(2 * k, Math.max(0, b - threshold + k));
  const q = (soft * soft) / (4 * k);
  return Math.max(q, b - threshold) / b;
}

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
	vUv = position.xy * 0.5 + 0.5;
	gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

// 13 taps: a 4×4-texel box around the centre from 4 overlapping 2×2 boxes + 1 inner box (Jimenez).
const DOWN13 = /* glsl */ `
vec3 down13( sampler2D t, vec2 uv, vec2 px, bool karis ) {
	vec3 a = SRC( t, uv + px * vec2( - 2.0, - 2.0 ) );
	vec3 b = SRC( t, uv + px * vec2(   0.0, - 2.0 ) );
	vec3 c = SRC( t, uv + px * vec2(   2.0, - 2.0 ) );
	vec3 d = SRC( t, uv + px * vec2( - 1.0, - 1.0 ) );
	vec3 e = SRC( t, uv + px * vec2(   1.0, - 1.0 ) );
	vec3 f = SRC( t, uv + px * vec2( - 2.0,   0.0 ) );
	vec3 g = SRC( t, uv );
	vec3 h = SRC( t, uv + px * vec2(   2.0,   0.0 ) );
	vec3 i = SRC( t, uv + px * vec2( - 1.0,   1.0 ) );
	vec3 j = SRC( t, uv + px * vec2(   1.0,   1.0 ) );
	vec3 k = SRC( t, uv + px * vec2( - 2.0,   2.0 ) );
	vec3 l = SRC( t, uv + px * vec2(   0.0,   2.0 ) );
	vec3 m = SRC( t, uv + px * vec2(   2.0,   2.0 ) );
	vec3 g0 = ( d + e + i + j ) * 0.25;
	vec3 g1 = ( a + b + f + g ) * 0.25;
	vec3 g2 = ( b + c + g + h ) * 0.25;
	vec3 g3 = ( f + g + k + l ) * 0.25;
	vec3 g4 = ( g + h + l + m ) * 0.25;
	vec4 wk = vec4( 0.125 );
	float w0 = 0.5;
	if ( karis ) {
		// Karis average: weight each 2×2 box by 1 / (1 + exposed luma) — one hot texel can't dominate
		const vec3 Y = vec3( 0.2126, 0.7152, 0.0722 );
		w0 *= 1.0 / ( 1.0 + dot( g0, Y ) * uKaris );
		wk *= 1.0 / ( 1.0 + vec4( dot( g1, Y ), dot( g2, Y ), dot( g3, Y ), dot( g4, Y ) ) * uKaris );
	}
	return ( g0 * w0 + g1 * wk.x + g2 * wk.y + g3 * wk.z + g4 * wk.w ) / ( w0 + wk.x + wk.y + wk.z + wk.w );
}
`;

const PREFILTER = /* glsl */ `
uniform sampler2D tSrc;
uniform sampler2D tCloudA;
uniform float uCloudOn;
uniform vec2 uPx;
uniform vec4 uKnee; // threshold, knee, clamp (all scene units = exposed / exposure), 1/exposure
uniform float uKaris;
uniform sampler2D tAdapt; // eye adaptation (metering.ts): R = log2 exposure trim
uniform float uAdaptOn;
varying vec2 vUv;
float adaptGain() {
	return uAdaptOn > 0.5 ? exp2( textureLod( tAdapt, vec2( 0.5 ), 0.0 ).r ) : 1.0;
}
vec3 fetchScene( sampler2D t, vec2 uv ) {
	vec3 c = textureLod( t, uv, 0.0 ).rgb;
	if ( uCloudOn > 0.5 ) {
		vec4 cl = textureLod( tCloudA, uv, 0.0 );
		c = c * cl.a + cl.rgb;
	}
	// clamp per tap (keeps the sun disc and single hot texels from flooding the frame)
	float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
	return c * min( 1.0, uKnee.z / ( adaptGain() * max( l, 1e-6 ) ) );
}
void main() {
	// 4 bilinear taps = a 4×4-texel box, each tap Karis-weighted (1/(1 + exposed luma)) so a single
	// hot texel (a glint) cannot dominate and flicker
	const vec3 Y = vec3( 0.2126, 0.7152, 0.0722 );
	float ag = adaptGain();
	vec3 a = fetchScene( tSrc, vUv + uPx * vec2( - 1.0, - 1.0 ) );
	vec3 b4 = fetchScene( tSrc, vUv + uPx * vec2( 1.0, - 1.0 ) );
	vec3 d = fetchScene( tSrc, vUv + uPx * vec2( - 1.0, 1.0 ) );
	vec3 e = fetchScene( tSrc, vUv + uPx * vec2( 1.0, 1.0 ) );
	vec4 kw = 1.0 / ( 1.0 + vec4( dot( a, Y ), dot( b4, Y ), dot( d, Y ), dot( e, Y ) ) * uKaris * ag );
	vec3 c = ( a * kw.x + b4 * kw.y + d * kw.z + e * kw.w ) / ( kw.x + kw.y + kw.z + kw.w );
	// thresholds in the final exposed units: compare the adapted brightness
	float b = max( c.r, max( c.g, c.b ) ) * ag;
	float soft = clamp( b - uKnee.x + uKnee.y, 0.0, 2.0 * uKnee.y );
	soft = soft * soft / ( 4.0 * uKnee.y + 1e-6 );
	float w = max( soft, b - uKnee.x ) / max( b, 1e-6 );
	gl_FragColor = vec4( c * w, 1.0 );
}
`;

const DOWN = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uPx;
uniform float uKaris;
varying vec2 vUv;
#define SRC( t, uv ) textureLod( t, uv, 0.0 ).rgb
${DOWN13}
void main() {
	gl_FragColor = vec4( down13( tSrc, vUv, uPx, false ), 1.0 );
}
`;

const UP = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uPx;
uniform float uWeight;
varying vec2 vUv;
void main() {
	vec3 s = textureLod( tSrc, vUv + uPx * vec2( - 1.0, - 1.0 ), 0.0 ).rgb;
	s += textureLod( tSrc, vUv + uPx * vec2( 0.0, - 1.0 ), 0.0 ).rgb * 2.0;
	s += textureLod( tSrc, vUv + uPx * vec2( 1.0, - 1.0 ), 0.0 ).rgb;
	s += textureLod( tSrc, vUv + uPx * vec2( - 1.0, 0.0 ), 0.0 ).rgb * 2.0;
	s += textureLod( tSrc, vUv, 0.0 ).rgb * 4.0;
	s += textureLod( tSrc, vUv + uPx * vec2( 1.0, 0.0 ), 0.0 ).rgb * 2.0;
	s += textureLod( tSrc, vUv + uPx * vec2( - 1.0, 1.0 ), 0.0 ).rgb;
	s += textureLod( tSrc, vUv + uPx * vec2( 0.0, 1.0 ), 0.0 ).rgb * 2.0;
	s += textureLod( tSrc, vUv + uPx * vec2( 1.0, 1.0 ), 0.0 ).rgb;
	gl_FragColor = vec4( s * ( uWeight / 16.0 ), 1.0 );
}
`;

export interface Bloom {
  /** The result (½ res, scene units): add × intensity before tone mapping. */
  readonly texture: THREE.Texture;
  /** The ½-res render target holding `texture` (profiling readback). */
  readonly target: THREE.WebGLRenderTarget;
  readonly levels: number;
  setSize(width: number, height: number): void;
  /**
   * Run the chain from `source` (resolved HDR scene). `cloud` = the volumetric cloud buffer
   * (scene·a + rgb) or null. `exposure` converts the exposed-unit settings to scene units.
   */
  render(renderer: THREE.WebGLRenderer, source: THREE.Texture, cloud: THREE.Texture | null, exposure: number, s: BloomSettings, adapt?: THREE.Texture | null): void;
  dispose(): void;
}

export function createBloom(maxLevels = 5): Bloom {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const mk = (name: string, fragmentShader: string, uniforms: Record<string, THREE.IUniform>, blending: THREE.Blending = THREE.NoBlending) =>
    new THREE.ShaderMaterial({ name, vertexShader: VERTEX, fragmentShader, uniforms, depthTest: false, depthWrite: false, blending, toneMapped: false, fog: false });
  const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  blank.needsUpdate = true;
  const prefilter = mk('BloomPrefilter', PREFILTER, {
    tSrc: { value: null },
    tCloudA: { value: blank },
    uCloudOn: { value: 0 },
    uPx: { value: new THREE.Vector2() },
    uKnee: { value: new THREE.Vector4(1, 0.5, 50, 1) },
    uKaris: { value: 1 },
    tAdapt: { value: blank },
    uAdaptOn: { value: 0 },
  });
  const down = mk('BloomDown', DOWN, { tSrc: { value: null }, uPx: { value: new THREE.Vector2() }, uKaris: { value: 0 } });
  const up = mk('BloomUp', UP, { tSrc: { value: null }, uPx: { value: new THREE.Vector2() }, uWeight: { value: 1 } }, THREE.CustomBlending);
  up.blendEquation = THREE.AddEquation;
  up.blendSrc = THREE.OneFactor;
  up.blendDst = THREE.OneFactor;
  const mesh = new THREE.Mesh(geo, prefilter);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  let targets: THREE.WebGLRenderTarget[] = [];
  let srcW = 0;
  let srcH = 0;
  const makeTarget = (w: number, h: number) => {
    const t = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    t.texture.name = 'bloom';
    return t;
  };
  // Always at least one target, so `texture` is valid before the first setSize.
  targets = [makeTarget(1, 1)];

  function setSize(width: number, height: number) {
    if (width === srcW && height === srcH) return;
    srcW = width;
    srcH = height;
    const sizes = bloomLevels(width, height, maxLevels);
    for (let i = 0; i < sizes.length; i++) {
      if (targets[i]) targets[i].setSize(sizes[i].width, sizes[i].height);
      else targets.push(makeTarget(sizes[i].width, sizes[i].height));
    }
    while (targets.length > Math.max(1, sizes.length)) targets.pop()!.dispose();
  }

  const draw = (renderer: THREE.WebGLRenderer, mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget) => {
    mesh.material = mat;
    renderer.setRenderTarget(target);
    renderer.render(scene, cam);
  };

  return {
    get texture() {
      return targets[0].texture;
    },
    get target() {
      return targets[0];
    },
    get levels() {
      return targets.length;
    },
    setSize,
    render(renderer, source, cloud, exposure, s, adapt = null) {
      const n = targets.length;
      if (n === 0 || srcW === 0) return;
      const prevTarget = renderer.getRenderTarget();
      const prevAutoClear = renderer.autoClear;
      const ex = Number.isFinite(exposure) && exposure > 0 ? exposure : 1;
      // prefilter: full → ½
      const pu = prefilter.uniforms;
      pu.tSrc.value = source;
      pu.tCloudA.value = cloud ?? blank;
      pu.uCloudOn.value = cloud ? 1 : 0;
      pu.tAdapt.value = adapt ?? blank;
      pu.uAdaptOn.value = adapt ? 1 : 0;
      pu.uPx.value.set(1 / srcW, 1 / srcH);
      pu.uKnee.value.set(s.threshold / ex, Math.max(1e-4, Math.min(s.knee, s.threshold) / ex), s.clamp / ex, 1 / ex);
      pu.uKaris.value = ex;
      renderer.autoClear = true;
      draw(renderer, prefilter, targets[0]);
      // down chain
      for (let i = 1; i < n; i++) {
        const src = targets[i - 1];
        down.uniforms.tSrc.value = src.texture;
        down.uniforms.uPx.value.set(1 / src.width, 1 / src.height);
        draw(renderer, down, targets[i]);
      }
      // up chain: add the blurred lower level onto the level above (no clear)
      renderer.autoClear = false;
      for (let i = n - 1; i > 0; i--) {
        const src = targets[i];
        up.uniforms.tSrc.value = src.texture;
        up.uniforms.uPx.value.set(1 / src.width, 1 / src.height);
        up.uniforms.uWeight.value = 1;
        draw(renderer, up, targets[i - 1]);
      }
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevTarget);
    },
    dispose() {
      for (const t of targets) t.dispose();
      targets = [];
      geo.dispose();
      prefilter.dispose();
      down.dispose();
      up.dispose();
      blank.dispose();
    },
  };
}
