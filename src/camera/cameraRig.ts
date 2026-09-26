/**
 * PURE camera rig: aircraft pose + mouse input → CameraPose for four modes, with smooth
 * transitions, ground clearance, teleport snapping and optional shake. No three.js here —
 * threeCamera.ts copies the pose onto a THREE.PerspectiveCamera.
 *
 * Pose quaternions use the three.js camera convention (looks down local -Z, +Y up), which is
 * also the aircraft body convention, so the cockpit reuses the aircraft orientation directly.
 *
 * Modes
 *   cockpit  — pilot eye point; orientation = aircraft × head look × look-down. Drag = head look
 *              (clamped), eases back to centre when released. Wheel zooms the FOV.
 *   chase    — behind/above along the aircraft's horizontal heading. Critically damped springs on
 *              azimuth/elevation/radius around the aircraft (so it swings round in turns and never
 *              lags with speed), looks slightly ahead, banks partially. Drag orbits temporarily.
 *   external — fly-by: parked at an anchor ahead along the velocity, watching the aircraft pass
 *              with the FOV narrowing with distance; re-anchors once far and receding. On the
 *              ground at low speed: a spotter ~40 m off the side.
 *   orbit    — spherical orbit in world space; drag rotates, wheel zooms, pitch clamped, slow
 *              auto-rotate after a few seconds without input.
 *
 * Every function returns new objects and never mutates its inputs.
 */
import type { CameraMode, Quat, Vec3 } from '../types';
import { CONFIG, type Config } from '../config';
import { clamp, expApproach, lerp, smoothstep, vLerp } from '../math/vec3';
import { qFromAxisAngle, qMul, qNormalize, qRotate, qSlerp } from '../math/quat';
import { eulerFromQuat } from '../physics/frames';
import { dirFromAngles, easeInOut, lookRotation, springStep, wrapPi } from './cameraMath';

const DEG = Math.PI / 180;
const AXIS_X: Vec3 = { x: 1, y: 0, z: 0 };
const AXIS_Y: Vec3 = { x: 0, y: 1, z: 0 };
const AXIS_Z: Vec3 = { x: 0, y: 0, z: 1 };
const BODY_FWD: Vec3 = { x: 0, y: 0, z: -1 };
const MODE_CYCLE: readonly CameraMode[] = ['cockpit', 'chase', 'external', 'orbit'];
/** Time constant (s) for lowering a camera again after the ground pushed it up. */
const GROUND_LIFT_RELAX_TAU = 0.35;

export interface CameraPose {
  position: Vec3;
  quaternion: Quat;
  /** Vertical field of view, degrees. */
  fov: number;
}

export interface CameraTarget {
  /** Interpolated aircraft CG position (world). */
  position: Vec3;
  /** Aircraft body → world orientation. */
  orientation: Quat;
  /** World velocity, m/s. */
  velocity: Vec3;
  onGround: boolean;
}

export interface CameraInput {
  /** Mouse drag delta this frame, CSS pixels (+x right, +y down). */
  dx: number;
  dy: number;
  /** Wheel notches this frame (+ = zoom out). */
  wheel: number;
  dragging: boolean;
  /** 0..1 shake intensity from the app (see shakeTarget()). */
  shake: number;
}

export interface CameraTransition {
  /** Start pose position relative to the target, so the blend travels with a moving aircraft. */
  fromOffset: Vec3;
  fromQuat: Quat;
  fromFov: number;
  /** Seconds since the transition started. */
  elapsed: number;
}

export interface CockpitCamState {
  /** Head look, radians (+ yaw = right, + pitch = up). */
  yaw: number;
  pitch: number;
  fov: number;
}

export interface ChaseCamState {
  /** Sprung spherical coordinates around the aircraft (null = initialise at the desired values). */
  azimuth: number | null;
  azimuthVel: number;
  elevation: number;
  elevationVel: number;
  radius: number;
  radiusVel: number;
  /** Temporary mouse orbit, radians; springs back to 0 when released. */
  dragYaw: number;
  dragPitch: number;
  /** Wheel zoom factor. */
  zoom: number;
  /** Current camera bank, radians (+ = right side down). */
  bank: number;
  /** Last valid heading (radians), fallback for degenerate attitudes. */
  heading: number;
  /** Extra height (m) added to keep clear of the ground; relaxes smoothly. */
  lift: number;
}

