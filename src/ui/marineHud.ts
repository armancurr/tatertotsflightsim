/**
 * The marine helm HUD style ('marine': boats and ships, `config.aircraft.watercraft` set): a clean
 * chartplotter-style display drawn on canvases over the 3D view, fed by `readings.vessel`
 * (src/ui/instruments.ts). The heading is the shared compass tape top-centre (hud.ts).
 *
 *  - Nav block (bottom-left): the big speed through the water (kt, − astern) with the speed over the
 *    ground and the heading under it; the depth sounder (m under the keel, DEEP beyond its range,
 *    a flashing red SHALLOW box under SHALLOW_ALARM_M); running trim (a side profile) and heel (a
 *    hull section, P / S) glyphs, and the planing bar.
 *  - Engines block (bottom-right): one tachometer per engine (PORT / STBD: 0 … the tach's top,
 *    ×1000 rpm, the red arc from the rated rpm) with the digital rpm and the load bar; the helm
 *    lever (F / N / R with the gear the drive is in lit, the neutral detent band); the drive angle
 *    (a fan ±30°, P / S) and the trim tabs (% down).
 *  - Cockpit view: the helm's own dash is in view, so only a compact one-row strip docked
 *    bottom-left stays (speed · both rpm · gear + lever · depth).
 * Status flags (MOORED, AGROUND, SHALLOW WATER, ENGINES OFF) are the HUD's annunciators
 * (src/ui/messages.ts).
 *
 * `computeMarineHudLayout`, `tachAngle`, `tachRange`, `shallowAlarm`, `leverY`, `steerText` are
 * pure (tested); the painters never throw and never emit NaN whatever the readings hold, and the
 * view redraws a canvas only when a quantised value it shows has changed.
 */
import { CONFIG, type Config } from '../config';
import type { InstrumentReadings, MarineGear, VesselReadings } from '../types';
import type { HudMode, Rect } from './hud';

const DEG = Math.PI / 180;
const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "Helvetica Neue", Arial, sans-serif';
const NUM_FONT = '"SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif';
const fin = (x: number | undefined | null, fallback = 0): number => (typeof x === 'number' && Number.isFinite(x) ? x : fallback);
const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
const sz = (s: number): number => (Number.isFinite(s) && s > 0 ? Math.min(s, 1e5) : 0);
const wrap360 = (d: number): number => {
  const r = ((fin(d) % 360) + 360) % 360;
  return r >= 360 ? 0 : r;
};

/** Depth under the keel (m) below which the sounder's shallow-water alarm sounds. */
export const SHALLOW_ALARM_M = 2;
/** The drive-angle fan's range, ± deg. */
const DRIVE_SCALE_DEG = 30;

export const MARINE_COLORS = {
  text: '#eef4fb',
  dim: 'rgba(214,226,240,0.62)',
  faint: 'rgba(214,226,240,0.22)',
  label: '#6fd3ff',
  accent: '#39c6ff',
  ahead: '#4fe08a',
  neutral: '#e9eef5',
  astern: '#ffb347',
  red: '#ff4b4b',
  amber: '#ffb347',
  water: 'rgba(57,198,255,0.35)',
  track: 'rgba(255,255,255,0.10)',
};
const C = MARINE_COLORS;

// ─── Pure: layout, scales, alarms ────────────────────────────────────────────

export interface MarineHudLayout {
  /** Speed · depth · trim / heel block (bottom-left), or null in the cockpit view. */
  nav: Rect | null;
  /** Engines · lever · drives · tabs block (bottom-right), or the compact strip (cockpit view, bottom-left). */
  engines: Rect;
  /** Cockpit view: `engines` is the one-row compact strip. */
  compact: boolean;
}

/**
 * Pure layout for a viewport (CSS px). Outside: the nav block bottom-left and the engines block
 * bottom-right, both inside the bottom third, shrunk together when the viewport is too narrow for
 * both with a clear gap. Cockpit view: the compact strip bottom-left inside the left 36 %.
 */
export function computeMarineHudLayout(width: number, height: number, _cfg: Config = CONFIG, mode: HudMode = 'normal'): MarineHudLayout {
  const w = Number.isFinite(width) && width > 0 ? width : 1024;
  const h = Number.isFinite(height) && height > 0 ? height : 768;
  const margin = Math.round(clamp(w * 0.012, 10, 20));
  if (mode !== 'normal') {
    const ch = Math.round(clamp(h * 0.072, 44, 60));
    const cw = Math.max(0, Math.round(Math.min(ch * 6.4, w * 0.36 - margin)));
    return { nav: null, engines: { x: margin, y: Math.round(h - margin - ch), w: cw, h: ch }, compact: true };
  }
  const maxH = Math.floor(h / 3) - margin - 16;
  let bh = Math.max(60, Math.min(clamp(h * 0.23, 150, 216), maxH));
  let nw = bh * 1.62;
  let ew = bh * 2.7;
  const room = w - 2 * margin - Math.max(margin, w * 0.04);
  if (nw + ew > room) {
    const k = room / (nw + ew);
    bh *= k;
    nw *= k;
    ew *= k;
  }
  const BH = Math.floor(bh);
  const NW = Math.floor(nw);
  const EW = Math.floor(ew);
  return {
    nav: { x: margin, y: Math.round(h - margin - BH), w: NW, h: BH },
    engines: { x: Math.round(w - margin - EW), y: Math.round(h - margin - BH), w: EW, h: BH },
    compact: false,
  };
}

