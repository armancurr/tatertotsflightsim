/**
 * The 172RG panel texture: a physically laid-out face (PANEL_LAYOUT, real instrument sizes)
 * drawn with the HUD's own gauge drawers for the six-pack and the tachometer, plus the panel's
 * other faces — clock, suction, ammeter, two nav heads, manifold pressure/fuel flow, EGT, the
 * engine cluster, a GNS 430-style GPS/COM, NAV/COM, transponder and audio panel, rocker
 * switches, circuit breakers, glovebox, placards, the gear-handle and flap-lever slots and the
 * little flap position indicator.
 *
 * Everything static is painted once into an offscreen bitmap per canvas size; a redraw blits it
 * and draws only the needles. The drawer never throws and never feeds NaN to the canvas,
 * whatever the readings hold.
 */
import type { InstrumentReadings } from '../types';
import { GAUGES } from '../ui/gauges';
import { PANEL, PANEL_LAYOUT as L, type GaugeSpot, type RectSpot } from './panel';

const DEG = Math.PI / 180;
const FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';
const MONO = '"DIN Alternate", "Arial Narrow", "Helvetica Neue", Arial, sans-serif';
const INK = '#e9e6dc';
const INK_DIM = '#a6a39a';

const fin = (x: number, d = 0) => (Number.isFinite(x) ? x : d);
const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

/** Pixel mapping of the current draw (uniform scale; the face is centred if the canvas aspect differs). */
const M = { k: 1, ox: 0, oy: 0 };
function setMapping(w: number, h: number) {
  M.k = Math.min(w / PANEL.widthM, h / PANEL.heightM);
  M.ox = (w - PANEL.widthM * M.k) / 2;
  M.oy = (h - PANEL.heightM * M.k) / 2;
}
const X = (x: number) => M.ox + (x + PANEL.widthM / 2) * M.k;
const Y = (y: number) => M.oy + (PANEL.topY - y) * M.k;
const S = (m: number) => m * M.k;

// ─── Primitives ─────────────────────────────────────────────────────────────

