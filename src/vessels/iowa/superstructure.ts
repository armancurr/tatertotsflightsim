/**
 * USS Iowa superstructure (the 1984 modernisation, as she lies today): the 01 / 02 / 03 level
 * deckhouses, the armoured conning tower and the pilot house around the helm (04 level, glazed so
 * the helm view looks out through it), the open bridge, the tower foremast with its fire-control
 * platforms, the Mk 38 main-battery directors and Mk 37 secondary directors, the tripod foremast
 * with its air-search array and the masthead light, two funnels with black tops, the rebuilt
 * tripod mainmast; the six remaining 5-inch/38 twin mounts, eight Tomahawk armoured box launchers,
 * four Harpoon quad canisters and four Phalanx CIWS (all as shapes only); the boats; portholes and
 * windows (and the ones lit at night); and the rails and whip antennas (drawn only up close).
 * Returns plain geometries per material; index.ts makes the meshes.
 */
import * as THREE from 'three';
import { tint, merge } from '../../aircraft/materials';
import { V, ellipsoid, tube } from '../../aircraft/f16/geom';
import { gridGeometry, fanCap, boxMinMax, type P3 } from '../geom';
import { GEO, IOWA_SHAPE as S, LEVEL, by, bz } from './shape';
import { IOWA_COLORS as C } from './materials';

export interface SuperstructureGeometry {
  /** Deckhouses, tower, funnels, masts, weapons, boats, portholes — gray parts material. */
  main: THREE.BufferGeometry;
  /** Rails, whips, small fittings (drawn only up close) — gray parts material. */
  details: THREE.BufferGeometry;
  /** Pilot-house windows — glass material. */
  glass: THREE.BufferGeometry;
  /** Windows and portholes lit at night — lit material. */
  lit: THREE.BufferGeometry;
  /** Deck lamps (floodlights, passageway lights), body frame. */
  lamps: THREE.Vector3[];
}

type Plan = [number, number][]; // [x, s] points (s = m aft of the stem), convex, in order

const toBody = (p: Plan): [number, number][] => p.map(([x, s]) => [x, bz(s)]);

/** A symmetric plan: half-widths at stations (s ascending), mirrored to port. */
function symPlan(pts: [number, number][]): Plan {
  const stbd: Plan = pts.map(([s, hw]) => [hw, s]);
  const port: Plan = [...pts].reverse().map(([s, hw]) => [-hw, s]);
  return [...stbd, ...port];
}

/** A vertical prism over a convex plan (body x, z) from y0 to y1: sides `side`, top `top` (null = open). */
function prism(planB: [number, number][], y0: number, y1: number, side: number = C.haze, top: number | null = C.deckGray): THREE.BufferGeometry[] {
  const n = planB.length;
  const cx = planB.reduce((a, p) => a + p[0], 0) / n;
  const cz = planB.reduce((a, p) => a + p[1], 0) / n;
  const out: THREE.BufferGeometry[] = [];
  for (let i = 0; i < n; i++) {
    const [ax, az] = planB[i];
    const [bx, bzz] = planB[(i + 1) % n];
    if (Math.hypot(bx - ax, bzz - az) < 1e-6) continue;
    const mx = (ax + bx) / 2 - cx;
    const mz = (az + bzz) / 2 - cz;
    out.push(tint(gridGeometry([[[ax, y0, az], [bx, y0, bzz]], [[ax, y1, az], [bx, y1, bzz]]], [mx, 0, mz]), side, 0.72, 0.1));
  }
  if (top !== null) out.push(tint(fanCap(planB.map(([x, z]) => [x, y1, z] as P3), [0, 1, 0]), top, 0.85, 0.05));
  return out;
}

/** A closed elliptic cylinder (funnel, conning tower, tower) centred at (x, z), semi-axes rx, rz, from y0 to y1. */
function ellipticTube(x: number, z: number, rx: number, rz: number, y0: number, y1: number, color: number, segs = 32, taper = 1): THREE.BufferGeometry[] {
  const g = new THREE.CylinderGeometry(taper, 1, y1 - y0, segs, 1, false);
  g.scale(rx, 1, rz);
  g.translate(x, (y0 + y1) / 2, z);
  return [tint(g, color, 0.7, 0.1)];
}

