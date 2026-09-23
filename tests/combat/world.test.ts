import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { createCombatWorld, combatWorld } from '../../src/combat/world';
import { CONFIG } from '../../src/config';
import type { CombatEvent } from '../../src/combat/types';

const tank = CONFIG.combat.targets.tank;

/** A world with one T-72 at the origin facing north (its front faces −Z). */
function oneTank(headingDeg = 0) {
  const w = createCombatWorld();
  const t = w.addTarget({ kind: 'tank', position: { x: 0, y: 0, z: 0 }, headingDeg, group: 'test' });
  return { w, t };
}

describe('combat world: targets', () => {
  it('adds targets with unique ids and the class health', () => {
    const w = createCombatWorld();
    const a = w.addTarget({ kind: 'tank', position: { x: 0, y: 0, z: 0 }, headingDeg: 0, group: 'g' });
    const b = w.addTarget({ kind: 'truck', position: { x: 50, y: 0, z: 0 }, headingDeg: 90, group: 'g' });
    expect(a.id).not.toBe(b.id);
    expect(a.health).toBe(tank.health);
    expect(b.maxHealth).toBe(CONFIG.combat.targets.truck.health);
    expect(a.alive && b.alive).toBe(true);
    expect(w.targets).toHaveLength(2);
    expect(w.find(b.id)).toBe(b);
    w.removeAll();
    expect(w.targets).toHaveLength(0);
  });

  it('the scene hub returns one world per scene', () => {
    const s1 = {};
    const s2 = {};
    expect(combatWorld(s1)).toBe(combatWorld(s1));
    expect(combatWorld(s1)).not.toBe(combatWorld(s2));
  });
});

