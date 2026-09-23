/**
 * Functional: a headless A-10 (A10_WEAPONS GAU-8/A, the real muzzle and gun line) diving on vehicles
 * over flat ground, flown kinematically along a straight dive with the pilot keeping the CCIP pipper
 * on the target (the nose pitched each frame so the pipper sits on the hull), opening fire at
 * 4,000 ft slant range — the classic A-10 gun pass. Checks the armour-by-aspect outcome:
 * a 2 s burst from above/behind kills a T-72, the same burst into its front barely scratches it,
 * and a short burst wrecks a truck.
 */
import { describe, it, expect, vi } from 'vitest';
import { A10_WEAPONS, KT_TO_MS } from '../../src/config';
import { createCombatWorld } from '../../src/combat/world';
import { createGunnery, type GunPose } from '../../src/combat/gunnery';
import { computeCcip, newCcip } from '../../src/combat/ccip';
import { defaultControls, FLAT_ENV } from '../../src/physics';
import { quatFromEuler, bodyToWorld } from '../../src/physics/frames';
import type { CombatEvent, TargetKind } from '../../src/combat/types';
import type { Vec3 } from '../../src/types';

vi.setConfig({ testTimeout: 30_000 });

const GAU8 = A10_WEAPONS.gun!;

interface Pass {
  kind: TargetKind;
  /** The target's heading; the A-10 runs in heading north (0°), so 0 = from behind, 180 = head-on. */
  targetHeading: number;
  diveDeg: number;
  kt: number;
  openFireM: number;
  burstS: number;
  seed?: number;
}

/** Along-track distance of the CCIP past the target (m, + = long) for the nose at `pitch`. */
function pipperError(pos: Vec3, vel: Vec3, pitch: number): number {
  const q = quatFromEuler(0, pitch, 0);
  const m = bodyToWorld(q, GAU8.muzzle);
  const d = (GAU8.boresightDownDeg * Math.PI) / 180;
  const dir = bodyToWorld(q, { x: 0, y: -Math.sin(d), z: -Math.cos(d) });
  const out = newCcip();
  const mv = GAU8.muzzleVelocity;
  if (!computeCcip(FLAT_ENV, pos.x + m.x, pos.y + m.y, pos.z + m.z, vel.x + mv * dir.x, vel.y + mv * dir.y, vel.z + mv * dir.z, GAU8.dragK, out, { maxRangeM: 8000, maxTimeS: 8 })) return 1e4;
  return -out.z; // target at z = 0, the aircraft comes from +z
}

/** Pitch that puts the pipper on the target (secant iterations from a guess). */
function aim(pos: Vec3, vel: Vec3, guess: number): number {
  let a = guess, b = guess - 0.5;
  let ea = pipperError(pos, vel, a), eb = pipperError(pos, vel, b);
  for (let i = 0; i < 8 && Math.abs(ea) > 0.05; i++) {
    if (ea === eb) break;
    const c = a - (ea * (a - b)) / (ea - eb);
    b = a; eb = ea;
    a = Math.max(-80, Math.min(20, c));
    ea = pipperError(pos, vel, a);
  }
  return a;
}

