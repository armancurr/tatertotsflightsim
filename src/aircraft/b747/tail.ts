/**
 * 747-400 empennage: the tall swept fin (42° leading edge) with the split rudder (upper and lower
 * panels), and the 22.17 m stabiliser (40° leading edge, 7° dihedral) with inboard and outboard
 * elevators each side. Fin faces and stabiliser surfaces carry atlas UVs (the mascot lives on the
 * fin). Hinged parts come with their hinge frames: + rotation lowers an elevator trailing edge
 * and swings a rudder trailing edge to the right.
 */
import * as THREE from 'three';
import { loftGeometry } from '../loft';
import { nacaRing } from '../airfoil';
import { merge } from '../materials';
import { airfoilPiece, hingeFrame, mirrorX, toLocal, V } from '../f16/geom';
import { finUV, stabUV } from './atlas';
import { FIN, STAB, lerp } from './shape';
import { mirrorHinge, type HingedPart } from './wing';

export interface TailBuild {
  /** Fin + stabiliser fixed surfaces (paint). */
  surfaces: THREE.BufferGeometry;
  rudderUpper: HingedPart;
  rudderLower: HingedPart;
  elevators: { leftIn: HingedPart; leftOut: HingedPart; rightIn: HingedPart; rightOut: HingedPart };
  /** Logo lights on the stabiliser's upper surface, aimed at the fin. */
  logoLights: THREE.Vector3[];
}

function steps(a: number, b: number, step: number): number[] {
  const n = Math.max(1, Math.ceil((b - a) / step));
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(a + ((b - a) * i) / n);
  return out;
}

// ─── Fin ─────────────────────────────────────────────────────────────────────

const finChord = (y: number) => FIN.te(y) - FIN.le(y);
function finPoint(y: number, f: number, h: number): [number, number, number] {
  const c = finChord(y);
  return [h * c, y, FIN.le(y) + f * c];
}
function finLoft(ys: number[], ring: (y: number) => number[]): THREE.BufferGeometry {
  const rings = ys.map((y) => {
    const r = ring(y);
    const out: number[] = [];
    for (let k = 0; k < r.length; k += 2) out.push(...finPoint(y, r[k], r[k + 1]));
    return out;
  });
  return loftGeometry(rings, { closed: true, capStart: true, capEnd: true });
}
function applyFinUV(g: THREE.BufferGeometry) {
  const p = g.getAttribute('position');
  const n = g.getAttribute('normal');
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const t: [number, number] = [0, 0];
  for (let i = 0; i < p.count; i++) {
    finUV(p.getZ(i), p.getY(i), n.getX(i) >= 0, t);
    uv.setXY(i, t[0], t[1]);
  }
}

// ─── Stabiliser ──────────────────────────────────────────────────────────────

const stabChord = (x: number) => STAB.te(x) - STAB.le(x);
function stabPoint(x: number, f: number, h: number): [number, number, number] {
  const c = stabChord(x);
  // Slight negative incidence (the stabiliser trims nose-up at cruise).
  const inc = -1.5 * (Math.PI / 180);
  return [x, STAB.y(x) + h * c - Math.sin(inc) * (f - 0.3) * c, STAB.le(x) + f * c];
}
function stabLoft(xs: number[], ring: (x: number) => number[]): THREE.BufferGeometry {
  const rings = xs.map((x) => {
    const r = ring(x);
    const out: number[] = [];
    for (let k = 0; k < r.length; k += 2) out.push(...stabPoint(x, r[k], r[k + 1]));
    return out;
  });
  return loftGeometry(rings, { closed: true, capStart: true, capEnd: true });
}
function applyStabUV(g: THREE.BufferGeometry) {
  const p = g.getAttribute('position');
  const n = g.getAttribute('normal');
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const t: [number, number] = [0, 0];
  for (let i = 0; i < p.count; i++) {
    const ax = Math.min(STAB.tipX, Math.abs(p.getX(i)));
    const f = (p.getZ(i) - STAB.le(ax)) / stabChord(ax);
    stabUV(ax, f, n.getY(i) >= 0, t);
    uv.setXY(i, t[0], t[1]);
  }
}

