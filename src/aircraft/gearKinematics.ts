/**
 * Kinematics of the 172RG retractable gear, and the fuselage envelope it has to
 * disappear into. Pure maths (three.js math classes only, no scene objects) so
 * tests can drive it directly; `gear.ts` builds the meshes and applies it.
 *
 * Mains: a tubular spring-steel leg on a pivot inside the lower fuselage side,
 * just behind the cabin door. Retracting, the leg swings aft and inward while
 * the axle fitting turns the wheel flat; the wheel ends up lying in an open
 * well in the belly behind the cabin with only a sliver of tyre below the skin,
 * the leg tucked in a slot running forward to its pivot. No main gear doors
 * (like the real Cutlass RG).
 * Nose: an oleo leg that swings 90° aft about a pivot at the firewall into a
 * well under the cabin floor, braced by a folding drag link; clamshell doors
 * close after it.
 *
 * Body frame: +X right, +Y up, −Z nose, origin = CG. Numbers are for the RIGHT
 * main gear; the left one is mirrored in x.
 */
import * as THREE from 'three';
import { CONFIG } from '../config';
import { FUSE_Z0, FUSE_Z1, GEAR, fuselageSection, type SectionParams } from './shape';

const G = CONFIG.aircraft.geometry;
const M = CONFIG.aircraft.model;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

const clamp01 = (v: number) => (Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0);
const finiteOr = (v: number, d: number) => (Number.isFinite(v) ? v : d);
function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

// ─── Fuselage envelope ────────────────────────────────────────────────────────

const _s: SectionParams = { top: 0, bottom: 0, halfWidth: 0, widthY: 0, nTop: 2, nBot: 2 };

function lowerY(s: SectionParams, ax: number): number {
  const r = Math.min(1, ax / s.halfWidth);
  return s.widthY - (s.widthY - s.bottom) * Math.pow(1 - Math.pow(r, s.nBot), 1 / s.nBot);
}
function upperY(s: SectionParams, ax: number): number {
  const r = Math.min(1, ax / s.halfWidth);
  return s.widthY + (s.top - s.widthY) * Math.pow(1 - Math.pow(r, s.nTop), 1 / s.nTop);
}
function halfWidthAt(s: SectionParams, y: number): number {
  if (y <= s.bottom || y >= s.top) return 0;
  const upper = y >= s.widthY;
  const n = upper ? s.nTop : s.nBot;
  const f = upper ? (y - s.widthY) / (s.top - s.widthY) : (s.widthY - y) / (s.widthY - s.bottom);
  return s.halfWidth * Math.pow(1 - Math.pow(f, n), 1 / n);
}

/** Half-width (m) of the fuselage skin at height y of station z (0 above/below the section). */
export function sectionHalfWidthAt(y: number, z: number): number {
  fuselageSection(z, _s);
  return halfWidthAt(_s, y);
}

/** y of the skin's lower surface at (x, z) (the section's widest y beyond the side). */
export function bellyY(x: number, z: number): number {
  fuselageSection(z, _s);
  return lowerY(_s, Math.abs(x));
}

/**
 * How far (m) a body-frame point sits outside the fuselage skin: the smaller
 * of the vertical and sideways distances back to the surface. ≤ 0 = inside
 * (then the value is minus the distance to the nearer of the two).
 */
export function skinProtrusion(x: number, y: number, z: number): number {
  if (z < FUSE_Z0) return FUSE_Z0 - z + 0.001;
  if (z > FUSE_Z1) return z - FUSE_Z1 + 0.001;
  fuselageSection(z, _s);
  const ax = Math.abs(x);
  let vert: number;
  if (ax >= _s.halfWidth) vert = Infinity;
  else {
    const yb = lowerY(_s, ax);
    const yt = upperY(_s, ax);
    vert = y < yb ? yb - y : y > yt ? y - yt : -Math.min(y - yb, yt - y);
  }
  const hw = halfWidthAt(_s, y);
  const lat = hw > 0 ? ax - hw : Infinity;
  if (vert <= 0 && lat <= 0) return Math.max(vert, lat);
  const a = vert > 0 ? vert : Infinity;
  const b = lat > 0 ? lat : Infinity;
  const d = Math.min(a, b);
  return Number.isFinite(d) ? d : Math.hypot(ax - _s.halfWidth, y - _s.widthY);
}

// ─── Tyres ────────────────────────────────────────────────────────────────────

