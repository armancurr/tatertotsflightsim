/**
 * The target range (owned by src/combat/targets): finds the site (main thread, cheap) and sets
 * `combatWorld.range` at once (so `?spawn=range` works), lays the range out in a worker, then
 * registers the vehicles with the combat world, draws them (instanced, LODs) and plays their
 * wrecks (turret toss, charring, fire + smoke column, cook-offs). Reset (R / Shift+R / teleport)
 * revives everything where it started. Debug: `window.sim.combatDebug` (kill / hit / list / look).
 */
import { combatWorld } from '../../combat/world';
import { fxHub } from '../../fx/hub';
import { groundFromEnv } from '../../combat/targets/ground';
import { findRangeSite } from '../../combat/targets/site';
import { planRange, type RangePlan } from '../../combat/targets/plan';
import { createRangeGround } from '../../combat/targets/groundQuery';
import { createTargetsRenderer, type TargetsRenderer } from '../../combat/targets/renderer';
import { createRangeRuntime } from '../../combat/targets/runtime';
import type { TargetKind } from '../../combat/types';
import type { SystemModule } from './types';

const mod: SystemModule = {
  name: 'targets',
  order: 65,
  create(ctx) {
    const world = combatWorld(ctx.scene);
    const env = ctx.env;
    const t0 = performance.now();
    const site = findRangeSite(groundFromEnv(env));
    world.range = { x: site.x, z: site.z, headingDeg: site.headingDeg };
    const siteMs = performance.now() - t0;

    const runtime = createRangeRuntime(world, { height: (x, z) => env.groundHeight(x, z), normal: (x, z) => env.groundNormal(x, z) }, () => fxHub(ctx.scene).effects?.sim ?? null);
    let renderer: TargetsRenderer | null = null;
    let plan: RangePlan | null = null;
    let planMs = 0;
    let installed = false;
    let worker: Worker | null = null;
    let debugCam: { x: number; y: number; z: number; tx: number; ty: number; tz: number; fov: number } | null = null;

    const planned = new Promise<RangePlan | null>((resolve) => {
      const p0 = performance.now();
      const done = (p: RangePlan | null) => {
        planMs = performance.now() - p0;
        plan = p;
        resolve(p);
      };
      try {
        if (typeof Worker === 'undefined') throw new Error('no worker');
        worker = new Worker(new URL('../../combat/targets/layout.worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (e: MessageEvent) => {
          const m = e.data as { ok: boolean; plan?: RangePlan; message?: string };
          if (!m.ok) console.error('[targets] layout worker:', m.message);
          done(m.ok ? m.plan! : null);
          worker?.terminate();
          worker = null;
        };
        worker.onerror = (err) => {
          console.error('[targets] layout worker error', err.message);
          done(null);
        };
        worker.postMessage({ x: site.x, z: site.z, headingDeg: site.headingDeg });
      } catch {
        // no worker (tests): lay it out inline
        setTimeout(() => done(planRange(createRangeGround(site), site)), 0);
      }
    });

    const install = () => {
      if (installed || !plan) return;
      installed = true;
      runtime.install(plan);
      const counts: Partial<Record<TargetKind, number>> = {};
      for (const v of plan.vehicles) counts[v.kind] = (counts[v.kind] ?? 0) + 1;
      renderer = createTargetsRenderer(counts, { berms: plan.berms, ground: (x, z) => env.groundHeight(x, z) });
      ctx.scene.add(renderer.group);
    };

    const debug = {
      list: () => runtime.vehicles.map((v) => ({ id: v.target.id, kind: v.target.kind, group: v.target.group, alive: v.target.alive, health: v.target.health, x: v.target.position.x, y: v.target.position.y, z: v.target.position.z, headingDeg: v.target.headingDeg })),
      kill(id: number, weapon: 'gun' | 'missile' = 'missile') {
        const t = world.find(id);
        if (!t || !t.alive) return false;
        return world.applyHit(id, { weapon, damage: 1e6, point: { ...t.position }, direction: { x: 0, y: -1, z: 0 }, time: runtime.time(), face: 'top' }).destroyed;
      },
      hit(id: number, damage: number) {
        const t = world.find(id);
        if (!t) return null;
        return world.applyHit(id, { weapon: 'missile', damage, point: { ...t.position }, direction: { x: 0, y: -1, z: 0 }, time: runtime.time(), face: 'top' });
      },
      killAll(kind?: TargetKind) {
        let n = 0;
        for (const v of runtime.vehicles) if ((!kind || v.target.kind === kind) && debug.kill(v.target.id)) n++;
        return n;
      },
      /** QA camera: look from (x,y,z) at (tx,ty,tz) (null = back to the game camera). */
      look(x: number | null, y = 0, z = 0, tx = 0, ty = 0, tz = 0, fov = 40) {
        debugCam = x === null ? null : { x, y, z, tx, ty, tz, fov };
      },
      stats: () => ({ ...runtime.stats(), draws: renderer?.activeMeshes() ?? 0, counts: renderer?.counts() ?? {}, convoy: runtime.convoy ? { phase: runtime.convoy.phase(), dir: runtime.convoy.dir() } : null }),
      /** The march column's units (s, lat, speed, mode) for QA. */
      convoy: () => runtime.convoy?.units.map((u) => ({ slot: u.slot, kind: u.kind, alive: u.alive, mode: u.mode, s: +u.s.toFixed(1), lat: +u.lat.toFixed(1), speed: +u.speed.toFixed(2), x: u.x, z: u.z })) ?? [],
      plan: () => plan,
      meshes: () => renderer?.group.children.map((c) => ({ name: c.name, visible: c.visible, count: (c as { count?: number }).count ?? null })) ?? [],
    };
    let debugInstalled = false;
    const installDebug = () => {
      if (debugInstalled) return;
      const sim = (globalThis as unknown as { sim?: Record<string, unknown> }).sim;
      if (sim) {
        sim.combatDebug = debug;
        debugInstalled = true;
      }
    };
    const baseFov = { v: 0 };

    return {
      async ready() {
        await planned;
        install();
      },
      update(f) {
        installDebug();
        if (!installed && plan) install();
        if (!installed || !renderer) return;
        runtime.update(f.paused ? 0 : f.dt);
        if (debugCam) {
          if (!baseFov.v) baseFov.v = f.camera.fov;
          f.camera.position.set(debugCam.x, debugCam.y, debugCam.z);
          f.camera.lookAt(debugCam.tx, debugCam.ty, debugCam.tz);
          f.camera.fov = debugCam.fov;
          f.camera.updateProjectionMatrix();
          f.camera.updateMatrixWorld();
        }
        renderer.update(f.camera, runtime.views, ctx.atmosphere.sunDirection, f.time);
      },
      onReset() {
        runtime.reset();
      },
      stats: () => ({
        site: { x: Math.round(site.x), z: Math.round(site.z), bearing: Math.round(site.bearingDeg), open: +site.open.toFixed(2), ms: +siteMs.toFixed(1) },
        planMs: Math.round(planMs),
        plan: plan ? { ...(plan as RangePlan).stats, track: (plan as RangePlan).track?.kind ?? 'none', vehicles: (plan as RangePlan).vehicles.length } : null,
        ...runtime.stats(),
        draws: renderer?.activeMeshes() ?? 0,
      }),
      dispose() {
        worker?.terminate();
        runtime.dispose();
        renderer?.dispose();
        world.removeAll();
      },
    };
  },
};
export default mod;
