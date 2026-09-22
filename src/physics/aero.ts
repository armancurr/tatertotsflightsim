/**
 * Aerodynamics of the C172RG: lift/drag coefficient curves (with a rounded
 * stall peak collapsing to flat-plate behaviour) and the full airframe
 * force/moment build-up from the stability derivatives in config.aircraft.aero.
 * Pure; every frame conversion goes through ./frames.
 */
import { CONFIG, type Config } from '../config';
import type { Vec3 } from '../types';
import { clamp, smoothstep } from '../math/vec3';
import { airDataFromBodyVelocity, pqrFromOmega, torqueFromLMN } from './frames';

const DEG = Math.PI / 180;

/** 0 (flaps up) .. 1 (full flaps). */
function flapFraction(flapsDeg: number, cfg: Config): number {
  return clamp(flapsDeg / cfg.aircraft.surfaces.flapMaxDeg, 0, 1);
}

/** Positive stall angle of attack (rad) for a flap deflection. */
export function stallAlphaRad(flapsDeg: number, cfg: Config = CONFIG): number {
  const a = cfg.aircraft.aero;
  return (a.stallAlphaDeg + a.stallAlphaFlapsShiftDeg * flapFraction(flapsDeg, cfg)) * DEG;
}

/** Negative stall angle of attack (rad). */
export function negativeStallAlphaRad(cfg: Config = CONFIG): number {
  return cfg.aircraft.aero.stallAlphaNegDeg * DEG;
}

/**
 * Attached-flow lift curve: linear, with a parabolic rounding over the last
 * `r` radians before each stall angle (slope → 0 exactly at the stall angle).
 * Past the stall the parabola keeps falling (it is blended away by then).
 */
function attachedLift(alpha: number, cl0: number, clAlpha: number, aS: number, aN: number, r: number): number {
  if (alpha > aS - r) {
    const x = alpha - (aS - r);
    return cl0 + clAlpha * (aS - r) + clAlpha * (x - (x * x) / (2 * r));
  }
  if (alpha < aN + r) {
    const x = aN + r - alpha;
    return cl0 + clAlpha * (aN + r) - clAlpha * (x - (x * x) / (2 * r));
  }
  return cl0 + clAlpha * alpha;
}

/** 0 before the stall, rising smoothly to 1 at `width` past it (either stall). */
function postStallBlend(alpha: number, aS: number, aN: number, width: number): number {
  if (alpha > aS) return smoothstep(aS, aS + width, alpha);
  if (alpha < aN) return smoothstep(aN, aN - width, alpha);
  return 0;
}

/** How far into the stall the wing is: 0 attached … 1 fully separated. */
export function stallFactor(alphaRad: number, flapsDeg: number, cfg: Config = CONFIG): number {
  return postStallBlend(alphaRad, stallAlphaRad(flapsDeg, cfg), negativeStallAlphaRad(cfg), cfg.aircraft.aero.stallBreakWidthDeg * DEG);
}

/**
 * Lift coefficient: cl0 + clAlpha·α + ΔCL(flaps), rounded to a peak at the
 * stall angle, then collapsing over stallBreakWidthDeg toward the flat-plate
 * curve flatPlateLift·sin(2α). Continuous everywhere, α in radians.
 */
export function liftCoefficient(alphaRad: number, flapsDeg: number, cfg: Config = CONFIG): number {
  const a = cfg.aircraft.aero;
  const cl0 = a.cl0 + a.clFlapsFull * flapFraction(flapsDeg, cfg);
  const aS = stallAlphaRad(flapsDeg, cfg);
  const aN = negativeStallAlphaRad(cfg);
  const b = postStallBlend(alphaRad, aS, aN, a.stallBreakWidthDeg * DEG);
  // Flat plate, plus part of the flap increment (a flapped wing still lifts more when stalled).
  const fp = a.flatPlateLift * Math.sin(2 * alphaRad) + a.postStallFlapLiftFraction * (cl0 - a.cl0) * Math.cos(alphaRad);
  if (b >= 1) return fp;
  const att = attachedLift(alphaRad, cl0, a.clAlpha, aS, aN, a.stallRoundingDeg * DEG);
  return att + (fp - att) * b;
}

/**
 * Drag coefficient: parasite (cd0 + gear + flaps) + induced CL²/(π·e·AR) +
 * sideslip cdBeta·β², blended past the stall toward flatPlateDrag·sin²α.
 * Induced drag is held at its stall-peak value past the stall so total drag
 * never falls as α grows.
 */
