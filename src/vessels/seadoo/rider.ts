/**
 * The Sea-Doo's rider: one skinned mesh (one draw call) on a flat 13-bone rig — pelvis, torso,
 * head, upper / fore arms, thighs, shins, feet — every bone a direct child of the rider group and
 * posed in the body frame each frame by `solveRiderPose` (no allocations):
 *
 *   seat        the pelvis sits on the seat; `lean` (−1 port … +1 starboard) rolls the hips and more
 *               so the torso into the turn and slides the hips across; the head stays more upright
 *   fore / aft  `fwd` (−1 sitting back … +1 crouched over the bars) slides the hips and pitches the
 *               torso: forward and lower, or back and upright
 *   arms        two-bone IK from the shoulders to the bar grips (gripPosition, they follow the bars);
 *               if a grip is out of reach the torso leans further forward until it isn't
 *   legs        two-bone IK from the hips to the feet planted in the footwells, knees forward and out
 *
 * The rig is placed so that, in the neutral pose, the eye point in the head is exactly
 * geometry.pilotEye (the helm camera): the model hides the head in the cockpit view by scaling the
 * head bone to nothing. Bone geometry is authored in each bone's local frame (+Y along the segment,
 * −Z the front), so the bind matrices are all identity.
 *
 * Also: the swimmer (helmet and vest in the water) shown beside the craft when the rider is off.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { tint, merge } from '../../aircraft/materials';
import { V, ellipsoid, tube } from '../../aircraft/f16/geom';
import { SEADOO_COLORS as C } from './materials';
import { EYE, SEADOO_SHAPE as S, clamp, floorY } from './shape';
import { gripPosition } from './helm';

const DEG = Math.PI / 180;

export const BONE = {
  pelvis: 0,
  torso: 1,
  head: 2,
  upperArmL: 3,
  foreArmL: 4,
  upperArmR: 5,
  foreArmR: 6,
  thighL: 7,
  shinL: 8,
  footL: 9,
  thighR: 10,
  shinR: 11,
  footR: 12,
} as const;
export const BONE_COUNT = 13;
export const BONE_NAMES = Object.keys(BONE) as (keyof typeof BONE)[];

/** Rider proportions (m) and posture. */
export const RIDER = {
  /** Hip centre → neck base, and the shoulder joints / hip joints in the torso / pelvis frames. */
  spine: 0.5,
  shoulder: { x: 0.19, y: 0.44, z: -0.02 },
  hipJoint: { x: 0.1, y: -0.02, z: 0 },
  upperArm: 0.33,
  /** Elbow → the hand's grip point. */
  foreArm: 0.37,
  thigh: 0.43,
  shin: 0.44,
  /** Eye point in the head frame (neck base = origin). */
  eye: { x: 0, y: 0.145, z: -0.09 },
  /** Helmet (centre and radii in the head frame): its crown is ~0.2 m above the eye. */
  helmet: { y: 0.19, z: 0.01, rx: 0.135, ry: 0.155, rz: 0.165 },
  /** Ankles in the footwells (body frame x, z); ankle height above the floor. */
  ankle: { x: 0.34, z: -0.02 + (EYE.z - 0.22), up: 0.09 },
  /** Neutral torso pitch forward, deg; with fwd = +1 / −1. */
  pitchDeg: 16,
  pitchFwdDeg: 36,
  pitchBackDeg: 4,
  /** Lean: pelvis roll, torso roll (total), hip slide (m) at |lean| = 1. */
  pelvisRollDeg: 14,
  torsoRollDeg: 21,
  leanSlide: 0.07,
  /** Fore / aft hip slide (m) at fwd = +1 / −1. */
  slideFwd: 0.1,
  slideBack: 0.05,
  /** Torso twist toward the turned bars (fraction of the bar angle), shoulder protraction when reaching (m). */
  twist: 0.5,
  protraction: 0.05,
} as const;

export interface RiderPose {
  pos: THREE.Vector3[];
  quat: THREE.Quaternion[];
  /** The eye point (body frame), the hand points and the grip targets. */
  eye: THREE.Vector3;
  hands: [THREE.Vector3, THREE.Vector3];
  grips: [THREE.Vector3, THREE.Vector3];
  /** Extra forward pitch the arms' reach needed, rad. */
  reachPitch: number;
}

