/**
 * Geometry for the aids to navigation (traffic MeshBuilder, batched PBR material): the Gull Island
 * lighthouse (a tapered white tower with red bands, gallery, glazed lantern, domed cupola, the
 * keeper's house) built round the tower's foot, and one pillar buoy per IALA kind in its body frame
 * (waterline at y = 0): red can (port hand), green cone (starboard hand), red-and-white safe water
 * with a red ball, and the four cardinals in their black-and-yellow bands with double-cone topmarks.
 * Dimensions: LIGHTHOUSE_DIMS / BUOY_DIMS in navaids.ts (the obstacles use the same).
 */
import { MeshBuilder, mat, type Mat } from '../traffic/models/builder';
import { BUOY_DIMS, LIGHTHOUSE_DIMS, type BuoyKind, type Lighthouse } from './navaids';

const WHITE = mat(0xf1f0ec, 0.5);
const RED = mat(0xb3261e, 0.5);
const RED_BRIGHT = mat(0xc8231a, 0.45);
const GREEN = mat(0x1f7a3a, 0.5);
const YELLOW = mat(0xf0c419, 0.5);
const BLACK = mat(0x1b1c1e, 0.55);
const STEEL = mat(0x8a8f95, 0.45, 0.7);
const DARK = mat(0x2a2b2d, 0.5, 0.4);
const GLASS = mat(0x223038, 0.05, 0.3);
const WINDOWS = mat(0x16202a, 0.08, 0.2, 0, -1);
const ROOF = mat(0x8e3b2c, 0.8);
const STONE = mat(0x9b958a, 0.9);
const BRASS = mat(0xb08d57, 0.35, 0.8);

/** A sphere (latitude rings) centred at (x, y, z). */
function sphere(b: MeshBuilder, x: number, y: number, z: number, r: number, m: Mat, seg = 10): void {
  const rings: [number, number, number][][] = [];
  for (let i = 0; i <= seg / 2; i++) {
    const phi = (i / (seg / 2)) * Math.PI;
    const ring: [number, number, number][] = [];
    for (let j = 0; j < seg; j++) {
      const th = (j / seg) * Math.PI * 2;
      ring.push([x + r * Math.sin(phi) * Math.cos(th), y + r * Math.cos(phi), z - r * Math.sin(phi) * Math.sin(th)]);
    }
    rings.push(ring);
  }
  b.loft(rings, () => m, true);
}