/** A flat quad facing ±X at x (z0…z1, y0…y1). */
const quadX = (x: number, z0: number, z1: number, y0: number, y1: number, facing: 1 | -1, color: number) =>
  tint(gridGeometry([[[x, y0, z0], [x, y0, z1]], [[x, y1, z0], [x, y1, z1]]], [facing, 0, 0]), color, 0.3, 0.2);
/** A flat quad facing ±Z at z (x0…x1, y0…y1). */
const quadZ = (z: number, x0: number, x1: number, y0: number, y1: number, facing: 1 | -1, color: number) =>
  tint(gridGeometry([[[x0, y0, z], [x1, y0, z]], [[x0, y1, z], [x1, y1, z]]], [0, 0, facing]), color, 0.3, 0.2);

/** Deterministic hash 0…1. */
const hash = (a: number, b: number) => {
  const v = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return v - Math.floor(v);
};

/** Apply a local → body transform (rotate about Y by −train, i.e. + train turns toward starboard, then translate). */
function place(list: THREE.BufferGeometry[], x: number, y: number, z: number, trainDeg = 0): THREE.BufferGeometry[] {
  const m = new THREE.Matrix4().makeRotationY((-trainDeg * Math.PI) / 180).setPosition(x, y, z);
  for (const g of list) g.applyMatrix4(m);
  return list;
}

/** 5-inch/38 twin mount (Mk 28 gunhouse): local frame, origin on its deck, guns toward −Z. */
function fiveInchMount(): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const base = new THREE.CylinderGeometry(2.3, 2.4, 0.5, 24);
  base.translate(0, 0.25, 0);
  out.push(tint(base, C.hazeDark, 0.7, 0.1));
  // gunhouse: sloped front, flat roof, square back
  const lo: [number, number][] = [[-2.1, -2.7], [2.1, -2.7], [2.5, 3.1], [-2.5, 3.1]];
  const hi: [number, number][] = [[-1.9, -1.7], [1.9, -1.7], [2.35, 3.0], [-2.35, 3.0]];
  const y0 = 0.5;
  const y1 = 3.3;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const [ax, az] = lo[i];
    const [bx, bzz] = lo[j];
    const [cx, cz] = hi[j];
    const [dx, dz] = hi[i];
    const mid = [(ax + bx) / 2, (az + bzz) / 2];
    out.push(tint(gridGeometry([[[ax, y0, az], [bx, y0, bzz]], [[dx, y1, dz], [cx, y1, cz]]], [mid[0], 0.2, mid[1]]), C.haze, 0.7, 0.1));
  }
  out.push(tint(fanCap(hi.map(([x, z]) => [x, y1, z] as P3), [0, 1, 0]), C.haze, 0.7, 0.1));
  // sight hoods on the roof
  for (const x of [-1.3, 1.3]) out.push(tint(boxMinMax(x - 0.35, y1, -1.0, x + 0.35, y1 + 0.45, -0.1), C.haze, 0.7, 0.1));
  // the two 5-inch barrels with their blast bags
  for (const x of [-0.75, 0.75]) {
    out.push(tint(tube(V(x, 1.5, -1.9), V(x, 1.5, -2.6), 0.3, 0.26, 10), C.hazeDark, 0.8, 0));
    out.push(tint(tube(V(x, 1.5, -2.6), V(x, 1.5, -7.6), 0.14, 0.11, 10), C.haze, 0.5, 0.4));
  }
  return out;
}

/** Tomahawk armoured box launcher (stowed flat): local frame, origin on its deck, long axis along z. */
function tomahawkABL(): THREE.BufferGeometry[] {
  const out = [tint(boxMinMax(-1.0, 0, -2.0, 1.0, 0.9, 2.0), C.hazeDark, 0.7, 0.1), tint(boxMinMax(-1.3, 0.9, -3.3, 1.3, 2.6, 3.3), C.haze, 0.7, 0.15)];
  for (const z of [-2.2, 0, 2.2]) out.push(tint(boxMinMax(-1.36, 0.95, z - 0.12, 1.36, 2.66, z + 0.12), C.hazeDark, 0.7, 0.15));
  // the four cell doors on the front face
  for (const [x, y] of [[-0.6, 1.3], [0.6, 1.3], [-0.6, 2.15], [0.6, 2.15]]) out.push(quadZ(-3.31, x - 0.5, x + 0.5, y - 0.35, y + 0.35, -1, C.hazeDark));
  return out;
}

