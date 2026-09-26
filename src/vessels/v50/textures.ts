/**
 * Princess V50 canvas textures, painted in code (browser only; null in node): the teak planking
 * with its black caulking seams (1 m square tile, planks along the texture's v = body z), the two
 * helm displays (chart plotter and engine page, repainted live from the helm readings — see
 * screens.ts), and the transom name board ("TATER TOT", the
 * config's registration, over the port of registry).
 */
import * as THREE from 'three';
import type { V50Textures } from './materials';
import type { ScreenData } from './screens';

/** Teak tile: 1 m × 1 m, planks 70 mm wide. */
export const TEAK_TILE = { px: 512, plankM: 0.07 } as const;
/** Displays: two 4:3 screens side by side. */
export const SCREENS_TEX = { width: 1024, height: 384 } as const;
export const NAME_TEX = { width: 1024, height: 256 } as const;

/** Tiny deterministic hash → [0, 1). */
function hash(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function paintTeak(ctx: CanvasRenderingContext2D, px: number) {
  const plankPx = (TEAK_TILE.plankM / 1) * px;
  const n = Math.round(px / plankPx);
  const w = px / n;
  for (let k = 0; k < n; k++) {
    const t = hash(k);
    const r = 176 + t * 26;
    const g = 128 + t * 20;
    const b = 84 + t * 14;
    ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
    ctx.fillRect(k * w, 0, w, px);
    // Grain: fine streaks along the plank.
    for (let s = 0; s < 14; s++) {
      const x = k * w + hash(k * 31 + s) * w;
      ctx.fillStyle = `rgba(90,58,30,${0.05 + 0.08 * hash(k * 7 + s)})`;
      ctx.fillRect(x, 0, 1 + hash(s + k) * 1.5, px);
    }
    // Butt joints, staggered.
    ctx.fillStyle = 'rgba(30,24,18,0.8)';
    ctx.fillRect(k * w, ((hash(k + 99) * px) | 0) % px, w, 2);
    // Caulking seam.
    ctx.fillStyle = '#1c1a17';
    ctx.fillRect(k * w, 0, Math.max(2, w * 0.09), px);
  }
}

/** Maximum engine rpm on the tachometer dials. */
const TACH_MAX = 4000;

/**
 * Paint both helm displays. Left: a heading-up chart plotter (own ship fixed, the chart turning
 * under it, heading line, HDG / SOG / STW / DPT). Right: the engine page (two tachometers with
 * rpm, gear and load, then lever, drives, tabs and trim). `d` null = the idle look (engines at
 * idle, alongside) used when the sim passes no instruments.
 */
export function paintScreens(ctx: CanvasRenderingContext2D, W: number, H: number, d: ScreenData | null) {
  const half = W / 2;
  const m = 10;
  const hdg = d?.headingDeg ?? 0;
  ctx.save();
  ctx.fillStyle = '#05070a';
  ctx.fillRect(0, 0, W, H);

  // ── Chart plotter (heading up) ──
  ctx.save();
  ctx.beginPath();
  ctx.rect(m, m, half - 2 * m, H - 2 * m);
  ctx.clip();
  ctx.fillStyle = '#9fd0ea';
  ctx.fillRect(m, m, half - 2 * m, H - 2 * m);
  const ox = half * 0.5;
  const oy = H * 0.66;
  ctx.translate(ox, oy);
  ctx.rotate((-hdg * Math.PI) / 180);
  ctx.fillStyle = '#e7dca8';
  ctx.beginPath();
  ctx.moveTo(-420, -420);
  ctx.lineTo(60, -420);
  ctx.bezierCurveTo(-10, -260, -120, -230, -100, -120);
  ctx.bezierCurveTo(-90, -40, -200, -10, -420, 40);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(230, -180, 70, 40, 0.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(40,90,140,0.55)';
  ctx.lineWidth = 2;
  for (let k = 1; k <= 3; k++) {
    ctx.beginPath();
    ctx.ellipse(-150, -180, 80 + k * 45, 55 + k * 40, 0.3, 0, Math.PI * 2);
    ctx.stroke();
  }
  // North arrow on the chart.
  ctx.fillStyle = '#b02030';
  ctx.beginPath();
  ctx.moveTo(0, -150);
  ctx.lineTo(-8, -128);
  ctx.lineTo(8, -128);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  // Own ship (heading up) and its heading line.
  ctx.strokeStyle = '#cc2030';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(ox, oy);
  ctx.lineTo(ox, m + 50);
  ctx.stroke();
  ctx.fillStyle = '#10151c';
  ctx.beginPath();
  ctx.moveTo(ox, oy - 16);
  ctx.lineTo(ox - 9, oy + 12);
  ctx.lineTo(ox + 9, oy + 12);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(8,16,26,0.85)';
  ctx.fillRect(m, m, half - 2 * m, 42);
  ctx.fillRect(m, H - m - 44, half - 2 * m, 44);
  ctx.fillStyle = '#e8f2f8';
  ctx.font = 'bold 26px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`HDG ${String(Math.round(hdg)).padStart(3, '0')}°`, m + 12, m + 30);
  ctx.textAlign = 'right';
  const status = d?.aground ? 'AGROUND' : d === null || d.moored ? 'MOORED' : 'UNDER WAY';
  ctx.fillStyle = d?.aground ? '#ff8a3c' : '#9fe0a8';
  ctx.fillText(status, half - m - 12, m + 30);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#e8f2f8';
  const sog = d ? d.sogKt.toFixed(1) : '0.0';
  const stw = d ? d.stwKt.toFixed(1) : '0.0';
  const dpt = d ? (d.depthM === null ? '---' : d.depthM.toFixed(1)) : '6.2';
  ctx.fillText(`SOG ${sog} kn  STW ${stw}  DPT ${dpt} m`, m + 12, H - m - 14);

  // ── Engine page ──
  const x0 = half + m;
  const w0 = half - 2 * m;
  ctx.fillStyle = '#0b1622';
  ctx.fillRect(x0, m, w0, H - 2 * m);
  const gear = d?.gear ?? 'neutral';
  for (let e = 0; e < 2; e++) {
    const rpm = d ? (d.rpm[e] ?? 0) : 700;
    const load = d ? (d.loadPct[e] ?? 0) : 8;
    const cx = x0 + w0 * (0.27 + 0.46 * e);
    const cy = H * 0.42;
    const r = 92;
    const a0 = Math.PI * 0.75;
    const a1 = Math.PI * 2.25;
    const at = (x: number) => a0 + (a1 - a0) * Math.max(0, Math.min(1, x / TACH_MAX));
    ctx.lineWidth = 14;
    ctx.strokeStyle = '#2c3e50';
    ctx.beginPath();
    ctx.arc(cx, cy, r, a0, a1);
    ctx.stroke();
    ctx.strokeStyle = '#34c3ff';
    ctx.beginPath();
    ctx.arc(cx, cy, r, a0, at(rpm));
    ctx.stroke();
    ctx.strokeStyle = '#e04030';
    ctx.beginPath();
    ctx.arc(cx, cy, r, at(3500), a1);
    ctx.stroke();
    ctx.fillStyle = '#e8f2f8';
    ctx.textAlign = 'center';
    ctx.font = 'bold 40px sans-serif';
    ctx.fillText(String(Math.round(rpm)), cx, cy + 10);
    ctx.font = '19px sans-serif';
    ctx.fillText(e === 0 ? 'PORT RPM' : 'STBD RPM', cx, cy + 38);
    ctx.font = 'bold 26px sans-serif';
    ctx.fillStyle = gear === 'ahead' ? '#7ee08a' : gear === 'astern' ? '#ff9a4a' : '#e8d86a';
    ctx.fillText(gear === 'ahead' ? 'F' : gear === 'astern' ? 'R' : 'N', cx, cy - 32);
    ctx.fillStyle = '#9fb4c8';
    ctx.font = '19px sans-serif';
    ctx.fillText(`LOAD ${Math.round(load)} %`, cx, cy + r + 30);
  }
  ctx.textAlign = 'left';
  ctx.fillStyle = '#9fb4c8';
  ctx.font = '21px sans-serif';
  const lever = d ? d.leverPct : 0;
  const tabs = d ? d.tabsPct : 0;
  const trim = d ? d.trimDeg : 0;
  const steer = d ? d.steerDeg : 0;
  ctx.fillText(`LEVER ${lever > 0 ? '+' : ''}${Math.round(lever)}%  DRV ${Math.round(steer)}°  TABS ${Math.round(tabs)}%  TRIM ${trim.toFixed(1)}°`, x0 + 14, H - m - 16);
  ctx.restore();
}

function paintName(ctx: CanvasRenderingContext2D, W: number, H: number, name: string, port: string) {
  ctx.clearRect(0, 0, W, H);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = 'italic 700 132px Georgia, "Times New Roman", serif';
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(200,205,210,0.9)';
  ctx.strokeText(name, W / 2, H * 0.62);
  ctx.fillStyle = '#15181d';
  ctx.fillText(name, W / 2, H * 0.62);
  ctx.font = '600 44px Georgia, "Times New Roman", serif';
  ctx.fillStyle = '#2a2f36';
  ctx.fillText(port, W / 2, H * 0.9);
}

/** Paint every texture (null outside a browser). */
export function createV50Textures(registration: string, port = 'PLYMOUTH'): { tex: V50Textures; screensCtx: CanvasRenderingContext2D } | null {
  if (typeof document === 'undefined') return null;
  const canvas = (w: number, h: number) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  };
  const tc = canvas(TEAK_TILE.px, TEAK_TILE.px);
  const sc = canvas(SCREENS_TEX.width, SCREENS_TEX.height);
  const nc = canvas(NAME_TEX.width, NAME_TEX.height);
  const t = tc.getContext('2d');
  const s = sc.getContext('2d');
  const n = nc.getContext('2d');
  if (!t || !s || !n) return null;
  paintTeak(t, TEAK_TILE.px);
  paintScreens(s, SCREENS_TEX.width, SCREENS_TEX.height, null);
  paintName(n, NAME_TEX.width, NAME_TEX.height, registration, port);
  const tex = (c: HTMLCanvasElement, aniso: number) => {
    const x = new THREE.CanvasTexture(c);
    x.colorSpace = THREE.SRGBColorSpace;
    x.anisotropy = aniso;
    return x;
  };
  const teak = tex(tc, 8);
  teak.wrapS = teak.wrapT = THREE.RepeatWrapping;
  return { tex: { teak, screens: tex(sc, 4), name: tex(nc, 4) }, screensCtx: s };
}
