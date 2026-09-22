/**
 * Fixed-step accumulator (pure, no DOM). The physics always advances in exact `fixedDt` steps,
 * whatever the display refresh rate; the renderer interpolates between the last two physics
 * states with `alpha` (see interpolate.ts).
 *
 *   const loop = new FixedStepLoop(CONFIG.sim.fixedDt, CONFIG.sim.maxSubSteps, CONFIG.sim.maxFrameDt);
 *   const { alpha } = loop.advance(frameDt, (dt) => { prev = state; state = step(state, controls, dt, env); });
 *   const pose = interpolatePose(prev, state, alpha);
 */

/** Tolerance so 1/60-ish frame times that are a hair short still run their second step. */
const EPS = 1e-9;

export class FixedStepLoop {
  private accumulator = 0;

  constructor(
    readonly fixedDt: number,
    readonly maxSubSteps: number,
    readonly maxFrameDt: number,
  ) {
    if (!(fixedDt > 0)) throw new Error('FixedStepLoop: fixedDt must be > 0');
  }

  /**
   * Add a frame's worth of real time and run as many fixed steps as fit (at most maxSubSteps).
   * Frame times are clamped to maxFrameDt; time that still doesn't fit after maxSubSteps is
   * dropped (the sim runs slow for that frame rather than spiralling).
   */
  advance(frameDt: number, stepFn: (dt: number) => void): { steps: number; alpha: number } {
    const dtIn = Number.isFinite(frameDt) && frameDt > 0 ? Math.min(frameDt, this.maxFrameDt) : 0;
    this.accumulator += dtIn;
    let steps = 0;
    while (this.accumulator >= this.fixedDt - EPS && steps < this.maxSubSteps) {
      stepFn(this.fixedDt);
      this.accumulator -= this.fixedDt;
      steps++;
    }
    if (this.accumulator >= this.fixedDt) {
      // Hit maxSubSteps: drop whole steps we could not afford, keep the fractional part.
      this.accumulator %= this.fixedDt;
    }
    if (this.accumulator < 0) this.accumulator = 0;
    let alpha = this.accumulator / this.fixedDt;
    if (!(alpha >= 0)) alpha = 0;
    if (alpha >= 1) alpha = 1 - 1e-9;
    return { steps, alpha };
  }

  reset(): void {
    this.accumulator = 0;
  }
}
