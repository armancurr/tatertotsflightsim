/**
 * The airport's static structures as ONE merged mesh (building material, per-
 * vertex material id): control tower, hangars (gabled steel and arched), the
 * FBO/terminal, the fuel installation, windsock mast and segmented circle,
 * light fixtures, PAPI boxes, approach-light stands and the fence posts/rails.
 * Plus the chain-link fabric as its own (alpha) geometry.
 *
 * Local building frame (MeshBuilder.pushTR with rotY = −heading): −Z = the
 * front the spot faces, +X = right of the front, y = metres above the ground
 * at the building centre.
 */
import * as THREE from 'three';
import { MeshBuilder, type V2, type V3 } from './builder';
import { MAT } from './materials';
import { toWorld, type AirportPlan, type HangarPlan } from './plan';
import type { BuildingSpot } from '../layout';
import type { LightDef } from './lights';
import { WINDSOCK_MAST } from './windsock';
import type { HeightFn } from './ground';
import { fireStation, flightSchool, fuelFarm, glideslope, localizerArray, tHangarRow, vorStation } from './facilities';
import { fromRunwayCoords } from '../runway';

const DEG = Math.PI / 180;
const rotOf = (headingDeg: number) => -headingDeg * DEG;

/** Octagon (flat side toward −Z) of circumradius r at height y. */
function octagon(r: number, y: number): V3[] {
  const out: V3[] = [];
  for (let k = 0; k < 8; k++) {
    const a = (22.5 + k * 45) * DEG;
    out.push([r * Math.sin(a), y, -r * Math.cos(a)]);
  }
  return out;
}

/** Vertical prism between two octagon rings (with top and bottom caps). */
function octPrism(b: MeshBuilder, r0: number, r1: number, y0: number, y1: number, caps = true) {
  const lo = octagon(r0, y0);
  const hi = octagon(r1, y1);
  for (let k = 0; k < 8; k++) {
    const k1 = (k + 1) % 8;
    const mx = (lo[k][0] + lo[k1][0]) / 2;
    const mz = (lo[k][2] + lo[k1][2]) / 2;
    const l = Math.hypot(mx, mz);
    const slope = (r0 - r1) / (y1 - y0);
    const n: V3 = [mx / l, slope * 0.924, mz / l];
    const nl = Math.hypot(n[0], n[1], n[2]);
    b.poly([lo[k], lo[k1], hi[k1], hi[k]], [n[0] / nl, n[1] / nl, n[2] / nl], { wallUV: true });
  }
  if (caps) {
    b.poly(hi, [0, 1, 0], { uAxis: [1, 0, 0] });
    b.poly(lo, [0, -1, 0], { uAxis: [1, 0, 0] });
  }
}

// ─── control tower ────────────────────────────────────────────────────────────

function tower(b: MeshBuilder, t: BuildingSpot, g: number) {
  b.pushTR(t.center.x, g, t.center.z, rotOf(t.headingDeg));
  const concrete = 0xc9c4b8;
  // base block with entrance and a band of windows
  b.set({ mat: MAT.concrete, color: concrete });
  b.box(-3.5, -0.2, -3.5, 3.5, 3.4, 3.5, 'b');
  b.set({ mat: MAT.membrane, color: 0x55585a });
  b.box(-3.45, 3.4, -3.45, 3.45, 3.46, 3.45, 'b');
  b.set({ mat: MAT.paint, color: 0x6a6f73 });
  b.box(-3.6, 3.25, -3.6, 3.6, 3.55, 3.6, 'b'); // coping band
  b.set({ mat: MAT.window, color: 0xffffff });
  b.poly([[-2.6, 0.9, -3.52], [2.6, 0.9, -3.52], [2.6, 2.9, -3.52], [-2.6, 2.9, -3.52]], [0, 0, -1], { wallUV: true });
  b.poly([[3.52, 0.9, -2.6], [3.52, 0.9, 2.6], [3.52, 2.9, 2.6], [3.52, 2.9, -2.6]], [1, 0, 0], { wallUV: true });
  b.set({ mat: MAT.door, color: 0x3a4148 });
  b.poly([[-3.52, 0, -0.9], [-3.52, 0, 0.9], [-3.52, 2.3, 0.9], [-3.52, 2.3, -0.9]], [-1, 0, 0], { wallUV: true });
  // shaft
  b.set({ mat: MAT.concrete, color: concrete });
  b.box(-2.0, 3.4, -2.0, 2.0, 16.4, 2.0, 'b');
  b.set({ mat: MAT.window, color: 0xffffff });
  b.poly([[-0.55, 4.2, -2.02], [0.55, 4.2, -2.02], [0.55, 15.8, -2.02], [-0.55, 15.8, -2.02]], [0, 0, -1], { wallUV: true });
  b.poly([[2.02, 4.2, -0.5], [2.02, 4.2, 0.5], [2.02, 15.8, 0.5], [2.02, 15.8, -0.5]], [1, 0, 0], { wallUV: true });
  // equipment level under the cab
  b.set({ mat: MAT.paint, color: 0xd9d6ce });
  octPrism(b, 3.0, 3.25, 16.4, 17.35);
  // catwalk slab
  b.set({ mat: MAT.concrete, color: 0xb9b5ab });
  octPrism(b, 4.4, 4.4, 17.35, 17.6);
  // cab: dark sill, outward-leaning glass, mullions, head band
  b.set({ mat: MAT.paint, color: 0x3c4146 });
  octPrism(b, 3.25, 3.3, 17.6, 17.95, false);
  b.set({ mat: MAT.glass, color: 0x202a30 });
  octPrism(b, 3.3, 3.75, 17.95, 20.75, false);
  const lo = octagon(3.31, 17.95);
  const hi = octagon(3.76, 20.75);
  b.set({ mat: MAT.metal, color: 0x2e3236, rough: 0.5 });
  for (let k = 0; k < 8; k++) b.tube(lo[k], hi[k], 0.06, 0.06, 4);
  b.set({ mat: MAT.paint, color: 0x3c4146 });
  octPrism(b, 3.75, 3.8, 20.75, 21.0, false);
  // roof with overhang and fascia
  b.set({ mat: MAT.paint, color: 0xe2dfd8 });
  octPrism(b, 4.25, 4.25, 21.0, 21.5);
  b.set({ mat: MAT.membrane, color: 0x5a5d5f });
  octPrism(b, 4.0, 4.0, 21.5, 21.55, true);
  // catwalk railing
  b.set({ mat: MAT.metal, color: 0x8d9296, rough: 0.45 });
  const rl = octagon(4.3, 17.6);
  for (let k = 0; k < 8; k++) {
    const p = rl[k];
    const q = rl[(k + 1) % 8];
    for (let s = 0; s < 3; s++) {
      const f = s / 3;
      const x = p[0] + (q[0] - p[0]) * f;
      const z = p[2] + (q[2] - p[2]) * f;
      b.tube([x, 17.6, z], [x, 18.65, z], 0.022, 0.022, 4);
    }
    b.tube([p[0], 18.65, p[2]], [q[0], 18.65, q[2]], 0.03, 0.03, 4);
    b.tube([p[0], 18.12, p[2]], [q[0], 18.12, q[2]], 0.018, 0.018, 4);
  }
  // rooftop: beacon mast + housing, antennas, obstruction-light posts
  b.set({ mat: MAT.metal, color: 0x9ea3a6 });
  b.tube([0, 21.55, 0], [0, 24.95, 0], 0.09, 0.06, 8);
  b.set({ mat: MAT.metal, color: 0x2b2e31 });
  b.cylinder(0, 24.9, 0, 0.3, 0.08, 12);
  b.set({ mat: MAT.lamp, color: 0xcfe8d2 });
  b.cylinder(0, 24.98, 0, 0.26, 0.44, 12);
  b.set({ mat: MAT.metal, color: 0x2b2e31 });
  b.cylinder(0, 25.42, 0, 0.29, 0.1, 12);
  b.set({ mat: MAT.metal, color: 0xb0b4b6 });
  b.tube([2.6, 21.55, 2.2], [2.6, 25.0, 2.2], 0.025, 0.012, 4);
  b.tube([-2.8, 21.55, 1.9], [-2.8, 24.4, 1.9], 0.025, 0.012, 4);
  b.tube([-2.2, 21.55, -2.4], [-2.2, 23.0, -2.4], 0.04, 0.04, 6);
  b.tube([-2.2, 23.0, -2.4], [-1.6, 23.0, -2.4], 0.012, 0.012, 3);
  b.tube([-2.2, 23.0, -2.4], [-2.2, 23.0, -1.8], 0.012, 0.012, 3);
  for (const s of [-1, 1]) {
    const x = s * (t.width / 2 + 0.2);
    b.set({ mat: MAT.metal, color: 0x9ea3a6 });
    b.tube([x, 21.5, 0], [x, 22.5, 0], 0.03, 0.03, 4);
    b.set({ mat: MAT.lamp, color: 0xd02010 });
    b.cylinder(x, 22.5, 0, 0.09, 0.16, 8);
  }
  b.pop();
}