/** The tachometer's full scale for an engine rated at `ratedRpm`: the next 500 above rated + 14 % (3,500 → 4,000). */
export function tachRange(ratedRpm: number): { max: number; redline: number } {
  const redline = Math.max(500, fin(ratedRpm, 3500));
  return { max: Math.ceil((redline * 1.14) / 500) * 500, redline };
}

/** Canvas angle (rad) of `rpm` on a 270° tach dial: 0 at 7:30, full scale at 4:30, clockwise. */
export function tachAngle(rpm: number, max: number): number {
  const m = Math.max(1, fin(max, 4000));
  return (135 + (clamp(fin(rpm), 0, m * 1.02) / m) * 270) * DEG;
}

/** The sounder's shallow-water alarm: a bottom in range, less than SHALLOW_ALARM_M under the keel (not while moored). */
export function shallowAlarm(v: VesselReadings | undefined | null): boolean {
  if (!v || v.moored) return false;
  return v.depthM !== null && Number.isFinite(v.depthM) && v.depthM < SHALLOW_ALARM_M;
}

/** Height of the lever handle on a track from `top` (full ahead) to `bottom` (full astern). */
export function leverY(leverPct: number, top: number, bottom: number): number {
  const t = (clamp(fin(leverPct), -100, 100) + 100) / 200;
  return bottom + (top - bottom) * t;
}

/** "12° S" / "8° P" / "0°": a steering (or heel) angle with its side (+ = starboard). */
export function steerText(deg: number): string {
  const a = Math.round(clamp(fin(deg), -180, 180));
  if (a === 0) return '0°';
  return `${Math.abs(a)}° ${a > 0 ? 'S' : 'P'}`;
}

/** "24.6" (one decimal below 100), "−3.2" astern. */
export function speedText(kt: number): string {
  const v = clamp(fin(kt), -99.9, 99.9);
  const s = Math.abs(v).toFixed(1);
  return v < -0.049 ? `−${s}` : s;
}

const gearColor = (g: MarineGear): string => (g === 'ahead' ? C.ahead : g === 'astern' ? C.astern : C.neutral);
const gearLetter = (g: MarineGear): string => (g === 'ahead' ? 'F' : g === 'astern' ? 'R' : 'N');

/**
 * The vessel block of the readings with every number made finite, or a zeroed stand-in built from
 * the aircraft readings (never throws, never hands the painters a NaN).
 */
export function vesselOf(r: InstrumentReadings): VesselReadings {
  const v = r.vessel;
  if (v) {
    const arr = (a: unknown): number[] => (Array.isArray(a) ? a.slice(0, 4).map((x) => fin(x as number)) : []);
    const rpm = arr(v.rpm);
    return {
      speedKt: fin(v.speedKt), sogKt: fin(v.sogKt), rpm: rpm.length ? rpm : [0], loadPct: arr(v.loadPct), leverPct: fin(v.leverPct),
      gear: v.gear === 'ahead' || v.gear === 'astern' ? v.gear : 'neutral', steerDeg: fin(v.steerDeg), tabsPct: fin(v.tabsPct), trimDeg: fin(v.trimDeg),
      heelDeg: fin(v.heelDeg), depthM: typeof v.depthM === 'number' && Number.isFinite(v.depthM) ? v.depthM : null, planingPct: fin(v.planingPct),
      moored: v.moored === true, aground: v.aground === true,
    };
  }
  return {
    speedKt: fin(r.airspeedKt), sogKt: fin(r.groundSpeedKt), rpm: [fin(r.rpm)], loadPct: [0], leverPct: 0, gear: 'neutral', steerDeg: 0,
    tabsPct: 0, trimDeg: 0, heelDeg: fin(r.rollDeg), depthM: null, planingPct: 0, moored: false, aground: false,
  };
}

// ─── Painters ────────────────────────────────────────────────────────────────

type Ctx = CanvasRenderingContext2D;
let boundW = 0;
let boundH = 0;

function text(c: Ctx, s: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign = 'center', weight = 600, family = FONT): void {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < -1 || y < -1 || x > boundW + 1 || y > boundH + 1) return;
  c.font = `${weight} ${Math.round(clamp(size, 6, 200))}px ${family}`;
  c.textAlign = align;
  c.textBaseline = 'middle';
  c.fillStyle = color;
  c.fillText(s, x, y);
}

function line(c: Ctx, x0: number, y0: number, x1: number, y1: number, color: string, width: number): void {
  c.beginPath();
  c.moveTo(x0, y0);
  c.lineTo(x1, y1);
  c.strokeStyle = color;
  c.lineWidth = width;
  c.stroke();
}

function rrect(c: Ctx, x: number, y: number, w: number, h: number, r: number, fill: string | null, stroke: string | null = null, lw = 1): void {
  const W = Math.max(0, w);
  const H = Math.max(0, h);
  const R = clamp(r, 0, Math.min(W, H) / 2);
  c.beginPath();
  c.moveTo(x + R, y);
  c.lineTo(x + W - R, y);
  c.arcTo(x + W, y, x + W, y + R, R);
  c.lineTo(x + W, y + H - R);
  c.arcTo(x + W, y + H, x + W - R, y + H, R);
  c.lineTo(x + R, y + H);
  c.arcTo(x, y + H, x, y + H - R, R);
  c.lineTo(x, y + R);
  c.arcTo(x, y, x + R, y, R);
  c.closePath();
  if (fill) {
    c.fillStyle = fill;
    c.fill();
  }
  if (stroke) {
    c.strokeStyle = stroke;
    c.lineWidth = lw;
    c.stroke();
  }
}