function hinged(geo: THREE.BufferGeometry, a: THREE.Vector3, b: THREE.Vector3, up?: THREE.Vector3): HingedPart {
  const q = hingeFrame(b.clone().sub(a), up);
  toLocal(geo, a, q);
  return { geometry: geo, position: a.clone(), quaternion: q };
}

const plainAttrs = (g: THREE.BufferGeometry) => {
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
  return g;
};

export function buildTail(): TailBuild {
  const T = FIN.thickness;
  const RF = FIN.rudderF;
  // Fin: full sections below the rudder and at the tip cap, cut at the rudder hinge between.
  const finFull = (y: number) => airfoilPiece(T, 0, 0.4, 0, 1, 22);
  const finCut = (y: number) => airfoilPiece(T, 0, 0.4, 0, RF, 20);
  void finFull;
  const finParts = [
    finLoft(steps(FIN.rootY, FIN.rudderBottomY, 1), () => airfoilPiece(T, 0, 0.4, 0, 1, 22)),
    finLoft(steps(FIN.rudderBottomY, FIN.rudderTopY, 1.2), finCut),
    finLoft(steps(FIN.rudderTopY, FIN.topY, 0.25), () => airfoilPiece(T, 0, 0.4, 0, 1, 22)),
  ].map(plainAttrs);
  const fin = merge(finParts);
  applyFinUV(fin);

  const rudder = (y0: number, y1: number) => {
    const g = finLoft(steps(y0, y1, 1.4), () => nacaRing({ m: 0, p: 0, t: T, n: 10, from: RF + 0.004 }));
    applyFinUV(g);
    const a = V(...finPoint(y0, RF, 0));
    const b = V(...finPoint(y1, RF, 0));
    return hinged(g, a, b, V(-1, 0, 0));
  };
  const rudderLower = rudder(FIN.rudderBottomY + 0.02, FIN.rudderSplitY - 0.02);
  const rudderUpper = rudder(FIN.rudderSplitY + 0.02, FIN.rudderTopY - 0.02);

  // Stabiliser (right half, mirrored).
  const ST = STAB.thickness;
  const EF = STAB.elevatorF;
  const stabRing = (x: number) => airfoilPiece(ST, 0, 0.4, 0, 1, 20);
  const stabCut = () => airfoilPiece(ST, 0, 0.4, 0, EF, 18);
  void stabRing;
  const stabR = merge(
    [
      stabLoft(steps(0, STAB.elevatorInX, 1.3), () => airfoilPiece(ST, 0, 0.4, 0, 1, 20)),
      stabLoft(steps(STAB.elevatorInX, STAB.elevatorOutX, 1.2), stabCut),
      stabLoft(steps(STAB.elevatorOutX, STAB.tipX, 0.3), () => airfoilPiece(ST, 0, 0.4, 0, 1, 20)),
    ].map(plainAttrs),
  );
  const stabL = mirrorX(stabR);
  applyStabUV(stabR);
  applyStabUV(stabL);
  const surfaces = merge([fin, stabR, stabL]);

  const elevator = (x0: number, x1: number) => {
    const g = stabLoft(steps(x0, x1, 1.4), () => nacaRing({ m: 0, p: 0, t: ST, n: 10, from: EF + 0.004 }));
    applyStabUV(g);
    return hinged(g, V(...stabPoint(x0, EF, 0)), V(...stabPoint(x1, EF, 0)));
  };
  const rightIn = elevator(STAB.elevatorInX + 0.02, STAB.elevatorSplitX - 0.02);
  const rightOut = elevator(STAB.elevatorSplitX + 0.02, STAB.elevatorOutX - 0.02);
  const leftIn = mirrorHinge(rightIn, applyStabUV);
  const leftOut = mirrorHinge(rightOut, applyStabUV);

  const logoLights = [-1, 1].map((s) => {
    const x = 3.4;
    const p = stabPoint(x, 0.35, 0.05);
    return V(s * x, p[1] + 0.02, p[2]);
  });
  void lerp;
  return { surfaces, rudderUpper, rudderLower, elevators: { leftIn, leftOut, rightIn, rightOut }, logoLights };
}
