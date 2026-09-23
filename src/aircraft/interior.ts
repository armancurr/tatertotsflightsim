/**
 * Cabin interior details (all static, all vertex-tinted for the merged furniture mesh): pleated
 * front seats with vinyl bolsters and belts, the wet compass on the windshield frame, fuel
 * selector between the seats, circuit breakers and rocker switches on the lower panel, placards,
 * fresh-air vents, dome light, overhead strip and door pockets; plus the stowed sun visors
 * (their own smoky translucent mesh, cockpit view only).
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { tint } from './materials';
import { PANEL, PANEL_BOTTOM_Y } from './panel';
import { fuselageSection, type SectionParams } from './shape';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

function box(w: number, h: number, d: number, m?: THREE.Matrix4): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (m) g.applyMatrix4(m);
  return g;
}
function rbox(w: number, h: number, d: number, r: number, m?: THREE.Matrix4): THREE.BufferGeometry {
  const g = new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4));
  if (m) g.applyMatrix4(m);
  return g;
}
function cyl(r: number, h: number, segs: number, m?: THREE.Matrix4): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, h, segs);
  if (m) g.applyMatrix4(m);
  return g;
}
/** Placement matrix: translate then (optionally) rotate by Euler angles. */
function at(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.Matrix4 {
  return new THREE.Matrix4().compose(V(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), V(1, 1, 1));
}
/** A flat strap (webbing) from a to b, `w` wide, lying with its face normal roughly along `n`. */
function strap(a: THREE.Vector3, b: THREE.Vector3, w: number, n: THREE.Vector3): THREE.BufferGeometry {
  const d = b.clone().sub(a);
  const len = d.length();
  const yAxis = d.clone().normalize();
  const zAxis = n.clone().sub(yAxis.clone().multiplyScalar(n.dot(yAxis))).normalize();
  const xAxis = new THREE.Vector3().crossVectors(yAxis, zAxis);
  const m = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis).setPosition(a.clone().add(b).multiplyScalar(0.5));
  return box(w, len, 0.003, m);
}

const _sec: SectionParams = { top: 0, bottom: 0, halfWidth: 0, widthY: 0, nTop: 2, nBot: 2 };
function innerRoofY(z: number): number {
  fuselageSection(z, _sec);
  return _sec.top - 0.035;
}

export const INTERIOR_COLORS = {
  fabric: 0x4b5568,
  fabricDark: 0x3a4354,
  vinyl: 0x262a31,
  webbing: 0x8c8474,
  buckle: 0xb9bcc0,
  black: 0x141415,
  chrome: 0xc9cbcd,
  placard: 0xd9d6cc,
  placardInk: 0x2a2a2a,
  red: 0xb01c1c,
} as const;

export interface SeatSpec {
  x: number;
  cushionY: number;
  cushionZ: number;
  backY: number;
  backZ: number;
  backHeight: number;
  reclineRad: number;
  /** +1 = belts come from the right-hand (outboard for the right seat) side. */
  outboard: -1 | 1;
}