export function dragCoefficient(alphaRad: number, betaRad: number, flapsDeg: number, gearPos: number, cfg: Config = CONFIG): number {
  const ac = cfg.aircraft;
  const a = ac.aero;
  const f = flapFraction(flapsDeg, cfg);
  const parasite = a.cd0 + a.cdGear * clamp(gearPos, 0, 1) + a.cdFlapsFull * f + a.cdBeta * betaRad * betaRad;
  const aS = stallAlphaRad(flapsDeg, cfg);
  const aN = negativeStallAlphaRad(cfg);
  const aspect = (ac.wingSpan * ac.wingSpan) / ac.wingArea;
  const clAtt = attachedLift(clamp(alphaRad, aN, aS), a.cl0 + a.clFlapsFull * f, a.clAlpha, aS, aN, a.stallRoundingDeg * DEG);
  const induced = (clAtt * clAtt) / (Math.PI * ac.oswald * aspect);
  const b = postStallBlend(alphaRad, aS, aN, a.stallBreakWidthDeg * DEG);
  if (b <= 0) return parasite + induced;
  const s = Math.sin(alphaRad);
  const separated = Math.max(a.flatPlateDrag * s * s, induced);
  return parasite + induced + (separated - induced) * b;
}

/** Pilot surfaces as the aero model sees them (per unit, this sim's sign convention). */
export interface SurfaceInputs {
  elevator: number;
  aileron: number;
  rudder: number;
  elevatorTrim: number;
}

export interface AeroResult {
  /** Aerodynamic + thrust force in the BODY frame, N. */
  fx: number;
  fy: number;
  fz: number;
  /** Torque about the CG in the BODY frame, N·m (aero moments, P-factor and thrust-line moment). */
  tx: number;
  ty: number;
  tz: number;
  /** Lift and drag magnitudes (signed lift), N. */
  lift: number;
  drag: number;
  V: number;
  alpha: number;
  beta: number;
  /** Free-stream dynamic pressure (after the low-speed fade), Pa. */
  qbar: number;
  CL: number;
  CD: number;
  stallFactor: number;
}

/**
 * All airframe forces and moments except gravity and the ground, in the body
 * frame: lift ⟂ airflow in the plane of symmetry, drag along −v, side force
 * along body +X, the thrust along the nose applied at the prop hub, and the
 * roll/pitch/yaw moment build-ups (static, damping, control, stall, propwash,
 * P-factor).
 *
 * @param vb        velocity of the aircraft relative to the air, BODY frame (m/s)
 * @param omegaBody angular velocity, BODY frame (rad/s)
 * @param thrust    propeller thrust along the nose (N, may be negative when windmilling)
 * @param wingHeightM height of the wing above the surface (m) for ground effect; Infinity = none
 */
