/**
 * The JetRanger's airframe skin: the lofted cabin pod and aft fuselage (painted livery, window
 * cut-outs), the tapered tail boom, the cabin lining (the inside of the skin), the glass, the
 * engine/transmission fairing on the roof and the small fuselage parts (intake screens, exhaust
 * stack, pitot, antennas, door hinges, landing-light housing).
 *
 * UVs: the skin and boom use the global livery mapping (u around the ring, v = vOfZ(z)); the lining
 * and the glass use the cabin mapping (v = vCabinOfZ(z)). See shape.ts / livery.ts.
 */
import * as THREE from 'three';
import { loftGeometry } from '../loft';
import { merge, plain, tint } from '../materials';
import { splitByTriangles } from '../breakup';
import { box, ellipsoid, tube, V } from '../f16/geom';
import {
  FAIRING_Z0,
  FAIRING_Z1,
  WINDOWS,
  Z_BOOM_END,
  Z_CABIN_END,
  Z_JOINT,
  Z_TIP,
  fairingSection,
  fuselageSection,
  insetSection,
  makeSection,
  sectionHalfWidthAt,
  sectionPoint,
  skinHalfWidth,
  vCabinOfZ,
  vOfZ,
  windowSd,
  type Section,
} from './shape';
import { LINING_INSET } from './livery';

const _p: [number, number] = [0, 0];

function ring(sec: Section, z: number, n: number): number[] {
  const out: number[] = [];
  for (let j = 0; j < n; j++) {
    sectionPoint(sec, j / n, _p);
    out.push(_p[0], _p[1], z);
  }
  return out;
}

/** Stations from the nose tip: quadratic near the tip (the rounded cap), then `step` apart. */
function stations(z0: number, z1: number, step: number, noseK: number): number[] {
  const out: number[] = [];
  if (z0 <= Z_TIP + 1e-9) {
    for (let k = 0; k <= noseK; k++) out.push(Z_TIP + 0.5 * (k / noseK) ** 2);
    z0 = Z_TIP + 0.5;
  }
  const n = Math.max(1, Math.round((z1 - z0) / step));
  for (let k = out.length ? 1 : 0; k <= n; k++) out.push(z0 + ((z1 - z0) * k) / n);
  return out;
}

function loftFuselage(zs: number[], n: number, v: (z: number) => number, inset = 0, opts: { capEnd?: boolean } = {}): THREE.BufferGeometry {
  const s = makeSection();
  const si = makeSection();
  const rings = zs.map((z) => {
    fuselageSection(z, s);
    return ring(inset > 0 ? insetSection(s, inset, si) : s, z, n);
  });
  return loftGeometry(rings, { v: zs.map(v), capEnd: opts.capEnd, orient: 'auto' });
}

export interface FuselageGeometry {
  /** Cabin pod + aft fuselage (to the boom joint), livery UVs. */
  skin: THREE.BufferGeometry;
  /** Tail boom (joint to the end cap), livery UVs. */
  boom: THREE.BufferGeometry;
  /** Cabin lining (BackSide) with the rear wall, cabin UVs. */
  lining: THREE.BufferGeometry;
  /** Window glass: RGBA vertex colours, cabin UVs (the mask texture trims it). */
  glass: THREE.BufferGeometry;
  /** Engine / transmission fairing (vertex-coloured paint). */
  fairing: THREE.BufferGeometry;
  /** Small fuselage parts (parts material). */
  details: THREE.BufferGeometry;
}

/** Fairing ring: the upper superellipse, vertical side walls down into the roof, a hidden floor. */
function fairingRing(z: number): number[] {
  const f = fairingSection(z);
  const cab = fuselageSection(z);
  const hw = Math.min(f.hw, Math.max(0.004, cab.hw * 0.9));
  // Roof height under the fairing's edge (the walls stand on it).
  const roofEdge = cab.wY + (cab.top - cab.wY) * Math.pow(Math.max(0, 1 - Math.pow(Math.min(1, hw / cab.hw), cab.nT)), 1 / cab.nT);
  const top = Math.max(f.top, roofEdge + 0.01);
  const wY = roofEdge + 0.35 * (top - roofEdge);
  const low = roofEdge - 0.04;
  const floor = Math.min(low, cab.top - 0.08);
  const pts: number[] = [];
  const ARC = 32;
  for (let k = 0; k <= ARC; k++) {
    const th = (Math.PI * k) / ARC;
    const c = Math.cos(th);
    const s = Math.sin(th);
    const e = 2 / 2.6;
    pts.push((c < 0 ? -1 : 1) * hw * Math.pow(Math.abs(c), e), wY + (top - wY) * Math.pow(s, e), z);
  }
  // Left wall down, floor across, right wall up.
  for (const t of [0.5, 1]) pts.push(-hw, wY + (low - wY) * t, z);
  for (const t of [0.25, 0.5, 0.75]) pts.push(-hw + 2 * hw * t, floor, z);
  for (const t of [1, 0.5]) pts.push(hw, wY + (low - wY) * t, z);
  return pts;
}

