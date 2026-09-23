/**
 * 747-400 fuselage: one loft from the round nose to the tail cone (the upper-deck hump and the
 * wing-body fairing come from the section function in shape.ts), resampled uniformly in arc
 * length around every station so the atlas v coordinate is simply the arc length s. Split into the
 * nose section, the centre (wing box) and the aft body for the crash break-up. Also the flight-deck
 * window glass (six panes on the forehead and the hump sides), the APU exhaust and small details.
 */
import * as THREE from 'three';
import { loftGeometry } from '../loft';
import { tint, merge } from '../materials';
import { tube, box, ellipsoid, V } from '../f16/geom';
import { fuselageUV } from './atlas';
import {
  COCKPIT_WINDOWS, SPLIT_AFT_Z, SPLIT_FWD_Z, FUSE_END_Z as TAIL_Z, clamp, fuselageStations, halfOutline, lerp, outlineAt, sAtY, section, xAtY,
} from './shape';

/** Segments per half ring (top centre → keel). */
export const HALF_SEGS = 44;

export interface FuselageBuild {
  forward: THREE.BufferGeometry;
  centre: THREE.BufferGeometry;
  aft: THREE.BufferGeometry;
  /** Flight-deck window panes (both sides), 1 cm proud of the skin. */
  glass: THREE.BufferGeometry;
  /** Small parts per section (parts material). */
  detailsForward: THREE.BufferGeometry;
  detailsCentre: THREE.BufferGeometry;
  detailsAft: THREE.BufferGeometry;
  /** Anti-collision beacons (top of the fuselage behind the hump, belly under the wing box). */
  beaconTop: THREE.Vector3;
  beaconBottom: THREE.Vector3;
}

/** One ring of the loft at station z: right side keel → top, then the left side top → keel. */
function ring(z: number, sArr: number[]): number[] {
  const h = halfOutline(z, 160);
  const total = h[h.length - 1];
  const H = HALF_SEGS + 1;
  const half: [number, number, number][] = [];
  const p: [number, number] = [0, 0];
  for (let k = 0; k < H; k++) {
    const s = (k / HALF_SEGS) * total;
    outlineAt(h, s, p);
    half.push([p[0], p[1], s]);
  }
  const out: number[] = [];
  sArr.length = 0;
  for (let k = H - 1; k >= 0; k--) {
    out.push(half[k][0], half[k][1], z);
    sArr.push(half[k][2]);
  }
  for (let k = 1; k < H - 1; k++) {
    out.push(-half[k][0], half[k][1], z);
    sArr.push(-half[k][2]);
  }
  // Seam column (duplicate of j = 0) carries the left keel's s.
  sArr.push(-total);
  return out;
}

function loftRange(zs: number[]): THREE.BufferGeometry {
  const rings: number[][] = [];
  const sCols: number[][] = [];
  for (const z of zs) {
    const s: number[] = [];
    rings.push(ring(z, s));
    sCols.push(s);
  }
  const geo = loftGeometry(rings, { closed: true });
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  const cols = sCols[0].length;
  const t: [number, number] = [0, 0];
  for (let i = 0; i < zs.length; i++) {
    for (let j = 0; j < cols; j++) {
      fuselageUV(zs[i], sCols[i][j], t);
      uv.setXY(i * cols + j, t[0], t[1]);
    }
  }
  return geo;
}

// ─── Flight-deck windows ─────────────────────────────────────────────────────