function circle(c: CanvasRenderingContext2D, x: number, y: number, r: number) {
  c.beginPath();
  c.arc(x, y, Math.max(0, r), 0, Math.PI * 2);
}
function rrect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
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
function text(c: CanvasRenderingContext2D, s: string, x: number, y: number, px: number, color = INK, align: CanvasTextAlign = 'center', weight = 700, family = FONT) {
  c.font = `${weight} ${Math.max(1, px).toFixed(1)}px ${family}`;
  c.fillStyle = color;
  c.textAlign = align;
  c.textBaseline = 'middle';
  c.fillText(s, x, y);
}
function screw(c: CanvasRenderingContext2D, x: number, y: number, r: number) {
  const g = c.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
  g.addColorStop(0, '#8d9094');
  g.addColorStop(1, '#232426');
  circle(c, x, y, r);
  c.fillStyle = g;
  c.fill();
  c.beginPath();
  c.moveTo(x - r * 0.7, y - r * 0.15);
  c.lineTo(x + r * 0.7, y + r * 0.15);
  c.strokeStyle = '#121212';
  c.lineWidth = r * 0.3;
  c.stroke();
}
/** Recessed rectangle (a hole or a bezel seat): dark fill, shadow top-left, light bottom-right edge. */
function recess(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, fill = '#141517') {
  rrect(c, x, y, w, h, r);
  c.fillStyle = fill;
  c.fill();
  c.lineWidth = Math.max(1, S(0.0012));
  c.strokeStyle = 'rgba(0,0,0,0.7)';
  c.stroke();
  c.beginPath();
  c.moveTo(x + r, y + h + c.lineWidth);
  c.lineTo(x + w, y + h + c.lineWidth);
  c.lineTo(x + w + c.lineWidth, y + r);
  c.strokeStyle = 'rgba(255,255,255,0.09)';
  c.stroke();
}
/** Square gauge flange with four screws (the instrument hole seat). */
function flange(c: CanvasRenderingContext2D, g: GaugeSpot) {
  const cx = X(g.x);
  const cy = Y(g.y);
  const half = S(g.d) * 0.53;
  rrect(c, cx - half, cy - half, half * 2, half * 2, S(g.d) * 0.07);
  const gr = c.createLinearGradient(cx - half, cy - half, cx + half, cy + half);
  gr.addColorStop(0, '#34363a');
  gr.addColorStop(1, '#17181a');
  c.fillStyle = gr;
  c.fill();
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) screw(c, cx + sx * half * 0.84, cy + sy * half * 0.84, S(g.d) * 0.034);
}
/** Round dial: black face, bezel ring. Returns the face radius (px). */
function dial(c: CanvasRenderingContext2D, g: GaugeSpot): number {
  const cx = X(g.x);
  const cy = Y(g.y);
  const R = S(g.d) / 2;
  const b = c.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
  b.addColorStop(0, '#6f7277');
  b.addColorStop(0.4, '#2c2e31');
  b.addColorStop(1, '#060606');
  circle(c, cx, cy, R);
  c.fillStyle = b;
  c.fill();
  const F = R * 0.87;
  circle(c, cx, cy, F);
  c.fillStyle = '#121314';
  c.fill();
  return F;
}
function ticks(c: CanvasRenderingContext2D, cx: number, cy: number, r0: number, r1: number, a0: number, a1: number, n: number, width: number, color = INK) {
  c.strokeStyle = color;
  c.lineWidth = width;
  c.beginPath();
  for (let i = 0; i <= n; i++) {
    const a = (a0 + ((a1 - a0) * i) / n) * DEG;
    const s = Math.sin(a);
    const k = -Math.cos(a);
    c.moveTo(cx + s * r0, cy + k * r0);
    c.lineTo(cx + s * r1, cy + k * r1);
  }
  c.stroke();
}
function arcBand(c: CanvasRenderingContext2D, cx: number, cy: number, r: number, a0: number, a1: number, width: number, color: string) {
  c.beginPath();
  c.arc(cx, cy, r, (a0 - 90) * DEG, (a1 - 90) * DEG);
  c.strokeStyle = color;
  c.lineWidth = width;
  c.stroke();
}
/** Needle at `deg` clockwise from 12 o'clock. */
function needle(c: CanvasRenderingContext2D, cx: number, cy: number, deg: number, len: number, width: number, color = '#f3f1ea') {
  const a = fin(deg) * DEG;
  const s = Math.sin(a);
  const k = -Math.cos(a);
  c.beginPath();
  c.moveTo(cx - s * len * 0.18 - k * width, cy - k * len * 0.18 + s * width);
  c.lineTo(cx + s * len, cy + k * len);
  c.lineTo(cx - s * len * 0.18 + k * width, cy - k * len * 0.18 - s * width);
  c.closePath();
  c.fillStyle = color;
  c.fill();
  circle(c, cx, cy, width * 1.4);
  c.fillStyle = '#1b1b1b';
  c.fill();
}
/** Soft glare on a round cover glass. */
function glass(c: CanvasRenderingContext2D, g: GaugeSpot) {
  const cx = X(g.x);
  const cy = Y(g.y);
  const F = (S(g.d) / 2) * 0.87;
  const gr = c.createLinearGradient(cx - F, cy - F, cx + F * 0.3, cy + F * 0.3);
  gr.addColorStop(0, 'rgba(255,255,255,0.13)');
  gr.addColorStop(0.5, 'rgba(255,255,255,0.02)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  circle(c, cx, cy, F);
  c.fillStyle = gr;
  c.fill();
}

// ─── Static faces (painted into the background) ────────────────────────────

function clockFace(c: CanvasRenderingContext2D) {
  const g = L.clock;
  const F = dial(c, g);
  const cx = X(g.x);
  const cy = Y(g.y);
  ticks(c, cx, cy, F * 0.8, F * 0.95, 0, 330, 11, F * 0.06);
  ticks(c, cx, cy, F * 0.88, F * 0.95, 0, 354, 59, F * 0.025, INK_DIM);
  for (let h = 1; h <= 12; h++) text(c, String(h), cx + Math.sin(h * 30 * DEG) * F * 0.6, cy - Math.cos(h * 30 * DEG) * F * 0.6, F * 0.22, INK, 'center', 700, MONO);
  needle(c, cx, cy, 305, F * 0.5, F * 0.06);
  needle(c, cx, cy, 60, F * 0.78, F * 0.045);
  glass(c, g);
}
function smallGauge(c: CanvasRenderingContext2D, g: GaugeSpot, title: string, lo: string, hi: string, green: [number, number], deg: number) {
  const F = dial(c, g);
  const cx = X(g.x);
  const cy = Y(g.y);
  arcBand(c, cx, cy, F * 0.82, green[0], green[1], F * 0.1, '#2fbf57');
  ticks(c, cx, cy, F * 0.72, F * 0.9, -60, 60, 6, F * 0.05);
  text(c, lo, cx - F * 0.62, cy + F * 0.05, F * 0.2);
  text(c, hi, cx + F * 0.62, cy + F * 0.05, F * 0.2);
  text(c, title, cx, cy + F * 0.45, F * 0.17, INK_DIM);
  needle(c, cx, cy + F * 0.1, deg, F * 0.78, F * 0.05);
  glass(c, g);
}
/** VOR/LOC/GS nav head: rotating OBS card, CDI and glideslope needles, TO flag. */
function navHead(c: CanvasRenderingContext2D, g: GaugeSpot, obs: number, gs: boolean) {
  const F = dial(c, g);
  const cx = X(g.x);
  const cy = Y(g.y);
  for (let d = 0; d < 360; d += 5) {
    const a = (d - obs) * DEG;
    const big = d % 30 === 0;
    c.beginPath();
    c.moveTo(cx + Math.sin(a) * F * (big ? 0.78 : 0.84), cy - Math.cos(a) * F * (big ? 0.78 : 0.84));
    c.lineTo(cx + Math.sin(a) * F * 0.95, cy - Math.cos(a) * F * 0.95);
    c.strokeStyle = INK;
    c.lineWidth = F * (big ? 0.035 : 0.018);
    c.stroke();
    if (big) text(c, d === 0 ? 'N' : d === 90 ? 'E' : d === 180 ? 'S' : d === 270 ? 'W' : String(d / 10), cx + Math.sin(a) * F * 0.64, cy - Math.cos(a) * F * 0.64, F * 0.15);
  }
  // Lubber triangle, dots, CDI and GS needles.
  c.fillStyle = '#f39322';
  c.beginPath();
  c.moveTo(cx, cy - F * 0.97);
  c.lineTo(cx - F * 0.07, cy - F * 0.84);
  c.lineTo(cx + F * 0.07, cy - F * 0.84);
  c.fill();
  for (let i = -5; i <= 5; i++) {
    if (i === 0) continue;
    circle(c, cx + i * F * 0.1, cy, F * 0.025);
    c.fillStyle = INK;
    c.fill();
  }
  c.fillStyle = INK;
  c.fillRect(cx + F * 0.08 - F * 0.018, cy - F * 0.55, F * 0.036, F * 1.1);
  if (gs) c.fillRect(cx - F * 0.55, cy - F * 0.1 - F * 0.018, F * 1.1, F * 0.036);
  rrect(c, cx - F * 0.42, cy - F * 0.34, F * 0.22, F * 0.13, F * 0.02);
  c.fillStyle = '#e8e6de';
  c.fill();
  text(c, 'TO', cx - F * 0.31, cy - F * 0.275, F * 0.1, '#111');
  // OBS knob, lower left.
  circle(c, cx - F * 0.86, cy + F * 0.86, F * 0.2);
  c.fillStyle = '#0c0c0c';
  c.fill();
  text(c, 'OBS', cx - F * 0.86, cy + F * 0.86, F * 0.08, INK_DIM);
  glass(c, g);
}
/** A dual-needle combined gauge face (manifold pressure left scale, fuel flow right). */
function mpFace(c: CanvasRenderingContext2D) {
  const g = L.manifold;
  const F = dial(c, g);
  const cx = X(g.x);
  const cy = Y(g.y);
  // MP: 10–35 inHg over −140…+40°; FF: 0–19 gph on the right, −… shown as a short arc.
  arcBand(c, cx, cy, F * 0.84, mpDeg(15), mpDeg(25), F * 0.09, '#2fbf57');
  ticks(c, cx, cy, F * 0.74, F * 0.92, mpDeg(10), mpDeg(35), 25, F * 0.02);
  ticks(c, cx, cy, F * 0.68, F * 0.92, mpDeg(10), mpDeg(35), 5, F * 0.045);
  for (let v = 10; v <= 35; v += 5) text(c, String(v), cx + Math.sin(mpDeg(v) * DEG) * F * 0.52, cy - Math.cos(mpDeg(v) * DEG) * F * 0.52, F * 0.16, INK, 'center', 700, MONO);
  arcBand(c, cx, cy, F * 0.84, ffDeg(6), ffDeg(12), F * 0.09, '#2fbf57');
  ticks(c, cx, cy, F * 0.74, F * 0.92, ffDeg(0), ffDeg(18), 9, F * 0.03);
  text(c, 'MAN PRESS', cx - F * 0.1, cy + F * 0.32, F * 0.1, INK_DIM);
  text(c, 'IN HG', cx - F * 0.1, cy + F * 0.45, F * 0.09, INK_DIM);
  text(c, 'FUEL FLOW', cx + F * 0.35, cy - F * 0.08, F * 0.08, INK_DIM);
  text(c, 'GAL/HR', cx + F * 0.35, cy + F * 0.04, F * 0.08, INK_DIM);
}
const mpDeg = (inHg: number) => -140 + ((clamp(fin(inHg, 10), 10, 35) - 10) / 25) * 190;
const ffDeg = (gph: number) => 70 + (clamp(fin(gph), 0, 18) / 18) * 90;

function egtFace(c: CanvasRenderingContext2D) {
  const g = L.egt;
  const F = dial(c, g);
  const cx = X(g.x);
  const cy = Y(g.y);
  ticks(c, cx, cy, F * 0.72, F * 0.9, -60, 60, 10, F * 0.035);
  text(c, 'EGT', cx, cy + F * 0.42, F * 0.2, INK_DIM);
  circle(c, cx + F * 0.55, cy + F * 0.62, F * 0.12);
  c.fillStyle = '#0b0b0b';
  c.fill();
}
/** Engine cluster: five little dual-scale gauges (fuel L/R, oil temp, oil press, CHT). */
const CLUSTER = ['FUEL L', 'FUEL R', 'OIL T', 'OIL P', 'CHT'] as const;
function clusterRect(i: number): RectSpot {
  const r = L.engineCluster;
  const w = (r.w - 0.012 * 4) / 5;
  return { x: r.x + i * (w + 0.012), y: r.y, w, h: r.h };
}
function clusterFace(c: CanvasRenderingContext2D) {
  CLUSTER.forEach((label, i) => {
    const r = clusterRect(i);
    const x = X(r.x);
    const y = Y(r.y);
    const w = S(r.w);
    const h = S(r.h);
    recess(c, x - S(0.003), y - S(0.003), w + S(0.006), h + S(0.006), S(0.004), '#0f1011');
    rrect(c, x, y, w, h, S(0.003));
    c.fillStyle = '#121314';
    c.fill();
    // Arc scale along the top with a green band.
    const cx = x + w / 2;
    const cy = y + h * 1.05;
    const R = h * 0.82;
    arcBand(c, cx, cy, R, -45, 45, h * 0.06, 'rgba(242,239,230,0.85)');
    arcBand(c, cx, cy, R - h * 0.06, label.startsWith('FUEL') ? -30 : -15, label.startsWith('FUEL') ? 45 : 25, h * 0.07, '#2fbf57');
    if (!label.startsWith('FUEL')) arcBand(c, cx, cy, R - h * 0.06, 38, 45, h * 0.07, '#e2362b');
    text(c, label, cx, y + h * 0.78, h * 0.2, INK_DIM);
  });
}
/** Needles of the cluster: oil pressure follows the engine, the rest sit in the green. */
function clusterNeedles(c: CanvasRenderingContext2D, r: InstrumentReadings) {
  const running = r.engineStatus === 'RUNNING';
  const rpm = clamp(fin(r.rpm), 0, 3000);
  const vals = [25, 25, running ? 5 + rpm / 200 : -38, running ? 8 + rpm / 250 : -44, running ? -5 + rpm / 150 : -40];
  for (let i = 0; i < 5; i++) {
    const rc = clusterRect(i);
    const x = X(rc.x);
    const w = S(rc.w);
    const h = S(rc.h);
    needle(c, x + w / 2, Y(rc.y) + h * 1.05, clamp(vals[i], -45, 45), h * 0.85, h * 0.045);
  }
}

function avionics(c: CanvasRenderingContext2D) {
  // Stack rack: a recessed black frame.
  const st = L.stack;
  recess(c, X(st.x) - S(0.004), Y(st.y) - S(0.002), S(st.w) + S(0.008), S(st.h) + S(0.006), S(0.004), '#0a0a0b');
  const unit = (u: RectSpot, face = '#2a2c2f') => {
    const x = X(u.x);
    const y = Y(u.y);
    const w = S(u.w);
    const h = S(u.h);
    rrect(c, x, y, w, h, S(0.002));
    const g = c.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, face);
    g.addColorStop(1, '#1a1b1d');
    c.fillStyle = g;
    c.fill();
    c.strokeStyle = 'rgba(255,255,255,0.08)';
    c.lineWidth = Math.max(1, S(0.0008));
    c.stroke();
    return { x, y, w, h };
  };
  const knob = (x: number, y: number, r: number) => {
    circle(c, x, y, r);
    c.fillStyle = '#0d0d0e';
    c.fill();
    circle(c, x, y, r * 0.62);
    c.fillStyle = '#1f2022';
    c.fill();
  };
  const button = (x: number, y: number, w: number, h: number, label: string) => {
    rrect(c, x, y, w, h, h * 0.2);
    c.fillStyle = '#3b3d41';
    c.fill();
    text(c, label, x + w / 2, y + h / 2, h * 0.5, '#d8d6cf', 'center', 700);
  };
  // Audio panel: a row of push buttons and marker-beacon lights.
  {
    const u = unit(L.audio);
    const labels = ['COM1', 'COM2', 'BOTH', 'NAV1', 'NAV2', 'ADF', 'DME', 'MKR', 'SPKR'];
    const bw = u.w * 0.08;
    labels.forEach((t, i) => button(u.x + u.w * 0.03 + i * bw * 1.12, u.y + u.h * 0.25, bw, u.h * 0.5, t));
    ['#4a7bd8', '#d69a2a', '#e8e8e8'].forEach((col, i) => {
      circle(c, u.x + u.w * (0.86 + i * 0.045), u.y + u.h * 0.5, u.h * 0.16);
      c.fillStyle = col;
      c.globalAlpha = 0.45;
      c.fill();
      c.globalAlpha = 1;
    });
  }
  // GNS 430-style GPS/NAV/COM: knobs left and right, screen with frequencies and a moving map.
  {
    const u = unit(L.gps, '#2c2e31');
    text(c, 'GARMIN', u.x + u.w * 0.5, u.y + u.h * 0.07, u.h * 0.055, '#c9c7c0', 'center', 800);
    knob(u.x + u.w * 0.07, u.y + u.h * 0.2, u.h * 0.065);
    knob(u.x + u.w * 0.07, u.y + u.h * 0.8, u.h * 0.085);
    knob(u.x + u.w * 0.93, u.y + u.h * 0.8, u.h * 0.085);
    for (let i = 0; i < 3; i++) button(u.x + u.w * 0.02, u.y + u.h * (0.36 + i * 0.1), u.w * 0.1, u.h * 0.07, ['C/V', 'V/V', 'ENT'][i]);
    for (let i = 0; i < 4; i++) button(u.x + u.w * 0.88, u.y + u.h * (0.14 + i * 0.1), u.w * 0.1, u.h * 0.07, ['D→', 'MENU', 'CLR', 'ENT'][i]);
    ['CDI', 'OBS', 'MSG', 'FPL', 'PROC'].forEach((t, i) => button(u.x + u.w * (0.2 + i * 0.13), u.y + u.h * 0.88, u.w * 0.11, u.h * 0.075, t));
    // Screen.
    const sx = u.x + u.w * 0.155;
    const sy = u.y + u.h * 0.13;
    const sw = u.w * 0.69;
    const sh = u.h * 0.7;
    c.fillStyle = '#05070a';
    c.fillRect(sx - 2, sy - 2, sw + 4, sh + 4);
    c.fillStyle = '#0b1a2c';
    c.fillRect(sx, sy, sw, sh);
    // Left column: frequencies.
    const col = sw * 0.3;
    c.fillStyle = '#0a0f16';
    c.fillRect(sx, sy, col, sh);
    const fr = sh * 0.11;
    text(c, '118.300', sx + col * 0.5, sy + sh * 0.1, fr, '#5ef08a', 'center', 700, MONO);
    text(c, '121.500', sx + col * 0.5, sy + sh * 0.22, fr, '#e8e8e8', 'center', 700, MONO);
    text(c, '110.50', sx + col * 0.5, sy + sh * 0.4, fr, '#5ef08a', 'center', 700, MONO);
    text(c, '113.90', sx + col * 0.5, sy + sh * 0.52, fr, '#e8e8e8', 'center', 700, MONO);
    text(c, 'GS  112kt', sx + col * 0.5, sy + sh * 0.72, fr * 0.72, '#cfe0ff', 'center', 700, MONO);
    text(c, 'DTK 360°', sx + col * 0.5, sy + sh * 0.84, fr * 0.72, '#cfe0ff', 'center', 700, MONO);
    // Map: land, a lake, a course line in magenta, the airplane.
    const mx = sx + col;
    const mw = sw - col;
    c.save();
    c.beginPath();
    c.rect(mx, sy, mw, sh);
    c.clip();
    c.fillStyle = '#3b3326';
    c.fillRect(mx, sy, mw, sh);
    c.fillStyle = '#1d4f7a';
    c.beginPath();
    c.ellipse(mx + mw * 0.2, sy + sh * 0.25, mw * 0.18, sh * 0.12, 0.4, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = '#d8d8d8';
    c.lineWidth = Math.max(1, sh * 0.01);
    c.beginPath();
    c.arc(mx + mw * 0.5, sy + sh * 0.72, sh * 0.42, 0, Math.PI * 2);
    c.stroke();
    c.strokeStyle = '#ff38e0';
    c.lineWidth = Math.max(1, sh * 0.025);
    c.beginPath();
    c.moveTo(mx + mw * 0.5, sy + sh);
    c.lineTo(mx + mw * 0.55, sy);
    c.stroke();
    c.fillStyle = '#ffffff';
    c.beginPath();
    c.moveTo(mx + mw * 0.5, sy + sh * 0.64);
    c.lineTo(mx + mw * 0.47, sy + sh * 0.76);
    c.lineTo(mx + mw * 0.53, sy + sh * 0.76);
    c.fill();
    text(c, 'KAPT', mx + mw * 0.6, sy + sh * 0.15, sh * 0.07, '#9fd0ff', 'left');
    c.restore();
  }
  // NAV/COM with two orange digit windows.
  {
    const u = unit(L.navcom);
    for (const [fx, t] of [[0.08, '122.80  119.10'], [0.52, '110.00  117.00']] as const) {
      c.fillStyle = '#050505';
      c.fillRect(u.x + u.w * fx, u.y + u.h * 0.2, u.w * 0.36, u.h * 0.46);
      text(c, t, u.x + u.w * (fx + 0.18), u.y + u.h * 0.43, u.h * 0.3, '#ff8a2a', 'center', 700, MONO);
    }
    knob(u.x + u.w * 0.04, u.y + u.h * 0.8, u.h * 0.16);
    knob(u.x + u.w * 0.96, u.y + u.h * 0.8, u.h * 0.16);
  }
  // Transponder: code window, mode knob, reply light.
  {
    const u = unit(L.xpdr);
    text(c, 'TRANSPONDER', u.x + u.w * 0.2, u.y + u.h * 0.2, u.h * 0.14, '#bdbbb4');
    c.fillStyle = '#050505';
    c.fillRect(u.x + u.w * 0.36, u.y + u.h * 0.28, u.w * 0.3, u.h * 0.42);
    text(c, '1 2 0 0', u.x + u.w * 0.51, u.y + u.h * 0.5, u.h * 0.3, '#f0f0ea', 'center', 700, MONO);
    for (let i = 0; i < 4; i++) knob(u.x + u.w * (0.39 + i * 0.075), u.y + u.h * 0.86, u.h * 0.09);
    knob(u.x + u.w * 0.14, u.y + u.h * 0.6, u.h * 0.2);
    text(c, 'OFF SBY ON ALT', u.x + u.w * 0.14, u.y + u.h * 0.2 + u.h * 0.72, u.h * 0.1, '#bdbbb4');
    circle(c, u.x + u.w * 0.8, u.y + u.h * 0.45, u.h * 0.1);
    c.fillStyle = '#5a4a28';
    c.fill();
    text(c, 'IDT', u.x + u.w * 0.9, u.y + u.h * 0.45, u.h * 0.16, '#bdbbb4');
  }
}

/** Switch row, key, knob labels, gear/flap slots, breakers, glovebox, placards. */
function controlsArt(c: CanvasRenderingContext2D) {
  // Rocker switches: split master (red BAT/ALT), then black rockers with white tops.
  const sw = L.switches;
  const names = ['BAT', 'ALT', 'FUEL PUMP', 'BCN', 'LAND', 'TAXI', 'NAV', 'STROBE', 'PITOT HT'];
  const sp = sw.w / names.length;
  recess(c, X(sw.x) - S(0.003), Y(sw.y) - S(0.003), S(sw.w) + S(0.004), S(sw.h * 0.62), S(0.003), '#101112');
  names.forEach((t, i) => {
    const x = X(sw.x + i * sp + sp * 0.12);
    const y = Y(sw.y);
    const w = S(sp * 0.76);
    const h = S(sw.h * 0.52);
    rrect(c, x, y, w, h, S(0.002));
    c.fillStyle = i < 2 ? '#a51c1c' : '#1a1a1b';
    c.fill();
    c.fillStyle = i < 2 ? '#c8403a' : '#e8e6de';
    c.fillRect(x + w * 0.15, y + h * 0.12, w * 0.7, h * 0.22);
    text(c, t, x + w / 2, Y(sw.y - sw.h * 0.72), S(0.0042), INK_DIM);
  });
  text(c, 'MASTER', X(sw.x + sp), Y(sw.y - sw.h * 0.92), S(0.0045), INK_DIM);
  // Magneto key switch.
  const mg = L.magneto;
  circle(c, X(mg.x), Y(mg.y), S(mg.d / 2));
  c.fillStyle = '#1a1b1c';
  c.fill();
  (['OFF', 'R', 'L', 'BOTH', 'START'] as const).forEach((t, i) => {
    const a = (-70 + i * 35) * DEG;
    text(c, t, X(mg.x) + Math.sin(a) * S(mg.d * 0.78), Y(mg.y) - Math.cos(a) * S(mg.d * 0.78), S(0.0042), INK_DIM);
  });
  // Push-pull engine controls: labels under each hole.
  for (const [k, t] of [['throttle', 'THROTTLE'], ['prop', 'PROP'], ['mixture', 'MIXTURE']] as const) {
    const p = L[k];
    circle(c, X(p.x), Y(p.y), S(0.011));
    c.fillStyle = '#060606';
    c.fill();
    text(c, t, X(p.x), Y(p.y - 0.03), S(0.0055), INK_DIM);
  }
  text(c, 'PUSH', X(L.prop.x), Y(L.prop.y - 0.041), S(0.004), INK_DIM);
  // Gear handle slot and its labels; the lights' bezels (the lamps themselves are 3D).
  const gh = L.gearHandle;
  recess(c, X(gh.x) - S(0.006), Y(gh.top) - S(0.006), S(0.012), S(gh.top - gh.bottom) + S(0.012), S(0.006), '#050505');
  text(c, 'UP', X(gh.x) - S(0.016), Y(gh.top - 0.004), S(0.0055), INK_DIM);
  text(c, 'DOWN', X(gh.x) - S(0.02), Y(gh.bottom + 0.004), S(0.0055), INK_DIM);
  text(c, 'GEAR', X(gh.x), Y(gh.top + 0.012), S(0.0062), INK);
  for (const [p, t] of [[L.gearLightUp, 'GEAR UP'], [L.gearLightDown, 'GEAR DOWN']] as const) {
    circle(c, X(p.x), Y(p.y), S(0.0085));
    c.fillStyle = '#0b0b0b';
    c.fill();
    text(c, t, X(p.x) + S(0.013), Y(p.y), S(0.0042), INK_DIM, 'left');
  }
  // Flap lever slot with detents, and the flap position indicator scale.
  const fl = L.flapLever;
  recess(c, X(fl.x) - S(0.005), Y(fl.top) - S(0.005), S(0.01), S(fl.top - fl.bottom) + S(0.01), S(0.005), '#050505');
  text(c, 'FLAPS', X(fl.x), Y(fl.top + 0.01), S(0.0058), INK);
  const fi = L.flapIndicator;
  rrect(c, X(fi.x), Y(fi.y), S(fi.w), S(fi.h), S(0.002));
  c.fillStyle = '#101112';
  c.fill();
  (['0°', '10°', '20°', 'FULL'] as const).forEach((t, i) => {
    const y = Y(fi.y - 0.008 - (i / 3) * (fi.h - 0.016));
    c.fillStyle = INK;
    c.fillRect(X(fi.x) + S(0.001), y - 1, S(0.004), 2);
    text(c, t, X(fi.x) + S(0.0065), y, S(0.0038), INK, 'left');
  });
  // Yoke shaft holes.
  for (const p of L.yokeShafts) {
    circle(c, X(p.x), Y(p.y), S(0.028));
    c.fillStyle = '#0c0c0d';
    c.fill();
  }
  // Circuit breakers: two rows of push-to-reset buttons with labels.
  const br = L.breakers;
  const cb = ['MSTR', 'FLAP', 'GEAR', 'INST', 'LTS', 'PITOT', 'FUEL', 'RADIO', 'XPDR', 'GPS', 'AUDIO', 'NAV2', 'ADF', 'ALT FLD'];
  for (let i = 0; i < 14; i++) {
    const col = i % 7;
    const row = Math.floor(i / 7);
    const x = X(br.x + 0.012 + col * (br.w - 0.024) / 6);
    const y = Y(br.y - 0.016 - row * 0.03);
    circle(c, x, y, S(0.0062));
    c.fillStyle = '#d2d0c8';
    c.fill();
    circle(c, x, y, S(0.0042));
    c.fillStyle = '#0d0d0d';
    c.fill();
    text(c, cb[i], x, y + S(0.011), S(0.0035), INK_DIM);
  }
  // Glovebox door and latch.
  const gb = L.glovebox;
  rrect(c, X(gb.x), Y(gb.y), S(gb.w), S(gb.h), S(0.006));
  c.strokeStyle = 'rgba(0,0,0,0.75)';
  c.lineWidth = S(0.0015);
  c.stroke();
  rrect(c, X(gb.x + gb.w / 2 - 0.02), Y(gb.y - 0.008), S(0.04), S(0.012), S(0.003));
  c.fillStyle = '#8f9194';
  c.fill();
  // Upper right: hour meter, limitations placard, cabin heat/air knobs.
  const ru = L.rightUpper;
  rrect(c, X(ru.x + 0.01), Y(ru.y - 0.012), S(0.05), S(0.016), S(0.002));
  c.fillStyle = '#0a0a0a';
  c.fill();
  text(c, '0 3 4 1 7', X(ru.x + 0.035), Y(ru.y - 0.02), S(0.0085), '#f2f0ea', 'center', 700, MONO);
  text(c, 'HOURS', X(ru.x + 0.035), Y(ru.y - 0.034), S(0.0036), INK_DIM);
  rrect(c, X(ru.x + 0.012), Y(ru.y - 0.05), S(0.15), S(0.052), S(0.002));
  c.fillStyle = '#cfcbbf';
  c.fill();
  text(c, 'THIS AIRPLANE MUST BE OPERATED IN THE', X(ru.x + 0.087), Y(ru.y - 0.058), S(0.0038), '#222');
  text(c, 'NORMAL CATEGORY · NO ACROBATIC MANEUVERS', X(ru.x + 0.087), Y(ru.y - 0.066), S(0.0038), '#222');
  text(c, 'INCLUDING SPINS APPROVED', X(ru.x + 0.087), Y(ru.y - 0.074), S(0.0038), '#222');
  text(c, 'GEAR DOWN 140 KIAS · GEAR UP 140 KIAS', X(ru.x + 0.087), Y(ru.y - 0.084), S(0.0038), '#222');
  text(c, 'MAX GEAR EXTENDED 164 KIAS', X(ru.x + 0.087), Y(ru.y - 0.092), S(0.0038), '#222');
  for (const [i, t] of [[0, 'CABIN HT'], [1, 'CABIN AIR']] as const) {
    const x = X(ru.x + 0.045 + i * 0.08);
    const y = Y(ru.y - 0.13);
    circle(c, x, y, S(0.009));
    c.fillStyle = '#141414';
    c.fill();
    circle(c, x, y, S(0.0065));
    c.fillStyle = '#26272a';
    c.fill();
    text(c, t, x, y + S(0.016), S(0.0042), INK_DIM);
  }
  // Davtron-style digital clock / OAT / volts beside the hour meter (red LCD digits, three buttons).
  {
    const x = X(ru.x + 0.07);
    const y = Y(ru.y - 0.008);
    rrect(c, x, y, S(0.085), S(0.034), S(0.003));
    c.fillStyle = '#111213';
    c.fill();
    rrect(c, x + S(0.006), y + S(0.004), S(0.073), S(0.016), S(0.0015));
    c.fillStyle = '#1c0a08';
    c.fill();
    text(c, '12:47', x + S(0.0425), y + S(0.0122), S(0.011), '#ff5a3c', 'center', 700, MONO);
    for (let i = 0; i < 3; i++) {
      circle(c, x + S(0.02 + i * 0.0225), y + S(0.027), S(0.0032));
      c.fillStyle = '#8a8c90';
      c.fill();
    }
    text(c, 'OAT · VOLTS · CLOCK', x + S(0.0425), y + S(0.038), S(0.0034), INK_DIM);
  }
  // ELT remote switch and the low-voltage light, right of the engine gauges.
  {
    const ex = X(0.272);
    const ey = Y(0.3);
    rrect(c, ex - S(0.017), ey - S(0.014), S(0.034), S(0.03), S(0.002));
    c.fillStyle = '#c9c4b6';
    c.fill();
    text(c, 'ELT', ex, ey - S(0.008), S(0.0048), '#1a1a1a');
    text(c, 'ON  ARM  RESET', ex, ey + S(0.011), S(0.0028), '#1a1a1a');
    circle(c, ex, ey + S(0.002), S(0.0045));
    c.fillStyle = '#26272a';
    c.fill();
    c.fillStyle = '#c8cacc';
    c.fillRect(ex - S(0.0012), ey - S(0.004), S(0.0024), S(0.008));
    circle(c, X(0.272), Y(0.245), S(0.0065));
    c.fillStyle = '#3a0c08';
    c.fill();
    text(c, 'LOW VOLTS', X(0.272), Y(0.232), S(0.0036), INK_DIM);
  }
  // Wear: rubbed paint round the most-used knobs and the yoke holes, a scuff under the key.
  for (const [x, y, r] of [[L.throttle.x, L.throttle.y, 0.024], [L.mixture.x, L.mixture.y, 0.02], [L.magneto.x, L.magneto.y, 0.024], [L.yokeShafts[0].x, L.yokeShafts[0].y, 0.04], [L.yokeShafts[1].x, L.yokeShafts[1].y, 0.04], [L.gearHandle.x, L.gearHandle.bottom, 0.02]] as const) {
    const g = c.createRadialGradient(X(x), Y(y), S(r * 0.5), X(x), Y(y), S(r));
    g.addColorStop(0, 'rgba(120,122,126,0.10)');
    g.addColorStop(1, 'rgba(120,122,126,0)');
    c.fillStyle = g;
    circle(c, X(x), Y(y), S(r));
    c.fill();
  }
  // Registration placard and the model name.
  text(c, 'N172RG', X(-0.487), Y(0.425), S(0.0065), '#b9b6ad', 'left', 700, MONO);
  text(c, 'CUTLASS RG', X(-0.1), Y(0.43), S(0.006), '#7c7a74');
  text(c, 'CESSNA', X(0.41), Y(0.065), S(0.009), '#6d6b66', 'center', 800);
}

function paintBackground(c: CanvasRenderingContext2D, w: number, h: number) {
  // Satin dark-grey painted metal, darker at the bottom (in the shadow of the glareshield… and the knees).
  const g = c.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#303236');
  g.addColorStop(0.35, '#2b2d30');
  g.addColorStop(1, '#1f2123');
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);
  // Crinkle texture: a few thousand faint specks (deterministic).
  let seed = 1234567;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const n = Math.min(40000, Math.round((w * h) / 60));
  for (let i = 0; i < n; i++) {
    c.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.08)';
    c.fillRect(rnd() * w, rnd() * h, 1.5, 1.5);
  }
  // Shadow under the glareshield lip.
  const sg = c.createLinearGradient(0, Y(PANEL.topY), 0, Y(PANEL.topY - 0.03));
  sg.addColorStop(0, 'rgba(0,0,0,0.55)');
  sg.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = sg;
  c.fillRect(0, Y(PANEL.topY), w, S(0.03));
  // Subpanel seam between the upper (flight/radio) and lower (switch/control) panels.
  c.fillStyle = 'rgba(0,0,0,0.5)';
  c.fillRect(X(-0.51), Y(0.2), S(0.32), Math.max(1, S(0.0015)));
  // Instrument seats.
  for (const k of ['airspeed', 'attitude', 'altimeter', 'turn', 'heading', 'vsi', 'nav1', 'nav2', 'manifold', 'tach'] as const) flange(c, L[k]);
  clockFace(c);
  smallGauge(c, L.suction, 'SUCTION', '3', '7', [-15, 25], 5);
  smallGauge(c, L.ammeter, 'AMPS', '−', '+', [-10, 10], 2);
  navHead(c, L.nav1, 0, true);
  navHead(c, L.nav2, 0, false);
  mpFace(c);
  egtFace(c);
  clusterFace(c);
  avionics(c);
  controlsArt(c);
}

