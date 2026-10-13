/**
 * Sea-Doo hull, deck, hood, seat and jet pump geometry. The hull skin is lofted from the physics'
 * station table (the mesh the tests hold to the table); on top of it the deck moulding: the bow
 * dome under the hood, the footwells either side of the central tunnel (with their sloping front
 * wall and raised outer lips), the rear deck / boarding platform overhanging the pump; the hull's
 * orange swoosh and pinstripe, the sponsons and chine flats. The hood (its own break-up part) lies
 * on the dome; the narrow sculpted seat on the tunnel. At the stern: the ride plate, the pump
 * venturi in its dark tunnel recess, the steerable / trimmable nozzle and the iBR reverse bucket;
 * under the hull the intake grate. Returns plain geometries; index.ts makes the meshes.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { tint, merge } from '../../aircraft/materials';
import { V, ellipsoid, tube } from '../../aircraft/f16/geom';
import { buildHullPatch, buildHullShell, buildSprayRail, sectionBottomY, sectionOutlinePoint } from '../hullLoft';
import { boxMinMax, fanCap, gridGeometry, railTube, type Hint, type P3 } from '../geom';
import { SEADOO_COLORS as C } from './materials';
import {
  JET,
  POD_BASE_Y,
  SEADOO_SHAPE as S,
  SEAT_BASE_Y,
  STATIONS,
  domeY,
  floorY,
  footFloorY,
  lipInnerX,
  lipTopY,
  mix,
  seatHalf,
  seatTop,
  sec,
  smoothstep,
} from './shape';

export const range = (a: number, b: number, n: number) => Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);
/** Evenly spaced samples from a to b, no gap larger than `step`. */
export const steps = (a: number, b: number, step: number) => range(a, b, Math.max(1, Math.ceil(Math.abs(b - a) / step - 1e-9)));

/** A grid surface from row / column parameters. */
export function surf(rows: readonly number[], cols: readonly number[], f: (r: number, c: number, i: number, j: number) => P3, hint: Hint): THREE.BufferGeometry {
  return gridGeometry(
    rows.map((r, i) => cols.map((c, j) => f(r, c, i, j))),
    hint,
  );
}

/** Tinted surface (parts / paint vertex colours). */
export function paintSurf(rows: readonly number[], cols: readonly number[], f: (r: number, c: number, i: number, j: number) => P3, hint: Hint, hex: number, rough = 0.35, metal = 0): THREE.BufferGeometry {
  return tint(surf(rows, cols, f, hint), hex, rough, metal);
}

/** Recolour a tinted geometry per vertex. */
export function recolor(g: THREE.BufferGeometry, fn: (x: number, y: number, z: number, nx: number, ny: number, nz: number) => number): THREE.BufferGeometry {
  const p = g.getAttribute('position');
  const n = g.getAttribute('normal');
  const col = g.getAttribute('color') as THREE.BufferAttribute;
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    c.setHex(fn(p.getX(i), p.getY(i), p.getZ(i), n.getX(i), n.getY(i), n.getZ(i)));
    col.setXYZ(i, c.r, c.g, c.b);
  }
  col.needsUpdate = true;
  return g;
}

/** Superellipse cross-section loft along z: an arch from (+w, base) over (0, top) to (−w, base), capped at both ends. */
export function archLoft(zs: readonly number[], half: (z: number) => number, top: (z: number) => number, base: number, n = 3, segs = 20, caps = true): THREE.BufferGeometry {
  const e = 2 / n;
  const ring = (z: number): P3[] => {
    const w = Math.max(0.004, half(z));
    const t = top(z);
    const pts: P3[] = [];
    for (let j = 0; j <= segs; j++) {
      const th = (Math.PI * j) / segs;
      const c = Math.cos(th);
      const s = Math.sin(th);
      pts.push([w * Math.sign(c) * Math.pow(Math.abs(c), e), base + (t - base) * Math.pow(Math.abs(s), e), z]);
    }
    return pts;
  };
  const grid = zs.map(ring);
  const parts = [gridGeometry(grid, (x, y) => [x, y - base, 0])];
  if (caps) {
    parts.push(fanCap(grid[0], [0, 0, -1]), fanCap(grid[grid.length - 1], [0, 0, 1]));
  }
  const out = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  return out;
}

