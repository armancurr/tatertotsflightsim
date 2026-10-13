/**
 * Live helm displays for the Princess V50 (pure, no three.js / DOM): what the two glass screens
 * show, taken from the helm readings (`v.instruments.vessel`, VesselReadings, and the heading),
 * quantised to what the screens can resolve, and a throttled updater that repaints only when a
 * shown value changes, at most `hz` times a second. `null` data = the static idle look (no
 * instruments passed). The painting itself lives in textures.ts (`paintScreens`).
 */
import type { AircraftVisualState } from '../../aircraft/types';
import type { MarineGear } from '../../types';

/** Everything the chart plotter and the engine page show (display units). */
export interface ScreenData {
  headingDeg: number;
  sogKt: number;
  stwKt: number;
  /** Depth under the keel, m (null = deep / out of the sounder's range). */
  depthM: number | null;
  /** Engine rpm and load %, port first. */
  rpm: number[];
  loadPct: number[];
  gear: MarineGear;
  leverPct: number;
  steerDeg: number;
  tabsPct: number;
  trimDeg: number;
  moored: boolean;
  aground: boolean;
}

const fin = (x: unknown, d = 0) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const q = (x: number, step: number) => Math.round(fin(x) / step) * step;

/** The screens' data from the visual state, quantised (null = no instruments: static idle look). */
export function screenData(v: AircraftVisualState): ScreenData | null {
  const r = v.instruments;
  const vr = r?.vessel;
  if (!r || !vr) return null;
  const hdg = ((q(r.headingDeg, 1) % 360) + 360) % 360;
  return {
    headingDeg: hdg,
    sogKt: q(vr.sogKt, 0.1),
    stwKt: q(vr.speedKt, 0.1),
    depthM: vr.depthM === null || !Number.isFinite(vr.depthM) ? null : q(vr.depthM, 0.1),
    rpm: (vr.rpm ?? []).map((x) => q(x, 10)),
    loadPct: (vr.loadPct ?? []).map((x) => q(x, 1)),
    gear: vr.gear,
    leverPct: q(vr.leverPct, 1),
    steerDeg: q(vr.steerDeg, 1),
    tabsPct: q(vr.tabsPct, 1),
    trimDeg: q(vr.trimDeg, 0.1),
    moored: !!vr.moored,
    aground: !!vr.aground,
  };
}

/** A string that changes exactly when something shown on the screens changes. */
export function screenKey(d: ScreenData | null): string {
  if (!d) return 'static';
  return [
    d.headingDeg, d.sogKt.toFixed(1), d.stwKt.toFixed(1), d.depthM === null ? '-' : d.depthM.toFixed(1),
    d.rpm.join('/'), d.loadPct.join('/'), d.gear, d.leverPct, d.steerDeg, d.tabsPct, d.trimDeg.toFixed(1),
    d.moored ? 'M' : '', d.aground ? 'A' : '',
  ].join('|');
}

export interface ScreenUpdater {
  /** Advance by dt; repaints (calls `draw`) when due and the shown data changed. Returns true on a repaint. */
  update(v: AircraftVisualState, dt: number): boolean;
  /** Repaints so far. */
  readonly redraws: number;
  /** Force the next update to repaint (e.g. after a texture is recreated). */
  invalidate(): void;
}

/** Throttled repaint: at most `hz` times a second, and only when screenKey changes. */
export function createScreenUpdater(draw: (d: ScreenData | null) => void, hz = 5): ScreenUpdater {
  let key: string | null = null;
  let clock = Infinity;
  let redraws = 0;
  const period = 1 / Math.max(0.5, hz);
  return {
    update(v, dt) {
      clock += Number.isFinite(dt) ? Math.max(0, dt) : 0;
      if (clock < period && key !== null) return false;
      const d = screenData(v);
      const k = screenKey(d);
      if (k === key) return false;
      clock = 0;
      key = k;
      redraws++;
      draw(d);
      return true;
    },
    get redraws() {
      return redraws;
    },
    invalidate() {
      key = null;
      clock = Infinity;
    },
  };
}
