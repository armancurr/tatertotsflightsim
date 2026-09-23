/**
 * Static harbour structures, built in the marina's local (u, w) frame mapped to
 * a geometry whose origin is the marina frame origin (rotation about Y applied
 * by the instance): rubble-mound breakwaters with a concrete crest path and
 * harbour-entrance beacons, the quay wall with bollards, floating pontoons with
 * fingers and piles, gangways. Also the bay ferry terminals (trestle pier,
 * transfer ramp, berthing dolphins, terminal building).
 */
import { MeshBuilder, mat } from './builder';
import { h01 } from '../rng';
import type { MarinaLayout } from '../sea';

const CONCRETE = mat(0xa8a49a, 0.85);
const CONCRETE_DARK = mat(0x7d7a73, 0.9);
const PONTOON_DECK = mat(0x8e8a80, 0.85);
const PONTOON_SIDE = mat(0xd2d0c8, 0.6);
const PILE = mat(0x3e3d3a, 0.7, 0.3);
const PILE_CAP = mat(0xd8d8d2, 0.5);
const BOLLARD = mat(0x2a2b2d, 0.5, 0.4);
const LAMP = mat(0xe8e2c8, 0.4);
const ROCKS = [0x6f6d68, 0x86837b, 0x5d5b57, 0x9a968d, 0x77736b, 0x8d887f].map((c) => mat(c, 0.92));
const RED = mat(0xb3261e, 0.5);
const GREEN = mat(0x1f7a3a, 0.5);
const WHITE = mat(0xeeeeea, 0.4);
const GLASS = mat(0x10161c, 0.08, 0.1, 0, -1); // lit windows at dusk
const TIMBER = mat(0x5b4a3a, 0.85);

/**
 * Geometry for the marina (origin = marina frame origin, +x = u along the coast, +z = w out to
 * sea; the instance rotates it by the coast angle).
 */
export function buildMarina(m: MarinaLayout, lod = 0): MeshBuilder {
  const b = new MeshBuilder();
  // In the geometry frame: x = u, z = w (w is "south-ish"); the instance applies the coast rotation.
  // ── Quay: block from the land into the water with a vertical front face ──
  const q = m.quay;
  b.box((q.u0 + q.u1) / 2, (q.top - 4) / 2, (q.w0 + q.w1) / 2, q.u1 - q.u0, q.top + 4, q.w1 - q.w0, CONCRETE, { bottom: true });
  b.box((q.u0 + q.u1) / 2, q.top - 0.15, q.w1 - 0.4, q.u1 - q.u0, 0.3, 0.8, CONCRETE_DARK, { bottom: true }); // coping
  if (!lod) {
    for (let u = q.u0 + 10; u < q.u1 - 5; u += 16) b.cylinder([u, q.top, q.w1 - 0.8], [u, q.top + 0.55, q.w1 - 0.8], 0.22, 0.26, 8, BOLLARD);
    for (let u = q.u0 + 30; u < q.u1; u += 60) {
      b.cylinder([u, q.top, q.w0 + 4], [u, q.top + 6, q.w0 + 4], 0.08, 0.06, 5, BOLLARD, false);
      b.box(u, q.top + 6.1, q.w0 + 4.3, 0.3, 0.2, 0.8, LAMP);
    }
  }
  // ── Breakwaters: rubble mound along the centreline ──
  for (const bw of m.breakwaters) buildBreakwater(b, bw, lod);
  // ── Beacons at the heads (red to port, green to starboard entering) ──
  for (const bc of m.beacons) {
    const col = bc.color === 'red' ? RED : GREEN;
    b.cylinder([bc.u, 3.2, bc.w], [bc.u, 8.5, bc.w], 0.9, 0.75, 12, col);
    b.cylinder([bc.u, 6.4, bc.w], [bc.u, 7.2, bc.w], 0.83, 0.8, 12, WHITE, false);
    b.cylinder([bc.u, 8.5, bc.w], [bc.u, 9.4, bc.w], 0.35, 0.35, 8, GLASS);
    b.cylinder([bc.u, 9.4, bc.w], [bc.u, 9.8, bc.w], 0.5, 0.1, 8, col);
  }
  // ── Pontoons, fingers, piles, gangways ──
  for (const p of m.pontoons) {
    const len = p.w1 - p.w0;
    b.box(p.u, 0.12, (p.w0 + p.w1) / 2, 2 * p.half, 0.86, len, PONTOON_SIDE, { bottom: true });
    b.box(p.u, 0.56, (p.w0 + p.w1) / 2, 2 * p.half - 0.1, 0.02, len - 0.1, PONTOON_DECK, { bottom: true });
    // gangway from the quay down to the pontoon
    const g0 = q.w1 - 1;
    const g1 = p.w0 + 4;
    const dy = q.top - 0.55;
    const gl = Math.hypot(g1 - g0, dy);
    b.with([p.u, (q.top + 0.6) / 2 + 0.05, (g0 + g1) / 2], [(-Math.atan2(dy, g1 - g0) * 180) / Math.PI, 0, 0], () => {
      b.box(0, 0, 0, 1.4, 0.12, gl, mat(0x9a9892, 0.5, 0.6));
    });
  }
  if (!lod) {
    for (const f of m.fingers) b.box((f.u0 + f.u1) / 2, 0.3, f.w, f.u1 - f.u0, 0.5, 2 * f.half, PONTOON_SIDE, { bottom: true });
    for (const pl of m.piles) {
      b.cylinder([pl.u, -3, pl.w], [pl.u, 2.9, pl.w], 0.24, 0.24, 8, PILE, false);
      b.cylinder([pl.u, 2.9, pl.w], [pl.u, 3.05, pl.w], 0.26, 0.2, 8, PILE_CAP);
    }
  }
  return b;
}

