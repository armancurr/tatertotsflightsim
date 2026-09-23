/**
 * Daylight inside the 172RG cabin. The sun's shadow map is far too coarse for the cabin (15 cm
 * texels), so without help the sun would light the seats and the panel straight through the roof.
 * Instead every interior material asks, per fragment, where a ray toward the sun leaves the cabin:
 * through the windshield, a side or rear window (sunlit, unless the high wing or the glareshield is
 * in the way) or through the roof, floor, firewall or a post (shade). The sky light is scaled the
 * same way, so surfaces that face a window get more of it than the floor under the panel.
 *
 * The cabin is a box with the real window outlines (body frame, metres): side walls at
 * |x| = SIDE_X, roof, floor, the sloped windshield plane, the sloped rear window plane. The same
 * maths is here twice — `cabinSunVisibility` (TypeScript, for tests) and `CABIN_LIGHT_GLSL` — built
 * from one set of constants.
 */
import * as THREE from 'three';
import { DOOR_WINDOW, PILLAR, REAR_SIDE_WINDOW, REAR_WINDOW } from './shape';

export const CABIN_BOX = {
  sideX: 0.525,
  roofY: 0.93,
  floorY: -0.44,
  firewallZ: -1.25,
  bulkheadZ: 2.0,
  /** Windshield plane in side view: y = y0 + k (z − z0). */
  windshield: { z0: -1.25, y0: 0.26, k: 0.943, halfWidth: 0.43 },
  /** Rear window plane: y = y0 − k (z − z0), glazed between REAR_WINDOW.z0 and z1, |x| < halfWidth. */
  rear: { z0: 1.1, y0: 0.93, k: 0.318, halfWidth: 0.33 },
  /** Wing underside over the cabin (height, chord z range, semi-span). */
  wing: { y: 0.96, z0: -0.55, z1: 1.08, halfSpan: 5.4 },
  /** Glareshield lip (the panel and the shroud shade everything behind and below it). */
  lip: { z: -0.678, y: 0.458, halfWidth: 0.5 },
  /** Soft edge (m) of every window and shadow boundary. */
  edge: 0.015,
} as const;

type Poly = ReadonlyArray<readonly [number, number]>;
interface Edge {
  nz: number;
  ny: number;
  c: number;
}
/** Inward unit normals of a convex polygon's edges: signed distance = min(nz·z + ny·y + c), positive inside. */
function edges(poly: Poly): Edge[] {
  let cz = 0;
  let cy = 0;
  for (const [z, y] of poly) {
    cz += z / poly.length;
    cy += y / poly.length;
  }
  return poly.map((a, i) => {
    const b = poly[(i + 1) % poly.length];
    const dz = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = Math.hypot(dz, dy);
    let nz = -dy / l;
    let ny = dz / l;
    if (nz * (cz - a[0]) + ny * (cy - a[1]) < 0) {
      nz = -nz;
      ny = -ny;
    }
    return { nz, ny, c: -(nz * a[0] + ny * a[1]) };
  });
}
const DOOR_E = edges(DOOR_WINDOW);
const REAR_SIDE_E = edges(REAR_SIDE_WINDOW);
const PK = (PILLAR.y1 - PILLAR.y0) / (PILLAR.z1 - PILLAR.z0);
const PILLAR_COS = 1 / Math.hypot(1, 1 / PK);

const polyDist = (E: Edge[], z: number, y: number) => {
  let d = Infinity;
  for (const e of E) d = Math.min(d, e.nz * z + e.ny * y + e.c);
  return d;
};
const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const soft = (d: number) => smooth(-CABIN_BOX.edge, CABIN_BOX.edge, d);

/**
 * Fraction (0 shade … 1 sunlit) of direct sunlight reaching body point p inside the cabin from
 * direction s (unit, toward the sun, body frame). Always finite; points outside the cabin box are
 * treated as sunlit.
 */
