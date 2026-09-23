/**
 * F-16 cockpit painting (procedural canvas 2D, no assets):
 *
 *  - `paintStaticAtlas`: the static cockpit atlas — the main instrument panel face in FS 36231 dark
 *    gull grey with its sub-panels, Dzus fasteners, white legends, placards and a little wear; the
 *    side-console tops (black sub-panels with legends); the ICP face and its key caps. Instrument
 *    faces are painted too (seen from outside; in the cockpit the live quads cover them).
 *  - `createLiveInstruments`: the live canvas — FCR and SMS MFD pages, the DED, the RWR scope, the
 *    ADI / standby ADI / HSI, airspeed/Mach, altimeter, VVI, fuel quantity and engine gauges, the gear
 *    lights, master caution and the glareshield eyebrow lights (AOA indexer, warning lights). Dial
 *    backgrounds are pre-rendered once; each redraw only blits them and draws the moving parts.
 *
 * `liveReadings` (pure) turns an AircraftVisualState into clamped, finite instrument values.
 */
import type { AircraftVisualState } from '../types';
import { CONSOLE_ATLAS, ICP, ICP_ATLAS, ICP_KEYS, LAYOUT, LIVE_ATLAS, PANEL, STATIC_ATLAS, panelOutlines, type Gauge, type LiveRect } from './cockpit';

type Ctx = CanvasRenderingContext2D;
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const fin = (x: unknown, d = 0): number => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

// ─── Pure: readings for the live instruments ─────────────────────────────────

export interface LiveReadings {
  airspeedKt: number;
  mach: number;
  altitudeFt: number;
  vsFpm: number;
  pitchDeg: number;
  rollDeg: number;
  headingDeg: number;
  aoaDeg: number;
  /** Throttle lever 0..1 (> 0.9 = afterburner). */
  throttle: number;
  rpmPct: number;
  ftitC: number;
  nozzlePct: number;
  oilPsi: number;
  fuelLb: number;
  /** Gear: 0 up … 1 down; the handle down (true) or up. */
  gearPos: number;
  handleDown: boolean;
  engineRunning: boolean;
  masterCaution: boolean;
  toLdgConfig: boolean;
  /** Seconds (the DED clock). */
  time: number;
  airStores: boolean[];
  stores: boolean[];
}

/** Clamped, finite instrument values from the visual state (whatever the sim throws at it). */
export function liveReadings(v: AircraftVisualState, handleDown: boolean): LiveReadings {
  const r = v.instruments;
  const running = v.engineRunning === true;
  const throttle = clamp(fin(r?.throttlePct) / 100, 0, 1);
  const ab = clamp(fin(v.afterburner), 0, 1);
  const rpm = clamp(fin(r?.rpm, running ? 70 : 0), 0, 110);
  const time = Math.max(0, fin(v.time));
  const kt = clamp(fin(r?.airspeedKt), 0, 1000);
  const agl = fin(r?.altitudeAglFt, 1e5);
  const gearPos = clamp(fin(v.gearPos, 1), 0, 1);
  return {
    airspeedKt: kt,
    mach: clamp(fin(r?.mach, kt / 661), 0, 3),
    altitudeFt: clamp(fin(r?.altitudeFt), -2000, 80000),
    vsFpm: clamp(fin(r?.verticalSpeedFpm), -60000, 60000),
    pitchDeg: clamp(fin(r?.pitchDeg), -90, 90),
    rollDeg: ((fin(r?.rollDeg) % 360) + 540) % 360 - 180,
    headingDeg: ((fin(r?.headingDeg) % 360) + 360) % 360,
    aoaDeg: clamp(fin(r?.aoaDeg), -30, 60),
    throttle,
    rpmPct: rpm,
    ftitC: running ? clamp(420 + 380 * throttle + 160 * ab, 0, 1200) : clamp(fin(rpm) * 2, 0, 200),
    nozzlePct: running ? clamp(ab > 0.01 ? 40 + 60 * ab : throttle < 0.15 ? 85 - throttle * 400 : 5, 0, 100) : 100,
    oilPsi: running ? clamp(25 + rpm * 0.25, 0, 100) : 0,
    fuelLb: clamp(7000 - time * (0.6 + 2.4 * throttle), 900, 7000),
    gearPos,
    handleDown,
    engineRunning: running,
    masterCaution: !running || r?.overspeed === true || (r?.stallWarning === true && r?.state === 'airborne'),
    toLdgConfig: gearPos < 0.99 && agl < 1000 && kt < 190 && fin(r?.verticalSpeedFpm) < -250,
    time,
    airStores: v.airStores ?? [true, true],
    stores: v.stores ?? [true, true],
  };
}

// ─── Shared drawing helpers ──────────────────────────────────────────────────

const FONT = 'Arial, Helvetica, sans-serif';
const MONO = '"Courier New", Courier, monospace';
function text(ctx: Ctx, t: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign = 'center', font = FONT, weight = 'bold') {
  ctx.fillStyle = color;
  ctx.font = `${weight} ${size}px ${font}`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillText(t, x, y);
}
/** Seeded PRNG (mulberry32) for repeatable wear. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function dzus(ctx: Ctx, x: number, y: number, r: number) {
  ctx.fillStyle = '#3d4144';
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
  ctx.fillStyle = '#80868a';
  ctx.beginPath();
  ctx.arc(x - r * 0.15, y - r * 0.15, r * 0.78, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = '#2a2d30';
  ctx.lineWidth = Math.max(1, r * 0.35);
  ctx.beginPath();
  ctx.moveTo(x - r * 0.6, y + r * 0.2);
  ctx.lineTo(x + r * 0.6, y - r * 0.2);
  ctx.stroke();
}
/** A plate: fill, a dark seam and a light top-left bevel, fasteners at the corners. */
function plate(ctx: Ctx, x: number, y: number, w: number, h: number, fill: string, screws = 7) {
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 3;
  ctx.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3);
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x + 4, y + h - 4);
  ctx.lineTo(x + 4, y + 4);
  ctx.lineTo(x + w - 4, y + 4);
  ctx.stroke();
  if (screws > 0) for (const [sx, sy] of [[x + 12, y + 12], [x + w - 12, y + 12], [x + 12, y + h - 12], [x + w - 12, y + h - 12]]) dzus(ctx, sx, sy, screws);
}
function wear(ctx: Ctx, x: number, y: number, w: number, h: number, seed: number, amount = 1) {
  const r = rng(seed);
  // Fine grain.
  for (let i = 0; i < w * h * 0.0025 * amount; i++) {
    ctx.fillStyle = r() < 0.5 ? `rgba(255,255,255,${0.02 + r() * 0.04})` : `rgba(0,0,0,${0.03 + r() * 0.06})`;
    ctx.fillRect(x + r() * w, y + r() * h, 1 + r() * 2, 1 + r() * 2);
  }
  // Scuffs: short light strokes, more near the bottom edge (boots, gloves, kneeboards).
  ctx.lineCap = 'round';
  for (let i = 0; i < 18 * amount; i++) {
    const sx = x + r() * w;
    const sy = y + h * (0.55 + 0.45 * r());
    const a = (r() - 0.5) * 0.8;
    const l = 6 + r() * 26;
    ctx.strokeStyle = `rgba(200,205,205,${0.05 + r() * 0.08})`;
    ctx.lineWidth = 1 + r() * 2;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + Math.cos(a) * l, sy + Math.sin(a) * l);
    ctx.stroke();
  }
  ctx.lineCap = 'butt';
}

