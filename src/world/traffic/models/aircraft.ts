/**
 * Procedural low-poly traffic aircraft (body frame: nose −Z, right wing +X, up
 * +Y, origin at the CG; wheels at y = −GEAR_HEIGHT): a high-wing Cessna 172
 * (struts, spring-steel gear with wheel pants), a low-wing Piper PA-28 Warrior
 * (stabilator), an AS350-style helicopter (bubble cabin, skids, tail boom) and
 * an A320-like airliner (swept wings, CFM nacelles). Livery stripes and tails
 * are "tint" vertices coloured by the instance colour. Discs (props/rotors)
 * are listed for the instanced blur-disc mesh.
 */
import { MeshBuilder, mat, type Mat } from './builder';
import type { AirKind } from '../air';

const WHITE = mat(0xf1f1ee, 0.32);
const TINT = mat(0xffffff, 0.35, 0, 1);
const GLASS = mat(0x0c1218, 0.05, 0.2);
const GREY = mat(0x9ca1a6, 0.45, 0.3);
const DARK = mat(0x26282b, 0.55, 0.2);
const BELLY = mat(0xb9bcbf, 0.4, 0.2);
const METAL = mat(0xc4c8cc, 0.3, 0.8);
const TYRE = mat(0x1a1a1a, 0.8);

export interface Disc {
  /** Centre in the body frame. */
  c: [number, number, number];
  /** Axis the disc faces along ('z' = propeller facing forward, 'y' = main rotor, 'x' = tail rotor). */
  axis: 'x' | 'y' | 'z';
  r: number;
  blades: number;
}

export const DISCS: Record<AirKind, Disc[]> = {
  c172: [{ c: [0, 0.02, -3.3], axis: 'z', r: 0.96, blades: 2 }],
  pa28: [{ c: [0, -0.05, -3.25], axis: 'z', r: 0.94, blades: 2 }],
  heli: [
    { c: [0, 2.05, -0.25], axis: 'y', r: 5.35, blades: 3 },
    { c: [0.42, 1.25, 7.7], axis: 'x', r: 0.93, blades: 2 },
  ],
  a320: [],
};

/** Light positions in the body frame: nav (red left / green right / white tail), strobes, beacon, landing. */
export const LIGHTS: Record<AirKind, { navL: number[]; navR: number[]; tail: number[]; beacon: number[]; landing: number[] }> = {
  c172: { navL: [-5.5, 1.0, -0.6], navR: [5.5, 1.0, -0.6], tail: [0, 1.95, 5.05], beacon: [0, 2.05, 4.6], landing: [-1.6, 0.9, -1.1] },
  pa28: { navL: [-5.35, -0.3, -0.3], navR: [5.35, -0.3, -0.3], tail: [0, 1.55, 4.7], beacon: [0, 1.62, 4.3], landing: [0, -0.2, -3.0] },
  heli: { navL: [-1.05, 0.5, 5.9], navR: [1.05, 0.5, 5.9], tail: [0, 1.9, 7.9], beacon: [0, 1.55, 0.6], landing: [0, -0.8, -1.9] },
  a320: { navL: [-17.9, 0.9, 3.6], navR: [17.9, 0.9, 3.6], tail: [0, 1.4, 18.9], beacon: [0, 2.2, -1], landing: [-4.0, -1.6, -3.0] },
};

type Station = { z: number; hw: number; top: number; bot: number };

/** A fuselage loft through stations; `matAt(zMid, yMid, xMid)` paints each quad. */
function fuselage(b: MeshBuilder, st: Station[], around: number, n: number, matAt: (z: number, y: number, x: number, up: boolean) => Mat): void {
  const rings: [number, number, number][][] = st.map((s) => {
    const mid = (s.top + s.bot) / 2;
    const pts: [number, number, number][] = [];
    for (let k = 0; k < around; k++) {
      const a = (k / around) * Math.PI * 2;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      const x = s.hw * Math.sign(c) * Math.pow(Math.abs(c), 2 / n);
      const y = sn >= 0 ? mid + (s.top - mid) * Math.pow(sn, 2 / n) : mid - (mid - s.bot) * Math.pow(-sn, 2 / n);
      pts.push([x, y, s.z]);
    }
    return pts;
  });
  b.loft(
    rings,
    (i, j) => {
      const p = rings[i][j];
      const q = rings[i + 1][(j + 1) % around];
      const zm = (p[2] + q[2]) / 2;
      const ym = (p[1] + q[1]) / 2;
      const xm = (p[0] + q[0]) / 2;
      return matAt(zm, ym, xm, Math.sin(((j + 0.5) / around) * Math.PI * 2) > 0);
    },
    true,
  );
}

