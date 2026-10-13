/**
 * "Tater Alpha" platform model (render): procedural geometry from the dimensions in platform.ts,
 * in the platform's local frame (origin at the jacket centre at sea level, +X toward the flare).
 *
 *  - `buildPlatformGeometry(lod, depth)`: one merged, vertex-coloured BufferGeometry per LOD (the
 *    traffic MeshBuilder: colour + `aPbr` per vertex) — the jacket (four battered legs, X-braced
 *    faces, plan bracing, conductors, risers, a boat landing), the three-deck topside with its
 *    equipment, process modules, gas-turbine exhausts, the living quarters with lit windows, the
 *    helideck (green, white perimeter line and H, yellow touchdown circle, safety net), the drilling
 *    derrick, two pedestal cranes, lifeboats in davits and the lattice flare boom. LOD 1 (far) is a
 *    few hundred triangles of blocks.
 *  - `createPlatformModel()`: the LOD object (one draw call at any distance), the flame (crossed
 *    animated quads leaning downwind), the flare's glow on the sea at night, and the platform's
 *    light list for the shared point sprites.
 */
import * as THREE from 'three';
import { MeshBuilder, mat, type Mat } from '../traffic/models/builder';
import { PLATFORM, flareTipLocal, helideckCircumradius, platformLights, type PlatformLight } from './platform';
import { createFlameMaterial, createFlareUniforms, createGlowMaterial, createOffshoreMaterial, type FlareLightUniforms } from './materials';

type V3 = [number, number, number];

// ─── Palette (sRGB hex; linear inside `mat`) ─────────────────────────────────
const STEEL = mat(0x8c9196, 0.55, 0.55);
const STEEL_DARK = mat(0x5b6066, 0.6, 0.5);
const GROWTH = mat(0x3c4a3c, 0.95, 0);
const LEG_YELLOW = mat(0xd4a020, 0.55, 0.2);
const DECK_TOP = mat(0x5a5e62, 0.9, 0.1);
const DECK_EDGE = mat(0xc6c6be, 0.6, 0.3);
const DECK_UNDER = mat(0x6a6f74, 0.8, 0.3);
const MOD_WHITE = mat(0xd9d9d0, 0.7, 0.1);
const MOD_GREY = mat(0xaeb3b8, 0.7, 0.15);
const MOD_BLUE = mat(0x6f86a0, 0.65, 0.15);
const MOD_GREEN = mat(0x6c8a74, 0.7, 0.1);
const LQ_WHITE = mat(0xeceae4, 0.6, 0.05);
const LQ_TRIM = mat(0xc8401e, 0.6, 0.05);
const GLASS: Mat = { ...mat(0x1c2a36, 0.12, 0.6), l: -1 };
const HELI_GREEN = mat(0x2d5a36, 0.85, 0);
const HELI_WHITE = mat(0xf0f0ea, 0.7, 0);
const HELI_YELLOW = mat(0xf2c000, 0.7, 0);
const NET = mat(0x2c2f30, 0.9, 0.2);
const CRANE_YELLOW = mat(0xf0b000, 0.5, 0.25);
const CAB_WHITE = mat(0xe8e8e0, 0.5, 0.1);
const RED = mat(0xc41e18, 0.55, 0.1);
const WHITE = mat(0xefefe8, 0.6, 0.1);
const LIFEBOAT = mat(0xff6200, 0.5, 0.05);
const RAIL = mat(0xe0b020, 0.6, 0.3);
const TANK = mat(0xc9ccce, 0.45, 0.45);
const BLACK = mat(0x1c1c1c, 0.7, 0.2);

/** A straight member between two points (square tube for lattices, round for jacket legs). */
function member(b: MeshBuilder, a: V3, c: V3, r: number, m: Mat, segs = 4): void {
  b.cylinder(a, c, r, r, segs, m, false);
}

/**
 * A square-section lattice between two points: 4 chords (`w` apart at A, `w1` at B), girts every
 * `bay` m and one diagonal per face per bay. The section is squared to the world's vertical.
 */