// ─── Static atlas ────────────────────────────────────────────────────────────

const GULL = '#4f5457';
const GULL_D = '#43474a';
const PANEL_BLACK = '#1b1c1e';
const LEGEND = '#e6e6de';

/** Panel coordinates (m) → atlas px. */
function P(x: number, y: number): [number, number] {
  const k = STATIC_ATLAS.panelPx;
  return [(x + PANEL.halfWidth) * k, -y * k];
}
const K = STATIC_ATLAS.panelPx;

function paintDial(ctx: Ctx, cx: number, cy: number, R: number, marks: number, labels: string[] = [], arc: [number, number] = [0, TAU], color = LEGEND) {
  ctx.fillStyle = '#0c0d0e';
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = color;
  for (let k = 0; k <= marks; k++) {
    const a = arc[0] + ((arc[1] - arc[0]) * k) / marks - Math.PI / 2;
    const major = k % 2 === 0;
    ctx.lineWidth = major ? Math.max(1.5, R * 0.035) : Math.max(1, R * 0.02);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * R * (major ? 0.74 : 0.82), cy + Math.sin(a) * R * (major ? 0.74 : 0.82));
    ctx.lineTo(cx + Math.cos(a) * R * 0.94, cy + Math.sin(a) * R * 0.94);
    ctx.stroke();
  }
  labels.forEach((t, k) => {
    const a = arc[0] + ((arc[1] - arc[0]) * k) / Math.max(1, labels.length - (arc[1] - arc[0] >= TAU - 1e-6 ? 0 : 1)) - Math.PI / 2;
    text(ctx, t, cx + Math.cos(a) * R * 0.56, cy + Math.sin(a) * R * 0.56, Math.max(8, R * 0.2), color);
  });
}

function paintPanel(ctx: Ctx): void {
  const W = STATIC_ATLAS.width;
  const H = 1024;
  // Base: gull grey with a faint vertical falloff.
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#4a4f52');
  grad.addColorStop(1, '#52575a');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  // Sub-panels (panel coords rects).
  const sub = (x0: number, y0: number, x1: number, y1: number, fill = GULL, screws = 7) => {
    const [a, b] = P(x0, y0);
    const [c, d] = P(x1, y1);
    plate(ctx, a, b, c - a, d - b, fill, screws);
  };
  sub(-0.13, 0, 0.13, -0.4, '#4d5255');
  sub(-0.44, 0, -0.325, -0.25);
  sub(-0.325, 0, -0.13, -0.25, '#4c5154', 0);
  sub(0.13, 0, 0.325, -0.25, '#4c5154', 0);
  sub(0.325, 0, 0.44, -0.37);
  sub(0.13, -0.25, 0.325, -0.37);
  sub(-0.44, -0.25, -0.2, -0.4, '#4b5053');
  sub(-0.2, -0.25, -0.13, -0.37);
  wear(ctx, 0, 0, W, H, 16, 3);

  // MFD surrounds (under the bezels): a dark recess.
  for (const m of LAYOUT.mfd) {
    const [a, b] = P(m.x - LAYOUT.mfdBezel / 2 - 0.006, m.y + LAYOUT.mfdBezel / 2 + 0.006);
    ctx.fillStyle = '#26292b';
    ctx.fillRect(a, b, (LAYOUT.mfdBezel + 0.012) * K, (LAYOUT.mfdBezel + 0.012) * K);
    // Screen (dark glass with a faint page; the live screen covers it in the cockpit view).
    const [sa, sb] = P(m.x - LAYOUT.mfdScreen / 2, m.y + LAYOUT.mfdScreen / 2);
    ctx.fillStyle = '#071008';
    ctx.fillRect(sa, sb, LAYOUT.mfdScreen * K, LAYOUT.mfdScreen * K);
  }
  // DED window.
  {
    const d = LAYOUT.ded;
    const [a, b] = P(d.x - d.w / 2 - 0.015, d.y + d.h / 2 + 0.009);
    ctx.fillStyle = PANEL_BLACK;
    ctx.fillRect(a, b, (d.w + 0.03) * K, (d.h + 0.018) * K);
  }
  // Round instruments: black cases with default faces; placards.
  const placard: Record<string, string> = { airspeed: 'AIRSPEED/MACH', adi: '', altimeter: 'ALT', sai: 'STBY ATT', hsi: 'HSI', vvi: 'VVI', rwr: 'THREAT', fuel: 'FUEL QTY', ftit: 'FTIT', rpm: 'RPM', noz: 'NOZ POS', oil: 'OIL' };
  for (const [name, g] of Object.entries(LAYOUT.gauges) as [string, Gauge][]) {
    const [cx, cy] = P(g.x, g.y);
    const R = g.r * K;
    ctx.fillStyle = PANEL_BLACK;
    const cw = g.r * (name === 'rwr' ? 2.5 : 2.36) * K;
    ctx.fillRect(cx - cw / 2, cy - cw / 2, cw, cw);
    if (name === 'adi' || name === 'sai') {
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, TAU);
      ctx.clip();
      ctx.fillStyle = '#9da3a6';
      ctx.fillRect(cx - R, cy - R, 2 * R, R);
      ctx.fillStyle = '#111';
      ctx.fillRect(cx - R, cy, 2 * R, R);
      ctx.restore();
    } else if (name === 'rwr') {
      ctx.fillStyle = '#050806';
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, TAU);
      ctx.fill();
    } else paintDial(ctx, cx, cy, R, 20);
    const t = placard[name];
    if (t) text(ctx, t, cx, cy + cw / 2 + 11, 13, LEGEND);
  }
  // Master caution / TF FAIL lenses (dark amber / dark red when unlit).
  for (const [l, col, t] of [[LAYOUT.masterCaution, '#3a2a08', 'MASTER CAUTION'], [LAYOUT.tfFail, '#3a0c0a', 'TF FAIL']] as const) {
    const [a, b] = P(l.x - l.w / 2, l.y + l.h / 2);
    ctx.fillStyle = col;
    ctx.fillRect(a, b, l.w * K, l.h * K);
    text(ctx, t, a + (l.w * K) / 2, b + (l.h * K) / 2, 12, '#15110a');
  }
  // Left upper plate: MASTER ARM etc. toggles, INSTR MODE knob.
  const lab = (t: string, x: number, y: number, size = 12) => {
    const [a, b] = P(x, y);
    text(ctx, t, a, b, size, LEGEND);
  };
  lab('MASTER ARM', -0.39, -0.028, 12);
  lab('ARM', -0.42, -0.045, 10);
  lab('OFF', -0.39, -0.045, 10);
  lab('SIM', -0.36, -0.045, 10);
  lab('ALT REL', -0.39, -0.094, 11);
  lab('LASER', -0.36, -0.138, 10);
  lab('RF', -0.42, -0.138, 10);
  lab('INSTR MODE', -0.39, -0.178, 11);
  lab('PROBE HEAT', 0.39, -0.048, 11);
  lab('ECM', 0.36, -0.1, 10);
  lab('ANTI ICE', 0.42, -0.1, 10);
  // Gear panel.
  {
    const gh = LAYOUT.gearHandle;
    lab('LG', gh.x, gh.y + 0.055, 16);
    lab('UP', gh.x - 0.03, gh.y + 0.025, 12);
    lab('DN', gh.x - 0.03, gh.y - 0.025, 12);
    lab('DN LOCK', gh.x + 0.034, gh.y - 0.047, 10);
    lab('REL', gh.x + 0.034, gh.y - 0.058, 10);
    const names = ['NOSE', 'LEFT', 'RIGHT'];
    LAYOUT.gearLights.forEach((l, i) => {
      const [a, b] = P(l.x - 0.01, l.y + 0.008);
      ctx.fillStyle = '#0a160c';
      ctx.fillRect(a, b, 0.02 * K, 0.016 * K);
      lab(names[i], l.x, l.y - 0.014, 9);
    });
    const ls = LAYOUT.landingSwitch;
    lab('LANDING', ls.x, ls.y + 0.022, 10);
    lab('OFF', ls.x + 0.028, ls.y, 10);
    lab('TAXI', ls.x, ls.y - 0.022, 10);
    lab('LIGHTS', ls.x - 0.04, ls.y + 0.022, 10);
    const hk = LAYOUT.hookSwitch;
    lab('HOOK', hk.x, hk.y + 0.022, 10);
    lab('ALT FLAPS', -0.33, -0.385, 10);
    // Yellow-black stripes around the gear handle slot (warning).
    const [a, b] = P(gh.x - 0.014, gh.y + 0.045);
    ctx.save();
    ctx.beginPath();
    ctx.rect(a, b, 0.028 * K, 0.09 * K);
    ctx.clip();
    ctx.fillStyle = '#d8b020';
    ctx.fillRect(a, b, 0.028 * K, 0.09 * K);
    ctx.fillStyle = '#141414';
    for (let k = -4; k < 12; k++) {
      ctx.beginPath();
      ctx.moveTo(a + k * 16, b);
      ctx.lineTo(a + k * 16 + 8, b);
      ctx.lineTo(a + k * 16 + 8 + 80, b + 210);
      ctx.lineTo(a + k * 16 + 80, b + 210);
      ctx.fill();
    }
    ctx.restore();
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(a + 0.008 * K, b + 0.006 * K, 0.012 * K, 0.078 * K);
  }
  // Centre pedestal legends, the right-hand plate's legends.
  lab('HDG', -0.1, -0.365, 10);
  lab('CRS', 0.1, -0.365, 10);
  lab('FUEL', 0.237, -0.345, 11);
  lab('ENG', 0.375, -0.255, 11);
  // Outline shadow under the glareshield lip (ambient occlusion), following the panel's top edge.
  for (const poly of panelOutlines()) {
    for (let k = 0; k < poly.length - 1; k++) {
      const [x0, y0] = poly[k];
      const [x1, y1] = poly[k + 1];
      if (y0 < -0.36 || y1 < -0.36) continue;
      const [a, b] = P(x0, y0);
      const [c, d] = P(x1, y1);
      const g2 = ctx.createLinearGradient(0, Math.min(b, d), 0, Math.min(b, d) + 70);
      g2.addColorStop(0, 'rgba(0,0,0,0.55)');
      g2.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g2;
      ctx.beginPath();
      ctx.moveTo(a, b - 2);
      ctx.lineTo(c, d - 2);
      ctx.lineTo(c, d + 70);
      ctx.lineTo(a, b + 70);
      ctx.fill();
    }
  }
}

