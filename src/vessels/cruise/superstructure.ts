/**
 * MS Tater Star superstructure geometry (body frame, metres): the stacked tiers extruded from
 * their plan outlines with window-atlas walls (one quad strip per deck — the windows are texture),
 * their decks and wind-screen rails, the glazed bridge with its wings and interior, the lido deck
 * with the pool and loungers, the lifeboats in their davits, the raked funnel in Tater Line colours
 * and the foremast. Every static part is merged per material.
 */
import * as THREE from 'three';
import { tint, merge } from '../../aircraft/materials';
import { V, box, tube } from '../../aircraft/f16/geom';
import { fanCap, gridGeometry, type P3 } from '../geom';
import { atlasRowV } from './textures';
import { CRUISE_SHAPE, DECK_H, GCR, WINDOW_ROWS, WINDOW_TILE_M, tierHalfAt, tierZs, type TierSpec } from './shape';

export interface CruiseSuperGeometry {
  /** Walls material (window atlas). */
  walls: THREE.BufferGeometry;
  /** Parts material: decks, rails, bridge wings, pool rim, loungers, mast. */
  decks: THREE.BufferGeometry;
  /** Double-sided parts material: the bridge's interior and the bands above and below its glass. */
  bridgeInterior: THREE.BufferGeometry;
  /** Bridge glass. */
  glass: THREE.BufferGeometry;
  /** Pool water. */
  pool: THREE.BufferGeometry;
  /** Parts material, distant-LOD detail: lifeboats and davits. */
  boats: THREE.BufferGeometry;
  /** Parts material: the funnel. */
  funnel: THREE.BufferGeometry;
}

type Pt = { x: number; z: number };
const S = CRUISE_SHAPE;
const B = S.bridge;

/** The tier's plan outline as a run of points: starboard bow → stern, then port stern → bow (closed). */
function outline(t: TierSpec): Pt[] {
  const zs = tierZs(t);
  const stbd = zs.map((z) => ({ x: tierHalfAt(t, z), z }));
  const port = zs.slice(1, -1).reverse().map((z) => ({ x: -tierHalfAt(t, z), z }));
  return [...stbd, ...port, stbd[0]];
}

/** Outward hint for a tier's walls: away from its centre line (and its end-rounding centres). */
function outward(t: TierSpec) {
  return (x: number, _y: number, z: number): P3 => {
    const a = t.zFwd + t.roundFwd;
    const b = t.zAft - t.roundAft;
    return [x, 0, z < a ? z - a : z > b ? z - b : 0];
  };
}

/** A wall strip through a run of points between two heights; UVs: metres along the run / tile, v within an atlas row. */
function wallStrip(run: Pt[], y0: number, y1: number, row: number, hint: (x: number, y: number, z: number) => P3, u0 = 0): THREE.BufferGeometry {
  const perim: number[] = [u0];
  for (let j = 1; j < run.length; j++) perim.push(perim[j - 1] + Math.hypot(run[j].x - run[j - 1].x, run[j].z - run[j - 1].z));
  const [vb, vt] = atlasRowV(row);
  const grid: P3[][] = [run.map((p) => [p.x, y0, p.z] as P3), run.map((p) => [p.x, y1, p.z] as P3)];
  return gridGeometry(grid, hint, (i, j) => [perim[j] / WINDOW_TILE_M, i === 0 ? vb : vt]);
}

/** A flat deck (or ceiling / underside) over a tier's outline at height y, facing up (or down). */
function deckFill(t: TierSpec, y: number, up: boolean, inset = 0, z0 = -Infinity, z1 = Infinity): THREE.BufferGeometry {
  const zs = tierZs(t).filter((z) => z >= z0 && z <= z1);
  if (z0 > t.zFwd && zs[0] !== z0) zs.unshift(z0);
  if (z1 < t.zAft && zs[zs.length - 1] !== z1) zs.push(z1);
  const grid: P3[][] = zs.map((z) => {
    const h = Math.max(0, tierHalfAt(t, z) - inset);
    return [[-h, y, z], [-h / 2, y, z], [0, y, z], [h / 2, y, z], [h, y, z]] as P3[];
  });
  return gridGeometry(grid, [0, up ? 1 : -1, 0], (i, j) => [grid[i][j][0], grid[i][j][2]]);
}

