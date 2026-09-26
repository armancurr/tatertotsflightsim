/**
 * Geometry for the big-ship port (three.js BufferGeometry via the traffic MeshBuilder, so it draws in
 * the same batched PBR material as the marina: roughness / metalness per vertex, lit windows at dusk
 * on glass): the cruise terminal and the naval pier, each in its pier frame (x = u out along the
 * pier, z = w to its right, y up, m MSL), two LODs. Dimensions come from layout.ts / PORT_DIMS — the
 * same numbers the obstacles (obstacles.ts) are built from.
 */
import { MeshBuilder, mat, type Mat } from '../traffic/models/builder';
import { PORT_DIMS, type CruiseTerminalLayout, type NavalPierLayout } from './layout';

const D = PORT_DIMS;
const CONCRETE = mat(0xb0aca2, 0.85);
const CONCRETE_DARK = mat(0x7f7b74, 0.9);
const DECK = mat(0x9c9890, 0.9);
const ASPHALT = mat(0x3a3b3d, 0.95);
const PILE = mat(0x5e5b56, 0.85);
const STEEL = mat(0x8a8f95, 0.45, 0.7);
const RAIL = mat(0xcfd2d4, 0.4, 0.6);
const BOLLARD = mat(0x2a2b2d, 0.5, 0.4);
const YELLOW = mat(0xe3b51b, 0.6);
const WHITE = mat(0xefeeea, 0.45);
const PAINT = mat(0xe9e7de, 0.7);
const FENDER = mat(0x151617, 0.8);
const PANEL = mat(0x3d4247, 0.5, 0.6);
const GLASS = mat(0x2c4252, 0.08, 0.25, 0, -1); // lit windows at dusk
const ROOF_LIGHT = mat(0xd9dcdf, 0.45, 0.5);
const GLASS_TINT = mat(0x2b4a5e, 0.1, 0.3);
const ROOF = mat(0x5a6068, 0.55, 0.4);
const NAVY_GREY = mat(0x5f6a73, 0.6, 0.2);
const HAZE_GREY = mat(0x8a939a, 0.55, 0.2);
const CRANE = mat(0xd9a21b, 0.5, 0.3);
const LAMP = mat(0xe8e2c8, 0.4);
const BUS = mat(0xf2f2ee, 0.35, 0.2, 1);
const CAR = mat(0xffffff, 0.35, 0.3, 1);
const RED = mat(0xb3261e, 0.5);
const BLUE = mat(0x1d3f8f, 0.5);

const deckSlab = (b: MeshBuilder, u0: number, u1: number, w0: number, w1: number, y: number, m: Mat = DECK) => {
  b.box((u0 + u1) / 2, y - D.deckThickness / 2, (w0 + w1) / 2, u1 - u0, D.deckThickness, w1 - w0, m);
};

/** Piles in bents across the deck (a cross-beam under each bent). */
function piles(b: MeshBuilder, u0: number, u1: number, ws: number[], y: number, step = 9, r = 0.45): void {
  for (let u = u0 + step / 2; u < u1; u += step) {
    for (const w of ws) b.cylinder([u, -12, w], [u, y - D.deckThickness, w], r, r, 8, PILE, false);
    b.box(u, y - D.deckThickness - 0.4, (ws[0] + ws[ws.length - 1]) / 2, 1.0, 0.8, Math.abs(ws[ws.length - 1] - ws[0]) + 1.2, CONCRETE_DARK, { top: true });
  }
}

/** A railing along u at w: posts every 2.5 m, a top rail (continuous, the obstacle wall) and a mid rail. */
function railing(b: MeshBuilder, u0: number, u1: number, w: number, y: number, lod: number): void {
  b.box((u0 + u1) / 2, y + 1.06, w, u1 - u0, 0.08, 0.16, RAIL, { bottom: false });
  if (lod) return;
  b.box((u0 + u1) / 2, y + 0.55, w, u1 - u0, 0.05, 0.05, RAIL);
  for (let u = u0 + 0.5; u <= u1; u += 2.5) b.box(u, y + 0.52, w, 0.06, 1.04, 0.06, RAIL, { top: true, bottom: true });
}

