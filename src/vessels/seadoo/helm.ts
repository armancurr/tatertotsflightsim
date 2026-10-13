/**
 * The Sea-Doo's helm: the steering pod (console) between the hood and the seat, with its smoked
 * visor, the dash display facing the rider and the two mirrors; and the handlebars on the tilted
 * steering column (riser, swept bar with its pad, grips, finger throttle and iBR lever).
 *
 * Bar frame: `pivot` sits at SEADOO_SHAPE.barPivot tilted about x by columnTiltDeg (its +Y is the
 * column axis, top leaning toward the rider); its child `steer` turns about that axis
 * (rotation.y = −bars: + bars = turned right, the right grip comes back). `gripPosition()` gives
 * the hand position on each grip in the body frame, for the rider's arms and the tests.
 */
import * as THREE from 'three';
import { tint, merge } from '../../aircraft/materials';
import { V, ellipsoid, tube } from '../../aircraft/f16/geom';
import { railTube, type P3 } from '../geom';
import { SEADOO_COLORS as C } from './materials';
import { POD_BASE_Y, SEADOO_SHAPE as S, podHalf, podTop } from './shape';
import { archLoft, paintSurf, range, steps } from './hull';

const DEG = Math.PI / 180;

/** Body-frame hand position on a grip (side −1 = left / port, +1 = right) with the bars turned `bars` rad (+ = right). */
export function gripPosition(side: number, bars: number, out: THREE.Vector3): THREE.Vector3 {
  const g = S.grip;
  const x0 = side * g.x;
  // Turn about the column (local y) by −bars, then tilt about x by the column tilt, then translate.
  const a = -bars;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const x1 = x0 * ca + g.z * sa;
  const z1 = -x0 * sa + g.z * ca;
  const t = S.columnTiltDeg * DEG;
  const ct = Math.cos(t);
  const st = Math.sin(t);
  const y2 = g.y * ct - z1 * st;
  const z2 = g.y * st + z1 * ct;
  return out.set(S.barPivot.x + x1, S.barPivot.y + y2, S.barPivot.z + z2);
}

/** Where the display sits on the pod (centre, surface frame: across X, down-the-slope T, normal N). */
export function displayFrame() {
  const z = S.zPodFront + 0.49 * (S.zPodRear - S.zPodFront);
  const e = 0.01;
  const T = new THREE.Vector3(0, podTop(z + e) - podTop(z - e), 2 * e).normalize();
  const X = new THREE.Vector3(1, 0, 0);
  const N = new THREE.Vector3().crossVectors(T, X).normalize();
  const c = new THREE.Vector3(0, podTop(z), z).addScaledVector(N, 0.004);
  return { c, X, T, N };
}

/** A flat quad on the display frame: u across (m), v down the slope (m), lifted `h` along the normal. */
function dashQuad(f: ReturnType<typeof displayFrame>, u0: number, u1: number, v0: number, v1: number, h: number, hex: number, rough = 0.3, metal = 0) {
  return paintSurf([v0, v1], [u0, u1], (v, u) => {
    const p = f.c.clone().addScaledVector(f.X, u).addScaledVector(f.T, v).addScaledVector(f.N, h);
    return [p.x, p.y, p.z];
  }, [f.N.x, f.N.y, f.N.z], hex, rough, metal);
}

export interface HelmGeometry {
  /** Pod, visor, mirrors, display bezel (parts material). */
  pod: THREE.BufferGeometry;
  /** The display face (unlit). */
  display: THREE.BufferGeometry;
  /** Bars in the steer frame (parts material). */
  bars: THREE.BufferGeometry;
}

