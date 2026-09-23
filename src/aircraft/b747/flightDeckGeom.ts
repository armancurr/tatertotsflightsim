/**
 * Boeing 747-400 flight deck — geometry (node-safe; three.js core only). Everything in the deck
 * frame (flightDeckLayout.ts). Builds:
 *
 *  - `lining`: the room faces with the window openings cut out (floor carpet, walls, header,
 *    ceiling, aft bulkhead), window frames and posts, the glareshield, panel bodies, display bezels,
 *    the pedestal and consoles, the overhead slab with its switches / knobs / fire handles, seats,
 *    observer seats, sun visors, window cranks — one vertex-coloured geometry (one draw call).
 *  - `faces`: the painted panel faces (UV-mapped into the atlas of flightDeckPaint.ts).
 *  - `glass`: the six windows' panes.
 *  - `screens`: one quad per display + the standby instrument strip.
 *  - the moving parts in their own local frames: thrust lever, speed brake lever, flap lever, gear
 *    lever, column, yoke, pedal (placed and animated by flightDeck.ts).
 */
import * as THREE from 'three';
import { tint, merge } from '../materials';
import { box, tube, V } from '../f16/geom';
import {
  CDU, COLUMN, CONSOLE, DISPLAY, DISPLAY_AT, DISPLAY_IDS, FLAP_LEVER, FLOOR_Y, GEAR_LEVER, GLARESHIELD, JUMP_SEATS, MCP, EFIS, OVERHEAD,
  PANEL, PANEL_NORMAL, PEDALS, PEDESTAL, ROOM, SEAT, SPEEDBRAKE, STANDBY, THRUST, WINDSCREEN, WINDSCREEN_OUTER, AFT_Z, CEILING_Y, SIDE_X,
  panelPoint, planePoint, type DisplayId, type Pt2, type RoomPlane, type V3,
} from './flightDeckLayout';
import { ATLAS, EFIS_KNOBS, MCP_KNOBS, atlasUV, overheadItems, type ARect } from './flightDeckPaint';

export const DECK_COLORS = {
  lining: 0xb3b2ac,
  ceiling: 0xbebdb7,
  floor: 0x3a3f46,
  panel: 0x5b6166,
  glare: 0x1d1f21,
  frame: 0x70757a,
  dark: 0x26292c,
  bezel: 0x2e3134,
  seat: 0x2f343c,
  sheep: 0xcdc3ae,
  metal: 0x9ea3a8,
  knob: 0x1a1b1c,
  white: 0xe8e8e2,
} as const;
const C = DECK_COLORS;

const v = (p: V3) => V(p.x, p.y, p.z);

// ─── Room faces ──────────────────────────────────────────────────────────────

/** Clip a convex 3D polygon by the half-space n·p ≤ d. */
function clipPoly(poly: THREE.Vector3[], n: V3, d: number): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  const nn = V(n.x, n.y, n.z);
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const da = nn.dot(a) - d;
    const db = nn.dot(b) - d;
    if (da <= 0) out.push(a);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) out.push(a.clone().lerp(b, da / (da - db)));
  }
  return out;
}

/** The face polygon of a room plane (in its (e1, e2) coordinates, CCW). */
export function roomFace(pl: RoomPlane): Pt2[] {
  const S = 6;
  let poly = [planePoint(pl, -S, -S), planePoint(pl, S, -S), planePoint(pl, S, S), planePoint(pl, -S, S)].map(v);
  for (const q of ROOM) if (q !== pl) poly = clipPoly(poly, q.n, q.d);
  return poly.map((p) => {
    const r = p.clone().sub(v(pl.o));
    return [r.dot(v(pl.e1)), r.dot(v(pl.e2))] as Pt2;
  });
}

/** A planar face (outline + holes, plane 2D coordinates) as a geometry facing INTO the room. */
function planeShape(pl: RoomPlane, outline: readonly Pt2[], holes: readonly (readonly Pt2[])[], color: number, rough: number): THREE.BufferGeometry {
  const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
  for (const h of holes) shape.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))));
  const g = new THREE.ShapeGeometry(shape);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const p = planePoint(pl, pos.getX(i), pos.getY(i));
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  // ShapeGeometry faces +Z of the shape = e1 × e2 = the outward normal: flip to face inward.
  const idx = g.getIndex()!;
  const a = idx.array as Uint16Array | Uint32Array;
  for (let i = 0; i < a.length; i += 3) {
    const t = a[i + 1];
    a[i + 1] = a[i + 2];
    a[i + 2] = t;
  }
  const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, -pl.n.x, -pl.n.y, -pl.n.z);
  return tint(g, color, rough, 0);
}

function roomColor(name: string): number {
  if (name === 'floor') return C.floor;
  if (name === 'ceiling' || name === 'header') return C.ceiling;
  if (name === 'windscreen') return C.dark;
  return C.lining;
}

