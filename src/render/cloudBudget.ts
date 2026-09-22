/**
 * Frame-budget controller for the clouds (pure).
 *
 * Levels: 0 'volumetric' (raymarch at config.render.cloudResolution),
 * 1 'volumetric-low' (raymarch at ~70 % of that per axis), 2 'billboard'
 * (the instanced puff clouds). The cloud pass is timed on the GPU when
 * EXT_disjoint_timer_query_webgl2 exists; the smoothed time over `budgetMs`
 * for `downDelay` seconds degrades one level. Without a timer, a frame rate
 * below 90 % of target degrades only once dynamic resolution has already hit
 * its minimum (lowering the pixel ratio is the cheaper fix). After `upDelay`
 * seconds of headroom the controller probes one level up; a probe that fails
 * within `probeWindow` doubles the next wait (up to `maxUpDelay`).
 */

export const CLOUD_QUALITIES = ['volumetric', 'volumetric-low', 'billboard'] as const;
export type CloudQuality = (typeof CLOUD_QUALITIES)[number];

export interface CloudBudgetOptions {
  /** GPU ms allowed for the cloud pass. */
  budgetMs: number;
  targetFps: number;
  forced?: CloudQuality;
  downDelay?: number;
  upDelay?: number;
  maxUpDelay?: number;
  probeWindow?: number;
  /** Seconds after any change before judging again. */
  settleTime?: number;
  /** Frames longer than this are ignored (tab switch, GC). */
  maxDt?: number;
}

export interface CloudBudget {
  readonly level: number;
  readonly quality: CloudQuality;
  /** Smoothed GPU ms of the cloud pass (NaN until measured). */
  readonly gpuMs: number;
  /** Feed one frame. Returns the new quality when it changed, else null. */
  update(dt: number, cloudGpuMs: number | null, pixelRatioAtMin: boolean): CloudQuality | null;
  reset(level?: number): void;
}

export function createCloudBudget(o: CloudBudgetOptions): CloudBudget {
  const downDelay = o.downDelay ?? 1.5;
  const baseUp = o.upDelay ?? 8;
  const maxUp = o.maxUpDelay ?? 120;
  const probeWindow = o.probeWindow ?? 4;
  const settleTime = o.settleTime ?? 1;
  const maxDt = o.maxDt ?? 0.25;
  const forcedLevel = o.forced ? CLOUD_QUALITIES.indexOf(o.forced) : -1;

  let level = forcedLevel >= 0 ? forcedLevel : 0;
  let gpu = NaN;
  let avgDt = 1 / o.targetFps;
  let over = 0;
  let head = 0;
  let settle = 0;
  let upDelay = baseUp;
  let sinceUp = Infinity;

  function reset(l = forcedLevel >= 0 ? forcedLevel : 0) {
    level = Math.min(CLOUD_QUALITIES.length - 1, Math.max(0, l));
    gpu = NaN;
    avgDt = 1 / o.targetFps;
    over = 0;
    head = 0;
    settle = 0;
    upDelay = baseUp;
    sinceUp = Infinity;
  }

  function update(dt: number, cloudGpuMs: number | null, atMin: boolean): CloudQuality | null {
    if (forcedLevel >= 0 || !(dt > 0) || dt > maxDt) return null;
    const k = 1 - Math.exp(-dt / 0.4);
    avgDt += (dt - avgDt) * k;
    if (cloudGpuMs !== null && Number.isFinite(cloudGpuMs)) gpu = Number.isNaN(gpu) ? cloudGpuMs : gpu + (cloudGpuMs - gpu) * k;
    sinceUp += dt;
    if (settle > 0) {
      settle -= dt;
      return null;
    }
    const fps = 1 / avgDt;
    const timed = !Number.isNaN(gpu);
    const isOver = (timed && gpu > o.budgetMs) || (fps < o.targetFps * 0.9 && (atMin || !timed) && (!timed || gpu > o.budgetMs * 0.5));
    // Headroom: frame rate at target and (when timed) the cheaper level leaves room for the next one (~2× cost).
    const isHead = fps >= o.targetFps * 0.97 && (!timed || gpu * 2 < o.budgetMs * 0.85);
    if (isOver) {
      over += dt;
      head = 0;
    } else if (isHead) {
      head += dt;
      over = 0;
    } else {
      over = 0;
      head = 0;
    }
    // Without a GPU timer, only degrade on frame rate when the resolution can't drop further.
    if (over >= downDelay && level < CLOUD_QUALITIES.length - 1 && (timed || atMin)) {
      if (sinceUp < probeWindow) upDelay = Math.min(maxUp, upDelay * 2);
      level++;
      over = 0;
      head = 0;
      settle = settleTime;
      gpu = NaN;
      return CLOUD_QUALITIES[level];
    }
    if (head >= upDelay && level > 0) {
      level--;
      head = 0;
      over = 0;
      settle = settleTime;
      sinceUp = 0;
      gpu = NaN;
      return CLOUD_QUALITIES[level];
    }
    return null;
  }

  return {
    get level() {
      return level;
    },
    get quality() {
      return CLOUD_QUALITIES[level];
    },
    get gpuMs() {
      return gpu;
    },
    update,
    reset,
  };
}
