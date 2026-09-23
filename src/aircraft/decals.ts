/**
 * Livery decals: the Tater mascot (both fuselage sides and a small one on the fin), the
 * registration and the aircraft's name. Each decal is rasterised once with canvas 2D into an
 * RGBA image that covers a box in SIDE-VIEW coordinates (z aft, y up, metres); the livery
 * painter (livery.ts) samples it per texel of the fuselage / fin textures.
 *
 * Orientation: the mascot is drawn nose-left (as seen from the LEFT side) and sampled at the
 * same (z, y) on both sides, so it always flies toward the nose. Text is drawn for the left
 * side and sampled mirrored in z on the right side, so it reads correctly from both.
 */
import { MASCOT_BOX, drawTaterMascot, type Paint2D } from './mascot';

export interface Text2D extends Paint2D {
  font: string;
  textBaseline: CanvasTextBaseline;
  textAlign: CanvasTextAlign;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number; actualBoundingBoxAscent?: number };
}

/** A rasterised decal over a side-view box. `data` is straight (non-premultiplied) RGBA. */
export interface DecalImage {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
  z0: number;
  z1: number;
  y0: number;
  y1: number;
}

export interface LiveryDecals {
  /** Mascot on the fuselage sides (same image both sides). */
  art: DecalImage | null;
  /** Registration + name (mirrored in z on the right side). */
  text: DecalImage | null;
  /** Small mascot on the fin (the fin texture is shared by both sides). */
  fin: DecalImage | null;
}

/** Where everything goes (side view, metres). `tiltDeg` > 0 = nose up. */
export const DECAL_LAYOUT = {
  /** Pixels per metre of the decal rasters. */
  pxPerM: 640,
  art: { z0: 1.3, z1: 3.3, y0: -0.4, y1: 0.66 },
  mascot: { z: 1.36, y: 0.665, scale: 0.00185, tiltDeg: 6.5 },
  text: { z0: 3.15, z1: 4.35, y0: -0.2, y1: 0.2 },
  registration: { z: 3.26, baseline: -0.035, capHeight: 0.165, width: 0.95 },
  name: { text: 'TATER ONE', z: 3.28, baseline: -0.105, capHeight: 0.045 },
  fin: { z0: 4.55, z1: 5.55, y0: 0.2, y1: 0.9 },
  finMascot: { z: 4.69, y: 0.64, scale: 0.00056, tiltDeg: 16 },
} as const;

export const DECAL_COLORS = {
  registration: '#15171b',
  name: '#1c3570',
} as const;

type Box = { z0: number; z1: number; y0: number; y1: number };

function boxSize(b: Box, pxPerM: number) {
  return { w: Math.max(1, Math.round((b.z1 - b.z0) * pxPerM)), h: Math.max(1, Math.round((b.y1 - b.y0) * pxPerM)) };
}

/** Transform ctx so that drawing in mascot units lands at the placement inside the box. */
function placeMascot(ctx: Paint2D, box: Box, w: number, h: number, m: { z: number; y: number; scale: number; tiltDeg: number }) {
  const sx = w / (box.z1 - box.z0);
  const sy = h / (box.y1 - box.y0);
  ctx.translate((m.z - box.z0) * sx, (box.y1 - m.y) * sy);
  ctx.rotate((m.tiltDeg * Math.PI) / 180);
  ctx.scale(m.scale * sx, m.scale * sy);
}

/** The fuselage-side mascot raster (canvas w × h covering DECAL_LAYOUT.art). */
export function drawArtDecal(ctx: Paint2D, w: number, h: number): void {
  ctx.save();
  placeMascot(ctx, DECAL_LAYOUT.art, w, h, DECAL_LAYOUT.mascot);
  drawTaterMascot(ctx, { outline: 8 });
  ctx.restore();
}

/** The small fin mascot (thicker outlines and no speed lines so it still reads small). */
export function drawFinDecal(ctx: Paint2D, w: number, h: number): void {
  ctx.save();
  placeMascot(ctx, DECAL_LAYOUT.fin, w, h, DECAL_LAYOUT.finMascot);
  drawTaterMascot(ctx, { outline: 12, speedLines: false });
  ctx.restore();
}

const FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';

