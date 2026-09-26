/**
 * Princess V50 hull and deck geometry: the skin lofted from the physics' station table (the mesh
 * the tests hold to the table), spray rails, chine flats and the IPS pod fairings; the dark hull
 * windows; the foredeck, coachroof, house sides, cockpit linings and gunwale caps in white GRP; the
 * teak side decks and soles; the stainless rub rail, bow pulpit and guard rails, anchor and
 * roller; the transom garage shut lines; and the teak swim platform (its own break-up part).
 * Returns plain geometries per material; index.ts makes the meshes.
 */
import * as THREE from 'three';
import { tint, merge } from '../../aircraft/materials';
import { V, box, ellipsoid, tube } from '../../aircraft/f16/geom';
import { buildHullDeck, buildHullPatch, buildHullShell, buildSprayRail, sectionBottomY, sectionHalfBreadth } from '../hullLoft';
import { gridGeometry, planarUV, railTube, boxMinMax, type P3 } from '../geom';
import { STATIONS, V50_SHAPE as S, W50, cockpitHalf, coachTopY, deckY, houseHalf, sec, sillY, wsBaseZ } from './shape';

export const V50_COLORS = {
  white: 0xf3f3f0,
  offWhite: 0xe4e2dc,
  black: 0x15171a,
  stainless: 0xd6dbe0,
  teak: 0xb88a5c,
  oak: 0xf2e2c8,
  shutLine: 0x3a3d42,
} as const;

/** Where the nav lights sit (body frame) and which way they shine. */
export const V50_LIGHTS = {
  port: V(-(sectionHalfBreadth(sec(-6.0), 0.93) + 0.012), 0.93, -6.0),
  starboard: V(sectionHalfBreadth(sec(-6.0), 0.93) + 0.012, 0.93, -6.0),
  stern: V(0, 0.84, S.zTransom + 0.02),
} as const;

const range = (a: number, b: number, n: number) => Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);

export interface HullGeometry {
  /** The lofted skin (exactly the station table) — hull material. */
  shell: THREE.BufferGeometry;
  /** Spray rails, chine flats, pod fairings — hull material. */
  details: THREE.BufferGeometry;
  windows: THREE.BufferGeometry;
  grp: THREE.BufferGeometry;
  teak: THREE.BufferGeometry;
  steel: THREE.BufferGeometry;
  /** Transom name board (a quad with UVs 0..1). */
  nameBoard: THREE.BufferGeometry;
}