export interface ExternalCamState {
  anchor: Vec3 | null;
  spotter: boolean;
  /** Side of the flight path for the next anchor (+1 right, -1 left). */
  side: number;
  fov: number | null;
}

export interface OrbitCamState {
  /** Radians, clockwise from north: direction from the aircraft to the camera. null = start behind. */
  azimuth: number | null;
  elevation: number;
  distance: number;
  /** Seconds since the last drag/wheel input. */
  idle: number;
  lift: number;
}

export interface CameraRigState {
  mode: CameraMode;
  transition: CameraTransition | null;
  /** Last output pose (before shake). */
  lastPose: CameraPose | null;
  lastTargetPosition: Vec3 | null;
  /** Next update snaps (after a reset/teleport). */
  snapPending: boolean;
  /** Seconds of rig time (drives the deterministic shake noise). */
  time: number;
  /** Current shake intensity 0..1 (rises instantly to the input, decays at shake.decay). */
  trauma: number;
  cockpit: CockpitCamState;
  chase: ChaseCamState;
  external: ExternalCamState;
  orbit: OrbitCamState;
}

// ─── Construction & mode changes ───────────────────────────────────────────────

function freshCockpit(cfg: Config, fov?: number): CockpitCamState {
  return { yaw: 0, pitch: 0, fov: fov ?? cfg.camera.cockpit.fov };
}

function freshChase(cfg: Config, zoom = 1, heading = 0): ChaseCamState {
  const c = cfg.camera.chase;
  return {
    azimuth: null, azimuthVel: 0,
    elevation: Math.atan2(c.height, c.distance), elevationVel: 0,
    radius: Math.hypot(c.distance, c.height) * zoom, radiusVel: 0,
    dragYaw: 0, dragPitch: 0, zoom, bank: 0, heading, lift: 0,
  };
}

function freshExternal(side = 1): ExternalCamState {
  return { anchor: null, spotter: false, side, fov: null };
}

function freshOrbit(cfg: Config): OrbitCamState {
  const o = cfg.camera.orbit;
  return { azimuth: null, elevation: o.pitchDeg * DEG, distance: o.distance, idle: 0, lift: 0 };
}

export function createCameraRig(mode: CameraMode = 'chase', cfg: Config = CONFIG): CameraRigState {
  return {
    mode,
    transition: null,
    lastPose: null,
    lastTargetPosition: null,
    snapPending: false,
    time: 0,
    trauma: 0,
    cockpit: freshCockpit(cfg),
    chase: freshChase(cfg),
    external: freshExternal(),
    orbit: freshOrbit(cfg),
  };
}

/** Switch mode; blends smoothly from the last output pose over config.camera.transitionTime. */
export function setCameraMode(state: CameraRigState, mode: CameraMode): CameraRigState {
  if (mode === state.mode) return state;
  const last = state.lastPose;
  const lt = state.lastTargetPosition;
  const transition: CameraTransition | null = last && lt
    ? {
      fromOffset: { x: last.position.x - lt.x, y: last.position.y - lt.y, z: last.position.z - lt.z },
      fromQuat: { ...last.quaternion },
      fromFov: last.fov,
      elapsed: 0,
    }
    : null;
  const next: CameraRigState = { ...state, mode, transition };
  // Each mode starts from its natural framing when entered.
  switch (mode) {
    case 'cockpit': next.cockpit = { ...state.cockpit, yaw: 0, pitch: 0 }; break;
    case 'chase': next.chase = freshChase(CONFIG, state.chase.zoom, state.chase.heading); break;
    case 'external': next.external = freshExternal(state.external.side); break;
    case 'orbit': next.orbit = { ...state.orbit, azimuth: null, idle: 0, lift: 0 }; break;
  }
  return next;
}

/** cockpit → chase → external → orbit → cockpit */
export function nextCameraMode(state: CameraRigState): CameraRigState {
  const i = MODE_CYCLE.indexOf(state.mode);
  return setCameraMode(state, MODE_CYCLE[(i + 1) % MODE_CYCLE.length]);
}

/** After a reset/teleport: the next update puts the camera straight into place (no lag, no transition). */
export function snapCamera(state: CameraRigState): CameraRigState {
  return { ...state, snapPending: true, transition: null };
}

// ─── Shake helper ──────────────────────────────────────────────────────────────

