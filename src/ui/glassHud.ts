/**
 * The airliner "glass" HUD style (the 747, which has no head-up display): a mini Boeing PFD and a
 * mini EICAS drawn on canvases over the 3D view. (Not to be confused with src/ui/hudGlass.ts, the
 * jet HUD's combiner-glass projector.)
 *
 *  - PFD (bottom-left): the attitude display (blue sky / brown ground, white horizon, pitch scale
 *    every 2.5°/5°/10°, the fixed bank scale with the sky pointer and slip brick, the aircraft
 *    symbol and a flight-path marker), the speed tape (10-kt ticks, readout box, the green speed
 *    trend arrow, red/black barber poles at Vmo and the stall speed with the amber band, the
 *    green V1/VR bugs on the ground and REF in the air, the magenta target speed), the altitude
 *    tape (readout with the hundreds, baro STD / 29.92 IN), the Boeing VSI (0 · 1 · 2 · 6 ×1000
 *    fpm) with digits above 400 fpm, the radio altitude below 2,500 ft and the heading rose.
 *  - EICAS (bottom-right): four N1 dials (the sim flies one lumped engine: N1 from the core speed,
 *    each engine a hair apart) with the thrust-lever command arc, the vertical flap indicator with
 *    the flap-lever detent in magenta, gear DOWN / UP / in transit, and memos (SPEEDBRAKE EXT,
 *    PARK BRAKE SET, ENG START…).
 *  - Cockpit view: the flight deck shows the real displays, so only a compact one-row strip
 *    (N1 × 4, flaps, gear) stays, docked bottom-left (config hud.glass.cockpit: 'strip' | 'hidden').
 *
 * `computeGlassHudLayout`, `pfdGeometry`, `speedToY`, `glassVSpeeds`, `engineN1` are pure (tested);
 * the painters never throw and never emit NaN, whatever the readings hold. The view redraws a
 * canvas only when a quantised value it shows has changed (no per-frame allocations).
 */
import { CONFIG, type Config } from '../config';
import type { EngineStatus, InstrumentReadings } from '../types';
import type { HudMode, Rect } from './hud';

/** Readings plus the extras from instruments.ts (optional so plain readings work too). */
export type GlassReadings = InstrumentReadings & {
  flightPathDeg?: number;
  speedBrake?: boolean;
  betaDeg?: number;
  mach?: number;
};

const DEG = Math.PI / 180;
const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "Helvetica Neue", Arial, sans-serif';
const fin = (x: number | undefined, fallback = 0): number => (typeof x === 'number' && Number.isFinite(x) ? x : fallback);
const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
const sz = (s: number): number => (Number.isFinite(s) && s > 0 ? Math.min(s, 1e5) : 0);
const wrap360 = (d: number): number => {
  const r = ((fin(d) % 360) + 360) % 360;
  return r >= 360 ? 0 : r;
};
const wrap180 = (d: number): number => {
  const a = wrap360(d);
  return a > 180 ? a - 360 : a;
};
const pad3 = (n: number): string => String(Math.round(wrap360(n)) % 360).padStart(3, '0');

// ─── Pure: layout, speeds, engines ───────────────────────────────────────────

export interface GlassHudLayout {
  /** The mini PFD (bottom-left), or null in the cockpit view. */
  pfd: Rect | null;
  /** The EICAS block (bottom-right), or the compact strip (cockpit view, bottom-left); w = h = 0 when hidden. */
  systems: Rect;
  /** Cockpit view: `systems` is the one-row compact strip. */
  compact: boolean;
}

/**
 * Pure layout of the glass HUD for a viewport (CSS px). Outside: PFD bottom-left, EICAS bottom-right,
 * both inside the bottom third (so the centre third and the toasts' anchor stay clear), shrunk
 * together if the viewport is too narrow for both. Cockpit view: the compact strip bottom-left,
 * inside the left 34 %.
 */
export function computeGlassHudLayout(width: number, height: number, cfg: Config = CONFIG, mode: HudMode = 'normal'): GlassHudLayout {
  const w = Number.isFinite(width) && width > 0 ? width : 1024;
  const h = Number.isFinite(height) && height > 0 ? height : 768;
  const g = cfg.hud.glass;
  const margin = Math.round(clamp(w * 0.012, 10, 20));
  if (mode !== 'normal') {
    if (g.cockpit === 'hidden') return { pfd: null, systems: { x: margin, y: Math.round(h - margin), w: 0, h: 0 }, compact: true };
    const ch = Math.round(clamp(h * g.compactHeightFrac, g.compactMinH, g.compactMaxH));
    const cw = Math.max(0, Math.round(Math.min(ch * g.compactAspect, w * 0.34 - margin)));
    return { pfd: null, systems: { x: margin, y: Math.round(h - margin - ch), w: cw, h: ch }, compact: true };
  }
  const maxH = Math.floor(h / 3) - margin - 16;
  let ph = Math.max(40, Math.min(clamp(h * g.pfdHeightFrac, g.pfdMinH, g.pfdMaxH), maxH));
  let pw = ph * g.pfdAspect;
  let eh = ph * g.eicasHeightFrac;
  let ew = eh * g.eicasAspect;
  const room = w - 3 * margin;
  if (pw + ew > room) {
    const k = room / (pw + ew);
    ph *= k;
    pw *= k;
    eh *= k;
    ew *= k;
  }
  const PH = Math.floor(ph);
  const PW = Math.floor(pw);
  const EH = Math.floor(eh);
  const EW = Math.floor(ew);
  return {
    pfd: { x: margin, y: Math.round(h - margin - PH), w: PW, h: PH },
    systems: { x: Math.round(w - margin - EW), y: Math.round(h - margin - EH), w: EW, h: EH },
    compact: false,
  };
}

export interface GlassVSpeeds {
  v1: number;
  vr: number;
  vref: number;
}

/** Take-off and landing reference speeds (kt) from the aircraft config (hud.glass overrides win). */
export function glassVSpeeds(cfg: Config = CONFIG): GlassVSpeeds {
  const g = cfg.hud.glass;
  const lim = cfg.aircraft.limits;
  const vr = Math.round(g.vrKt ?? fin(lim.vrKt, 150));
  const vref = Math.round(g.vrefKt ?? g.vrefFactor * fin(lim.vsoKt, 110));
  return { v1: vr - Math.max(0, g.v1BelowVrKt), vr, vref };
}

/** Tiny fixed per-engine N1 spread (%, at full power): four real engines never read identical. */
const N1_SPREAD = [0.3, -0.2, 0.1, -0.35];

