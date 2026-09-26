/**
 * The JetRanger's paint, evaluated per texel on the analytic skin: every texel (u, v) of the skin
 * texture is mapped back to its body-frame point on the fuselage (same (u, z) parameterisation as
 * the loft, see shape.ts) and the scheme is evaluated there in metres — a classic civil scheme:
 * gloss white over a dark blue belly with a gold stripe and a blue pinstripe that sweep up the aft
 * fuselage and run along the boom, the registration on both sides of the boom, door panel lines and
 * handles, dark rubber seals round the windows and alpha cut-outs for the glass (alphaTest).
 *
 * Also painted: the cabin lining (the inside of the skin: headliner, walls, carpet, window trim, with
 * the same cut-outs) and the glass mask (the window shapes, the glass mesh's alphaMap).
 *
 * `paintB206Livery` is pure (runs in node); the text sampler for the registration needs a DOM
 * canvas and is optional. Pixels are cached per module, so rebuilding the model is instant.
 */
import {
  DOOR_HANDLES,
  REGISTRATION,
  Z_BOOM_END,
  Z_CABIN_END,
  Z_JOINT,
  boomCy,
  fuselageSection,
  insetSection,
  makeSection,
  paintDivideY,
  doorLineDistance,
  windowSd,
  zOfV,
  zOfVCabin,
  type Section,
  type WindowKind,
} from './shape';

type Win = { d: number; kind: WindowKind };

export const SKIN_TEX = { width: 1024, height: 2048 } as const;
export const CABIN_TEX = { width: 512, height: 512 } as const;
/** Lining inset from the outer skin, m. */
export const LINING_INSET = 0.012;

type RGB = readonly [number, number, number];
export const LIVERY = {
  white: [243, 244, 240] as RGB,
  blue: [22, 40, 86] as RGB,
  gold: [201, 158, 62] as RGB,
  seal: [26, 28, 31] as RGB,
  handle: [70, 72, 76] as RGB,
  headliner: [176, 172, 163] as RGB,
  wall: [118, 119, 122] as RGB,
  lowerWall: [70, 71, 75] as RGB,
  carpet: [46, 47, 50] as RGB,
  trim: [36, 37, 40] as RGB,
} as const;

export interface LiveryPixels {
  skin: Uint8ClampedArray;
  cabin: Uint8ClampedArray;
  mask: Uint8ClampedArray;
}

/** Alpha (0..1) of the registration lettering at text coords s (0..1 left→right), t (0..1 top→bottom); width/height ratio. */
export interface TextSampler {
  aspect: number;
  alpha(s: number, t: number): number;
}

/** Skin splices across the boom (panel lines), the first is the boom joint. */
const SPLICES = [Z_JOINT, 3.6, 5.2] as const;

const cov = (d: number, ps: number) => {
  const k = 0.5 - d / ps;
  return k <= 0 ? 0 : k >= 1 ? 1 : k;
};

/** Per-column ring tables (cos/sin of the ring angle). */
function columnTables(w: number) {
  const c = new Float64Array(w);
  const s = new Float64Array(w);
  for (let i = 0; i < w; i++) {
    const th = 2 * Math.PI * ((i + 0.5) / w) - Math.PI / 2;
    c[i] = Math.cos(th);
    s[i] = Math.sin(th);
  }
  return { c, s };
}

function pointAt(sec: Section, c: number, s: number, out: { x: number; y: number }) {
  const up = s >= 0;
  const e = 2 / (up ? sec.nT : sec.nB);
  const ac = Math.abs(c);
  const as = Math.abs(s);
  out.x = sec.hw * (ac > 0 ? Math.pow(ac, e) : 0) * (c < 0 ? -1 : 1);
  out.y = sec.wY + (up ? sec.top - sec.wY : sec.wY - sec.bottom) * (as > 0 ? Math.pow(as, e) : 0) * (s < 0 ? -1 : 1);
}

/** Approximate perimeter of a section (for the texel size around the ring). */
const perimeter = (sec: Section) => Math.PI * (sec.hw + 0.5 * (sec.top - sec.bottom));

function mix(px: Float32Array, col: RGB, k: number) {
  if (k <= 0) return;
  px[0] += (col[0] - px[0]) * k;
  px[1] += (col[1] - px[1]) * k;
  px[2] += (col[2] - px[2]) * k;
}