export interface ShakeSources {
  onGround: boolean;
  /** Ground speed, m/s. */
  groundSpeed: number;
  stalled: boolean;
  /** Seconds since a crash, or null when not crashed. */
  crashAge: number | null;
  /** Helicopters: rotor vibration 0..1 (see rotorVibration). */
  rotorVibration?: number;
}

/**
 * Helicopter vibration felt in the cabin, 0..1: the shudder through translational lift (10–22 kt
 * of airspeed, while the rotor carries the aircraft), the vortex-ring buffet and retreating-blade
 * stall. Pure.
 */
export function rotorVibration(r: { vrs: number; bladeStall: number; thrust: number }, iasKt: number, weightN: number, airborne: boolean): number {
  const fin = (v: number) => (Number.isFinite(v) ? v : 0);
  const loaded = airborne && weightN > 0 ? clamp(fin(r.thrust) / weightN, 0, 1.5) : 0;
  const ias = fin(iasKt);
  const etl = ias > 8 && ias < 24 ? Math.sin(((ias - 8) / 16) * Math.PI) * 0.12 * Math.min(1, loaded) : 0;
  return clamp(Math.max(etl, 0.45 * fin(r.vrs), 0.5 * fin(r.bladeStall)), 0, 1);
}

/** Shake intensity 0..1 for CameraInput.shake from the flight situation (config.camera.shake). */
export function shakeTarget(src: ShakeSources, cfg: Config = CONFIG): number {
  const s = cfg.camera.shake;
  let v = 0;
  if (src.onGround && src.groundSpeed > 0 && s.groundRollSpeed > 0) {
    v = Math.max(v, s.groundRoll * clamp(src.groundSpeed / s.groundRollSpeed, 0, 1));
  }
  if (src.stalled) v = Math.max(v, s.stall);
  if (src.rotorVibration !== undefined && Number.isFinite(src.rotorVibration)) v = Math.max(v, clamp(src.rotorVibration, 0, 1));
  if (src.crashAge !== null && src.crashAge >= 0 && Number.isFinite(src.crashAge)) {
    v = Math.max(v, s.crash * Math.exp(-s.decay * src.crashAge));
  }
  return clamp(v, 0, 1);
}

// ─── Update ──────────────────────────────────────────────────────────────────

const finite = (v: number, fallback = 0) => (Number.isFinite(v) ? v : fallback);
const finiteVec = (v: Vec3 | undefined, fallback: Vec3): Vec3 =>
  v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z) ? { x: v.x, y: v.y, z: v.z } : { ...fallback };

/** Horizontal heading (radians, clockwise from north) of an attitude; continuous through vertical attitudes. */
function headingOf(q: Quat, fallback: number): number {
  const f = qRotate(q, BODY_FWD);
  const u = qRotate(q, AXIS_Y);
  const hl = Math.hypot(f.x, f.z);
  // Near vertical the nose's horizontal projection vanishes; blend in the belly/back direction.
  const w = hl < 0.3 ? (1 - hl / 0.3) ** 2 : 0;
  const s = f.y >= 0 ? 1 : -1;
  const hx = f.x - w * s * u.x;
  const hz = f.z - w * s * u.z;
  if (hx * hx + hz * hz < 1e-12) return fallback;
  return Math.atan2(hx, -hz);
}

/** Target bank for the chase camera: bankFollow × roll, fading to 0 when inverted (no flip at ±180°). */
function chaseBankTarget(rollDeg: number, follow: number): number {
  const a = Math.abs(rollDeg);
  const taper = a > 90 ? (180 - a) / 90 : 1;
  return follow * rollDeg * taper * DEG;
}

interface Ctx {
  cfg: Config;
  dt: number;
  snap: boolean;
  target: CameraTarget;
  input: CameraInput;
  ground: (x: number, z: number) => number;
}

/** Raise a sprung camera over the ground: lift jumps up when needed, relaxes down smoothly. */
function groundLift(prevLift: number, pos: Vec3, ctx: Ctx, snap: boolean): number {
  const g = ctx.ground(pos.x, pos.z);
  const need = Number.isFinite(g) ? Math.max(0, g + ctx.cfg.camera.groundClearance - pos.y) : 0;
  if (need >= prevLift || snap) return need;
  const relaxed = expApproach(prevLift, need, GROUND_LIFT_RELAX_TAU, ctx.dt);
  // Never let relaxing sink it below the clearance.
  return Math.max(need, relaxed);
}

