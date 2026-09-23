/**
 * Cessna 172RG flight model: state creation, the fixed-step 6-DOF integrator
 * and the flight-phase state machine (ground → airborne → landed / crashed).
 * Pure and deterministic: step() never mutates its inputs and never touches
 * the renderer or the DOM.
 *
 * ─── Calibration results (1100 kg, ISA, no wind; measured with the fixed 1/120 s step) ───
 * Checked by tests/physics/realism.test.ts, stall.test.ts, attitude.test.ts.
 *
 *   Quantity                                   Measured                              C172RG POH / target
 *   ─────────────────────────────────────────  ────────────────────────────────────  ───────────────────
 *   CLmax clean / full flaps (30°)             1.62 @ 15.5° / 2.20 @ 13.5°           1.5–1.7 clean
 *   Stall, clean, idle (Vs1)                   49.5 KIAS                             48 KIAS (44–54)
 *   Stall, full flaps, idle (Vs0)              42.4 KIAS                             40 KIAS (36–47)
 *   Full-throttle ground roll to Vr 55 KIAS    230 m (16.2 s)                        200–400 m
 *   Rotate at Vr, 0.7 yoke → lift-off          5.9 °/s rotation, 60.6 KIAS, 9.4° pitch, 299 m   3–6 °/s, 8–10°
 *   Yank: yoke +1 for 1 s then +0.3            ≤ 9.7° pitch on the wheels, airborne in 1.3 s, no tail strike
 *   Best-rate climb, Vy 75 KIAS, sea level     679 fpm, 11° pitch                    550–950 fpm
 *   75 % power cruise, 8000 ft, gear up        127 KTAS (113 KIAS), 2630 rpm         120–140 KTAS
 *   Top speed, full power, sea level, gear up  138 KTAS                              < 160 kt
 *   Idle glide 70 KIAS, gear up / gear down    9.6 : 1 / 8.6 : 1                     8–10 : 1
 *   Hands-off trimmed cruise, 110 KIAS         4° bank upset → 1.7° in 60 s (→ 0.3° in 180 s), |Δalt| < 3 m
 *   Max roll rate, full aileron, 90 KIAS       44 °/s                                30–90 °/s
 *   Approach 72 KIAS, flaps 20, 3° glide       throttle 0.51, trim −0.53, pitch −4.3° (holds hands-off)
 *   Approach + simple flare                    "smooth" −175 fpm, 60 KIAS, mains first, 582 m past threshold
 *   Braking rollout from 55 kt, full flaps     163 m                                 < 500 m
 *   Coordinated full-aft stall at idle         breaks straight (bank ≤ 1°), nose +21° → −9°, ~40 m lost
 *   Full-aft stall with full rudder            wing drops → spin/spiral (≤ 270 °/s roll)
 *   Full aft yoke at 110 / 125 KIAS            3.6 g / 4.4 g; > 6.5 g or > 1.3·Vne = structural failure
 *   step() cost (M2 Max, node)                 ~1.1 µs airborne, ~2.7 µs on the ground   ≪ 0.1 ms
 */
import { CONFIG, MS_TO_FPM, MS_TO_KT, type Config } from '../config';
import type {
  AircraftState, Controls, CrashRecord, DerivedData, EngineState, Environment, Quat, SimStateLabel, TouchdownRecord, Vec3,
} from '../types';
import { clamp, moveToward } from '../math/vec3';
import { qIntegrateBody } from '../math/quat';
import { runwayFrame, fromRunwayCoords, toRunwayCoords } from '../world/runway';
import {
  airDataFromBodyVelocity, bodyToWorld, eulerFromQuat, pqrFromOmega, quatFromEuler, worldToBody,
} from './frames';
import { airDensity } from './atmosphere';
import { computeAero, stallAlphaRad } from './aero';
import { powerTarget, propThrust, steadyEngine, stepEngine } from './engine';
import { groundContacts } from './ground';
import { FLAT_ENV } from './flatEnv';
import { solveTrim, type TrimRequest } from './trim';

const DEG = Math.PI / 180;
const ZERO: Vec3 = Object.freeze({ x: 0, y: 0, z: 0 });

