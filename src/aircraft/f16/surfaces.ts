/**
 * F-16 lifting and control surfaces: cropped-delta wings (fixed box, leading-edge flap, flaperon),
 * wingtip LAU-129 rails with AIM-9M missiles, all-moving stabilators, the fin with its rudder and
 * base fairing, the split speed brakes and the canted ventral fins.
 *
 * Every hinged part comes with its hinge frame (body coordinates): local +X along the hinge,
 * local +Z toward the part's trailing edge, so a positive rotation about +X lowers a trailing
 * edge on both sides (the left side's hinge axis points inboard).
 */
import * as THREE from 'three';
import { loftGeometry } from '../loft';
import { nacaRing } from '../airfoil';
import { tint, merge } from '../materials';
import { finUV, stabUV, wingUV, SWATCH } from './atlas';
import { airfoilPiece, box, ellipsoid, hingeFrame, mirrorX, toLocal, tube, V } from './geom';
import { AIM9, FIN, STAB, VENTRAL, WING, finLeZ, finTeZ, lefChord, wingChord, wingLeZ, wingTeZ } from './shape';

export interface HingedPart {
  geometry: THREE.BufferGeometry;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

const N_AIRFOIL = 22;

function wingY(x: number): number {
  return WING.y - 0.035 * Math.max(0, (Math.abs(x) - WING.rootX) / (WING.tipX - WING.rootX));
}
function wingThicknessScale(x: number): number {
  return 1 - 0.18 * Math.max(0, (Math.abs(x) - WING.rootX) / (WING.tipX - WING.rootX));
}

/** Upper-surface height of the wing airfoil at chord fraction f, station x (body y). */
function wingUpperY(x: number, f: number): number {
  const c = wingChord(x);
  const ring = airfoilPiece(WING.thickness, WING.camber, 0.4, 0, 1, 40, wingThicknessScale(x));
  // Linear search on the upper surface (first 40 points).
  for (let k = 1; k < 40; k++) {
    if (ring[k * 2] >= f) {
      const x0 = ring[(k - 1) * 2];
      const x1 = ring[k * 2];
      const t = (f - x0) / Math.max(1e-6, x1 - x0);
      return wingY(x) + c * (ring[(k - 1) * 2 + 1] + (ring[k * 2 + 1] - ring[(k - 1) * 2 + 1]) * t);
    }
  }
  return wingY(x);
}

/** A 3D wing ring at span station x from a 2D chord-fraction ring. */
function place(x: number, ring2d: number[], le = wingLeZ(x), chord = wingChord(x), y0 = wingY(x)): number[] {
  const out: number[] = [];
  for (let k = 0; k < ring2d.length; k += 2) out.push(x, y0 + ring2d[k + 1] * chord, le + ring2d[k] * chord);
  return out;
}

/** Atlas UVs by planform position; upper/lower by the vertex normal. */
function applyWingUV(g: THREE.BufferGeometry) {
  const p = g.getAttribute('position');
  const n = g.getAttribute('normal');
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const t: [number, number] = [0, 0];
  for (let i = 0; i < p.count; i++) {
    wingUV(p.getX(i), p.getZ(i), n.getY(i) >= 0, t);
    uv.setXY(i, t[0], t[1]);
  }
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
function applyFinUV(g: THREE.BufferGeometry) {
  const p = g.getAttribute('position');
  const n = g.getAttribute('normal');
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const t: [number, number] = [0, 0];
  for (let i = 0; i < p.count; i++) {
    const right = Math.abs(p.getX(i)) > 1e-4 ? p.getX(i) > 0 : n.getX(i) >= 0;
    finUV(p.getZ(i), p.getY(i), right, t);
    uv.setXY(i, t[0], t[1]);
  }
}
function applySwatch(g: THREE.BufferGeometry, sw: readonly [number, number]) {
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, sw[0], sw[1]);
}

function span(x0: number, x1: number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(x0 + ((x1 - x0) * i) / n);
  return out;
}

const lefFrac = (x: number) => lefChord(x) / wingChord(x);
const flapFrac = (x: number) => 1 - WING.flaperonChord / wingChord(x);

export interface WingBuild {
  panel: THREE.BufferGeometry;
  lef: HingedPart;
  flaperon: HingedPart;
  /** LAU-129 launcher rail (parts material, vertex colours); the AIM-9M is buildAim9(). */
  tip: THREE.BufferGeometry;
}

/** Right wing (x > 0); the left one is its mirror image. */
function buildRightWing(): WingBuild {
  const ts = wingThicknessScale;
  const piece = (x: number, a: number, b: number) => airfoilPiece(WING.thickness, WING.camber, 0.4, a, b, N_AIRFOIL, ts(x));
  const root = loftGeometry(span(WING.rootX, WING.junctionX, 3).map((x) => place(x, piece(x, 0, 1))), { capStart: true, capEnd: true });
  const mid = loftGeometry(span(WING.junctionX, WING.flaperonOuterX, 10).map((x) => place(x, piece(x, lefFrac(x), flapFrac(x)))), { capStart: true, capEnd: true });
  const outer = loftGeometry(span(WING.flaperonOuterX, WING.tipX, 4).map((x) => place(x, piece(x, lefFrac(x), 1))), { capStart: true, capEnd: true });
  for (const g of [root, mid, outer]) applyWingUV(g);
  const panel = mergeSimple([root, mid, outer]);

  // Leading-edge flap: front piece, hinged on the upper surface at its chord line.
  const lefGeo = loftGeometry(span(WING.junctionX, WING.tipX, 12).map((x) => place(x, piece(x, 0, lefFrac(x)))), { capStart: true, capEnd: true });
  applyWingUV(lefGeo);
  const hingeAt = (x: number, f: number, upper: boolean) => {
    const c = wingChord(x);
    return V(x, upper ? wingUpperY(x, f) - 0.004 : wingY(x) + WING.camber * c, wingLeZ(x) + f * c);
  };
  const lefA = hingeAt(WING.junctionX, lefFrac(WING.junctionX), true);
  const lefB = hingeAt(WING.tipX, lefFrac(WING.tipX), true);
  const lefQ = hingeFrame(lefB.clone().sub(lefA));
  toLocal(lefGeo, lefA, lefQ);

  // Flaperon: rear piece with a rounded nose, hinged at its nose centre.
  const flapRings = span(WING.junctionX + 0.01, WING.flaperonOuterX - 0.01, 10).map((x) => {
    const r = nacaRing({ m: WING.camber, p: 0.4, t: WING.thickness * ts(x), n: 8, from: flapFrac(x), nosePoints: 5 });
    return place(x, r);
  });
  const flapGeo = loftGeometry(flapRings, { capStart: true, capEnd: true });
  applyWingUV(flapGeo);
  const flA = hingeAt(WING.junctionX, flapFrac(WING.junctionX) + 0.004, false);
  const flB = hingeAt(WING.flaperonOuterX, flapFrac(WING.flaperonOuterX) + 0.004, false);
  const flQ = hingeFrame(flB.clone().sub(flA));
  toLocal(flapGeo, flA, flQ);

  return {
    panel,
    lef: { geometry: lefGeo, position: lefA, quaternion: lefQ },
    flaperon: { geometry: flapGeo, position: flA, quaternion: flQ },
    tip: buildTipStore(),
  };
}

/** LAU-129 wingtip launcher rail (right side); the AIM-9M itself is a separate mesh (buildAim9). */
function buildTipStore(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const grey = 0x8a8f93;
  const railX = WING.tipX + 0.07;
  const railTop = wingY(WING.tipX) + 0.05;
  // Rail: a slim box with a rounded nose fairing along the tip.
  const railZ0 = wingLeZ(WING.tipX) - 0.35;
  const railZ1 = wingTeZ(WING.tipX) + 0.12;
  parts.push(tint(box(0.13, 0.1, railZ1 - railZ0, V(railX, railTop - 0.06, (railZ0 + railZ1) / 2)), grey, 0.55, 0.1));
  parts.push(tint(ellipsoid(V(railX, railTop - 0.06, railZ0), 0.065, 0.05, 0.3, 12, 8), grey, 0.55, 0.1));
  // Adapter between the tip rib and the rail.
  parts.push(tint(box(0.06, 0.07, wingChord(WING.tipX) * 0.9, V(WING.tipX + 0.02, wingY(WING.tipX), wingLeZ(WING.tipX) + wingChord(WING.tipX) * 0.5)), grey, 0.55, 0.1));
  // Rail slot (the missile's hangers ride in it) under the rail.
  parts.push(tint(box(0.03, 0.012, railZ1 - railZ0 - 0.2, V(railX - 0.035, railTop - 0.112, (railZ0 + railZ1) / 2)), 0x3a3d40, 0.6, 0.2));
  return merge(parts);
}

/**
 * AIM-9M Sidewinder, centred on its own origin (the station point = the missile's centre): nose
 * (seeker dome) at z = −length/2, nozzle at +length/2; X fins (45°), so the same geometry serves
 * both wingtips. The launch hangers (they leave with the missile) point up-inboard toward the rail
 * on the right wing (x < 0 side of the body); `side` = −1 mirrors them for the left wing.
 */
export function buildAim9(side: 1 | -1 = 1): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const z0 = -AIM9.length / 2;
  const z1 = AIM9.length / 2;
  const R = AIM9.radius;
  const body = 0xc7c9c5;
  const domeLen = R * 0.98 * 1.25;
  parts.push(tint(tube(V(0, 0, z0 + domeLen), V(0, 0, z1 - 0.01), R, R, 16), body, 0.45, 0.2));
  // Seeker dome.
  const dome = new THREE.SphereGeometry(R * 0.98, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2);
  dome.rotateX(-Math.PI / 2);
  dome.scale(1, 1, 1.25);
  dome.translate(0, 0, z0 + domeLen);
  parts.push(tint(dome, 0x2b2a26, 0.08, 0.3));
  // Bands: yellow (warhead) and brown (rocket motor).
  parts.push(tint(tube(V(0, 0, z0 + 0.62), V(0, 0, z0 + 0.66), R + 0.0015, R + 0.0015, 16, true), 0xd8b020, 0.5, 0));
  parts.push(tint(tube(V(0, 0, z0 + 1.18), V(0, 0, z0 + 1.22), R + 0.0015, R + 0.0015, 16, true), 0x6a4a2a, 0.5, 0));
  // Launch hangers toward the rail (inboard of the missile, slightly up).
  const railDx = -side * (AIM9.x - (WING.tipX + 0.07));
  for (const hz of [z0 + 0.55, z0 + 1.35, z0 + 2.2]) parts.push(tint(box(0.05, 0.05, 0.08, V(railDx / 2, 0.02, hz)), 0x55595c, 0.6, 0.2));
  // Fins: X configuration (45°), canards forward, wings aft.
  const finSet = (zc: number, span: number, rootChord: number, tipChord: number, thick: number) => {
    for (let k = 0; k < 4; k++) {
      const ang = Math.PI / 4 + (k * Math.PI) / 2;
      const s = new THREE.Shape();
      const h = span / 2 - R;
      s.moveTo(0, 0);
      s.lineTo(rootChord, 0);
      s.lineTo(rootChord, h * 0.25);
      s.lineTo(rootChord - tipChord * 0.4, h);
      s.lineTo(rootChord - tipChord * 1.2, h);
      s.lineTo(0, 0);
      const g = new THREE.ExtrudeGeometry(s, { depth: thick, bevelEnabled: false });
      g.translate(0, R - 0.005, -thick / 2);
      // Shape x → body +z (aft), shape y → radial; rotate about the missile axis.
      g.applyMatrix4(new THREE.Matrix4().makeBasis(V(0, 0, 1), V(1, 0, 0), V(0, 1, 0)).premultiply(new THREE.Matrix4().makeRotationZ(ang)));
      g.translate(0, 0, zc);
      parts.push(tint(g, body, 0.45, 0.2));
    }
  };
  finSet(z0 + 0.3, AIM9.canardSpan, 0.22, 0.12, 0.012);
  finSet(z1 - 0.34, AIM9.finSpan, 0.3, 0.16, 0.012);
  // Nozzle.
  parts.push(tint(tube(V(0, 0, z1 - 0.03), V(0, 0, z1), R * 0.7, R * 0.7, 12), 0x2a2a2a, 0.6, 0.6));
  return merge(parts);
}

