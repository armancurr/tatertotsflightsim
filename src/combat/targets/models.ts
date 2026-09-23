/**
 * Procedural vehicle models (hull + turret, per level of detail) for the target range:
 * T-72B (with Kontakt-1 ERA), BMP-2, BTR-80, Ural-4320 and ZSU-23-4 "Shilka". Real proportions
 * (config sizes); few parts, merged into one non-indexed geometry per part with vertex colours so
 * every vehicle class is one instanced draw call per part.
 *
 * Frames: hull origin = centre of the footprint at ground level, +X right, +Y up, −Z the front.
 * The turret geometry's origin is its ring centre (placed at `ring` on the hull).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { GroundKind as TargetKind } from '../types';

export interface ClassModel {
  hull: THREE.BufferGeometry;
  turret: THREE.BufferGeometry | null;
  /** Turret ring centre on the hull (hull frame). */
  ring: { y: number; z: number };
  /** Rough centre of the turret's mass above the ring, m (turret toss). */
  turretCg: number;
}

export type Lod = 0 | 1 | 2;

// Linear albedo (calibrated for the HDR pipeline, exposure ≈ 2.2): Russian 4BO green and friends —
// a darker, browner olive than sunlit grass, so the vehicles read against the fields from the air.
export const PAINT = {
  green: [0.046, 0.052, 0.024],
  greenDark: [0.033, 0.038, 0.018],
  greenLight: [0.062, 0.068, 0.033],
  rubber: [0.022, 0.022, 0.02],
  track: [0.045, 0.04, 0.034],
  steel: [0.06, 0.058, 0.05],
  canvas: [0.13, 0.12, 0.068],
  wood: [0.12, 0.075, 0.04],
  glass: [0.015, 0.02, 0.025],
  lamp: [0.2, 0.2, 0.18],
} as const;
type Rgb = readonly [number, number, number] | readonly number[];

/**
 * Animated parts (vertex attribute `aPart`: kind, centre y, centre z, radius — hull/turret frame):
 * the shader turns wheels and runs the tracks with the odometer and spins the radar dish.
 */
export const PART = { body: 0, wheel: 1, track: 2, dish: 3 } as const;

