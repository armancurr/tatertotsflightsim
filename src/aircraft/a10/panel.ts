/**
 * A-10C instrument panel, consoles and displays, painted in code (no three.js here — pure canvas
 * painting + gauge maths, so tests can fuzz it with a recording context).
 *
 * Two canvases:
 *  - the PANEL canvas (lit, 1024 × 1024): the front dash (top half: armament HUD control panel,
 *    UFC keypad, standby/flight instruments, engine instruments, fuel, gear and flap panel) and
 *    the two console tops (bottom half, rotated so the text reads from the seat);
 *  - the SCREENS canvas (unlit, 1024 × 640): the two 5 × 5" MFCD pages (TAD moving map, TGP video
 *    or DSMS stores page), the lamp faces (gear, master caution, GUN READY, AOA and refuel
 *    indexers…) and the CDU display.
 *
 * Layout (metres, "panel coordinates": x right, y up, from the panel centre) is shared with the
 * geometry (cockpit.ts) so the 3D bezels, keys and handles sit on the painted art.
 */
import type { InstrumentReadings } from '../../types';

// ─── Layout ──────────────────────────────────────────────────────────────────

/** Front dash size (m). The geometry places it (cockpit.ts PANEL). */
export const DASH = { w: 0.9, h: 0.46 } as const;

/** MFCDs: 5 × 5" (0.127 m) active area in a 0.2 m bezel with 20 option-select buttons. */
export const MFCD = { x: 0.235, y: -0.075, bezel: 0.2, screen: 0.127 } as const;
/** Up-front controller (keypad) directly under the HUD. */
export const UFC = { x: 0, y: 0.118, w: 0.2, h: 0.17 } as const;
/** Armament HUD control panel (top left): the arming toggles. */
export const AHCP = { x: -0.27, y: 0.168, w: 0.3, h: 0.096 } as const;
/** The AHCP switches: label, positions (top → bottom), which one is selected (0 = up). */
export const AHCP_SWITCHES: readonly { name: string; pos: readonly string[]; sel: number }[] = [
  { name: 'MASTER', pos: ['TRAIN', 'SAFE', 'ARM'], sel: 2 },
  { name: 'GUN/PAC', pos: ['ARM', 'SAFE', 'GUN'], sel: 0 },
  { name: 'LASER', pos: ['ARM', 'SAFE', 'TRAIN'], sel: 0 },
  { name: 'TGP', pos: ['ON', 'OFF'], sel: 0 },
  { name: 'ALT SCE', pos: ['BARO', 'DELTA', 'RADAR'], sel: 2 },
  { name: 'HUD', pos: ['DAY', 'NIGHT'], sel: 0 },
  { name: 'CICU', pos: ['ON', 'OFF'], sel: 0 },
  { name: 'JTRS', pos: ['ON', 'OFF'], sel: 0 },
  { name: 'IFFCC', pos: ['ON', 'TEST', 'OFF'], sel: 0 },
];
/** x of AHCP switch k (panel coords). */
export const ahcpX = (k: number): number => AHCP.x - AHCP.w / 2 + 0.02 + (k * (AHCP.w - 0.04)) / (AHCP_SWITCHES.length - 1);

/** Round instruments (centre x, y and face radius, m). */
export const GAUGE = {
  adi: { x: 0, y: -0.047, r: 0.042 },
  hsi: { x: 0, y: -0.163, r: 0.046 },
  asi: { x: -0.098, y: -0.03, r: 0.027 },
  aoa: { x: -0.098, y: -0.117, r: 0.023 },
  alt: { x: 0.098, y: -0.03, r: 0.027 },
  vvi: { x: 0.098, y: -0.117, r: 0.023 },
  sai: { x: 0.19, y: 0.122, r: 0.04 },
  accel: { x: 0.283, y: 0.15, r: 0.024 },
  clock: { x: 0.283, y: 0.083, r: 0.021 },
  flaps: { x: -0.395, y: -0.182, r: 0.026 },
  fuel: { x: 0.395, y: -0.165, r: 0.04 },
} as const;
/** Engine instruments: two columns (left / right TF34) × rows. */
export const ENGINE = { x0: 0.366, x1: 0.419, y0: 0.195, dy: -0.05, r: 0.02, rows: ['FAN', 'ITT', 'CORE', 'FF', 'OIL'] as const } as const;
/** Landing gear panel: the handle and the three position lights (NOSE / LEFT / RIGHT). */
export const GEAR = { handleX: -0.395, handleY: -0.075, lights: [[-0.395, 0.045], [-0.422, 0.012], [-0.368, 0.012]] as readonly (readonly [number, number])[] } as const;

/** Console tops (body frame): y, inboard/outboard |x|, front/back z. */
export const CONSOLE = { y: 0.575, xIn: 0.3, xOut: 0.475, zFront: -4.98, zBack: -3.78 } as const;

// ─── Canvases ────────────────────────────────────────────────────────────────

export const PANEL_CANVAS = { width: 1024, height: 1024 } as const;
export const SCREEN_CANVAS = { width: 1024, height: 640 } as const;
/** Console strips on the panel canvas (rows): left and right, each 1024 × CONSOLE_PX. */
export const CONSOLE_PX = 150;
export const CONSOLE_ROW = { left: 520, right: 690 } as const;

/** Lamp faces on the screens canvas: 64-px cells (row 0: y 512–576; row 1: y 576–640, from x 256). */
export const LAMP = {
  gearNose: 0,
  gearLeft: 1,
  gearRight: 2,
  gearHandle: 3,
  masterCaution: 4,
  gunReady: 5,
  aoaHigh: 6,
  aoaOn: 7,
  aoaLow: 8,
  refuelReady: 9,
  refuelLatched: 10,
  refuelDisc: 11,
  canopy: 12,
  nws: 13,
  marker: 14,
  fireL: 15,
  fireApu: 16,
  fireR: 17,
} as const;
export type LampId = keyof typeof LAMP;
export const LAMP_COUNT = 18;

/** Pixel rect of lamp cell i on the screens canvas (inset by 4 px for mip bleed). */
export function lampCell(i: number): { x: number; y: number; w: number; h: number } {
  const row0 = i < 16;
  const x = row0 ? i * 64 : 256 + (i - 16) * 64;
  const y = row0 ? 512 : 576;
  return { x: x + 4, y: y + 4, w: 56, h: 56 };
}
/** The CDU display on the screens canvas. */
export const CDU_RECT = { x: 4, y: 580, w: 248, h: 56 } as const;

// ─── Gauge values (pure) ─────────────────────────────────────────────────────

const fin = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const wrap360 = (d: number): number => ((d % 360) + 360) % 360;

export interface A10Gauges {
  iasKt: number;
  altFt: number;
  vviFpm: number;
  aoaUnits: number;
  pitchDeg: number;
  rollDeg: number;
  headingDeg: number;
  g: number;
  fanPct: number;
  corePct: number;
  ittC: number;
  ffPph: number;
  oilPsi: number;
  flapsDeg: number;
  fuelLb: number;
  clockS: number;
  gear: 'down' | 'up' | 'transit';
  running: boolean;
}

