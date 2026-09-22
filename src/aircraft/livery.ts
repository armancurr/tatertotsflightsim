/**
 * Procedural livery. Each texel of the fuselage texture is mapped back onto
 * the analytic fuselage surface (same (t, z) parameterisation as the loft), and
 * the paint scheme is evaluated there in metres: window cut-outs (alpha, used
 * with alphaTest) and their seals, the two-tone swoosh stripe, anti-glare
 * panel, door and cowl panel lines, gear wells and the registration.
 *
 * Needs a DOM canvas only for the registration lettering; returns null
 * without one (node tests).
 */
import * as THREE from 'three';
import { CONFIG } from '../config';
import { CABIN_Z0, CABIN_Z1 } from './fuselage';
import {
  DOOR_OUTLINE,
  DOOR_WINDOW,
  FUSE_Z0,
  FUSE_Z1,
  PILLAR,
  REAR_SIDE_WINDOW,
  REAR_WINDOW,
  arcToAngle,
  fuselageSection,
  pillarY,
  rearWindowLowerY,
  windshieldBaseZ,
  type SectionParams,
} from './shape';

export const COLORS = {
  white: [242, 242, 238],
  navy: [24, 44, 92],
  gold: [196, 150, 52],
  antiGlare: [22, 22, 24],
  seal: [28, 30, 33],
  well: [48, 48, 50],
  headliner: [196, 188, 170],
  wall: [150, 142, 128],
  lowerWall: [86, 80, 74],
  carpet: [60, 57, 54],
} as const;

/** Fin texture covers this side-view box (z, y). */
export const FIN_UV = { z0: 2.1, z1: 6.05, y0: 0.15, y1: 1.55 };

/** Paint seal band (m) round each window, and the inset of the cabin trim openings. */
const SEAL = 0.013;
const CABIN_INSET = 0.028;

// ─── 2D distance helpers (side view: p = (z, y)) ─────────────────────────────

type Poly = ReadonlyArray<readonly [number, number]>;

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/** Signed distance to a convex polygon (negative inside). */
function sdPoly(poly: Poly, px: number, py: number): number {
  let d = Infinity;
  let pos = 0;
  let neg = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    d = Math.min(d, segDist(px, py, a[0], a[1], b[0], b[1]));
    const c = (b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0]);
    if (c > 0) pos++;
    else if (c < 0) neg++;
  }
  const inside = pos === 0 || neg === 0;
  return inside ? -d : d;
}

/** Inset a convex polygon by r (for rounded corners: sd(inset) − r). */
function insetPoly(poly: Poly, r: number): Array<[number, number]> {
  const n = poly.length;
  // Orientation sign.
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const s = area > 0 ? 1 : -1;
  const lines: Array<{ px: number; py: number; dx: number; dy: number }> = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = Math.hypot(dx, dy);
    // Inward normal for CCW (s>0) is (−dy, dx).
    const nx = (-dy / l) * s;
    const ny = (dx / l) * s;
    lines.push({ px: a[0] + nx * r, py: a[1] + ny * r, dx, dy });
  }
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const L1 = lines[(i + n - 1) % n];
    const L2 = lines[i];
    const den = L1.dx * L2.dy - L1.dy * L2.dx;
    const t = ((L2.px - L1.px) * L2.dy - (L2.py - L1.py) * L2.dx) / den;
    out.push([L1.px + L1.dx * t, L1.py + L1.dy * t]);
  }
  return out;
}

function roundedPoly(poly: Poly, r: number) {
  const inner = insetPoly(poly, r);
  return (px: number, py: number) => sdPoly(inner, px, py) - r;
}

/** Signed distance to an open polyline: + on the left of the travel direction (above for a rising line). */
function sdPolyline(pts: Poly, px: number, py: number): number {
  let best = Infinity;
  let sign = 1;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const d = segDist(px, py, a[0], a[1], b[0], b[1]);
    if (d < best) {
      best = d;
      const c = (b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0]);
      sign = c >= 0 ? 1 : -1;
    }
  }
  return best * sign;
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