/** Harpoon quad canisters on their rack: local frame, pointing toward −Z, elevated 30°. */
function harpoonQuad(): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [tint(boxMinMax(-1.2, 0, -1.6, 1.2, 0.8, 1.6), C.hazeDark, 0.7, 0.1)];
  const tubes: THREE.BufferGeometry[] = [];
  for (const x of [-0.42, 0.42]) for (const y of [0, 0.8]) tubes.push(tint(boxMinMax(x - 0.38, y, -2.3, x + 0.38, y + 0.76, 2.3), C.haze, 0.6, 0.15));
  const m = new THREE.Matrix4().makeRotationX((30 * Math.PI) / 180).setPosition(0, 1.4, 0);
  for (const t of tubes) t.applyMatrix4(m);
  return [...out, ...tubes];
}

/** Phalanx CIWS: pedestal, gun body, the white radome ("R2-D2") and the barrel cluster; faces −Z. */
function ciws(): THREE.BufferGeometry[] {
  const ped = new THREE.CylinderGeometry(0.95, 1.05, 1.1, 20);
  ped.translate(0, 0.55, 0);
  const dome = new THREE.CylinderGeometry(0.62, 0.66, 1.5, 20);
  dome.translate(0, 2.55, 0.35);
  return [
    tint(ped, C.haze, 0.7, 0.1),
    tint(boxMinMax(-0.75, 1.1, -0.6, 0.75, 1.9, 1.0), C.white, 0.5, 0.1),
    tint(dome, C.white, 0.45, 0.05),
    tint(ellipsoid(V(0, 3.3, 0.35), 0.64, 0.5, 0.66, 20, 10), C.white, 0.45, 0.05),
    tint(tube(V(0, 1.6, -0.6), V(0, 1.6, -2.5), 0.2, 0.16, 12), C.hazeDark, 0.5, 0.5),
  ];
}

/** Mk 37 secondary-battery director with its Mk 25 dish: local frame, facing −Z. */
function mk37(): THREE.BufferGeometry[] {
  const dish = new THREE.CylinderGeometry(1.5, 1.5, 0.25, 24);
  dish.rotateX(Math.PI / 2);
  dish.translate(0, 4.1, -0.3);
  return [
    ...prism([[-1.8, -1.6], [1.8, -1.6], [2.0, 2.0], [-2.0, 2.0]], 0, 2.6, C.haze, C.haze),
    tint(boxMinMax(-2.4, 1.6, -0.6, 2.4, 2.1, -0.1), C.hazeDark, 0.6, 0.3),
    tint(tube(V(0, 2.6, 0), V(0, 3.9, 0), 0.25, 0.25, 8), C.hazeDark, 0.6, 0.3),
    tint(dish, C.hazeDark, 0.6, 0.3),
  ];
}

/** Mk 38 main-battery director with its rangefinder arms: local frame, facing −Z. */
function mk38(): THREE.BufferGeometry[] {
  return [
    ...prism([[-2.2, -2.0], [2.2, -2.0], [2.5, 2.2], [-2.5, 2.2]], 0, 2.8, C.haze, C.haze),
    tint(tube(V(-6.5, 1.8, 0.3), V(6.5, 1.8, 0.3), 0.45, 0.45, 12), C.haze, 0.7, 0.1),
    tint(boxMinMax(-7.0, 1.2, -0.3, -6.1, 2.4, 0.9), C.hazeDark, 0.7, 0.1),
    tint(boxMinMax(6.1, 1.2, -0.3, 7.0, 2.4, 0.9), C.hazeDark, 0.7, 0.1),
    tint(boxMinMax(-1.4, 2.8, -1.2, 1.4, 3.8, 0.6), C.hazeDark, 0.6, 0.3),
  ];
}

