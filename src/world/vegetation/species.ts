/**
 * Procedural tree meshes for the seven species, built deterministically at
 * startup from alpha-tested leaf cards (textures.ts) on a branch skeleton:
 *
 *   spruce    – spruce/fir: whorls of drooping needle-spray branches with
 *               upturned tips on a straight trunk, a dark inner cone
 *   pine      – Scots pine: long bare orange-brown trunk, a few flat, clumpy
 *               needle pads on top
 *   broadleaf – oak/beech/maple: thick trunk and limbs, 8 clumpy lobes of leaf
 *               sprays around shadowed cores
 *   birch     – white trunk, narrow airy crown of small pendulous sprays
 *   poplar    – Lombardy poplar: a tall column of upward-pointing sprays
 *   willow    – short leaning trunk, a dome of small sprays and a curtain of
 *               hanging strands
 *   bush      – a low mound of sprays
 *
 * Geometry is NORMALISED: height 1 (y 0..1, trunk sunk slightly below 0) and
 * crown radius 1 (x, z), inside `canopyProfile` — the same envelope the
 * physics uses — so an instance scaled by (crownRadius, height, crownRadius)
 * is exactly the obstacle. Leaf-card normals are bent outward from the crown
 * centre for soft, volumetric foliage lighting (the material doesn't flip them
 * on back faces). Attributes: position, normal, uv (atlas), color (linear RGB
 * species colour × baked ambient occlusion), leaf (1 foliage, 0 bark), clump
 * (xyz = centre of the foliage mass the vertex belongs to, w = its id; −1 for
 * the trunk and limbs). The near material shrinks or drops clumps per tree
 * (materials.ts), so no two trees share a silhouette and bare branches show in
 * the gaps; clump centres lie inside the (convex) envelope, so any shrink stays
 * inside it. Foliage normals are bent toward a blend of the crown-outward and
 * clump-outward directions: every foliage mass has a lit top and a shaded
 * underside. `buildSpeciesGeometry(species, seed)` builds any variant; the
 * game uses the default seed per species.
 */
import * as THREE from 'three';
import { mulberry32 } from '../noise';
import { SPRUCE, PINE, BROADLEAF, BIRCH, POPLAR, WILLOW, BUSH, ENVELOPE, SPECIES_COUNT } from './placement';
import { REGION, type UvRect } from './textures';

/** Typical crown radius / height per species (matches placement's mean ratios). */
export const SPECIES_R0 = [0.2, 0.24, 0.43, 0.26, 0.135, 0.575, 0.925] as const;

type RGB = [number, number, number];
/** Foliage vertex colours (linear; × the atlas texel ≈ real leaf albedo). */
const FOLIAGE: RGB[] = [
  [0.085, 0.11, 0.08], // spruce: dark green
  [0.13, 0.14, 0.11], // pine: grey-green
  [0.15, 0.2, 0.14], // broadleaf
  [0.18, 0.24, 0.17], // birch: light yellow-green
  [0.1, 0.17, 0.14], // poplar: deep green
  [0.16, 0.2, 0.17], // willow (silvered per instance)
  [0.13, 0.17, 0.15], // bush
];
/** Bark vertex colours (× the bark texel). */
const BARK: RGB[] = [
  [0.27, 0.23, 0.2], // spruce: grey-brown
  [0.55, 0.3, 0.17], // pine: orange upper trunk
  [0.3, 0.285, 0.265], // oak/beech: grey
  [0.95, 0.95, 0.93], // birch (white texture)
  [0.33, 0.31, 0.28],
  [0.3, 0.27, 0.23],
  [0.3, 0.26, 0.2],
];

/** Clump state of the builder: the foliage mass new vertices belong to (id −1 = none). */
interface ClumpState {
  x: number;
  y: number;
  z: number;
  rx: number;
  ry: number;
  id: number;
}

class Builder {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  uv: number[] = [];
  leaf: number[] = [];
  clump: number[] = [];
  idx: number[] = [];
  /** The clump new vertices join (set by `beginClump`, cleared by `endClump`). */
  cl: ClumpState | null = null;
  private nextClump = 0;

  beginClump(x: number, y: number, z: number, rx: number, ry: number): void {
    this.cl = { x, y, z, rx, ry, id: this.nextClump++ };
  }

