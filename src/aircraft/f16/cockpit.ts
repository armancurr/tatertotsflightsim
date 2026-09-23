/**
 * F-16C Block 50 cockpit, built in code: the one-piece frameless bubble canopy (sill rails and the
 * aft bow behind the seat), the sculpted glareshield ("hood"), the wide-angle HUD on its mount with
 * the combiner glass, the Integrated Control Panel (ICP) under it and the DED below, the main
 * instrument panel bent around the pilot (centre pedestal + two wings with the MFDs), the left
 * auxiliary panel with the gear handle, the side consoles (left: throttle quadrant with the F110
 * throttle grip; right: the side-stick controller and its armrest), the ACES II seat reclined 30°
 * and the pilot.
 *
 * Meshes (index.ts): `interior` (big shapes, both views), `detail` (knobs, keys, bezels, stick,
 * throttle, the cockpit-view pilot; cockpit view only), `panelFace` (quads textured from the static
 * cockpit atlas painted by cockpitPaint.ts), `live` (quads textured from the live instrument canvas;
 * cockpit view only), the HUD glass (`hudCombiner`), the canopy glass and frame, and the outside
 * pilot. Layout constants are shared with the painter so the paint lines up with the relief.
 *
 * Moving parts without extra draw calls: in `detail`, the uv attribute carries motion weights read
 * by the detail material's vertex shader (materials.ts): uv.x ∈ [0, 1] × throttle offset, uv.x ∈
 * [2, 3] × gear-handle offset, uv.y ∈ [0, 1] × stick offset, uv.y ∈ [2, 3] × landing-light switch.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { loftGeometry } from '../loft';
import { tint, merge } from '../materials';
import { box, ellipsoid, tube, V } from './geom';
import { ANCHOR, CANOPY_FRONT_Z, CANOPY_REAR_Z, canopyArch, canopyAt } from './shape';

const DEG = Math.PI / 180;
const EYE = ANCHOR.eye;

/** Cockpit colours (sRGB). FS 36231 dark gull grey panels and consoles, flat black glareshield. */
export const PIT = {
  gull: 0x505558,
  gullDark: 0x424649,
  gullLight: 0x6d7275,
  shield: 0x1d1e20,
  black: 0x121314,
  bezel: 0x242628,
  knob: 0x161616,
  frame: 0x34383b,
  seat: 0x3a3d35,
  cushion: 0x4f5240,
} as const;

// ─── HUD ─────────────────────────────────────────────────────────────────────

/**
 * The HUD combiner glass (F-16C wide-angle HUD): a flat pane leaning aft 16°, sized so that from
 * the design eye it spans ~25° wide and from +7.4° above the boresight down to −13.8°, where its
 * bottom edge meets the top rear edge of the ICP housing (the limit of the view over the nose). The mesh's local frame is
 * the glass plane (x right, y up, z = 0), so the HUD overlay can project its 4 corners (src/ui/hudGlass.ts).
 */
export const HUD_COMBINER = { cx: 0, cy: 0.955, cz: -5.0263, tilt: 0.28, w: 0.29, h: 0.2444 } as const;

/** Local glass plane → model space (the combiner mesh's transform). */
export function combinerMatrix(): THREE.Matrix4 {
  const c = HUD_COMBINER;
  return new THREE.Matrix4().compose(new THREE.Vector3(c.cx, c.cy, c.cz), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), c.tilt), new THREE.Vector3(1, 1, 1));
}

/**
 * The ICP housing under the HUD: a box leaning back so its face looks up at the pilot. Its top rear
 * edge is the highest thing on the centreline between the eye and the nose (the over-the-nose view).
 */
export const ICP = { w: 0.215, h: 0.125, d: 0.07, tilt: -13 * DEG, cy: 0.775, cz: -5.055 } as const;

/** ICP face frame: x right, y up, z out of the face (toward the pilot), origin at the face centre. */
export function icpFrame(x = 0, y = 0, dz = 0, out = new THREE.Matrix4()): THREE.Matrix4 {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), ICP.tilt);
  const p = new THREE.Vector3(x, y, ICP.d / 2 + dz).applyQuaternion(q).add(new THREE.Vector3(0, ICP.cy, ICP.cz));
  return out.makeRotationFromQuaternion(q).setPosition(p);
}

/** ICP keys (face coordinates, m) with their legends (painted on the key caps). */
export const ICP_KEYS: { x: number; y: number; w: number; h: number; top: string; bottom?: string; kind?: 'mode' | 'func' }[] = (() => {
  const keys: { x: number; y: number; w: number; h: number; top: string; bottom?: string; kind?: 'mode' | 'func' }[] = [];
  const pad: [string, string?][] = [['1', 'T-ILS'], ['2', 'ALOW'], ['3'], ['4', 'STPT'], ['5', 'CRUS'], ['6', 'TIME'], ['7', 'MARK'], ['8', 'FIX'], ['9', 'A-CAL'], ['RCL'], ['0', 'M-SEL'], ['ENTR']];
  pad.forEach(([t, b], k) => keys.push({ x: -0.056 + (k % 3) * 0.024, y: 0.036 - Math.floor(k / 3) * 0.022, w: 0.019, h: 0.017, top: t, bottom: b }));
  [['COM', '1'], ['COM', '2'], ['IFF'], ['LIST']].forEach(([t, b], k) => keys.push({ x: 0.0 + (k % 2) * 0.024, y: 0.036 - Math.floor(k / 2) * 0.022, w: 0.019, h: 0.017, top: t, bottom: b, kind: 'func' }));
  keys.push({ x: 0.0, y: -0.012, w: 0.019, h: 0.017, top: 'A-A', kind: 'mode' });
  keys.push({ x: 0.024, y: -0.012, w: 0.019, h: 0.017, top: 'A-G', kind: 'mode' });
  return keys;
})();

// ─── Instrument panel ────────────────────────────────────────────────────────

/**
 * The main instrument panel: a centre pedestal (|x| ≤ fold) raked back `tilt`, and two wings turned
 * `wingYaw` toward the pilot. Panel coordinates: x right (m, along the bent face), y up (m, 0 at the
 * top edge under the glareshield, negative downward).
 */
export const PANEL = { topY: 0.79, topZ: -5.09, tilt: 16 * DEG, fold: 0.13, wingYaw: 17 * DEG, halfWidth: 0.44, depth: 0.44 } as const;

const _q = new THREE.Quaternion();
/** Frame on the panel face at (xp, yp), dz out of the face: x along the face, y up it, z toward the pilot. */
export function panelFrame(xp: number, yp: number, dz = 0, out = new THREE.Matrix4()): THREE.Matrix4 {
  const c = Math.cos(PANEL.tilt);
  const s = Math.sin(PANEL.tilt);
  const ey = V(0, c, -s);
  const ex = V(1, 0, 0);
  const o = V(0, PANEL.topY, PANEL.topZ);
  let d = xp;
  if (Math.abs(xp) > PANEL.fold) {
    const side = Math.sign(xp);
    o.x = side * PANEL.fold;
    ex.applyQuaternion(_q.setFromAxisAngle(ey, -side * PANEL.wingYaw));
    d = xp - side * PANEL.fold;
  }
  const ez = new THREE.Vector3().crossVectors(ex, ey);
  o.addScaledVector(ex, d).addScaledVector(ey, yp).addScaledVector(ez, dz);
  return out.makeBasis(ex, ey, ez).setPosition(o);
}

/** Body-space point on the panel. */
export function panelPoint(xp: number, yp: number, dz = 0): THREE.Vector3 {
  return new THREE.Vector3().setFromMatrixPosition(panelFrame(xp, yp, dz));
}

/** Glareshield lip: height of its top edge above body x (the hood drops toward the sills). */
export function lipY(x: number): number {
  const a = Math.abs(x);
  return a <= 0.2 ? 0.806 : 0.806 - 0.19 * ((a - 0.2) / 0.245) ** 2;
}
/** Panel top edge (panel y) at panel x: tucked 3 cm under the glareshield lip. */
export function panelTopYp(xp: number): number {
  const x3 = Math.abs(xp) <= PANEL.fold ? xp : Math.sign(xp) * (PANEL.fold + (Math.abs(xp) - PANEL.fold) * Math.cos(PANEL.wingYaw));
  return Math.min(0, (lipY(x3) - 0.03 - PANEL.topY) / Math.cos(PANEL.tilt));
}

