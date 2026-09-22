import { describe, it, expect } from 'vitest';
import {
  createCameraRig, setCameraMode, nextCameraMode, snapCamera, updateCameraRig, shakeTarget,
  type CameraRigState, type CameraTarget, type CameraInput, type CameraPose,
} from '../../src/camera/cameraRig';
import { lookRotation } from '../../src/camera/cameraMath';
import { quatFromEuler, eulerFromQuat } from '../../src/physics/frames';
import { qRotate, qMul, qFromAxisAngle } from '../../src/math/quat';
import { vAdd, vSub, vLength, vNormalize, vDot, vDistance, vLerp } from '../../src/math/vec3';
import { CONFIG } from '../../src/config';
import type { CameraMode, Quat, Vec3 } from '../../src/types';

const DT = 1 / 60;
const DEG = Math.PI / 180;
const C = CONFIG.camera;
const MODES: CameraMode[] = ['cockpit', 'chase', 'external', 'orbit'];

const NO_INPUT: CameraInput = { dx: 0, dy: 0, wheel: 0, dragging: false, shake: 0 };
const inp = (p: Partial<CameraInput> = {}): CameraInput => ({ ...NO_INPUT, ...p });

function tgt(position: Vec3, heading = 0, pitch = 0, roll = 0, velocity: Vec3 = { x: 0, y: 0, z: 0 }, onGround = false): CameraTarget {
  return { position, orientation: quatFromEuler(heading, pitch, roll), velocity, onGround };
}

type TargetFn = (t: number) => CameraTarget;
type InputFn = (t: number) => CameraInput;

/** Run the rig for `seconds`; returns the final state/pose. `t0` = sim time at the start (for moving targets). */
function run(
  state: CameraRigState,
  target: CameraTarget | TargetFn,
  seconds: number,
  input: CameraInput | InputFn = NO_INPUT,
  ground?: (x: number, z: number) => number,
  t0 = 0,
): { state: CameraRigState; pose: CameraPose; t: number } {
  let s = state;
  let pose!: CameraPose;
  const n = Math.max(1, Math.round(seconds / DT));
  let t = t0;
  for (let i = 0; i < n; i++) {
    t += DT;
    const tg = typeof target === 'function' ? target(t) : target;
    const ip = typeof input === 'function' ? input(t) : input;
    const r = updateCameraRig(s, tg, ip, DT, ground);
    s = r.state;
    pose = r.pose;
  }
  return { state: s, pose, t };
}

const fwd = (q: Quat) => qRotate(q, { x: 0, y: 0, z: -1 });
const up = (q: Quat) => qRotate(q, { x: 0, y: 1, z: 0 });
const right = (q: Quat) => qRotate(q, { x: 1, y: 0, z: 0 });
const horiz = (v: Vec3) => Math.hypot(v.x, v.z);
/** Angle between two quaternions, degrees. */
const qAngleDeg = (a: Quat, b: Quat) => (2 * Math.acos(Math.min(1, Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w)))) / DEG;

function expectFinitePose(p: CameraPose) {
  for (const v of [p.position.x, p.position.y, p.position.z, p.quaternion.x, p.quaternion.y, p.quaternion.z, p.quaternion.w, p.fov]) {
    expect(Number.isFinite(v)).toBe(true);
  }
  expect(Math.hypot(p.quaternion.x, p.quaternion.y, p.quaternion.z, p.quaternion.w)).toBeCloseTo(1, 6);
  expect(p.fov).toBeGreaterThan(1);
  expect(p.fov).toBeLessThan(179);
}

describe('lookRotation (three.js camera convention: looks down -Z, +Y up)', () => {
  it('looking north is the identity, east is heading 90', () => {
    const q = lookRotation({ x: 0, y: 0, z: -5 });
    expect(q.w).toBeCloseTo(1, 9);
    const e = lookRotation({ x: 3, y: 0, z: 0 });
    const f = fwd(e);
    expect(f.x).toBeCloseTo(1, 9);
    expect(up(e).y).toBeCloseTo(1, 9);
  });
  it('handles straight down/up and zero vectors without NaN', () => {
    for (const d of [{ x: 0, y: -1, z: 0 }, { x: 0, y: 7, z: 0 }, { x: 0, y: 0, z: 0 }]) {
      const q = lookRotation(d);
      expect([q.x, q.y, q.z, q.w].every(Number.isFinite)).toBe(true);
      if (vLength(d) > 0) expect(vDot(fwd(q), vNormalize(d))).toBeCloseTo(1, 9);
    }
  });
});

