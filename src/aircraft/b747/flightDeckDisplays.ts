/**
 * Boeing 747-400 flight deck — the display painters (canvas 2D, square pictures of S × S px):
 *
 *  - PFD: FMA row, attitude (sky/ground, pitch scale every 2.5°, bank scale + pointer + slip,
 *    aircraft symbol, flight path vector), speed tape (V1/VR/REF bugs, flap manoeuvre speeds,
 *    barber poles, amber minimum-manoeuvre band, selected speed, Mach/GS), altitude tape
 *    (selected altitude, baro), VSI, heading rose with the selected heading bug, radio altitude.
 *  - ND (MAP, heading up): compass arc, the magenta route with waypoints, the airport and its
 *    runways, range arcs, track line, trend vector, GS/TAS, the active waypoint's distance.
 *  - Upper EICAS: four N1 and EGT round dials with digital readouts and redlines, thrust mode,
 *    TAT, alerts and memos, gear, flaps, total fuel.
 *  - Lower EICAS (secondary engine page): N2 dials, fuel flow, oil pressure/temperature/quantity, VIB.
 *  - Standby instruments: airspeed, attitude, altimeter (stacked).
 *
 * Boeing colours: white scales, magenta targets, green modes, cyan labels, amber cautions, red
 * warnings, on black. Every painter takes finite readings (see flightDeckReadings.ts) and never
 * allocates arrays per call beyond what canvas itself does.
 */
import type { DeckReadings } from './flightDeckReadings';
import { ENGINE_MAP } from './flightDeckReadings';

type Ctx = CanvasRenderingContext2D;

export const DC = {
  bg: '#000000',
  white: '#f4f6f8',
  magenta: '#ff5cf0',
  green: '#3cf06e',
  cyan: '#40d8ff',
  amber: '#ffb319',
  red: '#ff3030',
  sky: '#1f78c8',
  ground: '#7e5132',
  tape: '#4a5058',
  grey: '#8a9098',
} as const;

const FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';
const DEG = Math.PI / 180;
const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
const f = (x: number): number => (Number.isFinite(x) ? x : 0);

function text(c: Ctx, s: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign = 'center', weight = 600) {
  c.font = `${weight} ${Math.max(4, Math.round(size))}px ${FONT}`;
  c.fillStyle = color;
  c.textAlign = align;
  c.textBaseline = 'middle';
  c.fillText(s, f(x), f(y));
}
function line(c: Ctx, x0: number, y0: number, x1: number, y1: number, color: string, w: number) {
  c.strokeStyle = color;
  c.lineWidth = w;
  c.beginPath();
  c.moveTo(f(x0), f(y0));
  c.lineTo(f(x1), f(y1));
  c.stroke();
}
function box(c: Ctx, x: number, y: number, w: number, h: number, stroke: string, lw: number, fill?: string) {
  if (fill) {
    c.fillStyle = fill;
    c.fillRect(f(x), f(y), f(w), f(h));
  }
  c.strokeStyle = stroke;
  c.lineWidth = lw;
  c.strokeRect(f(x), f(y), f(w), f(h));
}
const pad3 = (n: number) => String(Math.round(n)).padStart(3, '0');

// ─── PFD ─────────────────────────────────────────────────────────────────────

/** PFD geometry as fractions of S. */
export const PFD = { cx: 0.47, cy: 0.46, adiHalfW: 0.2, adiHalfH: 0.25, ppd: 0.0102, spd: { x0: 0.035, x1: 0.16, half: 0.3, pxPerKt: 0.0044 }, alt: { x0: 0.77, x1: 0.895, half: 0.3, pxPerFt: 0.00062 }, vsi: { x0: 0.905, x1: 0.985 } } as const;

