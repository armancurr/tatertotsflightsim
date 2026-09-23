/**
 * A debug driver for the weapons HUD (`window.sim.weaponsHudDemo(mode)`): until the gun and
 * targets systems are in, it seeds a platoon of vehicles at the target range and writes a plausible
 * weapons status every frame — the gun's CCIP point (a drag-free ballistic march from the muzzle to
 * the ground) and/or a Maverick track/lock on the vehicle nearest the nose — so the HUD, the
 * Maverick view and their tests can be exercised. Mode 'off' stops writing (the real systems win).
 */
import type { WeaponsConfig } from '../config';
import type { CombatWorld } from '../combat/world';
import type { Vec3 } from '../types';

export type WeaponsHudDemoMode = 'off' | 'gun' | 'track' | 'lock' | 'all';
export const DEMO_MODES: readonly WeaponsHudDemoMode[] = ['off', 'gun', 'track', 'lock', 'all'];

/** Where the demo range goes when the targets system has not set one (the app's `?spawn=range` fallback). */
export const DEMO_RANGE = { x: 0, z: -7000, headingDeg: 0 };

/** Put a range and a platoon there (T-72Bs, BMP-2s, a ZSU-23-4, trucks) if the world has no targets yet. */
export function seedDemoRange(world: CombatWorld, groundHeight: (x: number, z: number) => number): void {
  if (!world.range) world.range = { ...DEMO_RANGE };
  if (world.targets.length > 0) return;
  const r = world.range;
  const h = (r.headingDeg * Math.PI) / 180;
  // Along the approach axis (f) and across it (s).
  const fx = Math.sin(h);
  const fz = -Math.cos(h);
  const put = (kind: 'tank' | 'ifv' | 'apc' | 'truck' | 'aaa', along: number, across: number, facing: number, group: string) => {
    const x = r.x + fx * along - fz * across;
    const z = r.z + fz * along + fx * across;
    world.addTarget({ kind, position: { x, y: groundHeight(x, z), z }, headingDeg: facing, group });
  };
  // Tanks in line abreast facing the airport (the way you come in: front armour toward you).
  for (let i = 0; i < 4; i++) put('tank', 0, (i - 1.5) * 45, r.headingDeg + 180, 'platoon');
  put('ifv', 90, -60, r.headingDeg + 170, 'platoon');
  put('ifv', 95, 60, r.headingDeg + 190, 'platoon');
  put('aaa', 180, 0, r.headingDeg + 180, 'aaa-site');
  put('truck', 260, -30, r.headingDeg + 90, 'convoy');
  put('truck', 260, 0, r.headingDeg + 90, 'convoy');
  put('apc', 260, 30, r.headingDeg + 90, 'convoy');
}

export interface DemoPose {
  position: Vec3;
  /** Body → world. */
  orientation: { x: number; y: number; z: number; w: number };
  velocity: Vec3;
}

const G = 9.81;

function rot(q: DemoPose['orientation'], x: number, y: number, z: number): Vec3 {
  const tx = 2 * (q.y * z - q.z * y);
  const ty = 2 * (q.z * x - q.x * z);
  const tz = 2 * (q.x * y - q.y * x);
  return { x: x + q.w * tx + (q.y * tz - q.z * ty), y: y + q.w * ty + (q.z * tx - q.x * tz), z: z + q.w * tz + (q.x * ty - q.y * tx) };
}

/** Where rounds fired now would hit the ground (drag-free ballistics), and the slant range; null past 4 s of flight. */
export function demoCcip(pose: DemoPose, weapons: WeaponsConfig, groundHeight: (x: number, z: number) => number): { point: Vec3; range: number } | null {
  const gun = weapons.gun;
  if (!gun) return null;
  const m = rot(pose.orientation, gun.muzzle.x, gun.muzzle.y, gun.muzzle.z);
  const d = (gun.boresightDownDeg * Math.PI) / 180;
  const u = rot(pose.orientation, 0, -Math.sin(d), -Math.cos(d));
  const p0 = { x: pose.position.x + m.x, y: pose.position.y + m.y, z: pose.position.z + m.z };
  const v = { x: pose.velocity.x + u.x * gun.muzzleVelocity, y: pose.velocity.y + u.y * gun.muzzleVelocity, z: pose.velocity.z + u.z * gun.muzzleVelocity };
  let prev = { ...p0 };
  let prevAbove = p0.y - groundHeight(p0.x, p0.z);
  const dt = 0.02;
  for (let t = dt; t <= 4 + 1e-9; t += dt) {
    const p = { x: p0.x + v.x * t, y: p0.y + v.y * t - 0.5 * G * t * t, z: p0.z + v.z * t };
    const above = p.y - groundHeight(p.x, p.z);
    if (above <= 0) {
      const k = prevAbove / Math.max(1e-9, prevAbove - above);
      const point = { x: prev.x + (p.x - prev.x) * k, y: prev.y + (p.y - prev.y) * k, z: prev.z + (p.z - prev.z) * k };
      return { point, range: Math.hypot(point.x - pose.position.x, point.y - pose.position.y, point.z - pose.position.z) };
    }
    prev = p;
    prevAbove = above;
  }
  return null;
}

/** Write the demo's status for this frame. */
export function applyWeaponsHudDemo(
  world: CombatWorld, mode: WeaponsHudDemoMode, pose: DemoPose, weapons: WeaponsConfig | null,
  groundHeight: (x: number, z: number) => number, time: number,
): void {
  if (mode === 'off' || !weapons) return;
  const st = world.status;
  if ((mode === 'gun' || mode === 'all') && weapons.gun) {
    if (!st.hasGun) {
      st.hasGun = true;
      st.gunName = weapons.gun.name;
      st.rounds = weapons.gun.rounds;
      st.maxRounds = weapons.gun.rounds;
    }
    const c = demoCcip(pose, weapons, groundHeight);
    st.ccip = c ? c.point : null;
    st.ccipRangeM = c ? c.range : null;
  }
  if ((mode === 'track' || mode === 'lock' || mode === 'all') && weapons.missiles) {
    const msl = weapons.missiles;
    if (!st.hasMissiles) {
      st.hasMissiles = true;
      st.missileName = msl.name;
      st.maxMissiles = msl.stations.length;
      st.missiles = msl.stations.length;
      st.stores = msl.stations.map(() => true);
    }
    const nose = rot(pose.orientation, 0, 0, -1);
    const hits = world.targetsInCone(pose.position, nose, 45, msl.maxRangeM * 1.2);
    const pick = hits.length ? hits[0] : null;
    if (pick) {
      st.lock.state = mode === 'track' ? 'tracking' : 'locked';
      st.lock.targetId = pick.target.id;
      st.lock.progress = mode === 'track' ? (time * 0.5) % 1 : 1;
      st.lock.rangeM = pick.range;
      st.lock.inRange = pick.range >= msl.minRangeM && pick.range <= msl.maxRangeM;
    } else {
      st.lock.state = 'off';
      st.lock.targetId = null;
      st.lock.progress = 0;
      st.lock.rangeM = null;
      st.lock.inRange = false;
    }
  }
}
