/**
 * The far level of detail for every vehicle, in ONE instanced draw: a
 * parametric box car (a dark base where the wheels are, the painted body, a
 * glasshouse with sloped screens and a painted roof, and an optional painted
 * or white upper box — a van's cargo area, a truck body, a sleeper cab) whose
 * proportions come per model from uniform tables. Beyond ~300 m a vehicle is a
 * few pixels to a few dozen; the silhouette and colours are what read.
 *
 * Per instance: the model matrix (position, heading, pitch), `aInst` (model id,
 * road kind for the LOD lift, finish, brake), and `instanceColor` (paint, linear).
 */
import * as THREE from 'three';
import { SPECS, SEMI, VT, MODEL_COUNT, MODEL_TRAILER, TRAILER_WHEELBASE } from './specs';
import { DEPTH_GLSL } from '../roads/depth';
import type { CarUniforms } from './material';

/** Shape of one model: length/width, body bottom and top, glasshouse and upper box (z as fractions of the length from the front). */
export interface FarShape {
  L: number;
  W: number;
  clear: number;
  belt: number;
  /** Glasshouse: base front / back (fractions), screen run (fractions), roof height, side inset. */
  a0: number;
  a1: number;
  sf: number;
  sb: number;
  roof: number;
  tumble: number;
  /** Upper box: z range (fractions), bottom and top heights, 1 = white (truck body) instead of paint. */
  b0: number;
  b1: number;
  bBase: number;
  bTop: number;
  bWhite: number;
  /** Model origin (axle midpoint) → body centre, along −z (m). */
  zc: number;
}

const carOrigin = (m: number) => {
  const s = SPECS[m];
  // body centre relative to the axle midpoint (+ = toward the front, i.e. −z)
  return s.length / 2 - s.frontOverhang - s.wheelbase / 2;
};

export const FAR_SHAPES: FarShape[] = (() => {
  const out: FarShape[] = [];
  for (let m = 0; m < MODEL_COUNT; m++) {
    if (m === MODEL_TRAILER) {
      const L = SEMI.trailerRear - SEMI.trailerFront;
      // trailer origin: midway kingpin–axle; its box centre lies back from it
      const back = L / 2 - (SEMI.kingpin - SEMI.trailerFront) - TRAILER_WHEELBASE / 2;
      out.push({ L, W: SEMI.trailerWidth, clear: 1.2, belt: SEMI.trailerHeight, a0: 0, a1: 0, sf: 0, sb: 0, roof: 0, tumble: 0, b0: 0, b1: 0, bBase: 0, bTop: 0, bWhite: 0, zc: -back });
      continue;
    }
    const s = SPECS[m];
    const base = { L: s.length, W: s.width, zc: carOrigin(m) };
    switch (m) {
      case VT.sedan:
        out.push({ ...base, clear: 0.28, belt: 0.92, a0: 0.36, a1: 0.83, sf: 0.15, sb: 0.13, roof: 1.44, tumble: 0.16, b0: 0, b1: 0, bBase: 0, bTop: 0, bWhite: 0 });
        break;
      case VT.hatch:
        out.push({ ...base, clear: 0.27, belt: 0.93, a0: 0.33, a1: 0.98, sf: 0.17, sb: 0.1, roof: 1.46, tumble: 0.15, b0: 0, b1: 0, bBase: 0, bTop: 0, bWhite: 0 });
        break;
      case VT.suv:
        out.push({ ...base, clear: 0.36, belt: 1.08, a0: 0.32, a1: 0.97, sf: 0.14, sb: 0.04, roof: 1.72, tumble: 0.13, b0: 0, b1: 0, bBase: 0, bTop: 0, bWhite: 0 });
        break;
      case VT.pickup:
        out.push({ ...base, clear: 0.44, belt: 1.2, a0: 0.33, a1: 0.64, sf: 0.1, sb: 0.02, roof: 1.9, tumble: 0.12, b0: 0, b1: 0, bBase: 0, bTop: 0, bWhite: 0 });
        break;
      case VT.van:
        out.push({ ...base, clear: 0.36, belt: 1.12, a0: 0.2, a1: 0.42, sf: 0.15, sb: 0, roof: 2.4, tumble: 0.08, b0: 0.42, b1: 1, bBase: 1.1, bTop: 2.45, bWhite: 0 });
        break;
      case VT.box:
        out.push({ ...base, clear: 0.6, belt: 1.4, a0: 0.12, a1: 0.28, sf: 0.07, sb: 0, roof: 2.75, tumble: 0.1, b0: 0.32, b1: 1, bBase: 1.02, bTop: s.height, bWhite: 1 });
        break;
      case VT.semi: {
        // the tractor unit only (6.3 m); the sleeper is the upper box
        const L = 6.3;
        out.push({ L, W: s.width, zc: L / 2 - s.frontOverhang - s.wheelbase / 2, clear: 0.75, belt: 1.62, a0: 0.33, a1: 0.52, sf: 0.05, sb: 0, roof: 3.0, tumble: 0.14, b0: 0.52, b1: 0.77, bBase: 1.6, bTop: 4.0, bWhite: 0 });
        break;
      }
      case VT.bus:
        out.push({ ...base, clear: 0.42, belt: 1.18, a0: 0, a1: 1, sf: 0.01, sb: 0.01, roof: s.height, tumble: 0.03, b0: 0, b1: 0, bBase: 0, bTop: 0, bWhite: 0 });
        break;
      case VT.tractor:
      default:
        out.push({ ...base, clear: 0.55, belt: 1.5, a0: 0.45, a1: 0.9, sf: 0, sb: 0, roof: 2.9, tumble: 0.75, b0: 0, b1: 0, bBase: 0, bTop: 0, bWhite: 0 });
        break;
    }
  }
  return out;
})();

