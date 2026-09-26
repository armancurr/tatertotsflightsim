/**
 * Canvas-2D steam gauges of the Cessna 172RG, drawn from InstrumentReadings:
 * the six-pack (airspeed, attitude, altimeter, turn coordinator, heading,
 * vertical speed), the tachometer, compact system cells (throttle, flaps,
 * gear lights, trim, brakes, engine), the HUD compass tape and the whole
 * instrument panel for the 3D cockpit texture (drawPanel).
 *
 * Conventions: a gauge drawer is `(ctx, cx, cy, size, readings)` — centre and
 * diameter in the context's current units (CSS px for the HUD, texture px for
 * the panel). Needle angles are degrees clockwise from 12 o'clock. The static
 * parts of each gauge (case, dial, markings) are rendered once per pixel size
 * into an offscreen canvas and blitted, so a frame only draws needles and
 * glass. Drawers never throw and never emit NaN, whatever the readings hold.
 */
import { CONFIG } from '../config';
import type { InstrumentReadings } from '../types';
import { gearFlags } from './gearWarning';

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
const DIAL_FONT = '"DIN Alternate", "DIN Condensed", "Bahnschrift", "Arial Narrow", "Helvetica Neue", Arial, sans-serif';
const UI_FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "Helvetica Neue", Arial, sans-serif';
const MARK = '#f2efe6';
const MARK_DIM = '#a9a69d';
const RED = '#e2362b';
const GREEN = '#2fbf57';
const YELLOW = '#f4c51c';
const ORANGE = '#f39322';
const SKY_TOP = '#15508f';
const SKY_HORIZON = '#4f9be0';
const GROUND_HORIZON = '#80502a';
const GROUND_BOTTOM = '#3f2410';

export type GaugeDrawer = (ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number, r: InstrumentReadings) => void;
/** A rectangular system cell: (ctx, left, top, width, height, readings). */
export type CellDrawer = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: InstrumentReadings) => void;

// ─── Small numeric helpers ────────────────────────────────────────────────────

const fin = (x: number, fallback = 0): number => (Number.isFinite(x) ? x : fallback);
const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
const mod = (x: number, m: number): number => {
  const r = ((x % m) + m) % m;
  return r >= m ? 0 : r;
};
const wrap360 = (deg: number): number => mod(fin(deg), 360);
/** A usable drawing size: finite and positive, else 0 (the drawer then does nothing). */
const sz = (s: number): number => (Number.isFinite(s) && s > 0 ? Math.min(s, 1e5) : 0);
/**
 * Small gauges (HUD at ~1024 px wide) get a simplified face: no small print, fewer and larger
 * numerals, so everything left on the dial stays legible (≥ ~0.1 × the gauge size).
 */
export const isSimpleFace = (size: number): boolean => size < CONFIG.hud.simpleFaceBelowPx;

// ─── Needle geometry (pure, tested) ──────────────────────────────────────────

/** Airspeed indicator: 0 at 12 o'clock, 0–40 kt compressed into 30°, then 40→180 kt over 300°, pegging at 345°. */
export function asiNeedleDeg(kt: number): number {
  const v = fin(kt);
  if (v <= 0) return 0;
  if (v <= 40) return (v * 30) / 40;
  return Math.min(30 + ((v - 40) * 300) / 140, 345);
}

/** Altimeter hands: 100-ft (1000 ft/rev), 1000-ft (10 000 ft/rev) and 10 000-ft (100 000 ft/rev) pointers. */
export function altimeterHandsDeg(ft: number): { h100: number; h1000: number; h10000: number } {
  const a = fin(ft);
  return { h100: (mod(a, 1000) / 1000) * 360, h1000: (mod(a, 10000) / 10000) * 360, h10000: (mod(a, 100000) / 100000) * 360 };
}

export const VSI_RANGE_FPM = 2000;
const VSI_SWEEP_DEG = 170;
/** Vertical speed: 0 at 9 o'clock, climb clockwise, ±2000 fpm at ±170°. */
export function vsiNeedleDeg(fpm: number): number {
  return -90 + (clamp(fin(fpm), -VSI_RANGE_FPM, VSI_RANGE_FPM) / VSI_RANGE_FPM) * VSI_SWEEP_DEG;
}

const TACH_MAX = 3500;
/** Tachometer: 0 rpm at -130°, 3500 rpm at +130°. */
export function tachNeedleDeg(rpm: number): number {
  return -130 + (clamp(fin(rpm), 0, TACH_MAX) / TACH_MAX) * 260;
}

/**
 * Attitude indicator ball transform: rotate by `rotation` (rad, canvas sense;
 * a right bank turns the horizon counter-clockwise), then shift down by
 * `offsetY` (px; nose up puts the horizon below the aircraft symbol).
 */
export function attitudeGeometry(pitchDeg: number, rollDeg: number, size: number): { rotation: number; offsetY: number; pxPerDeg: number } {
  const pxPerDeg = sz(size) * 0.0165;
  let roll = mod(fin(rollDeg) + 180, 360) - 180;
  if (roll === -180) roll = 180;
  return { rotation: -roll * DEG, offsetY: clamp(fin(pitchDeg), -90, 90) * pxPerDeg, pxPerDeg };
}

/** Turn coordinator miniature aircraft bank (deg, + right): a standard-rate turn (3°/s) sits on the L/R marks at 20°. */
export function turnCoordinatorBankDeg(turnRateDegPerSec: number): number {
  return clamp((fin(turnRateDegPerSec) / 3) * 20, -40, 40);
}

/** Inclinometer ball offset from centre, px (+ right) for a gauge of this size. */
export function ballOffset(slipSkid: number, size: number): number {
  return clamp(fin(slipSkid), -1, 1) * sz(size) * 0.155;
}

/** The heading card turns opposite to the heading so the heading sits under the lubber line. */
export function headingCardRotationDeg(headingDeg: number): number {
  return -wrap360(headingDeg);
}

/** Label of a compass card/tape position: N/E/S/W at the cardinals, otherwise tens of degrees ("3" = 030°). */
export function compassLabel(deg: number): string {
  const d = Math.round(wrap360(deg)) % 360;
  if (d === 0) return 'N';
  if (d === 90) return 'E';
  if (d === 180) return 'S';
  if (d === 270) return 'W';
  return String(Math.round(d / 10));
}

// ─── Offscreen cache for the static parts ────────────────────────────────────

let cacheEnabled = true;
const cache = new Map<string, CanvasImageSource | null>();

/** Turn the static-face cache on/off (tests and debugging), and drop what it holds. */
export function setFaceCaching(enabled: boolean): void {
  cacheEnabled = enabled;
  cache.clear();
}
export function clearFaceCache(): void {
  cache.clear();
}

function makeSurface(pw: number, ph: number): { canvas: CanvasImageSource; ctx: CanvasRenderingContext2D } | null {
  try {
    if (typeof OffscreenCanvas !== 'undefined') {
      const c = new OffscreenCanvas(pw, ph);
      const x = c.getContext('2d') as unknown as CanvasRenderingContext2D | null;
      if (x) return { canvas: c, ctx: x };
    }
    if (typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      c.width = pw;
      c.height = ph;
      const x = c.getContext('2d');
      if (x) return { canvas: c, ctx: x };
    }
  } catch {
    /* no offscreen canvas: draw directly */
  }
  return null;
}

function deviceScale(ctx: CanvasRenderingContext2D): number {
  const t = typeof ctx.getTransform === 'function' ? ctx.getTransform() : null;
  const s = t ? Math.hypot(t.a, t.b) : 1;
  return Number.isFinite(s) && s > 0 ? s : 1;
}

/**
 * Draw `draw(c, w, h)` (local coords 0..w × 0..h) at x,y — through a cached
 * bitmap at the current device resolution when possible, directly otherwise.
 */
function cached(ctx: CanvasRenderingContext2D, key: string, x: number, y: number, w: number, h: number, draw: (c: CanvasRenderingContext2D, w: number, h: number) => void): void {
  if (!cacheEnabled || w < 6 || h < 6) {
    ctx.save();
    ctx.translate(x, y);
    draw(ctx, w, h);
    ctx.restore();
    return;
  }
  const s = deviceScale(ctx);
  const pw = Math.min(4096, Math.ceil(w * s));
  const ph = Math.min(4096, Math.ceil(h * s));
  const k = `${key}|${pw}x${ph}`;
  let img = cache.get(k);
  if (img === undefined) {
    img = null;
    const surf = makeSurface(pw, ph);
    if (surf) {
      surf.ctx.scale(pw / w, ph / h);
      draw(surf.ctx, w, h);
      img = surf.canvas;
    }
    if (cache.size > 160) cache.clear();
    cache.set(k, img);
  }
  if (img) {
    ctx.drawImage(img, x, y, w, h);
  } else {
    ctx.save();
    ctx.translate(x, y);
    draw(ctx, w, h);
    ctx.restore();
  }
}

/** Cached square face centred at cx,cy; `draw` gets (ctx, centre, centre, size). */
function cachedFace(ctx: CanvasRenderingContext2D, key: string, cx: number, cy: number, size: number, draw: (c: CanvasRenderingContext2D, cx: number, cy: number, size: number) => void): void {
  cached(ctx, key, cx - size / 2, cy - size / 2, size, size, (c, w) => draw(c, w / 2, w / 2, w));
}

// ─── Drawing primitives ──────────────────────────────────────────────────────

function font(c: CanvasRenderingContext2D, px: number, weight = 600, family = DIAL_FONT): void {
  c.font = `${weight} ${Math.max(1, px).toFixed(2)}px ${family}`;
}

function circle(c: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  c.beginPath();
  c.arc(cx, cy, Math.max(0, r), 0, TAU);
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  c.beginPath();
  c.moveTo(x + rr, y);
  c.lineTo(x + w - rr, y);
  c.arcTo(x + w, y, x + w, y + rr, rr);
  c.lineTo(x + w, y + h - rr);
  c.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  c.lineTo(x + rr, y + h);
  c.arcTo(x, y + h, x, y + h - rr, rr);
  c.lineTo(x, y + rr);
  c.arcTo(x, y, x + rr, y, rr);
  c.closePath();
}

/** Point on a dial at `deg` clockwise from 12 o'clock. */
function px(cx: number, r: number, deg: number): number {
  return cx + Math.sin(deg * DEG) * r;
}
function py(cy: number, r: number, deg: number): number {
  return cy - Math.cos(deg * DEG) * r;
}

/** Add radial tick segments to the current path. */
function ticks(c: CanvasRenderingContext2D, cx: number, cy: number, degs: number[], r0: number, r1: number): void {
  for (const d of degs) {
    c.moveTo(px(cx, r0, d), py(cy, r0, d));
    c.lineTo(px(cx, r1, d), py(cy, r1, d));
  }
}

function strokeTicks(c: CanvasRenderingContext2D, cx: number, cy: number, degs: number[], r0: number, r1: number, width: number, color = MARK): void {
  c.beginPath();
  ticks(c, cx, cy, degs, r0, r1);
  c.strokeStyle = color;
  c.lineWidth = width;
  c.lineCap = 'butt';
  c.stroke();
}

/** Coloured arc band between two needle angles (deg clockwise from 12). */
function band(c: CanvasRenderingContext2D, cx: number, cy: number, r: number, width: number, deg0: number, deg1: number, color: string): void {
  c.beginPath();
  c.arc(cx, cy, r, (deg0 - 90) * DEG, (deg1 - 90) * DEG);
  c.strokeStyle = color;
  c.lineWidth = width;
  c.lineCap = 'butt';
  c.stroke();
}

function text(c: CanvasRenderingContext2D, s: string, x: number, y: number, color = MARK, align: CanvasTextAlign = 'center', baseline: CanvasTextBaseline = 'middle'): void {
  c.fillStyle = color;
  c.textAlign = align;
  c.textBaseline = baseline;
  c.fillText(s, x, y);
}

/** Dial numerals placed around a circle, upright. */
function numerals(c: CanvasRenderingContext2D, cx: number, cy: number, r: number, items: [number, string][], pxSize: number, color = MARK): void {
  font(c, pxSize, 600);
  for (const [deg, s] of items) text(c, s, px(cx, r, deg), py(cy, r, deg) + pxSize * 0.04, color);
}

/**
 * The instrument case: bevelled black bezel ring and a matte black dial with a
 * soft inner shadow. Returns the dial radius.
 */