export function cabinSunVisibility(p: { x: number; y: number; z: number }, s: { x: number; y: number; z: number }): number {
  const B = CABIN_BOX;
  const len = Math.hypot(s.x, s.y, s.z);
  if (!(len > 1e-6) || !Number.isFinite(len) || ![p.x, p.y, p.z].every(Number.isFinite)) return 1;
  const sx = s.x / len;
  const sy = s.y / len;
  const sz = s.z / len;
  const BIG = 1e6;
  // Exit distance through each boundary (only boundaries the ray moves toward).
  const tSide = sx > 1e-5 ? (B.sideX - p.x) / sx : sx < -1e-5 ? (-B.sideX - p.x) / sx : BIG;
  const tRoof = sy > 1e-5 ? (B.roofY - p.y) / sy : BIG;
  const tFloor = sy < -1e-5 ? (B.floorY - p.y) / sy : BIG;
  const tFire = sz < -1e-5 ? (B.firewallZ - p.z) / sz : BIG;
  const tBulk = sz > 1e-5 ? (B.bulkheadZ - p.z) / sz : BIG;
  const W = B.windshield;
  const fW = p.y - W.y0 - W.k * (p.z - W.z0);
  const gW = sy - W.k * sz;
  const tWind = gW > 1e-5 ? -fW / gW : BIG;
  const R = B.rear;
  const fR = p.y - R.y0 + R.k * (p.z - R.z0);
  const gR = sy + R.k * sz;
  const tRear = gR > 1e-5 ? -fR / gR : BIG;
  let t = Math.min(tSide, tRoof, tFloor, tFire, tBulk, tWind, tRear);
  if (!(t < BIG)) return 1;
  t = Math.max(0, t);
  const ex = p.x + sx * t;
  const ey = p.y + sy * t;
  const ez = p.z + sz * t;
  let vis = 0;
  if (t === Math.max(0, tSide)) {
    // Side wall: the windshield's wrap-round, the door window or the rear side window.
    const shield = Math.min((ey - (PILLAR.y0 + PK * (ez - PILLAR.z0))) * PILLAR_COS, -0.5 - ez);
    vis = soft(Math.max(shield, polyDist(DOOR_E, ez, ey), polyDist(REAR_SIDE_E, ez, ey)));
    // The high wing overhead shades a ray that climbs out of a side window.
    if (vis > 0 && sy > 1e-5) {
      const tw = (B.wing.y - p.y) / sy;
      const wz = p.z + sz * tw;
      const wx = Math.abs(p.x + sx * tw);
      const under = Math.min(wz - B.wing.z0, B.wing.z1 - wz, B.wing.halfSpan - wx);
      vis *= 1 - soft(under);
    }
  } else if (t === Math.max(0, tWind)) {
    vis = soft(W.halfWidth - Math.abs(ex));
  } else if (t === Math.max(0, tRear)) {
    vis = soft(Math.min(ez - REAR_WINDOW.z0, REAR_WINDOW.z1 - ez, R.halfWidth - Math.abs(ex)));
  }
  // The glareshield and panel shade whatever sits behind and below the lip.
  if (vis > 0 && sz < -1e-5 && p.z > B.lip.z && p.y < B.lip.y) {
    const tl = (B.lip.z - p.z) / sz;
    const ly = p.y + sy * tl;
    const lx = Math.abs(p.x + sx * tl);
    vis *= 1 - soft(Math.min(B.lip.y - ly, B.lip.halfWidth - lx));
  }
  return Math.max(0, Math.min(1, vis));
}

// ─── GLSL (same maths) ─────────────────────────────────────────────────────

const f = (x: number) => {
  const s = x.toFixed(6);
  return s.includes('.') ? s : `${s}.0`;
};
const polyGlsl = (E: Edge[]) => E.map((e) => `dot(vec2(${f(e.nz)}, ${f(e.ny)}), q) + ${f(e.c)}`).reduce((a, b) => `min(${a}, ${b})`);

export const CABIN_LIGHT_GLSL = /* glsl */ `
uniform mat4 uCabinBodyFromWorld;
varying vec3 vCabinP;
float cabSoft(float d) { return smoothstep(${f(-CABIN_BOX.edge)}, ${f(CABIN_BOX.edge)}, d); }
float cabinVis(vec3 p, vec3 s) {
  const float BIG = 1e6;
  float tSide = s.x > 1e-5 ? (${f(CABIN_BOX.sideX)} - p.x) / s.x : (s.x < -1e-5 ? (${f(-CABIN_BOX.sideX)} - p.x) / s.x : BIG);
  float tRoof = s.y > 1e-5 ? (${f(CABIN_BOX.roofY)} - p.y) / s.y : BIG;
  float tFloor = s.y < -1e-5 ? (${f(CABIN_BOX.floorY)} - p.y) / s.y : BIG;
  float tFire = s.z < -1e-5 ? (${f(CABIN_BOX.firewallZ)} - p.z) / s.z : BIG;
  float tBulk = s.z > 1e-5 ? (${f(CABIN_BOX.bulkheadZ)} - p.z) / s.z : BIG;
  float fW = p.y - ${f(CABIN_BOX.windshield.y0)} - ${f(CABIN_BOX.windshield.k)} * (p.z - ${f(CABIN_BOX.windshield.z0)});
  float gW = s.y - ${f(CABIN_BOX.windshield.k)} * s.z;
  float tWind = gW > 1e-5 ? -fW / gW : BIG;
  float fR = p.y - ${f(CABIN_BOX.rear.y0)} + ${f(CABIN_BOX.rear.k)} * (p.z - ${f(CABIN_BOX.rear.z0)});
  float gR = s.y + ${f(CABIN_BOX.rear.k)} * s.z;
  float tRear = gR > 1e-5 ? -fR / gR : BIG;
  float t = min(min(min(tSide, tRoof), min(tFloor, tFire)), min(min(tBulk, tWind), tRear));
  if (t >= BIG) return 1.0;
  t = max(t, 0.0);
  vec3 e = p + s * t;
  float vis = 0.0;
  if (t == max(tSide, 0.0)) {
    vec2 q = vec2(e.z, e.y);
    float shield = min((e.y - (${f(PILLAR.y0)} + ${f(PK)} * (e.z - ${f(PILLAR.z0)}))) * ${f(PILLAR_COS)}, -0.5 - e.z);
    float door = ${polyGlsl(DOOR_E)};
    float rearSide = ${polyGlsl(REAR_SIDE_E)};
    vis = cabSoft(max(shield, max(door, rearSide)));
    if (vis > 0.0 && s.y > 1e-5) {
      float tw = (${f(CABIN_BOX.wing.y)} - p.y) / s.y;
      float wz = p.z + s.z * tw;
      float wx = abs(p.x + s.x * tw);
      float under = min(min(wz - ${f(CABIN_BOX.wing.z0)}, ${f(CABIN_BOX.wing.z1)} - wz), ${f(CABIN_BOX.wing.halfSpan)} - wx);
      vis *= 1.0 - cabSoft(under);
    }
  } else if (t == max(tWind, 0.0)) {
    vis = cabSoft(${f(CABIN_BOX.windshield.halfWidth)} - abs(e.x));
  } else if (t == max(tRear, 0.0)) {
    vis = cabSoft(min(min(e.z - ${f(REAR_WINDOW.z0)}, ${f(REAR_WINDOW.z1)} - e.z), ${f(CABIN_BOX.rear.halfWidth)} - abs(e.x)));
  }
  if (vis > 0.0 && s.z < -1e-5 && p.z > ${f(CABIN_BOX.lip.z)} && p.y < ${f(CABIN_BOX.lip.y)}) {
    float tl = (${f(CABIN_BOX.lip.z)} - p.z) / s.z;
    float ly = p.y + s.y * tl;
    float lx = abs(p.x + s.x * tl);
    vis *= 1.0 - cabSoft(min(${f(CABIN_BOX.lip.y)} - ly, ${f(CABIN_BOX.lip.halfWidth)} - lx));
  }
  return clamp(vis, 0.0, 1.0);
}
vec3 cabToBody(vec3 viewDir) { return normalize(mat3(uCabinBodyFromWorld) * inverseTransformDirection(viewDir, viewMatrix)); }
`;

