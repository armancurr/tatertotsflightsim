/**
 * The JetRanger's instrument panel face, drawn live on a canvas from InstrumentReadings: the
 * pilot's flight instruments on the right (airspeed, attitude, altimeter / turn coordinator,
 * heading, vertical speed — the shared steam-gauge drawers from src/ui/gauges.ts), the engine and
 * rotor instruments in the centre (dual tachometer NR/N2, torquemeter, turbine outlet temperature,
 * gas-producer N1, fuel), the caution lights along the top, and the radio stack on the left.
 *
 * The canvas maps onto the panel face: x 0..W spans body x −w/2..+w/2 (left to right as the pilot
 * sees it), y 0..H the face from its top edge down.
 */
import { drawAirspeed, drawAltimeter, drawAttitude, drawHeading, drawTurnCoordinator, drawVsi } from '../../ui/gauges';
import type { InstrumentReadings } from '../../types';
import { COCKPIT } from './cockpit';

/** Canvas pixels per metre of panel face. */
export const PANEL_PX_PER_M = 1500;
export const PANEL_TEX = {
  width: Math.round(COCKPIT.panel.w * PANEL_PX_PER_M),
  height: Math.round(COCKPIT.panel.h * PANEL_PX_PER_M),
} as const;

/** Instrument spots: body x (m) and distance below the face's top edge (m), case diameter (m). */
export const PANEL_SPOTS = {
  airspeed: { x: 0.205, y: 0.085, d: 0.084 },
  attitude: { x: 0.305, y: 0.085, d: 0.084 },
  altimeter: { x: 0.405, y: 0.085, d: 0.084 },
  turn: { x: 0.205, y: 0.19, d: 0.084 },
  heading: { x: 0.305, y: 0.19, d: 0.084 },
  vsi: { x: 0.405, y: 0.19, d: 0.084 },
  tach: { x: 0.085, y: 0.09, d: 0.09 },
  torque: { x: 0.085, y: 0.2, d: 0.084 },
  tot: { x: -0.035, y: 0.085, d: 0.066 },
  n1: { x: -0.035, y: 0.175, d: 0.066 },
  fuel: { x: -0.125, y: 0.085, d: 0.058 },
  oil: { x: -0.125, y: 0.17, d: 0.058 },
} as const;

const fin = (x: unknown, d = 0) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const DEG = Math.PI / 180;
const FONT = '"Helvetica Neue", Arial, sans-serif';

type Ctx = CanvasRenderingContext2D;

const px = (x: number) => (x + COCKPIT.panel.w / 2) * PANEL_PX_PER_M;
const py = (y: number) => y * PANEL_PX_PER_M;

interface Arc {
  from: number;
  to: number;
  color: string;
}

/**
 * A round engine dial: sweep from −135° to +135° (clockwise from 12 o'clock) over min..max,
 * coloured arcs, ticks, numerals, a title, and needles (value, colour, length fraction).
 */
