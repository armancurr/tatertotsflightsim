/**
 * Property tests for the pure camera rig (src/camera/cameraRig.ts): random
 * aircraft trajectories (positions up to ±50 km, any orientation, velocities
 * including zero, occasional teleports), random mouse input, random mode
 * switches/snaps and random frame times over hilly or flat ground.
 */
import { describe, it } from 'vitest';
import fc from 'fast-check';
import {
  createCameraRig, nextCameraMode, setCameraMode, snapCamera, updateCameraRig,
  type CameraInput, type CameraPose, type CameraRigState, type CameraTarget,
} from '../../src/camera/cameraRig';
import { CONFIG } from '../../src/config';
import type { CameraMode, Quat, Vec3 } from '../../src/types';
import { fcParams } from '../support/fc';
import { hostileNum, num, unitQuat, vec3 } from '../support/arbitraries';
import { firstNonFinite, quatNorm } from '../support/invariants';
import { hillyHeight } from '../support/envs';

const C = CONFIG.camera;
const MODES: CameraMode[] = ['cockpit', 'chase', 'external', 'orbit'];
const FOV_MIN = Math.min(C.cockpit.minFov, C.external.minFov, C.chase.fov, C.orbit.fov);
const FOV_MAX = Math.max(C.cockpit.maxFov, C.external.fov, C.chase.fov, C.orbit.fov, C.cockpit.fov);

type Ground = ((x: number, z: number) => number) | undefined;
const grounds: fc.Arbitrary<{ name: string; fn: Ground }> = fc.constantFrom(
  { name: 'none', fn: undefined },
  { name: 'flat0', fn: () => 0 },
  { name: 'hilly', fn: hillyHeight },
  { name: 'steep', fn: (x: number, z: number) => 300 * Math.sin(x / 40) * Math.cos(z / 55) },
);

type Op =
  | { kind: 'frame'; dt: number; input: CameraInput; move: { dv: Vec3; q: Quat | null; teleport: Vec3 | null; zeroVel: boolean } }
  | { kind: 'mode'; mode: CameraMode }
  | { kind: 'next' }
  | { kind: 'snap' };

const inputArb: fc.Arbitrary<CameraInput> = fc.record({
  dx: fc.oneof({ weight: 12, arbitrary: num(-400, 400) }, { weight: 1, arbitrary: hostileNum }),
  dy: fc.oneof({ weight: 12, arbitrary: num(-400, 400) }, { weight: 1, arbitrary: hostileNum }),
  wheel: fc.oneof({ weight: 12, arbitrary: num(-5, 5) }, { weight: 1, arbitrary: hostileNum }),
  dragging: fc.boolean(),
  shake: fc.oneof({ weight: 12, arbitrary: num(0, 1) }, { weight: 1, arbitrary: hostileNum }),
});

const frameOp: fc.Arbitrary<Op> = fc.record({
  kind: fc.constant('frame' as const),
  dt: fc.oneof({ weight: 8, arbitrary: num(0, 0.25) }, { weight: 1, arbitrary: fc.constantFrom(0, 0.25, NaN, -1) }),
  input: inputArb,
  move: fc.record({
    dv: vec3(20),
    q: fc.option(unitQuat, { freq: 4 }),
    teleport: fc.option(fc.record({ x: num(-5e4, 5e4), y: num(0, 4000), z: num(-5e4, 5e4) }), { freq: 25 }),
    zeroVel: fc.boolean(),
  }),
});

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 20, arbitrary: frameOp },
  { weight: 2, arbitrary: fc.constantFrom(...MODES).map((mode) => ({ kind: 'mode' as const, mode })) },
  { weight: 1, arbitrary: fc.constant({ kind: 'next' as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'snap' as const }) },
);

interface Start { mode: CameraMode; pos: Vec3; q: Quat; vel: Vec3; onGround: boolean }

const startArb: fc.Arbitrary<Start> = fc.record({
  mode: fc.constantFrom(...MODES),
  pos: fc.record({ x: num(-5e4, 5e4), y: num(0, 3000), z: num(-5e4, 5e4) }),
  q: unitQuat,
  vel: fc.oneof(fc.constant({ x: 0, y: 0, z: 0 }), vec3(80)),
  onGround: fc.boolean(),
});

/**
 * `p` is the output pose (with shake), `base` the rig's pre-shake pose (state.lastPose): the ground
 * clearance contract applies to the latter — shake is a small cosmetic offset on top.
 */
function poseViolation(p: CameraPose, base: CameraPose | null, mode: CameraMode, inTransition: boolean, ground: Ground): string | null {
  const nf = firstNonFinite(p) ?? firstNonFinite(base);
  if (nf) return `non-finite ${nf}`;
  const n = quatNorm(p.quaternion);
  if (Math.abs(n - 1) > 1e-6) return `quaternion norm ${n}`;
  if (!(p.fov >= FOV_MIN - 1e-9 && p.fov <= FOV_MAX + 1e-9)) return `fov ${p.fov}`;
  if (!base) return 'no lastPose after an update';
  if (Math.hypot(p.position.x - base.position.x, p.position.y - base.position.y, p.position.z - base.position.z) > C.shake.amplitudeM * Math.sqrt(3) + 1e-9) {
    return 'shake offset larger than shake.amplitudeM';
  }
  if (ground && mode !== 'cockpit') {
    p = base;
    const g = ground(p.position.x, p.position.z);
    const floor = g + C.groundClearance - 1e-6;
    if (p.position.y < floor) {
      return `${mode}${inTransition ? ' (transition)' : ''} camera ${(g + C.groundClearance - p.position.y).toFixed(3)} m below ground+clearance at (${p.position.x.toFixed(1)}, ${p.position.z.toFixed(1)})`;
    }
  }
  return null;
}

