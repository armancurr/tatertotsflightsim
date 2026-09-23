/**
 * A-10 armament, visual: the GAU-8/A Avenger's seven-barrel cluster under the nose (built about its
 * own axis so the model can spin it) and the Desert-Storm-style tank-busting load:
 *   stations 3 / 9   LAU-88 triple launchers, 2 × AGM-65D Maverick each (outer + inner rails)
 *   station 11       LAU-105 dual rail, 2 × AIM-9M Sidewinder
 *   station 1        AN/ALQ-184 ECM pod
 *   station 2        AN/AAQ-33 Sniper targeting pod
 *   stations 4 / 8   GBU-12 Paveway II
 * Everything but the Mavericks is merged into static meshes (vertex colours, `parts` material).
 */
import * as THREE from 'three';
import { tint, merge } from '../materials';
import { box, ellipsoid, tube, V } from '../f16/geom';
import { GUN, LAU88, MAVERICK, STATION_X, lerp, wingLowerAt } from './shape';

const OLIVE = 0x4f5236;
const GREY = 0x8a8e8e;
const DARK = 0x2a2c2d;
const YELLOW = 0xd7a91c;
const BROWN = 0x6b4a2a;
const PYLON = 0x6d7275;

// ─── GAU-8/A ─────────────────────────────────────────────────────────────────

export interface GunBuild {
  /** Barrels + clamps, about the gun axis (local origin on the axis; +z aft). */
  cluster: THREE.BufferGeometry;
  /** Blurred shell shown while the cluster spins fast (same frame). */
  blur: THREE.BufferGeometry;
  /** Gun-port fairing in the nose (body coordinates). */
  port: THREE.BufferGeometry;
  /** Axis position (body). */
  axis: THREE.Vector3;
}

export function buildGun(): GunBuild {
  const g: THREE.BufferGeometry[] = [];
  const R = GUN.circleR;
  const z0 = GUN.portZ + 0.45; // barrels start inside the fuselage
  const zm = GUN.muzzleZ;
  for (let k = 0; k < GUN.barrels; k++) {
    // Barrel 0 at +x (the 9 o'clock position seen from the front) is the firing barrel.
    const a = (k / GUN.barrels) * Math.PI * 2;
    const x = Math.cos(a) * R;
    const y = Math.sin(a) * R;
    g.push(tint(tube(V(x, y, z0), V(x, y, zm + 0.005), GUN.barrelR * 1.08, GUN.barrelR, 12), 0x3b3d3f, 0.38, 0.85));
    // Bore (dark) at the muzzle.
    const bore = new THREE.CircleGeometry(GUN.barrelR * 0.5, 10);
    bore.rotateY(Math.PI);
    bore.translate(x, y, zm - 0.001);
    g.push(tint(bore, 0x050505, 0.9, 0));
    // Muzzle crown ring.
    g.push(tint(tube(V(x, y, zm + 0.03), V(x, y, zm), GUN.barrelR * 1.15, GUN.barrelR * 1.1, 12, true), 0x2c2e30, 0.4, 0.8));
  }
  // Muzzle clamp and mid-barrel support (rings binding the cluster), central rotor tube.
  const ringOuter = R + GUN.barrelR + 0.02;
  for (const [zc, w] of [[GUN.clampZ, 0.06], [GUN.midClampZ, 0.05]] as const) {
    g.push(tint(tube(V(0, 0, zc + w / 2), V(0, 0, zc - w / 2), ringOuter, ringOuter, 28), 0x2e3032, 0.45, 0.8));
    for (const zz of [zc - w / 2, zc + w / 2]) {
      const face = new THREE.RingGeometry(R * 0.45, ringOuter, 28, 1);
      if (zz < zc) face.rotateY(Math.PI);
      face.translate(0, 0, zz);
      g.push(tint(face, 0x2e3032, 0.45, 0.8));
    }
  }
  g.push(tint(tube(V(0, 0, z0), V(0, 0, GUN.clampZ), R * 0.45, R * 0.45, 14), 0x242628, 0.5, 0.7));
  const cluster = merge(g);

  const blurLen = z0 - zm;
  const shell = new THREE.CylinderGeometry(R + GUN.barrelR, R + GUN.barrelR, blurLen, 32, 1, true);
  shell.rotateX(Math.PI / 2);
  shell.translate(0, 0, (z0 + zm) / 2);
  // The muzzle end smears into a dark disc at speed (like a propeller disc).
  const disc = new THREE.RingGeometry(R * 0.35, R + GUN.barrelR, 32, 1);
  disc.rotateY(Math.PI);
  disc.translate(0, 0, zm - 0.004);
  const blur = merge([tint(shell, 0xffffff, 0.5, 0), tint(disc, 0xffffff, 0.5, 0)]);

  // Gun port: a dark shroud where the barrels leave the nose.
  const ax = GUN.axisX;
  const ay = GUN.axisY;
  const port = merge([
    tint(tube(V(ax, ay, GUN.portZ + 0.25), V(ax, ay, GUN.portZ - 0.02), ringOuter + 0.05, ringOuter + 0.035, 28, true), 0x1c1d1e, 0.6, 0.4),
    tint(new THREE.RingGeometry(ringOuter - 0.005, ringOuter + 0.035, 28, 1).rotateY(Math.PI).translate(ax, ay, GUN.portZ - 0.02), 0x161718, 0.6, 0.4),
  ]);
  return { cluster, blur, port, axis: V(ax, ay, 0) };
}