/** A polygon (unit coordinates) scaled by s, rotated by `rot` rad about (x, y). */
function poly(c: Ctx, pts: readonly (readonly [number, number])[], x: number, y: number, s: number, rot: number): void {
  const cr = Math.cos(rot);
  const sr = Math.sin(rot);
  c.beginPath();
  pts.forEach(([px, py], i) => {
    const X = x + (px * cr - py * sr) * s;
    const Y = y + (px * sr + py * cr) * s;
    if (i === 0) c.moveTo(X, Y);
    else c.lineTo(X, Y);
  });
  c.closePath();
}

/** Side profile (bow to the right) and hull section (seen from astern), unit size. */
const PROFILE: readonly (readonly [number, number])[] = [[-1, 0.12], [-1, -0.14], [0.5, -0.14], [1.08, -0.04], [0.98, 0.12], [0.3, 0.12], [0.08, 0.34], [-0.52, 0.34], [-0.6, 0.12]];
const SECTION: readonly (readonly [number, number])[] = [[0, 0.4], [-0.78, 0.1], [-0.84, 0.1], [-0.9, -0.3], [-0.45, -0.3], [-0.4, -0.62], [0.4, -0.62], [0.45, -0.3], [0.9, -0.3], [0.84, 0.1], [0.78, 0.1]];

/** Label + value pair: a small cyan caps label above a value. */
function caption(c: Ctx, label: string, x: number, y: number, f: number, align: CanvasTextAlign = 'left'): void {
  text(c, label, x, y, f * 0.72, C.label, align, 700);
}

/**
 * The nav block on a w × h canvas (CSS px; the caller set the DPR transform and cleared): speed,
 * SOG / heading, depth sounder, trim, heel, planing. `blink` = the alarm's off phase.
 */
export function drawMarineNav(c: Ctx, w: number, h: number, r: InstrumentReadings, blink = false): void {
  const W = sz(w);
  const H = sz(h);
  if (W < 60 || H < 40) return;
  boundW = W;
  boundH = H;
  const v = vesselOf(r);
  const f = Math.max(8, Math.min(H * 0.085, W * 0.055));
  const pad = Math.max(6, H * 0.07);
  const lw = Math.max(1, f * 0.12);
  c.save();

  // ── Speed through the water ──
  const colW = W * 0.56;
  caption(c, 'SPEED · STW', pad, pad + f * 0.4, f);
  const big = Math.min(H * 0.33, colW * 0.3);
  const sp = speedText(v.speedKt);
  c.font = `700 ${Math.round(big)}px ${NUM_FONT}`;
  const spW = typeof c.measureText === 'function' ? fin(c.measureText(sp).width, big * 2) : big * 2;
  const sy = pad + f * 0.95 + big * 0.55;
  text(c, sp, pad, sy, big, v.speedKt < -0.05 ? C.astern : C.text, 'left', 700, NUM_FONT);
  text(c, 'kt', pad + Math.min(spW, colW - f * 2) + f * 0.35, sy + big * 0.2, f * 1.05, C.dim, 'left', 600);
  const subY = sy + big * 0.55 + f * 0.75;
  text(c, 'SOG', pad, subY, f * 0.72, C.label, 'left', 700);
  text(c, `${speedText(Math.abs(v.sogKt))} kt`, pad + f * 2.1, subY, f * 0.95, C.text, 'left', 600);
  text(c, 'HDG', pad + colW * 0.5, subY, f * 0.72, C.label, 'left', 700);
  text(c, `${String(Math.round(wrap360(r.headingDeg)) % 360).padStart(3, '0')}°`, pad + colW * 0.5 + f * 2.1, subY, f * 0.95, C.text, 'left', 600);

  // ── Depth sounder ──
  const dx = colW + pad * 0.5;
  const dw = W - dx - pad;
  const dTop = pad;
  const dH = subY + f * 0.6 - dTop;
  const shallow = shallowAlarm(v);
  const alarmOn = shallow && !blink;
  rrect(c, dx, dTop, dw, dH, f * 0.6, alarmOn ? 'rgba(255,60,60,0.82)' : 'rgba(255,255,255,0.05)', shallow ? C.red : C.faint, lw);
  caption(c, 'DEPTH', dx + f * 0.6, dTop + f * 0.75, f);
  const depth = v.depthM;
  const dcx = dx + dw / 2;
  if (depth === null || !Number.isFinite(depth)) {
    text(c, 'DEEP', dcx, dTop + dH * 0.55, Math.min(dH * 0.3, dw * 0.24), C.dim, 'center', 700, NUM_FONT);
    text(c, 'no bottom', dcx, dTop + dH - f * 0.75, f * 0.7, C.dim, 'center', 500);
  } else {
    const dv = depth < 10 ? depth.toFixed(1) : String(Math.round(depth));
    const dSize = Math.min(dH * 0.38, dw * 0.3);
    c.font = `700 ${Math.round(dSize)}px ${NUM_FONT}`;
    const tw = typeof c.measureText === 'function' ? fin(c.measureText(dv).width, dSize * 1.2) : dSize * 1.2;
    const x0 = dcx - (tw + f * 1.1) / 2;
    text(c, dv, x0, dTop + dH * 0.54, dSize, alarmOn ? '#ffffff' : shallow ? C.red : C.text, 'left', 700, NUM_FONT);
    text(c, 'm', x0 + tw + f * 0.25, dTop + dH * 0.54 + dSize * 0.18, f * 0.9, alarmOn ? '#ffffff' : C.dim, 'left', 600);
    text(c, shallow ? 'SHALLOW' : 'under keel', dcx, dTop + dH - f * 0.75, f * (shallow ? 0.78 : 0.7), alarmOn ? '#ffffff' : shallow ? C.red : C.dim, 'center', shallow ? 800 : 500);
  }

  // ── Trim · heel · planing ──
  const rowTop = dTop + dH + pad * 0.7;
  const rowH = H - pad - rowTop;
  if (rowH > f * 1.6) {
    line(c, pad, rowTop - pad * 0.35, W - pad, rowTop - pad * 0.35, C.faint, 1);
    const cellW = (W - 2 * pad) / 3;
    const labY = rowTop + f * 0.35;
    const valY = H - pad - f * 0.4;
    const gy = (labY + valY) / 2 + f * 0.05;
    const gs = Math.max(4, Math.min(cellW * 0.3, (valY - labY) * 0.5 - f * 0.3));
    // Trim: side profile, bow right, tilted (×2 so a few degrees read), waterline.
    {
      const x = pad + cellW * 0.5;
      caption(c, 'TRIM', x, labY, f, 'center');
      line(c, x - gs * 1.35, gy + gs * 0.12, x + gs * 1.35, gy + gs * 0.12, C.water, lw * 1.4);
      poly(c, PROFILE, x, gy, gs, -clamp(v.trimDeg * 2, -30, 30) * DEG);
      c.fillStyle = 'rgba(238,244,251,0.92)';
      c.fill();
      text(c, `${v.trimDeg >= 0 ? '+' : '−'}${Math.abs(v.trimDeg).toFixed(1)}°`, x, valY, f * 0.9, C.text, 'center', 700);
    }
    // Heel: hull section from astern, rotated (starboard down = clockwise), waterline.
    {
      const x = pad + cellW * 1.5;
      caption(c, 'HEEL', x, labY, f, 'center');
      const heel = clamp(fin(v.heelDeg), -180, 180);
      line(c, x - gs * 1.35, gy + gs * 0.05, x + gs * 1.35, gy + gs * 0.05, C.water, lw * 1.4);
      poly(c, SECTION, x, gy, gs * 0.95, clamp(heel, -90, 90) * DEG);
      c.fillStyle = 'rgba(238,244,251,0.92)';
      c.fill();
      text(c, steerText(heel), x, valY, f * 0.9, Math.abs(heel) > 20 ? C.amber : C.text, 'center', 700);
    }
    // Planing: how much of the weight rides on dynamic lift.
    {
      const x0 = pad + 2 * cellW + f * 0.4;
      const bw = cellW - f * 0.4;
      caption(c, 'PLANING', x0 + bw / 2, labY, f, 'center');
      const p = clamp(fin(v.planingPct), 0, 100);
      const bh = Math.max(4, f * 0.55);
      const by = gy - bh / 2;
      rrect(c, x0, by, bw, bh, bh / 2, C.track);
      if (p > 0.5) rrect(c, x0, by, Math.max(bh, (bw * p) / 100), bh, bh / 2, p >= 60 ? C.ahead : C.accent);
      text(c, `${Math.round(p)}%`, x0 + bw / 2, valY, f * 0.9, p >= 60 ? C.ahead : C.text, 'center', 700);
    }
  }
  c.restore();
}