class Parts {
  readonly list: THREE.BufferGeometry[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private tag: [number, number, number, number] = [0, 0, 0, 0];

  /** Tag the parts added inside `fn` (wheels, track runs, the radar dish). */
  tagged(kind: number, cy: number, cz: number, r: number, fn: () => void): void {
    const prev = this.tag;
    this.tag = [kind, cy, cz, r];
    fn();
    this.tag = prev;
  }

  add(geo: THREE.BufferGeometry, color: Rgb, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): void {
    let g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    g.deleteAttribute('uv');
    this.e.set(rx, ry, rz);
    this.q.setFromEuler(this.e);
    this.m.compose(new THREE.Vector3(x, y, z), this.q, new THREE.Vector3(sx, sy, sz));
    g.applyMatrix4(this.m);
    const n = g.getAttribute('position').count;
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      c[i * 3] = color[0];
      c[i * 3 + 1] = color[1];
      c[i * 3 + 2] = color[2];
    }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    const t = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) t.set(this.tag, i * 4);
    g.setAttribute('aPart', new THREE.BufferAttribute(t, 4));
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    this.list.push(g);
    g = geo;
  }

  box(w: number, h: number, d: number, color: Rgb, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): void {
    this.add(new THREE.BoxGeometry(w, h, d), color, x, y, z, rx, ry, rz);
  }

  /** Cylinder along X (wheels, drums, logs). */
  cylX(r: number, len: number, color: Rgb, x: number, y: number, z: number, seg = 12): void {
    this.add(new THREE.CylinderGeometry(r, r, len, seg), color, x, y, z, 0, 0, Math.PI / 2);
  }

  /** Cylinder along −Z (barrels) starting at z0 going forward `len`. */
  barrel(r0: number, r1: number, len: number, color: Rgb, x: number, y: number, z0: number, seg = 10): void {
    this.add(new THREE.CylinderGeometry(r1, r0, len, seg), color, x, y, z0 - len / 2, -Math.PI / 2, 0, 0);
  }

  /** Vertical cylinder. */
  cylY(rTop: number, rBot: number, h: number, color: Rgb, x: number, y: number, z: number, seg = 14): void {
    this.add(new THREE.CylinderGeometry(rTop, rBot, h, seg), color, x, y + h / 2, z);
  }

  /** A side profile (z, y) extruded across the width (centred on x). */
  prism(profile: [number, number][], width: number, color: Rgb, x = 0): void {
    const shape = new THREE.Shape(profile.map(([z, y]) => new THREE.Vector2(z, y)));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false, curveSegments: 1 });
    // shape (sx, sy, ez) → hull (−ez, sy, sx), then centre the width
    this.add(geo, color, x + width / 2, 0, 0, 0, -Math.PI / 2, 0);
  }

  /** A tapered block: bottom w0×d0, top w1×d1, height h (turrets, cabs). */
  frustum(w0: number, d0: number, w1: number, d1: number, h: number, color: Rgb, x: number, y: number, z: number, dz1 = 0): void {
    const g = new THREE.BoxGeometry(1, 1, 1);
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const top = p.getY(i) > 0;
      p.setXYZ(i, p.getX(i) * (top ? w1 : w0), (p.getY(i) + 0.5) * h, p.getZ(i) * (top ? d1 : d0) + (top ? dz1 : 0));
    }
    g.computeVertexNormals();
    this.add(g, color, x, y, z);
  }

  merge(): THREE.BufferGeometry {
    const g = mergeGeometries(this.list, false)!;
    for (const x of this.list) x.dispose();
    this.list.length = 0;
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** Road wheels + track run for a tracked vehicle (both sides). */
function runningGear(P: Parts, lod: Lod, o: { halfTrack: number; trackW: number; len: number; wheels: number; r: number; wy: number; z0: number; z1: number; sprocketRear: boolean; top: number }): void {
  for (const sx of [-1, 1]) {
    const x = sx * o.halfTrack;
    // the track: top run, bottom run and the ends (a flattened loop); links run with the odometer
    P.tagged(PART.track, o.top / 2, 0, 0, () => {
      P.box(o.trackW, 0.09, o.len, PAINT.track, x, o.top, 0);
      P.box(o.trackW, 0.09, o.len - 0.9, PAINT.track, x, 0.045, 0);
      if (lod === 2) P.box(o.trackW, o.top - 0.05, o.len - 0.4, PAINT.track, x, o.top / 2, 0);
    });
    if (lod === 2) continue;
    const seg = lod === 0 ? 14 : 8;
    for (let k = 0; k < o.wheels; k++) {
      const z = o.z0 + ((o.z1 - o.z0) * k) / (o.wheels - 1);
      P.tagged(PART.wheel, o.wy, z, o.r, () => {
        P.cylX(o.r, o.trackW * 0.8, PAINT.greenDark, x, o.wy, z, seg);
        if (lod === 0) P.cylX(o.r * 0.45, o.trackW * 0.86, PAINT.steel, x, o.wy, z, 8);
      });
    }
    const zs = o.sprocketRear ? o.len / 2 - 0.35 : -o.len / 2 + 0.35;
    const zi = o.sprocketRear ? -o.len / 2 + 0.35 : o.len / 2 - 0.35;
    P.tagged(PART.wheel, o.top - 0.3, zs, 0.32, () => P.cylX(0.32, o.trackW * 0.9, PAINT.steel, x, o.top - 0.3, zs, seg));
    P.tagged(PART.wheel, o.top - 0.34, zi, 0.28, () => P.cylX(0.28, o.trackW * 0.8, PAINT.greenDark, x, o.top - 0.34, zi, seg));
    // track wrapping the sprocket and idler
    P.tagged(PART.wheel, o.top - 0.35, zs, 0.4, () => P.cylX(0.4, o.trackW, PAINT.track, x, o.top - 0.35, zs, seg));
    P.tagged(PART.wheel, o.top - 0.37, zi, 0.36, () => P.cylX(0.36, o.trackW, PAINT.track, x, o.top - 0.37, zi, seg));
  }
}

function t72(lod: Lod): ClassModel {
  const H = new Parts();
  const T = new Parts();
  const G = PAINT.green;
  // lower + upper hull (side profile: steep upper glacis, rear plate)
  H.prism([[-3.47, 0.62], [-2.95, 0.45], [3.3, 0.45], [3.45, 0.7], [3.45, 1.38], [-2.35, 1.45], [-3.47, 0.95]], 2.2, G);
  // fenders over the tracks
  for (const sx of [-1, 1]) {
    H.box(0.62, 0.05, 6.9, G, sx * 1.47, 0.98, 0);
    // rubber side skirts (the T-72's flaps over the upper track)
    H.box(0.05, 0.42, 6.0, lod === 2 ? G : PAINT.greenDark, sx * 1.77, 0.78, -0.25);
    if (lod === 0) {
      // Kontakt-1 bricks on the front of the skirts
      for (let k = 0; k < 4; k++) H.box(0.09, 0.26, 0.42, PAINT.greenLight, sx * 1.8, 0.8, -3.0 + k * 0.47);
      // stowage bins / fuel cells on the right fender, boxes on the left
      for (let k = 0; k < 3; k++) H.box(0.5, 0.36, 0.9, sx > 0 ? G : PAINT.greenDark, sx * 1.46, 1.19, 0.3 + k * 1.0);
    }
  }
  runningGear(H, lod, { halfTrack: 1.44, trackW: 0.58, len: 6.3, wheels: 6, r: 0.375, wy: 0.42, z0: -2.2, z1: 2.1, sprocketRear: true, top: 0.86 });
  if (lod < 2) {
    // ERA on the glacis (two rows) and the V splash board
    for (let k = 0; k < 7; k++) H.box(0.28, 0.06, 0.34, PAINT.greenLight, -0.9 + k * 0.3, 1.02, -2.95, -0.37 * Math.PI, 0, 0);
    H.box(1.6, 0.12, 0.08, G, 0, 1.36, -2.45, 0, 0, 0);
    // rear: two external fuel drums and the unditching log
    H.cylX(0.29, 0.85, PAINT.greenDark, -0.62, 1.05, 3.72, lod === 0 ? 14 : 8);
    H.cylX(0.29, 0.85, PAINT.greenDark, 0.62, 1.05, 3.72, lod === 0 ? 14 : 8);
    H.cylX(0.13, 3.3, PAINT.wood, 0, 1.52, 3.42, 8);
    // engine deck grilles
    if (lod === 0) for (let k = 0; k < 5; k++) H.box(1.9, 0.03, 0.12, PAINT.greenDark, 0, 1.44, 1.3 + k * 0.35);
    // driver's hatch
    H.cylY(0.26, 0.28, 0.08, G, 0, 1.43, -2.1, 10);
  }
  // turret: the rounded cast dome
  const seg = lod === 0 ? 22 : lod === 1 ? 12 : 6;
  T.add(new THREE.SphereGeometry(1, seg, Math.max(3, seg >> 1), 0, Math.PI * 2, 0, Math.PI / 2), G, 0, 0, 0.1, 0, 0, 0, 1.12, 0.72, 1.28);
  T.cylY(1.08, 1.1, 0.12, G, 0, -0.05, 0.1, seg);
  // mantlet + 125 mm 2A46: thermal sleeve, fume extractor, muzzle
  T.box(0.6, 0.42, 0.45, G, 0, 0.38, -1.12);
  const gs = lod === 0 ? 12 : 6;
  T.barrel(0.13, 0.12, 1.9, G, 0, 0.4, -1.3, gs);
  T.barrel(0.11, 0.1, 3.2, G, 0, 0.4, -3.2, gs);
  T.barrel(0.15, 0.15, 0.62, PAINT.greenDark, 0, 0.4, -2.95, gs);
  if (lod < 2) {
    // Kontakt-1 chevron on the turret front and roof
    for (const sx of [-1, 1]) {
      for (let k = 0; k < 4; k++) T.box(0.32, 0.22, 0.26, PAINT.greenLight, sx * (0.45 + k * 0.2), 0.36 - k * 0.02, -1.12 + k * 0.28, 0, sx * 0.6, 0);
      for (let k = 0; k < 3; k++) T.box(0.34, 0.07, 0.3, PAINT.greenLight, sx * (0.35 + k * 0.28), 0.66, -0.55 + k * 0.1, 0.2, 0, 0);
    }
    // commander's cupola (right) with the NSVT, gunner's hatch (left), IR searchlight (right of the gun)
    T.cylY(0.34, 0.37, 0.2, G, 0.5, 0.62, 0.2, lod === 0 ? 14 : 8);
    T.barrel(0.03, 0.025, 1.2, PAINT.steel, 0.5, 0.95, 0.0, 6);
    T.box(0.12, 0.2, 0.35, PAINT.steel, 0.5, 0.9, 0.15);
    T.cylY(0.28, 0.3, 0.12, G, -0.5, 0.63, 0.25, 10);
    T.barrel(0.19, 0.19, 0.34, PAINT.greenDark, 0.62, 0.62, -0.9, 10);
    T.box(0.16, 0.05, 0.16, PAINT.lamp, 0.62, 0.62, -1.26);
    // snorkel tube along the turret rear, stowage box
    T.cylX(0.1, 1.5, PAINT.greenDark, -0.2, 0.42, 1.28, 8);
    T.box(1.1, 0.35, 0.3, PAINT.greenDark, 0.35, 0.3, 1.25);
  }
  return { hull: H.merge(), turret: T.merge(), ring: { y: 1.45, z: -0.35 }, turretCg: 0.35 };
}

function bmp2(lod: Lod): ClassModel {
  const H = new Parts();
  const T = new Parts();
  const G = PAINT.green;
  // boat-shaped hull: long ribbed upper glacis, sharp bow, vertical rear with doors
  H.prism([[-3.36, 0.72], [-2.9, 0.42], [3.2, 0.42], [3.36, 0.62], [3.36, 1.72], [-1.2, 1.78], [-3.36, 0.9]], 2.4, G);
  for (const sx of [-1, 1]) H.box(0.42, 0.05, 6.6, G, sx * 1.36, 1.02, 0);
  runningGear(H, lod, { halfTrack: 1.32, trackW: 0.3, len: 6.2, wheels: 6, r: 0.33, wy: 0.4, z0: -2.1, z1: 2.3, sprocketRear: false, top: 0.86 });
  if (lod < 2) {
    // ribs on the glacis, headlights, troop hatches, rear doors (fuel tanks)
    if (lod === 0) for (let k = 0; k < 6; k++) H.box(2.2, 0.03, 0.05, PAINT.greenDark, 0, 0.98 + k * 0.14, -3.0 + k * 0.36, 0.0, 0, 0);
    for (let k = 0; k < 4; k++) H.box(0.55, 0.05, 0.7, PAINT.greenDark, (k % 2 ? 0.4 : -0.4), 1.79, 1.1 + Math.floor(k / 2) * 0.95);
    H.box(0.7, 1.0, 0.08, PAINT.greenDark, -0.5, 1.05, 3.38);
    H.box(0.7, 1.0, 0.08, PAINT.greenDark, 0.5, 1.05, 3.38);
    H.cylY(0.24, 0.26, 0.08, G, -0.6, 1.3, -1.9, 10);
  }
  // two-man turret, 30 mm 2A42 with its long thin barrel, Konkurs ATGM tube on the roof
  T.frustum(1.8, 1.9, 1.35, 1.3, 0.55, G, 0, 0, 0.05, 0.08);
  T.box(0.4, 0.34, 0.35, G, 0, 0.3, -1.0);
  T.barrel(0.07, 0.055, 3.0, G, 0, 0.32, -1.1, lod === 0 ? 10 : 6);
  T.barrel(0.075, 0.075, 0.28, PAINT.greenDark, 0, 0.32, -3.9, 8);
  if (lod < 2) {
    T.barrel(0.075, 0.075, 1.25, PAINT.greenLight, 0.45, 0.75, -0.2, 8);
    T.box(0.08, 0.2, 0.08, PAINT.steel, 0.45, 0.62, 0.0);
    T.cylY(0.25, 0.27, 0.1, G, -0.35, 0.55, 0.2, 10);
    T.cylY(0.25, 0.27, 0.1, G, 0.3, 0.55, 0.3, 10);
  }
  return { hull: H.merge(), turret: T.merge(), ring: { y: 1.78, z: -0.35 }, turretCg: 0.25 };
}

function btr80(lod: Lod): ClassModel {
  const H = new Parts();
  const T = new Parts();
  const G = PAINT.green;
  // sloped boat hull on 8 big wheels
  H.prism([[-3.82, 0.95], [-3.35, 0.5], [3.4, 0.5], [3.82, 1.1], [3.7, 1.95], [-2.2, 2.0], [-3.82, 1.4]], 2.35, G);
  // the upper sides lean in: a narrower roof strip
  H.frustum(2.9, 7.0, 2.3, 6.0, 0.5, G, 0, 1.45, 0.05);
  const seg = lod === 0 ? 16 : lod === 1 ? 10 : 6;
  for (const sx of [-1, 1]) {
    for (const z of [-2.3, -0.9, 0.9, 2.3]) {
      H.tagged(PART.wheel, 0.56, z, 0.56, () => {
        H.cylX(0.56, 0.36, PAINT.rubber, sx * 1.18, 0.56, z, seg);
        if (lod === 0) H.cylX(0.3, 0.38, PAINT.greenDark, sx * 1.19, 0.56, z, 10);
      });
    }
    if (lod < 2) H.box(0.06, 0.75, 0.9, PAINT.greenDark, sx * 1.46, 1.35, 0.0); // side doors
  }
  if (lod < 2) {
    H.box(2.0, 0.05, 0.6, PAINT.greenDark, 0, 1.5, -3.55, -0.9, 0, 0); // trim vane
    H.box(1.8, 0.04, 1.3, PAINT.greenDark, 0, 1.99, 2.6); // engine grilles
    for (const sx of [-1, 1]) H.box(0.35, 0.3, 0.08, PAINT.glass, sx * 0.55, 1.75, -2.9, -0.5, 0, 0); // vision blocks
  }
  // small conical turret with the 14.5 mm KPVT
  T.add(new THREE.CylinderGeometry(0.42, 0.62, 0.48, seg), G, 0, 0.24, 0);
  T.barrel(0.05, 0.04, 1.75, G, 0, 0.26, -0.5, 8);
  if (lod < 2) T.barrel(0.025, 0.02, 0.8, PAINT.steel, 0.16, 0.26, -0.5, 6);
  return { hull: H.merge(), turret: T.merge(), ring: { y: 2.0, z: -1.2 }, turretCg: 0.2 };
}

function ural(lod: Lod): ClassModel {
  const H = new Parts();
  const G = PAINT.green;
  const seg = lod === 0 ? 16 : lod === 1 ? 10 : 6;
  // frame, bonnet (the Ural-4320 is a normal-control truck: long hood in front of the cab), cab
  H.box(1.0, 0.25, 7.0, PAINT.greenDark, 0, 1.0, 0.1);
  H.box(1.2, 0.5, 0.35, PAINT.greenDark, 0, 0.95, -3.55);
  H.frustum(1.3, 1.6, 1.15, 1.5, 0.75, G, 0, 1.2, -2.75);
  H.box(2.45, 0.12, 1.2, G, 0, 1.22, -2.75); // wide flared wings over the front wheels
  H.box(2.35, 1.35, 1.65, G, 0, 1.25 + 0.67, -1.35);
  H.box(2.1, 0.5, 0.06, PAINT.glass, 0, 2.3, -2.18);
  // cargo bed with the canvas tilt over bows
  H.box(2.5, 0.55, 4.1, PAINT.greenDark, 0, 1.45, 1.55);
  H.box(2.5, 0.9, 4.05, PAINT.canvas, 0, 2.17, 1.55);
  H.add(new THREE.CylinderGeometry(1.25, 1.25, 4.05, lod === 0 ? 20 : 10, 1, false, 0, Math.PI), PAINT.canvas, 0, 2.6, 1.55, Math.PI / 2, 0, 0, 1, 1, 0.21);
  if (lod === 0) {
    H.cylX(0.48, 0.3, PAINT.rubber, 0, 1.7, -0.35, 12); // spare wheel behind the cab
    H.box(1.0, 0.3, 0.06, PAINT.steel, 0, 1.3, -3.72); // grille
    for (const sx of [-1, 1]) H.box(0.18, 0.18, 0.05, PAINT.lamp, sx * 0.9, 1.5, -3.4);
  }
  for (const sx of [-1, 1]) for (const z of [-2.55, 1.0, 2.4]) {
    H.tagged(PART.wheel, 0.54, z, 0.54, () => {
      H.cylX(0.54, 0.4, PAINT.rubber, sx * 1.02, 0.54, z, seg);
      if (lod === 0) H.cylX(0.28, 0.42, PAINT.greenDark, sx * 1.02, 0.54, z, 10);
    });
  }
  return { hull: H.merge(), turret: null, ring: { y: 0, z: 0 }, turretCg: 0 };
}

function zsu(lod: Lod): ClassModel {
  const H = new Parts();
  const T = new Parts();
  const G = PAINT.green;
  H.prism([[-3.27, 0.72], [-2.9, 0.4], [3.1, 0.4], [3.27, 0.6], [3.27, 1.3], [-2.6, 1.35], [-3.27, 1.0]], 2.3, G);
  for (const sx of [-1, 1]) H.box(0.5, 0.05, 6.5, G, sx * 1.4, 0.95, 0);
  runningGear(H, lod, { halfTrack: 1.35, trackW: 0.36, len: 6.1, wheels: 6, r: 0.33, wy: 0.38, z0: -2.3, z1: 2.3, sprocketRear: true, top: 0.82 });
  // the big flat box turret overhanging the hull, four 2A7 barrels, the RPK-2 radar on its mast
  T.frustum(2.95, 2.9, 2.75, 2.5, 0.8, G, 0, 0, 0.2, 0.1);
  T.box(2.2, 0.55, 0.5, G, 0, 0.25, -1.3);
  const bs = lod === 0 ? 8 : 5;
  for (const sx of [-1, 1]) for (const dy of [0, 0.22]) T.barrel(0.035, 0.03, 2.0, PAINT.steel, sx * 0.55, 0.3 + dy, -1.5, bs);
  if (lod < 2) {
    for (const sx of [-1, 1]) T.box(0.3, 0.45, 0.5, PAINT.greenDark, sx * 0.55, 0.42, -1.55);
    T.cylY(0.07, 0.07, 0.55, PAINT.steel, 0, 0.8, 1.1, 8);
    // the RPK-2 dish on its mast: spins about the mast (shader)
    T.tagged(PART.dish, 1.45, 1.1, 0.62, () => {
      T.add(new THREE.CylinderGeometry(0.62, 0.62, 0.08, lod === 0 ? 18 : 10), PAINT.greenLight, 0, 1.45, 1.05, Math.PI / 2 - 0.35, 0, 0);
      T.box(0.14, 0.14, 0.3, PAINT.steel, 0, 1.4, 1.2);
    });
    T.cylY(0.3, 0.32, 0.12, G, -0.6, 0.8, 0.4, 10);
    T.cylY(0.3, 0.32, 0.12, G, 0.6, 0.8, 0.4, 10);
  }
  return { hull: H.merge(), turret: T.merge(), ring: { y: 1.35, z: -0.2 }, turretCg: 0.35 };
}

const BUILDERS: Record<TargetKind, (lod: Lod) => ClassModel> = { tank: t72, ifv: bmp2, apc: btr80, truck: ural, aaa: zsu };

export function buildClassModel(kind: TargetKind, lod: Lod): ClassModel {
  return BUILDERS[kind](lod);
}

export const TARGET_KINDS: readonly TargetKind[] = ['tank', 'ifv', 'apc', 'truck', 'aaa'];
