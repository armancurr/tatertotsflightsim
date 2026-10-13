/**
 * The jet-ski race course off Tater Beach (src/world/offshore/raceCourse.ts + raceModel.ts) and its
 * lap timer (src/ui/raceHud.ts).
 *
 * The marks bob on the waves and are SOFT obstacles (`env.registerSoftObstacleSource`: a hull bumps
 * off an inflatable buoy, nothing crashes). While a vessel is driven on or near the course the
 * lap-timer panel shows (top-left) and a green chevron floats over the next mark; the tracker times
 * laps from the start arch, checks every mark is rounded on its side in order (a missed mark voids
 * the lap) and keeps the best lap per vessel in localStorage. Lap and missed-mark toasts go through
 * the HUD's message stack.
 *
 * Debug: `window.sim.debug().systems.raceCourse`.
 */
import { CONFIG } from '../../config';
import { terrainHeight } from '../../world/heightfield';
import { getSeaSpectrum } from '../../world/water/waves';
import { nightFactor, sunElevationDeg } from '../../world/traffic/daylight';
import {
  courseDistance, createRaceTracker, loadBest, raceCourse, resetRace, saveBest, updateRace, type KeyValueStore, type RaceTracker,
} from '../../world/offshore/raceCourse';
import { createBuoyObstacles, createRaceCourseModel } from '../../world/offshore/raceModel';
import { createRaceHud, formatLapTime, raceHudView } from '../../ui/raceHud';
import { uiBusFor } from '../../ui/uiBus';
import type { AircraftDef } from '../../fleet/types';
import type { SystemModule } from './types';

/** The panel shows within this distance (m) outside the course's circle; racing is abandoned beyond ABANDON_M. */
export const SHOW_MARGIN_M = 700;
export const ABANDON_M = 1500;

/** Longest vessel that races the course (a jet ski, a sports yacht — not a cruise ship or a battleship), m. */
export const RACER_MAX_LENGTH_M = 40;
const isVessel = (d: AircraftDef | null | undefined): boolean =>
  !!d && (d.kind === 'vessel' || d.config?.aircraft?.watercraft != null) && (d.config?.aircraft?.geometry?.length ?? 0) <= RACER_MAX_LENGTH_M;

function storage(): KeyValueStore | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

