/**
 * The F-16's paint, drawn on canvas: USAF "Hill Gray II" counter-shading — FS 36118 gunship grey
 * over the spine and nose, FS 36270 on the sides, wings, stabilators and fin, FS 36375 underneath
 * — with soft sprayed demarcations, panel lines and fasteners (also as a bump map), touch-up
 * patches, exhaust and gun soot, stencils, the subdued national insignia (intake sides, left upper
 * / right lower wing), "USAF", the Shaw "SW" tail code, a 77th FS red tail band and the serial
 * AF 90-772 (90-0772). Also paints the roughness map. All regions come from `atlas.ts`.
 */
import * as THREE from 'three';
import { ATLAS_SIZE, CELL, RANGE, SWATCH, cowlUV, finUV, fuselageUV, stabUV, uvToPx, wingUV, type Cell } from './atlas';
import type { FuselageStationInfo } from './fuselage';
import { EDGE_INDEX } from './shape';

const S = ATLAS_SIZE;
export const FS36118 = '#4a4f54';
export const FS36270 = '#7b8186';
export const FS36375 = '#9da2a6';
const INTERIOR = '#2b2d2f';
const WELL = '#d9dad5';

type Ctx = CanvasRenderingContext2D;

/** Deterministic PRNG (mulberry32) so the paint is identical every build. */
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

const px = (uv: [number, number]) => uvToPx(uv[0], uv[1], S);
const F = (z: number, s: number) => px(fuselageUV(z, s));

function cellRect(c: Cell): [number, number, number, number] {
  const [x0, y1] = uvToPx(c.u0, c.v0, S);
  const [x1, y0] = uvToPx(c.u1, c.v1, S);
  return [x0, y0, x1 - x0, y1 - y0];
}

/** Arc length on a station's lower surface where |x| = x (between the edge and the bottom). */
function sAtLowerX(st: FuselageStationInfo, x: number): number | null {
  const h = st.half;
  for (let k = EDGE_INDEX; k < h.length - 1; k++) {
    const a = h[k];
    const b = h[k + 1];
    if ((a[0] - x) * (b[0] - x) <= 0 && a[0] !== b[0]) {
      const t = (x - a[0]) / (b[0] - a[0]);
      return a[2] + (b[2] - a[2]) * t;
    }
  }
  return null;
}

/** Fill the fuselage band |s| < f(z) (f in metres, per station). */
function fuselageBand(ctx: Ctx, st: FuselageStationInfo[], lo: (s: FuselageStationInfo) => number, hi: (s: FuselageStationInfo) => number, sign: 1 | -1 | 0) {
  const sides: (1 | -1)[] = sign === 0 ? [1, -1] : [sign];
  for (const sd of sides) {
    ctx.beginPath();
    st.forEach((s, i) => {
      const [x, y] = F(s.z, sd * lo(s));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    for (let i = st.length - 1; i >= 0; i--) {
      const [x, y] = F(st[i].z, sd * hi(st[i]));
      ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
  }
}

function line(ctx: Ctx, pts: [number, number][]) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.stroke();
}

/** A panel line on colour + bump canvases (dark groove, faint highlight). */
function panelLine(col: Ctx, bump: Ctx, pts: [number, number][], rivets = false) {
  col.strokeStyle = 'rgba(20, 22, 24, 0.42)';
  col.lineWidth = 1.6;
  line(col, pts);
  bump.strokeStyle = '#4a4a4a';
  bump.lineWidth = 2.2;
  line(bump, pts);
  if (rivets) {
    bump.fillStyle = '#6a6a6a';
    col.fillStyle = 'rgba(30, 32, 34, 0.25)';
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[i + 1];
      const n = Math.max(1, Math.floor(Math.hypot(x1 - x0, y1 - y0) / 6));
      for (let k = 0; k <= n; k++) {
        const x = x0 + ((x1 - x0) * k) / n;
        const y = y0 + ((y1 - y0) * k) / n;
        // Offset the rivet row a few px from the seam.
        bump.fillRect(x + 3, y + 3, 1.3, 1.3);
        col.fillRect(x + 3, y + 3, 1.2, 1.2);
      }
    }
  }
}

function panelRect(col: Ctx, bump: Ctx, x: number, y: number, w: number, h: number, rivets = true) {
  panelLine(col, bump, [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]], rivets);
}

