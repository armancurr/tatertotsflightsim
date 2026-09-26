/**
 * The naval guns' sound (src/audio/naval.ts) in the shared mix: each gun's report as the navalFire
 * event arrives and each shell's splash / burst on its detonation, all heard from the camera at the
 * speed of sound (a salvo fired 10 km away is heard ~30 s after the flash). Plays into the audio
 * system's master bus (mute, pause and the limiter apply); silent until the context exists.
 */
import { combatWorld } from '../../combat/world';
import { createNavalSound, sharedAudio, type NavalSound } from '../../audio/naval';
import type { Vec3 } from '../../types';
import type { SystemModule } from './types';

const mod: SystemModule = {
  name: 'navalAudio',
  order: 91,
  create(ctx) {
    if (!ctx.scene) return {};
    const world = combatWorld(ctx.scene);
    let sound: NavalSound | null = null;
    let ctxSeen: BaseAudioContext | null = null;
    const ensure = (): NavalSound | null => {
      const a = sharedAudio(ctx.scene);
      const c = a?.context ?? null;
      const m = a?.masterInput ?? null;
      if (!a || !c || !m) return null;
      if (!sound || ctxSeen !== c) {
        sound?.dispose();
        sound = createNavalSound(c, m);
        ctxSeen = c;
      }
      return sound;
    };
    const dist = (p: Vec3): number => {
      const c = ctx.camera?.position;
      if (!c) return 0;
      const d = Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z);
      return Number.isFinite(d) ? d : 0;
    };
    const off = world.on((e) => {
      if (e.type === 'navalFire') {
        ensure()?.report({ distanceM: dist(e.position), size: e.caliberMm / 406 });
      } else if (e.type === 'detonation' && e.weapon === 'shell') {
        const s = ensure();
        if (!s) return;
        if (e.surface === 'water') s.splash({ distanceM: dist(e.position) });
        else s.burst({ distanceM: dist(e.position), size: e.surface === 'target' ? 1.1 : 1 });
      }
    });
    return {
      onReset() {
        sound?.reset();
      },
      stats: () => ({ ...(sound?.played ?? { reports: 0, splashes: 0, bursts: 0 }) }),
      dispose() {
        off();
        sound?.dispose();
        sound = null;
      },
    };
  },
};
export default mod;