/** A wind-screen rail (both faces) along a run, `h` high from y. */
function rail(run: Pt[], y: number, h: number, inset: number): THREE.BufferGeometry[] {
  const pts = run.map((p) => {
    const k = Math.abs(p.x) > inset ? (Math.abs(p.x) - inset) / Math.abs(p.x) : 0;
    return { x: p.x * k, z: p.z };
  });
  const grid: P3[][] = [pts.map((p) => [p.x, y, p.z] as P3), pts.map((p) => [p.x, y + h, p.z] as P3)];
  return [gridGeometry(grid, (x) => [x, 0, 0]), gridGeometry(grid, (x) => [-x, 0, 0])];
}

/** A tier's walls, deck by deck; `skip` drops the points of one deck's run forward of a z (the bridge front). */
function tierWalls(t: TierSpec, skip?: { deck: number; zBack: number }): THREE.BufferGeometry[] {
  const loop = outline(t);
  const h = t.deckH ?? DECK_H;
  const out: THREE.BufferGeometry[] = [];
  for (let k = 0; k < t.decks; k++) {
    const y0 = t.y0 + k * h;
    if (skip && skip.deck === k) {
      // the side and aft walls: from the bridge's back on starboard, round the stern, to its back on port
      const zb = skip.zBack;
      const run: Pt[] = [{ x: tierHalfAt(t, zb), z: zb }, ...loop.filter((p, i) => i < loop.length - 1 && p.z > zb && p.x >= 0)];
      run.push(...loop.filter((p, i) => i < loop.length - 1 && p.z > zb && p.x < 0), { x: -tierHalfAt(t, zb), z: zb });
      out.push(wallStrip(run, y0, y0 + h, t.styles[k], outward(t)));
    } else out.push(wallStrip(loop, y0, y0 + h, t.styles[k], outward(t)));
  }
  return out;
}

/** The glazed front run of the balcony tier's upper deck (starboard back → bow → port back). */
function bridgeRun(t: TierSpec): Pt[] {
  const loop = outline(t).slice(0, -1);
  const zb = B.zBack;
  const stbd = loop.filter((p) => p.x >= 0 && p.z < zb).sort((a, b) => b.z - a.z);
  const port = loop.filter((p) => p.x < 0 && p.z < zb).sort((a, b) => a.z - b.z);
  return [{ x: tierHalfAt(t, zb), z: zb }, ...stbd, ...port, { x: -tierHalfAt(t, zb), z: zb }];
}

/** Superellipse ring of the funnel at fraction t of its height (closed: the first point repeated). */
function funnelRing(t: number, n = 28): P3[] {
  const F = S.funnel;
  const cx = F.base.x + (F.top.x - F.base.x) * t;
  const cy = F.base.y + (F.top.y - F.base.y) * t;
  const cz = F.base.z + (F.top.z - F.base.z) * t;
  const k = 1 + (F.topScale - 1) * t;
  const pts: P3[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const e = 2 / 2.6;
    const x = Math.sign(s) * Math.pow(Math.abs(s), e) * F.halfWid * k;
    const z = Math.sign(c) * Math.pow(Math.abs(c), e) * F.halfLen * k;
    pts.push([cx + x, cy, cz + z]);
  }
  return pts;
}

