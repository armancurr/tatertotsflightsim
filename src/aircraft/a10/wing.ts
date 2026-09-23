/**
 * A-10 wing: the thick straight wing (16 % → 13 %), a constant-chord centre section (part of the
 * fuselage structure) and two tapered outer panels with ~6.5° dihedral ending in the drooped Hoerner
 * tips; inboard leading-edge slats (ahead of the engines), slotted flaps (centre + outer panel) and
 * the split decelerons (ailerons whose upper and lower halves open apart as the speed brake). Also
 * the main-gear pods under the centre section.
 *
 * Every hinged part comes with its hinge frame (body coordinates): local +X along the hinge, so a
 * positive rotation about +X lowers a trailing edge on both sides (the left hinges point inboard).
 */
import * as THREE from 'three';
import { loftGeometry } from '../loft';
import { nacaRing } from '../airfoil';
import { merge } from '../materials';
import { wingUV } from './atlas';
import { airfoilPiece, hingeFrame, mirrorX, toLocal, V } from '../f16/geom';
import { POD, WING, lerp, smooth, wingChord, wingLeZ, wingLowerY, wingRoll, wingThickness, wingY } from './shape';

export interface HingedPart {
  geometry: THREE.BufferGeometry;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

const N_AIRFOIL = 18;
const P_CAMBER = 0.4;

/** A 3D wing ring at span station x (x > 0) from a 2D chord-fraction ring (section rolled with the dihedral). */
export function placeWing(x: number, ring2d: number[]): number[] {
  const c = wingChord(x);
  const le = wingLeZ(x);
  const y0 = wingY(x);
  const r = wingRoll(x);
  const sr = Math.sin(r);
  const cr = Math.cos(r);
  const out: number[] = [];
  for (let k = 0; k < ring2d.length; k += 2) {
    const h = ring2d[k + 1] * c;
    out.push(x - sr * h, y0 + cr * h, le + ring2d[k] * c);
  }
  return out;
}

function piece(x: number, a: number, b: number, n = N_AIRFOIL): number[] {
  return airfoilPiece(wingThickness(x), WING.camber, P_CAMBER, a, b, n);
}

/** Atlas UVs by planform position; upper/lower by the vertex normal. */
export function applyWingUV(g: THREE.BufferGeometry) {
  const p = g.getAttribute('position');
  const n = g.getAttribute('normal');
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const t: [number, number] = [0, 0];
  for (let i = 0; i < p.count; i++) {
    wingUV(p.getX(i), p.getZ(i), n.getY(i) >= 0, t);
    uv.setXY(i, t[0], t[1]);
  }
}

export function span(x0: number, x1: number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(x0 + ((x1 - x0) * i) / n);
  return out;
}

/** Hinge point at chord fraction f of station x, `below` metres under the lower surface. */
function hingePoint(x: number, f: number, below: number): THREE.Vector3 {
  const c = wingChord(x);
  return V(x, wingLowerY(x, f) - below, wingLeZ(x) + f * c);
}

/** Split deceleron halves as 2D rings from chord fraction f0 to the trailing edge. */
function decelRing(x: number, f0: number, upper: boolean, n = 8): number[] {
  const t = wingThickness(x);
  const m = WING.camber;
  const thick = (f: number) => 5 * t * (0.2969 * Math.sqrt(f) - 0.126 * f - 0.3516 * f * f + 0.2843 * f ** 3 - 0.1036 * f ** 4);
  const cam = (f: number) => (f < P_CAMBER ? (m / (P_CAMBER * P_CAMBER)) * (2 * P_CAMBER * f - f * f) : (m / ((1 - P_CAMBER) ** 2)) * (1 - 2 * P_CAMBER + 2 * P_CAMBER * f - f * f));
  const fs: number[] = [];
  for (let k = 0; k <= n; k++) fs.push(f0 + 0.006 + (1 - f0 - 0.006) * (1 - Math.cos((k / n) * (Math.PI / 2))));
  const out: number[] = [];
  const gap = 0.0015;
  if (upper) {
    for (const f of fs) out.push(f, cam(f) + Math.max(gap + 0.001, thick(f)));
    for (let k = n; k >= 0; k--) out.push(fs[k], cam(fs[k]) + gap);
  } else {
    for (const f of fs) out.push(f, cam(f) - gap);
    for (let k = n; k >= 0; k--) out.push(fs[k], cam(fs[k]) - Math.max(gap + 0.001, thick(fs[k])));
  }
  return out;
}

export interface OuterWingBuild {
  /** Fixed panel (+ drooped tip). */
  panel: THREE.BufferGeometry;
  flap: HingedPart;
  decelUpper: HingedPart;
  decelLower: HingedPart;
  /** Tip positions for the lights (body coordinates, right side). */
  tipLight: THREE.Vector3;
}

export interface CentreWingBuild {
  /** Both halves of the centre section (painted). */
  panel: THREE.BufferGeometry;
  slatRight: HingedPart;
  slatLeft: HingedPart;
  flapRight: HingedPart;
  flapLeft: HingedPart;
}

function hinge(geo: THREE.BufferGeometry, a: THREE.Vector3, b: THREE.Vector3): HingedPart {
  const q = hingeFrame(b.clone().sub(a));
  toLocal(geo, a, q);
  return { geometry: geo, position: a, quaternion: q };
}

/** Mirror a right-side hinged part to the left (hinge axis pointing inboard so +rotation still lowers the TE). */
export function mirrorHinge(h: HingedPart, uv: (g: THREE.BufferGeometry) => void): HingedPart {
  const body = h.geometry.clone().applyQuaternion(h.quaternion).translate(h.position.x, h.position.y, h.position.z);
  const m = mirrorX(body);
  body.dispose();
  uv(m);
  const axisR = V(1, 0, 0).applyQuaternion(h.quaternion);
  const axisL = V(axisR.x, -axisR.y, -axisR.z);
  const pos = V(-h.position.x, h.position.y, h.position.z);
  const q = hingeFrame(axisL);
  toLocal(m, pos, q);
  return { geometry: m, position: pos, quaternion: q };
}

function mergeSimple(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  for (const g of list) for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
  return merge(list);
}

const flapF = 1 - WING.flapFrac;
const decelF = 1 - WING.decelFrac;
const slatF = (x: number) => WING.slatChord / wingChord(x);

/** The right half of the centre section with its slat and inboard flap. */
function buildCentreRight(): { panel: THREE.BufferGeometry; slat: HingedPart; flap: HingedPart } {
  const W = WING;
  const segs: THREE.BufferGeometry[] = [];
  const seg = (x0: number, x1: number, n: number, a: (x: number) => number, b: (x: number) => number) =>
    segs.push(loftGeometry(span(x0, x1, n).map((x) => placeWing(x, piece(x, a(x), b(x)))), { capStart: true, capEnd: true }));
  const full = () => 0;
  const te = () => 1;
  seg(W.rootX, W.flapInX0, 1, full, te);
  seg(W.flapInX0, W.slatX0, 1, full, () => flapF);
  seg(W.slatX0, W.slatX1, 4, slatF, () => flapF);
  seg(W.slatX1, W.flapInX1, 3, full, () => flapF);
  seg(W.flapInX1, W.jointX, 1, full, te);
  for (const g of segs) applyWingUV(g);
  const panel = mergeSimple(segs);

  // Slat: the leading-edge piece, hinged at its rear lower corner.
  const slatGeo = loftGeometry(span(W.slatX0 + 0.01, W.slatX1 - 0.01, 4).map((x) => placeWing(x, piece(x, 0, slatF(x) - 0.004))), { capStart: true, capEnd: true });
  applyWingUV(slatGeo);
  const sA = hingePoint(W.slatX0, slatF(W.slatX0), 0);
  const sB = hingePoint(W.slatX1, slatF(W.slatX1), 0);
  const slat = hinge(slatGeo, sA, sB);

  // Slotted flap: rounded-nose rear piece, hinged below the lower surface (moves aft as it lowers).
  const flap = buildFlap(W.flapInX0 + 0.01, W.flapInX1 - 0.01, 5);
  return { panel, slat, flap };
}

function buildFlap(x0: number, x1: number, n: number): HingedPart {
  const rings = span(x0, x1, n).map((x) => placeWing(x, nacaRing({ m: WING.camber, p: P_CAMBER, t: wingThickness(x), n: 8, from: flapF + 0.012, nosePoints: 5 })));
  const g = loftGeometry(rings, { capStart: true, capEnd: true });
  applyWingUV(g);
  const a = hingePoint(x0, flapF + 0.05, 0.1);
  const b = hingePoint(x1, flapF + 0.05, 0.1);
  return hinge(g, a, b);
}

export function buildCentreWing(): CentreWingBuild {
  const r = buildCentreRight();
  const left = mirrorX(r.panel);
  applyWingUV(left);
  return {
    panel: merge([r.panel, left]),
    slatRight: r.slat,
    slatLeft: mirrorHinge(r.slat, applyWingUV),
    flapRight: r.flap,
    flapLeft: mirrorHinge(r.flap, applyWingUV),
  };
}

/** Right outer panel: fixed box, outboard flap, split decelerons, drooped Hoerner tip. */
export function buildOuterRight(): OuterWingBuild {
  const W = WING;
  const segs: THREE.BufferGeometry[] = [];
  const seg = (x0: number, x1: number, n: number, b: number, capEnd = true) =>
    segs.push(loftGeometry(span(x0, x1, n).map((x) => placeWing(x, piece(x, 0, b))), { capStart: true, capEnd }));
  seg(W.jointX, W.flapOutX0, 1, 1);
  seg(W.flapOutX0, W.flapOutX1, 6, flapF);
  seg(W.flapOutX1, W.decelX0, 1, 1);
  seg(W.decelX0, W.decelX1, 7, decelF);
  // Drooped tip: full chord, thinning and turning down to the tip rib.
  const tipXs = [W.decelX1, ...span(W.droopX, W.tipX, 7).slice(0)].filter((x, i, a) => i === 0 || x > a[i - 1] + 1e-4);
  const tipRings = tipXs.map((x) => {
    const k = smooth(W.droopX, W.tipX, x);
    const ring = placeWing(x, airfoilPiece(wingThickness(x) * (1 - 0.35 * k), WING.camber, P_CAMBER, 0, 1, N_AIRFOIL));
    // The rolled (drooping) section leans outboard: keep the tip rib inside the real span.
    let maxX = 0;
    for (let i = 0; i < ring.length; i += 3) maxX = Math.max(maxX, ring[i]);
    const over = Math.max(0, maxX - W.tipX) * k;
    for (let i = 0; i < ring.length; i += 3) ring[i] -= over;
    return ring;
  });
  segs.push(loftGeometry(tipRings, { capStart: true, capEnd: true }));
  for (const g of segs) applyWingUV(g);
  const panel = mergeSimple(segs);

  const flap = buildFlap(W.flapOutX0 + 0.01, W.flapOutX1 - 0.01, 6);

  const dx = span(W.decelX0 + 0.01, W.decelX1 - 0.01, 7);
  const up = loftGeometry(dx.map((x) => placeWing(x, decelRing(x, decelF, true))), { capStart: true, capEnd: true });
  const lo = loftGeometry(dx.map((x) => placeWing(x, decelRing(x, decelF, false))), { capStart: true, capEnd: true });
  applyWingUV(up);
  applyWingUV(lo);
  const hp = (x: number) => {
    const c = wingChord(x);
    const r = wingRoll(x);
    const camY = (WING.camber / ((1 - P_CAMBER) ** 2)) * (1 - 2 * P_CAMBER + 2 * P_CAMBER * decelF - decelF * decelF) * c;
    return V(x - Math.sin(r) * camY, wingY(x) + Math.cos(r) * camY, wingLeZ(x) + (decelF + 0.006) * c);
  };
  const a = hp(W.decelX0);
  const b = hp(W.decelX1);
  const decelUpper = hinge(up, a.clone(), b.clone());
  const decelLower = hinge(lo, a.clone(), b.clone());
  const tx = W.tipX - 0.05;
  const tipLight = V(tx, wingY(tx) - 0.02, wingLeZ(tx) + 0.35 * wingChord(tx));
  return { panel, flap, decelUpper, decelLower, tipLight };
}

export function mirrorOuter(w: OuterWingBuild): OuterWingBuild {
  const panel = mirrorX(w.panel);
  applyWingUV(panel);
  return {
    panel,
    flap: mirrorHinge(w.flap, applyWingUV),
    decelUpper: mirrorHinge(w.decelUpper, applyWingUV),
    decelLower: mirrorHinge(w.decelLower, applyWingUV),
    tipLight: V(-w.tipLight.x, w.tipLight.y, w.tipLight.z),
  };
}

// ─── Main gear pods ──────────────────────────────────────────────────────────

const POD_KEYS: { z: number; top: number; bot: number; hw: number }[] = [
  { z: POD.noseZ, top: -0.93, bot: -0.97, hw: 0.02 },
  { z: POD.noseZ + 0.06, top: -0.84, bot: -1.06, hw: 0.14 },
  { z: POD.noseZ + 0.2, top: -0.76, bot: -1.13, hw: 0.23 },
  { z: POD.noseZ + 0.45, top: -0.69, bot: -1.18, hw: 0.3 },
  { z: POD.noseZ + 0.85, top: -0.64, bot: -1.21, hw: 0.345 },
  { z: -0.5, top: -0.6, bot: POD.bottomY, hw: POD.halfWidth },
  { z: 0.7, top: -0.6, bot: POD.bottomY, hw: POD.halfWidth },
  { z: 1.1, top: -0.62, bot: -1.17, hw: 0.32 },
  { z: 1.38, top: -0.66, bot: -1.07, hw: 0.24 },
  { z: 1.54, top: -0.7, bot: -0.94, hw: 0.13 },
  { z: POD.tailZ, top: -0.8, bot: -0.82, hw: 0.02 },
];

/** Gear pod section at z (closed ring, rounded box). */
export function podSection(z: number) {
  const ks = POD_KEYS;
  let i = 0;
  while (i < ks.length - 2 && z > ks[i + 1].z) i++;
  const t = Math.max(0, Math.min(1, (z - ks[i].z) / (ks[i + 1].z - ks[i].z)));
  const s = t * t * (3 - 2 * t);
  return { top: lerp(ks[i].top, ks[i + 1].top, s), bot: lerp(ks[i].bot, ks[i + 1].bot, s), hw: lerp(ks[i].hw, ks[i + 1].hw, s) };
}

/** One gear pod (right side at +POD.x; mirror for the left). */
export function buildPod(side: 1 | -1): THREE.BufferGeometry {
  const rings: number[][] = [];
  const zs: number[] = [];
  for (const k of POD_KEYS) zs.push(k.z);
  for (let z = POD.noseZ + 0.1; z < POD.tailZ - 0.05; z += 0.2) zs.push(z);
  const sorted = [...new Set(zs.map((z) => Math.round(z * 1000) / 1000))].sort((a, b) => a - b);
  const n = 28;
  for (const z of sorted) {
    const s = podSection(z);
    const cy = (s.top + s.bot) / 2;
    const hh = (s.top - s.bot) / 2;
    const ring: number[] = [];
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      // Flatter bottom and sides (the pod is a rounded box).
      const ex = c < 0 ? 2.8 : 2.4;
      ring.push(side * POD.x + s.hw * Math.sign(sn) * Math.abs(sn) ** (2 / 2.6), cy + hh * Math.sign(c) * Math.abs(c) ** (2 / ex), z);
    }
    rings.push(ring);
  }
  const g = loftGeometry(rings, { closed: true });
  // Planar projection onto the lower wing cell.
  const p = g.getAttribute('position');
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const t: [number, number] = [0, 0];
  for (let i = 0; i < p.count; i++) {
    wingUV(p.getX(i), p.getZ(i), false, t);
    uv.setXY(i, t[0], t[1]);
  }
  return g;
}

export { flapF as FLAP_FRACTION, decelF as DECEL_FRACTION };
