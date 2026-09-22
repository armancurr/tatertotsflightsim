/**
 * HDR → display output pass: one full-screen triangle that applies, in order,
 * the lens flare (lensflare.ts), the in-cloud whiteout, a mild optical
 * vignette and saturation grade, filmic tone mapping (renderer.toneMapping),
 * sRGB encoding and a triangular dither against banding in sky gradients.
 * All of it costs one texture read per pixel plus ALU (≈0.2 ms at 1440×900).
 * Bloom is intentionally not used: the flare's glare term gives the sun its
 * photographic halo at a fraction of the cost of a blur chain.
 */
import * as THREE from 'three';
import { FLARE_FRAGMENT_GLSL, FLARE_VERTEX_GLSL, flareEdgeFade, sunScreenPosition, type SunScreen } from './lensflare';
import type { AtmosphereFrameData } from './frameData';

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
}

const VERTEX = /* glsl */ `
uniform sampler2D tHDR;
uniform vec2 uTexel;
varying vec2 vUv;
${FLARE_VERTEX_GLSL}
void main() {
	vUv = position.xy * 0.5 + 0.5;
	vSunVis = sunVisibility( tHDR, uTexel );
	gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

const FRAGMENT = /* glsl */ `
uniform sampler2D tHDR;
uniform vec4 uImmersion;
uniform vec3 uGrade; // saturation, vignette, dither
varying vec2 vUv;
${FLARE_FRAGMENT_GLSL}
void main() {
	vec3 c = texture2D( tHDR, vUv ).rgb;
	c += lensFlare( vUv );
	c = mix( c, uImmersion.rgb, uImmersion.a );
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
  /** Per-frame uniforms from the atmosphere + the scene camera. */
  update(frame: AtmosphereFrameData | undefined, camera: THREE.Camera, settings: PostSettings): void;
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
      uFlareSun: { value: new THREE.Vector4() },
      uFlareThreshold: { value: 1000 },
      uFlareSampleRadius: { value: 2 },
      uFlareColor: { value: new THREE.Vector3() },
      uFlareParams: { value: new THREE.Vector4(1, 1, 1, 1.6) },
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    depthTest: false,
    depthWrite: false,
    toneMapped: true,
  });
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const sun: SunScreen = { x: 0, y: 0, inFront: false };
  let texH = 1;

  return {
    scene,
    camera,
    material,
    setInput(texture, width, height) {
      material.uniforms.tHDR.value = texture;
      material.uniforms.uTexel.value.set(1 / width, 1 / height);
      texH = height;
    },
    update(frame, cam, s) {
      const u = material.uniforms;
      const aspect = (cam as THREE.PerspectiveCamera).aspect ?? 1;
      u.uFlareParams.value.set(s.flareGlare, s.flareGhosts, s.flareStarburst, aspect);
      u.uGrade.value.set(s.saturation, s.vignette, s.dither ? 1 : 0);
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
    },
  };
}