function updateCockpit(s: CockpitCamState, ctx: Ctx): { st: CockpitCamState; pose: CameraPose } {
  const k = ctx.cfg.camera.cockpit;
  const { input, target, dt } = ctx;
  let yaw = s.yaw;
  let pitch = s.pitch;
  if (input.dragging) {
    yaw += finite(input.dx) * k.dragSensitivity * DEG;
    pitch -= finite(input.dy) * k.dragSensitivity * DEG;
  } else if (dt > 0) {
    const tau = k.headLookReturnRate > 0 ? 1 / k.headLookReturnRate : 0;
    yaw = expApproach(yaw, 0, tau, dt);
    pitch = expApproach(pitch, 0, tau, dt);
    if (Math.abs(yaw) < 1e-5) yaw = 0;
    if (Math.abs(pitch) < 1e-5) pitch = 0;
  }
  yaw = clamp(yaw, -k.headLookMaxYawDeg * DEG, k.headLookMaxYawDeg * DEG);
  pitch = clamp(pitch, -k.headLookMaxPitchDeg * DEG, k.headLookMaxPitchDeg * DEG);
  const wheel = finite(input.wheel);
  const fov = wheel !== 0 ? clamp(s.fov * Math.pow(1 + k.zoomPerNotch, wheel), k.minFov, k.maxFov) : s.fov;

  const eye = qRotate(target.orientation, ctx.cfg.aircraft.geometry.pilotEye);
  const position = { x: target.position.x + eye.x, y: target.position.y + eye.y, z: target.position.z + eye.z };
  const head = qMul(qFromAxisAngle(AXIS_Y, -yaw), qFromAxisAngle(AXIS_X, pitch - k.lookDownDeg * DEG));
  const quaternion = qNormalize(qMul(target.orientation, head));
  return { st: { yaw, pitch, fov: finite(fov, k.fov) }, pose: { position, quaternion, fov: finite(fov, k.fov) } };
}

function updateChase(s: ChaseCamState, ctx: Ctx): { st: ChaseCamState; pose: CameraPose } {
  const c = ctx.cfg.camera.chase;
  const { input, target, dt } = ctx;
  const heading = headingOf(target.orientation, s.heading);

  // Temporary mouse orbit (immediate), springing back when released.
  let dragYaw = s.dragYaw;
  let dragPitch = s.dragPitch;
  const baseElevation = Math.atan2(c.height, c.distance);
  if (input.dragging) {
    dragYaw = wrapPi(dragYaw + finite(input.dx) * c.dragSensitivity * DEG);
    dragPitch += finite(input.dy) * c.dragSensitivity * DEG;
  } else if (dt > 0) {
    dragYaw = expApproach(dragYaw, 0, c.dragReturnTau, dt);
    dragPitch = expApproach(dragPitch, 0, c.dragReturnTau, dt);
  }
  dragPitch = clamp(dragPitch, -baseElevation - 10 * DEG, c.maxDragPitchDeg * DEG - baseElevation);

  const wheel = finite(input.wheel);
  const zoom = wheel !== 0 ? clamp(s.zoom * Math.pow(1 + c.zoomPerNotch, wheel), c.minZoom, c.maxZoom) : s.zoom;

  // Springs on the spherical coordinates around the aircraft.
  const wantAz = heading + Math.PI;
  const wantEl = baseElevation;
  const wantR = Math.hypot(c.distance, c.height) * zoom;
  let az: number, azV: number, el: number, elV: number, r: number, rV: number;
  if (s.azimuth === null || ctx.snap) {
    az = wrapPi(wantAz); azV = 0; el = wantEl; elV = 0; r = wantR; rV = 0;
  } else {
    const w = c.positionStiffness;
    const [e, ev] = springStep(wrapPi(s.azimuth - wantAz), s.azimuthVel, 0, w, dt);
    az = wrapPi(wantAz + e); azV = ev;
    [el, elV] = springStep(s.elevation, s.elevationVel, wantEl, w, dt);
    [r, rV] = springStep(s.radius, s.radiusVel, wantR, w, dt);
  }

  const dir = dirFromAngles(az + dragYaw, el + dragPitch);
  const raw = { x: target.position.x + dir.x * r, y: target.position.y + dir.y * r, z: target.position.z + dir.z * r };
  const lift = groundLift(s.lift, raw, ctx, ctx.snap || s.azimuth === null);
  const position = { x: raw.x, y: raw.y + lift, z: raw.z };

  const hx = Math.sin(heading), hz = -Math.cos(heading);
  const look = { x: target.position.x + hx * c.lookAhead, y: target.position.y, z: target.position.z + hz * c.lookAhead };
  const lookQ = lookRotation({ x: look.x - position.x, y: look.y - position.y, z: look.z - position.z });

  const wantBank = chaseBankTarget(eulerFromQuat(target.orientation).rollDeg, c.bankFollow);
  let bank = s.azimuth === null || ctx.snap ? wantBank : expApproach(s.bank, wantBank, c.rotationStiffness > 0 ? 1 / c.rotationStiffness : 0, dt);
  if (Math.abs(bank - wantBank) < 1e-7) bank = wantBank;
  const quaternion = qNormalize(qMul(lookQ, qFromAxisAngle(AXIS_Z, -bank)));

  return {
    st: {
      azimuth: az, azimuthVel: azV, elevation: el, elevationVel: elV, radius: r, radiusVel: rV,
      dragYaw, dragPitch, zoom, bank: finite(bank), heading, lift,
    },
    pose: { position, quaternion, fov: c.fov },
  };
}