export interface CabinLight {
  /** Body-from-world matrix of the aircraft (shared uniform of every interior material). */
  bodyFromWorld: { value: THREE.Matrix4 };
  /** Patch an interior material (chains any existing onBeforeCompile). */
  apply<T extends THREE.MeshStandardMaterial>(m: T): T;
  /** Keep the uniform on the aircraft's pose: call from an interior mesh's onBeforeRender. */
  update(root: THREE.Object3D): void;
}

/**
 * Ambient in the cabin: sky light arrives only through the glass. `floor` is the share that
 * reaches a surface facing solid trim (bounce light), the rest scales with a window test along
 * the surface normal tilted toward the sky.
 */
export const CABIN_SKY = { floor: 0.38, tiltUp: 0.6, specularFloor: 0.25 } as const;

export function createCabinLight(): CabinLight {
  const bodyFromWorld = { value: new THREE.Matrix4() };
  return {
    bodyFromWorld,
    apply(m) {
      const prev = m.onBeforeCompile;
      const prevKey = m.customProgramCacheKey.bind(m);
      m.onBeforeCompile = (shader, renderer) => {
        prev.call(m, shader, renderer);
        shader.uniforms.uCabinBodyFromWorld = bodyFromWorld;
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nuniform mat4 uCabinBodyFromWorld;\nvarying vec3 vCabinP;')
          .replace('#include <project_vertex>', '#include <project_vertex>\nvCabinP = (uCabinBodyFromWorld * modelMatrix * vec4(transformed, 1.0)).xyz;');
        const begin = THREE.ShaderChunk.lights_fragment_begin.replace(
          'getDirectionalLightInfo( directionalLight, directLight );',
          'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= cabinVis( vCabinP, cabToBody( directLight.direction ) );',
        );
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\n' + CABIN_LIGHT_GLSL)
          .replace('#include <lights_fragment_begin>', begin)
          .replace(
            '#include <lights_fragment_maps>',
            `#include <lights_fragment_maps>
{
  vec3 cabN = cabToBody( geometryNormal );
  float cabSky = ${f(CABIN_SKY.floor)} + ${f(1 - CABIN_SKY.floor)} * cabinVis( vCabinP, normalize( cabN + vec3( 0.0, ${f(CABIN_SKY.tiltUp)}, 0.0 ) ) );
  #if defined( RE_IndirectDiffuse )
  irradiance *= cabSky;
  iblIrradiance *= cabSky;
  #endif
  #if defined( RE_IndirectSpecular )
  radiance *= mix( ${f(CABIN_SKY.specularFloor)}, 1.0, cabinVis( vCabinP, cabToBody( reflect( -geometryViewDir, geometryNormal ) ) ) );
  #endif
}`,
          );
      };
      m.customProgramCacheKey = () => prevKey() + '|cabinLight';
      return m;
    },
    update(root) {
      bodyFromWorld.value.copy(root.matrixWorld).invert();
    },
  };
}