/**
 * N1 (%) of engine `engine` (0..3) from the core speed the sim reports (`readings.rpm`, % N2: idle
 * `engine.idleRpm` … full `engine.maxRpm`). N1 is linear in the core's √power above idle
 * (hud.glass n1IdlePct → n1MaxPct) and falls away below idle as the engine spins down.
 */
export function engineN1(rpm: number, status: EngineStatus, engine: number, cfg: Config = CONFIG): number {
  const e = cfg.aircraft.engine;
  const g = cfg.hud.glass;
  const idle = Math.max(1, fin(e.idleRpm, 60));
  const max = Math.max(idle + 1, fin(e.maxRpm, 100));
  const x = fin(rpm);
  if (!(x > 0)) return 0;
  let n1: number;
  if (x >= idle) {
    const s = clamp((x - idle) / (max - idle), 0, 1.05);
    const spread = status === 'RUNNING' ? (N1_SPREAD[engine] ?? 0) : 0;
    n1 = g.n1IdlePct + (g.n1MaxPct - g.n1IdlePct + spread) * s;
  } else n1 = g.n1IdlePct * Math.pow(x / idle, 1.5);
  return clamp(n1, 0, 110);
}

/** The N1 the thrust levers ask for (the steady-state N1 of this lever position), %. */
export function engineN1Command(throttlePct: number, cfg: Config = CONFIG): number {
  const e = cfg.aircraft.engine;
  const detent = clamp(fin(e.jet?.abDetent, 1), 0.05, 1);
  const core = clamp(fin(throttlePct) / 100 / detent, 0, 1);
  const idle = fin(e.idleRpm, 60);
  const max = fin(e.maxRpm, 100);
  return engineN1(idle + (max - idle) * Math.sqrt(core), 'OFF', -1, cfg);
}

// ─── Pure: PFD geometry ──────────────────────────────────────────────────────

export interface PfdGeometry {
  w: number;
  h: number;
  speed: Rect;
  adi: Rect;
  alt: Rect;
  vsi: Rect;
  /** The aircraft symbol (and the tapes' readout line). */
  centre: { x: number; y: number };
  /** Attitude px per degree of pitch. */
  ppd: number;
  pxPerKt: number;
  pxPerFt: number;
  /** Heading rose: centre (below the display) and radius. */
  rose: { x: number; y: number; r: number };
  font: number;
}

/** Where everything sits on a w × h PFD canvas. */
export function pfdGeometry(w: number, h: number, cfg: Config = CONFIG): PfdGeometry {
  const W = sz(w);
  const H = sz(h);
  const top = H * 0.1;
  const th = H * 0.64;
  const speed = { x: W * 0.025, y: top, w: W * 0.16, h: th };
  // (The gap between the speed tape and the attitude display carries the V-speed bug labels.)
  const adi = { x: W * 0.25, y: top, w: W * 0.435, h: th };
  const alt = { x: W * 0.72, y: top, w: W * 0.165, h: th };
  const vsi = { x: W * 0.9, y: top + th * 0.06, w: W * 0.085, h: th * 0.88 };
  const centre = { x: adi.x + adi.w / 2, y: adi.y + adi.h / 2 };
  const r = W * 0.36;
  return {
    w: W,
    h: H,
    speed,
    adi,
    alt,
    vsi,
    centre,
    ppd: adi.h / Math.max(5, cfg.hud.glass.degPerAdiHeight),
    pxPerKt: th / 90,
    pxPerFt: th / 1000,
    rose: { x: centre.x, y: H * 0.835 + r, r },
    font: Math.max(7, Math.min(W * 0.048, H * 0.055)),
  };
}

/** Screen y of speed `kt` on the tape when the aircraft flies at `current` kt. */
export function speedToY(kt: number, current: number, g: PfdGeometry): number {
  return g.centre.y - (fin(kt) - clamp(fin(current), 0, 2000)) * g.pxPerKt;
}

/** Boeing VSI: 0 · 1 · 2 · 6 ×1000 fpm, compressed. Offset from the centre line, px (+ = up). */
export function vsiOffset(fpm: number, half: number): number {
  const v = Math.abs(fin(fpm));
  const s = v <= 1000 ? (0.42 * v) / 1000 : v <= 2000 ? 0.42 + (0.26 * (v - 1000)) / 1000 : 0.68 + 0.32 * Math.min(1, (v - 2000) / 4000);
  return Math.sign(fin(fpm)) * s * half;
}

// ─── Speed trend ─────────────────────────────────────────────────────────────

export interface GlassHudState {
  /** Speed predicted in 10 s minus the speed now, kt (smoothed). */
  trendKt: number;
  lastIas: number;
  init: boolean;
}

export function createGlassHudState(): GlassHudState {
  return { trendKt: 0, lastIas: 0, init: false };
}

/** Advance the speed trend (10-s prediction of the airspeed, low-passed). Pause/garbage dt holds it. */
export function trackGlassHud(s: GlassHudState, r: GlassReadings, dt: number): void {
  const ias = fin(r.airspeedKt, s.lastIas);
  const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.5) : 0;
  if (!s.init) {
    s.init = true;
    s.lastIas = ias;
    s.trendKt = 0;
    return;
  }
  if (step > 0) {
    const accel = (ias - s.lastIas) / step;
    const k = 1 - Math.exp(-step / 0.45);
    s.trendKt = clamp(fin(s.trendKt + (accel * 10 - s.trendKt) * k), -120, 120);
    s.lastIas = ias;
  }
  if (!Number.isFinite(s.trendKt)) s.trendKt = 0;
}

// ─── Painters ────────────────────────────────────────────────────────────────

type Ctx = CanvasRenderingContext2D;
let boundW = 0;
let boundH = 0;

/** Text, skipped if its anchor is off the canvas (never draws "NaN"). */
function text(c: Ctx, s: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign = 'center', weight = 600): void {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > boundW || y > boundH) return;
  c.font = `${weight} ${Math.round(clamp(size, 6, 200))}px ${FONT}`;
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