// ─── Scheme ──────────────────────────────────────────────────────────────────

/**
 * One swoosh centreline (side view) shared by the fuselage and fin textures:
 * along the fuselage under the windows, kicking up behind the cabin, then
 * sweeping up the dorsal fillet and the fin to the rudder top.
 */
const SWOOSH: Array<[number, number]> = (() => {
  const ctrl = [
    new THREE.Vector2(-2.0, -0.08),
    new THREE.Vector2(-1.2, -0.035),
    new THREE.Vector2(0.0, 0.015),
    new THREE.Vector2(1.0, 0.055),
    new THREE.Vector2(1.8, 0.12),
    new THREE.Vector2(2.4, 0.235),
    new THREE.Vector2(3.2, 0.3),
    new THREE.Vector2(3.8, 0.33),
    new THREE.Vector2(4.25, 0.4),
    new THREE.Vector2(4.7, 0.56),
    new THREE.Vector2(5.2, 0.83),
    new THREE.Vector2(5.65, 1.1),
    new THREE.Vector2(6.15, 1.42),
  ];
  const curve = new THREE.SplineCurve(ctrl);
  return curve.getSpacedPoints(400).map((p) => [p.x, p.y] as [number, number]);
})();
const doorWindowSd = roundedPoly(DOOR_WINDOW, 0.055);
const rearSideSd = roundedPoly(REAR_SIDE_WINDOW, 0.06);
const doorOutlineSd = roundedPoly(DOOR_OUTLINE, 0.04);
const baggageSd = roundedPoly(
  [
    [1.62, -0.2],
    [1.62, 0.15],
    [2.06, 0.15],
    [2.06, -0.2],
  ],
  0.035,
);
const PILLAR_DZ = PILLAR.z1 - PILLAR.z0;
const PILLAR_DY = PILLAR.y1 - PILLAR.y0;
const PILLAR_L = Math.hypot(PILLAR_DZ, PILLAR_DY);
const RW_COS = Math.cos(Math.atan2(REAR_WINDOW.yFront - REAR_WINDOW.yBack, REAR_WINDOW.z1 - REAR_WINDOW.z0));

/** Registration box on the rear fuselage (side view). */
const REG = { z0: 2.25, z1: 3.45, yBottom: -0.115, yTop: 0.105 };

/**
 * Positive-inside distance (m) to the nearest window opening at a skin point
 * (x, y, z) whose section is `sec`, or a negative number outside every window.
 */
export function windowDistance(x: number, y: number, z: number, sec: SectionParams): number {
  const ax = Math.abs(x);
  let d = -1;
  // Windshield: aft of its curved base, above the A-pillars, ahead of the wing.
  if (z > -1.4 && z < -0.4 && y > 0.1) {
    const d1 = z - windshieldBaseZ(ax);
    // Distance to the pillar measured in the section plane (round the cabin corner).
    const pY = pillarY(z);
    let xp: number;
    if (pY <= sec.widthY) xp = sec.halfWidth;
    else if (pY >= sec.top) xp = 0;
    else xp = sec.halfWidth * Math.pow(1 - Math.pow((pY - sec.widthY) / (sec.top - sec.widthY), sec.nTop), 1 / sec.nTop);
    const d2 = (y > pY ? 1 : -1) * Math.hypot(ax - xp, y - pY);
    const d3 = -0.5 - z;
    d = Math.max(d, Math.min(d1, d2, d3));
  }
  if (ax > 0.2 && z > -1.0 && z < 1.6 && y > 0.3) {
    d = Math.max(d, -doorWindowSd(z, y), -rearSideSd(z, y));
  }
  if (z > REAR_WINDOW.z0 - 0.05 && z < REAR_WINDOW.z1 + 0.05 && y > 0.4) {
    const d1 = z - REAR_WINDOW.z0;
    const d2 = REAR_WINDOW.z1 - z;
    const d3 = (y - rearWindowLowerY(z)) * RW_COS;
    d = Math.max(d, Math.min(d1, d2, d3));
  }
  return d;
}

