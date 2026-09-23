/**
 * The enemy pilots' behaviour (PURE): fly the assigned path (pure pursuit, the path's altitude and
 * speed; a wingman holds station a set distance behind and to the side of its leader on the same
 * path), stay clear of the terrain ahead, keep out of the airport circuit, keep away from the player
 * unless the player is chasing from behind, and — when locked, shot at or hit — break: a hard,
 * max-bank turn into the threat (away from the airport near it) with a salvo of flares, then rejoin
 * the path. Writes a FlightCommand for flight.ts each step.
 */
import { CONFIG } from '../../config';
import type { Rng } from '../rng';
import type { AirKind } from '../types';
import { turnRateFor, wrapPi, type FlightCommand, type FlightSpec, type FlightState } from './flight';
import { bearingTo, deltaS, nearestS, newPathSample, pursuitTurnRate, samplePath, type FlightPath } from './paths';

const DEG = Math.PI / 180;
export type AirConfig = typeof CONFIG.combat.air;
export type PilotMode = 'path' | 'break' | 'avoid';
export type ThreatKind = 'lock' | 'launch' | 'gun' | 'hit';

export interface PlayerInfo {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Unit nose direction (world). */
  fx: number;
  fy: number;
  fz: number;
}

export interface PilotEnv {
  time: number;
  ground(x: number, z: number): number;
  player: PlayerInfo | null;
}

export interface Pilot {
  kind: AirKind;
  spec: FlightSpec;
  flight: FlightState;
  path: FlightPath;
  /** Along-path position (m). */
  s: number;
  /** Station: metres to the right of the path, and behind the leader. */
  side: number;
  trail: number;
  leader: Pilot | null;
  mode: PilotMode;
  modeUntil: number;
  breakDir: number;
  /** No lock/gun-triggered break before this time. */
  cooldownUntil: number;
  flaresLeft: number;
  nextFlareAt: number;
  /** Last reason it broke, for QA. */
  lastThreat: ThreatKind | null;
  breaks: number;
  rng: Rng;
  cmd: FlightCommand;
  /** Lowest altitude it may fly at here (ground ahead + margin), m. */
  floorAhead: number;
}

const sample = newPathSample();
const sample2 = newPathSample();

export function createPilot(kind: AirKind, spec: FlightSpec, flight: FlightState, path: FlightPath, rng: Rng, o: { side?: number; trail?: number; leader?: Pilot | null } = {}): Pilot {
  return {
    kind, spec, flight, path, s: nearestS(path, flight.x, flight.z), side: o.side ?? 0, trail: o.trail ?? 0, leader: o.leader ?? null,
    mode: 'path', modeUntil: 0, breakDir: 1, cooldownUntil: 0, flaresLeft: 0, nextFlareAt: 0, lastThreat: null, breaks: 0, rng,
    cmd: { turnRate: 0, altitude: flight.y, speed: spec.cruise, maxBank: spec.cruiseBankDeg * DEG, altitudeTau: 9 },
    floorAhead: -Infinity,
  };
}

/** Altitude the path asks for at a sample (AGL paths ride the terrain). */
function pathAltitude(p: Pilot, s: { x: number; z: number; alt: number }, env: PilotEnv): number {
  return p.path.agl ? env.ground(s.x, s.z) + s.alt : s.alt;
}

/** The player is behind this aircraft (inside the rear cone), i.e. chasing it. */
export function isChased(f: FlightState, pl: PlayerInfo, coneDeg: number): boolean {
  const dx = f.x - pl.x, dy = f.y - pl.y, dz = f.z - pl.z;
  const d = Math.hypot(dx, dy, dz);
  if (!(d > 1e-6) || !(f.speed > 1e-6)) return false;
  const c = (dx * f.velocity.x + dy * f.velocity.y + dz * f.velocity.z) / (d * f.speed);
  return c >= Math.cos(coneDeg * DEG);
}

/**
 * Something threatens it: a lock (respects the cooldown), a missile launch or a hit (always), gun
 * rounds passing close (respects the cooldown). `from` = where the threat is. Returns true when a
 * break starts (or is extended).
 */
export function threaten(p: Pilot, kind: ThreatKind, from: { x: number; z: number }, time: number, cfg: AirConfig = CONFIG.combat.air, airport = { x: 0, z: 0 }): boolean {
  const soft = kind === 'lock' || kind === 'gun';
  if (p.mode === 'break') {
    if (soft) return false;
    p.modeUntil = Math.max(p.modeUntil, time + cfg.breakS[0]);
    if (p.flaresLeft === 0) p.flaresLeft = cfg.flares.count[0];
    p.lastThreat = kind;
    return true;
  }
  if (soft && time < p.cooldownUntil) return false;
  const f = p.flight;
  // Break into the threat (turn toward the side it is on) …
  const rel = wrapPi(bearingTo(f.x, f.z, from.x, from.z) - f.heading);
  let dir = rel >= 0 ? 1 : -1;
  // … unless that turn heads for the airport circuit.
  const dA = Math.hypot(f.x - airport.x, f.z - airport.z);
  if (dA < cfg.airportKeepOutM + 3000) {
    const toA = wrapPi(bearingTo(f.x, f.z, airport.x, airport.z) - f.heading);
    dir = toA >= 0 ? -1 : 1;
  }
  p.breakDir = dir;
  p.mode = 'break';
  const [lo, hi] = cfg.breakS;
  p.modeUntil = time + lo + (hi - lo) * p.rng.next();
  const [c0, c1] = cfg.flares.count;
  p.flaresLeft = c0 + Math.floor((c1 - c0 + 1) * p.rng.next());
  p.nextFlareAt = time;
  p.lastThreat = kind;
  p.breaks++;
  return true;
}

