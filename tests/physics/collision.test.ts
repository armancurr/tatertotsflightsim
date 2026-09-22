/**
 * Collision detection: terrain, wingtips, belly, water, obstacles, over-G,
 * and the crash state that follows.
 */
import { describe, it, expect } from 'vitest';
import { CONFIG, MS_TO_KT } from '../../src/config';
import type { AircraftState, Environment } from '../../src/types';
import { createInitialState, simStateLabel, step, FLAT_ENV, defaultControls } from '../../src/physics';
import { quatFromEuler, bodyToWorld } from '../../src/physics/frames';
import { fly, trimmed, DT, allFinite } from './helpers';

const G = CONFIG.aircraft.geometry;

/** Lowest point of the airframe (structural points + wheels) relative to the CG, world y, for an orientation. */
function lowestOffset(s: AircraftState): number {
  let lo = Infinity;
  for (const p of [...G.structuralPoints, G.noseWheel, G.leftMainWheel, G.rightMainWheel]) {
    lo = Math.min(lo, bodyToWorld(s.orientation, p).y);
  }
  return lo;
}

/** Place an airborne state so its lowest point is `gap` metres above `surfaceY`, sinking at vs m/s. */
function placeAbove(s: AircraftState, surfaceY: number, gap: number, vs: number): AircraftState {
  return { ...s, position: { ...s.position, y: surfaceY + gap - lowestOffset(s) }, velocity: { ...s.velocity, y: vs } };
}

describe('collision detection', () => {
  it('flying nose-down into the ground is a crash: "Hit terrain"', () => {
    const { state, controls } = trimmed({ altitudeM: 150, iasKt: 100 });
    const s = fly(state, { ...controls, elevator: -0.7 }, 30, { until: (s) => s.phase === 'crashed' });
    expect(s.phase).toBe('crashed');
    expect(s.crash?.reason).toBe('Hit terrain');
    expect(s.crash!.speedKt).toBeGreaterThan(60);
    expect(s.crash!.verticalSpeedFpm).toBeLessThan(-1000);
  });

  it('flying level into rising terrain is a crash', () => {
    const env: Environment = { ...FLAT_ENV, groundHeight: (_x, z) => (z < -800 ? 200 : 0), surfaceAt: () => 'rock' };
    const { state, controls } = trimmed({ altitudeM: 100, iasKt: 100 });
    const s = fly(state, controls, 30, { env, until: (s) => s.phase === 'crashed' });
    expect(s.phase).toBe('crashed');
    expect(s.crash?.reason).toBe('Hit terrain');
    expect(s.position.z).toBeGreaterThan(-820);
  });

  it('dragging a wingtip is a crash: "Wingtip strike"', () => {
    const { state, controls } = trimmed({ altitudeM: 50, iasKt: 60, flapsNotch: 2 });
    const banked = { ...state, orientation: quatFromEuler(0, state.derived.pitchDeg, 40) };
    const s0 = placeAbove(banked, 0, 0.15, -0.5);
    const s = fly(s0, controls, 3, { until: (s) => s.phase === 'crashed' });
    expect(s.phase).toBe('crashed');
    expect(s.crash?.reason).toBe('Wingtip strike');
  });

  it('touching down with the gear up is a crash: "Gear-up landing"', () => {
    const { state, controls } = trimmed({ altitudeM: 50, iasKt: 65, flapsNotch: 3, gearDown: false });
    expect(state.gearPos).toBe(0);
    const s0 = placeAbove(state, 0, 0.2, -0.8);
    const s = fly(s0, controls, 3, { until: (s) => s.phase === 'crashed' });
    expect(s.phase).toBe('crashed');
    expect(s.crash?.reason).toBe('Gear-up landing');
  });

  it('the gear cannot be retracted on the ground (squat switch), so no belly landing on the runway', () => {
    const s = fly(createInitialState(), { ...defaultControls(), gearDown: false }, 8);
    expect(s.gearPos).toBe(1);
    expect(s.phase).toBe('ground');
  });

  it('landing on water is a crash: "Ditched in water"', () => {
    const env: Environment = { ...FLAT_ENV, groundHeight: () => -8, waterLevel: () => 0, surfaceAt: () => 'water' };
    const { state, controls } = trimmed({ altitudeM: 50, iasKt: 60, flapsNotch: 3 });
    const s0 = placeAbove(state, 0, 0.3, -1);
    expect(s0.derived.altitudeAGL).toBeGreaterThan(0);
    const s = fly(s0, controls, 3, { env, until: (s) => s.phase === 'crashed' });
    expect(s.phase).toBe('crashed');
    expect(s.crash?.reason).toBe('Ditched in water');
  });

  it('flying into an obstacle is a crash: "Hit an obstacle"', () => {
    const env: Environment = { ...FLAT_ENV, surfaceAt: () => 'forest', obstacleTop: (_x, z) => (z < -400 && z > -420 ? 60 : -Infinity) };
    const { state, controls } = trimmed({ altitudeM: 40, iasKt: 100 });
    const s = fly(state, controls, 20, { env, until: (s) => s.phase === 'crashed' });
    expect(s.phase).toBe('crashed');
    expect(s.crash?.reason).toBe('Hit an obstacle');
    expect(s.position.z).toBeLessThan(-390);
    // Flying over it is fine.
    const high = fly(trimmed({ altitudeM: 90, iasKt: 100 }).state, trimmed({ altitudeM: 90, iasKt: 100 }).controls, 10, { env });
    expect(high.phase).toBe('airborne');
    expect(high.position.z).toBeLessThan(-420);
  });

  it('pulling far past the load limit is a crash: "Structural failure"', () => {
    const { state, controls } = trimmed({ altitudeM: 2000, iasKt: 160, gearDown: false });
    let maxG = 0;
    const s = fly(state, { ...controls, elevator: 1 }, 5, {
      until: (s) => s.phase === 'crashed',
      each: (s) => { if (s.phase !== 'crashed') maxG = Math.max(maxG, s.derived.loadFactor); },
    });
    expect(s.phase).toBe('crashed');
    expect(s.crash?.reason).toMatch(/Structural failure/);
    expect(maxG).toBeGreaterThan(CONFIG.aircraft.limits.gLimitPos);
  });

  it('diving far past Vne is a crash: "Structural failure — overspeed"', () => {
    const { state, controls } = trimmed({ altitudeM: 4000, iasKt: 150, gearDown: false });
    const dive = { ...state, orientation: quatFromEuler(0, -80, 0), velocity: { x: 0, y: -60, z: -40 } };
    let maxKias = 0;
    const s = fly(dive, { ...controls, throttle: 1, elevator: 0 }, 60, {
      until: (x) => x.phase === 'crashed',
      each: (x) => { if (x.phase !== 'crashed') maxKias = Math.max(maxKias, x.derived.ias * 1.943844); },
    });
    expect(s.phase).toBe('crashed');
    expect(s.crash?.reason).toMatch(/overspeed/i);
    expect(maxKias).toBeGreaterThan(CONFIG.aircraft.limits.vneKt);
    expect(maxKias).toBeLessThan(CONFIG.aircraft.limits.vneKt * 1.4);
  });

  it('a normal steep turn (2 g) does not break the airframe', () => {
    const { state, controls } = trimmed({ altitudeM: 2000, iasKt: 100, gearDown: false });
    let maxG = 0;
    const s = fly(state, (s) => ({
      ...controls,
      throttle: 1,
      aileron: Math.max(-1, Math.min(1, 0.04 * (60 - s.derived.rollDeg) - 0.012 * s.derived.p * 57.3)),
      elevator: s.derived.rollDeg > 45 ? 0.35 : 0.1,
    }), 15, { each: (s) => { maxG = Math.max(maxG, s.derived.loadFactor); } });
    expect(s.phase).toBe('airborne');
    expect(maxG).toBeGreaterThan(1.7);
  });

  it('a tail scrape (even a firm 2.5 m/s one) skids on the tail tie-down; only a violent > 3 m/s impact is a "Tail strike"', () => {
    const base = createInitialState();
    const tailDown = (vs: number): AircraftState => {
      const q = quatFromEuler(0, 14, 0);
      const tail = G.structuralPoints.find((p) => p.name === 'tailcone')!;
      const y = 0.005 - bodyToWorld(q, tail).y; // tailcone 5 mm into the runway
      return { ...base, orientation: q, position: { ...base.position, y }, velocity: { x: 0, y: vs, z: -22 }, phase: 'ground' };
    };
    const gentle = fly(tailDown(-0.4), { ...defaultControls(), throttle: 0.3 }, 3, { until: (s) => s.phase === 'crashed' });
    expect(gentle.phase).not.toBe('crashed');
    const firm = fly(tailDown(-2.5), { ...defaultControls(), throttle: 0.3 }, 3, { until: (s) => s.phase === 'crashed' });
    expect(firm.phase).not.toBe('crashed');
    expect(firm.wheelContact.some(Boolean)).toBe(true); // it settles back onto the wheels
    const hard = fly(tailDown(-4.5), { ...defaultControls(), throttle: 0.3 }, 1, { until: (s) => s.phase === 'crashed' });
    expect(hard.phase).toBe('crashed');
    expect(hard.crash?.reason).toBe('Tail strike');
  });
});