export function computeAero(
  vb: Vec3,
  omegaBody: Vec3,
  density: number,
  flapsDeg: number,
  gearPos: number,
  ctl: SurfaceInputs,
  thrust: number,
  cfg: Config = CONFIG,
  wingHeightM = Infinity,
): AeroResult {
  const ac = cfg.aircraft;
  const a = ac.aero;
  const S = ac.wingArea;
  const b = ac.wingSpan;
  const c = ac.meanChord;
  const ad = airDataFromBodyVelocity(vb);
  const V = ad.V;
  const alpha = ad.alpha;
  const beta = ad.beta;

  // Low-speed guard: aero fades to zero below ~1 m/s so nothing blows up at rest.
  const fade = smoothstep(0.2, 1.2, V);
  const qbar = 0.5 * density * V * V * fade;
  const sf = stallFactor(alpha, flapsDeg, cfg);
  // Ground effect on the wing (McCormick): within ~a span of the surface the ground blocks the
  // downwash, so induced drag falls by φ = (16h/b)²/(1+(16h/b)²) and the lift slope rises a little.
  // Attached flow only (fades out as the wing stalls).
  const h16 = wingHeightM > 0 ? (16 * wingHeightM) / b : 0;
  const phi = Number.isFinite(h16) ? (h16 * h16) / (1 + h16 * h16) : 1;
  const ge = (1 - phi) * (1 - sf);
  const CL0 = liftCoefficient(alpha, flapsDeg, cfg);
  const CL = CL0 * (1 + a.groundEffectLift * ge);
  const aspect = (b * b) / S;
  const CD = dragCoefficient(alpha, beta, flapsDeg, gearPos, cfg) - ge * ((CL0 * CL0) / (Math.PI * ac.oswald * aspect));
  const f = flapFraction(flapsDeg, cfg);

  // Propeller slipstream adds dynamic pressure over the tail (momentum theory Δp = T/A).
  const disc = Math.PI * ac.geometry.propRadius * ac.geometry.propRadius;
  const posThrust = thrust > 0 ? thrust : 0;
  const qTail = qbar + (a.propwashTail * posThrust) / disc;
  // Tail stability/damping terms ride the slipstream too (ratio capped; → 1 with no power).
  const kTail = qbar > 0 ? Math.min(qTail / qbar, a.propwashTailMaxRatio) : 1;

  const lift = qbar * S * CL;
  const drag = qbar * S * CD;
  let fx = 0;
  let fy = 0;
  let fz = 0;
  if (qbar > 0) {
    const ix = vb.x / V;
    const iy = vb.y / V;
    const iz = vb.z / V;
    // L̂ = normalize(cross(x̂_body, v̂)) = normalize(0, −v̂z, v̂y): ⟂ airflow, in the plane of symmetry.
    const ln = Math.sqrt(iz * iz + iy * iy);
    const ly = ln > 1e-9 ? -iz / ln : 0;
    const lz = ln > 1e-9 ? iy / ln : 0;
    fx = -drag * ix;
    fy = lift * ly - drag * iy;
    fz = lift * lz - drag * iz;
  }
  // Side force along body +X (rudder part rides the propwash too).
  fx += qbar * S * a.cyBeta * beta + qTail * S * a.cyRudder * ctl.rudder;
  // Thrust along the nose (−Z).
  fz -= thrust;

  // Moments, aircraft convention (L roll + right wing down, M pitch + nose up, N yaw + nose right).
  const { p, q, r } = pqrFromOmega(omegaBody);
  // Rate terms: C·(rate·len/2V)·q̄·S·len = (½ρVS)·len·(len/2)·C·rate — no division by V.
  const halfRhoVS = 0.5 * density * V * S * fade;
  const dampB = halfRhoVS * b * (b / 2);
  const dampC = halfRhoVS * c * (c / 2);
  const W = ac.mass * cfg.sim.gravity;

  // Stall: roll damping is lost (reversed past stallRollDampingLoss = 1) as the wing stalls. Only part of
  // the loss applies while the aircraft is coordinated, so a coordinated stall breaks straight and a
  // slipping/yawing one drops a wing and autorotates. The autorotative moment saturates at high roll
  // rates (the down-going wing goes deep into the flat-plate region), which bounds the spin rate.
  const Vref = V > 5 ? V : 5;
  const pHat = (p * b) / (2 * Vref);
  const rHat = (r * b) / (2 * Vref);
  const asym = clamp((Math.abs(beta) + a.stallWingDropYawGain * Math.abs(rHat)) / (a.stallAsymmetryRefDeg * DEG), 0, 1);
  const coord = a.stallCoordinatedDampingFraction;
  const loss = a.stallRollDampingLoss * sf * (coord + (1 - coord) * asym);
  const pLim = a.stallAutorotationRateLimit;

  const Lroll =
    qbar * S * b * (a.clBeta * beta + a.clAileron * ctl.aileron - a.stallWingDrop * sf * beta - a.clP * loss * pLim * Math.tanh(pHat / pLim)) +
    qTail * S * b * a.clRudder * ctl.rudder +
    dampB * (a.clP * p + a.clR * r + a.stallWingDrop * sf * a.stallWingDropYawGain * r);
  // Ground effect: less downwash at the tail near the ground → nose-down, growing with lift.
  const hr = wingHeightM > 0 ? wingHeightM / (a.groundEffectScale * b) : 0;
  const groundEffect = 1 / (1 + hr * hr);
  const Mpitch =
    qbar * S * c * (a.cm0 + (kTail - 1) * a.cm0Tail + kTail * (a.cmAlpha * Math.sin(alpha) - a.cmGroundEffect * CL * groundEffect) + a.cmFlapsFull * f + a.stallPitchBreak * sf) +
    qTail * S * c * (1 - a.stallTailBlanking * sf) * (a.cmElevator * ctl.elevator + a.cmTrim * ctl.elevatorTrim) +
    dampC * kTail * (a.cmQ + a.cmAlphaDot) * q;
  const Nyaw =
    qbar * S * b * (kTail * a.cnBeta * beta + a.cnAileron * ctl.aileron - a.pFactor * (posThrust / W) * (alpha > 0 ? alpha : 0)) +
    qTail * S * b * a.cnRudder * ctl.rudder +
    dampB * (a.cnP * p + kTail * a.cnR * r);

  const t = torqueFromLMN(Lroll, Mpitch, Nyaw);
  // Thrust acts at the prop hub: τ = hub × (0, 0, −T).
  const hub = ac.geometry.propHub;
  const tx = t.x - hub.y * thrust;
  const ty = t.y + hub.x * thrust;

  return { fx, fy, fz, tx, ty, tz: t.z, lift, drag, V, alpha, beta, qbar, CL, CD, stallFactor: sf };
}