function bollard(b: MeshBuilder, u: number, w: number, y: number): void {
  b.cylinder([u, y, w], [u, y + D.bollardTop - 0.12, w], D.bollardR - 0.08, D.bollardR - 0.1, 8, BOLLARD, false);
  b.cylinder([u, y + D.bollardTop - 0.12, w], [u, y + D.bollardTop, w], D.bollardR, D.bollardR, 8, BOLLARD);
}

function lampPost(b: MeshBuilder, u: number, w: number, top: number, deckY: number, lod: number): void {
  if (lod) return;
  b.cylinder([u, deckY, w], [u, top, w], 0.14, 0.09, 6, STEEL, false);
  b.box(u, top + 0.2, w, 0.7, 0.4, 0.44, LAMP);
}

/** The cruise terminal (pier frame; see layout.ts). */
export function buildCruiseTerminal(c: CruiseTerminalLayout, lod = 0): MeshBuilder {
  const b = new MeshBuilder();
  const y = c.deckY;
  const t = c.trestle;
  const p = c.pier;
  // ── trestle and berthing pier ──
  deckSlab(b, t.u0, t.u1 + 1, -t.half, t.half, y);
  deckSlab(b, p.u0, p.u1, p.w0, p.w1, y);
  b.box((t.u0 + t.u1) / 2, y + 0.005, 0, t.u1 - t.u0, 0.01, 0.15, PAINT, { bottom: true }); // centre line
  railing(b, t.u0, t.u1, -t.half + 0.1, y, lod);
  railing(b, t.u0, t.u1, t.half - 0.1, y, lod);
  railing(b, p.u0, p.u1, p.w0 + 0.1, y, lod);
  b.box(p.u1 - 0.1, y + 1.06, (p.w0 + p.w1 - 3) / 2, 0.16, 0.08, p.w1 - 3 - p.w0, RAIL);
  if (!lod) {
    piles(b, t.u0 + 12, t.u1, [-t.half + 1.5, t.half - 1.5], y);
    piles(b, p.u0, p.u1, [p.w0 + 2, p.w0 + 10, -2, 6, p.w1 - 6, p.w1 - 1.5], y, 8, 0.5);
  }
  // yellow safety line along the berth edge
  b.box((p.u0 + p.u1) / 2, y + 0.006, p.w1 - 0.6, p.u1 - p.u0, 0.012, 0.25, YELLOW, { bottom: true });
  for (const bl of c.bollards) bollard(b, bl.u, bl.w, y);
  // cell fenders: a rubber cell against the face, a steel panel in front, from near the water to under the deck
  for (const f of c.fenders) {
    const top = y - 0.3;
    if (!lod) b.cylinder([f.u, 0.2, p.w1 + 0.55], [f.u, top - 0.2, p.w1 + 0.55], 0.55, 0.55, 10, FENDER, true);
    b.box(f.u, (top + 0.1) / 2, p.w1 + D.fenderOut - 0.2, 3.2, top - 0.1, 0.4, PANEL);
  }
  // ── terminal building ──
  const bd = c.building;
  const H = bd.height;
  const uc = (bd.u0 + bd.u1) / 2;
  const wc = (bd.w0 + bd.w1) / 2;
  const L = bd.u1 - bd.u0;
  const W = bd.w1 - bd.w0;
  // ground floor: white panels with a glazed band and columns; upper floor: a continuous curtain wall
  b.box(uc, y + 3.5, wc, L, 7, W, WHITE, { bottom: true, top: true });
  b.box(uc, y + 3.7, wc, L - 0.1, 3.4, W + 0.08, GLASS, { bottom: true, top: true });
  b.box(uc, y + 7.3, wc, L, 0.6, W, WHITE, { bottom: true });
  b.box(uc, y + 11.6, wc, L - 0.1, 8.2, W - 0.1, GLASS, { bottom: true, top: true });
  if (!lod)
    for (let u = bd.u0 + 3; u <= bd.u1 - 2.9; u += 6)
      for (const w of [bd.w0 + 0.12, bd.w1 - 0.12]) {
        b.box(u, y + 11.6, w, 0.4, 8.2, 0.24, WHITE);
        b.box(u, y + 3.5, w, 0.7, 7, 0.24, WHITE);
      }
  // the roof: a white slab at the eaves and a barrel vault (the atrium end has its own flat roof)
  b.box(uc, y + H - 0.4, wc, L, 0.8, W, WHITE);
  {
    const R = D.vaultRise;
    const va = bd.u0 + D.atriumLen;
    const seg = lod ? 6 : 14;
    const ring = (u: number): [number, number, number][] => {
      const pts: [number, number, number][] = [];
      for (let k = 0; k <= seg; k++) {
        const d = -W / 2 + (W * k) / seg;
        pts.push([u, y + H + R * (1 - (2 * d / W) ** 2), wc + d]);
      }
      return pts;
    };
    b.loft([ring(va), ring(bd.u1)], () => ROOF_LIGHT, false);
    // end walls of the vault (flat fans)
    for (const u of [va, bd.u1]) {
      const r = ring(u);
      for (let k = 0; k < seg; k++) b.poly([[u, y + H, r[k][2]], [u, r[k][1], r[k][2]], [u, r[k + 1][1], r[k + 1][2]], [u, y + H, r[k + 1][2]]], GLASS_TINT);
    }
  }
  // the glazed atrium at the land end, taller than the hall, with the blue-and-gold name band
  const aU = bd.u0 + D.atriumLen / 2;
  b.box(aU, y + D.atriumH / 2, wc, D.atriumLen, D.atriumH, W, GLASS, { bottom: true });
  b.box(aU, y + D.atriumH - 0.3, wc, D.atriumLen, 0.6, W, WHITE);
  if (!lod) {
    for (const w of [bd.w0 + 0.15, bd.w1 - 0.15]) for (let u = bd.u0 + 0.3; u <= bd.u0 + D.atriumLen; u += 4.4) b.box(u, y + D.atriumH / 2, w, 0.3, D.atriumH, 0.3, WHITE);
    b.box(bd.u0 + 0.1, y + D.atriumH - 3.2, wc, 0.2, 2.2, W * 0.7, BLUE);
    b.box(bd.u0 + 0.05, y + D.atriumH - 3.2, wc, 0.1, 0.5, W * 0.55, YELLOW);
    b.box(aU, y + 6.1, bd.w0 + 0.1, D.atriumLen * 0.8, 1.4, 0.2, BLUE);
    // entrance canopy (within the footprint)
    b.box(bd.u0 + 1.5, y + 3.6, wc, 3, 0.3, W * 0.5, WHITE);
  }
  // ── jet bridges: rotunda at the wall, a glazed tube out over the face, a cab, a support leg ──
  for (const br of c.bridges) {
    const len = br.w1 - br.w0;
    b.box(br.u, br.y + D.bridgeH / 2, br.w0 + len / 2, D.bridgeW, D.bridgeH, len, mat(0xc8ccd0, 0.4, 0.5));
    b.box(br.u, br.y + D.bridgeH * 0.62, br.w0 + len / 2, D.bridgeW + 0.04, 0.9, len - 0.6, GLASS_TINT);
    b.box(br.u, br.y + D.bridgeH / 2, br.w1 - 1.1, D.bridgeW, D.bridgeH, 2.2, mat(0x9aa0a6, 0.4, 0.5));
    b.cylinder([br.u, y, p.w1 - 4], [br.u, br.y, p.w1 - 4], 0.5, 0.45, 8, STEEL);
  }
  for (const l of c.lamps) lampPost(b, l.u, l.w, l.y, y, lod);
  // ── the apron ashore: a raised deck behind a retaining wall ──
  const a = c.apron;
  b.box((a.u0 + a.u1) / 2, (y - 3) / 2, (a.w0 + a.w1) / 2, a.u1 - a.u0, y + 3, a.w1 - a.w0, CONCRETE, { bottom: true, top: true });
  b.box((a.u0 + a.u1) / 2, y - 0.06, (a.w0 + a.w1) / 2, a.u1 - a.u0, 0.12, a.w1 - a.w0, ASPHALT, { bottom: true });
  if (!lod) {
    // parking bay lines and the bus bay kerb
    for (const ur of [c.shoreU - 43, c.shoreU - 73]) for (let w = -34.6; w >= -106; w -= 2.8) b.box(ur, y + 0.005, w, 10.5, 0.01, 0.1, PAINT, { bottom: true });
    b.box(c.shoreU - 8.5, y + 0.075, -75, 1.0, 0.15, 60, CONCRETE, { bottom: true });
  }
  for (const v of c.vehicles) {
    if (v.bus) {
      b.box(v.u, y + 0.5 + (v.h - 0.5) / 2, v.w, v.len, v.h - 0.5, v.wid, BUS);
      b.box(v.u, y + 2.2, v.w, v.len - 0.4, 1.1, v.wid + 0.04, GLASS);
      if (!lod) for (const du of [-v.len * 0.32, v.len * 0.3]) b.box(v.u + du, y + 0.5, v.w, 1.0, 1.0, v.wid - 0.1, FENDER);
    } else {
      b.box(v.u, y + 0.45, v.w, v.len, 0.7, v.wid, CAR);
      b.box(v.u + 0.2, y + 1.1, v.w, v.len * 0.55, 0.62, v.wid - 0.16, GLASS_TINT);
    }
  }
  for (const s of c.shelters) {
    b.box((s.u0 + s.u1) / 2, y + 2.5, (s.w0 + s.w1) / 2, s.u1 - s.u0, 0.2, s.w1 - s.w0, GLASS_TINT);
    if (!lod) for (const w of [s.w0 + 0.2, s.w1 - 0.2]) b.box(s.u0 + 0.3, y + 1.2, w, 0.12, 2.4, 0.12, STEEL);
  }
  return b;
}

