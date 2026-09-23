/**
 * Instruments, HUD overlay and the live cockpit panel (owned by src/ui). The aircraft decides the
 * style: steam gauges (six-pack, the Cessna) or the F-16's head-up display — switched on
 * `onAircraftChange`, with that aircraft's own config for the readings (limits, stall, flaps).
 */
import { CONFIG, type Config } from '../../config';
import { createHud, type Hud, type HudCombinerView, type PanelDrawerFn } from '../../ui/hud';
import { createInstrumentModel, updateInstruments, type HudReadings } from '../../ui/instruments';
import { veilActive } from '../../ui/veil';
import { uiBusFor } from '../../ui/uiBus';
import type { AircraftDef } from '../../fleet/types';
import type { SystemModule } from './types';

type PanelTarget = { setPanelDrawer?(fn: PanelDrawerFn): void };

const mod: SystemModule = {
  name: 'hud',
  order: 100,
  create(ctx) {
    const model = createInstrumentModel();
    const panelTarget = (m: PanelTarget) => (m.setPanelDrawer ? (m as { setPanelDrawer(fn: PanelDrawerFn): void }) : undefined);
    let def: AircraftDef | null = null;
    try {
      def = ctx.actions?.currentAircraft?.() ?? null;
    } catch {
      def = null;
    }
    let cfg: Config = def?.config ?? CONFIG;
    const make = (m: PanelTarget, d: AircraftDef | null): Hud => createHud(ctx.hudRoot, { aircraft: panelTarget(m), config: d?.config ?? CONFIG, style: d?.hud ?? 'steam' });
    let hud = make(ctx.aircraft, def);
    let readings: HudReadings | null = null;
    // Cockpit view of a jet with a HUD combiner: the HUD goes on the glass (see src/ui/hudGlass.ts).
    const combinerView: HudCombinerView = { camera: ctx.camera, combiner: ctx.camera, body: { x: 0, y: 0, z: 0, w: 1 }, velocity: null };
    let muted = false;
    let menuOpen = false;
    const bus = uiBusFor(ctx.hudRoot.ownerDocument ?? ctx.hudRoot);
    const toggleVisible = () => {
      hud.toggleVisible();
      bus.emit('hudVisible', hud.isVisible());
    };
    const offs = [
      bus.on('toggleHud', toggleVisible),
      bus.on('menuOpen', (open) => {
        menuOpen = open;
        hud.setMenuOpen(open);
      }),
      bus.on('showHelp', () => hud.toggleHelp()),
      bus.on('toast', (t) => hud.flash(t.text, t.level ?? 'info', t.seconds)),
    ];
    return {
      readings(state, controls, dt) {
        readings = updateInstruments(model, state, controls, dt, cfg);
        if (def) readings.aircraftId = def.id;
        return readings;
      },
      update(f) {
        const r = readings ?? updateInstruments(model, f.state, f.controls, 0, cfg);
        const glass = f.cameraMode === 'cockpit' && f.def?.hud === 'jet' ? f.aircraft?.hudCombiner : undefined;
        if (glass) {
          combinerView.camera = f.camera;
          combinerView.combiner = glass;
          combinerView.body = f.aircraft.root.quaternion;
          combinerView.velocity = f.state.velocity;
        }
        hud.update(r, {
          combiner: glass ? combinerView : null,
          cameraMode: f.cameraMode, paused: f.paused, fps: f.fps.fps, timeOfDay: ctx.atmosphere.timeOfDayName,
          state: f.state, controls: f.controls, mouseYoke: f.controlState.mouseYoke,
          landingLight: f.controlState.landingLight, veil: veilActive(),
        }, f.dt);
      },
      onAction(a) {
        // With the pause menu up, H shows the menu's own Controls page instead.
        if (a === 'help' && !menuOpen) hud.toggleHelp();
        else if (a === 'toggleHud') toggleVisible();
        else if (a === 'mute') {
          muted = !muted;
          hud.flash(muted ? 'Sound off (M)' : 'Sound on (M)', 'info', 1.5);
        }
      },
      onReset() {
        hud.onReset();
      },
      onAircraftChange(next, aircraftModel) {
        // New aircraft: its own config, its HUD style, its cockpit panel gets the gauge drawer.
        def = next;
        cfg = next.config;
        model.initialized = false;
        readings = null;
        const wasVisible = hud.isVisible();
        hud.dispose();
        hud = make(aircraftModel, next);
        hud.setMenuOpen(menuOpen);
        if (!wasVisible) hud.toggleVisible();
      },
      onResize: () => hud.resize(),
      stats: () => ({ style: hud.style, visible: hud.isVisible() }),
      dispose: () => {
        offs.forEach((off) => off());
        hud.dispose();
      },
    };
  },
};
export default mod;
