/**
 * "Tater Airways" — the 747's paint, drawn on canvas: a classic airliner scheme (gloss white upper
 * fuselage, a Tater-blue cheatline with a gold pinstripe under the window line, a grey belly),
 * "TATER AIRWAYS" titles on the forward fuselage, the registration N747TT, the flying-potato
 * mascot big on a blue fin with a gold-ringed roundel, passenger windows (main and upper deck),
 * doors L1–L5 and the upper-deck exits, the flight-deck windows, panel lines (also as bump) and
 * subtle weathering. A second canvas with the same layout carries the bump (R) and the roughness
 * (G). All regions come from `atlas.ts`; the fuselage is painted column by column from the section
 * function, so every stripe sits exactly at its body height all along the hump and the tapers.
 */
import * as THREE from 'three';
import { ATLAS_H, ATLAS_W, CELL, RANGE, cellRect, fuselageUV, uvToPx, wingUV, finUV, stabUV, type Cell } from './atlas';
import { DOORS, ENGINES, FIN, NOSE_Z, STAB, FUSE_END_Z as TAIL_Z, WINDOWS, WING, halfOutline, sAtY } from './shape';
import { windowOutline } from './fuselage';
import { MASCOT_BOX, drawTaterMascot } from '../mascot';

type Ctx = CanvasRenderingContext2D;

export const TATER_BLUE = '#1d3f8f';
export const TATER_GOLD = '#d4a531';
const WHITE = '#f3f4f2';
const BELLY = '#9aa0a6';
const WING_GREY = '#c0c5ca';
const WING_LOWER = '#aeb4ba';
const INK = '#20242a';

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

const F = (z: number, s: number) => {
  const uv = fuselageUV(z, s);
  return uvToPx(uv[0], uv[1]);
};
/** Pixels per metre of the fuselage cell along z (u) and s (v). */
const PX_Z = ATLAS_W / (RANGE.fuseZ[1] - RANGE.fuseZ[0]);
const PX_S = (ATLAS_H * 0.5) / (RANGE.fuseS[1] - RANGE.fuseS[0]);

function clip(ctxs: Ctx[], c: Cell, f: () => void) {
  const [x, y, w, h] = cellRect(c);
  for (const k of ctxs) {
    k.save();
    k.beginPath();
    k.rect(x, y, w, h);
    k.clip();
  }
  f();
  for (const k of ctxs) k.restore();
}

function poly(ctx: Ctx, pts: [number, number][]) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
}

/** Panel line on colour + data canvases (a groove in the bump). */
function groove(col: Ctx, dat: Ctx, pts: [number, number][], alpha = 0.12) {
  col.strokeStyle = `rgba(40, 46, 54, ${alpha})`;
  col.lineWidth = 1.2;
  col.beginPath();
  pts.forEach(([x, y], i) => (i ? col.lineTo(x, y) : col.moveTo(x, y)));
  col.stroke();
  dat.strokeStyle = 'rgb(70, 90, 0)';
  dat.lineWidth = 1.6;
  dat.beginPath();
  pts.forEach(([x, y], i) => (i ? dat.lineTo(x, y) : dat.moveTo(x, y)));
  dat.stroke();
}

// ─── Fuselage ────────────────────────────────────────────────────────────────

interface Band {
  top: number;
  bot: number;
  color: string;
  /** Optional z limits of the band (with a taper at the front end). */
  z0?: number;
  z1?: number;
}

/** Cheatline heights: blue band under the windows, gold pinstripe, thin blue line above. */
export const CHEAT = { blueTop: 0.66, blueBot: 0.1, goldTop: 0.02, goldBot: -0.08, lineTop: 1.36, lineBot: 1.28, bellyTop: -1.35 } as const;