/** Window frame: bars along each edge of the window polygon, set just inside the room. */
function windowFrame(pl: RoomPlane, poly: readonly Pt2[], width: number, depth: number, color: number): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const nIn = V(-pl.n.x, -pl.n.y, -pl.n.z);
  for (let i = 0; i < poly.length; i++) {
    const a = v(planePoint(pl, poly[i][0], poly[i][1]));
    const b = v(planePoint(pl, poly[(i + 1) % poly.length][0], poly[(i + 1) % poly.length][1]));
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const along = b.clone().sub(a);
    const len = along.length();
    along.normalize();
    // Frame bar: length along the edge, width across (outward from the opening, in the plane), depth into the room.
    const across = new THREE.Vector3().crossVectors(nIn, along).normalize().multiplyScalar(-1);
    const g = new THREE.BoxGeometry(len + width * 0.6, width, depth);
    const m = new THREE.Matrix4().makeBasis(along, across, nIn);
    g.applyMatrix4(m);
    // `across` points into the opening: set the bar on the lining, overlapping the opening by 6 mm.
    const off = -(width / 2 - 0.006);
    g.translate(mid.x + across.x * off + nIn.x * depth * 0.5, mid.y + across.y * off + nIn.y * depth * 0.5, mid.z + across.z * off + nIn.z * depth * 0.5);
    out.push(tint(g, color, 0.6, 0.05));
  }
  return out;
}

// ─── Textured faces ──────────────────────────────────────────────────────────

/** Quad a (bottom-left) → b (bottom-right) → c (top-right) → d (top-left), UV-mapped to an atlas rect (or a sub-rect in 0..1 of it). */
export function quadUV(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, r: ARect, sub = { u0: 0, v0: 0, u1: 1, v1: 1 }): THREE.BufferGeometry {
  const uv = atlasUV(r);
  const U = (t: number) => uv.u0 + (uv.u1 - uv.u0) * t;
  const W = (t: number) => uv.v0 + (uv.v1 - uv.v0) * t;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, d.x, d.y, d.z], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([U(sub.u0), W(sub.v0), U(sub.u1), W(sub.v0), U(sub.u1), W(sub.v1), U(sub.u0), W(sub.v1)], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.computeVertexNormals();
  return g;
}
/** Plain quad with 0..1 UVs (a display screen). */
function screenQuad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, d.x, d.y, d.z], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.computeVertexNormals();
  return g;
}

const pp = (px: number, py: number, dz = 0) => v(panelPoint(px, py, dz));

/** A box whose axes are the panel's (x across, y up the face, z out of the face), centred at panel point (px, py) and dz out. */
function panelBox(px: number, py: number, dz: number, w: number, h: number, d: number, color: number, rough = 0.6, metal = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.rotateX(-PANEL.tilt);
  const c = pp(px, py, dz);
  g.translate(c.x, c.y, c.z);
  return tint(g, color, rough, metal);
}

// ─── Moving parts (local frames) ─────────────────────────────────────────────

/** Thrust lever: shaft up from the pivot (+Y), the T-shaped knob, and the reverse lever riding in front. */
export function buildThrustLever(): THREE.BufferGeometry {
  const L = THRUST.length;
  return merge([
    tint(box(0.012, L, 0.01, V(0, L / 2, 0)), C.metal, 0.3, 0.85),
    tint(new THREE.CylinderGeometry(0.017, 0.017, 0.044, 14).rotateZ(Math.PI / 2).translate(0, L + 0.01, 0.002), 0x4a4e52, 0.4, 0.1),
    tint(box(0.008, 0.075, 0.008, V(0, L - 0.055, -0.022)), C.metal, 0.35, 0.8),
    tint(box(0.02, 0.012, 0.02, V(0, L - 0.015, -0.03)), 0x3a3d40, 0.5, 0.05),
  ]);
}
export function buildSpeedBrakeLever(): THREE.BufferGeometry {
  const L = SPEEDBRAKE.length;
  return merge([tint(box(0.014, L, 0.012, V(0, L / 2, 0)), C.metal, 0.35, 0.8), tint(box(0.05, 0.03, 0.03, V(0, L + 0.01, 0)), C.dark, 0.5, 0.05)]);
}
export function buildFlapLever(): THREE.BufferGeometry {
  const L = FLAP_LEVER.length;
  // The flap handle: an airfoil-shaped knob.
  const knob = new THREE.CylinderGeometry(0.018, 0.018, 0.07, 12);
  knob.rotateZ(Math.PI / 2);
  knob.scale(1, 1, 1.9);
  knob.translate(0, L + 0.012, 0);
  return merge([tint(box(0.014, L, 0.012, V(0, L / 2, 0)), C.metal, 0.35, 0.8), tint(knob, C.white, 0.5, 0.05)]);
}
/** Gear lever in its own frame (x across the panel, y up the face, z out of it): arm along +z then the wheel knob. */
export function buildGearLever(): THREE.BufferGeometry {
  const wheel = new THREE.CylinderGeometry(0.03, 0.03, 0.022, 20);
  wheel.rotateZ(Math.PI / 2);
  wheel.translate(0, 0, 0.1);
  return merge([tint(box(0.016, 0.016, 0.1, V(0, 0, 0.05)), C.metal, 0.35, 0.8), tint(wheel, C.white, 0.45, 0.05)]);
}
/** Control column from its floor pivot (origin) up to the hub. */
export function buildColumn(): THREE.BufferGeometry {
  const hub = V(0, COLUMN.hubY - COLUMN.pivotY, COLUMN.hubZ - COLUMN.pivotZ);
  return merge([
    tint(tube(V(0, 0, 0), hub.clone().multiplyScalar(0.96), 0.03, 0.026, 12), C.panel, 0.55, 0.2),
    tint(box(0.1, 0.08, 0.12, V(0, 0.02, 0)), C.dark, 0.6, 0.1),
  ]);
}
/** Ram's-horn yoke about its hub (origin); the roll axis is local +Z (toward the pilot). */
export function buildYoke(): THREE.BufferGeometry {
  const H = COLUMN.yokeHalf;
  const parts: THREE.BufferGeometry[] = [tint(box(0.13, 0.07, 0.05, V(0, 0, 0.01)), C.dark, 0.5, 0.1), tint(box(0.1, 0.06, 0.006, V(0, 0.005, 0.038)), 0x3a3f44, 0.4, 0.1)];
  for (const s of [-1, 1]) {
    parts.push(tint(tube(V(s * 0.06, -0.01, 0.01), V(s * (H - 0.02), -0.03, 0.03), 0.014, 0.014, 8), C.knob, 0.5, 0.05));
    parts.push(tint(tube(V(s * (H - 0.02), -0.05, 0.03), V(s * H, 0.09, 0.03), 0.019, 0.017, 10), C.knob, 0.55, 0.02));
    parts.push(tint(box(0.012, 0.012, 0.014, V(s * (H - 0.004), 0.08, 0.016)), 0x6a6e72, 0.4, 0.5));
  }
  return merge(parts);
}
export function buildPedal(): THREE.BufferGeometry {
  return merge([tint(box(0.08, 0.2, 0.02, V(0, 0, 0), -0.35, 0, 0), C.dark, 0.7, 0.2), tint(tube(V(0, -0.02, 0.02), V(0, 0.2, -0.3), 0.012, 0.012, 6), C.metal, 0.4, 0.6)]);
}