// ─── Missiles and bombs ──────────────────────────────────────────────────────

/** A set of four fins/wings (X configuration) about the z axis. */
function finSet(r: number, zRoot0: number, zRoot1: number, span: number, tipChord: number, sweepBack: number, thick: number, hex: number, xConfig = true): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const h = span / 2 - r;
  for (let k = 0; k < 4; k++) {
    const ang = (xConfig ? Math.PI / 4 : 0) + (k * Math.PI) / 2;
    const s = new THREE.Shape();
    s.moveTo(0, 0);
    s.lineTo(zRoot1 - zRoot0, 0);
    s.lineTo(Math.min(zRoot1 - zRoot0, sweepBack + tipChord), h);
    s.lineTo(sweepBack, h);
    s.lineTo(0, 0);
    const g = new THREE.ExtrudeGeometry(s, { depth: thick, bevelEnabled: false });
    g.translate(0, r - 0.004, -thick / 2);
    // Shape x → +z (aft), shape y → radial; then rotate about the body axis.
    g.applyMatrix4(new THREE.Matrix4().makeBasis(V(0, 0, 1), V(1, 0, 0), V(0, 1, 0)).premultiply(new THREE.Matrix4().makeRotationZ(ang)));
    g.translate(0, 0, zRoot0);
    out.push(tint(g, hex, 0.55, 0.1));
  }
  return out;
}

/** AGM-65D Maverick about its own centre (axis z, nose −z): IIR glass dome, long-chord wings, tail fins, bands. */
export function buildMaverick(): THREE.BufferGeometry {
  const L = MAVERICK.length;
  const R = MAVERICK.radius;
  const zn = -L / 2;
  const zt = L / 2;
  const g: THREE.BufferGeometry[] = [];
  g.push(tint(tube(V(0, 0, zn + 0.16), V(0, 0, zt - 0.03), R, R, 20), OLIVE, 0.62, 0.05));
  // Seeker section: a slightly slimmer ring and the glass dome.
  g.push(tint(tube(V(0, 0, zn + 0.1), V(0, 0, zn + 0.17), R * 0.93, R, 20), 0x3a3c2a, 0.5, 0.1));
  const dome = new THREE.SphereGeometry(R * 0.93, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2);
  dome.rotateX(-Math.PI / 2);
  dome.scale(1, 1, 0.95);
  dome.translate(0, 0, zn + 0.1);
  g.push(tint(dome, 0x1d2426, 0.05, 0.6));
  // Bands: yellow (live warhead) and brown (live rocket motor).
  g.push(tint(tube(V(0, 0, zn + 0.72), V(0, 0, zn + 0.78), R + 0.0015, R + 0.0015, 20, true), YELLOW, 0.55, 0));
  g.push(tint(tube(V(0, 0, zn + 1.3), V(0, 0, zn + 1.36), R + 0.0015, R + 0.0015, 20, true), BROWN, 0.55, 0));
  // Long-chord wings (delta-ish) over the rear half, control fins right aft.
  g.push(...finSet(R, zn + 1.05, zt - 0.3, MAVERICK.wingSpan, 0.18, 0.72, 0.008, OLIVE));
  g.push(...finSet(R, zt - 0.24, zt - 0.02, 0.62, 0.12, 0.08, 0.008, OLIVE));
  // Motor nozzle, hanger lugs on top.
  g.push(tint(tube(V(0, 0, zt - 0.03), V(0, 0, zt + 0.005), R * 0.55, R * 0.5, 14), 0x1a1a1a, 0.6, 0.6));
  for (const zz of [-0.35, 0.4]) g.push(tint(box(0.03, 0.035, 0.07, V(0, R + 0.012, zz)), DARK, 0.5, 0.4));
  return merge(g);
}