export function createRiderPose(): RiderPose {
  return {
    pos: Array.from({ length: BONE_COUNT }, () => new THREE.Vector3()),
    quat: Array.from({ length: BONE_COUNT }, () => new THREE.Quaternion()),
    eye: new THREE.Vector3(),
    hands: [new THREE.Vector3(), new THREE.Vector3()],
    grips: [new THREE.Vector3(), new THREE.Vector3()],
    reachPitch: 0,
  };
}

// Scratch (module level: no per-frame allocation).
const _e = new THREE.Euler(0, 0, 0, 'ZYX');
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _d = new THREE.Vector3();
const _p = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _sh = [new THREE.Vector3(), new THREE.Vector3()];
const _elbow = new THREE.Vector3();
const _end = new THREE.Vector3();
const _hip = new THREE.Vector3();
const _pole = new THREE.Vector3();

/** Rotation whose local +Y points along `dir` (unit) and local +Z as close as possible to `zHint`. */
export function aimY(q: THREE.Quaternion, dir: THREE.Vector3, zHint: THREE.Vector3): THREE.Quaternion {
  _y.copy(dir);
  _z.copy(zHint).addScaledVector(_y, -zHint.dot(_y));
  if (_z.lengthSq() < 1e-8) {
    _z.set(0, 0, 1).addScaledVector(_y, -_y.z);
    if (_z.lengthSq() < 1e-8) _z.set(1, 0, 0).addScaledVector(_y, -_y.x);
  }
  _z.normalize();
  _x.crossVectors(_y, _z);
  _m.makeBasis(_x, _y, _z);
  return q.setFromRotationMatrix(_m);
}

/**
 * Two-bone IK: root a, target t, bone lengths l1, l2, bend toward `pole` (a direction). Writes the
 * middle joint and the reachable end point (t, or as close as the chain reaches).
 */