function drawCase(c: CanvasRenderingContext2D, cx: number, cy: number, size: number): number {
  const R = size / 2;
  // Outer bezel: satin black metal lit from the upper left.
  let g = c.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
  g.addColorStop(0, '#7b7e83');
  g.addColorStop(0.35, '#34363a');
  g.addColorStop(0.7, '#141516');
  g.addColorStop(1, '#050505');
  circle(c, cx, cy, R);
  c.fillStyle = g;
  c.fill();
  // Inner chamfer (reversed light) gives the ring depth.
  g = c.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
  g.addColorStop(0, '#040404');
  g.addColorStop(0.55, '#1b1c1e');
  g.addColorStop(1, '#5c5f63');
  circle(c, cx, cy, R * 0.93);
  c.fillStyle = g;
  c.fill();
  // Dial.
  const F = R * 0.885;
  g = c.createRadialGradient(cx - F * 0.2, cy - F * 0.3, F * 0.05, cx, cy, F);
  g.addColorStop(0, '#242527');
  g.addColorStop(0.65, '#161718');
  g.addColorStop(1, '#0c0c0d');
  circle(c, cx, cy, F);
  c.fillStyle = g;
  c.fill();
  // Inner shadow cast by the bezel onto the dial.
  g = c.createRadialGradient(cx + F * 0.04, cy + F * 0.06, F * 0.78, cx, cy, F);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.6)');
  circle(c, cx, cy, F);
  c.fillStyle = g;
  c.fill();
  return F;
}

/** Cover glass: a soft glare in the upper left and a thin rim highlight. */
function drawGlass(c: CanvasRenderingContext2D, cx: number, cy: number, size: number): void {
  const F = (size / 2) * 0.885;
  c.save();
  circle(c, cx, cy, F);
  c.clip();
  const g = c.createLinearGradient(cx - F, cy - F, cx + F * 0.2, cy + F * 0.35);
  g.addColorStop(0, 'rgba(255,255,255,0.16)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.04)');
  g.addColorStop(0.62, 'rgba(255,255,255,0)');
  c.beginPath();
  c.ellipse(cx - F * 0.28, cy - F * 0.52, F * 1.05, F * 0.66, -0.55, 0, TAU);
  c.fillStyle = g;
  c.fill();
  c.restore();
  c.beginPath();
  c.arc(cx, cy, F * 0.975, 195 * DEG, 285 * DEG);
  c.strokeStyle = 'rgba(255,255,255,0.2)';
  c.lineWidth = Math.max(0.5, F * 0.018);
  c.lineCap = 'round';
  c.stroke();
  c.beginPath();
  c.arc(cx, cy, F * 0.975, 20 * DEG, 70 * DEG);
  c.strokeStyle = 'rgba(255,255,255,0.06)';
  c.stroke();
}

/**
 * A white pointer with a pointed tip and a black counterweight tail, with a
 * soft drop shadow. `deg` clockwise from 12 o'clock; lengths in px.
 */
function needle(c: CanvasRenderingContext2D, cx: number, cy: number, deg: number, len: number, tail: number, width: number, color = MARK): void {
  const w = width / 2;
  const path = () => {
    c.beginPath();
    c.moveTo(-w, 0);
    c.lineTo(-w * 0.8, -len * 0.82);
    c.lineTo(0, -len);
    c.lineTo(w * 0.8, -len * 0.82);
    c.lineTo(w, 0);
    c.closePath();
  };
  const rot = deg * DEG;
  // Shadow on the dial.
  c.save();
  c.translate(cx + width * 0.35, cy + width * 0.6);
  c.rotate(rot);
  path();
  c.fillStyle = 'rgba(0,0,0,0.45)';
  c.fill();
  c.restore();
  c.save();
  c.translate(cx, cy);
  c.rotate(rot);
  // Counterweight tail.
  c.beginPath();
  c.moveTo(-w * 1.15, 0);
  c.lineTo(-w * 1.4, tail);
  c.lineTo(w * 1.4, tail);
  c.lineTo(w * 1.15, 0);
  c.closePath();
  c.fillStyle = '#1b1b1c';
  c.fill();
  path();
  c.fillStyle = color;
  c.fill();
  c.restore();
}

function hub(c: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  const g = c.createRadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.1, cx, cy, r);
  g.addColorStop(0, '#5a5c60');
  g.addColorStop(0.5, '#1d1e20');
  g.addColorStop(1, '#050505');
  circle(c, cx, cy, r);
  c.fillStyle = g;
  c.fill();
}

// ─── Airspeed indicator ──────────────────────────────────────────────────────

function asiFace(c: CanvasRenderingContext2D, cx: number, cy: number, size: number): void {
  const F = drawCase(c, cx, cy, size);
  const lim = CONFIG.aircraft.limits;
  const vfe = CONFIG.aircraft.flaps.vfeKt;
  // Arcs: white (flap operating range) inside, green (normal) and yellow (caution) outside.
  band(c, cx, cy, F * 0.805, F * 0.05, asiNeedleDeg(lim.vsoKt), asiNeedleDeg(vfe), MARK);
  band(c, cx, cy, F * 0.875, F * 0.075, asiNeedleDeg(lim.vs1Kt), asiNeedleDeg(lim.vnoKt), GREEN);
  band(c, cx, cy, F * 0.875, F * 0.075, asiNeedleDeg(lim.vnoKt), asiNeedleDeg(lim.vneKt), YELLOW);
  // Red line at Vne.
  const vne = asiNeedleDeg(lim.vneKt);
  c.beginPath();
  ticks(c, cx, cy, [vne], F * 0.74, F * 0.935);
  c.strokeStyle = RED;
  c.lineWidth = F * 0.04;
  c.stroke();
  // Graduations: every 5 kt from 40, longer every 10.
  const minor: number[] = [];
  const major: number[] = [];
  if (isSimpleFace(size)) {
    for (let v = 40; v <= 180; v += 10) (v % 20 === 0 ? major : minor).push(asiNeedleDeg(v));
    strokeTicks(c, cx, cy, minor, F * 0.84, F * 0.94, F * 0.035);
    strokeTicks(c, cx, cy, major, F * 0.76, F * 0.94, F * 0.05);
    const big: [number, string][] = [40, 80, 120, 160].map((v) => [asiNeedleDeg(v), String(v)]);
    numerals(c, cx, cy, F * 0.54, big, F * 0.3);
    font(c, F * 0.24, 800, UI_FONT);
    text(c, 'KT', cx, cy - F * 0.3, MARK);
    return;
  }
  for (let v = 40; v <= 180; v += 5) (v % 10 === 0 ? major : minor).push(asiNeedleDeg(v));
  strokeTicks(c, cx, cy, minor, F * 0.86, F * 0.94, F * 0.022);
  strokeTicks(c, cx, cy, major, F * 0.8, F * 0.94, F * 0.032);
  const labels: [number, string][] = [];
  for (let v = 40; v <= 180; v += 20) labels.push([asiNeedleDeg(v), String(v)]);
  numerals(c, cx, cy, F * 0.6, labels, F * 0.17);
  font(c, F * 0.085, 700, UI_FONT);
  text(c, 'AIRSPEED', cx, cy - F * 0.3, MARK_DIM);
  font(c, F * 0.1, 700, UI_FONT);
  text(c, 'KNOTS', cx, cy + F * 0.3, MARK);
}

export const drawAirspeed: GaugeDrawer = (ctx, cx, cy, size, r) => {
  const s = sz(size);
  if (!s || !Number.isFinite(cx) || !Number.isFinite(cy)) return;
  cachedFace(ctx, isSimpleFace(s) ? 'asiS' : 'asi', cx, cy, s, asiFace);
  const F = (s / 2) * 0.885;
  needle(ctx, cx, cy, asiNeedleDeg(r.airspeedKt), F * 0.88, F * 0.22, F * 0.075);
  hub(ctx, cx, cy, F * 0.09);
  drawGlass(ctx, cx, cy, s);
};

// ─── Attitude indicator ──────────────────────────────────────────────────────

function aiFixed(c: CanvasRenderingContext2D, cx: number, cy: number, size: number): void {
  const F = (size / 2) * 0.885;
  // Pedestal of the miniature aircraft rising from the bottom of the case.
  c.beginPath();
  c.moveTo(cx - F * 0.3, cy + F);
  c.lineTo(cx - F * 0.07, cy + F * 0.2);
  c.lineTo(cx + F * 0.07, cy + F * 0.2);
  c.lineTo(cx + F * 0.3, cy + F);
  c.closePath();
  const pg = c.createLinearGradient(cx, cy + F * 0.2, cx, cy + F);
  pg.addColorStop(0, 'rgba(22,22,24,0.95)');
  pg.addColorStop(1, 'rgba(8,8,9,0.98)');
  c.fillStyle = pg;
  c.fill();
  // Miniature aircraft: orange wings with a centre dot.
  const wy = cy;
  c.lineCap = 'round';
  c.strokeStyle = 'rgba(0,0,0,0.5)';
  c.lineWidth = F * 0.075;
  c.beginPath();
  c.moveTo(cx - F * 0.6, wy + F * 0.02);
  c.lineTo(cx - F * 0.2, wy + F * 0.02);
  c.lineTo(cx - F * 0.1, wy + F * 0.1);
  c.moveTo(cx + F * 0.6, wy + F * 0.02);
  c.lineTo(cx + F * 0.2, wy + F * 0.02);
  c.lineTo(cx + F * 0.1, wy + F * 0.1);
  c.stroke();
  c.strokeStyle = ORANGE;
  c.lineWidth = F * 0.06;
  c.beginPath();
  c.moveTo(cx - F * 0.6, wy);
  c.lineTo(cx - F * 0.2, wy);
  c.lineTo(cx - F * 0.1, wy + F * 0.08);
  c.moveTo(cx + F * 0.6, wy);
  c.lineTo(cx + F * 0.2, wy);
  c.lineTo(cx + F * 0.1, wy + F * 0.08);
  c.stroke();
  circle(c, cx, wy, F * 0.045);
  c.fillStyle = ORANGE;
  c.fill();
  // Fixed bank index at the top of the case.
  c.beginPath();
  c.moveTo(cx, cy - F * 0.8);
  c.lineTo(cx - F * 0.075, cy - F * 0.97);
  c.lineTo(cx + F * 0.075, cy - F * 0.97);
  c.closePath();
  c.fillStyle = ORANGE;
  c.fill();
}

