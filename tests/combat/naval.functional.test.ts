/**
 * Functional: the whole naval fire-control loop (src/combat/navalFireControl.ts) on a scripted ship
 * over open sea — aim, the turrets train onto the solution, salvos ripple, shells fly tens of
 * seconds, land in a pattern around the aim point, splash, hit and sink target barges — plus the
 * shells' own bookkeeping (src/combat/navalShells.ts) and a fuzz of random aims and ship motion that
 * never fires a turret outside its arc and never produces NaN.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { IOWA_WEAPONS, type NavalGunsConfig } from '../../src/config';
import { createCombatWorld } from '../../src/combat/world';
import { createNavalController, type FiredShot, type ShipPose } from '../../src/combat/navalFireControl';
import { createNavalShells, type ShellImpact } from '../../src/combat/navalShells';
import { toArc } from '../../src/combat/naval';
import type { CombatEvent } from '../../src/combat/types';
import type { Environment, Quat, SurfaceType } from '../../src/types';

const GUNS = IOWA_WEAPONS.naval as NavalGunsConfig;
const DEG = Math.PI / 180;

/** Open sea (40 m deep) with an island (land) around (0, −30 km). */
const SEA: Environment = {
  groundHeight: (x, z) => (Math.hypot(x, z + 30000) < 2000 ? 20 : -40),
  surfaceAt: (x, z): SurfaceType => (Math.hypot(x, z + 30000) < 2000 ? 'grass' : 'water'),
  waterLevel: (x, z) => (Math.hypot(x, z + 30000) < 2000 ? null : 0),
  obstacleTop: () => -Infinity,
};

function quat(headingDeg: number, pitchDeg = 0, rollDeg = 0): Quat {
  const mul = (a: Quat, b: Quat): Quat => ({
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  });
  const ax = (x: number, y: number, z: number, d: number): Quat => ({ x: x * Math.sin((d * DEG) / 2), y: y * Math.sin((d * DEG) / 2), z: z * Math.sin((d * DEG) / 2), w: Math.cos((d * DEG) / 2) });
  return mul(mul(ax(0, 1, 0, -headingDeg), ax(1, 0, 0, pitchDeg)), ax(0, 0, 1, -rollDeg));
}

/** A ship steaming at `kt` on `headingDeg`, rolling ±rollAmp with period rollT. */
function ship(headingDeg: number, kt: number, rollAmp = 0, rollT = 14) {
  const v = kt * 0.514444;
  const h = headingDeg * DEG;
  const pose: ShipPose = { position: { x: 0, y: 0, z: 0 }, orientation: quat(headingDeg), velocity: { x: Math.sin(h) * v, y: 0, z: -Math.cos(h) * v } };
  return {
    pose,
    advance(t: number) {
      pose.position.x = pose.velocity.x * t;
      pose.position.z = pose.velocity.z * t;
      const roll = rollAmp * Math.sin((2 * Math.PI * t) / rollT);
      const pitch = rollAmp * 0.25 * Math.sin((2 * Math.PI * t) / (rollT * 0.6) + 1);
      pose.orientation = quat(headingDeg, pitch, roll);
    },
  };
}

