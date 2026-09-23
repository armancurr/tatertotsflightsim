/**
 * PURE scripted combat demos (debug/QA only — allocation is fine here): timelines of combat events
 * that `window.sim.combatFx.demo()` emits into the combat world, so the effects and the sound can be
 * seen and heard before (or without) the weapons and targets systems.
 *
 *   gunRunScript   a GAU-8 burst: gunStart, rounds fired at the gun's rate (spinning up), each landing
 *                  after its time of flight around an aim point that walks along the ground (the pilot
 *                  walks the burst through the target), with dispersion; rounds near the aim point
 *                  strike a (virtual) vehicle, some glancing off; gunStop.
 *   maverickScript an AGM-65 launch, its flight, the detonation on the target and the kill.
 */
import { A10_WEAPONS } from '../../config';
import type { SurfaceType, Vec3 } from '../../types';
import type { CombatEvent, TargetKind } from '../types';

export interface DemoEvent {
  /** Seconds after the demo starts. */
  at: number;
  event: CombatEvent;
}

export interface DemoScript {
  events: DemoEvent[];
  /** The gun fires over [from, to] s (the demo writes the weapons status for the sound), or null. */
  firing: [number, number] | null;
  /** Barrel spin-up / spin-down times of the gun, s. */
  spinUpS: number;
  spinDownS: number;
  duration: number;
}

export interface DemoEnv {
  groundHeight(x: number, z: number): number;
  surfaceAt(x: number, z: number): SurfaceType;
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sortEvents = (e: DemoEvent[]) => e.sort((a, b) => a.at - b.at);

export function gunRunScript(o: DemoEnv & {
  shooter: Vec3; target: Vec3; rateRps?: number; burstS?: number; seed?: number;
  /** Radius of the virtual vehicle at the aim point (0 = none), m. */
  targetRadiusM?: number; muzzleVelocity?: number; dispersionMrad?: number; spinUpS?: number; spinDownS?: number;
}): DemoScript {
  const gun = A10_WEAPONS.gun;
  const rate = o.rateRps ?? 65;
  const burst = o.burstS ?? 2;
  const v0 = o.muzzleVelocity ?? 1010;
  const disp = (o.dispersionMrad ?? 5) / 1000;
  const spinUp = o.spinUpS ?? gun?.spinUpS ?? 0.55;
  const spinDown = o.spinDownS ?? gun?.spinDownS ?? 0.7;
  const rTarget = o.targetRadiusM ?? 3.5;
  const rnd = rng(o.seed ?? 4242);
  const events: DemoEvent[] = [{ at: 0, event: { type: 'gunStart', time: 0 } }];
  // Walk direction: along the line of fire projected on the ground.
  let fx = o.target.x - o.shooter.x, fz = o.target.z - o.shooter.z;
  const fl = Math.hypot(fx, fz) || 1;
  fx /= fl; fz /= fl;
  const range = Math.hypot(o.target.x - o.shooter.x, o.target.y - o.shooter.y, o.target.z - o.shooter.z);
  // Mean speed over the flight (the round slows from v0).
  const tof = range / (v0 * 0.82);
  const walk = 45;
  // Rounds fire from the first turn of the barrels; the rate ramps with the spin.
  let t = 0;
  let n = 0;
  while (t < burst) {
    const spin = Math.min(1, t / spinUp);
    const r = rate * Math.max(0.2, spin);
    t += 1 / r;
    if (t >= burst) break;
    const u = t / burst - 0.5;
    const g1 = (rnd() + rnd() + rnd() - 1.5) * 1.4;
    const g2 = (rnd() + rnd() + rnd() - 1.5) * 1.4;
    const sd = disp * range;
    const ax = o.target.x + fx * walk * u - fz * g1 * sd + fx * g2 * sd * 2.5;
    const az = o.target.z + fz * walk * u + fx * g1 * sd + fz * g2 * sd * 2.5;
    const onTarget = rTarget > 0 && Math.hypot(ax - o.target.x, az - o.target.z) < rTarget;
    const g = o.groundHeight(ax, az);
    const y = onTarget ? o.target.y + 0.5 + 1.5 * rnd() : Number.isFinite(g) ? g : o.target.y;
    const surface = onTarget ? 'target' : o.surfaceAt(ax, az);
    events.push({
      at: t + tof * (0.97 + 0.06 * rnd()),
      event: { type: 'impact', time: t + tof, weapon: 'gun', point: { x: ax, y, z: az }, surface, targetId: onTarget ? 999 : null, ricochet: onTarget && rnd() < 0.25 },
    });
    n++;
  }
  events.push({ at: burst, event: { type: 'gunStop', time: burst, roundsFired: n } });
  sortEvents(events);
  return { events, firing: [0, burst], spinUpS: spinUp, spinDownS: spinDown, duration: burst + tof + 1 };
}

export function maverickScript(o: DemoEnv & { shooter: Vec3; velocity?: Vec3; target: Vec3; kind?: TargetKind; targetId?: number }): DemoScript {
  const v = o.velocity ?? { x: 0, y: 0, z: 0 };
  const launchPos = { x: o.shooter.x, y: o.shooter.y - 1.4, z: o.shooter.z };
  const range = Math.hypot(o.target.x - launchPos.x, o.target.y - launchPos.y, o.target.z - launchPos.z);
  // AGM-65: boosts to ~300 m/s above the launch speed, then coasts; mean ≈ launch speed + 230 m/s.
  const flight = range / (Math.hypot(v.x, v.y, v.z) + 230);
  const id = o.targetId ?? 998;
  const kind = o.kind ?? 'tank';
  const g = o.groundHeight(o.target.x, o.target.z);
  const y = (Number.isFinite(g) ? g : o.target.y) + 1;
  const events: DemoEvent[] = [
    { at: 0, event: { type: 'missileLaunch', time: 0, missileId: 1, station: 0, position: launchPos, velocity: { ...v } } },
    { at: flight, event: { type: 'detonation', time: flight, weapon: 'missile', position: { x: o.target.x, y, z: o.target.z }, targetId: id, blastRadiusM: 18, surface: o.surfaceAt(o.target.x, o.target.z) } },
    { at: flight, event: { type: 'destroyed', time: flight, weapon: 'missile', targetId: id, kind, position: { x: o.target.x, y: y - 1, z: o.target.z } } },
  ];
  return { events, firing: null, spinUpS: 0, spinDownS: 0, duration: flight + 3 };
}
