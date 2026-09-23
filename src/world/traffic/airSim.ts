/**
 * The air traffic simulation driver (PURE, no three.js): owns the runway-36
 * circuit, the crossing-GA and airliner slot schedulers and the helicopter, and
 * turns them into a fixed list of entities with poses every frame.
 *
 *  - Built as a time-sliced job (`airSimJob`): with a traffic start time t0
 *    (`?tt=`) the circuit is fast-forwarded from 0 in 20 s chunks.
 *  - `update(t, dt, player)`: steps the circuit by the traffic step, rolls the
 *    schedulers over (anchored on the player), fills poses and keeps every
 *    airborne aircraft ≥ `playerClearance` from the player (never below the
 *    terrain: the push turns horizontal near the ground).
 *  - `reanchor(t, player)`: after a reset / teleport / aircraft change — the
 *    crossing tracks restart around the new position and the circuit clears the
 *    runway if the player is on it.
 */
import { CONFIG, type Config } from '../../config';
import type { WorldLayout } from '../layout';
import {
  airlinerPose, airlinerTrack, buildHeliRoute, circuitPose, createCircuitState, createScheduler, crossingPose, crossingTrack, heliPose, keepClear, newAirPose, reanchorCircuit, stepCircuit,
  GEAR_HEIGHT, type AirKind, type AirPose, type AirlinerSlot, type CircuitState, type CrossingSlot, type HeliRoute, type PlayerRef, type SlotScheduler,
} from './air';
import { h01 } from './rng';
import type { Job } from './jobs';

export type AirRole = 'circuit' | 'crossing' | 'heli' | 'airliner';

export interface AirEntity {
  id: number;
  role: AirRole;
  kind: AirKind;
  /** Index into LIVERIES[kind]. */
  livery: number;
  pose: AirPose;
  /** Airliners: the current track (contrail source). */
  airliner: AirlinerSlot | null;
}

export interface AirSim {
  readonly entities: readonly AirEntity[];
  readonly circuit: CircuitState | null;
  update(t: number, dt: number, player: PlayerRef | null): void;
  reanchor(t: number, player: PlayerRef | null): void;
}

export interface AirSimOptions {
  layout: WorldLayout;
  heightAt: (x: number, z: number) => number;
  config?: Config;
  /** Traffic time at start (the circuit is fast-forwarded to it). */
  t0: number;
  /** The player at start (schedule anchor, circuit decisions during the fast-forward). */
  player: PlayerRef | null;
}

/** Circuit fast-forward chunk per job step (s of traffic time). */
const FF_CHUNK = 20;
/**
 * New crossing tracks are laid through where the player will be when the crossing aircraft
 * reaches the middle of its track (~4 min later): the player's position + velocity × LEAD_S,
 * at most LEAD_MAX m ahead (a turning player still sees them pass within a few km).
 */
const LEAD_S = 190;
const LEAD_MAX = 9000;

/** The crossing anchor for a player: `lead` = where they are heading. */
export function leadAnchor(player: PlayerRef, out: { x: number; z: number }): { x: number; z: number } {
  let lx = (player.vx ?? 0) * LEAD_S;
  let lz = (player.vz ?? 0) * LEAD_S;
  const l = Math.hypot(lx, lz);
  if (l > LEAD_MAX) {
    lx *= LEAD_MAX / l;
    lz *= LEAD_MAX / l;
  }
  out.x = player.x + (Number.isFinite(lx) ? lx : 0);
  out.z = player.z + (Number.isFinite(lz) ? lz : 0);
  return out;
}

