/**
 * Steady-flight trim solver: finds the angle of attack, engine power and
 * elevator trim that hold a given indicated airspeed on a given flight path
 * hands-off (elevator 0, wings level, no sideslip), using exactly the same
 * force model as step(). Pure.
 */
import { CONFIG, KT_TO_MS, type Config } from '../config';
import { airDensity } from './atmosphere';
import { computeAero, liftCoefficient } from './aero';
import { enginePowerTarget, engineThrottleForPower, engineThrust } from './engine';
import { speedOfSound } from './atmosphere';
import { quatFromEuler, worldToBody } from './frames';

const DEG = Math.PI / 180;
const ZERO = Object.freeze({ x: 0, y: 0, z: 0 });

export interface TrimRequest {
  /** Altitude MSL, m. */
  altitudeM: number;
  /** Indicated airspeed, kt. */
  iasKt: number;
  /** Flight path angle, deg (+ climbing). Default 0 (level). */
  flightPathDeg?: number;
  /** Flap notch index into config.aircraft.flaps.notchesDeg. Default 0. */
  flapsNotch?: number;
  /** Gear down (default true) or up. */
  gearDown?: boolean;
  /** Heading, deg. Default 0 (north). Used by createTrimmedState. */
  headingDeg?: number;
  /** Horizontal position for createTrimmedState, m. Default 0, 0. */
  x?: number;
  z?: number;
}

export interface TrimResult {
  /** Angle of attack, rad. */
  alpha: number;
  /** Pitch attitude, deg. */
  pitchDeg: number;
  /** True airspeed, m/s. */
  tas: number;
  density: number;
  /** Engine power fraction (0..1 of max). */
  power: number;
  thrust: number;
  /** Throttle lever that produces that power at this density (clamped 0..1). */
  throttle: number;
  /** Elevator trim -1..1 (clamped). */
  elevatorTrim: number;
  flapsDeg: number;
  /** True when the solution is exact and within the throttle/trim ranges. */
  converged: boolean;
}

function solve3(J: number[][], r: number[]): number[] | null {
  const [a, b, c] = J;
  const det =
    a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-14) return null;
  const col = (k: number) => {
    const m = J.map((row, i) => row.map((v, j) => (j === k ? r[i] : v)));
    const [p, q, s] = m;
    return (p[0] * (q[1] * s[2] - q[2] * s[1]) - p[1] * (q[0] * s[2] - q[2] * s[0]) + p[2] * (q[0] * s[1] - q[1] * s[0])) / det;
  };
  return [col(0), col(1), col(2)];
}

export function solveTrim(req: TrimRequest, cfg: Config = CONFIG): TrimResult {
  const ac = cfg.aircraft;
  const notches = ac.flaps.notchesDeg;
  const flapsDeg = notches[Math.max(0, Math.min(notches.length - 1, Math.round(req.flapsNotch ?? 0)))];
  const gearPos = req.gearDown === false ? 0 : 1;
  const gamma = (req.flightPathDeg ?? 0) * DEG;
  const rho = airDensity(req.altitudeM);
  const V = req.iasKt * KT_TO_MS * Math.sqrt(cfg.sim.seaLevelDensity / rho);
  const W = ac.mass * cfg.sim.gravity;
  const qbar = 0.5 * rho * V * V;
  const scaleM = qbar * ac.wingArea * ac.meanChord;
  const mach = V / speedOfSound(req.altitudeM);

  const residual = (x: number[]): number[] => {
    const [alpha, power, trim] = x;
    const vb = { x: 0, y: -V * Math.sin(alpha), z: -V * Math.cos(alpha) };
    const thrust = engineThrust(power, V * Math.cos(alpha), rho, mach, cfg);
    const a = computeAero(vb, ZERO, rho, flapsDeg, gearPos, { elevator: 0, aileron: 0, rudder: 0, elevatorTrim: trim }, thrust, cfg, Infinity, { mach });
    const q = quatFromEuler(0, (gamma + alpha) / DEG, 0);
    const g = worldToBody(q, { x: 0, y: -W, z: 0 });
    return [(a.fy + g.y) / W, (a.fz + g.z) / W, a.tx / scaleM];
  };

  // Initial guess from the linear lift curve.
  const clNeed = (W * Math.cos(gamma)) / (qbar * ac.wingArea);
  const cl0 = liftCoefficient(0, flapsDeg, cfg);
  let x = [(clNeed - cl0) / ac.aero.clAlpha, ac.spawn.approach.throttle, 0];
  let r = residual(x);
  for (let it = 0; it < 40; it++) {
    const norm = Math.abs(r[0]) + Math.abs(r[1]) + Math.abs(r[2]);
    if (norm < 1e-12) break;
    const h = [1e-6, 1e-6, 1e-6];
    const J: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let j = 0; j < 3; j++) {
      const xp = x.slice();
      xp[j] += h[j];
      const rp = residual(xp);
      for (let i = 0; i < 3; i++) J[i][j] = (rp[i] - r[i]) / h[j];
    }
    const dx = solve3(J, r);
    if (!dx) break;
    // Damped Newton step (keeps alpha on the attached part of the lift curve).
    let lambda = 1;
    let next = x;
    let rn = r;
    for (let k = 0; k < 8; k++) {
      next = [x[0] - lambda * dx[0], x[1] - lambda * dx[1], x[2] - lambda * dx[2]];
      next[0] = Math.max(-0.3, Math.min(0.35, next[0]));
      rn = residual(next);
      if (Math.abs(rn[0]) + Math.abs(rn[1]) + Math.abs(rn[2]) < norm) break;
      lambda *= 0.5;
    }
    x = next;
    r = rn;
  }

  const [alpha, powerRaw, trimRaw] = x;
  const norm = Math.abs(r[0]) + Math.abs(r[1]) + Math.abs(r[2]);
  const throttleRaw = engineThrottleForPower(powerRaw, rho, cfg);
  const throttle = Math.max(0, Math.min(1, throttleRaw));
  const elevatorTrim = Math.max(-1, Math.min(1, trimRaw));
  // Never hand back more power than the engine can make here (an infeasible request is flagged instead).
  const power = Math.max(0, Math.min(powerRaw, enginePowerTarget(1, rho, cfg)));
  return {
    alpha,
    pitchDeg: (gamma + alpha) / DEG,
    tas: V,
    density: rho,
    power,
    thrust: engineThrust(power, V * Math.cos(alpha), rho, mach, cfg),
    throttle,
    elevatorTrim,
    flapsDeg,
    converged: norm < 1e-6 && throttle === throttleRaw && elevatorTrim === trimRaw && powerRaw >= 0,
  };
}