function lattice(b: MeshBuilder, A: V3, B: V3, w: number, w1: number, bay: number, rChord: number, rWeb: number, m: Mat, web: Mat = m): void {
  const ax = new THREE.Vector3(B[0] - A[0], B[1] - A[1], B[2] - A[2]);
  const len = ax.length();
  ax.normalize();
  const up = Math.abs(ax.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(ax, up).normalize();
  const v = new THREE.Vector3().crossVectors(u, ax).normalize();
  const corner = (t: number, k: number): V3 => {
    const hw = (w + (w1 - w) * t) / 2;
    const su = k === 0 || k === 3 ? -1 : 1;
    const sv = k < 2 ? -1 : 1;
    return [A[0] + ax.x * len * t + (u.x * su + v.x * sv) * hw, A[1] + ax.y * len * t + (u.y * su + v.y * sv) * hw, A[2] + ax.z * len * t + (u.z * su + v.z * sv) * hw];
  };
  for (let k = 0; k < 4; k++) member(b, corner(0, k), corner(1, k), rChord, m);
  const n = Math.max(1, Math.round(len / bay));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    for (let k = 0; k < 4; k++) member(b, corner(t, k), corner(t, (k + 1) % 4), rWeb, web);
    if (i < n) {
      const t1 = (i + 1) / n;
      for (let k = 0; k < 4; k++) member(b, corner(t, i % 2 ? k : (k + 1) % 4), corner(t1, i % 2 ? (k + 1) % 4 : k), rWeb, web);
    }
  }
}

/** Jacket leg position (x, z) at height y (battered: spreading downward). */
function legAt(sx: number, sz: number, y: number): V3 {
  const L = PLATFORM.legs;
  const d = (L.topY - y) * L.batter;
  return [sx * (L.x + d), y, sz * (L.z + d)];
}

function buildJacket(b: MeshBuilder, depth: number, lod: number): void {
  const L = PLATFORM.legs;
  const seg = lod ? 6 : 14;
  const signs: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (const [sx, sz] of signs) {
    // below the waterline: marine growth; the splash zone and above: yellow
    member(b, legAt(sx, sz, -depth), legAt(sx, sz, -3), L.radius, GROWTH, seg);
    member(b, legAt(sx, sz, -3), legAt(sx, sz, L.topY), L.radius, LEG_YELLOW, seg);
    // pile sleeves at the mudline
    if (!lod) member(b, legAt(sx, sz, -depth), legAt(sx, sz, -depth + 6), L.radius * 1.6, GROWTH, 10);
  }
  if (lod) return;
  const levels = [L.topY - 0.5, ...PLATFORM.braceLevels.filter((y) => y > -depth + 2), -depth + 2];
  for (let i = 0; i < levels.length; i++) {
    const y = levels[i];
    const m = y < -3 ? GROWTH : STEEL;
    // horizontal frame and plan diagonals
    for (let k = 0; k < 4; k++) {
      const [ax, az] = signs[k];
      const [bx, bz] = signs[(k + 1) % 4];
      member(b, legAt(ax, az, y), legAt(bx, bz, y), 0.45, m, 8);
    }
    member(b, legAt(-1, -1, y), legAt(1, 1, y), 0.38, m, 6);
    member(b, legAt(1, -1, y), legAt(-1, 1, y), 0.38, m, 6);
    // X braces on every face down to the next level
    if (i < levels.length - 1) {
      const y1 = levels[i + 1];
      const mm = y1 < -3 ? GROWTH : STEEL;
      for (let k = 0; k < 4; k++) {
        const [ax, az] = signs[k];
        const [bx, bz] = signs[(k + 1) % 4];
        member(b, legAt(ax, az, y), legAt(bx, bz, y1), 0.42, mm, 8);
        member(b, legAt(bx, bz, y), legAt(ax, az, y1), 0.42, mm, 8);
      }
    }
  }
  // conductors under the derrick (3 × 3) and risers up a leg
  const d = PLATFORM.derrick;
  for (let i = -1; i <= 1; i++)
    for (let j = -1; j <= 1; j++) member(b, [d.cx + i * 2.4, -depth, d.cz + j * 2.4], [d.cx + i * 2.4, PLATFORM.cellarY, d.cz + j * 2.4], 0.36, i === 0 && j === 0 ? STEEL : STEEL_DARK, 8);
  for (let k = 0; k < 3; k++) {
    const [x0, , z0] = legAt(1, 1, -depth);
    const [x1, , z1] = legAt(1, 1, L.topY);
    member(b, [x0 - 2.2 - k * 0.9, -depth, z0 - 1.6], [x1 - 2.2 - k * 0.9, PLATFORM.cellarY, z1 - 1.6], 0.28, k === 0 ? LEG_YELLOW : STEEL_DARK, 8);
  }
  // boat landing on the (−x, +z) leg: a frame at the waterline, fenders, a ladder
  const [lx, , lz] = legAt(-1, 1, 0);
  b.box(lx - 2.2, 1.2, lz + 1.2, 1.2, 5.5, 5, LEG_YELLOW);
  b.box(lx - 2.9, 1.2, lz + 1.2, 0.3, 5.5, 5, BLACK);
  member(b, [lx - 1.4, 3.8, lz + 1.2], [lx - 0.6, L.topY + 1.5, lz + 0.6], 0.25, LEG_YELLOW, 6);
}

