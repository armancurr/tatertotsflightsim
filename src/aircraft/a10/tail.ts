/**
 * A-10 tail: the straight horizontal stabiliser across the tail cone with the elevators (one mesh,
 * one hinge line), and the two rectangular fins as its end plates, each with its rudder in an upper
 * and a lower section (split by the stabiliser). Hinge frames are in body coordinates.
 */
import * as THREE from 'three';
import { loftGeometry } from '../loft';
import { nacaRing } from '../airfoil';
import { merge } from '../materials';
import { finUV, stabUV } from './atlas';
import { airfoilPiece, mirrorX, V } from '../f16/geom';
import { FIN, STAB, finLeZ, finTeZ, lerp } from './shape';
import { span, type HingedPart } from './wing';

/** Elevator hinge line (z) — straight across both sides. */
export const ELEVATOR_HINGE_Z = 8.3;

function stabLeZ(x: number): number {
  return lerp(STAB.rootLeZ, STAB.tipLeZ, Math.min(1, Math.abs(x) / STAB.halfSpan));
}

/** Stabiliser section at span x as a ring (x fixed, y/z vary), chord fraction a..b of the full chord. */
function stabRing(x: number, a: number, b: number, n = 12): number[] {
  const le = stabLeZ(x);
  const c = STAB.teZ - le;
  const r = airfoilPiece(STAB.thickness, 0, 0.4, a, b, n);
  const out: number[] = [];
  for (let k = 0; k < r.length; k += 2) out.push(x, STAB.y + r[k + 1] * c, le + r[k] * c);
  return out;
}

function applyStabUV(g: THREE.BufferGeometry) {
  const p = g.getAttribute('position');
  const n = g.getAttribute('normal');
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const t: [number, number] = [0, 0];
  for (let i = 0; i < p.count; i++) {
    stabUV(p.getX(i), p.getZ(i), n.getY(i) >= 0, t);
    uv.setXY(i, t[0], t[1]);
  }
}

function applyFinUV(g: THREE.BufferGeometry, rightFin: boolean) {
  const p = g.getAttribute('position');
  const n = g.getAttribute('normal');
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const t: [number, number] = [0, 0];
  const cx = rightFin ? FIN.x : -FIN.x;
  for (let i = 0; i < p.count; i++) {
    const dx = p.getX(i) - cx;
    const side = Math.abs(dx) > 1e-4 ? dx : n.getX(i);
    const outer = rightFin ? side > 0 : side < 0;
    finUV(p.getZ(i), p.getY(i), rightFin, outer, t);
    uv.setXY(i, t[0], t[1]);
  }
}

/** Fin section at height y as a ring in the x/z plane (chord fraction a..b). */
function finRing(y: number, a: number, b: number, n = 14): number[] {
  const le = finLeZ(y);
  const c = finTeZ(y) - le;
  const r = airfoilPiece(FIN.thickness, 0, 0.4, a, b, n);
  const out: number[] = [];
  for (let k = 0; k < r.length; k += 2) out.push(FIN.x + r[k + 1] * c, y, le + r[k] * c);
  return out;
}
const hingeFrac = (y: number) => (FIN.rudderHingeZ - finLeZ(y)) / (finTeZ(y) - finLeZ(y));

export interface TailBuild {
  stab: THREE.BufferGeometry;
  elevators: HingedPart;
  finRight: THREE.BufferGeometry;
  finLeft: THREE.BufferGeometry;
  rudderRight: HingedPart;
  rudderLeft: HingedPart;
}