export function drawPfd(c: Ctx, S: number, r: DeckReadings): void {
  c.save();
  c.fillStyle = DC.bg;
  c.fillRect(0, 0, S, S);
  const cx = PFD.cx * S;
  const cy = PFD.cy * S;
  const hw = PFD.adiHalfW * S;
  const hh = PFD.adiHalfH * S;
  const ppd = PFD.ppd * S;

  // ── Attitude ──
  c.save();
  c.beginPath();
  const rr = S * 0.035;
  c.moveTo(cx - hw + rr, cy - hh);
  c.lineTo(cx + hw - rr, cy - hh);
  c.quadraticCurveTo(cx + hw, cy - hh, cx + hw, cy - hh + rr);
  c.lineTo(cx + hw, cy + hh - rr);
  c.quadraticCurveTo(cx + hw, cy + hh, cx + hw - rr, cy + hh);
  c.lineTo(cx - hw + rr, cy + hh);
  c.quadraticCurveTo(cx - hw, cy + hh, cx - hw, cy + hh - rr);
  c.lineTo(cx - hw, cy - hh + rr);
  c.quadraticCurveTo(cx - hw, cy - hh, cx - hw + rr, cy - hh);
  c.closePath();
  c.clip();
  c.translate(cx, cy);
  c.rotate(-f(r.roll) * DEG);
  c.translate(0, clamp(r.pitch, -90, 90) * ppd);
  const big = S * 2;
  c.fillStyle = DC.sky;
  c.fillRect(-big, -big * 2, big * 2, big * 2);
  c.fillStyle = DC.ground;
  c.fillRect(-big, 0, big * 2, big * 2);
  line(c, -big, 0, big, 0, DC.white, S * 0.006);
  // Pitch scale: every 2.5° (short), 5° (medium), 10° (long with numbers), within ±30° of the nose.
  const p0 = Math.ceil((r.pitch - 22) / 2.5);
  const p1 = Math.floor((r.pitch + 22) / 2.5);
  for (let k = p0; k <= p1; k++) {
    if (k === 0) continue;
    const deg = k * 2.5;
    const y = -deg * ppd;
    const ten = k % 4 === 0;
    const five = k % 2 === 0;
    const w = ten ? 0.085 * S : five ? 0.045 * S : 0.022 * S;
    line(c, -w, y, w, y, DC.white, S * 0.004);
    if (ten && Math.abs(deg) <= 90) {
      text(c, String(Math.abs(deg)), -w - 0.03 * S, y, S * 0.034, DC.white);
      text(c, String(Math.abs(deg)), w + 0.03 * S, y, S * 0.034, DC.white);
    }
  }
  c.restore();

  // Bank scale (fixed, top of the ADI) and the pointer that turns with the roll.
  const R = hh * 0.92;
  c.strokeStyle = DC.white;
  c.lineWidth = S * 0.004;
  c.beginPath();
  c.arc(cx, cy, R, -Math.PI / 2 - 60 * DEG, -Math.PI / 2 + 60 * DEG);
  c.stroke();
  for (const a of [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60]) {
    const t = (-90 + a) * DEG;
    const l = Math.abs(a) === 30 || Math.abs(a) === 60 ? 0.035 * S : 0.02 * S;
    line(c, cx + Math.cos(t) * R, cy + Math.sin(t) * R, cx + Math.cos(t) * (R + l), cy + Math.sin(t) * (R + l), DC.white, S * 0.004);
  }
  // Zero index (fixed triangle).
  c.fillStyle = DC.white;
  c.beginPath();
  c.moveTo(cx, cy - R - 0.002 * S);
  c.lineTo(cx - 0.016 * S, cy - R - 0.03 * S);
  c.lineTo(cx + 0.016 * S, cy - R - 0.03 * S);
  c.closePath();
  c.fill();
  // Roll pointer + slip/skid brick (amber past 35° of bank).
  c.save();
  c.translate(cx, cy);
  c.rotate(-clamp(r.roll, -180, 180) * DEG);
  const pc = Math.abs(r.roll) > 35 ? DC.amber : DC.white;
  c.strokeStyle = pc;
  c.lineWidth = S * 0.004;
  c.beginPath();
  c.moveTo(0, -R + 0.002 * S);
  c.lineTo(-0.016 * S, -R + 0.03 * S);
  c.lineTo(0.016 * S, -R + 0.03 * S);
  c.closePath();
  c.stroke();
  const sl = clamp(r.slip, -1, 1) * 0.03 * S;
  c.strokeRect(sl - 0.018 * S, -R + 0.036 * S, 0.036 * S, 0.012 * S);
  c.restore();

  // Flight path vector (airborne): circle with wings, at the flight-path angle.
  if (!r.onGround) {
    const fy = cy - clamp(r.fpa - r.pitch, -20, 20) * ppd;
    c.strokeStyle = DC.white;
    c.lineWidth = S * 0.004;
    c.beginPath();
    c.arc(cx, fy, 0.014 * S, 0, Math.PI * 2);
    c.stroke();
    line(c, cx - 0.042 * S, fy, cx - 0.014 * S, fy, DC.white, S * 0.004);
    line(c, cx + 0.014 * S, fy, cx + 0.042 * S, fy, DC.white, S * 0.004);
    line(c, cx, fy - 0.014 * S, cx, fy - 0.03 * S, DC.white, S * 0.004);
  }
  // Aircraft symbol: two L-shaped wings and the centre square, black with a white outline.
  c.lineWidth = S * 0.004;
  for (const s of [-1, 1]) {
    const x0 = cx + s * 0.055 * S;
    const x1 = cx + s * 0.14 * S;
    c.fillStyle = '#000';
    c.strokeStyle = DC.white;
    c.beginPath();
    c.moveTo(x1, cy - 0.008 * S);
    c.lineTo(x0, cy - 0.008 * S);
    c.lineTo(x0, cy + 0.03 * S);
    c.lineTo(x0 + s * 0.016 * S, cy + 0.03 * S);
    c.lineTo(x0 + s * 0.016 * S, cy + 0.008 * S);
    c.lineTo(x1, cy + 0.008 * S);
    c.closePath();
    c.fill();
    c.stroke();
  }
  c.fillStyle = '#000';
  c.fillRect(cx - 0.009 * S, cy - 0.009 * S, 0.018 * S, 0.018 * S);
  c.strokeRect(cx - 0.009 * S, cy - 0.009 * S, 0.018 * S, 0.018 * S);

  // Radio altitude under 2,500 ft.
  if (r.aglFt < 2500) text(c, r.aglFt < 100 ? String(Math.round(r.aglFt)) : String(Math.round(r.aglFt / 10) * 10), cx, cy + hh + 0.035 * S, S * 0.042, DC.white);

  drawSpeedTape(c, S, r);
  drawAltTape(c, S, r);
  drawVsi(c, S, r);
  drawHeadingRose(c, S, r);

  // FMA (flight mode annunciations).
  const fy = 0.035 * S;
  const colW = (PFD.alt.x0 - PFD.spd.x1) * S / 3;
  const x0 = PFD.spd.x1 * S;
  for (let i = 1; i < 3; i++) line(c, x0 + colW * i, 0.008 * S, x0 + colW * i, 0.065 * S, DC.white, S * 0.003);
  const modes = r.onGround ? ['THR REF', 'TO/GA', 'TO/GA'] : r.vsFpm > 300 ? ['THR REF', 'HDG SEL', 'FLCH SPD'] : ['SPD', 'HDG SEL', 'ALT'];
  for (let i = 0; i < 3; i++) text(c, modes[i], x0 + colW * (i + 0.5), fy, S * 0.036, DC.green);
  text(c, r.onGround ? 'FD' : 'A/P', cx, 0.1 * S, S * 0.036, DC.green);
  // Stall / overspeed flags.
  if (r.stall) text(c, 'STALL', cx, cy - hh * 0.55, S * 0.06, DC.red, 'center', 800);
  c.restore();
}