function deckPlate(b: MeshBuilder, x0: number, x1: number, z0: number, z1: number, y: number, t: number): void {
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  b.box(cx, y - t / 2, cz, x1 - x0, t, z1 - z0, DECK_UNDER, { top: true });
  b.box(cx, y - 0.05, cz, x1 - x0, 0.1, z1 - z0, DECK_TOP, { bottom: true });
  // edge beams (a lighter band round the plate)
  b.box(cx, y - t * 0.55, z0 + 0.3, x1 - x0, t * 0.9, 0.6, DECK_EDGE);
  b.box(cx, y - t * 0.55, z1 - 0.3, x1 - x0, t * 0.9, 0.6, DECK_EDGE);
  b.box(x0 + 0.3, y - t * 0.55, cz, 0.6, t * 0.9, z1 - z0, DECK_EDGE);
  b.box(x1 - 0.3, y - t * 0.55, cz, 0.6, t * 0.9, z1 - z0, DECK_EDGE);
}

function rails(b: MeshBuilder, x0: number, x1: number, z0: number, z1: number, y: number): void {
  const h = 1.1;
  for (const z of [z0 + 0.1, z1 - 0.1]) {
    b.box((x0 + x1) / 2, y + h, z, x1 - x0, 0.09, 0.09, RAIL);
    b.box((x0 + x1) / 2, y + h * 0.5, z, x1 - x0, 0.07, 0.07, RAIL);
    for (let x = x0; x <= x1; x += 2.5) b.box(x, y + h / 2, z, 0.07, h, 0.07, RAIL);
  }
  for (const x of [x0 + 0.1, x1 - 0.1]) {
    b.box(x, y + h, (z0 + z1) / 2, 0.09, 0.09, z1 - z0, RAIL);
    b.box(x, y + h * 0.5, (z0 + z1) / 2, 0.07, 0.07, z1 - z0, RAIL);
    for (let z = z0; z <= z1; z += 2.5) b.box(x, y + h / 2, z, 0.07, h, 0.07, RAIL);
  }
}

