/**
 * PURE naval shells in flight (no three.js): a fixed pool of 16-inch shells flown with the naval
 * ballistics (src/combat/naval.ts `stepShell`: gravity + drag with the ISA density), each frame's
 * flight segment tested against the combat world's hulls (`world.raycast`) and the ground / water
 * (`segmentSurfaceHit`, only once the shell is low enough to matter). An impact bursts:
 *
 *   on a target / the land   `world.applyBlast(point, blastRadiusM, damage)` — a direct hit is the
 *                            blast at distance 0 (full damage, no armour factor: weapon 'shell')
 *   on the water             the same blast × `waterBlastFactor` (the sea soaks it)
 *
 * and emits `detonation` { weapon: 'shell', surface, blastRadiusM } for the effects and the sound.
 * Each shell also carries its predicted fall of shot (simulated at firing, dispersion included) for
 * the HUD's splash markers. Allocation-free per frame except the events.
 */
import type { NavalGunsConfig } from '../config';
import type { Environment, SurfaceType, Vec3 } from '../types';
import type { CombatWorld } from './world';
import type { ImpactSurface } from './types';
import { flyToHeight, newShellFlight, newShellState, stepShell, type ShellState } from './naval';
import { segmentSurfaceHit, surfaceHeight, type SurfaceHit } from './ground';

export interface ShellImpact {
  x: number;
  y: number;
  z: number;
  surface: ImpactSurface;
  targetId: number | null;
  time: number;
  /** Speed at the impact (m/s), unit velocity direction. */
  speed: number;
  dx: number;
  dy: number;
  dz: number;
  turret: number;
  gun: number;
  /** Ids the burst destroyed. */
  destroyed: number[];
}

export interface Shell extends ShellState {
  live: boolean;
  age: number;
  turret: number;
  gun: number;
  /** Predicted impact (world) and its time of flight, s. */
  px: number;
  py: number;
  pz: number;
  ptof: number;
  /** Position at the start of the last step (tracer tail). */
  ox: number;
  oy: number;
  oz: number;
}

export interface NavalShells {
  readonly shells: readonly Shell[];
  readonly count: number;
  /** Launch a shell from `pos` with world velocity `vel` (the ship's velocity included). Returns the slot or −1 when full. */
  fire(guns: NavalGunsConfig, pos: Vec3, vel: Vec3, time: number, turret: number, gun: number): number;
  /** Fly every shell by dt; impacts are applied to the world and reported through `onImpact`. */
  update(guns: NavalGunsConfig | null, dt: number, time: number, onImpact?: (i: ShellImpact) => void): void;
  clear(): void;
  stats(): { inFlight: number; fired: number; impacts: number; hits: number };
}

/** Terrain / water tests start once a shell is this far above the surface below it, m (plus its step length). */
const SURFACE_MARGIN = 60;
/** The highest terrain anywhere (conservative), m: shells above it skip the surface query. */
const TERRAIN_TOP = 3200;