function drawSpeedTape(c: Ctx, S: number, r: DeckReadings) {
  const T = PFD.spd;
  const x0 = T.x0 * S;
  const x1 = T.x1 * S;
  const cy = PFD.cy * S;
  const half = T.half * S;
  const k = T.pxPerKt * S;
  const y = (kt: number) => cy - (kt - r.ias) * k;
  c.save();
  c.beginPath();
  c.rect(x0 - 0.03 * S, cy - half, x1 - x0 + 0.06 * S, half * 2);
  c.clip();
  c.fillStyle = DC.tape;
  c.fillRect(x0, cy - half, x1 - x0, half * 2);
  const lo = Math.max(30, Math.floor((r.ias - half / k) / 10) * 10);
  const hi = Math.ceil((r.ias + half / k) / 10) * 10;
  for (let kt = lo; kt <= hi; kt += 10) {
    const yy = y(kt);
    line(c, x1 - 0.022 * S, yy, x1, yy, DC.white, S * 0.004);
    if (kt % 20 === 0) text(c, String(kt), x1 - 0.028 * S, yy, S * 0.04, DC.white, 'right');
  }
  // Barber poles: max speed (top) and stall (bottom), red/black checks.
  const pole = (from: number, to: number) => {
    const ya = y(from);
    const yb = y(to);
    const top = Math.min(ya, yb);
    const bot = Math.max(ya, yb);
    const w = 0.014 * S;
    for (let yy = top; yy < bot; yy += w * 2) {
      c.fillStyle = DC.red;
      c.fillRect(x1 - w, yy, w, Math.min(w, bot - yy));
      c.fillStyle = '#000';
      c.fillRect(x1 - w, yy + w, w, Math.max(0, Math.min(w, bot - yy - w)));
    }
  };
  if (!r.onGround) {
    pole(r.vmax, r.vmax + 200);
    pole(Math.max(0, r.vstall - 200), r.vstall);
    // Amber minimum-manoeuvre band.
    c.fillStyle = DC.amber;
    const ya = y(r.vminMan);
    const yb = y(r.vstall);
    c.fillRect(x1 - 0.006 * S, Math.min(ya, yb), 0.006 * S, Math.abs(yb - ya));
  } else pole(r.vmax, r.vmax + 200);
  // Bugs: V1, VR (takeoff), REF (landing), flap manoeuvre speeds (green), selected speed (magenta).
  const bug = (kt: number, label: string, color: string) => {
    const yy = y(kt);
    if (yy < cy - half || yy > cy + half) return;
    line(c, x1, yy, x1 + 0.018 * S, yy, color, S * 0.005);
    text(c, label, x1 + 0.021 * S, yy, S * 0.032, color, 'left');
  };
  if (r.onGround || r.altFt < 1500) {
    bug(r.v1, 'V1', DC.green);
    bug(r.vr, 'VR', DC.green);
  }
  if (r.flapsTargetDeg >= 20 || (!r.onGround && r.vsFpm < -300)) bug(r.vref, 'REF', DC.green);
  if (!r.onGround && r.flapsDeg > 0.5) {
    const fl = r.flapsDeg;
    const next = fl > 25 ? ['25', 10] : fl > 20 ? ['20', 10] : fl > 10 ? ['10', 20] : fl > 5 ? ['5', 40] : fl > 1 ? ['1', 60] : ['UP', 80];
    bug(r.vref + (next[1] as number), next[0] as string, DC.green);
  }
  // Selected speed bug (magenta, notched).
  {
    const yy = clamp(y(r.selSpd), cy - half, cy + half);
    c.strokeStyle = DC.magenta;
    c.lineWidth = S * 0.005;
    c.beginPath();
    c.moveTo(x1, yy - 0.012 * S);
    c.lineTo(x1 + 0.014 * S, yy - 0.012 * S);
    c.lineTo(x1 + 0.014 * S, yy + 0.012 * S);
    c.lineTo(x1, yy + 0.012 * S);
    c.moveTo(x1, yy - 0.004 * S);
    c.lineTo(x1 + 0.008 * S, yy);
    c.lineTo(x1, yy + 0.004 * S);
    c.stroke();
  }
  c.restore();
  // Current speed box.
  const bw = x1 - x0 - 0.004 * S;
  c.fillStyle = '#000';
  c.strokeStyle = DC.white;
  c.lineWidth = S * 0.004;
  c.beginPath();
  c.moveTo(x0, cy - 0.03 * S);
  c.lineTo(x0 + bw, cy - 0.03 * S);
  c.lineTo(x0 + bw, cy - 0.012 * S);
  c.lineTo(x0 + bw + 0.014 * S, cy);
  c.lineTo(x0 + bw, cy + 0.012 * S);
  c.lineTo(x0 + bw, cy + 0.03 * S);
  c.lineTo(x0, cy + 0.03 * S);
  c.closePath();
  c.fill();
  c.stroke();
  const low = !r.onGround && r.ias < r.vminMan;
  text(c, r.ias < 30 ? '---' : String(Math.round(r.ias)), x0 + bw - 0.006 * S, cy, S * 0.052, low ? DC.amber : DC.white, 'right', 700);
  // Selected speed (top) and Mach / ground speed (bottom).
  text(c, String(Math.round(r.selSpd)), (x0 + x1) / 2, cy - half - 0.03 * S, S * 0.044, DC.magenta);
  if (r.mach >= 0.4) text(c, `.${String(Math.round(r.mach * 1000)).padStart(3, '0').slice(-3)}`, (x0 + x1) / 2, cy + half + 0.03 * S, S * 0.042, DC.white);
  else text(c, `GS ${Math.round(r.gsKt)}`, (x0 + x1) / 2, cy + half + 0.03 * S, S * 0.036, DC.white);
}