function fairingGeometry(): THREE.BufferGeometry {
  const zs: number[] = [];
  const K = 64;
  for (let k = 0; k <= K; k++) {
    // Denser at both rounded ends.
    const t = 0.5 - 0.5 * Math.cos((Math.PI * k) / K);
    zs.push(FAIRING_Z0 + (FAIRING_Z1 - FAIRING_Z0) * t);
  }
  const g = loftGeometry(zs.map(fairingRing), { capStart: true, capEnd: true });
  return tint(plain(g), 0xf3f4f0, 0.32, 0);
}

/** Glass: the window triangles of a fine outer loft, pushed 4 mm out, RGBA-tinted. */
function glassGeometry(): THREE.BufferGeometry {
  const zs = stations(Z_TIP, 0.22, 0.03, 16);
  const full = loftFuselage(zs, 128, vCabinOfZ);
  const win = { d: 0, kind: 'none' as ReturnType<typeof windowSd>['kind'] };
  const [sel] = splitByTriangles(full, 1, (x, y, z) => (windowSd(x, y, z, win).d < 0.035 ? 0 : -1));
  full.dispose();
  const g = sel!;
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  const col = new Float32Array(pos.count * 4);
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(i, pos.getX(i) + nor.getX(i) * 0.004, pos.getY(i) + nor.getY(i) * 0.004, pos.getZ(i) + nor.getZ(i) * 0.004);
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    windowSd(x, y, z, win);
    // Tinted green-grey band across the top of the windscreen, and the overhead windows.
    let k = 0;
    if (win.kind === 'windscreen') k = Math.min(1, Math.max(0, (y - 0.5) / 0.14));
    if (win.kind === 'overhead') k = 1;
    const clear = [0.3, 0.34, 0.36, 0.34];
    const tintC = [0.1, 0.2, 0.14, 0.72];
    for (let c = 0; c < 4; c++) col[i * 4 + c] = clear[c] + (tintC[c] - clear[c]) * k;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 4));
  g.computeBoundingSphere();
  return g;
}

/** A vertical grille of slats on the fairing's side at station range z0..z1, height y0..y1. */
function intakeScreen(side: 1 | -1, z0: number, z1: number, y0: number, y1: number): THREE.BufferGeometry[] {
  const g: THREE.BufferGeometry[] = [];
  const zc = (z0 + z1) / 2;
  const xAt = (y: number) => {
    // The fairing's half-width at height y (wall or arc).
    const f = fairingSection(zc);
    const cab = fuselageSection(zc);
    const hw = Math.min(f.hw, cab.hw * 0.9);
    const roofEdge = cab.wY + (cab.top - cab.wY) * Math.pow(Math.max(0, 1 - Math.pow(Math.min(1, hw / cab.hw), cab.nT)), 1 / cab.nT);
    const wY = roofEdge + 0.35 * (f.top - roofEdge);
    if (y <= wY) return hw;
    const t = Math.min(1, (y - wY) / (f.top - wY));
    return hw * Math.pow(1 - Math.pow(t, 2.6), 1 / 2.6);
  };
  const xm = xAt((y0 + y1) / 2);
  // Dark backing and a frame.
  g.push(tint(box(0.012, y1 - y0, z1 - z0, V(side * (xm + 0.002), (y0 + y1) / 2, zc)), 0x15161a, 0.8, 0.2));
  g.push(tint(box(0.016, 0.018, z1 - z0 + 0.03, V(side * (xm + 0.004), y1 + 0.006, zc)), 0xc9ccce, 0.4, 0.3));
  g.push(tint(box(0.016, 0.018, z1 - z0 + 0.03, V(side * (xm + 0.004), y0 - 0.006, zc)), 0xc9ccce, 0.4, 0.3));
  // Mesh screen: fine vertical and horizontal bars.
  const nz = 14;
  for (let k = 1; k < nz; k++) {
    const z = z0 + ((z1 - z0) * k) / nz;
    g.push(tint(box(0.008, y1 - y0, 0.006, V(side * (xm + 0.009), (y0 + y1) / 2, z)), 0x5a5e62, 0.5, 0.6));
  }
  for (let k = 1; k < 4; k++) {
    const y = y0 + ((y1 - y0) * k) / 4;
    g.push(tint(box(0.008, 0.005, z1 - z0, V(side * (xAt(y) + 0.01), y, zc)), 0x5a5e62, 0.5, 0.6));
  }
  return g;
}

