/**
 * Reeds and rushes at the water's edge: patchy stands along the slow lowland
 * reaches of the river (thicker on the inner, slack-water side of bends) and
 * round the lowland lakes — none in the rapids, the mountains or round the
 * alpine tarn. Placement is PURE (placeReeds, deterministic hashes); drawing
 * is one InstancedBufferGeometry per ~1.5 km chunk (frustum + distance culled)
 * of four crossed quads per clump, the blades cut procedurally in the fragment
 * shader (alpha test / alpha-to-coverage), swaying in the wind, fading out
 * with distance. MeshStandardMaterial + onBeforeCompile, `fog: true`.
 */
import * as THREE from 'three';
import type { WorldLayout } from '../layout';
import { bendStrength, riverTurbidity, smoothstep } from './shading';

/** Per clump: x, y (base), z, height (m), rotation (rad), tint 0..1. */
export const REED_STRIDE = 6;

export interface ReedChunk {
  start: number;
  count: number;
  /** Bounding circle of the chunk's clumps (xz) and base height range. */
  x: number;
  z: number;
  radius: number;
  y0: number;
  y1: number;
}

export interface ReedPlacement {
  count: number;
  data: Float32Array;
  chunks: ReedChunk[];
}

export interface ReedOptions {
  /** Distance between candidate clumps along a bank (m). */
  spacing: number;
  rapidsSlope: number;
  coastZAt(x: number): number;
  /** Chunk size (m). */
  chunk?: number;
}