describe('modes', () => {
  it('defaults to chase; can start in any mode', () => {
    expect(createCameraRig().mode).toBe('chase');
    for (const m of MODES) expect(createCameraRig(m).mode).toBe(m);
  });
  it('C cycles cockpit → chase → external → orbit → cockpit', () => {
    let s = createCameraRig('cockpit');
    const seen: CameraMode[] = [];
    for (let i = 0; i < 4; i++) {
      s = nextCameraMode(s);
      seen.push(s.mode);
    }
    expect(seen).toEqual(['chase', 'external', 'orbit', 'cockpit']);
  });
  it('selecting the current mode again does not start a transition', () => {
    let s = run(createCameraRig('chase'), tgt({ x: 0, y: 100, z: 0 }), 0.5).state;
    s = setCameraMode(s, 'chase');
    expect(s.transition).toBeNull();
  });
});

describe('cockpit camera', () => {
  it('sits at the pilot eye point and looks along the nose, tipped down to show the panel', () => {
    const t = tgt({ x: 100, y: 50, z: 200 }, 90);
    const { pose } = run(createCameraRig('cockpit'), t, DT);
    const eye = vAdd(t.position, qRotate(t.orientation, CONFIG.aircraft.geometry.pilotEye));
    expect(vDistance(pose.position, eye)).toBeLessThan(1e-9);
    const f = fwd(pose.quaternion);
    expect(f.x).toBeCloseTo(Math.cos(C.cockpit.lookDownDeg * DEG), 6);
    expect(f.y).toBeCloseTo(-Math.sin(C.cockpit.lookDownDeg * DEG), 6);
    expect(pose.fov).toBe(C.cockpit.fov);
  });
  it('rolls and pitches with the aircraft: orientation = aircraft × look-down', () => {
    const t = tgt({ x: 0, y: 500, z: 0 }, 0, 10, 30);
    const { pose } = run(createCameraRig('cockpit'), t, DT);
    const expected = qMul(t.orientation, qFromAxisAngle({ x: 1, y: 0, z: 0 }, -C.cockpit.lookDownDeg * DEG));
    expect(qAngleDeg(pose.quaternion, expected)).toBeLessThan(1e-6);
    expect(right(pose.quaternion).y).toBeLessThan(-0.4);
  });
  it('mouse drag looks around (right / up), clamped, and eases back to centre when released', () => {
    const t = tgt({ x: 0, y: 500, z: 0 }, 0);
    let r = run(createCameraRig('cockpit'), t, DT, inp({ dragging: true, dx: 200 }));
    expect(fwd(r.pose.quaternion).x).toBeGreaterThan(0.5); // heading north: right is +x
    r = run(r.state, t, DT, inp({ dragging: true, dx: 100000 }));
    const f = fwd(r.pose.quaternion);
    const yaw = Math.atan2(f.x, -f.z) / DEG;
    expect(yaw).toBeCloseTo(C.cockpit.headLookMaxYawDeg, 0);
    const lookUp = run(createCameraRig('cockpit'), t, DT, inp({ dragging: true, dy: -200 }));
    expect(fwd(lookUp.pose.quaternion).y).toBeGreaterThan(0.3);
    const huge = run(createCameraRig('cockpit'), t, DT, inp({ dragging: true, dy: -100000 }));
    expect(Math.asin(fwd(huge.pose.quaternion).y) / DEG).toBeCloseTo(C.cockpit.headLookMaxPitchDeg - C.cockpit.lookDownDeg, 0);
    const back = run(r.state, t, 3);
    const centre = run(createCameraRig('cockpit'), t, DT);
    expect(qAngleDeg(back.pose.quaternion, centre.pose.quaternion)).toBeLessThan(0.5);
  });
});

