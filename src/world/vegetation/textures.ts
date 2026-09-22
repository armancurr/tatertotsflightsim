/**
 * Procedural foliage + bark atlas (one RGBA8 sRGB DataTexture, mipmapped),
 * painted in plain JS from a seeded PRNG — deterministic, no canvas, no
 * network, works in node tests too. Regions (UV space, v up):
 *
 *   LEAF      [0, .5] × [.5, 1]   broadleaf spray: overlapping oval leaves on twigs
 *   NEEDLE    [.5, 1] × [.5, 1]   conifer spray: a fishbone of needle twigs
 *   SMALL     [0, .5] × [0, .5]   small leaves (birch, willow crowns, shrubs)
 *   STRAND    [.5, .625] × [0, .5] hanging willow strands (tall)
 *   CANOPY    [.625, .75] × [0, .5] opaque shadowed leaf mass (crown interiors)
 *   BARK      [.75, .875] × [0, .5] furrowed brown bark (opaque)
 *   BIRCHBARK [.875, 1] × [0, .5] white birch bark with dark lenticels (opaque)
 *
 * Leaf texels are near-neutral light green (value ≈ 0.55–0.85 sRGB) so the
 * species colour comes from the mesh's vertex colours × per-instance tint;
 * alpha is the leaf coverage. Transparent texels carry leaf colour so filtering
 * never produces dark fringes.
 */
import * as THREE from 'three';
import { mulberry32 } from '../noise';

export interface UvRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

export const REGION = {
  LEAF: { u0: 0, v0: 0.5, u1: 0.5, v1: 1 },
  NEEDLE: { u0: 0.5, v0: 0.5, u1: 1, v1: 1 },
  SMALL: { u0: 0, v0: 0, u1: 0.5, v1: 0.5 },
  STRAND: { u0: 0.5, v0: 0, u1: 0.625, v1: 0.5 },
  CANOPY: { u0: 0.625, v0: 0, u1: 0.75, v1: 0.5 },
  BARK: { u0: 0.75, v0: 0, u1: 0.875, v1: 0.5 },
  BIRCHBARK: { u0: 0.875, v0: 0, u1: 1, v1: 0.5 },
} as const satisfies Record<string, UvRect>;

export interface FoliageTextures {
  map: THREE.DataTexture;
  size: number;
  /** Raw RGBA pixels (row 0 = v 0). */
  pixels: Uint8Array;
}

class Canvas {
  readonly px: Uint8Array;
  // accumulation in float for soft painting
  readonly r: Float32Array;
  readonly g: Float32Array;
  readonly b: Float32Array;
  readonly a: Float32Array;
  constructor(readonly size: number) {
    this.px = new Uint8Array(size * size * 4);
    this.r = new Float32Array(size * size);
    this.g = new Float32Array(size * size);
    this.b = new Float32Array(size * size);
    this.a = new Float32Array(size * size);
  }
  /** Paints colour (sRGB 0..1) with coverage `cov` over pixel (x, y) (y = row, v up). */
  put(x: number, y: number, cr: number, cg: number, cb: number, cov: number): void {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size || cov <= 0) return;
    const i = y * this.size + x;
    const k = cov > 1 ? 1 : cov;
    this.r[i] += (cr - this.r[i]) * k;
    this.g[i] += (cg - this.g[i]) * k;
    this.b[i] += (cb - this.b[i]) * k;
    this.a[i] = this.a[i] + (1 - this.a[i]) * k;
  }
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Paints an oval leaf (length L px, width W px) at (cx, cy) along angle `ang`. */
function leaf(c: Canvas, cx: number, cy: number, L: number, W: number, ang: number, col: [number, number, number], rnd: () => number, clip: UvRect): void {
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  const R = Math.ceil(Math.max(L, W)) + 1;
  const x0 = Math.max(Math.floor(clip.u0 * c.size), Math.floor(cx - R));
  const x1 = Math.min(Math.ceil(clip.u1 * c.size) - 1, Math.ceil(cx + R));
  const y0 = Math.max(Math.floor(clip.v0 * c.size), Math.floor(cy - R));
  const y1 = Math.min(Math.ceil(clip.v1 * c.size) - 1, Math.ceil(cy + R));
  const shade = 0.82 + 0.3 * rnd();
  const tilt = rnd() * 2 - 1; // light falls across the leaf from one side
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const u = (dx * ca + dy * sa) / L; // -1..1 along the leaf (0 = middle)
      const v = (-dx * sa + dy * ca) / W; // across
      // pointed oval: width shrinks toward the tip (u → 1) and the stalk end
      const t = (u + 1) / 2;
      const half = Math.sin(Math.PI * Math.pow(clamp01(t), 0.8));
      const e = Math.abs(v) - half;
      if (e > 0.12 || t < 0 || t > 1) continue;
      const cov = clamp01((0.12 - e) / 0.18);
      const vein = Math.abs(v) < 0.06 ? 1.12 : 1;
      const side = 1 + 0.12 * tilt * Math.sign(v) - 0.1 * Math.abs(v);
      const k = shade * vein * side * (0.9 + 0.1 * t);
      c.put(x, y, col[0] * k, col[1] * k, col[2] * k, cov);
    }
}