/** The lighthouse and the keeper's house, origin at the tower's foot (x, groundY, z). */
export function buildLighthouse(lh: Lighthouse, lod = 0): MeshBuilder {
  const b = new MeshBuilder();
  const L = LIGHTHOUSE_DIMS;
  const H = L.towerH;
  const rAt = (y: number) => L.baseR + ((L.topR - L.baseR) * y) / H;
  const seg = lod ? 10 : 20;
  // the tower in bands: white, red, white, red, white (a red band at a third and at two-thirds)
  const bands: [number, number, Mat][] = [[-2.5, 6, WHITE], [6, 9.5, RED], [9.5, 13.5, WHITE], [13.5, 17, RED], [17, H, WHITE]];
  for (const [y0, y1, m] of bands) b.cylinder([0, y0, 0], [0, y1, 0], rAt(Math.max(0, y0)), rAt(y1), seg, m, false);
  // a stone plinth round the foot
  b.cylinder([0, -1.5, 0], [0, 0.6, 0], L.baseR + 0.9, L.baseR + 0.7, seg, STONE);
  // gallery slab and railing
  b.cylinder([0, H - 0.1, 0], [0, H + 0.3, 0], L.galleryR, L.galleryR, seg, DARK);
  if (!lod) {
    b.cylinder([0, H + 1.25, 0], [0, H + 1.33, 0], L.galleryR - 0.05, L.galleryR - 0.05, seg, DARK, false);
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const r = L.galleryR - 0.08;
      b.cylinder([r * Math.cos(a), H + 0.3, r * Math.sin(a)], [r * Math.cos(a), H + 1.3, r * Math.sin(a)], 0.035, 0.035, 4, DARK, false);
    }
    // watch-room windows
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + 0.4;
      const r = rAt(H - 3) + 0.02;
      b.with([r * Math.cos(a), H - 3, r * Math.sin(a)], [0, (-a * 180) / Math.PI + 90, 0], () => b.box(0, 0, 0, 0.8, 1.2, 0.08, WINDOWS));
    }
  }
  // the lantern: a glazed drum with a dark frame, the cupola, the vent ball and the rod
  const g0 = H + 0.3;
  const g1 = g0 + L.lanternH - 0.3;
  b.cylinder([0, g0, 0], [0, g0 + 0.6, 0], L.lanternR + 0.05, L.lanternR + 0.05, seg, DARK);
  b.cylinder([0, g0 + 0.6, 0], [0, g1, 0], L.lanternR, L.lanternR, seg, GLASS, false);
  if (!lod) for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    b.cylinder([L.lanternR * Math.cos(a), g0 + 0.6, L.lanternR * Math.sin(a)], [L.lanternR * Math.cos(a), g1, L.lanternR * Math.sin(a)], 0.05, 0.05, 4, DARK, false);
  }
  b.cylinder([0, g1, 0], [0, g1 + 0.2, 0], L.lanternR + 0.2, L.lanternR + 0.2, seg, RED);
  b.cylinder([0, g1 + 0.2, 0], [0, g1 + L.domeH, 0], L.lanternR + 0.15, 0.35, seg, RED);
  sphere(b, 0, g1 + L.domeH + 0.2, 0, 0.3, BRASS, lod ? 6 : 10);
  b.cylinder([0, g1 + L.domeH + 0.4, 0], [0, g1 + L.domeH + 0.9, 0], 0.03, 0.02, 4, BRASS, false);
  // the keeper's house beside it (its own floor on the slope)
  const hs = L.house;
  const fy = lh.houseY - lh.groundY;
  b.box(hs.dx, fy - 1 + (hs.h + 1) / 2, hs.dz, hs.len, hs.h + 1, hs.wid, WHITE, { bottom: true });
  b.prism(hs.dx, hs.dz, fy + hs.h, fy + hs.h + 1.6, hs.len + 0.6, hs.wid + 0.6, hs.len + 0.6, 0.2, ROOF);
  if (!lod) {
    for (const dx of [-3.2, 0, 3.2]) for (const s of [-1, 1]) b.box(hs.dx + dx, fy + 2.4, hs.dz + s * (hs.wid / 2 + 0.03), 1.1, 1.3, 0.06, WINDOWS);
    b.box(hs.dx + hs.len / 2 - 2, fy + hs.h + 1.2, hs.dz + 1.2, 0.8, 1.6, 0.8, STONE);
  }
  return b;
}

/** Colour bands of a buoy body (float + tower), bottom to top: [y0, y1, material]. */
function bands(kind: BuoyKind): [number, number, Mat][] {
  const lo = -BUOY_DIMS.draft;
  const hi = BUOY_DIMS.towerTop;
  const mid = (lo + hi) / 2 + 0.4;
  switch (kind) {
    case 'port':
      return [[lo, hi, RED]];
    case 'starboard':
      return [[lo, hi, GREEN]];
    case 'safe':
      return [[lo, hi, WHITE]]; // (red vertical stripes added separately)
    case 'north':
      return [[lo, mid, YELLOW], [mid, hi, BLACK]];
    case 'south':
      return [[lo, mid, BLACK], [mid, hi, YELLOW]];
    case 'east':
      return [[lo, 0.2, BLACK], [0.2, 1.9, YELLOW], [1.9, hi, BLACK]];
    case 'west':
      return [[lo, 0.2, YELLOW], [0.2, 1.9, BLACK], [1.9, hi, YELLOW]];
  }
}

const matAtY = (bs: [number, number, Mat][], y: number): Mat => (bs.find(([a, b]) => y >= a && y < b) ?? bs[bs.length - 1])[2];

