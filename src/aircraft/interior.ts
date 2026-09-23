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
  // Shoulder harness draped over the back (top outboard → bottom inboard, on the fabric), then
  // down to the buckle on the inboard side of the cushion; the lap belt across the cushion.
  const onBack = (x: number, y: number) => V(x, y, -0.066).applyMatrix4(back);
  const top = onBack(s.outboard * 0.15, s.backHeight / 2 - 0.09);
  const low = onBack(-s.outboard * 0.1, -s.backHeight / 2 + 0.1);
  const buckle = V(s.x - s.outboard * 0.12, s.cushionY + 0.082, s.cushionZ + 0.2);
  const lapOut = V(s.x + s.outboard * 0.19, s.cushionY + 0.08, s.cushionZ + 0.19);
  const n = V(0, 0, -1).transformDirection(back);
  out.push(tint(strap(top, low, 0.045, n), C.webbing, 0.9, 0));
  out.push(tint(strap(low, buckle, 0.045, V(0, 1, -0.6)), C.webbing, 0.9, 0));
  out.push(tint(strap(lapOut, buckle, 0.045, V(0, 1, 0)), C.webbing, 0.9, 0));
  out.push(tint(box(0.05, 0.012, 0.035, at(buckle.x, buckle.y + 0.004, buckle.z)), C.buckle, 0.3, 0.9));
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
  // Door map pockets.
  for (const side of [-1, 1]) {
    fuselageSection(-0.3, _sec);
    out.push(tint(rbox(0.03, 0.14, 0.42, 0.01, at(side * (_sec.halfWidth - 0.075), -0.08, -0.36)), 0x4a453f, 0.9, 0));
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