function funnelGeometry(): THREE.BufferGeometry {
  const F = S.funnel;
  const band = (t0: number, t1: number, hex: number, rough: number) => {
    const rows: P3[][] = [];
    const n = Math.max(1, Math.ceil((t1 - t0) * 8));
    for (let i = 0; i <= n; i++) rows.push(funnelRing(t0 + ((t1 - t0) * i) / n));
    const cx = (F.base.x + F.top.x) / 2;
    const cz = (F.base.z + F.top.z) / 2;
    return tint(gridGeometry(rows, (x, _y, z) => [x - cx, 0, (z - cz) * 0.4]), hex, rough);
  };
  const parts = [
    band(0, F.bandLo, 0xf2f2ee, 0.4),
    band(F.bandLo, F.bandHi, 0xd9a13b, 0.35),
    band(F.bandHi, 0.93, 0xf2f2ee, 0.4),
    band(0.93, 1, 0x15181c, 0.6),
  ];
  // the dark top, a little down inside the rim, and two exhaust uptakes
  const top = funnelRing(0.985).slice(0, -1);
  parts.push(tint(fanCap(top, [0, 1, 0]), 0x0c0d0f, 0.9));
  for (const dx of [-1.3, 1.3]) parts.push(tint(tube(V(dx, F.top.y - 1, F.top.z - 1.5), V(dx, F.top.y + 0.9, F.top.z - 1.2), 0.55, 0.5, 14), 0x1b1d20, 0.5, 0.4));
  // the aft masthead light's pole
  parts.push(tint(tube(V(S.aftMast.x, F.top.y - 1, S.aftMast.z), V(S.aftMast.x, S.aftMast.y1, S.aftMast.z), 0.16, 0.1, 8), 0x2a2d31, 0.5, 0.5));
  return merge(parts);
}

function lifeboatGeometry(): THREE.BufferGeometry {
  const L = S.lifeboats;
  const parts: THREE.BufferGeometry[] = [];
  const r = L.height / 2;
  const proto = new THREE.CapsuleGeometry(r, L.length - 2 * r, 4, 12);
  proto.rotateX(Math.PI / 2);
  proto.scale(L.beam / L.height, 1, 1);
  for (const side of [1, -1]) {
    for (let i = 0; i < L.count; i++) {
      const z = L.z0 + i * L.pitch;
      const cy = L.y + r;
      parts.push(tint(proto.clone().translate(side * L.x, cy, z), 0xee7722, 0.55));
      // a white canopy stripe and the davits: two posts and arms, the falls
      parts.push(tint(box(L.beam * 0.72, 0.25, L.length * 0.62, V(side * L.x, cy + r * 0.86, z)), 0xf3f3ef, 0.5));
      for (const dz of [-L.length * 0.36, L.length * 0.36]) {
        const xw = 12.3;
        parts.push(tint(box(0.35, L.height + 0.9, 0.35, V(side * xw, L.y + (L.height + 0.9) / 2, z + dz)), 0x8d949a, 0.5, 0.5));
        parts.push(tint(box(Math.abs(L.x - xw) + 0.6, 0.3, 0.3, V(side * (xw + L.x) / 2, L.y + L.height + 0.75, z + dz)), 0x8d949a, 0.5, 0.5));
        parts.push(tint(box(0.06, 0.6, 0.06, V(side * L.x, L.y + L.height + 0.3, z + dz)), 0x2a2a2a, 0.8));
      }
    }
  }
  proto.dispose();
  return merge(parts);
}