/** A straight soft line (twig / needle) from (x0,y0) to (x1,y1), width w px. */
function line(c: Canvas, x0: number, y0: number, x1: number, y1: number, w: number, col: [number, number, number], clip: UvRect, cov0 = 1): void {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(1, Math.ceil(len * 1.5));
  const r = w / 2;
  const ux0 = Math.floor(clip.u0 * c.size);
  const ux1 = Math.ceil(clip.u1 * c.size) - 1;
  const vy0 = Math.floor(clip.v0 * c.size);
  const vy1 = Math.ceil(clip.v1 * c.size) - 1;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const px = x0 + (x1 - x0) * t;
    const py = y0 + (y1 - y0) * t;
    const rr = r * (1 - 0.5 * t);
    for (let y = Math.floor(py - rr - 1); y <= Math.ceil(py + rr + 1); y++)
      for (let x = Math.floor(px - rr - 1); x <= Math.ceil(px + rr + 1); x++) {
        if (x < ux0 || x > ux1 || y < vy0 || y > vy1) continue;
        const d = Math.hypot(x + 0.5 - px, y + 0.5 - py);
        const cov = clamp01(rr + 0.5 - d) * cov0;
        if (cov > 0) c.put(x, y, col[0], col[1], col[2], cov * 0.6);
      }
  }
}

function paintBroadleaf(c: Canvas, rnd: () => number, reg: UvRect, leafL: number, leafW: number, grid: number, leavesPer: number, colBase: [number, number, number]): void {
  const S = c.size;
  const X0 = reg.u0 * S;
  const Y0 = reg.v0 * S;
  const W = (reg.u1 - reg.u0) * S;
  const H = (reg.v1 - reg.v0) * S;
  const twig: [number, number, number] = [0.36, 0.3, 0.22];
  // Leaf rosettes on a jittered grid over a disc (ragged round card), each on a twig
  // pointing back toward the card centre; a darker back layer first, then the lit front.
  for (const layer of [0, 1]) {
    const dark = layer === 0 ? 0.6 : 1;
    const g = layer === 0 ? grid - 1 : grid;
    for (let j = 0; j < g; j++)
      for (let i = 0; i < g; i++) {
        const u = (i + 0.2 + 0.6 * rnd()) / g - 0.5;
        const v = (j + 0.2 + 0.6 * rnd()) / g - 0.5;
        const r = Math.hypot(u, v);
        if (r > 0.42 + 0.06 * rnd()) continue;
        const cx = X0 + W * (0.5 + u);
        const cy = Y0 + H * (0.5 + v);
        const out = Math.atan2(v, u);
        line(c, cx, cy, cx - Math.cos(out) * W * 0.07, cy - Math.sin(out) * H * 0.07, 1.8, twig, reg, 0.6);
        const base = out + (rnd() - 0.5) * 1.2;
        for (let k = 0; k < leavesPer; k++) {
          const la = base + ((k - (leavesPer - 1) / 2) / leavesPer) * 3.4 + (rnd() - 0.5) * 0.4;
          const L = leafL * (0.75 + 0.5 * rnd());
          const col: [number, number, number] = [colBase[0] * (0.9 + 0.2 * rnd()) * dark, colBase[1] * (0.94 + 0.1 * rnd()) * dark, colBase[2] * (0.8 + 0.35 * rnd()) * dark];
          leaf(c, cx + Math.cos(la) * L * 0.9, cy + Math.sin(la) * L * 0.9, L, leafW * (0.8 + 0.4 * rnd()), la, col, rnd, reg);
        }
      }
  }
}

