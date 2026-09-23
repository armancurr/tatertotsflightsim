/**
 * Fly-by-wire (F-16 style), a pure layer between the pilot's controls and the control surfaces.
 * applyFbw(state, pilot, cfg) returns the Controls the airframe actually flies with; step()
 * calls it when `cfg.aircraft.fbw` is set.
 *
 * Command laws (what the stick means):
 *   Pitch, gear up:    stick → normal load factor, +maxG (full aft) … minG (full forward); neutral
 *                      stick = the load that holds the flight path (1 g wings level, bank-compensated
 *                      up to bankCompensationDeg) → "hands off holds attitude".
 *   Pitch, gear down:  stick → flight-path rate (±pathRateGearDownDeg), neutral = hold the path.
 *   AoA limiter:       the load command is cut to what aoaLimitDeg (gear down: aoaLimitGearDownDeg)
 *                      can make, so a full pull at low speed parks at the limit instead of stalling.
 *   Roll:              stick → roll rate (maxRollRateDeg), reduced at high α, with the gear down and
 *                      as sideslip builds (departure protection against roll coupling); the roll
 *                      acceleration is limited (rollAccelDeg building, rollStopAccelDeg stopping) so a
 *                      keyboard tap gives a modest bank change and a held stick builds to the full rate.
 *   Stick gradients:   curved (rollShaping / pitchShaping) — fine near centre, full at the stops.
 *   Yaw:               sideslip → 0 with turn coordination and stability-axis roll (r = p·tan α);
 *                      pedals command a small sideslip.
 *   On the wheels:     pitch-rate command (full stick ≈ groundPitchRateDeg) that fades to zero at
 *                      groundPitchLimitDeg of pitch — tail-strike protection; ailerons and pedals
 *                      direct. Blends into the flight laws over liftoffBlendS after lift-off.
 *
 * Inner loops are nonlinear dynamic inversion: the desired angular accelerations become required
 * moments (incl. gyroscopic terms), and the surfaces that make them are solved from the aircraft's
 * own aero model (computeAero at the current state, surfaces 0 and 1 — the controls are linear).
 */
import { CONFIG, type Config, type FbwConfig } from '../config';
import type { AircraftState, Controls } from '../types';
import { clamp, smoothstep } from '../math/vec3';
import { computeAero, liftCoefficient } from './aero';
import { speedOfSound } from './atmosphere';

const DEG = Math.PI / 180;

/** What the control laws are asking for (for tests, the HUD and debugging). */
export interface FbwTelemetry {
  /** Commanded load factor (after the AoA limiter), g. */
  nCmd: number;
  /** Commanded angle of attack and the active AoA limit, deg. */
  alphaCmdDeg: number;
  alphaLimitDeg: number;
  /** Commanded roll rate, deg/s, and sideslip, deg. */
  pCmdDeg: number;
  betaCmdDeg: number;
  /** 0 = ground (direct) laws … 1 = flight laws. */
  airBlend: number;
}

const fin = (v: number, d = 0): number => (Number.isFinite(v) ? v : d);

/** Neutral-stick bank compensation: 1/cos φ up to the limit, fading through 0 at knife-edge to −1/cos(limit) inverted. */
function bankCompensation(phi: number, limitDeg: number): number {
  const L = clamp(limitDeg, 0, 80) * DEG;
  const a = Math.abs(phi);
  if (a <= L || a >= Math.PI - L) return 1 / Math.cos(phi);
  const t = (a - L) / (Math.PI - 2 * L); // 0 at the limit … 1 at 180° − limit
  return (1 - 2 * t) / Math.cos(L);
}

interface Air {
  V: number;
  rho: number;
  qS: number;
  alpha: number;
  beta: number;
  gamma: number;
  phi: number;
  theta: number;
  mach: number;
}

function airOf(s: AircraftState, cfg: Config): Air {
  const d = s.derived;
  const V = Math.max(1, fin(d.tas, 1));
  const rho = fin(d.density, cfg.sim.seaLevelDensity);
  return {
    V,
    rho,
    qS: 0.5 * rho * V * V * cfg.aircraft.wingArea,
    alpha: fin(d.alpha),
    beta: fin(d.beta),
    gamma: Math.asin(clamp(fin(d.verticalSpeed) / V, -1, 1)),
    phi: fin(d.rollDeg) * DEG,
    theta: fin(d.pitchDeg) * DEG,
    mach: V / speedOfSound(s.position.y),
  };
}

/** Load factor the lift (+ thrust tilt) makes at angle of attack a. */
function loadAt(a: number, air: Air, flapsDeg: number, thrust: number, W: number, cfg: Config): number {
  return (air.qS * liftCoefficient(a, flapsDeg, cfg) + thrust * Math.sin(a)) / W;
}