interface Texel {
  r: number;
  g: number;
  b: number;
  a: number;
  clear: number;
  rough: number;
}

function set(t: Texel, c: readonly number[], clear: number, rough: number) {
  t.r = c[0];
  t.g = c[1];
  t.b = c[2];
  t.clear = clear;
  t.rough = rough;
}

/** Blend toward a paint by coverage k (0..1) — anti-aliased edges. */
function mix(t: Texel, c: readonly number[], clear: number, rough: number, k: number) {
  if (k <= 0) return;
  if (k >= 1) return set(t, c, clear, rough);
  t.r += (c[0] - t.r) * k;
  t.g += (c[1] - t.g) * k;
  t.b += (c[2] - t.b) * k;
  t.clear += (clear - t.clear) * k;
  t.rough += (rough - t.rough) * k;
}

function shade(t: Texel, k: number) {
  t.r *= k;
  t.g *= k;
  t.b *= k;
}

/** Texel footprint (m) used to anti-alias edges; set per texture. */
let AA = 0.004;
/** Coverage of a signed distance (positive inside) over one texel. */
const cov = (d: number) => (d >= AA * 0.5 ? 1 : d <= -AA * 0.5 ? 0 : d / AA + 0.5);
/** Coverage of a thin line of half-width w at distance d. */
const lineCov = (d: number, w: number) => cov(w - Math.abs(d));

function paintSkin(
  x: number,
  y: number,
  z: number,
  nx: number,
  ny: number,
  sec: SectionParams,
  reg: RegistrationSampler | null,
  t: Texel,
) {
  const ax = Math.abs(x);
  set(t, COLORS.white, 1, 0.3);
  t.a = 255;
  const side = Math.abs(nx) > 0.3;

  // Gear wells and bays on the belly (dark, matte).
  if (ny < -0.2) {
    let k = 0;
    if (ny < -0.5 && z > -1.4 && z < -0.3) k = Math.max(k, cov(Math.min(0.125 - ax, z + 1.33, -0.37 - z)));
    k = Math.max(k, cov(0.2 - Math.hypot(ax - 0.23, z - 1.36)));
    k = Math.max(k, cov(0.042 - segDist(ax, z, 0.46, 0.33, 0.23, 1.36)));
    if (k > 0) {
      mix(t, COLORS.well, 0, 0.9, k);
      if (k >= 1) return;
    }
  }

  // Anti-glare panel on the cowling top.
  if (z < windshieldBaseZ(ax) + 0.01 && ny > 0.35) {
    const w = 0.09 + 0.12 * smooth(-1.97, -1.35, z);
    const front = -1.955 + 0.05 * (ax / w) * (ax / w);
    mix(t, COLORS.antiGlare, 0, 0.8, cov(Math.min(w - ax, z - front, windshieldBaseZ(ax) + 0.004 - z)));
  }

  // Swoosh stripe: navy band with a gold pinstripe under it (and a fine one above on the tail).
  if (Math.abs(nx) > 0.2 && z > -1.965) {
    const d = swooshDistance(z, y);
    const fade = cov(z + 1.93);
    stripe(t, d, fade);
  }

  // Registration (black) on both sides of the rear fuselage.
  if (reg && side && z > REG.z0 && z < REG.z1 && y > REG.yBottom && y < REG.yTop) {
    const u = x < 0 ? (z - REG.z0) / (REG.z1 - REG.z0) : (REG.z1 - z) / (REG.z1 - REG.z0);
    const v = (REG.yTop - y) / (REG.yTop - REG.yBottom);
    const k = reg(u, v) / 255;
    if (k > 0) mix(t, [20, 22, 26], t.clear, t.rough, k);
  }

  // Panel lines: cowl joint and split line, doors, baggage door, tailcone rivet rows.
  let line = 0;
  if (y < 0.25) line = Math.max(line, lineCov(z + 1.235, 0.0022));
  if (z < -1.235 && z > -1.95 && side) line = Math.max(line, lineCov(y + 0.07, 0.002));
  if (ax > 0.2 && z > -1.05 && z < 0.4) line = Math.max(line, lineCov(doorOutlineSd(z, y), 0.0024));
  if (x < -0.2 && z > 1.55 && z < 2.12) line = Math.max(line, lineCov(baggageSd(z, y), 0.0024));
  if (line > 0) shade(t, 1 - 0.4 * line);
  if (ax > 0.2 && z > 0.1 && z < 0.26) mix(t, [70, 72, 76], 0, 0.4, cov(Math.min(0.011 - Math.abs(y - 0.2), 0.06 - Math.abs(z - 0.18))));
  for (const zr of [2.35, 2.95, 3.55, 4.15, 4.75]) {
    const k = lineCov(z - zr, 0.0012);
    if (k > 0) shade(t, 1 - 0.1 * k);
  }

  // Faint exhaust stain along the lower right side.
  if (x > 0 && z > -1.3 && z < 1.2) {
    const k = Math.exp(-(((y + 0.4) / 0.07) ** 2)) * smooth(1.2, -1.2, z) * 0.14;
    shade(t, 1 - k);
  }

  // Windows: seal band, then the hole. Alpha ramps over a texel so alpha-testing
  // finds the true (sub-texel) edge.
  const dw = windowDistance(x, y, z, sec);
  if (dw > -AA) {
    mix(t, COLORS.seal, 0, 0.55, cov(dw));
    t.a = Math.round(255 * (1 - cov(dw - SEAL)));
  }
}

