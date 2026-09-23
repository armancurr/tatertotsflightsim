/**
 * Cabin trim of the 172RG as seen from the seats: the moulded dark-grey plastic windshield posts
 * (A-pillars), the windshield header across the top of the windshield (the wet compass hangs
 * from it), and the side-view geometry the cabin painter (livery.ts) uses to keep the inner
 * shell's window openings right up to the trim — so a post reads as a slim 6–7 cm moulding, not
 * as a wide flat band of wall.
 *
 * Side view = (z, y). The post runs along the corridor between the windshield's side edge
 * (PILLAR) and the door window's front edge (DOOR_WINDOW[0] → DOOR_WINDOW[1]), which are parallel
 * lines about 7 cm apart.
 */
import * as THREE from 'three';
import { loftGeometry } from './loft';
import { tint } from './materials';
import { DOOR_WINDOW, PILLAR, fuselageSection, type SectionParams } from './shape';

/** The cabin's inner shell sits this far inside the skin (fuselage.ts). */
export const SHELL_INSET = 0.035;

const zPillar = (y: number) => PILLAR.z0 + ((y - PILLAR.y0) * (PILLAR.z1 - PILLAR.z0)) / (PILLAR.y1 - PILLAR.y0);
const DW0 = DOOR_WINDOW[0];
const DW1 = DOOR_WINDOW[1];
const zDoorFront = (y: number) => DW0[0] + ((y - DW0[1]) * (DW1[0] - DW0[0])) / (DW1[1] - DW0[1]);
/** z of the post centreline at height y. */
export const postCentreZ = (y: number) => (zPillar(y) + zDoorFront(y)) / 2;

// Unit direction of the centreline in side view (dz, dy) and its perpendicular toward the windshield.
const DZ = postCentreZ(1) - postCentreZ(0);
const DL = Math.hypot(DZ, 1);
const TZ = DZ / DL;
const TY = 1 / DL;

/** Windshield-post trim (side view): half-width perpendicular to the post, depth of the moulding, height range. */
export const POST = {
  /** Side-view half width of the moulding (perpendicular to the post). */
  halfWidth: 0.022,
  /** How far the moulding stands in from the shell at its crown. */
  depth: 0.014,
  /** The moulding runs from under the glareshield up into the header. */
  y0: 0.3,
  y1: 0.885,
  /** The painter opens the shell right up to the moulding between these heights. */
  openY0: 0.4,
  openY1: 0.845,
  /** Half the corridor between the windshield edge and the door-window edge (side view). */
  corridorHalf: 0.0349,
} as const;

/** Windshield header trim: z range of the moulding across the top of the windshield. */
export const HEADER = { z0: -0.545, z1: -0.47, depth: 0.016, halfSpan: 0.445 } as const;

/**
 * Signed side-view distance (m) from the post centreline: + toward the windshield (forward/up),
 * − toward the door window.
 */
export function postSideDistance(z: number, y: number): number {
  // Perpendicular of the (TZ, TY) direction pointing forward (−z) and up is (−TY, TZ); measured
  // from the centreline point at the same height.
  return (postCentreZ(y) - z) * TY;
}

const _s: SectionParams = { top: 0, bottom: 0, halfWidth: 0, widthY: 0, nTop: 2, nBot: 2 };

/**
 * Inner shell surface of the upper cabin at height y, station z: |x| of the surface (the shell
 * superellipse shrunk by `inset`) and its inward unit normal in the section plane (nx toward the
 * centreline for the right side, ny downward).
 */
export function innerSurface(y: number, z: number, inset: number, out: { x: number; nx: number; ny: number }) {
  fuselageSection(z, _s);
  const W = _s.halfWidth - inset;
  const H = Math.max(0.05, _s.top - inset - _s.widthY);
  const n = _s.nTop;
  const v = Math.min(0.999, Math.max(0, (y - _s.widthY) / H));
  const u = Math.pow(1 - Math.pow(v, n), 1 / n);
  out.x = W * u;
  // Gradient of (x/W)^n + (dy/H)^n (outward), negated = inward.
  const gx = Math.pow(Math.max(u, 1e-6), n - 1) / W;
  const gy = Math.pow(Math.max(v, 1e-6), n - 1) / H;
  const l = Math.hypot(gx, gy) || 1;
  out.nx = -gx / l;
  out.ny = -gy / l;
  return out;
}

