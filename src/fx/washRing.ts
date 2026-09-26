/**
 * The rotor wash on water, drawn as ONE flat disc lying on the surface (one draw call, hidden when
 * there is no wash on water): the wash roughens the water so it stops mirroring the sky — a darker
 * ring around the impact point — with ripples racing outward, their fronts wobbling,
 * and inside a paler, matte disc where the chop scatters the sky, streaked with radial cat's paws.
 * The spray itself is particles (rotorWash.ts).
 * Allocation-free per frame.
 */
import * as THREE from 'three';
import { ensureAtmosphericFogUniforms } from '../render/fog';

/** Outer radius of the disc, in rotor radii. */
export const WASH_RING_RADII = 2.8;

const VERT = /* glsl */ `
varying vec2 vP;
#include <fog_pars_vertex>
void main() {
  vP = position.xy;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
uniform float uTime;
uniform float uStrength;
uniform vec3 uDark;
uniform vec3 uFoam;
varying vec2 vP;
#include <fog_pars_fragment>
void main() {
  float r = length(vP);
  if (r > 1.0) discard;
  float ang = atan(vP.y, vP.x);
  // Where the wash is: from the impact ring (~0.6 R) out, fading softly before the edge.
  float env = smoothstep(0.05, 0.3, r) * (1.0 - smoothstep(0.45, 1.0, r));
  // Radial filaments of roughened water (cat's paws blown outward), slowly writhing.
  float f1 = 0.5 + 0.5 * sin(ang * 73.0 + 3.0 * sin(ang * 9.0 + r * 4.0 - uTime * 0.7));
  float f2 = 0.5 + 0.5 * sin(ang * 131.0 - 2.0 * sin(ang * 5.0 - uTime * 0.5) + r * 11.0);
  // Ripples racing outward, their fronts wobbling with angle and time.
  float wob = 0.035 * sin(ang * 5.0 + uTime * 1.3) + 0.02 * sin(ang * 11.0 - uTime * 2.3);
  float rip = 0.5 + 0.5 * sin((r + wob) * 30.0 - uTime * 8.0);
  float gust = 0.5 + 0.5 * sin(ang * 7.0 + 1.7 * sin(ang * 3.0 - uTime * 0.4) + uTime * 0.3);
  float rough = env * (0.5 + 0.3 * f1 * f2 * gust + 0.2 * rip);
  // Inside, the chop scatters sky light (a paler, matte disc); further out the ripples only darken the mirror.
  float inner = 1.0 - smoothstep(0.3, 0.7, r);
  float s = clamp(uStrength, 0.0, 1.3);
  float aLight = s * 0.14 * rough * inner;
  float aDark = s * 0.22 * env * (1.0 - inner * 0.6) * (0.5 + 0.5 * rip);
  float a = aLight + aDark;
  if (a < 0.002) discard;
  gl_FragColor = vec4(mix(uDark, uFoam, aLight / a), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export interface WashRing {
  readonly mesh: THREE.Mesh;
  /**
   * Place the ring (world centre on the water surface, rotor radius m) with strength 0..~1.5 (0 hides
   * it); time in s drives the ripples; foam = lit colour of white froth (scene-referred linear RGB).
   */
  update(x: number, y: number, z: number, radius: number, strength: number, time: number, foam?: THREE.Color): void;
  hide(): void;
  dispose(): void;
}

export function createWashRing(parent: THREE.Object3D): WashRing {
  const geo = new THREE.CircleGeometry(1, 64, 0, Math.PI * 2);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uTime: { value: 0 },
      uStrength: { value: 0 },
      uDark: { value: new THREE.Color(0.004, 0.009, 0.012) },
      uFoam: { value: new THREE.Color(0.8, 0.82, 0.85) },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    fog: true,
  });
  // The shared atmospheric-fog uniforms by reference (a clone would freeze them).
  const u = mat.uniforms as Record<string, THREE.IUniform>;
  const fogLib = THREE.UniformsLib.fog as Record<string, THREE.IUniform>;
  if (fogLib.atmoFog) u.atmoFog = { value: fogLib.atmoFog.value };
  if (fogLib.atmoCloudShadow) u.atmoCloudShadow = { value: fogLib.atmoCloudShadow.value };
  ensureAtmosphericFogUniforms(mat);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'fx-rotor-wash-ring';
  mesh.rotation.x = -Math.PI / 2; // disc in the XY plane → lying on the water (XZ)
  mesh.renderOrder = -8; // after the water surfaces (-10, -9), before the particles
  mesh.frustumCulled = false;
  mesh.visible = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  parent.add(mesh);
  let disposed = false;
  const fin = Number.isFinite;

  return {
    mesh,
    update(x, y, z, radius, strength, time, foam) {
      if (disposed) return;
      const s = fin(strength) ? Math.max(0, Math.min(1.5, strength)) : 0;
      if (s < 0.01 || !(fin(x) && fin(y) && fin(z) && fin(radius) && radius > 0)) {
        mesh.visible = false;
        return;
      }
      const R = radius * WASH_RING_RADII;
      mesh.position.set(x, y + 0.12, z);
      mesh.scale.set(R, R, 1);
      mesh.visible = true;
      u.uStrength.value = s;
      u.uTime.value = fin(time) ? time % 3600 : 0;
      if (foam) (u.uFoam.value as THREE.Color).copy(foam);
    },
    hide() {
      mesh.visible = false;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      mesh.removeFromParent();
      geo.dispose();
      mat.dispose();
    },
  };
}
