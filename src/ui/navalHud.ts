/**
 * The naval fire-control display (ships with `weapons.naval`, the USS Iowa's main battery), in the
 * marine helm HUD's look (dark glass, rounded panels, the same colours and fonts — src/ui/marineHud.ts)
 * and clear of it (the helm blocks hold the bottom corners; this panel sits at the right edge
 * between the top bar and the engines block):
 *
 *   header      MAIN BATTERY · the gun · the aim (FREE AIM / the locked target's name)
 *   solution    range (km), true bearing, time of flight; OUT OF RANGE when beyond the guns' reach
 *   turrets     one card per turret (I, II, III): a train dial (bow up, the blind sector shaded, the
 *               ordered bearing ticked), train and elevation, a load bar per gun (full = loaded,
 *               filling = reloading), rounds left, and ON TARGET / TRAINING / NO BEARING
 *   footer      READY n/9 (or the next gun in s) · SHELLS n · SPLASH in s (the first shell's fall)
 *
 * Over the view (a full-viewport canvas): the aim marker on the sea, a bracket round a locked target,
 * a small diamond with a countdown where each shell in flight will fall, and the recent fall of
 * shot as fading rings (red where they hit).
 *
 * `computeNavalHudLayout`, `navalHudModel`, `turretStateText` are pure (tested); the painters never
 * throw and never emit NaN whatever the inputs hold.
 */
import { CONFIG, type Config } from '../config';
import { computeHudLayout, type HudMode, type Rect } from './hud';
import { MARINE_COLORS } from './marineHud';
import type { Battery } from '../combat/navalBattery';
import type { FireSolution } from '../combat/naval';
import type { NavalAim } from '../combat/navalHub';

const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "Helvetica Neue", Arial, sans-serif';
const NUM_FONT = '"SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif';
const C = MARINE_COLORS;
const fin = (x: number | undefined | null, d = 0): number => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

// ─── Layout ──────────────────────────────────────────────────────────────────

/**
 * The panel (CSS px): right edge, below the top bar / compass line, above the helm's engines block
 * (or the bottom margin in the cockpit view where the helm strip is bottom-left). Shrinks with the
 * viewport; never overlaps the marine blocks or the compass.
 */
export function computeNavalHudLayout(width: number, height: number, cfg: Config = CONFIG, mode: HudMode = 'normal'): Rect {
  const w = Number.isFinite(width) && width > 0 ? width : 1024;
  const h = Number.isFinite(height) && height > 0 ? height : 768;
  const L = computeHudLayout(w, h, cfg, mode, 'marine');
  const margin = L.margin;
  const top = L.compass.y + L.compass.h + Math.round(margin * 1.6);
  const bottomLimit = (L.marine && !L.marine.compact ? L.marine.engines.y : h - margin) - Math.round(margin * 0.8);
  let pw = Math.round(clamp(w * 0.2, 232, 318));
  // keep clear of the compass tape horizontally too (narrow windows)
  pw = Math.min(pw, w - margin - (L.compass.x + L.compass.w) - margin);
  const avail = Math.max(0, bottomLimit - top);
  let ph = Math.round(pw * 1.02);
  if (ph > avail) {
    ph = avail;
    pw = Math.min(pw, Math.round(ph / 0.9));
  }
  ph = Math.max(0, ph);
  pw = Math.max(0, pw);
  return { x: Math.round(w - margin - pw), y: Math.round(top), w: pw, h: ph };
}

// ─── The model (pure) ────────────────────────────────────────────────────────

export type TurretState = 'on' | 'armed' | 'training' | 'blind' | 'range' | 'stowed';

export interface TurretCard {
  name: string;
  trainDeg: number;
  elevDeg: number;
  /** The ordered train (deg), or null (stowed). */
  orderDeg: number | null;
  arcMin: number;
  arcMax: number;
  state: TurretState;
  /** Per gun: 1 = loaded, 0..1 = reloading progress, 0 = empty; flash 0..1. */
  load: number[];
  flash: number[];
  rounds: number;
}