function box(c: Ctx, x: number, y: number, w: number, h: number, fill: string | null, stroke: string | null, lw = 1): void {
  c.beginPath();
  c.rect(x, y, w, h);
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

const onGroundState = (r: GlassReadings): boolean => r.state === 'ground' || r.state === 'landed';

/** Red/black barber pole along x..x+w between y0 and y1 (either order). */
function barber(c: Ctx, x: number, w: number, y0: number, y1: number, top: number, bottom: number, red: string): void {
  const a = clamp(Math.min(y0, y1), top, bottom);
  const b = clamp(Math.max(y0, y1), top, bottom);
  if (b - a < 1) return;
  box(c, x, a, w, b - a, '#000000', null);
  const seg = Math.max(3, w * 1.3);
  const phase = ((y0 % (2 * seg)) + 2 * seg) % (2 * seg);
  for (let y = a - phase; y < b; y += 2 * seg) {
    const s0 = Math.max(a, y);
    const s1 = Math.min(b, y + seg);
    if (s1 > s0) box(c, x, s0, w, s1 - s0, red, null);
  }
}

/** The mini PFD on a w × h canvas (CSS px; the caller sets the DPR transform and clears). */
export function drawGlassPfd(c: Ctx, w: number, h: number, r: GlassReadings, s: GlassHudState, cfg: Config = CONFIG): void {
  const W = sz(w);
  const H = sz(h);
  if (W < 60 || H < 50) return;
  boundW = W;
  boundH = H;
  const G = pfdGeometry(W, H, cfg);
  const col = cfg.hud.glass.colors;
  const lim = cfg.aircraft.limits;
  const f = G.font;
  const lw = Math.max(1, f * 0.12);
  const ias = clamp(fin(r.airspeedKt), 0, 2000);
  const alt = clamp(fin(r.altitudeFt), -5000, 99999);
  const pitch = clamp(fin(r.pitchDeg), -90, 90);
  let roll = wrap180(fin(r.rollDeg));
  if (roll === -180) roll = 180;
  const ground = onGroundState(r);
  c.save();

  // ── Attitude ──
  const A = G.adi;
  const cx = G.centre.x;
  const cy = G.centre.y;
  c.save();
  c.beginPath();
  c.rect(A.x, A.y, A.w, A.h);
  c.clip();
  const L = Math.max(A.w, A.h) * 2;
  c.translate(cx, cy);
  c.rotate(-roll * DEG);
  c.translate(0, pitch * G.ppd);
  c.fillStyle = col.sky;
  c.fillRect(-L, -L * 2, 2 * L, L * 2);
  c.fillStyle = col.ground;
  c.fillRect(-L, 0, 2 * L, L * 2);
  line(c, -L, 0, L, 0, col.white, lw * 1.2);
  // Pitch scale: 2.5° / 5° / 10° lines within the display, numbers on the 10° lines.
  const span = (A.h * 0.62) / G.ppd;
  const lo = Math.ceil((pitch - span) / 2.5);
  const hi = Math.floor((pitch + span) / 2.5);
  const rot = -roll * DEG;
  const cr = Math.cos(rot);
  const sr = Math.sin(rot);
  for (let k = lo; k <= hi; k++) {
    const d = k * 2.5;
    if (d === 0 || d < -90 || d > 90) continue;
    const y = -d * G.ppd;
    const ten = k % 4 === 0;
    const half = ten ? A.w * 0.18 : k % 2 === 0 ? A.w * 0.1 : A.w * 0.05;
    line(c, -half, y, half, y, col.white, lw);
    if (ten) {
      const lbl = String(Math.abs(d));
      // Place the numbers in device space (clipped by hand: nothing outside the display).
      for (const sx of [-1, 1]) {
        const lx = sx * (half + f * 0.8);
        const ly = y + pitch * G.ppd;
        const px = cx + lx * cr - ly * sr;
        const py = cy + lx * sr + ly * cr;
        if (px > A.x + f * 0.5 && px < A.x + A.w - f * 0.5 && py > A.y + f * 0.5 && py < A.y + A.h - f * 0.5) textRot(c, lbl, lx, y, f * 0.78, col.white);
      }
    }
  }
  c.restore();

  // Bank scale (fixed) and the sky pointer + slip brick (turning with the horizon).
  const R = A.h * 0.43;
  for (const b of [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60]) {
    const a = (b - 90) * DEG;
    const long = Math.abs(b) === 30 || Math.abs(b) === 60;
    const r0 = R;
    const r1 = R + (long ? f * 0.7 : f * 0.4);
    const x0 = cx + Math.cos(a) * r0;
    const y0 = cy + Math.sin(a) * r0;
    if (y0 < A.y + 1) continue;
    line(c, x0, y0, cx + Math.cos(a) * r1, Math.max(A.y + 1, cy + Math.sin(a) * r1), col.white, lw);
  }
  // Fixed zero index (triangle).
  c.beginPath();
  c.moveTo(cx, cy - R);
  c.lineTo(cx - f * 0.35, cy - R - f * 0.55);
  c.lineTo(cx + f * 0.35, cy - R - f * 0.55);
  c.closePath();
  c.strokeStyle = col.white;
  c.lineWidth = lw;
  c.stroke();
  {
    const a = -roll * DEG;
    const ux = Math.sin(a);
    const uy = -Math.cos(a);
    const px = cx + ux * (R - 1);
    const py = cy + uy * (R - 1);
    const nx = -uy;
    const ny = ux;
    const tw = f * 0.38;
    const th = f * 0.55;
    c.beginPath();
    c.moveTo(px, py);
    c.lineTo(px - ux * th + nx * tw, py - uy * th + ny * tw);
    c.lineTo(px - ux * th - nx * tw, py - uy * th - ny * tw);
    c.closePath();
    c.fillStyle = Math.abs(roll) > 35 ? col.amber : col.white;
    c.fill();
    // Slip/skid brick under the pointer.
    const slip = clamp(fin(r.slipSkid), -1, 1) * f * 0.9;
    const bx = px - ux * (th + f * 0.12) + nx * slip;
    const by = py - uy * (th + f * 0.12) + ny * slip;
    c.beginPath();
    c.moveTo(bx - nx * tw - ux * 0, by - ny * tw);
    c.lineTo(bx + nx * tw, by + ny * tw);
    c.lineTo(bx + nx * tw - ux * f * 0.22, by + ny * tw - uy * f * 0.22);
    c.lineTo(bx - nx * tw - ux * f * 0.22, by - ny * tw - uy * f * 0.22);
    c.closePath();
    c.fill();
  }

  // Flight-path marker (airborne, flying): the velocity vector below/beside the nose.
  const fpa = fin(r.flightPathDeg, pitch);
  if (!ground && ias > 60 && r.state !== 'crashed') {
    const dx = clamp(fin(r.betaDeg), -10, 10) * G.ppd;
    const dy = clamp(pitch - fpa, -15, 15) * G.ppd;
    const a = -roll * DEG;
    const fx = clamp(cx + dx * Math.cos(a) - dy * Math.sin(a), A.x + f, A.x + A.w - f);
    const fy = clamp(cy + dx * Math.sin(a) + dy * Math.cos(a), A.y + f, A.y + A.h - f);
    const rr = f * 0.36;
    c.beginPath();
    c.arc(fx, fy, rr, 0, Math.PI * 2);
    c.strokeStyle = col.white;
    c.lineWidth = lw * 1.1;
    c.stroke();
    line(c, fx - rr - f * 0.6, fy, fx - rr, fy, col.white, lw * 1.1);
    line(c, fx + rr, fy, fx + rr + f * 0.6, fy, col.white, lw * 1.1);
    line(c, fx, fy - rr, fx, fy - rr - f * 0.4, col.white, lw * 1.1);
  }

  // Aircraft symbol: two black L-wings outlined white and the centre square.
  const ws = A.w * 0.2;
  const wt = Math.max(2, f * 0.3);
  for (const sx of [-1, 1]) {
    const x0 = cx + sx * A.w * 0.1;
    const x1 = cx + sx * (A.w * 0.1 + ws);
    c.beginPath();
    c.moveTo(x1, cy - wt / 2);
    c.lineTo(x0, cy - wt / 2);
    c.lineTo(x0, cy + wt * 1.8);
    c.lineTo(x0 + sx * wt, cy + wt * 1.8);
    c.lineTo(x0 + sx * wt, cy + wt / 2);
    c.lineTo(x1, cy + wt / 2);
    c.closePath();
    c.fillStyle = '#000000';
    c.fill();
    c.strokeStyle = col.white;
    c.lineWidth = Math.max(1, lw * 0.8);
    c.stroke();
  }
  box(c, cx - wt * 0.55, cy - wt * 0.55, wt * 1.1, wt * 1.1, '#000000', col.white, Math.max(1, lw * 0.8));

  // Radio altitude (below 2,500 ft AGL), bottom centre of the attitude display.
  // (The readings' AGL is the CG's: the radio altimeter reads 0 with the wheels on the ground.)
  const agl = fin(r.altitudeAglFt, 99999) + Math.min(0, fin(cfg.aircraft.geometry.leftMainWheel.y)) * 3.28084;
  if (agl < 2500) {
    const ra = agl < 100 ? Math.round(Math.max(-20, agl) / 2) * 2 : Math.round(agl / 10) * 10;
    text(c, String(ra), cx, A.y + A.h - f * 0.75, f * 1.05, agl < 500 && !ground ? col.amber : col.white);
    text(c, 'RADIO', cx, A.y + A.h - f * 1.75, f * 0.62, col.white, 'center', 500);
  }

  // ── Speed tape ──
  const S = G.speed;
  c.save();
  c.beginPath();
  c.rect(S.x, S.y, S.w, S.h);
  c.clip();
  c.fillStyle = col.tape;
  c.fillRect(S.x, S.y, S.w, S.h);
  const kLo = Math.max(0, Math.floor((ias - 50) / 10) * 10);
  for (let kt = kLo; kt <= ias + 50; kt += 10) {
    if (kt < 30) continue;
    const y = speedToY(kt, ias, G);
    line(c, S.x + S.w - f * 0.5, y, S.x + S.w, y, col.white, lw);
    if (kt % 20 === 0) text(c, String(kt), S.x + S.w - f * 0.75, y, f * 0.85, col.white, 'right');
  }
  // Barber poles: Vmo above; the stall speed below (airborne), with the amber manoeuvre band.
  const pw = Math.max(3, f * 0.35);
  const px = S.x + S.w - pw;
  const vmo = fin(lim.vneKt, 400);
  barber(c, px, pw, speedToY(vmo, ias, G), S.y - 10, S.y, S.y + S.h, col.red);
  if (!ground) {
    const vs = fin(r.flapsDeg) > 1 ? fin(lim.vsoKt, 100) : fin(lim.vs1Kt, 120);
    barber(c, px, pw, speedToY(vs, ias, G), S.y + S.h + 10, S.y, S.y + S.h, col.red);
    const a0 = speedToY(vs, ias, G);
    const a1 = speedToY(vs * 1.2, ias, G);
    if (a1 < S.y + S.h && a0 > S.y) line(c, px + pw / 2, clamp(a0, S.y, S.y + S.h), px + pw / 2, clamp(a1, S.y, S.y + S.h), col.amber, pw * 0.5);
  }
  // V-speed bugs: V1 / VR on the ground, REF in the air (green, outside the tape's right edge).
  const V = glassVSpeeds(cfg);
  c.restore();
  const bug = (kt: number, label: string) => {
    const y = speedToY(kt, ias, G);
    if (y < S.y || y > S.y + S.h) return;
    line(c, S.x + S.w, y, S.x + S.w + f * 0.35, y, col.green, lw * 1.3);
    text(c, label, S.x + S.w + f * 0.42, y, f * 0.62, col.green, 'left', 700);
  };
  if (ground) {
    bug(V.v1, 'V1');
    bug(V.vr, 'VR');
  } else bug(V.vref, 'REF');
  // Magenta target speed: V2 + 10 on the ground, Vref + 5 configured for landing, 250 / 300 clean.
  const dirty = fin(r.flapsDeg) > 1 || r.gear !== 'up';
  const target = ground ? V.vr + 20 : dirty ? V.vref + 5 : alt < 10000 ? 250 : 300;
  {
    const y = clamp(speedToY(target, ias, G), S.y, S.y + S.h);
    c.beginPath();
    c.moveTo(S.x + S.w, y - f * 0.35);
    c.lineTo(S.x + S.w - f * 0.35, y);
    c.lineTo(S.x + S.w, y + f * 0.35);
    c.strokeStyle = col.magenta;
    c.lineWidth = lw * 1.3;
    c.stroke();
    text(c, String(target), S.x + S.w / 2, S.y - f * 0.62, f * 0.95, col.magenta);
  }
  // Speed trend arrow (green).
  const tr = clamp(fin(s.trendKt), -60, 60);
  if (Math.abs(tr) >= 2 && ias >= 30) {
    const x = S.x + S.w - f * 0.15;
    const y1 = clamp(speedToY(ias + tr, ias, G), S.y, S.y + S.h);
    line(c, x, cy, x, y1, col.green, lw * 1.2);
    const d = tr > 0 ? 1 : -1;
    c.beginPath();
    c.moveTo(x - f * 0.25, y1 + d * f * 0.35);
    c.lineTo(x, y1);
    c.lineTo(x + f * 0.25, y1 + d * f * 0.35);
    c.strokeStyle = col.green;
    c.stroke();
  }
  // Readout box with its pointer.
  {
    const bh = f * 1.5;
    const bx = S.x + 1;
    const bw = S.w - f * 0.55;
    c.beginPath();
    c.moveTo(bx, cy - bh / 2);
    c.lineTo(bx + bw, cy - bh / 2);
    c.lineTo(bx + bw, cy - f * 0.3);
    c.lineTo(bx + bw + f * 0.45, cy);
    c.lineTo(bx + bw, cy + f * 0.3);
    c.lineTo(bx + bw, cy + bh / 2);
    c.lineTo(bx, cy + bh / 2);
    c.closePath();
    c.fillStyle = '#000000';
    c.fill();
    c.strokeStyle = col.white;
    c.lineWidth = lw;
    c.stroke();
    const low = !ground && ias < fin(lim.vs1Kt, 0) * (fin(r.flapsDeg) > 1 ? 0.9 : 1.05);
    text(c, String(Math.round(ias < 30 ? 30 : ias)), bx + bw * 0.5, cy + 0.5, f * 1.12, low || fin(r.airspeedKt) > vmo ? col.amber : col.white, 'center', 700);
  }
  // Under the tape: Mach (above .40) or ground speed.
  const mach = fin(r.mach);
  if (mach >= 0.4) text(c, `.${String(Math.round(clamp(mach, 0, 0.999) * 1000)).padStart(3, '0')}`, S.x + S.w / 2, S.y + S.h + f * 0.8, f * 0.95, col.white);
  else text(c, `GS ${Math.round(clamp(fin(r.groundSpeedKt), 0, 999))}`, S.x + S.w / 2, S.y + S.h + f * 0.8, f * 0.78, col.white);

  // ── Altitude tape ──
  const T = G.alt;
  c.save();
  c.beginPath();
  c.rect(T.x, T.y, T.w, T.h);
  c.clip();
  c.fillStyle = col.tape;
  c.fillRect(T.x, T.y, T.w, T.h);
  const aLo = Math.floor((alt - 550) / 100) * 100;
  for (let a = aLo; a <= alt + 550; a += 100) {
    const y = cy - (a - alt) * G.pxPerFt;
    line(c, T.x, y, T.x + f * (a % 500 === 0 ? 0.55 : 0.35), y, col.white, lw);
    if (a % 200 === 0) text(c, String(a), T.x + T.w - f * 0.25, y, f * 0.78, col.white, 'right');
  }
  c.restore();
  {
    const bh = f * 1.55;
    const bx = T.x + f * 0.4;
    const bw = T.w - f * 0.4;
    c.beginPath();
    c.moveTo(bx - f * 0.4, cy);
    c.lineTo(bx, cy - f * 0.3);
    c.lineTo(bx, cy - bh / 2);
    c.lineTo(bx + bw, cy - bh / 2);
    c.lineTo(bx + bw, cy + bh / 2);
    c.lineTo(bx, cy + bh / 2);
    c.lineTo(bx, cy + f * 0.3);
    c.closePath();
    c.fillStyle = '#000000';
    c.fill();
    c.strokeStyle = col.white;
    c.lineWidth = lw;
    c.stroke();
    const a10 = Math.round(alt / 10) * 10;
    const neg = a10 < 0;
    const mag = Math.abs(a10);
    const th = Math.floor(mag / 1000);
    const rest = String(mag % 1000).padStart(3, '0');
    const split = bx + bw * 0.46;
    text(c, `${neg ? '-' : ''}${th > 0 ? th : ''}`, split, cy + 0.5, f * 1.15, col.white, 'right', 700);
    text(c, rest, split + 1, cy + 1, f * 0.9, col.white, 'left', 700);
  }
  // Baro setting under the tape; selected-altitude window above (no MCP: the altitude rounded).
  const std = alt >= 18000;
  text(c, std ? 'STD' : `${fin(cfg.hud.kollsmanInHg, 29.92).toFixed(2)} IN`, T.x + T.w / 2, T.y + T.h + f * 0.8, f * 0.8, std ? col.green : col.green);

  // ── VSI ──
  const Vs = G.vsi;
  const vcy = cy;
  const half = Vs.h / 2;
  c.beginPath();
  c.moveTo(Vs.x, Vs.y + half * 0.15);
  c.lineTo(Vs.x + Vs.w * 0.55, Vs.y);
  c.lineTo(Vs.x + Vs.w, Vs.y);
  c.lineTo(Vs.x + Vs.w, Vs.y + Vs.h);
  c.lineTo(Vs.x + Vs.w * 0.55, Vs.y + Vs.h);
  c.lineTo(Vs.x, Vs.y + Vs.h - half * 0.15);
  c.closePath();
  c.fillStyle = col.tape;
  c.fill();
  for (const v of [-6000, -2000, -1000, -500, 0, 500, 1000, 2000, 6000]) {
    const y = vcy - vsiOffset(v, half * 0.92);
    const major = v === 0 || Math.abs(v) === 1000 || Math.abs(v) === 2000 || Math.abs(v) === 6000;
    line(c, Vs.x + Vs.w * 0.08, y, Vs.x + Vs.w * (major ? 0.36 : 0.24), y, col.white, lw * (v === 0 ? 1.6 : 1));
    if (major && v !== 0) text(c, String(Math.abs(v) / 1000), Vs.x + Vs.w * 0.55, y, f * 0.62, col.white, 'center', 500);
  }
  const vs = clamp(fin(r.verticalSpeedFpm), -9999, 9999);
  {
    const y = vcy - vsiOffset(vs, half * 0.92);
    line(c, Vs.x + Vs.w * 1.15, vcy + (y - vcy) * 0.35, Vs.x + Vs.w * 0.1, y, col.white, lw * 1.4);
    if (Math.abs(vs) >= 400) {
      const v50 = Math.round(Math.abs(vs) / 50) * 50;
      text(c, String(v50), Vs.x + Vs.w * 0.5, vs > 0 ? Vs.y - f * 0.6 : Vs.y + Vs.h + f * 0.6, f * 0.72, col.white);
    }
  }

  // ── Heading rose ──
  const hdg = wrap360(fin(r.headingDeg));
  const Rr = G.rose;
  c.save();
  c.beginPath();
  c.rect(0, A.y + A.h + f * 1.6, W, H);
  c.clip();
  c.beginPath();
  c.arc(Rr.x, Rr.y, Rr.r, Math.PI, Math.PI * 2);
  c.closePath();
  c.fillStyle = col.tape;
  c.fill();
  for (let d = Math.floor((hdg - 50) / 5) * 5; d <= hdg + 50; d += 5) {
    const a = (d - hdg - 90) * DEG;
    const major = ((d % 10) + 10) % 10 === 0;
    const r0 = Rr.r - f * (major ? 0.55 : 0.32);
    line(c, Rr.x + Math.cos(a) * r0, Rr.y + Math.sin(a) * r0, Rr.x + Math.cos(a) * Rr.r, Rr.y + Math.sin(a) * Rr.r, col.white, lw);
    const dd = ((d % 360) + 360) % 360;
    if (dd % 30 === 0 && Math.abs(d - hdg) > 7) {
      const rl = Rr.r - f * 1.2;
      text(c, String(dd / 10), Rr.x + Math.cos(a) * rl, Rr.y + Math.sin(a) * rl, f * 0.75, col.white);
    }
  }
  c.restore();
  // Heading readout box (top of the rose) with the MAG label.
  {
    const bw = f * 2.3;
    const bh = f * 1.2;
    const by = Rr.y - Rr.r - bh * 0.55;
    box(c, Rr.x - bw / 2, by - bh / 2, bw, bh, '#000000', col.white, lw);
    text(c, pad3(hdg), Rr.x, by + 0.5, f * 0.95, col.white, 'center', 700);
    text(c, 'MAG', Rr.x + bw / 2 + f * 0.25, by, f * 0.62, col.green, 'left', 600);
    text(c, 'H', Rr.x - bw / 2 - f * 0.25, by, f * 0.62, col.green, 'right', 600);
  }
  c.restore();
}

/** Pitch-scale number drawn in the (already rotated) attitude frame, skipped by the caller when off-display. */
function textRot(c: Ctx, s: string, x: number, y: number, size: number, color: string): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  c.font = `600 ${Math.round(clamp(size, 6, 200))}px ${FONT}`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillStyle = color;
  c.fillText(s, x, y);
}

