/**
 * Procedural low-poly meshes for the four tree species (a few hundred
 * triangles each), built deterministically at startup:
 *
 *   conifer   – spruce/fir: 9 drooping, jagged branch tiers on a short trunk
 *   deciduous – oak/maple: 5 lumpy, noise-displaced leaf clumps + trunk/limbs
 *   poplar    – Lombardy poplar: a tall column of stacked clumps
 *   bush      – a low mound of clumps
 *
 * Geometry is NORMALISED: height 1 (y 0..1, trunk sunk slightly below 0) and
 * crown radius 1 (x, z), inside `canopyProfile` — the same envelope the
 * physics uses — so an instance scaled by (crownRadius, height, crownRadius)
 * is exactly the obstacle. Normals are "spherised" toward the crown shape for
 * soft foliage lighting, and computed for the typical proportions
 * (`SPECIES_R0` = crown radius / height) so they are right after instancing.
 * Vertex colours are linear RGB with baked ambient occlusion.
 */
import * as THREE from 'three';
import { hash2i } from '../noise';
import { CONIFER, DECIDUOUS, POPLAR, ENVELOPE } from './placement';

/** Typical crown radius / height per species (matches placement's mean ratios). */
export const SPECIES_R0 = [0.22, 0.43, 0.145, 0.925] as const;

/** Foliage base colours (linear RGB) per species, and trunk colours. */
const FOLIAGE: [number, number, number][] = [
  [0.028, 0.06, 0.03],
  [0.062, 0.118, 0.03],
  [0.07, 0.125, 0.034],
  [0.068, 0.112, 0.036],
];
const TRUNK: [number, number, number][] = [
  [0.075, 0.05, 0.034],
  [0.07, 0.058, 0.045],
  [0.08, 0.07, 0.055],
  [0.06, 0.05, 0.035],
];