// ─── Controls ─────────────────────────────────────────────────────────────────

/** Throttle idle, yoke centred, flaps up, gear down, brakes off, engine on. */
export function defaultControls(): Controls {
  return {
    throttle: 0,
    elevator: 0,
    aileron: 0,
    rudder: 0,
    elevatorTrim: 0,
    flapsNotch: 0,
    gearDown: true,
    brake: 0,
    parkingBrake: false,
    engineOn: true,
    speedBrake: false,
  };
}

const num = (v: number, lo: number, hi: number, fallback = 0): number => (Number.isFinite(v) ? clamp(v, lo, hi) : fallback);

/** Clamp every control into range; NaN → neutral. */
function sanitize(c: Controls, cfg: Config): Controls {
  const n = cfg.aircraft.flaps.notchesDeg.length;
  return {
    throttle: num(c.throttle, 0, 1),
    elevator: num(c.elevator, -1, 1),
    aileron: num(c.aileron, -1, 1),
    rudder: num(c.rudder, -1, 1),
    elevatorTrim: num(c.elevatorTrim, -1, 1),
    flapsNotch: Math.round(num(c.flapsNotch, 0, n - 1)),
    gearDown: c.gearDown !== false,
    brake: num(c.brake, 0, 1),
    parkingBrake: !!c.parkingBrake,
    engineOn: c.engineOn !== false,
  };
}

// ─── Labels & classification ─────────────────────────────────────────────────

/** 'crashed' | 'stalled' (airborne and stalled) | the phase. */
export function simStateLabel(state: AircraftState): SimStateLabel {
  if (state.phase === 'crashed') return 'crashed';
  if (state.phase === 'airborne' && state.stalled) return 'stalled';
  return state.phase;
}

/** Touchdown rating by vertical speed (fpm; the magnitude is used). Beyond hardFpm the gear collapses. */
export function classifyTouchdown(verticalSpeedFpm: number, cfg: Config = CONFIG): TouchdownRecord['rating'] | 'crash' {
  const l = cfg.aircraft.landing;
  const v = Math.abs(verticalSpeedFpm);
  if (!(v <= l.hardFpm)) return 'crash';
  if (v <= l.butterFpm) return 'butter';
  if (v <= l.smoothFpm) return 'smooth';
  if (v <= l.firmFpm) return 'firm';
  return 'hard';
}

// ─── Derived data ────────────────────────────────────────────────────────────

function computeDerived(
  pos: Vec3, vel: Vec3, q: Quat, omega: Vec3, wind: Vec3, loadFactor: number, env: Environment, cfg: Config,
): DerivedData {
  const rho = airDensity(pos.y);
  const vb = worldToBody(q, { x: vel.x - wind.x, y: vel.y - wind.y, z: vel.z - wind.z });
  const ad = airDataFromBodyVelocity(vb);
  const e = eulerFromQuat(q);
  const { p, q: qr, r } = pqrFromOmega(omega);
  const ground = env.groundHeight(pos.x, pos.z);
  const water = env.waterLevel(pos.x, pos.z);
  const surface = water !== null && water > ground ? water : ground;
  return {
    tas: ad.V,
    ias: ad.V * Math.sqrt(rho / cfg.sim.seaLevelDensity),
    groundSpeed: Math.hypot(vel.x, vel.z),
    alpha: ad.alpha,
    beta: ad.beta,
    verticalSpeed: vel.y,
    altitudeAGL: pos.y - surface,
    headingDeg: e.headingDeg,
    pitchDeg: e.pitchDeg,
    rollDeg: e.rollDeg,
    loadFactor,
    density: rho,
    p,
    q: qr,
    r,
  };
}

const windAt = (env: Environment, p: Vec3, t: number): Vec3 => (env.wind ? env.wind(p.x, p.y, p.z, t) : ZERO);

// ─── State creation ──────────────────────────────────────────────────────────