/** Boeing N1 dial: 0 at 9 o'clock → 110 % sweeping 210° clockwise. Canvas angle of a value. */
const n1Angle = (n1: number): number => (180 + (clamp(n1, 0, 110) / 110) * 210) * DEG;

/**
 * The EICAS block (w × h canvas): N1 × 4 dials, flaps, gear and memos — or, `compact`, the one-row
 * strip (N1 × 4 bars, flaps, gear) for the cockpit view.
 */
export function drawGlassEicas(c: Ctx, w: number, h: number, r: GlassReadings, cfg: Config = CONFIG, compact = false): void {
  const W = sz(w);
  const H = sz(h);
  if (W < 60 || H < 20) return;
  boundW = W;
  boundH = H;
  const col = cfg.hud.glass.colors;
  const status = r.engineStatus;
  const rpm = fin(r.rpm);
  const cmd = engineN1Command(fin(r.throttlePct), cfg);
  const running = status === 'RUNNING';
  c.save();
  if (compact) drawCompact(c, W, H, r, cfg, rpm, cmd);
  else {
    const f = Math.max(7, Math.min(H * 0.1, W * 0.05));
    const lw = Math.max(1, f * 0.13);
    // ── N1 dials: the digital readout box above each dial (right of centre), the arc below it ──
    const dialW = W * 0.78;
    const cell = dialW / 4;
    const bh = f * 1.2;
    const boxTop = Math.max(1, H * 0.04);
    const R = Math.max(4, Math.min(cell * 0.4, H * 0.3));
    const dy = boxTop + bh + f * 0.25 + R * 0.92;
    for (let i = 0; i < 4; i++) {
      const n1 = engineN1(rpm, status, i, cfg);
      const x = cell * (i + 0.5);
      // Filled sector to the value (Boeing's dim fill), the arc and the red line.
      c.beginPath();
      c.moveTo(x, dy);
      c.arc(x, dy, R, n1Angle(0), n1Angle(n1));
      c.closePath();
      c.fillStyle = 'rgba(200,205,212,0.3)';
      c.fill();
      c.beginPath();
      c.arc(x, dy, R, n1Angle(0), n1Angle(110));
      c.strokeStyle = col.white;
      c.lineWidth = lw;
      c.stroke();
      const redA = n1Angle(108);
      line(c, x + Math.cos(redA) * R * 0.8, dy + Math.sin(redA) * R * 0.8, x + Math.cos(redA) * R * 1.12, dy + Math.sin(redA) * R * 1.12, col.red, lw * 1.6);
      // Thrust-lever command: a thin arc outside the rim from the actual to the commanded N1, and its green tick.
      if (running && Math.abs(cmd - n1) > 1.5) {
        c.beginPath();
        c.arc(x, dy, R * 1.1, n1Angle(Math.min(n1, cmd)), n1Angle(Math.max(n1, cmd)));
        c.strokeStyle = col.white;
        c.lineWidth = lw * 0.9;
        c.stroke();
      }
      const ca = n1Angle(cmd);
      line(c, x + Math.cos(ca) * R * 1.02, dy + Math.sin(ca) * R * 1.02, x + Math.cos(ca) * R * 1.24, dy + Math.sin(ca) * R * 1.24, col.green, lw * 1.5);
      // Needle.
      const a = n1Angle(n1);
      line(c, x, dy, x + Math.cos(a) * R * 0.97, dy + Math.sin(a) * R * 0.97, n1 >= 108 ? col.red : col.white, lw * 1.6);
      // Digital readout.
      const bw = Math.min(cell * 0.86, f * 2.6);
      const bx = x - bw * 0.3;
      box(c, bx, boxTop, bw, bh, 'rgba(0,0,0,0.6)', col.white, Math.max(1, lw * 0.8));
      text(c, n1.toFixed(1), bx + bw / 2, boxTop + bh / 2 + 0.5, f * 0.92, n1 >= 108 ? col.red : col.white, 'center', 700);
    }
    text(c, 'N1', dialW / 2, dy + R * 0.55, f * 0.9, col.cyan, 'center', 700);

    // ── Gear ──
    const rowY = H * 0.8;
    const gearW = W * 0.2;
    const gearH = f * 1.45;
    const gx = W * 0.03;
    text(c, 'GEAR', gx, rowY - gearH * 0.95, f * 0.72, col.cyan, 'left', 700);
    drawGearBox(c, gx, rowY - gearH / 2, gearW, gearH, r, f, lw, col);

    // ── Memos ──
    const memos = memoList(r);
    let my = rowY - gearH * 0.95;
    for (let i = 0; i < memos.length && i < 3; i++) {
      text(c, memos[i].text, W * 0.28, my, f * 0.78, memos[i].amber ? col.amber : col.white, 'left', 700);
      my += f * 1.15;
    }

    // ── Flaps (vertical indicator) ──
    drawFlaps(c, W * 0.8, H * 0.06, W * 0.18, H * 0.9, r, cfg, f, lw, false);
  }
  c.restore();
}