export function buildCruiseSuperstructure(): CruiseSuperGeometry {
  const [, cabins, balc, lidoF, lidoA, sports] = S.tiers;
  const walls: THREE.BufferGeometry[] = [];
  const decks: THREE.BufferGeometry[] = [];
  for (const t of S.tiers) walls.push(...tierWalls(t, t === balc ? { deck: 1, zBack: B.zBack } : undefined));

  // Decks, overhang undersides, rails.
  const top = (t: TierSpec) => t.y0 + t.decks * (t.deckH ?? DECK_H);
  decks.push(tint(deckFill(cabins, top(cabins), true), 0xc6c6be, 0.85));
  decks.push(tint(deckFill(cabins, cabins.y0 - 0.02, false), 0xd8d8d2, 0.8));
  decks.push(tint(deckFill(balc, balc.y0 - 0.02, false), 0xd8d8d2, 0.8));
  decks.push(tint(deckFill(balc, top(balc), true), 0xbdbcb4, 0.85));
  decks.push(tint(deckFill(lidoF, top(lidoF), true), 0xb9b6ac, 0.85));
  decks.push(tint(deckFill(lidoA, top(lidoA), true), 0xb9b6ac, 0.85));
  decks.push(tint(deckFill(sports, top(sports), true), 0x5f7f78, 0.9));
  // the lido deck's teak round the pool, between the deckhouses
  decks.push(tint(deckFill(balc, top(balc) + 0.06, true, 1.2, lidoF.zAft + 0.5, lidoA.zFwd - 0.5), 0xa9855c, 0.8));
  for (const t of [cabins, balc, lidoF, lidoA, sports]) decks.push(...rail(outline(t), top(t), 1.1, 0.12).map((g) => tint(g, 0xf1f1ed, 0.45)));

  // Pool: water, a white rim, loungers on the teak.
  const P = S.pool;
  const pool = new THREE.PlaneGeometry(2 * P.half, P.z1 - P.z0).rotateX(-Math.PI / 2).translate(0, P.y + 0.14, (P.z0 + P.z1) / 2);
  const rimH = 0.4;
  decks.push(tint(box(2 * P.half + 1.2, rimH, 0.6, V(0, P.y + rimH / 2, P.z0 - 0.3)), 0xf4f4f0, 0.4));
  decks.push(tint(box(2 * P.half + 1.2, rimH, 0.6, V(0, P.y + rimH / 2, P.z1 + 0.3)), 0xf4f4f0, 0.4));
  decks.push(tint(box(0.6, rimH, P.z1 - P.z0, V(-P.half - 0.3, P.y + rimH / 2, (P.z0 + P.z1) / 2)), 0xf4f4f0, 0.4));
  decks.push(tint(box(0.6, rimH, P.z1 - P.z0, V(P.half + 0.3, P.y + rimH / 2, (P.z0 + P.z1) / 2)), 0xf4f4f0, 0.4));
  const loungers: THREE.BufferGeometry[] = [];
  for (const [z0, z1] of [[lidoF.zAft + 3, P.z0 - 3], [P.z1 + 3, lidoA.zFwd - 3]]) {
    for (let z = z0; z <= z1; z += 2.6) {
      for (let x = -10.5; x <= 10.5; x += 1.3) {
        if (Math.abs(x) < 1.5) continue;
        loungers.push(tint(box(0.7, 0.35, 1.9, V(x, P.y + 0.3, z)), 0xf6f6f2, 0.6));
      }
    }
  }
  decks.push(merge(loungers));

  // Bridge: glazed front, wings, the interior (floor, ceiling, back wall, console), mullions.
  const run = bridgeRun(balc);
  const glass = wallStrip(run, B.glassLo, B.glassHi, WINDOW_ROWS.plain, outward(balc));
  const interior: THREE.BufferGeometry[] = [];
  interior.push(tint(wallStrip(run, B.floorY, B.glassLo, WINDOW_ROWS.plain, outward(balc)), 0xf0f0ec, 0.5));
  interior.push(tint(wallStrip(run, B.glassHi, B.roofY, WINDOW_ROWS.plain, outward(balc)), 0xf0f0ec, 0.5));
  interior.push(tint(deckFill(balc, B.floorY + 0.02, true, 0.2, balc.zFwd, B.zBack), 0x4a4d50, 0.85));
  interior.push(tint(deckFill(balc, B.roofY - 0.06, false, 0.2, balc.zFwd, B.zBack), 0xe6e6e0, 0.8));
  const hb = tierHalfAt(balc, B.zBack) - 0.1;
  interior.push(tint(box(2 * hb, B.roofY - B.floorY, 0.2, V(0, (B.floorY + B.roofY) / 2, B.zBack + 0.1)), 0x9da3a8, 0.7));
  const eye = GCR.pilotEye;
  // the console along the windows, low enough to see the bow over it
  const zc = B.zFront + 0.25 + 0.4;
  interior.push(tint(box(9, 0.75, 0.8, V(0, B.floorY + 0.375, zc)), 0x202428, 0.6, 0.2));
  interior.push(tint(box(2.4, 0.08, 0.5, V(eye.x, B.floorY + 0.79, zc + 0.05)), 0x0e1114, 0.4, 0.3));
  for (let j = 1; j < run.length - 1; j += 2) {
    const p = run[j];
    decks.push(tint(box(0.14, B.glassHi - B.glassLo, 0.14, V(p.x, (B.glassLo + B.glassHi) / 2, p.z)), 0x2b3036, 0.5, 0.3));
  }
  for (const side of [1, -1]) {
    const x0 = tierHalfAt(balc, B.wingZ1) - 0.3;
    const x1 = B.wingHalf;
    const cx = side * (x0 + x1) / 2;
    const cz = (B.wingZ0 + B.wingZ1) / 2;
    decks.push(tint(box(x1 - x0, B.roofY - B.floorY, B.wingZ1 - B.wingZ0, V(cx, (B.floorY + B.roofY) / 2, cz)), 0xf0f0ec, 0.45));
    decks.push(tint(box(x1 - x0 + 0.4, 0.25, B.wingZ1 - B.wingZ0 + 0.5, V(cx, B.roofY + 0.12, cz)), 0xe2e2dc, 0.5));
  }
  const wingGlass: THREE.BufferGeometry[] = [];
  for (const side of [1, -1]) {
    const x0 = tierHalfAt(balc, B.wingZ1) - 0.3;
    const x1 = B.wingHalf;
    // the wing's front and outboard windows
    wingGlass.push(new THREE.PlaneGeometry(x1 - x0, B.glassHi - B.glassLo).rotateY(Math.PI).translate(side * (x0 + x1) / 2, (B.glassLo + B.glassHi) / 2, B.wingZ0 - 0.03));
    wingGlass.push(new THREE.PlaneGeometry(B.wingZ1 - B.wingZ0, B.glassHi - B.glassLo).rotateY((side * Math.PI) / 2).translate(side * (x1 + 0.03), (B.glassLo + B.glassHi) / 2, (B.wingZ0 + B.wingZ1) / 2));
  }
  const glassAll = merge([glass, ...wingGlass.map((g) => {
    g.deleteAttribute('normal');
    g.computeVertexNormals();
    return g;
  })]);

  // Foremast on the sports deck: a tapered pole, a yard, the radar platform and scanners.
  const M = S.mast;
  decks.push(tint(tube(V(M.x, M.y0, M.z), V(M.x, M.y1, M.z), 0.4, 0.14, 10), 0xe8e8e4, 0.45, 0.2));
  decks.push(tint(box(7, 0.2, 0.25, V(M.x, M.y1 - 2.4, M.z)), 0xe8e8e4, 0.45, 0.2));
  decks.push(tint(box(3.2, 0.25, 2.4, V(M.x, M.y0 + 3, M.z - 1.2)), 0xdcdcd6, 0.5));
  decks.push(tint(box(5.5, 0.3, 0.35, V(M.x, M.y0 + 3.5, M.z - 1.6)), 0x2a2d31, 0.5, 0.3));
  decks.push(tint(box(4.2, 0.28, 0.3, V(M.x, M.y0 + 4.6, M.z - 0.6)), 0x2a2d31, 0.5, 0.3));

  return {
    walls: merge(walls),
    decks: merge(decks),
    bridgeInterior: merge(interior),
    glass: glassAll,
    pool,
    boats: lifeboatGeometry(),
    funnel: funnelGeometry(),
  };
}
