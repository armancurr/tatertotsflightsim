/**
 * High strut-braced wing: NACA 2412 sections, constant-chord inner panel,
 * outer panel tapered on the leading edge (straight trailing edge), 1.7°
 * dihedral, 3° washout, drooped fibreglass tips, single streamlined strut per
 * side. Flaps and ailerons are cut out of the trailing edge and returned as
 * separate geometries expressed in their hinge frames.
 */
import * as THREE from 'three';
import { loftGeometry } from './loft';
import { nacaCamber, nacaRing, symmetricRing } from './airfoil';
import { STRUT, WING, wingChord, wingLEy, wingLEz, wingPoint } from './shape';
import { plain, tint } from './materials';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export interface HingedPart {
  side: -1 | 1;
  /** Pivot on the hinge line; local +X runs along the hinge toward +x (body right). */
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  /** Geometry in the pivot frame. */
  geometry: THREE.BufferGeometry;
}

export interface WingBuild {
  /** Plain-paint static geometry (both wings, struts). */
  paint: THREE.BufferGeometry;
  /** Tinted static details (fuel caps, pitot, stall-warning inlet, strut cuffs). */
  parts: THREE.BufferGeometry[];
  ailerons: HingedPart[];
  flaps: HingedPart[];
  /** Nav light / strobe anchor at each tip (body frame), and the landing/taxi lamp spots. */
  tipLight: { left: THREE.Vector3; right: THREE.Vector3 };
  lamps: { landing: THREE.Vector3; taxi: THREE.Vector3 };
}

const _p = { x: 0, y: 0, z: 0 };

function place(side: number, ax: number, ring2d: number[], opts: { droop?: number; leShift?: number } = {}): number[] {
  const out: number[] = [];
  const droop = opts.droop ?? 0;
  const leShift = opts.leShift ?? 0;
  const ch = wingChord(ax);
  for (let k = 0; k < ring2d.length; k += 2) {
    // Chord shrink from the leading edge (rounded tip in plan view): c' = shift + c·(1 − shift).
    const f = leShift / ch;
    const c = f + ring2d[k] * (1 - f);
    wingPoint(side, ax, c, ring2d[k + 1], _p);
    out.push(_p.x, _p.y - droop, _p.z);
  }
  return out;
}

function hinged(side: -1 | 1, axIn: number, axOut: number, h: number, geo: THREE.BufferGeometry): HingedPart {
  const pin = wingPoint(side, axIn, h, nacaCamber(WING.m, WING.p, h), { x: 0, y: 0, z: 0 });
  const pout = wingPoint(side, axOut, h, nacaCamber(WING.m, WING.p, h), { x: 0, y: 0, z: 0 });
  const a = new THREE.Vector3(pin.x, pin.y, pin.z);
  const b = new THREE.Vector3(pout.x, pout.y, pout.z);
  const dir = side > 0 ? b.clone().sub(a) : a.clone().sub(b);
  dir.normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
  const m = new THREE.Matrix4().compose(a, q, new THREE.Vector3(1, 1, 1));
  geo.applyMatrix4(m.clone().invert());
  return { side, position: a, quaternion: q, geometry: geo };
}