interface Memo {
  text: string;
  amber: boolean;
}
const MEMOS: Memo[] = [
  { text: 'SPEEDBRAKE EXT', amber: true },
  { text: 'PARK BRAKE SET', amber: false },
  { text: 'ENGINE FAIL', amber: true },
  { text: 'ENG SHUTDOWN', amber: false },
  { text: 'ENG START', amber: false },
  { text: 'OVERSPEED', amber: true },
];
const memoBuf: Memo[] = [];
function memoList(r: GlassReadings): Memo[] {
  memoBuf.length = 0;
  if (r.overspeed) memoBuf.push(MEMOS[5]);
  if (r.engineStatus === 'FAILED') memoBuf.push(MEMOS[2]);
  if (r.speedBrake) memoBuf.push(MEMOS[0]);
  if (r.parkingBrake) memoBuf.push(MEMOS[1]);
  if (r.engineStatus === 'OFF') memoBuf.push(MEMOS[3]);
  if (r.engineStatus === 'STARTING') memoBuf.push(MEMOS[4]);
  return memoBuf;
}

type Colors = Config['hud']['glass']['colors'];

function drawGearBox(c: Ctx, x: number, y: number, w: number, h: number, r: GlassReadings, f: number, lw: number, col: Colors): void {
  if (r.gear === 'down') {
    box(c, x, y, w, h, 'rgba(0,0,0,0.55)', col.green, lw * 1.2);
    text(c, 'DOWN', x + w / 2, y + h / 2 + 0.5, f * 0.95, col.green, 'center', 800);
  } else if (r.gear === 'up') {
    box(c, x, y, w, h, 'rgba(0,0,0,0.55)', col.white, lw * 1.2);
    text(c, 'UP', x + w / 2, y + h / 2 + 0.5, f * 0.95, col.white, 'center', 800);
  } else {
    // In transit: the white cross-hatched box.
    box(c, x, y, w, h, 'rgba(0,0,0,0.55)', col.white, lw * 1.2);
    c.save();
    c.beginPath();
    c.rect(x, y, w, h);
    c.clip();
    c.beginPath();
    for (let k = -h; k < w; k += Math.max(4, h * 0.45)) {
      c.moveTo(x + k, y + h);
      c.lineTo(x + k + h, y);
      c.moveTo(x + k, y);
      c.lineTo(x + k + h, y + h);
    }
    c.strokeStyle = col.white;
    c.lineWidth = Math.max(1, lw * 0.7);
    c.stroke();
    c.restore();
  }
}

