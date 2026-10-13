/**
 * The naval fire-control HUD (src/ui/navalHud.ts) for vehicles with a naval battery: the panel at
 * the right edge (dark glass like the marine helm HUD, clear of it) and a full-viewport overlay with
 * the aim marker, the locked-target bracket, the splash markers of the shells in flight and the fall
 * of shot. Reads `navalHub(scene)` (written by the navalGuns system) every frame; hidden with the
 * rest of the HUD (I) and for every vehicle without naval guns.
 */
import * as THREE from 'three';
import { CONFIG } from '../../config';
import { navalHub } from '../../combat/navalHub';
import { combatWorld } from '../../combat/world';
import { computeNavalHudLayout, drawNavalOverlay, drawNavalPanel, navalHudKey, navalHudModel, type NavalOverlay, type ScreenPoint } from '../../ui/navalHud';
import { uiBusFor } from '../../ui/uiBus';
import type { HudMode } from '../../ui/hud';
import type { SystemModule } from './types';

const PANEL_HZ = 12;

const mod: SystemModule = {
  name: 'navalHud',
  order: 103,
  create(ctx) {
    const doc = ctx.hudRoot?.ownerDocument ?? (typeof document !== 'undefined' ? document : null);
    const hub = navalHub(ctx.scene);
    const world = combatWorld(ctx.scene);
    if (!doc || !ctx.hudRoot) return {};
    const win = (doc.defaultView ?? window) as Window;
    const bus = uiBusFor(doc);
    let hudVisible = true;
    const offBus = bus.on('hudVisible', (v) => (hudVisible = v));

    const root = doc.createElement('div');
    root.className = 'fsn-root';
    root.setAttribute('aria-hidden', 'true');
    root.style.cssText = 'position:fixed;inset:0;z-index:18;pointer-events:none;overflow:hidden;display:none;';
    const overlay = doc.createElement('canvas');
    overlay.setAttribute('data-hud', 'naval-overlay');
    overlay.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;';
    const panel = doc.createElement('div');
    panel.setAttribute('data-hud', 'naval-panel');
    panel.style.cssText = [
      'position:absolute', 'border-radius:14px', 'pointer-events:none',
      'background:linear-gradient(180deg, rgba(22,28,38,0.50), rgba(8,11,17,0.62))',
      'border:1px solid rgba(255,255,255,0.10)',
      'box-shadow:0 10px 28px rgba(0,0,0,0.32), inset 0 1px 0 rgba(255,255,255,0.07)',
      'backdrop-filter:blur(9px) saturate(1.25)', '-webkit-backdrop-filter:blur(9px) saturate(1.25)',
    ].join(';');
    const pc = doc.createElement('canvas');
    pc.style.cssText = 'position:absolute;left:0;top:0;';
    panel.appendChild(pc);
    root.append(overlay, panel);
    ctx.hudRoot.appendChild(root);
    let p2d: CanvasRenderingContext2D | null = null;
    let o2d: CanvasRenderingContext2D | null = null;
    try {
      p2d = pc.getContext('2d');
      o2d = overlay.getContext('2d');
    } catch {
      /* no canvas (tests) */
    }

    let vw = 0, vh = 0, dpr = 1;
    let mode: HudMode = 'normal';
    let rect = { x: 0, y: 0, w: 0, h: 0 };
    const lastKey: number[] = [];
    const key: number[] = [];
    const layout = () => {
      vw = win.innerWidth || 1440;
      vh = win.innerHeight || 900;
      dpr = Math.min(2, win.devicePixelRatio || 1);
      rect = computeNavalHudLayout(vw, vh, CONFIG, mode);
      panel.style.left = `${rect.x}px`;
      panel.style.top = `${rect.y}px`;
      panel.style.width = `${rect.w}px`;
      panel.style.height = `${rect.h}px`;
      pc.style.width = `${Math.max(1, rect.w - 2)}px`;
      pc.style.height = `${Math.max(1, rect.h - 2)}px`;
      pc.width = Math.max(1, Math.round((rect.w - 2) * dpr));
      pc.height = Math.max(1, Math.round((rect.h - 2) * dpr));
      overlay.style.width = `${vw}px`;
      overlay.style.height = `${vh}px`;
      overlay.width = Math.max(1, Math.round(vw * dpr));
      overlay.height = Math.max(1, Math.round(vh * dpr));
      lastKey.length = 0;
    };
    layout();
    const onResize = () => layout();
    win.addEventListener('resize', onResize);

    let lastDraw = -1;
    let shown = false;
    let overlayDirty = false;
    const v = new THREE.Vector3();
    const project = (x: number, y: number, z: number, cam: THREE.Camera, out: ScreenPoint): ScreenPoint => {
      v.set(x, y, z).project(cam);
      out.x = (v.x * 0.5 + 0.5) * vw;
      out.y = (-v.y * 0.5 + 0.5) * vh;
      out.visible = v.z < 1 && v.z > -1 && out.x > -40 && out.x < vw + 40 && out.y > -40 && out.y < vh + 40;
      return out;
    };
    const ov: NavalOverlay = { aim: { x: 0, y: 0, visible: false }, aimOk: true, lock: null, splashes: [], falls: [] };
    const stats = { drawn: 0, shown: false, model: null as ReturnType<typeof navalHudModel> | null };

    return {
      update(f) {
        const want = !!hub.guns && hudVisible;
        if (want !== shown) {
          shown = want;
          root.style.display = want ? 'block' : 'none';
          if (!want && o2d) o2d.clearRect(0, 0, overlay.width, overlay.height);
          lastKey.length = 0;
        }
        stats.shown = shown;
        if (!shown || !hub.guns) return;
        const nextMode: HudMode = f.cameraMode === 'cockpit' ? 'cockpitCompact' : 'normal';
        if (nextMode !== mode) {
          mode = nextMode;
          layout();
        }
        const time = f.time;
        // splash countdown: the first shell to fall
        let splash: number | null = null;
        const shells = hub.shells;
        ov.splashes.length = 0;
        if (shells) {
          for (const s of shells.shells) {
            if (!s.live) continue;
            const left = s.ptof - s.age;
            if (splash === null || left < splash) splash = left;
            const p = project(s.px, s.py, s.pz, f.camera, { x: 0, y: 0, visible: false });
            ov.splashes.push({ ...p, s: Math.max(0, left) });
          }
        }
        const lockT = hub.aim.targetId !== null ? world.find(hub.aim.targetId) : undefined;
        const m = navalHudModel(hub.guns.name, hub.battery, hub.solutions, hub.aim, {
          target: lockT ? world.classOf(lockT.kind).name : null,
          shells: shells?.count ?? 0,
          splashS: splash,
          message: hub.message.until > time ? hub.message.text : '',
          messageLevel: hub.message.level,
          zoom: hub.zoom,
        });
        stats.model = m;
        const blink = Math.floor(time * 3) % 2 === 1;
        navalHudKey(m, key);
        key.push(blink ? 1 : 0);
        let changed = key.length !== lastKey.length;
        for (let i = 0; !changed && i < key.length; i++) if (key[i] !== lastKey[i]) changed = true;
        if (changed && (time - lastDraw >= 1 / PANEL_HZ || lastDraw < 0) && p2d) {
          lastKey.length = 0;
          lastKey.push(...key);
          lastDraw = time;
          p2d.setTransform(dpr, 0, 0, dpr, 0, 0);
          p2d.clearRect(0, 0, rect.w, rect.h);
          if (rect.w > 40 && rect.h > 40) drawNavalPanel(p2d, rect.w - 2, rect.h - 2, m, blink);
          stats.drawn++;
        }
        // overlay every frame (the view moves)
        if (o2d) {
          o2d.setTransform(dpr, 0, 0, dpr, 0, 0);
          o2d.clearRect(0, 0, vw, vh);
          ov.aim = hub.aim.valid ? project(hub.aim.point.x, hub.aim.point.y, hub.aim.point.z, f.camera, ov.aim ?? { x: 0, y: 0, visible: false }) : null;
          ov.aimOk = !hub.aim.tooFar && !hub.aim.tooClose;
          if (lockT && lockT.alive) {
            const c = world.centreOf(lockT);
            const p = project(c.x, c.y, c.z, f.camera, { x: 0, y: 0, visible: false });
            const cls = world.classOf(lockT.kind);
            const d = Math.max(1, f.camera.position.distanceTo(v.set(c.x, c.y, c.z)));
            const px = (Math.max(cls.length, cls.height) / d) * (vh / (2 * Math.tan(((f.camera as THREE.PerspectiveCamera).fov * Math.PI) / 360)));
            ov.lock = { ...p, r: px * 0.7 + 8 };
          } else ov.lock = null;
          ov.falls.length = 0;
          for (const fl of hub.falls) {
            const age = (time - fl.t) / 12;
            if (age >= 1 || age < 0) continue;
            const p = project(fl.x, fl.y, fl.z, f.camera, { x: 0, y: 0, visible: false });
            ov.falls.push({ ...p, age, hit: fl.hit });
          }
          drawNavalOverlay(o2d, vw, vh, ov);
          overlayDirty = true;
        }
        void overlayDirty;
      },
      onResize: () => layout(),
      stats: () => ({ shown: stats.shown, drawn: stats.drawn, panel: rect }),
      dispose() {
        offBus();
        win.removeEventListener('resize', onResize);
        root.remove();
      },
    };
  },
};
export default mod;