/** Opaque shadowed leaf mass: densely overlapping dark leaves on a dark ground. */
function paintCanopy(c: Canvas, rnd: () => number, reg: UvRect, leafL: number, leafW: number): void {
  const S = c.size;
  const x0 = Math.floor(reg.u0 * S);
  const x1 = Math.ceil(reg.u1 * S);
  const y0 = Math.floor(reg.v0 * S);
  const y1 = Math.ceil(reg.v1 * S);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) c.put(x, y, 0.3, 0.38, 0.24, 1);
  const n = Math.round(((x1 - x0) * (y1 - y0)) / (leafL * leafW * 0.9));
  for (let i = 0; i < n; i++) {
    const k = 0.45 + 0.4 * rnd();
    leaf(c, x0 + rnd() * (x1 - x0), y0 + rnd() * (y1 - y0), leafL * (0.8 + 0.4 * rnd()), leafW, rnd() * 6.283, [0.62 * k, 0.78 * k, 0.48 * k], rnd, reg);
  }
}

function paintNeedles(c: Canvas, rnd: () => number, reg: UvRect): void {
  const S = c.size;
  const X0 = reg.u0 * S;
  const Y0 = reg.v0 * S;
  const W = (reg.u1 - reg.u0) * S;
  const H = (reg.v1 - reg.v0) * S;
  const twig: [number, number, number] = [0.4, 0.33, 0.24];
  // one broad branch spray along v (bottom = trunk end): a main axis, side twigs, dense needles.
  const bx = X0 + W * 0.5;
  const by0 = Y0 + H * 0.02;
  const by1 = Y0 + H * 0.96;
  for (const layer of [0, 1]) {
    const dark = layer === 0 ? 0.6 : 1;
    const nTw = layer === 0 ? 16 : 22;
    for (let t = 0; t < nTw; t++) {
      const f = (t + rnd() * 0.8) / nTw;
      const py = by0 + (by1 - by0) * f;
      const axisX = bx + Math.sin(f * 3.1) * W * 0.02;
      for (const side of [-1, 1]) {
        // the spray is widest in the middle third, narrow at both ends (leaf-shaped outline)
        const env = Math.sin(Math.PI * Math.min(1, Math.pow(f, 0.75) * 1.02)) * 0.44 + 0.08;
        const len = W * env * (0.75 + 0.3 * rnd());
        const a = side * (0.55 + 0.35 * rnd()); // angle from the axis (toward the tip)
        const tx = axisX + Math.sin(a) * len;
        const ty = py + Math.cos(a) * len * 0.55;
        line(c, axisX, py, tx, ty, 2.4, twig, reg, 0.9);
        const nN = Math.max(8, Math.floor(len / 2.2));
        for (let k = 0; k < nN; k++) {
          const g = (k + rnd()) / nN;
          const nx = axisX + (tx - axisX) * g;
          const ny = py + (ty - py) * g;
          const tw = Math.atan2(ty - py, tx - axisX);
          for (const s2 of [-1, 1]) {
            const na = tw + s2 * (0.7 + 0.5 * rnd());
            const nl = (9 + 6 * rnd()) * (1 - 0.4 * g);
            const shade = (0.72 + 0.4 * rnd()) * dark;
            line(c, nx, ny, nx + Math.cos(na) * nl, ny + Math.sin(na) * nl, 3.2, [0.6 * shade, 0.8 * shade, 0.58 * shade], reg);
          }
        }
      }
    }
  }
  line(c, bx, by0, bx, by1, 4.5, twig, reg);
}