// ─── hangars ──────────────────────────────────────────────────────────────────

/** Concrete plinth along the side and back walls (the door side stays open). */
function plinth(b: MeshBuilder, w: number, d: number, h: number, proud: number) {
  b.box(-w / 2 - proud, -0.2, -d / 2 - proud, -w / 2 + 0.3, h, d / 2 + proud, 'b');
  b.box(w / 2 - 0.3, -0.2, -d / 2 - proud, w / 2 + proud, h, d / 2 + proud, 'b');
  b.box(-w / 2 + 0.3, -0.2, d / 2 - 0.3, w / 2 - 0.3, h, d / 2 + proud, 'b');
}

/** Door leaves of a bi-parting sliding door across [−dw/2, dw/2], opened by `open` (0..1). */
function doorLeaves(b: MeshBuilder, dw: number, hd: number, zFront: number, open: number, color: number) {
  const leafW = dw / 4 + 0.15;
  const slide = open * (dw / 2);
  b.set({ mat: MAT.door, color });
  for (const s of [-1, 1]) {
    // inner leaf (rear track) slides first, behind the outer one; the outer follows past half-open
    const innerShift = Math.min(slide, dw / 4);
    const outerShift = Math.max(0, slide - dw / 4);
    const innerX0 = s * (0 + innerShift);
    const outerX0 = s * (dw / 4 + outerShift);
    for (const [x0, z] of [
      [innerX0, zFront - 0.32],
      [outerX0, zFront - 0.12],
    ] as const) {
      const xa = s > 0 ? x0 - 0.08 : x0 - leafW + 0.08;
      const xb = s > 0 ? x0 + leafW - 0.08 : x0 + 0.08;
      b.box(Math.min(xa, xb), 0.02, z - 0.1, Math.max(xa, xb), hd + 0.15, z, '');
    }
  }
  // top guide beam and floor track
  b.set({ mat: MAT.metal, color: 0x4a4f53 });
  b.box(-dw / 2 - 0.9, hd + 0.15, zFront - 0.5, dw / 2 + 0.9, hd + 0.45, zFront - 0.02, '');
  b.set({ mat: MAT.dark, color: 0x111111 });
  b.box(-dw / 2 - 0.9, 0.0, zFront - 0.5, dw / 2 + 0.9, 0.03, zFront - 0.02, 'b');
}

/** Dim interior shell (inward-facing) of a hangar with an open door. */
function hangarInterior(b: MeshBuilder, w: number, d: number, he: number, hr: number) {
  const x0 = -w / 2 + 0.25, x1 = w / 2 - 0.25, z0 = -d / 2 + 0.3, z1 = d / 2 - 0.25;
  b.set({ mat: MAT.concrete, color: 0x3b3a37 });
  b.poly([[x0, 0.02, z0], [x1, 0.02, z0], [x1, 0.02, z1], [x0, 0.02, z1]], [0, 1, 0], { uAxis: [1, 0, 0] });
  b.set({ mat: MAT.paint, color: 0x2a2c2d });
  b.poly([[x0, 0, z1], [x1, 0, z1], [x1, he, z1], [x0, he, z1]], [0, 0, -1], { wallUV: true });
  b.poly([[x0, 0, z0], [x0, 0, z1], [x0, he, z1], [x0, he, z0]], [1, 0, 0], { wallUV: true });
  b.poly([[x1, 0, z0], [x1, 0, z1], [x1, he, z1], [x1, he, z0]], [-1, 0, 0], { wallUV: true });
  b.set({ mat: MAT.paint, color: 0x222426 });
  b.poly([[x0, he, z0], [0, hr, z0], [0, hr, z1], [x0, he, z1]], [0.1, -1, 0], { uAxis: [0, 0, 1] });
  b.poly([[x1, he, z0], [0, hr, z0], [0, hr, z1], [x1, he, z1]], [-0.1, -1, 0], { uAxis: [0, 0, 1] });
  // rows of lit high-bay lamps
  b.set({ mat: MAT.interiorLamp, color: 0xfff1d8 });
  for (const x of [-w / 4, w / 4])
    for (let z = z0 + 3; z < z1 - 1; z += 5) b.boxC(x, he - 0.35, z, 0.9, 0.12, 0.9, 't');
  // a work bench and a tool chest along the back wall
  b.set({ mat: MAT.paint, color: 0x5a1e1a });
  b.box(x1 - 3.2, 0, z1 - 0.9, x1 - 1.4, 1.1, z1 - 0.2, 'b');
  b.set({ mat: MAT.metal, color: 0x6d7174 });
  b.box(x0 + 1, 0, z1 - 1.0, x0 + 4.5, 0.95, z1 - 0.2, 'b');
}