/** Deck edge (sheer) at z. */
const edge = (z: number) => {
  const s = sec(z);
  return { half: s.deckHalf, y: s.deckY };
};

/** Rear deck overhang half-width (rounded rear corners) and top height. */
const W_T = edge(S.zTransom).half - 0.02;
const CORNER = Math.min(0.14, S.zAft - S.zTransom);
export function rearHalf(z: number): number {
  if (z <= S.zTransom) return edge(z).half - 0.02;
  const zc = S.zAft - CORNER;
  if (z <= zc) return W_T;
  const d = Math.min(CORNER, z - zc);
  return W_T - CORNER + Math.sqrt(Math.max(0, CORNER * CORNER - d * d));
}
export const rearTopY = (x: number, z: number) => {
  const w = Math.max(0.05, rearHalf(z));
  const u = Math.min(1, Math.abs(x) / w);
  return S.rearDeckY + 0.008 * (1 - u * u);
};

export interface HullGeometry {
  shell: THREE.BufferGeometry;
  deck: THREE.BufferGeometry;
  parts: THREE.BufferGeometry;
}

/** The lofted skin: charcoal bottom, white topsides and transom. */
export function buildShell(): THREE.BufferGeometry {
  const shell = tint(buildHullShell(STATIONS, { maxStep: 0.08, bottomSegments: 8, sideSegments: 6, capBow: true, capStern: true }), C.white, 0.3);
  const chineT = sec(S.zTransom).chineY;
  return recolor(shell, (_x, y, z, _nx, ny, nz) => {
    if (z > S.zTransom - 1e-4 && nz > 0.9) return y < chineT ? C.bottom : C.white;
    return ny < -0.7 ? C.bottom : C.white;
  });
}

