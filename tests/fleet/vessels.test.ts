/**
 * The fleet's vessels in the real world: every entry with `kind: 'vessel'` has a `watercraft`
 * config (and every `watercraft` config is a vessel), the marine HUD and voice; it starts moored at
 * its berth in Port Chateau (the visitors' pontoon for a yacht, the cruise terminal or the naval pier
 * for a ship — src/world/port.ts vesselBerth) — afloat, clear of the pontoon / pier and the moored
 * boats (the marina and the port registered as obstacles, as the systems do) — lies there to its lines, casts
 * off and idles out; and it starts underway at the open-sea start in deep water.
 */
import { describe, it, expect } from 'vitest';
import { FLEET } from '../../src/fleet';
import { createVesselState, step, defaultControls } from '../../src/physics';
import { createEnvironment } from '../../src/world/environment';
import { vesselBerth, vesselSize, portMarina, seaStart } from '../../src/world/port';
import { createHarbourObstacles } from '../../src/world/traffic/harbourObstacles';
import { portWorks } from '../../src/world/harbour/layout';
import { createPortObstacles } from '../../src/world/harbour/obstacles';
import { navaids, navaidObstacles } from '../../src/world/harbour/navaids';

const VESSELS = FLEET.filter((d) => d.kind === 'vessel');
const env = createEnvironment();
const harbour = createHarbourObstacles(portMarina());
env.registerObstacleSource((x, z) => harbour.top(x, z));
// the big-ship port and the buoys, as the port system registers them
const piers = createPortObstacles(portWorks());
const aids = navaidObstacles(navaids());
env.registerObstacleSource((x, z) => Math.max(piers.top(x, z), aids.top(x, z)));

describe('the fleet: vessels', () => {
  it('has at least one vessel, and kind and config agree', () => {
    expect(VESSELS.length).toBeGreaterThan(0);
    for (const d of FLEET) expect(d.kind === 'vessel', d.id).toBe(d.config.aircraft.watercraft != null);
    for (const d of VESSELS) {
      expect(d.hud).toBe('marine');
      expect(['marineDiesel', 'pwc']).toContain(d.sound);
    }
  });

  it('every vessel lies moored at its berth, clear of the pontoon, then casts off and idles out', () => {
    for (const d of VESSELS) {
      // each at its own berth by size: the visitors' pontoon, the cruise terminal or the naval pier
      const b = vesselBerth(d);
      let s = createVesselState(env, d.config, { x: b.x, z: b.z, headingDeg: b.headingDeg, moored: true }).state;
      let touched = false;
      for (let i = 0; i < 120 * 20; i++) {
        s = step(s, { ...defaultControls(), throttle: 0 }, 1 / 120, env, d.config);
        touched ||= s.vessel!.aground || s.vessel!.touching;
      }
      expect(s.phase, d.id).toBe('afloat');
      expect(touched, `${d.id} touched the pontoon or the bottom at its berth`).toBe(false);
      expect(Math.hypot(s.position.x - b.x, s.position.z - b.z)).toBeLessThan(1.5);
      expect(s.vessel!.depthUnderKeel).toBeGreaterThan(1.5);
      // lever to slow ahead: cast off and idle out along the berth's heading for 60 s (a big ship —
      // tens of thousands of tonnes — gets half ahead and three minutes to gather way)
      const big = (vesselSize(d.config)?.lengthM ?? 0) > 60;
      const lever = big ? 0.5 : 0.15;
      for (let i = 0; i < 120 * (big ? 180 : 60); i++) {
        s = step(s, { ...defaultControls(), throttle: lever }, 1 / 120, env, d.config);
        touched ||= s.vessel!.aground;
      }
      expect(touched, `${d.id} ran aground leaving its berth`).toBe(false);
      expect(s.phase, `${d.id}: ${s.crash?.reason}`).toBe('afloat');
      expect(s.vessel!.mooring).toBeNull();
      expect(Math.hypot(s.position.x - b.x, s.position.z - b.z)).toBeGreaterThan(100);
    }
  });

  it('every vessel starts underway at the open-sea start, in deep water, in gear and holding 22 kt', () => {
    const p = seaStart();
    for (const d of VESSELS) {
      const v = createVesselState(env, d.config, { x: p.x, z: p.z, headingDeg: p.headingDeg, speedKt: 22 });
      let s = v.state;
      for (let i = 0; i < 120 * 20; i++) s = step(s, { ...defaultControls(), ...v.controls }, 1 / 120, env, d.config);
      expect(s.phase, d.id).toBe('afloat');
      // the start comes with the lever that holds the speed (a 58,000 t battleship as well as a jet ski)
      expect(v.controls.throttle!, d.id).toBeGreaterThan(d.config.aircraft.watercraft!.neutralDetent);
      expect(Math.abs(s.vessel!.speedMs * 1.943844 - 22), d.id).toBeLessThan(2);
      expect(s.vessel!.depthUnderKeel).toBeGreaterThan(5);
    }
  });
});