export interface SurfacesBuild {
  wingRight: WingBuild;
  wingLeft: WingBuild;
  stabRight: HingedPart;
  stabLeft: HingedPart;
  fin: THREE.BufferGeometry;
  rudder: HingedPart;
  /** Fin tip cap, antennas, light housings (parts material). */
  finDetails: THREE.BufferGeometry;
  /** Positions of the fin lights (body coordinates). */
  finLights: { strobe: THREE.Vector3; tail: THREE.Vector3 };
  speedBrakes: { upperLeft: HingedPart; lowerLeft: HingedPart; upperRight: HingedPart; lowerRight: HingedPart };
  ventrals: THREE.BufferGeometry;
}

function mirrorWing(w: WingBuild): WingBuild {
  const mirrorHinge = (h: HingedPart): HingedPart => {
    // Body-space geometry of the right part, mirrored, re-expressed in the left hinge frame
    // (axis pointing inboard so +rotation still lowers the trailing edge).
    const body = h.geometry.clone().applyQuaternion(h.quaternion).translate(h.position.x, h.position.y, h.position.z);
    const m = mirrorX(body);
    body.dispose();
    const axisR = V(1, 0, 0).applyQuaternion(h.quaternion);
    const axisL = V(axisR.x, -axisR.y, -axisR.z); // mirror (−x) then reverse → (x, −y, −z)
    const pos = V(-h.position.x, h.position.y, h.position.z);
    const q = hingeFrame(axisL);
    toLocal(m, pos, q);
    fixWingUV(m);
    return { geometry: m, position: pos, quaternion: q };
  };
  const panel = mirrorX(w.panel);
  fixWingUV(panel);
  return { panel, lef: mirrorHinge(w.lef), flaperon: mirrorHinge(w.flaperon), tip: mirrorX(w.tip) };
}
/** Move mirrored wing UVs from the right-wing cells to the left-wing cells. */
function fixWingUV(g: THREE.BufferGeometry) {
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) + 0.5);
}