function drawAltTape(c: Ctx, S: number, r: DeckReadings) {
  const T = PFD.alt;
  const x0 = T.x0 * S;
  const x1 = T.x1 * S;
  const cy = PFD.cy * S;
  const half = T.half * S;
  const k = T.pxPerFt * S;
  const y = (ft: number) => cy - (ft - r.altFt) * k;
  c.save();
  c.beginPath();
  c.rect(x0 - 0.02 * S, cy - half, x1 - x0 + 0.02 * S, half * 2);
  c.clip();
  c.fillStyle = DC.tape;
  c.fillRect(x0, cy - half, x1 - x0, half * 2);
  const lo = Math.floor((r.altFt - half / k) / 100) * 100;
  const hi = Math.ceil((r.altFt + half / k) / 100) * 100;
  for (let ft = lo; ft <= hi; ft += 100) {
    const yy = y(ft);
    line(c, x0, yy, x0 + 0.018 * S, yy, DC.white, S * 0.004);
    if (ft % 200 === 0) text(c, String(ft), x1 - 0.004 * S, yy, S * 0.034, DC.white, 'right');
  }
  // Selected altitude bug (magenta).
  const sy = clamp(y(r.selAlt), cy - half, cy + half);
  box(c, x0, sy - 0.02 * S, 0.016 * S, 0.04 * S, DC.magenta, S * 0.005);
  c.restore();
  // Current altitude box (thousands big, hundreds small).
  c.fillStyle = '#000';
  c.strokeStyle = DC.white;
  c.lineWidth = S * 0.004;
  c.fillRect(x0 - 0.012 * S, cy - 0.032 * S, x1 - x0 + 0.016 * S, 0.064 * S);
  c.strokeRect(x0 - 0.012 * S, cy - 0.032 * S, x1 - x0 + 0.016 * S, 0.064 * S);
  const a = Math.round(r.altFt / 20) * 20;
  const th = Math.trunc(a / 1000);
  const hu = Math.abs(a - th * 1000);
  text(c, a < 0 && th === 0 ? '-0' : String(th), x0 + 0.05 * S, cy, S * 0.054, DC.white, 'right', 700);
  text(c, String(hu).padStart(3, '0'), x0 + 0.052 * S, cy + 0.004 * S, S * 0.04, DC.white, 'left', 700);
  text(c, String(r.selAlt), (x0 + x1) / 2, cy - half - 0.03 * S, S * 0.044, DC.magenta);
  text(c, '29.92 IN', (x0 + x1) / 2, cy + half + 0.03 * S, S * 0.036, DC.green);
}

/** VSI pointer offset (fraction of the scale half-height) for a vertical speed: ±1000 → 0.4, ±2000 → 0.65, ±6000 → 1. */
export function vsiScale(fpm: number): number {
  const a = Math.min(6000, Math.abs(f(fpm)));
  const v = a <= 1000 ? (0.4 * a) / 1000 : a <= 2000 ? 0.4 + (0.25 * (a - 1000)) / 1000 : 0.65 + (0.35 * (a - 2000)) / 4000;
  return Math.sign(f(fpm)) * v;
}

function drawVsi(c: Ctx, S: number, r: DeckReadings) {
  const x0 = PFD.vsi.x0 * S;
  const x1 = PFD.vsi.x1 * S;
  const cy = PFD.cy * S;
  const half = 0.24 * S;
  c.fillStyle = DC.tape;
  c.beginPath();
  c.moveTo(x0, cy - half + 0.03 * S);
  c.lineTo(x0 + 0.02 * S, cy - half);
  c.lineTo(x1, cy - half);
  c.lineTo(x1, cy + half);
  c.lineTo(x0 + 0.02 * S, cy + half);
  c.lineTo(x0, cy + half - 0.03 * S);
  c.closePath();
  c.fill();
  for (const [v, lbl] of [[1000, '1'], [2000, '2'], [6000, '6']] as const) {
    for (const s of [-1, 1]) {
      const yy = cy - s * vsiScale(v) * half;
      line(c, x0 + 0.004 * S, yy, x0 + 0.02 * S, yy, DC.white, S * 0.004);
      text(c, lbl, x0 + 0.03 * S, yy, S * 0.03, DC.white);
    }
  }
  line(c, x0 + 0.004 * S, cy, x0 + 0.026 * S, cy, DC.white, S * 0.006);
  // Pointer from a pivot off the right edge.
  const py = cy - vsiScale(r.vsFpm) * half;
  line(c, x1 + 0.04 * S, cy, x0 + 0.006 * S, py, DC.white, S * 0.005);
  if (Math.abs(r.vsFpm) >= 400) text(c, String(Math.round(Math.abs(r.vsFpm) / 50) * 50), (x0 + x1) / 2, r.vsFpm > 0 ? cy - half - 0.025 * S : cy + half + 0.025 * S, S * 0.032, DC.white);
}

function drawHeadingRose(c: Ctx, S: number, r: DeckReadings) {
  const cx = PFD.cx * S;
  const top = 0.83 * S;
  const R = 0.34 * S;
  const ccy = top + R;
  c.save();
  c.beginPath();
  c.rect(cx - 0.3 * S, top - 0.01 * S, 0.6 * S, S - top + 0.01 * S);
  c.clip();
  c.fillStyle = DC.tape;
  c.beginPath();
  c.arc(cx, ccy, R, 0, Math.PI * 2);
  c.fill();
  for (let d = 0; d < 360; d += 5) {
    const a = (d - r.hdg) * DEG;
    if (Math.cos(a) < 0.55) continue;
    const sx = cx + Math.sin(a) * R;
    const sy = ccy - Math.cos(a) * R;
    const l = d % 10 === 0 ? 0.022 * S : 0.012 * S;
    line(c, sx, sy, cx + Math.sin(a) * (R - l), ccy - Math.cos(a) * (R - l), DC.white, S * 0.004);
    if (d % 30 === 0) text(c, String(d / 10), cx + Math.sin(a) * (R - 0.045 * S), ccy - Math.cos(a) * (R - 0.045 * S), S * 0.036, DC.white);
  }
  // Selected heading bug.
  const ha = (r.selHdg - r.hdg) * DEG;
  if (Math.cos(ha) > 0.55) {
    c.strokeStyle = DC.magenta;
    c.lineWidth = S * 0.005;
    const bx = cx + Math.sin(ha) * R;
    const by = ccy - Math.cos(ha) * R;
    c.strokeRect(bx - 0.012 * S, by - 0.004 * S, 0.024 * S, 0.012 * S);
  }
  c.restore();
  // Heading box + MAG.
  box(c, cx - 0.045 * S, top - 0.05 * S, 0.09 * S, 0.042 * S, DC.white, S * 0.004, '#000');
  text(c, pad3(r.hdg) === '000' ? '360' : pad3(r.hdg), cx, top - 0.029 * S, S * 0.04, DC.white, 'center', 700);
  text(c, 'MAG', cx + 0.07 * S, top - 0.029 * S, S * 0.03, DC.green, 'left');
  text(c, `H ${pad3(r.selHdg)}`, cx - 0.08 * S, top - 0.029 * S, S * 0.03, DC.magenta, 'right');
}

