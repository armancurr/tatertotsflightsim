/**
 * Boeing 747-400 flight deck — the layout (pure data + small maths, no three.js).
 *
 * Everything is in the DECK FRAME: the body axes (+X right, +Y up, +Z aft), origin on the fuselage
 * centreline at the captain's eye height and eye station (B747_AIRCRAFT.geometry.pilotEye), so the
 * captain's eye is (−0.55, 0, 0) and the first officer's (+0.55, 0, 0). `DECK_ORIGIN` places it in
 * the body frame.
 *
 * The room is a convex polyhedron — floor, ceiling, the sloping header over the windscreen, the
 * windscreen plane, the two "cheek" planes of the No. 2 (sliding) windows, the side walls with the
 * No. 3 windows and the aft bulkhead — and each window is a convex polygon in its plane's 2D
 * coordinates. The same planes build the lining (flightDeckGeom.ts) and decide where sunlight comes
 * in (flightDeckLight.ts), so light and geometry always agree.
 *
 * Real-aircraft references (Boeing 747-400 flight deck): six 8 × 8 in displays (PFD, ND | upper
 * EICAS | ND, PFD, lower EICAS under the upper), ~20° over-the-nose vision, pilots' eyes ±0.55 m
 * off the centreline, the glareshield with the MCP, the pedestal between the seats with four thrust
 * levers, the speed brake lever on the left and the flap lever on the right, three CDUs.
 */
import { B747_AIRCRAFT } from '../../config';

export interface V3 {
  x: number;
  y: number;
  z: number;
}
export type Pt2 = readonly [number, number];

const G = B747_AIRCRAFT.geometry;

/** Deck frame origin in the body frame (centreline, captain's eye height and station). */
export const DECK_ORIGIN: V3 = { x: 0, y: G.pilotEye.y, z: G.pilotEye.z };
/** Pilots' design eye points (deck frame). */
export const EYE_CAPTAIN: V3 = { x: G.pilotEye.x, y: 0, z: 0 };
export const EYE_FO: V3 = { x: -G.pilotEye.x, y: 0, z: 0 };

export const deckToBody = (p: V3): V3 => ({ x: p.x + DECK_ORIGIN.x, y: p.y + DECK_ORIGIN.y, z: p.z + DECK_ORIGIN.z });

// ─── The room ────────────────────────────────────────────────────────────────

export const FLOOR_Y = -1.24;
export const CEILING_Y = 0.64;
export const AFT_Z = 1.55;
/** Windscreen: bottom edge (glareshield front) and top edge (header). The plane is z = z0 + k (y − y0). */
export const WINDSCREEN = { y0: -0.4, z0: -1.0, y1: 0.29, z1: -0.63, postHalf: 0.045 } as const;
export const WINDSCREEN_K = (WINDSCREEN.z1 - WINDSCREEN.z0) / (WINDSCREEN.y1 - WINDSCREEN.y0);
/** Outer edge (corner post) of each No. 1 window: |x| at the bottom and at the top. */
export const WINDSCREEN_OUTER = { bottom: 0.9, top: 0.84 } as const;
/** Side walls (vertical), and the ceiling band's height. */
export const SIDE_X = 1.1;
/** Header: from the windscreen top edge up to the ceiling at this station. */
export const HEADER_Z = -0.12;

/** Windscreen plane z at height y. */
export const windscreenZ = (y: number): number => WINDSCREEN.z0 + WINDSCREEN_K * (y - WINDSCREEN.y0);

/**
 * A plane of the room: outward unit normal n, offset d (points p inside have n·p < d), a 2D basis
 * (e1, e2) with origin o for its window polygons, and the windows (convex polygons, CCW, in (e1, e2)).
 */
export interface RoomPlane {
  name: string;
  n: V3;
  d: number;
  o: V3;
  e1: V3;
  e2: V3;
  windows: Pt2[][];
}