describe('naval fire control, end to end', () => {
  it('trains onto an aim point on the beam, comes ON TARGET, and a salvo of 9 lands in a pattern around it', () => {
    const world = createCombatWorld();
    const ctl = createNavalController(world, SEA, GUNS);
    const s = ship(90, 15, 2.5);
    const aim = { x: 0, y: 0, z: -15000 }; // 15 km on the port beam
    const shots: FiredShot[] = [];
    const impacts: ShellImpact[] = [];
    let t = 0;
    const dt = 1 / 60;
    let fired = false;
    while (t < 90) {
      s.advance(t);
      ctl.setAim(aim);
      ctl.update(s.pose, dt, t, (x) => shots.push(x), (i) => impacts.push(i));
      if (!fired && ctl.battery.turrets.every((tt) => tt.onTarget)) {
        const r = ctl.fire();
        expect(r.scheduled).toBe(9);
        fired = true;
      }
      t += dt;
    }
    expect(fired).toBe(true);
    expect(shots.length).toBe(9);
    // turret I/II train to port (≈ −90), turret III too (≈ 270 in its arc)
    const tr = ctl.battery.turrets.map((x) => x.trainDeg);
    expect(tr[0]).toBeCloseTo(-90, -1);
    expect(tr[2]).toBeCloseTo(270, -1);
    expect(impacts.length).toBe(9);
    for (const i of impacts) expect(i.surface).toBe('water');
    // the pattern: mean point of impact near the aim, spread tens to a couple of hundred metres
    const mx = impacts.reduce((a, i) => a + i.x, 0) / 9;
    const mz = impacts.reduce((a, i) => a + i.z, 0) / 9;
    expect(Math.hypot(mx - aim.x, mz - aim.z)).toBeLessThan(150);
    const spread = Math.max(...impacts.map((i) => Math.hypot(i.x - mx, i.z - mz)));
    expect(spread).toBeGreaterThan(5);
    expect(spread).toBeLessThan(400);
    // tens of seconds of flight
    const t0 = shots[0].time;
    expect(impacts[0].time - t0).toBeGreaterThan(20);
    expect(ctl.shells.count).toBe(0);
  });

  it('a scripted salvo series at an anchored raft 10 km off destroys it within a few salvos; a hulk takes several hits', () => {
    for (const kind of ['raft', 'hulk'] as const) {
      const world = createCombatWorld();
      const events: CombatEvent[] = [];
      world.on((e) => events.push(e));
      const ctl = createNavalController(world, SEA, GUNS, kind === 'raft' ? 7 : 8);
      const target = world.addTarget({ kind, position: { x: 7000, y: -1.2, z: -7140 }, headingDeg: 30, group: 'gunnery' });
      const s = ship(0, 10, 1.5);
      const c = world.centreOf(target);
      let t = 0;
      const dt = 1 / 30;
      let salvos = 0;
      while (t < 600 && target.alive) {
        s.advance(t);
        ctl.setAim(world.centreOf(target));
        ctl.update(s.pose, dt, t);
        if (ctl.battery.turrets.some((x) => x.onTarget) && ctl.fire().scheduled > 0) salvos++;
        t += dt;
      }
      expect(target.alive).toBe(false);
      expect(events.some((e) => e.type === 'destroyed' && e.targetId === target.id && e.weapon === 'shell')).toBe(true);
      expect(events.some((e) => e.type === 'detonation' && e.weapon === 'shell')).toBe(true);
      expect(events.filter((e) => e.type === 'navalFire').length).toBeGreaterThanOrEqual(3);
      if (kind === 'raft') expect(salvos).toBeLessThanOrEqual(4);
      else expect(salvos).toBeLessThanOrEqual(10);
      void c;
    }
  });

  it('leads the towed sled: the mean point of impact tracks where it will be', () => {
    const world = createCombatWorld();
    const ctl = createNavalController(world, SEA, GUNS, 3);
    const s = ship(180, 12);
    const vel = { x: 3.1, y: 0, z: 0 };
    const start = { x: -5000, y: 1, z: 11000 };
    const impacts: ShellImpact[] = [];
    let t = 0;
    let fired = false;
    while (t < 80) {
      s.advance(t);
      const p = { x: start.x + vel.x * t, y: start.y, z: start.z + vel.z * t };
      ctl.setAim(p, vel);
      ctl.update(s.pose, 1 / 30, t, undefined, (i) => impacts.push(i));
      if (!fired && ctl.battery.turrets.filter((x) => x.onTarget).length >= 2) fired = ctl.fire().scheduled > 0;
      t += 1 / 30;
    }
    expect(fired).toBe(true);
    expect(impacts.length).toBeGreaterThan(0);
    for (const i of impacts) {
      const p = { x: start.x + vel.x * i.time, z: start.z + vel.z * i.time };
      expect(Math.hypot(i.x - p.x, i.z - p.z)).toBeLessThan(260);
    }
    const mean = impacts.reduce((a, i) => a + (i.x - (start.x + vel.x * i.time)), 0) / impacts.length;
    expect(Math.abs(mean)).toBeLessThan(60); // lead: no systematic lag behind the sled (it moves ~70 m during the flight)
  });

  it('refuses a salvo with a reason (no aim, out of range); a salvo called while training arms the turrets, which fire once on target or give up', () => {
    const world = createCombatWorld();
    const ctl = createNavalController(world, SEA, GUNS);
    const s = ship(0, 0);
    expect(ctl.fire().refusal).toBe('no-aim');
    ctl.setAim({ x: 0, y: 0, z: -60000 });
    ctl.update(s.pose, 1 / 60, 0);
    expect(ctl.fire().refusal).toBe('out-of-range');
    // a 90° train takes > 22 s: the arm (4 s) lapses and nothing fires
    ctl.setAim({ x: 12000, y: 0, z: 0 });
    let t = 0;
    for (; t < 1; t += 1 / 60) ctl.update(s.pose, 1 / 60, t);
    const r = ctl.fire();
    expect(r.scheduled).toBe(0);
    expect(r.armed).toBe(3);
    expect(r.refusal).toBeNull();
    let shots = 0;
    for (; t < 7; t += 1 / 60) ctl.update(s.pose, 1 / 60, t, () => shots++);
    expect(shots).toBe(0);
    expect(ctl.battery.turrets.every((x) => x.armedUntil < 0)).toBe(true);
    // nearly on the line: armed, then it fires by itself as the turrets settle
    for (; t < 40; t += 1 / 60) ctl.update(s.pose, 1 / 60, t);
    ctl.setAim({ x: 12000, y: 0, z: -400 });
    ctl.update(s.pose, 1 / 60, t);
    const r2 = ctl.fire();
    expect(r2.scheduled + r2.armed).toBeGreaterThan(0);
    for (let k = 0; k < 6 * 60; k++, t += 1 / 60) ctl.update(s.pose, 1 / 60, t, () => shots++);
    expect(shots).toBe(9);
  });

  it('shells hit land and burst there; out-of-flight shells expire; the reset clears everything', () => {
    const world = createCombatWorld();
    const shells = createNavalShells(world, SEA);
    const impacts: ShellImpact[] = [];
    // fire at the island 30 km north
    const e = 30 * DEG;
    shells.fire(GUNS, { x: 0, y: 20, z: 0 }, { x: 0, y: Math.sin(e) * GUNS.muzzleVelocity, z: -Math.cos(e) * GUNS.muzzleVelocity }, 0, 0, 1);
    expect(shells.count).toBe(1);
    const s0 = shells.shells.find((x) => x.live)!;
    expect(s0.ptof).toBeGreaterThan(40);
    for (let t = 0; t < 120 && shells.count; t += 1 / 60) shells.update(GUNS, 1 / 60, t, (i) => impacts.push(i));
    expect(impacts.length).toBe(1);
    const i = impacts[0];
    // the predicted fall of shot matches the live flight
    expect(Math.hypot(i.x - s0.px, i.z - s0.pz)).toBeLessThan(25);
    expect(i.surface === 'grass' || i.surface === 'water').toBe(true);
    shells.fire(GUNS, { x: 0, y: 20, z: 0 }, { x: 0, y: 700, z: 0 }, 0, 0, 0);
    shells.clear();
    expect(shells.count).toBe(0);
    expect(shells.fire(GUNS, { x: Number.NaN, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 0, 0, 0)).toBe(-1);
  });

  it('a direct hit on a raft destroys it; a near miss on the water does reduced (waterBlastFactor) damage', () => {
    const world = createCombatWorld();
    const raft = world.addTarget({ kind: 'raft', position: { x: 0, y: -1.2, z: -500 }, headingDeg: 0, group: 'g' });
    const hulk = world.addTarget({ kind: 'hulk', position: { x: 2000, y: -5.2, z: -500 }, headingDeg: 90, group: 'g' });
    const shells = createNavalShells(world, SEA);
    // straight down onto the raft from above
    shells.fire(GUNS, { x: 0, y: 300, z: -500 }, { x: 0, y: -500, z: 0 }, 0, 0, 0);
    // 20 m beside the hulk's side, into the water
    shells.fire(GUNS, { x: 2000, y: 300, z: -500 + 7.25 + 20 }, { x: 0, y: -500, z: 0 }, 0, 0, 1);
    const impacts: ShellImpact[] = [];
    for (let t = 0; t < 2; t += 1 / 60) shells.update(GUNS, 1 / 60, t, (i) => impacts.push(i));
    expect(raft.alive).toBe(false);
    const hitRaft = impacts.find((i) => i.targetId === raft.id)!;
    expect(hitRaft.surface).toBe('target');
    expect(hitRaft.destroyed).toContain(raft.id);
    const water = impacts.find((i) => i.targetId === null)!;
    expect(water.surface).toBe('water');
    const expected = GUNS.damage * GUNS.waterBlastFactor * (1 - 20 / GUNS.blastRadiusM) ** 2;
    expect(hulk.maxHealth - hulk.health).toBeCloseTo(expected, 0);
  });

  it('fuzz: random aim points, ship motion and triggers — no NaN anywhere, never a shot from a turret out of its arc', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 360, noNaN: true }), fc.double({ min: 0, max: 30, noNaN: true }), fc.double({ min: 0, max: 8, noNaN: true }),
        fc.array(fc.record({ brg: fc.double({ min: -360, max: 360, noNaN: true }), d: fc.double({ min: 200, max: 50000, noNaN: true }), fire: fc.boolean(), hold: fc.integer({ min: 1, max: 90 }) }), { minLength: 1, maxLength: 8 }),
        (hdg, kt, roll, aims) => {
          const world = createCombatWorld();
          const ctl = createNavalController(world, SEA, GUNS, 5);
          const s = ship(hdg, kt, roll);
          let t = 0;
          for (const a of aims) {
            const p = { x: Math.sin(a.brg * DEG) * a.d, y: 0, z: -Math.cos(a.brg * DEG) * a.d };
            for (let k = 0; k < a.hold; k++) {
              s.advance(t);
              ctl.setAim(p);
              if (a.fire && k === a.hold - 1) ctl.fire();
              ctl.update(s.pose, 1 / 20, t, (shot) => {
                const tt = ctl.battery.turrets[shot.turret];
                expect(tt.inArc).toBe(true);
                expect(toArc(tt.cfg, tt.trainDeg)).not.toBeNull();
                expect(Number.isFinite(shot.velocity.x + shot.velocity.y + shot.velocity.z + shot.muzzle.x)).toBe(true);
              });
              t += 1 / 20;
              for (const tt of ctl.battery.turrets) expect(Number.isFinite(tt.trainDeg + tt.elevDeg + (Number.isFinite(tt.missM) ? tt.missM : 0))).toBe(true);
              for (const so of ctl.solutions) expect(Number.isFinite(so.elevDeg + so.bearingDeg)).toBe(true);
            }
          }
        },
      ),
      { numRuns: 25 },
    );
  }, 60000);
});
