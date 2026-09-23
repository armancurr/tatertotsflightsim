/**
 * A-10C canopy and cockpit, built to be looked at from the seat:
 *
 *  - the three-piece armoured windscreen (flat front panel, curved side panels) in a medium-grey
 *    frame — two slim posts at the front panel's edges and the bow where the one-piece bubble
 *    canopy starts (with the three rear-view mirrors); the bubble itself is frameless overhead;
 *  - the glareshield with the HUD (a tall combiner glass leaning back on its housing, placed so
 *    level flight sits in the middle of it), the AOA and refuel indexers, MASTER CAUTION / GUN
 *    READY lamps and the three fire T-handles;
 *  - the front dash (painted canvas, panel.ts): AHCP, UFC keypad, the ADI/HSI and standby
 *    instruments, engine instruments for both TF34s, fuel, gear handle + lights and flap
 *    indicator, with 3D bezels, option-select buttons, toggles and knobs over the paint;
 *  - two 5 × 5" MFCDs (unlit screens: TAD, TGP / DSMS), the lamp faces and the CDU display;
 *  - the consoles (painted tops), the centre stick and the throttles (moving parts), the ACES II
 *    seat, rudder pedals, and the pilot (helmet, olive flight suit, harness).
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { loftGeometry } from '../loft';
import { tint, merge } from '../materials';
import { box, ellipsoid, tube, V } from '../f16/geom';
import { ANCHOR, CANOPY_FRONT_Z, CANOPY_REAR_Z, WINDSCREEN_BOW_Z, canopyArch, canopyAt } from './shape';
import {
  AHCP, AHCP_SWITCHES, CDU_RECT, CONSOLE, CONSOLE_PX, CONSOLE_ROW, DASH, ENGINE, GAUGE, GEAR, LAMP, MFCD, PANEL_CANVAS, SCREEN_CANVAS, UFC, ahcpX, lampCell,
  type LampId,
} from './panel';

const EYE = ANCHOR.eye;
const DEG = Math.PI / 180;

export interface CockpitBuild {
  canopyGlass: THREE.BufferGeometry;
  canopyFrame: THREE.BufferGeometry;
  interior: THREE.BufferGeometry;
  pilotBody: THREE.BufferGeometry;
  pilotHead: THREE.BufferGeometry;
  /** HUD combiner glass in its own frame (a w × h rectangle in the local XY plane, facing +z); place it with `hudPosition` and a rotation of `HUD.tilt` about X. */
  hudGlass: THREE.BufferGeometry;
  hudPosition: THREE.Vector3;
  /** Unlit faces from the screens canvas: MFCDs, lamps, CDU. */
  screens: THREE.BufferGeometry;
  /** Lit faces from the panel canvas: the front dash and the console tops. */
  panelFace: THREE.BufferGeometry;
  /** Centre stick about its pivot (local origin = STICK.pivot): tilt it with the controls. */
  stick: THREE.BufferGeometry;
  /** The two throttle levers about their pivot (local origin = THROTTLE.pivot). */
  throttle: THREE.BufferGeometry;
}

/** Instrument panel plane: centre height, depth, tilt (raked back), size. */
export const PANEL = { cy: 0.6, z: -5.02, tilt: -0.16, w: DASH.w, h: DASH.h } as const;
/** The glareshield's aft lip (limits the view over the nose: ~18° below the eye). */
export const GLARESHIELD = { y: 0.875, z: -4.98 } as const;
/**
 * HUD combiner glass: a single pane leaning back over the UFC. From the eye it spans about
 * −10.5° … +5° (boresight = 0°): level cruise (2–4.5° nose up) puts the horizon and the
 * flight-path marker in its middle, like the real A-10C HUD. (≈ 15.5° tall: the jet HUD keeps its
 * compact A-10 layout at 1440 × 900 and 1024 × 768.)
 */
export const HUD = { w: 0.19, h: 0.175, tilt: 0.25, z: -4.935, bottomY: 0.982 } as const;
/** Centre of the combiner glass. */
export function hudCentre(): THREE.Vector3 {
  return V(0, HUD.bottomY + (HUD.h / 2) * Math.cos(HUD.tilt), HUD.z + (HUD.h / 2) * Math.sin(HUD.tilt));
}
/** The windscreen's front panel edges (posts): x at the base and at the bow; the frame section. */
export const WINDSCREEN = { baseZ: -5.4, baseX: 0.3, topX: 0.165, postW: 0.03, postD: 0.018, bowW: 0.032, bowD: 0.016 } as const;
/** Fire T-handles on the glareshield: L ENG, APU, R ENG (x). */
const FIRE_X = [-0.335, 0.3, 0.37] as const;
/** Centre stick: floor pivot, travel. */
export const STICK = { pivot: { x: 0, y: 0.12, z: -4.62 }, pitchDeg: 9, rollDeg: 8 } as const;
/** Throttle levers: pivot in the left console quadrant; lever angle at idle (aft) and at max (forward). */
export const THROTTLE = { pivot: { x: -0.39, y: 0.585, z: -4.47 }, idleDeg: 20, maxDeg: -24 } as const;

/** A point on the panel plane (panel coordinates x right, y up from the panel centre; dz toward the pilot). */
export function panelPoint(x: number, y: number, dz = 0): THREE.Vector3 {
  const c = Math.cos(PANEL.tilt);
  const s = Math.sin(PANEL.tilt);
  return V(x, PANEL.cy + y * c - dz * s, PANEL.z + y * s + dz * c);
}
/** Unit normal of the panel face (toward the pilot). */
const PANEL_N = V(0, -Math.sin(PANEL.tilt), Math.cos(PANEL.tilt));

// ─── Geometry helpers ────────────────────────────────────────────────────────