// ─── ND ──────────────────────────────────────────────────────────────────────

export interface MapFix {
  name: string;
  x: number;
  z: number;
}
/** A made-up local route around Tater Field (world metres, +X east, +Z south) and the airport. */
export const ND_ROUTE: readonly MapFix[] = [
  { name: 'RW36', x: 0, z: 800 },
  { name: 'CD36', x: 0, z: -3700 },
  { name: 'SPUDS', x: 4200, z: -8200 },
  { name: 'FRIES', x: 9500, z: -2500 },
  { name: 'TTVLE', x: 2100, z: 2100 },
  { name: 'MASHR', x: 2600, z: 9800 },
  { name: 'FF36', x: 0, z: 9800 },
];
export const ND_AIRPORT = { name: 'KTTR', x: 0, z: 0, runways: [{ hdg: 0, len: 1600 }, { hdg: 30, len: 1400 }] } as const;
export const ND_RANGE_NM = 10;
const NM = 1852;

/** Index of the active (next) waypoint: the one after the route point nearest the aircraft. */
export function activeFix(x: number, z: number): number {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < ND_ROUTE.length; i++) {
    const d = Math.hypot(ND_ROUTE[i].x - f(x), ND_ROUTE[i].z - f(z));
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return (best + 1) % ND_ROUTE.length;
}

/** Map point (world x, z) → ND pixel for an aircraft at (ax, az) heading hdg; aircraft symbol at (ox, oy), `ppm` px per metre. */
export function ndProject(x: number, z: number, ax: number, az: number, hdg: number, ox: number, oy: number, ppm: number): { x: number; y: number } {
  const east = f(x) - f(ax);
  const north = -(f(z) - f(az));
  const h = f(hdg) * DEG;
  const right = east * Math.cos(h) - north * Math.sin(h);
  const ahead = east * Math.sin(h) + north * Math.cos(h);
  return { x: ox + right * ppm, y: oy - ahead * ppm };
}

