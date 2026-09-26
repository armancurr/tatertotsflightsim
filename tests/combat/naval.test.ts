/**
 * Naval gunnery maths (src/combat/naval.ts): the 16-inch shell's ballistics against the real
 * 16"/50 Mark 7 (≈ 38 km at 45°, ~95 s time of flight), the turret geometry contract with the ship's
 * model (train / elevation / muzzle sign conventions), the training arcs, and the fire-control
 * solution landing a simulated shell on the aim point from a moving, rolling ship.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { IOWA_WEAPONS, type NavalGunsConfig, type NavalTurretConfig } from '../../src/config';
import {
  deckAngles, flyToHeight, gunDirection, muzzlePosition, navalGunsOf, nearestArcLimit, newFireSolution, newShellFlight, newShellState,
  predictedMissM, rangeTable, rotateByQuat, solveElevation, solveFireControl, stepShell, tableAt, tableElevation, toArc, trunnionPosition, worldBore,
} from '../../src/combat/naval';
import type { Quat, Vec3 } from '../../src/types';

const GUNS = IOWA_WEAPONS.naval as NavalGunsConfig;
const [T1, T2, T3] = GUNS.turrets as [NavalTurretConfig, NavalTurretConfig, NavalTurretConfig];
const DEG = Math.PI / 180;

const fire = (elevDeg: number, k = GUNS.dragK) => {
  const s = newShellState();
  s.vx = GUNS.muzzleVelocity * Math.cos(elevDeg * DEG);
  s.vy = GUNS.muzzleVelocity * Math.sin(elevDeg * DEG);
  return flyToHeight(s, k, 0, 300, newShellFlight());
};

/** Quaternion from yaw (heading, deg clockwise from north) then pitch (bow up +) and roll (starboard down +). */
function shipQuat(headingDeg: number, pitchDeg = 0, rollDeg = 0): Quat {
  // body→world = Ry(−heading) · Rx(pitch) · Rz(−roll)
  const mul = (a: Quat, b: Quat): Quat => ({
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  });
  const ax = (x: number, y: number, z: number, deg: number): Quat => {
    const h = (deg * DEG) / 2;
    return { x: x * Math.sin(h), y: y * Math.sin(h), z: z * Math.sin(h), w: Math.cos(h) };
  };
  return mul(mul(ax(0, 1, 0, -headingDeg), ax(1, 0, 0, pitchDeg)), ax(0, 0, 1, -rollDeg));
}

describe('16-inch shell ballistics', () => {
  it('reaches ~38 km at 45° in ~95 s (the real Mark 7 with the AP shell: 38.7 km, 98.6 s)', () => {
    const f = fire(45);
    expect(f.landed).toBe(true);
    expect(f.x).toBeGreaterThan(36500);
    expect(f.x).toBeLessThan(40000);
    expect(f.tof).toBeGreaterThan(85);
    expect(f.tof).toBeLessThan(105);
    // apex ~11 km, strikes at ~500 m/s
    expect(f.apex).toBeGreaterThan(9000);
    expect(Math.hypot(f.vx, f.vy)).toBeGreaterThan(420);
    expect(Math.hypot(f.vx, f.vy)).toBeLessThan(600);
  });

  it('flight time is tens of seconds at long range; range grows with elevation up to the limit', () => {
    let last = 0;
    for (const e of [2, 5, 10, 15, 20, 30, 40, 45]) {
      const f = fire(e);
      expect(f.x).toBeGreaterThan(last);
      last = f.x;
    }
    expect(fire(10).tof).toBeGreaterThan(18);
    expect(fire(20).tof).toBeGreaterThan(40);
  });

  it('drag matters: without it the same shell would fly ~59 km at 45°; thinner air aloft carries it further', () => {
    const vac = fire(45, 0);
    const v = GUNS.muzzleVelocity;
    expect(vac.x).toBeCloseTo((v * v) / 9.80665, -2);
    expect(fire(45).x).toBeLessThan(vac.x * 0.7);
    // constant sea-level density would cut the range much further than the real (thinning) air does
    const s = newShellState();
    s.vx = v * Math.SQRT1_2;
    s.vy = v * Math.SQRT1_2;
    let t = 0;
    const k = GUNS.dragK;
    // explicit Euler with ρ = ρ0 everywhere
    while (t < 200 && !(s.vy < 0 && s.y <= 0)) {
      const sp = k * Math.hypot(s.vx, s.vy);
      s.vx -= sp * s.vx * 0.01;
      s.vy -= (9.80665 + sp * s.vy) * 0.01;
      s.x += s.vx * 0.01;
      s.y += s.vy * 0.01;
      t += 0.01;
    }
    expect(s.x).toBeLessThan(fire(45).x * 0.85);
  });

  it('RK4 frame steps agree with the 0.25 s fire-control steps to a few metres at 20 km', () => {
    const a = newShellState();
    a.vx = GUNS.muzzleVelocity * Math.cos(12 * DEG);
    a.vy = GUNS.muzzleVelocity * Math.sin(12 * DEG);
    const b = { ...a };
    for (let i = 0; i < 60 * 30; i++) stepShell(a, 1 / 60, GUNS.dragK);
    stepShell(b, 30, GUNS.dragK);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(3);
  });

  it('never produces NaN from garbage inputs', () => {
    const s = newShellState();
    s.vx = 700;
    stepShell(s, Number.NaN, Number.NaN);
    stepShell(s, 1, Number.POSITIVE_INFINITY);
    expect(Number.isFinite(s.x + s.y + s.vx + s.vy)).toBe(true);
  });

  it('the range table covers the elevations, its lookup inverts it, and it reports the max range', () => {
    const t = rangeTable(GUNS);
    expect(t.maxRangeM).toBeGreaterThan(36500);
    expect(t.maxRangeElevDeg).toBeCloseTo(45, 0);
    for (const e of [3, 8, 17.5, 33]) {
      const r = tableAt(t, e).rangeM;
      expect(tableElevation(t, r)).toBeCloseTo(e, 1);
    }
    expect(tableAt(t, 10).dRdElev).toBeGreaterThan(500);
  });
});