  endClump(): void {
    this.cl = null;
  }

  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, c: RGB, k: number, u: number, v: number, leaf: number): number {
    const l = Math.hypot(nx, ny, nz) || 1;
    this.pos.push(x, y, z);
    this.nrm.push(nx / l, ny / l, nz / l);
    this.col.push(clamp01(c[0] * k), clamp01(c[1] * k), clamp01(c[2] * k));
    this.uv.push(u, v);
    this.leaf.push(leaf);
    const cl = this.cl;
    if (cl) this.clump.push(cl.x, cl.y, cl.z, cl.id);
    else this.clump.push(0, 0, 0, -1);
    return this.pos.length / 3 - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  /** Canonical (height 1, crown radius R0) → normalised (crown radius 1), clamped inside the envelope. */
  build(R0: number, species: number): THREE.BufferGeometry {
    const n = this.pos.length / 3;
    const p = new Float32Array(this.pos.length);
    const nn = new Float32Array(this.nrm.length);
    const cc = new Float32Array(this.clump.length);
    const q: V3 = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      clampToEnvelope(species, this.pos[i * 3] / R0, this.pos[i * 3 + 1], this.pos[i * 3 + 2] / R0, q);
      p[i * 3] = q[0];
      p[i * 3 + 1] = q[1];
      p[i * 3 + 2] = q[2];
      // normals transform with the inverse transpose of diag(1/R0, 1, 1/R0)
      const nx = this.nrm[i * 3] * R0;
      const ny = this.nrm[i * 3 + 1];
      const nz = this.nrm[i * 3 + 2] * R0;
      const l = Math.hypot(nx, ny, nz) || 1;
      nn[i * 3] = nx / l;
      nn[i * 3 + 1] = ny / l;
      nn[i * 3 + 2] = nz / l;
      const id = this.clump[i * 4 + 3];
      if (id >= 0) {
        // the clump centre, pulled a little further in than the vertices (strictly inside the envelope)
        clampToEnvelope(species, this.clump[i * 4] / R0, this.clump[i * 4 + 1], this.clump[i * 4 + 2] / R0, q, 0.97);
        cc[i * 4] = q[0];
        cc[i * 4 + 1] = q[1];
        cc[i * 4 + 2] = q[2];
      }
      cc[i * 4 + 3] = id;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nn, 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.uv), 2));
    g.setAttribute('leaf', new THREE.BufferAttribute(new Float32Array(this.leaf), 1));
    g.setAttribute('clump', new THREE.BufferAttribute(cc, 4));
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

type V3 = [number, number, number];

/** Pulls a normalised point inside the species' physics envelope (scaled by `k` ≤ 1). */
function clampToEnvelope(species: number, x: number, y: number, z: number, out: V3, k = 0.995): V3 {
  if (y < -0.1) y = -0.1; // low cards of a shrub: no deeper than the trunk base
  const rho = Math.hypot(x, z);
  if (species === SPRUCE) {
    if (y > k + 0.004) y = k + 0.004;
    const maxRho = Math.min(k, ((1 - y) / 0.9) * (k / 0.995));
    if (rho > maxRho) {
      const f = Math.max(0, maxRho) / rho;
      x *= f;
      z *= f;
    }
  } else {
    const env = ENVELOPE[species];
    const dy = (y - env.center) / env.half;
    if (dy > 0) {
      const e = Math.hypot(rho, dy);
      if (e > k) {
        x *= k / e;
        z *= k / e;
        y = env.center + (dy * k * env.half) / e;
      }
    } else if (rho > k) {
      x *= k / rho;
      z *= k / rho;
    }
  }
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
}
const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Random unit vector (uniform on the sphere). */
function randDir(rnd: () => number): V3 {
  const z = rnd() * 2 - 1;
  const a = rnd() * Math.PI * 2;
  const r = Math.sqrt(1 - z * z);
  return [r * Math.cos(a), z, r * Math.sin(a)];
}

interface Crown {
  /** Crown centre (canonical) and radii for normal bending / AO. */
  cx: number;
  cy: number;
  cz: number;
  rx: number;
  ry: number;
}

/**
 * A leaf card: centre c, facing `nrm`, with `up` hint, size w × h, atlas region
 * `reg`, flipped horizontally if `flip`. The shading normal is bent toward the
 * crown-outward direction; AO darkens cards deep inside the crown and low down.
 */