/** AIM-9M about its own centre (canards forward, fins with rollerons aft). */
function aim9(cx: number, cy: number, cz: number): THREE.BufferGeometry[] {
  const L = 2.87;
  const R = 0.0635;
  const zn = cz - L / 2;
  const zt = cz + L / 2;
  const g: THREE.BufferGeometry[] = [];
  const body = 0xa9adac;
  g.push(tint(tube(V(0, 0, zn + 0.1), V(0, 0, zt), R, R, 14), body, 0.45, 0.2));
  const dome = new THREE.SphereGeometry(R * 0.96, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  dome.rotateX(-Math.PI / 2);
  dome.scale(1, 1, 1.3);
  dome.translate(0, 0, zn + 0.1);
  g.push(tint(dome, 0x2b2a26, 0.08, 0.3));
  g.push(tint(tube(V(0, 0, zn + 0.6), V(0, 0, zn + 0.64), R + 0.0015, R + 0.0015, 14, true), YELLOW, 0.5, 0));
  g.push(tint(tube(V(0, 0, zn + 1.16), V(0, 0, zn + 1.2), R + 0.0015, R + 0.0015, 14, true), BROWN, 0.5, 0));
  g.push(...finSet(R, zn + 0.28, zn + 0.5, 0.56, 0.1, 0.12, 0.01, body));
  g.push(...finSet(R, zt - 0.36, zt - 0.04, 0.64, 0.14, 0.2, 0.01, body));
  for (const x of g) x.translate(cx, cy, 0);
  return g;
}

/** GBU-12 Paveway II (Mk 82 body, seeker + canards in front, folded airfoil group aft). */
function gbu12(cx: number, cy: number, cz: number): THREE.BufferGeometry[] {
  const g: THREE.BufferGeometry[] = [];
  const R = 0.137;
  const zBodyF = cz - 0.95;
  const zBodyA = cz + 1.2;
  // Mk 82 body: ogive nose into the cylinder, tapered aft.
  const prof: [number, number][] = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    const z = lerp(zBodyF, zBodyA, t);
    const r = R * Math.min(1, Math.sqrt(Math.min(1, t / 0.28)) * 1.0) * (t > 0.78 ? 1 - ((t - 0.78) / 0.22) * 0.42 : 1);
    prof.push([Math.max(0.05, r), z]);
  }
  const lathe = new THREE.LatheGeometry(prof.map(([r, z]) => new THREE.Vector2(r, z)), 20);
  // Lathe axis is +Y: turn it to +Z.
  lathe.rotateX(Math.PI / 2);
  g.push(tint(lathe, OLIVE, 0.62, 0.05));
  g.push(tint(tube(V(0, 0, zBodyF + 0.32), V(0, 0, zBodyF + 0.37), R * 0.93, R * 0.93, 18, true), YELLOW, 0.55, 0));
  // Seeker: guidance body + ring wing canards.
  g.push(tint(tube(V(0, 0, zBodyF + 0.05), V(0, 0, zBodyF - 0.55), 0.105, 0.09, 16), GREY, 0.45, 0.25));
  g.push(tint(ellipsoid(V(0, 0, zBodyF - 0.58), 0.09, 0.09, 0.12, 14, 8), 0x1f2426, 0.15, 0.5));
  g.push(...finSet(0.1, zBodyF - 0.42, zBodyF - 0.18, 0.44, 0.08, 0.1, 0.008, GREY, false));
  // Airfoil group (folded wings: short span on the rack).
  g.push(tint(tube(V(0, 0, zBodyA - 0.1), V(0, 0, zBodyA + 0.35), R * 0.62, R * 0.55, 16), GREY, 0.5, 0.2));
  g.push(...finSet(R * 0.6, zBodyA - 0.05, zBodyA + 0.38, 0.56, 0.2, 0.1, 0.01, GREY));
  // Lugs.
  for (const zz of [cz - 0.18, cz + 0.18]) g.push(tint(box(0.03, 0.04, 0.06, V(0, R + 0.015, zz)), DARK, 0.5, 0.4));
  for (const x of g) x.translate(cx, cy, 0);
  return g;
}

