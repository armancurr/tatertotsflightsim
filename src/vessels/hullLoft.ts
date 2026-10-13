/**
 * Generic hull loft: builds the drawn hull of any vessel from its station table (`HullStation[]`,
 * the same table the physics floats — see src/vessels/hullSection.ts for the section shape and the
 * PCHIP interpolation along z). Nothing here knows about a particular boat; a Princess V50, a
 * trawler, a cruise ship or a battleship are all a station table plus options.
 *
 *   buildHullShell   the outer skin: V bottom + topsides per side (crisp keel and chine creases),
 *                    rings exactly at every station (so the drawn hull passes through the table),
 *                    optional transom / stem caps and a full cambered deck (watertight together).
 *   buildHullDeck    a cambered deck between two z, full width or as side strips outboard of an
 *                    inner half-width (around a coachroof, a cockpit well…).
 *   buildHullPatch   a patch lying on the skin between two heights (hull windows, stripes, names).
 *   buildSprayRail   a spray rail / chine flat: a small ledge with a horizontal underside along a
 *                    girth line of the bottom.
 *   hullSampleZs     the ring positions: every station plus even subdivisions (≤ maxStep).
 *
 * Body frame: +X starboard, +Y up, −Z bow, metres. Outputs are indexed BufferGeometries with
 * position / normal / uv, outward normals.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { HullStation } from '../config';
import { fanCap, gridGeometry, type P3 } from './geom';
import { hullSectionAt, sectionBottomY, sectionHalfBreadth, sectionOutlinePoint, type HullSection } from './hullSection';

export { createHullInterpolator, hullSectionAt, pchipEval, pchipTangents, sectionArea, sectionBottomY, sectionHalfBreadth, sectionOutlinePoint } from './hullSection';
export type { HullInterpolator, HullSection } from './hullSection';

/**
 * Ring positions along the hull: every station in [z0, z1] exactly, plus z0 and z1, with each
 * interval split evenly so no gap exceeds maxStep. Ascending.
 */
export function hullSampleZs(stations: readonly HullStation[], maxStep = 0.25, z0 = stations[0].z, z1 = stations[stations.length - 1].z): number[] {
  const knots = [z0, ...stations.map((s) => s.z).filter((z) => z > z0 + 1e-9 && z < z1 - 1e-9), z1];
  const out: number[] = [];
  for (let k = 0; k < knots.length - 1; k++) {
    const a = knots[k];
    const b = knots[k + 1];
    const n = Math.max(1, Math.ceil((b - a) / maxStep - 1e-9));
    for (let i = 0; i < n; i++) out.push(a + ((b - a) * i) / n);
  }
  out.push(z1);
  return out;
}

/** Height of a cambered deck at x: the deck edge height plus `camber` × (1 − (x / deckHalf)²). */
export function deckHeightAt(s: HullSection, x: number, camber: number): number {
  const u = s.deckHalf > 1e-9 ? Math.min(1, Math.abs(x) / s.deckHalf) : 1;
  return s.deckY + camber * (1 - u * u);
}

export interface HullShellOptions {
  /** Largest ring spacing along z, m (default 0.25). */
  maxStep?: number;
  /** Subdivisions of the V bottom (keel → chine) and of the topsides (chine → deck), per side. */
  bottomSegments?: number;
  sideSegments?: number;
  /** Close the stern (flat transom at the last station) and the bow (the first station's section). */
  capStern?: boolean;
  capBow?: boolean;
  /** A full-length cambered deck closing the top (camber in m; true = 0.05 m), `segments` across. */
  deck?: boolean | { camber?: number; segments?: number };
}

/**
 * The hull's outer skin lofted through the station table. Separate panels per side for the bottom
 * and the topsides (split vertices along the keel and the chines keep those edges crisp); the
 * stern and bow caps and the deck (when asked for) share their edge positions with the skin, so
 * the whole is closed once positions are welded. UVs: skin (z, girth from the keel), caps (x, y),
 * deck (x, z) — all in metres.
 */