function card(b: Builder, c: V3, nrm: V3, up: V3, w: number, h: number, reg: UvRect, col: RGB, crown: Crown, bend: number, flip: boolean, aoBias = 1): void {
  const n = norm(nrm);
  let r = cross(up, n);
  if (Math.hypot(r[0], r[1], r[2]) < 1e-4) r = cross([1, 0, 0], n);
  r = norm(r);
  const u = norm(cross(n, r));
  const corners: [number, number][] = [
    [-0.5, -0.5],
    [0.5, -0.5],
    [0.5, 0.5],
    [-0.5, 0.5],
  ];
  const ids: number[] = [];
  for (const [a, bb] of corners) {
    const x = c[0] + r[0] * a * w + u[0] * bb * h;
    const y = c[1] + r[1] * a * w + u[1] * bb * h;
    const z = c[2] + r[2] * a * w + u[2] * bb * h;
    // crown-outward direction (ellipsoid gradient) for the bent normal, blended with the
    // clump-outward direction so every foliage mass has its own lit top and shaded underside
    const ox = (x - crown.cx) / (crown.rx * crown.rx);
    const oy = (y - crown.cy) / (crown.ry * crown.ry);
    const oz = (z - crown.cz) / (crown.rx * crown.rx);
    let o = norm([ox, oy + 0.15 / crown.ry, oz]);
    const cl = b.cl;
    let clumpAo = 1;
    if (cl && cl.rx > 0) {
      const co = norm([(x - cl.x) / (cl.rx * cl.rx), (y - cl.y) / (cl.ry * cl.ry) + 0.1 / cl.ry, (z - cl.z) / (cl.rx * cl.rx)]);
      o = norm([o[0] * 0.4 + co[0] * 0.6, o[1] * 0.4 + co[1] * 0.6, o[2] * 0.4 + co[2] * 0.6]);
      const cd = Math.hypot((x - cl.x) / cl.rx, (y - cl.y) / cl.ry, (z - cl.z) / cl.rx);
      const ch = clamp01(((y - cl.y) / cl.ry + 1) / 2);
      clumpAo = (0.72 + 0.28 * smooth(0.2, 1.0, cd)) * (0.84 + 0.16 * ch);
    }
    const nx = n[0] * (1 - bend) + o[0] * bend;
    const ny = n[1] * (1 - bend) + o[1] * bend;
    const nz = n[2] * (1 - bend) + o[2] * bend;
    // ambient occlusion: depth inside the crown ellipsoid and height within it, and inside the clump
    const depth = Math.hypot((x - crown.cx) / crown.rx, (y - crown.cy) / crown.ry, (z - crown.cz) / crown.rx);
    const hgt = clamp01(((y - crown.cy) / crown.ry + 1) / 2);
    const ao = (0.42 + 0.58 * smooth(0.25, 1.0, depth)) * (0.74 + 0.26 * hgt) * aoBias * clumpAo;
    const uu = reg.u0 + (reg.u1 - reg.u0) * ((flip ? -a : a) + 0.5);
    const vv = reg.v0 + (reg.v1 - reg.v0) * (bb + 0.5);
    ids.push(b.vert(x, y, z, nx, ny, nz, col, ao, uu, vv, 1));
  }
  b.tri(ids[0], ids[1], ids[2]);
  b.tri(ids[0], ids[2], ids[3]);
}

/** UV inside the opaque canopy-interior region for a direction (spherical mapping). */
function coreUv(d: V3): [number, number] {
  const R = REGION.CANOPY;
  const u = Math.atan2(d[2], d[0]) / (Math.PI * 2) + 0.5;
  const v = d[1] * 0.5 + 0.5;
  return [R.u0 + (R.u1 - R.u0) * (0.04 + 0.92 * u), R.v0 + (R.v1 - R.v0) * (0.04 + 0.92 * v)];
}
const CORE_UV = coreUv([0, 0, 1]);

/** A low-poly core (icosahedron) of opaque shadowed foliage filling a lobe's interior. */
function core(b: Builder, c: V3, rx: number, ry: number, col: RGB, k: number): void {
  const t = (1 + Math.sqrt(5)) / 2;
  const v: V3[] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map((p) => norm(p as V3));
  const f = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  const ids = v.map((d) => {
    const [uu, vv] = coreUv(d);
    return b.vert(c[0] + d[0] * rx, c[1] + d[1] * ry, c[2] + d[2] * rx, d[0], d[1] + 0.3, d[2], col, k * (0.75 + 0.25 * (d[1] * 0.5 + 0.5)), uu, vv, 1);
  });
  for (const [a, bb, cc] of f) b.tri(ids[a], ids[bb], ids[cc]);
}