function gabledHangar(b: MeshBuilder, h: HangarPlan, g: number) {
  const s = h.spot;
  const w = s.width, d = s.depth, H = s.height;
  const rise = (w / 2) * Math.tan(5.5 * DEG);
  const he = H - rise;
  const dw = w - 2.4;
  const hd = he - 1.1;
  b.pushTR(s.center.x, g, s.center.z, rotOf(s.headingDeg));
  // plinth
  b.set({ mat: MAT.concrete, color: 0xa9a59c });
  plinth(b, w, d, 0.45, 0.04);
  // walls
  b.set({ mat: MAT.corrugated, color: h.wall });
  b.poly([[-w / 2, 0.45, d / 2], [w / 2, 0.45, d / 2], [w / 2, he, d / 2], [0, H, d / 2], [-w / 2, he, d / 2]], [0, 0, 1], { wallUV: true });
  b.poly([[w / 2, 0.45, -d / 2], [w / 2, 0.45, d / 2], [w / 2, he, d / 2], [w / 2, he, -d / 2]], [1, 0, 0], { wallUV: true });
  b.poly([[-w / 2, 0.45, -d / 2], [-w / 2, 0.45, d / 2], [-w / 2, he, d / 2], [-w / 2, he, -d / 2]], [-1, 0, 0], { wallUV: true });
  // front: jambs + header gable
  b.poly([[-w / 2, 0, -d / 2], [-dw / 2, 0, -d / 2], [-dw / 2, hd, -d / 2], [-w / 2, hd, -d / 2]], [0, 0, -1], { wallUV: true });
  b.poly([[dw / 2, 0, -d / 2], [w / 2, 0, -d / 2], [w / 2, hd, -d / 2], [dw / 2, hd, -d / 2]], [0, 0, -1], { wallUV: true });
  b.poly([[-w / 2, hd, -d / 2], [w / 2, hd, -d / 2], [w / 2, he, -d / 2], [0, H, -d / 2], [-w / 2, he, -d / 2]], [0, 0, -1], { wallUV: true });
  // corner trims and eave gutters
  b.set({ mat: MAT.paint, color: 0xe6e6e2 });
  for (const x of [-w / 2, w / 2]) for (const z of [-d / 2, d / 2]) b.boxC(x, he / 2, z, 0.16, he, 0.16, 'b');
  // roof with overhangs (standing seam, seams run down the slope)
  const ov = 0.45, ovg = 0.35;
  const yEave = he - ov * Math.tan(5.5 * DEG);
  b.set({ mat: MAT.roofMetal, color: h.roofColor });
  for (const sgn of [-1, 1]) {
    const nx = sgn * Math.sin(5.5 * DEG), ny = Math.cos(5.5 * DEG);
    const pts: V3[] = [[sgn * (w / 2 + ov), yEave, -d / 2 - ovg], [0, H, -d / 2 - ovg], [0, H, d / 2 + ovg], [sgn * (w / 2 + ov), yEave, d / 2 + ovg]];
    b.poly(pts, [nx, ny, 0], { uAxis: [0, 0, 1] });
    b.set({ mat: MAT.paint, color: 0x8c9194 });
    b.poly(pts.map((p) => [p[0], p[1] - 0.12, p[2]] as V3), [0, -1, 0], { uAxis: [0, 0, 1] });
    b.set({ mat: MAT.roofMetal, color: h.roofColor });
  }
  // fascia/barge boards
  b.set({ mat: MAT.paint, color: 0xe6e6e2 });
  for (const z of [-d / 2 - ovg, d / 2 + ovg])
    for (const sgn of [-1, 1]) {
      const zz = z;
      b.poly(
        [[sgn * (w / 2 + ov), yEave - 0.25, zz], [0, H - 0.25, zz], [0, H + 0.02, zz], [sgn * (w / 2 + ov), yEave + 0.02, zz]],
        [0, 0, Math.sign(z)],
        { wallUV: true },
      );
    }
  for (const sgn of [-1, 1]) b.box(Math.min(sgn * (w / 2 + ov), sgn * (w / 2 + ov - 0.18)), yEave - 0.28, -d / 2 - ovg, Math.max(sgn * (w / 2 + ov), sgn * (w / 2 + ov - 0.18)), yEave + 0.02, d / 2 + ovg);
  // translucent wall-light strip + personnel door on the sides
  b.set({ mat: MAT.window, color: 0xffffff });
  b.poly([[w / 2 + 0.02, he - 1.6, -d / 2 + 2], [w / 2 + 0.02, he - 1.6, d / 2 - 2], [w / 2 + 0.02, he - 0.7, d / 2 - 2], [w / 2 + 0.02, he - 0.7, -d / 2 + 2]], [1, 0, 0], { wallUV: true });
  b.set({ mat: MAT.door, color: 0x5b6670 });
  b.poly([[w / 2 + 0.03, 0.02, d / 2 - 4.2], [w / 2 + 0.03, 0.02, d / 2 - 3.2], [w / 2 + 0.03, 2.15, d / 2 - 3.2], [w / 2 + 0.03, 2.15, d / 2 - 4.2]], [1, 0, 0], { wallUV: true });
  // doors
  doorLeaves(b, dw, hd, -d / 2, h.doorOpen, h.door);
  if (h.doorOpen > 0) hangarInterior(b, w, d, he, H - 0.3);
  else {
    // closed: a dark backing so gaps between leaves never show sky
    b.set({ mat: MAT.dark, color: 0x101010 });
    b.poly([[-dw / 2, 0, -d / 2 + 0.05], [dw / 2, 0, -d / 2 + 0.05], [dw / 2, hd, -d / 2 + 0.05], [-dw / 2, hd, -d / 2 + 0.05]], [0, 0, -1], { wallUV: true });
  }
  // wall lamps over the door
  b.set({ mat: MAT.lamp, color: 0xfff0d0 });
  for (const x of [-dw / 4, dw / 4]) b.boxC(x, hd + 0.75, -d / 2 - 0.25, 0.5, 0.18, 0.4);
  b.pop();
}