function buildTopside(b: MeshBuilder, lod: number): void {
  const P = PLATFORM;
  const t = P.topside;
  if (lod) {
    b.box((t.x0 + t.x1) / 2, (P.cellarY - 1.2 + P.weatherY) / 2, 0, t.x1 - t.x0, P.weatherY - P.cellarY + 1.2, t.z1 - t.z0, DECK_UNDER);
    b.box((t.x0 + t.x1) / 2, P.weatherY + 0.05, 0, t.x1 - t.x0, 0.1, t.z1 - t.z0, DECK_TOP);
    for (const m of P.modules) b.box((m.x0 + m.x1) / 2, (P.weatherY + m.top) / 2, (m.z0 + m.z1) / 2, m.x1 - m.x0, m.top - P.weatherY, m.z1 - m.z0, MOD_WHITE, { bottom: true });
    return;
  }
  // three decks, the cellar deck a little smaller
  deckPlate(b, t.x0 + 3, t.x1 - 3, t.z0 + 2, t.z1 - 2, P.cellarY, 1.4);
  deckPlate(b, t.x0, t.x1, t.z0, t.z1, P.mainY, 1.6);
  deckPlate(b, t.x0, t.x1, t.z0, t.z1, P.weatherY, 1.8);
  // columns on a grid between the decks (and down to the leg tops)
  for (let x = t.x0 + 2; x <= t.x1 - 1; x += 12.6)
    for (const z of [t.z0 + 1, 0, t.z1 - 1]) b.box(x, (P.cellarY - 1.4 + P.weatherY) / 2, z, 0.9, P.weatherY - P.cellarY + 1.4, 0.9, STEEL);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box(sx * P.legs.x, (P.legs.topY + P.cellarY) / 2, sz * P.legs.z, 2.4, P.cellarY - P.legs.topY, 2.4, LEG_YELLOW);
  // diagonal truss bracing on the long faces between the decks
  for (const z of [t.z0 + 0.4, t.z1 - 0.4]) {
    for (let x = t.x0 + 2; x < t.x1 - 8; x += 12.6) {
      member(b, [x, P.cellarY, z], [x + 12.6, P.mainY - 1.6, z], 0.22, STEEL);
      member(b, [x + 12.6, P.mainY, z], [x, P.weatherY - 1.8, z], 0.22, STEEL);
    }
  }
  // cellar-deck equipment: tanks, a pump row, pipe runs (glimpsed between the decks)
  for (let i = 0; i < 3; i++) b.cylinder([-22 + i * 13, P.cellarY + 2.2, -10], [-12 + i * 13, P.cellarY + 2.2, -10], 1.9, 1.9, 14, TANK);
  for (let i = 0; i < 5; i++) b.box(-18 + i * 9, P.cellarY + 1.2, 9, 3, 2.4, 2.6, MOD_BLUE);
  for (let k = 0; k < 4; k++) b.cylinder([t.x0 + 4, P.cellarY + 4.8 + k * 0.6, 14.5], [t.x1 - 6, P.cellarY + 4.8 + k * 0.6, 14.5], 0.22, 0.22, 6, k % 2 ? STEEL : MOD_GREY, false);
  // main deck: separators (horizontal vessels), compressors, partly clad bays
  b.cylinder([-4, P.mainY + 2.6, -12], [12, P.mainY + 2.6, -12], 2.2, 2.2, 16, TANK);
  b.cylinder([-4, P.mainY + 2.4, -5], [10, P.mainY + 2.4, -5], 1.8, 1.8, 16, TANK);
  b.box(20, P.mainY + 3, 8, 12, 6, 9, MOD_GREEN);
  b.box(-26, P.mainY + 3.4, 0, 12, 6.8, 30, MOD_GREY); // utilities below the quarters
  b.box(30, P.mainY + 3.4, -10, 8, 6.8, 14, MOD_WHITE);
  for (let k = 0; k < 5; k++) b.cylinder([t.x0 + 14, P.mainY + 6 + k * 0.5, 16.5], [t.x1 - 2, P.mainY + 6 + k * 0.5, 16.5], 0.25, 0.25, 6, k % 2 ? STEEL : TANK, false);
  // weather deck: process modules
  const mods = [MOD_WHITE, MOD_GREY, MOD_WHITE, MOD_BLUE, MOD_GREY];
  P.modules.forEach((m, i) => {
    const h = m.top - P.weatherY;
    b.box((m.x0 + m.x1) / 2, P.weatherY + h / 2, (m.z0 + m.z1) / 2, m.x1 - m.x0, h, m.z1 - m.z0, mods[i % mods.length], { bottom: true });
    // roof kit: louvres, a vent, a darker band at the eaves
    b.box((m.x0 + m.x1) / 2, m.top - 0.5, (m.z0 + m.z1) / 2, m.x1 - m.x0 + 0.1, 0.6, m.z1 - m.z0 + 0.1, STEEL_DARK, { bottom: true, top: true });
    b.box(m.x0 + 2, m.top + 0.8, m.z0 + 2, 2, 1.6, 2, STEEL);
  });
  // gas-turbine exhausts (power generation), with a darker lip
  for (let i = 0; i < 3; i++) {
    b.cylinder([26 + i * 3.4, P.weatherY, 3], [26 + i * 3.4, 54, 3], 1.1, 1.0, 12, STEEL, false);
    b.cylinder([26 + i * 3.4, 54, 3], [26 + i * 3.4, 55.2, 3], 1.1, 1.1, 12, BLACK);
  }
  // cold vent stack
  b.cylinder([33, P.weatherY, -16], [33, 62, -16], 0.6, 0.45, 10, STEEL);
  rails(b, t.x0, t.x1, t.z0, t.z1, P.weatherY);
}

