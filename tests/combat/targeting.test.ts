import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createCombatWorld } from '../../src/combat/world';
import { newLock, newPicker, pickTarget, selectNextTarget, stepLock } from '../../src/combat/targeting';
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

describe('T-key stability: the first press takes what the nose is on (sticky), quick presses cycle', () => {
  // a tight platoon 4 km north, 14 m apart across the line of sight
  const platoon = () => {
    const w = createCombatWorld();
    const ids = [0, 1, 2, 3].map((k) => w.addTarget({ kind: 'tank', position: { x: -21 + k * 14, y: 0, z: -4000 }, headingDeg: 0, group: 'p' }).id);
    return { w, ids };
  };
  /** Nose pointed at the ground point (x, 0, −4000). */
  const at = (x: number) => {
    const d = { x: x - origin.x, y: 1.2 - origin.y, z: -4000 - origin.z };
    const l = Math.hypot(d.x, d.y, d.z);
    return { x: d.x / l, y: d.y / l, z: d.z / l };
  };
  const OPTS = { cycleS: 2.5, stickDeg: 0.35 };

  it('first press: the tank nearest the nose', () => {
    const { w, ids } = platoon();
    const p = newPicker();
    expect(pickTarget(p, 0, w, origin, at(-7 + 2), cfg, null, FLAT_ENV, undefined, OPTS)).toBe(ids[1]);
    const p2 = newPicker();
    expect(pickTarget(p2, 0, w, origin, at(21), cfg, null, FLAT_ENV, undefined, OPTS)).toBe(ids[3]);
  });

  it('a later press with the nose slightly off keeps the tracked tank (no jumping to the neighbour)', () => {
    const { w, ids } = platoon();
    const p = newPicker();
    const first = pickTarget(p, 0, w, origin, at(-7), cfg, null, FLAT_ENV, undefined, OPTS);
    expect(first).toBe(ids[1]);
    // the nose has drifted to just past the midpoint toward tank 2 (7.5 m right of tank 1 = 0.1°)
    expect(pickTarget(p, 5, w, origin, at(0.5), cfg, first, FLAT_ENV, undefined, OPTS)).toBe(ids[1]);
    // pointed squarely at tank 3 (well beyond the margin): that one
    expect(pickTarget(p, 10, w, origin, at(21), cfg, first, FLAT_ENV, undefined, OPTS)).toBe(ids[3]);
  });

  it('quick presses cycle through the platoon in the order of the first press, whatever the nose does meanwhile', () => {
    const { w, ids } = platoon();
    const p = newPicker();
    let id = pickTarget(p, 0, w, origin, at(-7), cfg, null, FLAT_ENV, undefined, OPTS);
    const seen = [id];
    for (let k = 1; k < 4; k++) {
      // the nose wanders between presses
      id = pickTarget(p, k * 0.8, w, origin, at(-7 + (k % 2 ? 9 : -9)), cfg, id, FLAT_ENV, undefined, OPTS);
      seen.push(id);
    }
    expect(new Set(seen).size).toBe(4);
    expect(seen[0]).toBe(ids[1]);
    // then wraps back to the first
    expect(pickTarget(p, 3.9, w, origin, at(-7), cfg, id, FLAT_ENV, undefined, OPTS)).toBe(ids[1]);
  });

  it('skips targets destroyed during the cycle', () => {
    const { w, ids } = platoon();
    const p = newPicker();
    const first = pickTarget(p, 0, w, origin, at(-7), cfg, null, FLAT_ENV, undefined, OPTS);
    const t = w.find(ids[0])!;
    w.applyHit(t.id, { weapon: 'missile', damage: 999, point: t.position, direction: { x: 0, y: -1, z: 0 }, time: 0 });
    let id = first;
    for (let k = 1; k < 6; k++) {
      id = pickTarget(p, k * 0.5, w, origin, at(-7), cfg, id, FLAT_ENV, undefined, OPTS);
      expect(id).not.toBe(ids[0]);
      expect(w.find(id!)!.alive).toBe(true);
    }
  });

  it('property: slow presses with a wobbling nose near one tank never change the target, so the lock completes', () => {
    fc.assert(
      fc.property(fc.array(fc.record({ wait: fc.double({ min: 2.6, max: 6, noNaN: true }), wobble: fc.double({ min: -4, max: 4, noNaN: true }) }), { minLength: 2, maxLength: 12 }), fc.integer({ min: 0, max: 3 }), (presses, k) => {
        const { w, ids } = platoon();
        const p = newPicker();
        const lock = newLock();
        let now = 0;
        const aimX = -21 + k * 14;
        for (const pr of presses) {
          const id = pickTarget(p, now, w, origin, at(aimX + pr.wobble), cfg, lock.targetId, FLAT_ENV, undefined, OPTS);
          expect(id).toBe(ids[k]);
          // the missiles system: the lock timer restarts only when the target changes
          if (id !== lock.targetId) Object.assign(lock, { state: 'tracking', targetId: id, timer: 0 });
          for (let t = 0; t < pr.wait; t += 0.1) stepLock(lock, w, origin, 0.1, cfg);
          now += pr.wait;
        }
        expect(lock.state).toBe('locked');
      }),
      { numRuns: 150 },
    );
  });
});