/** A quad with explicit corners (a → b → c → d counter-clockwise seen from the front) and UVs. */
function quad4(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, uv: [number, number, number, number]): THREE.BufferGeometry {
  const [u0, v0, u1, v1] = uv;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, d.x, d.y, d.z], 3));
  const n = b.clone().sub(a).cross(d.clone().sub(a)).normalize();
  g.setAttribute('normal', new THREE.Float32BufferAttribute([n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([u0, v0, u1, v0, u1, v1, u0, v1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

/** A rectangle on the panel face (panel coords centre, size) mapped to a UV rect. */
function panelRect(x: number, y: number, w: number, h: number, dz: number, uv: [number, number, number, number]): THREE.BufferGeometry {
  return quad4(panelPoint(x - w / 2, y - h / 2, dz), panelPoint(x + w / 2, y - h / 2, dz), panelPoint(x + w / 2, y + h / 2, dz), panelPoint(x - w / 2, y + h / 2, dz), uv);
}

/** Pixel rect on a canvas → UV rect (flipY). */
function uvRect(x: number, y: number, w: number, h: number, W: number, H: number): [number, number, number, number] {
  return [x / W, 1 - (y + h) / H, (x + w) / W, 1 - y / H];
}

/** Closed hexahedron from 8 corners (0–3 one end, 4–7 the other, same order); outward normals, flat shaded. */
function hexa(c: THREE.Vector3[]): THREE.BufferGeometry {
  const centre = c.reduce((s, p) => s.add(p), V(0, 0, 0)).multiplyScalar(1 / 8);
  const faces = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  const pos: number[] = [];
  const nor: number[] = [];
  const idx: number[] = [];
  for (const f of faces) {
    const [a, b, cc, d] = f.map((i) => c[i]);
    let n = b.clone().sub(a).cross(d.clone().sub(a));
    if (n.lengthSq() < 1e-14) n = cc.clone().sub(b).cross(a.clone().sub(b));
    n.normalize();
    const mid = a.clone().add(b).add(cc).add(d).multiplyScalar(0.25);
    const flip = n.dot(mid.sub(centre)) < 0;
    if (flip) n.negate();
    const base = pos.length / 3;
    for (const p of [a, b, cc, d]) {
      pos.push(p.x, p.y, p.z);
      nor.push(n.x, n.y, n.z);
    }
    if (flip) idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    else idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Array((pos.length / 3) * 2).fill(0), 2));
  g.setIndex(idx);
  return g;
}

/** A rectangular bar along a polyline: `side` (width) and `inward` (depth) unit vectors per point; the outer face is `out` outside the point. */
function bar(pts: THREE.Vector3[], side: THREE.Vector3[], inward: THREE.Vector3[], w: number, d: number, out: number): THREE.BufferGeometry[] {
  const corners = (i: number) => {
    const p = pts[i];
    const s = side[i].clone().multiplyScalar(w / 2);
    const o = inward[i].clone().multiplyScalar(-out);
    const n = inward[i].clone().multiplyScalar(d);
    return [p.clone().sub(s).add(o), p.clone().add(s).add(o), p.clone().add(s).add(n), p.clone().sub(s).add(n)];
  };
  const out2: THREE.BufferGeometry[] = [];
  for (let i = 0; i < pts.length - 1; i++) out2.push(hexa([...corners(i), ...corners(i + 1)]));
  return out2;
}

/** Point on the canopy surface at station z and lateral x (upper surface of the superellipse arch). */
export function canopySurfaceY(z: number, x: number): number {
  const c = canopyAt(z);
  const t = Math.min(0.999, Math.abs(x) / c.w);
  return c.sill + (c.top - c.sill) * (1 - t ** c.n) ** (1 / c.n);
}

/** The windscreen post (front panel edge) on side s at fraction t (0 = base, 1 = bow). */
export function windscreenPost(s: 1 | -1, t: number): THREE.Vector3 {
  const z = WINDSCREEN.baseZ + (WINDSCREEN_BOW_Z - WINDSCREEN.baseZ) * t;
  const x = s * (WINDSCREEN.baseX + (WINDSCREEN.topX - WINDSCREEN.baseX) * t);
  return V(x, canopySurfaceY(z, x), z);
}

// ─── Canopy: glass and frame ─────────────────────────────────────────────────

const FRAME = 0x6c7479;
const FRAME_DARK = 0x4b5257;

function buildCanopy(): { glass: THREE.BufferGeometry; frame: THREE.BufferGeometry } {
  const rings: number[][] = [];
  const n = 32;
  const zs: number[] = [];
  for (let i = 0; i <= 8; i++) zs.push(CANOPY_FRONT_Z + ((WINDSCREEN_BOW_Z - CANOPY_FRONT_Z) * i) / 8);
  for (let i = 1; i <= 26; i++) zs.push(WINDSCREEN_BOW_Z + ((CANOPY_REAR_Z - WINDSCREEN_BOW_Z) * i) / 26);
  for (const z of zs) rings.push(canopyArch(z, n));
  const glass = loftGeometry(rings, { closed: false });

  const f: THREE.BufferGeometry[] = [];
  const add = (gs: THREE.BufferGeometry[], hex = FRAME) => {
    for (const g of gs) f.push(tint(g, hex, 0.55, 0.25));
  };
  // Arch frame (bow) at station z: points round the arch, depth inward, width along z.
  const arch = (z: number, w: number, d: number, from = 0, to = 1, hex = FRAME) => {
    const N = 40;
    const a = canopyArch(z, N);
    const b = canopyArch(z, N, 0.012);
    const pts: THREE.Vector3[] = [];
    const inw: THREE.Vector3[] = [];
    const sd: THREE.Vector3[] = [];
    for (let k = Math.round(from * N); k <= Math.round(to * N); k++) {
      const p = V(a[k * 3], a[k * 3 + 1], a[k * 3 + 2]);
      pts.push(p);
      inw.push(V(b[k * 3], b[k * 3 + 1], b[k * 3 + 2]).sub(p).normalize());
      sd.push(V(0, 0, 1));
    }
    add(bar(pts, sd, inw, w, d, 0.006), hex);
  };
  // The bow: where the windscreen meets the bubble.
  arch(WINDSCREEN_BOW_Z, WINDSCREEN.bowW, WINDSCREEN.bowD);
  // Windscreen base (mostly under the glareshield) and the bubble's aft frame.
  arch(CANOPY_FRONT_Z + 0.06, 0.05, 0.025, 0, 1, FRAME_DARK);
  arch(CANOPY_REAR_Z + 0.05, 0.1, 0.05, 0, 1, FRAME_DARK);
  // Posts: the front panel's edges, from the glareshield up to the bow, on the glass surface.
  for (const s of [-1, 1] as const) {
    const pts: THREE.Vector3[] = [];
    const inw: THREE.Vector3[] = [];
    const sd: THREE.Vector3[] = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      const p = windscreenPost(s, t);
      const along = windscreenPost(s, Math.min(1, t + 0.02)).sub(windscreenPost(s, Math.max(0, t - 0.02))).normalize();
      // Across the surface: step in x at the same z.
      const dx = 0.01 * s;
      const q = V(p.x + dx, canopySurfaceY(p.z, p.x + dx), p.z);
      const across = q.sub(p).normalize();
      let nrm = along.clone().cross(across).normalize();
      if (nrm.dot(V(-p.x, EYE.y - p.y, EYE.z - p.z)) < 0) nrm.negate();
      pts.push(p);
      inw.push(nrm);
      sd.push(nrm.clone().cross(along).normalize());
    }
    add(bar(pts, sd, inw, WINDSCREEN.postW, WINDSCREEN.postD, 0.006));
  }
  // Sill rails along both sides.
  for (const s of [-1, 1]) {
    for (let i = 0; i < 18; i++) {
      const z0 = CANOPY_FRONT_Z + 0.1 + ((CANOPY_REAR_Z - CANOPY_FRONT_Z - 0.1) * i) / 18;
      const z1 = CANOPY_FRONT_Z + 0.1 + ((CANOPY_REAR_Z - CANOPY_FRONT_Z - 0.1) * (i + 1)) / 18;
      const c0 = canopyAt(z0);
      const c1 = canopyAt(z1);
      const p0 = V(s * (c0.w - 0.012), c0.sill + 0.006, z0);
      const p1 = V(s * (c1.w - 0.012), c1.sill + 0.006, z1);
      add(bar([p0, p1], [V(1, 0, 0), V(1, 0, 0)], [V(0, 1, 0), V(0, 1, 0)], 0.05, 0.022, 0.01), FRAME_DARK);
    }
  }
  // Rear-view mirrors on the bow: centre and two either side, angled to the pilot.
  for (const [x, yaw, w] of [[0, 0, 0.1], [-0.2, 0.35, 0.075], [0.2, -0.35, 0.075]] as const) {
    const y = canopySurfaceY(WINDSCREEN_BOW_Z, x) - (x === 0 ? 0.05 : 0.04);
    const c = V(x, y, WINDSCREEN_BOW_Z + 0.03);
    const tiltX = -0.35;
    f.push(tint(box(w, 0.034, 0.012, c, tiltX, yaw, 0), 0x2d3134, 0.6, 0.2));
    const face = box(w - 0.008, 0.027, 0.002, c.clone().add(V(Math.sin(yaw) * 0.007, -Math.sin(tiltX) * 0.007, Math.cos(yaw) * 0.007)), tiltX, yaw, 0);
    f.push(tint(face, 0x8a9094, 0.06, 1));
    f.push(tint(tube(c.clone().add(V(0, 0.018, -0.005)), V(x, y + 0.045, WINDSCREEN_BOW_Z), 0.006, 0.006, 6), 0x2d3134, 0.6, 0.2));
  }
  // Canopy hinge fairing and the rear actuator housing behind the head.
  f.push(tint(box(0.16, 0.08, 0.3, V(0, canopyAt(CANOPY_REAR_Z).top - 0.06, CANOPY_REAR_Z + 0.12)), FRAME_DARK, 0.55, 0.2));
  return { glass, frame: merge(f) };
}

// ─── Interior (vertex colours, lit) ──────────────────────────────────────────

const BLACK = 0x1c1e20;
const DASH_GREY = 0x565f66;
const BEZEL = 0x26292c;
const OSB = 0x8a9095;
const CONSOLE_GREY = 0x4a5157;
const WALL = 0x565e64;
const SEAT_GREEN = 0x3f4636;
const SEAT_FRAME = 0x2b2e2c;

/** Panel-plane box: centre (panel coords, dz of its centre), size (w, h, depth). */
function pbox(x: number, y: number, dz: number, w: number, h: number, d: number): THREE.BufferGeometry {
  return box(w, h, d, panelPoint(x, y, dz), PANEL.tilt, 0, 0);
}

function buildInterior(): THREE.BufferGeometry {
  const g: THREE.BufferGeometry[] = [];
  const T = (geo: THREE.BufferGeometry, hex: number, r = 0.7, m = 0.1) => g.push(tint(geo, hex, r, m));

  // Glareshield: a hood over the dash, its aft lip ~18° below the eye straight ahead.
  const hoodRing = (z: number, top: number, hw: number) => {
    const out: number[] = [];
    const n = 20;
    for (let k = 0; k <= n; k++) {
      const t = -1 + (2 * k) / n;
      out.push(t * hw, top - 0.05 * t * t - 0.06 * t ** 8, z);
    }
    for (let k = n; k >= 0; k--) {
      const t = -1 + (2 * k) / n;
      out.push(t * (hw - 0.01), top - 0.03 - 0.05 * t * t - 0.06 * t ** 8, z);
    }
    return out;
  };
  const G = GLARESHIELD;
  T(loftGeometry([hoodRing(-5.34, 0.77, 0.44), hoodRing(-5.18, 0.835, 0.44), hoodRing(-5.08, 0.862, 0.438), hoodRing(G.z - 0.02, G.y, 0.435), hoodRing(G.z, G.y - 0.015, 0.435)], { closed: true, capStart: true, capEnd: true }), BLACK, 0.92, 0);
  // Rubber edge along the lip (follows the hood's aft section).
  {
    const lip = hoodRing(G.z + 0.002, G.y - 0.001, 0.43);
    for (let k = 0; k < 20; k++) T(tube(V(lip[k * 3], lip[k * 3 + 1], lip[k * 3 + 2]), V(lip[k * 3 + 3], lip[k * 3 + 4], lip[k * 3 + 5]), 0.005, 0.005, 5), 0x121314, 0.9, 0);
  }

  // HUD: housing on the glareshield, the combiner's lower mount and slim side arms.
  const hc = hudCentre();
  const up = V(0, Math.cos(HUD.tilt), Math.sin(HUD.tilt));
  // Housing: a wedge whose top falls away forward, so the view through the glass stays clear.
  {
    const hw = 0.1;
    const za = HUD.z + 0.008;
    const zf = HUD.z - 0.25;
    const yb = G.y - 0.01;
    const c = [
      V(-hw, yb, za), V(hw, yb, za), V(hw, HUD.bottomY, za), V(-hw, HUD.bottomY, za),
      V(-hw, yb, zf), V(hw, yb, zf), V(hw, 0.885, zf), V(-hw, 0.885, zf),
    ];
    T(hexa(c), 0x232629, 0.75, 0.15);
  }
  T(box(0.2, 0.012, 0.026, V(0, HUD.bottomY - 0.004, HUD.z + 0.002)), 0x17191b, 0.6, 0.2);
  for (const s of [-1, 1]) {
    const arm = box(0.006, HUD.h, 0.012, V(0, 0, 0));
    arm.rotateX(HUD.tilt);
    const c = hc.clone().add(V(s * (HUD.w / 2 + 0.003), 0, -0.003));
    arm.translate(c.x, c.y, c.z);
    T(arm, 0x2a2d30, 0.5, 0.4);
    // Arm roots in the housing.
    T(box(0.014, 0.035, 0.03, hc.clone().addScaledVector(up, -HUD.h / 2 - 0.004).add(V(s * (HUD.w / 2 + 0.004), 0, -0.01))), 0x1f2224, 0.6, 0.3);
  }
  // HUD control panel face on the housing's aft side (dark with a few knobs).
  for (const x of [-0.065, -0.035, 0.035, 0.065]) T(tube(V(x, HUD.bottomY - 0.045, HUD.z + 0.008), V(x, HUD.bottomY - 0.045, HUD.z + 0.02), 0.006, 0.006, 10), 0x0e0f10, 0.5, 0.3);

  // Indexer housings either side of the HUD (lamp faces are screen quads), lamp boxes, fire T-handles.
  for (const s of [-1, 1]) T(box(0.026, 0.08, 0.035, V(s * 0.121, G.y + 0.035, G.z - 0.012)), 0x17191a, 0.7, 0.1);
  for (const x of [-0.205, -0.255, 0.205, 0.255]) T(box(0.04, 0.02, 0.04, V(x, G.y + 0.006, G.z - 0.02)), 0x17191a, 0.7, 0.1);
  // Fire T-handles in their wells on the glareshield (L ENG, APU, R ENG).
  for (const x of FIRE_X) {
    const zc = G.z - 0.045;
    T(box(0.08, 0.012, 0.034, V(x, G.y - 0.004, zc)), 0x111213, 0.8, 0.05);
    T(box(0.012, 0.016, 0.012, V(x, G.y + 0.008, zc)), 0x1f1f1f, 0.6, 0.2);
    T(box(0.066, 0.02, 0.022, V(x, G.y + 0.022, zc)), 0xb02818, 0.55, 0.05);
  }

  // Dash body behind the painted face, closing panels to the consoles.
  T(box(PANEL.w, PANEL.h, 0.05, panelPoint(0, 0, -0.026), PANEL.tilt, 0, 0), DASH_GREY, 0.8, 0.05);
  for (const s of [-1, 1]) T(box(0.06, 0.3, 0.1, V(s * 0.47, 0.5, -4.99)), DASH_GREY, 0.8, 0.05);
  // Knee-well below the dash (dark).
  T(box(0.5, 0.02, 0.3, V(0, 0.36, -5.12)), 0x2c3034, 0.9, 0);

  // MFCDs: recessed bezels (frame round the screen), 20 option-select buttons, 4 rockers each.
  for (const s of [-1, 1]) {
    const cx = s * MFCD.x;
    const cy = MFCD.y;
    const B = MFCD.bezel;
    const fw = (B - MFCD.screen) / 2;
    const off = MFCD.screen / 2 + fw / 2;
    T(pbox(cx, cy, 0.004, B, B, 0.008), 0x1a1c1e, 0.7, 0.1);
    T(pbox(cx, cy + off, 0.013, B, fw, 0.01), BEZEL, 0.65, 0.15);
    T(pbox(cx, cy - off, 0.013, B, fw, 0.01), BEZEL, 0.65, 0.15);
    T(pbox(cx + off, cy, 0.013, fw, MFCD.screen, 0.01), BEZEL, 0.65, 0.15);
    T(pbox(cx - off, cy, 0.013, fw, MFCD.screen, 0.01), BEZEL, 0.65, 0.15);
    for (let k = 0; k < 5; k++) {
      const o = (k - 2) * 0.023;
      T(pbox(cx + o, cy + off, 0.02, 0.015, 0.011, 0.006), OSB, 0.55, 0.1);
      T(pbox(cx + o, cy - off, 0.02, 0.015, 0.011, 0.006), OSB, 0.55, 0.1);
      T(pbox(cx + off, cy + o, 0.02, 0.011, 0.015, 0.006), OSB, 0.55, 0.1);
      T(pbox(cx - off, cy + o, 0.02, 0.011, 0.015, 0.006), OSB, 0.55, 0.1);
    }
    for (const [dx, dy] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) T(pbox(cx + dx * off, cy + dy * off, 0.021, 0.02, 0.009, 0.007), 0x4e5358, 0.6, 0.1);
  }
  // UFC surround.
  T(pbox(UFC.x, UFC.y + UFC.h / 2 - 0.004, 0.005, UFC.w, 0.008, 0.01), 0x3e454b, 0.7, 0.1);
  T(pbox(UFC.x, UFC.y - UFC.h / 2 + 0.004, 0.005, UFC.w, 0.008, 0.01), 0x3e454b, 0.7, 0.1);
  // AHCP toggles: bats pointing up or down per their position.
  AHCP_SWITCHES.forEach((sw, k) => {
    const x = ahcpX(k);
    const root = panelPoint(x, AHCP.y - 0.03, 0.002);
    const dir = sw.sel === 0 ? 1 : sw.sel === sw.pos.length - 1 ? -1 : 0;
    const tip = panelPoint(x, AHCP.y - 0.03 + dir * 0.008, 0.022);
    T(tube(root, tip, 0.0032, 0.0022, 8), 0xc9cdd0, 0.3, 0.8);
    T(ellipsoid(tip, 0.0035, 0.0035, 0.0035, 8, 6), 0xd4d7da, 0.3, 0.8);
  });
  // Gauge bezels (short open cylinders proud of the face) and a few knobs.
  const ring = (x: number, y: number, r: number) => T(tube(panelPoint(x, y, 0), panelPoint(x, y, 0.009), r * 1.22, r * 1.18, 24, true), 0x191b1d, 0.6, 0.2);
  for (const k of Object.keys(GAUGE) as (keyof typeof GAUGE)[]) ring(GAUGE[k].x, GAUGE[k].y, GAUGE[k].r);
  ENGINE.rows.forEach((_, i) => {
    for (const x of [ENGINE.x0, ENGINE.x1]) ring(x, ENGINE.y0 + i * ENGINE.dy, ENGINE.r);
  });
  for (const [k, dx, dy] of [['alt', 0.8, -0.8], ['hsi', -0.85, -0.85], ['hsi', 0.85, -0.85], ['adi', 0.85, -0.85], ['sai', 0.8, -0.8], ['clock', 0.8, -0.8]] as const) {
    const gg = GAUGE[k];
    T(tube(panelPoint(gg.x + dx * gg.r * 1.25, gg.y + dy * gg.r * 1.25, 0), panelPoint(gg.x + dx * gg.r * 1.25, gg.y + dy * gg.r * 1.25, 0.016), 0.0065, 0.0065, 10), 0x121314, 0.5, 0.2);
  }
  // Landing gear handle: slot, lever and the wheel-shaped knob (its lamp is a screen quad).
  T(pbox(GEAR.handleX, GEAR.handleY, 0.002, 0.016, 0.085, 0.004), 0x121314, 0.8, 0);
  const lever0 = panelPoint(GEAR.handleX, GEAR.handleY + 0.025, 0.002);
  const lever1 = panelPoint(GEAR.handleX, GEAR.handleY + 0.025, 0.07);
  T(tube(lever0, lever1, 0.006, 0.006, 8), 0xa7abae, 0.35, 0.8);
  T(tube(lever1, lever1.clone().addScaledVector(PANEL_N, 0.016), 0.024, 0.024, 20), 0xdcdcd2, 0.45, 0.05);

  // Side consoles: bodies (their tops are painted quads), sidewalls up to the sills, throttle quadrant.
  const cw = CONSOLE.xOut - CONSOLE.xIn;
  const cl = CONSOLE.zBack - CONSOLE.zFront;
  for (const s of [-1, 1]) {
    const cx = s * (CONSOLE.xIn + cw / 2);
    T(box(cw, 0.2, cl, V(cx, CONSOLE.y - 0.1 - 0.002, (CONSOLE.zFront + CONSOLE.zBack) / 2)), CONSOLE_GREY, 0.8, 0.05);
    T(box(0.01, 0.2, cl, V(s * (CONSOLE.xIn + 0.005), CONSOLE.y - 0.1, (CONSOLE.zFront + CONSOLE.zBack) / 2)), 0x3b4146, 0.8, 0.05);
    T(box(0.03, 0.14, 2.1, V(s * 0.505, 0.62, -4.2)), WALL, 0.85, 0.02);
    // Wall stiffeners / cable runs.
    for (let k = 0; k < 6; k++) T(box(0.01, 0.12, 0.02, V(s * 0.488, 0.62, -4.95 + k * 0.3)), 0x464d52, 0.8, 0.05);
  }
  // Throttle quadrant housing on the left console (the levers are the separate `throttle` mesh).
  T(box(0.12, 0.05, 0.3, V(THROTTLE.pivot.x, CONSOLE.y + 0.02, THROTTLE.pivot.z)), 0x3a3f44, 0.75, 0.1);
  for (const dx of [-0.022, 0.022]) T(box(0.012, 0.004, 0.24, V(THROTTLE.pivot.x + dx, CONSOLE.y + 0.046, THROTTLE.pivot.z)), 0x0c0d0e, 0.9, 0);
  // Stick boot on the floor (the stick itself moves).
  T(tube(V(STICK.pivot.x, 0.09, STICK.pivot.z), V(STICK.pivot.x, STICK.pivot.y + 0.06, STICK.pivot.z), 0.08, 0.03, 14), 0x191a1b, 0.95, 0);

  // ACES II seat: bucket, cushions, back, headrest with the canopy breakers, parachute container,
  // side rails, the yellow/black ejection handles. Rounded pads; the head sits just ahead of the headrest.
  const rec = -13 * DEG;
  const rbox = (w: number, h: number, d: number, r: number, c: THREE.Vector3, rx = 0) => {
    const b = new RoundedBoxGeometry(w, h, d, 2, r);
    if (rx) b.rotateX(rx);
    b.translate(c.x, c.y, c.z);
    return b;
  };
  // Along the seat back (reclined 13°): a point `up` metres up the back and `fwd` in front of its face.
  const backAt = (up: number, fwd: number) => V(0, 0.36 + up * Math.cos(rec), -4.08 + up * Math.sin(-rec) - fwd);
  T(rbox(0.46, 0.09, 0.5, 0.02, V(0, 0.28, -4.28)), SEAT_FRAME, 0.8, 0.1);
  T(rbox(0.4, 0.07, 0.44, 0.03, V(0, 0.345, -4.3)), SEAT_GREEN, 0.95, 0);
  for (const s of [-1, 1]) {
    T(rbox(0.045, 0.36, 0.54, 0.012, V(s * 0.265, 0.37, -4.22)), SEAT_FRAME, 0.75, 0.15);
    // Side rails up the back to the headrest.
    T(box(0.032, 0.92, 0.055, backAt(0.46, -0.03).add(V(s * 0.235, 0, 0)), rec, 0, 0), 0x3a3f3b, 0.65, 0.25);
    // Ejection handles (striped loops on the seat sides).
    for (let k = 0; k < 4; k++) {
      const a = V(s * 0.225, 0.36 + k * 0.015, -4.52 + k * 0.012);
      T(tube(a, a.clone().add(V(0, 0.015, 0.012)), 0.012, 0.012, 8), k % 2 ? 0x161616 : 0xe0b822, 0.5, 0);
    }
  }
  // Back cushion, parachute container behind the shoulders, headrest pad and the top of the seat.
  T(rbox(0.42, 0.62, 0.08, 0.03, backAt(0.34, 0.02), rec), SEAT_GREEN, 0.95, 0);
  T(rbox(0.46, 0.46, 0.2, 0.05, backAt(0.72, -0.1), rec), 0x4a503f, 0.9, 0);
  T(rbox(0.3, 0.22, 0.07, 0.03, backAt(0.86, 0.05), rec), 0x3a4033, 0.95, 0);
  T(rbox(0.3, 0.06, 0.2, 0.02, backAt(1.02, -0.05), rec), 0x262927, 0.7, 0.2);
  for (const s of [-1, 1]) T(tube(backAt(1.04, -0.02).add(V(s * 0.1, 0, 0)), backAt(1.12, -0.02).add(V(s * 0.1, 0, 0)), 0.012, 0.003, 8), 0x9a9da0, 0.4, 0.8);
  T(box(0.2, 0.05, 0.012, backAt(0.62, 0.105), rec, 0, 0), 0xd8c01e, 0.6, 0);
  // Rudder pedals, floor, aft bulkhead / avionics behind the seat.
  for (const s of [-1, 1]) {
    T(box(0.1, 0.17, 0.03, V(s * 0.15, 0.22, -5.2), -0.5, 0, 0), 0x3a3d40, 0.6, 0.3);
    T(tube(V(s * 0.15, 0.14, -5.25), V(s * 0.15, 0.14, -5.35), 0.012, 0.012, 6), 0x2a2c2e, 0.6, 0.3);
  }
  T(box(0.84, 0.03, 2.1, V(0, 0.09, -4.2)), 0x2c3033, 0.9, 0);
  T(box(0.9, 0.7, 0.05, V(0, 0.8, -3.1)), 0x2e3235, 0.85, 0);
  return merge(g);
}

// ─── Moving parts ────────────────────────────────────────────────────────────

const GLOVE = 0x4d4a3c;

function buildStick(): THREE.BufferGeometry {
  const g: THREE.BufferGeometry[] = [];
  // Local frame: origin at the pivot; the grip ~0.55 m up and a little aft.
  const top = V(0, 0.5, -0.04);
  g.push(tint(tube(V(0, 0, 0), top, 0.017, 0.014, 10), 0x1a1b1c, 0.5, 0.3));
  // Grip: flattened, raked forward, with the trim hat, trigger, weapon release and pinky switch.
  const gb = top.clone();
  const grip = new RoundedBoxGeometry(0.036, 0.11, 0.046, 2, 0.014);
  grip.rotateX(0.18);
  grip.translate(gb.x, gb.y + 0.055, gb.z - 0.008);
  g.push(tint(grip, 0x202122, 0.75, 0.05));
  const head = gb.clone().add(V(0, 0.112, -0.02));
  g.push(tint(tube(head.clone().add(V(0, 0, 0.012)), head.clone().add(V(0, 0.012, 0.018)), 0.006, 0.005, 8), 0x3c3d3e, 0.5, 0.3));
  g.push(tint(box(0.009, 0.007, 0.009, head.clone().add(V(-0.012, 0.004, 0.012))), 0x8a2a1c, 0.5, 0.1));
  g.push(tint(box(0.014, 0.022, 0.008, gb.clone().add(V(0, 0.08, -0.036))), 0x151515, 0.6, 0.2));
  // The pilot's right glove round the grip (fingers forward, thumb on top).
  const glove = new RoundedBoxGeometry(0.056, 0.075, 0.07, 2, 0.022);
  glove.rotateX(0.18);
  glove.translate(gb.x + 0.006, gb.y + 0.05, gb.z - 0.004);
  g.push(tint(glove, GLOVE, 0.85, 0));
  return merge(g);
}

function buildThrottle(): THREE.BufferGeometry {
  const g: THREE.BufferGeometry[] = [];
  // Two levers side by side (local origin at the quadrant pivot), joined grips on top.
  for (const dx of [-0.022, 0.022]) g.push(tint(box(0.012, 0.13, 0.016, V(dx, 0.065, 0)), 0x2a2b2c, 0.5, 0.35));
  g.push(tint(box(0.036, 0.07, 0.085, V(-0.022, 0.15, -0.01)), 0x1b1c1d, 0.7, 0.05));
  g.push(tint(box(0.036, 0.062, 0.075, V(0.022, 0.146, -0.008)), 0x1b1c1d, 0.7, 0.05));
  // Switches on the grips (speed brake, boat switch, china hat, mic).
  g.push(tint(box(0.01, 0.01, 0.018, V(-0.04, 0.162, -0.03)), 0x505254, 0.5, 0.3));
  g.push(tint(box(0.012, 0.008, 0.012, V(0.022, 0.18, -0.03)), 0x505254, 0.5, 0.3));
  g.push(tint(tube(V(-0.022, 0.185, -0.035), V(-0.022, 0.195, -0.035), 0.006, 0.004, 8), 0x3a3b3c, 0.5, 0.3));
  // The pilot's left glove on the grips.
  const glove = new RoundedBoxGeometry(0.06, 0.06, 0.08, 2, 0.022);
  glove.translate(-0.02, 0.165, 0.004);
  g.push(tint(glove, GLOVE, 0.85, 0));
  return merge(g);
}

// ─── The pilot ───────────────────────────────────────────────────────────────

function buildPilot(): { body: THREE.BufferGeometry; head: THREE.BufferGeometry } {
  const SUIT = 0x5b6150;
  const VEST = 0x3b3e30;
  const GSUIT = 0x61604c;
  const b: THREE.BufferGeometry[] = [];
  const hip = V(0, 0.4, -4.25);
  const neck = V(0, 0.93, -4.12);
  b.push(tint(tube(hip, neck, 0.16, 0.15, 14), SUIT, 0.9, 0));
  b.push(tint(tube(V(0, 0.58, -4.21), V(0, 0.9, -4.13), 0.178, 0.162, 14), VEST, 0.85, 0));
  for (const s of [-1, 1]) {
    const sh = V(s * 0.19, 0.86, -4.13);
    const el = V(s * 0.25, 0.62, -4.3);
    // Wrists end at the stick grip / throttle grips (the gloves are on those meshes).
    const hand = s > 0 ? V(0.03, 0.64, -4.6) : V(-0.37, 0.72, -4.45);
    b.push(tint(ellipsoid(sh, 0.075, 0.07, 0.075, 10, 8), VEST, 0.85, 0));
    b.push(tint(tube(sh, el, 0.055, 0.048, 10), SUIT, 0.9, 0));
    b.push(tint(tube(el, hand, 0.046, 0.038, 10), SUIT, 0.9, 0));
    b.push(tint(tube(V(s * 0.1, 0.9, -4.14), V(s * 0.08, 0.5, -4.3), 0.022, 0.022, 6), 0x2f2f28, 0.8, 0));
    const hipS = V(s * 0.11, 0.38, -4.3);
    const knee = V(s * 0.14, 0.5, -4.78);
    const foot = V(s * 0.15, 0.2, -5.15);
    b.push(tint(tube(hipS, knee, 0.075, 0.062, 12), GSUIT, 0.9, 0));
    b.push(tint(ellipsoid(knee, 0.064, 0.064, 0.064, 12, 8), GSUIT, 0.9, 0));
    b.push(tint(tube(knee, foot, 0.055, 0.046, 12), SUIT, 0.9, 0));
    b.push(tint(box(0.09, 0.07, 0.24, V(s * 0.15, 0.2, -5.2)), 0x1c1b19, 0.8, 0));
  }

  const h: THREE.BufferGeometry[] = [];
  // Oxygen hose from the mask down to the chest (with the head: hidden in the cockpit view).
  h.push(tint(tube(V(0.03, 0.99, -4.36), V(0.1, 0.78, -4.26), 0.018, 0.018, 8), 0x202020, 0.7, 0));
  const hc = V(0, EYE.y + 0.06, EYE.z + 0.095);
  h.push(tint(ellipsoid(hc, 0.135, 0.145, 0.155, 20, 14), 0x7f8386, 0.45, 0.05));
  const visor = new THREE.SphereGeometry(1, 20, 12, Math.PI * 0.62, Math.PI * 0.76, Math.PI * 0.28, Math.PI * 0.3);
  visor.scale(0.142, 0.152, 0.164);
  visor.translate(hc.x, hc.y, hc.z);
  h.push(tint(visor, 0x0c0c0e, 0.06, 0.4));
  h.push(tint(ellipsoid(V(0, EYE.y - 0.07, EYE.z - 0.04), 0.06, 0.065, 0.06, 12, 8), 0x2a2e25, 0.7, 0));
  h.push(tint(tube(V(0, hc.y + 0.12, hc.z - 0.1), V(0, hc.y + 0.15, hc.z + 0.02), 0.03, 0.03, 8), 0x55585a, 0.5, 0.1));
  return { body: merge(b), head: merge(h) };
}

// ─── Painted and lit faces ───────────────────────────────────────────────────

/** The lit painted faces: the dash (top half of the panel canvas) and the console tops. */
function buildPanelFaces(): THREE.BufferGeometry {
  const W = PANEL_CANVAS.width;
  const H = PANEL_CANVAS.height;
  const faces: THREE.BufferGeometry[] = [panelRect(0, 0, PANEL.w, PANEL.h, 0.0015, uvRect(0, 0, 1024, 512, W, H))];
  for (const side of ['left', 'right'] as const) {
    const s = side === 'left' ? -1 : 1;
    const row = CONSOLE_ROW[side];
    // Corners: u (across, to the pilot's right) and w (aft) → canvas X = w, Y = row + (wid − u).
    const xL = side === 'left' ? -CONSOLE.xOut : CONSOLE.xIn;
    const xR = side === 'left' ? -CONSOLE.xIn : CONSOLE.xOut;
    const y = CONSOLE.y;
    const v0 = 1 - (row + CONSOLE_PX) / H; // u = 0 (left edge)
    const v1 = 1 - row / H; // u = wid (right edge)
    const g = new THREE.BufferGeometry();
    const zf = CONSOLE.zFront;
    const zb = CONSOLE.zBack;
    g.setAttribute('position', new THREE.Float32BufferAttribute([xL, y, zf, xR, y, zf, xR, y, zb, xL, y, zb], 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, v0, 0, v1, 1, v1, 1, v0], 2));
    g.setIndex([0, 2, 1, 0, 3, 2]);
    void s;
    faces.push(g);
  }
  return merge(faces.map((f) => tint(f, 0xffffff, 0.75, 0)));
}

/** Where each lamp face sits (body frame corners). */
function lampQuads(): { id: LampId; geo: THREE.BufferGeometry }[] {
  const out: { id: LampId; geo: THREE.BufferGeometry }[] = [];
  const W = SCREEN_CANVAS.width;
  const H = SCREEN_CANVAS.height;
  const uvOf = (id: LampId) => {
    const c = lampCell(LAMP[id]);
    return uvRect(c.x, c.y, c.w, c.h, W, H);
  };
  // Gear lights on the dash.
  (['gearNose', 'gearLeft', 'gearRight'] as const).forEach((id, i) => out.push({ id, geo: panelRect(GEAR.lights[i][0], GEAR.lights[i][1], 0.018, 0.016, 0.003, uvOf(id)) }));
  // The gear handle's knob lamp (on the knob face).
  {
    const c = panelPoint(GEAR.handleX, GEAR.handleY + 0.025, 0.087);
    const x = V(1, 0, 0).multiplyScalar(0.012);
    const y = V(0, Math.cos(PANEL.tilt), Math.sin(PANEL.tilt)).multiplyScalar(0.012);
    out.push({ id: 'gearHandle', geo: quad4(c.clone().sub(x).sub(y), c.clone().add(x).sub(y), c.clone().add(x).add(y), c.clone().sub(x).add(y), uvOf('gearHandle')) });
  }
  const G = GLARESHIELD;
  // Glareshield-top lamps, faced up/aft toward the eye.
  const topLamp = (id: LampId, x: number, w: number, h: number) => {
    const c = V(x, G.y + 0.0165, G.z - 0.02);
    const toEye = V(EYE.x - x, EYE.y - c.y, EYE.z - c.z).normalize();
    const right = V(1, 0, 0);
    const upv = toEye.clone().cross(right).normalize();
    const a = c.clone().addScaledVector(right, -w / 2).addScaledVector(upv, -h / 2);
    const b = c.clone().addScaledVector(right, w / 2).addScaledVector(upv, -h / 2);
    const cc = c.clone().addScaledVector(right, w / 2).addScaledVector(upv, h / 2);
    const d = c.clone().addScaledVector(right, -w / 2).addScaledVector(upv, h / 2);
    out.push({ id, geo: quad4(a, b, cc, d, uvOf(id)) });
  };
  topLamp('gunReady', -0.255, 0.034, 0.034);
  topLamp('masterCaution', -0.205, 0.034, 0.034);
  topLamp('nws', 0.205, 0.034, 0.034);
  topLamp('canopy', 0.255, 0.034, 0.034);
  // Indexers: three lamps stacked on each housing's aft face.
  const idx = (ids: LampId[], x: number) =>
    ids.forEach((id, k) => {
      const c = V(x, G.y + 0.06 - k * 0.024, G.z + 0.0065);
      const w = 0.02;
      const h = 0.02;
      out.push({ id, geo: quad4(c.clone().add(V(-w / 2, -h / 2, 0)), c.clone().add(V(w / 2, -h / 2, 0)), c.clone().add(V(w / 2, h / 2, 0)), c.clone().add(V(-w / 2, h / 2, 0)), uvOf(id)) });
    });
  idx(['aoaHigh', 'aoaOn', 'aoaLow'], -0.121);
  idx(['refuelReady', 'refuelLatched', 'refuelDisc'], 0.121);
  // Fire handles: a lamp strip on each handle's aft face.
  (['fireL', 'fireApu', 'fireR'] as const).forEach((id, k) => {
    const c = V(FIRE_X[k], G.y + 0.022, G.z - 0.045 + 0.0115);
    const hw = 0.026;
    const hh = 0.008;
    out.push({ id, geo: quad4(c.clone().add(V(-hw, -hh, 0)), c.clone().add(V(hw, -hh, 0)), c.clone().add(V(hw, hh, 0)), c.clone().add(V(-hw, hh, 0)), uvOf(id)) });
  });
  // Marker beacon lamp on the dash (right of the UFC).
  out.push({ id: 'marker', geo: panelRect(0.135, 0.19, 0.03, 0.018, 0.003, uvOf('marker')) });
  return out;
}

/** Unlit faces: the two MFCD screens, the lamp faces, the CDU display. */
function buildScreens(): THREE.BufferGeometry {
  const W = SCREEN_CANVAS.width;
  const H = SCREEN_CANVAS.height;
  const q: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) q.push(panelRect(s * MFCD.x, MFCD.y, MFCD.screen, MFCD.screen, 0.009, uvRect(s < 0 ? 0 : 512, 0, 512, 512, W, H)));
  for (const l of lampQuads()) q.push(l.geo);
  // CDU display at the front of the right console, raised and tilted toward the pilot.
  {
    const x0 = CONSOLE.xIn + 0.012;
    const x1 = CONSOLE.xOut - 0.012;
    const z0 = CONSOLE.zFront + 0.015;
    const z1 = z0 + (x1 - x0) * (CDU_RECT.h / CDU_RECT.w);
    const y = CONSOLE.y + 0.0015;
    const g = quad4(V(x0, y, z1), V(x1, y, z1), V(x1, y, z0), V(x0, y, z0), uvRect(CDU_RECT.x, CDU_RECT.y, CDU_RECT.w, CDU_RECT.h, W, H));
    q.push(g);
  }
  return merge(q.map((g) => tint(g, 0xffffff, 0.2, 0)));
}

export function buildCockpit(): CockpitBuild {
  const canopy = buildCanopy();
  const pilot = buildPilot();
  const hud = tint(new THREE.PlaneGeometry(HUD.w, HUD.h), 0xffffff, 0.05, 0);
  return {
    canopyGlass: canopy.glass,
    canopyFrame: canopy.frame,
    interior: buildInterior(),
    pilotBody: pilot.body,
    pilotHead: pilot.head,
    hudGlass: hud,
    hudPosition: hudCentre(),
    screens: buildScreens(),
    panelFace: buildPanelFaces(),
    stick: buildStick(),
    throttle: buildThrottle(),
  };
}

/** Stick angles (rad) from the controls: aft with + elevator, right with + aileron. */
export function stickAngles(elevator: number, aileron: number): { pitch: number; roll: number } {
  const f = (v: number) => (Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0);
  return { pitch: f(elevator) * STICK.pitchDeg * DEG, roll: -f(aileron) * STICK.rollDeg * DEG };
}

/** Throttle lever angle (rad about +X; + = aft) from the throttle percentage. */
export function throttleAngle(pct: number): number {
  const t = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) / 100 : 0;
  return (THROTTLE.idleDeg + (THROTTLE.maxDeg - THROTTLE.idleDeg) * t) * DEG;
}
