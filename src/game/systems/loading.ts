/**
 * Start-up loading veil (owned by src/ui): a title card that covers the page from the moment the
 * code loads until the world is streamed in and frames run smoothly, then fades to the aircraft on
 * the runway (see src/ui/veil.ts). It goes up while this module is evaluated — before the app
 * builds the aircraft — and a top-level await lets the browser paint it before that heavy,
 * synchronous work starts. The simulator keeps running behind it; keys still reach the sim.
 *
 * `?veil=0` (or `?no=loading`) skips it.
 */
import { CONFIG } from '../../config';
import { createLoadingVeil, type LoadingVeil } from '../../ui/veil';
import { loadAircraftChoice, safeLocalStorage } from '../../ui/picker';
import { FLEET, getAircraftDef } from '../../fleet';
import type { SystemModule } from './types';

/** The aircraft the app is about to build: ?aircraft=, else the remembered choice, else the default. */
function aircraftName(): string {
  try {
    const q = new URLSearchParams(location.search).get('aircraft');
    const saved = loadAircraftChoice(safeLocalStorage(), CONFIG.menu.storageKey);
    const id = q ?? (saved && FLEET.some((d) => d.id === saved) ? saved : null);
    return getAircraftDef(id).name;
  } catch {
    return CONFIG.aircraft.name;
  }
}

function wanted(): boolean {
  try {
    if (typeof document === 'undefined' || !document.getElementById('app')) return false;
    const q = new URLSearchParams(location.search);
    if (q.get('veil') === '0') return false;
    const no = (q.get('no') ?? '').split(',').map((s) => s.trim());
    return !no.includes('loading');
  } catch {
    return false;
  }
}

let veil: LoadingVeil | null = null;
if (wanted()) {
  veil = createLoadingVeil(document, CONFIG, { aircraftName: aircraftName() });
  // One painted frame before the app's synchronous start-up work (capped, in case rAF is paused in a background tab).
  await Promise.race([
    new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0))),
    new Promise<void>((r) => setTimeout(r, 150)),
  ]);
}

const mod: SystemModule = {
  name: 'loading',
  order: 0,
  create() {
    veil?.mark(1);
    return {
      ready() {
        veil?.mark(2);
        return Promise.resolve();
      },
      update(f) {
        if (!veil) return;
        veil.frame(f.dt);
        if (!veil.element) veil = null;
      },
      stats: () => (veil ? { phase: veil.model.phase, progress: Math.round(veil.model.progress * 100) / 100 } : { phase: 'gone' }),
      dispose() {
        veil?.dispose();
        veil = null;
      },
    };
  },
};
export default mod;