/** The pitch command: load factor after the AoA limiter, and the α that makes it. */
function pitchCommand(s: AircraftState, stickRaw: number, gearDown: boolean, air: Air, f: FbwConfig, cfg: Config) {
  const stick = (1 - f.pitchShaping) * stickRaw + f.pitchShaping * stickRaw * Math.abs(stickRaw);
  const ac = cfg.aircraft;
  const g = cfg.sim.gravity;
  const W = ac.mass * g;
  const thrust = Math.max(0, fin(s.engine.thrust));
  const n0 = Math.cos(air.gamma) * bankCompensation(air.phi, f.bankCompensationDeg);
  let nCmd: number;
  if (gearDown) nCmd = clamp(n0 + (stick * air.V * f.pathRateGearDownDeg * DEG) / g, f.minG, f.maxG);
  else nCmd = stick >= 0 ? n0 + stick * (f.maxG - n0) : n0 + stick * (n0 - f.minG);
  const aMax = (gearDown ? f.aoaLimitGearDownDeg : f.aoaLimitDeg) * DEG;
  const aMin = f.minAoaDeg * DEG;
  // Invert the lift curve (monotonic between the limits) by bisection.
  let alphaCmd: number;
  if (loadAt(aMax, air, s.flapsDeg, thrust, W, cfg) <= nCmd) alphaCmd = aMax;
  else if (loadAt(aMin, air, s.flapsDeg, thrust, W, cfg) >= nCmd) alphaCmd = aMin;
  else {
    let lo = aMin;
    let hi = aMax;
    for (let i = 0; i < 14; i++) {
      const mid = 0.5 * (lo + hi);
      if (loadAt(mid, air, s.flapsDeg, thrust, W, cfg) < nCmd) lo = mid;
      else hi = mid;
    }
    alphaCmd = 0.5 * (lo + hi);
  }
  const nAch = loadAt(alphaCmd, air, s.flapsDeg, thrust, W, cfg);
  return { nCmd: nAch, alphaCmd, alphaLimit: aMax };
}

/** The laws' commands at this state (no surface solving). */
export function fbwCommands(state: AircraftState, pilot: Controls, cfg: Config = CONFIG): FbwTelemetry {
  const f = cfg.aircraft.fbw;
  const air = airOf(state, cfg);
  const blend = state.onGround ? 0 : clamp(state.airborneTime / Math.max(1e-3, f?.liftoffBlendS ?? 1), 0, 1);
  if (!f) return { nCmd: 1, alphaCmdDeg: air.alpha / DEG, alphaLimitDeg: 90, pCmdDeg: 0, betaCmdDeg: 0, airBlend: blend };
  const pc = pitchCommand(state, clamp(fin(pilot.elevator), -1, 1), pilot.gearDown !== false, air, f, cfg);
  const roll = rollCommand(clamp(fin(pilot.aileron), -1, 1), pilot.gearDown !== false, air.alpha, pc.alphaLimit, f, air.beta);
  return {
    nCmd: pc.nCmd,
    alphaCmdDeg: pc.alphaCmd / DEG,
    alphaLimitDeg: pc.alphaLimit / DEG,
    pCmdDeg: roll / DEG,
    betaCmdDeg: -clamp(fin(pilot.rudder), -1, 1) * f.pedalBetaDeg,
    airBlend: blend,
  };
}

function rollCommand(stick: number, gearDown: boolean, alpha: number, alphaLimit: number, f: FbwConfig, beta = 0): number {
  const pMax = (gearDown ? f.maxRollRateGearDownDeg : f.maxRollRateDeg) * DEG;
  const kAlpha = 1 - (1 - f.rollAtAoaLimitFraction) * smoothstep(f.rollAoaStartDeg * DEG, alphaLimit, Math.abs(alpha));
  const kBeta = 1 - smoothstep(f.betaLimitStartDeg * DEG, f.betaLimitFullDeg * DEG, Math.abs(beta));
  const k = kAlpha * kBeta;
  const shaped = (1 - f.rollShaping) * stick + f.rollShaping * stick * stick * stick;
  return shaped * pMax * k;
}

/**
 * The surfaces the fly-by-wire commands for the pilot's inputs at this state. Pure: returns new
 * Controls (elevator/aileron/rudder replaced, everything else passed through), inputs untouched.
 */
