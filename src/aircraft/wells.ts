/**
 * Gear well liners: the recessed tubs behind the belly openings (the livery cuts
 * the skin there with alpha; see `wellCutDistance`). Each tub hangs from a rim
 * that follows the belly just inside the skin up to a roof: the main wheel
 * wells (roof parallel to the stowed wheel), the leg slots running forward to
 * the pivots (roof just above the stowed leg), and the nose well under the
 * clamshell doors, with ribs, a snubber pad and the brace bracket.
 *
 * Shading is baked per vertex: primer grey at the rim darkening with depth (a
 * cheap ambient-occlusion stand-in), so the wells read as lit recesses, not
 * black slabs. Everything is one mesh on the shared `parts` material, drawn
 * double-sided (from inside the cabin the tubs are the floor humps).
 */
import * as THREE from 'three';
import { loftGeometry } from './loft';
import { merge, tint } from './materials';
import { MAIN_GEAR, NOSE_GEAR, WELL, bellyY } from './gearKinematics';

const RIM_IN = 0.002;
const PRIMER = new THREE.Color(0xb9bdb4);
const DEEP = new THREE.Color(0x646a66);

/** Recolour a tub by depth above the belly (0 at the rim → dark at the roof). */
function shadeByDepth(g: THREE.BufferGeometry, full: number): THREE.BufferGeometry {
  const p = g.getAttribute('position');
  const col = g.getAttribute('color') as THREE.BufferAttribute;
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const depth = p.getY(i) - bellyY(p.getX(i), p.getZ(i));
    const t = Math.min(1, Math.max(0, depth / full));
    c.copy(PRIMER).lerp(DEEP, Math.pow(t, 0.7));
    col.setXYZ(i, c.r, c.g, c.b);
  }
  col.needsUpdate = true;
  return g;
}

/** Stowed-wheel roof plane of the right main well: y at (x, z). */
function mainRoofY(x: number, z: number): number {
  const C = MAIN_GEAR.wheelStowed;
  const a = MAIN_GEAR.axleStowed;
  // Plane through C − a·h (h above the wheel centre, on the leg side), normal a.
  const h = 0.155;
  return C.y + (-h - (x - C.x) * a.x - (z - C.z) * a.z) / a.y;
}

/** Stowed leg centreline height at plan station z (right side). */
function legY(z: number): number {
  const P = MAIN_GEAR.pivot;
  const F = MAIN_GEAR.footStowed;
  const t = (z - P.z) / (F.z - P.z);
  return P.y + (F.y - P.y) * Math.min(1, Math.max(0, t));
}

function mainWell(side: -1 | 1, quality: 'high' | 'low'): THREE.BufferGeometry[] {
  const m = WELL.main;
  const out: THREE.BufferGeometry[] = [];
  const r = m.r + 0.006;
  const n = quality === 'high' ? 56 : 32;
  // Slot direction in plan (from the slot start toward the wheel centre).
  const sx = m.cx - m.slotX0;
  const sz = m.cz - m.slotZ0;
  const sl = Math.hypot(sx, sz);
  const ux = sx / sl;
  const uz = sz / sl;
  const slotHalf = m.slotHalfWidth + 0.006;
  const slotRoof = (z: number) => legY(z) + 0.036 + 0.018;

  // Wheel tub: wall rings (rim → roof) and a roof cap; where the slot enters, the wall starts at the slot roof.
  const bottom: number[] = [];
  const mid: number[] = [];
  const top: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const x = m.cx + Math.cos(a) * r;
    const z = m.cz + Math.sin(a) * r;
    // Plan distance across the slot centreline and whether this point faces the slot.
    const across = Math.abs((x - m.slotX0) * uz - (z - m.slotZ0) * ux);
    const along = (x - m.cx) * -ux + (z - m.cz) * -uz;
    const inSlot = across < slotHalf && along > 0;
    const yb = inSlot ? Math.min(mainRoofY(x, z), slotRoof(z)) : bellyY(x, z) + RIM_IN;
    const yt = mainRoofY(x, z);
    bottom.push(side * x, yb, z);
    mid.push(side * x, yb + (yt - yb) * 0.5, z);
    top.push(side * x, yt, z);
  }
  out.push(tint(loftGeometry([bottom, mid, top], { capEnd: true }), 0xffffff, 0.85, 0));

  // Leg slot trough: from a rounded front pocket at the pivot (the extended leg exits there) to the wheel well.
  const ringPts = 7;
  const rings: number[][] = [];
  const front = slotHalf + 0.012;
  const endAlong = sl - Math.sqrt(Math.max(0, r * r - slotHalf * slotHalf)) + 0.01;
  const stations: number[] = [];
  for (let k = 0; k <= 6; k++) stations.push(-front + (front * k) / 6);
  for (let k = 1; k <= 10; k++) stations.push((endAlong * k) / 10);
  for (const s of stations) {
    const w = s < 0 ? Math.sqrt(Math.max(1e-6, front * front - s * s)) * (slotHalf / front) : slotHalf;
    const cx = m.slotX0 + ux * s;
    const cz = m.slotZ0 + uz * s;
    const ring: number[] = [];
    for (let j = 0; j < ringPts; j++) {
      // j: 0 rim(left) · 1 wall · 2..4 roof · 5 wall · 6 rim(right)
      const f = [-1, -1, -0.6, 0, 0.6, 1, 1][j];
      const x = cx + uz * w * f;
      const z = cz - ux * w * f;
      const rim = bellyY(x, z) + RIM_IN;
      const roof = Math.max(rim + 0.03, slotRoof(z));
      const y = j === 0 || j === 6 ? rim : roof - (j === 1 || j === 5 ? 0.012 : 0);
      ring.push(side * x, y, z);
    }
    rings.push(ring);
  }
  out.push(tint(loftGeometry(rings, { closed: false }), 0xffffff, 0.85, 0));

  // Structure: two ribs across the roof, a rubber snubber pad where the tyre stops, a stringer along the slot roof.
  const C = MAIN_GEAR.wheelStowed;
  for (const dz of [-0.09, 0.09]) {
    const z = C.z + dz;
    const x0 = C.x - 0.17;
    const x1 = C.x + 0.17;
    const a = new THREE.Vector3(side * x0, mainRoofY(x0, z) - 0.012, z);
    const b = new THREE.Vector3(side * x1, mainRoofY(x1, z) - 0.012, z);
    const rib = new THREE.BoxGeometry(a.distanceTo(b), 0.024, 0.018);
    rib.rotateZ(Math.atan2(b.y - a.y, b.x - a.x));
    rib.translate((a.x + b.x) / 2, (a.y + b.y) / 2, z);
    out.push(tint(rib, 0xffffff, 0.8, 0.1));
  }
  const pad = new THREE.CylinderGeometry(0.05, 0.05, 0.02, 16);
  pad.translate(side * C.x, mainRoofY(C.x, C.z) - 0.01, C.z + 0.03);
  out.push(tint(pad, 0x151516, 0.9, 0));
  return out;
}