function paintCabin(x: number, y: number, z: number, sec: SectionParams, t: Texel) {
  t.a = 255;
  set(t, COLORS.wall, 0, 0.9);
  if (y > 0.8) set(t, COLORS.headliner, 0, 0.95);
  else if (y < -0.36) set(t, COLORS.carpet, 0, 1);
  else if (y < 0.22) set(t, COLORS.lowerWall, 0, 0.9);
  // Door trim line and a seam between the cabin sides and headliner.
  const seam = Math.max(lineCov(y - 0.8, 0.003), lineCov(y - 0.22, 0.0025));
  if (seam > 0) shade(t, 1 - 0.2 * seam);
  const dw = windowDistance(x, y, z, sec);
  if (dw > -AA) {
    mix(t, [118, 112, 102], 0, 0.7, cov(dw));
    t.a = Math.round(255 * (1 - cov(dw - CABIN_INSET)));
  }
}

/** Signed distance to the swoosh, searching only the segments near z (the curve is monotone in z). */
function swooshDistance(z: number, y: number): number {
  let lo = 0;
  let hi = SWOOSH.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (SWOOSH[mid][0] > z) hi = mid;
    else lo = mid;
  }
  // Early out: distance to the local tangent line (the curve bends gently) is far from the band.
  {
    const a = SWOOSH[lo];
    const b = SWOOSH[Math.min(lo + 1, SWOOSH.length - 1)];
    const dz = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = Math.hypot(dz, dy) || 1;
    const perp = Math.abs(((y - a[1]) * dz - (z - a[0]) * dy) / l);
    if (perp > 0.3) return (y > a[1] ? 1 : -1) * perp;
  }
  const i0 = Math.max(0, lo - 30);
  const i1 = Math.min(SWOOSH.length - 1, lo + 31);
  let best = Infinity;
  let sign = 1;
  for (let i = i0; i < i1; i++) {
    const a = SWOOSH[i];
    const b = SWOOSH[i + 1];
    const d = segDist(z, y, a[0], a[1], b[0], b[1]);
    if (d < best) {
      best = d;
      sign = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (z - a[0]) >= 0 ? 1 : -1;
    }
  }
  return best * sign;
}

function stripe(t: Texel, d: number, fade: number) {
  if (Math.abs(d) > 0.2) return;
  mix(t, COLORS.navy, 1, 0.28, cov(0.055 - Math.abs(d)) * fade);
  mix(t, COLORS.gold, 1, 0.28, cov(0.0175 - Math.abs(d + 0.095)) * fade);
}