export const drawAttitude: GaugeDrawer = (ctx, cx, cy, size, r) => {
  const s = sz(size);
  if (!s || !Number.isFinite(cx) || !Number.isFinite(cy)) return;
  cachedFace(ctx, 'case', cx, cy, s, drawCase);
  const F = (s / 2) * 0.885;
  const g = attitudeGeometry(r.pitchDeg, r.rollDeg, s);
  const big = F * 3 + Math.abs(g.offsetY);
  ctx.save();
  circle(ctx, cx, cy, F);
  ctx.clip();
  ctx.translate(cx, cy);
  ctx.rotate(g.rotation);
  // Bank card: sky/ground ring that turns with the horizon (not with pitch).
  ctx.fillStyle = SKY_TOP;
  ctx.fillRect(-F, -F, F * 2, F);
  ctx.fillStyle = GROUND_BOTTOM;
  ctx.fillRect(-F, 0, F * 2, F);
  const bankDegs = [-60, -30, -20, -10, 10, 20, 30, 60];
  ctx.beginPath();
  ticks(ctx, 0, 0, [-30, -20, -10, 10, 20, 30], F * 0.82, F * 0.95);
  ctx.strokeStyle = MARK;
  ctx.lineWidth = F * 0.028;
  ctx.stroke();
  ctx.beginPath();
  ticks(ctx, 0, 0, [-90, -60, 60, 90], F * 0.78, F * 0.98);
  ctx.lineWidth = F * 0.04;
  ctx.stroke();
  for (const d of [-45, 45]) {
    ctx.beginPath();
    ctx.moveTo(px(0, F * 0.83, d), py(0, F * 0.83, d));
    ctx.lineTo(px(0, F * 0.96, d - 3.5), py(0, F * 0.96, d - 3.5));
    ctx.lineTo(px(0, F * 0.96, d + 3.5), py(0, F * 0.96, d + 3.5));
    ctx.closePath();
    ctx.fillStyle = MARK;
    ctx.fill();
  }
  void bankDegs;
  // Zero-bank triangle on the card.
  ctx.beginPath();
  ctx.moveTo(0, -F * 0.8);
  ctx.lineTo(-F * 0.07, -F * 0.94);
  ctx.lineTo(F * 0.07, -F * 0.94);
  ctx.closePath();
  ctx.fillStyle = MARK;
  ctx.fill();
  // The ball: sky/ground with the pitch ladder, shifted by pitch.
  ctx.save();
  circle(ctx, 0, 0, F * 0.77);
  ctx.clip();
  ctx.translate(0, g.offsetY);
  let grad = ctx.createLinearGradient(0, -F * 1.2, 0, 0);
  grad.addColorStop(0, SKY_TOP);
  grad.addColorStop(1, SKY_HORIZON);
  ctx.fillStyle = grad;
  ctx.fillRect(-big, -big, big * 2, big);
  grad = ctx.createLinearGradient(0, 0, 0, F * 1.2);
  grad.addColorStop(0, GROUND_HORIZON);
  grad.addColorStop(1, GROUND_BOTTOM);
  ctx.fillStyle = grad;
  ctx.fillRect(-big, 0, big * 2, big);
  ctx.beginPath();
  ctx.moveTo(-big, 0);
  ctx.lineTo(big, 0);
  ctx.strokeStyle = MARK;
  ctx.lineWidth = F * 0.03;
  ctx.stroke();
  // Pitch ladder: 5° short, 10° long with numerals, both directions.
  ctx.beginPath();
  for (const p of [-20, -15, -10, -5, 5, 10, 15, 20]) {
    const y = -p * g.pxPerDeg;
    const half = p % 10 === 0 ? F * 0.26 : F * 0.13;
    ctx.moveTo(-half, y);
    ctx.lineTo(half, y);
  }
  ctx.lineWidth = F * 0.022;
  ctx.stroke();
  if (!isSimpleFace(s)) {
    font(ctx, F * 0.12, 700);
    for (const p of [-20, -10, 10, 20]) {
      const y = -p * g.pxPerDeg;
      text(ctx, String(Math.abs(p)), -F * 0.37, y, MARK);
      text(ctx, String(Math.abs(p)), F * 0.37, y, MARK);
    }
  }
  ctx.restore();
  // Rim of the ball.
  circle(ctx, 0, 0, F * 0.77);
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = F * 0.03;
  ctx.stroke();
  ctx.restore();
  cachedFace(ctx, 'aiFixed', cx, cy, s, aiFixed);
  drawGlass(ctx, cx, cy, s);
};

// ─── Altimeter ───────────────────────────────────────────────────────────────

function altFace(c: CanvasRenderingContext2D, cx: number, cy: number, size: number): void {
  const F = drawCase(c, cx, cy, size);
  const minor: number[] = [];
  const major: number[] = [];
  for (let i = 0; i < 50; i++) (i % 5 === 0 ? major : minor).push(i * 7.2);
  strokeTicks(c, cx, cy, minor, F * 0.87, F * 0.95, F * 0.02);
  strokeTicks(c, cx, cy, major, F * 0.78, F * 0.95, F * 0.036);
  const labels: [number, string][] = [];
  for (let i = 0; i < 10; i++) labels.push([i * 36, String(i)]);
  if (isSimpleFace(size)) {
    numerals(c, cx, cy, F * 0.6, labels, F * 0.3);
    return;
  }
  numerals(c, cx, cy, F * 0.63, labels, F * 0.22);
  // Kollsman window at 3 o'clock.
  const kw = F * 0.3;
  const kh = F * 0.15;
  const kx = cx + F * 0.17;
  roundRect(c, kx, cy - kh / 2, kw, kh, kh * 0.18);
  c.fillStyle = '#050505';
  c.fill();
  c.strokeStyle = '#3a3b3e';
  c.lineWidth = F * 0.015;
  c.stroke();
  font(c, F * 0.1, 700);
  text(c, CONFIG.hud.kollsmanInHg.toFixed(2), kx + kw / 2, cy + F * 0.005, MARK);
  font(c, F * 0.085, 700, UI_FONT);
  text(c, 'ALT', cx, cy - F * 0.3, MARK_DIM);
  font(c, F * 0.075, 700, UI_FONT);
  text(c, '100 FEET', cx, cy + F * 0.3, MARK);
}

export const drawAltimeter: GaugeDrawer = (ctx, cx, cy, size, r) => {
  const s = sz(size);
  if (!s || !Number.isFinite(cx) || !Number.isFinite(cy)) return;
  cachedFace(ctx, isSimpleFace(s) ? 'altS' : 'alt', cx, cy, s, altFace);
  const F = (s / 2) * 0.885;
  const h = altimeterHandsDeg(r.altitudeFt);
  // 10 000-ft pointer: thin needle with a triangle at the rim.
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(h.h10000 * DEG);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, -F * 0.8);
  ctx.strokeStyle = MARK;
  ctx.lineWidth = F * 0.018;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, -F * 0.8);
  ctx.lineTo(-F * 0.06, -F * 0.94);
  ctx.lineTo(F * 0.06, -F * 0.94);
  ctx.closePath();
  ctx.fillStyle = MARK;
  ctx.fill();
  ctx.restore();
  // 1000-ft hand: short and broad.
  needle(ctx, cx, cy, h.h1000, F * 0.52, F * 0.14, F * 0.13);
  // 100-ft hand: long and slim.
  needle(ctx, cx, cy, h.h100, F * 0.86, F * 0.2, F * 0.065);
  hub(ctx, cx, cy, F * 0.085);
  drawGlass(ctx, cx, cy, s);
};

// ─── Turn coordinator ────────────────────────────────────────────────────────

/** Ball tube geometry shared by the face and the ball. */
function tubeGeom(cx: number, cy: number, F: number) {
  const bottom = cy + F * 0.47;
  const rad = F * 2.1;
  return { ox: cx, oy: bottom - rad, rad, half: (F * 0.42) / rad, width: F * 0.17 };
}

function tcFace(c: CanvasRenderingContext2D, cx: number, cy: number, size: number): void {
  const F = drawCase(c, cx, cy, size);
  // Level and standard-rate marks.
  strokeTicks(c, cx, cy, [-90, 90], F * 0.72, F * 0.94, F * 0.05);
  strokeTicks(c, cx, cy, [-110, 110], F * 0.72, F * 0.94, F * 0.05);
  const simple = isSimpleFace(size);
  font(c, simple ? F * 0.24 : F * 0.15, 700, UI_FONT);
  text(c, 'L', px(cx, F * 0.62, -122), py(cy, F * 0.62, -122), MARK);
  text(c, 'R', px(cx, F * 0.62, 122), py(cy, F * 0.62, 122), MARK);
  if (!simple) {
    font(c, F * 0.075, 700, UI_FONT);
    text(c, 'TURN COORDINATOR', cx, cy - F * 0.5, MARK_DIM);
    font(c, F * 0.1, 700, UI_FONT);
    text(c, '2 MIN', cx, cy + F * 0.7, MARK);
    font(c, F * 0.055, 600, UI_FONT);
    text(c, 'NO PITCH INFORMATION', cx, cy + F * 0.82, MARK_DIM);
  }
  // Inclinometer tube: cream liquid behind glass, two reference wires.
  const t = tubeGeom(cx, cy, F);
  c.beginPath();
  c.arc(t.ox, t.oy, t.rad, Math.PI / 2 - t.half, Math.PI / 2 + t.half);
  c.strokeStyle = '#0a0a0a';
  c.lineWidth = t.width + F * 0.04;
  c.lineCap = 'round';
  c.stroke();
  c.beginPath();
  c.arc(t.ox, t.oy, t.rad, Math.PI / 2 - t.half, Math.PI / 2 + t.half);
  c.strokeStyle = '#d9d2bd';
  c.lineWidth = t.width;
  c.stroke();
  const wire = F * 0.095;
  c.beginPath();
  for (const sx of [-wire, wire]) {
    const a = Math.PI / 2 - sx / t.rad;
    c.moveTo(t.ox + Math.cos(a) * (t.rad - t.width / 2), t.oy + Math.sin(a) * (t.rad - t.width / 2));
    c.lineTo(t.ox + Math.cos(a) * (t.rad + t.width / 2), t.oy + Math.sin(a) * (t.rad + t.width / 2));
  }
  c.strokeStyle = '#111';
  c.lineWidth = F * 0.022;
  c.lineCap = 'butt';
  c.stroke();
}

export const drawTurnCoordinator: GaugeDrawer = (ctx, cx, cy, size, r) => {
  const s = sz(size);
  if (!s || !Number.isFinite(cx) || !Number.isFinite(cy)) return;
  cachedFace(ctx, isSimpleFace(s) ? 'tcS' : 'tc', cx, cy, s, tcFace);
  const F = (s / 2) * 0.885;
  // Ball.
  const t = tubeGeom(cx, cy, F);
  const off = ballOffset(r.slipSkid, s);
  const a = Math.PI / 2 - off / t.rad;
  const bx = t.ox + Math.cos(a) * t.rad;
  const by = t.oy + Math.sin(a) * t.rad;
  const br = t.width * 0.44;
  const bg = ctx.createRadialGradient(bx - br * 0.35, by - br * 0.4, br * 0.1, bx, by, br);
  bg.addColorStop(0, '#6a6a6a');
  bg.addColorStop(0.6, '#161616');
  bg.addColorStop(1, '#000');
  circle(ctx, bx, by, br);
  ctx.fillStyle = bg;
  ctx.fill();
  // Miniature aircraft seen from behind, banked by the turn rate.
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(turnCoordinatorBankDeg(r.turnRateDegPerSec) * DEG);
  const shadow = (dx: number, dy: number, color: string) => {
    ctx.beginPath();
    ctx.moveTo(-F * 0.66 + dx, -F * 0.015 + dy);
    ctx.lineTo(F * 0.66 + dx, -F * 0.015 + dy);
    ctx.lineTo(F * 0.62 + dx, F * 0.045 + dy);
    ctx.lineTo(-F * 0.62 + dx, F * 0.045 + dy);
    ctx.closePath();
    ctx.moveTo(-F * 0.03 + dx, -F * 0.2 + dy);
    ctx.lineTo(F * 0.03 + dx, -F * 0.2 + dy);
    ctx.lineTo(F * 0.04 + dx, -F * 0.05 + dy);
    ctx.lineTo(-F * 0.04 + dx, -F * 0.05 + dy);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    circle(ctx, dx, F * 0.01 + dy, F * 0.085);
    ctx.fill();
  };
  shadow(F * 0.02, F * 0.035, 'rgba(0,0,0,0.5)');
  shadow(0, 0, MARK);
  circle(ctx, 0, F * 0.01, F * 0.045);
  ctx.fillStyle = '#222';
  ctx.fill();
  ctx.restore();
  drawGlass(ctx, cx, cy, s);
};

// ─── Heading indicator ───────────────────────────────────────────────────────

function hiCard(c: CanvasRenderingContext2D, cx: number, cy: number, size: number): void {
  const F = (size / 2) * 0.885;
  const minor: number[] = [];
  const major: number[] = [];
  const simple = isSimpleFace(size);
  for (let d = 0; d < 360; d += simple ? 10 : 5) ((simple ? d % 30 === 0 : d % 10 === 0) ? major : minor).push(d);
  strokeTicks(c, cx, cy, minor, F * 0.87, F * 0.95, simple ? F * 0.03 : F * 0.02);
  strokeTicks(c, cx, cy, major, F * 0.8, F * 0.95, simple ? F * 0.045 : F * 0.032);
  for (let d = 0; d < 360; d += 30) {
    const card = d % 90 === 0;
    c.save();
    c.translate(px(cx, simple ? F * 0.6 : F * 0.64, d), py(cy, simple ? F * 0.6 : F * 0.64, d));
    c.rotate(d * DEG);
    if (simple) font(c, card ? F * 0.32 : F * 0.22, card ? 800 : 700);
    else font(c, card ? F * 0.21 : F * 0.17, card ? 800 : 600);
    text(c, compassLabel(d), 0, 0, card ? MARK : MARK);
    c.restore();
  }
}