function buildQuarters(b: MeshBuilder, lod: number): void {
  const P = PLATFORM;
  const q = P.quarters;
  const H = q.storeys * q.storeyH;
  const cx = (q.x0 + q.x1) / 2;
  const cz = (q.z0 + q.z1) / 2;
  const w = q.x1 - q.x0;
  const d = q.z1 - q.z0;
  b.box(cx, P.weatherY + H / 2, cz, w, H, d, LQ_WHITE, { bottom: true });
  if (lod) return;
  // window bands (glass flagged for the night windows) on all four faces, a trim stripe per storey
  for (let s = 0; s < q.storeys; s++) {
    const y = P.weatherY + s * q.storeyH + q.storeyH * 0.55;
    const e = 0.06;
    b.box(cx, y, q.z0 - e, w - 2, 1.3, 0.1, GLASS);
    b.box(cx, y, q.z1 + e, w - 2, 1.3, 0.1, GLASS);
    b.box(q.x0 - e, y, cz, 0.1, 1.3, d - 2, GLASS);
    b.box(q.x1 + e, y, cz, 0.1, 1.3, d - 2, GLASS);
    b.box(cx, P.weatherY + (s + 1) * q.storeyH - 0.2, cz, w + 0.3, 0.3, d + 0.3, LQ_TRIM, { top: true, bottom: true });
  }
  // stairs tower and the helideck access stair on the downwind side
  b.box(q.x1 + 2, P.weatherY + (H + 2.5) / 2, q.z0 + 3, 4, H + 2.5, 5, MOD_GREY, { bottom: true });
  // helideck support frame: columns and a ring beam from the roof to the deck underside
  const hd = P.helideck;
  const R = helideckCircumradius();
  for (let k = 0; k < 8; k++) {
    const a = ((k + 0.5) / 8) * Math.PI * 2;
    const x = hd.cx + Math.cos(a) * (R - 1.2);
    const z = hd.cz + Math.sin(a) * (R - 1.2);
    const xi = Math.min(q.x1 - 0.5, Math.max(q.x0 + 0.5, x));
    const zi = Math.min(q.z1 - 0.5, Math.max(q.z0 + 0.5, z));
    member(b, [xi, P.weatherY + H, zi], [x, hd.y - 0.6, z], 0.3, STEEL, 6);
  }
  // lifeboats (enclosed, orange) in davits on the starboard side of the quarters, at the main deck
  for (let i = 0; i < 3; i++) {
    const x = q.x0 + 4 + i * 7.5;
    const z = P.topside.z1 + 1.9;
    const y = P.mainY + 2.4;
    b.cylinder([x - 4, y, z], [x + 4, y, z], 1.45, 1.45, 12, LIFEBOAT);
    b.cylinder([x + 4, y, z], [x + 4.9, y, z], 1.45, 0.3, 12, LIFEBOAT);
    b.cylinder([x - 4, y, z], [x - 4.7, y, z], 1.45, 0.6, 12, LIFEBOAT);
    b.box(x, y + 1.35, z, 5.5, 0.7, 1.8, WHITE);
    for (const dx of [-3.2, 3.2]) {
      member(b, [x + dx, P.mainY, P.topside.z1], [x + dx, y + 2.6, z], 0.18, STEEL_DARK);
      member(b, [x + dx, y + 2.6, z], [x + dx, y + 1.4, z], 0.05, BLACK);
    }
  }
}