class Builder {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  idx: number[] = [];

  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, r: number, g: number, b: number): number {
    const l = Math.hypot(nx, ny, nz) || 1;
    this.pos.push(x, y, z);
    this.nrm.push(nx / l, ny / l, nz / l);
    this.col.push(clamp01(r), clamp01(g), clamp01(b));
    return this.pos.length / 3 - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  /** Canonical (height 1, crown radius R0) → normalised (crown radius 1). */
  build(R0: number): THREE.BufferGeometry {
    const n = this.pos.length / 3;
    const p = new Float32Array(this.pos.length);
    const nn = new Float32Array(this.nrm.length);
    for (let i = 0; i < n; i++) {
      p[i * 3] = this.pos[i * 3] / R0;
      p[i * 3 + 1] = this.pos[i * 3 + 1];
      p[i * 3 + 2] = this.pos[i * 3 + 2] / R0;
      // normals transform with the inverse transpose of diag(1/R0, 1, 1/R0)
      const nx = this.nrm[i * 3] * R0;
      const ny = this.nrm[i * 3 + 1];
      const nz = this.nrm[i * 3 + 2] * R0;
      const l = Math.hypot(nx, ny, nz) || 1;
      nn[i * 3] = nx / l;
      nn[i * 3 + 1] = ny / l;
      nn[i * 3 + 2] = nz / l;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nn, 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 3));
    g.setIndex(n < 65536 ? new THREE.BufferAttribute(new Uint16Array(this.idx), 1) : new THREE.BufferAttribute(new Uint32Array(this.idx), 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (e0: number, e1: number, x: number): number => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** Smooth 3D value noise in [-1, 1] (deterministic). */
function vnoise3(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);
  const h = (a: number, b: number, c: number): number => hash2i(a + c * 7919, b - c * 104729, seed) * 2 - 1;
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
  const x00 = lerp(h(ix, iy, iz), h(ix + 1, iy, iz), ux);
  const x10 = lerp(h(ix, iy + 1, iz), h(ix + 1, iy + 1, iz), ux);
  const x01 = lerp(h(ix, iy, iz + 1), h(ix + 1, iy, iz + 1), ux);
  const x11 = lerp(h(ix, iy + 1, iz + 1), h(ix + 1, iy + 1, iz + 1), ux);
  return lerp(lerp(x00, x10, uy), lerp(x01, x11, uy), uz);
}

/** Unit icosphere subdivided once: 42 vertices, 80 faces (indexed). */
function icosphere(): { v: number[][]; f: number[][] } {
  const t = (1 + Math.sqrt(5)) / 2;
  const v: number[][] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map((p) => {
    const l = Math.hypot(p[0], p[1], p[2]);
    return [p[0] / l, p[1] / l, p[2] / l];
  });
  const f0 = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  const cache = new Map<string, number>();
  const mid = (a: number, b: number): number => {
    const k = a < b ? `${a}_${b}` : `${b}_${a}`;
    let i = cache.get(k);
    if (i === undefined) {
      const p = [v[a][0] + v[b][0], v[a][1] + v[b][1], v[a][2] + v[b][2]];
      const l = Math.hypot(p[0], p[1], p[2]);
      v.push([p[0] / l, p[1] / l, p[2] / l]);
      i = v.length - 1;
      cache.set(k, i);
    }
    return i;
  };
  const f: number[][] = [];
  for (const [a, b, c] of f0) {
    const ab = mid(a, b);
    const bc = mid(b, c);
    const ca = mid(c, a);
    f.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
  }
  return { v, f };
}
const ICO = icosphere();

/**
 * A lumpy leaf clump: a noise-displaced icosphere placed in the crown's unit
 * ellipsoid space (u, v, w) and mapped to canonical space by
 * x = u·R0, y = yc + v·half, z = w·R0. Clamped inside the envelope.
 */
function addClump(
  b: Builder,
  species: number,
  R0: number,
  cu: number,
  cv: number,
  cw: number,
  radius: number,
  seed: number,
  minV = -1,
  radiusV = radius * 0.92,
): void {
  const { center: yc, half } = ENVELOPE[species];
  const base = FOLIAGE[species];
  const ids: number[] = [];
  for (const d of ICO.v) {
    const n1 = vnoise3(d[0] * 1.9 + seed * 3.1, d[1] * 1.9, d[2] * 1.9, seed);
    const n2 = vnoise3(d[0] * 4.3, d[1] * 4.3 + seed, d[2] * 4.3, seed + 77);
    const k = 1 + 0.2 * n1 + 0.09 * n2;
    let u = cu + d[0] * k * radius;
    let v = cv + d[1] * k * radiusV;
    let w = cw + d[2] * k * radius;
    if (v < minV) v = minV + (v - minV) * 0.15;
    const m = Math.hypot(u, v, w);
    if (m > 0.985) {
      u *= 0.985 / m;
      v *= 0.985 / m;
      w *= 0.985 / m;
    }
    const x = u * R0;
    const y = yc + v * half;
    const z = w * R0;
    // blob normal and crown normal in canonical space (ellipsoid gradients)
    const bx = d[0] / (radius * R0);
    const by = d[1] / (radiusV * half);
    const bz = d[2] / (radius * R0);
    const bl = Math.hypot(bx, by, bz);
    const cx = u / R0;
    const cy = v / half;
    const cz = w / R0;
    const cl = Math.hypot(cx, cy, cz) || 1;
    const nx = (0.45 * bx) / bl + (0.55 * cx) / cl;
    const ny = (0.45 * by) / bl + (0.55 * cy) / cl + 0.08;
    const nz = (0.45 * bz) / bl + (0.55 * cz) / cl;
    // ambient occlusion: deep inside the crown and underneath is darker
    const depth = Math.hypot(u, v, w);
    const ao = (0.38 + 0.62 * smooth(0.3, 0.95, depth)) * (0.72 + 0.28 * clamp01((v + 1) / 2)) * (0.88 + 0.16 * n2);
    const warm = 1 + 0.12 * n1;
    ids.push(b.vert(x, y, z, nx, ny, nz, base[0] * ao * warm, base[1] * ao, base[2] * ao * (2 - warm)));
  }
  for (const f of ICO.f) b.tri(ids[f[0]], ids[f[1]], ids[f[2]]);
}

/** Tapered open cylinder (trunk / limb) between two points. */
function addLimb(
  b: Builder,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  r0: number,
  r1: number,
  sides: number,
  c: [number, number, number],
): void {
  const ax = new THREE.Vector3(x1 - x0, y1 - y0, z1 - z0).normalize();
  const t = Math.abs(ax.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const u = new THREE.Vector3().crossVectors(ax, t).normalize();
  const v = new THREE.Vector3().crossVectors(ax, u).normalize();
  const bottom: number[] = [];
  const top: number[] = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    const nx = u.x * Math.cos(a) + v.x * Math.sin(a);
    const ny = u.y * Math.cos(a) + v.y * Math.sin(a);
    const nz = u.z * Math.cos(a) + v.z * Math.sin(a);
    const shade = 0.85 + 0.15 * Math.cos(a * 3);
    bottom.push(b.vert(x0 + nx * r0, y0 + ny * r0, z0 + nz * r0, nx, ny, nz, c[0] * 0.8 * shade, c[1] * 0.8 * shade, c[2] * 0.8 * shade));
    top.push(b.vert(x1 + nx * r1, y1 + ny * r1, z1 + nz * r1, nx, ny, nz, c[0] * shade, c[1] * shade, c[2] * shade));
  }
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    b.tri(bottom[i], bottom[j], top[j]);
    b.tri(bottom[i], top[j], top[i]);
  }
}

function buildConifer(): THREE.BufferGeometry {
  const R0 = SPECIES_R0[CONIFER];
  const b = new Builder();
  addLimb(b, 0, -0.06, 0, 0, 0.3, 0, 0.02, 0.012, 5, TRUNK[CONIFER]);
  const env = (y: number): number => R0 * Math.min(1, (1 - y) / 0.9); // cone envelope radius at height y
  const base = FOLIAGE[CONIFER];
  const N = 9;
  for (let t = 0; t < N; t++) {
    const f = t / (N - 1);
    const yb = 0.08 + 0.8 * Math.pow(t / N, 0.95);
    const tierH = 0.2 - 0.08 * f;
    const yApex = t === N - 1 ? 1 : Math.min(0.995, yb + tierH);
    const K = t >= N - 2 ? 7 : 9;
    const twist = hash2i(t, 1, 5) * Math.PI * 2;
    const tierScale = 0.9 + 0.1 * hash2i(t, 2, 5);
    const droop = 0.025 + 0.02 * (1 - f);
    const light = 0.62 + 0.5 * f; // upper tiers catch more light
    const rim: { x: number; y: number; z: number; nx: number; nz: number; tip: boolean }[] = [];
    for (let k = 0; k < 2 * K; k++) {
      const a = twist + (k / (2 * K)) * Math.PI * 2 + (hash2i(t, k, 9) - 0.5) * 0.25;
      const tip = k % 2 === 0;
      const y = tip ? yb - droop * (0.7 + 0.6 * hash2i(t, k, 11)) : yb + 0.03;
      const r = tip ? env(y) * 0.97 * tierScale * (0.8 + 0.2 * hash2i(t, k, 13)) : env(yb) * 0.6 * tierScale;
      rim.push({ x: Math.cos(a) * r, y, z: Math.sin(a) * r, nx: Math.cos(a), nz: Math.sin(a), tip });
    }
    const inner = b.vert(0, yb + 0.05, 0, 0, -1, 0, base[0] * 0.3, base[1] * 0.3, base[2] * 0.3);
    for (let k = 0; k < 2 * K; k++) {
      const p = rim[k];
      const q = rim[(k + 1) % (2 * K)];
      const ma = Math.atan2(p.nz + q.nz, p.nx + q.nx);
      const tipBoost = (tip: boolean): number => (tip ? 1.35 : 0.7);
      // upper surface: apex duplicated per segment so each wedge has its own outward normal
      const apex = b.vert(0, yApex, 0, Math.cos(ma) * 0.45, 1, Math.sin(ma) * 0.45, base[0] * light * 0.8, base[1] * light * 0.8, base[2] * light * 0.8);
      const pa = b.vert(p.x, p.y, p.z, p.nx, p.tip ? 0.55 : 0.9, p.nz, base[0] * light * tipBoost(p.tip) * 1.1, base[1] * light * tipBoost(p.tip), base[2] * light * tipBoost(p.tip));
      const qa = b.vert(q.x, q.y, q.z, q.nx, q.tip ? 0.55 : 0.9, q.nz, base[0] * light * tipBoost(q.tip) * 1.1, base[1] * light * tipBoost(q.tip), base[2] * light * tipBoost(q.tip));
      b.tri(apex, qa, pa);
      // underside (dark, faces down/out)
      const pu = b.vert(p.x, p.y, p.z, p.nx, -0.6, p.nz, base[0] * 0.42, base[1] * 0.42, base[2] * 0.42);
      const qu = b.vert(q.x, q.y, q.z, q.nx, -0.6, q.nz, base[0] * 0.42, base[1] * 0.42, base[2] * 0.42);
      b.tri(inner, pu, qu);
    }
  }
  return b.build(R0);
}

function buildDeciduous(): THREE.BufferGeometry {
  const R0 = SPECIES_R0[DECIDUOUS];
  const b = new Builder();
  const tc = TRUNK[DECIDUOUS];
  addLimb(b, 0, -0.06, 0, 0.01, 0.46, 0, 0.034, 0.02, 6, tc);
  addLimb(b, 0.005, 0.34, 0, 0.16, 0.6, 0.05, 0.016, 0.008, 4, tc);
  addLimb(b, 0.005, 0.38, 0, -0.1, 0.62, -0.12, 0.015, 0.008, 4, tc);
  addClump(b, DECIDUOUS, R0, 0.02, 0.42, -0.03, 0.54, 1);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4 + (hash2i(i, 3, 21) - 0.5) * 0.6;
    const dist = 0.43 + 0.06 * hash2i(i, 4, 21);
    const v = -0.2 + 0.32 * hash2i(i, 5, 21);
    const r = 0.47 + 0.07 * hash2i(i, 6, 21);
    addClump(b, DECIDUOUS, R0, Math.cos(a) * dist, v, Math.sin(a) * dist, r, 10 + i);
  }
  return b.build(R0);
}