function hiFixed(c: CanvasRenderingContext2D, cx: number, cy: number, size: number): void {
  const F = (size / 2) * 0.885;
  // 45° reference marks on the case.
  for (let d = 45; d < 360; d += 45) {
    if (d === 180) continue;
    c.beginPath();
    c.moveTo(px(cx, F * 0.965, d), py(cy, F * 0.965, d));
    c.lineTo(px(cx, F * 1.04, d - 3), py(cy, F * 1.04, d - 3));
    c.lineTo(px(cx, F * 1.04, d + 3), py(cy, F * 1.04, d + 3));
    c.closePath();
    c.fillStyle = MARK;
    c.fill();
  }
  // Lubber line.
  c.beginPath();
  c.moveTo(cx, cy - F * 0.76);
  c.lineTo(cx - F * 0.07, cy - F * 1.02);
  c.lineTo(cx + F * 0.07, cy - F * 1.02);
  c.closePath();
  c.fillStyle = ORANGE;
  c.fill();
  // Aircraft symbol.
  const k = F * 0.36;
  c.save();
  c.translate(cx, cy);
  for (const [dx, dy, color] of [[k * 0.05, k * 0.08, 'rgba(0,0,0,0.5)'], [0, 0, ORANGE]] as const) {
    c.beginPath();
    c.moveTo(dx, -k + dy);
    c.lineTo(k * 0.09 + dx, -k * 0.75 + dy);
    c.lineTo(k * 0.09 + dx, -k * 0.2 + dy);
    c.lineTo(k * 0.85 + dx, k * 0.05 + dy);
    c.lineTo(k * 0.85 + dx, k * 0.18 + dy);
    c.lineTo(k * 0.09 + dx, k * 0.08 + dy);
    c.lineTo(k * 0.07 + dx, k * 0.6 + dy);
    c.lineTo(k * 0.34 + dx, k * 0.75 + dy);
    c.lineTo(k * 0.34 + dx, k * 0.85 + dy);
    c.lineTo(dx, k * 0.8 + dy);
    c.lineTo(-k * 0.34 + dx, k * 0.85 + dy);
    c.lineTo(-k * 0.34 + dx, k * 0.75 + dy);
    c.lineTo(-k * 0.07 + dx, k * 0.6 + dy);
    c.lineTo(-k * 0.09 + dx, k * 0.08 + dy);
    c.lineTo(-k * 0.85 + dx, k * 0.18 + dy);
    c.lineTo(-k * 0.85 + dx, k * 0.05 + dy);
    c.lineTo(-k * 0.09 + dx, -k * 0.2 + dy);
    c.lineTo(-k * 0.09 + dx, -k * 0.75 + dy);
    c.closePath();
    c.fillStyle = color;
    c.fill();
  }
  c.restore();
}

export const drawHeading: GaugeDrawer = (ctx, cx, cy, size, r) => {
  const s = sz(size);
  if (!s || !Number.isFinite(cx) || !Number.isFinite(cy)) return;
  cachedFace(ctx, 'case', cx, cy, s, drawCase);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(headingCardRotationDeg(r.headingDeg) * DEG);
  cachedFace(ctx, isSimpleFace(s) ? 'hiCardS' : 'hiCard', 0, 0, s, hiCard);
  ctx.restore();
  cachedFace(ctx, 'hiFixed', cx, cy, s, hiFixed);
  drawGlass(ctx, cx, cy, s);
};

// ─── Vertical speed indicator ────────────────────────────────────────────────

function vsiFace(c: CanvasRenderingContext2D, cx: number, cy: number, size: number): void {
  const F = drawCase(c, cx, cy, size);
  const minor: number[] = [];
  const major: number[] = [];
  if (isSimpleFace(size)) {
    for (let v = -2000; v <= 2000; v += 500) (v % 1000 === 0 ? major : minor).push(vsiNeedleDeg(v));
    strokeTicks(c, cx, cy, minor, F * 0.83, F * 0.95, F * 0.035);
    strokeTicks(c, cx, cy, major, F * 0.74, F * 0.95, F * 0.05);
    numerals(c, cx, cy, F * 0.56, [[vsiNeedleDeg(0), '0'], [vsiNeedleDeg(1000), '10'], [vsiNeedleDeg(-1000), '10'], [90, '20']], F * 0.3);
    font(c, F * 0.22, 800, UI_FONT);
    text(c, 'UP', cx - F * 0.3, cy - F * 0.3, MARK);
    text(c, 'DN', cx - F * 0.3, cy + F * 0.3, MARK);
    return;
  }
  for (let v = -2000; v <= 2000; v += 100) (v % 500 === 0 ? major : minor).push(vsiNeedleDeg(v));
  strokeTicks(c, cx, cy, minor, F * 0.86, F * 0.95, F * 0.022);
  strokeTicks(c, cx, cy, major, F * 0.77, F * 0.95, F * 0.036);
  const labels: [number, string][] = [[vsiNeedleDeg(0), '0']];
  for (const v of [500, 1000, 1500, 2000]) {
    labels.push([vsiNeedleDeg(v), String(v / 100)]);
    labels.push([vsiNeedleDeg(-v), String(v / 100)]);
  }
  numerals(c, cx, cy, F * 0.6, labels.filter(([d]) => Math.abs(d - 90) > 20 && Math.abs(d + 270) > 20), F * 0.18);
  font(c, F * 0.085, 700, UI_FONT);
  text(c, 'UP', cx - F * 0.4, cy - F * 0.17, MARK);
  text(c, 'DOWN', cx - F * 0.4, cy + F * 0.17, MARK);
  font(c, F * 0.07, 700, UI_FONT);
  text(c, 'VERTICAL SPEED', cx + F * 0.06, cy - F * 0.3, MARK_DIM);
  font(c, F * 0.06, 600, UI_FONT);
  text(c, '100 FT PER MIN', cx + F * 0.06, cy + F * 0.3, MARK_DIM);
  // The ±2000 pegs share 3 o'clock: label it once.
  font(c, F * 0.16, 600);
  text(c, '20', px(cx, F * 0.62, 90), py(cy, F * 0.62, 90), MARK);
}

export const drawVsi: GaugeDrawer = (ctx, cx, cy, size, r) => {
  const s = sz(size);
  if (!s || !Number.isFinite(cx) || !Number.isFinite(cy)) return;
  cachedFace(ctx, isSimpleFace(s) ? 'vsiS' : 'vsi', cx, cy, s, vsiFace);
  const F = (s / 2) * 0.885;
  needle(ctx, cx, cy, vsiNeedleDeg(r.verticalSpeedFpm), F * 0.88, F * 0.22, F * 0.075);
  hub(ctx, cx, cy, F * 0.09);
  drawGlass(ctx, cx, cy, s);
};

// ─── Tachometer ──────────────────────────────────────────────────────────────

function tachFace(c: CanvasRenderingContext2D, cx: number, cy: number, size: number): void {
  const F = drawCase(c, cx, cy, size);
  band(c, cx, cy, F * 0.875, F * 0.08, tachNeedleDeg(CONFIG.hud.tachGreenLowRpm), tachNeedleDeg(CONFIG.hud.tachGreenHighRpm), GREEN);
  c.beginPath();
  ticks(c, cx, cy, [tachNeedleDeg(CONFIG.aircraft.engine.maxRpm)], F * 0.74, F * 0.95);
  c.strokeStyle = RED;
  c.lineWidth = F * 0.04;
  c.stroke();
  const minor: number[] = [];
  const major: number[] = [];
  if (isSimpleFace(size)) {
    for (let v = 0; v <= TACH_MAX; v += 500) (v % 1000 === 0 ? major : minor).push(tachNeedleDeg(v));
    strokeTicks(c, cx, cy, minor, F * 0.84, F * 0.95, F * 0.035);
    strokeTicks(c, cx, cy, major, F * 0.76, F * 0.95, F * 0.05);
    numerals(c, cx, cy, F * 0.56, [0, 1000, 2000, 3000].map((v) => [tachNeedleDeg(v), String(v / 100)] as [number, string]), F * 0.3);
    font(c, F * 0.24, 800, UI_FONT);
    text(c, 'RPM', cx, cy + F * 0.42, MARK);
    return;
  }
  for (let v = 0; v <= TACH_MAX; v += 100) (v % 500 === 0 ? major : minor).push(tachNeedleDeg(v));
  strokeTicks(c, cx, cy, minor, F * 0.87, F * 0.95, F * 0.02);
  strokeTicks(c, cx, cy, major, F * 0.78, F * 0.95, F * 0.034);
  const labels: [number, string][] = [];
  for (let v = 0; v <= TACH_MAX; v += 500) labels.push([tachNeedleDeg(v), String(v / 100)]);
  numerals(c, cx, cy, F * 0.62, labels, F * 0.17);
  font(c, F * 0.12, 700, UI_FONT);
  text(c, 'RPM', cx, cy - F * 0.3, MARK);
  font(c, F * 0.065, 600, UI_FONT);
  text(c, 'HUNDREDS', cx, cy - F * 0.17, MARK_DIM);
  // Hour meter.
  const w = F * 0.5;
  const h = F * 0.14;
  roundRect(c, cx - w / 2, cy + F * 0.36, w, h, h * 0.15);
  c.fillStyle = '#050505';
  c.fill();
  font(c, F * 0.095, 700);
  const digits = ['0', '4', '1', '7', '2'];
  digits.forEach((d, i) => text(c, d, cx - w / 2 + (w / 5) * (i + 0.5), cy + F * 0.36 + h / 2, i === 4 ? '#111' : MARK));
  // Tenths wheel is white-on-black inverted like the real counter.
  c.fillStyle = MARK;
  c.fillRect(cx + w / 2 - w / 5, cy + F * 0.36 + h * 0.08, w / 5 - h * 0.08, h * 0.84);
  text(c, '2', cx + w / 2 - w / 10, cy + F * 0.36 + h / 2, '#111');
  font(c, F * 0.05, 600, UI_FONT);
  text(c, 'HOURS', cx, cy + F * 0.58, MARK_DIM);
}

export const drawTachometer: GaugeDrawer = (ctx, cx, cy, size, r) => {
  const s = sz(size);
  if (!s || !Number.isFinite(cx) || !Number.isFinite(cy)) return;
  cachedFace(ctx, isSimpleFace(s) ? 'tachS' : 'tach', cx, cy, s, tachFace);
  const F = (s / 2) * 0.885;
  needle(ctx, cx, cy, tachNeedleDeg(r.rpm), F * 0.86, F * 0.22, F * 0.075);
  hub(ctx, cx, cy, F * 0.09);
  drawGlass(ctx, cx, cy, s);
};

// ─── Helicopter gauges (Bell 206B-3 JetRanger) ───────────────────────────────

/**
 * Markings of the JetRanger's engine and rotor instruments, % (after the 206B-3 flight manual):
 * the dual tachometer's rotor (NR) scale — red 90, green 95–104, red 107 — and its inner power
 * turbine (N2) scale — green 97–100, red 105; the torquemeter — green 0–85, yellow 85–100
 * (5-minute take-off range), red line 100; the gas producer (N1) — red 105.
 */
export const HELI_MARKS = {
  nr: { redLow: 90, greenLow: 95, greenHigh: 104, redHigh: 107 },
  n2: { greenLow: 97, greenHigh: 100, redHigh: 105 },
  torque: { greenHigh: 85, red: 100, max: 110 },
  n1: { red: 105 },
} as const;

const DT_SPLIT = 60;
/** Dual tach: 0 % at -135°, 0–60 % compressed into 70°, 60–120 % spread over 200° (the working range reads large). */
export function dualTachNeedleDeg(pct: number): number {
  const v = clamp(fin(pct), 0, 120);
  if (v <= DT_SPLIT) return -135 + (v / DT_SPLIT) * 70;
  return -65 + ((v - DT_SPLIT) / (120 - DT_SPLIT)) * 200;
}

/** Torquemeter: 0 % at -135°, 110 % at +135°, linear. */
export function torqueNeedleDeg(pct: number): number {
  return -135 + (clamp(fin(pct), 0, HELI_MARKS.torque.max) / HELI_MARKS.torque.max) * 270;
}

/** Helicopter airspeed indicator: 0 at 12 o'clock, 0–20 kt in the first 20° (the pitot reads nothing in a hover), then 20→150 kt over 310°. */
export function heliAsiNeedleDeg(kt: number): number {
  const v = fin(kt);
  if (v <= 0) return 0;
  if (v <= 20) return v;
  return Math.min(20 + ((v - 20) * 310) / 130, 335);
}