/**
 * A wing panel pair (mirrored): root at x = xRoot, tip at xRoot + span, leading edge z at the root
 * `zLE`, `sweep` = LE z offset at the tip, dihedral (deg), thickness (fraction of chord).
 */
function wingPair(b: MeshBuilder, o: { xRoot: number; span: number; y: number; zLE: number; root: number; tip: number; sweep: number; dihedral: number; thick: number; m: Mat; tipM?: Mat; sections?: number }): void {
  const n = o.sections ?? 3;
  for (const side of [-1, 1]) {
    const secs: [number, number, number][][] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = o.xRoot + o.span * t;
      const y = o.y + Math.tan((o.dihedral * Math.PI) / 180) * o.span * t;
      const chord = o.root + (o.tip - o.root) * t;
      const le = o.zLE + o.sweep * t;
      const th = chord * o.thick;
      // airfoil ring: LE, upper 30%, TE, lower 30% (closed)
      secs.push([
        [side * x, y, le],
        [side * x, y + th * 0.75, le + chord * 0.3],
        [side * x, y + th * 0.1, le + chord],
        [side * x, y - th * 0.25, le + chord * 0.35],
      ]);
    }
    b.loft(secs, (i) => (o.tipM && i === n - 1 ? o.tipM : o.m), true, side < 0);
    // tip cap
    const tip = secs[n];
    b.poly(side > 0 ? [tip[0], tip[3], tip[2], tip[1]] : [tip[0], tip[1], tip[2], tip[3]], o.tipM ?? o.m);
  }
}

/** A vertical fin: root chord at y0 from zLE0, tip at y1 from zLE1. */
function fin(b: MeshBuilder, y0: number, y1: number, zLE0: number, c0: number, zLE1: number, c1: number, th: number, m: Mat): void {
  const ring = (y: number, le: number, c: number): [number, number, number][] => [
    [0, y, le],
    [th / 2, y, le + c * 0.3],
    [0, y, le + c],
    [-th / 2, y, le + c * 0.3],
  ];
  const r0 = ring(y0, zLE0, c0);
  const r1 = ring(y1, zLE1, c1);
  b.loft([r0, r1], () => m, true, true);
  b.poly([r1[0], r1[1], r1[2], r1[3]].reverse() as [number, number, number][], m);
}

function wheel(b: MeshBuilder, x: number, y: number, z: number, r: number, w: number, pant: boolean): void {
  b.cylinder([x - w / 2, y, z], [x + w / 2, y, z], r, r, 10, TYRE);
  if (pant) {
    b.with([x, y + r * 0.2, z + 0.05], null, () => {
      fuselage(b, [
        { z: -0.55, hw: 0.02, top: 0.02, bot: -0.02 },
        { z: -0.35, hw: 0.14, top: 0.18, bot: -0.2 },
        { z: 0.1, hw: 0.16, top: 0.22, bot: -0.24 },
        { z: 0.55, hw: 0.03, top: 0.12, bot: 0.02 },
      ], 8, 2.2, () => WHITE);
    });
  }
}