export function twoBone(a: THREE.Vector3, t: THREE.Vector3, l1: number, l2: number, pole: THREE.Vector3, mid: THREE.Vector3, end: THREE.Vector3): void {
  _d.subVectors(t, a);
  let dist = _d.length();
  if (dist < 1e-6) {
    _d.set(0, -1, 0);
    dist = 1e-6;
  } else _d.divideScalar(dist);
  const dc = clamp(dist, Math.abs(l1 - l2) + 1e-4, l1 + l2 - 1e-5);
  end.copy(a).addScaledVector(_d, dc);
  const cosA = clamp((l1 * l1 + dc * dc - l2 * l2) / (2 * l1 * dc), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  _p.copy(pole).addScaledVector(_d, -pole.dot(_d));
  if (_p.lengthSq() < 1e-10) _p.set(0, 1, 0).addScaledVector(_d, -_d.y);
  _p.normalize();
  mid.copy(a).addScaledVector(_d, l1 * cosA).addScaledVector(_p, l1 * sinA);
}

/** The hip centre in the neutral pose, found so the neutral eye lands on pilotEye (see below). */
const HIP_BASE = new THREE.Vector3(0, 0.462 + (EYE.y - 1.08), 0.438 + (EYE.z - 0.22));

/**
 * Pose the rider: lean −1..1, fwd −1..1 (already including any speed crouch), bars (rad, + = right).
 * Pure and allocation-free; writes `out`.
 */
export function solveRiderPose(lean: number, fwd: number, bars: number, out: RiderPose): RiderPose {
  const L = clamp(Number.isFinite(lean) ? lean : 0, -1, 1);
  const F = clamp(Number.isFinite(fwd) ? fwd : 0, -1, 1);
  const B = clamp(Number.isFinite(bars) ? bars : 0, -S.barMaxDeg * DEG * 1.2, S.barMaxDeg * DEG * 1.2);
  const R = RIDER;

  // Pelvis: slides across with the lean and fore / aft with fwd, rolls into the turn.
  const hip = out.pos[BONE.pelvis];
  hip.copy(HIP_BASE);
  hip.x += L * R.leanSlide;
  hip.y -= Math.abs(L) * 0.012 + Math.max(0, F) * 0.02;
  hip.z -= F > 0 ? F * R.slideFwd : F * R.slideBack;
  _e.set(-Math.max(0, F) * 6 * DEG, 0, -L * R.pelvisRollDeg * DEG, 'ZYX');
  out.quat[BONE.pelvis].setFromEuler(_e);

  // Torso: pitch from fwd (+ the reach correction), roll into the turn, a twist toward the turned bars.
  const basePitch = (F >= 0 ? R.pitchDeg + F * (R.pitchFwdDeg - R.pitchDeg) : R.pitchDeg + F * (R.pitchDeg - R.pitchBackDeg)) * DEG;
  const roll = -L * R.torsoRollDeg * DEG;
  const yaw = -B * R.twist;
  gripPosition(-1, B, out.grips[0]);
  gripPosition(1, B, out.grips[1]);
  const reach = (R.upperArm + R.foreArm) * 0.965;
  let extra = 0;
  const tq = out.quat[BONE.torso];
  for (let it = 0; it < 4; it++) {
    _e.set(-(basePitch + extra), yaw, roll, 'ZYX');
    tq.setFromEuler(_e);
    let excess = 0;
    for (let s = 0; s < 2; s++) {
      _sh[s].set((s === 0 ? -1 : 1) * R.shoulder.x, R.shoulder.y, R.shoulder.z).applyQuaternion(tq).add(hip);
      // Reaching: the shoulder itself comes forward a little toward the grip first.
      const d = _sh[s].distanceTo(out.grips[s]);
      const pro = clamp(d - reach * 0.97, 0, R.protraction);
      if (pro > 0) _sh[s].lerp(out.grips[s], pro / d);
      excess = Math.max(excess, d - pro - reach);
    }
    if (excess <= 1e-4 || extra >= 40 * DEG) break;
    extra = Math.min(40 * DEG, extra + excess / (R.shoulder.y * 0.95));
  }
  out.reachPitch = extra;
  out.pos[BONE.torso].copy(hip);

  // Head on the neck base: counters most of the torso pitch and roll (eyes on the horizon), looks into the turn.
  const neck = out.pos[BONE.head];
  neck.set(0, R.spine, 0).applyQuaternion(tq).add(hip);
  _e.set(-(basePitch + extra) * 0.3, yaw * 1.6, roll * 0.4, 'ZYX');
  out.quat[BONE.head].setFromEuler(_e);
  out.eye.set(R.eye.x, R.eye.y, R.eye.z).applyQuaternion(out.quat[BONE.head]).add(neck);

  // Arms: elbows out, down and back.
  for (let s = 0; s < 2; s++) {
    const side = s === 0 ? -1 : 1;
    const ua = s === 0 ? BONE.upperArmL : BONE.upperArmR;
    const fa = s === 0 ? BONE.foreArmL : BONE.foreArmR;
    _pole.set(side * 1, -0.8, 0.45);
    twoBone(_sh[s], out.grips[s], R.upperArm, R.foreArm, _pole, _elbow, _end);
    out.pos[ua].copy(_sh[s]);
    _v.subVectors(_elbow, _sh[s]).normalize();
    _w.set(0, 0, 1);
    aimY(out.quat[ua], _v, _w);
    out.pos[fa].copy(_elbow);
    _v.subVectors(_end, _elbow).normalize();
    _w.set(0, 1, 0);
    aimY(out.quat[fa], _v, _w);
    out.hands[s].copy(_end);
  }

  // Legs: hips → ankles in the footwells, knees forward, up and out.
  for (let s = 0; s < 2; s++) {
    const side = s === 0 ? -1 : 1;
    const th = s === 0 ? BONE.thighL : BONE.thighR;
    const sh = s === 0 ? BONE.shinL : BONE.shinR;
    const ft = s === 0 ? BONE.footL : BONE.footR;
    _hip.set(side * R.hipJoint.x, R.hipJoint.y, R.hipJoint.z).applyQuaternion(out.quat[BONE.pelvis]).add(hip);
    const ankle = out.pos[ft];
    ankle.set(side * R.ankle.x, floorY(R.ankle.z) + R.ankle.up, R.ankle.z);
    _pole.set(side * 0.45, 1, -0.7);
    twoBone(_hip, ankle, R.thigh, R.shin, _pole, _elbow, _end);
    out.pos[th].copy(_hip);
    _v.subVectors(_elbow, _hip).normalize();
    _w.set(0, 1, 0);
    aimY(out.quat[th], _v, _w);
    out.pos[sh].copy(_elbow);
    _v.subVectors(_end, _elbow).normalize();
    _w.set(0, 0, -1);
    aimY(out.quat[sh], _v, _w);
    ankle.copy(_end);
    // Feet flat, toes a little out.
    _e.set(0, -side * 10 * DEG, 0, 'ZYX');
    out.quat[ft].setFromEuler(_e);
  }
  return out;
}

// Place the rig: iterate the neutral pose so its eye is exactly pilotEye.
{
  const pose = createRiderPose();
  for (let i = 0; i < 4; i++) {
    solveRiderPose(0, 0, 0, pose);
    HIP_BASE.add(_v.set(EYE.x - pose.eye.x, EYE.y - pose.eye.y, EYE.z - pose.eye.z));
  }
}

/** The neutral hip centre (body frame), after placing the eye on pilotEye. */
export function riderHipBase(out = new THREE.Vector3()): THREE.Vector3 {
  return out.copy(HIP_BASE);
}

// ── Geometry (bone-local) ──────────────────────────────────────────────────

/** A limb segment along +Y from 0 to len (rounded ends), radius r0 → r1. */
function limb(len: number, r0: number, r1: number, hex: number, rough = 0.7): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  const n = 5;
  for (let i = 0; i <= n; i++) {
    const a = -Math.PI / 2 + ((Math.PI / 2) * i) / n;
    pts.push(new THREE.Vector2(r0 * Math.cos(a), r0 * Math.sin(a)));
  }
  for (let i = 0; i <= n; i++) {
    const a = ((Math.PI / 2) * i) / n;
    pts.push(new THREE.Vector2(r1 * Math.cos(a), len + r1 * Math.sin(a)));
  }
  pts[0].x = 0;
  pts[pts.length - 1].x = 0;
  return tint(new THREE.LatheGeometry(pts, 12), hex, rough);
}