function redLine(c: CanvasRenderingContext2D, cx: number, cy: number, deg: number, r0: number, r1: number, width: number): void {
  c.beginPath();
  ticks(c, cx, cy, [deg], r0, r1);
  c.strokeStyle = RED;
  c.lineWidth = width;
  c.lineCap = 'butt';
  c.stroke();
}

function heliAsiFace(vneKt: number) {
  return (c: CanvasRenderingContext2D, cx: number, cy: number, size: number): void => {
    const F = drawCase(c, cx, cy, size);
    // No flap or stall arcs on a helicopter's ASI: just the Vne red line.
    redLine(c, cx, cy, heliAsiNeedleDeg(vneKt), F * 0.72, F * 0.95, F * 0.05);
    const minor: number[] = [];
    const major: number[] = [];
    const simple = isSimpleFace(size);
    for (let v = 20; v <= 150; v += simple ? 10 : 5) ((simple ? v % 20 === 0 : v % 10 === 0) ? major : minor).push(heliAsiNeedleDeg(v));
    strokeTicks(c, cx, cy, minor, F * (simple ? 0.84 : 0.86), F * 0.94, F * (simple ? 0.035 : 0.022));
    strokeTicks(c, cx, cy, major, F * (simple ? 0.76 : 0.8), F * 0.94, F * (simple ? 0.05 : 0.032));
    strokeTicks(c, cx, cy, [0], F * 0.8, F * 0.94, F * 0.032);
    if (simple) {
      numerals(c, cx, cy, F * 0.55, [40, 80, 120].map((v) => [heliAsiNeedleDeg(v), String(v)] as [number, string]), F * 0.3);
      font(c, F * 0.24, 800, UI_FONT);
      text(c, 'KT', cx, cy - F * 0.3, MARK);
      return;
    }
    const labels: [number, string][] = [];
    for (let v = 20; v <= 140; v += 20) labels.push([heliAsiNeedleDeg(v), String(v)]);
    numerals(c, cx, cy, F * 0.6, labels, F * 0.17);
    font(c, F * 0.085, 700, UI_FONT);
    text(c, 'AIRSPEED', cx, cy - F * 0.3, MARK_DIM);
    font(c, F * 0.1, 700, UI_FONT);
    text(c, 'KNOTS', cx, cy + F * 0.3, MARK);
  };
}

/** The helicopter's airspeed indicator (0–150 kt, red line at `vneKt`). */
export function makeHeliAirspeed(vneKt: number): GaugeDrawer {
  const vne = clamp(fin(vneKt, 130), 20, 150);
  const face = heliAsiFace(vne);
  return (ctx, cx, cy, size, r) => {
    const s = sz(size);
    if (!s || !Number.isFinite(cx) || !Number.isFinite(cy)) return;
    cachedFace(ctx, `hasi${isSimpleFace(s) ? 'S' : ''}${Math.round(vne)}`, cx, cy, s, face);
    const F = (s / 2) * 0.885;
    needle(ctx, cx, cy, heliAsiNeedleDeg(r.airspeedKt), F * 0.88, F * 0.22, F * 0.075);
    hub(ctx, cx, cy, F * 0.09);
    drawGlass(ctx, cx, cy, s);
  };
}

const N2_NEEDLE = '#ffb547';

function dualTachFace(c: CanvasRenderingContext2D, cx: number, cy: number, size: number): void {
  const F = drawCase(c, cx, cy, size);
  const M = HELI_MARKS;
  const simple = isSimpleFace(size);
  // Outer scale: rotor (NR). Green band, red limits.
  band(c, cx, cy, F * 0.875, F * 0.08, dualTachNeedleDeg(M.nr.greenLow), dualTachNeedleDeg(M.nr.greenHigh), GREEN);
  redLine(c, cx, cy, dualTachNeedleDeg(M.nr.redLow), F * 0.74, F * 0.95, F * 0.04);
  redLine(c, cx, cy, dualTachNeedleDeg(M.nr.redHigh), F * 0.74, F * 0.95, F * 0.04);
  // Inner scale: power turbine (N2), drawn in the turbine needle's colour.
  band(c, cx, cy, F * 0.7, F * 0.05, dualTachNeedleDeg(M.n2.greenLow), dualTachNeedleDeg(M.n2.greenHigh), GREEN);
  redLine(c, cx, cy, dualTachNeedleDeg(M.n2.redHigh), F * 0.64, F * 0.74, F * 0.035);
  const minor: number[] = [];
  const major: number[] = [];
  for (let v = 0; v <= 120; v += simple ? 10 : 5) {
    if (v < DT_SPLIT && v % 20 !== 0) continue;
    (v % 20 === 0 ? major : minor).push(dualTachNeedleDeg(v));
  }
  strokeTicks(c, cx, cy, minor, F * (simple ? 0.84 : 0.86), F * 0.95, F * (simple ? 0.035 : 0.022));
  strokeTicks(c, cx, cy, major, F * (simple ? 0.76 : 0.78), F * 0.95, F * (simple ? 0.05 : 0.034));
  if (simple) {
    // The needle rests on 100 %: that numeral would only hide under it (the green band marks it).
    numerals(c, cx, cy, F * 0.54, [0, 60, 80, 120].map((v) => [dualTachNeedleDeg(v), String(v / 10)] as [number, string]), F * 0.27);
    font(c, F * 0.22, 800, UI_FONT);
    text(c, 'R', cx - F * 0.12, cy + F * 0.58, MARK);
    text(c, 'T', cx + F * 0.12, cy + F * 0.58, N2_NEEDLE);
    return;
  }
  numerals(c, cx, cy, F * 0.63, [0, 20, 40, 60, 70, 80, 90, 100, 110, 120].map((v) => [dualTachNeedleDeg(v), String(v / 10)] as [number, string]), F * 0.15);
  font(c, F * 0.075, 700, UI_FONT);
  text(c, 'RPM % ×10', cx, cy - F * 0.3, MARK_DIM);
  font(c, F * 0.09, 800, UI_FONT);
  text(c, 'R ROTOR', cx, cy + F * 0.36, MARK);
  text(c, 'T TURB', cx, cy + F * 0.5, N2_NEEDLE);
}

/** Dual tachometer: rotor (NR, white "R" needle) and power turbine (N2, amber "T" needle), %. */
export const drawDualTach: GaugeDrawer = (ctx, cx, cy, size, r) => {
  const s = sz(size);
  if (!s || !Number.isFinite(cx) || !Number.isFinite(cy)) return;
  cachedFace(ctx, isSimpleFace(s) ? 'dtachS' : 'dtach', cx, cy, s, dualTachFace);
  const F = (s / 2) * 0.885;
  const rot = r.rotor;
  // N2 under NR: when they agree (the engine driving the rotor) the rotor needle covers it.
  needle(ctx, cx, cy, dualTachNeedleDeg(rot?.n2Pct ?? 0), F * 0.7, F * 0.18, F * 0.085, N2_NEEDLE);
  needle(ctx, cx, cy, dualTachNeedleDeg(rot?.nrPct ?? 0), F * 0.88, F * 0.22, F * 0.065);
  hub(ctx, cx, cy, F * 0.09);
  drawGlass(ctx, cx, cy, s);
};

function torqueFace(c: CanvasRenderingContext2D, cx: number, cy: number, size: number): void {
  const F = drawCase(c, cx, cy, size);
  const T = HELI_MARKS.torque;
  const simple = isSimpleFace(size);
  band(c, cx, cy, F * 0.875, F * 0.08, torqueNeedleDeg(0), torqueNeedleDeg(T.greenHigh), GREEN);
  band(c, cx, cy, F * 0.875, F * 0.08, torqueNeedleDeg(T.greenHigh), torqueNeedleDeg(T.red), YELLOW);
  redLine(c, cx, cy, torqueNeedleDeg(T.red), F * 0.72, F * 0.95, F * 0.05);
  const minor: number[] = [];
  const major: number[] = [];
  for (let v = 0; v <= T.max; v += simple ? 10 : 5) (v % 20 === 0 ? major : minor).push(torqueNeedleDeg(v));
  strokeTicks(c, cx, cy, minor, F * (simple ? 0.84 : 0.86), F * 0.95, F * (simple ? 0.035 : 0.022));
  strokeTicks(c, cx, cy, major, F * (simple ? 0.76 : 0.78), F * 0.95, F * (simple ? 0.05 : 0.034));
  const labels = (simple ? [20, 60, 100] : [0, 20, 40, 60, 80, 100]).map((v) => [torqueNeedleDeg(v), String(v)] as [number, string]);
  numerals(c, cx, cy, simple ? F * 0.55 : F * 0.6, labels, simple ? F * 0.24 : F * 0.16);
  font(c, simple ? F * 0.2 : F * 0.11, 800, UI_FONT);
  text(c, 'TRQ', cx, cy - F * (simple ? 0.28 : 0.3), MARK);
  if (!simple) {
    font(c, F * 0.07, 700, UI_FONT);
    text(c, '% TORQUE', cx, cy - F * 0.18, MARK_DIM);
  }
  // N1 (gas producer) window at the bottom.
  const w = F * (simple ? 0.76 : 0.7);
  const h = F * (simple ? 0.28 : 0.2);
  roundRect(c, cx - w / 2, cy + F * (simple ? 0.42 : 0.38), w, h, h * 0.18);
  c.fillStyle = '#050505';
  c.fill();
  c.strokeStyle = '#3a3b3e';
  c.lineWidth = F * 0.015;
  c.stroke();
}

/** Torquemeter (0–110 %, green to 85, yellow to the 100 % red line) with the gas producer N1 in a window. */
export const drawTorque: GaugeDrawer = (ctx, cx, cy, size, r) => {
  const s = sz(size);
  if (!s || !Number.isFinite(cx) || !Number.isFinite(cy)) return;
  const simple = isSimpleFace(s);
  cachedFace(ctx, simple ? 'trqS' : 'trq', cx, cy, s, torqueFace);
  const F = (s / 2) * 0.885;
  const rot = r.rotor;
  const n1 = clamp(fin(rot?.n1Pct ?? 0), 0, 120);
  const h = F * (simple ? 0.28 : 0.2);
  font(ctx, h * 0.72, 700, simple ? UI_FONT : DIAL_FONT);
  text(ctx, `N1 ${n1.toFixed(simple ? 0 : 1)}`, cx, cy + F * (simple ? 0.42 : 0.38) + h * 0.53, n1 > HELI_MARKS.n1.red ? '#ff8a7e' : MARK);
  needle(ctx, cx, cy, torqueNeedleDeg(rot?.torquePct ?? 0), F * 0.86, F * 0.22, F * 0.075);
  hub(ctx, cx, cy, F * 0.09);
  drawGlass(ctx, cx, cy, s);
};

/** The six-pack plus the tach, by name. */
export const GAUGES: Record<'airspeed' | 'attitude' | 'altimeter' | 'turn' | 'heading' | 'vsi' | 'tach', GaugeDrawer> = {
  airspeed: drawAirspeed,
  attitude: drawAttitude,
  altimeter: drawAltimeter,
  turn: drawTurnCoordinator,
  heading: drawHeading,
  vsi: drawVsi,
  tach: drawTachometer,
};

// ─── Compact system cells (HUD strip) ────────────────────────────────────────

const LAMP = {
  green: ['#6dff8e', '#1aa53e', 'rgba(60,255,120,0.45)'],
  red: ['#ff7a6e', '#c4231a', 'rgba(255,70,50,0.5)'],
  amber: ['#ffd27a', '#d68a12', 'rgba(255,170,40,0.45)'],
  off: ['#3a3d40', '#1a1c1e', 'rgba(0,0,0,0)'],
} as const;

function lamp(c: CanvasRenderingContext2D, x: number, y: number, r: number, kind: keyof typeof LAMP): void {
  const [hi, lo, glow] = LAMP[kind];
  if (kind !== 'off') {
    const gg = c.createRadialGradient(x, y, r * 0.5, x, y, r * 2.1);
    gg.addColorStop(0, glow);
    gg.addColorStop(1, 'rgba(0,0,0,0)');
    circle(c, x, y, r * 2.1);
    c.fillStyle = gg;
    c.fill();
  }
  const g = c.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.1, x, y, r);
  g.addColorStop(0, hi);
  g.addColorStop(1, lo);
  circle(c, x, y, r);
  c.fillStyle = g;
  c.fill();
  c.strokeStyle = 'rgba(0,0,0,0.6)';
  c.lineWidth = Math.max(0.5, r * 0.18);
  c.stroke();
}