/** A store pylon: a slim fairing from the wing's lower surface down to `bottom`. */
function pylon(x: number, z0: number, z1: number, bottom: number, thick = 0.12): THREE.BufferGeometry[] {
  const top = Math.max(wingLowerAt(x, z0 + 0.1), wingLowerAt(x, z1 - 0.1)) + 0.1;
  const h = top - bottom;
  const s = new THREE.Shape();
  s.moveTo(z0 + 0.15, 0);
  s.lineTo(z1 - 0.05, 0);
  s.lineTo(z1, h * 0.55);
  s.lineTo(z1 + 0.05, h);
  s.lineTo(z0 - 0.05, h);
  s.quadraticCurveTo(z0 - 0.05, h * 0.2, z0 + 0.15, 0);
  const g = new THREE.ExtrudeGeometry(s, { depth: thick, bevelEnabled: false, curveSegments: 4 });
  // Shape x → body z, shape y → body y (up), depth → body x.
  g.applyMatrix4(new THREE.Matrix4().makeBasis(V(0, 0, 1), V(0, 1, 0), V(1, 0, 0)));
  g.translate(x - thick / 2, bottom, 0);
  return [tint(g, PYLON, 0.62, 0.05), tint(box(thick + 0.04, 0.05, z1 - z0 - 0.3, V(x, bottom + 0.02, (z0 + z1) / 2)), DARK, 0.6, 0.3)];
}

export interface StoresBuild {
  /** Maverick geometry about its centre (one geometry, four meshes). */
  maverick: THREE.BufferGeometry;
  /** Static stores/pylons on the right outer panel (stations 9–11), left outer (1–3), centre (4–8). */
  right: THREE.BufferGeometry;
  left: THREE.BufferGeometry;
  centre: THREE.BufferGeometry;
}

/** LAU-88 at station x (sign = side): pylon, launcher beam, the two side rails, the empty bottom rail. */
function lau88(side: 1 | -1): THREE.BufferGeometry[] {
  const x = side * LAU88.x;
  const g: THREE.BufferGeometry[] = [];
  g.push(...pylon(x, -0.55, 1.35, LAU88.y + 0.1));
  const zc = (LAU88.z0 + LAU88.z1) / 2;
  const len = LAU88.z1 - LAU88.z0;
  g.push(tint(box(0.2, 0.18, len, V(x, LAU88.y, zc)), 0x5f6467, 0.6, 0.1));
  g.push(tint(ellipsoid(V(x, LAU88.y, LAU88.z0), 0.1, 0.09, 0.22, 12, 8), 0x5f6467, 0.6, 0.1));
  // Side rails down to the missiles' tops (±0.32 m), and the empty centre rail below.
  for (const s of [-1, 1]) {
    const mx = x + s * 0.32;
    g.push(tint(box(0.09, 0.05, len * 0.85, V((x + mx) / 2 + s * 0.02, -1.14, zc)).rotateZ(0), 0x555a5d, 0.6, 0.15));
    g.push(tint(box(0.07, 0.035, len * 0.8, V(mx, -1.175, zc)), 0x46494b, 0.6, 0.2));
  }
  g.push(tint(box(0.08, 0.06, len * 0.8, V(x, LAU88.y - 0.12, zc)), 0x46494b, 0.6, 0.2));
  return g;
}