/** Console tops: strips with u = fore → aft along x, top of the strip = the outboard edge. */
function paintConsole(ctx: Ctx, rect: readonly [number, number, number, number], left: boolean): void {
  const [x0, y0, x1, y1] = rect;
  const w = x1 - x0;
  const h = y1 - y0;
  ctx.fillStyle = GULL;
  ctx.fillRect(x0, y0, w, h);
  // Panels (u0, u1 fractions of the length) with legends; the throttle quadrant / stick area stay grey.
  const panels: [number, number, string, string[]][] = left
    ? [[0, 0.4, '', []], [0.42, 0.56, 'FLT CONTROL', ['DIGITAL BACKUP', 'ALT FLAPS', 'LE FLAPS']], [0.57, 0.7, 'FUEL', ['MASTER', 'TANK INERTING', 'ENG FEED']], [0.71, 0.84, 'EXT LIGHTING', ['ANTI-COLL', 'POSITION', 'FORM']], [0.85, 1, 'ELEC / EPU', ['MAIN PWR', 'EPU', 'CAUTION RESET']]]
    : [[0, 0.1, 'SNSR PWR', ['FCR', 'RDR ALT']], [0.1, 0.34, 'HUD', ['SCALES', 'FPM', 'DED DATA', 'DEPR RET']], [0.34, 0.54, '', []], [0.55, 0.7, 'INTERIOR LIGHTING', ['PRIMARY', 'FLOOD', 'CONSOLES']], [0.71, 0.86, 'OXYGEN', ['SUPPLY', 'DILUTER', 'EMER']], [0.87, 1, 'AIR COND', ['TEMP', 'AUTO']]];
  let seed = left ? 101 : 202;
  for (const [u0, u1, title, items] of panels) {
    const a = x0 + u0 * w + 3;
    const b = x0 + u1 * w - 3;
    if (!title) {
      plate(ctx, a, y0 + 3, b - a, h - 6, GULL, 7);
      continue;
    }
    plate(ctx, a, y0 + 3, b - a, h - 6, PANEL_BLACK, 7);
    text(ctx, title, (a + b) / 2, y0 + 30, 17, LEGEND);
    items.forEach((t, k) => text(ctx, t, a + ((k + 0.5) * (b - a)) / items.length, y0 + h * 0.5 + (k % 2) * 40, 13, LEGEND));
    // Small white index ticks and ON/OFF legends.
    const r = rng(seed++);
    for (let k = 0; k < 6; k++) text(ctx, r() < 0.5 ? 'ON' : 'OFF', a + (b - a) * r(), y0 + h * (0.3 + 0.6 * r()), 10, '#c9c9c0');
  }
  if (left) {
    // Throttle quadrant: gate markings along the slot (the slot runs along the strip's inner half).
    const lab = (t: string, u: number) => text(ctx, t, x0 + u * w, y0 + h * 0.2, 16, LEGEND);
    lab('OFF', 0.33);
    lab('IDLE', 0.27);
    lab('MIL', 0.14);
    lab('AB', 0.06);
    ctx.fillStyle = '#26292b';
    ctx.fillRect(x0 + 0.02 * w, y0 + h * 0.34, 0.34 * w, h * 0.42);
  }
  wear(ctx, x0, y0, w, h, left ? 7 : 8, 2);
}

