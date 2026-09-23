/**
 * Boeing 747-400 flight deck — control animation (pure): what the levers, columns, yokes and pedals
 * show for a visual state. Every output is finite and inside its mechanical range whatever the sim
 * sends (NaN, ±Infinity, out-of-range values → the nearest stop / rest).
 *
 * - Thrust levers (four, ganged — the sim has one throttle): idle (aft) … full (forward), with a few
 *   tenths of a degree of stagger between them, as real levers never sit perfectly in line.
 * - Speed brake lever: DOWN (forward) … UP (aft) with the speed brake.
 * - Flap lever: in the gate of the commanded flap setting (the 747-400 gate UP, 1, 5, 10, 20, 25, 30);
 *   it moves to the new gate quickly while the flaps themselves run slowly.
 * - Gear lever: DN / UP with the lever (command), the handle lights red while the gear is in transit.
 * - Columns fore/aft with the elevator, yokes turn with the ailerons, pedals slide with the rudder.
 */
import type { AircraftVisualState } from '../types';
import { COLUMN, FLAP_GATES, PEDALS, SPEEDBRAKE, THRUST } from './flightDeckLayout';

export interface DeckPose {
  /** Thrust lever angles, deg (+ forward), levers 1–4 (left to right). */
  thrustDeg: [number, number, number, number];
  speedBrakeDeg: number;
  /** Flap lever angle, deg, and the gate index it sits in (FLAP_GATES). */
  flapDeg: number;
  flapGate: number;
  /** Gear lever: 1 = down, 0 = up. */
  gearLever: number;
  /** Gear in transit (lever lights / disagree). */
  gearTransit: boolean;
  /** Column pitch, deg (+ = pulled aft, nose up) and yoke roll, deg (+ = right wing down). */
  columnDeg: number;
  yokeDeg: number;
  /** Pedal fore/aft offset of the LEFT pedal, m (+ aft); the right pedal moves the opposite way. */
  pedal: number;
}

export function createDeckPose(): DeckPose {
  return { thrustDeg: [THRUST.idleDeg, THRUST.idleDeg, THRUST.idleDeg, THRUST.idleDeg], speedBrakeDeg: SPEEDBRAKE.downDeg, flapDeg: FLAP_GATES[0].angle, flapGate: 0, gearLever: 1, gearTransit: false, columnDeg: 0, yokeDeg: 0, pedal: 0 };
}

const fin = (x: unknown, d = 0): number => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
/** Exponential approach (dt ≤ 0 or NaN holds; a huge dt snaps). */
const approach = (cur: number, target: number, tau: number, dt: number): number => {
  if (!(dt > 0) || !Number.isFinite(dt)) return cur;
  const k = 1 - Math.exp(-dt / tau);
  return cur + (target - cur) * k;
};

/** Small fixed stagger between the four thrust levers, deg. */
export const THRUST_STAGGER: readonly number[] = [0.35, -0.2, 0.15, -0.3];

/** Thrust lever angle for a throttle fraction 0..1. */
export function thrustLeverDeg(throttle01: number): number {
  const t = clamp(fin(throttle01), 0, 1);
  return THRUST.idleDeg + (THRUST.fullDeg - THRUST.idleDeg) * t;
}

/** The flap gate for a commanded flap angle: the gate with the nearest detent angle. */
export function flapGateFor(flapsTargetDeg: number): number {
  const d = clamp(fin(flapsTargetDeg), 0, 30);
  let best = 0;
  for (let i = 1; i < FLAP_GATES.length; i++) if (Math.abs(FLAP_GATES[i].deg - d) < Math.abs(FLAP_GATES[best].deg - d)) best = i;
  return best;
}

/**
 * Advance the pose toward what the visual state commands. Levers move with short time constants
 * (a hand moves them), so a new setting shows at once but never jumps.
 */
export function stepDeckPose(pose: DeckPose, v: AircraftVisualState, dt: number): DeckPose {
  const r = v.instruments as (Partial<{ throttlePct: number; flapsTargetDeg: number; gearHandleDown: boolean; speedBrake: boolean; gear: string }> | null);
  const snap = !(dt > 0) || !Number.isFinite(dt) ? 0 : dt;
  const lever = thrustLeverDeg(fin(r?.throttlePct, 0) / 100);
  for (let i = 0; i < 4; i++) {
    const target = clamp(lever + THRUST_STAGGER[i], THRUST.idleDeg - 1, THRUST.fullDeg + 1);
    pose.thrustDeg[i] = clamp(approach(fin(pose.thrustDeg[i], target), target, 0.08, snap), THRUST.idleDeg - 1, THRUST.fullDeg + 1);
  }
  const sb = clamp(fin(v.speedBrake, r?.speedBrake ? 1 : 0), 0, 1);
  const sbT = SPEEDBRAKE.downDeg + (SPEEDBRAKE.upDeg - SPEEDBRAKE.downDeg) * sb;
  pose.speedBrakeDeg = clamp(approach(fin(pose.speedBrakeDeg, sbT), sbT, 0.12, snap), SPEEDBRAKE.downDeg, SPEEDBRAKE.upDeg);

  const gate = flapGateFor(fin(r?.flapsTargetDeg, fin(v.flapsDeg)));
  pose.flapGate = gate;
  const fT = FLAP_GATES[gate].angle;
  const fMin = FLAP_GATES[FLAP_GATES.length - 1].angle;
  const fMax = FLAP_GATES[0].angle;
  pose.flapDeg = clamp(approach(fin(pose.flapDeg, fT), fT, 0.15, snap), fMin, fMax);

  const gp = clamp(fin(v.gearPos, 1), 0, 1);
  const handleDown = typeof r?.gearHandleDown === 'boolean' ? r.gearHandleDown : gp > 0.5;
  pose.gearLever = clamp(approach(fin(pose.gearLever, handleDown ? 1 : 0), handleDown ? 1 : 0, 0.15, snap), 0, 1);
  pose.gearTransit = gp > 0.001 && gp < 0.999;

  const colT = clamp(fin(v.elevator), -1, 1) * COLUMN.pitchDeg;
  const yokeT = clamp(fin(v.aileron), -1, 1) * COLUMN.rollDeg;
  pose.columnDeg = clamp(approach(fin(pose.columnDeg, colT), colT, 0.05, snap), -COLUMN.pitchDeg, COLUMN.pitchDeg);
  pose.yokeDeg = clamp(approach(fin(pose.yokeDeg, yokeT), yokeT, 0.05, snap), -COLUMN.rollDeg, COLUMN.rollDeg);
  // Right rudder: right pedal forward, left pedal aft.
  const pedT = clamp(fin(v.rudder), -1, 1) * PEDALS.travel;
  pose.pedal = clamp(approach(fin(pose.pedal, pedT), pedT, 0.05, snap), -PEDALS.travel, PEDALS.travel);
  return pose;
}
