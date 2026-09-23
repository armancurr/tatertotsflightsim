/**
 * The missiles (arcade Mavericks): T picks the vehicle nearest the nose (again = the next one),
 * LOCK after a moment, Z launches from the next loaded rail, and the missile flies a scripted
 * curve to the target (src/combat/missile.ts) — then a direct hit plus blast. Writes the missile
 * and lock fields of the combat world's status (the weapons system writes the gun's) and emits
 * missileLaunch / detonation / lock / lockLost / reload for the fx, audio and HUD.
 */
import * as THREE from 'three';
import type { MissileConfig } from '../../config';
import type { AircraftState, Vec3 } from '../../types';
import { combatWorld } from '../../combat/world';
import { launchArcadeMissile, stepArcadeMissile, type ArcadeMissile } from '../../combat/missile';
import { newLock, selectNextTarget, stepLock, targetCentre } from '../../combat/targeting';
import { createMissileRenderer, type MissileRenderer } from '../../combat/missileRender';
import type { AircraftDef } from '../../fleet/types';
import type { SystemModule } from './types';

const MAX_IN_FLIGHT = 6;

const mod: SystemModule = {
  name: 'missiles',
  order: 71,
  create(ctx) {
    const world = combatWorld(ctx.scene);
    const env = ctx.env;
    let def: AircraftDef | undefined = ctx.actions?.currentAircraft?.();
    let cfg: MissileConfig | null = def?.config.weapons?.missiles ?? null;
    let stores: boolean[] = [];
    const lock = newLock();
    const flying: ArcadeMissile[] = [];
    let nextId = 1;
    let time = 0;
    let render: MissileRenderer | null = null;
    let last: AircraftState | null = null;
    const Q = new THREE.Quaternion();
    const V = new THREE.Vector3();
    const size = new THREE.Vector2();
    const prevPos: Vec3[] = Array.from({ length: MAX_IN_FLIGHT }, () => ({ x: 0, y: 0, z: 0 }));

    const ensureRenderer = () => {
      if (render || !cfg) return;
      render = createMissileRenderer({ length: cfg.lengthM, diameter: cfg.diameterM, slots: MAX_IN_FLIGHT });
      ctx.scene.add(render.object);
    };

    const setLock = (state: 'off' | 'tracking', id: number | null) => {
      const had = lock.state !== 'off' ? lock.targetId : null;
      lock.state = state;
      lock.targetId = id;
      lock.timer = 0;
      if (state === 'off' && had !== null) world.emit({ type: 'lockLost', time, targetId: had });
    };

    const reload = () => {
      flying.length = 0;
      render?.clear();
      stores = cfg ? cfg.stations.map(() => true) : [];
      world.status.stores = stores;
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

    const detonate = (m: ArcadeMissile) => {
      if (!cfg) return;
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
      const surface = targetId !== null ? 'target' : water !== null && p.y <= water + 1 ? 'water' : env.surfaceAt(p.x, p.z);
      world.emit({ type: 'detonation', time, weapon: 'missile', position: p, targetId, blastRadiusM: cfg.blastRadiusM, surface });
    };

    const writeStatus = (s: AircraftState | null) => {
      const st = world.status;
      st.hasMissiles = !!cfg && stores.length > 0;
      st.missileName = cfg?.name ?? '';
      st.maxMissiles = stores.length;
      st.missiles = stores.reduce((n, b) => n + (b ? 1 : 0), 0);
      st.stores = stores;
      st.missilesInFlight = flying.length;
      const L = st.lock;
      L.state = lock.state;
      L.targetId = lock.targetId;
      L.progress = lock.state === 'locked' ? 1 : cfg && lock.state === 'tracking' ? Math.min(1, lock.timer / cfg.lockTimeS) : 0;
      const c = lock.targetId !== null ? targetCentre(world, lock.targetId) : null;
      L.rangeM = c && s ? Math.hypot(c.x - s.position.x, c.y - s.position.y, c.z - s.position.z) : null;
      L.inRange = !!cfg && L.rangeM !== null && L.rangeM >= cfg.minRangeM && L.rangeM <= cfg.maxRangeM;
    };

    reload();

    return {
      update(f) {
        const s = f.state;
        last = s;
        if (f.def && f.def !== def) {
          def = f.def;
          cfg = def.config.weapons?.missiles ?? null;
          reload();
        }
        const dt = f.paused ? 0 : f.dt;
        time += dt;

        // Missiles in flight.
        for (let i = flying.length - 1; i >= 0; i--) {
          const m = flying[i];
          const slot = m.id % MAX_IN_FLIGHT;
          const from = prevPos[slot];
          from.x = m.pos.x;
          from.y = m.pos.y;
          from.z = m.pos.z;
          const t = m.targetId !== null ? world.find(m.targetId) : undefined;
          stepArcadeMissile(m, dt, t && t.alive ? targetCentre(world, t.id) : null);
          // A hill in the way: it hits the hill.
          const g = env.groundHeight(m.pos.x, m.pos.z);
          if (!m.arrived && m.pos.y < g + 0.2 && m.t / m.duration < 0.97) {
            m.pos.y = g;
            m.arrived = true;
            m.targetId = null;
          }
          render?.trail(from, m.pos);
          if (m.arrived) {
            detonate(m);
            render?.setMissile(slot, null);
            flying.splice(i, 1);
          } else render?.setMissile(slot, m.pos, m.dir);
        }
        // The lock (after the missiles, so a kill drops it this frame).
        if (s.phase === 'crashed' && lock.state !== 'off') setLock('off', null);
        const ev = cfg ? stepLock(lock, world, s.position, dt, cfg) : null;
        if (ev === 'lock') world.emit({ type: 'lock', time, targetId: lock.targetId! });
        else if (ev === 'lost') world.emit({ type: 'lockLost', time, targetId: null });

        if (render) {
          ctx.renderer?.getDrawingBufferSize?.(size);
          render.update(dt, size.y || 900);
        }
        writeStatus(s);
      },

      onAction(a) {
        if (!cfg || !last) return;
        const s = last;
        if (a === 'lockTarget') {
          if (s.phase === 'crashed') return;
          const id = selectNextTarget(world, s.position, nose(s), cfg, lock.targetId, env);
          if (id === null) setLock('off', null);
          else setLock('tracking', id);
          writeStatus(s);
        } else if (a === 'fireMissile') {
          if (lock.state !== 'locked' || lock.targetId === null || flying.length >= MAX_IN_FLIGHT) return;
          const c = targetCentre(world, lock.targetId);
          if (!c) return;
          const range = Math.hypot(c.x - s.position.x, c.y - s.position.y, c.z - s.position.z);
          if (range < cfg.minRangeM || range > cfg.maxRangeM) return;
          const station = stores.findIndex((b) => b);
          if (station < 0) return;
          stores[station] = false;
          const start = bodyToWorld(s, cfg.stations[station]);
          const m = launchArcadeMissile(nextId++, station, lock.targetId, start, nose(s), c, cfg);
          flying.push(m);
          ensureRenderer();
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
        cfg = d.config.weapons?.missiles ?? null;
        reload();
        writeStatus(last);
      },

      stats: () => ({ inFlight: flying.length, stores: stores.join(''), lock: lock.state, ...(render?.stats() ?? {}) }),

      dispose() {
        render?.dispose();
        render = null;
      },
    };
  },
};

export default mod;