export function buildHullShell(stations: readonly HullStation[], opts: HullShellOptions = {}): THREE.BufferGeometry {
  const zs = hullSampleZs(stations, opts.maxStep ?? 0.25);
  const nb = Math.max(1, opts.bottomSegments ?? 8);
  const nt = Math.max(1, opts.sideSegments ?? 6);
  const secs = zs.map((z) => hullSectionAt(stations, z));
  const parts: THREE.BufferGeometry[] = [];

  for (const side of [1, -1]) {
    // Girth (m) from the keel for the UVs.
    const panel = (t0: number, t1: number, n: number) => {
      const grid: P3[][] = [];
      const girth: number[][] = [];
      for (const s of secs) {
        const row: P3[] = [];
        const gr: number[] = [];
        let acc = 0;
        let prev = sectionOutlinePoint(s, 0);
        const g1 = sectionOutlinePoint(s, 1);
        const base = t0 >= 1 ? Math.hypot(g1.x, g1.y - s.keelY) : 0;
        for (let j = 0; j <= n; j++) {
          const p = sectionOutlinePoint(s, t0 + ((t1 - t0) * j) / n);
          if (j === 0) prev = p;
          acc += Math.hypot(p.x - prev.x, p.y - prev.y);
          prev = p;
          row.push([side * p.x, p.y, s.z]);
          gr.push(base + acc);
        }
        grid.push(row);
        girth.push(gr);
      }
      // Outward: away from the centreline plane and down (bottom) / sideways (topsides).
      const hint = (_x: number, _y: number, z: number): P3 => {
        const s = hullSectionAt(stations, z);
        const a = sectionOutlinePoint(s, t0);
        const b = sectionOutlinePoint(s, t1);
        return [side * (b.y - a.y), -(b.x - a.x), 0];
      };
      return gridGeometry(grid, hint, (i, j) => [zs[i], girth[i][j]]);
    };
    parts.push(panel(0, 1, nb), panel(1, 2, nt));
  }

  const deckOpt = opts.deck ? (typeof opts.deck === 'object' ? opts.deck : {}) : null;
  const camber = deckOpt?.camber ?? 0.05;
  const nd = Math.max(2, deckOpt?.segments ?? 8);
  if (deckOpt) {
    const grid = secs.map((s) => {
      const row: P3[] = [];
      for (let j = 0; j <= nd; j++) {
        const x = -s.deckHalf + (2 * s.deckHalf * j) / nd;
        row.push([x, deckHeightAt(s, x, camber), s.z]);
      }
      return row;
    });
    parts.push(gridGeometry(grid, [0, 1, 0], (i, j) => [grid[i][j][0], zs[i]]));
  }

  // Caps: the section outline at the end ring, going round (starboard deck edge → keel → port deck
  // edge → back across the deck line), with exactly the skin's (and deck's) edge positions.
  const outline = (s: HullSection): P3[] => {
    const pts: P3[] = [];
    for (let j = nt; j >= 0; j--) {
      const p = sectionOutlinePoint(s, 1 + j / nt);
      pts.push([p.x, p.y, s.z]);
    }
    for (let j = nb - 1; j >= 1; j--) {
      const p = sectionOutlinePoint(s, j / nb);
      pts.push([p.x, p.y, s.z]);
    }
    pts.push([0, s.keelY, s.z]);
    for (let j = 1; j <= nb - 1; j++) {
      const p = sectionOutlinePoint(s, j / nb);
      pts.push([-p.x, p.y, s.z]);
    }
    for (let j = 0; j <= nt; j++) {
      const p = sectionOutlinePoint(s, 1 + j / nt);
      pts.push([-p.x, p.y, s.z]);
    }
    if (deckOpt) {
      for (let j = 1; j < nd; j++) {
        const x = -s.deckHalf + (2 * s.deckHalf * j) / nd;
        pts.push([x, deckHeightAt(s, x, camber), s.z]);
      }
    }
    return pts;
  };
  if (opts.capStern !== false) parts.push(fanCap(outline(secs[secs.length - 1]), [0, 0, 1]));
  if (opts.capBow !== false) parts.push(fanCap(outline(secs[0]), [0, 0, -1]));

  const out = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!out) throw new Error('hullLoft: merge failed');
  out.computeBoundingSphere();
  return out;
}

export interface HullDeckOptions {
  z0: number;
  z1: number;
  /** Deck camber at the centreline, m (default 0.05). */
  camber?: number;
  /**
   * Half-width of an opening in the middle (a coachroof, a cockpit well) at z: the deck is then
   * two side strips from ±inner(z) to the deck edge. Absent = full width.
   */
  inner?: (z: number) => number;
  /** Subdivisions across (full deck) or per strip; ring spacing along z. */
  segments?: number;
  maxStep?: number;
  /** Raise the deck by this much above the sheer line (a deck laid on top of the skin), m. */
  lift?: number;
}

/** A cambered deck (or side strips) between z0 and z1 on the hull's sheer line. UVs = (x, z) m. */
export function buildHullDeck(stations: readonly HullStation[], o: HullDeckOptions): THREE.BufferGeometry {
  const zs = hullSampleZs(stations, o.maxStep ?? 0.25, o.z0, o.z1);
  const camber = o.camber ?? 0.05;
  const lift = o.lift ?? 0;
  const n = Math.max(1, o.segments ?? (o.inner ? 2 : 8));
  const parts: THREE.BufferGeometry[] = [];
  const strip = (from: (s: HullSection) => number, to: (s: HullSection) => number) => {
    const grid = zs.map((z) => {
      const s = hullSectionAt(stations, z);
      const a = from(s);
      const b = to(s);
      const row: P3[] = [];
      for (let j = 0; j <= n; j++) {
        const x = a + ((b - a) * j) / n;
        row.push([x, deckHeightAt(s, x, camber) + lift, z]);
      }
      return row;
    });
    parts.push(gridGeometry(grid, [0, 1, 0], (i, j) => [grid[i][j][0], grid[i][j][2]]));
  };
  if (o.inner) {
    const inner = o.inner;
    strip((s) => Math.min(s.deckHalf, inner(s.z)), (s) => s.deckHalf);
    strip((s) => -s.deckHalf, (s) => -Math.min(s.deckHalf, inner(s.z)));
  } else strip((s) => -s.deckHalf, (s) => s.deckHalf);
  const out = parts.length === 1 ? parts[0] : mergeGeometries(parts, false)!;
  if (parts.length > 1) for (const p of parts) p.dispose();
  return out;
}