function c172(b: MeshBuilder, lod: number): void {
  const st: Station[] = [
    { z: -3.36, hw: 0.02, top: 0.07, bot: -0.03 },
    { z: -3.2, hw: 0.2, top: 0.2, bot: -0.2 },
    { z: -3.05, hw: 0.42, top: 0.32, bot: -0.42 },
    { z: -2.5, hw: 0.53, top: 0.45, bot: -0.56 },
    { z: -1.65, hw: 0.57, top: 0.55, bot: -0.62 },
    { z: -1.0, hw: 0.6, top: 0.98, bot: -0.63 },
    { z: 0.45, hw: 0.58, top: 0.98, bot: -0.58 },
    { z: 1.3, hw: 0.49, top: 0.72, bot: -0.43 },
    { z: 2.6, hw: 0.32, top: 0.46, bot: -0.14 },
    { z: 4.0, hw: 0.16, top: 0.36, bot: 0.1 },
    { z: 4.95, hw: 0.05, top: 0.32, bot: 0.22 },
  ];
  const paint = (z: number, y: number, x: number): Mat => {
    if (z < -3.0) return METAL; // spinner
    // windscreen, side and rear windows
    if (z > -1.62 && z < -1.0 && y > 0.55) return GLASS;
    if (z > -0.95 && z < 0.4 && y > 0.36 && y < 0.92 && Math.abs(x) > 0.4) return GLASS;
    if (z > 0.45 && z < 1.25 && y > 0.6) return GLASS;
    // cheatline stripe
    if (y > -0.05 && y < 0.14 && z > -2.9) return TINT;
    return WHITE;
  };
  fuselage(b, lod ? st.filter((_, i) => i % 2 === 0 || i === st.length - 1) : st, lod ? 8 : 16, 2.6, paint);
  // high wing (constant-chord inner, tapered outer), struts
  wingPair(b, { xRoot: 0.0, span: 2.5, y: 1.0, zLE: -1.0, root: 1.62, tip: 1.62, sweep: 0, dihedral: 1.7, thick: 0.13, m: WHITE, sections: 1 });
  wingPair(b, { xRoot: 2.5, span: 3.0, y: 1.0 + 0.074, zLE: -1.0, root: 1.62, tip: 1.12, sweep: 0.25, dihedral: 1.7, thick: 0.12, m: WHITE, tipM: TINT, sections: lod ? 1 : 3 });
  for (const s of [-1, 1]) b.cylinder([s * 0.56, -0.42, -0.35], [s * 2.55, 0.98, -0.55], 0.05, 0.04, 4, WHITE, false);
  // tail: horizontal stabiliser + elevator, swept fin with a tinted band
  wingPair(b, { xRoot: 0.05, span: 1.7, y: 0.28, zLE: 3.95, root: 1.15, tip: 0.8, sweep: 0.3, dihedral: 0, thick: 0.09, m: WHITE, sections: 1 });
  fin(b, 0.3, 1.9, 3.25, 1.7, 4.45, 0.65, 0.12, WHITE);
  fin(b, 1.35, 1.72, 3.75, 1.2, 3.95, 1.0, 0.125, TINT);
  // gear: spring-steel mains with pants, nose leg with pant
  if (!lod) {
    for (const s of [-1, 1]) {
      b.cylinder([s * 0.45, -0.55, -0.05], [s * 1.2, -0.95, 0.05], 0.05, 0.04, 4, WHITE, false);
      wheel(b, s * 1.25, -0.9, 0.05, 0.3, 0.16, true);
    }
    b.cylinder([0, -0.55, -2.35], [0, -0.92, -2.45], 0.05, 0.05, 5, METAL, false);
    wheel(b, 0, -0.9, -2.45, 0.26, 0.13, true);
  } else {
    for (const s of [-1, 1]) b.box(s * 1.2, -0.9, 0.05, 0.3, 0.5, 0.9, WHITE);
    b.box(0, -0.9, -2.45, 0.25, 0.5, 0.8, WHITE);
  }
}