describe('chase camera', () => {
  const still = tgt({ x: 0, y: 100, z: 0 }, 0);
  it('sits behind and above the aircraft along its heading, looking at it', () => {
    const { pose } = run(createCameraRig('chase'), still, 3);
    expect(pose.position.x).toBeCloseTo(0, 3);
    expect(pose.position.z).toBeCloseTo(C.chase.distance, 1); // north-facing → behind is +z (south)
    expect(pose.position.y).toBeCloseTo(100 + C.chase.height, 1);
    const f = fwd(pose.quaternion);
    expect(f.z).toBeLessThan(-0.9);
    expect(f.y).toBeLessThan(0);
    expect(pose.fov).toBe(C.chase.fov);
  });
  it('keeps its distance in steady flight (no speed-dependent lag)', () => {
    const flying: TargetFn = (t) => tgt({ x: 0, y: 300, z: -60 * t }, 0, 0, 0, { x: 0, y: 0, z: -60 });
    const { pose, t } = run(createCameraRig('chase'), flying, 4);
    const off = vSub(pose.position, flying(t).position);
    expect(horiz(off)).toBeCloseTo(C.chase.distance, 0);
    expect(off.z).toBeGreaterThan(0);
  });
  it('lags in a turn, then springs round behind the new heading', () => {
    const settled = run(createCameraRig('chase'), still, 3).state;
    const turned = tgt({ x: 0, y: 100, z: 0 }, 90); // now facing east → behind is -x
    const one = run(settled, turned, DT);
    expect(one.pose.position.z).toBeGreaterThan(C.chase.distance * 0.9); // still mostly where it was
    const mid = run(settled, turned, 0.3);
    expect(mid.pose.position.x).toBeLessThan(-1);
    expect(mid.pose.position.z).toBeGreaterThan(1);
    const done = run(settled, turned, 3);
    expect(done.pose.position.x).toBeCloseTo(-C.chase.distance, 1);
    expect(done.pose.position.z).toBeCloseTo(0, 1);
  });
  it('banks partially with the aircraft (bankFollow)', () => {
    const { pose } = run(createCameraRig('chase'), tgt({ x: 0, y: 300, z: 0 }, 0, 0, 30), 3);
    expect(eulerFromQuat(pose.quaternion).rollDeg).toBeCloseTo(30 * C.chase.bankFollow, 1);
    expect(right(pose.quaternion).y).toBeLessThan(0); // right side down, like the aircraft
  });
  it('mouse drag orbits it temporarily; it springs back behind when released', () => {
    const settled = run(createCameraRig('chase'), still, 3).state;
    const dragged = run(settled, still, 0.5, inp({ dragging: true, dx: 10 }));
    const off = vSub(dragged.pose.position, still.position);
    expect(Math.abs(off.x)).toBeGreaterThan(5);
    const back = run(dragged.state, still, 4);
    expect(back.pose.position.x).toBeCloseTo(0, 1);
    expect(back.pose.position.z).toBeCloseTo(C.chase.distance, 1);
  });
  it('wheel zooms the chase distance', () => {
    const settled = run(createCameraRig('chase'), still, 2).state;
    const out = run(settled, still, 3, (t) => inp({ wheel: t < 0.1 ? 1 : 0 }));
    expect(horiz(vSub(out.pose.position, still.position))).toBeGreaterThan(C.chase.distance * 1.2);
  });
});