function buildHelideck(b: MeshBuilder, lod: number): void {
  const hd = PLATFORM.helideck;
  const R = helideckCircumradius();
  const y = hd.y;
  const oct = (r: number, yy: number): V3[] => Array.from({ length: 8 }, (_, k) => {
    const a = ((k + 0.5) / 8) * Math.PI * 2;
    // counter-clockwise seen from above (+Y normal): negate z so the winding faces up
    return [hd.cx + Math.cos(a) * r, yy, hd.cz - Math.sin(a) * r] as V3;
  });
  b.poly(oct(R, y), HELI_GREEN);
  // underside and edge (a 0.6 m deep plate)
  const top = oct(R, y);
  const bot = oct(R, y - 0.6);
  for (let k = 0; k < 8; k++) b.poly([bot[k], bot[(k + 1) % 8], top[(k + 1) % 8], top[k]], DECK_EDGE);
  b.poly(oct(R, y - 0.6).reverse(), DECK_UNDER);
  if (lod) return;
  const lift = 0.02;
  // white perimeter line (0.3 m) — as eight quads round the edge
  const o = oct(R, y + lift);
  const i2 = oct(R - 0.42, y + lift);
  for (let k = 0; k < 8; k++) b.poly([o[k], o[(k + 1) % 8], i2[(k + 1) % 8], i2[k]], HELI_WHITE);
  // yellow touchdown / positioning circle: inner Ø 0.5 D, 1 m wide
  const D = hd.flats;
  const r0 = D / 4;
  const r1 = r0 + 1;
  const n = 48;
  for (let k = 0; k < n; k++) {
    const a0 = (k / n) * Math.PI * 2;
    const a1 = ((k + 1) / n) * Math.PI * 2;
    const p = (r: number, a: number): V3 => [hd.cx + Math.cos(a) * r, y + lift, hd.cz - Math.sin(a) * r];
    b.poly([p(r1, a0), p(r1, a1), p(r0, a1), p(r0, a0)], HELI_YELLOW);
  }
  // white H (4 m × 6 m, 0.75 m strokes), its crossbar across the platform's long axis
  const s = 0.75;
  const hx = 2;
  const hz = 3;
  const Y = y + lift * 1.5;
  const rect = (x0: number, x1: number, z0: number, z1: number) => b.poly([[hd.cx + x0, Y, hd.cz + z1], [hd.cx + x1, Y, hd.cz + z1], [hd.cx + x1, Y, hd.cz + z0], [hd.cx + x0, Y, hd.cz + z0]], HELI_WHITE);
  rect(-hx, -hx + s, -hz, hz);
  rect(hx - s, hx, -hz, hz);
  rect(-hx + s, hx - s, -s / 2, s / 2);
  // perimeter safety net: 1.5 m wide, just below the deck edge, sloping out
  const n0 = oct(R + 0.05, y - 0.3);
  const n1 = oct(R + 1.5, y - 0.1);
  for (let k = 0; k < 8; k++) {
    b.poly([n0[k], n0[(k + 1) % 8], n1[(k + 1) % 8], n1[k]], NET);
    b.poly([n1[k], n1[(k + 1) % 8], n0[(k + 1) % 8], n0[k]], NET);
  }
}

function buildDerrick(b: MeshBuilder, lod: number): void {
  const d = PLATFORM.derrick;
  const base = PLATFORM.weatherY;
  // substructure / drill floor block
  b.box(d.cx, (base + d.floorY) / 2, d.cz, d.base + 4, d.floorY - base, d.base + 4, MOD_GREY, { bottom: true });
  if (lod) {
    b.prism(d.cx, d.cz, d.floorY, d.floorY + d.height, d.base, d.base, d.top, d.top, STEEL);
    return;
  }
  // doghouse and the pipe deck
  b.box(d.cx + d.base / 2 + 2.5, d.floorY + 1.6, d.cz + 3, 4.5, 3.2, 5, MOD_BLUE);
  // tapered lattice mast (red and white crown)
  lattice(b, [d.cx, d.floorY, d.cz], [d.cx, d.floorY + d.height * 0.8, d.cz], d.base, d.base + (d.top - d.base) * 0.8, 3.6, 0.3, 0.14, STEEL, STEEL);
  lattice(b, [d.cx, d.floorY + d.height * 0.8, d.cz], [d.cx, d.floorY + d.height, d.cz], d.base + (d.top - d.base) * 0.8, d.top, 2.4, 0.3, 0.14, RED, WHITE);
  // crown block and the racking board
  b.box(d.cx, d.floorY + d.height + 1.1, d.cz, d.top + 1, 2.2, d.top + 1, RED);
  b.box(d.cx, d.floorY + d.height * 0.55, d.cz - d.base * 0.3, d.base * 0.6, 0.4, 2.2, CRANE_YELLOW);
}

