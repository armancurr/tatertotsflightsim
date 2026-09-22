/**
 * Empennage: horizontal stabiliser with the elevator (one surface on a straight
 * hinge, cut out round the rudder, trim tab on the right half), the swept fin
 * with its long dorsal fillet, and the rudder with the counterbalance horn at
 * the top. Movable parts come back in their hinge frames.
 */
import * as THREE from 'three';
import { loftGeometry } from './loft';
import { symmetricRing } from './airfoil';
import { HTAIL, VTAIL, monotoneCurve } from './shape';
import { FIN_UV } from './livery';
import { plain } from './materials';
import { mergeGeometriesSafe } from './wing';

export interface TailBuild {
  stab: THREE.BufferGeometry;
  elevator: { position: THREE.Vector3; geometry: THREE.BufferGeometry };
  /** Trim tab pivot relative to the elevator pivot (the tab rides on the elevator). */
  trimTab: { position: THREE.Vector3; quaternion: THREE.Quaternion; geometry: THREE.BufferGeometry };
  fin: THREE.BufferGeometry;
  rudder: { position: THREE.Vector3; quaternion: THREE.Quaternion; geometry: THREE.BufferGeometry };
  /** Beacon base on the fin cap, tail light spot on the rudder (body frame). */
  beaconBase: THREE.Vector3;
  tailLight: THREE.Vector3;
}

const lin = (a: number, b: number, k: number) => Array.from({ length: k }, (_, i) => a + ((b - a) * i) / (k - 1));

// ─── Horizontal tail ─────────────────────────────────────────────────────────

/** Stabiliser leading edge z at span |x| (swept, rounded into the tip). */
function stabLE(ax: number): number {
  const s = HTAIL.semiSpan;
  const straight = HTAIL.rootLE + ((HTAIL.tipLE - HTAIL.rootLE) * Math.min(ax, s - 0.15)) / s;
  if (ax <= s - 0.15) return straight;
  const k = (ax - (s - 0.15)) / 0.15; // 0..1 over the tip
  const target = HTAIL.hinge - 0.03;
  return straight + (target - straight) * (1 - Math.sqrt(Math.max(0, 1 - k * k)));
}
function elevTE(ax: number): number {
  const s = HTAIL.semiSpan;
  const te = HTAIL.rootTE + ((HTAIL.tipTE - HTAIL.rootTE) * Math.min(ax, s)) / s;
  const tip0 = s - 0.2;
  if (ax <= tip0) return te;
  const k = Math.min(1, (ax - tip0) / 0.2);
  return te - (te - (HTAIL.hinge + 0.05)) * (1 - Math.sqrt(Math.max(0, 1 - k * k)));
}

function stabRing(x: number, n: number, part: 'front' | 'rear', teOverride?: number): number[] {
  const ax = Math.abs(x);
  const le = stabLE(ax);
  const teFull = elevTE(ax);
  const chord = teFull - le;
  const h = Math.min(0.97, Math.max(0.03, (HTAIL.hinge - le) / chord));
  const tipThin = ax > HTAIL.semiSpan - 0.12 ? Math.max(0.25, 1 - (ax - (HTAIL.semiSpan - 0.12)) / 0.14) : 1;
  const ring2d = symmetricRing(HTAIL.t, n, part === 'front' ? { to: h, thicknessScale: tipThin } : { from: h, thicknessScale: tipThin, nosePoints: 4 });
  const te = teOverride ?? teFull;
  const out: number[] = [];
  for (let k = 0; k < ring2d.length; k += 2) {
    const c = ring2d[k];
    // Front part: plain chord mapping. Rear part: stretch hinge→TE onto hinge→te (cut-outs, tab notch).
    let z: number;
    if (part === 'front' || c < h) z = le + c * chord;
    else z = HTAIL.hinge + ((c - h) / (1 - h)) * (te - HTAIL.hinge);
    out.push(x, HTAIL.y + ring2d[k + 1] * chord, z);
  }
  return out;
}