function buildStabRight(): HingedPart {
  const stations = span(STAB.rootX, STAB.tipX, 8);
  const rings = stations.map((x) => {
    const t = (x - STAB.rootX) / (STAB.tipX - STAB.rootX);
    const le = STAB.rootLeZ + (STAB.tipLeZ - STAB.rootLeZ) * t;
    const te = STAB.rootTeZ + (STAB.tipTeZ - STAB.rootTeZ) * t;
    const y = STAB.rootY + (STAB.tipY - STAB.rootY) * t;
    const r = airfoilPiece(STAB.thickness * (1 - 0.25 * t), 0, 0.4, 0, 1, 12);
    return place(x, r, le, te - le, y);
  });
  const g = loftGeometry(rings, { capStart: true, capEnd: true });
  applyStabUV(g);
  const pos = V(STAB.rootX - 0.04, STAB.rootY, STAB.pivotZ);
  const q = hingeFrame(V(STAB.tipX - STAB.rootX, STAB.tipY - STAB.rootY, 0));
  toLocal(g, pos, q);
  return { geometry: g, position: pos, quaternion: q };
}

function mirrorStab(h: HingedPart): HingedPart {
  const body = h.geometry.clone().applyQuaternion(h.quaternion).translate(h.position.x, h.position.y, h.position.z);
  const m = mirrorX(body);
  body.dispose();
  const pos = V(-h.position.x, h.position.y, h.position.z);
  const axisR = V(1, 0, 0).applyQuaternion(h.quaternion);
  const q = hingeFrame(V(axisR.x, -axisR.y, -axisR.z));
  toLocal(m, pos, q);
  return { geometry: m, position: pos, quaternion: q };
}

