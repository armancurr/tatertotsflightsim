/**
 * Enemy aircraft to shoot down (owned by src/combat/air): MiG-29 pairs on racetrack CAPs around the
 * range, a Su-25 pair making attack passes at it, a Mi-24 pair circling low near it. They are
 * aircraft targets in the combat world (T locks them, Z fires a Sidewinder, the gun hits them),
 * break and pop flares when locked or shot at, fall burning when killed and leave a wreck, and a
 * replacement arrives `respawnS` later; everything comes back on reset (R). They never shoot back.
 *
 * Debug: `window.sim.airTargets` — list(), kill(idOrIndex, weapon?), threat(id, kind?),
 * watch(id | null, { dist, az, el, fov }) (a QA chase camera on one aircraft), stats().
 */
import { CONFIG } from '../../config';
import { combatWorld } from '../../combat/world';
import { fxHub } from '../../fx/hub';
import { createAirSquadron, type AirEntity } from '../../combat/air/squadron';
import { createAirRenderer } from '../../combat/air/renderer';
import type { PlayerInfo, ThreatKind } from '../../combat/air/pilot';
import { nightFactor, sunElevationDeg, syncLighting } from '../../world/traffic/daylight';
import type { SystemModule } from './types';

const DEG = Math.PI / 180;
const M_TO_FT = 3.280839895;
const MS_TO_KT = 1.943844;

