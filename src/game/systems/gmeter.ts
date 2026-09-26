/**
 * The on-screen G meter (src/ui/gMeter.ts) for every aircraft, top left under the status badge.
 * Shows and hides with the HUD (I key / menu), clears its max/min tell-tales on a reset or an
 * aircraft change, and uses the limits of the aircraft being flown. Hidden on a vessel (a boat
 * has no g meter; the helm display has the trim and heel instead).
 */
import { CONFIG } from '../../config';
import { createGTrack, drawGMeter, gMeterModel, resetGTrack, stepGTrack } from '../../ui/gMeter';
import { uiBusFor } from '../../ui/uiBus';
import type { AircraftDef } from '../../fleet/types';
import type { SystemModule } from './types';

const mod: SystemModule = {
  name: 'gmeter',
  order: 102,
  create(ctx) {
    const G = CONFIG.hud.gMeter;
    const doc = ctx.hudRoot.ownerDocument ?? document;
    const canvas = doc.createElement('canvas');
    canvas.className = 'tfs-gmeter';
    canvas.setAttribute('role', 'img');
    Object.assign(canvas.style, {
      position: 'absolute',
      left: `${G.left}px`,
      top: `${G.top}px`,
      width: `${G.size}px`,
      height: `${G.size}px`,
      pointerEvents: 'none',
    });
    const dpr = Math.min(2, (doc.defaultView?.devicePixelRatio ?? 1) || 1);
    const px = Math.round(G.size * dpr);
    canvas.width = px;
    canvas.height = px;
    ctx.hudRoot.appendChild(canvas);
    let g2d: CanvasRenderingContext2D | null = null;
    try {
      g2d = canvas.getContext('2d');
    } catch {
      g2d = null;
    }
    const track = createGTrack();
    let def: AircraftDef | undefined = ctx.actions?.currentAircraft?.();
    let sinceDraw = Infinity;
    const bus = uiBusFor(doc);
    let hudVisible = true;
    const isVessel = (d: AircraftDef | undefined) => d?.kind === 'vessel' || d?.config?.aircraft.watercraft != null;
    const applyDisplay = () => {
      canvas.style.display = hudVisible && !isVessel(def) ? '' : 'none';
    };
    applyDisplay();
    const off = bus.on('hudVisible', (v) => {
      hudVisible = v;
      applyDisplay();
    });

    return {
      update(f) {
        if (f.def && f.def !== def) {
          def = f.def;
          applyDisplay();
        }
        if (isVessel(def)) return;
        const g = f.readings?.gLoad ?? f.state?.derived?.loadFactor ?? 1;
        if (!f.paused) stepGTrack(track, g, f.dt);
        sinceDraw += Number.isFinite(f.dt) ? f.dt : 0;
        if (sinceDraw < 1 / G.redrawHz) return;
        sinceDraw = 0;
        const m = gMeterModel(track, (def?.config ?? CONFIG).aircraft.limits);
        canvas.setAttribute('aria-label', `G meter: ${m.text} g, max ${m.maxText}, min ${m.minText}`);
        if (g2d) drawGMeter(g2d, px, m);
      },
      onReset() {
        resetGTrack(track);
        sinceDraw = Infinity;
      },
      onAircraftChange(d) {
        def = d;
        applyDisplay();
        resetGTrack(track);
        sinceDraw = Infinity;
      },
      stats: () => ({ g: Math.round(track.g * 100) / 100, max: Math.round(track.max * 100) / 100, min: Math.round(track.min * 100) / 100 }),
      dispose() {
        off();
        canvas.remove();
      },
    };
  },
};

export default mod;