function detailsGeometry(): THREE.BufferGeometry {
  const g: THREE.BufferGeometry[] = [];
  // Engine air intake screens on both sides of the fairing, behind the transmission.
  for (const s of [1, -1] as const) g.push(...intakeScreen(s, 0.42, 0.86, 0.95, 1.1));
  // Exhaust stack: up and slightly aft out of the engine cowling.
  const ex0 = V(0, 1.0, 1.42);
  const ex1 = V(0, 1.25, 1.58);
  g.push(tint(tube(ex0, ex1, 0.11, 0.105, 20, true), 0x4a4643, 0.45, 0.7));
  g.push(tint(tube(ex1.clone().add(V(0, -0.014, -0.009)), ex1, 0.115, 0.115, 20), 0x6a655f, 0.4, 0.7));
  g.push(tint(tube(ex0.clone().lerp(ex1, 0.5), ex1.clone().add(V(0, -0.02, -0.013)), 0.095, 0.097, 20), 0x0d0c0c, 0.95, 0));
  g.push(tint(box(0.36, 0.012, 0.3, V(0, 1.11, 1.47)), 0x8b8580, 0.5, 0.6));
  // Pitot tube on the roof bow above the windscreen.
  g.push(tint(box(0.02, 0.07, 0.035, V(0, 0.985, -1.54)), 0x2a2b2e, 0.6, 0.2));
  g.push(tint(tube(V(0, 1.015, -1.52), V(0, 1.015, -1.72), 0.008, 0.006, 8), 0xb8bbbe, 0.3, 0.9));
  // VHF whip on the aft fairing, a blade antenna under the belly, a small ELT whip on the boom.
  g.push(tint(tube(V(0, 1.1, 1.6), V(0, 1.28, 1.88), 0.006, 0.003, 6), 0x1a1a1a, 0.6, 0.1));
  g.push(tint(box(0.012, 0.14, 0.2, V(0, -0.87, -0.35), -0.4, 0, 0), 0x2a2b2e, 0.6, 0.1));
  g.push(tint(tube(V(0.02, -0.82, 0.45), V(0.02, -1.0, 0.62), 0.005, 0.003, 6), 0x1a1a1a, 0.6, 0.1));
  // Door hinges (front edge of each door) and the fuel filler on the right aft fuselage.
  for (const s of [1, -1]) {
    for (const [z, y] of [
      [-1.9, -0.35],
      [-1.9, -0.1],
      [-0.86, -0.35],
      [-0.86, -0.1],
    ] as const) {
      const x = skinHalfWidth(y, z) + 0.004;
      g.push(tint(box(0.014, 0.07, 0.03, V(s * x, y, z)), 0x9fa3a6, 0.4, 0.7));
    }
  }
  const fx = skinHalfWidth(-0.05, 0.75);
  g.push(tint(ellipsoid(V(fx + 0.002, -0.05, 0.75), 0.006, 0.045, 0.045, 12, 6), 0x3a3b3e, 0.5, 0.5));
  // Landing-light housing flush under the nose.
  const lz = -2.2;
  const ly = fuselageSection(lz).bottom;
  g.push(tint(ellipsoid(V(0, ly - 0.002, lz), 0.075, 0.012, 0.09, 16, 6), 0x2b2c2f, 0.5, 0.4));
  // Fresh-air vents on the nose sides and the static ports.
  for (const s of [1, -1]) {
    const x = skinHalfWidth(-0.3, -1.95);
    g.push(tint(ellipsoid(V(s * (x + 0.002), -0.3, -1.95), 0.012, 0.035, 0.05, 10, 6), 0x2e2f33, 0.6, 0.2));
  }
  return merge(g);
}

export function buildFuselage(): FuselageGeometry {
  const skin = plain(loftFuselage(stations(Z_TIP, Z_JOINT, 0.04, 18), 96, vOfZ));
  const boomZs = stations(Z_JOINT, Z_BOOM_END, 0.22, 0);
  const s = makeSection();
  const boom = plain(
    loftGeometry(
      boomZs.map((z) => ring(fuselageSection(z, s), z, 48)),
      { v: boomZs.map(vOfZ), capEnd: true },
    ),
  );
  const lining = plain(loftFuselage(stations(Z_TIP, Z_CABIN_END, 0.06, 10), 64, vCabinOfZ, LINING_INSET, { capEnd: true }));
  return { skin, boom, lining, glass: glassGeometry(), fairing: fairingGeometry(), details: detailsGeometry() };
}

/** |x| of the cabin lining at (y, z). */
export function liningHalfWidth(y: number, z: number): number {
  const s = insetSection(fuselageSection(z), LINING_INSET);
  return sectionHalfWidthAt(s, y);
}

export { WINDOWS };