// ─── The whole static deck ───────────────────────────────────────────────────

export interface DeckBuild {
  lining: THREE.BufferGeometry;
  faces: THREE.BufferGeometry;
  glass: THREE.BufferGeometry;
  /** Display screens (0..1 UVs), keyed by id, and the standby strip. */
  screens: Record<DisplayId, THREE.BufferGeometry>;
  standby: THREE.BufferGeometry;
  /** Where the gear lever pivots and its frame (panel orientation). */
  gearLeverPos: THREE.Vector3;
  panelQuat: THREE.Quaternion;
}

function seat(x: number, zPan: number, scale = 1, facing = 1): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const y = SEAT.cushionY;
  const w = SEAT.width * scale;
  const zBack = zPan + facing * 0.25 * scale;
  out.push(tint(box(w, 0.1, 0.46 * scale, V(x, y - 0.05, zPan)), C.seat, 0.85));
  out.push(tint(box(w * 0.92, 0.03, 0.4 * scale, V(x, y + 0.005, zPan - facing * 0.01)), C.sheep, 0.95));
  out.push(tint(box(w, 0.72 * scale, 0.1, V(x, y + 0.36 * scale, zBack), facing * -0.2, 0, 0), C.seat, 0.85));
  out.push(tint(box(w * 0.9, 0.62 * scale, 0.03, V(x, y + 0.36 * scale, zBack - facing * 0.06), facing * -0.2, 0, 0), C.sheep, 0.95));
  out.push(tint(box(w * 0.55, 0.16 * scale, 0.09, V(x, y + 0.8 * scale, zBack + facing * 0.08), facing * -0.2, 0, 0), C.seat, 0.85));
  for (const s of [-1, 1]) out.push(tint(box(0.06, 0.05, 0.34 * scale, V(x + s * (w / 2 + 0.02), y + 0.2 * scale, zPan)), C.seat, 0.8));
  out.push(tint(box(0.16, Math.max(0.05, y - 0.1 - FLOOR_Y), 0.3, V(x, (y - 0.1 + FLOOR_Y) / 2, zPan)), C.dark, 0.7, 0.3));
  out.push(tint(box(0.5, 0.03, 0.55, V(x, FLOOR_Y + 0.02, zPan)), C.metal, 0.5, 0.6));
  return out;
}