/** Vertical fin section at height y as a ring in the x/z plane (chord fraction a..b). */
function finRing(y: number, a: number, b: number, n = 14): number[] {
  const le = finLeZ(y);
  const c = finTeZ(y) - le;
  const t = FIN.thickness * (1 - 0.35 * (y - FIN.rootY) / (FIN.tipY - FIN.rootY));
  const r = airfoilPiece(t, 0, 0.4, a, b, n);
  const out: number[] = [];
  for (let k = 0; k < r.length; k += 2) out.push(r[k + 1] * c, y, le + r[k] * c);
  return out;
}

function buildFin(): { fin: THREE.BufferGeometry; rudder: HingedPart; details: THREE.BufferGeometry; lights: SurfacesBuild['finLights'] } {
  const rudFrac = (y: number) => 1 - FIN.rudderChord / (finTeZ(y) - finLeZ(y));
  const topY = FIN.tipY - 0.05;
  const lower = loftGeometry(span(FIN.rootY, FIN.rudderBottomY, 3).map((y) => finRing(y, 0, 1)), { capStart: true, capEnd: true });
  const mid = loftGeometry(span(FIN.rudderBottomY, FIN.rudderTopY, 10).map((y) => finRing(y, 0, rudFrac(y))), { capStart: true, capEnd: true });
  const upper = loftGeometry(span(FIN.rudderTopY, topY, 3).map((y) => finRing(y, 0, 1)), { capStart: true, capEnd: true });

  // Base fairing (ECM / drag-chute housing) along the fin root trailing edge.
  const fairRings: number[][] = [];
  const fz0 = 4.3;
  const fz1 = 5.8;
  for (let i = 0; i <= 14; i++) {
    const t = i / 14;
    const z = fz0 + (fz1 - fz0) * t;
    const grow = Math.min(1, Math.sqrt(t / 0.35));
    const endRound = t > 0.93 ? Math.sqrt(Math.max(0, 1 - ((t - 0.93) / 0.07) ** 2)) : 1;
    const hw = 0.13 * grow * (0.45 + 0.55 * endRound);
    const hh = 0.17 * grow * (0.5 + 0.5 * endRound);
    const cy = 0.63 + 0.04 * t;
    const ring: number[] = [];
    for (let k = 0; k < 20; k++) {
      const a = (k / 20) * Math.PI * 2;
      const s = Math.sin(a);
      const c = Math.cos(a);
      ring.push(hw * Math.sign(s) * Math.abs(s) ** 0.55, cy + hh * Math.sign(c) * Math.abs(c) ** 0.7, z);
    }
    fairRings.push(ring);
  }
  const fairing = loftGeometry(fairRings, { capEnd: true });
  const fin = mergeSimple([lower, mid, upper, fairing]);
  applyFinUV(fin);

  // Rudder: rounded-nose rear piece; hinge line along its nose.
  const rudRings = span(FIN.rudderBottomY + 0.01, FIN.rudderTopY - 0.01, 8).map((y) => {
    const le = finLeZ(y);
    const c = finTeZ(y) - le;
    const t = FIN.thickness * (1 - 0.35 * (y - FIN.rootY) / (FIN.tipY - FIN.rootY));
    const r = nacaRing({ m: 0, p: 0, t, n: 8, from: rudFrac(y) + 0.004, nosePoints: 5 });
    const out: number[] = [];
    for (let k = 0; k < r.length; k += 2) out.push(r[k + 1] * c, y, le + r[k] * c);
    return out;
  });
  const rudGeo = loftGeometry(rudRings, { capStart: true, capEnd: true });
  applyFinUV(rudGeo);
  const hz = (y: number) => finLeZ(y) + (rudFrac(y) + 0.004) * (finTeZ(y) - finLeZ(y));
  const hA = V(0, FIN.rudderBottomY, hz(FIN.rudderBottomY));
  const hB = V(0, FIN.rudderTopY, hz(FIN.rudderTopY));
  // Rudder frame: local Y up the hinge, local Z aft, local X right.
  const yAxis = hB.clone().sub(hA).normalize();
  const zAxis = V(0, 0, 1).sub(yAxis.clone().multiplyScalar(yAxis.z)).normalize();
  const xAxis = new THREE.Vector3().crossVectors(yAxis, zAxis).normalize();
  const rq = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis));
  toLocal(rudGeo, hA, rq);

  // Details: dielectric fin cap, strobe and tail-light housings, antennas.
  const d: THREE.BufferGeometry[] = [];
  const capLe = finLeZ(topY);
  const capTe = finTeZ(topY);
  const cap = new THREE.CapsuleGeometry(0.035, capTe - capLe - 0.12, 4, 10);
  cap.rotateX(Math.PI / 2);
  cap.scale(0.9, 1.0, 1);
  cap.translate(0, topY + 0.02, (capLe + capTe) / 2);
  d.push(tint(cap, 0x5b6064, 0.6, 0));
  const strobe = V(0, FIN.tipY - 0.01, capLe + 0.14);
  const tail = V(0, topY - 0.06, capTe + 0.015);
  d.push(tint(box(0.03, 0.03, 0.05, V(tail.x, tail.y, tail.z - 0.02)), 0x303234, 0.6, 0.2));
  // ECM / RWR antenna radomes at the fairing end and on the fin leading edge.
  d.push(tint(ellipsoid(V(0, 0.69, 5.79), 0.06, 0.08, 0.05, 12, 8), 0x3c3f42, 0.5, 0));
  d.push(tint(ellipsoid(V(0, 1.95, finLeZ(1.95) - 0.01), 0.03, 0.12, 0.05, 10, 8), 0x3c3f42, 0.5, 0));
  // VHF blade on the fin leading edge root.
  d.push(tint(box(0.012, 0.22, 0.14, V(0, 0.95, finLeZ(0.95) - 0.02), -0.4, 0, 0), 0x55595c, 0.6, 0.1));
  return { fin, rudder: { geometry: rudGeo, position: hA, quaternion: rq }, details: merge(d), lights: { strobe, tail } };
}

