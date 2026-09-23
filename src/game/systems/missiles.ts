/**
 * The missiles (arcade): T picks the target nearest the nose (again = the next one) — a ground
 * vehicle or an aircraft, whichever this aircraft can shoot — LOCK after a moment, and Z launches
 * from the next loaded rail of the matching type: an AGM-65 Maverick at a vehicle, an AIM-9
 * Sidewinder at an aircraft. The missile flies a scripted curve to the target
 * (src/combat/missile.ts) — then a direct hit plus blast. Writes the missile/lock fields of the
 * combat world's status (the weapons system writes the gun's) and emits missileLaunch /
 * detonation / lock / lockLost / reload for the fx, audio and HUD.
 */
import * as THREE from 'three';
import type { MissileConfig } from '../../config';
import type { AircraftState, Vec3 } from '../../types';
import type { GroundTarget } from '../../combat/types';
import { combatWorld } from '../../combat/world';
import { launchArcadeMissile, stepArcadeMissile, type ArcadeMissile } from '../../combat/missile';
import { newLock, selectNextTarget, stepLock, targetCentre } from '../../combat/targeting';
import { createMissileRenderer, type MissileRenderer } from '../../combat/missileRender';
import type { AircraftDef } from '../../fleet/types';
import type { SystemModule } from './types';

const MAX_IN_FLIGHT = 6;

type Kind = 'ground' | 'air';

interface Rack {
  cfg: MissileConfig | null;
  stores: boolean[];
  render: MissileRenderer | null;
}

interface Flight {
  m: ArcadeMissile;
  kind: Kind;
  slot: number;
  prev: Vec3;
}