export function drawNd(c: Ctx, S: number, r: DeckReadings): void {
  c.save();
  c.fillStyle = DC.bg;
  c.fillRect(0, 0, S, S);
  const ox = 0.5 * S;
  const oy = 0.8 * S;
  const R = 0.66 * S;
  const ppm = R / (ND_RANGE_NM * NM);
  // Compass arc.
  c.strokeStyle = DC.white;
  c.lineWidth = S * 0.004;
  c.beginPath();
  c.arc(ox, oy, R, -Math.PI / 2 - 52 * DEG, -Math.PI / 2 + 52 * DEG);
  c.stroke();
  for (let d = 0; d < 360; d += 5) {
    const relDeg = ((((d - r.hdg) % 360) + 540) % 360) - 180;
    if (Math.abs(relDeg) > 52) continue;
    const rel = relDeg * DEG;
    const l = d % 10 === 0 ? 0.03 * S : 0.016 * S;
    line(c, ox + Math.sin(rel) * R, oy - Math.cos(rel) * R, ox + Math.sin(rel) * (R - l), oy - Math.cos(rel) * (R - l), DC.white, S * 0.004);
    if (d % 30 === 0) text(c, String(d / 10), ox + Math.sin(rel) * (R - 0.06 * S), oy - Math.cos(rel) * (R - 0.06 * S), S * (d % 90 === 0 ? 0.046 : 0.038), DC.white);
  }
  // Half-range arc (dashed) and its label.
  c.setLineDash([S * 0.012, S * 0.014]);
  c.strokeStyle = DC.white;
  c.lineWidth = S * 0.003;
  c.beginPath();
  c.arc(ox, oy, R / 2, -Math.PI / 2 - 50 * DEG, -Math.PI / 2 + 50 * DEG);
  c.stroke();
  // Track line (dashed) and the trend vector (turn-rate prediction, green).
  line(c, ox, oy - 0.02 * S, ox, oy - R, DC.white, S * 0.003);
  c.setLineDash([]);
  text(c, String(ND_RANGE_NM / 2), ox - R / 2 * Math.sin(50 * DEG) - 0.03 * S, oy - (R / 2) * Math.cos(50 * DEG), S * 0.034, DC.white);

  // Clip the map to the area above the aircraft symbol, inside the range.
  c.save();
  c.beginPath();
  c.rect(0, 0.1 * S, S, oy + 0.02 * S - 0.1 * S);
  c.clip();
  // Airport + runways (cyan circle, white runway outlines).
  const ap = ndProject(ND_AIRPORT.x, ND_AIRPORT.z, r.x, r.z, r.hdg, ox, oy, ppm);
  for (const rw of ND_AIRPORT.runways) {
    const a = (rw.hdg - r.hdg) * DEG;
    const dx = Math.sin(a) * (rw.len / 2) * ppm;
    const dy = -Math.cos(a) * (rw.len / 2) * ppm;
    line(c, ap.x - dx, ap.y - dy, ap.x + dx, ap.y + dy, DC.white, S * 0.008);
  }
  c.strokeStyle = DC.cyan;
  c.lineWidth = S * 0.004;
  c.beginPath();
  c.arc(ap.x, ap.y, 0.022 * S, 0, Math.PI * 2);
  c.stroke();
  text(c, ND_AIRPORT.name, ap.x + 0.03 * S, ap.y + 0.03 * S, S * 0.034, DC.cyan, 'left');
  // Route: magenta active leg, white elsewhere; waypoint stars with names.
  const act = activeFix(r.x, r.z);
  const n = ND_ROUTE.length;
  for (let i = 0; i < n; i++) {
    const a = ND_ROUTE[i];
    const b = ND_ROUTE[(i + 1) % n];
    const pa = ndProject(a.x, a.z, r.x, r.z, r.hdg, ox, oy, ppm);
    const pb = ndProject(b.x, b.z, r.x, r.z, r.hdg, ox, oy, ppm);
    line(c, pa.x, pa.y, pb.x, pb.y, (i + 1) % n === act ? DC.magenta : DC.white, S * 0.005);
  }
  for (let i = 0; i < n; i++) {
    const p = ndProject(ND_ROUTE[i].x, ND_ROUTE[i].z, r.x, r.z, r.hdg, ox, oy, ppm);
    const col = i === act ? DC.magenta : DC.white;
    c.strokeStyle = col;
    c.lineWidth = S * 0.004;
    c.beginPath();
    for (let k = 0; k < 4; k++) {
      const t = (k * Math.PI) / 2;
      c.moveTo(p.x, p.y);
      c.lineTo(p.x + Math.cos(t) * 0.02 * S, p.y + Math.sin(t) * 0.02 * S);
    }
    c.stroke();
    text(c, ND_ROUTE[i].name, p.x + 0.025 * S, p.y - 0.025 * S, S * 0.034, col, 'left');
  }
  c.restore();
  // Selected heading bug on the arc.
  const hb = (((r.selHdg - r.hdg) % 360) + 540) % 360 - 180;
  if (Math.abs(hb) < 52) {
    const a = hb * DEG;
    c.save();
    c.translate(ox + Math.sin(a) * R, oy - Math.cos(a) * R);
    c.rotate(a);
    box(c, -0.016 * S, -0.012 * S, 0.032 * S, 0.012 * S, DC.magenta, S * 0.005);
    c.restore();
  }
  // Aircraft symbol (white triangle).
  c.strokeStyle = DC.white;
  c.lineWidth = S * 0.005;
  c.beginPath();
  c.moveTo(ox, oy - 0.03 * S);
  c.lineTo(ox - 0.02 * S, oy + 0.03 * S);
  c.lineTo(ox + 0.02 * S, oy + 0.03 * S);
  c.closePath();
  c.stroke();
  // Header: heading box (top centre), GS/TAS (top left), active waypoint (top right).
  box(c, ox - 0.06 * S, 0.02 * S, 0.12 * S, 0.055 * S, DC.white, S * 0.004, '#000');
  text(c, pad3(r.hdg) === '000' ? '360' : pad3(r.hdg), ox, 0.048 * S, S * 0.046, DC.white, 'center', 700);
  text(c, 'HDG', ox - 0.08 * S, 0.048 * S, S * 0.034, DC.green, 'right');
  text(c, 'MAG', ox + 0.08 * S, 0.048 * S, S * 0.034, DC.green, 'left');
  text(c, `GS ${Math.round(r.gsKt)}  TAS ${Math.round(r.tasKt)}`, 0.03 * S, 0.12 * S, S * 0.034, DC.white, 'left');
  const w = ND_ROUTE[act];
  const dist = Math.hypot(w.x - r.x, w.z - r.z) / NM;
  text(c, w.name, S - 0.03 * S, 0.11 * S, S * 0.038, DC.magenta, 'right');
  text(c, `${dist.toFixed(1)} NM`, S - 0.03 * S, 0.155 * S, S * 0.034, DC.white, 'right');
  text(c, 'VOR L', 0.03 * S, S - 0.07 * S, S * 0.03, DC.green, 'left');
  text(c, 'TTR', 0.03 * S, S - 0.035 * S, S * 0.03, DC.green, 'left');
  c.restore();
}

// ─── EICAS ───────────────────────────────────────────────────────────────────

/** Round engine dial: 0 at −210° … full scale at 0° (screen angles from 3 o'clock, clockwise). */
function dial(c: Ctx, x: number, y: number, R: number, frac: number, redFrac: number, value: string, color: string, refFrac = -1) {
  const a0 = -210 * DEG;
  const a1 = 0;
  const ang = a0 + (a1 - a0) * clamp(frac, 0, 1.05);
  // Filled sector (the swept area) and the arc.
  c.fillStyle = 'rgba(160,166,176,0.45)';
  c.beginPath();
  c.moveTo(x, y);
  c.arc(x, y, R, a0, ang);
  c.closePath();
  c.fill();
  c.strokeStyle = DC.white;
  c.lineWidth = R * 0.07;
  c.beginPath();
  c.arc(x, y, R, a0, a0 + (a1 - a0) * clamp(redFrac, 0, 1));
  c.stroke();
  // Redline.
  const ar = a0 + (a1 - a0) * redFrac;
  line(c, x + Math.cos(ar) * R * 0.8, y + Math.sin(ar) * R * 0.8, x + Math.cos(ar) * R * 1.15, y + Math.sin(ar) * R * 1.15, DC.red, R * 0.1);
  if (refFrac >= 0) {
    const af = a0 + (a1 - a0) * refFrac;
    line(c, x + Math.cos(af) * R * 1.02, y + Math.sin(af) * R * 1.02, x + Math.cos(af) * R * 1.2, y + Math.sin(af) * R * 1.2, DC.green, R * 0.09);
  }
  // Needle.
  line(c, x, y, x + Math.cos(ang) * R * 0.95, y + Math.sin(ang) * R * 0.95, color, R * 0.08);
  // Digital readout box (upper right of the dial).
  box(c, x + R * 0.05, y - R * 0.92, R * 1.05, R * 0.55, DC.white, R * 0.05, '#000');
  text(c, value, x + R * 1.05, y - R * 0.64, R * 0.42, color, 'right', 700);
}