/** Registration (block capitals) and the aircraft's name (small italic), for the left side. */
export function drawTextDecal(ctx: Text2D, w: number, h: number, registration: string): void {
  const L = DECAL_LAYOUT;
  const box = L.text;
  const sx = w / (box.z1 - box.z0);
  const sy = h / (box.y1 - box.y0);
  const px = (z: number) => (z - box.z0) * sx;
  const py = (y: number) => (box.y1 - y) * sy;
  ctx.save();
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  // Registration: fit the cap height, then squeeze to the width with slight letter spacing.
  const reg = L.registration;
  let size = 100;
  ctx.font = `700 ${size}px ${FONT}`;
  const cap = ctx.measureText('N').actualBoundingBoxAscent || size * 0.72;
  size = (size * reg.capHeight * sy) / cap;
  ctx.font = `700 ${size}px ${FONT}`;
  const spacing = size * 0.04;
  let total = 0;
  for (const ch of registration) total += ctx.measureText(ch).width + spacing;
  total -= spacing;
  const squeeze = total > 0 ? Math.min(1.25, (reg.width * sx) / total) : 1;
  ctx.fillStyle = DECAL_COLORS.registration;
  ctx.save();
  ctx.translate(px(reg.z), py(reg.baseline));
  ctx.scale(squeeze, 1);
  let pen = 0;
  for (const ch of registration) {
    ctx.fillText(ch, pen, 0);
    pen += ctx.measureText(ch).width + spacing;
  }
  ctx.restore();
  // Name: small spaced italic capitals under the registration.
  const nm = L.name;
  let ns = 100;
  ctx.font = `italic 700 ${ns}px ${FONT}`;
  const ncap = ctx.measureText('T').actualBoundingBoxAscent || ns * 0.72;
  ns = (ns * nm.capHeight * sy) / ncap;
  ctx.font = `italic 700 ${ns}px ${FONT}`;
  ctx.fillStyle = DECAL_COLORS.name;
  let pen2 = px(nm.z);
  for (const ch of nm.text) {
    ctx.fillText(ch, pen2, py(nm.baseline));
    pen2 += ctx.measureText(ch).width + ns * 0.12;
  }
  ctx.restore();
}

/** Anything with a 2D context and pixel read-back (HTMLCanvasElement or OffscreenCanvas). */
export type CanvasFactory = (w: number, h: number) => {
  getContext(type: '2d'): unknown;
} | null;

function rasterize(factory: CanvasFactory, box: Box, pxPerM: number, draw: (ctx: Text2D, w: number, h: number) => void): DecalImage | null {
  const { w, h } = boxSize(box, pxPerM);
  const canvas = factory(w, h);
  const ctx = canvas?.getContext('2d') as (Text2D & { clearRect(x: number, y: number, w: number, h: number): void; getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } }) | null;
  if (!ctx) return null;
  ctx.clearRect(0, 0, w, h);
  draw(ctx, w, h);
  return { data: ctx.getImageData(0, 0, w, h).data, width: w, height: h, ...box };
}

/** Rasterise every livery decal with the given canvas factory (DOM canvas or OffscreenCanvas). */
export function rasterizeLiveryDecals(factory: CanvasFactory, registration: string, pxPerM: number = DECAL_LAYOUT.pxPerM): LiveryDecals {
  return {
    art: rasterize(factory, DECAL_LAYOUT.art, pxPerM, drawArtDecal),
    text: rasterize(factory, DECAL_LAYOUT.text, pxPerM, (c, w, h) => drawTextDecal(c, w, h, registration)),
    fin: rasterize(factory, DECAL_LAYOUT.fin, pxPerM * 1.4, drawFinDecal),
  };
}

/** Output of `sampleDecal`: straight colour (0..255) and coverage (0..1). */
export interface DecalSample {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * Premultiplied bilinear sample of a decal at side-view (z, y), averaged over a 2×2 grid spread
 * ±`fz`/±`fy` metres (a small box filter matching the target texel). Writes `out`; a = 0 outside.
 */
export function sampleDecal(img: DecalImage, z: number, y: number, fz: number, fy: number, out: DecalSample): DecalSample {
  out.r = out.g = out.b = out.a = 0;
  if (z < img.z0 - fz || z > img.z1 + fz || y < img.y0 - fy || y > img.y1 + fy) return out;
  const W = img.width;
  const H = img.height;
  const d = img.data;
  const kx = W / (img.z1 - img.z0);
  const ky = H / (img.y1 - img.y0);
  let pr = 0;
  let pg = 0;
  let pb = 0;
  let pa = 0;
  for (let s = 0; s < 4; s++) {
    const zz = z + (s & 1 ? fz : -fz) * 0.5;
    const yy = y + (s & 2 ? fy : -fy) * 0.5;
    const fx = (zz - img.z0) * kx - 0.5;
    const fyy = (img.y1 - yy) * ky - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fyy);
    const ax = fx - x0;
    const ay = fyy - y0;
    for (let j = 0; j < 4; j++) {
      const xi = x0 + (j & 1);
      const yi = y0 + (j >> 1);
      if (xi < 0 || yi < 0 || xi >= W || yi >= H) continue;
      const wgt = (j & 1 ? ax : 1 - ax) * (j >> 1 ? ay : 1 - ay);
      const i = (yi * W + xi) * 4;
      const a = d[i + 3] * wgt;
      pr += d[i] * a;
      pg += d[i + 1] * a;
      pb += d[i + 2] * a;
      pa += a;
    }
  }
  if (pa <= 0) return out;
  out.r = pr / pa;
  out.g = pg / pa;
  out.b = pb / pa;
  out.a = Math.min(1, pa / (4 * 255));
  return out;
}

export { MASCOT_BOX };
