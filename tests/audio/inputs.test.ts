import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createAudioInputTracker } from '../../src/audio/inputs';
import { CONFIG, MS_TO_KT } from '../../src/config';
import type { AircraftState, Controls, TouchdownRecord } from '../../src/types';

const DT = 1 / 60;

function controls(p: Partial<Controls> = {}): Controls {
  return { throttle: 0.5, elevator: 0, aileron: 0, rudder: 0, elevatorTrim: 0, flapsNotch: 0, gearDown: true, brake: 0, parkingBrake: false, engineOn: true, ...p };
}

function state(p: Partial<AircraftState> = {}, derived: Partial<AircraftState['derived']> = {}): AircraftState {
  return {
    time: 10,
    position: { x: 0, y: 100, z: 0 },
    velocity: { x: 0, y: 0, z: -50 },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    angularVelocity: { x: 0, y: 0, z: 0 },
    engine: { running: true, starting: false, startTimer: 0, failed: false, power: 0.7, rpm: 2350, thrust: 1500 },
    flapsDeg: 0,
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
      tas: 50, ias: 50, groundSpeed: 50, alpha: 0.05, beta: 0, verticalSpeed: 0, altitudeAGL: 70, headingDeg: 0,
      pitchDeg: 2, rollDeg: 0, loadFactor: 1, density: 1.2, p: 0, q: 0, r: 0, ...derived,
    },
    ...p,
  };
}

const td = (time: number, fpm: number): TouchdownRecord => ({
  time, verticalSpeedFpm: fpm, airspeedKt: 60, rating: 'smooth', bankDeg: 0, pitchDeg: 4, surface: 'runway', onRunway: true, centerlineOffsetM: 0,
});