function pa28(b: MeshBuilder, lod: number): void {
  const st: Station[] = [
    { z: -3.3, hw: 0.02, top: 0.03, bot: -0.08 },
    { z: -3.15, hw: 0.2, top: 0.12, bot: -0.28 },
    { z: -2.95, hw: 0.45, top: 0.25, bot: -0.5 },
    { z: -2.2, hw: 0.55, top: 0.38, bot: -0.6 },
    { z: -1.5, hw: 0.58, top: 0.45, bot: -0.62 },
    { z: -0.75, hw: 0.6, top: 0.82, bot: -0.62 },
    { z: 0.55, hw: 0.58, top: 0.8, bot: -0.58 },
    { z: 1.4, hw: 0.46, top: 0.58, bot: -0.42 },
    { z: 2.7, hw: 0.3, top: 0.36, bot: -0.2 },
    { z: 4.0, hw: 0.14, top: 0.28, bot: 0.02 },
    { z: 4.75, hw: 0.04, top: 0.24, bot: 0.12 },
  ];
  const paint = (z: number, y: number, x: number): Mat => {
    if (z < -2.95) return METAL;
    if (z > -1.5 && z < -0.75 && y > 0.42) return GLASS;
    if (z > -0.7 && z < 1.2 && y > 0.32 && y < 0.76 && Math.abs(x) > 0.38) return GLASS;
    if (y > -0.34 && y < -0.12 && z > -2.8) return TINT; // Piper stripe low on the fuselage
    if (y > 0.22 && y < 0.3 && z > 1.0) return TINT;
    return WHITE;
  };
  fuselage(b, lod ? st.filter((_, i) => i % 2 === 0 || i === st.length - 1) : st, lod ? 8 : 16, 2.5, paint);
  // low wing: constant-chord Hershey bar → tapered Warrior outer panels
  wingPair(b, { xRoot: 0.0, span: 2.6, y: -0.52, zLE: -1.1, root: 1.6, tip: 1.6, sweep: 0, dihedral: 7, thick: 0.13, m: WHITE, sections: 1 });
  wingPair(b, { xRoot: 2.6, span: 2.75, y: -0.52 + 0.32, zLE: -1.1, root: 1.6, tip: 1.07, sweep: 0.28, dihedral: 7, thick: 0.12, m: WHITE, tipM: TINT, sections: lod ? 1 : 3 });
  // stabilator + fin
  wingPair(b, { xRoot: 0.05, span: 1.8, y: 0.2, zLE: 3.85, root: 0.78, tip: 0.78, sweep: 0, dihedral: 0, thick: 0.09, m: WHITE, sections: 1 });
  fin(b, 0.24, 1.6, 3.35, 1.3, 4.1, 0.65, 0.12, WHITE);
  fin(b, 1.1, 1.45, 3.65, 1.05, 3.85, 0.85, 0.125, TINT);
  if (!lod) {
    for (const s of [-1, 1]) {
      b.cylinder([s * 1.45, -0.55, -0.4], [s * 1.5, -0.85, -0.35], 0.05, 0.05, 5, METAL, false);
      wheel(b, s * 1.5, -0.78, -0.35, 0.27, 0.15, true);
    }
    b.cylinder([0, -0.55, -2.4], [0, -0.8, -2.45], 0.05, 0.05, 5, METAL, false);
    wheel(b, 0, -0.8, -2.45, 0.24, 0.12, true);
  }
}

function heli(b: MeshBuilder, lod: number): void {
  const st: Station[] = [
    { z: -2.35, hw: 0.1, top: 0.2, bot: -0.3 },
    { z: -2.1, hw: 0.55, top: 0.75, bot: -0.62 },
    { z: -1.5, hw: 0.8, top: 1.08, bot: -0.8 },
    { z: -0.4, hw: 0.86, top: 1.22, bot: -0.82 },
    { z: 0.8, hw: 0.8, top: 1.18, bot: -0.72 },
    { z: 1.7, hw: 0.5, top: 1.05, bot: -0.2 },
    { z: 2.2, hw: 0.3, top: 0.95, bot: 0.3 },
  ];
  const paint = (z: number, y: number, x: number): Mat => {
    if (z < -0.9 && y > -0.35) return GLASS; // big bubble canopy
    if (z > -0.9 && z < 0.5 && y > 0.1 && y < 0.95 && Math.abs(x) > 0.55) return GLASS; // doors
    if (y < -0.3) return WHITE;
    return TINT;
  };
  fuselage(b, st, lod ? 8 : 16, 2.2, paint);
  // engine deck, mast, tail boom, stabiliser, fins
  b.prism(0, 0.6, 1.1, 1.55, 1.2, 2.4, 0.9, 1.9, TINT, 0.1);
  b.cylinder([0, 1.5, -0.25], [0, 2.05, -0.25], 0.12, 0.1, 6, DARK, false);
  b.cylinder([0, 0.72, 2.0], [0, 0.95, 7.3], 0.34, 0.14, lod ? 6 : 10, TINT);
  wingPair(b, { xRoot: 0.12, span: 1.05, y: 0.85, zLE: 5.8, root: 0.55, tip: 0.45, sweep: 0.05, dihedral: 0, thick: 0.12, m: TINT, sections: 1 });
  fin(b, 0.9, 1.95, 6.9, 0.9, 7.55, 0.5, 0.1, TINT);
  fin(b, 0.2, 0.9, 7.1, 0.6, 7.2, 0.5, 0.1, TINT);
  // skids
  if (!lod) {
    for (const s of [-1, 1]) {
      b.cylinder([s * 1.05, -1.2, -1.6], [s * 1.05, -1.2, 1.4], 0.05, 0.05, 5, METAL, false);
      b.cylinder([s * 1.05, -1.2, -1.6], [s * 1.0, -1.05, -2.0], 0.05, 0.05, 5, METAL, false);
      for (const z of [-0.9, 0.7]) b.cylinder([s * 0.55, -0.7, z], [s * 1.05, -1.2, z], 0.05, 0.05, 5, METAL, false);
    }
  }
}