function paintFuselageBase(col: Ctx, dat: Ctx) {
  const [cx, cy, cw, ch] = cellRect(CELL.fuselage);
  col.fillStyle = WHITE;
  col.fillRect(cx, cy, cw, ch);
  const step = 2;
  for (let px = cx; px < cx + cw; px += step) {
    const z = RANGE.fuseZ[0] + ((px + step / 2 - cx) / cw) * (RANGE.fuseZ[1] - RANGE.fuseZ[0]);
    if (z < NOSE_Z - 0.1 || z > TAIL_Z + 0.1) continue;
    const h = halfOutline(Math.min(TAIL_Z, Math.max(NOSE_Z, z)), 120);
    const total = h[h.length - 1];
    // Cheatline sweeps: starts as a point at the nose, ends tapering before the tail cone.
    const noseT = Math.min(1, Math.max(0, (z + 30.4) / 2.6));
    const tailT = Math.min(1, Math.max(0, (33.8 - z) / 5));
    const bands: Band[] = [
      { top: CHEAT.bellyTop, bot: -99, color: BELLY },
      { top: CHEAT.blueTop - (1 - noseT) * 0.28, bot: CHEAT.blueBot + (1 - noseT) * 0.28, color: TATER_BLUE },
      { top: CHEAT.goldTop, bot: CHEAT.goldBot, color: TATER_GOLD },
      { top: CHEAT.lineTop, bot: CHEAT.lineBot, color: TATER_BLUE },
    ];
    for (const b of bands) {
      if (b.color !== BELLY && (noseT <= 0 || tailT <= 0)) continue;
      let top = b.top;
      let bot = b.bot;
      if (b.color !== BELLY) {
        // Taper the stripes to their centreline at both ends.
        const mid = (top + bot) / 2;
        const k = Math.min(noseT, tailT);
        top = mid + (top - mid) * Math.min(1, k * 1.6);
        bot = mid + (bot - mid) * Math.min(1, k * 1.6);
        if (top - bot < 0.01) continue;
      }
      const s0 = sAtY(h, top);
      const s1 = bot < -50 ? total : sAtY(h, bot);
      if (s1 <= s0) continue;
      col.fillStyle = b.color;
      for (const sign of [1, -1]) {
        const [, y0] = F(z, sign * s0);
        const [, y1] = F(z, sign * s1);
        col.fillRect(px, Math.min(y0, y1), step, Math.abs(y1 - y0) + 0.6);
      }
    }
    // Belly: slightly rougher than the gloss white.
    const sb = sAtY(h, CHEAT.bellyTop);
    for (const sign of [1, -1]) {
      const [, y0] = F(z, sign * sb);
      const [, y1] = F(z, sign * total);
      dat.fillStyle = 'rgb(128, 125, 0)';
      dat.fillRect(px, Math.min(y0, y1), step, Math.abs(y1 - y0) + 0.6);
    }
  }
}

/** Rounded rectangle centred at (z, y) of size w × h metres on one side (sign) of the fuselage. */
function sideRect(ctx: Ctx, z: number, y: number, w: number, hgt: number, sign: 1 | -1, r = 0.08) {
  const h = halfOutline(z, 120);
  const s0 = sAtY(h, y + hgt / 2);
  const s1 = sAtY(h, y - hgt / 2);
  const [x0, ya] = F(z - w / 2, sign * s0);
  const [x1, yb] = F(z + w / 2, sign * s1);
  const top = Math.min(ya, yb);
  const hh = Math.abs(yb - ya);
  const rr = Math.min(r * PX_Z, (x1 - x0) / 2, hh / 2);
  ctx.beginPath();
  ctx.roundRect(x0, top, x1 - x0, hh, rr);
}

function inDoor(z: number, pad: number): boolean {
  return DOORS.main.some((d) => Math.abs(z - d) < DOORS.width / 2 + pad);
}

function paintWindows(col: Ctx, dat: Ctx) {
  const W = WINDOWS;
  for (const sign of [1, -1] as const) {
    // Main deck: from behind the nose to the aft taper, skipping the doors.
    for (let z = -27.3; z < 28.6; z += W.pitch) {
      if (inDoor(z, 0.35)) continue;
      sideRect(col, z, W.mainY, W.w, W.h, sign, 0.1);
      col.fillStyle = '#15191e';
      col.fill();
      col.strokeStyle = 'rgba(120, 128, 138, 0.8)';
      col.lineWidth = 1.2;
      col.stroke();
      sideRect(dat, z, W.mainY, W.w, W.h, sign, 0.1);
      dat.fillStyle = 'rgb(110, 18, 0)';
      dat.fill();
    }
    // Upper deck (the -400's stretched upper deck: ten windows, the exit door, two more).
    for (let z = -25.2; z < -10.3; z += W.pitch * 2) {
      if (Math.abs(z - DOORS.upper) < 0.75) continue;
      sideRect(col, z, W.upperY, W.w, W.h * 0.95, sign, 0.1);
      col.fillStyle = '#15191e';
      col.fill();
      sideRect(dat, z, W.upperY, W.w, W.h * 0.95, sign, 0.1);
      dat.fillStyle = 'rgb(110, 18, 0)';
      dat.fill();
    }
  }
}

