/**
 * The JetRanger's cabin, seen from the pilot's RIGHT seat: floor, the two crew seats and the rear
 * bench, the instrument panel under its glareshield hood (a live canvas texture, panel.ts) on the
 * centre pedestal, and the flight controls — the cyclic between the pilot's knees, the collective
 * on his left, the anti-torque pedals — which move with the rotor controls.
 *
 * Body frame, metres. The eye is B206_AIRCRAFT.geometry.pilotEye (0.33, 0.52, −1.35).
 */
import * as THREE from 'three';
import { merge, tint } from '../materials';
import { box, ellipsoid, tube, V } from '../f16/geom';
import { B206_AIRCRAFT } from '../../config';
import { Z_CABIN_END, DEG } from './shape';
import { liningHalfWidth } from './fuselage';

const EYE = B206_AIRCRAFT.geometry.pilotEye;

export const COCKPIT = {
  floorY: -0.6,
  floorZ0: -2.03,
  /** Crew seats: cushion top, fore/aft extent; the pilot on the right (+x), a passenger on the left. */
  seatX: [EYE.x, -EYE.x] as const,
  cushionTopY: -0.27,
  cushionZ: [-1.6, -1.12] as const,
  /** Instrument panel face: centre, size, tilt (top away from the pilot). */
  panel: { x: 0, y: 0.115, z: -2.1, w: 1.0, h: 0.3, tiltDeg: 12 },
  /** Glareshield hood lip (the edge nearest the pilot). */
  lip: { y: 0.3, z: -2.04, halfW: 0.51 },
  /** Cyclic: floor pivot and the grip. */
  cyclic: { pivot: V(EYE.x, -0.6, -1.56), grip: V(EYE.x, 0.0, -1.47), maxDeg: 11 },
  /** Collective: pivot aft by the seat, lever running forward along the pilot's left. */
  collective: { pivot: V(EYE.x - 0.29, -0.36, -1.02), tip: V(EYE.x - 0.29, -0.31, -1.6), maxDeg: 16 },
  pedals: { z: -2.0, y: -0.5, dx: 0.12, travel: 0.05 },
} as const;

export interface CockpitGeometry {
  /** Static furniture (interior material). */
  furniture: THREE.BufferGeometry;
  /** Panel face (panel material, uv 0..1 over the face). */
  panelFace: THREE.BufferGeometry;
}

function seat(x: number, width: number, z0: number, z1: number, top: number, backTop: number): THREE.BufferGeometry[] {
  const g: THREE.BufferGeometry[] = [];
  const zc = (z0 + z1) / 2;
  // Cushion (sheepskin-grey fabric), the aluminium seat tub below it.
  g.push(tint(box(width, 0.1, z1 - z0, V(x, top - 0.05, zc)), 0x4d4a46, 0.95, 0));
  g.push(tint(box(width + 0.02, top - 0.1 - COCKPIT.floorY, z1 - z0 - 0.04, V(x, (top - 0.1 + COCKPIT.floorY) / 2, zc + 0.02)), 0x3a3b3e, 0.7, 0.2));
  // Back, reclined ~12°, against the bulkhead.
  const h = backTop - top;
  g.push(tint(box(width, h, 0.1, V(x, top + h / 2, z1 + 0.06 + h * 0.1), 0.2, 0, 0), 0x4d4a46, 0.95, 0));
  return g;
}