/** The deck moulding (charcoal), sponsons, chine flats and the hull stripes — one paint mesh. */
export function buildDeck(): THREE.BufferGeometry {
  const geos: THREE.BufferGeometry[] = [];
  const ZF = S.zFootFront;
  const ZR = S.zFootRear;
  const XT = S.tunnelHalf;

  // Bow dome, full width, from the stem to the footwells' front wall.
  const us = range(-1, 1, 28).map((t) => Math.sin((Math.PI / 2) * t));
  geos.push(paintSurf(steps(S.zStem, ZF, 0.04), us, (z, u) => {
    const x = u * edge(z).half;
    return [x, domeY(x, z), z];
  }, [0, 1, 0], C.deck));

  const zsFoot = [...range(ZF, ZF + S.frontWall, 6), ...steps(ZF + S.frontWall, ZR, 0.06).slice(1)];
  for (const side of [1, -1] as const) {
    // Outer lip: inner wall up from the floor, rounded top, outer face down to the sheer.
    geos.push(paintSurf(zsFoot, range(0, 6, 6), (z, k) => {
      const b = smoothstep(ZF, ZF + 0.3, z);
      const XL = lipInnerX(z);
      const e = edge(z);
      const top = lipTopY(z);
      const pts: [number, number][] = [
        [XL, footFloorY(XL, z)],
        [XL, top - 0.03],
        [XL + 0.01, top - 0.008],
        [XL + 0.028, top],
        [XL + 0.05, top - 0.006],
        [e.half - 0.018, e.y + 0.035],
        [e.half, e.y],
      ];
      const [x, yl] = pts[k];
      const y = k === 0 ? yl : k === 6 ? e.y : Math.max(pts[0][1], mix(domeY(x, ZF), yl, b));
      return [side * x, y, z];
    }, (x) => [side * (Math.abs(x) > 0 ? 1 : 1), 1, 0], C.deck));
    // Floor and the sloping front wall.
    geos.push(paintSurf(zsFoot, range(0, 1, 6), (z, t) => {
      const x = mix(XT, lipInnerX(z), t);
      return [side * x, footFloorY(x, z), z];
    }, [0, 1, 0], C.deck));
    // Tunnel side wall (the footwell's inner wall), floor → tunnel top.
    geos.push(paintSurf(zsFoot, [0, 1], (z, t) => {
      const lo = footFloorY(XT, z);
      const hi = Math.max(lo, S.tunnelTopY);
      return [side * XT, mix(lo, hi, t), z];
    }, [side, 0, 0], C.deck));
  }
  // Tunnel top (under the seat and pod) and its rear face down to the rear deck.
  geos.push(paintSurf([ZF, ZR], [-XT, XT], (z, x) => [x, S.tunnelTopY, z], [0, 1, 0], C.deck));
  geos.push(paintSurf([0, 1], [-XT, XT], (t, x) => [x, mix(S.tunnelTopY, rearTopY(x, ZR), t), ZR], [0, 0, 1], C.deck));

  // Rear deck / boarding platform: top, side roll to the sheer, overhang skirt and underside.
  const zsRear = [...steps(ZR, S.zTransom, 0.06), ...steps(S.zTransom, S.zAft, 0.02).slice(1)];
  geos.push(paintSurf(zsRear, range(-1, 1, 16), (z, u) => {
    const x = u * rearHalf(z);
    return [x, rearTopY(x, z), z];
  }, [0, 1, 0], C.deck));
  for (const side of [1, -1] as const) {
    geos.push(paintSurf(steps(ZR, S.zTransom, 0.06), [0, 1, 2], (z, k) => {
      const e = edge(z);
      const w = rearHalf(z);
      const pts: [number, number][] = [
        [w, rearTopY(w, z)],
        [e.half - 0.004, e.y + 0.022],
        [e.half, e.y],
      ];
      return [side * pts[k][0], pts[k][1], z];
    }, [side, 0.3, 0], C.deck));
  }
  // Overhang perimeter (starboard transom corner → round the back → port corner).
  const perim: [number, number][] = [];
  for (const z of steps(S.zTransom, S.zAft, 0.012)) perim.push([rearHalf(z), z]);
  const back = range(W_T - CORNER, -(W_T - CORNER), 10).slice(1, -1).map((x) => [x, S.zAft] as [number, number]);
  const perimAll: [number, number][] = [...perim, ...back, ...[...perim].reverse().map(([x, z]) => [-x, z] as [number, number])];
  geos.push(paintSurf(range(0, perimAll.length - 1, perimAll.length - 1), [0, 1, 2], (i, k) => {
    const [x, z] = perimAll[i];
    const top = rearTopY(x, z);
    const ys = [top, top - 0.02, S.rearUnderY];
    const out = k === 1 ? 0.004 : 0;
    const r = Math.hypot(x, z - S.zTransom) || 1;
    return [x + (out * x) / r, ys[k], z + (out * (z - S.zTransom)) / r];
  }, (x, _y, z) => [x, 0, z - S.zTransom], C.deck));
  const under: P3[] = perimAll.map(([x, z]) => [x, S.rearUnderY, z]);
  geos.push(tint(fanCap(under, [0, -1, 0]), C.deck, 0.4));

  // Chine flats and sponsons (the T3-R's aft side fins), in the bottom colour.
  geos.push(tint(buildSprayRail(STATIONS, { z0: S.zStem + 0.35, z1: S.zTransom, t: 1, width: 0.025, maxHeight: 0.03, taper: 0.4, maxStep: 0.08 }), C.bottom, 0.35));
  for (const side of [1, -1] as const) {
    const z0 = S.zTransom - 0.72;
    const z1 = S.zTransom - 0.03;
    geos.push(paintSurf(steps(z0, z1, 0.04), [0, 1, 2], (z, k) => {
      const s = sec(z);
      const taper = Math.min(1, (z - z0) / 0.25, (z1 - z) / 0.06);
      const lo = sectionOutlinePoint(s, 1.03);
      const hi = sectionOutlinePoint(s, 1.03 + 0.28 * Math.max(0.15, taper));
      const tip: [number, number] = [lo.x + 0.05 * taper, lo.y - 0.004];
      const p: [number, number][] = [[hi.x, hi.y], tip, [lo.x, lo.y]];
      return [side * p[k][0], p[k][1], z];
    }, [side, -0.2, 0], C.bottom));
  }

  // Hull stripes: an orange swoosh rising toward the bow, a charcoal pinstripe under it.
  const zs0 = S.zStem + 0.35;
  const zs1 = S.zTransom - 0.2;
  const topsY = (z: number, f: number) => {
    const s = sec(z);
    return s.chineY + f * (s.deckY - s.chineY);
  };
  const bow = (z: number) => (zs1 - z) / (zs1 - zs0);
  const width = (z: number) => 0.3 * Math.min(1, (z - zs0) / 0.55) * Math.min(1, (zs1 - z) / 0.3);
  const fLo = (z: number) => 0.28 + 0.3 * bow(z);
  for (const side of [1, -1] as const) {
    geos.push(tint(buildHullPatch(STATIONS, { z0: zs0, z1: zs1, side, offset: 0.004, nz: 40, ny: 2, yLo: (z) => topsY(z, fLo(z)), yHi: (z) => topsY(z, fLo(z) + width(z)) }), C.orange, 0.3));
    geos.push(tint(buildHullPatch(STATIONS, { z0: zs0 + 0.3, z1: zs1 + 0.1, side, offset: 0.004, nz: 40, ny: 1, yLo: (z) => topsY(z, fLo(z) - 0.1), yHi: (z) => topsY(z, fLo(z) - 0.1 + 0.035 * Math.min(1, (z - zs0 - 0.3) / 0.4)) }), C.black, 0.3));
  }
  return merge(geos);
}

