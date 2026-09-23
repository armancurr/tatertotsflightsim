/**
 * The weapons HUD (src/ui/weaponsHud.ts) for aircraft that carry weapons (A-10C, F-16C): gun
 * cross, CCIP pipper, Maverick circle + lock box, target markers, range cue, stores/kills and short
 * messages on a transparent full-viewport canvas over the view (after the jet HUD, order 101);
 * kill toasts through the HUD's message stack (uiBus 'toast'); and the Maverick view picture in the
 * bottom-right corner (postRender). Reads `combatWorld(scene)` every frame and listens to its events.
 *
 * Debug: `window.sim.weaponsHudDemo(mode)` ('gun' | 'track' | 'lock' | 'all' | 'off') seeds a
 * platoon at the range and fakes the gun's CCIP / a Maverick lock until those systems exist;
 * `window.sim.weaponsHudProbe()` returns what is drawn and the picture's brightness spread.
 */
import * as THREE from 'three';
import { CONFIG, type Config } from '../../config';
import { combatWorld } from '../../combat/world';
import type { CombatEvent } from '../../combat/types';
import { computeHudLayout, type HudMode } from '../../ui/hud';
import { uiBusFor } from '../../ui/uiBus';
import { killToastText } from '../../ui/messages';
import {
  createSeekerOverlay, createWeaponsHudFrame, createWeaponsHudModel, drawSeekerOverlay, drawWeaponsHud, seekerRect, updateWeaponsHud,
  weaponsHudChanged, WEAPONS_HUD_KEY_LENGTH, type Rect,
} from '../../ui/weaponsHud';
import { formatSlantRange, gunLineDir, weaponsVisibility } from '../../ui/weaponsHudMath';
import { createSeekerView, seekerHotSpots, type SeekerView } from '../../ui/seekerView';
import { applyWeaponsHudDemo, DEMO_MODES, seedDemoRange, type WeaponsHudDemoMode } from '../../ui/weaponsHudDemo';
import type { AircraftDef } from '../../fleet/types';
import type { CameraMode } from '../../types';
import type { SystemModule } from './types';