const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: V3, b: V3): V3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const norm = (a: V3): V3 => {
  const l = Math.hypot(a.x, a.y, a.z) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
};
const P = (x: number, y: number, z: number): V3 => ({ x, y, z });

/** Plane through three points with its normal facing away from `inside`; basis e1 along a→b. */
function planeThrough(name: string, a: V3, b: V3, c: V3, inside: V3, up: V3 = P(0, 1, 0)): RoomPlane {
  let n = norm(cross(sub(b, a), sub(c, a)));
  if (dot(n, sub(inside, a)) > 0) n = { x: -n.x, y: -n.y, z: -n.z };
  // e2 = "up" projected into the plane; e1 = e2 × n (so (e1, e2, n) is right-handed).
  let e2 = sub(up, { x: n.x * dot(up, n), y: n.y * dot(up, n), z: n.z * dot(up, n) });
  if (Math.hypot(e2.x, e2.y, e2.z) < 1e-6) e2 = norm(sub(b, a));
  e2 = norm(e2);
  const e1 = norm(cross(e2, n));
  return { name, n, d: dot(n, a), o: a, e1, e2, windows: [] };
}

/** 2D coordinates of a point in a plane's basis. */
export function planeUV(pl: RoomPlane, p: V3): [number, number] {
  const r = sub(p, pl.o);
  return [dot(r, pl.e1), dot(r, pl.e2)];
}
/** Point of a plane from its 2D coordinates. */
export function planePoint(pl: RoomPlane, u: number, v: number): V3 {
  return { x: pl.o.x + pl.e1.x * u + pl.e2.x * v, y: pl.o.y + pl.e1.y * u + pl.e2.y * v, z: pl.o.z + pl.e1.z * u + pl.e2.z * v };
}

const CENTRE_INSIDE = P(0, -0.2, 0.2);

/** Corner-post line (bottom → top) of the No. 1 window on side s (−1 left, +1 right). */
export function cornerPost(s: number): { bottom: V3; top: V3 } {
  return {
    bottom: P(s * WINDSCREEN_OUTER.bottom, WINDSCREEN.y0, WINDSCREEN.z0),
    top: P(s * WINDSCREEN_OUTER.top, WINDSCREEN.y1, WINDSCREEN.z1),
  };
}

/** Where the cheek plane (No. 2 window) meets the side wall: its front edge station at the sill and at the top. */
export const CHEEK_AFT = { zBottom: -0.36, zTop: -0.3 } as const;
/** No. 2 (sliding) window and No. 3 window outlines, as 3D corner points (left side; mirrored for the right). */
export const WINDOW_SILL_Y = -0.26;
export const SIDE_WINDOW_TOP_Y = 0.24;