/**
 * The template: per vertex `aT` = (x sign, y level, z level, part) and `aK` =
 * colour kind (0 paint, 1 glass, 2 dark, 3 white box); normals are fixed per
 * face (the screens' are computed in the shader: normal.y = 2 front, 3 back).
 */
export function farTemplate(): THREE.BufferGeometry {
  const T: number[] = [];
  const K: number[] = [];
  const N: number[] = [];
  const idx: number[] = [];
  const v = (xs: number, yi: number, zi: number, part: number, k: number, n: [number, number, number]) => {
    T.push(xs, yi, zi, part);
    K.push(k);
    N.push(n[0], n[1], n[2]);
    return T.length / 4 - 1;
  };
  // a quad of four (xs, yi, zi) corners, wound CCW seen from outside (the caller orders them)
  const quad = (part: number, k: number, n: [number, number, number], c: [number, number, number][]) => {
    const i = c.map((p) => v(p[0], p[1], p[2], part, k, n));
    idx.push(i[0], i[1], i[2], i[0], i[2], i[3]);
  };
  // box-like part: y levels 0..1, z levels z0..z1 (for the glasshouse the roof z levels are 1..2)
  const boxPart = (part: number, kSide: number, kTop: number, kFront: number, kBack: number, zb0: number, zb1: number, zt0: number, zt1: number, bottom: boolean) => {
    // right side (+x): corners (bottom front, bottom back, top back, top front)
    quad(part, kSide, [1, 0, 0], [
      [1, 0, zb0],
      [1, 1, zt0],
      [1, 1, zt1],
      [1, 0, zb1],
    ]);
    quad(part, kSide, [-1, 0, 0], [
      [-1, 0, zb0],
      [-1, 0, zb1],
      [-1, 1, zt1],
      [-1, 1, zt0],
    ]);
    quad(part, kTop, [0, 1, 0], [
      [-1, 1, zt0],
      [-1, 1, zt1],
      [1, 1, zt1],
      [1, 1, zt0],
    ]);
    quad(part, kFront, part === 2 ? [0, 2, 0] : [0, 0, -1], [
      [-1, 0, zb0],
      [-1, 1, zt0],
      [1, 1, zt0],
      [1, 0, zb0],
    ]);
    quad(part, kBack, part === 2 ? [0, 3, 0] : [0, 0, 1], [
      [-1, 0, zb1],
      [1, 0, zb1],
      [1, 1, zt1],
      [-1, 1, zt1],
    ]);
    if (bottom)
      quad(part, 2, [0, -1, 0], [
        [-1, 0, zb0],
        [1, 0, zb0],
        [1, 0, zb1],
        [-1, 0, zb1],
      ]);
  };
  boxPart(0, 2, 2, 2, 2, 0, 1, 0, 1, false); // dark base (wheels, underbody)
  boxPart(1, 0, 0, 0, 0, 0, 1, 0, 1, false); // painted body
  boxPart(2, 1, 0, 1, 1, 0, 3, 1, 2, false); // glasshouse: glass sides and screens, painted roof
  boxPart(3, 0, 0, 0, 0, 0, 1, 0, 1, false); // upper box (paint or white)
  const g = new THREE.BufferGeometry();
  // three needs a position attribute (count + bounds): the template's own codes serve
  g.setAttribute('position', new THREE.Float32BufferAttribute(T.length === 0 ? [] : T.filter((_, i) => i % 4 !== 3), 3));
  g.setAttribute('aT', new THREE.Float32BufferAttribute(T, 4));
  g.setAttribute('aK', new THREE.Float32BufferAttribute(K, 1));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  return g;
}

/** Uniform tables (4 vec4 per model). */
export function farTables(): THREE.Vector4[][] {
  const A: THREE.Vector4[] = [];
  const B: THREE.Vector4[] = [];
  const C: THREE.Vector4[] = [];
  const D: THREE.Vector4[] = [];
  for (const s of FAR_SHAPES) {
    A.push(new THREE.Vector4(s.L, s.W, s.clear, s.belt));
    B.push(new THREE.Vector4(s.a0, s.a1, s.roof, s.tumble));
    C.push(new THREE.Vector4(s.sf, s.sb, s.b0, s.b1));
    D.push(new THREE.Vector4(s.bBase, s.bTop, s.bWhite, s.zc));
  }
  return [A, B, C, D];
}