function paintIcp(ctx: Ctx): void {
  const [x0, y0, x1, y1] = ICP_ATLAS.face;
  const w = x1 - x0;
  const h = y1 - y0;
  const kx = w / ICP.w;
  const ky = h / ICP.h;
  // Face coordinates (m, origin at the centre, y up) → px.
  const F = (x: number, y: number): [number, number] => [x0 + (x + ICP.w / 2) * kx, y0 + (ICP.h / 2 - y) * ky];
  ctx.fillStyle = '#4b4f52';
  ctx.fillRect(x0, y0, w, h);
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = 4;
  ctx.strokeRect(x0 + 2, y0 + 2, w - 4, h - 4);
  for (const [sx, sy] of [[-0.1, 0.055], [0.1, 0.055], [-0.1, -0.055], [0.1, -0.055]]) {
    const [a, b] = F(sx, sy);
    dzus(ctx, a, b, 5);
  }
  // Key wells.
  for (const k of ICP_KEYS) {
    const [a, b] = F(k.x - k.w / 2 - 0.002, k.y + k.h / 2 + 0.002);
    ctx.fillStyle = '#1c1e20';
    ctx.fillRect(a, b, (k.w + 0.004) * kx, (k.h + 0.004) * ky);
  }
  const lab = (t: string, x: number, y: number, s = 11) => {
    const [a, b] = F(x, y);
    text(ctx, t, a, b, s, LEGEND);
  };
  lab('SYM', -0.094, 0.05);
  lab('BRT', -0.094, 0.004);
  lab('RET', -0.094, -0.036, 9);
  lab('DEPR', -0.094, -0.045, 9);
  lab('CONT', 0.094, 0.05);
  lab('WX', 0.094, 0.004);
  lab('DCS', 0.068, 0.048);
  lab('FLIR', 0.068, -0.05);
  lab('DRIFT C/O', -0.056, -0.058, 9);
  lab('WARN RESET', 0.046, -0.058, 9);
  // Key caps (cells).
  const cell = ICP_ATLAS.keyCell;
  ICP_KEYS.forEach((k, i) => {
    const cx = cell.x0 + (i % cell.cols) * cell.w;
    const cy = cell.y0 + Math.floor(i / cell.cols) * cell.h;
    const g = ctx.createLinearGradient(0, cy, 0, cy + cell.h);
    const base = k.kind === 'mode' ? ['#3c4043', '#2a2d30'] : ['#4a4e51', '#35393c'];
    g.addColorStop(0, base[0]);
    g.addColorStop(1, base[1]);
    ctx.fillStyle = g;
    ctx.fillRect(cx, cy, cell.w, cell.h);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 3;
    ctx.strokeRect(cx + 2, cy + 2, cell.w - 4, cell.h - 4);
    if (k.bottom) {
      text(ctx, k.top, cx + cell.w / 2, cy + cell.h * 0.36, k.top.length > 2 ? 22 : 30, '#f2f2ea');
      text(ctx, k.bottom, cx + cell.w / 2, cy + cell.h * 0.76, 17, '#e0e0d6');
    } else text(ctx, k.top, cx + cell.w / 2, cy + cell.h / 2, k.top.length > 3 ? 20 : 26, '#f2f2ea');
  });
}

/** Paint the whole static atlas (STATIC_ATLAS size). */
export function paintStaticAtlas(ctx: Ctx): void {
  ctx.fillStyle = GULL_D;
  ctx.fillRect(0, 0, STATIC_ATLAS.width, STATIC_ATLAS.height);
  paintPanel(ctx);
  paintConsole(ctx, CONSOLE_ATLAS.left, true);
  paintConsole(ctx, CONSOLE_ATLAS.right, false);
  paintIcp(ctx);
}

// ─── Live instruments ────────────────────────────────────────────────────────

const GREEN = '#46e46a';
const GREEN_D = 'rgba(70,228,106,0.55)';
const WHITE = '#ecece4';

type Canvas = HTMLCanvasElement | OffscreenCanvas;
type AnyCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function makeCanvas(w: number, h: number): Canvas | null {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  return null;
}

function rectOf(key: LiveRect): { x: number; y: number; w: number; h: number } {
  const r = LIVE_ATLAS[key];
  return { x: r[0], y: r[1], w: r[2] - r[0], h: r[3] - r[1] };
}

/** Needle: from the centre (with a short tail) to 0.85 R at angle a (0 = up, clockwise). */
function needle(ctx: Ctx, cx: number, cy: number, R: number, a: number, color = WHITE, width = 0.055, len = 0.84) {
  const s = Math.sin(a);
  const c = -Math.cos(a);
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  ctx.lineWidth = R * width;
  ctx.beginPath();
  ctx.moveTo(cx - s * R * 0.18, cy - c * R * 0.18);
  ctx.lineTo(cx + s * R * len, cy + c * R * len);
  ctx.stroke();
  ctx.lineCap = 'butt';
  ctx.fillStyle = '#2a2a2a';
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.08, 0, TAU);
  ctx.fill();
}

/** Pre-rendered dial: black face, ticks, numerals (angles 0 = up, clockwise). */
function dialBackground(size: number, draw: (ctx: Ctx, c: number, R: number) => void): Canvas | null {
  const cv = makeCanvas(size, size);
  const ctx = cv?.getContext('2d') as Ctx | null;
  if (!cv || !ctx) return null;
  const c = size / 2;
  const R = size / 2.2;
  ctx.fillStyle = '#0b0b0c';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#101112';
  ctx.beginPath();
  ctx.arc(c, c, R, 0, TAU);
  ctx.fill();
  draw(ctx, c, R);
  return cv;
}
function ticks(ctx: Ctx, c: number, R: number, a0: number, a1: number, n: number, every: number, labels?: (k: number) => string, fontScale = 0.17) {
  for (let k = 0; k <= n; k++) {
    const a = a0 + ((a1 - a0) * k) / n;
    const major = k % every === 0;
    const s = Math.sin(a);
    const co = -Math.cos(a);
    ctx.strokeStyle = WHITE;
    ctx.lineWidth = major ? R * 0.04 : R * 0.022;
    ctx.beginPath();
    ctx.moveTo(c + s * R * (major ? 0.78 : 0.86), c + co * R * (major ? 0.78 : 0.86));
    ctx.lineTo(c + s * R * 0.96, c + co * R * 0.96);
    ctx.stroke();
    if (major && labels) {
      const t = labels(k);
      if (t) text(ctx, t, c + s * R * 0.6, c + co * R * 0.6, R * fontScale, WHITE);
    }
  }
}

/** Redraw rate of the live canvas (Hz) and timing stats (QA: import this module in the page to read them). */
export const LIVE_CFG = { hz: 10 };
export const LIVE_STATS = { draws: 0, lastMs: 0, maxMs: 0, totalMs: 0 };

export interface LiveInstruments {
  /** Redraw the canvas from the visual state (call at ~10 Hz while the cockpit view is shown). */
  draw(v: AircraftVisualState, handleDown: boolean): void;
}