/** Evaluate the outer paint at a skin point: writes rgb into px[0..2], returns alpha 0..1. */
export function skinPaint(x: number, y: number, z: number, ps: number, px: Float32Array, text: TextSampler | null, win: Win = { d: 0, kind: 'none' }): number {
  px[0] = LIVERY.white[0];
  px[1] = LIVERY.white[1];
  px[2] = LIVERY.white[2];
  const ax = Math.abs(x);
  // Belly, gold stripe, blue pinstripe.
  const yd = paintDivideY(z);
  mix(px, LIVERY.blue, cov(y - yd, ps));
  mix(px, LIVERY.gold, cov(Math.abs(y - (yd + 0.042)) - 0.015, ps));
  mix(px, LIVERY.blue, cov(Math.abs(y - (yd + 0.077)) - 0.005, ps));
  // Registration on the boom sides.
  if (text && z > 2.2 && z < 4.6 && ax > 0.02) {
    const R = REGISTRATION;
    const y0 = boomCy(z) + R.yOff;
    const t = (y0 + R.h - y) / R.h;
    if (t >= 0 && t <= 1) {
      const w = R.h * text.aspect;
      const along = x > 0 ? R.zc - z : z - R.zc;
      const s = along / w + 0.5;
      if (s >= 0 && s <= 1) mix(px, LIVERY.blue, text.alpha(s, t));
    }
  }
  // Panel lines: doors (side view), the boom joint, boom skin splices.
  if (ax > 0.18 && z < 1.1) {
    const d = doorLineDistance(z, y);
    const k = cov(d - 0.0016, ps) * 0.45;
    if (k > 0) {
      px[0] *= 1 - k;
      px[1] *= 1 - k;
      px[2] *= 1 - k;
    }
    for (const h of DOOR_HANDLES) {
      if (Math.abs(z - h[0]) < 0.06 && Math.abs(y - h[1]) < 0.02) {
        const dh = Math.max(Math.abs(z - h[0]) - 0.045, Math.abs(y - h[1]) - 0.008);
        mix(px, LIVERY.handle, cov(dh, ps));
      }
    }
  }
  for (let i = 0; i < SPLICES.length; i++) {
    const zl = SPLICES[i];
    if (Math.abs(z - zl) > 0.02) continue;
    const k = cov(Math.abs(z - zl) - 0.0015, ps) * (i === 0 ? 0.5 : 0.22);
    if (k > 0) {
      px[0] *= 1 - k;
      px[1] *= 1 - k;
      px[2] *= 1 - k;
    }
  }
  // Windows: dark rubber seals, alpha cut-outs.
  if (z < Z_CABIN_END + 0.1) {
    windowSd(x, y, z, win);
    if (win.d < 0.05) {
      mix(px, LIVERY.seal, cov(win.d - 0.011, ps));
      return Math.min(1, Math.max(0, 0.5 + win.d / ps));
    }
  }
  return 1;
}

/** Evaluate the cabin lining at a (lining) point: rgb into px, returns alpha. */
export function cabinPaint(x: number, y: number, z: number, ps: number, px: Float32Array, win: Win = { d: 0, kind: 'none' }): number {
  const base = y < -0.56 ? LIVERY.carpet : y < -0.22 ? LIVERY.lowerWall : y > 0.7 ? LIVERY.headliner : LIVERY.wall;
  px[0] = base[0];
  px[1] = base[1];
  px[2] = base[2];
  if (Math.abs(x) > 0.18) {
    const d = doorLineDistance(z, y);
    mix(px, LIVERY.trim, cov(d - 0.006, ps) * 0.8);
  }
  windowSd(x, y, z, win);
  if (win.d < 0.08) {
    mix(px, LIVERY.trim, cov(win.d - 0.012, ps));
    return Math.min(1, Math.max(0, 0.5 + win.d / ps));
  }
  return 1;
}

let cached: { withText: boolean; px: LiveryPixels } | null = null;