// ─── Background cache ──────────────────────────────────────────────────────

let bg: { img: CanvasImageSource; w: number; h: number } | null = null;
function background(w: number, h: number): CanvasImageSource | null {
  if (bg && bg.w === w && bg.h === h) return bg.img;
  let surf: { img: CanvasImageSource; ctx: CanvasRenderingContext2D } | null = null;
  try {
    if (typeof OffscreenCanvas !== 'undefined') {
      const cv = new OffscreenCanvas(w, h);
      const x = cv.getContext('2d') as unknown as CanvasRenderingContext2D | null;
      if (x) surf = { img: cv, ctx: x };
    } else if (typeof document !== 'undefined') {
      const cv = document.createElement('canvas');
      cv.width = w;
      cv.height = h;
      const x = cv.getContext('2d');
      if (x) surf = { img: cv, ctx: x };
    }
  } catch {
    surf = null;
  }
  if (!surf) return null;
  paintBackground(surf.ctx, w, h);
  bg = { img: surf.img, w, h };
  return bg.img;
}

// ─── The drawer ────────────────────────────────────────────────────────────

const SIX = ['airspeed', 'attitude', 'altimeter', 'turn', 'heading', 'vsi'] as const;

/** Draw the whole 172RG panel face into a w×h canvas (PANEL.width × PANEL.height is 1:1). */
export function drawCessnaPanel(ctx: CanvasRenderingContext2D, w: number, h: number, r: InstrumentReadings): void {
  const W = Number.isFinite(w) && w > 0 ? Math.min(w, 8192) : 0;
  const H = Number.isFinite(h) && h > 0 ? Math.min(h, 8192) : 0;
  if (!W || !H) return;
  setMapping(W, H);
  ctx.save();
  const img = background(W, H);
  if (img) ctx.drawImage(img, 0, 0);
  else paintBackground(ctx, W, H);
  // Flight instruments and the tach: the HUD's own gauge drawers at real size.
  for (const k of SIX) {
    const g = L[k];
    GAUGES[k](ctx, X(g.x), Y(g.y), S(g.d), r);
  }
  GAUGES.tach(ctx, X(L.tach.x), Y(L.tach.y), S(L.tach.d), r);
  // Manifold pressure and fuel flow (engine model: MP follows the throttle, ambient at full).
  {
    const g = L.manifold;
    const F = (S(g.d) / 2) * 0.87;
    const running = r.engineStatus === 'RUNNING';
    const thr = clamp(fin(r.throttlePct), 0, 100) / 100;
    const ambient = 29.92 - clamp(fin(r.altitudeFt), -2000, 30000) / 1000;
    const mp = running ? 11 + (ambient - 11) * thr : ambient;
    const ff = running ? 2.5 + 11 * thr * thr : 0;
    needle(ctx, X(g.x), Y(g.y), mpDeg(mp), F * 0.8, F * 0.055);
    needle(ctx, X(g.x), Y(g.y), ffDeg(ff), F * 0.5, F * 0.045, '#dcdad2');
    glass(ctx, g);
  }
  // EGT follows power.
  {
    const g = L.egt;
    const F = (S(g.d) / 2) * 0.87;
    const running = r.engineStatus === 'RUNNING';
    needle(ctx, X(g.x), Y(g.y), running ? -30 + (clamp(fin(r.rpm), 0, 2800) / 2800) * 70 : -58, F * 0.78, F * 0.05);
    glass(ctx, g);
  }
  clusterNeedles(ctx, r);
  // Flap position indicator pointer (actual flap angle).
  {
    const fi = L.flapIndicator;
    const t = clamp(fin(r.flapsDeg), 0, 30) / 30;
    const y = Y(fi.y - 0.008 - t * (fi.h - 0.016));
    ctx.fillStyle = '#f39322';
    ctx.beginPath();
    ctx.moveTo(X(fi.x) - S(0.001), y);
    ctx.lineTo(X(fi.x) - S(0.006), y - S(0.0028));
    ctx.lineTo(X(fi.x) - S(0.006), y + S(0.0028));
    ctx.fill();
  }
  ctx.restore();
}
