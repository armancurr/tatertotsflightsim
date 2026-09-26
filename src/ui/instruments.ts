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
 *
 * Vessels (`cfg.aircraft.watercraft` set) also get `readings.vessel` (the helm: speed through the
 * water and over the ground, both tachs, lever / gear, drives, tabs, trim, heel, depth), and their
 * aircraft readings are kept harmless: airspeed = speed through the water, no stall, no overspeed,
 * gear 'down' with no light and no gear warnings, flaps 0.
 */
import { CONFIG, M_TO_FT, MS_TO_FPM, MS_TO_KT, RAD_TO_DEG, DEG_TO_RAD, type Config, type WatercraftConfig } from '../config';
import type { AircraftState, Controls, EngineState, EngineStatus, GearState, InstrumentReadings, MarineGear, PropulsorState, RotorReadings, VesselReadings } from '../types';
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
  /** Helicopters: smoothed rotor / turbine needles, % (see rotorReadings). */
  nr: number;
  n2: number;
  n1: number;
  trq: number;
  /**
   * Power-turbine speed before the needle smoothing, %: locked to NR while the engine drives the
   * rotor, decaying on its own once the freewheel has let go (engine off / failed).
   */
  n2Free: number;
  /** Vessels: smoothed speed through the water (signed) and over the ground, kt. */
  stw: number;
  sog: number;
}