describe('crash state', () => {
  it('is terminal: record filled, engine failed, velocities zeroed, later steps only advance time', () => {
    const { state, controls } = trimmed({ altitudeM: 80, iasKt: 110 });
    const c = fly(state, { ...controls, elevator: -1 }, 30, { until: (s) => s.phase === 'crashed' });
    expect(c.phase).toBe('crashed');
    expect(simStateLabel(c)).toBe('crashed');
    expect(c.crash).not.toBeNull();
    expect(c.crash!.reason.length).toBeGreaterThan(3);
    expect(c.crash!.time).toBeCloseTo(c.time, 6);
    expect(c.crash!.position).toEqual(c.position);
    expect(c.crash!.speedKt).toBeGreaterThan(50);
    expect(c.engine.failed).toBe(true);
    expect(c.engine.running).toBe(false);
    expect(c.engine.power).toBe(0);
    expect(c.engine.thrust).toBe(0);
    expect(c.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(c.angularVelocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(c.stalled).toBe(false);
    // Nothing moves any more, whatever the controls say.
    const later = fly(c, { ...defaultControls(), throttle: 1, elevator: 1, engineOn: true }, 5);
    expect(later.phase).toBe('crashed');
    expect(later.position).toEqual(c.position);
    expect(later.orientation).toEqual(c.orientation);
    expect(later.crash).toEqual(c.crash);
    expect(later.engine.running).toBe(false);
    expect(later.time).toBeCloseTo(c.time + 5, 6);
    expect(allFinite(later)).toBe(true);
    const one = step(c, defaultControls(), DT);
    expect(one.time).toBeCloseTo(c.time + DT, 9);
    expect(one.crash!.speedKt * 0 + c.crash!.speedKt).toBe(c.crash!.speedKt);
    expect(c.crash!.speedKt / MS_TO_KT).toBeGreaterThan(0);
  });
});