/** The hood (bow cowl): orange shell on the dome with a white race stripe and black vents. */
export function buildHood(): THREE.BufferGeometry {
  const z0 = S.zStem + 0.1;
  const z1 = S.zPodFront + 0.05;
  const uh = (z: number) => 0.76 * Math.sqrt(smoothstep(z0, z0 + 0.5, z)) * (1 - 0.1 * smoothstep(z1 - 0.3, z1, z));
  const lift = 0.016;
  const at = (s: number, z: number, dy = 0): P3 => {
    const x = s * uh(z) * edge(z).half;
    return [x, domeY(x, z) + lift + dy, z];
  };
  const geos: THREE.BufferGeometry[] = [];
  const zs = steps(z0, z1, 0.025);
  geos.push(paintSurf(zs, range(-1, 1, 24), (z, s) => at(s, z), [0, 1, 0], C.orange, 0.28));
  // Skirt: round the edge down onto the dome.
  const outline: [number, number][] = [...zs.map((z) => [1, z] as [number, number]), ...range(1, -1, 12).slice(1, -1).map((s) => [s, z1] as [number, number]), ...[...zs].reverse().map((z) => [-1, z] as [number, number])];
  const zc = (z0 + z1) / 2;
  geos.push(paintSurf(range(0, outline.length - 1, outline.length - 1), [0, 1], (i, k) => {
    const [s, z] = outline[i];
    const p = at(s, z);
    if (k === 0) return p;
    const x = p[0] * 1.012;
    return [x, domeY(x, z) + 0.001, z];
  }, (x, _y, z) => [x, 0, z - zc], C.orange, 0.28));
  // Race stripe and pinstripes.
  const zsS = steps(z0 + 0.14, z1, 0.03);
  geos.push(paintSurf(zsS, range(-0.13, 0.13, 4), (z, s) => at(s, z, 0.003), [0, 1, 0], C.white, 0.28));
  for (const side of [1, -1]) {
    geos.push(paintSurf(zsS, [0.16 * side, 0.19 * side], (z, s) => at(s, z, 0.003), [0, 1, 0], C.black, 0.3));
    // Vents: black inserts with three slats.
    const zv0 = z1 - 0.42;
    const zv1 = z1 - 0.12;
    geos.push(paintSurf(steps(zv0, zv1, 0.03), [0.36 * side, 0.64 * side], (z, s) => at(s, z, 0.003), [0, 1, 0], C.black, 0.6));
    for (let k = 0; k < 4; k++) {
      const za = zv0 + 0.02 + k * 0.075;
      geos.push(paintSurf([za, za + 0.018], [0.37 * side, 0.63 * side], (z, s) => at(s, z, 0.006), [0, 1, 0], C.deck, 0.4));
    }
  }
  return merge(geos);
}