function paintStrands(c: Canvas, rnd: () => number, reg: UvRect): void {
  const S = c.size;
  const X0 = reg.u0 * S;
  const Y0 = reg.v0 * S;
  const W = (reg.u1 - reg.u0) * S;
  const H = (reg.v1 - reg.v0) * S;
  const strands = 6;
  for (let s = 0; s < strands; s++) {
    const x = X0 + W * ((s + 0.5) / strands) + (rnd() - 0.5) * 8;
    const top = Y0 + H * (0.97 - 0.05 * rnd());
    const bottom = Y0 + H * (0.05 + 0.25 * rnd());
    const sway = (rnd() - 0.5) * 14;
    line(c, x, top, x + sway, bottom, 1.5, [0.45, 0.42, 0.28], reg, 0.8);
    const n = Math.floor((top - bottom) / 6);
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const px = x + sway * t;
      const py = top + (bottom - top) * t;
      const side = k % 2 === 0 ? 1 : -1;
      const la = -Math.PI / 2 + side * (0.35 + 0.25 * rnd());
      const L = 9 + 4 * rnd();
      const col: [number, number, number] = [0.66 + 0.08 * rnd(), 0.78, 0.6 + 0.1 * rnd()];
      leaf(c, px + Math.cos(la) * L * 0.9, py + Math.sin(la) * L * 0.9, L, 2.2, la, col, rnd, reg);
    }
  }
}

function paintBark(c: Canvas, rnd: () => number, reg: UvRect, birch: boolean): void {
  const S = c.size;
  const x0 = Math.floor(reg.u0 * S);
  const x1 = Math.ceil(reg.u1 * S);
  const y0 = Math.floor(reg.v0 * S);
  const y1 = Math.ceil(reg.v1 * S);
  const W = x1 - x0;
  // vertical furrow noise: sum of a few sines with random phases, warped along v
  const ph = Array.from({ length: 6 }, () => rnd() * Math.PI * 2);
  const marks: { x: number; y: number; w: number; h: number }[] = [];
  if (birch) for (let i = 0; i < 70; i++) marks.push({ x: x0 + rnd() * W, y: y0 + rnd() * (y1 - y0), w: 3 + 10 * rnd(), h: 1 + 2.5 * rnd() });
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const u = ((x - x0) / W) * Math.PI * 2;
      const v = (y - y0) / 40;
      const w = 0.6 * Math.sin(v * 0.7 + ph[0]) + 0.3 * Math.sin(v * 1.9 + ph[1]);
      const f =
        0.5 * Math.sin(u * 5 + w * 2 + ph[2]) + 0.3 * Math.sin(u * 11 + w * 3 + ph[3]) + 0.2 * Math.sin(u * 23 + v * 0.8 + ph[4]);
      const grain = rnd() * 0.12;
      if (birch) {
        let k = 0.86 + 0.08 * f + grain * 0.6;
        c.put(x, y, k * 0.93, k * 0.92, k * 0.88, 1);
        void k;
      } else {
        const ridge = f > 0.15 ? 1 : 0.55 + 0.45 * clamp01(f + 0.6);
        const k = (0.34 + 0.14 * ridge + grain) * 0.95;
        c.put(x, y, k * 1.05, k * 0.9, k * 0.74, 1);
      }
    }
  if (birch)
    for (const m of marks)
      for (let y = Math.floor(m.y - m.h); y <= Math.ceil(m.y + m.h); y++)
        for (let x = Math.floor(m.x - m.w); x <= Math.ceil(m.x + m.w); x++) {
          const dx = (x - m.x) / m.w;
          const dy = (y - m.y) / m.h;
          const d = dx * dx + dy * dy;
          if (d > 1) continue;
          const xx = x0 + ((((x - x0) % W) + W) % W);
          if (y >= y0 && y < y1) c.put(xx, y, 0.12, 0.11, 0.1, clamp01((1 - d) * 3));
        }
}