/** 0..1 hash of two integers and a salt. */
function hash(a: number, b: number, salt: number): number {
  let h = (Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(salt | 0, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth 1D value noise (patchy stands along a bank). */
function noise1(x: number, salt: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash(i, 0, salt) * (1 - u) + hash(i + 1, 0, salt) * u;
}

export function placeReeds(L: WorldLayout, o: ReedOptions): ReedPlacement {
  const out: number[] = [];
  const push = (x: number, y: number, z: number, k: number, salt: number) => {
    out.push(x, y, z, 1.3 + 1.2 * hash(k, 1, salt), hash(k, 2, salt) * Math.PI * 2, hash(k, 3, salt));
  };
  const sp = Math.max(0.5, o.spacing);
  // ── river banks ──
  L.rivers.forEach((rv, ri) => {
    const P = rv.points;
    const N = P.length;
    if (N < 2) return;
    const S = new Float64Array(N);
    for (let i = 1; i < N; i++) S[i] = S[i - 1] + Math.hypot(P[i].x - P[i - 1].x, P[i].z - P[i - 1].z);
    const total = S[N - 1] || 1;
    // across-channel normals smoothed like the water ribbon's (river.ts), so the stands follow its edges
    const NX = new Float64Array(N);
    const NZ = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const kT = Math.max(1, Math.round((rv.halfWidths[i] + 3) / 15));
      const a = P[Math.max(0, i - kT)];
      const b = P[Math.min(N - 1, i + kT)];
      const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      NX[i] = -(b.z - a.z) / l;
      NZ[i] = (b.x - a.x) / l;
    }
    let k = 0;
    for (let i = 0; i < N - 1; i++) {
      const a = P[i];
      const b = P[i + 1];
      if (b.z > o.coastZAt(b.x) - 300) break; // the estuary: beach and surf, not reeds
      const i0 = Math.max(0, i - 3);
      const i1 = Math.min(N - 1, i + 3);
      const slope = S[i1] > S[i0] ? Math.max(0, (rv.levels[i0] - rv.levels[i1]) / (S[i1] - S[i0])) : 0;
      if (slope > o.rapidsSlope * 2) continue;
      const lowland = riverTurbidity(S[i] / total, slope, o.rapidsSlope);
      if (lowland < 0.35) continue;
      const seg = S[i + 1] - S[i];
      if (seg <= 0) continue;
      // curvature → inner bank (slack water) gets more reeds
      const c = P[Math.min(N - 1, i + 2)];
      const p = P[Math.max(0, i - 1)];
      const cr = ((a.x - p.x) * (c.z - a.z) - (a.z - p.z) * (c.x - a.x)) / Math.max(1, Math.hypot(a.x - p.x, a.z - p.z) * Math.hypot(c.x - a.x, c.z - a.z));
      const bend = bendStrength(cr / 60, rv.halfWidths[i]);
      const steps = Math.max(1, Math.round(seg / sp));
      for (let s = 0; s < steps; s++, k++) {
        const f = (s + hash(k, 4, ri)) / steps;
        const x = a.x + (b.x - a.x) * f;
        const z = a.z + (b.z - a.z) * f;
        const along = S[i] + seg * f;
        const hw = rv.halfWidths[i] + (rv.halfWidths[i + 1] - rv.halfWidths[i]) * f;
        const y = rv.levels[i] + (rv.levels[i + 1] - rv.levels[i]) * f - 0.25;
        for (const sg of [-1, 1]) {
          // stands come and go along the bank; the inner bank of a bend (bend·side > 0) is favoured
          const stand = noise1(along / 45, ri * 7 + (sg > 0 ? 1 : 2)) + 0.25 * bend * sg - 0.35 * smoothstep(0.3, 1.5, slope / o.rapidsSlope);
          if (stand < 0.52) continue;
          if (hash(k, sg > 0 ? 5 : 6, ri) > 0.8) continue;
          const off = hw - 1.2 + 2.6 * hash(k, sg > 0 ? 7 : 8, ri);
          let nx = NX[i] + (NX[i + 1] - NX[i]) * f;
          let nz = NZ[i] + (NZ[i + 1] - NZ[i]) * f;
          const nl = Math.hypot(nx, nz) || 1;
          nx /= nl;
          nz /= nl;
          const rx = x + nx * off * sg;
          const rz = z + nz * off * sg;
          // on a kink of the centreline the offset point can land in the water: keep it only at the bank
          let dmin = Infinity;
          for (let j = Math.max(0, i - 4); j < Math.min(N - 1, i + 5); j++) {
            const p0 = P[j];
            const p1 = P[j + 1];
            const ux = p1.x - p0.x;
            const uz = p1.z - p0.z;
            const t = Math.max(0, Math.min(1, ((rx - p0.x) * ux + (rz - p0.z) * uz) / (ux * ux + uz * uz || 1)));
            dmin = Math.min(dmin, Math.hypot(rx - p0.x - ux * t, rz - p0.z - uz * t));
          }
          if (Math.abs(dmin - hw) > 3) continue;
          push(rx, y, rz, k * 2 + (sg > 0 ? 1 : 0), 11 + ri);
        }
      }
    }
  });
  // ── lake shores (lowland lakes only) ──
  L.lakes.forEach((lk, li) => {
    if (lk.level > 500) return;
    const sh = lk.shoreline;
    const n = sh.length;
    let k = 0;
    let along = 0;
    for (let i = 0; i < n; i++) {
      const a = sh[i];
      const b = sh[(i + 1) % n];
      const seg = Math.hypot(b.x - a.x, b.z - a.z);
      const steps = Math.max(1, Math.round(seg / sp));
      for (let s = 0; s < steps; s++, k++) {
        const f = (s + hash(k, 4, 90 + li)) / steps;
        const x = a.x + (b.x - a.x) * f;
        const z = a.z + (b.z - a.z) * f;
        const stand = noise1((along + seg * f) / 60, 90 + li);
        if (stand < 0.45 || hash(k, 5, 90 + li) > 0.8) continue;
        // a few metres into the water, toward the centre
        const dx = lk.center.x - x;
        const dz = lk.center.z - z;
        const d = Math.hypot(dx, dz) || 1;
        const off = -1 + 4 * hash(k, 7, 90 + li);
        push(x + (dx / d) * off, lk.level - 0.25, z + (dz / d) * off, k, 40 + li);
      }
      along += seg;
    }
  });

  // ── chunks: sort clumps into a grid of cells ──
  const size = o.chunk ?? 1500;
  const count = out.length / REED_STRIDE;
  const cells = new Map<string, number[]>();
  for (let k = 0; k < count; k++) {
    const key = `${Math.floor(out[k * REED_STRIDE] / size)},${Math.floor(out[k * REED_STRIDE + 2] / size)}`;
    let c = cells.get(key);
    if (!c) cells.set(key, (c = []));
    c.push(k);
  }
  const data = new Float32Array(count * REED_STRIDE);
  const chunks: ReedChunk[] = [];
  let at = 0;
  for (const ks of cells.values()) {
    let cx = 0;
    let cz = 0;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const k of ks) {
      cx += out[k * REED_STRIDE];
      cz += out[k * REED_STRIDE + 2];
    }
    cx /= ks.length;
    cz /= ks.length;
    let r = 0;
    const start = at;
    for (const k of ks) {
      for (let j = 0; j < REED_STRIDE; j++) data[at * REED_STRIDE + j] = out[k * REED_STRIDE + j];
      r = Math.max(r, Math.hypot(out[k * REED_STRIDE] - cx, out[k * REED_STRIDE + 2] - cz));
      y0 = Math.min(y0, out[k * REED_STRIDE + 1]);
      y1 = Math.max(y1, out[k * REED_STRIDE + 1]);
      at++;
    }
    chunks.push({ start, count: ks.length, x: cx, z: cz, radius: r + 1e-3, y0, y1 });
  }
  return { count, data, chunks };
}

// ── drawing ──────────────────────────────────────────────────────────────────

const REED_VERTEX_PARS = /* glsl */ `
attribute vec4 aReed;   // x, y, z (base), height
attribute vec2 aReed2;  // rotation, tint
uniform float uReedTime;
uniform float uReedFar;
varying vec2 vReedUv;
varying float vReedTint;
varying float vReedDist;
`;

const REED_BEGIN_VERTEX = /* glsl */ `
{
  float c = cos( aReed2.x );
  float s = sin( aReed2.x );
  vec3 p = position;                     // quad in a unit clump: x, z in ±0.6, y in 0..1
  p.y *= aReed.w;
  // sway: tips move most, gusts roll along the bank
  float ph = uReedTime * 1.6 + aReed.x * 0.11 + aReed.z * 0.07;
  float sway = ( sin( ph ) * 0.6 + sin( ph * 2.3 + 1.7 ) * 0.25 ) * 0.09 * uv.y * uv.y * aReed.w;
  p.x += sway;
  p.z += sway * 0.4;
  vec3 world = vec3( c * p.x - s * p.z, p.y, s * p.x + c * p.z ) + aReed.xyz;
  vReedDist = distance( world, cameraPosition );
  // shrink away far out (the chunk is culled beyond uReedFar anyway)
  float keep = 1.0 - smoothstep( uReedFar * 0.7, uReedFar, vReedDist );
  world = mix( aReed.xyz, world, keep );
  transformed = world;
  vReedUv = uv;
  vReedTint = aReed2.y;
}
`;

const REED_FRAGMENT_PARS = /* glsl */ `
varying vec2 vReedUv;
varying float vReedTint;
varying float vReedDist;
float rHash( float n ) { return fract( sin( n * 91.3458 ) * 47453.5453 ); }
// one layer of blades: coverage at uv, blade id out
float rBlades( vec2 uv, float n, float seed, float widen, out float id, out float top ) {
  float x = uv.x * n;
  id = floor( x );
  float h = 0.5 + 0.5 * rHash( id + seed );
  top = h;
  float lean = ( rHash( id * 1.37 + seed ) - 0.5 ) * 1.4;
  float cx = id + 0.5 + ( rHash( id * 2.11 + seed ) - 0.5 ) * 0.5 + lean * uv.y * uv.y;
  float w = 0.18 * ( 1.0 - uv.y / h ) * widen;
  return step( abs( x - cx ), w ) * step( uv.y, h );
}
`;

const REED_MAP_FRAGMENT = /* glsl */ `
{
  float widen = 1.0 + vReedDist / 120.0;   // far away the stand reads as a tuft, not sparkle
  float id1, id2, t1, t2;
  float a1 = rBlades( vReedUv, 7.0, 3.1 + vReedTint * 17.0, widen, id1, t1 );
  float a2 = rBlades( vReedUv + vec2( 0.37, 0.0 ), 11.0, 8.7 + vReedTint * 13.0, widen, id2, t2 );
  float cover = max( a1, a2 );
  // a few bulrush heads (cattails) on the tallest stems
  float head = 0.0;
  if ( rHash( id1 * 3.7 + vReedTint * 29.0 ) > 0.72 ) {
    float cx = ( id1 + 0.5 ) / 7.0;
    head = step( abs( vReedUv.x - cx ), 0.028 * widen ) * step( t1 - 0.2, vReedUv.y ) * step( vReedUv.y, t1 - 0.06 );
    cover = max( cover, head );
  }
  if ( cover < 0.5 ) discard;
  vec3 green = mix( vec3( 0.075, 0.1, 0.035 ), vec3( 0.19, 0.2, 0.075 ), vReedUv.y );
  vec3 straw = mix( vec3( 0.16, 0.13, 0.07 ), vec3( 0.3, 0.26, 0.15 ), vReedUv.y );
  vec3 col = mix( green, straw, smoothstep( 0.55, 0.95, vReedTint ) * 0.8 );
  col *= 0.8 + 0.4 * rHash( id2 + vReedTint * 7.0 );
  col = mix( col, vec3( 0.12, 0.075, 0.04 ), head );
  // darker at the waterline
  col *= mix( 0.55, 1.0, smoothstep( 0.0, 0.3, vReedUv.y ) );
  diffuseColor.rgb = col;
}
`;

export interface ReedsHandle {
  meshes: THREE.Mesh[];
  /** Cull by distance and advance the sway. */
  update(camPos: THREE.Vector3, time: number): void;
  dispose(): void;
}

/** One clump: four vertical quads crossed at 45°, unit size (x, z ∈ ±0.6, y ∈ 0..1). */
function clumpGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  for (let q = 0; q < 4; q++) {
    const a = (q * Math.PI) / 4;
    const c = Math.cos(a) * 0.6;
    const s = Math.sin(a) * 0.6;
    const b = pos.length / 3;
    pos.push(-c, 0, -s, c, 0, s, c, 1, s, -c, 1, -s);
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    // normals tilted up: a stand of reeds is lit like a canopy, not like a flat card
    for (let k = 0; k < 4; k++) nrm.push(-s * 0.5, 0.85, c * 0.5);
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  return g;
}

export function buildReeds(p: ReedPlacement, far = 1800): ReedsHandle {
  const base = clumpGeometry();
  const uTime = { value: 0 };
  const uFar = { value: far };
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0, side: THREE.DoubleSide, alphaTest: 0.5, alphaToCoverage: true, fog: true });
  material.name = 'water-reeds';
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uReedTime = uTime;
    shader.uniforms.uReedFar = uFar;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${REED_VERTEX_PARS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${REED_BEGIN_VERTEX}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${REED_FRAGMENT_PARS}`)
      .replace('#include <map_fragment>', REED_MAP_FRAGMENT);
  };
  material.customProgramCacheKey = () => 'water-reeds-1';
  const meshes: THREE.Mesh[] = [];
  for (const c of p.chunks) {
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index;
    g.setAttribute('position', base.getAttribute('position'));
    g.setAttribute('uv', base.getAttribute('uv'));
    g.setAttribute('normal', base.getAttribute('normal'));
    const a = new Float32Array(c.count * 4);
    const b = new Float32Array(c.count * 2);
    for (let k = 0; k < c.count; k++) {
      const o = (c.start + k) * REED_STRIDE;
      a[k * 4] = p.data[o];
      a[k * 4 + 1] = p.data[o + 1];
      a[k * 4 + 2] = p.data[o + 2];
      a[k * 4 + 3] = p.data[o + 3];
      b[k * 2] = p.data[o + 4];
      b[k * 2 + 1] = p.data[o + 5];
    }
    g.setAttribute('aReed', new THREE.InstancedBufferAttribute(a, 4));
    g.setAttribute('aReed2', new THREE.InstancedBufferAttribute(b, 2));
    g.instanceCount = c.count;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(c.x, (c.y0 + c.y1) / 2 + 1.5, c.z), c.radius + (c.y1 - c.y0) / 2 + 4);
    g.boundingBox = new THREE.Box3(new THREE.Vector3(c.x - c.radius - 2, c.y0, c.z - c.radius - 2), new THREE.Vector3(c.x + c.radius + 2, c.y1 + 3.5, c.z + c.radius + 2));
    const m = new THREE.Mesh(g, material);
    m.name = `reeds:${meshes.length}`;
    m.receiveShadow = true;
    m.castShadow = false;
    m.visible = false;
    meshes.push(m);
  }
  return {
    meshes,
    update(cam, time) {
      uTime.value = Number.isFinite(time) ? time % 3600 : 0;
      for (let i = 0; i < meshes.length; i++) {
        const c = p.chunks[i];
        meshes[i].visible = Math.hypot(cam.x - c.x, cam.z - c.z) - c.radius < far && cam.y - c.y1 < far;
      }
    },
    dispose() {
      for (const m of meshes) m.geometry.dispose();
      base.dispose();
      material.dispose();
    },
  };
}
