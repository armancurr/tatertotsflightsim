/**
 * Missions (d), (f), (g): the ways a flight ends badly, and the reset afterwards.
 *   (d) controlled flight into the western ridge → 'crashed' ("Hit terrain"), frozen; reset → clean runway state
 *   (f) an otherwise good approach and flare with the gear up → crash "Gear-up landing"
 *   (g) a ditching on the lake → crash "Ditched in water"
 */
import { describe, it, expect } from 'vitest';
import type { AircraftState, Controls } from '../../src/types';
import {
  createInitialState, createApproachState, approachControls, createTrimmedState, defaultControls, step, simStateLabel,
} from '../../src/physics';
import { buildSimSnapshot } from '../../src/game/simApi';
import { createControlState, resetControls, updateControls, emptyInputFrame } from '../../src/input/controlSystem';
import { isOnRunway, runwayFrame, toRunwayCoords } from '../../src/world/runway';
import { ScriptedPilot, flyPhase, describeState, wheelHeight, DT } from '../support/pilot';
import { HILLY_ENV, RIDGE, LAKE, FIELD_ELEV, hillyHeight } from '../support/envs';
import { deepFreeze, stateViolation } from '../support/invariants';

const env = HILLY_ENV;
const rw = runwayFrame();
const FPS = { fps: 60, avg: 60, min: 60, onePercentLow: 60, longFrames: 0, frames: 1 };

function expectFrozenCrash(s: AircraftState, c: Controls) {
  let x = deepFreeze(structuredClone(s));
  for (let i = 0; i < 240; i++) x = step(x, { ...c, throttle: 1, elevator: 1, engineOn: true }, DT, env);
  expect(x.phase).toBe('crashed');
  expect(x.crash).toEqual(s.crash);
  expect(x.position).toEqual(s.position);
  expect(x.velocity).toEqual({ x: 0, y: 0, z: 0 });
  expect(x.engine.running).toBe(false);
  expect(x.time).toBeCloseTo(s.time + 2, 6);
}