/** On runway 36, main wheels spawn.runwayStartOffset m past the threshold, resting on the gear, engine idling. */
export function createInitialState(env: Environment = FLAT_ENV, cfg: Config = CONFIG): AircraftState {
  const ac = cfg.aircraft;
  const geo = ac.geometry;
  const gd = ac.ground;
  const rw = runwayFrame(cfg);
  const nose = geo.noseWheel;
  const main = geo.leftMainWheel;
  const cgXZ = fromRunwayCoords(ac.spawn.runwayStartOffset + main.z, 0, rw);
  const heading = rw.headingDeg;

  // Static gear loads (moment balance about the CG) → strut compressions.
  const W = ac.mass * cfg.sim.gravity;
  const armN = -nose.z;
  const armM = main.z;
  const loadNose = (W * armM) / (armN + armM);
  const loadMain = (W - loadNose) / 2;
  const dN = loadNose / gd.springNose;
  const dM = loadMain / gd.springMain;

  // Terrain under the wheels (level attitude is close enough for the lookup).
  const qLevel = quatFromEuler(heading, 0, 0);
  const at = (b: Vec3) => {
    const r = bodyToWorld(qLevel, b);
    return env.groundHeight(cgXZ.x + r.x, cgXZ.z + r.z);
  };
  const gN = at(nose);
  const gM = (at(geo.leftMainWheel) + at(geo.rightMainWheel)) / 2;
  // Wheel world y = y_cg + y_b·cosθ − z_b·sinθ ; penetration d = ground − that.
  let theta = 0;
  for (let i = 0; i < 4; i++) {
    const s = (dN - dM - (gN - gM) + (nose.y - main.y) * Math.cos(theta)) / (nose.z - main.z);
    theta = Math.asin(clamp(s, -0.5, 0.5));
  }
  const y = gM - main.y * Math.cos(theta) + main.z * Math.sin(theta) - dM;
  const position = { x: cgXZ.x, y, z: cgXZ.z };
  const orientation = quatFromEuler(heading, theta / DEG, 0);
  const rho = airDensity(y);
  const engine: EngineState = { ...steadyEngine(powerTarget(0, rho, cfg), rho, 0, 0, cfg), rpm: ac.engine.idleRpm };
  engine.thrust = propThrust(engine.power, 0, rho, cfg);

  return {
    time: 0,
    position,
    velocity: { x: 0, y: 0, z: 0 },
    orientation,
    angularVelocity: { x: 0, y: 0, z: 0 },
    engine,
    flapsDeg: 0,
    gearPos: 1,
    phase: 'ground',
    stalled: false,
    onGround: true,
    wheelContact: [true, true, true],
    wheelCompression: [dN, dM, dM],
    airborneTime: 0,
    touchdown: null,
    crash: null,
    derived: computeDerived(position, ZERO, orientation, ZERO, windAt(env, position, 0), 1, env, cfg),
  };
}

/** Controls that hold a trim solution (throttle + elevator trim, elevator 0). */
function controlsFor(req: TrimRequest, tr: ReturnType<typeof solveTrim>): Controls {
  return {
    ...defaultControls(),
    throttle: tr.throttle,
    elevatorTrim: tr.elevatorTrim,
    flapsNotch: Math.round(req.flapsNotch ?? 0),
    gearDown: req.gearDown !== false,
  };
}

/**
 * An airborne aircraft in steady, trimmed flight (wings level) plus the
 * controls that hold it there hands-off. Handy for tests and scenario resets.
 */
