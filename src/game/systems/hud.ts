/** Instruments, HUD overlay and the live cockpit panel (owned by src/ui). */
import { createHud, type PanelDrawerFn } from '../../ui/hud';
import { createInstrumentModel, updateInstruments, type HudReadings } from '../../ui/instruments';
import { veilActive } from '../../ui/veil';
import type { SystemModule } from './types';

const mod: SystemModule = {
  name: 'hud',
  order: 100,
  create(ctx) {
    const model = createInstrumentModel();
    const ac = ctx.aircraft;
    const panelTarget = (m: { setPanelDrawer?(fn: PanelDrawerFn): void }) =>
      m.setPanelDrawer ? (m as { setPanelDrawer(fn: PanelDrawerFn): void }) : undefined;
    let hud = createHud(ctx.hudRoot, { aircraft: panelTarget(ac) });
    let readings: HudReadings | null = null;
    let muted = false;
    return {
      readings(state, controls, dt) {
        readings = updateInstruments(model, state, controls, dt);
        return readings;
      },
      update(f) {
        const r = readings ?? updateInstruments(model, f.state, f.controls, 0);
        hud.update(r, {
          cameraMode: f.cameraMode, paused: f.paused, fps: f.fps.fps, timeOfDay: ctx.atmosphere.timeOfDayName,
          state: f.state, controls: f.controls, mouseYoke: f.controlState.mouseYoke,
          landingLight: f.controlState.landingLight, veil: veilActive(),
        }, f.dt);
      },
      onAction(a) {
        if (a === 'help') hud.toggleHelp();
        else if (a === 'toggleHud') hud.toggleVisible();
        else if (a === 'mute') {
          muted = !muted;
          hud.flash(muted ? 'Sound off (M)' : 'Sound on (M)', 'info', 1.5);
        }
      },
      onAircraftChange(_def, model) {
        // Re-create the HUD so the new aircraft's cockpit panel gets the gauge drawer.
        hud.dispose();
        hud = createHud(ctx.hudRoot, { aircraft: panelTarget(model) });
      },
      onResize: () => hud.resize(),
      dispose: () => hud.dispose(),
    };
  },
};
export default mod;