/** A ship's boat on its cradle (12 m motor boat). */
function boat(): THREE.BufferGeometry[] {
  const hull = ellipsoid(V(0, 0.9, 0), 1.6, 1.0, 6.0, 20, 10);
  const pos = hull.getAttribute('position');
  for (let i = 0; i < pos.count; i++) if (pos.getY(i) > 1.1) pos.setY(i, 1.1);
  hull.computeVertexNormals();
  return [
    tint(boxMinMax(-1.2, 0, -3.5, 1.2, 0.5, -2.9), C.hazeDark, 0.7, 0.1),
    tint(boxMinMax(-1.2, 0, 2.9, 1.2, 0.5, 3.5), C.hazeDark, 0.7, 0.1),
    tint(hull, C.haze, 0.6, 0.05),
    tint(boxMinMax(-1.0, 1.1, -1.8, 1.0, 2.1, 1.2), C.white, 0.6, 0.05),
  ];
}

/** Rails round a plan at deck height y (stanchions every ~2.5 m and two wires). */
function railsAround(planB: [number, number][], y: number): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const n = planB.length;
  for (let i = 0; i < n; i++) {
    const [ax, az] = planB[i];
    const [bx, bzz] = planB[(i + 1) % n];
    const len = Math.hypot(bx - ax, bzz - az);
    if (len < 0.3) continue;
    const k = Math.max(1, Math.round(len / 2.5));
    for (let j = 0; j < k; j++) {
      const t = j / k;
      const x = ax + (bx - ax) * t;
      const z = az + (bzz - az) * t;
      out.push(tint(boxMinMax(x - 0.03, y, z - 0.03, x + 0.03, y + 1.0, z + 0.03), C.haze, 0.6, 0.2));
    }
    for (const h of [0.5, 0.98]) out.push(tint(tube(V(ax, y + h, az), V(bx, y + h, bzz), 0.025, 0.025, 4, true), C.haze, 0.6, 0.2));
  }
  return out;
}

/** Portholes along a side wall (x fixed) between z0 and z1 at height y: dark discs; returns [dark, lit]. */
function portholes(x: number, z0: number, z1: number, y: number, facing: 1 | -1, spacing: number, lit: THREE.BufferGeometry[], seed: number): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const n = Math.max(1, Math.floor((z1 - z0) / spacing));
  for (let i = 0; i <= n; i++) {
    const z = z0 + ((z1 - z0) * i) / n;
    out.push(quadX(x + facing * 0.02, z - 0.22, z + 0.22, y - 0.22, y + 0.22, facing, C.window));
    if (hash(i, seed) < 0.38) lit.push(quadX(x + facing * 0.05, z - 0.2, z + 0.2, y - 0.2, y + 0.2, facing, 0xffffff));
  }
  return out;
}

