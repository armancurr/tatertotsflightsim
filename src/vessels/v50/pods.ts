/**
 * Volvo Penta IPS 600 drives and trim tabs for the Princess V50. Each drive: a streamlined leg
 * hanging from the hull, the gear-housing torpedo, a skeg under it, and two counter-rotating
 * propellers at its FRONT (IPS pulls) whose midpoint is PropulsorConfig.position and whose
 * diameter is PropulsorConfig.diameter (the forward prop; the aft one is a little smaller, as on
 * the real drive). The drive turns about the vertical axis through `position` (see animate.ts for
 * the sign). Trim tabs: plates hinged on the hull bottom at the transom, following the deadrise.
 *
 * Local frames: a pod's `pivot` sits at `position` (axes = body axes when straight), the props
 * spin about local z. A tab's `hinge` sits on the hull bottom at the transom, rotated by the
 * deadrise about z; its `flap` child rotates about x (+ = trailing edge down).
 */
import * as THREE from 'three';
import { tint, merge } from '../../aircraft/materials';
import { V, ellipsoid, tube } from '../../aircraft/f16/geom';
import type { PropulsorConfig } from '../../config';
import { sectionBottomY } from '../hullSection';
import { gridGeometry, boxMinMax, type P3 } from '../geom';
import { V50_SHAPE as S, sec } from './shape';

/** Spacing of the two propellers along the drive (each sits half of it from `position`). */
export const PROP_SPACING = 0.24;
/** Aft propeller diameter relative to the forward one. */
export const AFT_PROP_SCALE = 0.92;

const DRIVE = 0x3b4046;
const PROP = 0xb8ab8a;

export interface PodRig {
  /** Break-up container (identity) → pivot (steers) → leg + prop spinners. */
  container: THREE.Group;
  pivot: THREE.Group;
  leg: THREE.Mesh;
  /** Forward (index 0) and aft (index 1) propeller spinners (rotation.z) and their blade meshes. */
  spinners: [THREE.Group, THREE.Group];
  blades: [THREE.Mesh, THREE.Mesh];
  disc: THREE.Mesh;
}

/** One propeller's blades (N blades, radius r), disc in the local xy plane, hub on the axis. */
export function propellerGeometry(n: number, r: number, hand: 1 | -1): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const hubR = 0.065;
  const pitch = 0.62;
  for (let b = 0; b < n; b++) {
    const a0 = (b * 2 * Math.PI) / n;
    const nr = 8;
    const nc = 6;
    const grid: P3[][] = [];
    for (let i = 0; i <= nr; i++) {
      const rr = hubR * 0.9 + (r - hubR * 0.9) * (i / nr);
      const f = i / nr;
      // Wide, skewed blade outline (chord in radians of the circle at rr), rounded tip.
      const chord = (0.36 + 0.5 * Math.sin(Math.PI * Math.min(1, f * 0.85 + 0.1))) * r * (1 - 0.7 * f ** 6);
      const skew = 0.35 * f * f;
      const beta = Math.atan2(pitch, 2 * Math.PI * rr);
      const row: P3[] = [];
      for (let j = 0; j <= nc; j++) {
        const c = (j / nc - 0.5) * chord;
        const th = a0 + hand * (skew + (c * Math.cos(beta)) / rr);
        const zc = c * Math.sin(beta);
        row.push([rr * Math.cos(th), rr * Math.sin(th), zc]);
      }
      grid.push(row);
    }
    parts.push(gridGeometry(grid, [0, 0, -1]));
  }
  const hub = new THREE.CylinderGeometry(hubR, hubR, 0.12, 16).rotateX(Math.PI / 2);
  return merge([...parts.map((p) => tint(p, PROP, 0.28, 0.85)), tint(hub, PROP, 0.3, 0.85)]);
}

/** A symmetric foil section (NACA-ish), chord along z from zLe to zLe + chord, thickness t. */
function foilRing(chord: number, t: number, zLe: number, y: number, n = 14): P3[] {
  const pts: P3[] = [];
  for (let k = 0; k <= 2 * n; k++) {
    const s = k <= n ? k / n : (2 * n - k) / n;
    const x = 0.5 - 0.5 * Math.cos(Math.PI * s);
    const half = 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
    const side = k <= n ? 1 : -1;
    pts.push([side * half * chord, y, zLe + x * chord]);
  }
  return pts;
}

