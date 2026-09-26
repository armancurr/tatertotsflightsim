/**
 * The JetRanger's tail: the horizontal stabiliser (inverted cambered section, span and chord from
 * geometry.horizontalTail) with small vertical endplates, the swept upper fin (its tip is
 * geometry.verticalTailTop and the airframe's aft-most point), the lower fin with the tubular tail
 * skid (the `tailBumper` structural point), the driveshaft cover along the boom and the tail-rotor
 * gearbox at the end of the boom.
 */
import * as THREE from 'three';
import { loftGeometry } from '../loft';
import { nacaRing } from '../airfoil';
import { merge, plain, tint } from '../materials';
import { box, ellipsoid, tube, V } from '../f16/geom';
import { B206_AIRCRAFT } from '../../config';
import { FIN_TOP, STAB, TAIL_BUMPER, TAIL_ROTOR, Z_BOOM_END, Z_TAIL_END, boomCy, boomR, DEG } from './shape';

const PAINT = { white: 0xf3f4f0, blue: 0x162856, gold: 0xc99e3e } as const;

/** Section ring (2D NACA) placed in the plane x = const (a horizontal surface): chord along z. */
function hRing(sec: number[], x: number, y: number, zLE: number, chord: number, incidence: number): number[] {
  const out: number[] = [];
  const c = Math.cos(incidence);
  const s = Math.sin(incidence);
  for (let k = 0; k < sec.length; k += 2) {
    const zc = sec[k] * chord;
    const yc = sec[k + 1] * chord;
    // Incidence: + = leading edge up (rotate about the quarter chord).
    const dz = zc - 0.25 * chord;
    out.push(x, y + yc * c - dz * s, zLE + 0.25 * chord + dz * c + yc * s);
  }
  return out;
}

/** Section ring in the plane y = const (a vertical surface): chord along z, thickness along x. */
function vRing(sec: number[], y: number, zLE: number, chord: number, xOff = 0): number[] {
  const out: number[] = [];
  for (let k = 0; k < sec.length; k += 2) out.push(xOff + sec[k + 1] * chord, y, zLE + sec[k] * chord);
  return out;
}

export interface TailGeometry {
  /** Painted: stabiliser + endplates (a separately named mesh, for the anchor tests). */
  stab: THREE.BufferGeometry;
  /** Painted: fins, driveshaft cover. */
  paint: THREE.BufferGeometry;
  /** Parts: gearbox, tail skid, hangers, light housings. */
  parts: THREE.BufferGeometry;
  /** Tail light lens position (white, aft) and the nav lights on the endplates (left red, right green). */
  lights: { tail: THREE.Vector3; navLeft: THREE.Vector3; navRight: THREE.Vector3; beaconTop: THREE.Vector3 };
}

/** Upper fin: root on the boom end, swept tip at FIN_TOP.y reaching back to the airframe's end. */
export const UPPER_FIN = {
  root: { y: 0.4, zLE: 5.8, chord: 0.6 },
  tip: { y: FIN_TOP.y, zLE: 6.48, chord: Z_TAIL_END - 6.48 },
  thickness: 0.11,
} as const;
export const LOWER_FIN = {
  root: { y: 0.3, zLE: 5.9, chord: 0.5 },
  tip: { y: -0.16, zLE: 6.2, chord: 0.26 },
  thickness: 0.1,
} as const;

function finLoft(ys: number[], fin: typeof UPPER_FIN | typeof LOWER_FIN, caps: { start?: boolean; end?: boolean }): THREE.BufferGeometry {
  const sec = nacaRing({ m: 0, p: 0, t: fin.thickness, n: 12 });
  const rings = ys.map((y) => {
    const t = (y - fin.root.y) / (fin.tip.y - fin.root.y);
    const zLE = fin.root.zLE + (fin.tip.zLE - fin.root.zLE) * t;
    const chord = fin.root.chord + (fin.tip.chord - fin.root.chord) * t;
    return vRing(sec, y, zLE, chord);
  });
  return plain(loftGeometry(rings, { capStart: caps.start, capEnd: caps.end }));
}

function stabGeometry(): THREE.BufferGeometry {
  const half = STAB.span / 2;
  const endT = 0.024;
  const inner = half - endT;
  // Inverted camber (the JetRanger's stabiliser pushes the tail down in forward flight).
  const sec = nacaRing({ m: 0.03, p: 0.4, t: 0.12, n: 14 }).map((v, i) => (i % 2 ? -v : v));
  const inc = B206_AIRCRAFT.rotorcraft!.airframe.stab.incidenceDeg * DEG;
  const zLE = STAB.z - STAB.chord / 2;
  const xs = [-inner, -inner * 0.5, 0, inner * 0.5, inner];
  const stab = tint(loftGeometry(xs.map((x) => hRing(sec, x, STAB.y, zLE, STAB.chord, inc)), { capStart: true, capEnd: true }), PAINT.white, 0.32);
  // Endplates: small vertical fins centred on the stabiliser's tips, symmetric about its plane.
  const ep: THREE.BufferGeometry[] = [];
  const esec = nacaRing({ m: 0, p: 0, t: 0.09, n: 10 });
  for (const s of [-1, 1]) {
    const x = s * (half - endT / 2);
    const h = 0.11;
    const rings = [-h, -h * 0.5, 0, h * 0.5, h].map((dy) => {
      const k = Math.abs(dy) / h;
      const chord = 0.3 - 0.08 * k;
      const zl = STAB.z - 0.17 + 0.05 * k;
      const r: number[] = [];
      for (let i = 0; i < esec.length; i += 2) r.push(x + (esec[i + 1] * endT) / 0.09, STAB.y + dy, zl + esec[i] * chord);
      return r;
    });
    ep.push(tint(loftGeometry(rings, { capStart: true, capEnd: true }), PAINT.blue, 0.32));
  }
  return merge([stab, ...ep]);
}

