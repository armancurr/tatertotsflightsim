/**
 * Procedural livery. Each texel of the fuselage texture is mapped back onto
 * the analytic fuselage surface (same (t, z) parameterisation as the loft), and
 * the paint scheme is evaluated there in metres: window cut-outs (alpha, used
 * with alphaTest) and their seals, the two-tone swoosh stripe, anti-glare
 * panel, door and cowl panel lines, gear wells, and the decals (the Tater
 * mascot, registration and name — rasterised with canvas 2D in decals.ts).
 *
 * The painter itself (`paintLivery`) is pure: it runs in node, in a worker or on
 * the main thread. `createFuselageTextures` needs a DOM canvas for the decals and
 * returns null without one (node tests); its pixels are cached per quality, so
 * rebuilding the model (aircraft switching) is instant.
 */
import * as THREE from 'three';
import { CONFIG } from '../config';
import { sampleDecal, rasterizeLiveryDecals, type DecalSample, type LiveryDecals } from './decals';
import { CABIN_Z0, CABIN_Z1 } from './fuselage';
import { wellCutDistance } from './gearKinematics';
import { HEADER, POST, postSideDistance } from './cabinTrim';
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
  // Cabin (1980s 172RG grey interior): light vinyl headliner, grey plastic upper trim round the
  // windows, dark grey windshield posts and header, grey vinyl sides, charcoal kick panels and carpet.
  headliner: [168, 166, 160],
  upperTrim: [104, 105, 107],
  post: [54, 55, 58],
  wall: [92, 93, 96],
  lowerWall: [64, 65, 68],
  carpet: [46, 47, 50],
  windowSeal: [30, 30, 32],
} as const;

/** Fin texture covers this side-view box (z, y). */
export const FIN_UV = { z0: 2.1, z1: 6.05, y0: 0.15, y1: 1.55 };

/** Paint seal band (m) round each window, and the inset of the cabin trim openings. */
const SEAL = 0.013;
/** Kept just above SEAL so the inner trim hides the wall thickness but the door posts stay slim. */
export const CABIN_INSET = 0.015;

// ─── 2D distance helpers (side view: p = (z, y)) ─────────────────────────────

type Poly = ReadonlyArray<readonly [number, number]>;

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  const ex = px - ax - t * dx;
  const ey = py - ay - t * dy;
  return Math.sqrt(ex * ex + ey * ey);
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

/** Signed distance (m, negative inside) to the cabin door outline in side view (z, y). */
export function doorOutlineDistance(z: number, y: number): number {
  return doorOutlineSd(z, y);
}

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
    const d2 = (y > pY ? 1 : -1) * Math.sqrt((ax - xp) * (ax - xp) + (y - pY) * (y - pY));
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
  /** Surface relief (m): panel-line grooves < 0, rivet heads > 0 (→ the normal map). */
  h: number;
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
/** Texel size along z and around the section (m), for decal filtering; set per texture. */
let AA_Z = 0.004;
let AA_Y = 0.003;
const _ds: DecalSample = { r: 0, g: 0, b: 0, a: 0 };
/** Coverage of a signed distance (positive inside) over one texel. */
const cov = (d: number) => (d >= AA * 0.5 ? 1 : d <= -AA * 0.5 ? 0 : d / AA + 0.5);
/** Coverage of a thin line of half-width w at distance d. */
const lineCov = (d: number, w: number) => cov(w - Math.abs(d));

/**
 * Panel-line groove depth and rivet head height (m), rivet pitch and head radius (m). Depths are
 * exaggerated ~3× over the real 0.3–0.5 mm: a texel is 3.6 mm, so true slopes would average away.
 */
const GROOVE = 0.0013;
const RIVET_H = 0.0008;
const RIVET_PITCH = 0.032;
const RIVET_R = 0.0028;
const RIVET_FRAMES = [1.5, 2.35, 2.95, 3.55, 4.15, 4.75];

/** Height of a rivet head at a skin point `dz` from a rivet row (rivets spaced along the ring). */
function rivet(x: number, y: number, dz: number, sec: SectionParams): number {
  const radius = (sec.halfWidth + (sec.top - sec.bottom) / 2) / 2;
  const arc = Math.atan2(y - sec.widthY, Math.abs(x)) * radius;
  const f = arc / RIVET_PITCH - Math.floor(arc / RIVET_PITCH) - 0.5;
  const d2 = (f * RIVET_PITCH) ** 2 + dz * dz;
  return d2 < RIVET_R * RIVET_R ? RIVET_H * (1 - d2 / (RIVET_R * RIVET_R)) : 0;
}