export function buildFlightDeck(): DeckBuild {
  const L: THREE.BufferGeometry[] = [];
  const F: THREE.BufferGeometry[] = [];
  const glass: THREE.BufferGeometry[] = [];

  // ── Room lining with the windows cut out, window frames, glass ──
  for (const pl of ROOM) {
    L.push(planeShape(pl, roomFace(pl), pl.windows, roomColor(pl.name), pl.name === 'floor' ? 0.95 : 0.85));
    for (const w of pl.windows) {
      L.push(...windowFrame(pl, w, 0.05, 0.04, C.frame));
      const pts = w.map(([x, y]) => v(planePoint(pl, x, y)));
      const g = new THREE.BufferGeometry().setFromPoints(pts);
      const idx: number[] = [];
      for (let i = 1; i < pts.length - 1; i++) idx.push(0, i + 1, i);
      g.setIndex(idx);
      // Push the glass 2 cm outward, beyond the lining.
      g.translate(pl.n.x * 0.02, pl.n.y * 0.02, pl.n.z * 0.02);
      g.computeVertexNormals();
      glass.push(g);
    }
  }
  // Centre post between the windscreens.
  L.push(tint(tube(V(0, WINDSCREEN.y0, WINDSCREEN.z0 + 0.02), V(0, WINDSCREEN.y1, WINDSCREEN.z1 + 0.02), 0.05, 0.04, 8), C.frame, 0.6, 0.05));
  // Sidewall trim on the cheek and side walls: the armrest ledge under the windows and the darker
  // kick panel below it.
  for (const pl of ROOM) {
    if (!/^(cheek|side)/.test(pl.name)) continue;
    const band = (y0: number, y1: number, inward: number, color: number) => {
      let poly = [planePoint(pl, -6, -6), planePoint(pl, 6, -6), planePoint(pl, 6, 6), planePoint(pl, -6, 6)].map(v);
      for (const q of ROOM) if (q !== pl) poly = clipPoly(poly, q.n, q.d);
      poly = clipPoly(poly, { x: 0, y: 1, z: 0 }, y1);
      poly = clipPoly(poly, { x: 0, y: -1, z: 0 }, -y0);
      if (poly.length < 3) return;
      const pts = poly.map((p) => p.addScaledVector(v(pl.n), -inward));
      const g = new THREE.BufferGeometry().setFromPoints(pts);
      const idx: number[] = [];
      for (let i = 1; i < pts.length - 1; i++) idx.push(0, i + 1, i);
      g.setIndex(idx);
      g.computeVertexNormals();
      if ((g.getAttribute('normal') as THREE.BufferAttribute).getX(0) * pl.n.x + (g.getAttribute('normal') as THREE.BufferAttribute).getY(0) * pl.n.y + (g.getAttribute('normal') as THREE.BufferAttribute).getZ(0) * pl.n.z > 0) {
        const r: number[] = [];
        for (let i = 0; i < idx.length; i += 3) r.push(idx[i], idx[i + 2], idx[i + 1]);
        g.setIndex(r);
        g.computeVertexNormals();
      }
      L.push(tint(g, color, 0.8));
    };
    band(-0.62, -0.36, 0.006, 0x6d7176);
    band(-0.36, -0.3, 0.035, 0x44484c);
  }
  // Sliding-window cranks.
  for (const s of [-1, 1]) {
    L.push(tint(box(0.03, 0.12, 0.03, V(s * (SIDE_X - 0.06), -0.22, -0.3)), C.dark, 0.5, 0.3));
    L.push(tint(box(0.07, 0.022, 0.022, V(s * (SIDE_X - 0.08), -0.17, -0.3)), C.knob, 0.5, 0.1));
  }

  // ── Glareshield: anti-glare top, the MCP/EFIS face, underside ──
  const G = GLARESHIELD;
  {
    const top = new THREE.Shape([
      new THREE.Vector2(-WINDSCREEN_OUTER.bottom, WINDSCREEN.z0),
      new THREE.Vector2(WINDSCREEN_OUTER.bottom, WINDSCREEN.z0),
      new THREE.Vector2(G.halfWidth, G.lipZ),
      new THREE.Vector2(-G.halfWidth, G.lipZ),
    ]);
    const tg = new THREE.ShapeGeometry(top);
    tg.rotateX(Math.PI / 2); // (x, z) shape → XZ plane, facing -Y… flip below.
    const pos = tg.getAttribute('position') as THREE.BufferAttribute;
    // Sloping down from the lip to the windscreen base, just under the pilots' sight line over the lip.
    for (let i = 0; i < pos.count; i++) {
      const z = pos.getZ(i);
      const t = (z - G.lipZ) / (WINDSCREEN.z0 - G.lipZ);
      pos.setXYZ(i, pos.getX(i), G.lipY + 0.004 + (WINDSCREEN.y0 - 0.004 - G.lipY) * t, z);
    }
    const idx = tg.getIndex()!.array as Uint16Array;
    for (let i = 0; i < idx.length; i += 3) {
      const t = idx[i + 1];
      idx[i + 1] = idx[i + 2];
      idx[i + 2] = t;
    }
    tg.computeVertexNormals();
    // Make sure it faces up.
    const nrm = tg.getAttribute('normal') as THREE.BufferAttribute;
    if (nrm.getY(0) < 0) for (let i = 0; i < idx.length; i += 3) {
      const t = idx[i + 1];
      idx[i + 1] = idx[i + 2];
      idx[i + 2] = t;
    }
    tg.computeVertexNormals();
    L.push(tint(tg, C.glare, 0.95));
    // Rounded aft lip (a tube along the edge).
    L.push(tint(tube(V(-G.halfWidth, G.lipY - 0.004, G.lipZ + 0.004), V(G.halfWidth, G.lipY - 0.004, G.lipZ + 0.004), 0.012, 0.012, 8), C.glare, 0.9));
    // The face: MCP in the centre, EFIS panels, plain grey outboard.
    const faceAt = (x: number, t: number) => V(x, G.lipY + (G.faceBottomY - G.lipY) * t, G.lipZ + (G.faceBottomZ - G.lipZ) * t);
    F.push(quadUV(faceAt(MCP.x0, 1), faceAt(MCP.x1, 1), faceAt(MCP.x1, 0), faceAt(MCP.x0, 0), ATLAS.mcp));
    for (const s of [-1, 1]) {
      const x0 = s < 0 ? -EFIS.x1 : EFIS.x0;
      const x1 = s < 0 ? -EFIS.x0 : EFIS.x1;
      F.push(quadUV(faceAt(x0, 1), faceAt(x1, 1), faceAt(x1, 0), faceAt(x0, 0), s < 0 ? ATLAS.efisL : ATLAS.efisR));
    }
    // Plain face strips between and outboard (lining side of the glareshield).
    const strip = (x0: number, x1: number) => {
      const g = new THREE.BufferGeometry().setFromPoints([faceAt(x0, 1), faceAt(x1, 1), faceAt(x1, 0), faceAt(x0, 0)]);
      g.setIndex([0, 1, 2, 0, 2, 3]);
      g.computeVertexNormals();
      L.push(tint(g, C.panel, 0.7));
    };
    strip(MCP.x1, EFIS.x0);
    strip(-EFIS.x0, MCP.x0);
    strip(EFIS.x1, G.halfWidth);
    strip(-G.halfWidth, -EFIS.x1);
    // Underside back to the panel top.
    const pt = pp(0, PANEL.top);
    const u0 = faceAt(-G.halfWidth, 1);
    const u1 = faceAt(G.halfWidth, 1);
    const ug = new THREE.BufferGeometry().setFromPoints([V(-PANEL.halfWidth, pt.y, pt.z), V(PANEL.halfWidth, pt.y, pt.z), u1, u0]);
    ug.setIndex([0, 2, 1, 0, 3, 2]);
    ug.computeVertexNormals();
    L.push(tint(ug, C.dark, 0.8));
    // MCP knobs and the EFIS knobs (3D), and the MCP's autopilot disengage bar.
    const faceN = new THREE.Vector3(0, G.faceBottomZ - G.lipZ, -(G.faceBottomY - G.lipY)).normalize();
    if (faceN.z < 0) faceN.multiplyScalar(-1);
    const knobAt = (x: number, t: number, r: number, h: number, col: number) => {
      const k = new THREE.CylinderGeometry(r, r * 1.05, h, 16);
      k.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), faceN));
      const c = faceAt(x, t).addScaledVector(faceN, h / 2);
      k.translate(c.x, c.y, c.z);
      L.push(tint(k, col, 0.5, 0.1));
    };
    for (const k of MCP_KNOBS) knobAt(MCP.x0 + (MCP.x1 - MCP.x0) * k.u, 0.72, 0.014, 0.02, C.knob);
    for (const s of [-1, 1]) for (const u of EFIS_KNOBS) knobAt(s < 0 ? -EFIS.x1 + (EFIS.x1 - EFIS.x0) * u : EFIS.x0 + (EFIS.x1 - EFIS.x0) * u, 0.65, 0.013, 0.018, C.knob);
    knobAt(MCP.x1 - 0.06, 0.8, 0.006, 0.01, 0x9a9a92);
  }

  // ── Main instrument panel: body, face, bezels, screens ──
  const T = PANEL.top;
  const B = PANEL.bottom;
  const CB = PANEL.centreBottom;
  const HW = PANEL.halfWidth;
  // Face (UV into the 'main' region: px −0.86..0.86 → u, py 0.14..−0.37 → v).
  const sub = (px0: number, py0: number, px1: number, py1: number) => ({ u0: (px0 + HW) / (2 * HW), u1: (px1 + HW) / (2 * HW), v0: (py0 - CB) / (T - CB), v1: (py1 - CB) / (T - CB) });
  F.push(quadUV(pp(-HW, B), pp(HW, B), pp(HW, T), pp(-HW, T), ATLAS.main, sub(-HW, B, HW, T)));
  F.push(quadUV(pp(-PANEL.centreHalf, CB), pp(PANEL.centreHalf, CB), pp(PANEL.centreHalf, B), pp(-PANEL.centreHalf, B), ATLAS.main, sub(-PANEL.centreHalf, CB, PANEL.centreHalf, B)));
  L.push(panelBox(0, (T + B) / 2, -0.03, 2 * HW, T - B + 0.02, 0.06, C.dark, 0.8));
  L.push(panelBox(0, (T + B) / 2, -0.1, 1.5, T - B, 0.08, C.dark, 0.8));
  L.push(panelBox(0, (B + CB) / 2, -0.08, 2 * PANEL.centreHalf + 0.02, B - CB + 0.02, 0.16, C.dark, 0.8));
  // Knee panels under the pilots' sides of the panel.
  for (const s of [-1, 1]) L.push(panelBox(s * 0.58, B - 0.1, -0.12, 0.55, 0.2, 0.05, C.panel, 0.8));
  const screens = {} as Record<DisplayId, THREE.BufferGeometry>;
  const hs = DISPLAY.screen / 2;
  for (const id of DISPLAY_IDS) {
    const { px, py } = DISPLAY_AT[id];
    L.push(panelBox(px, py, 0.012, DISPLAY.bezel, DISPLAY.bezel, 0.024, C.bezel, 0.55, 0.05));
    // Bezel buttons along the bottom edge.
    for (let i = -2; i <= 2; i++) L.push(panelBox(px + i * 0.03, py - DISPLAY.bezel / 2 + 0.011, 0.026, 0.016, 0.008, 0.006, 0x4a4e52, 0.6));
    screens[id] = screenQuad(pp(px - hs, py - hs, 0.0245), pp(px + hs, py - hs, 0.0245), pp(px + hs, py + hs, 0.0245), pp(px - hs, py + hs, 0.0245));
  }
  // Standby instruments: a stacked strip left of the upper EICAS.
  const sw = STANDBY.size / 2;
  const sTop = STANDBY.pys[0] + sw;
  const sBot = STANDBY.pys[2] - sw;
  L.push(panelBox(STANDBY.px, (sTop + sBot) / 2, 0.01, STANDBY.size + 0.02, sTop - sBot + 0.02, 0.02, C.bezel, 0.55));
  const standby = screenQuad(pp(STANDBY.px - sw, sBot, 0.0205), pp(STANDBY.px + sw, sBot, 0.0205), pp(STANDBY.px + sw, sTop, 0.0205), pp(STANDBY.px - sw, sTop, 0.0205));
  // Gear lever: a slot plate; the lever itself is a moving part at GEAR_LEVER.
  L.push(panelBox(GEAR_LEVER.px, GEAR_LEVER.py, 0.004, 0.05, 0.16, 0.008, 0x2b2e31, 0.6));
  L.push(panelBox(GEAR_LEVER.px, GEAR_LEVER.py + 0.1, 0.008, 0.05, 0.02, 0.012, 0xc9c9c0, 0.6));
  // Gear lights (three greens) right of the lever, and the autobrake knob, clocks.
  for (let i = 0; i < 3; i++) L.push(panelBox(0.27, 0.04 - i * 0.035, 0.006, 0.03, 0.02, 0.01, 0x1c3a22, 0.3));
  for (const [px, py] of [[0.2, -0.22], [-0.2, -0.22], [-0.8, 0.11], [0.8, 0.11]] as const) {
    const k = new THREE.CylinderGeometry(0.014, 0.015, 0.018, 14);
    k.rotateX(Math.PI / 2 - PANEL.tilt);
    const c = pp(px, py, 0.009);
    k.translate(c.x, c.y, c.z);
    L.push(tint(k, C.knob, 0.5, 0.1));
  }

  // ── Centre pedestal: body, quadrant plate, aft plate, CDUs ──
  const P = PEDESTAL;
  const cbp = pp(0, CB);
  L.push(tint(box(2 * P.halfWidth + 0.02, cbp.y - FLOOR_Y, 0.24, V(0, (cbp.y + FLOOR_Y) / 2, cbp.z + 0.1)), C.panel, 0.8));
  // Forward slope from the lower EICAS panel down/aft to the quadrant.
  {
    const a = V(-P.halfWidth, cbp.y, cbp.z + 0.02);
    const b = V(P.halfWidth, cbp.y, cbp.z + 0.02);
    const c = V(P.halfWidth, P.yFront, P.z0);
    const d = V(-P.halfWidth, P.yFront, P.z0);
    const g = new THREE.BufferGeometry().setFromPoints([d, c, b, a]);
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.computeVertexNormals();
    if ((g.getAttribute('normal') as THREE.BufferAttribute).getZ(0) < 0) g.setIndex([0, 2, 1, 0, 3, 2]), g.computeVertexNormals();
    L.push(tint(g, C.panel, 0.8));
  }
  const zMid = -0.28;
  L.push(tint(box(2 * P.halfWidth, P.yFront - FLOOR_Y, zMid - P.z0, V(0, (P.yFront + FLOOR_Y) / 2 - 0.004, (P.z0 + zMid) / 2)), C.panel, 0.8));
  L.push(tint(box(2 * P.halfWidth, P.yAft - FLOOR_Y, P.z1 - zMid, V(0, (P.yAft + FLOOR_Y) / 2 - 0.004, (zMid + P.z1) / 2)), C.panel, 0.8));
  F.push(quadUV(V(-P.halfWidth, P.yFront + 0.001, zMid), V(P.halfWidth, P.yFront + 0.001, zMid), V(P.halfWidth, P.yFront + 0.001, P.z0), V(-P.halfWidth, P.yFront + 0.001, P.z0), ATLAS.quadrant));
  F.push(quadUV(V(-P.halfWidth, P.yAft + 0.001, P.z1), V(P.halfWidth, P.yAft + 0.001, P.z1), V(P.halfWidth, P.yAft + 0.001, zMid), V(-P.halfWidth, P.yAft + 0.001, zMid), ATLAS.pedestalAft));
  // Step between the two levels.
  L.push(tint(box(2 * P.halfWidth, P.yFront - P.yAft, 0.01, V(0, (P.yFront + P.yAft) / 2, zMid)), C.panel, 0.8));
  // Thrust lever quadrant hump and the fuel control switches.
  L.push(tint(box(0.24, 0.012, 0.22, V(0, P.yFront + 0.004, THRUST.pivotZ)), 0x2e3134, 0.7));
  for (let i = 0; i < 4; i++) L.push(tint(box(0.012, 0.035, 0.012, V((i - 1.5) * 0.05, P.yFront + 0.02, -0.33)), C.metal, 0.4, 0.7));
  // CDUs: raised, tilted to face aft/up.
  const cduTilt = (CDU.tiltDeg * Math.PI) / 180;
  CDU.at.forEach((c, i) => {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2 + cduTilt, 0, 0));
    const centre = V(c.x, P.yAft + 0.035, c.z);
    const bodyG = new THREE.BoxGeometry(CDU.w, CDU.h, 0.06);
    bodyG.applyQuaternion(q);
    bodyG.translate(centre.x, centre.y, centre.z);
    L.push(tint(bodyG, 0x3c4145, 0.7));
    const hw = CDU.w / 2 - 0.004;
    const hh = CDU.h / 2 - 0.004;
    const corner = (x: number, y: number) => V(x, y, 0.0305).applyQuaternion(q).add(centre);
    F.push(quadUV(corner(-hw, -hh), corner(hw, -hh), corner(hw, hh), corner(-hw, hh), ATLAS[`cdu${i}`]));
  });

  // ── Side consoles, tiller, oxygen boxes ──
  for (const s of [-1, 1]) {
    const x0 = s * CONSOLE.x0;
    const x1 = s * (SIDE_X - 0.01);
    const cx = (x0 + x1) / 2;
    const w = Math.abs(x1 - x0);
    L.push(tint(box(w, CONSOLE.topY - FLOOR_Y, CONSOLE.z1 - CONSOLE.z0, V(cx, (CONSOLE.topY + FLOOR_Y) / 2, (CONSOLE.z0 + CONSOLE.z1) / 2)), C.panel, 0.8));
    const y = CONSOLE.topY + 0.001;
    const xa = Math.min(x0, x1);
    const xb = Math.max(x0, x1);
    F.push(quadUV(V(xa, y, CONSOLE.z1), V(xb, y, CONSOLE.z1), V(xb, y, CONSOLE.z0), V(xa, y, CONSOLE.z0), s < 0 ? ATLAS.consoleL : ATLAS.consoleR));
    // Armrest-height oxygen mask box.
    L.push(tint(box(w * 0.6, 0.08, 0.16, V(cx, CONSOLE.topY + 0.04, CONSOLE.z0 + 0.2)), 0x40454a, 0.7));
  }
  // Captain's nose-wheel steering tiller.
  L.push(tint(tube(V(-0.92, CONSOLE.topY, -0.42), V(-0.92, CONSOLE.topY + 0.05, -0.42), 0.02, 0.02, 10), C.dark, 0.5, 0.3));
  L.push(tint(box(0.03, 0.02, 0.12, V(-0.92, CONSOLE.topY + 0.06, -0.46)), C.knob, 0.5, 0.05));

  // ── Overhead panel: the slab, its face, the relief ──
  {
    const O = OVERHEAD;
    const f0 = V(0, O.front.y, O.front.z);
    const f1 = V(0, O.back.y, O.back.z);
    const along = f1.clone().sub(f0);
    const len = along.length();
    along.normalize();
    const down = new THREE.Vector3(0, -1, 0).addScaledVector(along, along.y).normalize();
    const mid = f0.clone().add(f1).multiplyScalar(0.5);
    // Slab above the face.
    const slab = new THREE.BoxGeometry(2 * O.halfWidth + 0.02, 0.035, len + 0.01);
    const basis = new THREE.Matrix4().makeBasis(V(1, 0, 0), down.clone().multiplyScalar(-1), along);
    slab.applyMatrix4(basis);
    slab.translate(mid.x - down.x * 0.0175, mid.y - down.y * 0.0175, mid.z - down.z * 0.0175);
    L.push(tint(slab, C.panel, 0.8));
    const at = (u: number, t: number, off = 0.002) => f0.clone().addScaledVector(along, t * len).add(V(-O.halfWidth + 2 * O.halfWidth * u, 0, 0)).addScaledVector(down, off);
    // Face, facing down. Looking up from the seat the front rows are at the bottom of the view, so
    // the legends read with their tops toward the aft edge: image bottom = front, image left = left.
    F.push(quadUV(at(0, 0), at(1, 0), at(1, 1), at(0, 1), ATLAS.overhead));
    const { items } = overheadItems();
    const q = new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), down);
    for (const it of items) {
      const c = at(it.u, it.v, 0.002);
      let g: THREE.BufferGeometry;
      let col: number = C.knob;
      if (it.kind === 'rotary') {
        g = new THREE.CylinderGeometry(0.011, 0.013, 0.02, 12);
        g.translate(0, 0.01, 0);
        const ptr = new THREE.BoxGeometry(0.004, 0.022, 0.02);
        ptr.translate(0, 0.012, 0.004);
        g = merge([tint(g, C.knob, 0.5, 0.05), tint(ptr, C.white, 0.5, 0)]);
        g.applyQuaternion(q);
        g.translate(c.x, c.y, c.z);
        L.push(g);
        continue;
      } else if (it.kind === 'push') {
        g = new THREE.BoxGeometry(0.036, 0.012, 0.03);
        g.translate(0, 0.006, 0);
        col = 0x2a2c2e;
      } else if (it.kind === 'handle') {
        g = merge([tint(new THREE.BoxGeometry(0.07, 0.03, 0.028).translate(0, 0.045, 0), 0xd8d8d0, 0.5, 0), tint(new THREE.BoxGeometry(0.014, 0.03, 0.014).translate(0, 0.015, 0), C.metal, 0.4, 0.6)]);
        g.applyQuaternion(q);
        g.translate(c.x, c.y, c.z);
        L.push(g);
        continue;
      } else if (it.kind === 'guard') {
        g = new THREE.BoxGeometry(0.036, 0.018, 0.03);
        g.translate(0, 0.009, 0);
        col = 0xb03a2a;
      } else {
        g = merge([tint(new THREE.CylinderGeometry(0.009, 0.009, 0.006, 10).translate(0, 0.003, 0), C.metal, 0.4, 0.7), tint(new THREE.CylinderGeometry(0.0025, 0.0035, 0.024, 6).translate(0, 0.014, 0).rotateX(0.35), 0xd4d4d0, 0.3, 0.7)]);
        g.applyQuaternion(q);
        g.translate(c.x, c.y, c.z);
        L.push(g);
        continue;
      }
      g.applyQuaternion(q);
      g.translate(c.x, c.y, c.z);
      L.push(tint(g, col, 0.55, 0.05));
    }
  }

  // ── Seats, observer seats ──
  L.push(...seat(-0.55, SEAT.z0 + (SEAT.z1 - SEAT.z0) / 2));
  L.push(...seat(0.55, SEAT.z0 + (SEAT.z1 - SEAT.z0) / 2));
  for (const j of JUMP_SEATS) L.push(...seat(j.x, j.z - 0.12, 0.85));

  // ── Aft bulkhead: door frame, circuit breakers, coat hooks; dome light; rudder pedal wells ──
  L.push(tint(box(0.8, 1.9, 0.04, V(-0.1, FLOOR_Y + 0.95, AFT_Z - 0.03)), 0x8d8f8a, 0.8));
  L.push(tint(box(0.06, 1.9, 0.06, V(-0.52, FLOOR_Y + 0.95, AFT_Z - 0.04)), C.frame, 0.6));
  L.push(tint(box(0.06, 1.9, 0.06, V(0.32, FLOOR_Y + 0.95, AFT_Z - 0.04)), C.frame, 0.6));
  L.push(tint(box(0.04, 0.03, 0.14, V(0.24, FLOOR_Y + 1.02, AFT_Z - 0.1)), C.metal, 0.4, 0.8));
  F.push(quadUV(V(0.5, -0.5, AFT_Z - 0.01), V(1.0, -0.5, AFT_Z - 0.01), V(1.0, -0.28, AFT_Z - 0.01), V(0.5, -0.28, AFT_Z - 0.01), ATLAS.cb));
  L.push(tint(new THREE.CylinderGeometry(0.07, 0.07, 0.015, 16).translate(0, CEILING_Y - 0.008, 0.75), 0xdedcd4, 0.5));
  for (const s of [-1, 1]) L.push(tint(box(0.36, 0.3, 0.02, V(s * 0.55, PEDALS.y - 0.05, PEDALS.z - 0.2), -0.6, 0, 0), C.dark, 0.9));

  return {
    lining: merge(L),
    faces: mergeFaces(F),
    glass: mergeFaces(glass.map((g) => {
      if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
      return g;
    })),
    screens,
    standby,
    gearLeverPos: pp(GEAR_LEVER.px, GEAR_LEVER.py, 0.008),
    panelQuat: new THREE.Quaternion().setFromUnitVectors(V(0, 0, 1), V(PANEL_NORMAL.x, PANEL_NORMAL.y, PANEL_NORMAL.z)),
  };
}

/** Merge position/normal/uv-only geometries. */
function mergeFaces(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const clean = list.map((g) => {
    const ng = g.index ? g.toNonIndexed() : g;
    for (const k of Object.keys(ng.attributes)) if (!['position', 'normal', 'uv'].includes(k)) ng.deleteAttribute(k);
    return ng;
  });
  const n = clean.reduce((s, g) => s + g.getAttribute('position').count, 0);
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  let o = 0;
  for (const g of clean) {
    const c = g.getAttribute('position').count;
    pos.set(g.getAttribute('position').array as Float32Array, o * 3);
    nor.set(g.getAttribute('normal').array as Float32Array, o * 3);
    uv.set(g.getAttribute('uv').array as Float32Array, o * 2);
    o += c;
  }
  for (const g of list) g.dispose();
  for (const g of clean) g.dispose();
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return out;
}
