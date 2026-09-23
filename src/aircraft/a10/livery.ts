/**
 * The A-10C's paint, drawn on canvas: the two-tone grey scheme — FS 36118 gunship grey in big soft
 * disruptive patches over FS 36270 neutral grey, a dark anti-glare panel ahead of the windscreen,
 * a false canopy under the nose — with panel lines and fasteners (also as a bump map), grime, gun
 * soot round the GAU-8 muzzle, exhaust staining behind the TF34s, the 23rd Fighter Group's shark
 * mouth, the low-visibility star-and-bar on the nacelles and wings, the "FT" (Flying Tigers, Moody
 * AFB) tail code with the serial AF 80-0281, stencils, and a small "Tater" nose-art mascot under the
 * canopy. Also paints the roughness map. All regions come from `atlas.ts`.
 */
import * as THREE from 'three';
import { ATLAS_SIZE, CELL, SWATCH, finUV, fuselageUV, nacelleUV, stabUV, uvToPx, wingUV, type Cell } from './atlas';
import { stationAt, sAtY, type FuselageStationInfo } from './fuselage';
import { GUN, POD, TUB, WING, wingChord, wingLeZ } from './shape';
import { MASCOT_BOX, drawTaterMascot } from '../mascot';

const S = ATLAS_SIZE;
export const FS36118 = '#555b5f';
export const FS36270 = '#80868a';
const FS36118_RGB = [0x50, 0x56, 0x5a];
const INTERIOR = '#2f3336';
const INK = '#16181a';

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

function line(ctx: Ctx, pts: [number, number][]) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.stroke();
}

function poly(ctx: Ctx, pts: [number, number][]) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
}

/** A panel line on colour + bump canvases (dark groove), with an optional rivet row. */
function panelLine(col: Ctx, bump: Ctx, pts: [number, number][], rivets = false) {
  col.strokeStyle = 'rgba(18, 20, 22, 0.4)';
  col.lineWidth = 1.5;
  line(col, pts);
  bump.strokeStyle = '#4a4a4a';
  bump.lineWidth = 2.2;
  line(bump, pts);
  if (rivets) {
    bump.fillStyle = '#6c6c6c';
    col.fillStyle = 'rgba(28, 30, 32, 0.22)';
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[i + 1];
      const n = Math.max(1, Math.floor(Math.hypot(x1 - x0, y1 - y0) / 6));
      for (let k = 0; k <= n; k++) {
        const x = x0 + ((x1 - x0) * k) / n;
        const y = y0 + ((y1 - y0) * k) / n;
        bump.fillRect(x + 3, y + 3, 1.3, 1.3);
        col.fillRect(x + 3, y + 3, 1.2, 1.2);
      }
    }
  }
}

function panelRect(col: Ctx, bump: Ctx, x: number, y: number, w: number, h: number, rivets = true) {
  panelLine(col, bump, [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]], rivets);
}

/** Low-visibility USAF national insignia (outlined bars and circle, filled star), `r` = circle radius px. */
function insignia(ctx: Ctx, cx: number, cy: number, r: number, color: string, rot = 0, sx = 1, sy = 1) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  ctx.scale(sx, sy);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(1.5, r * 0.07);
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

