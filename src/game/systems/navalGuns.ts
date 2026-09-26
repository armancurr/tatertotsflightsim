/**
 * A ship's main battery as a game feature (the USS Iowa's nine 16-inch/50 guns): active for any
 * vehicle whose config has `weapons.naval` (dev harness: any vessel with `?naval=iowa`), inert
 * otherwise. On the pure fire control (src/combat/navalFireControl.ts):
 *
 *   aim      where the view ray under the mouse pointer meets the sea (or the land) — drag the view
 *            to look around, point at the water, the turrets train onto it; without a pointer, the
 *            ray through the screen centre. Z toggles the rangefinder: the view turns to look along the
 *            pointer's ray, narrowed ×5 (drag to pan it), so a point 10–20 km off can be picked
 *            precisely; Z again gives the normal view back. T locks the next combat target within
 *            reach (nearest the view first; again = the next; past the last = free aim). The solution
 *            leads a moving target and allows for the ship's speed, roll and pitch.
 *   fire     Q (the gun trigger's press) calls a salvo: every loaded gun of every turret ON TARGET,
 *            rippled gun after gun. Each gun reloads in 30 s; 130 rounds a gun.
 *   effects  the muzzle blast (flash, fireball, the brown smoke cloud, the pressure wave flattening
 *            the sea), glowing shells to follow the fall of shot, water columns / bursts / fires where
 *            they land (src/combat/navalFx.ts + render/navalFxRender.ts), camera shake as each blast
 *            reaches the camera at the speed of sound, the flash lighting the scene.
 *   status   `combat.status.turrets` (train, elevation, recoil, flash, ready per gun) every frame —
 *            the ship's 3D model animates from it; the naval HUD and sound read `navalHub(scene)`.
 *
 * Dev harness: with `?naval=iowa` on a vessel that has no turret model (the V50), grey stand-in
 * turrets are drawn at the configured positions so the training and recoil can be seen.
 * QA: `window.sim.naval` — state(), aimAt(x, z), lock(id | null), fire(), watch(x, y, z, tx, ty, tz)
 * (a parked QA camera, null = back), next().
 */
import * as THREE from 'three';
import { CONFIG, type NavalGunsConfig } from '../../config';
import { combatWorld } from '../../combat/world';
import { navalGunsOf, rangeTable, muzzlePosition, gunLateral, gunDirection } from '../../combat/naval';
import { createNavalController, type NavalController, type SalvoRefusal } from '../../combat/navalFireControl';
import { NavalFxSim } from '../../combat/navalFx';
import { createNavalFxRenderer } from '../../combat/render/navalFxRender';
import { createGlowRenderer } from '../../combat/render/glow';
import { navalHub } from '../../combat/navalHub';
import { surfaceHeight } from '../../combat/ground';
import { fxHub } from '../../fx/hub';
import { smokeLighting } from '../../fx/effects';
import { uiBusFor } from '../../ui/uiBus';
import type { AircraftDef, AircraftModelHandle } from '../../fleet/types';
import type { GroundTarget, SeaKind } from '../../combat/types';
import type { SystemModule } from './types';

const SEA_KINDS: readonly SeaKind[] = ['raft', 'hulk', 'sled'];
const REFUSAL_TEXT: Record<Exclude<SalvoRefusal, null>, string> = {
  'no-aim': 'NO SOLUTION',
  'out-of-range': 'OUT OF RANGE',
  'no-bearing': 'NO GUNS BEAR',
  training: 'TRAINING',
  reloading: 'RELOADING',
  empty: 'MAGAZINES EMPTY',
};