/** Flip a geometry's winding if its normals mostly point away from `toward`. */
function faceToward(g: THREE.BufferGeometry, toward: THREE.Vector3): THREE.BufferGeometry {
  g.computeVertexNormals();
  const p = g.getAttribute('position');
  const n = g.getAttribute('normal');
  let dot = 0;
  for (let i = 0; i < p.count; i++) {
    dot += (toward.x - p.getX(i)) * n.getX(i) + (toward.y - p.getY(i)) * n.getY(i) + (toward.z - p.getZ(i)) * n.getZ(i);
  }
  if (dot < 0 && g.index) {
    const idx = g.index.array as Uint16Array | Uint32Array;
    for (let i = 0; i < idx.length; i += 3) {
      const t = idx[i + 1];
      idx[i + 1] = idx[i + 2];
      idx[i + 2] = t;
    }
    g.index.needsUpdate = true;
    g.computeVertexNormals();
  }
  return g;
}

/** Crown profile across a moulding: 0 at the edges, 1 at the centre (a flattened half-round). */
const crown = (f: number) => Math.pow(Math.max(0, 1 - f * f), 0.6);

const CABIN_CENTRE = new THREE.Vector3(0, 0.45, -0.3);
export const TRIM_COLOR = 0x3a3b3e;

/** One windshield post moulding (side −1 = left, +1 = right), in body coordinates. */
export function postTrimGeometry(side: -1 | 1): THREE.BufferGeometry {
  const rings: number[][] = [];
  const across = 9;
  const surf = { x: 0, nx: 0, ny: 0 };
  const steps = 30;
  for (let i = 0; i <= steps; i++) {
    const yc = POST.y0 + ((POST.y1 - POST.y0) * i) / steps;
    const zc = postCentreZ(yc);
    const ring: number[] = [];
    for (let j = 0; j < across; j++) {
      const f = (j / (across - 1)) * 2 - 1;
      const s = f * POST.halfWidth;
      // Across the post in side view: perpendicular (−TY, TZ) scaled by s.
      const z = zc - TY * s;
      const y = yc + TZ * s;
      innerSurface(y, z, SHELL_INSET + 0.002, surf);
      const d = POST.depth * crown(f);
      ring.push(side * (surf.x + surf.nx * d), y + surf.ny * d, z);
    }
    rings.push(ring);
  }
  return faceToward(loftGeometry(rings, { closed: false, orient: 'keep' }), CABIN_CENTRE);
}

/** The windshield header: a moulding across the roof at the windshield's top edge. */
export function headerTrimGeometry(): THREE.BufferGeometry {
  const rings: number[][] = [];
  const across = 9;
  const steps = 36;
  const surf = { x: 0, nx: 0, ny: 0 };
  for (let i = 0; i <= steps; i++) {
    const x = -HEADER.halfSpan + (2 * HEADER.halfSpan * i) / steps;
    const ring: number[] = [];
    for (let j = 0; j < across; j++) {
      const f = (j / (across - 1)) * 2 - 1;
      const z = (HEADER.z0 + HEADER.z1) / 2 + (f * (HEADER.z1 - HEADER.z0)) / 2;
      // Inner roof height over |x| at this station: invert the superellipse for y.
      fuselageSection(z, _s);
      const W = _s.halfWidth - SHELL_INSET - 0.002;
      const H = _s.top - SHELL_INSET - 0.002 - _s.widthY;
      const r = Math.min(0.999, Math.abs(x) / W);
      const y = _s.widthY + H * Math.pow(1 - Math.pow(r, _s.nTop), 1 / _s.nTop);
      innerSurface(y, z, SHELL_INSET + 0.002, surf);
      const d = HEADER.depth * crown(f);
      ring.push(x + Math.sign(x) * surf.nx * d, y + surf.ny * d, z);
    }
    rings.push(ring);
  }
  return faceToward(loftGeometry(rings, { closed: false, orient: 'keep' }), CABIN_CENTRE);
}

/** Every trim moulding, vertex-tinted for the interior parts material. */
export function cabinTrim(): THREE.BufferGeometry[] {
  return [tint(postTrimGeometry(-1), TRIM_COLOR, 0.6, 0), tint(postTrimGeometry(1), TRIM_COLOR, 0.6, 0), tint(headerTrimGeometry(), TRIM_COLOR, 0.6, 0)];
}
