/**
 * The F-16's head-up display, drawn on a transparent canvas over the centre of the view:
 * a pitch ladder that rolls with the aircraft (a right bank rotates it counter-clockwise, exactly
 * like the real horizon seen from the cockpit), the gun cross (boresight), the flight-path marker
 * (α below and β beside the boresight), airspeed and altitude tapes with boxed readouts, a
 * heading tape (bottom; it moves to the top with the gear down, as in the jet, to keep the runway
 * clear), Mach, g and max g, AoA, throttle/afterburner, radar altitude and the gear/speed-brake cues.
 *
 * `jetHudGeometry`, `ladderRungs`, `headingTapeMarks` are pure (tested); `drawJetHud` never throws
 * and never emits NaN, whatever the readings hold. Canvas angles: positive = clockwise (y down).
 */
import { CONFIG, type Config } from '../config';
import type { InstrumentReadings } from '../types';

/** Readings plus the jet extras from instruments.ts (optional so plain readings work too). */
export type JetReadings = InstrumentReadings & { betaDeg?: number; flightPathDeg?: number; speedBrake?: boolean };

export const JET_HUD_COLOR = CONFIG.hud.jet.color;

const DEG = Math.PI / 180;
const FONT = '"SF Mono", ui-monospace, Menlo, Consolas, "DejaVu Sans Mono", monospace';

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

export interface Pt {
  x: number;
  y: number;
}

export interface JetHudGeometry {
  /** Pixels per degree of pitch (ladder spacing, FPM displacement). */
  ppd: number;
  /** Gun cross: the aircraft's nose (fixed in the HUD). */
  bore: Pt;
  /** Ladder rotation, canvas radians (−roll: a right bank turns it counter-clockwise). */
  rotation: number;
  /** Horizon line below the boresight along the rolled vertical, px (pitch × ppd; nose up → below). */
  horizonOffset: number;
  /** Flight-path marker (clamped inside the HUD). */
  fpm: Pt;
}

export function jetHudGeometry(r: JetReadings, w: number, h: number, cfg: Config = CONFIG): JetHudGeometry {
  const W = sz(w);
  const H = sz(h);
  const j = cfg.hud.jet;
  const ppd = H / Math.max(5, j.degPerHeight);
  const bore = { x: W / 2, y: H * j.boresightY };
  let roll = wrap180(fin(r.rollDeg));
  if (roll === -180) roll = 180;
  const pitch = clamp(fin(r.pitchDeg), -90, 90);
  const aoa = clamp(fin(r.aoaDeg), -30, 60);
  const beta = clamp(fin(r.betaDeg), -45, 45);
  return {
    ppd,
    bore,
    rotation: -roll * DEG,
    horizonOffset: pitch * ppd,
    fpm: { x: clamp(bore.x + beta * ppd, W * 0.08, W * 0.92), y: clamp(bore.y + aoa * ppd, H * 0.06, H * 0.94) },
  };
}

export interface Rung {
  deg: number;
  /** Offset below the boresight along the rolled vertical, px. */
  offset: number;
}

/** Visible pitch-ladder rungs, every 5° (0 = the horizon line). */
export function ladderRungs(g: JetHudGeometry, h: number): Rung[] {
  const H = sz(h);
  const out: Rung[] = [];
  if (!(g.ppd > 0)) return out;
  for (let deg = -90; deg <= 90; deg += 5) {
    const offset = g.horizonOffset - deg * g.ppd;
    if (Math.abs(offset) <= H * 1.1) out.push({ deg, offset });
  }
  return out;
}

export interface TapeMark {
  /** Card heading 0..359. */
  deg: number;
  /** Offset from the tape centre, px (+ right). */
  x: number;
  major: boolean;
  /** Tens of degrees, two digits ("09" = 090°, "36" = north), on the major marks. */
  label: string;
}

/** Heading-tape marks every 5° across `width` px (±20° visible). */
export function headingTapeMarks(headingDeg: number, width: number): TapeMark[] {
  const W = sz(width);
  const hdg = wrap360(headingDeg);
  const ppd = W / 40;
  const out: TapeMark[] = [];
  if (!(ppd > 0)) return out;
  for (let d = Math.ceil((hdg - 21) / 5) * 5; d <= hdg + 21; d += 5) {
    const dd = wrap360(d);
    const major = dd % 10 === 0;
    out.push({ deg: dd, x: (d - hdg) * ppd, major, label: major ? (dd === 0 ? '36' : String(dd / 10).padStart(2, '0')) : '' });
  }
  return out;
}