function buildCranes(b: MeshBuilder, lod: number): void {
  const base = PLATFORM.weatherY;
  for (const c of PLATFORM.cranes) {
    b.cylinder([c.cx, base, c.cz], [c.cx, c.pedestalTop, c.cz], 1.6, 1.4, lod ? 8 : 16, CRANE_YELLOW);
    const dir = Math.cos((c.boomDeg * Math.PI) / 180);
    // slewing house + cab
    b.box(c.cx - dir * 1.5, c.pedestalTop + 2, c.cz, 6, 4, 4.4, CRANE_YELLOW);
    b.box(c.cx + dir * 2.2, c.pedestalTop + 2.4, c.cz + 2.4, 2.4, 2.6, 1.6, CAB_WHITE);
    // A-frame
    member(b, [c.cx - dir * 3, c.pedestalTop + 4, c.cz - 1.5], [c.cx - dir * 1, c.pedestalTop + 8, c.cz], 0.2, CRANE_YELLOW);
    member(b, [c.cx - dir * 3, c.pedestalTop + 4, c.cz + 1.5], [c.cx - dir * 1, c.pedestalTop + 8, c.cz], 0.2, CRANE_YELLOW);
    // the boom in its rest: a lattice from the heel to the tip, sloping down a little
    const heel: V3 = [c.cx + dir * 1.5, c.pedestalTop + 1.6, c.cz];
    const tip: V3 = [c.cx + dir * c.boom, c.pedestalTop + 0.6, c.cz];
    if (lod) b.cylinder(heel, tip, 0.9, 0.5, 4, CRANE_YELLOW);
    else lattice(b, heel, tip, 1.8, 0.9, 2.6, 0.14, 0.07, CRANE_YELLOW);
    // boom rest
    b.box(tip[0] - dir * 3, (base + tip[1]) / 2, c.cz, 0.6, tip[1] - base, 0.6, CRANE_YELLOW);
  }
}

function buildFlareBoom(b: MeshBuilder, lod: number): void {
  const f = PLATFORM.flare;
  const tip = flareTipLocal();
  const root: V3 = [f.rootX - 2, f.rootY - 2, f.rootZ];
  const end: V3 = [tip.x, tip.y - 1, tip.z];
  if (lod) {
    b.cylinder(root, end, 1.2, 0.6, 4, STEEL);
    return;
  }
  lattice(b, root, end, 4, 2, 4.2, 0.2, 0.1, STEEL);
  // red / white bands near the tip, the flare tip (burner) and a platform round it
  lattice(b, [end[0] - 8 * Math.cos((f.riseDeg * Math.PI) / 180), end[1] - 8 * Math.sin((f.riseDeg * Math.PI) / 180), end[2] - 1], end, 2.3, 2, 2, 0.21, 0.11, RED, WHITE);
  b.cylinder([tip.x, tip.y - 1.5, tip.z], [tip.x, tip.y + 1.5, tip.z], 0.7, 0.9, 12, STEEL_DARK);
  b.box(tip.x, tip.y - 1.6, tip.z, 3.6, 0.2, 3.6, STEEL);
}

/** The platform geometry for a level of detail (0 near, 1 far), in its local frame; `depth` = water depth under it (m). */
export function buildPlatformGeometry(lod: 0 | 1, depth: number = PLATFORM.depth): THREE.BufferGeometry {
  const b = new MeshBuilder();
  buildJacket(b, depth, lod);
  buildTopside(b, lod);
  buildQuarters(b, lod);
  buildHelideck(b, lod);
  buildDerrick(b, lod);
  buildCranes(b, lod);
  buildFlareBoom(b, lod);
  return b.build();
}

/** Distance (m) beyond which the far LOD is drawn. */
export const PLATFORM_LOD_DISTANCE = 2600;

export interface PlatformModel {
  /** Positioned in the platform's local frame: add to a group placed and rotated at the site. */
  root: THREE.Group;
  uniforms: FlareLightUniforms;
  lights: PlatformLight[];
  /** Flare tip, local. */
  flareTip: { x: number; y: number; z: number };
  /** Per frame: flame animation, flare light, night windows, the glow on the sea. */
  update(time: number, night: number): void;
  /** The flare's current light intensity (0..~1.3, flickering). */
  flareLevel(): number;
  triangles(lod: 0 | 1): number;
  dispose(): void;
}

