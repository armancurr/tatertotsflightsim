/**
 * The instrument model: turns the physics state into what the cockpit
 * instruments show, in display units, with the behaviour of the real
 * instruments — pitot-static needles that are smoothed, a VSI that lags,
 * gyro attitude that does not, a damped inclinometer ball and a turn
 * coordinator. PURE: no DOM, no three.js; the same readings feed the HUD
 * overlay, the 3D panel texture and window.sim.
 *
 * Robust by construction: every reading is finite and clamped to the range the
 * gauge can show, whatever garbage the state holds (tests fuzz it).
 */
import { CONFIG, M_TO_FT, MS_TO_FPM, MS_TO_KT, RAD_TO_DEG, DEG_TO_RAD, type Config } from '../config';
import type { AircraftState, Controls, EngineState, EngineStatus, GearState, InstrumentReadings } from '../types';
import { stallAlphaRad, simStateLabel } from '../physics';
import { gearWarning } from './gearWarning';

/** Readings plus the few extras the panel drawers use (still assignable to InstrumentReadings). */
export interface HudReadings extends InstrumentReadings {
  /** Position of the gear lever (the command), which leads the gear while it is in transit. */
  gearHandleDown: boolean;
  /** Weight on wheels (the squat switch). */
  onGround: boolean;
  /** The intermittent gear warning horn is sounding (see gearWarning.ts). */
  gearHorn: boolean;
  /** Red GEAR: airborne with the gear not down and locked at low power or landing flaps. */
  gearUnsafe: boolean;
  /** Amber GEAR — SQUAT SWITCH: handle UP on the ground. */
  gearSquat: boolean;
  /** Gear speed limit exceeded (VLE down, VLO in transit). */
  gearOverspeed: boolean;
  /** Mach number (TAS over the ISA speed of sound at this altitude). */
  mach: number;
  /** 0..1 afterburner intensity (0 for piston engines). */
  afterburner: number;
  /** Speed brake extended (X; jets). */
  speedBrake: boolean;
  /** Sideslip, deg (+ air from the right: the flight path is right of the nose). */
  betaDeg: number;
  /** Flight-path angle, deg (+ climbing): where the jet HUD's flight-path marker sits against the horizon. */
  flightPathDeg: number;
}

/** What the gauges can show for this aircraft: the steam gauges' stops, stretched for fast aircraft. */
export interface InstrumentLimits {
  maxAirspeedKt: number;
  maxVsiFpm: number;
  maxRpm: number;
}

/**
 * Reading limits for an aircraft: the config's steam-gauge stops (the Cessna), raised to 1.25 × Vne
 * for anything faster (the VSI range scales with it), so a jet's readings never peg at 250 kt.
 */
export function instrumentLimits(cfg: Config = CONFIG): InstrumentLimits {
  const h = cfg.hud;
  const vne = fin(cfg.aircraft.limits.vneKt, h.maxAirspeedKt);
  const maxAirspeedKt = Math.max(h.maxAirspeedKt, vne * 1.25);
  const maxRpm = Math.max(4000, fin(cfg.aircraft.engine.maxRpm, 0) * 1.2);
  return { maxAirspeedKt, maxVsiFpm: h.maxVsiFpm * (maxAirspeedKt / h.maxAirspeedKt), maxRpm };
}

/** ISA speed of sound (m/s) at a geometric altitude (m): T falls 6.5 K/km to 216.65 K at 11 km, then holds. */
export function isaSpeedOfSound(altitudeM: number): number {
  const h = clamp(fin(altitudeM), -1000, 20000);
  const T = h < 11000 ? 288.15 - 0.0065 * h : 216.65;
  return Math.sqrt(1.4 * 287.053 * T);
}

/** Smoothing state of the needles. Create with createInstrumentModel(); mutated by updateInstruments(). */
export interface InstrumentModel {
  initialized: boolean;
  /** Sim time of the last update (a reset sends it backwards → the needles snap). */
  lastTime: number;
  ias: number;
  alt: number;
  hdg: number;
  vsi: number;
  turn: number;
  ball: number;
  rpm: number;
}

const fin = (x: number, fallback = 0): number => (Number.isFinite(x) ? x : fallback);
const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

/** 0 ≤ h < 360, even for -1e-17 or NaN. */
export function wrapHeading(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  const h = ((deg % 360) + 360) % 360;
  return h >= 360 ? 0 : h;
}

/** -180 < a ≤ 180. */
function wrap180(deg: number): number {
  const a = wrapHeading(deg);
  return a > 180 ? a - 360 : a;
}