/** One tachometer: 270° dial, ×1000 labels, red arc from the rated rpm, needle, digits, label, load. */
function drawTach(c: Ctx, cx: number, cy: number, R: number, rpm: number, load: number, label: string, rated: number, f: number, off: boolean): void {
  const { max, redline } = tachRange(rated);
  const lw = Math.max(1, R * 0.035);
  // Track and red arc.
  c.beginPath();
  c.arc(cx, cy, R, tachAngle(0, max), tachAngle(max, max));
  c.strokeStyle = C.track;
  c.lineWidth = R * 0.1;
  c.stroke();
  c.beginPath();
  c.arc(cx, cy, R, tachAngle(redline, max), tachAngle(max, max));
  c.strokeStyle = C.red;
  c.lineWidth = R * 0.1;
  c.stroke();
  // Value arc.
  const x = clamp(fin(rpm), 0, max);
  const over = x > redline + 1;
  if (x > 1) {
    c.beginPath();
    c.arc(cx, cy, R, tachAngle(0, max), tachAngle(x, max));
    c.strokeStyle = over ? C.red : C.accent;
    c.lineWidth = R * 0.1;
    c.stroke();
  }
  // Ticks every 250, labels every 1000.
  for (let t = 0; t <= max + 1; t += 250) {
    const a = tachAngle(t, max);
    const major = t % 1000 === 0;
    const half = t % 500 === 0;
    const r0 = R * (major ? 0.74 : half ? 0.79 : 0.83);
    line(c, cx + Math.cos(a) * r0, cy + Math.sin(a) * r0, cx + Math.cos(a) * R * 0.88, cy + Math.sin(a) * R * 0.88, t >= redline ? C.red : major ? C.text : C.dim, major ? lw * 1.4 : lw);
    if (major && R > 26) text(c, String(t / 1000), cx + Math.cos(a) * R * 0.6, cy + Math.sin(a) * R * 0.6, R * 0.19, C.dim, 'center', 600);
  }
  // Needle.
  const a = tachAngle(x, max);
  line(c, cx - Math.cos(a) * R * 0.1, cy - Math.sin(a) * R * 0.1, cx + Math.cos(a) * R * 0.86, cy + Math.sin(a) * R * 0.86, over ? C.red : '#ffffff', lw * 2);
  c.beginPath();
  c.arc(cx, cy, R * 0.07, 0, Math.PI * 2);
  c.fillStyle = '#ffffff';
  c.fill();
  // Digits and label.
  // The name above the hub, the digital rpm in the dial's open bottom.
  text(c, label, cx, cy - R * 0.3, Math.min(f * 0.78, R * 0.2), C.label, 'center', 800);
  text(c, off ? 'OFF' : String(Math.round(x / 10) * 10), cx, cy + R * 0.74, R * 0.3, off ? C.dim : over ? C.red : C.text, 'center', 700, NUM_FONT);
  // Load bar under the dial.
  const ld = clamp(fin(load), 0, 150);
  const bw = R * 1.3;
  const bh = Math.max(3, f * 0.36);
  const bx = cx - bw / 2;
  const by = cy + R + f * 0.75;
  rrect(c, bx, by, bw, bh, bh / 2, C.track);
  if (ld > 0.5) rrect(c, bx, by, Math.max(bh, (bw * Math.min(ld, 100)) / 100), bh, bh / 2, ld > 100 ? C.red : ld > 85 ? C.amber : C.accent);
  text(c, 'LOAD', bx - f * 0.3, by + bh / 2, f * 0.6, C.dim, 'right', 700);
  text(c, `${Math.round(ld)}%`, bx + bw + f * 0.3, by + bh / 2, f * 0.7, C.text, 'left', 700);
}