/** A 1980s Cessna front seat: vinyl frame, pleated fabric inserts, rolled top, rails, belts. */
export function seat(s: SeatSpec): THREE.BufferGeometry[] {
  const C = INTERIOR_COLORS;
  const out: THREE.BufferGeometry[] = [];
  // Cushion: vinyl base, fabric pleats along z, side bolsters.
  out.push(tint(rbox(0.4, 0.1, 0.5, 0.035, at(s.x, s.cushionY - 0.01, s.cushionZ)), C.vinyl, 0.75, 0));
  for (const dx of [-0.105, -0.035, 0.035, 0.105]) {
    out.push(tint(rbox(0.068, 0.04, 0.44, 0.016, at(s.x + dx, s.cushionY + 0.055, s.cushionZ + 0.01)), C.fabric, 0.97, 0));
  }
  for (const side of [-1, 1]) out.push(tint(rbox(0.055, 0.07, 0.48, 0.02, at(s.x + side * 0.175, s.cushionY + 0.05, s.cushionZ)), C.vinyl, 0.7, 0));
  // Back (reclined about its centre): shell, pleats on the front face, rolled top.
  const back = at(s.x, s.backY, s.backZ, s.reclineRad);
  const local = (x: number, y: number, z: number, g: THREE.BufferGeometry) => g.applyMatrix4(at(x, y, z)).applyMatrix4(back);
  out.push(tint(local(0, 0, 0, rbox(0.42, s.backHeight, 0.08, 0.035)), C.vinyl, 0.75, 0));
  for (const dx of [-0.105, -0.035, 0.035, 0.105]) out.push(tint(local(dx, -0.02, -0.045, rbox(0.068, s.backHeight - 0.16, 0.035, 0.016)), C.fabric, 0.97, 0));
  out.push(tint(local(0, s.backHeight / 2 - 0.035, -0.02, rbox(0.42, 0.075, 0.1, 0.035)), C.fabricDark, 0.9, 0));
  // Belts: grey webbing. The shoulder harness comes down from its anchor on the cabin wall above
  // and behind the door, over the outboard shoulder of the seat back, across the back to the
  // inboard hip; the two lap-belt halves lie across the cushion to the buckle.
  const onBack = (x: number, y: number) => V(x, y, -0.064).applyMatrix4(back);
  const anchor = V(s.x + s.outboard * 0.19, 0.84, s.backZ + 0.2);
  const shoulder = onBack(s.outboard * 0.13, s.backHeight / 2 + 0.01);
  const mid = onBack(0, -0.02);
  const hip = onBack(-s.outboard * 0.13, -s.backHeight / 2 + 0.1);
  const buckle = V(s.x - s.outboard * 0.11, s.cushionY + 0.08, s.cushionZ + 0.12);
  const lapOut = V(s.x + s.outboard * 0.2, s.cushionY + 0.075, s.cushionZ + 0.14);
  const lapIn = V(s.x - s.outboard * 0.2, s.cushionY + 0.06, s.cushionZ + 0.16);
  const n = V(0, 0, -1).transformDirection(back);
  const web = 0x5b5a57;
  out.push(tint(strap(anchor, shoulder, 0.04, V(-s.outboard, 0, -0.3)), web, 0.9, 0));
  out.push(tint(strap(shoulder, mid, 0.04, n), web, 0.9, 0));
  out.push(tint(strap(mid, hip, 0.04, n), web, 0.9, 0));
  out.push(tint(strap(lapOut, buckle, 0.04, V(0, 1, 0)), web, 0.9, 0));
  out.push(tint(strap(lapIn, buckle, 0.04, V(0, 1, 0)), web, 0.9, 0));
  out.push(tint(box(0.045, 0.01, 0.03, at(buckle.x, buckle.y + 0.004, buckle.z)), C.buckle, 0.3, 0.9));
  // Inertia-reel anchor fitting on the wall.
  out.push(tint(rbox(0.03, 0.05, 0.04, 0.008, at(anchor.x, anchor.y + 0.02, anchor.z)), 0x2a2b2d, 0.6, 0.3));
  return out;
}

/** Wet compass on a short bracket under the windshield's top frame, card window facing aft. */
export function compass(): THREE.BufferGeometry[] {
  const C = INTERIOR_COLORS;
  const z = -0.585;
  const y = innerRoofY(-0.56) - 0.06;
  const face = z + 0.033;
  const out = [
    tint(rbox(0.07, 0.055, 0.065, 0.012, at(0, y, z)), C.black, 0.45, 0),
    tint(cyl(0.006, 0.05, 8, at(0, y + 0.045, z + 0.01)), C.black, 0.5, 0.2),
    tint(box(0.05, 0.012, 0.03, at(0, y + 0.066, z + 0.018)), C.black, 0.5, 0.2),
    // Card window: cream card, heading marks, red lubber line; correction card underneath.
    tint(box(0.048, 0.026, 0.002, at(0, y + 0.004, face)), 0xe9dfc2, 0.35, 0),
    tint(box(0.002, 0.026, 0.002, at(0, y + 0.004, face + 0.0015)), 0xc01818, 0.4, 0),
    tint(box(0.04, 0.012, 0.002, at(0, y - 0.022, face - 0.004)), 0xf2f0ea, 0.5, 0),
  ];
  for (let i = -3; i <= 3; i++) {
    if (i === 0) continue;
    out.push(tint(box(0.0014, i % 2 === 0 ? 0.01 : 0.006, 0.001, at(i * 0.0065, y + 0.008, face + 0.0012)), 0x202020, 0.5, 0));
  }
  return out;
}