/** USAF national insignia (star in circle with bars), centred, `r` = circle radius px. */
function insignia(ctx: Ctx, cx: number, cy: number, r: number, color: string, rot = 0) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(1.5, r * 0.07);
  // Bars (outlined), circle (outlined), star (filled) — the low-visibility style.
  const bw = r * 1.0;
  const bh = r * 0.5;
  ctx.strokeRect(r * 0.72, -bh / 2, bw, bh);
  ctx.strokeRect(-r * 0.72 - bw, -bh / 2, bw, bh);
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  for (let k = 0; k < 10; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / 5;
    const rr = k % 2 === 0 ? r * 0.92 : r * 0.36;
    const x = Math.cos(a) * rr;
    const y = Math.sin(a) * rr;
    if (k === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function text(ctx: Ctx, str: string, x: number, y: number, size: number, color: string, rot = 0, font = 'Arial, Helvetica, sans-serif', weight = 'bold') {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.fillStyle = color;
  ctx.font = `${weight} ${size}px ${font}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(str, 0, 0);
  ctx.restore();
}

/** Mottle + touch-up patches + streaks inside a rectangle. */
function weather(col: Ctx, rough: Ctx, r: () => number, x: number, y: number, w: number, h: number, patches: number) {
  col.save();
  col.filter = 'blur(1.5px)';
  for (let i = 0; i < patches * 0.6; i++) {
    const pw = 16 + r() * 70;
    const ph = 12 + r() * 50;
    const px0 = x + r() * (w - pw);
    const py0 = y + r() * (h - ph);
    const light = r() < 0.5;
    col.fillStyle = light ? `rgba(255,255,255,${0.012 + r() * 0.022})` : `rgba(0,0,0,${0.015 + r() * 0.03})`;
    col.fillRect(px0, py0, pw, ph);
    rough.fillStyle = light ? 'rgba(90,90,90,0.2)' : 'rgba(200,200,200,0.12)';
    rough.fillRect(px0, py0, pw, ph);
  }
  col.restore();
  // Fine grime: many faint small blotches.
  for (let i = 0; i < patches * 12; i++) {
    col.fillStyle = `rgba(0,0,0,${r() * 0.035})`;
    const s = 2 + r() * 10;
    col.fillRect(x + r() * w, y + r() * h, s, s * (0.5 + r()));
  }
}

function paintFuselage(col: Ctx, rough: Ctx, bump: Ctx, st: FuselageStationInfo[], r: () => number) {
  const [x0, y0, w, h] = cellRect(CELL.fuselage);
  col.fillStyle = FS36270;
  col.fillRect(x0, y0, w, h);
  // Light undersides (below the strake / boom edge), soft sprayed edge.
  col.save();
  col.filter = 'blur(5px)';
  col.fillStyle = FS36375;
  fuselageBand(col, st, (s) => s.sEdge + 0.04, (s) => s.sHalf + 0.2, 0);
  // Dark spine / nose top: down to just below the shoulder, wider on the nose, narrower aft.
  col.fillStyle = FS36118;
  const darkTo = (s: FuselageStationInfo) => {
    const k = s.z < -5.9 ? 0.95 : s.z < -3.0 ? 1.0 : s.z < 2.5 ? 0.92 : 0.8;
    return s.sShoulder * k + 0.05;
  };
  fuselageBand(col, st, () => 0, darkTo, 0);
  col.restore();
  // Cockpit tub interior (under the canopy, inside the sills).
  col.fillStyle = INTERIOR;
  const tub = st.filter((s) => s.z > -5.06 && s.z < -2.74);
  fuselageBand(col, tub, () => 0, (s) => s.sShoulder - 0.02, 0);
  // Anti-glare panel ahead of the windscreen (matte, same dark grey), roughness only.
  rough.fillStyle = '#c8c8c8';
  fuselageBand(rough, st.filter((s) => s.z < -5.7), () => 0, (s) => s.sShoulder * 0.8, 0);

  // Main gear wells (white liners with a darker centre for depth).
  const wells = st.filter((s) => s.z > -0.88 && s.z < 0.6);
  for (const side of [1, -1] as const) {
    col.fillStyle = WELL;
    col.beginPath();
    const upper: [number, number][] = [];
    const lower: [number, number][] = [];
    for (const s of wells) {
      const a = sAtLowerX(s, 1.04);
      const b = sAtLowerX(s, 0.64);
      if (a === null || b === null) continue;
      upper.push(F(s.z, side * a));
      lower.push(F(s.z, side * b));
    }
    if (upper.length > 1) {
      const poly = [...upper, ...lower.reverse()];
      col.moveTo(poly[0][0], poly[0][1]);
      for (const p of poly) col.lineTo(p[0], p[1]);
      col.closePath();
      col.fill();
      col.save();
      col.clip();
      col.filter = 'blur(10px)';
      col.fillStyle = 'rgba(40,40,38,0.55)';
      const cx = (upper[0][0] + upper[upper.length - 1][0]) / 2;
      const cy = (upper[0][1] + lower[0][1]) / 2;
      col.fillRect(cx - 40, cy - 12, 80, 24);
      col.restore();
    }
  }

  // Panel lines: circumferential frames and longitudinal seams.
  const frames = [-6.35, -5.95, -5.35, -2.95, -2.35, -1.65, -0.95, -0.25, 0.45, 1.15, 1.85, 2.55, 3.2, 3.85, 4.45];
  for (const z of frames) {
    const s = st.reduce((a, b) => (Math.abs(b.z - z) < Math.abs(a.z - z) ? b : a));
    const inTub = z > -5.06 && z < -2.7;
    const from = inTub ? s.sShoulder : 0;
    panelLine(col, bump, [F(s.z, from), F(s.z, s.sHalf)], true);
    panelLine(col, bump, [F(s.z, -from), F(s.z, -s.sHalf)], true);
  }
  const seam = (f: (s: FuselageStationInfo) => number, zMin: number, zMax: number, rivets: boolean) => {
    const part = st.filter((s) => s.z >= zMin && s.z <= zMax);
    for (const side of [1, -1]) panelLine(col, bump, part.map((s) => F(s.z, side * f(s))), rivets);
  };
  seam((s) => s.sShoulder + 0.02, -6.7, 4.9, true);
  seam((s) => s.sEdge - 0.12, -5.2, 4.9, false);
  seam((s) => s.sEdge + 0.1, -4.5, 4.9, true);
  seam(() => 0.12, -2.9, 4.9, false);
  seam((s) => (s.sShoulder + s.sEdge) * 0.5, -2.9, 3.8, false);
  // Access panels (symmetric pairs).
  const panels: [number, number, number, number][] = [
    [-6.55, 0.12, 0.35, 0.18], [-6.1, 0.35, 0.3, 0.2], [-2.8, 0.5, 0.45, 0.22], [-2.1, 0.62, 0.4, 0.2],
    [-1.4, 0.3, 0.5, 0.2], [-0.6, 0.55, 0.55, 0.25], [0.2, 0.25, 0.45, 0.2], [0.9, 0.62, 0.5, 0.22],
    [1.6, 0.3, 0.4, 0.2], [2.3, 0.6, 0.45, 0.2], [3.3, 0.3, 0.35, 0.18], [3.9, 0.55, 0.3, 0.2],
    [-4.6, 1.05, 0.5, 0.16], [-3.6, 1.1, 0.4, 0.16], [0.4, 1.35, 0.6, 0.2], [1.5, 1.45, 0.5, 0.2], [2.9, 1.3, 0.45, 0.18],
  ];
  for (const [z, s, dz, ds] of panels) {
    for (const side of [1, -1]) {
      const [ax, ay] = F(z, side * s);
      const [bx, by] = F(z + dz, side * (s + ds));
      panelRect(col, bump, Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
    }
  }

  // Touch-up patches and grime (the F-16 fleet's patchwork), then exhaust soot on the aft end.
  weather(col, rough, r, x0, y0, w, h, 70);
  const aft = F(4.1, 0);
  const end = F(5.0, 0);
  const grd = col.createLinearGradient(aft[0], 0, end[0], 0);
  grd.addColorStop(0, 'rgba(25,22,20,0)');
  grd.addColorStop(1, 'rgba(25,22,20,0.55)');
  col.fillStyle = grd;
  col.fillRect(aft[0], y0, end[0] - aft[0], h);
  // Gun gas soot streaking aft from the port (left side, s < 0).
  const gunS = -0.62;
  const g0 = F(-3.4, gunS);
  const g1 = F(-1.8, gunS - 0.1);
  col.save();
  col.filter = 'blur(6px)';
  const gg = col.createLinearGradient(g0[0], 0, g1[0], 0);
  gg.addColorStop(0, 'rgba(15,15,15,0.7)');
  gg.addColorStop(1, 'rgba(15,15,15,0)');
  col.fillStyle = gg;
  col.beginPath();
  col.ellipse((g0[0] + g1[0]) / 2, (g0[1] + g1[1]) / 2, (g1[0] - g0[0]) / 2, 18, 0, 0, Math.PI * 2);
  col.fill();
  col.restore();

  // Air-refuelling receptacle guide lines (white) on the spine.
  col.strokeStyle = 'rgba(235,235,230,0.8)';
  col.lineWidth = 2;
  col.setLineDash([10, 8]);
  line(col, [F(-2.9, 0), F(-1.25, 0)]);
  col.setLineDash([]);
  const [rx0, ry0] = F(-1.25, 0.13);
  const [rx1, ry1] = F(-0.79, -0.13);
  col.strokeRect(Math.min(rx0, rx1), Math.min(ry0, ry1), Math.abs(rx1 - rx0), Math.abs(ry1 - ry0));

  // Stencils: RESCUE arrows and ejection-seat warning triangles below the canopy sills, NO STEP.
  for (const side of [1, -1] as const) {
    const sil = st.reduce((a, b) => (Math.abs(b.z + 4.3) < Math.abs(a.z + 4.3) ? b : a));
    const sPos = side * (sil.sShoulder + 0.14);
    const [tx, ty] = F(-4.3, sPos);
    // Right side (s > 0) is painted rotated 180° so it reads upright from outside.
    const rot = side > 0 ? Math.PI : 0;
    col.save();
    col.translate(tx, ty);
    col.rotate(rot);
    col.fillStyle = '#b8231c';
    col.beginPath();
    col.moveTo(0, -6);
    col.lineTo(6, 5);
    col.lineTo(-6, 5);
    col.closePath();
    col.fill();
    col.restore();
    text(col, 'RESCUE', ...F(-4.8, sPos), 7, '#2a2b2c', rot);
    text(col, 'NO STEP', ...F(-1.2, side * (st[0].sShoulder + 0.75)), 7, '#2a2b2c', rot);
    text(col, 'DANGER', ...F(-5.5, side * (sil.sEdge - 0.05)), 6, '#7e2420', rot);
  }

  // Swatches for small parts.
  for (const [sw, c] of [[SWATCH.light, FS36375], [SWATCH.mid, FS36270]] as const) {
    const [sx, sy] = px(sw as [number, number]);
    col.fillStyle = c;
    col.fillRect(sx - 12, sy - 12, 24, 24);
    rough.fillStyle = '#8c8c8c';
    rough.fillRect(sx - 12, sy - 12, 24, 24);
  }
}

function paintWings(col: Ctx, rough: Ctx, bump: Ctx, r: () => number) {
  for (const [c, upper, right] of [
    [CELL.wingRightUpper, true, true], [CELL.wingRightLower, false, true], [CELL.wingLeftUpper, true, false], [CELL.wingLeftLower, false, false],
  ] as const) {
    const [x0, y0, w, h] = cellRect(c);
    col.fillStyle = upper ? FS36270 : FS36375;
    col.fillRect(x0, y0, w, h);
    const W = (x: number, z: number) => px(wingUV(right ? x : -x, z, upper));
    // Spars (spanwise) and ribs (chordwise) as panel lines.
    for (const f of [0.15, 0.4, 0.62, 0.8]) {
      const pts: [number, number][] = [];
      for (let x = 1.45; x <= 4.5; x += 0.25) {
        const le = -1.9 + Math.tan((40 * Math.PI) / 180) * x;
        const te = 3.1 - 0.0354 * x;
        pts.push(W(x, le + (te - le) * f));
      }
      panelLine(col, bump, pts, f === 0.4 || f === 0.62);
    }
    for (const x of [1.9, 2.5, 3.1, 3.7, 4.2]) {
      const le = -1.9 + Math.tan((40 * Math.PI) / 180) * x;
      const te = 3.1 - 0.0354 * x;
      panelLine(col, bump, [W(x, le + (te - le) * 0.15), W(x, le + (te - le) * 0.8)], true);
    }
    weather(col, rough, r, x0, y0, w, h, 16);
    // National insignia on the left upper / right lower wing, "USAF" on the right upper / left lower.
    const ins = (upper && !right) || (!upper && right);
    const [cx, cy] = W(3.35, 1.55);
    if (ins) insignia(col, cx, cy, 34, upper ? '#50565b' : '#6c7175', -Math.PI / 2);
    else text(col, 'USAF', cx, cy, 62, upper ? '#50565b' : '#6c7175', upper === right ? Math.PI / 2 : -Math.PI / 2);
  }
  for (const [c, upper] of [[CELL.stabUpper, true], [CELL.stabLower, false]] as const) {
    const [x0, y0, w, h] = cellRect(c);
    col.fillStyle = upper ? FS36270 : FS36375;
    col.fillRect(x0, y0, w, h);
    const T = (x: number, z: number) => px(stabUV(x, z, upper));
    panelLine(col, bump, [T(1.1, 4.6), T(2.8, 4.6)], true);
    panelLine(col, bump, [T(1.1, 5.2), T(2.7, 5.45)], false);
    weather(col, rough, r, x0, y0, w, h, 6);
  }
}

function paintFin(col: Ctx, rough: Ctx, bump: Ctx, r: () => number) {
  for (const right of [true, false]) {
    const c = right ? CELL.finRight : CELL.finLeft;
    const [x0, y0, w, h] = cellRect(c);
    col.fillStyle = FS36270;
    col.fillRect(x0, y0, w, h);
    const P = (z: number, y: number) => px(finUV(z, y, right));
    // Dielectric fin cap (darker) and the 77th FS red tail band below it.
    const capA = P(4.9, 3.2);
    const capB = P(6.0, 2.98);
    col.fillStyle = '#5b6064';
    col.fillRect(Math.min(capA[0], capB[0]), capA[1], Math.abs(capB[0] - capA[0]), capB[1] - capA[1]);
    const bandA = P(4.6, 2.95);
    const bandB = P(6.0, 2.78);
    col.fillStyle = '#9a1f1a';
    col.fillRect(Math.min(bandA[0], bandB[0]), bandA[1], Math.abs(bandB[0] - bandA[0]), bandB[1] - bandA[1]);
    col.fillStyle = '#1b1b1b';
    col.fillRect(Math.min(bandA[0], bandB[0]), bandB[1] - 3, Math.abs(bandB[0] - bandA[0]), 3);
    // Tail code, serial.
    const ink = '#3b3f43';
    text(col, 'SW', ...P(4.98, 2.18), 112, ink, 0, 'Arial Black, Arial, sans-serif', '900');
    const [ax, ay] = P(4.88, 1.55);
    text(col, 'AF', ax - 70, ay - 13, 26, ink);
    text(col, '90', ax - 70, ay + 15, 26, ink);
    text(col, '772', ax + 30, ay, 64, ink, 0, 'Arial Black, Arial, sans-serif', '900');
    text(col, '20 OG', ...P(5.12, 1.22), 18, ink);
    // Panel lines: the leading-edge spar, horizontal ribs, the root fairing.
    panelLine(col, bump, [P(2.72, 0.6), P(5.2, 3.05)], true);
    panelLine(col, bump, [P(2.6, 0.9), P(5.6, 0.9)], true);
    panelLine(col, bump, [P(3.2, 1.9), P(5.7, 1.9)], false);
    panelRect(col, bump, ...(() => {
      const a = P(3.4, 1.35);
      const b = P(3.8, 1.1);
      return [Math.min(a[0], b[0]), a[1], Math.abs(b[0] - a[0]), b[1] - a[1]] as [number, number, number, number];
    })());
    weather(col, rough, r, x0, y0, w, h, 10);
  }
  // Cowl: medium grey sides fading to the light underside, insignia, lip area.
  const [x0, y0, w, h] = cellRect(CELL.cowl);
  const top = px(cowlUV(0, -0.5))[1];
  const bot = px(cowlUV(0, -0.85))[1];
  const g = col.createLinearGradient(0, top, 0, bot);
  g.addColorStop(0, FS36270);
  g.addColorStop(1, FS36375);
  col.fillStyle = g;
  col.fillRect(x0, y0, w, h);
  col.fillStyle = FS36270;
  col.fillRect(x0, y0, w, top - y0);
  col.fillStyle = FS36375;
  col.fillRect(x0, bot, w, y0 + h - bot);
  const C = (z: number, y: number) => px(cowlUV(z, y));
  for (const z of [-3.9, -3.1, -2.3, -1.5, -0.7, 0.1, 0.9]) panelLine(col, bump, [C(z, -0.3), C(z, -0.98)], true);
  panelLine(col, bump, [C(-4.4, -0.62), C(1.6, -0.62)], false);
  weather(col, rough, r, x0, y0, w, h, 14);
  const [ix, iy] = C(-2.55, -0.64);
  // Cowl u runs along z at 6.25 mm/px but v along y at 3.3 mm/px: squash the insignia to stay round.
  col.save();
  col.translate(ix, iy);
  col.scale((6.5 / 3.2) * 0.5, 1);
  insignia(col, 0, 0, 34, '#5f6469');
  col.restore();
  void RANGE;
}

export interface LiveryTextures {
  map: THREE.CanvasTexture;
  roughness: THREE.CanvasTexture;
  bump: THREE.CanvasTexture;
}

/** Paint the atlas (browser only; returns null without a DOM / 2D canvas). */
export function paintLivery(stations: FuselageStationInfo[]): LiveryTextures | null {
  if (typeof document === 'undefined') return null;
  const mk = () => {
    const c = document.createElement('canvas');
    c.width = S;
    c.height = S;
    return c;
  };
  const cc = mk();
  const rc = mk();
  const bc = mk();
  const col = cc.getContext('2d');
  const rough = rc.getContext('2d');
  const bump = bc.getContext('2d');
  if (!col || !rough || !bump) return null;
  rough.fillStyle = '#9a9a9a';
  rough.fillRect(0, 0, S, S);
  bump.fillStyle = '#808080';
  bump.fillRect(0, 0, S, S);
  const r = rng(90_0772);
  paintFuselage(col, rough, bump, stations, r);
  paintWings(col, rough, bump, r);
  paintFin(col, rough, bump, r);
  const tex = (c: HTMLCanvasElement, srgb: boolean) => {
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 8;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    return t;
  };
  return { map: tex(cc, true), roughness: tex(rc, false), bump: tex(bc, false) };
}