/** A round instrument on the panel (panel coordinates, face radius). */
export interface Gauge {
  x: number;
  y: number;
  r: number;
}
/** What sits where on the panel (panel coordinates, m). Shared by the geometry and the painter. */
export const LAYOUT = {
  mfd: [
    { x: -0.237, y: -0.152 },
    { x: 0.237, y: -0.152 },
  ],
  mfdBezel: 0.17,
  mfdScreen: 0.106,
  ded: { x: 0, y: -0.125, w: 0.1, h: 0.03 },
  gauges: {
    airspeed: { x: -0.087, y: -0.207, r: 0.033 },
    adi: { x: 0, y: -0.207, r: 0.04 },
    altimeter: { x: 0.087, y: -0.207, r: 0.033 },
    sai: { x: -0.087, y: -0.296, r: 0.03 },
    hsi: { x: 0, y: -0.3, r: 0.04 },
    vvi: { x: 0.087, y: -0.296, r: 0.03 },
    rwr: { x: 0.39, y: -0.205, r: 0.036 },
    fuel: { x: 0.237, y: -0.292, r: 0.034 },
    ftit: { x: 0.345, y: -0.29, r: 0.024 },
    rpm: { x: 0.405, y: -0.29, r: 0.024 },
    noz: { x: 0.345, y: -0.345, r: 0.022 },
    oil: { x: 0.405, y: -0.345, r: 0.022 },
  } satisfies Record<string, Gauge>,
  /** Lit legends (x, y centre, w, h). */
  masterCaution: { x: -0.39, y: -0.2, w: 0.046, h: 0.026 },
  tfFail: { x: -0.39, y: -0.235, w: 0.046, h: 0.02 },
  /** Left auxiliary console (the gear panel), below the left MFD. */
  gearPanel: { x0: -0.44, x1: -0.2, y0: -0.25, y1: -0.4 },
  gearHandle: { x: -0.37, y: -0.315 },
  gearLights: [
    { x: -0.275, y: -0.275 },
    { x: -0.3, y: -0.305 },
    { x: -0.25, y: -0.305 },
  ],
  landingSwitch: { x: -0.26, y: -0.365 },
  hookSwitch: { x: -0.425, y: -0.37 },
  /** Panel outline bottoms: centre pedestal and right wing; the left wing ends at the gear panel. */
  bottom: { centre: -0.4, wing: -0.37 },
} as const;

/** Glareshield-mounted lit panels: the AOA indexer + TF FAIL (left), warning lights + AR/NWS indexer (right). */
export const EYEBROW = {
  left: { x: -0.155, w: 0.05, h: 0.034 },
  right: { x: 0.165, w: 0.07, h: 0.04 },
} as const;
/** Eyebrow panel frame: centred on the glareshield near the lip, facing the pilot. */
export function eyebrowFrame(x: number, h: number, out = new THREE.Matrix4()): THREE.Matrix4 {
  const y = lipY(x) + h / 2 - 0.004;
  const z = hoodLipZ(x) - 0.05;
  const face = new THREE.Vector3(0, 1.0, EYE.z).sub(new THREE.Vector3(x, y, z)).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), face);
  return out.makeRotationFromQuaternion(q).setPosition(x, y, z);
}

/** Side consoles: top height, inner/outer edges, fore/aft extent. */
export const CONSOLE = { top: 0.405, inner: 0.27, outer: 0.452, z0: -5.0, z1: -3.95 } as const;
/** Side-stick base (right console) and throttle (left console) at the build position. */
export const STICK = { x: 0.365, z: -4.7, height: 0.14 } as const;
export const THROTTLE = { x: -0.37, zIdle: -4.42, travel: 0.17, build: 0.5 } as const;

/** Glareshield lip z at body x: overhangs the panel's top edge by 4.5 cm. */
export function hoodLipZ(x: number): number {
  return PANEL.topZ + Math.max(0, Math.abs(x) - PANEL.fold) * Math.tan(PANEL.wingYaw) + 0.045;
}

/** Canopy inner surface height at body (x, z), or the sill if x is outside the arch. */
export function canopyInnerY(x: number, z: number): number {
  const c = canopyAt(z);
  const a = Math.abs(x) / Math.max(0.001, c.w);
  if (a >= 1) return c.sill;
  const cs = a ** (2.25 / 2);
  const sn = Math.sqrt(Math.max(0, 1 - cs * cs));
  return c.sill + (c.top - c.sill) * sn ** (2 / 2.1);
}

// ─── Build helpers ───────────────────────────────────────────────────────────

const M4 = () => new THREE.Matrix4();
/** Rounded box centred at c, turned rx about x (cushions, the seat's headrest). */
function rbox(w: number, h: number, d: number, c: THREE.Vector3, rx: number, radius: number): THREE.BufferGeometry {
  const g = new RoundedBoxGeometry(w, h, d, 3, radius);
  g.rotateX(rx);
  g.translate(c.x, c.y, c.z);
  return g;
}
/** Box in a local frame. */
function fbox(F: THREE.Matrix4, w: number, h: number, d: number, x: number, y: number, z: number, hex: number, rough: number, metal = 0): THREE.BufferGeometry {
  return tint(box(w, h, d, V(x, y, z)).applyMatrix4(F), hex, rough, metal);
}
/** Cylinder along the local z (out of the face) in a local frame. */
function fcyl(F: THREE.Matrix4, r0: number, r1: number, z0: number, z1: number, x: number, y: number, hex: number, rough: number, segs = 16, open = false, metal = 0): THREE.BufferGeometry {
  return tint(tube(V(x, y, z0), V(x, y, z1), r0, r1, segs, open).applyMatrix4(F), hex, rough, metal);
}
/** Prism across x (x0 → x1) of a (z, y) profile, flat shaded (hard edges). */
function prismX(profile: [number, number][], x0: number, x1: number): THREE.BufferGeometry {
  const shape = new THREE.Shape(profile.map(([z, y]) => new THREE.Vector2(z, y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: x1 - x0, bevelEnabled: false });
  // Shape (u, v) = (z, y); extrusion along local +z → body −x (a right-handed basis), then shift.
  g.applyMatrix4(new THREE.Matrix4().makeBasis(V(0, 0, 1), V(0, 1, 0), V(-1, 0, 0)));
  g.translate(x1, 0, 0);
  // ExtrudeGeometry is non-indexed: recomputed normals are per face (hard edges).
  g.computeVertexNormals();
  return g;
}

/** Quad textured from an atlas rect (canvas px, top-left origin) of an atlas of size aw × ah. */
export function atlasQuad(F: THREE.Matrix4, w: number, h: number, x: number, y: number, dz: number, rect: readonly [number, number, number, number], aw: number, ah: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const [px0, py0, px1, py1] = rect;
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i);
    const v = uv.getY(i);
    uv.setXY(i, (px0 + (px1 - px0) * u) / aw, 1 - (py1 + (py0 - py1) * v) / ah);
  }
  g.translate(x, y, dz);
  g.applyMatrix4(F);
  return tint(g, 0xffffff, 0.7, 0);
}

const MOVING = new WeakSet<THREE.BufferGeometry>();
/** Set the motion weights (see the header) of a detail part. */
function moving(g: THREE.BufferGeometry, wx: (p: THREE.Vector3) => number, wy: (p: THREE.Vector3) => number): THREE.BufferGeometry {
  const pos = g.getAttribute('position');
  const uv = new Float32Array(pos.count * 2);
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    uv[2 * i] = wx(p);
    uv[2 * i + 1] = wy(p);
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  MOVING.add(g);
  return g;
}
function still(list: THREE.BufferGeometry[]): THREE.BufferGeometry[] {
  for (const g of list) {
    const n = g.getAttribute('position').count;
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  }
  return list;
}

// ─── Canopy ──────────────────────────────────────────────────────────────────

/** The aft canopy bow (the frame behind the seat) and the canopy sill rails. */
export const CANOPY_BOW_Z = -3.55;