export function drawEicasUpper(c: Ctx, S: number, r: DeckReadings): void {
  c.save();
  c.fillStyle = DC.bg;
  c.fillRect(0, 0, S, S);
  const M = ENGINE_MAP;
  const R = 0.062 * S;
  const xs = [0.1, 0.25, 0.4, 0.55];
  // Thrust mode + reference N1 + TAT.
  text(c, r.thrustMode, 0.08 * S, 0.04 * S, S * 0.04, DC.green, 'left', 700);
  text(c, r.n1Ref.toFixed(1), 0.2 * S, 0.04 * S, S * 0.04, DC.green, 'left', 700);
  text(c, `TAT ${r.tat >= 0 ? '+' : ''}${Math.round(r.tat)}c`, 0.42 * S, 0.04 * S, S * 0.034, DC.cyan, 'left');
  for (let i = 0; i < 4; i++) {
    const e = r.engines[i];
    const x = xs[i] * S;
    dial(c, x, 0.2 * S, R, e.n1 / 110, M.n1Red / 110, e.n1.toFixed(1), DC.white, r.running ? r.n1Ref / 110 : -1);
    dial(c, x, 0.44 * S, R, (e.egt - 0) / 1000 * 1.25, M.egtRed / 800, String(Math.round(e.egt)), e.egt > M.egtRed ? DC.red : DC.white);
  }
  text(c, 'N1', 0.32 * S, 0.31 * S, S * 0.036, DC.cyan);
  text(c, 'EGT', 0.32 * S, 0.55 * S, S * 0.036, DC.cyan);
  // Alerts / memos (top right).
  for (let i = 0; i < r.alertCount; i++) {
    const a = r.alerts[i];
    text(c, a.text, 0.66 * S, (0.05 + i * 0.045) * S, S * 0.036, a.level === 2 ? DC.red : a.level === 1 ? DC.amber : DC.white, 'left', 700);
  }
  // Gear.
  const gx = 0.78 * S;
  const gy = 0.66 * S;
  text(c, 'GEAR', gx, gy - 0.055 * S, S * 0.034, DC.cyan);
  if (r.gear === 'down') box(c, gx - 0.07 * S, gy - 0.025 * S, 0.14 * S, 0.05 * S, DC.green, S * 0.004), text(c, 'DOWN', gx, gy, S * 0.04, DC.green, 'center', 700);
  else if (r.gear === 'transit') {
    box(c, gx - 0.07 * S, gy - 0.025 * S, 0.14 * S, 0.05 * S, DC.white, S * 0.004);
    for (let k = 0; k < 6; k++) line(c, gx - 0.07 * S + k * 0.024 * S, gy + 0.025 * S, gx - 0.05 * S + k * 0.024 * S, gy - 0.025 * S, DC.white, S * 0.003);
  } else text(c, 'UP', gx, gy, S * 0.04, DC.white, 'center', 700);
  // Flaps: vertical indicator with the lever setting (magenta) and the position (green) + digits.
  if (r.flapsDeg > 0.3 || r.flapsTargetDeg > 0) {
    const fx = 0.9 * S;
    const f0 = 0.5 * S;
    const f1 = 0.78 * S;
    box(c, fx - 0.018 * S, f0, 0.036 * S, f1 - f0, DC.white, S * 0.004);
    const fh = (clamp(r.flapsDeg, 0, 30) / 30) * (f1 - f0);
    c.fillStyle = DC.white;
    c.fillRect(fx - 0.014 * S, f0 + 0.002 * S, 0.028 * S, Math.max(0, fh - 0.004 * S));
    const ty = f0 + (clamp(r.flapsTargetDeg, 0, 30) / 30) * (f1 - f0);
    line(c, fx - 0.034 * S, ty, fx + 0.034 * S, ty, DC.magenta, S * 0.006);
    text(c, String(Math.round(r.flapsTargetDeg)), fx - 0.05 * S, ty, S * 0.04, Math.abs(r.flapsDeg - r.flapsTargetDeg) > 0.5 ? DC.magenta : DC.green, 'right', 700);
    text(c, 'FLAPS', fx, f0 - 0.03 * S, S * 0.032, DC.cyan);
  }
  // Total fuel.
  text(c, 'TOTAL FUEL', 0.66 * S, 0.9 * S, S * 0.032, DC.cyan, 'left');
  text(c, r.fuelT.toFixed(1), 0.95 * S, 0.9 * S, S * 0.042, DC.white, 'right', 700);
  text(c, 'KGS X 1000', 0.66 * S, 0.945 * S, S * 0.026, DC.cyan, 'left');
  c.restore();
}

