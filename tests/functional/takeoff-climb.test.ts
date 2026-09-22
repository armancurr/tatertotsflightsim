/**
 * Mission (a): full take-off and climb, flown by the scripted pilot against the
 * real physics — on the flat default world and on the hilly test world.
 *   runway, idle → full power roll on the centreline → rotate at 55 KIAS → airborne
 *   → climb at ~75 KIAS (Vy) → level off at 1,500 ft above the field.
 */
import { describe, it, expect } from 'vitest';
import type { Environment } from '../../src/types';
import { createInitialState, FLAT_ENV, simStateLabel } from '../../src/physics';
import { FT_TO_M } from '../../src/config';
import { isOnRunway, runwayFrame, toRunwayCoords } from '../../src/world/runway';
import { ScriptedPilot, flyPhase, iasKt, describeState } from '../support/pilot';
import { HILLY_ENV } from '../support/envs';

const rw = runwayFrame();

function takeoffAndClimb(env: Environment) {
  let s = createInitialState(env);
  const field = env.groundHeight(s.position.x, s.position.z);
  const pilot = new ScriptedPilot({ throttle: 0, lateral: { mode: 'centreline' }, vertical: { mode: 'elevator', value: 0 } });

  // ── Phase 0: parked, engine idling, on the runway ──
  expect(s.phase).toBe('ground');
  expect(simStateLabel(s)).toBe('ground');
  expect(isOnRunway(s.position.x, s.position.z)).toBe(true);
  expect(s.engine.running).toBe(true);
  const settle = flyPhase(s, pilot, { env, seconds: 2 });
  s = settle.state;
  expect(s.phase).toBe('ground');
  expect(s.derived.groundSpeed).toBeLessThan(0.5);

  // ── Phase 1: take-off roll to Vr (55 KIAS), full power, nosewheel on the centreline ──
  pilot.set({ throttle: 1 });
  const roll = flyPhase(s, pilot, { env, seconds: 40, until: (x) => iasKt(x) >= 55 });
  s = roll.state;
  expect(roll.stats.metAt, describeState(s)).not.toBeNull();
  expect(s.phase).toBe('ground');
  expect(s.onGround).toBe(true);
  const rollC = toRunwayCoords(s.position.x, s.position.z, rw);
  expect(Math.abs(rollC.across), 'stays near the centreline').toBeLessThan(5);
  expect(rollC.along, 'Vr reached on the runway').toBeLessThan(rw.length);
  expect(roll.stats.seconds, 'C172RG reaches 55 KIAS in well under 30 s').toBeLessThan(30);

  // ── Phase 2: rotate → airborne ──
  pilot.set({ vertical: { mode: 'pitch', deg: 8 } });
  const rotate = flyPhase(s, pilot, { env, seconds: 20, until: (x) => x.phase === 'airborne' && x.airborneTime > 2 });
  s = rotate.state;
  expect(rotate.stats.metAt, describeState(s)).not.toBeNull();
  expect(simStateLabel(s)).toBe('airborne');
  expect(s.wheelContact).toEqual([false, false, false]);
  expect(isOnRunway(s.position.x, s.position.z) || toRunwayCoords(s.position.x, s.position.z, rw).along > rw.length).toBe(true);
  expect(rotate.stats.stalledSeen).toBe(false);

  // ── Phase 3: climb at Vy (75 KIAS) to 1,500 ft above the field ──
  const target = field + 1500 * FT_TO_M;
  pilot.set({ vertical: { mode: 'speed', kt: 75 }, lateral: { mode: 'heading', deg: rw.headingDeg } });
  let climbIas: number[] = [];
  const climb = flyPhase(s, pilot, {
    env, seconds: 400, until: (x) => x.position.y >= target - 15,
    each: (x) => { if (x.position.y > field + 300 * FT_TO_M) climbIas.push(iasKt(x)); },
  });
  s = climb.state;
  expect(climb.stats.metAt, describeState(s)).not.toBeNull();
  expect(s.phase).toBe('airborne');
  expect(climb.stats.stalledSeen).toBe(false);
  climbIas = climbIas.slice(Math.floor(climbIas.length * 0.2));
  const meanIas = climbIas.reduce((a, b) => a + b, 0) / climbIas.length;
  expect(meanIas, 'climbs at ~75 KIAS').toBeGreaterThan(70);
  expect(meanIas).toBeLessThan(80);
  expect(climb.stats.minY).toBeGreaterThan(field);

  // ── Phase 4: level off at 1,500 ft, cruise power ──
  pilot.set({ vertical: { mode: 'altitude', m: target }, throttle: { mode: 'speed', kt: 95 } });
  const level = flyPhase(s, pilot, { env, seconds: 60 });
  s = level.state;
  expect(s.phase).toBe('airborne');
  expect(Math.abs(s.position.y - target), describeState(s)).toBeLessThan(100 * FT_TO_M);
  expect(Math.abs(s.velocity.y) * 196.85, 'level: |VS| < 300 fpm').toBeLessThan(300);
  expect(Math.abs(s.derived.rollDeg)).toBeLessThan(5);
  return s;
}

describe('mission: take-off and climb to 1,500 ft', () => {
  it('flat world (FLAT_ENV)', () => {
    const s = takeoffAndClimb(FLAT_ENV);
    expect(s.crash).toBeNull();
  });

  it('hilly world (airport plateau, sine hills, ridge, lake)', () => {
    const s = takeoffAndClimb(HILLY_ENV);
    expect(s.crash).toBeNull();
    expect(s.derived.altitudeAGL).toBeGreaterThan(300);
  });
});