function archedHangar(b: MeshBuilder, h: HangarPlan, g: number) {
  const s = h.spot;
  const w = s.width, d = s.depth, H = s.height;
  const wall = 1.4;
  const sag = H - wall;
  const R = (sag * sag + (w / 2) * (w / 2)) / (2 * sag);
  const cy = H - R;
  const half = Math.asin(w / 2 / R);
  const N = 28;
  const arc: V2[] = [];
  for (let i = 0; i <= N; i++) {
    const a = -half + (2 * half * i) / N;
    arc.push([R * Math.sin(a), cy + R * Math.cos(a)]);
  }
  const arcY = (x: number) => cy + Math.sqrt(Math.max(0, R * R - x * x));
  const hd = Math.min(H * 0.64, H - 2.2);
  // widest door that keeps 1.1 m of wall under the arch
  const dw = Math.min(w - 3, 2 * Math.sqrt(Math.max(0, R * R - (hd + 1.1 - cy) ** 2)));
  b.pushTR(s.center.x, g, s.center.z, rotOf(s.headingDeg));
  b.set({ mat: MAT.concrete, color: 0xa9a59c });
  plinth(b, w, d, wall, 0.05);
  // shell: corrugations follow the arch (u = along the length)
  b.set({ mat: MAT.corrugated, color: h.roofColor });
  const z0 = -d / 2 - 0.25, z1 = d / 2 + 0.25;
  const rows: number[][] = [];
  for (const [x, y] of arc) {
    const nx = x / R, ny = (y - cy) / R;
    rows.push([b.v(x, y, z0, nx, ny, 0, z0, y), b.v(x, y, z1, nx, ny, 0, z1, y)]);
  }
  for (let i = 0; i < N; i++) b.quad(rows[i][0], rows[i + 1][0], rows[i + 1][1], rows[i][1]);
  // underside of the overhanging shell ends
  b.set({ mat: MAT.paint, color: 0x6c7073 });
  for (const [za, zb] of [[z0, -d / 2], [d / 2, z1]] as const) {
    const ids: number[][] = [];
    for (const [x, y] of arc) {
      const nx = -x / R, ny = -(y - cy) / R;
      ids.push([b.v(x, y - 0.06, za, nx, ny, 0, za, y), b.v(x, y - 0.06, zb, nx, ny, 0, zb, y)]);
    }
    for (let i = 0; i < N; i++) b.quad(ids[i][0], ids[i + 1][0], ids[i + 1][1], ids[i][1]);
  }
  // end walls (vertical corrugated cladding in the wall colour)
  b.set({ mat: MAT.corrugated, color: h.wall });
  b.poly([[-w / 2, 0, d / 2], [w / 2, 0, d / 2], ...[...arc].reverse().map(([x, y]) => [x, y, d / 2] as V3)], [0, 0, 1], { wallUV: true });
  // front: left/right pieces under the arch beside the door, and the top piece over the door
  const leftArc = arc.filter(([x]) => x < -dw / 2);
  const rightArc = arc.filter(([x]) => x > dw / 2);
  b.poly([[-w / 2, 0, -d / 2], [-dw / 2, 0, -d / 2], [-dw / 2, arcY(dw / 2), -d / 2], ...[...leftArc].reverse().map(([x, y]) => [x, y, -d / 2] as V3), [-w / 2, wall, -d / 2]], [0, 0, -1], { wallUV: true });
  b.poly([[dw / 2, 0, -d / 2], [w / 2, 0, -d / 2], [w / 2, wall, -d / 2], ...[...rightArc].reverse().map(([x, y]) => [x, y, -d / 2] as V3), [dw / 2, arcY(dw / 2), -d / 2]], [0, 0, -1], { wallUV: true });
  const topArc = arc.filter(([x]) => x >= -dw / 2 && x <= dw / 2);
  b.poly([[-dw / 2, hd, -d / 2], [dw / 2, hd, -d / 2], [dw / 2, arcY(dw / 2), -d / 2], ...[...topArc].reverse().map(([x, y]) => [x, y, -d / 2] as V3), [-dw / 2, arcY(dw / 2), -d / 2]], [0, 0, -1], { wallUV: true });
  // hangar name band over the door (painted)
  b.set({ mat: MAT.paint, color: 0x2f4d6e });
  b.poly([[-dw / 3, hd + 1.2, -d / 2 - 0.03], [dw / 3, hd + 1.2, -d / 2 - 0.03], [dw / 3, hd + 2.2, -d / 2 - 0.03], [-dw / 3, hd + 2.2, -d / 2 - 0.03]], [0, 0, -1], { wallUV: true });
  doorLeaves(b, dw, hd, -d / 2, h.doorOpen, h.door);
  if (h.doorOpen > 0) {
    const x0 = -w / 2 + 0.3, x1 = w / 2 - 0.3, zi0 = -d / 2 + 0.3, zi1 = d / 2 - 0.3;
    b.set({ mat: MAT.concrete, color: 0x3b3a37 });
    b.poly([[x0, 0.02, zi0], [x1, 0.02, zi0], [x1, 0.02, zi1], [x0, 0.02, zi1]], [0, 1, 0], { uAxis: [1, 0, 0] });
    b.set({ mat: MAT.paint, color: 0x25272a });
    const inner = arc.map(([x, y]) => [x * 0.985, y * 0.985 - 0.1] as V2);
    const ids: number[][] = [];
    for (const [x, y] of inner) {
      const nx = -x / R, ny = -(y - cy) / R;
      ids.push([b.v(x, y, zi0, nx, ny, 0, zi0, y), b.v(x, y, zi1, nx, ny, 0, zi1, y)]);
    }
    for (let i = 0; i < N; i++) b.quad(ids[i][0], ids[i + 1][0], ids[i + 1][1], ids[i][1]);
    b.poly([[x0, 0, zi1], [x1, 0, zi1], ...[...inner].reverse().map(([x, y]) => [x, y, zi1] as V3)], [0, 0, -1], { wallUV: true });
    for (const sx of [x0, x1]) b.poly([[sx, 0, zi0], [sx, 0, zi1], [sx, wall, zi1], [sx, wall, zi0]], [-Math.sign(sx), 0, 0], { wallUV: true });
    b.set({ mat: MAT.interiorLamp, color: 0xfff1d8 });
    for (const x of [-w / 5, 0, w / 5]) for (let z = zi0 + 3; z < zi1 - 1; z += 5.5) b.boxC(x, arcY(x) - 1.3, z, 0.8, 0.1, 0.8, 't');
    b.set({ mat: MAT.paint, color: 0x5a1e1a });
    b.box(x1 - 4, 0, zi1 - 0.9, x1 - 2.2, 1.1, zi1 - 0.2, 'b');
  } else {
    b.set({ mat: MAT.dark, color: 0x101010 });
    b.poly([[-dw / 2, 0, -d / 2 + 0.05], [dw / 2, 0, -d / 2 + 0.05], [dw / 2, hd, -d / 2 + 0.05], [-dw / 2, hd, -d / 2 + 0.05]], [0, 0, -1], { wallUV: true });
  }
  b.set({ mat: MAT.lamp, color: 0xfff0d0 });
  for (const x of [-dw / 4, dw / 4]) b.boxC(x, hd + 0.8, -d / 2 - 0.25, 0.5, 0.18, 0.4);
  b.pop();
}

