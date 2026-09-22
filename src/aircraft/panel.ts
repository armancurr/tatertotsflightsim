/**
 * Instrument panel texture: canvas size, where things sit on it, and a
 * placeholder drawer (six-pack + tach/MP, radios, switches) used until the
 * real gauge renderer is plugged in through `setPanelDrawer`.
 *
 * The canvas maps onto the physical panel face: x 0..width spans body x
 * −PANEL.widthM/2..+PANEL.widthM/2 (left to right as the pilot sees it), y 0..height spans the
 * panel top (y = PANEL.topY) down to its bottom.
 */
import type { InstrumentReadings } from '../types';

export const PANEL = {
  /** Canvas pixels. */
  width: 1536,
  height: 560,
  /** Physical face (m) and placement in the body frame. */
  widthM: 1.02,
  heightM: 0.372,
  centerY: 0.15,
  z: -0.7,
  get topY() {
    return this.centerY + this.heightM / 2;
  },
} as const;

/** Body-frame (x, y) on the panel face → canvas pixel. */
export function panelPx(x: number, y: number): { x: number; y: number } {
  return {
    x: ((x + PANEL.widthM / 2) / PANEL.widthM) * PANEL.width,
    y: ((PANEL.centerY + PANEL.heightM / 2 - y) / PANEL.heightM) * PANEL.height,
  };
}

/**
 * Where the 3D controls come through the panel (canvas px) — a drawer should
 * keep gauges clear of these. The six-pack sits in front of the pilot (eye x = −0.28 m).
 */
/** Panel bottom edge (body y). */
export const PANEL_BOTTOM_Y = PANEL.centerY - PANEL.heightM / 2;

export const PANEL_LAYOUT = {
  sixPack: { cx: panelPx(-0.28, 0).x, row1: panelPx(0, PANEL.topY - 0.07).y, pitch: 137, diameter: 120 },
  yokeShafts: [panelPx(-0.28, PANEL_BOTTOM_Y + 0.055), panelPx(0.28, PANEL_BOTTOM_Y + 0.055)],
  gearLever: panelPx(-0.09, PANEL_BOTTOM_Y + 0.1),
  gearLights: panelPx(-0.045, PANEL_BOTTOM_Y + 0.13),
  engineControls: panelPx(0.045, PANEL_BOTTOM_Y + 0.035),
  flapLever: panelPx(0.2, PANEL_BOTTOM_Y + 0.05),
} as const;

// ─── Placeholder drawer ──────────────────────────────────────────────────────

let bgCache: { canvas: HTMLCanvasElement; w: number; h: number } | null = null;

function dialFace(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  const g = ctx.createRadialGradient(cx, cy - r * 0.3, r * 0.1, cx, cy, r * 1.15);
  g.addColorStop(0, '#3a3c3f');
  g.addColorStop(1, '#101112');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 1.12, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#0b0b0c';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  // Mounting screws.
  ctx.fillStyle = '#55585c';
  for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    ctx.beginPath();
    ctx.arc(cx + dx * r * 0.98, cy + dy * r * 0.98, r * 0.06, 0, Math.PI * 2);
    ctx.fill();
  }
}

function ticks(
  ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number,
  a0: number, a1: number, n: number, major: number, labels?: (i: number) => string,
) {
  ctx.strokeStyle = '#e8e8e2';
  ctx.fillStyle = '#e8e8e2';
  ctx.font = `600 ${Math.round(r * 0.2)}px Helvetica, Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    const big = i % major === 0;
    ctx.lineWidth = big ? r * 0.035 : r * 0.02;
    const r0 = big ? r * 0.8 : r * 0.87;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    ctx.lineTo(cx + Math.cos(a) * r * 0.95, cy + Math.sin(a) * r * 0.95);
    ctx.stroke();
    if (big && labels) ctx.fillText(labels(i / major), cx + Math.cos(a) * r * 0.62, cy + Math.sin(a) * r * 0.62);
  }
}

function arc(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, a0: number, a1: number, color: string, w: number) {
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.beginPath();
  ctx.arc(cx, cy, r, a0, a1);
  ctx.stroke();
}

function needle(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, a: number, len = 0.85, w = 0.05, color = '#f4f4ee') {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(a);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(-r * 0.15, -r * w);
  ctx.lineTo(r * len, -r * w * 0.35);
  ctx.lineTo(r * (len + 0.04), 0);
  ctx.lineTo(r * len, r * w * 0.35);
  ctx.lineTo(-r * 0.15, r * w);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#222';
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.08, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color = '#d8d8d0') {
  ctx.fillStyle = color;
  ctx.font = `600 ${size}px Helvetica, Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
}