export function buildHull(): HullGeometry {
  const shell = buildHullShell(STATIONS, { maxStep: 0.22, bottomSegments: 10, sideSegments: 8, capBow: true, capStern: true });

  // ── Spray rails, chine flats and pod fairings (hull material: they take the antifouling) ──
  const details: THREE.BufferGeometry[] = [
    buildSprayRail(STATIONS, { z0: -7.9, z1: 5.5, t: 1, width: 0.07, maxHeight: 0.05, taper: 1.2 }),
    buildSprayRail(STATIONS, { z0: -7.6, z1: 1.5, t: 0.36, width: 0.045, taper: 1.5 }),
    buildSprayRail(STATIONS, { z0: -7.2, z1: -0.5, t: 0.68, width: 0.045, taper: 1.5 }),
  ];
  for (const p of W50.propulsors) {
    const s = sec(p.position.z + 0.3);
    const y = sectionBottomY(s, p.position.x);
    const f = ellipsoid(V(p.position.x, y + 0.01, p.position.z + 0.3), S.podFairingRadius, 0.07, 0.5, 20, 8);
    // Tilt with the deadrise so it sits flush on the V bottom.
    const dead = Math.atan2(s.chineY - s.keelY, s.chineHalf);
    f.translate(-p.position.x, -(y + 0.01), 0);
    f.rotateZ(Math.sign(p.position.x) * dead);
    f.translate(p.position.x, y + 0.01, 0);
    details.push(f);
  }
  const detailsGeo = mergePlain(details);

  // ── Dark hull windows (a long lozenge on each side) ──
  const zw0 = -5.3;
  const zw1 = 0.9;
  const hiW = (z: number) => sec(z).deckY - 0.3;
  const hW = (z: number) => {
    const fwd = Math.sqrt(smooth(zw0, -2.3, z));
    const aft = z > 0.45 ? Math.sqrt(Math.max(0, 1 - ((z - 0.45) / (zw1 - 0.45)) ** 2)) : 1;
    return 0.3 * fwd * aft;
  };
  const windows = mergePlain(
    ([1, -1] as const).map((side) =>
      buildHullPatch(STATIONS, { z0: zw0, z1: zw1, side, yLo: (z) => hiW(z) - hW(z), yHi: hiW, offset: 0.007, nz: 48, ny: 3 }),
    ),
  );

  // ── White GRP mouldings ──
  const grp: THREE.BufferGeometry[] = [];
  const W = V50_COLORS.white;
  // Foredeck (full width) up to where the coachroof starts.
  grp.push(tint(buildHullDeck(STATIONS, { z0: S.zStem, z1: S.zCoachroof, camber: S.deckCamber, segments: 10, maxStep: 0.2 }), W, 0.3));
  // Coachroof top, from its forward end to the windscreen base.
  {
    const nu = 18;
    const nt = 26;
    const grid: P3[][] = [];
    for (let i = 0; i <= nt; i++) {
      const row: P3[] = [];
      for (let j = 0; j <= nu; j++) {
        const u = -1 + (2 * j) / nu;
        const z = S.zCoachroof + (wsBaseZ(u) - S.zCoachroof) * (i / nt);
        const x = u * houseHalf(z);
        row.push([x, coachTopY(x, z), z]);
      }
      grid.push(row);
    }
    grp.push(tint(gridGeometry(grid, [0, 1, 0]), W, 0.3));
  }
  // House sides: from the sole (hidden under the side decks forward) to the sill.
  const zHouse = range(S.zCoachroof, S.zAftBulkhead, 40);
  for (const side of [1, -1]) {
    const grid = zHouse.map((z) => {
      const x = side * houseHalf(z);
      return [[x, S.floorY, z], [x, sillY(z), z]] as P3[];
    });
    grp.push(tint(gridGeometry(grid, [side, 0, 0]), W, 0.3));
  }
  // Cockpit: inner bulwarks, the step down from the side decks, the transom's inner face, caps.
  const zCock = range(S.zAftBulkhead, S.zTransomInner, 20);
  for (const side of [1, -1]) {
    grp.push(tint(gridGeometry(zCock.map((z) => [[side * cockpitHalf(z), S.floorY, z], [side * cockpitHalf(z), sec(z).deckY, z]] as P3[]), [-side, 0, 0]), W, 0.35));
    const z = S.zAftBulkhead;
    grp.push(tint(gridGeometry([[[side * houseHalf(z), S.floorY, z], [side * houseHalf(z), sec(z).deckY, z]], [[side * cockpitHalf(z), S.floorY, z], [side * cockpitHalf(z), sec(z).deckY, z]]], [0, 0, 1]), W, 0.35));
  }
  {
    const z = S.zTransomInner;
    const h = cockpitHalf(z);
    grp.push(tint(gridGeometry([[[-h, S.floorY, z], [-h, sec(z).deckY, z]], [[h, S.floorY, z], [h, sec(z).deckY, z]]], [0, 0, -1]), W, 0.35));
    // Transom cap.
    const zs = [S.zTransomInner, S.zTransom];
    grp.push(tint(gridGeometry(zs.map((zz) => [[-sec(zz).deckHalf, sec(zz).deckY + 0.003, zz], [sec(zz).deckHalf, sec(zz).deckY + 0.003, zz]] as P3[]), [0, 1, 0]), W, 0.3));
  }
  // Gunwale caps along the cockpit.
  grp.push(tint(buildHullDeck(STATIONS, { z0: S.zAftBulkhead, z1: S.zTransom, camber: S.deckCamber, inner: cockpitHalf, segments: 1, lift: 0.003 }), W, 0.3));
  // Garage door shut lines on the transom, and the swim-platform brackets.
  const zt = S.zTransom + 0.004;
  for (const [x0, y0, x1, y1] of [
    [-1.15, -0.18, 1.15, -0.165],
    [-1.15, 0.3, 1.15, 0.315],
    [-1.16, -0.18, -1.145, 0.315],
    [1.145, -0.18, 1.16, 0.315],
  ]) {
    grp.push(tint(boxMinMax(x0, y0, zt - 0.003, x1, y1, zt + 0.002), V50_COLORS.shutLine, 0.5));
  }
  const grpGeo = merge(grp);

  // ── Teak: side decks beside the house, saloon and cockpit soles ──
  const teak: THREE.BufferGeometry[] = [];
  teak.push(tint(planarUV(buildHullDeck(STATIONS, { z0: S.zCoachroof, z1: S.zAftBulkhead, camber: S.deckCamber, inner: houseHalf, segments: 2, lift: 0.004 }), 'x', 'z'), V50_COLORS.teak, 0.8));
  const sole = (z0: number, z1: number, half: (z: number) => number, hex: number) => {
    const grid: P3[][] = range(z0, z1, 24).map((z) => range(-1, 1, 8).map((u) => [u * half(z), S.floorY, z] as P3));
    teak.push(tint(planarUV(gridGeometry(grid, [0, 1, 0]), 'x', 'z'), hex, 0.7));
  };
  sole(-3.4, S.zAftBulkhead, houseHalf, V50_COLORS.oak);
  sole(S.zAftBulkhead, S.zTransomInner, cockpitHalf, V50_COLORS.teak);
  const teakGeo = merge(teak);

  // ── Stainless: rub rail, bow pulpit and guard rails, anchor and roller ──
  const steel: THREE.BufferGeometry[] = [];
  const ST = V50_COLORS.stainless;
  {
    const pts: THREE.Vector3[] = [];
    const zs = range(S.zTransom, S.zStem + 0.12, 40);
    const at = (side: number, z: number) => {
      const s = sec(z);
      const y = s.deckY - 0.03;
      return V(side * (sectionHalfBreadth(s, y) + 0.004), y, z);
    };
    for (const z of zs) pts.push(at(1, z));
    pts.push(V(0, sec(S.zStem).deckY - 0.03, S.zStem - 0.02));
    for (const z of [...zs].reverse()) pts.push(at(-1, z));
    steel.push(tint(railTube(pts, 0.018, 6, 3), ST, 0.18, 0.9));
    // Across the transom top edge.
    const zT = S.zTransom + 0.012;
    const hT = sec(S.zTransom).deckHalf;
    steel.push(tint(tube(V(-hT, sec(S.zTransom).deckY - 0.03, zT), V(hT, sec(S.zTransom).deckY - 0.03, zT), 0.014, 0.014, 6), ST, 0.18, 0.9));
  }
  {
    const top = (side: number, z: number) => {
      const s = sec(z);
      return V(side * (s.deckHalf - S.railInset), s.deckY + S.railHeight, z);
    };
    const zr = [-3.0, -3.8, -4.9, -6.0, -7.1, -7.9];
    const pts: THREE.Vector3[] = [];
    for (const z of zr) pts.push(top(1, z));
    const yb = sec(S.zStem).deckY + S.railHeight;
    pts.push(V(0.36, yb, -8.55), V(0.14, yb, -8.95), V(0, yb, -9.02), V(-0.14, yb, -8.95), V(-0.36, yb, -8.55));
    for (const z of [...zr].reverse()) pts.push(top(-1, z));
    steel.push(tint(railTube(pts, 0.014, 6, 6), ST, 0.18, 0.9));
    for (const side of [1, -1]) {
      for (const z of zr) {
        const t = top(side, z);
        steel.push(tint(tube(V(t.x, sec(z).deckY, z), t, 0.012, 0.012, 6), ST, 0.18, 0.9));
      }
      // Pulpit legs.
      const zl = -8.35;
      const xl = side * (sec(zl).deckHalf - 0.05);
      steel.push(tint(tube(V(xl, deckY(xl, zl), zl), V(side * 0.3, yb, -8.62), 0.012, 0.012, 6), ST, 0.18, 0.9));
    }
  }
  {
    // Anchor roller and a stowed Delta-style anchor (its fluke is the boat's forward-most point).
    const yr = sec(S.zStem).deckY;
    steel.push(tint(box(0.14, 0.07, 0.72, V(0, yr + 0.02, -8.72)), ST, 0.2, 0.9));
    steel.push(tint(tube(V(0, yr + 0.02, -8.4), V(0, yr - 0.08, S.zAnchorTip + 0.14), 0.022, 0.018, 8), ST, 0.2, 0.9));
    const fluke = ellipsoid(V(0, yr - 0.12, S.zAnchorTip + 0.1), 0.15, 0.045, 0.1, 16, 8);
    steel.push(tint(fluke, ST, 0.2, 0.9));
    // Cleats on the side decks and cockpit gunwales.
    for (const side of [1, -1]) {
      for (const z of [-5.6, 1.6, 5.1]) {
        const s = sec(z);
        const x = side * (s.deckHalf - 0.07);
        steel.push(tint(box(0.05, 0.05, 0.24, V(x, s.deckY + 0.03, z)), ST, 0.2, 0.9));
      }
    }
  }
  const steelGeo = merge(steel);

  // ── Transom name board (quad on the transom face, above the garage door) ──
  const nameBoard = new THREE.PlaneGeometry(1.9, 0.475);
  nameBoard.translate(0, 0.6, S.zTransom + 0.006);

  return { shell, details: detailsGeo, windows, grp: grpGeo, teak: teakGeo, steel: steelGeo, nameBoard };
}