/**
 * Tyre cross-section (radius from the axle, offset along the axle) as a boxy
 * superellipse from bead to bead. Shared by the wheel mesh and the stowage solve.
 */
export function tyreProfile(R: number, rim: number, width: number, k = 16): Array<[number, number]> {
  const rc = (R + rim) / 2 + 0.01;
  const hr = R - rc;
  const hw = width / 2;
  const out: Array<[number, number]> = [];
  const e = 2 / 3.2;
  for (let i = 0; i <= k; i++) {
    const phi = -Math.PI / 2 + (Math.PI * i) / k;
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    out.push([rc + hr * Math.sign(c) * Math.pow(Math.abs(c), e), hw * Math.sign(s) * Math.pow(Math.abs(s), e)]);
  }
  return out;
}

// ─── Main gear geometry (right side) ─────────────────────────────────────────

const MAIN_RIM = 0.078;
const MAIN_TYRE_W = GEAR.mainTyreWidth;
/** Axle stub from the leg foot (inboard) to the wheel centre. */
const STUB = 0.1;
/** Leg pivot: inside the lower fuselage side just aft of the cabin door. */
const PIVOT = { x: 0.405, y: -0.4, z: 0.26 };
/** Stowed wheel centre x (the two wells sit side by side with a keel between them). */
const STOW_X = 0.212;
/** How far the lowest tyre point may hang below the skin when stowed. */
const STOW_SLIVER = 0.012;

const WHEEL_DOWN = { x: G.rightMainWheel.x, y: G.rightMainWheel.y + G.mainWheelRadius, z: G.rightMainWheel.z };
const FOOT_DOWN = { x: WHEEL_DOWN.x - STUB, y: WHEEL_DOWN.y, z: WHEEL_DOWN.z };
const LEG_LEN = Math.hypot(FOOT_DOWN.x - PIVOT.x, FOOT_DOWN.y - PIVOT.y, FOOT_DOWN.z - PIVOT.z);

/** Outward (downward) belly normal averaged over a wheel-sized patch at (x, z): the stowed axle direction. */
function stowAxle(x: number, z: number): THREE.Vector3 {
  const h = 0.14;
  const fx = (bellyY(x + h, z) - bellyY(x - h, z)) / (2 * h);
  const fz = (bellyY(x, z + h) - bellyY(x, z - h)) / (2 * h);
  return new THREE.Vector3(fx, -1, fz).normalize();
}

/** Worst protrusion below the skin of a tyre centred at c with axle (outward) direction a. */
function tyreWorst(c: THREE.Vector3, a: THREE.Vector3, R: number, rim: number, width: number, samples = 16): number {
  const prof = tyreProfile(R, rim, width, 8);
  const u = new THREE.Vector3(0, 0, 1).cross(a).normalize();
  const w = a.clone().cross(u).normalize();
  const p = new THREE.Vector3();
  let worst = -Infinity;
  for (const [r, h] of prof) {
    if (h < 0) continue;
    for (let k = 0; k < samples; k++) {
      const t = (k / samples) * Math.PI * 2;
      p.copy(c).addScaledVector(a, h).addScaledVector(u, r * Math.cos(t)).addScaledVector(w, r * Math.sin(t));
      worst = Math.max(worst, skinProtrusion(p.x, p.y, p.z));
    }
  }
  return worst;
}

/** Solve the stowed wheel: flat on the belly (sliver showing) at a distance that keeps the leg rigid. */
function solveStowage() {
  const P = new THREE.Vector3(PIVOT.x, PIVOT.y, PIVOT.z);
  const place = (z: number) => {
    const a = stowAxle(STOW_X, z);
    // Height: bisect the wheel centre y so the worst tyre point hangs STOW_SLIVER below the skin.
    let lo = bellyY(STOW_X, z) - 0.1;
    let hi = bellyY(STOW_X, z) + 0.3;
    const c = new THREE.Vector3(STOW_X, 0, z);
    for (let i = 0; i < 14; i++) {
      c.y = (lo + hi) / 2;
      if (tyreWorst(c, a, G.mainWheelRadius, MAIN_RIM, MAIN_TYRE_W) > STOW_SLIVER) lo = c.y;
      else hi = c.y;
    }
    c.y = hi;
    const foot = c.clone().addScaledVector(a, -STUB);
    return { wheel: c, axle: a, foot, len: foot.distanceTo(P) };
  };
  // The leg length fixes how far aft the wheel goes.
  let lo = 0.7;
  let hi = 1.9;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (place(mid).len < LEG_LEN) lo = mid;
    else hi = mid;
  }
  return place((lo + hi) / 2);
}
const STOWED = solveStowage();