function buildCanopy(): { glass: THREE.BufferGeometry; frame: THREE.BufferGeometry } {
  const rings: number[][] = [];
  const n = 32;
  const steps = 36;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Denser at the rounded front.
    const z = CANOPY_FRONT_Z + (CANOPY_REAR_Z - CANOPY_FRONT_Z) * (1 - Math.cos((t * Math.PI) / 2)) ** 0.85;
    rings.push(canopyArch(z, n));
  }
  const glass = loftGeometry(rings, { closed: false });

  const f: THREE.BufferGeometry[] = [];
  const FRAME = PIT.frame;
  // Sill rails: the canopy's lower frame, a dark flat band on the inside of the glass, from the
  // glareshield back to the aft end (piecewise along the sill line).
  for (const s of [-1, 1]) {
    const N = 24;
    for (let i = 0; i < N; i++) {
      const za = -5.75 + ((CANOPY_REAR_Z + 0.02 + 5.75) * i) / N;
      const zb = -5.75 + ((CANOPY_REAR_Z + 0.02 + 5.75) * (i + 1)) / N;
      const ca = canopyAt(za);
      const cb = canopyAt(zb);
      const zc = (za + zb) / 2;
      const w = (ca.w + cb.w) / 2;
      const sill = (ca.sill + cb.sill) / 2;
      const yaw = Math.atan2(cb.w - ca.w, zb - za) * s;
      const len = Math.hypot(zb - za, cb.w - ca.w) + 0.004;
      // Inner flange (seen from the seat) and the rail top.
      f.push(tint(box(0.022, 0.05, len, V(s * (w - 0.014), sill + 0.012, zc), 0, -yaw, 0), FRAME, 0.55, 0.35));
      f.push(tint(box(0.04, 0.012, len, V(s * (w - 0.006), sill - 0.012, zc), 0, -yaw, 0), 0x2a2d2f, 0.6, 0.3));
    }
  }
  // Aft bow: a deep band following the arch just inside the glass, and the aft end frame.
  const bow = (z: number, width: number, inset: number, depth: number) => {
    const a = canopyArch(z - width / 2, 24, inset, 0);
    const b = canopyArch(z + width / 2, 24, inset, 0);
    const c2 = canopyArch(z + width / 2, 24, inset + depth, 0);
    const d = canopyArch(z - width / 2, 24, inset + depth, 0);
    f.push(tint(loftGeometry([a, b, c2, d, a.slice()], { closed: false }), FRAME, 0.5, 0.3));
  };
  bow(CANOPY_BOW_Z, 0.09, 0.004, 0.045);
  bow(CANOPY_REAR_Z + 0.04, 0.1, -0.004, 0.03);
  // Canopy actuator/lock fittings on the bow (left and right, low) and the bow's centre fitting.
  for (const s of [-1, 1]) f.push(tint(box(0.05, 0.08, 0.1, V(s * 0.4, 0.55, CANOPY_BOW_Z + 0.02)), 0x2b2e30, 0.6, 0.3));
  f.push(tint(box(0.12, 0.03, 0.08, V(0, canopyAt(CANOPY_BOW_Z).top - 0.06, CANOPY_BOW_Z)), 0x2b2e30, 0.6, 0.3));
  return { glass, frame: merge(f) };
}

// ─── Glareshield ─────────────────────────────────────────────────────────────

/** The hood: lofted across the cockpit (one closed (z, y) profile per x), hugging the canopy. */
function buildHood(): THREE.BufferGeometry {
  const rings: number[][] = [];
  const NX = 30;
  const X = 0.448;
  const fwd = [0, 0.03, 0.09, 0.18, 0.3, 0.44, 0.58, 0.72];
  // The top falls away faster than the sightline over the ICP (tan 13.8° ≈ 0.25), so only the lip shows.
  const drop = [0, 0.008, 0.027, 0.057, 0.098, 0.145, 0.195, 0.245];
  for (let i = 0; i <= NX; i++) {
    const t = -1 + (2 * i) / NX;
    const x = X * Math.sign(t) * Math.abs(t) ** 0.8;
    const zL = hoodLipZ(x);
    const yL = lipY(x);
    const pts: [number, number, number][] = [];
    const clampPt = (z: number, y: number): [number, number, number] => {
      const c = canopyAt(z);
      const xx = Math.sign(x) * Math.min(Math.abs(x), c.w - 0.02);
      const yy = Math.max(c.sill + 0.02, Math.min(y, canopyInnerY(xx, z) - 0.025));
      return [xx, yy, z];
    };
    // Top: lip → forward.
    for (let k = 0; k < fwd.length; k++) pts.push(clampPt(zL - fwd[k], yL - drop[k]));
    // Underside: forward → back toward the lip.
    const th = 0.028;
    for (let k = fwd.length - 1; k >= 1; k--) {
      const top = clampPt(zL - fwd[k], yL - drop[k]);
      pts.push([top[0], top[1] - th - fwd[k] * 0.05, top[2]]);
    }
    // Bullnose lip.
    pts.push(clampPt(zL, yL - th));
    pts.push(clampPt(zL + 0.007, yL - th + 0.003));
    pts.push(clampPt(zL + 0.011, yL - 0.014));
    pts.push(clampPt(zL + 0.008, yL - 0.005));
    rings.push(pts.flat());
  }
  return tint(loftGeometry(rings, { closed: true, capStart: true, capEnd: true }), PIT.shield, 0.92, 0);
}

// ─── HUD and ICP ─────────────────────────────────────────────────────────────

function buildHud(detail: THREE.BufferGeometry[]): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const c = HUD_COMBINER;
  const M = combinerMatrix();
  // HUD body in the glareshield, below the sightline over the ICP (the part under the combiner base).
  out.push(tint(box(0.2, 0.085, 0.3, V(0, 0.7025, -5.23)), PIT.bezel, 0.7, 0.1));
  out.push(tint(box(0.24, 0.02, 0.14, V(0, 0.77, -5.16)), PIT.black, 0.8, 0.1));
  // ICP housing: a prism whose rear face (the ICP) leans back 13° and whose top stays under the
  // sightline through its top rear edge (the face is textured by panelFace; the keys are in `detail`).
  const F = icpFrame();
  const top = V(0, ICP.h / 2, 0).applyMatrix4(F);
  const bot = V(0, -ICP.h / 2, 0).applyMatrix4(F);
  out.push(tint(prismX([[top.z, top.y], [bot.z, bot.y], [-5.1, bot.y], [-5.1, top.y - 0.012]], -ICP.w / 2, ICP.w / 2), PIT.gullDark, 0.75, 0.05));
  // Combiner frame: two posts and a top bar outside the glass rectangle, a clamp at its foot.
  const FR = 0x26292c;
  const parts: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    parts.push(tint(box(0.014, c.h + 0.05, 0.022, V(s * (c.w / 2 + 0.008), 0.012, -0.004)), FR, 0.5, 0.35));
    // Post feet down into the ICP housing.
    parts.push(tint(box(0.022, 0.05, 0.04, V(s * (c.w / 2 + 0.006), -c.h / 2 - 0.022, -0.022)), FR, 0.6, 0.3));
  }
  parts.push(tint(box(c.w + 0.03, 0.014, 0.02, V(0, c.h / 2 + 0.008, -0.004)), FR, 0.5, 0.35));
  // The HUD's upper combiner (a thin second pane's edge seen on top) and its hinge knuckles.
  for (const s of [-1, 1]) parts.push(tint(tube(V(s * (c.w / 2 + 0.002), c.h / 2 + 0.016, -0.012), V(s * (c.w / 2 - 0.02), c.h / 2 + 0.016, -0.012), 0.006, 0.006, 8), 0x1a1c1e, 0.5, 0.4));
  for (const p of parts) p.applyMatrix4(M);
  out.push(...parts);

  // ICP keys (caps; the legends are textured quads on top) and the rockers / thumbwheels.
  for (const k of ICP_KEYS) {
    const hex = k.kind === 'mode' ? 0x2e3134 : 0x3b3f42;
    detail.push(fbox(F, k.w, k.h, 0.005, k.x, k.y, 0.0025, hex, 0.55, 0.05));
  }
  // DCS rocker (4-way "dobber"): a cross on a round base; the FLIR rocker below it.
  detail.push(fcyl(F, 0.013, 0.012, 0, 0.004, 0.068, 0.022, PIT.black, 0.6, 16));
  detail.push(fbox(F, 0.022, 0.007, 0.006, 0.068, 0.022, 0.006, 0x3b3f42, 0.55));
  detail.push(fbox(F, 0.007, 0.022, 0.006, 0.068, 0.022, 0.006, 0x3b3f42, 0.55));
  detail.push(fbox(F, 0.012, 0.022, 0.006, 0.068, -0.03, 0.003, 0x3b3f42, 0.55));
  detail.push(fbox(F, 0.014, 0.012, 0.005, 0.068, -0.003, 0.0025, 0x3b3f42, 0.55));
  // Thumbwheels at both ends (SYM / BRT, RET DEPR / CONT): ribbed rollers across the face.
  for (const [x, y] of [[-0.094, 0.028], [-0.094, -0.018], [0.094, 0.028], [0.094, -0.018]]) {
    const g = tube(V(x - 0.006, y, 0.004), V(x + 0.006, y, 0.004), 0.011, 0.011, 14);
    detail.push(tint(g.applyMatrix4(F), 0x202224, 0.7, 0.05));
    detail.push(fbox(F, 0.018, 0.03, 0.004, x, y, 0.001, PIT.black, 0.8));
  }
  // Drift cut-out and warn-reset toggles under the keypad.
  for (const x of [-0.078, 0.046]) {
    detail.push(fcyl(F, 0.004, 0.004, 0, 0.004, x, -0.046, 0x8e9295, 0.4, 10, false, 0.6));
    detail.push(tint(tube(V(x, -0.046, 0.003), V(x, -0.044, 0.02), 0.0022, 0.0018, 8).applyMatrix4(F), 0xb5b8ba, 0.3, 0.8));
  }
  return out;
}

