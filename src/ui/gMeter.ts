/**
 * The G meter: a round accelerometer like the one on an aerobatic panel — a needle for the load
 * factor now, orange tell-tale needles that stay at the highest and lowest g since the last reset,
 * red marks at the aircraft's own limits (Cessna +3.8 / −1.52, A-10 +7.33 / −3, F-16 +9 / −3) and a
 * big digital readout that turns amber near a limit and red past it. Pure model + canvas drawing.
 */
import { CONFIG } from '../config';

/** The dial: −4 g … +10 g over 270°, angles in degrees clockwise from 12 o'clock. */
export const G_DIAL = { minG: -4, maxG: 10, startDeg: -135, sweepDeg: 270 } as const;

export interface GTrack {
  /** Smoothed load factor, g. */
  g: number;
  max: number;
  min: number;
}

export type GZone = 'normal' | 'caution' | 'over';

export interface GMeterModel {
  angle: number;
  maxAngle: number;
  minAngle: number;
  limitPos: number;
  limitNeg: number;
  limitPosAngle: number;
  limitNegAngle: number;
  cautionPosAngle: number;
  cautionNegAngle: number;
  zone: GZone;
  text: string;
  maxText: string;
  minText: string;
}

export const createGTrack = (): GTrack => ({ g: 1, max: 1, min: 1 });

export function resetGTrack(t: GTrack): void {
  t.g = 1;
  t.max = 1;
  t.min = 1;
}

/** Ease the needle toward `g` (bad values are ignored) and update the tell-tales. */
export function stepGTrack(t: GTrack, g: number, dt: number, tau: number = CONFIG.hud.gMeter.tau): void {
  if (Number.isFinite(g) && Number.isFinite(dt) && dt > 0) {
    const target = Math.max(-20, Math.min(20, g));
    const a = 1 - Math.exp(-dt / Math.max(1e-3, tau));
    t.g += (target - t.g) * a;
  }
  if (t.g > t.max) t.max = t.g;
  if (t.g < t.min) t.min = t.g;
}

export function gAngle(g: number): number {
  const c = Math.max(G_DIAL.minG, Math.min(G_DIAL.maxG, Number.isFinite(g) ? g : 1));
  return G_DIAL.startDeg + ((c - G_DIAL.minG) / (G_DIAL.maxG - G_DIAL.minG)) * G_DIAL.sweepDeg;
}

/** "+3.4" / "−0.5" (a real minus sign). */
export function gText(g: number): string {
  const v = Math.round((Number.isFinite(g) ? g : 0) * 10) / 10;
  return `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(1)}`;
}

export function gMeterModel(t: GTrack, limits: { gLimitPos: number; gLimitNeg: number }, cautionFraction: number = CONFIG.hud.gMeter.cautionFraction): GMeterModel {
  const lp = limits.gLimitPos;
  const ln = limits.gLimitNeg;
  const g = t.g;
  const zone: GZone = g > lp || g < ln ? 'over' : g > lp * cautionFraction || g < ln * cautionFraction ? 'caution' : 'normal';
  return {
    angle: gAngle(g),
    maxAngle: gAngle(t.max),
    minAngle: gAngle(t.min),
    limitPos: lp,
    limitNeg: ln,
    limitPosAngle: gAngle(lp),
    limitNegAngle: gAngle(ln),
    cautionPosAngle: gAngle(lp * cautionFraction),
    cautionNegAngle: gAngle(ln * cautionFraction),
    zone,
    text: gText(g),
    maxText: gText(t.max),
    minText: gText(t.min),
  };
}

const ZONE_COLOUR: Record<GZone, string> = { normal: '#f4f7fb', caution: '#ffc43d', over: '#ff4d4d' };

/** Draw the meter into a square canvas of `px` device pixels. */
export function drawGMeter(ctx: CanvasRenderingContext2D, px: number, m: GMeterModel, font = '-apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif'): void {
  const r = px / 2;
  const rad = (deg: number) => ((deg - 90) * Math.PI) / 180;
  const at = (deg: number, k: number) => [r + Math.cos(rad(deg)) * r * k, r + Math.sin(rad(deg)) * r * k] as const;
  ctx.clearRect(0, 0, px, px);
  // Bezel and face.
  ctx.beginPath();
  ctx.arc(r, r, r * 0.97, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(12, 16, 22, 0.72)';
  ctx.fill();
  ctx.lineWidth = r * 0.04;
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.stroke();
  // Caution arcs (amber) between the caution point and each limit.
  ctx.lineWidth = r * 0.07;
  ctx.strokeStyle = 'rgba(255, 196, 61, 0.85)';
  ctx.beginPath();
  ctx.arc(r, r, r * 0.8, rad(m.cautionPosAngle), rad(m.limitPosAngle));
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(r, r, r * 0.8, rad(m.limitNegAngle), rad(m.cautionNegAngle));
  ctx.stroke();
  // Ticks every 1 g, numbers every 2 g.
  ctx.strokeStyle = 'rgba(244,247,251,0.85)';
  ctx.fillStyle = 'rgba(244,247,251,0.9)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `600 ${Math.round(r * 0.2)}px ${font}`;
  for (let g: number = G_DIAL.minG; g <= G_DIAL.maxG; g++) {
    const a = gAngle(g);
    const major = g % 2 === 0;
    const [x0, y0] = at(a, major ? 0.7 : 0.76);
    const [x1, y1] = at(a, 0.86);
    ctx.lineWidth = major ? r * 0.035 : r * 0.02;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    if (major && g !== 10 && g !== -4) {
      const [tx, ty] = at(a, 0.55);
      ctx.fillText(String(g), tx, ty);
    }
  }
  // Red limit marks.
  ctx.strokeStyle = '#ff4d4d';
  ctx.lineWidth = r * 0.06;
  for (const a of [m.limitPosAngle, m.limitNegAngle]) {
    const [x0, y0] = at(a, 0.66);
    const [x1, y1] = at(a, 0.92);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }
  // Tell-tales (max / min) and the needle.
  const needle = (a: number, colour: string, w: number, len: number) => {
    const [x, y] = at(a, len);
    const [bx, by] = at(a + 180, 0.12);
    ctx.strokeStyle = colour;
    ctx.lineWidth = w;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(x, y);
    ctx.stroke();
  };
  needle(m.maxAngle, 'rgba(255, 150, 60, 0.9)', r * 0.03, 0.82);
  needle(m.minAngle, 'rgba(255, 150, 60, 0.9)', r * 0.03, 0.82);
  needle(m.angle, ZONE_COLOUR[m.zone], r * 0.06, 0.84);
  ctx.beginPath();
  ctx.arc(r, r, r * 0.07, 0, Math.PI * 2);
  ctx.fillStyle = '#2a3038';
  ctx.fill();
  // Digital readout.
  ctx.fillStyle = ZONE_COLOUR[m.zone];
  ctx.font = `700 ${Math.round(r * 0.34)}px ${font}`;
  const w = ctx.measureText(m.text).width;
  ctx.fillText(m.text, r - r * 0.07, r * 1.42);
  ctx.font = `700 ${Math.round(r * 0.19)}px ${font}`;
  ctx.textAlign = 'left';
  ctx.fillText('G', r - r * 0.07 + w / 2 + r * 0.04, r * 1.46);
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(244,247,251,0.75)';
  ctx.font = `600 ${Math.round(r * 0.15)}px ${font}`;
  ctx.fillText(`${m.maxText} / ${m.minText}`, r, r * 1.7);
}