export function createTrimmedState(
  req: TrimRequest,
  env: Environment = FLAT_ENV,
  cfg: Config = CONFIG,
): { state: AircraftState; controls: Controls } {
  const tr = solveTrim(req, cfg);
  const heading = req.headingDeg ?? 0;
  const gamma = (req.flightPathDeg ?? 0) * DEG;
  const h = heading * DEG;
  const position = { x: req.x ?? 0, y: req.altitudeM, z: req.z ?? 0 };
  const wind = windAt(env, position, 0);
  const vh = tr.tas * Math.cos(gamma);
  const velocity = { x: Math.sin(h) * vh + wind.x, y: tr.tas * Math.sin(gamma) + wind.y, z: -Math.cos(h) * vh + wind.z };
  const orientation = quatFromEuler(heading, tr.pitchDeg, 0);
  const ias = tr.tas * Math.sqrt(tr.density / cfg.sim.seaLevelDensity) * MS_TO_KT;
  const engine = steadyEngine(tr.power, tr.density, tr.tas * Math.cos(tr.alpha), ias, cfg);
  const state: AircraftState = {
    time: 0,
    position,
    velocity,
    orientation,
    angularVelocity: { x: 0, y: 0, z: 0 },
    engine,
    flapsDeg: tr.flapsDeg,
    gearPos: req.gearDown === false ? 0 : 1,
    phase: 'airborne',
    stalled: false,
    onGround: false,
    wheelContact: [false, false, false],
    wheelCompression: [0, 0, 0],
    airborneTime: 60,
    touchdown: null,
    crash: null,
    derived: computeDerived(position, velocity, orientation, ZERO, wind, 1, env, cfg),
  };
  return { state, controls: controlsFor(req, tr) };
}

function approachRequest(runwayGround: number, cfg: Config): TrimRequest {
  const ap = cfg.aircraft.spawn.approach;
  const rw = runwayFrame(cfg);
  const p = fromRunwayCoords(-ap.distance, 0, rw);
  return {
    altitudeM: runwayGround + ap.height,
    iasKt: ap.speedKt,
    flightPathDeg: -Math.atan2(ap.height, ap.distance + ap.aimPointM) / DEG,
    flapsNotch: ap.flapsNotch,
    gearDown: true,
    headingDeg: rw.headingDeg,
    x: p.x,
    z: p.z,
  };
}

/** On final for runway 36: gear down, approach flaps, on a ~3° glide to the aim point at spawn.approach.speedKt. */
export function createApproachState(env: Environment = FLAT_ENV, cfg: Config = CONFIG): AircraftState {
  const rw = runwayFrame(cfg);
  return createTrimmedState(approachRequest(env.groundHeight(rw.threshold.x, rw.threshold.z), cfg), env, cfg).state;
}

/** Controls matching createApproachState: gear down, approach flaps, throttle + trim that hold the glide hands-off. */
export function approachControls(cfg: Config = CONFIG): Controls {
  const req = approachRequest(cfg.world.airport.elevation, cfg);
  return controlsFor(req, solveTrim(req, cfg));
}

// ─── The step ────────────────────────────────────────────────────────────────

function crashedState(
  s: AircraftState, reason: string, time: number, env: Environment, cfg: Config, extra: Partial<AircraftState> = {},
): AircraftState {
  const v = s.velocity;
  const crash: CrashRecord = {
    time,
    reason,
    speedKt: Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) * MS_TO_KT,
    verticalSpeedFpm: v.y * MS_TO_FPM,
    position: { ...s.position },
  };
  const position = { ...s.position };
  return {
    ...s,
    ...extra,
    time,
    position,
    velocity: { x: 0, y: 0, z: 0 },
    orientation: { ...s.orientation },
    angularVelocity: { x: 0, y: 0, z: 0 },
    engine: { running: false, starting: false, startTimer: 0, failed: true, power: 0, rpm: 0, thrust: 0 },
    phase: 'crashed',
    stalled: false,
    crash,
    derived: computeDerived(position, ZERO, s.orientation, ZERO, ZERO, 1, env, cfg),
  };
}

function cloneState(s: AircraftState): AircraftState {
  return structuredClone(s);
}