export function createNavalShells(world: CombatWorld, env: Environment, capacity = 96): NavalShells {
  const shells: Shell[] = Array.from({ length: Math.max(1, capacity) }, () => ({
    ...newShellState(), live: false, age: 0, turret: 0, gun: 0, px: 0, py: 0, pz: 0, ptof: 0, ox: 0, oy: 0, oz: 0,
  }));
  let count = 0;
  let fired = 0;
  let impacts = 0;
  let hits = 0;
  const HIT: SurfaceHit = { x: 0, y: 0, z: 0, water: false };
  const P0 = { x: 0, y: 0, z: 0 };
  const P1 = { x: 0, y: 0, z: 0 };
  const pred = newShellState();
  const predF = newShellFlight();

  const burst = (guns: NavalGunsConfig, s: Shell, x: number, y: number, z: number, surface: ImpactSurface, targetId: number | null, time: number, onImpact?: (i: ShellImpact) => void) => {
    const sp = Math.hypot(s.vx, s.vy, s.vz) || 1;
    const dmg = surface === 'water' ? guns.damage * guns.waterBlastFactor : guns.damage;
    const destroyed = world.applyBlast({ x, y, z }, guns.blastRadiusM, dmg, 'shell', time);
    impacts++;
    if (targetId !== null) hits++;
    world.emit({ type: 'detonation', time, weapon: 'shell', position: { x, y, z }, targetId, blastRadiusM: guns.blastRadiusM, surface });
    onImpact?.({ x, y, z, surface, targetId, time, speed: sp, dx: s.vx / sp, dy: s.vy / sp, dz: s.vz / sp, turret: s.turret, gun: s.gun, destroyed });
  };

  return {
    shells,
    get count() {
      return count;
    },

    fire(guns, pos, vel, time, turret, gun) {
      if (!Number.isFinite(pos.x + pos.y + pos.z + vel.x + vel.y + vel.z)) return -1;
      const slot = shells.findIndex((s) => !s.live);
      if (slot < 0) return -1;
      const s = shells[slot];
      s.live = true;
      s.age = 0;
      s.x = s.ox = pos.x;
      s.y = s.oy = pos.y;
      s.z = s.oz = pos.z;
      s.vx = vel.x;
      s.vy = vel.y;
      s.vz = vel.z;
      s.turret = turret;
      s.gun = gun;
      // predicted fall of shot: fly a copy down to the sea surface / ground height below the aim
      pred.x = pos.x; pred.y = pos.y; pred.z = pos.z;
      pred.vx = vel.x; pred.vy = vel.y; pred.vz = vel.z;
      flyToHeight(pred, guns.dragK, 0, guns.maxFlightS, predF);
      const gy = surfaceHeight(env, predF.x, predF.z);
      if (Math.abs(gy) > 0.5 && predF.landed) {
        pred.x = pos.x; pred.y = pos.y; pred.z = pos.z;
        pred.vx = vel.x; pred.vy = vel.y; pred.vz = vel.z;
        flyToHeight(pred, guns.dragK, gy, guns.maxFlightS, predF);
      }
      s.px = predF.x;
      s.py = predF.y;
      s.pz = predF.z;
      s.ptof = predF.tof;
      count++;
      fired++;
      world.stats.roundsFired++;
      return slot;
    },

    update(guns, dtIn, time, onImpact) {
      const dt = Number.isFinite(dtIn) && dtIn > 0 ? Math.min(dtIn, 0.25) : 0;
      if (!(dt > 0) || count === 0 || !guns) return;
      for (const s of shells) {
        if (!s.live) continue;
        s.ox = s.x;
        s.oy = s.y;
        s.oz = s.z;
        stepShell(s, dt, guns.dragK);
        s.age += dt;
        P0.x = s.ox; P0.y = s.oy; P0.z = s.oz;
        P1.x = s.x; P1.y = s.y; P1.z = s.z;
        if (!Number.isFinite(s.x + s.y + s.z)) {
          s.live = false;
          count--;
          continue;
        }
        // hulls first (a raycast is cheap: a bounding-sphere reject per target)
        const rh = world.raycast(P0, P1);
        // then the ground / water, when the shell is low enough to reach it this step
        const seg = Math.hypot(s.x - s.ox, s.y - s.oy, s.z - s.oz);
        let f = -1;
        if (Math.min(s.y, s.oy) < TERRAIN_TOP + SURFACE_MARGIN && Math.min(s.y, s.oy) - surfaceHeight(env, s.x, s.z) < seg + SURFACE_MARGIN) {
          f = segmentSurfaceHit(env, s.ox, s.oy, s.oz, s.x, s.y, s.z, HIT, 10);
        }
        const hitD = rh ? rh.distance : Infinity;
        const surfD = f >= 0 ? f * seg : Infinity;
        if (rh && hitD <= surfD) {
          s.live = false;
          count--;
          burst(guns, s, rh.point.x, rh.point.y, rh.point.z, 'target', rh.target.id, time, onImpact);
          continue;
        }
        if (f >= 0) {
          s.live = false;
          count--;
          const surface: SurfaceType | 'water' = HIT.water ? 'water' : env.surfaceAt(HIT.x, HIT.z);
          burst(guns, s, HIT.x, HIT.y, HIT.z, surface, null, time, onImpact);
          continue;
        }
        if (s.age > Math.max(guns.maxFlightS, 10) * 1.5 || s.y < -500) {
          s.live = false;
          count--;
        }
      }
    },

    clear() {
      for (const s of shells) s.live = false;
      count = 0;
    },

    stats: () => ({ inFlight: count, fired, impacts, hits }),
  };
}