/** The swim platform: GRP body and teak top (z = transom … zPlatformAft). */
export function buildPlatform(): { grp: THREE.BufferGeometry; teak: THREE.BufferGeometry } {
  const z0 = S.zTransom - 0.02;
  const z1 = S.zPlatformAft;
  const half = sec(S.zTransom).deckHalf - 0.1;
  const r = 0.28;
  const outline = (inset: number) => {
    const sh = new THREE.Shape();
    const h = half - inset;
    const a = z0;
    const b = z1 - inset;
    sh.moveTo(-h, a);
    sh.lineTo(h, a);
    sh.lineTo(h, b - r);
    sh.quadraticCurveTo(h, b, h - r, b);
    sh.lineTo(-h + r, b);
    sh.quadraticCurveTo(-h, b, -h, b - r);
    sh.closePath();
    return sh;
  };
  // Extrude down: shape (x, z) in the XY plane → rotateX(+90°) puts shape y on body z, depth on −y.
  const body = new THREE.ExtrudeGeometry(outline(0), { depth: S.platformThickness, bevelEnabled: false, curveSegments: 6 });
  body.rotateX(Math.PI / 2);
  body.translate(0, S.platformY, 0);
  const grp = merge([tint(body, V50_COLORS.white, 0.3)]);
  // Teak top: the same outline inset, facing up (shape (x, −z) → rotateX(−90°)).
  const sh = outline(0.03);
  const flipped = new THREE.Shape(sh.getPoints(6).map((p) => new THREE.Vector2(p.x, -p.y)));
  const top = new THREE.ShapeGeometry(flipped, 6);
  top.rotateX(-Math.PI / 2);
  top.translate(0, S.platformY + 0.004, 0);
  const teak = merge([tint(planarUV(top, 'x', 'z'), V50_COLORS.teak, 0.8)]);
  return { grp, teak };
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Merge geometries that carry only position / normal / uv. */
function mergePlain(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  return merge(list.map((g) => tint(g, 0xffffff, 0.3)));
}