export function buildHelm(): HelmGeometry {
  const geos: THREE.BufferGeometry[] = [];
  const zs = steps(S.zPodFront, S.zPodRear, 0.02);
  geos.push(tint(archLoft(zs, podHalf, podTop, POD_BASE_Y, 3.4, 22), 0x17191c, 0.22, 0.05));
  // Orange accent band along the pod's flanks.
  for (const side of [1, -1]) {
    const e = 2 / 3.4;
    geos.push(
      paintSurf(steps(S.zPodFront + 0.06, S.zPodRear - 0.06, 0.02), [0.3, 0.36], (z, th) => {
        const a = Math.PI * th;
        const w = podHalf(z) + 0.002;
        const x = w * Math.pow(Math.cos(a), e);
        const y = POD_BASE_Y + (podTop(z) - POD_BASE_Y) * Math.pow(Math.sin(a), e);
        return [side * x, y, z];
      }, [side, 0, 0], C.orange, 0.3),
    );
  }
  // Smoked visor over the front of the pod, sweeping up toward the rider.
  const zv0 = S.zPodFront + 0.05;
  const zv1 = S.zPodFront + 0.2;
  geos.push(
    paintSurf(steps(zv0, zv1, 0.015), range(-1, 1, 12), (z, u) => {
      const t = (z - zv0) / (zv1 - zv0);
      const hw = 0.92 * podHalf(z) * (1 - 0.3 * t);
      return [u * hw, podTop(z) + 0.004 + 0.05 * Math.pow(t, 1.6) - 0.03 * u * u * t, z];
    }, [0, 1, 0.3], C.smoke, 0.06, 0.4),
  );
  // Display bezel.
  const f = displayFrame();
  geos.push(dashQuad(f, -0.095, 0.095, -0.045, 0.045, 0.0, 0x0c0d0f, 0.4));
  // Mirrors: stalks from the pod shoulders to the heads (top ≈ 0.71), silvered faces toward the rider.
  const zm = S.zPodFront + 0.24 * (S.zPodRear - S.zPodFront);
  const headY = S.barPivot.y + 0.098;
  for (const side of [1, -1]) {
    const base = V(side * (podHalf(zm) - 0.03), podTop(zm) - 0.02, zm);
    const head = V(side * 0.3, headY, zm - 0.01);
    geos.push(tint(tube(base, head.clone().add(V(-side * 0.03, -0.01, 0)), 0.011, 0.009, 8), 0x17191c, 0.3, 0.1));
    geos.push(tint(ellipsoid(head, 0.07, 0.036, 0.028, 16, 10), 0x17191c, 0.25, 0.05));
    const glass = new THREE.CircleGeometry(1, 20);
    glass.scale(0.06, 0.028, 1);
    glass.translate(head.x, head.y, head.z + 0.029);
    geos.push(tint(glass, 0xc8d0d8, 0.05, 1));
  }
  const pod = merge(geos);

  // Display face: dark screen, an rpm bar of segments (lime → orange), big speed digits, a status strip.
  const d: THREE.BufferGeometry[] = [dashQuad(f, -0.085, 0.085, -0.037, 0.037, 0.002, 0x06121e)];
  for (let k = 0; k < 12; k++) {
    const u0 = -0.078 + k * 0.0132;
    const hex = k < 8 ? 0xb8f000 : k < 10 ? 0xffa000 : 0xff3010;
    d.push(dashQuad(f, u0, u0 + 0.0105, -0.032, -0.022 + 0.0012 * k, 0.003, hex));
  }
  // "Digits": two seven-segment-ish blocks.
  for (const u of [-0.03, 0.002]) {
    d.push(dashQuad(f, u, u + 0.024, -0.012, -0.008, 0.003, 0xe8f4ff));
    d.push(dashQuad(f, u, u + 0.004, -0.012, 0.022, 0.003, 0xe8f4ff));
    d.push(dashQuad(f, u + 0.02, u + 0.024, -0.012, 0.022, 0.003, 0xe8f4ff));
    d.push(dashQuad(f, u, u + 0.024, 0.004, 0.008, 0.003, 0xe8f4ff));
    d.push(dashQuad(f, u, u + 0.024, 0.018, 0.022, 0.003, 0xe8f4ff));
  }
  d.push(dashQuad(f, 0.036, 0.078, 0.012, 0.03, 0.003, 0x1d5f9a));
  d.push(dashQuad(f, -0.078, 0.078, 0.028, 0.033, 0.003, 0x2a3a4a));
  const display = merge(d);

  // ── Bars, in the steer frame (y = the column axis) ──
  const b: THREE.BufferGeometry[] = [];
  const g = S.grip;
  b.push(tint(tube(V(0, -0.14, 0), V(0, 0.03, 0), 0.022, 0.018, 12), 0x2a2d31, 0.4, 0.5));
  b.push(tint(new THREE.BoxGeometry(0.1, 0.035, 0.06).translate(0, 0.035, 0), 0x2a2d31, 0.35, 0.6));
  const barPts = [
    V(-0.38, g.y + 0.004, g.z + 0.006),
    V(-g.x, g.y, g.z),
    V(-0.2, g.y - 0.012, 0.012),
    V(-0.07, 0.048, 0.0),
    V(0.07, 0.048, 0.0),
    V(0.2, g.y - 0.012, 0.012),
    V(g.x, g.y, g.z),
    V(0.38, g.y + 0.004, g.z + 0.006),
  ];
  b.push(tint(railTube(barPts, 0.011, 10, 6), 0x2d3035, 0.3, 0.7));
  // Bar pad.
  b.push(tint(new THREE.CapsuleGeometry(0.024, 0.16, 4, 10).rotateZ(Math.PI / 2).translate(0, 0.065, 0.0), C.black, 0.6));
  for (const side of [1, -1]) {
    // Grip (rubber) with an orange bar end.
    const a = V(side * 0.245, g.y - 0.004, g.z - 0.002);
    const e = V(side * 0.378, g.y + 0.004, g.z + 0.006);
    b.push(tint(tube(a, e, 0.018, 0.018, 12), C.rubber, 0.85));
    b.push(tint(tube(e, e.clone().add(V(side * 0.016, 0.001, 0.001)), 0.021, 0.019, 12), C.orange, 0.35));
    // Finger throttle (right) / iBR lever (left), in front of the grip.
    const lv: P3 = [side * 0.29, g.y - 0.01, g.z - 0.045];
    b.push(tint(new THREE.BoxGeometry(0.075, 0.012, 0.02).rotateY(side * 0.2).translate(lv[0], lv[1], lv[2]), 0x2a2d31, 0.4, 0.4));
    // Switch housing inboard of the grip.
    b.push(tint(new THREE.BoxGeometry(0.035, 0.04, 0.045).translate(side * 0.225, g.y, g.z - 0.004), 0x1b1d20, 0.5));
  }
  const bars = merge(b);
  return { pod, display, bars };
}
