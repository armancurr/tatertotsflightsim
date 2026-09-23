/**
 * Unit: the scripted combat demos behind `window.sim.combatFx.demo()` (they drive the effects and
 * the sound through the combat world until the weapons/targets systems exist): a GAU-8 burst that
 * walks along the ground with armour hits on a (virtual) target, and a Maverick shot that kills a tank.
 */
import { describe, it, expect } from 'vitest';
import { gunRunScript, maverickScript } from '../../../src/combat/fx/demo';
import type { CombatEvent } from '../../../src/combat/types';

const env = { groundHeight: () => 10, surfaceAt: () => 'dirt' as const };
const shooter = { x: 0, y: 410, z: 1200 };
const target = { x: 0, y: 10, z: 0 };

const of = <T extends CombatEvent['type']>(evs: { event: CombatEvent }[], t: T) => evs.filter((e) => e.event.type === t).map((e) => e.event as Extract<CombatEvent, { type: T }>);

describe('gun run demo', () => {
  const s = gunRunScript({ ...env, shooter, target, rateRps: 65, burstS: 2 });
  it('fires a 2 s burst at 65 rds/s (spinning up over 0.55 s): gunStart, ~115 impacts arriving after the time of flight, gunStop', () => {
    expect(s.events[0].event.type).toBe('gunStart');
    const imp = s.events.filter((e) => e.event.type === 'impact');
    expect(imp.length).toBeGreaterThan(105);
    expect(imp.length).toBeLessThan(125);
    const range = Math.hypot(shooter.x - target.x, shooter.y - target.y, shooter.z - target.z);
    expect(imp[0].at).toBeGreaterThan(range / 1100);
    expect(of(s.events, 'gunStop')).toHaveLength(1);
    expect(s.firing).toEqual([0, 2]);
    for (let i = 1; i < s.events.length; i++) expect(s.events[i].at).toBeGreaterThanOrEqual(s.events[i - 1].at);
  });
  it('the impacts walk along the ground (a line tens of metres long) and some strike the target, a few glancing off', () => {
    const imp = of(s.events, 'impact');
    const zs = imp.map((e) => e.point.z);
    expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(30);
    for (const e of imp) expect(e.point.y).toBeGreaterThanOrEqual(10);
    const hits = imp.filter((e) => e.surface === 'target');
    expect(hits.length).toBeGreaterThan(5);
    expect(hits.some((e) => e.ricochet)).toBe(true);
    expect(imp.filter((e) => e.surface === 'dirt').length).toBeGreaterThan(60);
  });
});

describe('Maverick demo', () => {
  const s = maverickScript({ ...env, shooter, velocity: { x: 0, y: 0, z: -120 }, target, kind: 'tank' });
  it('launch, then detonation at the target after the flight time, then the tank is destroyed', () => {
    const [launch] = of(s.events, 'missileLaunch');
    const [det] = of(s.events, 'detonation');
    const [kill] = of(s.events, 'destroyed');
    expect(launch).toBeDefined();
    expect(det.weapon).toBe('missile');
    expect(Math.hypot(det.position.x - target.x, det.position.z - target.z)).toBeLessThan(1);
    expect(kill.kind).toBe('tank');
    const tDet = s.events.find((e) => e.event.type === 'detonation')!.at;
    expect(tDet).toBeGreaterThan(2);
    expect(tDet).toBeLessThan(10);
    expect(s.events.find((e) => e.event.type === 'destroyed')!.at).toBeGreaterThanOrEqual(tDet);
    expect(s.firing).toBeNull();
  });
});
