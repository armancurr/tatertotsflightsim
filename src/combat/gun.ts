/**
 * PURE rotary-cannon state machine (GAU-8/A, M61A1): the trigger spins the barrels up over
 * `spinUpS`; at full speed rounds leave at `rateRps` until the trigger is released or the drum is
 * empty; the barrels coast down over `spinDownS`. Round emission times are exact within the frame
 * (the caller spawns each at its own sub-frame time, so a 60 fps frame's ~1.1 rounds don't clump),
 * and the cadence carries across frames. Also the circular-Gaussian dispersion of each round.
 */
import type { GunConfig } from '../config';
import type { Rng } from './rng';

/** Max rounds one step can emit (100 rds/s × the 0.25 s frame clamp, with margin). */
export const GUN_MAX_ROUNDS_PER_STEP = 64;

export interface GunState {
  /** Barrel speed 0..1. */
  spin: number;
  rounds: number;
  /** Rounds were leaving on the last step. */
  firing: boolean;
  /** Time from the start of the next step to the next round while a burst continues, s. */
  nextT: number;
  /** Rounds fired in the current burst. */
  burst: number;
}

export interface GunStep {
  /** Rounds are leaving the barrel this step (trigger + at speed + rounds left + allowed). */
  firing: boolean;
  /** Rounds emitted this step; their times from the step start are in `times[0..count)`. */
  count: number;
  /** A burst began / ended this step. */
  started: boolean;
  stopped: boolean;
  /** Rounds in the burst (the finished burst's total when `stopped`). */
  burst: number;
}

export const newGunStep = (): GunStep => ({ firing: false, count: 0, started: false, stopped: false, burst: 0 });

export function createGunState(cfg: GunConfig | null): GunState {
  return { spin: 0, rounds: cfg ? cfg.rounds : 0, firing: false, nextT: 0, burst: 0 };
}

export function reloadGun(g: GunState, cfg: GunConfig | null): void {
  g.spin = 0;
  g.rounds = cfg ? cfg.rounds : 0;
  g.firing = false;
  g.nextT = 0;
  g.burst = 0;
}

/**
 * Advance the gun by dt. `trigger` = the pilot holds the trigger; `allowed` = the aircraft can fire
 * (not crashed). Writes the emission times (s from the step start, ascending) into `times`.
 */
export function stepGun(g: GunState, cfg: GunConfig | null, trigger: boolean, allowed: boolean, dtIn: number, times: Float64Array, out: GunStep): GunStep {
  const dt = Number.isFinite(dtIn) && dtIn > 0 ? Math.min(dtIn, 1) : 0;
  out.count = 0;
  out.started = false;
  out.stopped = false;
  const wasFiring = g.firing;
  if (!cfg) {
    g.spin = 0;
    g.firing = false;
    out.firing = false;
    out.burst = 0;
    return out;
  }
  // Barrels: spin up while the trigger is held (even when empty — it just clicks), else coast down.
  let tFire = -1;
  if (trigger && allowed) {
    if (g.spin >= 1) tFire = 0;
    else {
      const need = (1 - g.spin) * cfg.spinUpS;
      if (need <= dt) tFire = need;
      g.spin = cfg.spinUpS > 0 ? Math.min(1, g.spin + dt / cfg.spinUpS) : 1;
      if (tFire >= 0) g.spin = 1;
    }
  } else {
    g.spin = cfg.spinDownS > 0 ? Math.max(0, g.spin - dt / cfg.spinDownS) : 0;
  }

  const firing = tFire >= 0 && g.rounds > 0;
  if (firing) {
    const period = 1 / Math.max(1e-3, cfg.rateRps);
    // A continuing burst keeps its cadence; a new one fires its first round as the barrels reach speed.
    let t = wasFiring ? Math.max(tFire, g.nextT) : tFire;
    while (t <= dt + 1e-9 && g.rounds > 0 && out.count < times.length) {
      times[out.count++] = Math.min(t, dt);
      g.rounds--;
      t += period;
    }
    g.nextT = Math.max(0, t - dt);
    if (!wasFiring) {
      g.burst = 0;
      out.started = true;
    }
    g.burst += out.count;
  } else if (wasFiring) {
    out.stopped = true;
  }
  g.firing = firing;
  out.firing = firing;
  out.burst = g.burst;
  if (out.stopped) g.burst = 0;
  return out;
}

/**
 * Angular offsets (rad) of one round from the gun line: circular Gaussian with 80 % of rounds inside
 * `r80Mrad` (for a 2-D normal P(r ≤ R) = 1 − e^{−R²/2σ²} → σ = r80 / √(2 ln 5) = r80 / 1.794).
 */
export function disperse(rng: Rng, r80Mrad: number, out: { a: number; b: number }): void {
  const sigma = (Number.isFinite(r80Mrad) && r80Mrad > 0 ? r80Mrad : 0) * 1e-3 / Math.sqrt(2 * Math.log(5));
  out.a = rng.gauss() * sigma;
  out.b = rng.gauss() * sigma;
}