/** Instrument values from the readings: finite and inside each dial's range whatever comes in. */
export function a10Gauges(r: InstrumentReadings | null, timeS = 0): A10Gauges {
  const x = r ?? null;
  const running = x?.engineStatus === 'RUNNING' || x?.engineStatus === 'STARTING';
  const core = clamp(fin(x?.rpm), 0, 104);
  const thr = clamp(fin(x?.throttlePct), 0, 100) / 100;
  // TF34-GE-100A: fan speed trails the core (idle core ≈ 56 %, fan ≈ 28 %; max ≈ 90 / 82 %).
  const fan = core <= 0 ? 0 : clamp(core < 50 ? core * 0.4 : 20 + (core - 50) * 1.4, 0, 100);
  const gear = x?.gear === 'up' || x?.gear === 'transit' ? x.gear : 'down';
  return {
    iasKt: clamp(fin(x?.airspeedKt), 0, 550),
    altFt: clamp(fin(x?.altitudeFt), -2000, 60000),
    vviFpm: clamp(fin(x?.verticalSpeedFpm), -6000, 6000),
    aoaUnits: clamp(fin(x?.aoaDeg) * 1.1 + 2, 0, 30),
    pitchDeg: clamp(fin(x?.pitchDeg), -90, 90),
    rollDeg: clamp(((fin(x?.rollDeg) + 180) % 360 + 360) % 360 - 180, -180, 180),
    headingDeg: wrap360(fin(x?.headingDeg)),
    g: clamp(fin(x?.gLoad, 1), -5, 10),
    fanPct: fan,
    corePct: core,
    ittC: running ? clamp(420 + thr * 430 + (core - 60) * 1.5, 100, 1100) : clamp(core * 3, 0, 1100),
    ffPph: running ? clamp(480 + thr * 2400, 0, 5000) : 0,
    oilPsi: running ? clamp(30 + core * 0.2, 0, 100) : clamp(core * 0.4, 0, 100),
    flapsDeg: clamp(fin(x?.flapsDeg), 0, 20),
    fuelLb: 7600,
    clockS: fin(timeS) + 11 * 3600 + 23 * 60,
    gear,
    running,
  };
}

export type LampStates = Record<LampId, boolean>;

/** Which lamps are lit (the gear lights follow the gear; the AOA indexer shows with the gear down). */
export function a10Lamps(r: InstrumentReadings | null): LampStates {
  const gear = r?.gear ?? 'down';
  const down = gear === 'down';
  const aoa = fin(r?.aoaDeg);
  const air = r?.state === 'airborne' || r?.state === 'stalled';
  const indexer = down && air;
  return {
    gearNose: down,
    gearLeft: down,
    gearRight: down,
    gearHandle: gear === 'transit',
    masterCaution: r?.stallWarning === true || r?.overspeed === true,
    gunReady: r?.engineStatus === 'RUNNING',
    aoaHigh: indexer && aoa > 10.5,
    aoaOn: indexer && aoa >= 6.5 && aoa <= 11.5,
    aoaLow: indexer && aoa < 7.5,
    refuelReady: false,
    refuelLatched: false,
    refuelDisc: false,
    canopy: false,
    nws: r?.state === 'ground' || r?.state === 'landed',
    marker: false,
    fireL: false,
    fireApu: false,
    fireR: false,
  };
}

// ─── Painting helpers ────────────────────────────────────────────────────────

type Ctx = CanvasRenderingContext2D;
const SX = 1024 / DASH.w;
const SY = 512 / DASH.h;
/** Panel coords (m) → canvas px on the dash region. */
const PX = (x: number): number => (x + DASH.w / 2) * SX;
const PY = (y: number): number => (DASH.h / 2 - y) * SY;
const R = (r: number): number => r * SX;
const DEG = Math.PI / 180;

const COL = {
  panel: '#5a636a',
  sub: '#5f686f',
  subEdge: '#434a50',
  seam: '#3c4247',
  text: '#eef0ea',
  dim: '#c9ccc4',
  face: '#0d0e10',
  bezel: '#1b1d1f',
  tick: '#f2f2ea',
  needle: '#f4f4ee',
  green: '#61e57e',
  amber: '#f0a830',
  red: '#e0321e',
  key: '#3b4146',
  keyTop: '#4a5157',
} as const;

function text(ctx: Ctx, t: string, x: number, y: number, size: number, color: string = COL.text, align: CanvasTextAlign = 'center', weight = 'bold'): void {
  ctx.fillStyle = color;
  ctx.font = `${weight} ${size}px Arial, Helvetica, sans-serif`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillText(t, x, y);
}

function screw(ctx: Ctx, x: number, y: number): void {
  ctx.fillStyle = '#80888e';
  ctx.beginPath();
  ctx.arc(x, y, 2.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#3a3f43';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x - 2, y - 1);
  ctx.lineTo(x + 2, y + 1);
  ctx.stroke();
}

/** A sub-panel (rect in panel metres) with an edge, a subtle top light and corner screws. */
function subPanel(ctx: Ctx, x: number, y: number, w: number, h: number, fill: string = COL.sub): void {
  const a = PX(x - w / 2);
  const b = PY(y + h / 2);
  const ww = w * SX;
  const hh = h * SY;
  ctx.fillStyle = fill;
  ctx.fillRect(a, b, ww, hh);
  const g = ctx.createLinearGradient(0, b, 0, b + hh);
  g.addColorStop(0, 'rgba(255,255,255,0.06)');
  g.addColorStop(1, 'rgba(0,0,0,0.08)');
  ctx.fillStyle = g;
  ctx.fillRect(a, b, ww, hh);
  ctx.strokeStyle = COL.subEdge;
  ctx.lineWidth = 2;
  ctx.strokeRect(a + 1, b + 1, ww - 2, hh - 2);
  for (const [sx, sy] of [[a + 6, b + 6], [a + ww - 6, b + 6], [a + 6, b + hh - 6], [a + ww - 6, b + hh - 6]]) screw(ctx, sx, sy);
}

/** Dial scale: ticks + numbers between angles a0..a1 (canvas radians, clockwise from +x). */
function scale(ctx: Ctx, cx: number, cy: number, rp: number, a0: number, a1: number, majors: number, minorsPer: number, labels: readonly string[] | null, fontPx: number): void {
  ctx.strokeStyle = COL.tick;
  const n = majors * minorsPer;
  for (let k = 0; k <= n; k++) {
    const t = a0 + ((a1 - a0) * k) / n;
    const major = k % minorsPer === 0;
    ctx.lineWidth = major ? 2 : 1;
    const r0 = rp * (major ? 0.74 : 0.84);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(t) * r0, cy + Math.sin(t) * r0);
    ctx.lineTo(cx + Math.cos(t) * rp * 0.95, cy + Math.sin(t) * rp * 0.95);
    ctx.stroke();
    if (major && labels) {
      const lab = labels[k / minorsPer];
      if (lab) text(ctx, lab, cx + Math.cos(t) * rp * 0.55, cy + Math.sin(t) * rp * 0.55, fontPx, COL.tick);
    }
  }
}

function dialFace(ctx: Ctx, cx: number, cy: number, rp: number): void {
  ctx.fillStyle = COL.bezel;
  ctx.beginPath();
  ctx.arc(cx, cy, rp * 1.16, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = COL.face;
  ctx.beginPath();
  ctx.arc(cx, cy, rp, 0, Math.PI * 2);
  ctx.fill();
}

function needle(ctx: Ctx, cx: number, cy: number, rp: number, a: number, len = 0.86, width = 2.6, color: string = COL.needle): void {
  const t = fin(a);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - Math.cos(t) * rp * 0.18, cy - Math.sin(t) * rp * 0.18);
  ctx.lineTo(cx + Math.cos(t) * rp * len, cy + Math.sin(t) * rp * len);
  ctx.stroke();
  ctx.lineCap = 'butt';
  ctx.fillStyle = '#26292c';
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(1.5, rp * 0.1), 0, Math.PI * 2);
  ctx.fill();
}