function buildHorizontalTail(quality: 'high' | 'low') {
  const n = quality === 'high' ? 16 : 10;
  const s = HTAIL.semiSpan;
  const tipStations = [s - 0.2, s - 0.12, s - 0.06, s - 0.025, s];
  const half = [0, 0.4, 0.8, 1.2, ...tipStations];
  const xs = [...half.slice(1).reverse().map((x) => -x), ...half];
  const stab = plain(loftGeometry(xs.map((x) => stabRing(x, n, 'front')), { capStart: true, capEnd: true }));

  // Elevator: the inboard trailing edge is cut back to clear the rudder.
  const cut = (ax: number) => {
    const full = elevTE(ax);
    if (ax >= 0.3) return full;
    const k = (ax - 0.11) / (0.3 - 0.11);
    return HTAIL.hinge + 0.14 + k * (full - HTAIL.hinge - 0.14);
  };
  const elevParts: THREE.BufferGeometry[] = [];
  const tipE = [s - 0.2, s - 0.12, s - 0.06, s - 0.03];
  const leftStations = [0.11, 0.2, 0.3, 0.8, 1.3, ...tipE];
  elevParts.push(plain(loftGeometry(leftStations.map((ax) => stabRing(-ax, n, 'rear', cut(ax))), { capStart: true, capEnd: true })));
  // Right half in three pieces round the trim tab notch.
  const a0 = HTAIL.tabInboard;
  const a1 = HTAIL.tabOutboard;
  elevParts.push(plain(loftGeometry([0.11, 0.2, a0].map((ax) => stabRing(ax, n, 'rear', cut(ax))), { capStart: true, capEnd: true })));
  elevParts.push(plain(loftGeometry(lin(a0, a1, 3).map((ax) => stabRing(ax, n, 'rear', cut(ax) - HTAIL.tabChord)), { capStart: true, capEnd: true })));
  elevParts.push(plain(loftGeometry([a1, 1.3, ...tipE].map((ax) => stabRing(ax, n, 'rear', cut(ax))), { capStart: true, capEnd: true })));
  const elevPivot = new THREE.Vector3(0, HTAIL.y, HTAIL.hinge);
  const elevator = mergeGeometriesSafe(elevParts);
  elevator.translate(-elevPivot.x, -elevPivot.y, -elevPivot.z);

  // Trim tab: thin plate behind the notch.
  const tabRings = lin(a0 + 0.005, a1 - 0.005, 3).map((ax) => {
    const te = cut(ax);
    const z0 = te - HTAIL.tabChord;
    const ring = symmetricRing(0.07, 8);
    const out: number[] = [];
    for (let k = 0; k < ring.length; k += 2) out.push(ax, HTAIL.y + ring[k + 1] * HTAIL.tabChord, z0 + ring[k] * HTAIL.tabChord);
    return out;
  });
  const tabGeo = plain(loftGeometry(tabRings, { capStart: true, capEnd: true }));
  const tIn = new THREE.Vector3(a0, HTAIL.y, cut(a0) - HTAIL.tabChord);
  const tOut = new THREE.Vector3(a1, HTAIL.y, cut(a1) - HTAIL.tabChord);
  const tq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), tOut.clone().sub(tIn).normalize());
  tabGeo.applyMatrix4(new THREE.Matrix4().compose(tIn, tq, new THREE.Vector3(1, 1, 1)).invert());

  return {
    stab,
    elevator: { position: elevPivot, geometry: elevator },
    trimTab: { position: tIn.clone().sub(elevPivot), quaternion: tq, geometry: tabGeo },
  };
}

// ─── Vertical tail ───────────────────────────────────────────────────────────

/** Fin leading edge z at height y: the dorsal fillet sweeping into the swept fin. */
const finLE = monotoneCurve([
  [0.2, VTAIL.dorsalStart - 0.05],
  [0.58, VTAIL.dorsalStart],
  [0.615, 2.55],
  [0.645, 3.25],
  [0.69, 3.95],
  [0.76, 4.38],
  [0.86, 4.72],
  [1.0, 4.94],
  [VTAIL.finTop, VTAIL.leTop.z],
]);
function hingeZ(y: number): number {
  const { hingeBottom: b, hingeTop: t } = VTAIL;
  return b.z + ((y - b.y) * (t.z - b.z)) / (t.y - b.y);
}
function rudderTE(y: number): number {
  const { teBottom: b, teTop: t } = VTAIL;
  if (y <= t.y) return b.z + ((y - b.y) * (t.z - b.z)) / (t.y - b.y);
  const k = Math.min(1, (y - t.y) / (VTAIL.hornTop - t.y));
  return t.z - 0.32 * k * k;
}