// ─── Registration lettering ──────────────────────────────────────────────────

type RegistrationSampler = (u: number, v: number) => number;

function makeRegistrationSampler(text: string): RegistrationSampler | null {
  if (typeof document === 'undefined') return null;
  const W = 1400;
  const H = 256;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'alphabetic';
  // Block letters, cap height fills the box (FAA-style sans).
  let size = 300;
  ctx.font = `700 ${size}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  const m = ctx.measureText('N');
  const cap = m.actualBoundingBoxAscent || size * 0.72;
  size = Math.floor((size * (H * 0.98)) / cap);
  ctx.font = `700 ${size}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  const width = ctx.measureText(text).width;
  const sx = Math.min(1, (W * 0.98) / width);
  ctx.save();
  ctx.translate(W * 0.01, H * 0.99);
  ctx.scale(sx, 1);
  // Slight letter spacing like painted registrations.
  let penX = 0;
  for (const ch of text) {
    ctx.fillText(ch, penX, 0);
    penX += ctx.measureText(ch).width + size * 0.02;
  }
  ctx.restore();
  const img = ctx.getImageData(0, 0, W, H).data;
  return (u: number, v: number) => {
    const fx = u * (W - 1);
    const fy = v * (H - 1);
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    if (x0 < 0 || y0 < 0 || x0 >= W - 1 || y0 >= H - 1) return 0;
    const ax = fx - x0;
    const ay = fy - y0;
    const i00 = (y0 * W + x0) * 4 + 3;
    const i10 = i00 + 4;
    const i01 = i00 + W * 4;
    const i11 = i01 + 4;
    return (img[i00] * (1 - ax) + img[i10] * ax) * (1 - ay) + (img[i01] * (1 - ax) + img[i11] * ax) * ay;
  };
}

// ─── Texture generation ──────────────────────────────────────────────────────

export interface FuselageTextures {
  /** RGBA: paint colours, alpha = window holes (use with alphaTest). */
  map: THREE.DataTexture;
  /** R = clearcoat, G = roughness (for clearcoatMap + roughnessMap). */
  orm: THREE.DataTexture;
  /** Cabin inner shell: trim colours, alpha = (slightly smaller) window openings. */
  cabin: THREE.DataTexture;
  /** Fin/rudder side-view livery (FIN_UV mapping). */
  fin: THREE.DataTexture;
}

function dataTexture(data: Uint8Array, w: number, h: number, srgb: boolean): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

/** Evaluate the skin (x, y and a rough outward normal) for a section at parameter t. */
function evalSection(s: SectionParams, sn: number, cs: number, out: { x: number; y: number; nx: number; ny: number }) {
  const upper = cs >= 0;
  const n = upper ? s.nTop : s.nBot;
  const e = 2 / n;
  const h = upper ? s.top - s.widthY : s.widthY - s.bottom;
  const px = Math.pow(Math.abs(sn), e);
  const py = Math.pow(Math.abs(cs), e);
  out.x = -s.halfWidth * Math.sign(sn) * px;
  out.y = s.widthY + (upper ? 1 : -1) * h * py;
  // Implicit-surface gradient of |x/W|^n + |dy/H|^n = 1.
  const gx = (Math.sign(out.x) * Math.pow(px, n - 1)) / s.halfWidth;
  const gy = ((upper ? 1 : -1) * Math.pow(py, n - 1)) / h;
  const l = Math.hypot(gx, gy) || 1;
  out.nx = gx / l;
  out.ny = gy / l;
}