const STRIP_LABEL = 'rgba(214,224,238,0.62)';
const STRIP_VALUE = '#eef3fa';

/** Label (left) and value (right) on the top line of a cell; returns the body box below it. */
function cellHeader(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, label: string, value: string, valueColor = STRIP_VALUE) {
  const pad = Math.max(2, h * 0.14);
  const ly = y + h * 0.3;
  font(c, h * 0.2, 700, UI_FONT);
  text(c, label, x + pad, ly, STRIP_LABEL, 'left');
  if (value) {
    // The value shrinks (never below 70 %) so it never runs into the label.
    const labelW = measure(c, label);
    let vpx = h * 0.27;
    font(c, vpx, 700, UI_FONT);
    const room = w - pad * 2 - labelW - h * 0.12;
    const vw = measure(c, value);
    if (vw > room && vw > 0) {
      vpx = Math.max(h * 0.19, (vpx * room) / vw);
      font(c, vpx, 700, UI_FONT);
    }
    text(c, value, x + w - pad, ly, valueColor, 'right');
  }
  return { bx: x + pad, by: y + h * 0.56, bw: Math.max(0, w - pad * 2), bh: h * 0.3 };
}

/** Text width in px (0 when the context cannot measure). */
function measure(c: CanvasRenderingContext2D, s: string): number {
  const m = typeof c.measureText === 'function' ? c.measureText(s) : null;
  const w = m ? m.width : 0;
  return Number.isFinite(w) ? w : 0;
}

function track(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  roundRect(c, x, y, w, h, h / 2);
  c.fillStyle = 'rgba(255,255,255,0.1)';
  c.fill();
}

export const drawThrottle: CellDrawer = (c, x, y, w, h, r) => {
  if (!sz(w) || !sz(h) || !Number.isFinite(x) || !Number.isFinite(y)) return;
  const pct = clamp(fin(r.throttlePct), 0, 100);
  c.save();
  const b = cellHeader(c, x, y, w, h, 'THROTTLE', `${Math.round(pct)}%`);
  const th = b.bh * 0.55;
  const ty = b.by + (b.bh - th) / 2;
  track(c, b.bx, ty, b.bw, th);
  const fw = (b.bw * pct) / 100;
  if (fw > 0.5) {
    const g = c.createLinearGradient(b.bx, 0, b.bx + b.bw, 0);
    g.addColorStop(0, '#3d8bd8');
    g.addColorStop(1, '#8fd3ff');
    roundRect(c, b.bx, ty, Math.max(th, fw), th, th / 2);
    c.fillStyle = g;
    c.fill();
  }
  circle(c, b.bx + Math.max(th / 2, fw - th / 2), ty + th / 2, th * 0.85);
  c.fillStyle = '#101214';
  c.fill();
  c.strokeStyle = '#dfe8f2';
  c.lineWidth = Math.max(0.5, th * 0.25);
  c.stroke();
  c.restore();
};

export const drawFlaps: CellDrawer = (c, x, y, w, h, r) => {
  if (!sz(w) || !sz(h) || !Number.isFinite(x) || !Number.isFinite(y)) return;
  // The flown aircraft's gates (F-16 0/10/20, A-10 0/7/20…); the Cessna's when the readings don't say.
  const notches = r.flapNotchesDeg && r.flapNotchesDeg.length > 1 ? r.flapNotchesDeg : CONFIG.aircraft.flaps.notchesDeg;
  const max = notches[notches.length - 1] || 30;
  const deg = clamp(fin(r.flapsDeg), 0, max);
  const tgt = clamp(fin(r.flapsTargetDeg), 0, max);
  const moving = Math.abs(deg - tgt) > 0.5;
  c.save();
  const value = moving ? `${Math.round(deg)}°→${Math.round(tgt)}°` : `${Math.round(deg)}°`;
  const b = cellHeader(c, x, y, w, h, 'FLAPS', value, moving ? '#ffd27a' : STRIP_VALUE);
  const ly = b.by + b.bh * 0.5;
  c.beginPath();
  c.moveTo(b.bx, ly);
  c.lineTo(b.bx + b.bw, ly);
  c.strokeStyle = 'rgba(255,255,255,0.22)';
  c.lineWidth = Math.max(0.5, h * 0.03);
  c.stroke();
  for (const n of notches) {
    const nx = b.bx + (b.bw * n) / max;
    const on = Math.abs(n - tgt) < 0.01;
    c.beginPath();
    c.moveTo(nx, ly - b.bh * 0.45);
    c.lineTo(nx, ly + b.bh * 0.45);
    c.strokeStyle = on ? '#8fd3ff' : 'rgba(255,255,255,0.45)';
    c.lineWidth = Math.max(0.5, on ? h * 0.05 : h * 0.03);
    c.stroke();
  }
  const ax = b.bx + (b.bw * deg) / max;
  c.beginPath();
  c.moveTo(ax, ly - b.bh * 0.1);
  c.lineTo(ax - b.bh * 0.45, ly + b.bh * 0.65);
  c.lineTo(ax + b.bh * 0.45, ly + b.bh * 0.65);
  c.closePath();
  c.fillStyle = STRIP_VALUE;
  c.fill();
  c.restore();
};

export const drawGear: CellDrawer = (c, x, y, w, h, r) => {
  if (!sz(w) || !sz(h) || !Number.isFinite(x) || !Number.isFinite(y)) return;
  const word = r.gear === 'down' ? 'DOWN' : r.gear === 'up' ? 'UP' : 'TRANSIT';
  const kind = r.gearLight === 'green' ? 'green' : r.gearLight === 'red' ? 'red' : 'off';
  const color = kind === 'green' ? '#7dffa0' : kind === 'red' ? '#ff8a7e' : STRIP_VALUE;
  c.save();
  const b = cellHeader(c, x, y, w, h, 'GEAR', word, color);
  const lr = Math.min(b.bh * 0.42, b.bw / 10);
  const midY = b.by + b.bh / 2;
  const span = Math.min(b.bw * 0.6, lr * 7);
  const x0 = b.bx + (b.bw - span) / 2;
  for (let i = 0; i < 3; i++) lamp(c, x0 + (span * i) / 2, midY, lr, kind);
  c.restore();
};

export const drawTrim: CellDrawer = (c, x, y, w, h, r) => {
  if (!sz(w) || !sz(h) || !Number.isFinite(x) || !Number.isFinite(y)) return;
  const t = clamp(fin(r.trimPct), -100, 100);
  const v = Math.round(t);
  c.save();
  const b = cellHeader(c, x, y, w, h, 'TRIM', v === 0 ? '0' : v > 0 ? `${v} UP` : `${-v} DN`);
  const ly = b.by + b.bh * 0.5;
  track(c, b.bx, ly - b.bh * 0.18, b.bw, b.bh * 0.36);
  const mx = b.bx + b.bw / 2;
  c.beginPath();
  c.moveTo(mx, ly - b.bh * 0.5);
  c.lineTo(mx, ly + b.bh * 0.5);
  c.strokeStyle = 'rgba(255,255,255,0.45)';
  c.lineWidth = Math.max(0.5, h * 0.03);
  c.stroke();
  const pxx = mx + (b.bw / 2) * (t / 100);
  roundRect(c, pxx - b.bh * 0.22, ly - b.bh * 0.5, b.bh * 0.44, b.bh, b.bh * 0.12);
  c.fillStyle = '#f7d37a';
  c.fill();
  c.restore();
};

function pill(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, label: string, kind: keyof typeof LAMP): void {
  roundRect(c, x, y, w, h, h * 0.3);
  if (kind === 'off') {
    c.fillStyle = 'rgba(255,255,255,0.06)';
    c.fill();
    c.strokeStyle = 'rgba(255,255,255,0.14)';
  } else {
    const [hi, lo] = LAMP[kind];
    const g = c.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, hi);
    g.addColorStop(1, lo);
    c.fillStyle = g;
    c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.5)';
  }
  c.lineWidth = Math.max(0.5, h * 0.06);
  c.stroke();
  // Fit the label inside the pill (≈0.62 em per character of this bold caps face).
  font(c, Math.min(h * 0.56, (w * 0.86) / Math.max(1, label.length * 0.66)), 800, UI_FONT);
  text(c, label, x + w / 2, y + h * 0.54, kind === 'off' ? 'rgba(214,224,238,0.45)' : '#1a0f05');
}

export const drawBrakes: CellDrawer = (c, x, y, w, h, r) => {
  if (!sz(w) || !sz(h) || !Number.isFinite(x) || !Number.isFinite(y)) return;
  c.save();
  const pad = Math.max(2, h * 0.14);
  const ph = h * 0.3;
  const pw = w - pad * 2;
  pill(c, x + pad, y + h * 0.14, pw, ph, 'BRAKE', r.brakes ? 'amber' : 'off');
  pill(c, x + pad, y + h * 0.56, pw, ph, 'PARK', r.parkingBrake ? 'red' : 'off');
  c.restore();
};

export const drawEngine: CellDrawer = (c, x, y, w, h, r) => {
  if (!sz(w) || !sz(h) || !Number.isFinite(x) || !Number.isFinite(y)) return;
  const st = r.engineStatus;
  const kind = st === 'RUNNING' ? 'green' : st === 'STARTING' ? 'amber' : st === 'FAILED' ? 'red' : 'off';
  const word = st === 'RUNNING' ? 'RUN' : st === 'STARTING' ? 'START' : st === 'FAILED' ? 'FAIL' : 'OFF';
  c.save();
  const rpm = Math.round(clamp(fin(r.rpm), 0, 9999) / 10) * 10;
  const b = cellHeader(c, x, y, w, h, 'ENGINE', `${rpm}`);
  const lr = Math.min(b.bh * 0.42, b.bw / 8);
  lamp(c, b.bx + lr * 1.2, b.by + b.bh / 2, lr, kind);
  font(c, h * 0.22, 800, UI_FONT);
  text(c, word, b.bx + lr * 3, b.by + b.bh / 2 + h * 0.01, kind === 'red' ? '#ff8a7e' : kind === 'off' ? STRIP_LABEL : STRIP_VALUE, 'left');
  font(c, h * 0.16, 700, UI_FONT);
  text(c, 'RPM', b.bx + b.bw, b.by + b.bh / 2 + h * 0.01, STRIP_LABEL, 'right');
  c.restore();
};

/** The compact system cells in strip order, with their width:height aspect. */
export const SYSTEM_CELLS: Record<'throttle' | 'flaps' | 'gear' | 'trim' | 'brakes' | 'engine', { aspect: number; draw: CellDrawer }> = {
  throttle: { aspect: 2.3, draw: drawThrottle },
  flaps: { aspect: 2.25, draw: drawFlaps },
  gear: { aspect: 2.0, draw: drawGear },
  trim: { aspect: 1.7, draw: drawTrim },
  brakes: { aspect: 1.35, draw: drawBrakes },
  engine: { aspect: 2.0, draw: drawEngine },
};

/** A bar cell: label, value, a track with optional coloured zones (fractions of the track) and a fill. */
function barCell(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, label: string, value: string, frac: number, valueColor = STRIP_VALUE, zones: readonly (readonly [number, number, string])[] = [], fill?: string): void {
  const b = cellHeader(c, x, y, w, h, label, value, valueColor);
  const th = b.bh * 0.55;
  const ty = b.by + (b.bh - th) / 2;
  track(c, b.bx, ty, b.bw, th);
  for (const [a, z, col] of zones) {
    const x0 = b.bx + b.bw * clamp(a, 0, 1);
    const x1 = b.bx + b.bw * clamp(z, 0, 1);
    if (x1 - x0 < 0.5) continue;
    c.fillStyle = col;
    c.fillRect(x0, ty + th * 0.7, x1 - x0, th * 0.3);
  }
  const f = clamp(fin(frac), 0, 1);
  const fw = b.bw * f;
  if (fw > 0.5) {
    roundRect(c, b.bx, ty, Math.max(th, fw), th * 0.7, th * 0.3);
    if (fill) c.fillStyle = fill;
    else {
      const g = c.createLinearGradient(b.bx, 0, b.bx + b.bw, 0);
      g.addColorStop(0, '#3d8bd8');
      g.addColorStop(1, '#8fd3ff');
      c.fillStyle = g;
    }
    c.fill();
  }
}

