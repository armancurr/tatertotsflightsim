/**
 * What the naval-guns system shares with the naval HUD and sound systems, per scene (a WeakMap like
 * the fx hub): the battery, the aim, each turret's solution, the shells in flight and the recent
 * fall of shot. Plain data, written by src/game/systems/navalGuns.ts every frame.
 */
import type { NavalGunsConfig } from '../config';
import type { Vec3 } from '../types';
import type { Battery } from './navalBattery';
import type { FireSolution } from './naval';
import type { NavalShells } from './navalShells';

export type AimSource = 'pointer' | 'view' | 'target' | 'script';

export interface NavalAim {
  valid: boolean;
  source: AimSource;
  /** The point aimed at (world). */
  point: Vec3;
  /** A locked combat target, or null. */
  targetId: number | null;
  /** Ship → aim: horizontal range (m), true bearing (deg) and time of flight of the reference turret's solution (s). */
  rangeM: number;
  bearingDeg: number;
  tofS: number;
  /** Beyond the guns' reach / closer than the lowest elevation reaches. */
  tooFar: boolean;
  tooClose: boolean;
}

export interface FallOfShot {
  x: number;
  y: number;
  z: number;
  /** Time of the impact (the system clock, s). */
  t: number;
  hit: boolean;
}

export interface NavalShared {
  /** The battery of the vehicle driven now (null = none: everything naval is inert). */
  guns: NavalGunsConfig | null;
  battery: Battery | null;
  solutions: FireSolution[];
  aim: NavalAim;
  shells: NavalShells | null;
  /** The last impacts, newest last (a ring of ≤ 36). */
  falls: FallOfShot[];
  /** A short HUD message ("NO GUNS BEAR", "SALVO", …) and until when it shows (s). */
  message: { text: string; until: number; level: 'info' | 'warn' | 'good' };
  /** The system clock (s). */
  time: number;
  /** A stand-in (dev harness) is drawing the turrets. */
  harness: boolean;
  /** The rangefinder zoom now (1 = off). */
  zoom: number;
}

const hubs = new WeakMap<object, NavalShared>();

export function navalHub(scene: object): NavalShared {
  let h = hubs.get(scene);
  if (!h) {
    h = {
      guns: null,
      battery: null,
      solutions: [],
      aim: { valid: false, source: 'view', point: { x: 0, y: 0, z: 0 }, targetId: null, rangeM: 0, bearingDeg: 0, tofS: 0, tooFar: false, tooClose: false },
      shells: null,
      falls: [],
      message: { text: '', until: 0, level: 'info' },
      time: 0,
      harness: false,
      zoom: 1,
    };
    hubs.set(scene, h);
  }
  return h;
}