export interface JetHeadingTape {
  /** Tape baseline, px from the HUD box top. */
  y: number;
  /** Half the tape width and px per degree (±20° visible). */
  halfWidth: number;
  ppd: number;
  /** Ticks rise from the bottom tape (−1) and hang from the top one (+1, gear down). */
  dir: 1 | -1;
}

/** Where the heading tape sits in a w×h HUD box: bottom, or top with the gear down (shared with the weapons HUD's range caret). */
export function jetHeadingTape(w: number, h: number, gearUp: boolean): JetHeadingTape {
  const W = sz(w);
  const H = sz(h);
  const tw = W * 0.46;
  return { y: gearUp ? H * 0.88 : H * 0.12, halfWidth: tw / 2, ppd: tw / 40, dir: gearUp ? -1 : 1 };
}

/**
 * A-10 variant: with a gun line depressed below the datum (the GAU-8's 2°) the weapons HUD draws the
 * real, conformal gun cross, so the jet HUD leaves its fixed boresight cross out (no second cross).
 */
export function jetHudOmitsGunCross(cfg: Config = CONFIG): boolean {
  const gun = cfg.weapons?.gun;
  return !!gun && Math.abs(gun.boresightDownDeg) > cfg.hud.weapons.separateGunCrossAboveDeg;
}

// ─── State (max g) ───────────────────────────────────────────────────────────

export interface JetHudState {
  maxG: number;
}

export function createJetHudState(): JetHudState {
  return { maxG: 1 };
}

/** Remember the peak g since the last reset. */
export function trackJetHud(s: JetHudState, r: JetReadings): void {
  const g = fin(r.gLoad, NaN);
  if (Number.isFinite(g) && g > s.maxG) s.maxG = Math.min(g, 99);
}

// ─── Drawing ─────────────────────────────────────────────────────────────────

const fmtThousands = (v: number): string => {
  const n = Math.round(v);
  const s = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return n < 0 ? `-${s}` : s;
};

/**
 * Draw the whole HUD into a w×h area at the context's origin (CSS px). The caller clears the
 * canvas. `st` carries the max-g memory (see trackJetHud).
 */
