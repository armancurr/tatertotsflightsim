/** Synthesised engine, wind, stall horn, tyres, motors, crash (owned by src/audio). */
import { createAudio, createAudioInputTracker } from '../../audio';
import type { HudReadings } from '../../ui/instruments';
import type { SystemModule } from './types';

const mod: SystemModule = {
  name: 'audio',
  order: 90,
  create(ctx) {
    const audio = createAudio();
    const track = createAudioInputTracker();
    const unlock = () => void audio.resume();
    addEventListener('keydown', unlock);
    addEventListener('pointerdown', unlock);
    return {
      update(f) {
        const p = f.state.position;
        audio.update(
          track({
            state: f.state, controls: f.controls, cameraMode: f.cameraMode, paused: f.paused, dt: f.dt,
            surface: ctx.env.surfaceAt(p.x, p.z), cameraPosition: f.camera.position,
            stallWarning: f.readings?.stallWarning,
            gearWarning: (f.readings as HudReadings | null)?.gearHorn,
          }),
          f.dt,
        );
      },
      onAction(a) {
        if (a === 'mute') audio.setMuted(!audio.muted);
      },
      dispose() {
        audio.dispose();
        removeEventListener('keydown', unlock);
        removeEventListener('pointerdown', unlock);
      },
    };
  },
};
export default mod;