function noseWell(): THREE.BufferGeometry[] {
  const w = WELL.nose;
  const hw = w.halfWidth + 0.006;
  const z0 = w.z0 - 0.006;
  const z1 = w.z1 + 0.006;
  const roof = w.roofY;
  const rc = 0.03;
  // Rounded-rectangle outline in plan.
  const outline: Array<[number, number]> = [];
  const corners: Array<[number, number, number]> = [
    [hw - rc, z1 - rc, 0],
    [-hw + rc, z1 - rc, Math.PI / 2],
    [-hw + rc, z0 + rc, Math.PI],
    [hw - rc, z0 + rc, (3 * Math.PI) / 2],
  ];
  for (let i = 0; i < 4; i++) {
    const [cx, cz, a0] = corners[i];
    for (let k = 0; k <= 4; k++) {
      const a = a0 + (k / 4) * (Math.PI / 2);
      outline.push([cx + Math.cos(a) * rc, cz + Math.sin(a) * rc]);
    }
    // Densify the straight side to the next corner so the rim follows the belly curve.
    const [nx0, nz0, na] = corners[(i + 1) % 4];
    const ex = cx + Math.cos(a0 + Math.PI / 2) * rc;
    const ez = cz + Math.sin(a0 + Math.PI / 2) * rc;
    const nx = nx0 + Math.cos(na) * rc;
    const nz = nz0 + Math.sin(na) * rc;
    const steps = Math.max(1, Math.round(Math.hypot(nx - ex, nz - ez) / 0.05));
    for (let k = 1; k < steps; k++) outline.push([ex + ((nx - ex) * k) / steps, ez + ((nz - ez) * k) / steps]);
  }
  const bottom: number[] = [];
  const mid: number[] = [];
  const top: number[] = [];
  for (const [x, z] of outline) {
    const yb = bellyY(x, z) + RIM_IN;
    bottom.push(x, yb, z);
    mid.push(x, (yb + roof) / 2, z);
    top.push(x, roof, z);
  }
  const out = [tint(loftGeometry([bottom, mid, top], { capEnd: true }), 0xffffff, 0.85, 0)];
  // Ribs across the roof, brace bracket down to the drag-brace anchor.
  for (const z of [-1.18, -0.95, -0.7, -0.5]) out.push(tint(new THREE.BoxGeometry(hw * 2 - 0.01, 0.02, 0.016).translate(0, roof - 0.01, z), 0xffffff, 0.8, 0.1));
  const A = NOSE_GEAR.braceAnchor;
  out.push(tint(new THREE.BoxGeometry(0.05, roof - A.y + 0.01, 0.03).translate(0, (roof + A.y) / 2, A.z), 0xffffff, 0.6, 0.5));
  out.push(tint(new THREE.CylinderGeometry(0.012, 0.012, 0.07, 8).rotateZ(Math.PI / 2).translate(0, A.y, A.z), 0x8c8e90, 0.4, 0.8));
  return out;
}

export function buildWells(quality: 'high' | 'low'): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1] as const) parts.push(...mainWell(side, quality));
  parts.push(...noseWell());
  // Depth shading (the ribs/pads keep their own tint only where they are not near-white).
  for (const g of parts) {
    const col = g.getAttribute('color');
    const white = col.getX(0) > 0.99 && col.getY(0) > 0.99;
    if (white) shadeByDepth(g, 0.16);
  }
  const g = merge(parts);
  g.computeBoundingSphere();
  return g;
}