/** Fuel selector on the floor between the seats: red/white placard ring and a pointer handle (BOTH). */
export function fuelSelector(z = -0.22, floorY = -0.41): THREE.BufferGeometry[] {
  const C = INTERIOR_COLORS;
  const out = [
    tint(cyl(0.075, 0.006, 32, at(0, floorY + 0.004, z)), C.red, 0.5, 0),
    tint(cyl(0.06, 0.008, 32, at(0, floorY + 0.006, z)), 0xeeeae0, 0.45, 0),
    tint(cyl(0.02, 0.02, 16, at(0, floorY + 0.018, z)), C.black, 0.5, 0.1),
    tint(rbox(0.13, 0.022, 0.032, 0.01, at(0, floorY + 0.03, z)), C.red, 0.5, 0),
    tint(box(0.03, 0.023, 0.033, at(0, floorY + 0.03, z - 0.0)), 0xf4f1ea, 0.5, 0),
  ];
  // Position labels: four short dark bars round the ring (LEFT, BOTH, RIGHT, OFF).
  for (const [dx, dz] of [[-0.045, 0], [0, -0.045], [0.045, 0], [0, 0.045]] as const) {
    out.push(tint(box(Math.abs(dz) > 0 ? 0.03 : 0.008, 0.002, Math.abs(dz) > 0 ? 0.008 : 0.03, at(dx, floorY + 0.0105, z + dz)), 0x222222, 0.6, 0));
  }
  return out;
}

/** Lower panel skirt (angled toward the pilot's knees) frame, and what sits on it. */
export function lowerPanel(): THREE.BufferGeometry[] {
  const C = INTERIOR_COLORS;
  const tilt = 0.5;
  const centre = V(0, PANEL_BOTTOM_Y - 0.09, PANEL.z - 0.07);
  const frame = at(centre.x, centre.y, centre.z, tilt);
  const on = (u: number, v: number, h: number, g: THREE.BufferGeometry) => g.applyMatrix4(at(u, v, 0.006 + h / 2)).applyMatrix4(frame);
  const out: THREE.BufferGeometry[] = [];
  // Circuit breakers: two rows on the right, black push-pull buttons with white collars and labels.
  for (let row = 0; row < 2; row++) {
    for (let i = 0; i < 10; i++) {
      const u = 0.17 + i * 0.027;
      const v = 0.04 - row * 0.042;
      const collar = cyl(0.0085, 0.004, 14);
      collar.rotateX(Math.PI / 2);
      out.push(tint(on(u, v, 0.004, collar), 0xd8d8d2, 0.4, 0.3));
      const btn = cyl(0.0062, 0.012, 12);
      btn.rotateX(Math.PI / 2);
      out.push(tint(on(u, v, 0.012, btn), C.black, 0.5, 0));
      out.push(tint(on(u, v - 0.016, 0.001, box(0.016, 0.005, 0.001)), 0xe8e6de, 0.6, 0));
    }
  }
  // Rocker switches on the left: red split master (BAT/ALT), then black avionics/lights rockers.
  for (let i = 0; i < 2; i++) out.push(tint(on(-0.44 + i * 0.017, 0.02, 0.012, rbox(0.015, 0.03, 0.012, 0.003)), C.red, 0.45, 0));
  for (let i = 0; i < 6; i++) {
    const u = -0.39 + i * 0.024;
    out.push(tint(on(u, 0.02, 0.012, rbox(0.016, 0.03, 0.012, 0.003)), C.black, 0.5, 0));
    out.push(tint(on(u, 0.028, 0.0125, box(0.012, 0.01, 0.001)), 0xeeeeea, 0.5, 0));
    out.push(tint(on(u, -0.004, 0.001, box(0.018, 0.005, 0.001)), 0xe8e6de, 0.6, 0));
  }
  // Magneto/start key switch.
  const key = cyl(0.017, 0.012, 20);
  key.rotateX(Math.PI / 2);
  out.push(tint(on(-0.2, 0.015, 0.012, key), C.chrome, 0.25, 0.9));
  out.push(tint(on(-0.2, 0.015, 0.02, box(0.006, 0.022, 0.006)), C.black, 0.5, 0));
  // Placards: "NO SMOKING" and the operating-limitations plate (plates with lines of print).
  for (const [u, v, w, lines] of [
    [0.02, 0.03, 0.07, 1],
    [-0.07, -0.02, 0.16, 4],
  ] as const) {
    out.push(tint(on(u, v, 0.001, box(w, 0.012 + lines * 0.007, 0.001)), C.placard, 0.4, 0.3));
    for (let l = 0; l < lines; l++) {
      out.push(tint(on(u, v + (lines - 1) * 0.0035 - l * 0.007, 0.0016, box(w * (l === lines - 1 ? 0.6 : 0.85), 0.0022, 0.0008)), C.placardInk, 0.6, 0));
    }
  }
  return out;
}