/** Standard dial sweep: 7 o'clock → 5 o'clock (canvas radians). */
const SWEEP0 = 125 * DEG;
const SWEEP1 = 415 * DEG;
const sweep = (t: number): number => SWEEP0 + (SWEEP1 - SWEEP0) * clamp(fin(t), 0, 1);

// ─── Front dash: static art ──────────────────────────────────────────────────

/** Paint everything on the dash that does not move (canvas rows 0–512). */
export function drawDashBackground(ctx: Ctx): void {
  ctx.fillStyle = COL.panel;
  ctx.fillRect(0, 0, 1024, 512);
  // Panel seams (the dash is several removable panels).
  ctx.strokeStyle = COL.seam;
  ctx.lineWidth = 2;
  for (const x of [-0.345, 0.345]) {
    ctx.beginPath();
    ctx.moveTo(PX(x), 0);
    ctx.lineTo(PX(x), 512);
    ctx.stroke();
  }
  // AHCP.
  subPanel(ctx, AHCP.x, AHCP.y, AHCP.w, AHCP.h);
  text(ctx, 'ARMAMENT  HUD  CONTROL', PX(AHCP.x), PY(AHCP.y + AHCP.h / 2 - 0.009), 8, COL.dim);
  AHCP_SWITCHES.forEach((s, k) => {
    const x = PX(ahcpX(k));
    text(ctx, s.name, x, PY(AHCP.y + 0.027), 7.5, COL.text);
    s.pos.forEach((p, j) => text(ctx, p, x, PY(AHCP.y + 0.009 - j * 0.013), 6.5, COL.dim, 'center', 'normal'));
    // Switch boss (the 3D bat stands on it).
    ctx.fillStyle = '#2d3135';
    ctx.beginPath();
    ctx.arc(x, PY(AHCP.y - 0.03), 5, 0, Math.PI * 2);
    ctx.fill();
  });
  // UFC: keypad (painted keys with legends; the 3D surround frames it).
  subPanel(ctx, UFC.x, UFC.y, UFC.w, UFC.h, '#50585e');
  const keys = [
    ['1', '2', '3', 'HACK', 'FUNC'],
    ['4', '5', '6', 'LTR', 'SPC'],
    ['7', '8', '9', 'MK', 'CLR'],
    ['ALT', '0', 'MW', 'ENT', 'TOGL'],
  ];
  keys.forEach((row, i) =>
    row.forEach((k, j) => {
      const x = UFC.x - 0.078 + j * 0.039;
      const y = UFC.y + 0.03 - i * 0.03;
      const a = PX(x - 0.016);
      const b = PY(y + 0.011);
      ctx.fillStyle = '#23272a';
      ctx.fillRect(a - 1, b - 1, 0.032 * SX + 2, 0.022 * SY + 2);
      ctx.fillStyle = COL.keyTop;
      ctx.fillRect(a, b, 0.032 * SX, 0.022 * SY);
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(a, b, 0.032 * SX, 4);
      text(ctx, k, PX(x), PY(y), k.length > 2 ? 7 : 10, COL.text);
    }),
  );
  // Rockers along the top of the UFC (DATA / SEL / DEPR / INTEN).
  ['DATA', 'SEL', 'DEPR', 'INTEN', 'STEER'].forEach((t, j) => {
    const x = UFC.x - 0.078 + j * 0.039;
    ctx.fillStyle = '#2a2e32';
    ctx.fillRect(PX(x - 0.012), PY(UFC.y + 0.072), 0.024 * SX, 0.012 * SY);
    text(ctx, t, PX(x), PY(UFC.y + 0.053), 6.5, COL.dim);
  });
  // Flight instruments: sub-panel between the MFCDs.
  subPanel(ctx, 0, -0.1, 0.26, 0.26, '#565f66');
  subPanel(ctx, 0.235, 0.12, 0.2, 0.11, '#565f66');
  // Engine instruments.
  subPanel(ctx, (ENGINE.x0 + ENGINE.x1) / 2, 0.1, 0.11, 0.26);
  text(ctx, 'ENGINE', PX((ENGINE.x0 + ENGINE.x1) / 2), PY(0.225), 7.5, COL.dim);
  // Gear / flap panel, fuel.
  subPanel(ctx, -0.395, -0.07, 0.1, 0.3);
  text(ctx, 'LANDING GEAR', PX(-0.395), PY(0.07), 6.5, COL.dim);
  text(ctx, 'DN', PX(-0.36), PY(-0.045), 7, COL.text);
  text(ctx, 'UP', PX(-0.36), PY(-0.11), 7, COL.text);
  text(ctx, 'NOSE', PX(GEAR.lights[0][0]), PY(GEAR.lights[0][1] + 0.02), 6, COL.dim);
  text(ctx, 'L', PX(GEAR.lights[1][0]), PY(GEAR.lights[1][1] - 0.019), 6, COL.dim);
  text(ctx, 'R', PX(GEAR.lights[2][0]), PY(GEAR.lights[2][1] - 0.019), 6, COL.dim);
  subPanel(ctx, 0.395, -0.165, 0.1, 0.12);
  // Warning / caution legends printed on the dash.
  text(ctx, 'FLAP POS', PX(GAUGE.flaps.x), PY(GAUGE.flaps.y + GAUGE.flaps.r + 0.012), 6.5, COL.dim);

  // Dial scales.
  const g = GAUGE;
  const d = (k: keyof typeof GAUGE) => ({ x: PX(g[k].x), y: PY(g[k].y), r: R(g[k].r) });
  {
    const a = d('asi');
    dialFace(ctx, a.x, a.y, a.r);
    scale(ctx, a.x, a.y, a.r, SWEEP0, SWEEP1, 10, 5, ['0', '', '100', '', '200', '', '300', '', '400', '', '500'], 7);
    text(ctx, 'KNOTS', a.x, a.y + a.r * 0.35, 5.5, COL.dim);
  }
  {
    const a = d('alt');
    dialFace(ctx, a.x, a.y, a.r);
    scale(ctx, a.x, a.y, a.r, -Math.PI / 2, (3 * Math.PI) / 2, 10, 5, ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', ''], 8);
  }
  {
    const a = d('vvi');
    dialFace(ctx, a.x, a.y, a.r);
    scale(ctx, a.x, a.y, a.r, Math.PI - 170 * DEG, Math.PI + 170 * DEG, 4, 3, ['6', '2', '0', '2', '6'], 7);
    text(ctx, 'VVI', a.x + a.r * 0.35, a.y, 5.5, COL.dim);
  }
  {
    const a = d('aoa');
    dialFace(ctx, a.x, a.y, a.r);
    scale(ctx, a.x, a.y, a.r, SWEEP0, SWEEP1, 6, 5, ['0', '5', '10', '15', '20', '25', '30'], 6);
    text(ctx, 'AOA', a.x, a.y + a.r * 0.4, 5.5, COL.dim);
  }
  {
    const a = d('accel');
    dialFace(ctx, a.x, a.y, a.r);
    scale(ctx, a.x, a.y, a.r, SWEEP0, SWEEP1, 3, 5, ['-5', '0', '5', '10'], 7);
    text(ctx, 'G', a.x, a.y + a.r * 0.4, 6, COL.dim);
  }
  {
    const a = d('clock');
    dialFace(ctx, a.x, a.y, a.r);
    scale(ctx, a.x, a.y, a.r, -Math.PI / 2, (3 * Math.PI) / 2, 12, 1, null, 6);
  }
  {
    const a = d('flaps');
    dialFace(ctx, a.x, a.y, a.r);
    scale(ctx, a.x, a.y, a.r, -150 * DEG, -30 * DEG + 0.0001, 4, 1, ['0', '5', '10', '15', '20'], 6.5);
  }
  {
    const a = d('fuel');
    dialFace(ctx, a.x, a.y, a.r);
    scale(ctx, a.x, a.y, a.r, SWEEP0, SWEEP1, 6, 2, ['0', '1', '2', '3', '4', '5', '6'], 7);
    text(ctx, 'FUEL QTY', a.x, a.y - a.r * 0.32, 5.5, COL.dim);
    text(ctx, 'LB × 1000', a.x, a.y + a.r * 0.62, 5, COL.dim);
    text(ctx, 'FUEL', PX(0.395), PY(-0.113), 7, COL.dim);
  }
  ENGINE.rows.forEach((name, i) => {
    const y = PY(ENGINE.y0 + i * ENGINE.dy);
    for (const x of [ENGINE.x0, ENGINE.x1]) {
      const cx = PX(x);
      dialFace(ctx, cx, y, R(ENGINE.r));
      scale(ctx, cx, y, R(ENGINE.r), SWEEP0, SWEEP1, 5, 2, null, 5);
    }
    text(ctx, name, PX((ENGINE.x0 + ENGINE.x1) / 2), y + R(ENGINE.r) + 5, 6, COL.text);
  });
  text(ctx, 'L', PX(ENGINE.x0), PY(0.222), 7, COL.text);
  text(ctx, 'R', PX(ENGINE.x1), PY(0.222), 7, COL.text);
  // Lamp wells behind the lamp faces (the faces are unlit quads on top).
  for (const [lx, ly] of GEAR.lights) {
    ctx.fillStyle = '#1a1c1e';
    ctx.fillRect(PX(lx) - 11, PY(ly) - 9, 22, 18);
  }
}

// ─── Front dash: moving parts ────────────────────────────────────────────────

function attitudeBall(ctx: Ctx, cx: number, cy: number, rp: number, pitchDeg: number, rollDeg: number, sky: string, ground: string, pxPerDeg: number): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, rp, 0, Math.PI * 2);
  ctx.clip();
  ctx.translate(cx, cy);
  ctx.rotate(-rollDeg * DEG);
  const off = pitchDeg * pxPerDeg;
  ctx.fillStyle = sky;
  ctx.fillRect(-rp * 2, -rp * 4 + off, rp * 4, rp * 4);
  ctx.fillStyle = ground;
  ctx.fillRect(-rp * 2, off, rp * 4, rp * 4);
  ctx.strokeStyle = '#f4f4ee';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-rp * 2, off);
  ctx.lineTo(rp * 2, off);
  ctx.stroke();
  ctx.lineWidth = 1.2;
  for (let p = -30; p <= 30; p += 10) {
    if (p === 0) continue;
    const y = off - p * pxPerDeg;
    const hw = rp * (p % 20 === 0 ? 0.42 : 0.28);
    ctx.strokeStyle = p > 0 ? '#1a1a1a' : '#f0f0ea';
    ctx.beginPath();
    ctx.moveTo(-hw, y);
    ctx.lineTo(hw, y);
    ctx.stroke();
  }
  ctx.restore();
  // Bank scale + pointer, fixed miniature aircraft.
  ctx.strokeStyle = '#f4f4ee';
  ctx.lineWidth = 1.5;
  for (const b of [-60, -30, -20, -10, 0, 10, 20, 30, 60]) {
    const t = (-90 + b) * DEG;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(t) * rp * 0.88, cy + Math.sin(t) * rp * 0.88);
    ctx.lineTo(cx + Math.cos(t) * rp, cy + Math.sin(t) * rp);
    ctx.stroke();
  }
  ctx.strokeStyle = '#f2b21e';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx - rp * 0.55, cy);
  ctx.lineTo(cx - rp * 0.18, cy);
  ctx.lineTo(cx - rp * 0.1, cy + rp * 0.1);
  ctx.moveTo(cx + rp * 0.55, cy);
  ctx.lineTo(cx + rp * 0.18, cy);
  ctx.lineTo(cx + rp * 0.1, cy + rp * 0.1);
  ctx.stroke();
  ctx.fillStyle = '#f2b21e';
  ctx.beginPath();
  ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
  ctx.fill();
}