function pickExternalAnchor(s: ExternalCamState, ctx: Ctx, spotter: boolean): { anchor: Vec3; side: number } {
  const e = ctx.cfg.camera.external;
  const { target } = ctx;
  const heading = headingOf(target.orientation, 0);
  const hdir = { x: Math.sin(heading), y: 0, z: -Math.cos(heading) };
  const clearance = ctx.cfg.camera.groundClearance;
  const side = s.side >= 0 ? 1 : -1;
  if (spotter) {
    const rightDir = { x: -hdir.z, y: 0, z: hdir.x };
    const ax = target.position.x + rightDir.x * e.spotterDistance * side + hdir.x * 10;
    const az = target.position.z + rightDir.z * e.spotterDistance * side + hdir.z * 10;
    const g = ctx.ground(ax, az);
    const ay = Number.isFinite(g) ? g + Math.max(clearance, e.spotterEyeHeight) : target.position.y;
    return { anchor: { x: ax, y: ay, z: az }, side: -side };
  }
  const v = target.velocity;
  const speed = Math.hypot(v.x, v.y, v.z);
  const dir = speed > 1 ? { x: v.x / speed, y: v.y / speed, z: v.z / speed } : hdir;
  const lead = clamp(speed * e.leadTime, e.minLead, e.leadDistance);
  let sx = -dir.z, sz = dir.x;
  const sl = Math.hypot(sx, sz);
  if (sl < 0.2) { sx = -hdir.z; sz = hdir.x; } else { sx /= sl; sz /= sl; }
  const ax = target.position.x + dir.x * lead + sx * e.sideOffset * side;
  const az = target.position.z + dir.z * lead + sz * e.sideOffset * side;
  let ay = target.position.y + dir.y * lead + e.heightOffset;
  const g = ctx.ground(ax, az);
  if (Number.isFinite(g)) ay = Math.max(ay, g + Math.max(clearance, 2));
  return { anchor: { x: ax, y: ay, z: az }, side: -side };
}