export function buildWing(quality: 'high' | 'low'): WingBuild {
  const n = quality === 'high' ? 30 : 18;
  const { m, p, t } = WING;
  const full = nacaRing({ m, p, t, n });
  const flapFront = nacaRing({ m, p, t, n, to: WING.flapHinge });
  const ailFront = nacaRing({ m, p, t, n, to: WING.aileronHinge });
  const flapRear = nacaRing({ m, p, t, n: Math.round(n * 0.6), from: WING.flapHinge });
  const ailRear = nacaRing({ m, p, t, n: Math.round(n * 0.6), from: WING.aileronHinge });

  const paint: THREE.BufferGeometry[] = [];
  const ailerons: HingedPart[] = [];
  const flaps: HingedPart[] = [];

  // Centre section across the cabin roof (both sides in one loft).
  {
    const xs = [-0.6, -0.3, 0, 0.3, 0.6];
    const rings = xs.map((x) => place(x < 0 ? -1 : 1, Math.abs(x), full));
    paint.push(plain(loftGeometry(rings, { capStart: true, capEnd: true })));
  }

  for (const side of [-1, 1] as const) {
    const lin = (a: number, b: number, k: number) => Array.from({ length: k }, (_, i) => a + ((b - a) * i) / (k - 1));
    // Wing box ahead of the flap.
    paint.push(plain(loftGeometry(lin(0.6, 2.52, 3).map((ax) => place(side, ax, flapFront)), { capStart: true, capEnd: true })));
    // Wing box ahead of the aileron (tapered, twisting).
    paint.push(plain(loftGeometry(lin(2.52, WING.tipStart, 5).map((ax) => place(side, ax, ailFront)), { capStart: true, capEnd: true })));
    // Drooped, rounded fibreglass tip.
    {
      const ss = [0, 0.3, 0.55, 0.72, 0.85, 0.93, 0.975, 1];
      const rings = ss.map((s) => {
        const ax = WING.tipStart + (WING.tipEnd - WING.tipStart) * s;
        const thick = Math.max(0.06, Math.sqrt(Math.max(0, 1 - s * s)));
        const ring2d = nacaRing({ m, p, t, n, thicknessScale: thick });
        const leShift = 0.3 * (1 - Math.sqrt(Math.max(0, 1 - s * s)));
        return place(side, ax, ring2d, { droop: 0.045 * s * s, leShift });
      });
      paint.push(plain(loftGeometry(rings, { capStart: true, capEnd: true })));
    }
    // Flap and aileron.
    flaps.push(
      hinged(side, 0.62, 2.5, WING.flapHinge,
        plain(loftGeometry(lin(0.62, 2.5, 3).map((ax) => place(side, ax, flapRear)), { capStart: true, capEnd: true }))),
    );
    ailerons.push(
      hinged(side, WING.aileronInboard, WING.aileronOutboard, WING.aileronHinge,
        plain(loftGeometry(lin(WING.aileronInboard, WING.aileronOutboard, 4).map((ax) => place(side, ax, ailRear)), { capStart: true, capEnd: true }))),
    );
    // Strut: streamlined section from the lower fuselage to the wing's front spar.
    paint.push(plain(buildStrut(side)));
  }

  // Details.
  const parts: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    // Fuel filler cap on the upper surface.
    const cap = new THREE.CylinderGeometry(0.036, 0.038, 0.012, 20);
    const c = 0.24;
    const ax = 2.2;
    const up = wingPoint(side, ax, c, nacaCamber(m, p, c) + 0.06, { x: 0, y: 0, z: 0 });
    cap.translate(up.x, up.y + 0.004, up.z);
    parts.push(tint(cap, 0x9a9ea3, 0.35, 0.8));
  }
  // Pitot tube under the left wing: mast + forward tube.
  {
    const ax = 3.1;
    const lo = wingPoint(-1, ax, 0.12, nacaCamber(m, p, 0.12) - 0.05, { x: 0, y: 0, z: 0 });
    const mast = new THREE.BoxGeometry(0.012, 0.11, 0.05);
    mast.translate(lo.x, lo.y - 0.05, lo.z + 0.01);
    const tube = new THREE.CylinderGeometry(0.007, 0.008, 0.2, 10);
    tube.rotateX(Math.PI / 2);
    tube.translate(lo.x, lo.y - 0.1, lo.z - 0.07);
    parts.push(tint(mast, 0xb8bcc0, 0.35, 0.8), tint(tube, 0xc4c8cc, 0.3, 0.9));
  }
  // Stall warning inlet in the left leading edge.
  {
    const le = wingPoint(-1, 1.45, 0.004, 0, { x: 0, y: 0, z: 0 });
    const slot = new THREE.BoxGeometry(0.06, 0.018, 0.012);
    slot.translate(le.x, le.y - 0.01, le.z);
    parts.push(tint(slot, 0x1a1a1a, 0.6, 0));
  }
  // Strut cuffs where the strut meets wing and fuselage.
  for (const side of [-1, 1]) {
    for (const end of [0, 1]) {
      const a = strutEnds(side);
      const pnt = end === 0 ? a.from : a.to;
      const cuff = new THREE.SphereGeometry(1, 14, 8);
      cuff.scale(0.07, 0.05, 0.11);
      cuff.translate(pnt.x, pnt.y + (end === 0 ? 0.02 : -0.015), pnt.z + 0.01);
      parts.push(tint(cuff, 0xe8e8e4, 0.35, 0));
    }
  }

  // Lights anchors.
  const tip = (side: number) => {
    const ax = WING.tipEnd;
    const ch = wingChord(ax);
    const z = wingLEz(ax) + 0.3 + 0.06;
    const y = wingLEy(ax) - 0.045 - ch * 0.02;
    return new THREE.Vector3(side * (ax + 0.012), y, z);
  };
  const lampAt = (ax: number) => {
    const le = wingPoint(-1, ax, 0.0, 0, { x: 0, y: 0, z: 0 });
    return new THREE.Vector3(le.x, le.y - 0.008, le.z - 0.002);
  };

  return {
    paint: mergePlain(paint),
    parts,
    ailerons,
    flaps,
    tipLight: { left: tip(-1), right: tip(1) },
    lamps: { landing: lampAt(1.66), taxi: lampAt(1.8) },
  };
}

function strutEnds(side: number) {
  const c = (STRUT.wing.z - wingLEz(STRUT.wing.x)) / wingChord(STRUT.wing.x);
  const lower = wingPoint(side, STRUT.wing.x, c, nacaCamber(WING.m, WING.p, c) - 0.04, { x: 0, y: 0, z: 0 });
  const from = new THREE.Vector3(side * STRUT.fuselage.x, STRUT.fuselage.y, STRUT.fuselage.z);
  const to = new THREE.Vector3(lower.x, lower.y + 0.02, lower.z);
  return { from, to };
}

function buildStrut(side: number): THREE.BufferGeometry {
  const { from, to } = strutEnds(side);
  const axis = to.clone().sub(from).normalize();
  const chordDir = new THREE.Vector3(0, 0, 1).addScaledVector(axis, -axis.z).normalize();
  const thickDir = new THREE.Vector3().crossVectors(axis, chordDir).normalize();
  const sec = symmetricRing(STRUT.thickness, 12);
  const rings: number[][] = [];
  const k = 5;
  for (let i = 0; i < k; i++) {
    const s = -0.03 + (1.06 * i) / (k - 1);
    const c = from.clone().lerp(to, s);
    const ring: number[] = [];
    for (let j = 0; j < sec.length; j += 2) {
      const cc = (sec[j] - 0.4) * STRUT.chord;
      const tt = sec[j + 1] * STRUT.chord;
      ring.push(c.x + chordDir.x * cc + thickDir.x * tt, c.y + chordDir.y * cc + thickDir.y * tt, c.z + chordDir.z * cc + thickDir.z * tt);
    }
    rings.push(ring);
  }
  return loftGeometry(rings, { capStart: true, capEnd: true });
}

function mergePlain(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  return mergeGeometriesSafe(list);
}

export function mergeGeometriesSafe(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(list, false);
  if (!g) throw new Error('aircraft: merge failed');
  for (const x of list) x.dispose();
  return g;
}