/** Rounded box-ish body section loft along +Y: rings of superellipses (half-width, half-depth, z offset). */
function bodyLoft(rings: [number, number, number, number][], hex: number, rough: number, n = 3, segs = 20): THREE.BufferGeometry {
  // rings: [y, halfWidth, halfDepth, zCentre]
  const e = 2 / n;
  const pos: number[] = [];
  const idx: number[] = [];
  const cols = segs + 1;
  rings.forEach(([y, hw, hd, zc]) => {
    for (let j = 0; j <= segs; j++) {
      const a = (2 * Math.PI * j) / segs;
      const c = Math.cos(a);
      const s = Math.sin(a);
      pos.push(hw * Math.sign(c) * Math.pow(Math.abs(c), e), y, zc + hd * Math.sign(s) * Math.pow(Math.abs(s), e));
    }
  });
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < segs; j++) {
      const a = i * cols + j;
      const b = a + cols;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return tint(g, hex, rough);
}

/** Helmet (white shell, orange crown stripe, chin bar) and the dark visor, in the head frame. */
export function helmetGeometry(): THREE.BufferGeometry {
  const H = RIDER.helmet;
  const shell = tint(ellipsoid(V(0, H.y, H.z), H.rx, H.ry, H.rz, 24, 16), C.helmet, 0.22, 0.05);
  // Visor: a band of a slightly larger ellipsoid across the front (SphereGeometry: phi = 3π/2 faces
  // −Z), at eye level (theta from the top).
  const visor = new THREE.SphereGeometry(1, 24, 6, Math.PI * 1.5 - Math.PI * 0.33, Math.PI * 0.66, Math.PI * 0.43, Math.PI * 0.22);
  visor.scale(H.rx + 0.006, H.ry + 0.006, H.rz + 0.006);
  visor.translate(0, H.y, H.z);
  // Orange stripe over the crown, front to back.
  const crown = [Math.PI * 1.5, Math.PI * 0.5].map((phi) => {
    const g = new THREE.SphereGeometry(1, 4, 10, phi - 0.1, 0.2, 0, Math.PI * 0.5);
    g.scale(H.rx + 0.003, H.ry + 0.003, H.rz + 0.003);
    g.translate(0, H.y, H.z);
    return tint(g, C.orange, 0.3);
  });
  const chin = ellipsoid(V(0, H.y - 0.105, H.z - 0.1), 0.095, 0.055, 0.062, 16, 10);
  return merge([shell, tint(visor, C.visor, 0.08, 0.7), ...crown, tint(chin, C.helmet, 0.25, 0.05)]);
}