// ─── terminal / FBO ───────────────────────────────────────────────────────────

function terminal(b: MeshBuilder, t: BuildingSpot, g: number) {
  const w = t.width, d = t.depth, H = t.height;
  const wallTop = H - 0.8;
  b.pushTR(t.center.x, g, t.center.z, rotOf(t.headingDeg));
  b.set({ mat: MAT.concrete, color: 0xa9a59c });
  b.box(-w / 2 - 0.05, -0.2, -d / 2 - 0.05, w / 2 + 0.05, 0.35, d / 2 + 0.05, 'b');
  b.set({ mat: MAT.paint, color: 0xd6cfbf });
  b.box(-w / 2, 0.35, -d / 2, w / 2, wallTop, d / 2, 'tb');
  // parapet / fascia band (metal composite panels)
  b.set({ mat: MAT.metal, color: 0x5b6166, rough: 0.4 });
  b.box(-w / 2 - 0.15, wallTop, -d / 2 - 0.15, w / 2 + 0.15, H, d / 2 + 0.15, 'b');
  b.set({ mat: MAT.membrane, color: 0x5d6062 });
  b.poly([[-w / 2, H - 0.35, -d / 2], [w / 2, H - 0.35, -d / 2], [w / 2, H - 0.35, d / 2], [-w / 2, H - 0.35, d / 2]], [0, 1, 0], { uAxis: [1, 0, 0] });
  // parapet inner faces
  b.set({ mat: MAT.paint, color: 0x6a6f73 });
  b.poly([[-w / 2, H - 0.35, -d / 2 + 0.01], [w / 2, H - 0.35, -d / 2 + 0.01], [w / 2, H, -d / 2 + 0.01], [-w / 2, H, -d / 2 + 0.01]], [0, 0, 1], { wallUV: true });
  b.poly([[-w / 2, H - 0.35, d / 2 - 0.01], [w / 2, H - 0.35, d / 2 - 0.01], [w / 2, H, d / 2 - 0.01], [-w / 2, H, d / 2 - 0.01]], [0, 0, -1], { wallUV: true });
  // airside curtain wall and landside windows
  b.set({ mat: MAT.window, color: 0xffffff });
  const cw = Math.min(9, w / 2 - 3);
  b.poly([[-cw, 0.4, -d / 2 - 0.05], [cw, 0.4, -d / 2 - 0.05], [cw, wallTop - 0.3, -d / 2 - 0.05], [-cw, wallTop - 0.3, -d / 2 - 0.05]], [0, 0, -1], { wallUV: true });
  // punched windows in the stucco flanks
  for (let x0 = cw + 1.6; x0 + 2.4 < w / 2 - 0.8; x0 += 3.6)
    for (const sx of [-1, 1]) {
      const xa = sx * x0, xb = sx * (x0 + 2.4);
      b.poly([[Math.min(xa, xb), 1.0, -d / 2 - 0.04], [Math.max(xa, xb), 1.0, -d / 2 - 0.04], [Math.max(xa, xb), 2.45, -d / 2 - 0.04], [Math.min(xa, xb), 2.45, -d / 2 - 0.04]], [0, 0, -1], { wallUV: true });
    }
  b.set({ mat: MAT.paint, color: 0x8f8a80 });
  for (let x0 = cw + 1.6; x0 + 2.4 < w / 2 - 0.8; x0 += 3.6)
    for (const sx of [-1, 1]) {
      const xa = sx * (x0 - 0.08), xb = sx * (x0 + 2.48);
      b.box(Math.min(xa, xb), 0.88, -d / 2 - 0.12, Math.max(xa, xb), 1.0, -d / 2 + 0.01); // sills
    }
  b.set({ mat: MAT.window, color: 0xffffff });
  for (const x0 of [-w / 2 + 2, -w / 2 + 11, 4, 13])
    b.poly([[x0, 1.0, d / 2 + 0.04], [x0 + 6, 1.0, d / 2 + 0.04], [x0 + 6, 2.35, d / 2 + 0.04], [x0, 2.35, d / 2 + 0.04]], [0, 0, 1], { wallUV: true });
  b.poly([[-2, 0.4, d / 2 + 0.05], [2, 0.4, d / 2 + 0.05], [2, 3.2, d / 2 + 0.05], [-2, 3.2, d / 2 + 0.05]], [0, 0, 1], { wallUV: true });
  // entrance canopies (airside and landside)
  for (const [zf, dir] of [[-d / 2, -1], [d / 2, 1]] as const) {
    b.set({ mat: MAT.metal, color: 0x5b6166, rough: 0.4 });
    b.box(-6, 3.3, Math.min(zf, zf + dir * 3.2), 6, 3.62, Math.max(zf, zf + dir * 3.2));
    b.set({ mat: MAT.metal, color: 0x3d4145 });
    for (const x of [-5.6, 5.6]) b.tube([x, 0.35, zf + dir * 2.9], [x, 3.3, zf + dir * 2.9], 0.09, 0.09, 8);
    b.set({ mat: MAT.lamp, color: 0xfff0d8 });
    for (const x of [-3, 0, 3]) b.boxC(x, 3.28, zf + dir * 1.6, 0.6, 0.04, 0.6, 't');
  }
  // rooftop plant
  b.set({ mat: MAT.metal, color: 0xa7abab, rough: 0.5 });
  b.box(-10, H - 0.35, -2, -7.5, H + 1.05, 0.2, 'b');
  b.box(3, H - 0.35, 0.5, 6.2, H + 0.95, 2.8, 'b');
  b.box(11, H - 0.35, -3, 12.6, H + 0.75, -1.2, 'b');
  b.set({ mat: MAT.dark, color: 0x1a1a1a });
  b.cylinder(-8.75, H + 1.05, -0.9, 0.55, 0.05, 12, true);
  b.cylinder(4.6, H + 0.95, 1.65, 0.6, 0.05, 12, true);
  b.set({ mat: MAT.metal, color: 0xb0b4b6 });
  b.tube([15, H, 4], [15, H + 3.5, 4], 0.03, 0.015, 4);
  b.pop();
}