export function buildCockpit(): CockpitGeometry {
  const g: THREE.BufferGeometry[] = [];
  const C = COCKPIT;
  // Floor: a flat panel between the lining's walls.
  const zs: number[] = [];
  for (let z = C.floorZ0; z <= Z_CABIN_END - 0.01; z += 0.1) zs.push(z);
  zs.push(Z_CABIN_END - 0.01);
  const pos: number[] = [];
  const idx: number[] = [];
  zs.forEach((z, i) => {
    const w = Math.max(0.1, liningHalfWidth(C.floorY, z) - 0.005);
    pos.push(-w, C.floorY, z, w, C.floorY, z);
    if (i > 0) {
      const a = (i - 1) * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  });
  const floor = new THREE.BufferGeometry();
  floor.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  floor.setIndex(idx);
  floor.computeVertexNormals();
  g.push(tint(floor, 0x2e2f32, 0.95, 0));
  // Crew seats (their backs against the cabin partition) and the rear bench.
  for (const x of C.seatX) g.push(...seat(x, 0.46, C.cushionZ[0], C.cushionZ[1], C.cushionTopY, 0.42));
  g.push(...seat(0, 1.08, -0.42, Z_CABIN_END - 0.16, -0.2, 0.5));
  // Partition between the crew and the passengers (lower half; the upper half is open).
  g.push(tint(box(1.1, 0.5, 0.03, V(0, -0.35, -0.95)), 0x3d3e41, 0.8, 0.1));
  // Seat belts / shoulder harness on the crew seats.
  for (const x of C.seatX) {
    g.push(tint(box(0.05, 0.62, 0.006, V(x - 0.1, 0.1, -1.14), -0.2, 0, 0.12), 0x1f2224, 0.8, 0));
    g.push(tint(box(0.05, 0.62, 0.006, V(x + 0.1, 0.1, -1.14), -0.2, 0, -0.12), 0x1f2224, 0.8, 0));
  }
  // Instrument panel: the housing behind the face, the glareshield hood, the pedestal.
  const P = C.panel;
  g.push(tint(box(P.w + 0.04, P.h + 0.04, 0.16, V(0, P.y, P.z - 0.1), -P.tiltDeg * DEG, 0, 0), 0x202124, 0.8, 0.1));
  const L = C.lip;
  g.push(tint(box(2 * L.halfW, 0.03, 0.2, V(0, L.y - 0.015, L.z - 0.1), 0.05, 0, 0), 0x17181a, 0.95, 0));
  g.push(tint(tube(V(-L.halfW, L.y - 0.02, L.z), V(L.halfW, L.y - 0.02, L.z), 0.018, 0.018, 8).rotateX(0), 0x17181a, 0.95, 0));
  // Pedestal (radios console) between the crew's legs, sloping back from the panel to the floor.
  g.push(tint(box(0.26, 0.58, 0.24, V(0, -0.32, -2.02)), 0x232427, 0.8, 0.1));
  g.push(tint(box(0.24, 0.42, 0.14, V(0, -0.42, -1.86), 0.3, 0, 0), 0x232427, 0.8, 0.1));
  g.push(tint(box(0.2, 0.3, 0.01, V(0, -0.38, -1.79), 0.3, 0, 0), 0x121315, 0.6, 0.2));
  // Pedal mounts and the collective's pivot box by the pilot's seat.
  for (const x of C.seatX) g.push(tint(box(0.36, 0.06, 0.12, V(x, C.floorY + 0.03, C.pedals.z - 0.02)), 0x2a2b2e, 0.7, 0.3));
  g.push(tint(box(0.08, 0.1, 0.22, V(C.collective.pivot.x, C.collective.pivot.y - 0.02, C.collective.pivot.z + 0.02)), 0x2a2b2e, 0.7, 0.3));
  // Overhead: a small console (circuit breakers) on the roof between the overhead windows.
  g.push(tint(box(0.13, 0.03, 0.4, V(0, 0.9, -1.27)), 0x1e1f22, 0.8, 0.1));
  // Door frames / pillar trim: the B-pillar between the doors.
  for (const s of [-1, 1]) {
    for (let y = -0.5; y <= 0.45; y += 0.3) {
      const x = liningHalfWidth(y + 0.15, -0.88) - 0.02;
      g.push(tint(box(0.03, 0.31, 0.06, V(s * x, y + 0.15, -0.88)), 0x2d2e31, 0.8, 0.1));
    }
  }
  // Fire extinguisher by the passenger seat and the first-aid kit, for a lived-in cabin.
  g.push(tint(tube(V(-0.52, -0.58, -1.55), V(-0.52, -0.3, -1.55), 0.045, 0.045, 12), 0xb3261e, 0.45, 0.1));
  g.push(tint(ellipsoid(V(-0.52, -0.29, -1.55), 0.03, 0.02, 0.03, 8, 5), 0x1c1d1f, 0.5, 0.4));

  const face = new THREE.PlaneGeometry(P.w, P.h);
  face.rotateX(-P.tiltDeg * DEG);
  face.translate(P.x, P.y, P.z);
  return { furniture: merge(g), panelFace: face };
}

/** Moving controls, each a pivot group with its mesh (interior material). */
export interface ControlsRig {
  cyclic: THREE.Group;
  collective: THREE.Group;
  pedalLeft: THREE.Group;
  pedalRight: THREE.Group;
  meshes: THREE.Mesh[];
  /** Apply the control positions: cyclic (+aft, +right), collective 0..1, pedal (+right). */
  update(stickLong: number, stickLat: number, lever: number, pedal: number): void;
}

export function buildControls(material: THREE.Material): ControlsRig {
  const C = COCKPIT;
  const meshes: THREE.Mesh[] = [];
  const pivotGroup = (name: string, at: THREE.Vector3, geo: THREE.BufferGeometry) => {
    const grp = new THREE.Group();
    grp.name = name;
    grp.position.copy(at);
    geo.translate(-at.x, -at.y, -at.z);
    const m = new THREE.Mesh(geo, material);
    m.name = `${name}.mesh`;
    grp.add(m);
    meshes.push(m);
    return grp;
  };
  // Cyclic: a bent stick with a boot at the floor and the black grip with its switches.
  const cp = C.cyclic.pivot;
  const cg = C.cyclic.grip;
  const bend = V(cp.x, cp.y + 0.35, cp.z - 0.04);
  const cyclicGeo = merge([
    tint(tube(cp.clone().add(V(0, -0.02, 0)), cp.clone().add(V(0, 0.08, 0)), 0.06, 0.03, 12), 0x141516, 0.9, 0),
    tint(tube(cp, bend, 0.014, 0.014, 10), 0x2a2b2d, 0.5, 0.5),
    tint(tube(bend, cg, 0.014, 0.014, 10), 0x2a2b2d, 0.5, 0.5),
    tint(tube(cg.clone().add(V(0, -0.02, 0.005)), cg.clone().add(V(0, 0.11, 0.025)), 0.02, 0.018, 12), 0x121212, 0.7, 0),
    tint(box(0.03, 0.02, 0.02, cg.clone().add(V(0, 0.105, 0.005))), 0x3a3a3a, 0.5, 0.2),
    tint(box(0.012, 0.012, 0.012, cg.clone().add(V(0.012, 0.09, -0.012))), 0xa01010, 0.5, 0.1),
  ]);
  const cyclic = pivotGroup('b206.cyclic', cp, cyclicGeo);
  // Collective: lever from the pivot box forward, the throttle twist grip and switch box at its end.
  const kp = C.collective.pivot;
  const kt = C.collective.tip;
  const dir = kt.clone().sub(kp).normalize();
  const collectiveGeo = merge([
    tint(tube(kp, kt, 0.016, 0.016, 10), 0x2a2b2d, 0.5, 0.5),
    tint(tube(kt.clone().sub(dir.clone().multiplyScalar(0.02)), kt.clone().add(dir.clone().multiplyScalar(0.12)), 0.022, 0.022, 12), 0x121212, 0.8, 0),
    tint(box(0.05, 0.05, 0.07, kt.clone().add(V(0, 0.02, 0.1))), 0x1b1c1e, 0.6, 0.3),
  ]);
  const collective = pivotGroup('b206.collective', kp, collectiveGeo);
  // Pedals: two per side (both crew stations), each on a short arm from the floor.
  const pedalGeo = (x: number) =>
    merge([
      tint(box(0.08, 0.13, 0.02, V(x, C.pedals.y + 0.03, C.pedals.z), -0.4, 0, 0), 0x2a2b2d, 0.6, 0.4),
      tint(tube(V(x, C.floorY + 0.02, C.pedals.z + 0.04), V(x, C.pedals.y - 0.02, C.pedals.z + 0.01), 0.01, 0.01, 6), 0x6b6f73, 0.4, 0.7),
    ]);
  const pedalRight = pivotGroup('b206.pedal.right', V(0, 0, 0), merge([pedalGeo(EYE.x + C.pedals.dx), pedalGeo(-EYE.x + C.pedals.dx)]));
  const pedalLeft = pivotGroup('b206.pedal.left', V(0, 0, 0), merge([pedalGeo(EYE.x - C.pedals.dx), pedalGeo(-EYE.x - C.pedals.dx)]));
  const max = C.cyclic.maxDeg * DEG;
  const lmax = C.collective.maxDeg * DEG;
  return {
    cyclic,
    collective,
    pedalLeft,
    pedalRight,
    meshes,
    update(stickLong, stickLat, lever, pedal) {
      // +aft: the grip comes back toward the pilot (+z); +right: the grip goes right (+x).
      cyclic.rotation.set(stickLong * max, 0, -stickLat * max * 0.8, 'XZY');
      collective.rotation.x = lever * lmax;
      pedalRight.position.z = -pedal * C.pedals.travel;
      pedalLeft.position.z = pedal * C.pedals.travel;
    },
  };
}