export function* airSimJob(o: AirSimOptions): Job<AirSim> {
  const cfg = o.config ?? CONFIG;
  const ac = cfg.world.traffic.air;
  const seed = cfg.world.traffic.seed;
  const R = cfg.world.traffic.playerClearance;
  const circuit = ac.circuit > 0 ? createCircuitState(o.layout, cfg) : null;
  yield;
  if (circuit) {
    let left = Math.max(0, o.t0);
    while (left > 0) {
      const step = Math.min(FF_CHUNK, left);
      stepCircuit(circuit, step, o.player);
      left -= step;
      yield;
    }
  }
  const heli: HeliRoute | null = ac.helicopter ? buildHeliRoute(o.layout, o.heightAt, cfg) : null;
  yield;
  const anchor0 = o.player ? leadAnchor(o.player, { x: 0, z: 0 }) : { x: 0, z: 0 };
  const lead = { x: anchor0.x, z: anchor0.z };
  const crossing: SlotScheduler<CrossingSlot> = createScheduler(ac.crossing, (s, c, a, st) => crossingTrack(seed, s, c, a, st, o.heightAt, cfg), (s) => 0.36 * ((s * 0.37) % 1), o.t0, anchor0);
  yield;
  const airliners: SlotScheduler<AirlinerSlot> = createScheduler(ac.airliners, (s, c, a, st) => airlinerTrack(seed, s, c, a, st, cfg), (s) => 0.25 + 0.3 * h01(seed, 9600, s), o.t0, anchor0);

  const entities: AirEntity[] = [];
  let id = 0;
  if (circuit) for (const a of circuit.aircraft) entities.push({ id: id++, role: 'circuit', kind: a.kind, livery: a.livery, pose: newAirPose(), airliner: null });
  for (let i = 0; i < crossing.slots.length; i++) entities.push({ id: id++, role: 'crossing', kind: crossing.slots[i].kind, livery: crossing.slots[i].livery, pose: newAirPose(), airliner: null });
  if (heli) entities.push({ id: id++, role: 'heli', kind: 'heli', livery: Math.floor(h01(seed, 9402, 0) * 2), pose: newAirPose(), airliner: null });
  for (let i = 0; i < airliners.slots.length; i++) entities.push({ id: id++, role: 'airliner', kind: 'a320', livery: airliners.slots[i].livery, pose: newAirPose(), airliner: airliners.slots[i] });
  const nCross = crossing.slots.length;
  const anchor = { x: anchor0.x, z: anchor0.z };

  const fill = (t: number, player: PlayerRef | null) => {
    let k = 0;
    if (circuit) for (const a of circuit.aircraft) circuitPose(circuit, a, entities[k++].pose);
    for (let i = 0; i < nCross; i++) {
      const e = entities[k++];
      const s = crossing.slots[i];
      e.kind = s.kind;
      e.livery = s.livery;
      crossingPose(s, t, e.pose);
    }
    if (heli) heliPose(heli, t, entities[k++].pose);
    for (let i = 0; i < airliners.slots.length; i++) {
      const e = entities[k++];
      e.airliner = airliners.slots[i];
      e.livery = e.airliner.livery;
      airlinerPose(e.airliner, t, e.pose);
    }
    if (!player) return;
    for (const e of entities) {
      const p = e.pose;
      if (p.onGround || !p.visible) continue;
      // keepClear leaves points beyond R + 8 × its 120 m softness alone: skip the terrain lookup
      if (Math.abs(p.x - player.x) > R + 1000 || Math.abs(p.z - player.z) > R + 1000 || Math.abs(p.y - player.y) > R + 1000) continue;
      const floor = o.heightAt(p.x, p.z) + GEAR_HEIGHT[e.kind] + 25;
      keepClearAbove(p, player, R, floor);
    }
  };

  const sim: AirSim = {
    entities,
    circuit,
    update(t, dt, player) {
      if (circuit && dt > 0) stepCircuit(circuit, dt, player);
      if (player) {
        anchor.x = player.x;
        anchor.z = player.z;
        leadAnchor(player, lead);
      }
      crossing.update(t, lead);
      airliners.update(t, anchor);
      fill(t, player);
    },
    reanchor(t, player) {
      if (player) {
        anchor.x = player.x;
        anchor.z = player.z;
        leadAnchor(player, lead);
      }
      crossing.reanchor(t, lead);
      airliners.reanchor(t, anchor);
      if (circuit) reanchorCircuit(circuit, player);
      fill(t, player);
    },
  };
  fill(o.t0, o.player);
  return sim;
}

/**
 * `keepClear`, but never pushing below `floorY`: if the radial push would sink the aircraft under
 * the floor it is held at the floor and pushed out horizontally instead (still ≥ R from the player).
 */
export function keepClearAbove(p: { x: number; y: number; z: number }, player: { x: number; y: number; z: number }, R: number, floorY: number): void {
  const y0 = p.y;
  keepClear(p, player, R);
  if (p.y >= floorY || p.y >= y0) return;
  p.y = Math.max(floorY, Math.min(y0, p.y));
  const dy = p.y - player.y;
  const need = R * R - dy * dy;
  if (need <= 0) return;
  const dx = p.x - player.x;
  const dz = p.z - player.z;
  const dh = Math.hypot(dx, dz);
  const want = Math.sqrt(need) + 1;
  if (dh >= want) return;
  if (dh < 1e-3) {
    p.x = player.x + want;
    return;
  }
  p.x = player.x + (dx / dh) * want;
  p.z = player.z + (dz / dh) * want;
}