function buildFinRight(): { fin: THREE.BufferGeometry; rudder: HingedPart } {
  const F = FIN;
  const segs: THREE.BufferGeometry[] = [];
  const seg = (y0: number, y1: number, n: number, cut: boolean) =>
    segs.push(loftGeometry(span(y0, y1, n).map((y) => finRing(y, 0, cut ? hingeFrac(y) - 0.004 : 1)), { capStart: true, capEnd: true }));
  // Bottom (rounded) → lower rudder → stabiliser junction → upper rudder → rounded top.
  const bottom = [F.bottomY, F.bottomY + 0.01, F.bottomY + 0.04, F.bottomY + 0.09];
  segs.push(loftGeometry([...bottom, F.rudderLowerY0].map((y) => finRing(y, 0, 1)), { capStart: true, capEnd: true }));
  seg(F.rudderLowerY0, F.rudderLowerY1, 2, true);
  seg(F.rudderLowerY1, F.rudderUpperY0, 2, false);
  seg(F.rudderUpperY0, F.rudderUpperY1, 8, true);
  const topYs = [F.rudderUpperY1, 2.4, 2.46, 2.5, F.topY];
  segs.push(loftGeometry(topYs.map((y) => finRing(y, 0, 1)), { capStart: true, capEnd: true }));
  const fin = merge(segs);
  applyFinUV(fin, true);

  const rud = (y0: number, y1: number, n: number) =>
    loftGeometry(span(y0 + 0.01, y1 - 0.01, n).map((y) => {
      const le = finLeZ(y);
      const c = finTeZ(y) - le;
      const r = nacaRing({ m: 0, p: 0, t: F.thickness, n: 8, from: hingeFrac(y) + 0.004, nosePoints: 5 });
      const out: number[] = [];
      for (let k = 0; k < r.length; k += 2) out.push(F.x + r[k + 1] * c, y, le + r[k] * c);
      return out;
    }), { capStart: true, capEnd: true });
  const rg = merge([rud(F.rudderLowerY0, F.rudderLowerY1, 2), rud(F.rudderUpperY0, F.rudderUpperY1, 8)]);
  applyFinUV(rg, true);
  // Vertical hinge: local frame = body axes at the hinge point.
  const pos = V(F.x, 0, F.rudderHingeZ);
  rg.translate(-pos.x, -pos.y, -pos.z);
  return { fin, rudder: { geometry: rg, position: pos, quaternion: new THREE.Quaternion() } };
}

function mirrorFin(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const m = mirrorX(g);
  applyFinUV(m, false);
  return m;
}

export function buildTail(): TailBuild {
  // Stabiliser (fixed part, ahead of the hinge) across the whole span.
  const xs = span(-STAB.halfSpan, STAB.halfSpan, 16);
  const hf = (x: number) => (ELEVATOR_HINGE_Z - stabLeZ(x)) / (STAB.teZ - stabLeZ(x));
  const stab = loftGeometry(xs.map((x) => stabRing(x, 0, hf(x) - 0.003)), { capStart: true, capEnd: true });
  applyStabUV(stab);

  // Elevators: both sides in one mesh about one hinge line; the tail cone sits between them.
  const elev = (x0: number, x1: number) =>
    loftGeometry(span(x0, x1, 6).map((x) => {
      const le = stabLeZ(x);
      const c = STAB.teZ - le;
      const r = nacaRing({ m: 0, p: 0, t: STAB.thickness, n: 8, from: hf(x) + 0.003, nosePoints: 5 });
      const out: number[] = [];
      for (let k = 0; k < r.length; k += 2) out.push(x, STAB.y + r[k + 1] * c, le + r[k] * c);
      return out;
    }), { capStart: true, capEnd: true });
  const eg = merge([elev(STAB.elevatorX0, STAB.halfSpan - 0.08), elev(-STAB.halfSpan + 0.08, -STAB.elevatorX0)]);
  applyStabUV(eg);
  const epos = V(0, STAB.y, ELEVATOR_HINGE_Z);
  eg.translate(-epos.x, -epos.y, -epos.z);

  const r = buildFinRight();
  const finLeft = mirrorFin(r.fin);
  const rudLeftBody = r.rudder.geometry.clone().translate(r.rudder.position.x, r.rudder.position.y, r.rudder.position.z);
  const rudLeft = mirrorFin(rudLeftBody);
  rudLeftBody.dispose();
  const lpos = V(-FIN.x, 0, FIN.rudderHingeZ);
  rudLeft.translate(-lpos.x, -lpos.y, -lpos.z);
  return {
    stab,
    elevators: { geometry: eg, position: epos, quaternion: new THREE.Quaternion() },
    finRight: r.fin,
    finLeft,
    rudderRight: r.rudder,
    rudderLeft: { geometry: rudLeft, position: lpos, quaternion: new THREE.Quaternion() },
  };
}