describe('combat world: raycast against the hull boxes', () => {
  it('hits the front armour of a tank that faces the shooter', () => {
    const { w, t } = oneTank(0);
    // Shooter 100 m north of the tank (at −Z), aiming south at mid-hull height.
    const hit = w.raycast({ x: 0, y: 1, z: -100 }, { x: 0, y: 1, z: 100 });
    expect(hit?.target).toBe(t);
    expect(hit?.face).toBe('front');
    expect(hit!.point.z).toBeCloseTo(-tank.length / 2, 6);
    expect(hit!.distance).toBeCloseTo(100 - tank.length / 2, 6);
  });

  it('a tank turned 90° shows its side; from behind its rear; from above its top', () => {
    expect(oneTank(90).w.raycast({ x: 0, y: 1, z: -100 }, { x: 0, y: 1, z: 100 })?.face).toBe('side');
    expect(oneTank(180).w.raycast({ x: 0, y: 1, z: -100 }, { x: 0, y: 1, z: 100 })?.face).toBe('rear');
    const top = oneTank(0).w.raycast({ x: 0.3, y: 500, z: 0.2 }, { x: 0.3, y: -10, z: 0.2 });
    expect(top?.face).toBe('top');
    expect(top!.point.y).toBeCloseTo(tank.height, 6);
  });

  it('misses beside the hull, short of it, and returns the nearest of two targets', () => {
    const { w } = oneTank(0);
    expect(w.raycast({ x: 5, y: 1, z: -100 }, { x: 5, y: 1, z: 100 })).toBeNull();
    expect(w.raycast({ x: 0, y: 1, z: -100 }, { x: 0, y: 1, z: -50 })).toBeNull();
    const far = w.addTarget({ kind: 'truck', position: { x: 0, y: 0, z: 40 }, headingDeg: 0, group: 'g' });
    const hit = w.raycast({ x: 0, y: 1, z: 200 }, { x: 0, y: 1, z: -200 });
    expect(hit?.target).toBe(far);
  });

  it('dead hulks still stop rounds (they are still there)', () => {
    const { w, t } = oneTank(0);
    w.applyHit(t.id, { weapon: 'missile', damage: 1000, point: t.position, direction: { x: 0, y: -1, z: 0 }, time: 1 });
    expect(t.alive).toBe(false);
    expect(w.raycast({ x: 0, y: 1, z: -100 }, { x: 0, y: 1, z: 100 })?.target).toBe(t);
  });

  it('fuzz: any reported hit lies on the hull surface and inside the segment', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 360, noNaN: true }),
        fc.record({ x: fc.double({ min: -60, max: 60, noNaN: true }), y: fc.double({ min: 0.5, max: 400, noNaN: true }), z: fc.double({ min: -60, max: 60, noNaN: true }) }),
        fc.record({ x: fc.double({ min: -3, max: 3, noNaN: true }), y: fc.double({ min: -1, max: 3, noNaN: true }), z: fc.double({ min: -4, max: 4, noNaN: true }) }),
        (hdg, from, aim) => {
          const { w, t } = oneTank(hdg);
          const to = { x: from.x + (aim.x - from.x) * 3, y: from.y + (aim.y - from.y) * 3, z: from.z + (aim.z - from.z) * 3 };
          const hit = w.raycast(from, to);
          if (!hit || hit.distance === 0) return; // (a segment that starts inside the hull reports its start)
          const len = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
          expect(hit.distance).toBeGreaterThanOrEqual(-1e-9);
          expect(hit.distance).toBeLessThanOrEqual(len + 1e-6);
          // Back into the hull frame: the point is on the box (within 1 mm of a face).
          const r = (hdg * Math.PI) / 180;
          const dx = hit.point.x - t.position.x;
          const dz = hit.point.z - t.position.z;
          const lx = dx * Math.cos(r) + dz * Math.sin(r);
          const lz = -(dx * Math.sin(r) - dz * Math.cos(r));
          const ly = hit.point.y - t.position.y;
          const inside = Math.abs(lx) <= tank.width / 2 + 1e-3 && Math.abs(lz) <= tank.length / 2 + 1e-3 && ly >= -1e-3 && ly <= tank.height + 1e-3;
          const onFace = Math.min(Math.abs(Math.abs(lx) - tank.width / 2), Math.abs(Math.abs(lz) - tank.length / 2), Math.abs(ly), Math.abs(ly - tank.height)) < 1e-3;
          expect(inside && onFace).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('combat world: damage', () => {
  const gunHit = (face: 'front' | 'top', time = 1) => ({
    weapon: 'gun' as const,
    damage: 10,
    point: { x: 0, y: 1, z: 0 },
    direction: face === 'top' ? { x: 0, y: -1, z: 0 } : { x: 0, y: 0, z: 1 },
    time,
    face,
  });

  it('armour by aspect: a 30 mm round barely scratches the front, bites the top', () => {
    const { w, t } = oneTank(0);
    const front = w.applyHit(t.id, gunHit('front'));
    expect(front.damage).toBeCloseTo(10 * tank.armor.front, 9);
    const top = w.applyHit(t.id, gunHit('top'));
    expect(top.damage).toBeCloseTo(10 * tank.armor.top, 9);
    expect(t.health).toBeCloseTo(tank.health - 10 * (tank.armor.front + tank.armor.top), 9);
  });

  it('missiles ignore armour; destruction fires exactly one event and counts one kill', () => {
    const { w, t } = oneTank(0);
    const events: CombatEvent[] = [];
    w.on((e) => events.push(e));
    const r = w.applyHit(t.id, { weapon: 'missile', damage: 400, point: t.position, direction: { x: 0, y: -1, z: 0 }, time: 3, face: 'front' });
    expect(r.destroyed).toBe(true);
    w.applyHit(t.id, { weapon: 'gun', damage: 10, point: t.position, direction: { x: 0, y: -1, z: 0 }, time: 4, face: 'top' });
    expect(events.filter((e) => e.type === 'destroyed')).toHaveLength(1);
    expect(events.find((e) => e.type === 'destroyed')).toMatchObject({ targetId: t.id, kind: 'tank', weapon: 'missile', time: 3 });
    expect(t.health).toBe(0);
    expect(t.destroyedAt).toBe(3);
    expect(w.stats.kills).toBe(1);
  });

  it('blast damage falls off with distance from the hull and stops at the radius', () => {
    const w = createCombatWorld();
    const near = w.addTarget({ kind: 'truck', position: { x: 0, y: 0, z: 0 }, headingDeg: 0, group: 'g' });
    const mid = w.addTarget({ kind: 'truck', position: { x: 12, y: 0, z: 0 }, headingDeg: 0, group: 'g' });
    const out = w.addTarget({ kind: 'truck', position: { x: 60, y: 0, z: 0 }, headingDeg: 0, group: 'g' });
    w.applyBlast({ x: 0, y: 0.5, z: 0 }, 18, 100, 'missile', 5);
    expect(near.alive).toBe(false);
    expect(mid.health).toBeLessThan(mid.maxHealth);
    expect(mid.health).toBeGreaterThan(0);
    expect(out.health).toBe(out.maxHealth);
  });

  it('revive restores every target; stats reset separately', () => {
    const { w, t } = oneTank(0);
    w.applyHit(t.id, { weapon: 'missile', damage: 400, point: t.position, direction: { x: 0, y: -1, z: 0 }, time: 1, face: 'top' });
    w.reviveAll();
    expect(t.alive).toBe(true);
    expect(t.health).toBe(t.maxHealth);
    expect(t.destroyedAt).toBeNull();
    expect(w.stats.kills).toBe(1);
    w.resetStats();
    expect(w.stats).toEqual({ roundsFired: 0, roundsHit: 0, missilesFired: 0, kills: 0 });
  });

  it('fuzz: health stays in [0, max], never rises, and each target dies at most once', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            idx: fc.integer({ min: 0, max: 2 }),
            weapon: fc.constantFrom('gun' as const, 'missile' as const),
            damage: fc.double({ min: -50, max: 500, noNaN: false }),
            face: fc.constantFrom('front' as const, 'side' as const, 'rear' as const, 'top' as const, 'bottom' as const),
            blast: fc.boolean(),
          }),
          { maxLength: 60 },
        ),
        (ops) => {
          const w = createCombatWorld();
          const ts = [0, 1, 2].map((i) => w.addTarget({ kind: i === 0 ? 'tank' : i === 1 ? 'apc' : 'truck', position: { x: i * 30, y: 0, z: 0 }, headingDeg: i * 45, group: 'g' }));
          let deaths = 0;
          w.on((e) => {
            if (e.type === 'destroyed') deaths++;
          });
          let time = 0;
          for (const op of ops) {
            const before = ts.map((t) => t.health);
            time += 0.1;
            if (op.blast) w.applyBlast(ts[op.idx].position, 20, op.damage, op.weapon, time);
            else w.applyHit(ts[op.idx].id, { weapon: op.weapon, damage: op.damage, point: ts[op.idx].position, direction: { x: 0, y: -1, z: 0 }, time, face: op.face });
            ts.forEach((t, i) => {
              expect(Number.isFinite(t.health)).toBe(true);
              expect(t.health).toBeGreaterThanOrEqual(0);
              expect(t.health).toBeLessThanOrEqual(t.maxHealth);
              expect(t.health).toBeLessThanOrEqual(before[i]);
              expect(t.alive).toBe(t.health > 0);
            });
          }
          expect(deaths).toBe(ts.filter((t) => !t.alive).length);
          expect(w.stats.kills).toBe(deaths);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('combat world: seeker search and events', () => {
  it('finds live targets inside a cone, nearest to the boresight first, within range', () => {
    const w = createCombatWorld();
    const onAxis = w.addTarget({ kind: 'tank', position: { x: 0, y: 0, z: -3000 }, headingDeg: 0, group: 'g' });
    const offAxis = w.addTarget({ kind: 'tank', position: { x: 150, y: 0, z: -3000 }, headingDeg: 0, group: 'g' });
    w.addTarget({ kind: 'tank', position: { x: 0, y: 0, z: -20000 }, headingDeg: 0, group: 'g' });
    w.addTarget({ kind: 'tank', position: { x: 3000, y: 0, z: -3000 }, headingDeg: 0, group: 'g' });
    const dead = w.addTarget({ kind: 'tank', position: { x: 10, y: 0, z: -3000 }, headingDeg: 0, group: 'g' });
    w.applyHit(dead.id, { weapon: 'missile', damage: 999, point: dead.position, direction: { x: 0, y: -1, z: 0 }, time: 0, face: 'top' });
    const found = w.targetsInCone({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, 8, 9000);
    expect(found.map((f) => f.target)).toEqual([onAxis, offAxis]);
    expect(found[0].range).toBeCloseTo(3000, 0);
    expect(found[0].angleDeg).toBeLessThan(found[1].angleDeg);
  });

  it('unsubscribes, and a throwing listener does not stop the others', () => {
    const w = createCombatWorld();
    const a = vi.fn(() => {
      throw new Error('boom');
    });
    const b = vi.fn();
    const off = w.on(a);
    w.on(b);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    w.emit({ type: 'gunStart', time: 0 });
    off();
    w.emit({ type: 'gunStop', time: 1, roundsFired: 10 });
    spy.mockRestore();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('starts with an empty weapons status (no gun, no missiles, no lock)', () => {
    const w = createCombatWorld();
    expect(w.status.hasGun).toBe(false);
    expect(w.status.hasMissiles).toBe(false);
    expect(w.status.lock.state).toBe('off');
    expect(w.status.ccip).toBeNull();
    expect(w.range).toBeNull();
  });
});
