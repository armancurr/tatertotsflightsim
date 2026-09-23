/**
 * Turbofan with afterburner (F-16: General Electric F110-GE-129), simplified. Pure.
 *
 * The throttle runs idle → military (full dry power) up to `jet.abDetent`; past the detent it
 * selects afterburner (minimum `abMin` at the detent → full at the stop). The core ("power",
 * 0 = idle … 1 = military) follows its target with a time constant that is long at idle and short
 * near military (a real engine accelerates slowly from idle: ~4–5 s idle → mil). The afterburner
 * lights only once the core is near military and ramps at a fixed rate (~1 s to full).
 *
 * Thrust = [idle + (mil − idle)·core]·σ^k·(1 − l·M + ramDry·M²) + ab·(max − mil)·σ^k·(1 − l·M + ramAb·M²),
 * σ = ρ/ρ₀, l = lowSpeedLapse (momentum drag), ram·M² = ram recovery. `rpm` reports core speed in %
 * (idle ≈ 70, military 100).
 */
import { CONFIG, type Config, type JetEngineConfig } from '../config';
import type { Controls, EngineState } from '../types';
import { clamp, expApproach, moveToward } from '../math/vec3';

function jetOf(cfg: Config): JetEngineConfig {
  const j = cfg.aircraft.engine.jet;
  if (!j) throw new Error(`${cfg.aircraft.name} has no jet engine`);
  return j;
}

/** Thrust (N) for a core fraction (0 idle … 1 military), afterburner intensity (0..1), density and Mach. */
export function jetThrust(core: number, ab: number, density: number, mach: number, cfg: Config = CONFIG): number {
  const j = jetOf(cfg);
  const sigma = Math.max(0, density) / cfg.sim.seaLevelDensity;
  const lapse = Math.pow(sigma, j.densityExponent);
  const m = Number.isFinite(mach) && mach > 0 ? mach : 0;
  const c = clamp(Number.isFinite(core) ? core : 0, 0, 1);
  const a = clamp(Number.isFinite(ab) ? ab : 0, 0, 1);
  const lo = 1 - j.lowSpeedLapse * m;
  const dry = (j.idleThrustN + (j.milThrustN - j.idleThrustN) * c) * lapse * (lo + j.ramDry * m * m);
  const wet = a * (j.maxThrustN - j.milThrustN) * lapse * (lo + j.ramAb * m * m);
  return dry + wet;
}

/** Core target (0 idle … 1 military) for a throttle lever position. */
export function jetCoreTarget(throttle: number, cfg: Config = CONFIG): number {
  const j = jetOf(cfg);
  return clamp(clamp(throttle, 0, 1) / j.abDetent, 0, 1);
}

/** Afterburner target (0 = off, abMin at the detent … 1 at the stop) for a throttle lever position. */
export function jetAbTarget(throttle: number, cfg: Config = CONFIG): number {
  const j = jetOf(cfg);
  const t = clamp(throttle, 0, 1);
  if (t <= j.abDetent) return 0;
  return j.abMin + (1 - j.abMin) * clamp((t - j.abDetent) / (1 - j.abDetent), 0, 1);
}

/** Throttle lever that asks for a core fraction (below the detent). */
export function jetThrottleForCore(core: number, cfg: Config = CONFIG): number {
  return core * jetOf(cfg).abDetent;
}

/** Core speed % for a core fraction: thrust grows roughly with the square of (N − N_idle). */
export function coreRpm(core: number, cfg: Config = CONFIG): number {
  const e = cfg.aircraft.engine;
  return e.idleRpm + (e.maxRpm - e.idleRpm) * Math.sqrt(clamp(core, 0, 1));
}

/**
 * Advance the jet by dt. `mach` drives the ram effect, `iasKt` the windmilling core speed.
 * Returns a new EngineState (inputs untouched).
 */
export function stepJetEngine(
  engine: EngineState,
  controls: Pick<Controls, 'throttle' | 'engineOn'>,
  dt: number,
  density: number,
  mach: number,
  iasKt: number,
  cfg: Config = CONFIG,
): EngineState {
  const e = cfg.aircraft.engine;
  const j = jetOf(cfg);
  const throttle = Number.isFinite(controls.throttle) ? controls.throttle : 0;
  let running = engine.running;
  let starting = engine.starting;
  let startTimer = engine.startTimer;
  const failed = engine.failed;

  if (failed || !controls.engineOn) {
    running = false;
    starting = false;
    startTimer = 0;
  } else if (!running) {
    if (!starting) {
      starting = true;
      startTimer = 0;
    }
    startTimer += dt;
    if (startTimer >= e.startTime) {
      running = true;
      starting = false;
      startTimer = 0;
    }
  }

  const prevCore = clamp(Number.isFinite(engine.power) ? engine.power : 0, 0, 1);
  const prevAb = clamp(engine.afterburner ?? 0, 0, 1);
  let core = 0;
  let ab = 0;
  let rpm: number;
  const windmill = e.windmillRpmPerKt * Math.max(0, Number.isFinite(iasKt) ? iasKt : 0);
  if (running) {
    const target = jetCoreTarget(throttle, cfg);
    const tau = target > prevCore ? j.spoolUpTauIdle + (j.spoolUpTauMil - j.spoolUpTauIdle) * prevCore : j.spoolDownTau;
    core = clamp(expApproach(prevCore, target, tau, dt), 0, 1);
    // Close the last sliver so the core actually reaches military (the exponential never quite does).
    if (Math.abs(core - target) < 2e-4) core = target;
    const abWanted = core >= j.abLightCore ? jetAbTarget(throttle, cfg) : 0;
    ab = moveToward(prevAb, abWanted, (abWanted > prevAb ? j.abRampUpPerSec : j.abRampDownPerSec) * dt);
    // Core speed follows the core with a short lag (after light-off it runs up from the starter speed).
    rpm = expApproach(Number.isFinite(engine.rpm) ? engine.rpm : 0, coreRpm(core, cfg), e.rpmTau, dt);
  } else {
    // Not running: the core coasts down (starter-motored while starting, windmilling otherwise).
    const rpmTarget = starting ? Math.max(windmill, e.crankRpm) : windmill;
    const tau = starting ? e.rpmTau * 4 : e.spinDownTau;
    rpm = expApproach(Number.isFinite(engine.rpm) ? engine.rpm : 0, rpmTarget, tau, dt);
    if (rpm < 0.05 && rpmTarget === 0) rpm = 0;
  }
  const thrust = running ? jetThrust(core, ab, density, mach, cfg) : 0;
  return { running, starting, startTimer, failed, power: core, rpm: clamp(rpm, 0, e.maxRpm * 1.04), thrust, afterburner: ab };
}

/** A warm jet running steadily at `core` (afterburner out). */
export function steadyJetEngine(core: number, density: number, mach: number, cfg: Config = CONFIG): EngineState {
  const c = clamp(core, 0, 1);
  return {
    running: true,
    starting: false,
    startTimer: 0,
    failed: false,
    power: c,
    rpm: coreRpm(c, cfg),
    thrust: jetThrust(c, 0, density, mach, cfg),
    afterburner: 0,
  };
}