// ─── Panel ───────────────────────────────────────────────────────────────────

/** Outline polygons of the panel face (panel coordinates), one per facet (the fold is a crease). */
export function panelOutlines(): [number, number][][] {
  const f = PANEL.fold;
  const W = PANEL.halfWidth;
  const top = (x0: number, x1: number, n: number): [number, number][] => {
    const out: [number, number][] = [];
    for (let i = 0; i <= n; i++) {
      const x = x0 + ((x1 - x0) * i) / n;
      out.push([x, panelTopYp(x)]);
    }
    return out;
  };
  const b = LAYOUT.bottom;
  const g = LAYOUT.gearPanel;
  const centre: [number, number][] = [[-f, b.centre], [f, b.centre], ...top(f, -f, 4)];
  const right: [number, number][] = [[f, b.wing], [W, b.wing], ...top(W, f, 12)];
  const left: [number, number][] = [[-f, b.wing], [g.x1, b.wing], [g.x1, g.y1], [-W, g.y1], ...top(-W, -f, 12)];
  return [left, centre, right];
}

function buildPanel(interior: THREE.BufferGeometry[], detail: THREE.BufferGeometry[], face: THREE.BufferGeometry[], atlas: { w: number; h: number; px: number }): void {
  const PX = atlas.px;
  // Painted face: every outline → triangles in panel coords → bent onto the facets.
  for (const poly of panelOutlines()) {
    const shape = new THREE.Shape(poly.map(([x, y]) => new THREE.Vector2(x, y)));
    const g = new THREE.ShapeGeometry(shape, 4);
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    const m = M4();
    const p = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      const xp = pos.getX(i);
      const yp = pos.getY(i);
      uv.setXY(i, ((xp + PANEL.halfWidth) * PX) / atlas.w, 1 - (-yp * PX) / atlas.h);
      // (The centre and wing mappings agree on the fold line.)
      panelFrame(xp, yp, 0, m);
      p.set(0, 0, 0).applyMatrix4(m);
      pos.setXYZ(i, p.x, p.y, p.z);
    }
    g.computeVertexNormals();
    face.push(tint(g, 0xffffff, 0.72, 0));
    // Panel edge thickness: a band behind the bottom edge (the knee-well roof) and the outer edges.
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k];
      const b2 = poly[(k + 1) % poly.length];
      const bottomEdge = Math.abs(a[1] - b2[1]) < 1e-6 && a[1] < -0.2;
      const sideEdge = Math.abs(a[0] - b2[0]) < 1e-6 && Math.abs(a[0]) > PANEL.fold + 0.01;
      if (!bottomEdge && !sideEdge) continue;
      const pa = panelPoint(a[0], a[1]);
      const pb = panelPoint(b2[0], b2[1]);
      const depth = bottomEdge ? 0.14 : 0.1;
      const n = new THREE.Vector3().setFromMatrixColumn(panelFrame((a[0] + b2[0]) / 2, (a[1] + b2[1]) / 2), 2);
      const back = n.clone().multiplyScalar(-depth);
      const q = [pa, pb, pb.clone().add(back), pa.clone().add(back)];
      const gg = new THREE.BufferGeometry().setFromPoints([q[0], q[1], q[2], q[0], q[2], q[3]]);
      gg.computeVertexNormals();
      interior.push(tint(gg, PIT.gullDark, 0.8, 0));
      // Also the reverse face (seen from below).
      const gr = new THREE.BufferGeometry().setFromPoints([q[0], q[2], q[1], q[0], q[3], q[2]]);
      gr.computeVertexNormals();
      interior.push(tint(gr, PIT.gullDark, 0.8, 0));
    }
  }

  // MFDs: bezel frame (4 bars), 20 option-select buttons, 4 corner rockers.
  const B = LAYOUT.mfdBezel;
  const S = LAYOUT.mfdScreen;
  const bar = (B - S) / 2;
  for (const c of LAYOUT.mfd) {
    const F = panelFrame(c.x, c.y);
    const zc = 0.009;
    interior.push(fbox(F, B, bar, 0.018, 0, (S + bar) / 2, zc, PIT.bezel, 0.6, 0.1));
    interior.push(fbox(F, B, bar, 0.018, 0, -(S + bar) / 2, zc, PIT.bezel, 0.6, 0.1));
    interior.push(fbox(F, bar, S, 0.018, -(S + bar) / 2, 0, zc, PIT.bezel, 0.6, 0.1));
    interior.push(fbox(F, bar, S, 0.018, (S + bar) / 2, 0, zc, PIT.bezel, 0.6, 0.1));
    // Screen well (dark, behind the glass).
    interior.push(fbox(F, S + 0.004, S + 0.004, 0.004, 0, 0, 0.002, 0x050606, 0.3, 0));
    const off = [-0.042, -0.021, 0, 0.021, 0.042];
    const edge = S / 2 + bar / 2;
    for (const o of off) {
      detail.push(fbox(F, 0.014, 0.01, 0.006, o, edge, 0.021, 0x4a4e51, 0.6, 0.05));
      detail.push(fbox(F, 0.014, 0.01, 0.006, o, -edge, 0.021, 0x4a4e51, 0.6, 0.05));
      detail.push(fbox(F, 0.01, 0.014, 0.006, edge, o, 0.021, 0x4a4e51, 0.6, 0.05));
      detail.push(fbox(F, 0.01, 0.014, 0.006, -edge, o, 0.021, 0x4a4e51, 0.6, 0.05));
    }
    for (const [sx, sy] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
      detail.push(fbox(F, 0.018, 0.009, 0.006, sx * (edge - 0.001), sy * (edge + 0.0005), 0.021, 0x2f3235, 0.6, 0.05));
    }
  }

  // DED bezel and window well.
  {
    const d = LAYOUT.ded;
    const F = panelFrame(d.x, d.y);
    interior.push(fbox(F, d.w + 0.03, d.h + 0.018, 0.012, 0, 0, 0.006, PIT.bezel, 0.6, 0.1));
    interior.push(fbox(F, d.w + 0.004, d.h + 0.004, 0.003, 0, 0, 0.0135, 0x050606, 0.3, 0));
  }

  // Round instruments: square case front, cylindrical lip, knobs.
  const knobs: Record<string, [number, number][]> = {
    altimeter: [[-0.8, -0.8]],
    adi: [[0.8, -0.85]],
    hsi: [[-0.85, -0.85], [0.85, -0.85]],
    sai: [[0.8, -0.8]],
    fuel: [[0.85, -0.8]],
    airspeed: [[0.8, -0.8]],
  };
  for (const [name, g] of Object.entries(LAYOUT.gauges) as [string, Gauge][]) {
    const F = panelFrame(g.x, g.y);
    const rwr = name === 'rwr';
    const caseW = g.r * (rwr ? 2.5 : 2.36);
    interior.push(fbox(F, caseW, caseW, 0.008, 0, 0, 0.004, PIT.black, 0.7, 0.05));
    detail.push(fcyl(F, g.r * 1.1, g.r * 1.1, 0.006, 0.016, 0, 0, 0x1a1b1c, 0.5, 28, true, 0.2));
    detail.push(fcyl(F, g.r * 1.18, g.r * 1.1, 0.006, 0.0165, 0, 0, 0x1a1b1c, 0.5, 28, true, 0.2));
    // Case screws.
    for (const [sx, sy] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) detail.push(fcyl(F, 0.0028, 0.0028, 0.008, 0.0095, (sx * caseW) / 2.45, (sy * caseW) / 2.45, 0x3e4245, 0.4, 8, false, 0.5));
    for (const [kx, ky] of knobs[name] ?? []) {
      detail.push(fcyl(F, 0.0075, 0.007, 0.008, 0.024, kx * g.r * 1.05, ky * g.r * 1.05, PIT.knob, 0.55, 14));
    }
    if (rwr) {
      // The RWR scope's anti-glare hood.
      detail.push(fcyl(F, g.r * 1.32, g.r * 1.25, 0.006, 0.03, 0, 0, 0x151617, 0.8, 28, true, 0.05));
    }
  }

  // Master caution and TF FAIL lenses; eyebrow panel housings.
  for (const l of [LAYOUT.masterCaution, LAYOUT.tfFail]) {
    const F = panelFrame(l.x, l.y);
    interior.push(fbox(F, l.w + 0.008, l.h + 0.008, 0.01, 0, 0, 0.005, PIT.black, 0.6, 0.1));
  }
  for (const e of [EYEBROW.left, EYEBROW.right]) {
    const F = eyebrowFrame(e.x, e.h);
    interior.push(fbox(F, e.w + 0.012, e.h + 0.012, 0.03, 0, 0, -0.015, PIT.shield, 0.85, 0.05));
  }

  // Gear panel: the handle (a white wheel knob on a lever, moving between UP and DN), its slot, the
  // three gear lights, the landing/taxi light switch, the hook switch, DN LOCK REL button.
  {
    const gp = LAYOUT.gearHandle;
    const F = panelFrame(gp.x, gp.y);
    interior.push(fbox(F, 0.018, 0.08, 0.006, 0, 0, 0.003, PIT.black, 0.8));
    // Handle at the DN position (panel y −0.025); the UP position is +0.05 (uv.x ∈ [2, 3] weights).
    const handle: THREE.BufferGeometry[] = [];
    handle.push(fcyl(F, 0.006, 0.006, 0.0, 0.05, 0, -0.025, 0xb7babb, 0.35, 10, false, 0.7));
    handle.push(fcyl(F, 0.017, 0.017, 0.042, 0.06, 0, -0.025, 0xc9c5bb, 0.5, 24));
    handle.push(fcyl(F, 0.0185, 0.0185, 0.045, 0.057, 0, -0.025, 0xb9b5aa, 0.55, 24, true));
    handle.push(fcyl(F, 0.0055, 0.0055, 0.0602, 0.0608, 0, -0.025, 0x4a1a14, 0.35, 16));
    for (const h of handle) detail.push(moving(h, () => 3, () => 0));
    detail.push(fcyl(F, 0.007, 0.007, 0.004, 0.014, 0.034, -0.03, 0x1a1a1a, 0.6, 12));
    for (const l of LAYOUT.gearLights) {
      const Fl = panelFrame(l.x, l.y);
      interior.push(fbox(Fl, 0.02, 0.016, 0.008, 0, 0, 0.004, PIT.black, 0.6));
    }
    // Landing/taxi light switch: a toggle bat (uv.y ∈ [2, 3] weights move its tip).
    for (const sw of [LAYOUT.landingSwitch, LAYOUT.hookSwitch]) {
      const Fs = panelFrame(sw.x, sw.y);
      detail.push(fcyl(Fs, 0.0065, 0.0065, 0, 0.005, 0, 0, 0x8e9295, 0.4, 12, false, 0.6));
      const bat = tint(tube(V(0, 0, 0.004), V(0, 0.004, 0.022), 0.0026, 0.002, 8).applyMatrix4(Fs), 0xc0c3c5, 0.3, 0.85);
      if (sw === LAYOUT.landingSwitch) detail.push(moving(bat, () => 0, (p) => 2 + Math.min(1, Math.max(0, new THREE.Vector3().copy(p).applyMatrix4(Fs.clone().invert()).z / 0.022))));
      else detail.push(bat);
    }
  }

  // Switches and knobs sprinkled where the painted legends call for them (left wing and centre).
  const toggles: [number, number][] = [[-0.39, -0.06], [-0.36, -0.06], [-0.42, -0.06], [-0.39, -0.12], [-0.36, -0.12], [0.39, -0.08], [0.36, -0.08], [0.42, -0.08]];
  for (const [x, y] of toggles) {
    const F = panelFrame(x, y);
    detail.push(fcyl(F, 0.005, 0.005, 0, 0.004, 0, 0, 0x8e9295, 0.4, 10, false, 0.6));
    detail.push(tint(tube(V(0, 0, 0.003), V(0, 0.003, 0.018), 0.0022, 0.0017, 8).applyMatrix4(F), 0xc0c3c5, 0.3, 0.85));
  }
  const rotaries: [number, number, number][] = [[-0.39, -0.155, 0.011], [0.39, -0.135, 0.009], [0.345, -0.135, 0.009], [-0.1, -0.35, 0.008], [0.1, -0.35, 0.008]];
  for (const [x, y, r] of rotaries) {
    const F = panelFrame(x, y);
    detail.push(fcyl(F, r, r * 0.9, 0, 0.014, 0, 0, PIT.knob, 0.55, 16));
    detail.push(fbox(F, r * 0.35, r * 1.9, 0.006, 0, 0, 0.016, PIT.knob, 0.55));
  }
}