/** Exponential approach with time constant tau; dt ≤ 0 (paused) holds, a huge dt snaps. */
function approach(cur: number, target: number, tau: number, dt: number): number {
  if (!(dt > 0)) return cur;
  if (!(tau > 0)) return target;
  const k = 1 - Math.exp(-dt / tau);
  return cur + (target - cur) * (Number.isFinite(k) ? k : 1);
}

export function createInstrumentModel(_cfg: Config = CONFIG): InstrumentModel {
  return { initialized: false, lastTime: 0, ias: 0, alt: 0, hdg: 0, vsi: 0, turn: 0, ball: 0, rpm: 0 };
}

export function gearStateFromPos(gearPos: number): GearState {
  if (!Number.isFinite(gearPos)) return 'transit';
  if (gearPos >= 0.999) return 'down';
  if (gearPos <= 0.001) return 'up';
  return 'transit';
}

export function engineStatusOf(e: EngineState): EngineStatus {
  if (e.failed) return 'FAILED';
  if (e.starting) return 'STARTING';
  if (e.running) return 'RUNNING';
  return 'OFF';
}

/**
 * Heading rate ψ̇ (deg/s, + right) from the body rates — what a turn
 * coordinator shows: ψ̇ = (q·sinφ + r·cosφ) / cosθ.
 */
export function rawTurnRate(state: AircraftState, cfg: Config = CONFIG): number {
  const d = state.derived;
  const phi = fin(d.rollDeg) * DEG_TO_RAD;
  const cosTheta = Math.cos(fin(d.pitchDeg) * DEG_TO_RAD);
  const c = Math.abs(cosTheta) < 0.1 ? 0.1 : cosTheta;
  const psiDot = (fin(d.q) * Math.sin(phi) + fin(d.r) * Math.cos(phi)) / c;
  const lim = cfg.hud.maxTurnRateDegPerSec;
  return clamp(fin(psiDot * RAD_TO_DEG), -lim, lim);
}

/**
 * Undamped inclinometer ball position, -1..1 (+ right). The ball follows the
 * apparent gravity (the specific force): airborne that is the aerodynamic side
 * force from sideslip and rudder (the same derivatives the physics uses) against
 * the load factor; on the ground it is the centripetal acceleration of a turn.
 */
export function rawSlipBall(state: AircraftState, controls: Controls, cfg: Config = CONFIG): number {
  const d = state.derived;
  const ac = cfg.aircraft;
  const g = cfg.sim.gravity;
  let fLat: number;
  let fUp: number;
  if (state.onGround) {
    // Turning right (r > 0) accelerates the aircraft to the right: the ball swings out to the left.
    fLat = fin(d.groundSpeed) * fin(d.r);
    fUp = g;
  } else {
    const rho = clamp(fin(d.density, cfg.sim.seaLevelDensity), 0, 2);
    const V = clamp(fin(d.tas), 0, 200);
    const qbar = 0.5 * rho * V * V;
    const disc = Math.PI * ac.geometry.propRadius * ac.geometry.propRadius;
    const thrust = clamp(fin(state.engine.thrust), 0, 1e5);
    const qTail = qbar + (ac.aero.propwashTail * thrust) / disc;
    const beta = clamp(fin(d.beta), -Math.PI / 2, Math.PI / 2);
    const rudder = clamp(fin(controls.rudder), -1, 1);
    const side = qbar * ac.wingArea * ac.aero.cyBeta * beta + qTail * ac.wingArea * ac.aero.cyRudder * rudder;
    fLat = side / ac.mass;
    fUp = fin(d.loadFactor, 1) * g;
  }
  // The ball sits opposite the lateral specific force (it "falls" toward the apparent gravity).
  const tilt = Math.atan2(-fLat, fUp);
  return clamp(fin(tilt / (cfg.hud.ballRangeDeg * DEG_TO_RAD)), -1, 1);
}

/**
 * Advance the instrument model by dt seconds and return what the gauges read.
 * The first call (and the first call after a reset) shows the true values at once.
 */