/** The helm lever: F / N / R scale, detent band, the handle at the lever position, the gear lit. */
function drawLever(c: Ctx, x: number, top: number, bottom: number, v: VesselReadings, f: number, detentPct: number): void {
  const tw = Math.max(5, f * 0.55);
  const lw = Math.max(1, f * 0.12);
  // Track: ahead half green-tinted, astern half amber-tinted, the neutral band white.
  const yN0 = leverY(detentPct, top, bottom);
  const yN1 = leverY(-detentPct, top, bottom);
  rrect(c, x - tw / 2, top, tw, bottom - top, tw / 2, C.track);
  rrect(c, x - tw / 2, top, tw, yN0 - top, tw / 2, 'rgba(79,224,138,0.22)');
  rrect(c, x - tw / 2, yN1, tw, bottom - yN1, tw / 2, 'rgba(255,179,71,0.22)');
  c.fillStyle = 'rgba(255,255,255,0.35)';
  c.fillRect(x - tw / 2, yN0, tw, Math.max(1, yN1 - yN0));
  // Letters left of the track; the gear the drive is in, lit.
  const lx = x - tw / 2 - f * 1.35;
  const letters: [MarineGear, number][] = [['ahead', top + f * 0.3], ['neutral', (top + bottom) / 2], ['astern', bottom - f * 0.3]];
  for (const [g, y] of letters) {
    const on = v.gear === g;
    if (on) rrect(c, lx - f * 0.55, y - f * 0.55, f * 1.1, f * 1.1, f * 0.25, gearColor(g));
    text(c, gearLetter(g), lx, y + 0.5, f * 0.85, on ? '#08121c' : C.dim, 'center', 800);
  }
  // Ticks right of the track every 25 %.
  for (let p = -100; p <= 100; p += 25) {
    const y = leverY(p, top, bottom);
    line(c, x + tw / 2 + 2, y, x + tw / 2 + (p % 50 === 0 ? f * 0.55 : f * 0.32), y, C.dim, lw);
  }
  // Handle.
  const hy = leverY(v.leverPct, top, bottom);
  const hw = tw * 2.6;
  const hh = Math.max(4, f * 0.5);
  rrect(c, x - hw / 2, hy - hh / 2, hw, hh, hh / 2, '#ffffff', 'rgba(0,0,0,0.5)', lw);
  line(c, x - hw / 2 + hh * 0.5, hy, x + hw / 2 - hh * 0.5, hy, gearColor(v.gear), Math.max(1.5, hh * 0.35));
}

/** Drive-angle fan (top view: bow up, + = starboard) with the pod line. */
function drawDrive(c: Ctx, cx: number, cy: number, r: number, steerDeg: number, f: number): void {
  const lw = Math.max(1, f * 0.12);
  const up = -90 * DEG;
  c.beginPath();
  c.moveTo(cx, cy);
  c.arc(cx, cy, r, up - DRIVE_SCALE_DEG * DEG, up + DRIVE_SCALE_DEG * DEG);
  c.closePath();
  c.fillStyle = 'rgba(57,198,255,0.08)';
  c.fill();
  c.beginPath();
  c.arc(cx, cy, r, up - DRIVE_SCALE_DEG * DEG, up + DRIVE_SCALE_DEG * DEG);
  c.strokeStyle = C.dim;
  c.lineWidth = lw;
  c.stroke();
  for (const d of [-30, -20, -10, 0, 10, 20, 30]) {
    const a = up + d * DEG;
    line(c, cx + Math.cos(a) * r * (d === 0 ? 0.78 : 0.86), cy + Math.sin(a) * r * (d === 0 ? 0.78 : 0.86), cx + Math.cos(a) * r, cy + Math.sin(a) * r, d === 0 ? C.text : C.dim, lw);
  }
  text(c, 'P', cx + Math.cos(up - 38 * DEG) * r * 1.02, cy + Math.sin(up - 38 * DEG) * r * 1.02, f * 0.62, C.red, 'center', 800);
  text(c, 'S', cx + Math.cos(up + 38 * DEG) * r * 1.02, cy + Math.sin(up + 38 * DEG) * r * 1.02, f * 0.62, C.ahead, 'center', 800);
  const s = clamp(fin(steerDeg), -DRIVE_SCALE_DEG - 5, DRIVE_SCALE_DEG + 5);
  const a = up + s * DEG;
  line(c, cx, cy, cx + Math.cos(a) * r * 0.95, cy + Math.sin(a) * r * 0.95, '#ffffff', lw * 2.4);
  c.beginPath();
  c.arc(cx, cy, Math.max(2, r * 0.09), 0, Math.PI * 2);
  c.fillStyle = C.accent;
  c.fill();
}

