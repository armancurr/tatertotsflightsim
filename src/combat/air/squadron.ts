/**
 * The enemy aircraft (PURE — no three.js; the fx pools are pure too): creates them from the plan,
 * registers each with the combat world as an aircraft target and keeps its position, orientation,
 * heading and velocity current every step; flies them (pilot + kinematic flight); makes them break
 * and pop flares when the player locks them, launches at them, hits them or shoots close past them;
 * plays the shoot-down (fall, trail of fire and smoke, a part letting go, impact, burning wreck and
 * smoke column); respawns a replacement `respawnS` after a kill; rebuilds everything on reset.
 */
import { CONFIG } from '../../config';
import type { FxSim } from '../../fx/sim';
import type { Quat, Vec3 } from '../../types';
import { createRng, type Rng } from '../rng';
import type { AirKind, CombatEvent, GroundTarget } from '../types';
import type { CombatWorld } from '../world';
import { newFlightState, stepFlight, type FlightSpec, type FlightState } from './flight';
import { createPilot, steer, threaten, type Pilot, type PlayerInfo, type ThreatKind } from './pilot';
import { newPathSample, samplePath } from './paths';
import { planAir, slotPoint, type SlotPlan } from './plan';
import { startFall, stepFall, type Fall } from './wreck';
import { FlarePool, groundImpact, partTrail, wreckTrail } from './airFx';

const DEG = Math.PI / 180;
type AirCfg = typeof CONFIG.combat.air;

export type AirPhase = 'flying' | 'falling' | 'wreck' | 'sunk';

export interface AirEntity {
  /** Slot it flies (the replacement flies the same one). */
  slot: number;
  kind: AirKind;
  group: string;
  target: GroundTarget;
  flight: FlightState;
  pilot: Pilot;
  phase: AirPhase;
  fall: Fall | null;
  /** Pose drawn (flight or fall). */
  position: Vec3;
  orientation: Quat;
  /** Paint seed and tactical number. */
  seed: number;
  bort: number;
  destroyedAt: number | null;
  landedAt: number | null;
  /** 0 intact … 1 charred. */
  char: number;
  /** Rotor speed 0..1 and phase (rad). */
  rotor: number;
  rotorPhase: number;
  fireH: number;
  columnH: number;
  trailAcc: number;
  partAcc: number;
  rng: Rng;
  /** Flare side alternation. */
  flareSide: number;
}

export interface AirSquadronOptions {
  world: CombatWorld;
  ground(x: number, z: number): number;
  water?: (x: number, z: number) => number | null;
  /** The scene's fx pools (null when off). */
  fx?: () => FxSim | null;
  range?: { x: number; z: number } | null;
  airport?: { x: number; z: number };
  cfg?: AirCfg;
  seed?: number;
}

export interface AirSquadron {
  readonly entities: readonly AirEntity[];
  readonly flares: FlarePool;
  readonly slots: readonly SlotPlan[];
  readonly time: number;
  /** Place everyone (≥ 2.5 km from the player) — at start, on reset (R) and on aircraft change. */
  reset(player: PlayerInfo | null): void;
  /** One step. `player` = the player's aircraft (null = unknown/crashed). */
  update(dt: number, player: PlayerInfo | null): void;
  /** Live aircraft (flying). */
  live(): AirEntity[];
  entityOf(targetId: number): AirEntity | undefined;
  /** Force a threat (tests / QA). */
  threat(targetId: number, kind: ThreatKind, from: { x: number; z: number }): boolean;
  stats(): Record<string, unknown>;
  dispose(): void;
}

const specOf = (cfg: AirCfg, kind: AirKind): FlightSpec => cfg.flight[kind] as FlightSpec;