/** Compute this step's flight command. */
export function steer(p: Pilot, env: PilotEnv, cfg: AirConfig = CONFIG.combat.air, airport = { x: 0, z: 0 }): FlightCommand {
  const f = p.flight;
  const spec = p.spec;
  const cmd = p.cmd;
  const V = Math.max(1, f.speed);
  cmd.altitudeTau = cfg.altitudeTauS;
  cmd.maxBank = spec.cruiseBankDeg * DEG;

  // Where it is on its path.
  p.s = nearestS(p.path, f.x, f.z, p.s, 600, 2500);
  const L = Math.max(cfg.minLookaheadM, V * cfg.lookaheadS);
  samplePath(p.path, p.s + L, sample);
  // Station to the side of the path.
  const tx = sample.x + Math.cos(sample.heading) * p.side;
  const tz = sample.z + Math.sin(sample.heading) * p.side;
  cmd.turnRate = pursuitTurnRate(f.x, f.z, f.heading, V, tx, tz);
  cmd.altitude = pathAltitude(p, sample, env);
  samplePath(p.path, p.s, sample2);
  let speed = sample2.speed;
  // Wingman: hold the station behind the leader.
  const ld = p.leader;
  if (ld && ld.path === p.path) {
    const gap = deltaS(p.path, ld.s - p.trail, p.s);
    speed = Math.min(spec.max, Math.max(spec.min, speed + Math.max(-0.2 * speed, Math.min(0.25 * speed, gap * 0.04))));
  }
  cmd.speed = speed;

  if (p.mode === 'break') {
    if (env.time >= p.modeUntil) {
      p.mode = 'path';
      p.cooldownUntil = env.time + cfg.breakCooldownS;
      // Rejoin wherever the break left it.
      p.s = nearestS(p.path, f.x, f.z);
    } else {
      cmd.maxBank = spec.breakBankDeg * DEG;
      cmd.turnRate = p.breakDir * turnRateFor(Math.min(spec.breakBankDeg * DEG, Math.acos(1 / spec.maxG)), V) * 1.5;
      cmd.speed = spec.heloPitch ? spec.max : Math.min(spec.max, spec.cruise * 1.25);
      cmd.altitude = f.y - (spec.heloPitch ? 15 : 200);
    }
  }

  let avoid = false;
  if (p.mode !== 'break') {
    // Keep out of the airport circuit: turn away from it if the next ~12 s would take it inside.
    const px = f.x + f.velocity.x * 12, pz = f.z + f.velocity.z * 12;
    const dNow = Math.hypot(f.x - airport.x, f.z - airport.z);
    const dNext = Math.hypot(px - airport.x, pz - airport.z);
    if (dNow < cfg.airportKeepOutM || dNext < cfg.airportKeepOutM) {
      const away = bearingTo(airport.x, airport.z, f.x, f.z);
      const err = wrapPi(away - f.heading);
      cmd.turnRate = Math.sign(err || 1) * turnRateFor(spec.cruiseBankDeg * DEG, V) * Math.min(1, Math.abs(err) / (20 * DEG) + 0.3);
      avoid = true;
    }
    // Keep away from the player unless it is chasing from behind.
    const pl = env.player;
    if (pl && !avoid) {
      const dx = f.x - pl.x, dy = f.y - pl.y, dz = f.z - pl.z;
      const d = Math.hypot(dx, dy, dz);
      // Closing speed; turn away early enough to pass ≥ playerMinM clear (≈ 6.5 s of closure).
      const closure = d > 1e-6 ? (dx * (pl.vx - f.velocity.x) + dy * (pl.vy - f.velocity.y) + dz * (pl.vz - f.velocity.z)) / d : 0;
      const trigger = cfg.playerMinM + Math.min(3500, Math.max(0, closure) * 6.5);
      if (d < trigger && closure > 0 && !isChased(f, pl, cfg.chaseConeDeg)) {
        const away = bearingTo(pl.x, pl.z, f.x, f.z);
        const err = wrapPi(away - f.heading);
        cmd.maxBank = Math.max(cmd.maxBank, Math.min(spec.breakBankDeg, spec.cruiseBankDeg + 20) * DEG);
        cmd.turnRate = Math.sign(err || 1) * turnRateFor(cmd.maxBank, V);
        // and open the vertical gap
        cmd.altitude = f.y + (dy >= 0 ? 150 : -150);
        avoid = true;
      }
    }
  }
  p.mode = p.mode === 'break' ? 'break' : avoid ? 'avoid' : 'path';

  // Terrain ahead.
  let floor = -Infinity;
  const vx = f.velocity.x, vz = f.velocity.z;
  for (const t of cfg.terrainLookS) {
    const g = env.ground(f.x + vx * t, f.z + vz * t);
    if (g > floor) floor = g;
  }
  floor += spec.minAglM;
  p.floorAhead = floor;
  if (!(cmd.altitude >= floor)) cmd.altitude = floor;
  return cmd;
}