/** Paint the moving parts of the dash (needles, ADI/SAI balls, HSI card, counters). */
export function drawDashDynamic(ctx: Ctx, g: A10Gauges): void {
  const G = GAUGE;
  const d = (k: keyof typeof GAUGE) => ({ x: PX(G[k].x), y: PY(G[k].y), r: R(G[k].r) });
  // ADI (grey sky / black ground like the A-10's ARU-50 ball) and the standby (SAI).
  {
    const a = d('adi');
    dialFace(ctx, a.x, a.y, a.r);
    attitudeBall(ctx, a.x, a.y, a.r * 0.96, g.pitchDeg, g.rollDeg, '#8d9296', '#1f1d1b', (a.r * 0.96) / 35);
  }
  {
    const a = d('sai');
    dialFace(ctx, a.x, a.y, a.r);
    attitudeBall(ctx, a.x, a.y, a.r * 0.94, g.pitchDeg, g.rollDeg, '#9aa0a4', '#27231f', (a.r * 0.94) / 40);
    text(ctx, 'STBY', a.x, a.y + a.r * 0.78, 5.5, '#e8e8e0');
  }
  // HSI: rotating compass card, course arrow, aircraft symbol.
  {
    const a = d('hsi');
    dialFace(ctx, a.x, a.y, a.r);
    ctx.save();
    ctx.translate(a.x, a.y);
    ctx.rotate(-g.headingDeg * DEG);
    ctx.strokeStyle = COL.tick;
    for (let k = 0; k < 72; k++) {
      const t = (k * 5 - 90) * DEG;
      const major = k % 2 === 0;
      ctx.lineWidth = major ? 1.6 : 1;
      ctx.beginPath();
      ctx.moveTo(Math.cos(t) * a.r * (major ? 0.8 : 0.87), Math.sin(t) * a.r * (major ? 0.8 : 0.87));
      ctx.lineTo(Math.cos(t) * a.r * 0.95, Math.sin(t) * a.r * 0.95);
      ctx.stroke();
    }
    for (let k = 0; k < 12; k++) {
      const t = (k * 30 - 90) * DEG;
      const lab = ['N', '3', '6', 'E', '12', '15', 'S', '21', '24', 'W', '30', '33'][k];
      ctx.save();
      ctx.translate(Math.cos(t) * a.r * 0.64, Math.sin(t) * a.r * 0.64);
      ctx.rotate(k * 30 * DEG);
      text(ctx, lab, 0, 0, 8, COL.tick);
      ctx.restore();
    }
    // Course arrow (steering to steerpoint 3 on 350°).
    ctx.rotate(350 * DEG);
    ctx.strokeStyle = '#f2c230';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(0, a.r * 0.55);
    ctx.lineTo(0, -a.r * 0.55);
    ctx.moveTo(-5, -a.r * 0.45);
    ctx.lineTo(0, -a.r * 0.58);
    ctx.lineTo(5, -a.r * 0.45);
    ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = '#f2b21e';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(a.x - 8, a.y);
    ctx.lineTo(a.x + 8, a.y);
    ctx.moveTo(a.x, a.y - 7);
    ctx.lineTo(a.x, a.y + 8);
    ctx.moveTo(a.x - 4, a.y + 7);
    ctx.lineTo(a.x + 4, a.y + 7);
    ctx.stroke();
    ctx.fillStyle = '#f4f4ee';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y - a.r * 0.97);
    ctx.lineTo(a.x - 4, a.y - a.r * 1.1);
    ctx.lineTo(a.x + 4, a.y - a.r * 1.1);
    ctx.fill();
  }
  // Airspeed, altimeter (100-ft needle + counter), VVI, AOA, accelerometer, clock, flaps, fuel.
  {
    const a = d('asi');
    needle(ctx, a.x, a.y, a.r, sweep(g.iasKt / 500));
  }
  {
    const a = d('alt');
    ctx.fillStyle = '#050505';
    ctx.fillRect(a.x - a.r * 0.62, a.y + a.r * 0.18, a.r * 1.24, a.r * 0.42);
    const ft = Math.round(Math.max(0, g.altFt) / 10) * 10;
    text(ctx, String(ft).padStart(5, '0'), a.x, a.y + a.r * 0.39, 8, '#f4f4ee', 'center', 'bold');
    needle(ctx, a.x, a.y, a.r, -Math.PI / 2 + (((g.altFt % 1000) + 1000) % 1000) / 1000 * Math.PI * 2);
  }
  {
    const a = d('vvi');
    const v = g.vviFpm;
    const m = Math.abs(v) <= 2000 ? (Math.abs(v) / 2000) * 85 : 85 + ((Math.abs(v) - 2000) / 4000) * 85;
    needle(ctx, a.x, a.y, a.r, Math.PI - Math.sign(v) * m * DEG);
  }
  {
    const a = d('aoa');
    needle(ctx, a.x, a.y, a.r, sweep(g.aoaUnits / 30), 0.86, 2);
  }
  {
    const a = d('accel');
    needle(ctx, a.x, a.y, a.r, sweep((g.g + 5) / 15), 0.86, 2);
  }
  {
    const a = d('clock');
    const s = ((g.clockS % 43200) + 43200) % 43200;
    needle(ctx, a.x, a.y, a.r, -Math.PI / 2 + (s / 43200) * Math.PI * 2, 0.55, 2.2);
    needle(ctx, a.x, a.y, a.r, -Math.PI / 2 + ((s % 3600) / 3600) * Math.PI * 2, 0.85, 1.6);
    needle(ctx, a.x, a.y, a.r, -Math.PI / 2 + ((s % 60) / 60) * Math.PI * 2, 0.9, 0.8, '#e04030');
  }
  {
    const a = d('flaps');
    needle(ctx, a.x, a.y, a.r, -150 * DEG + (g.flapsDeg / 20) * 120 * DEG, 0.86, 2);
  }
  {
    const a = d('fuel');
    ctx.fillStyle = '#050505';
    ctx.fillRect(a.x - a.r * 0.5, a.y + a.r * 0.05, a.r, a.r * 0.36);
    text(ctx, String(Math.round(g.fuelLb)).padStart(5, '0'), a.x, a.y + a.r * 0.23, 8, '#f4f4ee');
    needle(ctx, a.x, a.y, a.r, sweep(g.fuelLb / 2 / 6000), 0.86, 2.2);
    needle(ctx, a.x, a.y, a.r, sweep((g.fuelLb / 2 - 250) / 6000), 0.7, 1.6, '#f2c230');
  }
  ENGINE.rows.forEach((row, i) => {
    const y = PY(ENGINE.y0 + i * ENGINE.dy);
    const v = row === 'FAN' ? g.fanPct / 100 : row === 'ITT' ? (g.ittC - 100) / 1000 : row === 'CORE' ? g.corePct / 104 : row === 'FF' ? g.ffPph / 5000 : g.oilPsi / 100;
    for (const [k, x] of [ENGINE.x0, ENGINE.x1].entries()) needle(ctx, PX(x), y, R(ENGINE.r), sweep(v + (k ? 0.006 : 0)), 0.86, 1.8);
  });
}

