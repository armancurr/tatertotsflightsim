/**
 * Mission (e): from the final-approach reset, fly the 3° glide path, flare, land
 * on runway 36 ('landed', rating better than 'hard', on the runway, near the
 * centreline), then brake to a full stop on the runway.
 */
import { describe, it, expect } from 'vitest';
import type { Environment } from '../../src/types';
import { createApproachState, approachControls, FLAT_ENV, simStateLabel } from '../../src/physics';
import { isOnRunway, runwayFrame, toRunwayCoords } from '../../src/world/runway';
import { ScriptedPilot, flyPhase, describeState, iasKt, wheelHeight } from '../support/pilot';
import { HILLY_ENV, RUNWAY_FLAT_ENV, FIELD_ELEV } from '../support/envs';

const rw = runwayFrame();

function approachAndLand(env: Environment, field: number) {
  const base = approachControls();
  let s = createApproachState(env);

  // ── Phase 0: the reset puts us on final, stable ──
  expect(simStateLabel(s)).toBe('airborne');
  expect(s.gearPos).toBe(1);
  expect(s.flapsDeg).toBeGreaterThan(0);
  const c0 = toRunwayCoords(s.position.x, s.position.z, rw);
  expect(c0.along).toBeLessThan(-3000);
  expect(Math.abs(c0.across)).toBeLessThan(1);
  expect(s.derived.altitudeAGL).toBeGreaterThan(150);

  const pilot = new ScriptedPilot({
    throttle: base.throttle, elevatorTrim: base.elevatorTrim, flapsNotch: base.flapsNotch,
    vertical: { mode: 'glidepath', deg: 3, aimAlongM: 300, fieldElev: field }, lateral: { mode: 'centreline' },
  });
  pilot.set({ throttle: { mode: 'speed', kt: 70 } });

  // ── Phase 1: final approach down to ~20 ft ──
  let maxGpDev = 0;
  let maxAcross = 0;
  const fin = flyPhase(s, pilot, {
    env, seconds: 200,
    until: (x) => wheelHeight(x) - field < 6 || x.phase !== 'airborne',
    each: (x) => {
      const c = toRunwayCoords(x.position.x, x.position.z, rw);
      const want = field + Math.tan((3 * Math.PI) / 180) * (300 - c.along);
      maxGpDev = Math.max(maxGpDev, Math.abs(x.position.y - want));
      maxAcross = Math.max(maxAcross, Math.abs(c.across));
    },
  });
  s = fin.state;
  expect(s.phase, describeState(s)).toBe('airborne');
  expect(fin.stats.stalledSeen).toBe(false);
  expect(maxGpDev, 'on the glide path (±20 m)').toBeLessThan(20);
  expect(maxAcross, 'on the extended centreline').toBeLessThan(10);
  expect(fin.stats.minIasKt).toBeGreaterThan(60);
  expect(fin.stats.maxIasKt).toBeLessThan(85);
  const cFin = toRunwayCoords(s.position.x, s.position.z, rw);
  expect(cFin.along, 'still before the aim point').toBeLessThan(300);

  // ── Phase 2: flare, power to idle, touchdown ──
  pilot.set({ vertical: { mode: 'flare', fieldElev: field }, throttle: 0 });
  const flare = flyPhase(s, pilot, { env, seconds: 40, until: (x) => x.phase !== 'airborne' });
  s = flare.state;
  expect(s.phase, describeState(s)).toBe('landed');
  expect(simStateLabel(s)).toBe('landed');
  const td = s.touchdown!;
  expect(td).not.toBeNull();
  expect(td.rating, `touchdown ${td.verticalSpeedFpm.toFixed(0)} fpm`).not.toBe('hard');
  expect(['butter', 'smooth', 'firm']).toContain(td.rating);
  expect(td.onRunway).toBe(true);
  expect(isOnRunway(s.position.x, s.position.z)).toBe(true);
  expect(Math.abs(td.centerlineOffsetM ?? 99)).toBeLessThan(8);
  expect(td.airspeedKt).toBeGreaterThan(40);
  expect(td.airspeedKt).toBeLessThan(75);
  expect(td.pitchDeg, 'main wheels first').toBeGreaterThan(0);
  expect(Math.abs(td.bankDeg)).toBeLessThan(5);

  // ── Phase 3: rollout — lower the nose, brake to a full stop on the runway ──
  pilot.set({ vertical: { mode: 'elevator', value: 0 }, throttle: 0 });
  const tdAlong = toRunwayCoords(s.position.x, s.position.z, rw).along;
  const roll = flyPhase(s, pilot, {
    env, seconds: 90,
    until: (x) => x.derived.groundSpeed < 0.2,
    each: (x) => { if (x.wheelContact[0]) pilot.set({ brake: 1 }); },
  });
  s = roll.state;
  expect(roll.stats.metAt, describeState(s)).not.toBeNull();
  expect(s.phase).toBe('landed');
  expect(s.crash).toBeNull();
  expect(s.touchdown).toEqual(td);
  const stop = toRunwayCoords(s.position.x, s.position.z, rw);
  expect(isOnRunway(s.position.x, s.position.z), describeState(s)).toBe(true);
  expect(stop.along - tdAlong, 'ground roll with brakes').toBeLessThan(450);
  expect(Math.abs(stop.across)).toBeLessThan(8);
  expect(iasKt(s)).toBeLessThan(2);
  return s;
}

describe('mission: approach and landing on runway 36', () => {
  it('flat world (FLAT_ENV, all runway)', () => {
    approachAndLand(FLAT_ENV, 0);
  });
  it('flat world with a real runway rectangle (grass elsewhere)', () => {
    approachAndLand(RUNWAY_FLAT_ENV, 0);
  });
  it('hilly world (runway at the field elevation)', () => {
    approachAndLand(HILLY_ENV, FIELD_ELEV);
  });
});