/** Engine shaft power above which the turboshaft is driving the rotor (the freewheel is engaged), W. */
const DRIVING_POWER_W = 1000;
/** Power-turbine spin-down time constant with the engine off (the rotor keeps turning on its own), s. */
const N2_SPIN_DOWN_TAU = 3.5;
/** The governor holds N2 here when the engine runs but the rotor is overrunning it (split needles), %. */
const N2_GOVERNED_PCT = 100;
/** Low rotor RPM warning below this NR, % (the 206's horn and light). */
export const LOW_ROTOR_RPM_PCT = 95;
/** On the ground the low-RPM warning is armed only with the collective above this (like the real collective switch). */
const LOW_RPM_GROUND_COLLECTIVE = 0.3;

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
  return { initialized: false, lastTime: 0, ias: 0, alt: 0, hdg: 0, vsi: 0, turn: 0, ball: 0, rpm: 0, nr: 0, n2: 0, n1: 0, trq: 0, n2Free: 0, stw: 0, sog: 0 };
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
 * the load factor — for a helicopter the body side force the rotor physics
 * reports (`state.rotor.fx`); on the ground it is the centripetal acceleration of a turn.
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
  } else if (ac.rotorcraft) {
    // Helicopter: the rotor, tail rotor and airframe force the physics summed this step. Hovering
    // with the tail rotor pushing sideways the ball sits a little off-centre, like the real one.
    const mass = ac.mass > 0 ? ac.mass : 1;
    fLat = clamp(fin(state.rotor?.fx ?? 0) / mass, -10 * g, 10 * g);
    fUp = fin(d.loadFactor, 1) * g;
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

/** Raw (unsmoothed) helicopter gauge values, %, from the rotor state (defaults when it is absent). */
export function rawRotorGauges(state: AircraftState, cfg: Config = CONFIG): { nrPct: number; n1Pct: number; torquePct: number; driving: boolean } {
  const rc = cfg.aircraft.rotorcraft;
  const nominal = rc && rc.rotor.nominalRpm > 0 ? rc.rotor.nominalRpm : fin(cfg.aircraft.engine.maxRpm, 1) || 1;
  const rotor = state.rotor;
  const e = state.engine;
  const running = e.running === true && e.failed !== true;
  let nrPct: number;
  let n1Pct: number;
  let torquePct: number;
  let driving: boolean;
  if (rotor) {
    nrPct = (fin(rotor.omega) * 60) / (2 * Math.PI) / nominal * 100;
    n1Pct = fin(rotor.n1) * 100;
    torquePct = fin(rotor.torque) * 100;
    driving = (running || e.starting === true) && fin(rotor.enginePower) > DRIVING_POWER_W;
  } else {
    // No rotor state (physics not stepped yet, tests): the engine block stands in.
    nrPct = (fin(e.rpm) / nominal) * 100;
    const pw = clamp(fin(e.power), 0, 1.2);
    n1Pct = running ? 63 + 40 * pw : 0;
    torquePct = running ? pw * 100 : 0;
    driving = running;
  }
  return { nrPct: clamp(nrPct, 0, 130), n1Pct: clamp(n1Pct, 0, 120), torquePct: clamp(torquePct, 0, 150), driving };
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
  const heli = cfg.aircraft.rotorcraft != null;
  const rg = heli ? rawRotorGauges(state, cfg) : null;
  const wc = cfg.aircraft.watercraft ?? null;
  const vessel = wc ? state.vessel : undefined;
  const stwT = clamp(fin(vessel?.speedMs ?? d.ias) * MS_TO_KT, -MAX_VESSEL_KT, MAX_VESSEL_KT);
  const sogT = clamp(fin(d.groundSpeed) * MS_TO_KT, 0, MAX_VESSEL_KT);

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
    m.stw = stwT;
    m.sog = sogT;
    if (rg) {
      m.nr = rg.nrPct;
      m.n2Free = rg.driving || state.engine.running ? Math.min(rg.nrPct, rg.driving ? 130 : N2_GOVERNED_PCT) : 0;
      m.n2 = m.n2Free;
      m.n1 = rg.n1Pct;
      m.trq = rg.torquePct;
    }
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
    m.stw = approach(m.stw, stwT, h.needleTau, step);
    m.sog = approach(m.sog, sogT, h.needleTau, step);
    if (rg) {
      // N2: locked to NR through the freewheel while the engine drives; governed at 100 % when the
      // rotor overruns a running engine; spinning down on its own with the engine off (needle split).
      if (rg.driving) m.n2Free = rg.nrPct;
      else if (state.engine.running && !state.engine.failed) m.n2Free = approach(m.n2Free, Math.min(rg.nrPct, N2_GOVERNED_PCT), h.needleTau, step);
      else m.n2Free = approach(m.n2Free, 0, N2_SPIN_DOWN_TAU, step);
      m.nr = approach(m.nr, rg.nrPct, h.needleTau, step);
      m.n2 = approach(m.n2, m.n2Free, h.needleTau, step);
      m.n1 = approach(m.n1, rg.n1Pct, h.needleTau, step);
      m.trq = approach(m.trq, rg.torquePct, h.needleTau, step);
    }
  }
  m.lastTime = time;

  const flapsDeg = clamp(fin(state.flapsDeg), 0, cfg.aircraft.surfaces.flapMaxDeg);
  const notches = cfg.aircraft.flaps.notchesDeg;
  const notch = clamp(Math.round(fin(controls.flapsNotch)), 0, notches.length - 1);
  const gear = gearStateFromPos(state.gearPos);
  const alpha = fin(d.alpha);
  const airborne = state.phase === 'airborne';
  // No stall warning on a helicopter: body α means nothing in a hover (the air comes from above).
  const stallWarning =
    !heli && !wc && airborne && (state.stalled || alpha >= stallAlphaRad(flapsDeg, cfg) - cfg.aircraft.stall.warningMarginDeg * DEG_TO_RAD);
  // On a helicopter the throttle lever is the collective: throttle % reads collective %.
  const throttlePct = clamp(fin(controls.throttle) * 100, 0, 100);
  const onGround = state.onGround === true;
  // Fixed gear (skids) has no handle: it is always "down".
  const gearHandleDown = wc != null || cfg.aircraft.gear.retractable === false || controls.gearDown !== false;
  const tas = clamp(fin(d.tas), 0, 2000);
  const vsMs = clamp(fin(d.verticalSpeed), -2000, 2000);
  const flightPathDeg = tas > 1 ? Math.asin(clamp(vsMs / tas, -1, 1)) * RAD_TO_DEG : 0;
  const gw = wc ? NO_GEAR_WARNING : gearWarning(
    { onGround, crashed: state.phase === 'crashed', gear, handleDown: gearHandleDown, throttlePct, flapsDeg, iasKt: iasT, aglFt: fin(d.altitudeAGL) * M_TO_FT },
    cfg,
  );

  const out: HudReadings = {
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
    flapNotchesDeg: notches,
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
  if (rg) out.rotor = rotorReadings(m, state, controls, rg.nrPct);
  if (wc) {
    const v = vesselReadings(m, state, controls, cfg);
    out.vessel = v;
    // Nothing aircraft-specific may fire on a boat: the "airspeed" is the log's speed through the
    // water, the tach the busier engine, the throttle the lever's travel either way.
    out.airspeedKt = Math.abs(v.speedKt);
    out.rpm = Math.max(0, ...v.rpm);
    out.throttlePct = Math.abs(v.leverPct);
    out.stallWarning = false;
    out.overspeed = false;
    out.gear = 'down';
    out.gearLight = 'off';
    out.flapsDeg = 0;
    out.flapsTargetDeg = 0;
    out.aoaDeg = 0;
    out.trimPct = -v.tabsPct;
  }
  return out;
}

/** Speed readouts of a vessel are clamped to ±this, kt. */
const MAX_VESSEL_KT = 99;
/** The depth sounder's range, m: deeper reads as null ("deep water"). */
export const SOUNDER_RANGE_M = 200;
const NO_GEAR_WARNING = { horn: false, gearUnsafe: false, squatSwitch: false, overspeed: false, lights: 'off' as const };

/** The gearbox the helm lever selects: inside the neutral detent → neutral, else ahead / astern. */
export function leverGear(lever: number, detent: number): MarineGear {
  const x = fin(lever);
  const d = Math.max(0, fin(detent, 0.08));
  if (Math.abs(x) < d || x === 0) return 'neutral';
  return x > 0 ? 'ahead' : 'astern';
}

/** The depth under the keel the sounder shows, m (null = out of range / no bottom). */
export function sounderDepth(depthUnderKeel: number | undefined | null): number | null {
  if (typeof depthUnderKeel !== 'number' || !Number.isFinite(depthUnderKeel) || depthUnderKeel > SOUNDER_RANGE_M) return null;
  return Math.max(0, depthUnderKeel);
}

/**
 * The helm's instruments from the vessel state (defaults when the physics has not produced one
 * yet): one tach and load per propulsor (port first), the lever and the gear the first drive is
 * in, its steering angle, tabs, trim, heel (= roll, starboard down +), sounder and flags.
 */
export function vesselReadings(m: InstrumentModel, state: AircraftState, controls: Controls, cfg: Config = CONFIG): VesselReadings {
  const wc = cfg.aircraft.watercraft;
  const v = state.vessel;
  const lever = clamp(fin(controls.throttle), -1, 1);
  const all = Array.isArray(v?.propulsors) ? v.propulsors : [];
  // tunnel thrusters (cruise-ship work) are not engines: the tachs, gear and drive angle read the rest
  const isThruster = (i: number) => wc?.propulsors[i]?.type === 'thruster';
  const props = wc?.propulsors.some((p) => p.type === 'thruster') ? all.filter((_p, i) => !isThruster(i)) : all;
  const count = Math.max(1, props.length || wc?.propulsors.filter((p) => p.type !== 'thruster').length || 1);
  const rpm: number[] = [];
  const loadPct: number[] = [];
  // (Sea-Doo: a high-revving engine's tach reads past 5,000)
  const rpmCap = Math.max(5000, 1.25 * (cfg.aircraft.watercraft?.engine.maxRpm ?? 0));
  const engineRpm = clamp(fin(state.engine?.rpm), 0, rpmCap);
  for (let i = 0; i < count; i++) {
    const p = props[i];
    rpm.push(p ? clamp(fin(p.rpm), 0, rpmCap) : engineRpm);
    loadPct.push(p ? clamp(fin(p.load) * 100, 0, 150) : 0);
  }
  const first = props[0];
  const gear: MarineGear = first && (first.gear === 'ahead' || first.gear === 'neutral' || first.gear === 'astern') ? first.gear : leverGear(lever, wc?.neutralDetent ?? 0.08);
  return {
    speedKt: m.stw,
    sogKt: m.sog,
    rpm,
    loadPct,
    leverPct: lever * 100,
    gear,
    steerDeg: clamp(fin(first?.steerDeg ?? 0), -90, 90),
    tabsPct: clamp(fin(v?.tabs ?? 0) * 100, 0, 100),
    trimDeg: clamp(fin(v?.trimDeg ?? 0), -45, 45),
    heelDeg: wrap180(fin(state.derived?.rollDeg)),
    depthM: sounderDepth(v?.depthUnderKeel),
    planingPct: clamp(fin(v?.planing ?? 0) * 100, 0, 100),
    moored: v ? v.mooring != null : false,
    aground: v?.aground === true,
    ...(wc?.propulsors.some((p) => p.type === 'thruster') ? { thrusters: thrusterReadings(all, wc) } : {}),
  };
}

/** Bow / stern tunnel-thruster groups' mean thrust, −1 … +1 of full (+ pushing to starboard). */
function thrusterReadings(all: readonly PropulsorState[], wc: WatercraftConfig): { bow: number; stern: number } {
  let bow = 0;
  let nb = 0;
  let stern = 0;
  let ns = 0;
  wc.propulsors.forEach((pc, i) => {
    if (pc.type !== 'thruster') return;
    const f = clamp(fin(all[i]?.thrust) / Math.max(1, pc.thruster?.maxThrustN ?? 1), -1, 1);
    if (pc.position.z < 0) {
      bow += f;
      nb++;
    } else {
      stern += f;
      ns++;
    }
  });
  return { bow: nb ? bow / nb : 0, stern: ns ? stern / ns : 0 };
}

/** The helicopter's rotor instruments from the (already advanced) model. */
function rotorReadings(m: InstrumentModel, state: AircraftState, controls: Controls, nrRawPct: number): RotorReadings {
  const rotor = state.rotor;
  const collective = clamp(fin(controls.throttle), 0, 1);
  const running = state.engine.running === true && state.engine.failed !== true;
  const crashed = state.phase === 'crashed';
  const airborne = !crashed && state.onGround !== true && state.phase === 'airborne';
  // The real 206's low-RPM horn is armed in flight, and on the ground once the collective is raised.
  const armed = airborne || (!crashed && state.onGround === true && running && collective > LOW_RPM_GROUND_COLLECTIVE);
  const torquePct = clamp(m.trq, 0, 150);
  return {
    nrPct: clamp(m.nr, 0, 130),
    n2Pct: clamp(m.n2, 0, 130),
    n1Pct: clamp(m.n1, 0, 120),
    torquePct,
    collectivePct: collective * 100,
    sas: rotor ? rotor.sasOn === true : controls.stabilityAssist !== false,
    lowRotorRpm: armed && nrRawPct < LOW_ROTOR_RPM_PCT,
    overTorque: !crashed && fin(rotor?.torque ?? 0) > 1,
    vrs: clamp(fin(rotor?.vrs ?? 0), 0, 1),
    bladeStall: clamp(fin(rotor?.bladeStall ?? 0), 0, 1),
  };
}