/** Split speed brakes on the aft booms (right side), hinged at their trailing edge. */
function buildSpeedBrake(upper: boolean): HingedPart {
  const z0 = 4.62;
  const z1 = 5.56;
  const x0 = 0.56;
  const x1 = 1.0;
  const midY = -0.34;
  const rings: number[][] = [];
  const nx = 8;
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    const z = z0 + (z1 - z0) * t;
    // Surface height above/below the boom mid-plane: full boom depth at the front, closing to the TE.
    const depth = (upper ? 0.24 : 0.16) * (1 - t) ** 0.9 + 0.012;
    const ring: number[] = [];
    // Outer surface across the boom (inboard → outboard), then back along the inner face.
    for (let k = 0; k <= nx; k++) {
      const u = k / nx;
      const x = x0 + (x1 - x0) * u;
      const edge = Math.sin(Math.min(1, (1 - u) / 0.25) * Math.PI / 2);
      const h = depth * (0.35 + 0.65 * edge) * (upper ? 1 - 0.35 * (1 - u) : 1);
      ring.push(x, upper ? midY + h : midY - h, z);
    }
    for (let k = nx; k >= 0; k--) {
      const x = x0 + ((x1 - x0) * k) / nx;
      ring.push(x, upper ? midY + 0.006 : midY - 0.006, z);
    }
    rings.push(ring);
  }
  const g = loftGeometry(rings, { capStart: true, capEnd: true });
  applySwatch(g, upper ? SWATCH.mid : SWATCH.light);
  const pos = V(x0, midY + (upper ? 0.01 : -0.01), z1);
  const q = hingeFrame(V(1, 0, 0));
  toLocal(g, pos, q);
  return { geometry: g, position: pos, quaternion: q };
}