/** The live canvas painter (browser). */
export function createLiveInstruments(ctx: Ctx): LiveInstruments {
  const bg: Partial<Record<LiveRect, Canvas | null>> = {};
  const sz = (k: LiveRect) => rectOf(k).w;
  // Airspeed/Mach: 0–850 kt on a compressed scale (sqrt-like): 80 kt at the top, 850 near 330°.
  const iasAngle = (kt: number) => (Math.sqrt(clamp(kt, 0, 850) / 850) * 330 * DEG);
  bg.airspeed = dialBackground(sz('airspeed'), (c2, c, R) => {
    for (const kt of [100, 150, 200, 250, 300, 350, 400, 450, 500, 600, 700, 800]) {
      const a = iasAngle(kt);
      c2.strokeStyle = WHITE;
      c2.lineWidth = R * 0.035;
      c2.beginPath();
      c2.moveTo(c + Math.sin(a) * R * 0.78, c - Math.cos(a) * R * 0.78);
      c2.lineTo(c + Math.sin(a) * R * 0.96, c - Math.cos(a) * R * 0.96);
      c2.stroke();
      if (kt <= 300 ? kt % 100 === 0 || kt === 150 || kt === 250 : kt % 100 === 0) text(c2, String(kt / 10), c + Math.sin(a) * R * 0.62, c - Math.cos(a) * R * 0.62, R * 0.16, WHITE);
    }
    text(c2, 'KNOTS', c, c + R * 0.42, R * 0.1, WHITE);
    text(c2, '×10', c, c + R * 0.55, R * 0.1, WHITE);
  });
  bg.altimeter = dialBackground(sz('altimeter'), (c2, c, R) => {
    ticks(c2, c, R, 0, TAU, 50, 5, (k) => (k < 50 ? String(k / 5) : ''), 0.2);
    text(c2, 'ALT', c - R * 0.36, c + R * 0.08, R * 0.12, WHITE);
    text(c2, '100 FEET', c, c + R * 0.62, R * 0.09, WHITE);
  });
  bg.fuel = dialBackground(sz('fuel'), (c2, c, R) => {
    ticks(c2, c, R, -135 * DEG, 135 * DEG, 24, 6, (k) => String(k / 6), 0.2);
    text(c2, 'LB ×1000', c, c - R * 0.3, R * 0.11, WHITE);
    text(c2, 'AL', c - R * 0.3, c + R * 0.12, R * 0.12, WHITE);
    text(c2, 'FR', c + R * 0.3, c + R * 0.12, R * 0.12, '#e05a3a');
  });
  const gaugeBg = (label: string, marks: string[], a0 = -140 * DEG, a1 = 140 * DEG) => (c2: Ctx, c: number, R: number) => {
    ticks(c2, c, R, a0, a1, (marks.length - 1) * 2, 2, (k) => marks[k / 2] ?? '', 0.24);
    text(c2, label, c, c + R * 0.45, R * 0.17, WHITE);
  };
  bg.ftit = dialBackground(sz('ftit'), gaugeBg('FTIT', ['2', '4', '6', '8', '10', '12']));
  bg.rpm = dialBackground(sz('rpm'), gaugeBg('RPM', ['0', '2', '4', '6', '8', '10']));
  bg.noz = dialBackground(sz('noz'), gaugeBg('NOZ', ['0', '', '50', '', '100']));
  bg.oil = dialBackground(sz('oil'), gaugeBg('OIL', ['0', '', '50', '', '100']));
  bg.vvi = dialBackground(sz('vvi'), (c2, c, R) => {
    ticks(c2, c, R, -170 * DEG, -10 * DEG, 12, 3, (k) => ['6', '4', '2', '1', '0'][k / 3] ?? '', 0.2);
    ticks(c2, c, R, 10 * DEG, 170 * DEG, 12, 3, (k) => ['', '1', '2', '4', '6'][k / 3] ?? '', 0.2);
    text(c2, 'VERT VEL', c + R * 0.3, c - R * 0.34, R * 0.11, WHITE);
    text(c2, 'UP', c + R * 0.35, c - R * 0.14, R * 0.12, WHITE);
    text(c2, 'DN', c + R * 0.35, c + R * 0.16, R * 0.12, WHITE);
  });
  // VVI: 0 at 9 o'clock (−90°), ±6000 fpm over ±160°, compressed.
  const vviAngle = (fpm: number) => {
    const s = Math.sign(fpm);
    const a = Math.sqrt(clamp(Math.abs(fpm), 0, 6000) / 6000) * 160;
    return (-90 + s * a) * DEG;
  };

  const blit = (k: LiveRect) => {
    const r = rectOf(k);
    const b = bg[k];
    if (b) ctx.drawImage(b as CanvasImageSource, r.x, r.y);
    else {
      ctx.fillStyle = '#0b0b0c';
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
    return { cx: r.x + r.w / 2, cy: r.y + r.h / 2, R: r.w / 2.2, r };
  };

  function attitude(k: LiveRect, pitch: number, roll: number, standby: boolean) {
    const r = rectOf(k);
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const R = r.w / 2.2;
    ctx.fillStyle = '#0b0b0c';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TAU);
    ctx.clip();
    ctx.translate(cx, cy);
    ctx.rotate(-roll * DEG);
    const ppd = R / 30; // px per degree of pitch
    const off = pitch * ppd;
    // Ball: grey sky over black ground (the F-16's ADI colours).
    ctx.fillStyle = standby ? '#8f9598' : '#a3a9ab';
    ctx.fillRect(-2 * R, -3 * R + off, 4 * R, 3 * R);
    ctx.fillStyle = standby ? '#1a1a1a' : '#141414';
    ctx.fillRect(-2 * R, off, 4 * R, 3 * R);
    ctx.strokeStyle = WHITE;
    ctx.lineWidth = R * 0.03;
    ctx.beginPath();
    ctx.moveTo(-2 * R, off);
    ctx.lineTo(2 * R, off);
    ctx.stroke();
    for (let p = -60; p <= 60; p += 5) {
      if (p === 0) continue;
      const y = off - p * ppd;
      if (Math.abs(y) > R * 1.2) continue;
      const w = p % 10 === 0 ? R * 0.34 : R * 0.16;
      ctx.strokeStyle = p > 0 ? '#1a1a1a' : WHITE;
      ctx.lineWidth = R * 0.025;
      ctx.beginPath();
      ctx.moveTo(-w, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      if (p % 10 === 0 && !standby) {
        text(ctx, String(Math.abs(p)), -w - R * 0.13, y, R * 0.11, p > 0 ? '#1a1a1a' : WHITE);
        text(ctx, String(Math.abs(p)), w + R * 0.13, y, R * 0.11, p > 0 ? '#1a1a1a' : WHITE);
      }
    }
    ctx.restore();
    // Roll scale and pointer (fixed scale, rotating pointer: the ball's top index).
    ctx.save();
    ctx.translate(cx, cy);
    ctx.strokeStyle = WHITE;
    for (const a of [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60]) {
      const t = (a - 90) * DEG;
      ctx.lineWidth = R * (Math.abs(a) % 30 === 0 ? 0.04 : 0.025);
      ctx.beginPath();
      ctx.moveTo(Math.cos(t) * R * 0.86, Math.sin(t) * R * 0.86);
      ctx.lineTo(Math.cos(t) * R * 0.98, Math.sin(t) * R * 0.98);
      ctx.stroke();
    }
    ctx.rotate(-roll * DEG);
    ctx.fillStyle = WHITE;
    ctx.beginPath();
    ctx.moveTo(0, -R * 0.84);
    ctx.lineTo(-R * 0.06, -R * 0.72);
    ctx.lineTo(R * 0.06, -R * 0.72);
    ctx.fill();
    ctx.restore();
    // Miniature aircraft (fixed): orange-yellow wings and dot.
    ctx.strokeStyle = '#f0a020';
    ctx.lineWidth = R * 0.06;
    ctx.beginPath();
    ctx.moveTo(cx - R * 0.55, cy);
    ctx.lineTo(cx - R * 0.2, cy);
    ctx.lineTo(cx - R * 0.1, cy + R * 0.1);
    ctx.moveTo(cx + R * 0.55, cy);
    ctx.lineTo(cx + R * 0.2, cy);
    ctx.lineTo(cx + R * 0.1, cy + R * 0.1);
    ctx.stroke();
    ctx.fillStyle = '#f0a020';
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.045, 0, TAU);
    ctx.fill();
    // Bezel shadow ring.
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = R * 0.08;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.98, 0, TAU);
    ctx.stroke();
  }

  function hsi(hdg: number) {
    const r = rectOf('hsi');
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const R = r.w / 2.2;
    ctx.fillStyle = '#0b0b0c';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = '#121314';
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TAU);
    ctx.fill();
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-hdg * DEG);
    for (let d = 0; d < 360; d += 5) {
      const t = d * DEG;
      const major = d % 10 === 0;
      ctx.strokeStyle = WHITE;
      ctx.lineWidth = R * (major ? 0.03 : 0.018);
      ctx.beginPath();
      ctx.moveTo(Math.sin(t) * R * (major ? 0.78 : 0.84), -Math.cos(t) * R * (major ? 0.78 : 0.84));
      ctx.lineTo(Math.sin(t) * R * 0.93, -Math.cos(t) * R * 0.93);
      ctx.stroke();
      if (d % 30 === 0) {
        ctx.save();
        ctx.rotate(t);
        const lbl = d === 0 ? 'N' : d === 90 ? 'E' : d === 180 ? 'S' : d === 270 ? 'W' : String(d / 10);
        text(ctx, lbl, 0, -R * 0.64, R * 0.15, WHITE);
        ctx.restore();
      }
    }
    // Course arrow (selected course 360) and deviation bar, rotating with the card.
    ctx.strokeStyle = '#e8d040';
    ctx.lineWidth = R * 0.045;
    ctx.beginPath();
    ctx.moveTo(0, R * 0.5);
    ctx.lineTo(0, R * 0.2);
    ctx.moveTo(0, -R * 0.2);
    ctx.lineTo(0, -R * 0.52);
    ctx.stroke();
    ctx.fillStyle = '#e8d040';
    ctx.beginPath();
    ctx.moveTo(0, -R * 0.6);
    ctx.lineTo(-R * 0.07, -R * 0.48);
    ctx.lineTo(R * 0.07, -R * 0.48);
    ctx.fill();
    ctx.fillRect(-R * 0.02 + R * 0.08, -R * 0.18, R * 0.04, R * 0.36);
    ctx.restore();
    // Lubber line, aircraft symbol, windows.
    ctx.fillStyle = WHITE;
    ctx.fillRect(cx - R * 0.015, cy - R * 0.98, R * 0.03, R * 0.14);
    ctx.strokeStyle = WHITE;
    ctx.lineWidth = R * 0.035;
    ctx.beginPath();
    ctx.moveTo(cx, cy - R * 0.14);
    ctx.lineTo(cx, cy + R * 0.16);
    ctx.moveTo(cx - R * 0.14, cy - R * 0.02);
    ctx.lineTo(cx + R * 0.14, cy - R * 0.02);
    ctx.moveTo(cx - R * 0.06, cy + R * 0.14);
    ctx.lineTo(cx + R * 0.06, cy + R * 0.14);
    ctx.stroke();
    ctx.fillStyle = '#050505';
    ctx.fillRect(r.x + 4, r.y + 4, R * 0.62, R * 0.22);
    ctx.fillRect(r.x + r.w - 4 - R * 0.62, r.y + 4, R * 0.62, R * 0.22);
    text(ctx, '012.4', r.x + 4 + R * 0.31, r.y + 4 + R * 0.11, R * 0.15, WHITE, 'center', MONO);
    text(ctx, '360', r.x + r.w - 4 - R * 0.31, r.y + 4 + R * 0.11, R * 0.15, WHITE, 'center', MONO);
  }

  function mfdFrame(k: LiveRect, top: string[], bottom: string[], left: string[], right: string[], boxed: string) {
    const r = rectOf(k);
    ctx.fillStyle = '#020403';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    const s = r.w;
    const pos = [0.19, 0.345, 0.5, 0.655, 0.81];
    const fs = s * 0.052;
    top.forEach((t, i) => t && text(ctx, t, r.x + s * pos[i], r.y + s * 0.05, fs, GREEN, 'center', MONO));
    bottom.forEach((t, i) => {
      if (!t) return;
      const x = r.x + s * pos[i];
      const y = r.y + s * 0.95;
      text(ctx, t, x, y, fs, GREEN, 'center', MONO);
      if (t === boxed) {
        ctx.strokeStyle = GREEN;
        ctx.lineWidth = 2;
        ctx.strokeRect(x - fs * 1.3, y - fs * 0.62, fs * 2.6, fs * 1.24);
      }
    });
    left.forEach((t, i) => t && text(ctx, t, r.x + s * 0.03, r.y + s * pos[i], fs, GREEN, 'left', MONO));
    right.forEach((t, i) => t && text(ctx, t, r.x + s * 0.97, r.y + s * pos[i], fs, GREEN, 'right', MONO));
    return r;
  }

  function fcr(t: number, L: LiveReadings) {
    const r = mfdFrame('mfdL', ['CRM', 'RWS', 'NORM', 'OVRD', 'CNTL'], ['SWAP', 'FCR', 'DTE', 'SMS', 'DCLT'], ['▲', '40', '▼', 'A6', '4B'], ['', '', '', '', ''], 'FCR');
    const s = r.w;
    const x0 = r.x + s * 0.16;
    const y0 = r.y + s * 0.12;
    const w = s * 0.68;
    const h = s * 0.72;
    ctx.strokeStyle = GREEN_D;
    ctx.lineWidth = 2;
    ctx.strokeRect(x0, y0, w, h);
    // Range ticks, azimuth ticks.
    ctx.strokeStyle = GREEN;
    for (let k = 1; k < 4; k++) {
      ctx.beginPath();
      ctx.moveTo(x0, y0 + (h * k) / 4);
      ctx.lineTo(x0 + s * 0.03, y0 + (h * k) / 4);
      ctx.stroke();
    }
    for (let k = 0; k <= 6; k++) {
      const x = x0 + (w * k) / 6;
      ctx.beginPath();
      ctx.moveTo(x, y0 + h);
      ctx.lineTo(x, y0 + h - s * (k % 3 === 0 ? 0.03 : 0.018));
      ctx.stroke();
    }
    // Artificial horizon line (FCR attitude reference).
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, w, h);
    ctx.clip();
    ctx.translate(x0 + w / 2, y0 + h / 2 + clamp(L.pitchDeg, -40, 40) * (h / 90));
    ctx.rotate(-L.rollDeg * DEG);
    ctx.strokeStyle = GREEN_D;
    ctx.beginPath();
    ctx.moveTo(-w * 0.45, 0);
    ctx.lineTo(-w * 0.1, 0);
    ctx.moveTo(w * 0.1, 0);
    ctx.lineTo(w * 0.45, 0);
    ctx.stroke();
    ctx.restore();
    // Scan caret sweeping along the bottom, antenna elevation caret on the left.
    const scan = Math.sin(t * 1.3);
    ctx.fillStyle = GREEN;
    const sx = x0 + w / 2 + scan * w * 0.42;
    ctx.fillRect(sx - 2, y0 + h + 4, 4, s * 0.03);
    ctx.fillRect(x0 - s * 0.03, y0 + h * 0.52, s * 0.025, 4);
    // Two search hits drifting in range, the acquisition cursor.
    for (const [bx, by, sp] of [[0.3, 0.35, 0.013], [0.62, 0.55, 0.008]]) {
      const y = y0 + h * ((by + t * sp) % 1);
      ctx.fillRect(x0 + w * bx - 7, y - 4, 14, 8);
    }
    ctx.strokeStyle = GREEN;
    ctx.lineWidth = 3;
    const cxr = x0 + w * 0.47;
    const cyr = y0 + h * 0.62;
    ctx.beginPath();
    ctx.moveTo(cxr - 9, cyr - 12);
    ctx.lineTo(cxr - 9, cyr + 12);
    ctx.moveTo(cxr + 9, cyr - 12);
    ctx.lineTo(cxr + 9, cyr + 12);
    ctx.stroke();
    text(ctx, `${Math.round(L.headingDeg).toString().padStart(3, '0')}°`, x0 + w / 2, y0 + s * 0.03, s * 0.045, GREEN, 'center', MONO);
    text(ctx, 'A1', x0 + w - s * 0.02, y0 + s * 0.03, s * 0.045, GREEN, 'right', MONO);
  }

  function sms(L: LiveReadings) {
    const r = mfdFrame('mfdR', ['AAM', 'SLAV', 'INV', 'SPOT', ''], ['SWAP', 'FCR', 'DTE', 'SMS', 'DCLT'], ['', '', '', '', ''], ['', '', '', '', ''], 'SMS');
    const s = r.w;
    text(ctx, 'GUN  511 PGU-28', r.x + s / 2, r.y + s * 0.16, s * 0.05, GREEN, 'center', MONO);
    // Wing planform line and the nine stations.
    const cy = r.y + s * 0.44;
    ctx.strokeStyle = GREEN_D;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(r.x + s * 0.1, cy + s * 0.06);
    ctx.lineTo(r.x + s * 0.5, cy - s * 0.1);
    ctx.lineTo(r.x + s * 0.9, cy + s * 0.06);
    ctx.stroke();
    const stn = (n: number, label: string, loaded: boolean) => {
      const x = r.x + s * (0.1 + ((n - 1) / 8) * 0.8);
      const y = cy + s * (0.06 - (1 - Math.abs(n - 5) / 4) * 0.16) + s * 0.08;
      text(ctx, String(n), x, y - s * 0.07, s * 0.045, GREEN, 'center', MONO);
      if (loaded && label) text(ctx, label, x, y, s * 0.04, GREEN, 'center', MONO);
    };
    stn(1, '9M', L.airStores[0] !== false);
    stn(2, '', false);
    stn(3, '65D', L.stores[0] !== false);
    stn(4, '', false);
    stn(5, '', false);
    stn(6, '', false);
    stn(7, '65D', L.stores[1] !== false);
    stn(8, '', false);
    stn(9, '9M', L.airStores[1] !== false);
    const nAim = L.airStores.filter((x) => x !== false).length;
    const nMav = L.stores.filter((x) => x !== false).length;
    text(ctx, `${nAim} AIM-9M   ${nMav} AGM-65D`, r.x + s / 2, r.y + s * 0.72, s * 0.05, GREEN, 'center', MONO);
    text(ctx, 'RDY   SLAV', r.x + s / 2, r.y + s * 0.82, s * 0.05, GREEN, 'center', MONO);
  }

  function ded(L: LiveReadings) {
    const r = rectOf('ded');
    ctx.fillStyle = '#030402';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    const t = Math.floor(L.time) + 9 * 3600 + 32 * 60;
    const hh = String(Math.floor(t / 3600) % 24).padStart(2, '0');
    const mm = String(Math.floor(t / 60) % 60).padStart(2, '0');
    const ss = String(t % 60).padStart(2, '0');
    const lines = ['UHF  292.30  STPT ▲  1', '', `VHF   1       ${hh}:${mm}:${ss}`, '             M3 4000', 'TCN 109X   C  HACK'];
    lines.forEach((l, k) => text(ctx, l, r.x + 5, r.y + 7 + k * 13, 12, '#c4f25c', 'left', MONO));
  }

  function rwr(L: LiveReadings) {
    const r = rectOf('rwr');
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const R = r.w / 2.2;
    ctx.fillStyle = '#020302';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = 'rgba(70,228,106,0.35)';
    ctx.lineWidth = 2;
    for (const f of [0.33, 0.66, 0.97]) {
      ctx.beginPath();
      ctx.arc(cx, cy, R * f, 0, TAU);
      ctx.stroke();
    }
    for (let a = 0; a < 360; a += 30) {
      const t = a * DEG;
      ctx.beginPath();
      ctx.moveTo(cx + Math.sin(t) * R * 0.9, cy - Math.cos(t) * R * 0.9);
      ctx.lineTo(cx + Math.sin(t) * R * 0.97, cy - Math.cos(t) * R * 0.97);
      ctx.stroke();
    }
    // Ownship symbol.
    ctx.strokeStyle = GREEN;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 9);
    ctx.lineTo(cx, cy + 9);
    ctx.moveTo(cx - 9, cy + 1);
    ctx.lineTo(cx + 9, cy + 1);
    ctx.moveTo(cx - 4, cy + 8);
    ctx.lineTo(cx + 4, cy + 8);
    ctx.stroke();
    // Two ground search radars at world-fixed bearings (they swing round as the jet turns).
    for (const [brg, sym, f] of [[35, 'S', 0.82], [250, 'S', 0.74]] as [number, string, number][]) {
      const a = (brg - L.headingDeg) * DEG;
      text(ctx, sym, cx + Math.sin(a) * R * f, cy - Math.cos(a) * R * f, 18, GREEN, 'center', MONO);
    }
  }

  function lamp(k: LiveRect, on: boolean, onCol: string, offCol: string, label: string, labelOn = '#101010', size = 13) {
    const r = rectOf(k);
    ctx.fillStyle = on ? onCol : offCol;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    if (on) {
      const g = ctx.createRadialGradient(r.x + r.w / 2, r.y + r.h / 2, 2, r.x + r.w / 2, r.y + r.h / 2, r.w * 0.7);
      g.addColorStop(0, 'rgba(255,255,255,0.35)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
    if (label) {
      const parts = label.split('\n');
      parts.forEach((p, i) => text(ctx, p, r.x + r.w / 2, r.y + r.h / 2 + (i - (parts.length - 1) / 2) * size * 1.05, size, on ? labelOn : 'rgba(0,0,0,0.55)'));
    }
  }

  function eyebrows(L: LiveReadings) {
    // Left: AOA indexer (lit with the gear down) and TF FAIL.
    {
      const r = rectOf('eyebrowL');
      ctx.fillStyle = '#0c0c0c';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      const lit = L.gearPos > 0.5 && L.engineRunning;
      const slow = lit && L.aoaDeg > 13.5;
      const on = lit && L.aoaDeg >= 11 && L.aoaDeg <= 13.5;
      const fast = lit && L.aoaDeg < 11;
      const cx = r.x + r.w * 0.3;
      const sym = (y: number, col: string, onState: boolean, draw: () => void) => {
        ctx.strokeStyle = onState ? col : 'rgba(80,80,80,0.5)';
        ctx.lineWidth = 6;
        ctx.beginPath();
        draw();
        ctx.stroke();
        void y;
      };
      sym(0, '#58f070', slow, () => {
        ctx.moveTo(cx - 16, r.y + 12);
        ctx.lineTo(cx, r.y + 32);
        ctx.lineTo(cx + 16, r.y + 12);
      });
      sym(0, '#f0b030', on, () => ctx.arc(cx, r.y + r.h / 2, 11, 0, TAU));
      sym(0, '#f04030', fast, () => {
        ctx.moveTo(cx - 16, r.y + r.h - 12);
        ctx.lineTo(cx, r.y + r.h - 32);
        ctx.lineTo(cx + 16, r.y + r.h - 12);
      });
      ctx.fillStyle = '#160605';
      ctx.fillRect(r.x + r.w * 0.58, r.y + r.h * 0.3, r.w * 0.38, r.h * 0.4);
      text(ctx, 'TF', r.x + r.w * 0.77, r.y + r.h * 0.43, 12, 'rgba(0,0,0,0.6)');
      text(ctx, 'FAIL', r.x + r.w * 0.77, r.y + r.h * 0.57, 12, 'rgba(0,0,0,0.6)');
    }
    // Right: the warning lights (2 × 4).
    {
      const r = rectOf('eyebrowR');
      ctx.fillStyle = '#0c0c0c';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      const names = ['ENG FIRE', 'ENGINE', 'HYD/OIL\nPRESS', 'FLCS', 'DBU ON', 'TO/LDG\nCONFIG', 'CANOPY', 'OXY LOW'];
      const lit = [false, !L.engineRunning, !L.engineRunning, false, false, L.toLdgConfig, false, false];
      const cw = (r.w - 6) / 2;
      const ch = (r.h - 6) / 4;
      names.forEach((n, i) => {
        const x = r.x + 3 + (i % 2) * cw;
        const y = r.y + 3 + Math.floor(i / 2) * ch;
        ctx.fillStyle = lit[i] ? '#ff3a24' : '#170706';
        ctx.fillRect(x + 2, y + 2, cw - 4, ch - 4);
        const parts = n.split('\n');
        parts.forEach((p, k) => text(ctx, p, x + cw / 2, y + ch / 2 + (k - (parts.length - 1) / 2) * 11, 10, lit[i] ? '#2a0500' : 'rgba(0,0,0,0.6)'));
      });
    }
  }

  return {
    draw(v, handleDown) {
      const t0 = performance.now();
      drawAll(v, handleDown);
      const ms = performance.now() - t0;
      LIVE_STATS.draws++;
      LIVE_STATS.lastMs = ms;
      LIVE_STATS.maxMs = Math.max(LIVE_STATS.maxMs, ms);
      LIVE_STATS.totalMs += ms;
    },
  };

  function drawAll(v: AircraftVisualState, handleDown: boolean) {
    {
      const L = liveReadings(v, handleDown);
      const t = L.time;
      fcr(t, L);
      sms(L);
      ded(L);
      rwr(L);
      attitude('adi', L.pitchDeg, L.rollDeg, false);
      attitude('sai', L.pitchDeg, L.rollDeg, true);
      hsi(L.headingDeg);
      {
        const { cx, cy, R, r } = blit('airspeed');
        ctx.fillStyle = '#050505';
        ctx.fillRect(cx - R * 0.3, cy + R * 0.12, R * 0.6, R * 0.2);
        text(ctx, L.mach.toFixed(2), cx, cy + R * 0.22, R * 0.15, WHITE, 'center', MONO);
        needle(ctx, cx, cy, R, iasAngle(L.airspeedKt));
        void r;
      }
      {
        const { cx, cy, R } = blit('altimeter');
        const ft = Math.max(0, L.altitudeFt);
        ctx.fillStyle = '#050505';
        ctx.fillRect(cx - R * 0.1, cy - R * 0.4, R * 0.62, R * 0.22);
        text(ctx, String(Math.floor(ft / 1000)).padStart(2, '0') + String(Math.floor((ft % 1000) / 100)), cx + R * 0.21, cy - R * 0.29, R * 0.17, WHITE, 'center', MONO);
        ctx.fillRect(cx - R * 0.25, cy + R * 0.22, R * 0.5, R * 0.18);
        text(ctx, '29.92', cx, cy + R * 0.31, R * 0.13, WHITE, 'center', MONO);
        needle(ctx, cx, cy, R, ((ft % 1000) / 1000) * TAU);
      }
      {
        const { cx, cy, R } = blit('vvi');
        needle(ctx, cx, cy, R, vviAngle(L.vsFpm) + Math.PI / 2);
      }
      {
        const { cx, cy, R } = blit('fuel');
        const half = L.fuelLb / 2;
        needle(ctx, cx, cy, R, (-135 + (half / 4000) * 270) * DEG, WHITE, 0.05);
        needle(ctx, cx, cy, R, (-135 + ((half * 0.98) / 4000) * 270) * DEG, '#e05a3a', 0.04, 0.7);
        ctx.fillStyle = '#050505';
        ctx.fillRect(cx - R * 0.34, cy + R * 0.4, R * 0.68, R * 0.22);
        text(ctx, String(Math.round(L.fuelLb / 10) * 10).padStart(5, '0'), cx, cy + R * 0.51, R * 0.16, WHITE, 'center', MONO);
      }
      const eng = (k: LiveRect, frac: number) => {
        const { cx, cy, R } = blit(k);
        needle(ctx, cx, cy, R, (-140 + clamp(frac, 0, 1) * 280) * DEG, WHITE, 0.07);
      };
      eng('ftit', (L.ftitC - 200) / 1000);
      eng('rpm', L.rpmPct / 100);
      eng('noz', L.nozzlePct / 100);
      eng('oil', L.oilPsi / 100);
      // Lights.
      const down = L.gearPos >= 0.999;
      lamp('gear0', down, '#3cf060', '#0a160c', '');
      lamp('gear1', down, '#3cf060', '#0a160c', '');
      lamp('gear2', down, '#3cf060', '#0a160c', '');
      lamp('masterCaution', L.masterCaution, '#ffb020', '#0f0b03', 'MASTER\nCAUTION', '#221400', 15);
      lamp('tfFail', false, '#ff3a24', '#0e0404', 'TF FAIL', '#220000', 15);
      eyebrows(L);
    }
  }
}
