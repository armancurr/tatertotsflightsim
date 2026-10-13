import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { FLEET, getAircraftDef, DEFAULT_AIRCRAFT_ID } from '../../src/fleet';
import { createInitialState, step, defaultControls, FLAT_ENV } from '../../src/physics';

describe('fleet registry', () => {
  it('has the Cessna and the F-16 with unique ids', () => {
    const ids = FLEET.map((d) => d.id);
    expect(ids).toEqual(expect.arrayContaining(['c172rg', 'f16']));
    expect(new Set(ids).size).toBe(ids.length);
    expect(DEFAULT_AIRCRAFT_ID).toBe('c172rg');
  });
  it('falls back to the default aircraft for unknown ids', () => {
    expect(getAircraftDef('nope').id).toBe('c172rg');
    expect(getAircraftDef(null).id).toBe('c172rg');
    expect(getAircraftDef('f16').shortName).toBe('F-16');
  });
  it('the F-16 geometry matches the real jet', () => {
    const g = getAircraftDef('f16').config.aircraft.geometry;
    const span = Math.max(...g.structuralPoints.map((p) => Math.abs(p.x))) * 2;
    expect(span).toBeCloseTo(9.96, 1);
    expect(g.length).toBeCloseTo(15.06, 2);
    expect(g.verticalTailTop.y - g.noseWheel.y).toBeCloseTo(4.88, 2);
    expect(g.leftMainWheel.z - g.noseWheel.z).toBeCloseTo(4.0, 2);
    expect(g.rightMainWheel.x - g.leftMainWheel.x).toBeCloseTo(2.36, 2);
  });
  it('the 747-400 geometry matches the real jumbo (and fits the runway)', () => {
    const d = getAircraftDef('b747');
    expect(d.shortName).toBe('747');
    const g = d.config.aircraft.geometry;
    const span = Math.max(...g.structuralPoints.map((p) => Math.abs(p.x))) * 2;
    expect(span).toBeCloseTo(64.44, 1);
    expect(g.length).toBeCloseTo(70.66, 2);
    expect(g.verticalTailTop.y - g.noseWheel.y).toBeCloseTo(19.41, 2);
    expect(g.leftMainWheel.z - g.noseWheel.z).toBeCloseTo(25.6, 2);
    expect(g.rightMainWheel.x - g.leftMainWheel.x).toBeCloseTo(11, 1);
    // The wing-gear track fits the 30 m runway with room to spare.
    expect(g.rightMainWheel.x - g.leftMainWheel.x).toBeLessThan(30 - 8);
    // Four engines' worth of thrust and no weapons.
    expect(d.config.aircraft.engine.jet!.milThrustN).toBeGreaterThan(900000);
    expect(d.config.weapons.gun).toBeNull();
    expect(d.config.weapons.missiles).toBeNull();
  });

  it('every aircraft spawns resting on its gear on the runway and stays put at idle', () => {
    for (const d of FLEET.filter((f) => f.kind !== 'vessel')) {
      let s = createInitialState(FLAT_ENV, d.config);
      expect(s.phase).toBe('ground');
      for (let i = 0; i < 120 * 5; i++) s = step(s, { ...defaultControls(), parkingBrake: true }, 1 / 120, FLAT_ENV, d.config);
      expect(s.crash, d.id).toBeNull();
      expect(Math.abs(s.derived.verticalSpeed)).toBeLessThan(0.05);
      expect(s.onGround).toBe(true);
    }
  });
  it('fuzz: any id resolves to a fleet member', () => {
    fc.assert(fc.property(fc.string(), (id) => {
      expect(FLEET).toContain(getAircraftDef(id));
    }), { numRuns: 100 });
  });
});