function paintDoors(col: Ctx, dat: Ctx) {
  const D = DOORS;
  const doorLine = (ctx: Ctx, z: number, y: number, w: number, h: number, sign: 1 | -1) => {
    sideRect(ctx, z, y, w, h, sign, 0.18);
    ctx.stroke();
  };
  for (const sign of [1, -1] as const) {
    for (const z of D.main) {
      const yc = D.sillY + D.height / 2;
      col.strokeStyle = 'rgba(30, 36, 44, 0.55)';
      col.lineWidth = 2;
      doorLine(col, z, yc, D.width, D.height, sign);
      dat.strokeStyle = 'rgb(60, 90, 0)';
      dat.lineWidth = 2.4;
      doorLine(dat, z, yc, D.width, D.height, sign);
      // Door window and handle.
      sideRect(col, z, D.sillY + D.height * 0.72, 0.2, 0.28, sign, 0.08);
      col.fillStyle = '#15191e';
      col.fill();
      sideRect(col, z + sign * 0.0, D.sillY + D.height * 0.45, 0.32, 0.06, sign, 0.02);
      col.fillStyle = 'rgba(40, 44, 50, 0.6)';
      col.fill();
    }
    // Upper-deck exit.
    col.strokeStyle = 'rgba(30, 36, 44, 0.55)';
    col.lineWidth = 2;
    doorLine(col, D.upper, 3.75, 0.72, 1.25, sign);
    dat.strokeStyle = 'rgb(60, 90, 0)';
    doorLine(dat, D.upper, 3.75, 0.72, 1.25, sign);
    // Cargo doors on the lower lobe (forward and aft of the wing) and the bulk door.
    for (const [z, w] of [[-18.5, 2.7], [18.6, 2.7], [23.0, 1.2]] as const) {
      col.strokeStyle = 'rgba(40, 46, 54, 0.4)';
      col.lineWidth = 1.5;
      doorLine(col, z, -1.9, w, 1.7, sign);
      doorLine(dat, z, -1.9, w, 1.7, sign);
    }
  }
}

function paintCockpit(col: Ctx, dat: Ctx) {
  for (const sign of [1, -1] as const) {
    for (let w = 0; w < 3; w++) {
      const pts = windowOutline(w, 8).map((p) => {
        const h = halfOutline(p.z, 160);
        return F(p.z, sign * sAtY(h, p.y));
      });
      for (const [ctx, fill, stroke] of [[col, '#0d1115', '#3b4148'], [dat, 'rgb(110, 12, 0)', 'rgb(40, 60, 0)']] as const) {
        poly(ctx, pts);
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 3;
        ctx.stroke();
      }
    }
  }
}

function paintTitles(col: Ctx) {
  // "TATER AIRWAYS" above the main-deck windows, under the upper-deck windows.
  const zc = -14.2;
  const y = 2.18;
  const hM = 0.98;
  for (const sign of [1, -1] as const) {
    const h = halfOutline(zc, 160);
    const s = sAtY(h, y);
    const [x, yy] = F(zc, sign * s);
    col.save();
    col.translate(x, yy);
    // Left side reads normally; the right side shows the canvas rotated 180°.
    if (sign > 0) col.rotate(Math.PI);
    col.scale(PX_Z / PX_S, 1);
    col.fillStyle = TATER_BLUE;
    col.font = `bold ${Math.round(hM * PX_S * 1.36)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
    col.textAlign = 'center';
    col.textBaseline = 'middle';
    const text = 'TATER AIRWAYS';
    const target = 15.5 * PX_S;
    const wText = col.measureText(text).width;
    col.save();
    col.scale(Math.min(1.25, target / wText), 1);
    col.fillText(text, 0, 0);
    col.restore();
    col.restore();
    // Registration on the aft fuselage, and a small one under the cockpit.
    for (const [zr, yr, size] of [[27.2, 1.95, 0.55], [-27.6, -0.95, 0.28]] as const) {
      const hr = halfOutline(zr, 160);
      const [rx, ry] = F(zr, sign * sAtY(hr, yr));
      col.save();
      col.translate(rx, ry);
      if (sign > 0) col.rotate(Math.PI);
      col.scale(PX_Z / PX_S, 1);
      col.fillStyle = INK;
      col.font = `bold ${Math.round(size * PX_S * 1.36)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
      col.textAlign = 'center';
      col.textBaseline = 'middle';
      col.fillText('N747TT', 0, 0);
      col.restore();
    }
    // A small Tater roundel by the forward door.
    const hm = halfOutline(-23.9, 160);
    const [mx, my] = F(-23.9, sign * sAtY(hm, 2.45));
    col.save();
    col.translate(mx, my);
    if (sign > 0) col.rotate(Math.PI);
    col.scale(PX_Z / PX_S, 1);
    const k = (1.3 * PX_S) / MASCOT_BOX.w;
    col.scale(k, k);
    col.translate(-MASCOT_BOX.w / 2, -MASCOT_BOX.h / 2);
    drawTaterMascot(col, { outline: 14, speedLines: true });
    col.restore();
  }
}