// ─── fuel installation ────────────────────────────────────────────────────────

function fuelStation(b: MeshBuilder, plan: AirportPlan, heightAt: HeightFn) {
  const rot = rotOf(plan.fuel.headingDeg);
  // pump island (local: −z faces the apron)
  const p = plan.fuelPump;
  b.pushTR(p.x, heightAt(p.x, p.z), p.z, rot);
  b.set({ mat: MAT.concrete, color: 0xbdb8ad });
  b.box(-1.7, -0.1, -0.7, 1.7, 0.2, 0.7, 'b');
  b.set({ mat: MAT.paint, color: 0xe8e6e0 });
  b.box(-0.45, 0.2, -0.3, 0.45, 1.75, 0.3, 'b');
  b.set({ mat: MAT.paint, color: 0xb5261c });
  b.box(-0.47, 0.2, -0.32, 0.47, 0.9, 0.32, 'b');
  b.set({ mat: MAT.dark, color: 0x151515 });
  b.box(-0.3, 1.1, -0.32, 0.3, 1.5, -0.3, '');
  b.set({ mat: MAT.metal, color: 0x2a2a2a });
  b.cylinder(0.75, 0.2, 0, 0.35, 0.5, 12); // hose reel
  b.set({ mat: MAT.rubber, color: 0x111111 });
  b.tube([0.75, 0.6, -0.3], [0.9, 0.2, -1.2], 0.025, 0.025, 4);
  b.set({ mat: MAT.paint, color: 0xd8b21a });
  for (const [x, z] of [[-1.5, -0.9], [1.5, -0.9], [-1.5, 0.9], [1.5, 0.9]] as const) b.cylinder(x, 0, z, 0.1, 1.05, 8);
  b.set({ mat: MAT.paint, color: 0xc0201a });
  b.cylinder(-1.2, 0.2, 0.45, 0.09, 0.5, 8);
  b.pop();
  // self-serve skid tank on saddles
  const t = plan.fuelTank;
  b.pushTR(t.x, heightAt(t.x, t.z), t.z, rot);
  b.set({ mat: MAT.concrete, color: 0xb7b2a7 });
  b.box(-4.2, -0.1, -1.9, 4.2, 0.15, 1.9, 'b');
  b.box(-2.6, 0.15, -1.1, -2.1, 0.55, 1.1, 'b');
  b.box(2.1, 0.15, -1.1, 2.6, 0.55, 1.1, 'b');
  const tankR = 1.25;
  b.set({ mat: MAT.paint, color: 0xecebe6 });
  b.push(new THREE.Matrix4().makeRotationZ(Math.PI / 2).setPosition(0, 0.55 + tankR, 0));
  b.lathe([[0.0, -3.55], [tankR * 0.75, -3.5], [tankR * 0.97, -3.3], [tankR, -3.1], [tankR, 3.1], [tankR * 0.97, 3.3], [tankR * 0.75, 3.5], [0, 3.55]], 20);
  b.pop();
  b.set({ mat: MAT.paint, color: 0x1f4f9a });
  b.push(new THREE.Matrix4().makeRotationZ(Math.PI / 2).setPosition(0, 0.55 + tankR, 0));
  b.lathe([[tankR + 0.01, -0.6], [tankR + 0.01, 0.6]], 20);
  b.pop();
  // top walkway, ladder and vents
  b.set({ mat: MAT.metal, color: 0x8b9093 });
  b.box(-1.2, 0.55 + 2 * tankR, -0.4, 1.2, 0.6 + 2 * tankR, 0.4, '');
  for (const x of [-1.2, 1.2]) b.tube([x, 0.6 + 2 * tankR, 0.4], [x, 1.6 + 2 * tankR, 0.4], 0.02, 0.02, 4);
  b.tube([-1.2, 1.6 + 2 * tankR, 0.4], [1.2, 1.6 + 2 * tankR, 0.4], 0.025, 0.025, 4);
  for (const x of [1.35, 1.8]) b.tube([x, 0.15, -1.5], [x, 0.6 + 2 * tankR, -0.45], 0.025, 0.025, 4);
  for (let i = 1; i < 8; i++) {
    const f = i / 8;
    b.tube([1.35, 0.15 + f * (0.45 + 2 * tankR), -1.5 + f * 1.05], [1.8, 0.15 + f * (0.45 + 2 * tankR), -1.5 + f * 1.05], 0.015, 0.015, 3);
  }
  b.tube([-2.5, 0.55 + 2 * tankR, 0], [-2.5, 1.4 + 2 * tankR, 0], 0.04, 0.04, 6);
  b.set({ mat: MAT.paint, color: 0xd8b21a });
  for (const [x, z] of [[-4, -1.7], [0, -1.7], [4, -1.7], [-4, 1.7], [4, 1.7]] as const) b.cylinder(x, 0.15, z, 0.1, 1.0, 8);
  b.pop();
}

// ─── windsock mast + segmented circle ─────────────────────────────────────────

function windsockSite(b: MeshBuilder, plan: AirportPlan, heightAt: HeightFn) {
  const p = plan.windsock;
  const g = heightAt(p.x, p.z);
  b.pushTR(p.x, g, p.z, 0);
  b.set({ mat: MAT.concrete, color: 0xb3aea4 });
  b.cylinder(0, -0.1, 0, 0.45, 0.25, 12);
  b.set({ mat: MAT.paint, color: 0xe9e7e2 });
  b.tube([0, 0.15, 0], [0, WINDSOCK_MAST.height, 0], 0.075, 0.05, 8);
  b.set({ mat: MAT.metal, color: 0x5a5f63 });
  b.cylinder(0, WINDSOCK_MAST.height - 0.1, 0, 0.07, 0.25, 8);
  // obstruction lamp on top
  b.set({ mat: MAT.lamp, color: 0xd02010 });
  b.cylinder(0, WINDSOCK_MAST.height + 0.15, 0, 0.07, 0.14, 8);
  b.pop();
  // segmented circle (20 panels, r 15 m) + landing-strip indicators
  const R = 15;
  b.set({ mat: MAT.paint, color: 0xdad6cc });
  for (let k = 0; k < 20; k++) {
    const a = (k / 20) * Math.PI * 2;
    b.pushTR(p.x + R * Math.sin(a), 0, p.z - R * Math.cos(a), -a);
    const x = p.x + R * Math.sin(a), z = p.z - R * Math.cos(a);
    const y = heightAt(x, z);
    b.box(-1.3, y - 0.1, -0.35, 1.3, y + 0.14, 0.35, 'b');
    b.pop();
  }
  // runway alignment indicators just outside the circle (along the runway, both ends)
  const rw = plan.rw;
  for (const s of [-1, 1]) {
    const x = p.x + rw.dir.x * s * (R + 5), z = p.z + rw.dir.z * s * (R + 5);
    b.pushTR(x, heightAt(x, z), z, rotOf(rw.headingDeg));
    b.box(-0.35, -0.1, -3, 0.35, 0.14, 3, 'b');
    b.pop();
  }
}