// ─── Consoles, stick, throttle ───────────────────────────────────────────────

/** Console-top atlas regions: the console's length (z0 → z1) runs along the canvas x. */
export const CONSOLE_ATLAS = { left: [0, 1024, 2048, 1408], right: [0, 1408, 2048, 1792] } as const;

function buildConsoles(interior: THREE.BufferGeometry[], detail: THREE.BufferGeometry[], face: THREE.BufferGeometry[], atlas: { w: number; h: number }): void {
  const C = CONSOLE;
  const len = C.z1 - C.z0;
  const wid = C.outer - C.inner;
  for (const s of [-1, 1]) {
    const xc = s * (C.inner + wid / 2);
    // Console body down to the floor, the sidewall up to the sill.
    interior.push(tint(box(wid, C.top - 0.22, len, V(xc, (C.top + 0.22) / 2, (C.z0 + C.z1) / 2)), PIT.gullDark, 0.8, 0));
    const zs = [-5.0, -4.6, -4.2, -3.8];
    for (let i = 0; i < zs.length - 1; i++) {
      const za = zs[i];
      const zb = zs[i + 1];
      const w = (canopyAt(za).w + canopyAt(zb).w) / 2;
      interior.push(tint(box(0.02, 0.07, zb - za + 0.002, V(s * (w - 0.03), C.top + 0.03, (za + zb) / 2)), PIT.gull, 0.8, 0));
    }
    // Console top: textured quad (length along the canvas x).
    const rect = s < 0 ? CONSOLE_ATLAS.left : CONSOLE_ATLAS.right;
    const g = new THREE.PlaneGeometry(len, wid);
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) {
      const u = uv.getX(i);
      const v = uv.getY(i);
      // u: fore → aft; v: 0 = inner edge… for the left console the outer edge is at the top of the strip.
      uv.setXY(i, (rect[0] + (rect[2] - rect[0]) * u) / atlas.w, 1 - (rect[1] + (rect[3] - rect[1]) * (1 - v)) / atlas.h);
    }
    // Plane: local y → body x outboard (s), normal → up; local x → aft on the right, fore on the left
    // (keeps the basis right-handed), so the left console's u runs aft → fore: flip it.
    if (s < 0) for (let i = 0; i < uv.count; i++) uv.setX(i, (rect[0] + rect[2]) / atlas.w - uv.getX(i));
    g.applyMatrix4(new THREE.Matrix4().makeBasis(V(0, 0, s), V(s, 0, 0), V(0, 1, 0)));
    g.translate(xc, C.top + 0.0012, (C.z0 + C.z1) / 2);
    face.push(tint(g, 0xffffff, 0.75, 0));
    // Console knobs and toggles (a row of panels; positions in console coordinates u = fore→aft, v = inner→outer).
    const knob = (u: number, v: number, r: number) => {
      const p = V(s * (C.inner + v * wid), C.top, C.z0 + u * len);
      detail.push(tint(tube(p, V(p.x, p.y + 0.014, p.z), r, r * 0.88, 14), PIT.knob, 0.55, 0));
      detail.push(tint(box(r * 0.35, 0.005, r * 1.9, V(p.x, p.y + 0.016, p.z)), PIT.knob, 0.55, 0));
    };
    const toggle = (u: number, v: number) => {
      const p = V(s * (C.inner + v * wid), C.top, C.z0 + u * len);
      detail.push(tint(tube(p, V(p.x, p.y + 0.004, p.z), 0.005, 0.005, 10), 0x8e9295, 0.4, 0.6));
      detail.push(tint(tube(V(p.x, p.y + 0.003, p.z), V(p.x, p.y + 0.019, p.z - 0.004), 0.0022, 0.0017, 8), 0xc0c3c5, 0.3, 0.85));
    };
    if (s < 0) {
      // Left: aft of the throttle — FLCS, fuel, AUX COMM, EXT LIGHTING, EPU, ELEC, audio panels.
      for (const [u, v, r] of [[0.52, 0.3, 0.009], [0.52, 0.7, 0.009], [0.62, 0.25, 0.011], [0.62, 0.55, 0.008], [0.62, 0.8, 0.008], [0.74, 0.3, 0.009], [0.74, 0.7, 0.009], [0.86, 0.25, 0.008], [0.86, 0.5, 0.008], [0.86, 0.75, 0.008], [0.95, 0.4, 0.009]] as [number, number, number][]) knob(u, v, r);
      for (const [u, v] of [[0.47, 0.2], [0.47, 0.45], [0.47, 0.7], [0.68, 0.4], [0.68, 0.65], [0.8, 0.2], [0.8, 0.45], [0.8, 0.7], [0.91, 0.2], [0.91, 0.62]] as [number, number][]) toggle(u, v);
    } else {
      // Right: ahead of the stick — SNSR PWR, HUD panel; aft — lighting, oxygen, air-conditioning, avionics power.
      for (const [u, v, r] of [[0.08, 0.3, 0.008], [0.08, 0.7, 0.008], [0.58, 0.72, 0.009], [0.66, 0.3, 0.011], [0.66, 0.72, 0.009], [0.78, 0.3, 0.009], [0.78, 0.7, 0.012], [0.9, 0.35, 0.009], [0.9, 0.7, 0.009]] as [number, number, number][]) knob(u, v, r);
      for (const [u, v] of [[0.16, 0.2], [0.16, 0.42], [0.16, 0.64], [0.16, 0.86], [0.26, 0.25], [0.26, 0.5], [0.26, 0.75], [0.72, 0.5], [0.84, 0.5], [0.95, 0.25], [0.95, 0.6]] as [number, number][]) toggle(u, v);
    }
  }

  // Right console: the side-stick controller on its base and the adjustable armrest behind it.
  {
    const bx = STICK.x;
    const bz = STICK.z;
    const by = C.top;
    interior.push(tint(box(0.1, 0.02, 0.12, V(bx, by + 0.01, bz)), 0x2a2c2e, 0.7, 0.1));
    // Armrest: padded top on a pedestal, adjustable rails.
    interior.push(tint(box(0.08, 0.06, 0.1, V(bx - 0.005, by + 0.03, -4.44)), 0x2c2e30, 0.8, 0.05));
    interior.push(tint(box(0.085, 0.03, 0.26, V(bx - 0.01, by + 0.075, -4.42), 0.04, 0, 0), 0x2b2c27, 0.95, 0));
    const st: THREE.BufferGeometry[] = [];
    // Rubber boot, then the grip: a pistol grip raked forward, canted out, with the head on top.
    st.push(tint(tube(V(bx, by + 0.02, bz), V(bx, by + 0.045, bz), 0.032, 0.022, 16), 0x141414, 0.95, 0));
    const grip = (y: number, z: number, rx: number, ry: number, rz: number) => tint(ellipsoid(V(bx + 0.003, by + y, bz + z), rx, ry, rz, 16, 12), 0x1b1b1b, 0.75, 0);
    st.push(grip(0.075, -0.004, 0.02, 0.042, 0.025));
    st.push(grip(0.112, -0.012, 0.022, 0.024, 0.031));
    st.push(grip(0.132, -0.018, 0.019, 0.012, 0.027));
    // Trigger (front), pinky paddle, trim hat and the red weapon-release button on top, TMS/DMS hats on the thumb side.
    st.push(tint(box(0.008, 0.024, 0.01, V(bx + 0.003, by + 0.1, bz - 0.036), 0.3, 0, 0), 0x2a2a2a, 0.6, 0.2));
    st.push(tint(box(0.03, 0.006, 0.02, V(bx + 0.003, by + 0.05, bz - 0.027), -0.4, 0, 0), 0x2a2a2a, 0.6, 0.2));
    st.push(tint(tube(V(bx + 0.003, by + 0.142, bz - 0.012), V(bx + 0.003, by + 0.149, bz - 0.012), 0.006, 0.005, 10), 0x3a3a3a, 0.5, 0.3));
    st.push(tint(tube(V(bx - 0.011, by + 0.139, bz - 0.03), V(bx - 0.013, by + 0.145, bz - 0.034), 0.0055, 0.005, 10), 0xa0201a, 0.45, 0));
    for (const [y, z] of [[0.128, -0.036], [0.112, -0.036]]) st.push(tint(tube(V(bx - 0.018, by + y, bz + z + 0.01), V(bx - 0.024, by + y + 0.002, bz + z + 0.008), 0.004, 0.0035, 8), 0x3a3a3a, 0.5, 0.3));
    for (const g of st) detail.push(moving(g, () => 0, (p) => Math.min(1, Math.max(0, (p.y - by - 0.02) / STICK.height))));
  }

  // Left console: throttle quadrant (slot plate, gate) and the F110 throttle grip on its arm.
  {
    const x = THROTTLE.x;
    const zb = THROTTLE.zIdle - THROTTLE.travel * THROTTLE.build;
    interior.push(tint(box(0.07, 0.012, THROTTLE.travel + 0.12, V(x, C.top + 0.006, THROTTLE.zIdle - THROTTLE.travel / 2)), 0x2a2c2e, 0.75, 0.1));
    interior.push(tint(box(0.012, 0.004, THROTTLE.travel + 0.04, V(x, C.top + 0.0125, THROTTLE.zIdle - THROTTLE.travel / 2)), 0x050505, 0.9, 0));
    // Outboard gate plate with the IDLE / MIL / AB detents.
    interior.push(tint(box(0.008, 0.05, THROTTLE.travel + 0.1, V(x - 0.045, C.top + 0.025, THROTTLE.zIdle - THROTTLE.travel / 2)), PIT.gull, 0.75, 0.05));
    const th: THREE.BufferGeometry[] = [];
    th.push(tint(box(0.022, 0.07, 0.035, V(x, C.top + 0.04, zb)), 0x2a2c2e, 0.6, 0.2));
    // Grip: a chunky body leaning inboard, the thumb switch bank facing the pilot.
    th.push(tint(ellipsoid(V(x + 0.006, C.top + 0.095, zb - 0.005), 0.03, 0.042, 0.052, 16, 12), 0x1c1c1c, 0.75, 0));
    th.push(tint(ellipsoid(V(x + 0.012, C.top + 0.125, zb - 0.02), 0.026, 0.02, 0.036, 14, 10), 0x1c1c1c, 0.75, 0));
    // Speed-brake slider, cursor/enable, dogfight switch, antenna elevation wheel, mic switch.
    th.push(tint(box(0.008, 0.016, 0.026, V(x + 0.035, C.top + 0.11, zb - 0.01)), 0x3a3a3a, 0.5, 0.3));
    th.push(tint(tube(V(x + 0.03, C.top + 0.13, zb - 0.035), V(x + 0.038, C.top + 0.132, zb - 0.035), 0.007, 0.006, 10), 0x3a3a3a, 0.5, 0.3));
    th.push(tint(box(0.02, 0.008, 0.008, V(x + 0.015, C.top + 0.12, zb - 0.058)), 0x3a3a3a, 0.5, 0.3));
    th.push(tint(tube(V(x - 0.02, C.top + 0.115, zb - 0.045), V(x - 0.026, C.top + 0.115, zb - 0.045), 0.009, 0.009, 12), 0x2a2a2a, 0.6, 0.2));
    th.push(tint(tube(V(x + 0.016, C.top + 0.142, zb - 0.02), V(x + 0.016, C.top + 0.148, zb - 0.02), 0.006, 0.005, 10), 0x3a3a3a, 0.5, 0.3));
    for (const g of th) detail.push(moving(g, () => 1, () => 0));
  }
}