const DEG = Math.PI / 180;
/** ASI: 0 kt at the top-left, 200 kt most of the way round. */
const asiAngle = (kt: number) => -Math.PI / 2 + (Math.max(0, Math.min(200, kt)) / 200) * 1.75 * Math.PI - 0.12 * Math.PI;

function drawBackground(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  const sx = w / PANEL.width;
  ctx.scale(sx, sx);
  const W = PANEL.width;
  const H = PANEL.height;
  // Panel: dark grey, slight texture gradient.
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#3b3e42');
  g.addColorStop(1, '#2a2c2f');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // Centre radio stack.
  const rx = 700;
  ctx.fillStyle = '#18191b';
  ctx.fillRect(rx, 20, 300, 420);
  const radios = ['COM1 118.300  121.500', 'NAV1 110.50  113.90', 'COM2 122.800  119.100', 'NAV2 108.20  117.00', 'XPDR  1200   ALT'];
  radios.forEach((t, i) => {
    const y = 40 + i * 78;
    ctx.fillStyle = '#26282b';
    ctx.fillRect(rx + 10, y, 280, 64);
    ctx.fillStyle = '#050605';
    ctx.fillRect(rx + 22, y + 14, 200, 34);
    ctx.fillStyle = '#50e070';
    ctx.font = '600 20px "Courier New", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(t, rx + 28, y + 31);
    ctx.fillStyle = '#5a5d61';
    ctx.beginPath();
    ctx.arc(rx + 252, y + 32, 18, 0, Math.PI * 2);
    ctx.fill();
  });
  // Right side: engine gauges cluster and glovebox.
  ctx.fillStyle = '#34373b';
  ctx.fillRect(1060, 300, 440, 220);
  ctx.strokeStyle = '#1d1f21';
  ctx.lineWidth = 3;
  ctx.strokeRect(1060, 300, 440, 220);
  label(ctx, 'CESSNA', 1280, 410, 26, '#6d7176');
  // Switch row (master, avionics, lights) bottom left.
  const sw = ['BAT', 'ALT', 'BCN', 'LAND', 'TAXI', 'NAV', 'STRB', 'PITOT'];
  sw.forEach((t, i) => {
    const x = 40 + i * 58;
    ctx.fillStyle = '#111';
    ctx.fillRect(x, 470, 34, 56);
    ctx.fillStyle = i < 2 ? '#b8242a' : '#e4e4de';
    ctx.fillRect(x + 5, 476, 24, 26);
    label(ctx, t, x + 17, 540, 14);
  });
  // Gear panel placard next to the lever.
  const gl = PANEL_LAYOUT.gearLever;
  ctx.fillStyle = '#1b1c1e';
  ctx.fillRect(gl.x - 34, gl.y - 90, 68, 180);
  label(ctx, 'GEAR', gl.x, gl.y - 100, 16);
  label(ctx, 'UP', gl.x + 50, gl.y - 60, 14);
  label(ctx, 'DOWN', gl.x + 54, gl.y + 60, 14);
  return c;
}