/** Headliner furniture: overhead strip, dome light, eyeball vents at the upper door-post corners, door pockets. */
export function headliner(): THREE.BufferGeometry[] {
  const C = INTERIOR_COLORS;
  const out: THREE.BufferGeometry[] = [];
  // Overhead console strip along the roof centre (speaker grille + dome light).
  for (let z = -0.42; z < 0.3; z += 0.08) out.push(tint(box(0.13, 0.008, 0.078, at(0, innerRoofY(z) - 0.004, z + 0.04)), 0x5d5850, 0.8, 0));
  out.push(tint(rbox(0.08, 0.012, 0.06, 0.005, at(0, innerRoofY(0.12) - 0.012, 0.12)), 0xf0eee6, 0.3, 0));
  for (let i = 0; i < 5; i++) out.push(tint(box(0.09, 0.003, 0.004, at(0, innerRoofY(-0.2) - 0.009, -0.24 + i * 0.012)), 0x2a2826, 0.7, 0));
  // Fresh-air vents in the upper corners, just behind the windshield.
  for (const side of [-1, 1]) {
    fuselageSection(-0.42, _sec);
    const x = side * (_sec.halfWidth - 0.13);
    const y = innerRoofY(-0.42) - 0.07;
    const ring = cyl(0.028, 0.02, 18, at(x, y, -0.42, 0, 0, side * 0.9));
    out.push(tint(ring, 0x3a3834, 0.6, 0.1));
    const ball = new THREE.SphereGeometry(0.02, 14, 10);
    ball.applyMatrix4(at(x - side * 0.008, y - 0.006, -0.42));
    out.push(tint(ball, 0x77746c, 0.5, 0.3));
  }
  return out;
}

/** Stowed sun visors: thin smoky panels hinged under the headliner, tipped 10° down. */
export function sunVisors(): THREE.BufferGeometry {
  const parts = [-0.27, 0.27].map((x) => {
    const hz = -0.47;
    const g = new RoundedBoxGeometry(0.34, 0.004, 0.17, 2, 0.0019);
    g.deleteAttribute('uv');
    g.translate(0, 0, -0.085);
    g.rotateX(0.17);
    g.translate(x, innerRoofY(hz) - 0.02, hz);
    return g;
  });
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!merged) throw new Error('aircraft: sun visor merge failed');
  return merged;
}

/** Visor hinge rods and clips (tinted, for the furniture mesh). */
export function visorHinges(): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  for (const x of [-0.27, 0.27]) {
    const hz = -0.47;
    const hy = innerRoofY(hz) - 0.02;
    const rod = cyl(0.005, 0.3, 8, at(x, hy + 0.003, hz, 0, 0, Math.PI / 2));
    out.push(tint(rod, 0x5a5650, 0.5, 0.4));
    out.push(tint(box(0.02, 0.02, 0.02, at(x + 0.16, hy + 0.01, hz)), 0x3a3834, 0.6, 0));
  }
  return out;
}

/**
 * Inner cabin wall at height y, station z: |x| of the shell surface `inset` metres inside the skin
 * (upper and lower halves of the section), and the inward normal's x/y (right side).
 */
export function wallPoint(y: number, z: number, inset: number, out: { x: number; nx: number; ny: number }) {
  fuselageSection(z, _sec);
  const upper = y >= _sec.widthY;
  const n = upper ? _sec.nTop : _sec.nBot;
  const W = _sec.halfWidth - inset;
  const H = Math.max(0.05, upper ? _sec.top - inset - _sec.widthY : _sec.widthY - (_sec.bottom + inset));
  const v = Math.min(0.999, Math.abs(y - _sec.widthY) / H);
  const u = Math.pow(1 - Math.pow(v, n), 1 / n);
  out.x = W * u;
  const gx = Math.pow(Math.max(u, 1e-6), n - 1) / W;
  const gy = (upper ? 1 : -1) * (Math.pow(Math.max(v, 1e-6), n - 1) / H);
  const l = Math.hypot(gx, gy) || 1;
  out.nx = -gx / l;
  out.ny = -gy / l;
  return out;
}

