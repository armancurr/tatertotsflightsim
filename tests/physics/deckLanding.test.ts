/**
 * FUNCTIONAL: landable decks (Environment.deckTop). The JetRanger sets down gently on the naval
 * pier's T-head and on a berthed battleship's fantail (a 270 m stand-in; its clear deck is a deck,
 * the hull an obstacle), stays put on its skids — while flying into the terminal building (an
 * obstacle, not a deck) is still a collision. Without decks nothing changes (the existing suites).
 */
import { describe, it, expect } from 'vitest';
import { createTrimmedState, defaultControls, step } from '../../src/physics';
import { createEnvironment } from '../../src/world/environment';
import { portWorks, pierWorld } from '../../src/world/harbour/layout';
import { createPortObstacles } from '../../src/world/harbour/obstacles';
import { berthedObstacles, berthedShipSpecs, shipToWorld, deckAt } from '../../src/world/harbour/berthedShips';
import { getAircraftDef } from '../../src/fleet';
import { clamp } from '../../src/math/vec3';
import { CRUISE_STANDIN, IOWA_STANDIN } from '../support/shipStandIn';
import type { AircraftState } from '../../src/types';

const B206 = getAircraftDef('b206').config;
const DT = 1 / 120;
const works = portWorks();
const fleet = [CRUISE_STANDIN(), IOWA_STANDIN()];
const specs = berthedShipSpecs(fleet);

function env() {
  const e = createEnvironment();
  const piers = createPortObstacles(works);
  e.registerObstacleSource((x, z) => piers.top(x, z));
  e.registerDeckSource((x, z) => piers.deckTop(x, z));
  const ships = berthedObstacles(specs, () => true);
  e.registerObstacleSource((x, z) => ships.top(x, z));
  e.registerDeckSource((x, z) => ships.deckTop(x, z));
  return e;
}

/** Hover 10 m above (x, z) (trimmed in the deck's ground effect), let down at 0.5 m/s (a touch under the hover collective: the ground effect grows as it sinks) and lower the collective once on the skids. */
function landAt(x: number, z: number, deckY: number, headingDeg = 0): { s: AircraftState; e: ReturnType<typeof env> } {
  const e = env();
  const t = createTrimmedState({ altitudeM: deckY + 10, iasKt: 0, headingDeg, x, z }, e, B206);
  let s = t.state;
  const trim = t.controls.throttle;
  for (let i = 0; i < 40 / DT; i++) {
    const c = s.onGround ? Math.max(0, s.rotor!.collective - DT * 0.25) : clamp(trim - 0.045 + 0.08 * (-0.5 - s.velocity.y), 0, 1);
    s = step(s, { ...defaultControls(), throttle: c }, DT, e, B206);
    if (s.phase === 'crashed') break;
  }
  return { s, e };
}

describe('landing on decks', () => {
  it('the JetRanger lands on the naval pier\'s T-head and stays put', () => {
    const n = works.naval;
    const p = pierWorld(n.frame, n.head.u0 + 12, -120);
    const { s } = landAt(p.x, p.z, n.deckY, 90);
    expect(s.crash, s.crash?.reason).toBeNull();
    expect(s.touchdown).not.toBeNull();
    expect(s.onGround).toBe(true);
    // resting on the deck, not sunk into it
    expect(s.position.y - n.deckY).toBeGreaterThan(0.5);
    expect(s.position.y - n.deckY).toBeLessThan(2.5);
    expect(Math.hypot(s.position.x - p.x, s.position.z - p.z)).toBeLessThan(3);
  }, 60_000);

  it('the JetRanger lands on the berthed battleship\'s fantail (its helipad) and stays put', () => {
    const bb = specs.find((x) => x.id === 'iowa')!;
    const bz = bb.size.sternZ - 18;
    const d = deckAt(bb, bz);
    const p = shipToWorld(bb, 0, d.y - bb.y, bz);
    const { s, e } = landAt(p.x, p.z, d.y, bb.pose.headingDeg);
    expect(e.deckTop(p.x, p.z)).toBeCloseTo(d.y, 2);
    expect(s.crash, s.crash?.reason).toBeNull();
    expect(s.touchdown).not.toBeNull();
    expect(s.position.y - d.y).toBeGreaterThan(0.5);
    expect(s.position.y - d.y).toBeLessThan(2.5);
    expect(Math.hypot(s.position.x - p.x, s.position.z - p.z)).toBeLessThan(3);
  }, 60_000);

  it('descending onto the cruise terminal\'s roof is still a collision (a building is not a deck)', () => {
    const c = works.cruise;
    const p = pierWorld(c.frame, (c.building.u0 + c.building.u1) / 2, (c.building.w0 + c.building.w1) / 2);
    const e = env();
    const t = createTrimmedState({ altitudeM: c.deckY + c.building.height + 6, iasKt: 0, headingDeg: 0, x: p.x, z: p.z }, e, B206);
    let s = t.state;
    for (let i = 0; i < 20 / DT && s.phase !== 'crashed'; i++) s = step(s, { ...defaultControls(), throttle: clamp(t.controls.throttle + 0.08 * (-1.5 - s.velocity.y), 0, 1) }, DT, e, B206);
    expect(s.crash?.reason).toBe('Hit an obstacle');
  }, 60_000);
});