function buildBreakwater(b: MeshBuilder, bw: MarinaLayout['breakwaters'][number], lod: number): void {
  // dense centreline
  const cl: { u: number; w: number }[] = [];
  const step = lod ? 8 : 3;
  for (let i = 1; i < bw.pts.length; i++) {
    const a = bw.pts[i - 1];
    const c = bw.pts[i];
    const L = Math.hypot(c.u - a.u, c.w - a.w);
    const n = Math.max(1, Math.round(L / step));
    for (let k = 0; k < n; k++) cl.push({ u: a.u + ((c.u - a.u) * k) / n, w: a.w + ((c.w - a.w) * k) / n });
  }
  cl.push(bw.pts[bw.pts.length - 1]);
  // cross-section: base → toe → armour slope → crest → mirror
  const prof: [number, number][] = [
    [-bw.baseHalf, bw.baseY],
    [-bw.baseHalf * 0.72, -2.5],
    [-bw.baseHalf * 0.5, 0.2],
    [-bw.crestHalf - 1.5, bw.crestY - 0.8],
    [-bw.crestHalf, bw.crestY],
    [bw.crestHalf, bw.crestY],
    [bw.crestHalf + 1.5, bw.crestY - 0.8],
    [bw.baseHalf * 0.5, 0.2],
    [bw.baseHalf * 0.72, -2.5],
    [bw.baseHalf, bw.baseY],
  ];
  const rings: [number, number, number][][] = [];
  for (let i = 0; i < cl.length; i++) {
    const a = cl[Math.max(0, i - 1)];
    const c = cl[Math.min(cl.length - 1, i + 1)];
    const tu = c.u - a.u;
    const tw = c.w - a.w;
    const tl = Math.hypot(tu, tw) || 1;
    const nu = tw / tl;
    const nw = -tu / tl;
    const ring: [number, number, number][] = prof.map(([x, y], k) => {
      // rock armour: irregular bumps on the slopes, none on the crest path
      const onCrest = k === 4 || k === 5;
      const j = onCrest ? 0 : (h01(77, i, k) - 0.5) * 1.4;
      const jy = onCrest ? 0 : (h01(78, i, k) - 0.5) * 1.1;
      return [cl[i].u + nu * (x + j), y + jy, cl[i].w + nw * (x + j)];
    });
    rings.push(ring);
  }
  b.loft(rings, (i, j) => (j === 4 ? CONCRETE : ROCKS[Math.floor(h01(79, i, j) * ROCKS.length)]), false, true);
  // head: a rounded rock pile closing the end
  const end = cl[cl.length - 1];
  b.cylinder([end.u, bw.baseY, end.w], [end.u, bw.crestY + 0.2, end.w], bw.baseHalf, bw.crestHalf + 1, lod ? 6 : 12, ROCKS[1], true);
  const start = cl[0];
  b.cylinder([start.u, bw.baseY, start.w], [start.u, bw.crestY, start.w], bw.baseHalf * 0.9, bw.crestHalf, 6, ROCKS[2], false);
}