/** Grey stand-in turrets for the dev harness (a vessel without a turret model). */
function createStandIn(guns: NavalGunsConfig) {
  const group = new THREE.Group();
  group.name = 'naval-standin';
  const mat = new THREE.MeshStandardMaterial({ color: 0x7c848c, roughness: 0.7, metalness: 0.2 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x3a3f44, roughness: 0.6, metalness: 0.3 });
  const turrets = guns.turrets.map((t) => {
    const base = new THREE.Mesh(new THREE.CylinderGeometry(6, 6.5, Math.max(0.5, t.position.y), 24), dark);
    base.position.set(t.position.x, t.position.y / 2, t.position.z);
    group.add(base);
    const house = new THREE.Group();
    house.position.set(t.position.x, t.position.y, t.position.z);
    const shell = new THREE.Mesh(new THREE.BoxGeometry(12.5, 3.6, 15), mat);
    shell.position.set(0, 1.8, 1.8);
    house.add(shell);
    const barrels = Array.from({ length: t.barrels }, (_, k) => {
      const pivot = new THREE.Group();
      pivot.position.set(gunLateral(t, k), t.trunnionHeight, -t.trunnionForward);
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.62, t.barrelLength, 12), dark);
      tube.rotation.x = -Math.PI / 2;
      tube.position.z = -t.barrelLength / 2;
      pivot.add(tube);
      house.add(pivot);
      return { pivot, tube };
    });
    group.add(house);
    return { house, barrels };
  });
  return {
    group,
    update(status: { trainDeg: number; elevDeg: number; recoil: number[] }[]) {
      turrets.forEach((t, i) => {
        const s = status[i];
        if (!s) return;
        t.house.rotation.y = (-s.trainDeg * Math.PI) / 180;
        t.barrels.forEach((b, k) => {
          b.pivot.rotation.x = (s.elevDeg * Math.PI) / 180;
          b.tube.position.z = -guns.turrets[i].barrelLength / 2 + (s.recoil[k] ?? 0) * 1.2;
        });
      });
    },
    dispose() {
      group.removeFromParent();
      group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      mat.dispose();
      dark.dispose();
    },
  };
}