function a320(b: MeshBuilder, lod: number): void {
  const R = 1.98;
  const st: Station[] = [
    { z: -18.9, hw: 0.05, top: -0.1, bot: -0.3 },
    { z: -18.4, hw: 0.9, top: 0.6, bot: -1.2 },
    { z: -17.2, hw: 1.6, top: 1.35, bot: -1.75 },
    { z: -15.5, hw: R, top: R, bot: -R },
    { z: 8.0, hw: R, top: R, bot: -R },
    { z: 13.5, hw: 1.5, top: R * 0.95, bot: -0.6 },
    { z: 17.5, hw: 0.6, top: 1.6, bot: 0.9 },
    { z: 18.9, hw: 0.15, top: 1.35, bot: 1.1 },
  ];
  const paint = (z: number, y: number, x: number, up: boolean): Mat => {
    if (z < -17.0 && z > -18.3 && y > 0.25 && y < 1.3) return GLASS; // cockpit windows
    if (!up && y < -0.9) return BELLY;
    if (z > -16 && z < 12 && y > 0.35 && y < 0.75 && Math.abs(x) > 1.6) return lod ? WHITE : GLASS; // cabin window line
    if (z > 12 && y > 0.4) return TINT;
    return WHITE;
  };
  const ring = lod ? 8 : 16;
  // extra stations along the window line so the band shows
  fuselage(b, st, ring, 2, paint);
  // wings: 25° sweep, 5° dihedral, root at the lower fuselage
  wingPair(b, { xRoot: 1.5, span: 16.0, y: -1.3, zLE: -3.2, root: 6.2, tip: 1.6, sweep: 7.4, dihedral: 5, thick: 0.1, m: GREY, sections: lod ? 1 : 3 });
  // sharklets
  for (const s of [-1, 1]) b.with([s * 17.5, -1.3 + Math.tan((5 * Math.PI) / 180) * 16, 4.3], null, () => fin(b, 0, 2.3, 0, 1.4, 0.9, 0.55, 0.12, TINT));
  // engines under the wings
  for (const s of [-1, 1]) {
    b.cylinder([s * 5.75, -2.5, -7.4], [s * 5.75, -2.5, -3.0], 1.05, 0.9, lod ? 8 : 14, TINT);
    b.cylinder([s * 5.75, -2.5, -7.45], [s * 5.75, -2.5, -7.3], 0.85, 0.85, lod ? 8 : 14, DARK);
    b.cylinder([s * 5.75, -2.5, -3.0], [s * 5.75, -2.4, -1.8], 0.6, 0.35, 8, GREY, true);
    b.box(s * 5.75, -1.6, -3.4, 0.35, 1.0, 3.2, GREY); // pylon
  }
  // horizontal tail and fin
  wingPair(b, { xRoot: 0.8, span: 5.6, y: 0.7, zLE: 13.2, root: 3.6, tip: 1.3, sweep: 3.2, dihedral: 6, thick: 0.09, m: GREY, sections: 1 });
  fin(b, R * 0.9, 7.9, 10.8, 6.2, 15.3, 2.2, 0.3, TINT);
}

/** Builds an aircraft model at a level of detail. */
export function buildAircraft(kind: AirKind, lod: number): MeshBuilder {
  const b = new MeshBuilder();
  if (kind === 'c172') c172(b, lod);
  else if (kind === 'pa28') pa28(b, lod);
  else if (kind === 'heli') heli(b, lod);
  else a320(b, lod);
  return b;
}

/** Livery colours (instance tint) per kind: stripes / tails / body. */
export const LIVERIES: Record<AirKind, number[]> = {
  c172: [0x1f3f7a, 0x8a1d1d, 0x2d6a3e],
  pa28: [0x7a1e1a, 0x1d3b6b, 0xc7922a],
  heli: [0x1c2c4c, 0xb52a1e],
  a320: [0x1d3f8f, 0xc0392b, 0x0f6b5c, 0x5a2d82],
};
