/**
 * Fuselage geometry: the painted outer skin (lofted from the profile curves in
 * shape.ts), the glass shell that shows through the window holes, and the
 * cabin's inner shell (seen from the cockpit).
 *
 * UV convention of every fuselage loft: u = ring parameter t (0 top, 0.25 left,
 * 0.5 belly, 0.75 right), v = (z − FUSE_Z0) / (FUSE_Z1 − FUSE_Z0) for the outer
 * skin and glass, (z − CABIN_Z0) / (CABIN_Z1 − CABIN_Z0) for the inner shell.
 * The livery painter (livery.ts) evaluates the same surface per texel.
 */
import * as THREE from 'three';
import { loftGeometry } from './loft';
import { FUSE_Z0, FUSE_Z1, fuselageSection, fuselageStations, superSectionPoint, type SectionParams } from './shape';

export const CABIN_Z0 = -1.24;
export const CABIN_Z1 = 2.06;

const _s: SectionParams = { top: 0, bottom: 0, halfWidth: 0, widthY: 0, nTop: 2, nBot: 2 };
const _p = { x: 0, y: 0 };
const _q = { x: 0, y: 0 };

/** Surface point at (t, z) pushed `inset` metres inward along the section normal. */
export function fuselagePoint(t: number, z: number, inset: number, out: { x: number; y: number }) {
  fuselageSection(z, _s);
  superSectionPoint(_s, t, out);
  if (inset !== 0) {
    const e = 1e-3;
    superSectionPoint(_s, t - e, _p);
    superSectionPoint(_s, t + e, _q);
    const tx = _q.x - _p.x;
    const ty = _q.y - _p.y;
    const l = Math.hypot(tx, ty) || 1;
    // Outward normal of a CCW ring (seen from +z) = tangent rotated −90°.
    const nx = ty / l;
    const ny = -tx / l;
    out.x -= nx * inset;
    out.y -= ny * inset;
  }
  return out;
}

function ring(z: number, n: number, inset: number, t0 = 0, t1 = 1, closed = true, scale = 1): number[] {
  const out: number[] = [];
  const count = closed ? n : n + 1;
  const pt = { x: 0, y: 0 };
  fuselageSection(z, _s);
  const cy = (_s.top + _s.bottom) / 2;
  for (let j = 0; j < count; j++) {
    const t = t0 + ((t1 - t0) * j) / n;
    fuselagePoint(t, z, inset, pt);
    out.push(pt.x * scale, cy + (pt.y - cy) * scale, z);
  }
  return out;
}

export interface FuselageGeometry {
  skin: THREE.BufferGeometry;
  glass: THREE.BufferGeometry;
  cabin: THREE.BufferGeometry;
  /** Ring point count used (for the livery painter's resolution choices). */
  ringPoints: number;
}

export function buildFuselage(quality: 'high' | 'low'): FuselageGeometry {
  const N = quality === 'high' ? 72 : 44;
  const zs = fuselageStations(quality);

  // Outer skin: two lip rings round the nose bowl, the body, capped at both ends.
  const lipA = ring(FUSE_Z0 - 0.02, N, 0, 0, 1, true, 0.82);
  const lipB = ring(FUSE_Z0 - 0.011, N, 0, 0, 1, true, 0.94);
  const rings = [lipA, lipB, ...zs.map((z) => ring(z, N, 0))];
  const vOf = (z: number) => Math.max(0, (z - FUSE_Z0) / (FUSE_Z1 - FUSE_Z0));
  const v = [0, 0, ...zs.map(vOf)];
  const skin = loftGeometry(rings, { v, capStart: true, capEnd: true });

  // Glass shell: an open strip over the upper cabin, 6 mm inside the skin.
  const gz: number[] = [];
  for (let z = -1.3; z <= 1.98; z += quality === 'high' ? 0.035 : 0.07) gz.push(z);
  const GN = quality === 'high' ? 64 : 36;
  const glassRings = gz.map((z) => ring(z, GN, 0.006, -0.29, 0.29, false));
  const glass = loftGeometry(glassRings, { closed: false });

  // Cabin inner shell: closed rings 3.5 cm inside the skin, capped (firewall and baggage bulkhead).
  const cz: number[] = [];
  for (let z = CABIN_Z0; z <= CABIN_Z1 + 1e-6; z += quality === 'high' ? 0.04 : 0.08) cz.push(z);
  const cabinRings = cz.map((z) => ring(z, N, 0.035));
  const cabin = loftGeometry(cabinRings, {
    v: cz.map((z) => (z - CABIN_Z0) / (CABIN_Z1 - CABIN_Z0)),
    capStart: true,
    capEnd: true,
  });

  return { skin, glass, cabin, ringPoints: N };
}