/** Whole dash: the cached background (or a fresh paint) + the moving parts. */
export function drawDash(ctx: Ctx, g: A10Gauges, background: CanvasImageSource | null = null): void {
  if (background) ctx.drawImage(background, 0, 0);
  else drawDashBackground(ctx);
  drawDashDynamic(ctx, g);
}

// ─── Consoles (static, rows CONSOLE_ROW…+CONSOLE_PX) ─────────────────────────

/** Paint both console tops (read from the seat: forward is "up"). */
export function drawConsoles(ctx: Ctx): void {
  // Millimetres throughout (console length × width).
  const len = (CONSOLE.zBack - CONSOLE.zFront) * 1000;
  const wid = (CONSOLE.xOut - CONSOLE.xIn) * 1000;
  const pxPerMm = 1024 / len;
  const scaleAcross = CONSOLE_PX / wid;
  for (const side of ['left', 'right'] as const) {
    const row = CONSOLE_ROW[side];
    ctx.save();
    // Local frame (mm): u to the pilot's right across the console (0 … wid), w aft (0 … len).
    // Canvas: X = w · pxPerMm, Y = row + (wid − u) · scaleAcross (a rotation: text is not mirrored).
    ctx.setTransform(0, -scaleAcross, pxPerMm, 0, 0, row + CONSOLE_PX);
    ctx.fillStyle = '#4f575d';
    ctx.fillRect(0, 0, wid, len);
    const panels = side === 'left'
      ? [
          { w0: 0, w1: 140, name: 'AUX LG / EMER FLT' },
          { w0: 140, w1: 440, name: '' },
          { w0: 440, w1: 580, name: 'FUEL SYSTEM' },
          { w0: 580, w1: 700, name: 'SAS' },
          { w0: 700, w1: 820, name: 'ENGINE START' },
          { w0: 820, w1: 940, name: 'LASTE' },
          { w0: 940, w1: 1060, name: 'INTERCOM' },
          { w0: 1060, w1: 1200, name: 'UHF RADIO' },
        ]
      : [
          { w0: 0, w1: 200, name: 'CDU' },
          { w0: 200, w1: 440, name: 'CAUTION LIGHTS' },
          { w0: 440, w1: 560, name: 'ELECTRICAL' },
          { w0: 560, w1: 680, name: 'LIGHTING' },
          { w0: 680, w1: 800, name: 'ENVIRONMENT' },
          { w0: 800, w1: 920, name: 'OXYGEN' },
          { w0: 920, w1: 1060, name: 'IFF' },
          { w0: 1060, w1: 1200, name: 'TISL' },
        ];
    let seed = side === 'left' ? 7 : 19;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const p of panels) {
      ctx.fillStyle = '#586167';
      ctx.fillRect(4, p.w0 + 3, wid - 8, p.w1 - p.w0 - 6);
      ctx.strokeStyle = '#3d4449';
      ctx.lineWidth = 2;
      ctx.strokeRect(4, p.w0 + 3, wid - 8, p.w1 - p.w0 - 6);
      for (const [u, w] of [[12, p.w0 + 11], [wid - 12, p.w0 + 11], [12, p.w1 - 11], [wid - 12, p.w1 - 11]]) {
        ctx.fillStyle = '#8a9298';
        ctx.beginPath();
        ctx.arc(u, w, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
      if (!p.name) continue;
      ctx.fillStyle = COL.text;
      ctx.font = 'bold 9px Arial, Helvetica, sans-serif';
      ctx.fillText(p.name, wid / 2, p.w0 + 17);
      if (p.name === 'CAUTION LIGHTS') {
        // 4 × 12 caution legends, dark (nothing wrong).
        const names = ['ENG START', 'L-R TKS', 'HYD PRESS', 'GUN UNSAFE', 'ANTI-SKID', 'OXY LOW', 'CADC', 'EAC', 'INST INV', 'L GEN', 'R GEN', 'SEAT ARM'];
        ctx.font = 'bold 5px Arial, Helvetica, sans-serif';
        for (let i = 0; i < 12; i++)
          for (let j = 0; j < 4; j++) {
            const u = 22 + j * ((wid - 44) / 3);
            const w = p.w0 + 34 + i * 16.5;
            ctx.fillStyle = '#23261f';
            ctx.fillRect(u - 18, w - 6.5, 36, 13);
            ctx.fillStyle = '#77715a';
            ctx.fillText(names[(i + j * 5) % names.length], u, w);
          }
      } else if (p.name === 'CDU') {
        // Keypad under the display (the display itself is a lit quad).
        for (let i = 0; i < 5; i++)
          for (let j = 0; j < 6; j++) {
            ctx.fillStyle = '#383e43';
            ctx.fillRect(16 + j * 24, p.w0 + 92 + i * 19, 19, 14);
            ctx.fillStyle = '#d8dad4';
            ctx.font = 'bold 6px Arial, Helvetica, sans-serif';
            ctx.fillText('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123'[i * 6 + j], 25.5 + j * 24, p.w0 + 99 + i * 19);
          }
      } else {
        // Knobs and toggles.
        const n = 2 + Math.floor(rnd() * 3);
        for (let k = 0; k < n; k++) {
          const u = 30 + (k * (wid - 60)) / Math.max(1, n - 1);
          const w = p.w0 + 50 + rnd() * (p.w1 - p.w0 - 80);
          ctx.fillStyle = '#1c1e20';
          ctx.beginPath();
          ctx.arc(u, w, 8.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#e8e8e0';
          ctx.fillRect(u - 0.8, w - 8.5, 1.6, 6);
          ctx.fillStyle = COL.dim;
          ctx.font = '5px Arial, Helvetica, sans-serif';
          ctx.fillText(['MODE', 'VOL', 'BRT', 'SEL', 'TEST', 'PWR'][Math.floor(rnd() * 6)], u, w + 14);
        }
      }
    }
    ctx.restore();
  }
}

// ─── Screens: MFCD pages, lamps, CDU ─────────────────────────────────────────

export interface ScreenState {
  headingDeg: number;
  rightPage: 'TGP' | 'DSMS';
  stores: readonly boolean[];
  airStores: readonly boolean[];
  lamps: LampStates;
  time: number;
}

const MFCD_GREEN = '#6cf08a';
const MFCD_WHITE = '#e9f2ea';

function osbLabels(ctx: Ctx, top: readonly string[], right: readonly string[], bottom: readonly string[], left: readonly string[], sel: string): void {
  ctx.font = 'bold 19px monospace';
  ctx.textBaseline = 'middle';
  const pos = (k: number) => 512 * (0.18 + k * 0.16);
  top.forEach((t, k) => text(ctx, t, pos(k), 22, 19, MFCD_WHITE, 'center', 'bold'));
  bottom.forEach((t, k) => {
    const x = pos(k);
    text(ctx, t, x, 490, 19, t === sel ? '#101410' : MFCD_WHITE, 'center', 'bold');
    if (t === sel) {
      ctx.fillStyle = MFCD_WHITE;
      ctx.fillRect(x - 32, 478, 64, 24);
      text(ctx, t, x, 490, 19, '#0c100c', 'center', 'bold');
    }
  });
  left.forEach((t, k) => text(ctx, t, 8, pos(k), 17, MFCD_WHITE, 'left', 'bold'));
  right.forEach((t, k) => text(ctx, t, 504, pos(k), 17, MFCD_WHITE, 'right', 'bold'));
}

function drawTad(ctx: Ctx, headingDeg: number): void {
  ctx.fillStyle = '#020403';
  ctx.fillRect(0, 0, 512, 512);
  const ox = 256;
  const oy = 360;
  const nm = 7.2; // px per NM (20 NM scale → ~145 px)
  ctx.save();
  ctx.beginPath();
  ctx.rect(4, 40, 504, 420);
  ctx.clip();
  ctx.translate(ox, oy);
  ctx.rotate(-headingDeg * DEG);
  // Dark map underlay: terrain relief blotches, a coastline, a river (north-up, turns with heading).
  let seed = 4242;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let k = 0; k < 70; k++) {
    const x = (rnd() - 0.5) * 900;
    const y = (rnd() - 0.8) * 900;
    const r = 25 + rnd() * 70;
    ctx.fillStyle = `rgba(${40 + rnd() * 30}, ${52 + rnd() * 30}, ${34 + rnd() * 16}, 0.55)`;
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * (0.5 + rnd() * 0.5), rnd() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(20, 40, 72, 0.9)';
  ctx.fillRect(-600, 7.6 * nm * 1.852, 1200, 600);
  ctx.strokeStyle = 'rgba(70, 120, 170, 0.8)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(1.7 * nm * 1.852, 7.6 * nm * 1.852);
  ctx.bezierCurveTo(30, 20, 60, -30, 40, -120);
  ctx.stroke();
  // Roads.
  ctx.strokeStyle = 'rgba(160, 150, 120, 0.45)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-300, 40);
  ctx.lineTo(300, -60);
  ctx.moveTo(-40, 250);
  ctx.lineTo(-10, -300);
  ctx.stroke();
  // Flight plan: airfield → steerpoints (white), the range (red threat ring, SA-8-ish), bullseye.
  const pts: [number, number][] = [[0, 0], [-0.4, -2.2], [-0.8, -2.85], [0.9, -1.2]];
  const P = ([x, y]: [number, number]): [number, number] => [x * nm * 1.852, y * nm * 1.852];
  ctx.strokeStyle = MFCD_WHITE;
  ctx.lineWidth = 2;
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(...P(p)) : ctx.moveTo(...P(p))));
  ctx.stroke();
  pts.forEach((p, i) => {
    const [x, y] = P(p);
    ctx.strokeStyle = MFCD_WHITE;
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(headingDeg * DEG);
    text(ctx, String(i), 12, -10, 15, MFCD_WHITE, 'left');
    ctx.restore();
  });
  // Runway symbol at the field.
  ctx.fillStyle = MFCD_WHITE;
  ctx.fillRect(-2, -12, 4, 24);
  const [tx, ty] = P([-0.82, -2.85]);
  ctx.strokeStyle = '#ff4b3a';
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 6]);
  ctx.beginPath();
  ctx.arc(tx, ty, 58, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  for (const [dx, dy] of [[-10, 4], [8, -6], [14, 10], [-4, -14]]) {
    ctx.fillStyle = '#ff4b3a';
    ctx.beginPath();
    ctx.moveTo(tx + dx, ty + dy - 7);
    ctx.lineTo(tx + dx + 6, ty + dy + 4);
    ctx.lineTo(tx + dx - 6, ty + dy + 4);
    ctx.fill();
  }
  // Bullseye.
  const [bx, by] = P([1.6, -3.2]);
  ctx.strokeStyle = '#48c8ff';
  ctx.lineWidth = 1.5;
  for (const r of [8, 16, 24]) {
    ctx.beginPath();
    ctx.arc(bx, by, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
  // Range rings (5 and 10 NM) and compass rose (turns with heading), ownship.
  ctx.strokeStyle = 'rgba(210, 230, 210, 0.5)';
  ctx.lineWidth = 1.5;
  for (const r of [5, 10]) {
    ctx.beginPath();
    ctx.arc(ox, oy, r * nm * 1.852, Math.PI * 1.05, Math.PI * 1.95);
    ctx.stroke();
  }
  ctx.save();
  ctx.translate(ox, oy);
  ctx.rotate(-headingDeg * DEG);
  const rr = 10 * nm * 1.852;
  ctx.strokeStyle = MFCD_WHITE;
  for (let k = 0; k < 36; k++) {
    const t = (k * 10 - 90) * DEG;
    ctx.lineWidth = k % 3 === 0 ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(Math.cos(t) * rr, Math.sin(t) * rr);
    ctx.lineTo(Math.cos(t) * (rr - (k % 3 === 0 ? 12 : 6)), Math.sin(t) * (rr - (k % 3 === 0 ? 12 : 6)));
    ctx.stroke();
  }
  for (const [lab, deg] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]] as const) {
    const t = (deg - 90) * DEG;
    ctx.save();
    ctx.translate(Math.cos(t) * (rr - 26), Math.sin(t) * (rr - 26));
    ctx.rotate(headingDeg * DEG);
    text(ctx, lab, 0, 0, 18, MFCD_WHITE);
    ctx.restore();
  }
  ctx.restore();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(ox, oy - 16);
  ctx.lineTo(ox - 5, oy - 2);
  ctx.lineTo(ox - 16, oy + 4);
  ctx.lineTo(ox - 16, oy + 8);
  ctx.lineTo(ox - 4, oy + 6);
  ctx.lineTo(ox - 3, oy + 14);
  ctx.lineTo(ox + 3, oy + 14);
  ctx.lineTo(ox + 4, oy + 6);
  ctx.lineTo(ox + 16, oy + 8);
  ctx.lineTo(ox + 16, oy + 4);
  ctx.lineTo(ox + 5, oy - 2);
  ctx.fill();
  // Heading readout box, scale, data blocks.
  ctx.strokeStyle = MFCD_WHITE;
  ctx.lineWidth = 2;
  ctx.strokeRect(222, 44, 68, 28);
  text(ctx, String(Math.round(headingDeg) % 360).padStart(3, '0'), 256, 58, 20, MFCD_WHITE);
  text(ctx, '20', 470, 64, 18, MFCD_GREEN, 'right');
  text(ctx, 'BULL 047/12', 14, 438, 16, '#48c8ff', 'left');
  text(ctx, 'STPT 3  RANGE', 498, 438, 16, MFCD_WHITE, 'right');
  osbLabels(ctx, ['CNTL', 'FILE', 'COM', 'SYS', 'TAD'], ['EXP', 'CEN', '', 'SOI', ''], ['LOAD', 'TAD', 'TGP', 'DSMS', 'MSG'], ['', 'HOOK', 'MAP', '', 'VIEW'], 'TAD');
  // SOI box (this page has the sensor-of-interest).
  ctx.strokeStyle = MFCD_GREEN;
  ctx.lineWidth = 3;
  ctx.strokeRect(3, 3, 506, 506);
}