export interface NavalHudModel {
  gunName: string;
  target: string | null;
  valid: boolean;
  rangeM: number;
  bearingDeg: number;
  tofS: number;
  tooFar: boolean;
  tooClose: boolean;
  turrets: TurretCard[];
  ready: number;
  guns: number;
  nextReadyS: number;
  shells: number;
  /** Seconds to the first shell's fall, or null. */
  splashS: number | null;
  message: string;
  messageLevel: 'info' | 'warn' | 'good';
  /** Rangefinder zoom (1 = off). */
  zoom: number;
}

export function turretStateText(s: TurretState): string {
  switch (s) {
    case 'on': return 'ON TARGET';
    case 'armed': return 'STANDBY';
    case 'training': return 'TRAINING';
    case 'blind': return 'NO BEARING';
    case 'range': return 'OUT OF RANGE';
    default: return 'STOWED';
  }
}

/** Builds the display model from the battery, the solutions and the aim (pure; tolerates garbage). */
export function navalHudModel(
  gunName: string, battery: Battery | null, solutions: readonly FireSolution[], aim: NavalAim | null,
  extra: { target?: string | null; shells?: number; splashS?: number | null; message?: string; messageLevel?: 'info' | 'warn' | 'good'; zoom?: number } = {},
): NavalHudModel {
  const turrets: TurretCard[] = [];
  let ready = 0;
  let guns = 0;
  let next = Infinity;
  if (battery) {
    battery.turrets.forEach((t, i) => {
      const s = solutions[i];
      const state: TurretState = !aim?.valid || t.orderTrain === null ? 'stowed' : !t.inArc ? 'blind' : s && (s.tooFar || s.tooClose) ? 'range' : t.onTarget ? 'on' : t.armedUntil >= 0 ? 'armed' : 'training';
      const load = t.guns.map((g) => (g.rounds <= 0 ? 0 : g.loaded ? 1 : clamp(1 - g.reloadLeft / Math.max(0.1, battery.cfg.reloadS), 0, 0.999)));
      for (const g of t.guns) {
        guns++;
        if (g.rounds > 0 && g.loaded) ready++;
        else if (g.rounds > 0) next = Math.min(next, g.reloadLeft);
      }
      turrets.push({
        name: t.cfg.name,
        trainDeg: fin(t.trainDeg),
        elevDeg: fin(t.elevDeg),
        orderDeg: t.orderTrain === null ? null : fin(t.orderTrain),
        arcMin: t.cfg.trainMinDeg,
        arcMax: t.cfg.trainMaxDeg,
        state,
        load,
        flash: t.guns.map((g) => clamp(fin(g.flash), 0, 1)),
        rounds: t.guns.reduce((a, g) => a + Math.max(0, g.rounds), 0),
      });
    });
  }
  return {
    gunName,
    target: extra.target ?? null,
    valid: !!aim?.valid,
    rangeM: fin(aim?.rangeM),
    bearingDeg: fin(aim?.bearingDeg),
    tofS: fin(aim?.tofS),
    tooFar: !!aim?.tooFar,
    tooClose: !!aim?.tooClose,
    turrets,
    ready,
    guns,
    nextReadyS: ready > 0 ? 0 : next,
    shells: Math.max(0, Math.round(fin(extra.shells))),
    splashS: extra.splashS === null || extra.splashS === undefined || !Number.isFinite(extra.splashS) ? null : Math.max(0, extra.splashS),
    message: extra.message ?? '',
    messageLevel: extra.messageLevel ?? 'info',
    zoom: Number.isFinite(extra.zoom) ? Math.max(1, extra.zoom as number) : 1,
  };
}

/** A key of what the panel shows, quantised (redraw only when it changes). */
export function navalHudKey(m: NavalHudModel, out: number[] = []): number[] {
  out.length = 0;
  out.push(m.valid ? 1 : 0, Math.round(m.rangeM / 50), Math.round(m.bearingDeg), Math.round(m.tofS), m.tooFar ? 1 : 0, m.tooClose ? 1 : 0, m.ready, Math.ceil(fin(m.nextReadyS, -1)), m.shells, m.splashS === null ? -1 : Math.ceil(m.splashS), m.message.length, m.target ? m.target.length : -1, Math.round(m.zoom));
  for (const t of m.turrets) {
    out.push(Math.round(t.trainDeg * 2), Math.round(t.elevDeg * 10), t.orderDeg === null ? 9999 : Math.round(t.orderDeg), ['on', 'armed', 'training', 'blind', 'range', 'stowed'].indexOf(t.state), t.rounds);
    for (const l of t.load) out.push(Math.round(l * 40));
    for (const f of t.flash) out.push(f > 0.05 ? 1 : 0);
  }
  return out;
}