function dial(c: Ctx, cx: number, cy: number, size: number, min: number, max: number, arcs: Arc[], major: number, labels: number[], title: string, needles: Array<[number, string, number]>, redline?: number) {
  const R = size / 2;
  const ang = (v: number) => (-135 + (270 * (clamp(v, min, max) - min)) / (max - min)) * DEG - Math.PI / 2;
  // Case and face.
  c.fillStyle = '#0c0c0d';
  c.beginPath();
  c.arc(cx, cy, R, 0, 2 * Math.PI);
  c.fill();
  c.fillStyle = '#151618';
  c.beginPath();
  c.arc(cx, cy, R * 0.9, 0, 2 * Math.PI);
  c.fill();
  c.lineCap = 'butt';
  for (const a of arcs) {
    c.strokeStyle = a.color;
    c.lineWidth = R * 0.09;
    c.beginPath();
    c.arc(cx, cy, R * 0.8, ang(a.from), ang(a.to));
    c.stroke();
  }
  if (redline !== undefined) {
    c.strokeStyle = '#e2362b';
    c.lineWidth = R * 0.05;
    const a = ang(redline);
    c.beginPath();
    c.moveTo(cx + Math.cos(a) * R * 0.68, cy + Math.sin(a) * R * 0.68);
    c.lineTo(cx + Math.cos(a) * R * 0.88, cy + Math.sin(a) * R * 0.88);
    c.stroke();
  }
  c.strokeStyle = '#eeeae0';
  for (let v = min; v <= max + 1e-6; v += major) {
    const a = ang(v);
    c.lineWidth = R * 0.03;
    c.beginPath();
    c.moveTo(cx + Math.cos(a) * R * 0.7, cy + Math.sin(a) * R * 0.7);
    c.lineTo(cx + Math.cos(a) * R * 0.86, cy + Math.sin(a) * R * 0.86);
    c.stroke();
  }
  c.fillStyle = '#eeeae0';
  c.font = `700 ${Math.round(R * 0.2)}px ${FONT}`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  for (const v of labels) {
    const a = ang(v);
    c.fillText(String(v), cx + Math.cos(a) * R * 0.52, cy + Math.sin(a) * R * 0.52);
  }
  c.fillStyle = '#b8b4aa';
  c.font = `700 ${Math.round(R * 0.15)}px ${FONT}`;
  c.fillText(title, cx, cy + R * 0.42);
  for (const [v, col, len] of needles) {
    const a = ang(v);
    c.strokeStyle = col;
    c.lineWidth = R * 0.07;
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(cx - Math.cos(a) * R * 0.12, cy - Math.sin(a) * R * 0.12);
    c.lineTo(cx + Math.cos(a) * R * len, cy + Math.sin(a) * R * len);
    c.stroke();
  }
  c.fillStyle = '#2a2b2e';
  c.beginPath();
  c.arc(cx, cy, R * 0.1, 0, 2 * Math.PI);
  c.fill();
  // Glass glint.
  const gr = c.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
  gr.addColorStop(0, 'rgba(255,255,255,0.1)');
  gr.addColorStop(0.45, 'rgba(255,255,255,0)');
  c.fillStyle = gr;
  c.beginPath();
  c.arc(cx, cy, R * 0.9, 0, 2 * Math.PI);
  c.fill();
}

function radio(c: Ctx, x: number, y: number, w: number, h: number, label: string, text: string) {
  c.fillStyle = '#18191b';
  c.fillRect(x, y, w, h);
  c.strokeStyle = '#3a3b3e';
  c.lineWidth = 2;
  c.strokeRect(x + 1, y + 1, w - 2, h - 2);
  c.fillStyle = '#060807';
  c.fillRect(x + w * 0.22, y + h * 0.2, w * 0.56, h * 0.6);
  c.fillStyle = '#6fe28a';
  c.font = `600 ${Math.round(h * 0.4)}px ui-monospace, Menlo, monospace`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(text, x + w * 0.5, y + h * 0.52);
  c.fillStyle = '#9d9a92';
  c.font = `700 ${Math.round(h * 0.24)}px ${FONT}`;
  c.fillText(label, x + w * 0.11, y + h * 0.5);
  for (const k of [0.88, 0.95]) {
    c.fillStyle = '#2c2d30';
    c.beginPath();
    c.arc(x + w * k, y + h * 0.5, h * 0.18, 0, 2 * Math.PI);
    c.fill();
  }
}