const mod: SystemModule = {
  name: 'airTargets',
  order: 66,
  create(ctx) {
    const world = combatWorld(ctx.scene);
    const env = ctx.env;
    const squadron = createAirSquadron({
      world,
      ground: (x, z) => env.groundHeight(x, z),
      water: (x, z) => env.waterLevel(x, z),
      fx: () => fxHub(ctx.scene).effects?.sim ?? null,
      range: world.range,
      airport: { x: 0, z: 0 },
    });
    const renderer = createAirRenderer();
    ctx.scene.add(renderer.group);
    const player: PlayerInfo = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, fx: 0, fy: 0, fz: -1 };
    let anchored = false;
    let watch: { id: number; dist: number; az: number; el: number; fov: number } | null = null;
    let baseFov = 0;
    let updMs = 0;

    const find = (idOrIndex: number): AirEntity | undefined =>
      squadron.entities.find((e) => e.target.id === idOrIndex) ?? (Number.isInteger(idOrIndex) && idOrIndex >= 0 && idOrIndex < 100 ? squadron.live()[idOrIndex] : undefined);

    const debug = {
      list: () =>
        squadron.entities.map((e) => ({
          id: e.target.id, kind: e.kind, name: CONFIG.combat.targets[e.kind].name, group: e.group, phase: e.phase, alive: e.target.alive,
          x: Math.round(e.position.x), y: Math.round(e.position.y), z: Math.round(e.position.z),
          altFt: Math.round(e.position.y * M_TO_FT), aglFt: Math.round((e.position.y - env.groundHeight(e.position.x, e.position.z)) * M_TO_FT),
          speedKt: Math.round((e.fall ? Math.hypot(e.fall.vx, e.fall.vy, e.fall.vz) : e.flight.speed) * MS_TO_KT), headingDeg: Math.round(e.target.headingDeg), bankDeg: Math.round(e.flight.bank / DEG),
          mode: e.pilot.mode, bort: e.bort, lod: renderer.lodOf(e), fall: e.fall ? `${e.fall.mode}${e.fall.part ? `+${e.fall.part.which}` : ''}` : null,
          distM: Math.round(Math.hypot(e.position.x - player.x, e.position.y - player.y, e.position.z - player.z)),
        })),
      kill(idOrIndex: number, weapon: 'gun' | 'missile' = 'missile') {
        const e = find(idOrIndex);
        if (!e || !e.target.alive) return false;
        return world.applyHit(e.target.id, { weapon, damage: 1e6, point: { ...e.target.position }, direction: { x: 0, y: -1, z: 0 }, time: squadron.time, face: 'top' }).destroyed;
      },
      threat(idOrIndex: number, kind: ThreatKind = 'lock') {
        const e = find(idOrIndex);
        return !!e && squadron.threat(e.target.id, kind, { x: player.x, z: player.z });
      },
      /** A QA camera chasing one aircraft: `dist` m away, azimuth `az` deg from its tail (+ right), elevation `el` deg. null = off. */
      watch(idOrIndex: number | null, o: { dist?: number; az?: number; el?: number; fov?: number } = {}) {
        if (idOrIndex === null) {
          watch = null;
          return true;
        }
        const e = find(idOrIndex);
        if (!e) return false;
        watch = { id: e.target.id, dist: o.dist ?? 60, az: o.az ?? 20, el: o.el ?? 10, fov: o.fov ?? 45 };
        return true;
      },
      stats: () => ({ ...squadron.stats(), render: renderer.stats() }),
    };
    let debugInstalled = false;
    const installDebug = () => {
      if (debugInstalled) return;
      const sim = (globalThis as unknown as { sim?: Record<string, unknown> }).sim;
      if (sim) {
        sim.airTargets = debug;
        debugInstalled = true;
      }
    };

    return {
      update(f) {
        const t0 = performance.now();
        installDebug();
        const s = f.state;
        player.x = s.position.x;
        player.y = s.position.y;
        player.z = s.position.z;
        player.vx = s.velocity.x;
        player.vy = s.velocity.y;
        player.vz = s.velocity.z;
        const q = s.orientation;
        // nose = body −Z rotated into the world
        player.fx = -2 * (q.x * q.z + q.w * q.y);
        player.fy = -2 * (q.y * q.z - q.w * q.x);
        player.fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
        const crashed = s.phase === 'crashed';
        if (!anchored) {
          squadron.reset(player);
          anchored = true;
        }
        squadron.update(f.paused ? 0 : f.dt, crashed ? null : player);

        // QA chase camera.
        if (watch) {
          const e = squadron.entities.find((x) => x.target.id === watch!.id);
          if (e) {
            const h = e.target.headingDeg * DEG + watch.az * DEG;
            const el = watch.el * DEG;
            const cx = e.position.x - Math.sin(h) * Math.cos(el) * watch.dist;
            const cz = e.position.z + Math.cos(h) * Math.cos(el) * watch.dist;
            const cy = Math.max(e.position.y + Math.sin(el) * watch.dist, env.groundHeight(cx, cz) + 3);
            if (!baseFov) baseFov = f.camera.fov;
            f.camera.position.set(cx, cy, cz);
            f.camera.up.set(0, 1, 0);
            f.camera.lookAt(e.position.x, e.position.y, e.position.z);
            f.camera.fov = watch.fov;
            f.camera.updateProjectionMatrix();
            f.camera.updateMatrixWorld();
          }
        } else if (baseFov) {
          baseFov = 0;
        }

        const atmo = ctx.atmosphere;
        if (atmo) syncLighting(renderer.shared, atmo.sunDirection, atmo.state?.sunAtCamera, atmo.state?.skyIrradiance);
        const night = atmo ? nightFactor(sunElevationDeg(atmo.sunDirection.y)) : 0;
        renderer.update({ camera: f.camera, time: f.time, night, viewportHeight: ctx.renderer?.domElement?.height || 900 }, squadron.entities, squadron.flares);
        updMs += (performance.now() - t0 - updMs) * 0.05;
      },
      onReset(which) {
        // R / Shift+R bring everyone back; a teleport leaves them flying (the range's revive of the
        // world's targets is undone for our wrecks by the squadron itself).
        if (which !== 'teleport') anchored = false;
      },
      onAircraftChange() {
        anchored = false;
      },
      stats: () => ({ ...squadron.stats(), render: renderer.stats(), ms: +updMs.toFixed(3) }),
      dispose() {
        squadron.dispose();
        renderer.dispose();
        const sim = (globalThis as unknown as { sim?: Record<string, unknown> }).sim;
        if (sim && sim.airTargets === debug) delete sim.airTargets;
      },
    };
  },
};
export default mod;
