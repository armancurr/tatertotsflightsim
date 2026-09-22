import { describe, it, expect } from 'vitest';
import { buildSimSnapshot, gearStateFromPos, installSimApi } from '../../src/game/simApi';
import type { AircraftState, Controls } from '../../src/types';
import { quatFromEuler } from '../../src/physics/frames';

function fakeState(over: Partial<AircraftState> = {}): AircraftState {
  return {
    time: 12,
    position: { x: 1, y: 304.8, z: 3 },
    velocity: { x: 0, y: 2.54, z: -50 },
    orientation: quatFromEuler(90, 5, -10),
    angularVelocity: { x: 0, y: 0, z: 0 },
    engine: { running: true, starting: false, startTimer: 0, failed: false, power: 0.8, rpm: 2450, thrust: 1800 },
    flapsDeg: 10,
    gearPos: 1,
    phase: 'airborne',
    stalled: false,
    onGround: false,
    wheelContact: [false, false, false],
    wheelCompression: [0, 0, 0],
    airborneTime: 30,
    touchdown: null,
    crash: null,
    derived: {
      tas: 51.44, ias: 51.44, groundSpeed: 50, alpha: 0.05, beta: 0, verticalSpeed: 2.54, altitudeAGL: 274.32,
      headingDeg: 90, pitchDeg: 5, rollDeg: -10, loadFactor: 1, density: 1.225, p: 0, q: 0, r: 0,
    },
    ...over,
  };
}
const controls: Controls = {
  throttle: 0.75, elevator: 0, aileron: 0, rudder: 0, elevatorTrim: 0.1, flapsNotch: 1, gearDown: true,
  brake: 0, parkingBrake: false, engineOn: true,
};
const fps = { fps: 59.6, avg: 60.1, min: 55, onePercentLow: 52, longFrames: 0, frames: 1000 };

describe('window.sim snapshot', () => {
  it('reports the required fields in display units', () => {
    const s = buildSimSnapshot({ state: fakeState(), controls, fps, cameraMode: 'chase', paused: false });
    expect(s.airspeed).toBeCloseTo(100, 0); // 51.44 m/s ≈ 100 kt
    expect(s.altitude).toBeCloseTo(1000, 0); // 304.8 m = 1000 ft
    expect(s.heading).toBeCloseTo(90, 5);
    expect(s.pitch).toBeCloseTo(5, 5);
    expect(s.roll).toBeCloseTo(-10, 5);
    expect(s.throttle).toBeCloseTo(75, 5);
    expect(s.gear).toBe('down');
    expect(s.flaps).toBeCloseTo(10, 5);
    expect(s.state).toBe('airborne');
    expect(s.fps).toBeCloseTo(59.6, 5);
  });
  it('adds the extras used while flying', () => {
    const s = buildSimSnapshot({ state: fakeState(), controls, fps, cameraMode: 'orbit', paused: true });
    expect(s.verticalSpeed).toBeCloseTo(500, 0);
    expect(s.altitudeAGL).toBeCloseTo(900, 0);
    expect(s.rpm).toBe(2450);
    expect(s.engine).toBe('running');
    expect(s.camera).toBe('orbit');
    expect(s.paused).toBe(true);
    expect(s.perf.avg).toBeCloseTo(60.1);
    expect(s.flapsNotch).toBe(1);
  });
  it('labels stalls and crashes', () => {
    expect(buildSimSnapshot({ state: fakeState({ stalled: true }), controls, fps, cameraMode: 'chase', paused: false }).state).toBe('stalled');
    const crashed = fakeState({
      phase: 'crashed',
      crash: { time: 5, reason: 'Hit terrain', speedKt: 90, verticalSpeedFpm: -2000, position: { x: 0, y: 0, z: 0 } },
      engine: { running: false, starting: false, startTimer: 0, failed: true, power: 0, rpm: 0, thrust: 0 },
    });
    const s = buildSimSnapshot({ state: crashed, controls, fps, cameraMode: 'chase', paused: false });
    expect(s.state).toBe('crashed');
    expect(s.crash).toBe('Hit terrain');
    expect(s.engine).toBe('failed');
  });
  it('derives the gear state from the gear position', () => {
    expect(gearStateFromPos(1)).toBe('down');
    expect(gearStateFromPos(0)).toBe('up');
    expect(gearStateFromPos(0.5)).toBe('transit');
  });
  it('installs a live window.sim object that is updated in place', () => {
    const win = {} as unknown as Window & { sim?: unknown };
    const api = installSimApi(win, { reset: () => {}, resetApproach: () => {}, setCamera: () => {}, setPaused: () => {} });
    const obj = (win as unknown as { sim: Record<string, unknown> }).sim;
    api.update(buildSimSnapshot({ state: fakeState(), controls, fps, cameraMode: 'chase', paused: false }));
    expect(obj.altitude).toBeCloseTo(1000, 0);
    api.update(buildSimSnapshot({ state: fakeState({ position: { x: 0, y: 609.6, z: 0 } }), controls, fps, cameraMode: 'chase', paused: false }));
    expect((win as unknown as { sim: Record<string, unknown> }).sim).toBe(obj);
    expect(obj.altitude).toBeCloseTo(2000, 0);
    expect(typeof obj.reset).toBe('function');
  });
});