/** The naval pier (pier frame; see layout.ts). */
export function buildNavalPier(n: NavalPierLayout, lod = 0): MeshBuilder {
  const b = new MeshBuilder();
  const y = n.deckY;
  const t = n.trestle;
  const h = n.head;
  deckSlab(b, t.u0, t.u1 + 1, -t.half, t.half, y);
  deckSlab(b, h.u0, h.u1, h.w0, h.w1, y);
  railing(b, t.u0, t.u1, -t.half + 0.1, y, lod);
  railing(b, t.u0, t.u1, t.half - 0.1, y, lod);
  if (!lod) {
    piles(b, t.u0 + 12, t.u1, [-t.half + 1.5, t.half - 1.5], y);
    for (let w = h.w0 + 4; w < h.w1; w += 8) for (const u of [h.u0 + 1.5, h.u0 + 9, h.u0 + 16, h.u1 - 1.5]) b.cylinder([u, -14, w], [u, y - D.deckThickness, w], 0.5, 0.5, 8, PILE, false);
    // bull rail and the yellow safety line along the face
    b.box(h.u1 - 0.6, y + 0.006, 0, 0.25, 0.012, h.w1 - h.w0, YELLOW, { bottom: true });
    b.box(h.u1 - 0.15, y - 0.2, 0, 0.3, 1.2, h.w1 - h.w0, NAVY_GREY);
  }
  for (const bl of n.bollards) bollard(b, bl.u, bl.w, y);
  // navy-grey floating camels between the ship and the face (ride at ~1 m freeboard)
  for (const c of n.camels) {
    const cw = (c.w0 + c.w1) / 2;
    b.box(h.u1 + D.camelOut / 2, 0.25, cw, D.camelOut, 1.7, c.w1 - c.w0, NAVY_GREY);
    if (!lod) for (const s of [-1, 1]) b.box(h.u1 + D.camelOut / 2, 0.95, cw + s * ((c.w1 - c.w0) / 2 - 0.4), D.camelOut - 0.3, 0.3, 0.8, FENDER);
  }
  // containers and a truck on the head
  const TINTS = [0x3f5a3c, 0x5f6a73, 0x7a4a32, 0x4c5a44];
  for (const st of n.stores) {
    b.box(st.u, y + st.h / 2, st.w, st.wid, st.h, st.len, mat(TINTS[st.tint % TINTS.length], 0.7, 0.3));
    if (!lod && st.tint === 3) b.box(st.u, y + st.h + 0.01 - 0.6, st.w + st.len / 2 - 1.2, st.wid + 0.02, 1.2, 2.2, GLASS);
  }
  // utility building: two storeys, concrete, a row of windows each floor, a flat roof
  const bd = n.building;
  const uc = (bd.u0 + bd.u1) / 2;
  const wc = (bd.w0 + bd.w1) / 2;
  b.box(uc, y + bd.height / 2, wc, bd.u1 - bd.u0, bd.height, bd.w1 - bd.w0, mat(0xc9c2b2, 0.85), { bottom: true });
  for (const fy of [2.1, 5.6]) b.box(uc, y + fy, wc, bd.u1 - bd.u0 + 0.08, 1.2, bd.w1 - bd.w0 - 3, GLASS, { bottom: true, top: true });
  b.box(uc, y + bd.height - 0.15, wc, bd.u1 - bd.u0, 0.3, bd.w1 - bd.w0, ROOF);
  // portal crane
  const cr = n.crane;
  const C = D.crane;
  for (const du of [-C.legSpan / 2, C.legSpan / 2]) for (const dw of [-C.legGauge / 2, C.legGauge / 2]) {
    b.box(cr.u + du, y + 5.5, cr.w + dw, 1.3, 11, 1.3, CRANE);
    if (!lod) b.box(cr.u + du, y + 0.5, cr.w + dw, 1.6, 1.0, 1.6, BOLLARD);
  }
  b.box(cr.u, y + 11.6, cr.w, C.legSpan + 1.6, 1.2, C.legGauge + 1.6, CRANE);
  b.box(cr.u, y + 15.2, cr.w, 8, 6, 9, CRANE);
  b.box(cr.u, y + 15.2, cr.w + 4.52, 5, 1.2, 0.04, GLASS);
  {
    const jr = (40 * Math.PI) / 180;
    const jl = 30;
    const ax = cr.w - 3;
    const bx = ax - jl * Math.cos(jr);
    const ay = y + 16.5;
    const by = ay + jl * Math.sin(jr);
    const len = Math.hypot(bx - ax, by - ay);
    b.with([cr.u, (ay + by) / 2, (ax + bx) / 2], [(Math.atan2(by - ay, ax - bx) * 180) / Math.PI, 0, 0], () => {
      b.box(0, 0, 0, 1.4, 1.6, len, CRANE);
    });
    if (!lod) b.cylinder([cr.u, by - 0.8, bx], [cr.u, y + 14, bx], 0.03, 0.03, 4, STEEL, false);
  }
  for (const l of n.lamps) lampPost(b, l.u, l.w, l.y, y, lod);
  // the apron ashore with the guard house and the barrier
  const a = n.apron;
  b.box((a.u0 + a.u1) / 2, (y - 3) / 2, (a.w0 + a.w1) / 2, a.u1 - a.u0, y + 3, a.w1 - a.w0, CONCRETE, { bottom: true, top: true });
  b.box((a.u0 + a.u1) / 2, y - 0.06, (a.w0 + a.w1) / 2, a.u1 - a.u0, 0.12, a.w1 - a.w0, ASPHALT, { bottom: true });
  const g = n.gate;
  b.box((g.u0 + g.u1) / 2, y + g.height / 2, (g.w0 + g.w1) / 2, g.u1 - g.u0, g.height, g.w1 - g.w0, HAZE_GREY, { bottom: true });
  b.box((g.u0 + g.u1) / 2, y + 1.9, (g.w0 + g.w1) / 2, g.u1 - g.u0 + 0.06, 1.1, g.w1 - g.w0 - 1.5, GLASS, { bottom: true, top: true });
  b.cylinder([g.u0 - 1, y, g.w0 - 0.6], [g.u0 - 1, y + 1.2, g.w0 - 0.6], 0.2, 0.2, 6, RED);
  if (!lod) b.box(g.u0 - 1, y + 1.05, g.w0 - 0.6 - 3, 0.12, 0.12, 6, RED);
  return b;
}