// ─── Painters ────────────────────────────────────────────────────────────────

type Ctx = CanvasRenderingContext2D;

function text(c: Ctx, s: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign = 'left', weight = 600, family = FONT): void {
  if (!Number.isFinite(x + y + size)) return;
  c.font = `${weight} ${Math.round(clamp(size, 6, 120))}px ${family}`;
  c.textAlign = align;
  c.textBaseline = 'middle';
  c.fillStyle = color;
  c.fillText(s, x, y);
}

function rrect(c: Ctx, x: number, y: number, w: number, h: number, r: number, fill: string | null, stroke: string | null = null, lw = 1): void {
  const W = Math.max(0, fin(w));
  const H = Math.max(0, fin(h));
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

const STATE_COLOR: Record<TurretState, string> = { on: C.ahead, armed: C.accent, training: C.amber, blind: C.dim, range: C.red, stowed: C.dim };

/** A turret's train dial: bow up, the blind sector shaded, the barrels at the train, the order ticked. */
function dial(c: Ctx, cx: number, cy: number, r: number, t: TurretCard): void {
  const D = Math.PI / 180;
  const ang = (deg: number) => (deg - 90) * D; // canvas: 0 = +x; bow (0°) up
  c.beginPath();
  c.arc(cx, cy, r, 0, Math.PI * 2);
  c.fillStyle = 'rgba(255,255,255,0.05)';
  c.fill();
  c.strokeStyle = C.faint;
  c.lineWidth = 1;
  c.stroke();
  // blind sector (from arcMax round to arcMin + 360)
  c.beginPath();
  c.moveTo(cx, cy);
  c.arc(cx, cy, r, ang(t.arcMax), ang(t.arcMin + 360));
  c.closePath();
  c.fillStyle = 'rgba(255,75,75,0.16)';
  c.fill();
  // bow tick
  c.beginPath();
  c.moveTo(cx, cy - r);
  c.lineTo(cx, cy - r + Math.max(3, r * 0.22));
  c.strokeStyle = C.dim;
  c.lineWidth = 1.5;
  c.stroke();
  if (t.orderDeg !== null) {
    const a = ang(t.orderDeg);
    c.beginPath();
    c.moveTo(cx + Math.cos(a) * r * 0.78, cy + Math.sin(a) * r * 0.78);
    c.lineTo(cx + Math.cos(a) * r * 1.08, cy + Math.sin(a) * r * 1.08);
    c.strokeStyle = C.accent;
    c.lineWidth = 2;
    c.stroke();
  }
  const a = ang(t.trainDeg);
  c.beginPath();
  c.moveTo(cx, cy);
  c.lineTo(cx + Math.cos(a) * r * 0.9, cy + Math.sin(a) * r * 0.9);
  c.strokeStyle = STATE_COLOR[t.state] === C.dim ? C.text : STATE_COLOR[t.state];
  c.lineWidth = Math.max(2, r * 0.14);
  c.lineCap = 'round';
  c.stroke();
  c.lineCap = 'butt';
  c.beginPath();
  c.arc(cx, cy, Math.max(2, r * 0.22), 0, Math.PI * 2);
  c.fillStyle = C.text;
  c.fill();
}

const fmtKm = (m: number) => (m >= 10000 ? (m / 1000).toFixed(1) : (m / 1000).toFixed(2));
const pad3 = (d: number) => String(Math.round(((d % 360) + 360) % 360) % 360).padStart(3, '0');

/** The panel on a w × h canvas (CSS px; the caller set the DPR transform and cleared it). */
export function drawNavalPanel(c: Ctx, w: number, h: number, m: NavalHudModel, blink = false): void {
  const W = Math.max(1, fin(w, 1));
  const H = Math.max(1, fin(h, 1));
  const f = clamp(W / 300, 0.6, 1.4) * 14;
  const pad = Math.round(f * 0.8);
  // header
  text(c, 'MAIN BATTERY', pad, pad + f * 0.45, f * 0.78, C.label, 'left', 700);
  text(c, m.gunName, W - pad, pad + f * 0.45, f * 0.72, C.dim, 'right', 600);
  const aimTxt = m.target ? m.target.toUpperCase() : m.valid ? 'FREE AIM' : 'NO AIM';
  text(c, aimTxt, pad, pad + f * 1.55, f * 0.82, m.target ? C.ahead : C.text, 'left', 700);
  if (m.zoom > 1.5) text(c, `×${Math.round(m.zoom)}`, W - pad, pad + f * 1.55, f * 0.78, C.accent, 'right', 800);
  // solution line
  const y1 = pad + f * 3.0;
  const col = W / 3;
  const lab = (s: string, x: number) => text(c, s, x, y1, f * 0.62, C.label, 'left', 700);
  lab('RANGE', pad);
  lab('BRG', pad + col);
  lab('TOF', pad + col * 2);
  const vy = y1 + f * 1.05;
  const range = m.valid ? `${fmtKm(m.rangeM)} km` : '— km';
  text(c, range, pad, vy, f * 1.1, m.tooFar ? C.red : C.text, 'left', 700, NUM_FONT);
  text(c, m.valid ? `${pad3(m.bearingDeg)}°` : '—', pad + col, vy, f * 1.1, C.text, 'left', 700, NUM_FONT);
  text(c, m.valid && !m.tooFar && m.tofS > 0 ? `${m.tofS.toFixed(0)} s` : '—', pad + col * 2, vy, f * 1.1, C.text, 'left', 700, NUM_FONT);
  if (m.tooFar || m.tooClose) text(c, m.tooFar ? 'OUT OF RANGE' : 'TOO CLOSE', W - pad, y1, f * 0.62, C.red, 'right', 800);
  // turret cards
  const cardsTop = vy + f * 1.0;
  const n = Math.max(1, m.turrets.length);
  const gap = Math.round(f * 0.4);
  const cw = (W - 2 * pad - gap * (n - 1)) / n;
  const footerH = f * 3.4;
  const ch = Math.max(f * 4, H - cardsTop - pad - footerH);
  m.turrets.forEach((t, i) => {
    const x = pad + i * (cw + gap);
    const y = cardsTop;
    rrect(c, x, y, cw, ch, 8, 'rgba(255,255,255,0.045)', t.state === 'on' ? 'rgba(79,224,138,0.55)' : 'rgba(255,255,255,0.08)', 1);
    text(c, t.name, x + cw / 2, y + f * 0.7, f * 0.9, C.text, 'center', 800);
    const r = Math.min(cw * 0.3, ch * 0.18);
    dial(c, x + cw / 2, y + f * 1.35 + r, r, t);
    let yy = y + f * 1.7 + r * 2 + f * 0.55;
    text(c, `TRN ${pad3(t.trainDeg)}`, x + cw / 2, yy, f * 0.66, C.text, 'center', 600, NUM_FONT);
    yy += f * 0.95;
    text(c, `ELV ${t.elevDeg.toFixed(1)}`, x + cw / 2, yy, f * 0.66, C.text, 'center', 600, NUM_FONT);
    // load bars, one per gun
    yy += f * 0.85;
    const bw = (cw - f * 1.2) / Math.max(1, t.load.length);
    t.load.forEach((l, k) => {
      const bx = x + f * 0.6 + k * bw + 1.5;
      const bh = f * 0.55;
      rrect(c, bx, yy, bw - 3, bh, 2, C.track);
      const fill = l >= 1 ? C.ahead : C.amber;
      if (l > 0) rrect(c, bx, yy, (bw - 3) * clamp(l, 0, 1), bh, 2, t.flash[k] > 0.05 ? '#ffffff' : fill);
    });
    yy += f * 1.25;
    text(c, `${t.rounds} rds`, x + cw / 2, yy, f * 0.58, C.dim, 'center', 600, NUM_FONT);
    const st = turretStateText(t.state);
    const on = t.state === 'on';
    text(c, st, x + cw / 2, y + ch - f * 0.62, f * (st.length > 10 ? 0.5 : 0.58), on && blink ? '#ffffff' : STATE_COLOR[t.state], 'center', 800);
  });
  // footer
  const fy = H - pad - f * 0.7;
  const readyTxt = m.ready > 0 ? `READY ${m.ready}/${m.guns}` : Number.isFinite(m.nextReadyS) ? `LOADING ${Math.ceil(m.nextReadyS)} s` : 'EMPTY';
  text(c, readyTxt, pad, fy, f * 0.72, m.ready > 0 ? C.ahead : C.amber, 'left', 800);
  const sp = m.splashS !== null ? `SPLASH ${Math.ceil(m.splashS)} s` : m.shells > 0 ? `SHELLS ${m.shells}` : '';
  if (sp) text(c, sp, W - pad, fy, f * 0.72, m.splashS !== null && m.splashS < 3 && blink ? '#ffffff' : C.accent, 'right', 800);
  if (m.message) {
    const my = fy - f * 1.15;
    text(c, m.message, W / 2, my, f * 0.7, m.messageLevel === 'warn' ? C.amber : m.messageLevel === 'good' ? C.ahead : C.text, 'center', 800);
  }
}

// ─── Overlay (markers over the 3D view) ──────────────────────────────────────

export interface ScreenPoint {
  x: number;
  y: number;
  /** In front of the camera and inside the viewport (with a margin). */
  visible: boolean;
}

export interface NavalOverlay {
  aim: ScreenPoint | null;
  aimOk: boolean;
  /** Locked target bracket: centre and half size (px). */
  lock: (ScreenPoint & { r: number }) | null;
  /** Shells in flight: where they will fall and the seconds left. */
  splashes: (ScreenPoint & { s: number })[];
  /** Recent falls: age 0..1 (1 = gone), hit. */
  falls: (ScreenPoint & { age: number; hit: boolean })[];
}

export function drawNavalOverlay(c: Ctx, w: number, h: number, o: NavalOverlay): void {
  const f = clamp(Math.min(fin(w, 900), fin(h, 900)) / 900, 0.7, 1.5);
  const ok = (p: ScreenPoint) => p.visible && Number.isFinite(p.x + p.y);
  for (const p of o.falls) {
    if (!ok(p)) continue;
    const age = clamp(fin(p.age, 1), 0, 1);
    const a = 1 - age;
    c.beginPath();
    c.arc(p.x, p.y, (5 + 10 * age) * f, 0, Math.PI * 2);
    c.strokeStyle = p.hit ? `rgba(255,90,70,${(0.9 * a).toFixed(3)})` : `rgba(230,245,255,${(0.75 * a).toFixed(3)})`;
    c.lineWidth = 1.5;
    c.stroke();
  }
  for (const s of o.splashes) {
    if (!ok(s)) continue;
    const r = 5 * f;
    c.beginPath();
    c.moveTo(s.x, s.y - r);
    c.lineTo(s.x + r, s.y);
    c.lineTo(s.x, s.y + r);
    c.lineTo(s.x - r, s.y);
    c.closePath();
    c.strokeStyle = C.accent;
    c.lineWidth = 1.5;
    c.stroke();
  }
  // one countdown for the whole salvo (the first shell to fall), beside the group
  const first = o.splashes.filter((s) => ok(s) && Number.isFinite(s.s)).sort((a, b) => a.s - b.s)[0];
  if (first) text(c, `${Math.ceil(first.s)}`, first.x + 9 * f, first.y - 9 * f, 12 * f, C.accent, 'left', 800, NUM_FONT);
  if (o.lock && ok(o.lock)) {
    const { x, y } = o.lock;
    const r = clamp(fin(o.lock.r, 10), 10 * f, 60 * f);
    const k = r * 0.45;
    c.strokeStyle = C.ahead;
    c.lineWidth = 2;
    c.beginPath();
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      c.moveTo(x + sx * r, y + sy * (r - k));
      c.lineTo(x + sx * r, y + sy * r);
      c.lineTo(x + sx * (r - k), y + sy * r);
    }
    c.stroke();
  }
  if (o.aim && ok(o.aim)) {
    const { x, y } = o.aim;
    const r = 11 * f;
    const col = o.aimOk ? C.text : C.red;
    c.strokeStyle = 'rgba(0,0,0,0.45)';
    c.lineWidth = 3.5;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.stroke();
    c.strokeStyle = col;
    c.lineWidth = 1.6;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      c.moveTo(x + dx * r * 0.45, y + dy * r * 0.45);
      c.lineTo(x + dx * r * 1.6, y + dy * r * 1.6);
    }
    c.stroke();
  }
}