function mirrorBrake(h: HingedPart): HingedPart {
  const body = h.geometry.clone().applyQuaternion(h.quaternion).translate(h.position.x, h.position.y, h.position.z);
  const m = mirrorX(body);
  body.dispose();
  const pos = V(-h.position.x - (1.0 - 0.56), h.position.y, h.position.z);
  const q = hingeFrame(V(1, 0, 0));
  toLocal(m, pos, q);
  return { geometry: m, position: pos, quaternion: q };
}

function buildVentrals(): THREE.BufferGeometry {
  const one = (side: number) => {
    const rings: number[][] = [];
    const cant = VENTRAL.cantDeg * (Math.PI / 180) * side;
    for (let i = 0; i <= 5; i++) {
      const t = i / 5;
      const y = VENTRAL.rootY + (VENTRAL.tipY - VENTRAL.rootY) * t;
      const le = VENTRAL.rootLeZ + (VENTRAL.tipLeZ - VENTRAL.rootLeZ) * t;
      const te = VENTRAL.rootTeZ + (VENTRAL.tipTeZ - VENTRAL.rootTeZ) * t;
      const r = airfoilPiece(0.05, 0, 0.4, 0, 1, 10);
      const x0 = side * VENTRAL.x - Math.tan(cant) * (y - VENTRAL.rootY);
      const ring: number[] = [];
      for (let k = 0; k < r.length; k += 2) ring.push(x0 + r[k + 1] * (te - le), y, le + r[k] * (te - le));
      rings.push(ring);
    }
    return loftGeometry(rings, { capStart: true, capEnd: true });
  };
  const g = mergeSimple([one(1), one(-1)]);
  applySwatch(g, SWATCH.light);
  return g;
}

export function buildSurfaces(): SurfacesBuild {
  const wingRight = buildRightWing();
  const wingLeft = mirrorWing(wingRight);
  const stabRight = buildStabRight();
  const stabLeft = mirrorStab(stabRight);
  const f = buildFin();
  const ur = buildSpeedBrake(true);
  const lr = buildSpeedBrake(false);
  return {
    wingRight,
    wingLeft,
    stabRight,
    stabLeft,
    fin: f.fin,
    rudder: f.rudder,
    finDetails: f.details,
    finLights: f.lights,
    speedBrakes: { upperRight: ur, lowerRight: lr, upperLeft: mirrorBrake(ur), lowerLeft: mirrorBrake(lr) },
    ventrals: buildVentrals(),
  };
}

/** Merge geometries with position/normal/uv only. */
export function mergeSimple(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const clean = list.map((g) => {
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    return g;
  });
  return merge(clean);
}