const mod: SystemModule = {
  name: 'weaponsHud',
  order: 101,
  create(ctx) {
    const doc = ctx.hudRoot.ownerDocument ?? document;
    const win = (doc.defaultView ?? window) as Window;
    const world = combatWorld(ctx.scene);
    const bus = uiBusFor(doc);
    let def: AircraftDef | null = null;
    try {
      def = ctx.actions?.currentAircraft?.() ?? null;
    } catch {
      def = null;
    }
    let cfg: Config = def?.config ?? CONFIG;
    const hw = CONFIG.hud.weapons;
    const vis = weaponsVisibility(cfg.weapons, hw);

    // ── DOM: a full-viewport canvas + the Maverick view's overlay canvas ──
    const root = doc.createElement('div');
    root.className = 'fsw-root';
    root.setAttribute('aria-hidden', 'true');
    root.style.cssText = 'position:fixed;inset:0;z-index:19;pointer-events:none;overflow:hidden;';
    const canvas = doc.createElement('canvas');
    canvas.setAttribute('data-hud', 'weapons');
    canvas.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;';
    const pipCanvas = doc.createElement('canvas');
    pipCanvas.setAttribute('data-hud', 'maverick');
    pipCanvas.style.cssText = 'position:absolute;pointer-events:none;border-radius:3px;box-shadow:0 6px 22px rgba(0,0,0,0.45);';
    root.append(canvas, pipCanvas);
    ctx.hudRoot.appendChild(root);
    let c2d: CanvasRenderingContext2D | null = null;
    let p2d: CanvasRenderingContext2D | null = null;
    try {
      c2d = canvas.getContext('2d');
      p2d = pipCanvas.getContext('2d');
    } catch {
      /* no 2D canvas (tests) */
    }

    // ── State ──
    const frame = createWeaponsHudFrame();
    let model = createWeaponsHudModel(cfg);
    const key = new Float64Array(WEAPONS_HUD_KEY_LENGTH).fill(NaN);
    const overlay = createSeekerOverlay();
    let vw = 0;
    let vh = 0;
    let dpr = 1;
    let cameraMode: CameraMode | null = null;
    let hudBox: Rect | null = null;
    let pipRect: Rect = { x: 0, y: 0, w: 320, h: 240 };
    let hudVisible = true;
    let shown = false;
    let pipShown = false;
    let pipWanted = false;
    let pipUntil = 0;
    let lastTargetId: number | null = null;
    let time = 0;
    let launchSeen = false;
    let demo: WeaponsHudDemoMode = 'off';
    let seeker: SeekerView | null = null;
    let seekerFailed = false;
    let drawMs = 0;
    let rangeGroundKey = '';
    let rangeGroundY = 0;
    const tmpV = new THREE.Vector3();
    const tmpUp = new THREE.Vector3();
    const dir = { x: 0, y: 0, z: 0 };
    const pipKey = new Float64Array(10).fill(NaN);
    const say = (text: string) => {
      frame.message = text;
      frame.messageUntil = time + hw.messageS;
    };

    const layout = () => {
      vw = win.innerWidth || doc.documentElement.clientWidth || 1024;
      vh = win.innerHeight || doc.documentElement.clientHeight || 768;
      dpr = Math.min(CONFIG.hud.maxPixelRatio, Math.max(1, Number(win.devicePixelRatio) || 1));
      canvas.width = Math.max(1, Math.round(vw * dpr));
      canvas.height = Math.max(1, Math.round(vh * dpr));
      canvas.style.width = `${vw}px`;
      canvas.style.height = `${vh}px`;
      const mode: HudMode = cameraMode === 'cockpit' ? (CONFIG.hud.cockpitGauges === 'compact' ? 'cockpitCompact' : 'cockpitHidden') : 'normal';
      const L = computeHudLayout(vw, vh, cfg, mode, def?.hud ?? 'jet');
      hudBox = L.jet;
      pipRect = seekerRect(vw, vh, CONFIG, L.strip);
      pipCanvas.width = Math.max(1, Math.round(pipRect.w * dpr));
      pipCanvas.height = Math.max(1, Math.round(pipRect.h * dpr));
      pipCanvas.style.left = `${pipRect.x}px`;
      pipCanvas.style.top = `${pipRect.y}px`;
      pipCanvas.style.width = `${pipRect.w}px`;
      pipCanvas.style.height = `${pipRect.h}px`;
      key.fill(NaN);
      pipKey.fill(NaN);
    };
    layout();
    const onResize = () => layout();
    win.addEventListener('resize', onResize);

    const setShown = (v: boolean) => {
      if (v === shown) return;
      shown = v;
      canvas.hidden = !v;
      canvas.style.display = v ? 'block' : 'none';
      if (!v && c2d) {
        c2d.setTransform(1, 0, 0, 1, 0, 0);
        c2d.clearRect(0, 0, canvas.width, canvas.height);
      }
      key.fill(NaN);
    };
    const setPipShown = (v: boolean) => {
      if (v === pipShown) return;
      pipShown = v;
      pipCanvas.style.display = v ? 'block' : 'none';
      if (v) seeker?.invalidate();
      pipKey.fill(NaN);
    };
    // Start hidden (set the styles directly: the setters skip a no-change).
    canvas.hidden = true;
    canvas.style.display = 'none';
    pipCanvas.style.display = 'none';

    const offBus = [bus.on('hudVisible', (v) => (hudVisible = v))];

    const onEvent = (e: CombatEvent) => {
      if (!vis.any) return;
      switch (e.type) {
        case 'destroyed':
          bus.emit('toast', { text: killToastText(e.kind, e.weapon, cfg.weapons), level: 'good', seconds: hw.killToastS });
          break;
        case 'missileLaunch':
          launchSeen = true;
          say('RIFLE');
          pipUntil = Math.max(pipUntil, time + hw.seeker.showAfterLaunchS);
          break;
        case 'lockLost':
          if (e.targetId !== null) say('LOCK LOST');
          break;
        case 'reload':
          frame.message = '';
          pipUntil = 0;
          lastTargetId = null;
          break;
        default:
          break;
      }
    };
    const offWorld = world.on(onEvent);

    const setAircraft = (next: AircraftDef) => {
      def = next;
      cfg = next.config;
      weaponsVisibility(cfg.weapons, hw, vis);
      model = createWeaponsHudModel(cfg);
      frame.message = '';
      pipUntil = 0;
      lastTargetId = null;
      layout();
    };

    const groundHeight = (x: number, z: number) => {
      try {
        const g = ctx.env.groundHeight(x, z);
        return Number.isFinite(g) ? g : 0;
      } catch {
        return 0;
      }
    };

    // Debug hooks on window.sim (installed once it exists).
    const installDebug = () => {
      const sim = (win as unknown as { sim?: Record<string, unknown> }).sim;
      if (!sim || sim.weaponsHudDemo) return;
      sim.weaponsHudDemo = (mode: WeaponsHudDemoMode = 'all') => {
        demo = DEMO_MODES.includes(mode) ? mode : 'all';
        if (demo !== 'off') seedDemoRange(world, groundHeight);
        return { mode: demo, range: world.range, targets: world.targets.length };
      };
      sim.weaponsHudProbe = () => ({ ...stats(), picture: seeker && pipShown ? seeker.probe(ctx.renderer) : null });
    };

    const stats = () => ({
      visible: shown,
      aircraft: def?.id ?? null,
      demo,
      exterior: frame.exterior,
      gunCross: model.gunCross.show,
      pipper: model.pipper.show ? { x: Math.round(model.pipper.x), y: Math.round(model.pipper.y), arc: Math.round(model.pipper.arc * 100) / 100, inRange: model.pipper.inRange, clamped: model.pipper.clamped } : null,
      lock: model.lock.show ? { solid: model.lock.solid, fill: model.lock.fill, type: model.lock.type, range: model.lock.range, inRange: model.lock.inRange, x: Math.round(model.lock.x), y: Math.round(model.lock.y) } : null,
      markers: model.markerCount,
      rangeCue: model.rangeCue.show ? model.rangeCue.text : '',
      stores: [model.stores.gun, model.vis.missiles ? model.stores.msl : '', model.stores.kills].filter(Boolean),
      message: model.msg.show ? model.msg.text : '',
      drawMs: Math.round(drawMs * 1000) / 1000,
      maverickView: { shown: pipShown, rect: pipRect, ...(seeker ? seeker.stats() : { renders: 0, cpuMs: 0, gpuMs: -1, width: 0, height: 0 }) },
    });

    return {
      update(f) {
        launchSeen = false;
        time = f.time;
        installDebug();
        if (f.def && f.def !== def) setAircraft(f.def);
        if (!seeker && vis.missiles && hw.seeker.enabled) {
          // Build the Maverick view now (under the loading veil) so its first appearance doesn't hitch.
          seeker = createSeekerView(CONFIG);
          seeker.warmUp(ctx.renderer);
        }
        if (f.cameraMode !== cameraMode) {
          cameraMode = f.cameraMode;
          layout();
        }
        const crashed = f.state.phase === 'crashed';
        const on = vis.any && hudVisible && !crashed;
        setShown(on);
        const st = world.status;
        const root3 = f.aircraft.root;
        if (demo !== 'off' && vis.any) {
          applyWeaponsHudDemo(world, demo, { position: root3.position, orientation: root3.quaternion, velocity: f.state.velocity }, cfg.weapons, groundHeight, time);
        }
        // The Maverick view: tracking/locked, or just after T / a launch.
        if (st.lock.targetId !== null && st.lock.state !== 'off') lastTargetId = st.lock.targetId;
        pipWanted = on && vis.missiles && hw.seeker.enabled && !seekerFailed && (st.lock.state !== 'off' || time < pipUntil) && (f.cameraMode !== 'cockpit' || hw.seeker.inCockpit);
        if (!on) {
          setPipShown(false);
          return;
        }
        const t0 = performance.now();
        // Fill the frame.
        const cam = f.camera;
        frame.w = vw;
        frame.h = vh;
        frame.view = cam.matrixWorldInverse.elements;
        frame.proj = cam.projectionMatrix.elements;
        frame.exterior = f.cameraMode !== 'cockpit';
        frame.hudBox = def?.hud === 'jet' ? hudBox : null;
        frame.gearUp = f.readings ? f.readings.gear === 'up' : f.state.gearPos < 0.02;
        frame.ax = root3.position.x;
        frame.ay = root3.position.y;
        frame.az = root3.position.z;
        frame.qx = root3.quaternion.x;
        frame.qy = root3.quaternion.y;
        frame.qz = root3.quaternion.z;
        frame.qw = root3.quaternion.w;
        frame.headingDeg = f.readings ? f.readings.headingDeg : f.state.derived.headingDeg ?? 0;
        frame.weapons = cfg.weapons;
        frame.status = st;
        frame.kills = world.stats.kills;
        frame.targets = world.targets;
        frame.classOf = world.classOf;
        frame.range = world.range;
        if (world.range) {
          const k = `${Math.round(world.range.x)},${Math.round(world.range.z)}`;
          if (k !== rangeGroundKey) {
            rangeGroundKey = k;
            rangeGroundY = groundHeight(world.range.x, world.range.z);
          }
        }
        frame.rangeGroundY = rangeGroundY;
        frame.time = time;
        frame.seekerActive = vis.missiles && (st.lock.state !== 'off' || time < pipUntil);
        updateWeaponsHud(model, frame, cfg);
        if (c2d && weaponsHudChanged(model, key)) {
          c2d.setTransform(1, 0, 0, 1, 0, 0);
          c2d.clearRect(0, 0, canvas.width, canvas.height);
          c2d.setTransform(dpr, 0, 0, dpr, 0, 0);
          drawWeaponsHud(c2d, model, cfg);
        }
        drawMs += (performance.now() - t0 - drawMs) * 0.05;
      },

      postRender(f) {
        if (!pipWanted) {
          setPipShown(false);
          return;
        }
        setPipShown(true);
        const msl = cfg.weapons?.missiles;
        if (!msl) return;
        seeker ??= createSeekerView(CONFIG);
        const st = world.status;
        const root3 = f.aircraft.root;
        // Camera at the next loaded rail (a little ahead of it), looking at the target or along the nose.
        const stations = msl.stations;
        let si = st.stores.findIndex((b) => b);
        if (si < 0) si = 0;
        const s = stations[Math.min(si, stations.length - 1)];
        tmpV.set(s.x, s.y, s.z - 1.3);
        root3.localToWorld(tmpV);
        const cam = seeker.camera;
        cam.position.copy(tmpV);
        tmpUp.set(0, 1, 0).applyQuaternion(root3.quaternion);
        cam.up.copy(tmpUp);
        const id = st.lock.state !== 'off' && st.lock.targetId !== null ? st.lock.targetId : lastTargetId;
        const t = id !== null ? world.find(id) : undefined;
        const sc = hw.seeker;
        let fov = sc.wideFovDeg;
        if (t) {
          const h = world.classOf(t.kind).height;
          cam.lookAt(t.position.x, t.position.y + h / 2, t.position.z);
          fov = st.lock.state === 'locked' ? sc.narrowFovDeg / Math.max(1, sc.expandFactor) : sc.narrowFovDeg;
        } else {
          gunLineDir(dir, root3.quaternion.x, root3.quaternion.y, root3.quaternion.z, root3.quaternion.w, 0);
          cam.lookAt(tmpV.x + dir.x * 1000, tmpV.y + dir.y * 1000, tmpV.z + dir.z * 1000);
        }
        const aspect = pipRect.w / pipRect.h;
        if (cam.fov !== fov || cam.aspect !== aspect) {
          cam.fov = fov;
          cam.aspect = aspect;
          cam.updateProjectionMatrix();
        }
        cam.updateMatrixWorld();
        try {
          if (seeker.isDue(time)) {
            seeker.hotCount = seekerHotSpots(seeker.hot, cam.matrixWorldInverse.elements, cam.projectionMatrix.elements, fov, world.targets, world.classOf);
            seeker.render(ctx.renderer, ctx.scene, root3, time, pipRect);
          }
          seeker.blit(ctx.renderer, pipRect);
        } catch (e) {
          console.error('[weaponsHud] Maverick view failed; turning it off', e);
          seekerFailed = true;
          setPipShown(false);
          return;
        }
        // Overlay: gates on the target, state, stores, range.
        if (!p2d) return;
        overlay.state = t ? st.lock.state : 'off';
        overlay.progress = st.lock.progress;
        overlay.missiles = st.hasMissiles ? st.missiles : msl.stations.length;
        overlay.flashOn = Math.floor(time * hw.flashHz * 2) % 2 === 0;
        overlay.inRange = st.lock.inRange;
        overlay.fovLabel = '';
        overlay.tx = NaN;
        overlay.ty = NaN;
        if (t) {
          tmpV.set(t.position.x, t.position.y + world.classOf(t.kind).height / 2, t.position.z).project(cam);
          overlay.tx = ((tmpV.x + 1) / 2) * pipRect.w;
          overlay.ty = ((1 - tmpV.y) / 2) * pipRect.h;
          const dist = cam.position.distanceTo(tmpV.set(t.position.x, t.position.y, t.position.z));
          const px = (world.classOf(t.kind).length / 2 / Math.max(1, dist)) * (pipRect.h / 2) / Math.tan((fov * Math.PI) / 360);
          overlay.half = Math.max(8, px * 1.5);
        }
        const rng = st.lock.rangeM;
        const rkey = rng === null || !Number.isFinite(rng) ? -1 : rng >= 1852 ? 1e7 + Math.round(rng / 185.2) : Math.round(rng / 3.048);
        if (pipKey[9] !== rkey) {
          pipKey[9] = rkey;
          pipKey[7] = NaN;
          overlay.range = rkey < 0 ? '' : formatSlantRange(rng as number);
        }
        let changed = false;
        const put = (i: number, x: number) => {
          const q = Number.isFinite(x) ? x : -1;
          if (pipKey[i] !== q) {
            pipKey[i] = q;
            changed = true;
          }
        };
        put(0, overlay.state === 'locked' ? 2 : overlay.state === 'tracking' ? 1 : 0);
        put(1, Math.round(overlay.progress * 100));
        put(2, overlay.missiles);
        put(3, (overlay.flashOn ? 1 : 0) + (overlay.inRange ? 2 : 0));
        put(4, Math.round(overlay.tx));
        put(5, Math.round(overlay.ty));
        put(6, Math.round(overlay.half));
        put(7, rkey);
        if (changed) {
          p2d.setTransform(1, 0, 0, 1, 0, 0);
          p2d.clearRect(0, 0, pipCanvas.width, pipCanvas.height);
          p2d.setTransform(dpr, 0, 0, dpr, 0, 0);
          drawSeekerOverlay(p2d, pipRect.w, pipRect.h, overlay);
        }
      },

      onAction(a) {
        if (!vis.missiles) return;
        const st = world.status;
        if (a === 'lockTarget') {
          pipUntil = time + hw.seeker.showAfterLockKeyS;
        } else if (a === 'fireMissile') {
          if (launchSeen) return;
          const n = st.hasMissiles ? st.missiles : cfg.weapons?.missiles?.stations.length ?? 0;
          if (n <= 0) say('NO MSL');
          else if (st.lock.state !== 'locked') say('NO LOCK');
          else if (!st.lock.inRange) say('OUT OF RNG');
        }
      },

      onReset() {
        frame.message = '';
        pipUntil = 0;
        lastTargetId = null;
        key.fill(NaN);
      },

      onAircraftChange(next) {
        setAircraft(next);
      },

      onResize: () => layout(),
      stats,
      dispose() {
        offWorld();
        offBus.forEach((off) => off());
        win.removeEventListener('resize', onResize);
        seeker?.dispose();
        root.remove();
      },
    };
  },
};
export default mod;