describe('turret geometry (the contract with the ship model)', () => {
  it('train 0 points at the bow (−Z), +90 at starboard (+X), elevation raises the bore', () => {
    const v = gunDirection(0, 0);
    expect(v.z).toBeCloseTo(-1, 12);
    const s = gunDirection(90, 0);
    expect(s.x).toBeCloseTo(1, 12);
    expect(s.z).toBeCloseTo(0, 12);
    const up = gunDirection(0, 30);
    expect(up.y).toBeCloseTo(0.5, 12);
    expect(up.z).toBeCloseTo(-Math.cos(30 * DEG), 12);
    const aft = gunDirection(180, 0);
    expect(aft.z).toBeCloseTo(1, 12);
  });

  it('muzzle = turret + Ry(−train)·(trunnion + lateral + Rx(elev)·(0,0,−L)): worked numbers', () => {
    const m = muzzlePosition(T1, 0, 0, 1);
    expect(m.x).toBeCloseTo(T1.position.x, 9);
    expect(m.y).toBeCloseTo(T1.position.y + T1.trunnionHeight, 9);
    expect(m.z).toBeCloseTo(T1.position.z - T1.trunnionForward - T1.barrelLength, 9);
    // gun 0 is to port (−X) when trained forward, to the bow side (−Z) when trained to starboard
    expect(muzzlePosition(T1, 0, 0, 0).x).toBeCloseTo(T1.position.x - T1.barrelSpacing, 9);
    const s = muzzlePosition(T1, 90, 0, 0);
    expect(s.x).toBeCloseTo(T1.position.x + T1.trunnionForward + T1.barrelLength, 9);
    expect(s.z).toBeCloseTo(T1.position.z - T1.barrelSpacing, 9);
    // elevated 45°: the muzzle rises L sin 45 and comes back L (1 − cos 45)
    const e = muzzlePosition(T1, 0, 45, 1);
    expect(e.y - T1.position.y - T1.trunnionHeight).toBeCloseTo(T1.barrelLength * Math.SQRT1_2, 9);
    expect(-(e.z - T1.position.z) - T1.trunnionForward).toBeCloseTo(T1.barrelLength * Math.SQRT1_2, 9);
  });

  it('fuzz: the muzzle lies on the bore line through the trunnion (plus the lateral offset)', () => {
    fc.assert(fc.property(fc.double({ min: -180, max: 360, noNaN: true }), fc.double({ min: -2, max: 45, noNaN: true }), fc.integer({ min: 0, max: 2 }), (tr, el, k) => {
      const m = muzzlePosition(T2, tr, el, k);
      const p = trunnionPosition(T2, tr);
      const d = gunDirection(tr, el);
      const lat = (k - 1) * T2.barrelSpacing;
      // remove the lateral offset (turret +X rotated): (cos T, 0, sin T)
      const rx = m.x - p.x - lat * Math.cos(tr * DEG);
      const ry = m.y - p.y;
      const rz = m.z - p.z - lat * Math.sin(tr * DEG);
      expect(rx).toBeCloseTo(d.x * T2.barrelLength, 6);
      expect(ry).toBeCloseTo(d.y * T2.barrelLength, 6);
      expect(rz).toBeCloseTo(d.z * T2.barrelLength, 6);
    }));
  });

  it('deck angles invert the bore on a rolled, pitched ship', () => {
    fc.assert(fc.property(fc.double({ min: 0, max: 360, noNaN: true }), fc.double({ min: -8, max: 8, noNaN: true }), fc.double({ min: -15, max: 15, noNaN: true }), fc.double({ min: -150, max: 150, noNaN: true }), fc.double({ min: -2, max: 45, noNaN: true }), (h, p, r, tr, el) => {
      const q = shipQuat(h, p, r);
      const w = worldBore(q, tr, el);
      const a = deckAngles(q, w);
      expect(a.elevDeg).toBeCloseTo(el, 6);
      expect(((a.trainDeg - tr + 540) % 360) - 180).toBeCloseTo(0, 5);
    }));
  });
});