/** The rider's bone-local geometries (one list per bone). */
function riderParts(): THREE.BufferGeometry[][] {
  const R = RIDER;
  const parts: THREE.BufferGeometry[][] = Array.from({ length: BONE_COUNT }, () => []);
  // Pelvis: hips / shorts.
  parts[BONE.pelvis].push(tint(ellipsoid(V(0, -0.005, 0.015), 0.18, 0.11, 0.15, 18, 12), C.suit, 0.75));
  // Torso: wetsuit trunk, the bright life vest over it with black straps, shoulders.
  parts[BONE.torso].push(tint(ellipsoid(V(0, 0.2, 0.01), 0.165, 0.2, 0.12, 18, 12), C.suit, 0.75));
  parts[BONE.torso].push(
    bodyLoft(
      [
        [0.1, 0.175, 0.13, 0.01],
        [0.18, 0.2, 0.145, 0.0],
        [0.3, 0.215, 0.15, -0.005],
        [0.4, 0.21, 0.14, 0.0],
        [0.46, 0.175, 0.12, 0.01],
        [0.5, 0.11, 0.09, 0.015],
        [0.515, 0.06, 0.06, 0.02],
      ],
      C.vest,
      0.6,
      3,
      24,
    ),
  );
  for (const y of [0.17, 0.27]) {
    parts[BONE.torso].push(bodyLoft([[y, 0.203, 0.149, -0.001], [y + 0.022, 0.21, 0.152, -0.003]], C.black, 0.6, 3, 24));
  }
  parts[BONE.torso].push(tint(new THREE.TorusGeometry(0.055, 0.02, 8, 16).rotateX(Math.PI / 2).translate(0, 0.5, 0.015), C.black, 0.6));
  for (const side of [1, -1]) parts[BONE.torso].push(tint(ellipsoid(V(side * R.shoulder.x, R.shoulder.y - 0.01, R.shoulder.z + 0.02), 0.08, 0.072, 0.08, 12, 8), C.vest, 0.6));
  // Head: neck, helmet, visor.
  parts[BONE.head].push(tint(tube(V(0, -0.02, 0.015), V(0, 0.09, 0.0), 0.066, 0.058, 12), C.suit, 0.7));
  parts[BONE.head].push(helmetGeometry());
  // Arms: sleeves and gloves (a fist round the grip at the forearm's end).
  for (const [ua, fa] of [
    [BONE.upperArmL, BONE.foreArmL],
    [BONE.upperArmR, BONE.foreArmR],
  ]) {
    parts[ua].push(limb(R.upperArm, 0.06, 0.05, C.suit));
    parts[fa].push(limb(R.foreArm - 0.06, 0.049, 0.04, C.suit));
    parts[fa].push(tint(ellipsoid(V(0, R.foreArm - 0.035, 0), 0.048, 0.062, 0.044, 12, 8), C.glove, 0.8));
    parts[fa].push(tint(tube(V(0, R.foreArm - 0.11, 0), V(0, R.foreArm - 0.06, 0), 0.05, 0.046, 12), C.glove, 0.8));
  }
  // Legs: thighs, shins, boots.
  for (const [th, sh, ft] of [
    [BONE.thighL, BONE.shinL, BONE.footL],
    [BONE.thighR, BONE.shinR, BONE.footR],
  ]) {
    parts[th].push(limb(R.thigh, 0.1, 0.07, C.suit));
    parts[th].push(tint(ellipsoid(V(0, R.thigh, 0.0), 0.072, 0.06, 0.074, 12, 8), C.black, 0.6));
    parts[sh].push(limb(R.shin, 0.068, 0.05, C.suit));
    parts[sh].push(tint(tube(V(0, R.shin - 0.15, 0), V(0, R.shin, 0), 0.058, 0.062, 12), C.boot, 0.7));
    parts[ft].push(tint(ellipsoid(V(0, -0.045, -0.055), 0.052, 0.05, 0.125, 14, 8), C.boot, 0.7));
    parts[ft].push(tint(new THREE.BoxGeometry(0.1, 0.018, 0.25).translate(0, -0.083, -0.055), 0x111214, 0.9));
  }
  return parts;
}