function paintFuselagePanels(col: Ctx, dat: Ctx, r: () => number) {
  // Circumferential skin joints every ~2 m and longitudinal laps every ~1.1 m of arc.
  for (let z = -29; z < 36; z += 2.03) {
    const h = halfOutline(z, 120);
    const total = h[h.length - 1];
    const [x, yTop] = F(z, total);
    const [, yBot] = F(z, -total);
    groove(col, dat, [[x, yTop], [x, yBot]], 0.07);
  }
  for (let s = -11.5; s <= 11.5; s += 1.15) {
    const pts: [number, number][] = [];
    for (let z = -29; z <= 35; z += 1) {
      const h = halfOutline(z, 60);
      if (Math.abs(s) > h[h.length - 1] - 0.2) continue;
      pts.push(F(z, s));
    }
    if (pts.length > 1) groove(col, dat, pts, 0.05);
  }
  // Grime: soft streaks aft of the wing-body fairing and on the aft belly, dirty door sills.
  col.save();
  col.filter = 'blur(6px)';
  for (let i = 0; i < 70; i++) {
    const z = 10 + r() * 20;
    const y = -2.8 + r() * 1.6;
    const sign = r() < 0.5 ? 1 : -1;
    const h = halfOutline(z, 60);
    const [x, yy] = F(z, sign * sAtY(h, y));
    col.fillStyle = `rgba(60, 55, 48, ${0.03 + r() * 0.05})`;
    col.fillRect(x, yy - 3, 40 + r() * 140, 5 + r() * 8);
  }
  col.restore();
  // Gear-door seams on the belly.
  for (const [z0, z1, xs] of [[-26.7, -22.8, 0.6], [0.6, 3.4, 1.0], [1.9, 6.1, 2.65]] as const) {
    for (const sign of [1, -1]) {
      const pts: [number, number][] = [];
      for (let z = z0; z <= z1 + 1e-6; z += 0.25) {
        const h = halfOutline(z, 120);
        const n = h.length / 3;
        // Arc length from the keel up to half width xs.
        let s = h[h.length - 1];
        for (let i = n - 1; i > 0; i--) {
          if (h[(i - 1) * 3] >= xs) {
            s = h[i * 3 + 2];
            break;
          }
        }
        pts.push(F(z, sign * s));
      }
      groove(col, dat, pts, 0.18);
    }
  }
}

// ─── Wings, fin, stabiliser ──────────────────────────────────────────────────