export const MAIN_GEAR = {
  pivot: PIVOT,
  stub: STUB,
  rim: MAIN_RIM,
  tyreWidth: MAIN_TYRE_W,
  legLength: LEG_LEN,
  footDown: FOOT_DOWN,
  wheelDown: WHEEL_DOWN,
  footStowed: { x: STOWED.foot.x, y: STOWED.foot.y, z: STOWED.foot.z },
  wheelStowed: { x: STOWED.wheel.x, y: STOWED.wheel.y, z: STOWED.wheel.z },
  /** Unit axle direction (leg foot → wheel centre, i.e. the wheel's outboard face normal) when stowed. */
  axleStowed: { x: STOWED.axle.x, y: STOWED.axle.y, z: STOWED.axle.z },
} as const;

// ─── Nose gear geometry ──────────────────────────────────────────────────────

const NOSE_PIVOT = { x: GEAR.nosePivot.x, y: GEAR.nosePivot.y, z: GEAR.nosePivot.z };
const NOSE_AXLE_DOWN = { x: GEAR.noseAxle.x, y: GEAR.noseAxle.y, z: GEAR.noseAxle.z };
const NOSE_LEG = NOSE_PIVOT.y - NOSE_AXLE_DOWN.y;
const NOSE_RETRACT = M.noseGearRetractDeg * (Math.PI / 180);
/** Drag brace: fixed anchor on the well roof aft of the leg, attach point on the leg (leg frame, from the pivot). */
const BRACE_ANCHOR = { x: 0, y: -0.28, z: NOSE_PIVOT.z + 0.23 };
const BRACE_ON_LEG = { x: 0, y: -0.18, z: 0.03 };

function rotX(p: Vec3, a: number, out: THREE.Vector3): THREE.Vector3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return out.set(p.x, p.y * c - p.z * s, p.y * s + p.z * c);
}
const _braceDown = rotX(BRACE_ON_LEG, 0, new THREE.Vector3()).add(new THREE.Vector3(NOSE_PIVOT.x, NOSE_PIVOT.y, NOSE_PIVOT.z));
const BRACE_SPAN = _braceDown.distanceTo(new THREE.Vector3(BRACE_ANCHOR.x, BRACE_ANCHOR.y, BRACE_ANCHOR.z));

export const NOSE_GEAR = {
  pivot: NOSE_PIVOT,
  axleDown: NOSE_AXLE_DOWN,
  /** Pivot → axle, m. */
  legLength: NOSE_LEG,
  retractRad: NOSE_RETRACT,
  wheelStowed: (() => {
    const w = rotX({ x: 0, y: -NOSE_LEG, z: NOSE_AXLE_DOWN.z - NOSE_PIVOT.z }, -NOSE_RETRACT, new THREE.Vector3());
    return { x: NOSE_PIVOT.x + w.x, y: NOSE_PIVOT.y + w.y, z: NOSE_PIVOT.z + w.z };
  })(),
  braceAnchor: BRACE_ANCHOR,
  braceOnLeg: BRACE_ON_LEG,
  /** Link lengths: straight (just short of over-centre) with the gear down. */
  braceUpper: BRACE_SPAN * 0.5,
  braceLower: BRACE_SPAN * 0.5 + 1e-3,
} as const;

// ─── Belly openings (plan view) ──────────────────────────────────────────────

export const WELL = {
  main: {
    /** Wheel opening: circle round the stowed wheel. */
    cx: MAIN_GEAR.wheelStowed.x,
    cz: MAIN_GEAR.wheelStowed.z,
    r: G.mainWheelRadius + 0.018,
    /** Leg slot: from just outboard of the pivot to the wheel opening. */
    slotX0: PIVOT.x + 0.004,
    slotZ0: PIVOT.z,
    slotHalfWidth: 0.046,
  },
  nose: {
    /** Opening under the clamshell doors (the doors overlap it by ~1 cm all round). */
    halfWidth: 0.1,
    z0: -1.32,
    z1: -0.38,
    /** Well roof height. */
    roofY: -0.17,
  },
} as const;

