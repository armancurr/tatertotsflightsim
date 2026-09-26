/**
 * The fleet's vessels in the real world: every entry with `kind: 'vessel'` has a `watercraft`
 * config (and every `watercraft` config is a vessel), the marine HUD and voice; it starts moored at
 * the reserved visitors' berth in Port Chateau — afloat, clear of the pontoon and the moored boats
 * (the marina registered as obstacles, as the ships system does) — lies there to its lines, casts
 * off and idles out; and it starts underway at the open-sea start in deep water.
 */
import { describe, it, expect } from 'vitest';
import { FLEET } from '../../src/fleet';
import { createVesselState, step, defaultControls } from '../../src/physics';
import { createEnvironment } from '../../src/world/environment';
import { playerBerth, portMarina, seaStart } from '../../src/world/port';
import { createHarbourObstacles } from '../../src/world/traffic/harbourObstacles';

const VESSELS = FLEET.filter((d) => d.kind === 'vessel');
const env = createEnvironment();
const harbour = createHarbourObstacles(portMarina());
env.registerObstacleSource((x, z) => harbour.top(x, z));

describe('the fleet: vessels', () => {
  it('has at least one vessel, and kind and config agree', () => {
    expect(VESSELS.length).toBeGreaterThan(0);
    for (const d of FLEET) expect(d.kind === 'vessel', d.id).toBe(d.config.aircraft.watercraft != null);
    for (const d of VESSELS) {
      expect(d.hud).toBe('marine');
      expect(d.sound).toBe('marineDiesel');
    }
  });

  it('every vessel lies moored at its berth, clear of the pontoon, then casts off and idles out', () => {
    const b = playerBerth();
    for (const d of VESSELS) {
      let s = createVesselState(env, d.config, { x: b.x, z: b.z, headingDeg: b.headingDeg, moored: true }).state;
      let touched = false;
      for (let i = 0; i < 120 * 20; i++) {
        s = step(s, { ...defaultControls(), throttle: 0 }, 1 / 120, env, d.config);
        touched ||= s.vessel!.aground;
      }
      expect(s.phase, d.id).toBe('afloat');
      expect(touched, `${d.id} touched the pontoon or the bottom at its berth`).toBe(false);
      expect(Math.hypot(s.position.x - b.x, s.position.z - b.z)).toBeLessThan(1.5);
      expect(s.vessel!.depthUnderKeel).toBeGreaterThan(1.5);
      // lever to slow ahead: cast off and idle out along the berth's heading for 60 s
      for (let i = 0; i < 120 * 60; i++) s = step(s, { ...defaultControls(), throttle: 0.15 }, 1 / 120, env, d.config);
      expect(s.phase, `${d.id}: ${s.crash?.reason}`).toBe('afloat');
      expect(s.vessel!.mooring).toBeNull();
      expect(Math.hypot(s.position.x - b.x, s.position.z - b.z)).toBeGreaterThan(100);
    }
  });

  it('every vessel starts underway at the open-sea start, in deep water', () => {
    const p = seaStart();
    for (const d of VESSELS) {
      const v = createVesselState(env, d.config, { x: p.x, z: p.z, headingDeg: p.headingDeg, speedKt: 22 });
      let s = v.state;
      for (let i = 0; i < 120 * 20; i++) s = step(s, { ...defaultControls(), ...v.controls }, 1 / 120, env, d.config);
      expect(s.phase, d.id).toBe('afloat');
      expect(s.vessel!.speedMs * 1.943844).toBeGreaterThan(15);
      expect(s.vessel!.depthUnderKeel).toBeGreaterThan(5);
    }
  });
});