export function drawJetHud(ctx: CanvasRenderingContext2D, w: number, h: number, r: JetReadings, st: JetHudState, cfg: Config = CONFIG): void {
  const W = sz(w);
  const H = sz(h);
  if (!W || !H) return;
  const j = cfg.hud.jet;
  const green = j.color;
  const g = jetHudGeometry(r, W, H, cfg);
  const lw = Math.max(1.2, H * 0.0034);
  const small = Math.max(9, H * 0.03);
  const big = Math.max(11, H * 0.038);

  const strokeBoth = (build: () => void, width = lw) => {
    ctx.beginPath();
    build();
    ctx.strokeStyle = j.halo;
    ctx.lineWidth = width * 2.6;
    ctx.stroke();
    ctx.beginPath();
    build();
    ctx.strokeStyle = green;
    ctx.lineWidth = width;
    ctx.stroke();
  };
  const text = (s: string, x: number, y: number, px: number, align: CanvasTextAlign = 'center', weight = 600) => {
    ctx.font = `${weight} ${px.toFixed(1)}px ${FONT}`;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.lineWidth = Math.max(2, px * 0.22);
    ctx.strokeStyle = j.halo;
    ctx.strokeText(s, x, y);
    ctx.fillStyle = green;
    ctx.fillText(s, x, y);
  };

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // ── Pitch ladder (rolled about the boresight, clipped to the middle of the HUD) ──
  // The ladder keeps clear of the heading tape (bottom with the gear up, top with it down).
  const tapeTop = r.gear !== 'up';
  ctx.save();
  ctx.beginPath();
  ctx.rect(W * 0.2, tapeTop ? H * 0.19 : H * 0.03, W * 0.6, H * 0.77);
  ctx.clip();
  ctx.translate(g.bore.x, g.bore.y);
  ctx.rotate(g.rotation);
  const rungs = ladderRungs(g, H);
  const half = W * 0.15;
  const gap = W * 0.06;
  const tick = H * 0.018;
  // Horizon: one long line across the HUD.
  strokeBoth(() => {
    ctx.moveTo(-W * 0.9, g.horizonOffset);
    ctx.lineTo(W * 0.9, g.horizonOffset);
  });
  const rungPath = (up: boolean) => () => {
    for (const k of rungs) {
      if (k.deg === 0 || k.deg > 0 !== up) continue;
      const y = k.offset;
      const t = up ? tick : -tick; // end ticks point toward the horizon
      ctx.moveTo(-half, y + t);
      ctx.lineTo(-half, y);
      ctx.lineTo(-gap, y);
      ctx.moveTo(gap, y);
      ctx.lineTo(half, y);
      ctx.lineTo(half, y + t);
    }
  };
  strokeBoth(rungPath(true));
  ctx.setLineDash([W * 0.022, W * 0.014]);
  strokeBoth(rungPath(false));
  ctx.setLineDash([]);
  for (const k of rungs) {
    if (k.deg === 0) continue;
    const s = String(Math.abs(k.deg));
    const dy = k.deg > 0 ? tick * 0.2 : -tick * 0.2;
    text(s, -half - small * 1.2, k.offset + dy, small);
    text(s, half + small * 1.2, k.offset + dy, small);
  }
  ctx.restore();

  // ── Gun cross (boresight) and flight-path marker ──
  const c = H * 0.02;
  if (!jetHudOmitsGunCross(cfg)) {
    strokeBoth(() => {
      ctx.moveTo(g.bore.x - c, g.bore.y);
      ctx.lineTo(g.bore.x + c, g.bore.y);
      ctx.moveTo(g.bore.x, g.bore.y - c);
      ctx.lineTo(g.bore.x, g.bore.y + c * 0.6);
    });
  }
  const fr = H * 0.017;
  strokeBoth(() => {
    ctx.moveTo(g.fpm.x + fr, g.fpm.y);
    ctx.arc(g.fpm.x, g.fpm.y, fr, 0, Math.PI * 2);
    ctx.moveTo(g.fpm.x - fr, g.fpm.y);
    ctx.lineTo(g.fpm.x - fr * 2.7, g.fpm.y);
    ctx.moveTo(g.fpm.x + fr, g.fpm.y);
    ctx.lineTo(g.fpm.x + fr * 2.7, g.fpm.y);
    ctx.moveTo(g.fpm.x, g.fpm.y - fr);
    ctx.lineTo(g.fpm.x, g.fpm.y - fr * 2);
  });

  // ── Airspeed (left) and altitude (right) tapes with boxed readouts ──
  const span = H * 0.2;
  const tape = (x: number, value: number, unit: number, labelEvery: number, dir: 1 | -1, fmt: (v: number) => string, boxText: string) => {
    const pxPer = span / (unit * 4);
    const v0 = Math.floor((value - unit * 4) / unit) * unit;
    strokeBoth(() => {
      for (let v = v0; v <= value + unit * 4; v += unit) {
        const y = g.bore.y - (v - value) * pxPer;
        if (Math.abs(y - g.bore.y) > span) continue;
        const len = v % labelEvery === 0 ? H * 0.022 : H * 0.012;
        ctx.moveTo(x, y);
        ctx.lineTo(x - dir * len, y);
      }
    });
    for (let v = Math.ceil((value - unit * 4) / labelEvery) * labelEvery; v <= value + unit * 4; v += labelEvery) {
      const y = g.bore.y - (v - value) * pxPer;
      if (Math.abs(y - g.bore.y) > span || Math.abs(y - g.bore.y) < big * 1.1) continue;
      text(fmt(v), x - dir * H * 0.03, y, small * 0.9, dir > 0 ? 'right' : 'left', 500);
    }
    // Box with the current value, pointing at the scale (wide enough for the digits: mono ≈ 0.62 em each).
    const bw = Math.max(big * 3.6, big * (0.62 * boxText.length + 1));
    const bh = big * 1.45;
    const bx = dir > 0 ? Math.max(1, x - H * 0.03 - bw) : Math.min(W - bw - 1, x + H * 0.03);
    strokeBoth(() => {
      ctx.rect(bx, g.bore.y - bh / 2, bw, bh);
    });
    text(boxText, bx + bw / 2, g.bore.y, big, 'center', 700);
  };
  const ias = Math.max(0, fin(r.airspeedKt));
  const alt = fin(r.altitudeFt);
  tape(W * 0.19, ias, 10, 50, 1, (v) => String(Math.max(0, v)), String(Math.round(ias)));
  tape(W * 0.81, alt, 100, 500, -1, (v) => fmtThousands(v), fmtThousands(Math.round(alt / 10) * 10));

  // ── Corner data ──
  const gl = fin(r.gLoad, 1);
  text(`G ${gl.toFixed(1)}`, W * 0.03, H * 0.05, big, 'left', 700);
  text(`MAX ${Math.max(st.maxG, gl).toFixed(1)}`, W * 0.03, H * 0.05 + big * 1.2, small, 'left');
  const low = g.bore.y + span + big * 1.2;
  text(`M ${Math.max(0, fin(r.mach)).toFixed(2)}`, W * 0.03, low, big, 'left', 700);
  text(`AOA ${fin(r.aoaDeg).toFixed(1)}`, W * 0.03, low + big * 1.3, small, 'left');
  const thr = clamp(fin(r.throttlePct), 0, 100);
  text(`THR ${Math.round(thr)}%`, W * 0.97, H * 0.05, big, 'right', 700);
  const ab = clamp(fin(r.afterburner), 0, 1);
  const eng = r.engineStatus === 'OFF' || r.engineStatus === 'FAILED' ? `ENG ${r.engineStatus}` : '';
  if (ab > 0.02 || eng) text([ab > 0.02 ? 'AB' : '', eng].filter(Boolean).join('  '), W * 0.97, H * 0.05 + big * 1.2, small, 'right', 800);
  const agl = fin(r.altitudeAglFt);
  if (agl < 5000) text(`R ${fmtThousands(Math.round(agl / 10) * 10)}`, W * 0.97, low, big, 'right', 700);
  const vs = Math.round(fin(r.verticalSpeedFpm) / 10) * 10;
  text(`VS ${vs > 0 ? '+' : vs < 0 ? '−' : ''}${fmtThousands(Math.abs(vs))}`, W * 0.97, low + big * 1.3, small, 'right');

  // ── Heading tape: bottom, or top with the gear down ──
  const gearUp = r.gear === 'up';
  const htape = jetHeadingTape(W, H, gearUp);
  const tw = htape.halfWidth * 2;
  // Baseline: ticks and labels face the HUD's centre, the caret and the digital heading its edge.
  const ty = htape.y;
  const marks = headingTapeMarks(fin(r.headingDeg), tw);
  const tdir = htape.dir; // ticks rise from the bottom tape, hang from the top one
  strokeBoth(() => {
    for (const m of marks) {
      if (Math.abs(m.x) > tw / 2) continue;
      const x = W / 2 + m.x;
      ctx.moveTo(x, ty);
      ctx.lineTo(x, ty + tdir * (m.major ? H * 0.02 : H * 0.011));
    }
    // Caret under/over the tape centre.
    const cy = ty - tdir * H * 0.012;
    ctx.moveTo(W / 2 - H * 0.012, cy - tdir * H * 0.014);
    ctx.lineTo(W / 2, cy);
    ctx.lineTo(W / 2 + H * 0.012, cy - tdir * H * 0.014);
  });
  for (const m of marks) {
    if (!m.major || Math.abs(m.x) > tw / 2 - small) continue;
    text(m.label, W / 2 + m.x, ty + tdir * H * 0.042, small);
  }
  text(String(Math.round(wrap360(fin(r.headingDeg))) % 360).padStart(3, '0'), W / 2, ty - tdir * H * 0.058, small, 'center', 700);

  // ── Configuration cues, under the vertical speed ──
  let cy = low + big * 2.5;
  if (r.gear !== 'up') {
    text(r.gear === 'down' ? 'GEAR DN' : 'GEAR ⇅', W * 0.97, cy, small, 'right', 700);
    cy += big * 1.2;
  }
  if (r.speedBrake) text('SPD BRK', W * 0.97, cy, small, 'right', 700);

  ctx.restore();
}