function buildRoom(): RoomPlane[] {
  const planes: RoomPlane[] = [];
  const floor = planeThrough('floor', P(0, FLOOR_Y, 0), P(1, FLOOR_Y, 0), P(0, FLOOR_Y, 1), CENTRE_INSIDE, P(0, 0, -1));
  const ceiling = planeThrough('ceiling', P(0, CEILING_Y, 0), P(1, CEILING_Y, 0), P(0, CEILING_Y, 1), CENTRE_INSIDE, P(0, 0, -1));
  const aft = planeThrough('aft', P(0, 0, AFT_Z), P(1, 0, AFT_Z), P(0, 1, AFT_Z), CENTRE_INSIDE);
  const front = planeThrough('windscreen', P(0, WINDSCREEN.y0, WINDSCREEN.z0), P(1, WINDSCREEN.y0, WINDSCREEN.z0), P(0, WINDSCREEN.y1, WINDSCREEN.z1), CENTRE_INSIDE);
  const header = planeThrough('header', P(0, WINDSCREEN.y1, WINDSCREEN.z1), P(1, WINDSCREEN.y1, WINDSCREEN.z1), P(0, CEILING_Y, HEADER_Z), CENTRE_INSIDE);
  planes.push(floor, ceiling, aft, front, header);
  // No. 1 windows on the windscreen plane (u = x across, v up the slope).
  const w1 = (s: number): Pt2[] => {
    const pts = [
      P(s * WINDSCREEN.postHalf, WINDSCREEN.y0, WINDSCREEN.z0),
      P(s * WINDSCREEN_OUTER.bottom, WINDSCREEN.y0, WINDSCREEN.z0),
      P(s * WINDSCREEN_OUTER.top, WINDSCREEN.y1, WINDSCREEN.z1),
      P(s * WINDSCREEN.postHalf, WINDSCREEN.y1, WINDSCREEN.z1),
    ].map((p) => planeUV(front, p));
    return ccw(pts);
  };
  front.windows.push(inset(w1(-1), 0.012), inset(w1(1), 0.012));

  for (const s of [-1, 1]) {
    const post = cornerPost(s);
    const side = planeThrough(s < 0 ? 'sideL' : 'sideR', P(s * SIDE_X, 0, 0), P(s * SIDE_X, 0, 1), P(s * SIDE_X, 1, 0), CENTRE_INSIDE);
    const cheekBack = P(s * SIDE_X, WINDOW_SILL_Y, CHEEK_AFT.zBottom);
    const cheek = planeThrough(s < 0 ? 'cheekL' : 'cheekR', post.bottom, post.top, cheekBack, CENTRE_INSIDE);
    // No. 2 window: between the corner post and the cheek's aft edge, sill to top, with frame margins.
    const topAft = intersectLinePlane(P(s * SIDE_X, SIDE_WINDOW_TOP_Y + 0.02, -2), P(s * SIDE_X, SIDE_WINDOW_TOP_Y + 0.02, 2), cheek);
    const w2 = [
      post.bottom,
      cheekBack,
      topAft ?? P(s * SIDE_X, SIDE_WINDOW_TOP_Y, CHEEK_AFT.zTop),
      post.top,
    ].map((p) => planeUV(cheek, p));
    cheek.windows.push(inset(ccw(w2), 0.045));
    // No. 3 window: on the side wall beside the pilot, its front edge 10 cm aft of the raked
    // junction with the cheek plane (z where the cheek meets x = ±SIDE_X at height y).
    const junctionZ = (y: number) => (cheek.d - cheek.n.x * s * SIDE_X - cheek.n.y * y) / cheek.n.z;
    const yb = WINDOW_SILL_Y + 0.05;
    const yt = SIDE_WINDOW_TOP_Y - 0.03;
    const w3 = [P(s * SIDE_X, yb, junctionZ(yb) + 0.1), P(s * SIDE_X, yb, 0.4), P(s * SIDE_X, yt, 0.4), P(s * SIDE_X, yt, junctionZ(yt) + 0.1)].map((p) =>
      planeUV(side, p),
    );
    side.windows.push(ccw(w3));
    planes.push(side, cheek);
  }
  return planes;
}

function intersectLinePlane(a: V3, b: V3, pl: RoomPlane): V3 | null {
  const d = sub(b, a);
  const den = dot(pl.n, d);
  if (Math.abs(den) < 1e-9) return null;
  const t = (pl.d - dot(pl.n, a)) / den;
  return { x: a.x + d.x * t, y: a.y + d.y * t, z: a.z + d.z * t };
}