const mod: SystemModule = {
  name: 'navalGuns',
  order: 72,
  create(ctx) {
    const world = combatWorld(ctx.scene);
    const hub = navalHub(ctx.scene);
    const env = ctx.env;
    let def: AircraftDef | null = null;
    try {
      def = ctx.actions?.currentAircraft?.() ?? null;
    } catch {
      def = null;
    }
    let guns: NavalGunsConfig | null = navalGunsOf(def);
    let ctl: NavalController | null = null;
    let model: AircraftModelHandle | null = ctx.aircraft ?? null;
    let standIn: ReturnType<typeof createStandIn> | null = null;
    const fx = new NavalFxSim();
    let fxr: ReturnType<typeof createNavalFxRenderer> | null = null;
    let glow: ReturnType<typeof createGlowRenderer> | null = null;
    const doc = ctx.hudRoot?.ownerDocument ?? (typeof document !== 'undefined' ? document : null);
    const bus = doc ? uiBusFor(doc) : null;
    let time = 0;
    let lastTrigger = false;
    let lockId: number | null = null;
    let scriptAim: { x: number; y: number; z: number } | null = null;
    let qaCam: { x: number; y: number; z: number; tx: number; ty: number; tz: number } | null = null;
    /** Rangefinder zoom: the wanted and the eased factor (the camera's FOV ÷ zoom). */
    let zoomWant = 1;
    let zoom = 1;
    /** The rangefinder's look direction (world yaw about +Y from −Z, pitch, rad), taken from the pointer's ray when it opens. */
    let binoYaw = 0;
    let binoPitch = 0;
    let baseFov = 60;
    let binoPending = false;
    const DEG = Math.PI / 180;
    const binoEuler = new THREE.Euler(0, 0, 0, 'YXZ');

    const harnessWanted = () => !!guns && !def?.config?.weapons?.naval;

    const setup = () => {
      guns = navalGunsOf(def);
      ctl = guns ? createNavalController(world, env, guns) : null;
      hub.guns = guns;
      hub.battery = ctl?.battery ?? null;
      hub.solutions = ctl?.solutions ?? [];
      hub.shells = ctl?.shells ?? null;
      hub.falls.length = 0;
      hub.harness = false;
      lockId = null;
      scriptAim = null;
      if (guns) {
        rangeTable(guns); // build the table now, not on the first aim
        world.status.turrets = ctl!.battery.status;
        if (!fxr && ctx.renderer) {
          fxr = createNavalFxRenderer(ctx.scene);
          glow = createGlowRenderer(ctx.scene, 128);
        }
      } else {
        delete world.status.turrets;
      }
      standIn?.dispose();
      standIn = null;
      if (guns && harnessWanted() && model?.root) {
        standIn = createStandIn(guns);
        model.root.add(standIn.group);
        hub.harness = true;
      }
    };
    setup();

    // ── the mouse pointer (NDC over the canvas) ──
    const pointer = { x: 0, y: 0, inside: false, seen: false };
    const canvas = ctx.renderer?.domElement ?? null;
    const win = (doc?.defaultView ?? (typeof window !== 'undefined' ? window : null)) as Window | null;
    const onPointer = (e: PointerEvent) => {
      if (!canvas) return;
      // dragging in the rangefinder pans it, one to one with the narrowed view
      if (zoomWant > 1 && e.type === 'pointermove' && e.buttons & 1 && Number.isFinite(e.movementX + e.movementY)) {
        const h = Math.max(1, canvas.clientHeight || 900);
        const degPerPx = (baseFov / zoom) / h;
        binoYaw -= e.movementX * degPerPx * DEG;
        binoPitch = Math.max(-60 * DEG, Math.min(60 * DEG, binoPitch - e.movementY * degPerPx * DEG));
      }
      const r = canvas.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return;
      pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      pointer.y = -(((e.clientY - r.top) / r.height) * 2 - 1);
      pointer.inside = pointer.x >= -1 && pointer.x <= 1 && pointer.y >= -1 && pointer.y <= 1;
      pointer.seen = true;
    };
    const onLeave = () => (pointer.inside = false);
    win?.addEventListener?.('pointermove', onPointer);
    win?.addEventListener?.('pointerdown', onPointer);
    doc?.addEventListener?.('pointerleave', onLeave);

    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const aimPoint = { x: 0, y: 0, z: 0 };
    /** Where the ray from the camera through (ndc) first meets the sea / land, or the max-range point along its bearing. */
    const castAim = (camera: THREE.Camera, sx: number, sz: number, maxRange: number): boolean => {
      ndc.set(pointer.inside ? pointer.x : 0, pointer.inside ? pointer.y : 0);
      ray.setFromCamera(ndc, camera);
      const o = ray.ray.origin;
      const d = ray.ray.direction;
      const far = maxRange * 1.25 + Math.hypot(o.x - sx, o.z - sz);
      // march along the ray against the surface (sea level or terrain), coarse then bisect
      let tPrev = 0;
      let step = 4;
      let t = step;
      const above = (tt: number) => o.y + d.y * tt > surfaceHeight(env, o.x + d.x * tt, o.z + d.z * tt);
      if (above(0)) {
        while (t < far) {
          if (!above(t)) {
            let lo = tPrev;
            let hi = t;
            for (let k = 0; k < 18; k++) {
              const m = 0.5 * (lo + hi);
              if (above(m)) lo = m;
              else hi = m;
            }
            aimPoint.x = o.x + d.x * hi;
            aimPoint.z = o.z + d.z * hi;
            aimPoint.y = surfaceHeight(env, aimPoint.x, aimPoint.z);
            return true;
          }
          tPrev = t;
          step = Math.min(250, step * 1.35);
          t += step;
        }
      }
      // above the horizon (or no surface in reach): the max-range point along the ray's bearing, from the ship
      const hx = d.x, hz = d.z;
      const hl = Math.hypot(hx, hz);
      if (hl < 1e-6) return false;
      aimPoint.x = sx + (hx / hl) * maxRange * 1.04;
      aimPoint.z = sz + (hz / hl) * maxRange * 1.04;
      aimPoint.y = Math.max(0, surfaceHeight(env, aimPoint.x, aimPoint.z));
      return true;
    };

    const say = (text: string, level: 'info' | 'warn' | 'good' = 'info', seconds = 1.6) => {
      hub.message.text = text;
      hub.message.level = level;
      hub.message.until = time + seconds;
    };

    /** Targets T can lock: alive, not aircraft, within the guns' reach of the ship; nearest the view first. */
    const lockable = (camera: THREE.Camera, sx: number, sz: number): GroundTarget[] => {
      if (!guns) return [];
      const maxR = rangeTable(guns).maxRangeM;
      const e = camera.matrixWorld.elements;
      const fx0 = -e[8], fz0 = -e[10];
      const cx = e[12], cz = e[14];
      const fl = Math.hypot(fx0, fz0) || 1;
      const out: { t: GroundTarget; a: number }[] = [];
      for (const t of world.targets) {
        if (!t.alive || world.isAir(t)) continue;
        const r = Math.hypot(t.position.x - sx, t.position.z - sz);
        if (r > maxR || r < 300) continue;
        const vx = t.position.x - cx, vz = t.position.z - cz;
        const vl = Math.hypot(vx, vz) || 1;
        const a = Math.acos(Math.max(-1, Math.min(1, (vx * fx0 + vz * fz0) / (vl * fl))));
        out.push({ t, a: a + (SEA_KINDS.includes(t.kind as SeaKind) ? 0 : 0.05) });
      }
      return out.sort((p, q) => p.a - q.a).map((o) => o.t);
    };
    let lastCamera: THREE.Camera | null = null;
    const lastShip = { x: 0, z: 0 };
    const cycleLock = () => {
      if (!guns || !lastCamera) return;
      const list = lockable(lastCamera, lastShip.x, lastShip.z);
      if (!list.length) {
        lockId = null;
        say('NO TARGETS IN RANGE', 'warn');
        return;
      }
      const cur = lockId === null ? -1 : list.findIndex((t) => t.id === lockId);
      if (lockId !== null && cur === list.length - 1) {
        lockId = null;
        say('FREE AIM');
        return;
      }
      const next = list[cur + 1] ?? list[0];
      lockId = next.id;
      say(`TARGET: ${world.classOf(next.kind).name.toUpperCase()}`, 'good');
    };

    // kills by the ship's shells → a toast
    const offWorld = world.on((e) => {
      if (!guns) return;
      if (e.type === 'destroyed' && e.weapon === 'shell') {
        bus?.emit('toast', { text: `${world.classOf(e.kind).name} destroyed — 16-inch`, level: 'good', seconds: 3 });
        if (e.targetId === lockId) lockId = null;
      }
    });

    const SUN = new THREE.Color();
    const AMB = new THREE.Color();
    const vp = new THREE.Vector2();
    const camPos = new THREE.Vector3();
    const pose = { position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 }, velocity: { x: 0, y: 0, z: 0 } };
    const M = { x: 0, y: 0, z: 0 };
    const FP = new THREE.Vector3();
    const BQ = new THREE.Quaternion();
    const FD = new THREE.Vector3();
    const SUN_DEFAULT = new THREE.Vector3(0.3, 0.8, -0.4);

    const api = {
      state: () => ({
        active: !!guns,
        harness: hub.harness,
        aim: { ...hub.aim, point: { ...hub.aim.point } },
        turrets: ctl?.battery.turrets.map((t, i) => ({
          name: t.cfg.name, trainDeg: +t.trainDeg.toFixed(2), elevDeg: +t.elevDeg.toFixed(2), order: [t.orderTrain === null ? null : +t.orderTrain.toFixed(2), t.orderElev === null ? null : +t.orderElev.toFixed(2)], ffE: +t.orderElevRate.toFixed(2), inArc: t.inArc, onTarget: t.onTarget,
          missM: Number.isFinite(t.missM) ? Math.round(t.missM) : null, loaded: t.guns.map((g) => g.loaded), rounds: t.guns.map((g) => g.rounds),
          solution: { ok: ctl!.solutions[i].ok, elevDeg: +ctl!.solutions[i].elevDeg.toFixed(3), tofS: +ctl!.solutions[i].tofS.toFixed(1), rangeM: Math.round(ctl!.solutions[i].rangeM) },
        })) ?? [],
        shells: ctl?.shells.count ?? 0,
        falls: hub.falls.slice(-9),
        stats: ctl?.stats() ?? null,
        fx: fx.stats(),
        message: hub.message.text,
      }),
      aimAt(x: number | null, z = 0) {
        scriptAim = x === null ? null : { x, y: Math.max(0, surfaceHeight(env, x, z)), z };
        if (x !== null) lockId = null;
      },
      lock(id: number | null) {
        lockId = id;
        if (id !== null) scriptAim = null;
      },
      next: () => cycleLock(),
      fire: () => {
        const r = ctl?.fire() ?? { scheduled: 0, armed: 0, refusal: 'no-aim' as const };
        if (r.scheduled === 0 && r.armed === 0 && r.refusal) say(REFUSAL_TEXT[r.refusal], 'warn');
        return r;
      },
      /** QA: play an effect at (x, z) without firing: 'splash' | 'burst' | 'blast' (a muzzle blast pointing north). */
      demo(kind: 'splash' | 'burst' | 'blast', x: number, z: number) {
        const seaY = CONFIG.world.seaLevel;
        if (kind === 'splash') fx.waterColumn(x, seaY, z, 1);
        else if (kind === 'burst') fx.burst(x, seaY + 2, z, true, 1);
        else fx.muzzleBlast(x, seaY + 12, z, 0, 0.08, -1, 0, 0, 0, 1, seaY);
        return fx.stats();
      },
      /** QA: the live effect particles by kind (count, mean height, mean size, mean alpha). */
      particles() {
        const out: Record<number, { n: number; y: number; size: number; alpha: number }> = {};
        for (let i = 0; i < fx.cap; i++) {
          if (!fx.alive[i]) continue;
          const o = (out[fx.kind[i]] ??= { n: 0, y: 0, size: 0, alpha: 0 });
          o.n++;
          o.y += (fx.py[i] - o.y) / o.n;
          o.size += (fx.sizeOf(i) - o.size) / o.n;
          o.alpha += (fx.alphaOf(i) - o.alpha) / o.n;
        }
        return out;
      },
      watch(x: number | null, y = 0, z = 0, tx = 0, ty = 0, tz = 0) {
        qaCam = x === null ? null : { x, y, z, tx, ty, tz };
      },
    };
    let apiInstalled = false;

    return {
      update(f) {
        if (!apiInstalled) {
          const sim = (globalThis as unknown as { sim?: Record<string, unknown> }).sim;
          if (sim) {
            sim.naval = api;
            apiInstalled = true;
          }
        }
        time = f.time;
        hub.time = time;
        if (f.def && f.def !== def) {
          def = f.def;
          model = f.aircraft;
          setup();
        }
        const dt = f.paused ? 0 : f.dt;
        if (qaCam) {
          f.camera.position.set(qaCam.x, qaCam.y, qaCam.z);
          f.camera.lookAt(qaCam.tx, qaCam.ty, qaCam.tz);
          f.camera.updateMatrixWorld();
        }
        // the rangefinder: look along the pointer's ray with a narrowed view (the camera rig puts its own
        // orientation and FOV back every frame, so leaving it needs nothing)
        baseFov = f.camera.fov;
        if (binoPending) {
          binoPending = false;
          ndc.set(pointer.inside ? pointer.x : 0, pointer.inside ? pointer.y : 0);
          ray.setFromCamera(ndc, f.camera);
          const d = ray.ray.direction;
          binoYaw = Math.atan2(-d.x, -d.z);
          binoPitch = Math.asin(Math.max(-1, Math.min(1, d.y)));
        }
        zoom += (zoomWant - zoom) * (1 - Math.exp(-Math.max(0, f.dt) / 0.12));
        if (Math.abs(zoom - zoomWant) < 1e-3) zoom = zoomWant;
        hub.zoom = zoom;
        if (zoom > 1.001 && guns) {
          f.camera.fov /= zoom;
          f.camera.updateProjectionMatrix();
          // swing from the rig's view to the rangefinder's as the zoom comes in
          const k = Math.min(1, (zoom - 1) / Math.max(1e-3, 5 - 1));
          binoEuler.set(binoPitch, binoYaw, 0, 'YXZ');
          BQ.setFromEuler(binoEuler);
          f.camera.quaternion.slerp(BQ, k);
          f.camera.updateMatrixWorld();
        }
        lastCamera = f.camera;
        f.camera.getWorldPosition(camPos);

        if (ctl && guns) {
          const r = f.aircraft.root;
          pose.position.x = r.position.x; pose.position.y = r.position.y; pose.position.z = r.position.z;
          pose.orientation.x = r.quaternion.x; pose.orientation.y = r.quaternion.y; pose.orientation.z = r.quaternion.z; pose.orientation.w = r.quaternion.w;
          pose.velocity.x = f.state.velocity.x; pose.velocity.y = f.state.velocity.y; pose.velocity.z = f.state.velocity.z;
          lastShip.x = pose.position.x;
          lastShip.z = pose.position.z;
          const crashed = f.state.phase === 'crashed';
          // aim: locked target → script → the view ray
          const maxR = rangeTable(guns).maxRangeM;
          let aimOk = false;
          let aimVel: { x: number; y: number; z: number } | null = null;
          if (lockId !== null) {
            const t = world.find(lockId);
            if (t && t.alive) {
              const c = world.centreOf(t);
              aimPoint.x = c.x; aimPoint.y = c.y; aimPoint.z = c.z;
              aimVel = t.velocity;
              aimOk = true;
              hub.aim.source = 'target';
            } else lockId = null;
          }
          if (!aimOk && scriptAim) {
            aimPoint.x = scriptAim.x; aimPoint.y = scriptAim.y; aimPoint.z = scriptAim.z;
            aimOk = true;
            hub.aim.source = 'script';
          }
          if (!aimOk) {
            aimOk = castAim(f.camera, pose.position.x, pose.position.z, maxR);
            hub.aim.source = pointer.inside ? 'pointer' : 'view';
          }
          ctl.setAim(aimOk && !crashed ? aimPoint : null, aimVel, lockId);
          // Q: a salvo on the trigger's press
          const trig = !!f.controls.trigger && !f.paused && !crashed;
          if (trig && !lastTrigger) {
            const res = ctl.fire();
            if (res.scheduled > 0) say(res.scheduled >= 6 ? 'SALVO' : `${res.scheduled} GUN${res.scheduled > 1 ? 'S' : ''}`, 'good', 1.2);
            else if (res.armed > 0) say('STANDBY — FIRING ON TARGET', 'info', 2);
            else if (res.refusal) say(REFUSAL_TEXT[res.refusal], 'warn');
          }
          lastTrigger = trig;
          const seaY = CONFIG.world.seaLevel;
          ctl.update(pose, dt, time, (shot) => {
            const sc = guns!.caliberMm / 406;
            fx.muzzleBlast(shot.muzzle.x, shot.muzzle.y, shot.muzzle.z, shot.dir.x, shot.dir.y, shot.dir.z, pose.velocity.x, pose.velocity.y, pose.velocity.z, sc, seaY);
            fxHub(ctx.scene).effects?.sim.flash(shot.muzzle.x + shot.dir.x * 30, shot.muzzle.y + shot.dir.y * 30, shot.muzzle.z + shot.dir.z * 30, 1.4);
          }, (imp) => {
            const hitSea = imp.surface === 'water';
            const target = imp.targetId !== null ? world.find(imp.targetId) : undefined;
            const onSea = !!target && SEA_KINDS.includes(target.kind as SeaKind);
            if (hitSea) fx.waterColumn(imp.x, seaY, imp.z, guns!.caliberMm / 406);
            else {
              fx.burst(imp.x, imp.y, imp.z, onSea, guns!.caliberMm / 406);
              const g = onSea ? seaY : surfaceHeight(env, imp.x, imp.z);
              fxHub(ctx.scene).effects?.sim.explosion(imp.x, Math.max(imp.y, g + 1), imp.z, g, 2);
            }
            hub.falls.push({ x: imp.x, y: imp.y, z: imp.z, t: time, hit: imp.targetId !== null });
            if (hub.falls.length > 36) hub.falls.shift();
          });
          // what the HUD quotes: the reference turret's solution
          const ref = ctl.referenceTurret();
          const a = hub.aim;
          a.valid = ctl.aim.valid;
          a.point.x = aimPoint.x; a.point.y = aimPoint.y; a.point.z = aimPoint.z;
          a.targetId = lockId;
          if (ref >= 0) {
            const s = ctl.solutions[ref];
            a.rangeM = s.rangeM;
            a.bearingDeg = s.bearingDeg;
            a.tofS = s.tofS;
            a.tooFar = s.tooFar;
            a.tooClose = s.tooClose;
          } else {
            a.rangeM = Math.hypot(aimPoint.x - pose.position.x, aimPoint.z - pose.position.z);
            a.bearingDeg = ((Math.atan2(aimPoint.x - pose.position.x, -(aimPoint.z - pose.position.z)) * 180) / Math.PI + 360) % 360;
            a.tofS = 0;
            a.tooFar = a.rangeM > maxR;
            a.tooClose = false;
          }
          world.status.turrets = ctl.battery.status;
          standIn?.update(ctl.battery.status);
        }

        // effects: always stepped (smoke from the last salvo lingers after a vehicle change)
        const w = env.wind?.(camPos.x, 20, camPos.z, f.time);
        fx.step(dt, w ? w.x : 0, w ? w.z : 0, CONFIG.world.seaLevel);
        if (fxr) {
          const atmo = ctx.atmosphere;
          if (atmo?.sunLight && atmo.state) smokeLighting(atmo.sunLight.color, atmo.sunLight.intensity, atmo.state.skyIrradiance, atmo.state.groundRadiance, SUN, AMB);
          else {
            SUN.setRGB(1, 1, 1);
            AMB.setRGB(0.4, 0.45, 0.5);
          }
          fxr.update(fx, f.camera, SUN, AMB, atmo?.sunDirection ?? SUN_DEFAULT, f.waveTime);
        }
        if (glow) {
          glow.begin();
          const shells = ctl?.shells;
          if (shells && guns) {
            for (const s of shells.shells) {
              if (!s.live) continue;
              const sp = Math.hypot(s.vx, s.vy, s.vz) || 1;
              const L = Math.min(70, sp * 0.1);
              glow.add(s.x, s.y, s.z, s.x - (s.vx / sp) * L, s.y - (s.vy / sp) * L, s.z - (s.vz / sp) * L, 1.1, 1, 14, 5.5, 1.6, 1);
            }
            // the muzzle flash cores (bright, brief) along each firing gun
            if (ctl) {
              const q = f.aircraft.root.quaternion;
              for (const t of ctl.battery.turrets) {
                for (let k = 0; k < t.guns.length; k++) {
                  const g = t.guns[k];
                  if (g.flash < 0.05) continue;
                  muzzlePosition(t.cfg, t.trainDeg, t.elevDeg, k, M);
                  FP.set(M.x, M.y, M.z).applyQuaternion(q).add(f.aircraft.root.position);
                  gunDirection(t.trainDeg, t.elevDeg, M);
                  FD.set(M.x, M.y, M.z).applyQuaternion(q);
                  const Lf = 45 * g.flash;
                  glow.add(FP.x + FD.x * Lf, FP.y + FD.y * Lf, FP.z + FD.z * Lf, FP.x, FP.y, FP.z, 9 * g.flash, 1.6 * g.flash, 10, 6, 2.2, -1);
                }
              }
            }
          }
          ctx.renderer.getDrawingBufferSize(vp);
          glow.end(vp.x, vp.y);
        }
      },

      cameraShake: () => (guns || fx.count > 0 ? fx.shakeAt(camPos.x, camPos.y, camPos.z) : 0),

      onAction(a) {
        if (a === 'lockTarget' && guns) cycleLock();
        else if (a === 'fireMissile' && guns) {
          zoomWant = zoomWant > 1 ? 1 : 5;
          if (zoomWant > 1) binoPending = true;
          say(zoomWant > 1 ? 'RANGEFINDER ×5 — DRAG TO PAN' : 'RANGEFINDER OFF');
        }
      },

      onReset() {
        ctl?.reset();
        fx.reset();
        hub.falls.length = 0;
        lockId = null;
        lastTrigger = false;
        zoomWant = 1;
        if (ctl) world.status.turrets = ctl.battery.status;
      },

      onAircraftChange(d, m) {
        def = d;
        model = m;
        setup();
      },

      stats: () => ({ active: !!guns, shells: ctl?.shells.count ?? 0, ...fx.stats(), drawn: fxr?.drawn.particles ?? 0, rings: fxr?.drawn.rings ?? 0, ...(ctl?.stats() ?? {}) }),

      dispose() {
        offWorld();
        win?.removeEventListener?.('pointermove', onPointer);
        win?.removeEventListener?.('pointerdown', onPointer);
        doc?.removeEventListener?.('pointerleave', onLeave);
        standIn?.dispose();
        fxr?.dispose();
        glow?.dispose();
        const sim = (globalThis as unknown as { sim?: Record<string, unknown> }).sim;
        if (sim && sim.naval === api) delete sim.naval;
      },
    };
  },
};
export default mod;