describe('external (fly-by) camera', () => {
  const V = 50;
  const flyNorth: TargetFn = (t) => tgt({ x: 0, y: 300, z: -V * t }, 0, 0, 0, { x: 0, y: 0, z: -V });
  it('parks ahead of the aircraft along its velocity, offset to the side and up, and watches it', () => {
    const { pose, t } = run(createCameraRig('external'), flyNorth, DT);
    const a = flyNorth(t).position;
    expect(a.z - pose.position.z).toBeCloseTo(C.external.leadDistance, 0);
    expect(Math.abs(pose.position.x)).toBeCloseTo(C.external.sideOffset, 0);
    expect(pose.position.y).toBeCloseTo(300 + C.external.heightOffset, 0);
    const toPlane = vNormalize(vSub(a, pose.position));
    expect(vDot(fwd(pose.quaternion), toPlane)).toBeGreaterThan(0.9999);
  });
  it('stays put while the aircraft flies past and zooms (narrow FOV far, wide near)', () => {
    const r0 = run(createCameraRig('external'), flyNorth, 0.1);
    const r2 = run(r0.state, flyNorth, 1.9, NO_INPUT, undefined, r0.t);
    const r5 = run(r2.state, flyNorth, 3.4, NO_INPUT, undefined, r2.t);
    const r10 = run(r5.state, flyNorth, 5, NO_INPUT, undefined, r5.t);
    expect(vDistance(r0.pose.position, r10.pose.position)).toBeLessThan(1e-6);
    expect(r0.pose.fov).toBeLessThan(15);
    expect(r0.pose.fov).toBeGreaterThanOrEqual(C.external.minFov);
    expect(r5.pose.fov).toBeGreaterThan(35);
    expect(r5.pose.fov).toBeLessThanOrEqual(C.external.fov);
    expect(r10.pose.fov).toBeLessThan(r5.pose.fov);
  });
  it('picks a new anchor ahead once the aircraft is beyond maxDistance and moving away', () => {
    const first = run(createCameraRig('external'), flyNorth, DT);
    const r = run(first.state, flyNorth, 18, NO_INPUT, undefined, first.t);
    const a = flyNorth(r.t).position;
    expect(vDistance(r.pose.position, first.pose.position)).toBeGreaterThan(100);
    expect(r.pose.position.z).toBeLessThan(a.z); // ahead again (north of the aircraft)
    expect(vDistance(r.pose.position, a)).toBeLessThan(C.external.maxDistance);
  });
  it('on the ground at low speed it becomes a spotter ~40 m off the side', () => {
    const ground = () => 30;
    const parked = tgt({ x: 0, y: 31.4, z: 0 }, 0, 0, 0, { x: 0, y: 0, z: 0 }, true);
    const { pose } = run(createCameraRig('external'), parked, 0.5, NO_INPUT, ground);
    const d = horiz(vSub(pose.position, parked.position));
    expect(d).toBeGreaterThan(C.external.spotterDistance - 5);
    expect(d).toBeLessThan(C.external.spotterDistance + 15);
    expect(pose.position.y).toBeGreaterThanOrEqual(30 + C.groundClearance);
    expect(pose.position.y).toBeLessThan(35);
    expect(vDot(fwd(pose.quaternion), vNormalize(vSub(parked.position, pose.position)))).toBeGreaterThan(0.9999);
  });
});

describe('orbit camera', () => {
  const still = tgt({ x: 0, y: 500, z: 0 }, 0);
  const azimuth = (p: CameraPose) => Math.atan2(p.position.x - still.position.x, -(p.position.z - still.position.z)) / DEG;
  const elevation = (p: CameraPose) => Math.asin((p.position.y - still.position.y) / vDistance(p.position, still.position)) / DEG;

  it('starts behind the aircraft at the configured distance and pitch, looking at it', () => {
    const { pose } = run(createCameraRig('orbit'), still, DT);
    expect(vDistance(pose.position, still.position)).toBeCloseTo(C.orbit.distance, 6);
    expect(elevation(pose)).toBeCloseTo(C.orbit.pitchDeg, 6);
    expect(pose.position.z).toBeGreaterThan(0);
    expect(vDot(fwd(pose.quaternion), vNormalize(vSub(still.position, pose.position)))).toBeGreaterThan(0.9999);
    expect(pose.fov).toBe(C.orbit.fov);
  });
  it('drag rotates it by dragSensitivity degrees per pixel', () => {
    const a = run(createCameraRig('orbit'), still, DT);
    const b = run(a.state, still, DT, inp({ dragging: true, dx: 100 }));
    let d = azimuth(b.pose) - azimuth(a.pose);
    d = ((d + 540) % 360) - 180;
    expect(Math.abs(d)).toBeCloseTo(100 * C.orbit.dragSensitivity, 4);
  });
  it('pitch is clamped to -10°..85°', () => {
    const top = run(createCameraRig('orbit'), still, DT, inp({ dragging: true, dy: 100000 }));
    expect(elevation(top.pose)).toBeCloseTo(C.orbit.maxPitchDeg, 4);
    const bottom = run(createCameraRig('orbit'), still, DT, inp({ dragging: true, dy: -100000 }));
    expect(elevation(bottom.pose)).toBeCloseTo(C.orbit.minPitchDeg, 4);
  });
  it('wheel zooms within min/max distance', () => {
    const out = run(createCameraRig('orbit'), still, DT, inp({ wheel: 1000 }));
    expect(vDistance(out.pose.position, still.position)).toBeCloseTo(C.orbit.maxDistance, 4);
    const inn = run(createCameraRig('orbit'), still, DT, inp({ wheel: -1000 }));
    expect(vDistance(inn.pose.position, still.position)).toBeCloseTo(C.orbit.minDistance, 4);
    const one = run(createCameraRig('orbit'), still, DT, inp({ wheel: 1 }));
    expect(vDistance(one.pose.position, still.position)).toBeGreaterThan(C.orbit.distance);
  });
  it('auto-rotates slowly after 3 s without input, not before', () => {
    const a = run(createCameraRig('orbit'), still, DT);
    const b = run(a.state, still, 2.8, NO_INPUT, undefined, a.t);
    expect(azimuth(b.pose)).toBeCloseTo(azimuth(a.pose), 6);
    const c = run(b.state, still, 2.2, NO_INPUT, undefined, b.t);
    const d = run(c.state, still, 1, NO_INPUT, undefined, c.t);
    let rate = azimuth(d.pose) - azimuth(c.pose);
    rate = ((rate + 540) % 360) - 180;
    expect(Math.abs(rate)).toBeCloseTo(C.orbit.autoRotateDegPerSec, 1);
    // any input restarts the idle timer
    const e = run(d.state, still, DT, inp({ dragging: true }));
    const f = run(e.state, still, 1, NO_INPUT);
    expect(azimuth(f.pose)).toBeCloseTo(azimuth(e.pose), 6);
  });
});

