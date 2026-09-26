/**
 * Helicopter flight model: the rotors, the airframe, the drivetrain and the turboshaft, plus the
 * stability assist and the trim solver. Used by step() for any aircraft whose config has a
 * `rotorcraft` section (the Bell 206B-3 JetRanger III). Pure: no three.js, no DOM, no clock.
 *
 * ─── The model (after Padfield, "Helicopter Flight Dynamics"; Johnson, "Helicopter Theory";
 *     Heffley & Mnich, "Minimum-Complexity Helicopter Simulation Math Model", NASA CR-177476) ───
 *
 * Main rotor
 *  - Thrust from blade-element theory with linear twist and uniform inflow, referenced to the
 *    tip-path plane (TPP):  CT = (σa/2)·B²·[θ0(1/3 + μ²/2) + θtw(1 + μ²)/4 − λ/2],
 *    λ = (Vc + vi)/ΩR, Vc = hub velocity along the thrust axis (climb +), μ = in-plane speed/ΩR.
 *  - Induced velocity vi is a state (Pitt–Peters dynamic inflow, τ = 0.849/(4λΩ)) relaxing toward
 *    momentum theory (Glauert: vi·√(Vip² + (Vc + vi)²) = vh²), blended at low in-plane speed with
 *    an empirical axial curve through the vortex-ring state (Johnson's fit, matched to momentum
 *    theory at Vc = 0 and Vc = −2vh). Ground effect: Hayden's fit, faded with forward speed.
 *    Translational lift, the power bucket and autorotation all come out of these equations.
 *  - Vortex-ring state: thrust loss (up to vrsThrustLoss) and buffet in slow, steep descents.
 *  - Flapping (teetering rotor, quasi-steady): the TPP tilts from the mast by the cyclic, blowback
 *    μ(8/3θ0 + 2θtw − 2λ)/(1 − μ²/2) (away from the relative wind), lateral flapping from the
 *    built-in coning (4/3·μ·β0) and the transverse-flow inflow gradient (κ·λi, κ = tan(χ/2)), and the
 *    body rates (the disc lags the mast by 16/γ·(q, p)/Ω and cross-couples by (p, −q)/Ω). A
 *    teetering rotor has no hub moment: the thrust vector's tilt about the CG is the only control
 *    moment, so control authority fades with thrust in low g, as on the real JetRanger.
 *  - Retreating-blade stall past CT/σ = stallCtSigma − stallMuSlope·μ: thrust saturates, profile
 *    drag climbs, the disc pitches up and rolls toward the retreating side.
 *  - Torque: CQ = CT·λ + σ·Cd/8·(1 + μ²), with the H-force σ·Cd/4·μ in the plane.
 * Tail rotor: the same thrust/inflow/VRS model (no flapping), pitch from the pedals, driven at a fixed
 *   gear ratio; its power loads the drivetrain; losing it in a fast pedal turn (VRS) is possible.
 * Airframe: fuselage drag (front/side/top areas) in the rotor wash, an unstable fuselage pitch and yaw
 *   moment, a horizontal stabiliser that meets the rotor wake at low speed (the pitch-up in the
 *   transition) and a cambered fin that unloads the tail rotor in cruise.
 * Drivetrain: I·dΩ/dt = Qshaft − Qrotor; the fuselage reacts −Qshaft about the mast (so the nose yaws
 *   right with power on a counter-clockwise rotor, and left in autorotation). The freewheel means
 *   the engine can only drive, never brake, the rotor.
 * Turboshaft: an N2 governor (P + I + collective anticipator) commands power, which lags through the
 *   gas generator (N1); available power falls with density. It can exceed the transmission limit
 *   (overtorque) — the torquemeter says so, the aircraft doesn't stop you.
 */
import { CONFIG, KT_TO_MS, type Config, type RotorcraftConfig } from '../config';
import type { AircraftState, Controls, EngineState, RotorState, Vec3 } from '../types';
import { clamp, smoothstep, wrap180 } from '../math/vec3';
import { airDensity } from './atmosphere';
import { airDataFromBodyVelocity, quatFromEuler, worldToBody } from './frames';
import type { TrimRequest } from './trim';

const DEG = Math.PI / 180;
const RPM = (2 * Math.PI) / 60;

/** Vortex-ring state: the most thrust it costs, and the buffet (fraction of thrust, ~2 Hz). */
const VRS_THRUST_LOSS = 0.3;
const VRS_BUFFET = 0.08;

/** What moves the blades: collective 0..1, cyclic ±1 (+ aft / + right), pedals ±1 (+ right). */
export interface RotorControls {
  collective: number;
  cyclicLong: number;
  cyclicLat: number;
  pedal: number;
}

export interface RotorcraftForces {
  /** Total aerodynamic force and moment about the CG, body frame (drivetrain reaction NOT included). */
  force: Vec3;
  torque: Vec3;
  thrust: number;
  tailThrust: number;
  /** Where the dynamic inflow is heading, and how fast (s). */
  viTarget: number;
  viTailTarget: number;
  inflowTau: number;
  tailInflowTau: number;
  /** Aerodynamic torque on the main rotor (N·m, resisting its rotation; < 0 = the air drives it). */
  mainTorque: number;
  /** Aerodynamic power absorbed by the tail rotor, W. */
  tailPower: number;
  flapLong: number;
  flapLat: number;
  vrs: number;
  bladeStall: number;
  groundEffect: number;
  /** Advance ratio and inflow ratio (TPP), for tests and the trim solver. */
  mu: number;
  lambda: number;
}

// ─── Small vector helpers (plain objects, allocation is fine at 120 Hz) ───────

const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const len = (a: Vec3) => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
const fin = (x: number, fallback = 0) => (Number.isFinite(x) ? x : fallback);

/** The mast (shaft) axis, body frame: up, tilted forward by mastTiltDeg. */
export function mastAxis(rc: RotorcraftConfig): Vec3 {
  const i = rc.rotor.mastTiltDeg * DEG;
  return { x: 0, y: Math.cos(i), z: -Math.sin(i) };
}

/** Nominal (100 %) main-rotor speed, rad/s. */
export const nominalOmega = (rc: RotorcraftConfig): number => rc.rotor.nominalRpm * RPM;