const ZONE_GREEN = 'rgba(47,191,87,0.85)';
const ZONE_YELLOW = 'rgba(244,197,28,0.9)';
const ZONE_RED = 'rgba(226,54,43,0.95)';
const VAL_GREEN = '#7dffa0';
const VAL_AMBER = '#ffd27a';
const VAL_RED = '#ff8a7e';

/** Helicopter: the collective lever, % (the throttle keys move it). */
export const drawCollective: CellDrawer = (c, x, y, w, h, r) => {
  if (!sz(w) || !sz(h) || !Number.isFinite(x) || !Number.isFinite(y)) return;
  const pct = clamp(fin(r.rotor?.collectivePct ?? r.throttlePct), 0, 100);
  c.save();
  barCell(c, x, y, w, h, 'COLLECTIVE', `${Math.round(pct)}%`, pct / 100);
  c.restore();
};

/** Helicopter: engine torque, % of the transmission limit (green · yellow · red over 100). */
export const drawTorqueCell: CellDrawer = (c, x, y, w, h, r) => {
  if (!sz(w) || !sz(h) || !Number.isFinite(x) || !Number.isFinite(y)) return;
  const T = HELI_MARKS.torque;
  const pct = clamp(fin(r.rotor?.torquePct ?? 0), 0, 150);
  const color = pct > T.red ? VAL_RED : pct > T.greenHigh ? VAL_AMBER : STRIP_VALUE;
  c.save();
  barCell(c, x, y, w, h, 'TRQ', `${Math.round(pct)}%`, pct / T.max, color, [
    [0, T.greenHigh / T.max, ZONE_GREEN],
    [T.greenHigh / T.max, T.red / T.max, ZONE_YELLOW],
    [T.red / T.max, 1, ZONE_RED],
  ], pct > T.red ? VAL_RED : pct > T.greenHigh ? VAL_AMBER : undefined);
  c.restore();
};

/** Helicopter: gas producer speed N1, %. */
export const drawN1Cell: CellDrawer = (c, x, y, w, h, r) => {
  if (!sz(w) || !sz(h) || !Number.isFinite(x) || !Number.isFinite(y)) return;
  const pct = clamp(fin(r.rotor?.n1Pct ?? 0), 0, 120);
  c.save();
  barCell(c, x, y, w, h, 'N1', `${Math.round(pct)}%`, pct / 110, pct > HELI_MARKS.n1.red ? VAL_RED : STRIP_VALUE, [[HELI_MARKS.n1.red / 110, 1, ZONE_RED]]);
  c.restore();
};

/** Helicopter: rotor speed NR, % — the bar spans 80–110 % around the green band; red below it. */
export const drawNrCell: CellDrawer = (c, x, y, w, h, r) => {
  if (!sz(w) || !sz(h) || !Number.isFinite(x) || !Number.isFinite(y)) return;
  const M = HELI_MARKS.nr;
  const pct = clamp(fin(r.rotor?.nrPct ?? 0), 0, 130);
  const lo = 80;
  const hi = 110;
  const f = (v: number) => (v - lo) / (hi - lo);
  const bad = pct < M.redLow + 5 || pct > M.redHigh;
  const color = r.rotor?.lowRotorRpm || bad ? VAL_RED : pct >= M.greenLow && pct <= M.greenHigh ? VAL_GREEN : VAL_AMBER;
  c.save();
  barCell(c, x, y, w, h, 'NR', `${Math.round(pct)}%`, f(pct), color, [
    [0, f(M.redLow), ZONE_RED],
    [f(M.greenLow), f(M.greenHigh), ZONE_GREEN],
    [f(M.redHigh), 1, ZONE_RED],
  ], color);
  c.restore();
};

/** Helicopter: stability assist lamp (K), and the skids (fixed gear: nothing to do). */
export const drawSasCell: CellDrawer = (c, x, y, w, h, r) => {
  if (!sz(w) || !sz(h) || !Number.isFinite(x) || !Number.isFinite(y)) return;
  const on = r.rotor ? r.rotor.sas : true;
  c.save();
  const pad = Math.max(2, h * 0.14);
  const ph = h * 0.3;
  const pw = w - pad * 2;
  pill(c, x + pad, y + h * 0.14, pw, ph, on ? 'SAS ON' : 'SAS OFF', on ? 'green' : 'amber');
  pill(c, x + pad, y + h * 0.56, pw, ph, 'SKIDS', 'off');
  c.restore();
};

/** Helicopter engine cell: status lamp and the power-turbine speed. */
export const drawHeliEngine: CellDrawer = (c, x, y, w, h, r) => {
  if (!sz(w) || !sz(h) || !Number.isFinite(x) || !Number.isFinite(y)) return;
  const st = r.engineStatus;
  const kind = st === 'RUNNING' ? 'green' : st === 'STARTING' ? 'amber' : st === 'FAILED' ? 'red' : 'off';
  const word = st === 'RUNNING' ? 'RUN' : st === 'STARTING' ? 'START' : st === 'FAILED' ? 'FAIL' : 'OFF';
  c.save();
  const n2 = Math.round(clamp(fin(r.rotor?.n2Pct ?? 0), 0, 130));
  const b = cellHeader(c, x, y, w, h, 'ENGINE', `${n2}%`);
  const lr = Math.min(b.bh * 0.42, b.bw / 8);
  lamp(c, b.bx + lr * 1.2, b.by + b.bh / 2, lr, kind);
  font(c, h * 0.22, 800, UI_FONT);
  text(c, word, b.bx + lr * 3, b.by + b.bh / 2 + h * 0.01, kind === 'red' ? VAL_RED : kind === 'off' ? STRIP_LABEL : STRIP_VALUE, 'left');
  font(c, h * 0.16, 700, UI_FONT);
  text(c, 'N2', b.bx + b.bw, b.by + b.bh / 2 + h * 0.01, STRIP_LABEL, 'right');
  c.restore();
};

/** The helicopter's strip cells: no flaps, gear or brakes (skids), the rotor and engine instead. */
export const HELI_SYSTEM_CELLS: Record<'collective' | 'torque' | 'n1' | 'nr' | 'sas' | 'engine', { aspect: number; draw: CellDrawer }> = {
  collective: { aspect: 2.3, draw: drawCollective },
  torque: { aspect: 1.8, draw: drawTorqueCell },
  n1: { aspect: 1.5, draw: drawN1Cell },
  nr: { aspect: 1.6, draw: drawNrCell },
  sas: { aspect: 1.35, draw: drawSasCell },
  engine: { aspect: 2.0, draw: drawHeliEngine },
};

/** Which set of strip cells: the fixed-wing one (throttle, flaps, gear…) or the helicopter's. */
export type StripKind = 'fixed' | 'heli';

type CellSpec = { aspect: number; draw: CellDrawer };
const CELL_SETS: Record<StripKind, { one: CellSpec[]; two: CellSpec[][] }> = (() => {
  const fixed = Object.values(SYSTEM_CELLS);
  const heli = Object.values(HELI_SYSTEM_CELLS);
  // Two rows of three: throttle · flaps · gear / trim · brakes · engine (collective · TRQ · N1 / NR · SAS · engine).
  return { fixed: { one: fixed, two: [fixed.slice(0, 3), fixed.slice(3)] }, heli: { one: heli, two: [heli.slice(0, 3), heli.slice(3)] } };
})();
const aspectSum = (cells: { aspect: number }[]) => cells.reduce((s, k) => s + k.aspect, 0);

/** Width of the strip for a cell height: one row, or two rows of three (the wider row sets the width). */
export function systemsStripWidth(cellH: number, rows: 1 | 2 = 1, kind: StripKind = 'fixed'): number {
  const set = CELL_SETS[kind] ?? CELL_SETS.fixed;
  const a = rows === 1 ? aspectSum(set.one) : Math.max(aspectSum(set.two[0]), aspectSum(set.two[1]));
  return a * sz(cellH);
}

/**
 * All system cells in x,y,w,h, sharing each row's width by aspect, with
 * hairline dividers: one row (default) or two rows of three.
 */
export function drawSystemsStrip(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: InstrumentReadings, rows: 1 | 2 = 1, kind: StripKind = 'fixed'): void {
  const W = sz(w);
  const H = sz(h);
  if (!W || !H || !Number.isFinite(x) || !Number.isFinite(y)) return;
  const set = CELL_SETS[kind] ?? CELL_SETS.fixed;
  const lines = rows === 2 ? set.two : [set.one];
  const rh = H / lines.length;
  ctx.save();
  lines.forEach((cells, row) => {
    const total = aspectSum(cells);
    const ry = y + row * rh;
    let cx = x;
    cells.forEach((cell, i) => {
      const cw = (W * cell.aspect) / total;
      cell.draw(ctx, cx, ry, cw, rh, r);
      if (i > 0) {
        ctx.beginPath();
        ctx.moveTo(cx + 0.5, ry + rh * 0.18);
        ctx.lineTo(cx + 0.5, ry + rh * 0.82);
        ctx.strokeStyle = 'rgba(255,255,255,0.1)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      cx += cw;
    });
    if (row > 0) {
      ctx.beginPath();
      ctx.moveTo(x + W * 0.03, ry + 0.5);
      ctx.lineTo(x + W * 0.97, ry + 0.5);
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  });
  ctx.restore();
}

// ─── Compass tape ────────────────────────────────────────────────────────────

/**
 * Horizontal heading tape (±40° visible) with the digital heading in a box
 * under the lubber mark. x,y,w,h is the whole widget; the tape takes the upper
 * 58 %, the readout the rest.
 */
export function drawCompassTape(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, headingDeg: number): void {
  const W = sz(w);
  const H = sz(h);
  if (!W || !H || !Number.isFinite(x) || !Number.isFinite(y)) return;
  const hdg = wrap360(headingDeg);
  const cx = x + W / 2;
  const tapeH = H * 0.58;
  const ppd = W / 80;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, W, tapeH);
  ctx.clip();
  const first = Math.floor((hdg - 44) / 5) * 5;
  ctx.beginPath();
  for (let d = first; d <= hdg + 44; d += 5) {
    const tx = cx + (d - hdg) * ppd;
    const len = d % 10 === 0 ? tapeH * 0.28 : tapeH * 0.16;
    ctx.moveTo(tx, y + tapeH - len);
    ctx.lineTo(tx, y + tapeH);
  }
  ctx.strokeStyle = 'rgba(235,242,250,0.75)';
  ctx.lineWidth = Math.max(1, H * 0.03);
  ctx.stroke();
  for (let d = Math.ceil((hdg - 44) / 10) * 10; d <= hdg + 44; d += 10) {
    const tx = cx + (d - hdg) * ppd;
    const lab = compassLabel(d);
    const cardinal = /[NESW]/.test(lab);
    const fade = 1 - Math.pow(Math.abs(tx - cx) / (W / 2), 3);
    ctx.globalAlpha = clamp(fade, 0, 1);
    font(ctx, cardinal ? tapeH * 0.44 : tapeH * 0.36, cardinal ? 800 : 600, UI_FONT);
    text(ctx, lab, tx, y + tapeH * 0.38, cardinal ? '#ffffff' : 'rgba(225,233,243,0.85)');
  }
  ctx.globalAlpha = 1;
  ctx.restore();
  // Lubber mark.
  ctx.beginPath();
  ctx.moveTo(cx, y + tapeH - tapeH * 0.05);
  ctx.lineTo(cx - tapeH * 0.16, y + tapeH + tapeH * 0.2);
  ctx.lineTo(cx + tapeH * 0.16, y + tapeH + tapeH * 0.2);
  ctx.closePath();
  ctx.fillStyle = '#ffb547';
  ctx.fill();
  // Digital readout.
  const rh = H - tapeH - H * 0.04;
  const rw = rh * 2.6;
  roundRect(ctx, cx - rw / 2, y + tapeH + H * 0.1, rw, rh * 0.86, rh * 0.2);
  ctx.fillStyle = 'rgba(5,9,15,0.85)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,181,71,0.7)';
  ctx.lineWidth = Math.max(0.75, H * 0.02);
  ctx.stroke();
  font(ctx, rh * 0.62, 700, UI_FONT);
  const shown = Math.round(hdg) % 360;
  text(ctx, `${String(shown).padStart(3, '0')}°`, cx + rh * 0.08, y + tapeH + H * 0.1 + rh * 0.45, '#ffffff');
}

// ─── The instrument panel (3D cockpit texture) ───────────────────────────────

function panelBackground(c: CanvasRenderingContext2D, w: number, h: number): void {
  const g = c.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#2f3134');
  g.addColorStop(0.5, '#27292c');
  g.addColorStop(1, '#1d1f21');
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);
  // Fine horizontal grain of the painted metal.
  c.fillStyle = 'rgba(255,255,255,0.018)';
  for (let yy = 0; yy < h; yy += Math.max(2, h / 180)) c.fillRect(0, yy, w, Math.max(0.5, h / 900));
  // Glareshield lip.
  const lip = h * 0.035;
  const lg = c.createLinearGradient(0, 0, 0, lip);
  lg.addColorStop(0, '#0d0e0f');
  lg.addColorStop(1, '#1a1b1d');
  c.fillStyle = lg;
  c.fillRect(0, 0, w, lip);
  c.fillStyle = 'rgba(255,255,255,0.08)';
  c.fillRect(0, lip, w, Math.max(1, h * 0.003));
}

