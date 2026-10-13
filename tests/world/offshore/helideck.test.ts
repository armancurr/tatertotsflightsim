/**
 * Functional (pure physics): the Bell 206 JetRanger lands on Tater Alpha's helideck and sits on it.
 * The real world environment (heightfield, sea) with the platform registered exactly as the offshore
 * system does it: its structure as an obstacle source, the helideck as a landable deck. A hover over
 * the deck, a gentle descent, touchdown on the skids (rated, on 'asphalt'), parked without sliding,
 * then a lift-off and a departure over the edge. Touching down on the topside beside the deck is a
 * crash (it is an obstacle, not a deck).
 */
import { describe, it, expect } from 'vitest';
import { createTrimmedState, defaultControls, step } from '../../../src/physics';
import type { AircraftState, Controls } from '../../../src/types';
import { createEnvironment } from '../../../src/world/environment';
import { createPlatformPhysics, PLATFORM, platformFrame } from '../../../src/world/offshore/platform';
import { localToWorld } from '../../../src/world/offshore/sites';
import { B206_CFG, DT, RC, holdClimb, holdHeight } from '../../physics/b206-helpers';

const phys = createPlatformPhysics();
const env = createEnvironment();
env.registerObstacleSource((x, z) => phys.obstacleTop(x, z));
env.registerDeckSource((x, z) => phys.helideckTop(x, z));
const deck = PLATFORM.helideck.y;
const c = phys.helideck;

const fly = (s0: AircraftState, pilot: (s: AircraftState) => Controls, seconds: number, each?: (s: AircraftState) => void) => {
  let s = s0;
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    s = step(s, pilot(s), DT, env, B206_CFG);
    each?.(s);
    if (s.crash) break;
  }
  return s;
};

/** Hover `h` m over (x, z), trimmed (in ground effect over the deck: AGL is measured from it). */
const hoverOver = (x: number, z: number, h: number, headingDeg = 215) => createTrimmedState({ altitudeM: Math.max(env.groundHeight(x, z), env.deckTop(x, z), 0) + h, iasKt: 0, headingDeg, x, z }, env, B206_CFG);

/** Skids' lowest point below the CG (unloaded), m. */
const skidDrop = -Math.min(...RC.skids.points.map((p) => p.y));

describe('JetRanger on the helideck', () => {
  it('the deck is the ground under the helicopter: AGL is measured from it', () => {
    const { state } = hoverOver(c.x, c.z, 8);
    expect(env.deckTop(c.x, c.z)).toBe(deck);
    expect(state.derived.altitudeAGL).toBeGreaterThan(5);
    expect(state.derived.altitudeAGL).toBeLessThan(9);
    expect(state.crash).toBeNull();
  });

  it('hovers, descends gently, touches down rated on the deck, stays put, then lifts off and departs over the edge', () => {
    const { state, controls } = hoverOver(c.x, c.z, 6);
    const trim = controls.throttle;
    const hold = (s: AircraftState): Controls => ({ ...defaultControls(), ...controls, throttle: holdHeight(s, 6, trim) });
    let s = fly(state, hold, 5);
    expect(s.crash).toBeNull();
    expect(s.phase).toBe('airborne');
    expect(Math.hypot(s.position.x - c.x, s.position.z - c.z)).toBeLessThan(3);
    // settle: -0.5 m/s until the skids touch, then ease the collective down
    s = fly(s, (x) => ({ ...defaultControls(), ...controls, throttle: x.onGround ? Math.max(0, x.rotor!.collective - DT * 0.25) : holdClimb(x, -0.5, trim - 0.045) }), 25);
    expect(s.crash).toBeNull();
    expect(s.touchdown).not.toBeNull();
    expect(s.touchdown!.surface).toBe('asphalt');
    expect(['butter', 'smooth']).toContain(s.touchdown!.rating);
    expect(s.onGround).toBe(true);
    // sitting on its skids on the deck (not the sea 51 m below)
    expect(s.position.y - deck).toBeGreaterThan(skidDrop - 0.3);
    expect(s.position.y - deck).toBeLessThan(skidDrop + 0.2);
    expect(Math.hypot(s.position.x - c.x, s.position.z - c.z)).toBeLessThan(4);
    // parked: 10 s with the collective down, it doesn't slide
    const p = { ...s.position };
    s = fly(s, () => ({ ...defaultControls(), ...controls, throttle: 0 }), 10);
    expect(s.crash).toBeNull();
    expect(Math.hypot(s.position.x - p.x, s.position.z - p.z)).toBeLessThan(0.05);
    expect(Math.abs(s.position.y - p.y)).toBeLessThan(0.05);
    // lift off to a 10 m hover, then fly forward off the deck (heading 215): AGL jumps to the sea
    s = fly(s, (x) => ({ ...defaultControls(), ...controls, throttle: holdClimb(x, 1.5, trim) }), 8);
    expect(s.crash).toBeNull();
    expect(s.onGround).toBe(false);
    let maxAgl = 0;
    s = fly(s, (x) => ({ ...defaultControls(), ...controls, elevator: -0.2, throttle: holdClimb(x, 1, trim + 0.02) }), 12, (x) => (maxAgl = Math.max(maxAgl, x.derived.altitudeAGL)));
    expect(s.crash).toBeNull();
    expect(Math.hypot(s.position.x - c.x, s.position.z - c.z)).toBeGreaterThan(40);
    expect(maxAgl).toBeGreaterThan(50);
  });

  it('touching down on the topside beside the deck is a crash (an obstacle, not a deck)', () => {
    const F = platformFrame();
    const w = localToWorld(F, 12, 12, { x: 0, z: 0 });
    expect(phys.helideckTop(w.x, w.z)).toBe(-Infinity);
    const top = phys.obstacleTop(w.x, w.z);
    expect(top).toBeGreaterThan(PLATFORM.weatherY);
    const { state, controls } = createTrimmedState({ altitudeM: top + 8, iasKt: 0, headingDeg: 215, x: w.x, z: w.z }, env, B206_CFG);
    const s = fly(state, (x) => ({ ...defaultControls(), ...controls, throttle: holdClimb(x, -0.8, controls.throttle) }), 20);
    expect(s.crash?.reason).toBe('Hit an obstacle');
  });
});