export function updateInstruments(
  m: InstrumentModel,
  state: AircraftState,
  controls: Controls,
  dt: number,
  cfg: Config = CONFIG,
): HudReadings {
  const h = cfg.hud;
  const d = state.derived;
  const lim = cfg.aircraft.limits;

  const L = instrumentLimits(cfg);
  const iasT = clamp(fin(d.ias) * MS_TO_KT, 0, L.maxAirspeedKt);
  const altT = clamp(fin(state.position.y) * M_TO_FT, -2000, 99000);
  const hdgT = wrapHeading(fin(d.headingDeg, m.hdg));
  const vsT = clamp(fin(d.verticalSpeed) * MS_TO_FPM, -L.maxVsiFpm, L.maxVsiFpm);
  const turnT = rawTurnRate(state, cfg);
  const ballT = rawSlipBall(state, controls, cfg);
  const rpmT = clamp(fin(state.engine.rpm), 0, L.maxRpm);

  const time = fin(state.time, m.lastTime);
  const snap = !m.initialized || time < m.lastTime - 1e-6;
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  if (snap) {
    m.ias = iasT;
    m.alt = altT;
    m.hdg = hdgT;
    m.vsi = vsT;
    m.turn = turnT;
    m.ball = ballT;
    m.rpm = rpmT;
    m.initialized = true;
  } else {
    m.ias = approach(m.ias, iasT, h.needleTau, step);
    m.alt = approach(m.alt, altT, h.needleTau, step);
    // Heading: smooth the shortest-way difference so 359 → 1 goes through north.
    let dh = hdgT - m.hdg;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
    m.hdg = wrapHeading(approach(m.hdg, m.hdg + dh, h.needleTau, step));
    m.vsi = approach(m.vsi, vsT, h.vsiLagTau, step);
    m.turn = approach(m.turn, turnT, h.turnTau, step);
    m.ball = approach(m.ball, ballT, h.ballTau, step);
    m.rpm = approach(m.rpm, rpmT, h.needleTau, step);
  }
  m.lastTime = time;

  const flapsDeg = clamp(fin(state.flapsDeg), 0, cfg.aircraft.surfaces.flapMaxDeg);
  const notches = cfg.aircraft.flaps.notchesDeg;
  const notch = clamp(Math.round(fin(controls.flapsNotch)), 0, notches.length - 1);
  const gear = gearStateFromPos(state.gearPos);
  const alpha = fin(d.alpha);
  const airborne = state.phase === 'airborne';
  const stallWarning =
    airborne && (state.stalled || alpha >= stallAlphaRad(flapsDeg, cfg) - cfg.aircraft.stall.warningMarginDeg * DEG_TO_RAD);
  const throttlePct = clamp(fin(controls.throttle) * 100, 0, 100);
  const onGround = state.onGround === true;
  const gearHandleDown = controls.gearDown !== false;
  const tas = clamp(fin(d.tas), 0, 2000);
  const vsMs = clamp(fin(d.verticalSpeed), -2000, 2000);
  const flightPathDeg = tas > 1 ? Math.asin(clamp(vsMs / tas, -1, 1)) * RAD_TO_DEG : 0;
  const gw = gearWarning(
    { onGround, crashed: state.phase === 'crashed', gear, handleDown: gearHandleDown, throttlePct, flapsDeg, iasKt: iasT },
    cfg,
  );

  return {
    airspeedKt: m.ias,
    altitudeFt: m.alt,
    altitudeAglFt: clamp(fin(d.altitudeAGL) * M_TO_FT, 0, 99000),
    headingDeg: m.hdg,
    verticalSpeedFpm: m.vsi,
    pitchDeg: clamp(fin(d.pitchDeg), -90, 90),
    rollDeg: wrap180(fin(d.rollDeg)),
    slipSkid: clamp(m.ball, -1, 1),
    turnRateDegPerSec: m.turn,
    throttlePct,
    rpm: m.rpm,
    engineStatus: engineStatusOf(state.engine),
    flapsDeg,
    flapsTargetDeg: notches[notch],
    gear,
    gearLight: gw.lights,
    brakes: fin(controls.brake) > h.brakeLampThreshold,
    parkingBrake: controls.parkingBrake === true,
    trimPct: clamp(fin(controls.elevatorTrim) * 100, -100, 100),
    stallWarning,
    overspeed: iasT > lim.vneKt,
    aoaDeg: wrap180(alpha * RAD_TO_DEG),
    gLoad: clamp(fin(d.loadFactor, 1), -h.maxG, h.maxG),
    groundSpeedKt: clamp(fin(d.groundSpeed) * MS_TO_KT, 0, 1000),
    state: simStateLabel(state),
    gearHandleDown,
    onGround,
    gearHorn: gw.horn,
    gearUnsafe: gw.gearUnsafe,
    gearSquat: gw.squatSwitch,
    gearOverspeed: gw.overspeed,
    mach: tas / isaSpeedOfSound(fin(state.position.y)),
    afterburner: clamp(fin(state.engine.afterburner ?? 0), 0, 1),
    speedBrake: controls.speedBrake === true,
    betaDeg: clamp(fin(d.beta) * RAD_TO_DEG, -90, 90),
    flightPathDeg,
  };
}