/** One pillar buoy of a kind, in its body frame (waterline y = 0, the lamp at BUOY_DIMS.lampY). */
export function buildBuoy(kind: BuoyKind, lod = 0): MeshBuilder {
  const b = new MeshBuilder();
  const B = BUOY_DIMS;
  const bs = bands(kind);
  const seg = lod ? 8 : 16;
  // the float: a squat drum with a chamfered top; the tower: a tapered pillar
  if (kind === 'safe' && !lod) {
    // red and white vertical stripes: a lofted drum with alternating materials
    const rings: [number, number, number][][] = [];
    for (const [y, r] of [[-B.draft, B.floatR * 0.85], [-0.3, B.floatR], [B.floatTop - 0.15, B.floatR], [B.floatTop, B.floatR * 0.8]] as const) {
      const ring: [number, number, number][] = [];
      for (let j = 0; j < 16; j++) ring.push([r * Math.cos((j / 16) * Math.PI * 2), y, -r * Math.sin((j / 16) * Math.PI * 2)]);
      rings.push(ring);
    }
    b.loft(rings, (_i, j) => (Math.floor(j / 2) % 2 ? RED_BRIGHT : WHITE), true);
    const rings2: [number, number, number][][] = [];
    for (const [y, r] of [[B.floatTop, 0.55], [B.towerTop, 0.32]] as const) {
      const ring: [number, number, number][] = [];
      for (let j = 0; j < 16; j++) ring.push([r * Math.cos((j / 16) * Math.PI * 2), y, -r * Math.sin((j / 16) * Math.PI * 2)]);
      rings2.push(ring);
    }
    b.loft(rings2, (_i, j) => (Math.floor(j / 2) % 2 ? RED_BRIGHT : WHITE), true);
  } else {
    b.cylinder([0, -B.draft, 0], [0, -0.3, 0], B.floatR * 0.85, B.floatR, seg, matAtY(bs, -0.8), false);
    b.cylinder([0, -0.3, 0], [0, B.floatTop - 0.15, 0], B.floatR, B.floatR, seg, matAtY(bs, 0.1), false);
    b.cylinder([0, B.floatTop - 0.15, 0], [0, B.floatTop, 0], B.floatR, B.floatR * 0.8, seg, matAtY(bs, 0.6), true);
    // the tower in its bands
    const r = (y: number) => 0.55 + ((0.32 - 0.55) * (y - B.floatTop)) / (B.towerTop - B.floatTop);
    for (const [y0, y1, m] of bs) {
      const a = Math.max(y0, B.floatTop);
      const c = Math.min(y1, B.towerTop);
      if (c > a) b.cylinder([0, a, 0], [0, c, 0], r(a), r(c), seg, m, false);
    }
  }
  // a fender ring at the waterline and a radar reflector / lamp platform
  if (!lod) b.cylinder([0, -0.05, 0], [0, 0.2, 0], B.floatR + 0.08, B.floatR + 0.08, seg, DARK, false);
  b.cylinder([0, B.towerTop - 0.05, 0], [0, B.towerTop + 0.05, 0], 0.5, 0.5, seg, DARK);
  // lantern
  b.cylinder([0, B.towerTop + 0.05, 0], [0, B.lampY + 0.2, 0], 0.16, 0.16, 8, GLASS, true);
  // topmark on a short mast
  const t0 = B.lampY + 0.3;
  b.cylinder([0, B.lampY + 0.2, 0], [0, t0, 0], 0.04, 0.04, 4, STEEL, false);
  const T = B.topmarkTop;
  switch (kind) {
    case 'port':
      b.cylinder([0, t0 + 0.1, 0], [0, T, 0], 0.3, 0.3, 10, RED);
      break;
    case 'starboard':
      b.cylinder([0, t0 + 0.1, 0], [0, T, 0], 0.36, 0.0, 10, GREEN);
      break;
    case 'safe':
      sphere(b, 0, T - 0.3, 0, 0.3, RED_BRIGHT, lod ? 6 : 10);
      break;
    default: {
      // two black cones: N points up, S down, E base to base, W point to point
      const h = (T - t0) / 2;
      const up = (y0: number) => b.cylinder([0, y0, 0], [0, y0 + h, 0], 0.3, 0, 8, BLACK);
      const down = (y0: number) => b.cylinder([0, y0 + h, 0], [0, y0, 0], 0.3, 0, 8, BLACK);
      if (kind === 'north') {
        up(t0);
        up(t0 + h);
      } else if (kind === 'south') {
        down(t0);
        down(t0 + h);
      } else if (kind === 'east') {
        down(t0);
        up(t0 + h);
      } else {
        up(t0);
        down(t0 + h);
      }
    }
  }
  return b;
}

export const BUOY_KINDS: readonly BuoyKind[] = ['port', 'starboard', 'safe', 'north', 'east', 'south', 'west'];