function text(ctx: Ctx, str: string, x: number, y: number, size: number, color: string, rot = 0, font = 'Arial, Helvetica, sans-serif', weight = 'bold', sx = 1, sy = 1) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.scale(sx, sy);
  ctx.fillStyle = color;
  ctx.font = `${weight} ${size}px ${font}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(str, 0, 0);
  ctx.restore();
}

/** Mottle + touch-up patches + grime inside a rectangle. */
function weather(col: Ctx, rough: Ctx, r: () => number, x: number, y: number, w: number, h: number, patches: number) {
  col.save();
  col.filter = 'blur(2px)';
  for (let i = 0; i < patches * 0.6; i++) {
    const pw = 16 + r() * 80;
    const ph = 12 + r() * 50;
    const px0 = x + r() * (w - pw);
    const py0 = y + r() * (h - ph);
    const light = r() < 0.45;
    col.fillStyle = light ? `rgba(255,255,255,${0.01 + r() * 0.02})` : `rgba(0,0,0,${0.015 + r() * 0.035})`;
    col.fillRect(px0, py0, pw, ph);
    rough.fillStyle = light ? 'rgba(90,90,90,0.2)' : 'rgba(210,210,210,0.14)';
    rough.fillRect(px0, py0, pw, ph);
  }
  col.restore();
  for (let i = 0; i < patches * 14; i++) {
    col.fillStyle = `rgba(0,0,0,${r() * 0.04})`;
    const s = 2 + r() * 10;
    col.fillRect(x + r() * w, y + r() * h, s, s * (0.5 + r()));
  }
}

/**
 * Disruptive FS 36118 patches: soft-edged blobs from a fixed list (shape space = the cell's own
 * coordinates, metres), clipped to `clip` if given.
 */
function blobs(col: Ctx, list: [number, number, number, number, number][], map: (a: number, b: number) => [number, number], r: () => number) {
  col.save();
  col.filter = 'blur(9px)';
  col.globalAlpha = 0.85;
  col.fillStyle = FS36118;
  for (const [a, b, ra, rb, rot] of list) {
    col.beginPath();
    const n = 18;
    for (let k = 0; k <= n; k++) {
      const t = (k / n) * Math.PI * 2;
      const wob = 1 + 0.18 * Math.sin(3 * t + a * 7) + 0.1 * Math.sin(5 * t + b * 3) + (r() - 0.5) * 0.06;
      const ca = Math.cos(t) * ra * wob;
      const cb = Math.sin(t) * rb * wob;
      const pa = a + ca * Math.cos(rot) - cb * Math.sin(rot);
      const pb = b + ca * Math.sin(rot) + cb * Math.cos(rot);
      const [x, y] = map(pa, pb);
      if (k === 0) col.moveTo(x, y);
      else col.lineTo(x, y);
    }
    col.closePath();
    col.fill();
  }
  col.restore();
}

/** Run `f` with all three canvases clipped to a cell (nothing spills into a neighbour). */
function clipped(cell: Cell, ctxs: Ctx[], f: () => void) {
  const [x, y, w, h] = cellRect(cell);
  for (const c of ctxs) {
    c.save();
    c.beginPath();
    c.rect(x, y, w, h);
    c.clip();
  }
  f();
  for (const c of ctxs) c.restore();
}

function paintFuselage(col: Ctx, rough: Ctx, bump: Ctx, st: FuselageStationInfo[], r: () => number) {
  clipped(CELL.fuselage, [col, rough, bump], () => paintFuselageCell(col, rough, bump, st, r));
}

function paintFuselageCell(col: Ctx, rough: Ctx, bump: Ctx, st: FuselageStationInfo[], r: () => number) {
  const [x0, y0, w, h] = cellRect(CELL.fuselage);
  col.fillStyle = FS36270;
  col.fillRect(x0, y0, w, h);

  // Disruptive dark patches on the upper fuselage and sides (the scheme wraps round the top).
  const sideBlobs: [number, number, number, number, number][] = [
    [-5.9, 0.1, 0.9, 0.55, 0.2], [-3.9, 1.2, 1.0, 0.45, -0.25], [-1.6, 0.35, 1.3, 0.6, 0.15], [0.9, 1.35, 1.2, 0.5, -0.2],
    [3.0, 0.4, 1.3, 0.55, 0.25], [5.6, 1.1, 1.1, 0.45, -0.15], [7.7, 0.3, 0.9, 0.4, 0.2],
  ];
  for (const side of [1, -1]) blobs(col, sideBlobs.map(([a, b, ra, rb, rot]) => [a + (side > 0 ? 0 : 0.35), side * b, ra, rb, side * rot]), (z, s) => F(z, s), r);
  // Anti-glare panel on the nose top ahead of the windscreen.
  col.fillStyle = FS36118;
  const nose = st.filter((s) => s.z < TUB.z0 + 0.02 && s.z > -6.75);
  bandFill(col, nose, () => 0, (s) => s.sShoulder * 0.95, 0);
  // Cockpit tub interior.
  col.fillStyle = INTERIOR;
  const tub = st.filter((s) => s.z > TUB.z0 - 0.02 && s.z < TUB.z1 + 0.02);
  bandFill(col, tub, () => 0, (s) => s.sShoulder - 0.015, 0);
  // False canopy under the nose (a dark canopy shape on the belly).
  col.save();
  col.filter = 'blur(2px)';
  col.fillStyle = '#3f4447';
  for (const side of [1, -1]) {
    const pts: [number, number][] = [];
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      const z = -5.15 + 1.6 * t;
      const s0 = stationAt(st, z);
      const half = 0.3 * Math.sin(Math.PI * Math.pow(t, 0.8)) + 0.001;
      pts.push(F(z, side * (s0.sHalf - half)));
    }
    for (let i = 20; i >= 0; i--) {
      const z = -5.15 + 1.6 * (i / 20);
      pts.push(F(z, side * (stationAt(st, z).sHalf + 0.05)));
    }
    poly(col, pts);
    col.fill();
  }
  col.restore();

  // Nose-well opening (dark) — covered by the doors when the gear is up.
  col.fillStyle = '#1b1c1d';
  {
    const [a, b] = F(-5.99, stationAt(st, -5.4).sHalf - 0.49);
    const [c, d] = F(-4.69, stationAt(st, -5.4).sHalf - 0.11);
    col.fillRect(Math.min(a, c), Math.min(b, d), Math.abs(c - a), Math.abs(d - b));
  }

  // Panel lines: frames and longitudinal seams, then access panels.
  const frames = [-6.62, -6.15, -5.45, -2.9, -2.2, -1.4, -0.75, 0.1, 0.9, 1.7, 2.5, 3.3, 4.1, 4.9, 5.7, 6.5, 7.3, 8.1];
  for (const z of frames) {
    const s = stationAt(st, z);
    const inTub = z > TUB.z0 - 0.05 && z < TUB.z1 + 0.05;
    const from = inTub ? s.sShoulder : 0;
    panelLine(col, bump, [F(s.z, from), F(s.z, s.sHalf)], true);
    panelLine(col, bump, [F(s.z, -from), F(s.z, -s.sHalf)], true);
  }
  const seam = (f: (s: FuselageStationInfo) => number, zMin: number, zMax: number, rivets: boolean) => {
    const part = st.filter((s) => s.z >= zMin && s.z <= zMax);
    for (const side of [1, -1]) panelLine(col, bump, part.map((s) => F(s.z, side * f(s))), rivets);
  };
  seam((s) => s.sShoulder + 0.03, -6.6, 8.6, true);
  seam((s) => s.sEdge + 0.02, -6.4, 8.6, false);
  seam((s) => (s.sEdge + s.sHalf) * 0.5 + 0.1, -5.5, 7.5, true);
  seam(() => 0.18, -2.8, 8.4, false);
  const panels: [number, number, number, number][] = [
    [-6.45, 0.3, 0.45, 0.28], [-6.0, 0.72, 0.4, 0.3], [-2.7, 0.62, 0.5, 0.34], [-2.0, 1.05, 0.55, 0.3], [-1.2, 0.5, 0.6, 0.3],
    [-0.5, 1.2, 0.45, 0.35], [0.3, 0.55, 0.7, 0.3], [1.3, 1.2, 0.55, 0.3], [2.1, 0.45, 0.6, 0.28], [3.0, 1.1, 0.5, 0.3],
    [4.2, 0.4, 0.55, 0.25], [5.2, 0.9, 0.45, 0.25], [6.2, 0.35, 0.5, 0.22], [7.0, 0.7, 0.4, 0.2], [-4.4, 1.35, 0.9, 0.22],
  ];
  for (const [z, s, dz, ds] of panels) {
    for (const side of [1, -1]) {
      const [ax, ay] = F(z, side * s);
      const [bx, by] = F(z + dz, side * (s + ds));
      panelRect(col, bump, Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
    }
  }

  // Grime, then exhaust staining along the rear fuselage top (the TF34 exhaust washes over it).
  weather(col, rough, r, x0, y0, w, h, 90);
  col.save();
  col.filter = 'blur(10px)';
  for (const side of [1, -1]) {
    const a = F(5.6, side * 0.1);
    const b = F(8.9, side * 0.9);
    const g = col.createLinearGradient(a[0], 0, b[0], 0);
    g.addColorStop(0, 'rgba(24,22,20,0)');
    g.addColorStop(0.4, 'rgba(24,22,20,0.28)');
    g.addColorStop(1, 'rgba(24,22,20,0.4)');
    col.fillStyle = g;
    col.fillRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
  }
  col.restore();

  // Gun soot: the lower nose round the muzzle is blackened by gun gas, streaking aft along the sides.
  col.save();
  col.filter = 'blur(8px)';
  for (const side of [1, -1]) {
    const pts: [number, number][] = [];
    const zs = [-6.95, -6.7, -6.4, -6.0, -5.6, -5.2, -4.8];
    for (const z of zs) {
      const s0 = stationAt(st, z);
      const k = (z + 6.95) / 2.15;
      pts.push(F(z, side * (s0.sEdge + 0.02 + k * 0.25)));
    }
    for (let i = zs.length - 1; i >= 0; i--) pts.push(F(zs[i], side * (stationAt(st, zs[i]).sHalf + 0.02)));
    const g = col.createLinearGradient(F(-6.95, 0)[0], 0, F(-4.8, 0)[0], 0);
    g.addColorStop(0, 'rgba(12,12,12,0.78)');
    g.addColorStop(0.45, 'rgba(12,12,12,0.45)');
    g.addColorStop(1, 'rgba(12,12,12,0)');
    col.fillStyle = g;
    poly(col, pts);
    col.fill();
    rough.fillStyle = 'rgba(235,235,235,0.5)';
    poly(rough, pts);
    rough.fill();
  }
  col.restore();

  // The shark mouth (23rd FG) on both sides of the nose, and the eye.
  for (const side of [1, -1] as const) sharkMouth(col, st, side);

  // Air-refuelling receptacle slipway on the nose top (white guide lines, dark slipway).
  {
    const [a, b] = F(-6.2, -0.1);
    const [c, d] = F(-5.62, 0.1);
    col.fillStyle = '#2a2d30';
    col.fillRect(Math.min(a, c), Math.min(b, d), Math.abs(c - a), Math.abs(d - b));
    col.strokeStyle = 'rgba(236,236,230,0.85)';
    col.lineWidth = 2;
    col.setLineDash([9, 7]);
    line(col, [F(-6.55, 0), F(-6.22, 0)]);
    col.setLineDash([]);
    col.strokeRect(Math.min(a, c) - 2, Math.min(b, d) - 2, Math.abs(c - a) + 4, Math.abs(d - b) + 4);
  }

  // Stencils: rescue arrow + ejection triangle below the sills, gun danger area, NO STEP.
  for (const side of [1, -1] as const) {
    const sil = stationAt(st, -4.2);
    const sPos = side * (sil.sShoulder + 0.2);
    const rot = side > 0 ? Math.PI : 0;
    const [tx, ty] = F(-4.9, sPos);
    col.save();
    col.translate(tx, ty);
    col.rotate(rot);
    col.fillStyle = '#b8231c';
    col.beginPath();
    col.moveTo(0, -7);
    col.lineTo(7, 6);
    col.lineTo(-7, 6);
    col.closePath();
    col.fill();
    col.restore();
    text(col, 'RESCUE', ...F(-4.45, sPos), 8, '#d8b43a', rot);
    text(col, 'NO STEP', ...F(1.6, side * 0.45), 8, INK, rot);
    text(col, 'DANGER', ...F(-6.1, side * (stationAt(st, -6.1).sEdge + 0.35)), 7, '#8e2420', rot);
  }

  // Tater nose art (left side, below the canopy): small and tasteful.
  mascot(col, st, -1);
  mascot(col, st, 1);

  // Swatches for small parts.
  for (const [sw, c] of [[SWATCH.light, FS36270], [SWATCH.dark, FS36118]] as const) {
    const [sx, sy] = px(sw as [number, number]);
    col.fillStyle = c;
    col.fillRect(sx - 14, sy - 14, 28, 28);
    rough.fillStyle = '#8c8c8c';
    rough.fillRect(sx - 14, sy - 14, 28, 28);
  }
}

/** Fill the band lo(s) ≤ |s| ≤ hi(s) along the stations (sign 0 = both sides). */
function bandFill(ctx: Ctx, st: FuselageStationInfo[], lo: (s: FuselageStationInfo) => number, hi: (s: FuselageStationInfo) => number, sign: 1 | -1 | 0) {
  if (st.length < 2) return;
  const sides: (1 | -1)[] = sign === 0 ? [1, -1] : [sign];
  for (const sd of sides) {
    const pts: [number, number][] = [];
    for (const s of st) pts.push(F(s.z, sd * lo(s)));
    for (let i = st.length - 1; i >= 0; i--) pts.push(F(st[i].z, sd * hi(st[i])));
    poly(ctx, pts);
    ctx.fill();
  }
}

/**
 * The Flying Tigers' shark mouth: open jaws wrapping round the lower nose from under the gun back
 * to below the windscreen, red inside, white teeth on both jaws, black outline; the eye above.
 */
function sharkMouth(col: Ctx, st: FuselageStationInfo[], side: 1 | -1) {
  const Fz = (z: number, y: number, upper: boolean) => {
    const s0 = stationAt(st, z);
    const s = sAtY(s0, y, upper) ?? (upper ? s0.sEdge : s0.sHalf);
    return F(z, side * s);
  };
  // Jaw lines (z, y): the upper lip runs back just above mid-height; the lower lip below it; they
  // meet at the corner of the mouth under the windscreen.
  const n = 16;
  const upper: [number, number][] = [];
  const lower: [number, number][] = [];
  const zTip = -6.9;
  const zCorner = -5.35;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const z = zTip + (zCorner - zTip) * t;
    const s0 = stationAt(st, z);
    // Upper lip: from just above the gun port, curving slightly up then down into the corner.
    const yU = -0.44 + 0.1 * Math.sin(t * Math.PI * 0.8) - 0.12 * t * t;
    // Lower jaw: wraps under the nose, rising to the corner.
    const yL = -0.8 + 0.24 * t * t + 0.02 * Math.sin(t * Math.PI);
    const pu = F(z, side * (sAtY(s0, yU, false) ?? sAtY(s0, yU, true) ?? s0.sEdge));
    const pl = F(z, side * (sAtY(s0, yL, false) ?? s0.sHalf * 0.85));
    upper.push(pu);
    lower.push(pl);
  }
  const mouth = [...upper, ...lower.slice().reverse()];
  col.save();
  // Outline (black), then the red interior slightly inset.
  col.fillStyle = '#101010';
  col.strokeStyle = '#101010';
  col.lineWidth = 9;
  col.lineJoin = 'round';
  poly(col, mouth);
  col.fill();
  col.stroke();
  col.fillStyle = '#b3211d';
  col.lineWidth = 1;
  poly(col, mouth);
  col.save();
  col.clip();
  col.fillRect(0, 0, S, S);
  // Dark throat toward the corner.
  const [cx, cy] = Fz(zCorner - 0.1, -0.52, false);
  const g = col.createRadialGradient(cx, cy, 5, cx, cy, 90);
  g.addColorStop(0, 'rgba(60,8,8,0.8)');
  g.addColorStop(1, 'rgba(60,8,8,0)');
  col.fillStyle = g;
  col.fillRect(cx - 100, cy - 100, 200, 200);
  // Teeth: white triangles along both jaws, pointing into the mouth.
  const teeth = (edge: [number, number][], other: [number, number][], count: number) => {
    col.fillStyle = '#f4f2ea';
    col.strokeStyle = '#2a2a2a';
    col.lineWidth = 1.2;
    for (let k = 0; k < count; k++) {
      const t0 = k / count;
      const t1 = (k + 1) / count;
      const at = (arr: [number, number][], t: number): [number, number] => {
        const f = t * (arr.length - 1);
        const i = Math.min(arr.length - 2, Math.floor(f));
        const u = f - i;
        return [arr[i][0] + (arr[i + 1][0] - arr[i][0]) * u, arr[i][1] + (arr[i + 1][1] - arr[i][1]) * u];
      };
      const a = at(edge, t0);
      const b = at(edge, t1);
      const tm = (t0 + t1) / 2;
      const e = at(edge, tm);
      const o = at(other, tm);
      const len = 0.42 * (1 - 0.55 * tm);
      const tip: [number, number] = [e[0] + (o[0] - e[0]) * len, e[1] + (o[1] - e[1]) * len];
      col.beginPath();
      col.moveTo(a[0], a[1]);
      col.lineTo(tip[0], tip[1]);
      col.lineTo(b[0], b[1]);
      col.closePath();
      col.fill();
      col.stroke();
    }
  };
  teeth(upper, lower, 11);
  teeth(lower, upper, 10);
  col.restore();
  col.restore();

  // The eye: white almond with a black pupil and a red rim, under a heavy brow.
  const [ex, ey] = Fz(-5.75, 0.02, true);
  col.save();
  col.translate(ex, ey);
  const flip = side > 0 ? -1 : 1;
  col.scale(1, flip);
  col.fillStyle = '#101010';
  col.beginPath();
  col.ellipse(0, 0, 30, 16, -0.12, 0, Math.PI * 2);
  col.fill();
  col.fillStyle = '#f4f2ea';
  col.beginPath();
  col.ellipse(0, 0, 25, 12, -0.12, 0, Math.PI * 2);
  col.fill();
  col.fillStyle = '#b3211d';
  col.beginPath();
  col.arc(-6, 1, 10, 0, Math.PI * 2);
  col.fill();
  col.fillStyle = '#080808';
  col.beginPath();
  col.arc(-7, 1, 6, 0, Math.PI * 2);
  col.fill();
  // Brow.
  col.fillStyle = '#101010';
  col.beginPath();
  col.moveTo(-34, -10);
  col.quadraticCurveTo(0, -30, 32, -16);
  col.lineTo(30, -10);
  col.quadraticCurveTo(0, -22, -32, -5);
  col.closePath();
  col.fill();
  col.restore();
}

/** The "Tater" mascot, ~0.4 m long, below the canopy sill; faces the nose on both sides. */
function mascot(col: Ctx, st: FuselageStationInfo[], side: 1 | -1) {
  const z = -4.35;
  const s0 = stationAt(st, z);
  const s = side * (s0.sShoulder + 0.36);
  const [cx, cy] = F(z, s);
  const widthM = 0.42;
  const [ax] = F(z - widthM / 2, s);
  const [bx] = F(z + widthM / 2, s);
  const wpx = Math.abs(bx - ax);
  const k = wpx / MASCOT_BOX.w;
  col.save();
  col.translate(cx, cy);
  // Canvas → model: the right side shows the canvas rotated 180°, so flip it vertically there.
  col.scale(k, side > 0 ? -k : k);
  col.translate(-MASCOT_BOX.w / 2, -MASCOT_BOX.h / 2);
  drawTaterMascot(col, { outline: 11, speedLines: true });
  col.restore();
}

function paintWings(col: Ctx, rough: Ctx, bump: Ctx, r: () => number) {
  for (const [c, upper, right] of [
    [CELL.wingRightUpper, true, true], [CELL.wingRightLower, false, true], [CELL.wingLeftUpper, true, false], [CELL.wingLeftLower, false, false],
  ] as const) {
    const [x0, y0, w, h] = cellRect(c);
    col.fillStyle = FS36270;
    col.fillRect(x0, y0, w, h);
    const W = (x: number, z: number) => px(wingUV(right ? x : -x, z, upper));
    if (upper) {
      const list: [number, number, number, number, number][] = right
        ? [[1.4, 0.2, 1.2, 0.8, 0.4], [4.2, 1.2, 1.4, 0.6, -0.3], [7.0, 0.3, 1.1, 0.6, 0.2]]
        : [[2.0, 1.1, 1.3, 0.7, -0.3], [5.0, 0.1, 1.3, 0.7, 0.35], [7.6, 1.2, 0.9, 0.5, -0.2]];
      blobs(col, list, (x, z) => W(x, z), r);
    }
    // Spars and ribs.
    for (const f of [0.12, 0.28, 0.62, 0.72]) {
      const pts: [number, number][] = [];
      for (let x = 0.6; x <= WING.tipX; x += 0.3) pts.push(W(x, wingLeZ(x) + wingChord(x) * f));
      panelLine(col, bump, pts, f === 0.12 || f === 0.62);
    }
    for (const x of [1.2, 1.9, 2.6, WING.jointX, 3.8, 4.6, 5.44, 6.3, 7.2, WING.droopX]) {
      panelLine(col, bump, [W(x, wingLeZ(x)), W(x, wingLeZ(x) + wingChord(x) * 0.7)], x === WING.jointX);
    }
    // Access panels (fuel cells) between the spars.
    for (const [x, f] of [[1.5, 0.35], [2.4, 0.35], [3.6, 0.3], [4.8, 0.32], [6.0, 0.34]] as const) {
      const [ax, ay] = W(x, wingLeZ(x) + wingChord(x) * f);
      const [bx, by] = W(x + 0.45, wingLeZ(x) + wingChord(x) * (f + 0.18));
      panelRect(col, bump, Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
    }
    weather(col, rough, r, x0, y0, w, h, 26);
    // Walkway (dark anti-skid) on the centre section.
    if (upper) {
      col.fillStyle = 'rgba(40,43,46,0.22)';
      const [ax, ay] = W(0.9, -0.55);
      const [bx, by] = W(1.25, 1.6);
      col.fillRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
      rough.fillStyle = '#e8e8e8';
      rough.fillRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
    }
    // Gear-pod opening under the pod (the stowed wheel shows through it).
    if (!upper) {
      col.fillStyle = '#18191a';
      const [ax, ay] = W(POD.x - 0.19, -0.9);
      const [bx, by] = W(POD.x + 0.19, 0.95);
      col.fillRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
    }
    // National insignia on the left upper and right lower wing (point toward the nose).
    if ((upper && !right) || (!upper && right)) {
      const [cx, cy] = W(6.1, 0.55);
      insignia(col, cx, cy, 44, upper ? '#3e4347' : '#5a6064', Math.PI);
    }
  }
  for (const [c, upper] of [[CELL.stabUpper, true], [CELL.stabLower, false]] as const) {
    const [x0, y0, w, h] = cellRect(c);
    col.fillStyle = FS36270;
    col.fillRect(x0, y0, w, h);
    const T = (x: number, z: number) => px(stabUV(x, z, upper));
    if (upper) blobs(col, [[-1.6, 7.9, 0.9, 0.5, 0.3], [1.3, 8.1, 1.0, 0.5, -0.2]], (x, z) => T(x, z), r);
    for (const z of [7.6, 8.3]) panelLine(col, bump, [T(-2.85, z), T(2.85, z)], true);
    for (const x of [-2.0, -1.0, 1.0, 2.0]) panelLine(col, bump, [T(x, 7.3), T(x, 8.3)], false);
    weather(col, rough, r, x0, y0, w, h, 10);
    // Exhaust staining on the upper stabiliser behind the nacelles.
    if (upper) {
      col.save();
      col.filter = 'blur(12px)';
      for (const x of [-1.55, 1.55]) {
        const [ax, ay] = T(x - 0.55, 7.2);
        const [bx, by] = T(x + 0.55, 8.95);
        col.fillStyle = 'rgba(22,20,18,0.32)';
        col.fillRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
      }
      col.restore();
    }
  }
}

function paintFins(col: Ctx, rough: Ctx, bump: Ctx, r: () => number) {
  for (const rightFin of [true, false]) {
    for (const outer of [true, false]) {
      const c = rightFin ? (outer ? CELL.finRightOuter : CELL.finRightInner) : outer ? CELL.finLeftOuter : CELL.finLeftInner;
      const [x0, y0, w, h] = cellRect(c);
      col.fillStyle = FS36270;
      col.fillRect(x0, y0, w, h);
      const P = (z: number, y: number) => px(finUV(z, y, rightFin, outer));
      blobs(col, [[7.9, 1.9, 0.6, 0.5, 0.4], [8.4, 0.2, 0.5, 0.4, -0.3]], (z, y) => P(z, y), r);
      // Rudder hinge line, ribs and the stabiliser junction.
      panelLine(col, bump, [P(8.36, -0.3), P(8.36, 2.45)], true);
      for (const y of [0.2, 0.7, 1.3, 1.9]) panelLine(col, bump, [P(7.4 + y * 0.17, y), P(8.36, y)], false);
      panelRect(col, bump, ...(() => {
        const a = P(7.75, 1.1);
        const b = P(8.15, 0.85);
        return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])] as [number, number, number, number];
      })());
      weather(col, rough, r, x0, y0, w, h, 12);
      if (!outer) {
        // Exhaust grime on the inner faces.
        col.save();
        col.filter = 'blur(10px)';
        const [ax, ay] = P(7.2, 1.6);
        const [bx, by] = P(9.0, 0.5);
        col.fillStyle = 'rgba(22,20,18,0.25)';
        col.fillRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
        col.restore();
      }
      // Tail code, serial, unit: black on the outer faces (and the inner, as on the real jets).
      const ink = '#141516';
      const [fx, fy] = P(8.18, 1.45);
      text(col, 'FT', fx, fy, 150, ink, 0, 'Arial Black, Arial, sans-serif', '900', 0.62, 1.1);
      const [ax, ay] = P(8.22, 2.12);
      text(col, 'AF 80', ax - 42, ay, 26, ink, 0, 'Arial, sans-serif', 'bold', 0.62, 1);
      text(col, '281', ax + 30, ay, 58, ink, 0, 'Arial Black, Arial, sans-serif', '900', 0.62, 1.1);
      // 23rd FG tail flash: a black/yellow tiger-stripe band at the top.
      const [t0x, t0y] = P(7.7, 2.5);
      const [t1x, t1y] = P(9.0, 2.34);
      col.fillStyle = '#d6a21c';
      col.fillRect(Math.min(t0x, t1x), Math.min(t0y, t1y), Math.abs(t1x - t0x), Math.abs(t1y - t0y));
      col.fillStyle = '#121212';
      for (let k = 0; k < 9; k++) {
        const zz = 7.72 + k * 0.15;
        const [sx0, sy0] = P(zz, 2.5);
        const [sx1, sy1] = P(zz + 0.07, 2.34);
        col.beginPath();
        col.moveTo(sx0, sy0);
        col.lineTo(sx0 + (sx1 - sx0) * 0.6, sy0);
        col.lineTo(sx1, sy1);
        col.lineTo(sx1 - (sx1 - sx0) * 0.6, sy1);
        col.closePath();
        col.fill();
      }
    }
  }
}

function paintNacelles(col: Ctx, rough: Ctx, bump: Ctx, r: () => number) {
  const [x0, y0, w, h] = cellRect(CELL.nacelle);
  col.fillStyle = FS36270;
  col.fillRect(x0, y0, w, h);
  const N = (z: number, a: number) => px(nacelleUV(z, a));
  // Dark top half (seen from above), lighter underside.
  blobs(col, [[4.2, 0.2, 1.3, 0.9, 0.1], [5.8, 5.9, 0.8, 0.8, 0]], (z, a) => N(z, a), r);
  for (const z of [3.35, 4.05, 4.85, 5.5]) panelLine(col, bump, [N(z, 0.001), N(z, Math.PI * 2 - 0.001)], true);
  for (const a of [0.9, 2.4, 3.9, 5.4]) panelLine(col, bump, [N(3.35, a), N(5.5, a)], false);
  weather(col, rough, r, x0, y0, w, h, 20);
  // Oil/exhaust streaks toward the fan nozzle.
  col.save();
  col.filter = 'blur(6px)';
  const [ax, ay] = N(5.2, 0);
  const [bx, by] = N(5.9, Math.PI * 2);
  const g = col.createLinearGradient(ax, 0, bx, 0);
  g.addColorStop(0, 'rgba(20,18,16,0)');
  g.addColorStop(1, 'rgba(20,18,16,0.45)');
  col.fillStyle = g;
  col.fillRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
  col.restore();
  // Star-and-bar on the outboard side (drawn inverted: both nacelles show it upright).
  const [ix, iy] = N(4.45, Math.PI / 2);
  // u: 3.4 mm/px along z, v: 15.6 mm/px round the nacelle — squash to stay round.
  insignia(col, ix, iy, 120, '#3c4145', 0, 1, -(3.42 / 15.7));
  // Intake danger chevrons (red) just behind the lip on the outboard side.
  text(col, 'DANGER', ...N(3.32, Math.PI / 2), 60, '#a52520', 0, 'Arial, sans-serif', 'bold', 0.5, -(3.42 / 15.7));
  void FS36118_RGB;
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
  rough.fillStyle = '#a0a0a0';
  rough.fillRect(0, 0, S, S);
  bump.fillStyle = '#808080';
  bump.fillRect(0, 0, S, S);
  const r = rng(80_0281);
  paintFuselage(col, rough, bump, stations, r);
  paintWings(col, rough, bump, r);
  paintFins(col, rough, bump, r);
  paintNacelles(col, rough, bump, r);
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

export { GUN };