function updateExternal(s: ExternalCamState, ctx: Ctx): { st: ExternalCamState; pose: CameraPose } {
  const e = ctx.cfg.camera.external;
  const { target, dt } = ctx;
  const v = target.velocity;
  const speed = Math.hypot(v.x, v.y, v.z);
  const spotterNow = target.onGround && speed < e.spotterSpeed;

  let { anchor, spotter, side, fov } = s;
  let relocate = ctx.snap || anchor === null;
  if (!relocate && anchor) {
    const tx = target.position.x - anchor.x, ty = target.position.y - anchor.y, tz = target.position.z - anchor.z;
    const d = Math.hypot(tx, ty, tz);
    if (spotterNow) {
      relocate = d > (spotter ? e.spotterDistance * 3 : e.maxDistance);
    } else {
      const receding = v.x * tx + v.y * ty + v.z * tz > 0;
      relocate = d > e.maxDistance && receding;
    }
  }
  if (relocate || !anchor) {
    const picked = pickExternalAnchor(s, ctx, spotterNow);
    anchor = picked.anchor;
    side = picked.side;
    spotter = spotterNow;
    fov = null;
  }

  // Keep the parked camera out of the terrain (hard clamp: it isn't moving).
  const position = { ...anchor };
  const g = ctx.ground(position.x, position.z);
  if (Number.isFinite(g)) position.y = Math.max(position.y, g + ctx.cfg.camera.groundClearance);

  const to = { x: target.position.x - position.x, y: target.position.y - position.y, z: target.position.z - position.z };
  const d = Math.hypot(to.x, to.y, to.z);
  const quaternion = lookRotation(to);
  const framing = d > 1e-3 ? (2 * Math.atan(e.framingSize / 2 / d)) / DEG : e.fov;
  const wantFov = clamp(framing, e.minFov, e.fov);
  const newFov = fov === null ? wantFov : expApproach(fov, wantFov, e.fovTau, dt);
  const outFov = clamp(finite(newFov, e.fov), e.minFov, e.fov);
  return { st: { anchor, spotter, side, fov: outFov }, pose: { position, quaternion, fov: outFov } };
}

function updateOrbit(s: OrbitCamState, ctx: Ctx): { st: OrbitCamState; pose: CameraPose } {
  const o = ctx.cfg.camera.orbit;
  const { input, target, dt } = ctx;
  let az = s.azimuth ?? headingOf(target.orientation, 0) + Math.PI;
  let el = s.elevation;
  let dist = s.distance;
  let idle = s.idle;
  const wheel = finite(input.wheel);
  if (input.dragging) {
    az += finite(input.dx) * o.dragSensitivity * DEG;
    el += finite(input.dy) * o.dragSensitivity * DEG;
  }
  if (wheel !== 0) dist = dist * Math.pow(1 + o.zoomPerNotch, wheel);
  dist = clamp(finite(dist, o.distance), o.minDistance, o.maxDistance);
  el = clamp(el, o.minPitchDeg * DEG, o.maxPitchDeg * DEG);
  if (input.dragging || wheel !== 0) {
    idle = 0;
  } else {
    idle += dt;
    const ramp = smoothstep(o.autoRotateDelay, o.autoRotateDelay + 1, idle);
    az += o.autoRotateDegPerSec * DEG * dt * ramp;
  }
  az = wrapPi(az);

  const dir = dirFromAngles(az, el);
  const raw = { x: target.position.x + dir.x * dist, y: target.position.y + dir.y * dist, z: target.position.z + dir.z * dist };
  const lift = groundLift(s.lift, raw, ctx, ctx.snap || s.azimuth === null);
  const position = { x: raw.x, y: raw.y + lift, z: raw.z };
  const quaternion = lookRotation({ x: target.position.x - position.x, y: target.position.y - position.y, z: target.position.z - position.z });
  return { st: { azimuth: az, elevation: el, distance: dist, idle, lift }, pose: { position, quaternion, fov: o.fov } };
}

/** Deterministic smooth noise in about [-1, 1]: a few incommensurate sines. */
function noise(t: number, f: number, seed: number): number {
  const w = 2 * Math.PI * f;
  return 0.55 * Math.sin(w * t + seed * 1.7 + 0.4)
    + 0.3 * Math.sin(w * 2.137 * t + seed * 3.1 + 1.3)
    + 0.15 * Math.sin(w * 0.513 * t + seed * 5.3 + 2.9);
}

function applyShake(pose: CameraPose, trauma: number, time: number, cfg: Config): CameraPose {
  if (trauma <= 1e-4) return pose;
  const s = cfg.camera.shake;
  const amp = trauma * trauma;
  const rot = amp * s.amplitudeDeg * DEG;
  const pitch = rot * noise(time, s.frequency, 1);
  const yaw = rot * noise(time, s.frequency * 0.93, 2);
  const roll = rot * 0.6 * noise(time, s.frequency * 1.11, 3);
  const q = qNormalize(qMul(pose.quaternion, qMul(qFromAxisAngle(AXIS_Y, yaw), qMul(qFromAxisAngle(AXIS_X, pitch), qFromAxisAngle(AXIS_Z, roll)))));
  const m = amp * s.amplitudeM;
  const position = {
    x: pose.position.x + m * noise(time, s.frequency * 0.77, 4),
    y: pose.position.y + m * noise(time, s.frequency * 1.23, 5),
    z: pose.position.z + m * noise(time, s.frequency * 0.89, 6),
  };
  return { position, quaternion: q, fov: pose.fov };
}