/** The whole platform model (in its local frame). */
export function createPlatformModel(depth: number = PLATFORM.depth): PlatformModel {
  const root = new THREE.Group();
  root.name = 'offshore.platform';
  const uniforms = createFlareUniforms();
  const material = createOffshoreMaterial(uniforms, { flare: true, name: 'offshore.platform' });
  const near = buildPlatformGeometry(0, depth);
  const far = buildPlatformGeometry(1, depth);
  const lod = new THREE.LOD();
  lod.name = 'offshore.platform.lod';
  const nearMesh = new THREE.Mesh(near, material);
  nearMesh.castShadow = true;
  nearMesh.receiveShadow = true;
  const farMesh = new THREE.Mesh(far, material);
  farMesh.castShadow = false;
  farMesh.receiveShadow = true;
  lod.addLevel(nearMesh, 0);
  lod.addLevel(farMesh, PLATFORM_LOD_DISTANCE);
  root.add(lod);
  // the flare's light position in view space, per render (both LOD meshes share the material)
  const tip = flareTipLocal();
  const flareLocal = new THREE.Vector3(tip.x, tip.y + 9, tip.z);
  const tmp = new THREE.Vector3();
  const setView = (_r: THREE.WebGLRenderer, _s: THREE.Scene, camera: THREE.Camera) => {
    tmp.copy(flareLocal);
    root.localToWorld(tmp);
    uniforms.uFlareView.value.copy(tmp).applyMatrix4(camera.matrixWorldInverse);
  };
  nearMesh.onBeforeRender = setView;
  farMesh.onBeforeRender = setView;

  // flame: three crossed quads, 12 m wide and 17 m tall, leaning downwind (local +X)
  const flameMat = createFlameMaterial();
  const quad = new THREE.PlaneGeometry(12, 17, 1, 1);
  quad.translate(0, 8.5, 0);
  const flame = new THREE.Group();
  flame.name = 'offshore.flame';
  const flameGeo: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 3; k++) {
    const g = quad.clone();
    g.rotateY((k / 3) * Math.PI);
    flameGeo.push(g);
  }
  quad.dispose();
  const merged = mergeGeometries(flameGeo);
  for (const g of flameGeo) g.dispose();
  const flameMesh = new THREE.Mesh(merged, flameMat);
  flameMesh.frustumCulled = false;
  flameMesh.renderOrder = 2;
  flame.add(flameMesh);
  flame.position.set(tip.x, tip.y + 1.2, tip.z);
  flame.rotation.z = -0.25; // lean toward +X (downwind)
  root.add(flame);

  // glow on the sea under the flare (night)
  const glowMat = createGlowMaterial();
  const glowGeo = new THREE.PlaneGeometry(200, 200);
  glowGeo.rotateX(-Math.PI / 2);
  const glow = new THREE.Mesh(glowGeo, glowMat);
  glow.name = 'offshore.flareGlow';
  glow.position.set(tip.x + 10, 0.4, tip.z);
  glow.renderOrder = 1;
  root.add(glow);

  let level = 1;
  return {
    root,
    uniforms,
    lights: platformLights(),
    flareTip: tip,
    update(time, night) {
      // flicker: a few incommensurate sines (the flame roars)
      level = 1 + 0.12 * Math.sin(time * 7.1) + 0.08 * Math.sin(time * 12.7 + 1.3) + 0.06 * Math.sin(time * 3.3 + 0.4);
      flameMat.uniforms.uTime.value = time;
      flameMat.uniforms.uIntensity.value = (1.3 + 5 * night) * level;
      const k = (120 + 1500 * night) * level;
      uniforms.uFlareColor.value.setRGB(1.0 * k, 0.55 * k, 0.2 * k);
      uniforms.uNight.value = night;
      glowMat.uniforms.uColor.value.setRGB(0.9, 0.42, 0.12).multiplyScalar(0.12 * night * level);
      glow.visible = night > 0.02;
      const sway = Math.sin(time * 0.9) * 0.05 + Math.sin(time * 2.3) * 0.02;
      flame.rotation.z = -0.25 + sway;
      flame.scale.setScalar(0.92 + 0.1 * level);
    },
    flareLevel: () => level,
    triangles: (l) => (l === 0 ? near : far).index!.count / 3,
    dispose() {
      near.dispose();
      far.dispose();
      merged.dispose();
      glowGeo.dispose();
      material.dispose();
      flameMat.dispose();
      glowMat.dispose();
    },
  };
}

/** Merges non-indexed/indexed geometries with the same attributes (position, normal, uv). */
function mergeGeometries(gs: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let base = 0;
  for (const g of gs) {
    const p = g.getAttribute('position');
    const u = g.getAttribute('uv');
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      uv.push(u.getX(i), u.getY(i));
    }
    const ix = g.getIndex();
    if (ix) for (let i = 0; i < ix.count; i++) idx.push(base + ix.getX(i));
    base += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  out.setIndex(idx);
  out.computeBoundingSphere();
  return out;
}