/**
 * The engines block (w × h canvas): PORT / STBD tachs with load, the lever, drive angle and trim
 * tabs. `ratedRpm` sets the red arc (the tach reads to the next 500 above rated + 14 %).
 */
export function drawMarineEngines(c: Ctx, w: number, h: number, r: InstrumentReadings, ratedRpm = 3500, detent = 0.08): void {
  const W = sz(w);
  const H = sz(h);
  if (W < 80 || H < 40) return;
  boundW = W;
  boundH = H;
  const v = vesselOf(r);
  const f = Math.max(8, Math.min(H * 0.08, W * 0.03));
  const pad = Math.max(6, H * 0.06);
  const off = r.engineStatus === 'OFF' || r.engineStatus === 'FAILED';
  c.save();
  // Columns: tach(s) · lever · drive + tabs.
  const leverW = W * 0.15;
  const sideW = W * 0.22;
  const tachW = W - leverW - sideW - 2 * pad;
  const n = Math.max(1, Math.min(4, v.rpm.length));
  const cellW = tachW / n;
  const R = Math.max(10, Math.min(cellW * 0.4, (H - 2 * pad - f * 1.6) * 0.47));
  const cy = pad + R * 1.05;
  const names = n === 2 ? ['PORT', 'STBD'] : n === 1 ? ['ENGINE'] : Array.from({ length: n }, (_, i) => `ENG ${i + 1}`);
  for (let i = 0; i < n; i++) drawTach(c, pad + cellW * (i + 0.5), cy, R, v.rpm[i] ?? 0, v.loadPct[i] ?? 0, names[i], ratedRpm, f, off);

  // Lever.
  const lx = pad + tachW + leverW * 0.62;
  line(c, pad + tachW + 1, pad, pad + tachW + 1, H - pad, C.faint, 1);
  text(c, 'LEVER', pad + tachW + leverW / 2, pad + f * 0.35, f * 0.72, C.label, 'center', 700);
  const lTop = pad + f * 1.5;
  const lBot = H - pad - f * 1.5;
  drawLever(c, lx, lTop, lBot, v, f, clamp(fin(detent) * 100, 0, 50));
  const lp = Math.round(clamp(fin(v.leverPct), -100, 100));
  text(c, `${lp > 0 ? '+' : lp < 0 ? '−' : ''}${Math.abs(lp)}%`, pad + tachW + leverW / 2, H - pad - f * 0.45, f * 0.85, gearColor(v.gear), 'center', 700);

  // Drive angle (top half) and trim tabs (bottom half).
  const sx = W - pad - sideW;
  line(c, sx - 1, pad, sx - 1, H - pad, C.faint, 1);
  const scx = sx + sideW / 2;
  text(c, 'DRIVES', sx + f * 0.5, pad + f * 0.35, f * 0.72, C.label, 'left', 700);
  text(c, steerText(v.steerDeg), W - pad, pad + f * 0.35, f * 0.85, C.text, 'right', 700);
  const dr = Math.min(sideW * 0.42, H * 0.3);
  drawDrive(c, scx, pad + f * 1.2 + dr, dr, v.steerDeg, f);
  const tTop = pad + f * 1.9 + dr + f * 0.4;
  text(c, 'TABS', sx + f * 0.5, tTop, f * 0.72, C.label, 'left', 700);
  const tabs = clamp(fin(v.tabsPct), 0, 100);
  text(c, `${Math.round(tabs)}%`, W - pad, tTop, f * 0.85, C.text, 'right', 700);
  // Two tab bars (port / starboard) filling downward, with UP / DN marks.
  const bTop = tTop + f * 0.8;
  const bBot = H - pad;
  const bw = Math.max(4, sideW * 0.12);
  if (bBot - bTop > 6) {
    for (const k of [-1, 1]) {
      const bx = scx + k * bw * 0.9 - bw / 2;
      rrect(c, bx, bTop, bw, bBot - bTop, bw * 0.3, C.track);
      if (tabs > 0.5) rrect(c, bx, bTop, bw, Math.max(bw * 0.6, ((bBot - bTop) * tabs) / 100), bw * 0.3, C.accent);
    }
    text(c, 'UP', scx - bw * 2.2, bTop + f * 0.3, f * 0.55, C.dim, 'right', 700);
    text(c, 'DN', scx - bw * 2.2, bBot - f * 0.3, f * 0.55, C.dim, 'right', 700);
  }
  c.restore();
}