export function updateCameraRig(
  state: CameraRigState,
  target: CameraTarget,
  input: CameraInput,
  dt: number,
  groundHeight?: (x: number, z: number) => number,
  cfg: Config = CONFIG,
): { state: CameraRigState; pose: CameraPose } {
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  const lastPos = state.lastTargetPosition;
  const tgt: CameraTarget = {
    position: finiteVec(target.position, lastPos ?? { x: 0, y: 0, z: 0 }),
    orientation: qNormalize({
      x: finite(target.orientation.x), y: finite(target.orientation.y),
      z: finite(target.orientation.z), w: finite(target.orientation.w),
    }),
    velocity: finiteVec(target.velocity, { x: 0, y: 0, z: 0 }),
    onGround: !!target.onGround,
  };
  const ground = (x: number, z: number): number => {
    if (!groundHeight) return -Infinity;
    const h = groundHeight(x, z);
    return Number.isFinite(h) ? h : -Infinity;
  };
  const jumped = lastPos !== null &&
    Math.hypot(tgt.position.x - lastPos.x, tgt.position.y - lastPos.y, tgt.position.z - lastPos.z) > cfg.camera.snapDistance;
  const snap = state.snapPending || jumped;
  const ctx: Ctx = {
    cfg, dt: step, snap, target: tgt, ground,
    input: {
      dx: finite(input.dx), dy: finite(input.dy), wheel: finite(input.wheel),
      dragging: !!input.dragging, shake: clamp(finite(input.shake), 0, 1),
    },
  };

  let cockpit = state.cockpit;
  let chase = state.chase;
  let external = state.external;
  let orbit = state.orbit;
  let live: CameraPose;
  switch (state.mode) {
    case 'cockpit': { const r = updateCockpit(cockpit, ctx); cockpit = r.st; live = r.pose; break; }
    case 'chase': { const r = updateChase(chase, ctx); chase = r.st; live = r.pose; break; }
    case 'external': { const r = updateExternal(external, ctx); external = r.st; live = r.pose; break; }
    default: { const r = updateOrbit(orbit, ctx); orbit = r.st; live = r.pose; break; }
  }

  // Transition blend from the previous pose (carried along with the aircraft).
  let pose = live;
  let transition = snap ? null : state.transition;
  if (transition) {
    const T = cfg.camera.transitionTime;
    const elapsed = transition.elapsed + step;
    const t = T > 0 ? elapsed / T : 1;
    if (t >= 1) {
      transition = null;
    } else {
      const k = easeInOut(t);
      const from = {
        x: tgt.position.x + transition.fromOffset.x,
        y: tgt.position.y + transition.fromOffset.y,
        z: tgt.position.z + transition.fromOffset.z,
      };
      const position = vLerp(from, live.position, k);
      // Blends into non-cockpit modes keep the ground clearance; into the cockpit, no higher than the eye.
      const gLive = ground(live.position.x, live.position.z);
      const g = ground(position.x, position.z);
      if (Number.isFinite(g)) {
        const clearance = state.mode === 'cockpit'
          ? Math.min(cfg.camera.groundClearance, Number.isFinite(gLive) ? Math.max(0, live.position.y - gLive) : cfg.camera.groundClearance)
          : cfg.camera.groundClearance;
        position.y = Math.max(position.y, g + clearance);
      }
      pose = {
        position,
        quaternion: qNormalize(qSlerp(transition.fromQuat, live.quaternion, k)),
        fov: lerp(transition.fromFov, live.fov, k),
      };
      transition = { ...transition, elapsed };
    }
  }

  const time = state.time + step;
  const s = cfg.camera.shake;
  const trauma = Math.max(ctx.input.shake, state.trauma * Math.exp(-s.decay * step));
  const out = applyShake(pose, trauma < 1e-4 ? 0 : trauma, time, cfg);

  return {
    state: {
      mode: state.mode,
      transition,
      lastPose: pose,
      lastTargetPosition: { ...tgt.position },
      snapPending: false,
      time,
      trauma: trauma < 1e-4 ? 0 : trauma,
      cockpit, chase, external, orbit,
    },
    pose: out,
  };
}