function paintWings(col: Ctx, dat: Ctx, r: () => number) {
  const W = (x: number, f: number, upper: boolean) => {
    const uv = wingUV(x, f, upper);
    return uvToPx(uv[0], uv[1]);
  };
  for (const [cell, upper, x] of [[CELL.wingRightUpper, true, 1], [CELL.wingLeftUpper, true, -1], [CELL.wingRightLower, false, 1], [CELL.wingLeftLower, false, -1]] as const) {
    const [cx, cy, cw, ch] = cellRect(cell);
    col.fillStyle = upper ? WING_GREY : WING_LOWER;
    col.fillRect(cx, cy, cw, ch);
    dat.fillStyle = 'rgb(128, 100, 0)';
    dat.fillRect(cx, cy, cw, ch);
    clip([col, dat], cell, () => {
      // Leading-edge erosion strip (bare metal look) and the spar lines.
      for (const [f0, f1, c] of [[0, 0.06, '#d6dade']] as const) {
        const a = W(x * 2.6, f0, upper);
        const b = W(x * 32.4, f1, upper);
        col.fillStyle = c;
        col.fillRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
        dat.fillStyle = 'rgb(128, 60, 0)';
        dat.fillRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
      }
      for (const f of [0.12, 0.25, 0.4, 0.55, 0.62, 0.7, 0.76]) groove(col, dat, [W(x * 2.6, f, upper), W(x * 32.4, f, upper)], 0.12);
      for (let s = 3.5; s < 31.5; s += 1.4) groove(col, dat, [W(x * s, 0.06, upper), W(x * s, 0.7, upper)], 0.07);
      // Control-surface seams.
      for (const [a0, a1] of [WING.flapInboard, WING.aileronInboard, WING.flapOutboard, WING.aileronOutboard, WING.spoilerInboard, WING.spoilerOutboard]) {
        groove(col, dat, [W(x * a0, 0.55, upper), W(x * a0, 1, upper)], 0.2);
        groove(col, dat, [W(x * a1, 0.55, upper), W(x * a1, 1, upper)], 0.2);
      }
      if (upper) {
        // Walkway outline and "no step" lines over the wing root, fuel caps.
        col.strokeStyle = 'rgba(40, 44, 50, 0.45)';
        col.lineWidth = 2;
        col.beginPath();
        const w0 = W(x * 4, 0.2, true);
        const w1 = W(x * 10, 0.2, true);
        const w2 = W(x * 10, 0.45, true);
        const w3 = W(x * 4, 0.45, true);
        col.moveTo(...w0);
        col.lineTo(...w1);
        col.lineTo(...w2);
        col.lineTo(...w3);
        col.closePath();
        col.stroke();
        for (const s of [8, 16, 24]) {
          const [fx, fy] = W(x * s, 0.35, true);
          col.fillStyle = 'rgba(60, 64, 70, 0.6)';
          col.beginPath();
          col.arc(fx, fy, 4, 0, Math.PI * 2);
          col.fill();
        }
      } else {
        // Exhaust and hydraulic staining aft of each pylon, grime along the flap tracks.
        col.save();
        col.filter = 'blur(5px)';
        for (const e of ENGINES) {
          if (Math.sign(e.x) !== Math.sign(x)) continue;
          const ax = Math.abs(e.x);
          for (let k = 0; k < 6; k++) {
            const [sx, sy] = W(x * (ax + (r() - 0.5) * 1.2), 0.35 + r() * 0.2, false);
            col.fillStyle = `rgba(55, 50, 45, ${0.04 + r() * 0.05})`;
            col.fillRect(sx - 6, sy, 12 + r() * 10, 30 + r() * 50);
          }
        }
        col.restore();
      }
    });
  }
}

function paintFin(col: Ctx, dat: Ctx) {
  for (const right of [false, true]) {
    const cell = right ? CELL.finRight : CELL.finLeft;
    const [cx, cy, cw, ch] = cellRect(cell);
    col.fillStyle = TATER_BLUE;
    col.fillRect(cx, cy, cw, ch);
    dat.fillStyle = 'rgb(128, 85, 0)';
    dat.fillRect(cx, cy, cw, ch);
    const P = (z: number, y: number) => {
      const uv = finUV(z, y, right);
      return uvToPx(uv[0], uv[1]);
    };
    clip([col, dat], cell, () => {
      // A gold sweep along the fin root, following the leading-edge sweep.
      col.fillStyle = TATER_GOLD;
      poly(col, [P(FIN.le(3.0) - 1, 3.0), P(FIN.te(3.0) + 1, 3.0), P(FIN.te(4.6) + 1, 4.6), P(FIN.le(4.6), 4.6)]);
      col.fill();
      col.fillStyle = '#f3f1ea';
      poly(col, [P(FIN.le(4.75) - 1, 4.75), P(FIN.te(4.75) + 1, 4.75), P(FIN.te(5.0) + 1, 5.0), P(FIN.le(5.0), 5.0)]);
      col.fill();
      // Roundel with the mascot.
      const yc = 9.6;
      const zc = (FIN.le(yc) + FIN.te(yc)) / 2 + 0.2;
      const [px, py] = P(zc, yc);
      const [qx] = P(zc + 1, yc);
      const pxm = Math.abs(qx - px);
      const rr = 3.35 * pxm;
      const ry = rr * ((ch / (RANGE.finY[1] - RANGE.finY[0])) / (cw / (RANGE.finZ[1] - RANGE.finZ[0])));
      col.fillStyle = TATER_GOLD;
      col.beginPath();
      col.ellipse(px, py, rr * 1.08, ry * 1.08, 0, 0, Math.PI * 2);
      col.fill();
      col.fillStyle = '#f4f1e8';
      col.beginPath();
      col.ellipse(px, py, rr, ry, 0, 0, Math.PI * 2);
      col.fill();
      col.save();
      col.translate(px, py);
      // Mascot space is square-pixel; the fin cell has its own px/m in z and y.
      const kx = (rr * 2.35) / MASCOT_BOX.w;
      const ky = kx * (ry / rr);
      col.scale(kx, ky);
      col.translate(-MASCOT_BOX.w / 2 + 40, -MASCOT_BOX.h / 2);
      drawTaterMascot(col, { outline: 9, speedLines: true });
      col.restore();
      // Panel lines, rudder seams.
      for (const y of [4.0, 6.2, 8.7, 11.1, 13.4]) groove(col, dat, [P(FIN.le(y), y), P(FIN.te(y), y)], 0.1);
      for (const f of [0.15, 0.45, 0.7]) groove(col, dat, [P(FIN.le(3.3) + f * (FIN.te(3.3) - FIN.le(3.3)), 3.3), P(FIN.le(14.4) + f * (FIN.te(14.4) - FIN.le(14.4)), 14.4)], 0.14);
      // Registration small at the fin top trailing edge? (US: on the aft fuselage) — a gold tip cap instead.
      col.fillStyle = TATER_GOLD;
      poly(col, [P(FIN.le(13.9), 13.9), P(FIN.te(13.9) + 1, 13.9), P(FIN.te(14.7) + 1, 14.7), P(FIN.le(14.7) - 1, 14.7)]);
      col.fill();
    });
  }
}