describe('createAudioInputTracker', () => {
  it('maps the engine, speeds and controls', () => {
    const track = createAudioInputTracker();
    const a = track({ state: state(), controls: controls({ brake: 0.4 }), cameraMode: 'cockpit', paused: false, dt: DT });
    expect(a.rpm).toBe(2350);
    expect(a.power).toBe(0.7);
    expect(a.engineRunning).toBe(true);
    expect(a.starting).toBe(false);
    expect(a.airspeedKt).toBeCloseTo(50 * MS_TO_KT, 9);
    expect(a.groundSpeedKt).toBeCloseTo(50 * MS_TO_KT, 9);
    expect(a.brake).toBe(0.4);
    expect(a.cameraMode).toBe('cockpit');
    expect(a.crashed).toBe(false);
    expect(a.surface).toBe('runway');
  });
  it('reports a touchdown exactly once per record', () => {
    const track = createAudioInputTracker();
    const base = { controls: controls(), cameraMode: 'chase' as const, paused: false, dt: DT };
    expect(track({ ...base, state: state() }).touchdownFpm).toBeNull();
    expect(track({ ...base, state: state({ touchdown: td(12, -240), onGround: true }) }).touchdownFpm).toBe(-240);
    expect(track({ ...base, state: state({ touchdown: td(12, -240), onGround: true }) }).touchdownFpm).toBeNull();
    expect(track({ ...base, state: state({ touchdown: { ...td(12, -240) }, onGround: true }) }).touchdownFpm).toBeNull(); // cloned record
    expect(track({ ...base, state: state({ touchdown: td(40, -520), onGround: true }) }).touchdownFpm).toBe(-520);
    // reset clears; the next landing reports even if the numbers repeat
    expect(track({ ...base, state: state({ touchdown: null }) }).touchdownFpm).toBeNull();
    expect(track({ ...base, state: state({ touchdown: td(40, -520), onGround: true }) }).touchdownFpm).toBe(-520);
  });
  it('a touchdown already present on the first frame is not replayed', () => {
    const track = createAudioInputTracker();
    const a = track({ state: state({ touchdown: td(3, -300) }), controls: controls(), cameraMode: 'chase', paused: false, dt: DT });
    expect(a.touchdownFpm).toBeNull();
  });
  it('gear and flap motors run while the surfaces travel', () => {
    const track = createAudioInputTracker();
    const base = { cameraMode: 'chase' as const, paused: false, dt: DT };
    expect(track({ ...base, state: state({ gearPos: 1 }), controls: controls() }).gearMoving).toBe(false);
    expect(track({ ...base, state: state({ gearPos: 0.6 }), controls: controls({ gearDown: false }) }).gearMoving).toBe(true);
    expect(track({ ...base, state: state({ gearPos: 0 }), controls: controls({ gearDown: false }) }).gearMoving).toBe(true); // moved this frame
    expect(track({ ...base, state: state({ gearPos: 0 }), controls: controls({ gearDown: false }) }).gearMoving).toBe(false);
    const n = CONFIG.aircraft.flaps.notchesDeg;
    expect(track({ ...base, state: state({ flapsDeg: 4 }), controls: controls({ flapsNotch: 1 }) }).flapsMoving).toBe(true);
    expect(track({ ...base, state: state({ flapsDeg: n[1] }), controls: controls({ flapsNotch: 1 }) }).flapsMoving).toBe(true); // moved this frame
    expect(track({ ...base, state: state({ flapsDeg: n[1] }), controls: controls({ flapsNotch: 1 }) }).flapsMoving).toBe(false);
  });
  it('stall warning from angle of attack (margin below the stall), or from the caller', () => {
    const track = createAudioInputTracker();
    const base = { controls: controls(), cameraMode: 'chase' as const, paused: false, dt: DT };
    const stallRad = (CONFIG.aircraft.aero.stallAlphaDeg * Math.PI) / 180;
    expect(track({ ...base, state: state({}, { alpha: 0.05 }) }).stallWarning).toBe(false);
    expect(track({ ...base, state: state({}, { alpha: stallRad - 0.02 }) }).stallWarning).toBe(true);
    expect(track({ ...base, state: state({}, { alpha: 0.05 }), stallWarning: true }).stallWarning).toBe(true);
    expect(track({ ...base, state: state({ onGround: true }, { alpha: stallRad, ias: 3 }) }).stallWarning).toBe(false);
  });
  it('gear warning: from the caller when given, else computed from the gear, throttle, flaps and squat switch', () => {
    const track = createAudioInputTracker();
    const base = { cameraMode: 'cockpit' as const, paused: false, dt: DT };
    expect(track({ ...base, state: state({ gearPos: 0 }), controls: controls({ throttle: 0.05, gearDown: false }) }).gearWarning).toBe(true);
    expect(track({ ...base, state: state({ gearPos: 0 }), controls: controls({ throttle: 0.6, gearDown: false }) }).gearWarning).toBe(false);
    expect(track({ ...base, state: state({ gearPos: 1 }), controls: controls({ throttle: 0.05 }) }).gearWarning).toBe(false);
    const ground = state({ gearPos: 1, onGround: true, phase: 'ground' });
    expect(track({ ...base, state: ground, controls: controls({ throttle: 0, gearDown: false }) }).gearWarning).toBe(true);
    expect(track({ ...base, state: state({ gearPos: 0 }), controls: controls({ throttle: 0.05, gearDown: false }), gearWarning: false }).gearWarning).toBe(false);
  });
  it('crash maps to crashed + impact speed', () => {
    const track = createAudioInputTracker();
    const a = track({
      state: state({ phase: 'crashed', crash: { time: 9, reason: 'Hit terrain', speedKt: 88, verticalSpeedFpm: -2000, position: { x: 0, y: 0, z: 0 } } }),
      controls: controls(), cameraMode: 'chase', paused: false, dt: DT,
    });
    expect(a.crashed).toBe(true);
    expect(a.crashSpeedKt).toBe(88);
  });
  it('listener distance and closing speed from the camera (fly-by Doppler), with teleports ignored', () => {
    const track = createAudioInputTracker();
    const base = { controls: controls(), cameraMode: 'external' as const, paused: false, dt: DT };
    // aircraft at z=0 flying north (-z) at 50 m/s toward a fixed camera 200 m north
    let a = track({ ...base, state: state({ position: { x: 0, y: 100, z: 0 } }), cameraPosition: { x: 0, y: 100, z: -200 } });
    expect(a.listenerDistanceM).toBeCloseTo(200, 6);
    for (let i = 0; i < 60; i++) a = track({ ...base, state: state({ position: { x: 0, y: 100, z: 0 } }), cameraPosition: { x: 0, y: 100, z: -200 } });
    expect(a.closingSpeedMs!).toBeGreaterThan(45);
    // a camera jump of 5 km in one frame is a teleport, not a 300 km/s camera
    a = track({ ...base, state: state({ position: { x: 0, y: 100, z: 0 } }), cameraPosition: { x: 5000, y: 100, z: -200 } });
    expect(Math.abs(a.closingSpeedMs!)).toBeLessThan(100);
  });
  it('fuzz: outputs are always finite for finite-or-not state numbers', () => {
    const wild = fc.oneof(fc.double(), fc.constantFrom(Number.NaN, Infinity, -Infinity));
    fc.assert(fc.property(fc.array(fc.tuple(wild, wild, wild, wild, wild), { minLength: 1, maxLength: 20 }), (rows) => {
      const track = createAudioInputTracker();
      for (const [rpm, ias, gp, fd, dt] of rows) {
        const a = track({
          state: state({ gearPos: gp, flapsDeg: fd, engine: { running: true, starting: false, startTimer: 0, failed: false, power: 0.5, rpm, thrust: 0 } }, { ias, groundSpeed: ias }),
          controls: controls(), cameraMode: 'orbit', paused: false, dt, cameraPosition: { x: rpm, y: 0, z: ias },
        });
        for (const v of [a.rpm, a.power, a.airspeedKt, a.groundSpeedKt, a.brake, a.listenerDistanceM ?? 0, a.closingSpeedMs ?? 0]) expect(Number.isFinite(v)).toBe(true);
      }
    }));
  });
});