export function drawEicasLower(c: Ctx, S: number, r: DeckReadings): void {
  c.save();
  c.fillStyle = DC.bg;
  c.fillRect(0, 0, S, S);
  const R = 0.07 * S;
  const xs = [0.14, 0.38, 0.62, 0.86];
  for (let i = 0; i < 4; i++) {
    const e = r.engines[i];
    const x = xs[i] * S;
    dial(c, x - 0.03 * S, 0.14 * S, R, e.n2 / 110, 1.05 / 1.1, e.n2.toFixed(1), DC.white);
    box(c, x - 0.07 * S, 0.3 * S, 0.14 * S, 0.055 * S, DC.white, S * 0.004, '#000');
    text(c, e.ff.toFixed(1), x + 0.06 * S, 0.33 * S, S * 0.042, DC.white, 'right', 700);
    // Oil pressure and temperature: small vertical bars; quantity and VIB: digits.
    const bar = (bx: number, frac: number, color: string) => {
      box(c, bx, 0.45 * S, 0.024 * S, 0.16 * S, DC.white, S * 0.003);
      const h = clamp(frac, 0, 1) * 0.16 * S;
      c.fillStyle = color;
      c.fillRect(bx + 0.003 * S, 0.61 * S - h, 0.018 * S, h);
    };
    bar(x - 0.05 * S, e.oilP / 200, DC.white);
    bar(x + 0.025 * S, e.oilT / 200, DC.white);
    text(c, String(Math.round(e.oilP)), x - 0.038 * S, 0.64 * S, S * 0.032, DC.white);
    text(c, String(Math.round(e.oilT)), x + 0.037 * S, 0.64 * S, S * 0.032, DC.white);
    text(c, e.oilQ.toFixed(0), x, 0.75 * S, S * 0.04, DC.white);
    text(c, e.vib.toFixed(1), x, 0.87 * S, S * 0.04, DC.white);
  }
  text(c, 'N2', 0.5 * S, 0.24 * S, S * 0.036, DC.cyan);
  text(c, 'FF', 0.5 * S, 0.395 * S, S * 0.036, DC.cyan);
  text(c, 'OIL P      OIL T', 0.5 * S, 0.42 * S, S * 0.03, DC.cyan);
  text(c, 'OIL Q', 0.5 * S, 0.81 * S, S * 0.032, DC.cyan);
  text(c, 'VIB', 0.5 * S, 0.93 * S, S * 0.032, DC.cyan);
  c.restore();
}

// ─── Standby instruments ─────────────────────────────────────────────────────

/** Three stacked standby instruments (airspeed, attitude, altimeter), each W × W, in a W × 3W canvas. */
export function drawStandby(c: Ctx, W: number, r: DeckReadings): void {
  c.save();
  c.fillStyle = '#16181b';
  c.fillRect(0, 0, W, W * 3);
  const face = (cy: number) => {
    c.fillStyle = '#050506';
    c.beginPath();
    c.arc(W / 2, cy, W * 0.46, 0, Math.PI * 2);
    c.fill();
  };
  // Airspeed: 40 → 450 kt around the dial.
  const cy0 = W / 2;
  face(cy0);
  const asA = (kt: number) => (-90 + (clamp(kt, 40, 450) - 40) / 410 * 330) * DEG;
  for (let kt = 40; kt <= 450; kt += 10) {
    const a = asA(kt);
    const l = kt % 50 === 0 ? 0.1 : 0.05;
    line(c, W / 2 + Math.cos(a) * W * 0.42, cy0 + Math.sin(a) * W * 0.42, W / 2 + Math.cos(a) * W * (0.42 - l), cy0 + Math.sin(a) * W * (0.42 - l), DC.white, W * 0.012);
    if (kt % 100 === 0) text(c, String(kt / 10), W / 2 + Math.cos(a) * W * 0.26, cy0 + Math.sin(a) * W * 0.26, W * 0.1, DC.white);
  }
  const aa = asA(r.ias);
  line(c, W / 2, cy0, W / 2 + Math.cos(aa) * W * 0.4, cy0 + Math.sin(aa) * W * 0.4, DC.white, W * 0.025);
  // Attitude.
  const cy1 = W * 1.5;
  c.save();
  c.beginPath();
  c.arc(W / 2, cy1, W * 0.44, 0, Math.PI * 2);
  c.clip();
  c.translate(W / 2, cy1);
  c.rotate(-f(r.roll) * DEG);
  c.translate(0, clamp(r.pitch, -60, 60) * W * 0.012);
  c.fillStyle = DC.sky;
  c.fillRect(-W, -2 * W, 2 * W, 2 * W);
  c.fillStyle = DC.ground;
  c.fillRect(-W, 0, 2 * W, 2 * W);
  line(c, -W, 0, W, 0, DC.white, W * 0.015);
  for (const d of [-20, -10, 10, 20]) line(c, -W * 0.1, -d * W * 0.012, W * 0.1, -d * W * 0.012, DC.white, W * 0.01);
  c.restore();
  line(c, W * 0.22, cy1, W * 0.4, cy1, DC.amber, W * 0.03);
  line(c, W * 0.6, cy1, W * 0.78, cy1, DC.amber, W * 0.03);
  // Altimeter: 100-ft needle + drum.
  const cy2 = W * 2.5;
  face(cy2);
  for (let k = 0; k < 50; k++) {
    const a = (-90 + k * 7.2) * DEG;
    const l = k % 5 === 0 ? 0.1 : 0.05;
    line(c, W / 2 + Math.cos(a) * W * 0.42, cy2 + Math.sin(a) * W * 0.42, W / 2 + Math.cos(a) * W * (0.42 - l), cy2 + Math.sin(a) * W * (0.42 - l), DC.white, W * 0.012);
    if (k % 5 === 0) text(c, String(k / 5), W / 2 + Math.cos(a) * W * 0.27, cy2 + Math.sin(a) * W * 0.27, W * 0.1, DC.white);
  }
  const alt = f(r.altFt);
  const na = (-90 + (((alt % 1000) + 1000) % 1000) * 0.36) * DEG;
  box(c, W * 0.3, cy2 - W * 0.2, W * 0.4, W * 0.13, DC.white, W * 0.01, '#000');
  text(c, String(Math.round(alt / 20) * 20), W * 0.5, cy2 - W * 0.135, W * 0.1, DC.white);
  line(c, W / 2, cy2, W / 2 + Math.cos(na) * W * 0.4, cy2 + Math.sin(na) * W * 0.4, DC.white, W * 0.025);
  c.restore();
}

/** Painter per display id (all square S × S). */
export const DISPLAY_PAINTERS = {
  pfdL: drawPfd,
  ndL: drawNd,
  eicasUpper: drawEicasUpper,
  ndR: drawNd,
  pfdR: drawPfd,
  eicasLower: drawEicasLower,
} as const;