function drawTgp(ctx: Ctx, time: number): void {
  // IR video, white-hot: fields (patchwork), a road, tree lines, a hot vehicle in the track box.
  const g = ctx.createLinearGradient(0, 0, 0, 512);
  g.addColorStop(0, '#5a5a5a');
  g.addColorStop(1, '#6e6e6e');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 512, 512);
  let seed = 991;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  ctx.save();
  ctx.translate(256, 256);
  ctx.rotate(0.3);
  for (let i = -4; i <= 4; i++)
    for (let j = -4; j <= 4; j++) {
      const v = 70 + Math.floor(rnd() * 60);
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      ctx.fillRect(i * 70 - 35, j * 55 - 27, 68 + rnd() * 6, 53 + rnd() * 6);
    }
  ctx.strokeStyle = '#a8a8a8';
  ctx.lineWidth = 9;
  ctx.beginPath();
  ctx.moveTo(-400, 30);
  ctx.bezierCurveTo(-100, 10, 60, 60, 400, -20);
  ctx.stroke();
  for (let k = 0; k < 90; k++) {
    const x = (rnd() - 0.5) * 700;
    const y = (rnd() - 0.5) * 700;
    ctx.fillStyle = `rgba(30,30,30,${0.3 + rnd() * 0.4})`;
    ctx.beginPath();
    ctx.arc(x, y, 4 + rnd() * 9, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  // Hot vehicle (white-hot engine deck) + its shadow.
  ctx.fillStyle = '#2d2d2d';
  ctx.fillRect(250, 262, 30, 14);
  ctx.fillStyle = '#d8d8d8';
  ctx.fillRect(244, 250, 26, 14);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(262, 252, 8, 10);
  // Sensor noise lines (a hint of scan structure).
  const n = Math.floor(fin(time) * 3) % 7;
  ctx.fillStyle = 'rgba(255,255,255,0.03)';
  for (let y = n; y < 512; y += 7) ctx.fillRect(0, y, 512, 1);
  // Symbology: crosshair with a gap, track gates, text.
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(256, 60);
  ctx.lineTo(256, 226);
  ctx.moveTo(256, 286);
  ctx.lineTo(256, 450);
  ctx.moveTo(40, 256);
  ctx.lineTo(226, 256);
  ctx.moveTo(286, 256);
  ctx.lineTo(472, 256);
  ctx.stroke();
  ctx.strokeRect(236, 238, 42, 36);
  ctx.fillStyle = '#000000';
  ctx.font = 'bold 18px monospace';
  text(ctx, 'A-G', 40, 60, 18, '#000', 'left');
  text(ctx, 'WHOT', 40, 84, 18, '#000', 'left');
  text(ctx, 'NARO', 472, 60, 18, '#000', 'right');
  text(ctx, 'PTRK', 472, 84, 18, '#000', 'right');
  text(ctx, 'L 1688', 40, 420, 18, '#000', 'left');
  text(ctx, '3.1 NM', 472, 420, 18, '#000', 'right');
  text(ctx, 'LSS', 256, 440, 18, '#000');
  osbLabels(ctx, ['A-G', 'STBY', 'A-A', 'CNTL', 'TGP'], ['FOCUS', 'GAIN', 'LVL', 'TRK', 'BHOT'], ['LOAD', 'TAD', 'TGP', 'DSMS', 'MSG'], ['ZOOM', 'FOV', 'BHOT', 'MARK', ''], 'TGP');
}

function drawDsms(ctx: Ctx, stores: readonly boolean[], airStores: readonly boolean[]): void {
  ctx.fillStyle = '#020403';
  ctx.fillRect(0, 0, 512, 512);
  // A-10 planform (top view), stations 1–11 along the wing.
  ctx.strokeStyle = MFCD_GREEN;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(256, 90);
  ctx.lineTo(272, 130);
  ctx.lineTo(272, 180);
  ctx.lineTo(470, 190);
  ctx.lineTo(470, 216);
  ctx.lineTo(272, 222);
  ctx.lineTo(268, 330);
  ctx.lineTo(320, 342);
  ctx.lineTo(320, 356);
  ctx.lineTo(192, 356);
  ctx.lineTo(192, 342);
  ctx.lineTo(244, 330);
  ctx.lineTo(240, 222);
  ctx.lineTo(42, 216);
  ctx.lineTo(42, 190);
  ctx.lineTo(240, 180);
  ctx.lineTo(240, 130);
  ctx.closePath();
  ctx.stroke();
  const cnt = (a: readonly boolean[], idx: readonly number[]) => idx.reduce((n, i) => n + (a[i] !== false ? 1 : 0), 0);
  const left65 = cnt(stores, [0, 2]);
  const right65 = cnt(stores, [1, 3]);
  const aim9 = cnt(airStores, [0, 1]);
  const st = [
    ['1', 'ECM', 'ALQ184'],
    ['2', 'TGP', 'SNIPER'],
    ['3', `${left65}`, '65D'],
    ['4', '1', 'G12'],
    ['5', '', ''],
    ['6', '', ''],
    ['7', '', ''],
    ['8', '1', 'G12'],
    ['9', `${right65}`, '65D'],
    ['10', '', ''],
    ['11', `${aim9}`, '9M'],
  ];
  st.forEach(([n, q, t], k) => {
    const x = 56 + k * 40;
    text(ctx, n, x, 250, 15, MFCD_GREEN);
    if (t) {
      text(ctx, q, x, 276, 17, MFCD_WHITE);
      text(ctx, t, x, 298, 14, q === '0' ? '#6d766e' : MFCD_WHITE);
    }
  });
  text(ctx, 'GUN  PAC  1', 256, 392, 19, MFCD_WHITE);
  text(ctx, 'CCIP  CONSENT OPT', 256, 418, 16, MFCD_GREEN);
  text(ctx, 'MASTER ARM', 60, 60, 16, MFCD_WHITE, 'left');
  osbLabels(ctx, ['INV', 'PROF', 'STAT', 'LOAD', 'DSMS'], ['SEL', '', 'CHG', '', 'CNTL'], ['LOAD', 'TAD', 'TGP', 'DSMS', 'MSG'], ['A-G', '', 'A-A', '', 'MSL'], 'DSMS');
}

const LAMP_STYLE: Record<LampId, { on: string; off: string; label: string; shape?: 'chevDown' | 'chevUp' | 'donut' | 'round' }> = {
  gearNose: { on: '#39ff5c', off: '#16301b', label: 'NOSE', shape: 'round' },
  gearLeft: { on: '#39ff5c', off: '#16301b', label: 'L', shape: 'round' },
  gearRight: { on: '#39ff5c', off: '#16301b', label: 'R', shape: 'round' },
  gearHandle: { on: '#ff2a18', off: '#3a1210', label: '', shape: 'round' },
  masterCaution: { on: '#ffb020', off: '#3e2c10', label: 'MASTER CAUTION' },
  gunReady: { on: '#42ff64', off: '#153019', label: 'GUN READY' },
  aoaHigh: { on: '#34ff58', off: '#10220f', label: '', shape: 'chevDown' },
  aoaOn: { on: '#ffb020', off: '#231a0a', label: '', shape: 'donut' },
  aoaLow: { on: '#ff3020', off: '#240e0c', label: '', shape: 'chevUp' },
  refuelReady: { on: '#34ff58', off: '#132a14', label: 'READY' },
  refuelLatched: { on: '#34ff58', off: '#132a14', label: 'LATCHED' },
  refuelDisc: { on: '#ffb020', off: '#2d2310', label: 'DISC' },
  canopy: { on: '#ff2a18', off: '#3a1411', label: 'CANOPY UNLOCKED' },
  nws: { on: '#34ff58', off: '#142c15', label: 'NWS' },
  marker: { on: '#5aa8ff', off: '#121c2a', label: 'MARKER BEACON' },
  fireL: { on: '#ff2a18', off: '#3a1411', label: 'L ENG FIRE' },
  fireApu: { on: '#ff2a18', off: '#3a1411', label: 'APU FIRE' },
  fireR: { on: '#ff2a18', off: '#3a1411', label: 'R ENG FIRE' },
};

function drawLamp(ctx: Ctx, id: LampId, on: boolean): void {
  const c = lampCell(LAMP[id]);
  const s = LAMP_STYLE[id];
  ctx.fillStyle = '#050505';
  ctx.fillRect(c.x - 4, c.y - 4, c.w + 8, c.h + 8);
  const col = on ? s.on : s.off;
  const cx = c.x + c.w / 2;
  const cy = c.y + c.h / 2;
  ctx.fillStyle = col;
  ctx.strokeStyle = col;
  if (s.shape === 'chevDown' || s.shape === 'chevUp') {
    const d = s.shape === 'chevDown' ? 1 : -1;
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.moveTo(c.x + 6, cy - d * 14);
    ctx.lineTo(cx, cy + d * 12);
    ctx.lineTo(c.x + c.w - 6, cy - d * 14);
    ctx.stroke();
  } else if (s.shape === 'donut') {
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.arc(cx, cy, 18, 0, Math.PI * 2);
    ctx.stroke();
  } else if (s.shape === 'round') {
    ctx.beginPath();
    ctx.arc(cx, cy, 26, 0, Math.PI * 2);
    ctx.fill();
    if (s.label) text(ctx, s.label, cx, cy, s.label.length > 2 ? 13 : 18, on ? '#0b1a0d' : '#4e6a52');
  } else {
    ctx.fillRect(c.x, c.y, c.w, c.h);
    const words = s.label.split(' ');
    words.forEach((w, i) => text(ctx, w, cx, cy + (i - (words.length - 1) / 2) * 15, 12, on ? '#141008' : 'rgba(255,255,255,0.28)'));
  }
}

/** Paint the whole screens canvas (MFCD pages, lamp faces, CDU). */
export function drawScreens(ctx: Ctx, s: ScreenState): void {
  ctx.save();
  drawTad(ctx, wrap360(fin(s.headingDeg)));
  ctx.restore();
  ctx.save();
  ctx.translate(512, 0);
  ctx.beginPath();
  ctx.rect(0, 0, 512, 512);
  ctx.clip();
  if (s.rightPage === 'DSMS') drawDsms(ctx, s.stores, s.airStores);
  else drawTgp(ctx, s.time);
  ctx.restore();
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 512, 1024, 128);
  for (const id of Object.keys(LAMP) as LampId[]) drawLamp(ctx, id, s.lamps[id] === true);
  // CDU (right console): green text on black.
  const c = CDU_RECT;
  ctx.fillStyle = '#020502';
  ctx.fillRect(c.x, c.y, c.w, c.h);
  ctx.font = 'bold 12px monospace';
  ['WAYPT   STEER 3  RANGE', 'N 31 43.215 W083 16.502', 'EGI  NAV   FOM 1   EHE 12', `TOD ${Math.floor((fin(s.time) / 60 + 683) % 1440 / 60).toString().padStart(2, '0')}:${Math.floor((fin(s.time) / 60 + 683) % 60).toString().padStart(2, '0')}`].forEach((t, i) =>
    text(ctx, t, c.x + 6, c.y + 8 + i * 13.5, 11.5, i === 0 ? '#7df598' : '#4fd06c', 'left'),
  );
}