function stepOnce(state: AircraftState, raw: Controls, dt: number, env: Environment, cfg: Config): AircraftState {
  const time = state.time + dt;
  if (state.phase === 'crashed') {
    const s = cloneState(state);
    s.time = time;
    return s;
  }
  const ac = cfg.aircraft;
  const c = sanitize(raw, cfg);
  const g = cfg.sim.gravity;
  const m = ac.mass;
  const pos = state.position;
  const vel = state.velocity;
  const q = state.orientation;
  const w = state.angularVelocity;

  // ── Air data ──
  const wind = windAt(env, pos, state.time);
  const vb = worldToBody(q, { x: vel.x - wind.x, y: vel.y - wind.y, z: vel.z - wind.z });
  const rho = airDensity(pos.y);
  const ad = airDataFromBodyVelocity(vb);
  const iasKt = ad.V * Math.sqrt(rho / cfg.sim.seaLevelDensity) * MS_TO_KT;

  // ── Systems: flaps, gear (squat switch), engine ──
  const notches = ac.flaps.notchesDeg;
  const flapsDeg = moveToward(state.flapsDeg, notches[c.flapsNotch], ac.flaps.rateDegPerSec * dt);
  // Squat switch + interlock: the gear only starts up once the aircraft has been continuously airborne
  // for gear.retractDelay s, so a handle raised during the takeoff roll or a skipped bounce can't
  // fold the gear under a settling aircraft (play-test bug #2).
  const weightOnWheels = state.onGround || state.airborneTime < ac.gear.retractDelay;
  const gearTarget = c.gearDown || (ac.gear.squatSwitch && weightOnWheels && state.gearPos >= 0.999) ? 1 : 0;
  const gearPos = moveToward(state.gearPos, gearTarget, dt / ac.gear.transitTime);
  const engine = stepEngine(state.engine, c, dt, rho, Math.max(0, ad.u), iasKt, cfg);

  // ── Airframe forces (body) ──
  // Wing height above the surface (last step's AGL is plenty accurate) for ground effect.
  const wingHeight = state.derived.altitudeAGL + ac.geometry.wingRootLeadingEdge.y;
  const aero = computeAero(vb, w, rho, flapsDeg, gearPos, c, engine.thrust, cfg, wingHeight);
  const fAir = bodyToWorld(q, { x: aero.fx, y: aero.fy, z: aero.fz });

  // ── Ground, structure, water, obstacles ──
  const omegaWorld = bodyToWorld(q, w);
  const gr = groundContacts(
    { position: pos, velocity: vel, orientation: q, omegaWorld, gearPos, brake: c.brake, parkingBrake: c.parkingBrake, rudder: c.rudder, engineRunning: engine.running },
    env,
    cfg,
  );
  if (gr.crashReason) return crashedState(state, gr.crashReason, time, env, cfg, { flapsDeg, gearPos });

  // ── Flight phase: touchdowns and takeoffs ──
  let phase = state.phase;
  let airborneTime = state.airborneTime;
  let touchdown = state.touchdown;
  if (gr.onGround) {
    if (state.phase === 'airborne') {
      const vsFpm = vel.y * MS_TO_FPM;
      const lim = ac.landing;
      if (-vsFpm > lim.hardFpm) {
        const reason = -vel.y > lim.terrainImpactMs ? 'Hit terrain' : 'Hard landing — gear collapsed';
        return crashedState(state, reason, time, env, cfg, { flapsDeg, gearPos });
      }
      if (state.airborneTime >= lim.minAirborneTime) {
        const e = eulerFromQuat(q);
        if (Math.abs(e.rollDeg) > lim.maxBankDeg) {
          return crashedState(state, 'Wingtip strike — too much bank at touchdown', time, env, cfg, { flapsDeg, gearPos });
        }
        if (e.pitchDeg < lim.minPitchDeg) {
          return crashedState(state, 'Prop strike — landed nose-first', time, env, cfg, { flapsDeg, gearPos });
        }
        const surface = env.surfaceAt(pos.x, pos.z);
        const onRunway = surface === 'runway';
        touchdown = {
          time,
          verticalSpeedFpm: vsFpm,
          airspeedKt: iasKt,
          rating: classifyTouchdown(vsFpm, cfg) as TouchdownRecord['rating'],
          bankDeg: e.rollDeg,
          pitchDeg: e.pitchDeg,
          surface,
          onRunway,
          centerlineOffsetM: onRunway ? toRunwayCoords(pos.x, pos.z, runwayFrame(cfg)).across : null,
        };
        phase = 'landed';
      } else {
        // A short hop: back to whatever ground phase we came from, no new rating.
        phase = state.touchdown ? 'landed' : 'ground';
      }
    }
    airborneTime = 0;
  } else {
    phase = 'airborne';
    airborneTime = state.airborneTime + dt;
  }

  // ── Integrate (semi-implicit Euler) ──
  const fx = fAir.x + gr.force.x;
  const fy = fAir.y + gr.force.y - m * g;
  const fz = fAir.z + gr.force.z;
  const velocity = { x: vel.x + (fx / m) * dt, y: vel.y + (fy / m) * dt, z: vel.z + (fz / m) * dt };
  const position = { x: pos.x + velocity.x * dt, y: pos.y + velocity.y * dt, z: pos.z + velocity.z * dt };

  const tg = worldToBody(q, gr.torque);
  const tx = aero.tx + tg.x;
  const ty = aero.ty + tg.y;
  const tz = aero.tz + tg.z;
  const I = ac.inertia;
  // ω̇ = I⁻¹(τ − ω × Iω), diagonal inertia (pitch = X, yaw = Y, roll = Z).
  const hx = I.pitch * w.x;
  const hy = I.yaw * w.y;
  const hz = I.roll * w.z;
  const wMax = ac.limits.maxAngularRate;
  const angularVelocity = {
    x: clamp(w.x + ((tx - (w.y * hz - w.z * hy)) / I.pitch) * dt, -wMax, wMax),
    y: clamp(w.y + ((ty - (w.z * hx - w.x * hz)) / I.yaw) * dt, -wMax, wMax),
    z: clamp(w.z + ((tz - (w.x * hy - w.y * hx)) / I.roll) * dt, -wMax, wMax),
  };
  const orientation = qIntegrateBody(q, angularVelocity, dt);

  // ── Load factor: specific force along body up (accelerometer), and the airframe (aero) part for over-G ──
  const nAero = aero.fy / (m * g);
  const gBody = worldToBody(q, gr.force);
  const loadFactor = (aero.fy + gBody.y) / (m * g);
  if (nAero > ac.limits.structuralFailureG || nAero < ac.limits.structuralFailureNegG) {
    return crashedState(state, 'Structural failure — over-G', time, env, cfg, { flapsDeg, gearPos });
  }
  if (iasKt > ac.limits.vneKt * ac.limits.overspeedFailureFactor) {
    return crashedState(state, 'Structural failure — overspeed', time, env, cfg, { flapsDeg, gearPos });
  }

  const derived = computeDerived(position, velocity, orientation, angularVelocity, wind, loadFactor, env, cfg);

  // ── Stall flag with hysteresis (only meaningful in the air) ──
  const aStall = stallAlphaRad(flapsDeg, cfg);
  let stalled = false;
  if (phase === 'airborne') {
    stalled = state.stalled
      ? derived.alpha > aStall - ac.stall.recoveryHysteresisDeg * DEG
      : derived.alpha > aStall;
  }

  return {
    time,
    position,
    velocity,
    orientation,
    angularVelocity,
    engine,
    flapsDeg,
    gearPos,
    phase,
    stalled,
    onGround: gr.onGround,
    wheelContact: gr.wheelContact,
    wheelCompression: gr.wheelCompression,
    airborneTime,
    touchdown,
    crash: null,
    derived,
  };
}

/**
 * Advance the aircraft by dt seconds (normally config.sim.fixedDt = 1/120 s).
 * Pure: returns a NEW state and never mutates its inputs; deterministic.
 * A dt larger than 1.5 × fixedDt is split into equal sub-steps.
 */
export function step(
  state: AircraftState,
  controls: Controls,
  dt: number,
  env: Environment = FLAT_ENV,
  cfg: Config = CONFIG,
): AircraftState {
  if (!(dt > 0) || !Number.isFinite(dt)) return cloneState(state);
  const maxDt = cfg.sim.fixedDt * 1.5;
  if (dt <= maxDt) return stepOnce(state, controls, dt, env, cfg);
  const n = Math.ceil(dt / cfg.sim.fixedDt);
  const h = dt / n;
  let s = state;
  for (let i = 0; i < n; i++) s = stepOnce(s, controls, h, env, cfg);
  return s;
}