/** Paint the skin, the cabin lining and the glass mask (cached; the text sampler only the first time it's given). */
export function paintB206Livery(text: TextSampler | null = null): LiveryPixels {
  if (cached && (cached.withText || !text)) return cached.px;
  const px = new Float32Array(3);
  const sec = makeSection();
  const inner = makeSection();
  const p = { x: 0, y: 0 };
  const win: Win = { d: 0, kind: 'none' };

  // Skin: u around (columns), v along (rows; row 0 = v 1 = the boom end, three's flipY).
  const { width: SW, height: SH } = SKIN_TEX;
  const skin = new Uint8ClampedArray(SW * SH * 4);
  const colS = columnTables(SW);
  const dz = (Z_BOOM_END - zOfV(0)) / SH;
  for (let j = 0; j < SH; j++) {
    const z = zOfV(1 - (j + 0.5) / SH);
    fuselageSection(z, sec);
    const ps = Math.max(dz, perimeter(sec) / SW, 0.002);
    let o = j * SW * 4;
    for (let i = 0; i < SW; i++, o += 4) {
      pointAt(sec, colS.c[i], colS.s[i], p);
      const a = skinPaint(p.x, p.y, z, ps, px, text, win);
      skin[o] = px[0];
      skin[o + 1] = px[1];
      skin[o + 2] = px[2];
      skin[o + 3] = a * 255;
    }
  }

  // Cabin lining and glass mask (cabin mapping).
  const { width: CW, height: CH } = CABIN_TEX;
  const cabin = new Uint8ClampedArray(CW * CH * 4);
  const mask = new Uint8ClampedArray(CW * CH * 4);
  const colC = columnTables(CW);
  const dzc = (Z_CABIN_END - zOfVCabin(0)) / CH;
  for (let j = 0; j < CH; j++) {
    const z = zOfVCabin(1 - (j + 0.5) / CH);
    fuselageSection(z, sec);
    insetSection(sec, LINING_INSET, inner);
    const ps = Math.max(dzc, perimeter(inner) / CW, 0.004);
    let o = j * CW * 4;
    for (let i = 0; i < CW; i++, o += 4) {
      pointAt(inner, colC.c[i], colC.s[i], p);
      const a = cabinPaint(p.x, p.y, z, ps, px, win);
      cabin[o] = px[0];
      cabin[o + 1] = px[1];
      cabin[o + 2] = px[2];
      cabin[o + 3] = a * 255;
      // Glass mask: the window shapes on the outer skin, grown a little so the glass meets the seals.
      pointAt(sec, colC.c[i], colC.s[i], p);
      windowSd(p.x, p.y, z, win);
      const m = cov(win.d - 0.008, ps) * 255;
      mask[o] = mask[o + 1] = mask[o + 2] = m;
      mask[o + 3] = 255;
    }
  }
  const out = { skin, cabin, mask };
  cached = { withText: !!text, px: out };
  return out;
}

/** Registration lettering rendered once into a canvas (browser only). */
export function createTextSampler(doc: Document): TextSampler | null {
  const c = doc.createElement('canvas');
  const H = 160;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  const font = `700 ${H * 0.92}px "Helvetica Neue", "Arial", sans-serif`;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(REGISTRATION.text).width + H * 0.1);
  c.width = w;
  c.height = H;
  ctx.font = font;
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'center';
  ctx.fillText(REGISTRATION.text, w / 2, H * 0.84);
  const data = ctx.getImageData(0, 0, w, H).data;
  return {
    aspect: w / H,
    alpha(s: number, t: number) {
      // Bilinear sample of the alpha channel.
      const fx = s * w - 0.5;
      const fy = t * H - 0.5;
      const x0 = Math.max(0, Math.min(w - 1, Math.floor(fx)));
      const y0 = Math.max(0, Math.min(H - 1, Math.floor(fy)));
      const x1 = Math.min(w - 1, x0 + 1);
      const y1 = Math.min(H - 1, y0 + 1);
      const ax = Math.min(1, Math.max(0, fx - x0));
      const ay = Math.min(1, Math.max(0, fy - y0));
      const a = (x: number, y: number) => data[(y * w + x) * 4 + 3] / 255;
      return (a(x0, y0) * (1 - ax) + a(x1, y0) * ax) * (1 - ay) + (a(x0, y1) * (1 - ax) + a(x1, y1) * ax) * ay;
    },
  };
}

/** Put painted pixels into a canvas (browser). */
export function pixelsToCanvas(doc: Document, data: Uint8ClampedArray, w: number, h: number): HTMLCanvasElement | null {
  const c = doc.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  const img = ctx.createImageData(w, h);
  img.data.set(data);
  ctx.putImageData(img, 0, 0);
  return c;
}