// ─── the field's buildings and navaids (facilities.ts) ────────────────────────

function fieldBuildings(b: MeshBuilder, plan: AirportPlan, heightAt: HeightFn) {
  for (const f of plan.field.buildings) {
    if (f.kind === 'maintHangar') continue; // a HangarPlan (plan.hangars)
    const p = fromRunwayCoords(f.a, f.c, plan.rw);
    b.pushTR(p.x, heightAt(p.x, p.z), p.z, rotOf(f.headingDeg));
    switch (f.kind) {
      case 'thangar':
        tHangarRow(b, f.width, f.depth, 10, f.seed ?? 0);
        break;
      case 'flightSchool':
        flightSchool(b, 26, 14);
        break;
      case 'fireStation':
        fireStation(b, 36, 22, 3);
        break;
      case 'fuelFarm':
        fuelFarm(b);
        break;
      case 'vor':
        vorStation(b);
        break;
      case 'localizer':
        localizerArray(b, 30);
        break;
      case 'glideslope':
        glideslope(b);
        break;
    }
    b.pop();
  }
}

/** A plain windsock mast (the sock itself is the instanced windsock mesh). */
function sockMast(b: MeshBuilder, x: number, z: number, heightAt: HeightFn) {
  const g = heightAt(x, z);
  b.pushTR(x, g, z, 0);
  b.set({ mat: MAT.concrete, color: 0xb3aea4 });
  b.cylinder(0, -0.1, 0, 0.4, 0.22, 10);
  b.set({ mat: MAT.paint, color: 0xe9e7e2 });
  b.tube([0, 0.12, 0], [0, WINDSOCK_MAST.height, 0], 0.07, 0.05, 8);
  b.set({ mat: MAT.metal, color: 0x5a5f63 });
  b.cylinder(0, WINDSOCK_MAST.height - 0.1, 0, 0.07, 0.25, 8);
  b.set({ mat: MAT.lamp, color: 0xd02010 });
  b.cylinder(0, WINDSOCK_MAST.height + 0.15, 0, 0.07, 0.14, 8);
  b.pop();
}

// ─── light fixtures ───────────────────────────────────────────────────────────

function fixtures(b: MeshBuilder, lights: readonly LightDef[], heightAt: HeightFn, plan: AirportPlan) {
  const rot = rotOf(plan.rw.headingDeg);
  const papiDone = new Set<string>();
  for (const l of lights) {
    const g = heightAt(l.x, l.z);
    const h = l.y - g;
    switch (l.kind) {
      case 'edge':
      case 'threshold':
      case 'taxi': {
        b.set({ mat: MAT.paint, color: l.kind === 'taxi' ? 0x3c3f42 : 0xd8b21a });
        b.tube([l.x, g - 0.02, l.z], [l.x, g + h - 0.07, l.z], 0.03, 0.022, 5);
        b.set({ mat: MAT.metal, color: 0x2c2f31 });
        b.cylinder(l.x, g + h - 0.08, l.z, 0.065, 0.05, 8, true);
        const c = new THREE.Color().setRGB(l.front[0], l.front[1], l.front[2], THREE.LinearSRGBColorSpace);
        b.set({ mat: MAT.lamp, color: c.getHex() });
        const y0 = g + h - 0.03;
        b.lathe([[0.06, y0 - 0.03], [0.055, y0 + 0.03], [0.03, y0 + 0.07], [0, y0 + 0.08]], 8, l.x, l.z);
        break;
      }
      default:
        break;
    }
    if (l.kind === 'reil') {
      b.set({ mat: MAT.paint, color: 0xd8b21a });
      b.tube([l.x, g - 0.02, l.z], [l.x, g + h - 0.15, l.z], 0.04, 0.035, 5);
      b.pushTR(l.x, g + h, l.z, rotOf(l.facingDeg ?? 0));
      b.set({ mat: MAT.metal, color: 0x2e3134 });
      b.box(-0.16, -0.16, -0.12, 0.16, 0.14, 0.2, '');
      b.set({ mat: MAT.lamp, color: 0xf2f6ff });
      b.poly(circle(0, -0.01, -0.125, 0.11), [0, 0, -1], { wallUV: true });
      b.pop();
    }
    if (l.kind === 'approach' || l.kind === 'rabbit') {
      b.set({ mat: MAT.paint, color: 0xd8d8d2 });
      b.tube([l.x, g - 0.02, l.z], [l.x, g + h - 0.12, l.z], 0.045, 0.035, 5);
      b.pushTR(l.x, g + h, l.z, rot);
      b.set({ mat: MAT.metal, color: 0x3a3d40 });
      b.box(-0.13, -0.14, -0.1, 0.13, 0.12, 0.14, '');
      b.set({ mat: MAT.lamp, color: 0xfff6e0 });
      b.poly([[-0.1, -0.1, 0.145], [0.1, -0.1, 0.145], [0.1, 0.09, 0.145], [-0.1, 0.09, 0.145]], [0, 0, 1], { wallUV: true });
      b.pop();
    }
    if (l.kind === 'papi' && l.end !== undefined) {
      const key = `${l.end}-${l.unit}`;
      if (papiDone.has(key)) continue;
      papiDone.add(key);
      const facing = l.facingDeg ?? 0;
      b.pushTR(l.x, g, l.z, rotOf(facing));
      b.set({ mat: MAT.paint, color: 0xd6d8d4 });
      b.box(-0.55, h - 0.28, -0.42, 0.55, h + 0.3, 0.42, 'b');
      b.set({ mat: MAT.paint, color: 0xd9a21b });
      b.box(-0.58, h + 0.3, -0.45, 0.58, h + 0.36, 0.45, 'b');
      b.set({ mat: MAT.metal, color: 0x55595c });
      for (const [x, z] of [[-0.45, -0.32], [0.45, -0.32], [-0.45, 0.32], [0.45, 0.32]] as const) b.tube([x, -0.05, z], [x, h - 0.28, z], 0.035, 0.035, 5);
      b.set({ mat: MAT.lamp, color: 0xfff4e8 });
      for (const x of [-0.25, 0.25]) b.poly(circle(x, h, -0.425, 0.13), [0, 0, -1], { wallUV: true });
      b.pop();
    }
  }
  // MALSR 5-light bars: a horizontal pipe through each bar's lamps
  const byBar = new Map<number, LightDef[]>();
  for (const l of lights) if (l.kind === 'approach') {
    const k = Math.round((l.x * plan.rw.dir.x + l.z * plan.rw.dir.z) * 10);
    const arr = byBar.get(k) ?? [];
    arr.push(l);
    byBar.set(k, arr);
  }
  b.set({ mat: MAT.paint, color: 0xd8d8d2 });
  for (const bar of byBar.values()) {
    const c = bar.map((l) => ({ l, c: l.x * plan.rw.right.x + l.z * plan.rw.right.z })).sort((p, q) => p.c - q.c);
    for (let i = 1; i < c.length; i++) {
      if (c[i].c - c[i - 1].c > 1.6) continue;
      const p = c[i - 1].l, q = c[i].l;
      b.tube([p.x, p.y - 0.16, p.z], [q.x, q.y - 0.16, q.z], 0.03, 0.03, 4);
    }
  }
}

