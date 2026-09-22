/** Instruments, HUD overlay and the live cockpit panel (owned by src/ui). */
import { createHud, type PanelDrawerFn } from '../../ui/hud';
import { createInstrumentModel, updateInstruments, type HudReadings } from '../../ui/instruments';
import type { SystemModule } from './types';

const mod: SystemModule = {
  name: 'hud',
  order: 100,
  create(ctx) {
    const model = createInstrumentModel();
    const ac = ctx.aircraft;
    const hud = createHud(ctx.hudRoot, { aircraft: ac.setPanelDrawer ? (ac as { setPanelDrawer(fn: PanelDrawerFn): void }) : undefined });
    let readings: HudReadings | null = null;
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
        }, f.dt);
      },
      onAction(a) {
        if (a === 'help') hud.toggleHelp();
        else if (a === 'toggleHud') hud.toggleVisible();
        else if (a === 'mute') hud.flash('Sound toggled (M)', 'info', 1.5);
      },
      onResize: () => hud.resize(),
      dispose: () => hud.dispose(),
    };
  },
};
export default mod;