export function buildPod(p: PropulsorConfig, name: string, mats: { parts: THREE.Material; props: THREE.Material; disc: THREE.Material }): PodRig {
  const container = new THREE.Group();
  container.name = name;
  const pivot = new THREE.Group();
  pivot.name = `${name}.pivot`;
  pivot.position.set(p.position.x, p.position.y, p.position.z);
  container.add(pivot);

  const R = p.diameter / 2;
  const geos: THREE.BufferGeometry[] = [];
  // Hull bottom above the drive (the leg reaches well into the hull so it never shows a gap when steered).
  const bottom = sectionBottomY(sec(p.position.z + 0.3), p.position.x) - p.position.y;
  const legTop = bottom + 0.35;
  // Leg: a foil strut above the torpedo, a little aft of the props.
  const legRings = [0, 1, 2, 3].map((k) => {
    const y = 0.02 + (legTop - 0.02) * (k / 3);
    return foilRing(0.62 - 0.08 * (k / 3), 0.16, PROP_SPACING / 2 + 0.12, y);
  });
  geos.push(tint(gridGeometry(legRings, (x, _y, z) => [x, 0, z - (PROP_SPACING / 2 + 0.4)]), DRIVE, 0.55, 0.3));
  // Torpedo (gear housing): nose cone ahead of the forward prop's hub to a tail cone with the exhaust.
  const prof: [number, number][] = [
    [0, -PROP_SPACING / 2 - 0.2],
    [0.05, -PROP_SPACING / 2 - 0.12],
    [0.066, -PROP_SPACING / 2 - 0.06],
    [0.068, PROP_SPACING / 2 + 0.06],
    [0.1, PROP_SPACING / 2 + 0.16],
    [0.105, PROP_SPACING / 2 + 0.5],
    [0.08, PROP_SPACING / 2 + 0.72],
    [0.05, PROP_SPACING / 2 + 0.8],
  ];
  const lathe = new THREE.LatheGeometry(prof.map(([r, z]) => new THREE.Vector2(r, z)), 20);
  // Lathe axis is +y: lay it along +z.
  lathe.rotateX(Math.PI / 2);
  geos.push(tint(lathe, DRIVE, 0.5, 0.35));
  // Skeg under the torpedo's aft end.
  const skeg = [0, 1].map((k) => foilRing(0.34 - 0.12 * k, 0.12, PROP_SPACING / 2 + 0.36 + 0.1 * k, -0.06 - 0.22 * k, 10));
  geos.push(tint(gridGeometry(skeg, (x) => [x, 0, 0]), DRIVE, 0.55, 0.3));
  // Exhaust ring at the tail.
  geos.push(tint(tube(V(0, 0, PROP_SPACING / 2 + 0.78), V(0, 0, PROP_SPACING / 2 + 0.82), 0.05, 0.05, 16, true), 0x1a1c1e, 0.7));

  const leg = new THREE.Mesh(merge(geos), mats.parts);
  leg.name = `${name}.leg`;
  leg.castShadow = true;
  pivot.add(leg);

  const spinners: THREE.Group[] = [];
  const blades: THREE.Mesh[] = [];
  const specs: [number, number, 1 | -1, number][] = [
    [-PROP_SPACING / 2, 3, 1, R],
    [PROP_SPACING / 2, 4, -1, R * AFT_PROP_SCALE],
  ];
  specs.forEach(([z, nb, hand, r], k) => {
    const spin = new THREE.Group();
    spin.name = `${name}.prop${k === 0 ? 'Fwd' : 'Aft'}`;
    spin.position.set(0, 0, z);
    const m = new THREE.Mesh(propellerGeometry(nb, r, hand), mats.props);
    m.name = `${spin.name}.blades`;
    m.castShadow = true;
    spin.add(m);
    pivot.add(spin);
    spinners.push(spin);
    blades.push(m);
  });

  // Blur disc: two thin annuli at the props (one mesh).
  const discGeo = merge(
    specs.map(([z, , , r]) => {
      const g = new THREE.RingGeometry(0.066, r, 40, 1);
      g.translate(0, 0, z);
      return tint(g, 0xffffff, 0.4);
    }),
  );
  const disc = new THREE.Mesh(discGeo, mats.disc);
  disc.name = `${name}.disc`;
  disc.visible = false;
  disc.renderOrder = 2;
  pivot.add(disc);

  return { container, pivot, leg, spinners: spinners as [THREE.Group, THREE.Group], blades: blades as [THREE.Mesh, THREE.Mesh], disc };
}

export interface TabRig {
  hinge: THREE.Group;
  flap: THREE.Group;
  mesh: THREE.Mesh;
}

/** Tab plate: span along the hinge, chord aft. */
export const TAB = { span: 0.62, chord: 0.3, thickness: 0.018 } as const;

export function buildTab(pos: { x: number; y: number; z: number }, name: string, mat: THREE.Material): TabRig {
  const s = sec(S.zTransom);
  const side = Math.sign(pos.x) || 1;
  const hinge = new THREE.Group();
  hinge.name = `${name}.hinge`;
  // On the bottom at the transom (the V bottom's height at this x), tilted with the deadrise.
  hinge.position.set(pos.x, sectionBottomY(s, pos.x), S.zTransom);
  hinge.rotation.z = side * Math.atan2(s.chineY - s.keelY, s.chineHalf);
  const flap = new THREE.Group();
  flap.name = name;
  hinge.add(flap);
  const plate = tint(boxMinMax(-TAB.span / 2, -TAB.thickness, 0, TAB.span / 2, 0, TAB.chord), 0x9aa0a6, 0.4, 0.8);
  // Actuator: from the transom above to the plate's middle.
  const act = tint(tube(V(0, 0.2, 0.02), V(0, 0, TAB.chord * 0.55), 0.022, 0.018, 8), 0x3b4046, 0.5, 0.4);
  const mesh = new THREE.Mesh(merge([plate, act, tint(ellipsoid(V(0, 0.2, 0.03), 0.04, 0.04, 0.04, 8, 6), 0x3b4046, 0.5)]), mat);
  mesh.name = `${name}.plate`;
  mesh.castShadow = true;
  flap.add(mesh);
  return { hinge, flap, mesh };
}
