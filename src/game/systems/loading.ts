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
import { departureRunwayName } from '../../world/runway';
import { berthFor, type BerthId } from '../../world/port';
import type { AircraftDef } from '../../fleet/types';
import type { SystemModule } from './types';

/** The aircraft the app is about to build: ?aircraft=, else the remembered choice, else the default. */
function chosenDef(): AircraftDef | null {
  try {
    const q = new URLSearchParams(location.search).get('aircraft');
    const saved = loadAircraftChoice(safeLocalStorage(), CONFIG.menu.storageKey);
    const id = q ?? (saved && FLEET.some((d) => d.id === saved) ? saved : null);
    return getAircraftDef(id);
  } catch {
    return null;
  }
}

const BERTH_NAMES: Record<BerthId, string> = { visitor: "Visitors' pontoon", cruise: 'Cruise terminal', naval: 'Naval pier' };

/** A vessel starts at its berth (or on the open sea), not on the runway. */
function vesselPlace(def: AircraftDef | null): string | undefined {
  if (!def || def.kind !== 'vessel') return undefined;
  try {
    const spawn = new URLSearchParams(location.search).get('spawn');
    if (spawn === 'sea') return 'Off Port Chateau';
    if (spawn === 'gunnery') return 'Gunnery range';
    if (spawn) return 'At sea';
    // (names only: no layout work before the veil has painted)
    return `Port Chateau · ${BERTH_NAMES[berthFor(def)]}`;
  } catch {
    return 'Port Chateau';
  }
}

/** The runway end the app starts on (?rwy=, else the default). */
function runwayName(): string {
  try {
    return departureRunwayName(new URLSearchParams(location.search).get('rwy'));
  } catch {
    return '36';
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
  const def = chosenDef();
  veil = createLoadingVeil(document, CONFIG, { aircraftName: def?.name ?? CONFIG.aircraft.name, runway: runwayName(), place: vesselPlace(def) });
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