/** Fills transparent texels with the average leaf colour of their region (no dark fringes when filtering). */
function bleed(c: Canvas, reg: UvRect): void {
  const S = c.size;
  const x0 = Math.floor(reg.u0 * S);
  const x1 = Math.ceil(reg.u1 * S);
  const y0 = Math.floor(reg.v0 * S);
  const y1 = Math.ceil(reg.v1 * S);
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let n = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i = y * S + x;
      if (c.a[i] > 0.5) {
        sr += c.r[i] / c.a[i];
        sg += c.g[i] / c.a[i];
        sb += c.b[i] / c.a[i];
        n++;
      }
    }
  if (n === 0) return;
  sr /= n;
  sg /= n;
  sb /= n;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i = y * S + x;
      const a = c.a[i];
      if (a >= 0.999) continue;
      // un-premultiply what was painted, blend toward the region average where empty
      const k = a > 1e-3 ? 1 / a : 0;
      c.r[i] = c.r[i] * k * a + sr * (1 - a);
      c.g[i] = c.g[i] * k * a + sg * (1 - a);
      c.b[i] = c.b[i] * k * a + sb * (1 - a);
    }
}

let cached: FoliageTextures | null = null;

/** The shared foliage atlas (built once). */
export function getFoliageTextures(size = 1024): FoliageTextures {
  if (cached && cached.size === size) return cached;
  const c = new Canvas(size);
  const rnd = mulberry32(0x7ee5);
  const sc = size / 1024;
  paintBroadleaf(c, rnd, REGION.LEAF, 21 * sc, 10.5 * sc, 9, 6, [0.66, 0.8, 0.5]);
  paintNeedles(c, rnd, REGION.NEEDLE);
  paintBroadleaf(c, rnd, REGION.SMALL, 13 * sc, 7 * sc, 12, 6, [0.72, 0.82, 0.5]);
  paintStrands(c, rnd, REGION.STRAND);
  paintCanopy(c, rnd, REGION.CANOPY, 16 * sc, 8 * sc);
  paintBark(c, rnd, REGION.BARK, false);
  paintBark(c, rnd, REGION.BIRCHBARK, true);
  for (const r of [REGION.LEAF, REGION.NEEDLE, REGION.SMALL, REGION.STRAND]) bleed(c, r);
  const px = c.px;
  for (let i = 0; i < size * size; i++) {
    px[i * 4] = Math.round(clamp01(c.r[i]) * 255);
    px[i * 4 + 1] = Math.round(clamp01(c.g[i]) * 255);
    px[i * 4 + 2] = Math.round(clamp01(c.b[i]) * 255);
    px[i * 4 + 3] = Math.round(clamp01(c.a[i]) * 255);
  }
  const map = new THREE.DataTexture(px, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  map.colorSpace = THREE.SRGBColorSpace;
  map.generateMipmaps = true;
  map.minFilter = THREE.LinearMipmapLinearFilter;
  map.magFilter = THREE.LinearFilter;
  map.wrapS = THREE.ClampToEdgeWrapping;
  map.wrapT = THREE.ClampToEdgeWrapping;
  map.anisotropy = 4;
  map.name = 'vegetation-foliage';
  map.needsUpdate = true;
  cached = { map, size, pixels: px };
  return cached;
}
