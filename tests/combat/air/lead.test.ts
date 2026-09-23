import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { A10_WEAPONS, F16_WEAPONS } from '../../../src/config';
import { gunLead, newLead } from '../../../src/combat/air/lead';
import { newBallistic, stepBallistic } from '../../../src/combat/ballistics';

const v = (x: number, y: number, z: number) => ({ x, y, z });

describe('gun lead', () => {
  it('a still target with no drag or gravity: aim straight at it', () => {
    const s = gunLead(newLead(), v(0, 1000, 0), v(0, 0, 0), v(0, 1000, -800), v(0, 0, 0), 1000, 0, 0);
    expect(s.ok).toBe(true);
    expect(s.x).toBeCloseTo(0, 6);
    expect(s.z).toBeCloseTo(-800, 6);
    expect(s.tof).toBeCloseTo(0.8, 6);
  });

  it('crossing target, constant velocity: the exact intercept |D + Vr·t| = u·t', () => {
    fc.assert(
      fc.property(fc.double({ min: 200, max: 1800, noNaN: true }), fc.double({ min: -250, max: 250, noNaN: true }), fc.double({ min: -60, max: 60, noNaN: true }), (d, vx, vy) => {
        const s = gunLead(newLead(), v(0, 1000, 0), v(0, 0, -150), v(0, 1000, -d), v(vx, vy, -150), 1030, 0, 0);
        expect(s.ok).toBe(true);
        // relative position at t equals u·t along the aim direction
        const px = s.x, py = s.y - 1000, pz = s.z;
        expect(Math.hypot(px, py, pz)).toBeCloseTo(1030 * s.tof, 3);
        expect(px).toBeCloseTo(vx * s.tof, 3);
      }),
    );
  });

  it('drag and gravity: longer time of flight, aim above; a real round fired there meets the target', () => {
    const gun = A10_WEAPONS.gun!;
    const shooter = v(0, 800, 0);
    const sv = v(0, 0, -120);
    const tp = v(80, 830, -700);
    const tv = v(-45, 0, -40);
    const plain = gunLead(newLead(), shooter, sv, tp, tv, gun.muzzleVelocity, 0, 0);
    const s = gunLead(newLead(), shooter, sv, tp, tv, gun.muzzleVelocity, gun.dragK, 9.80665);
    expect(s.ok).toBe(true);
    expect(s.tof).toBeGreaterThan(plain.tof);
    expect(s.y - shooter.y).toBeGreaterThan(plain.y - shooter.y);
    // Fire a round from the muzzle along the aim direction with the shooter's velocity added (the real ballistics).
    const ax = s.x - shooter.x, ay = s.y - shooter.y, az = s.z - shooter.z;
    const al = Math.hypot(ax, ay, az);
    const b = newBallistic();
    b.x = shooter.x; b.y = shooter.y; b.z = shooter.z;
    b.vx = sv.x + (gun.muzzleVelocity * ax) / al;
    b.vy = sv.y + (gun.muzzleVelocity * ay) / al;
    b.vz = sv.z + (gun.muzzleVelocity * az) / al;
    let best = Infinity;
    const dt = 1 / 600;
    for (let t = 0; t < 3; t += dt) {
      stepBallistic(b, dt, gun.dragK);
      const tx = tp.x + tv.x * (t + dt), ty = tp.y + tv.y * (t + dt), tz = tp.z + tv.z * (t + dt);
      best = Math.min(best, Math.hypot(b.x - tx, b.y - ty, b.z - tz));
    }
    // (the lead uses sea-level drag; the round flies at 800 m) — within a couple of metres
    expect(best).toBeLessThan(2.5);
  });

  it('never NaN; out of reach → not ok', () => {
    const gun = F16_WEAPONS.gun!;
    expect(gunLead(newLead(), v(0, 0, 0), v(0, 0, 0), v(0, 0, -1e6), v(0, 0, -300), gun.muzzleVelocity, gun.dragK).ok).toBe(false);
    expect(gunLead(newLead(), v(0, 0, 0), v(0, 0, 0), v(NaN, 0, 0), v(0, 0, 0), 1000).ok).toBe(false);
    fc.assert(
      fc.property(fc.array(fc.double({ min: -3000, max: 3000 }), { minLength: 12, maxLength: 12 }), (a) => {
        const s = gunLead(newLead(), v(a[0], a[1], a[2]), v(a[3] / 10, a[4] / 10, a[5] / 10), v(a[6], a[7], a[8]), v(a[9] / 10, a[10] / 10, a[11] / 10), 1030, 5.8e-4);
        if (s.ok) {
          for (const x of [s.x, s.y, s.z, s.tof, s.rangeM]) expect(Number.isFinite(x)).toBe(true);
          expect(s.tof).toBeGreaterThan(0);
        }
      }),
    );
  });
});