/**
 * A ferry terminal in a local frame whose +x points from the shore out along the pier:
 * trestle pier from x = −20 (on land) to x = pierLen, transfer ramp, dolphins, small terminal building.
 */
export function buildFerryTerminal(pierLen: number, lod = 0): MeshBuilder {
  const b = new MeshBuilder();
  const deckY = 4.4;
  b.box((pierLen - 20) / 2, deckY - 0.35, 0, pierLen + 20, 0.7, 11, CONCRETE, {});
  b.box((pierLen - 20) / 2, deckY + 0.5, 5.4, pierLen + 20, 1.0, 0.25, CONCRETE_DARK, {}); // parapets
  b.box((pierLen - 20) / 2, deckY + 0.5, -5.4, pierLen + 20, 1.0, 0.25, CONCRETE_DARK, {});
  if (!lod) {
    for (let x = 0; x < pierLen; x += 9) for (const z of [-4, 4]) b.cylinder([x, -5, z], [x, deckY - 0.7, z], 0.4, 0.4, 8, CONCRETE_DARK, false);
    for (let x = 10; x < pierLen; x += 30) {
      b.cylinder([x, deckY, 5], [x, deckY + 7, 5], 0.1, 0.08, 5, BOLLARD, false);
      b.box(x, deckY + 7.1, 4.4, 0.3, 0.2, 1.0, LAMP);
    }
  }
  // transfer span (hinged ramp) and its lifting towers
  b.box(pierLen + 7, deckY - 0.5, 0, 14, 0.5, 9, mat(0x8f8b83, 0.6, 0.5));
  for (const z of [-5.5, 5.5]) {
    b.box(pierLen + 1, deckY + 5, z, 1.2, 10, 1.2, mat(0xd9b21c, 0.5, 0.3));
  }
  b.box(pierLen + 1, deckY + 10.2, 0, 1.4, 0.8, 12.4, mat(0xd9b21c, 0.5, 0.3));
  // berthing dolphins along both sides of the ferry berth (ferry length ≈ 92 m)
  for (const x of [pierLen + 20, pierLen + 50, pierLen + 80]) {
    for (const z of [-13, 13]) {
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2;
        b.cylinder([x + Math.cos(a) * 1.2, -5, z + Math.sin(a) * 1.2], [x + Math.cos(a) * 0.6, 5.2, z + Math.sin(a) * 0.6], 0.4, 0.35, 6, TIMBER, false);
      }
      b.cylinder([x, 5.2, z], [x, 5.8, z], 1.1, 1.1, 8, PILE_CAP);
    }
  }
  // terminal building on the shore end
  b.box(-26, 3.5, 14, 22, 7, 12, WHITE, { bottom: true });
  b.box(-26, 4.2, 14, 22.05, 2.2, 12.05, GLASS, { bottom: true, top: true });
  b.box(-26, 7.2, 14, 23, 0.4, 13, mat(0x5a6068, 0.5, 0.4));
  return b;
}