describe('ground clearance', () => {
  it('orbit never goes below ground + clearance', () => {
    const ground = () => 100;
    const onGround = tgt({ x: 0, y: 101.4, z: 0 }, 0, 0, 0, { x: 0, y: 0, z: 0 }, true);
    const { pose } = run(createCameraRig('orbit'), onGround, 0.2, inp({ dragging: true, dy: -100000 }), ground);
    expect(pose.position.y).toBeGreaterThanOrEqual(100 + C.groundClearance - 1e-9);
  });
  it('chase rides up over a ridge behind the aircraft and still looks at it', () => {
    const ground = (_x: number, z: number) => (z > 5 ? 150 : 100);
    const t = tgt({ x: 0, y: 110, z: 0 }, 0);
    const { pose } = run(createCameraRig('chase'), t, 2, NO_INPUT, ground);
    expect(pose.position.y).toBeGreaterThanOrEqual(150 + C.groundClearance - 1e-9);
    expect(fwd(pose.quaternion).y).toBeLessThan(0);
  });
  it('external anchors are never underground (steep descent toward terrain)', () => {
    const ground = () => 200;
    const diving: TargetFn = (t) => tgt({ x: 0, y: 260 - 20 * t, z: -40 * t }, 0, -25, 0, { x: 0, y: -20, z: -40 });
    const { pose } = run(createCameraRig('external'), diving, 1, NO_INPUT, ground);
    expect(pose.position.y).toBeGreaterThanOrEqual(200 + C.groundClearance - 1e-9);
  });
  it('the cockpit is exempt (the eye is where it is)', () => {
    const t = tgt({ x: 0, y: 10, z: 0 }, 0);
    const { pose } = run(createCameraRig('cockpit'), t, DT, NO_INPUT, () => 1000);
    expect(pose.position.y).toBeCloseTo(10 + CONFIG.aircraft.geometry.pilotEye.y, 9);
  });
});

