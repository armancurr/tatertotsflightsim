/**
 * Ground interaction: spring-damper struts at the three wheels, tyre friction
 * (rolling resistance by surface, brakes, cornering, nosewheel steering), the
 * tail skid, and collision detection of the structural points against
 * terrain, water and obstacles. Pure.
 */
import { CONFIG, type Config, MS_TO_KT } from '../config';
import type { Environment, Quat, SurfaceType, Vec3 } from '../types';
import { clamp } from '../math/vec3';
import { bodyToWorld } from './frames';

const UP: Vec3 = Object.freeze({ x: 0, y: 1, z: 0 });
const DEG = Math.PI / 180;

export interface GroundInput {
  position: Vec3;
  velocity: Vec3;
  orientation: Quat;
  /** Angular velocity in the WORLD frame. */
  omegaWorld: Vec3;
  gearPos: number;
  brake: number;
  parkingBrake: boolean;
  rudder: number;
  engineRunning: boolean;
}

export interface GroundOutput {
  /** Total contact force, world frame, N. */
  force: Vec3;
  /** Torque about the CG, world frame, N·m. */
  torque: Vec3;
  wheelContact: [boolean, boolean, boolean];
  wheelCompression: [number, number, number];
  /** Any wheel touching. */
  onGround: boolean;
  /** Tailcone skidding on the surface (gentle scrape). */
  tailScrape: boolean;
  /** Set when this contact destroys the aircraft. */
  crashReason: string | null;
}

/** Map a structural point that touched the surface to a crash reason. */
function crashReasonFor(name: string, impactMs: number, gearDown: boolean, cfg: Config): string {
  if (impactMs > cfg.aircraft.landing.terrainImpactMs) return 'Hit terrain';
  const belly = name.startsWith('belly');
  if (!gearDown && (belly || name === 'propTip' || name === 'cowling')) return 'Gear-up landing';
  switch (name) {
    case 'propTip':
    case 'cowling':
      return 'Prop strike';
    case 'leftWingtip':
    case 'rightWingtip':
      return 'Wingtip strike';
    case 'tailcone':
    case 'tailBumper':
    case 'leftStab':
    case 'rightStab':
      return 'Tail strike';
    case 'leftInboardEngine':
    case 'rightInboardEngine':
    case 'leftOutboardEngine':
    case 'rightOutboardEngine':
      return 'Engine pod strike';
    case 'finTop':
    case 'cabinRoof':
      return 'Flipped over';
    default:
      return 'Hit terrain';
  }
}

function noContact(): GroundOutput {
  return {
    force: { x: 0, y: 0, z: 0 },
    torque: { x: 0, y: 0, z: 0 },
    wheelContact: [false, false, false],
    wheelCompression: [0, 0, 0],
    onGround: false,
    tailScrape: false,
    crashReason: null,
  };
}

/** Surface under a point: the higher of terrain and water. */
function surfaceY(env: Environment, x: number, z: number): { ground: number; water: number | null; top: number; wet: boolean } {
  const ground = env.groundHeight(x, z);
  const water = env.waterLevel(x, z);
  const wet = water !== null && water > ground;
  return { ground, water, top: wet ? (water as number) : ground, wet };
}

/**
 * Contact forces and collisions for the current pose. Wheels only exist while
 * the gear is down and locked (gearPos ≥ 0.999).
 */