/** A panel following the cabin wall over (z0..z1) × (y0..y1), `proud` metres off the shell, with a rounded rim. */
function wallPanel(side: -1 | 1, z0: number, z1: number, y0: number, y1: number, proud: number, rim = 0.012): THREE.BufferGeometry {
  const w = { x: 0, nx: 0, ny: 0 };
  const nz = 14;
  const ny = 8;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= ny; j++) {
    const y = y0 + ((y1 - y0) * j) / ny;
    for (let i = 0; i <= nz; i++) {
      const z = z0 + ((z1 - z0) * i) / nz;
      // Rounded rim: the panel face comes out of the wall over `rim` at every edge.
      const e = Math.min(z - z0, z1 - z, y - y0, y1 - y) / rim;
      const d = 0.002 + proud * Math.sqrt(Math.max(0, Math.min(1, e)) * (2 - Math.min(1, e)));
      wallPoint(y, z, 0.035, w);
      pos.push(side * (w.x + w.nx * d), y + w.ny * d, z);
    }
  }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nz; i++) {
      const a = j * (nz + 1) + i;
      const b = a + 1;
      const c = a + nz + 1;
      const d = c + 1;
      // Faces toward the cabin centre for either side.
      if (side < 0) idx.push(a, c, b, b, c, d);
      else idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Door interior: moulded vinyl panel, sculpted armrest, chrome handle in its cup, map pocket; plus the kick panel ahead of the door. */
export function doorPanels(): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const w = { x: 0, nx: 0, ny: 0 };
  const onWall = (side: -1 | 1, y: number, z: number, proud: number) => {
    wallPoint(y, z, 0.035, w);
    return V(side * (w.x + w.nx * proud), y + w.ny * proud, z);
  };
  for (const side of [-1, 1] as const) {
    // Door panel (the door's lower half, under the window) and its upper trim strip under the window.
    out.push(tint(wallPanel(side, -0.9, 0.29, -0.3, 0.3, 0.012), 0x55565a, 0.85, 0));
    out.push(tint(wallPanel(side, -0.72, 0.29, 0.305, 0.345, 0.018, 0.008), 0x46474a, 0.6, 0));
    // Armrest: a sculpted bar along the door at elbow height, sloping up toward the front (the door pull).
    const ar = onWall(side, 0.075, -0.22, 0.036);
    out.push(tint(rbox(0.065, 0.055, 0.62, 0.024, at(ar.x, ar.y, ar.z, 0.04, 0, 0)), 0x3e3f42, 0.75, 0));
    out.push(tint(rbox(0.05, 0.012, 0.56, 0.005, at(ar.x - side * 0.004, ar.y + 0.028, ar.z, 0.04, 0, 0)), 0x4a4b4e, 0.55, 0));
    // Door pull cup and the chrome handle (lever) ahead of the armrest, under the window.
    const h = onWall(side, 0.21, -0.62, 0.012);
    out.push(tint(rbox(0.014, 0.05, 0.11, 0.008, at(h.x, h.y, h.z)), 0x202124, 0.7, 0));
    out.push(tint(rbox(0.016, 0.018, 0.085, 0.006, at(h.x - side * 0.01, h.y, h.z + 0.005, 0, 0, 0)), 0xb8babc, 0.3, 0.9));
    // Map pocket along the bottom of the door.
    const m = onWall(side, -0.19, -0.35, 0.03);
    out.push(tint(rbox(0.03, 0.13, 0.5, 0.012, at(m.x, m.y, m.z)), 0x404144, 0.9, 0));
    out.push(tint(box(0.006, 0.006, 0.47, at(m.x - side * 0.016, m.y + 0.06, m.z)), 0x1c1c1d, 0.9, 0));
    // Kick panel ahead of the door, under the panel (fresh-air outlet grille).
    out.push(tint(wallPanel(side, -1.18, -0.93, -0.28, 0.2, 0.006), 0x424346, 0.85, 0));
    const v = onWall(side, 0.02, -1.06, 0.012);
    for (let k = 0; k < 4; k++) out.push(tint(box(0.01, 0.006, 0.09, at(v.x, v.y + k * 0.014, v.z)), 0x1a1a1b, 0.8, 0));
  }
  return out;
}