// ─── Seat, floor, pedals ─────────────────────────────────────────────────────

function buildSeat(interior: THREE.BufferGeometry[], detail: THREE.BufferGeometry[]): void {
  const r = 30 * DEG; // recline: rotating a box by +r about x leans its top aft (+z)
  const up = V(0, Math.cos(r), Math.sin(r)); // along the seat back
  const base = V(0, 0.37, -4.36);
  const at = (t: number, fwd = 0) => base.clone().addScaledVector(up, t).add(V(0, 0, -fwd));
  // Back cushion and back plate (reclined), the back's side rails, low bucket sides at the seat pan,
  // headrest / parachute container behind the head, seat pan, survival kit.
  interior.push(tint(rbox(0.34, 0.58, 0.07, at(0.33, 0.0), r, 0.025), PIT.cushion, 0.95, 0));
  interior.push(tint(box(0.38, 0.7, 0.05, at(0.34, -0.06), r, 0, 0), PIT.seat, 0.8, 0.05));
  for (const s of [-1, 1]) {
    interior.push(tint(rbox(0.035, 0.62, 0.1, at(0.3, -0.03).add(V(s * 0.2, 0, 0)), r, 0.012), PIT.seat, 0.7, 0.1));
    interior.push(tint(rbox(0.035, 0.12, 0.4, V(s * 0.215, 0.35, -4.53), 0, 0.012), PIT.seat, 0.7, 0.1));
  }
  // Headrest / parachute container: narrower than the seat, rounded, with the canopy breaker on top.
  interior.push(tint(rbox(0.24, 0.24, 0.17, at(0.86, -0.08), r, 0.035), 0x2d2f31, 0.8, 0.05));
  interior.push(tint(rbox(0.2, 0.12, 0.04, at(0.82, 0.015), r, 0.015), 0x3a3c36, 0.95, 0));
  for (const s of [-1, 1]) interior.push(tint(tube(at(0.96, -0.06).add(V(s * 0.06, 0, 0)), at(1.0, -0.02).add(V(s * 0.06, 0, 0)), 0.008, 0.005, 8), 0x8a8e90, 0.4, 0.6));
  interior.push(tint(rbox(0.38, 0.06, 0.42, V(0, 0.33, -4.54), -8 * DEG, 0.02), PIT.cushion, 0.95, 0));
  interior.push(tint(box(0.42, 0.1, 0.42, V(0, 0.26, -4.54)), PIT.seat, 0.8, 0.05));
  // Headrest pad and the parachute riser covers over the shoulders.
  detail.push(tint(box(0.18, 0.1, 0.03, at(0.8, 0.03), r, 0, 0), 0x2f3129, 0.95, 0));
  for (const s of [-1, 1]) detail.push(tint(box(0.06, 0.16, 0.04, at(0.64, 0.02).add(V(s * 0.12, 0, 0)), r, 0, 0), 0x34362e, 0.9, 0));
  // Ejection handle: the yellow-and-black loop on the front of the seat pan, between the knees.
  const hc = V(0, 0.335, -4.775);
  const loop = new THREE.TorusGeometry(0.045, 0.009, 8, 20, Math.PI);
  loop.rotateX(-Math.PI / 2 + 0.5);
  loop.translate(hc.x, hc.y, hc.z);
  interior.push(tint(loop, 0xd8b020, 0.55, 0));
  for (let k = 0; k < 4; k++) {
    const a = ((k + 0.5) / 4) * Math.PI;
    const p = V(hc.x + Math.cos(a) * 0.045, hc.y, hc.z - Math.sin(a) * 0.045 * Math.cos(0.5 - Math.PI / 2 + Math.PI / 2));
    detail.push(tint(ellipsoid(V(p.x, p.y + Math.sin(a) * 0.02, p.z + 0.004), 0.0105, 0.0105, 0.0105, 8, 6), 0x151515, 0.6, 0));
  }
  // Seat-arm lever (left front), emergency oxygen green ring (left), manual-override handle (right).
  detail.push(tint(box(0.012, 0.012, 0.09, V(-0.21, 0.37, -4.68)), 0xd8b020, 0.55, 0));
  detail.push(tint(new THREE.TorusGeometry(0.018, 0.004, 6, 14).rotateY(Math.PI / 2).translate(-0.25, 0.43, -4.5), 0x3a8a3a, 0.55, 0));
  detail.push(tint(box(0.012, 0.03, 0.06, V(0.25, 0.42, -4.52)), 0xd8b020, 0.55, 0));
  // Floor plate, rudder pedals under the panel, the knee-well roof.
  interior.push(tint(box(0.52, 0.012, 0.9, V(0, 0.245, -4.95)), 0x2a2c2e, 0.9, 0));
  for (const s of [-1, 1]) {
    interior.push(tint(box(0.09, 0.15, 0.025, V(s * 0.14, 0.31, -5.36), -0.45, 0, 0), 0x3a3c3e, 0.6, 0.3));
    interior.push(tint(box(0.02, 0.02, 0.2, V(s * 0.14, 0.27, -5.25)), 0x2a2c2e, 0.6, 0.3));
  }
  // Aft cockpit bulkhead behind the seat and the avionics shelf.
  interior.push(tint(box(0.8, 0.3, 0.03, V(0, 0.4, -3.78)), PIT.gullDark, 0.85, 0));
  interior.push(tint(box(0.62, 0.05, 1.0, V(0, 0.41, -3.25)), 0x2a2c2e, 0.8, 0));
}