/** Signed area > 0 ⇔ CCW. */
function area(poly: readonly Pt2[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}
function ccw(poly: Pt2[]): Pt2[] {
  return area(poly) < 0 ? poly.slice().reverse() : poly;
}
/** Shrink a convex CCW polygon by moving every edge inward by m (frame margin). */
function inset(poly: Pt2[], m: number): Pt2[] {
  const n = poly.length;
  const lines = poly.map((a, i) => {
    const b = poly[(i + 1) % n];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    const nx = -dy / l;
    const ny = dx / l; // inward (left of the edge for CCW)
    return { px: a[0] + nx * m, py: a[1] + ny * m, dx, dy };
  });
  return lines.map((L1, i) => {
    const L0 = lines[(i + n - 1) % n];
    // Intersect L0 and L1.
    const den = L0.dx * L1.dy - L0.dy * L1.dx;
    if (Math.abs(den) < 1e-12) return [L1.px, L1.py] as Pt2;
    const t = ((L1.px - L0.px) * L1.dy - (L1.py - L0.py) * L1.dx) / den;
    return [L0.px + L0.dx * t, L0.py + L0.dy * t] as Pt2;
  });
}

/** The room planes (built once). */
export const ROOM: readonly RoomPlane[] = buildRoom();
export const roomPlane = (name: string): RoomPlane => {
  const p = ROOM.find((q) => q.name === name);
  if (!p) throw new Error(`flight deck: no plane ${name}`);
  return p;
};

/** Half-width of the room (to the nearer of the side wall and the cheek plane) at height y, station z. */
export function roomHalfWidth(y: number, z: number): number {
  let w = SIDE_X;
  for (const pl of ROOM) {
    if (pl.n.x <= 0.2) continue;
    // n·(x, y, z) = d → x = (d − n.y y − n.z z) / n.x
    w = Math.min(w, (pl.d - pl.n.y * y - pl.n.z * z) / pl.n.x);
  }
  return w;
}

/** Signed distance to a convex CCW polygon's boundary: > 0 inside. */
export function polyInside(poly: readonly Pt2[], u: number, v: number): number {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    d = Math.min(d, (-(u - a[0]) * dy + (v - a[1]) * dx) / l);
  }
  return d;
}

/** Inside the room (all planes), with a margin m (> 0 = at least m from every wall). */
export function insideRoom(p: V3, m = 0): boolean {
  for (const pl of ROOM) if (dot(pl.n, p) > pl.d - m) return false;
  return true;
}

// ─── Furniture ───────────────────────────────────────────────────────────────

/**
 * The main instrument panel: a flat face tilted back by `tilt` (top further forward), centred at
 * (0, cy, cz). Panel coordinates (px right, py up the face). The display row is at py = 0.
 */
export const PANEL = { cy: -0.52, cz: -0.86, tilt: (12 * Math.PI) / 180, halfWidth: 0.86, top: 0.14, bottom: -0.2, centreBottom: -0.37, centreHalf: 0.3 } as const;
export function panelPoint(px: number, py: number, dz = 0): V3 {
  const c = Math.cos(PANEL.tilt);
  const s = Math.sin(PANEL.tilt);
  // Face normal n = (0, s, c) (toward the pilots and up); up-the-face t = (0, c, −s).
  return { x: px, y: PANEL.cy + py * c + dz * s, z: PANEL.cz - py * s + dz * c };
}
export const PANEL_NORMAL: V3 = { x: 0, y: Math.sin(PANEL.tilt), z: Math.cos(PANEL.tilt) };

/** Display units: 8 × 8 in bezels with a 6.7 in square picture. */
export const DISPLAY = { bezel: 0.214, screen: 0.172 } as const;
export type DisplayId = 'pfdL' | 'ndL' | 'eicasUpper' | 'ndR' | 'pfdR' | 'eicasLower';
export const DISPLAY_IDS: readonly DisplayId[] = ['pfdL', 'ndL', 'eicasUpper', 'ndR', 'pfdR', 'eicasLower'];
/** Display centres in panel coordinates. */
export const DISPLAY_AT: Record<DisplayId, { px: number; py: number }> = {
  pfdL: { px: -0.655, py: 0 },
  ndL: { px: -0.425, py: 0 },
  eicasUpper: { px: 0, py: 0 },
  ndR: { px: 0.425, py: 0 },
  pfdR: { px: 0.655, py: 0 },
  eicasLower: { px: 0, py: -0.226 },
};
/** Standby instruments (airspeed, attitude, altimeter) left of the upper EICAS, stacked; the clock. */
export const STANDBY = { px: -0.2, pys: [0.07, -0.02, -0.11], size: 0.074 } as const;
/** Gear lever on the centre panel right of the upper EICAS (the F/O's side, as on the 747-400). */
export const GEAR_LEVER = { px: 0.2, py: -0.05, travel: 0.07 } as const;