/** Placeholder instrument drawer: readable six-pack, tachometer and manifold pressure. */
export function drawPlaceholderPanel(ctx: CanvasRenderingContext2D, w: number, h: number, r: InstrumentReadings) {
  if (typeof document !== 'undefined') {
    if (!bgCache || bgCache.w !== w || bgCache.h !== h) bgCache = { canvas: drawBackground(w, h), w, h };
    ctx.drawImage(bgCache.canvas, 0, 0);
  } else {
    ctx.fillStyle = '#333';
    ctx.fillRect(0, 0, w, h);
  }
  const s = w / PANEL.width;
  ctx.save();
  ctx.scale(s, s);
  const L = PANEL_LAYOUT.sixPack;
  const rad = L.diameter / 2;
  const cols = [L.cx - L.pitch, L.cx, L.cx + L.pitch];
  const rows = [L.row1, L.row1 + L.pitch];

  // Airspeed.
  {
    const [cx, cy] = [cols[0], rows[0]];
    dialFace(ctx, cx, cy, rad);
    arc(ctx, cx, cy, rad * 0.9, asiAngle(40), asiAngle(85), '#f2f2f2', rad * 0.08);
    arc(ctx, cx, cy, rad * 0.95, asiAngle(50), asiAngle(129), '#2fbf4a', rad * 0.08);
    arc(ctx, cx, cy, rad * 0.95, asiAngle(129), asiAngle(163), '#e8c630', rad * 0.08);
    ticks(ctx, cx, cy, rad, asiAngle(0), asiAngle(200), 20, 4, (i) => String(i * 40));
    label(ctx, 'KNOTS', cx, cy + rad * 0.35, rad * 0.14);
    needle(ctx, cx, cy, rad, asiAngle(r.airspeedKt));
  }
  // Attitude.
  {
    const [cx, cy] = [cols[1], rows[0]];
    dialFace(ctx, cx, cy, rad);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, rad * 0.94, 0, Math.PI * 2);
    ctx.clip();
    ctx.translate(cx, cy);
    ctx.rotate(-r.rollDeg * DEG);
    const off = Math.max(-40, Math.min(40, r.pitchDeg)) * rad * 0.022;
    ctx.fillStyle = '#2f7fd1';
    ctx.fillRect(-rad * 2, -rad * 2 + off, rad * 4, rad * 2);
    ctx.fillStyle = '#8a5a2b';
    ctx.fillRect(-rad * 2, off, rad * 4, rad * 2);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-rad * 2, off);
    ctx.lineTo(rad * 2, off);
    ctx.stroke();
    for (const p of [-20, -10, 10, 20]) {
      const y = off - p * rad * 0.022;
      const hw = p % 20 === 0 ? rad * 0.3 : rad * 0.16;
      ctx.beginPath();
      ctx.moveTo(-hw, y);
      ctx.lineTo(hw, y);
      ctx.stroke();
    }
    ctx.restore();
    // Bank scale and fixed aircraft symbol.
    ticks(ctx, cx, cy, rad * 0.98, -Math.PI / 2 - Math.PI / 3, -Math.PI / 2 + Math.PI / 3, 6, 3);
    ctx.strokeStyle = '#f0a020';
    ctx.lineWidth = rad * 0.06;
    ctx.beginPath();
    ctx.moveTo(cx - rad * 0.5, cy);
    ctx.lineTo(cx - rad * 0.15, cy);
    ctx.lineTo(cx, cy + rad * 0.1);
    ctx.lineTo(cx + rad * 0.15, cy);
    ctx.lineTo(cx + rad * 0.5, cy);
    ctx.stroke();
  }
  // Altimeter.
  {
    const [cx, cy] = [cols[2], rows[0]];
    dialFace(ctx, cx, cy, rad);
    ticks(ctx, cx, cy, rad, -Math.PI / 2, (3 * Math.PI) / 2, 50, 5, (i) => (i < 10 ? String(i) : ''));
    const alt = Math.max(0, r.altitudeFt);
    needle(ctx, cx, cy, rad, -Math.PI / 2 + ((alt % 10000) / 10000) * Math.PI * 2, 0.45, 0.08);
    needle(ctx, cx, cy, rad, -Math.PI / 2 + ((alt % 1000) / 1000) * Math.PI * 2, 0.82, 0.045);
    label(ctx, '29.92', cx + rad * 0.45, cy, rad * 0.13, '#bbb');
  }
  // Turn coordinator.
  {
    const [cx, cy] = [cols[0], rows[1]];
    dialFace(ctx, cx, cy, rad);
    label(ctx, 'L', cx - rad * 0.75, cy + rad * 0.35, rad * 0.17);
    label(ctx, 'R', cx + rad * 0.75, cy + rad * 0.35, rad * 0.17);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(Math.max(-30, Math.min(30, (r.turnRateDegPerSec / 3) * 15)) * DEG);
    ctx.strokeStyle = '#f4f4ee';
    ctx.lineWidth = rad * 0.07;
    ctx.beginPath();
    ctx.moveTo(-rad * 0.62, 0);
    ctx.lineTo(rad * 0.62, 0);
    ctx.moveTo(0, -rad * 0.14);
    ctx.lineTo(0, rad * 0.1);
    ctx.stroke();
    ctx.restore();
    // Inclinometer.
    ctx.fillStyle = '#e8e2c8';
    ctx.fillRect(cx - rad * 0.45, cy + rad * 0.48, rad * 0.9, rad * 0.2);
    ctx.fillStyle = '#111';
    ctx.beginPath();
    ctx.arc(cx + Math.max(-1, Math.min(1, r.slipSkid)) * rad * 0.35, cy + rad * 0.58, rad * 0.085, 0, Math.PI * 2);
    ctx.fill();
  }
  // Heading indicator.
  {
    const [cx, cy] = [cols[1], rows[1]];
    dialFace(ctx, cx, cy, rad);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-r.headingDeg * DEG);
    ctx.strokeStyle = '#eee';
    ctx.fillStyle = '#eee';
    ctx.font = `700 ${Math.round(rad * 0.2)}px Helvetica, Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let d = 0; d < 360; d += 5) {
      const a = d * DEG - Math.PI / 2;
      const big = d % 30 === 0;
      ctx.lineWidth = big ? 2.5 : 1.5;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * rad * (big ? 0.78 : 0.85), Math.sin(a) * rad * (big ? 0.78 : 0.85));
      ctx.lineTo(Math.cos(a) * rad * 0.94, Math.sin(a) * rad * 0.94);
      ctx.stroke();
      if (big) {
        const t = d === 0 ? 'N' : d === 90 ? 'E' : d === 180 ? 'S' : d === 270 ? 'W' : String(d / 10);
        ctx.save();
        ctx.translate(Math.cos(a) * rad * 0.6, Math.sin(a) * rad * 0.6);
        ctx.rotate(d * DEG);
        ctx.fillText(t, 0, 0);
        ctx.restore();
      }
    }
    ctx.restore();
    ctx.fillStyle = '#f0a020';
    ctx.beginPath();
    ctx.moveTo(cx, cy - rad * 0.95);
    ctx.lineTo(cx - rad * 0.07, cy - rad * 0.8);
    ctx.lineTo(cx + rad * 0.07, cy - rad * 0.8);
    ctx.fill();
  }
  // Vertical speed.
  {
    const [cx, cy] = [cols[2], rows[1]];
    dialFace(ctx, cx, cy, rad);
    const vsA = (fpm: number) => Math.PI + (Math.max(-2000, Math.min(2000, fpm)) / 2000) * Math.PI * 0.9;
    ticks(ctx, cx, cy, rad, vsA(-2000), vsA(2000), 20, 5, (i) => String(Math.abs(i * 5 - 10)));
    label(ctx, 'VERT SPEED', cx + rad * 0.2, cy - rad * 0.35, rad * 0.11);
    needle(ctx, cx, cy, rad, vsA(r.verticalSpeedFpm));
  }
  // Manifold pressure + tachometer column.
  {
    const cx = cols[2] + L.pitch;
    const rs = rad * 0.8;
    dialFace(ctx, cx, rows[0], rs);
    const mpA = (inHg: number) => Math.PI * 0.75 + ((Math.max(10, Math.min(35, inHg)) - 10) / 25) * Math.PI * 1.5;
    arc(ctx, cx, rows[0], rs * 0.93, mpA(15), mpA(25), '#2fbf4a', rs * 0.08);
    ticks(ctx, cx, rows[0], rs, mpA(10), mpA(35), 25, 5, (i) => String(10 + i * 5));
    label(ctx, 'MAN PRESS', cx, rows[0] + rs * 0.45, rs * 0.13);
    const mp = 10 + (r.throttlePct / 100) * 19 * (r.engineStatus === 'RUNNING' ? 1 : 0) + (r.engineStatus === 'RUNNING' ? 0 : 19.9);
    needle(ctx, cx, rows[0], rs, mpA(mp));
    dialFace(ctx, cx, rows[1], rs);
    const tA = (rpm: number) => Math.PI * 0.75 + (Math.max(0, Math.min(3500, rpm)) / 3500) * Math.PI * 1.5;
    arc(ctx, cx, rows[1], rs * 0.93, tA(2100), tA(2700), '#2fbf4a', rs * 0.08);
    arc(ctx, cx, rows[1], rs * 0.93, tA(2700), tA(2760), '#e02020', rs * 0.08);
    ticks(ctx, cx, rows[1], rs, tA(0), tA(3500), 35, 5, (i) => String(i * 5));
    label(ctx, 'RPM', cx, rows[1] + rs * 0.42, rs * 0.14);
    label(ctx, String(Math.round(r.rpm / 10) * 10).padStart(4, '0'), cx, rows[1] + rs * 0.62, rs * 0.14, '#9fe8a0');
    needle(ctx, cx, rows[1], rs, tA(r.rpm));
  }
  // Clock / suction (left column).
  {
    const cx = cols[0] - L.pitch * 0.9;
    const rs = rad * 0.62;
    dialFace(ctx, cx, rows[0], rs);
    ticks(ctx, cx, rows[0], rs, -Math.PI / 2, Math.PI * 1.5, 12, 3);
    dialFace(ctx, cx, rows[1], rs);
    label(ctx, 'SUCTION', cx, rows[1] + rs * 0.4, rs * 0.16);
    needle(ctx, cx, rows[1], rs, -Math.PI / 2 + 0.2, 0.8, 0.06);
  }
  // Stall warning / low voltage annunciators.
  label(ctx, 'STALL', cols[1], rows[1] + rad + 30, 16, r.stallWarning ? '#ff4a3a' : '#555');
  ctx.restore();
}