/** The narrow sculpted seat (black vinyl, charcoal lower band, orange piping) and the rear grab handle. */
export function buildSeat(): THREE.BufferGeometry {
  const zs = steps(S.zSeatFront, S.zSeatRear, 0.025);
  const base = SEAT_BASE_Y;
  const cushion = tint(archLoft(zs, seatHalf, seatTop, base, 3.2, 22), C.black, 0.55);
  recolor(cushion, (_x, y, z) => (y < base + 0.4 * (seatTop(z) - base) ? 0x2c2f33 : C.black));
  const geos = [cushion];
  const e = 2 / 3.2;
  for (const side of [1, -1]) {
    const pts = steps(S.zSeatFront + 0.05, S.zSeatRear - 0.04, 0.05).map((z) => {
      const th = Math.PI * 0.2;
      const x = seatHalf(z) * Math.pow(Math.cos(th), e) + 0.003;
      const y = base + (seatTop(z) - base) * Math.pow(Math.sin(th), e);
      return V(side * x, y, z);
    });
    geos.push(tint(railTube(pts, 0.007, 6, 2), C.orange, 0.4));
  }
  // Grab handle behind the seat.
  const zr = S.zSeatRear;
  const hy = S.rearDeckY;
  geos.push(tint(railTube([V(-0.13, hy - 0.01, zr - 0.02), V(-0.14, hy + 0.08, zr + 0.06), V(0, hy + 0.11, zr + 0.1), V(0.14, hy + 0.08, zr + 0.06), V(0.13, hy - 0.01, zr - 0.02)], 0.016, 8, 5), C.rubber, 0.6));
  return merge(geos);
}

/** Dark overlay on the V bottom following its shape (x span, z span). */
function bottomPatch(x0: number, x1: number, z0: number, z1: number, dy: number, hex: number, rough = 0.6, metal = 0): THREE.BufferGeometry {
  return paintSurf(steps(z0, z1, 0.03), range(x0, x1, 6), (z, x) => [x, sectionBottomY(sec(z), x) - dy, z], [0, -1, 0], hex, rough, metal);
}

