/**
 * Mission (c): a deliberate power-off stall and recovery.
 *   idle power, hold the nose up as the speed bleeds off, then full back yoke → 'stalled'
 *   (as window.sim reports it) → push, full power, wings level → unstalled → climb away,
 *   losing less than 500 ft overall.
 */
import { describe, it, expect } from 'vitest';
import type { Environment } from '../../src/types';
import { createTrimmedState, FLAT_ENV, simStateLabel } from '../../src/physics';
import { FT_TO_M } from '../../src/config';
import { buildSimSnapshot } from '../../src/game/simApi';
import { ScriptedPilot, flyPhase, iasKt, describeState } from '../support/pilot';
import { HILLY_ENV, FIELD_ELEV } from '../support/envs';

const FPS = { fps: 60, avg: 60, min: 60, onePercentLow: 60, longFrames: 0, frames: 1 };

function stallMission(env: Environment, field: number) {
  const start = field + 3000 * FT_TO_M;
  const { state, controls } = createTrimmedState({ altitudeM: start, iasKt: 80, headingDeg: 360, x: 0, z: -3000 }, env);
  const pilot = new ScriptedPilot({
    throttle: controls.throttle,
    elevatorTrim: controls.elevatorTrim,
    vertical: { mode: 'altitude', m: start },
    lateral: { mode: 'heading', deg: 360 },
  });
  let s = flyPhase(state, pilot, { env, seconds: 5 }).state;

  // ── Entry: power off, hold altitude while the speed decays ──
  pilot.set({ throttle: 0 });
  const slow = flyPhase(s, pilot, { env, seconds: 60, until: (x) => iasKt(x) < 55 });
  s = slow.state;
  expect(slow.stats.metAt, describeState(s)).not.toBeNull();
  expect(slow.stats.stalledSeen).toBe(false);
  expect(Math.abs(s.position.y - start) / FT_TO_M).toBeLessThan(150);

  // ── Stall: full back yoke, wings level ──
  pilot.set({ vertical: { mode: 'elevator', value: 1 }, lateral: { mode: 'bank', deg: 0 } });
  let snapshotLabel = '';
  const stall = flyPhase(s, pilot, {
    env, seconds: 30,
    until: (x) => simStateLabel(x) === 'stalled',
    each: (x, c) => { snapshotLabel = buildSimSnapshot({ state: x, controls: c, fps: FPS, cameraMode: 'chase', paused: false }).state; },
  });
  s = stall.state;
  expect(stall.stats.metAt, describeState(s)).not.toBeNull();
  expect(s.stalled).toBe(true);
  expect(simStateLabel(s)).toBe('stalled');
  expect(snapshotLabel, 'window.sim.state reports the stall').toBe('stalled');
  expect(iasKt(s)).toBeLessThan(60);
  const entryY = s.position.y;

  // Hold it in the stall briefly (the break).
  s = flyPhase(s, pilot, { env, seconds: 1.5 }).state;
  expect(s.phase).toBe('airborne');

  // ── Recovery: push (nose below the horizon), full power, wings level ──
  pilot.set({ vertical: { mode: 'pitch', deg: -5 }, throttle: 1, lateral: { mode: 'bank', deg: 0 } });
  let minY = s.position.y;
  const rec = flyPhase(s, pilot, {
    env, seconds: 15,
    until: (x) => !x.stalled && iasKt(x) > 62,
    each: (x) => { minY = Math.min(minY, x.position.y); },
  });
  s = rec.state;
  expect(rec.stats.metAt, describeState(s)).not.toBeNull();
  expect(s.stalled).toBe(false);
  expect(simStateLabel(s)).toBe('airborne');

  // ── Climb away at Vy ──
  pilot.set({ vertical: { mode: 'speed', kt: 75 }, lateral: { mode: 'heading', deg: s.derived.headingDeg } });
  const climb = flyPhase(s, pilot, { env, seconds: 30, each: (x) => { minY = Math.min(minY, x.position.y); } });
  s = climb.state;
  expect(climb.stats.stalledSeen, 'no secondary stall').toBe(false);
  expect(s.velocity.y, `climbing: ${describeState(s)}`).toBeGreaterThan(1);
  expect(s.position.y).toBeGreaterThan(minY + 20);
  expect(Math.abs(s.derived.rollDeg)).toBeLessThan(10);
  const lossFt = (Math.max(entryY, start) - minY) / FT_TO_M;
  expect(lossFt, 'altitude lost in the stall + recovery').toBeLessThan(500);
  return s;
}

describe('mission: power-off stall and recovery', () => {
  it('flat world', () => {
    expect(stallMission(FLAT_ENV, 0).crash).toBeNull();
  });
  it('hilly world', () => {
    expect(stallMission(HILLY_ENV, FIELD_ELEV).crash).toBeNull();
  });
});