describe('transitions', () => {
  const still = tgt({ x: 10, y: 200, z: -30 }, 45);
  it('blends the last pose into the new mode over transitionTime with ease-in-out', () => {
    const cockpit = run(createCameraRig('cockpit'), still, 0.5);
    const from = cockpit.pose;
    const liveChase = run(createCameraRig('chase'), still, 0.5).pose;
    let s = setCameraMode(cockpit.state, 'chase');
    expect(s.mode).toBe('chase');
    expect(s.transition).not.toBeNull();

    const early = run(s, still, 0.2);
    expect(vDistance(early.pose.position, from.position)).toBeLessThan(vDistance(early.pose.position, liveChase.position));

    const half = run(s, still, C.transitionTime / 2);
    const mid = vLerp(from.position, liveChase.position, 0.5);
    expect(vDistance(half.pose.position, mid)).toBeLessThan(1e-6);
    expect(half.pose.fov).toBeCloseTo((C.cockpit.fov + C.chase.fov) / 2, 6);
    expect(qAngleDeg(half.pose.quaternion, from.quaternion)).toBeCloseTo(qAngleDeg(from.quaternion, liveChase.quaternion) / 2, 3);
    expect(half.state.transition).not.toBeNull();

    const done = run(s, still, C.transitionTime + DT);
    expect(done.state.transition).toBeNull();
    expect(vDistance(done.pose.position, liveChase.position)).toBeLessThan(1e-6);
    expect(qAngleDeg(done.pose.quaternion, liveChase.quaternion)).toBeLessThan(1e-3);
    expect(done.pose.fov).toBe(C.chase.fov);
    s = done.state;
  });
  it('switching again mid-transition continues from the current blended pose (no jump)', () => {
    const a = run(setCameraMode(run(createCameraRig('cockpit'), still, 0.5).state, 'chase'), still, 0.3);
    const b = updateCameraRig(setCameraMode(a.state, 'orbit'), still, NO_INPUT, DT);
    expect(vDistance(a.pose.position, b.pose.position)).toBeLessThan(1);
  });
  it('the blend moves with a fast aircraft instead of being left behind', () => {
    const fast: TargetFn = (t) => tgt({ x: 0, y: 300, z: -70 * t }, 0, 0, 0, { x: 0, y: 0, z: -70 });
    const c = run(createCameraRig('cockpit'), fast, 0.5);
    let s = setCameraMode(c.state, 'chase');
    let worst = 0;
    let t = c.t;
    for (let i = 0; i < 60; i++) {
      t += DT;
      const r = updateCameraRig(s, fast(t), NO_INPUT, DT);
      s = r.state;
      worst = Math.max(worst, vDistance(r.pose.position, fast(t).position));
    }
    expect(worst).toBeLessThan(C.chase.distance + 5);
  });
});

describe('snap / teleport', () => {
  it('a target jump over snapDistance snaps the camera (no lag, no transition)', () => {
    const settled = run(createCameraRig('chase'), tgt({ x: 0, y: 100, z: 0 }, 0), 3).state;
    const moving = setCameraMode(setCameraMode(settled, 'orbit'), 'chase');
    const jumped = tgt({ x: 5000, y: 400, z: 0 }, 90);
    const r = updateCameraRig(moving, jumped, NO_INPUT, DT);
    expect(r.state.transition).toBeNull();
    expect(r.pose.position.x).toBeCloseTo(5000 - C.chase.distance, 3);
    expect(r.pose.position.z).toBeCloseTo(0, 3);
    expect(r.pose.position.y).toBeCloseTo(400 + C.chase.height, 3);
  });
  it('snapCamera() removes the lag after a reset even for a short move', () => {
    const settled = run(createCameraRig('chase'), tgt({ x: 0, y: 100, z: 0 }, 0), 3).state;
    const reset = tgt({ x: 0, y: 100, z: -50 }, 90);
    const lagging = updateCameraRig(settled, reset, NO_INPUT, DT).pose;
    expect(lagging.position.x).toBeGreaterThan(-5);
    const snapped = updateCameraRig(snapCamera(settled), reset, NO_INPUT, DT).pose;
    expect(snapped.position.x).toBeCloseTo(-C.chase.distance, 3);
    expect(snapped.position.z).toBeCloseTo(-50, 3);
  });
  it('snapCamera() cancels a running transition', () => {
    const t = tgt({ x: 0, y: 100, z: 0 }, 0);
    const s = setCameraMode(run(createCameraRig('cockpit'), t, 0.3).state, 'orbit');
    const snapped = snapCamera(s);
    expect(snapped.transition).toBeNull();
    const live = run(createCameraRig('orbit'), t, DT).pose;
    expect(vDistance(updateCameraRig(snapped, t, NO_INPUT, DT).pose.position, live.position)).toBeLessThan(1e-6);
  });
});

