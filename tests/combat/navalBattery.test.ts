/**
 * The main battery's state (src/combat/navalBattery.ts): turrets train and elevate at their real
 * rates, never through the blind sector, salvos ripple from the loaded guns of the turrets on target,
 * each gun reloads in `reloadS` from a finite magazine; the TurretStatus mirror the model reads.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { IOWA_WEAPONS, type NavalGunsConfig } from '../../src/config';
import { armedCount, cancelSalvo, createBattery, dueShots, HOLD_FIRE_S, nextReadyS, orderTurret, pollArmed, requestSalvo, resetBattery, roundsLeft, stepBattery, type Shot } from '../../src/combat/navalBattery';

const GUNS = IOWA_WEAPONS.naval as NavalGunsConfig;

const run = (b: ReturnType<typeof createBattery>, seconds: number, dt = 1 / 60, shots?: Shot[], out: Shot[] = []) => {
  for (let t = 0; t < seconds - 1e-9; t += dt) {
    stepBattery(b, dt);
    if (shots) {
      dueShots(b, out);
      shots.push(...out);
    }
  }
};

describe('turret drives', () => {
  it('starts stowed (III faces aft), every gun loaded, full magazines, status mirrors it', () => {
    const b = createBattery(GUNS);
    expect(b.status.map((s) => s.trainDeg)).toEqual([0, 0, 180]);
    expect(b.status.every((s) => s.ready.every(Boolean) && s.ready.length === 3)).toBe(true);
    expect(roundsLeft(b)).toBe(9 * GUNS.roundsPerGun);
  });

  it('trains at 4°/s and elevates at 12°/s (real Iowa rates)', () => {
    const b = createBattery(GUNS);
    orderTurret(b, 0, 90, 30);
    run(b, 5);
    expect(b.turrets[0].trainDeg).toBeCloseTo(20, 0);
    expect(b.turrets[0].elevDeg).toBeGreaterThan(29);
    run(b, 20);
    expect(b.turrets[0].trainDeg).toBeCloseTo(90, 1);
    // a train of 90° cannot take less than 22.5 s
    const c = createBattery(GUNS);
    orderTurret(c, 1, 90, 0);
    run(c, 22);
    expect(c.turrets[1].trainDeg).toBeLessThan(89);
  });

  it('turret I goes the long way round rather than through its blind sector aft', () => {
    const b = createBattery(GUNS);
    orderTurret(b, 0, -140, 5);
    run(b, 40);
    expect(b.turrets[0].trainDeg).toBeCloseTo(-140, 1);
    orderTurret(b, 0, 140, 5);
    const seen: number[] = [];
    for (let t = 0; t < 80; t += 1 / 30) {
      stepBattery(b, 1 / 30);
      seen.push(b.turrets[0].trainDeg);
    }
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(-150);
    expect(Math.max(...seen)).toBeLessThanOrEqual(150);
    expect(seen.some((v) => Math.abs(v) < 2)).toBe(true); // passed the bow
    expect(b.turrets[0].trainDeg).toBeCloseTo(140, 1);
  });

  it('an order into the blind sector parks the turret at the nearest arc limit and flags it out of arc', () => {
    const b = createBattery(GUNS);
    orderTurret(b, 2, 5, 10); // turret III cannot fire over the bow
    expect(b.turrets[2].inArc).toBe(false);
    expect(b.turrets[2].orderTrain).toBe(30);
    orderTurret(b, 2, -60, 10); // = 300, inside III's arc
    expect(b.turrets[2].inArc).toBe(true);
    expect(b.turrets[2].orderTrain).toBe(300);
    orderTurret(b, 0, 175, 10);
    expect(b.turrets[0].inArc).toBe(false);
    expect(b.turrets[0].orderTrain).toBe(150);
  });

  it('follows a moving order (the ship rolling) with the feed-forward: small lag', () => {
    const b = createBattery(GUNS);
    const dt = 1 / 60;
    let worst = 0;
    for (let t = 0; t < 30; t += dt) {
      const e = 12 + 2.5 * Math.sin((2 * Math.PI * t) / 12); // ±2.5° roll-induced elevation change, 12 s period
      orderTurret(b, 0, 60, e, dt);
      stepBattery(b, dt);
      if (t > 10) worst = Math.max(worst, Math.abs(b.turrets[0].elevDeg - e));
    }
    expect(worst).toBeLessThan(0.05);
  });
});

describe('salvos and reloading', () => {
  it('a salvo ripples every loaded gun of the turrets on target, rippleS apart, centre gun first', () => {
    const b = createBattery(GUNS);
    b.turrets[0].onTarget = true;
    b.turrets[1].onTarget = true;
    b.turrets[2].onTarget = false;
    expect(requestSalvo(b)).toBe(6);
    const shots: Shot[] = [];
    const times: number[] = [];
    const out: Shot[] = [];
    for (let t = 0; t < 2; t += 1 / 120) {
      stepBattery(b, 1 / 120);
      if (dueShots(b, out)) for (const s of out) {
        shots.push(s);
        times.push(b.time);
      }
    }
    expect(shots.map((s) => s.turret)).toEqual([0, 0, 0, 1, 1, 1]);
    expect(shots[0].gun).toBe(1);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeCloseTo(GUNS.rippleS, 1);
    expect(b.status[1].recoil[2]).toBeGreaterThan(0);
    expect(b.status[0].ready.every((r) => !r)).toBe(true);
    expect(b.status[2].ready.every(Boolean)).toBe(true);
    expect(roundsLeft(b)).toBe(9 * GUNS.roundsPerGun - 6);
  });

  it('guns reload in reloadS; a second salvo before then fires nothing', () => {
    const b = createBattery(GUNS);
    for (const t of b.turrets) t.onTarget = true;
    requestSalvo(b);
    const shots: Shot[] = [];
    run(b, 3, 1 / 60, shots);
    expect(shots.length).toBe(9);
    expect(requestSalvo(b)).toBe(0);
    expect(nextReadyS(b)).toBeGreaterThan(GUNS.reloadS - 4);
    run(b, GUNS.reloadS - 1);
    expect(requestSalvo(b)).toBe(9);
  });

  it('recoil runs out over recoilReturnS and the flash dies in a fraction of a second', () => {
    const b = createBattery(GUNS);
    b.turrets[0].onTarget = true;
    requestSalvo(b);
    const shots: Shot[] = [];
    run(b, 0.02, 1 / 120, shots);
    expect(b.status[0].recoil[1]).toBeGreaterThan(0.95);
    expect(b.status[0].flash[1]).toBeGreaterThan(0.7);
    run(b, 0.6);
    expect(b.status[0].flash[1]).toBe(0);
    run(b, GUNS.recoilReturnS + 0.1);
    expect(b.status[0].recoil[1]).toBe(0);
  });

  it('empty magazines: the gun never loads again; reset refills', () => {
    const g = { ...GUNS, roundsPerGun: 1, reloadS: 1 };
    const b = createBattery(g);
    for (const t of b.turrets) t.onTarget = true;
    requestSalvo(b);
    run(b, 3, 1 / 60, []);
    run(b, 5);
    expect(roundsLeft(b)).toBe(0);
    expect(requestSalvo(b)).toBe(0);
    expect(nextReadyS(b)).toBe(Infinity);
    resetBattery(b);
    expect(roundsLeft(b)).toBe(9);
    expect(b.status[2].trainDeg).toBe(180);
  });

  it('a scheduled gun holds its fire while its turret is off the line, fires when back on it, and stands down after HOLD_FIRE_S', () => {
    const b = createBattery(GUNS);
    b.turrets[0].onTarget = true;
    requestSalvo(b);
    const shots: Shot[] = [];
    const out: Shot[] = [];
    stepBattery(b, 1 / 60);
    dueShots(b, out);
    shots.push(...out);
    expect(shots.length).toBe(1);
    b.turrets[0].onTarget = false; // the roll carried the guns off
    for (let t = 0; t < 1; t += 1 / 60) {
      stepBattery(b, 1 / 60);
      dueShots(b, out);
      shots.push(...out);
    }
    expect(shots.length).toBe(1);
    b.turrets[0].onTarget = true;
    for (let t = 0; t < 1; t += 1 / 60) {
      stepBattery(b, 1 / 60);
      dueShots(b, out);
      shots.push(...out);
    }
    expect(shots.length).toBe(3);
    // held too long: stood down, still loaded
    const c = createBattery(GUNS);
    c.turrets[1].onTarget = true;
    requestSalvo(c);
    c.turrets[1].onTarget = false;
    for (let t = 0; t < HOLD_FIRE_S + 1; t += 1 / 30) {
      stepBattery(c, 1 / 30);
      dueShots(c, out);
      expect(out.length).toBe(0);
    }
    c.turrets[1].onTarget = true;
    stepBattery(c, 1 / 30);
    expect(dueShots(c, out)).toBe(0);
    expect(c.status[1].ready.every(Boolean)).toBe(true);
  });

  it('armed salvo: a turret not yet on target fires the moment it is (within the wait), not after', () => {
    const b = createBattery(GUNS);
    b.turrets[0].onTarget = true;
    expect(requestSalvo(b, undefined, 4)).toBe(3);
    expect(armedCount(b)).toBe(2);
    b.turrets[2].tooFar = true; // no solution: dropped
    stepBattery(b, 1);
    pollArmed(b);
    expect(armedCount(b)).toBe(1);
    b.turrets[1].onTarget = true;
    expect(pollArmed(b)).toBe(3);
    expect(armedCount(b)).toBe(0);
    const c = createBattery(GUNS);
    requestSalvo(c, undefined, 2);
    for (let k = 0; k < 5; k++) stepBattery(c, 0.5);
    c.turrets[0].onTarget = true;
    expect(pollArmed(c)).toBe(0);
  });

  it('cancelSalvo drops scheduled shots', () => {
    const b = createBattery(GUNS);
    for (const t of b.turrets) t.onTarget = true;
    requestSalvo(b);
    cancelSalvo(b);
    const shots: Shot[] = [];
    run(b, 3, 1 / 60, shots);
    expect(shots.length).toBe(0);
  });

  it('fuzz: random orders, targets and triggers never fire a turret out of its arc and never produce NaN', () => {
    fc.assert(
      fc.property(fc.array(fc.record({ i: fc.integer({ min: 0, max: 2 }), tr: fc.double({ min: -720, max: 720, noNaN: true }), el: fc.double({ min: -20, max: 80, noNaN: true }), on: fc.boolean(), fire: fc.boolean(), dt: fc.double({ min: 0, max: 0.6, noNaN: true }) }), { maxLength: 60 }), (ops) => {
        const b = createBattery(GUNS);
        const out: Shot[] = [];
        for (const o of ops) {
          orderTurret(b, o.i, o.tr, o.el, o.dt);
          b.turrets[o.i].onTarget = o.on && b.turrets[o.i].inArc;
          if (o.fire) requestSalvo(b);
          stepBattery(b, o.dt);
          dueShots(b, out);
          for (const t of b.turrets) {
            expect(Number.isFinite(t.trainDeg + t.elevDeg)).toBe(true);
            expect(t.trainDeg).toBeGreaterThanOrEqual(t.cfg.trainMinDeg - 1e-9);
            expect(t.trainDeg).toBeLessThanOrEqual(t.cfg.trainMaxDeg + 1e-9);
            expect(t.elevDeg).toBeGreaterThanOrEqual(t.cfg.elevMinDeg - 1e-9);
            expect(t.elevDeg).toBeLessThanOrEqual(t.cfg.elevMaxDeg + 1e-9);
          }
          for (const s of out) expect(b.turrets[s.turret].inArc).toBe(true);
        }
      }),
      { numRuns: 80 },
    );
  });
});