/** Tapered open cylinder (trunk / limb) between two points, bark-textured. */
function limb(b: Builder, p0: V3, p1: V3, r0: number, r1: number, sides: number, c: RGB, reg: UvRect, k0 = 0.7, k1 = 1): void {
  const ax = norm([p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]);
  const t: V3 = Math.abs(ax[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = norm(cross(ax, t));
  const v = norm(cross(ax, u));
  const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
  const vv1 = reg.v0 + (reg.v1 - reg.v0) * Math.min(1, len * 2.2);
  const bottom: number[] = [];
  const top: number[] = [];
  for (let i = 0; i <= sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    const nx = u[0] * Math.cos(a) + v[0] * Math.sin(a);
    const ny = u[1] * Math.cos(a) + v[1] * Math.sin(a);
    const nz = u[2] * Math.cos(a) + v[2] * Math.sin(a);
    const uu = reg.u0 + (reg.u1 - reg.u0) * (i / sides);
    bottom.push(b.vert(p0[0] + nx * r0, p0[1] + ny * r0, p0[2] + nz * r0, nx, ny, nz, c, k0, uu, reg.v0, 0));
    top.push(b.vert(p1[0] + nx * r1, p1[1] + ny * r1, p1[2] + nz * r1, nx, ny, nz, c, k1, uu, vv1, 0));
  }
  for (let i = 0; i < sides; i++) {
    b.tri(bottom[i], bottom[i + 1], top[i + 1]);
    b.tri(bottom[i], top[i + 1], top[i]);
  }
}

/** Leaf cards scattered over a lobe (ellipsoid), facing outward. */
function lobe(
  b: Builder,
  rnd: () => number,
  c: V3,
  rx: number,
  ry: number,
  cards: number,
  size: number,
  reg: UvRect,
  col: RGB,
  crown: Crown,
  opts: { outward?: V3; hang?: number; upright?: number; shell?: number } = {},
): void {
  const out = opts.outward ? norm(opts.outward) : null;
  for (let i = 0; i < cards; i++) {
    let d = randDir(rnd);
    if (out && d[0] * out[0] + d[1] * out[1] + d[2] * out[2] < -0.35) d = [-d[0], -d[1], -d[2]];
    const s = (opts.shell ?? 0.55) + (1 - (opts.shell ?? 0.55)) * Math.sqrt(rnd());
    const p: V3 = [c[0] + d[0] * rx * s, c[1] + d[1] * ry * s, c[2] + d[2] * rx * s];
    // card faces outward, tilted randomly; "up" is mostly world-up (or down for hanging sprays)
    const tilt = randDir(rnd);
    const n: V3 = norm([d[0] + tilt[0] * 0.5, d[1] + tilt[1] * 0.5 + 0.25, d[2] + tilt[2] * 0.5]);
    const hang = opts.hang ?? 0;
    const upr = opts.upright ?? 0;
    const up: V3 = norm([Math.cos(rnd() * 6.283) * (1 - upr), rnd() < hang ? -1 : 0.4 + upr, Math.sin(rnd() * 6.283) * (1 - upr)]);
    const sz = size * (0.8 + 0.4 * rnd());
    card(b, p, n, up, sz, sz, reg, col, crown, 0.62, rnd() < 0.5);
  }
}

/**
 * A drooping skirt of needle sprays around the trunk: `seg` segments, each a
 * two-step strip from the trunk (inner) out to the tips (outer), textured with
 * one spray so the ragged spray outline makes natural branch tips and gaps.
 */
function skirt(b: Builder, rnd: () => number, yb: number, L: number, droop: number, seg: number, col: RGB, light: number, crown: Crown, twist: number): void {
  const reg = REGION.NEEDLE;
  const vm = (reg.v0 + reg.v1) / 2;
  const ring: { a: number; L: number; d: number }[] = [];
  for (let k = 0; k <= seg; k++) {
    const kk = k % seg;
    ring.push({ a: twist + (k / seg) * Math.PI * 2, L: L * (0.85 + 0.25 * hashJ(kk, 1, rnd)), d: droop * (0.75 + 0.5 * hashJ(kk, 2, rnd)) });
  }
  for (let k = 0; k < seg; k++) {
    const p = ring[k];
    const q = ring[k + 1];
    const ids: number[] = [];
    // each branch segment is a clump centred on the trunk: shrinking it shortens the branch
    b.beginClump(0, yb - droop * 0.3, 0, L, droop + 0.02);
    for (const [e, f] of [[p, 0], [q, 1]] as [typeof p, number][]) {
      const dx = Math.cos(e.a);
      const dz = Math.sin(e.a);
      const u = f === 0 ? reg.u0 : reg.u1;
      const r0 = e.L * 0.08;
      const r1 = e.L * 0.58;
      const r2 = e.L;
      const y0 = yb + 0.012;
      const y1 = yb - e.d * 0.7;
      const y2 = yb - e.d * 0.72 + e.L * 0.05; // tips curl up again
      const shade = (t: number): number => light * (0.55 + 0.5 * t);
      const bendN = (t: number): V3 => {
        const o = norm([dx * (crown.rx > 0 ? 1 : 0), 0.9 - 0.3 * t, dz]);
        return o;
      };
      const n0 = bendN(0);
      const n1 = bendN(0.6);
      const n2 = bendN(1);
      ids.push(
        b.vert(dx * r0, y0, dz * r0, n0[0], n0[1], n0[2], col, shade(0), u, reg.v0, 1),
        b.vert(dx * r1, y1, dz * r1, n1[0], n1[1], n1[2], col, shade(0.6), u, vm, 1),
        b.vert(dx * r2, y2, dz * r2, n2[0], n2[1], n2[2], col, shade(1), u, reg.v1, 1),
      );
    }
    const [a0, a1, a2, b0, b1, b2] = ids;
    b.tri(a0, b0, b1);
    b.tri(a0, b1, a1);
    b.tri(a1, b1, b2);
    b.tri(a1, b2, a2);
    b.endClump();
  }
}

/** Deterministic per-(k, j) jitter drawn once from the builder's PRNG stream. */
const jitterCache = new Map<string, number>();
function hashJ(k: number, j: number, rnd: () => number): number {
  const key = `${k}_${j}_${jitterSeq}`;
  let v = jitterCache.get(key);
  if (v === undefined) {
    v = rnd();
    jitterCache.set(key, v);
  }
  return v;
}
let jitterSeq = 0;

/** Default builder seeds (the trees the game draws). */
const DEFAULT_SEEDS = [101, 202, 303, 404, 505, 606, 707] as const;
const TAU = Math.PI * 2;

function buildSpruce(seed: number): THREE.BufferGeometry {
  const sp = SPRUCE;
  const R0 = SPECIES_R0[sp];
  const b = new Builder();
  const rnd = mulberry32(seed);
  jitterCache.clear();
  const fol = FOLIAGE[sp];
  limb(b, [0, -0.05, 0], [0, 0.3, 0], 0.014, 0.01, 6, BARK[sp], REGION.BARK);
  limb(b, [0, 0.3, 0], [0, 0.97, 0], 0.01, 0.003, 5, BARK[sp], REGION.BARK, 0.5, 0.6);
  const env = (y: number): number => R0 * Math.min(1, (1 - y) / 0.9);
  const crown: Crown = { cx: 0, cy: 0.42, cz: 0, rx: R0, ry: 0.55 };
  // a narrow dark core of dense needles hides the trunk and the sky behind it (clump 0: never dropped)
  b.beginClump(0, 0.45, 0, R0 * 0.3, 0.4);
  const coneSides = 6;
  const apex = b.vert(0, 0.9, 0, 0, 1, 0, fol, 0.5, CORE_UV[0], REGION.CANOPY.v1 - 0.01, 1);
  const ring: number[] = [];
  for (let i = 0; i <= coneSides; i++) {
    const a = (i / coneSides) * TAU;
    const [uu] = coreUv([Math.cos(a), 0, Math.sin(a)]);
    ring.push(b.vert(Math.cos(a) * R0 * 0.3, 0.12, Math.sin(a) * R0 * 0.3, Math.cos(a), 0.4, Math.sin(a), fol, 0.45, uu, REGION.CANOPY.v0 + 0.01, 1));
  }
  for (let i = 0; i < coneSides; i++) b.tri(apex, ring[i + 1], ring[i]);
  b.endClump();
  const tiers = 15;
  for (let t = 0; t < tiers; t++) {
    jitterSeq = t;
    const f = t / (tiers - 1);
    const yb = 0.13 + 0.82 * Math.pow(f, 0.92) + (rnd() - 0.5) * 0.012;
    const L = env(yb - 0.05) * (0.94 + 0.12 * rnd());
    const droop = L * (0.5 + 0.3 * (1 - f)) * (1 / R0) * 0.2;
    const seg = t > tiers - 4 ? 5 : 8;
    const tw = rnd() * TAU;
    skirt(b, rnd, yb, L, droop, seg, fol, 0.62 + 0.45 * f, crown, tw);
    // an inner, shorter skirt offset by half a segment fills the gaps near the trunk
    jitterSeq = 100 + t;
    if (t < tiers - 2) skirt(b, rnd, yb - 0.025, L * 0.62, droop * 0.7, 5, fol, 0.45 + 0.35 * f, crown, tw + Math.PI / seg);
  }
  // leader: two crossed vertical sprays at the tip
  b.beginClump(0, 0.9, 0, R0 * 0.2, 0.08);
  for (let k = 0; k < 2; k++) {
    const a = (k * Math.PI) / 2;
    card(b, [0, 0.93, 0], [Math.cos(a), 0, Math.sin(a)], [0, 1, 0], R0 * 0.35, 0.13, REGION.NEEDLE, fol, crown, 0.3, false, 1.1);
  }
  b.endClump();
  return b.build(R0, sp);
}

function buildPine(seed: number): THREE.BufferGeometry {
  const sp = PINE;
  const R0 = SPECIES_R0[sp];
  const b = new Builder();
  const rnd = mulberry32(seed);
  const fol = FOLIAGE[sp];
  const bark = BARK[sp];
  const lower: RGB = [0.32, 0.26, 0.22];
  // slightly sinuous trunk: grey-brown below, orange above
  const w1 = (rnd() - 0.5) * 0.03;
  const w2 = (rnd() - 0.5) * 0.03;
  const pts: V3[] = [[0, -0.05, 0], [0.012 + w1, 0.3, 0.004], [-0.006 + w2, 0.58, 0.01 - w1], [0.01 + w1, 0.84, -0.004 + w2]];
  const radii = [0.02, 0.016, 0.012, 0.006];
  for (let i = 0; i < 3; i++) limb(b, pts[i], pts[i + 1], radii[i], radii[i + 1], 6, i === 0 ? lower : bark, REGION.BARK, 0.75, 0.95);
  const crown: Crown = { cx: 0, cy: 0.78, cz: 0, rx: R0, ry: 0.2 };
  const pads = 7;
  for (let i = 0; i < pads; i++) {
    const a = (i / pads) * TAU + rnd() * 0.6;
    const top = i === 0;
    const rr = top ? 0 : R0 * (0.35 + 0.35 * rnd());
    const y = top ? 0.94 : 0.64 + 0.2 * rnd();
    const c: V3 = [Math.cos(a) * rr, y, Math.sin(a) * rr];
    const src = Math.min(3, Math.floor(((y - 0.55) / 0.35) * 3) + 1);
    const from = pts[Math.max(1, Math.min(3, src))];
    if (!top) limb(b, [from[0], Math.min(y - 0.04, from[1] + 0.02), from[2]], [c[0] * 0.8, y - 0.02, c[2] * 0.8], 0.006, 0.003, 4, bark, REGION.BARK, 0.7, 0.8);
    const prx = R0 * (top ? 0.45 : 0.38 + 0.12 * rnd());
    b.beginClump(c[0], y, c[2], prx, 0.06);
    core(b, [c[0], y - 0.01, c[2]], prx * 0.62, 0.045, fol, 0.5);
    const cards = 14;
    for (let k = 0; k < cards; k++) {
      const ang = rnd() * TAU;
      const rad = prx * Math.sqrt(rnd()) * 0.8;
      const p: V3 = [c[0] + Math.cos(ang) * rad, y + (rnd() - 0.3) * 0.05, c[2] + Math.sin(ang) * rad];
      const n: V3 = norm([Math.cos(ang) * 0.5 + (rnd() - 0.5) * 0.5, 1, Math.sin(ang) * 0.5 + (rnd() - 0.5) * 0.5]);
      const up: V3 = [Math.cos(ang), 0, Math.sin(ang)];
      const sz = prx * (0.85 + 0.4 * rnd());
      if (k % 3 === 2) {
        // an upright tuft seen from the side
        card(b, [p[0], p[1] + sz * 0.2, p[2]], [Math.cos(ang + 1.57), 0.15, Math.sin(ang + 1.57)], [0, 1, 0], sz, sz * 0.7, REGION.NEEDLE, fol, crown, 0.5, rnd() < 0.5);
      } else card(b, p, n, up, sz, sz * 1.2, REGION.NEEDLE, fol, crown, 0.45, rnd() < 0.5);
    }
    b.endClump();
  }
  return b.build(R0, sp);
}

/**
 * Oak / beech / maple: a leaning trunk forking into 3–4 scaffold limbs, and a
 * dozen foliage clumps of different sizes spread over the upper crown (a
 * golden-angle spiral from the top down past the crown's equator), each fed by
 * a twig from the nearest limb — an irregular, clumpy dome with shadowed gaps.
 */
function buildBroadleaf(seed: number): THREE.BufferGeometry {
  const sp = BROADLEAF;
  const R0 = SPECIES_R0[sp];
  const b = new Builder();
  const rnd = mulberry32(seed);
  const fol = FOLIAGE[sp];
  const bark = BARK[sp];
  const yc = 0.6;
  const ryc = 0.38;
  const crown: Crown = { cx: 0, cy: yc, cz: 0, rx: R0, ry: ryc };
  const lean: V3 = [(rnd() - 0.5) * 0.04, 0, (rnd() - 0.5) * 0.04];
  const fork: V3 = [lean[0], 0.36 + 0.06 * rnd(), lean[2]];
  limb(b, [0, -0.05, 0], [lean[0] * 0.5, 0.2, lean[2] * 0.5], 0.034, 0.027, 8, bark, REGION.BARK, 0.55, 0.7);
  limb(b, [lean[0] * 0.5, 0.2, lean[2] * 0.5], fork, 0.027, 0.021, 7, bark, REGION.BARK, 0.7, 0.8);
  const nLimb = rnd() < 0.5 ? 3 : 4;
  const a0 = rnd() * TAU;
  const ends: V3[] = [];
  for (let i = 0; i < nLimb; i++) {
    const a = a0 + (i / nLimb) * TAU + (rnd() - 0.5) * 0.7;
    const out = R0 * (0.3 + 0.18 * rnd());
    const e: V3 = [Math.cos(a) * out + lean[0], yc + 0.02 + 0.14 * rnd(), Math.sin(a) * out + lean[2]];
    limb(b, fork, e, 0.016, 0.008, 5, bark, REGION.BARK, 0.6, 0.8);
    ends.push(e);
  }
  const N = 13;
  const phase = rnd() * TAU;
  for (let k = 0; k < N; k++) {
    // one clump on top, the rest in a golden-angle spiral from ~40° below the top to past the equator
    const f = k === 0 ? 0 : (k - 1 + 0.3 + 0.4 * rnd()) / (N - 1);
    const cth = k === 0 ? 1 : 0.78 - 1.25 * f;
    const th = Math.acos(Math.max(-0.5, Math.min(1, cth)));
    const ph = phase + k * 2.39996 + (rnd() - 0.5) * 0.6;
    const rr = k === 0 ? 0.45 : 0.55 + 0.15 * rnd();
    const c: V3 = [Math.sin(th) * Math.cos(ph) * R0 * rr, yc + Math.cos(th) * ryc * rr, Math.sin(th) * Math.sin(ph) * R0 * rr];
    const big = k === 0 ? 1.15 : 0.85 + 0.35 * rnd();
    const rx = R0 * 0.42 * big;
    const ry = (0.15 + 0.05 * rnd()) * big;
    // a twig from the nearest scaffold limb end toward the clump
    let best = ends[0];
    let bd = Infinity;
    for (const e of ends) {
      const d = Math.hypot(e[0] - c[0], e[1] - c[1], e[2] - c[2]);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    limb(b, best, [c[0] * 0.85, c[1] - ry * 0.3, c[2] * 0.85], 0.007, 0.003, 3, bark, REGION.BARK, 0.6, 0.7);
    b.beginClump(c[0], c[1], c[2], rx, ry);
    core(b, c, rx * 0.72, ry * 0.72, fol, 0.5);
    lobe(b, rnd, c, rx, ry, 12, R0 * 0.4 * (0.9 + 0.2 * big), REGION.LEAF, fol, crown, { outward: [c[0], c[1] - yc + 0.08, c[2]], shell: 0.7 });
    b.endClump();
  }
  return b.build(R0, sp);
}

function buildBirch(seed: number): THREE.BufferGeometry {
  const sp = BIRCH;
  const R0 = SPECIES_R0[sp];
  const b = new Builder();
  const rnd = mulberry32(seed);
  const fol = FOLIAGE[sp];
  const bark = BARK[sp];
  const lean = 0.015 + (rnd() - 0.5) * 0.02;
  limb(b, [0, -0.05, 0], [lean, 0.5, 0], 0.014, 0.01, 6, bark, REGION.BIRCHBARK, 0.85, 1);
  limb(b, [lean, 0.5, 0], [lean * 1.5, 0.9, 0.005], 0.01, 0.004, 5, bark, REGION.BIRCHBARK, 0.85, 1);
  const crown: Crown = { cx: 0, cy: 0.62, cz: 0, rx: R0, ry: 0.36 };
  const N = 8;
  for (let i = 0; i < N; i++) {
    const f = i / (N - 1);
    const a = i * 2.39996 + rnd() * 0.4;
    const y = 0.36 + 0.55 * f;
    const d = R0 * (0.45 - 0.2 * f) * (0.8 + 0.4 * rnd());
    const c: V3 = [Math.cos(a) * d + lean, y, Math.sin(a) * d];
    limb(b, [lean * 1.2, y - 0.08, 0], [c[0] * 0.8, y, c[2] * 0.8], 0.004, 0.002, 3, bark, REGION.BIRCHBARK, 0.7, 0.8);
    const rx = R0 * (0.5 - 0.15 * f);
    b.beginClump(c[0], c[1], c[2], rx, 0.14);
    lobe(b, rnd, c, rx, 0.14, 14, R0 * 0.5, REGION.SMALL, fol, crown, { outward: [c[0], 0, c[2]], hang: 0.55, shell: 0.35 });
    b.endClump();
  }
  return b.build(R0, sp);
}

function buildPoplar(seed: number): THREE.BufferGeometry {
  const sp = POPLAR;
  const R0 = SPECIES_R0[sp];
  const b = new Builder();
  const rnd = mulberry32(seed);
  const fol = FOLIAGE[sp];
  limb(b, [0, -0.05, 0], [0, 0.6, 0], 0.012, 0.006, 6, BARK[sp], REGION.BARK);
  const crown: Crown = { cx: 0, cy: 0.55, cz: 0, rx: R0, ry: 0.45 };
  const N = 8;
  for (let i = 0; i < N; i++) {
    const f = i / (N - 1);
    const y = 0.16 + 0.76 * f;
    const w = Math.sin(Math.PI * (0.12 + 0.8 * Math.pow(f, 0.85))) * 0.9 + 0.1;
    const c: V3 = [(rnd() - 0.5) * R0 * 0.2, y, (rnd() - 0.5) * R0 * 0.2];
    const rx = R0 * 0.8 * w;
    b.beginClump(c[0], c[1], c[2], rx, 0.1);
    core(b, c, rx * 0.6, 0.07, fol, 0.7);
    lobe(b, rnd, c, rx, 0.1, 15, R0 * 0.8, REGION.LEAF, fol, crown, { upright: 0.7, shell: 0.55 });
    b.endClump();
  }
  return b.build(R0, sp);
}

function buildWillow(seed: number): THREE.BufferGeometry {
  const sp = WILLOW;
  const R0 = SPECIES_R0[sp];
  const b = new Builder();
  const rnd = mulberry32(seed);
  const fol = FOLIAGE[sp];
  const bark = BARK[sp];
  limb(b, [0, -0.05, 0], [0.04, 0.4, 0.01], 0.05, 0.035, 8, bark, REGION.BARK);
  const crown: Crown = { cx: 0, cy: 0.62, cz: 0, rx: R0, ry: 0.36 };
  const N = 6;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * TAU + rnd() * 0.5;
    const d = i === 0 ? 0 : R0 * (0.45 + 0.1 * rnd());
    const c: V3 = [Math.cos(a) * d, 0.72 + 0.1 * rnd(), Math.sin(a) * d];
    limb(b, [0.04, 0.38, 0.01], [c[0] * 0.7, c[1] - 0.06, c[2] * 0.7], 0.018, 0.008, 5, bark, REGION.BARK, 0.6, 0.7);
    b.beginClump(c[0], c[1], c[2], R0 * 0.42, 0.14);
    core(b, c, R0 * 0.32, 0.11, fol, 0.55);
    lobe(b, rnd, c, R0 * 0.42, 0.14, 14, R0 * 0.42, REGION.SMALL, fol, crown, { outward: [c[0], 0.3, c[2]], hang: 0.4 });
    b.endClump();
  }
  // the curtain of hanging strands around the dome, in 6 groups (clumps hanging from the rim)
  const strands = 26;
  const groups = 6;
  for (let i = 0; i < strands; i++) {
    const a = (i / strands) * TAU + (rnd() - 0.5) * 0.2;
    const rr = R0 * (0.62 + 0.3 * rnd());
    const top = 0.84 - 0.2 * (rr / R0 - 0.6) + 0.04 * rnd();
    const bottom = 0.16 + 0.22 * rnd();
    const h = top - bottom;
    const c: V3 = [Math.cos(a) * rr, (top + bottom) / 2, Math.sin(a) * rr];
    const g = Math.floor((i / strands) * groups);
    const ga = ((g + 0.5) / groups) * TAU;
    // the group hangs from a point under the rim: shrinking it shortens and gathers the strands
    b.beginClump(Math.cos(ga) * R0 * 0.62, 0.8, Math.sin(ga) * R0 * 0.62, R0 * 0.4, 0.35);
    card(b, c, [Math.cos(a), 0.1, Math.sin(a)], [0, 1, 0], R0 * 0.3, h, REGION.STRAND, fol, crown, 0.55, rnd() < 0.5, 0.95);
    b.endClump();
  }
  return b.build(R0, sp);
}

function buildBush(seed: number): THREE.BufferGeometry {
  const sp = BUSH;
  const R0 = SPECIES_R0[sp];
  const b = new Builder();
  const rnd = mulberry32(seed);
  const fol = FOLIAGE[sp];
  const crown: Crown = { cx: 0, cy: 0.4, cz: 0, rx: R0, ry: 0.55 };
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU;
    limb(b, [0, -0.05, 0], [Math.cos(a) * R0 * 0.3, 0.45, Math.sin(a) * R0 * 0.3], 0.03, 0.012, 4, BARK[sp], REGION.BARK, 0.5, 0.6);
  }
  const lobes: { c: V3; rx: number; ry: number }[] = [{ c: [0, 0.6, 0], rx: R0 * 0.55, ry: 0.4 }];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + 0.4 + (rnd() - 0.5) * 0.4;
    lobes.push({ c: [Math.cos(a) * R0 * 0.45, 0.3 + 0.12 * rnd(), Math.sin(a) * R0 * 0.45], rx: R0 * 0.45, ry: 0.3 });
  }
  for (const l of lobes) {
    b.beginClump(l.c[0], l.c[1], l.c[2], l.rx, l.ry);
    core(b, l.c, l.rx * 0.7, l.ry * 0.7, fol, 0.55);
    lobe(b, rnd, l.c, l.rx, l.ry, 12, R0 * 0.45, REGION.LEAF, fol, crown, { outward: [l.c[0], l.c[1] - 0.2, l.c[2]], shell: 0.65 });
    b.endClump();
  }
  return b.build(R0, sp);
}

const builders = [buildSpruce, buildPine, buildBroadleaf, buildBirch, buildPoplar, buildWillow, buildBush];
if (builders.length !== SPECIES_COUNT) throw new Error('species builders out of sync');

/**
 * The normalised mesh of a species (a new geometry each call). `seed` picks a
 * variant; omitted, the default tree the game draws.
 */
export function buildSpeciesGeometry(species: number, seed?: number): THREE.BufferGeometry {
  const s = seed === undefined ? DEFAULT_SEEDS[species] : (Math.abs(Math.floor(seed)) % 0x7fffffff) || 1;
  return builders[species](s);
}

/** Number of foliage clumps of a species mesh (ids 0 … n−1 in the `clump` attribute). */
export function clumpCount(g: THREE.BufferGeometry): number {
  const c = g.getAttribute('clump') as THREE.BufferAttribute | undefined;
  if (!c) return 0;
  let m = -1;
  for (let i = 0; i < c.count; i++) m = Math.max(m, c.getW(i));
  return m + 1;
}

export function triangleCount(g: THREE.BufferGeometry): number {
  return g.index ? g.index.count / 3 : g.getAttribute('position').count / 3;
}
