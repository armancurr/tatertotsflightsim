/**
 * The animals' material: a MeshStandardMaterial (lit by the sun and the sky's environment like
 * everything else, in the atmospheric fog) with vertex animation in the shader, driven by the
 * geometry's `aBody` (models.ts) and a per-instance `aAnim`:
 *
 *   cetaceans / seals  aAnim = (tail-beat phase rad, beat amplitude 0..1, arch, tail lift)
 *     the tail beats up and down (cetaceans swim with vertical strokes), growing toward the flukes;
 *     `arch` bows the back (ends down), `tail lift` raises the tail stock and flukes (a sounding
 *     whale); for a seal, arch < 0 lifts the head and hind flippers (the "banana" pose).
 *   gulls              aAnim = (wingbeat phase rad, flap 0..1, fold 0..1, −)
 *     each wing hinges at the shoulder and again at the wrist (the hand lags the arm), gliding
 *     with a slight dihedral; folded, the wings lie along the back and the legs show.
 *
 * Normals are bent with the positions (the flapping wing catches the sun).
 */
import * as THREE from 'three';

export type AnimalKind = 'cetacean' | 'gull' | 'seal';

const CETACEAN = /* glsl */ `
void animalAnimate( inout vec3 p, inout vec3 n ) {
  float s = aBody.x;
  float L = uLength;
  // tail beat: a travelling wave, amplitude growing aft of the mid-body
  float w = max( 0.0, ( s - 0.35 ) / 0.65 );
  float amp = aAnim.y * 0.075 * L * w * w;
  float ph = aAnim.x - 3.2 * s;
  float dy = amp * sin( ph );
  // the slope of the displacement tilts the normal (and the flukes)
  float slope = ( aAnim.y * 0.075 * w * 2.0 / 0.65 ) * sin( ph ) - amp / L * 3.2 * cos( ph );
  // arch: ends down (convex back); tail lift: the tail stock and flukes raised
  float c = 2.0 * s - 1.0;
  dy += -aAnim.z * 0.075 * L * c * c;
  slope += -aAnim.z * 0.075 * 4.0 * c;
  float tl = max( 0.0, ( s - 0.55 ) / 0.45 );
  dy += aAnim.w * 0.22 * L * tl * tl;
  slope += aAnim.w * 0.22 * 2.0 * tl / 0.45;
  p.y += dy;
  n = normalize( n + vec3( 0.0, 0.0, -slope ) * abs( n.y ) );
}`;

const SEAL = /* glsl */ `
void animalAnimate( inout vec3 p, inout vec3 n ) {
  float s = aBody.x;
  float L = uLength;
  // head raised and turned, hind flippers up (the banana pose)
  float head = max( 0.0, ( 0.28 - s ) / 0.28 );
  float lift = aAnim.z;
  p.y += lift * 0.22 * L * head * head;
  float turn = aAnim.w * head * head;
  p.x += turn * 0.12 * L;
  float tail = max( 0.0, ( s - 0.8 ) / 0.2 );
  p.y += aAnim.y * 0.12 * L * tail * tail;
}`;

const GULL = /* glsl */ `
void animalAnimate( inout vec3 p, inout vec3 n ) {
  float part = aBody.y;
  float fold = aAnim.z;
  if ( part > 3.5 ) {
    // legs: tucked into the belly in flight
    p.y = mix( -0.06, p.y, fold );
    return;
  }
  if ( part < 2.5 ) return;
  float side = aBody.w;
  float r = aBody.z;
  float root = 0.045;
  float flap = aAnim.y;
  // the arm: dihedral when gliding, ±38° when flapping; the hand lags and bends further
  float a1 = 0.1 + flap * 0.66 * sin( aAnim.x );
  float a2 = a1 + flap * 0.35 * sin( aAnim.x - 0.9 ) + 0.06;
  float wrist = 0.42 - root;
  float r1 = min( r, wrist );
  float r2 = max( 0.0, r - wrist );
  vec2 q = vec2( r1 * cos( a1 ) + r2 * cos( a2 ), r1 * sin( a1 ) + r2 * sin( a2 ) );
  vec3 flight = vec3( side * ( root + q.x ), p.y + q.y, p.z );
  // folded: the wing lies along the back, tip past the tail
  vec3 folded = vec3( side * ( 0.06 + r * 0.05 ), 0.05 + r * 0.03, p.z + r * 0.62 - 0.08 );
  float a = r2 > 0.0 ? a2 : a1;
  vec3 nf = vec3( -side * sin( a ) * n.y, cos( a ) * n.y, n.z );
  p = mix( flight, folded, fold );
  n = normalize( mix( nf, vec3( side * 0.7, 0.7 * sign( n.y ), 0.0 ), fold ) );
}`;

export interface AnimalMaterialOptions {
  kind: AnimalKind;
  /** Reference length of the model (m). */
  length: number;
  roughness: number;
  name: string;
}

export function createAnimalMaterial(o: AnimalMaterialOptions): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: o.roughness, metalness: 0, envMapIntensity: 1 });
  m.name = o.name;
  const fn = o.kind === 'gull' ? GULL : o.kind === 'seal' ? SEAL : CETACEAN;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uLength = { value: o.length };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec4 aBody;
attribute vec4 aAnim;
uniform float uLength;
${fn}`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
vec3 animalPos = position;
animalAnimate( animalPos, objectNormal );`,
      )
      .replace('#include <begin_vertex>', 'vec3 transformed = animalPos;');
  };
  m.customProgramCacheKey = () => `wildlife-${o.kind}`;
  return m;
}

/**
 * A submerged cetacean seen through the water: the water shader is opaque below ~1 m, so a bow
 * rider or a whale just under the surface would vanish. This pass draws the same animated body
 * pressed flat onto the surface (per-instance `aSurf` = (surface height, lift, fade depth, −)) as
 * a dark, soft shape whose opacity falls with the depth of each point below the surface — after
 * the sea (renderOrder), depth-tested so a hull in front still hides it. Parts above the surface
 * draw nothing (the real mesh is there).
 */
export function createUnderwaterMaterial(o: { length: number; name: string }): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.018, 0.045, 0.055), transparent: true, depthWrite: false });
  m.name = o.name;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uLength = { value: o.length };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec4 aBody;
attribute vec4 aAnim;
attribute vec4 aSurf;
uniform float uLength;
varying float vUnder;
varying float vFade;
${CETACEAN}`,
      )
      .replace('#include <begin_vertex>', `vec3 transformed = position; vec3 nDummy = vec3( 0.0, 1.0, 0.0 ); animalAnimate( transformed, nDummy );`)
      .replace(
        '#include <project_vertex>',
        `vec4 wpos = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
  wpos = instanceMatrix * wpos;
#endif
wpos = modelMatrix * wpos;
vUnder = aSurf.x - wpos.y;
vFade = aSurf.z;
wpos.y = aSurf.x + aSurf.y;
vec4 mvPosition = viewMatrix * wpos;
gl_Position = projectionMatrix * mvPosition;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying float vUnder;
varying float vFade;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
if ( vUnder < 0.02 ) discard;
diffuseColor.a *= 0.5 * exp( - vUnder / vFade ) * smoothstep( 0.02, 0.25, vUnder );`,
      );
  };
  m.customProgramCacheKey = () => 'wildlife-underwater';
  return m;
}