/** The compact one-row strip for the cockpit view: speed · rpm × n · gear + lever · depth. */
export function drawMarineCompact(c: Ctx, w: number, h: number, r: InstrumentReadings, ratedRpm = 3500, blink = false): void {
  const W = sz(w);
  const H = sz(h);
  if (W < 80 || H < 20) return;
  boundW = W;
  boundH = H;
  const v = vesselOf(r);
  const f = Math.max(7, Math.min(H * 0.3, W * 0.045));
  const { redline } = tachRange(ratedRpm);
  c.save();
  const pad = Math.max(4, H * 0.1);
  const cells = [0.25, 0.34, 0.17, 0.24];
  const xs: number[] = [];
  let acc = 0;
  for (const k of cells) {
    xs.push(acc * W);
    acc += k;
  }
  for (let i = 1; i < cells.length; i++) line(c, xs[i], pad, xs[i], H - pad, C.faint, 1);
  const labelY = H * 0.25;
  const valY = H * 0.64;
  // Speed.
  text(c, 'STW kt', xs[0] + W * cells[0] * 0.5, labelY, f * 0.55, C.label, 'center', 700);
  text(c, speedText(v.speedKt), xs[0] + W * cells[0] * 0.5, valY, f * 1.15, v.speedKt < -0.05 ? C.astern : C.text, 'center', 700, NUM_FONT);
  // RPM bars.
  const n = Math.max(1, Math.min(4, v.rpm.length));
  const rw = W * cells[1];
  text(c, 'RPM', xs[1] + rw * 0.5, labelY, f * 0.55, C.label, 'center', 700);
  const off = r.engineStatus === 'OFF' || r.engineStatus === 'FAILED';
  for (let i = 0; i < n; i++) {
    const cw = rw / n;
    const x0 = xs[1] + cw * i + cw * 0.1;
    const rpm = clamp(fin(v.rpm[i]), 0, 9999);
    text(c, off ? 'OFF' : String(Math.round(rpm / 10) * 10), x0 + cw * 0.4, valY - f * 0.12, f * 0.8, rpm > redline + 1 ? C.red : off ? C.dim : C.text, 'center', 700, NUM_FONT);
    const bw = cw * 0.8;
    const bh = Math.max(2, f * 0.22);
    const by = H - pad - bh;
    rrect(c, x0, by, bw, bh, bh / 2, C.track);
    const t = clamp(rpm / Math.max(1, redline * 1.14), 0, 1);
    if (t > 0.01) rrect(c, x0, by, Math.max(bh, bw * t), bh, bh / 2, rpm > redline + 1 ? C.red : C.accent);
  }
  // Gear + lever.
  const gx = xs[2] + W * cells[2] * 0.5;
  const lp = Math.round(clamp(fin(v.leverPct), -100, 100));
  text(c, `${lp > 0 ? '+' : lp < 0 ? '−' : ''}${Math.abs(lp)}%`, gx, labelY, f * 0.55, C.label, 'center', 700);
  const bs = Math.min(H * 0.46, W * cells[2] * 0.5);
  rrect(c, gx - bs / 2, valY - bs / 2, bs, bs, bs * 0.22, gearColor(v.gear));
  text(c, gearLetter(v.gear), gx, valY + 0.5, bs * 0.7, '#08121c', 'center', 800);
  // Depth.
  const dx0 = xs[3];
  const dw = W * cells[3];
  const shallow = shallowAlarm(v);
  if (shallow && !blink) rrect(c, dx0 + 3, pad * 0.5, dw - 6, H - pad, f * 0.3, 'rgba(255,60,60,0.82)');
  text(c, shallow ? 'SHALLOW' : 'DEPTH m', dx0 + dw * 0.5, labelY, f * 0.55, shallow ? '#ffffff' : C.label, 'center', 700);
  const d = v.depthM;
  text(c, d === null || !Number.isFinite(d) ? 'DEEP' : d < 10 ? d.toFixed(1) : String(Math.round(d)), dx0 + dw * 0.5, valY, f * (d === null ? 0.8 : 1.15), shallow ? '#ffffff' : d === null ? C.dim : C.text, 'center', 700, NUM_FONT);
  c.restore();
}

// ─── The overlay view (DOM + canvases), used by hud.ts ───────────────────────

export interface MarineHudView {
  place(g: MarineHudLayout, dpr: number): void;
  /** Redraw what changed; `time` (s) drives the shallow-water alarm's flashing. */
  draw(r: InstrumentReadings, time: number): void;
  markDirty(): void;
  dispose(): void;
}

interface MSlot {
  wrap: HTMLElement;
  el: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D | null;
  w: number;
  h: number;
  dpr: number;
  key: Float64Array;
  next: Float64Array;
  dirty: boolean;
}

const FALLBACK: VesselReadings = {
  speedKt: 0, sogKt: 0, rpm: [], loadPct: [], leverPct: 0, gear: 'neutral', steerDeg: 0, tabsPct: 0, trimDeg: 0, heelDeg: 0, depthM: null, planingPct: 0, moored: false, aground: false,
};
const NAV_KEYS = 12;
const ENG_KEYS = 16;
/** Shallow-water alarm flash rate, Hz. */
const ALARM_HZ = 2;

