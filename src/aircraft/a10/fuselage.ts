/**
 * A-10 fuselage geometry: one loft from the blunt nose to the tail cone (the cockpit tub open under
 * the canopy), split into the forward fuselage (nose, cockpit, gun bay — its own crash part) and
 * the main fuselage, with atlas UVs from (station z, arc length s) — plus the per-station outline
 * the livery painter needs to put the shark mouth, the insignia and the panel lines in place.
 */
import * as THREE from 'three';
import { loftGeometry } from '../loft';
import { fuselageUV } from './atlas';
import { EDGE_INDEX, FUSE_END_Z, HALF_POINTS, SHOULDER_INDEX, TAIL_CONE, bodyHalf, fuselageStations } from './shape';

/** Per-station outline data for the livery painter. */
export interface FuselageStationInfo {
  z: number;
  /** Arc length (m) from the top centreline to the widest point on one side. */
  sEdge: number;
  /** Arc length from the top centreline to the bottom centreline (half perimeter). */
  sHalf: number;
  /** Arc length to the upper shoulder (canopy sill). */
  sShoulder: number;
  /** Half ring points with their arc length: [x, y, s]. */
  half: [number, number, number][];
}

export interface FuselageBuild {
  /** Nose + cockpit section (ahead of SPLIT_Z) and the main fuselage + tail cone behind it. */
  forward: THREE.BufferGeometry;
  main: THREE.BufferGeometry;
  stations: FuselageStationInfo[];
}

/** Where the forward fuselage (nose, cockpit, gun bay) separates from the main fuselage. */
export const SPLIT_Z = -2.9;

/** Arc lengths along a sampled half ring from the top centre. */
export function halfWithArc(half: [number, number][]): [number, number, number][] {
  const out: [number, number, number][] = [];
  let s = 0;
  for (let k = 0; k < half.length; k++) {
    if (k > 0) s += Math.hypot(half[k][0] - half[k - 1][0], half[k][1] - half[k - 1][1]);
    out.push([half[k][0], half[k][1], s]);
  }
  return out;
}

export function buildFuselage(): FuselageBuild {
  const stations = [...new Set([...fuselageStations(), SPLIT_Z])].sort((a, b) => a - b);
  // Tail cone: shrink the last section onto the tail-light point.
  const endHalf = bodyHalf(FUSE_END_Z);
  const cy = (endHalf[0][1] + endHalf[endHalf.length - 1][1]) / 2;
  const coneZ = [FUSE_END_Z + 0.08, FUSE_END_Z + 0.15, FUSE_END_Z + 0.2, TAIL_CONE.z];
  const coneF = [0.86, 0.62, 0.36, 0];
  const H = HALF_POINTS;
  const halves: [number, number][][] = stations.map((z) => bodyHalf(z));
  for (let i = 0; i < coneZ.length; i++) {
    const f = coneF[i];
    const ay = cy + (TAIL_CONE.y - cy) * (1 - f);
    halves.push(endHalf.map(([x, y]) => [x * f, ay + (y - cy) * f] as [number, number]));
  }
  const allZ = [...stations, ...coneZ];
  const ringOf = (half: [number, number][], z: number) => {
    const ring: number[] = [];
    for (let k = H - 1; k >= 0; k--) ring.push(half[k][0], half[k][1], z);
    for (let k = 1; k < H - 1; k++) ring.push(-half[k][0], half[k][1], z);
    return ring;
  };
  const info: FuselageStationInfo[] = allZ.map((z, i) => {
    const half = halfWithArc(halves[i]);
    return { z, sEdge: half[EDGE_INDEX][2], sHalf: half[H - 1][2], sShoulder: half[SHOULDER_INDEX][2], half };
  });
  const N = 2 * H - 2;
  const cols = N + 1;
  const tmp: [number, number] = [0, 0];
  const loft = (i0: number, i1: number) => {
    const rings: number[][] = [];
    for (let i = i0; i <= i1; i++) rings.push(ringOf(halves[i], allZ[i]));
    const geo = loftGeometry(rings, { closed: true });
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = i0; i <= i1; i++) {
      const { z, half, sHalf } = info[i];
      for (let j = 0; j < cols; j++) {
        // Ring index: 0 = bottom centre, H-1 = top centre, then down the left side; j = N is the seam.
        let s: number;
        if (j <= H - 1) s = half[H - 1 - j][2];
        else if (j < N) s = -half[j - (H - 1)][2];
        else s = -sHalf;
        fuselageUV(z, s, tmp);
        uv.setXY((i - i0) * cols + j, tmp[0], tmp[1]);
      }
    }
    return geo;
  };
  const split = allZ.indexOf(SPLIT_Z);
  return { forward: loft(0, split), main: loft(split, allZ.length - 1), stations: info };
}

/** The station record nearest z. */
export function stationAt(st: FuselageStationInfo[], z: number): FuselageStationInfo {
  return st.reduce((a, b) => (Math.abs(b.z - z) < Math.abs(a.z - z) ? b : a));
}

/** Arc length on a station's side where the outline passes height y (upper = above the widest point). */
export function sAtY(st: FuselageStationInfo, y: number, upper: boolean): number | null {
  const h = st.half;
  const k0 = upper ? 0 : EDGE_INDEX;
  const k1 = upper ? EDGE_INDEX : h.length - 1;
  for (let k = k0; k < k1; k++) {
    const a = h[k];
    const b = h[k + 1];
    if ((a[1] - y) * (b[1] - y) <= 0 && a[1] !== b[1]) return a[2] + ((b[2] - a[2]) * (y - a[1])) / (b[1] - a[1]);
  }
  return null;
}
