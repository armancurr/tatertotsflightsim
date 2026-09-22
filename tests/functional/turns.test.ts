/**
 * Mission (b): a 90° left turn and a 90° right turn at 1,500 ft above the field,
 * holding altitude within ±150 ft, coordinated, at cruise speed.
 */
import { describe, it, expect } from 'vitest';
import type { AircraftState, Environment } from '../../src/types';
import { createTrimmedState, FLAT_ENV, simStateLabel } from '../../src/physics';
import { FT_TO_M } from '../../src/config';
import { ScriptedPilot, flyPhase, describeState } from '../support/pilot';
import { HILLY_ENV, FIELD_ELEV } from '../support/envs';

const wrap180 = (d: number) => {
  const w = ((d % 360) + 360) % 360;
  return w > 180 ? w - 360 : w;
};

function turnMission(env: Environment, field: number) {
  const target = field + 1500 * FT_TO_M;
  const { state, controls } = createTrimmedState({ altitudeM: target, iasKt: 95, headingDeg: 360, x: 0, z: -2000 }, env);
  const pilot = new ScriptedPilot({
    throttle: controls.throttle,
    elevatorTrim: controls.elevatorTrim,
    vertical: { mode: 'altitude', m: target },
    lateral: { mode: 'heading', deg: 360 },
  });
  pilot.set({ throttle: { mode: 'speed', kt: 95 } });
  let s: AircraftState = state;

  // Settle on heading 360.
  s = flyPhase(s, pilot, { env, seconds: 10 }).state;
  expect(simStateLabel(s)).toBe('airborne');

  const turn = (toHeading: number, dir: 'left' | 'right') => {
    pilot.set({ lateral: { mode: 'heading', deg: toHeading, maxBank: 25 } });
    let minRoll = Infinity;
    let maxRoll = -Infinity;
    let maxAltErr = 0;
    let maxSlipDeg = 0;
    const r = flyPhase(s, pilot, {
      env,
      seconds: 90,
      until: (x) => Math.abs(wrap180(x.derived.headingDeg - toHeading)) < 2 && Math.abs(x.derived.rollDeg) < 3,
      each: (x) => {
        minRoll = Math.min(minRoll, x.derived.rollDeg);
        maxRoll = Math.max(maxRoll, x.derived.rollDeg);
        maxAltErr = Math.max(maxAltErr, Math.abs(x.position.y - target));
        maxSlipDeg = Math.max(maxSlipDeg, Math.abs(x.derived.beta) * 57.2958);
      },
    });
    s = r.state;
    expect(r.stats.metAt, `turn to ${toHeading}: ${describeState(s)}`).not.toBeNull();
    expect(s.phase).toBe('airborne');
    expect(r.stats.stalledSeen).toBe(false);
    // Banked the right way, at a sensible angle.
    if (dir === 'left') {
      expect(minRoll).toBeLessThan(-15);
      expect(maxRoll).toBeLessThan(5);
    } else {
      expect(maxRoll).toBeGreaterThan(15);
      expect(minRoll).toBeGreaterThan(-5);
    }
    expect(r.stats.maxAbsRoll).toBeLessThan(35);
    expect(maxAltErr / FT_TO_M, 'altitude held within ±150 ft').toBeLessThan(150);
    expect(maxSlipDeg, 'coordinated').toBeLessThan(5);
    // A 90° turn at standard-ish bank takes 10–40 s.
    expect(r.stats.seconds).toBeGreaterThan(8);
    expect(r.stats.seconds).toBeLessThan(40);
    // Roll out and stay on the new heading.
    const hold = flyPhase(s, pilot, { env, seconds: 10 });
    s = hold.state;
    expect(Math.abs(wrap180(s.derived.headingDeg - toHeading))).toBeLessThan(5);
    expect(Math.abs(s.position.y - target) / FT_TO_M).toBeLessThan(150);
  };

  turn(270, 'left');
  turn(360, 'right');
  return s;
}

describe('mission: 90° turns holding altitude', () => {
  it('flat world: left 360→270 then right 270→360, ±150 ft', () => {
    const s = turnMission(FLAT_ENV, 0);
    expect(s.crash).toBeNull();
  });

  it('hilly world: same turns 1,500 ft above the field', () => {
    const s = turnMission(HILLY_ENV, FIELD_ELEV);
    expect(s.crash).toBeNull();
  });
});