export function applyFbw(state: AircraftState, pilot: Controls, cfg: Config = CONFIG): Controls {
  const f = cfg.aircraft.fbw;
  if (!f) return pilot;
  const ac = cfg.aircraft;
  const stick = clamp(fin(pilot.elevator), -1, 1);
  const lat = clamp(fin(pilot.aileron), -1, 1);
  const pedal = clamp(fin(pilot.rudder), -1, 1);
  const w = state.angularVelocity;
  const q = fin(w.x);
  // Take-off/landing laws on the wheels (or too slow for the flight laws): pitch-rate command with a
  // pitch-attitude protection so a held full-aft stick can't drag the tail.
  const theta = fin(state.derived.pitchDeg) * DEG;
  const qCmdGround = Math.min(stick * f.groundPitchRateDeg * DEG, f.groundPitchProtectGain * (f.groundPitchLimitDeg * DEG - theta));
  const eGround = clamp(stick * f.groundElevatorGain + f.groundPitchRateGain * (qCmdGround - q), -1, 1);
  const air = airOf(state, cfg);
  const blend = state.onGround ? 0 : clamp(state.airborneTime / Math.max(1e-3, f.liftoffBlendS), 0, 1) * smoothstep(15, 30, air.V);
  if (blend <= 0) return { ...pilot, elevator: eGround, aileron: lat, rudder: pedal };

  const g = cfg.sim.gravity;
  const I = ac.inertia;
  const wx = q;
  const wy = fin(w.y);
  const wz = fin(w.z);
  const p = -wz;
  const r = -wy;
  const gearDown = pilot.gearDown !== false;

  // ── Commands ──
  const pc = pitchCommand(state, stick, gearDown, air, f, cfg);
  const qCmd = (g * (pc.nCmd - Math.cos(air.gamma) * Math.cos(air.phi))) / air.V;
  const pCmd = rollCommand(lat, gearDown, air.alpha, pc.alphaLimit, f, air.beta);
  const betaCmd = -pedal * f.pedalBetaDeg * DEG;
  const rCmd = p * Math.tan(clamp(air.alpha, -1, 1)) + (g * Math.cos(air.theta) * Math.sin(air.phi)) / air.V;

  // ── Desired angular accelerations (aircraft convention) ──
  const qDot = f.pitchOmega * f.pitchOmega * (pc.alphaCmd - air.alpha) + 2 * f.pitchZeta * f.pitchOmega * (qCmd - q);
  // Roll shaping: limit the commanded roll acceleration (building the rate / taking it off).
  const pDotRaw = (pCmd - p) / f.rollTau;
  const stopping = p !== 0 && Math.sign(pDotRaw) !== Math.sign(p);
  const pAccMax = (stopping ? f.rollStopAccelDeg : f.rollAccelDeg) ?? Infinity;
  const pDot = clamp(pDotRaw, -pAccMax * DEG, pAccMax * DEG);
  const rDot = f.yawOmega * f.yawOmega * (air.beta - betaCmd) + 2 * f.yawZeta * f.yawOmega * (rCmd - r);

  // ── Required body torques: τ = I·ω̇ + ω × Iω (diagonal inertia; p = −ωz, q = ωx, r = −ωy) ──
  const hx = I.pitch * wx;
  const hy = I.yaw * wy;
  const hz = I.roll * wz;
  const txReq = I.pitch * qDot + (wy * hz - wz * hy);
  const tyReq = I.yaw * -rDot + (wz * hx - wx * hz);
  const tzReq = I.roll * -pDot + (wx * hy - wy * hx);

  // ── Control effectiveness from the aero model at this state ──
  const ca = Math.cos(air.alpha);
  const cb = Math.cos(air.beta);
  const vb = { x: air.V * Math.sin(air.beta), y: -air.V * Math.sin(air.alpha) * cb, z: -air.V * ca * cb };
  const wingH = fin(state.derived.altitudeAGL, 1e3) + ac.geometry.wingRootLeadingEdge.y;
  const thrust = fin(state.engine.thrust);
  const extras = { mach: air.mach, speedBrake: pilot.speedBrake ? 1 : 0 };
  const trim = clamp(fin(pilot.elevatorTrim), -1, 1);
  const at = (e: number, a: number, rd: number) =>
    computeAero(vb, w, air.rho, state.flapsDeg, state.gearPos, { elevator: e, aileron: a, rudder: rd, elevatorTrim: trim }, thrust, cfg, wingH, extras);
  const base = at(0, 0, 0);
  const dE = at(1, 0, 0);
  const dA = at(0, 1, 0);
  const dR = at(0, 0, 1);
  const txE = dE.tx - base.tx;
  let elevator = Math.abs(txE) > 1e-6 ? (txReq - base.tx) / txE : stick;
  // Lateral-directional: solve the 2×2 [roll; yaw] = [δa, δr] system (aileron yaws, rudder rolls).
  const a11 = dA.tz - base.tz;
  const a12 = dR.tz - base.tz;
  const a21 = dA.ty - base.ty;
  const a22 = dR.ty - base.ty;
  const b1 = tzReq - base.tz;
  const b2 = tyReq - base.ty;
  const det = a11 * a22 - a12 * a21;
  let aileron = lat;
  let rudder = pedal;
  if (Math.abs(det) > 1e-9) {
    aileron = (b1 * a22 - a12 * b2) / det;
    rudder = (a11 * b2 - a21 * b1) / det;
  }
  elevator = clamp(fin(elevator, stick), -1, 1);
  aileron = clamp(fin(aileron, lat), -1, 1);
  rudder = clamp(fin(rudder, pedal), -1, 1);

  // Blend in from the direct laws after lift-off.
  return {
    ...pilot,
    elevator: eGround + (elevator - eGround) * blend,
    aileron: lat + (aileron - lat) * blend,
    rudder: pedal + (rudder - pedal) * blend,
  };
}