function finUV(geo: THREE.BufferGeometry) {
  const p = geo.getAttribute('position');
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    uv.setXY(i, (p.getZ(i) - FIN_UV.z0) / (FIN_UV.z1 - FIN_UV.z0), (p.getY(i) - FIN_UV.y0) / (FIN_UV.y1 - FIN_UV.y0));
  }
  uv.needsUpdate = true;
}

function buildVerticalTail(quality: 'high' | 'low') {
  const n = quality === 'high' ? 18 : 11;
  // Fin: symmetric sections along y, cut flat at the rudder hinge. Thickness capped (the dorsal is a thin blade).
  const finRing = (y: number, topShrink = 0, thick = 1) => {
    const le = finLE(y) + topShrink;
    const te = rudderTE(Math.min(y, VTAIL.teTop.y));
    const chord = te - le;
    const hz = hingeZ(y);
    const h = Math.min(0.97, (hz - le) / chord);
    const tr = Math.min(VTAIL.t, (2 * VTAIL.maxHalfThickness) / chord) * thick;
    const r = symmetricRing(tr, n, { to: h });
    const out: number[] = [];
    for (let k = 0; k < r.length; k += 2) out.push(-r[k + 1] * chord, y, le + r[k] * chord);
    return out;
  };
  const top = 1.37;
  const ys = [0.2, 0.45, 0.56, 0.6, 0.62, 0.64, 0.665, 0.7, 0.75, 0.82, 0.9, 1.0, 1.12, 1.25, 1.33];
  const rings = ys.map((y) => finRing(y));
  // Rounded fin cap: leading edge rolls back, section thins.
  rings.push(finRing(top - 0.02, 0.02, 0.85), finRing(top - 0.006, 0.06, 0.55), finRing(top, 0.11, 0.2));
  const fin = plain(loftGeometry(rings, { capStart: true, capEnd: true }));
  finUV(fin);

  // Rudder: rear sections from the hinge to the trailing edge; above the fin cap the horn reaches forward.
  const hornFront = VTAIL.hornFront + 0.19;
  const rudRing = (y: number) => {
    const inHorn = y > top + 0.005;
    const hz = inHorn ? hornFront : hingeZ(y);
    const te = rudderTE(y);
    const le = hz - 0.22; // virtual leading edge: sets the thickness at the hinge
    const chord = te - le;
    const h = (hz - le) / chord;
    const topK = y > VTAIL.hornTop - 0.04 ? Math.max(0.2, (VTAIL.hornTop - y) / 0.04) : 1;
    const r = symmetricRing(0.13, n, { from: h, nosePoints: 5, thicknessScale: topK });
    const out: number[] = [];
    for (let k = 0; k < r.length; k += 2) out.push(-r[k + 1] * chord, y, le + r[k] * chord);
    return out;
  };
  const rys = [VTAIL.teBottom.y - 0.01, 0.0, 0.2, 0.5, 0.8, 1.1, 1.3, top, top + 0.012, top + 0.03, 1.415, VTAIL.hornTop - 0.015, VTAIL.hornTop];
  const rudderGeo = plain(loftGeometry(rys.map(rudRing), { capStart: true, capEnd: true }));
  finUV(rudderGeo);
  const hb = new THREE.Vector3(0, VTAIL.hingeBottom.y, VTAIL.hingeBottom.z);
  const ht = new THREE.Vector3(0, VTAIL.hingeTop.y, VTAIL.hingeTop.z);
  const rq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), ht.clone().sub(hb).normalize());
  rudderGeo.applyMatrix4(new THREE.Matrix4().compose(hb, rq, new THREE.Vector3(1, 1, 1)).invert());

  return {
    fin,
    rudder: { position: hb, quaternion: rq, geometry: rudderGeo },
    beaconBase: new THREE.Vector3(0, top - 0.005, 5.43),
    tailLight: new THREE.Vector3(0, 0.0, rudderTE(0.0) + 0.012),
  };
}

export function buildTail(quality: 'high' | 'low'): TailBuild {
  const h = buildHorizontalTail(quality);
  const v = buildVerticalTail(quality);
  return { ...h, ...v };
}