/** Station z where the outline passes (x, y) on the forehead (bisection: the section grows aft). */
export function foreheadZ(x: number, y: number): number {
  let lo = -31.5;
  let hi = -26.5;
  for (let i = 0; i < 28; i++) {
    const mid = (lo + hi) / 2;
    const w = xAtY(halfOutline(mid, 72), y);
    if (w < x) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Body point of a window patch at (a, b) ∈ [0,1]² (right side). index 0 = front screen, 1–2 side windows. */
export function windowPoint(index: number, a: number, b: number): THREE.Vector3 {
  if (index === 0) {
    const w = COCKPIT_WINDOWS.front;
    const y = lerp(w.y0, w.y1, b);
    const x = lerp(w.x0, lerp(w.x1, w.x1Top, b), a);
    return V(x, y, foreheadZ(x, y));
  }
  const w = COCKPIT_WINDOWS.side[index - 1];
  const y = lerp(w.y0, w.y1, b);
  const z = lerp(lerp(w.z0, w.z0Top, b), lerp(w.z1, w.z1Top, b), a);
  return V(xAtY(halfOutline(z, 96), y), y, z);
}

/** Window outline (right side, body coordinates) — for the livery painter. */
export function windowOutline(index: number, n = 6): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) pts.push(windowPoint(index, i / n, 0));
  for (let i = 0; i < n; i++) pts.push(windowPoint(index, 1, i / n));
  for (let i = n; i > 0; i--) pts.push(windowPoint(index, i / n, 1));
  for (let i = n; i > 0; i--) pts.push(windowPoint(index, 0, i / n));
  return pts;
}

/** Arc length s on the right side of station z at height y (for the painter). */
export function sOn(z: number, y: number): number {
  return sAtY(halfOutline(z, 160), y);
}

function glassPatch(index: number, side: 1 | -1): THREE.BufferGeometry {
  const NA = 7;
  const NB = 6;
  const pos: number[] = [];
  const grid: THREE.Vector3[][] = [];
  for (let i = 0; i <= NA; i++) {
    const row: THREE.Vector3[] = [];
    for (let j = 0; j <= NB; j++) row.push(windowPoint(index, i / NA, j / NB));
    grid.push(row);
  }
  // Offset each point 1.2 cm along the outward surface normal.
  const out: THREE.Vector3[][] = grid.map((row, i) =>
    row.map((p, j) => {
      const da = grid[Math.min(NA, i + 1)][j].clone().sub(grid[Math.max(0, i - 1)][j]);
      const db = grid[i][Math.min(NB, j + 1)].clone().sub(grid[i][Math.max(0, j - 1)]);
      const n = new THREE.Vector3().crossVectors(da, db).normalize();
      const s = section(p.z);
      const radial = V(p.x, p.y - s.cy, -0.6);
      if (n.dot(radial) < 0) n.negate();
      return p.clone().addScaledVector(n, 0.012);
    }),
  );
  const idx: number[] = [];
  for (let i = 0; i <= NA; i++) for (let j = 0; j <= NB; j++) pos.push(side * out[i][j].x, out[i][j].y, out[i][j].z);
  const at = (i: number, j: number) => i * (NB + 1) + j;
  for (let i = 0; i < NA; i++) {
    for (let j = 0; j < NB; j++) {
      const a = at(i, j);
      const b = at(i + 1, j);
      const c = at(i + 1, j + 1);
      const d = at(i, j + 1);
      idx.push(a, b, c, a, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // Glass is double sided; orientation only matters for the normals (point outward).
  const n = g.getAttribute('normal');
  const p0 = out[NA >> 1][NB >> 1];
  const s0 = section(p0.z);
  const outward = V(side * p0.x, p0.y - s0.cy, -0.6);
  const nn = V(n.getX(at(NA >> 1, NB >> 1)), n.getY(at(NA >> 1, NB >> 1)), n.getZ(at(NA >> 1, NB >> 1)));
  if (nn.dot(outward) < 0) for (let k = 0; k < n.count; k++) n.setXYZ(k, -n.getX(k), -n.getY(k), -n.getZ(k));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n.count * 2), 2));
  return g;
}

// ─── Small parts ─────────────────────────────────────────────────────────────

const DARK = 0x2a2c2e;
const GREY = 0x9aa0a6;
const WHITE = 0xe9ecef;

function crownY(z: number): number {
  return halfOutline(z, 8)[1];
}
function keelY(z: number): number {
  const h = halfOutline(z, 8);
  return h[h.length - 2];
}