describe('training arcs', () => {
  it('turrets I and II cannot bear aft, III cannot bear forward', () => {
    expect(toArc(T1, 0)).toBe(0);
    expect(toArc(T1, 140)).toBe(140);
    expect(toArc(T1, -140)).toBe(-140);
    expect(toArc(T1, 180)).toBeNull();
    expect(toArc(T1, 170)).toBeNull();
    expect(toArc(T3, 180)).toBe(180);
    expect(toArc(T3, -90)).toBe(270);
    expect(toArc(T3, 0)).toBeNull();
    expect(toArc(T3, 20)).toBeNull();
    expect(toArc(T3, 40)).toBe(40);
    expect(nearestArcLimit(T1, 175)).toBe(150);
    expect(nearestArcLimit(T1, -170)).toBe(-150);
    expect(nearestArcLimit(T3, 10)).toBe(30);
    expect(nearestArcLimit(T3, -5)).toBe(330);
  });

  it('fuzz: toArc returns a value inside the arc equal to the bearing mod 360, or null in the blind sector', () => {
    fc.assert(fc.property(fc.constantFrom(T1, T2, T3), fc.double({ min: -1000, max: 1000, noNaN: true }), (t, b) => {
      const a = toArc(t, b);
      if (a === null) {
        // every representation is outside
        for (let k = -3; k <= 3; k++) {
          const v = b + 360 * k;
          expect(v < t.trainMinDeg - 1e-6 || v > t.trainMaxDeg + 1e-6).toBe(true);
        }
      } else {
        expect(a).toBeGreaterThanOrEqual(t.trainMinDeg - 1e-9);
        expect(a).toBeLessThanOrEqual(t.trainMaxDeg + 1e-9);
        const d = (((a - b) % 360) + 360) % 360;
        expect(Math.min(d, 360 - d)).toBeCloseTo(0, 6);
      }
    }));
  });
});

