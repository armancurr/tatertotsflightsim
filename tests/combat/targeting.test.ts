import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createCombatWorld } from '../../src/combat/world';
import { newLock, selectNextTarget, stepLock } from '../../src/combat/targeting';
import { A10_WEAPONS } from '../../src/config';
import { FLAT_ENV } from '../../src/physics';
import type { Environment } from '../../src/types';

const cfg = A10_WEAPONS.missiles!;
const origin = { x: 0, y: 600, z: 0 };
const north = { x: 0, y: -0.15, z: -1 };

function range() {
  const w = createCombatWorld();
  const a = w.addTarget({ kind: 'tank', position: { x: 0, y: 0, z: -4000 }, headingDeg: 0, group: 'g' });
  const b = w.addTarget({ kind: 'truck', position: { x: 300, y: 0, z: -4000 }, headingDeg: 0, group: 'g' });
  const behind = w.addTarget({ kind: 'tank', position: { x: 0, y: 0, z: 3000 }, headingDeg: 0, group: 'g' });
  const far = w.addTarget({ kind: 'tank', position: { x: 0, y: 0, z: -30000 }, headingDeg: 0, group: 'g' });
  return { w, a, b, behind, far };
}

describe('target selection (T): nearest the nose first, then cycle', () => {
  it('picks the target closest to where the nose points, then the next, then wraps', () => {
    const { w, a, b } = range();
    const first = selectNextTarget(w, origin, north, cfg, null, FLAT_ENV);
    expect(first).toBe(a.id);
    const second = selectNextTarget(w, origin, north, cfg, first, FLAT_ENV);
    expect(second).toBe(b.id);
    expect(selectNextTarget(w, origin, north, cfg, second, FLAT_ENV)).toBe(a.id);
  });

  it('never selects targets behind, beyond range, destroyed, or hidden behind a hill', () => {
    const { w, a, b } = range();
    w.applyHit(a.id, { weapon: 'missile', damage: 999, point: a.position, direction: { x: 0, y: -1, z: 0 }, time: 0 });
    w.applyHit(b.id, { weapon: 'missile', damage: 999, point: b.position, direction: { x: 0, y: -1, z: 0 }, time: 0 });
    expect(selectNextTarget(w, origin, north, cfg, null, FLAT_ENV)).toBeNull();

    const w2 = createCombatWorld();
    w2.addTarget({ kind: 'tank', position: { x: 0, y: 0, z: -4000 }, headingDeg: 0, group: 'g' });
    const ridge: Environment = { ...FLAT_ENV, groundHeight: (_x, z) => (z < -1500 && z > -2500 ? 900 : 0) };
    expect(selectNextTarget(w2, origin, north, cfg, null, ridge)).toBeNull();
  });
});

describe('lock timing', () => {
  it('tracks for lockTimeS, then LOCK (once); drops the lock when the target dies', () => {
    const { w, a } = range();
    const lock = newLock();
    lock.state = 'tracking';
    lock.targetId = a.id;
    const events: string[] = [];
    let t = 0;
    while (t < cfg.lockTimeS + 0.5) {
      const e = stepLock(lock, w, origin, 1 / 60, cfg);
      if (e) events.push(e);
      t += 1 / 60;
    }
    expect(lock.state).toBe('locked');
    expect(events).toEqual(['lock']);
    w.applyHit(a.id, { weapon: 'missile', damage: 999, point: a.position, direction: { x: 0, y: -1, z: 0 }, time: 1 });
    expect(stepLock(lock, w, origin, 1 / 60, cfg)).toBe('lost');
    expect(lock.state).toBe('off');
    expect(lock.targetId).toBeNull();
  });

  it('drops the lock when the target is far beyond the maximum range', () => {
    const { w, a } = range();
    const lock = newLock();
    lock.state = 'locked';
    lock.targetId = a.id;
    expect(stepLock(lock, w, { x: 0, y: 600, z: 30000 }, 1 / 60, cfg)).toBe('lost');
  });

  it('fuzz: any sequence of selections and steps keeps the lock state consistent', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ select: fc.boolean(), kill: fc.integer({ min: -1, max: 3 }), dt: fc.double({ min: 0, max: 0.5, noNaN: true }) }), { maxLength: 80 }),
        (ops) => {
          const { w } = range();
          const lock = newLock();
          for (const op of ops) {
            if (op.select) {
              const id = selectNextTarget(w, origin, north, cfg, lock.targetId, FLAT_ENV);
              if (id === null) Object.assign(lock, newLock());
              else Object.assign(lock, { state: 'tracking', targetId: id, timer: 0 });
            }
            if (op.kill >= 0) {
              const t = w.targets[op.kill];
              w.applyHit(t.id, { weapon: 'missile', damage: 999, point: t.position, direction: { x: 0, y: -1, z: 0 }, time: 0 });
            }
            stepLock(lock, w, origin, op.dt, cfg);
            if (lock.state === 'off') expect(lock.targetId).toBeNull();
            else {
              const t = w.find(lock.targetId!);
              expect(t?.alive).toBe(true);
            }
            if (lock.state === 'locked') expect(lock.timer).toBeGreaterThanOrEqual(cfg.lockTimeS);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
