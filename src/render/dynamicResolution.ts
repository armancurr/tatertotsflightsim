/**
 * Pure dynamic-resolution controller: lowers the render pixel ratio when the
 * frame rate sits below target and restores it when there is headroom.
 *
 * With vsync the frame rate is capped at the display rate, so "headroom" can
 * only be discovered by probing: after `upDelay` seconds at (nearly) full
 * frame rate the ratio is raised one step. If the frame rate then drops within
 * `probeWindow` seconds the probe failed: the ratio goes back down and the
 * next probe waits twice as long (up to `maxUpDelay`). This hysteresis keeps
 * the resolution from oscillating on a GPU that sits right at the edge.
 */

export interface DynamicResolutionOptions {
  targetFps: number;
  minPixelRatio: number;
  maxPixelRatio: number;
  /** Starting ratio (default: maxPixelRatio). */
  initialPixelRatio?: number;
  /** Multiplicative step when lowering (default 0.85). Raising uses 1/stepDown. */
  stepDown?: number;
  /** Frame rate below targetFps × this counts as "slow" (default 0.92). */
  slowFraction?: number;
  /** Frame rate at or above targetFps × this counts as "headroom" (default 0.98). */
  headroomFraction?: number;
  /** Seconds of sustained slowness before lowering (default 1.0). */
  downDelay?: number;
  /** Seconds of sustained headroom before probing a higher ratio (default 4). */
  upDelay?: number;
  /** Cap for the exponential back-off of upDelay after failed probes (default 60). */
  maxUpDelay?: number;
  /** A slowdown within this many seconds of raising counts as a failed probe (default 3). */
  probeWindow?: number;
  /** After any change, wait this long before judging again (default 0.6 s). */
  settleTime?: number;
  /** Frames longer than this are ignored (tab switch, GC pause…) (default 0.25 s). */
  maxDt?: number;
  /** Time constant of the frame-time average, seconds (default 0.35). */
  smoothing?: number;
  /**
   * Seconds of headroom per raise during the first ramp up from a conservative start (default: none,
   * i.e. upDelay). The ramp ends at the first failed probe, where the GPU's limit was found.
   */
  rampUpDelay?: number;
  /** Seconds of frames after start/reset that are not judged (start-up streaming, shader compiles) (default 0). */
  warmup?: number;
}

export interface DynamicResolution {
  readonly pixelRatio: number;
  /** Feed one frame's duration (seconds). Returns the new ratio when it changed, else null. */
  update(dt: number): number | null;
  /** Restore a ratio (default: the maximum) and clear all timers/back-off. */
  reset(pixelRatio?: number): void;
}

export function createDynamicResolution(opts: DynamicResolutionOptions): DynamicResolution {
  const minR = opts.minPixelRatio;
  const maxR = opts.maxPixelRatio;
  const stepDown = opts.stepDown ?? 0.85;
  const slowFps = opts.targetFps * (opts.slowFraction ?? 0.92);
  const fastFps = opts.targetFps * (opts.headroomFraction ?? 0.98);
  const downDelay = opts.downDelay ?? 1.0;
  const baseUpDelay = opts.upDelay ?? 4;
  const maxUpDelay = opts.maxUpDelay ?? 60;
  const probeWindow = opts.probeWindow ?? 3;
  const settleTime = opts.settleTime ?? 0.6;
  const maxDt = opts.maxDt ?? 0.25;
  const tau = opts.smoothing ?? 0.35;
  const rampUpDelay = opts.rampUpDelay !== undefined && opts.rampUpDelay > 0 ? opts.rampUpDelay : 0;
  const warmupS = opts.warmup !== undefined && opts.warmup > 0 ? opts.warmup : 0;

  const clamp = (r: number) => Math.min(maxR, Math.max(minR, Math.round(r * 1000) / 1000));

  let ratio = clamp(opts.initialPixelRatio ?? maxR);
  let avgDt = 1 / opts.targetFps;
  let slowTime = 0;
  let fastTime = 0;
  let settle = 0;
  let upDelay = baseUpDelay;
  let sinceRaise = Infinity;
  let ramping = rampUpDelay > 0;
  let warm = warmupS;

  function reset(pixelRatio?: number) {
    ratio = clamp(pixelRatio ?? maxR);
    avgDt = 1 / opts.targetFps;
    slowTime = 0;
    fastTime = 0;
    settle = 0;
    upDelay = baseUpDelay;
    sinceRaise = Infinity;
    ramping = rampUpDelay > 0;
    warm = warmupS;
  }

  function update(dt: number): number | null {
    if (!(dt > 0) || dt > maxDt) return null;
    avgDt += (dt - avgDt) * (1 - Math.exp(-dt / tau));
    sinceRaise += dt;
    if (warm > 0) {
      warm -= dt;
      return null;
    }
    if (settle > 0) {
      settle -= dt;
      return null;
    }
    const fps = 1 / avgDt;
    if (fps < slowFps) {
      slowTime += dt;
      fastTime = 0;
    } else if (fps >= fastFps) {
      fastTime += dt;
      slowTime = 0;
    } else {
      slowTime = 0;
      fastTime = 0;
    }

    if (slowTime >= downDelay && ratio > minR) {
      if (sinceRaise < probeWindow) {
        upDelay = Math.min(maxUpDelay, upDelay * 2);
        ramping = false;
      }
      ratio = clamp(ratio * stepDown);
      slowTime = 0;
      fastTime = 0;
      settle = settleTime;
      return ratio;
    }
    if (fastTime >= (ramping ? Math.min(rampUpDelay, upDelay) : upDelay) && ratio < maxR) {
      ratio = clamp(ratio / stepDown);
      fastTime = 0;
      slowTime = 0;
      settle = settleTime;
      sinceRaise = 0;
      return ratio;
    }
    return null;
  }

  return {
    get pixelRatio() {
      return ratio;
    },
    update,
    reset,
  };
}