export function createMarineHudView(doc: Document, parent: HTMLElement, cfg: Config = CONFIG): MarineHudView {
  const wc = cfg.aircraft.watercraft;
  const rated = fin(wc?.engine.maxRpm ?? cfg.aircraft.engine.maxRpm, 3500);
  const detent = fin(wc?.neutralDetent, 0.08);
  const slot = (name: string, cls: string, n: number): MSlot => {
    const wrap = doc.createElement('div');
    wrap.className = `fsh-glass ${cls}`;
    wrap.style.borderRadius = '14px';
    const el = doc.createElement('canvas');
    el.setAttribute('data-hud', name);
    wrap.appendChild(el);
    parent.appendChild(wrap);
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = el.getContext('2d');
    } catch {
      ctx = null;
    }
    return { wrap, el, ctx, w: 0, h: 0, dpr: 1, key: new Float64Array(n).fill(NaN), next: new Float64Array(n), dirty: true };
  };
  const nav = slot('marine-nav', 'fsh-marinenav', NAV_KEYS);
  const eng = slot('marine-engines', 'fsh-marineeng', ENG_KEYS);
  let compact = false;
  let disposed = false;

  const size = (s: MSlot, r: Rect | null, dpr: number) => {
    const on = !!r && r.w > 0 && r.h > 0;
    s.wrap.hidden = !on;
    if (!r || !on) return;
    const b = 1;
    s.wrap.style.left = `${r.x}px`;
    s.wrap.style.top = `${r.y}px`;
    s.wrap.style.width = `${r.w}px`;
    s.wrap.style.height = `${r.h}px`;
    s.w = Math.max(1, r.w - 2 * b);
    s.h = Math.max(1, r.h - 2 * b);
    s.dpr = dpr;
    s.el.style.left = '0px';
    s.el.style.top = '0px';
    s.el.style.width = `${s.w}px`;
    s.el.style.height = `${s.h}px`;
    s.el.width = Math.max(1, Math.round(s.w * dpr));
    s.el.height = Math.max(1, Math.round(s.h * dpr));
    s.dirty = true;
  };
  const changed = (s: MSlot): boolean => {
    let same = !s.dirty;
    for (let i = 0; i < s.next.length; i++) {
      if (s.key[i] !== s.next[i] && !(Number.isNaN(s.key[i]) && Number.isNaN(s.next[i]))) same = false;
      s.key[i] = s.next[i];
    }
    s.dirty = false;
    return !same;
  };
  const begin = (s: MSlot): CanvasRenderingContext2D | null => {
    const c = s.ctx;
    if (!c) return null;
    c.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
    c.clearRect(0, 0, s.w, s.h);
    return c;
  };
  const gearCode = (g: MarineGear) => (g === 'ahead' ? 1 : g === 'astern' ? 2 : 0);

  return {
    place(g, dpr) {
      compact = g.compact;
      size(nav, g.nav, dpr);
      size(eng, g.engines, dpr);
    },
    draw(r, time) {
      if (disposed) return;
      // Keys straight from the readings (no per-frame allocation); the painters sanitise on redraw.
      const v = r.vessel ?? FALLBACK;
      const shallow = shallowAlarm(v);
      const blink = shallow && Math.floor(fin(time) * ALARM_HZ * 2) % 2 === 1;
      const depthKey = typeof v.depthM === 'number' && Number.isFinite(v.depthM) ? Math.round(clamp(v.depthM, 0, 1000) * 10) : -1;
      if (!nav.wrap.hidden) {
        const k = nav.next;
        k[0] = Math.round(fin(v.speedKt) * 10);
        k[1] = Math.round(fin(v.sogKt) * 10);
        k[2] = Math.round(wrap360(r.headingDeg));
        k[3] = depthKey;
        k[4] = (shallow ? 1 : 0) + (blink ? 2 : 0);
        k[5] = Math.round(fin(v.trimDeg) * 10);
        k[6] = Math.round(fin(v.heelDeg));
        k[7] = Math.round(fin(v.planingPct));
        k[8] = v.moored ? 1 : 0;
        // Without a vessel block the painter falls back to the aircraft readings.
        k[9] = r.vessel ? 0 : Math.round(fin(r.airspeedKt) * 10);
        k[10] = r.vessel ? 0 : Math.round(fin(r.rollDeg));
        k[11] = r.vessel ? 0 : Math.round(fin(r.rpm) / 10);
        if (changed(nav)) {
          const c = begin(nav);
          if (c) drawMarineNav(c, nav.w, nav.h, r, blink);
        }
      }
      if (!eng.wrap.hidden) {
        const k = eng.next;
        k.fill(0);
        for (let i = 0; i < 4; i++) {
          k[i] = Math.round(fin(v.rpm?.[i]) / 10);
          k[4 + i] = Math.round(fin(v.loadPct?.[i]));
        }
        k[3] += 100000 * (v.rpm?.length ?? 0);
        k[8] = Math.round(fin(v.leverPct));
        k[9] = gearCode(v.gear);
        k[10] = Math.round(fin(v.steerDeg) * 2);
        k[11] = Math.round(fin(v.tabsPct));
        k[12] = ['RUNNING', 'STARTING', 'OFF', 'FAILED'].indexOf(r.engineStatus);
        k[13] = compact ? 1 : 0;
        k[14] = compact ? Math.round(fin(v.speedKt) * 10) : 0;
        k[15] = compact ? depthKey * 4 + (shallow ? 1 : 0) + (blink ? 2 : 0) : 0;
        if (changed(eng)) {
          const c = begin(eng);
          if (c) {
            if (compact) drawMarineCompact(c, eng.w, eng.h, r, rated, blink);
            else drawMarineEngines(c, eng.w, eng.h, r, rated, detent);
          }
        }
      }
    },
    markDirty() {
      nav.dirty = true;
      eng.dirty = true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      nav.wrap.remove();
      eng.wrap.remove();
    },
  };
}