function buildPoplar(): THREE.BufferGeometry {
  const R0 = SPECIES_R0[POPLAR];
  const b = new Builder();
  addLimb(b, 0, -0.06, 0, 0, 0.3, 0, 0.1 * R0, 0.06 * R0, 5, TRUNK[POPLAR]);
  // [v centre, horizontal radius, vertical radius, offset] in unit crown space (round clumps in metres)
  const stack = [
    [-0.62, 0.78, 0.3, 0.08],
    [-0.28, 0.9, 0.32, -0.07],
    [0.08, 0.86, 0.32, 0.06],
    [0.42, 0.72, 0.3, -0.04],
    [0.72, 0.46, 0.26, 0.02],
  ];
  stack.forEach(([v, ru, rv, off], i) => addClump(b, POPLAR, R0, off, v, -off * 0.5, ru, 30 + i, -1, rv));
  return b.build(R0);
}

function buildBush(): THREE.BufferGeometry {
  const R0 = SPECIES_R0[3];
  const b = new Builder();
  addClump(b, 3, R0, 0, 0.46, 0, 0.6, 40, -0.52);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.3;
    addClump(b, 3, R0, Math.cos(a) * 0.45, -0.02 + 0.12 * hash2i(i, 1, 41), Math.sin(a) * 0.45, 0.5, 41 + i, -0.52);
  }
  return b.build(R0);
}

const builders = [buildConifer, buildDeciduous, buildPoplar, buildBush];

/** The normalised mesh of a species (a new geometry each call). */
export function buildSpeciesGeometry(species: number): THREE.BufferGeometry {
  return builders[species]();
}

export function triangleCount(g: THREE.BufferGeometry): number {
  return g.index ? g.index.count / 3 : g.getAttribute('position').count / 3;
}