function paintSkin(
  x: number,
  y: number,
  z: number,
  nx: number,
  ny: number,
  sec: SectionParams,
  decals: LiveryDecals | null,
  t: Texel,
) {
  const ax = Math.abs(x);
  set(t, COLORS.white, 1, 0.3);
  t.a = 255;
  t.h = 0;
  const side = Math.abs(nx) > 0.3;

  // Belly openings (main wheel wells, leg slots, nose well): holes in the skin (alpha) with a
  // slightly darker, worn edge lip; the recessed liners behind them come from wells.ts.
  if (y < sec.widthY - 0.05 && ny < -0.2) {
    const d = wellCutDistance(x, z);
    if (d > -0.02) {
      mix(t, [150, 152, 150], 0.3, 0.6, cov(d + 0.006) * 0.6);
      t.a = Math.round(255 * (1 - cov(d)));
      if (t.a === 0) return;
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

  // Decals: the mascot (same image both sides, always flying toward the nose), then the
  // registration and name (mirrored in z on the right so they read from both sides).
  if (decals && Math.abs(nx) > 0.08) {
    const edge = smooth(0.08, 0.3, Math.abs(nx));
    if (decals.art) {
      sampleDecal(decals.art, z, y, AA_Z, AA_Y, _ds);
      if (_ds.a > 0) mix(t, [_ds.r, _ds.g, _ds.b], 1, 0.3, _ds.a * edge);
    }
    if (decals.text) {
      const tz = x < 0 ? z : decals.text.z0 + decals.text.z1 - z;
      sampleDecal(decals.text, tz, y, AA_Z, AA_Y, _ds);
      if (_ds.a > 0) mix(t, [_ds.r, _ds.g, _ds.b], 1, 0.3, _ds.a * edge);
    }
  }

  // Panel lines: cowl joint and split line, doors, baggage door, tailcone rivet rows.
  let line = 0;
  if (y < 0.25) line = Math.max(line, lineCov(z + 1.235, 0.0022));
  if (z < -1.235 && z > -1.95 && side) line = Math.max(line, lineCov(y + 0.07, 0.002));
  if (ax > 0.2 && z > -1.05 && z < 0.4) line = Math.max(line, lineCov(doorOutlineSd(z, y), 0.0024));
  if (x < -0.2 && z > 1.55 && z < 2.12) line = Math.max(line, lineCov(baggageSd(z, y), 0.0024));
  if (line > 0) {
    shade(t, 1 - 0.4 * line);
    t.h -= GROOVE * line;
  }
  if (ax > 0.2 && z > 0.1 && z < 0.26) mix(t, [70, 72, 76], 0, 0.4, cov(Math.min(0.011 - Math.abs(y - 0.2), 0.06 - Math.abs(z - 0.18))));
  // Tailcone frames and the firewall joint: rows of round rivet heads (faint seam + domes).
  for (const zr of RIVET_FRAMES) {
    const dz = z - zr;
    if (Math.abs(dz) > Math.max(0.006, AA)) continue;
    const k = lineCov(dz, 0.0012);
    if (k > 0) {
      shade(t, 1 - 0.08 * k);
      t.h -= GROOVE * 0.6 * k;
    }
    t.h += rivet(x, y, dz, sec);
  }
  if (y < 0.25 && Math.abs(z + 1.215) < 0.006) t.h += rivet(x, y, z + 1.215, sec);

  // Exhaust soot: streaks swept aft from the stack under the right cowl, spreading and fading
  // along the lower right side and belly; oil mist from the cowl-flap exit along the belly.
  if (x > 0 && z > -1.34 && z < 1.6 && y < sec.widthY) {
    const run = z + 1.34;
    const spread = 0.05 + run * 0.06;
    const lane = sec.bottom + 0.1 + run * 0.035;
    const across = Math.exp(-(((y - lane) / spread) ** 2));
    const streaks = 0.55 + 0.45 * Math.sin(y * 170 + Math.sin(z * 2.3) * 3 + x * 40) * Math.sin(y * 61 - z * 1.7);
    const k = across * streaks * smooth(1.6, -1.1, z) * 0.42 * smooth(-1.36, -1.28, z);
    if (k > 0.004) mix(t, [58, 54, 50], t.clear * 0.6, 0.55, k);
  }
  if (ny < -0.6 && z > -1.25 && z < 2.0) {
    const streak = 0.5 + 0.5 * Math.sin(x * 210 + Math.sin(z * 4) * 2);
    const k = Math.exp(-((x / 0.09) ** 2)) * streak * smooth(2.0, -1.2, z) * 0.22;
    if (k > 0.004) mix(t, [96, 78, 52], t.clear, 0.4, k);
  }

  // Windows: seal band, then the hole. Alpha ramps over a texel so alpha-testing
  // finds the true (sub-texel) edge.
  const dw = windowDistance(x, y, z, sec);
  if (dw > -AA) {
    mix(t, COLORS.seal, 0, 0.55, cov(dw));
    t.a = Math.round(255 * (1 - cov(dw - SEAL)));
  }
}

/**
 * How far (m) a cabin-shell point is inside an opening of the shell (> 0 open, < 0 solid): the
 * window openings inset by CABIN_INSET, and — next to each windshield post — the shell opened right
 * up to the post moulding (cabinTrim.ts), so the post is the slim moulding, not a band of wall.
 */
export function cabinOpenDistance(x: number, y: number, z: number, sec: SectionParams): number {
  const dw = windowDistance(x, y, z, sec);
  let d = dw - CABIN_INSET;
  if (Math.abs(x) > 0.2 && z < -0.4 && y > POST.openY0 - 0.02 && y < POST.openY1 + 0.02) {
    const s = postSideDistance(z, y);
    const as = Math.abs(s);
    if (as < POST.corridorHalf + 0.03) {
      // Only in the strips between the moulding and a window edge (never beyond a window's end).
      const nearWindow = s > 0 ? dw + 0.03 : 0.016 - doorWindowSd(z, y);
      const open = Math.min(as - POST.halfWidth + 0.004, nearWindow, y - POST.openY0, POST.openY1 - y);
      d = Math.max(d, open);
    }
  }
  return d;
}

/** Cheap deterministic texel noise in [−1, 1] (vinyl grain, headliner perforation). */
function grain(x: number, y: number, z: number): number {
  const h = Math.sin(x * 1291.7 + y * 3117.3 + z * 2371.1) * 43758.5453;
  return (h - Math.floor(h)) * 2 - 1;
}

function paintCabin(x: number, y: number, z: number, sec: SectionParams, t: Texel) {
  t.a = 255;
  const ax = Math.abs(x);
  set(t, COLORS.wall, 0, 0.85);
  if (y > 0.8) {
    // Headliner: light vinyl stretched over bows every 0.25 m — seams, a little pillowing between them.
    set(t, COLORS.headliner, 0, 0.95);
    const f = (z + 0.47) / 0.25;
    const u = f - Math.floor(f);
    shade(t, 0.93 + 0.07 * Math.sin(u * Math.PI));
    if (z > -0.45 && z < 1.9) shade(t, 1 - 0.28 * lineCov(Math.min(u, 1 - u) * 0.25, 0.0022));
    shade(t, 1 + 0.012 * grain(x, y, z));
  } else if (y < -0.36) {
    set(t, COLORS.carpet, 0, 1);
    shade(t, 1 + 0.08 * grain(x, y, z));
  } else if (y < 0.22) {
    set(t, z < -0.97 ? COLORS.lowerWall : COLORS.wall, 0, 0.85);
    shade(t, 1 + 0.025 * grain(x, y, z));
  } else {
    set(t, COLORS.upperTrim, 0, 0.7);
    shade(t, 1 + 0.01 * grain(x, y, z));
  }
  // Seams: headliner edge, the upper trim over the door panels, and the door's own gap.
  const seam = Math.max(lineCov(y - 0.8, 0.003), lineCov(y - 0.22, 0.0025));
  if (seam > 0) shade(t, 1 - 0.3 * seam);
  if (ax > 0.3) {
    const gap = lineCov(doorOutlineDistance(z, y), 0.0025);
    if (gap > 0) shade(t, 1 - 0.55 * gap);
  }
  // Windshield posts and header: dark grey moulded plastic (the 3D mouldings sit on this band).
  if (ax > 0.2 && z < -0.35 && y > 0.25) {
    const s = postSideDistance(z, y);
    mix(t, COLORS.post, 0, 0.6, cov(POST.corridorHalf + 0.012 - Math.abs(s)));
  }
  if (y > 0.78) mix(t, COLORS.post, 0, 0.6, cov(Math.min(z - HEADER.z0 + 0.012, HEADER.z1 + 0.012 - z)));
  // Window reveals: a black rubber seal at the glass, then the opening.
  const dw = windowDistance(x, y, z, sec);
  if (dw > CABIN_INSET - 0.02) mix(t, COLORS.windowSeal, 0, 0.6, cov(dw - CABIN_INSET + 0.006));
  const open = cabinOpenDistance(x, y, z, sec);
  t.a = Math.round(255 * (1 - cov(open)));
}

/** The cabin shell's paint at a shell point (sRGB 0–255 and alpha), for checks and previews. */
export function cabinTexel(x: number, y: number, z: number, sec: SectionParams, aa = 0.004): [number, number, number, number] {
  const prev = AA;
  AA = aa;
  const t: Texel = { r: 0, g: 0, b: 0, a: 255, clear: 0, rough: 1, h: 0 };
  paintCabin(x, y, z, sec, t);
  AA = prev;
  return [t.r, t.g, t.b, t.a];
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
    const l = Math.sqrt(dz * dz + dy * dy) || 1;
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

// ─── Texture generation ──────────────────────────────────────────────────────

export interface FuselageTextures {
  /** RGBA: paint colours, alpha = window holes (use with alphaTest). */
  map: THREE.DataTexture;
  /** R = clearcoat, G = roughness (for clearcoatMap + roughnessMap). */
  orm: THREE.DataTexture;
  /** Tangent-space normal map: panel-line grooves and rivet heads. */
  normal: THREE.DataTexture;
  /** Cabin inner shell: trim colours, alpha = (slightly smaller) window openings. */
  cabin: THREE.DataTexture;
  /** Fin/rudder side-view livery (FIN_UV mapping). */
  fin: THREE.DataTexture;
  /** Resolves once the full livery is in the textures (they start as plain paint while it is painted off-thread). */
  ready: Promise<void>;
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
  const l = Math.sqrt(gx * gx + gy * gy) || 1;
  out.nx = gx / l;
  out.ny = gy / l;
}

/** Raw pixels of every livery texture (what the painter produces; transferable from a worker). */
export interface LiveryPixels {
  map: Uint8Array;
  orm: Uint8Array;
  /** Tangent-space normal map of the skin relief (panel-line grooves, rivet heads). */
  normal: Uint8Array;
  cabin: Uint8Array;
  fin: Uint8Array;
  size: { w: number; h: number; cw: number; ch: number; fw: number; fh: number };
}

/** Texture sizes per quality. */
export function liverySizes(quality: 'high' | 'low') {
  const w = quality === 'high' ? 1024 : 512; // around (u = t, arc length)
  const h = quality === 'high' ? 2048 : 1024; // along (v = z)
  return { w, h, cw: w, ch: h / 2, fw: quality === 'high' ? 1024 : 512, fh: quality === 'high' ? 384 : 192 };
}

/**
 * Paint every livery texture. Pure (no DOM): `decals` come from `rasterizeLiveryDecals`, or null
 * for a plain scheme. Deterministic for the same inputs.
 */
export function paintLivery(quality: 'high' | 'low', decals: LiveryDecals | null): LiveryPixels {
  const size = liverySizes(quality);
  const { w: W, h: H } = size;
  const map = new Uint8Array(W * H * 4);
  const orm = new Uint8Array(W * H * 4);
  const relief = new Float32Array(W * H);
  const texelU = new Float32Array(H);
  const sec: SectionParams = { top: 0, bottom: 0, halfWidth: 1, widthY: 0, nTop: 2, nBot: 2 };
  const ts = new Float64Array(W);
  for (let c = 0; c < W; c++) ts[c] = (c + 0.5) / W;
  const angles = new Float64Array(W);
  const p = { x: 0, y: 0, nx: 0, ny: 0 };
  const t: Texel = { r: 0, g: 0, b: 0, a: 255, clear: 1, rough: 0.3, h: 0 };
  AA = Math.max((FUSE_Z1 - FUSE_Z0) / H, 3.6 / W) * 1.2;
  AA_Z = (FUSE_Z1 - FUSE_Z0) / H;
  AA_Y = 3.4 / W;
  for (let r = 0; r < H; r++) {
    const z = FUSE_Z0 + ((r + 0.5) / H) * (FUSE_Z1 - FUSE_Z0);
    fuselageSection(z, sec);
    arcToAngle(sec, ts, angles);
    // Arc length per texel column (ellipse-perimeter approximation of the section).
    const a = sec.halfWidth;
    const b = (sec.top - sec.bottom) / 2;
    texelU[r] = (2 * Math.PI * Math.sqrt((a * a + b * b) / 2)) / W;
    for (let c = 0; c < W; c++) {
      const th = 2 * Math.PI * angles[c];
      evalSection(sec, Math.sin(th), Math.cos(th), p);
      paintSkin(p.x, p.y, z, p.nx, p.ny, sec, decals, t);
      relief[r * W + c] = t.h;
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
  const { cw: CW, ch: CH } = size;
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

  return { map, orm, normal: reliefNormals(relief, W, H, texelU, (FUSE_Z1 - FUSE_Z0) / H), cabin: cab, fin: paintFin(size.fw, size.fh, decals), size };
}

/** Tangent-space normals (u around the ring, wrapping; v along z) from the relief height field. */
function reliefNormals(hgt: Float32Array, W: number, H: number, du: Float32Array, dv: number): Uint8Array {
  const out = new Uint8Array(W * H * 4);
  for (let r = 0; r < H; r++) {
    const r0 = Math.max(0, r - 1) * W;
    const r1 = Math.min(H - 1, r + 1) * W;
    const row = r * W;
    const su = 1 / (2 * du[r]);
    const sv = 1 / (2 * dv);
    for (let c = 0; c < W; c++) {
      const cl = c === 0 ? W - 1 : c - 1;
      const cr = c === W - 1 ? 0 : c + 1;
      const gx = (hgt[row + cr] - hgt[row + cl]) * su;
      const gy = (hgt[r1 + c] - hgt[r0 + c]) * sv;
      const inv = 1 / Math.sqrt(gx * gx + gy * gy + 1);
      const i = (row + c) * 4;
      out[i] = Math.round((-gx * inv * 0.5 + 0.5) * 255);
      out[i + 1] = Math.round((-gy * inv * 0.5 + 0.5) * 255);
      out[i + 2] = Math.round((inv * 0.5 + 0.5) * 255);
      out[i + 3] = 255;
    }
  }
  return out;
}

const pixelCache = new Map<string, LiveryPixels>();
const pending = new Map<string, Promise<LiveryPixels>>();

/** Wrap painted pixels as the model's textures (the arrays are copied, so cached pixels stay intact). */
export function liveryTextures(px: LiveryPixels, ready: Promise<void> = Promise.resolve()): FuselageTextures {
  const { w, h, cw, ch, fw, fh } = px.size;
  const fin = dataTexture(px.fin.slice(), fw, fh, true);
  fin.wrapS = THREE.ClampToEdgeWrapping;
  return {
    map: dataTexture(px.map.slice(), w, h, true),
    orm: dataTexture(px.orm.slice(), w, h, false),
    normal: dataTexture(px.normal.slice(), w, h, false),
    cabin: dataTexture(px.cabin.slice(), cw, ch, true),
    fin,
    ready,
  };
}

/** Plain paint of the final texture sizes, shown for the moment the livery takes to paint. */
function placeholderPixels(quality: 'high' | 'low'): LiveryPixels {
  const size = liverySizes(quality);
  const fill = (n: number, c: readonly number[], a = 255) => {
    const out = new Uint8Array(n * 4);
    for (let i = 0; i < n * 4; i += 4) {
      out[i] = c[0];
      out[i + 1] = c[1];
      out[i + 2] = c[2];
      out[i + 3] = a;
    }
    return out;
  };
  return {
    map: fill(size.w * size.h, COLORS.white),
    orm: fill(size.w * size.h, [255, 77, 0]),
    normal: fill(size.w * size.h, [128, 128, 255]),
    cabin: fill(size.cw * size.ch, COLORS.wall),
    fin: fill(size.fw * size.fh, COLORS.white),
    size,
  };
}

/** Paint on this thread (DOM canvas for the decals). */
function paintHere(quality: 'high' | 'low', registration: string): LiveryPixels {
  const decals = rasterizeLiveryDecals((w, h) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return { getContext: (type: '2d') => c.getContext(type, { willReadFrequently: true }) };
  }, registration);
  return paintLivery(quality, decals);
}

/** Paint in a worker (OffscreenCanvas); falls back to this thread when workers or OffscreenCanvas 2D are missing. */
function paintAsync(quality: 'high' | 'low', registration: string): Promise<LiveryPixels> {
  const key = `${quality}|${registration}`;
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const job = new Promise<LiveryPixels>((resolve) => {
    const fallback = () => setTimeout(() => resolve(paintHere(quality, registration)), 0);
    if (typeof Worker === 'undefined') return fallback();
    let worker: Worker;
    try {
      worker = new Worker(new URL('./livery.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      return fallback();
    }
    worker.onmessage = (e: MessageEvent<{ ok: boolean; px?: LiveryPixels }>) => {
      worker.terminate();
      if (e.data.ok && e.data.px) resolve(e.data.px);
      else fallback();
    };
    worker.onerror = () => {
      worker.terminate();
      fallback();
    };
    worker.postMessage({ id: 1, quality, registration });
  }).then((px) => {
    pixelCache.set(key, px);
    pending.delete(key);
    return px;
  });
  pending.set(key, job);
  return job;
}

/**
 * The fuselage, cabin and fin textures with the full livery. Null without a DOM (node tests).
 * The first call per quality returns plain-paint textures at once and fills in the livery when
 * the worker has painted it (`ready`); later calls come from the pixel cache, already painted.
 */
export function createFuselageTextures(quality: 'high' | 'low'): FuselageTextures | null {
  if (typeof document === 'undefined') return null;
  const registration = CONFIG.aircraft.registration;
  const cached = pixelCache.get(`${quality}|${registration}`);
  if (cached) return liveryTextures(cached);
  let tex: FuselageTextures | null = null;
  let disposed = false;
  const ready = paintAsync(quality, registration).then((px) => {
    if (!tex || disposed) return;
    const pairs: Array<[THREE.DataTexture, Uint8Array]> = [
      [tex.map, px.map],
      [tex.orm, px.orm],
      [tex.normal, px.normal],
      [tex.cabin, px.cabin],
      [tex.fin, px.fin],
    ];
    for (const [t, data] of pairs) {
      (t.image.data as Uint8Array).set(data);
      t.needsUpdate = true;
    }
  });
  tex = liveryTextures(placeholderPixels(quality), ready);
  tex.map.addEventListener('dispose', () => {
    disposed = true;
  });
  return tex;
}

// ─── Fin ─────────────────────────────────────────────────────────────────────

function paintFin(W: number, H: number, decals: LiveryDecals | null): Uint8Array {
  const data = new Uint8Array(W * H * 4);
  const tx: Texel = { r: 0, g: 0, b: 0, a: 255, clear: 1, rough: 0.3, h: 0 };
  const dz = (FIN_UV.z1 - FIN_UV.z0) / W;
  const dy = (FIN_UV.y1 - FIN_UV.y0) / H;
  AA = Math.max(dz, dy) * 1.2;
  for (let r = 0; r < H; r++) {
    const y = FIN_UV.y0 + ((r + 0.5) / H) * (FIN_UV.y1 - FIN_UV.y0);
    for (let c = 0; c < W; c++) {
      const z = FIN_UV.z0 + ((c + 0.5) / W) * (FIN_UV.z1 - FIN_UV.z0);
      const d = swooshDistance(z, y);
      tx.r = COLORS.white[0];
      tx.g = COLORS.white[1];
      tx.b = COLORS.white[2];
      stripe(tx, d, 1);
      if (decals?.fin) {
        sampleDecal(decals.fin, z, y, dz, dy, _ds);
        if (_ds.a > 0) mix(tx, [_ds.r, _ds.g, _ds.b], 1, 0.3, _ds.a);
      }
      const i = (r * W + c) * 4;
      data[i] = tx.r;
      data[i + 1] = tx.g;
      data[i + 2] = tx.b;
      data[i + 3] = 255;
    }
  }
  return data;
}