export function buildStores(): StoresBuild {
  const maverick = buildMaverick();

  // Right outer panel: LAU-88 (st 9), empty st 10 pylon, LAU-105 + 2 × AIM-9M (st 11).
  const right: THREE.BufferGeometry[] = [...lau88(1)];
  {
    const x = STATION_X[11];
    right.push(...pylon(x, -0.25, 1.25, -0.52));
    right.push(tint(box(0.16, 0.12, 1.5, V(x, -0.58, 0.5)), 0x5f6467, 0.6, 0.1));
    for (const s of [-1, 1]) {
      right.push(tint(box(0.07, 0.04, 1.3, V(x + s * 0.13, -0.64, 0.5)).rotateZ(0), 0x555a5d, 0.6, 0.15));
      right.push(...aim9(x + s * 0.24, -0.73, 0.35));
    }
    right.push(...pylon(STATION_X[10], -0.1, 1.15, -0.45));
  }

  // Left outer panel: LAU-88 (st 3), Sniper pod (st 2), ALQ-184 (st 1).
  const left: THREE.BufferGeometry[] = [...lau88(-1)];
  {
    const x = STATION_X[2];
    left.push(...pylon(x, -0.15, 1.2, -0.5));
    const r = 0.15;
    const cy = -0.5 - r;
    left.push(tint(tube(V(x, cy, 1.55), V(x, cy, -0.55), r, r, 20), 0x5c6064, 0.55, 0.15));
    left.push(tint(ellipsoid(V(x, cy, 1.55), r, r, 0.3, 18, 10), 0x5c6064, 0.55, 0.15));
    // Sensor head: a rotating ball housing with the window.
    left.push(tint(tube(V(x, cy, -0.55), V(x, cy, -0.75), r, r * 0.95, 20), 0x4a4e52, 0.5, 0.2));
    left.push(tint(ellipsoid(V(x, cy, -0.8), r * 0.95, r * 0.95, 0.18, 18, 12), 0x4a4e52, 0.5, 0.2));
    left.push(tint(box(0.16, 0.12, 0.02, V(x, cy - 0.03, -0.955), 0.35, 0, 0), 0x2a3a4a, 0.04, 0.8));
  }
  {
    const x = STATION_X[1];
    left.push(...pylon(x, -0.2, 1.15, -0.4));
    const r = 0.17;
    const cy = -0.4 - r;
    left.push(tint(tube(V(x, cy, 1.7), V(x, cy, -1.3), r, r, 20), 0x74797c, 0.6, 0.1));
    left.push(tint(ellipsoid(V(x, cy, -1.3), r, r, 0.42, 18, 10), 0x3c3f41, 0.6, 0.05));
    left.push(tint(ellipsoid(V(x, cy, 1.7), r, r, 0.35, 18, 10), 0x3c3f41, 0.6, 0.05));
    left.push(tint(box(0.16, 0.08, 0.9, V(x, cy - r, 0.2)), 0x5b5f62, 0.6, 0.1));
  }

  // Centre: GBU-12s under stations 4 and 8 (between the fuselage and the gear pods).
  const centre: THREE.BufferGeometry[] = [];
  for (const st of [4, 8]) {
    const x = STATION_X[st];
    centre.push(...pylon(x, -0.45, 1.2, -1.0, 0.11));
    centre.push(...gbu12(x, -1.0 - 0.137 - 0.02, 0.2));
  }
  return { maverick, right: merge(right), left: merge(left), centre: merge(centre) };
}