/** Square mounting flange with four screws around a gauge. */
function flange(c: CanvasRenderingContext2D, cx: number, cy: number, size: number): void {
  const half = size * 0.54;
  roundRect(c, cx - half, cy - half, half * 2, half * 2, size * 0.08);
  const g = c.createLinearGradient(cx - half, cy - half, cx + half, cy + half);
  g.addColorStop(0, '#3a3c40');
  g.addColorStop(1, '#161719');
  c.fillStyle = g;
  c.fill();
  c.strokeStyle = 'rgba(0,0,0,0.55)';
  c.lineWidth = size * 0.01;
  c.stroke();
  const sr = size * 0.035;
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const x = cx + sx * half * 0.84;
    const y = cy + sy * half * 0.84;
    const sg = c.createRadialGradient(x - sr * 0.3, y - sr * 0.3, sr * 0.1, x, y, sr);
    sg.addColorStop(0, '#9a9ca0');
    sg.addColorStop(1, '#2a2b2d');
    circle(c, x, y, sr);
    c.fillStyle = sg;
    c.fill();
    c.beginPath();
    c.moveTo(x - sr * 0.7, y - sr * 0.2);
    c.lineTo(x + sr * 0.7, y + sr * 0.2);
    c.strokeStyle = '#141414';
    c.lineWidth = sr * 0.3;
    c.stroke();
  }
}

function placard(c: CanvasRenderingContext2D, s: string, x: number, y: number, px2: number, align: CanvasTextAlign = 'center', color = '#d9d6cc'): void {
  font(c, px2, 700, UI_FONT);
  text(c, s, x, y, color, align);
}

/** 172RG gear panel: the wheel-knob lever (up/down) and three position lights. */
function gearPanel(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: InstrumentReadings): void {
  roundRect(c, x, y, w, h, w * 0.06);
  c.fillStyle = '#1b1c1e';
  c.fill();
  c.strokeStyle = 'rgba(255,255,255,0.08)';
  c.lineWidth = w * 0.012;
  c.stroke();
  placard(c, 'GEAR', x + w / 2, y + h * 0.07, w * 0.11);
  const handleDown = (r as InstrumentReadings & { gearHandleDown?: boolean }).gearHandleDown ?? r.gear !== 'up';
  // Slot and lever.
  const sx = x + w * 0.3;
  const top = y + h * 0.2;
  const bot = y + h * 0.88;
  roundRect(c, sx - w * 0.035, top, w * 0.07, bot - top, w * 0.035);
  c.fillStyle = '#050505';
  c.fill();
  placard(c, 'UP', sx + w * 0.12, top + h * 0.02, w * 0.075, 'left', '#b9b6ad');
  placard(c, 'DOWN', sx + w * 0.12, bot - h * 0.02, w * 0.075, 'left', '#b9b6ad');
  const ky = handleDown ? bot - h * 0.06 : top + h * 0.06;
  // Wheel-shaped knob (the 172RG's gear handle is a little tyre).
  const kr = w * 0.13;
  const kg = c.createRadialGradient(sx - kr * 0.3, ky - kr * 0.3, kr * 0.2, sx, ky, kr);
  kg.addColorStop(0, '#f4f4f2');
  kg.addColorStop(1, '#9a9a96');
  circle(c, sx, ky, kr);
  c.fillStyle = '#0c0c0c';
  c.fill();
  circle(c, sx, ky, kr * 0.62);
  c.fillStyle = kg;
  c.fill();
  circle(c, sx, ky, kr * 0.2);
  c.fillStyle = '#555';
  c.fill();
  // Position lights: nose above, mains below — three greens down and locked, red in transit.
  const kind = r.gearLight === 'green' ? 'green' : r.gearLight === 'red' ? 'red' : 'off';
  const lx = x + w * 0.72;
  const lr = w * 0.085;
  lamp(c, lx, y + h * 0.34, lr, kind);
  lamp(c, lx - w * 0.14, y + h * 0.52, lr, kind);
  lamp(c, lx + w * 0.14, y + h * 0.52, lr, kind);
  // Gear warning light: red with the horn in flight (gear not down at low power / landing flaps),
  // amber when the squat switch is holding the gear down against an UP handle on the ground.
  const gw = gearFlags(r);
  const warn: keyof typeof LAMP = gw.gearUnsafe ? 'red' : gw.squatSwitch ? 'amber' : 'off';
  pill(c, lx - w * 0.21, y + h * 0.68, w * 0.42, h * 0.11, gw.squatSwitch && !gw.gearUnsafe ? 'SQUAT' : 'WARN', warn);
}

/** The 172's flap position indicator: a vertical slot with 0°/10°/20°/FULL marks and a pointer. */
function flapPanel(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: InstrumentReadings): void {
  roundRect(c, x, y, w, h, w * 0.06);
  c.fillStyle = '#1b1c1e';
  c.fill();
  placard(c, 'FLAPS', x + w / 2, y + h * 0.08, w * 0.11);
  const notches = CONFIG.aircraft.flaps.notchesDeg;
  const max = notches[notches.length - 1] || 30;
  const top = y + h * 0.2;
  const bot = y + h * 0.9;
  const sx = x + w * 0.42;
  roundRect(c, sx - w * 0.03, top, w * 0.06, bot - top, w * 0.03);
  c.fillStyle = '#050505';
  c.fill();
  const tgt = clamp(fin(r.flapsTargetDeg), 0, max);
  for (const n of notches) {
    const ny = top + ((bot - top) * n) / max;
    c.beginPath();
    c.moveTo(sx + w * 0.06, ny);
    c.lineTo(sx + w * 0.15, ny);
    c.strokeStyle = MARK;
    c.lineWidth = w * 0.015;
    c.stroke();
    placard(c, n === max ? 'FULL' : `${n}°`, sx + w * 0.2, ny, w * 0.085, 'left', Math.abs(n - tgt) < 0.01 ? '#8fd3ff' : '#d9d6cc');
  }
  const fy = top + ((bot - top) * clamp(fin(r.flapsDeg), 0, max)) / max;
  c.beginPath();
  c.moveTo(sx + w * 0.05, fy);
  c.lineTo(sx - w * 0.14, fy - w * 0.06);
  c.lineTo(sx - w * 0.14, fy + w * 0.06);
  c.closePath();
  c.fillStyle = MARK;
  c.fill();
}

/** Annunciator block: STALL, overspeed, brakes, engine. */
function annunciators(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: InstrumentReadings): void {
  roundRect(c, x, y, w, h, h * 0.08);
  c.fillStyle = '#121314';
  c.fill();
  const gw = gearFlags(r);
  const st = r.engineStatus;
  const items: [string, keyof typeof LAMP][] = [
    ['STALL', r.stallWarning ? 'red' : 'off'],
    ['GEAR', gw.gearUnsafe ? 'red' : gw.squatSwitch || gw.overspeed ? 'amber' : 'off'],
    ['VNE', r.overspeed ? 'red' : 'off'],
    ['BRAKE', r.brakes ? 'amber' : 'off'],
    ['PARK BRK', r.parkingBrake ? 'red' : 'off'],
    st === 'FAILED' ? ['ENG FAIL', 'red'] : st === 'STARTING' ? ['STARTER', 'amber'] : st === 'RUNNING' ? ['ENG RUN', 'green'] : ['ENG OFF', 'off'],
  ];
  const cols = 3;
  const pad = h * 0.08;
  const cw = (w - pad * (cols + 1)) / cols;
  const ch = (h - pad * 3) / 2;
  items.forEach(([label, kind], i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    pill(c, x + pad + col * (cw + pad), y + pad + row * (ch + pad), cw, ch, label, kind);
  });
}

/** Throttle and trim readouts under the annunciators. */
function panelSystems(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: InstrumentReadings): void {
  roundRect(c, x, y, w, h, h * 0.08);
  c.fillStyle = 'rgba(10,11,12,0.85)';
  c.fill();
  const half = w / 2;
  // Keep each cell at its design aspect so labels never collide; centre it vertically.
  const ch = Math.min(h, half / SYSTEM_CELLS.throttle.aspect);
  const cy = y + (h - ch) / 2;
  drawThrottle(c, x, cy, half, ch, r);
  drawTrim(c, x + half, cy, half, ch, r);
}

/**
 * Draw the whole 172RG instrument panel into a w×h canvas (the cockpit's
 * CanvasTexture): six-pack, tachometer, annunciators, throttle/trim, the gear
 * lever with its lights and the flap position indicator. Scales with w,h
 * (designed for 2:1, e.g. 2048×1024).
 */
export function drawPanel(ctx: CanvasRenderingContext2D, w: number, h: number, r: InstrumentReadings): void {
  const W = sz(w);
  const H = sz(h);
  if (!W || !H) return;
  ctx.save();
  cached(ctx, 'panelBg', 0, 0, W, H, panelBackground);
  const s = Math.min(H * 0.41, W * 0.2);
  const step = s * 1.1;
  const x0 = W * 0.03 + s * 0.55;
  const y0 = H * 0.075 + s * 0.55;
  const six: GaugeDrawer[][] = [
    [drawAirspeed, drawAttitude, drawAltimeter],
    [drawTurnCoordinator, drawHeading, drawVsi],
  ];
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 3; col++) {
      const cx = x0 + col * step;
      const cy = y0 + row * step;
      cached(ctx, 'flange', cx - s * 0.56, cy - s * 0.56, s * 1.12, s * 1.12, (c, fw) => flange(c, fw / 2, fw / 2, s));
      six[row][col](ctx, cx, cy, s, r);
    }
  }
  // Column 4: annunciators + throttle/trim on top, the tach below.
  const c4x = x0 + 3 * step - s * 0.55;
  const c4w = s * 0.95;
  annunciators(ctx, c4x, y0 - s * 0.5, c4w, s * 0.42, r);
  panelSystems(ctx, c4x, y0 - s * 0.5 + s * 0.5, c4w, s * 0.36, r);
  const ts = s * 0.86;
  const tcx = c4x + c4w / 2;
  const tcy = y0 + step;
  cached(ctx, 'flangeT', tcx - ts * 0.56, tcy - ts * 0.56, ts * 1.12, ts * 1.12, (c, fw) => flange(c, fw / 2, fw / 2, ts));
  drawTachometer(ctx, tcx, tcy, ts, r);
  // Column 5: gear lever and lights, flap indicator.
  const c5x = c4x + c4w + s * 0.1;
  const c5w = W - c5x - W * 0.02;
  if (c5w > s * 0.3) {
    gearPanel(ctx, c5x, y0 - s * 0.5, c5w, s * 1.02, r);
    flapPanel(ctx, c5x, y0 - s * 0.5 + s * 1.1, c5w, s * 0.98, r);
  }
  placard(ctx, `${CONFIG.aircraft.registration}`, W * 0.03, H * 0.965, H * 0.028, 'left', '#8d8a82');
  placard(ctx, 'CESSNA 172RG CUTLASS', x0 + step, H * 0.965, H * 0.022, 'center', '#6f6c66');
  ctx.restore();
}