export function createAirSquadron(o: AirSquadronOptions): AirSquadron {
  const cfg = o.cfg ?? CONFIG.combat.air;
  const world = o.world;
  const ground = o.ground;
  const water = o.water ?? null;
  const fx = o.fx ?? (() => null);
  const airport = o.airport ?? { x: 0, z: 0 };
  const range = o.range ?? { x: Math.sin(350 * DEG) * 7000, z: -Math.cos(350 * DEG) * 7000 };
  const seed = o.seed ?? cfg.seed;
  const slots = planAir(range, ground, cfg, airport, seed);
  const entities: AirEntity[] = [];
  const bySlot: (AirEntity | null)[] = slots.map(() => null);
  const respawnAt: (number | null)[] = slots.map(() => null);
  const flares = new FlarePool(40);
  const pending: number[] = [];
  let time = 0;
  let lastPlayer: PlayerInfo | null = null;
  let spawnCount = 0;
  let kills = 0;
  let impacts = 0;
  let flaresOut = 0;
  const hardFloor = (x: number, z: number) => {
    const g = ground(x, z);
    const w = water ? water(x, z) : null;
    return (w !== null && w > g ? w : g) + cfg.hardFloorM;
  };
  const env = { time: 0, ground, player: null as PlayerInfo | null };
  const pathSample = newPathSample();

  const removeTarget = (t: GroundTarget) => {
    const i = world.targets.indexOf(t);
    if (i >= 0) (world.targets as GroundTarget[]).splice(i, 1);
  };

  const syncTarget = (e: AirEntity) => {
    const t = e.target;
    t.position.x = e.position.x;
    t.position.y = e.position.y;
    t.position.z = e.position.z;
    const q = t.orientation ?? (t.orientation = { x: 0, y: 0, z: 0, w: 1 });
    q.x = e.orientation.x;
    q.y = e.orientation.y;
    q.z = e.orientation.z;
    q.w = e.orientation.w;
    const f = e.fall;
    if (f) {
      t.velocity.x = f.vx;
      t.velocity.y = f.vy;
      t.velocity.z = f.vz;
      t.headingDeg = (((f.heading / DEG) % 360) + 360) % 360;
    } else {
      t.velocity.x = e.flight.velocity.x;
      t.velocity.y = e.flight.velocity.y;
      t.velocity.z = e.flight.velocity.z;
      t.headingDeg = (((e.flight.heading / DEG) % 360) + 360) % 360;
    }
  };

  /** Spawn the slot's aircraft at along-path s. */
  const spawn = (slotIndex: number, s: number): AirEntity => {
    const sp = slots[slotIndex];
    const spec = specOf(cfg, sp.kind);
    const pt = slotPoint(sp, s, ground);
    const y = Math.max(pt.y, hardFloor(pt.x, pt.z) + spec.minAglM * 0.5);
    const flight = newFlightState(pt.x, y, pt.z, pt.heading, Math.min(spec.max, Math.max(spec.min, pt.speed)));
    const rng = createRng((sp.seed + spawnCount * 0x9e3779b1) >>> 0);
    const leaderE = sp.leader !== null ? bySlot[sp.leader] : null;
    const pilot = createPilot(sp.kind, spec, flight, sp.path, rng, { side: sp.side, trail: sp.trail, leader: leaderE && leaderE.phase === 'flying' ? leaderE.pilot : null });
    pilot.s = s;
    const target = world.addTarget({ kind: sp.kind, position: { x: pt.x, y, z: pt.z }, headingDeg: pt.heading / DEG, velocity: { ...flight.velocity }, orientation: { ...flight.orientation }, group: `air:${sp.group}` });
    const e: AirEntity = {
      slot: slotIndex, kind: sp.kind, group: sp.group, target, flight, pilot, phase: 'flying', fall: null,
      position: { x: flight.x, y: flight.y, z: flight.z }, orientation: { ...flight.orientation },
      seed: (sp.seed % 997) / 997, bort: spawnCount < slots.length ? sp.bort : 10 + ((sp.bort + spawnCount * 17) % 89),
      destroyedAt: null, landedAt: null, char: 0, rotor: sp.kind === 'helo' ? 1 : 0, rotorPhase: rng.next() * 6.28,
      fireH: -1, columnH: -1, trailAcc: 0, partAcc: 0, rng, flareSide: 1,
    };
    spawnCount++;
    entities.push(e);
    bySlot[slotIndex] = e;
    // Wingmen of this slot follow it again.
    slots.forEach((q, i) => {
      if (q.leader === slotIndex && bySlot[i] && bySlot[i]!.phase === 'flying') bySlot[i]!.pilot.leader = e.pilot;
    });
    syncTarget(e);
    return e;
  };

  /** Along-path s for a slot that keeps ≥ minD from the player (the farthest point when none does). */
  const clearS = (slotIndex: number, s0: number, player: PlayerInfo | null, minD: number): number => {
    if (!player) return s0;
    const sp = slots[slotIndex];
    const L = sp.path.length;
    let best = s0;
    let bestD = -1;
    const n = 48;
    for (let k = 0; k < n; k++) {
      const s = s0 + (k * L) / n;
      samplePath(sp.path, s, pathSample);
      const d = Math.hypot(pathSample.x - player.x, pathSample.z - player.z);
      if (d >= minD) return s;
      if (d > bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  };

  const releaseFx = (e: AirEntity) => {
    const sim = fx();
    if (sim) {
      // a burning wreck removed early: let its emitters go (they burn out on their own otherwise)
      if (e.fireH >= 0) sim.quench(e.fireH);
    }
    e.fireH = -1;
    e.columnH = -1;
  };

  const threatFrom = (): { x: number; z: number } => (lastPlayer ? { x: lastPlayer.x, z: lastPlayer.z } : { x: airport.x, z: airport.z });

  const onEvent = (ev: CombatEvent) => {
    switch (ev.type) {
      case 'lock': {
        const e = byTarget(ev.targetId);
        if (e && e.phase === 'flying') threaten(e.pilot, 'lock', threatFrom(), time, cfg, airport);
        break;
      }
      case 'missileLaunch': {
        const id = world.status.lock.targetId;
        const e = id !== null ? byTarget(id) : undefined;
        if (e && e.phase === 'flying') threaten(e.pilot, 'launch', { x: ev.position.x, z: ev.position.z }, time, cfg, airport);
        break;
      }
      case 'hit': {
        const e = byTarget(ev.targetId);
        if (e && e.phase === 'flying' && e.target.alive) threaten(e.pilot, 'hit', threatFrom(), time, cfg, airport);
        break;
      }
      case 'destroyed': {
        const e = byTarget(ev.targetId);
        if (e && e.phase === 'flying') pending.push(ev.targetId);
        break;
      }
      default:
        break;
    }
  };
  const off = world.on(onEvent);

  const byTarget = (id: number) => {
    for (const e of entities) if (e.target.id === id) return e;
    return undefined;
  };

  const startFalling = (e: AirEntity) => {
    if (e.phase !== 'flying') return;
    e.phase = 'falling';
    e.destroyedAt = time;
    e.fall = startFall(e.kind, e.flight, e.rng, cfg.wreck, e.rotor);
    kills++;
    respawnAt[e.slot] = time + cfg.respawnS;
    if (bySlot[e.slot] === e) bySlot[e.slot] = null;
    // Its wingman flies on alone (and the leader's slot keeps the path).
    for (const w of entities) if (w.pilot.leader === e.pilot) w.pilot.leader = null;
    const sim = fx();
    if (sim) {
      // the burning airframe (moved with it every step)
      e.fireH = sim.addFire(e.flight.x, e.flight.y, e.flight.z, ground(e.flight.x, e.flight.z), 1, 600, e.kind === 'helo' ? 2.5 : 3, true);
      sim.sparks(e.flight.x, e.flight.y, e.flight.z, e.flight.velocity.x * 0.5, e.flight.velocity.y * 0.5, e.flight.velocity.z * 0.5, 40);
    }
  };

  const land = (e: AirEntity) => {
    const f = e.fall!;
    e.landedAt = time;
    impacts++;
    const sim = fx();
    const g = ground(f.x, f.z);
    if (f.water) {
      e.phase = 'sunk';
      if (sim) {
        sim.splash(f.x, f.y, f.z, 1.6);
        if (e.fireH >= 0) sim.quench(e.fireH);
      }
      e.fireH = -1;
      return;
    }
    e.phase = 'wreck';
    if (!sim) return;
    groundImpact(sim, f.x, g, f.z, e.target.velocity.x, e.target.velocity.y, e.target.velocity.z, e.kind === 'helo' ? 0.85 : 1.1);
    // The fire on the airframe goes out; a ground fire and the smoke column take over (budgeted).
    if (e.fireH >= 0) sim.quench(e.fireH);
    e.fireH = -1;
    let fires = 0;
    for (const w of entities) if (w !== e && w.phase === 'wreck' && w.columnH >= 0) fires++;
    if (fires < cfg.wreck.maxFires) {
      const [f0, f1] = cfg.wreck.fireS;
      const [c0, c1] = cfg.wreck.columnS;
      e.fireH = sim.addFire(f.x, g + 1, f.z, g, 1, f0 + (f1 - f0) * e.rng.next(), e.kind === 'helo' ? 3.5 : 4.5, true);
      e.columnH = sim.addColumn(f.x, g, f.z, g, 0.9, c0 + (c1 - c0) * e.rng.next());
    }
  };

  const updateFlying = (e: AirEntity, dt: number) => {
    const p = e.pilot;
    steer(p, env, cfg, airport);
    stepFlight(e.flight, p.cmd, p.spec, dt, hardFloor);
    const f = e.flight;
    e.position.x = f.x;
    e.position.y = f.y;
    e.position.z = f.z;
    e.orientation.x = f.orientation.x;
    e.orientation.y = f.orientation.y;
    e.orientation.z = f.orientation.z;
    e.orientation.w = f.orientation.w;
    if (e.kind === 'helo') e.rotorPhase += dt * 25;
    // Flares: one every intervalS, alternating sides, ejected down and out behind.
    if (p.flaresLeft > 0 && time >= p.nextFlareAt) {
      p.flaresLeft--;
      p.nextFlareAt = time + cfg.flares.intervalS;
      e.flareSide = -e.flareSide;
      const q = f.orientation;
      // body → world for the ejector (aft, below, to the side) and the kick
      const bx = e.flareSide * 0.8, by = -0.9, bz = e.kind === 'helo' ? 3 : 5;
      const w = rot(q, bx, by, bz);
      const k = rot(q, e.flareSide * 12, -18, 6);
      flares.eject(f.x + w.x, f.y + w.y, f.z + w.z, f.velocity.x, f.velocity.y, f.velocity.z, k.x, k.y, k.z, cfg.flares.burnS * (0.85 + 0.3 * e.rng.next()));
      flaresOut++;
    }
  };

  const updateFalling = (e: AirEntity, dt: number) => {
    const f = e.fall!;
    const x0 = f.x, y0 = f.y, z0 = f.z;
    const px0 = f.part?.x ?? 0, py0 = f.part?.y ?? 0, pz0 = f.part?.z ?? 0;
    const hit = stepFall(f, dt, ground, water, e.rng, cfg.wreck);
    e.position.x = f.x;
    e.position.y = f.y;
    e.position.z = f.z;
    e.orientation.x = f.q.x;
    e.orientation.y = f.q.y;
    e.orientation.z = f.q.z;
    e.orientation.w = f.q.w;
    e.rotor = f.rotor;
    e.rotorPhase += dt * 25 * f.rotor;
    e.char = Math.min(1, (time - (e.destroyedAt ?? time)) / 3);
    const sim = fx();
    if (sim && dt > 0) {
      const g = ground(f.x, f.z);
      if (e.fireH >= 0) sim.moveFire(e.fireH, f.x, f.y, f.z, g);
      e.trailAcc = wreckTrail(sim, x0, y0, z0, f.x, f.y, f.z, e.trailAcc, cfg.wreck.trailStepM, 1, g);
      if (f.part && !f.part.landed) e.partAcc = partTrail(sim, px0, py0, pz0, f.part.x, f.part.y, f.part.z, e.partAcc, 14);
    }
    if (hit) land(e);
  };

  const self: AirSquadron = {
    entities,
    flares,
    slots,
    get time() {
      return time;
    },

    reset(player) {
      lastPlayer = player;
      for (const e of entities) {
        releaseFx(e);
        removeTarget(e.target);
      }
      entities.length = 0;
      pending.length = 0;
      flares.clear();
      spawnCount = 0;
      kills = 0;
      impacts = 0;
      flaresOut = 0;
      for (let i = 0; i < slots.length; i++) {
        bySlot[i] = null;
        respawnAt[i] = null;
      }
      // Leaders first (their wingmen form on them).
      const order = slots.map((_, i) => i).sort((a, b) => (slots[a].leader === null ? 0 : 1) - (slots[b].leader === null ? 0 : 1));
      for (const i of order) {
        const sp = slots[i];
        let s = sp.s0;
        if (sp.leader !== null && bySlot[sp.leader]) s = bySlot[sp.leader]!.pilot.s - sp.trail;
        else s = clearS(i, s, player, 2500);
        spawn(i, s);
      }
    },

    update(dtIn, player) {
      const dt = Number.isFinite(dtIn) && dtIn > 0 ? Math.min(dtIn, 0.1) : 0;
      if (player) lastPlayer = player;
      env.player = player;
      if (dt === 0) return;
      time += dt;
      env.time = time;

      // Killed by someone (the world said 'destroyed'): start falling.
      while (pending.length) {
        const e = byTarget(pending.shift()!);
        if (e) startFalling(e);
      }
      // A world.reviveAll (the range's reset) woke a wreck: it goes (our reset rebuilds everything).
      for (let i = entities.length - 1; i >= 0; i--) {
        const e = entities[i];
        if (e.phase !== 'flying' && e.target.alive) {
          releaseFx(e);
          removeTarget(e.target);
          entities.splice(i, 1);
        } else if (e.phase === 'flying' && !e.target.alive) {
          startFalling(e);
        }
      }

      // Gun rounds passing close: the player is firing with the nose on one of them.
      if (player && world.status.gunFiring) {
        for (const e of entities) {
          if (e.phase !== 'flying') continue;
          const dx = e.flight.x - player.x, dy = e.flight.y - player.y, dz = e.flight.z - player.z;
          const along = dx * player.fx + dy * player.fy + dz * player.fz;
          if (along <= 0 || along > cfg.gunRangeM) continue;
          const miss = Math.sqrt(Math.max(0, dx * dx + dy * dy + dz * dz - along * along));
          if (miss < cfg.gunNearM) threaten(e.pilot, 'gun', { x: player.x, z: player.z }, time, cfg, airport);
        }
      }

      for (const e of entities) {
        if (e.phase === 'flying') updateFlying(e, dt);
        else if (e.phase === 'falling') updateFalling(e, dt);
        else if (e.fall?.part && !e.fall.part.landed) stepFall(e.fall, dt, ground, water, e.rng, cfg.wreck);
        if (e.phase === 'wreck') e.char = Math.min(1, e.char + dt / 3);
        syncTarget(e);
      }

      // Replacements.
      for (let i = 0; i < slots.length; i++) {
        const at = respawnAt[i];
        if (at === null || time < at || bySlot[i]) continue;
        respawnAt[i] = null;
        const sp = slots[i];
        let s = sp.s0 + time * 37;
        const ld = sp.leader !== null ? bySlot[sp.leader] : null;
        if (ld && ld.phase === 'flying') {
          // rejoin behind the leader if that is clear of the player, else far away
          const behind = ld.pilot.s - sp.trail;
          s = clearS(i, behind, player, cfg.respawnMinDistM);
        } else s = clearS(i, s, player, cfg.respawnMinDistM);
        spawn(i, s);
      }

      // Old wrecks go (and their hit boxes).
      let wrecks = 0;
      for (let i = entities.length - 1; i >= 0; i--) {
        const e = entities[i];
        if (e.phase === 'flying' || e.phase === 'falling') continue;
        wrecks++;
        if (wrecks > cfg.wreck.maxWrecks || (e.phase === 'sunk' && time - (e.landedAt ?? time) > 4)) {
          releaseFx(e);
          removeTarget(e.target);
          entities.splice(i, 1);
        }
      }

      flares.step(dt, fx());
    },

    live: () => entities.filter((e) => e.phase === 'flying'),
    entityOf: (id) => byTarget(id),

    threat(id, kind, from) {
      const e = byTarget(id);
      return !!e && e.phase === 'flying' && threaten(e.pilot, kind, from, time, cfg, airport);
    },

    stats() {
      const count = (p: AirPhase) => entities.filter((e) => e.phase === p).length;
      return {
        flying: count('flying'),
        falling: count('falling'),
        wrecks: count('wreck'),
        kills,
        impacts,
        flares: flaresOut,
        flaresActive: flares.active,
        breaking: entities.filter((e) => e.phase === 'flying' && e.pilot.mode === 'break').length,
        spawned: spawnCount,
        respawnIn: respawnAt.map((t) => (t === null ? null : Math.max(0, Math.round(t - time)))),
      };
    },

    dispose() {
      off();
      for (const e of entities) removeTarget(e.target);
      entities.length = 0;
    },
  };
  return self;
}

/** Rotate a body vector by a quaternion. */
function rot(q: Quat, x: number, y: number, z: number): Vec3 {
  const tx = 2 * (q.y * z - q.z * y);
  const ty = 2 * (q.z * x - q.x * z);
  const tz = 2 * (q.x * y - q.y * x);
  return { x: x + q.w * tx + (q.y * tz - q.z * ty), y: y + q.w * ty + (q.z * tx - q.x * tz), z: z + q.w * tz + (q.x * ty - q.y * tx) };
}