/** Hull hardware: bumper rails, mats, pump venturi and tunnel recess, ride plate, intake grate, exhaust. */
export function buildHullParts(): THREE.BufferGeometry {
  const geos: THREE.BufferGeometry[] = [];
  const E = JET.position;

  // Rub rail along the sheer, round the stem; and round the rear deck overhang.
  const railZs = steps(S.zStem + 0.03, S.zTransom, 0.08);
  const railPt = (side: number, z: number) => {
    const e = edge(z);
    return V(side * (e.half - 0.012), e.y + 0.012, z);
  };
  const rail = [...[...railZs].reverse().map((z) => railPt(-1, z)), V(0, edge(S.zStem).y + 0.012, S.zStem + 0.004), ...railZs.map((z) => railPt(1, z))];
  geos.push(tint(railTube(rail, 0.016, 8, 3), C.rubber, 0.7));
  const perim = steps(S.zTransom, S.zAft, 0.015).map((z) => [rearHalf(z), z] as [number, number]);
  const rearRail = [...perim.map(([x, z]) => V(x, S.rearUnderY + 0.03, Math.min(z, S.zAft - 0.012))), ...[...perim].reverse().map(([x, z]) => V(-x, S.rearUnderY + 0.03, Math.min(z, S.zAft - 0.012)))];
  geos.push(tint(railTube(rearRail, 0.014, 8, 2), C.rubber, 0.7));
  geos.push(tint(ellipsoid(V(0, edge(S.zStem).y - 0.01, S.zStem + 0.02), 0.045, 0.06, 0.035, 12, 8), C.rubber, 0.7));

  // Footwell mats (longitudinal ribs) and the rear deck mat.
  const zm0 = S.zFootFront + S.frontWall + 0.03;
  const zm1 = S.zFootRear - 0.06;
  for (const side of [1, -1]) {
    for (let k = 0; k < 6; k++) {
      const a = (k + 0.1) / 6;
      const b = (k + 0.82) / 6;
      geos.push(paintSurf(steps(zm0, zm1, 0.1), [a, b], (z, t) => {
        const x = mix(S.tunnelHalf + 0.02, lipInnerX(z) - 0.02, t);
        return [side * x, floorY(z) + 0.005, z];
      }, [0, 1, 0], C.mat, 0.95));
    }
  }
  const zr0 = S.zFootRear + 0.06;
  const zr1 = S.zAft - 0.07;
  for (let k = 0; k < 10; k++) {
    const x0 = -0.42 + (0.84 * (k + 0.1)) / 10;
    const x1 = -0.42 + (0.84 * (k + 0.85)) / 10;
    geos.push(paintSurf(steps(zr0, zr1, 0.1), [x0, x1], (z, x) => {
      const w = Math.min(1, (rearHalf(z) - 0.06) / Math.max(Math.abs(x), 1e-3));
      const xx = Math.abs(x) > rearHalf(z) - 0.06 ? x * w : x;
      return [xx, rearTopY(xx, z) + 0.005, z];
    }, [0, 1, 0], C.mat, 0.95));
  }

  // Pump tunnel recess in the transom (dark), the venturi coming out of it.
  const T = S.zTransom + 0.002;
  const keelT = sec(S.zTransom).keelY;
  const rec: P3[] = [];
  const rx = 0.135;
  const yTop = E.y + 0.12;
  for (let k = 0; k <= 10; k++) {
    const a = (Math.PI * k) / 10;
    rec.push([rx * Math.cos(a), yTop - 0.05 + 0.05 * Math.sin(a), T]);
  }
  rec.push([-rx, keelT + 0.01, T], [rx, keelT + 0.01, T]);
  geos.push(tint(fanCap(rec, [0, 0, 1]), 0x0b0c0d, 0.8));
  const pivotZ = E.z - S.nozzleLength;
  const venturi = new THREE.LatheGeometry(
    [
      [0.001, S.zTransom - 0.1],
      [0.08, S.zTransom - 0.1],
      [0.078, pivotZ - 0.03],
      [0.074, pivotZ + 0.004],
      [0.06, pivotZ + 0.004],
    ].map(([r, z]) => new THREE.Vector2(r, z)),
    20,
  ).rotateX(Math.PI / 2);
  venturi.translate(E.x, E.y, 0);
  geos.push(tint(venturi, C.darkMetal, 0.45, 0.6));
  // iBR pivot bosses either side of the venturi (the bucket hinges on them).
  const hz = E.z - S.bucketHingeAhead;
  for (const side of [1, -1]) geos.push(tint(tube(V(side * 0.07, E.y, hz), V(side * 0.118, E.y, hz), 0.022, 0.022, 12), C.darkMetal, 0.45, 0.6));

  // Ride plate under the pump tunnel (a flat plate below the V, its sides up into the hull).
  const rpZ0 = JET.jet!.inlet.z + 0.26;
  geos.push(tint(boxMinMax(-0.14, keelT - 0.012, rpZ0, 0.14, keelT + 0.08, S.zTransom + 0.025), C.metal, 0.35, 0.75));
  // Intake grate (at jet.inlet): the dark opening on the V bottom, a frame and bars following the V.
  const I = JET.jet!.inlet;
  geos.push(bottomPatch(I.x - 0.11, I.x + 0.11, I.z - 0.17, I.z + 0.17, 0.002, 0x0a0b0c, 0.9));
  for (let k = 0; k < 7; k++) {
    const x = I.x - 0.09 + (0.18 * k) / 6;
    geos.push(
      tint(
        railTube(steps(I.z - 0.16, I.z + 0.16, 0.08).map((z) => V(x, sectionBottomY(sec(z), x) - 0.008, z)), 0.006, 5, 1),
        C.metal,
        0.35,
        0.8,
      ),
    );
  }
  for (const zz of [I.z - 0.165, I.z + 0.165]) {
    geos.push(tint(railTube(range(-0.11, 0.11, 6).map((x) => V(I.x + x, sectionBottomY(sec(zz), I.x + x) - 0.006, zz)), 0.008, 5, 1), C.metal, 0.35, 0.8));
  }
  // Exhaust outlet on the transom, starboard.
  const ex = new THREE.CircleGeometry(0.03, 14);
  ex.translate(0.3, -0.05, T + 0.001);
  geos.push(tint(ex, 0x0a0a0a, 0.8));
  geos.push(tint(new THREE.TorusGeometry(0.032, 0.006, 6, 16).translate(0.3, -0.05, T + 0.002), C.darkMetal, 0.4, 0.6));
  return merge(geos);
}