/** Glareshield: aft lip (top), the sloped MCP face down to its lower edge, forward to the windscreen. */
export const GLARESHIELD = { lipY: -0.265, lipZ: -0.7, faceBottomY: -0.345, faceBottomZ: -0.73, halfWidth: 0.9 } as const;
/** Mode control panel (centre) and EFIS control panels on the glareshield face (x ranges). */
export const MCP = { x0: -0.42, x1: 0.42 } as const;
export const EFIS = { x0: 0.5, x1: 0.8 } as const;

/** Centre pedestal between the seats: forward/aft ends, top surface heights, half width. */
export const PEDESTAL = { z0: -0.62, z1: 0.42, yFront: -0.72, yAft: -0.77, halfWidth: 0.29 } as const;
/** Thrust lever quadrant (4 levers) on the forward pedestal: pivot line, lever length, spacing, sweep. */
export const THRUST = { pivotY: -0.78, pivotZ: -0.44, length: 0.26, spacing: 0.052, idleDeg: -28, fullDeg: 22 } as const;
/** Speed brake lever (left of the thrust levers) and flap lever (right). */
export const SPEEDBRAKE = { x: -0.19, pivotY: -0.76, pivotZ: -0.42, length: 0.16, downDeg: -18, upDeg: 22 } as const;
export const FLAP_LEVER = { x: 0.19, pivotY: -0.76, pivotZ: -0.4, length: 0.16 } as const;
/** Flap lever gate on the 747-400: UP, 1, 5, 10, 20, 25, 30 — lever angle per gate (deg, + forward). */
export const FLAP_GATES: readonly { label: string; deg: number; angle: number }[] = [
  { label: 'UP', deg: 0, angle: 24 },
  { label: '1', deg: 1, angle: 15 },
  { label: '5', deg: 5, angle: 7 },
  { label: '10', deg: 10, angle: -1 },
  { label: '20', deg: 20, angle: -9 },
  { label: '25', deg: 25, angle: -17 },
  { label: '30', deg: 30, angle: -25 },
];
/** CDUs on the pedestal aft of the throttle quadrant (left, right) and the centre one further aft. */
export const CDU = { w: 0.146, h: 0.23, tiltDeg: 38, at: [{ x: -0.145, z: -0.13 }, { x: 0.145, z: -0.13 }, { x: 0, z: 0.2 }] } as const;

/** Control columns: floor pivot and the yoke hub (captain at x = −0.55, F/O mirrored). */
export const COLUMN = { pivotY: FLOOR_Y + 0.08, pivotZ: -0.74, hubY: -0.56, hubZ: -0.5, pitchDeg: 9, rollDeg: 75, yokeHalf: 0.185 } as const;
/** Rudder pedals: centre, travel (m, fore/aft at full rudder). */
export const PEDALS = { y: FLOOR_Y + 0.2, z: -1.0, halfSpacing: 0.12, travel: 0.06 } as const;
/** Pilot seats: cushion top, pan fore/aft, back. */
export const SEAT = { cushionY: -0.79, z0: -0.18, z1: 0.3, backZ: 0.34, width: 0.5 } as const;
/** Side consoles outboard of the seats. */
export const CONSOLE = { x0: 0.8, topY: -0.6, z0: -0.72, z1: 0.62 } as const;
/**
 * Overhead panel: hangs under the ceiling from just aft of the windscreen header to behind the
 * pilots' heads, tilted to face them.
 */
export const OVERHEAD = { halfWidth: 0.46, front: { y: 0.39, z: -0.47 }, back: { y: 0.6, z: 0.5 } } as const;
/** Observer (jump) seats in front of the aft bulkhead. */
export const JUMP_SEATS: readonly V3[] = [
  { x: 0.18, y: FLOOR_Y, z: 1.18 },
  { x: -0.62, y: FLOOR_Y, z: 1.2 },
];
