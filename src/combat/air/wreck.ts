/**
 * The shoot-down (PURE): a destroyed aircraft falls. Jets either roll into a steepening spiral dive
 * (the nose follows the velocity) or go into a flat spin; a helicopter that lost its tail rotor
 * spins about the mast and settles in autorotation. Ballistic with quadratic drag toward a terminal
 * speed; a separated part (a wing panel, the fins, the tail rotor) tumbles down on its own with much
 * more drag. On the ground the wreck comes to rest (upright, inverted or on its side) where it hit.
 */
import { CONFIG } from '../../config';
import type { Quat } from '../../types';
import type { Rng } from '../rng';
import type { AirKind } from '../types';
import { attitudeQuat, G, type FlightState } from './flight';

const DEG = Math.PI / 180;
type WreckCfg = typeof CONFIG.combat.air.wreck;

export type PartName = 'wingL' | 'wingR' | 'tail' | 'tailRotor';
export type FallMode = 'roll' | 'flat' | 'helo';

export interface PartFall {
  which: PartName;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  q: Quat;
  /** Tumble rates about the body axes, rad/s. */
  wx: number;
  wy: number;
  wz: number;
  landed: boolean;
}

export interface Fall {
  kind: AirKind;
  mode: FallMode;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  heading: number;
  pitch: number;
  roll: number;
  rollRate: number;
  yawRate: number;
  q: Quat;
  t: number;
  landed: boolean;
  /** Came down in water (the wreck sinks). */
  water: boolean;
  part: PartFall | null;
  /** Rotor speed 0..1 (helicopters: it keeps windmilling in autorotation). */
  rotor: number;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Centroid of each separable part in the body frame (it tumbles about this; the renderer agrees). */
export const PART_PIVOT: Record<AirKind, Partial<Record<PartName, [number, number, number]>>> = {
  fighter: { wingL: [-3.95, 0.05, 1.6], wingR: [3.95, 0.05, 1.6], tail: [0, 1.35, 5.1] },
  attack: { wingL: [-4.1, 0.35, 0.6], wingR: [4.1, 0.35, 0.6], tail: [0, 1.4, 5.2] },
  helo: { tailRotor: [-0.3, 1.62, 8.4] },
};

/** How high the centre sits above the ground when the wreck rests, m. */
export const REST_HEIGHT: Record<AirKind, number> = { fighter: 0.95, attack: 1.05, helo: 1.25 };

export function startFall(kind: AirKind, f: FlightState, rng: Rng, cfg: WreckCfg = CONFIG.combat.air.wreck, rotor = 1): Fall {
  const mode: FallMode = kind === 'helo' ? 'helo' : rng.next() < cfg.spinChance ? 'flat' : 'roll';
  const fall: Fall = {
    kind, mode, x: f.x, y: f.y, z: f.z,
    vx: f.velocity.x + rng.sym(4), vy: f.velocity.y + rng.sym(3), vz: f.velocity.z + rng.sym(4),
    heading: f.heading, pitch: f.pitch, roll: f.bank,
    rollRate: (rng.next() < 0.5 ? -1 : 1) * (mode === 'roll' ? 1.6 + 2.2 * rng.next() : 0.4),
    yawRate: (rng.next() < 0.5 ? -1 : 1) * (mode === 'flat' ? 1.4 + 1.2 * rng.next() : mode === 'helo' ? 0.3 : 0.05),
    q: { ...f.orientation }, t: 0, landed: false, water: false, part: null, rotor,
  };
  // A part lets go: a wing panel or the fins (jets, sometimes), the tail rotor (helicopters, always).
  let which: PartName | null = null;
  if (kind === 'helo') which = 'tailRotor';
  else if (rng.next() < cfg.partChance) {
    const u = rng.next();
    which = u < 0.4 ? 'wingL' : u < 0.8 ? 'wingR' : 'tail';
  }
  if (which) {
    const side = which === 'wingL' ? -1 : which === 'wingR' ? 1 : 0;
    // Thrown out sideways (and up) relative to the aircraft.
    const ch = Math.cos(f.heading), sh = Math.sin(f.heading);
    const rx = ch, rz = sh; // right of the heading
    const kick = 6 + 6 * rng.next();
    // starts where it is on the airframe: CG + R·pivot
    const pv = PART_PIVOT[kind][which] ?? [0, 0, 0];
    const q = f.orientation;
    const tx = 2 * (q.y * pv[2] - q.z * pv[1]), ty = 2 * (q.z * pv[0] - q.x * pv[2]), tz = 2 * (q.x * pv[1] - q.y * pv[0]);
    const ox = pv[0] + q.w * tx + (q.y * tz - q.z * ty), oy = pv[1] + q.w * ty + (q.z * tx - q.x * tz), oz = pv[2] + q.w * tz + (q.x * ty - q.y * tx);
    fall.part = {
      which, x: f.x + ox, y: f.y + oy, z: f.z + oz,
      vx: f.velocity.x + rx * side * kick + rng.sym(3), vy: f.velocity.y + 4 + 4 * rng.next(), vz: f.velocity.z + rz * side * kick + rng.sym(3),
      q: { ...f.orientation }, wx: rng.sym(6), wy: rng.sym(4), wz: rng.sym(8), landed: false,
    };
  }
  return fall;
}

/** q ← q ⊗ exp(ω·dt/2) (body rates). */
function integrateQuat(q: Quat, wx: number, wy: number, wz: number, dt: number): void {
  const ax = wx * dt * 0.5, ay = wy * dt * 0.5, az = wz * dt * 0.5;
  const a = Math.hypot(ax, ay, az);
  if (a < 1e-12) return;
  const s = Math.sin(a) / a;
  const bx = ax * s, by = ay * s, bz = az * s, bw = Math.cos(a);
  const x = q.w * bx + q.x * bw + q.y * bz - q.z * by;
  const y = q.w * by - q.x * bz + q.y * bw + q.z * bx;
  const z = q.w * bz + q.x * by - q.y * bx + q.z * bw;
  const w = q.w * bw - q.x * bx - q.y * by - q.z * bz;
  const n = Math.hypot(x, y, z, w) || 1;
  q.x = x / n;
  q.y = y / n;
  q.z = z / n;
  q.w = w / n;
}

function stepPart(p: PartFall, dt: number, ground: (x: number, z: number) => number, cfg: WreckCfg): void {
  if (p.landed) return;
  const k = G / (cfg.partTerminalMs * cfg.partTerminalMs);
  const v = Math.hypot(p.vx, p.vy, p.vz);
  p.vx -= k * v * p.vx * dt;
  p.vy -= (G + k * v * p.vy) * dt;
  p.vz -= k * v * p.vz * dt;
  p.x += p.vx * dt;
  p.y += p.vy * dt;
  p.z += p.vz * dt;
  integrateQuat(p.q, p.wx, p.wy, p.wz, dt);
  const g = ground(p.x, p.z);
  if (p.y <= g + 0.4) {
    p.y = g + 0.4;
    p.landed = true;
    p.vx = p.vy = p.vz = 0;
    // lie flat-ish: keep the heading, drop the tumble
    const yaw = Math.atan2(2 * (p.q.w * p.q.y + p.q.x * p.q.z), 1 - 2 * (p.q.y * p.q.y + p.q.x * p.q.x));
    attitudeQuat(p.q, -yaw, 0, 0);
  }
}

/**
 * Advance the fall. Returns true on the frame it hits the ground (or water). `water(x, z)` = water
 * surface height or null.
 */
export function stepFall(f: Fall, dtIn: number, ground: (x: number, z: number) => number, water: ((x: number, z: number) => number | null) | null, rng: Rng, cfg: WreckCfg = CONFIG.combat.air.wreck): boolean {
  const dt = Number.isFinite(dtIn) && dtIn > 0 ? Math.min(dtIn, 0.1) : 0;
  if (f.part) stepPart(f.part, dt, ground, cfg);
  if (f.landed || dt === 0) return false;
  f.t += dt;
  const vh = Math.hypot(f.vx, f.vz);
  if (f.mode === 'helo') {
    // Autorotation: the descent settles at heloDescentMs, the forward speed bleeds off; spinning up.
    const rate = 1 - Math.exp(-0.7 * dt);
    f.vy += (-cfg.heloDescentMs - f.vy) * rate;
    const keep = Math.exp(-0.35 * dt);
    f.vx *= keep;
    f.vz *= keep;
    f.yawRate = Math.sign(f.yawRate || 1) * Math.min(3.6, Math.abs(f.yawRate) + 1.6 * dt);
    f.heading += f.yawRate * dt;
    f.pitch = -0.08 + 0.1 * Math.sin(f.t * 1.7);
    f.roll = 0.12 * Math.sin(f.t * 2.3 + 1);
    f.rotor = Math.max(0.55, f.rotor - 0.1 * dt);
  } else if (f.mode === 'flat') {
    // Flat spin: little forward speed, a fast yaw, dropping at ~half the dive's terminal speed.
    const vt = cfg.terminalMs * 0.55;
    const kv = G / (vt * vt);
    f.vy -= (G - kv * f.vy * f.vy * (f.vy < 0 ? 1 : -1)) * dt;
    const keep = Math.exp(-0.5 * dt);
    f.vx *= keep;
    f.vz *= keep;
    f.yawRate = Math.sign(f.yawRate) * Math.min(3.2, Math.abs(f.yawRate) + 0.8 * dt);
    f.heading += f.yawRate * dt;
    f.pitch += (-22 * DEG - f.pitch) * (1 - Math.exp(-1.2 * dt));
    f.roll = 0.2 * Math.sin(f.t * 1.3);
  } else {
    // Rolling spiral dive: ballistic with drag, the nose following the velocity.
    const k = G / (cfg.terminalMs * cfg.terminalMs);
    const v = Math.hypot(f.vx, f.vy, f.vz);
    f.vx -= k * v * f.vx * dt;
    f.vy -= (G + k * v * f.vy) * dt;
    f.vz -= k * v * f.vz * dt;
    const gamma = Math.atan2(f.vy, Math.max(1e-3, vh));
    f.pitch += (gamma - f.pitch) * (1 - Math.exp(-1.5 * dt));
    if (vh > 5) {
      const hv = Math.atan2(f.vx, -f.vz);
      let d = hv - f.heading;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      f.heading += d * (1 - Math.exp(-1.0 * dt));
    }
    f.rollRate = Math.sign(f.rollRate) * Math.min(4.5, Math.abs(f.rollRate) + 0.6 * dt);
    f.roll += f.rollRate * dt;
  }
  f.x += f.vx * dt;
  f.y += f.vy * dt;
  f.z += f.vz * dt;
  f.pitch = clamp(f.pitch, -89 * DEG, 60 * DEG);
  attitudeQuat(f.q, f.heading, f.pitch, f.roll);

  const g = ground(f.x, f.z);
  const w = water ? water(f.x, f.z) : null;
  const surface = w !== null && w > g ? w : g;
  if (f.y <= surface + REST_HEIGHT[f.kind] * 0.8) {
    f.landed = true;
    f.water = w !== null && w > g;
    f.y = f.water ? w! : g + REST_HEIGHT[f.kind];
    f.vx = f.vy = f.vz = 0;
    // Rest pose: upright or inverted jets (a small tilt), a helicopter often on its side.
    let roll: number;
    if (f.kind === 'helo') roll = rng.next() < 0.6 ? (rng.next() < 0.5 ? -1 : 1) * (70 + 25 * rng.next()) * DEG : rng.sym(12) * DEG;
    else roll = rng.next() < 0.25 ? Math.PI + rng.sym(10) * DEG : rng.sym(10) * DEG;
    f.roll = roll;
    f.pitch = rng.sym(5) * DEG;
    if (f.kind === 'helo' && Math.abs(roll) > 1) f.y = g + 1.6;
    f.rotor = 0;
    attitudeQuat(f.q, f.heading, f.pitch, f.roll);
    return true;
  }
  return false;
}