function circle(x: number, y: number, z: number, r: number): V3[] {
  const out: V3[] = [];
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2;
    out.push([x + r * Math.cos(a), y + r * Math.sin(a), z]);
  }
  return out;
}

// ─── fence ───────────────────────────────────────────────────────────────────

export const FENCE = { height: 2.1, wireTop: 2.55, postSpacing: 3.05 };

interface FenceRun {
  p0: { a: number; c: number };
  p1: { a: number; c: number };
}

export function fenceRuns(plan: AirportPlan): FenceRun[] {
  const f = plan.fence;
  const sides: Record<'north' | 'south' | 'east' | 'west', FenceRun> = {
    south: { p0: { a: f.a0, c: f.c0 }, p1: { a: f.a0, c: f.c1 } },
    east: { p0: { a: f.a0, c: f.c1 }, p1: { a: f.a1, c: f.c1 } },
    north: { p0: { a: f.a1, c: f.c1 }, p1: { a: f.a1, c: f.c0 } },
    west: { p0: { a: f.a1, c: f.c0 }, p1: { a: f.a0, c: f.c0 } },
  };
  const out: FenceRun[] = [];
  for (const [name, run] of Object.entries(sides) as [keyof typeof sides, FenceRun][]) {
    const alongA = run.p0.c === run.p1.c; // east/west sides run along a
    const gates = f.gates.filter((g) => g.side === name).sort((x, y) => x.from - y.from);
    const v0 = alongA ? run.p0.a : run.p0.c;
    const v1 = alongA ? run.p1.a : run.p1.c;
    const lo = Math.min(v0, v1), hi = Math.max(v0, v1);
    let cur = lo;
    const segs: [number, number][] = [];
    for (const g of gates) {
      if (g.from > cur) segs.push([cur, Math.min(g.from, hi)]);
      cur = Math.max(cur, g.to);
    }
    if (cur < hi) segs.push([cur, hi]);
    for (const [s0, s1] of segs)
      out.push(alongA ? { p0: { a: s0, c: run.p0.c }, p1: { a: s1, c: run.p0.c } } : { p0: { a: run.p0.a, c: s0 }, p1: { a: run.p0.a, c: s1 } });
  }
  return out;
}

function fencePosts(b: MeshBuilder, plan: AirportPlan, heightAt: HeightFn) {
  b.set({ mat: MAT.metal, color: 0x9aa0a3, rough: 0.45 });
  for (const r of fenceRuns(plan)) {
    const len = Math.hypot(r.p1.a - r.p0.a, r.p1.c - r.p0.c);
    const n = Math.max(1, Math.ceil(len / FENCE.postSpacing));
    let prev: V3 | null = null;
    for (let i = 0; i <= n; i++) {
      const f = i / n;
      const w = toWorld(plan, r.p0.a + (r.p1.a - r.p0.a) * f, r.p0.c + (r.p1.c - r.p0.c) * f);
      const g = heightAt(w.x, w.z);
      const terminal = i === 0 || i === n;
      b.tube([w.x, g - 0.2, w.z], [w.x, g + FENCE.height + (terminal ? 0.12 : 0.05), w.z], terminal ? 0.05 : 0.03, terminal ? 0.05 : 0.03, 5);
      const top: V3 = [w.x, g + FENCE.height, w.z];
      if (prev) b.tube(prev, top, 0.021, 0.021, 4);
      prev = top;
    }
  }
}

/** Chain-link fabric (+ barbed-wire strands drawn by the shader above FENCE.height). */
export function buildFenceFabric(plan: AirportPlan, heightAt: HeightFn): THREE.BufferGeometry {
  const b = new MeshBuilder();
  let u0 = 0;
  for (const r of fenceRuns(plan)) {
    const len = Math.hypot(r.p1.a - r.p0.a, r.p1.c - r.p0.c);
    const n = Math.max(1, Math.ceil(len / 12));
    let prev: [number, number] | null = null;
    for (let i = 0; i <= n; i++) {
      const f = i / n;
      const w = toWorld(plan, r.p0.a + (r.p1.a - r.p0.a) * f, r.p0.c + (r.p1.c - r.p0.c) * f);
      const g = heightAt(w.x, w.z);
      const u = u0 + len * f;
      const lo = b.v(w.x, g + 0.03, w.z, 0, 1, 0, u, 0.03);
      const hi = b.v(w.x, g + FENCE.wireTop, w.z, 0, 1, 0, u, FENCE.wireTop);
      if (prev) b.quad(prev[0], lo, hi, prev[1]);
      prev = [lo, hi];
    }
    u0 += len;
  }
  return b.toGeometry(['uv']);
}

// ─── all structures ───────────────────────────────────────────────────────────

export function buildStructures(plan: AirportPlan, lights: readonly LightDef[], heightAt: HeightFn): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const gAt = (s: BuildingSpot) => heightAt(s.center.x, s.center.z);
  tower(b, plan.tower, gAt(plan.tower));
  terminal(b, plan.terminal, gAt(plan.terminal));
  for (const h of plan.hangars) (h.roof === 'arched' ? archedHangar : gabledHangar)(b, h, gAt(h.spot));
  fuelStation(b, plan, heightAt);
  windsockSite(b, plan, heightAt);
  fieldBuildings(b, plan, heightAt);
  for (const w of plan.field.windsocks) sockMast(b, w.x, w.z, heightAt);
  fixtures(b, lights, heightAt, plan);
  fencePosts(b, plan, heightAt);
  return b.toGeometry(['color', 'mat', 'uv']);
}
