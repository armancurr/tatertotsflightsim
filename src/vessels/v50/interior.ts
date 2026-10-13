/**
 * Princess V50 saloon and cockpit furniture: the dash under the windscreen (anti-glare top), the
 * starboard helm binnacle with its two glass displays, the wheel on its tilted column, the IPS
 * joystick and throttle console, the double helm seat and the port companion seat, the port
 * settee and table, the starboard galley, and the cockpit's aft bench, table and wet bar.
 * The helm is laid out around geometry.pilotEye: a seated eye above the helm seat with a clear
 * view forward over the dash through the windscreen.
 */
import * as THREE from 'three';
import { tint, merge } from '../../aircraft/materials';
import { V, box, tube } from '../../aircraft/f16/geom';
import { boxMinMax, gridGeometry, type P3 } from '../geom';
import { HELM, V50_SHAPE as S, cockpitHalf, coachTopY, dashAftZ, houseHalf, wsBaseZ } from './shape';

const range = (a: number, b: number, n: number) => Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);

const C = {
  leather: 0xe9e1d2,
  leatherDark: 0xcfc4b0,
  dashTop: 0x2e2a27,
  moulding: 0xe6e2da,
  walnut: 0x4a3526,
  worktop: 0x2a2b2d,
  rim: 0x141414,
  steel: 0xcfd4d9,
  black: 0x121314,
} as const;

/** The binnacle's sloped instrument face: top edge (y, z), bottom edge (y, z), across x0..x1. */
export const BINNACLE = {
  x0: HELM.wheel.x - 0.45,
  x1: HELM.wheel.x + 0.45,
  top: { y: S.dashY, z: dashAftZ(HELM.wheel.x) },
  bottom: { y: 0.98, z: dashAftZ(HELM.wheel.x) + 0.3 },
} as const;

export interface InteriorGeometry {
  furniture: THREE.BufferGeometry;
  /** The two helm displays: a quad pair with UVs across the shared screen texture (left half, right half). */
  screens: THREE.BufferGeometry;
}