// ─── Pilot ───────────────────────────────────────────────────────────────────

/** Pilot's hands (they hold the stick and throttle grips). */
export const HANDS = { right: V(STICK.x + 0.004, CONSOLE.top + 0.1, STICK.z - 0.006), left: V(THROTTLE.x + 0.012, CONSOLE.top + 0.1, THROTTLE.zIdle - THROTTLE.travel * THROTTLE.build - 0.004) } as const;

function buildPilot(cockpitView: boolean): { body: THREE.BufferGeometry; head: THREE.BufferGeometry } {
  const SUIT = 0x55594a;
  const VEST = 0x3a3c30;
  const GSUIT = 0x57553f;
  const GLOVE = 0x2e2d2a;
  const b: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry, wx: (p: THREE.Vector3) => number = () => 0, wy: (p: THREE.Vector3) => number = () => 0) => b.push(cockpitView ? moving(g, wx, wy) : g);
  // Torso (reclined with the seat), survival vest, shoulders.
  const hip = V(0, 0.42, -4.44);
  const neck = V(0, 0.88, -4.2);
  add(tint(tube(hip, neck, 0.16, 0.15, 14), SUIT, 0.9, 0));
  add(tint(tube(V(0, 0.56, -4.36), V(0, 0.85, -4.22), 0.175, 0.16, 14), VEST, 0.85, 0));
  for (const s of [-1, 1]) {
    const sh = V(s * 0.19, 0.8, -4.2);
    const el = s > 0 ? V(0.3, 0.55, -4.36) : V(-0.3, 0.56, -4.3);
    const hand = s > 0 ? HANDS.right : HANDS.left;
    add(tint(ellipsoid(sh, 0.075, 0.07, 0.075, 10, 8), VEST, 0.85, 0));
    add(tint(tube(sh, el, 0.055, 0.048, 10), SUIT, 0.9, 0));
    // Forearm and glove follow the grip (throttle: uv.x weights along the forearm; stick: uv.y).
    const along = (p: THREE.Vector3) => Math.min(1, Math.max(0, p.clone().sub(el).dot(hand.clone().sub(el)) / hand.distanceToSquared(el)));
    const fore = tint(tube(el, hand, 0.046, 0.04, 10), SUIT, 0.9, 0);
    const glove = tint(ellipsoid(hand, 0.042, 0.038, 0.052, 10, 8), GLOVE, 0.7, 0);
    if (s < 0) {
      add(fore, along);
      add(glove, () => 1);
    } else {
      add(fore, () => 0, (p) => along(p) * 0.6);
      add(glove, () => 0, () => 0.6);
    }
    // Harness straps.
    add(tint(tube(V(s * 0.1, 0.85, -4.22), V(s * 0.08, 0.5, -4.4), 0.022, 0.022, 6), 0x2f2f28, 0.8, 0));
    // Legs: G-suit thighs to the knees, shins to the pedals.
    const hipS = V(s * 0.1, 0.4, -4.47);
    const knee = V(s * 0.15, 0.44, -4.88);
    const foot = V(s * 0.14, 0.3, -5.33);
    add(tint(tube(hipS, knee, 0.075, 0.06, 16), GSUIT, 0.95, 0));
    add(tint(ellipsoid(knee, 0.058, 0.055, 0.058, 14, 10), GSUIT, 0.95, 0));
    add(tint(tube(knee, foot, 0.052, 0.045, 14), SUIT, 0.95, 0));
    // G-suit hose and pocket.
    add(tint(box(0.05, 0.02, 0.12, V(hipS.x + s * 0.04, hipS.y + 0.05, (hipS.z + knee.z) / 2), 0.1, 0, 0), 0x4c4a37, 0.95, 0));
    add(tint(box(0.09, 0.07, 0.2, V(foot.x, foot.y - 0.02, foot.z + 0.02), -0.4, 0, 0), 0x1d1d1b, 0.8, 0));
    // Kneeboard strap on the left thigh.
    if (s < 0) {
      const kb = hipS.clone().lerp(knee, 0.72);
      add(tint(tube(V(kb.x - 0.07, kb.y + 0.012, kb.z), V(kb.x + 0.07, kb.y + 0.012, kb.z), 0.066, 0.066, 14, true), 0x2a2a26, 0.9, 0));
    }
  }
  // Oxygen hose from the mask to the chest.
  add(tint(tube(V(0.03, 0.93, -4.43), V(0.1, 0.72, -4.36), 0.018, 0.018, 8), 0x202020, 0.7, 0));

  const h: THREE.BufferGeometry[] = [];
  // Helmet (HGU-55 grey), dark visor down, oxygen mask; the eye point is inside, behind the visor.
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

