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
export function stallFactor(
  alphaRad: number, flapsDeg: number, cfg: Config = CONFIG, breakWidthDeg: number = cfg.aircraft.aero.stallBreakWidthDeg,
): number {
  return postStallBlend(alphaRad, stallAlphaRad(flapsDeg, cfg), negativeStallAlphaRad(cfg), breakWidthDeg * DEG);
}

/**
 * Lift coefficient: cl0 + clAlpha·α + ΔCL(flaps), rounded to a peak at the
 * stall angle, then collapsing over stallBreakWidthDeg toward the flat-plate
 * curve flatPlateLift·sin(2α). Continuous everywhere, α in radians.
 */
export function liftCoefficient(
  alphaRad: number, flapsDeg: number, cfg: Config = CONFIG, breakWidthDeg: number = cfg.aircraft.aero.stallBreakWidthDeg,
): number {
  const a = cfg.aircraft.aero;
  const cl0 = a.cl0 + a.clFlapsFull * flapFraction(flapsDeg, cfg);
  const aS = stallAlphaRad(flapsDeg, cfg);
  const aN = negativeStallAlphaRad(cfg);
  const b = postStallBlend(alphaRad, aS, aN, breakWidthDeg * DEG);
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
export function dragCoefficient(
  alphaRad: number, betaRad: number, flapsDeg: number, gearPos: number, cfg: Config = CONFIG,
  breakWidthDeg: number = cfg.aircraft.aero.stallBreakWidthDeg,
): number {
  const ac = cfg.aircraft;
  const a = ac.aero;
  const f = flapFraction(flapsDeg, cfg);
  const parasite = a.cd0 + a.cdGear * clamp(gearPos, 0, 1) + a.cdFlapsFull * f + a.cdBeta * betaRad * betaRad;
  const aS = stallAlphaRad(flapsDeg, cfg);
  const aN = negativeStallAlphaRad(cfg);
  const aspect = (ac.wingSpan * ac.wingSpan) / ac.wingArea;
  const clAtt = attachedLift(clamp(alphaRad, aN, aS), a.cl0 + a.clFlapsFull * f, a.clAlpha, aS, aN, a.stallRoundingDeg * DEG);
  const induced = (clAtt * clAtt) / (Math.PI * ac.oswald * aspect);
  const b = postStallBlend(alphaRad, aS, aN, breakWidthDeg * DEG);
  if (b <= 0) return parasite + induced;
  const s = Math.sin(alphaRad);
  const separated = Math.max(a.flatPlateDrag * s * s, induced);
  return parasite + induced + (separated - induced) * b;
}

// ─── Strip-theory wing (roll/yaw moments, stall and spin) ───────────────────────

export interface StripGeometry {
  /** Spanwise station of each strip centre (m, > 0) and its area (m²; both halves together sum to wingArea). */
  y: Float64Array;
  area: Float64Array;
  /** Washout at the station, rad (+ = more incidence than mid-span). */
  twist: Float64Array;
  /** 1 where the strip carries aileron, else 0. */
  aileron: Float64Array;
  /** Gain that makes the attached-flow strip roll damping equal config clP. */
  kAttached: number;
  /** Local α change (rad) of the aileron strips at full aileron that reproduces config clAileron. */
  aileronAlpha: number;
}

const stripCache = new WeakMap<object, StripGeometry>();

/** Spanwise strips of one half wing from the planform (constant-chord inner panel, tapered outer panel). */
export function wingStripGeometry(cfg: Config = CONFIG): StripGeometry {
  const ac = cfg.aircraft;
  const cached = stripCache.get(ac);
  if (cached) return cached;
  const a = ac.aero;
  const n = Math.max(1, Math.round(a.wingStrips));
  const semi = ac.wingSpan / 2;
  const geo = ac.geometry;
  const chordAt = (y: number) => {
    if (y <= geo.wingTaperStart) return geo.wingRootChord;
    const t = clamp((y - geo.wingTaperStart) / Math.max(1e-6, semi - geo.wingTaperStart), 0, 1);
    return geo.wingRootChord + (geo.wingTipChord - geo.wingRootChord) * t;
  };
  const g: StripGeometry = {
    y: new Float64Array(n), area: new Float64Array(n), twist: new Float64Array(n), aileron: new Float64Array(n), kAttached: 1, aileronAlpha: 0,
  };
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const yc = ((i + 0.5) / n) * semi;
    g.y[i] = yc;
    g.area[i] = chordAt(yc) * (semi / n);
    sum += g.area[i];
    g.twist[i] = a.washoutDeg * DEG * (0.5 - yc / semi);
    g.aileron[i] = yc / semi >= a.aileronSpanStart ? 1 : 0;
  }
  const k = ac.wingArea / 2 / sum;
  let sy2 = 0;
  let syAil = 0;
  for (let i = 0; i < n; i++) {
    g.area[i] *= k;
    sy2 += g.area[i] * g.y[i] * g.y[i];
    syAil += g.area[i] * g.y[i] * g.aileron[i];
  }
  const S = ac.wingArea;
  const b = ac.wingSpan;
  // Strip theory: Clp = −4·CLα·Σ(S·y²)/(S·b²) (per half wing), Clδa = 2·CLα·Δα·Σ_ail(S·y)/(S·b).
  const clpStrip = (-4 * a.clAlpha * sy2) / (S * b * b);
  g.kAttached = clpStrip < 0 ? a.clP / clpStrip : 1;
  g.aileronAlpha = syAil > 0 ? (a.clAileron * S * b) / (2 * a.clAlpha * syAil * g.kAttached) : 0;
  stripCache.set(ac, g);
  return g;
}