function paintGeometry(): THREE.BufferGeometry {
  const g: THREE.BufferGeometry[] = [];
  // Upper fin: white, a gold stripe, a dark blue tip.
  const f = UPPER_FIN;
  g.push(tint(finLoft([f.root.y, 0.7, 1.0, 1.24], f, { start: true }), PAINT.white, 0.32));
  g.push(tint(finLoft([1.24, 1.275], f, {}), PAINT.gold, 0.35));
  g.push(tint(finLoft([1.275, 1.4, f.tip.y], f, { end: true }), PAINT.blue, 0.32));
  // Lower fin: blue (it continues the belly colour).
  const l = LOWER_FIN;
  g.push(tint(finLoft([l.root.y, 0.1, -0.05, l.tip.y], l, { start: true, end: true }), PAINT.blue, 0.32));
  // Driveshaft cover: a low half-round fairing along the top of the boom.
  const zs: number[] = [];
  for (let k = 0; k <= 24; k++) zs.push(2.18 + ((5.78 - 2.18) * k) / 24);
  const rings = zs.map((z) => {
    const end = Math.min(1, (z - 2.18) / 0.15, (5.78 - z) / 0.12);
    const k = Math.sqrt(Math.max(0.02, 1 - (1 - Math.max(0, end)) ** 2));
    const top = boomCy(z) + boomR(z);
    const w = 0.07 * Math.max(0.15, k);
    const h = 0.065 * Math.max(0.1, k);
    const r: number[] = [];
    const N = 20;
    for (let j = 0; j <= N; j++) {
      const th = (Math.PI * j) / N;
      const c = Math.cos(th);
      r.push((c < 0 ? -1 : 1) * w * Math.pow(Math.abs(c), 2 / 2.4), top - 0.02 + (h + 0.02) * Math.pow(Math.sin(th), 2 / 2.4), z);
    }
    r.push(-w * 0.8, top - 0.04, z, w * 0.8, top - 0.04, z);
    return r;
  });
  g.push(tint(plain(loftGeometry(rings, { capStart: true, capEnd: true })), PAINT.white, 0.32));
  return merge(g);
}

function partsGeometry(): THREE.BufferGeometry {
  const g: THREE.BufferGeometry[] = [];
  const h = TAIL_ROTOR.hub;
  const zb = h.z;
  const top = boomCy(zb) + boomR(zb);
  // Tail-rotor gearbox on the end of the boom, its output shaft out to the left, the input quill.
  g.push(tint(ellipsoid(V(-0.03, top + 0.035, zb), 0.1, 0.075, 0.14, 16, 10), 0x8e9398, 0.45, 0.55));
  g.push(tint(tube(V(-0.08, h.y, zb), V(h.x + 0.05, h.y, zb), 0.035, 0.03, 12), 0x7b8085, 0.4, 0.7));
  g.push(tint(tube(V(0, top + 0.03, zb - 0.28), V(0, top + 0.03, zb - 0.1), 0.028, 0.028, 10), 0x7b8085, 0.4, 0.7));
  g.push(tint(box(0.1, 0.03, 0.16, V(-0.03, top - 0.005, zb)), 0x6b7075, 0.5, 0.5));
  // Tail skid: a steel tube loop under the lower fin, lowest at the tail-bumper point.
  const b = TAIL_BUMPER;
  const rT = 0.019;
  const path = new THREE.CatmullRomCurve3(
    [V(0, -0.08, 6.12), V(0, -0.27, b.z - 0.13), V(0, b.y + rT, b.z), V(0, b.y + rT + 0.03, b.z + 0.13), V(0, -0.14, 6.45)],
    false,
    'centripetal',
  );
  g.push(tint(new THREE.TubeGeometry(path, 40, rT, 10, false), 0x3a3c3f, 0.45, 0.6));
  g.push(tint(ellipsoid(V(0, b.y + rT + 0.002, b.z + 0.01), 0.022, 0.012, 0.05, 10, 6), 0x55585c, 0.5, 0.6));
  // Driveshaft hangers peeking out under the cover, and the boom's attachment fittings at the joint.
  for (const z of [2.9, 3.7, 4.5, 5.3]) g.push(tint(box(0.16, 0.012, 0.05, V(0, boomCy(z) + boomR(z) - 0.012, z)), 0x9aa0a4, 0.45, 0.6));
  // Aft end cap trim and the tail-light housing.
  const cy = boomCy(Z_BOOM_END);
  g.push(tint(tube(V(0, cy, Z_BOOM_END - 0.01), V(0, cy, Z_BOOM_END + 0.04), 0.04, 0.035, 12), 0x2c2d30, 0.5, 0.3));
  // Beacon base on the driveshaft cover.
  const bz = 2.75;
  const btop = boomCy(bz) + boomR(bz) + 0.045;
  g.push(tint(tube(V(0, btop - 0.01, bz), V(0, btop + 0.012, bz), 0.04, 0.04, 14), 0x2c2d30, 0.5, 0.3));
  return merge(g);
}

export function buildTail(): TailGeometry {
  const cy = boomCy(Z_BOOM_END);
  const bz = 2.75;
  return {
    stab: stabGeometry(),
    paint: paintGeometry(),
    parts: partsGeometry(),
    lights: {
      tail: V(0, cy, Z_BOOM_END + 0.055),
      navLeft: V(-(STAB.span / 2 - 0.012), STAB.y + 0.03, STAB.z - 0.172),
      navRight: V(STAB.span / 2 - 0.012, STAB.y + 0.03, STAB.z - 0.172),
      beaconTop: V(0, boomCy(bz) + boomR(bz) + 0.045 + 0.012, bz),
    },
  };
}