export function createFarMaterial(u: CarUniforms): THREE.MeshStandardMaterial {
  const [A, B, C, D] = farTables();
  const m = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0, fog: true });
  m.name = 'cars-far';
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uFarA = { value: A };
    shader.uniforms.uFarB = { value: B };
    shader.uniforms.uFarC = { value: C };
    shader.uniforms.uFarD = { value: D };
    shader.uniforms.uLodLift = u.uLodLift;
    shader.uniforms.uDepthPull = u.uDepthPull;
    shader.uniforms.uLights = u.uLights;
    const n = MODEL_COUNT;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
attribute vec4 aT;
attribute float aK;
attribute vec4 aInst;
uniform vec4 uFarA[ ${n} ];
uniform vec4 uFarB[ ${n} ];
uniform vec4 uFarC[ ${n} ];
uniform vec4 uFarD[ ${n} ];
varying vec3 vFarCol;
varying vec2 vFarMat;
${DEPTH_GLSL}
vec3 farPos;
vec3 farNrm;`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        /* glsl */ `{
  int mi = int( aInst.x + 0.5 );
  vec4 A = uFarA[ mi ];
  vec4 B = uFarB[ mi ];
  vec4 C = uFarC[ mi ];
  vec4 D = uFarD[ mi ];
  float L = A.x;
  float hw = A.y * 0.5;
  float part = aT.w;
  float zf;
  vec3 p;
  if ( part < 0.5 ) {
    zf = aT.z < 0.5 ? 0.05 : 0.95;
    p = vec3( aT.x * ( hw - 0.07 ), aT.y < 0.5 ? 0.02 : A.z + 0.06, zf * L );
  } else if ( part < 1.5 ) {
    p = vec3( aT.x * hw, aT.y < 0.5 ? A.z : A.w, aT.z * L );
  } else if ( part < 2.5 ) {
    float zl = aT.z < 0.5 ? B.x : aT.z < 1.5 ? B.x + C.x : aT.z < 2.5 ? B.y - C.y : B.y;
    float inset = aT.y < 0.5 ? 0.04 : B.w;
    p = vec3( aT.x * max( 0.05, hw - inset ), aT.y < 0.5 ? A.w : B.z, zl * L );
    if ( B.y <= B.x ) p = vec3( 0.0, A.w, 0.5 * L );
  } else {
    p = vec3( aT.x * ( hw - 0.03 ), aT.y < 0.5 ? D.x : D.y, ( aT.z < 0.5 ? C.z : C.w ) * L );
    if ( C.w <= C.z ) p = vec3( 0.0, A.w, 0.5 * L );
  }
  // front at −z, origin at the axle midpoint (the body centre is D.w ahead of it)
  farPos = vec3( p.x, p.y, p.z - 0.5 * L - D.w );
  farNrm = normal;
  if ( normal.y > 1.5 ) {
    float rise = ( normal.y < 2.5 ? B.z - A.w : B.z - A.w );
    float run = ( normal.y < 2.5 ? C.x : C.y ) * L;
    farNrm = normal.y < 2.5 ? normalize( vec3( 0.0, run, -rise ) ) : normalize( vec3( 0.0, run, rise ) );
  }
  // colour: paint, glass, dark, white box (C.w/D.z: the upper box is white)
  float k = aK;
  if ( part > 2.5 && D.z > 0.5 ) k = 3.0;
  vFarCol = k < 0.5 ? instanceColor : k < 1.5 ? vec3( 0.006, 0.008, 0.01 ) : k < 2.5 ? vec3( 0.012 ) : vec3( 0.78, 0.78, 0.76 );
  vFarMat = vec2( k < 0.5 ? ( aInst.z > 1.5 ? 0.28 : 0.38 ) : k < 1.5 ? 0.08 : k < 2.5 ? 0.9 : 0.55, k < 0.5 ? ( aInst.z < 0.5 ? 0.0 : aInst.z < 1.5 ? 0.2 : 0.45 ) : 0.0 );
}
vec3 objectNormal = farNrm;
#ifdef USE_TANGENT
  vec3 objectTangent = vec3( 1.0, 0.0, 0.0 );
#endif`,
      )
      .replace('#include <begin_vertex>', 'vec3 transformed = farPos;')
      .replace(
        '#include <project_vertex>',
        /* glsl */ `vec4 cWorld = modelMatrix * instanceMatrix * vec4( transformed, 1.0 );
cWorld.y += roadLodLift( aInst.y, distance( cWorld.xyz, cameraPosition ) );
vec4 mvPosition = viewMatrix * cWorld;
gl_Position = projectionMatrix * roadPull( mvPosition );`,
      )
      .replace('#include <color_vertex>', '');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFarCol;\nvarying vec2 vFarMat;')
      .replace('#include <color_fragment>', 'diffuseColor.rgb = vFarCol;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vFarMat.x;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vFarMat.y;');
  };
  m.customProgramCacheKey = () => 'cars-far-v1';
  return m;
}