export function buildSuperstructure(): SuperstructureGeometry {
  const main: THREE.BufferGeometry[] = [];
  const det: THREE.BufferGeometry[] = [];
  const glass: THREE.BufferGeometry[] = [];
  const lit: THREE.BufferGeometry[] = [];
  const lamps: THREE.Vector3[] = [];
  const Y = by;

  // ── Deckhouses (01, 02, 03 levels) ──
  const p01 = toBody(symPlan([[88, 7.5], [95, 11.2], [102, 12.8], [172, 12.8], [180, 9.5]]));
  const p02 = toBody(symPlan([[90, 7.0], [96, 9.8], [170, 9.8], [176, 8.0]]));
  const p03f = toBody(symPlan([[94.5, 6.2], [98, 7.6], [134, 7.6], [135.5, 6.0]]));
  const p03a = toBody(symPlan([[144, 5.2], [146, 6.8], [172, 6.8]]));
  const p04a = toBody(symPlan([[163, 4.2], [172, 4.2]]));
  main.push(...prism(p01, Y(6.0), Y(LEVEL.l01)));
  main.push(...prism(p02, Y(LEVEL.l01), Y(LEVEL.l02)));
  main.push(...prism(p03f, Y(LEVEL.l02), Y(LEVEL.l03)));
  main.push(...prism(p03a, Y(LEVEL.l02), Y(LEVEL.l03)));
  main.push(...prism(p04a, Y(LEVEL.l03), Y(LEVEL.l04)));
  det.push(...railsAround(p01, Y(LEVEL.l01)), ...railsAround(p02, Y(LEVEL.l02)), ...railsAround(p03a, Y(LEVEL.l03)), ...railsAround(p04a, Y(LEVEL.l04)));
  // portholes and doors on the deckhouse sides
  for (const side of [-1, 1] as const) {
    main.push(...portholes(side * 12.8, bz(104), bz(170), Y(8.9), side, 2.6, lit, 1 + side));
    main.push(...portholes(side * 9.8, bz(98), bz(168), Y(11.7), side, 2.2, lit, 5 + side));
    main.push(...portholes(side * 7.6, bz(99), bz(132), Y(14.4), side, 2.0, lit, 9 + side));
    for (const s of [110, 136, 158]) main.push(quadX(side * 12.82, bz(s) - 0.6, bz(s) + 0.6, Y(LEVEL.main - 0.2), Y(LEVEL.main + 1.9), side, C.hazeDark));
    for (let i = 0; i < 6; i++) lamps.push(V(side * 12.9, Y(LEVEL.l01 - 0.3), bz(106 + i * 12)));
    for (let i = 0; i < 4; i++) lamps.push(V(side * 9.9, Y(LEVEL.l02 - 0.3), bz(104 + i * 18)));
  }

  // ── Conning tower (armoured, with its vision slits) ──
  const ct = S.conningTower;
  main.push(...ellipticTube(0, bz(ct.s), ct.rx, ct.rz, Y(LEVEL.l02), Y(ct.top), C.haze, 36));
  const slit = new THREE.CylinderGeometry(1, 1, 0.35, 36, 1, true);
  slit.scale(ct.rx + 0.03, 1, ct.rz + 0.03);
  slit.translate(0, Y(ct.top - 0.9), bz(ct.s));
  main.push(tint(slit, C.window, 0.4, 0.2));

  // ── The 03–04 block under the pilot house, the pilot house (glazed band), its roof, the open bridge ──
  const ph = S.pilotHouse;
  const phPlan = toBody(symPlan([[ph.s0, ph.half - 1.2], [ph.s0 + 1.2, ph.half], [ph.s1, ph.half]]));
  const l04 = Y(LEVEL.l04);
  const eye = GEO.pilotEye;
  main.push(...prism(phPlan, Y(LEVEL.l03), l04));
  main.push(...prism(phPlan, l04, l04 + ph.winLo, C.haze, null));
  main.push(...prism(phPlan, l04 + ph.winHi, l04 + ph.roof, C.haze, C.deckGray));
  // the deckhead (ceiling) seen from the helm
  main.push(tint(fanCap(phPlan.map(([x, z]) => [x, l04 + ph.winHi - 0.01, z] as P3), [0, -1, 0]), 0xb9bcbe, 0.9, 0));
  // pillars between the windows, and the glass
  const n = phPlan.length;
  for (let i = 0; i < n; i++) {
    const [ax, az] = phPlan[i];
    const [bx, bzz] = phPlan[(i + 1) % n];
    const back = Math.abs(az - bz(ph.s1)) < 0.01 && Math.abs(bzz - bz(ph.s1)) < 0.01;
    const len = Math.hypot(bx - ax, bzz - az);
    if (len < 0.1) continue;
    if (back) {
      main.push(...prism([[ax, az], [bx, bzz], [bx, bzz + 0.2], [ax, az + 0.2]], l04 + ph.winLo, l04 + ph.winHi, C.haze, null));
      continue;
    }
    // mullions every ~1.6 m; on the front, a pane centred on the helm eye (nothing between it and the bow)
    const front = Math.abs(az - bzz) < 0.01 && Math.abs(az - bz(ph.s0)) < 0.01;
    const ts: number[] = [0, 1];
    if (front) {
      for (let x = eye.x - 0.85; x > Math.min(ax, bx) + 0.3; x -= 1.7) ts.push((x - ax) / (bx - ax));
      for (let x = eye.x + 0.85; x < Math.max(ax, bx) - 0.3; x += 1.7) ts.push((x - ax) / (bx - ax));
    } else {
      const k = Math.max(1, Math.round(len / 1.6));
      for (let j = 1; j < k; j++) ts.push(j / k);
    }
    for (const t of ts) {
      const x = ax + (bx - ax) * t;
      const z = az + (bzz - az) * t;
      main.push(tint(boxMinMax(x - 0.05, l04 + ph.winLo, z - 0.05, x + 0.05, l04 + ph.winHi, z + 0.05), C.haze, 0.7, 0.1));
    }
    const mx = (ax + bx) / 2;
    const mz = (az + bzz) / 2;
    glass.push(gridGeometry([[[ax, l04 + ph.winLo, az], [bx, l04 + ph.winLo, bzz]], [[ax, l04 + ph.winHi, az], [bx, l04 + ph.winHi, bzz]]], [mx, 0, mz - bz((ph.s0 + ph.s1) / 2)]));
    lit.push(tint(gridGeometry([[[ax * 0.99, l04 + ph.winLo + 0.1, az + 0.05], [bx * 0.99, l04 + ph.winLo + 0.1, bzz + 0.05]], [[ax * 0.99, l04 + ph.winLo + 0.35, az + 0.05], [bx * 0.99, l04 + ph.winLo + 0.35, bzz + 0.05]]], [mx, 0, mz]), 0xffffff, 1, 0));
  }
  // the helm console and the wheel pedestal in front of the officer of the deck
  main.push(tint(boxMinMax(-3.5, l04, bz(ph.s0) + 0.5, 3.5, l04 + 0.85, bz(ph.s0) + 1.0), C.hazeDark, 0.6, 0.2));
  main.push(tint(tube(V(0, l04, eye.z - 0.6), V(0, l04 + 1.1, eye.z - 0.6), 0.25, 0.3, 10), C.black, 0.5, 0.3));
  // bridge wings (open platforms either side) and the open bridge on the roof
  for (const side of [-1, 1]) {
    main.push(tint(boxMinMax(Math.min(side * ph.half, side * 8.6), l04 - 0.25, bz(93.8), Math.max(side * ph.half, side * 8.6), l04, bz(97.5)), C.deckGray, 0.8, 0.1));
    det.push(...railsAround([[side * ph.half, bz(93.8)], [side * 8.6, bz(93.8)], [side * 8.6, bz(97.5)], [side * ph.half, bz(97.5)]], l04));
  }
  const obPlan = toBody(symPlan([[ph.s0 + 1.5, 4.2], [ph.s1 + 3, 4.2]]));
  det.push(...railsAround(obPlan, l04 + ph.roof));

  // ── The tower foremast, its platforms and directors ──
  const tw = S.tower;
  main.push(...ellipticTube(0, bz(tw.s), tw.r + 0.6, tw.r, Y(LEVEL.l03), Y(tw.top), C.haze, 28));
  for (const [h, rx, rz0, rz1] of [[LEVEL.l05, 6.8, 101.5, 114], [24.6, 7.6, 103, 112], [28.6, 5.4, 104.5, 111.5], [32.4, 4.6, 105, 111]] as const) {
    main.push(...prism(toBody(symPlan([[rz0, rx - 1.5], [rz0 + 1.5, rx], [rz1, rx]])), Y(h - 0.35), Y(h)));
    det.push(...railsAround(toBody(symPlan([[rz0, rx - 1.5], [rz0 + 1.5, rx], [rz1, rx]])), Y(h)));
  }
  for (const side of [-1, 1]) main.push(...place(mk37(), side * 5.4, Y(24.6), bz(107.5), side * 20));
  main.push(...place(mk38(), 0, Y(tw.top), bz(tw.s - 0.5)));
  // the tripod foremast: three legs to the apex, the pole, yards, the air-search array, TACAN
  const apex = V(0, Y(45.5), bz(108.8));
  for (const [x, s] of [[-2.6, 106.3], [2.6, 106.3], [0, 111.5]] as const) main.push(tint(tube(V(x, Y(tw.top + 2.8), bz(s)), apex, 0.34, 0.26, 8), C.haze, 0.7, 0.1));
  main.push(tint(tube(apex, V(0, Y(tw.mastTop), bz(109)), 0.24, 0.1, 8), C.haze, 0.7, 0.1));
  main.push(tint(tube(V(-6.5, Y(43.2), bz(109)), V(6.5, Y(43.2), bz(109)), 0.12, 0.12, 6), C.haze, 0.7, 0.1));
  main.push(tint(boxMinMax(-2.4, Y(40.6), bz(106.2), 2.4, Y(41.0), bz(110.8)), C.deckGray, 0.8, 0.1));
  main.push(tint(boxMinMax(-3.7, Y(41.2), bz(106.6), 3.7, Y(45.4), bz(106.2)), C.hazeDark, 0.6, 0.4));
  for (let i = -3; i <= 3; i++) det.push(tint(boxMinMax(i * 1.05 - 0.04, Y(41.2), bz(106.65), i * 1.05 + 0.04, Y(45.4), bz(106.55)), C.haze, 0.6, 0.3));
  main.push(tint(tube(V(0, Y(47.6), bz(109)), V(0, Y(48.6), bz(109)), 0.6, 0.6, 12), C.hazeDark, 0.6, 0.3));
  main.push(tint(boxMinMax(-2.2, Y(46.2), bz(108.6), 2.2, Y(46.7), bz(109.4)), C.hazeDark, 0.6, 0.3));
  // masthead light housing
  main.push(tint(boxMinMax(-0.25, Y(44.2), bz(109.3), 0.25, Y(44.9), bz(109.8)), C.black, 0.6, 0.2));

  // ── Funnels (black tops, cap grilles), with their floodlights ──
  for (const f of S.funnels) {
    const z = bz(f.s);
    const tp = 0.86;
    const topScale = 1 - (1 - tp) * ((f.top - 2.0 - LEVEL.l02) / (f.top - LEVEL.l02));
    main.push(...ellipticTube(0, z, f.hx, f.hs, Y(LEVEL.l02), Y(f.top - 2.0), C.haze, 32, topScale));
    main.push(...ellipticTube(0, z, f.hx * topScale + 0.04, f.hs * topScale + 0.04, Y(f.top - 2.0), Y(f.top), C.black, 32, tp / topScale));
    const cap = new THREE.CylinderGeometry(1, 1, 0.25, 32);
    cap.scale(f.hx * tp - 0.3, 1, f.hs * tp - 0.3);
    cap.translate(0, Y(f.top - 0.35), z);
    main.push(tint(cap, 0x0b0c0d, 0.9, 0.2));
    // the smoke-pipe tops sticking up through the grille
    for (const dz of [-f.hs * 0.45, 0, f.hs * 0.45]) main.push(tint(tube(V(0, Y(f.top - 0.5), z + dz), V(0, Y(f.top + 0.6), z + dz), 0.8, 0.8, 12), 0x0b0c0d, 0.9, 0.2));
    // the funnel's platform (searchlight level) and the steam pipe up its aft face
    main.push(...prism(toBody(symPlan([[f.s - f.hs - 1.2, f.hx + 1.4], [f.s + f.hs + 1.2, f.hx + 1.4]])), Y(21.6), Y(21.9)));
    det.push(...railsAround(toBody(symPlan([[f.s - f.hs - 1.2, f.hx + 1.4], [f.s + f.hs + 1.2, f.hx + 1.4]])), Y(21.9)));
    det.push(tint(tube(V(0, Y(LEVEL.l02), z + f.hs + 0.3), V(0, Y(f.top + 0.8), z + f.hs + 0.3), 0.22, 0.22, 8), C.hazeDark, 0.6, 0.3));
    lamps.push(V(f.hx + 1.3, Y(22.6), z), V(-f.hx - 1.3, Y(22.6), z));
  }

  // ── The mainmast (a tripod aft of the second funnel), its yard, radar, range light ──
  const mm = S.mainmast;
  const mApex = V(0, Y(34), bz(mm.s + 0.4));
  for (const [x, s] of [[-2.8, mm.s - 3], [2.8, mm.s - 3], [0, mm.s + 4.5]] as const) main.push(tint(tube(V(x, Y(LEVEL.l03), bz(s)), mApex, 0.36, 0.26, 8), C.haze, 0.7, 0.1));
  main.push(tint(tube(mApex, V(0, Y(mm.top), bz(mm.s + 0.5)), 0.22, 0.1, 8), C.haze, 0.7, 0.1));
  main.push(tint(tube(V(-5, Y(33.2), bz(mm.s + 0.4)), V(5, Y(33.2), bz(mm.s + 0.4)), 0.12, 0.12, 6), C.haze, 0.7, 0.1));
  main.push(tint(boxMinMax(-2.6, Y(35.2), bz(mm.s - 0.1), 2.6, Y(36.4), bz(mm.s + 0.3)), C.hazeDark, 0.6, 0.4));
  main.push(tint(boxMinMax(-0.25, Y(37.7), bz(mm.s + 0.4), 0.25, Y(38.4), bz(mm.s + 0.9)), C.black, 0.6, 0.2));
  // aft Mk 38 director on its pedestal, aft Mk 37 at the end of the 02 level
  main.push(tint(tube(V(0, Y(LEVEL.l04), bz(169)), V(0, Y(21.6), bz(169)), 1.6, 1.8, 16), C.haze, 0.7, 0.1));
  main.push(...place(mk38(), 0, Y(21.6), bz(169), 180));
  main.push(...place(mk37(), 0, Y(LEVEL.l02), bz(174), 180));

  // ── Secondary battery, missiles, CIWS, boats ──
  for (const side of [-1, 1]) {
    for (const m of S.fiveInch) main.push(...place(fiveInchMount(), side * m.x, Y(m.deck), bz(m.s), m.train === 0 ? side * 12 : 180 - side * 12));
    for (const t of S.tomahawk) main.push(...place(tomahawkABL(), side * t.x, Y(t.deck), bz(t.s)));
    for (const h of S.harpoon) main.push(...place(harpoonQuad(), side * h.x, Y(h.deck), bz(h.s), side * 70));
    for (const c of S.ciws) main.push(...place(ciws(), side * c.x, Y(c.deck), bz(c.s), c.s < 140 ? side * 30 : 180 - side * 30));
    main.push(...place(boat(), side * 5.7, Y(LEVEL.l02), bz(139.5)));
  }
  // CIWS sponsons on the 03 level (the forward pair sits outboard of the deckhouse)
  for (const side of [-1, 1]) {
    const c = S.ciws[0];
    main.push(...prism([[side * 6.2, bz(c.s - 2.4)], [side * 9.9, bz(c.s - 2.4)], [side * 9.9, bz(c.s + 2.4)], [side * 6.2, bz(c.s + 2.4)]], Y(LEVEL.l03 - 0.4), Y(LEVEL.l03)));
    det.push(...railsAround([[side * 6.2, bz(c.s - 2.4)], [side * 9.9, bz(c.s - 2.4)], [side * 9.9, bz(c.s + 2.4)], [side * 6.2, bz(c.s + 2.4)]], Y(LEVEL.l03)));
  }

  // ── Whip antennas ──
  for (const [x, s, h0, h1] of [[12.4, 98, LEVEL.l01, 22], [-12.4, 98, LEVEL.l01, 22], [9.5, 176, LEVEL.l02, 25], [-9.5, 176, LEVEL.l02, 25], [6.5, 150, LEVEL.l03, 30]] as const) {
    det.push(tint(tube(V(x, Y(h0), bz(s)), V(x, Y(h1), bz(s)), 0.07, 0.03, 5), C.haze, 0.6, 0.3));
  }

  // ── Deck lamps on the open decks (the helicopter pad's perimeter, the forecastle, the quarterdeck) ──
  const hp = S.helipad;
  for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]]) lamps.push(V(dx * (hp.half + 0.3), Y(6.4), bz(hp.s) + dz * (hp.half + 0.3)));
  for (const s of [30, 60, 190, 210, 228]) for (const side of [-1, 1]) lamps.push(V(side * 3, Y(s < 100 ? 11.8 : 7.0), bz(s)));

  const out = {
    main: merge(main),
    details: merge(det),
    glass: merge(glass.map((g) => tint(g, 0xffffff, 0.1, 0))),
    lit: merge(lit),
    lamps,
  };
  return out;
}