/** The flap position on the indicator (0 at UP → 1 at the last detent): detents equally spaced, like Boeing's. */
function flapFrac(deg: number, notches: readonly number[]): number {
  const n = notches.length;
  if (n < 2) return 0;
  const d = clamp(fin(deg), notches[0], notches[n - 1]);
  for (let i = 1; i < n; i++) {
    if (d <= notches[i]) {
      const span = notches[i] - notches[i - 1];
      return (i - 1 + (span > 0 ? (d - notches[i - 1]) / span : 1)) / (n - 1);
    }
  }
  return 1;
}

function drawFlaps(c: Ctx, x: number, y: number, w: number, h: number, r: GlassReadings, cfg: Config, f: number, lw: number, compact: boolean): void {
  const col = cfg.hud.glass.colors;
  const notches = cfg.aircraft.flaps.notchesDeg;
  const cmdDeg = fin(r.flapsTargetDeg);
  const cmdTxt = String(Math.round(clamp(cmdDeg, 0, 90)));
  if (compact) {
    text(c, 'FLAPS', x + w * 0.5, y + h * 0.24, f * 0.6, col.cyan, 'center', 700);
    text(c, cmdDeg <= 0.01 && fin(r.flapsDeg) < 0.5 ? 'UP' : cmdTxt, x + w * 0.5, y + h * 0.6, f * 0.95, col.magenta, 'center', 800);
    // A thin horizontal bar under it: the actual flaps.
    const bw = w * 0.8;
    const bx = x + w * 0.1;
    const by = y + h * 0.9;
    box(c, bx, by - 2, bw, 3, 'rgba(255,255,255,0.18)', null);
    box(c, bx, by - 2, bw * flapFrac(r.flapsDeg, notches), 3, col.white, null);
    return;
  }
  text(c, 'FLAPS', x + w * 0.5, y + f * 0.45, f * 0.72, col.cyan, 'center', 700);
  const top = y + f * 1.3;
  const bot = y + h - f * 0.4;
  const bx = x + w * 0.12;
  const bw = Math.max(4, w * 0.22);
  box(c, bx, top, bw, bot - top, 'rgba(0,0,0,0.45)', col.white, lw);
  const fy = top + (bot - top) * flapFrac(r.flapsDeg, notches);
  if (fy > top + 0.5) box(c, bx, top, bw, fy - top, 'rgba(255,255,255,0.85)', null);
  for (let i = 0; i < notches.length; i++) {
    const ny = top + ((bot - top) * i) / Math.max(1, notches.length - 1);
    line(c, bx + bw, ny, bx + bw + f * 0.3, ny, col.white, lw);
    text(c, i === 0 ? 'UP' : String(notches[i]), bx + bw + f * 0.4, ny, f * 0.6, col.white, 'left', 500);
  }
  // Flap lever position: magenta line across the gauge + the number.
  const cy = top + (bot - top) * flapFrac(cmdDeg, notches);
  line(c, bx - f * 0.25, cy, bx + bw + f * 0.15, cy, col.magenta, lw * 1.8);
  if (cmdDeg > 0.01) text(c, cmdTxt, bx - f * 0.35, cy, f * 0.85, col.magenta, 'right', 800);
}

