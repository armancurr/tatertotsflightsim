/**
 * Functional: the `audio` system plug-in — engine sound per aircraft (initial aircraft, the
 * onAircraftChange hook, and the frame's def), the crash effects' window events `sim:explosion` /
 * `sim:impact`, reset, and the QA hooks on window (runAudioSelfTest, simAudio); a vessel (the V50's
 * 'marineDiesel' voice fed from state.vessel, no aircraft horns).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import mod from '../../src/game/systems/audio';
import type { SimSystem, SystemContext, SystemFrame } from '../../src/game/systems/types';
import type { AircraftDef } from '../../src/fleet/types';
import type { AircraftState, Controls } from '../../src/types';
import { MockAudioContext, violations } from './mockAudio';

type G = Record<string, unknown>;
const g = globalThis as unknown as G;
const saved: G = {};
const KEYS = ['AudioContext', 'addEventListener', 'removeEventListener', 'dispatchEvent', 'runAudioSelfTest', 'simAudio'];

const piston = { id: 'c172rg', sound: 'piston' } as unknown as AircraftDef;
const jet = { id: 'f16', sound: 'jet' } as unknown as AircraftDef;
const boat = { id: 'v50', kind: 'vessel', sound: 'marineDiesel' } as unknown as AircraftDef;

function state(p: Partial<AircraftState> = {}): AircraftState {
  return {
    time: 10, position: { x: 0, y: 100, z: 0 }, velocity: { x: 0, y: 0, z: -80 }, orientation: { x: 0, y: 0, z: 0, w: 1 },
    angularVelocity: { x: 0, y: 0, z: 0 },
    engine: { running: true, starting: false, startTimer: 0, failed: false, power: 1, rpm: 100, thrust: 0, afterburner: 0 },
    flapsDeg: 0, gearPos: 0, phase: 'airborne', stalled: false, onGround: false, wheelContact: [false, false, false],
    wheelCompression: [0, 0, 0], airborneTime: 30, touchdown: null, crash: null,
    derived: {
      tas: 80, ias: 80, groundSpeed: 80, alpha: 0.05, beta: 0, verticalSpeed: 0, altitudeAGL: 70, headingDeg: 0,
      pitchDeg: 2, rollDeg: 0, loadFactor: 1, density: 1.2, p: 0, q: 0, r: 0,
    },
    ...p,
  } as AircraftState;
}
const controls: Controls = {
  throttle: 1, elevator: 0, aileron: 0, rudder: 0, elevatorTrim: 0, flapsNotch: 0, gearDown: false, brake: 0, parkingBrake: false, engineOn: true,
};

let current: AircraftDef = piston;
function ctxStub(): SystemContext {
  return {
    env: { surfaceAt: () => 'runway' },
    actions: { currentAircraft: () => current },
  } as unknown as SystemContext;
}
function frame(def: AircraftDef, s = state()): SystemFrame {
  return {
    state: s, controls, controlState: {}, camera: { position: { x: 0, y: 100, z: 20 } }, dt: 1 / 60, time: 1, paused: false,
    cameraMode: 'chase', fps: {}, readings: null, def, aircraft: {},
  } as unknown as SystemFrame;
}

let sys: SimSystem;
beforeEach(async () => {
  violations.length = 0;
  for (const k of KEYS) saved[k] = g[k];
  const target = new EventTarget();
  g.addEventListener = target.addEventListener.bind(target);
  g.removeEventListener = target.removeEventListener.bind(target);
  g.dispatchEvent = target.dispatchEvent.bind(target);
  g.AudioContext = MockAudioContext;
  MockAudioContext.instances.length = 0;
  current = piston;
});
afterEach(() => {
  sys?.dispose?.();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete g[k];
    else g[k] = saved[k];
  }
  expect(violations).toEqual([]);
});

const unlock = async () => {
  (g.dispatchEvent as (e: Event) => boolean)(new Event('keydown'));
  await new Promise((r) => setTimeout(r, 0));
};
const stats = () => sys.stats!() as Record<string, number>;

describe('audio system', () => {
  it('starts with the current aircraft\'s engine sound, and swaps on onAircraftChange', async () => {
    current = jet;
    sys = await mod.create(ctxStub());
    await unlock();
    sys.update!(frame(jet));
    expect(stats().jet).toBe(1);
    current = piston;
    sys.onAircraftChange!(piston, {} as never);
    sys.update!(frame(piston, state({ engine: { running: true, starting: false, startTimer: 0, failed: false, power: 0.8, rpm: 2400, thrust: 0 } })));
    expect(stats().jet).toBe(0);
    expect(stats().exhaust).toBeGreaterThan(0);
  });

  it('follows the frame\'s aircraft even without the hook', async () => {
    sys = await mod.create(ctxStub());
    await unlock();
    sys.update!(frame(piston));
    expect(stats().jet).toBe(0);
    sys.update!(frame(jet));
    expect(stats().jet).toBe(1);
  });

  it('plays the crash effects\' sim:explosion and sim:impact events (distance from the camera)', async () => {
    sys = await mod.create(ctxStub());
    await unlock();
    const crashed = state({ phase: 'crashed', crash: { time: 9, reason: 'Hit terrain', speedKt: 200, verticalSpeedFpm: -3000, position: { x: 0, y: 100, z: 0 } } });
    sys.update!(frame(jet, state()));
    sys.update!(frame(jet, crashed));
    const dispatch = g.dispatchEvent as (e: Event) => boolean;
    dispatch(new CustomEvent('sim:explosion', { detail: { position: { x: 0, y: 100, z: 0 }, size: 1 } }));
    dispatch(new CustomEvent('sim:impact', { detail: { position: { x: 5, y: 100, z: 0 }, speed: 30 } }));
    dispatch(new CustomEvent('sim:impact', { detail: null }));
    expect(stats().explosions).toBe(1);
    expect(stats().impacts).toBe(1);
    expect(stats().pendingExplosions).toBe(0);
    expect(stats().errors).toBe(0);
  });

  it('onReset silences the crash; dispose removes the listeners and the window hooks', async () => {
    sys = await mod.create(ctxStub());
    await unlock();
    expect(typeof g.runAudioSelfTest).toBe('function');
    expect(typeof (g.simAudio as { levels: unknown }).levels).toBe('function');
    const crashed = state({ phase: 'crashed', crash: { time: 9, reason: 'Hit terrain', speedKt: 90, verticalSpeedFpm: -3000, position: { x: 0, y: 100, z: 0 } } });
    sys.update!(frame(piston, state()));
    sys.update!(frame(piston, crashed));
    expect(stats().pendingExplosions).toBeGreaterThan(0);
    sys.onReset!('runway');
    expect(stats().pendingExplosions).toBe(0);
    expect(stats().fire).toBe(0);
    sys.dispose!();
    const before = stats().explosions;
    (g.dispatchEvent as (e: Event) => boolean)(new CustomEvent('sim:explosion', { detail: { size: 1 } }));
    expect(stats().explosions).toBe(before);
    expect(g.simAudio).toBeUndefined();
    expect(g.runAudioSelfTest).toBeUndefined();
    sys = undefined as unknown as SimSystem;
  });

  it('a vessel plays the marine diesels from state.vessel, with no stall or gear horn', async () => {
    current = boat;
    sys = await mod.create(ctxStub());
    await unlock();
    const prop = { rpm: 3000, n: 27.5, gear: 'ahead', thrust: 14000, steerDeg: 0, load: 0.8, boost: 0.9 };
    const vessel = {
      seaTime: 1, propulsors: [prop, { ...prop }], tabs: 0, mooring: null, speedMs: 14.4, leewayDeg: 0, trimDeg: 4, planing: 0.9,
      wettedLength: 9, wettedArea: 30, displacedVolume: 12, resistance: 26000, depthUnderKeel: Infinity, aground: false, capsizeTime: 0, surfaceY: 0,
    };
    const s = state({
      phase: 'afloat', onGround: false, gearPos: 1, vessel,
      engine: { running: true, starting: false, startTimer: 0, failed: false, power: 0.75, rpm: 3000, thrust: 28000 },
    } as Partial<AircraftState>);
    const f = { ...frame(boat, s), readings: { stallWarning: true, gearHorn: true } } as unknown as SystemFrame;
    sys.update!(f);
    sys.update!(f);
    const L = stats();
    expect(L.marine).toBe(1);
    expect(L.marineRpm).toBeCloseTo(3000, 6); // (firingHz carries the Doppler shift: the boat runs away from the camera)
    expect(L.firingHz).toBeGreaterThan(100);
    expect(L.hullRush).toBeGreaterThan(0);
    expect(L.skim).toBeGreaterThan(0);
    expect(L.horn).toBe(0);
    expect(L.gearHorn).toBe(0);
    expect(L.rolling).toBe(0);
    // Back to an aircraft.
    sys.onAircraftChange!(piston, {} as never);
    sys.update!(frame(piston, state({ engine: { running: true, starting: false, startTimer: 0, failed: false, power: 0.8, rpm: 2400, thrust: 0 } })));
    expect(stats().marine).toBe(0);
    expect(stats().exhaust).toBeGreaterThan(0);
  });

  it('override (QA hook) forces inputs on top of the live state', async () => {
    sys = await mod.create(ctxStub());
    await unlock();
    const sa = g.simAudio as { override(p: object | null): void };
    sa.override({ rpm: 100, power: 1, afterburner: 1, engineRunning: true });
    sys.update!(frame(jet));
    expect(stats().afterburner).toBeGreaterThan(0.5);
    sa.override(null);
    sys.update!(frame(jet));
    expect(stats().afterburner).toBe(0);
  });
});