function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz)));
  const ex = px - ax - t * dx;
  const ez = pz - az - t * dz;
  return Math.sqrt(ex * ex + ez * ez);
}

/** Signed plan-view distance (m) into the belly openings: > 0 inside a well or slot, < 0 on skin. */
export function wellCutDistance(x: number, z: number): number {
  const m = WELL.main;
  const ax = Math.abs(x);
  const wheel = m.r - Math.sqrt((ax - m.cx) * (ax - m.cx) + (z - m.cz) * (z - m.cz));
  const slot = m.slotHalfWidth - segDist(ax, z, m.slotX0, m.slotZ0, m.cx, m.cz);
  const n = WELL.nose;
  const nose = Math.min(n.halfWidth - ax, z - n.z0, n.z1 - z);
  return Math.max(wheel, slot, nose);
}

// ─── Poses ───────────────────────────────────────────────────────────────────

export interface MainGearPose {
  /** Leg foot (axle stub root) and wheel centre, body frame. */
  foot: THREE.Vector3;
  wheel: THREE.Vector3;
  /** Orientation of the leg mesh (built along local +Y from the pivot), and its length scale. */
  legQuat: THREE.Quaternion;
  legScale: number;
  /** Orientation of the axle fitting (local +X·side = outboard axle) and its outward unit direction. */
  axleQuat: THREE.Quaternion;
  axleDir: THREE.Vector3;
}

export function createMainGearPose(): MainGearPose {
  return {
    foot: new THREE.Vector3(),
    wheel: new THREE.Vector3(),
    legQuat: new THREE.Quaternion(),
    legScale: 1,
    axleQuat: new THREE.Quaternion(),
    axleDir: new THREE.Vector3(1, 0, 0),
  };
}

const Y = new THREE.Vector3(0, 1, 0);
/**
 * Hinge axis tilt: the retraction is a rotation about ONE fixed axis through the
 * pivot. Of all the axes that carry the leg from down to stowed, this one (tilted
 * out of the minimal-rotation axis toward the leg bisector) swings the wheel aft
 * through the air and lifts it straight up into its well: no clipping through the
 * skin anywhere along the path (tested).
 */
const HINGE_TILT = -0.9;
function mainConsts(side: -1 | 1) {
  const P = new THREE.Vector3(side * PIVOT.x, PIVOT.y, PIVOT.z);
  const fDown = new THREE.Vector3(side * FOOT_DOWN.x, FOOT_DOWN.y, FOOT_DOWN.z);
  const fUp = new THREE.Vector3(side * STOWED.foot.x, STOWED.foot.y, STOWED.foot.z);
  const uDown = fDown.clone().sub(P).normalize();
  const uUp = fUp.clone().sub(P).normalize();
  const n1 = uDown.clone().cross(uUp).normalize();
  const n2 = uDown.clone().add(uUp).normalize();
  const hinge = n1.multiplyScalar(Math.cos(HINGE_TILT)).addScaledVector(n2, Math.sin(HINGE_TILT)).normalize();
  const pd = uDown.clone().addScaledVector(hinge, -hinge.dot(uDown)).normalize();
  const pu = uUp.clone().addScaledVector(hinge, -hinge.dot(uUp)).normalize();
  let angle = Math.acos(Math.max(-1, Math.min(1, pd.dot(pu))));
  if (pd.clone().cross(pu).dot(hinge) < 0) angle = -angle;
  const aUp = new THREE.Vector3(side * STOWED.axle.x, STOWED.axle.y, STOWED.axle.z);
  return {
    P,
    uDown,
    hinge,
    angle,
    qLeg0: new THREE.Quaternion().setFromUnitVectors(Y, uDown),
    qAxle: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(side, 0, 0), aUp),
    axle0: new THREE.Vector3(side, 0, 0),
  };
}
const MAINS = { [-1]: mainConsts(-1), [1]: mainConsts(1) } as Record<-1 | 1, ReturnType<typeof mainConsts>>;
/** Hinge axis (unit, body frame) and total swing angle of each main leg. */
export function mainGearHinge(side: -1 | 1): { axis: Vec3; angle: number } {
  const k = MAINS[side < 0 ? -1 : 1];
  return { axis: { x: k.hinge.x, y: k.hinge.y, z: k.hinge.z }, angle: k.angle };
}
const _I = new THREE.Quaternion();
const _q = new THREE.Quaternion();
const _u = new THREE.Vector3();
const _d = new THREE.Vector3();