function drawCompact(c: Ctx, W: number, H: number, r: GlassReadings, cfg: Config, rpm: number, cmd: number): void {
  const col = cfg.hud.glass.colors;
  const f = Math.max(7, Math.min(H * 0.3, W * 0.05));
  const lw = Math.max(1, f * 0.12);
  // Cells: N1 × 4 (≈ 60 %), FLAPS (≈ 18 %), GEAR (≈ 22 %).
  const n1W = W * 0.6;
  const cell = n1W / 4;
  const top = H * 0.2;
  const bot = H * 0.8;
  text(c, 'N1', n1W / 2, H * 0.11, f * 0.52, col.cyan, 'center', 700);
  for (let i = 0; i < 4; i++) {
    const n1 = engineN1(rpm, r.engineStatus, i, cfg);
    const x = cell * i + cell * 0.1;
    const bw = Math.max(3, cell * 0.1);
    box(c, x, top, bw, bot - top, 'rgba(0,0,0,0.45)', 'rgba(255,255,255,0.7)', Math.max(1, lw * 0.7));
    const fy = bot - ((bot - top) * clamp(n1, 0, 110)) / 110;
    box(c, x, fy, bw, bot - fy, n1 >= 108 ? col.red : col.white, null);
    const cy = bot - ((bot - top) * clamp(cmd, 0, 110)) / 110;
    line(c, x - 2, cy, x + bw + 2, cy, col.green, lw * 1.2);
    text(c, n1.toFixed(1), x + bw + cell * 0.06, H * 0.55, f * 0.8, n1 >= 108 ? col.red : col.white, 'left', 700);
  }
  drawFlaps(c, n1W, 0, W * 0.18, H, r, cfg, f, lw, true);
  const gx = W * 0.8;
  const gw = W * 0.18;
  const gh = Math.min(H * 0.46, f * 1.3);
  text(c, 'GEAR', gx + gw / 2, H * 0.24, f * 0.6, col.cyan, 'center', 700);
  drawGearBox(c, gx, H * 0.62 - gh / 2, gw, gh, r, f * 0.85, lw, col);
}

