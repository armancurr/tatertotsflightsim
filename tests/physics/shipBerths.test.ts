/**
 * FUNCTIONAL: big ships at their berths in the real world (heightfield, marina, piers, buoys and the
 * other berthed ship registered as obstacles, as the systems do). A 270 m, 11 m-draft stand-in for
 * the battleship spawned at the naval pier floats at its waterline, lies to its lines without touching
 * the pier or the bottom, then backs off the T-head and drives out west; a 260 m stand-in for the
 * cruise ship does the same at the cruise terminal and drives out to sea. (The real ships are built
 * elsewhere; these hulls are the same size — tests/support/shipStandIn.ts.)
 */
import { describe, it, expect } from 'vitest';
import { createVesselState, step, defaultControls } from '../../src/physics';
import { createEnvironment } from '../../src/world/environment';
import { vesselBerth, portMarina } from '../../src/world/port';
import { createHarbourObstacles } from '../../src/world/traffic/harbourObstacles';
import { portWorks, pierLocal } from '../../src/world/harbour/layout';
import { createPortObstacles } from '../../src/world/harbour/obstacles';
import { navaids, navaidObstacles } from '../../src/world/harbour/navaids';
import { berthedObstacles, berthedShipSpecs } from '../../src/world/harbour/berthedShips';
import { CRUISE_STANDIN, IOWA_STANDIN, type StandIn } from '../support/shipStandIn';
import type { AircraftState } from '../../src/types';

const DT = 1 / 120;
const works = portWorks();

function worldEnv(fleet: StandIn[], playerId: string) {
  const env = createEnvironment();
  const harbour = createHarbourObstacles(portMarina());
  env.registerObstacleSource((x, z) => harbour.top(x, z));
  const piers = createPortObstacles(works);
  const aids = navaidObstacles(navaids());
  env.registerObstacleSource((x, z) => Math.max(piers.top(x, z), aids.top(x, z)));
  env.registerDeckSource((x, z) => piers.deckTop(x, z));
  // the other big ship lies berthed; the player's own is not (it is the player's vessel)
  const berthed = berthedObstacles(berthedShipSpecs(fleet), (id) => id !== playerId);
  env.registerObstacleSource((x, z) => berthed.top(x, z));
  env.registerDeckSource((x, z) => berthed.deckTop(x, z));
  return env;
}

function run(s: AircraftState, cfg: StandIn['config'], env: ReturnType<typeof worldEnv>, seconds: number, throttle: number, rudder = 0, watch?: (s: AircraftState) => void): AircraftState {
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    s = step(s, { ...defaultControls(), throttle, rudder }, DT, env, cfg);
    watch?.(s);
  }
  return s;
}

describe('big ships at their berths', () => {
  const fleet = [CRUISE_STANDIN(), IOWA_STANDIN()];

  it('the battleship stand-in floats at the naval pier, lies to its lines, backs off and drives out west', () => {
    const ship = fleet[1];
    const env = worldEnv(fleet, ship.id);
    const b = vesselBerth(ship);
    expect(b.berth).toBe('naval');
    let s = createVesselState(env, ship.config, { x: b.x, z: b.z, headingDeg: b.headingDeg, moored: true }).state;
    let touched = false;
    s = run(s, ship.config, env, 30, 0, 0, (x) => (touched ||= x.vessel!.touching || x.vessel!.aground));
    expect(s.phase).toBe('afloat');
    expect(touched, 'touched the pier or the bottom while moored').toBe(false);
    expect(Math.hypot(s.position.x - b.x, s.position.z - b.z)).toBeLessThan(1.5);
    expect(s.vessel!.depthUnderKeel).toBeGreaterThan(1.5);
    // afloat at its waterline (the CG within a metre of the static float height)
    expect(Math.abs(s.position.y - createVesselState(env, ship.config, { x: b.x, z: b.z, headingDeg: b.headingDeg }).state.position.y)).toBeLessThan(1);
    // back off: slow astern for 60 s, the wheel a little to port (swing the stern off the T-head)
    s = run(s, ship.config, env, 60, -0.35, 0, (x) => (touched ||= x.vessel!.aground));
    expect(s.phase, s.crash?.reason).toBe('afloat');
    expect(s.vessel!.mooring).toBeNull();
    const back = pierLocal(works.naval.frame, s.position.x, s.position.z);
    // (astern = east along the face; it has moved and not into the pier)
    expect(Math.hypot(s.position.x - b.x, s.position.z - b.z)).toBeGreaterThan(20);
    expect(back.u).toBeGreaterThan(works.naval.head.u1 + 10);
    // ahead: drive out west for 180 s, past the berth and on along the coast
    const x0 = s.position.x;
    s = run(s, ship.config, env, 180, 0.6, 0, (x) => (touched ||= x.vessel!.aground));
    expect(s.phase, s.crash?.reason).toBe('afloat');
    expect(touched, 'ran aground').toBe(false);
    expect(x0 - s.position.x).toBeGreaterThan(150);
    expect(s.position.x).toBeLessThan(b.x - 50);
  }, 120_000);

  it('the cruise ship stand-in floats at the cruise terminal, lies to its lines and drives straight out to sea', () => {
    const ship = fleet[0];
    const env = worldEnv(fleet, ship.id);
    const b = vesselBerth(ship);
    expect(b.berth).toBe('cruise');
    let s = createVesselState(env, ship.config, { x: b.x, z: b.z, headingDeg: b.headingDeg, moored: true }).state;
    let touched = false;
    s = run(s, ship.config, env, 30, 0, 0, (x) => (touched ||= x.vessel!.touching || x.vessel!.aground));
    expect(s.phase).toBe('afloat');
    expect(touched).toBe(false);
    expect(Math.hypot(s.position.x - b.x, s.position.z - b.z)).toBeLessThan(1.5);
    s = run(s, ship.config, env, 150, 0.5, 0, (x) => (touched ||= x.vessel!.aground || x.vessel!.touching));
    expect(s.phase, s.crash?.reason).toBe('afloat');
    expect(touched, 'touched the pier or the bottom leaving').toBe(false);
    // out to sea: south of the pier head
    expect(pierLocal(works.cruise.frame, s.position.x, s.position.z).u).toBeGreaterThan(works.cruise.pier.u1 + 50);
  }, 120_000);

  it('a yacht can\'t sail through a berthed ship: the hull is solid from the waterline to the deck', () => {
    const env = worldEnv(fleet, 'v50');
    const [cruise, iowa] = berthedShipSpecs(fleet);
    for (const sp of [cruise, iowa]) {
      expect(env.obstacleTop(sp.pose.x, sp.pose.z)).toBeGreaterThan(sp.y + sp.size.freeboardM - 1.5);
      // a landable deck there
      expect(env.deckTop(sp.pose.x, sp.pose.z)).toBeGreaterThan(sp.y);
    }
  });
});
