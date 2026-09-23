/**
 * Lycoming O-360 + constant-speed propeller, simplified. Pure.
 *
 * Power target = idlePower + (1 − idlePower)·throttle, scaled by the density
 * ratio (normally aspirated); actual power follows with first-order lag.
 * Thrust T = P·η/√(V² + V₀²) with V₀ chosen so T(0, full) = staticThrustN,
 * minus the drag of a windmilling prop when it is not being driven hard.
 */
import { CONFIG, type Config } from '../config';
import type { Controls, EngineState } from '../types';
import { clamp, expApproach } from '../math/vec3';
import { jetCoreTarget, jetThrottleForCore, jetThrust, steadyJetEngine } from './jet';

/** Fraction of max power the engine settles at for a throttle position and air density. */
export function powerTarget(throttle: number, density: number, cfg: Config = CONFIG): number {
  const e = cfg.aircraft.engine;
  const sigma = Math.min(density / cfg.sim.seaLevelDensity, 1.1);
  return (e.idlePower + (1 - e.idlePower) * clamp(throttle, 0, 1)) * sigma;
}

/** Inverse of powerTarget (unclamped): the throttle that gives a power fraction at a density. */
export function throttleForPower(power: number, density: number, cfg: Config = CONFIG): number {
  const e = cfg.aircraft.engine;
  const sigma = Math.min(density / cfg.sim.seaLevelDensity, 1.1);
  return (power / sigma - e.idlePower) / (1 - e.idlePower);
}

/**
 * Propeller thrust (N) for a power fraction (0..1 of max power, already
 * including any altitude loss), axial airspeed (m/s) and air density.
 */
export function propThrust(powerFraction: number, airspeedMs: number, density: number, cfg: Config = CONFIG): number {
  const e = cfg.aircraft.engine;
  const eta = e.propEfficiency;
  const v0 = (e.maxPowerW * eta) / e.staticThrustN;
  const V = airspeedMs > 0 ? airspeedMs : 0;
  const p = powerFraction > 0 ? powerFraction : 0;
  const thrust = (p * e.maxPowerW * eta) / Math.sqrt(V * V + v0 * v0);
  const r = cfg.aircraft.geometry.propRadius;
  const unload = 1 - clamp(powerFraction, 0, 1);
  const windmill = e.windmillDragCoeff * unload * unload * 0.5 * density * V * V * Math.PI * r * r;
  return thrust - windmill;
}

/** Target RPM of a running engine: idle → max with power (constant-speed prop), never below windmilling. */
function runningRpm(power: number, density: number, iasKt: number, cfg: Config): number {
  const e = cfg.aircraft.engine;
  const lever = clamp(throttleForPower(power, density, cfg), 0, 1);
  const rpm = e.idleRpm + (e.maxRpm - e.idleRpm) * Math.pow(lever, 0.75);
  return Math.min(Math.max(rpm, e.windmillRpmPerKt * Math.max(0, iasKt)), e.maxRpm * 1.04);
}

/**
 * Advance the engine by dt. `axialSpeed` = forward airspeed through the prop (m/s),
 * `iasKt` drives windmilling. Returns a new EngineState (inputs untouched).
 */
export function stepEngine(
  engine: EngineState,
  controls: Pick<Controls, 'throttle' | 'engineOn'>,
  dt: number,
  density: number,
  axialSpeed: number,
  iasKt: number,
  cfg: Config = CONFIG,
): EngineState {
  const e = cfg.aircraft.engine;
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

  const target = running ? powerTarget(controls.throttle, density, cfg) : 0;
  const tau = target > engine.power ? e.spoolUpTau : e.spoolDownTau;
  let power = running ? expApproach(engine.power, target, tau, dt) : expApproach(engine.power, 0, e.spoolDownTau, dt);
  if (!running && power < 1e-4) power = 0;

  const windmill = e.windmillRpmPerKt * Math.max(0, iasKt);
  let rpmTarget: number;
  let rpmTau: number;
  if (running) {
    rpmTarget = runningRpm(power, density, iasKt, cfg);
    rpmTau = e.rpmTau;
  } else if (starting) {
    rpmTarget = Math.max(windmill, e.crankRpm);
    rpmTau = e.rpmTau;
  } else {
    rpmTarget = windmill;
    rpmTau = e.spinDownTau;
  }
  let rpm = expApproach(engine.rpm, rpmTarget, rpmTau, dt);
  if (rpm < 0.5 && rpmTarget === 0) rpm = 0;

  const thrust = propThrust(power, axialSpeed, density, cfg);
  return { running, starting, startTimer, failed, power, rpm, thrust };
}

/** Engine state of a warm engine running steadily at `power`. */
export function steadyEngine(power: number, density: number, axialSpeed: number, iasKt: number, cfg: Config = CONFIG): EngineState {
  return {
    running: true,
    starting: false,
    startTimer: 0,
    failed: false,
    power,
    rpm: runningRpm(power, density, iasKt, cfg),
    thrust: propThrust(power, axialSpeed, density, cfg),
  };
}

// ─── Engine-type dispatch (piston or jet), used by the trim solver and state creation ──────────

/** Thrust (N) of either engine type at a steady power (piston: power fraction; jet: core fraction, no AB). */
export function engineThrust(power: number, axialSpeed: number, density: number, mach: number, cfg: Config = CONFIG): number {
  return cfg.aircraft.engine.type === 'jet' ? jetThrust(power, 0, density, mach, cfg) : propThrust(power, axialSpeed, density, cfg);
}

/** Steady power (piston: fraction of max power; jet: core fraction) a throttle position settles at. */
export function enginePowerTarget(throttle: number, density: number, cfg: Config = CONFIG): number {
  return cfg.aircraft.engine.type === 'jet' ? jetCoreTarget(throttle, cfg) : powerTarget(throttle, density, cfg);
}

/** Throttle that gives a steady power (unclamped for pistons). */
export function engineThrottleForPower(power: number, density: number, cfg: Config = CONFIG): number {
  return cfg.aircraft.engine.type === 'jet' ? jetThrottleForCore(power, cfg) : throttleForPower(power, density, cfg);
}

/** A warm engine running steadily at `power` (either type). */
export function steadyEngineAny(power: number, density: number, axialSpeed: number, iasKt: number, mach: number, cfg: Config = CONFIG): EngineState {
  return cfg.aircraft.engine.type === 'jet' ? steadyJetEngine(power, density, mach, cfg) : steadyEngine(power, density, axialSpeed, iasKt, cfg);
}