function paintStab(col: Ctx, dat: Ctx) {
  for (const upper of [true, false]) {
    const cell = upper ? CELL.stabUpper : CELL.stabLower;
    const [cx, cy, cw, ch] = cellRect(cell);
    col.fillStyle = upper ? WING_GREY : WING_LOWER;
    col.fillRect(cx, cy, cw, ch);
    dat.fillStyle = 'rgb(128, 100, 0)';
    dat.fillRect(cx, cy, cw, ch);
    const P = (x: number, f: number) => {
      const uv = stabUV(x, f, upper);
      return uvToPx(uv[0], uv[1]);
    };
    clip([col, dat], cell, () => {
      col.fillStyle = '#d6dade';
      const a = P(0, 0);
      const b = P(STAB.tipX, 0.05);
      col.fillRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
      for (const f of [0.15, 0.4, 0.7]) groove(col, dat, [P(0, f), P(STAB.tipX, f)], 0.12);
      for (let x = 1; x < STAB.tipX; x += 1.3) groove(col, dat, [P(x, 0.05), P(x, 0.7)], 0.07);
      for (const x of [STAB.elevatorInX, STAB.elevatorSplitX, STAB.elevatorOutX]) groove(col, dat, [P(x, 0.7), P(x, 1)], 0.2);
    });
  }
}

export interface LiveryTextures {
  map: THREE.CanvasTexture;
  data: THREE.CanvasTexture;
}

/** Paint the atlas (browser only; returns null without a DOM / 2D canvas). */
export function paintLivery(): LiveryTextures | null {
  if (typeof document === 'undefined') return null;
  const mk = () => {
    const c = document.createElement('canvas');
    c.width = ATLAS_W;
    c.height = ATLAS_H;
    return c;
  };
  const cc = mk();
  const dc = mk();
  const col = cc.getContext('2d');
  const dat = dc.getContext('2d');
  if (!col || !dat) return null;
  // Data: R = bump (128 flat), G = roughness (gloss paint ≈ 0.3).
  dat.fillStyle = 'rgb(128, 78, 0)';
  dat.fillRect(0, 0, ATLAS_W, ATLAS_H);
  const r = rng(747_400);
  paintFuselageBase(col, dat);
  paintFuselagePanels(col, dat, r);
  paintWindows(col, dat);
  paintDoors(col, dat);
  paintCockpit(col, dat);
  paintTitles(col);
  paintWings(col, dat, r);
  paintFin(col, dat);
  paintStab(col, dat);
  const tex = (c: HTMLCanvasElement, srgb: boolean) => {
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 8;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    return t;
  };
  return { map: tex(cc, true), data: tex(dc, false) };
}