describe('shake', () => {
  const t = tgt({ x: 0, y: 100, z: 0 }, 0);
  it('shake 0 does nothing; shake 1 moves the view a little, deterministically', () => {
    const calm = run(createCameraRig('chase'), t, 1).pose;
    const a = run(createCameraRig('chase'), t, 1, inp({ shake: 1 })).pose;
    const b = run(createCameraRig('chase'), t, 1, inp({ shake: 1 })).pose;
    expect(a).toEqual(b);
    const ang = qAngleDeg(a.quaternion, calm.quaternion);
    expect(ang).toBeGreaterThan(0.05);
    expect(ang).toBeLessThan(C.shake.amplitudeDeg * 2);
    const gentle = run(createCameraRig('chase'), t, 1, inp({ shake: 0.2 })).pose;
    expect(qAngleDeg(gentle.quaternion, calm.quaternion)).toBeLessThan(ang);
  });
  it('decays smoothly after the input drops instead of cutting off', () => {
    const shaken = run(createCameraRig('cockpit'), t, 0.5, inp({ shake: 1 }));
    expect(shaken.state.trauma).toBeCloseTo(1, 6);
    const next = run(shaken.state, t, DT);
    expect(next.state.trauma).toBeGreaterThan(0.9);
    const later = run(shaken.state, t, 3);
    expect(later.state.trauma).toBeLessThan(0.01);
  });
  it('shakeTarget combines ground roll, stall and a decaying crash impulse', () => {
    const base = { onGround: false, groundSpeed: 0, stalled: false, crashAge: null };
    expect(shakeTarget(base)).toBe(0);
    expect(shakeTarget({ ...base, onGround: true, groundSpeed: C.shake.groundRollSpeed })).toBeCloseTo(C.shake.groundRoll, 9);
    expect(shakeTarget({ ...base, onGround: true, groundSpeed: C.shake.groundRollSpeed / 2 })).toBeCloseTo(C.shake.groundRoll / 2, 9);
    expect(shakeTarget({ ...base, onGround: true, groundSpeed: 0 })).toBe(0);
    expect(shakeTarget({ ...base, stalled: true })).toBe(C.shake.stall);
    expect(shakeTarget({ ...base, crashAge: 0 })).toBe(C.shake.crash);
    expect(shakeTarget({ ...base, crashAge: 2 })).toBeLessThan(0.01);
  });
});

describe('robustness: never NaN', () => {
  const nasty: CameraTarget[] = [
    tgt({ x: 0, y: 100, z: 0 }, 0, -90), // straight down
    tgt({ x: 0, y: 100, z: 0 }, 0, 90), // straight up
    tgt({ x: 0, y: 100, z: 0 }, 123, -90, 70, { x: 0, y: -80, z: 0 }), // vertical dive, rolled
    tgt({ x: 0, y: 100, z: 0 }, 0, 0, 180, { x: 0, y: 0, z: 0 }), // inverted, still
    { position: { x: 1, y: 2, z: 3 }, orientation: { x: 0, y: 0, z: 0, w: 0 }, velocity: { x: NaN, y: 0, z: 0 }, onGround: true },
  ];
  for (const mode of MODES) {
    it(`${mode}: zero velocity, vertical attitudes, dt = 0 / NaN, a broken ground function`, () => {
      for (const t of nasty) {
        let s = createCameraRig(mode);
        for (const dt of [0, NaN, DT, 1, -1]) {
          const r = updateCameraRig(s, t, inp({ dragging: true, dx: 5, dy: -3, wheel: 1 }), dt, () => NaN);
          expectFinitePose(r.pose);
          s = r.state;
        }
        s = nextCameraMode(s);
        const r = run(s, t, 1, inp({ shake: 1 }));
        expectFinitePose(r.pose);
      }
    });
  }
  it('updating before any pose exists and switching modes immediately is fine', () => {
    let s = createCameraRig('chase');
    s = setCameraMode(s, 'cockpit');
    expect(s.transition).toBeNull();
    s = snapCamera(nextCameraMode(s));
    expectFinitePose(updateCameraRig(s, tgt({ x: 0, y: 0, z: 0 }), NO_INPUT, 0).pose);
  });
  it('is pure: the input state is not mutated', () => {
    const s = run(createCameraRig('chase'), tgt({ x: 0, y: 100, z: 0 }), 0.5).state;
    const snap = JSON.stringify(s);
    updateCameraRig(s, tgt({ x: 3, y: 100, z: 0 }, 20, 5, 10), inp({ dragging: true, dx: 10, shake: 1 }), DT);
    setCameraMode(s, 'orbit');
    snapCamera(s);
    expect(JSON.stringify(s)).toBe(snap);
  });
});