export interface RiderRig {
  mesh: THREE.SkinnedMesh;
  bones: THREE.Bone[];
  pose: RiderPose;
}

/** Build the skinned rider into `parent` (bones + mesh as its children). */
export function buildRider(parent: THREE.Object3D, material: THREE.Material, name: string): RiderRig {
  const lists = riderParts();
  const perBone: THREE.BufferGeometry[] = [];
  lists.forEach((list, b) => {
    if (list.length === 0) return;
    const g = merge(list);
    const n = g.getAttribute('position').count;
    const si = new Uint16Array(n * 4);
    const sw = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      si[i * 4] = b;
      sw[i * 4] = 1;
    }
    g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
    perBone.push(g);
  });
  const geo = mergeGeometries(perBone, false)!;
  for (const g of perBone) g.dispose();

  const bones = BONE_NAMES.map((n) => {
    const b = new THREE.Bone();
    b.name = `${name}.${n}`;
    parent.add(b);
    return b;
  });
  const mesh = new THREE.SkinnedMesh(geo, material);
  mesh.name = `${name}.body`;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // Bones move everywhere: the bind-pose bounds mean nothing; the rider is small, never cull it.
  mesh.frustumCulled = false;
  parent.add(mesh);
  mesh.bind(new THREE.Skeleton(bones, bones.map(() => new THREE.Matrix4())), new THREE.Matrix4());
  return { mesh, bones, pose: createRiderPose() };
}

/** Copy a pose onto the bones (head scale: 1 shown, ~0 hidden for the cockpit view). */
export function applyRiderPose(rig: RiderRig, pose: RiderPose, headScale: number): void {
  for (let i = 0; i < BONE_COUNT; i++) {
    rig.bones[i].position.copy(pose.pos[i]);
    rig.bones[i].quaternion.copy(pose.quat[i]);
  }
  rig.bones[BONE.head].scale.setScalar(headScale);
}

/**
 * The swimmer: helmet, shoulders in the vest and arms out, treading water. Local frame: y = 0 at
 * the water surface, facing −Z.
 */
export function buildSwimmer(): THREE.BufferGeometry {
  const H = RIDER.helmet;
  const helmet = helmetGeometry();
  // Head frame → swimmer frame: helmet centre ~0.2 m above the water.
  helmet.translate(0, 0.2 - H.y + 0.02, 0);
  const vest = tint(ellipsoid(V(0, -0.04, 0), 0.21, 0.13, 0.15, 18, 10), C.vest, 0.6);
  const collar = tint(new THREE.TorusGeometry(0.06, 0.022, 8, 16).rotateX(Math.PI / 2).translate(0, 0.07, 0.01), C.black, 0.6);
  const arms: THREE.BufferGeometry[] = [];
  for (const side of [1, -1]) {
    const a = V(side * 0.2, 0.0, 0);
    const e = V(side * 0.46, -0.02, -0.12);
    const h = V(side * 0.62, -0.03, -0.3);
    arms.push(tint(tube(a, e, 0.05, 0.043, 10), C.suit, 0.7));
    arms.push(tint(tube(e, h, 0.042, 0.035, 10), C.suit, 0.7));
    arms.push(tint(ellipsoid(h, 0.04, 0.03, 0.055, 10, 6), C.glove, 0.8));
  }
  return merge([helmet, vest, collar, ...arms]);
}