export function buildInterior(): InteriorGeometry {
  const f: THREE.BufferGeometry[] = [];

  // ── Dash: anti-glare top from the windscreen base aft, then the vertical face to the sole ──
  {
    const nu = 20;
    const top: P3[][] = range(0, 1, 4).map((t) =>
      range(-1, 1, nu).map((u) => {
        const zb = wsBaseZ(u);
        const x = u * houseHalf(zb) * 0.995;
        const z = zb + S.dashDepth * t;
        const y = coachTopY(x, zb) - 0.012 + (S.dashY - (coachTopY(x, zb) - 0.012)) * t;
        return [x, y, z] as P3;
      }),
    );
    f.push(tint(gridGeometry(top, [0, 1, 0.2]), C.dashTop, 0.85));
    const face: P3[][] = range(-1, 1, nu).map((u) => {
      const zb = wsBaseZ(u);
      const x = u * houseHalf(zb) * 0.995;
      const z = zb + S.dashDepth;
      return [[x, S.floorY, z], [x, S.dashY, z]] as P3[];
    });
    f.push(tint(gridGeometry(face, [0, 0, 1]), C.moulding, 0.5));
  }

  // ── Helm binnacle (a wedge with the sloped display face) ──
  {
    const B = BINNACLE;
    const sh = new THREE.Shape();
    sh.moveTo(B.top.z - 0.02, B.top.y);
    sh.lineTo(B.bottom.z, B.bottom.y);
    sh.lineTo(B.bottom.z, S.floorY);
    sh.lineTo(B.top.z - 0.02, S.floorY);
    sh.closePath();
    const g = new THREE.ExtrudeGeometry(sh, { depth: B.x1 - B.x0, bevelEnabled: false });
    // Shape (z, y), depth along +z → rotateY(−90°): depth runs along −x.
    g.rotateY(-Math.PI / 2);
    g.translate(B.x1, 0, 0);
    f.push(tint(g, C.black, 0.6));
  }

  // ── Wheel, column, joystick and throttles ──
  {
    const w = HELM.wheel;
    const tilt = (w.tiltDeg * Math.PI) / 180;
    const rim = new THREE.TorusGeometry(w.radius, 0.017, 8, 40);
    const hub = new THREE.CylinderGeometry(0.045, 0.05, 0.05, 16).rotateX(Math.PI / 2);
    const spokes = [0, 1, 2].map((k) => {
      const a = Math.PI / 2 + (k * 2 * Math.PI) / 3;
      return tube(V(0, 0, 0), V(Math.cos(a) * w.radius, Math.sin(a) * w.radius, 0), 0.011, 0.009, 6);
    });
    const wheel = merge([tint(rim, C.rim, 0.55), tint(hub, C.steel, 0.25, 0.9), ...spokes.map((s) => tint(s, C.steel, 0.25, 0.9))]);
    // Face up and aft toward the helmsman.
    wheel.rotateX(-tilt);
    wheel.translate(w.x, w.y, w.z);
    f.push(wheel);
    // Column from the binnacle face to the hub, along the wheel's axis.
    const axis = new THREE.Vector3(0, Math.sin(tilt), Math.cos(tilt));
    f.push(tint(tube(V(w.x, w.y, w.z).addScaledVector(axis, -0.3), V(w.x, w.y, w.z).addScaledVector(axis, -0.02), 0.03, 0.03, 10), C.black, 0.5));
    // Side console with the throttles and the IPS joystick (outboard of the wheel).
    const cx = w.x + 0.62;
    const cz = w.z + 0.1;
    f.push(tint(boxMinMax(cx - 0.14, S.floorY, cz - 0.3, cx + 0.14, 1.02, cz + 0.2), C.black, 0.6));
    for (const dx of [-0.05, 0.05]) {
      f.push(tint(tube(V(cx + dx, 1.02, cz - 0.02), V(cx + dx, 1.17, cz - 0.08), 0.009, 0.009, 6), C.steel, 0.25, 0.9));
      f.push(tint(box(0.04, 0.03, 0.06, V(cx + dx, 1.18, cz - 0.085)), C.black, 0.5));
    }
    f.push(tint(tube(V(cx, 1.02, cz + 0.12), V(cx, 1.1, cz + 0.12), 0.012, 0.009, 8), C.black, 0.5));
  }

  // ── Seats: double helm seat (starboard), companion seat (port) ──
  const seat = (xc: number) => {
    const s = HELM.seat;
    const x0 = xc - s.width / 2;
    const x1 = xc + s.width / 2;
    const z0 = s.z - s.depth / 2 - 0.05;
    const z1 = s.z + s.depth / 2 - 0.05;
    f.push(tint(boxMinMax(x0 + 0.08, S.floorY, z0 + 0.1, x1 - 0.08, s.cushionY - 0.12, z1 - 0.05), C.moulding, 0.5));
    f.push(tint(boxMinMax(x0, s.cushionY - 0.12, z0, x1, s.cushionY, z1), C.leather, 0.6));
    // Backrest, raked back.
    const back = boxMinMax(x0, 0, -0.06, x1, 0.62, 0.06);
    back.rotateX(-0.2);
    back.translate(0, s.cushionY - 0.04, z1 + 0.02);
    f.push(tint(back, C.leather, 0.6));
    // Arm rests.
    for (const x of [x0 - 0.02, x1 + 0.02]) f.push(tint(boxMinMax(x - 0.05, s.cushionY, z0 + 0.05, x + 0.05, s.cushionY + 0.2, z1), C.leatherDark, 0.6));
  };
  seat(HELM.seat.x);
  seat(-HELM.seat.x);

  // ── Saloon: port settee and table, starboard galley ──
  {
    const zs0 = -0.75;
    const zs1 = 1.0;
    const xw = -houseHalf(0.2) + 0.04;
    f.push(tint(boxMinMax(xw, S.floorY, zs0, xw + 0.58, S.floorY + 0.44, zs1), C.leather, 0.6));
    f.push(tint(boxMinMax(xw, S.floorY + 0.44, zs0, xw + 0.14, S.floorY + 0.92, zs1), C.leatherDark, 0.6));
    f.push(tint(boxMinMax(xw, S.floorY, zs1 - 0.55, xw + 1.4, S.floorY + 0.44, zs1), C.leather, 0.6));
    f.push(tint(boxMinMax(xw + 0.75, S.floorY + 0.68, -0.5, xw + 1.45, S.floorY + 0.72, 0.3), C.walnut, 0.4));
    f.push(tint(tube(V(xw + 1.1, S.floorY, -0.1), V(xw + 1.1, S.floorY + 0.68, -0.1), 0.04, 0.04, 10), C.steel, 0.3, 0.9));
    const xg = houseHalf(0.2) - 0.04;
    f.push(tint(boxMinMax(xg - 0.62, S.floorY, -0.5, xg, S.floorY + 0.88, 1.12), C.walnut, 0.5));
    f.push(tint(boxMinMax(xg - 0.64, S.floorY + 0.88, -0.52, xg, S.floorY + 0.92, 1.12), C.worktop, 0.25));
  }

  // ── Cockpit: aft bench against the transom, table, wet bar (port) ──
  {
    const zb0 = S.zTransomInner - 0.6;
    const zb1 = S.zTransomInner - 0.01;
    const h = cockpitHalf(S.zTransomInner) - 0.02;
    f.push(tint(boxMinMax(-h, S.floorY, zb0, h, S.floorY + 0.3, zb1), C.moulding, 0.5));
    f.push(tint(boxMinMax(-h, S.floorY + 0.3, zb0, h, S.floorY + 0.45, zb1), C.leather, 0.6));
    const back = boxMinMax(-h, 0, -0.07, h, 0.34, 0.07);
    back.rotateX(-0.22);
    back.translate(0, S.floorY + 0.43, zb1 - 0.12);
    f.push(tint(back, C.leather, 0.6));
    f.push(tint(boxMinMax(-0.55, S.floorY + 0.66, 3.55, 0.55, S.floorY + 0.7, 4.5), C.walnut, 0.35));
    f.push(tint(tube(V(0, S.floorY, 4.0), V(0, S.floorY + 0.66, 4.0), 0.05, 0.05, 10), C.steel, 0.3, 0.9));
    const xp = -cockpitHalf(1.8) + 0.02;
    f.push(tint(boxMinMax(xp, S.floorY, S.zAftBulkhead + 0.05, xp + 0.6, S.floorY + 0.9, S.zAftBulkhead + 1.25), C.moulding, 0.45));
    f.push(tint(boxMinMax(xp, S.floorY + 0.9, S.zAftBulkhead + 0.04, xp + 0.62, S.floorY + 0.93, S.zAftBulkhead + 1.26), C.worktop, 0.25));
  }

  // ── Displays on the binnacle face (5 mm proud of it) ──
  const B = BINNACLE;
  const dir = new THREE.Vector3(0, B.bottom.y - B.top.y, B.bottom.z - B.top.z);
  const slope = dir.length();
  dir.normalize();
  const nrm = new THREE.Vector3(0, -dir.z, dir.y);
  if (nrm.y < 0) nrm.negate();
  const quad = (xc: number, u0: number, u1: number) => {
    const w = 0.4;
    const hgt = Math.min(0.3, slope - 0.06);
    const c0 = new THREE.Vector3(xc, B.top.y, B.top.z).addScaledVector(dir, slope / 2).addScaledVector(nrm, 0.005);
    const up = dir.clone().negate();
    const p = [
      c0.clone().add(new THREE.Vector3(-w / 2, 0, 0)).addScaledVector(up, -hgt / 2),
      c0.clone().add(new THREE.Vector3(w / 2, 0, 0)).addScaledVector(up, -hgt / 2),
      c0.clone().add(new THREE.Vector3(w / 2, 0, 0)).addScaledVector(up, hgt / 2),
      c0.clone().add(new THREE.Vector3(-w / 2, 0, 0)).addScaledVector(up, hgt / 2),
    ];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p.flatMap((v) => v.toArray()), 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute([...nrm.toArray(), ...nrm.toArray(), ...nrm.toArray(), ...nrm.toArray()], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([u0, 0, u1, 0, u1, 1, u0, 1], 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    return g;
  };
  const screens = merge([tint(quad(B.x0 + 0.22, 0, 0.5), 0xffffff, 0.25), tint(quad(B.x1 - 0.22, 0.5, 1), 0xffffff, 0.25)]);

  return { furniture: merge(f), screens };
}