// ─── Induced velocity ─────────────────────────────────────────────────────────

/**
 * Empirical axial induced velocity vi/vh against x = Vc/vh (climb +): momentum theory outside the
 * vortex-ring region, Johnson's quartic fit (Helicopter Theory §4.2) inside −2 < x < 0, corrected
 * linearly so it meets momentum theory at both ends.
 */
export function axialInflowRatio(x: number): number {
  if (x >= 0) return -x / 2 + Math.sqrt((x * x) / 4 + 1);
  if (x <= -2) return -x / 2 - Math.sqrt((x * x) / 4 - 1);
  const p = 1.15 - 1.125 * x - 1.372 * x * x - 1.718 * x * x * x - 0.655 * x * x * x * x;
  return p - (0.15 - 0.013 * x);
}

/** Glauert momentum theory, non-dimensional: the smallest v ≥ 0 with v·√(m² + (x + v)²) = 1. */
function glauertRatio(x: number, m: number): number {
  const f = (v: number) => v * Math.sqrt(m * m + (x + v) * (x + v)) - 1;
  let lo = 0;
  let hi = 0.25;
  // March out to the first sign change (the windmill-brake root when there are two), then bisect.
  while (f(hi) < 0 && hi < 12) {
    lo = hi;
    hi += 0.25;
  }
  for (let i = 0; i < 18; i++) {
    const mid = 0.5 * (lo + hi);
    if (f(mid) < 0) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/**
 * Target induced velocity (m/s, + down through the disc along the thrust) of a disc of area A making
 * thrust T, with the hub moving at vc along the thrust axis (+ climbing into it) and vip in the
 * plane. Also returns the vortex-ring-state intensity 0..1.
 */
export function inducedVelocity(T: number, rho: number, A: number, vc: number, vip: number): { vi: number; vrs: number } {
  const vh = Math.sqrt(Math.abs(T) / (2 * rho * A));
  if (!(vh > 1e-3)) return { vi: 0, vrs: 0 };
  const s = T >= 0 ? 1 : -1;
  const x = (s * vc) / vh;
  const m = Math.abs(vip) / vh;
  const wAx = Math.exp(-(m / 0.8) * (m / 0.8));
  const v = wAx * axialInflowRatio(x) + (1 - wAx) * glauertRatio(x, m);
  const vrs = wAx * smoothstep(-0.3, -0.7, x) * smoothstep(-2.1, -1.6, x);
  return { vi: s * v * vh, vrs };
}

/** Blade-element thrust coefficient (uniform inflow, linear twist, tip loss B). */
function thrustCoefficient(sigma: number, a: number, B: number, theta0: number, twist: number, mu: number, lambda: number): number {
  const mu2 = mu * mu;
  return ((sigma * a) / 2) * B * B * (theta0 * (1 / 3 + mu2 / 2) + (twist * (1 + mu2)) / 4 - lambda / 2);
}

/** Soft retreating-blade-stall limit on CT/σ: linear to 85 % of the limit, then saturating. */
function stallLimited(cts: number, limit: number): { cts: number; excess: number } {
  const a = Math.abs(cts);
  const knee = 0.85 * limit;
  if (a <= knee) return { cts, excess: 0 };
  const w = limit - knee;
  const out = knee + w * Math.tanh((a - knee) / w);
  return { cts: Math.sign(cts) * out, excess: Math.max(0, (a - knee) / limit) };
}

// ─── Forces ───────────────────────────────────────────────────────────────────

export interface ForceInput {
  /** CG velocity relative to the air, body frame, m/s. */
  vb: Vec3;
  /** Angular velocity, body frame, rad/s. */
  w: Vec3;
  rho: number;
  /** Height of the rotor hub above the surface, m (Infinity = out of ground effect). */
  hubHeight: number;
  omega: number;
  vi: number;
  viTail: number;
  /** Sim time (buffet phase). */
  time: number;
}

/** Aerodynamic forces and moments of the whole helicopter for the given rotor state and controls. Pure. */
export function rotorcraftForces(inp: ForceInput, u: RotorControls, rc: RotorcraftConfig): RotorcraftForces {
  const mr = rc.rotor;
  const tr = rc.tailRotor;
  const af = rc.airframe;
  const { vb, w, rho } = inp;
  const omega = Math.max(0, fin(inp.omega));
  const dir = mr.direction;

  let fx = 0, fy = 0, fz = 0, tx = 0, ty = 0, tz = 0;
  const apply = (r: Vec3, F: Vec3) => {
    fx += F.x; fy += F.y; fz += F.z;
    const t = cross(r, F);
    tx += t.x; ty += t.y; tz += t.z;
  };
  /** Air-relative velocity of a body point (the point moving through the air), body frame. */
  const pointVel = (r: Vec3): Vec3 => add(vb, cross(w, r));

  // ── Main rotor ──
  const R = mr.radius;
  const A = Math.PI * R * R;
  const sigma = (mr.blades * mr.chord) / (Math.PI * R);
  const OR = Math.max(1, omega * R);
  const s = mastAxis(rc);
  const eRight: Vec3 = { x: 1, y: 0, z: 0 };
  const eBack = cross(eRight, s); // aft, perpendicular to the mast
  const hub = mr.hub;
  const vh = pointVel(hub);
  const vcShaft = dot(vh, s);
  const vipVec = add(vh, scale(s, -vcShaft));
  const vip = len(vipVec);
  const mu = vip / OR;
  // Relative wind across the disc (the direction the air flows), and 90° round in the rotation sense.
  const f = vip > 1e-6 ? scale(vipVec, -1 / vip) : eBack;
  const perp = scale(cross(s, f), dir);

  const theta75 = (mr.collectiveDeg[0] + clamp(u.collective, 0, 1) * (mr.collectiveDeg[1] - mr.collectiveDeg[0])) * DEG;
  const twist = mr.twistDeg * DEG;
  const theta0 = theta75 - 0.75 * twist;
  const lamShaft = (vcShaft + inp.vi) / OR;

  // Flapping: TPP tilt from the mast (vector in the disc plane; + along f = blown back).
  const mu2 = mu * mu;
  const blowback = (mu * ((8 / 3) * theta0 + 2 * twist - 2 * lamShaft)) / Math.max(0.2, 1 - mu2 / 2);
  const lamI = inp.vi / OR;
  const chi = Math.atan2(mu, Math.max(1e-4, lamShaft));
  const kappa = Math.tan(clamp(chi, 0, Math.PI / 2 - 1e-3) / 2);
  const lateral = ((4 / 3) * mu * mr.preconeDeg * DEG) / (1 + mu2 / 2) + kappa * lamI;
  const qRate = w.x; // nose up +
  const pRate = -w.z; // right wing down +
  const om = Math.max(omega, 1);
  const g16 = 16 / mr.lockNumber;
  const aftTilt = u.cyclicLong * mr.cyclicLongDeg * DEG - (g16 * qRate) / om + (dir * pRate) / om;
  const rightTilt = u.cyclicLat * mr.cyclicLatDeg * DEG - (g16 * pRate) / om - (dir * qRate) / om;
  let tilt = add(add(scale(f, blowback), scale(perp, lateral)), add(scale(eBack, aftTilt), scale(eRight, rightTilt)));

  // Thrust (first pass with this tilt; the stall feedback adds its own tilt below).
  const tiltAxis = (t: Vec3) => {
    const a = len(t);
    const stop = mr.flapStopDeg * DEG;
    const k = a > stop ? stop / a : 1;
    const tt = scale(t, k);
    const aa = Math.min(a, stop);
    return { n: add(scale(s, Math.cos(aa)), aa > 1e-9 ? scale(tt, Math.sin(aa) / aa) : { x: 0, y: 0, z: 0 }), tilt: tt };
  };
  let ax = tiltAxis(tilt);
  const vcTpp = dot(vh, ax.n);
  const lambda = (vcTpp + inp.vi) / OR;
  const ctRaw = thrustCoefficient(sigma, mr.liftSlope, mr.tipLoss, theta0, twist, mu, lambda);
  const limit = Math.max(0.03, mr.stallCtSigma - mr.stallMuSlope * mu);
  const st = stallLimited(ctRaw / sigma, limit);
  const bladeStall = clamp(st.excess / 0.15, 0, 1);
  // Retreating-blade stall: the disc pitches up (blows back) and rolls toward the retreating side.
  if (bladeStall > 0) {
    tilt = add(tilt, add(scale(f, 0.05 * bladeStall * Math.min(1, mu / 0.15)), scale(perp, -0.03 * bladeStall * Math.min(1, mu / 0.15))));
    ax = tiltAxis(tilt);
  }
  const n = ax.n;
  const q0 = rho * A * OR * OR;
  const vcN = dot(vh, n);
  const ind = inducedVelocity(st.cts * sigma * q0, rho, A, vcN, len(add(vh, scale(n, -vcN))));
  // Ground effect (Hayden's empirical fit to flight data: P_IGE/P_OGE = 1/(0.9926 + 0.03794·(2R/z)²),
  // applied to the induced velocity), fading as the wake is blown back.
  const z = Math.max(0.35 * R, fin(inp.hubHeight, Infinity));
  const geRaw = Number.isFinite(z) ? clamp(1 - 1 / (0.9926 + 0.03794 * ((2 * R) / z) ** 2), 0, 0.5) : 0;
  const vref = Math.max(0.5, Math.abs(inp.vi));
  const ge = geRaw / (1 + (vip / vref) * (vip / vref));
  const buffet = 1 + VRS_BUFFET * ind.vrs * Math.sin(inp.time * 12.9) * Math.sin(inp.time * 4.1 + 1.3);
  const thrust = st.cts * sigma * q0 * (1 - VRS_THRUST_LOSS * ind.vrs) * buffet;
  const viTarget = ind.vi * (1 - ge);
  const inflowTau = clamp(0.849 / (4 * Math.max(0.02, Math.abs(lambda)) * om), mr.inflowTauMin, mr.inflowTauMax);

  const cts = Math.abs(st.cts);
  const cd = mr.cd0 * (1 + mr.cdLift * (cts / 0.1) * (cts / 0.1)) + 0.12 * bladeStall * bladeStall;
  const cq =
    st.cts * sigma * lambda +
    (mr.inducedPowerFactor - 1) * Math.abs(st.cts * sigma) * Math.max(0, inp.vi / OR) +
    ((sigma * cd) / 8) * (1 + mu2) +
    0.25 * ind.vrs * Math.abs(st.cts * sigma) * (Math.abs(inp.vi) / OR);
  const mainTorque = omega > 0.5 ? cq * q0 * R : 0;
  const hForce = ((sigma * cd) / 4) * mu * q0;
  apply(hub, add(scale(n, thrust), scale(f, hForce)));

  // ── Tail rotor ──
  const Rt = tr.radius;
  const At = Math.PI * Rt * Rt;
  const sigmaT = (tr.blades * tr.chord) / (Math.PI * Rt);
  const ORt = Math.max(1, omega * tr.gearRatio * Rt);
  const axisT = tr.axis;
  const vt = pointVel(tr.position);
  const vcT = dot(vt, axisT);
  const vipT = len(add(vt, scale(axisT, -vcT)));
  const muT = vipT / ORt;
  const lamT = (vcT + inp.viTail) / ORt;
  const thetaT = (tr.pitchNeutralDeg - clamp(u.pedal, -1, 1) * tr.pitchRangeDeg) * DEG;
  const ctT = thrustCoefficient(sigmaT, tr.liftSlope, 0.97, thetaT, 0, muT, lamT);
  const stT = stallLimited(ctT / sigmaT, 0.16);
  const q0t = rho * At * ORt * ORt;
  const indT = inducedVelocity(stT.cts * sigmaT * q0t, rho, At, vcT, vipT);
  const tailThrust = stT.cts * sigmaT * q0t * (1 - VRS_THRUST_LOSS * indT.vrs) * (1 - tr.finBlockage);
  const cdT = tr.cd0 * (1 + 0.3 * (Math.abs(stT.cts) / 0.1) ** 2);
  const cqT = stT.cts * sigmaT * lamT + ((sigmaT * cdT) / 8) * (1 + muT * muT);
  const tailPower = omega > 0.5 ? cqT * q0t * ORt : 0;
  const tailInflowTau = clamp(0.849 / (4 * Math.max(0.02, Math.abs(lamT)) * Math.max(1, omega * tr.gearRatio)), 0.03, 0.3);
  apply(tr.position, scale(axisT, tailThrust));

  // ── Rotor wake over the airframe ──
  const flowDown = vcN + inp.vi; // air speed down through the disc
  const tanSkew = flowDown > 0.1 ? vip / flowDown : 1e3;
  const washFuse = flowDown > 0 ? (1 - smoothstep(0.6, 2.0, tanSkew)) * af.washFactor * inp.vi : 0;
  const tanDescent = flowDown > 0 ? flowDown / Math.max(0.1, vip) : 0;
  const washTail = flowDown > 0 ? smoothstep(0.135, 1.0, tanDescent) * 1.5 * inp.vi : 0;

  // ── Fuselage ──
  // Air velocity as the airframe feels it (the air moves opposite to the aircraft, plus the wash down the mast).
  const uF = add(scale(pointVel(af.dragPoint), -1), scale(s, -washFuse));
  const uMag = len(uF);
  apply(af.dragPoint, {
    x: 0.5 * rho * uMag * uF.x * af.dragAreaSide,
    y: 0.5 * rho * uMag * uF.y * af.dragAreaTop,
    z: 0.5 * rho * uMag * uF.z * af.dragAreaFront,
  });
  const ad = airDataFromBodyVelocity(vb);
  const qbar = 0.5 * rho * ad.V * ad.V;
  const sinA = Math.sin(clamp(ad.alpha, -Math.PI / 2, Math.PI / 2));
  const sinB = Math.sin(clamp(ad.beta, -Math.PI / 2, Math.PI / 2));
  // Unstable fuselage: nose-up moment grows with α; the nose swings away from the wind with β.
  tx += qbar * af.pitchVolume * sinA * Math.abs(Math.cos(ad.alpha));
  ty += qbar * af.yawVolume * sinB;

  // ── Horizontal stabiliser and fin (flat plates past the stall) ──
  const surface = (area: number, pos: Vec3, incidence: number, slope: number, wash: number, vertical: boolean) => {
    const u = add(scale(pointVel(pos), -1), scale(s, -wash));
    // In the surface's plane: chordwise (aft, +z) and normal (up for the stab, right for the fin).
    const along = u.z;
    const normal = vertical ? u.x : u.y;
    const V2 = along * along + normal * normal;
    if (V2 < 1e-4) return;
    const V = Math.sqrt(V2);
    const alpha = Math.atan2(normal, along) + incidence * DEG;
    const a = Math.atan2(Math.sin(alpha), Math.cos(alpha));
    const lin = slope * a;
    const plate = 1.1 * Math.sin(2 * a);
    const cl = Math.abs(a) < 0.26 ? lin : Math.abs(a) < 0.4 ? lin + (plate - lin) * ((Math.abs(a) - 0.26) / 0.14) : plate;
    const cdS = 0.01 + 1.2 * Math.sin(a) ** 2;
    const q = 0.5 * rho * V2 * area;
    // Lift ⟂ to the local flow, drag along it.
    const la = -normal / V;
    const ln = along / V;
    const L = q * cl;
    const D = q * cdS;
    const Fz = L * la + D * (along / V);
    const Fn = L * ln + D * (normal / V);
    apply(pos, vertical ? { x: Fn, y: 0, z: Fz } : { x: 0, y: Fn, z: Fz });
  };
  surface(af.stab.area, af.stab.position, af.stab.incidenceDeg, af.stab.liftSlope, washTail, false);
  surface(af.fin.area, af.fin.position, af.fin.incidenceDeg, af.fin.liftSlope, 0, true);

  const flapLong = dot(ax.tilt, eBack);
  const flapLat = dot(ax.tilt, eRight);
  return {
    force: { x: fx, y: fy, z: fz },
    torque: { x: tx, y: ty, z: tz },
    thrust,
    tailThrust,
    viTarget,
    viTailTarget: indT.vi,
    inflowTau,
    tailInflowTau,
    mainTorque,
    tailPower,
    flapLong,
    flapLat,
    vrs: ind.vrs,
    bladeStall,
    groundEffect: ge / 0.5,
    mu,
    lambda,
  };
}

// ─── Turboshaft and drivetrain ────────────────────────────────────────────────

/** Power the engine can make at this density, W (thermodynamic; the transmission limit is advisory). */
export function availablePower(rho: number, rc: RotorcraftConfig, seaLevelDensity = CONFIG.sim.seaLevelDensity): number {
  return rc.engine.thermoPowerW * Math.pow(clamp(rho / seaLevelDensity, 0.05, 1.3), rc.engine.densityExponent);
}

/** Drivetrain losses at this delivered power, W. */
const lossPower = (P: number, rc: RotorcraftConfig) => (P > 0 ? rc.engine.accessoryW + rc.engine.lossFraction * P : 0);

/** N1 for a delivered power (fraction of the thermodynamic sea-level power). */
function n1For(P: number, rc: RotorcraftConfig): number {
  const e = rc.engine;
  return e.n1Idle + (e.n1Max - e.n1Idle) * Math.sqrt(clamp(P / e.thermoPowerW, 0, 1.2));
}

interface EngineStep {
  engine: EngineState;
  power: number;
  govInt: number;
}

/**
 * Step the turboshaft: start sequence, the N2 governor, the gas-generator lag. The freewheel means
 * the delivered power is never negative (the rotor can overrun the engine).
 */
function stepTurboshaft(eng: EngineState, r: RotorState, engineOn: boolean, collective: number, runUp: boolean, dt: number, rho: number, cfg: Config): EngineStep {
  const rc = cfg.aircraft.rotorcraft!;
  const e = rc.engine;
  let { running, starting, startTimer } = eng;
  const failed = eng.failed;
  let P = r.enginePower;
  let govInt = r.govInt;
  const Pavail = availablePower(rho, rc, cfg.sim.seaLevelDensity);
  const lag = (target: number) => {
    const tau = target > P ? e.n1TauUp : e.n1TauDown;
    return P + (target - P) * (1 - Math.exp(-dt / tau));
  };
  if (failed || !engineOn) {
    running = false;
    starting = false;
    startTimer = 0;
    P = P * Math.exp(-dt / 1.2);
    if (P < 50) P = 0;
    govInt = 0;
  } else if (!running) {
    if (!starting) {
      starting = true;
      startTimer = 0;
    }
    startTimer += dt;
    P = lag(e.startPowerW * clamp(startTimer / e.startTime, 0, 1));
    if (startTimer >= e.startTime) {
      running = true;
      starting = false;
      // Hand over to the governor from the power the start sequence was making.
      govInt = P - e.govAnticipator * collective;
    }
  } else {
    const err = nominalOmega(rc) - r.omega;
    const ff = e.govAnticipator * collective;
    const raw = govInt + ff + e.govKp * err;
    // Running the rotor up on the ground (collective down) the start schedule keeps the torque ≤ 100 %.
    const cap = runUp ? Math.min(Pavail, (e.transmissionLimitW * r.omega) / nominalOmega(rc)) : Pavail;
    const cmd = clamp(raw, 0, cap);
    // Anti-windup: stop integrating into a saturated command.
    if (!((raw > cap && err > 0) || (raw < 0 && err < 0))) govInt += e.govKi * err * dt;
    govInt = clamp(govInt, -e.govAnticipator - Pavail, Pavail);
    P = lag(cmd);
  }
  P = clamp(P, 0, Pavail);
  const rpm = r.omega / RPM;
  return {
    engine: {
      running,
      starting,
      startTimer,
      failed,
      power: P / e.transmissionLimitW,
      rpm,
      thrust: r.thrust,
      afterburner: 0,
    },
    power: P,
    govInt,
  };
}

// ─── Stability assist ─────────────────────────────────────────────────────────

interface SasOut {
  u: RotorControls;
  on: boolean;
  sasLong: number;
  sasLat: number;
  sasYaw: number;
  headingRef: number;
  hoverLong: number;
  hoverLat: number;
}

/** Pedal feed-forward for the engine torque (left pedal with power), control units per unit torque. */
const PEDAL_TORQUE_FF = -0.4;
/** A stick or pedal counts as "hands on" past this deflection. */
const ACTIVE = 0.05;

/**
 * The pilot's controls → blade controls. Stability assist off (or not configured): direct — cyclic =
 * stick (+ the trim keys as a fore-aft cyclic trim), pedals = pedals. On:
 *  - attitude command / attitude hold: the stick commands pitch and bank; centred, the aircraft holds
 *    the hover attitude (pitchBias / rollBias) plus the pitch trim;
 *  - hover hold below hoverHoldKt with the stick centred: attitude to stop the drift (P + I);
 *  - yaw: the pedals command a yaw rate and, centred, hold the heading (hover); at speed they only
 *    null the sideslip (turn coordination) and the bank holds the heading;
 * It engages once the skids are light (thrust ≥ 50 % of the weight) or airborne.
 */
function stabilityAssist(state: AircraftState, pilot: Controls, dt: number, cfg: Config): SasOut {
  const rc = cfg.aircraft.rotorcraft!;
  const sc = rc.sas;
  const r = state.rotor!;
  const collective = clamp(pilot.throttle, 0, 1);
  const ff = PEDAL_TORQUE_FF * clamp(r.torque, 0, 1.3);
  const W = cfg.aircraft.mass * cfg.sim.gravity;
  // The loops engage as the skids get light, so the lift-off is already held; the integrators wait
  // until it is actually airborne (they would only wind up against the ground).
  const light = !state.onGround || r.thrust > 0.5 * W;
  const learn = state.onGround ? 0 : 1;
  const d = state.derived;
  const psi = fin(d.headingDeg);
  const direct = (pedalFF: number) => ({
    collective,
    cyclicLong: clamp(pilot.elevator + 0.5 * pilot.elevatorTrim, -1, 1),
    cyclicLat: pilot.aileron,
    pedal: clamp(pilot.rudder + pedalFF, -1, 1),
  });
  if (pilot.stabilityAssist === false) {
    return { u: direct(0), on: false, sasLong: 0, sasLat: 0, sasYaw: 0, headingRef: psi, hoverLong: 0, hoverLat: 0 };
  }
  if (!light) {
    // Sitting on the skids: controls pass straight through (the pedals get the torque feed-forward);
    // the integrators bleed off and the heading reference follows the nose.
    const bleed = Math.exp(-dt / 1.5);
    return {
      u: direct(ff), on: true,
      sasLong: r.sasLong * bleed, sasLat: r.sasLat * bleed, sasYaw: r.sasYaw * bleed,
      headingRef: psi, hoverLong: r.hoverLong * bleed, hoverLat: r.hoverLat * bleed,
    };
  }
  const iLim = sc.integratorLimit;
  const theta = fin(d.pitchDeg) * DEG;
  const phi = fin(d.rollDeg) * DEG;
  const { p, q, r: yawRate } = d;
  const iasKt = fin(d.ias) * 1.943844;
  const stickLat = Math.abs(pilot.aileron) > ACTIVE;
  const pedals = Math.abs(pilot.rudder) > ACTIVE;

  // Hover hold: null the drift over the ground with the stick centred, below hoverHoldKt.
  const h = psi * DEG;
  const vFwd = state.velocity.x * Math.sin(h) - state.velocity.z * Math.cos(h);
  const vRight = state.velocity.x * Math.cos(h) + state.velocity.z * Math.sin(h);
  const gsKt = Math.hypot(vFwd, vRight) * 1.943844;
  const wHover = 1 - smoothstep(sc.hoverHoldKt * 0.6, sc.hoverHoldKt, gsKt);
  // Any deliberate stick movement hands the position over to the pilot.
  const wLong = wHover * (1 - smoothstep(ACTIVE, 3 * ACTIVE, Math.abs(pilot.elevator)));
  const wLat = wHover * (1 - smoothstep(ACTIVE, 3 * ACTIVE, Math.abs(pilot.aileron)));
  const hMax = sc.hoverMaxDeg;
  const hoverLong = clamp(r.hoverLong + learn * sc.hoverIntegralDeg * vFwd * wLong * dt, -hMax, hMax) * (wHover > 0 ? 1 : Math.exp(-dt / 3));
  const hoverLat = clamp(r.hoverLat - learn * sc.hoverIntegralDeg * vRight * wLat * dt, -hMax, hMax) * (wHover > 0 ? 1 : Math.exp(-dt / 3));
  const hoverPitch = clamp(sc.hoverGainDeg * vFwd + hoverLong, -hMax, hMax) * wLong;
  const hoverRoll = clamp(-sc.hoverGainDeg * vRight + hoverLat, -hMax, hMax) * wLat;

  // Heading: pedals (any speed) or the stick in forward flight re-take the reference.
  const wFwd = smoothstep(sc.coordinateFromKt, sc.coordinateFullKt, iasKt);
  const retake = pedals || (wFwd > 0.3 && stickLat);
  const headingRef = retake ? psi : r.headingRef;
  const ePsiDeg = retake ? 0 : wrap180(headingRef - psi);
  const headingBank = stickLat ? 0 : wFwd * clamp(sc.kHeadingBank * ePsiDeg, -sc.headingBankMaxDeg, sc.headingBankMaxDeg);

  const thetaCmd = (sc.pitchBiasDeg + pilot.elevatorTrim * sc.trimPitchDeg + pilot.elevator * sc.pitchCmdDeg + hoverPitch) * DEG;
  const phiCmd = (sc.rollBiasDeg + pilot.aileron * sc.rollCmdDeg + hoverRoll + headingBank) * DEG;
  const eTheta = thetaCmd - theta;
  const ePhi = phiCmd - phi;
  // The attitude integrators learn the trim cyclic (anti-windup: not further into a saturated stick).
  const rawLong = sc.kPitch * eTheta - sc.kQ * q + r.sasLong;
  const rawLat = sc.kRoll * ePhi - sc.kP * p + r.sasLat;
  const windLong = (rawLong >= 1 && eTheta > 0) || (rawLong <= -1 && eTheta < 0);
  const windLat = (rawLat >= 1 && ePhi > 0) || (rawLat <= -1 && ePhi < 0);
  const sasLong = clamp(r.sasLong + (windLong ? 0 : learn * sc.iPitch * eTheta * dt), -iLim, iLim);
  const sasLat = clamp(r.sasLat + (windLat ? 0 : learn * sc.iRoll * ePhi * dt), -iLim, iLim);
  const cyclicLong = clamp(sc.kPitch * eTheta - sc.kQ * q + sasLong, -1, 1);
  const cyclicLat = clamp(sc.kRoll * ePhi - sc.kP * p + sasLat, -1, 1);

  // Yaw: rate command / heading hold in the hover, sideslip-nulling turn coordination at speed.
  const rCmd = pilot.rudder * sc.yawRateCmdDegS * DEG;
  const hoverYaw = sc.kR * (rCmd - yawRate) + (pedals ? 0 : sc.kHeading * ePsiDeg * DEG);
  const V = Math.max(10, fin(d.tas));
  const rCoord = (cfg.sim.gravity * Math.tan(clamp(phi, -1.2, 1.2))) / V;
  const beta = fin(d.beta);
  const fwdYaw = pilot.rudder + sc.kBeta * beta - 0.5 * sc.kR * (yawRate - rCoord);
  const yawErr = (1 - wFwd) * (pedals ? rCmd - yawRate : ePsiDeg * DEG) + wFwd * (pedals ? 0 : beta);
  const sasYaw = clamp(r.sasYaw + learn * sc.iYaw * yawErr * dt, -iLim, iLim);
  const pedal = clamp(ff + sasYaw + (1 - wFwd) * hoverYaw + wFwd * fwdYaw, -1, 1);
  return { u: { collective, cyclicLong, cyclicLat, pedal }, on: true, sasLong, sasLat, sasYaw, headingRef, hoverLong, hoverLat };
}

// ─── The step ─────────────────────────────────────────────────────────────────

export interface RotorcraftStep {
  engine: EngineState;
  rotor: RotorState;
  /** Aerodynamic force (body) and torque about the CG (body) including the drivetrain reaction. */
  force: Vec3;
  torque: Vec3;
}

/**
 * One helicopter step's worth of rotor, engine and control-system dynamics: returns the next rotor
 * and engine state and the aerodynamic force and moment to integrate. Called by step() in place of
 * the wing and engine models.
 */
export function stepRotorcraft(state: AircraftState, pilot: Controls, vb: Vec3, rho: number, hubHeight: number, dt: number, cfg: Config): RotorcraftStep {
  const rc = cfg.aircraft.rotorcraft!;
  const r0 = state.rotor ?? initialRotorState(cfg);
  const sas = stabilityAssist({ ...state, rotor: r0 }, pilot, dt, cfg);
  const u = sas.u;
  const F = rotorcraftForces({ vb, w: state.angularVelocity, rho, hubHeight, omega: r0.omega, vi: r0.vi, viTail: r0.viTail, time: state.time }, u, rc);
  const runUp = state.onGround && u.collective < 0.15;
  const es = stepTurboshaft(state.engine, r0, pilot.engineOn, u.collective, runUp, dt, rho, cfg);

  // Drivetrain: the engine drives the main rotor and (through the gearbox) the tail rotor.
  const om = Math.max(r0.omega, 1);
  const qEngine = es.power / om;
  const qTail = F.tailPower / om;
  const qLoss = lossPower(es.power, rc) / om;
  const qShaft = qEngine - qTail - qLoss;
  const omega = clamp(r0.omega + ((qShaft - F.mainTorque) / rc.rotor.inertia) * dt, 0, nominalOmega(rc) * 1.4);
  // The fuselage reacts the shaft torque about the mast.
  const s = mastAxis(rc);
  const reaction = scale(s, -rc.rotor.direction * qShaft);
  const vi = r0.vi + (F.viTarget - r0.vi) * (1 - Math.exp(-dt / F.inflowTau));
  const viTail = r0.viTail + (F.viTailTarget - r0.viTail) * (1 - Math.exp(-dt / F.tailInflowTau));
  const rotor: RotorState = {
    omega,
    vi: fin(vi),
    viTail: fin(viTail),
    thrust: F.thrust,
    tailThrust: F.tailThrust,
    flapLong: F.flapLong,
    flapLat: F.flapLat,
    enginePower: es.power,
    n1: es.engine.running || es.engine.starting ? n1For(es.power, rc) : Math.max(0, r0.n1 * Math.exp(-dt / 3)),
    govInt: es.govInt,
    torque: (es.power / Math.max(omega, 1) / (rc.engine.transmissionLimitW / nominalOmega(rc))),
    collective: u.collective,
    cyclicLong: u.cyclicLong,
    cyclicLat: u.cyclicLat,
    pedal: u.pedal,
    sasOn: sas.on,
    sasLong: sas.sasLong,
    sasLat: sas.sasLat,
    sasYaw: sas.sasYaw,
    headingRef: sas.headingRef,
    hoverLong: sas.hoverLong,
    hoverLat: sas.hoverLat,
    skidAnchors: r0.skidAnchors,
    vrs: F.vrs,
    bladeStall: F.bladeStall,
    groundEffect: F.groundEffect,
    fx: F.force.x,
    fy: F.force.y,
  };
  return {
    engine: { ...es.engine, rpm: omega / RPM, thrust: F.thrust },
    rotor,
    force: F.force,
    torque: add(F.torque, reaction),
  };
}

// ─── Initial states and trim ──────────────────────────────────────────────────

/** Rotor at 100 %, engine governing at flat pitch, nothing blowing: the state on the ground at idle. */
export function initialRotorState(cfg: Config, heading = 0): RotorState {
  const rc = cfg.aircraft.rotorcraft!;
  const omega = nominalOmega(rc);
  const rho = cfg.sim.seaLevelDensity;
  // Settle the flat-pitch inflow and power at rest.
  let vi = 0;
  let viTail = 0;
  let F = rotorcraftForces({ vb: { x: 0, y: 0, z: 0 }, w: { x: 0, y: 0, z: 0 }, rho, hubHeight: Infinity, omega, vi, viTail, time: 0 }, { collective: 0, cyclicLong: 0, cyclicLat: 0, pedal: 0 }, rc);
  for (let i = 0; i < 60; i++) {
    vi += 0.5 * (F.viTarget - vi);
    viTail += 0.5 * (F.viTailTarget - viTail);
    F = rotorcraftForces({ vb: { x: 0, y: 0, z: 0 }, w: { x: 0, y: 0, z: 0 }, rho, hubHeight: Infinity, omega, vi, viTail, time: 0 }, { collective: 0, cyclicLong: 0, cyclicLat: 0, pedal: 0 }, rc);
  }
  const P = Math.max(0, F.mainTorque * omega + F.tailPower);
  const Pd = (P + rc.engine.accessoryW) / (1 - rc.engine.lossFraction);
  return {
    omega,
    vi,
    viTail,
    thrust: F.thrust,
    tailThrust: F.tailThrust,
    flapLong: F.flapLong,
    flapLat: F.flapLat,
    enginePower: Pd,
    n1: n1For(Pd, rc),
    govInt: Pd,
    torque: Pd / rc.engine.transmissionLimitW,
    collective: 0,
    cyclicLong: 0,
    cyclicLat: 0,
    pedal: 0,
    sasOn: true,
    sasLong: 0,
    sasLat: 0,
    sasYaw: 0,
    headingRef: heading,
    hoverLong: 0,
    hoverLat: 0,
    skidAnchors: rc.skids.points.map(() => null),
    vrs: 0,
    bladeStall: 0,
    groundEffect: 0,
    fx: 0,
    fy: 0,
  };
}

export interface RotorTrim {
  controls: RotorControls;
  pitchDeg: number;
  rollDeg: number;
  /** True airspeed, m/s; density. */
  tas: number;
  density: number;
  vi: number;
  viTail: number;
  /** Engine shaft power delivered, W. */
  power: number;
  thrust: number;
  tailThrust: number;
  flapLong: number;
  flapLat: number;
  /** Residual of the solution (force / weight), for tests. */
  residual: number;
}

/** Solve a 6×6 linear system in place (Gaussian elimination with partial pivoting). */
function solve6(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (Math.abs(A[piv][c]) < 1e-12) return null;
    [A[c], A[piv]] = [A[piv], A[c]];
    [b[c], b[piv]] = [b[piv], b[c]];
    for (let r = c + 1; r < n; r++) {
      const k = A[r][c] / A[c][c];
      for (let j = c; j < n; j++) A[r][j] -= k * A[c][j];
      b[r] -= k * b[c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let j = r + 1; j < n; j++) s -= A[r][j] * x[j];
    x[r] = s / A[r][r];
  }
  return x;
}

/**
 * Steady, straight, coordinated flight (no sideslip) at the requested IAS and flight path (0 kt =
 * a hover; out of ground effect unless the hub's height over the surface is given): the collective, cyclic, pedals, pitch and bank that balance every
 * force and moment with the rotor at 100 %. Newton iterations on the same force model as step().
 */
export function solveRotorTrim(req: TrimRequest, cfg: Config = CONFIG, hubHeight = Infinity): RotorTrim {
  const ac = cfg.aircraft;
  const rc = ac.rotorcraft!;
  const rho = airDensity(req.altitudeM);
  const iasKt = clamp(fin(req.iasKt), 0, ac.limits.vneKt * 0.95);
  const gammaDeg = clamp(fin(req.flightPathDeg ?? 0), -60, 60);
  // Continuation: Newton from the hover, seeding each speed with the last solution (the trim moves a
  // long way between the hover and Vne and a single cold start can wander off).
  let x = [0.45, 0.1, 0, -0.3, 3, -2.5];
  let last = newtonTrim(x, 0, 0, rho, cfg, hubHeight);
  for (let kt = 20; kt < iasKt + 20; kt += 20) {
    const k = Math.min(kt, iasKt);
    const g = gammaDeg * (k / Math.max(iasKt, 1e-6));
    last = newtonTrim(last.x, k * KT_TO_MS * Math.sqrt(cfg.sim.seaLevelDensity / rho), g * DEG, rho, cfg, hubHeight);
    x = last.x;
  }
  if (iasKt < 20 && gammaDeg !== 0) last = newtonTrim(x, iasKt * KT_TO_MS * Math.sqrt(cfg.sim.seaLevelDensity / rho), gammaDeg * DEG, rho, cfg, hubHeight);
  void rc;
  return last.trim;
}

function newtonTrim(x0: number[], tas: number, gamma: number, rho: number, cfg: Config, hubHeight = Infinity): { x: number[]; trim: RotorTrim } {
  const ac = cfg.aircraft;
  const rc = ac.rotorcraft!;
  const omega = nominalOmega(rc);
  const mg = ac.mass * cfg.sim.gravity;
  const s = mastAxis(rc);
  const vi0 = Math.sqrt(mg / (2 * rho * Math.PI * rc.rotor.radius ** 2));

  const evaluate = (x: number[]) => {
    const [collective, cyclicLong, cyclicLat, pedal, pitchDeg, rollDeg] = x;
    const q = quatFromEuler(0, pitchDeg, rollDeg);
    const vw = { x: 0, y: tas * Math.sin(gamma), z: -tas * Math.cos(gamma) };
    const vb = worldToBody(q, vw);
    const u = { collective, cyclicLong, cyclicLat, pedal };
    let vi = vi0;
    let viTail = 5;
    let F = rotorcraftForces({ vb, w: { x: 0, y: 0, z: 0 }, rho, hubHeight, omega, vi, viTail, time: 0 }, u, rc);
    for (let i = 0; i < 60; i++) {
      vi += 0.6 * (F.viTarget - vi);
      viTail += 0.6 * (F.viTailTarget - viTail);
      F = rotorcraftForces({ vb, w: { x: 0, y: 0, z: 0 }, rho, hubHeight, omega, vi, viTail, time: 0 }, u, rc);
      if (Math.abs(F.viTarget - vi) < 1e-7 && Math.abs(F.viTailTarget - viTail) < 1e-7) break;
    }
    const Pmr = F.mainTorque * omega;
    const Pd = (Pmr + F.tailPower + rc.engine.accessoryW) / (1 - rc.engine.lossFraction);
    // Steady rotor speed: the shaft delivers exactly the main rotor's torque.
    const react = scale(s, -rc.rotor.direction * F.mainTorque);
    const gb = worldToBody(q, { x: 0, y: -mg, z: 0 });
    const res = [
      (F.force.x + gb.x) / mg,
      (F.force.y + gb.y) / mg,
      (F.force.z + gb.z) / mg,
      (F.torque.x + react.x) / mg,
      (F.torque.y + react.y) / mg,
      (F.torque.z + react.z) / mg,
    ];
    return { res, F, vi, viTail, P: Pd };
  };

  const norm = (r: number[]) => Math.sqrt(r.reduce((a, v) => a + v * v, 0));
  const steps = [1e-3, 1e-3, 1e-3, 1e-3, 0.02, 0.02];
  let x = x0.slice();
  let ev = evaluate(x);
  for (let it = 0; it < 30 && norm(ev.res) > 1e-7; it++) {
    const J: number[][] = [[], [], [], [], [], []];
    for (let j = 0; j < 6; j++) {
      const xp = x.slice();
      xp[j] += steps[j];
      const rp = evaluate(xp).res;
      for (let i = 0; i < 6; i++) J[i][j] = (rp[i] - ev.res[i]) / steps[j];
    }
    const dx = solve6(J, ev.res.map((v) => -v));
    if (!dx) break;
    // Damped step: back off until the residual falls.
    let k = 1;
    let next = ev;
    let xn = x;
    for (let b = 0; b < 8; b++) {
      xn = x.map((v, i) => v + k * dx[i]);
      xn[0] = clamp(xn[0], 0, 1);
      xn[1] = clamp(xn[1], -1, 1);
      xn[2] = clamp(xn[2], -1, 1);
      xn[3] = clamp(xn[3], -1, 1);
      xn[4] = clamp(xn[4], -30, 30);
      xn[5] = clamp(xn[5], -30, 30);
      next = evaluate(xn);
      if (norm(next.res) < norm(ev.res)) break;
      k *= 0.5;
    }
    x = xn;
    ev = next;
  }
  return {
    x,
    trim: {
      controls: { collective: x[0], cyclicLong: x[1], cyclicLat: x[2], pedal: x[3] },
      pitchDeg: x[4],
      rollDeg: x[5],
      tas,
      density: rho,
      vi: ev.vi,
      viTail: ev.viTail,
      power: ev.P,
      thrust: ev.F.thrust,
      tailThrust: ev.F.tailThrust,
      flapLong: ev.F.flapLong,
      flapLat: ev.F.flapLat,
      residual: norm(ev.res),
    },
  };
}

/**
 * The rotor state and pilot controls that hold a trim solution with the stability assist engaged
 * (elevator trim sets the pitch reference to the trim attitude; the integrators carry the trim
 * cyclic and pedal), for createTrimmedState.
 */
export function trimmedRotorState(tr: RotorTrim, headingDeg: number, cfg: Config): { rotor: RotorState; pilot: Partial<Controls> } {
  const rc = cfg.aircraft.rotorcraft!;
  const sc = rc.sas;
  const base = initialRotorState(cfg, headingDeg);
  const elevatorTrim = clamp((tr.pitchDeg - sc.pitchBiasDeg) / sc.trimPitchDeg, -1, 1);
  const thetaCmd = sc.pitchBiasDeg + elevatorTrim * sc.trimPitchDeg;
  const torque = tr.power / rc.engine.transmissionLimitW;
  const rotor: RotorState = {
    ...base,
    vi: tr.vi,
    viTail: tr.viTail,
    thrust: tr.thrust,
    tailThrust: tr.tailThrust,
    flapLong: tr.flapLong,
    flapLat: tr.flapLat,
    enginePower: tr.power,
    n1: n1For(tr.power, rc),
    govInt: tr.power - rc.engine.govAnticipator * tr.controls.collective,
    torque,
    ...tr.controls,
    sasLong: tr.controls.cyclicLong - sc.kPitch * (thetaCmd - tr.pitchDeg) * DEG,
    sasLat: tr.controls.cyclicLat - sc.kRoll * (sc.rollBiasDeg - tr.rollDeg) * DEG,
    sasYaw: tr.controls.pedal - PEDAL_TORQUE_FF * clamp(torque, 0, 1.3),
    headingRef: headingDeg,
  };
  return { rotor, pilot: { throttle: tr.controls.collective, elevatorTrim } };
}