/** Draw the whole panel face. */
export function drawB206Panel(c: Ctx, W: number, H: number, r: InstrumentReadings): void {
  const rot = r.rotor;
  // Matte black face with a subtle top-to-bottom sheen and the screw heads.
  const g = c.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#26272a');
  g.addColorStop(1, '#1b1c1e');
  c.fillStyle = g;
  c.fillRect(0, 0, W, H);
  c.fillStyle = '#3a3b3f';
  for (const [x, y] of [[0.01, 0.01], [0.99, 0.01], [0.01, 0.97], [0.99, 0.97], [0.5, 0.01], [0.5, 0.97]]) {
    c.beginPath();
    c.arc(x * W, y * H, 4, 0, 2 * Math.PI);
    c.fill();
  }
  const S = PANEL_SPOTS;
  const at = (s: { x: number; y: number; d: number }) => [px(s.x), py(s.y), s.d * PANEL_PX_PER_M] as const;
  // Flight instruments (the pilot's side).
  drawAirspeed(c, ...at(S.airspeed), r);
  drawAttitude(c, ...at(S.attitude), r);
  drawAltimeter(c, ...at(S.altimeter), r);
  drawTurnCoordinator(c, ...at(S.turn), r);
  drawHeading(c, ...at(S.heading), r);
  drawVsi(c, ...at(S.vsi), r);
  // Rotor and engine instruments.
  const nr = fin(rot?.nrPct, fin(r.rpm) > 0 ? (fin(r.rpm) / 394) * 100 : 0);
  const n2 = fin(rot?.n2Pct, nr);
  const n1 = fin(rot?.n1Pct, r.engineStatus === 'RUNNING' ? 62 + 0.3 * fin(r.throttlePct) : 0);
  const tq = fin(rot?.torquePct, 0);
  dial(c, ...at(S.tach), 0, 120, [
    { from: 95, to: 104, color: '#2fbf57' },
    { from: 85, to: 95, color: '#f4c51c' },
  ], 10, [0, 20, 40, 60, 80, 100, 120], 'NR  N2', [
    [n2, '#f2efe6', 0.66],
    [nr, '#f4c51c', 0.84],
  ], 107);
  dial(c, ...at(S.torque), 0, 120, [
    { from: 0, to: 85, color: '#2fbf57' },
    { from: 85, to: 100, color: '#f4c51c' },
  ], 10, [0, 20, 40, 60, 80, 100, 120], 'TORQUE %', [[tq, '#f2efe6', 0.84]], 100);
  const tot = n1 > 10 ? 380 + 3.6 * tq : 20;
  dial(c, ...at(S.tot), 0, 900, [{ from: 300, to: 738, color: '#2fbf57' }], 100, [0, 3, 6, 9].map((v) => v * 100), 'TOT °C', [[tot, '#f2efe6', 0.84]], 810);
  dial(c, ...at(S.n1), 0, 110, [{ from: 60, to: 105, color: '#2fbf57' }], 10, [0, 50, 100], 'N1 %', [[n1, '#f2efe6', 0.84]], 105);
  dial(c, ...at(S.fuel), 0, 100, [{ from: 0, to: 10, color: '#e2362b' }], 25, [0, 50, 100], 'FUEL', [[64, '#f2efe6', 0.84]]);
  dial(c, ...at(S.oil), 0, 150, [{ from: 50, to: 130, color: '#2fbf57' }], 25, [0, 75, 150], 'OIL PSI', [[n1 > 10 ? 115 : 0, '#f2efe6', 0.84]]);
  // Caution panel along the top middle.
  const lights: Array<[string, boolean, string]> = [
    ['RPM', !!rot?.lowRotorRpm, '#ff3b24'],
    ['ENG OUT', n1 < 50 && nr > 5, '#ff3b24'],
    ['TORQUE', !!rot?.overTorque, '#ffb020'],
    ['SAS', !!rot?.sas, '#3ce36a'],
    ['XMSN OIL', false, '#ffb020'],
    ['FUEL LOW', false, '#ffb020'],
  ];
  const lw = 0.055 * PANEL_PX_PER_M;
  const lh = 0.016 * PANEL_PX_PER_M;
  lights.forEach(([label, on, col], i) => {
    const x = px(-0.2) + i * (lw + 5);
    const y = py(0.012);
    c.fillStyle = on ? col : '#26211d';
    c.fillRect(x, y, lw, lh);
    c.fillStyle = on ? '#1a0c06' : '#5a5046';
    c.font = `700 ${Math.round(lh * 0.62)}px ${FONT}`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(label, x + lw / 2, y + lh / 2 + 1);
  });
  // Radio stack and transponder on the left (the passenger's side).
  const rx = px(-0.47);
  const rw = 0.24 * PANEL_PX_PER_M;
  const rh = 0.038 * PANEL_PX_PER_M;
  radio(c, rx, py(0.05), rw, rh, 'COM', '122.80');
  radio(c, rx, py(0.05) + rh + 6, rw, rh, 'NAV', '113.90');
  radio(c, rx, py(0.05) + 2 * (rh + 6), rw, rh, 'ADF', ' 350 ');
  radio(c, rx, py(0.05) + 3 * (rh + 6), rw, rh, 'XPDR', ' 1200 ');
  // Hour meter.
  c.fillStyle = '#0b0b0c';
  c.fillRect(px(-0.47) + rw + 0.02 * PANEL_PX_PER_M, py(0.235), 0.05 * PANEL_PX_PER_M, 0.016 * PANEL_PX_PER_M);
  c.fillStyle = '#e8e4da';
  c.font = `600 ${Math.round(0.012 * PANEL_PX_PER_M)}px ui-monospace, Menlo, monospace`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText('2461.3', px(-0.47) + rw + 0.045 * PANEL_PX_PER_M, py(0.243));
  // Placards.
  c.fillStyle = '#c9c4b8';
  c.font = `700 ${Math.round(0.011 * PANEL_PX_PER_M)}px ${FONT}`;
  c.textAlign = 'left';
  c.fillText('VNE 130 KIAS SEE PLACARD', px(0.16), py(0.285));
  c.fillText('N206TT', px(-0.47), py(0.285));
}
