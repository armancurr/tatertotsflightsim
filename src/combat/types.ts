/**
 * Shared combat contracts (no three.js): the ground targets, hits, the event stream and the
 * weapons status. The combat world (src/combat/world.ts) holds them; the systems talk through it:
 *
 *   weapons system  → fires rounds/missiles, raycasts, applies hits, writes `status`, emits events
 *   targets system  → adds/moves/revives the vehicles, draws them (and their wrecks)
 *   fx / audio      → listen to the events (impacts, explosions, gun start/stop, launches)
 *   HUD             → reads `status` (ammo, CCIP, lock) and the targets
 *
 * World frame as everywhere (+X east, +Y up, +Z south). A target's hull box sits on the ground:
 * `position` is the centre of the hull's footprint at ground level; the box spans x ∈ ±width/2,
 * y ∈ [0, height], z ∈ ±length/2 in the hull frame, where −Z is the front (the way it faces).
 */
import type { Quat, SurfaceType, Vec3 } from '../types';

/** Ground vehicles (the range) and aircraft to shoot down (CONFIG.combat.targets[kind].air). */
export type GroundKind = 'tank' | 'ifv' | 'apc' | 'truck' | 'aaa';
export type AirKind = 'fighter' | 'attack' | 'helo';
/**
 * Floating targets at the naval gunnery range (src/combat/navalRange.ts): a raft with a radar-reflector
 * frame, a hulked freighter, a towed target sled. Like a ground vehicle their box stands on `position`,
 * which is the KEEL (the box spans keel … top, so it reaches below the waterline).
 */
export type SeaKind = 'raft' | 'hulk' | 'sled';
export type TargetKind = GroundKind | AirKind | SeaKind;
/** 'shell': a ship's gun shell (the naval guns, src/combat/navalShells.ts) — blast damage, no armour factor. */
export type WeaponKind = 'gun' | 'missile' | 'shell';
export type HullFace = 'front' | 'side' | 'rear' | 'top' | 'bottom';

export interface GroundTarget {
  readonly id: number;
  kind: TargetKind;
  /** Hull footprint centre at ground level, world m (the targets system moves it). */
  position: Vec3;
  /** The way the hull faces, deg clockwise from north. */
  headingDeg: number;
  /** World velocity, m/s (0 when parked). */
  velocity: Vec3;
  health: number;
  maxHealth: number;
  alive: boolean;
  /** Time of destruction (the caller's clock, s), or null. */
  destroyedAt: number | null;
  /** Free label: 'convoy', 'platoon', 'aaa-site'… */
  group: string;
  /**
   * Aircraft only: body → world rotation (three.js convention: −Z nose, +Y up, +X right wing).
   * `position` is then the centre of the box. Ground vehicles leave it undefined (yaw from headingDeg).
   */
  orientation?: Quat;
}

export interface NewTarget {
  kind: TargetKind;
  position: Vec3;
  headingDeg: number;
  group: string;
  velocity?: Vec3;
  orientation?: Quat;
}

export interface HitInfo {
  weapon: WeaponKind;
  /** Damage before armour. */
  damage: number;
  point: Vec3;
  /** Travel direction of the round / missile (unit, world). */
  direction: Vec3;
  /** The caller's clock, s. */
  time: number;
  /** Face that was struck (from `raycast`); derived from `direction` when absent. */
  face?: HullFace;
}

export interface RayHit {
  target: GroundTarget;
  /** Distance from the segment start, m. */
  distance: number;
  point: Vec3;
  face: HullFace;
}

export interface ConeHit {
  target: GroundTarget;
  /** Distance to the hull centre (at half height), m. */
  range: number;
  /** Angle off the cone axis, deg. */
  angleDeg: number;
}

export type ImpactSurface = SurfaceType | 'target';

export type CombatEvent =
  | { type: 'gunStart'; time: number }
  | { type: 'gunStop'; time: number; roundsFired: number }
  | { type: 'impact'; time: number; weapon: WeaponKind; point: Vec3; surface: ImpactSurface; targetId: number | null; ricochet?: boolean }
  | { type: 'hit'; time: number; weapon: WeaponKind; targetId: number; point: Vec3; damage: number; health: number; face: HullFace }
  | { type: 'destroyed'; time: number; weapon: WeaponKind; targetId: number; kind: TargetKind; position: Vec3 }
  | { type: 'missileLaunch'; time: number; missileId: number; station: number; position: Vec3; velocity: Vec3 }
  | { type: 'detonation'; time: number; weapon: WeaponKind; position: Vec3; targetId: number | null; blastRadiusM: number; surface: ImpactSurface }
  | { type: 'lock'; time: number; targetId: number }
  | { type: 'lockLost'; time: number; targetId: number | null }
  | { type: 'reload'; time: number }
  /** A ship's gun fired (naval guns): the muzzle (world), the bore direction (unit), turret / gun index, calibre. */
  | { type: 'navalFire'; time: number; turret: number; gun: number; position: Vec3; direction: Vec3; caliberMm: number };

export type CombatListener = (e: CombatEvent) => void;

export type LockState = 'off' | 'tracking' | 'locked';

/** Written by the weapons system every frame; read by the HUD, audio, app (visual state) and tests. */
export interface WeaponsStatus {
  hasGun: boolean;
  gunName: string;
  rounds: number;
  maxRounds: number;
  /** Barrel speed 0..1 (spins up on the trigger, down after). */
  gunSpin: number;
  /** Rounds are leaving the barrel this frame. */
  gunFiring: boolean;
  hasMissiles: boolean;
  missileName: string;
  missiles: number;
  maxMissiles: number;
  /** Per config station: a missile still hangs there. */
  stores: boolean[];
  /** Air-to-air missiles (Sidewinders), same shape as the Mavericks' fields. */
  hasAirMissiles: boolean;
  airMissileName: string;
  airMissiles: number;
  maxAirMissiles: number;
  airStores: boolean[];
  lock: {
    state: LockState;
    targetId: number | null;
    /** 0..1 toward LOCK while tracking. */
    progress: number;
    rangeM: number | null;
    /** The target is between the missile's min and max range. */
    inRange: boolean;
  };
  /** Gun CCIP: where rounds fired now would hit the ground (world), or null. */
  ccip: Vec3 | null;
  /** Slant range to the CCIP point, m. */
  ccipRangeM: number | null;
  missilesInFlight: number;
  /** Ships with turrets (CONFIG.weapons.naval.turrets order): written by the naval-gunnery system. Absent = none. */
  turrets?: TurretStatus[];
}

/** One ship's turret, live (drives the 3D model and the HUD). */
export interface TurretStatus {
  /** Train (deg, relative to the bow, + starboard) and gun elevation (deg). */
  trainDeg: number;
  elevDeg: number;
  /** Per gun: recoil 0..1 (1 = fully back, just fired) and muzzle flash 0..1. */
  recoil: number[];
  flash: number[];
  /** Per gun: loaded and ready to fire. */
  ready: boolean[];
}

export interface CombatStats {
  roundsFired: number;
  /** Gun rounds that struck a live target. */
  roundsHit: number;
  missilesFired: number;
  kills: number;
}

/** Where the target range is (set by the targets system; used for `?spawn=range` and the HUD). */
export interface RangeInfo {
  x: number;
  z: number;
  /** Heading to fly from the airport to the range, deg. */
  headingDeg: number;
}