function detailsFor(zone: 'forward' | 'centre' | 'aft'): THREE.BufferGeometry {
  const g: THREE.BufferGeometry[] = [];
  if (zone === 'forward') {
    // Pitot probes and AoA vanes on both sides below the flight deck, a VHF blade on the hump.
    for (const s of [-1, 1]) {
      const z = -29.2;
      const h = halfOutline(z, 96);
      const x = xAtY(h, 1.2);
      g.push(tint(tube(V(s * (x - 0.02), 1.2, z), V(s * (x + 0.1), 1.18, z - 0.16), 0.018, 0.012, 6), GREY, 0.35, 0.8));
      g.push(tint(box(0.01, 0.07, 0.1, V(s * (x + 0.02), 0.7, z + 0.4)), GREY, 0.4, 0.7));
    }
    g.push(tint(box(0.02, 0.3, 0.42, V(0, crownY(-20) + 0.13, -20), -0.45, 0, 0), WHITE, 0.4, 0.1));
    // Belly VHF / DME blades.
    g.push(tint(box(0.02, 0.26, 0.36, V(0, keelY(-18) - 0.11, -18), 0.45, 0, 0), WHITE, 0.4, 0.1));
  } else if (zone === 'centre') {
    // SATCOM fairing on the crown behind the hump, blades.
    g.push(tint(ellipsoid(V(0, crownY(6) + 0.02, 6), 0.45, 0.16, 1.3, 16, 8), WHITE, 0.45, 0.05));
    g.push(tint(box(0.02, 0.32, 0.4, V(0, crownY(10) + 0.14, 10), -0.45, 0, 0), WHITE, 0.4, 0.1));
    g.push(tint(box(0.02, 0.22, 0.34, V(0, keelY(9) - 0.09, 9), 0.45, 0, 0), WHITE, 0.4, 0.1));
  } else {
    // APU exhaust: a dark recess at the tail-cone tip, and the APU intake door on the right side.
    const h = halfOutline(TAIL_Z, 32);
    const pts: number[] = [];
    const cy = (h[1] + h[h.length - 2]) / 2;
    const r = (h[1] - h[h.length - 2]) / 2;
    g.push(tint(tube(V(0, cy, TAIL_Z - 0.25), V(0, cy, TAIL_Z + 0.003), r * 0.82, r * 0.82, 16, true), 0x151515, 0.8, 0.2));
    g.push(tint(new THREE.CircleGeometry(r * 0.82, 16).translate(0, cy, TAIL_Z - 0.2), 0x0b0b0b, 0.9, 0));
    void pts;
    const zi = 34.5;
    const xi = xAtY(halfOutline(zi, 96), 1.9);
    g.push(tint(box(0.03, 0.34, 0.9, V(xi + 0.005, 1.9, zi)), 0x8d9296, 0.5, 0.3));
  }
  return merge(g);
}

export function buildFuselage(): FuselageBuild {
  const zs = fuselageStations();
  const iF = zs.indexOf(SPLIT_FWD_Z);
  const iA = zs.indexOf(SPLIT_AFT_Z);
  const forward = loftRange(zs.slice(0, iF + 1));
  const centre = loftRange(zs.slice(iF, iA + 1));
  const aft = loftRange(zs.slice(iA));
  const panes: THREE.BufferGeometry[] = [];
  for (const side of [1, -1] as const) for (let w = 0; w < 3; w++) panes.push(glassPatch(w, side));
  const glass = merge(panes);
  const zTop = 1.5;
  const zBot = -6;
  return {
    forward,
    centre,
    aft,
    glass,
    detailsForward: detailsFor('forward'),
    detailsCentre: detailsFor('centre'),
    detailsAft: detailsFor('aft'),
    beaconTop: V(0, crownY(zTop) + 0.09, zTop),
    beaconBottom: V(0, keelY(zBot) - 0.09, zBot),
  };
}

export { clamp };