export function createFuselageTextures(quality: 'high' | 'low'): FuselageTextures | null {
  if (typeof document === 'undefined') return null;
  const reg = makeRegistrationSampler(CONFIG.aircraft.registration);
  const W = quality === 'high' ? 1024 : 512; // around (u = t, arc length)
  const H = quality === 'high' ? 2048 : 1024; // along (v = z)
  const map = new Uint8Array(W * H * 4);
  const orm = new Uint8Array(W * H * 4);
  const sec: SectionParams = { top: 0, bottom: 0, halfWidth: 1, widthY: 0, nTop: 2, nBot: 2 };
  const ts = new Float64Array(W);
  for (let c = 0; c < W; c++) ts[c] = (c + 0.5) / W;
  const angles = new Float64Array(W);
  const p = { x: 0, y: 0, nx: 0, ny: 0 };
  const t: Texel = { r: 0, g: 0, b: 0, a: 255, clear: 1, rough: 0.3 };
  AA = Math.max((FUSE_Z1 - FUSE_Z0) / H, 3.6 / W) * 1.2;
  for (let r = 0; r < H; r++) {
    const z = FUSE_Z0 + ((r + 0.5) / H) * (FUSE_Z1 - FUSE_Z0);
    fuselageSection(z, sec);
    arcToAngle(sec, ts, angles);
    for (let c = 0; c < W; c++) {
      const th = 2 * Math.PI * angles[c];
      evalSection(sec, Math.sin(th), Math.cos(th), p);
      paintSkin(p.x, p.y, z, p.nx, p.ny, sec, reg, t);
      const i = (r * W + c) * 4;
      map[i] = t.r;
      map[i + 1] = t.g;
      map[i + 2] = t.b;
      map[i + 3] = t.a;
      orm[i] = t.clear * 255;
      orm[i + 1] = t.rough * 255;
      orm[i + 2] = 0;
      orm[i + 3] = 255;
    }
  }

  // Cabin inner shell (same t mapping, its own z range).
  const CW = W;
  const CH = H / 2;
  const cab = new Uint8Array(CW * CH * 4);
  const ci = { x: 0, y: 0, nx: 0, ny: 0 };
  AA = Math.max((CABIN_Z1 - CABIN_Z0) / CH, 3.6 / CW) * 1.2;
  for (let r = 0; r < CH; r++) {
    const z = CABIN_Z0 + ((r + 0.5) / CH) * (CABIN_Z1 - CABIN_Z0);
    fuselageSection(z, sec);
    arcToAngle(sec, ts, angles);
    for (let c = 0; c < CW; c++) {
      const th = 2 * Math.PI * angles[c];
      evalSection(sec, Math.sin(th), Math.cos(th), ci);
      paintCabin(ci.x, ci.y, z, sec, t);
      const i = (r * CW + c) * 4;
      cab[i] = t.r;
      cab[i + 1] = t.g;
      cab[i + 2] = t.b;
      cab[i + 3] = t.a;
    }
  }

  return {
    map: dataTexture(map, W, H, true),
    orm: dataTexture(orm, W, H, false),
    cabin: dataTexture(cab, CW, CH, true),
    fin: createFinTexture(quality),
  };
}

// ─── Fin ─────────────────────────────────────────────────────────────────────

function createFinTexture(quality: 'high' | 'low'): THREE.DataTexture {
  const W = quality === 'high' ? 1024 : 512;
  const H = quality === 'high' ? 384 : 192;
  const data = new Uint8Array(W * H * 4);
  const tx: Texel = { r: 0, g: 0, b: 0, a: 255, clear: 1, rough: 0.3 };
  AA = Math.max((FIN_UV.z1 - FIN_UV.z0) / W, (FIN_UV.y1 - FIN_UV.y0) / H) * 1.2;
  for (let r = 0; r < H; r++) {
    const y = FIN_UV.y0 + ((r + 0.5) / H) * (FIN_UV.y1 - FIN_UV.y0);
    for (let c = 0; c < W; c++) {
      const z = FIN_UV.z0 + ((c + 0.5) / W) * (FIN_UV.z1 - FIN_UV.z0);
      const d = swooshDistance(z, y);
      tx.r = COLORS.white[0];
      tx.g = COLORS.white[1];
      tx.b = COLORS.white[2];
      stripe(tx, d, 1);
      const i = (r * W + c) * 4;
      data[i] = tx.r;
      data[i + 1] = tx.g;
      data[i + 2] = tx.b;
      data[i + 3] = 255;
    }
  }
  const tex = dataTexture(data, W, H, true);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  return tex;
}