const mod: SystemModule = {
  name: 'missiles',
  order: 71,
  create(ctx) {
    const world = combatWorld(ctx.scene);
    const env = ctx.env;
    let def: AircraftDef | undefined = ctx.actions?.currentAircraft?.();
    const racks: Record<Kind, Rack> = {
      ground: { cfg: null, stores: [], render: null },
      air: { cfg: null, stores: [], render: null },
    };
    const lock = newLock();
    const flying: Flight[] = [];
    let nextId = 1;
    let time = 0;
    let last: AircraftState | null = null;
    const Q = new THREE.Quaternion();
    const V = new THREE.Vector3();
    const size = new THREE.Vector2();

    const kindOf = (t: GroundTarget): Kind => (world.isAir(t) ? 'air' : 'ground');
    const rackFor = (t: GroundTarget | undefined) => (t ? racks[kindOf(t)] : null);
    const canShoot = (t: GroundTarget) => racks[kindOf(t)].cfg !== null;
    /** Target selection covers every missile this aircraft carries. */
    const selection = () => {
      const g = racks.ground.cfg;
      const a = racks.air.cfg;
      return {
        selectConeDeg: Math.max(g?.selectConeDeg ?? 0, a?.selectConeDeg ?? 0),
        maxRangeM: Math.max(g?.maxRangeM ?? 0, a?.maxRangeM ?? 0),
      };
    };
    const anyMissiles = () => racks.ground.cfg !== null || racks.air.cfg !== null;

    const renderer = (kind: Kind) => {
      const r = racks[kind];
      if (!r.render && r.cfg) {
        r.render = createMissileRenderer({ length: r.cfg.lengthM, diameter: r.cfg.diameterM, slots: MAX_IN_FLIGHT });
        ctx.scene.add(r.render.object);
      }
      return r.render;
    };

    const setLock = (state: 'off' | 'tracking', id: number | null) => {
      const had = lock.state !== 'off' ? lock.targetId : null;
      lock.state = state;
      lock.targetId = id;
      lock.timer = 0;
      if (state === 'off' && had !== null) world.emit({ type: 'lockLost', time, targetId: had });
    };

    const loadFrom = (d: AircraftDef | undefined) => {
      racks.ground.cfg = d?.config.weapons?.missiles ?? null;
      racks.air.cfg = d?.config.weapons?.airMissiles ?? null;
    };

    const reload = () => {
      flying.length = 0;
      for (const k of ['ground', 'air'] as Kind[]) {
        const r = racks[k];
        r.render?.clear();
        r.stores = r.cfg ? r.cfg.stations.map(() => true) : [];
      }
      world.status.stores = racks.ground.stores;
      world.status.airStores = racks.air.stores;
      setLock('off', null);
      world.emit({ type: 'reload', time });
    };

    /** Body-frame point → world, with the aircraft's current pose. */
    const bodyToWorld = (s: AircraftState, p: Vec3): Vec3 => {
      Q.set(s.orientation.x, s.orientation.y, s.orientation.z, s.orientation.w);
      V.set(p.x, p.y, p.z).applyQuaternion(Q);
      return { x: s.position.x + V.x, y: s.position.y + V.y, z: s.position.z + V.z };
    };
    const nose = (s: AircraftState): Vec3 => {
      Q.set(s.orientation.x, s.orientation.y, s.orientation.z, s.orientation.w);
      V.set(0, 0, -1).applyQuaternion(Q);
      return { x: V.x, y: V.y, z: V.z };
    };

    const detonate = (f: Flight) => {
      const cfg = racks[f.kind].cfg;
      if (!cfg) return;
      const m = f.m;
      const p = { ...m.pos };
      let targetId: number | null = null;
      if (m.targetId !== null) {
        const c = targetCentre(world, m.targetId);
        const t = world.find(m.targetId);
        if (c && t && Math.hypot(c.x - p.x, c.y - p.y, c.z - p.z) < 6) {
          targetId = t.id;
          world.applyHit(t.id, { weapon: 'missile', damage: cfg.damage, point: p, direction: { ...m.dir }, time, face: 'top' });
        }
      }
      world.applyBlast(p, cfg.blastRadiusM, cfg.damage * 0.6, 'missile', time);
      const water = env.waterLevel(p.x, p.z);
      const ground = env.groundHeight(p.x, p.z);
      const surface = targetId !== null ? 'target' : water !== null && p.y <= water + 1 ? 'water' : p.y > ground + 20 ? 'target' : env.surfaceAt(p.x, p.z);
      world.emit({ type: 'detonation', time, weapon: 'missile', position: p, targetId, blastRadiusM: cfg.blastRadiusM, surface });
    };

    const writeStatus = (s: AircraftState | null) => {
      const st = world.status;
      const g = racks.ground;
      const a = racks.air;
      st.hasMissiles = !!g.cfg && g.stores.length > 0;
      st.missileName = g.cfg?.name ?? '';
      st.maxMissiles = g.stores.length;
      st.missiles = g.stores.reduce((n, b) => n + (b ? 1 : 0), 0);
      st.stores = g.stores;
      st.hasAirMissiles = !!a.cfg && a.stores.length > 0;
      st.airMissileName = a.cfg?.name ?? '';
      st.maxAirMissiles = a.stores.length;
      st.airMissiles = a.stores.reduce((n, b) => n + (b ? 1 : 0), 0);
      st.airStores = a.stores;
      st.missilesInFlight = flying.length;
      const L = st.lock;
      const t = lock.targetId !== null ? world.find(lock.targetId) : undefined;
      const cfg = rackFor(t)?.cfg ?? null;
      L.state = lock.state;
      L.targetId = lock.targetId;
      L.progress = lock.state === 'locked' ? 1 : cfg && lock.state === 'tracking' ? Math.min(1, lock.timer / cfg.lockTimeS) : 0;
      const c = t ? world.centreOf(t) : null;
      L.rangeM = c && s ? Math.hypot(c.x - s.position.x, c.y - s.position.y, c.z - s.position.z) : null;
      L.inRange = !!cfg && L.rangeM !== null && L.rangeM >= cfg.minRangeM && L.rangeM <= cfg.maxRangeM;
    };

    loadFrom(def);
    reload();

    return {
      update(f) {
        const s = f.state;
        last = s;
        if (f.def && f.def !== def) {
          def = f.def;
          loadFrom(def);
          reload();
        }
        const dt = f.paused ? 0 : f.dt;
        time += dt;

        // Missiles in flight.
        for (let i = flying.length - 1; i >= 0; i--) {
          const fl = flying[i];
          const m = fl.m;
          fl.prev.x = m.pos.x;
          fl.prev.y = m.pos.y;
          fl.prev.z = m.pos.z;
          const t = m.targetId !== null ? world.find(m.targetId) : undefined;
          stepArcadeMissile(m, dt, t && t.alive ? world.centreOf(t) : null);
          // A hill in the way: it hits the hill.
          const g = env.groundHeight(m.pos.x, m.pos.z);
          if (!m.arrived && m.pos.y < g + 0.2 && m.t / m.duration < 0.97) {
            m.pos.y = g;
            m.arrived = true;
            m.targetId = null;
          }
          const r = racks[fl.kind].render;
          r?.trail(fl.prev, m.pos);
          if (m.arrived) {
            detonate(fl);
            r?.setMissile(fl.slot, null);
            flying.splice(i, 1);
          } else r?.setMissile(fl.slot, m.pos, m.dir);
        }

        // The lock (after the missiles, so a kill drops it this frame).
        if (s.phase === 'crashed' && lock.state !== 'off') setLock('off', null);
        const lt = lock.targetId !== null ? world.find(lock.targetId) : undefined;
        const lcfg = rackFor(lt)?.cfg ?? racks.ground.cfg ?? racks.air.cfg;
        const ev = lcfg ? stepLock(lock, world, s.position, dt, lcfg) : null;
        if (ev === 'lock') world.emit({ type: 'lock', time, targetId: lock.targetId! });
        else if (ev === 'lost') world.emit({ type: 'lockLost', time, targetId: null });

        ctx.renderer?.getDrawingBufferSize?.(size);
        for (const k of ['ground', 'air'] as Kind[]) racks[k].render?.update(dt, size.y || 900);
        writeStatus(s);
      },

      onAction(a) {
        if (!anyMissiles() || !last) return;
        const s = last;
        if (a === 'lockTarget') {
          if (s.phase === 'crashed') return;
          const id = selectNextTarget(world, s.position, nose(s), selection(), lock.targetId, env, canShoot);
          if (id === null) setLock('off', null);
          else setLock('tracking', id);
          writeStatus(s);
        } else if (a === 'fireMissile') {
          if (lock.state !== 'locked' || lock.targetId === null || flying.length >= MAX_IN_FLIGHT) return;
          const t = world.find(lock.targetId);
          if (!t) return;
          const kind = kindOf(t);
          const rack = racks[kind];
          const cfg = rack.cfg;
          if (!cfg) return;
          const c = world.centreOf(t);
          const range = Math.hypot(c.x - s.position.x, c.y - s.position.y, c.z - s.position.z);
          if (range < cfg.minRangeM || range > cfg.maxRangeM) return;
          const station = rack.stores.findIndex((b) => b);
          if (station < 0) return;
          rack.stores[station] = false;
          const start = bodyToWorld(s, cfg.stations[station]);
          const m = launchArcadeMissile(nextId++, station, lock.targetId, start, nose(s), c, cfg);
          // A render slot not used by another missile of this type.
          const used = new Set(flying.filter((x) => x.kind === kind).map((x) => x.slot));
          let slot = 0;
          while (used.has(slot)) slot++;
          flying.push({ m, kind, slot, prev: { ...start } });
          renderer(kind);
          world.stats.missilesFired++;
          world.emit({ type: 'missileLaunch', time, missileId: m.id, station, position: { ...start }, velocity: { ...s.velocity } });
          writeStatus(s);
        }
      },

      onReset() {
        reload();
        world.resetStats();
        writeStatus(last);
      },

      onAircraftChange(d) {
        def = d;
        loadFrom(d);
        reload();
        writeStatus(last);
      },

      stats: () => ({
        inFlight: flying.length,
        stores: racks.ground.stores.join(''),
        airStores: racks.air.stores.join(''),
        lock: lock.state,
      }),

      dispose() {
        for (const k of ['ground', 'air'] as Kind[]) {
          racks[k].render?.dispose();
          racks[k].render = null;
        }
      },
    };
  },
};

export default mod;