const mod: SystemModule = {
  name: 'raceCourse',
  order: 54,
  create(ctx) {
    const course = raceCourse();
    ctx.env.registerSoftObstacleSource?.(createBuoyObstacles(course));
    const model = createRaceCourseModel(course, getSeaSpectrum(CONFIG), (x, z) => -terrainHeight(x, z));
    ctx.scene.add(model.group);
    const doc = ctx.hudRoot?.ownerDocument ?? (typeof document !== 'undefined' ? document : null);
    const hud = doc && ctx.hudRoot ? createRaceHud(ctx.hudRoot) : null;
    const win = doc?.defaultView ?? null;
    const layout = () => hud?.layout(win?.innerWidth ?? 1440, win?.innerHeight ?? 900);
    layout();
    const bus = doc ? uiBusFor(doc) : null;
    let hudShown = true;
    const offBus = bus?.on('hudVisible', (v) => (hudShown = v));

    const store = storage();
    let vesselId = '';
    let tracker: RaceTracker = createRaceTracker(course, 'none');
    let px = NaN;
    let pz = NaN;
    let hudTimer = 0;
    let near = false;
    let crashed = false;
    const toast = (text: string, level: 'info' | 'warn' | 'good' = 'info', seconds = 3) => bus?.emit('toast', { text, level, seconds });

    const selectVessel = (id: string) => {
      vesselId = id;
      tracker = createRaceTracker(course, id, loadBest(store, course.id, id));
      px = NaN;
      pz = NaN;
    };

    const handleEvents = (n: number) => {
      for (let k = 0; k < n; k++) {
        const e = tracker.events[k];
        const id = course.marks[Math.max(0, e.mark)]?.id ?? '';
        switch (e.kind) {
          case 'start':
            toast(`${course.name}: GO!`, 'good', 2);
            break;
          case 'missed':
            toast(e.mark === 0 ? 'Missed the finish arch — lap void' : `Missed ${id} — lap void`, 'warn', 3);
            break;
          case 'lap': {
            const best = Math.abs(e.value - tracker.best) < 1e-9;
            toast(`Lap ${tracker.lap - 1}: ${formatLapTime(e.value)}${best ? ' · BEST LAP' : ''}`, 'good', 4);
            if (best) saveBest(store, course.id, vesselId, tracker);
            break;
          }
          case 'invalidLap':
            toast(`Lap ${tracker.lap - 1}: ${formatLapTime(e.value)} · doesn't count`, 'warn', 4);
            break;
          case 'abandon':
            toast('Left the course — race abandoned', 'info', 3);
            break;
        }
      }
    };

    return {
      update(f) {
        const def = f.def ?? null;
        const vessel = isVessel(def);
        const p = f.state?.position;
        const night = nightFactor(sunElevationDeg(ctx.atmosphere.sunDirection.y));
        if (vessel && def && def.id !== vesselId) selectVessel(def.id);
        const dist = p ? courseDistance(course, p.x, p.z) : Infinity;
        near = vessel && dist < SHOW_MARGIN_M;
        const isCrashed = !!f.state?.crash;
        if (isCrashed && !crashed) resetRace(tracker, true, f.time);
        crashed = isCrashed;
        if (vessel && p && !f.paused && !isCrashed) {
          if (dist > ABANDON_M) {
            if (tracker.phase === 'racing') {
              tracker.eventCount = 0;
              resetRace(tracker, true, f.time);
              handleEvents(tracker.eventCount);
            }
          } else if (Number.isFinite(px)) {
            const n = updateRace(tracker, px, pz, p.x, p.z, f.time, f.dt);
            if (n) handleEvents(n);
          }
          px = p.x;
          pz = p.z;
        }
        model.update(f.waveTime ?? f.time, f.camera.position.x, f.camera.position.z, near ? (tracker.phase === 'idle' ? 0 : tracker.next) : -1, f.time, night);
        if (hud) {
          hud.setVisible(near && hudShown);
          if (near && (hudTimer -= f.dt) <= 0) {
            hudTimer = 0.1;
            hud.update(raceHudView(tracker, p!.x, p!.z, f.readings?.headingDeg ?? headingOf(f.state), f.time));
          }
        }
      },
      onReset() {
        resetRace(tracker, false);
        px = NaN;
        pz = NaN;
      },
      onAircraftChange(def) {
        if (isVessel(def)) selectVessel(def.id);
        else resetRace(tracker, false);
      },
      onResize: layout,
      stats: () => ({
        phase: tracker.phase,
        lap: tracker.lap,
        next: tracker.phase === 'idle' ? 'START' : course.marks[tracker.next].id,
        penalties: tracker.penalties,
        last: tracker.last,
        best: tracker.best,
        validLaps: tracker.validLaps,
        near,
        vessel: vesselId,
        lengthM: Math.round(course.length),
      }),
      dispose() {
        offBus?.();
        hud?.dispose();
        ctx.scene.remove(model.group);
        model.dispose();
      },
    };
  },
};
export default mod;

/** Heading (deg) from an AircraftState's orientation, when no readings are around. */
function headingOf(s: { orientation?: { x: number; y: number; z: number; w: number } } | undefined): number {
  const q = s?.orientation;
  if (!q) return 0;
  // body −Z (the bow) in world: x = −2(xz + wy), z = −(1 − 2(x² + y²))
  const fx = -2 * (q.x * q.z + q.w * q.y);
  const fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
  return ((Math.atan2(fx, -fz) * 180) / Math.PI + 360) % 360;
}