// ── Jet: nozzle (steers about a vertical pivot just ahead of its exit, trims about a transverse one) and bucket ──

/** Nozzle in its pivot frame (pivot at the origin, exit plane at z = nozzleLength, exit radius = diameter / 2). */
export function buildNozzle(): THREE.BufferGeometry {
  const L = S.nozzleLength;
  const r = JET.diameter / 2;
  const prof: [number, number][] = [
    [0.061, -0.03],
    [0.068, -0.02],
    [0.07, 0.0],
    [0.066, L * 0.45],
    [r + 0.009, L * 0.92],
    [r + 0.005, L],
    [r, L],
    [r + 0.003, L * 0.6],
    [0.056, -0.03],
  ];
  const lathe = new THREE.LatheGeometry(prof.map(([rr, z]) => new THREE.Vector2(rr, z)), 22).rotateX(Math.PI / 2);
  const geos = [tint(lathe, C.metal, 0.3, 0.85)];
  // Steering arm lug (port) and the VTS trim ring.
  geos.push(tint(boxMinMax(-0.09, -0.012, -0.005, -0.06, 0.012, 0.03), C.darkMetal, 0.4, 0.6));
  geos.push(tint(new THREE.TorusGeometry(0.071, 0.006, 6, 22).translate(0, 0, 0.004), C.darkMetal, 0.4, 0.6));
  return merge(geos);
}

/**
 * The iBR reverse bucket in its hinge frame, drawn DOWN (bucket = 1): side arms from the hinge pins
 * and a cupped scoop behind the nozzle exit that turns the jet forward and down. The hinge
 * rotates it up (rotation.x = −up angle) clear above the nozzle for full ahead.
 */
export function buildBucket(): THREE.BufferGeometry {
  const hx = 0.12;
  // Scoop section (y, z) in the hinge frame, top → bottom curl.
  const ahead = S.bucketHingeAhead;
  const arc: [number, number][] = [
    [0.075, ahead + 0.035],
    [0.03, ahead + 0.055],
    [-0.02, ahead + 0.062],
    [-0.07, ahead + 0.053],
    [-0.105, ahead + 0.022],
    [-0.12, ahead - 0.005],
  ];
  const geos: THREE.BufferGeometry[] = [];
  geos.push(paintSurf(range(0, arc.length - 1, arc.length - 1), range(-hx, hx, 8), (i, x) => {
    const [y, z] = arc[i];
    // Cupped across (the sides a little further aft).
    const cup = 0.012 * (x / hx) ** 2;
    return [x, y, z + cup];
  }, (_x, y, z) => [0, y * 0.3, z], 0x26292d, 0.5, 0.2));
  // Side plates: pin → round the scoop's side edge.
  for (const side of [1, -1]) {
    const outline: P3[] = [[side * hx, 0.03, -0.01], [side * hx, -0.03, -0.01], ...[...arc].reverse().map(([y, z]) => [side * hx, y, z + 0.012] as P3)];
    geos.push(tint(fanCap(outline, [side, 0, 0]), 0x26292d, 0.5, 0.2));
  }
  return merge(geos);
}

/** Everything under the hull group except the moving jet parts. */
export function buildHull(): HullGeometry {
  return { shell: buildShell(), deck: buildDeck(), parts: buildHullParts() };
}

export { POD_BASE_Y };