function simulate(start: Start, ops: Op[], ground: Ground) {
  let rig: CameraRigState = createCameraRig(start.mode);
  // The aircraft always flies above the ground (it would have crashed otherwise).
  const lift = (p: Vec3): Vec3 => (ground ? { ...p, y: Math.max(p.y, ground(p.x, p.z) + 2) } : p);
  let target: CameraTarget = { position: lift(start.pos), orientation: start.q, velocity: start.vel, onGround: start.onGround };
  let sinceSwitch: number | null = null;
  for (const op of ops) {
    if (op.kind === 'mode') { const before = rig.mode; rig = setCameraMode(rig, op.mode); if (op.mode !== before) sinceSwitch = 0; continue; }
    if (op.kind === 'next') { rig = nextCameraMode(rig); sinceSwitch = 0; continue; }
    if (op.kind === 'snap') { rig = snapCamera(rig); continue; }
    const dt = op.dt;
    const m = op.move;
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    const vel = m.zeroVel ? { x: 0, y: 0, z: 0 } : { x: target.velocity.x + m.dv.x, y: target.velocity.y + m.dv.y, z: target.velocity.z + m.dv.z };
    const pos = m.teleport ?? { x: target.position.x + vel.x * step, y: target.position.y + vel.y * step, z: target.position.z + vel.z * step };
    target = { position: lift(pos), orientation: m.q ?? target.orientation, velocity: vel, onGround: target.onGround };
    const r = updateCameraRig(rig, target, op.input, dt, ground);
    rig = r.state;
    if (sinceSwitch !== null) sinceSwitch += step;
    const bad = poseViolation(r.pose, rig.lastPose, rig.mode, rig.transition !== null, ground);
    if (bad) throw new Error(bad);
    // Transitions always complete: never still blending after transitionTime of positive frame time.
    if (rig.transition && sinceSwitch !== null && sinceSwitch > C.transitionTime + 1e-9) {
      throw new Error(`transition still running ${sinceSwitch.toFixed(3)} s after the switch`);
    }
    if (!rig.transition) sinceSwitch = null;
    if (!(rig.cockpit.fov >= C.cockpit.minFov - 1e-9 && rig.cockpit.fov <= C.cockpit.maxFov + 1e-9)) throw new Error(`cockpit fov ${rig.cockpit.fov}`);
    if (!(rig.orbit.distance >= C.orbit.minDistance && rig.orbit.distance <= C.orbit.maxDistance)) throw new Error(`orbit distance ${rig.orbit.distance}`);
    if (!(rig.chase.zoom >= C.chase.minZoom && rig.chase.zoom <= C.chase.maxZoom)) throw new Error(`chase zoom ${rig.chase.zoom}`);
  }
  return rig;
}

describe('camera rig under random trajectories, input and mode switches', () => {
  it('pose is finite, unit-quaternion, fov in range, above ground+clearance (non-cockpit), transitions complete', () => {
    fc.assert(fc.property(startArb, fc.array(opArb, { minLength: 1, maxLength: 150 }), grounds, (start, ops, g) => {
      simulate(start, ops, g.fn);
    }), fcParams(300));
  });

  it('is deterministic and never mutates its inputs', () => {
    fc.assert(fc.property(startArb, fc.array(opArb, { minLength: 1, maxLength: 60 }), grounds, (start, ops, g) => {
      const frozenOps = structuredClone(ops);
      const a = simulate(start, ops, g.fn);
      const b = simulate(start, ops, g.fn);
      if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('same inputs, different rig state');
      if (JSON.stringify(ops) !== JSON.stringify(frozenOps)) throw new Error('ops mutated');
    }), fcParams(100));
  });

  it('a mode switch followed by transitionTime of steady frames always ends the blend, in every mode pair', () => {
    fc.assert(fc.property(startArb, fc.constantFrom(...MODES), fc.constantFrom(...MODES), fc.constantFrom(1 / 30, 1 / 60, 1 / 144, 0.25), (start, from, to, dt) => {
      fc.pre(from !== to);
      let rig = createCameraRig(from);
      const target: CameraTarget = { position: start.pos, orientation: start.q, velocity: start.vel, onGround: start.onGround };
      const noInput: CameraInput = { dx: 0, dy: 0, wheel: 0, dragging: false, shake: 0 };
      for (let i = 0; i < 5; i++) rig = updateCameraRig(rig, target, noInput, dt).state;
      rig = setCameraMode(rig, to);
      if (!rig.transition) throw new Error('switching modes after a pose exists should start a transition');
      let t = 0;
      while (t < C.transitionTime + dt) { rig = updateCameraRig(rig, target, noInput, dt).state; t += dt; }
      if (rig.transition) throw new Error(`still blending after ${t} s`);
      if (rig.mode !== to) throw new Error(`mode ${rig.mode}`);
    }), fcParams(200));
  });
});