export interface HullPatchOptions {
  z0: number;
  z1: number;
  /** Lower and upper edge heights of the patch at z (clamped to the section). */
  yLo: (z: number) => number;
  yHi: (z: number) => number;
  /** 1 = starboard, −1 = port. */
  side: 1 | -1;
  /** Distance off the skin along the section normal, m (+ outboard). */
  offset?: number;
  /** Grid resolution along z and up the patch. */
  nz?: number;
  ny?: number;
}

/**
 * A patch lying on the hull skin between two heights (dark hull windows, a boot-top band, a name
 * board). UV u runs along z (0 → 1 from z0 to z1), v up the patch (0 → 1).
 */
export function buildHullPatch(stations: readonly HullStation[], o: HullPatchOptions): THREE.BufferGeometry {
  const nz = Math.max(1, o.nz ?? 24);
  const ny = Math.max(1, o.ny ?? 4);
  const off = o.offset ?? 0.006;
  const grid: P3[][] = [];
  for (let i = 0; i <= nz; i++) {
    const z = o.z0 + ((o.z1 - o.z0) * i) / nz;
    const s = hullSectionAt(stations, z);
    const lo = Math.max(s.keelY, Math.min(s.deckY, o.yLo(z)));
    const hi = Math.max(lo, Math.min(s.deckY, o.yHi(z)));
    const row: P3[] = [];
    for (let j = 0; j <= ny; j++) {
      const y = lo + ((hi - lo) * j) / ny;
      const x = sectionHalfBreadth(s, y);
      // Section normal of the segment this height lies on.
      const [ax, ay, bx, by] = y <= s.chineY ? [0, s.keelY, s.chineHalf, s.chineY] : [s.chineHalf, s.chineY, s.deckHalf, s.deckY];
      const len = Math.hypot(bx - ax, by - ay) || 1;
      const nx = (by - ay) / len;
      const nyy = -(bx - ax) / len;
      row.push([o.side * (x + off * nx), y + off * nyy, z]);
    }
    grid.push(row);
  }
  return gridGeometry(grid, [o.side, 0, 0], (i, j) => [i / nz, j / ny]);
}

export interface SprayRailOptions {
  z0: number;
  z1: number;
  /** Girth line of the rail's inner edge: 0 = keel … 1 = chine (a chine flat sits at 1). */
  t: number;
  /** Width of the horizontal underside, m, and the tallest outer face allowed, m. */
  width: number;
  maxHeight?: number;
  /** Length over which the rail fades in at z0 (and out at z1), m. */
  taper?: number;
  maxStep?: number;
}

/**
 * Spray rails (both sides): a ledge along a girth line of the bottom with a horizontal underside
 * `width` wide and an outer face rising to the skin. At t = 1 it is a chine flat.
 */
export function buildSprayRail(stations: readonly HullStation[], o: SprayRailOptions): THREE.BufferGeometry {
  const zs = hullSampleZs(stations, o.maxStep ?? 0.25, o.z0, o.z1);
  const hMax = o.maxHeight ?? 0.06;
  const taper = Math.max(1e-6, o.taper ?? 0.6);
  const parts: THREE.BufferGeometry[] = [];
  for (const side of [1, -1]) {
    const under: P3[][] = [];
    const face: P3[][] = [];
    for (const z of zs) {
      const s = hullSectionAt(stations, z);
      const w = o.width * Math.min(1, (z - o.z0) / taper, (o.z1 - z) / taper);
      const p1 = sectionOutlinePoint(s, o.t);
      const x2 = p1.x + w;
      // Outer face: straight up to the skin above the ledge's edge, or to hMax up the skin.
      let y3 = sectionBottomY(s, x2);
      let x3 = x2;
      if (!Number.isFinite(y3) || y3 - p1.y > hMax) {
        y3 = p1.y + Math.min(hMax, w);
        x3 = sectionHalfBreadth(s, y3);
      }
      const P1: P3 = [side * p1.x, p1.y, z];
      const P2: P3 = [side * x2, p1.y, z];
      const P3_: P3 = [side * x3, y3, z];
      under.push([P1, P2]);
      face.push([P2, P3_]);
    }
    parts.push(gridGeometry(under, [0, -1, 0]), gridGeometry(face, [side, 0.2, 0]));
  }
  const out = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  return out;
}