describe('mission: controlled flight into terrain, then reset', () => {
  it('flying level at 200 m MSL toward the western ridge ends in "Hit terrain" on the ridge', () => {
    const alt = 200;
    const { state, controls } = createTrimmedState({ altitudeM: alt, iasKt: 90, headingDeg: 270, x: -1500, z: 0 }, env);
    const pilot = new ScriptedPilot({
      throttle: controls.throttle, elevatorTrim: controls.elevatorTrim,
      vertical: { mode: 'altitude', m: alt }, lateral: { mode: 'heading', deg: 270 },
    });
    pilot.set({ throttle: { mode: 'speed', kt: 90 } });
    let last!: Controls;
    const r = flyPhase(state, pilot, { env, seconds: 240, until: (x) => x.phase === 'crashed', each: (_x, c) => { last = c; } });
    const s = r.state;
    expect(r.stats.metAt, describeState(s)).not.toBeNull();
    expect(s.phase).toBe('crashed');
    expect(simStateLabel(s)).toBe('crashed');
    // Level until the end: the pilot held altitude, the terrain came up to meet it.
    expect(r.stats.minY).toBeGreaterThan(alt - 30);
    const crash = s.crash!;
    expect(crash.reason).toBe('Hit terrain');
    expect(crash.position.x).toBeLessThan(RIDGE.startX);
    expect(Math.abs(crash.position.y - hillyHeight(crash.position.x, crash.position.z))).toBeLessThan(15);
    expect(crash.speedKt).toBeGreaterThan(60);
    expect(stateViolation(s)).toBeNull();
    // window.sim sees it too.
    const snap = buildSimSnapshot({ state: s, controls: last, fps: FPS, cameraMode: 'chase', paused: false });
    expect(snap.state).toBe('crashed');
    expect(snap.crash).toBe('Hit terrain');
    expect(snap.engine).toBe('failed');
    // Terminal: nothing the pilot does changes it.
    expectFrozenCrash(s, last);

    // ── Reset (R): a clean aircraft on the runway, controls back to their defaults ──
    const fresh = createInitialState(env);
    expect(fresh.phase).toBe('ground');
    expect(fresh.crash).toBeNull();
    expect(fresh.touchdown).toBeNull();
    expect(fresh.time).toBe(0);
    expect(fresh.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(fresh.gearPos).toBe(1);
    expect(fresh.flapsDeg).toBe(0);
    expect(fresh.engine.running).toBe(true);
    expect(fresh.engine.failed).toBe(false);
    expect(fresh.wheelContact).toEqual([true, true, true]);
    expect(isOnRunway(fresh.position.x, fresh.position.z)).toBe(true);
    expect(fresh.derived.headingDeg).toBeCloseTo(rw.headingDeg % 360, 3);
    expect(fresh.position.y).toBeGreaterThan(FIELD_ELEV);
    expect(fresh.position.y).toBeLessThan(FIELD_ELEV + 2);
    expect(stateViolation(fresh)).toBeNull();

    let cs = updateControls(createControlState(), { ...emptyInputFrame(), held: new Set(['KeyW', 'ArrowDown']), pressed: [{ code: 'KeyG', shift: false }, { code: 'KeyF', shift: false }] }, 1).state;
    expect(cs.controls.throttle).toBeGreaterThan(0.3);
    cs = resetControls(cs);
    expect(cs.controls).toEqual(defaultControls());

    // It sits still on the runway (brakes off, idle) and does not crash.
    const rest = flyPhase(fresh, new ScriptedPilot({ throttle: 0, vertical: { mode: 'elevator', value: 0 } }), { env, seconds: 5 });
    expect(rest.state.phase).toBe('ground');
    expect(Math.hypot(rest.state.position.x - fresh.position.x, rest.state.position.z - fresh.position.z)).toBeLessThan(1);
  });
});

describe('mission: gear-up landing', () => {
  it('a stabilised approach and flare with the gear retracted ends in "Gear-up landing" on the runway', () => {
    const base = approachControls();
    let s = createApproachState(env);
    const pilot = new ScriptedPilot({
      throttle: base.throttle, elevatorTrim: base.elevatorTrim, flapsNotch: base.flapsNotch, gearDown: false,
      vertical: { mode: 'glidepath', deg: 3, aimAlongM: 300, fieldElev: FIELD_ELEV }, lateral: { mode: 'centreline' },
    });
    pilot.set({ throttle: { mode: 'speed', kt: 72 } });
    const fin = flyPhase(s, pilot, { env, seconds: 200, until: (x) => wheelHeight(x) - FIELD_ELEV < 6 || x.phase !== 'airborne' });
    s = fin.state;
    expect(s.phase, describeState(s)).toBe('airborne');
    expect(s.gearPos, 'gear fully retracted on final').toBe(0);
    // Flare — belly first, because the wheels are in their wells.
    pilot.set({ vertical: { mode: 'flare', fieldElev: FIELD_ELEV + 0.75 }, throttle: 0 });
    const flare = flyPhase(s, pilot, { env, seconds: 40, until: (x) => x.phase !== 'airborne' });
    s = flare.state;
    expect(s.phase, describeState(s)).toBe('crashed');
    expect(s.crash!.reason).toBe('Gear-up landing');
    expect(Math.abs(s.crash!.verticalSpeedFpm)).toBeLessThan(600);
    expect(isOnRunway(s.position.x, s.position.z)).toBe(true);
    expect(s.touchdown).toBeNull();
  });
});

describe('mission: ditching', () => {
  it('a slow, flapped descent onto the lake ends in "Ditched in water"', () => {
    const alt = LAKE.level + 60;
    const { state, controls } = createTrimmedState(
      { altitudeM: alt, iasKt: 65, headingDeg: 90, x: LAKE.x - 900, z: LAKE.z, flapsNotch: 2 }, env,
    );
    expect(env.waterLevel(state.position.x, state.position.z)).toBe(LAKE.level);
    const pilot = new ScriptedPilot({
      throttle: controls.throttle, elevatorTrim: controls.elevatorTrim, flapsNotch: 2,
      vertical: { mode: 'vs', ms: -1.5 }, lateral: { mode: 'heading', deg: 90 },
    });
    pilot.set({ throttle: { mode: 'speed', kt: 65 } });
    let s = flyPhase(state, pilot, { env, seconds: 60, until: (x) => wheelHeight(x) - LAKE.level < 5 || x.phase !== 'airborne' }).state;
    expect(s.phase, describeState(s)).toBe('airborne');
    pilot.set({ vertical: { mode: 'flare', fieldElev: LAKE.level }, throttle: 0 });
    s = flyPhase(s, pilot, { env, seconds: 30, until: (x) => x.phase !== 'airborne' }).state;
    expect(s.phase, describeState(s)).toBe('crashed');
    expect(s.crash!.reason).toBe('Ditched in water');
    expect(env.waterLevel(s.crash!.position.x, s.crash!.position.z)).toBe(LAKE.level);
    expect(Math.abs(s.crash!.position.y - LAKE.level)).toBeLessThan(3);
    expect(toRunwayCoords(s.position.x, s.position.z, rw).across).toBeGreaterThan(3000);
  });
});