describe('fire-control solution', () => {
  it('solveElevation hits ranges across the envelope and flags too far', () => {
    for (const D of [3000, 10000, 20000, 30000, 36000]) {
      const s = solveElevation(GUNS, D, -12, -2, 45);
      expect(s.ok).toBe(true);
      expect(Math.abs(s.rangeM - D)).toBeLessThan(1);
      expect(s.flights).toBeLessThan(25);
    }
    const far = solveElevation(GUNS, 45000, 0, -2, 45);
    expect(far.ok).toBe(false);
    expect(far.tooFar).toBe(true);
    expect(far.elevDeg).toBeCloseTo(45, 0);
  });

  it('lands the shell on a stationary point from a fast ship (the shell inherits the ship\'s velocity)', () => {
    const sol = solveFireControl(GUNS, {
      muzzle: { x: 0, y: 20, z: 0 }, shipVelocity: { x: 16, y: 0, z: 0 }, target: { x: 9000, y: 0, z: -12000 }, elevMinDeg: -2, elevMaxDeg: 45,
    });
    expect(sol.ok).toBe(true);
    expect(Math.hypot(sol.impact.x - 9000, sol.impact.z + 12000)).toBeLessThan(2);
    expect(sol.tofS).toBeGreaterThan(20);
    expect(sol.rangeM).toBeCloseTo(15000, -1);
    // re-fly it independently
    const s = newShellState();
    s.x = 0; s.y = 20; s.z = 0;
    s.vx = sol.dir.x * GUNS.muzzleVelocity + 16;
    s.vy = sol.dir.y * GUNS.muzzleVelocity;
    s.vz = sol.dir.z * GUNS.muzzleVelocity;
    for (let t = 0; t < sol.tofS - 1e-9; t += 1 / 60) stepShell(s, Math.min(1 / 60, sol.tofS - t), GUNS.dragK);
    expect(Math.hypot(s.x - 9000, s.z + 12000)).toBeLessThan(15);
  });

  it('leads a moving target by the time of flight', () => {
    const tv = { x: -6, y: 0, z: 2 };
    const sol = solveFireControl(GUNS, { muzzle: { x: 0, y: 15, z: 0 }, shipVelocity: { x: 0, y: 0, z: -8 }, target: { x: 0, y: 2, z: -18000 }, targetVelocity: tv, elevMinDeg: -2, elevMaxDeg: 45 });
    expect(sol.ok).toBe(true);
    expect(Math.hypot(sol.impact.x - sol.targetAtImpact.x, sol.impact.z - sol.targetAtImpact.z)).toBeLessThan(2);
    expect(sol.targetAtImpact.x).toBeCloseTo(tv.x * sol.tofS, 0);
  });

  it('from a rolling ship: the deck angles for the solution put the rolled bore on the world solution', () => {
    const q = shipQuat(70, 1.5, -6);
    const sol = solveFireControl(GUNS, { muzzle: { x: 100, y: 18, z: 50 }, shipVelocity: { x: 7, y: 0.4, z: -2 }, target: { x: -8000, y: 0, z: -6000 }, elevMinDeg: -2, elevMaxDeg: 45 });
    const a = deckAngles(q, sol.dir);
    const bore = worldBore(q, a.trainDeg, a.elevDeg);
    expect(predictedMissM(sol, bore)).toBeLessThan(0.5);
    // the unrolled deck angles would miss by hundreds of metres
    const flat = deckAngles(shipQuat(70), sol.dir);
    expect(predictedMissM(sol, worldBore(q, flat.trainDeg, flat.elevDeg))).toBeGreaterThan(100);
  });

  it('predicted miss grows with the bearing and elevation error', () => {
    const sol = solveFireControl(GUNS, { muzzle: { x: 0, y: 15, z: 0 }, shipVelocity: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: -10000 }, elevMinDeg: -2, elevMaxDeg: 45 });
    const q = shipQuat(0);
    const a = deckAngles(q, sol.dir);
    expect(predictedMissM(sol, worldBore(q, a.trainDeg + 0.2, a.elevDeg))).toBeCloseTo(10000 * 0.2 * DEG, -1);
    expect(predictedMissM(sol, worldBore(q, a.trainDeg, a.elevDeg + 0.1))).toBeGreaterThan(50);
  });

  it('fuzz: random aim points and ship motion never produce NaN; in-range solutions land within 5 m', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 360, noNaN: true }), fc.double({ min: 500, max: 45000, noNaN: true }),
        fc.record({ x: fc.double({ min: -18, max: 18, noNaN: true }), y: fc.double({ min: -1, max: 1, noNaN: true }), z: fc.double({ min: -18, max: 18, noNaN: true }) }),
        fc.double({ min: 5, max: 30, noNaN: true }),
        (brg, D, v, h) => {
          const target: Vec3 = { x: Math.sin(brg * DEG) * D, y: 0, z: -Math.cos(brg * DEG) * D };
          const sol = solveFireControl(GUNS, { muzzle: { x: 0, y: h, z: 0 }, shipVelocity: v, target, elevMinDeg: -2, elevMaxDeg: 45 }, newFireSolution());
          expect(Number.isFinite(sol.elevDeg + sol.bearingDeg + sol.tofS + sol.dir.x + sol.dir.y + sol.dir.z)).toBe(true);
          expect(sol.elevDeg).toBeGreaterThanOrEqual(-2 - 1e-9);
          expect(sol.elevDeg).toBeLessThanOrEqual(45.5 + 1e-9);
          if (sol.ok) expect(Math.hypot(sol.impact.x - target.x, sol.impact.z - target.z)).toBeLessThan(5);
          else expect(sol.tooFar || sol.tooClose).toBe(true);
          if (D < 36000) expect(sol.tooFar).toBe(false);
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe('navalGunsOf (which vehicles carry the battery)', () => {
  it('a config with weapons.naval; the Iowa battery on a vessel only with ?naval=iowa (dev harness)', () => {
    expect(navalGunsOf({ config: { weapons: IOWA_WEAPONS } })).toBe(GUNS);
    expect(navalGunsOf({ kind: 'vessel', config: { weapons: null } }, '')).toBeNull();
    expect(navalGunsOf({ kind: 'vessel', config: { weapons: null } }, '?naval=iowa')).toBe(GUNS);
    expect(navalGunsOf({ config: { weapons: null } }, '?naval=iowa')).toBeNull();
    expect(navalGunsOf(null, '?naval=iowa')).toBeNull();
  });
  it('rotateByQuat is a rotation (keeps length)', () => {
    const q = shipQuat(33, 4, -7);
    const o = rotateByQuat(q, 1, 2, 3, { x: 0, y: 0, z: 0 });
    expect(Math.hypot(o.x, o.y, o.z)).toBeCloseTo(Math.hypot(1, 2, 3), 12);
  });
});