function gunPass(p: Pass) {
  const world = createCombatWorld();
  const gn = createGunnery(world, FLAT_ENV, { seed: p.seed ?? 11 });
  gn.setGun(GAU8, 0);
  const events: CombatEvent[] = [];
  world.on((e) => events.push(e));
  const target = world.addTarget({ kind: p.kind, position: { x: 0, y: 0, z: 0 }, headingDeg: p.targetHeading, group: 'test' });
  const g = (p.diveDeg * Math.PI) / 180;
  const v = p.kt * KT_TO_MS;
  const vel = { x: 0, y: -Math.sin(g) * v, z: -Math.cos(g) * v };
  // Start 1 km before the open-fire range, on the dive line through the target.
  const start = p.openFireM + 1000;
  const pos = { x: 0, y: 1.1 + Math.sin(g) * start, z: Math.cos(g) * start };
  const dt = 1 / 60;
  // The trigger is held through the 0.55 s spin-up, then `burstS` of rounds.
  const hold = p.burstS + GAU8.spinUpS;
  let t = 0;
  let pitch = -p.diveDeg;
  let fireStart = -1;
  let firedPitch = 0;
  for (let i = 0; i < 60 * 20; i++) {
    const slant = Math.hypot(pos.x, pos.y - 1.1, pos.z);
    const firing = fireStart < 0 ? slant <= p.openFireM : t - fireStart < hold;
    if (firing && fireStart < 0) fireStart = t;
    const done = fireStart >= 0 && t - fireStart >= hold;
    // Track the pipper until the burst ends, then pull off (freeze the jet out of the way).
    if (!done) {
      pos.x += vel.x * dt; pos.y += vel.y * dt; pos.z += vel.z * dt;
      pitch = aim(pos, vel, pitch);
      if (firing) firedPitch = pitch;
    }
    const pose: GunPose = { position: { ...pos }, orientation: quatFromEuler(0, pitch, 0) };
    gn.adjustControls({ ...defaultControls(), trigger: firing && !done }, false, dt);
    t += dt;
    gn.update(pose, vel, dt, t);
    if (done && gn.pool.count === 0) break;
  }
  const fired = GAU8.rounds - world.status.rounds;
  const hitsOnTarget = events.filter((e) => e.type === 'impact' && e.targetId === target.id).length;
  const ricochets = events.filter((e) => e.type === 'impact' && e.ricochet).length;
  return { world, target, events, fired, hitsOnTarget, ricochets, firedPitch };
}

describe('functional: A-10 gun passes on armour', () => {
  it('30° dive from behind, 2 s burst at 4,000 ft: the T-72 is destroyed (thin rear/top armour)', () => {
    const r = gunPass({ kind: 'tank', targetHeading: 0, diveDeg: 30, kt: 300, openFireM: 1220, burstS: 2 });
    expect(r.fired).toBeGreaterThan(120);
    expect(r.fired).toBeLessThan(135);
    expect(r.hitsOnTarget).toBeGreaterThan(15);
    expect(r.target.alive).toBe(false);
    expect(r.events.filter((e) => e.type === 'destroyed')).toHaveLength(1);
    // The pilot held the nose a little above the flight path (gun line 2° down + gravity drop).
    expect(r.firedPitch).toBeGreaterThan(-30);
  });

  it('head-on, low-angle strafe (3°), the same 2 s burst into its front: the T-72 survives, barely scratched', () => {
    const r = gunPass({ kind: 'tank', targetHeading: 180, diveDeg: 3, kt: 300, openFireM: 1220, burstS: 2 });
    expect(r.fired).toBeGreaterThan(120);
    expect(r.hitsOnTarget).toBeGreaterThan(10);
    expect(r.ricochets).toBeGreaterThan(5);
    expect(r.target.alive).toBe(true);
    expect(r.target.health).toBeGreaterThan(r.target.maxHealth * 0.6);
  });

  it('results hold across dispersion seeds (top attack kills, frontal survives)', () => {
    for (const seed of [1, 2, 3]) {
      expect(gunPass({ kind: 'tank', targetHeading: 0, diveDeg: 30, kt: 300, openFireM: 1220, burstS: 2, seed }).target.alive).toBe(false);
      expect(gunPass({ kind: 'tank', targetHeading: 180, diveDeg: 3, kt: 300, openFireM: 1220, burstS: 2, seed }).target.alive).toBe(true);
    }
  });

  it('a half-second burst wrecks a truck (soft skin)', () => {
    const r = gunPass({ kind: 'truck', targetHeading: 90, diveDeg: 20, kt: 300, openFireM: 1220, burstS: 0.5 });
    expect(r.target.alive).toBe(false);
  });
});