// ─── Assembly ────────────────────────────────────────────────────────────────

/**
 * Live instrument canvas (cockpitPaint.ts redraws it ~10×/s in the cockpit view): px rects
 * [x0, y0, x1, y1]. Round instruments: the quad is 2.2 r square, the face circle fills the cell.
 */
export const LIVE_ATLAS = {
  width: 1024,
  height: 1024,
  mfdL: [0, 0, 400, 400],
  mfdR: [400, 0, 800, 400],
  rwr: [800, 0, 1024, 224],
  ded: [800, 224, 1024, 291],
  masterCaution: [800, 300, 912, 364],
  tfFail: [912, 300, 1024, 364],
  gear0: [800, 364, 840, 396],
  gear1: [840, 364, 880, 396],
  gear2: [880, 364, 920, 396],
  adi: [0, 400, 256, 656],
  airspeed: [256, 400, 512, 656],
  altimeter: [512, 400, 768, 656],
  hsi: [768, 400, 1024, 656],
  sai: [0, 656, 192, 848],
  vvi: [192, 656, 384, 848],
  fuel: [384, 656, 576, 848],
  ftit: [576, 656, 768, 848],
  rpm: [768, 656, 960, 848],
  noz: [0, 848, 176, 1024],
  oil: [176, 848, 352, 1024],
  eyebrowL: [352, 848, 512, 956],
  eyebrowR: [512, 848, 736, 976],
} as const;
export type LiveRect = keyof Omit<typeof LIVE_ATLAS, 'width' | 'height'>;

/** Quads of the live mesh; rm.y (the `glow` channel in the live material) = self-lit fraction. */
function buildLive(): THREE.BufferGeometry {
  const L = LIVE_ATLAS;
  const q: THREE.BufferGeometry[] = [];
  const quad = (F: THREE.Matrix4, w: number, h: number, dz: number, key: LiveRect, glow: number, rough: number) => {
    const g = atlasQuad(F, w, h, 0, 0, dz, L[key], L.width, L.height);
    const rm = g.getAttribute('rm') as THREE.BufferAttribute;
    for (let i = 0; i < rm.count; i++) rm.setXY(i, rough, glow);
    q.push(g);
  };
  LAYOUT.mfd.forEach((c, i) => quad(panelFrame(c.x, c.y), LAYOUT.mfdScreen, LAYOUT.mfdScreen, 0.0045, i === 0 ? 'mfdL' : 'mfdR', 1, 0.08));
  quad(panelFrame(LAYOUT.ded.x, LAYOUT.ded.y), LAYOUT.ded.w, LAYOUT.ded.h, 0.0155, 'ded', 1, 0.08);
  for (const [name, g] of Object.entries(LAYOUT.gauges) as [LiveRect, Gauge][]) {
    const rwr = name === 'rwr';
    quad(panelFrame(g.x, g.y), 2.2 * g.r, 2.2 * g.r, 0.0085, name, rwr ? 1 : 0.14, 0.18);
  }
  quad(panelFrame(LAYOUT.masterCaution.x, LAYOUT.masterCaution.y), LAYOUT.masterCaution.w, LAYOUT.masterCaution.h, 0.0102, 'masterCaution', 1, 0.2);
  quad(panelFrame(LAYOUT.tfFail.x, LAYOUT.tfFail.y), LAYOUT.tfFail.w, LAYOUT.tfFail.h, 0.0102, 'tfFail', 1, 0.2);
  LAYOUT.gearLights.forEach((l, i) => quad(panelFrame(l.x, l.y), 0.016, 0.012, 0.0082, (['gear0', 'gear1', 'gear2'] as const)[i], 1, 0.2));
  quad(eyebrowFrame(EYEBROW.left.x, EYEBROW.left.h), EYEBROW.left.w, EYEBROW.left.h, 0.0005, 'eyebrowL', 1, 0.2);
  quad(eyebrowFrame(EYEBROW.right.x, EYEBROW.right.h), EYEBROW.right.w, EYEBROW.right.h, 0.0005, 'eyebrowR', 1, 0.2);
  return merge(q);
}

/** Static cockpit atlas (painted by cockpitPaint.ts): panel face, console tops, ICP key caps. */
export const STATIC_ATLAS = { width: 2048, height: 2048, /** px per metre on the panel face */ panelPx: 2048 / 0.88 } as const;
/** ICP face region and key-cap cells in the static atlas. */
export const ICP_ATLAS = { face: [0, 1792, 496, 2048] as const, keyCell: { x0: 512, y0: 1792, w: 96, h: 80, cols: 15 } } as const;

export interface CockpitBuild {
  canopyGlass: THREE.BufferGeometry;
  canopyFrame: THREE.BufferGeometry;
  /** Big shapes (both views). */
  interior: THREE.BufferGeometry;
  /** Fine relief + stick, throttle and the cockpit-view pilot, with motion weights in uv (cockpit view only). */
  detail: THREE.BufferGeometry;
  /** Outside view: the whole pilot (body + head). */
  pilot: THREE.BufferGeometry;
  /** The pilot's head alone (hidden in the cockpit view; kept for the eye-inside-helmet check). */
  pilotHead: THREE.BufferGeometry;
  hudGlass: THREE.BufferGeometry;
  /** Static-atlas textured quads (panel face, console tops, ICP face and key legends). */
  panelFace: THREE.BufferGeometry;
  /** Live-canvas textured quads (displays, instrument faces, lights; cockpit view only). */
  live: THREE.BufferGeometry;
}

export function buildCockpit(): CockpitBuild {
  const canopy = buildCanopy();
  const interior: THREE.BufferGeometry[] = [];
  const detail: THREE.BufferGeometry[] = [];
  const face: THREE.BufferGeometry[] = [];
  const A = { w: STATIC_ATLAS.width, h: STATIC_ATLAS.height, px: STATIC_ATLAS.panelPx };
  interior.push(buildHood());
  interior.push(...buildHud(detail));
  buildPanel(interior, detail, face, A);
  buildConsoles(interior, detail, face, A);
  buildSeat(interior, detail);

  // ICP face and key legends (textured).
  {
    const F = icpFrame();
    face.push(atlasQuad(F, ICP.w, ICP.h, 0, 0, 0.0004, ICP_ATLAS.face, A.w, A.h));
    const cell = ICP_ATLAS.keyCell;
    ICP_KEYS.forEach((k, i) => {
      const cx = cell.x0 + (i % cell.cols) * cell.w;
      const cy = cell.y0 + Math.floor(i / cell.cols) * cell.h;
      face.push(atlasQuad(F, k.w, k.h, k.x, k.y, 0.0052, [cx, cy, cx + cell.w, cy + cell.h], A.w, A.h));
    });
  }

  const inside = buildPilot(true);
  const outside = buildPilot(false);
  const pilotHead = outside.head;
  const pilot = merge([outside.body, pilotHead.clone()]);
  inside.head.dispose();
  // Static detail parts get zero weights; moving ones were set by `moving`.
  const weighted = detail.filter((g) => MOVING.has(g));
  const staticParts = still(detail.filter((g) => !MOVING.has(g)));
  const hud = tint(new THREE.PlaneGeometry(HUD_COMBINER.w, HUD_COMBINER.h), 0xffffff, 0.05, 0);
  return {
    canopyGlass: canopy.glass,
    canopyFrame: canopy.frame,
    interior: merge(still(interior)),
    detail: merge([...staticParts, ...weighted, inside.body]),
    pilot,
    pilotHead,
    hudGlass: hud,
    panelFace: merge(face),
    live: buildLive(),
  };
}