/**
 * Pose of a main gear at retraction `retract` (0 = down and locked … 1 = stowed)
 * with strut compression `compression` m (applied only as the leg nears down).
 * The leg swings about its fixed hinge axis; the axle fitting turns the wheel
 * flat over the first ~85 % of the swing so it rises into the well flat.
 */
export function mainGearPose(side: -1 | 1, retract: number, compression: number, out: MainGearPose): MainGearPose {
  const k = MAINS[side < 0 ? -1 : 1];
  const s = clamp01(retract);
  const c = Math.min(G.strutTravel, Math.max(0, finiteOr(compression, 0))) * (1 - smoothstep(0, 0.05, s));
  _q.setFromAxisAngle(k.hinge, k.angle * s);
  _u.copy(k.uDown).applyQuaternion(_q);
  out.foot.copy(k.P).addScaledVector(_u, LEG_LEN);
  out.foot.y += c;
  _d.copy(out.foot).sub(k.P);
  const len = _d.length();
  out.legScale = len / LEG_LEN;
  _d.divideScalar(len);
  // legQuat = aim(compression) · swing(s) · rest.
  out.legQuat.copy(k.qLeg0).premultiply(_q);
  _q.setFromUnitVectors(_u, _d);
  out.legQuat.premultiply(_q);
  out.axleQuat.slerpQuaternions(_I, k.qAxle, smoothstep(0.04, 0.86, s));
  out.axleDir.copy(k.axle0).applyQuaternion(out.axleQuat);
  out.wheel.copy(out.foot).addScaledVector(out.axleDir, STUB);
  return out;
}

export interface NoseGearPose {
  /** Leg swing about +X (negative = wheel aft), rad. */
  swingRad: number;
  /** Oleo compression (lower strut slides up), m. */
  slide: number;
  steerRad: number;
  /** Axle centre, body frame. */
  wheel: THREE.Vector3;
  /** Folding drag brace: knee and the attach point on the leg (the anchor is fixed: NOSE_GEAR.braceAnchor). */
  braceKnee: THREE.Vector3;
  braceAttach: THREE.Vector3;
}

export function createNoseGearPose(): NoseGearPose {
  return { swingRad: 0, slide: 0, steerRad: 0, wheel: new THREE.Vector3(), braceKnee: new THREE.Vector3(), braceAttach: new THREE.Vector3() };
}

const _p = new THREE.Vector3();
const _anchor = new THREE.Vector3(BRACE_ANCHOR.x, BRACE_ANCHOR.y, BRACE_ANCHOR.z);

export function noseGearPose(retract: number, compression: number, steerRad: number, out: NoseGearPose): NoseGearPose {
  const s = clamp01(retract);
  const down = 1 - smoothstep(0, 0.05, s);
  out.swingRad = -s * NOSE_RETRACT;
  out.slide = Math.min(G.strutTravel, Math.max(0, finiteOr(compression, 0))) * down;
  out.steerRad = s > 0 ? 0 : Math.max(-1, Math.min(1, finiteOr(steerRad, 0)));
  rotX({ x: 0, y: -NOSE_LEG + out.slide, z: NOSE_AXLE_DOWN.z - NOSE_PIVOT.z }, out.swingRad, _p);
  out.wheel.set(NOSE_PIVOT.x + _p.x, NOSE_PIVOT.y + _p.y, NOSE_PIVOT.z + _p.z);
  // Drag brace: two links anchor → knee → attach; the knee folds forward/up as the leg swings aft.
  rotX(BRACE_ON_LEG, out.swingRad, _p);
  out.braceAttach.set(NOSE_PIVOT.x + _p.x, NOSE_PIVOT.y + _p.y, NOSE_PIVOT.z + _p.z);
  const l1 = NOSE_GEAR.braceUpper;
  const l2 = NOSE_GEAR.braceLower;
  const dy = out.braceAttach.y - _anchor.y;
  const dz = out.braceAttach.z - _anchor.z;
  const d = Math.max(1e-6, Math.min(l1 + l2 - 1e-9, Math.hypot(dy, dz)));
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const ey = dy / d;
  const ez = dz / d;
  // Perpendicular (−ez, ey) points up/forward of the anchor→attach line with the leg down.
  out.braceKnee.set(_anchor.x, _anchor.y + ey * a - ez * h, _anchor.z + ez * a + ey * h);
  return out;
}