// ─── The overlay view (DOM + canvases), used by hud.ts ───────────────────────

export interface GlassHudView {
  /** Place/size the blocks for a layout (on resize and camera-mode changes). */
  place(g: GlassHudLayout, dpr: number): void;
  /** Advance the speed trend (every frame, visible or not). */
  track(r: GlassReadings, dt: number): void;
  /** Redraw what changed. */
  draw(r: GlassReadings): void;
  /** Force a full redraw next time (the HUD was shown again). */
  markDirty(): void;
  dispose(): void;
}

interface GSlot {
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

const PFD_KEYS = 20;
const EICAS_KEYS = 14;

export function createGlassHudView(doc: Document, parent: HTMLElement, cfg: Config = CONFIG): GlassHudView {
  const slot = (name: string, cls: string, n: number): GSlot => {
    const wrap = doc.createElement('div');
    wrap.className = `fsh-glass ${cls}`;
    wrap.style.borderRadius = '12px';
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
  const pfd = slot('glass-pfd', 'fsh-glasspfd', PFD_KEYS);
  const eicas = slot('glass-eicas', 'fsh-glasseicas', EICAS_KEYS);
  const state = createGlassHudState();
  let compact = false;
  let disposed = false;

  const size = (s: GSlot, r: Rect | null, dpr: number) => {
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
  /** true when the key changed (and stores it). */
  const changed = (s: GSlot): boolean => {
    let same = !s.dirty;
    for (let i = 0; i < s.next.length; i++) {
      if (s.key[i] !== s.next[i] && !(Number.isNaN(s.key[i]) && Number.isNaN(s.next[i]))) same = false;
      s.key[i] = s.next[i];
    }
    s.dirty = false;
    return !same;
  };
  const begin = (s: GSlot): CanvasRenderingContext2D | null => {
    const c = s.ctx;
    if (!c) return null;
    c.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
    c.clearRect(0, 0, s.w, s.h);
    return c;
  };
  const gearCode = (r: GlassReadings) => (r.gear === 'down' ? 0 : r.gear === 'up' ? 1 : 2);
  const stateCode = (r: GlassReadings) => ['ground', 'airborne', 'stalled', 'landed', 'crashed'].indexOf(r.state);
  const engCode = (r: GlassReadings) => ['RUNNING', 'STARTING', 'OFF', 'FAILED'].indexOf(r.engineStatus);

  return {
    place(g, dpr) {
      compact = g.compact;
      size(pfd, g.pfd, dpr);
      size(eicas, g.systems, dpr);
    },
    track(r, dt) {
      trackGlassHud(state, r, dt);
    },
    draw(r) {
      if (disposed) return;
      if (!pfd.wrap.hidden) {
        const v = pfd.next;
        v[0] = Math.round(fin(r.pitchDeg) * 10);
        v[1] = Math.round(fin(r.rollDeg) * 10);
        v[2] = Math.round(fin(r.airspeedKt) * 4);
        v[3] = Math.round(fin(r.altitudeFt));
        v[4] = Math.round(fin(r.headingDeg) * 5);
        v[5] = Math.round(fin(r.verticalSpeedFpm) / 10);
        v[6] = Math.round(Math.min(3000, fin(r.altitudeAglFt, 3000)));
        v[7] = Math.round(fin(r.flightPathDeg) * 10);
        v[8] = Math.round(fin(r.betaDeg) * 10);
        v[9] = Math.round(state.trendKt);
        v[10] = Math.round(fin(r.flapsDeg) * 2);
        v[11] = gearCode(r);
        v[12] = stateCode(r);
        v[13] = Math.round(fin(r.mach) * 1000);
        v[14] = Math.round(fin(r.slipSkid) * 40);
        v[15] = Math.round(fin(r.groundSpeedKt));
        v[16] = r.overspeed ? 1 : 0;
        v[17] = Math.round(fin(r.flapsTargetDeg));
        v[18] = 0;
        v[19] = 0;
        if (changed(pfd)) {
          const c = begin(pfd);
          if (c) drawGlassPfd(c, pfd.w, pfd.h, r, state, cfg);
        }
      }
      if (!eicas.wrap.hidden) {
        const v = eicas.next;
        v[0] = Math.round(fin(r.rpm) * 20);
        v[1] = Math.round(fin(r.throttlePct) * 2);
        v[2] = Math.round(fin(r.flapsDeg) * 4);
        v[3] = Math.round(fin(r.flapsTargetDeg));
        v[4] = gearCode(r);
        v[5] = r.speedBrake ? 1 : 0;
        v[6] = r.parkingBrake ? 1 : 0;
        v[7] = engCode(r);
        v[8] = r.overspeed ? 1 : 0;
        v[9] = compact ? 1 : 0;
        v[10] = 0;
        v[11] = 0;
        v[12] = 0;
        v[13] = 0;
        if (changed(eicas)) {
          const c = begin(eicas);
          if (c) drawGlassEicas(c, eicas.w, eicas.h, r, cfg, compact);
        }
      }
    },
    markDirty() {
      pfd.dirty = true;
      eicas.dirty = true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      pfd.wrap.remove();
      eicas.wrap.remove();
    },
  };
}