export function groundContacts(inp: GroundInput, env: Environment, cfg: Config = CONFIG): GroundOutput {
  const ac = cfg.aircraft;
  const geo = ac.geometry;
  const gd = ac.ground;
  const land = ac.landing;
  const { position: pos, velocity: vel, orientation: q, omegaWorld: w } = inp;

  const cg = surfaceY(env, pos.x, pos.z);
  const aglTerrain = pos.y - cg.ground;
  const out = noContact();

  // Obstacles (trees, buildings, towers): any point inside one is a crash.
  if (env.obstacleTop && aglTerrain < land.obstacleCheckAglM) {
    const pts = geo.structuralPoints;
    for (let i = -3; i < pts.length; i++) {
      const b = i === -3 ? geo.noseWheel : i === -2 ? geo.leftMainWheel : i === -1 ? geo.rightMainWheel : pts[i];
      const r = bodyToWorld(q, b);
      const px = pos.x + r.x;
      const pz = pos.z + r.z;
      if (pos.y + r.y < env.obstacleTop(px, pz)) {
        out.crashReason = 'Hit an obstacle';
        return out;
      }
    }
  }

  // Broad phase: nothing can touch the surface from this high.
  if (pos.y - cg.top > land.nearGroundAglM) return out;

  const gearDown = inp.gearPos >= 0.999;
  let fx = 0, fy = 0, fz = 0, tx = 0, ty = 0, tz = 0;
  const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);
  const ditchOk = speed * MS_TO_KT <= land.ditchSpeedKt && !inp.engineRunning;

  const addForce = (r: Vec3, Fx: number, Fy: number, Fz: number) => {
    fx += Fx; fy += Fy; fz += Fz;
    tx += r.y * Fz - r.z * Fy;
    ty += r.z * Fx - r.x * Fz;
    tz += r.x * Fy - r.y * Fx;
  };

  // ── Wheels ────────────────────────────────────────────────────────────────
  if (gearDown) {
    const gs = Math.hypot(vel.x, vel.z);
    const steerFrac = Math.max(gd.steeringMinFraction, clamp(1 - gs / gd.steeringFadeSpeed, 0, 1));
    const steer = clamp(inp.rudder, -1, 1) * ac.surfaces.nosewheelSteerMaxDeg * DEG * steerFrac;
    const wheels = [geo.noseWheel, geo.leftMainWheel, geo.rightMainWheel];
    const brake = Math.max(clamp(inp.brake, 0, 1), inp.parkingBrake ? 1 : 0);
    for (let i = 0; i < 3; i++) {
      const r = bodyToWorld(q, wheels[i]);
      const px = pos.x + r.x;
      const py = pos.y + r.y;
      const pz = pos.z + r.z;
      const su = surfaceY(env, px, pz);
      if (su.wet) {
        if (py < su.top && !ditchOk) {
          out.crashReason = 'Ditched in water';
          return out;
        }
        continue;
      }
      const n = env.groundNormal ? env.groundNormal(px, pz) : UP;
      const d = (su.ground - py) * n.y; // penetration along the surface normal
      if (d <= 0) continue;
      out.wheelContact[i] = true;
      out.wheelCompression[i] = d;
      // Velocity of the contact point: v + ω × r.
      const vx = vel.x + (w.y * r.z - w.z * r.y);
      const vy = vel.y + (w.z * r.x - w.x * r.z);
      const vz = vel.z + (w.x * r.y - w.y * r.x);
      const vn = vx * n.x + vy * n.y + vz * n.z;
      const k = i === 0 ? gd.springNose : gd.springMain;
      // Oleo struts damp extension (rebound) much harder than compression: no spring "kick".
      const c = (i === 0 ? gd.damperNose : gd.damperMain) * (vn > 0 ? gd.reboundDampingFactor : 1);
      let Fn = k * d - c * vn;
      if (d > geo.strutTravel) Fn += k * gd.bottomOutStiffness * (d - geo.strutTravel) - c * vn;
      if (Fn <= 0) continue;
      // Wheel rolling direction (nosewheel steered), projected onto the ground plane.
      const fb = i === 0 ? { x: Math.sin(steer), y: 0, z: -Math.cos(steer) } : { x: 0, y: 0, z: -1 };
      const fw = bodyToWorld(q, fb);
      const fdn = fw.x * n.x + fw.y * n.y + fw.z * n.z;
      let ex = fw.x - n.x * fdn, ey = fw.y - n.y * fdn, ez = fw.z - n.z * fdn;
      const el = Math.sqrt(ex * ex + ey * ey + ez * ez);
      if (el < 1e-6) continue; // wheel pointing straight into the ground: no rolling direction
      ex /= el; ey /= el; ez /= el;
      // Lateral = forward × normal (points to the wheel's right).
      const lx = ey * n.z - ez * n.y;
      const ly = ez * n.x - ex * n.z;
      const lz = ex * n.y - ey * n.x;
      const vf = vx * ex + vy * ey + vz * ez;
      const vl = vx * lx + vy * ly + vz * lz;
      const surface: SurfaceType = env.surfaceAt(px, pz);
      const muRoll = (gd.rollingFriction as Record<string, number>)[surface] ?? 0.05;
      const muLong = muRoll + (i > 0 ? brake * gd.brakeFriction : 0);
      let Ff = -muLong * Fn * Math.tanh(vf / gd.longitudinalSmoothing);
      let Fl = -gd.lateralFriction * Fn * Math.tanh(vl / gd.frictionSmoothing);
      // Friction circle.
      const lim = Math.max(gd.lateralFriction, muLong) * Fn;
      const mag = Math.sqrt(Ff * Ff + Fl * Fl);
      if (mag > lim) {
        Ff *= lim / mag;
        Fl *= lim / mag;
      }
      addForce(r, n.x * Fn + ex * Ff + lx * Fl, n.y * Fn + ey * Ff + ly * Fl, n.z * Fn + ez * Ff + lz * Fl);
    }
    out.onGround = out.wheelContact[0] || out.wheelContact[1] || out.wheelContact[2];
  }

  // ── Structural points ─────────────────────────────────────────────────────
  for (const sp of geo.structuralPoints) {
    const belly = sp.name.startsWith('belly');
    if (belly && gearDown) continue; // with the gear down the struts keep the belly clear
    const r = bodyToWorld(q, sp);
    const px = pos.x + r.x;
    const py = pos.y + r.y;
    const pz = pos.z + r.z;
    const su = surfaceY(env, px, pz);
    if (py >= su.top) continue;
    if (su.wet) {
      if (ditchOk) continue;
      out.crashReason = 'Ditched in water';
      return out;
    }
    const n = env.groundNormal ? env.groundNormal(px, pz) : UP;
    const vx = vel.x + (w.y * r.z - w.z * r.y);
    const vy = vel.y + (w.z * r.x - w.x * r.z);
    const vz = vel.z + (w.x * r.y - w.y * r.x);
    const vn = vx * n.x + vy * n.y + vz * n.z;
    const impact = -vn;
    // The 747's tail bumper (aft-body skid point) scrapes like a tailcone.
    const tailGroup = sp.name === 'tailcone' || sp.name === 'tailBumper' || sp.name === 'leftStab' || sp.name === 'rightStab';
    if (tailGroup && impact <= land.scrapeSpeedMs) {
      // Gentle tail scrape: the tailcone skids on the surface.
      const d = (su.ground - py) * n.y;
      const Fn = Math.max(0, gd.springMain * d - gd.damperMain * vn);
      let tvx = vx - n.x * vn, tvy = vy - n.y * vn, tvz = vz - n.z * vn;
      const tv = Math.sqrt(tvx * tvx + tvy * tvy + tvz * tvz);
      const ff = tv > 1e-9 ? (-gd.tailSkidFriction * Fn * Math.tanh(tv / gd.frictionSmoothing)) / tv : 0;
      addForce(r, n.x * Fn + tvx * ff, n.y * Fn + tvy * ff, n.z * Fn + tvz * ff);
      out.tailScrape = true;
      continue;
    }
    // Deep below the surface = flew into it this step; on a slope without a supplied normal, measure
    // the impact against the terrain gradient.
    const depth = su.ground - py;
    let hit = impact;
    if (!env.groundNormal) {
      const e = 0.5;
      const gx = (env.groundHeight(px + e, pz) - env.groundHeight(px - e, pz)) / (2 * e);
      const gz = (env.groundHeight(px, pz + e) - env.groundHeight(px, pz - e)) / (2 * e);
      const gl = Math.sqrt(gx * gx + 1 + gz * gz);
      hit = -(vx * -gx + vy + vz * -gz) / gl;
    }
    out.crashReason = depth > land.terrainPenetrationM ? 'Hit terrain' : crashReasonFor(sp.name, hit, gearDown, cfg);
    return out;
  }

  out.force = { x: fx, y: fy, z: fz };
  out.torque = { x: tx, y: ty, z: tz };
  return out;
}