/**
 * The wing's roll and yaw moments from strip theory (N·m, aircraft convention: L + right wing down,
 * N + nose right). Each strip meets the air at its local angle of attack atan2(w + p·y, u − r·y) plus
 * washout and aileron and reads its lift/drag from the same curves as the whole wing. Roll comes from
 * the strips' normal force: roll damping, the yaw-rate roll (Clr), the ailerons — scaled in attached
 * flow to the calibrated clP/clAileron — and, once the down-going wing stalls, autorotation. Yaw comes
 * from the strips' chordwise force: adverse yaw, the leading-edge suction of an unstalled wing, and
 * the loss of it (plus the drag) of a stalled one.
 *
 * @param u forward, w downward air-relative body speeds (m/s); p roll, r yaw rates (rad/s)
 * @param wingStall whole-wing stall factor 0..1 (blends the roll gain toward stripRollGainStalled)
 */
export function wingStripMoments(
  u: number, w: number, p: number, r: number, density: number, flapsDeg: number, aileron: number, wingStall: number,
  cfg: Config = CONFIG,
): { L: number; N: number } {
  const a = cfg.aircraft.aero;
  const g = wingStripGeometry(cfg);
  const ail = clamp(aileron, -1, 1) * g.aileronAlpha;
  const half = 0.5 * density;
  const bw = a.stripStallBreakWidthDeg;
  let L = 0;
  let N = 0;
  for (let i = 0; i < g.y.length; i++) {
    const y = g.y[i];
    for (let side = -1; side <= 1; side += 2) {
      const x = side * y;
      const ui = u - r * x;
      const wi = w + p * x;
      const qi = half * (ui * ui + wi * wi) * g.area[i];
      const ai = Math.atan2(wi, ui);
      // Right aileron (+) raises the right aileron: less α on the right outer strips, more on the left.
      const aEff = ai + g.twist[i] - side * ail * g.aileron[i];
      const cl = liftCoefficient(aEff, flapsDeg, cfg, bw);
      const cd = dragCoefficient(aEff, 0, flapsDeg, 0, cfg, bw);
      const ca = Math.cos(ai);
      const sa = Math.sin(ai);
      const cn = cl * ca + cd * sa;
      // Chordwise force (+ aft): leading-edge suction while attached, lost as the strip stalls.
      const cAtt = cd * ca - cl * sa;
      const cc = cAtt + (a.cd0 - cAtt) * stallFactor(aEff, flapsDeg, cfg, bw);
      L -= x * qi * cn;
      N += x * qi * cc;
    }
  }
  const kL = g.kAttached + (a.stripRollGainStalled - g.kAttached) * clamp(wingStall, 0, 1);
  return { L: L * kL, N: N * a.stripYawGain };
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
  // Fuselage crossflow (Allen & Perkins) past the stall: the body meets the air broadside and adds a normal
  // force ΔCN = k·sin α·|sin α| (resolved into lift and drag) — it keeps a spin's descent slow.
  const sinA = Math.sin(alpha);
  const dCN = a.bodyCrossflowCn * sinA * Math.abs(sinA) * sf;
  const CL = CL0 * (1 + a.groundEffectLift * ge) + dCN * Math.cos(alpha);
  const aspect = (b * b) / S;
  const CD = dragCoefficient(alpha, beta, flapsDeg, gearPos, cfg) - ge * ((CL0 * CL0) / (Math.PI * ac.oswald * aspect)) + dCN * Math.abs(sinA);
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

  // Wing roll/yaw moments. Attached flow, or a stalled wing meeting the air symmetrically: the calibrated
  // linear derivatives (a coordinated stall breaks straight). A stalled wing with asymmetric flow — rolling,
  // yawing, sideslipping or with aileron — strip theory: the down-going (or down-aileron) wing stalls deeper,
  // loses lift and suction (wing drop, autorotation → spin). Blend weight = stall × asymmetry.
  const Vref = V > 5 ? V : 5;
  const asym = (Math.abs(p) + Math.abs(r)) * (b / (2 * Vref)) + a.stripAsymBeta * Math.abs(beta) + a.stripAsymAileron * Math.abs(ctl.aileron);
  const aStall = stallAlphaRad(flapsDeg, cfg);
  const nearStall = smoothstep(aStall - a.stripStallBlendDeg * DEG, aStall + a.stripStallBlendDeg * DEG, alpha);
  const wStrip = nearStall * smoothstep(a.stripAsymOnset, a.stripAsymFull, asym);
  let Lwing = qbar * S * b * a.clAileron * ctl.aileron + dampB * (a.clP * p + a.clR * r);
  let Nwing = qbar * S * b * a.cnAileron * ctl.aileron + dampB * a.cnP * p;
  if (wStrip > 0) {
    const st = wingStripMoments(ad.u * fade, ad.w * fade, p * fade, r * fade, density, flapsDeg, ctl.aileron, sf, cfg);
    Lwing += (st.L - Lwing) * wStrip;
    Nwing += (st.N - Nwing) * wStrip;
  }
  // At high α the fin sits in the wake of the stalled wing: directional stability and yaw damping fade,
  // the rudder a little.
  const finK = 1 - a.stallYawDampingLoss * sf;
  const rudK = 1 - a.stallRudderLoss * sf;

  const Lroll =
    qbar * S * b * a.clBeta * beta +
    qTail * S * b * a.clRudder * ctl.rudder +
    Lwing;
  // Ground effect: less downwash at the tail near the ground → nose-down, growing with lift.
  const hr = wingHeightM > 0 ? wingHeightM / (a.groundEffectScale * b) : 0;
  const groundEffect = 1 / (1 + hr * hr);
  const Mpitch =
    qbar * S * c * (a.cm0 + (kTail - 1) * a.cm0Tail + kTail * (a.cmAlpha * Math.sin(alpha) - a.cmGroundEffect * CL * groundEffect) + a.cmFlapsFull * f + a.stallPitchBreak * sf) +
    qTail * S * c * (1 - a.stallTailBlanking * sf) * (a.cmElevator * ctl.elevator + a.cmTrim * ctl.elevatorTrim) +
    dampC * kTail * (a.cmQ + a.cmAlphaDot) * q;
  const Nyaw =
    qbar * S * b * (kTail * finK * a.cnBeta * beta - a.pFactor * (posThrust / W) * (alpha > 0 ? alpha : 0)) +
    qTail * S * b * rudK * a.cnRudder * ctl.rudder +
    dampB * kTail * finK * a.cnR * r +
    Nwing;

  const t = torqueFromLMN(Lroll, Mpitch, Nyaw);
  // Thrust acts at the prop hub: τ = hub × (0, 0, −T).
  const hub = ac.geometry.propHub;
  const tx = t.x - hub.y * thrust;
  const ty = t.y + hub.x * thrust;

  return { fx, fy, fz, tx, ty, tz: t.z, lift, drag, V, alpha, beta, qbar, CL, CD, stallFactor: sf };
}
